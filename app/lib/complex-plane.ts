// 複素平面表現 (Complex Plane Representations)
// 実数の株価時系列を複素平面 (Argand平面) 上の軌跡として描くための
// 4つの写像を提供する。
//   1. 解析信号    z(t) = x(t) + i·H[x](t)            (Hilbert変換)
//   2. 遅延埋め込み z(t) = x(t) + i·x(t-τ)             (複素位相空間)
//   3. 複素Morletウェーブレット 特定周期成分の複素係数
//   4. 共鳴フェーザ z_k = Σ_{j≤k} r_j·e^(-i·2πf·j)    (累積位相スパイラル)

import { computeAnalyticSignal } from "./analytic-signal";

export interface ComplexPoint {
  re: number;
  im: number;
}

export interface ComplexTrajectoryStats {
  netDisplacement: number; // |z_end − z_start|
  pathLength: number;      // 軌跡の総延長 Σ|z_k − z_{k-1}|
  efficiency: number;      // netDisplacement / pathLength (0:往復, 1:直進)
  meanRadius: number;      // 原点からの平均距離
  winding: number;         // 原点まわりの累積回転数 (符号付き)
}

// ---- 1. 解析信号の軌跡 ----
// computeAnalyticSignal を再利用し、複素平面上の点列として返す。
export function analyticTrajectory(values: number[]): ComplexPoint[] {
  const res = computeAnalyticSignal(values);
  const pts: ComplexPoint[] = [];
  for (let i = 0; i < res.real.length; i++) {
    pts.push({ re: res.real[i], im: res.imag[i] });
  }
  return pts;
}

// ---- 2. 遅延座標埋め込み ----
// z(t) = x(t) + i·x(t-τ)
export function delayEmbedding(values: number[], tau: number): ComplexPoint[] {
  const pts: ComplexPoint[] = [];
  for (let i = tau; i < values.length; i++) {
    pts.push({ re: values[i], im: values[i - tau] });
  }
  return pts;
}

// ---- 3. 複素Morletウェーブレット変換 (単一スケール) ----
// ψ(t) = π^(-1/4)·e^(i·ω0·t)·e^(-t²/2)
// Morletでは Fourier周期 λ ≈ (4π/(ω0+√(2+ω0²)))·s。ω0=6 のとき λ ≈ 1.03·s。
// 指定した周期 period [日] に対応するスケール s で畳み込み、複素係数列を返す。
export function morletTrajectory(
  values: number[],
  period: number,
  omega0 = 6
): ComplexPoint[] {
  const n = values.length;
  // period → scale s
  const s = (period * (omega0 + Math.sqrt(2 + omega0 * omega0))) / (4 * Math.PI);
  const half = Math.ceil(4 * s); // ±4σ で打ち切り
  const norm = Math.pow(Math.PI, -0.25) / Math.sqrt(s);

  // 平均除去 (DC成分の漏れを抑える)
  const mean = values.reduce((a, b) => a + b, 0) / n;

  const pts: ComplexPoint[] = [];
  for (let t = 0; t < n; t++) {
    let re = 0;
    let im = 0;
    const lo = Math.max(0, t - half);
    const hi = Math.min(n - 1, t + half);
    for (let k = lo; k <= hi; k++) {
      const u = (k - t) / s;
      const env = Math.exp(-0.5 * u * u);
      // ψ*((k−t)/s): 共役なので e^(-i·ω0·u)
      const ang = omega0 * u;
      const x = values[k] - mean;
      re += x * norm * env * Math.cos(ang);
      im += x * norm * env * -Math.sin(ang);
    }
    pts.push({ re, im });
  }
  return pts;
}

// ---- 4. 累積共鳴フェーザ ----
// z_k = Σ_{j=0}^{k} r_j·e^(-i·2π·f·j),  f [cycles/day]
// 周波数 f の成分がリターンに持続的に存在すると、原点から大きく離れていく (共鳴)。
export function resonancePhasor(values: number[], freq: number): ComplexPoint[] {
  const pts: ComplexPoint[] = [];
  let re = 0;
  let im = 0;
  const w = 2 * Math.PI * freq;
  for (let j = 0; j < values.length; j++) {
    const ang = w * j;
    re += values[j] * Math.cos(ang);
    im += values[j] * -Math.sin(ang);
    pts.push({ re, im });
  }
  return pts;
}

// ---- 軌跡の統計量 ----
export function trajectoryStats(pts: ComplexPoint[]): ComplexTrajectoryStats {
  const n = pts.length;
  if (n < 2) {
    return { netDisplacement: 0, pathLength: 0, efficiency: 0, meanRadius: 0, winding: 0 };
  }
  let pathLength = 0;
  let radiusSum = 0;
  let winding = 0;
  for (let i = 0; i < n; i++) {
    radiusSum += Math.hypot(pts[i].re, pts[i].im);
    if (i > 0) {
      pathLength += Math.hypot(pts[i].re - pts[i - 1].re, pts[i].im - pts[i - 1].im);
      // 原点まわりの偏角変化を積算
      const a0 = Math.atan2(pts[i - 1].im, pts[i - 1].re);
      const a1 = Math.atan2(pts[i].im, pts[i].re);
      let d = a1 - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      winding += d;
    }
  }
  const netDisplacement = Math.hypot(
    pts[n - 1].re - pts[0].re,
    pts[n - 1].im - pts[0].im
  );
  return {
    netDisplacement,
    pathLength,
    efficiency: pathLength > 0 ? netDisplacement / pathLength : 0,
    meanRadius: radiusSum / n,
    winding: winding / (2 * Math.PI),
  };
}
