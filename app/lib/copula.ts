/**
 * Copula analysis utilities for stock vs benchmark dependency structure.
 */

export interface CopulaResult {
  kendallTau: number;
  spearmanRho: number;
  pearson: number;
  lowerTail: number;
  upperTail: number;
  tailAsymmetry: number;
  stockRanks: number[];
  benchRanks: number[];
  stockReturns: number[];
  benchReturns: number[];
}

/**
 * Convert an array of values to ranks in [0, 1] using the empirical CDF.
 * Ties are handled by averaging the tied ranks.
 */
export function rankTransform(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];

  // Create indexed array and sort by value
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array<number>(n);

  let j = 0;
  while (j < n) {
    // Find the end of the current tie group
    let k = j;
    while (k + 1 < n && indexed[k + 1].v === indexed[j].v) k++;

    // Average rank for tie group (1-based), then normalize to (0, 1)
    const avgRank = (j + 1 + k + 1) / 2; // 1-based average rank
    const normalizedRank = avgRank / (n + 1); // map to (0, 1) open interval

    for (let m = j; m <= k; m++) {
      ranks[indexed[m].i] = normalizedRank;
    }
    j = k + 1;
  }

  return ranks;
}

/**
 * Compute Kendall's tau rank correlation between two arrays.
 * O(n^2) concordant/discordant pair counting.
 */
export function kendallTau(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;

  let concordant = 0;
  let discordant = 0;

  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = x[i] - x[j];
      const dy = y[i] - y[j];
      const product = dx * dy;
      if (product > 0) concordant++;
      else if (product < 0) discordant++;
      // ties contribute 0
    }
  }

  const totalPairs = (n * (n - 1)) / 2;
  return totalPairs === 0 ? 0 : (concordant - discordant) / totalPairs;
}

/**
 * Compute Spearman's rank correlation between two arrays.
 */
export function spearmanRho(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;

  const rx = rankTransform(x);
  const ry = rankTransform(y);

  // Pearson correlation on the ranks
  return pearsonCorrelation(rx, ry);
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;

  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;

  let cov = 0;
  let varX = 0;
  let varY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denom = Math.sqrt(varX * varY);
  return denom === 0 ? 0 : cov / denom;
}

/**
 * Compute lower and upper tail dependence from rank-transformed data.
 *
 * Lower tail: P(V <= q | U <= q)  estimated as #(U<=q AND V<=q) / #(U<=q)
 * Upper tail: P(V > 1-q | U > 1-q) estimated as #(U>1-q AND V>1-q) / #(U>1-q)
 *
 * @param u  Rank-transformed stock series in (0, 1)
 * @param v  Rank-transformed benchmark series in (0, 1)
 * @param threshold  Tail threshold (default 0.1 = bottom/top 10%)
 */
export function computeTailDependence(
  u: number[],
  v: number[],
  threshold = 0.1
): { lowerTail: number; upperTail: number } {
  const n = u.length;
  if (n === 0) return { lowerTail: 0, upperTail: 0 };

  const q = threshold;
  const qHigh = 1 - q;

  let lowerBoth = 0;
  let lowerU = 0;
  let upperBoth = 0;
  let upperU = 0;

  for (let i = 0; i < n; i++) {
    if (u[i] <= q) {
      lowerU++;
      if (v[i] <= q) lowerBoth++;
    }
    if (u[i] > qHigh) {
      upperU++;
      if (v[i] > qHigh) upperBoth++;
    }
  }

  const lowerTail = lowerU === 0 ? 0 : lowerBoth / lowerU;
  const upperTail = upperU === 0 ? 0 : upperBoth / upperU;

  return { lowerTail, upperTail };
}

/**
 * Full copula analysis: takes aligned price arrays, computes log returns,
 * rank-transforms both series, and returns copula statistics.
 */
export function computeCopulaAnalysis(
  stockPrices: number[],
  benchPrices: number[]
): CopulaResult {
  const n = Math.min(stockPrices.length, benchPrices.length);

  // Compute log returns (length = n - 1)
  const stockReturns: number[] = [];
  const benchReturns: number[] = [];

  for (let i = 1; i < n; i++) {
    const sR =
      stockPrices[i - 1] > 0 && stockPrices[i] > 0
        ? Math.log(stockPrices[i] / stockPrices[i - 1])
        : 0;
    const bR =
      benchPrices[i - 1] > 0 && benchPrices[i] > 0
        ? Math.log(benchPrices[i] / benchPrices[i - 1])
        : 0;
    stockReturns.push(sR);
    benchReturns.push(bR);
  }

  // Rank transform both return series
  const stockRanks = rankTransform(stockReturns);
  const benchRanks = rankTransform(benchReturns);

  // Dependency measures
  const tau = kendallTau(stockReturns, benchReturns);
  const rho = spearmanRho(stockReturns, benchReturns);
  const pearson = pearsonCorrelation(stockReturns, benchReturns);

  // Tail dependence from rank-transformed series
  const { lowerTail, upperTail } = computeTailDependence(
    stockRanks,
    benchRanks,
    0.1
  );

  const tailAsymmetry = upperTail - lowerTail;

  return {
    kendallTau: tau,
    spearmanRho: rho,
    pearson,
    lowerTail,
    upperTail,
    tailAsymmetry,
    stockRanks,
    benchRanks,
    stockReturns,
    benchReturns,
  };
}
