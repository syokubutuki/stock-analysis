// 市場マイクロストラクチャー指標
// Roll スプレッド推定 / Amihud 非流動性比率

import { PricePoint } from "./types";

export interface RollSpreadResult {
  spread: number;          // 推定スプレッド
  spreadBps: number;       // bps単位
  autoCovariance: number;  // Cov(Δp_t, Δp_{t-1})
  rollingSpread: { time: string; spread: number }[];
  interpretation: string;
}

export interface AmihudResult {
  illiquidity: number;     // Amihud比率 (年平均)
  rollingAmihud: { time: string; amihud: number }[];
  logAmihud: number;       // log(Amihud) for comparison
  interpretation: string;
}

export interface MicrostructureResult {
  roll: RollSpreadResult;
  amihud: AmihudResult;
}

// --- Roll (1984) スプレッド推定 ---
// Spread = 2√(-Cov(Δp_t, Δp_{t-1}))
// 自己共分散が負 → ビッド・アスクバウンスによるもの
export function rollSpread(prices: PricePoint[], window: number = 60): RollSpreadResult {
  const n = prices.length;
  if (n < 30) return emptyRoll();

  const dp: number[] = [];
  for (let i = 1; i < n; i++) dp.push(prices[i].close - prices[i - 1].close);

  // Full-sample autocovariance
  let cov = 0;
  const m = dp.length;
  let mean = 0;
  for (const d of dp) mean += d;
  mean /= m;

  for (let t = 1; t < m; t++) {
    cov += (dp[t] - mean) * (dp[t - 1] - mean);
  }
  cov /= m - 1;

  const spread = cov < 0 ? 2 * Math.sqrt(-cov) : 0;
  const avgPrice = prices.reduce((s, p) => s + p.close, 0) / n;
  const spreadBps = avgPrice > 0 ? (spread / avgPrice) * 10000 : 0;

  // Rolling spread
  const rollingSpread: { time: string; spread: number }[] = [];
  for (let i = window + 1; i < n; i++) {
    const slice = dp.slice(i - window - 1, i - 1);
    let localMean = 0;
    for (const d of slice) localMean += d;
    localMean /= slice.length;

    let localCov = 0;
    for (let t = 1; t < slice.length; t++) {
      localCov += (slice[t] - localMean) * (slice[t - 1] - localMean);
    }
    localCov /= slice.length - 1;

    const localSpread = localCov < 0 ? 2 * Math.sqrt(-localCov) : 0;
    const localAvg = prices.slice(i - window, i).reduce((s, p) => s + p.close, 0) / window;
    rollingSpread.push({
      time: prices[i].time,
      spread: localAvg > 0 ? (localSpread / localAvg) * 10000 : 0,
    });
  }

  const interpretation = spreadBps > 50
    ? `推定スプレッド: ${spreadBps.toFixed(1)}bps。流動性が低く、取引コストが高い。`
    : spreadBps > 10
      ? `推定スプレッド: ${spreadBps.toFixed(1)}bps。中程度の流動性。`
      : spreadBps > 0
        ? `推定スプレッド: ${spreadBps.toFixed(1)}bps。流動性が高い。`
        : `正の自己共分散（スプレッド推定不可）。高頻度データでないと検出が困難。`;

  return { spread, spreadBps, autoCovariance: cov, rollingSpread, interpretation };
}

// --- Amihud (2002) 非流動性比率 ---
// ILLIQ = (1/D) Σ |r_t| / Volume_t
// 高い → 少ない出来高で大きく動く → 非流動的
export function amihudIlliquidity(prices: PricePoint[], window: number = 60): AmihudResult {
  const n = prices.length;
  if (n < 30) return emptyAmihud();

  // Full-sample
  let sum = 0;
  let count = 0;
  for (let i = 1; i < n; i++) {
    if (prices[i].volume > 0 && prices[i - 1].close > 0) {
      const absReturn = Math.abs(prices[i].close / prices[i - 1].close - 1);
      sum += absReturn / prices[i].volume;
      count++;
    }
  }

  const illiquidity = count > 0 ? (sum / count) * 1e6 : 0; // scale for readability
  const logAmihud = illiquidity > 0 ? Math.log10(illiquidity) : 0;

  // Rolling
  const rollingAmihud: { time: string; amihud: number }[] = [];
  for (let i = window + 1; i < n; i++) {
    let localSum = 0;
    let localCount = 0;
    for (let j = i - window; j < i; j++) {
      if (prices[j].volume > 0 && j > 0 && prices[j - 1].close > 0) {
        const absR = Math.abs(prices[j].close / prices[j - 1].close - 1);
        localSum += absR / prices[j].volume;
        localCount++;
      }
    }
    rollingAmihud.push({
      time: prices[i].time,
      amihud: localCount > 0 ? (localSum / localCount) * 1e6 : 0,
    });
  }

  const interpretation = illiquidity > 10
    ? `Amihud比率: ${illiquidity.toFixed(2)}×10⁻⁶。流動性が非常に低い。大口注文が価格に大きなインパクト。`
    : illiquidity > 1
      ? `Amihud比率: ${illiquidity.toFixed(2)}×10⁻⁶。中程度の流動性。`
      : `Amihud比率: ${illiquidity.toFixed(4)}×10⁻⁶。流動性が高く、取引インパクトは小さい。`;

  return { illiquidity, rollingAmihud, logAmihud, interpretation };
}

// --- 総合 ---
export function microstructureAnalysis(prices: PricePoint[]): MicrostructureResult {
  return {
    roll: rollSpread(prices),
    amihud: amihudIlliquidity(prices),
  };
}

function emptyRoll(): RollSpreadResult {
  return { spread: 0, spreadBps: 0, autoCovariance: 0, rollingSpread: [], interpretation: "データ不足" };
}

function emptyAmihud(): AmihudResult {
  return { illiquidity: 0, rollingAmihud: [], logAmihud: 0, interpretation: "データ不足" };
}
