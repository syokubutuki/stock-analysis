// Michaud リサンプリング(統計的に頑健なフロンティア)
// ----------------------------------------------------------------------------
// 平均分散最適化は入力(μ・Σ)の推定誤差に極端に敏感で、最適ウェイトが少しの
// データ差で大きく振れる。Michaud(1998)の resampling は、履歴をブートストラップして
// 何度も再最適化し、得られたウェイトを平均することで「推定誤差で暴れない」配分を作る。
//
// ここでは日次リターンの行(=日)を復元抽出でブートストラップ(同時点相関を保つ)し、
// 各リサンプルで空売り無し接点・最小分散を解く。各解を元サンプルのモデルで評価して
// σ-μ 平面に散らすと「最適点の揺れ(信頼雲)」が見える。平均ウェイト=Michaud配分。
// ============================================================================

import { AlignedReturns } from "./portfolio-risk";
import {
  buildModel,
  weightsFromModel,
  evaluatePortfolio,
  PortfolioPoint,
} from "./efficient-frontier";

export interface ResampleOpts {
  covShrinkage?: boolean;
  muShrinkage?: boolean;
  maxWeight?: number;
  nBoot?: number; // ブートストラップ回数(既定 300)
  seed?: number;
}

export interface WeightStability {
  ticker: string;
  tanMean: number;
  tanStd: number;
  mvMean: number;
  mvStd: number;
}

export interface ResampleResult {
  tickers: string[];
  nBoot: number;
  nObs: number;
  riskFree: number;
  tangencyCloud: { sigma: number; mu: number }[];
  minVarCloud: { sigma: number; mu: number }[];
  tangencyInSample: PortfolioPoint | null; // 単発推定(揺れの中心)
  minVarInSample: PortfolioPoint | null;
  tangencyMichaud: PortfolioPoint | null; // 平均ウェイト(頑健配分)
  minVarMichaud: PortfolioPoint | null;
  stability: WeightStability[];
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function normalize(w: number[]): number[] {
  const s = w.reduce((a, b) => a + b, 0);
  return s > 0 ? w.map((v) => v / s) : w.map(() => 1 / w.length);
}

export function michaudResample(
  aligned: AlignedReturns,
  rf: number,
  opts: ResampleOpts = {}
): ResampleResult | null {
  const { returns, tickers } = aligned;
  const k = returns.length;
  if (k < 2) return null;
  const T = returns[0]?.length ?? 0;
  if (T < 24) return null;

  const nBoot = opts.nBoot ?? 300;
  const cap = opts.maxWeight ?? 1;
  const rng = mulberry32(opts.seed ?? 0x51ed270b);

  const model0 = buildModel(returns, opts);
  if (!model0) return null;
  const w0 = weightsFromModel(model0, rf, cap);
  const tangencyInSample = w0.tangency ? evaluatePortfolio(model0, w0.tangency, rf) : null;
  const minVarInSample = w0.minVar ? evaluatePortfolio(model0, w0.minVar, rf) : null;

  const tangencyCloud: { sigma: number; mu: number }[] = [];
  const minVarCloud: { sigma: number; mu: number }[] = [];
  // ウェイトの累積(平均・分散用)
  const tanSum = new Array(k).fill(0);
  const tanSum2 = new Array(k).fill(0);
  let tanCount = 0;
  const mvSum = new Array(k).fill(0);
  const mvSum2 = new Array(k).fill(0);
  let mvCount = 0;

  const resampled: number[][] = Array.from({ length: k }, () => new Array(T));
  const idx = new Array(T);

  for (let b = 0; b < nBoot; b++) {
    for (let t = 0; t < T; t++) idx[t] = Math.floor(rng() * T);
    for (let a = 0; a < k; a++) {
      const src = returns[a];
      const dst = resampled[a];
      for (let t = 0; t < T; t++) dst[t] = src[idx[t]];
    }
    const mB = buildModel(resampled, opts);
    if (!mB) continue;
    // 単発の in-sample 解で暖機(収束を速める)
    const wB = weightsFromModel(mB, rf, cap, {
      tangency: w0.tangency ?? undefined,
      minVar: w0.minVar ?? undefined,
    });
    if (wB.tangency) {
      const p = evaluatePortfolio(model0, wB.tangency, rf);
      tangencyCloud.push({ sigma: p.sigma, mu: p.mu });
      for (let i = 0; i < k; i++) {
        tanSum[i] += wB.tangency[i];
        tanSum2[i] += wB.tangency[i] * wB.tangency[i];
      }
      tanCount++;
    }
    if (wB.minVar) {
      const p = evaluatePortfolio(model0, wB.minVar, rf);
      minVarCloud.push({ sigma: p.sigma, mu: p.mu });
      for (let i = 0; i < k; i++) {
        mvSum[i] += wB.minVar[i];
        mvSum2[i] += wB.minVar[i] * wB.minVar[i];
      }
      mvCount++;
    }
  }

  const tangencyMichaud =
    tanCount > 0 ? evaluatePortfolio(model0, normalize(tanSum.map((s) => s / tanCount)), rf) : null;
  const minVarMichaud =
    mvCount > 0 ? evaluatePortfolio(model0, normalize(mvSum.map((s) => s / mvCount)), rf) : null;

  const stdOf = (sum: number, sum2: number, n: number) => {
    if (n < 2) return 0;
    const m = sum / n;
    return Math.sqrt(Math.max(sum2 / n - m * m, 0));
  };
  const stability: WeightStability[] = tickers.map((ticker, i) => ({
    ticker,
    tanMean: tanCount > 0 ? tanSum[i] / tanCount : 0,
    tanStd: stdOf(tanSum[i], tanSum2[i], tanCount),
    mvMean: mvCount > 0 ? mvSum[i] / mvCount : 0,
    mvStd: stdOf(mvSum[i], mvSum2[i], mvCount),
  }));

  return {
    tickers,
    nBoot,
    nObs: T,
    riskFree: rf,
    tangencyCloud,
    minVarCloud,
    tangencyInSample,
    minVarInSample,
    tangencyMichaud,
    minVarMichaud,
    stability,
  };
}
