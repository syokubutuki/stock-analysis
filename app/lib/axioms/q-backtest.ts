// 合流点の検証 ─ synthesizeQ が出す q を過去に適用し、W を本当に改善するかを実証する。
//
// 命題4は「分析の価値は q を改善する度合いでのみ測られる」と言う。合流点(TodayQProposal)は
// q を主張するだけで、その q が W を改善したかは何も語っていなかった。ここがその穴を埋める。
//
// 最重要の設計制約 ── 公準3(非先読み):
//   時刻 t の建玉は F(t) にのみ依存できる。ゆえに「最終データで作った q を過去に当てはめる」
//   のは公理違反であり、成績を必ず過大評価する。本エンジンは各リバランス時点 t で
//   synthesizeQ(prices[0..t]) を「その時点までのデータだけ」で解き直す純ウォークフォワード。
//   Kelly の μ/σ も、分散比も、曜日 FDR も、HMM 信念も、すべて t 時点の情報のみで再推定される。
//
// 重い(全期間で ~10 秒)ため Web Worker から呼ぶこと(q-backtest.worker.ts)。

import { PricePoint } from "../types";
import { synthesizeQ } from "./q-synthesis";

export interface QBacktestPoint {
  time: string;
  /** 合流点の q に従った資産(初期1)。 */
  strategy: number;
  /** 買い持ち(q=1固定)の資産(初期1)。 */
  buyHold: number;
  /** その時点で採用していた符号付き建玉 q(資本比率)。 */
  q: number;
}

export interface QBacktestMetrics {
  totalReturn: number; // 期間トータル(倍率−1)
  annualReturn: number; // 年率(幾何)
  sharpe: number; // 年率シャープ(rf=0)
  maxDrawdown: number; // 最大ドローダウン(負値)
  /** 時間平均成長率 g = mean(log(1+r))×252（C21: 我々が実際に生きる成長率）。 */
  growthRate: number;
}

export interface QBacktestResult {
  points: QBacktestPoint[];
  strategy: QBacktestMetrics;
  buyHold: QBacktestMetrics;
  /** リバランス回数(= synthesizeQ を解き直した回数)。 */
  nRebalances: number;
  /** q=0(不参加)だった営業日の割合。 */
  flatShare: number;
  /** 累計で差し引いた取引コスト(資産倍率に対する引き算の総和)。 */
  totalCost: number;
  /** 建玉の平均絶対値(どれだけ張っていたか)。 */
  avgExposure: number;
}

/** 最大ドローダウン(負値)。 */
function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.min(mdd, v / peak - 1);
  }
  return mdd;
}

function metricsOf(equity: number[], dailyRets: number[], years: number): QBacktestMetrics {
  const last = equity[equity.length - 1] ?? 1;
  const totalReturn = last - 1;
  const annualReturn = years > 0 && last > 0 ? Math.pow(last, 1 / years) - 1 : 0;

  const n = dailyRets.length;
  let m = 0;
  for (const r of dailyRets) m += r;
  m = n ? m / n : 0;
  let v = 0;
  for (const r of dailyRets) v += (r - m) ** 2;
  const sd = n > 1 ? Math.sqrt(v / (n - 1)) : 0;
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(252) : 0;

  // C21: 時間平均成長率。アンサンブル平均ではなく、1本の経路が辿る成長。
  let g = 0;
  let gN = 0;
  for (const r of dailyRets) {
    if (1 + r > 0) {
      g += Math.log(1 + r);
      gN++;
    }
  }
  const growthRate = gN ? (g / gN) * 252 : 0;

  return { totalReturn, annualReturn, sharpe, maxDrawdown: maxDrawdown(equity), growthRate };
}

export interface QBacktestOptions {
  /** 何営業日ごとに q を解き直すか(既定21≒月次)。 */
  stepDays?: number;
  /** 最初に q を出すまでに必要な履歴(既定500≒2年)。HMM(200)・VR・曜日FDRに足る量。 */
  minHistory?: number;
  /** 進捗コールバック(0..1)。 */
  onProgress?: (p: number) => void;
}

/**
 * 純ウォークフォワードで合流点の q を検証する。
 * 各リバランス時点で過去データのみから q を解き直し(公準3)、次のリバランスまで保持する。
 */
export function backtestQ(prices: PricePoint[], opts?: QBacktestOptions): QBacktestResult | null {
  const stepDays = opts?.stepDays ?? 21;
  const minHistory = opts?.minHistory ?? 500;
  const n = prices.length;
  if (n < minHistory + stepDays + 10) return null;

  const points: QBacktestPoint[] = [];
  const stratRets: number[] = [];
  const bhRets: number[] = [];

  let eqStrat = 1;
  let eqBH = 1;
  let prevQ = 0;
  let nRebalances = 0;
  let flatDays = 0;
  let totalCost = 0;
  let exposureSum = 0;
  let days = 0;

  const totalSteps = Math.max(1, Math.ceil((n - minHistory) / stepDays));
  let stepIdx = 0;

  for (let t = minHistory; t < n; t += stepDays) {
    // ── 公準3: t 時点までの情報だけで q を解く。未来の価格は一切見ない。
    const rec = synthesizeQ(prices.slice(0, t));
    nRebalances++;
    const q = rec ? rec.sign * rec.sizeFraction : 0;

    // 建玉を prevQ → q へ動かすコスト(片道スプレッド × 変更量)。公準5/命題5。
    const oneWay = (rec?.assumedCost ?? 0.001) / 2;
    const turnCost = Math.abs(q - prevQ) * oneWay;
    eqStrat *= 1 - turnCost;
    totalCost += turnCost;
    prevQ = q;

    // 次のリバランスまで q を保持して日次で評価。
    const end = Math.min(t + stepDays, n);
    for (let i = t; i < end; i++) {
      const p0 = prices[i - 1].close;
      const p1 = prices[i].close;
      if (!(p0 > 0 && p1 > 0)) continue;
      const r = p1 / p0 - 1;

      const rs = q * r;
      eqStrat *= 1 + rs;
      eqBH *= 1 + r;
      stratRets.push(rs);
      bhRets.push(r);

      days++;
      if (q === 0) flatDays++;
      exposureSum += Math.abs(q);

      points.push({ time: prices[i].time, strategy: eqStrat, buyHold: eqBH, q });
    }

    stepIdx++;
    opts?.onProgress?.(Math.min(1, stepIdx / totalSteps));
  }

  if (points.length === 0) return null;

  const years = days / 252;
  const stratEq = points.map((p) => p.strategy);
  const bhEq = points.map((p) => p.buyHold);

  return {
    points,
    strategy: metricsOf(stratEq, stratRets, years),
    buyHold: metricsOf(bhEq, bhRets, years),
    nRebalances,
    flatShare: days ? flatDays / days : 0,
    totalCost,
    avgExposure: days ? exposureSum / days : 0,
  };
}
