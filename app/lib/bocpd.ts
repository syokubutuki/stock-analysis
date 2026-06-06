// Bayesian Online Change Point Detection (BOCPD)
// Adams-MacKay 2007

export interface BOCPDChangePoint {
  index: number;
  time: string;
  probability: number;
  meanBefore: number;
  meanAfter: number;
}

export interface BOCPDResult {
  changeProbability: number[];
  changePoints: BOCPDChangePoint[];
  maxRunLength: number[];
  runLengthPosterior: number[][]; // downsampled for visualization
  interpretation: string;
}

export function computeBOCPD(
  values: number[],
  times: string[],
  hazardRate: number = 1 / 250
): BOCPDResult {
  const n = values.length;
  const empty: BOCPDResult = {
    changeProbability: [],
    changePoints: [],
    maxRunLength: [],
    runLengthPosterior: [],
    interpretation: "データが不足しています。",
  };
  if (n < 30) return empty;

  // Hazard function: constant H(r) = hazardRate
  const H = hazardRate;

  // Prior hyperparameters (Normal-Inverse-Gamma conjugate)
  const mu0 = 0;
  const kappa0 = 1;
  const alpha0 = 1;
  const beta0 = 1;

  // Sufficient statistics per run length
  // For each run length r, maintain: n_r, sum_r, sumsq_r
  const maxR = 300;
  let runProb = new Float64Array(maxR + 1); // P(r_t | x_{1:t})
  runProb[0] = 1.0; // initial: r_0 = 0 with probability 1

  // Sufficient statistics arrays
  const sn = new Float64Array(maxR + 1); // count
  const sSum = new Float64Array(maxR + 1); // sum
  const sSumSq = new Float64Array(maxR + 1); // sum of squares

  const changeProbability = new Array(n).fill(0);
  const maxRunLength = new Array(n).fill(0);

  // Downsampled run-length posterior for visualization
  const step = Math.max(1, Math.floor(n / 500));
  const runLengthPosterior: number[][] = [];

  for (let t = 0; t < n; t++) {
    const x = values[t];

    // --- Step 1: Compute predictive probability for each run length ---
    const predProb = new Float64Array(maxR + 1);
    for (let r = 0; r <= Math.min(t, maxR); r++) {
      if (runProb[r] < 1e-12) continue;

      // Posterior hyperparameters for run length r
      const nr = sn[r];
      const kn = kappa0 + nr;
      const mun = (kappa0 * mu0 + sSum[r]) / kn;
      const an = alpha0 + nr / 2;
      const bn =
        beta0 +
        0.5 * (sSumSq[r] - sSum[r] * sSum[r] / Math.max(nr, 1e-10)) +
        (kappa0 * nr * (sSum[r] / Math.max(nr, 1e-10) - mu0) ** 2) / (2 * kn);

      // Predictive: Student-t with 2*an degrees of freedom
      const scale = Math.sqrt(((bn * (kn + 1)) / (an * kn)) || 1);
      const df = 2 * an;
      const z = (x - mun) / scale;
      // Student-t PDF approximation
      const logPdf =
        lgamma((df + 1) / 2) -
        lgamma(df / 2) -
        0.5 * Math.log(df * Math.PI) -
        Math.log(scale) -
        ((df + 1) / 2) * Math.log(1 + (z * z) / df);
      predProb[r] = Math.exp(logPdf);
    }

    // --- Step 2: Update run length distribution ---
    const newRunProb = new Float64Array(maxR + 1);

    // Growth: r_t = r_{t-1} + 1
    for (let r = 0; r <= Math.min(t, maxR - 1); r++) {
      newRunProb[r + 1] += runProb[r] * predProb[r] * (1 - H);
    }

    // Change: r_t = 0
    let changeProb = 0;
    for (let r = 0; r <= Math.min(t, maxR); r++) {
      changeProb += runProb[r] * predProb[r] * H;
    }
    newRunProb[0] = changeProb;

    // Normalize
    let total = 0;
    for (let r = 0; r <= maxR; r++) total += newRunProb[r];
    if (total > 1e-15) {
      for (let r = 0; r <= maxR; r++) newRunProb[r] /= total;
    }

    // --- Step 3: Update sufficient statistics ---
    // Shift: for r > 0, stats[r] = stats[r-1] + x
    const newSn = new Float64Array(maxR + 1);
    const newSSum = new Float64Array(maxR + 1);
    const newSSumSq = new Float64Array(maxR + 1);

    for (let r = 1; r <= Math.min(t + 1, maxR); r++) {
      newSn[r] = sn[r - 1] + 1;
      newSSum[r] = sSum[r - 1] + x;
      newSSumSq[r] = sSumSq[r - 1] + x * x;
    }
    // r=0: new segment starts
    newSn[0] = 1;
    newSSum[0] = x;
    newSSumSq[0] = x * x;

    // Copy back
    sn.set(newSn);
    sSum.set(newSSum);
    sSumSq.set(newSSumSq);

    // Prune: zero out very small probabilities
    for (let r = 0; r <= maxR; r++) {
      if (newRunProb[r] < 1e-8) newRunProb[r] = 0;
    }
    runProb = newRunProb;

    // Store results
    changeProbability[t] = newRunProb[0];

    // MAP run length
    let maxProb = 0;
    let maxIdx = 0;
    for (let r = 0; r <= maxR; r++) {
      if (runProb[r] > maxProb) {
        maxProb = runProb[r];
        maxIdx = r;
      }
    }
    maxRunLength[t] = maxIdx;

    // Downsample posterior for visualization
    if (t % step === 0) {
      const row = new Array(Math.min(maxR, 100)).fill(0);
      for (let r = 0; r < row.length; r++) row[r] = runProb[r];
      runLengthPosterior.push(row);
    }
  }

  // Detect change points: local peaks in changeProbability
  const changePoints: BOCPDChangePoint[] = [];
  const smoothWindow = 5;
  for (let t = smoothWindow; t < n - smoothWindow; t++) {
    if (changeProbability[t] > 0.3) {
      // Check if local maximum
      let isMax = true;
      for (let d = 1; d <= smoothWindow; d++) {
        if (changeProbability[t - d] >= changeProbability[t] ||
            changeProbability[t + d] >= changeProbability[t]) {
          isMax = false;
          break;
        }
      }
      if (isMax) {
        // Compute means before/after
        const windowBefore = Math.max(0, t - 20);
        const windowAfter = Math.min(n - 1, t + 20);
        let sumBefore = 0, cntBefore = 0;
        let sumAfter = 0, cntAfter = 0;
        for (let i = windowBefore; i < t; i++) { sumBefore += values[i]; cntBefore++; }
        for (let i = t; i <= windowAfter; i++) { sumAfter += values[i]; cntAfter++; }

        changePoints.push({
          index: t,
          time: times[t] || "",
          probability: changeProbability[t],
          meanBefore: cntBefore > 0 ? sumBefore / cntBefore : 0,
          meanAfter: cntAfter > 0 ? sumAfter / cntAfter : 0,
        });
      }
    }
  }

  // Sort by probability descending, limit to top 10
  changePoints.sort((a, b) => b.probability - a.probability);
  const topCPs = changePoints.slice(0, 10);

  const interpretation =
    topCPs.length === 0
      ? "統計的に有意な構造変化点は検出されませんでした。データは比較的安定した一つのレジームに属しています。"
      : `${topCPs.length}個の構造変化点を検出。` +
        topCPs
          .slice(0, 3)
          .map(
            (cp) =>
              `${cp.time}(確率${(cp.probability * 100).toFixed(0)}%, 平均${cp.meanBefore.toFixed(4)}→${cp.meanAfter.toFixed(4)})`
          )
          .join(", ") +
        "。CUSUM法よりも確率的に厳密な変化点推定です。";

  return {
    changeProbability,
    changePoints: topCPs,
    maxRunLength,
    runLengthPosterior,
    interpretation,
  };
}

// Log-gamma function (Stirling approximation)
function lgamma(x: number): number {
  if (x <= 0) return 0;
  if (x < 0.5) {
    // Reflection formula
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  x -= 1;
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  let sum = c[0];
  for (let i = 1; i < g + 2; i++) sum += c[i] / (x + i);
  const t = x + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum);
}
