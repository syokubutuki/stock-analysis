// 行動ファイナンス指標
// モメンタム/リバーサル効果 / アンカリング（52週高値比率）

import { PricePoint } from "./types";

export interface MomentumResult {
  periods: { days: number; avgReturn: number; winRate: number; tStat: number }[];
  currentMomentum: { [key: string]: number };
  reversalDetected: boolean;
  interpretation: string;
}

export interface AnchoringResult {
  high52w: number;
  current: number;
  ratio: number;           // current / high52w
  avgReturnNearHigh: number; // 90%+の時の翌月リターン
  avgReturnFarHigh: number;  // 70%以下の時の翌月リターン
  rollingRatio: { time: string; ratio: number }[];
  interpretation: string;
}

export interface BehavioralResult {
  momentum: MomentumResult;
  anchoring: AnchoringResult;
}

// --- モメンタム/リバーサル効果 ---
// 過去N日のリターンが、将来M日のリターンを予測するか
export function momentumAnalysis(prices: PricePoint[]): MomentumResult {
  const n = prices.length;
  if (n < 252) return emptyMomentum();

  const closes = prices.map(p => p.close);

  // N日モメンタム → 翌20日リターン
  const lookbacks = [5, 10, 20, 60, 120, 252];
  const holdingPeriod = 20;

  const periods: { days: number; avgReturn: number; winRate: number; tStat: number }[] = [];
  const currentMomentum: { [key: string]: number } = {};

  for (const lb of lookbacks) {
    if (lb + holdingPeriod >= n) continue;

    // Classify into "winners" and "losers" based on past lb-day return
    const winnerReturns: number[] = [];
    const loserReturns: number[] = [];

    for (let i = lb; i < n - holdingPeriod; i++) {
      const pastReturn = closes[i] / closes[i - lb] - 1;
      const futureReturn = closes[i + holdingPeriod] / closes[i] - 1;

      if (pastReturn > 0) {
        winnerReturns.push(futureReturn);
      } else {
        loserReturns.push(futureReturn);
      }
    }

    // Momentum = avg(winner future return) - avg(loser future return)
    const avgWinner = winnerReturns.length > 0 ? winnerReturns.reduce((s, v) => s + v, 0) / winnerReturns.length : 0;
    const avgLoser = loserReturns.length > 0 ? loserReturns.reduce((s, v) => s + v, 0) / loserReturns.length : 0;
    const momentumReturn = avgWinner - avgLoser;

    // t-stat
    const allReturns = [...winnerReturns, ...loserReturns];
    const meanAll = allReturns.reduce((s, v) => s + v, 0) / allReturns.length;
    let variance = 0;
    for (const r of allReturns) variance += (r - meanAll) ** 2;
    variance /= allReturns.length - 1;
    const se = Math.sqrt(variance / allReturns.length);
    const tStat = se > 0 ? momentumReturn / se : 0;

    const winRate = winnerReturns.length > 0
      ? winnerReturns.filter(r => r > 0).length / winnerReturns.length
      : 0;

    periods.push({
      days: lb,
      avgReturn: momentumReturn,
      winRate,
      tStat,
    });

    currentMomentum[`${lb}d`] = closes[n - 1] / closes[Math.max(0, n - 1 - lb)] - 1;
  }

  // Check for reversal (short-term momentum negative, long-term positive)
  const shortTerm = periods.find(p => p.days <= 10);
  const longTerm = periods.find(p => p.days >= 120);
  const reversalDetected = !!(shortTerm && longTerm && shortTerm.avgReturn < 0 && longTerm.avgReturn > 0);

  const strongMomentum = periods.filter(p => Math.abs(p.tStat) > 2);
  const interpretation = strongMomentum.length > 0
    ? `${strongMomentum.map(p => `${p.days}日`).join(", ")}で統計的に有意なモメンタム/リバーサル効果。` +
      (reversalDetected ? "短期リバーサル+長期モメンタムのパターン。" : "")
    : `統計的に有意なモメンタム効果は検出されず。効率的市場に近い。`;

  return { periods, currentMomentum, reversalDetected, interpretation };
}

// --- アンカリング効果（52週高値比率） ---
export function anchoringAnalysis(prices: PricePoint[]): AnchoringResult {
  const n = prices.length;
  if (n < 252) return emptyAnchoring();

  const closes = prices.map(p => p.close);

  // Rolling 52-week (252-day) high ratio
  const rollingRatio: { time: string; ratio: number }[] = [];
  for (let i = 252; i < n; i++) {
    const high252 = Math.max(...closes.slice(i - 252, i + 1));
    const ratio = high252 > 0 ? closes[i] / high252 : 0;
    rollingRatio.push({ time: prices[i].time, ratio });
  }

  // Current
  const high52w = Math.max(...closes.slice(Math.max(0, n - 252)));
  const current = closes[n - 1];
  const ratio = high52w > 0 ? current / high52w : 0;

  // Conditional returns: near high (>90%) vs far (<=70%)
  const holdPeriod = 20;
  const nearHighReturns: number[] = [];
  const farHighReturns: number[] = [];

  for (let i = 252; i < n - holdPeriod; i++) {
    const high = Math.max(...closes.slice(i - 252, i + 1));
    const r = high > 0 ? closes[i] / high : 0;
    const futReturn = closes[i + holdPeriod] / closes[i] - 1;

    if (r > 0.9) nearHighReturns.push(futReturn);
    else if (r <= 0.7) farHighReturns.push(futReturn);
  }

  const avgNear = nearHighReturns.length > 0 ? nearHighReturns.reduce((s, v) => s + v, 0) / nearHighReturns.length : 0;
  const avgFar = farHighReturns.length > 0 ? farHighReturns.reduce((s, v) => s + v, 0) / farHighReturns.length : 0;

  const interpretation =
    `52週高値比率: ${(ratio * 100).toFixed(1)}%。` +
    (ratio > 0.95
      ? `新高値に近い。心理的抵抗があるが、ブレイクアウトの可能性も。`
      : ratio > 0.8
        ? `高値からやや下落。52週高値が心理的なアンカーとして機能する可能性。`
        : `高値から大きく下落。「安くなった」というアンカリングバイアスに注意。`) +
    ` 高値近辺(>90%)での翌月平均リターン: ${(avgNear * 100).toFixed(2)}%、` +
    `低水準(≤70%): ${(avgFar * 100).toFixed(2)}%。`;

  return {
    high52w, current, ratio,
    avgReturnNearHigh: avgNear,
    avgReturnFarHigh: avgFar,
    rollingRatio,
    interpretation,
  };
}

// --- 総合 ---
export function behavioralAnalysis(prices: PricePoint[]): BehavioralResult {
  return {
    momentum: momentumAnalysis(prices),
    anchoring: anchoringAnalysis(prices),
  };
}

function emptyMomentum(): MomentumResult {
  return { periods: [], currentMomentum: {}, reversalDetected: false, interpretation: "データ不足" };
}

function emptyAnchoring(): AnchoringResult {
  return { high52w: 0, current: 0, ratio: 0, avgReturnNearHigh: 0, avgReturnFarHigh: 0, rollingRatio: [], interpretation: "データ不足" };
}
