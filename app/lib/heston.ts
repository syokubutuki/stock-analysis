// Heston確率ボラティリティモデル
// dS/S = μdt + √v_t dW_S
// dv_t = κ(θ - v_t)dt + ξ√v_t dW_v
// Corr(dW_S, dW_v) = ρ

export interface HestonParams {
  mu: number;     // ドリフト
  kappa: number;  // ボラの平均回帰速度
  theta: number;  // ボラの長期平均
  xi: number;     // ボラのボラティリティ (vol of vol)
  rho: number;    // 価格とボラの相関 (通常<0)
  v0: number;     // 初期分散
}

export interface HestonResult {
  params: HestonParams;
  fellerCondition: boolean; // 2κθ > ξ² (分散が正を保つ条件)
  volOfVol: number;
  halfLifeVol: number;     // ボラの半減期 = ln(2)/κ
  paths: { price: number[]; vol: number[] }[];
  percentiles: { p5: number[]; p25: number[]; p50: number[]; p75: number[]; p95: number[] };
  interpretation: string;
}

// --- パラメータ推定 (モーメント法 + 条件付きモーメント) ---
export function fitHeston(returns: number[]): HestonParams {
  const n = returns.length;
  if (n < 100) return defaultParams();

  // 日次リターンの統計
  let m1 = 0, m2 = 0;
  for (const r of returns) { m1 += r; m2 += r * r; }
  m1 /= n; m2 /= n;
  const variance = m2 - m1 * m1;

  // ローリングボラティリティ (20日窓)
  const w = 20;
  const rollingVar: number[] = [];
  for (let i = w; i < n; i++) {
    let s = 0, s2 = 0;
    for (let j = i - w; j < i; j++) { s += returns[j]; s2 += returns[j] ** 2; }
    rollingVar.push(s2 / w - (s / w) ** 2);
  }

  if (rollingVar.length < 50) return defaultParams();

  // θ: 分散の長期平均
  let thetaEst = 0;
  for (const v of rollingVar) thetaEst += v;
  thetaEst /= rollingVar.length;
  thetaEst *= 252; // annualize

  // κ: 分散の平均回帰速度 (AR(1)係数から推定)
  let svx = 0, svx2 = 0, svy = 0, svxy = 0;
  for (let i = 1; i < rollingVar.length; i++) {
    svx += rollingVar[i - 1];
    svx2 += rollingVar[i - 1] ** 2;
    svy += rollingVar[i];
    svxy += rollingVar[i] * rollingVar[i - 1];
  }
  const nv = rollingVar.length - 1;
  const denomV = nv * svx2 - svx * svx;
  const phiV = denomV > 0 ? (nv * svxy - svx * svy) / denomV : 0.99;
  const kappaEst = Math.max(0.1, -Math.log(Math.max(phiV, 0.01)) * 252 / w);

  // ξ: vol of vol (分散変化のstd)
  const dv: number[] = [];
  for (let i = 1; i < rollingVar.length; i++) dv.push(rollingVar[i] - rollingVar[i - 1]);
  let dvVar = 0;
  const dvMean = dv.reduce((s, v) => s + v, 0) / dv.length;
  for (const d of dv) dvVar += (d - dvMean) ** 2;
  dvVar /= dv.length;
  const xiEst = Math.sqrt(dvVar * 252) / Math.sqrt(Math.max(thetaEst, 1e-6));

  // ρ: リターンとボラ変化の相関
  let corrNum = 0, corrDenR = 0, corrDenV = 0;
  const rMean = m1;
  for (let i = 1; i < Math.min(rollingVar.length, n - w); i++) {
    const r = returns[i + w - 1] - rMean;
    const v = dv[i - 1] - dvMean;
    corrNum += r * v;
    corrDenR += r * r;
    corrDenV += v * v;
  }
  const rhoEst = corrDenR > 0 && corrDenV > 0
    ? corrNum / Math.sqrt(corrDenR * corrDenV)
    : -0.5;

  const v0 = rollingVar[rollingVar.length - 1] * 252;

  return {
    mu: m1 * 252,
    kappa: Math.min(kappaEst, 20),
    theta: thetaEst,
    xi: Math.min(Math.max(xiEst, 0.1), 5),
    rho: Math.max(-0.99, Math.min(0.99, rhoEst)),
    v0: Math.max(v0, 0.001),
  };
}

// --- シミュレーション ---
export function simulateHeston(
  params: HestonParams,
  startPrice: number,
  days: number,
  numPaths: number = 500,
  seed: number = 42
): HestonResult {
  const { mu, kappa, theta, xi, rho, v0 } = params;
  const dt = 1 / 252;
  const sqrtDt = Math.sqrt(dt);

  const paths: { price: number[]; vol: number[] }[] = [];
  let rng = mulberry32(seed);

  for (let p = 0; p < numPaths; p++) {
    let s = startPrice;
    let v = v0;
    const pricePath = [s];
    const volPath = [Math.sqrt(v)];

    for (let t = 0; t < days; t++) {
      const z1 = boxMuller(rng);
      rng = mulberry32(seed + p * 10000 + t * 7 + 1);
      const z2temp = boxMuller(rng);
      rng = mulberry32(seed + p * 10000 + t * 7 + 3);
      const z2 = rho * z1 + Math.sqrt(1 - rho * rho) * z2temp;

      // Euler-Maruyama with full truncation
      const vPlus = Math.max(v, 0);
      const sqrtV = Math.sqrt(vPlus);

      s = s * Math.exp((mu - 0.5 * vPlus) * dt + sqrtV * sqrtDt * z1);
      v = v + kappa * (theta - vPlus) * dt + xi * sqrtV * sqrtDt * z2;

      pricePath.push(Math.max(s, 0.001));
      volPath.push(Math.sqrt(Math.max(v, 0)));
    }

    paths.push({ price: pricePath, vol: volPath });
  }

  // Percentiles
  const p5: number[] = [];
  const p25: number[] = [];
  const p50: number[] = [];
  const p75: number[] = [];
  const p95: number[] = [];

  for (let t = 0; t <= days; t++) {
    const vals = paths.map(path => path.price[t]).sort((a, b) => a - b);
    p5.push(vals[Math.floor(numPaths * 0.05)]);
    p25.push(vals[Math.floor(numPaths * 0.25)]);
    p50.push(vals[Math.floor(numPaths * 0.50)]);
    p75.push(vals[Math.floor(numPaths * 0.75)]);
    p95.push(vals[Math.floor(numPaths * 0.95)]);
  }

  const fellerCondition = 2 * kappa * theta > xi * xi;
  const halfLifeVol = kappa > 0 ? Math.log(2) / kappa * 252 : Infinity;
  const volOfVol = xi;

  const interpretation =
    `Heston推定: κ=${kappa.toFixed(2)}(vol回帰速度), θ=${(Math.sqrt(theta) * 100).toFixed(1)}%(長期vol), ξ=${xi.toFixed(2)}(vol of vol), ρ=${rho.toFixed(3)}(価格-vol相関)。` +
    (fellerCondition
      ? `Feller条件を満たし、分散は常に正。`
      : `Feller条件を満たさず、分散がゼロになる可能性あり。`) +
    (rho < -0.3
      ? ` ρ<0でレバレッジ効果（下落時にvol上昇）を確認。`
      : ``);

  return {
    params,
    fellerCondition,
    volOfVol,
    halfLifeVol,
    paths: paths.slice(0, 10),
    percentiles: { p5, p25, p50, p75, p95 },
    interpretation,
  };
}

function defaultParams(): HestonParams {
  return { mu: 0.05, kappa: 2, theta: 0.04, xi: 0.5, rho: -0.7, v0: 0.04 };
}

function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function boxMuller(rng: () => number): number {
  const u1 = rng() || 1e-10;
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
