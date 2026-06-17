// ウェーブレットコヒーレンス (Wavelet Coherence, WTC)
// 2系列の連続ウェーブレット変換(Morlet)から、時間-周波数ごとの
// 局所相関(コヒーレンス 0..1)と位相差(リード・ラグ)を計算する。
// 単一銘柄では「価格リターン × 出来高変化」のペアに適用できる。
//
// 参考: Torrence & Compo (1998), Grinsted et al. (2004)

import { PricePoint } from "./types";

export interface WaveletCoherenceResult {
  coherence: Float64Array[]; // [scaleIndex][timeIndex]  0..1
  phase: Float64Array[];     // [scaleIndex][timeIndex]  位相差 (rad, -π..π)
  scales: number[];          // 各スケールの周期(日)
  times: string[];
  n: number;
}

const OMEGA0 = 6; // Morlet中心周波数

// Morlet波の実部・虚部 (dt は中心からの時間ずれ)
function morletRe(dt: number, scale: number): number {
  const x = dt / scale;
  return Math.pow(Math.PI, -0.25) * Math.exp(-0.5 * x * x) * Math.cos(OMEGA0 * x) / Math.sqrt(scale);
}
function morletIm(dt: number, scale: number): number {
  const x = dt / scale;
  return Math.pow(Math.PI, -0.25) * Math.exp(-0.5 * x * x) * Math.sin(OMEGA0 * x) / Math.sqrt(scale);
}

// z-score 標準化 (2系列のスケールを揃える)
function zscore(v: number[]): number[] {
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  let s2 = 0;
  for (const x of v) s2 += (x - mean) ** 2;
  const sd = Math.sqrt(s2 / n) || 1;
  return v.map((x) => (x - mean) / sd);
}

interface ComplexCWT {
  re: Float64Array[]; // [scaleIndex][timeIndex]
  im: Float64Array[];
  scales: number[];
}

// 複素CWT (係数そのものを返す。wavelet.ts はパワーのみのため別実装)
function complexCWT(values: number[], scales: number[]): ComplexCWT {
  const n = values.length;
  const re: Float64Array[] = [];
  const im: Float64Array[] = [];
  for (let si = 0; si < scales.length; si++) {
    const scale = scales[si];
    const rowRe = new Float64Array(n);
    const rowIm = new Float64Array(n);
    const half = Math.min(Math.ceil(scale * 4), n - 1);
    for (let t = 0; t < n; t++) {
      let sr = 0, si2 = 0;
      for (let dt = -half; dt <= half; dt++) {
        const idx = t + dt;
        if (idx < 0 || idx >= n) continue;
        // 畳み込みは波の複素共役。Im を反転して内積。
        sr += values[idx] * morletRe(dt, scale);
        si2 -= values[idx] * morletIm(dt, scale);
      }
      rowRe[t] = sr;
      rowIm[t] = si2;
    }
    re.push(rowRe);
    im.push(rowIm);
  }
  return { re, im, scales };
}

// 時間方向の平滑化 (スケールに比例した幅のガウス窓)
function smoothTime(row: Float64Array, scale: number): Float64Array {
  const n = row.length;
  const out = new Float64Array(n);
  const sigma = Math.max(1, scale); // 平滑窓 ~ スケール
  const half = Math.min(Math.ceil(sigma * 2), n - 1);
  const kernel: number[] = [];
  let ksum = 0;
  for (let k = -half; k <= half; k++) {
    const w = Math.exp(-0.5 * (k / sigma) ** 2);
    kernel.push(w);
    ksum += w;
  }
  for (let t = 0; t < n; t++) {
    let acc = 0;
    for (let k = -half; k <= half; k++) {
      const idx = t + k;
      if (idx < 0 || idx >= n) continue;
      acc += row[idx] * kernel[k + half];
    }
    out[t] = acc / ksum;
  }
  return out;
}

// スケール方向の平滑化 (隣接3スケールの加重平均)
function smoothScale(mat: Float64Array[]): Float64Array[] {
  const ns = mat.length;
  const n = mat[0]?.length ?? 0;
  const out: Float64Array[] = [];
  for (let si = 0; si < ns; si++) {
    const row = new Float64Array(n);
    for (let t = 0; t < n; t++) {
      let acc = 0, w = 0;
      for (let d = -1; d <= 1; d++) {
        const j = si + d;
        if (j < 0 || j >= ns) continue;
        const weight = d === 0 ? 2 : 1;
        acc += mat[j][t] * weight;
        w += weight;
      }
      row[t] = acc / w;
    }
    out.push(row);
  }
  return out;
}

function buildScales(n: number, numScales: number): number[] {
  const minScale = 2;
  const maxScale = Math.min(n / 2, 256);
  const scales: number[] = [];
  for (let i = 0; i < numScales; i++) {
    scales.push(minScale * Math.pow(maxScale / minScale, i / (numScales - 1)));
  }
  return scales;
}

export function computeWaveletCoherence(
  x: number[],
  y: number[],
  times: string[],
  numScales: number = 32
): WaveletCoherenceResult {
  const n = Math.min(x.length, y.length, times.length);
  if (n < 16) {
    return { coherence: [], phase: [], scales: [], times: [], n };
  }
  const xs = zscore(x.slice(x.length - n));
  const ys = zscore(y.slice(y.length - n));
  const ts = times.slice(times.length - n);

  const scales = buildScales(n, numScales);
  const Wx = complexCWT(xs, scales);
  const Wy = complexCWT(ys, scales);

  // クロススペクトル Wxy = Wx · conj(Wy)、自己スペクトル |Wx|², |Wy|² (各 s⁻¹ 正規化)
  const ns = scales.length;
  const cxyRe: Float64Array[] = [];
  const cxyIm: Float64Array[] = [];
  const sxx: Float64Array[] = [];
  const syy: Float64Array[] = [];
  for (let si = 0; si < ns; si++) {
    const s = scales[si];
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    for (let t = 0; t < n; t++) {
      const xr = Wx.re[si][t], xi = Wx.im[si][t];
      const yr = Wy.re[si][t], yi = Wy.im[si][t];
      // Wx · conj(Wy)
      re[t] = (xr * yr + xi * yi) / s;
      im[t] = (xi * yr - xr * yi) / s;
      px[t] = (xr * xr + xi * xi) / s;
      py[t] = (yr * yr + yi * yi) / s;
    }
    cxyRe.push(re);
    cxyIm.push(im);
    sxx.push(px);
    syy.push(py);
  }

  // 平滑化 S(·): 時間方向 → スケール方向
  const smRe = smoothScale(cxyRe.map((row, si) => smoothTime(row, scales[si])));
  const smIm = smoothScale(cxyIm.map((row, si) => smoothTime(row, scales[si])));
  const smXX = smoothScale(sxx.map((row, si) => smoothTime(row, scales[si])));
  const smYY = smoothScale(syy.map((row, si) => smoothTime(row, scales[si])));

  const coherence: Float64Array[] = [];
  const phase: Float64Array[] = [];
  for (let si = 0; si < ns; si++) {
    const coh = new Float64Array(n);
    const ph = new Float64Array(n);
    for (let t = 0; t < n; t++) {
      const numer = smRe[si][t] * smRe[si][t] + smIm[si][t] * smIm[si][t];
      const denom = smXX[si][t] * smYY[si][t] + 1e-20;
      coh[t] = Math.min(1, numer / denom);
      ph[t] = Math.atan2(smIm[si][t], smRe[si][t]);
    }
    coherence.push(coh);
    phase.push(ph);
  }

  return { coherence, phase, scales, times: ts, n };
}

// ---- 1D要約系列: 指定周期帯の平均コヒーレンスを時間方向に1本化 ----
// 価格対数リターン × 出来高対数変化のコヒーレンスを、minPeriod〜maxPeriod 日の
// 周期帯で平均する。基礎分析の系列セレクタ用(2D行列を時系列スカラーに縮約)。
export function priceVolumeCoherenceSeries(
  prices: PricePoint[],
  minPeriod = 5,
  maxPeriod = 20
): { time: string; value: number }[] {
  const closes = prices.map((p) => p.close);
  const vols = prices.map((p) => p.volume);
  const t = prices.map((p) => p.time);
  const x: number[] = [];
  const y: number[] = [];
  const tt: string[] = [];
  for (let i = 1; i < closes.length; i++) {
    x.push(closes[i] > 0 && closes[i - 1] > 0 ? Math.log(closes[i] / closes[i - 1]) : 0);
    y.push(vols[i] > 0 && vols[i - 1] > 0 ? Math.log(vols[i] / vols[i - 1]) : 0);
    tt.push(t[i]);
  }
  const res = computeWaveletCoherence(x, y, tt, 32);
  if (res.coherence.length === 0) return [];

  // 周期帯に入るスケールのインデックス
  const bandIdx: number[] = [];
  for (let si = 0; si < res.scales.length; si++) {
    if (res.scales[si] >= minPeriod && res.scales[si] <= maxPeriod) bandIdx.push(si);
  }
  if (bandIdx.length === 0) bandIdx.push(0);

  const out: { time: string; value: number }[] = [];
  for (let ti = 0; ti < res.n; ti++) {
    let acc = 0;
    for (const si of bandIdx) acc += res.coherence[si][ti];
    out.push({ time: res.times[ti], value: acc / bandIdx.length });
  }
  return out;
}
