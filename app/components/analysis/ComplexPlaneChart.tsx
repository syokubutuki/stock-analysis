"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { logReturns } from "../../lib/transforms";
import {
  ComplexPoint,
  analyticTrajectory,
  delayEmbedding,
  morletTrajectory,
  resonancePhasor,
  trajectoryStats,
} from "../../lib/complex-plane";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

type Method = "analytic" | "delay" | "morlet" | "phasor";

const METHODS: { key: Method; label: string; axes: [string, string] }[] = [
  { key: "analytic", label: "解析信号", axes: ["x(t)", "H[x](t)"] },
  { key: "delay", label: "遅延埋め込み", axes: ["x(t)", "x(t−τ)"] },
  { key: "morlet", label: "Morletウェーブレット", axes: ["Re W(t)", "Im W(t)"] },
  { key: "phasor", label: "共鳴フェーザ", axes: ["Re Σ", "Im Σ"] },
];

export default function ComplexPlaneChart({ prices, seriesMode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [method, setMethod] = useState<Method>("analytic");
  const [tau, setTau] = useState(5);
  const [period, setPeriod] = useState(21);
  const [phasorPeriod, setPhasorPeriod] = useState(21);

  // 解析信号・ウェーブレット・フェーザは定常なリターン系列で計算。
  // 遅延埋め込みは「水準」のアトラクタが意味を持つので元系列をそのまま使う。
  const { values } = extractSeries(prices, seriesMode);
  const needsTransform = seriesMode === "close" || seriesMode === "open";
  const lr = useMemo(
    () => (needsTransform ? logReturns(values) : values),
    [prices, seriesMode]
  );

  const points: ComplexPoint[] = useMemo(() => {
    switch (method) {
      case "analytic":
        return analyticTrajectory(lr);
      case "delay":
        return delayEmbedding(values, tau);
      case "morlet":
        return morletTrajectory(lr, period);
      case "phasor":
        return resonancePhasor(lr, 1 / phasorPeriod);
    }
  }, [method, lr, values, tau, period, phasorPeriod]);

  const stats = useMemo(() => trajectoryStats(points), [points]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const size = Math.min(parent.clientWidth, 420);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);

    const n = points.length;
    if (n < 2) return;

    // データ範囲 (原点を含む対称な枠に)
    let maxAbs = 0;
    for (const p of points) {
      maxAbs = Math.max(maxAbs, Math.abs(p.re), Math.abs(p.im));
    }
    if (maxAbs === 0) maxAbs = 1;

    const pad = 36;
    const plot = size - pad * 2;
    const cx = pad + plot / 2;
    const cy = pad + plot / 2;
    const scale = (plot / 2) / (maxAbs * 1.05);

    const X = (re: number) => cx + re * scale;
    const Y = (im: number) => cy - im * scale;

    // グリッド (十字)
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, cy);
    ctx.lineTo(size - pad, cy);
    ctx.moveTo(cx, pad);
    ctx.lineTo(cx, size - pad);
    ctx.stroke();

    // 同心円 (距離ガイド)
    ctx.strokeStyle = "#f1f5f9";
    for (let r = 0.25; r <= 1.0; r += 0.25) {
      ctx.beginPath();
      ctx.arc(cx, cy, (plot / 2) * r, 0, 2 * Math.PI);
      ctx.stroke();
    }

    // 軌跡 (時間で青→赤グラデーション)
    ctx.lineWidth = 1;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const r = Math.round(37 + t * 200);
      const g = Math.round(99 - t * 60);
      const b = Math.round(235 - t * 180);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.55)`;
      ctx.beginPath();
      ctx.moveTo(X(points[i - 1].re), Y(points[i - 1].im));
      ctx.lineTo(X(points[i].re), Y(points[i].im));
      ctx.stroke();
    }

    // 始点 (緑) と 終点 (赤)
    ctx.fillStyle = "#10b981";
    ctx.beginPath();
    ctx.arc(X(points[0].re), Y(points[0].im), 4, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.arc(X(points[n - 1].re), Y(points[n - 1].im), 4.5, 0, 2 * Math.PI);
    ctx.fill();

    // 軸ラベル
    const m = METHODS.find((mm) => mm.key === method)!;
    ctx.fillStyle = "#6b7280";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(m.axes[0], size - pad, cy - 6);
    ctx.textAlign = "left";
    ctx.fillText(m.axes[1], cx + 6, pad + 4);
  }, [points, method]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        複素平面の時間発展 (Argand平面軌跡)
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        株価時系列を複素平面上の点列として描き、時間発展を軌跡で可視化 — 4方式を切替
      </p>

      {/* 方式セレクタ */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {METHODS.map((m) => (
          <button
            key={m.key}
            onClick={() => setMethod(m.key)}
            className={`px-3 py-1 text-xs rounded border transition-colors ${
              method === m.key
                ? "bg-blue-600 text-white border-blue-600"
                : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* 方式別パラメータ */}
      <div className="mb-3 text-xs text-gray-600 h-6 flex items-center">
        {method === "delay" && (
          <label className="flex items-center gap-2">
            遅延 τ = {tau} 日
            <input
              type="range" min={1} max={60} value={tau}
              onChange={(e) => setTau(Number(e.target.value))}
              className="w-48"
            />
          </label>
        )}
        {method === "morlet" && (
          <label className="flex items-center gap-2">
            中心周期 = {period} 日
            <input
              type="range" min={3} max={120} value={period}
              onChange={(e) => setPeriod(Number(e.target.value))}
              className="w-48"
            />
          </label>
        )}
        {method === "phasor" && (
          <label className="flex items-center gap-2">
            共鳴周期 1/f = {phasorPeriod} 日
            <input
              type="range" min={2} max={120} value={phasorPeriod}
              onChange={(e) => setPhasorPeriod(Number(e.target.value))}
              className="w-48"
            />
          </label>
        )}
        {method === "analytic" && (
          <span className="text-gray-400">パラメータなし — Hilbert変換による解析信号</span>
        )}
      </div>

      {/* 統計カード */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <StatCard label="正味変位" value={stats.netDisplacement.toFixed(4)} />
        <StatCard label="軌跡長" value={stats.pathLength.toFixed(3)} />
        <StatCard
          label="直進効率"
          value={stats.efficiency.toFixed(3)}
          sub={stats.efficiency > 0.3 ? "ドリフト傾向" : "往復・回転"}
        />
        <StatCard label="原点まわり回転数" value={`${stats.winding.toFixed(1)} 回`} />
      </div>

      {/* 複素平面 Canvas */}
      <div className="flex flex-col sm:flex-row gap-4 items-start">
        <div>
          <canvas ref={canvasRef} className="rounded border border-gray-100" />
          <div className="text-xs text-gray-400 mt-1">
            横軸=実部, 縦軸=虚部, 色=時間(青→赤), 緑点=始点, 赤点=最新
          </div>
        </div>
        <div className="text-xs text-gray-600 space-y-2 flex-1 min-w-0">
          {method === "analytic" && (
            <p>z(t)=x(t)+i·H[x](t)。原点まわりの回転が振動サイクル、半径がボラティリティ。一定半径の円運動は安定した周期性、半径の伸縮はボラの変化を表す。</p>
          )}
          {method === "delay" && (
            <p>z(t)=x(t)+i·x(t−τ)。トレンド相場は対角線上に伸び、レンジ相場は原点付近のループになる。アトラクタの広がり方で相場構造を読む。</p>
          )}
          {method === "morlet" && (
            <p>指定周期の成分だけを複素ウェーブレットで抽出。その周期のサイクルが活発な区間では大きく回転し、無効な区間では原点付近に縮む。</p>
          )}
          {method === "phasor" && (
            <p>各リターンを位相回転させて累積。指定周期の成分が持続すると原点から離れていく(共鳴)。原点付近に留まるなら、その周期に有意な周期性はない。</p>
          )}
          <div className="p-2 bg-gray-50 rounded">
            <span className="font-medium">直進効率</span>が高いほど一方向のドリフト(トレンド)、低いほど往復・回転(レンジ/サイクル)が支配的。
          </div>
        </div>
      </div>

      <AnalysisGuide title="複素平面表現の詳細理論">
        <p className="font-medium text-gray-700">1. なぜ複素平面に描くのか</p>
        <p>
          実数の株価系列 x(t) は「大きさ」しか持ちませんが、振動現象を理解するには
          「いまサイクルのどの位相にいるか」という角度の情報が欲しくなります。
          適切な方法で虚部を付加して複素数 z(t)=a+bi にすると、
          <strong>大きさ(半径 |z|)と位相(角度 arg z)を同時に</strong>扱え、
          時間発展を平面上の軌跡(Argand図)として一望できます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 4方式の数式</p>
        <p className="mt-1"><strong>(1) 解析信号:</strong>{" "}
          {"z(t) = x(t) + i·H[x](t) = A(t)·e^{iφ(t)}"}。
          Hilbert変換 H は各周波数成分の位相を90°ずらす演算(cos→sin)で、
          周波数領域では負の周波数成分を消去することに相当します。
          半径 A(t)=|z| が瞬時振幅、角度 φ(t)=arg z が瞬時位相です。
        </p>
        <p className="mt-1"><strong>(2) 遅延座標埋め込み:</strong>{" "}
          {"z(t) = x(t) + i·x(t−τ)"}。
          τ だけ過去の値を虚軸に取り、Takensの埋め込み定理に基づき
          1次元時系列から力学系のアトラクタ(軌道の幾何形状)を再構成します。
          τ は通常、自己相関が最初に 1/e へ減衰するラグや相互情報量の最初の極小に選びます。
        </p>
        <p className="mt-1"><strong>(3) 複素Morletウェーブレット:</strong>{" "}
          {"ψ(t) = π^{-1/4}·e^{iω₀t}·e^{-t²/2}"}、変換{" "}
          {"W(t) = Σ_k x(k)·ψ*((k−t)/s)/√s"}。
          スケール s を中心周期に対応させ(ω₀=6 で周期 λ≈1.03·s)、
          特定の周期成分だけを複素数として取り出します。解析信号を1つの周波数帯に絞った版です。
        </p>
        <p className="mt-1"><strong>(4) 累積共鳴フェーザ:</strong>{" "}
          {"z_k = Σ_{j≤k} r_j·e^{-i·2πf·j}"}。
          対数リターン r_j を周波数 f で位相回転させながら足し上げます。
          これは離散フーリエ変換の部分和で、f がリターンの実際の周期成分と一致すると
          ベクトルが揃って原点から離れ(共鳴)、一致しなければ打ち消し合って原点付近に留まります。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 直感的な例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>解析信号 = 回転する観覧車。半径が今日の「揺れの大きさ」、角度が「サイクルの位置」。</li>
          <li>遅延埋め込み = 今日と過去を一組にした足跡。まっすぐ歩けばトレンド、足踏みすればレンジ。</li>
          <li>共鳴フェーザ = 一定リズムでブランコを押す実験。リズムが固有周期に合えば大きく揺れていく。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>直進効率(正味変位/軌跡長)</strong>: 1に近い=一方向ドリフト(トレンド)、0に近い=往復・回転(レンジ/周期)。</li>
          <li><strong>回転数</strong>: 原点まわりに何周したか。多いほど周期的な振動が継続。</li>
          <li><strong>半径の伸縮</strong>: ボラティリティの拡大・縮小。</li>
          <li>解析信号・Morletで<strong>滑らかな円</strong>=安定した周期、<strong>不規則な渦</strong>=非定常・広帯域。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>遅延埋め込みでアトラクタが対角線方向に伸びていればトレンドフォロー、原点周回ならレンジ戦略(逆張り)に傾ける。</li>
          <li>共鳴フェーザの周期スライダを動かし、原点から大きく離れる周期=その銘柄が持つ卓越周期。カレンダー戦略の周期選定に使える。</li>
          <li>解析信号の半径(瞬時振幅)が急拡大=ボラ上昇局面。ポジションサイズの縮小やオプション戦略の検討材料。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>生のリターンは広帯域なので、解析信号の瞬時位相が物理的に無意味になることがある(Bedrosianの定理)。狭帯域成分にはMorletや EMD を使う。</li>
          <li>遅延埋め込みの形状は τ の選び方に強く依存する。複数の τ で頑健性を確認すること。</li>
          <li>共鳴フェーザの「離れ」は系列長に比例して伸びうるため、絶対値でなく周期を変えたときの相対比較で判断する。</li>
          <li>いずれも記述的・可視化の道具であり、それ自体は将来予測を保証しない。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="p-2 bg-gray-50 rounded text-xs">
      <div className="text-gray-500">{label}</div>
      <div className="font-bold text-gray-800">{value}</div>
      {sub && <div className="text-gray-400">{sub}</div>}
    </div>
  );
}
