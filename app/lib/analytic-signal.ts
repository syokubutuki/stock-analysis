// 解析信号 (Analytic Signal) — 瞬時振幅・瞬時位相・瞬時周波数
// Hilbert変換によって実数時系列を複素解析信号に拡張し、
// 振動の「今この瞬間」の状態を抽出する。

export interface AnalyticSignalResult {
  real: number[];           // 元の信号 x(t)
  imag: number[];           // Hilbert変換 H[x](t)
  amplitude: number[];      // 瞬時振幅 A(t) = |z(t)|
  phase: number[];          // 瞬時位相 φ(t) (unwrapped, radians)
  instFrequency: number[];  // 瞬時周波数 f(t) (cycles/day)
  instPeriod: number[];     // 瞬時周期 T(t) = 1/f(t) (days)
}

export interface AnalyticSignalStats {
  meanAmplitude: number;
  stdAmplitude: number;
  meanFrequency: number;
  medianPeriod: number;
  freqStability: number;    // 瞬時周波数の変動係数 (CV) — 小さいほど安定
}

// ---- FFT (Cooley-Tukey radix-2, in-place) ----

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

// ---- 解析信号の計算 ----

export function computeAnalyticSignal(values: number[]): AnalyticSignalResult {
  const n = values.length;
  const nfft = nextPow2(n);
  const real = new Float64Array(nfft);
  const imag = new Float64Array(nfft);
  for (let i = 0; i < n; i++) real[i] = values[i];

  // FFT
  fftInPlace(real, imag, false);

  // 片側スペクトルの重み: 負の周波数を消去
  // h[0] = 1 (DC), h[1..N/2-1] = 2 (正の周波数), h[N/2] = 1 (Nyquist), h[N/2+1..N-1] = 0
  for (let i = 1; i < nfft / 2; i++) {
    real[i] *= 2;
    imag[i] *= 2;
  }
  for (let i = nfft / 2 + 1; i < nfft; i++) {
    real[i] = 0;
    imag[i] = 0;
  }

  // 逆FFT → 解析信号 z(t) = x(t) + i·H[x](t)
  fftInPlace(real, imag, true);

  const sigReal: number[] = [];
  const sigImag: number[] = [];
  const amplitude: number[] = [];
  const rawPhase: number[] = [];

  for (let i = 0; i < n; i++) {
    const re = real[i];
    const im = imag[i];
    sigReal.push(re);
    sigImag.push(im);
    amplitude.push(Math.sqrt(re * re + im * im));
    rawPhase.push(Math.atan2(im, re));
  }

  // 位相アンラッピング
  const phase = unwrapPhase(rawPhase);

  // 瞬時周波数 (中心差分)
  const instFrequency: number[] = new Array(n);
  instFrequency[0] = (phase[1] - phase[0]) / (2 * Math.PI);
  for (let i = 1; i < n - 1; i++) {
    instFrequency[i] = (phase[i + 1] - phase[i - 1]) / (2 * 2 * Math.PI);
  }
  instFrequency[n - 1] = (phase[n - 1] - phase[n - 2]) / (2 * Math.PI);

  // 瞬時周期
  const instPeriod = instFrequency.map((f) =>
    f > 0.001 ? 1 / f : 999
  );

  return { real: sigReal, imag: sigImag, amplitude, phase, instFrequency, instPeriod };
}

// ---- 位相アンラッピング ----

function unwrapPhase(phase: number[]): number[] {
  const unwrapped = [phase[0]];
  for (let i = 1; i < phase.length; i++) {
    let diff = phase[i] - phase[i - 1];
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    unwrapped.push(unwrapped[i - 1] + diff);
  }
  return unwrapped;
}

// ---- 統計量 ----

export function analyticSignalStats(result: AnalyticSignalResult): AnalyticSignalStats {
  const { amplitude, instFrequency } = result;
  const n = amplitude.length;

  const meanAmp = amplitude.reduce((a, b) => a + b, 0) / n;
  const stdAmp = Math.sqrt(
    amplitude.reduce((a, v) => a + (v - meanAmp) ** 2, 0) / n
  );

  // 瞬時周波数の統計（物理的に意味のある正の値のみ）
  const validFreqs = instFrequency.filter((f) => f > 0.001 && f < 0.5);
  const meanFreq = validFreqs.length > 0
    ? validFreqs.reduce((a, b) => a + b, 0) / validFreqs.length
    : 0;
  const stdFreq = validFreqs.length > 0
    ? Math.sqrt(validFreqs.reduce((a, v) => a + (v - meanFreq) ** 2, 0) / validFreqs.length)
    : 0;

  const validPeriods = validFreqs.map((f) => 1 / f).sort((a, b) => a - b);
  const medianPeriod = validPeriods.length > 0
    ? validPeriods[Math.floor(validPeriods.length / 2)]
    : 0;

  return {
    meanAmplitude: meanAmp,
    stdAmplitude: stdAmp,
    meanFrequency: meanFreq,
    medianPeriod,
    freqStability: meanFreq > 0 ? stdFreq / meanFreq : 0,
  };
}
