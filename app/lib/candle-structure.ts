import { PricePoint } from "./types";

export interface CandleMetrics {
  time: string;
  bodyRatio: number;       // |close - open| / (high - low)
  upperShadowRatio: number; // (high - max(open,close)) / (high - low)
  lowerShadowRatio: number; // (min(open,close) - low) / (high - low)
  closePosition: number;    // (close - low) / (high - low)
  isBullish: boolean;       // close >= open
}

export function computeCandleMetrics(prices: PricePoint[]): CandleMetrics[] {
  const result: CandleMetrics[] = [];
  for (const p of prices) {
    const range = p.high - p.low;
    if (range <= 0) {
      result.push({
        time: p.time,
        bodyRatio: 0,
        upperShadowRatio: 0,
        lowerShadowRatio: 0,
        closePosition: 0.5,
        isBullish: p.close >= p.open,
      });
      continue;
    }
    const bodyTop = Math.max(p.open, p.close);
    const bodyBottom = Math.min(p.open, p.close);
    result.push({
      time: p.time,
      bodyRatio: (bodyTop - bodyBottom) / range,
      upperShadowRatio: (p.high - bodyTop) / range,
      lowerShadowRatio: (bodyBottom - p.low) / range,
      closePosition: (p.close - p.low) / range,
      isBullish: p.close >= p.open,
    });
  }
  return result;
}

export interface CandleStats {
  avgBodyRatio: number;
  avgUpperShadow: number;
  avgLowerShadow: number;
  avgClosePosition: number;
  bullishRate: number;
  // 大陽線/大陰線 (body > 70%)
  bigBullishCount: number;
  bigBearishCount: number;
  // 十字線 (body < 10%)
  dojiCount: number;
  // 上ヒゲ優勢 (upper > lower * 2)
  upperDominantCount: number;
  // 下ヒゲ優勢 (lower > upper * 2)
  lowerDominantCount: number;
}

export function computeCandleStats(metrics: CandleMetrics[]): CandleStats {
  const n = metrics.length;
  if (n === 0) {
    return {
      avgBodyRatio: 0, avgUpperShadow: 0, avgLowerShadow: 0,
      avgClosePosition: 0, bullishRate: 0, bigBullishCount: 0,
      bigBearishCount: 0, dojiCount: 0, upperDominantCount: 0, lowerDominantCount: 0,
    };
  }

  return {
    avgBodyRatio: metrics.reduce((a, m) => a + m.bodyRatio, 0) / n,
    avgUpperShadow: metrics.reduce((a, m) => a + m.upperShadowRatio, 0) / n,
    avgLowerShadow: metrics.reduce((a, m) => a + m.lowerShadowRatio, 0) / n,
    avgClosePosition: metrics.reduce((a, m) => a + m.closePosition, 0) / n,
    bullishRate: metrics.filter((m) => m.isBullish).length / n,
    bigBullishCount: metrics.filter((m) => m.isBullish && m.bodyRatio > 0.7).length,
    bigBearishCount: metrics.filter((m) => !m.isBullish && m.bodyRatio > 0.7).length,
    dojiCount: metrics.filter((m) => m.bodyRatio < 0.1).length,
    upperDominantCount: metrics.filter(
      (m) => m.upperShadowRatio > m.lowerShadowRatio * 2 && m.upperShadowRatio > 0.3
    ).length,
    lowerDominantCount: metrics.filter(
      (m) => m.lowerShadowRatio > m.upperShadowRatio * 2 && m.lowerShadowRatio > 0.3
    ).length,
  };
}

// ローリング統計 (closePosition の移動平均)
export interface RollingCandlePoint {
  time: string;
  bodyRatioMA: number;
  closePositionMA: number;
}

export function rollingCandleStats(
  metrics: CandleMetrics[],
  window: number = 20
): RollingCandlePoint[] {
  const result: RollingCandlePoint[] = [];
  for (let i = window - 1; i < metrics.length; i++) {
    const slice = metrics.slice(i - window + 1, i + 1);
    result.push({
      time: metrics[i].time,
      bodyRatioMA: slice.reduce((a, m) => a + m.bodyRatio, 0) / window,
      closePositionMA: slice.reduce((a, m) => a + m.closePosition, 0) / window,
    });
  }
  return result;
}
