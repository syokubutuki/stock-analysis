"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { simulateDeltaHedge } from "../../lib/delta-hedge";
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

export default function DeltaHedgeSimChart({ prices }: Props) {
  const pnlRef = useRef<HTMLDivElement>(null);
  const pnlChartRef = useRef<IChartApi | null>(null);
  const freqRef = useRef<HTMLCanvasElement>(null);

  const [ivPct, setIvPct] = useState(25);
  const [rebalance, setRebalance] = useState(1);
  const [costBps, setCostBps] = useState(5);
  const [rPct, setRPct] = useState(0.5);

  const result = useMemo(
    () =>
      simulateDeltaHedge(prices, {
        impliedSigma: ivPct / 100,
        rebalanceEvery: rebalance,
        r: rPct / 100,
        q: 0,
        cost: costBps / 10000,
      }),
    [prices, ivPct, rebalance, costBps, rPct]
  );

  // P&L + デルタ 時系列
  useEffect(() => {
    if (!pnlRef.current || !result) return;
    if (pnlChartRef.current) pnlChartRef.current.remove();
    const chart = createChart(pnlRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: pnlRef.current.clientWidth,
      height: 240,
      rightPriceScale: { visible: true, borderColor: "#e11d48" },
      leftPriceScale: { visible: true, borderColor: "#2563eb" },
      timeScale: { timeVisible: false },
    });
    pnlChartRef.current = chart;

    const pnl = chart.addSeries(LineSeries, {
      color: "#e11d48",
      lineWidth: 2,
      title: "ヘッジ後P&L",
      priceScaleId: "right",
    });
    pnl.setData(
      result.steps.map((s) => ({ time: s.time as Time, value: s.portfolioValue }))
    );
    const delta = chart.addSeries(LineSeries, {
      color: "#2563eb",
      lineWidth: 1,
      title: "デルタ",
      priceScaleId: "left",
    });
    delta.setData(
      result.steps.map((s) => ({ time: s.time as Time, value: s.delta }))
    );
    chart.timeScale().fitContent();
    const onResize = () => {
      if (pnlRef.current) chart.applyOptions({ width: pnlRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      pnlChartRef.current = null;
    };
  }, [result]);

  // リバランス頻度スキャン
  useEffect(() => {
    const cv = freqRef.current;
    if (!cv || !result || result.freqScan.length === 0) return;
    const R = initCanvas(cv, 200);
    if (!R) return;
    const { ctx, width, height } = R;
    const pad = { top: 16, right: 16, bottom: 34, left: 44 };
    const pw = width - pad.left - pad.right;
    const ph = height - pad.top - pad.bottom;
    const scan = result.freqScan;
    const maxErr = Math.max(...scan.map((s) => s.rmsError), 1e-9) * 1.15;
    const bw = (pw / scan.length) * 0.6;

    ctx.strokeStyle = "#eee";
    ctx.fillStyle = "#888";
    ctx.font = "10px sans-serif";
    for (let g = 0; g <= 4; g++) {
      const yy = pad.top + (ph * g) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(width - pad.right, yy);
      ctx.stroke();
      ctx.fillText((maxErr * (4 - g) / 4).toFixed(2), 4, yy + 3);
    }
    scan.forEach((s, i) => {
      const cx = pad.left + (pw * (i + 0.5)) / scan.length;
      const h = (s.rmsError / maxErr) * ph;
      ctx.fillStyle = s.every === rebalance ? "#dc2626" : "#93c5fd";
      ctx.fillRect(cx - bw / 2, pad.top + ph - h, bw, h);
      ctx.fillStyle = "#64748b";
      ctx.fillText(`${s.every}d`, cx - 8, height - 20);
      ctx.fillText(s.finalPnL.toFixed(1), cx - 12, height - 8);
    });
    ctx.fillStyle = "#334155";
    ctx.fillText("ヘッジ誤差RMS（下段=最終P&L）", pad.left, pad.top - 4);
  }, [result, rebalance]);

  const fmt = (v: number, d = 2) => (isFinite(v) ? v.toFixed(d) : "-");

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">デルタヘッジ・シミュレータ（ガンマ・スキャルピング）</h3>
      <p className="text-xs text-gray-500">
        実データのパス上でATMコールをロングし、Δ株ショートで日次ヘッジ。損益＝実現σとインプライドσの差で決まる。
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <label className="space-y-1">
          <span className="text-gray-500">インプライドσ = {ivPct.toFixed(1)}%</span>
          <input type="range" min={5} max={80} step={0.5} value={ivPct}
            onChange={(e) => setIvPct(Number(e.target.value))} className="w-full" />
        </label>
        <label className="space-y-1">
          <span className="text-gray-500">リバランス間隔 = {rebalance}日</span>
          <input type="range" min={1} max={21} step={1} value={rebalance}
            onChange={(e) => setRebalance(Number(e.target.value))} className="w-full" />
        </label>
        <label className="space-y-1">
          <span className="text-gray-500">取引コスト = {costBps}bps</span>
          <input type="range" min={0} max={30} step={1} value={costBps}
            onChange={(e) => setCostBps(Number(e.target.value))} className="w-full" />
        </label>
        <label className="space-y-1">
          <span className="text-gray-500">金利 r = {rPct.toFixed(2)}%</span>
          <input type="range" min={0} max={5} step={0.05} value={rPct}
            onChange={(e) => setRPct(Number(e.target.value))} className="w-full" />
        </label>
      </div>

      {!result && (
        <div className="text-xs text-gray-400">データ不足（20営業日以上必要）</div>
      )}

      {result && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <Stat label="実現σ" value={(result.realizedSigma * 100).toFixed(1) + "%"} />
            <Stat label="インプライドσ" value={(result.impliedSigma * 100).toFixed(1) + "%"}
              tone={result.realizedSigma > result.impliedSigma ? "up" : "down"} />
            <Stat label="最終P&L（ロング）" value={fmt(result.finalPnL)}
              tone={result.finalPnL >= 0 ? "up" : "down"} />
            <Stat label="プレミアム" value={fmt(result.premium)} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
            <Stat label="ガンマ項 Σ½Γ(ΔS)²" value={fmt(result.gammaPnL)} tone="up" />
            <Stat label="シータ項 ΣΘdt" value={fmt(result.thetaPnL)} tone="down" />
            <Stat label="ガンマ+シータ" value={fmt(result.gammaPnL + result.thetaPnL)}
              tone={result.gammaPnL + result.thetaPnL >= 0 ? "up" : "down"} />
          </div>

          <div className="text-xs bg-gray-50 rounded p-2">
            {result.realizedSigma > result.impliedSigma ? (
              <span className="text-green-700">
                実現σ({(result.realizedSigma * 100).toFixed(1)}%) &gt; インプライドσ({(result.impliedSigma * 100).toFixed(1)}%)
                → ロングガンマが勝ち。オプション買いのデルタヘッジは平均的にプラス。
              </span>
            ) : (
              <span className="text-red-700">
                実現σ({(result.realizedSigma * 100).toFixed(1)}%) &lt; インプライドσ({(result.impliedSigma * 100).toFixed(1)}%)
                → 動きが小さくインプライドを回収できず、時間価値で削られてマイナス。
              </span>
            )}
          </div>

          <div>
            <p className="text-xs font-medium text-gray-600 mb-1">
              ヘッジ後P&L（赤・右軸）とデルタ（青・左軸）の推移
            </p>
            <div ref={pnlRef} className="w-full rounded border border-gray-100" />
          </div>
          <div>
            <p className="text-xs font-medium text-gray-600 mb-1">
              リバランス頻度 vs ヘッジ誤差（頻度↑で誤差↓・コスト↑のトレードオフ）
            </p>
            <canvas ref={freqRef} className="w-full rounded border border-gray-100" />
          </div>
        </>
      )}

      <AnalysisGuide title="デルタヘッジとガンマ・スキャルピングの詳細理論">
        <p className="font-medium text-gray-700">1. 何をしているか</p>
        <p>
          オプションを1枚ロングし、その都度デルタ（Δ）分だけ原資産をショートして
          「方向リスクを消す」動的ヘッジを実データ上で回します。方向を消すと、残るのは
          「どれだけ動いたか（ボラティリティ）」の損益だけになります。これがオプションが
          σを売買している商品である、という核心を体感させます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 損益の分解（ガンマ・スキャルピング）</p>
        <p>{"ヘッジ後P&L ≈ Σ ½·Γ·(ΔS)² + Σ Θ·dt"}</p>
        <p>{"連続極限では ≈ ½ Σ Γ·S²·(σ_realized² − σ_implied²)·dt"}</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Γ（ガンマ）&gt;0 のロングオプションは、原資産が動くほど ½Γ(ΔS)² を稼ぐ（ガンマ項）。</li>
          <li>一方、時間経過で Θ（シータ）分の時間価値を失う（シータ項、通常マイナス）。</li>
          <li>ガンマ益がシータ損を上回る条件＝実現σ &gt; インプライドσ。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>実現σ &gt; インプライドσ の局面ではヘッジ後P&L（赤線）が右肩上がり＝ロングガンマの勝ち。</li>
          <li>逆に凪相場（実現σが小さい）ではシータ負けで右肩下がり。</li>
          <li>デルタ（青線）はコールなので0→1の間を推移。ITM化すると1に近づく。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. リバランス頻度のトレードオフ</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>頻度を上げるほど離散化によるヘッジ誤差（RMS）は小さくなる（理論の連続ヘッジに近づく）。</li>
          <li>しかし取引コストは頻度に比例して増える。最適頻度はボラとコストのバランスで決まる。</li>
          <li>コストbpsを上げると高頻度側の最終P&Lが悪化するのを確認できる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>「インプライドが割高（実現が上回らない）」と見るならショートガンマ（売り）＋デルタヘッジ。</li>
          <li>「これから大きく動く（実現がインプライドを超える）」と見るならロングガンマ。</li>
          <li>VRP（分散リスクプレミアム）分析と併用し、σの割高/割安を判断する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>単一パスのバックテストであり、将来の分布ではない。σ設定次第で結果は大きく変わる。</li>
          <li>ATMコール1枚・満期＝表示期間全体という単純化。実務は複数限月・スキューを扱う。</li>
          <li>ジャンプ（窓開け）があるとデルタヘッジは破綻的損失になりうる（連続ヘッジの前提崩れ）。</li>
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
