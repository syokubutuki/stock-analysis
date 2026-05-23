// Hilbert-Huang Spectrum (HHS), STFT, Spectral Entropy

import { computeEMD, hilbertTransform } from "./emd";

// ---- Hilbert-Huang Spectrum ----

export interface HHSResult {
  timeAxis: number[];
  periodAxis: number[];
  energy: number[][];  // [periodIndex][timeIndex]
  maxEnergy: number;
}

export function computeHHS(
  values: number[],
  numPeriodBins: number = 40
): HHSResult {
  const emd = computeEMD(values, 6);
  const n = values.length;
  const timeAxis = Array.from({ length: n }, (_, i) => i);

  const minPeriod = 2;
  const maxPeriod = Math.min(n / 2, 256);
  const periodAxis: number[] = [];
  for (let i = 0; i < numPeriodBins; i++) {
    periodAxis.push(
      minPeriod * Math.pow(maxPeriod / minPeriod, i / (numPeriodBins - 1))
    );
  }

  const energy: number[][] = Array.from({ length: numPeriodBins }, () =>
    new Array(n).fill(0)
  );
  let maxEnergy = 0;

  for (const imf of emd.imfs) {
    const ht = hilbertTransform(imf.data);
    const phases = unwrapPhase(ht.phase);

    for (let t = 1; t < n - 1; t++) {
      const instFreq = (phases[t + 1] - phases[t - 1]) / (2 * 2 * Math.PI);
      if (instFreq <= 0.001 || instFreq > 0.5) continue;
      const instPeriod = 1 / instFreq;
      const amp2 = ht.amplitude[t] * ht.amplitude[t];

      // find nearest period bin
      let bestBin = 0;
      let bestDist = Infinity;
      for (let p = 0; p < numPeriodBins; p++) {
        const dist = Math.abs(Math.log(periodAxis[p]) - Math.log(instPeriod));
        if (dist < bestDist) { bestDist = dist; bestBin = p; }
      }
      energy[bestBin][t] += amp2;
      if (energy[bestBin][t] > maxEnergy) maxEnergy = energy[bestBin][t];
    }
  }

  return { timeAxis, periodAxis, energy, maxEnergy };
}

function unwrapPhase(phase: number[]): number[] {
  const u = [phase[0]];
  for (let i = 1; i < phase.length; i++) {
    let d = phase[i] - phase[i - 1];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    u.push(u[i - 1] + d);
  }
  return u;
}

// ---- STFT ----

export interface STFTResult {
  timeIndices: number[];
  freqAxis: number[];   // cycles/day
  periodAxis: number[];  // days
  magnitude: number[][]; // [freqIndex][timeIndex]
  maxMag: number;
}

export function computeSTFT(
  values: number[],
  windowSize: number = 64,
  hopSize: number = 4
): STFTResult {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const centered = values.map((v) => v - mean);

  const nfft = nextPow2(windowSize);
  const halfN = nfft / 2;
  const timeIndices: number[] = [];
  const columns: number[][] = [];
  let maxMag = 0;

  for (let start = 0; start + windowSize <= n; start += hopSize) {
    const real = new Float64Array(nfft);
    const imag = new Float64Array(nfft);
    for (let i = 0; i < windowSize; i++) {
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowSize - 1)));
      real[i] = centered[start + i] * hann;
    }
    fftInPlace(real, imag);

    const col: number[] = [];
    for (let k = 1; k < halfN; k++) {
      const mag = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]) / nfft;
      col.push(mag);
      if (mag > maxMag) maxMag = mag;
    }
    columns.push(col);
    timeIndices.push(start + Math.floor(windowSize / 2));
  }

  // transpose: [freqIndex][timeIndex]
  const numFreqs = halfN - 1;
  const magnitude: number[][] = Array.from({ length: numFreqs }, (_, fi) =>
    columns.map((col) => col[fi])
  );

  const freqAxis = Array.from({ length: numFreqs }, (_, k) => (k + 1) / nfft);
  const periodAxis = freqAxis.map((f) => 1 / f);

  return { timeIndices, freqAxis, periodAxis, magnitude, maxMag };
}

// ---- Spectral Entropy ----

export function spectralEntropy(powers: number[]): number {
  const total = powers.reduce((s, v) => s + v, 0);
  if (total <= 0) return 0;
  const probs = powers.map((v) => v / total);
  let entropy = 0;
  for (const p of probs) {
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy / Math.log2(probs.length); // normalized 0-1
}

export function rollingSpectralEntropy(
  values: number[],
  windowSize: number = 64,
  hopSize: number = 1
): { indices: number[]; entropy: number[] } {
  const indices: number[] = [];
  const entropies: number[] = [];
  const nfft = nextPow2(windowSize);
  const halfN = nfft / 2;

  for (let start = 0; start + windowSize <= values.length; start += hopSize) {
    const real = new Float64Array(nfft);
    const imag = new Float64Array(nfft);
    const mean = values.slice(start, start + windowSize).reduce((a, b) => a + b, 0) / windowSize;
    for (let i = 0; i < windowSize; i++) {
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowSize - 1)));
      real[i] = (values[start + i] - mean) * hann;
    }
    fftInPlace(real, imag);

    const powers: number[] = [];
    for (let k = 1; k < halfN; k++) {
      powers.push(real[k] * real[k] + imag[k] * imag[k]);
    }
    indices.push(start + Math.floor(windowSize / 2));
    entropies.push(spectralEntropy(powers));
  }

  return { indices, entropy: entropies };
}

// ---- FFT utility ----

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function fftInPlace(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
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
    const angle = -2 * Math.PI / step;
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
}
