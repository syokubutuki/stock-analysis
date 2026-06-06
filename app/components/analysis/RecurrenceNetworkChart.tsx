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
import { computeRecurrenceNetwork } from "../../lib/recurrence-network";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function RecurrenceNetworkChart({ prices, seriesMode }: Props) {
  const degreeRef = useRef<HTMLDivElement>(null);
  const clusterRef = useRef<HTMLDivElement>(null);
  const degreeChartRef = useRef<IChartApi | null>(null);
  const clusterChartRef = useRef<IChartApi | null>(null);

  const { values: lr, times } = extractSeries(prices, seriesMode);

  const rn = useMemo(() => computeRecurrenceNetwork(lr), [prices, seriesMode]);

  // Degree series
  useEffect(() => {
    if (!degreeRef.current) return;
    if (degreeChartRef.current) degreeChartRef.current.remove();
    const chart = createChart(degreeRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: degreeRef.current.clientWidth,
      height: 150,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    degreeChartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#f97316",
      lineWidth: 1,
      title: "RN degree",
    });
    series.setData(
      rn.degreeSeries.slice(0, times.length).map((v, i) => ({
        time: times[i] as Time, value: v,
      }))
    );
    chart.timeScale().fitContent();
    const handleResize = () => {
      if (degreeRef.current) chart.applyOptions({ width: degreeRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); degreeChartRef.current = null; };
  }, [prices, rn]);

  // Local clustering
  useEffect(() => {
    if (!clusterRef.current) return;
    if (clusterChartRef.current) clusterChartRef.current.remove();
    const chart = createChart(clusterRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: clusterRef.current.clientWidth,
      height: 120,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    clusterChartRef.current = chart;

    const series = chart.addSeries(LineSeries, {
      color: "#06b6d4",
      lineWidth: 1,
      title: "局所CC",
    });
    series.setData(
      rn.localClustering.slice(0, times.length).map((v, i) => ({
        time: times[i] as Time, value: v,
      }))
    );
    chart.timeScale().fitContent();
    const handleResize = () => {
      if (clusterRef.current) chart.applyOptions({ width: clusterRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); clusterChartRef.current = null; };
  }, [prices, rn]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">Recurrence Network</h3>
      <p className="text-xs text-gray-500 mb-3">リカレンスプロットをグラフとして解析</p>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">クラスタリング係数</div>
          <div className="font-bold">{rn.clusteringCoeff.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">推移性</div>
          <div className="font-bold">{rn.transitivity.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">平均経路長</div>
          <div className="font-bold">{rn.avgPathLength.toFixed(2)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">コミュニティ数</div>
          <div className="font-bold">{rn.numCommunities}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">次数分布</div>
          <div className="font-bold">{rn.degreeDistribution.length} bins</div>
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-1">Recurrence Network 次数 (時系列)</div>
      <div ref={degreeRef} className="w-full rounded border border-gray-100 mb-2" />

      <div className="text-xs text-gray-500 mb-1">局所クラスタリング係数 (時系列)</div>
      <div ref={clusterRef} className="w-full rounded border border-gray-100" />

      <AnalysisGuide title="Recurrence Network分析の詳細理論">
        <p className="font-medium text-gray-700">1. この分析の概要</p>
        <p>Recurrence Plot（再帰プロット）の隣接行列をネットワーク（グラフ）として解釈し、複雑ネットワーク科学の指標で時系列の力学的構造を分析します。どの時期の市場状態が似ているか、状態の遷移パターンにどんな構造があるかを可視化します。</p>
        <p className="mt-1">SNSの友達ネットワークに例えると、各時点を「人」、似た動きをした時点同士を「友達関係」でつなぎます。友達が多い人（高次数ノード）は「よくある市場パターン」、グループ（コミュニティ）は「レジーム」に対応します。</p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">{"隣接行列: A_ij = Θ(ε - ||x_i - x_j||) - δ_ij\n  x_i: 時刻iの位相空間ベクトル, ε: 閾値\n\n次数: k_i = Σ_j A_ij\n\n局所クラスタリング係数:\n  C_i = (Σ_{j,k} A_ij·A_jk·A_ki) / (k_i·(k_i-1))\n\nネットワーク密度: ρ = Σ A_ij / (N·(N-1))"}</p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>A_ij</strong>: 隣接行列の要素。時点iとjの距離が閾値ε以内なら1、それ以外は0</li>
          <li><strong>k_i</strong>: ノードiの次数。iと類似した状態にあった時点の数</li>
          <li><strong>C_i</strong>: 局所クラスタリング係数。iの近傍同士がどれだけ接続されているか</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>Recurrence Network</strong>: 再帰プロットの隣接行列をネットワークとして解釈したもの。ノード=時点、エッジ=状態の類似性</li>
          <li><strong>次数（degree）</strong>: あるノードに接続されたエッジの数。高次数＝多くの過去の状態に類似した「典型的」な市場状態</li>
          <li><strong>クラスタリング係数</strong>: ノードの近傍がどれだけ密に接続されているかの指標。高い値は状態空間が局所的に密で、安定したダイナミクスを示す</li>
          <li><strong>コミュニティ</strong>: ネットワーク内の密に接続されたグループ。Label Propagation法で検出。異なるレジーム（市場状態）に対応</li>
          <li><strong>位相空間再構成</strong>: Takensの埋め込み定理に基づき、1次元の時系列から多次元の状態ベクトルを構成する手法</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>次数が高い時期</strong>: 多くの過去の状態と似ている＝よく訪れる状態（アトラクタの中心）。安定した市場パターン</li>
          <li><strong>次数が低い時期</strong>: 過去に類例が少ない状態。異常な市場環境やレジーム転換直後に見られやすい</li>
          <li><strong>クラスタリング係数が高い</strong>: 近傍同士が密に接続＝状態空間が局所的に密で、滑らかなダイナミクス</li>
          <li><strong>クラスタリング係数が低い</strong>: 近傍の構造が疎＝カオス的・不規則な動き</li>
          <li><strong>コミュニティが複数</strong>: 市場に複数のレジーム（例: 低ボラ期、高ボラ期）が存在することを示唆</li>
          <li><strong>コミュニティの時間的分布</strong>: 同じコミュニティに属する時点が連続していれば安定したレジーム、散在していれば頻繁な状態遷移</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>レジーム判定</strong>: 現在の時点がどのコミュニティに属するかで、現在の市場レジームを推定。HMMと異なりパラメトリックな仮定が不要</li>
          <li><strong>異常検知</strong>: 次数が急低下した時期は過去に例のない状態であり、リスク管理の警告シグナルとなる</li>
          <li><strong>戦略の有効期間</strong>: 同一コミュニティ内では同じ戦略が有効と期待される。コミュニティ遷移時に戦略を切り替える</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>埋め込みパラメータ依存</strong>: 埋め込み次元と遅延時間の選択でネットワーク構造が大きく変わる。最適パラメータの選定が重要</li>
          <li><strong>閾値εの選択</strong>: εが小さすぎるとネットワークが疎になりすぎ、大きすぎると構造が潰れる。再帰率5-10%が目安</li>
          <li><strong>計算コスト</strong>: N×Nの距離行列を計算するため、データ点数Nが大きいとメモリと計算時間が急増する</li>
          <li><strong>Label Propagationの非決定性</strong>: コミュニティ検出結果は初期条件によって変わりうる。結果の安定性を確認すべき</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
