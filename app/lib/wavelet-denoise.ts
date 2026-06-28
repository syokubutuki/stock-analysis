import { PricePoint } from "./types";

// ============================================================================
// ウェーブレット縮小ノイズ除去 (Wavelet Shrinkage Denoising)
// ----------------------------------------------------------------------------
// Donoho-Johnstone のウェーブレット縮小法。対数価格を Haar ウェーブレットで
// 多重分解し、ノイズは細かい係数に薄く広がり、信号は少数の大きな係数に集中する
// という性質を使って、小さな係数(=ノイズ)をソフト閾値で削ってから再構成する。
//   閾値 λ = σ√(2 ln N)  (普遍閾値)
//   σ    = MAD(最細レベルの詳細係数) / 0.6745  (頑健なノイズ標準偏差推定)
// ============================================================================

export type DenoiseStrength = "weak" | "mid" | "strong";

export interface WaveletDenoiseResult {
  time: string[];
  observed: number[]; // 価格
  denoised: number[]; // 価格(ノイズ除去後)
  sigmaNoisePct: number; // 推定ノイズ標準偏差 %
  threshold: number; // 適用した閾値(対数空間)
  levels: number; // 分解レベル数
  rawFlips: number; // 生の対数価格の方向転換回数
  denoisedFlips: number; // 除去後の方向転換回数
  whipsawReduction: number; // 方向転換が何%減ったか
  trendUp: boolean; // 直近の除去後系列の傾き(上昇か)
  currentDeviationPct: number; // 観測 − 除去後 の現在乖離 %
}

const SQRT2 = Math.SQRT2;

function haarStep(a: number[]): { approx: number[]; detail: number[] } {
  const approx: number[] = [];
  const detail: number[] = [];
  for (let i = 0; i < a.length; i += 2) {
    approx.push((a[i] + a[i + 1]) / SQRT2);
    detail.push((a[i] - a[i + 1]) / SQRT2);
  }
  return { approx, detail };
}

function haarInv(approx: number[], detail: number[]): number[] {
  const out = new Array(approx.length * 2);
  for (let i = 0; i < approx.length; i++) {
    out[2 * i] = (approx[i] + detail[i]) / SQRT2;
    out[2 * i + 1] = (approx[i] - detail[i]) / SQRT2;
  }
  return out;
}

function softThreshold(x: number, t: number): number {
  const s = Math.sign(x);
  const m = Math.abs(x) - t;
  return m > 0 ? s * m : 0;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const STRENGTH_MULT: Record<DenoiseStrength, number> = {
  weak: 0.6,
  mid: 1.0,
  strong: 1.6,
};

function countFlips(series: number[]): number {
  let flips = 0;
  let prevDir = 0;
  for (let i = 1; i < series.length; i++) {
    const d = Math.sign(series[i] - series[i - 1]);
    if (d !== 0 && prevDir !== 0 && d !== prevDir) flips++;
    if (d !== 0) prevDir = d;
  }
  return flips;
}

export function waveletDenoise(
  prices: PricePoint[],
  strength: DenoiseStrength = "mid"
): WaveletDenoiseResult | null {
  const n = prices.length;
  if (n < 64) return null;

  const logP = prices.map((p) => Math.log(p.close));

  // 2の冪に反射パディング
  let padLen = 1;
  while (padLen < n) padLen *= 2;
  const padded = logP.slice();
  for (let i = n; i < padLen; i++) {
    // 端を折り返して反射
    const mirror = 2 * n - 2 - i;
    padded.push(logP[Math.max(0, Math.min(n - 1, mirror))]);
  }

  // 分解レベル(最細を残しつつ)
  const maxLevels = Math.floor(Math.log2(padLen));
  const levels = Math.min(maxLevels - 1, 6);

  // 多重分解
  let approx = padded;
  const detailStack: number[][] = [];
  for (let lvl = 0; lvl < levels; lvl++) {
    const { approx: a, detail: d } = haarStep(approx);
    detailStack.push(d);
    approx = a;
  }

  // ノイズσ: 最細レベル(level 1)の詳細係数のMAD
  const finest = detailStack[0];
  const sigma = median(finest.map((v) => Math.abs(v))) / 0.6745;
  const threshold = sigma * Math.sqrt(2 * Math.log(n)) * STRENGTH_MULT[strength];

  // 各レベルの詳細係数をソフト閾値
  const thresholded = detailStack.map((d) =>
    d.map((v) => softThreshold(v, threshold))
  );

  // 再構成
  let recon = approx;
  for (let lvl = levels - 1; lvl >= 0; lvl--) {
    recon = haarInv(recon, thresholded[lvl]);
  }

  const denoisedLog = recon.slice(0, n);
  const denoised = denoisedLog.map((v) => Math.exp(v));
  const observed = prices.map((p) => p.close);

  const rawFlips = countFlips(logP);
  const denoisedFlips = countFlips(denoisedLog);
  const whipsawReduction =
    rawFlips > 0 ? (1 - denoisedFlips / rawFlips) * 100 : 0;

  // ノイズ残差σ
  const resid = logP.map((v, i) => v - denoisedLog[i]);
  const meanR = resid.reduce((a, v) => a + v, 0) / n;
  const sigmaNoise = Math.sqrt(
    resid.reduce((a, v) => a + (v - meanR) * (v - meanR), 0) / (n - 1)
  );

  const trendUp = denoisedLog[n - 1] >= denoisedLog[n - 2];
  const currentDeviationPct =
    ((observed[n - 1] - denoised[n - 1]) / denoised[n - 1]) * 100;

  return {
    time: prices.map((p) => p.time),
    observed,
    denoised,
    sigmaNoisePct: sigmaNoise * 100,
    threshold,
    levels,
    rawFlips,
    denoisedFlips,
    whipsawReduction,
    trendUp,
    currentDeviationPct,
  };
}
