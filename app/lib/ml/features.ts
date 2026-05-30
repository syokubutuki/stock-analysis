/** 予測モデル用 特徴量ライブラリ */
import { PricePoint } from "../types";

export interface FeatureParam {
  name: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
}

export interface FeatureDef {
  id: string;
  label: string;
  defaultEnabled: boolean;
  params: FeatureParam[];
  lookback: (params: Record<string, number>) => number;
  compute: (prices: PricePoint[], i: number, params: Record<string, number>) => number;
}

function sma(prices: PricePoint[], end: number, period: number): number {
  let s = 0;
  for (let i = end - period + 1; i <= end; i++) s += prices[i].close;
  return s / period;
}

function stdReturns(prices: PricePoint[], end: number, period: number): number {
  const r: number[] = [];
  for (let i = end - period + 1; i <= end; i++) {
    r.push(Math.log(prices[i].close / prices[i - 1].close));
  }
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, v) => a + (v - m) ** 2, 0) / r.length);
}

export const FEATURE_LIBRARY: FeatureDef[] = [
  {
    id: "ret_1d",
    label: "1日リターン",
    defaultEnabled: true,
    params: [],
    lookback: () => 1,
    compute: (p, i) => Math.log(p[i].close / p[i - 1].close),
  },
  {
    id: "ret_5d",
    label: "5日リターン",
    defaultEnabled: true,
    params: [],
    lookback: () => 5,
    compute: (p, i) => Math.log(p[i].close / p[i - 5].close),
  },
  {
    id: "ret_20d",
    label: "20日リターン",
    defaultEnabled: false,
    params: [],
    lookback: () => 20,
    compute: (p, i) => Math.log(p[i].close / p[i - 20].close),
  },
  {
    id: "rsi",
    label: "RSI",
    defaultEnabled: true,
    params: [{ name: "period", label: "期間", default: 14, min: 2, max: 50, step: 1 }],
    lookback: (ps) => ps.period + 1,
    compute: (p, i, ps) => {
      let gain = 0, loss = 0;
      for (let j = i - ps.period + 1; j <= i; j++) {
        const d = p[j].close - p[j - 1].close;
        if (d > 0) gain += d; else loss -= d;
      }
      return gain + loss === 0 ? 50 : (100 * gain) / (gain + loss);
    },
  },
  {
    id: "sma_dev",
    label: "SMA乖離率",
    defaultEnabled: true,
    params: [{ name: "period", label: "期間", default: 20, min: 5, max: 200, step: 5 }],
    lookback: (ps) => ps.period,
    compute: (p, i, ps) => {
      const avg = sma(p, i, ps.period);
      return (p[i].close - avg) / avg;
    },
  },
  {
    id: "vol_10d",
    label: "10日ボラティリティ",
    defaultEnabled: true,
    params: [],
    lookback: () => 11,
    compute: (p, i) => stdReturns(p, i, 10),
  },
  {
    id: "vol_ratio",
    label: "短期/長期ボラ比",
    defaultEnabled: false,
    params: [
      { name: "short", label: "短期", default: 5, min: 3, max: 20, step: 1 },
      { name: "long", label: "長期", default: 20, min: 10, max: 60, step: 5 },
    ],
    lookback: (ps) => ps.long + 1,
    compute: (p, i, ps) => {
      const sv = stdReturns(p, i, ps.short);
      const lv = stdReturns(p, i, ps.long);
      return lv > 0 ? sv / lv : 1;
    },
  },
  {
    id: "volume_change",
    label: "出来高変化率",
    defaultEnabled: false,
    params: [],
    lookback: () => 1,
    compute: (p, i) => (p[i - 1].volume > 0 ? (p[i].volume - p[i - 1].volume) / p[i - 1].volume : 0),
  },
  {
    id: "bb_pos",
    label: "ボリンジャー位置",
    defaultEnabled: false,
    params: [{ name: "period", label: "期間", default: 20, min: 5, max: 50, step: 5 }],
    lookback: (ps) => ps.period,
    compute: (p, i, ps) => {
      const avg = sma(p, i, ps.period);
      let sq = 0;
      for (let j = i - ps.period + 1; j <= i; j++) sq += (p[j].close - avg) ** 2;
      const sd = Math.sqrt(sq / ps.period);
      return sd > 0 ? (p[i].close - avg) / (2 * sd) : 0;
    },
  },
  {
    id: "candle_body",
    label: "ローソク実体比",
    defaultEnabled: false,
    params: [],
    lookback: () => 0,
    compute: (p, i) => {
      const rng = p[i].high - p[i].low;
      return rng > 0 ? (p[i].close - p[i].open) / rng : 0;
    },
  },
  {
    id: "gap",
    label: "ギャップ率",
    defaultEnabled: false,
    params: [],
    lookback: () => 1,
    compute: (p, i) => (p[i - 1].close > 0 ? (p[i].open - p[i - 1].close) / p[i - 1].close : 0),
  },
];

/** 有効な特徴量に必要な最大lookback */
export function maxLookback(
  enabled: Set<string>,
  paramMap: Record<string, Record<string, number>>,
): number {
  let mx = 0;
  for (const f of FEATURE_LIBRARY) {
    if (!enabled.has(f.id)) continue;
    const ps = paramMap[f.id] ?? Object.fromEntries(f.params.map((p) => [p.name, p.default]));
    mx = Math.max(mx, f.lookback(ps));
  }
  return mx;
}

/** 単一データポイントの特徴量ベクトルを計算 */
export function computeFeatureVector(
  prices: PricePoint[],
  index: number,
  enabled: Set<string>,
  paramMap: Record<string, Record<string, number>>,
): number[] {
  const vec: number[] = [];
  for (const f of FEATURE_LIBRARY) {
    if (!enabled.has(f.id)) continue;
    const ps = paramMap[f.id] ?? Object.fromEntries(f.params.map((p) => [p.name, p.default]));
    vec.push(f.compute(prices, index, ps));
  }
  return vec;
}

/** 有効な特徴量IDリスト (順序固定) */
export function enabledFeatureList(enabled: Set<string>): FeatureDef[] {
  return FEATURE_LIBRARY.filter((f) => enabled.has(f.id));
}
