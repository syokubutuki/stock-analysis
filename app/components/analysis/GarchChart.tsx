"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { fitGarch, analyzeLeverage, detectJumps } from "../../lib/garch";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function GarchChart({ prices, seriesMode }: Props) {
  const volRef = useRef<HTMLDivElement>(null);
  const leverageCanvasRef = useRef<HTMLCanvasElement>(null);
  const jumpRef = useRef<HTMLDivElement>(null);
  const volChartRef = useRef<IChartApi | null>(null);
  const jumpChartRef = useRef<IChartApi | null>(null);

  const { values: lr, times: lrTimes } = extractSeries(prices, seriesMode);

  const garch = useMemo(() => fitGarch(lr), [prices, seriesMode]);
  const leverage = useMemo(() => analyzeLeverage(lr), [prices, seriesMode]);
  const jumps = useMemo(() => detectJumps(lr), [prices, seriesMode]);

  // GARCH conditional volatility chart
  useEffect(() => {
    if (!volRef.current) return;
    if (volChartRef.current) volChartRef.current.remove();

    const chart = createChart(volRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: volRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    volChartRef.current = chart;

    const retSeries = chart.addSeries(HistogramSeries, {
      color: "#94a3b8",
      title: "log return",
    });
    retSeries.setData(
      lr.map((v, i) => ({
        time: lrTimes[i] as Time,
        value: v,
        color: v >= 0 ? "#22c55e40" : "#ef444440",
      }))
    );

    const volSeries = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 2,
      title: "GARCH σ(t)",
    });
    volSeries.setData(
      garch.conditionalVol.map((v, i) => ({ time: lrTimes[i] as Time, value: v }))
    );

    const negVolSeries = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 2,
      title: "-σ(t)",
    });
    negVolSeries.setData(
      garch.conditionalVol.map((v, i) => ({ time: lrTimes[i] as Time, value: -v }))
    );

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (volRef.current) chart.applyOptions({ width: volRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); volChartRef.current = null; };
  }, [prices, garch]);

  // News Impact Curve (leverage effect)
  useEffect(() => {
    const canvas = leverageCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = 300;
    const height = 200;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { left: 45, right: 10, top: 15, bottom: 25 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const curve = leverage.newsImpactCurve;
    if (curve.length === 0) return;

    const xMin = Math.min(...curve.map((c) => c.ret));
    const xMax = Math.max(...curve.map((c) => c.ret));
    const yMax = Math.max(...curve.map((c) => c.vol));
    const xRange = xMax - xMin || 1;
    const yRange = yMax || 1;

    // Axes
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top);
    ctx.lineTo(margin.left, margin.top + plotH);
    ctx.lineTo(margin.left + plotW, margin.top + plotH);
    ctx.stroke();

    // Zero line
    const zeroX = margin.left + (-xMin / xRange) * plotW;
    ctx.strokeStyle = "#e5e7eb";
    ctx.beginPath();
    ctx.moveTo(zeroX, margin.top);
    ctx.lineTo(zeroX, margin.top + plotH);
    ctx.stroke();

    // Curve
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    curve.forEach((c, i) => {
      const x = margin.left + ((c.ret - xMin) / xRange) * plotW;
      const y = margin.top + plotH - (c.vol / yRange) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Labels
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("r(t) →", margin.left + plotW / 2, height - 3);
    ctx.save();
    ctx.translate(10, margin.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("E[|r(t+1)|]", 0, 0);
    ctx.restore();
    ctx.fillText("News Impact Curve", margin.left + plotW / 2, 10);
  }, [leverage]);

  // Jump detection chart
  useEffect(() => {
    if (!jumpRef.current) return;
    if (jumpChartRef.current) jumpChartRef.current.remove();

    const chart = createChart(jumpRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: jumpRef.current.clientWidth,
      height: 150,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    jumpChartRef.current = chart;

    const retSeries = chart.addSeries(HistogramSeries, {
      title: "リターン (ジャンプ検出)",
    });

    const jumpSet = new Set(jumps.jumpDays);
    retSeries.setData(
      lr.map((v, i) => ({
        time: lrTimes[i] as Time,
        value: v,
        color: jumpSet.has(i) ? (v >= 0 ? "#22c55e" : "#ef4444") : "#d1d5db",
      }))
    );

    chart.timeScale().fitContent();
    const handleResize = () => {
      if (jumpRef.current) chart.applyOptions({ width: jumpRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); jumpChartRef.current = null; };
  }, [prices, jumps]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">GARCH / レバレッジ効果 / ジャンプ検出</h3>
      <p className="text-xs text-gray-500 mb-3">条件付きボラティリティの推定とリスク構造の分解</p>

      {/* GARCH params */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">α (ARCH)</div>
          <div className="font-bold">{garch.alpha.toFixed(4)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">β (GARCH)</div>
          <div className="font-bold">{garch.beta.toFixed(4)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">持続性 α+β</div>
          <div className="font-bold">{garch.persistence.toFixed(4)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">半減期</div>
          <div className="font-bold">{garch.halfLife < 1000 ? `${garch.halfLife.toFixed(1)}日` : "∞"}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">非対称性</div>
          <div className="font-bold">{leverage.asymmetryCoeff.toFixed(3)}</div>
          <div className="text-gray-400">{leverage.asymmetryCoeff > 1.1 ? "レバレッジ効果あり" : "対称的"}</div>
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-1">GARCH(1,1) 条件付きボラティリティ σ(t)</div>
      <div ref={volRef} className="w-full rounded border border-gray-100" />

      <div className="mt-3 flex flex-col sm:flex-row gap-3 items-start">
        <div>
          <canvas ref={leverageCanvasRef} className="rounded border border-gray-100" />
          <div className="text-xs text-gray-400 mt-1">
            非対称性: 負リターン後vol {(leverage.negativeVolMean * 100).toFixed(3)}%
            / 正リターン後vol {(leverage.positiveVolMean * 100).toFixed(3)}%
          </div>
        </div>
        <div className="flex-1">
          <div className="text-xs text-gray-500 mb-1">
            ジャンプ検出 (BNS test, 閾値=3σ) — 検出数: {jumps.jumpDays.length}件,
            ジャンプ比率: {(jumps.jumpRatio * 100).toFixed(1)}%
          </div>
          <div ref={jumpRef} className="w-full rounded border border-gray-100" />
        </div>
      </div>

      <AnalysisGuide title="GARCH・レバレッジ・ジャンプの詳細理論">
        <p className="font-medium text-gray-700">1. この分析の概要</p>
        <p>株価のボラティリティ（値動きの激しさ）は一定ではなく、大きく動いた日の翌日はまた大きく動きやすい性質（ボラティリティクラスタリング）があります。GARCHモデルはこの「荒れの連鎖」を数式で捉えるモデルです。</p>
        <p className="mt-1">嵐の後の海に例えると、嵐が去った直後はまだ波が高く、徐々に凪いでいきます。GARCHは「今日の波の高さ」を「昨日の波」と「昨日の突風」から予測するモデルです。加えて、レバレッジ効果（下落時に波がより高くなる非対称性）とジャンプ（突然の巨大波）も分析します。</p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">{"GARCH(1,1): σ²_t = ω + α·r²_{t-1} + β·σ²_{t-1}\n\n半減期: HL = ln(0.5) / ln(α + β)\n\nBipower Variation: BV = (π/2) · (1/n) Σ|r_t|·|r_{t-1}|\n\nジャンプ検出: J_t = |r_t| / √BV > 閾値"}</p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>σ²_t</strong>: 今日の条件付き分散（ボラティリティの二乗）</li>
          <li><strong>ω</strong>: ベースとなる最低限のボラティリティ。凪の日でもゼロにはならない定数</li>
          <li><strong>α</strong>: 直前のショック（リターンの二乗）への反応度。大きいほど急変に敏感</li>
          <li><strong>β</strong>: 前日のボラティリティの持続度。大きいほど荒れが長引く</li>
          <li><strong>BV</strong>: 連続的な価格変動成分のみの分散推定。ジャンプの影響を除去できる</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>条件付きボラティリティ</strong>: 直近の市場状況を加味した「今日のボラティリティ」。固定値でなく日々変動する</li>
          <li><strong>IGARCH</strong>: α+β=1の状態。ボラティリティショックが永続し、長期の無条件分散が発散する</li>
          <li><strong>レバレッジ効果</strong>: 株価下落後にボラティリティが上昇しやすい非対称性。Blackにより1976年に報告された</li>
          <li><strong>News Impact Curve</strong>: 「今日のリターンが明日のボラティリティに与える影響」を可視化した曲線</li>
          <li><strong>Bipower Variation (BV)</strong>: 隣接するリターンの絶対値の積の平均。連続的な変動のみを推定しジャンプを分離する</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>α+β {">"} 0.95</strong>: ボラティリティショックの持続性が非常に高い。荒れた相場が長期化しやすい</li>
          <li><strong>α+β ≈ 1.0</strong>: IGARCH状態。ショックが永続する危険なサイン</li>
          <li><strong>半減期が20日以上</strong>: ショックの影響が1ヶ月近く残る。ボラティリティ戦略の保有期間の目安になる</li>
          <li><strong>News Impact Curveの左右非対称</strong>: 左（負リターン）が右より高ければレバレッジ効果あり。日本株では顕著に見られることが多い</li>
          <li><strong>ジャンプ比率 {">"} 10%</strong>: 全分散のうちジャンプ（不連続変動）が相当割合を占める。決算発表やイベント駆動の値動きが多い銘柄</li>
          <li><strong>ジャンプ検出の赤点</strong>: 通常のボラティリティでは説明できない異常な値動きが発生した日</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ポジションサイジング</strong>: 条件付きボラティリティが高い時期はポジションを縮小し、低い時期に拡大するリスクパリティ的運用</li>
          <li><strong>オプション戦略</strong>: レバレッジ効果が強い銘柄ではプット（下落保険）がコール（上昇権利）より割高になりやすく、プットスプレッド売りなどの戦略が検討可能</li>
          <li><strong>ジャンプリスクの管理</strong>: ジャンプ比率が高い銘柄では、ストップロスだけでなくオプションでのヘッジが有効</li>
          <li><strong>ボラティリティ売買</strong>: GARCH予測ボラティリティとインプライドボラティリティの乖離はオプションの割安/割高を示唆する</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>正規分布の仮定</strong>: 標準GARCH(1,1)はリターンの正規性を仮定。実際のファットテールにはt分布GARCHやGJR-GARCH（別セクション）がより適切</li>
          <li><strong>構造変化への弱さ</strong>: 市場構造が急変すると、過去データで推定したパラメータが無効になる</li>
          <li><strong>最尤推定の局所解</strong>: パラメータ推定が局所最適に陥る場合がある。初期値依存性に注意</li>
          <li><strong>ジャンプ閾値の恣意性</strong>: ジャンプ検出の閾値設定（何σ以上をジャンプとするか）には裁量が入る</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
