// 先物 / フォワードの cost-of-carry 分析。
//   F = S·e^{(r-q)T}     （r=金利, q=保有利回り/配当利回り）
// r>q ならコンタンゴ（F>S）、r<q ならバックワーデーション（F<S）。
// 期先を毎回買い直すロールで、コンタンゴでは負のロールイールドが累積する
// （原油ETF等が長期で現物に負ける主因）。ここでは日足終値をスポット近似とし、
// 一定間隔でロールしたときの累積ロールコストを現物保有と対比する。

import { PricePoint } from "./types";
import { forwardPrice } from "./derivatives-core";

export interface CarryPoint {
  months: number; // 満期（月）
  T: number; // 年
  forward: number; // 理論F
  basis: number; // S - F
  annualizedRoll: number; // 年率ロールイールド ≈ (q - r)
}

export interface CarryCurve {
  spot: number;
  points: CarryPoint[];
  regime: "contango" | "backwardation" | "flat";
  slopePerYear: number; // dF/dT の符号感（r - q）
}

// 限月別の理論先物カーブ。
export function carryCurve(
  spot: number,
  r: number,
  q: number,
  monthsList: number[] = [1, 2, 3, 6, 9, 12, 18, 24]
): CarryCurve {
  const points: CarryPoint[] = monthsList.map((m) => {
    const T = m / 12;
    const forward = forwardPrice(spot, r, q, T);
    return {
      months: m,
      T,
      forward,
      basis: spot - forward,
      annualizedRoll: q - r, // 現物−先物のロールで得られる年率（正=バック=順ザヤ益）
    };
  });
  const diff = r - q;
  const regime =
    Math.abs(diff) < 1e-6 ? "flat" : diff > 0 ? "contango" : "backwardation";
  return { spot, points, regime, slopePerYear: diff };
}

export interface RollSimPoint {
  time: string;
  spotCum: number; // 現物バイ&ホールドの累積リターン（1=元本）
  futuresCum: number; // 先物ロール戦略の累積リターン
  rollDrag: number; // spotCum - futuresCum（正=ロールで劣後）
}

export interface RollSimResult {
  path: RollSimPoint[];
  totalRollDrag: number; // 最終的な累積ロールコスト
  annualizedRollDrag: number; // 年率換算
  regime: "contango" | "backwardation" | "flat";
}

// 一定間隔でロールする先物戦略 vs 現物バイ&ホールドのシミュレーション。
// 先物リターン ≈ スポットリターン − 日次キャリー(r-q)。
// r>q（コンタンゴ）なら先物は毎日 (r-q)/252 だけ現物に劣後する。
export function rollYieldSim(
  prices: PricePoint[],
  r: number,
  q: number,
  rollDays: number
): RollSimResult | null {
  if (prices.length < 20) return null;
  // rollDays: ロール間隔。キャリーは日次連続近似で均すため実効値には影響しないが、
  // 離散ロール実装への拡張余地として受け取り、間隔ごとの区切りを path に残す。
  const step = Math.max(1, Math.floor(rollDays));
  const dailyCarry = (r - q) / 252; // 先物が現物に対して失う日次ドリフト
  const path: RollSimPoint[] = [];
  let spotCum = 1;
  let futCum = 1;
  const first = prices[0].close;
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1].close;
    const cur = prices[i].close;
    if (prev <= 0 || cur <= 0) continue;
    const ret = cur / prev - 1;
    spotCum = cur / first;
    // 先物は現物リターンで日々変動し、ロール日(step間隔)にキャリー分をまとめて負担する。
    // → futuresCum は step 日ごとに階段状に下方(コンタンゴ時)へずれ、ロールの離散性を可視化。
    futCum *= 1 + ret;
    if (i % step === 0) futCum *= 1 - dailyCarry * step;
    path.push({
      time: prices[i].time,
      spotCum,
      futuresCum: futCum,
      rollDrag: spotCum - futCum,
    });
  }
  if (path.length === 0) return null;
  const last = path[path.length - 1];
  const years = path.length / 252;
  const diff = r - q;
  return {
    path,
    totalRollDrag: last.rollDrag,
    annualizedRollDrag: years > 0 ? last.rollDrag / years : 0,
    regime:
      Math.abs(diff) < 1e-6 ? "flat" : diff > 0 ? "contango" : "backwardation",
  };
}

export interface HedgeRatioResult {
  beta: number; // 最小分散ヘッジ比率 h* = cov(S,F)/var(F)
  corr: number; // 現物と先物（ベンチ）リターン相関 ρ
  sigmaS: number; // 現物リターン標準偏差
  sigmaF: number; // 先物（ベンチ）リターン標準偏差
  n: number;
  hedgeEffectiveness: number; // ρ²（ヘッジで消せる分散割合）
}

// 最小分散ヘッジ比率 h* = ρ·σ_S/σ_F（＝ S を F に回帰した傾き）。
// stockRet を現物、benchRet を先物近似（ヘッジ手段）として推定。
export function minVarianceHedgeRatio(
  stockRet: number[],
  benchRet: number[]
): HedgeRatioResult | null {
  const n = Math.min(stockRet.length, benchRet.length);
  if (n < 20) return null;
  const s = stockRet.slice(-n);
  const f = benchRet.slice(-n);
  const ms = s.reduce((a, b) => a + b, 0) / n;
  const mf = f.reduce((a, b) => a + b, 0) / n;
  let cov = 0,
    vs = 0,
    vf = 0;
  for (let i = 0; i < n; i++) {
    const ds = s[i] - ms;
    const dfv = f[i] - mf;
    cov += ds * dfv;
    vs += ds * ds;
    vf += dfv * dfv;
  }
  cov /= n - 1;
  vs /= n - 1;
  vf /= n - 1;
  if (vf <= 0 || vs <= 0) return null;
  const beta = cov / vf;
  const corr = cov / Math.sqrt(vs * vf);
  return {
    beta,
    corr,
    sigmaS: Math.sqrt(vs),
    sigmaF: Math.sqrt(vf),
    n,
    hedgeEffectiveness: corr * corr,
  };
}
