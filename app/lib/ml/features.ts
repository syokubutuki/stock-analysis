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

/** 終値の指数移動平均(EMA)。end時点まで period 本の重み付き平均を逐次計算 */
function ema(prices: PricePoint[], end: number, period: number): number {
  const k = 2 / (period + 1);
  // 初期値は (period本前のさらに過去) を起点にした逐次更新。
  // lookback で十分な過去本数を確保しているので、(end - 2*period) 付近から走らせて収束させる。
  const start = Math.max(1, end - period * 3 + 1);
  let e = prices[start].close;
  for (let j = start + 1; j <= end; j++) {
    e = prices[j].close * k + e * (1 - k);
  }
  return e;
}

/** 終値の対数リターン配列(直近period本)を返す */
function logReturns(prices: PricePoint[], end: number, period: number): number[] {
  const r: number[] = [];
  for (let i = end - period + 1; i <= end; i++) {
    r.push(Math.log(prices[i].close / prices[i - 1].close));
  }
  return r;
}

/** 平均 */
function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
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
  // ===== 追加特徴量 =====
  {
    id: "macd",
    label: "MACD(正規化)",
    defaultEnabled: true,
    params: [
      { name: "fast", label: "短期", default: 12, min: 3, max: 30, step: 1 },
      { name: "slow", label: "長期", default: 26, min: 10, max: 60, step: 1 },
      { name: "signal", label: "シグナル", default: 9, min: 3, max: 20, step: 1 },
    ],
    // EMAは過去3倍本数で収束させるため slow*3 程度を確保
    lookback: (ps) => Math.ceil(ps.slow * 3),
    compute: (p, i, ps) => {
      const macdLine = ema(p, i, ps.fast) - ema(p, i, ps.slow);
      // 価格で正規化して相対値に
      return p[i].close > 0 ? macdLine / p[i].close : 0;
    },
  },
  {
    id: "macd_signal_diff",
    label: "MACD-シグナル差",
    defaultEnabled: false,
    params: [
      { name: "fast", label: "短期", default: 12, min: 3, max: 30, step: 1 },
      { name: "slow", label: "長期", default: 26, min: 10, max: 60, step: 1 },
      { name: "signal", label: "シグナル", default: 9, min: 3, max: 20, step: 1 },
    ],
    lookback: (ps) => Math.ceil(ps.slow * 3 + ps.signal * 3),
    compute: (p, i, ps) => {
      const k = 2 / (ps.signal + 1);
      // MACD線のシグナルEMAを、MACD線を逐次計算しながら求める
      const start = Math.max(Math.ceil(ps.slow * 3), i - ps.signal * 3 + 1);
      const macdAt = (j: number) => ema(p, j, ps.fast) - ema(p, j, ps.slow);
      let sig = macdAt(start);
      for (let j = start + 1; j <= i; j++) {
        sig = macdAt(j) * k + sig * (1 - k);
      }
      const macdLine = macdAt(i);
      return p[i].close > 0 ? (macdLine - sig) / p[i].close : 0;
    },
  },
  {
    id: "ret_lag1",
    label: "ラグ1リターン",
    defaultEnabled: false,
    params: [],
    lookback: () => 2,
    compute: (p, i) => Math.log(p[i - 1].close / p[i - 2].close),
  },
  {
    id: "ret_lag2",
    label: "ラグ2リターン",
    defaultEnabled: false,
    params: [],
    lookback: () => 3,
    compute: (p, i) => Math.log(p[i - 2].close / p[i - 3].close),
  },
  {
    id: "ret_lag3",
    label: "ラグ3リターン",
    defaultEnabled: false,
    params: [],
    lookback: () => 4,
    compute: (p, i) => Math.log(p[i - 3].close / p[i - 4].close),
  },
  {
    id: "dist_high",
    label: "高値距離",
    defaultEnabled: false,
    params: [{ name: "period", label: "期間", default: 252, min: 20, max: 504, step: 1 }],
    lookback: (ps) => ps.period - 1,
    compute: (p, i, ps) => {
      let mx = p[i].close;
      for (let j = i - ps.period + 1; j <= i; j++) {
        if (j < 0) continue;
        if (p[j].close > mx) mx = p[j].close;
      }
      return mx > 0 ? (p[i].close - mx) / mx : 0;
    },
  },
  {
    id: "dist_low",
    label: "安値距離",
    defaultEnabled: false,
    params: [{ name: "period", label: "期間", default: 252, min: 20, max: 504, step: 1 }],
    lookback: (ps) => ps.period - 1,
    compute: (p, i, ps) => {
      let mn = p[i].close;
      for (let j = i - ps.period + 1; j <= i; j++) {
        if (j < 0) continue;
        if (p[j].close < mn) mn = p[j].close;
      }
      return mn > 0 ? (p[i].close - mn) / mn : 0;
    },
  },
  {
    id: "atr",
    label: "ATR(正規化)",
    defaultEnabled: true,
    params: [{ name: "period", label: "期間", default: 14, min: 2, max: 60, step: 1 }],
    lookback: (ps) => ps.period,
    compute: (p, i, ps) => {
      let sum = 0;
      for (let j = i - ps.period + 1; j <= i; j++) {
        const prevClose = p[j - 1].close;
        const tr = Math.max(
          p[j].high - p[j].low,
          Math.abs(p[j].high - prevClose),
          Math.abs(p[j].low - prevClose),
        );
        sum += tr;
      }
      const atr = sum / ps.period;
      return p[i].close > 0 ? atr / p[i].close : 0;
    },
  },
  {
    id: "volume_z",
    label: "出来高zスコア",
    defaultEnabled: false,
    params: [{ name: "period", label: "期間", default: 20, min: 5, max: 100, step: 1 }],
    lookback: (ps) => ps.period - 1,
    compute: (p, i, ps) => {
      let s = 0;
      for (let j = i - ps.period + 1; j <= i; j++) s += p[j].volume;
      const m = s / ps.period;
      let sq = 0;
      for (let j = i - ps.period + 1; j <= i; j++) sq += (p[j].volume - m) ** 2;
      const sd = Math.sqrt(sq / ps.period);
      return sd > 1e-9 ? (p[i].volume - m) / sd : 0;
    },
  },
  {
    id: "ret_skew",
    label: "リターン歪度",
    defaultEnabled: false,
    params: [{ name: "period", label: "期間", default: 20, min: 5, max: 100, step: 1 }],
    lookback: (ps) => ps.period,
    compute: (p, i, ps) => {
      const r = logReturns(p, i, ps.period);
      const m = mean(r);
      const n = r.length;
      const var_ = r.reduce((a, v) => a + (v - m) ** 2, 0) / n;
      const sd = Math.sqrt(var_);
      if (sd < 1e-9) return 0;
      const s3 = r.reduce((a, v) => a + ((v - m) / sd) ** 3, 0) / n;
      return s3;
    },
  },
  {
    id: "ret_kurt",
    label: "リターン尖度(過剰)",
    defaultEnabled: false,
    params: [{ name: "period", label: "期間", default: 20, min: 5, max: 100, step: 1 }],
    lookback: (ps) => ps.period,
    compute: (p, i, ps) => {
      const r = logReturns(p, i, ps.period);
      const m = mean(r);
      const n = r.length;
      const var_ = r.reduce((a, v) => a + (v - m) ** 2, 0) / n;
      const sd = Math.sqrt(var_);
      if (sd < 1e-9) return 0;
      const s4 = r.reduce((a, v) => a + ((v - m) / sd) ** 4, 0) / n;
      return s4 - 3; // 過剰尖度
    },
  },
  {
    id: "dow",
    label: "曜日",
    defaultEnabled: false,
    params: [],
    lookback: () => 0,
    compute: (p, i) => {
      const d = new Date(p[i].time).getUTCDay();
      return Number.isFinite(d) ? d : 0;
    },
  },
  {
    id: "month",
    label: "月",
    defaultEnabled: false,
    params: [],
    lookback: () => 0,
    compute: (p, i) => {
      const m = new Date(p[i].time).getUTCMonth();
      return Number.isFinite(m) ? m + 1 : 0;
    },
  },
  {
    id: "turn_of_month",
    label: "月替わり",
    defaultEnabled: false,
    params: [{ name: "days", label: "日数", default: 3, min: 1, max: 7, step: 1 }],
    lookback: () => 0,
    compute: (p, i, ps) => {
      const day = new Date(p[i].time).getUTCDate();
      // 月の総日数を求める(翌月0日 = 当月末日)
      const dt = new Date(p[i].time);
      const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
      const d = Number.isFinite(day) && Number.isFinite(lastDay) ? day : NaN;
      if (!Number.isFinite(d)) return 0;
      // 月初days日以内 または 月末days日以内なら1
      return d <= ps.days || d >= lastDay - ps.days + 1 ? 1 : 0;
    },
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

/** 行列を列ごとに因果的(過去のみ)ローリングz-scoreで標準化する。
 *  X[t] は時刻順に並んだ特徴ベクトル。各列について、各行tを
 *  (x - mean(直近window行,t含む)) / std(...) に変換。分散0や初期の
 *  サンプル不足時は0を返す。未来情報を一切使わないこと(リーク禁止)。
 *
 *  各列について rolling sum / sumSq を逐次更新し O(N×F) で計算する。 */
export function standardizeMatrixCausal(X: number[][], window: number): number[][] {
  const n = X.length;
  if (n === 0) return [];
  const f = X[0].length;
  const w = Math.max(1, Math.floor(window));
  const out: number[][] = Array.from({ length: n }, () => new Array(f).fill(0));

  for (let c = 0; c < f; c++) {
    let sum = 0;
    let sumSq = 0;
    for (let t = 0; t < n; t++) {
      const x = X[t][c];
      // 現在行を加算
      sum += x;
      sumSq += x * x;
      // ウィンドウから外れた行を減算 (trailing: 過去のみ, 現在行含む)
      if (t >= w) {
        const old = X[t - w][c];
        sum -= old;
        sumSq -= old * old;
      }
      const count = Math.min(t + 1, w);
      const m = sum / count;
      // 母分散 (count で割る)。数値誤差で負になりうるので0でクランプ
      const variance = Math.max(0, sumSq / count - m * m);
      const sd = Math.sqrt(variance);
      // サンプル不足(count<2)または分散極小なら0
      out[t][c] = count >= 2 && sd > 1e-9 ? (x - m) / sd : 0;
    }
  }
  return out;
}
