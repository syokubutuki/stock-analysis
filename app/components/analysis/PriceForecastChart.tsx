"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { computePriceForecast } from "../../lib/simulation";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const HORIZON_OPTIONS = [
  { value: 20, label: "1ヶ月" },
  { value: 60, label: "3ヶ月" },
  { value: 120, label: "6ヶ月" },
  { value: 250, label: "1年" },
];

type DisplayMode = "price" | "return";

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

function formatPrice(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e4) return (v / 1e3).toFixed(1) + "K";
  if (v >= 100) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function formatPct(v: number): string {
  return (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
}

export default function PriceForecastChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [horizon, setHorizon] = useState(60);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("price");

  const result = useMemo(() => computePriceForecast(prices, horizon), [prices, horizon]);

  useEffect(() => {
    if (!canvasRef.current || result.paths.length === 0) return;
    const H = 450;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 65, mr = 60, mt = 35, mb = 40;
    const plotW = width - ml - mr, plotH = height - mt - mb;

    const hist = result.history;
    const totalLen = hist.length + result.horizon;
    const histEnd = hist.length; // index where forecast starts
    const lastPrice = result.lastPrice;

    // 表示値への変換 (価格 or 基準価格からの累積リターン%)
    const isReturn = displayMode === "return";
    const disp = (v: number) => (isReturn ? (v / lastPrice - 1) * 100 : v);
    const fmtAxis = (v: number) => (isReturn ? formatPct(v) : formatPrice(v));
    const fmtVal = (rawV: number) => fmtAxis(disp(rawV));

    // Collect all values for Y range (表示空間)
    const allDisp = [
      ...hist.map(h => disp(h.price)),
      ...result.percentiles.p5.map(disp),
      ...result.percentiles.p95.map(disp),
    ];
    let minD = Math.min(...allDisp);
    let maxD = Math.max(...allDisp);
    // 余白
    const pad = (maxD - minD) * 0.04 || 1;
    minD -= pad; maxD += pad;
    const rangeD = maxD - minD || 1;

    const xFrom = (i: number) => ml + (i / totalLen) * plotW;
    const yFromD = (d: number) => mt + plotH - ((d - minD) / rangeD) * plotH;
    const yFrom = (rawV: number) => yFromD(disp(rawV));

    // Background for forecast area
    ctx.fillStyle = "rgba(239, 246, 255, 0.5)";
    ctx.fillRect(xFrom(histEnd), mt, xFrom(totalLen) - xFrom(histEnd), plotH);

    // Grid lines
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5;
    const nGridY = 6;
    for (let i = 0; i <= nGridY; i++) {
      const y = mt + (plotH * i) / nGridY;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      const val = maxD - (rangeD * i) / nGridY;
      ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(fmtAxis(val), ml - 4, y + 3);
    }

    // ゼロ(基準)ライン: リターン表示なら 0%、価格表示なら現在価格
    const baseDisp = isReturn ? 0 : lastPrice;
    if (baseDisp >= minD && baseDisp <= maxD) {
      const yb = yFromD(baseDisp);
      ctx.strokeStyle = "#9ca3af"; ctx.lineWidth = 0.8; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(ml, yb); ctx.lineTo(width - mr, yb); ctx.stroke();
      ctx.setLineDash([]);
    }

    // "Today" vertical line
    const todayX = xFrom(histEnd);
    ctx.strokeStyle = "#6b7280"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 3]);
    ctx.beginPath(); ctx.moveTo(todayX, mt); ctx.lineTo(todayX, mt + plotH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#374151"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("現在", todayX, mt + plotH + 13);

    // Sample paths (faint)
    const nShow = Math.min(result.paths.length, 100);
    for (let pi = 0; pi < nShow; pi++) {
      ctx.strokeStyle = "rgba(148, 163, 184, 0.06)"; ctx.lineWidth = 0.5;
      ctx.beginPath();
      const path = result.paths[pi];
      for (let t = 0; t <= result.horizon; t++) {
        const x = xFrom(histEnd + t), y = yFrom(path[t]);
        if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Confidence bands
    const p = result.percentiles;
    const drawBand = (upper: number[], lower: number[], color: string) => {
      ctx.beginPath();
      for (let t = 0; t <= result.horizon; t++) ctx.lineTo(xFrom(histEnd + t), yFrom(upper[t]));
      for (let t = result.horizon; t >= 0; t--) ctx.lineTo(xFrom(histEnd + t), yFrom(lower[t]));
      ctx.closePath();
      ctx.fillStyle = color; ctx.fill();
    };
    drawBand(p.p95, p.p5, "rgba(59, 130, 246, 0.06)");
    drawBand(p.p90, p.p10, "rgba(59, 130, 246, 0.08)");
    drawBand(p.p75, p.p25, "rgba(59, 130, 246, 0.12)");

    // Percentile lines
    const drawForecastLine = (vals: number[], color: string, w: number, dash?: number[]) => {
      ctx.strokeStyle = color; ctx.lineWidth = w;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      for (let t = 0; t <= result.horizon; t++) {
        const x = xFrom(histEnd + t), y = yFrom(vals[t]);
        if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (dash) ctx.setLineDash([]);
    };
    drawForecastLine(p.p5, "#ef4444", 1, [3, 3]);
    drawForecastLine(p.p25, "#f59e0b", 1, [3, 3]);
    drawForecastLine(p.p50, "#3b82f6", 2.5);
    drawForecastLine(p.p75, "#f59e0b", 1, [3, 3]);
    drawForecastLine(p.p95, "#ef4444", 1, [3, 3]);

    // Historical price line
    ctx.strokeStyle = "#111827"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const x = xFrom(i), y = yFrom(hist[i].price);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Right-side labels for percentiles
    const labelX = xFrom(totalLen) + 4;
    ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    const lastIdx = result.horizon;
    ctx.fillStyle = "#ef4444"; ctx.fillText(`5% ${fmtVal(p.p5[lastIdx])}`, labelX, yFrom(p.p5[lastIdx]) + 3);
    ctx.fillStyle = "#f59e0b"; ctx.fillText(`25% ${fmtVal(p.p25[lastIdx])}`, labelX, yFrom(p.p25[lastIdx]) + 3);
    ctx.fillStyle = "#3b82f6"; ctx.fillText(`50% ${fmtVal(p.p50[lastIdx])}`, labelX, yFrom(p.p50[lastIdx]) + 3);
    ctx.fillStyle = "#f59e0b"; ctx.fillText(`75% ${fmtVal(p.p75[lastIdx])}`, labelX, yFrom(p.p75[lastIdx]) + 3);
    ctx.fillStyle = "#ef4444"; ctx.fillText(`95% ${fmtVal(p.p95[lastIdx])}`, labelX, yFrom(p.p95[lastIdx]) + 3);

    // X-axis date labels
    ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    // Historical dates
    const histStep = Math.max(1, Math.floor(hist.length / 4));
    for (let i = 0; i < hist.length; i += histStep) {
      ctx.fillText(hist[i].date.slice(5), xFrom(i), height - mb + 25);
    }
    // Future dates
    const futStep = Math.max(1, Math.floor(result.futureDates.length / 4));
    for (let i = futStep; i < result.futureDates.length; i += futStep) {
      ctx.fillText(result.futureDates[i].slice(5), xFrom(histEnd + i + 1), height - mb + 25);
    }

    // Border
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);

    // Title
    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left";
    const horizonLabel = HORIZON_OPTIONS.find(o => o.value === horizon)?.label ?? `${horizon}日`;
    const modeLabel = isReturn ? "累積リターン%" : "価格水準";
    ctx.fillText(`モンテカルロ予測ファンチャート (${modeLabel}, ${horizonLabel}, 2000パス)`, ml, mt - 12);

    // Legend
    const legX = ml + plotW - 200;
    ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    ctx.fillStyle = "#111827"; ctx.fillText("━ 実績", legX, mt + 14);
    ctx.fillStyle = "#3b82f6"; ctx.fillText("━ 予測中央値", legX + 50, mt + 14);
    ctx.fillStyle = "#f59e0b"; ctx.fillText("--- 25/75%", legX + 115, mt + 14);
    ctx.fillStyle = "#ef4444"; ctx.fillText("--- 5/95%", legX + 165, mt + 14);
  }, [result, horizon, displayMode]);

  if (result.paths.length === 0) return null;

  const { finalStats, lastPrice } = result;
  const changeP50 = ((finalStats.median - lastPrice) / lastPrice) * 100;
  const changeP5 = ((finalStats.p5 - lastPrice) / lastPrice) * 100;
  const changeP95 = ((finalStats.p95 - lastPrice) / lastPrice) * 100;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">株価予測シミュレーター（モンテカルロ）</h3>
        <div className="flex items-center gap-3 flex-wrap">
          {/* 表示モード切替 */}
          <div className="flex gap-1">
            {([
              { value: "price", label: "価格" },
              { value: "return", label: "リターン%" },
            ] as const).map(opt => (
              <button
                key={opt.value}
                onClick={() => setDisplayMode(opt.value)}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  displayMode === opt.value
                    ? "bg-gray-800 text-white border-gray-800"
                    : "bg-white text-gray-600 border-gray-300 hover:border-gray-500"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {/* 期間切替 */}
          <div className="flex gap-1">
            {HORIZON_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setHorizon(opt.value)}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  horizon === opt.value
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-gray-600 border-gray-300 hover:border-blue-400"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="relative"><canvas ref={canvasRef} /></div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded border">
          <div className="text-gray-500">現在価格</div>
          <div className="font-mono font-bold text-gray-800">{formatPrice(lastPrice)}</div>
        </div>
        <div className="p-2 bg-blue-50 rounded border border-blue-200">
          <div className="text-gray-500">予測中央値</div>
          <div className={`font-mono font-bold ${changeP50 >= 0 ? "text-green-600" : "text-red-600"}`}>
            {formatPrice(finalStats.median)} ({changeP50 >= 0 ? "+" : ""}{changeP50.toFixed(1)}%)
          </div>
        </div>
        <div className="p-2 bg-red-50 rounded border border-red-200">
          <div className="text-gray-500">5%最悪</div>
          <div className="font-mono font-bold text-red-600">
            {formatPrice(finalStats.p5)} ({changeP5.toFixed(1)}%)
          </div>
        </div>
        <div className="p-2 bg-green-50 rounded border border-green-200">
          <div className="text-gray-500">95%最良</div>
          <div className="font-mono font-bold text-green-600">
            {formatPrice(finalStats.p95)} ({changeP95 >= 0 ? "+" : ""}{changeP95.toFixed(1)}%)
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded border">
          <div className="text-gray-500">上昇確率</div>
          <div className={`font-mono font-bold ${finalStats.probUp >= 0.5 ? "text-green-600" : "text-red-600"}`}>
            {(finalStats.probUp * 100).toFixed(1)}%
          </div>
        </div>
      </div>

      <AnalysisGuide title="株価予測シミュレーター（モンテカルロ）の詳細理論">
        <p className="font-medium text-gray-700">1. 概要</p>
        <p>過去の日次リターン分布からブートストラップ法（ヒストリカル・モンテカルロ）で将来の株価パスを2000本生成し、ファンチャートを描画します。「価格」表示では実際の株価水準で、「リターン%」表示では現在価格を基準(0%)とした累積リターンで同じシミュレーションを見られます。後者は従来の「モンテカルロ・シミュレーション」と同一の内容です。</p>

        <p className="font-medium text-gray-700 mt-3">2. 手法</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"過去の日次対数リターン r_t = ln(P_t / P_{t-1}) の経験分布を構築"}</li>
          <li>{"各パスで、リターン集合からランダムに復元抽出し、累積: S_T = P_0 × exp(Σr*_t)"}</li>
          <li>各時点で2000パスのパーセンタイル（5/10/25/50/75/90/95%）を計算</li>
          <li>パラメトリックな分布仮定を置かないため、実際のリターン分布の歪度・裾の重さが自然に反映される</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. チャートの読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>黒線（左側）: 過去60日間の実績</li>
          <li>点線「現在」: 予測の起点（直近終値）</li>
          <li>青線（中央値）: 最も可能性の高い予測パス</li>
          <li>濃い帯（25-75%）: 半数のシナリオがこの範囲に収まる</li>
          <li>薄い帯（5-95%）: 90%のシナリオがこの範囲。扇が広がるほど不確実性が大きい</li>
          <li>「価格」⇄「リターン%」ボタンで縦軸の単位を切り替え（同一シミュレーション）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>上昇確率が50%を大きく超えるなら、統計的には上昇バイアスあり</li>
          <li>5%最悪シナリオは「最大想定損失」の目安（ポジションサイジングに活用）</li>
          <li>ファンの広がり方でリスクの大きさを直感的に把握できる</li>
          <li>horizon別に比較することで、短期 vs 長期のリスク・リターン構造を理解</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>リターンの独立同分布(i.i.d.)を仮定 — ボラティリティクラスタリングやトレンドは反映されない</li>
          <li>過去の分布が将来も続くと仮定 — レジーム変化（バブル・暴落）は考慮されない</li>
          <li>これは「予測」ではなく「リスクシナリオの定量化」として使うべきツール</li>
          <li>投資判断の唯一の根拠にせず、他の分析と組み合わせて使用すること</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
