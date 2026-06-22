// ポテンシャル地形 (Potential / Drift Landscape)
// 価格を「谷を転がるボール」と見立てる。
//   状態変数 x (例: 移動平均からの乖離率) ごとに、その後 h 日の平均リターン
//   = ドリフト μ(x) をカーネル回帰で推定し、ポテンシャル U(x) = −∫μ dx を作る。
//   谷(U極小, μが+→−)=平均回帰の引力点(フェアバリュー)、丘(U極大)=不安定点(ブレイク領域)。
//   ボール(現在値)が谷の縁にいれば逆張り、丘の上にいれば順張りが効きやすい。
//
// 先読み回避: 状態 x_t は t 時点で確定する終値・移動平均のみで構成。
//   ドリフトの推定自体はヒストリカル(記述的)。

import { PricePoint } from "./types";

export type StateKind = "maDev" | "zscore";

export interface PotentialLandscape {
  grid: number[];       // 状態 x の格子
  drift: number[];      // μ(x): h日先の期待リターン
  potential: number[];  // U(x) = −∫μ (最小=0にシフト)
  density: number[];    // 各格子の有効標本重み (0..1, 信頼度)
  valleys: { x: number; price: number }[]; // 安定均衡(谷)
  hills: { x: number; price: number }[];   // 不安定点(丘)
  xNow: number;         // 現在の状態
  driftNow: number;     // 現在のドリフト μ(xNow)
  nearestValley: { x: number; price: number } | null;
  regime: "meanRevert" | "momentum" | "neutral";
  priceNow: number;
  smaNow: number;
  stdNow: number;
  kind: StateKind;
  window: number;
  horizon: number;
  unit: string;         // "%" or "σ"
}

function trailingSMA(closes: number[], period: number): number[] {
  const n = closes.length;
  const out = new Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function trailingStd(closes: number[], period: number): number[] {
  const n = closes.length;
  const out = new Array(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += closes[j];
    const m = s / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - m) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

function stdOf(arr: number[]): number {
  const n = arr.length;
  if (n < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / n);
}

export interface LandscapeOptions {
  kind?: StateKind;
  window?: number;
  horizon?: number;
  smoothMult?: number; // バンド幅倍率 (小=細かい, 大=滑らか)
  gridN?: number;
}

export function buildPotentialLandscape(
  prices: PricePoint[],
  opts: LandscapeOptions = {}
): PotentialLandscape | null {
  const kind = opts.kind ?? "maDev";
  const window = opts.window ?? 50;
  const horizon = opts.horizon ?? 5;
  const smoothMult = opts.smoothMult ?? 1;
  const gridN = opts.gridN ?? 81;
  const unit = kind === "maDev" ? "%" : "σ";

  const n = prices.length;
  if (n < window + horizon + 50) return null;

  const closes = prices.map((p) => p.close);
  const sma = trailingSMA(closes, window);
  const sd = trailingStd(closes, window);

  // 状態 x_t と h日先リターン f_t のペア
  const xs: number[] = [];
  const fs: number[] = [];
  for (let i = window - 1; i <= n - 1 - horizon; i++) {
    const m = sma[i];
    if (!(m > 0)) continue;
    let x: number;
    if (kind === "maDev") {
      x = ((closes[i] - m) / m) * 100;
    } else {
      if (!(sd[i] > 0)) continue;
      x = (closes[i] - m) / sd[i];
    }
    const f = closes[i + horizon] / closes[i] - 1;
    if (!isFinite(x) || !isFinite(f)) continue;
    xs.push(x);
    fs.push(f);
  }
  if (xs.length < 50) return null;

  // 現在の状態 (最新の確定値)
  const smaNow = sma[n - 1];
  const stdNow = sd[n - 1];
  const priceNow = closes[n - 1];
  let xNow: number;
  if (kind === "maDev") xNow = ((priceNow - smaNow) / smaNow) * 100;
  else xNow = stdNow > 0 ? (priceNow - smaNow) / stdNow : 0;

  // 格子 (ロバストな範囲)
  const sortedX = [...xs].sort((a, b) => a - b);
  const lo = quantile(sortedX, 0.025);
  const hi = quantile(sortedX, 0.975);
  const grid: number[] = [];
  for (let g = 0; g < gridN; g++) grid.push(lo + ((hi - lo) * g) / (gridN - 1));

  // バンド幅 (Silverman) × 倍率
  const bw = Math.max(1e-6, 1.06 * stdOf(xs) * Math.pow(xs.length, -0.2) * smoothMult);
  const inv2bw2 = 1 / (2 * bw * bw);

  // Nadaraya-Watson カーネル回帰でドリフト μ(x)
  const drift = new Array(gridN).fill(0);
  const density = new Array(gridN).fill(0);
  let maxW = 1e-12;
  for (let g = 0; g < gridN; g++) {
    let wsum = 0;
    let fsum = 0;
    for (let i = 0; i < xs.length; i++) {
      const d = xs[i] - grid[g];
      const w = Math.exp(-d * d * inv2bw2);
      wsum += w;
      fsum += w * fs[i];
    }
    drift[g] = wsum > 0 ? fsum / wsum : 0;
    density[g] = wsum;
    if (wsum > maxW) maxW = wsum;
  }
  for (let g = 0; g < gridN; g++) density[g] /= maxW;

  // ポテンシャル U(x) = −∫ μ dx (台形積分), 最小を0に
  const potential = new Array(gridN).fill(0);
  for (let g = 1; g < gridN; g++) {
    const dx = grid[g] - grid[g - 1];
    potential[g] = potential[g - 1] - 0.5 * (drift[g] + drift[g - 1]) * dx;
  }
  const uMin = Math.min(...potential);
  for (let g = 0; g < gridN; g++) potential[g] -= uMin;

  const priceOf = (x: number) =>
    kind === "maDev" ? smaNow * (1 + x / 100) : smaNow + x * stdNow;

  // 谷(極小)・丘(極大): U の傾きの符号変化で検出 (密度が低い端は除外)
  const valleys: { x: number; price: number }[] = [];
  const hills: { x: number; price: number }[] = [];
  for (let g = 1; g < gridN - 1; g++) {
    if (density[g] < 0.05) continue;
    const dPrev = potential[g] - potential[g - 1];
    const dNext = potential[g + 1] - potential[g];
    if (dPrev < 0 && dNext > 0) valleys.push({ x: grid[g], price: priceOf(grid[g]) });
    if (dPrev > 0 && dNext < 0) hills.push({ x: grid[g], price: priceOf(grid[g]) });
  }

  // 現在のドリフト μ(xNow) を補間
  const interp = (arr: number[], x: number) => {
    if (x <= grid[0]) return arr[0];
    if (x >= grid[gridN - 1]) return arr[gridN - 1];
    let g = 1;
    while (g < gridN && grid[g] < x) g++;
    const t = (x - grid[g - 1]) / (grid[g] - grid[g - 1]);
    return arr[g - 1] * (1 - t) + arr[g] * t;
  };
  const driftNow = interp(drift, xNow);

  // 最寄りの谷
  let nearestValley: { x: number; price: number } | null = null;
  let best = Infinity;
  for (const v of valleys) {
    const d = Math.abs(v.x - xNow);
    if (d < best) { best = d; nearestValley = v; }
  }

  // レジーム判定: xNow 近傍のドリフト傾き (負=復元力=平均回帰, 正=順張り)
  const hStep = (hi - lo) / gridN;
  const slope = (interp(drift, xNow + hStep) - interp(drift, xNow - hStep)) / (2 * hStep);
  const slopeScale = Math.abs(driftNow) / Math.max(1e-6, Math.abs(xNow) || 1);
  let regime: PotentialLandscape["regime"] = "neutral";
  if (slope < -0.0002 - 0.05 * slopeScale) regime = "meanRevert";
  else if (slope > 0.0002 + 0.05 * slopeScale) regime = "momentum";

  return {
    grid, drift, potential, density,
    valleys, hills,
    xNow, driftNow, nearestValley, regime,
    priceNow, smaNow, stdNow,
    kind, window, horizon, unit,
  };
}
