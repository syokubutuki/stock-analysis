"use client";

// ③ 頑健性と過剰適合の点検。計算は Web Worker（nday-move.worker.ts）。
// 「一番よかった組み合わせ」だけを見せないこと: 台帳は格子の並び順を既定にし、全件を出す。

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { MoveDirection, ThresholdUnit, TriggerMode } from "../../lib/nday-move";
import type { CapitalModel, CostModel, TradeRecord } from "../../lib/nday-move-trades";
import {
  type CandidateMetrics, type RobustnessConfig, type RobustnessResult, type GridSpec,
  DEFAULT_CSCV, candidateKey, concentration, neighborsOf, parseNumberList, selectionInflation,
} from "../../lib/nday-move-robustness";
import type { NdayMoveWorkerRequest, NdayMoveWorkerResponse } from "../../lib/nday-move.worker";
import { CHART_COLORS, DIRECTION_LABEL, EVENT_WINDOW_COLORS, withSign } from "../../lib/chart-colors";
import NdayMoveEquityChart from "./NdayMoveEquityChart";
import { BarHistogram, Notice, ResponsiveCanvas, StatCard, binValues, buttonClass, inputClass, labelClass, num, pctPlain, pctSigned } from "./ndayMoveShared";

// ───────────────────────── 入力 ─────────────────────────

export interface GridInputs {
  down: boolean;
  up: boolean;
  lookbacks: string;
  thresholds: string;
  holds: string;
  minTrainYears: string;
  minTrades: string;
  S: string;
}

export function defaultGridInputs(unit: ThresholdUnit): GridInputs {
  return {
    down: true, up: true, lookbacks: "3, 5, 10, 20",
    thresholds: unit === "pct" ? "3, 5, 7, 10" : "1, 1.5, 2, 2.5",
    holds: "3, 5, 10", minTrainYears: "3", minTrades: "10", S: "16",
  };
}

export function gridFromInputs(inputs: GridInputs): GridSpec {
  const directions: MoveDirection[] = [];
  if (inputs.down) directions.push("down");
  if (inputs.up) directions.push("up");
  return {
    directions,
    lookbacks: parseNumberList(inputs.lookbacks),
    thresholds: parseNumberList(inputs.thresholds),
    holds: parseNumberList(inputs.holds),
  };
}

export function configFromInputs(inputs: GridInputs, unit: ThresholdUnit, trigger: TriggerMode, cost: CostModel, capital: CapitalModel): RobustnessConfig {
  return {
    grid: gridFromInputs(inputs), unit, trigger, cost, capital,
    walkForward: { minTrainYears: Number(inputs.minTrainYears) || 3, minTrades: Math.max(1, Math.round(Number(inputs.minTrades) || 10)) },
    cscv: { ...DEFAULT_CSCV, S: Number(inputs.S) || 16 },
  };
}

// ───────────────────────── Worker ─────────────────────────

export interface RobustnessRun {
  status: "idle" | "running" | "done" | "error";
  progress: { stage: string; done: number; total: number } | null;
  result: RobustnessResult | null;
  /** 結果を計算したときの条件のキー（今の条件と違えば「古い結果」） */
  key: string | null;
  elapsedMs: number | null;
  error: string | null;
}

export function useRobustnessWorker() {
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const [run, setRun] = useState<RobustnessRun>({ status: "idle", progress: null, result: null, key: null, elapsedMs: null, error: null });

  useEffect(() => () => { workerRef.current?.terminate(); workerRef.current = null; }, []);

  const start = useCallback((request: Omit<NdayMoveWorkerRequest, "reqId">, key: string) => {
    if (!workerRef.current) workerRef.current = new Worker(new URL("../../lib/nday-move.worker.ts", import.meta.url));
    const worker = workerRef.current;
    const reqId = ++reqIdRef.current;
    worker.onmessage = (ev: MessageEvent<NdayMoveWorkerResponse>) => {
      const msg = ev.data;
      if (msg.reqId !== reqIdRef.current) return; // 古い要求の応答は捨てる
      if (msg.type === "progress") setRun((r) => ({ ...r, progress: { stage: msg.stage, done: msg.done, total: msg.total } }));
      else if (msg.type === "result") setRun({ status: "done", progress: null, result: msg.result, key, elapsedMs: msg.elapsedMs, error: msg.result.error });
      else setRun((r) => ({ ...r, status: "error", progress: null, error: msg.message }));
    };
    worker.onerror = (ev) => {
      if (reqId !== reqIdRef.current) return;
      setRun((r) => ({ ...r, status: "error", progress: null, error: ev.message || "計算中にエラーが起きました。" }));
    };
    setRun((r) => ({ ...r, status: "running", progress: null, error: null }));
    worker.postMessage({ ...request, reqId } satisfies NdayMoveWorkerRequest);
  }, []);

  const cancel = useCallback(() => {
    reqIdRef.current++;
    workerRef.current?.terminate();
    workerRef.current = null;
    setRun((r) => ({ ...r, status: r.result ? "done" : "idle", progress: null }));
  }, []);

  return { run, start, cancel };
}

// ───────────────────────── 描画 ─────────────────────────

const STAGE_LABEL: Record<string, string> = { candidates: "候補格子を評価中", "walk-forward": "ウォークフォワードで再選択中", cscv: "CSCV の組合せを計算中" };

function sharpeCellClass(sr: number | null): string {
  if (sr === null) return "bg-gray-50 text-gray-500";
  if (sr >= 1) return "bg-green-300";
  if (sr >= 0.5) return "bg-green-200";
  if (sr >= 0.2) return "bg-green-100";
  if (sr > 0) return "bg-green-50";
  if (sr <= -1) return "bg-red-300";
  if (sr <= -0.5) return "bg-red-200";
  if (sr <= -0.2) return "bg-red-100";
  return "bg-red-50";
}

function specLabel(c: { direction: MoveDirection; lookback: number; threshold: number; hold: number }, unit: ThresholdUnit): string {
  const p = unit === "pct" ? `${c.threshold}%` : `${c.threshold}σ`;
  return `${DIRECTION_LABEL[c.direction]}・n=${c.lookback}・p=${p}・h=${c.hold}`;
}

function Heatmaps({ result, unit, current }: { result: RobustnessResult; unit: ThresholdUnit; current: CurrentRule }) {
  const dirs = [...new Set(result.candidates.map((c) => c.direction))];
  const holds = [...new Set(result.candidates.map((c) => c.hold))].sort((a, b) => a - b);
  const ns = [...new Set(result.candidates.map((c) => c.lookback))].sort((a, b) => a - b);
  const ps = [...new Set(result.candidates.map((c) => c.threshold))].sort((a, b) => a - b);
  const byKey = new Map(result.candidates.map((c) => [c.key, c]));
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {dirs.flatMap((d) => holds.map((h) => (
        <div key={`${d}-${h}`} className="min-w-0 overflow-x-auto">
          <p className="mb-1 text-xs font-medium">{DIRECTION_LABEL[d]}・保有 h={h}日（値＝シャープ、下段＝取引数）</p>
          <table className="text-center text-[11px] tabular-nums">
            <thead><tr><th className="p-1 text-left text-gray-600">n＼p</th>{ps.map((p) => <th key={p} className="p-1 text-gray-600">{unit === "pct" ? `${p}%` : `${p}σ`}</th>)}</tr></thead>
            <tbody>{ns.map((n) => (
              <tr key={n}>
                <th className="p-1 text-left font-normal text-gray-600">{n}日</th>
                {ps.map((p) => {
                  const c = byKey.get(candidateKey({ direction: d, lookback: n, threshold: p, hold: h }));
                  const isCurrent = c && c.key === candidateKey(current);
                  return (
                    <td key={p} className={`min-w-[3.5rem] border border-white p-1 ${sharpeCellClass(c?.sharpe ?? null)} ${isCurrent ? "outline outline-2 outline-blue-700" : ""}`}
                      title={c ? `${specLabel(c, unit)}：シャープ ${num(c.sharpe)}、取引 ${c.trades}回、資産 ${pctSigned(Math.expm1(c.logGrowth))}` : "なし"}>
                      {c ? <>{c.sharpe === null ? "—" : withSign(c.sharpe, 2)}<span className="block text-[10px] text-gray-700">{c.trades}回</span></> : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )))}
    </div>
  );
}

type SortKey = "grid" | "trades" | "meanNet" | "winRate" | "logGrowth" | "sharpe" | "maxDrawdown";

function LedgerTable({ result, unit, current }: { result: RobustnessResult; unit: ThresholdUnit; current: CurrentRule }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "grid", desc: false });
  const rows = useMemo(() => {
    const list = result.candidates.map((c, i) => ({ c, i }));
    if (sort.key === "grid") return list;
    const val = (c: CandidateMetrics) => (c[sort.key as Exclude<SortKey, "grid">] ?? -Infinity) as number;
    return [...list].sort((a, b) => (sort.desc ? val(b.c) - val(a.c) : val(a.c) - val(b.c)));
  }, [result, sort]);
  const header = (key: SortKey, label: string) => (
    <th className="p-2">
      <button type="button" className="underline decoration-dotted" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))}>
        {label}{sort.key === key ? (sort.desc ? " ▼" : " ▲") : ""}
      </button>
    </th>
  );
  return (
    <div className="max-h-96 overflow-auto rounded border border-gray-200">
      <table className="w-full whitespace-nowrap text-right text-xs tabular-nums">
        <thead className="sticky top-0 bg-white"><tr className="border-b text-gray-600">
          {header("grid", "候補（格子順）")}<th className="p-2">シグナル</th>{header("trades", "取引")}{header("meanNet", "1回平均")}{header("winRate", "勝率")}
          {header("logGrowth", "資産の増減")}<th className="p-2">年率</th>{header("sharpe", "シャープ")}{header("maxDrawdown", "最大DD")}<th className="p-2">滞在率</th>
        </tr></thead>
        <tbody>{rows.map(({ c }) => (
          <tr key={c.key} className={`border-t border-gray-100 ${c.key === candidateKey(current) ? "bg-blue-50" : ""}`}>
            <td className="p-2 text-left">{specLabel(c, unit)}</td>
            <td className="p-2">{c.signals}</td><td className="p-2">{c.trades}</td><td className="p-2">{pctSigned(c.meanNet)}</td>
            <td className="p-2">{pctPlain(c.winRate)}</td><td className="p-2">{pctSigned(Math.expm1(c.logGrowth))}</td><td className="p-2">{pctSigned(c.cagr)}</td>
            <td className="p-2">{num(c.sharpe)}</td><td className="p-2">{pctPlain(c.maxDrawdown)}</td><td className="p-2">{pctPlain(c.exposure)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function DegradationScatter({ isSel, oosSel, slope, intercept }: { isSel: number[]; oosSel: number[]; slope: number | null; intercept: number | null }) {
  const stride = Math.max(1, Math.ceil(isSel.length / 2500));
  const description = `CSCV の各組合せで訓練最良だった候補の、訓練シャープ（横）と検証シャープ（縦）の散布。${isSel.length}組。${slope !== null ? `回帰の傾き${slope.toFixed(2)}。` : ""}`;
  return (
    <ResponsiveCanvas height={260} description={description} deps={[isSel, oosSel, slope, intercept]} draw={(ctx, width, height) => {
      const left = 44, right = 10, top = 12, bottom = 36;
      const pw = width - left - right, ph = height - top - bottom;
      const xs = isSel, ys = oosSel;
      let x0 = Math.min(0, ...xs), x1 = Math.max(0, ...xs), y0 = Math.min(0, ...ys), y1 = Math.max(0, ...ys);
      const px = (x1 - x0) * 0.05 || 0.5, py = (y1 - y0) * 0.05 || 0.5;
      x0 -= px; x1 += px; y0 -= py; y1 += py;
      const X = (v: number) => left + (pw * (v - x0)) / (x1 - x0);
      const Y = (v: number) => top + ph * (1 - (v - y0) / (y1 - y0));
      ctx.strokeStyle = CHART_COLORS.reference;
      ctx.beginPath(); ctx.moveTo(X(0), top); ctx.lineTo(X(0), top + ph); ctx.moveTo(left, Y(0)); ctx.lineTo(left + pw, Y(0)); ctx.stroke();
      ctx.fillStyle = EVENT_WINDOW_COLORS.lookback;
      ctx.globalAlpha = 0.35;
      for (let i = 0; i < xs.length; i += stride) ctx.fillRect(X(xs[i]) - 1, Y(ys[i]) - 1, 2, 2);
      ctx.globalAlpha = 1;
      if (slope !== null && intercept !== null) {
        ctx.save();
        ctx.beginPath(); ctx.rect(left, top, pw, ph); ctx.clip();
        ctx.strokeStyle = EVENT_WINDOW_COLORS.outcome;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(X(x0), Y(intercept + slope * x0)); ctx.lineTo(X(x1), Y(intercept + slope * x1)); ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = CHART_COLORS.ink;
      ctx.textAlign = "center";
      ctx.fillText("訓練での成績（シャープ・年率）", left + pw / 2, height - 6);
      for (let g = 0; g <= 4; g++) {
        const vx = x0 + ((x1 - x0) * g) / 4;
        ctx.fillText(vx.toFixed(1), X(vx), top + ph + 14);
      }
      ctx.textAlign = "right";
      for (let g = 0; g <= 4; g++) {
        const vy = y0 + ((y1 - y0) * g) / 4;
        ctx.fillText(vy.toFixed(1), left - 4, Y(vy) + 4);
      }
      ctx.save(); ctx.translate(10, top + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillText("検証での成績", 0, 0); ctx.restore();
    }} />
  );
}

function DominanceChart({ grid, sel, rnd }: { grid: number[]; sel: number[]; rnd: number[] }) {
  return (
    <ResponsiveCanvas height={220} description="確率優越の比較。訓練最良を選んだ場合の検証シャープの累積分布（実線）と、候補を無作為に1つ選んだ場合（破線）。実線が破線の右（下）にあれば、選ぶ手順に価値がある。" deps={[grid, sel, rnd]} draw={(ctx, width, height) => {
      const left = 40, right = 10, top = 10, bottom = 34;
      const pw = width - left - right, ph = height - top - bottom;
      const x0 = grid[0], x1 = grid[grid.length - 1] === x0 ? x0 + 1 : grid[grid.length - 1];
      const X = (v: number) => left + (pw * (v - x0)) / (x1 - x0);
      const Y = (v: number) => top + ph * (1 - v);
      ctx.strokeStyle = CHART_COLORS.grid;
      for (let g = 0; g <= 4; g++) { ctx.beginPath(); ctx.moveTo(left, Y(g / 4)); ctx.lineTo(left + pw, Y(g / 4)); ctx.stroke(); }
      const line = (vals: number[], color: string, dash: number[]) => {
        ctx.strokeStyle = color; ctx.setLineDash(dash); ctx.lineWidth = 2;
        ctx.beginPath(); vals.forEach((v, i) => (i === 0 ? ctx.moveTo(X(grid[i]), Y(v)) : ctx.lineTo(X(grid[i]), Y(v)))); ctx.stroke();
        ctx.setLineDash([]); ctx.lineWidth = 1;
      };
      line(rnd, CHART_COLORS.neutral, [5, 3]);
      line(sel, EVENT_WINDOW_COLORS.lookback, []);
      ctx.fillStyle = CHART_COLORS.ink;
      ctx.textAlign = "right";
      for (let g = 0; g <= 4; g++) ctx.fillText(`${g * 25}%`, left - 4, Y(g / 4) + 4);
      ctx.textAlign = "center";
      for (let g = 0; g <= 4; g++) { const v = x0 + ((x1 - x0) * g) / 4; ctx.fillText(v.toFixed(1), X(v), top + ph + 14); }
      ctx.fillText("検証でのシャープ（年率）", left + pw / 2, height - 4);
    }} />
  );
}

export interface CurrentRule {
  direction: MoveDirection;
  lookback: number;
  threshold: number;
  hold: number;
}

interface Props {
  unit: ThresholdUnit;
  inputs: GridInputs;
  setInputs: (updater: (prev: GridInputs) => GridInputs) => void;
  runState: RobustnessRun;
  configKey: string;
  onRun: () => void;
  onCancel: () => void;
  current: CurrentRule;
  currentTrades: TradeRecord[];
  triedCount: number;
  onResetTried: () => void;
}

export default function NdayMoveRobustness({
  unit, inputs, setInputs, runState, configKey, onRun, onCancel, current, currentTrades, triedCount, onResetTried,
}: Props) {
  const r = runState.result;
  const stale = r !== null && runState.key !== configKey;
  const grid = gridFromInputs(inputs);
  const nCandidates = grid.directions.length * new Set(grid.lookbacks).size * new Set(grid.thresholds).size * new Set(grid.holds).size;
  const conc = useMemo(() => concentration(currentTrades), [currentTrades]);
  const closed = currentTrades.filter((t) => t.status === "closed");
  const sd = useMemo(() => {
    if (closed.length < 2) return null;
    const xs = closed.map((t) => t.netReturn);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  }, [closed]);
  const inflation = sd !== null ? selectionInflation(sd, closed.length, Math.max(2, r?.candidates.length ?? nCandidates)) : null;
  const neighbor = r ? neighborsOf(r.candidates, gridFromInputs(inputs), current) : null;
  const positiveShare = r && r.candidates.length > 0 ? r.candidates.filter((c) => (c.sharpe ?? 0) > 0).length / r.candidates.length : null;
  const sharpes = r ? r.candidates.map((c) => c.sharpe).filter((v): v is number => v !== null).sort((a, b) => a - b) : [];
  const medianSharpe = sharpes.length > 0 ? sharpes[Math.floor((sharpes.length - 1) / 2)] : null;
  const wf = r?.walkForward;
  const cs = r?.cscv;
  const logitHist = cs ? binValues(cs.logits, 24, (v) => v.toFixed(1)) : null;
  const topSelected = cs && r ? cs.selectedCount.map((count, i) => ({ c: r.candidates[i], count })).filter((x) => x.count > 0).sort((a, b) => b.count - a.count).slice(0, 5) : [];
  const set = (k: keyof GridInputs) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value;
    setInputs((prev) => ({ ...prev, [k]: value }));
  };
  const maxYearAbs = Math.max(1e-9, ...conc.byYear.map((y) => Math.abs(y.sumLog)));

  return (
    <div className="space-y-4">
      <Notice>
        n・p・h を変えた<strong>候補の全件</strong>を同じ期間・同じ費用で評価し、台帳に残します。最良の1つではなく、格子全体の分布・近傍・年代順の再選択（ウォークフォワード）・CSCV による PBO で、成績が偶然や過剰適合で説明できないかを点検します。
        ここで使う期間は設計者（あなた）がすでに見たデータなので、<strong>どの検証も完全に未見のデータではありません</strong>（擬似アウトオブサンプル）。
      </Notice>

      <fieldset className="space-y-3 rounded border border-gray-200 p-3">
        <legend className="px-1 text-xs font-medium">候補格子と検証の設定</legend>
        <div className="flex flex-wrap gap-4 text-xs">
          <label className="flex items-center gap-1"><input type="checkbox" checked={inputs.down} onChange={set("down")} />下落後に買う</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={inputs.up} onChange={set("up")} />上昇後に買う</label>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className={labelClass}>判定期間 n の候補（営業日・カンマ区切り）<input className={inputClass} value={inputs.lookbacks} onChange={set("lookbacks")} /></label>
          <label className={labelClass}>閾値 p の候補（{unit === "pct" ? "%" : "σ"}）<input className={inputClass} value={inputs.thresholds} onChange={set("thresholds")} /></label>
          <label className={labelClass}>保有日数 h の候補（営業日）<input className={inputClass} value={inputs.holds} onChange={set("holds")} /></label>
          <label className={labelClass}>ウォークフォワードの最低訓練年数<input className={inputClass} type="number" min="1" max="8" step="1" value={inputs.minTrainYears} onChange={set("minTrainYears")} /></label>
          <label className={labelClass}>選択に要る訓練の最低取引数<input className={inputClass} type="number" min="1" max="100" step="1" value={inputs.minTrades} onChange={set("minTrades")} /></label>
          <label className={labelClass}>CSCV の分割数 S（偶数）
            <select className={inputClass} value={inputs.S} onChange={set("S")}>{["8", "10", "12", "14", "16"].map((s) => <option key={s} value={s}>{s}（{({ "8": 70, "10": 252, "12": 924, "14": 3432, "16": 12870 } as Record<string, number>)[s].toLocaleString("ja-JP")}通り）</option>)}</select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="rounded bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-800 disabled:opacity-40" onClick={onRun} disabled={runState.status === "running" || nCandidates === 0}>
            {r ? "再計算する" : "計算する"}（候補{nCandidates}通り）
          </button>
          {runState.status === "running" && <button type="button" className={buttonClass} onClick={onCancel}>キャンセル</button>}
          {runState.status === "running" && (
            <span role="status" className="text-xs text-gray-700">
              {runState.progress ? `${STAGE_LABEL[runState.progress.stage] ?? runState.progress.stage} ${runState.progress.done}/${runState.progress.total}` : "計算を始めています…"}
              <progress className="ml-2 h-2 w-32 align-middle" max={runState.progress?.total ?? 1} value={runState.progress?.done ?? 0} />
            </span>
          )}
          {runState.elapsedMs !== null && runState.status === "done" && <span className="text-xs text-gray-500">計算時間 {(runState.elapsedMs / 1000).toFixed(1)}秒</span>}
        </div>
        <p className="text-xs text-gray-600">この端末でこの銘柄について試した条件（方向・n・p・H・h などの組）：<strong>{triedCount}通り</strong>。手で条件を動かすのも「試行」です。多く試すほど、どこかで良い成績が偶然に出やすくなります。<button type="button" className="ml-2 underline" onClick={onResetTried}>記録を消す</button></p>
      </fieldset>

      {runState.status === "error" && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">計算できませんでした：{runState.error}</p>}
      {stale && <Notice tone="warn">分析期間・費用・資金・格子のいずれかが変わりました。下の結果は前の条件のものです。「再計算する」を押してください。</Notice>}
      {!r && runState.status !== "running" && <p className="rounded bg-gray-50 p-4 text-sm text-gray-600">まだ計算していません。「計算する」を押すと、候補格子・ウォークフォワード・PBO を計算します（数秒かかります。計算中も他の操作はできます）。</p>}

      {r && !r.error && (
        <div className={stale ? "opacity-60" : ""}>
          <section className="space-y-2">
            <h4 className="text-sm font-medium">1. 試した候補の台帳（全{r.candidates.length}通り）</h4>
            <p className="text-xs text-gray-600">共通の評価期間 {r.evalStartDate}〜{r.endDate}（最大の n でも判定できる日の翌日から。候補ごとに期間がずれると成績の差に期間の差が混ざるため）。同じ費用・同じ資金規則。青枠が現在の条件です。</p>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <StatCard label="シャープが正の候補" value={pctPlain(positiveShare)} note={`${r.candidates.length}通り中`} />
              <StatCard label="候補のシャープの中央値" value={num(medianSharpe)} note="最良値ではなく真ん中を見る" />
              <StatCard label="同じ期間の買い持ち" value={`${num(r.buyHold?.sharpe)}`} note={`シャープ・年率 ${pctSigned(r.buyHold?.cagr)}`} />
              <StatCard label="最良を選ぶ水増しの目安" value={inflation === null ? "—" : `+${(inflation * 100).toFixed(2)}%/回`} note={`SE·√(2 ln N)、N=${r.candidates.length}（系C26）`} />
            </div>
            <Heatmaps result={r} unit={unit} current={current} />
            <details className="rounded border border-gray-200 p-3">
              <summary className="cursor-pointer text-xs font-medium">台帳の全件（列名で並べ替え。既定は格子の順）</summary>
              <div className="mt-2"><LedgerTable result={r} unit={unit} current={current} /></div>
            </details>
            <p className="text-xs text-gray-600">
              「最良を選ぶ水増しの目安」は、効果がまったく無くても {r.candidates.length}通りの中で一番よいものを選ぶだけで、1回あたりの平均がこの程度は押し上げられうる、という大きさです（現在の条件の取引のばらつきから計算）。手で試した{triedCount}通りはここに含めていません。
            </p>
          </section>

          <section className="mt-4 space-y-2">
            <h4 className="text-sm font-medium">2. 少し条件を変えただけで崩れないか（近傍）</h4>
            {neighbor ? (
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-right text-xs tabular-nums">
                  <thead><tr className="border-b text-gray-600"><th className="p-2 text-left">候補</th><th className="p-2">取引</th><th className="p-2">1回平均</th><th className="p-2">資産の増減</th><th className="p-2">シャープ</th></tr></thead>
                  <tbody>{[neighbor.center, ...neighbor.neighbors].map((c, i) => (
                    <tr key={c.key} className={`border-t border-gray-100 ${i === 0 ? "bg-blue-50 font-medium" : ""}`}>
                      <td className="p-2 text-left">{i === 0 ? "現在：" : "近傍："}{specLabel(c, unit)}</td><td className="p-2">{c.trades}</td><td className="p-2">{pctSigned(c.meanNet)}</td><td className="p-2">{pctSigned(Math.expm1(c.logGrowth))}</td><td className="p-2">{num(c.sharpe)}</td>
                    </tr>
                  ))}</tbody>
                </table>
                <p className="mt-1 text-xs text-gray-600">近傍（n・p・h のどれか1つを1段ずらした候補）のシャープの中央値：<strong>{num(neighbor.neighborSharpeMedian)}</strong>（現在 {num(neighbor.center.sharpe)}）。現在の条件だけが突出して良く、近傍が振るわないなら、偶然の尖り（過剰適合）を疑います。</p>
              </div>
            ) : <p className="text-xs text-gray-600">現在の条件（{specLabel(current, unit)}）は格子に含まれていません。格子に同じ n・p・h を入れると近傍を比べられます。</p>}
          </section>

          <section className="mt-4 space-y-2">
            <h4 className="text-sm font-medium">3. 年代順のウォークフォワード（擬似アウトオブサンプル）</h4>
            {wf && wf.status === "ok" ? (
              <>
                <p className="text-xs text-gray-600">各年について、評価開始〜前年末だけで候補を選び（決済が前年末を越える取引は訓練に入れない）、選んだ条件を固定してその1年に適用します。選択はシャープ（待機日0・費用込み）が最大で、訓練の取引が{inputs.minTrades}回以上の候補から。正の候補が無ければ「取引しない」。期をまたぐ建玉は建てた期の条件で満期まで持ちます。</p>
                <div className="overflow-x-auto">
                  <table className="w-full whitespace-nowrap text-right text-xs tabular-nums">
                    <thead><tr className="border-b text-gray-600"><th className="p-2 text-left">検証年</th><th className="p-2 text-left">訓練期間</th><th className="p-2 text-left">選んだ条件</th><th className="p-2">選択可能な候補</th><th className="p-2">訓練の取引</th><th className="p-2">訓練シャープ</th><th className="p-2">検証の取引</th><th className="p-2">検証の資産増減</th><th className="p-2">同期間の買い持ち</th></tr></thead>
                    <tbody>{wf.folds.map((f) => (
                      <tr key={f.year} className="border-t border-gray-100">
                        <td className="p-2 text-left">{f.year}（{f.testStartDate}〜{f.testEndDate}）</td>
                        <td className="p-2 text-left">{f.trainStartDate}〜{f.trainEndDate}</td>
                        <td className="p-2 text-left">{f.selected ? specLabel(f.selected, unit) : "取引しない（現金）"}</td>
                        <td className="p-2">{f.eligible}</td><td className="p-2">{f.trainTrades ?? "—"}</td><td className="p-2">{num(f.trainSharpe)}</td>
                        <td className="p-2">{f.testTrades}</td><td className="p-2">{pctSigned(Math.expm1(f.testLogGrowth))}</td><td className="p-2">{pctSigned(Math.expm1(f.buyHoldLogGrowth))}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <StatCard label="検証期間をつないだ資産" value={pctSigned(wf.strategy?.totalReturn)} note={`年率 ${pctSigned(wf.strategy?.cagr)}・取引 ${wf.trades.length}回`} />
                  <StatCard label="同じ期間の買い持ち" value={pctSigned(wf.buyHold?.totalReturn)} note={`年率 ${pctSigned(wf.buyHold?.cagr)}`} />
                  <StatCard label="シャープ（検証 / 買い持ち）" value={`${num(wf.strategy?.sharpe)} / ${num(wf.buyHold?.sharpe)}`} />
                  <StatCard label="「取引しない」を選んだ年" value={`${wf.cashFolds} / ${wf.folds.length}`} />
                </div>
                {wf.folds.length < 3 && <Notice tone="warn">検証に回せた年が{wf.folds.length}年しかありません。1〜2年の結果は相場の巡り合わせで大きく変わり、判断材料になりません。</Notice>}
                <NdayMoveEquityChart points={wf.equity} strategyLabel="検証期間をつないだ規則" ariaLabel={`ウォークフォワードの検証期間をつないだ資産曲線。${pctSigned(wf.strategy?.totalReturn)}、買い持ち${pctSigned(wf.buyHold?.totalReturn)}。`} />
              </>
            ) : <Notice tone="muted">ウォークフォワードは実施できません：{wf?.reason ?? "期間が足りません。"}</Notice>}
          </section>

          <section className="mt-4 space-y-2">
            <h4 className="text-sm font-medium">4. バックテスト過剰適合確率 PBO（CSCV, Bailey et al.）</h4>
            {cs ? (
              <>
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <StatCard label="PBO" value={pctPlain(cs.pbo)} note="訓練で最良の候補が、検証で候補の中央値以下に落ちた割合" />
                  <StatCard label="損失確率（別の指標）" value={pctPlain(cs.probLoss)} note="訓練最良の検証シャープが負だった割合" />
                  <StatCard label="性能劣化の傾き" value={num(cs.degradation?.slope)} note="訓練が良いほど検証が悪いなら負" />
                  <StatCard label="確率優越" value={cs.dominance.first ? "一次で成立" : cs.dominance.second ? "二次で成立" : "不成立"} note="選ぶ手順が無作為の1つより良いか" />
                </div>
                <p className="text-xs text-gray-600">
                  全期間 {cs.T}営業日を{cs.S}個の連続した塊（各{cs.blockLength}日、古い側の端数{cs.dropped}日を除く）に分け、半分ずつを訓練・検証にする{cs.combinations.toLocaleString("ja-JP")}通りすべてで「訓練で最良のシャープの候補」を選び、検証での相対順位 ω̄＝順位/(N+1)（N={cs.N}、中身の異なる候補{cs.distinctN}）のロジットを集計しました。
                  PBO は「候補の集まりから最良を選ぶという手順」の評価で、現在の条件1つの勝率や損失確率ではありません。PBO が 0.5 前後なら、訓練での順位は検証での順位をほとんど予告していません。
                </p>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="min-w-0">
                    <p className="mb-1 text-xs font-medium">ロジット λ の分布（0以下の割合＝PBO・破線＝λ=0）</p>
                    {logitHist && <BarHistogram bins={logitHist.bins.map((b) => ({ ...b, tone: Number(b.label) <= 0 ? "down" as const : "up" as const }))} xLabel="λ = ln(ω/(1−ω))（ω＝検証での相対順位）" description={`ロジットの分布。${cs.combinations}組、PBO ${pctPlain(cs.pbo)}。`} marker={{ at: (0 - logitHist.lo) / logitHist.width, label: "λ=0" }} />}
                  </div>
                  <div className="min-w-0">
                    <p className="mb-1 text-xs font-medium">性能劣化：訓練最良の、訓練 vs 検証のシャープ</p>
                    <DegradationScatter isSel={cs.isSelected} oosSel={cs.oosSelected} slope={cs.degradation?.slope ?? null} intercept={cs.degradation?.intercept ?? null} />
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="min-w-0">
                    <p className="mb-1 text-xs font-medium">確率優越：選んだ候補（実線）と無作為の1つ（破線）の検証シャープの累積分布</p>
                    <DominanceChart grid={cs.dominance.grid} sel={cs.dominance.cdfSelected} rnd={cs.dominance.cdfRandom} />
                  </div>
                  <div className="min-w-0 text-xs">
                    <p className="mb-1 font-medium">訓練最良に選ばれた回数の多い候補</p>
                    <ol className="list-decimal pl-5">{topSelected.map((x) => <li key={x.c.key}>{specLabel(x.c, unit)}：{x.count.toLocaleString("ja-JP")}回（{pctPlain(x.count / cs.combinations)}）</li>)}</ol>
                    <p className="mt-2 text-gray-600">注意：CSCV は試した候補がすべて台帳に載っていることを前提にします（載せなかった試行があると PBO は過小になる）。塊の境界をまたぐ保有や系列相関は完全には切れません。PBO を条件選びの目的関数に使ってはいけません。</p>
                  </div>
                </div>
              </>
            ) : <Notice tone="muted">PBO は計算していません（標本不足）：{r.cscvStatus.reasons.join(" ")}</Notice>}
          </section>
        </div>
      )}

      <section className="space-y-2">
        <h4 className="text-sm font-medium">5. 利益が一部の年・少数の取引に集中していないか（現在の条件・②の確定取引）</h4>
        {conc.trades === 0 ? <p className="text-xs text-gray-600">確定取引がありません。</p> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap text-right text-xs tabular-nums">
                <thead><tr className="border-b text-gray-600"><th className="p-2 text-left">年</th><th className="p-2">取引</th><th className="p-2">損益（対数の和→%）</th><th className="p-2 text-left">寄与</th></tr></thead>
                <tbody>{conc.byYear.map((y) => (
                  <tr key={y.year} className="border-t border-gray-100">
                    <td className="p-2 text-left">{y.year}</td><td className="p-2">{y.trades}</td><td className="p-2">{pctSigned(Math.expm1(y.sumLog))}</td>
                    <td className="p-2 text-left"><span className={`inline-block h-2 align-middle ${y.sumLog >= 0 ? "bg-green-600" : "bg-red-600"}`} style={{ width: `${Math.round((80 * Math.abs(y.sumLog)) / maxYearAbs)}px` }} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <ul className="list-disc pl-5 text-xs text-gray-700">
              <li>全{conc.trades}回の累積：{pctSigned(Math.expm1(conc.totalLog))}</li>
              {conc.withoutTop.map((w) => <li key={w.k}>最も儲かった{w.k}回を除くと：{pctSigned(Math.expm1(w.totalLog))}</li>)}
              {conc.top10ShareOfGains !== null && <li>上位10%の取引が、利益の合計に占める割合：{pctPlain(conc.top10ShareOfGains)}</li>}
              {conc.leaveOneYearOut && <li>1年ずつ除いたときの累積：{pctSigned(Math.expm1(conc.leaveOneYearOut.min))}（{conc.leaveOneYearOut.minYear}年を除く）〜{pctSigned(Math.expm1(conc.leaveOneYearOut.max))}（{conc.leaveOneYearOut.maxYear}年を除く）</li>}
            </ul>
            <p className="text-xs text-gray-600">数回の大当たりや特定の1年を除くと符号が変わるなら、その成績は再現を期待しにくい「当たりくじ」です。</p>
          </>
        )}
      </section>
    </div>
  );
}
