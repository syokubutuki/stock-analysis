"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeMarketTime } from "../../lib/market-time";
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

export default function MarketTimeChart({ prices }: Props) {
  const mappingCanvasRef = useRef<HTMLCanvasElement>(null);
  const priceCanvasRef = useRef<HTMLCanvasElement>(null);
  const volPriceCanvasRef = useRef<HTMLCanvasElement>(null);

  const result = useMemo(() => computeMarketTime(prices), [prices]);

  // Chart 1: Time mapping (calendar vs volume/volatility time)
  useEffect(() => {
    const canvas = mappingCanvasRef.current;
    if (!canvas || result.data.length < 2) return;

    const draw = () => {
      const init = initCanvas(canvas, 280);
      if (!init) return;
      const { ctx, width, height } = init;

      const margin = { top: 25, right: 20, bottom: 35, left: 50 };
      const plotW = width - margin.left - margin.right;
      const plotH = height - margin.top - margin.bottom;

      const toX = (v: number) => margin.left + v * plotW;
      const toY = (v: number) => margin.top + plotH - v * plotH;

      // Axes
      ctx.strokeStyle = "#ccc";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(margin.left, margin.top);
      ctx.lineTo(margin.left, margin.top + plotH);
      ctx.lineTo(margin.left + plotW, margin.top + plotH);
      ctx.stroke();

      // Axis labels
      ctx.fillStyle = "#666";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Calendar Time (0-1)", margin.left + plotW / 2, height - 5);
      ctx.save();
      ctx.translate(12, margin.top + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText("Market Time (0-1)", 0, 0);
      ctx.restore();

      // Grid lines
      ctx.strokeStyle = "#eee";
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= 4; i++) {
        const frac = i / 4;
        ctx.beginPath();
        ctx.moveTo(toX(frac), margin.top);
        ctx.lineTo(toX(frac), margin.top + plotH);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(margin.left, toY(frac));
        ctx.lineTo(margin.left + plotW, toY(frac));
        ctx.stroke();

        ctx.fillStyle = "#999";
        ctx.font = "9px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(frac.toFixed(1), toX(frac), margin.top + plotH + 14);
        ctx.textAlign = "right";
        ctx.fillText(frac.toFixed(1), margin.left - 5, toY(frac) + 3);
      }

      // Diagonal reference line (calendar = market time)
      ctx.strokeStyle = "#bbb";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(toX(0), toY(0));
      ctx.lineTo(toX(1), toY(1));
      ctx.stroke();
      ctx.setLineDash([]);

      const n = result.data.length;

      // Volume time curve (blue)
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const calT = i / (n - 1);
        const volT = result.data[i].volumeTime;
        if (i === 0) ctx.moveTo(toX(calT), toY(volT));
        else ctx.lineTo(toX(calT), toY(volT));
      }
      ctx.stroke();

      // Volatility time curve (red)
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const calT = i / (n - 1);
        const volT = result.data[i].volatilityTime;
        if (i === 0) ctx.moveTo(toX(calT), toY(volT));
        else ctx.lineTo(toX(calT), toY(volT));
      }
      ctx.stroke();

      // Legend
      const legendX = margin.left + 10;
      const legendY = margin.top + 10;
      ctx.font = "11px sans-serif";

      ctx.strokeStyle = "#bbb";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(legendX, legendY);
      ctx.lineTo(legendX + 20, legendY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#888";
      ctx.textAlign = "left";
      ctx.fillText("Calendar (reference)", legendX + 25, legendY + 4);

      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(legendX, legendY + 16);
      ctx.lineTo(legendX + 20, legendY + 16);
      ctx.stroke();
      ctx.fillStyle = "#3b82f6";
      ctx.fillText("Volume Time", legendX + 25, legendY + 20);

      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(legendX, legendY + 32);
      ctx.lineTo(legendX + 20, legendY + 32);
      ctx.stroke();
      ctx.fillStyle = "#ef4444";
      ctx.fillText("Volatility Time", legendX + 25, legendY + 36);

      // Title
      ctx.fillStyle = "#333";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Time Mapping: Calendar vs Market Time", width / 2, 14);
    };

    draw();
    const handleResize = () => draw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [result]);

  // Chart 2: Price in calendar time vs volume time
  useEffect(() => {
    const canvas = priceCanvasRef.current;
    if (!canvas || result.data.length < 2) return;

    const draw = () => {
      const init = initCanvas(canvas, 280);
      if (!init) return;
      const { ctx, width, height } = init;

      const margin = { top: 25, right: 20, bottom: 35, left: 60 };
      const plotW = width - margin.left - margin.right;
      const plotH = height - margin.top - margin.bottom;

      const closes = result.data.map((d) => d.close);
      const minP = Math.min(...closes);
      const maxP = Math.max(...closes);
      const rangeP = maxP - minP || 1;

      const toY = (v: number) => margin.top + plotH - ((v - minP) / rangeP) * plotH;

      // Axes
      ctx.strokeStyle = "#ccc";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(margin.left, margin.top);
      ctx.lineTo(margin.left, margin.top + plotH);
      ctx.lineTo(margin.left + plotW, margin.top + plotH);
      ctx.stroke();

      // Y axis labels
      ctx.fillStyle = "#999";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "right";
      for (let i = 0; i <= 4; i++) {
        const val = minP + (rangeP * i) / 4;
        ctx.fillText(val.toFixed(0), margin.left - 5, toY(val) + 3);
        ctx.strokeStyle = "#eee";
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(margin.left, toY(val));
        ctx.lineTo(margin.left + plotW, toY(val));
        ctx.stroke();
      }

      // X axis labels
      ctx.textAlign = "center";
      for (let i = 0; i <= 4; i++) {
        const frac = i / 4;
        const x = margin.left + frac * plotW;
        ctx.fillText(frac.toFixed(1), x, margin.top + plotH + 14);
      }

      ctx.fillStyle = "#666";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Normalized Time (0-1)", margin.left + plotW / 2, height - 5);

      const n = result.data.length;

      // Calendar time price (gray)
      ctx.strokeStyle = "#aaa";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = margin.left + (i / (n - 1)) * plotW;
        if (i === 0) ctx.moveTo(x, toY(closes[i]));
        else ctx.lineTo(x, toY(closes[i]));
      }
      ctx.stroke();

      // Volume time price (blue) - resampled
      const volResampled = result.volumeResampled;
      if (volResampled.length > 1) {
        const volCloses = volResampled.map((d) => d.close);
        const volMinP = Math.min(...volCloses);
        const volMaxP = Math.max(...volCloses);
        const volRangeP = volMaxP - volMinP || 1;
        const volToY = (v: number) =>
          margin.top + plotH - ((v - minP) / rangeP) * plotH;

        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < volResampled.length; i++) {
          const x = margin.left + volResampled[i].time * plotW;
          if (i === 0) ctx.moveTo(x, volToY(volResampled[i].close));
          else ctx.lineTo(x, volToY(volResampled[i].close));
        }
        ctx.stroke();
      }

      // Legend
      const legendX = margin.left + 10;
      const legendY = margin.top + 10;
      ctx.font = "11px sans-serif";

      ctx.strokeStyle = "#aaa";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(legendX, legendY);
      ctx.lineTo(legendX + 20, legendY);
      ctx.stroke();
      ctx.fillStyle = "#888";
      ctx.textAlign = "left";
      ctx.fillText("Calendar Time Price", legendX + 25, legendY + 4);

      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(legendX, legendY + 16);
      ctx.lineTo(legendX + 20, legendY + 16);
      ctx.stroke();
      ctx.fillStyle = "#3b82f6";
      ctx.fillText("Volume Time Price", legendX + 25, legendY + 20);

      // Title
      ctx.fillStyle = "#333";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        "Price: Calendar Time vs Volume Time",
        width / 2,
        14
      );
    };

    draw();
    const handleResize = () => draw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [result]);

  // Chart 3: Price resampled in volatility time
  useEffect(() => {
    const canvas = volPriceCanvasRef.current;
    if (!canvas || result.data.length < 2) return;

    const draw = () => {
      const init = initCanvas(canvas, 280);
      if (!init) return;
      const { ctx, width, height } = init;

      const margin = { top: 25, right: 20, bottom: 35, left: 60 };
      const plotW = width - margin.left - margin.right;
      const plotH = height - margin.top - margin.bottom;

      const closes = result.data.map((d) => d.close);
      const minP = Math.min(...closes);
      const maxP = Math.max(...closes);
      const rangeP = maxP - minP || 1;

      const toY = (v: number) => margin.top + plotH - ((v - minP) / rangeP) * plotH;

      // Axes
      ctx.strokeStyle = "#ccc";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(margin.left, margin.top);
      ctx.lineTo(margin.left, margin.top + plotH);
      ctx.lineTo(margin.left + plotW, margin.top + plotH);
      ctx.stroke();

      // Y axis labels
      ctx.fillStyle = "#999";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "right";
      for (let i = 0; i <= 4; i++) {
        const val = minP + (rangeP * i) / 4;
        ctx.fillText(val.toFixed(0), margin.left - 5, toY(val) + 3);
        ctx.strokeStyle = "#eee";
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(margin.left, toY(val));
        ctx.lineTo(margin.left + plotW, toY(val));
        ctx.stroke();
      }

      // X axis labels
      ctx.fillStyle = "#999";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "center";
      for (let i = 0; i <= 4; i++) {
        const frac = i / 4;
        const x = margin.left + frac * plotW;
        ctx.fillText(frac.toFixed(1), x, margin.top + plotH + 14);
      }

      ctx.fillStyle = "#666";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Volatility Time (0-1)", margin.left + plotW / 2, height - 5);

      const n = result.data.length;

      // Calendar time price (gray)
      ctx.strokeStyle = "#aaa";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = margin.left + (i / (n - 1)) * plotW;
        if (i === 0) ctx.moveTo(x, toY(closes[i]));
        else ctx.lineTo(x, toY(closes[i]));
      }
      ctx.stroke();

      // Volatility time price (red) - resampled
      const volResampled = result.volatilityResampled;
      if (volResampled.length > 1) {
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < volResampled.length; i++) {
          const x = margin.left + volResampled[i].time * plotW;
          if (i === 0) ctx.moveTo(x, toY(volResampled[i].close));
          else ctx.lineTo(x, toY(volResampled[i].close));
        }
        ctx.stroke();
      }

      // Legend
      const legendX = margin.left + 10;
      const legendY = margin.top + 10;
      ctx.font = "11px sans-serif";

      ctx.strokeStyle = "#aaa";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(legendX, legendY);
      ctx.lineTo(legendX + 20, legendY);
      ctx.stroke();
      ctx.fillStyle = "#888";
      ctx.textAlign = "left";
      ctx.fillText("Calendar Time Price", legendX + 25, legendY + 4);

      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(legendX, legendY + 16);
      ctx.lineTo(legendX + 20, legendY + 16);
      ctx.stroke();
      ctx.fillStyle = "#ef4444";
      ctx.fillText("Volatility Time Price", legendX + 25, legendY + 20);

      // Title
      ctx.fillStyle = "#333";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        "Price: Calendar Time vs Volatility Time",
        width / 2,
        14
      );
    };

    draw();
    const handleResize = () => draw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [result]);

  const { stats } = result;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-700">
        Market Time Redefinition
      </h3>

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-blue-50 rounded-lg p-3">
          <div className="text-xs text-blue-600 font-medium">Volume Gini</div>
          <div className="text-lg font-bold text-blue-800">
            {stats.volumeGini.toFixed(4)}
          </div>
          <div className="text-xs text-blue-500">
            {stats.volumeGini > 0.5 ? "High distortion" : stats.volumeGini > 0.3 ? "Moderate" : "Low distortion"}
          </div>
        </div>
        <div className="bg-red-50 rounded-lg p-3">
          <div className="text-xs text-red-600 font-medium">Volatility Gini</div>
          <div className="text-lg font-bold text-red-800">
            {stats.volatilityGini.toFixed(4)}
          </div>
          <div className="text-xs text-red-500">
            {stats.volatilityGini > 0.5 ? "High distortion" : stats.volatilityGini > 0.3 ? "Moderate" : "Low distortion"}
          </div>
        </div>
        <div className="bg-blue-50 rounded-lg p-3">
          <div className="text-xs text-blue-600 font-medium">Vol. Time Corr.</div>
          <div className="text-lg font-bold text-blue-800">
            {stats.volumeCorrelation.toFixed(4)}
          </div>
          <div className="text-xs text-blue-500">
            {stats.volumeCorrelation > 0.99 ? "Near linear" : "Non-linear"}
          </div>
        </div>
        <div className="bg-red-50 rounded-lg p-3">
          <div className="text-xs text-red-600 font-medium">Volat. Time Corr.</div>
          <div className="text-lg font-bold text-red-800">
            {stats.volatilityCorrelation.toFixed(4)}
          </div>
          <div className="text-xs text-red-500">
            {stats.volatilityCorrelation > 0.99 ? "Near linear" : "Non-linear"}
          </div>
        </div>
      </div>

      {/* Chart 1: Time mapping */}
      <div>
        <canvas ref={mappingCanvasRef} />
      </div>

      {/* Chart 2: Price in volume time */}
      <div>
        <canvas ref={priceCanvasRef} />
      </div>

      {/* Chart 3: Price in volatility time */}
      <div>
        <canvas ref={volPriceCanvasRef} />
      </div>

      <AnalysisGuide title="市場時間の再定義 - 詳細理論">
        <p className="font-medium text-gray-700">1. 市場時間とは</p>
        <p>
          金融市場では、カレンダー上の1日がすべて同じ「重み」を持つわけではありません。
          出来高が集中する日は市場参加者の活動が活発で、多くの情報が価格に織り込まれます。
          逆に閑散日は情報がほとんど更新されません。「市場時間の再定義」とは、
          カレンダー時間の代わりに出来高やボラティリティの累積量を「時計」として使い、
          価格の動きを再解釈する手法です。
          日常的な比喩で言えば、カレンダー時間は「壁時計」、市場時間は「体感時計」のようなものです。
          忙しい日は時間が速く進み、暇な日は遅く進みます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          {"出来高時間: T_vol(i) = sum(V_k, k=1..i) / sum(V_k, k=1..N)"}
          <br />
          {"ボラティリティ時間: T_sigma(i) = sum(|log(C_k/C_{k-1})|, k=1..i) / sum(|log(C_k/C_{k-1})|, k=1..N)"}
          <br />
          {"Gini係数: G = sum((2i - n - 1) * x_i, i=1..n) / (n * sum(x_i))  (x_iは昇順ソート済み)"}
          <br />
          {"ここで V_k は日次出来高、C_k は終値、N は全データ数"}
        </p>
        <p>
          出来高時間・ボラティリティ時間はそれぞれ累積出来高・累積絶対対数リターンを
          全体の合計で正規化した値で、0から1の範囲に収まります。
          カレンダー時間も同様に0から1に正規化します。
          両者が一致すれば対角線上に乗り、乖離が大きいほど時間の「歪み」が生じています。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 結果の解釈</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>タイムマッピング図</strong>: 青曲線（出来高時間）や赤曲線（ボラティリティ時間）が
            灰色の対角線から上に離れている区間は、その期間に出来高/ボラティリティが集中していたことを示します。
            下に離れている区間は閑散期です。
          </li>
          <li>
            <strong>Gini係数</strong>: 0に近いほど出来高やボラティリティが均一に分布しており、
            1に近いほど特定の期間に集中しています。一般的に0.3以下は比較的均一、0.5以上は高い集中度を意味します。
          </li>
          <li>
            <strong>相関係数</strong>: カレンダー時間と市場時間の相関が1に近いほど両者は線形関係にあり、
            時間の歪みが小さいことを示します。1から離れるほど非線形な時間変換が必要です。
          </li>
          <li>
            <strong>価格チャート</strong>: 市場時間で再サンプリングした価格は、
            活発な取引期間を引き伸ばし、閑散期を圧縮して表示します。
            カレンダー時間では見えなかったパターンが浮かび上がることがあります。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            出来高時間で再サンプリングした価格は、出来高加重平均価格（VWAP）に基づくテクニカル分析と
            親和性が高く、機関投資家の執行アルゴリズムが実際に使用する時間軸に近い見方ができます。
          </li>
          <li>
            ボラティリティ時間は、リスク管理の観点から重要です。ボラティリティが高い期間を
            引き伸ばして表示するため、急落・急騰時の価格構造を詳細に分析できます。
          </li>
          <li>
            カレンダー時間では均等に見える移動平均やボリンジャーバンドなどの指標も、
            市場時間で再計算するとより適応的なシグナルが得られる可能性があります。
          </li>
          <li>
            Gini係数が高い銘柄は、特定の期間に取引活動が集中する傾向があり、
            イベント駆動型の戦略が有効な可能性を示唆します。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 理論的背景</p>
        <p>
          Clark (1973) の「従属過程仮説（Subordinated Process Hypothesis）」では、
          価格変動は取引量という内部時計に従うブラウン運動としてモデル化されます。
          この考えに基づけば、出来高時間で見た価格変動はより正規分布に近くなり、
          カレンダー時間で見られるファットテールの原因の一部を説明できます。
          Ane & Geman (2000) はこれを実証的に検証し、出来高時間での正規性の改善を示しました。
        </p>

        <p className="font-medium text-gray-700 mt-3">6. 実務での応用例</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            出来高プロファイル分析: 価格帯ごとの出来高分布を市場時間で再構成すると、
            真のサポート・レジスタンスレベルをより正確に特定できます。
          </li>
          <li>
            リスクモデルの改善: VaR計算にボラティリティ時間を用いることで、
            低ボラティリティ期間のリスク過大評価と高ボラティリティ期間の過小評価を緩和できます。
          </li>
          <li>
            アルゴリズム取引: 出来高時間に基づく注文執行は、マーケットインパクトの最小化に寄与します。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            出来高データの品質に大きく依存します。株式分割、配当落ち、
            市場構造の変化により出来高の比較可能性が損なわれることがあります。
          </li>
          <li>
            日次データでは日中の出来高パターン（寄付き・引け近辺の集中）が
            反映されないため、ティックデータや分足データでの分析がより適切な場合があります。
          </li>
          <li>
            Gini係数は分布の不均一性を測る指標ですが、時系列構造（自己相関や
            クラスタリング）は考慮しません。高いGini係数が必ずしも
            予測可能性を意味するわけではありません。
          </li>
          <li>
            市場時間での再サンプリングは補間を含むため、元データにない
            「人工的な」価格点が生成されます。解釈には注意が必要です。
          </li>
          <li>
            出来高時間とボラティリティ時間は異なる視点を提供しますが、
            どちらが「正しい」市場時間かは一概に言えません。分析目的に応じて使い分けてください。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
