"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { fitARIMA } from "../../lib/arima";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

export default function ArimaChart({ prices }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const residRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);
  const residApiRef = useRef<IChartApi | null>(null);

  const closes = useMemo(() => prices.map((p) => p.close), [prices]);
  const times = useMemo(() => prices.map((p) => p.time), [prices]);
  const result = useMemo(() => fitARIMA(closes, 8), [prices]);

  // Forecast chart
  useEffect(() => {
    if (!chartRef.current) return;
    if (chartApiRef.current) chartApiRef.current.remove();

    const chart = createChart(chartRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: chartRef.current.clientWidth,
      height: 250,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartApiRef.current = chart;

    // Actual prices (last 120 days for context)
    const showDays = Math.min(120, prices.length);
    const startIdx = prices.length - showDays;

    const actualSeries = chart.addSeries(LineSeries, {
      color: "#2563eb",
      lineWidth: 2,
      title: "実績",
    });
    actualSeries.setData(
      prices.slice(startIdx).map((p) => ({
        time: p.time as Time,
        value: p.close,
      }))
    );

    // Fitted values
    if (result.fittedValues.length > 0) {
      const fittedData = result.fittedValues
        .map((v, i) => (!isNaN(v) && i >= startIdx ? { time: times[i] as Time, value: v } : null))
        .filter(Boolean) as { time: Time; value: number }[];

      if (fittedData.length > 0) {
        const fittedSeries = chart.addSeries(LineSeries, {
          color: "#f59e0b",
          lineWidth: 1,
          lineStyle: 2,
          title: "フィット",
        });
        fittedSeries.setData(fittedData);
      }
    }

    // Forecast
    if (result.forecast.point.length > 0) {
      const lastTime = times[times.length - 1];
      const forecastTimes = generateFutureDates(lastTime, result.forecast.point.length);

      const pointSeries = chart.addSeries(LineSeries, {
        color: "#059669",
        lineWidth: 2,
        title: "予測",
      });
      pointSeries.setData(
        forecastTimes.map((t, i) => ({ time: t as Time, value: result.forecast.point[i] }))
      );

      const upperSeries = chart.addSeries(LineSeries, {
        color: "#059669",
        lineWidth: 1,
        lineStyle: 2,
        title: "95%上限",
      });
      upperSeries.setData(
        forecastTimes.map((t, i) => ({ time: t as Time, value: result.forecast.upper95[i] }))
      );

      const lowerSeries = chart.addSeries(LineSeries, {
        color: "#059669",
        lineWidth: 1,
        lineStyle: 2,
        title: "95%下限",
      });
      lowerSeries.setData(
        forecastTimes.map((t, i) => ({ time: t as Time, value: result.forecast.lower95[i] }))
      );
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (chartRef.current) chart.applyOptions({ width: chartRef.current.clientWidth });
    });
    ro.observe(chartRef.current);
    return () => { ro.disconnect(); chart.remove(); chartApiRef.current = null; };
  }, [result, prices, times]);

  // Residuals chart
  useEffect(() => {
    if (!residRef.current) return;
    if (residApiRef.current) residApiRef.current.remove();

    const bestAR = result.bestModel === "AR" ? result.original : result.differenced;
    const resids = bestAR.residuals;
    const residTimes = result.bestModel === "AR" ? times : times.slice(1);

    const chart = createChart(residRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: residRef.current.clientWidth,
      height: 120,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    residApiRef.current = chart;

    const validResids = resids
      .map((r, i) => {
        const t = residTimes[i];
        return t && r !== 0 ? { time: t as Time, value: r } : null;
      })
      .filter(Boolean) as { time: Time; value: number }[];

    if (validResids.length > 0) {
      const rSeries = chart.addSeries(LineSeries, {
        color: "#94a3b8",
        lineWidth: 1,
        title: "残差",
      });
      rSeries.setData(validResids);
      chart.timeScale().fitContent();
    }

    const ro = new ResizeObserver(() => {
      if (residRef.current) chart.applyOptions({ width: residRef.current.clientWidth });
    });
    ro.observe(residRef.current);
    return () => { ro.disconnect(); chart.remove(); residApiRef.current = null; };
  }, [result, times]);

  const bestAR = result.bestModel === "AR" ? result.original : result.differenced;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        ARIMA モデル推定・予測
      </h3>

      {/* モデル選択結果 */}
      <div className="bg-blue-50 text-blue-800 rounded p-2 text-xs mb-3">
        <span className="font-semibold">
          最適モデル: {result.bestModel === "AR"
            ? `AR(${result.original.order})`
            : `ARIMA(${result.differenced.order},1,0)`}
        </span>
        <span className="ml-2">
          BIC={bestAR.bic.toFixed(1)} / R²={bestAR.rSquared.toFixed(4)} / σ={bestAR.sigma.toFixed(6)}
        </span>
      </div>

      {/* 係数 */}
      {bestAR.order > 0 && (
        <div className="mb-3">
          <div className="text-xs text-gray-500 mb-1">推定係数</div>
          <div className="flex flex-wrap gap-2">
            <span className="text-xs font-mono bg-gray-100 px-2 py-0.5 rounded">
              c={bestAR.coeffs[0].toFixed(6)}
            </span>
            {bestAR.coeffs.slice(1).map((c, i) => (
              <span key={i} className="text-xs font-mono bg-gray-100 px-2 py-0.5 rounded">
                {"φ"}{i + 1}={c.toFixed(4)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* モデル比較 */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="border rounded p-2">
          <div className="text-xs font-medium text-gray-600">
            AR({result.original.order}) [原系列]
          </div>
          <div className="text-xs text-gray-500 font-mono">
            BIC={result.original.bic.toFixed(1)} / AIC={result.original.aic.toFixed(1)}
          </div>
        </div>
        <div className="border rounded p-2">
          <div className="text-xs font-medium text-gray-600">
            ARIMA({result.differenced.order},1,0) [差分系列]
          </div>
          <div className="text-xs text-gray-500 font-mono">
            BIC={result.differenced.bic.toFixed(1)} / AIC={result.differenced.aic.toFixed(1)}
          </div>
        </div>
      </div>

      <div className="text-xs text-gray-600 mb-3">{result.interpretation}</div>

      {/* 予測チャート */}
      <div className="text-xs text-gray-500 mb-1">実績 + 予測 (20日先)</div>
      <div ref={chartRef} />

      {/* 残差チャート */}
      <div className="text-xs text-gray-500 mb-1 mt-3">モデル残差</div>
      <div ref={residRef} />

      <AnalysisGuide title="ARIMAモデルの詳細理論">
        <p className="font-medium text-gray-700">1. ARIMAとは</p>
        <p>
          ARIMA(p,d,q)は時系列の自己回帰（AR）と移動平均（MA）を組み合わせたモデルです。
          ここではMA部分を省略したARIMA(p,d,0)を使用。dは差分の次数（0=原系列、1=1階差分）。
          天気予報の「昨日と一昨日の気温から今日を予測する」ような考え方です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          {"AR(p): Y_t = c + φ₁Y_{t-1} + φ₂Y_{t-2} + ... + φ_pY_{t-p} + ε_t"}
          <br />
          {"ARIMA(p,1,0): ΔY_t = c + φ₁ΔY_{t-1} + ... + φ_pΔY_{t-p} + ε_t"}
          <br />
          {"ΔY_t = Y_t - Y_{t-1} (1階差分)"}
        </p>

        <p className="font-medium text-gray-700 mt-3">3. モデル選択</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>AR(0)~AR(8)を全て推定し、BIC（ベイズ情報量規準）で最適次数pを選択</li>
          <li>原系列と差分系列の両方でARを推定し、BICが低い方を採用</li>
          <li>BICはAICよりパーシモニー（簡潔さ）を重視し、過剰適合を防ぐ</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>φ₁が正 → 前日と同方向に動く傾向（モメンタム）</li>
          <li>φ₁が負 → 前日と逆方向に動く傾向（平均回帰）</li>
          <li>R²が低い → 過去の値だけでは予測が難しい（効率的市場）</li>
          <li>緑の予測線: 信頼区間が急速に広がる → 不確実性が高い</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>短期的な方向性の参考（ただし信頼区間に注意）</li>
          <li>ARが有効 → 自己相関が存在する → テクニカル分析が効く可能性</li>
          <li>ARが無効 → ランダムウォーク → テクニカルは無意味の可能性</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>株価のARIMA予測は一般に精度が低い（効率的市場仮説）</li>
          <li>残差に自己相関やヘテロスケダスティシティ（分散の時変性）がある場合はモデル不適切</li>
          <li>構造変化がある区間では過去のパラメータが将来に通用しない</li>
          <li>MA項を省略しているため、厳密にはAR/ARI(p,1)モデル</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

// Generate future business day dates
function generateFutureDates(lastDate: string, count: number): string[] {
  const dates: string[] = [];
  const d = new Date(lastDate);
  let added = 0;
  while (added < count) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    dates.push(`${yyyy}-${mm}-${dd}`);
    added++;
  }
  return dates;
}
