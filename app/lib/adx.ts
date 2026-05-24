import { PricePoint } from "./types";

export interface ADXPoint {
  time: string;
  plusDI: number;
  minusDI: number;
  adx: number;
}

export function computeADX(prices: PricePoint[], period: number = 14): ADXPoint[] {
  if (prices.length < period + 1) return [];

  const n = prices.length;

  // Step 1: Calculate raw +DM, -DM, TR for each bar (starting from index 1)
  const rawPlusDM: number[] = [];
  const rawMinusDM: number[] = [];
  const rawTR: number[] = [];

  for (let i = 1; i < n; i++) {
    const curr = prices[i];
    const prev = prices[i - 1];

    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;

    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );

    rawPlusDM.push(plusDM);
    rawMinusDM.push(minusDM);
    rawTR.push(tr);
  }

  // Step 2: First smoothed values (sum of first `period` values)
  let smoothedPlusDM = rawPlusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedMinusDM = rawMinusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedTR = rawTR.slice(0, period).reduce((a, b) => a + b, 0);

  // Step 3: Calculate first DI values
  const diPoints: { time: string; plusDI: number; minusDI: number; dx: number }[] = [];

  const calcDI = (sPlusDM: number, sMinusDM: number, sTR: number) => {
    const plusDI = sTR !== 0 ? (sPlusDM / sTR) * 100 : 0;
    const minusDI = sTR !== 0 ? (sMinusDM / sTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum !== 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    return { plusDI, minusDI, dx };
  };

  // First DI point corresponds to prices[period] (index period in prices array)
  const first = calcDI(smoothedPlusDM, smoothedMinusDM, smoothedTR);
  diPoints.push({ time: prices[period].time, ...first });

  // Step 4: Wilder's smoothing for subsequent values
  for (let i = period; i < rawPlusDM.length; i++) {
    smoothedPlusDM = smoothedPlusDM - smoothedPlusDM / period + rawPlusDM[i];
    smoothedMinusDM = smoothedMinusDM - smoothedMinusDM / period + rawMinusDM[i];
    smoothedTR = smoothedTR - smoothedTR / period + rawTR[i];

    const di = calcDI(smoothedPlusDM, smoothedMinusDM, smoothedTR);
    diPoints.push({ time: prices[i + 1].time, ...di });
  }

  // Step 5: Calculate ADX using Wilder's smoothing over DX values
  if (diPoints.length < period) return [];

  // First ADX = average of first `period` DX values
  let adxValue = diPoints.slice(0, period).reduce((a, b) => a + b.dx, 0) / period;

  const result: ADXPoint[] = [];

  // First ADX point corresponds to diPoints[period - 1]
  result.push({
    time: diPoints[period - 1].time,
    plusDI: diPoints[period - 1].plusDI,
    minusDI: diPoints[period - 1].minusDI,
    adx: adxValue,
  });

  // Subsequent ADX values
  for (let i = period; i < diPoints.length; i++) {
    adxValue = (adxValue * (period - 1) + diPoints[i].dx) / period;
    result.push({
      time: diPoints[i].time,
      plusDI: diPoints[i].plusDI,
      minusDI: diPoints[i].minusDI,
      adx: adxValue,
    });
  }

  return result;
}

export interface ADXJudgment {
  strength: string;
  trend: string;
  signal: string;
}

export function judgeADX(points: ADXPoint[]): ADXJudgment {
  if (points.length === 0) {
    return { strength: "データ不足", trend: "-", signal: "-" };
  }

  const last = points[points.length - 1];
  const prev = points.length >= 2 ? points[points.length - 2] : null;

  // Trend strength
  let strength: string;
  if (last.adx > 25) {
    strength = "強いトレンド";
  } else if (last.adx >= 20) {
    strength = "弱いトレンド";
  } else {
    strength = "レンジ相場";
  }

  // Trend direction
  const trend = last.plusDI > last.minusDI ? "上昇" : "下降";

  // Cross detection
  let signal: string;
  if (prev) {
    const crossedUp =
      prev.plusDI <= prev.minusDI && last.plusDI > last.minusDI;
    const crossedDown =
      prev.plusDI >= prev.minusDI && last.plusDI < last.minusDI;

    if (crossedUp) {
      signal = "+DIクロスアップ (買いシグナル)";
    } else if (crossedDown) {
      signal = "-DIクロスアップ (売りシグナル)";
    } else {
      signal = trend === "上昇" ? "+DI優勢" : "-DI優勢";
    }
  } else {
    signal = trend === "上昇" ? "+DI優勢" : "-DI優勢";
  }

  return { strength, trend, signal };
}
