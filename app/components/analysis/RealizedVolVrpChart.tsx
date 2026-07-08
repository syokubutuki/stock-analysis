"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { rollingOHLCVol } from "../../lib/ohlc-volatility";
import { varianceSwapAnalysis } from "../../lib/kelly-bs";
import { logReturns, normalCdf } from "../../lib/derivatives-core";
import AnalysisGuide from "./AnalysisGuide";
import StatBadge from "./StatBadge";

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

// トレーリング close-to-close 年率ボラ系列（時刻付き）。
function rollingCloseVol(prices: PricePoint[], window: number) {
  const closes = prices.map((p) => p.close);
  const out: { time: string; vol: number }[] = [];
  for (let i = window; i < closes.length; i++) {
    const seg: number[] = [];
    for (let j = i - window + 1; j <= i; j++) {
      if (closes[j - 1] > 0 && closes[j] > 0)
        seg.push(Math.log(closes[j] / closes[j - 1]));
    }
    if (seg.length < 2) continue;
    const m = seg.reduce((a, b) => a + b, 0) / seg.length;
    const v = seg.reduce((a, b) => a + (b - m) ** 2, 0) / (seg.length - 1);
    out.push({ time: prices[i].time, vol: Math.sqrt(v * 252) });
  }
  return out;
}

// Fisher-z による相関のp値（両側）。
function corrPValue(r: number, n: number): number {
  if (n < 5 || Math.abs(r) >= 1) return 1;
  const z = Math.atanh(Math.max(-0.999, Math.min(0.999, r))) * Math.sqrt(n - 3);
  return 2 * (1 - normalCdf(Math.abs(z)));
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0,
    va = 0,
    vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma,
      db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

const TERM_WINDOWS = [5, 10, 21, 42, 63, 126];

export default function RealizedVolVrpChart({ prices }: Props) {
  const tsRef = useRef<HTMLDivElement>(null);
  const tsChartRef = useRef<IChartApi | null>(null);
  const termRef = useRef<HTMLCanvasElement>(null);
  const scatterRef = useRef<HTMLCanvasElement>(null);

  const returns = useMemo(() => logReturns(prices.map((p) => p.close)), [prices]);
  const times = useMemo(() => prices.slice(1).map((p) => p.time), [prices]);

  const vs = useMemo(
    () => varianceSwapAnalysis(returns, times),
    [returns, times]
  );

  const shortVol = useMemo(() => rollingOHLCVol(prices, 10), [prices]);
  const longVol = useMemo(() => rollingOHLCVol(prices, 63), [prices]);

  // 現在のボラ・ターム構造（各窓の直近値）。
  const termStructure = useMemo(
    () =>
      TERM_WINDOWS.map((w) => {
        const s = rollingOHLCVol(prices, w);
        return { w, vol: s.length ? s[s.length - 1].est.yangZhang : 0 };
      }),
    [prices]
  );

  // ボラの平均回帰: 現在ボラ水準 x → 21日後のボラ変化 y。
  const meanRev = useMemo(() => {
    const s = rollingCloseVol(prices, 21);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i + 21 < s.length; i++) {
      xs.push(s[i].vol);
      ys.push(s[i + 21].vol - s[i].vol);
    }
    const r = pearson(xs, ys);
    return { xs, ys, r, n: xs.length, p: corrPValue(r, xs.length) };
  }, [prices]);

  // レバレッジ効果: 当日リターン と 翌日ボラ変化 の相関。
  const leverage = useMemo(() => {
    const s = rollingCloseVol(prices, 21);
    // s[i].time は prices の当日。リターン系列 returns/times に整合させる。
    const volByTime = new Map(s.map((d) => [d.time, d.vol]));
    const rr: number[] = [];
    const dv: number[] = [];
    for (let i = 0; i < times.length - 1; i++) {
      const v0 = volByTime.get(times[i]);
      const v1 = volByTime.get(times[i + 1]);
      if (v0 != null && v1 != null) {
        rr.push(returns[i]);
        dv.push(v1 - v0);
      }
    }
    const r = pearson(rr, dv);
    return { r, n: rr.length, p: corrPValue(r, rr.length) };
  }, [prices, returns, times]);

  const curRealized = shortVol.length
    ? shortVol[shortVol.length - 1].est.yangZhang
    : 0;
  const impliedVol = Math.sqrt(Math.max(0, vs.impliedVar));
  const realizedVolAnn = Math.sqrt(Math.max(0, vs.realizedVar));

  // 時系列チャート
  useEffect(() => {
    if (!tsRef.current || shortVol.length === 0) return;
    if (tsChartRef.current) tsChartRef.current.remove();
    const chart = createChart(tsRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: tsRef.current.clientWidth,
      height: 220,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    tsChartRef.current = chart;

    const sSeries = chart.addSeries(LineSeries, {
      color: "#dc2626",
      lineWidth: 1,
      title: "実現Vol(10日)",
    });
    sSeries.setData(
      shortVol.map((d) => ({ time: d.time as Time, value: d.est.yangZhang * 100 }))
    );
    const lSeries = chart.addSeries(LineSeries, {
      color: "#2563eb",
      lineWidth: 2,
      title: "実現Vol(63日)",
    });
    lSeries.setData(
      longVol.map((d) => ({ time: d.time as Time, value: d.est.yangZhang * 100 }))
    );
    chart.timeScale().fitContent();

    const onResize = () => {
      if (tsRef.current) chart.applyOptions({ width: tsRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      tsChartRef.current = null;
    };
  }, [shortVol, longVol]);

  // ターム構造 Canvas
  useEffect(() => {
    const cv = termRef.current;
    if (!cv) return;
    const R = initCanvas(cv, 200);
    if (!R) return;
    const { ctx, width, height } = R;
    const pad = { top: 16, right: 16, bottom: 30, left: 44 };
    const pw = width - pad.left - pad.right;
    const ph = height - pad.top - pad.bottom;
    const vols = termStructure.map((t) => t.vol * 100);
    const maxV = Math.max(...vols, 1) * 1.15;
    const toX = (i: number) => pad.left + (pw * i) / (termStructure.length - 1);
    const toY = (v: number) => pad.top + ph * (1 - v / maxV);

    ctx.strokeStyle = "#eee";
    ctx.fillStyle = "#888";
    ctx.font = "10px sans-serif";
    for (let g = 0; g <= 4; g++) {
      const yy = pad.top + (ph * g) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(width - pad.right, yy);
      ctx.stroke();
      ctx.fillText(((maxV * (4 - g)) / 4).toFixed(0) + "%", 4, yy + 3);
    }
    ctx.strokeStyle = "#7c3aed";
    ctx.lineWidth = 2;
    ctx.beginPath();
    termStructure.forEach((t, i) => {
      const x = toX(i),
        y = toY(t.vol * 100);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = "#7c3aed";
    termStructure.forEach((t, i) => {
      ctx.beginPath();
      ctx.arc(toX(i), toY(t.vol * 100), 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#64748b";
      ctx.fillText(`${t.w}d`, toX(i) - 8, height - pad.bottom + 14);
      ctx.fillStyle = "#7c3aed";
    });
  }, [termStructure]);

  // 平均回帰 scatter
  useEffect(() => {
    const cv = scatterRef.current;
    if (!cv || meanRev.xs.length < 3) return;
    const R = initCanvas(cv, 220);
    if (!R) return;
    const { ctx, width, height } = R;
    const pad = { top: 16, right: 16, bottom: 30, left: 44 };
    const pw = width - pad.left - pad.right;
    const ph = height - pad.top - pad.bottom;
    const xs = meanRev.xs.map((v) => v * 100);
    const ys = meanRev.ys.map((v) => v * 100);
    const xMin = Math.min(...xs),
      xMax = Math.max(...xs);
    const yMin = Math.min(...ys),
      yMax = Math.max(...ys);
    const toX = (v: number) =>
      pad.left + ((v - xMin) / (xMax - xMin || 1)) * pw;
    const toY = (v: number) =>
      pad.top + ph * (1 - (v - yMin) / (yMax - yMin || 1));

    ctx.strokeStyle = "#eee";
    for (let g = 0; g <= 4; g++) {
      const yy = pad.top + (ph * g) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(width - pad.right, yy);
      ctx.stroke();
    }
    if (yMin < 0 && yMax > 0) {
      ctx.strokeStyle = "#cbd5e1";
      ctx.beginPath();
      ctx.moveTo(pad.left, toY(0));
      ctx.lineTo(width - pad.right, toY(0));
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(37,99,235,0.5)";
    for (let i = 0; i < xs.length; i++) {
      ctx.beginPath();
      ctx.arc(toX(xs[i]), toY(ys[i]), 2, 0, Math.PI * 2);
      ctx.fill();
    }
    // 回帰線
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let cov = 0,
      vx = 0;
    for (let i = 0; i < xs.length; i++) {
      cov += (xs[i] - mx) * (ys[i] - my);
      vx += (xs[i] - mx) ** 2;
    }
    const slope = vx > 0 ? cov / vx : 0;
    const intc = my - slope * mx;
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(toX(xMin), toY(slope * xMin + intc));
    ctx.lineTo(toX(xMax), toY(slope * xMax + intc));
    ctx.stroke();
    ctx.fillStyle = "#888";
    ctx.font = "10px sans-serif";
    ctx.fillText("現在ボラ水準(%) →", pad.left, height - 6);
    ctx.save();
    ctx.translate(12, pad.top + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("21日後のボラ変化(%)", -40, 0);
    ctx.restore();
  }, [meanRev]);

  const pct = (v: number) => (v * 100).toFixed(1) + "%";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">実現ボラティリティ & 分散リスクプレミアム(VRP)</h3>
      <p className="text-xs text-gray-500">
        市場IVデータが無いため、インプライドはGARCH予測分散で代用。VRP = 予測分散 − 実現分散。
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <Stat label="実現Vol(直近10日,YZ)" value={pct(curRealized)} />
        <Stat label="実現Vol(全期間)" value={pct(realizedVolAnn)} />
        <Stat label="GARCH予測Vol" value={pct(impliedVol)} />
        <Stat
          label="VRP"
          value={`${(vs.varianceRiskPremium * 10000).toFixed(1)} bps²`}
          tone={vs.varianceRiskPremium > 0 ? "up" : "down"}
        />
      </div>

      <div>
        <p className="text-xs font-medium text-gray-600 mb-1">
          実現ボラの時系列（短期10日 vs 長期63日。短期が長期を上回る＝ストレス局面）
        </p>
        <div ref={tsRef} className="w-full rounded border border-gray-100" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <p className="text-xs font-medium text-gray-600 mb-1">
            現在のボラ・ターム構造（窓幅別、VIX風）
          </p>
          <canvas ref={termRef} className="w-full rounded border border-gray-100" />
        </div>
        <div>
          <div className="flex items-center gap-2 mb-1">
            <p className="text-xs font-medium text-gray-600">ボラの平均回帰</p>
            <StatBadge n={meanRev.n} p={meanRev.p} significant={meanRev.p < 0.05} />
          </div>
          <canvas ref={scatterRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      <div className="text-xs bg-gray-50 rounded p-2 flex items-center gap-2 flex-wrap">
        <span className="font-medium text-gray-700">レバレッジ効果:</span>
        <span>当日リターン × 翌日ボラ変化の相関 r = {leverage.r.toFixed(3)}</span>
        <StatBadge n={leverage.n} p={leverage.p} significant={leverage.p < 0.05} />
        <span className="text-gray-500">
          （負なら「下落→ボラ上昇」の非対称性。VIXが株価と逆相関する理由）
        </span>
      </div>

      <AnalysisGuide title="実現ボラ・VRP・ボラ商品の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          ボラティリティ（変動の大きさ）そのものを分析します。オプションやVIX等の
          「ボラティリティ商品」は方向ではなく変動幅を売買するため、実現ボラの水準・
          期間構造・平均回帰・株価との非対称性を理解することが要になります。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 実現ボラ推定量（Yang-Zhang）</p>
        <p>
          終値だけを使うclose-to-close法は1日1点で分散が大きい。高値・安値・始値も使う
          Yang-Zhang推定量は、オーバーナイトギャップ＋日中変動＋Rogers-Satchellを組み合わせ、
          同じσをより少ない分散で推定できます（日足で最推奨）。年率化は √252 倍。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 分散リスクプレミアム(VRP)</p>
        <p>{"VRP = E[σ²]（インプライド分散） − 実現分散"}</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>本来は市場オプションから逆算したインプライド分散を使うが、データが無いためGARCH予測分散で代用。</li>
          <li>長期的にインプライド &gt; 実現（VRP&gt;0）が常態＝「保険料」を払う人が多い→ボラ売りが平均的に儲かる。</li>
          <li>ただし稀な暴落で大損（「ブルドーザーの前で小銭拾い」）。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. VIXとボラ商品</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>VIXは全ストライクのOTMオプションから算出するモデルフリーの30日期待ボラ（≒分散スワップレート）。</li>
          <li>性質: 株価と強い逆相関・平均回帰的・クラスタリング（高ボラは続く）。本チャートの平均回帰散布とレバレッジ相関で追体験できる。</li>
          <li>VXX等のボラETFはVIX先物のコンタンゴでロールコストが累積し長期減価（先物カーブ分析を参照）。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方・活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>短期ボラが長期ボラを大きく上回る＝ストレス。反落後の平均回帰を狙える。</li>
          <li>平均回帰散布の傾きが負＝高ボラは下がりやすい/低ボラは上がりやすい（ボラの逆張り根拠）。</li>
          <li>VRPが大きく正＝オプション売り妙味だがテールに注意。負＝ボラが予想超で実現、売りは危険。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>GARCH予測は真のインプライドではない。実際の市場VRPはスキュー込みでより大きくなりやすい。</li>
          <li>相関の有意性は自己相関のあるボラ系列では過大評価されがち。バッジは目安。</li>
          <li>ボラ商品はロールコストとテールリスクを理解せず触ると危険（ショートボラの一発退場例=2018 Volmageddon）。</li>
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
