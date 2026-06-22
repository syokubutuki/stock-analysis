// 裁量トレードの売買エンジン
//
// 旧 trade アプリ (trading-engine.ts) からの移植。共有 PricePoint を使い、
// さらに「取引コスト (手数料・スリッページ)」を加味できるよう costRate を追加した。
// 全力買い / 全力売り (現金を全て株に / 株を全て現金に) を前提とする。

import { PricePoint } from "./types";

export interface Trade {
  date: string;
  action: "buy" | "sell";
  price: number;
  shares: number;
  cash: number; // 取引後の現金
  totalValue: number; // 取引直後の評価総額
  cost?: number; // この取引で支払ったコスト
  note?: string; // 感情ログ (なぜ買った/売ったか)
}

export interface TradingState {
  cash: number;
  shares: number;
  trades: Trade[];
  initialCash: number;
  costRate: number; // 取引額に対するコスト率 (0.001 = 0.1%)
}

export interface ComparisonResult {
  buyAndHoldReturn: number;
  buyAndHoldPercent: number;
  humanReturn: number;
  humanPercent: number;
  difference: number;
  differencePercent: number;
}

export type TradingAction =
  | { type: "BUY"; price: number; date: string; note?: string }
  | { type: "SELL"; price: number; date: string; note?: string }
  | { type: "RESET"; initialCash: number; costRate: number };

// 全力買い: コストを差し引いた上で買える最大株数を購入する。
export function executeBuy(
  state: TradingState,
  price: number,
  date: string,
  note?: string
): TradingState {
  if (state.cash <= 0 || price <= 0) return state;
  // shares*price + shares*price*costRate <= cash を満たす最大の shares
  const unit = price * (1 + state.costRate);
  const shares = Math.floor(state.cash / unit);
  if (shares === 0) return state;
  const gross = shares * price;
  const cost = gross * state.costRate;
  const newCash = state.cash - gross - cost;
  const totalShares = state.shares + shares;
  const totalValue = newCash + totalShares * price;
  const trade: Trade = {
    date,
    action: "buy",
    price,
    shares,
    cash: newCash,
    totalValue,
    cost,
    note,
  };
  return {
    ...state,
    cash: newCash,
    shares: totalShares,
    trades: [...state.trades, trade],
  };
}

// 全力売り: 保有株を全て売却し、コストを差し引く。
export function executeSell(
  state: TradingState,
  price: number,
  date: string,
  note?: string
): TradingState {
  if (state.shares <= 0 || price <= 0) return state;
  const gross = state.shares * price;
  const cost = gross * state.costRate;
  const newCash = state.cash + gross - cost;
  const trade: Trade = {
    date,
    action: "sell",
    price,
    shares: state.shares,
    cash: newCash,
    totalValue: newCash,
    cost,
    note,
  };
  return {
    ...state,
    cash: newCash,
    shares: 0,
    trades: [...state.trades, trade],
  };
}

// Buy & Hold の資産曲線。初日にコストを払って買い、以後放置。
export function generateBuyAndHoldCurve(
  prices: PricePoint[],
  initialCash: number,
  costRate = 0
): { time: string; value: number }[] {
  if (prices.length === 0) return [];
  const firstPrice = prices[0].close;
  if (firstPrice <= 0) return prices.map((p) => ({ time: p.time, value: initialCash }));
  // 入口コストを差し引いた額で端株込み購入 (放置ベンチマークなので端株を許容)
  const invested = initialCash / (1 + costRate);
  const shares = invested / firstPrice;
  return prices.map((p) => ({
    time: p.time,
    value: shares * p.close,
  }));
}

// 一連のトレード (買い/売りシグナル) を replay して資産曲線を生成する。
// executeBuy/executeSell と同じコスト・端株なしのロジックで一貫させる。
export function generateHumanCurve(
  prices: PricePoint[],
  trades: Trade[],
  initialCash: number,
  costRate = 0
): { time: string; value: number }[] {
  if (prices.length === 0) return [];

  let cash = initialCash;
  let shares = 0;
  let tradeIndex = 0;
  const sorted = [...trades].sort((a, b) => (a.date < b.date ? -1 : 1));

  return prices.map((p) => {
    while (tradeIndex < sorted.length && sorted[tradeIndex].date === p.time) {
      const t = sorted[tradeIndex];
      if (t.action === "buy" && cash > 0 && t.price > 0) {
        const unit = t.price * (1 + costRate);
        const bought = Math.floor(cash / unit);
        if (bought > 0) {
          const gross = bought * t.price;
          cash -= gross + gross * costRate;
          shares += bought;
        }
      } else if (t.action === "sell" && shares > 0 && t.price > 0) {
        const gross = shares * t.price;
        cash += gross - gross * costRate;
        shares = 0;
      }
      tradeIndex++;
    }
    return {
      time: p.time,
      value: cash + shares * p.close,
    };
  });
}

// 最終時点での Buy & Hold vs 人間トレードの比較。
export function calculateComparison(
  prices: PricePoint[],
  state: TradingState
): ComparisonResult {
  if (prices.length === 0) {
    return {
      buyAndHoldReturn: 0,
      buyAndHoldPercent: 0,
      humanReturn: 0,
      humanPercent: 0,
      difference: 0,
      differencePercent: 0,
    };
  }

  const lastPrice = prices[prices.length - 1].close;
  const firstPrice = prices[0].close;

  const bhShares = firstPrice > 0 ? state.initialCash / (1 + state.costRate) / firstPrice : 0;
  const buyAndHoldValue = bhShares * lastPrice;
  const buyAndHoldReturn = buyAndHoldValue - state.initialCash;
  const buyAndHoldPercent =
    state.initialCash > 0 ? (buyAndHoldReturn / state.initialCash) * 100 : 0;

  const humanValue = state.cash + state.shares * lastPrice;
  const humanReturn = humanValue - state.initialCash;
  const humanPercent =
    state.initialCash > 0 ? (humanReturn / state.initialCash) * 100 : 0;

  const difference = humanReturn - buyAndHoldReturn;
  const differencePercent = humanPercent - buyAndHoldPercent;

  return {
    buyAndHoldReturn,
    buyAndHoldPercent,
    humanReturn,
    humanPercent,
    difference,
    differencePercent,
  };
}
