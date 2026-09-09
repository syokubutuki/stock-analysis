"use client";

// 2資産リバランス／動的配分の検証パネル。
// 「上がったほうを売って下がったほうを買うだけで儲かるのか」を、
//   ① 前提の検査（本当に逆相関か）
//   ② プレミアムの分解（理論 ½w(1−w)σ_diff² と、放置の勝者ドリフトの綱引き）
//   ③ 頻度・ウェイトの掃引
//   ④ 動的ルール（全振り型を含む）を巡回シフト・ヌルと損益分岐コストで採点
// の4層で測る。理論は app/lib/rebalance-premium.ts の冒頭と末尾の解説を参照。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeRebalance,
  DEFAULT_REBALANCE_SPEC,
  FREQ_LABEL,
  FREQ_ORDER,
  RULE_LABEL,
  RULE_ORDER,
  type RebalanceFreq,
  type RebalanceResult,
  type RebalanceSpec,
  type RuleKey,
} from "../../lib/rebalance-premium";
import AnalysisGuide from "./AnalysisGuide";
import AccessibleCanvas from "./AccessibleCanvas";
import { useAnalysisResultSummary } from "./AccordionSection";
import { CHART_COLORS, DIRECTION_COLORS } from "../../lib/chart-colors";
import { directionClass } from "./DirectionValue";

interface Props {
  prices: PricePoint[];
  ticker: string;
}

const PARTNER_PRESETS = [
  { ticker: "^N225", label: "日経225" },
  { ticker: "1306.T", label: "TOPIX(ETF)" },
  { ticker: "1615.T", label: "銀行業(ETF)" },
  { ticker: "^GSPC", label: "S&P500" },
];

const pct = (v: number, d = 2) => `${(v * 100).toFixed(d)}%`;
const spct = (v: number, d = 2) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;

function pText(p: number | null): string {
  if (p === null || Number.isNaN(p)) return "—";
  const star = p < 0.01 ? "***" : p < 0.05 ? "**" : p < 0.1 ? "*" : "";
  return `${p < 0.001 ? "<0.001" : p.toFixed(3)}${star}`;
}

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
  ctx.fillStyle = CHART_COLORS.surface; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

const CURVE_COLORS = ["#0f766e", CHART_COLORS.neutral, "#d97706", "#2563eb", "#7c3aed"];

export default function RebalancePremiumChart({ prices, ticker }: Props) {
  const [partner, setPartner] = useState("^N225");
  const [partnerInput, setPartnerInput] = useState("");
  const [partnerPrices, setPartnerPrices] = useState<PricePoint[] | null>(null);
  const [partnerName, setPartnerName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [weightA, setWeightA] = useState(DEFAULT_REBALANCE_SPEC.weightA);
  const [freq, setFreq] = useState<RebalanceFreq>(DEFAULT_REBALANCE_SPEC.freq);
  const [costBps, setCostBps] = useState(20);
  const [lookback, setLookback] = useState(DEFAULT_REBALANCE_SPEC.lookback);
  const [rule, setRule] = useState<RuleKey>("contrarian");

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true); setError(null);
      try {
        const res = await fetch(`/api/stock?ticker=${encodeURIComponent(partner)}&range=10y`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json.prices) { setError("相方の価格を取得できませんでした"); setPartnerPrices(null); }
        else { setPartnerPrices(json.prices); setPartnerName(json.name ?? partner); }
      } catch {
        if (!cancelled) { setError("通信エラー"); setPartnerPrices(null); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [partner]);

  const spec = useMemo<RebalanceSpec>(
    () => ({ ...DEFAULT_REBALANCE_SPEC, weightA, freq, costRT: costBps / 10000, lookback }),
    [weightA, freq, costBps, lookback],
  );

  const result = useMemo<RebalanceResult | null>(
    () => (partnerPrices ? computeRebalance(prices, partnerPrices, spec, rule) : null),
    [prices, partnerPrices, spec, rule],
  );

  const d = result?.decomposition ?? null;
  useAnalysisResultSummary(
    "sim-rebalance",
    d
      ? {
          status: "finding",
          direction: d.netVsBH > 0 ? "up" : "down",
          label: d.netVsBH > 0 ? "この期間はリバランス優位" : "この期間は放置優位",
        }
      : { status: "none" },
  );

  // ===== エクイティ + ウェイト + ローリングρ（横軸=日付なので lightweight-charts、3ペイン同期）=====
  const eqRef = useRef<HTMLDivElement>(null);
  const wRef = useRef<HTMLDivElement>(null);
  const rhoRef = useRef<HTMLDivElement>(null);
  const charts = useRef<{ eq: IChartApi; w: IChartApi; rho: IChartApi } | null>(null);
  const series = useRef<ISeriesApi<"Line">[]>([]);
  const hasResult = result !== null;

  useEffect(() => {
    if (!hasResult || !eqRef.current || !wRef.current || !rhoRef.current) return;
    const common = {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f5f5f5" }, horzLines: { color: "#f0f0f0" } },
      crosshair: { mode: 0 as const },
      timeScale: { timeVisible: false, secondsVisible: false },
    };
    const eq = createChart(eqRef.current, {
      ...common, width: eqRef.current.clientWidth, height: 280,
      localization: { priceFormatter: (v: number) => `${(v * 100).toFixed(0)}%` },
    });
    const w = createChart(wRef.current, {
      ...common, width: wRef.current.clientWidth, height: 130,
      localization: { priceFormatter: (v: number) => `${(v * 100).toFixed(0)}%` },
    });
    const rho = createChart(rhoRef.current, { ...common, width: rhoRef.current.clientWidth, height: 130 });
    charts.current = { eq, w, rho };

    let syncing = false;
    const all = [eq, w, rho];
    for (const from of all) {
      from.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (syncing || !range) return;
        syncing = true;
        for (const to of all) if (to !== from) to.timeScale().setVisibleLogicalRange(range);
        syncing = false;
      });
    }
    const onResize = () => {
      if (eqRef.current) eq.applyOptions({ width: eqRef.current.clientWidth });
      if (wRef.current) w.applyOptions({ width: wRef.current.clientWidth });
      if (rhoRef.current) rho.applyOptions({ width: rhoRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      eq.remove(); w.remove(); rho.remove();
      charts.current = null; series.current = [];
    };
  }, [hasResult]);

  useEffect(() => {
    const c = charts.current;
    if (!c || !result) return;
    for (const s of series.current) {
      try { c.eq.removeSeries(s); } catch { try { c.w.removeSeries(s); } catch { c.rho.removeSeries(s); } }
    }
    series.current = [];
    const added: ISeriesApi<"Line">[] = [];

    result.curves.forEach((run, i) => {
      const s = c.eq.addSeries(LineSeries, {
        color: CURVE_COLORS[i % CURVE_COLORS.length],
        lineWidth: i >= 3 ? 2 : 1,
        title: run.label,
        priceLineVisible: false,
      });
      s.setData(run.equity.map((p) => ({ time: p.time as Time, value: p.value })));
      added.push(s);
    });

    // ウェイト経路は「静的」と「選択中の動的ルール」だけ（0/1 を往復する様子を見せる）。
    // 全振りルールは10年ぶんを引くと帯に潰れるので、**静的を後に足して上へ重ねる**
    // （先に足したほうが下になる）。潰れて見えること自体が回転率の可視化でもあるため、
    // 間引きはしない。時間軸を拡大すれば個々の切り替えが読める。
    for (const [idx, run] of [result.curves[4], result.curves[3]].entries()) {
      const s = c.w.addSeries(LineSeries, {
        color: idx === 0 ? "#7c3aed" : "#2563eb",
        lineWidth: idx === 0 ? 1 : 2,
        title: idx === 0 ? "動的 w" : "静的 w",
        priceLineVisible: false,
      });
      s.setData(run.weights.map((p) => ({ time: p.time as Time, value: p.value })));
      added.push(s);
    }

    const rs = c.rho.addSeries(LineSeries, {
      color: "#0891b2", lineWidth: 2,
      title: `ローリング${result.pair.rollWindow}日ρ`, priceLineVisible: false,
    });
    rs.setData(result.rollingRho.map((p) => ({ time: p.time as Time, value: p.rho })));
    rs.createPriceLine({ price: 0, color: DIRECTION_COLORS.down, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
    added.push(rs);

    series.current = added;
    c.eq.timeScale().fitContent();
    c.w.timeScale().fitContent();
    c.rho.timeScale().fitContent();
  }, [result]);

  // ===== ウェイト掃引（横軸=ウェイトなので Canvas2D）=====
  const sweepRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = sweepRef.current;
    if (!canvas || !result) return;
    const init = initCanvas(canvas, 240);
    if (!init) return;
    const { ctx, width, height } = init;
    const rows = result.weightSweep;
    const pad = { l: 52, r: 12, t: 14, b: 32 };
    const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
    const vals = rows.flatMap((r) => [r.gRebal, r.gBH, r.gFreq, r.blended]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const span = Math.max(1e-6, hi - lo);
    const x = (w: number) => pad.l + w * iw;
    const y = (v: number) => pad.t + ih - ((v - lo) / span) * ih;

    ctx.strokeStyle = CHART_COLORS.grid; ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = lo + (span * k) / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(width - pad.r, y(v)); ctx.stroke();
      ctx.fillStyle = CHART_COLORS.ink; ctx.font = "10px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(`${(v * 100).toFixed(0)}%`, pad.l - 6, y(v) + 3);
    }
    ctx.textAlign = "center";
    for (let k = 0; k <= 5; k++) {
      const w = k / 5;
      ctx.fillStyle = CHART_COLORS.ink;
      ctx.fillText(`${(w * 100).toFixed(0)}%`, x(w), height - 12);
    }
    ctx.fillText("資産Aのウェイト w", width / 2, height - 1);

    const line = (get: (r: (typeof rows)[number]) => number, color: string, w: number, dash: number[]) => {
      ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash(dash); ctx.beginPath();
      rows.forEach((r, i) => (i === 0 ? ctx.moveTo(x(r.w), y(get(r))) : ctx.lineTo(x(r.w), y(get(r)))));
      ctx.stroke(); ctx.setLineDash([]);
    };
    line((r) => r.blended, CHART_COLORS.reference, 1, [4, 3]);
    line((r) => r.gBH, CHART_COLORS.neutral, 2, []);
    line((r) => r.gFreq, "#2563eb", 2, []);
    line((r) => r.gRebal, "#0f766e", 1, [2, 2]);

    // 選択中の w に縦線
    ctx.strokeStyle = "#7c3aed"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x(result.spec.weightA), pad.t); ctx.lineTo(x(result.spec.weightA), pad.t + ih); ctx.stroke();
    ctx.setLineDash([]);
  }, [result]);

  // ===== 巡回シフト・ヌルのヒストグラム（横軸=g なので Canvas2D）=====
  const nullRef = useRef<HTMLCanvasElement>(null);
  const selectedRow = result?.ruleRows.find((r) => r.key === rule) ?? null;
  useEffect(() => {
    const canvas = nullRef.current;
    if (!canvas || !selectedRow) return;
    const init = initCanvas(canvas, 170);
    if (!init) return;
    const { ctx, width, height } = init;
    const sample = selectedRow.nullSample;
    const pad = { l: 40, r: 12, t: 12, b: 28 };
    const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
    if (sample.length < 10) {
      ctx.fillStyle = CHART_COLORS.ink; ctx.font = "12px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("このルールはウェイトがほぼ動かないため、巡回シフト・ヌルは意味を持たない", width / 2, height / 2);
      return;
    }
    const actual = selectedRow.stats.g;
    const lo = Math.min(sample[0], actual), hi = Math.max(sample[sample.length - 1], actual);
    const span = Math.max(1e-6, hi - lo);
    const bins = 32;
    const counts = new Array(bins).fill(0);
    for (const v of sample) counts[Math.min(bins - 1, Math.floor(((v - lo) / span) * bins))]++;
    const maxC = Math.max(1, ...counts);
    const x = (v: number) => pad.l + ((v - lo) / span) * iw;

    ctx.fillStyle = "#c7d2fe";
    for (let i = 0; i < bins; i++) {
      const h = (counts[i] / maxC) * ih;
      ctx.fillRect(pad.l + (i / bins) * iw, pad.t + ih - h, iw / bins - 1, h);
    }
    ctx.strokeStyle = CHART_COLORS.axis; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, pad.t + ih); ctx.lineTo(width - pad.r, pad.t + ih); ctx.stroke();

    // 実測 g
    ctx.strokeStyle = actual >= (selectedRow.nullHi ?? 0) ? DIRECTION_COLORS.up : DIRECTION_COLORS.down;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x(actual), pad.t); ctx.lineTo(x(actual), pad.t + ih); ctx.stroke();
    ctx.fillStyle = CHART_COLORS.ink; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`実測 ${pct(actual, 1)}`, Math.min(width - 40, Math.max(40, x(actual))), pad.t - 1);
    ctx.textAlign = "left"; ctx.fillText(`${(lo * 100).toFixed(0)}%`, pad.l, height - 10);
    ctx.textAlign = "right"; ctx.fillText(`${(hi * 100).toFixed(0)}%`, width - pad.r, height - 10);
    ctx.textAlign = "center"; ctx.fillText("巡回シフト版の年率 g", width / 2, height - 1);
  }, [selectedRow]);

  if (prices.length < 200) return null;

  const p = result?.pair ?? null;
  const looksInverse = p !== null && p.rho < 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">
          2資産リバランス／動的配分：値動きそのものから超過リターンは出るか
        </h3>
      </div>

      {/* ───── 操作 ───── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs border-b border-gray-100 pb-3">
        <div className="flex items-center gap-1">
          <span className="text-fg-muted">相方(資産B)</span>
          {PARTNER_PRESETS.map((x) => (
            <button
              key={x.ticker}
              onClick={() => setPartner(x.ticker)}
              className={`px-2 py-0.5 rounded ${partner === x.ticker ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
            >
              {x.label}
            </button>
          ))}
          <input
            value={partnerInput}
            onChange={(e) => setPartnerInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && partnerInput.trim()) setPartner(partnerInput.trim()); }}
            placeholder="8306.T"
            aria-label="相方の銘柄コード"
            className="w-24 px-1.5 py-0.5 border border-gray-300 rounded"
          />
        </div>

        <label className="flex items-center gap-1">
          <span className="text-fg-muted">Aのウェイト</span>
          <input type="range" min={0} max={100} step={5} value={Math.round(weightA * 100)}
            onChange={(e) => setWeightA(Number(e.target.value) / 100)} className="w-24" />
          <span className="tabular-nums w-9">{(weightA * 100).toFixed(0)}%</span>
        </label>

        <label className="flex items-center gap-1">
          <span className="text-fg-muted">リバランス頻度</span>
          <select value={freq} onChange={(e) => setFreq(e.target.value as RebalanceFreq)}
            className="border border-gray-300 rounded px-1 py-0.5">
            {FREQ_ORDER.filter((f) => f !== "never").map((f) => (
              <option key={f} value={f}>{FREQ_LABEL[f]}</option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1">
          <span className="text-fg-muted">往復コスト</span>
          <input type="range" min={0} max={100} step={5} value={costBps}
            onChange={(e) => setCostBps(Number(e.target.value))} className="w-20" />
          <span className="tabular-nums w-12">{(costBps / 100).toFixed(2)}%</span>
        </label>

        <label className="flex items-center gap-1">
          <span className="text-fg-muted">推定窓</span>
          <select value={lookback} onChange={(e) => setLookback(Number(e.target.value))}
            className="border border-gray-300 rounded px-1 py-0.5">
            {[20, 60, 120, 252].map((v) => <option key={v} value={v}>{v}日</option>)}
          </select>
        </label>

        <label className="flex items-center gap-1">
          <span className="text-fg-muted">動的ルール</span>
          <select value={rule} onChange={(e) => setRule(e.target.value as RuleKey)}
            className="border border-gray-300 rounded px-1 py-0.5">
            {RULE_ORDER.filter((k) => k !== "static" && k !== "bh").map((k) => (
              <option key={k} value={k}>{RULE_LABEL[k]}</option>
            ))}
          </select>
        </label>
      </div>

      {loading && <div className="py-8 text-center text-sm text-fg-muted">相方の価格を取得中…</div>}
      {error && <div className="py-4 text-center text-sm text-red-600">{error}</div>}
      {!loading && !error && !result && (
        <div className="py-8 text-center text-sm text-fg-muted">2資産の共通営業日が足りません（120日以上必要）。</div>
      )}

      {result && p && d && (
        <>
          {/* ───── ① 前提の検査 ───── */}
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-gray-700">① 前提の検査：本当に逆相関か</h4>
            <div className={`rounded border p-3 text-sm ${looksInverse ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}`}>
              <p className="font-medium text-gray-800">
                {looksInverse
                  ? `日次リターンの相関は ρ=${p.rho.toFixed(3)} で負。リバランスで刈り取れる差の変動が大きい。`
                  : `日次リターンの相関は ρ=${p.rho.toFixed(3)}（正）。「逆相関」は生リターンでは成立していない。`}
              </p>
              <p className="text-xs text-gray-600 mt-1">
                資産Bが下げた日に資産Aが上げた割合は <b>{pct(p.pAUpGivenBDown, 1)}</b>
                （Bが上げた日にAも上げた割合は {pct(p.pAUpGivenBUp, 1)}）。
                ローリング{p.rollWindow}日のρが負だったのは全期間の <b>{pct(p.rhoRollNegShare, 1)}</b>（最小 {p.rhoRollMin.toFixed(3)}、直近 {p.rhoRollLast.toFixed(3)}）。
              </p>
              <p className="text-xs text-gray-600 mt-1">
                いっぽう <b>corr(A−B, B) = {p.rhoSpreadVsB.toFixed(3)}</b>。
                {p.rhoSpreadVsB < 0
                  ? `β=${p.beta.toFixed(2)}<1 なので、Bが上げる日にAは「相対的に負け」、下げる日に「相対的に勝つ」。これが逆相関に見える正体で、相対の話であってヘッジではない。`
                  : `β=${p.beta.toFixed(2)} なので相対でも同方向に動く。`}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs tabular-nums">
                <thead className="text-fg-muted border-b border-gray-200">
                  <tr>
                    <th className="text-left py-1 font-normal">資産</th>
                    <th className="text-right font-normal">年率μ(算術)</th>
                    <th className="text-right font-normal">年率σ</th>
                    <th className="text-right font-normal">幾何g</th>
                    <th className="text-right font-normal">β(vs B)</th>
                    <th className="text-right font-normal">ρ</th>
                    <th className="text-right font-normal">σ_diff</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr>
                    <td className="py-1 text-left">A: {ticker}</td>
                    <td className="text-right">{pct(p.muA, 1)}</td>
                    <td className="text-right">{pct(p.sigmaA, 1)}</td>
                    <td className="text-right font-medium">{pct(p.gA, 1)}</td>
                    <td className="text-right">{p.beta.toFixed(2)}</td>
                    <td className="text-right" rowSpan={2}>{p.rho.toFixed(3)}</td>
                    <td className="text-right font-medium" rowSpan={2}>{pct(p.sigmaDiff, 1)}</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-left">B: {partner}{partnerName ? `（${partnerName}）` : ""}</td>
                    <td className="text-right">{pct(p.muB, 1)}</td>
                    <td className="text-right">{pct(p.sigmaB, 1)}</td>
                    <td className="text-right font-medium">{pct(p.gB, 1)}</td>
                    <td className="text-right">1.00</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-fg-muted">
              {p.from} 〜 {p.to}（{p.n}営業日 / {p.years.toFixed(1)}年）。
              前日のB → 翌日のスプレッドの相関 {p.leadLagCorr.toFixed(3)}（t={p.leadLagT.toFixed(2)}）、
              スプレッドのlag1自己相関 {p.spreadAcf1.toFixed(3)}（t={p.spreadAcf1T.toFixed(2)}）。
              自己相関が負なら「上がったほうを売る」向きが、正なら順張りの向きが有利になる。
            </p>
          </section>

          {/* ───── ② プレミアムの分解 ───── */}
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-gray-700">② リバランス・プレミアムの分解：取れる分と、放置に譲る分</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs tabular-nums">
                <tbody className="divide-y divide-gray-100">
                  <tr>
                    <td className="py-1 text-left text-gray-600">単独保有の加重平均 Σw·g</td>
                    <td className="text-right w-24">{pct(d.blended)}</td>
                    <td className="text-left text-fg-muted pl-3">リバランスも放置もしなかった場合の基準</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-left text-gray-600">＋ 理論プレミアム ½·w(1−w)·σ_diff²</td>
                    <td className={`text-right ${directionClass(d.theory)}`}>{spct(d.theory)}</td>
                    <td className="text-left text-fg-muted pl-3">連続リバランスで確実に取れる分（μに依存しない）</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-left text-gray-600">＝ 毎日リバランスの実測</td>
                    <td className={`text-right ${directionClass(d.measured)}`}>{spct(d.measured)}</td>
                    <td className="text-left text-fg-muted pl-3">理論との差は離散化と高次項</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-left text-gray-600">放置の勝者ドリフト利得</td>
                    <td className={`text-right ${directionClass(d.bhDrift)}`}>{spct(d.bhDrift)}</td>
                    <td className="text-left text-fg-muted pl-3">
                      勝った側のウェイトが自然に増える分（T→∞ なら {spct(d.bhDriftAsymptotic)}）
                    </td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="py-1.5 text-left font-medium text-gray-800">毎日リバランス − 放置</td>
                    <td className={`text-right font-bold ${directionClass(d.netVsBH)}`}>{spct(d.netVsBH)}</td>
                    <td className="text-left text-fg-muted pl-3">正ならリバランスの勝ち</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className={`rounded border p-3 text-sm space-y-1.5 ${d.netVsBH > 0 ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}`}>
              <p className="font-medium text-gray-800">
                この期間（{p.years.toFixed(1)}年）の勝敗は <b className={directionClass(d.netVsBH)}>{spct(d.netVsBH)}</b> で
                {d.netVsBH > 0 ? "リバランスの勝ち" : "放置の勝ち"}。長期（T→∞）の勝敗はこれとは別に決まる。
              </p>
              <p className="text-xs text-gray-600">
                長期の条件は <span className="font-mono">½·w·σ_diff² &gt; Δg</span> ⟺ <span className="font-mono">σ_diff &gt; √(2Δg/w)</span>。
                Δg = |g_A − g_B| = <b>{pct(d.deltaG, 2)}</b>（良いほうは資産{d.better}、そのウェイトは {pct(d.better === "A" ? d.weightA : 1 - d.weightA, 0)}）なので、
                必要な σ_diff は <b>{Number.isFinite(d.sigmaDiffRequired) ? pct(d.sigmaDiffRequired, 1) : "∞"}</b>、実測は <b>{pct(p.sigmaDiff, 1)}</b>。
                {d.rebalanceWins
                  ? " 実測が必要量を上回るので、長期でもリバランスが勝つ側にある。"
                  : " 実測が必要量に届かないので、いずれ放置が上回る。"}
              </p>
              {!d.rebalanceWins && (
                <p className="text-xs text-gray-600">
                  {d.netVsBH > 0 ? (
                    <>
                      <b>いま勝っているのに長期では負ける</b>のは矛盾ではない。放置の勝者ドリフトは
                      T→∞ で {spct(d.bhDriftAsymptotic)} まで伸びるが、この期間で実現しているのはまだ
                      {" "}{spct(d.bhDrift)} だけである（指数関数の和が飽和するまでが遅い）。
                      追い越しが起きるのは保有 <b>{d.crossoverYears === null ? "—" : Number.isFinite(d.crossoverYears) ? `約${d.crossoverYears.toFixed(0)}年後` : "200年超"}</b>。
                      投資期間がそれより短いなら、実務上はこの期間の勝敗のほうを重く読んでよい。
                    </>
                  ) : (
                    <>
                      プレミアムは σ_diff の<b>2乗</b>にしか比例しない（√ が付くので必要量が急に伸びる）一方、
                      放置に譲る分は Δg に<b>比例</b>する。幾何成長率の差が少し開くだけでリバランスは割に合わなくなる。
                    </>
                  )}
                </p>
              )}
            </div>
          </section>

          {/* ───── ③ 頻度とウェイトの掃引 ───── */}
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-gray-700">③ 頻度とウェイトを掃引する</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs tabular-nums">
                <thead className="text-fg-muted border-b border-gray-200">
                  <tr>
                    <th className="text-left py-1 font-normal">頻度</th>
                    <th className="text-right font-normal">年率g(後)</th>
                    <th className="text-right font-normal">年率g(前)</th>
                    <th className="text-right font-normal">σ</th>
                    <th className="text-right font-normal">Sharpe</th>
                    <th className="text-right font-normal">最大DD</th>
                    <th className="text-right font-normal">回転/年</th>
                    <th className="text-right font-normal">vs 放置</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {result.freqRows.map((f) => (
                    <tr key={f.freq} className={f.freq === freq ? "bg-blue-50" : f.freq === "never" ? "bg-gray-50" : ""}>
                      <td className="py-1 text-left">{FREQ_LABEL[f.freq]}</td>
                      <td className="text-right font-medium">{pct(f.stats.g)}</td>
                      <td className="text-right text-fg-muted">{pct(f.stats.gGross)}</td>
                      <td className="text-right">{pct(f.stats.vol, 1)}</td>
                      <td className="text-right">{f.stats.sharpe.toFixed(2)}</td>
                      <td className="text-right">{pct(f.stats.maxDD, 1)}</td>
                      <td className="text-right">{f.stats.turnoverPerYear.toFixed(2)}</td>
                      <td className={`text-right ${directionClass(f.vsBH)}`}>{spct(f.vsBH)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="w-full">
              <AccessibleCanvas
                ref={sweepRef}
                description={`ウェイトを0から100%まで動かしたときの年率幾何成長率。毎日リバランス・${FREQ_LABEL[freq]}リバランス・放置・単独保有の加重平均の4本を比較する。選択中のウェイトは${pct(weightA, 0)}。`}
              />
            </div>
            <p className="text-[11px] text-fg-muted">
              <span style={{ color: "#0f766e" }}>■</span> 毎日リバランス（破線）／
              <span style={{ color: "#2563eb" }}>■</span> {FREQ_LABEL[freq]}リバランス／
              <span style={{ color: CHART_COLORS.neutral }}>■</span> 放置／
              <span style={{ color: CHART_COLORS.reference }}>■</span> Σw·g（破線）。
              曲線どうしの縦の隙間がリバランスの純損益で、これは w=0 と w=1 でゼロになる（混ぜていないので刈り取る差が無い）。
            </p>
          </section>

          {/* ───── ④ 動的配分ルール ───── */}
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-gray-700">④ 動的配分：その日の値動きで配分を変える</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs tabular-nums">
                <thead className="text-fg-muted border-b border-gray-200">
                  <tr>
                    <th className="text-left py-1 font-normal">ルール</th>
                    <th className="text-right font-normal">g(後)</th>
                    <th className="text-right font-normal">g(前)</th>
                    <th className="text-right font-normal">Sharpe</th>
                    <th className="text-right font-normal">回転/年</th>
                    <th className="text-right font-normal">コスト/年</th>
                    <th className="text-right font-normal">vs 静的</th>
                    <th className="text-right font-normal">JKM p</th>
                    <th className="text-right font-normal">ヌル p</th>
                    <th className="text-right font-normal">分岐コスト</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {result.ruleRows.map((r) => {
                    const be = r.breakevenCostRT;
                    const beText = Number.isNaN(be) ? "—"
                      : be === Infinity ? "∞"
                      : be < 0 ? "負け済み"
                      : `${(be * 100).toFixed(3)}%`;
                    const beClass = Number.isNaN(be) || be === Infinity ? "" : be * 10000 >= costBps ? directionClass(1) : directionClass(-1);
                    return (
                      <tr key={r.key} className={r.key === rule ? "bg-purple-50" : r.key === "static" ? "bg-gray-50" : ""}>
                        <td className="py-1 text-left" title={r.note}>{r.label}</td>
                        <td className={`text-right font-medium ${directionClass(r.stats.g)}`}>{pct(r.stats.g, 1)}</td>
                        <td className="text-right text-fg-muted">{pct(r.stats.gGross, 1)}</td>
                        <td className="text-right">{r.stats.sharpe.toFixed(2)}</td>
                        <td className="text-right">{r.stats.turnoverPerYear.toFixed(0)}</td>
                        <td className="text-right text-fg-muted">{pct(r.stats.costAnnual, 1)}</td>
                        <td className={`text-right ${directionClass(r.vsStatic)}`}>{spct(r.vsStatic, 1)}</td>
                        <td className="text-right">{pText(r.jkmP)}</td>
                        <td className="text-right">{pText(r.nullP)}</td>
                        <td className={`text-right ${beClass}`}>{beText}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-fg-muted">
              <b>g(前)</b> はコスト控除前、<b>g(後)</b> は往復{(costBps / 100).toFixed(2)}%を控除後。
              <b>JKM p</b> は静的リバランスに対する Sharpe 差の片側p。
              <b>ヌル p</b> は巡回シフト検定（ウェイト列を丸ごと時間方向に回して当て直す）の片側pで、
              小さいほど「いつ乗り換えるか」が効いている。
              <b>分岐コスト</b> はこれを超える往復コストなら静的に負ける水準。現在の設定は {(costBps / 100).toFixed(2)}%。
            </p>

            {selectedRow && (
              <div className="rounded border border-gray-200 p-3 space-y-2">
                <p className="text-xs text-gray-700">
                  <b>{selectedRow.label}</b>：{selectedRow.note}
                </p>
                <div className="w-full">
                  <AccessibleCanvas
                    ref={nullRef}
                    description={`巡回シフト・ヌルの分布と実測値の位置。実測の年率gは${pct(selectedRow.stats.g, 1)}で、ヌルの中央値は${selectedRow.nullMedian === null ? "算出不可" : pct(selectedRow.nullMedian, 1)}、片側pは${pText(selectedRow.nullP)}。`}
                  />
                </div>
                {selectedRow.nullP !== null && (
                  <p className="text-xs text-gray-600">
                    {selectedRow.nullP < 0.05
                      ? `タイミングそのものは偶然を超えている（p=${pText(selectedRow.nullP)}）。ただし手取りで静的リバランスに ${spct(selectedRow.vsStatic, 1)} なので、`
                      : `タイミングは偶然の範囲に収まる（p=${pText(selectedRow.nullP)}）。加えて手取りで ${spct(selectedRow.vsStatic, 1)} なので、`}
                    年 {selectedRow.stats.turnoverPerYear.toFixed(0)} 回転ぶんのコスト（年 {pct(selectedRow.stats.costAnnual, 1)}）を
                    {selectedRow.breakevenCostRT > costBps / 10000 ? "まだ吸収できている。" : "吸収できていない。"}
                  </p>
                )}
              </div>
            )}
          </section>

          {/* ───── 曲線 ───── */}
          <section className="space-y-1">
            <h4 className="text-sm font-semibold text-gray-700">累積対数リターン・ウェイト経路・ローリング相関</h4>
            <div ref={eqRef} className="w-full" />
            <div ref={wRef} className="w-full" />
            <div ref={rhoRef} className="w-full" />
            <p className="text-[11px] text-fg-muted">
              上段＝累積対数リターン（5本）、中段＝資産Aのウェイト（青＝静的、紫＝選択中の動的ルール）、
              下段＝ローリング{p.rollWindow}日の相関ρ。3つの時間軸は連動する。
            </p>
          </section>

          <AnalysisGuide title="リバランス・プレミアムと動的配分の詳細理論">
            <div className="space-y-3 text-xs text-gray-600 leading-relaxed">
              <p className="font-medium text-gray-700">1. 手法の概要</p>
              <p>
                2つの資産を混ぜて持ち、比率を戻し続ける（リバランスする）と、どちらか一方を持ち続けるより
                幾何成長率が高くなることがある。これを<b>リバランス・プレミアム</b>（ボラティリティ収穫、
                Shannon&rsquo;s demon）と呼ぶ。「上がったほうを売り、下がったほうを買う」という操作が、
                期待リターンの予測を一切使わずに複利を押し上げる現象である。
              </p>
              <p>
                本パネルはこれを「実在するか」ではなく<b>いくら取れるか</b>として測る。答えは
                <b>プレミアムは差のボラの2乗にしか比例せず、2資産の幾何成長率の差に対して二次的に小さい</b>
                という不等式に落ちる。さらに、比率を戻すだけでなく「その日の値動きで配分ごと切り替える」
                動的ルールを7種類同じエンジンで走らせ、回転コストと偶然の水準の両方に照らして採点する。
              </p>

              <p className="font-medium text-gray-700">2. 数式</p>
              <p>
                資産A・Bの単利リターンを r_A, r_B、対数リターンを ln(1+r) とする。ウェイト w で
                連続的にリバランスした portfolio の単利リターンは r_p = w·r_A + (1−w)·r_B、その分散は
              </p>
              <p className="font-mono text-[11px] bg-gray-50 p-2 rounded">
                σ_p(w)² = w²σ_A² + (1−w)²σ_B² + 2w(1−w)·ρ·σ_A·σ_B
              </p>
              <p>
                対数正規近似のもとで幾何成長率は g = μ − σ²/2 なので（μ は<b>算術</b>平均。ここを対数平均に
                すると σ²/2 を二重に引くことになる）、
              </p>
              <p className="font-mono text-[11px] bg-gray-50 p-2 rounded">
                g_rebal(w) = w·μ_A + (1−w)·μ_B − σ_p(w)²/2<br />
                Σw·g&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; = w·μ_A + (1−w)·μ_B − ½[w·σ_A² + (1−w)·σ_B²]
              </p>
              <p>
                差を取ると μ が完全に消える。これが「予測を使わずに取れる」ことの正体である:
              </p>
              <p className="font-mono text-[11px] bg-gray-50 p-2 rounded">
                P(w) = g_rebal(w) − Σw·g<br />
                &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;= ½[w·σ_A² + (1−w)·σ_B²] − ½·σ_p(w)²<br />
                &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;= ½·w(1−w)·[σ_A² + σ_B² − 2ρσ_Aσ_B]<br />
                &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;= <b>½·w(1−w)·σ_diff²</b>&nbsp;&nbsp;（σ_diff² = Var(r_A − r_B)）
              </p>
              <p>
                導出は代入するだけである。w·σ_A² − w²σ_A² = w(1−w)σ_A²、(1−w)σ_B² − (1−w)²σ_B² = w(1−w)σ_B²、
                残る交差項が −2w(1−w)ρσ_Aσ_B。3つをまとめると w(1−w) が括り出せて、括弧の中は
                Var(r_A − r_B) そのものになる。<b>ρ は σ_diff を経由してしか効かない。</b>
              </p>
              <p>
                いっぽう買って放置した富は、各資産が独立に複利するので
              </p>
              <p className="font-mono text-[11px] bg-gray-50 p-2 rounded">
                W_BH(T) = w·e^(g_A·T) + (1−w)·e^(g_B·T)<br />
                g_BH(T) = (1/T)·ln[w·e^(g_A·T) + (1−w)·e^(g_B·T)] ──→ max(g_A, g_B)&nbsp;&nbsp;(T→∞)
              </p>
              <p>
                指数関数の和は大きいほうに支配されるので、放置は<b>最良の1つへ収束する</b>。
                したがって g_A &gt; g_B のとき、放置がリバランスから奪う分は (1−w)·(g_A − g_B) に近づく。
                リバランスが勝つ条件は
              </p>
              <p className="font-mono text-[11px] bg-gray-50 p-2 rounded">
                ½·w(1−w)·σ_diff² &gt; (1−w)·Δg&nbsp;&nbsp;⟺&nbsp;&nbsp;<b>½·w·σ_diff² &gt; Δg</b>&nbsp;&nbsp;⟺&nbsp;&nbsp;<b>σ_diff &gt; √(2Δg/w)</b>
              </p>
              <p>
                w=0.5 なら σ_diff &gt; 2√Δg。Δg が 9% あるだけで σ_diff は 60% 必要になる。<b>√ が付くのが致命的</b>で、
                幾何成長率の差が少し開くだけで必要な差のボラは急速に手の届かない水準へ行く。
              </p>
              <p>
                動的ルールの採点は3本立てである。Sharpe 差は Jobson–Korkie–Memmel:
              </p>
              <p className="font-mono text-[11px] bg-gray-50 p-2 rounded">
                θ = (1/T)[2(1−ρ) + ½(SR_a² + SR_b² − 2·SR_a·SR_b·ρ²)],&nbsp;&nbsp;z = (SR_a − SR_b)/√θ
              </p>
              <p>
                巡回シフト・ヌルは、ルールが作ったウェイト列 w_t を乱数オフセット k で w_(t+k mod T) と回し、
                同じリターン列に当て直して g を測る操作を S 回繰り返す。周辺分布・自己相関・回転率は
                そのまま保たれ、<b>リターンとの時間対応だけ</b>が壊れるので、p = #{"{"}シフト版 ≥ 実測{"}"}/(S+1) は
                「いつ乗り換えるか」だけを問う。損益分岐コストは、コスト以外が同じなら
                g(c) ≒ g_gross − τ·c（τ=年間回転率）と1次で書けることから
                c* = (g_gross,rule − g_gross,base)/(τ_rule − τ_base) と解く。
              </p>

              <p className="font-medium text-gray-700">3. 専門用語の日本語定義</p>
              <ul className="list-disc pl-5 space-y-1">
                <li><b>幾何成長率 g</b>：複利で実際に効く年率成長率。g = μ − σ²/2。算術平均 μ より必ず小さい。</li>
                <li><b>算術平均 μ</b>：単利リターンの平均。「期待リターン」と呼ばれるのは通常こちら。</li>
                <li><b>σ_diff（差のボラ）</b>：2資産のリターンの差 r_A − r_B の標準偏差（年率）。リバランスで刈り取れる原資はこれだけ。</li>
                <li><b>リバランス・プレミアム</b>：比率を戻し続けることで得られる、単独保有の加重平均を超える分。½·w(1−w)·σ_diff²。</li>
                <li><b>ボラティリティ収穫 / Shannon&rsquo;s demon</b>：上と同じ現象の別名。μ=0 の資産と現金でも複利が伸びる例で知られる。</li>
                <li><b>勝者ドリフト</b>：放置していると勝った側のウェイトが自然に増え、結果的に最良の資産へ集中していく効果。</li>
                <li><b>回転率</b>：年間に入れ替えたウェイトの総量 Σ|Δw|/年。1 が「全額を1回入れ替えた」に相当する。</li>
                <li><b>往復コスト</b>：売って買い直すまでに払う比率。スプレッド＋手数料の合計。資産を x 入れ替えると x·c を払う。</li>
                <li><b>損益分岐コスト</b>：これを超える往復コストになると基準（静的リバランス）に負ける水準。</li>
                <li><b>巡回シフト・ヌル</b>：配分の系列を時間方向に丸ごと回して当て直す randomization 検定。回転率や偏りの有利さを打ち消し、タイミングだけを問う。</li>
                <li><b>JKM 検定</b>：2つの Sharpe 比の差が有意かを、両者の相関を織り込んで検定する方法。</li>
                <li><b>β</b>：資産Bが1%動くとき資産Aが平均何%動くか。β&lt;1 なら「Bが上げる日に相対的に負ける」。</li>
              </ul>

              <p className="font-medium text-gray-700">4. 直感的な例え</p>
              <p>
                エレベーターが2基ある建物を想像する。片方が上がるときもう片方は下がりやすいなら、
                上がったほうから降りて下がったほうに乗り換え続けることで、<b>2基の平均より高い階</b>に
                たどり着ける。これがリバランス・プレミアムである。乗り換えの回数ではなく
                <b>2基の高さの開き（σ_diff）</b>が稼ぎの源で、2基が同じ動きなら乗り換える意味は無い。
              </p>
              <p>
                ただしもう一つの事実がある。片方のエレベーターがそもそも<b>速い</b>なら、乗り換えずに
                速いほうに乗り続けたほうが高く行く。乗り換えは「速さの差 Δg」を平均へ引き戻す操作でもある。
                本パネルの中心的な結論は、<b>開きから得る分は開きの2乗、速さの差で失う分は差そのもの</b>で、
                後者のほうがずっと大きくなりやすい、ということである。
              </p>
              <p>
                動的ルールはさらに強い主張をしている。「いま速いのはどちらか」を毎日当てにいく操作だからである。
                速さ（μ）は測りにくく、乗り換えるたびに料金（コスト）を払う。年 100 回乗り換えれば
                往復 0.2% でも年 20% を先に支払う。
              </p>

              <p className="font-medium text-gray-700">5. 結果の読み方</p>
              <ul className="list-disc pl-5 space-y-1">
                <li><b>ρ が正で、Bが下げた日にAが上げた割合が 50% を大きく下回る</b>なら、「逆相関に見える」は生リターンでは成立していない。多くの場合 corr(A−B, B) が負であるだけで、これは β&lt;1 の帰結にすぎない。</li>
                <li><b>σ_diff が「必要な σ_diff」を下回る</b>なら、どんな頻度でリバランスしても長期では放置に負ける。②の緑／黄のカードが直接それを述べる。</li>
                <li><b>「毎日リバランス − 放置」が負</b>なら、この2資産では比率を戻す操作そのものが損である。頻度表の各行が放置に対してどれだけ負けているかで、頻度を上げても解決しない（＝プレミアムの問題であってコストの問題ではない）ことが読める。</li>
                <li><b>ウェイト掃引の図で曲線が交差せず放置が常に上</b>なら、どのウェイトを選んでもリバランスは勝てない。交差する点があれば、その付近のウェイトだけがリバランス有利である。</li>
                <li><b>動的ルールは「ヌル p」と「分岐コスト」を対にして読む。</b>ヌル p &lt; 0.05 かつ 分岐コスト &gt; 実際のコスト なら、タイミングに中身があり、かつ採算も合う。ヌル p &lt; 0.05 だが 分岐コスト &lt; 実際のコスト なら<b>信号は本物だが回転が多すぎて食えない</b>という状態で、これは低回転版を設計する余地がある、という読み方をする。</li>
                <li><b>「g(前)」と「g(後)」の差が大きいルール</b>は、実質的にコストとの勝負をしている。g(前) が静的を上回っていても g(後) で沈むなら、勝っているのは統計であって口座残高ではない。</li>
                <li><b>スプレッドのlag1自己相関が正</b>なら、逆張り（上がったほうを売る）は向きとして逆である。この符号を確認せずに逆張り型の動的ルールを組むと、構造的に負ける側に賭けることになる。</li>
              </ul>

              <p className="font-medium text-gray-700">6. 投資判断への活用</p>
              <ul className="list-disc pl-5 space-y-1">
                <li><b>比率を戻す運用を採るかどうか</b>：②の「必要な σ_diff」と実測 σ_diff を比べる。届かないなら、リバランスの根拠は「リターンを増やすため」ではなく「リスクを一定に保つため」に限定して採用する。σ とドローダウンは実際に下がる（③の表）ので、目的をそちらに置き換えれば運用として正当である。</li>
                <li><b>ウェイトの決め方</b>：掃引図で放置曲線が最大になる w を見る。多くの場合それは端点（＝良いほう1本）なので、分散する理由はリターンではなくσ・DDの許容度から決めることになる。</li>
                <li><b>頻度の決め方</b>：プレミアムが取れている場合に限り、頻度表の「vs 放置」が最大の行を採る。コストが効く水準まで頻度を上げると回転率の列が跳ねるので、そこが上限になる。</li>
                <li><b>動的配分に踏み込むかどうか</b>：ヌル p が全ルールで 0.05 を超えるなら、この2資産の日次の値動きに「いつ乗り換えるか」の情報は無い。踏み込まないのが正しい。逆に p が小さいルールがあるなら、<b>同じ信号を低回転で表現し直す</b>（連続配分・閾値を粗くする・保有日数を伸ばす）ことで分岐コストを実コストの上へ持ち上げられるかを検討する。</li>
                <li><b>建玉への落とし方</b>：本パネルの w は資産Aの建玉比率そのものである。採用するなら、静的リバランスの行の σ と最大DD が自分の許容範囲に入っているかを先に確認し、そのうえで頻度を決める。</li>
              </ul>

              <p className="font-medium text-gray-700">7. 注意点・限界</p>
              <ul className="list-disc pl-5 space-y-1">
                <li><b>μ も σ も過去の実現値である。</b>「必要な σ_diff」の判定は Δg の推定に依存し、Δg の標準誤差は大きい（μ の識別限界は別パネル参照）。Δg が実は 0 なら、リバランスは無条件に勝つ側へ回る。この判定は<b>点推定どうしの比較</b>であって検定ではない。</li>
                <li><b>過去の勝者は事前には分からない。</b>「放置が勝つ」という結論は、期間終了時点から振り返って言えることである。事前にどちらが速いか分からない状況では、リバランスは「賭けを分散する」という別の価値を持つ。</li>
                <li><b>g = μ − σ²/2 は対数正規近似である。</b>裾が厚い・ジャンプがある系列では誤差が出る。本パネルの「実測」列は近似ではなく実際の複利計算なので、理論と実測がずれる場合は実測を優先して読むこと。</li>
                <li><b>コストは比例モデルのみ。</b>スプレッド＋手数料を往復比率として一律に引いている。マーケットインパクト、板の薄さ、約定の滑りは入っていない。全振り型ルールの実際のコストはここより悪くなる。</li>
                <li><b>税金は入っていない。</b>実現益に課税される口座では、回転させるほど複利が削られる（別パネルの税引後比較を参照）。リバランス／動的配分は放置に対して構造的に不利になる。</li>
                <li><b>終値どうしで約定できる前提。</b>シグナルは前日終値まで、約定は当日終値としているが、実際には引け成行の滑りが乗る。日中の高安を使うルールではないので先読みは無いが、約定価格は楽観的である。</li>
                <li><b>ローリングρが一時的に負になる期間は必ずある。</b>それを見て「逆相関だ」と判断すると、期間を選んだ分だけ有利に見える。①の「負だった割合」を必ず併読すること。</li>
                <li><b>巡回シフト・ヌルはタイミングだけを問う。</b>ウェイトの平均水準が有利／不利であることは検定していない。水準の効果は静的リバランスとの差（vs 静的の列）が拾う。</li>
                <li><b>ルールのパラメータは掃引していない。</b>推定窓や z の傾きを変えれば数字は動く。ここで選べる値の中から最良を選ぶ行為自体が多重検定であり、表示している p 値はその分だけ楽観的である。</li>
              </ul>
            </div>
          </AnalysisGuide>
        </>
      )}
    </div>
  );
}
