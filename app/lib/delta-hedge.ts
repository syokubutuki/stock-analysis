// デルタヘッジ・シミュレーション。
// 実データの価格パス上で「ATMコールをロングし、Δ株ショートで連続ヘッジ」する自己資金戦略を回す。
// BS理論では、ヘッジ後P&L ≈ Σ ½·Γ·S²·(実現分散 − インプライド分散) となり、
// 「ガンマ・スキャルピング」＝実現σがインプライドσを上回った分だけロングガンマが儲かる。
// これを数値で体感させるのが目的。

import { PricePoint } from "./types";
import { bsPrice, bsGreeks, annualizedRealizedVol, logReturns } from "./derivatives-core";

export interface HedgeStep {
  time: string;
  S: number;
  delta: number; // オプションのΔ（= 保有株数の符号反転）
  T: number; // 残存年数
  portfolioValue: number; // マーク・トゥ・マーケット（≈0付近を推移）
}

export interface FreqScanPoint {
  every: number; // リバランス間隔（日）
  finalPnL: number;
  rmsError: number; // 日次P&L変動のRMS（ヘッジ誤差の代理）
}

export interface DeltaHedgeResult {
  steps: HedgeStep[];
  premium: number; // 支払ったオプション代金
  impliedSigma: number;
  realizedSigma: number;
  finalPnL: number; // 最終損益（プレミアム基準）
  gammaPnL: number; // Σ ½Γ(ΔS)²（ガンマ・スキャルピング項）
  thetaPnL: number; // Σ Θ·dt（時間価値の減衰項、通常マイナス）
  rmsError: number;
  freqScan: FreqScanPoint[];
  K: number;
}

export interface HedgeParams {
  impliedSigma: number;
  rebalanceEvery: number; // 日
  r: number;
  q: number;
  cost: number; // 片道取引コスト率（例 0.001 = 10bps）
}

interface SimCore {
  steps: HedgeStep[];
  finalPnL: number;
  gammaPnL: number;
  thetaPnL: number;
  rmsError: number;
  premium: number;
}

// 1回分のヘッジシミュレーション本体。
function runSim(
  closes: number[],
  times: string[],
  K: number,
  T0: number,
  p: HedgeParams
): SimCore {
  const { impliedSigma: sigma, rebalanceEvery, r, q, cost } = p;
  const N = closes.length;
  const dt = 1 / 252;
  const type = "call" as const;

  const S0 = closes[0];
  const premium = bsPrice({ S: S0, K, T: T0, r, q, sigma, type }).price;
  let delta = bsGreeks({ S: S0, K, T: T0, r, q, sigma, type }).delta;

  // ロングオプション＋Δ株ショート。保有株数 = -Δ。
  let shares = -delta;
  // cash: プレミアム支払い(-premium) + 株ショート益(-shares*S0) - 取引コスト。
  let cash = -premium - shares * S0 - Math.abs(shares) * S0 * cost;

  const steps: HedgeStep[] = [];
  let gammaPnL = 0;
  let thetaPnL = 0;
  const pnlChanges: number[] = [];
  let prevValue = 0;

  for (let i = 0; i < N; i++) {
    const S = closes[i];
    const T = Math.max(T0 - i * dt, 0);
    const g = bsGreeks({ S, K, T, r, q, sigma, type });
    const optVal = bsPrice({ S, K, T, r, q, sigma, type }).price;

    // ガンマ/シータ分解（前ステップから今ステップへの寄与）。
    if (i > 0) {
      const dS = S - closes[i - 1];
      const prevG = bsGreeks({
        S: closes[i - 1],
        K,
        T: Math.max(T0 - (i - 1) * dt, 0),
        r,
        q,
        sigma,
        type,
      });
      gammaPnL += 0.5 * prevG.gamma * dS * dS;
      thetaPnL += prevG.theta * dt;
    }

    // リバランス判定（初回と間隔ごと、最終日は必ず）。
    const rebalance = i === 0 || i % rebalanceEvery === 0 || i === N - 1;
    if (rebalance && T > 0) {
      const targetShares = -g.delta;
      const trade = targetShares - shares;
      cash -= trade * S; // 株購入はcash減
      cash -= Math.abs(trade) * S * cost;
      shares = targetShares;
      delta = g.delta;
    }

    // マーク・トゥ・マーケット: cash + 株評価 + オプション評価 + プレミアム(戻し) 。
    // premium を足し戻すことで「損益（0基準）」にする。
    const value = cash + shares * S + optVal + premium;
    steps.push({ time: times[i], S, delta: g.delta, T, portfolioValue: value });

    if (i > 0) pnlChanges.push(value - prevValue);
    prevValue = value;
  }

  // 満期決済: オプションはペイオフ、株は手仕舞い。
  const ST = closes[N - 1];
  const payoff = Math.max(ST - K, 0);
  const finalCash = cash + shares * ST - Math.abs(shares) * ST * cost;
  const finalPnL = finalCash + payoff + premium; // 0基準

  const rmsError =
    pnlChanges.length > 0
      ? Math.sqrt(
          pnlChanges.reduce((s, v) => s + v * v, 0) / pnlChanges.length
        )
      : 0;

  return { steps, finalPnL, gammaPnL, thetaPnL, rmsError, premium };
}

export function simulateDeltaHedge(
  prices: PricePoint[],
  p: HedgeParams
): DeltaHedgeResult | null {
  const closes = prices.map((x) => x.close).filter((c) => c > 0);
  const times = prices.filter((x) => x.close > 0).map((x) => x.time);
  const N = closes.length;
  if (N < 20 || p.impliedSigma <= 0) return null;

  const K = closes[0]; // ATM
  const T0 = (N - 1) / 252;
  const realizedSigma = annualizedRealizedVol(logReturns(closes));

  const main = runSim(closes, times, K, T0, p);

  // リバランス頻度スキャン。
  const freqs = [1, 2, 3, 5, 10, 21].filter((f) => f < N / 2);
  const freqScan: FreqScanPoint[] = freqs.map((every) => {
    const r = runSim(closes, times, K, T0, { ...p, rebalanceEvery: every });
    return { every, finalPnL: r.finalPnL, rmsError: r.rmsError };
  });

  return {
    steps: main.steps,
    premium: main.premium,
    impliedSigma: p.impliedSigma,
    realizedSigma,
    finalPnL: main.finalPnL,
    gammaPnL: main.gammaPnL,
    thetaPnL: main.thetaPnL,
    rmsError: main.rmsError,
    freqScan,
    K,
  };
}
