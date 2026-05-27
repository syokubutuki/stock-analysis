"use client";

import { useMemo, useRef, useEffect, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import {
  simplexProjection,
  smapPrediction,
  computePredictionSkill,
  testNonlinearity,
  autoMutualInformation,
  falseNearestNeighbors,
} from "../../lib/attractor-investment";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function SimplexPredictionChart({ prices, seriesMode }: Props) {
  const predRef = useRef<HTMLDivElement>(null);
  const skillRef = useRef<HTMLDivElement>(null);
  const thetaCanvasRef = useRef<HTMLCanvasElement>(null);
  const predChartRef = useRef<IChartApi | null>(null);
  const skillChartRef = useRef<IChartApi | null>(null);
  const [theta, setTheta] = useState(2);

  const { values, times } = extractSeries(prices, seriesMode);

  const tau = useMemo(
    () => autoMutualInformation(values, 20).optimalTau,
    [values]
  );

  const fnn = useMemo(
    () => falseNearestNeighbors(values, tau, 8),
    [values, tau]
  );

  const dim = fnn.optimalDim;

  const simplex = useMemo(
    () => simplexProjection(values, times, tau, dim),
    [values, times, tau, dim]
  );

  const smap = useMemo(
    () => smapPrediction(values, times, tau, dim, theta),
    [values, times, tau, dim, theta]
  );

  const skill = useMemo(
    () => smap.actual.length > 30
      ? computePredictionSkill(smap.actual, smap.predicted, smap.actualTimes, 30)
      : null,
    [smap]
  );

  const nlTest = useMemo(
    () => testNonlinearity(values, times, tau, dim),
    [values, times, tau, dim]
  );

  // Prediction chart (actual vs predicted)
  useEffect(() => {
    if (!predRef.current || smap.actual.length === 0) return;
    if (predChartRef.current) predChartRef.current.remove();

    const chart = createChart(predRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: predRef.current.clientWidth,
      height: 200,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    predChartRef.current = chart;

    const actualSeries = chart.addSeries(LineSeries, {
      color: "#374151",
      lineWidth: 2,
      title: "実測値",
    });
    const predSeries = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
      title: "S-map予測",
    });

    actualSeries.setData(smap.actualTimes.map((t, i) => ({
      time: t as Time,
      value: smap.actual[i],
    })));
    predSeries.setData(smap.actualTimes.map((t, i) => ({
      time: t as Time,
      value: smap.predicted[i],
    })));

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (predRef.current) chart.applyOptions({ width: predRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); predChartRef.current = null; };
  }, [smap]);

  // Prediction skill chart
  useEffect(() => {
    if (!skillRef.current || !skill || skill.times.length === 0) return;
    if (skillChartRef.current) skillChartRef.current.remove();

    const chart = createChart(skillRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: skillRef.current.clientWidth,
      height: 160,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    skillChartRef.current = chart;

    const skillSeries = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 2,
      title: "予測スキル (ρ)",
    });
    const dirSeries = chart.addSeries(LineSeries, {
      color: "#f97316",
      lineWidth: 2,
      title: "方向精度",
    });
    const zeroSeries = chart.addSeries(LineSeries, {
      color: "#d1d5db",
      lineWidth: 1,
      lineStyle: 2,
      title: "",
    });

    skillSeries.setData(skill.times.map((t, i) => ({ time: t as Time, value: skill.skill[i] })));
    dirSeries.setData(skill.times.map((t, i) => ({ time: t as Time, value: skill.direction[i] })));
    zeroSeries.setData(skill.times.map(t => ({ time: t as Time, value: 0.5 })));

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (skillRef.current) chart.applyOptions({ width: skillRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); skillChartRef.current = null; };
  }, [skill]);

  // Nonlinearity test θ chart
  useEffect(() => {
    const canvas = thetaCanvasRef.current;
    if (!canvas || nlTest.thetas.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement?.clientWidth || 300;
    const height = 180;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const m = { left: 50, right: 15, top: 25, bottom: 35 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const maxTheta = Math.max(...nlTest.thetas);
    const maxSkill = Math.max(...nlTest.skills.map(Math.abs), 0.01);
    const minSkill = Math.min(...nlTest.skills, 0);

    const toX = (t: number) => m.left + (t / (maxTheta || 1)) * plotW;
    const toY = (s: number) => m.top + plotH - ((s - minSkill) / (maxSkill - minSkill || 1)) * plotH;

    // Grid
    ctx.strokeStyle = "#f0f0f0";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = m.top + (plotH / 4) * i;
      ctx.beginPath(); ctx.moveTo(m.left, y); ctx.lineTo(m.left + plotW, y); ctx.stroke();
    }

    // Line
    ctx.strokeStyle = "#8b5cf6";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    nlTest.thetas.forEach((t, i) => {
      const x = toX(t);
      const y = toY(nlTest.skills[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Points
    nlTest.thetas.forEach((t, i) => {
      const x = toX(t);
      const y = toY(nlTest.skills[i]);
      const isBest = t === nlTest.bestTheta;
      ctx.fillStyle = isBest ? "#ef4444" : "#8b5cf6";
      ctx.beginPath(); ctx.arc(x, y, isBest ? 6 : 4, 0, 2 * Math.PI); ctx.fill();
      if (isBest) {
        ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI); ctx.fill();
      }
    });

    // Best theta label
    const bestIdx = nlTest.thetas.indexOf(nlTest.bestTheta);
    if (bestIdx >= 0) {
      ctx.fillStyle = "#ef4444";
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`best θ=${nlTest.bestTheta}`, toX(nlTest.bestTheta), toY(nlTest.skills[bestIdx]) - 10);
    }

    // θ=0 label (linear)
    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("← 線形", m.left + 3, m.top + plotH - 5);
    ctx.textAlign = "right";
    ctx.fillText("非線形 →", m.left + plotW - 3, m.top + plotH - 5);

    // Title
    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("非線形性テスト: S-map ρ(θ)", width / 2, 14);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText("局所性パラメータ θ", width / 2, height - 5);

    // Y axis
    ctx.save();
    ctx.translate(12, m.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("予測スキル ρ", 0, 0);
    ctx.restore();
  }, [nlTest]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        位相空間予測 (Simplex / S-map)
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        Takens埋め込み空間での近傍ベース予測と非線形性テスト
      </p>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3 text-xs">
        <div className={`p-2 rounded ${simplex.correlation > 0.3 ? "bg-green-50" : "bg-gray-50"}`}>
          <div className={simplex.correlation > 0.3 ? "text-green-600" : "text-gray-500"}>Simplexスキル</div>
          <div className="font-bold">ρ = {simplex.correlation.toFixed(3)}</div>
        </div>
        <div className={`p-2 rounded ${smap.correlation > 0.3 ? "bg-blue-50" : "bg-gray-50"}`}>
          <div className={smap.correlation > 0.3 ? "text-blue-600" : "text-gray-500"}>S-mapスキル</div>
          <div className="font-bold">ρ = {smap.correlation.toFixed(3)}</div>
        </div>
        <div className={`p-2 rounded ${nlTest.isNonlinear ? "bg-purple-50" : "bg-gray-50"}`}>
          <div className={nlTest.isNonlinear ? "text-purple-600" : "text-gray-500"}>非線形性</div>
          <div className="font-bold">{nlTest.isNonlinear ? "非線形" : "線形"}</div>
          <div className="text-gray-400">最適θ={nlTest.bestTheta}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">RMSE</div>
          <div className="font-bold">{smap.rmse.toFixed(4)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">パラメータ</div>
          <div className="font-bold text-xs">τ={tau} d={dim}</div>
          <div className="text-gray-400">自動選択</div>
        </div>
      </div>

      {/* theta control */}
      <div className="flex gap-4 mb-3 text-xs">
        <label className="flex items-center gap-2">
          <span className="text-gray-500">S-map θ:</span>
          <input
            type="range" min={0} max={8} step={0.5} value={theta}
            onChange={e => setTheta(Number(e.target.value))}
            className="w-24 accent-purple-600"
          />
          <span className="text-gray-700 font-medium w-6">{theta}</span>
        </label>
      </div>

      {/* Charts */}
      <div className="space-y-3 mb-3">
        <div>
          <div className="text-xs text-gray-500 mb-1">S-map予測値 vs 実測値 (アウトオブサンプル: 後半30%)</div>
          <div ref={predRef} className="w-full rounded border border-gray-100" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-gray-500 mb-1">予測スキル ρ(t) と方向精度</div>
            <div ref={skillRef} className="w-full rounded border border-gray-100" />
          </div>
          <div>
            <canvas ref={thetaCanvasRef} className="w-full rounded border border-gray-100" />
          </div>
        </div>
      </div>

      {/* Best periods */}
      {skill && skill.bestPeriods.length > 0 && (
        <div className="mb-3">
          <div className="text-xs font-medium text-gray-700 mb-1">高スキル期間 (ρ {">"} 0.3)</div>
          <div className="flex flex-wrap gap-2">
            {skill.bestPeriods.slice(0, 5).map((p, i) => (
              <div key={i} className="text-xs bg-green-50 text-green-700 px-2 py-1 rounded">
                {p.start} ~ {p.end} (ρ={p.skill.toFixed(2)})
              </div>
            ))}
          </div>
        </div>
      )}

      <AnalysisGuide title="位相空間予測 (Simplex / S-map) の詳細解説">
        <div className="space-y-3">
          <div>
            <p className="font-medium text-gray-700 mb-1">1. Simplex Projection (Sugihara & May, 1990)</p>
            <p>Takens埋め込み空間上で「現在の状態に似た過去のパターン」を探し、その後の軌道から次のステップを予測する手法です。</p>
            <div className="bg-gray-50 rounded p-2 my-2 font-mono text-xs">
              アルゴリズム:<br/>
              1. 現在の状態ベクトル v(t) = (x(t), x(t-τ), ..., x(t-(d-1)τ))<br/>
              2. ライブラリ(過去データ)から v(t) のk近傍を探索<br/>
              3. k近傍の「次のステップ」を距離の逆数で加重平均:<br/>
              <br/>
              　x̂(t+1) = Σ w_i · x(nn_i + 1) / Σ w_i<br/>
              　w_i = exp(-d_i / d_min)<br/>
              <br/>
              k = d + 1 (埋め込み次元+1 = simplex の頂点数)
            </div>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">2. S-map (局所線形予測)</p>
            <p>Simplexの拡張。各時点で局所的な線形モデルをフィッティングし、非線形性を制御するパラメータθを導入します。</p>
            <div className="bg-gray-50 rounded p-2 my-2 font-mono text-xs">
              重み関数: w_i = exp(-θ · d_i / d̄)<br/>
              <br/>
              θ = 0: 全点に等しい重み → 全体線形モデル (AR相当)<br/>
              θ → ∞: 最近傍のみ → 最も局所的な非線形モデル<br/>
              <br/>
              最適θの選択:<br/>
              θが大きいほうがスキルが良い → 系に非線形性がある<br/>
              θ=0が最良 → 線形モデルで十分
            </div>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">3. 非線形性テスト</p>
            <p>複数のθでS-map予測スキルを比較することで、時系列の非線形性を統計的に検証します。</p>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li><span className="font-medium">θ=0が最良</span> → 線形ダイナミクス → AR/MAモデルで十分 → テクニカル分析の移動平均系が有効</li>
              <li><span className="font-medium">θ{">"}0が最良</span> → 非線形ダイナミクス → 非線形モデルが優位 → パターン認識・機械学習が有効</li>
              <li><span className="font-medium">どのθでもスキルが低い</span> → 予測困難 → パッシブ運用が合理的</li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">4. 予測スキルの時間変化 (メタ戦略指標)</p>
            <p>ローリングウィンドウでの予測スキルρ(t)は、「今の市場が予測しやすいかどうか」を教えてくれる<span className="font-medium">メタ指標</span>です。</p>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li><span className="font-medium text-green-600">スキルが高い期間</span>: 系統的戦略の信頼性が高い → レバレッジ可能</li>
              <li><span className="font-medium text-red-600">スキルが低い期間</span>: ランダム性が支配的 → 待機/ポジション縮小</li>
              <li><span className="font-medium text-orange-600">方向精度 {">"} 60%</span>: 上昇/下落の方向を予測できている → 方向性ベットが有効</li>
            </ul>
          </div>

          <div>
            <p className="font-medium text-gray-700 mb-1">5. 注意点</p>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              <li>アウトオブサンプル(後半30%)で評価しているため、過学習のリスクは低い</li>
              <li>ただし金融市場は非定常であり、過去のスキルが将来のスキルを保証しない</li>
              <li>予測値そのものよりも、<span className="font-medium">スキルの時間変化パターン</span>のほうが実用的</li>
            </ul>
          </div>
        </div>
      </AnalysisGuide>
    </div>
  );
}
