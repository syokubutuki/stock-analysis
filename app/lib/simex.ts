import { PricePoint } from "./types";

// ============================================================================
// SIMEX (Simulation-Extrapolation) によるノイズ減衰の補正
// ----------------------------------------------------------------------------
// 測定ノイズで縮んだ推定量を、わざとノイズを段階的に足して劣化曲線を描き、
// 「ノイズ0」へ外挿して回復する手法。
// 本実装では短期反転/モメンタムの予測係数
//     r(t+1) = α + θ·r(t) + ε       （θ<0 なら平均回帰、θ>0 ならモメンタム）
// を対象にする。説明変数 r(t) にはマイクロ構造ノイズが乗っており、θは0方向へ
// 縮む(減衰)。ノイズ分散を Roll 法(=−1次自己共分散)で見積もり、SIMEXで真のθを
// 推定する。
// ============================================================================

export interface SimexPoint {
  zeta: number; // 追加ノイズ倍率
  theta: number; // その水準での平均推定係数
}

export interface SimexResult {
  n: number;
  naiveSlope: number; // θ(ζ=0) 観測される素朴な係数
  correctedSlope: number; // θ(ζ=−1) ノイズ0へ外挿した係数
  curve: SimexPoint[];
  fit: { a: number; b: number; c: number }; // θ(ζ)=a+bζ+cζ²
  sigmaUPct: number; // 価格の測定ノイズ標準偏差 %
  noiseShare: number; // 戻り値分散に占めるノイズ割合
  attenuationPct: number; // 補正で何%増えたか |corrected|/|naive|−1
  reverting: boolean; // 補正後θ<0 か(平均回帰)
}

// 簡易シード付きRNG (mulberry32) + Box-Muller 正規乱数
function makeRng(seed: number) {
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randn(rng: () => number): number {
  let u = 0,
    v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// y を x に回帰した傾き
function slope(x: number[], y: number[]): number {
  const n = x.length;
  let mx = 0,
    my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let cov = 0,
    vx = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    cov += dx * (y[i] - my);
    vx += dx * dx;
  }
  return vx > 0 ? cov / vx : 0;
}

// (zeta, theta) 5点に θ=a+bζ+cζ² を最小二乗フィット
function quadFit(pts: SimexPoint[]): { a: number; b: number; c: number } {
  // 正規方程式 (3×3)
  let S0 = 0,
    S1 = 0,
    S2 = 0,
    S3 = 0,
    S4 = 0,
    T0 = 0,
    T1 = 0,
    T2 = 0;
  for (const { zeta: z, theta: th } of pts) {
    const z2 = z * z;
    S0 += 1;
    S1 += z;
    S2 += z2;
    S3 += z2 * z;
    S4 += z2 * z2;
    T0 += th;
    T1 += th * z;
    T2 += th * z2;
  }
  // [S0 S1 S2; S1 S2 S3; S2 S3 S4] [a b c]' = [T0 T1 T2]'
  const M = [
    [S0, S1, S2, T0],
    [S1, S2, S3, T1],
    [S2, S3, S4, T2],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++)
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let c = col; c <= 3; c++) M[col][c] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c <= 3; c++) M[r][c] -= f * M[col][c];
    }
  }
  return { a: M[0][3], b: M[1][3], c: M[2][3] };
}

export function simexReversal(
  prices: PricePoint[],
  reps = 40
): SimexResult | null {
  const n0 = prices.length;
  if (n0 < 120) return null;

  const logP = prices.map((p) => Math.log(p.close));
  const ret: number[] = [];
  for (let i = 1; i < n0; i++) ret.push(logP[i] - logP[i - 1]);
  const n = ret.length;

  // 戻り値の分散・1次自己共分散 → Roll型ノイズ分散
  const mean = ret.reduce((a, v) => a + v, 0) / n;
  let g0 = 0,
    g1 = 0;
  for (let i = 0; i < n; i++) g0 += (ret[i] - mean) ** 2;
  for (let i = 1; i < n; i++) g1 += (ret[i] - mean) * (ret[i - 1] - mean);
  g0 /= n;
  g1 /= n;
  const sigmaU2 = Math.max(0, -g1); // 価格ノイズ分散 σ_u²
  const noiseVarRet = 2 * sigmaU2; // 戻り値に乗るノイズ分散(u_t−u_{t-1})
  const noiseShare = g0 > 0 ? noiseVarRet / g0 : 0;

  // 回帰用ペア x=r(t), y=r(t+1)
  const x0 = ret.slice(0, n - 1);
  const y = ret.slice(1);

  const naiveSlope = slope(x0, y);

  const zetas = [0, 0.5, 1, 1.5, 2];
  const rng = makeRng(12345);
  const curve: SimexPoint[] = [];
  for (const z of zetas) {
    if (z === 0) {
      curve.push({ zeta: 0, theta: naiveSlope });
      continue;
    }
    const sd = Math.sqrt(z * noiseVarRet);
    let acc = 0;
    for (let b = 0; b < reps; b++) {
      const xn = x0.map((v) => v + sd * randn(rng));
      acc += slope(xn, y);
    }
    curve.push({ zeta: z, theta: acc / reps });
  }

  const fit = quadFit(curve);
  // ζ=−1 へ外挿(ノイズ0)
  const correctedSlope = fit.a - fit.b + fit.c;

  const attenuationPct =
    Math.abs(naiveSlope) > 1e-9
      ? (Math.abs(correctedSlope) / Math.abs(naiveSlope) - 1) * 100
      : 0;

  return {
    n,
    naiveSlope,
    correctedSlope,
    curve,
    fit,
    sigmaUPct: Math.sqrt(sigmaU2) * 100,
    noiseShare,
    attenuationPct,
    reverting: correctedSlope < 0,
  };
}
