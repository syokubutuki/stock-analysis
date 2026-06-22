// 裁量トレードの「基準値」を逆算するモジュール
//
// 通常は「ルール → トレード」(例: RSI<30 で買う) だが、ここでは逆向きに
// 「実際に打ったトレード → そのときの各特徴量の値」を集計し、
// 人間が無意識に従っている裁量の基準を数値として浮かび上がらせる。
//
// 旧 trade アプリ (trade-criteria.ts) からの移植。指標計算は構造分析側の
// 既存ライブラリ (technical-indicators) を再利用し、特徴テーブルは prices だけで
// 構築できるよう分離した (trades が変わっても再計算不要)。

import { PricePoint } from "./types";
import { Trade } from "./discretionary-engine";
import {
  computeRSI,
  computeMACD,
  computeBollinger,
} from "./technical-indicators";

export interface FeatureDef {
  id: string;
  label: string;
  unit: string;
  description: string;
}

// 各日について 1 つのスカラー値を持つ特徴量の定義。
export const FEATURE_DEFS: FeatureDef[] = [
  { id: "rsi", label: "RSI(14)", unit: "", description: "買われすぎ/売られすぎ。低いほど売られすぎ" },
  { id: "macdHist", label: "MACDヒスト", unit: "", description: "勢いの転換。正なら上昇基調・負なら下降基調" },
  { id: "bbPercentB", label: "BB %B", unit: "%", description: "ボリンジャーバンド内の位置。0%=下限・100%=上限" },
  { id: "dev25", label: "25日乖離率", unit: "%", description: "終値が25日移動平均からどれだけ離れているか" },
  { id: "mom5", label: "5日モメンタム", unit: "%", description: "直近5日の値動き。買う直前の勢い" },
  { id: "mom20", label: "20日モメンタム", unit: "%", description: "直近20日の値動き。中期トレンド" },
  { id: "volRatio", label: "出来高比", unit: "倍", description: "20日平均出来高に対する当日の出来高" },
  { id: "realizedVol", label: "実現ボラ", unit: "%", description: "20日の年率ボラティリティ。相場の荒れ具合" },
  { id: "pricePos", label: "レンジ内位置", unit: "%", description: "直近20日の高安レンジ内での終値の位置" },
  { id: "dayReturn", label: "当日リターン", unit: "%", description: "前日比。陽線で買うか陰線で買うか" },
];

export type FeatureRecord = Partial<Record<string, number>>;

// 各日 (time) → 特徴量レコード のテーブルを構築する。prices のみに依存。
export function computeFeatureTable(
  prices: PricePoint[]
): Map<string, FeatureRecord> {
  const byTime = new Map<string, FeatureRecord>();
  const ensure = (t: string): FeatureRecord => {
    let r = byTime.get(t);
    if (!r) {
      r = {};
      byTime.set(t, r);
    }
    return r;
  };

  const closes = prices.map((p) => p.close);
  const vols = prices.map((p) => p.volume);

  // 既存の指標関数を再利用
  for (const d of computeRSI(prices, 14)) ensure(d.time).rsi = d.value;
  for (const d of computeMACD(prices)) ensure(d.time).macdHist = d.histogram;
  for (const d of computeBollinger(prices, 20, 2)) {
    // percentB は 0-1 で返るため % に変換
    ensure(d.time).bbPercentB = d.percentB * 100;
  }

  // インデックスベースで計算する特徴量
  for (let i = 0; i < prices.length; i++) {
    const t = prices[i].time;

    // 25日移動平均乖離率
    if (i >= 24) {
      let sum = 0;
      for (let j = i - 24; j <= i; j++) sum += closes[j];
      const sma25 = sum / 25;
      if (sma25 !== 0) ensure(t).dev25 = ((closes[i] - sma25) / sma25) * 100;
    }

    if (i >= 1 && closes[i - 1] !== 0) {
      ensure(t).dayReturn = (closes[i] / closes[i - 1] - 1) * 100;
    }
    if (i >= 5 && closes[i - 5] !== 0) {
      ensure(t).mom5 = (closes[i] / closes[i - 5] - 1) * 100;
    }
    if (i >= 20 && closes[i - 20] !== 0) {
      ensure(t).mom20 = (closes[i] / closes[i - 20] - 1) * 100;
    }
    if (i >= 19) {
      let sumVol = 0;
      for (let j = i - 19; j <= i; j++) sumVol += vols[j];
      const avgVol = sumVol / 20;
      if (avgVol > 0) ensure(t).volRatio = vols[i] / avgVol;

      let mn = Infinity;
      let mx = -Infinity;
      for (let j = i - 19; j <= i; j++) {
        if (closes[j] < mn) mn = closes[j];
        if (closes[j] > mx) mx = closes[j];
      }
      if (mx > mn) ensure(t).pricePos = ((closes[i] - mn) / (mx - mn)) * 100;
    }
    if (i >= 20) {
      const rets: number[] = [];
      for (let j = i - 19; j <= i; j++) {
        if (closes[j - 1] > 0) rets.push(Math.log(closes[j] / closes[j - 1]));
      }
      if (rets.length > 1) {
        const m = rets.reduce((a, b) => a + b, 0) / rets.length;
        const v = rets.reduce((a, x) => a + (x - m) ** 2, 0) / rets.length;
        ensure(t).realizedVol = Math.sqrt(v * 252) * 100;
      }
    }
  }

  return byTime;
}

export interface CriterionStat {
  id: string;
  label: string;
  unit: string;
  description: string;
  count: number;
  mean: number;
  std: number;
  min: number;
  max: number;
  // 全期間の分布の中で平均値が位置するパーセンタイル (0-100)。
  // 低い/高いほど「珍しい局面」で売買している = 強い裁量の癖。
  percentile: number;
  // 全期間の分布の最小・最大 (バー描画用)
  fullMin: number;
  fullMax: number;
}

export interface DerivedCriteria {
  buy: CriterionStat[];
  sell: CriterionStat[];
  buyCount: number;
  sellCount: number;
}

function percentileOf(sorted: number[], value: number): number {
  if (sorted.length === 0) return 50;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return (lo / sorted.length) * 100;
}

// 実際に打たれたトレードから裁量の基準値を逆算する。
// 特徴テーブルは事前計算済みのものを渡せる (再計算を避けるため)。
export function deriveCriteria(
  prices: PricePoint[],
  trades: Trade[],
  table?: Map<string, FeatureRecord>
): DerivedCriteria {
  const featTable = table ?? computeFeatureTable(prices);

  // 全期間の特徴量分布 (パーセンタイル算出 & バー範囲用)
  const fullByFeature: Record<string, number[]> = {};
  for (const def of FEATURE_DEFS) fullByFeature[def.id] = [];
  for (const rec of featTable.values()) {
    for (const def of FEATURE_DEFS) {
      const v = rec[def.id];
      if (v !== undefined && Number.isFinite(v)) fullByFeature[def.id].push(v);
    }
  }
  const sortedByFeature: Record<string, number[]> = {};
  for (const def of FEATURE_DEFS) {
    sortedByFeature[def.id] = [...fullByFeature[def.id]].sort((a, b) => a - b);
  }

  const summarize = (dates: string[]): CriterionStat[] => {
    const stats: CriterionStat[] = [];
    for (const def of FEATURE_DEFS) {
      const vals: number[] = [];
      for (const d of dates) {
        const v = featTable.get(d)?.[def.id];
        if (v !== undefined && Number.isFinite(v)) vals.push(v);
      }
      if (vals.length === 0) continue;

      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const std = Math.sqrt(
        vals.reduce((a, x) => a + (x - mean) ** 2, 0) / vals.length
      );
      const sorted = sortedByFeature[def.id];
      stats.push({
        id: def.id,
        label: def.label,
        unit: def.unit,
        description: def.description,
        count: vals.length,
        mean,
        std,
        min: Math.min(...vals),
        max: Math.max(...vals),
        percentile: percentileOf(sorted, mean),
        fullMin: sorted.length > 0 ? sorted[0] : mean,
        fullMax: sorted.length > 0 ? sorted[sorted.length - 1] : mean,
      });
    }
    return stats;
  };

  const buyDates = trades.filter((t) => t.action === "buy").map((t) => t.date);
  const sellDates = trades.filter((t) => t.action === "sell").map((t) => t.date);

  return {
    buy: summarize(buyDates),
    sell: summarize(sellDates),
    buyCount: buyDates.length,
    sellCount: sellDates.length,
  };
}
