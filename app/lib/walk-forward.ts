// C. ウォークフォワード頑健性ハーネス。
// 「過去に効いた」ではなく「先で効くか」を測る。時系列をアンカー式に IS(イン・サンプル)/
// OOS(アウト・オブ・サンプル)へ分割し、各フォールドの IS で最良シグナルを選ぶ→続く OOS で
// 評価する。過剰最適化を露出させ、Deflated Sharpe Ratio(試行数補正)と PBO(バックテスト
// 過剰最適化確率)を頭出し指標として出す。
//
// 選抜モード: 共通カタログから IS シャープ最大のシグナルを各フォールドで選ぶ。
// 固定モード: 指定シグナルを IS/OOS で評価(選抜はしないが DSR の試行数はカタログ数を用いる)。

import { PricePoint } from "./types";
import { mean, std } from "./stats-significance";
import { buildSignalCatalog, signalReturns, type SignalPerformance } from "./edge-signals";

const TRADING_DAYS = 252;
const EULER = 0.5772156649015329;

// ---- 正規分布ユーティリティ ----
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normalCdf(x: number): number { return 0.5 * (1 + erf(x / Math.SQRT2)); }
// Acklam の逆正規CDF近似
function invNormalCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  let q: number, r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// 標本シャープ(1期間あたり)、歪度・尖度
function perPeriodSharpe(rets: number[]): number {
  if (rets.length < 2) return 0;
  const s = std(rets);
  return s > 0 ? mean(rets) / s : 0;
}
function skewKurt(rets: number[]): { skew: number; kurt: number } {
  const n = rets.length;
  if (n < 4) return { skew: 0, kurt: 3 };
  const m = mean(rets), s = std(rets) || 1e-12;
  let s3 = 0, s4 = 0;
  for (const r of rets) { const z = (r - m) / s; s3 += z ** 3; s4 += z ** 4; }
  return { skew: s3 / n, kurt: s4 / n };
}

export type WalkMode = "select" | "fixed";

export interface WalkForwardFold {
  isEndDate: string;
  oosStartDate: string;
  oosEndDate: string;
  selectedId: string;
  selectedLabel: string;
  isSharpe: number;      // 年率
  oosSharpe: number;     // 年率
  oosRank: number;       // 0..1(1=そのフォールドOOSで最良)
}

export interface WalkEquityPoint { date: string; value: number; oos: boolean; }

export interface WalkForwardResult {
  mode: WalkMode;
  signalLabel: string;         // 選抜=「IS選抜」/ 固定=シグナル名
  folds: WalkForwardFold[];
  equity: WalkEquityPoint[];
  isSharpeMean: number;        // 年率
  oosSharpeMean: number;       // 年率
  decay: number;               // OOS / IS
  oosAnnReturn: number;
  dsr: number;                 // Deflated Sharpe Ratio(0..1)
  pbo: number;                 // Probability of Backtest Overfitting(0..1)
  nTrials: number;
  nOOS: number;
  costBps: number;
}

export interface WalkForwardOptions {
  mode?: WalkMode;
  signalId?: string;   // fixed モード時
  folds?: number;      // 総ブロック数(最初の1ブロックはIS専用)
  costBps?: number;
}

export function runWalkForward(prices: PricePoint[], opts: WalkForwardOptions = {}): WalkForwardResult | null {
  const mode: WalkMode = opts.mode ?? "select";
  const folds = Math.max(3, Math.min(12, opts.folds ?? 6));
  const costBps = opts.costBps ?? 5;

  const catalog = buildSignalCatalog(prices);
  if (catalog.length === 0) return null;
  const perf: SignalPerformance[] = catalog.map((s) => signalReturns(prices, s, costBps));
  const L = perf[0].rets.length;
  const dates = perf[0].dates;
  if (L < folds * 20) return null; // ブロックあたり最低20観測

  // ブロック境界
  const bounds: number[] = [];
  for (let k = 0; k <= folds; k++) bounds.push(Math.round((L * k) / folds));

  const fixedIdx = mode === "fixed" ? catalog.findIndex((s) => s.id === opts.signalId) : -1;
  const useFixed = mode === "fixed" && fixedIdx >= 0;

  const sliceSharpe = (idx: number, a: number, b: number) => perPeriodSharpe(perf[idx].rets.slice(a, b));

  const foldResults: WalkForwardFold[] = [];
  const oosAggregate: number[] = [];     // 選抜/固定シグナルのOOSリターン連結
  const equity: WalkEquityPoint[] = [];
  let eq = 1;

  // 最初のIS専用ブロック: フラット保有(現金)で表示
  for (let i = 0; i < bounds[1]; i++) equity.push({ date: dates[i], value: eq, oos: false });

  let pboBelow = 0;
  for (let k = 1; k < folds; k++) {
    const isA = 0, isB = bounds[k];
    const oosA = bounds[k], oosB = bounds[k + 1];

    // IS でシグナル選抜(または固定)
    let selIdx: number;
    if (useFixed) selIdx = fixedIdx;
    else {
      selIdx = 0; let best = -Infinity;
      for (let s = 0; s < catalog.length; s++) {
        const sh = sliceSharpe(s, isA, isB);
        if (sh > best) { best = sh; selIdx = s; }
      }
    }

    const isSh = sliceSharpe(selIdx, isA, isB) * Math.sqrt(TRADING_DAYS);
    const oosSh = sliceSharpe(selIdx, oosA, oosB) * Math.sqrt(TRADING_DAYS);

    // OOS内での選抜シグナルの順位(全カタログ中)
    const oosSharpes = catalog.map((_, s) => sliceSharpe(s, oosA, oosB));
    const selOosRaw = oosSharpes[selIdx];
    const worse = oosSharpes.filter((v) => v < selOosRaw).length;
    const rank = catalog.length > 1 ? worse / (catalog.length - 1) : 1;
    if (rank < 0.5) pboBelow++;

    foldResults.push({
      isEndDate: dates[isB - 1],
      oosStartDate: dates[oosA],
      oosEndDate: dates[oosB - 1],
      selectedId: catalog[selIdx].id,
      selectedLabel: catalog[selIdx].label,
      isSharpe: isSh,
      oosSharpe: oosSh,
      oosRank: rank,
    });

    // OOSエクイティ
    for (let i = oosA; i < oosB; i++) {
      const r = perf[selIdx].rets[i];
      eq *= 1 + r;
      oosAggregate.push(r);
      equity.push({ date: dates[i], value: eq, oos: true });
    }
  }

  const isSharpeMean = mean(foldResults.map((f) => f.isSharpe));
  const oosSharpeMean = mean(foldResults.map((f) => f.oosSharpe));
  const decay = isSharpeMean !== 0 ? oosSharpeMean / isSharpeMean : 0;
  const oosAnnReturn = mean(oosAggregate) * TRADING_DAYS;

  // DSR: OOS集約シャープを、カタログ試行数で補正
  const nTrials = mode === "select" ? catalog.length : Math.max(catalog.length, 2);
  const srHat = perPeriodSharpe(oosAggregate); // 1期間あたり
  // 試行シャープのばらつき(各シグナルのOOS集約シャープの分散)
  const trialSharpes = catalog.map((_, s) => {
    const seg: number[] = [];
    for (let k = 1; k < folds; k++) for (let i = bounds[k]; i < bounds[k + 1]; i++) seg.push(perf[s].rets[i]);
    return perPeriodSharpe(seg);
  });
  const vSR = Math.max(1e-8, std(trialSharpes) ** 2);
  const sr0 = Math.sqrt(vSR) * ((1 - EULER) * invNormalCdf(1 - 1 / nTrials) + EULER * invNormalCdf(1 - 1 / (nTrials * Math.E)));
  const { skew, kurt } = skewKurt(oosAggregate);
  const nObs = oosAggregate.length;
  const denom = Math.sqrt(Math.max(1e-8, 1 - skew * srHat + ((kurt - 1) / 4) * srHat * srHat));
  const dsr = nObs > 2 ? normalCdf(((srHat - sr0) * Math.sqrt(nObs - 1)) / denom) : 0;

  const pbo = foldResults.length > 0 ? pboBelow / foldResults.length : 0;

  return {
    mode,
    signalLabel: useFixed ? catalog[fixedIdx].label : "IS選抜(カタログ最良)",
    folds: foldResults,
    equity,
    isSharpeMean,
    oosSharpeMean,
    decay,
    oosAnnReturn,
    dsr,
    pbo,
    nTrials,
    nOOS: nObs,
    costBps,
  };
}
