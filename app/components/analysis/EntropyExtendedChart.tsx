"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import {
  renyiEntropy,
  tsallisEntropy,
  approximateEntropy,
  weightedPermutationEntropy,
  rollingRenyi,
  rollingTsallis,
  rollingApEn,
  rollingWeightedPE,
} from "../../lib/entropy-extended";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function EntropyExtendedChart({ prices, seriesMode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const { values, times } = extractSeries(prices, seriesMode);

  const renyi = useMemo(() => renyiEntropy(values, 2), [prices, seriesMode]);
  const tsallis = useMemo(() => tsallisEntropy(values, 1.5), [prices, seriesMode]);
  const apen = useMemo(() => approximateEntropy(values, 2), [prices, seriesMode]);
  const wpe = useMemo(() => weightedPermutationEntropy(values, 3, 1), [prices, seriesMode]);

  const rRenyi = useMemo(() => rollingRenyi(values, times, 60, 2), [prices, seriesMode]);
  const rTsallis = useMemo(() => rollingTsallis(values, times, 60, 1.5), [prices, seriesMode]);
  const rApEn = useMemo(() => rollingApEn(values, times, 60), [prices, seriesMode]);
  const rWPE = useMemo(() => rollingWeightedPE(values, times, 60), [prices, seriesMode]);

  useEffect(() => {
    if (!containerRef.current || rRenyi.length === 0) return;
    if (chartRef.current) chartRef.current.remove();

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 250,
      rightPriceScale: { visible: true },
      leftPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;

    const s1 = chart.addSeries(LineSeries, { color: "#ef4444", lineWidth: 1, title: "Renyi(α=2)", priceScaleId: "right" });
    s1.setData(rRenyi.map((r) => ({ time: r.time as Time, value: r.value })));

    const s2 = chart.addSeries(LineSeries, { color: "#f97316", lineWidth: 1, title: "Tsallis(q=1.5)", priceScaleId: "right" });
    s2.setData(rTsallis.map((r) => ({ time: r.time as Time, value: r.value })));

    const s3 = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 1, title: "ApEn", priceScaleId: "left" });
    s3.setData(rApEn.map((r) => ({ time: r.time as Time, value: r.value })));

    const s4 = chart.addSeries(LineSeries, { color: "#22c55e", lineWidth: 1, title: "WeightedPE", priceScaleId: "left" });
    s4.setData(rWPE.map((r) => ({ time: r.time as Time, value: r.value })));

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [rRenyi, rTsallis, rApEn, rWPE]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">拡張エントロピー指標</h3>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Renyi (α=2)</div>
          <div className="font-mono font-medium text-sm text-red-600">{renyi.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Tsallis (q=1.5)</div>
          <div className="font-mono font-medium text-sm text-orange-600">{tsallis.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Approximate Entropy</div>
          <div className="font-mono font-medium text-sm text-blue-600">{apen.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">Weighted PE</div>
          <div className="font-mono font-medium text-sm text-green-600">{wpe.toFixed(3)}</div>
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-2">ローリング拡張エントロピー (60日窓)</div>
      <div ref={containerRef} className="w-full rounded border border-gray-100" />

      <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-red-500" /> Renyi</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-orange-500" /> Tsallis</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-blue-500" /> ApEn</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-green-500" /> WeightedPE</span>
      </div>

      <AnalysisGuide title="拡張エントロピーの詳細理論">
        <p className="font-medium text-gray-700">1. Renyiエントロピー</p>
        <p>H_α = (1/(1-α)) * log₂(Σ p_i^α)。α=2(2次Renyi)はcollision entropyとも呼ばれ、確率の「集中度」を測ります。2つのサンプルが同じビンに入る確率の対数に対応します。Shannonより外れ値に鈍感で、分布の中心的な構造を捉えます。</p>

        <p className="font-medium text-gray-700 mt-3">2. Tsallisエントロピー</p>
        <p>S_q = (1/(q-1)) * (1 - Σ p_i^q)。非加法的エントロピーで、q=1でShannonに一致します。q{"<"}1で稀な事象を強調、q{">"}1で頻出事象を強調。金融のファットテール分布の特性を捉えるのに適しています。</p>

        <p className="font-medium text-gray-700 mt-3">3. Approximate Entropy (ApEn)</p>
        <p>時系列中で類似パターンが再現する頻度を測定。Sample Entropyと異なり自己マッチを含みます。値が低いほど規則的(予測しやすい)。ApEn {"<"} 0.5なら強い構造あり。</p>

        <p className="font-medium text-gray-700 mt-3">4. 重み付き順列エントロピー (Weighted PE)</p>
        <p>通常のPEは順序パターンの出現頻度のみを見ますが、WPEは振幅(分散)で重み付けします。大きな価格変動を伴うパターンにより高い重要性を与えるため、実際のトレードシグナルとしてより実用的です。</p>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>複数のエントロピーが同時に低下: 強い構造の出現 = トレード機会</li>
          <li>WPEが通常PEより大きく乖離: 大きな振幅を伴うパターンが出現中</li>
          <li>ApEnの急低下: 自己相似パターンの発生 = 予測可能性の向上</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
