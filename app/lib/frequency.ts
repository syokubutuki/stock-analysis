// FFT & パワースペクトル推定

export interface SpectrumPoint {
  frequency: number; // cycles per day
  period: number; // days
  power: number;
}

// Cooley-Tukey radix-2 FFT (in-place)
// real, imag は同じ長さ (2のべき乗)
function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  // ビット反転置換
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
    let k = n >> 1;
    while (k <= j) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }
  // バタフライ演算
  for (let step = 2; step <= n; step <<= 1) {
    const half = step >> 1;
    const angle = -2 * Math.PI / step;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let g = 0; g < n; g += step) {
      let curReal = 1;
      let curImag = 0;
      for (let k = 0; k < half; k++) {
        const tReal = curReal * real[g + k + half] - curImag * imag[g + k + half];
        const tImag = curReal * imag[g + k + half] + curImag * real[g + k + half];
        real[g + k + half] = real[g + k] - tReal;
        imag[g + k + half] = imag[g + k] - tImag;
        real[g + k] += tReal;
        imag[g + k] += tImag;
        const newCurReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = newCurReal;
      }
    }
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// パワースペクトル推定
export function powerSpectrum(values: number[]): SpectrumPoint[] {
  const n = nextPow2(values.length);
  // 平均除去 + Hann窓
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  for (let i = 0; i < values.length; i++) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (values.length - 1)));
    real[i] = (values[i] - mean) * hann;
  }

  fft(real, imag);

  const result: SpectrumPoint[] = [];
  const halfN = n / 2;
  for (let i = 1; i < halfN; i++) {
    const power = (real[i] ** 2 + imag[i] ** 2) / n;
    const frequency = i / n; // cycles per sample (= per day)
    const period = n / i; // days
    result.push({ frequency, period, power });
  }
  return result;
}

// 1/fノイズとの比較用: log-logでの傾き推定
export function estimateSpectralSlope(
  spectrum: SpectrumPoint[]
): { slope: number; intercept: number } {
  const logF = spectrum.map((s) => Math.log10(s.frequency));
  const logP = spectrum.map((s) => Math.log10(s.power + 1e-20));
  const n = logF.length;
  const sumX = logF.reduce((a, b) => a + b, 0);
  const sumY = logP.reduce((a, b) => a + b, 0);
  const sumXY = logF.reduce((a, x, i) => a + x * logP[i], 0);
  const sumX2 = logF.reduce((a, x) => a + x * x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}
