// Kramers-Moyal Coefficients — Drift, Diffusion, Potential

export interface KramersMoyalResult {
  priceLevels: number[];
  drift: number[];      // μ(p): first KM coefficient
  diffusion: number[];  // σ(p): second KM coefficient (square root)
  potential: number[];   // V(p) = -∫μ(p)dp
  stablePoints: number[];   // local minima of potential
  unstablePoints: number[]; // local maxima of potential
}

export function kramersMoyal(
  prices: number[],
  returns: number[],
  numBins: number = 25
): KramersMoyalResult {
  const n = Math.min(prices.length - 1, returns.length);
  if (n < 30) return emptyKM();

  const priceSlice = prices.slice(0, n);
  const retSlice = returns.slice(0, n);

  const pMin = Math.min(...priceSlice);
  const pMax = Math.max(...priceSlice);
  const pRange = pMax - pMin || 1;

  const priceLevels: number[] = [];
  const drift: number[] = [];
  const diffusion: number[] = [];

  for (let b = 0; b < numBins; b++) {
    const center = pMin + (b + 0.5) * pRange / numBins;
    const halfWidth = pRange / numBins;
    priceLevels.push(center);

    // Collect returns where price was in this bin
    const binReturns: number[] = [];
    for (let t = 0; t < n; t++) {
      if (Math.abs(priceSlice[t] - center) <= halfWidth) {
        binReturns.push(retSlice[t]);
      }
    }

    if (binReturns.length >= 5) {
      // First KM coefficient: E[Δx | x = p] ≈ mean return
      const m1 = binReturns.reduce((a, b) => a + b, 0) / binReturns.length;
      // Second KM coefficient: E[(Δx)² | x = p] ≈ variance
      const m2 = binReturns.reduce((a, v) => a + v * v, 0) / binReturns.length;
      drift.push(m1);
      diffusion.push(Math.sqrt(Math.max(0, m2 - m1 * m1)));
    } else {
      drift.push(0);
      diffusion.push(0);
    }
  }

  // Potential function: V(p) = -∫μ(p)dp (trapezoidal integration)
  const potential: number[] = [0];
  for (let i = 1; i < numBins; i++) {
    const dp = priceLevels[i] - priceLevels[i - 1];
    potential.push(potential[i - 1] - 0.5 * (drift[i] + drift[i - 1]) * dp);
  }

  // Normalize potential to [0, 1]
  const potMin = Math.min(...potential);
  const potMax = Math.max(...potential);
  const potRange = potMax - potMin || 1;
  const normalizedPotential = potential.map((v) => (v - potMin) / potRange);

  // Find stable/unstable points
  const stablePoints: number[] = [];
  const unstablePoints: number[] = [];
  for (let i = 1; i < numBins - 1; i++) {
    if (normalizedPotential[i] < normalizedPotential[i - 1] && normalizedPotential[i] < normalizedPotential[i + 1]) {
      stablePoints.push(priceLevels[i]);
    }
    if (normalizedPotential[i] > normalizedPotential[i - 1] && normalizedPotential[i] > normalizedPotential[i + 1]) {
      unstablePoints.push(priceLevels[i]);
    }
  }

  return {
    priceLevels,
    drift,
    diffusion,
    potential: normalizedPotential,
    stablePoints,
    unstablePoints,
  };
}

function emptyKM(): KramersMoyalResult {
  return { priceLevels: [], drift: [], diffusion: [], potential: [], stablePoints: [], unstablePoints: [] };
}
