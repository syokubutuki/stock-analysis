"use client";

// 寄り前情報アナログ: 曜日 × 前夜米国ビン で絞ったうえに「今日に至る経路の形」が似た過去日だけを
// 選び、その連続パス(直近K日の日足 → 夜間ギャップ → 当日日内)を今日の経路に重ねる。
//
// 3つの視点:
//   ① 重ね     : 近傍k本の連続パス + 加重中央値 + 四分位帯 vs 条件セル平均 vs 無条件平均 + 今日の実測
//   ② 近傍一覧 : どの日が選ばれたか(距離・重み・前夜米国・ギャップ・引け)
//   ③ OOS検証 : 形で絞ると本当に予測が良くなるのか(IC/的中率/損失差 + ランダムk本ヌル)
//
// 計算はすべて lib/intraday-analog.ts。ここは配線と描画のみ。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  computeIntradayAnalog, IntradayAnalogResult, AnalogCond, ANALOG_CONDS,
  AnalogMetric, AnalogWeight, AnalogOos,
} from "../../lib/intraday-analog";
import { buildUsBinning, WD_LABELS } from "../../lib/today-vs-expected";
import { BinScheme, AlignedDay } from "../../lib/us-spillover-core";
import { UsBinMode } from "../../lib/us-spillover-path";
import { useAlignedDays, UsDriverButtons, BinSchemeButtons } from "./usSpilloverShared";
import { US_DRIVERS } from "../../hooks/useUsDaily";
import {
  initCanvas, IntervalButtons, LoadingError, IntradayCaveat, ViewTabs, fmtSignedPct, fmtPct,
} from "./intradayShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";
import { CHART_COLORS } from "../../lib/chart-colors";

interface Props { ticker: string; }

const US_MODES: { value: UsBinMode; label: string }[] = [
  { value: "ret", label: "前日終値比" },
  { value: "intra", label: "日中" },
];

type View = "overlay" | "list" | "oos";
const VIEWS: { value: View; label: string }[] = [
  { value: "overlay", label: "① 経路を重ねる" },
  { value: "list", label: "② 選ばれた過去日" },
  { value: "oos", label: "③ 形で絞ると当たるのか（OOS）" },
];

const LEAD_OPTS = [3, 5, 10, 20];
const K_OPTS = [5, 10, 20, 40];

const C_ANALOG = "#2563eb"; // 近傍(アナログ)
const C_CELL = "#64748b"; // 条件セル平均
const C_UNCOND = CHART_COLORS.neutral; // 無条件平均
const C_TODAY = "#111827"; // 今日の実測

// ───────────────────────── ① 連続パスの重ね描き ─────────────────────────

function drawOverlay(
  ctx: CanvasRenderingContext2D, W: number, H: number, r: IntradayAnalogResult,
  opts: { showNeighbors: boolean; showBand: boolean; showCell: boolean; showUncond: boolean }
) {
  const ml = 48, mr = 10, mt = 12, mb = 26;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const T = r.fullLabels.length;
  if (T < 3) return;
  const yMax = r.maxAbs * 1.05;
  const X = (i: number) => ml + (i / (T - 1)) * plotW;
  const Y = (v: number) => mt + (1 - (v + yMax) / (2 * yMax)) * plotH;

  // グリッド + ゼロ線
  ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();

  ctx.fillStyle = CHART_COLORS.ink; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(fmtSignedPct(yMax, 1), ml - 3, mt + 8);
  ctx.fillText("0", ml - 3, Y(0) + 3);
  ctx.fillText(fmtSignedPct(-yMax, 1), ml - 3, mt + plotH);

  // 過去(日足リードイン)と当日(日内)の境界。左=前日までに確定した経路、右=これから動く当日。
  const bx = X(r.leadLen - 0.5);
  ctx.setLineDash([4, 3]); ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(bx, mt); ctx.lineTo(bx, mt + plotH); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#b45309"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("寄り前に確定 ←｜→ 当日", bx, mt + 9);

  ctx.save();
  ctx.beginPath(); ctx.rect(ml, mt, plotW, plotH); ctx.clip();

  const stroke = (vals: number[], color: string, width: number, upto = T - 1) => {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i <= upto; i++) { const x = X(i), y = Y(vals[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  };

  // 近傍の四分位帯(25-75%)。平均の精度ではなく「似た日々のばらつき」を示す。
  if (opts.showBand) {
    ctx.fillStyle = C_ANALOG + "22";
    ctx.beginPath();
    for (let i = 0; i < T; i++) ctx.lineTo(X(i), Y(r.analog.q75[i]));
    for (let i = T - 1; i >= 0; i--) ctx.lineTo(X(i), Y(r.analog.q25[i]));
    ctx.closePath(); ctx.fill();
  }

  // 近傍の個別日。似ている(重みが大きい)ほど濃く太い。
  if (opts.showNeighbors && r.neighbors.length > 0) {
    const wMax = Math.max(...r.neighbors.map((n) => n.weight));
    for (const n of r.neighbors) {
      const t = wMax > 0 ? n.weight / wMax : 1;
      const a = Math.round((0.12 + 0.33 * t) * 255).toString(16).padStart(2, "0");
      stroke(n.full, C_ANALOG + a, 0.6 + 1.0 * t);
    }
  }

  if (opts.showUncond) { ctx.setLineDash([3, 3]); stroke(r.uncond.mean, C_UNCOND, 1.5); ctx.setLineDash([]); }
  if (opts.showCell) stroke(r.cell.mean, C_CELL, 1.8);
  stroke(r.analog.med, C_ANALOG, 2.5); // 近傍の加重中央値 = アナログの予測パス

  // 今日の実測(黒)。到達済みの区間だけ。
  const todayUpto = r.leadLen + 1 + Math.max(0, r.target.lastIdx);
  stroke(r.target.full, C_TODAY, 2.5, Math.min(T - 1, todayUpto));
  const cx = X(Math.min(T - 1, todayUpto)), cy = Y(r.target.full[Math.min(T - 1, todayUpto)]);
  ctx.fillStyle = "#ffffff"; ctx.strokeStyle = C_TODAY; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  ctx.restore();

  // 横軸ラベル(密なら間引く)
  ctx.fillStyle = "#6b7280"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
  const every = T > 16 ? Math.ceil(T / 14) : 1;
  for (let i = 0; i < T; i++) {
    if (i % every !== 0 && i !== r.leadLen) continue;
    ctx.fillText(r.fullLabels[i], X(i), H - 8);
  }
}

// ───────────────────────── ③ ヌルIC分布 ─────────────────────────

function drawNullHist(
  ctx: CanvasRenderingContext2D, W: number, H: number, nullIc: number[], actual: number
) {
  const ml = 34, mr = 10, mt = 10, mb = 20;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  if (nullIc.length < 10) return;
  const lo = Math.min(nullIc[0], actual) - 0.02;
  const hi = Math.max(nullIc[nullIc.length - 1], actual) + 0.02;
  const nb = 24;
  const counts = new Array(nb).fill(0);
  for (const v of nullIc) counts[Math.max(0, Math.min(nb - 1, Math.floor(((v - lo) / (hi - lo)) * nb)))]++;
  const cMax = Math.max(...counts, 1);
  const X = (v: number) => ml + ((v - lo) / (hi - lo)) * plotW;

  ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(ml, mt + plotH); ctx.lineTo(ml + plotW, mt + plotH); ctx.stroke();

  const bw = plotW / nb;
  for (let b = 0; b < nb; b++) {
    const h = (counts[b] / cMax) * plotH;
    ctx.fillStyle = "#cbd5e1";
    ctx.fillRect(ml + b * bw + 0.5, mt + plotH - h, bw - 1, h);
  }
  // 実測IC
  ctx.strokeStyle = C_ANALOG; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(X(actual), mt); ctx.lineTo(X(actual), mt + plotH); ctx.stroke();
  ctx.fillStyle = C_ANALOG; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  ctx.fillText(`実測IC ${actual.toFixed(3)}`, Math.min(ml + plotW - 30, Math.max(ml + 30, X(actual))), mt + 9);

  ctx.fillStyle = CHART_COLORS.ink; ctx.font = "8px sans-serif";
  ctx.textAlign = "left"; ctx.fillText(lo.toFixed(2), ml, H - 6);
  ctx.textAlign = "right"; ctx.fillText(hi.toFixed(2), ml + plotW, H - 6);
  ctx.textAlign = "center"; ctx.fillText("ランダムk本ヌルのIC分布", ml + plotW / 2, H - 6);
}

// ───────────────────────── 本体 ─────────────────────────

export default function IntradayAnalogPathChart({ ticker }: Props) {
  const [usTicker, setUsTicker] = useState("^IXIC");
  const [interval, setInterval] = useState("60m");
  const [scheme, setScheme] = useState<BinScheme>("tercile");
  const [usMode, setUsMode] = useState<UsBinMode>("ret");
  const [cond, setCond] = useState<AnalogCond>("us");
  const [leadLen, setLeadLen] = useState(5);
  const [k, setK] = useState(10);
  const [metric, setMetric] = useState<AnalogMetric>("euclid");
  const [weight, setWeight] = useState<AnalogWeight>("kernel");
  const [view, setView] = useState<View>("overlay");
  const [showNeighbors, setShowNeighbors] = useState(true);
  const [showBand, setShowBand] = useState(true);
  const [showCell, setShowCell] = useState(true);
  const [showUncond, setShowUncond] = useState(false);

  const { data, loading, error } = useAlignedDays(ticker, interval, usTicker);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nullRef = useRef<HTMLCanvasElement>(null);

  const binning = useMemo(
    () => (data ? buildUsBinning(data.aligned, data.us, usMode, scheme) : null),
    [data, usMode, scheme]
  );

  const result = useMemo(() => {
    if (!binning || !data?.grid) return null;
    const usVal = (a: AlignedDay) => (usMode === "intra" ? a.us.intra : a.us.ret);
    return computeIntradayAnalog({
      rows: binning.rows,
      binIdx: binning.binIdx,
      usValues: binning.rows.map(usVal),
      grid: data.grid,
      gmtoffset: data.gmtoffset,
      leadLen, k, cond, metric, weight,
    });
  }, [binning, data, usMode, leadLen, k, cond, metric, weight]);

  useEffect(() => {
    if (view !== "overlay" || !result || !canvasRef.current) return;
    const init = initCanvas(canvasRef.current, 300);
    if (init) drawOverlay(init.ctx, init.width, init.height, result, { showNeighbors, showBand, showCell, showUncond });
  }, [view, result, showNeighbors, showBand, showCell, showUncond]);

  useEffect(() => {
    if (view !== "oos" || !result?.oos || !nullRef.current) return;
    const init = initCanvas(nullRef.current, 150);
    if (init) drawNullHist(init.ctx, init.width, init.height, result.oos.nullIc, result.oos.analog.ic);
  }, [view, result]);

  const usLabel = US_DRIVERS.find((d) => d.ticker === usTicker)?.label ?? usTicker;
  const condMeta = ANALOG_CONDS.find((c) => c.value === cond)!;

  // OOSの結論: 「形で絞る」手続きがヌル(同じ条件セルからランダムにk本)を超えているか。
  const verdict = useMemo(() => {
    const o = result?.oos;
    if (!o) return null;
    const beatsNull = o.icNullP < 0.05 && o.analog.ic > 0;
    const beatsCell = o.lossMean > 0 && o.lossP < 0.05;
    const losesToCell = o.lossMean < 0 && o.lossP < 0.05;
    if (beatsNull && beatsCell) return { tone: "good", text: "形の近さで絞ると、ランダム選抜ヌルも条件セル平均も有意に上回っている。アナログ選抜に根拠がある。" };
    if (beatsNull || beatsCell) return { tone: "mixed", text: "片方の基準しか超えていない。効果があるとしても弱く、標本の取り方に依存する可能性が高い。" };
    if (losesToCell) return { tone: "bad", text: "ランダムにk本選んだヌルの範囲内で、しかも予測誤差は条件セル平均より有意に大きい。形で絞ると標本をk本に減らすぶんノイズが増えるだけで、この銘柄・この設定では有害。判断は条件セル平均（曜日×米国ビンの素の平均）で行うこと。" };
    return { tone: "bad", text: "ランダムにk本選んだヌルの範囲内。この銘柄・この設定では「形が似た日を選ぶ」ことに予測上の価値は認められない（重ね描きは記述であって予測ではない）。" };
  }, [result]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">寄り前情報アナログ：似た経路をたどった過去日の日内パスを重ねる</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <UsDriverButtons value={usTicker} onChange={setUsTicker} />
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">ビン基準:</span>
          {US_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setUsMode(m.value)}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                usMode === m.value ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >{m.label}</button>
          ))}
        </div>
        <BinSchemeButtons value={scheme} onChange={setScheme} />
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">候補の絞り込み:</span>
          {ANALOG_CONDS.map((c) => (
            <button
              key={c.value}
              onClick={() => setCond(c.value)}
              title={c.note}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                cond === c.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >{c.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">リードイン:</span>
          {LEAD_OPTS.map((L) => (
            <button
              key={L}
              onClick={() => setLeadLen(L)}
              title={`直近${L}営業日の日足の形で似た日を探す`}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                leadLen === L ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >{L}日</button>
          ))}
        </div>
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">近傍数k:</span>
          {K_OPTS.map((n) => (
            <button
              key={n}
              onClick={() => setK(n)}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                k === n ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >{n}</button>
          ))}
        </div>
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">距離:</span>
          {([["euclid", "等速"], ["dtw", "DTW"]] as [AnalogMetric, string][]).map(([v, l]) => (
            <button
              key={v}
              onClick={() => setMetric(v)}
              title={v === "dtw" ? "動的時間伸縮。山谷が1日ずれていても同じ形とみなす" : "同じ日付位置どうしを比べる"}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                metric === v ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >{l}</button>
          ))}
        </div>
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">重み:</span>
          {([["uniform", "等重み"], ["kernel", "距離カーネル"]] as [AnalogWeight, string][]).map(([v, l]) => (
            <button
              key={v}
              onClick={() => setWeight(v)}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                weight === v ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >{l}</button>
          ))}
        </div>
      </div>

      <LoadingError loading={loading} error={error} />
      {!loading && !error && data && !result && (
        <div className="text-xs text-fg-muted">
          候補日が不足しています（60分足を選ぶ／絞り込みを「米国のみ」「無条件」に緩める／リードインを短くする）。
        </div>
      )}

      {result && (
        <>
          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
            <span className="font-bold">
              対象日 {result.target.date}（{WD_LABELS[result.target.weekday]}・前夜{usLabel} {fmtSignedPct(result.target.usValue, 2)}）
            </span>
            {" → "}
            候補 {result.nCand}日（{condMeta.label}）から形の近い {result.neighbors.length}日 を選抜。
            <span className="ml-2">
              前例の薄さ {fmtPct(result.novelty, 0)}
              <span className="text-blue-700">
                {result.novelty > 0.8 ? "（＝今日に似た前例がほとんど無い。重ねた過去日は「似ていない日の寄せ集め」なので読み込みすぎない）" : ""}
              </span>
            </span>
          </div>

          <ViewTabs value={view} onChange={setView} views={VIEWS} />

          {view === "overlay" && (
            <>
              <div className="flex items-center gap-4 flex-wrap text-xs text-gray-600">
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={showNeighbors} onChange={(e) => setShowNeighbors(e.target.checked)} />
                  近傍の個別日
                </label>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={showBand} onChange={(e) => setShowBand(e.target.checked)} />
                  近傍の25-75%帯
                </label>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={showCell} onChange={(e) => setShowCell(e.target.checked)} />
                  条件セル平均（距離を使わない）
                </label>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={showUncond} onChange={(e) => setShowUncond(e.target.checked)} />
                  無条件平均
                </label>
              </div>
              <div className="flex items-center gap-3 flex-wrap text-[11px]">
                <span className="inline-flex items-center gap-1"><span className="inline-block w-4 h-0.5" style={{ backgroundColor: C_TODAY }} /><span className="text-gray-600">今日の実測</span></span>
                <span className="inline-flex items-center gap-1"><span className="inline-block w-4 h-0.5" style={{ backgroundColor: C_ANALOG }} /><span className="text-gray-600">アナログ（近傍の加重中央値）</span></span>
                <span className="inline-flex items-center gap-1"><span className="inline-block w-4 h-0.5" style={{ backgroundColor: C_CELL }} /><span className="text-gray-600">条件セル平均</span></span>
                <span className="inline-flex items-center gap-1"><span className="inline-block w-4 h-0.5 border-t border-dashed" style={{ borderColor: C_UNCOND }} /><span className="text-gray-600">無条件平均</span></span>
              </div>
              <div className="relative"><canvas ref={canvasRef} /></div>
              <p className="text-[11px] text-gray-500">
                {"縦軸はすべて「前日終値=0」の累積対数リターン。左半分は前日までの日足経路（寄り前に確定＝距離の計算に使った部分）、境界の点が寄り付き（夜間ギャップ）、右半分が当日の日内。対数なので ギャップ+日中=当日 が足し算で繋がる。"}
                {" 黒が今日、青が「似た経路をたどった過去日」の中央値。青と黒が寄り付き以降で離れていくなら、今日は前例と違う動きをしている。"}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div className="bg-gray-50 rounded p-2">
                  <div className="text-gray-500">アナログの引け予想</div>
                  <div className={`font-bold ${result.analog.end >= 0 ? "text-green-700" : "text-red-600"}`}>{fmtSignedPct(result.analog.end)}</div>
                </div>
                <div className="bg-gray-50 rounded p-2">
                  <div className="text-gray-500">条件セル平均</div>
                  <div className={`font-bold ${result.cell.end >= 0 ? "text-green-700" : "text-red-600"}`}>{fmtSignedPct(result.cell.end)}</div>
                </div>
                <div className="bg-gray-50 rounded p-2">
                  <div className="text-gray-500">無条件平均</div>
                  <div className={`font-bold ${result.uncond.end >= 0 ? "text-green-700" : "text-red-600"}`}>{fmtSignedPct(result.uncond.end)}</div>
                </div>
                <div className="bg-gray-50 rounded p-2">
                  <div className="text-gray-500">今日の実測（寄り→現在）</div>
                  <div className="font-bold text-gray-800">
                    {result.target.lastIdx >= 0 ? fmtSignedPct(result.target.path[result.target.lastIdx]) : "—"}
                  </div>
                </div>
              </div>
            </>
          )}

          {view === "list" && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 px-2">日付</th>
                    <th className="text-left px-2">曜日</th>
                    <th className="text-right px-2">距離</th>
                    <th className="text-right px-2">重み</th>
                    <th className="text-right px-2">前夜米国</th>
                    <th className="text-right px-2">夜間ギャップ</th>
                    <th className="text-right px-2">寄り→引け</th>
                  </tr>
                </thead>
                <tbody>
                  {result.neighbors.map((n) => (
                    <tr key={n.date} className="border-b border-gray-100">
                      <td className="py-1 px-2 text-gray-700 tabular-nums">{n.date}</td>
                      <td className="px-2 text-gray-500">{WD_LABELS[n.weekday]}</td>
                      <td className="text-right px-2 text-gray-600 tabular-nums">{n.dist.toFixed(3)}</td>
                      <td className="text-right px-2 text-gray-500 tabular-nums">{fmtPct(n.weight, 1)}</td>
                      <td className={`text-right px-2 tabular-nums ${n.usValue >= 0 ? "text-green-700" : "text-red-600"}`}>{fmtSignedPct(n.usValue)}</td>
                      <td className={`text-right px-2 tabular-nums ${n.gap >= 0 ? "text-green-700" : "text-red-600"}`}>{fmtSignedPct(n.gap)}</td>
                      <td className={`text-right px-2 font-medium tabular-nums ${n.end >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(n.end)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-fg-muted mt-2">
                {"距離は前日までのK日の形をz化して測った差(小さいほど似ている)。重みは距離カーネルで正規化した集計ウェイト。日付が特定の時期に固まっているなら、それは「似た形」ではなく「同じ相場局面」を選んでいる可能性が高い(近い日どうしは経路も似るため)。"}
              </p>
            </div>
          )}

          {view === "oos" && (
            result.oos ? (
              <div className="space-y-3">
                <div className={`rounded-md px-3 py-2 text-xs ${
                  verdict?.tone === "good" ? "bg-green-50 text-green-900 border border-green-200"
                    : verdict?.tone === "mixed" ? "bg-amber-50 text-amber-900 border border-amber-200"
                      : "bg-red-50 text-red-900 border border-red-200"
                }`}>
                  <span className="font-bold">結論: </span>{verdict?.text}
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-200">
                        <th className="text-left py-1 px-2">予測子</th>
                        <th className="text-right px-2">日数</th>
                        <th className="text-right px-2">IC(順位相関)</th>
                        <th className="text-left px-2">有意性</th>
                        <th className="text-right px-2">方向的中率</th>
                        <th className="text-right px-2">RMSE</th>
                        <th className="text-right px-2">経路採点</th>
                      </tr>
                    </thead>
                    <tbody>
                      {([result.oos.analog, result.oos.cell, result.oos.uncond] as AnalogOos[]).map((o) => (
                        <tr key={o.label} className="border-b border-gray-100">
                          <td className="py-1 px-2 text-gray-700">{o.label}</td>
                          <td className="text-right px-2 text-gray-500 tabular-nums">{o.n}</td>
                          <td className={`text-right px-2 font-medium tabular-nums ${o.ic >= 0 ? "text-green-700" : "text-red-700"}`}>{o.ic.toFixed(3)}</td>
                          {/* ICが負なら「有意に外している」ので、有意バッジは付けない(正のICだけを実績とみなす) */}
                          <td className="px-2"><StatBadge n={o.n} p={o.icP} significant={o.icP < 0.05 && o.ic > 0} /></td>
                          <td className={`text-right px-2 tabular-nums ${o.hit > 0.5 ? "text-green-700" : "text-gray-600"}`}>
                            {fmtPct(o.hit, 1)}{o.hitP < 0.05 ? "★" : ""}
                          </td>
                          <td className="text-right px-2 text-gray-600 tabular-nums">{fmtPct(o.rmse, 2)}</td>
                          <td className="text-right px-2 text-gray-600 tabular-nums">{o.pathCorr ? o.pathCorr.toFixed(3) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">ヌル比較（IC）</div>
                    <div className="font-bold text-gray-800">p = {result.oos.icNullP.toFixed(3)}</div>
                    <div className="text-[10px] text-fg-muted">ヌル平均IC {result.oos.nullIcMean.toFixed(3)}</div>
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">損失差（セル − アナログ）</div>
                    <div className={`font-bold ${result.oos.lossMean > 0 ? "text-green-700" : "text-red-600"}`}>
                      {(result.oos.lossMean * 1e4).toFixed(2)}<span className="text-[10px] font-normal">×10⁻⁴</span>
                    </div>
                    <div className="text-[10px] text-fg-muted">p={result.oos.lossP.toFixed(3)}／CI[{(result.oos.lossLo * 1e4).toFixed(2)}, {(result.oos.lossHi * 1e4).toFixed(2)}]</div>
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">検証期間</div>
                    <div className="font-bold text-gray-800 text-[11px]">{result.oos.firstDate} 〜 {result.oos.lastDate}</div>
                  </div>
                </div>

                <div className="relative"><canvas ref={nullRef} /></div>
                <p className="text-[11px] text-gray-500">
                  {"ヌルは「同じ条件セルから距離を無視してk本を無作為抽出し、同じ集計をする」を200回繰り返した分布。近傍選抜という手続きだけを壊しているので、実測ICがこの山の中に埋もれていれば、形の近さは何も足していない。"}
                  {" 損失差は 二乗誤差(条件セル平均) − 二乗誤差(アナログ) の平均で、正ならアナログが正確。CIはブロックブートストラップ（連続する日の相関を保存）。"}
                </p>
              </div>
            ) : (
              <div className="text-xs text-fg-muted">OOS検証に必要な日数（有効な予測日20日以上）が足りません。60分足を選び、絞り込みを緩めてください。</div>
            )
          )}
        </>
      )}

      <IntradayCaveat extra="リードインの形は日足で測るため、5/15/30分足(約60営業日)では候補が数十日しか無く近傍選抜が成立しない。60分足(約2年)を既定とする。" />

      <AnalysisGuide title="寄り前情報アナログの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"「曜日×前夜米国ビン」の条件セルは、条件が一致する過去日をすべて等しく扱って平均する。だがその中には『3日下げ続けた末の木曜』も『高値を追っている最中の木曜』も混ざっている。寄り付き前に確定している情報は曜日と前夜米国だけではない ── 前日までの値動きの“形”も分かっている。この分析は、その形が今日に近い日だけを選び出し、選ばれた日の経路（直近K日の日足 → 夜間ギャップ → 当日日内）を今日の経路に重ねる。過去の経路と今日の経路を、途切れずに1本の線として突き合わせるのが目的。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"リードイン(寄り前に確定している経路): 対象日 t の前日終値 C_{t−1} を基準に ℓ_t(j) = ln(C_{t−1−K+1+j} / C_{t−1})、j=0..K−1。最終点は必ず 0。当日の値は一切使わない。"}</li>
          <li>{"形状のz化: z(ℓ) = (ℓ − mean(ℓ)) / sd(ℓ)。水準とスケールを落とし『形』だけを比較する。"}</li>
          <li>{"距離: 等速なら d = √( Σ_j (z_t(j) − z_i(j))² / K )。DTW なら動的時間伸縮 D(i,j) = (a_i−b_j)² + min(D(i−1,j), D(i,j−1), D(i−1,j−1)) を経路長で正規化した √(D/Λ)（山谷が1日ずれた似形を拾う）。"}</li>
          <li>{"重み: 等重み w_i = 1/k、または距離カーネル w_i ∝ exp(−(d_i/h)²)（Nadaraya-Watson、帯域 h = 選抜距離の中央値）。"}</li>
          <li>{"連続パス: 日足リードイン → 夜間ギャップ g = ln(O/C_{t−1}) → 日内 g + ln(P_s/O)。対数リターンなので ギャップ + 日中 = 当日 が厳密に加法で繋がり、1本の折れ線として描ける。"}</li>
          <li>{"集計: 各点で加重中央値と加重25/75%分位。終端(寄り→引け)は別に加重中央値を取り、売買の単位と揃える。"}</li>
          <li>{"IC(情報係数) = Spearman順位相関( 予測終端, 実現終端 )。p値は t = ρ√((n−2)/(1−ρ²))。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>アナログ（類似局面法）</strong>: 気象予報の古典的手法。今の状態に似た過去の状態を探し、その後の推移を予報とする。</li>
          <li><strong>リードイン</strong>: 対象時点に至るまでの経路。ここでは前日までのK日の日足。</li>
          <li><strong>DTW（動的時間伸縮）</strong>: 時間軸の伸び縮みを許して2つの波形を対応付ける距離。「同じ形だが1日早い/遅い」を同一視できる。</li>
          <li><strong>IC（情報係数）</strong>: 予測と実現の順位相関。株式の予測では 0.03〜0.05 でも十分実用と言われる程度に小さい値しか出ない。</li>
          <li><strong>前例の薄さ（novelty）</strong>: 今日の最近傍距離が、過去の各日の最近傍距離の分布の何分位にあるか。1に近いほど「似た前例が無い」。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          {"天気予報のアナログ法と同じ発想。「今日と似た気圧配置だった過去の日」を探し、その翌日の天気を並べる。ただし株価では『似た気圧配置』の定義が曖昧で、探せば必ず何かは見つかってしまう。だから重ね描き（＝それらしい絵）と、当たったかどうか（＝OOS検証）は必ず分けて扱う。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>青（アナログ中央値）と灰（条件セル平均）が大きく違う</strong>: 形の近さで選ぶと違う絵になる、という主張。ただし違う＝正しい ではない。必ず③のOOSを見る。</li>
          <li><strong>青の四分位帯が広い</strong>: 似た日を選んでも結果はばらばら。中央値の1本を信じてはいけない。</li>
          <li><strong>黒（今日）が寄り付き以降で帯の外に出た</strong>: 今日は前例と違う動き。アナログの前提が壊れている。</li>
          <li><strong>③でICがヌルの山に埋もれている</strong>: 「形が似た日を選ぶ」ことに情報が無い。重ね描きは記述にすぎない。</li>
          <li><strong>前例の薄さが高い</strong>: そもそも似た日が無い局面。この日は判断材料にしない。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>③が緑（ヌル超え＋セル平均超え）のときだけ、アナログの引け予想を寄り付きの建玉判断に使う。赤なら条件セル平均（＝曜日×米国ビンの素の平均）に戻す。</li>
          <li>四分位帯の幅は損切り/利確幅の目安になる。中央値だけでなく帯の下端（悪いシナリオ）を必ず併読する。</li>
          <li>今日の実測が帯を外れた時点でアナログの前提は崩れている。前例に基づく建玉は落とす。</li>
          <li>近傍の日付が特定の時期に固まっているなら、それは「似た形」ではなく「同じ相場局面」を拾っているだけ。局面が変わった今日には外挿できない。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"近傍選抜は自由度が非常に高い(K・k・距離・重み・絞り込みの組合せ)。設定を変えて『良い絵』を探す行為はそのまま過剰適合になる。③のOOSは設定ごとに必ず見直すこと。"}</li>
          <li>{"OOSはウォークフォワード(対象日より前の情報だけ)だが、設定そのものは全期間を見て選んでいる。厳密には設定選択のバイアスが残る。"}</li>
          <li>{"近傍日は互いに重なりうる(連続する日は経路も似る)ため、実効的な独立標本数はk本より少ない。帯の狭さを過信しない。"}</li>
          <li>{"60分足は約2年しか取れず、条件セル×形状で絞ると候補は数十日規模。5/15/30分足では成立しない。"}</li>
          <li>{"リードインは日足終値のみで測るため、同じ形でもボラの水準が違う日が混ざる(z化で水準とスケールを落としているため)。"}</li>
          <li>{"『前例が無い』ことは検出できるが、『前例が無い局面で何が起きるか』はこの手法では原理的に分からない。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
