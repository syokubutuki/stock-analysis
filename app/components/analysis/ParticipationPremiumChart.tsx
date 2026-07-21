"use client";

// 参加の価値（株式リスクプレミアムという床）── 系C24 の検証。
//
// 「まず床だけ」: 個別銘柄選択の前に、市場に参加すること自体の価値を実測する。
// タイミング/サイジングのエッジが消えた結果、損益は参加項に畳まれる（→AxiomPlacement C24）。
//   ① 床の高さ: 実現プレミアム μ−r ± SE、t値、有意性（SE=σ/√T の壁を可視化）
//   ② 参加 vs 不参加: 時間平均成長率 g・シャープ・最大DD（床を得る対価としての谷）
//   ③ タイミング無関係の実証＋床の不安定性: エントリー時刻スイープの年率分布
// 市場代理は自前取得（分配金調整済 adjClose であるほど床の実測が正しい）。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeParticipation,
  type ParticipationResult,
} from "../../lib/participation-premium";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";

// 市場代理プリセット。1306=TOPIX連動ETF（分配金込みadjClose→総収益の床）、^N225=日経225(配当抜き)。
const PROXY_PRESETS: { id: string; label: string; note: string }[] = [
  { id: "1306", label: "TOPIX ETF (1306)", note: "分配金込み・総収益の床" },
  { id: "1321", label: "日経225 ETF (1321)", note: "分配金込み" },
  { id: "^N225", label: "日経225 指数", note: "配当抜き・床は過小" },
  { id: "^GSPC", label: "S&P500 指数", note: "米国・配当抜き" },
];

const HOLD_OPTIONS: { days: number; label: string }[] = [
  { days: 252, label: "1年" },
  { days: 756, label: "3年" },
  { days: 1260, label: "5年" },
];

const pct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;

function Stat({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "neutral";
  sub?: string;
}) {
  const c =
    tone === "good" ? "text-green-700" : tone === "bad" ? "text-red-700" : "text-gray-800";
  return (
    <div className="rounded border border-gray-200 px-2.5 py-1.5">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`text-sm font-bold font-mono ${c}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-400">{sub}</div>}
    </div>
  );
}

export default function ParticipationPremiumChart() {
  const [proxy, setProxy] = useState<string>("1306");
  const [customProxy, setCustomProxy] = useState("");
  const [rfPct, setRfPct] = useState("0");
  const [holdDays, setHoldDays] = useState(252);
  const [logScale, setLogScale] = useState(true);

  const [prices, setPrices] = useState<PricePoint[]>([]);
  const [proxyName, setProxyName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeProxy = proxy === "custom" ? customProxy.trim() : proxy;

  // 市場代理の自前取得（10年・日足）。
  useEffect(() => {
    if (!activeProxy) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/stock?ticker=${encodeURIComponent(activeProxy)}&range=10y`
        );
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json.prices || json.prices.length === 0) {
          setError(json.error || "データを取得できませんでした");
          setPrices([]);
          return;
        }
        setPrices(json.prices as PricePoint[]);
        setProxyName(json.name || activeProxy);
      } catch {
        if (!cancelled) {
          setError("取得に失敗しました");
          setPrices([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [activeProxy]);

  const holdLabel = useMemo(
    () => HOLD_OPTIONS.find((h) => h.days === holdDays)?.label ?? `${holdDays}日`,
    [holdDays]
  );

  const result = useMemo<ParticipationResult | null>(() => {
    if (prices.length === 0) return null;
    const rf = (parseFloat(rfPct) || 0) / 100;
    return computeParticipation(prices, { rf, holdDays, holdLabel });
  }, [prices, rfPct, holdDays, holdLabel]);

  // ── 参加の資産曲線（lightweight-charts：横軸=時間なので v5 標準） ──────────
  const chartContainer = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!chartContainer.current || !result) return;
    const el = chartContainer.current;
    const chart: IChartApi = createChart(el, {
      width: el.clientWidth,
      height: 260,
      layout: { background: { color: "#ffffff" }, textColor: "#374151" },
      grid: {
        vertLines: { color: "#f1f5f9" },
        horzLines: { color: "#f1f5f9" },
      },
      rightPriceScale: { mode: logScale ? 1 : 0, borderColor: "#e5e7eb" },
      timeScale: { borderColor: "#e5e7eb" },
    });
    const series = chart.addSeries(LineSeries, {
      color: "#2563eb",
      lineWidth: 2,
      priceLineVisible: false,
    });
    series.setData(
      result.equity.map((p) => ({ time: p.time as Time, value: p.value }))
    );
    // 不参加（現金＝1固定）の参照線。
    const cash = chart.addSeries(LineSeries, {
      color: "#9ca3af",
      lineWidth: 1,
      priceLineVisible: false,
      lineStyle: 2,
    });
    cash.setData(result.equity.map((p) => ({ time: p.time as Time, value: 1 })));
    chart.timeScale().fitContent();

    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
    };
  }, [result, logScale]);

  // ── エントリー時刻スイープのヒストグラム（横軸=リターンなので Canvas2D） ────
  const histCanvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = histCanvas.current;
    if (!canvas || !result) return;
    drawSweepHistogram(canvas, result);
  }, [result]);

  const p = result?.premium;
  const part = result?.participation;
  const sw = result?.sweep;

  return (
    <div className="space-y-4">
      {/* コントロール */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-gray-500">
          市場代理
          <select
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm"
          >
            {PROXY_PRESETS.map((pr) => (
              <option key={pr.id} value={pr.id}>
                {pr.label}
              </option>
            ))}
            <option value="custom">その他（コード指定）</option>
          </select>
        </label>
        {proxy === "custom" && (
          <input
            value={customProxy}
            onChange={(e) => setCustomProxy(e.target.value)}
            placeholder="例: 1475 / AAPL"
            className="px-2 py-1 border border-gray-300 rounded text-sm w-28 uppercase"
          />
        )}
        <label className="flex flex-col text-xs text-gray-500">
          無リスク金利(年率%)
          <input
            type="number"
            value={rfPct}
            onChange={(e) => setRfPct(e.target.value)}
            step="0.1"
            className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm w-20 tabular-nums"
          />
        </label>
        <label className="flex flex-col text-xs text-gray-500">
          スイープ保有
          <div className="mt-0.5 flex gap-1 bg-gray-100 rounded p-0.5">
            {HOLD_OPTIONS.map((h) => (
              <button
                key={h.days}
                onClick={() => setHoldDays(h.days)}
                className={`px-2 py-0.5 text-xs rounded ${
                  holdDays === h.days ? "bg-white text-blue-600 shadow-sm" : "text-gray-500"
                }`}
              >
                {h.label}
              </button>
            ))}
          </div>
        </label>
        {loading && <span className="text-xs text-gray-400">取得中…</span>}
      </div>

      {error && <div className="text-sm text-red-600">{error}</div>}

      {!result && !loading && !error && (
        <div className="py-8 text-center text-gray-400 text-sm">
          データが不足しています（10年・日足が必要）。
        </div>
      )}

      {result && p && part && sw && (
        <>
          {/* ① 床の高さ */}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1.5">
              ① 床の高さ（{proxyName}・実測{p.years.toFixed(1)}年）
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              <Stat
                label="実現プレミアム(年率)"
                value={pct(p.premium)}
                tone={p.premium > 0 ? "good" : "bad"}
                sub={`ドリフト${pct(p.annualDrift)} − rf${(p.rf * 100).toFixed(1)}%`}
              />
              <Stat label="±標準誤差(年率)" value={`±${(p.seAnnual * 100).toFixed(1)}%`} sub="SE=σ/√T" />
              <Stat
                label="t値(床>0)"
                value={p.tValue.toFixed(2)}
                tone={p.significant ? "good" : "neutral"}
                sub={p.significant ? "片側5%で有意" : "有意でない"}
              />
              <Stat label="片側p値" value={p.pValueOneSided.toFixed(3)} />
              <Stat label="年率ボラ" value={`${(p.annualVol * 100).toFixed(1)}%`} />
              <Stat label="観測日数" value={`${p.nDays}日`} sub={`${p.years.toFixed(1)}年`} />
            </div>
            <p className="mt-1.5 text-[11px] text-gray-500">
              床は「当てにいく対象」ではなく「居るだけで受け取る」。ただし t 値が示す通り、
              10年程度の標本では市場プレミアムでさえ有意化しにくい（SE=σ/√T の壁）。
            </p>
          </div>

          {/* ② 参加 vs 不参加 */}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1.5">
              ② 参加（買い持ち）vs 不参加（現金）
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2">
              <Stat
                label="時間平均成長率 g"
                value={pct(part.growthRate)}
                tone={part.growthRate > 0 ? "good" : "bad"}
                sub="C21: 実際に生きる成長"
              />
              <Stat label="年率リターン(幾何)" value={pct(part.annualReturn)} />
              <Stat label="シャープ(rf=0)" value={part.sharpe.toFixed(2)} />
              <Stat
                label="最大ドローダウン"
                value={pct(part.maxDrawdown)}
                tone="bad"
                sub="床を得る対価の谷"
              />
              <Stat label="累積リターン" value={pct(part.totalReturn, 0)} />
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] text-gray-500">
                青=参加（買い持ち・初期1）／灰破線=不参加（現金・1固定）。不参加は床を放棄する“最も高くつく安全”。
              </span>
              <button
                onClick={() => setLogScale((v) => !v)}
                className="text-[11px] text-gray-500 border border-gray-300 rounded px-2 py-0.5 hover:bg-gray-50"
              >
                {logScale ? "対数軸" : "線形軸"}
              </button>
            </div>
            <div ref={chartContainer} className="w-full mt-1" />
          </div>

          {/* ③ エントリー時刻スイープ */}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1.5">
              ③ エントリー時刻スイープ（{sw.holdLabel}保有・全開始点の年率リターン分布）
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-2">
              <Stat label="平均(≒床)" value={pct(sw.mean)} tone={sw.mean > 0 ? "good" : "bad"} />
              <Stat label="中央値" value={pct(sw.median)} />
              <Stat label="ばらつき(sd)" value={`${(sw.sd * 100).toFixed(1)}%`} sub="タイミングが動かす分散" />
              <Stat label="最良" value={pct(sw.max)} tone="good" />
              <Stat label="最悪" value={pct(sw.min)} tone="bad" />
              <Stat
                label="床が負の窓"
                value={`${(sw.shareNegative * 100).toFixed(0)}%`}
                tone={sw.shareNegative > 0.3 ? "bad" : "neutral"}
                sub="床は消えうる"
              />
            </div>
            <canvas ref={histCanvas} className="w-full" style={{ height: 200 }} />
            <p className="mt-1.5 text-[11px] text-gray-500">
              入口をずらしても分布の<b>平均（床）はほぼ動かず、広がる（分散）だけ</b>
              ＝タイミング否定の再確認。同時に、単一窓では床が負にもなる（
              {(sw.shareNegative * 100).toFixed(0)}%の窓）＝床は保証ではない。
              ※overlapping窓のため各点は独立でない（分布の形状把握用）。
            </p>
          </div>

          <ParticipationGuide />
          <AxiomPlacement corollaryId="C24" />
        </>
      )}
    </div>
  );
}

// ── Canvas2D ヒストグラム（CLAUDE.md の initCanvas パターン） ─────────────────
function drawSweepHistogram(canvas: HTMLCanvasElement, result: ParticipationResult) {
  const parent = canvas.parentElement;
  if (!parent) return;
  const width = parent.clientWidth;
  const height = 200;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);

  const data = result.sweep.annualized;
  if (data.length === 0) return;

  const padL = 8;
  const padR = 8;
  const padT = 12;
  const padB = 22;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const lo = Math.min(...data);
  const hi = Math.max(...data);
  const span = hi - lo || 1;
  const nBins = 40;
  const bins = new Array(nBins).fill(0);
  for (const x of data) {
    let b = Math.floor(((x - lo) / span) * nBins);
    if (b >= nBins) b = nBins - 1;
    if (b < 0) b = 0;
    bins[b]++;
  }
  const maxCount = Math.max(...bins);
  const xOf = (v: number) => padL + ((v - lo) / span) * plotW;

  // バー（負=赤系、正=緑系）
  const bw = plotW / nBins;
  for (let i = 0; i < nBins; i++) {
    const binCenter = lo + ((i + 0.5) / nBins) * span;
    const h = maxCount > 0 ? (bins[i] / maxCount) * plotH : 0;
    ctx.fillStyle = binCenter < 0 ? "#fca5a5" : "#86efac";
    ctx.fillRect(padL + i * bw, padT + plotH - h, Math.max(1, bw - 1), h);
  }

  // ゼロ線（床の分岐）
  if (lo < 0 && hi > 0) {
    const zx = xOf(0);
    ctx.strokeStyle = "#6b7280";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(zx, padT);
    ctx.lineTo(zx, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.fillText("0%", zx + 2, padT + 9);
  }

  // 平均線（床の高さ）
  const mx = xOf(result.sweep.mean);
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(mx, padT);
  ctx.lineTo(mx, padT + plotH);
  ctx.stroke();
  ctx.fillStyle = "#2563eb";
  ctx.font = "10px sans-serif";
  ctx.fillText(`平均(床) ${(result.sweep.mean * 100).toFixed(1)}%`, mx + 3, padT + 9);

  // 軸ラベル（左右端の年率）
  ctx.fillStyle = "#9ca3af";
  ctx.font = "10px sans-serif";
  ctx.fillText(`${(lo * 100).toFixed(0)}%`, padL, height - 6);
  const hiLabel = `${(hi * 100).toFixed(0)}%`;
  ctx.fillText(hiLabel, width - padR - ctx.measureText(hiLabel).width, height - 6);
  const mid = "エントリー時刻ごとの年率リターン";
  ctx.fillText(mid, padL + plotW / 2 - ctx.measureText(mid).width / 2, height - 6);
}

// ── 解説（CLAUDE.md 規約: AnalysisGuide 必須） ───────────────────────────────
function ParticipationGuide() {
  return (
    <AnalysisGuide title="参加の価値（株式プレミアムという床）の詳細理論">
      <p className="font-medium text-gray-700">1. なぜ「何を保有するか」なのか</p>
      <p>
        我々が動かせるのは建玉 q だけ。うち符号・大きさ・タイミング・保有期間は、本プロジェクトの
        前向き検証で「バイ&ホールドを超えるエッジがほぼ無い」と繰り返し示された。損益の分解定理
        E[W]=Σ E[q_i]·E[dP_i] + Σ Cov(q_i,dP_i) − E[C] で、エッジ項 Cov≈0 を代入すると、
        残るのは<b>参加項 Σ E[q_i]·E[dP_i]</b>だけ。つまり「いつ・どれだけ」ではなく
        <b>「何に・どれだけ居るか」</b>だけが期待損益を動かす。これが「初期に持って長く保有」の必然。
      </p>

      <p className="font-medium text-gray-700 mt-3">2. 数式（床の同定と有意性）</p>
      <p>{"実現プレミアム（床）= μ̂_annual − r,  μ̂_annual = mean(日次r)×252"}</p>
      <p>{"標準誤差 SE = σ_annual/√T = 252·s_daily/√N,  t = (μ̂_annual − r)/SE"}</p>
      <p>
        ドリフトの推定誤差は<b>期間 T を伸ばすことでしか縮まない</b>（Merton）。ボラは高頻度で精密に
        測れるのに、ドリフトは何十年も要る。これが「個別銘柄のドリフト差を過去実績で選ぶ」ことの
        危うさ（生存者バイアス）であり、まず頑健な床＝市場参加から据える理由。
      </p>

      <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>
          <b>①床の高さ</b>: 実現プレミアムが正で、t 値が大きい（&gt;1.65）ほど床が確か。だが10年標本
          では t が小さくなりがち＝床は「長期の構造」であって短期の保証ではない。
        </li>
        <li>
          <b>②g と最大DD</b>: 時間平均成長率 g（C21）が正なら、持ち切りで富は乗法的に育つ。最大DD は
          その床を受け取るために耐える谷＝参加の対価。
        </li>
        <li>
          <b>③スイープ</b>: 入口をずらしても<b>平均（床）は不変で、分散だけ広がる</b>＝タイミングは
          床の獲得に効かない。「床が負の窓」の割合が高いほど、単一の入口では床が消えうる。
        </li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>不参加（現金）は「床を放棄する最も高くつく安全」。まず参加すること自体を意思決定に据える。</li>
        <li>タイミングを当てにいかず、床を受け取れる範囲で早く・長く持つ（g を守る大きさに抑える）。</li>
        <li>次段は「対象の選択」を個別銘柄へ広げる前に、国・市場（＝床の源）を選ぶ問題として捉える。</li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">5. 注意点・限界（重要）</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>
          <b>床は長期・国際分散された市場でのみ頑健</b>。単一国市場は一世代にわたり床が消えうる。
          <b>日本株は 1989 末（日経≈38,900）から 2019 まで約30年、床が平ら〜負</b>だった。
          「持てば必ず床が積み上がる」ではなく、<b>対象（国・市場）の選択が床そのものを左右する</b>。
        </li>
        <li>指数（^N225 等）は配当抜きで床を過小評価する。分配金込みETF（1306等 adjClose）の方が実測は正しい。</li>
        <li>③のスイープは overlapping 窓のため各点は独立でない（有意性ではなく分布形状の把握用）。</li>
        <li>過去の実現プレミアムは将来の期待の不偏推定ではない（レジーム・バリュエーション依存）。</li>
      </ul>
    </AnalysisGuide>
  );
}
