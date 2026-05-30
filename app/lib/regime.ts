// Hidden Markov Model (HMM), Change Point Detection, Kalman Filter

// ---- HMM (Gaussian, 2-3 states) ----

export interface HMMResult {
  nStates: number;
  states: number[];               // Viterbi path
  stateProbabilities: number[][];  // [t][state]
  transitionMatrix: number[][];    // [from][to]
  stateMeans: number[];
  stateVols: number[];
  stateLabels: string[];
  expectedDuration: number[];      // 1/(1-a_ii) days
}

export function fitHMM(returns: number[], nStates: number = 3): HMMResult {
  const n = returns.length;

  // Initialize with k-means-like approach
  const sorted = returns.slice().sort((a, b) => a - b);
  const means: number[] = [];
  const vols: number[] = [];
  for (let s = 0; s < nStates; s++) {
    const start = Math.floor((s * n) / nStates);
    const end = Math.floor(((s + 1) * n) / nStates);
    const segment = sorted.slice(start, end);
    const m = segment.reduce((a, b) => a + b, 0) / segment.length;
    means.push(m);
    vols.push(Math.sqrt(segment.reduce((a, v) => a + (v - m) ** 2, 0) / segment.length) || 0.01);
  }

  // Transition matrix: uniform initialization
  const trans: number[][] = Array.from({ length: nStates }, () => {
    const row = new Array(nStates).fill(1 / nStates);
    return row;
  });
  // Prior
  const prior = new Array(nStates).fill(1 / nStates);

  // Baum-Welch EM
  for (let iter = 0; iter < 30; iter++) {
    // Forward
    const alpha: number[][] = [];
    const scale: number[] = [];
    {
      const a0 = prior.map((p, s) => p * gaussian(returns[0], means[s], vols[s]));
      const s0 = a0.reduce((a, b) => a + b, 0) || 1e-300;
      alpha.push(a0.map((v) => v / s0));
      scale.push(s0);
    }
    for (let t = 1; t < n; t++) {
      const at: number[] = new Array(nStates).fill(0);
      for (let j = 0; j < nStates; j++) {
        let sum = 0;
        for (let i = 0; i < nStates; i++) sum += alpha[t - 1][i] * trans[i][j];
        at[j] = sum * gaussian(returns[t], means[j], vols[j]);
      }
      const st = at.reduce((a, b) => a + b, 0) || 1e-300;
      alpha.push(at.map((v) => v / st));
      scale.push(st);
    }

    // Backward
    const beta: number[][] = Array.from({ length: n }, () => new Array(nStates).fill(0));
    beta[n - 1] = new Array(nStates).fill(1);
    for (let t = n - 2; t >= 0; t--) {
      for (let i = 0; i < nStates; i++) {
        let sum = 0;
        for (let j = 0; j < nStates; j++) {
          sum += trans[i][j] * gaussian(returns[t + 1], means[j], vols[j]) * beta[t + 1][j];
        }
        beta[t][i] = sum / (scale[t + 1] || 1e-300);
      }
    }

    // Gamma (state probabilities)
    const gamma: number[][] = [];
    for (let t = 0; t < n; t++) {
      const g = alpha[t].map((a, s) => a * beta[t][s]);
      const total = g.reduce((a, b) => a + b, 0) || 1e-300;
      gamma.push(g.map((v) => v / total));
    }

    // Xi (transition probabilities)
    const xi: number[][][] = [];
    for (let t = 0; t < n - 1; t++) {
      const x: number[][] = Array.from({ length: nStates }, () => new Array(nStates).fill(0));
      let totalX = 0;
      for (let i = 0; i < nStates; i++) {
        for (let j = 0; j < nStates; j++) {
          x[i][j] = alpha[t][i] * trans[i][j] * gaussian(returns[t + 1], means[j], vols[j]) * beta[t + 1][j];
          totalX += x[i][j];
        }
      }
      if (totalX > 0) for (let i = 0; i < nStates; i++) for (let j = 0; j < nStates; j++) x[i][j] /= totalX;
      xi.push(x);
    }

    // Update parameters
    for (let s = 0; s < nStates; s++) {
      let gammaSum = 0, weightedSum = 0, weightedVar = 0;
      for (let t = 0; t < n; t++) {
        gammaSum += gamma[t][s];
        weightedSum += gamma[t][s] * returns[t];
      }
      means[s] = gammaSum > 0 ? weightedSum / gammaSum : means[s];
      for (let t = 0; t < n; t++) {
        weightedVar += gamma[t][s] * (returns[t] - means[s]) ** 2;
      }
      vols[s] = gammaSum > 0 ? Math.sqrt(weightedVar / gammaSum) : vols[s];
      if (vols[s] < 1e-6) vols[s] = 1e-6;
    }

    for (let i = 0; i < nStates; i++) {
      let rowSum = 0;
      for (let j = 0; j < nStates; j++) {
        let xiSum = 0;
        for (let t = 0; t < n - 1; t++) xiSum += xi[t][i][j];
        trans[i][j] = xiSum;
        rowSum += xiSum;
      }
      if (rowSum > 0) for (let j = 0; j < nStates; j++) trans[i][j] /= rowSum;
    }
  }

  // Viterbi decoding
  const viterbiStates = viterbi(returns, means, vols, trans, prior, nStates);

  // Final forward-backward for state probabilities
  const stateProbabilities = forwardBackward(returns, means, vols, trans, prior, nStates);

  // Sort states by volatility
  const stateOrder = means.map((_, i) => i).sort((a, b) => vols[a] - vols[b]);
  const labels = nStates === 2
    ? ["低ボラ", "高ボラ"]
    : ["低ボラ(安定)", "中ボラ(通常)", "高ボラ(危機)"];

  const sortedMeans = stateOrder.map((i) => means[i]);
  const sortedVols = stateOrder.map((i) => vols[i]);
  const stateMap = new Map(stateOrder.map((orig, sorted) => [orig, sorted]));
  const sortedStates = viterbiStates.map((s) => stateMap.get(s) ?? s);
  const sortedProbs = stateProbabilities.map((p) => stateOrder.map((i) => p[i]));
  const sortedTrans = stateOrder.map((i) => stateOrder.map((j) => trans[i][j]));
  const expectedDuration = sortedTrans.map((row, i) => 1 / (1 - row[i] + 1e-10));

  return {
    nStates,
    states: sortedStates,
    stateProbabilities: sortedProbs,
    transitionMatrix: sortedTrans,
    stateMeans: sortedMeans,
    stateVols: sortedVols,
    stateLabels: labels,
    expectedDuration,
  };
}

function gaussian(x: number, mean: number, std: number): number {
  const z = (x - mean) / std;
  return Math.exp(-0.5 * z * z) / (std * Math.sqrt(2 * Math.PI));
}

function viterbi(
  obs: number[], means: number[], vols: number[],
  trans: number[][], prior: number[], nStates: number
): number[] {
  const n = obs.length;
  const logV: number[][] = Array.from({ length: n }, () => new Array(nStates).fill(0));
  const path: number[][] = Array.from({ length: n }, () => new Array(nStates).fill(0));

  for (let s = 0; s < nStates; s++) {
    logV[0][s] = Math.log(prior[s] + 1e-300) + Math.log(gaussian(obs[0], means[s], vols[s]) + 1e-300);
  }

  for (let t = 1; t < n; t++) {
    for (let j = 0; j < nStates; j++) {
      let bestVal = -Infinity, bestI = 0;
      for (let i = 0; i < nStates; i++) {
        const v = logV[t - 1][i] + Math.log(trans[i][j] + 1e-300);
        if (v > bestVal) { bestVal = v; bestI = i; }
      }
      logV[t][j] = bestVal + Math.log(gaussian(obs[t], means[j], vols[j]) + 1e-300);
      path[t][j] = bestI;
    }
  }

  const states = new Array(n);
  let best = 0;
  for (let s = 1; s < nStates; s++) {
    if (logV[n - 1][s] > logV[n - 1][best]) best = s;
  }
  states[n - 1] = best;
  for (let t = n - 2; t >= 0; t--) {
    states[t] = path[t + 1][states[t + 1]];
  }
  return states;
}

function forwardBackward(
  obs: number[], means: number[], vols: number[],
  trans: number[][], prior: number[], nStates: number
): number[][] {
  const n = obs.length;
  const alpha: number[][] = [];
  const scale: number[] = [];

  const a0 = prior.map((p, s) => p * gaussian(obs[0], means[s], vols[s]));
  const s0 = a0.reduce((a, b) => a + b, 0) || 1e-300;
  alpha.push(a0.map((v) => v / s0));
  scale.push(s0);

  for (let t = 1; t < n; t++) {
    const at: number[] = new Array(nStates).fill(0);
    for (let j = 0; j < nStates; j++) {
      for (let i = 0; i < nStates; i++) at[j] += alpha[t - 1][i] * trans[i][j];
      at[j] *= gaussian(obs[t], means[j], vols[j]);
    }
    const st = at.reduce((a, b) => a + b, 0) || 1e-300;
    alpha.push(at.map((v) => v / st));
    scale.push(st);
  }

  const beta: number[][] = Array.from({ length: n }, () => new Array(nStates).fill(1));
  for (let t = n - 2; t >= 0; t--) {
    for (let i = 0; i < nStates; i++) {
      let sum = 0;
      for (let j = 0; j < nStates; j++) {
        sum += trans[i][j] * gaussian(obs[t + 1], means[j], vols[j]) * beta[t + 1][j];
      }
      beta[t][i] = sum / (scale[t + 1] || 1e-300);
    }
  }

  const gamma: number[][] = [];
  for (let t = 0; t < n; t++) {
    const g = alpha[t].map((a, s) => a * beta[t][s]);
    const total = g.reduce((a, b) => a + b, 0) || 1e-300;
    gamma.push(g.map((v) => v / total));
  }
  return gamma;
}

// ---- Change Point Detection (CUSUM + Binary Segmentation) ----

export interface ChangePointResult {
  changePoints: number[];
  segments: { start: number; end: number; mean: number; vol: number }[];
  cusumSeries: number[];
}

export function detectChangePoints(
  values: number[],
  minSegmentSize: number = 20,
  maxChangePoints: number = 8
): ChangePointResult {
  const n = values.length;

  // CUSUM series
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const cusumSeries: number[] = [0];
  for (let i = 0; i < n; i++) {
    cusumSeries.push(cusumSeries[i] + (values[i] - mean));
  }

  // Binary Segmentation
  const changePoints: number[] = [];
  binarySegmentation(values, 0, n - 1, minSegmentSize, maxChangePoints, changePoints);
  changePoints.sort((a, b) => a - b);

  // Compute segment statistics
  const boundaries = [0, ...changePoints, n];
  const segments: { start: number; end: number; mean: number; vol: number }[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const seg = values.slice(start, end);
    const segMean = seg.reduce((a, b) => a + b, 0) / seg.length;
    const segVol = Math.sqrt(seg.reduce((a, v) => a + (v - segMean) ** 2, 0) / seg.length);
    segments.push({ start, end, mean: segMean, vol: segVol });
  }

  return { changePoints, segments, cusumSeries };
}

function binarySegmentation(
  values: number[],
  left: number, right: number,
  minSize: number, maxCP: number,
  changePoints: number[]
): void {
  if (right - left < 2 * minSize || changePoints.length >= maxCP) return;

  const seg = values.slice(left, right + 1);
  const n = seg.length;
  const mean = seg.reduce((a, b) => a + b, 0) / n;

  // Find point that maximizes |CUSUM|
  let cusum = 0;
  let maxAbsCusum = 0;
  let bestIdx = -1;

  for (let i = 0; i < n; i++) {
    cusum += seg[i] - mean;
    const absCusum = Math.abs(cusum);
    if (absCusum > maxAbsCusum && i >= minSize - 1 && n - i - 1 >= minSize) {
      maxAbsCusum = absCusum;
      bestIdx = i;
    }
  }

  if (bestIdx < 0) return;

  // Statistical significance: compare with BIC penalty
  const totalSS = seg.reduce((a, v) => a + (v - mean) ** 2, 0);
  const left2 = seg.slice(0, bestIdx + 1);
  const right2 = seg.slice(bestIdx + 1);
  const lMean = left2.reduce((a, b) => a + b, 0) / left2.length;
  const rMean = right2.reduce((a, b) => a + b, 0) / right2.length;
  const splitSS = left2.reduce((a, v) => a + (v - lMean) ** 2, 0) +
                  right2.reduce((a, v) => a + (v - rMean) ** 2, 0);

  const improvement = 1 - splitSS / (totalSS + 1e-20);
  const penalty = 3 * Math.log(n) / n; // BIC-like

  if (improvement > penalty) {
    const cp = left + bestIdx;
    changePoints.push(cp);
    binarySegmentation(values, left, cp, minSize, maxCP, changePoints);
    binarySegmentation(values, cp + 1, right, minSize, maxCP, changePoints);
  }
}

// ---- Kalman Filter (Local Level Model) ----

export interface KalmanResult {
  filteredState: number[];
  predictedState: number[];
  filterGain: number[];
  upperBand: number[];
  lowerBand: number[];
  innovation: number[];
  innovationVariance: number[];
  logLikelihood: number;
}

export function kalmanFilter(
  observations: number[],
  processNoise: number = 0.01,
  measurementNoise: number = 1.0
): KalmanResult {
  const n = observations.length;

  // Auto-estimate noise levels from data
  const diff = observations.slice(1).map((v, i) => v - observations[i]);
  const diffVar = diff.reduce((a, v) => a + v * v, 0) / diff.length;
  const Q = processNoise * diffVar;
  const R = measurementNoise * diffVar;

  let x = observations[0]; // state estimate
  let P = diffVar;          // state covariance

  const filteredState: number[] = [];
  const predictedState: number[] = [];
  const filterGain: number[] = [];
  const upperBand: number[] = [];
  const lowerBand: number[] = [];
  const innovation: number[] = [];
  const innovationVariance: number[] = [];
  let logLikelihood = 0;

  for (let t = 0; t < n; t++) {
    // Predict
    const xPred = x;
    const pPred = P + Q;
    predictedState.push(xPred);

    // Innovation
    const innov = observations[t] - xPred;
    const S = pPred + R;
    innovation.push(innov);
    innovationVariance.push(S);

    // Log-likelihood
    logLikelihood += -0.5 * (Math.log(2 * Math.PI * S) + (innov * innov) / S);

    // Update
    const K = pPred / S;
    x = xPred + K * innov;
    P = (1 - K) * pPred;

    filteredState.push(x);
    filterGain.push(K);

    const band = 1.96 * Math.sqrt(P + R);
    upperBand.push(x + band);
    lowerBand.push(x - band);
  }

  return { filteredState, predictedState, filterGain, upperBand, lowerBand, innovation, innovationVariance, logLikelihood };
}

// ---- 2-State Kalman Filter (Price + Velocity) ----

export interface Kalman2Result {
  filteredPrice: number[];
  filteredVelocity: number[];
  upperBand: number[];
  lowerBand: number[];
  innovation: number[];
  filterGain: number[];
}

export function kalmanFilter2State(
  observations: number[],
  processNoisePrice: number = 0.01,
  processNoiseVelocity: number = 0.001,
  measurementNoise: number = 1.0
): Kalman2Result {
  const n = observations.length;

  const diff = observations.slice(1).map((v, i) => v - observations[i]);
  const diffVar = diff.reduce((a, v) => a + v * v, 0) / diff.length;
  const qp = processNoisePrice * diffVar;
  const qv = processNoiseVelocity * diffVar;
  const R = measurementNoise * diffVar;

  // State: [price, velocity]
  let x0 = observations[0];
  let x1 = diff.length > 0 ? diff[0] : 0;
  // Covariance matrix (2x2, stored as [P00, P01, P10, P11])
  let P00 = diffVar, P01 = 0, P10 = 0, P11 = diffVar;

  const filteredPrice: number[] = [];
  const filteredVelocity: number[] = [];
  const upperBand: number[] = [];
  const lowerBand: number[] = [];
  const innovation: number[] = [];
  const filterGain: number[] = [];

  for (let t = 0; t < n; t++) {
    // Predict: x_pred = F * x, F = [[1,1],[0,1]]
    const xp0 = x0 + x1;
    const xp1 = x1;
    // P_pred = F * P * F' + Q
    const Pp00 = P00 + P01 + P10 + P11 + qp;
    const Pp01 = P01 + P11;
    const Pp10 = P10 + P11;
    const Pp11 = P11 + qv;

    // Innovation: y = z - H * x_pred, H = [1, 0]
    const innov = observations[t] - xp0;
    const S = Pp00 + R;
    innovation.push(innov);

    // Kalman gain: K = P_pred * H' / S
    const K0 = Pp00 / S;
    const K1 = Pp10 / S;
    filterGain.push(K0);

    // Update
    x0 = xp0 + K0 * innov;
    x1 = xp1 + K1 * innov;
    P00 = (1 - K0) * Pp00;
    P01 = (1 - K0) * Pp01;
    P10 = Pp10 - K1 * Pp00;
    P11 = Pp11 - K1 * Pp01;

    filteredPrice.push(x0);
    filteredVelocity.push(x1);

    const band = 1.96 * Math.sqrt(P00 + R);
    upperBand.push(x0 + band);
    lowerBand.push(x0 - band);
  }

  return { filteredPrice, filteredVelocity, upperBand, lowerBand, innovation, filterGain };
}

// ---- 3-State Kalman Filter (Price + Velocity + Acceleration) ----

export interface Kalman3Result {
  filteredPrice: number[];
  filteredVelocity: number[];
  filteredAcceleration: number[];
  upperBand: number[];
  lowerBand: number[];
  innovation: number[];
  filterGain: number[];
}

export function kalmanFilter3State(
  observations: number[],
  processNoisePrice: number = 0.01,
  processNoiseVelocity: number = 0.001,
  processNoiseAccel: number = 0.0001,
  measurementNoise: number = 1.0
): Kalman3Result {
  const n = observations.length;

  const diff = observations.slice(1).map((v, i) => v - observations[i]);
  const diffVar = diff.reduce((a, v) => a + v * v, 0) / diff.length;
  const qp = processNoisePrice * diffVar;
  const qv = processNoiseVelocity * diffVar;
  const qa = processNoiseAccel * diffVar;
  const R = measurementNoise * diffVar;

  // State: [price, velocity, acceleration]
  // F = [[1,1,0.5],[0,1,1],[0,0,1]]
  // H = [1,0,0]
  let x = [observations[0], diff.length > 0 ? diff[0] : 0, 0];
  // 3x3 covariance (stored flat row-major)
  let P = [
    diffVar, 0, 0,
    0, diffVar, 0,
    0, 0, diffVar,
  ];

  const filteredPrice: number[] = [];
  const filteredVelocity: number[] = [];
  const filteredAcceleration: number[] = [];
  const upperBand: number[] = [];
  const lowerBand: number[] = [];
  const innovation: number[] = [];
  const filterGain: number[] = [];

  for (let t = 0; t < n; t++) {
    // Predict: x_pred = F * x
    const xp0 = x[0] + x[1] + 0.5 * x[2];
    const xp1 = x[1] + x[2];
    const xp2 = x[2];

    // P_pred = F * P * F' + Q (3x3 matrix multiplication)
    // F = [[1,1,0.5],[0,1,1],[0,0,1]]
    // FP = F * P
    const FP00 = P[0] + P[3] + 0.5 * P[6];
    const FP01 = P[1] + P[4] + 0.5 * P[7];
    const FP02 = P[2] + P[5] + 0.5 * P[8];
    const FP10 = P[3] + P[6];
    const FP11 = P[4] + P[7];
    const FP12 = P[5] + P[8];
    const FP20 = P[6];
    const FP21 = P[7];
    const FP22 = P[8];

    // Pp = FP * F' + Q
    const Pp00 = FP00 + FP01 + 0.5 * FP02 + qp;
    const Pp01 = FP01 + FP02;
    const Pp02 = FP02;
    const Pp10 = FP10 + FP11 + 0.5 * FP12;
    const Pp11 = FP11 + FP12 + qv;
    const Pp12 = FP12;
    const Pp20 = FP20 + FP21 + 0.5 * FP22;
    const Pp21 = FP21 + FP22;
    const Pp22 = FP22 + qa;

    // Innovation
    const innov = observations[t] - xp0;
    const S = Pp00 + R;
    innovation.push(innov);

    // Kalman gain: K = Pp * H' / S, H = [1,0,0]
    const K0 = Pp00 / S;
    const K1 = Pp10 / S;
    const K2 = Pp20 / S;
    filterGain.push(K0);

    // Update state
    x[0] = xp0 + K0 * innov;
    x[1] = xp1 + K1 * innov;
    x[2] = xp2 + K2 * innov;

    // Update covariance: P = (I - K*H) * Pp
    P[0] = (1 - K0) * Pp00;
    P[1] = (1 - K0) * Pp01;
    P[2] = (1 - K0) * Pp02;
    P[3] = Pp10 - K1 * Pp00;
    P[4] = Pp11 - K1 * Pp01;
    P[5] = Pp12 - K1 * Pp02;
    P[6] = Pp20 - K2 * Pp00;
    P[7] = Pp21 - K2 * Pp01;
    P[8] = Pp22 - K2 * Pp02;

    filteredPrice.push(x[0]);
    filteredVelocity.push(x[1]);
    filteredAcceleration.push(x[2]);

    const band = 1.96 * Math.sqrt(P[0] + R);
    upperBand.push(x[0] + band);
    lowerBand.push(x[0] - band);
  }

  return { filteredPrice, filteredVelocity, filteredAcceleration, upperBand, lowerBand, innovation, filterGain };
}

// ---- Kalman Smoother (RTS Smoother) ----

export interface KalmanSmootherResult {
  smoothedPrice: number[];
  smoothedVelocity: number[];
  smoothedUpperBand: number[];
  smoothedLowerBand: number[];
  turningPoints: { index: number; type: "peak" | "trough" }[];
}

export function kalmanSmoother(
  observations: number[],
  processNoisePrice: number = 0.01,
  processNoiseVelocity: number = 0.001,
  measurementNoise: number = 1.0
): KalmanSmootherResult {
  const n = observations.length;

  const diff = observations.slice(1).map((v, i) => v - observations[i]);
  const diffVar = diff.reduce((a, v) => a + v * v, 0) / diff.length;
  const qp = processNoisePrice * diffVar;
  const qv = processNoiseVelocity * diffVar;
  const R = measurementNoise * diffVar;

  // Forward pass (standard 2-state Kalman filter), store intermediate values
  const xFiltered: [number, number][] = [];
  const PFiltered: [number, number, number, number][] = []; // P00, P01, P10, P11
  const xPredicted: [number, number][] = [];
  const PPredicted: [number, number, number, number][] = [];

  let x0 = observations[0];
  let x1 = diff.length > 0 ? diff[0] : 0;
  let P00 = diffVar, P01 = 0, P10 = 0, P11 = diffVar;

  for (let t = 0; t < n; t++) {
    // Predict
    const xp0 = x0 + x1;
    const xp1 = x1;
    const Pp00 = P00 + P01 + P10 + P11 + qp;
    const Pp01 = P01 + P11;
    const Pp10 = P10 + P11;
    const Pp11 = P11 + qv;

    xPredicted.push([xp0, xp1]);
    PPredicted.push([Pp00, Pp01, Pp10, Pp11]);

    // Update
    const innov = observations[t] - xp0;
    const S = Pp00 + R;
    const K0 = Pp00 / S;
    const K1 = Pp10 / S;

    x0 = xp0 + K0 * innov;
    x1 = xp1 + K1 * innov;
    P00 = (1 - K0) * Pp00;
    P01 = (1 - K0) * Pp01;
    P10 = Pp10 - K1 * Pp00;
    P11 = Pp11 - K1 * Pp01;

    xFiltered.push([x0, x1]);
    PFiltered.push([P00, P01, P10, P11]);
  }

  // Backward pass (RTS smoother)
  const smoothedPrice = new Array(n);
  const smoothedVelocity = new Array(n);
  const smoothedP00 = new Array(n);

  smoothedPrice[n - 1] = xFiltered[n - 1][0];
  smoothedVelocity[n - 1] = xFiltered[n - 1][1];
  smoothedP00[n - 1] = PFiltered[n - 1][0];

  for (let t = n - 2; t >= 0; t--) {
    const Pf = PFiltered[t];
    const Pp = PPredicted[t + 1];

    // Smoother gain: C = P_filtered * F' * inv(P_predicted)
    // F' = [[1,0],[1,1]], so P_filtered * F' = [[Pf00+Pf01, Pf01], [Pf10+Pf11, Pf11]]
    // For simplicity, compute C for each element
    const PFt00 = Pf[0] + Pf[1]; // row 0 of P*F'
    const PFt01 = Pf[1];
    const PFt10 = Pf[2] + Pf[3];
    const PFt11 = Pf[3];

    // inv(Pp) for 2x2
    const detPp = Pp[0] * Pp[3] - Pp[1] * Pp[2];
    const invDet = detPp !== 0 ? 1 / detPp : 0;
    const iPp00 = Pp[3] * invDet;
    const iPp01 = -Pp[1] * invDet;
    const iPp10 = -Pp[2] * invDet;
    const iPp11 = Pp[0] * invDet;

    // C = PFt * inv(Pp)
    const C00 = PFt00 * iPp00 + PFt01 * iPp10;
    const C01 = PFt00 * iPp01 + PFt01 * iPp11;
    const C10 = PFt10 * iPp00 + PFt11 * iPp10;
    const C11 = PFt10 * iPp01 + PFt11 * iPp11;

    // x_smooth = x_filtered + C * (x_smooth[t+1] - x_predicted[t+1])
    const dx0 = smoothedPrice[t + 1] - xPredicted[t + 1][0];
    const dx1 = smoothedVelocity[t + 1] - xPredicted[t + 1][1];

    smoothedPrice[t] = xFiltered[t][0] + C00 * dx0 + C01 * dx1;
    smoothedVelocity[t] = xFiltered[t][1] + C10 * dx0 + C11 * dx1;

    // Smoothed covariance (just P00 for bands)
    const dP00 = smoothedP00[t + 1] - PPredicted[t + 1][0];
    smoothedP00[t] = PFiltered[t][0] + C00 * C00 * dP00;
  }

  // Bands
  const smoothedUpperBand = smoothedPrice.map((p: number, i: number) =>
    p + 1.96 * Math.sqrt(Math.max(smoothedP00[i], 0) + R)
  );
  const smoothedLowerBand = smoothedPrice.map((p: number, i: number) =>
    p - 1.96 * Math.sqrt(Math.max(smoothedP00[i], 0) + R)
  );

  // Detect turning points (velocity sign changes in smoothed series)
  const turningPoints: { index: number; type: "peak" | "trough" }[] = [];
  for (let t = 1; t < n; t++) {
    if (smoothedVelocity[t - 1] > 0 && smoothedVelocity[t] <= 0) {
      turningPoints.push({ index: t, type: "peak" });
    } else if (smoothedVelocity[t - 1] < 0 && smoothedVelocity[t] >= 0) {
      turningPoints.push({ index: t, type: "trough" });
    }
  }

  return { smoothedPrice, smoothedVelocity, smoothedUpperBand, smoothedLowerBand, turningPoints };
}

// ---- Market Regime Classification (using Kalman 3-state outputs) ----

export type MarketRegime = "uptrend" | "downtrend" | "high_volatility" | "low_volatility" | "accelerating" | "decelerating";

export interface MarketStateResult {
  regimes: MarketRegime[];
  trendStrength: number[];      // normalized velocity
  acceleration: number[];       // normalized acceleration
  volatilityState: number[];    // dynamic volatility estimate
  confidence: number[];         // filter confidence (inverse of innovation variance)
  overallScore: number;         // -100 to +100
  interpretation: string;
}

export function classifyMarketState(
  observations: number[],
  windowSize: number = 60
): MarketStateResult {
  const n = observations.length;
  const k3 = kalmanFilter3State(observations);
  const ak = adaptiveKalmanFilter(observations);

  // Normalize velocity and acceleration
  const velMean = k3.filteredVelocity.reduce((a, v) => a + v, 0) / n;
  const velStd = Math.sqrt(k3.filteredVelocity.reduce((a, v) => a + (v - velMean) ** 2, 0) / n) || 1;
  const trendStrength = k3.filteredVelocity.map(v => (v - velMean) / velStd);

  const accMean = k3.filteredAcceleration.reduce((a, v) => a + v, 0) / n;
  const accStd = Math.sqrt(k3.filteredAcceleration.reduce((a, v) => a + (v - accMean) ** 2, 0) / n) || 1;
  const acceleration = k3.filteredAcceleration.map(v => (v - accMean) / accStd);

  // Dynamic volatility from adaptive Kalman innovation
  const volatilityState: number[] = [];
  for (let t = 0; t < n; t++) {
    const start = Math.max(0, t - windowSize + 1);
    const window = ak.innovation.slice(start, t + 1);
    const vol = Math.sqrt(window.reduce((a, v) => a + v * v, 0) / window.length);
    volatilityState.push(vol);
  }

  // Normalize volatility
  const volMean = volatilityState.reduce((a, v) => a + v, 0) / n;
  const volStd = Math.sqrt(volatilityState.reduce((a, v) => a + (v - volMean) ** 2, 0) / n) || 1;
  const volNorm = volatilityState.map(v => (v - volMean) / volStd);

  // Confidence: inverse of innovation variance (higher = more predictable)
  const confidence: number[] = [];
  for (let t = 0; t < n; t++) {
    const start = Math.max(0, t - windowSize + 1);
    const window = k3.innovation.slice(start, t + 1);
    const innovVar = window.reduce((a, v) => a + v * v, 0) / window.length;
    confidence.push(1 / (1 + innovVar / (volMean * volMean + 1e-10)));
  }

  // Classify regimes
  const regimes: MarketRegime[] = [];
  for (let t = 0; t < n; t++) {
    if (volNorm[t] > 1.5) {
      regimes.push("high_volatility");
    } else if (volNorm[t] < -1.0) {
      regimes.push("low_volatility");
    } else if (trendStrength[t] > 0.5 && acceleration[t] > 0.3) {
      regimes.push("accelerating");
    } else if (trendStrength[t] > 0.5 && acceleration[t] < -0.3) {
      regimes.push("decelerating");
    } else if (trendStrength[t] > 0.3) {
      regimes.push("uptrend");
    } else if (trendStrength[t] < -0.3) {
      regimes.push("downtrend");
    } else if (acceleration[t] > 0.3) {
      regimes.push("accelerating");
    } else if (acceleration[t] < -0.3) {
      regimes.push("decelerating");
    } else {
      regimes.push("low_volatility");
    }
  }

  // Overall score: latest state summary (-100 to +100)
  const latestTrend = trendStrength[n - 1] || 0;
  const latestAccel = acceleration[n - 1] || 0;
  const latestConf = confidence[n - 1] || 0.5;
  const rawScore = (latestTrend * 60 + latestAccel * 30) * latestConf;
  const overallScore = Math.max(-100, Math.min(100, rawScore));

  let interpretation: string;
  const regime = regimes[n - 1];
  if (regime === "high_volatility") {
    interpretation = "高ボラティリティ — リスク管理を優先。ポジションサイズの縮小を検討";
  } else if (regime === "accelerating" && latestTrend > 0) {
    interpretation = "上昇加速中 — モメンタム戦略が有効。利益を伸ばす局面";
  } else if (regime === "decelerating" && latestTrend > 0) {
    interpretation = "上昇減速中 — トレンド転換の兆候。利益確定を検討";
  } else if (regime === "accelerating" && latestTrend < 0) {
    interpretation = "下落加速中 — 空売り・ヘッジ戦略。損切りの徹底";
  } else if (regime === "decelerating" && latestTrend < 0) {
    interpretation = "下落減速中 — 底打ちの可能性。段階的な買い検討";
  } else if (regime === "uptrend") {
    interpretation = "上昇トレンド — トレンドフォロー戦略が有効";
  } else if (regime === "downtrend") {
    interpretation = "下降トレンド — 逆張りは慎重に。ヘッジを検討";
  } else {
    interpretation = "低ボラティリティ — レンジ相場。平均回帰戦略を検討";
  }

  return { regimes, trendStrength, acceleration, volatilityState, confidence, overallScore, interpretation };
}

// ---- Adaptive Kalman Filter ----

export interface AdaptiveKalmanResult {
  filteredState: number[];
  upperBand: number[];
  lowerBand: number[];
  innovation: number[];
  adaptiveQ: number[];
  adaptiveR: number[];
}

export function adaptiveKalmanFilter(
  observations: number[],
  adaptWindow: number = 20
): AdaptiveKalmanResult {
  const n = observations.length;

  const diff = observations.slice(1).map((v, i) => v - observations[i]);
  const diffVar = diff.reduce((a, v) => a + v * v, 0) / diff.length;

  let x = observations[0];
  let P = diffVar;
  let Q = 0.01 * diffVar;
  let R = 1.0 * diffVar;

  const filteredState: number[] = [];
  const upperBand: number[] = [];
  const lowerBand: number[] = [];
  const innovationArr: number[] = [];
  const adaptiveQArr: number[] = [];
  const adaptiveRArr: number[] = [];

  for (let t = 0; t < n; t++) {
    // Predict
    const xPred = x;
    const pPred = P + Q;

    // Innovation
    const innov = observations[t] - xPred;
    const S = pPred + R;
    innovationArr.push(innov);

    // Update
    const K = pPred / S;
    x = xPred + K * innov;
    P = (1 - K) * pPred;

    filteredState.push(x);

    const band = 1.96 * Math.sqrt(P + R);
    upperBand.push(x + band);
    lowerBand.push(x - band);

    // Adapt Q and R from recent innovations
    if (t >= adaptWindow) {
      const recentInnov = innovationArr.slice(t - adaptWindow + 1, t + 1);
      const innovVar = recentInnov.reduce((a, v) => a + v * v, 0) / adaptWindow;
      // R_new ~ innovation variance - predicted covariance contribution
      R = Math.max(innovVar * 0.7, diffVar * 0.1);
      // Q_new ~ residual
      Q = Math.max(innovVar * 0.3, diffVar * 0.001);
    }

    adaptiveQArr.push(Q);
    adaptiveRArr.push(R);
  }

  return { filteredState, upperBand, lowerBand, innovation: innovationArr, adaptiveQ: adaptiveQArr, adaptiveR: adaptiveRArr };
}
