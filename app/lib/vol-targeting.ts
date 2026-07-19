// ボラティリティ・ターゲティング（可変レバレッジ）vs バイ&ホールドの検証。
//
// ■ 発想の核（リターンは予測できないがボラは予測できる）
// 日次リターンの自己相関はほぼゼロだが、ボラティリティは強くクラスター化する。
// そこでリターン予測を一切せず、直前までの情報で推定した予測ボラ σ̂_t に反比例して
// 建玉 k_t = clamp(σ*/σ̂_t, 0, k_max) を毎日調整する。荒れた日は建玉を落とし、
// 静かな日は信用取引でレバを掛ける。平均リターンをほぼ保ったまま実現分散を下げ、
// Sharpe を改善するのが狙い（Moreira & Muir 2017 / Harvey et al. 2018 の単一資産版）。
//
// ■ σ̂ ソース（2026-07 拡張）
// 日本株の日次分散は前夜米国ニュースの寄り付きギャップ流入が大きく、自銘柄の過去ボラ
// では予測しきれない（指数横断の実測: ρ ^GSPC 0.37 vs ^N225 0.22）。そこで σ̂ の入力を
// 選択制にする:
//   own    : 自銘柄の過去リターン（EWMA / 実現20日 / 実現60日）
//   vix    : 前夜VIX終値（S&P500のインプライドボラ, /100 で年率σ）
//   usrv   : 米国実現ボラ（^GSPC 日次リターンの EWMA λ=0.94）
//   hybrid : max(own, スケール済VIX)（どちらかが荒れを警告したら建玉を落とす防御型）
// 外部ソースは水準が資産と異なる（VIXはリスクプレミアム上乗せ・別資産）ため、
// 因果的スケール較正 σ̂_t = raw_t × trailingMean252(σ̂own)/trailingMean252(raw) で
// 「タイミング情報は外部、水準は自銘柄」に合わせる。
//
// ■ 前夜整合（ルックアヘッド禁止）
// 建玉の決定は営業日 t の終値時点（リターン r_t = close_t→close_{t+1} の開始点）。
// その時点で確定している最新の米国セッションは「決定日より暦日が厳密に小さい最新の
// 米国立会日」（us-spillover-core.alignJpUs と同じ規約）。祝日連休も自動整合。
//
// ■ 検定（「有意にB&Hを上回るか」を多面的に）
//  1) Sharpe差: Jobson–Korkie–Memmel 解析z + ペア・ブロックBootstrap
//  2) スパニング回帰α: r_strat = α + β·r_BH + ε の α>0 を Newey–West t で検定
//  3) 置換検定（機構の検証）: own はリターンをシャッフルしてボラ・クラスタリングを破壊、
//     外部ソースは σ̂ 系列を固定したままリターンをシャッフルして σ̂↔リターンの対応を破壊。
//     どちらも「実測がヌル分布の右端なら改善は予測情報に由来」
//  4) ボラ予測力: Mincer–Zarnowitz 回帰 r_t² = a + b·σ̂_t² と Spearman順位相関
//  5) 定数レバ掃引: k固定戦略の幾何年率/Sharpe曲線と実効ケリー k*（可変レバの立ち位置）
//  6) ソース横断比較: 全σ̂ソースを共通評価区間で回し ρ / ΔSharpe / ΔDD を並べる

import { PricePoint } from "./types";
import { mean, std, quantileSorted } from "./stats-significance";

const TRADING_DAYS = 252;

// ---------- 数値ユーティリティ ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// ---------- 仕様 ----------
export type VolEstimator = "ewma" | "rv20" | "rv60";
export type SigmaSource = "own" | "vix" | "usrv" | "hybrid";

export const SIGMA_SOURCE_LABEL: Record<SigmaSource, string> = {
  own: "自銘柄σ̂",
  vix: "前夜VIX",
  usrv: "米国実現ボラ",
  hybrid: "ハイブリッド(max)",
};

export interface VolTargetSpec {
  estimator: VolEstimator; // 自銘柄σ̂の推定法（own のσ̂そのもの + 外部ソースの較正基準）
  sigmaSource: SigmaSource; // σ̂ の入力ソース
  targetMode: "auto" | "fixed"; // auto=過去1年のσ̂平均（因果的・調整パラメータなし）
  sigmaTargetAnn: number; // fixed時の目標ボラ（年率）
  maxLev: number; // 建玉上限（信用3倍まで）
  trendFilter: boolean; // 終値<SMA200 のときレバ上限を1に落とす
  costBps: number; // 売買コスト（片道, 建玉変化1単位あたりbps）
  marginRateLong: number; // 信用買い方金利（年率, 借入分(k−1)+に課金）
  rebalanceBand: number; // リバランスバンド（レバ絶対値, これ未満の変化は放置）
}

export const DEFAULT_VT_SPEC: VolTargetSpec = {
  estimator: "ewma",
  sigmaSource: "own",
  targetMode: "auto",
  sigmaTargetAnn: 0.2,
  maxLev: 3,
  trendFilter: false,
  costBps: 5,
  marginRateLong: 0.026,
  rebalanceBand: 0.25,
};

// 外部σ̂ソースの素材（component が useUsDaily で取得して渡す）
export interface UsInputs {
  vix?: PricePoint[]; // ^VIX 日足
  us?: PricePoint[]; // ^GSPC 日足（米国実現ボラ用）
}

// ---------- 出力型 ----------
export interface VTMetrics {
  totalReturn: number;
  annualized: number; // 幾何年率
  annVol: number; // 年率ボラ
  sharpe: number; // 年率Sharpe
  maxDD: number; // 負値
}

export interface VTRow {
  time: string;
  strat: number; // 累積リターン（0始まり）
  bh: number;
  lev: number; // 保有レバ
  sigmaAnn: number; // 予測ボラ（年率）
}

export interface SharpeDiffTest {
  delta: number; // 年率Sharpe差（戦略 − B&H）
  jkmZ: number | null;
  jkmP: number | null; // 片側 H1: 差>0
  bootLo: number | null;
  bootHi: number | null;
  bootProbPositive: number | null;
}

export interface AnnualDiffTest {
  delta: number;
  lo: number;
  hi: number;
  probPositive: number;
}

export interface AlphaTest {
  alphaAnn: number; // 年率α
  beta: number;
  tNW: number | null; // Newey–West t（ラグ5）
  pOneSided: number | null;
  r2: number;
}

export interface VolForecastQuality {
  mzSlope: number; // 理想は1
  mzIntercept: number;
  mzR2: number;
  spearman: number; // σ̂_t と |r_t| の順位相関
}

export interface PermTest {
  nPerm: number;
  pOneSided: number; // P(ΔSharpe_perm ≥ 実測)
  actualDelta: number;
  dist: number[]; // ヌル分布（ヒストグラム描画用）
}

export interface LevSweep {
  ks: number[];
  annual: number[]; // 幾何年率（破産は−1）
  sharpe: number[];
  kStarEmp: number; // 幾何年率を最大にする定数レバ（実効ケリー, IS参考値）
  kKellyGross: number; // 理論ケリー μ/σ²（金利無視）
  annualAtOne: number;
}

// ソース横断比較の1行（共通評価区間・boot/permなしの軽量版）
export interface SourceComparisonRow {
  source: SigmaSource;
  label: string;
  spearman: number;
  mzR2: number;
  dSharpe: number; // 戦略 − B&H
  dMaxDD: number; // 戦略DD − B&H DD（正=改善）
  avgLev: number;
}

export interface VolTargetResult {
  meta: {
    nDays: number; // 評価区間の営業日数
    years: number;
    startDate: string;
    endDate: string;
    avgLev: number;
    avgTargetAnn: number; // 実際に使われた目標ボラの平均
    warmup: number;
    sigmaSource: SigmaSource;
  };
  rows: VTRow[];
  metrics: { strat: VTMetrics; bh: VTMetrics };
  costs: { carryPaid: number; costPaid: number; turnoverPerYear: number };
  sharpe: SharpeDiffTest;
  annual: AnnualDiffTest;
  alpha: AlphaTest;
  volForecast: VolForecastQuality;
  perm: PermTest | null;
  sweep: LevSweep;
  comparison: SourceComparisonRow[] | null; // 外部データがある場合のみ
}

// ---------- 入力系列の準備 ----------
interface Prepared {
  rets: number[]; // r_t = close_t → close_{t+1}（夜間込み簡易リターン）
  dates: string[]; // r_t が確定する日付 = prices[t+1].time
  decisions: string[]; // r_t の建玉を決める日付 = prices[t].time（この時点までの情報のみ使用可）
  closes: number[]; // 決定時点の終値（トレンドフィルタ用）
}

function prepare(prices: PricePoint[]): Prepared {
  const rets: number[] = [], dates: string[] = [], decisions: string[] = [], closes: number[] = [];
  for (let i = 0; i < prices.length - 1; i++) {
    const c0 = prices[i].close, c1 = prices[i + 1].close;
    if (!(c0 > 0) || !(c1 > 0)) continue;
    rets.push(c1 / c0 - 1);
    dates.push(prices[i + 1].time);
    decisions.push(prices[i].time);
    closes.push(c0);
  }
  return { rets, dates, decisions, closes };
}

// ---------- σ̂ の構築 ----------
// 自銘柄σ̂（年率）。σ̂_t は rets[0..t-1] のみから（先頭 s0 個は NaN）。
function computeSigmaOwn(rets: number[], estimator: VolEstimator): number[] {
  const n = rets.length;
  const sigma = new Array<number>(n).fill(NaN);
  if (estimator === "ewma") {
    const s0 = 20, lambda = 0.94;
    if (n <= s0) return sigma;
    let v = 0;
    for (let i = 0; i < s0; i++) v += rets[i] * rets[i];
    v /= s0;
    for (let t = s0; t < n; t++) {
      sigma[t] = Math.sqrt(Math.max(v, 1e-12) * TRADING_DAYS);
      v = lambda * v + (1 - lambda) * rets[t] * rets[t];
    }
  } else {
    const win = estimator === "rv60" ? 60 : 20;
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      s1 += rets[i]; s2 += rets[i] * rets[i];
      if (i >= win) { s1 -= rets[i - win]; s2 -= rets[i - win] * rets[i - win]; }
      const t = i + 1;
      if (t >= win && t < n) {
        const m = s1 / win;
        const varr = Math.max(s2 / win - m * m, 1e-12);
        sigma[t] = Math.sqrt(varr * TRADING_DAYS);
      }
    }
  }
  return sigma;
}

// 米国系列を「決定日より暦日が厳密に小さい最新値」で各 t に整合（asof join, 前夜整合）。
function alignAsof(decisions: string[], usDates: string[], usVals: number[]): number[] {
  const n = decisions.length;
  const out = new Array<number>(n).fill(NaN);
  let j = 0;
  for (let t = 0; t < n; t++) {
    while (j < usDates.length && usDates[j] < decisions[t]) j++;
    if (j - 1 >= 0) out[t] = usVals[j - 1];
  }
  return out;
}

// 前夜VIX: 終値/100 = 年率σ（S&P500のインプライドボラ）
function sigmaFromVix(decisions: string[], vixPrices: PricePoint[]): number[] {
  const ds: string[] = [], vs: number[] = [];
  for (const p of vixPrices) {
    if (p.close > 0) { ds.push(p.time); vs.push(p.close / 100); }
  }
  return alignAsof(decisions, ds, vs);
}

// 米国実現ボラ: ^GSPC 日次リターンの EWMA(λ=0.94)。各米国立会日の引け時点で確定した値。
function sigmaFromUsRv(decisions: string[], usPrices: PricePoint[]): number[] {
  const ds: string[] = [], vs: number[] = [];
  const lambda = 0.94, s0 = 20;
  let v = 0, cnt = 0;
  const rets: number[] = [], rDates: string[] = [];
  for (let i = 1; i < usPrices.length; i++) {
    const pc = usPrices[i - 1].close, c = usPrices[i].close;
    if (!(pc > 0) || !(c > 0)) continue;
    rets.push(c / pc - 1);
    rDates.push(usPrices[i].time);
  }
  for (let i = 0; i < rets.length; i++) {
    if (cnt < s0) { v += rets[i] * rets[i]; cnt++; if (cnt === s0) v /= s0; continue; }
    v = lambda * v + (1 - lambda) * rets[i] * rets[i];
    ds.push(rDates[i]); vs.push(Math.sqrt(Math.max(v, 1e-12) * TRADING_DAYS));
  }
  return alignAsof(decisions, ds, vs);
}

// 因果的スケール較正: σ̂_t = raw_t × trailingMean252(own)_t / trailingMean252(raw)_t。
// タイミング情報は外部系列、水準は自銘柄に合わせる（VIXのリスクプレミアム・別資産の水準差を吸収）。
function calibrateToOwn(raw: number[], own: number[], minObs = 40): number[] {
  const n = raw.length;
  const out = new Array<number>(n).fill(NaN);
  const sumR = new Array<number>(n + 1).fill(0), cntR = new Array<number>(n + 1).fill(0);
  const sumO = new Array<number>(n + 1).fill(0), cntO = new Array<number>(n + 1).fill(0);
  for (let t = 0; t < n; t++) {
    const fr = Number.isFinite(raw[t]), fo = Number.isFinite(own[t]);
    sumR[t + 1] = sumR[t] + (fr ? raw[t] : 0); cntR[t + 1] = cntR[t] + (fr ? 1 : 0);
    sumO[t + 1] = sumO[t] + (fo ? own[t] : 0); cntO[t + 1] = cntO[t] + (fo ? 1 : 0);
  }
  for (let t = 0; t < n; t++) {
    if (!Number.isFinite(raw[t])) continue;
    const lo = Math.max(0, t - TRADING_DAYS);
    const cR = cntR[t] - cntR[lo], cO = cntO[t] - cntO[lo];
    if (cR < minObs || cO < minObs) continue;
    const mR = (sumR[t] - sumR[lo]) / cR, mO = (sumO[t] - sumO[lo]) / cO;
    if (mR > 1e-8) out[t] = raw[t] * (mO / mR);
  }
  return out;
}

// ソースに応じた最終σ̂系列。データ不足なら null。
function buildSigma(
  prep: Prepared,
  spec: VolTargetSpec,
  usInputs?: UsInputs
): number[] | null {
  const own = computeSigmaOwn(prep.rets, spec.estimator);
  if (spec.sigmaSource === "own") return own;
  if (spec.sigmaSource === "vix" || spec.sigmaSource === "hybrid") {
    if (!usInputs?.vix || usInputs.vix.length < 300) return null;
    const scaled = calibrateToOwn(sigmaFromVix(prep.decisions, usInputs.vix), own);
    if (spec.sigmaSource === "vix") return scaled;
    // hybrid: どちらかが荒れを警告したら従う（max）。外部が未定義の間は own。
    return own.map((o, t) => {
      const s = scaled[t];
      if (!Number.isFinite(o)) return NaN;
      return Number.isFinite(s) ? Math.max(o, s) : o;
    });
  }
  // usrv
  if (!usInputs?.us || usInputs.us.length < 300) return null;
  return calibrateToOwn(sigmaFromUsRv(prep.decisions, usInputs.us), own);
}

// ---------- コア・シミュレーション ----------
interface SimOut {
  start: number; // 取引開始index（rets配列上）
  lev: number[]; // index t（t<start は NaN）
  targetAnn: number[];
  stratRet: number[]; // t=start.. の日次リターン
  bhRet: number[];
  turnover: number;
  carryPaid: number;
  costPaid: number;
}

function simulate(
  rets: number[],
  closes: number[],
  spec: VolTargetSpec,
  sigmaAnn: number[],
  startOverride?: number
): SimOut | null {
  const n = rets.length;
  let firstFinite = -1;
  for (let t = 0; t < n; t++) if (Number.isFinite(sigmaAnn[t])) { firstFinite = t; break; }
  if (firstFinite < 0) return null;
  const start = Math.max(63, firstFinite + 40, startOverride ?? 0); // 自動目標に最低40個のσ̂履歴
  if (n - start < TRADING_DAYS) return null; // 評価区間は最低1年

  // σ̂ の累積和（自動目標 = 過去252日のσ̂平均, 因果的・欠損は除外）
  const sigPrefix = new Array<number>(n + 1).fill(0);
  const cntPrefix = new Array<number>(n + 1).fill(0);
  for (let t = 0; t < n; t++) {
    const f = Number.isFinite(sigmaAnn[t]);
    sigPrefix[t + 1] = sigPrefix[t] + (f ? sigmaAnn[t] : 0);
    cntPrefix[t + 1] = cntPrefix[t] + (f ? 1 : 0);
  }
  const autoTarget = (t: number): number => {
    const lo = Math.max(0, t - TRADING_DAYS);
    const c = cntPrefix[t] - cntPrefix[lo];
    return c >= 20 ? (sigPrefix[t] - sigPrefix[lo]) / c : spec.sigmaTargetAnn;
  };

  // SMA200 トレンドフィルタ（closes の過去のみ, 63本未満は無効）
  const cPrefix = new Array<number>(n + 1).fill(0);
  for (let t = 0; t < n; t++) cPrefix[t + 1] = cPrefix[t] + closes[t];
  const belowSma = (t: number): boolean => {
    const w = Math.min(200, t + 1);
    if (w < 63) return false;
    const sma = (cPrefix[t + 1] - cPrefix[t + 1 - w]) / w;
    return closes[t] < sma;
  };

  const lev = new Array<number>(n).fill(NaN);
  const targetAnn = new Array<number>(n).fill(NaN);
  const stratRet: number[] = [];
  const bhRet: number[] = [];
  let kHeld = 0;
  let turnover = 0, carryPaid = 0, costPaid = 0;
  const dailyRate = spec.marginRateLong / TRADING_DAYS;
  for (let t = start; t < n; t++) {
    let cost = 0;
    if (Number.isFinite(sigmaAnn[t])) {
      const tgt = spec.targetMode === "auto" ? autoTarget(t) : spec.sigmaTargetAnn;
      let kRaw = tgt / Math.max(sigmaAnn[t], 1e-6);
      kRaw = Math.min(Math.max(kRaw, 0), spec.maxLev);
      if (spec.trendFilter && belowSma(t)) kRaw = Math.min(kRaw, 1);
      if (Math.abs(kRaw - kHeld) >= spec.rebalanceBand || stratRet.length === 0) {
        const d = Math.abs(kRaw - kHeld);
        turnover += d;
        cost = (d * spec.costBps) / 1e4;
        kHeld = kRaw;
      }
      targetAnn[t] = tgt;
    }
    const carry = Math.max(kHeld - 1, 0) * dailyRate;
    lev[t] = kHeld;
    carryPaid += carry;
    costPaid += cost;
    stratRet.push(kHeld * rets[t] - carry - cost);
    bhRet.push(rets[t]);
  }
  return { start, lev, targetAnn, stratRet, bhRet, turnover, carryPaid, costPaid };
}

// ---------- 指標 ----------
function metricsFromDaily(dailyRet: number[]): VTMetrics {
  let W = 1, peak = 1, maxDD = 0;
  let ruined = false;
  for (const r of dailyRet) {
    W *= 1 + r;
    if (W <= 0) { ruined = true; W = 1e-12; }
    peak = Math.max(peak, W);
    const dd = (W - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  const total = ruined ? -1 : W - 1;
  const years = dailyRet.length / TRADING_DAYS || 1;
  const annualized = ruined ? -1 : Math.pow(1 + total, 1 / years) - 1;
  const m = mean(dailyRet), s = std(dailyRet);
  return {
    totalReturn: total,
    annualized,
    annVol: s * Math.sqrt(TRADING_DAYS),
    sharpe: s > 0 ? (m / s) * Math.sqrt(TRADING_DAYS) : 0,
    maxDD,
  };
}

// 順序に依らない統計（Bootstrap内で使用）
function bootStats(dailyRet: number[]): { annual: number; sharpe: number } {
  const m = mean(dailyRet), s = std(dailyRet);
  let sumLog = 0;
  let ruined = false;
  for (const r of dailyRet) {
    if (1 + r <= 0) { ruined = true; break; }
    sumLog += Math.log(1 + r);
  }
  const annual = ruined ? -1 : Math.exp((TRADING_DAYS * sumLog) / dailyRet.length) - 1;
  return { annual, sharpe: s > 0 ? (m / s) * Math.sqrt(TRADING_DAYS) : 0 };
}

// ---------- 検定 ----------
function sharpeDiffTest(a: number[], b: number[], seed: number): SharpeDiffTest {
  const T = a.length;
  const sa = std(a), sb = std(b), ma = mean(a), mb = mean(b);
  const sharpeA = sa > 0 ? (ma / sa) * Math.sqrt(TRADING_DAYS) : 0;
  const sharpeB = sb > 0 ? (mb / sb) * Math.sqrt(TRADING_DAYS) : 0;
  const delta = sharpeA - sharpeB;
  let jkmZ: number | null = null, jkmP: number | null = null;
  if (T > 30 && sa > 0 && sb > 0) {
    let cov = 0;
    for (let i = 0; i < T; i++) cov += (a[i] - ma) * (b[i] - mb);
    cov /= T - 1;
    const rho = cov / (sa * sb);
    const sra = ma / sa, srb = mb / sb; // 日次Sharpe
    const theta = (1 / T) * (2 * (1 - rho) + 0.5 * (sra * sra + srb * srb - 2 * sra * srb * rho * rho));
    if (theta > 0) {
      jkmZ = (sra - srb) / Math.sqrt(theta);
      jkmP = 1 - normalCdf(jkmZ);
    }
  }
  const boot = pairedBlockBoot(a, b, 1000, seed, (ra, rb) => bootStats(ra).sharpe - bootStats(rb).sharpe);
  return {
    delta,
    jkmZ,
    jkmP,
    bootLo: boot ? boot.lo : null,
    bootHi: boot ? boot.hi : null,
    bootProbPositive: boot ? boot.probPositive : null,
  };
}

function annualDiffTest(a: number[], b: number[], seed: number): AnnualDiffTest {
  const delta = bootStats(a).annual - bootStats(b).annual;
  const boot = pairedBlockBoot(a, b, 1000, seed, (ra, rb) => bootStats(ra).annual - bootStats(rb).annual);
  return {
    delta,
    lo: boot ? boot.lo : delta,
    hi: boot ? boot.hi : delta,
    probPositive: boot ? boot.probPositive : delta > 0 ? 1 : 0,
  };
}

function pairedBlockBoot(
  a: number[],
  b: number[],
  B: number,
  seed: number,
  statistic: (ra: number[], rb: number[]) => number
): { lo: number; hi: number; probPositive: number } | null {
  const n = a.length;
  if (n < 30) return null;
  const rng = mulberry32(seed);
  const L = Math.max(1, Math.round(Math.cbrt(n)));
  const nBlocks = Math.ceil(n / L);
  const samples: number[] = [];
  let pos = 0;
  const ra: number[] = [], rb: number[] = [];
  for (let bIter = 0; bIter < B; bIter++) {
    ra.length = 0; rb.length = 0;
    for (let blk = 0; blk < nBlocks && ra.length < n; blk++) {
      const startIdx = Math.floor(rng() * n);
      for (let j = 0; j < L && ra.length < n; j++) {
        const idx = (startIdx + j) % n;
        ra.push(a[idx]); rb.push(b[idx]);
      }
    }
    const v = statistic(ra, rb);
    if (Number.isFinite(v)) {
      samples.push(v);
      if (v > 0) pos++;
    }
  }
  if (samples.length < 10) return null;
  samples.sort((x, y) => x - y);
  return { lo: quantileSorted(samples, 0.025), hi: quantileSorted(samples, 0.975), probPositive: pos / samples.length };
}

// スパニング回帰 r_strat = α + β r_BH + ε。αの標準誤差は Newey–West（Bartlett核, ラグL）。
function spanningAlpha(y: number[], x: number[], nwLag = 5): AlphaTest {
  const T = y.length;
  const mx = mean(x), my = mean(y);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < T; i++) {
    sxx += (x[i] - mx) * (x[i] - mx);
    sxy += (x[i] - mx) * (y[i] - my);
  }
  const beta = sxx > 0 ? sxy / sxx : 0;
  const alpha = my - beta * mx;
  const e = new Array<number>(T);
  let ssr = 0, sst = 0;
  for (let i = 0; i < T; i++) {
    e[i] = y[i] - alpha - beta * x[i];
    ssr += e[i] * e[i];
    sst += (y[i] - my) * (y[i] - my);
  }
  const r2 = sst > 0 ? 1 - ssr / sst : 0;
  const u0 = e;
  const u1 = new Array<number>(T);
  for (let i = 0; i < T; i++) u1[i] = x[i] * e[i];
  const S = [ [0, 0], [0, 0] ];
  const gamma = (l: number): number[][] => {
    let g00 = 0, g01 = 0, g10 = 0, g11 = 0;
    for (let t = l; t < T; t++) {
      g00 += u0[t] * u0[t - l];
      g01 += u0[t] * u1[t - l];
      g10 += u1[t] * u0[t - l];
      g11 += u1[t] * u1[t - l];
    }
    return [ [g00, g01], [g10, g11] ];
  };
  const g0 = gamma(0);
  S[0][0] = g0[0][0]; S[0][1] = g0[0][1]; S[1][0] = g0[1][0]; S[1][1] = g0[1][1];
  for (let l = 1; l <= nwLag; l++) {
    const w = 1 - l / (nwLag + 1);
    const gl = gamma(l);
    S[0][0] += w * (gl[0][0] + gl[0][0]);
    S[0][1] += w * (gl[0][1] + gl[1][0]);
    S[1][0] += w * (gl[1][0] + gl[0][1]);
    S[1][1] += w * (gl[1][1] + gl[1][1]);
  }
  let sx = 0, sx2 = 0;
  for (let i = 0; i < T; i++) { sx += x[i]; sx2 += x[i] * x[i]; }
  const det = T * sx2 - sx * sx;
  let tNW: number | null = null, pOneSided: number | null = null;
  if (det > 1e-12) {
    const Ainv = [ [sx2 / det, -sx / det], [-sx / det, T / det] ];
    const v00 =
      Ainv[0][0] * (S[0][0] * Ainv[0][0] + S[0][1] * Ainv[1][0]) +
      Ainv[0][1] * (S[1][0] * Ainv[0][0] + S[1][1] * Ainv[1][0]);
    if (v00 > 0) {
      tNW = alpha / Math.sqrt(v00);
      pOneSided = 1 - normalCdf(tNW);
    }
  }
  return { alphaAnn: alpha * TRADING_DAYS, beta, tNW, pOneSided, r2 };
}

// Mincer–Zarnowitz: r_t² = a + b·σ̂_daily,t² + Spearman(σ̂, |r|)
function volForecastQuality(rets: number[], sigmaAnn: number[], start: number): VolForecastQuality {
  const xs: number[] = [], ys: number[] = [];
  for (let t = start; t < rets.length; t++) {
    if (!Number.isFinite(sigmaAnn[t])) continue;
    xs.push((sigmaAnn[t] * sigmaAnn[t]) / TRADING_DAYS);
    ys.push(rets[t] * rets[t]);
  }
  const T = xs.length;
  const mx = mean(xs), my = mean(ys);
  let sxx = 0, sxy = 0, sst = 0;
  for (let i = 0; i < T; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
    sst += (ys[i] - my) * (ys[i] - my);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  let ssr = 0;
  for (let i = 0; i < T; i++) {
    const eh = ys[i] - intercept - slope * xs[i];
    ssr += eh * eh;
  }
  const r2 = sst > 0 ? 1 - ssr / sst : 0;
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((v, i) => ({ v, i })).sort((p, q) => p.v - q.v);
    const rk = new Array<number>(arr.length);
    let k = 0;
    while (k < idx.length) {
      let j = k;
      while (j + 1 < idx.length && idx[j + 1].v === idx[k].v) j++;
      const avg = (k + j) / 2 + 1;
      for (let t = k; t <= j; t++) rk[idx[t].i] = avg;
      k = j + 1;
    }
    return rk;
  };
  const ra = rank(xs.map(Math.sqrt));
  const rb = rank(ys.map((v) => Math.sqrt(v)));
  const mra = mean(ra), mrb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < T; i++) {
    num += (ra[i] - mra) * (rb[i] - mrb);
    da += (ra[i] - mra) * (ra[i] - mra);
    db += (rb[i] - mrb) * (rb[i] - mrb);
  }
  const spearman = da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  return { mzSlope: slope, mzIntercept: intercept, mzR2: r2, spearman };
}

// 置換検定。own: リターンをシャッフルしσ̂も再計算（クラスタリング破壊）。
// 外部ソース: σ̂系列は固定し、リターンだけシャッフル（σ̂↔リターンの対応破壊）。
function permutationTest(
  rets: number[],
  spec: VolTargetSpec,
  sigmaFixed: number[] | null, // 外部ソース時の固定σ̂（own時は null）
  actualDelta: number,
  nPerm: number,
  seed: number
): PermTest | null {
  const n = rets.length;
  const rng = mulberry32(seed);
  const dist: number[] = [];
  const perm = rets.slice();
  const closes = new Array<number>(n);
  for (let b = 0; b < nPerm; b++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
    }
    closes[0] = 1;
    for (let t = 1; t < n; t++) closes[t] = closes[t - 1] * (1 + perm[t - 1]);
    const sigma = sigmaFixed ?? computeSigmaOwn(perm, spec.estimator);
    const sim = simulate(perm, closes, spec, sigma);
    if (!sim) continue;
    const s = bootStats(sim.stratRet).sharpe - bootStats(sim.bhRet).sharpe;
    if (Number.isFinite(s)) dist.push(s);
  }
  if (dist.length < 20) return null;
  const ge = dist.filter((v) => v >= actualDelta).length;
  return { nPerm: dist.length, pOneSided: (ge + 1) / (dist.length + 1), actualDelta, dist };
}

// 定数レバ掃引: k∈[0, maxLev] の固定レバ戦略（金利込み）の幾何年率とSharpe。
function levSweep(rets: number[], start: number, spec: VolTargetSpec): LevSweep {
  const dailyRate = spec.marginRateLong / TRADING_DAYS;
  const ks: number[] = [], annual: number[] = [], sharpe: number[] = [];
  const evalRets = rets.slice(start);
  let kStarEmp = 0, best = -Infinity, annualAtOne = 0;
  for (let k = 0; k <= spec.maxLev + 1e-9; k += 0.05) {
    const kk = Math.round(k * 100) / 100;
    const carry = Math.max(kk - 1, 0) * dailyRate;
    const dr = evalRets.map((r) => kk * r - carry);
    const bs = bootStats(dr);
    ks.push(kk);
    annual.push(bs.annual);
    sharpe.push(bs.sharpe);
    if (bs.annual > best) { best = bs.annual; kStarEmp = kk; }
    if (Math.abs(kk - 1) < 1e-9) annualAtOne = bs.annual;
  }
  const m = mean(evalRets), v = std(evalRets) ** 2;
  const kKellyGross = v > 0 ? m / v : 0;
  return { ks, annual, sharpe, kStarEmp, kKellyGross, annualAtOne };
}

// ---------- ソース横断比較（軽量: boot/permなし・共通評価区間） ----------
function sourceComparison(
  prep: Prepared,
  spec: VolTargetSpec,
  usInputs?: UsInputs
): SourceComparisonRow[] | null {
  const sources: SigmaSource[] = ["own"];
  if (usInputs?.vix && usInputs.vix.length >= 300) sources.push("vix", "hybrid");
  if (usInputs?.us && usInputs.us.length >= 300) sources.push("usrv");
  if (sources.length <= 1) return null;

  // 各ソースのσ̂を先に作り、公平のため共通の開始点（最も遅い開始）で揃える
  const sigmas = new Map<SigmaSource, number[]>();
  let commonStart = 0;
  for (const src of sources) {
    const sg = buildSigma(prep, { ...spec, sigmaSource: src }, usInputs);
    if (!sg) continue;
    let ff = -1;
    for (let t = 0; t < sg.length; t++) if (Number.isFinite(sg[t])) { ff = t; break; }
    if (ff < 0) continue;
    sigmas.set(src, sg);
    commonStart = Math.max(commonStart, Math.max(63, ff + 40));
  }
  if (sigmas.size <= 1) return null;

  const rows: SourceComparisonRow[] = [];
  for (const [src, sg] of sigmas) {
    const sim = simulate(prep.rets, prep.closes, { ...spec, sigmaSource: src }, sg, commonStart);
    if (!sim) continue;
    const ms = metricsFromDaily(sim.stratRet);
    const mb = metricsFromDaily(sim.bhRet);
    const vfq = volForecastQuality(prep.rets, sg, sim.start);
    const levVals = sim.lev.slice(sim.start).filter((v) => Number.isFinite(v));
    rows.push({
      source: src,
      label: SIGMA_SOURCE_LABEL[src],
      spearman: vfq.spearman,
      mzR2: vfq.mzR2,
      dSharpe: ms.sharpe - mb.sharpe,
      dMaxDD: ms.maxDD - mb.maxDD,
      avgLev: mean(levVals),
    });
  }
  const order: SigmaSource[] = ["own", "vix", "usrv", "hybrid"];
  rows.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
  return rows.length > 1 ? rows : null;
}

// ---------- メイン ----------
export function computeVolTarget(
  prices: PricePoint[],
  spec: VolTargetSpec,
  usInputs?: UsInputs,
  seed = 20260718
): VolTargetResult | null {
  const len = prices.length;
  if (len < 400) return null;

  const prep = prepare(prices);
  const sigmaAnn = buildSigma(prep, spec, usInputs);
  if (!sigmaAnn) return null; // 外部ソース指定だがデータ未着

  const sim = simulate(prep.rets, prep.closes, spec, sigmaAnn);
  if (!sim) return null;

  const { start, stratRet, bhRet } = sim;
  const nEval = stratRet.length;
  const { rets, dates } = prep;

  const rows: VTRow[] = [];
  let Ws = 1, Wb = 1;
  for (let t = start; t < rets.length; t++) {
    const idx = t - start;
    Ws *= 1 + stratRet[idx];
    Wb *= 1 + bhRet[idx];
    rows.push({
      time: dates[t],
      strat: Ws - 1,
      bh: Wb - 1,
      lev: sim.lev[t],
      sigmaAnn: sigmaAnn[t],
    });
  }

  const metricsStrat = metricsFromDaily(stratRet);
  const metricsBH = metricsFromDaily(bhRet);

  const levVals = sim.lev.slice(start).filter((v) => Number.isFinite(v));
  const tgtVals = sim.targetAnn.slice(start).filter((v) => Number.isFinite(v));
  const years = nEval / TRADING_DAYS;

  const sharpeT = sharpeDiffTest(stratRet, bhRet, seed + 1);
  const annualT = annualDiffTest(stratRet, bhRet, seed + 2);
  const alphaT = spanningAlpha(stratRet, bhRet);
  const vfq = volForecastQuality(rets, sigmaAnn, start);
  const sigmaFixed = spec.sigmaSource === "own" ? null : sigmaAnn;
  const permT = permutationTest(rets, spec, sigmaFixed, sharpeT.delta, 200, seed + 3);
  const sweep = levSweep(rets, start, spec);
  const comparison = sourceComparison(prep, spec, usInputs);

  return {
    meta: {
      nDays: nEval,
      years,
      startDate: dates[start],
      endDate: dates[dates.length - 1],
      avgLev: mean(levVals),
      avgTargetAnn: mean(tgtVals),
      warmup: start,
      sigmaSource: spec.sigmaSource,
    },
    rows,
    metrics: { strat: metricsStrat, bh: metricsBH },
    costs: {
      carryPaid: sim.carryPaid,
      costPaid: sim.costPaid,
      turnoverPerYear: years > 0 ? sim.turnover / years : 0,
    },
    sharpe: sharpeT,
    annual: annualT,
    alpha: alphaT,
    volForecast: vfq,
    perm: permT,
    sweep,
    comparison,
  };
}
