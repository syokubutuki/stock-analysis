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
