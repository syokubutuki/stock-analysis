// z平面ポールマップ (Z-plane Pole Map)
//
// 時系列に AR(p) モデル  x_t = φ₁x_{t-1} + … + φ_p x_{t-p} + e_t  を当てはめ、
// その特性多項式  z^p − φ₁z^{p-1} − … − φ_p = 0  の根（＝極）を複素z平面に描く。
//
//   極の絶対値 |z|  … 持続性。1（単位円）に近いほど記憶が長く、非定常に近い。
//                     |z|<1 なら定常。|z|>1 は発散（非定常）。
//   極の偏角 θ      … 周期。period = 2π/|θ| [bar]。θ≈0 の実極はトレンド的持続、
//                     θ=π の負実極は period=2 の交互変動。
//   複素共役対      … 減衰振動（サイクル）。単位円に近い共役対＝卓越周期。
//
// AR係数は Yule-Walker 方程式を Levinson-Durbin 再帰で解いて推定し、
// 根は Durand-Kerner 法（Weierstrass反復）で同時に求める。すべて自前実装。

export interface Complex {
  re: number;
  im: number;
}

export interface Pole {
  re: number;
  im: number;
  modulus: number; // |z|（持続性）
  angleDeg: number; // 偏角 [度]
  period: number; // 周期 = 2π/|θ| [bar]（θ≈0 は Infinity）
  halfLife: number; // 半減期 = ln(0.5)/ln|z| [bar]（|z|≥1 は Infinity）
}

export interface ARFit {
  order: number;
  coeffs: number[]; // φ₁..φ_p
  sigma2: number; // 残差分散
  aic: number;
  poles: Pole[];
  stationary: boolean; // 全極が単位円内か
  dominant: Pole | null; // 単位円に最も近い極
}

// ---- 自己共分散 ----
function autocovariance(x: number[], maxLag: number): number[] {
  const n = x.length;
  const mean = x.reduce((a, b) => a + b, 0) / n;
  const g = new Array<number>(maxLag + 1).fill(0);
  for (let k = 0; k <= maxLag; k++) {
    let s = 0;
    for (let t = k; t < n; t++) s += (x[t] - mean) * (x[t - k] - mean);
    g[k] = s / n;
  }
  return g;
}

// ---- Levinson-Durbin: Yule-Walker を解いて AR(p) 係数と残差分散を返す ----
function levinsonDurbin(
  gamma: number[],
  p: number
): { coeffs: number[]; sigma2: number } {
  if (gamma[0] <= 0) return { coeffs: new Array(p).fill(0), sigma2: 0 };
  let phi = new Array<number>(p + 1).fill(0);
  let sigma2 = gamma[0];
  for (let k = 1; k <= p; k++) {
    let acc = gamma[k];
    for (let j = 1; j < k; j++) acc -= phi[j] * gamma[k - j];
    const reflect = sigma2 > 1e-12 ? acc / sigma2 : 0;
    const newPhi = phi.slice();
    newPhi[k] = reflect;
    for (let j = 1; j < k; j++) newPhi[j] = phi[j] - reflect * phi[k - j];
    phi = newPhi;
    sigma2 *= 1 - reflect * reflect;
    if (sigma2 < 0) sigma2 = 0;
  }
  return { coeffs: phi.slice(1, p + 1), sigma2 };
}

// ---- 複素演算 ----
const cAdd = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
const cSub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im });
const cMul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
const cDiv = (a: Complex, b: Complex): Complex => {
  const d = b.re * b.re + b.im * b.im;
  if (d < 1e-300) return { re: 0, im: 0 };
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};

// ---- Durand-Kerner: モニック多項式の全根を同時に求める ----
// coeffs は最高次から: p(z) = z^n + c[0] z^{n-1} + … + c[n-1]
function durandKerner(coeffs: number[]): Complex[] {
  const n = coeffs.length;
  if (n === 0) return [];
  // 初期値: 0.4+0.9i の冪（Aberth の慣用初期配置）
  const seed: Complex = { re: 0.4, im: 0.9 };
  let roots: Complex[] = [];
  let cur: Complex = { re: 1, im: 0 };
  for (let i = 0; i < n; i++) {
    roots.push({ ...cur });
    cur = cMul(cur, seed);
  }
  const evalP = (z: Complex): Complex => {
    // ホーナー法: z^n + c[0]z^{n-1}+…
    let acc: Complex = { re: 1, im: 0 };
    for (let i = 0; i < n; i++) acc = cAdd(cMul(acc, z), { re: coeffs[i], im: 0 });
    return acc;
  };
  for (let iter = 0; iter < 200; iter++) {
    let maxDelta = 0;
    const next: Complex[] = roots.slice();
    for (let i = 0; i < n; i++) {
      let denom: Complex = { re: 1, im: 0 };
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        denom = cMul(denom, cSub(roots[i], roots[j]));
      }
      const delta = cDiv(evalP(roots[i]), denom);
      next[i] = cSub(roots[i], delta);
      maxDelta = Math.max(maxDelta, Math.hypot(delta.re, delta.im));
    }
    roots = next;
    if (maxDelta < 1e-12) break;
  }
  return roots;
}

function toPole(z: Complex): Pole {
  const modulus = Math.hypot(z.re, z.im);
  const theta = Math.atan2(z.im, z.re);
  const absTheta = Math.abs(theta);
  const period = absTheta > 1e-6 ? (2 * Math.PI) / absTheta : Infinity;
  const halfLife =
    modulus > 0 && modulus < 1 ? Math.log(0.5) / Math.log(modulus) : Infinity;
  return {
    re: z.re,
    im: z.im,
    modulus,
    angleDeg: (theta * 180) / Math.PI,
    period,
    halfLife,
  };
}

// ---- AR(p) を当てはめて極を計算 ----
export function fitARPoles(values: number[], order: number): ARFit {
  const n = values.length;
  const p = Math.max(1, Math.min(order, Math.floor(n / 3)));
  const gamma = autocovariance(values, p);
  const { coeffs, sigma2 } = levinsonDurbin(gamma, p);

  // 特性多項式 z^p − φ₁z^{p-1} − … − φ_p のモニック係数（最高次を除く）
  const monic = coeffs.map((c) => -c); // c[0]=−φ₁, …, c[p-1]=−φ_p
  const roots = durandKerner(monic);
  const poles = roots.map(toPole).sort((a, b) => b.modulus - a.modulus);

  const aic =
    sigma2 > 0 ? n * Math.log(sigma2) + 2 * (p + 1) : Number.POSITIVE_INFINITY;
  const stationary = poles.every((pl) => pl.modulus < 1);
  const dominant = poles.length > 0 ? poles[0] : null;

  return { order: p, coeffs, sigma2, aic, poles, stationary, dominant };
}

// ---- AIC でAR次数を自動選択 ----
export function selectARByAic(values: number[], maxOrder: number): ARFit {
  let best: ARFit | null = null;
  const cap = Math.min(maxOrder, Math.floor(values.length / 3));
  for (let p = 1; p <= cap; p++) {
    const fit = fitARPoles(values, p);
    if (!best || fit.aic < best.aic) best = fit;
  }
  return best ?? fitARPoles(values, 1);
}
