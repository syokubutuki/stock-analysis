"use client";

// 今週の値動きの軌跡アナログ比較(日足)。
// 今週(直近L営業日)の経路を、①似た形の過去局面(similar) か ②前夜米国ビンで絞った過去局面(usbin)
// と突き合わせ、「今日(t=0)に至る経路(リードイン)」と「その後H日(フォワード)」を1枚で見る。
// すべて窓末=今日=0%に再基準化するため、t=0で全系列が収束し、左=形の比較 / 右=先読み分布 になる。

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { computeUsReturns, BinScheme } from "../../lib/us-spillover-core";
import { useUsDaily } from "../../hooks/useUsDaily";
import { useIntraday, IntradayResponse } from "../../hooks/useIntraday";
import { groupByDay } from "../../lib/intraday-core";
import {
  computeWeeklyAnalog, WeeklyAnalogResult, AnalogMode, UsMode, DistMetric, WindowAlign, WeightMode,
} from "../../lib/weekly-analog";
import { UsDriverButtons, BinSchemeButtons } from "./usSpilloverShared";
import AnalysisGuide from "./AnalysisGuide";

// C1: 信頼度バッジ。実効n・ベースライン差p・novelty棄却の3条件から緑/黄/赤。
function confidence(r: WeeklyAnalogResult): { level: "green" | "amber" | "red"; label: string; reasons: string[] } {
  const okN = r.nEff >= 15;
  const okP = r.diffP < 0.05;
  const okNov = !r.rejected;
  const pass = [okN, okP, okNov].filter(Boolean).length;
  const reasons = [
    `${okN ? "✓" : "✕"} 実効n=${r.nEff}${okN ? "" : "(薄い)"}`,
    `${okP ? "✓" : "✕"} ベースライン差 p=${r.diffP < 0.001 ? "<.001" : r.diffP.toFixed(3)}`,
    `${okNov ? "✓" : "✕"} 前例あり(novelty ${(r.novelty * 100).toFixed(0)}%)`,
  ];
  if (pass === 3) return { level: "green", label: "採用可", reasons };
  if (pass >= 1 && okNov) return { level: "amber", label: "参考", reasons };
  return { level: "red", label: "使うな", reasons };
}

interface Props {
  prices: PricePoint[];
  ticker?: string; // 指定時のみ「今週を日中足で表示」ドリルダウンを有効化
}

// 今週(直近L営業日)の日中足パス。今日の最終値=0% に再基準化した連続系列 + 日境界。
interface IntraWeek {
  cum: number[];
  dayStart: number[];
  labels: string[];
}
function buildIntraWeek(resp: IntradayResponse, L: number): IntraWeek | null {
  const days = groupByDay(resp.bars, resp.gmtoffset);
  if (days.length === 0) return null;
  const use = days.slice(-L);
  const cum: number[] = [];
  const dayStart: number[] = [];
  const labels: string[] = [];
  let idx = 0;
  const flat: { close: number }[] = [];
  for (const d of use) {
    dayStart.push(idx);
    labels.push(d.date.slice(5));
    for (const b of d.bars) { flat.push(b); idx++; }
  }
  if (flat.length < 3) return null;
  const lastC = flat[flat.length - 1].close;
  if (!(lastC > 0)) return null;
  for (const b of flat) cum.push(b.close / lastC - 1);
  return { cum, dayStart, labels };
}

function drawIntraWeek(ctx: CanvasRenderingContext2D, width: number, height: number, d: IntraWeek) {
  const ml = 44, mr = 14, mt = 16, mb = 16;
  const plotW = width - ml - mr, plotH = height - mt - mb;
  const N = d.cum.length;
  if (N < 2) return;
  const maxV = Math.max(0.004, ...d.cum.map((v) => Math.abs(v)));
  const xOf = (i: number) => ml + (i / (N - 1)) * plotW;
  const yOf = (v: number) => mt + plotH / 2 - (v / maxV) * (plotH / 2 - 4);

  ctx.fillStyle = "#374151"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("今週の日中足の軌跡（60分足・今日の最終値=0%）", ml, 11);
  // ゼロ線
  ctx.strokeStyle = "#e5e7eb"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(ml, yOf(0)); ctx.lineTo(ml + plotW, yOf(0)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(`+${(maxV * 100).toFixed(1)}%`, ml - 4, mt + 8);
  ctx.fillText("0%", ml - 4, yOf(0) + 3);
  ctx.fillText(`-${(maxV * 100).toFixed(1)}%`, ml - 4, mt + plotH);
  // 日境界 + 日付
  ctx.textAlign = "center";
  d.dayStart.forEach((s, k) => {
    const x = xOf(s);
    ctx.strokeStyle = "#e5e7eb"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, mt); ctx.lineTo(x, mt + plotH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif";
    ctx.fillText(d.labels[k], x + 2, mt + plotH + 12);
  });
  // パス
  ctx.strokeStyle = "#0f172a"; ctx.lineWidth = 1.6;
  ctx.beginPath();
  d.cum.forEach((v, i) => ctx[i === 0 ? "moveTo" : "lineTo"](xOf(i), yOf(v)));
  ctx.stroke();
  ctx.fillStyle = "#0f172a";
  ctx.beginPath(); ctx.arc(xOf(N - 1), yOf(0), 3, 0, Math.PI * 2); ctx.fill();
}

const L_PRESETS = [5, 10, 20];
const H_PRESETS = [5, 10, 20];
const K_PRESETS = [10, 20, 30];

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

function fmtPct(v: number, d = 1): string {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
}

function draw(ctx: CanvasRenderingContext2D, width: number, height: number, r: WeeklyAnalogResult, highlight: number | null) {
  const { L, H } = r;
  const ml = 46, mr = 16, mt = 22, mb = 24;
  const plotW = width - ml - mr, plotH = height - mt - mb;
  const tMin = -(L - 1), tMax = H, tSpan = tMax - tMin || 1;
  const xOf = (t: number) => ml + ((t - tMin) / tSpan) * plotW;

  // y範囲: 全系列(クエリ・選抜アナログ・帯・高安到達)から
  const all: number[] = [
    ...r.query.lead, ...r.query.leadHigh, ...r.query.leadLow,
    ...r.leadP25, ...r.leadP75, ...r.fwdP25, ...r.fwdP75,
    ...r.fwdHighMedian, ...r.fwdLowMedian, ...r.baselineFwdMedian,
  ];
  for (const s of r.selected) { all.push(...s.lead, ...s.forward); }
  const maxV = Math.max(0.01, ...all.map((v) => Math.abs(v)));
  const yOf = (v: number) => mt + plotH / 2 - (v / maxV) * (plotH / 2 - 4);

  // ゼロ線
  ctx.strokeStyle = "#e5e7eb"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(ml, yOf(0)); ctx.lineTo(ml + plotW, yOf(0)); ctx.stroke();
  ctx.setLineDash([]);
  // y目盛
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(`+${(maxV * 100).toFixed(0)}%`, ml - 4, mt + 8);
  ctx.fillText("0%", ml - 4, yOf(0) + 3);
  ctx.fillText(`-${(maxV * 100).toFixed(0)}%`, ml - 4, mt + plotH);

  // t=0(今日)の縦線
  ctx.strokeStyle = "#cbd5e1"; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(xOf(0), mt); ctx.lineTo(xOf(0), mt + plotH); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#64748b"; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("今", xOf(0), mt - 6);
  ctx.fillStyle = "#94a3b8"; ctx.font = "9px sans-serif";
  ctx.fillText("← 今週の経路", xOf(tMin / 2), mt - 6);
  ctx.fillText("その後 →", xOf(H / 2), mt - 6);

  // フォワード 25-75 帯(t=0..H)
  ctx.fillStyle = "rgba(37,99,235,0.13)";
  ctx.beginPath();
  for (let m = 0; m <= H; m++) ctx[m === 0 ? "moveTo" : "lineTo"](xOf(m), yOf(r.fwdP75[m]));
  for (let m = H; m >= 0; m--) ctx.lineTo(xOf(m), yOf(r.fwdP25[m]));
  ctx.closePath(); ctx.fill();

  // リードイン 25-75 帯(t<0, 薄め)
  ctx.fillStyle = "rgba(100,116,139,0.10)";
  ctx.beginPath();
  for (let i = 0; i < L; i++) ctx[i === 0 ? "moveTo" : "lineTo"](xOf(tMin + i), yOf(r.leadP75[i]));
  for (let i = L - 1; i >= 0; i--) ctx.lineTo(xOf(tMin + i), yOf(r.leadP25[i]));
  ctx.closePath(); ctx.fill();

  // 各アナログ(最大40本, 連続: リードイン→フォワード)
  const shown = r.selected.slice(0, 40);
  let hl: typeof shown[number] | null = null;
  for (const s of shown) {
    if (highlight !== null && s.endIndex === highlight) { hl = s; continue; }
    ctx.strokeStyle = "rgba(148,163,184,0.4)"; ctx.lineWidth = 1;
    ctx.beginPath();
    s.lead.forEach((v, i) => ctx[i === 0 ? "moveTo" : "lineTo"](xOf(tMin + i), yOf(v)));
    s.forward.forEach((v, m) => ctx.lineTo(xOf(m), yOf(v)));
    ctx.stroke();
  }

  // ベースライン(全候補窓)の中央値パス: 灰色の細線(A1: 絞った意味の有無を目視)
  ctx.strokeStyle = "rgba(107,114,128,0.85)"; ctx.lineWidth = 1.3; ctx.setLineDash([2, 2]);
  ctx.beginPath();
  r.baselineFwdMedian.forEach((v, m) => ctx[m === 0 ? "moveTo" : "lineTo"](xOf(m), yOf(v)));
  ctx.stroke(); ctx.setLineDash([]);

  // アナログのリードイン中央値(点線・比較用)
  ctx.strokeStyle = "#64748b"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
  ctx.beginPath();
  r.leadMedian.forEach((v, i) => ctx[i === 0 ? "moveTo" : "lineTo"](xOf(tMin + i), yOf(v)));
  ctx.stroke(); ctx.setLineDash([]);

  // フォワード 高値/安値 到達(MFE/MAE)の中央値: 緑上・赤下 + 薄いレンジ・コーン
  ctx.fillStyle = "rgba(16,163,74,0.06)";
  ctx.beginPath();
  for (let m = 0; m <= H; m++) ctx[m === 0 ? "moveTo" : "lineTo"](xOf(m), yOf(r.fwdHighMedian[m]));
  for (let m = H; m >= 0; m--) ctx.lineTo(xOf(m), yOf(r.fwdLowMedian[m]));
  ctx.closePath(); ctx.fill();
  ctx.setLineDash([3, 2]); ctx.lineWidth = 1.4;
  ctx.strokeStyle = "#16a34a";
  ctx.beginPath();
  r.fwdHighMedian.forEach((v, m) => ctx[m === 0 ? "moveTo" : "lineTo"](xOf(m), yOf(v)));
  ctx.stroke();
  ctx.strokeStyle = "#dc2626";
  ctx.beginPath();
  r.fwdLowMedian.forEach((v, m) => ctx[m === 0 ? "moveTo" : "lineTo"](xOf(m), yOf(v)));
  ctx.stroke();
  ctx.setLineDash([]);

  // フォワード中央値(太・青)
  ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2.6;
  ctx.beginPath();
  r.fwdMedian.forEach((v, m) => ctx[m === 0 ? "moveTo" : "lineTo"](xOf(m), yOf(v)));
  ctx.stroke();

  // 今週(クエリ)の日中レンジ(高安の縦バー=ローソクのヒゲ)
  ctx.strokeStyle = "rgba(15,23,42,0.35)"; ctx.lineWidth = 1;
  for (let i = 0; i < L; i++) {
    const xx = xOf(tMin + i);
    ctx.beginPath(); ctx.moveTo(xx, yOf(r.query.leadHigh[i])); ctx.lineTo(xx, yOf(r.query.leadLow[i])); ctx.stroke();
  }
  // 今週(クエリ)のリードイン終値(太・濃紺)
  ctx.strokeStyle = "#0f172a"; ctx.lineWidth = 2.8;
  ctx.beginPath();
  r.query.lead.forEach((v, i) => ctx[i === 0 ? "moveTo" : "lineTo"](xOf(tMin + i), yOf(v)));
  ctx.stroke();
  // 今日の点
  ctx.fillStyle = "#0f172a";
  ctx.beginPath(); ctx.arc(xOf(0), yOf(0), 3, 0, Math.PI * 2); ctx.fill();

  // 強調中のアナログ(C2/C6: 一覧クリックで該当事例を橙で前面に)
  if (hl) {
    ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 2.2;
    ctx.beginPath();
    hl.lead.forEach((v, i) => ctx[i === 0 ? "moveTo" : "lineTo"](xOf(tMin + i), yOf(v)));
    hl.forward.forEach((v, m) => ctx.lineTo(xOf(m), yOf(v)));
    ctx.stroke();
  }

  // x目盛
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  const step = Math.max(1, Math.round((tMax - tMin) / 6));
  for (let t = tMin; t <= tMax; t += step) ctx.fillText(t === 0 ? "0" : `${t > 0 ? "+" : ""}${t}d`, xOf(t), mt + plotH + 14);
}

const LS_KEY = "weeklyAnalog.settings.v1";

export default function WeeklyAnalogChart({ prices, ticker }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const intraCanvasRef = useRef<HTMLCanvasElement>(null);
  const [showIntraday, setShowIntraday] = useState(false);
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
  const [selBinOverride, setSelBinOverride] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null); // C2/C6: 強調するアナログの endIndex

  // C4: 設定の localStorage 永続化(銘柄非依存)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.mode) setMode(s.mode); if (s.metric) setMetric(s.metric); if (s.align) setAlign(s.align);
      if (s.weight) setWeight(s.weight); if (typeof s.volNorm === "boolean") setVolNorm(s.volNorm);
      if (typeof s.dtwBandFrac === "number") setDtwBandFrac(s.dtwBandFrac);
      if (typeof s.hlWeight === "number") setHlWeight(s.hlWeight);
      if (s.L) setL(s.L); if (s.H) setH(s.H); if (s.K) setK(s.K);
      if (s.usMode) setUsMode(s.usMode); if (s.scheme) setScheme(s.scheme);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ mode, metric, align, weight, volNorm, dtwBandFrac, hlWeight, L, H, K, usMode, scheme })); } catch { /* ignore */ }
  }, [mode, metric, align, weight, volNorm, dtwBandFrac, hlWeight, L, H, K, usMode, scheme]);

  const { prices: usPrices, loading: usLoading, error: usError } = useUsDaily(usTicker);
  const us = useMemo(() => (usPrices ? computeUsReturns(usPrices) : []), [usPrices]);

  const result = useMemo(() => {
    if (us.length === 0) return null;
    return computeWeeklyAnalog({ prices, us, L, H, K, mode, usMode, scheme, selBinOverride, metric, align, weight, volNorm, dtwBandFrac, hlWeight });
  }, [prices, us, L, H, K, mode, usMode, scheme, selBinOverride, metric, align, weight, volNorm, dtwBandFrac, hlWeight]);
  // align="week" では窓長はコア側が今週の経過日数に決める
  const effL = result?.L ?? L;

  useEffect(() => {
    if (!canvasRef.current || !result) return;
    const init = initCanvas(canvasRef.current, 280);
    if (init) draw(init.ctx, init.width, init.height, result, highlight);
  }, [result, highlight]);

  // 今週の日中足ドリルダウン(ticker 指定時のみ)
  const { resp: intraResp, loading: intraLoading, error: intraError } =
    useIntraday(showIntraday && ticker ? ticker : "", "60m");
  const intraWeek = useMemo(
    () => (showIntraday && intraResp ? buildIntraWeek(intraResp, effL) : null),
    [showIntraday, intraResp, effL]
  );
  useEffect(() => {
    if (!intraCanvasRef.current || !intraWeek) return;
    const init = initCanvas(intraCanvasRef.current, 150);
    if (init) drawIntraWeek(init.ctx, init.width, init.height, intraWeek);
  }, [intraWeek]);

  // US 切替でビン選択をリセット(今週の起点ビン既定に戻す)
  const resetBin = () => setSelBinOverride(null);

  if (prices.length < 120) {
    return <div className="text-sm text-gray-500">アナログ比較には約120営業日以上の履歴が必要です。</div>;
  }

  const Btn = ({ v, cur, set }: { v: number; cur: number; set: (n: number) => void }) => (
    <button onClick={() => set(v)} className={`px-2 py-0.5 rounded text-[11px] ${cur === v ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-600"}`}>{v}</button>
  );

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        今週({align === "week" ? `週境界・月〜今日の${effL}営業日` : `直近${effL}営業日`})の経路を、
        <span className="font-medium text-gray-700">似た形の過去局面</span>または
        <span className="font-medium text-gray-700">前夜米国ビンで絞った過去局面</span>と突き合わせ、
        今日(t=0)へ至る経路と<span className="font-medium text-gray-700">その後{H}日</span>の分布を重ねる。
      </p>

      {/* モード切替 */}
      <div className="inline-flex rounded overflow-hidden border border-gray-200 text-xs">
        {([["usbin", "前夜米国ビンで絞る"], ["similar", "似た形で絞る(アナログ)"], ["ensemble", "両立(米国ビン∩似た形)"]] as [AnalogMode, string][]).map(([m, lbl]) => (
          <button
            key={m}
            onClick={() => { setMode(m); resetBin(); }}
            title={m === "ensemble" ? "指定した前夜米国ビンに絞ったうえで、形の近い順に上位K局面(B4)。地合いと形の両立で確度を上げる。事例は減るので実効nに注意。" : undefined}
            className={`px-3 py-1 font-medium ${mode === m ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-100"}`}
          >{lbl}</button>
        ))}
      </div>

      {/* 共通パラメタ */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-600">
        <div className="flex items-center gap-1">
          <span>窓の取り方:</span>
          {([["trailing", "直近L営業日"], ["week", "今週(週境界)"]] as [WindowAlign, string][]).map(([a, lbl]) => (
            <button key={a} onClick={() => setAlign(a)}
              title={a === "week"
                ? "月曜起点で今日までを窓にし、過去も『各週の先頭同数日』と比較。曜日位置が揃い、窓起点=週初め(前夜米国ビンの基準)が厳密に一致する。候補は週数まで減る。"
                : "直近L営業日を窓にする(週をまたぐ)。候補数が多く安定するが、曜日位置は揃わない。"}
              className={`px-2 py-0.5 rounded ${align === a ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-600"}`}>{lbl}</button>
          ))}
        </div>
        {align === "trailing" ? (
          <div className="flex items-center gap-1"><span>今週の窓 L:</span>{L_PRESETS.map((v) => <Btn key={v} v={v} cur={L} set={setL} />)}</div>
        ) : (
          <span className="text-gray-500">今週= <span className="font-medium text-gray-700">{effL}営業日</span>（月〜今日）</span>
        )}
        <div className="flex items-center gap-1"><span>先行き H:</span>{H_PRESETS.map((v) => <Btn key={v} v={v} cur={H} set={setH} />)}</div>
        {(mode === "similar" || mode === "ensemble") && (
          <div className="flex items-center gap-1"><span>近傍 K:</span>{K_PRESETS.map((v) => <Btn key={v} v={v} cur={K} set={setK} />)}</div>
        )}
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

      {/* 手法の質: 重み・ボラ正規化・DTWバンド・HL距離 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-600">
        <div className="flex items-center gap-1">
          <span>近傍の重み:</span>
          {([["uniform", "等重み"], ["kernel", "カーネル"]] as [WeightMode, string][]).map(([m, lbl]) => (
            <button key={m} onClick={() => setWeight(m)}
              title={m === "kernel" ? "Nadaraya-Watson。距離が近い局面ほど重く、遠い局面は薄く。バンド幅=選抜距離の中央値。(B1)" : "全事例を1票ずつ等しく扱う。"}
              className={`px-2 py-0.5 rounded ${weight === m ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-600"}`}>{lbl}</button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1 cursor-pointer" title="フォワードをσ単位で集計し今週のσで掛け戻す。静かな週と荒い週の値幅の違いを補正(B2)。">
          <input type="checkbox" checked={volNorm} onChange={(e) => setVolNorm(e.target.checked)} className="accent-blue-600" />σ正規化
        </label>
        {metric === "dtw" && (
          <label className="inline-flex items-center gap-1" title="Sakoe-Chibaバンド幅(窓長比)。大きいほど時間のズレを許すが、L/2以上では退化(何でも似ている)に近づく(B3)。">
            <span>DTWバンド {Math.round(dtwBandFrac * 100)}%</span>
            <input type="range" min={0} max={50} step={5} value={Math.round(dtwBandFrac * 100)}
              onChange={(e) => setDtwBandFrac(Number(e.target.value) / 100)} className="accent-blue-600 w-24" />
            {dtwBandFrac >= 0.5 && <span className="text-amber-600">退化注意</span>}
          </label>
        )}
        <label className="inline-flex items-center gap-1" title="距離に日中レンジ(高安幅)の形状チャネルを加える重み γ。同じ終値経路でも荒れ方の違いを区別(B6)。">
          <span>HL距離 γ={hlWeight.toFixed(1)}</span>
          <input type="range" min={0} max={10} step={1} value={Math.round(hlWeight * 10)}
            onChange={(e) => setHlWeight(Number(e.target.value) / 10)} className="accent-blue-600 w-24" />
        </label>
      </div>

      {/* 米国ビン設定(usbin/ensemble モード) */}
      {mode !== "similar" && (
        <div className="space-y-2">
          <div className="flex items-center gap-4 flex-wrap">
            <UsDriverButtons value={usTicker} onChange={(t) => { setUsTicker(t); resetBin(); }} />
            <div className="flex items-center gap-1 flex-wrap text-xs">
              <span className="text-gray-500">ビン基準:</span>
              {([["ret", "前日終値比"], ["intra", "日中"]] as [UsMode, string][]).map(([m, lbl]) => (
                <button
                  key={m}
                  onClick={() => { setUsMode(m); resetBin(); }}
                  className={`px-2 py-0.5 rounded font-medium ${usMode === m ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                >{lbl}</button>
              ))}
            </div>
            <BinSchemeButtons value={scheme} onChange={(s) => { setScheme(s); resetBin(); }} />
          </div>

          {result && (
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              <span className="text-gray-500">見るビン:</span>
              {result.binMetaObj.labels.map((label, b) => {
                const isSel = b === result.selBin;
                const isQuery = b === result.queryUsBin;
                return (
                  <button
                    key={b}
                    onClick={() => setSelBinOverride(b)}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded font-medium ${isSel ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                  >
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: result.binMetaObj.colors[b] }} />
                    {label}
                    <span className={`text-[10px] ${isSel ? "text-gray-300" : "text-gray-400"}`}>n={result.binCounts[b]}</span>
                    {isQuery && <span className={isSel ? "text-amber-300" : "text-blue-600"}>◀今週</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {usLoading && <div className="text-xs text-gray-400">米国指数を取得中…</div>}
      {usError && <div className="text-xs text-red-500">{usError}</div>}

      {result ? (
        <>
          {(() => {
            const conf = confidence(result);
            const badgeCls = conf.level === "green" ? "bg-green-100 text-green-800 border-green-400"
              : conf.level === "amber" ? "bg-amber-100 text-amber-800 border-amber-400"
              : "bg-red-100 text-red-800 border-red-400";
            return (
              <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-bold ${badgeCls}`}
                    title={conf.reasons.join(" / ")}>信頼度: {conf.label}</span>
                  {result.rejected && <span className="text-red-700 font-medium">⚠ 今週は前例が薄い(novelty {(result.novelty * 100).toFixed(0)}%)——定石が効きにくい</span>}
                </div>
                <div>
                  {mode === "usbin"
                    ? <>前夜米国が<span className="font-bold">「{result.binMetaObj.labels[result.selBin]}」</span>で始まった過去 {result.selected.length} 週</>
                    : mode === "ensemble"
                    ? <>「{result.binMetaObj.labels[result.selBin]}」×似た形の過去 {result.selected.length} 局面</>
                    : <>今週の形に似た過去 {result.selected.length} 局面</>}
                  <span className="text-blue-700"> (実効 {result.nEff})</span>
                  {" → その後 "}{result.H}日の
                  <span className="font-bold"> 終値中央値 {fmtPct(result.medianFinal)}</span>
                  <span className="text-blue-700">（平均 {fmtPct(result.meanFinal)}｜勝率 {((result.upCount / (result.upCount + result.downCount || 1)) * 100).toFixed(0)}%）</span>
                </div>
                <div>
                  ベースライン(無条件)中央値 {fmtPct(result.baselineMedian)}／
                  <span className={`font-bold ${result.diffP < 0.05 ? "text-blue-900" : "text-gray-500"}`}>差 {result.diffMedian >= 0 ? "+" : ""}{(result.diffMedian * 100).toFixed(1)}pt, p={result.diffP < 0.001 ? "<.001" : result.diffP.toFixed(3)}</span>
                  <span className="text-blue-700">｜中央値95%CI [{fmtPct(result.ciLo)}, {fmtPct(result.ciHi)}]（方向安定 {(result.ciStable * 100).toFixed(0)}%）</span>
                </div>
                <div>
                  到達の中央値: <span className="text-green-700 font-bold">高値 {fmtPct(result.medianMfe)}</span>（利確目安）／
                  <span className="text-red-700 font-bold"> 安値 {fmtPct(result.medianMae)}</span>（損切り目安）
                  {result.volNorm && <span className="text-gray-500">｜σ正規化(今週σ {(result.volQuery * 100).toFixed(1)}%/日)</span>}
                </div>
              </div>
            );
          })()}

          <div className="relative"><canvas ref={canvasRef} /></div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-gray-400">
            <span><span className="inline-block w-4 h-0.5 align-middle" style={{ background: "#0f172a" }} /> 今週の経路(縦バー=日中高安)</span>
            <span><span className="inline-block w-4 h-0.5 align-middle" style={{ background: "#2563eb" }} /> その後の終値中央値</span>
            <span><span className="inline-block w-4 h-0.5 align-middle border-t border-dashed" style={{ borderColor: "#16a34a" }} /> 高値到達中央(MFE)</span>
            <span><span className="inline-block w-4 h-0.5 align-middle border-t border-dashed" style={{ borderColor: "#dc2626" }} /> 安値到達中央(MAE)</span>
            <span><span className="inline-block w-3 h-2 align-middle" style={{ background: "rgba(37,99,235,0.13)" }} /> 終値25–75%帯</span>
            <span><span className="inline-block w-4 h-0.5 align-middle border-t border-dashed" style={{ borderColor: "#6b7280" }} /> ベースライン中央(無条件)</span>
            <span>薄線=各事例（一覧クリックで<span style={{ color: "#f59e0b" }}>橙</span>強調）</span>
          </div>

          {/* 今週を日中足で見る(2階層目) */}
          {ticker && (
            <div className="space-y-1.5">
              <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                <input type="checkbox" checked={showIntraday} onChange={(e) => setShowIntraday(e.target.checked)} className="accent-blue-600" />
                今週の軌跡を日中足(60分)で見る
              </label>
              {showIntraday && (
                <>
                  {intraLoading && <div className="text-xs text-gray-400">日中足を取得中…</div>}
                  {intraError && <div className="text-xs text-red-500">{intraError}</div>}
                  {intraWeek && <div className="relative"><canvas ref={intraCanvasRef} /></div>}
                  <p className="text-[10px] text-gray-400">
                    日足では1日=1点に潰れる今週の値動きを、日中足で拡大表示（縦点線=日境界）。上のアナログ(過去局面)は日足のまま——
                    日中足は取得期間が短く(60分足≈2年)、何年も前のアナログ週は日中では再現できないため。
                  </p>
                </>
              )}
            </div>
          )}

          {/* アナログ一覧 */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">局面（週の起点〜今日相当）</th>
                  <th className="text-right px-2">前夜米国ビン</th>
                  {mode !== "usbin" && <th className="text-right px-2">形の距離</th>}
                  <th className="text-right px-2">高値到達</th>
                  <th className="text-right px-2">安値到達</th>
                  <th className="text-right px-2">終値{result.H}日後</th>
                </tr>
              </thead>
              <tbody>
                {result.selected.slice(0, 10).map((s) => (
                  <tr key={`${s.source}-${s.endIndex}`}
                    onClick={() => setHighlight(highlight === s.endIndex ? null : s.endIndex)}
                    className={`border-b border-gray-100 cursor-pointer ${highlight === s.endIndex ? "bg-amber-50" : "hover:bg-gray-50"}`}>
                    <td className="py-1 px-2 text-gray-700 tabular-nums">{s.source && <span className="text-[9px] text-gray-400 mr-1">{s.source}</span>}{s.startTime} 〜 {s.endTime}</td>
                    <td className="text-right px-2">
                      {s.usBin !== null
                        ? <span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: result.binMetaObj.colors[s.usBin] }} />{result.binMetaObj.labels[s.usBin]}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    {mode !== "usbin" && <td className="text-right px-2 text-gray-500 tabular-nums">{s.distance.toFixed(2)}</td>}
                    <td className="text-right px-2 text-green-600 tabular-nums">{fmtPct(s.mfe)}</td>
                    <td className="text-right px-2 text-red-600 tabular-nums">{fmtPct(s.mae)}</td>
                    <td className={`text-right px-2 font-medium tabular-nums ${s.forwardReturn >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtPct(s.forwardReturn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        !usLoading && <div className="text-xs text-gray-400">
          該当する過去局面が不足しています。窓 L を短く・先行き H を短く、ビンを粗く（陰陽/3分位）、または「似た形で絞る」に切り替えてください。
        </div>
      )}

      <AnalysisGuide title="今週の軌跡アナログ比較の詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"『今の値動きが過去のどの局面に似ていて、そのとき次に何が起きたか』を機械的に探す手法(アナログ予測)。今週(直近L営業日)の経路をクエリにして、過去から似た局面を集め、その"}<strong>その後H日</strong>{"の分布を重ねる。似た入口のあとに何が起きたかの経験分布を、確率的な先読みの材料にする。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 2つの絞り方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>前夜米国ビンで絞る</strong>: 窓の起点(週初め)の前夜米国が指定ビン(例: 米大幅高)だった過去週だけを集める。「同じ地合いで始まった週はその後どうなったか」。米国ビンは各JP立会日に『寄り前で最後に確定した米国立会日(暦日が厳密に小さい最新)』のリターンを対応付けて層別(祝日・連休も自動整合)。</li>
          <li><strong>似た形で絞る(アナログ)</strong>: 今週のリードイン形状に最も近い過去K局面を距離で探す。各窓を「窓末=0%の累積リターン列」にしz化(水準・ボラの差を吸収し"形"だけ比較)、距離が小さい順。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">2b. 形の距離: ユークリッド と DTW</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ユークリッド(等速比較)</strong>: 同じ日付位置どうしの差を二乗和。d(a,b)=√Σ(aᵢ−bᵢ)²。単純だが<strong>時間のズレに弱い</strong>——同じ形でも山が1日早い/遅いだけで「似ていない」と判定される。</li>
          <li><strong>DTW(動的時間伸縮)</strong>: 時間軸の伸び縮みを許して対応付ける。漸化式 {"D(i,j)=(aᵢ−bⱼ)² + min{ D(i−1,j), D(i,j−1), D(i−1,j−1) }"} を解き、累積コストの平方根を距離とする。「山が1日ずれた同じ形」を正しく似ていると判定できる。イメージは<em>2つの波形をゴムひものように伸縮させて最も重なる対応を探す</em>。</li>
          <li><strong>Sakoe-Chibaバンド</strong>: warping の幅を窓長の約1/4(最低1)に制限。無制限だと1点が多数点に対応する退化(1日が週全体に伸びる等)が起き、計算量も増えるため。</li>
          <li>使い分け: 曜日位置そのものに意味がある(月曜安い等)なら<strong>ユークリッド</strong>、値動きの「形」を優先しタイミングのズレを許すなら<strong>DTW</strong>。両方で残る局面は確度が高い。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">2c. 窓の取り方: 直近L営業日 と 週境界アライン</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>直近L営業日</strong>: 週をまたいで単純に直近L日を窓にする。候補位置が全日にわたるため<strong>事例数が多く安定</strong>するが、曜日位置は揃わない(過去窓の起点が水曜だったりする)。</li>
          <li><strong>今週(週境界)</strong>: 月曜起点で今日までを窓とし(L=今週の経過立会日数、火曜なら2)、過去は<strong>各週の先頭L日</strong>と比較する。曜日位置が今週と揃い、窓起点=<strong>週初め</strong>＝前夜米国ビンの基準日が厳密に一致する。週の進行に応じてLが自動で伸びる(月→金で1→5)。</li>
          <li>トレードオフ: 週境界アラインは候補が「週数」まで減る(≒1/5)。10年で約500週なので3分位ビンなら各≈150週だが、5分位や短い履歴では薄くなる。事例数の表示を必ず確認する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">2d. 統計的妥当性: ベースライン差・実効n・信頼度</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>無条件ベースラインとの差(A1)</strong>: 「勝率58%」も、その銘柄の<em>無条件</em>のH日リターンが元々56%なら無意味。全候補窓のフォワード分布を灰色の点線で重ね、選抜中央値との<strong>差(pt)と p 値</strong>を出す。p 値は<strong>ブロック順列検定</strong>——重複窓のかたまり(クラスタ)を単位に無作為抽出したヌル差の分布で |実測差| の外れ度を測る。差が有意でないビンは「絞った意味がない」。</li>
          <li><strong>実効標本数 n_eff(A2)</strong>: 隣接窓はフォワードをH−1日共有し独立でない。「事例300」の独立数は実質 ≈300/H。フォワードが重なる窓を1クラスタに畳んだ数が<strong>実効n</strong>。25–75%帯やCIはこのクラスタを単位に<strong>ブロック・ブートストラップ</strong>で出すので、初めて過信のない幅になる。</li>
          <li><strong>信頼度バッジ(C1)</strong>: 実効n≥15・ベースライン差 p&lt;0.05・前例あり(novelty低)の3条件で<span className="text-green-700 font-medium">緑=採用可</span>/<span className="text-amber-700 font-medium">黄=参考</span>/<span className="text-red-700 font-medium">赤=使うな</span>。増えた指標を1つの信号に統合する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">2e. 手法の質: 重み・ボラ正規化・novelty・アンサンブル</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>カーネル重み(B1)</strong>: 上位K件を等重みにすると1位も20位も同じ1票。Nadaraya-Watson は距離 d の近い局面を重く w=exp(−d²/2h²)(h=選抜距離の中央値)。遠い近傍の希釈を防ぐ。</li>
          <li><strong>novelty / 棄却(B1・C5)</strong>: 今週の最近傍距離を過去の最近傍距離分布の中で位置づけた分位。上位(90%超)なら<strong>「前例が薄い」</strong>と警告——今週が前例のない形なら、無理に集めた事例で予測を出すべきでない。棄却状態自体が「定石が効かない」という情報。</li>
          <li><strong>σ正規化(B2)</strong>: z化は形だけ見るため、静かな週(σ0.5%)と荒い週(σ3%)が「同じ形」で一致しうる。フォワードをσ単位に直して集計し今週のσで掛け戻すと、MFE/MAEの値幅目安が現在のボラ環境に整合する。</li>
          <li><strong>DTWバンド可変(B3)</strong>: Sakoe-Chibaバンドは結果を大きく左右する(広いほど「何でも似ている」)。スライダで感度を確認できる。L/2以上は退化(1点が多数点に対応)しやすい。</li>
          <li><strong>HL距離 γ(B6)</strong>: 終値経路だけの距離に日中レンジ(高安幅)の形状チャネルを加える。d=√(d_close²+γ·d_range²)。「同じ終値経路でも荒れながら来たか静かに来たか」を区別。</li>
          <li><strong>両立(アンサンブル, B4)</strong>: 前夜米国ビンで絞ったうえで形の近い順にK件。地合いと形が両立した局面は確度が高いが、事例が減るので実効nを必ず確認。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 図の読み方(すべて窓末=今日=0%に再基準化)</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>左側(t&lt;0, リードイン)</strong>: 今日に至る経路。<span className="text-gray-900 font-medium">濃紺の太線=今週</span>、点線=過去局面のリードイン中央値。両者の重なり具合で「似た入口か」を目視確認。全系列は t=0 で 0% に収束する。</li>
          <li><strong>右側(t&gt;0, フォワード)</strong>: その後の分布。<span className="text-blue-700 font-medium">青の太線=終値の中央値</span>、帯=終値25–75%、薄線=各事例。右肩上がり＆帯が上偏＝似た局面のあと上がりやすい。</li>
          <li><strong>高安到達(HL/MFE・MAE)</strong>: 終値だけでなく日中の高安も使う。<span className="text-green-700 font-medium">緑点線=高値到達の中央値(MFE)</span>＝その後どこまで上げたか(利確目安)、<span className="text-red-700 font-medium">赤点線=安値到達の中央値(MAE)</span>＝どこまで下げたか(損切り/含み損目安)。各時点までの running max/min を集計。緑赤に挟まれたコーンが「典型的な値幅」。今週の経路には縦バーで日中レンジ(高安)を重ねる。</li>
          <li>上部バナーの終値中央値・勝率に加え、到達の中央値(高値/安値)で利確幅・ストップ幅の当たりを付ける。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>中央値が明確にプラス＆勝率が高い＆帯が狭い＝翌週にかけて順張り妙味。逆なら手仕舞い/逆張り警戒。</li>
          <li>「前夜米国ビン」モードは、今夜の米国が確定した時点で来週の入口ビンが分かるため、地合い起点の先読みに使える。</li>
          <li>アナログ一覧の日付を本体チャートで確認し、当時の相場環境(暴落後/天井圏など)が今と整合するか吟味してから採用。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>「形・地合いが似ている」だけで因果はない。事例数が少ない(帯が広い/n小)ほど偶然に振られる。サイズを抑える。</li>
          <li>レジームが違えば同じ入口でも結果は変わる(過去の上げ相場と今の下げ相場など)。</li>
          <li>窓の取り方・距離(ユークリッド/DTW)・窓L・先行きH・ビン粗さで結果は変わる。複数設定で残る結論だけ採用する(設定を探し回ると過学習)。DTWも万能ではなく、バンドを広げるほど「何でも似ている」に近づく。</li>
          <li>週境界アラインは候補が週数まで減り、5分位や短い履歴では事例が薄くなる(コアは最低3事例で打ち切り)。事例数を必ず確認。</li>
          <li>日中足ドリルダウン(「今週を日中足で見る」)は<strong>今週側のみ</strong>。日中足の取得期間が短い(60分足≈2年)ため、何年も前のアナログ過去局面は日中では再現できず、アナログ本体は日足で比較する。日足の高安(MFE/MAE)が値幅の目安を補う。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
