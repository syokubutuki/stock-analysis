// as-of リプレイ検証: 過去のある時点に戻り、その時点で分かる情報だけで出した判断が
// その後に実際に適切だったかを採点する。
//
// なぜ必要か
// ----------
// バックテストの多くは「戦略のリターン」を測る。しかしこのアプリが実際に画面へ出しているのは
// 建玉ではなく**判断**である——方向(up/down/flat)、上昇確率、予測レンジ、ボラ予測、変化点警告。
// これらは「儲かったか」では採点できない。確率には確率の、区間には区間の、
// ボラ予測にはボラ予測の正しい採点則がある。ここではそれを型ごとに当てる。
//
// 先読みが無いことの担保
// ----------------------
// 蒸留層 computeDigest / computeForecastRange は「渡された価格配列しか見ない」純粋関数である。
// したがって prices.slice(0, k+1) を渡せば、k 日目の夜に画面へ出ていた判断が厳密に再現される。
// パラメータ探索も再推定もこの切り出しの内側で完結するので、この軸に先読みは入り得ない。
//
// これは前向き検証ではない（重要）
// --------------------------------
// 「どの判断を採点するか」「閾値をどこに置くか」を決めているのは今日の自分である。
// as-of の切り出しが厳密でも、その選択の痕跡は消えない。消せるのは先読みだけで、
// 探索バイアスは消せない。年単位で待つ前向き検証(prospective-ledger)の代わりにはならず、
// 「待たずに標本を稼ぐ代わりに、選択の自由度を抱えたままの検証」という位置づけになる。
//
// 重複窓の扱い
// ------------
// H日先を spacing 日ごとに評価すると、標本は ceil(H/spacing) 重に重なる。
// 素の n で誤差を計算すると信頼区間が実際の 1/√(重なり) に縮む。
// 実効標本数 nEff = n / ceil(H/spacing) を併記し、CI はブロック・ブートストラップで出す。

import { PricePoint } from "./types";
import { computeDigest, SignalDigest, Horizon, HORIZON_CONFIG } from "./signal-digest";
import { computeForecastRange, ForecastRangeResult } from "./forecast-range";
import { mean, std, quantileSorted } from "./stats-significance";
import { chiSquareSurvival } from "./weekday-us-interaction";
import { spearman } from "./weekly-analog-oos";
import { normalCdf } from "./derivatives-core";
import { mulberry32 } from "./null-calibration";

/** 採点するフォワード日数。1日=翌日、5日≒1週、21日≒1ヶ月、63日≒四半期。 */
export const FWD_HORIZONS = [1, 5, 21, 63] as const;
/** 予測レンジ(区間)を作る先行き日数。computeForecastRange に渡す。 */
export const BAND_HORIZONS = [1, 5, 21] as const;

const BOOT_ITER = 600;

// ───────────────────────── 型 ─────────────────────────

/** as-of 時点から見た「その後に実際に起きたこと」。 */
export interface ForwardOutcome {
  h: number;
  ret: number; // 単純リターン close[k+h]/close[k] − 1
  logRet: number;
  realizedVolDaily: number; // 期間内の日次対数リターン標準偏差
  mfe: number; // 期間内の高値到達(最大含み益)
  mae: number; // 期間内の安値到達(最大含み損)
}

/** 1つの as-of 時点で再現された判断と、その後の実測。 */
export interface AsOfPoint {
  idx: number;
  date: string;
  close: number;
  digest: SignalDigest;
  fc: ForecastRangeResult;
  fwd: (ForwardOutcome | null)[]; // FWD_HORIZONS と同順
}

export interface DirectionScore {
  h: number;
  n: number; // flat を除いた採点対象
  nFlat: number;
  hit: number;
  hitLo: number; hitHi: number; // ブロック・ブートストラップ95%CI
  baseHit: number; // 常に「実測の多数派方向」を言い続けた場合の的中率(ヌル)
  ptStat: number; ptP: number; // Pesaran–Timmermann 方向予測独立性検定
}

export interface CalibBin { pMid: number; pMean: number; obs: number; n: number }

export interface ProbabilityScore {
  h: number;
  n: number;
  meanP: number; obsRate: number;
  brier: number;
  brierClim: number; // 気候値(常に実測基準率を答える)のブライアスコア
  bss: number; // Brier Skill Score = 1 − brier/brierClim。正で気候値超え
  logLoss: number;
  bins: CalibBin[];
  reliability: number; resolution: number; uncertainty: number; // Murphy 分解
}

export interface IntervalScore {
  h: number;
  level: number; // 0.5 / 0.8 / 0.95
  n: number;
  coverage: number; // 実測が区間に入った割合
  covLo: number; covHi: number;
  nominal: number;
  meanWidthPct: number; // 区間幅(価格比%)
  pinball: number;
  lrUc: number; lrUcP: number; // Christoffersen 無条件被覆検定
  lrInd: number; lrCc: number; lrCcP: number; // 独立性・条件付き被覆
}

export interface VolScore {
  h: number;
  n: number;
  a: number; b: number; // Mincer–Zarnowitz 回帰 realized = a + b·predicted
  seA: number; seB: number; // Newey–West 標準誤差(重複窓を考慮)
  r2: number;
  wald: number; waldP: number; // (a,b)=(0,1) の同時検定
  qlike: number; // QLIKE 損失(小さいほど良い)
  corr: number;
  meanPred: number; meanReal: number;
}

export interface IcScore {
  key: string; label: string;
  h: number;
  n: number; nEff: number;
  ic: number; icLo: number; icHi: number;
  quintiles: { mean: number; n: number }[]; // 予測値5分位ごとの実測平均リターン
  monotone: number; // 分位順位と実測平均の Spearman
}

export interface EventScore {
  key: string; label: string;
  h: number;
  nEvent: number; nNon: number;
  volEvent: number; volNon: number; // 事象後の実現ボラ(日次%)
  retEvent: number; retNon: number; // 事象後の平均リターン(%)
  tStat: number; p: number; // ボラ差の Welch t
}

export interface AsOfReplayParams {
  horizon: Horizon;
  spacing: number; // 何営業日ごとに as-of を置くか
  lookbackYears: number; // 直近何年ぶんを採点対象にするか
}

export interface AsOfReplayResult {
  ok: boolean;
  reason?: string;
  params: AsOfReplayParams;
  points: AsOfPoint[];
  firstDate: string; lastDate: string;
  overlap: number[]; // 各 H の重なり数 ceil(H/spacing)
  nEff: number[]; // 各 H の実効標本数
  direction: DirectionScore[];
  probability: ProbabilityScore[];
  intervals: IntervalScore[];
  vol: VolScore[];
  ics: IcScore[];
  events: EventScore[];
}

// ───────────────────────── 下ごしらえ ─────────────────────────

/** as-of を置くインデックス列。最低学習本数を確保し、H=最長ぶんの実測が残る位置まで。 */
export function buildAsOfIndices(prices: PricePoint[], p: AsOfReplayParams): number[] {
  const cfg = HORIZON_CONFIG[p.horizon];
  const minBars = Math.max(60, Math.min(cfg.window, 252)); // 蒸留層が動く最低限
  const maxH = FWD_HORIZONS[FWD_HORIZONS.length - 1];
  const last = prices.length - 1 - maxH; // 最長ホライズンの実測が取れる最後の位置
  if (last < minBars) return [];
  const lookbackBars = Math.round(p.lookbackYears * 252);
  const start = Math.max(minBars, last - lookbackBars);
  const out: number[] = [];
  for (let k = start; k <= last; k += p.spacing) out.push(k);
  return out;
}

/** as-of 時点 k から h 日先までに実際に起きたこと。 */
export function forwardOutcome(prices: PricePoint[], k: number, h: number): ForwardOutcome | null {
  if (k + h >= prices.length) return null;
  const c0 = prices[k].close;
  const c1 = prices[k + h].close;
  if (!(c0 > 0) || !(c1 > 0)) return null;
  const lr: number[] = [];
  let hi = -Infinity, lo = Infinity;
  for (let j = k + 1; j <= k + h; j++) {
    const pj = prices[j], pp = prices[j - 1];
    if (pj.close > 0 && pp.close > 0) lr.push(Math.log(pj.close / pp.close));
    hi = Math.max(hi, (pj.high > 0 ? pj.high : pj.close) / c0 - 1);
    lo = Math.min(lo, (pj.low > 0 ? pj.low : pj.close) / c0 - 1);
  }
  return {
    h,
    ret: c1 / c0 - 1,
    logRet: Math.log(c1 / c0),
    realizedVolDaily: lr.length >= 2 ? std(lr) : Math.abs(lr[0] ?? 0),
    mfe: isFinite(hi) ? hi : 0,
    mae: isFinite(lo) ? lo : 0,
  };
}

/**
 * 1つの as-of 時点の判断を再現する。
 * prices.slice(0, k+1) しか渡さないので、k 日目の終値時点の情報だけで作られる。
 */
export function replayAt(prices: PricePoint[], k: number, ticker: string, horizon: Horizon): AsOfPoint {
  const past = prices.slice(0, k + 1);
  const digest = computeDigest(past, ticker, ticker, horizon);
  const cfg = HORIZON_CONFIG[horizon];
  const w = past.length > cfg.window ? past.slice(past.length - cfg.window) : past;
  const fc = computeForecastRange(w, [...BAND_HORIZONS]);
  return {
    idx: k,
    date: prices[k].time,
    close: prices[k].close,
    digest,
    fc,
    fwd: FWD_HORIZONS.map((h) => forwardOutcome(prices, k, h)),
  };
}

// ───────────────────────── 統計ヘルパ ─────────────────────────

/** 移動ブロック・ブートストラップによる平均の95%CI。重複窓の相関を壊さない。 */
function blockMeanCI(x: number[], block: number, seed = 0x51f0): { lo: number; hi: number } {
  const n = x.length;
  if (n < 4) return { lo: NaN, hi: NaN };
  const L = Math.max(1, Math.min(block, Math.floor(n / 2)));
  const rnd = mulberry32(seed);
  const nb = Math.ceil(n / L);
  const stats: number[] = [];
  for (let b = 0; b < BOOT_ITER; b++) {
    let s = 0, cnt = 0;
    for (let j = 0; j < nb; j++) {
      const st = Math.floor(rnd() * (n - L + 1));
      for (let t = 0; t < L && cnt < n; t++, cnt++) s += x[st + t];
    }
    stats.push(s / cnt);
  }
  stats.sort((a, b) => a - b);
  return { lo: quantileSorted(stats, 0.025), hi: quantileSorted(stats, 0.975) };
}

/** ブロック・ブートストラップによる Spearman IC の95%CI。 */
function blockIcCI(xs: number[], ys: number[], block: number, seed = 0x7ab1): { lo: number; hi: number } {
  const n = xs.length;
  if (n < 8) return { lo: NaN, hi: NaN };
  const L = Math.max(1, Math.min(block, Math.floor(n / 2)));
  const rnd = mulberry32(seed);
  const nb = Math.ceil(n / L);
  const stats: number[] = [];
  for (let b = 0; b < BOOT_ITER; b++) {
    const bx: number[] = [], by: number[] = [];
    for (let j = 0; j < nb && bx.length < n; j++) {
      const st = Math.floor(rnd() * (n - L + 1));
      for (let t = 0; t < L && bx.length < n; t++) { bx.push(xs[st + t]); by.push(ys[st + t]); }
    }
    stats.push(spearman(bx, by));
  }
  stats.sort((a, b) => a - b);
  return { lo: quantileSorted(stats, 0.025), hi: quantileSorted(stats, 0.975) };
}

/** Newey–West 分散の重み(Bartlett)。重複窓の自己相関を吸収する。 */
function neweyWestVar(u: number[], X: number[][], lag: number): number[][] | null {
  const n = u.length, k = X[0].length;
  // X'X の逆行列(2x2 のみ)
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) { a += X[i][0] * X[i][0]; b += X[i][0] * X[i][1]; c += X[i][1] * X[i][1]; }
  const det = a * c - b * b;
  if (!isFinite(det) || Math.abs(det) < 1e-14) return null;
  const inv = [[c / det, -b / det], [-b / det, a / det]];
  // S = Σ_l w_l Σ_t u_t u_{t-l} (x_t x_{t-l}' + x_{t-l} x_t')
  const S = [[0, 0], [0, 0]];
  for (let i = 0; i < n; i++) {
    const g = [X[i][0] * u[i], X[i][1] * u[i]];
    for (let r = 0; r < k; r++) for (let s = 0; s < k; s++) S[r][s] += g[r] * g[s];
  }
  for (let l = 1; l <= lag; l++) {
    const w = 1 - l / (lag + 1);
    for (let i = l; i < n; i++) {
      const g0 = [X[i][0] * u[i], X[i][1] * u[i]];
      const g1 = [X[i - l][0] * u[i - l], X[i - l][1] * u[i - l]];
      for (let r = 0; r < k; r++) for (let s = 0; s < k; s++) S[r][s] += w * (g0[r] * g1[s] + g1[r] * g0[s]);
    }
  }
  // V = (X'X)^-1 S (X'X)^-1
  const M = [[0, 0], [0, 0]];
  for (let r = 0; r < k; r++) for (let s = 0; s < k; s++) {
    let v = 0;
    for (let t = 0; t < k; t++) for (let q = 0; q < k; q++) v += inv[r][t] * S[t][q] * inv[q][s];
    M[r][s] = v;
  }
  return M;
}

// ───────────────────────── 採点則 ─────────────────────────

/**
 * 方向の採点。flat は「言わなかった」として除外する（言わないことを外れとは数えない）。
 * ヌルは「実測の多数派方向を常に言い続ける」戦略の的中率。上げ相場では 6割を超えるので、
 * 素の的中率だけを見ると必ず良く見える——ここを外すと採点にならない。
 * Pesaran–Timmermann は予測と実測の独立性を検定し、多数派当てを自動で割り引く。
 */
function scoreDirection(points: AsOfPoint[], hIdx: number, h: number, block: number): DirectionScore {
  const pred: number[] = [], act: number[] = [];
  let nFlat = 0;
  for (const p of points) {
    const f = p.fwd[hIdx];
    if (!f || !p.digest.ok) continue;
    const d = p.digest.direction;
    if (d === "flat") { nFlat++; continue; }
    pred.push(d === "up" ? 1 : -1);
    act.push(f.ret >= 0 ? 1 : -1);
  }
  const n = pred.length;
  if (n < 4) {
    return { h, n, nFlat, hit: NaN, hitLo: NaN, hitHi: NaN, baseHit: NaN, ptStat: NaN, ptP: NaN };
  }
  const hits = pred.map((v, i) => (v === act[i] ? 1 : 0));
  const hit = mean(hits);
  const ci = blockMeanCI(hits, block, 0x11a3);
  const upAct = act.filter((v) => v > 0).length / n;
  const baseHit = Math.max(upAct, 1 - upAct);

  // Pesaran–Timmermann (1992)
  const Px = pred.filter((v) => v > 0).length / n;
  const Py = upAct;
  const Pstar = Px * Py + (1 - Px) * (1 - Py);
  const varP = (Pstar * (1 - Pstar)) / n;
  const varPstar =
    ((2 * Py - 1) ** 2 * Px * (1 - Px)) / n +
    ((2 * Px - 1) ** 2 * Py * (1 - Py)) / n +
    (4 * Px * Py * (1 - Px) * (1 - Py)) / (n * n);
  const denom = Math.sqrt(Math.max(varP - varPstar, 1e-18));
  const ptStat = (hit - Pstar) / denom;
  const ptP = isFinite(ptStat) ? 2 * (1 - normalCdf(Math.abs(ptStat))) : NaN;
  return { h, n, nFlat, hit, hitLo: ci.lo, hitHi: ci.hi, baseHit, ptStat, ptP };
}

/**
 * 確率予測(上昇確率)の採点。ブライアスコア＝(予測確率 − 実現0/1)² の平均。
 * 小さいほど良いが、絶対値には意味がない——比較対象は「気候値」(常に実測基準率を答える予測)。
 * BSS>0 でようやく「基準率より情報がある」と言える。Murphy 分解で
 * ブライア = 較正誤差 − 分解能 + 不確実性 に分ける（分解能が0なら、当たっていても中身は基準率）。
 */
function scoreProbability(points: AsOfPoint[], hIdx: number, h: number, bandIdx: number): ProbabilityScore {
  const ps: number[] = [], ys: number[] = [];
  for (const p of points) {
    const f = p.fwd[hIdx];
    if (!f || !p.fc.ok) continue;
    const hf = p.fc.horizons[bandIdx];
    if (!hf || !isFinite(hf.upProb)) continue;
    ps.push(Math.min(1, Math.max(0, hf.upProb)));
    ys.push(f.ret >= 0 ? 1 : 0);
  }
  const n = ps.length;
  const empty: ProbabilityScore = {
    h, n, meanP: NaN, obsRate: NaN, brier: NaN, brierClim: NaN, bss: NaN, logLoss: NaN,
    bins: [], reliability: NaN, resolution: NaN, uncertainty: NaN,
  };
  if (n < 8) return empty;
  const obsRate = mean(ys);
  const brier = mean(ps.map((p, i) => (p - ys[i]) ** 2));
  const brierClim = obsRate * (1 - obsRate); // 気候値予測のブライア＝不確実性
  const logLoss = mean(ps.map((p, i) => {
    const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
    return -(ys[i] * Math.log(q) + (1 - ys[i]) * Math.log(1 - q));
  }));

  // 較正ビン(10等分)。Murphy 分解もここから作る。
  const NB = 10;
  const acc = Array.from({ length: NB }, () => ({ sp: 0, sy: 0, n: 0 }));
  for (let i = 0; i < n; i++) {
    const b = Math.min(NB - 1, Math.floor(ps[i] * NB));
    acc[b].sp += ps[i]; acc[b].sy += ys[i]; acc[b].n++;
  }
  const bins: CalibBin[] = acc.map((a, b) => ({
    pMid: (b + 0.5) / NB,
    pMean: a.n ? a.sp / a.n : NaN,
    obs: a.n ? a.sy / a.n : NaN,
    n: a.n,
  }));
  let reliability = 0, resolution = 0;
  for (const a of acc) {
    if (a.n === 0) continue;
    const pk = a.sp / a.n, ok = a.sy / a.n;
    reliability += (a.n / n) * (pk - ok) ** 2;
    resolution += (a.n / n) * (ok - obsRate) ** 2;
  }
  return {
    h, n, meanP: mean(ps), obsRate, brier, brierClim,
    bss: brierClim > 0 ? 1 - brier / brierClim : NaN,
    logLoss, bins, reliability, resolution, uncertainty: brierClim,
  };
}

/**
 * 予測レンジ(区間)の採点。名目50%の帯に実測が5割入るか——入らないなら、
 * その帯を「5割の確率で収まる範囲」として読むのは誤り。
 * Christoffersen の LR 検定で「被覆率が名目と等しい」を検定する。
 * 独立性(LR_ind)は重複窓では解釈できないので、overlap>1 のときは参考値。
 */
function scoreIntervals(points: AsOfPoint[], hIdx: number, h: number, bandIdx: number, block: number): IntervalScore[] {
  const out: IntervalScore[] = [];
  const levels = [0.5, 0.8, 0.95];
  for (let li = 0; li < levels.length; li++) {
    const level = levels[li];
    const inside: number[] = [];
    const widths: number[] = [];
    const pinballs: number[] = [];
    for (const p of points) {
      const f = p.fwd[hIdx];
      if (!f || !p.fc.ok) continue;
      const hf = p.fc.horizons[bandIdx];
      const band = hf?.bands.find((b) => Math.abs(b.level - level) < 1e-9);
      if (!band) continue;
      const y = f.logRet;
      const lo = band.lowReturn, hi = band.highReturn;
      inside.push(y >= lo && y <= hi ? 1 : 0);
      widths.push(((band.highPrice - band.lowPrice) / p.close) * 100);
      const qLo = (1 - level) / 2, qHi = (1 + level) / 2;
      const pl = (q: number, fq: number) => (y >= fq ? (y - fq) * q : (fq - y) * (1 - q));
      pinballs.push((pl(qLo, lo) + pl(qHi, hi)) / 2);
    }
    const n = inside.length;
    if (n < 8) {
      out.push({ h, level, n, coverage: NaN, covLo: NaN, covHi: NaN, nominal: level,
        meanWidthPct: NaN, pinball: NaN, lrUc: NaN, lrUcP: NaN, lrInd: NaN, lrCc: NaN, lrCcP: NaN });
      continue;
    }
    const coverage = mean(inside);
    const ci = blockMeanCI(inside, block, 0x2f10 + li);

    // Christoffersen: 違反 I_t = 1(区間外)。期待違反率 pv = 1 − level。
    const I = inside.map((v) => 1 - v);
    const n1 = I.reduce((s, v) => s + v, 0), n0 = n - n1;
    const pv = 1 - level;
    const piHat = n1 / n;
    const ll = (pp: number, a: number, b: number) =>
      (a > 0 ? a * Math.log(Math.max(1 - pp, 1e-12)) : 0) + (b > 0 ? b * Math.log(Math.max(pp, 1e-12)) : 0);
    const lrUc = -2 * (ll(pv, n0, n1) - ll(piHat, n0, n1));
    let n00 = 0, n01 = 0, n10 = 0, n11 = 0;
    for (let t = 1; t < n; t++) {
      if (I[t - 1] === 0 && I[t] === 0) n00++;
      else if (I[t - 1] === 0 && I[t] === 1) n01++;
      else if (I[t - 1] === 1 && I[t] === 0) n10++;
      else n11++;
    }
    const p01 = n00 + n01 > 0 ? n01 / (n00 + n01) : 0;
    const p11 = n10 + n11 > 0 ? n11 / (n10 + n11) : 0;
    const pAll = (n01 + n11) / Math.max(1, n00 + n01 + n10 + n11);
    const lnp = (x: number) => Math.log(Math.max(x, 1e-12));
    const l0 = (n00 + n10) * lnp(1 - pAll) + (n01 + n11) * lnp(pAll);
    const l1 = n00 * lnp(1 - p01) + n01 * lnp(p01) + n10 * lnp(1 - p11) + n11 * lnp(p11);
    const lrInd = -2 * (l0 - l1);
    const lrCc = lrUc + lrInd;
    out.push({
      h, level, n, coverage, covLo: ci.lo, covHi: ci.hi, nominal: level,
      meanWidthPct: mean(widths), pinball: mean(pinballs),
      lrUc, lrUcP: chiSquareSurvival(Math.max(lrUc, 0), 1),
      lrInd, lrCc, lrCcP: chiSquareSurvival(Math.max(lrCc, 0), 2),
    });
  }
  return out;
}

/**
 * ボラ予測の採点。Mincer–Zarnowitz 回帰 realized = a + b·predicted に対し
 * (a,b)=(0,1) を同時検定する。b<1 は「予測が過大に振れている(縮めるべき)」を意味し、
 * b>1 は逆。QLIKE は分散予測に対する適正損失で、水準の取り違えに敏感。
 * 重複窓の自己相関は Newey–West で吸収する。
 */
function scoreVol(points: AsOfPoint[], hIdx: number, h: number, overlap: number): VolScore {
  const pred: number[] = [], real: number[] = [];
  for (const p of points) {
    const f = p.fwd[hIdx];
    if (!f || !p.fc.ok) continue;
    const pv = p.fc.dailyVolGarch;
    if (!(pv > 0) || !(f.realizedVolDaily > 0)) continue;
    pred.push(pv); real.push(f.realizedVolDaily);
  }
  const n = pred.length;
  const empty: VolScore = { h, n, a: NaN, b: NaN, seA: NaN, seB: NaN, r2: NaN, wald: NaN, waldP: NaN, qlike: NaN, corr: NaN, meanPred: NaN, meanReal: NaN };
  if (n < 10) return empty;

  const mx = mean(pred), my = mean(real);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (pred[i] - mx) ** 2; sxy += (pred[i] - mx) * (real[i] - my); syy += (real[i] - my) ** 2; }
  if (sxx <= 0) return empty;
  const b = sxy / sxx;
  const a = my - b * mx;
  const u = real.map((y, i) => y - a - b * pred[i]);
  const r2 = syy > 0 ? 1 - u.reduce((s, v) => s + v * v, 0) / syy : NaN;
  const X = pred.map((v) => [1, v]);
  const V = neweyWestVar(u, X, Math.max(1, overlap - 1));
  let seA = NaN, seB = NaN, wald = NaN, waldP = NaN;
  if (V) {
    seA = Math.sqrt(Math.max(V[0][0], 0));
    seB = Math.sqrt(Math.max(V[1][1], 0));
    const d = [a - 0, b - 1];
    const det = V[0][0] * V[1][1] - V[0][1] * V[1][0];
    if (isFinite(det) && Math.abs(det) > 1e-24) {
      const iv = [[V[1][1] / det, -V[0][1] / det], [-V[1][0] / det, V[0][0] / det]];
      wald = d[0] * (iv[0][0] * d[0] + iv[0][1] * d[1]) + d[1] * (iv[1][0] * d[0] + iv[1][1] * d[1]);
      waldP = chiSquareSurvival(Math.max(wald, 0), 2);
    }
  }
  // QLIKE: 分散スケールで評価する(σ² 同士の比)
  const qlike = mean(pred.map((pv, i) => {
    const r = (real[i] * real[i]) / (pv * pv);
    return r - Math.log(Math.max(r, 1e-12)) - 1;
  }));
  const corr = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
  return { h, n, a, b, seA, seB, r2, wald, waldP, qlike, corr, meanPred: mx, meanReal: my };
}

/** 連続量の判断(スコア類)は IC で採点する。方向の言い切りより情報量が多い。 */
const IC_FIELDS: { key: string; label: string; get: (d: SignalDigest) => number; note: string }[] = [
  { key: "regimeScore", label: "レジーム総合スコア", get: (d) => d.regimeScore, note: "方向の元になる −100..100 のスコア" },
  { key: "meanRevZ", label: "平均回帰z(乖離)", get: (d) => -d.meanRevZ, note: "符号反転して評価（高z=割高→下落を予測）" },
  { key: "hurst", label: "Hurst指数", get: (d) => d.hurst, note: "持続性。方向そのものではないので IC は小さくて当然" },
  { key: "upProbDigest", label: "上昇確率(1日)", get: (d) => d.upProb, note: "確率をそのまま順位相関で見る" },
  { key: "drawdownPct", label: "ドローダウン", get: (d) => d.drawdownPct, note: "深いほど反発？を検定" },
  { key: "cvar95Pct", label: "CVaR95", get: (d) => d.cvar95Pct, note: "テールの厚み" },
];

function scoreIc(points: AsOfPoint[], hIdx: number, h: number, block: number, overlap: number): IcScore[] {
  return IC_FIELDS.map((f, fi) => {
    const xs: number[] = [], ys: number[] = [];
    for (const p of points) {
      const fw = p.fwd[hIdx];
      if (!fw || !p.digest.ok) continue;
      const v = f.get(p.digest);
      if (!isFinite(v)) continue;
      xs.push(v); ys.push(fw.ret);
    }
    const n = xs.length;
    if (n < 12) {
      return { key: f.key, label: f.label, h, n, nEff: n / overlap, ic: NaN, icLo: NaN, icHi: NaN, quintiles: [], monotone: NaN };
    }
    const ic = spearman(xs, ys);
    const ci = blockIcCI(xs, ys, block, 0x33a0 + fi);
    // 5分位
    const order = xs.map((v, i) => ({ v, y: ys[i] })).sort((A, B) => A.v - B.v);
    const q: { mean: number; n: number }[] = [];
    for (let g = 0; g < 5; g++) {
      const s = Math.floor((g * order.length) / 5), e = Math.floor(((g + 1) * order.length) / 5);
      const seg = order.slice(s, e).map((o) => o.y);
      q.push({ mean: seg.length ? mean(seg) : NaN, n: seg.length });
    }
    const monotone = spearman(q.map((_, i) => i), q.map((v) => v.mean));
    return { key: f.key, label: f.label, h, n, nEff: n / overlap, ic, icLo: ci.lo, icHi: ci.hi, quintiles: q, monotone };
  });
}

/** 警告系(二値の判断)は「出た後に本当にそうなったか」で採点する。 */
const EVENT_FIELDS: { key: string; label: string; get: (d: SignalDigest) => boolean }[] = [
  { key: "changePoint", label: "変化点検知", get: (d) => d.changePoint },
  { key: "volSpike", label: "ボラ急拡大", get: (d) => d.volSpike },
  { key: "highVol", label: "高ボラ・レジーム", get: (d) => d.highVol },
];

function scoreEvents(points: AsOfPoint[], hIdx: number, h: number): EventScore[] {
  return EVENT_FIELDS.map((f) => {
    const ev: number[] = [], non: number[] = [], evR: number[] = [], nonR: number[] = [];
    for (const p of points) {
      const fw = p.fwd[hIdx];
      if (!fw || !p.digest.ok) continue;
      if (f.get(p.digest)) { ev.push(fw.realizedVolDaily * 100); evR.push(fw.ret * 100); }
      else { non.push(fw.realizedVolDaily * 100); nonR.push(fw.ret * 100); }
    }
    if (ev.length < 4 || non.length < 4) {
      return { key: f.key, label: f.label, h, nEvent: ev.length, nNon: non.length,
        volEvent: ev.length ? mean(ev) : NaN, volNon: non.length ? mean(non) : NaN,
        retEvent: evR.length ? mean(evR) : NaN, retNon: nonR.length ? mean(nonR) : NaN,
        tStat: NaN, p: NaN };
    }
    // Welch t（分散が違う前提。重複窓ぶん自由度は楽観的なので p は目安）
    const v1 = std(ev) ** 2 / ev.length, v2 = std(non) ** 2 / non.length;
    const se = Math.sqrt(v1 + v2);
    const t = se > 0 ? (mean(ev) - mean(non)) / se : NaN;
    const df = se > 0 ? (v1 + v2) ** 2 / (v1 ** 2 / (ev.length - 1) + v2 ** 2 / (non.length - 1)) : 1;
    const p = isFinite(t) ? 2 * (1 - normalCdf(Math.abs(t))) : NaN; // df 十分大なので正規近似
    void df;
    return {
      key: f.key, label: f.label, h, nEvent: ev.length, nNon: non.length,
      volEvent: mean(ev), volNon: mean(non), retEvent: mean(evR), retNon: mean(nonR), tStat: t, p,
    };
  });
}

// ───────────────────────── 本体 ─────────────────────────

export function runAsOfReplay(
  prices: PricePoint[],
  ticker: string,
  params: AsOfReplayParams,
  onProgress?: (done: number, total: number) => void
): AsOfReplayResult {
  const empty = (reason: string): AsOfReplayResult => ({
    ok: false, reason, params, points: [], firstDate: "", lastDate: "",
    overlap: [], nEff: [], direction: [], probability: [], intervals: [], vol: [], ics: [], events: [],
  });
  const idxs = buildAsOfIndices(prices, params);
  if (idxs.length < 12) {
    return empty(`as-of 点が ${idxs.length} 点しか取れません（間隔を詰めるか対象期間を延ばしてください）。`);
  }

  const points: AsOfPoint[] = [];
  for (let i = 0; i < idxs.length; i++) {
    points.push(replayAt(prices, idxs[i], ticker, params.horizon));
    if (onProgress && (i % 5 === 0 || i === idxs.length - 1)) onProgress(i + 1, idxs.length);
  }

  const overlap = FWD_HORIZONS.map((h) => Math.max(1, Math.ceil(h / params.spacing)));
  const nEff = overlap.map((ov) => points.length / ov);

  const direction: DirectionScore[] = [];
  const probability: ProbabilityScore[] = [];
  const intervals: IntervalScore[] = [];
  const vol: VolScore[] = [];
  const ics: IcScore[] = [];
  const events: EventScore[] = [];

  for (let hi = 0; hi < FWD_HORIZONS.length; hi++) {
    const h = FWD_HORIZONS[hi];
    const block = overlap[hi];
    direction.push(scoreDirection(points, hi, h, block));
    // 予測レンジは BAND_HORIZONS にある h だけ採点できる
    const bandIdx = (BAND_HORIZONS as readonly number[]).indexOf(h);
    if (bandIdx >= 0) {
      probability.push(scoreProbability(points, hi, h, bandIdx));
      intervals.push(...scoreIntervals(points, hi, h, bandIdx, block));
    }
    vol.push(scoreVol(points, hi, h, block));
    ics.push(...scoreIc(points, hi, h, block, block));
    events.push(...scoreEvents(points, hi, h));
  }

  return {
    ok: true, params, points,
    firstDate: points[0].date, lastDate: points[points.length - 1].date,
    overlap, nEff, direction, probability, intervals, vol, ics, events,
  };
}
