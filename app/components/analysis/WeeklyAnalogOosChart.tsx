"use client";

// 今週の軌跡アナログの「予測力」ウォークフォワード OOS 検証(改善 A3)。
// 各週末で t 以前のデータだけからアナログ予測 ŷ を作り、実測 y と突き合わせて
// IC(情報係数)・方向的中率・分位単調性で予測力を測る。設定総当たりスキャンでは
// 試行数補正(Deflated 閾値)と PBO で多重比較の過学習を露出させる。
//
// 改善A: 上記はすべて「H日後の終値1点」の採点。予測している対象は経路なので、
// 実際に辿った経路との照合を別立てで行う——①25–75%帯の被覆率(名目50%)と帯幅、
// ②高安到達 MFE/MAE の IC・到達率・バイアス、③日次増分相関と DTW 距離の巡回シフト・ヌル比較。

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { computeUsReturns, BinScheme } from "../../lib/us-spillover-core";
import { useUsDaily } from "../../hooks/useUsDaily";
import { useAnalogWorker } from "../../hooks/useAnalogWorker";
import { OosResult, OosCatalog, OosSetting, OosPathScore } from "../../lib/weekly-analog-oos";
import { AnalogMode, DistMetric, WindowAlign, WeightMode } from "../../lib/weekly-analog";
import { UsDriverButtons, BinSchemeButtons } from "./usSpilloverShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const L_PRESETS = [5, 10, 20];
const H_PRESETS = [5, 10, 20];
const WEEKS_PRESETS = [80, 130, 200];

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

// 散布図: 横=予測 ŷ / 縦=実測 y。回帰線・原点十字・象限。
function drawScatter(ctx: CanvasRenderingContext2D, width: number, height: number, r: OosResult) {
  const ml = 48, mr = 14, mt = 16, mb = 30;
  const plotW = width - ml - mr, plotH = height - mt - mb;
  const xs = r.points.map((p) => p.yhat), ys = r.points.map((p) => p.yact);
  const mx = Math.max(0.01, ...xs.map(Math.abs)), my = Math.max(0.01, ...ys.map(Math.abs));
  const xOf = (v: number) => ml + ((v + mx) / (2 * mx)) * plotW;
  const yOf = (v: number) => mt + plotH - ((v + my) / (2 * my)) * plotH;

  // 象限の淡い塗り(第1・第3=的中, 第2・第4=外れ)
  ctx.fillStyle = "rgba(16,163,74,0.05)";
  ctx.fillRect(xOf(0), mt, plotW - (xOf(0) - ml), yOf(0) - mt); // 右上
  ctx.fillRect(ml, yOf(0), xOf(0) - ml, plotH - (yOf(0) - mt)); // 左下
  // 軸
  ctx.strokeStyle = "#cbd5e1"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(xOf(0), mt); ctx.lineTo(xOf(0), mt + plotH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ml, yOf(0)); ctx.lineTo(ml + plotW, yOf(0)); ctx.stroke();
  // 点
  for (const p of r.points) {
    const hit = Math.sign(p.yhat) === Math.sign(p.yact) && p.yhat !== 0;
    ctx.fillStyle = hit ? "rgba(37,99,235,0.55)" : "rgba(220,38,38,0.45)";
    ctx.beginPath(); ctx.arc(xOf(p.yhat), yOf(p.yact), 2.4, 0, Math.PI * 2); ctx.fill();
  }
  // 回帰線(最小二乗)
  const n = xs.length;
  const mxm = xs.reduce((s, v) => s + v, 0) / n, mym = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0, vv = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i] - mxm) * (ys[i] - mym); vv += (xs[i] - mxm) ** 2; }
  const slope = vv > 0 ? cov / vv : 0, intc = mym - slope * mxm;
  ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(xOf(-mx), yOf(intc + slope * -mx)); ctx.lineTo(xOf(mx), yOf(intc + slope * mx)); ctx.stroke();
  // ラベル
  ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("予測 ŷ（アナログ中央値）→", ml + plotW / 2, mt + plotH + 22);
  ctx.save(); ctx.translate(12, mt + plotH / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText("実測 y（H日先）→", 0, 0); ctx.restore();
  ctx.textAlign = "right"; ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif";
  ctx.fillText(`+${(my * 100).toFixed(0)}%`, ml - 4, mt + 8);
  ctx.fillText(`-${(my * 100).toFixed(0)}%`, ml - 4, mt + plotH);
}

// 五分位バケット棒: ŷ の分位ごとの実測平均。単調に右肩上がりなら予測力あり。
function drawQuintiles(ctx: CanvasRenderingContext2D, width: number, height: number, r: OosResult) {
  const ml = 44, mr = 14, mt = 16, mb = 26;
  const plotW = width - ml - mr, plotH = height - mt - mb;
  const qs = r.quintiles;
  const maxV = Math.max(0.005, ...qs.map((q) => Math.abs(q.yactMean || 0)));
  const yOf = (v: number) => mt + plotH / 2 - (v / maxV) * (plotH / 2 - 4);
  ctx.strokeStyle = "#e5e7eb"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(ml, yOf(0)); ctx.lineTo(ml + plotW, yOf(0)); ctx.stroke(); ctx.setLineDash([]);
  const bw = plotW / qs.length;
  qs.forEach((q, i) => {
    if (!isFinite(q.yactMean)) return;
    const x = ml + i * bw + bw * 0.2, w = bw * 0.6;
    const y0 = yOf(0), y1 = yOf(q.yactMean);
    ctx.fillStyle = q.yactMean >= 0 ? "rgba(37,99,235,0.6)" : "rgba(220,38,38,0.55)";
    ctx.fillRect(x, Math.min(y0, y1), w, Math.abs(y1 - y0));
    ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`Q${i + 1}`, x + w / 2, mt + plotH + 12);
    ctx.fillText(fmtPct(q.yactMean), x + w / 2, y1 + (q.yactMean >= 0 ? -3 : 11));
  });
  ctx.fillStyle = "#374151"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("予測ŷの分位 → 実測yの平均（右肩上がり＝単調＝予測力あり）", ml, 11);
}

// 改善A: 先行き m 日目ごとの帯被覆率。名目50%線からの乖離で「帯が締まりすぎ/緩すぎ」を見る。
// 棒＝被覆率、折れ線＝平均バンド幅(右軸)。被覆率は帯を広げれば簡単に上がるので幅と併読する。
function drawCoverage(ctx: CanvasRenderingContext2D, width: number, height: number, ps: OosPathScore) {
  const ml = 40, mr = 46, mt = 18, mb = 26;
  const plotW = width - ml - mr, plotH = height - mt - mb;
  const H = ps.H;
  const yOf = (v: number) => mt + plotH - v * plotH; // 0..1
  // 名目50%
  ctx.strokeStyle = "#94a3b8"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(ml, yOf(0.5)); ctx.lineTo(ml + plotW, yOf(0.5)); ctx.stroke(); ctx.setLineDash([]);
  const bw = plotW / H;
  for (let m = 1; m <= H; m++) {
    const c = ps.coverageByDay[m];
    if (!isFinite(c)) continue;
    const x = ml + (m - 1) * bw + bw * 0.22, w = bw * 0.56;
    // 名目に近いほど青、離れるほど赤
    const dev = Math.abs(c - 0.5);
    ctx.fillStyle = dev < 0.08 ? "rgba(37,99,235,0.6)" : dev < 0.15 ? "rgba(245,158,11,0.65)" : "rgba(220,38,38,0.6)";
    ctx.fillRect(x, yOf(c), w, plotH - (yOf(c) - mt));
    ctx.fillStyle = "#374151"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`${(c * 100).toFixed(0)}%`, x + w / 2, yOf(c) - 3);
    ctx.fillStyle = "#6b7280";
    ctx.fillText(`${m}日`, x + w / 2, mt + plotH + 12);
  }
  // 帯幅(右軸)
  const wMax = Math.max(0.005, ...ps.bandWidthByDay.filter((v) => isFinite(v)));
  ctx.strokeStyle = "#0f766e"; ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  for (let m = 1; m <= H; m++) {
    const w = ps.bandWidthByDay[m];
    if (!isFinite(w)) continue;
    const x = ml + (m - 0.5) * bw, y = mt + plotH - (w / wMax) * plotH * 0.9;
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = "#0f766e"; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`帯幅 最大${(wMax * 100).toFixed(1)}%`, ml + plotW + 4, mt + 8);
  ctx.fillStyle = "#9ca3af"; ctx.textAlign = "right";
  ctx.fillText("100%", ml - 4, mt + 8);
  ctx.fillText("50%", ml - 4, yOf(0.5) + 3);
  ctx.fillText("0%", ml - 4, mt + plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("予測25–75%帯が実測を包んだ割合（点線=名目50%）／ 緑線=帯幅", ml, 11);
}

// 改善A: 予測 MFE/MAE と実測の散布。45°線に乗れば「利確/損切り水準」として使える。
function drawExtremes(ctx: CanvasRenderingContext2D, width: number, height: number, r: OosResult) {
  const ml = 46, mr = 14, mt = 18, mb = 30;
  const plotW = width - ml - mr, plotH = height - mt - mb;
  const pts = r.points.filter((p) => isFinite(p.hiHat ?? NaN) && isFinite(p.hiAct ?? NaN) && isFinite(p.loHat ?? NaN) && isFinite(p.loAct ?? NaN));
  if (pts.length === 0) return;
  const all = [
    ...pts.map((p) => p.hiHat!), ...pts.map((p) => p.hiAct!),
    ...pts.map((p) => p.loHat!), ...pts.map((p) => p.loAct!),
  ];
  const mx = Math.max(0.01, ...all.map(Math.abs));
  const xOf = (v: number) => ml + ((v + mx) / (2 * mx)) * plotW;
  const yOf = (v: number) => mt + plotH - ((v + mx) / (2 * mx)) * plotH;
  // 45°線(完全較正)
  ctx.strokeStyle = "#94a3b8"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(xOf(-mx), yOf(-mx)); ctx.lineTo(xOf(mx), yOf(mx)); ctx.stroke(); ctx.setLineDash([]);
  // 軸
  ctx.strokeStyle = "#e5e7eb";
  ctx.beginPath(); ctx.moveTo(xOf(0), mt); ctx.lineTo(xOf(0), mt + plotH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ml, yOf(0)); ctx.lineTo(ml + plotW, yOf(0)); ctx.stroke();
  for (const p of pts) {
    ctx.fillStyle = "rgba(22,163,74,0.5)";
    ctx.beginPath(); ctx.arc(xOf(p.hiHat!), yOf(p.hiAct!), 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(220,38,38,0.45)";
    ctx.beginPath(); ctx.arc(xOf(p.loHat!), yOf(p.loAct!), 2.2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("予測（アナログの高安到達中央値）→", ml + plotW / 2, mt + plotH + 22);
  ctx.save(); ctx.translate(12, mt + plotH / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText("実測の高安到達 →", 0, 0); ctx.restore();
  ctx.textAlign = "left"; ctx.fillStyle = "#374151"; ctx.font = "bold 10px sans-serif";
  ctx.fillText("緑=高値到達(MFE, 利確目安) / 赤=安値到達(MAE, 損切り目安)｜点線=45°(完全較正)", ml, 11);
}

const LS_KEY = "weeklyAnalogOos.settings.v1";

export default function WeeklyAnalogOosChart({ prices }: Props) {
  const scatterRef = useRef<HTMLCanvasElement>(null);
  const quintRef = useRef<HTMLCanvasElement>(null);
  const covRef = useRef<HTMLCanvasElement>(null);
  const extRef = useRef<HTMLCanvasElement>(null);
  const [usTicker, setUsTicker] = useState("^IXIC");
  const [scheme, setScheme] = useState<BinScheme>("tercile");
  const [mode, setMode] = useState<AnalogMode>("similar");
  const [metric, setMetric] = useState<DistMetric>("euclid");
  const [align, setAlign] = useState<WindowAlign>("trailing");
  const [weight, setWeight] = useState<WeightMode>("uniform");
  const [volNorm, setVolNorm] = useState(false);
  const [L, setL] = useState(5);
  const [H, setH] = useState(5);
  const [K, setK] = useState(20);
  const [maxWeeks, setMaxWeeks] = useState(130);

  const [result, setResult] = useState<OosResult | null>(null);
  const [catalog, setCatalog] = useState<OosCatalog | null>(null);
  const [running, setRunning] = useState<null | "single" | "catalog">(null);

  // 設定の localStorage 永続化(C4)
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (s.mode) setMode(s.mode); if (s.metric) setMetric(s.metric); if (s.align) setAlign(s.align);
        if (s.weight) setWeight(s.weight); if (typeof s.volNorm === "boolean") setVolNorm(s.volNorm);
        if (s.L) setL(s.L); if (s.H) setH(s.H); if (s.K) setK(s.K); if (s.maxWeeks) setMaxWeeks(s.maxWeeks);
      } catch { /* ignore */ }
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ mode, metric, align, weight, volNorm, L, H, K, maxWeeks })); } catch { /* ignore */ }
  }, [mode, metric, align, weight, volNorm, L, H, K, maxWeeks]);

  const { prices: usPrices, loading: usLoading, error: usError } = useUsDaily(usTicker);
  const us = useMemo(() => (usPrices ? computeUsReturns(usPrices) : []), [usPrices]);
  const { run } = useAnalogWorker();

  const setting: OosSetting = useMemo(
    () => ({ mode, metric, align, L, K, weight, volNorm }),
    [mode, metric, align, L, K, weight, volNorm]
  );

  const runSingle = async () => {
    if (us.length === 0) return;
    setRunning("single"); setResult(null);
    const resp = await run({ kind: "oos", prices, us, setting, scheme, H, maxWeeks });
    setResult(resp.oos ?? null); setRunning(null);
  };
  const runCatalog = async () => {
    if (us.length === 0) return;
    setRunning("catalog"); setCatalog(null);
    const resp = await run({ kind: "catalog", prices, us, scheme, H, K, maxWeeks });
    setCatalog(resp.catalog ?? null); setRunning(null);
  };

  useEffect(() => {
    if (!scatterRef.current || !result) return;
    const init = initCanvas(scatterRef.current, 240);
    if (init) drawScatter(init.ctx, init.width, init.height, result);
  }, [result]);
  useEffect(() => {
    if (!quintRef.current || !result) return;
    const init = initCanvas(quintRef.current, 160);
    if (init) drawQuintiles(init.ctx, init.width, init.height, result);
  }, [result]);
  useEffect(() => {
    if (!covRef.current || !result?.path) return;
    const init = initCanvas(covRef.current, 180);
    if (init) drawCoverage(init.ctx, init.width, init.height, result.path);
  }, [result]);
  useEffect(() => {
    if (!extRef.current || !result?.path) return;
    const init = initCanvas(extRef.current, 240);
    if (init) drawExtremes(init.ctx, init.width, init.height, result);
  }, [result]);

  if (prices.length < 260) {
    return <div className="text-sm text-gray-500">OOS検証には約260営業日(1年)以上の履歴が必要です。</div>;
  }

  const Btn = ({ v, cur, set }: { v: number; cur: number; set: (n: number) => void }) => (
    <button onClick={() => set(v)} className={`px-2 py-0.5 rounded text-[11px] ${cur === v ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-600"}`}>{v}</button>
  );

  // 信頼度判定(IC>0 かつ CI下限>0 かつ 単調性>0)
  const icReliable = result ? result.ic > 0.03 && result.icLo > 0 : false;

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        アナログ予測に<span className="font-medium text-gray-700">本当に予測力があるか</span>を、各週末で
        「その時点までのデータだけ」から予測を作り実測と突き合わせて検証(ウォークフォワード OOS)。
        IC が 0 近辺なら、この機能は<span className="font-medium text-gray-700">先読みではなく文脈提示ツール</span>として使うのが正しい。
      </p>

      {/* 設定 */}
      <div className="inline-flex rounded overflow-hidden border border-gray-200 text-xs">
        {([["similar", "似た形"], ["usbin", "米国ビン"], ["ensemble", "アンサンブル"]] as [AnalogMode, string][]).map(([m, lbl]) => (
          <button key={m} onClick={() => setMode(m)}
            className={`px-3 py-1 font-medium ${mode === m ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-100"}`}>{lbl}</button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-600">
        <div className="flex items-center gap-1">
          <span>窓:</span>
          {([["trailing", "直近L"], ["week", "週境界"]] as [WindowAlign, string][]).map(([a, lbl]) => (
            <button key={a} onClick={() => setAlign(a)} className={`px-2 py-0.5 rounded ${align === a ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-600"}`}>{lbl}</button>
          ))}
        </div>
        {align === "trailing" && <div className="flex items-center gap-1"><span>L:</span>{L_PRESETS.map((v) => <Btn key={v} v={v} cur={L} set={setL} />)}</div>}
        <div className="flex items-center gap-1"><span>先行き H:</span>{H_PRESETS.map((v) => <Btn key={v} v={v} cur={H} set={setH} />)}</div>
        {(mode === "similar" || mode === "ensemble") && <div className="flex items-center gap-1"><span>近傍 K:</span>{[10, 20, 30].map((v) => <Btn key={v} v={v} cur={K} set={setK} />)}</div>}
        <div className="flex items-center gap-1">
          <span>距離:</span>
          {([["euclid", "ユークリッド"], ["dtw", "DTW"]] as [DistMetric, string][]).map(([m, lbl]) => (
            <button key={m} onClick={() => setMetric(m)} className={`px-2 py-0.5 rounded ${metric === m ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-600"}`}>{lbl}</button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span>重み:</span>
          {([["uniform", "等重み"], ["kernel", "カーネル"]] as [WeightMode, string][]).map(([m, lbl]) => (
            <button key={m} onClick={() => setWeight(m)} className={`px-2 py-0.5 rounded ${weight === m ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-600"}`}>{lbl}</button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={volNorm} onChange={(e) => setVolNorm(e.target.checked)} className="accent-blue-600" />σ正規化
        </label>
        <div className="flex items-center gap-1"><span>検証週数:</span>{WEEKS_PRESETS.map((v) => <Btn key={v} v={v} cur={maxWeeks} set={setMaxWeeks} />)}</div>
      </div>

      {(mode === "usbin" || mode === "ensemble") && (
        <div className="flex items-center gap-4 flex-wrap">
          <UsDriverButtons value={usTicker} onChange={setUsTicker} />
          <BinSchemeButtons value={scheme} onChange={setScheme} />
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={runSingle} disabled={running !== null || us.length === 0}
          className="px-3 py-1.5 rounded text-xs font-medium bg-indigo-600 text-white disabled:opacity-40 hover:bg-indigo-700">
          {running === "single" ? "検証中…" : "この設定で検証"}
        </button>
        <button onClick={runCatalog} disabled={running !== null || us.length === 0}
          className="px-3 py-1.5 rounded text-xs font-medium bg-gray-700 text-white disabled:opacity-40 hover:bg-gray-800">
          {running === "catalog" ? "スキャン中…" : "全設定スキャン(多重比較補正)"}
        </button>
        {usLoading && <span className="text-xs text-gray-400">米国指数を取得中…</span>}
        {usError && <span className="text-xs text-red-500">{usError}</span>}
      </div>

      {result && (
        <>
          <div className={`rounded-md border px-3 py-2 text-xs ${icReliable ? "border-green-300 bg-green-50 text-green-900" : "border-gray-300 bg-gray-50 text-gray-700"}`}>
            <span className="font-bold">IC(情報係数) {result.ic.toFixed(3)}</span>
            <span className="text-gray-500">（95%CI [{result.icLo.toFixed(3)}, {result.icHi.toFixed(3)}]）</span>
            <span className="mx-2">｜</span>
            方向的中率 <span className="font-bold">{(result.hit * 100).toFixed(0)}%</span>
            <span className="text-gray-500">（無条件 {(result.baseHit * 100).toFixed(0)}%, 差 {((result.hit - result.baseHit) * 100).toFixed(0)}pt）</span>
            <span className="mx-2">｜</span>
            分位単調性 <span className="font-bold">{result.monotone.toFixed(2)}</span>
            <span className="block mt-0.5 text-[11px]">
              予測週数 n={result.n}（実効 {result.nEff}）｜
              {icReliable
                ? <span className="text-green-700 font-medium">CI下限がプラス＝この設定は先読みに使える可能性</span>
                : <span className="text-gray-500">IC が 0 近辺／CI が 0 を跨ぐ＝先読みには使わず「文脈提示」に留める</span>}
            </span>
          </div>
          <div className="relative"><canvas ref={scatterRef} /></div>
          <div className="relative"><canvas ref={quintRef} /></div>

          {/* 改善A: 経路レベルの採点。上の IC/方向は終点1点だけの採点なので、経路そのものを別に採点する。 */}
          <div className="pt-2 border-t border-gray-200 space-y-3">
            <p className="text-xs text-gray-500">
              ここまでは<span className="font-medium text-gray-700">H日後の終値1点</span>の採点。
              しかし予測している対象は<span className="font-medium text-gray-700">経路</span>（中央値パス・25–75%帯・高安到達）で、
              「途中で沈んでから戻った週」と「一直線に上げた週」を終点採点は区別できない。以下は
              <span className="font-medium text-gray-700">実際に辿った経路</span>との照合。
            </p>
            {result.path ? (() => {
              const ps = result.path;
              const covDev = Math.abs(ps.coverage - 0.5);
              const covOk = ps.coverageLo <= 0.5 && ps.coverageHi >= 0.5; // CIが名目を含む＝較正されている
              const shapeOk = ps.shapeOk && ps.shapeCorrP < 0.05;
              const pct = (v: number, d = 0) => (isFinite(v) ? `${(v * 100).toFixed(d)}%` : "—");
              const num = (v: number, d = 3) => (isFinite(v) ? v.toFixed(d) : "—");
              return (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                    {/* ① 帯の較正 */}
                    <div className={`rounded-md border px-3 py-2 ${covOk ? "border-green-300 bg-green-50" : "border-amber-300 bg-amber-50"}`}>
                      <div className="font-medium text-gray-700">① 帯の較正</div>
                      <div className="mt-1">
                        被覆率 <span className="font-bold">{pct(ps.coverage)}</span>
                        <span className="text-gray-500">（名目50% / CI [{pct(ps.coverageLo)}, {pct(ps.coverageHi)}]）</span>
                      </div>
                      <div className="text-[11px] text-gray-600">平均バンド幅 {pct(ps.bandWidth, 1)}</div>
                      <div className="text-[11px] mt-0.5">
                        {covOk
                          ? <span className="text-green-700">CIが名目50%を含む＝帯は較正されている</span>
                          : ps.coverage > 0.5
                          ? <span className="text-amber-700">名目より広く当たる＝帯が緩い（幅を割り引いて読む）</span>
                          : <span className="text-red-700">名目より外れる＝帯が締まりすぎ・過信の元</span>}
                      </div>
                    </div>
                    {/* ② 高安の当否 */}
                    <div className="rounded-md border border-gray-300 bg-gray-50 px-3 py-2">
                      <div className="font-medium text-gray-700">② 高安(MFE/MAE)の当否</div>
                      <div className="mt-1">
                        IC <span className="text-green-700 font-bold">高値 {num(ps.mfeIC)}</span>
                        <span className="mx-1 text-gray-400">/</span>
                        <span className="text-red-700 font-bold">安値 {num(ps.maeIC)}</span>
                      </div>
                      <div className="text-[11px] text-gray-600">
                        到達率 高値 {pct(ps.mfeTouch)} / 安値 {pct(ps.maeTouch)}（較正なら≒50%）
                      </div>
                      <div className="text-[11px] text-gray-600">
                        バイアス(実測−予測) 高値 {isFinite(ps.mfeBias) ? fmtPct(ps.mfeBias) : "—"} / 安値 {isFinite(ps.maeBias) ? fmtPct(ps.maeBias) : "—"}
                      </div>
                    </div>
                    {/* ③ 形の一致 */}
                    <div className={`rounded-md border px-3 py-2 ${shapeOk ? "border-green-300 bg-green-50" : "border-gray-300 bg-gray-50"}`}>
                      <div className="font-medium text-gray-700">③ 形の一致（ヌル比較）</div>
                      {ps.shapeOk ? (
                        <>
                          <div className="mt-1">
                            増分相関 <span className="font-bold">{num(ps.shapeCorr)}</span>
                            <span className="text-gray-500">（ヌル {num(ps.shapeCorrNull)} / p={ps.shapeCorrP < 0.001 ? "<.001" : ps.shapeCorrP.toFixed(3)}）</span>
                          </div>
                          <div className="text-[11px] text-gray-600">
                            DTW距離 {num(ps.dtwDist, 2)}（ヌル {num(ps.dtwNull, 2)} / p={ps.dtwP < 0.001 ? "<.001" : ps.dtwP.toFixed(3)}）
                          </div>
                          <div className="text-[11px] mt-0.5">
                            {shapeOk
                              ? <span className="text-green-700">別の週の予測を当てるより形が合う＝経路の形に情報がある</span>
                              : <span className="text-gray-500">ヌルと区別できない＝形の先読み力はない（終点だけを見る）</span>}
                          </div>
                        </>
                      ) : <div className="text-[11px] text-gray-500 mt-1">H≧3 でのみ算出（現在 H={ps.H}）</div>}
                    </div>
                  </div>
                  <div className="text-[11px] text-gray-500">
                    経路採点の対象 n={ps.n}週｜終点採点(IC {result.ic.toFixed(3)})との食い違いに注意——
                    <span className="font-medium text-gray-700">終点が当たらなくても帯と高安が較正されていれば、ストップ幅・利確目標の設定には使える</span>。
                    逆も然り（終点だけ当たっても経路が荒ければ途中で振り落とされる）。
                  </div>
                  <div className="relative"><canvas ref={covRef} /></div>
                  <div className="relative"><canvas ref={extRef} /></div>
                  {covDev > 0.2 && (
                    <div className="text-[11px] text-red-600">
                      被覆率が名目から {(covDev * 100).toFixed(0)}pt 乖離。25–75%帯を「5割の確率で収まる範囲」として読むのは誤りになる。
                    </div>
                  )}
                </>
              );
            })() : (
              <div className="text-xs text-gray-400">経路の採点に必要な週数（8週以上）が揃いませんでした。</div>
            )}
          </div>
        </>
      )}

      {catalog && (
        <div className="space-y-2">
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            試行数 {catalog.nTrials} 設定｜最良 IC <span className="font-bold">{catalog.bestIc.toFixed(3)}</span>｜
            補正閾値 {catalog.deflatedThreshold.toFixed(3)}｜
            {catalog.bestPasses
              ? <span className="text-green-700 font-bold">最良設定は補正後も有意(過学習の可能性は低い)</span>
              : <span className="text-red-700 font-bold">最良 IC も補正閾値以下＝設定探索の見かけの当たり(過学習)</span>}
            <span className="ml-2">PBO {(catalog.pbo * 100).toFixed(0)}%</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">設定</th>
                  <th className="text-right px-2">IC</th>
                  <th className="text-right px-2">n</th>
                  <th className="text-right px-2">補正閾値超</th>
                </tr>
              </thead>
              <tbody>
                {catalog.rows.map((row, i) => (
                  <tr key={i} className="border-b border-gray-100">
                    <td className="py-1 px-2 text-gray-700">{row.label}</td>
                    <td className={`text-right px-2 font-medium tabular-nums ${row.ic > 0 ? "text-green-600" : "text-red-600"}`}>{row.ic.toFixed(3)}</td>
                    <td className="text-right px-2 text-gray-500 tabular-nums">{row.n}</td>
                    <td className="text-right px-2">{row.ic > catalog.deflatedThreshold ? <span className="text-green-600">✓</span> : <span className="text-gray-300">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!result && !catalog && running === null && (
        <div className="text-xs text-gray-400">上のボタンで検証を実行してください（設定により数秒かかります）。</div>
      )}

      <AnalysisGuide title="ウォークフォワード OOS 検証の詳細理論">
        <p className="font-medium text-gray-700">1. なぜ OOS 検証が必要か</p>
        <p>
          {"「似た形のあと上がった」は"}<strong>過去の記述</strong>{"であって、"}<strong>予測力の証拠ではない</strong>{"。アナログ一覧やフォワード分布はすべて in-sample(既に起きたことの集計)なので、そのまま先読みに使うと過信になる。ここでは各週末で『その時点までのデータだけ』から予測を作り、まだ見ていない実測と突き合わせることで、予測力を "}<strong>out-of-sample(OOS)</strong>{" に測る。候補窓のフォワードも検証時点を超えないよう制限し、未来リークを断つ。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 指標の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>IC(情報係数, Information Coefficient)</strong>: 予測 ŷ と実測 y の Spearman 順位相関 ρ。ŷ の大小と y の大小が順位として一致する度合い。<strong>IC=0.05 でも実務では有意</strong>とされるほど、市場予測では小さい値が普通。95%CI はブロック・ブートストラップ(週の系列相関に頑健)で推定。</li>
          <li><strong>方向的中率</strong>: sign(ŷ)=sign(y) の割合。ただ多数派方向を当て続けた場合の的中率(無条件ベースライン)と比較しないと意味がない。差(pt)が正で初めて価値。</li>
          <li><strong>分位単調性</strong>: ŷ を5分位に分け、各バケットの実測平均が Q1→Q5 で右肩上がりか。予測が強いほど単調。バケット順位と実測平均の Spearman で数値化(1に近いほど単調)。</li>
          <li><strong>実効週数 n_eff</strong>: フォワードが重なる週は独立でない。n_eff ≈ n / ⌈H/5⌉。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">2b. 経路レベルの採点（終点1点では足りない理由）</p>
        <p>
          {"上の IC・方向的中率・分位単調性は、すべて "}<strong>y = P(t+H)/P(t) − 1</strong>{" というH日後の終値1点だけの採点である。しかしアナログ予測が出力しているのは経路——中央値パス、25–75%帯、高値到達(MFE)/安値到達(MAE)——であって、「途中で−4%まで沈んでから+1%で終わった週」と「一直線に+1%まで上げた週」は終点採点では同点になる。だが実務では両者は全く違う: 前者ならストップに刈られて+1%を取り逃す。"}
          <strong>{"ストップ幅・利確目標・建玉を持ち堪えられるかは終点でなく経路が決める"}</strong>{"ので、経路そのものを次の3軸で採点する。"}
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>① 帯の較正（被覆率）</strong>: 各検証週の実測終値パスが、予測の25–75%帯に入っていた割合。
            {"名目は 50%（25%点と75%点の間だから）。定義は "}<strong>{"coverage = (1/N)Σ_i (1/H)Σ_{m=1..H} 1[ P25_i(m) ≤ act_i(m) ≤ P75_i(m) ]"}</strong>{"。"}
            95%CI は<strong>週ブロック・ブートストラップ</strong>（ブロック長 ≈ ⌈H/5⌉ 週＝フォワードが重なる週数）で、フォワード重複による見かけの標本増を打ち消す。
            <span className="text-red-700">帯を広げれば被覆率はいくらでも上がる</span>ので、必ず<strong>平均バンド幅</strong>と併せて読む——「被覆50%・幅3%」と「被覆50%・幅12%」では前者だけが有用。
          </li>
          <li>
            <strong>② 高安(MFE/MAE)の当否</strong>: MFE=Maximum Favorable Excursion(H日以内に到達した最大の含み益)、MAE=Maximum Adverse Excursion(同・最大の含み損)。予測値（選抜局面の高安到達中央値）と実測の
            <strong>Spearman IC</strong>、<strong>到達率</strong>（実測が予測水準に届いた割合。中央値予測が較正されていれば≒50%）、
            <strong>バイアス</strong>（実測−予測の中央値。高値側が正＝予測が控えめ、安値側が負＝予測より深く沈む）。
            <span className="font-medium">安値側のバイアスが負に大きいなら、アナログのMAEを損切り幅に使うと想定より頻繁に刈られる</span>——これは終点採点では絶対に見えない欠陥。
          </li>
          <li>
            <strong>③ 形の一致（ヌル比較）</strong>: 予測パスと実測パスをそれぞれ日次増分に直した Pearson 相関を週ごとに計算し、Fisher z 変換して平均。加えて両パスを z 化して <strong>DTW 距離</strong>（時間のズレを吸収した形の距離）。
            どちらも絶対値には意味がない——中央値パスは多数の局面を平均した平滑な対象なので、生の相関は構造的に小さくなる。そこで
            <strong>巡回シフト・ヌル</strong>と比較する: 予測パスを s 週ぶんずらして<em>別の週の実測</em>に付け替え、各系列の自己相関・重複構造は保ったまま「予測と実測の対応」だけを壊した分布を作り、実測の統計量がその外側にあるかを片側 p 値で測る。
            <strong>p&lt;0.05 なら「その週の予測はその週の実測に、他の週の実測より合っている」</strong>＝形に情報がある。
          </li>
        </ul>
        <p>
          {"3つは独立した性質で、食い違いこそが情報になる。"}<strong>{"終点IC≈0 でも帯と高安が較正されていれば、方向を張る材料にはならないがリスク管理（ストップ幅・利確目標・想定変動幅）には使える"}</strong>{"。逆に終点ICだけ高くても被覆率が名目から大きく外れていれば、25–75%帯を「5割の確率で収まる範囲」として読むのは誤りで、サイズを張る根拠にしてはいけない。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 多重比較の補正(全設定スキャン)</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>設定(モード/距離/窓/…)を総当たりして IC 最良を選ぶのは<strong>過学習</strong>。乱数でも試行数が多ければ、どれか一つは高い IC を示す。</li>
          <li><strong>補正閾値</strong>: 試行数 nTrials 個の標準正規の期待最大値 × IC の標準誤差。最良 IC がこれを超えて初めて「探索による見かけ」を否定できる(Deflated Sharpe Ratio と同発想)。</li>
          <li><strong>PBO(過学習確率, Probability of Backtest Overfitting)</strong>: 前半で最良の設定が後半では中央値を下回る割合。高いほど「選んだ設定は運」。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方と活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>IC の CI 下限がプラス</strong>かつ単調性が正＝その設定は先読みに使える可能性。サイズを張る根拠になる。</li>
          <li><strong>IC が 0 近辺／CI が 0 を跨ぐ</strong>＝先読み力はない。これは失敗ではなく、この機能を<strong>「文脈提示ツール」</strong>(今が過去のどの局面に似ているかを知る)として正しく位置づけ直す結論。</li>
          <li>全設定スキャンで「補正後も有意」な設定だけを、個別/横断ビューで使う設定として採用する。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>検証週数を増やすほど古いレジームを含む。近年だけで効くか、全期間で効くかは別問題。</li>
          <li>IC は線形順位相関。非線形な効き(極端な入口だけ効く等)は分位単調性で補って見る。</li>
          <li>取引コスト・スリッページは未考慮。IC が小さい戦略はコストで消えやすい。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
