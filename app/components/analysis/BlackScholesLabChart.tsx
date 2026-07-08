"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  bsPrice,
  bsGreeks,
  putCallParityResidual,
  type OptionType,
} from "../../lib/derivatives-core";
import { wholePeriodVol } from "../../lib/ohlc-volatility";
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

const GREEK_META: { key: "delta" | "gamma" | "vega" | "theta"; label: string; color: string }[] = [
  { key: "delta", label: "Δ デルタ", color: "#2563eb" },
  { key: "gamma", label: "Γ ガンマ", color: "#16a34a" },
  { key: "vega", label: "ν ベガ", color: "#d97706" },
  { key: "theta", label: "Θ シータ", color: "#dc2626" },
];

export default function BlackScholesLabChart({ prices }: Props) {
  const payoffRef = useRef<HTMLCanvasElement>(null);
  const greekRef = useRef<HTMLCanvasElement>(null);

  const S0 = prices.length ? prices[prices.length - 1].close : 100;
  const autoSigma = useMemo(() => {
    const w = wholePeriodVol(prices);
    return w ? Math.max(0.05, w.whole.yangZhang) : 0.25;
  }, [prices]);

  const [moneyness, setMoneyness] = useState(1); // K/S
  const [days, setDays] = useState(30);
  const [rPct, setRPct] = useState(0.5);
  const [qPct, setQPct] = useState(0);
  const [useAuto, setUseAuto] = useState(true);
  const [manualSigmaPct, setManualSigmaPct] = useState(25);
  const [type, setType] = useState<OptionType>("call");

  const K = S0 * moneyness;
  const T = days / 365;
  const r = rPct / 100;
  const q = qPct / 100;
  const sigma = useAuto ? autoSigma : manualSigmaPct / 100;

  const cur = useMemo(
    () => ({
      price: bsPrice({ S: S0, K, T, r, q, sigma, type }).price,
      greeks: bsGreeks({ S: S0, K, T, r, q, sigma, type }),
    }),
    [S0, K, T, r, q, sigma, type]
  );

  const parity = useMemo(
    () => putCallParityResidual(S0, K, T, r, q, sigma),
    [S0, K, T, r, q, sigma]
  );

  // ペイオフ図 & 現在価値曲線
  useEffect(() => {
    const cv = payoffRef.current;
    if (!cv) return;
    const R = initCanvas(cv, 260);
    if (!R) return;
    const { ctx, width, height } = R;
    const pad = { top: 16, right: 16, bottom: 28, left: 52 };
    const pw = width - pad.left - pad.right;
    const ph = height - pad.top - pad.bottom;

    const sMin = S0 * 0.6;
    const sMax = S0 * 1.4;
    const nPts = 120;
    const premium = cur.price;

    const payoff = (S: number) =>
      type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
    const value = (S: number) =>
      bsPrice({ S, K, T, r, q, sigma, type }).price;

    // P&L基準（プレミアムを引く）
    const ys: number[] = [];
    for (let i = 0; i <= nPts; i++) {
      const S = sMin + ((sMax - sMin) * i) / nPts;
      ys.push(payoff(S) - premium, value(S) - premium);
    }
    let yMin = Math.min(...ys);
    let yMax = Math.max(...ys);
    const ypad = (yMax - yMin) * 0.1 || 1;
    yMin -= ypad;
    yMax += ypad;

    const toX = (S: number) => pad.left + ((S - sMin) / (sMax - sMin)) * pw;
    const toY = (v: number) => pad.top + ph * (1 - (v - yMin) / (yMax - yMin));

    // grid + 軸
    ctx.strokeStyle = "#eee";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#888";
    ctx.font = "10px sans-serif";
    for (let g = 0; g <= 4; g++) {
      const yy = pad.top + (ph * g) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(width - pad.right, yy);
      ctx.stroke();
      const vv = yMax - ((yMax - yMin) * g) / 4;
      ctx.fillText(vv.toFixed(1), 4, yy + 3);
    }
    // 0ライン
    if (yMin < 0 && yMax > 0) {
      ctx.strokeStyle = "#cbd5e1";
      ctx.beginPath();
      ctx.moveTo(pad.left, toY(0));
      ctx.lineTo(width - pad.right, toY(0));
      ctx.stroke();
    }
    // K と現値の縦線
    ctx.strokeStyle = "#94a3b8";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(toX(K), pad.top);
    ctx.lineTo(toX(K), height - pad.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#64748b";
    ctx.fillText(`K=${K.toFixed(1)}`, toX(K) + 3, pad.top + 10);

    ctx.strokeStyle = "#0ea5e9";
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(toX(S0), pad.top);
    ctx.lineTo(toX(S0), height - pad.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#0284c7";
    ctx.fillText(`S=${S0.toFixed(1)}`, toX(S0) + 3, pad.top + 22);

    // 満期ペイオフ（P&L）
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= nPts; i++) {
      const S = sMin + ((sMax - sMin) * i) / nPts;
      const x = toX(S);
      const y = toY(payoff(S) - premium);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 現在価値（P&L）
    ctx.strokeStyle = "#e11d48";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= nPts; i++) {
      const S = sMin + ((sMax - sMin) * i) / nPts;
      const x = toX(S);
      const y = toY(value(S) - premium);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 凡例
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "#334155";
    ctx.fillText("― 満期ペイオフ", width - pad.right - 150, pad.top + 8);
    ctx.fillStyle = "#e11d48";
    ctx.fillText("― 現在価値(残存T)", width - pad.right - 150, pad.top + 22);
  }, [S0, K, T, r, q, sigma, type, cur.price]);

  // Greeks曲線（原資産価格に対して。各Greekは形状比較のため個別正規化）
  useEffect(() => {
    const cv = greekRef.current;
    if (!cv) return;
    const R = initCanvas(cv, 260);
    if (!R) return;
    const { ctx, width, height } = R;
    const pad = { top: 16, right: 16, bottom: 28, left: 40 };
    const pw = width - pad.left - pad.right;
    const ph = height - pad.top - pad.bottom;

    const sMin = S0 * 0.6;
    const sMax = S0 * 1.4;
    const nPts = 120;
    const toX = (S: number) => pad.left + ((S - sMin) / (sMax - sMin)) * pw;

    // 各Greekの系列を計算
    const series: Record<string, number[]> = { delta: [], gamma: [], vega: [], theta: [] };
    const xs: number[] = [];
    for (let i = 0; i <= nPts; i++) {
      const S = sMin + ((sMax - sMin) * i) / nPts;
      xs.push(S);
      const g = bsGreeks({ S, K, T, r, q, sigma, type });
      series.delta.push(g.delta);
      series.gamma.push(g.gamma);
      series.vega.push(g.vega);
      series.theta.push(g.theta);
    }

    // グリッド
    ctx.strokeStyle = "#eee";
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const yy = pad.top + (ph * g) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(width - pad.right, yy);
      ctx.stroke();
    }
    // 0ライン（正規化後の中央）
    ctx.strokeStyle = "#cbd5e1";
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + ph / 2);
    ctx.lineTo(width - pad.right, pad.top + ph / 2);
    ctx.stroke();
    // K縦線
    ctx.strokeStyle = "#94a3b8";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(toX(K), pad.top);
    ctx.lineTo(toX(K), height - pad.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    // 各Greekを個別正規化して描画
    for (const meta of GREEK_META) {
      const arr = series[meta.key];
      const maxAbs = Math.max(...arr.map((v) => Math.abs(v)), 1e-12);
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i <= nPts; i++) {
        const x = toX(xs[i]);
        const norm = arr[i] / maxAbs; // [-1,1]
        const y = pad.top + ph * (1 - (norm + 1) / 2);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // 凡例
    ctx.font = "10px sans-serif";
    let lx = pad.left + 4;
    for (const meta of GREEK_META) {
      ctx.fillStyle = meta.color;
      ctx.fillText(meta.label, lx, pad.top + 10);
      lx += 70;
    }
  }, [S0, K, T, r, q, sigma, type]);

  const fmt = (v: number, d = 3) => (isFinite(v) ? v.toFixed(d) : "-");

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">Black-Scholes ラボ（ペイオフ・Greeks）</h3>
        <div className="flex gap-1 text-xs">
          {(["call", "put"] as OptionType[]).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`px-2 py-0.5 rounded ${
                type === t ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"
              }`}
            >
              {t === "call" ? "コール" : "プット"}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-gray-500">
        現値 S={S0.toFixed(2)}。市場のIVデータが無いため σ は実現ボラ（Yang-Zhang）で代用。
      </p>

      {/* 操作パネル */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
        <label className="space-y-1">
          <span className="text-gray-500">
            ストライク K/S = {moneyness.toFixed(2)}（K={K.toFixed(1)}）
          </span>
          <input type="range" min={0.6} max={1.4} step={0.01} value={moneyness}
            onChange={(e) => setMoneyness(Number(e.target.value))} className="w-full" />
        </label>
        <label className="space-y-1">
          <span className="text-gray-500">満期 T = {days}日</span>
          <input type="range" min={1} max={365} step={1} value={days}
            onChange={(e) => setDays(Number(e.target.value))} className="w-full" />
        </label>
        <label className="space-y-1">
          <span className="text-gray-500">
            σ = {(sigma * 100).toFixed(1)}%（年率）
          </span>
          <input type="range" min={5} max={100} step={0.5} value={useAuto ? sigma * 100 : manualSigmaPct}
            disabled={useAuto}
            onChange={(e) => setManualSigmaPct(Number(e.target.value))}
            className="w-full disabled:opacity-40" />
        </label>
        <label className="space-y-1">
          <span className="text-gray-500">金利 r = {rPct.toFixed(2)}%</span>
          <input type="range" min={0} max={5} step={0.05} value={rPct}
            onChange={(e) => setRPct(Number(e.target.value))} className="w-full" />
        </label>
        <label className="space-y-1">
          <span className="text-gray-500">配当利回り q = {qPct.toFixed(2)}%</span>
          <input type="range" min={0} max={5} step={0.05} value={qPct}
            onChange={(e) => setQPct(Number(e.target.value))} className="w-full" />
        </label>
        <label className="flex items-center gap-2 text-gray-500">
          <input type="checkbox" checked={useAuto} onChange={(e) => setUseAuto(e.target.checked)} />
          σを実現ボラで自動設定
        </label>
      </div>

      {/* 価格・Greeks サマリ */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs">
        <Stat label="理論価格" value={fmt(cur.price, 2)} />
        <Stat label="Δ デルタ" value={fmt(cur.greeks.delta)} />
        <Stat label="Γ ガンマ" value={fmt(cur.greeks.gamma, 5)} />
        <Stat label="ν ベガ(1%)" value={fmt(cur.greeks.vega / 100, 3)} />
        <Stat label="Θ シータ(日)" value={fmt(cur.greeks.theta / 365, 3)} />
        <Stat label="ρ ロー(1%)" value={fmt(cur.greeks.rho / 100, 3)} />
      </div>

      <div>
        <p className="text-xs font-medium text-gray-600 mb-1">損益図（満期ペイオフ vs 現在価値）</p>
        <canvas ref={payoffRef} className="w-full rounded border border-gray-100" />
      </div>
      <div>
        <p className="text-xs font-medium text-gray-600 mb-1">
          Greeks曲線（横軸=原資産価格。各Greekは形状比較のため個別正規化）
        </p>
        <canvas ref={greekRef} className="w-full rounded border border-gray-100" />
      </div>

      {/* パリティ検証 */}
      <div className="text-xs bg-gray-50 rounded p-2">
        <span className="font-medium text-gray-700">プット・コール・パリティ検証: </span>
        C−P = {fmt(parity.lhs, 3)} / S·e^(−qT)−K·e^(−rT) = {fmt(parity.rhs, 3)} → 残差 ={" "}
        <span className={Math.abs(parity.residual) < 1e-4 ? "text-green-600" : "text-red-600"}>
          {parity.residual.toExponential(2)}
        </span>
        （理論上0。BS価格は無裁定なので一致する）
      </div>

      <AnalysisGuide title="Black-Scholes とGreeksの詳細理論">
        <p className="font-medium text-gray-700">1. 何を計算しているか</p>
        <p>
          オプションは「将来ある価格Kで売買する権利」です。コール（買う権利）の満期価値は
          max(S−K,0)、プット（売る権利）は max(K−S,0)。この図の黒線が満期ペイオフ、赤線が
          残存期間Tでの現在価値（時間価値を含む）です。両者の差＝時間価値で、満期に近づくと
          赤線は黒線に収束します。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. Black-Scholes 価格式</p>
        <p>{"C = S·e^(−qT)·N(d₁) − K·e^(−rT)·N(d₂)"}</p>
        <p>{"P = K·e^(−rT)·N(−d₂) − S·e^(−qT)·N(−d₁)"}</p>
        <p>{"d₁ = [ln(S/K) + (r − q + σ²/2)·T] / (σ·√T),  d₂ = d₁ − σ·√T"}</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>S=原資産価格、K=行使価格、T=満期までの年数、r=無リスク金利、q=配当利回り、σ=年率ボラティリティ。</li>
          <li>N(·)=標準正規分布の累積分布関数（CDF）。</li>
          <li>核心: σ以外は市場で観測できる。オプションは「上がるか下がるか」ではなく「どれだけ動くか(σ)」を売買している。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. Greeks（リスク感応度）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>Δ デルタ</b> = ∂V/∂S：原資産1動くと何動くか＝実効株数＝ヘッジ枚数。</li>
          <li><b>Γ ガンマ</b> = ∂²V/∂S²：デルタの変化率。ATM・満期近で最大。ヘッジのズレやすさ。</li>
          <li><b>ν ベガ</b> = ∂V/∂σ：ボラが1%上がると幾ら増えるか＝ボラ・エクスポージャー。</li>
          <li><b>Θ シータ</b> = ∂V/∂t：1日の時間価値の目減り（買い手には通常マイナス）。</li>
          <li><b>ρ ロー</b> = ∂V/∂r：金利感応度（実務では相対的に小さい）。</li>
          <li>ガンマとシータはトレードオフ：買い手は「大きく動けば+Γで儲かるが、動かないと−Θで削られる」。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>デルタはコールで0→1、プットで−1→0のS字。ATM付近で約±0.5。</li>
          <li>ガンマ・ベガはATMで山なり。満期を延ばすとベガが増える（遠い満期ほどボラ感応度大）。</li>
          <li>σを上げると価格・ベガが増え、ペイオフの現在価値曲線が上に膨らむ。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>デルタ＝実効的な株式エクスポージャー。保有オプションのデルタ合計で「実質何株分か」を把握。</li>
          <li>「大きく動くと思う」→ロングガンマ（買い）、「動かない・IVが高すぎる」→ショートガンマ（売り）。</li>
          <li>プット・コール・パリティ C−P=S·e^(−qT)−K·e^(−rT) は合成ポジション（現物＝コール買い＋プット売り）の基礎。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>BSは①対数正規分布②σ一定③連続取引・コストゼロを仮定。実際はファットテール・ボラスマイルでズレる。</li>
          <li>本ラボのσは実現ボラの代用。実際の市場IVはOTMプットで高い（スキュー＝暴落プレミアム）ため、テールの価格は過小評価になりうる。</li>
          <li>ヨーロピアン型（満期のみ行使）を仮定。アメリカン型の早期行使価値は含まない。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-2 rounded border border-gray-200 bg-gray-50">
      <div className="text-gray-500">{label}</div>
      <div className="font-mono font-medium">{value}</div>
    </div>
  );
}
