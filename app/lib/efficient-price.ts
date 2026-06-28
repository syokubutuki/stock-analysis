import { PricePoint } from "./types";
import { kalmanSmoother } from "./regime";

// ============================================================================
// カルマン平滑化による効率的価格 (Efficient Price via Kalman Smoother)
// ----------------------------------------------------------------------------
// 観測価格 = 効率的価格(真の評価値) + 測定ノイズ(マイクロ構造ノイズ) と捉え、
// 状態空間モデルの RTS スムーザーで効率的価格を抽出する。
//   残差 = 観測 − 効率的価格 = 測定ノイズ
// 残差が大きく振れた(価格が効率的価格から乖離した)後に、価格が効率的価格へ
// 戻る(平均回帰)傾向があるかを履歴で検証し、エントリー判断に使う。
// 計算の核は既存の regime.ts の kalmanSmoother を対数価格に適用して再利用する。
// ============================================================================

export interface EfficientPricePoint {
  time: string;
  observed: number; // 実際の終値
  efficient: number; // 効率的価格(価格空間)
  z: number; // 乖離の標準化スコア (対数残差 / ローリング標準偏差)
}

export interface ReversionStat {
  threshold: number; // |z| のしきい値
  nHigh: number; // z > +thr のサンプル数
  fwdHigh: number; // その後 H 日の平均対数リターン(%)
  nLow: number; // z < -thr のサンプル数
  fwdLow: number; // その後 H 日の平均対数リターン(%)
}

export type SmoothLevel = "weak" | "mid" | "strong";

export interface EfficientPriceResult {
  points: EfficientPricePoint[];
  sigmaNoisePct: number; // 残差(ノイズ)の標準偏差 %
  noiseRatio: number; // 残差std / 日次リターンstd : 1日の値動きに占めるノイズの大きさ
  currentZ: number;
  currentSignal: "buy" | "sell" | "neutral";
  fwdHorizon: number;
  reversion: ReversionStat;
  entryThreshold: number;
}

const LEVEL_PARAMS: Record<SmoothLevel, { qp: number; r: number }> = {
  // r(measurementNoise)が大きいほど観測を信用せず効率的価格は滑らか
  weak: { qp: 0.05, r: 0.3 },
  mid: { qp: 0.01, r: 1.0 },
  strong: { qp: 0.003, r: 3.0 },
};

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, v) => a + v, 0) / xs.length;
  const v = xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function efficientPrice(
  prices: PricePoint[],
  level: SmoothLevel = "mid",
  fwdHorizon = 5,
  entryThreshold = 1.5,
  zWindow = 60
): EfficientPriceResult | null {
  const n = prices.length;
  if (n < 80) return null;

  const logP = prices.map((p) => Math.log(p.close));
  const { qp, r } = LEVEL_PARAMS[level];
  const sm = kalmanSmoother(logP, qp, qp * 0.1, r);
  const smoothed = sm.smoothedPrice;

  // 対数残差(= 測定ノイズの推定)
  const resid = logP.map((v, i) => v - smoothed[i]);

  // 日次対数リターン(ノイズ比較の基準)
  const logRet: number[] = [];
  for (let i = 1; i < n; i++) logRet.push(logP[i] - logP[i - 1]);

  const sigmaNoise = std(resid);
  const sigmaRet = std(logRet);
  const noiseRatio = sigmaRet > 0 ? sigmaNoise / sigmaRet : 0;

  // ローリング標準偏差で残差を標準化 → z スコア
  const points: EfficientPricePoint[] = [];
  const z: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - zWindow + 1);
    const win = resid.slice(lo, i + 1);
    const s = std(win);
    const zi = s > 0 ? resid[i] / s : 0;
    z[i] = zi;
    points.push({
      time: prices[i].time,
      observed: prices[i].close,
      efficient: Math.exp(smoothed[i]),
      z: zi,
    });
  }

  // 平均回帰の履歴検証: |z|>thr の後、H日先の対数リターン
  let nHigh = 0,
    sumHigh = 0,
    nLow = 0,
    sumLow = 0;
  for (let i = 0; i + fwdHorizon < n; i++) {
    const fwd = logP[i + fwdHorizon] - logP[i];
    if (z[i] > entryThreshold) {
      nHigh++;
      sumHigh += fwd;
    } else if (z[i] < -entryThreshold) {
      nLow++;
      sumLow += fwd;
    }
  }

  const currentZ = z[n - 1];
  let currentSignal: "buy" | "sell" | "neutral" = "neutral";
  if (currentZ > entryThreshold) currentSignal = "sell"; // 効率的価格より割高→反落期待
  else if (currentZ < -entryThreshold) currentSignal = "buy"; // 割安→反発期待

  return {
    points,
    sigmaNoisePct: sigmaNoise * 100,
    noiseRatio,
    currentZ,
    currentSignal,
    fwdHorizon,
    entryThreshold,
    reversion: {
      threshold: entryThreshold,
      nHigh,
      fwdHigh: nHigh ? (sumHigh / nHigh) * 100 : 0,
      nLow,
      fwdLow: nLow ? (sumLow / nLow) * 100 : 0,
    },
  };
}
