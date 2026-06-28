import { PricePoint } from "./types";

// ============================================================================
// ノイズ補正ボラティリティ (Noise-corrected Volatility)
// ----------------------------------------------------------------------------
// 日次リターンの分散には『本当の値動き』だけでなく『マイクロ構造ノイズ
// (ビッド・アスクの往復など)』が混ざり、ボラを過大評価させる。
// MA(1)ノイズモデルでは
//     観測分散 γ₀ = 真の分散 + 2σ_u² 、   1次自己共分散 γ₁ = −σ_u²
// なので
//     真の分散 = γ₀ + 2γ₁ 、   ノイズ分散 σ_u² = −γ₁
// この1次自己共分散補正(French/Roll, Hansen-Lunde系)で“真のボラ”を推定する。
// ============================================================================

export interface NCVolPoint {
  time: string;
  naiveVol: number; // 年率%(素朴)
  correctedVol: number; // 年率%(ノイズ補正)
  noiseSharePct: number; // 観測分散に占めるノイズ%
}

export interface NoiseCorrectedVolResult {
  points: NCVolPoint[];
  window: number;
  currentNaive: number;
  currentCorrected: number;
  currentNoiseShare: number;
  sizingAdjustPct: number; // 補正ボラで建てると枚数を何%変えられるか
  avgNoiseShare: number;
}

const ANNUAL = Math.sqrt(252);

export function noiseCorrectedVol(
  prices: PricePoint[],
  window = 21
): NoiseCorrectedVolResult | null {
  const n = prices.length;
  if (n < window + 30) return null;

  const logP = prices.map((p) => Math.log(p.close));
  const ret: number[] = [];
  const retTime: string[] = [];
  for (let i = 1; i < n; i++) {
    ret.push(logP[i] - logP[i - 1]);
    retTime.push(prices[i].time);
  }

  const points: NCVolPoint[] = [];
  let noiseShareSum = 0;
  let noiseShareCnt = 0;

  for (let i = window - 1; i < ret.length; i++) {
    const win = ret.slice(i - window + 1, i + 1);
    const m = win.reduce((a, v) => a + v, 0) / win.length;
    let g0 = 0,
      g1 = 0;
    for (let k = 0; k < win.length; k++) g0 += (win[k] - m) ** 2;
    for (let k = 1; k < win.length; k++) g1 += (win[k] - m) * (win[k - 1] - m);
    g0 /= win.length;
    g1 /= win.length;

    const correctedVar = Math.max(g0 * 0.05, g0 + 2 * g1); // 下限を設けて非負保証
    const naiveVol = Math.sqrt(g0) * ANNUAL * 100;
    const correctedVol = Math.sqrt(correctedVar) * ANNUAL * 100;
    const noiseShare = g0 > 0 ? Math.max(0, (-2 * g1) / g0) : 0;

    noiseShareSum += noiseShare;
    noiseShareCnt++;

    points.push({
      time: retTime[i],
      naiveVol,
      correctedVol,
      noiseSharePct: noiseShare * 100,
    });
  }

  if (points.length === 0) return null;
  const last = points[points.length - 1];
  const sizingAdjustPct =
    last.correctedVol > 0 ? (last.naiveVol / last.correctedVol - 1) * 100 : 0;

  return {
    points,
    window,
    currentNaive: last.naiveVol,
    currentCorrected: last.correctedVol,
    currentNoiseShare: last.noiseSharePct,
    sizingAdjustPct,
    avgNoiseShare: noiseShareCnt ? (noiseShareSum / noiseShareCnt) * 100 : 0,
  };
}
