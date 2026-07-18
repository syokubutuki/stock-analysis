"use client";

// 今週の軌跡アナログ「ウォッチリスト横断」版。
// 個別版(WeeklyAnalogChart)の computeWeeklyAnalog を全銘柄に一斉適用し、
// 「今週の入口(前夜米国ビン=市場共通) or 各銘柄の似た形」から、来週H日の先読みを一覧比較する。
// usbin モードでは前夜米国ビンは市場共通なので、選んだビン列で全銘柄の先行きを横並びにできる。

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { computeUsReturns, BinScheme } from "../../lib/us-spillover-core";
import { useUsDaily } from "../../hooks/useUsDaily";
import { useAnalogWorker } from "../../hooks/useAnalogWorker";
import {
  WeeklyAnalogResult, AnalogMode, UsMode, DistMetric, WindowAlign, WeightMode,
} from "../../lib/weekly-analog";
import { UsDriverButtons, BinSchemeButtons } from "./usSpilloverShared";
import { NAME_COL_W, useNameColMode, nameColStyle, NameColHeader } from "./crossTableShared";
import AnalysisGuide from "./AnalysisGuide";

// A4: 銘柄間フォワード相関の平均 ρ̄ を直近リターンから概算し、実効銘柄数 N_eff=N/(1+(N-1)ρ̄) を返す。
function effectiveTickers(tickers: string[], pricesByTicker: Record<string, PricePoint[]>): { rhoBar: number; nEff: number } {
  const series: number[][] = [];
  for (const t of tickers) {
    const p = pricesByTicker[t];
    if (!p || p.length < 60) continue;
    const tail = p.slice(-252);
    const r: number[] = [];
    for (let i = 1; i < tail.length; i++) if (tail[i].close > 0 && tail[i - 1].close > 0) r.push(Math.log(tail[i].close / tail[i - 1].close));
    if (r.length >= 40) series.push(r);
  }
  const N = series.length;
  if (N < 2) return { rhoBar: 0, nEff: Math.max(1, N) };
  const corr = (a: number[], b: number[]): number => {
    const n = Math.min(a.length, b.length);
    const aa = a.slice(a.length - n), bb = b.slice(b.length - n);
    const ma = aa.reduce((s, v) => s + v, 0) / n, mb = bb.reduce((s, v) => s + v, 0) / n;
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i++) { const da = aa[i] - ma, db = bb[i] - mb; cov += da * db; va += da * da; vb += db * db; }
    const d = Math.sqrt(va * vb);
    return d > 0 ? cov / d : 0;
  };
  let sum = 0, cnt = 0;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { sum += corr(series[i], series[j]); cnt++; }
  const rhoBar = cnt ? Math.max(0, sum / cnt) : 0;
  const nEff = N / (1 + (N - 1) * rhoBar);
  return { rhoBar, nEff };
}

interface Props {
  tickers: string[];
  pricesByTicker: Record<string, PricePoint[]>;
  names?: Record<string, string>;
  onRename?: (ticker: string, name: string) => void;
}

const L_PRESETS = [5, 10, 20];
const H_PRESETS = [5, 10, 20];
const K_PRESETS = [10, 20, 30];

type SortKey = "median" | "mfe" | "mae" | "win" | "n" | "ticker" | "name";
const SORTS: { key: SortKey; label: string; hint: string }[] = [
  { key: "median", label: "先行き中央値", hint: "H日後の終値中央値が大きい順。" },
  { key: "mfe", label: "高値到達", hint: "高値到達の中央値(MFE)が大きい順＝利確余地の大きい銘柄が上に。" },
  { key: "mae", label: "安値到達(浅い順)", hint: "安値到達の中央値(MAE)が浅い順＝下振れの小さい銘柄が上に(0に近いほど上)。" },
  { key: "win", label: "勝率", hint: "上昇した事例の割合が高い順。" },
  { key: "n", label: "事例数", hint: "集めた過去局面が多い順(標本が厚い銘柄を上に)。" },
  { key: "ticker", label: "銘柄コード", hint: "ティッカーの昇順。" },
  { key: "name", label: "名称", hint: "銘柄名の五十音/アルファベット順。" },
];

interface Row {
  ticker: string;
  res: WeeklyAnalogResult | null;
}

function fmtPct(v: number, d = 1): string {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
}

// C1: 実効n・ベースライン差p・novelty棄却から緑/黄/赤の信頼度。
function confLevel(r: WeeklyAnalogResult): { level: "green" | "amber" | "red"; title: string } {
  const okN = r.nEff >= 15, okP = r.diffP < 0.05, okNov = !r.rejected;
  const pass = [okN, okP, okNov].filter(Boolean).length;
  const title = `実効n=${r.nEff}${okN ? "" : "(薄)"} / 差p=${r.diffP < 0.001 ? "<.001" : r.diffP.toFixed(3)} / novelty ${(r.novelty * 100).toFixed(0)}%`;
  if (pass === 3) return { level: "green", title };
  if (pass >= 1 && okNov) return { level: "amber", title };
  return { level: "red", title };
}
const CONF_COLOR: Record<string, string> = { green: "#16a34a", amber: "#f59e0b", red: "#dc2626" };

// 先行きミニSVG。青=終値中央値/薄青帯=終値25-75%/緑点線=高値到達中央(MFE)/赤点線=安値到達中央(MAE)。
// 縦は全銘柄共通スケールで比較可能。
function ForwardSpark({ res, scale }: { res: WeeklyAnalogResult; scale: number }) {
  const { fwdMedian, fwdP25, fwdP75, fwdHighMedian, fwdLowMedian, H } = res;
  const W = 96, HT = 34, padX = 3, padY = 4;
  if (H < 1 || scale <= 0) return <span className="text-gray-300">—</span>;
  const x = (m: number) => padX + (m / H) * (W - 2 * padX);
  const clamp = (v: number) => Math.max(-scale, Math.min(scale, v));
  const y = (v: number) => HT / 2 - (clamp(v) / scale) * (HT / 2 - padY);
  const path = (arr: number[]) => arr.map((v, m) => `${m === 0 ? "M" : "L"}${x(m).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const up = fwdP75.map((v, m) => `${x(m).toFixed(1)},${y(v).toFixed(1)}`);
  const lo = fwdP25.map((v, m) => `${x(m).toFixed(1)},${y(v).toFixed(1)}`).reverse();
  const area = `M${up.join(" L")} L${lo.join(" L")} Z`;
  const stroke = fwdMedian[H] >= 0 ? "#2563eb" : "#2563eb";
  return (
    <svg width={W} height={HT} className="inline-block align-middle" style={{ overflow: "visible" }}>
      <line x1={padX} y1={HT / 2} x2={W - padX} y2={HT / 2} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="2 2" />
      <path d={area} fill="rgba(37,99,235,0.12)" />
      <path d={path(fwdHighMedian)} fill="none" stroke="#16a34a" strokeWidth={1} strokeDasharray="2 1.5" opacity={0.8} />
      <path d={path(fwdLowMedian)} fill="none" stroke="#dc2626" strokeWidth={1} strokeDasharray="2 1.5" opacity={0.8} />
      <path d={path(fwdMedian)} fill="none" stroke={stroke} strokeWidth={1.7} />
    </svg>
  );
}

const LS_KEY = "weeklyAnalogCross.settings.v1";

export default function WeeklyAnalogCrossChart({ tickers, pricesByTicker, names, onRename }: Props) {
  const [usTicker, setUsTicker] = useState("^IXIC");
  const [usMode, setUsMode] = useState<UsMode>("ret");
  const [scheme, setScheme] = useState<BinScheme>("tercile");
  const [mode, setMode] = useState<AnalogMode>("usbin");
  const [L, setL] = useState(5);
  const [H, setH] = useState(5);
  const [K, setK] = useState(20);
  const [metric, setMetric] = useState<DistMetric>("euclid");
  const [align, setAlign] = useState<WindowAlign>("trailing");
  const [weight, setWeight] = useState<WeightMode>("uniform");
  const [volNorm, setVolNorm] = useState(false);
  const [dtwBandFrac, setDtwBandFrac] = useState(0.25);
  const [hlWeight, setHlWeight] = useState(0);
  const [pool, setPool] = useState(false);
  const [selBinOverride, setSelBinOverride] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("median");
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [nameCol, setNameCol] = useNameColMode();

  // C4: 設定の localStorage 永続化
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.mode) setMode(s.mode); if (s.metric) setMetric(s.metric); if (s.align) setAlign(s.align);
      if (s.weight) setWeight(s.weight); if (typeof s.volNorm === "boolean") setVolNorm(s.volNorm);
      if (typeof s.dtwBandFrac === "number") setDtwBandFrac(s.dtwBandFrac);
      if (typeof s.hlWeight === "number") setHlWeight(s.hlWeight);
      if (typeof s.pool === "boolean") setPool(s.pool);
      if (s.L) setL(s.L); if (s.H) setH(s.H); if (s.K) setK(s.K);
      if (s.usMode) setUsMode(s.usMode); if (s.scheme) setScheme(s.scheme);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ mode, metric, align, weight, volNorm, dtwBandFrac, hlWeight, pool, L, H, K, usMode, scheme })); } catch { /* ignore */ }
  }, [mode, metric, align, weight, volNorm, dtwBandFrac, hlWeight, pool, L, H, K, usMode, scheme]);

  const { prices: usPrices, loading: usLoading, error: usError } = useUsDaily(usTicker);
  const us = useMemo(() => (usPrices ? computeUsReturns(usPrices) : []), [usPrices]);

  const uniq = useMemo(() => Array.from(new Set(tickers.filter((t) => t && t.trim()))), [tickers]);
  const resetBin = () => setSelBinOverride(null);

  // C3: 全銘柄×設定の計算を Web Worker に逃がす(L=20/DTW/横断でメインスレッドが固まるのを防ぐ)
  const { run } = useAnalogWorker();
  const [rows, setRows] = useState<Row[]>([]);
  const [computing, setComputing] = useState(false);
  const runIdRef = useRef(0);
  useEffect(() => {
    if (us.length === 0 || uniq.length < 1) { setRows([]); return; }
    const myId = ++runIdRef.current;
    setComputing(true);
    run({
      kind: "cross", tickers: uniq, pricesByTicker, us, pool,
      params: { L, H, K, mode, usMode, scheme, selBinOverride, metric, align, weight, volNorm, dtwBandFrac, hlWeight },
    }).then((resp) => {
      if (myId !== runIdRef.current) return;
      setRows((resp.rows as Row[]) ?? []);
      setComputing(false);
    });
  }, [run, uniq, pricesByTicker, us, L, H, K, mode, usMode, scheme, selBinOverride, metric, align, weight, volNorm, dtwBandFrac, hlWeight, pool]);

  const withRes = rows.filter((r) => r.res);
  const meta = withRes[0]?.res?.binMetaObj ?? null;
  const queryBin = withRes[0]?.res?.queryUsBin ?? null;
  const selBin = withRes[0]?.res?.selBin ?? 0;
  const effL = withRes[0]?.res?.L ?? L; // align="week" ではコアが今週の経過日数に決める

  // 共通縦スケール(全銘柄のフォワード帯から)
  const scale = useMemo(() => {
    let mx = 0.005;
    for (const r of withRes) {
      const res = r.res!;
      for (let m = 0; m <= res.H; m++) {
        mx = Math.max(mx, Math.abs(res.fwdP25[m]), Math.abs(res.fwdP75[m]), Math.abs(res.fwdHighMedian[m]), Math.abs(res.fwdLowMedian[m]));
      }
    }
    return mx;
  }, [withRes]);

  const sortedRows = useMemo(() => {
    const nm = (t: string) => names?.[t] || t;
    const arr = [...rows];
    const val = (r: Row) => {
      if (!r.res) return -Infinity;
      if (sortKey === "median") return r.res.medianFinal;
      if (sortKey === "mfe") return r.res.medianMfe; // 大きいほど利確余地
      if (sortKey === "mae") return r.res.medianMae; // 0に近い(浅い)ほど上 = 降順でよい
      if (sortKey === "win") return r.res.upCount / (r.res.upCount + r.res.downCount || 1);
      if (sortKey === "n") return r.res.selected.length;
      return 0;
    };
    if (sortKey === "ticker") arr.sort((a, b) => a.ticker.localeCompare(b.ticker));
    else if (sortKey === "name") arr.sort((a, b) => nm(a.ticker).localeCompare(nm(b.ticker), "ja"));
    else arr.sort((a, b) => val(b) - val(a));
    return arr;
  }, [rows, sortKey, names]);

  // 横断コンセンサス(A4: 相関調整)
  const bull = withRes.filter((r) => r.res!.medianFinal > 0).length;
  const { rhoBar, nEff: nEffTickers } = useMemo(
    () => effectiveTickers(rows.filter((r) => r.res).map((r) => r.ticker), pricesByTicker),
    [rows, pricesByTicker]
  );

  if (uniq.length < 2) {
    return <div className="text-sm text-gray-500">横断比較にはウォッチリストに2銘柄以上が必要です。</div>;
  }

  const NumBtn = ({ v, cur, set }: { v: number; cur: number; set: (n: number) => void }) => (
    <button onClick={() => set(v)} className={`px-2 py-0.5 rounded text-[11px] ${cur === v ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-600"}`}>{v}</button>
  );

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        全銘柄の今週({align === "week" ? `週境界・月〜今日の${effL}営業日` : `直近${effL}営業日`})の経路を、
        <span className="font-medium text-gray-700">{mode === "usbin" ? "今週の入口(前夜米国ビン)" : "各銘柄の似た形"}</span>
        で過去局面と突き合わせ、来週{H}日の先読みを横並び比較。
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="inline-flex rounded overflow-hidden border border-gray-200 text-xs">
          {([["usbin", "前夜米国ビンで絞る"], ["similar", "似た形で絞る(アナログ)"], ["ensemble", "両立(米国ビン∩似た形)"]] as [AnalogMode, string][]).map(([m, lbl]) => (
            <button key={m} onClick={() => { setMode(m); resetBin(); }}
              className={`px-3 py-1 font-medium ${mode === m ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-100"}`}>{lbl}</button>
          ))}
        </div>
        {computing && <span className="text-xs text-gray-400">計算中…（Web Worker）</span>}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-600">
        <div className="flex items-center gap-1">
          <span>窓の取り方:</span>
          {([["trailing", "直近L営業日"], ["week", "今週(週境界)"]] as [WindowAlign, string][]).map(([a, lbl]) => (
            <button key={a} onClick={() => { setAlign(a); resetBin(); }}
              title={a === "week"
                ? "月曜起点で今日までを窓にし、過去も『各週の先頭同数日』と比較。曜日位置が揃い、窓起点=週初め(前夜米国ビンの基準)が厳密に一致する。候補は週数まで減る。"
                : "直近L営業日を窓にする(週をまたぐ)。候補数が多く安定するが、曜日位置は揃わない。"}
              className={`px-2 py-0.5 rounded ${align === a ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-600"}`}>{lbl}</button>
          ))}
        </div>
        {align === "trailing" ? (
          <div className="flex items-center gap-1"><span>今週の窓 L:</span>{L_PRESETS.map((v) => <NumBtn key={v} v={v} cur={L} set={setL} />)}</div>
        ) : (
          <span className="text-gray-500">今週= <span className="font-medium text-gray-700">{effL}営業日</span>（月〜今日）</span>
        )}
        <div className="flex items-center gap-1"><span>先行き H:</span>{H_PRESETS.map((v) => <NumBtn key={v} v={v} cur={H} set={setH} />)}</div>
        {(mode === "similar" || mode === "ensemble") && <div className="flex items-center gap-1"><span>近傍 K:</span>{K_PRESETS.map((v) => <NumBtn key={v} v={v} cur={K} set={setK} />)}</div>}
        <div className="flex items-center gap-1">
          <span>形の距離:</span>
          {([["euclid", "ユークリッド"], ["dtw", "DTW"]] as [DistMetric, string][]).map(([m, lbl]) => (
            <button key={m} onClick={() => setMetric(m)}
              title={m === "dtw"
                ? "動的時間伸縮。山や谷が1日早い/遅いといった時間のズレを吸収して形を突き合わせる(Sakoe-Chibaバンドは下のスライダで可変)。"
                : "等速比較。同じ日付位置どうしを突き合わせる。時間のズレに弱い。"}
              className={`px-2 py-0.5 rounded ${metric === m ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-600"}`}>{lbl}</button>
          ))}
        </div>
      </div>

      {/* 手法の質: 重み・σ正規化・DTWバンド・HL距離・横断プール */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-600">
        <div className="flex items-center gap-1">
          <span>重み:</span>
          {([["uniform", "等重み"], ["kernel", "カーネル"]] as [WeightMode, string][]).map(([m, lbl]) => (
            <button key={m} onClick={() => setWeight(m)}
              title={m === "kernel" ? "Nadaraya-Watson。距離が近い局面ほど重く(B1)。" : "全事例を1票ずつ等しく扱う。"}
              className={`px-2 py-0.5 rounded ${weight === m ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-600"}`}>{lbl}</button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1 cursor-pointer" title="フォワードをσ単位で集計し各銘柄の今週σで復元(B2)。">
          <input type="checkbox" checked={volNorm} onChange={(e) => setVolNorm(e.target.checked)} className="accent-blue-600" />σ正規化
        </label>
        {metric === "dtw" && (
          <label className="inline-flex items-center gap-1" title="Sakoe-Chibaバンド幅(窓長比)。L/2以上は退化に近づく(B3)。">
            <span>DTWバンド {Math.round(dtwBandFrac * 100)}%</span>
            <input type="range" min={0} max={50} step={5} value={Math.round(dtwBandFrac * 100)}
              onChange={(e) => setDtwBandFrac(Number(e.target.value) / 100)} className="accent-blue-600 w-20" />
          </label>
        )}
        <label className="inline-flex items-center gap-1" title="距離に日中レンジ形状チャネルを加える重み γ(B6)。">
          <span>HL距離 γ={hlWeight.toFixed(1)}</span>
          <input type="range" min={0} max={10} step={1} value={Math.round(hlWeight * 10)}
            onChange={(e) => setHlWeight(Number(e.target.value) / 10)} className="accent-blue-600 w-20" />
        </label>
        <label className="inline-flex items-center gap-1 cursor-pointer" title="他銘柄の過去週もアナログ候補に含めて事例数を増やす(B5, σ正規化を自動適用)。同一週の複数銘柄は1クラスタとして相関を吸収。">
          <input type="checkbox" checked={pool} onChange={(e) => setPool(e.target.checked)} className="accent-blue-600" />横断プール(B5)
        </label>
      </div>

      {mode !== "similar" && (
        <div className="space-y-2">
          <div className="flex items-center gap-4 flex-wrap">
            <UsDriverButtons value={usTicker} onChange={(t) => { setUsTicker(t); resetBin(); }} />
            <div className="flex items-center gap-1 flex-wrap text-xs">
              <span className="text-gray-500">ビン基準:</span>
              {([["ret", "前日終値比"], ["intra", "日中"]] as [UsMode, string][]).map(([m, lbl]) => (
                <button key={m} onClick={() => { setUsMode(m); resetBin(); }}
                  className={`px-2 py-0.5 rounded font-medium ${usMode === m ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{lbl}</button>
              ))}
            </div>
            <BinSchemeButtons value={scheme} onChange={(s) => { setScheme(s); resetBin(); }} />
          </div>

          {meta && (
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              <span className="text-gray-500">見るビン:</span>
              {meta.labels.map((label, b) => {
                const isSel = b === selBin;
                const isQuery = b === queryBin;
                return (
                  <button key={b} onClick={() => setSelBinOverride(b)}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded font-medium ${isSel ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: meta.colors[b] }} />
                    {label}
                    {isQuery && <span className={isSel ? "text-amber-300" : "text-blue-600"}>◀今週</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5 flex-wrap text-xs">
        <span className="text-gray-500">並び替え:</span>
        {SORTS.map((s) => (
          <button key={s.key} onClick={() => setSortKey(s.key)} title={s.hint}
            className={`px-2 py-0.5 rounded text-[11px] font-medium ${sortKey === s.key ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{s.label}</button>
        ))}
        {onRename && <span className="text-[10px] text-gray-400">｜✎ で名称編集(ウォッチリストに保存)</span>}
      </div>

      {usLoading && <div className="text-xs text-gray-400">米国指数を取得中…</div>}
      {usError && <div className="text-xs text-red-500">{usError}</div>}

      {meta && withRes.length > 0 && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 space-y-0.5">
          <div>
            {mode === "usbin"
              ? <>今週の入口<span className="font-bold">「{meta.labels[selBin]}」</span>の翌週見通し：</>
              : mode === "ensemble"
              ? <>「{meta.labels[selBin]}」×似た形の翌週見通し：</>
              : <>各銘柄の似た形の翌週見通し：</>}
            <span className="font-bold"> {withRes.length}銘柄中 {bull}銘柄が上向き</span>
            <span className="text-blue-700">（{bull > withRes.length / 2 ? "横断的にやや強気" : bull < withRes.length / 2 ? "横断的にやや弱気" : "拮抗"}）</span>
          </div>
          <div className="text-[11px] text-blue-700">
            A4 相関調整: 銘柄間フォワード相関 ρ̄≈{rhoBar.toFixed(2)} →
            <span className="font-bold"> 実効 {nEffTickers.toFixed(1)}銘柄相当</span>
            {nEffTickers < withRes.length * 0.4
              ? <>（{withRes.length}票ではなく<span className="font-medium">ほぼ地合い{Math.round(nEffTickers)}票</span>——全銘柄同方向は分散不足の裏返し）</>
              : <>（銘柄間の独立性はそこそこ保たれている）</>}
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="text-[11px] w-full border-collapse">
          <thead>
            <tr className="text-gray-500">
              <th className="text-left font-medium px-2 py-1 sticky left-0 bg-white z-10" style={nameColStyle(nameCol)}>
                <NameColHeader mode={nameCol} onChange={setNameCol} />
              </th>
              {mode === "usbin" && <th className="font-medium px-1 py-1 text-center">今週の起点</th>}
              <th className="font-medium px-1 py-1 text-center">その後{H}日(終値/高安到達)</th>
              <th className="font-medium px-2 py-1 text-right">終値中央</th>
              <th className="font-medium px-2 py-1 text-right" title="無条件ベースラインとの中央値差(pt)と順列検定p値(A1)">差(vs無条件)</th>
              <th className="font-medium px-2 py-1 text-right">高値中</th>
              <th className="font-medium px-2 py-1 text-right">安値中</th>
              <th className="font-medium px-2 py-1 text-right">勝率</th>
              <th className="font-medium px-2 py-1 text-right" title="事例数（実効n＝重複窓を畳んだ独立数, A2）">事例/実効</th>
              <th className="font-medium px-1 py-1 text-center" title="実効n・ベースライン差p・noveltyから緑=採用可/黄=参考/赤=使うな(C1)">信頼</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r) => {
              const res = r.res;
              const hasName = !!names?.[r.ticker] && names[r.ticker] !== r.ticker;
              return (
                <tr key={r.ticker} className="border-t border-gray-100">
                  <td className="px-2 py-1 sticky left-0 bg-white z-10" style={nameColStyle(nameCol)}>
                    {nameCol === "code" ? (
                      <div className="font-mono font-medium text-gray-700 truncate"
                        style={{ maxWidth: NAME_COL_W.code - 16 }}
                        title={hasName ? `${names[r.ticker]}（${r.ticker}）` : r.ticker}>
                        {r.ticker}
                      </div>
                    ) : editing === r.ticker ? (
                      <div className="flex items-center gap-1">
                        <input autoFocus value={editVal} onChange={(e) => setEditVal(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { const t = editVal.trim(); if (t) onRename?.(r.ticker, t); setEditing(null); }
                            if (e.key === "Escape") setEditing(null);
                          }}
                          className="w-[110px] px-1 py-0.5 text-[11px] border border-gray-300 rounded" placeholder={r.ticker} />
                        <button onClick={() => { const t = editVal.trim(); if (t) onRename?.(r.ticker, t); setEditing(null); }} className="text-emerald-600 text-sm leading-none">✓</button>
                        <button onClick={() => setEditing(null)} className="text-gray-400 text-sm leading-none">✕</button>
                      </div>
                    ) : (
                      <div style={{ maxWidth: NAME_COL_W.name - 16 }}>
                        <div className="flex items-center gap-1">
                          <span className="font-medium text-gray-700 truncate" title={hasName ? `${names[r.ticker]}（${r.ticker}）` : r.ticker}>
                            {hasName ? names[r.ticker] : r.ticker}
                          </span>
                          {onRename && (
                            <button onClick={() => { setEditVal(hasName ? names[r.ticker] : ""); setEditing(r.ticker); }}
                              title="銘柄名を編集(ウォッチリストに保存)" className="text-gray-300 hover:text-blue-500 text-[11px] leading-none flex-shrink-0">✎</button>
                          )}
                        </div>
                        {hasName && <div className="text-[9px] text-gray-400 font-mono">{r.ticker}</div>}
                      </div>
                    )}
                  </td>
                  {mode === "usbin" && (
                    <td className="px-1 py-1 text-center">
                      {res && res.queryUsBin !== null && meta
                        ? <span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: meta.colors[res.queryUsBin] }} />{meta.labels[res.queryUsBin]}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                  )}
                  <td className="px-1 py-0.5 text-center align-middle">
                    {res ? <ForwardSpark res={res} scale={scale} /> : <span className="text-gray-300">—</span>}
                  </td>
                  <td className={`px-2 py-1 text-right font-semibold tabular-nums ${res ? (res.medianFinal >= 0 ? "text-green-600" : "text-red-600") : "text-gray-300"}`}>
                    {res ? fmtPct(res.medianFinal) : "—"}
                  </td>
                  <td className={`px-2 py-1 text-right tabular-nums ${res ? (res.diffP < 0.05 ? "text-gray-700 font-medium" : "text-gray-400") : "text-gray-300"}`}
                    title={res ? `p=${res.diffP < 0.001 ? "<.001" : res.diffP.toFixed(3)}` : ""}>
                    {res ? `${res.diffMedian >= 0 ? "+" : ""}${(res.diffMedian * 100).toFixed(1)}pt${res.diffP < 0.05 ? "*" : ""}` : "—"}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-green-600">
                    {res ? fmtPct(res.medianMfe) : "—"}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-red-600">
                    {res ? fmtPct(res.medianMae) : "—"}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                    {res ? `${((res.upCount / (res.upCount + res.downCount || 1)) * 100).toFixed(0)}%` : "—"}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-400">
                    {res ? <>{res.selected.length}<span className="text-gray-300">/</span><span className="text-gray-600">{res.nEff}</span></> : "—"}
                  </td>
                  <td className="px-1 py-1 text-center">
                    {res ? (() => { const c = confLevel(res); return <span title={c.title} className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: CONF_COLOR[c.level] }} />; })() : <span className="text-gray-300">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-gray-400">
        ミニチャート: <span className="text-blue-600">青=終値中央</span> / <span className="text-green-600">緑点線=高値到達中央(MFE=利確目安)</span> / <span className="text-red-600">赤点線=安値到達中央(MAE=損切り目安)</span> / 薄青帯=終値25–75%。
        中央値が揃って右肩上がり＝全体に追い風(地合い集中=分散不足の裏返し)。1銘柄だけ逆行＝個別要因/ヘッジ候補。事例小は偶然に振られやすい。
      </p>

      <AnalysisGuide title="今週の軌跡アナログ 横断比較の詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"個別版の『今週の軌跡アナログ比較』をウォッチリスト全銘柄に一斉適用し、来週H日の先読みを横並びにする。前夜米国ビンは市場共通なので、選んだ入口ビン(例: 米大幅高で始まった週)に対して各銘柄がその後どう動きやすいかを一望できる。単一銘柄では『固有の癖』か『地合い共通』か分からないが、横断で並べると中央値パスが銘柄をまたいで揃うか(共通)、1銘柄だけ突出/逆行するか(固有)が一目で分かる。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 各列の意味</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>今週の起点</strong>: その銘柄の今週(週初め)の前夜米国ビン。市場共通なので通常は全銘柄同じ(整合の差で稀にズレる)。</li>
          <li><strong>その後H日(終値/高安到達)</strong>: 過去局面の翌H日を、終値中央値(青)＋終値25–75%帯に加え、<span className="text-green-700">高値到達の中央値(緑点線=MFE)</span>と<span className="text-red-700">安値到達の中央値(赤点線=MAE)</span>を重ねたミニチャート。終値だけでなく日中高安(HL)も使い「どこまで上げ/下げやすいか」を示す。縦は全銘柄共通スケールで大小比較可。</li>
          <li><strong>終値中央/高値中/安値中/勝率/事例</strong>: H日後の終値中央値、高値到達中央(利確目安)、安値到達中央(損切り目安)、上昇割合、過去局面数。事例が薄いほど不安定。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">2b. 窓の取り方・形の距離・並べ替え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>窓の取り方</strong>: 「直近L営業日」は週をまたぐ単純窓で事例数が多く安定。「今週(週境界)」は月曜起点で今日まで(L=今週の経過日数)を窓にし、過去も各週の先頭L日と比較——曜日位置が揃い、窓起点=週初め＝前夜米国ビンの基準日が厳密に一致する。ただし候補は週数まで減る(≒1/5)。</li>
          <li><strong>形の距離</strong>: ユークリッドは等速比較(時間のズレに弱い)、DTW(動的時間伸縮)は山谷が1日早い/遅いズレを吸収して形を突き合わせる。両方で残る銘柄は確度が高い。</li>
          <li><strong>並べ替え</strong>: 先行き中央値のほか<strong>高値到達</strong>(MFE降順＝利確余地の大きい順)、<strong>安値到達(浅い順)</strong>(MAEが0に近い順＝下振れの小さい順)でも並べられる。「上値が取れる銘柄」と「傷が浅い銘柄」を別々に探せる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">2c. 統計的妥当性と手法の質(新)</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>差(vs無条件)・信頼(A1/C1)</strong>: 各行に無条件ベースラインとの中央値差(pt)と順列検定 p 値(*=p&lt;0.05)、および実効n・差p・noveltyを束ねた<span style={{ color: CONF_COLOR.green }}>緑</span>/<span style={{ color: CONF_COLOR.amber }}>黄</span>/<span style={{ color: CONF_COLOR.red }}>赤</span>の信頼ドット。中央値が高くても差が有意でない銘柄は「絞った意味がない」。</li>
          <li><strong>事例/実効(A2)</strong>: フォワードが重なる窓を畳んだ<strong>実効n</strong>を併記。「事例300・実効60」なら独立情報は60。CI・p値もこのクラスタ単位で算出。</li>
          <li><strong>横断コンセンサスの相関調整(A4)</strong>: 「8/10銘柄が上向き」は8つの独立証拠ではない。同一市場の銘柄は相関 ρ̄≈0.5〜0.8。実効銘柄数 N_eff=N/(1+(N−1)ρ̄) を直近リターンの平均相関から概算し、「実効◯銘柄相当」を表示。全銘柄同方向＝<strong>分散が効いていない</strong>という正しい読みに誘導する。</li>
          <li><strong>重み・σ正規化・DTWバンド・HL距離(B1/B2/B3/B6)</strong>: 個別版と同じ。カーネル重みで遠い近傍を希釈、σ正規化で値幅を各銘柄のボラ環境に整合、DTWバンドで時間ズレ許容を調整、HL距離で荒れ方の違いを区別。</li>
          <li><strong>横断プール(B5)</strong>: 自己履歴だけでは薄い(週境界×ビンで各≈100週)。他銘柄の過去週も候補に含めて事例を数倍に。リターンはσ正規化してから距離・集計、同一週の複数銘柄は1クラスタとして横断相関を吸収。「銘柄が似た反応をする」前提が必要。</li>
          <li><strong>Web Worker(C3)</strong>: 全銘柄×DTW×設定変更の計算はメインスレッドを固めるため別スレッドで実行(「計算中…」表示)。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>今夜の米国が確定すれば来週の入口ビンが分かる。そのビン列で中央値・勝率が高い銘柄を来週の順張り候補に。</li>
          <li>高値到達で並べれば「利確余地の大きい銘柄」、安値到達(浅い順)で並べれば「下振れの小さい銘柄」。中央値が同じでも値幅の質は違う。</li>
          <li>横断コンセンサス(上向き銘柄数)でブック全体の傾きを把握。全銘柄同方向＝地合いに集中(分散不足)、逆行銘柄はヘッジ候補。</li>
          <li>『似た形』モードは各銘柄固有のパターン先読み。ビンモードは地合い起点の先読み。両方で一貫する銘柄は確度が高い。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>「形・地合いが似ている」だけで因果はない。事例数が少ない行は偶然に振られやすい。</li>
          <li>レジームが違えば同じ入口でも結果は変わる。窓L・先行きH・ビン粗さを変え頑健性を確認。</li>
          <li>多銘柄×多設定で見かけの好機が出やすい。横断的一貫性と事例数を重視する。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
