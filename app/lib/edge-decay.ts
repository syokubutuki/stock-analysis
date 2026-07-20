// エッジ減衰・死亡検知: 「このエッジはまだ生きているか」を逐次検定で監視する。
//
// バックテストで見つけたエッジは (a) そもそも偽発見だった (b) 本物だったが裁定・環境変化で
// 減衰した、のどちらかで死ぬ。毎日成績を覗いてt検定すると多重比較でp値が壊れるが、
// SPRT(逐次確率比検定)は「いつ覗いても誤り率が保たれる」anytime-valid な検定であり、
// 運用監視のための正しい道具になる。
//
// 手順:
//   1. 取引列の前半(isFrac)をIS(発見期間)とし、方向・μ_IS・σを推定。ここは検定に使わない。
//   2. 残り(OOS)に対して2つの監視統計量を並走:
//      ・SPRT対数尤度比: H1「μ=μ_IS(エッジ健在)」vs H0「μ=0(エッジ不在)」
//          λ_i = (μ_IS·r_i − μ_IS²/2) / σ²   (正規尤度・分散既知の近似)
//          累積L_t が A=ln((1−β)/α) を上抜け → エッジ健在の証拠十分
//          B=ln(β/(1−α)) を下抜け → エッジ不在(死亡)の証拠十分
//      ・CUSUM(下方シフト検知): z_i=(r_i−μ_IS)/σ、S_i = max(0, S_{i−1} − z_i − k)、
//          k = μ_IS/(2σ)(μ_IS→0へのシフトを最速検知する基準値)。S_i > h で警報。
//   3. 全期間を三分割した時代別平均と、取引リターンの経時回帰(McLean-Pontiff流の
//      「発見後減衰」の傾き)も併記する。

import { mean, std } from "./stats-significance";
import { Side } from "./weekday-trade";
import { EdgeSeries, directedReturns } from "./edge-trades";

export interface DecayParams {
  isFrac: number; // IS(発見期間)に使う取引の割合
  alpha: number; // SPRT第一種誤り率
  beta: number; // SPRT第二種誤り率
  cusumH: number; // CUSUM警報閾値(σ単位)
}

export const DEFAULT_DECAY_PARAMS: DecayParams = {
  isFrac: 0.5,
  alpha: 0.05,
  beta: 0.05,
  cusumH: 5,
};

export interface DecayPoint {
  date: string;
  equity: number; // 方向調整後の累積エクイティ(1始まり)
  logLR: number; // SPRT累積対数尤度比(IS区間は0)
  cusum: number; // CUSUM統計量(IS区間は0)
  oos: boolean;
}

export type SprtState = "alive" | "dead" | "undecided";

export interface EraStat {
  label: string;
  n: number;
  meanTrade: number;
  ciLo: number;
  ciHi: number;
  sharpe: number; // 年率
}

export interface DecayResult {
  edge: EdgeSeries;
  direction: Side;
  nIS: number;
  nOOS: number;
  splitDate: string;
  muIS: number;
  sigmaIS: number;
  muOOS: number;
  points: DecayPoint[];
  sprtUpper: number; // A
  sprtLower: number; // B
  sprtState: SprtState;
  sprtCrossDate: string | null; // 最初に境界を破った日
  cusumAlarmDate: string | null;
  eras: EraStat[];
  trendSlopePerYear: number; // 1取引リターンの経時傾き(年あたり)
  trendT: number;
  trendP: number;
}

function normalCdf(x: number): number {
  // Abramowitz-Stegun erf近似
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 + 0.5 * y : 0.5 - 0.5 * y;
}

// r_i を経過年数 t_i に回帰した傾き(発見後減衰の速度)。
function timeTrend(dates: string[], rets: number[]): { slope: number; t: number; p: number } {
  const n = rets.length;
  if (n < 20) return { slope: 0, t: 0, p: 1 };
  const t0 = new Date(dates[0]).getTime();
  const xs = dates.map((d) => (new Date(d).getTime() - t0) / (365.25 * 24 * 3600 * 1000));
  const mx = mean(xs), my = mean(rets);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (rets[i] - my);
  }
  if (sxx <= 0) return { slope: 0, t: 0, p: 1 };
  const slope = sxy / sxx;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const fit = my + slope * (xs[i] - mx);
    sse += (rets[i] - fit) ** 2;
  }
  const se = Math.sqrt(sse / (n - 2) / sxx);
  const t = se > 0 ? slope / se : 0;
  const p = 2 * (1 - normalCdf(Math.abs(t)));
  return { slope, t, p };
}

export function computeDecay(edge: EdgeSeries, params: DecayParams = DEFAULT_DECAY_PARAMS): DecayResult | null {
  const nAll = edge.trades.length;
  const nIS = Math.floor(nAll * params.isFrac);
  const nOOS = nAll - nIS;
  if (nIS < 30 || nOOS < 20) return null;

  // 方向はIS部分のみで決める(先読み排除)
  const isLongMean = mean(edge.trades.slice(0, nIS).map((t) => t.ret));
  const direction: Side = isLongMean >= 0 ? "long" : "short";
  const rets = directedReturns(edge, direction);
  const dates = edge.trades.map((t) => t.date);

  const isRets = rets.slice(0, nIS);
  const oosRets = rets.slice(nIS);
  const muIS = mean(isRets);
  const sigmaIS = std(isRets);
  if (sigmaIS <= 0 || muIS <= 0) return null; // ISでエッジ自体が観測できない

  const A = Math.log((1 - params.beta) / params.alpha);
  const B = Math.log(params.beta / (1 - params.alpha));
  const kRef = muIS / (2 * sigmaIS);

  const points: DecayPoint[] = [];
  let equity = 1;
  let logLR = 0;
  let cusum = 0;
  let sprtState: SprtState = "undecided";
  let sprtCrossDate: string | null = null;
  let cusumAlarmDate: string | null = null;

  for (let i = 0; i < nAll; i++) {
    equity *= 1 + rets[i];
    const oos = i >= nIS;
    if (oos) {
      logLR += (muIS * rets[i] - (muIS * muIS) / 2) / (sigmaIS * sigmaIS);
      const z = (rets[i] - muIS) / sigmaIS;
      cusum = Math.max(0, cusum - z - kRef);
      if (sprtState === "undecided") {
        if (logLR >= A) { sprtState = "alive"; sprtCrossDate = dates[i]; }
        else if (logLR <= B) { sprtState = "dead"; sprtCrossDate = dates[i]; }
      }
      if (cusumAlarmDate === null && cusum > params.cusumH) cusumAlarmDate = dates[i];
    }
    points.push({ date: dates[i], equity, logLR, cusum, oos });
  }

  // 時代別(三分割)
  const eras: EraStat[] = [];
  const third = Math.floor(nAll / 3);
  const eraDefs = [
    { label: "前期", s: 0, e: third },
    { label: "中期", s: third, e: 2 * third },
    { label: "後期", s: 2 * third, e: nAll },
  ];
  for (const d of eraDefs) {
    const seg = rets.slice(d.s, d.e);
    if (seg.length < 5) continue;
    const m = mean(seg), sd = std(seg);
    const se = sd / Math.sqrt(seg.length);
    eras.push({
      label: `${d.label} ${dates[d.s].slice(0, 7)}〜${dates[d.e - 1].slice(0, 7)}`,
      n: seg.length,
      meanTrade: m,
      ciLo: m - 1.96 * se,
      ciHi: m + 1.96 * se,
      sharpe: sd > 0 ? (m / sd) * Math.sqrt(edge.tradesPerYear) : 0,
    });
  }

  const trend = timeTrend(dates, rets);

  return {
    edge, direction, nIS, nOOS,
    splitDate: dates[nIS],
    muIS, sigmaIS,
    muOOS: mean(oosRets),
    points,
    sprtUpper: A, sprtLower: B,
    sprtState, sprtCrossDate, cusumAlarmDate,
    eras,
    trendSlopePerYear: trend.slope,
    trendT: trend.t,
    trendP: trend.p,
  };
}
