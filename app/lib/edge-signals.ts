// エッジ探索セクション共通のシグナルカタログ。
// ウォークフォワード頑健性(C)・シグナル合成(D)が共有する「名前付きシグナル」を定義する。
//
// 設計原則:
//  - 先読みバイアス回避: positionOf(i) は「i 日終値時点で確定する情報のみ」で建玉を決める。
//    リターンは翌足 close[i] → close[i+1] で実現する(建ては翌日始値相当の近似)。
//  - position ∈ {-1, 0, +1}: ショート/ノーポジ/ロング。
//  - コストモデル: 建玉変化 |Δpos| に比例した往復コスト(bps)を控除する。

import { PricePoint } from "./types";

export interface EdgeSignal {
  id: string;
  label: string;
  category: string; // "モメンタム" | "平均回帰" | "トレンド" | "カレンダー" | "ボラ"
  positionOf: (i: number) => -1 | 0 | 1;
}

export interface SignalPerformance {
  rets: number[];    // 各日の建玉調整後リターン(コスト控除後)
  equity: number[];  // 複利エクイティ(初期1)。長さ = rets.length + 1
  dates: string[];   // 各リターンの実現日(exit)
  years: number[];   // 各リターンの実現年
  nTrades: number;   // 建玉変化(往復)回数
  exposure: number;  // 建玉が非ゼロだった日の割合
  positions: (-1 | 0 | 1)[]; // 各 i の建玉(rets と同じ添字)
}

// ---- 指標ヘルパ(全て終値ベース・因果的) ----
function sma(prices: PricePoint[], period: number): number[] {
  const n = prices.length;
  const out = new Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += prices[i].close;
    if (i >= period) sum -= prices[i - period].close;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function wilderRSI(prices: PricePoint[], period: number): number[] {
  const n = prices.length;
  const out = new Array(n).fill(NaN);
  if (n < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i].close - prices[i - 1].close;
    avgGain += d > 0 ? d : 0;
    avgLoss += d < 0 ? -d : 0;
  }
  avgGain /= period; avgLoss /= period;
  out[period] = avgLoss > 0 ? 100 - 100 / (1 + avgGain / avgLoss) : 100;
  for (let i = period + 1; i < n; i++) {
    const d = prices[i].close - prices[i - 1].close;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgLoss > 0 ? 100 - 100 / (1 + avgGain / avgLoss) : 100;
  }
  return out;
}

function trailingStd(prices: PricePoint[], period: number): number[] {
  const n = prices.length;
  const out = new Array(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += prices[j].close;
    const m = s / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (prices[j].close - m) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

// 直近 win 日(当日除く)の終値の最高/最安。ドンチャン・ブレイク用。
function priorExtreme(prices: PricePoint[], win: number, kind: "max" | "min"): number[] {
  const n = prices.length;
  const out = new Array(n).fill(NaN);
  for (let i = win; i < n; i++) {
    let e = kind === "max" ? -Infinity : Infinity;
    for (let j = i - win; j < i; j++) e = kind === "max" ? Math.max(e, prices[j].close) : Math.min(e, prices[j].close);
    out[i] = e;
  }
  return out;
}

// ============================================================
// シグナルカタログ
// ============================================================
export function buildSignalCatalog(prices: PricePoint[]): EdgeSignal[] {
  const n = prices.length;
  const rsi2 = wilderRSI(prices, 2);
  const sma50 = sma(prices, 50);
  const sma200 = sma(prices, 200);
  const sd20 = trailingStd(prices, 20);
  const sma20 = sma(prices, 20);
  const donHi = priorExtreme(prices, 20, "max");
  const donLo = priorExtreme(prices, 20, "min");
  const dow = prices.map((p) => new Date(p.time).getDay()); // 0=日 1=月 … 5=金

  const roc = (i: number, w: number) =>
    i >= w && prices[i - w].close > 0 ? prices[i].close / prices[i - w].close - 1 : NaN;

  const signals: EdgeSignal[] = [
    {
      id: "mom12_1", label: "12-1ヶ月モメンタム", category: "モメンタム",
      positionOf: (i) => {
        if (i < 252) return 0;
        const m = prices[i - 21].close / prices[i - 252].close - 1;
        return m > 0 ? 1 : -1;
      },
    },
    {
      id: "roc20", label: "20日モメンタム(ROC)", category: "モメンタム",
      positionOf: (i) => {
        const r = roc(i, 20);
        if (isNaN(r)) return 0;
        return r > 0 ? 1 : -1;
      },
    },
    {
      id: "maCross", label: "移動平均クロス(50/200)", category: "トレンド",
      positionOf: (i) => {
        if (isNaN(sma50[i]) || isNaN(sma200[i])) return 0;
        return sma50[i] > sma200[i] ? 1 : -1;
      },
    },
    {
      id: "trend200", label: "200日線トレンド", category: "トレンド",
      positionOf: (i) => {
        if (isNaN(sma200[i])) return 0;
        return prices[i].close > sma200[i] ? 1 : -1;
      },
    },
    {
      id: "rsi2rev", label: "RSI(2)逆張り", category: "平均回帰",
      positionOf: (i) => {
        const r = rsi2[i];
        if (isNaN(r) || isNaN(sma200[i])) return 0;
        // 上昇トレンド内の押し目のみロング / 下降トレンド内の戻りのみショート
        if (r < 10 && prices[i].close > sma200[i]) return 1;
        if (r > 90 && prices[i].close < sma200[i]) return -1;
        return 0;
      },
    },
    {
      id: "bbRev", label: "ボリンジャー回帰(%b)", category: "平均回帰",
      positionOf: (i) => {
        if (isNaN(sma20[i]) || isNaN(sd20[i]) || sd20[i] === 0) return 0;
        const up = sma20[i] + 2 * sd20[i], lo = sma20[i] - 2 * sd20[i];
        const pb = (prices[i].close - lo) / (up - lo);
        if (pb < 0) return 1;
        if (pb > 1) return -1;
        return 0;
      },
    },
    {
      id: "donchian", label: "ドンチャン・ブレイク(20)", category: "モメンタム",
      positionOf: (i) => {
        if (isNaN(donHi[i]) || isNaN(donLo[i])) return 0;
        if (prices[i].close > donHi[i]) return 1;
        if (prices[i].close < donLo[i]) return -1;
        return 0;
      },
    },
    {
      id: "monEffect", label: "月曜持ち越し", category: "カレンダー",
      positionOf: (i) => (dow[i] === 1 ? 1 : 0), // 月曜終値→火曜終値を保有
    },
    {
      id: "friEffect", label: "金曜持ち越し", category: "カレンダー",
      positionOf: (i) => (dow[i] === 5 ? 1 : 0), // 金曜終値→月曜終値(週末)を保有
    },
  ];

  // データが極端に短い場合は長期指標系を落とす(全部ゼロで無意味なため)
  if (n < 260) return signals.filter((s) => !["mom12_1", "maCross", "trend200", "rsi2rev"].includes(s.id));
  return signals;
}

// ============================================================
// コストモデル付きリターン列
// ============================================================
export function signalReturns(
  prices: PricePoint[],
  sig: EdgeSignal,
  costBps = 0,
): SignalPerformance {
  const n = prices.length;
  const cost = costBps / 1e4;
  const rets: number[] = [];
  const dates: string[] = [];
  const years: number[] = [];
  const positions: (-1 | 0 | 1)[] = [];
  const equity: number[] = [1];
  let prevPos: -1 | 0 | 1 = 0;
  let nTrades = 0;
  let nonZero = 0;
  for (let i = 0; i < n - 1; i++) {
    const pos = sig.positionOf(i);
    const c0 = prices[i].close, c1 = prices[i + 1].close;
    if (!(c0 > 0) || !(c1 > 0)) { prevPos = pos; continue; }
    const nextRet = c1 / c0 - 1;
    const turn = Math.abs(pos - prevPos);
    if (turn > 0) nTrades++;
    const r = pos * nextRet - cost * turn;
    rets.push(r);
    dates.push(prices[i + 1].time);
    years.push(new Date(prices[i + 1].time).getFullYear());
    positions.push(pos);
    if (pos !== 0) nonZero++;
    equity.push(equity[equity.length - 1] * (1 + r));
    prevPos = pos;
  }
  return {
    rets, equity, dates, years, positions,
    nTrades,
    exposure: rets.length > 0 ? nonZero / rets.length : 0,
  };
}
