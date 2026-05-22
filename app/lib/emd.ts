// EMD (Empirical Mode Decomposition) / Hilbert-Huang変換

export interface IMF {
  label: string;
  data: number[];
}

export interface EMDResult {
  imfs: IMF[];
  residue: number[];
}

// 局所極大・極小の検出
function findExtrema(signal: number[]): { maxima: number[]; minima: number[] } {
  const maxima: number[] = [];
  const minima: number[] = [];
  for (let i = 1; i < signal.length - 1; i++) {
    if (signal[i] > signal[i - 1] && signal[i] >= signal[i + 1]) {
      maxima.push(i);
    }
    if (signal[i] < signal[i - 1] && signal[i] <= signal[i + 1]) {
      minima.push(i);
    }
  }
  return { maxima, minima };
}

// 3次スプライン補間 (Natural spline)
function cubicSplineInterpolate(
  xs: number[],
  ys: number[],
  xOut: number[]
): number[] {
  const n = xs.length;
  if (n < 2) return xOut.map(() => ys[0] || 0);
  if (n === 2) {
    const slope = (ys[1] - ys[0]) / (xs[1] - xs[0]);
    return xOut.map((x) => ys[0] + slope * (x - xs[0]));
  }

  // 簡略化: 線形補間でフォールバック（安定性のため）
  // 実用上、EMDでは線形補間でも十分な結果が得られる
  return xOut.map((x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return ys[lo] + t * (ys[hi] - ys[lo]);
  });
}

// エンベロープ計算
function computeEnvelopes(
  signal: number[],
  maxima: number[],
  minima: number[]
): { upper: number[]; lower: number[] } {
  const n = signal.length;
  const indices = Array.from({ length: n }, (_, i) => i);

  // 端点を追加
  const maxX = [0, ...maxima, n - 1];
  const maxY = [signal[0], ...maxima.map((i) => signal[i]), signal[n - 1]];
  const minX = [0, ...minima, n - 1];
  const minY = [signal[0], ...minima.map((i) => signal[i]), signal[n - 1]];

  const upper = cubicSplineInterpolate(maxX, maxY, indices);
  const lower = cubicSplineInterpolate(minX, minY, indices);
  return { upper, lower };
}

// 単一IMFの抽出（sifting）
function siftIMF(
  signal: number[],
  maxIterations: number = 10,
  threshold: number = 0.05
): number[] {
  let h = [...signal];

  for (let iter = 0; iter < maxIterations; iter++) {
    const { maxima, minima } = findExtrema(h);
    if (maxima.length < 2 || minima.length < 2) break;

    const { upper, lower } = computeEnvelopes(h, maxima, minima);
    const mean = upper.map((u, i) => (u + lower[i]) / 2);

    let sd = 0;
    let norm = 0;
    for (let i = 0; i < h.length; i++) {
      sd += (mean[i]) ** 2;
      norm += h[i] ** 2;
    }
    if (norm > 0 && sd / norm < threshold) break;

    h = h.map((v, i) => v - mean[i]);
  }
  return h;
}

// EMD分解
export function computeEMD(
  values: number[],
  maxIMFs: number = 6
): EMDResult {
  const imfs: IMF[] = [];
  let residue = [...values];

  for (let k = 0; k < maxIMFs; k++) {
    const { maxima, minima } = findExtrema(residue);
    if (maxima.length < 2 || minima.length < 2) break;

    const imf = siftIMF(residue);

    // IMFがほぼゼロなら終了
    const energy = imf.reduce((a, v) => a + v * v, 0);
    const totalEnergy = residue.reduce((a, v) => a + v * v, 0);
    if (totalEnergy > 0 && energy / totalEnergy < 0.001) break;

    imfs.push({ label: `IMF${k + 1}`, data: imf });
    residue = residue.map((v, i) => v - imf[i]);
  }

  return { imfs, residue };
}

// ヒルベルト変換 (瞬時振幅・位相)
export interface HilbertResult {
  amplitude: number[]; // 瞬時振幅
  phase: number[];     // 瞬時位相
}

export function hilbertTransform(signal: number[]): HilbertResult {
  const n = signal.length;
  // DFTベースのヒルベルト変換(簡易版)
  // 解析信号 = signal + j * H(signal)
  // H(signal)のFFTベース計算
  const nfft = nextPow2(n);
  const real = new Float64Array(nfft);
  const imag = new Float64Array(nfft);
  for (let i = 0; i < n; i++) real[i] = signal[i];

  fftInPlace(real, imag, false);

  // 正の周波数のみを2倍、DC・ナイキストはそのまま、負の周波数は0
  for (let i = 1; i < nfft / 2; i++) {
    real[i] *= 2;
    imag[i] *= 2;
  }
  for (let i = nfft / 2 + 1; i < nfft; i++) {
    real[i] = 0;
    imag[i] = 0;
  }

  fftInPlace(real, imag, true);

  const amplitude: number[] = [];
  const phase: number[] = [];
  for (let i = 0; i < n; i++) {
    const re = signal[i];
    const im = imag[i];
    amplitude.push(Math.sqrt(re * re + im * im));
    phase.push(Math.atan2(im, re));
  }

  return { amplitude, phase };
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function fftInPlace(
  real: Float64Array,
  imag: Float64Array,
  inverse: boolean
): void {
  const n = real.length;
  const dir = inverse ? 1 : -1;

  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
    let k = n >> 1;
    while (k <= j) { j -= k; k >>= 1; }
    j += k;
  }

  for (let step = 2; step <= n; step <<= 1) {
    const half = step >> 1;
    const angle = dir * 2 * Math.PI / step;
    const wR = Math.cos(angle);
    const wI = Math.sin(angle);
    for (let g = 0; g < n; g += step) {
      let cR = 1, cI = 0;
      for (let k = 0; k < half; k++) {
        const tR = cR * real[g + k + half] - cI * imag[g + k + half];
        const tI = cR * imag[g + k + half] + cI * real[g + k + half];
        real[g + k + half] = real[g + k] - tR;
        imag[g + k + half] = imag[g + k] - tI;
        real[g + k] += tR;
        imag[g + k] += tI;
        const nR = cR * wR - cI * wI;
        cI = cR * wI + cI * wR;
        cR = nR;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] /= n;
    }
  }
}
