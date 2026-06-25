// 公式マーク vs 約定可能価格の乖離による「エッジ割引」。
//
// open-close-edge.ts の scanExecutionEdges は「始値/終値ちょうどで約定できる」前提のグロスエッジを
// 出す。しかし寄り付き・引けのオークション値(マーク)と、現実に成行で取れる価格(寄り/引け近傍の
// 数分VWAP)にはズレがある。このズレ＋スプレッドを各トレード型のグロスエッジから差し引いた
// 「実効エッジ」を計算し、現実の執行で生き残るエッジだけを選別する。
//
// 1取引リターン(ロング)を約定可能価格で書き直すと:
//   r_net = Ĉ/Ô − 1 ≈ r_gross + gapExit − gapEntry
//   gapOpen = (Ô − O)/O,  gapClose = (Ĉ − C)/C
// 方向(direction)を掛けると direction調整後の実効エッジ:
//   meanEff = meanGross + sideSign·(gapExitMean − gapEntryMean) − spreadRoundTrip

import { PricePoint } from "./types";
import { IntradayBar, groupByDay, localMinute } from "./intraday-core";
import { mean, blockBootstrapCI } from "./stats-significance";
import { representativeSpread } from "./spread-estimator";
import { scanExecutionEdges } from "./open-close-edge";

export interface GapStats {
  kMin: number; // 約定可能価格を測る窓(分)
  nDays: number;
  meanOpenPct: number; // gapOpen 平均(%)
  meanClosePct: number;
  openCiLoPct: number; openCiHiPct: number;
  closeCiLoPct: number; closeCiHiPct: number;
  openVals: number[]; // ヒストグラム用(割合)
  closeVals: number[];
  spreadRoundTripPct: number; // 往復スプレッドコスト(%)
}

export interface DiscountedEdge {
  label: string;
  direction: "long" | "short";
  n: number;
  grossPct: number; // direction調整後グロス1取引平均(%)
  openTermPct: number; // 寄りレグ由来の割引(%)
  closeTermPct: number; // 引けレグ由来の割引(%)
  spreadTermPct: number; // スプレッド控除(%)
  effPct: number; // 実効エッジ(%)
  grossSignificant: boolean; // グロスがFDR有意
  survives: boolean; // グロス有意 かつ 実効>0
}

export interface EdgeDiscountResult {
  gaps: GapStats;
  edges: DiscountedEdge[]; // effPct 降順
  nGrossSignificant: number;
  nSurvive: number;
}

function intervalMinutes(interval: string): number {
  const m = /^(\d+)\s*m$/.exec(interval);
  return m ? parseInt(m[1], 10) : 5;
}

// 寄り後 kMin 分(=先頭側) or 引け前 kMin 分(=末尾側)の VWAP。出来高ゼロは典型価格平均。
function windowVwap(bars: IntradayBar[], gmtoffset: number, kMin: number, fromOpen: boolean): number {
  const openMin = localMinute(bars[0].ts, gmtoffset);
  const lastMin = localMinute(bars[bars.length - 1].ts, gmtoffset);
  let pv = 0, v = 0, tp = 0, cnt = 0;
  for (const b of bars) {
    const el = localMinute(b.ts, gmtoffset);
    const inWin = fromOpen ? (el - openMin) <= kMin : (lastMin - el) <= kMin;
    if (!inWin) continue;
    const typical = (b.high + b.low + b.close) / 3;
    const vol = b.volume || 0;
    pv += typical * vol; v += vol; tp += typical; cnt++;
  }
  if (cnt === 0) return 0;
  return v > 0 ? pv / v : tp / cnt;
}

export function computeEdgeDiscount(
  prices: PricePoint[],
  bars: IntradayBar[],
  gmtoffset: number,
  interval: string,
  kMin: number,
  useSpread: boolean
): EdgeDiscountResult | null {
  if (prices.length < 250) return null;
  const days = groupByDay(bars, gmtoffset);
  if (days.length < 10) return null;
  const iv = intervalMinutes(interval);
  const effK = Math.max(iv, kMin); // 足より細かい窓は取れない

  // 1. 寄り/引けのフィルギャップ分布
  const openVals: number[] = [];
  const closeVals: number[] = [];
  for (const day of days) {
    if (day.bars.length < 2) continue;
    const o = day.bars[0].open;
    const c = day.bars[day.bars.length - 1].close;
    if (!(o > 0) || !(c > 0)) continue;
    const oHat = windowVwap(day.bars, gmtoffset, effK, true);
    const cHat = windowVwap(day.bars, gmtoffset, effK, false);
    if (oHat > 0) openVals.push((oHat - o) / o);
    if (cHat > 0) closeVals.push((cHat - c) / c);
  }
  if (openVals.length < 5 || closeVals.length < 5) return null;

  const meanOpen = mean(openVals);
  const meanClose = mean(closeVals);
  const ciO = blockBootstrapCI(openVals, 500);
  const ciC = blockBootstrapCI(closeVals, 500);
  const spread = representativeSpread(prices); // 片道だが既存流儀に倣い往復コストとして使用
  const spreadRT = useSpread ? spread : 0;

  const gaps: GapStats = {
    kMin: effK,
    nDays: Math.min(openVals.length, closeVals.length),
    meanOpenPct: meanOpen * 100,
    meanClosePct: meanClose * 100,
    openCiLoPct: (ciO ? ciO.lo : meanOpen) * 100,
    openCiHiPct: (ciO ? ciO.hi : meanOpen) * 100,
    closeCiLoPct: (ciC ? ciC.lo : meanClose) * 100,
    closeCiHiPct: (ciC ? ciC.hi : meanClose) * 100,
    openVals, closeVals,
    spreadRoundTripPct: spread * 100,
  };

  // 2. グロスエッジを取得し割引
  const scan = scanExecutionEdges(prices);
  const edges: DiscountedEdge[] = scan.stats.map((s) => {
    const sideSign = s.direction === "long" ? 1 : -1;
    const entryOpen = s.def.entry === "open";
    const exitOpen = s.def.exit === "open";
    // 入口レグ: −sideSign·gap、出口レグ: +sideSign·gap。レグの timing に応じ寄り/引けへ加算。
    let openTerm = 0, closeTerm = 0;
    const entryGap = entryOpen ? meanOpen : meanClose;
    const exitGap = exitOpen ? meanOpen : meanClose;
    if (entryOpen) openTerm += -sideSign * entryGap; else closeTerm += -sideSign * entryGap;
    if (exitOpen) openTerm += sideSign * exitGap; else closeTerm += sideSign * exitGap;
    const effFrac = s.meanTrade + (openTerm + closeTerm) - spreadRT;
    return {
      label: s.def.label,
      direction: s.direction,
      n: s.n,
      grossPct: s.meanTrade * 100,
      openTermPct: openTerm * 100,
      closeTermPct: closeTerm * 100,
      spreadTermPct: -spreadRT * 100,
      effPct: effFrac * 100,
      grossSignificant: s.significant,
      survives: s.significant && effFrac > 0,
    };
  });
  edges.sort((a, b) => b.effPct - a.effPct);

  return {
    gaps,
    edges,
    nGrossSignificant: edges.filter((e) => e.grossSignificant).length,
    nSurvive: edges.filter((e) => e.survives).length,
  };
}
