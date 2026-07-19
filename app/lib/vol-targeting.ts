// ボラティリティ・ターゲティング（可変レバレッジ）vs バイ&ホールドの検証。
//
// ■ 発想の核（リターンは予測できないがボラは予測できる）
// 日次リターンの自己相関はほぼゼロだが、ボラティリティは強くクラスター化する。
// そこでリターン予測を一切せず、直前までの情報で推定した予測ボラ σ̂_t に反比例して
// 建玉 k_t = clamp(σ*/σ̂_t, 0, k_max) を毎日調整する。荒れた日は建玉を落とし、
// 静かな日は信用取引でレバを掛ける。平均リターンをほぼ保ったまま実現分散を下げ、
// Sharpe を改善するのが狙い（Moreira & Muir 2017 / Harvey et al. 2018 の単一資産版）。
//
// ■ ルックアヘッド禁止
// σ̂_t・目標ボラ・トレンドフィルタは全て t−1 までの情報のみで決まる。
// 信用金利は借入分 (k−1)+ に日割りで課金、リバランスはバンド制で売買コストも控除。
//
// ■ 検定（「有意にB&Hを上回るか」を多面的に）
//  1) Sharpe差: Jobson–Korkie–Memmel 解析z + ペア・ブロックBootstrap
//  2) スパニング回帰α: r_strat = α + β·r_BH + ε の α>0 を Newey–West t で検定
//     （B&Hの線形合成では作れない付加価値があるかの直接検定）
//  3) 置換検定（機構の検証）: リターンをシャッフルしてボラ・クラスタリングを破壊した
//     ヌル分布上で ΔSharpe を再計算。実測がその分布の右端なら「改善はボラ予測に由来」
//  4) ボラ予測力: Mincer–Zarnowitz 回帰 r_t² = a + b·σ̂_t² と Spearman順位相関
//  5) 定数レバ掃引: k固定戦略の幾何年率/Sharpe曲線と実効ケリー k*（可変レバの立ち位置）

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

export interface VolTargetSpec {
  estimator: VolEstimator; // 予測ボラの推定法
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
  targetMode: "auto",
  sigmaTargetAnn: 0.2,
  maxLev: 3,
  trendFilter: false,
  costBps: 5,
  marginRateLong: 0.026,
  rebalanceBand: 0.25,
};

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

export interface VolTargetResult {
  meta: {
    nDays: number; // 評価区間の営業日数
    years: number;
    startDate: string;
    endDate: string;
    avgLev: number;
    avgTargetAnn: number; // 実際に使われた目標ボラの平均
    warmup: number;
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
}

// ---------- コア・シミュレーション（リターン配列から, 実データ/置換で共用） ----------
interface SimOut {
  start: number; // 取引開始index（rets配列上）
  lev: number[]; // index t（t<start は NaN）
  sigmaAnn: number[]; // 同上
  targetAnn: number[];
  stratRet: number[]; // t=start.. の日次リターン
  bhRet: number[];
  turnover: number; // Σ|Δk|
  carryPaid: number; // 金利控除の合計（リターン単位）
  costPaid: number;
}

// closes[t] は「リターン r_t を観測する直前に確定している終値」（トレンドフィルタ用）
function simulate(rets: number[], closes: number[], spec: VolTargetSpec): SimOut | null {
  const n = rets.length;
  const lambda = 0.94;
  const win = spec.estimator === "rv60" ? 60 : 20;
  const s0 = spec.estimator === "ewma" ? 20 : win; // σ̂ が定義できる最初のindex
  const start = Math.max(63, s0 + 40); // 自動目標に最低40個のσ̂履歴を確保
  if (n - start < TRADING_DAYS) return null; // 評価区間は最低1年

  // --- 予測ボラ σ̂_t（年率）: t期のリターンを見る前に確定 ---
  const sigmaAnn = new Array<number>(n).fill(NaN);
  if (spec.estimator === "ewma") {
    let v = 0;
    for (let i = 0; i < s0; i++) v += rets[i] * rets[i];
    v /= s0;
    for (let t = s0; t < n; t++) {
      sigmaAnn[t] = Math.sqrt(Math.max(v, 1e-12) * TRADING_DAYS);
      v = lambda * v + (1 - lambda) * rets[t] * rets[t];
    }
  } else {
    // 実現ボラ（直近win日, 移動和で O(n)）
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      s1 += rets[i]; s2 += rets[i] * rets[i];
      if (i >= win) { s1 -= rets[i - win]; s2 -= rets[i - win] * rets[i - win]; }
      const t = i + 1; // σ̂_t は rets[t-win..t-1] から
      if (t >= win && t < n) {
        const m = s1 / win;
        const varr = Math.max(s2 / win - m * m, 1e-12);
        sigmaAnn[t] = Math.sqrt(varr * TRADING_DAYS);
      }
    }
  }

  // --- σ̂ の累積和（自動目標 = 過去252日のσ̂平均, 因果的） ---
  const sigPrefix = new Array<number>(n + 1).fill(0);
  for (let t = 0; t < n; t++) {
    sigPrefix[t + 1] = sigPrefix[t] + (Number.isFinite(sigmaAnn[t]) ? sigmaAnn[t] : 0);
  }
  const autoTarget = (t: number): number => {
    const lo = Math.max(s0, t - TRADING_DAYS);
    const cnt = t - lo;
    return cnt > 0 ? (sigPrefix[t] - sigPrefix[lo]) / cnt : spec.sigmaTargetAnn;
  };

  // --- SMA200 トレンドフィルタ（closes の過去のみ, 63本未満は無効） ---
  const cPrefix = new Array<number>(n + 1).fill(0);
  for (let t = 0; t < n; t++) cPrefix[t + 1] = cPrefix[t] + closes[t];
  const belowSma = (t: number): boolean => {
    const w = Math.min(200, t + 1);
    if (w < 63) return false;
    const sma = (cPrefix[t + 1] - cPrefix[t + 1 - w]) / w;
    return closes[t] < sma;
  };

  // --- メインループ ---
  const lev = new Array<number>(n).fill(NaN);
  const targetAnn = new Array<number>(n).fill(NaN);
  const stratRet: number[] = [];
  const bhRet: number[] = [];
  let kHeld = 0;
  let turnover = 0, carryPaid = 0, costPaid = 0;
  const dailyRate = spec.marginRateLong / TRADING_DAYS;
  for (let t = start; t < n; t++) {
    const tgt = spec.targetMode === "auto" ? autoTarget(t) : spec.sigmaTargetAnn;
    let kRaw = tgt / Math.max(sigmaAnn[t], 1e-6);
    kRaw = Math.min(Math.max(kRaw, 0), spec.maxLev);
    if (spec.trendFilter && belowSma(t)) kRaw = Math.min(kRaw, 1);
    let cost = 0;
    if (Math.abs(kRaw - kHeld) >= spec.rebalanceBand || stratRet.length === 0) {
      const d = Math.abs(kRaw - kHeld);
      turnover += d;
      cost = (d * spec.costBps) / 1e4;
      kHeld = kRaw;
    }
    const carry = Math.max(kHeld - 1, 0) * dailyRate;
    lev[t] = kHeld;
    targetAnn[t] = tgt;
    carryPaid += carry;
    costPaid += cost;
    stratRet.push(kHeld * rets[t] - carry - cost);
    bhRet.push(rets[t]);
  }
  return { start, lev, sigmaAnn, targetAnn, stratRet, bhRet, turnover, carryPaid, costPaid };
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
  // 残差と R²
  const e = new Array<number>(T);
  let ssr = 0, sst = 0;
  for (let i = 0; i < T; i++) {
    e[i] = y[i] - alpha - beta * x[i];
    ssr += e[i] * e[i];
    sst += (y[i] - my) * (y[i] - my);
  }
  const r2 = sst > 0 ? 1 - ssr / sst : 0;
  // u_t = z_t e_t, z_t = [1, x_t]。S = Γ0 + Σ w_l (Γl + Γl')
  const u0 = e; // 1·e_t
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
  // A = Z'Z = [[T, Σx],[Σx, Σx²]] の逆行列
  let sx = 0, sx2 = 0;
  for (let i = 0; i < T; i++) { sx += x[i]; sx2 += x[i] * x[i]; }
  const det = T * sx2 - sx * sx;
  let tNW: number | null = null, pOneSided: number | null = null;
  if (det > 1e-12) {
    const Ainv = [ [sx2 / det, -sx / det], [-sx / det, T / det] ];
    // V = Ainv · S · Ainv, se(α) = sqrt(V[0][0])
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
    xs.push((sigmaAnn[t] * sigmaAnn[t]) / TRADING_DAYS); // 日次分散予測
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
  // Spearman: σ̂ と |r| の順位相関（同順位は平均順位）
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

// 置換検定: リターンをi.i.d.シャッフル（分布・ドリフトは保存、ボラ・クラスタリングは破壊）した
// 系列に同一パイプラインを適用し、ΔSharpe のヌル分布を得る。
function permutationTest(
  rets: number[],
  spec: VolTargetSpec,
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
    // Fisher–Yates
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
    }
    // 疑似価格経路（トレンドフィルタ用）
    closes[0] = 1;
    for (let t = 1; t < n; t++) closes[t] = closes[t - 1] * (1 + perm[t - 1]);
    const sim = simulate(perm, closes, spec);
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

// ---------- メイン ----------
export function computeVolTarget(
  prices: PricePoint[],
  spec: VolTargetSpec,
  seed = 20260718
): VolTargetResult | null {
  const len = prices.length;
  if (len < 400) return null;

  // 日次リターン（終値→翌終値, 夜間込み）。rets[t] の日付は prices[t+1].time。
  const rets: number[] = [];
  const dates: string[] = [];
  const closes: number[] = []; // closes[t] = r_t 観測直前の終値
  for (let i = 0; i < len - 1; i++) {
    const c0 = prices[i].close, c1 = prices[i + 1].close;
    if (!(c0 > 0) || !(c1 > 0)) continue;
    rets.push(c1 / c0 - 1);
    dates.push(prices[i + 1].time);
    closes.push(c0);
  }
  const sim = simulate(rets, closes, spec);
  if (!sim) return null;

  const { start, stratRet, bhRet } = sim;
  const nEval = stratRet.length;

  // 累積リターン行
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
      sigmaAnn: sim.sigmaAnn[t],
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
  const vfq = volForecastQuality(rets, sim.sigmaAnn, start);
  const permT = permutationTest(rets, spec, sharpeT.delta, 200, seed + 3);
  const sweep = levSweep(rets, start, spec);

  return {
    meta: {
      nDays: nEval,
      years,
      startDate: dates[start],
      endDate: dates[dates.length - 1],
      avgLev: mean(levVals),
      avgTargetAnn: mean(tgtVals),
      warmup: start,
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
  };
}
