"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { financeTheoryAnalysis } from "../../lib/kelly-bs";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";

interface Props {
  prices: PricePoint[];
}

export default function FinanceTheoryChart({ prices }: Props) {
  const vrpRef = useRef<HTMLDivElement>(null);
  const vrpApiRef = useRef<IChartApi | null>(null);

  const returns = useMemo(() => {
    const r: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i].close > 0 && prices[i - 1].close > 0) {
        r.push(Math.log(prices[i].close / prices[i - 1].close));
      }
    }
    return r;
  }, [prices]);

  const times = useMemo(() => prices.map(p => p.time), [prices]);
  const currentPrice = prices[prices.length - 1]?.close ?? 100;

  const result = useMemo(
    () => financeTheoryAnalysis(returns, currentPrice, times),
    [returns, currentPrice, times]
  );

  // VRP chart
  useEffect(() => {
    if (!vrpRef.current) return;
    if (vrpApiRef.current) vrpApiRef.current.remove();

    const chart = createChart(vrpRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: vrpRef.current.clientWidth,
      height: 150,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    vrpApiRef.current = chart;

    if (result.varianceSwap.rollingVRP.length > 0) {
      const series = chart.addSeries(LineSeries, {
        color: "#059669",
        lineWidth: 1,
        title: "VRP (bps²)",
      });
      series.setData(
        result.varianceSwap.rollingVRP.map(d => ({
          time: d.time as Time,
          value: d.vrp,
        }))
      );
      chart.timeScale().fitContent();
    }

    const ro = new ResizeObserver(() => {
      if (vrpRef.current) chart.applyOptions({ width: vrpRef.current.clientWidth });
    });
    ro.observe(vrpRef.current);
    return () => { ro.disconnect(); chart.remove(); vrpApiRef.current = null; };
  }, [result]);

  const { kelly, bs, varianceSwap } = result;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        Kelly基準 / Black-Scholes / Variance Swap
      </h3>

      {/* Kelly */}
      <div className="mb-4">
        <div className="text-xs font-medium text-gray-600 mb-1">Kelly基準（最適ポジションサイズ）</div>
        <div className="grid grid-cols-4 gap-2">
          <div className="border rounded p-2 text-center">
            <div className="text-xs text-gray-500">Kelly比率</div>
            <div className={`font-mono text-sm font-semibold ${kelly.kellyFraction > 0 ? "text-green-700" : "text-red-700"}`}>
              {(kelly.kellyFraction * 100).toFixed(1)}%
            </div>
          </div>
          <div className="border rounded p-2 text-center">
            <div className="text-xs text-gray-500">半ケリー</div>
            <div className="font-mono text-sm">{(kelly.halfKelly * 100).toFixed(1)}%</div>
          </div>
          <div className="border rounded p-2 text-center">
            <div className="text-xs text-gray-500">期待成長率</div>
            <div className="font-mono text-sm">{(kelly.expectedGrowth * 100).toFixed(2)}%/年</div>
          </div>
          <div className="border rounded p-2 text-center">
            <div className="text-xs text-gray-500">μ / σ</div>
            <div className="font-mono text-sm">{(kelly.mu * 100).toFixed(1)}% / {(kelly.sigma * 100).toFixed(1)}%</div>
          </div>
        </div>
        <div className="text-xs text-gray-600 mt-1">{kelly.interpretation}</div>
      </div>

      {/* Black-Scholes */}
      <div className="mb-4">
        <div className="text-xs font-medium text-gray-600 mb-1">Black-Scholes ATMオプション理論価格（30日満期）</div>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          <div className="border rounded p-2 text-center">
            <div className="text-xs text-gray-500">コール</div>
            <div className="font-mono text-xs">{bs.callPrice.toFixed(2)}</div>
          </div>
          <div className="border rounded p-2 text-center">
            <div className="text-xs text-gray-500">プット</div>
            <div className="font-mono text-xs">{bs.putPrice.toFixed(2)}</div>
          </div>
          <div className="border rounded p-2 text-center">
            <div className="text-xs text-gray-500">Δ (C/P)</div>
            <div className="font-mono text-xs">{bs.callDelta.toFixed(3)} / {bs.putDelta.toFixed(3)}</div>
          </div>
          <div className="border rounded p-2 text-center">
            <div className="text-xs text-gray-500">Γ</div>
            <div className="font-mono text-xs">{bs.gamma.toFixed(5)}</div>
          </div>
          <div className="border rounded p-2 text-center">
            <div className="text-xs text-gray-500">Vega</div>
            <div className="font-mono text-xs">{bs.vega.toFixed(3)}</div>
          </div>
          <div className="border rounded p-2 text-center">
            <div className="text-xs text-gray-500">Θ/日</div>
            <div className="font-mono text-xs">{bs.theta.toFixed(3)}</div>
          </div>
        </div>
        <div className="text-xs text-gray-600 mt-1">{bs.interpretation}</div>
      </div>

      {/* Variance Swap */}
      <div className="mb-3">
        <div className="text-xs font-medium text-gray-600 mb-1">Variance Risk Premium</div>
        <div className="grid grid-cols-3 gap-2">
          <div className="border rounded p-2 text-center">
            <div className="text-xs text-gray-500">実現分散</div>
            <div className="font-mono text-xs">{(varianceSwap.realizedVar * 10000).toFixed(1)} bps²</div>
          </div>
          <div className="border rounded p-2 text-center">
            <div className="text-xs text-gray-500">期待分散</div>
            <div className="font-mono text-xs">{(varianceSwap.impliedVar * 10000).toFixed(1)} bps²</div>
          </div>
          <div className="border rounded p-2 text-center">
            <div className="text-xs text-gray-500">VRP</div>
            <div className={`font-mono text-xs font-semibold ${varianceSwap.varianceRiskPremium > 0 ? "text-green-700" : "text-red-700"}`}>
              {(varianceSwap.varianceRiskPremium * 10000).toFixed(1)} bps²
            </div>
          </div>
        </div>
        <div className="text-xs text-gray-600 mt-1">{varianceSwap.interpretation}</div>
      </div>

      <div className="text-xs text-gray-500 mb-1">ローリング VRP</div>
      <div ref={vrpRef} />

      <AnalysisGuide title="Kelly基準/Black-Scholes/Variance Swapの詳細理論">
        <p className="font-medium text-gray-700">1. Kelly基準</p>
        <p>
          Kelly(1956)が情報理論に基づき導出した最適投資比率。
          {"連続ケース: f* = μ/σ² (年率リターン/年率分散)"}
          <br />
          この比率で投資すると長期的な資産成長率が最大化されます。
          実務では半ケリー（f*/2）が推奨。ケリー以上に賭けると破産リスクが急増。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. Black-Scholes</p>
        <p>
          {"C = SN(d₁) - Ke^{-rT}N(d₂), d₁ = [ln(S/K) + (r+σ²/2)T] / (σ√T)"}
          <br />
          ヒストリカルvolをインプライドvolの代用として、30日ATMオプションの理論価格を算出。
          実際のオプション市場との乖離がボラティリティ・リスク・プレミアムを示唆。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. Variance Risk Premium (VRP)</p>
        <p>
          {"VRP = E[σ²] - Realized σ²"}
          <br />
          通常VRP {">"} 0: 投資家はボラティリティの不確実性に対してプレミアムを支払う。
          ボラティリティ売り（ショートストラドル等）の収益源。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Kelly比率: ポジションサイズの上限目安（半ケリー推奨）</li>
          <li>BS理論価格: 実際のオプション価格との比較で割高/割安判断</li>
          <li>VRP {">"} 0: ボラティリティ売り戦略に正のエッジ</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Kellyは過去データに基づく推定。将来のμ/σは不確実</li>
          <li>BSは正規分布+一定volを仮定。実際はファットテール+確率vol</li>
          <li>VRPの計算はIVデータがないためGARCHで近似（精度に限界）</li>
        </ul>
      </AnalysisGuide>

      <AxiomPlacement corollaryId="C1" />
    </div>
  );
}
