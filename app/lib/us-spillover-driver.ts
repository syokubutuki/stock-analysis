// 方法7: ドライバ指数の選択 と 乖離日分析。
//
// (A) ドライバ選択: 複数の米国指数(S&P500 / NASDAQ / SOX / NYダウ)それぞれを前夜ドライバとして
//     JPの当日リターンに回帰し、R²(説明力)で「その銘柄を最も動かす米国指数」を特定する。
//     ハイテク・半導体銘柄は S&P500 より NASDAQ/SOX が効くことが多い。
//
// (B) 乖離日分析: 選んだドライバに対し、JPの寄りギャップが米国と“逆符号”になった日(=日本が米国を
//     無視した/独自材料で動いた日)を抽出し、その後の日中が米国方向へ戻る(修正)か、ギャップ方向へ
//     続くかを検証する。

import { PricePoint } from "./types";
import { DayData } from "./intraday-core";
import { computeUsReturns, alignJpUs, AlignedDay, ols } from "./us-spillover-core";
import { mean, tTest } from "./stats-significance";

export interface DriverInput { ticker: string; label: string; prices: PricePoint[] | null; }

export interface DriverScore {
  ticker: string;
  label: string;
  n: number;
  betaFull: number;
  r2Full: number;
  corrFull: number;
  betaIntra: number;
  r2Intra: number;
  pIntra: number;
}

export interface DivergenceStat {
  ticker: string;
  label: string;
  alignedN: number; // ギャップと米国が同符号だった日数
  divergeN: number; // 逆符号だった日数
  intraAligned: number; // 同符号日の日中平均
  intraDiverge: number; // 逆符号日の日中平均
  followUsRate: number; // 逆符号日のうち、日中が米国方向へ動いた割合(=米国へ修正)
  pDiverge: number; // 逆符号日の日中平均が0と異なるか
}

export interface DriverResult {
  scores: DriverScore[]; // R²Full 降順
  best: string;
}

const sgn = (x: number) => (x >= 0 ? 1 : -1);

function alignFor(days: DayData[], prices: PricePoint[] | null): AlignedDay[] | null {
  if (!prices) return null;
  return alignJpUs(days, computeUsReturns(prices));
}

export function computeDriverScores(days: DayData[], inputs: DriverInput[]): DriverResult | null {
  const scores: DriverScore[] = [];
  for (const inp of inputs) {
    const aligned = alignFor(days, inp.prices);
    if (!aligned) continue;
    const rows = aligned.filter((a) => isFinite(a.us.ret) && isFinite(a.full) && isFinite(a.intra));
    if (rows.length < 8) continue;
    const x = rows.map((a) => a.us.ret);
    const rFull = ols(x, rows.map((a) => a.full));
    const rIntra = ols(x, rows.map((a) => a.intra));
    if (!rFull || !rIntra) continue;
    scores.push({
      ticker: inp.ticker, label: inp.label, n: rows.length,
      betaFull: rFull.beta, r2Full: rFull.r2, corrFull: rFull.corr,
      betaIntra: rIntra.beta, r2Intra: rIntra.r2, pIntra: rIntra.pBeta,
    });
  }
  if (scores.length === 0) return null;
  scores.sort((a, b) => b.r2Full - a.r2Full);
  return { scores, best: scores[0].ticker };
}

export function computeDivergence(days: DayData[], inp: DriverInput): DivergenceStat | null {
  const aligned = alignFor(days, inp.prices);
  if (!aligned) return null;
  const rows = aligned.filter((a) => isFinite(a.us.ret) && a.us.ret !== 0 && isFinite(a.gap) && isFinite(a.intra));
  if (rows.length < 8) return null;

  const alignedDays = rows.filter((a) => sgn(a.gap) === sgn(a.us.ret));
  const divergeDays = rows.filter((a) => sgn(a.gap) !== sgn(a.us.ret));
  if (divergeDays.length < 3) return null;

  const intraDivArr = divergeDays.map((a) => a.intra);
  const tt = tTest(intraDivArr);
  // 逆符号日のうち日中が米国方向(=米国符号)へ動いた割合
  const followUs = divergeDays.filter((a) => sgn(a.intra) === sgn(a.us.ret)).length / divergeDays.length;

  return {
    ticker: inp.ticker, label: inp.label,
    alignedN: alignedDays.length, divergeN: divergeDays.length,
    intraAligned: mean(alignedDays.map((a) => a.intra)),
    intraDiverge: mean(intraDivArr),
    followUsRate: followUs,
    pDiverge: tt ? tt.p : 1,
  };
}
