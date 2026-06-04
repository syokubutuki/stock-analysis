// Ornstein-Uhlenbeck (OU) 平均回帰プロセス
// dX_t = θ(μ - X_t)dt + σ dW_t

export interface OUParams {
  theta: number;   // 回帰速度
  mu: number;      // 長期平均
  sigma: number;   // ボラティリティ
  halfLife: number; // 半減期 = ln(2)/θ
}

export interface OUResult {
  params: OUParams;
  residuals: number[];
  rSquared: number;
  interpretation: string;
}

export interface RollingHalfLife {
  time: string;
  halfLife: number;
  theta: number;
}

export interface MeanReversionResult {
  ou: OUResult;
  rollingHL: RollingHalfLife[];
  vrRatio: number; // Variance Ratio (簡易版)
  hurst: number;   // R/S法によるHurst指数推定
}

// --- OU パラメータ推定 (最小二乗法) ---
// X_{t+1} - X_t = θ(μ - X_t)Δt + σ√Δt ε
// → ΔX = a + b*X_t + ε  where b = -θΔt, a = θμΔt
export function fitOU(values: number[], dt: number = 1): OUResult {
  const n = values.length;
  if (n < 20) return emptyOU();

  const dx: number[] = [];
  const x: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(values[i + 1] - values[i]);
    x.push(values[i]);
  }

  const m = dx.length;

  // OLS: ΔX = a + b*X
  let sx = 0, sx2 = 0, sy = 0, sxy = 0;
  for (let i = 0; i < m; i++) {
    sx += x[i];
    sx2 += x[i] * x[i];
    sy += dx[i];
    sxy += x[i] * dx[i];
  }

  const denom = m * sx2 - sx * sx;
  if (Math.abs(denom) < 1e-15) return emptyOU();

  const b = (m * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / m;

  // θ = -b/Δt, μ = -a/b
  const theta = -b / dt;
  const mu = theta > 1e-10 ? -a / b : values.reduce((s, v) => s + v, 0) / n;

  // σ from residual variance
  let sse = 0;
  const residuals: number[] = [];
  for (let i = 0; i < m; i++) {
    const predicted = a + b * x[i];
    const r = dx[i] - predicted;
    residuals.push(r);
    sse += r * r;
  }

  const resVar = sse / Math.max(m - 2, 1);
  const sigma = Math.sqrt(resVar / dt);

  // R²
  const dyMean = sy / m;
  let ssTot = 0;
  for (let i = 0; i < m; i++) ssTot += (dx[i] - dyMean) ** 2;
  const rSquared = ssTot > 0 ? 1 - sse / ssTot : 0;

  const halfLife = theta > 1e-10 ? Math.log(2) / theta : Infinity;

  const params: OUParams = { theta, mu, sigma, halfLife };

  const interpretation = theta > 0.01
    ? `平均回帰が検出されました。回帰速度θ=${theta.toFixed(4)}、長期平均μ=${mu.toFixed(2)}、半減期=${halfLife.toFixed(1)}日。価格は${mu.toFixed(2)}に向かって回帰する傾向があります。`
    : theta > 0
      ? `弱い平均回帰（θ=${theta.toFixed(4)}）。半減期=${halfLife.toFixed(1)}日と長く、ランダムウォークに近い動きです。`
      : `平均回帰なし（θ≤0）。トレンドまたはランダムウォーク的な動きです。`;

  return { params, residuals, rSquared, interpretation };
}

// --- ローリング半減期 ---
export function rollingHalfLife(
  values: number[],
  times: string[],
  window: number = 60
): RollingHalfLife[] {
  const result: RollingHalfLife[] = [];
  for (let i = window; i < values.length; i++) {
    const slice = values.slice(i - window, i + 1);
    const ou = fitOU(slice);
    result.push({
      time: times[i],
      halfLife: Math.min(ou.params.halfLife, window * 2), // cap for display
      theta: ou.params.theta,
    });
  }
  return result;
}

// --- Variance Ratio Test (簡易版) ---
// VR(q) = Var(r_q) / (q * Var(r_1))
// VR < 1 → 平均回帰、VR > 1 → モメンタム、VR ≈ 1 → ランダムウォーク
export function varianceRatio(values: number[], q: number = 5): number {
  const n = values.length;
  if (n < q + 10) return 1;

  // 1-period returns
  const r1: number[] = [];
  for (let i = 1; i < n; i++) r1.push(values[i] - values[i - 1]);

  // q-period returns
  const rq: number[] = [];
  for (let i = q; i < n; i++) rq.push(values[i] - values[i - q]);

  const var1 = variance(r1);
  const varQ = variance(rq);

  return var1 > 0 ? varQ / (q * var1) : 1;
}

// --- OU プロセスのシミュレーション ---
export function simulateOU(
  params: OUParams,
  startValue: number,
  steps: number,
  dt: number = 1,
  seed: number = 42
): number[] {
  const { theta, mu, sigma } = params;
  const path: number[] = [startValue];
  let rng = mulberry32(seed);

  for (let i = 1; i <= steps; i++) {
    const prev = path[i - 1];
    const drift = theta * (mu - prev) * dt;
    const diffusion = sigma * Math.sqrt(dt) * boxMullerNext(rng);
    rng = mulberry32(seed + i * 1000);
    path.push(prev + drift + diffusion);
  }

  return path;
}

// --- 総合分析 ---
export function meanReversionAnalysis(
  values: number[],
  times: string[],
  window: number = 60
): MeanReversionResult {
  const ou = fitOU(values);
  const rollingHL = rollingHalfLife(values, times, window);
  const vrRatio = varianceRatio(values, 5);

  // 簡易 Hurst by R/S
  const hurst = rsHurst(values);

  return { ou, rollingHL, vrRatio, hurst };
}

// --- Helpers ---
function variance(arr: number[]): number {
  const n = arr.length;
  if (n < 2) return 0;
  let s = 0, s2 = 0;
  for (const v of arr) { s += v; s2 += v * v; }
  return (s2 - s * s / n) / (n - 1);
}

function rsHurst(values: number[]): number {
  const n = values.length;
  if (n < 20) return 0.5;

  const sizes = [8, 16, 32, 64, 128, 256].filter(s => s <= n / 2);
  if (sizes.length < 2) return 0.5;

  const logRS: number[] = [];
  const logN: number[] = [];

  for (const size of sizes) {
    const segments = Math.floor(n / size);
    let totalRS = 0;
    let count = 0;

    for (let seg = 0; seg < segments; seg++) {
      const start = seg * size;
      const slice = values.slice(start, start + size);

      // Mean
      let mean = 0;
      for (const v of slice) mean += v;
      mean /= size;

      // Deviations and cumulative sum
      const cumDev: number[] = [];
      let cum = 0;
      let s2 = 0;
      for (const v of slice) {
        const dev = v - mean;
        cum += dev;
        cumDev.push(cum);
        s2 += dev * dev;
      }

      const R = Math.max(...cumDev) - Math.min(...cumDev);
      const S = Math.sqrt(s2 / size);
      if (S > 0) {
        totalRS += R / S;
        count++;
      }
    }

    if (count > 0) {
      logRS.push(Math.log(totalRS / count));
      logN.push(Math.log(size));
    }
  }

  if (logRS.length < 2) return 0.5;

  // Linear regression: logRS = H * logN + c
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  const m = logRS.length;
  for (let i = 0; i < m; i++) {
    sx += logN[i];
    sy += logRS[i];
    sxy += logN[i] * logRS[i];
    sx2 += logN[i] * logN[i];
  }
  const denom = m * sx2 - sx * sx;
  return denom > 0 ? (m * sxy - sx * sy) / denom : 0.5;
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

function boxMullerNext(rng: () => number): number {
  const u1 = rng() || 1e-10;
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function emptyOU(): OUResult {
  return {
    params: { theta: 0, mu: 0, sigma: 0, halfLife: Infinity },
    residuals: [],
    rSquared: 0,
    interpretation: "データ不足",
  };
}
