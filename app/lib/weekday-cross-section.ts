// ③ クロスセクション化：銘柄×週でプールして検出力を桁上げする（横断相関に正直に）
// -------------------------------------------------------------------------------
// 単一銘柄・10年では、週末プレミアムや曜日効果を検定するには検出力が足りない
// （t = SR·√T なので10年で t=3 に届くには年率シャープ0.95が必要）。そこで複数銘柄を
// プールして標本を増やす。ただし素朴に「銘柄×日 = 独立標本」と数えると大嘘になる。
// 同じ日は全銘柄がまとめて上下するので、横断相関を無視すると標準誤差が過小＝偽の有意。
//
// そこで intraday-basket.ts の clusterStat を使い、「同一日 = 1クラスタ」として
// クラスタ頑健SEと実効標本数 nEff を計算する。nEff は「独立標本に換算すると何個ぶんか」で、
// 銘柄を増やしても nEff は N倍にはならない（相関のぶん目減りする）——これが横断プールの
// 正直な検出力である。日付キーを「その観測が属する営業日」にすることで、週末ギャップも
// 曜日別リターンも、同一日の銘柄間相関を正しく吸収できる。
//
// null-calibration.ts の decompose/weekdayF を再利用（日中/平日夜間/週末ギャップの分解と
// 曜日ANOVAのF）。clusterStat/dateClusterBootstrapCI は intraday-basket.ts から。

import { PricePoint } from "./types";
import { decompose, weekdayF } from "./null-calibration";
import { clusterStat, dateClusterBootstrapCI } from "./intraday-basket";
import { mean, median } from "./stats-significance";

export interface TickerPrices {
  ticker: string;
  name?: string;
  prices: PricePoint[];
}

// F(4, 大) の臨界値（曜日=5群の一元配置ANOVA、df1=4）。N が大きいので F(4,∞) を使う。
const F_CRIT_05 = 2.37;
const F_CRIT_01 = 3.32;

const WD_LABEL = ["日", "月", "火", "水", "木", "金", "土"];

// クラスタ頑健なセル統計（同一日=1クラスタ）
export interface CellStat {
  mean: number;
  se: number; // クラスタ頑健SE
  t: number; // mean / se
  nObs: number; // 銘柄×日 のべ観測数
  nDays: number; // クラスタ数（独立営業日数）
  nEff: number; // 実効標本数
}

function toCell(vals: number[], dates: string[]): CellStat | null {
  const cs = clusterStat(vals, dates);
  if (!cs) return null;
  return {
    mean: cs.mean,
    se: cs.se,
    t: cs.se > 0 ? cs.mean / cs.se : 0,
    nObs: cs.nObs,
    nDays: cs.nDays,
    nEff: cs.nEff,
  };
}

export interface FSummary {
  perTicker: { ticker: string; name: string; F: number }[];
  nTickers: number;
  nReject05: number;
  nReject01: number;
  expected05: number; // 偽陽性の期待数 = 0.05 × nTickers
  medianF: number;
}

export interface WeekdayCrossResult {
  ok: boolean;
  reason?: string;
  nTickers: number;
  nObsTotal: number;
  from: string;
  to: string;
  // 週末プレミアム μ_w（横断プール）
  weekend: {
    pooled: CellStat | null;
    bootCI: { lo: number; hi: number; stable: number } | null;
    perTicker: { ticker: string; name: string; mean: number; n: number }[];
  };
  // 曜日 × セッション（日中 / 平日夜間）の横断プール
  weekdayIntraday: (CellStat | null)[]; // 長さ5（月..金）
  weekdayOvernight: (CellStat | null)[];
  // 曜日効果 F（銘柄ごと → 何銘柄が棄却するか）
  fIntraday: FSummary;
  fOvernight: FSummary;
}

function fSummary(rows: { ticker: string; name: string; F: number }[]): FSummary {
  const Fs = rows.map((r) => r.F);
  return {
    perTicker: rows.slice().sort((a, b) => b.F - a.F),
    nTickers: rows.length,
    nReject05: Fs.filter((f) => f > F_CRIT_05).length,
    nReject01: Fs.filter((f) => f > F_CRIT_01).length,
    expected05: 0.05 * rows.length,
    medianF: Fs.length ? median(Fs) : 0,
  };
}

export function computeWeekdayCrossSection(stocks: TickerPrices[]): WeekdayCrossResult {
  const empty: WeekdayCrossResult = {
    ok: false,
    nTickers: 0,
    nObsTotal: 0,
    from: "",
    to: "",
    weekend: { pooled: null, bootCI: null, perTicker: [] },
    weekdayIntraday: [null, null, null, null, null],
    weekdayOvernight: [null, null, null, null, null],
    fIntraday: fSummary([]),
    fOvernight: fSummary([]),
  };

  const usable = stocks.filter((s) => s.prices.length >= 200);
  if (usable.length < 2) return { ...empty, reason: "有効な銘柄が不足（2銘柄以上・各200本以上必要）" };

  // 週末ギャップのプール標本
  const weVals: number[] = [];
  const weDates: string[] = [];
  const wePerTicker: { ticker: string; name: string; mean: number; n: number }[] = [];
  // 曜日×セッション
  const wdIntraVals: number[][] = Array.from({ length: 5 }, () => []);
  const wdIntraDates: string[][] = Array.from({ length: 5 }, () => []);
  const wdOverVals: number[][] = Array.from({ length: 5 }, () => []);
  const wdOverDates: string[][] = Array.from({ length: 5 }, () => []);
  // F
  const fIntraRows: { ticker: string; name: string; F: number }[] = [];
  const fOverRows: { ticker: string; name: string; F: number }[] = [];

  let nObsTotal = 0;
  let from = "";
  let to = "";

  for (const s of usable) {
    const dec = decompose(s.prices);
    if (!dec) continue;
    const name = s.name ?? s.ticker;

    // 期間
    const f0 = dec.time[0];
    const t0 = dec.time[dec.time.length - 1];
    if (!from || f0 < from) from = f0;
    if (!to || t0 > to) to = t0;

    // 週末ギャップ + 曜日別
    const weTicker: number[] = [];
    for (let i = 0; i < dec.time.length; i++) {
      const d = dec.dow[i];
      if (d >= 1 && d <= 5) {
        wdIntraVals[d - 1].push(dec.intra[i]);
        wdIntraDates[d - 1].push(dec.time[i]);
        nObsTotal++;
      }
      if (dec.hasOver[i]) {
        if (dec.spansWeek[i]) {
          weVals.push(dec.over[i]);
          weDates.push(dec.time[i]);
          weTicker.push(dec.over[i]);
        } else if (d >= 1 && d <= 5) {
          wdOverVals[d - 1].push(dec.over[i]);
          wdOverDates[d - 1].push(dec.time[i]);
        }
      }
    }
    if (weTicker.length > 0) {
      wePerTicker.push({ ticker: s.ticker, name, mean: mean(weTicker), n: weTicker.length });
    }

    // 曜日効果 F（銘柄ごと）
    const f = weekdayF(dec, dec.intra, dec.over);
    fIntraRows.push({ ticker: s.ticker, name, F: f.intraday });
    fOverRows.push({ ticker: s.ticker, name, F: f.overnight });
  }

  return {
    ok: true,
    nTickers: usable.length,
    nObsTotal,
    from,
    to,
    weekend: {
      pooled: toCell(weVals, weDates),
      bootCI: dateClusterBootstrapCI(
        weVals.map((r, i) => ({ date: weDates[i], ret: r })),
        800,
      ),
      perTicker: wePerTicker.sort((a, b) => b.mean - a.mean),
    },
    weekdayIntraday: wdIntraVals.map((v, i) => toCell(v, wdIntraDates[i])),
    weekdayOvernight: wdOverVals.map((v, i) => toCell(v, wdOverDates[i])),
    fIntraday: fSummary(fIntraRows),
    fOvernight: fSummary(fOverRows),
  };
}

export { WD_LABEL, F_CRIT_05, F_CRIT_01 };
