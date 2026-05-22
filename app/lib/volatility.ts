// ボラティリティ分析: EWMA, ボラティリティレジーム

export interface VolatilityPoint {
  time: string;
  ewma: number;
  realized: number; // 実現ボラティリティ (窓付き)
}

export interface VolRegime {
  start: string;
  end: string;
  avgVol: number;
  regime: "low" | "medium" | "high";
}

// EWMA (指数加重移動平均) ボラティリティ
// σ²_t = λ * σ²_{t-1} + (1-λ) * r²_t
export function ewmaVolatility(
  returns: number[],
  times: string[],
  lambda: number = 0.94,
  realizedWindow: number = 20
): VolatilityPoint[] {
  if (returns.length === 0) return [];

  const result: VolatilityPoint[] = [];

  // 初期値: 最初のrealizedWindow期間の分散
  const initSlice = returns.slice(0, Math.min(realizedWindow, returns.length));
  const initMean = initSlice.reduce((a, b) => a + b, 0) / initSlice.length;
  let variance = initSlice.reduce((a, v) => a + (v - initMean) ** 2, 0) / initSlice.length;

  for (let i = 0; i < returns.length; i++) {
    variance = lambda * variance + (1 - lambda) * returns[i] ** 2;

    // 実現ボラティリティ
    const start = Math.max(0, i - realizedWindow + 1);
    const window = returns.slice(start, i + 1);
    const wMean = window.reduce((a, b) => a + b, 0) / window.length;
    const realized = Math.sqrt(
      window.reduce((a, v) => a + (v - wMean) ** 2, 0) / window.length
    );

    result.push({
      time: times[i],
      ewma: Math.sqrt(variance),
      realized,
    });
  }

  return result;
}

// ボラティリティレジーム検出 (単純な閾値ベース)
export function detectVolRegimes(
  volPoints: VolatilityPoint[]
): { regimes: VolRegime[]; thresholds: { low: number; high: number } } {
  if (volPoints.length === 0)
    return { regimes: [], thresholds: { low: 0, high: 0 } };

  const ewmaValues = volPoints.map((v) => v.ewma);
  const sorted = [...ewmaValues].sort((a, b) => a - b);
  const lowThreshold = sorted[Math.floor(sorted.length * 0.33)];
  const highThreshold = sorted[Math.floor(sorted.length * 0.67)];

  const regimes: VolRegime[] = [];
  let currentRegime: "low" | "medium" | "high" =
    ewmaValues[0] < lowThreshold ? "low" : ewmaValues[0] > highThreshold ? "high" : "medium";
  let regimeStart = 0;

  for (let i = 1; i <= volPoints.length; i++) {
    const newRegime =
      i < volPoints.length
        ? ewmaValues[i] < lowThreshold
          ? "low"
          : ewmaValues[i] > highThreshold
          ? "high"
          : "medium"
        : currentRegime;

    if (newRegime !== currentRegime || i === volPoints.length) {
      regimes.push({
        start: volPoints[regimeStart].time,
        end: volPoints[i - 1].time,
        avgVol:
          ewmaValues.slice(regimeStart, i).reduce((a, b) => a + b, 0) /
          (i - regimeStart),
        regime: currentRegime,
      });
      regimeStart = i;
      currentRegime = newRegime;
    }
  }

  return { regimes, thresholds: { low: lowThreshold, high: highThreshold } };
}

// ボラティリティの自己相関 (ボラクラスタリングの強さ)
export function volClustering(returns: number[]): number {
  const absReturns = returns.map(Math.abs);
  const n = absReturns.length;
  if (n < 10) return 0;
  const mean = absReturns.reduce((a, b) => a + b, 0) / n;
  const variance = absReturns.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  if (variance === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n - 1; i++) {
    sum += (absReturns[i] - mean) * (absReturns[i + 1] - mean);
  }
  return sum / (n * variance);
}
