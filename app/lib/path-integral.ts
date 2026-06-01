/**
 * Path Integral: GARCH残差ブートストラップによるシナリオ生成
 * 通常のモンテカルロと異なり、ボラティリティクラスタリングを反映した経路を生成
 */
import { PricePoint } from "./types";

export interface PathIntegralResult {
  /** シミュレーション経路 (累積対数リターン) */
  paths: number[][];
  /** パーセンタイルバンド */
  bands: {
    p5: number[];
    p25: number[];
    p50: number[];
    p75: number[];
    p95: number[];
  };
  /** 最終日の分布統計 */
  finalStats: {
    mean: number;
    std: number;
    skew: number;
    upProb: number; // 上昇確率
  };
  /** 表示用パス数 */
  displayPaths: number[][];
  horizon: number;
}

// mulberry32 PRNG
function rng32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computePathIntegral(
  prices: PricePoint[],
  horizon: number = 60,
  nPaths: number = 500
): PathIntegralResult {
  const empty: PathIntegralResult = {
    paths: [],
    bands: { p5: [], p25: [], p50: [], p75: [], p95: [] },
    finalStats: { mean: 0, std: 0, skew: 0, upProb: 0.5 },
    displayPaths: [],
    horizon,
  };
  if (prices.length < 30) return empty;

  const closes = prices.map((p) => p.close);
  const n = closes.length;

  // 対数リターン
  const lr: number[] = [];
  for (let i = 1; i < n; i++) lr.push(Math.log(closes[i] / closes[i - 1]));

  const mu = lr.reduce((a, b) => a + b, 0) / lr.length;

  // GARCH(1,1)でボラティリティ推定
  let uncondVar = 0;
  for (const r of lr) uncondVar += (r - mu) ** 2;
  uncondVar /= lr.length;

  const alpha = 0.1;
  const beta = 0.85;
  const omega = (1 - alpha - beta) * uncondVar;

  const sigma2: number[] = [uncondVar];
  for (let i = 1; i < lr.length; i++) {
    sigma2.push(
      Math.max(1e-10, omega + alpha * (lr[i - 1] - mu) ** 2 + beta * sigma2[i - 1])
    );
  }

  // 標準化残差
  const stdResiduals: number[] = [];
  for (let i = 0; i < lr.length; i++) {
    stdResiduals.push((lr[i] - mu) / Math.sqrt(sigma2[i]));
  }

  // GARCH残差ブートストラップでシミュレーション
  const rand = rng32(123);
  const allPaths: number[][] = [];
  const lastSigma2 = sigma2[sigma2.length - 1];

  for (let p = 0; p < nPaths; p++) {
    const path: number[] = [0];
    let cumRet = 0;
    let curSigma2 = lastSigma2;

    for (let t = 0; t < horizon; t++) {
      // ランダムに標準化残差をサンプリング
      const idx = Math.floor(rand() * stdResiduals.length);
      const eps = stdResiduals[idx];

      // GARCH更新
      const ret = mu + eps * Math.sqrt(curSigma2);
      curSigma2 = Math.max(1e-10, omega + alpha * (ret - mu) ** 2 + beta * curSigma2);

      cumRet += ret;
      path.push(cumRet);
    }
    allPaths.push(path);
  }

  // パーセンタイルバンド
  const pct = (sorted: number[], p: number) => {
    const i = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  };

  const bands = { p5: [] as number[], p25: [] as number[], p50: [] as number[], p75: [] as number[], p95: [] as number[] };
  for (let t = 0; t <= horizon; t++) {
    const vals = allPaths.map((p) => p[t]).sort((a, b) => a - b);
    bands.p5.push(pct(vals, 5));
    bands.p25.push(pct(vals, 25));
    bands.p50.push(pct(vals, 50));
    bands.p75.push(pct(vals, 75));
    bands.p95.push(pct(vals, 95));
  }

  // 最終分布
  const finals = allPaths.map((p) => p[horizon]);
  const fMean = finals.reduce((a, b) => a + b, 0) / finals.length;
  let fVar = 0, fM3 = 0;
  for (const f of finals) {
    fVar += (f - fMean) ** 2;
    fM3 += (f - fMean) ** 3;
  }
  fVar /= finals.length;
  fM3 /= finals.length;
  const fStd = Math.sqrt(fVar);
  const fSkew = fStd > 0 ? fM3 / (fStd ** 3) : 0;
  const upProb = finals.filter((f) => f > 0).length / finals.length;

  return {
    paths: allPaths,
    bands,
    finalStats: { mean: fMean, std: fStd, skew: fSkew, upProb },
    displayPaths: allPaths.slice(0, Math.min(200, nPaths)),
    horizon,
  };
}
