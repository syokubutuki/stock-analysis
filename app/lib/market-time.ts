/**
 * Market Time: 市場時間の再定義
 * カレンダー時間の代わりに出来高時間・ボラティリティ時間で再サンプリング
 */
import { PricePoint } from "./types";

export interface MarketTimePoint {
  /** 元のカレンダー日付 */
  calendarTime: string;
  /** 出来高累積時間 (0-1 正規化) */
  volumeTime: number;
  /** ボラティリティ累積時間 (0-1 正規化) */
  volatilityTime: number;
  /** 終値 */
  close: number;
  /** 対数リターン */
  logReturn: number;
}

export interface MarketTimeResult {
  data: MarketTimePoint[];
  /** 出来高時間での等間隔リサンプリング */
  volumeResampled: { time: number; close: number }[];
  /** ボラティリティ時間での等間隔リサンプリング */
  volatilityResampled: { time: number; close: number }[];
  /** 時間歪み統計 */
  stats: {
    /** 出来高時間のGini係数（不均一度） */
    volumeGini: number;
    /** ボラティリティ時間のGini係数 */
    volatilityGini: number;
    /** カレンダー時間対出来高時間の相関 */
    volumeCorrelation: number;
    /** カレンダー時間対ボラティリティ時間の相関 */
    volatilityCorrelation: number;
  };
}

export function computeMarketTime(
  prices: PricePoint[],
  resampleN: number = 200
): MarketTimeResult {
  const empty: MarketTimeResult = {
    data: [],
    volumeResampled: [],
    volatilityResampled: [],
    stats: { volumeGini: 0, volatilityGini: 0, volumeCorrelation: 0, volatilityCorrelation: 0 },
  };
  if (prices.length < 10) return empty;

  const n = prices.length;

  // 出来高累積
  let volCum = 0;
  const volCums: number[] = [0];
  for (let i = 1; i < n; i++) {
    volCum += prices[i].volume;
    volCums.push(volCum);
  }

  // ボラティリティ累積（|log return|の累積）
  let volatCum = 0;
  const volatCums: number[] = [0];
  for (let i = 1; i < n; i++) {
    volatCum += Math.abs(Math.log(prices[i].close / prices[i - 1].close));
    volatCums.push(volatCum);
  }

  // 正規化
  const volTotal = volCums[n - 1] || 1;
  const volatTotal = volatCums[n - 1] || 1;

  const data: MarketTimePoint[] = [];
  for (let i = 0; i < n; i++) {
    data.push({
      calendarTime: prices[i].time,
      volumeTime: volCums[i] / volTotal,
      volatilityTime: volatCums[i] / volatTotal,
      close: prices[i].close,
      logReturn: i > 0 ? Math.log(prices[i].close / prices[i - 1].close) : 0,
    });
  }

  // 等間隔リサンプリング
  const volumeResampled = resample(data, "volumeTime", resampleN);
  const volatilityResampled = resample(data, "volatilityTime", resampleN);

  // 統計量
  const calendarNorm = data.map((_, i) => i / (n - 1));
  const volNorm = data.map((d) => d.volumeTime);
  const volatNorm = data.map((d) => d.volatilityTime);

  const volumeGini = gini(prices.slice(1).map((p) => p.volume));
  const volatilityGini = gini(
    prices.slice(1).map((p, i) =>
      Math.abs(Math.log(p.close / prices[i].close))
    )
  );
  const volumeCorrelation = correlation(calendarNorm, volNorm);
  const volatilityCorrelation = correlation(calendarNorm, volatNorm);

  return {
    data,
    volumeResampled,
    volatilityResampled,
    stats: { volumeGini, volatilityGini, volumeCorrelation, volatilityCorrelation },
  };
}

function resample(
  data: MarketTimePoint[],
  timeKey: "volumeTime" | "volatilityTime",
  nPoints: number
): { time: number; close: number }[] {
  const result: { time: number; close: number }[] = [];
  for (let i = 0; i < nPoints; i++) {
    const t = i / (nPoints - 1);
    // 線形補間
    let lo = 0;
    let hi = data.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (data[mid][timeKey] <= t) lo = mid;
      else hi = mid;
    }
    const tLo = data[lo][timeKey];
    const tHi = data[hi][timeKey];
    const frac = tHi > tLo ? (t - tLo) / (tHi - tLo) : 0;
    const close = data[lo].close + frac * (data[hi].close - data[lo].close);
    result.push({ time: t, close });
  }
  return result;
}

function gini(values: number[]): number {
  if (values.length < 2) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += (2 * (i + 1) - n - 1) * sorted[i];
  }
  return sum / (n * total);
}

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const denom = Math.sqrt(da * db);
  return denom > 0 ? num / denom : 0;
}
