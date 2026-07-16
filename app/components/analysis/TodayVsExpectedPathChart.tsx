"use client";

// 当日の実測パス vs 条件付き期待パス（曜日 × 前夜米国ビン）。
//
// 曜日と前夜米国は寄り前に確定しているため、その条件で束ねた過去日の日内パスは「今日の台本」として
// 先読みなしに引ける。本コンポーネントはその台本と実際の値動きを3つの視点で突き合わせる。
//   ① 重ね     : 分位ファンに実測を重ね、各時刻の z / パーセンタイルで乖離を較正して読む
//   ② 乖離→残余: 時刻tの乖離から t→引けの残余リターンを説明できるか（継続かフェードか）＝売買判断の核
//   ③ 追随度   : そもそも台本が個別日をどれだけ説明するか（leave-one-out）＝健全性チェック
//
// 計算はすべて lib/today-vs-expected.ts。ここは配線と描画のみ。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildUsBinning, computeTodayVsExpected, TodayVsExpectedResult,
  CondMode, COND_MODES, WD_LABELS,
} from "../../lib/today-vs-expected";
import { BinScheme } from "../../lib/us-spillover-core";
import { useAlignedDays, UsDriverButtons, BinSchemeButtons } from "./usSpilloverShared";
import { US_DRIVERS } from "../../hooks/useUsDaily";
import {
  initCanvas, IntervalButtons, LoadingError, IntradayCaveat, ViewTabs,
  fmtSignedPct, fmtPct, drawTimeAxisLabels,
} from "./intradayShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

type UsMode = "ret" | "intra";
const US_MODES: { value: UsMode; label: string; formula: string }[] = [
  { value: "ret", label: "前日終値比", formula: "ln(当日終値 / 前日終値)（オーバーナイト含む米国当日騰落）" },
  { value: "intra", label: "日中", formula: "ln(当日終値 / 当日始値)（米国正規セッション内の値動き）" },
];

type View = "overlay" | "residual" | "track";
const VIEWS: { value: View; label: string }[] = [
  { value: "overlay", label: "① 重ね（実測 vs 期待）" },
  { value: "residual", label: "② 乖離 → 残余の予測力" },
  { value: "track", label: "③ 台本の追随度" },
];

const TODAY_COLOR = "#111827";
const MEAN_COLOR = "#64748b";

// ───────────────────────── ① 重ね描き ─────────────────────────

function drawOverlay(
  ctx: CanvasRenderingContext2D, W: number, H: number, r: TodayVsExpectedResult,
  opts: { showFan: boolean; showMedian: boolean }
) {
  const ml = 46, mr = 10, mt = 10, mb = 22;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const G = r.timeLabels.length;
  if (G < 2) return;
  const yMax = r.maxAbs * 1.05;
  const X = (g: number) => ml + (g / (G - 1)) * plotW;
  const Y = (v: number) => mt + (1 - (v + yMax) / (2 * yMax)) * plotH;

  ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();

  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(fmtSignedPct(yMax, 1), ml - 3, mt + 8);
  ctx.fillText("0", ml - 3, Y(0) + 3);
  ctx.fillText(fmtSignedPct(-yMax, 1), ml - 3, mt + plotH);

  // 分位ファン(外=10-90%, 内=25-75%)。平均の精度ではなく「日々のばらつき」を示す帯。
  if (opts.showFan) {
    const band = (lo: (i: number) => number, hi: (i: number) => number, fill: string) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      for (let g = 0; g < G; g++) ctx.lineTo(X(g), Y(hi(g)));
      for (let g = G - 1; g >= 0; g--) ctx.lineTo(X(g), Y(lo(g)));
      ctx.closePath(); ctx.fill();
    };
    band((g) => r.fan[g].q10, (g) => r.fan[g].q90, "#94a3b81f");
    band((g) => r.fan[g].q25, (g) => r.fan[g].q75, "#94a3b840");
  }

  // 期待パス(条件セルの平均)
  ctx.strokeStyle = MEAN_COLOR; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let g = 0; g < G; g++) { const x = X(g), y = Y(r.fan[g].mean); if (g === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.stroke();

  if (opts.showMedian) {
    ctx.setLineDash([3, 3]); ctx.lineWidth = 1.5; ctx.strokeStyle = MEAN_COLOR + "cc";
    ctx.beginPath();
    for (let g = 0; g < G; g++) { const x = X(g), y = Y(r.fan[g].med); if (g === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke(); ctx.setLineDash([]);
  }

  // 対象日の実測。到達済みビンだけを描く(前方補完による偽の平坦線を避ける)。
  if (r.lastIdx >= 0) {
    ctx.strokeStyle = TODAY_COLOR; ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let g = 0; g <= r.lastIdx; g++) { const x = X(g), y = Y(r.today[g].actual); if (g === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
    for (let g = 0; g <= r.lastIdx; g++) {
      ctx.fillStyle = TODAY_COLOR;
      ctx.beginPath(); ctx.arc(X(g), Y(r.today[g].actual), 2.2, 0, Math.PI * 2); ctx.fill();
    }
    // 現在地(最終到達点)を強調
    const cx = X(r.lastIdx), cy = Y(r.today[r.lastIdx].actual);
    ctx.strokeStyle = TODAY_COLOR; ctx.lineWidth = 1.5; ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (r.inSession) {
      ctx.setLineDash([2, 3]); ctx.strokeStyle = "#9ca3af"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, mt); ctx.lineTo(cx, mt + plotH); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#6b7280"; ctx.font = "8px sans-serif"; ctx.textAlign = "left";
      ctx.fillText("現在", cx + 3, mt + 8);
    }
  }

  drawTimeAxisLabels(ctx, r.timeLabels, ml, plotW / G, H - 6);
}

// ───────────────────────── ② β(t) 曲線 ─────────────────────────

function drawBetaCurve(ctx: CanvasRenderingContext2D, W: number, H: number, r: TodayVsExpectedResult, selG: number) {
  const ml = 46, mr = 10, mt = 10, mb = 22;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const G = r.timeLabels.length;
  const usable = r.betas.map((b, g) => ({ b, g })).filter((x) => x.b.ok);
  if (usable.length === 0) return;
  let yMax = 1e-6;
  for (const { b } of usable) {
    yMax = Math.max(yMax, Math.abs(b.beta));
    if (isFinite(b.bootLo)) yMax = Math.max(yMax, Math.abs(b.bootLo));
    if (isFinite(b.bootHi)) yMax = Math.max(yMax, Math.abs(b.bootHi));
  }
  yMax *= 1.12;
  const slot = plotW / G;
  const X = (g: number) => ml + g * slot + slot / 2;
  const Y = (v: number) => mt + (1 - (v + yMax) / (2 * yMax)) * plotH;

  ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();

  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(fmtSignedPct(yMax, 2), ml - 3, mt + 8);
  ctx.fillText("0", ml - 3, Y(0) + 3);
  ctx.fillText(fmtSignedPct(-yMax, 2), ml - 3, mt + plotH);

  for (const { b, g } of usable) {
    const x = X(g);
    if (g === selG) { ctx.fillStyle = "#fef3c7"; ctx.fillRect(x - slot / 2, mt, slot, plotH); }
    // ブートCIのヒゲ
    if (isFinite(b.bootLo) && isFinite(b.bootHi)) {
      ctx.strokeStyle = "#9ca3af"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, Y(b.bootLo)); ctx.lineTo(x, Y(b.bootHi)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 3, Y(b.bootLo)); ctx.lineTo(x + 3, Y(b.bootLo)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 3, Y(b.bootHi)); ctx.lineTo(x + 3, Y(b.bootHi)); ctx.stroke();
    }
    const sig = b.pAdj < 0.05;
    ctx.fillStyle = b.beta >= 0 ? "#16a34a" : "#dc2626";
    const bw = Math.min(14, slot * 0.5);
    ctx.fillRect(x - bw / 2, Math.min(Y(0), Y(b.beta)), bw, Math.abs(Y(b.beta) - Y(0)));
    if (sig) {
      ctx.fillStyle = "#b45309"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("★", x, Y(b.beta) + (b.beta >= 0 ? -6 : 12));
    }
  }
  drawTimeAxisLabels(ctx, r.timeLabels, ml, slot, H - 6);
}

// ───────────────────────── ② 散布図(選択時刻) ─────────────────────────

function drawScatter(ctx: CanvasRenderingContext2D, W: number, H: number, r: TodayVsExpectedResult, g: number) {
  const ml = 46, mr = 12, mt = 12, mb = 26;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const b = r.betas[g];
  if (!b || !b.ok) return;
  const xs = r.zMat.map((row) => row[g]);
  const ys = r.resMat.map((row) => row[g]);
  const todayZ = r.today[g].valid ? r.today[g].z : null;

  let xMax = 0.5, yMax = 1e-6;
  for (const v of xs) xMax = Math.max(xMax, Math.abs(v));
  for (const v of ys) yMax = Math.max(yMax, Math.abs(v));
  if (todayZ !== null) xMax = Math.max(xMax, Math.abs(todayZ));
  xMax *= 1.1; yMax *= 1.1;
  const X = (v: number) => ml + ((v + xMax) / (2 * xMax)) * plotW;
  const Y = (v: number) => mt + (1 - (v + yMax) / (2 * yMax)) * plotH;

  ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  ctx.strokeStyle = "#d1d5db";
  ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(X(0), mt); ctx.lineTo(X(0), mt + plotH); ctx.stroke();

  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(fmtSignedPct(yMax, 1), ml - 3, mt + 8);
  ctx.fillText(fmtSignedPct(-yMax, 1), ml - 3, mt + plotH);
  ctx.textAlign = "center";
  ctx.fillText(`z=−${xMax.toFixed(1)}`, ml + 14, H - 8);
  ctx.fillText(`z=+${xMax.toFixed(1)}`, ml + plotW - 14, H - 8);
  ctx.fillText("← 期待より弱い　　乖離 z　　期待より強い →", ml + plotW / 2, H - 8);

  // 回帰直線
  ctx.strokeStyle = b.beta >= 0 ? "#16a34a" : "#dc2626"; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(X(-xMax), Y(b.alpha + b.beta * -xMax));
  ctx.lineTo(X(xMax), Y(b.alpha + b.beta * xMax));
  ctx.stroke();

  for (let i = 0; i < xs.length; i++) {
    ctx.fillStyle = "#3b82f680";
    ctx.beginPath(); ctx.arc(X(xs[i]), Y(ys[i]), 3, 0, Math.PI * 2); ctx.fill();
  }

  // 対象日の z と、その予測残余
  if (todayZ !== null) {
    const tx = X(todayZ);
    ctx.setLineDash([3, 3]); ctx.strokeStyle = TODAY_COLOR; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(tx, mt); ctx.lineTo(tx, mt + plotH); ctx.stroke(); ctx.setLineDash([]);
    if (b.predicted !== null) {
      ctx.fillStyle = TODAY_COLOR;
      ctx.beginPath(); ctx.arc(tx, Y(b.predicted), 4.5, 0, Math.PI * 2); ctx.fill();
      if (b.predLo !== null && b.predHi !== null) {
        ctx.strokeStyle = TODAY_COLOR + "88"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(tx, Y(Math.max(-yMax, b.predLo))); ctx.lineTo(tx, Y(Math.min(yMax, b.predHi))); ctx.stroke();
      }
    }
    ctx.fillStyle = TODAY_COLOR; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("対象日", tx + 4, mt + 9);
  }
}

// ───────────────────────── ③ 追随度ヒストグラム ─────────────────────────

function drawTrackHist(ctx: CanvasRenderingContext2D, W: number, H: number, r: TodayVsExpectedResult) {
  const ml = 34, mr = 12, mt = 12, mb = 26;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const vals = r.track.map((t) => t.corr).filter((v) => isFinite(v));
  if (vals.length === 0) return;
  const NB = 20;
  const counts = new Array(NB).fill(0);
  for (const v of vals) {
    const k = Math.min(NB - 1, Math.max(0, Math.floor(((v + 1) / 2) * NB)));
    counts[k]++;
  }
  const cMax = Math.max(...counts, 1);
  const X = (v: number) => ml + ((v + 1) / 2) * plotW;
  const slot = plotW / NB;

  ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }

  for (let k = 0; k < NB; k++) {
    if (counts[k] === 0) continue;
    const h = (counts[k] / cMax) * plotH;
    const center = -1 + ((k + 0.5) / NB) * 2;
    ctx.fillStyle = center >= 0 ? "#3b82f6aa" : "#f9731699";
    ctx.fillRect(ml + k * slot + 1, mt + plotH - h, slot - 2, h);
  }

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X(0), mt); ctx.lineTo(X(0), mt + plotH); ctx.stroke();

  if (r.trackToday !== null && isFinite(r.trackToday)) {
    const tx = X(r.trackToday);
    ctx.strokeStyle = TODAY_COLOR; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(tx, mt); ctx.lineTo(tx, mt + plotH); ctx.stroke();
    ctx.fillStyle = TODAY_COLOR; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("対象日", tx, mt - 2);
  }

  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(String(cMax), ml - 3, mt + 8);
  ctx.fillText("0", ml - 3, mt + plotH);
  ctx.textAlign = "center";
  for (const v of [-1, -0.5, 0, 0.5, 1]) ctx.fillText(v.toFixed(1), X(v), H - 12);
  ctx.fillText("← 台本と逆の形　　パス相関　　台本どおりの形 →", ml + plotW / 2, H - 2);
}

// ───────────────────────── 本体 ─────────────────────────

export default function TodayVsExpectedPathChart({ ticker }: Props) {
  const [usTicker, setUsTicker] = useState("^IXIC");
  const [interval, setInterval] = useState("60m");
  const [scheme, setScheme] = useState<BinScheme>("tercile");
  const [usMode, setUsMode] = useState<UsMode>("ret");
  const [condMode, setCondMode] = useState<CondMode>("both");
  const [targetDate, setTargetDate] = useState<string | null>(null); // null=最新の立会日
  const [priorOnly, setPriorOnly] = useState(true);
  const [view, setView] = useState<View>("overlay");
  const [showFan, setShowFan] = useState(true);
  const [showMedian, setShowMedian] = useState(true);
  const [selGRaw, setSelGRaw] = useState<number | null>(null); // null=現在地の時刻

  const { data, loading, error } = useAlignedDays(ticker, interval, usTicker);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const betaRef = useRef<HTMLCanvasElement>(null);
  const scatterRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLCanvasElement>(null);

  const binning = useMemo(
    () => (data ? buildUsBinning(data.aligned, data.us, usMode, scheme) : null),
    [data, usMode, scheme]
  );

  const result = useMemo(
    () => (binning && data ? computeTodayVsExpected(binning, data.grid, data.gmtoffset, { condMode, targetDate, priorOnly }) : null),
    [binning, data, condMode, targetDate, priorOnly]
  );

  // 散布図の対象時刻: 未選択なら現在地(最終到達ビン)。残余が定義されない最終ビンは1つ手前に寄せる。
  const selG = useMemo(() => {
    if (!result) return 0;
    const G = result.timeLabels.length;
    const fallback = Math.min(Math.max(result.lastIdx, 0), G - 2);
    const g = selGRaw ?? fallback;
    return Math.min(Math.max(g, 0), G - 2);
  }, [result, selGRaw]);

  useEffect(() => {
    if (view !== "overlay" || !result || !overlayRef.current) return;
    const init = initCanvas(overlayRef.current, 280);
    if (init) drawOverlay(init.ctx, init.width, init.height, result, { showFan, showMedian });
  }, [view, result, showFan, showMedian]);

  useEffect(() => {
    if (view !== "residual" || !result) return;
    if (betaRef.current) {
      const i = initCanvas(betaRef.current, 220);
      if (i) drawBetaCurve(i.ctx, i.width, i.height, result, selG);
    }
    if (scatterRef.current) {
      const i = initCanvas(scatterRef.current, 260);
      if (i) drawScatter(i.ctx, i.width, i.height, result, selG);
    }
  }, [view, result, selG]);

  useEffect(() => {
    if (view !== "track" || !result || !trackRef.current) return;
    const init = initCanvas(trackRef.current, 220);
    if (init) drawTrackHist(init.ctx, init.width, init.height, result);
  }, [view, result]);

  const resetSel = useCallback(() => setSelGRaw(null), []);
  const usLabel = US_DRIVERS.find((d) => d.ticker === usTicker)?.label ?? usTicker;
  const modeMeta = US_MODES.find((m) => m.value === usMode)!;

  // 対象日の候補(直近60立会日)。
  const dateOptions = useMemo(() => {
    if (!binning) return [];
    return binning.rows.slice(-60).map((a) => a.jp.date).reverse();
  }, [binning]);

  const nowBin = result && result.lastIdx >= 0 ? result.today[result.lastIdx] : null;
  const nowBeta = result && result.lastIdx >= 0 && result.lastIdx < result.timeLabels.length - 1
    ? result.betas[result.lastIdx] : null;
  const selBinInfo = result && binning ? binning.binInfos[result.targetBin] : null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">当日の実測 vs 条件付き期待パス（曜日 × 前夜米国ビン）</h3>
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
              title={m.formula}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                usMode === m.value ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <BinSchemeButtons value={scheme} onChange={setScheme} />
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">期待パスの条件:</span>
          {COND_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setCondMode(m.value)}
              title={m.note}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                condMode === m.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-xs text-gray-600">
          <span className="text-gray-500">対象日:</span>
          <select
            value={targetDate ?? ""}
            onChange={(e) => { setTargetDate(e.target.value || null); resetSel(); }}
            className="border border-gray-200 rounded px-1.5 py-0.5 text-xs bg-white"
          >
            <option value="">最新の立会日</option>
            {dateOptions.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-gray-600" title="対象日より後の日を標本から外す。過去日を選んで『その日の朝に見えていたはずの台本』を再現する（先読み排除）。">
          <input type="checkbox" checked={priorOnly} onChange={(e) => setPriorOnly(e.target.checked)} />
          対象日より前の標本のみ（先読み排除）
        </label>
      </div>

      <LoadingError loading={loading} error={error} />
      {!loading && !error && data && !result && (
        <div className="text-xs text-gray-400">
          条件に合う過去日が不足しています（条件を「米国のみ」「曜日のみ」に緩めるか、60分足を選択）。
        </div>
      )}

      {result && (
        <>
          {/* 対象日の条件と現在地 */}
          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 space-y-1">
            <div>
              <span className="font-bold">対象日 {result.targetDate}（{WD_LABELS[result.targetWeekday]}）</span>
              {result.inSession && (
                <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 text-[10px] font-bold align-middle">
                  場中・{result.timeLabels[result.lastIdx]}まで
                </span>
              )}
              {selBinInfo && <>{" ／ 前夜 "}{usLabel}{" "}{modeMeta.label}が「<span className="font-bold">{selBinInfo.label}</span>」</>}
              {" → この条件に一致する過去日 "}<span className="font-bold">n={result.n}</span>
            </div>
            {nowBin && (
              <div>
                {`現在地 ${result.timeLabels[result.lastIdx]}: 実測 ${fmtSignedPct(nowBin.actual)}／期待 ${fmtSignedPct(result.fan[result.lastIdx].mean)}`}
                {` → 乖離 z=${nowBin.z.toFixed(2)}・条件付き分布の${fmtPct(nowBin.pctile, 0)}タイル`}
                <span className="ml-1 font-bold">
                  {Math.abs(nowBin.z) < 0.5 ? "（ほぼ台本どおり）" : nowBin.z > 0 ? "（台本より強い）" : "（台本より弱い）"}
                </span>
              </div>
            )}
            {nowBeta && nowBeta.ok && nowBeta.predicted !== null && (
              <div>
                {`ここからの残余（${result.timeLabels[result.lastIdx]}→引け）予測: `}
                <span className={`font-bold ${nowBeta.predicted >= 0 ? "text-green-700" : "text-red-700"}`}>
                  {fmtSignedPct(nowBeta.predicted)}
                </span>
                {nowBeta.predLo !== null && nowBeta.predHi !== null &&
                  ` （95%予測区間 ${fmtSignedPct(nowBeta.predLo)} 〜 ${fmtSignedPct(nowBeta.predHi)}）`}
                {nowBeta.pAdj < 0.05
                  ? <span className="ml-1 text-amber-800 font-bold">★乖離に予測力あり</span>
                  : <span className="ml-1 text-blue-700">（乖離の予測力は有意でない＝この予測は条件平均とほぼ同義）</span>}
              </div>
            )}
          </div>

          <ViewTabs value={view} onChange={setView} views={VIEWS} />

          {view === "overlay" && (
            <>
              <div className="flex items-center gap-4 flex-wrap">
                <label className="flex items-center gap-1 text-xs text-gray-600">
                  <input type="checkbox" checked={showFan} onChange={(e) => setShowFan(e.target.checked)} />
                  分位ファン（10-90% / 25-75%）
                </label>
                <label className="flex items-center gap-1 text-xs text-gray-600">
                  <input type="checkbox" checked={showMedian} onChange={(e) => setShowMedian(e.target.checked)} />
                  中央値パス（破線）
                </label>
              </div>
              <div className="flex items-center gap-3 flex-wrap text-[11px]">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-4 h-0.5" style={{ backgroundColor: TODAY_COLOR }} />
                  <span className="text-gray-600">対象日の実測（{result.targetDate}）</span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-4 h-0.5" style={{ backgroundColor: MEAN_COLOR }} />
                  <span className="text-gray-600">条件付き期待パス（n={result.n}）</span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: "#94a3b840" }} />
                  <span className="text-gray-600">過去日の分布帯</span>
                </span>
              </div>
              <div className="relative"><canvas ref={overlayRef} /></div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="text-left py-1 px-2">時刻</th>
                      <th className="text-right px-2">実測（寄り比）</th>
                      <th className="text-right px-2">期待（平均）</th>
                      <th className="text-right px-2">乖離</th>
                      <th className="text-right px-2">z</th>
                      <th className="text-right px-2">パーセンタイル</th>
                      <th className="text-left px-2">位置</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.today.map((t, g) => {
                      if (!t.valid) return null;
                      const d = t.actual - result.fan[g].mean;
                      const extreme = t.pctile >= 0.9 || t.pctile <= 0.1;
                      return (
                        <tr key={g} className={`border-b border-gray-100 ${g === result.lastIdx ? "bg-amber-50" : ""}`}>
                          <td className="py-1 px-2 text-gray-700">{result.timeLabels[g]}{g === result.lastIdx && result.inSession ? " ◀現在" : ""}</td>
                          <td className={`text-right px-2 font-medium tabular-nums ${t.actual >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(t.actual)}</td>
                          <td className="text-right px-2 text-gray-500 tabular-nums">{fmtSignedPct(result.fan[g].mean)}</td>
                          <td className={`text-right px-2 tabular-nums ${d >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(d)}</td>
                          <td className="text-right px-2 tabular-nums text-gray-700">{t.z.toFixed(2)}</td>
                          <td className={`text-right px-2 tabular-nums ${extreme ? "font-bold text-amber-800" : "text-gray-600"}`}>{fmtPct(t.pctile, 0)}</td>
                          <td className="px-2 text-gray-500">
                            {t.pctile >= 0.9 ? "上位10%（台本を大きく上振れ）"
                              : t.pctile <= 0.1 ? "下位10%（台本を大きく下振れ）"
                              : t.pctile >= 0.75 ? "上振れ"
                              : t.pctile <= 0.25 ? "下振れ"
                              : "台本の中心付近"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-gray-400">
                帯は「平均の精度」ではなく過去日の実測分布。今日がその中のどこにいるかを測るには、この分布帯が正しい物差しになる。
                パーセンタイルが極端（上位/下位10%）なら、条件を踏まえてもなお異例の動き＝台本外の材料が出ている可能性。
              </p>
            </>
          )}

          {view === "residual" && (
            <>
              <div className="text-xs text-gray-600">
                <span className="font-medium text-gray-700">問い:</span>{" "}
                <span className="text-gray-500">
                  「期待より上振れている日は、そのまま伸びるか（継続）、それとも戻すか（フェード）」。
                  各時刻tでの乖離 z(t) を説明変数、t→引けの残余リターンを被説明変数にした回帰係数 β(t)。
                  β&gt;0＝上振れがさらに伸びる（継続）、β&lt;0＝上振れが引けにかけて剥がれる（フェード）。
                </span>
              </div>
              <div className="relative"><canvas ref={betaRef} /></div>
              <p className="text-[11px] text-gray-400">
                縦棒＝β（乖離1σあたりの残余リターン）、ヒゲ＝95%ブートCI、★＝時間ビン横断でFDR補正後も有意。
                最終ビンは残余が定義上ゼロのため対象外。
              </p>

              <div className="flex items-center gap-1.5 flex-wrap text-xs">
                <span className="text-gray-500">散布図の時刻:</span>
                {result.timeLabels.slice(0, -1).map((lb, g) => (
                  <button
                    key={g}
                    onClick={() => setSelGRaw(g)}
                    className={`px-2 py-0.5 rounded font-medium transition-colors ${
                      g === selG ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}
                  >
                    {lb}
                  </button>
                ))}
                {selGRaw !== null && (
                  <button onClick={resetSel} className="ml-1 underline text-blue-700 hover:text-blue-900">現在地に戻す</button>
                )}
              </div>

              {result.betas[selG]?.ok ? (
                <>
                  <div className="relative"><canvas ref={scatterRef} /></div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                    <div className="bg-gray-50 rounded p-2">
                      <div className="text-gray-500">β（{result.timeLabels[selG]}）</div>
                      <div className={`font-bold ${result.betas[selG].beta >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {fmtSignedPct(result.betas[selG].beta)} / 1σ
                      </div>
                    </div>
                    <div className="bg-gray-50 rounded p-2">
                      <div className="text-gray-500">決定係数 R²</div>
                      <div className="font-bold text-gray-800">{(result.betas[selG].r2 * 100).toFixed(1)}%</div>
                    </div>
                    <div className="bg-gray-50 rounded p-2">
                      <div className="text-gray-500">βの95%ブートCI</div>
                      <div className="font-bold text-gray-800 text-[11px]">
                        {isFinite(result.betas[selG].bootLo)
                          ? `${fmtSignedPct(result.betas[selG].bootLo)} 〜 ${fmtSignedPct(result.betas[selG].bootHi)}`
                          : "標本不足"}
                      </div>
                    </div>
                    <div className="bg-gray-50 rounded p-2">
                      <div className="text-gray-500">有意性（FDR補正後）</div>
                      <div><StatBadge n={result.n} p={result.betas[selG].pAdj} significant={result.betas[selG].pAdj < 0.05} /></div>
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-400">
                    青点＝過去日（横=その日の乖離z、縦=そこから引けまでの残余）。破線＝対象日の現在の乖離、●＝そのzに対する残余の予測値、縦線＝95%予測区間。
                    予測区間が0を跨いでいる限り、方向は当てにならない（点予測だけ見ないこと）。
                  </p>
                </>
              ) : (
                <div className="text-xs text-gray-400">この時刻は標本不足で回帰できません（条件を緩めるか60分足を選択）。</div>
              )}
            </>
          )}

          {view === "track" && (
            <>
              <div className="text-xs text-gray-600">
                <span className="font-medium text-gray-700">問い:</span>{" "}
                <span className="text-gray-500">
                  そもそも「台本」は個別の1日をどれだけ説明するのか。条件セルの各過去日について、その日を平均から抜いた
                  leave-one-out 平均パスとの相関を取った分布。ここが0付近に集中しているなら、①②の読みは平均像の話であって
                  個別日の予言ではない、と自覚して使う必要がある。
                </span>
              </div>
              <div className="relative"><canvas ref={trackRef} /></div>
              {(() => {
                const corrs = result.track.map((t) => t.corr).filter(isFinite);
                const slopes = result.track.map((t) => t.slope).filter(isFinite);
                if (corrs.length === 0) return null;
                const sorted = [...corrs].sort((a, b) => a - b);
                const med = sorted[Math.floor(sorted.length / 2)];
                const posShare = corrs.filter((c) => c > 0).length / corrs.length;
                const signShare = result.track.filter((t) => t.endSign).length / result.track.length;
                const medSlope = slopes.length ? [...slopes].sort((a, b) => a - b)[Math.floor(slopes.length / 2)] : NaN;
                return (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                      <div className="bg-gray-50 rounded p-2">
                        <div className="text-gray-500">パス相関の中央値</div>
                        <div className={`font-bold ${med > 0.3 ? "text-green-600" : med > 0 ? "text-gray-800" : "text-red-600"}`}>{med.toFixed(2)}</div>
                      </div>
                      <div className="bg-gray-50 rounded p-2">
                        <div className="text-gray-500">相関が正だった日</div>
                        <div className="font-bold text-gray-800">{fmtPct(posShare, 0)}</div>
                      </div>
                      <div className="bg-gray-50 rounded p-2">
                        <div className="text-gray-500">終端の符号一致率</div>
                        <div className={`font-bold ${signShare > 0.6 ? "text-green-600" : "text-gray-800"}`}>{fmtPct(signShare, 0)}</div>
                      </div>
                      <div className="bg-gray-50 rounded p-2">
                        <div className="text-gray-500">追随βの中央値</div>
                        <div className="font-bold text-gray-800">{isFinite(medSlope) ? medSlope.toFixed(2) : "-"}</div>
                      </div>
                    </div>
                    <p className="text-[11px] text-gray-400">
                      {med > 0.3
                        ? "パス相関の中央値が高い＝この条件の日は実際に似た形をなぞる傾向。台本の信頼度は比較的高い。"
                        : "パス相関の中央値が低い＝台本は平均像にすぎず、個別日の形はばらばら。①の乖離は『異常』ではなく通常のばらつきの範囲かもしれない。"}
                      {" 追随β＞1なら台本より値幅が大きく出る条件、＜1なら台本より鈍い条件。"}
                      {" 累積パス同士の相関は構造上0から離れやすいので、水準そのものより分布の広がりと符号一致率を重視する。"}
                    </p>
                  </>
                );
              })()}
            </>
          )}
        </>
      )}

      <IntradayCaveat extra="曜日×前夜米国ビンで母集団を二重に分割するため1セルは薄い。標本が足りないときは条件を『米国のみ』『曜日のみ』に緩める。標本の厚い60分足(約2年)を既定とする。" />

      <AnalysisGuide title="当日の実測 vs 条件付き期待パスの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"曜日と前夜米国リターンは、日本市場が寄り付く前に確定している。したがって『同じ曜日・同じ前夜米国ビンだった過去日』を束ねて作った日内累積パスは、寄り時点で先読みバイアスなしに引ける“今日の台本”になる。この分析は、その台本と当日に実際に起きた値動きを突き合わせる。台本を描くだけの分析(曜日×前夜米国ビン交互作用パス)との違いは、実測を重ねて『今日は台本どおりか、外れているか』を較正された尺度で判定し、さらに『外れているとき、そこから引けまでどう動きやすいか』まで踏み込む点にある。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>累積パス</strong>: 寄り(始値O)を基準にした時刻tまでの累積対数リターン r(t)=ln(P_t/O)。同じ日の中の値動きの形。</li>
          <li><strong>条件セル</strong>: 対象日と同じ条件(曜日/前夜米国ビン)に一致する過去日の集合。その日数がn。</li>
          <li><strong>期待パス</strong>: 条件セル内の各時刻の平均パス M(t)=平均{"{r_d(t)}"}。台本の本体。</li>
          <li><strong>分位ファン</strong>: 各時刻での過去日の実測分布(10/25/50/75/90パーセンタイル)。「今日はどこにいるか」の物差し。</li>
          <li><strong>乖離 z</strong>: z(t) = (実測r(t) − M(t)) / SD(t)。標準偏差で割ることで、ボラティリティの大きい時間帯と小さい時間帯を同じ尺度で比べられる。</li>
          <li><strong>残余リターン</strong>: R(t) = r(引け) − r(t)。時刻tから引けまでに残っている値動き。これから取りに行ける部分。</li>
          <li><strong>leave-one-out(LOO)</strong>: ある日のzを計算するとき、その日自身を平均・SDから抜くこと。自分を含む平均に自分を比べると乖離が過小評価されるため。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"期待パス: M(t) = (1/n)·Σ_{d∈セル} r_d(t)、SD(t) = √( (1/(n−1))·Σ_d (r_d(t) − M(t))² )"}</li>
          <li>{"今日の乖離: z_today(t) = (r_today(t) − M(t)) / SD(t)。今日は標本外なので全標本の M・SD をそのまま使ってよい。"}</li>
          <li>{"過去日の乖離(LOO): M_{-d}(t) = (Σ_e r_e(t) − r_d(t)) / (n−1)、SD_{-d}(t) は同様に自分を抜いた不偏標準偏差。z_d(t) = (r_d(t) − M_{-d}(t)) / SD_{-d}(t)。これにより過去日のzと今日のzが同じ土俵に乗る。"}</li>
          <li>{"残余の回帰: R_d(t) = α(t) + β(t)·z_d(t) + ε。β(t) は「乖離1σあたり、そこから引けまでに何%動くか」。"}</li>
          <li>{"今日の残余予測: R̂ = α(t) + β(t)·z_today(t)。予測区間は se_pred = σ·√(1 + 1/n + (z_today − z̄)²/Σ(z_d − z̄)²)、R̂ ± t_{0.975,n−2}·se_pred。個別日の予測なので信頼区間ではなく予測区間(1+…の項)を使う。"}</li>
          <li>{"追随度: 各過去日について corr(r_d(·), M_{-d}(·)) を時間方向に計算。追随βは r_d(t) = a + b·M_{-d}(t) の b。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"台本と役者。曜日と前夜米国から「今日はこう動きやすい」という台本(期待パス)が寄り前に配られる。①は役者(実際の値動き)が台本どおり演じているかを見る。②は「アドリブが入ったとき、そのまま話が進むのか、それとも元の筋に戻るのか」を過去の公演から調べる。③は「そもそもこの台本、役者はどれくらい守ってきたのか」を確かめる。"}</li>
          <li>{"z は「身長何cm」ではなく「同年齢の中で何σ分背が高いか」に直すのと同じ。朝と大引け前ではそもそも動く幅が違うので、生の%で比べると時間帯のクセに騙される。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>①でzが±0.5以内</strong>: 台本どおり。条件付きの平均像がそのまま今日の見通しとして使える。</li>
          <li><strong>①でパーセンタイルが上位/下位10%</strong>: 条件を踏まえてもなお異例。台本にない材料(個別ニュース等)が入っている疑い。台本ベースの判断は一旦保留するのが安全。</li>
          <li><strong>②でβ(t)&lt;0かつ★</strong>: フェード型。上振れている日は引けにかけて戻しやすい＝乖離方向と逆張り。上振れ時の利確・逆張りエントリーの根拠になる。</li>
          <li><strong>②でβ(t)&gt;0かつ★</strong>: 継続型。上振れている日はさらに伸びやすい＝乖離方向に順張り。強い日に乗る根拠になる。</li>
          <li><strong>②でβがどの時刻も非有意</strong>: 乖離に情報はない。この場合「今日は上振れている」という観察から残余について言えることは何もなく、予測値は条件平均とほぼ同義になる。ここを混同しないこと。</li>
          <li><strong>②で朝は非有意・後場だけ有意</strong>: 情報の消化に時間がかかり、後場に入ってからの乖離だけが意味を持つ条件。エントリー時刻の設計に直結する。</li>
          <li><strong>③でパス相関の中央値が低い(0付近)</strong>: 台本は平均像にすぎず、個別日はばらばらの形をなぞる。①の「乖離」は異常ではなく通常のばらつき。台本の重みを下げて読む。</li>
          <li><strong>③で終端の符号一致率が60%超</strong>: 少なくとも方向については台本が効いている。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>寄り前: 前夜米国のビンと曜日が確定した時点で台本(期待パス)を引き、その日の基本方針(買い場探しか、戻り売りか、見送りか)を決める。</li>
          <li>場中: ①で今の乖離zを確認 → ②のβ(t)がその時刻で有意なら、残余の予測と予測区間から手仕舞い/追随を判断する。「上振れ×β&lt;0★」なら利確、「上振れ×β&gt;0★」なら継続保有。</li>
          <li>③を先に確認する運用: 追随度が低い条件では①②の示唆を弱く扱う。台本の信頼度そのものを事前にチェックしてから使う。</li>
          <li>対象日を過去日に切り替えれば、「その日の朝に見えていた台本」と実際の結果を並べて目視で検証できる（先読み排除をONのまま）。判断ルールを決める前にこの目視検証を数十日ぶん回すと、過剰なルール化を防げる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"標本の薄さが最大の制約。曜日×5分位では1セルが数日規模になり、n=6の平均に今日を比べるのはノイズ対ノイズ。nを常に確認し、薄ければ条件を『米国のみ』『曜日のみ』へ緩める。②の回帰は最低でもn≥8程度が欲しい。"}</li>
          <li>{"対象日は期待パスの標本から必ず除外しているが、前夜米国ビンの分位境界は全期間の分布から引いている(ごく軽微な情報漏れ)。境界は米国リターン分布から決まり安定しているため実害は小さいが、厳密なバックテストではない。"}</li>
          <li>{"β(t)は時間ビンを総当たりで検定するためFDR補正を掛けているが、それでも条件(米国指数×ビン基準×分位×条件モード×足)を切り替えて有意なものを探せば、いずれ偶然の★が出る。条件を先に決めてから見ること。"}</li>
          <li>{"Yahoo日中足は約15分遅延。『現在地』はリアルタイムではなく、直近の確定バーまで。場中の実測は最終確定バーで打ち切って描いている(未到達の時間帯を平坦線として描かない)。"}</li>
          <li>{"半日立会(大納会等)は最終バーが早く終わるため『場中』と誤判定されることがある。"}</li>
          <li>{"③のパス相関は、累積パス同士という自己相関の強い系列の相関であり、統計的検定ではなく形の一致度の目安。水準そのものより分布の広がりと符号一致率で読む。"}</li>
          <li>{"台本は『前夜米国と曜日で説明できる部分』しか持たない。決算・指数イベント・個別材料は台本の外にあり、その日は乖離が大きく出るが、それは②の回帰が想定する乖離とは性質が違う(構造的な材料 vs ノイズ)。①のパーセンタイルが極端な日は②を適用しないほうが安全。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
