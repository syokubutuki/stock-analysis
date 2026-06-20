// 日足ローソクの「中身」（実体・ヒゲ・レンジ・終値位置・日中の上下到達・窓・陽線）を
// 曜日/月のカレンダー軸で分解する。既存のカレンダー分析が「前X→当X」の点対点
// 変化率しか使わないのに対し、本モジュールは1本のローソク足の形状そのものを集計する。

import { PricePoint } from "./types";

export interface DayCandle {
  weekday: number; // 0=日..6=土
  month: number; // 0..11
  bodyPct: number; // |C-O| / (H-L)
  upperWickPct: number; // (H-max(O,C)) / (H-L)
  lowerWickPct: number; // (min(O,C)-L) / (H-L)
  rangePct: number; // (H-L) / C
  gkVol: number; // Garman-Klass 日次ボラ推定（標準偏差, 比率）
  clv: number; // (2C-H-L)/(H-L)  +1=高値引け / -1=安値引け
  mfeUp: number; // (H-O)/O 寄りからの上振れ
  maeDown: number; // (O-L)/O 寄りからの下振れ（正の大きさ）
  gap: number; // (O-prevC)/prevC （初日は NaN）
  filled: boolean | null; // 窓が当日中に前日終値を埋めたか
  bullish: boolean; // C>O
}

const LN2 = Math.log(2);

export function extractCandles(prices: PricePoint[]): DayCandle[] {
  const out: DayCandle[] = [];
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    const { open: O, high: H, low: L, close: C } = p;
    if (!(O > 0 && H > 0 && L > 0 && C > 0) || H < L) continue;
    const range = H - L;
    const d = new Date(p.time);

    // Garman-Klass: 0.5*(ln(H/L))^2 - (2ln2-1)*(ln(C/O))^2
    const gkVar = 0.5 * Math.log(H / L) ** 2 - (2 * LN2 - 1) * Math.log(C / O) ** 2;
    const gkVol = Math.sqrt(Math.max(0, gkVar));

    let gap = NaN;
    let filled: boolean | null = null;
    if (i > 0) {
      const prevC = prices[i - 1].close;
      if (prevC > 0) {
        gap = (O - prevC) / prevC;
        if (gap > 0) filled = L <= prevC; // 上窓: 安値が前日終値まで下がれば埋め
        else if (gap < 0) filled = H >= prevC; // 下窓: 高値が前日終値まで戻れば埋め
        else filled = true;
      }
    }

    out.push({
      weekday: d.getDay(),
      month: d.getMonth(),
      bodyPct: range > 0 ? Math.abs(C - O) / range : 0,
      upperWickPct: range > 0 ? (H - Math.max(O, C)) / range : 0,
      lowerWickPct: range > 0 ? (Math.min(O, C) - L) / range : 0,
      rangePct: (H - L) / C,
      gkVol,
      clv: range > 0 ? (2 * C - H - L) / range : 0,
      mfeUp: (H - O) / O,
      maeDown: (O - L) / O,
      gap,
      filled,
      bullish: C > O,
    });
  }
  return out;
}

export type SeasonAxis = "weekday" | "month";

export interface BucketAgg {
  key: number;
  label: string;
  n: number;
  body: number;
  upper: number;
  lower: number;
  rangePct: number;
  gkVol: number;
  clv: number;
  mfeUp: number;
  maeDown: number;
  gapUpRate: number;
  gapDownRate: number;
  fillRate: number; // 窓発生日のうち埋めた割合
  bullRate: number;
}

const WD_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const MONTH_LABELS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
const GAP_EPS = 0.001; // 窓とみなす最小ギャップ（0.1%）

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

export function aggregateSeason(candles: DayCandle[], axis: SeasonAxis): BucketAgg[] {
  const keys = axis === "weekday" ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const result: BucketAgg[] = [];

  for (const key of keys) {
    const grp = candles.filter((c) => (axis === "weekday" ? c.weekday : c.month) === key);
    if (grp.length === 0) continue;

    const gapDays = grp.filter((c) => !isNaN(c.gap) && Math.abs(c.gap) >= GAP_EPS);
    const gapUp = gapDays.filter((c) => c.gap > 0);
    const gapDown = gapDays.filter((c) => c.gap < 0);
    const filledDays = gapDays.filter((c) => c.filled);

    result.push({
      key,
      label: axis === "weekday" ? WD_LABELS[key] : MONTH_LABELS[key],
      n: grp.length,
      body: mean(grp.map((c) => c.bodyPct)),
      upper: mean(grp.map((c) => c.upperWickPct)),
      lower: mean(grp.map((c) => c.lowerWickPct)),
      rangePct: mean(grp.map((c) => c.rangePct)),
      gkVol: mean(grp.map((c) => c.gkVol)),
      clv: mean(grp.map((c) => c.clv)),
      mfeUp: mean(grp.map((c) => c.mfeUp)),
      maeDown: mean(grp.map((c) => c.maeDown)),
      gapUpRate: grp.length ? gapUp.length / grp.length : 0,
      gapDownRate: grp.length ? gapDown.length / grp.length : 0,
      fillRate: gapDays.length ? filledDays.length / gapDays.length : 0,
      bullRate: grp.length ? grp.filter((c) => c.bullish).length / grp.length : 0,
    });
  }
  return result;
}
