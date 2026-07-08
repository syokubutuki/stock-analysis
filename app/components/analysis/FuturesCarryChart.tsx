"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  carryCurve,
  rollYieldSim,
  minVarianceHedgeRatio,
} from "../../lib/futures-carry";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

const PRESETS = [
  { ticker: "^N225", label: "日経225" },
  { ticker: "^GSPC", label: "S&P500" },
  { ticker: "^TPX", label: "TOPIX" },
];

// 共通日付でリターンを整合。
function alignedReturns(a: PricePoint[], b: PricePoint[]) {
  const mb = new Map(b.map((p) => [p.time, p.close]));
  const times: string[] = [];
  const ca: number[] = [];
  const cb: number[] = [];
  for (const p of a) {
    const bc = mb.get(p.time);
    if (bc != null && p.close > 0 && bc > 0) {
      times.push(p.time);
      ca.push(p.close);
      cb.push(bc);
    }
  }
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < times.length; i++) {
    ra.push(Math.log(ca[i] / ca[i - 1]));
    rb.push(Math.log(cb[i] / cb[i - 1]));
  }
  return { ra, rb };
}

export default function FuturesCarryChart({ prices }: Props) {
  const curveRef = useRef<HTMLCanvasElement>(null);
  const rollRef = useRef<HTMLDivElement>(null);
  const rollChartRef = useRef<IChartApi | null>(null);

  const [rPct, setRPct] = useState(0.5);
  const [qPct, setQPct] = useState(1.8);
  const [rollDays, setRollDays] = useState(21);

  const [benchTicker, setBenchTicker] = useState("^N225");
  const [benchPrices, setBenchPrices] = useState<PricePoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const S0 = prices.length ? prices[prices.length - 1].close : 100;
  const r = rPct / 100;
  const q = qPct / 100;

  const curve = useMemo(() => carryCurve(S0, r, q), [S0, r, q]);
  const roll = useMemo(
    () => rollYieldSim(prices, r, q, rollDays),
    [prices, r, q, rollDays]
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/stock?ticker=${encodeURIComponent(benchTicker)}&range=10y`
        );
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json.prices) {
          setError("ベンチマーク取得失敗");
          setBenchPrices(null);
        } else {
          setBenchPrices(json.prices);
        }
      } catch {
        if (!cancelled) {
          setError("通信エラー");
          setBenchPrices(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [benchTicker]);

  const hedge = useMemo(() => {
    if (!benchPrices) return null;
    const { ra, rb } = alignedReturns(prices, benchPrices);
    return minVarianceHedgeRatio(ra, rb);
  }, [prices, benchPrices]);

  // 先物カーブ Canvas
  useEffect(() => {
    const cv = curveRef.current;
    if (!cv) return;
    const R = initCanvas(cv, 220);
    if (!R) return;
    const { ctx, width, height } = R;
    const pad = { top: 16, right: 16, bottom: 30, left: 56 };
    const pw = width - pad.left - pad.right;
    const ph = height - pad.top - pad.bottom;
    const fwds = curve.points.map((p) => p.forward);
    const allV = [...fwds, S0];
    const vMin = Math.min(...allV);
    const vMax = Math.max(...allV);
    const span = vMax - vMin || 1;
    const y0 = vMin - span * 0.2;
    const y1 = vMax + span * 0.2;
    const maxM = curve.points[curve.points.length - 1].months;
    const toX = (m: number) => pad.left + (pw * m) / maxM;
    const toY = (v: number) => pad.top + ph * (1 - (v - y0) / (y1 - y0));

    ctx.strokeStyle = "#eee";
    ctx.fillStyle = "#888";
    ctx.font = "10px sans-serif";
    for (let g = 0; g <= 4; g++) {
      const yy = pad.top + (ph * g) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(width - pad.right, yy);
      ctx.stroke();
      ctx.fillText((y1 - ((y1 - y0) * g) / 4).toFixed(1), 4, yy + 3);
    }
    // スポット水平線
    ctx.strokeStyle = "#0ea5e9";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(pad.left, toY(S0));
    ctx.lineTo(width - pad.right, toY(S0));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#0284c7";
    ctx.fillText(`スポット S=${S0.toFixed(1)}`, pad.left + 4, toY(S0) - 4);

    // 先物カーブ
    const col = curve.regime === "contango" ? "#dc2626" : curve.regime === "backwardation" ? "#16a34a" : "#64748b";
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    curve.points.forEach((p, i) => {
      const x = toX(p.months),
        y = toY(p.forward);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = col;
    curve.points.forEach((p) => {
      ctx.beginPath();
      ctx.arc(toX(p.months), toY(p.forward), 3, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = "#64748b";
    [1, 6, 12, 24].forEach((m) => {
      if (m <= maxM) ctx.fillText(`${m}M`, toX(m) - 6, height - 8);
    });
  }, [curve, S0]);

  // ロールイールド累積パス
  useEffect(() => {
    if (!rollRef.current || !roll) return;
    if (rollChartRef.current) rollChartRef.current.remove();
    const chart = createChart(rollRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: rollRef.current.clientWidth,
      height: 220,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    rollChartRef.current = chart;
    const spot = chart.addSeries(LineSeries, {
      color: "#0ea5e9",
      lineWidth: 2,
      title: "現物B&H",
    });
    spot.setData(roll.path.map((d) => ({ time: d.time as Time, value: d.spotCum })));
    const fut = chart.addSeries(LineSeries, {
      color: "#dc2626",
      lineWidth: 1,
      title: "先物ロール",
    });
    fut.setData(roll.path.map((d) => ({ time: d.time as Time, value: d.futuresCum })));
    chart.timeScale().fitContent();
    const onResize = () => {
      if (rollRef.current) chart.applyOptions({ width: rollRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      rollChartRef.current = null;
    };
  }, [roll]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">先物カーブ & コスト・オブ・キャリー</h3>
      <p className="text-xs text-gray-500">
        F = S·e^((r−q)T)。r&gt;q でコンタンゴ（順ザヤ・ロールコスト）、r&lt;q でバックワーデーション。
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
        <label className="space-y-1">
          <span className="text-gray-500">金利 r = {rPct.toFixed(2)}%</span>
          <input type="range" min={0} max={6} step={0.05} value={rPct}
            onChange={(e) => setRPct(Number(e.target.value))} className="w-full" />
        </label>
        <label className="space-y-1">
          <span className="text-gray-500">保有利回り q = {qPct.toFixed(2)}%（配当等）</span>
          <input type="range" min={0} max={6} step={0.05} value={qPct}
            onChange={(e) => setQPct(Number(e.target.value))} className="w-full" />
        </label>
        <label className="space-y-1">
          <span className="text-gray-500">ロール間隔 = {rollDays}日</span>
          <input type="range" min={5} max={63} step={1} value={rollDays}
            onChange={(e) => setRollDays(Number(e.target.value))} className="w-full" />
        </label>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <Stat label="カーブ形状" value={
          curve.regime === "contango" ? "コンタンゴ" : curve.regime === "backwardation" ? "バック" : "フラット"
        } tone={curve.regime === "contango" ? "down" : curve.regime === "backwardation" ? "up" : undefined} />
        <Stat label="年率ロールイールド" value={`${((q - r) * 100).toFixed(2)}%`} tone={q - r >= 0 ? "up" : "down"} />
        {roll && <Stat label="累積ロールドラッグ" value={`${(roll.totalRollDrag * 100).toFixed(1)}%`} tone={roll.totalRollDrag > 0 ? "down" : "up"} />}
        {roll && <Stat label="年率ドラッグ" value={`${(roll.annualizedRollDrag * 100).toFixed(2)}%`} tone={roll.annualizedRollDrag > 0 ? "down" : "up"} />}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <p className="text-xs font-medium text-gray-600 mb-1">理論先物カーブ（限月別）</p>
          <canvas ref={curveRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <p className="text-xs font-medium text-gray-600 mb-1">
            ロール戦略 vs 現物バイ&ホールド（累積リターン）
          </p>
          <div ref={rollRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      {/* ヘッジ比率 */}
      <div className="border-t border-gray-100 pt-2 space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-xs font-medium text-gray-700">最小分散ヘッジ比率（先物でのヘッジ）</p>
          <div className="flex gap-1 text-xs">
            {PRESETS.map((p) => (
              <button key={p.ticker} onClick={() => setBenchTicker(p.ticker)}
                className={`px-2 py-0.5 rounded ${
                  benchTicker === p.ticker ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"
                }`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {loading && <div className="text-xs text-gray-400">ベンチマーク取得中…</div>}
        {error && <div className="text-xs text-red-500">{error}</div>}
        {hedge && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <Stat label="ヘッジ比率 h*" value={hedge.beta.toFixed(3)} />
            <Stat label="相関 ρ" value={hedge.corr.toFixed(3)} />
            <Stat label="ヘッジ有効度 ρ²" value={(hedge.hedgeEffectiveness * 100).toFixed(1) + "%"} />
            <Stat label="標本数" value={String(hedge.n)} />
          </div>
        )}
        {hedge && (
          <p className="text-xs text-gray-500">
            現物1単位に対し先物 {hedge.beta.toFixed(2)} 単位を売れば分散最小。残存リスクは
            {((1 - hedge.hedgeEffectiveness) * 100).toFixed(0)}%（ρ²で消せない分）。
          </p>
        )}
      </div>

      <AnalysisGuide title="先物・フォワードとロールイールドの詳細理論">
        <p className="font-medium text-gray-700">1. フォワード価格の決定（cost-of-carry）</p>
        <p>{"F = S·e^((r − q)·T)"}</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>S=現物価格、r=無リスク金利（借入コスト）、q=保有で得るインカム（配当利回り等）、T=満期年数。</li>
          <li>直感: 売り手は借金で現物を買い金利を払って保管、その純コストを買い手が負担する。</li>
          <li>無裁定: この式を外れると「現物買い＋先物売り」等でノーリスク益が出るため裁定で是正される。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">2. コンタンゴ / バックワーデーション</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ベーシス = 現物 − 先物。満期に向け0へ収束（convergence）。</li>
          <li>F&gt;S（r&gt;q）＝コンタンゴ。F&lt;S（r&lt;q、需給逼迫）＝バックワーデーション。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. ロールイールドの罠</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>先物は満期があるので、維持には期近を売り期先を買う「ロール」が必要。</li>
          <li>コンタンゴでは毎回高い期先を買うため負のロールイールドが累積（原油ETF・VXX等が長期で現物に負ける主因）。</li>
          <li>右チャートの「先物ロール」線が「現物B&H」線から下方乖離する分が累積ロールコスト。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 最小分散ヘッジ比率</p>
        <p>{"h* = ρ·(σ_S / σ_F) = cov(S,F)/var(F)（S を F に回帰した傾き）"}</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>現物1単位のリスクを先物 h* 単位で最小化。ヘッジ有効度 ρ² が消せる分散割合。</li>
          <li>ここでは指数を先物の代理（ヘッジ手段）として推定。個別株を指数先物でヘッジする実務に対応。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 活用と注意</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>コンタンゴが急な商品を長期保有ETFで持つと減価。トレードは短期・ロール前後の限月選択が重要。</li>
          <li>本シミュレーションはキャリーを日次連続近似したもの。実際のロールは離散で、限月間スプレッド次第で乖離する。</li>
          <li>q（保有利回り）は株では配当利回り。商品では貯蔵コストや利便性利回りが絡み符号が変わりうる。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  const c = tone === "up" ? "text-green-600" : tone === "down" ? "text-red-600" : "text-gray-800";
  return (
    <div className="p-2 rounded border border-gray-200 bg-gray-50">
      <div className="text-gray-500">{label}</div>
      <div className={`font-mono font-medium ${c}`}>{value}</div>
    </div>
  );
}
