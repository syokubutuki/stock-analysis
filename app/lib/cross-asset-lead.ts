// クロスアセット先行指標スキャン（金・BTC・コモディティ・金利・為替・信用・海外金融株 → 日本株）。
//
// 問い: 「金やビットコインの動きは、この銘柄の短期の値動きに先行するか」。
// 答えを「いつの値動きに先行するか」で4つに分けて測る。分けないと、売買できない時間帯
// （前日終値→当日始値の窓）での強い相関を「先行指標が見つかった」と誤読する。
//
// 時刻の規約（先読み防止・us-spillover-core.alignJpUs と同じ「日付が厳密に小さい最新の行」）:
//   日本の立会日 D の判断時刻は寄り付き直前。候補 X は日付が D より厳密に小さい最新の足の終値。
//   - 米国株/ETF/先物: 日付 D-1 の終値は JST D の朝5〜7時に確定
//   - BTC/ETH: 日付 D-1 の足は UTC 0時 = JST 9時に閉じる（寄り付きちょうど）。月曜は日曜の足
//   - FX: 日付 D-1 の足は London 0時 = JST 8〜9時に閉じる
//   - 香港: D-1 の終値は JST D-1 の17時台
//   X の「1日変化」d1(D) = ln X_asof(D) − ln X_asof(D−1)（日本の判断時刻どうしの間の変化）。
//   利回り（^TNX 等）は水準差（%pt）。
//
// 研究の記録: research/leading-indicators/（scan.py / scan2.py / oot.py / yearly.py / regime*.py）。

import { PricePoint } from "./types";

export type LeadKind = "log" | "diff";

export interface LeadCandidate {
  ticker: string;
  label: string;
  group: string;
  kind: LeadKind;
}

export const LEAD_GROUPS = [
  "コモディティ",
  "暗号資産",
  "米金利・債券",
  "為替",
  "海外の金融株",
  "リスク指標・株価指数",
] as const;

export const LEAD_CANDIDATES: LeadCandidate[] = [
  { ticker: "GC=F", label: "金", group: "コモディティ", kind: "log" },
  { ticker: "SI=F", label: "銀", group: "コモディティ", kind: "log" },
  { ticker: "HG=F", label: "銅", group: "コモディティ", kind: "log" },
  { ticker: "CL=F", label: "原油(WTI)", group: "コモディティ", kind: "log" },
  { ticker: "BTC-USD", label: "ビットコイン", group: "暗号資産", kind: "log" },
  { ticker: "ETH-USD", label: "イーサリアム", group: "暗号資産", kind: "log" },
  { ticker: "^TNX", label: "米10年金利", group: "米金利・債券", kind: "diff" },
  { ticker: "^FVX", label: "米5年金利", group: "米金利・債券", kind: "diff" },
  { ticker: "^IRX", label: "米3か月金利", group: "米金利・債券", kind: "diff" },
  { ticker: "TLT", label: "米長期国債(TLT)", group: "米金利・債券", kind: "log" },
  { ticker: "HYG", label: "米ハイイールド債(HYG)", group: "米金利・債券", kind: "log" },
  { ticker: "LQD", label: "米投資適格債(LQD)", group: "米金利・債券", kind: "log" },
  { ticker: "USDJPY=X", label: "ドル円", group: "為替", kind: "log" },
  { ticker: "EURJPY=X", label: "ユーロ円", group: "為替", kind: "log" },
  { ticker: "AUDJPY=X", label: "豪ドル円", group: "為替", kind: "log" },
  { ticker: "DX-Y.NYB", label: "ドル指数(DXY)", group: "為替", kind: "log" },
  { ticker: "XLF", label: "米金融株(XLF)", group: "海外の金融株", kind: "log" },
  { ticker: "KBE", label: "米銀行株(KBE)", group: "海外の金融株", kind: "log" },
  { ticker: "KRE", label: "米地銀株(KRE)", group: "海外の金融株", kind: "log" },
  { ticker: "JPM", label: "JPモルガン", group: "海外の金融株", kind: "log" },
  { ticker: "EUFN", label: "欧州金融株(EUFN)", group: "海外の金融株", kind: "log" },
  { ticker: "^VIX", label: "VIX", group: "リスク指標・株価指数", kind: "log" },
  { ticker: "^MOVE", label: "MOVE(債券VIX)", group: "リスク指標・株価指数", kind: "log" },
  { ticker: "^GSPC", label: "S&P500", group: "リスク指標・株価指数", kind: "log" },
  { ticker: "NKD=F", label: "日経平均先物(CME)", group: "リスク指標・株価指数", kind: "log" },
  { ticker: "^HSI", label: "香港ハンセン", group: "リスク指標・株価指数", kind: "log" },
];

/** 寄り付き窓モデルに入れる説明変数（事前に経済的な理由で固定。選び方は Guide に開示）。 */
export const GAP_MODEL_TICKERS = ["^GSPC", "XLF", "^FVX", "^VIX", "EUFN", "USDJPY=X"];

/** 対照として常に入れる米国株（「米国株が上がっただけ」を除いても残るか）。 */
export const CONTROL_TICKER = "^GSPC";

export type LeadHorizon = "gap" | "id" | "oo" | "f5";
export const LEAD_HORIZONS: LeadHorizon[] = ["gap", "id", "oo", "f5"];
/** 売買できる（寄りで建てられる）ホライズン。族補正はこの3つで行う。 */
export const TRADABLE_HORIZONS: LeadHorizon[] = ["id", "oo", "f5"];

export const HORIZON_LABEL: Record<LeadHorizon, string> = {
  gap: "寄り付きの窓",
  id: "寄り→引け",
  oo: "寄り→翌寄り",
  f5: "寄り→5日後",
};

export type LeadFeat = "d1" | "d5";
export const FEAT_LABEL: Record<LeadFeat, string> = { d1: "前夜1日の変化", d5: "直近5日の変化" };

/** 日本側のターゲット（立会日 D の行）。 */
export interface JpTargets {
  times: string[];
  gap: Float64Array; // ln(O_D / C_{D-1})
  id: Float64Array; // ln(C_D / O_D)
  oo: Float64Array; // ln(O_{D+1} / O_D)
  f5: Float64Array; // ln(O_{D+5} / O_D)
}

export function buildJpTargets(prices: PricePoint[]): JpTargets {
  const n = prices.length;
  const times: string[] = [];
  const gap = new Float64Array(n).fill(NaN);
  const id = new Float64Array(n).fill(NaN);
  const oo = new Float64Array(n).fill(NaN);
  const f5 = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const p = prices[i];
    times.push(p.time);
    const ok = (v: number) => Number.isFinite(v) && v > 0;
    if (i > 0 && ok(p.open) && ok(prices[i - 1].close)) gap[i] = Math.log(p.open / prices[i - 1].close);
    if (ok(p.open) && ok(p.close)) id[i] = Math.log(p.close / p.open);
    if (i + 1 < n && ok(p.open) && ok(prices[i + 1].open)) oo[i] = Math.log(prices[i + 1].open / p.open);
    if (i + 5 < n && ok(p.open) && ok(prices[i + 5].open)) f5[i] = Math.log(prices[i + 5].open / p.open);
  }
  return { times, gap, id, oo, f5 };
}

/**
 * 候補 X を日本の立会日に asof 整合する。
 * level[k] = 日付が times[k] より厳密に小さい最新の足の（対数）終値。d1/d5 はその差。
 * `next` は「次の立会日の寄り」用の d1（最新の足 − 最後の日本立会日の asof 値）。
 */
export interface AlignedFeature {
  d1: Float64Array;
  d5: Float64Array;
  /** 次の寄り付きに向けた1日変化（最新値 − 最後の日本立会日時点の値）。 */
  nextD1: number;
  /** 最新の足の日付（次の寄りの予想がどこまでの情報を使っているか）。 */
  latestTime: string | null;
}

export function alignFeature(times: string[], x: PricePoint[], kind: LeadKind): AlignedFeature {
  const n = times.length;
  const xs = x.filter((p) => Number.isFinite(p.close) && (kind === "diff" || p.close > 0));
  const tf = (v: number) => (kind === "log" ? Math.log(v) : v);
  const level = new Float64Array(n).fill(NaN);
  let j = -1;
  for (let k = 0; k < n; k++) {
    while (j + 1 < xs.length && xs[j + 1].time < times[k]) j++;
    if (j >= 0) level[k] = tf(xs[j].close);
  }
  const d1 = new Float64Array(n).fill(NaN);
  const d5 = new Float64Array(n).fill(NaN);
  for (let k = 1; k < n; k++) {
    d1[k] = level[k] - level[k - 1];
    if (k >= 5) d5[k] = level[k] - level[k - 5];
  }
  const last = xs.length ? xs[xs.length - 1] : null;
  // 最後の日本立会日 D_last の当日に確定した足まで含む最新値。D_last 自身の asof は < D_last。
  const nextD1 = last && n > 0 ? tf(last.close) - level[n - 1] : NaN;
  return { d1, d5, nextD1, latestTime: last ? last.time : null };
}

// ───────────────────────── 回帰と検定 ─────────────────────────

/** 単回帰 y = a + b x の b と t。lags>0 なら Newey-West（Bartlett）、0 なら HC0。 */
export function slopeT(y: ArrayLike<number>, x: ArrayLike<number>, lags = 0): { b: number; t: number; n: number; r: number } {
  // 円環シフトの帰無で数万回呼ばれるため、配列を作らずに欠損を飛ばしながら集計する。
  const n0 = Math.min(y.length, x.length);
  let n = 0, mx = 0, my = 0;
  for (let i = 0; i < n0; i++) {
    const a = y[i], c = x[i];
    if (Number.isFinite(a) && Number.isFinite(c)) { n++; mx += c; my += a; }
  }
  if (n < 30) return { b: NaN, t: NaN, n, r: NaN };
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n0; i++) {
    const a = y[i], c = x[i];
    if (!Number.isFinite(a) || !Number.isFinite(c)) continue;
    const dx = c - mx, dy = a - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return { b: NaN, t: NaN, n, r: NaN };
  const b = sxy / sxx;
  // u_i = (x_i − x̄)·e_i。Var(b̂) = [Σu² + 2Σ_l w_l Σ u_i u_{i−l}] / Sxx²（l は有効な観測の並びで数える）
  let s = 0;
  const u = lags > 0 ? new Float64Array(n) : null;
  let m = 0;
  for (let i = 0; i < n0; i++) {
    const a = y[i], c = x[i];
    if (!Number.isFinite(a) || !Number.isFinite(c)) continue;
    const dx = c - mx;
    const ui = dx * (a - my - b * dx);
    s += ui * ui;
    if (u) u[m++] = ui;
  }
  if (u) {
    for (let l = 1; l <= lags; l++) {
      let c = 0;
      for (let i = l; i < n; i++) c += u[i] * u[i - l];
      s += 2 * (1 - l / (lags + 1)) * c;
    }
  }
  const se = Math.sqrt(Math.max(s, 1e-300)) / sxx;
  return { b, t: b / se, n, r: sxy / Math.sqrt(sxx * syy) };
}

/** 説明変数2つ（x と対照 z）の重回帰で x の t（HC0。f5 は NW）。 */
export function partialT(y: ArrayLike<number>, x: ArrayLike<number>, z: ArrayLike<number>, lags = 0): number {
  // Frisch–Waugh: y と x を z に回帰した残差どうしの単回帰の係数は、重回帰の係数に等しい。
  const n0 = Math.min(y.length, x.length, z.length);
  const Y: number[] = [], X: number[] = [], Z: number[] = [];
  for (let i = 0; i < n0; i++) {
    if (Number.isFinite(y[i]) && Number.isFinite(x[i]) && Number.isFinite(z[i])) { Y.push(y[i]); X.push(x[i]); Z.push(z[i]); }
  }
  if (Y.length < 30) return NaN;
  const resid = (a: number[]) => {
    const n = a.length;
    let mz = 0, ma = 0;
    for (let i = 0; i < n; i++) { mz += Z[i]; ma += a[i]; }
    mz /= n; ma /= n;
    let szz = 0, sza = 0;
    for (let i = 0; i < n; i++) { szz += (Z[i] - mz) ** 2; sza += (Z[i] - mz) * (a[i] - ma); }
    const g = szz > 0 ? sza / szz : 0;
    return a.map((v, i) => v - ma - g * (Z[i] - mz));
  };
  return slopeT(resid(Y), resid(X), lags).t;
}

/**
 * 拡大窓の単回帰による1期先予測の時間外 R²（基準は予測0＝ドリフトなし）。
 * R²_oos = 1 − Σ(y − ŷ)² / Σ y²。startFrac の位置から予測を始める。
 */
export function oosR2(y: ArrayLike<number>, x: ArrayLike<number>, startFrac = 0.4): { r2: number; hit: number; n: number } {
  const n = Math.min(y.length, x.length);
  let cx = 0, cy = 0, cxx = 0, cxy = 0, m = 0;
  const start = Math.floor(n * startFrac);
  let sse = 0, sst = 0, hits = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const a = y[i], c = x[i];
    if (!Number.isFinite(a) || !Number.isFinite(c)) continue;
    if (i >= start && m >= 250) {
      const v = cxx - (cx * cx) / m;
      const b = v > 0 ? (cxy - (cx * cy) / m) / v : 0;
      const a0 = cy / m - (b * cx) / m;
      const p = a0 + b * c;
      sse += (a - p) ** 2; sst += a * a; cnt++;
      if (Math.sign(p) === Math.sign(a) && a !== 0) hits++;
    }
    cx += c; cy += a; cxx += c * c; cxy += c * a; m++;
  }
  return { r2: sst > 0 ? 1 - sse / sst : NaN, hit: cnt ? hits / cnt : NaN, n: cnt };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rollArr(a: Float64Array, s: number): Float64Array {
  const n = a.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[(i + s) % n] = a[i];
  return out;
}

// ───────────────────────── スキャン本体 ─────────────────────────

export interface LeadCell {
  ticker: string;
  feat: LeadFeat;
  horizon: LeadHorizon;
  n: number;
  beta: number;
  t: number;
  /** 相関係数（ピアソン）。 */
  r: number;
  /** S&P500 の前夜1日変化を対照に入れたときの t（S&P 自身は NaN）。 */
  tCtrl: number;
  /** 時間外 R²（拡大窓・予測0基準）。f5 は重複があるので出さない（NaN）。 */
  oosR2: number;
  oosHit: number;
  /** 年別相関が正の年数 / 年数。 */
  yearsPos: number;
  years: number;
  /** 前半・後半の相関（安定性）。 */
  rFirst: number;
  rSecond: number;
  /** 族補正 p（売買できるホライズンのみ。窓は NaN）。 */
  pFamily: number;
}

export interface LeadScanInput {
  targets: JpTargets;
  features: { ticker: string; d1: Float64Array; d5: Float64Array }[];
  nNull?: number;
  seed?: number;
}

export interface LeadScanResult {
  cells: LeadCell[];
  /** ホライズンごとの帰無 max|t| の95%点。 */
  nullQ95: Partial<Record<LeadHorizon, number>>;
  nNull: number;
  nTests: number;
  /** 族補正 p<0.05 を満たす売買可能セルの数。 */
  nFamilySig: number;
  nDays: number;
  firstTime: string;
  lastTime: string;
}

const LAGS: Record<LeadHorizon, number> = { gap: 0, id: 0, oo: 0, f5: 4 };

function corrOn(y: Float64Array, x: Float64Array, from: number, to: number): number {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = from; i < to; i++) {
    const a = y[i], c = x[i];
    if (!Number.isFinite(a) || !Number.isFinite(c)) continue;
    n++; sx += c; sy += a; sxx += c * c; syy += a * a; sxy += a * c;
  }
  if (n < 60) return NaN;
  const vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n;
  return vx > 0 && vy > 0 ? (sxy - (sx * sy) / n) / Math.sqrt(vx * vy) : NaN;
}

export function scanLeads({ targets, features, nNull = 300, seed = 20261021 }: LeadScanInput): LeadScanResult {
  const T = targets;
  const n = T.times.length;
  const ctrl = features.find((f) => f.ticker === CONTROL_TICKER);
  // 年の境界
  const yearBounds: [number, number][] = [];
  for (let i = 0; i < n; ) {
    const y = T.times[i].slice(0, 4);
    let j = i;
    while (j < n && T.times[j].slice(0, 4) === y) j++;
    yearBounds.push([i, j]);
    i = j;
  }
  const half = Math.floor(n / 2);
  const cells: LeadCell[] = [];
  for (const f of features) {
    for (const feat of ["d1", "d5"] as LeadFeat[]) {
      const x = f[feat];
      for (const h of LEAD_HORIZONS) {
        const y = T[h];
        const s = slopeT(y, x, LAGS[h]);
        const tCtrl = ctrl && f.ticker !== CONTROL_TICKER ? partialT(y, x, ctrl.d1, LAGS[h]) : NaN;
        const o = h === "f5" ? { r2: NaN, hit: NaN } : oosR2(y, x);
        let yearsPos = 0, years = 0;
        for (const [a, b] of yearBounds) {
          const r = corrOn(y, x, a, b);
          if (Number.isFinite(r)) { years++; if (r > 0) yearsPos++; }
        }
        cells.push({
          ticker: f.ticker, feat, horizon: h, n: s.n, beta: s.b, t: s.t, r: s.r, tCtrl,
          oosR2: o.r2, oosHit: o.hit, yearsPos, years,
          rFirst: corrOn(y, x, 0, half), rSecond: corrOn(y, x, half, n), pFamily: NaN,
        });
      }
    }
  }
  // 族補正: 売買できるホライズンごとに、全候補×全特徴の max|t| の帰無分布を
  // 円環シフト（y を丸ごとずらす＝双方の自己相関を保ったまま、両者の時点の対応だけを壊す）で作る。
  const rand = mulberry32(seed);
  const nullQ95: Partial<Record<LeadHorizon, number>> = {};
  for (const h of TRADABLE_HORIZONS) {
    const y = T[h];
    const maxes = new Float64Array(nNull);
    for (let k = 0; k < nNull; k++) {
      const shift = 60 + Math.floor(rand() * Math.max(1, n - 120));
      const ys = rollArr(y, shift);
      let mx = 0;
      for (const f of features) {
        for (const feat of ["d1", "d5"] as LeadFeat[]) {
          const t = Math.abs(slopeT(ys, f[feat], LAGS[h]).t);
          if (t > mx) mx = t;
        }
      }
      maxes[k] = mx;
    }
    const sorted = Array.from(maxes).sort((a, b) => a - b);
    nullQ95[h] = sorted[Math.floor(0.95 * (nNull - 1))];
    for (const c of cells) {
      if (c.horizon !== h || !Number.isFinite(c.t)) continue;
      let ge = 0;
      for (let k = 0; k < nNull; k++) if (maxes[k] >= Math.abs(c.t)) ge++;
      c.pFamily = (ge + 1) / (nNull + 1);
    }
  }
  const tradable = cells.filter((c) => TRADABLE_HORIZONS.includes(c.horizon));
  return {
    cells,
    nullQ95,
    nNull,
    nTests: tradable.length,
    nFamilySig: tradable.filter((c) => c.pFamily < 0.05).length,
    nDays: n,
    firstTime: T.times[0] ?? "",
    lastTime: T.times[n - 1] ?? "",
  };
}

// ───────────────────────── 寄り付き窓モデル ─────────────────────────

export interface GapModelResult {
  tickers: string[];
  coef: { ticker: string; beta: number; t: number; contribution: number; nextX: number }[];
  intercept: number;
  /** 時間外 R²（拡大窓・21日ごと再推定・予測0基準）。 */
  oosR2: number;
  oosN: number;
  /** 全期間の残差の標準偏差。 */
  residSd: number;
  /** 次の寄りの窓の予測（対数）。 */
  nextPred: number;
  /** 最後の立会日の寄りについて、モデルの当てはめ値と実際（全期間の係数なので標本内）。 */
  lastTime: string;
  lastPred: number;
  lastActual: number;
  n: number;
}

/** 正規方程式を解く（小さい k 用。部分ピボット付きガウス消去）。 */
function solve(A: number[][], b: number[]): number[] | null {
  const k = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let q = c; q <= k; q++) M[r][q] -= f * M[c][q];
    }
  }
  return M.map((r, i) => r[k] / M[i][i]);
}

function invert(A: number[][]): number[][] | null {
  const k = A.length;
  const out: number[][] = [];
  for (let c = 0; c < k; c++) {
    const e = Array.from({ length: k }, (_, i) => (i === c ? 1 : 0));
    const col = solve(A, e);
    if (!col) return null;
    out.push(col);
  }
  // out[c] は列 c。対称なので転置不要
  return out;
}

export function fitGapModel(
  targets: JpTargets,
  feats: { ticker: string; d1: Float64Array; nextD1: number }[],
  startFrac = 0.4,
  refit = 21,
): GapModelResult | null {
  const n = targets.times.length;
  const k = feats.length + 1;
  const rows: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(targets.gap[i])) continue;
    if (feats.every((f) => Number.isFinite(f.d1[i]))) rows.push(i);
  }
  if (rows.length < 300) return null;
  const zRow = (i: number) => [1, ...feats.map((f) => f.d1[i])];
  // 累積の X'X と X'y
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  const start = Math.floor(rows.length * startFrac);
  let beta: number[] | null = null;
  let sse = 0, sst = 0, oosN = 0;
  for (let r = 0; r < rows.length; r++) {
    const i = rows[r];
    const z = zRow(i);
    const y = targets.gap[i];
    if (r >= start) {
      if (!beta || (r - start) % refit === 0) beta = solve(XtX, Xty) ?? beta;
      if (beta) {
        let p = 0;
        for (let q = 0; q < k; q++) p += beta[q] * z[q];
        sse += (y - p) ** 2; sst += y * y; oosN++;
      }
    }
    for (let a = 0; a < k; a++) {
      Xty[a] += z[a] * y;
      for (let b = 0; b < k; b++) XtX[a][b] += z[a] * z[b];
    }
  }
  const full = solve(XtX, Xty);
  const inv = invert(XtX);
  if (!full || !inv) return null;
  // HC0 の SE
  const meat = Array.from({ length: k }, () => new Array(k).fill(0));
  let ssr = 0;
  for (const i of rows) {
    const z = zRow(i);
    let p = 0;
    for (let q = 0; q < k; q++) p += full[q] * z[q];
    const e = targets.gap[i] - p;
    ssr += e * e;
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) meat[a][b] += e * e * z[a] * z[b];
  }
  const se = (q: number) => {
    let v = 0;
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) v += inv[q][a] * meat[a][b] * inv[b][q];
    return Math.sqrt(Math.max(v, 0));
  };
  let nextPred = full[0];
  const coef = feats.map((f, j) => {
    const nx = Number.isFinite(f.nextD1) ? f.nextD1 : 0;
    const contribution = full[j + 1] * nx;
    nextPred += contribution;
    return { ticker: f.ticker, beta: full[j + 1], t: full[j + 1] / se(j + 1), contribution, nextX: nx };
  });
  const li = n - 1;
  let lastPred = NaN;
  if (feats.every((f) => Number.isFinite(f.d1[li]))) {
    lastPred = full[0];
    feats.forEach((f, j) => { lastPred += full[j + 1] * f.d1[li]; });
  }
  return {
    tickers: feats.map((f) => f.ticker),
    coef,
    intercept: full[0],
    oosR2: sst > 0 ? 1 - sse / sst : NaN,
    oosN,
    residSd: Math.sqrt(ssr / Math.max(1, rows.length - k)),
    nextPred,
    lastTime: targets.times[li] ?? "",
    lastPred,
    lastActual: targets.gap[li],
    n: rows.length,
  };
}

// ───────────────────────── 時系列の詳細 ─────────────────────────

/** 過去 window 立会日のローリング相関（x の d1 と y）。 */
export function rollingCorr(
  times: string[],
  y: Float64Array,
  x: Float64Array,
  window = 250,
): { time: string; value: number }[] {
  const out: { time: string; value: number }[] = [];
  const n = times.length;
  for (let i = window; i < n; i += 1) {
    const r = corrOn(y, x, i - window, i);
    if (Number.isFinite(r) && i % 5 === 0) out.push({ time: times[i - 1], value: r });
  }
  return out;
}

export interface BigMoveRow {
  side: "up" | "down";
  horizon: LeadHorizon;
  n: number;
  mean: number;
  ci: number;
  /** 全日平均（比較の基準）。 */
  base: number;
}

/** X が大きく動いた（|z|>zTh、z は過去250日の標準偏差で基準化）日の、各ホライズンの平均。 */
export function bigMoves(T: JpTargets, x: Float64Array, zTh = 2): BigMoveRow[] {
  const n = T.times.length;
  const z = new Float64Array(n).fill(NaN);
  for (let i = 250; i < n; i++) {
    let s = 0, s2 = 0, m = 0;
    for (let j = i - 250; j < i; j++) {
      const v = x[j];
      if (Number.isFinite(v)) { s += v; s2 += v * v; m++; }
    }
    if (m < 120) continue;
    const sd = Math.sqrt(Math.max(s2 / m - (s / m) ** 2, 0));
    if (sd > 0 && Number.isFinite(x[i])) z[i] = x[i] / sd;
  }
  const rows: BigMoveRow[] = [];
  for (const side of ["up", "down"] as const) {
    for (const h of LEAD_HORIZONS) {
      const y = T[h];
      const v: number[] = [];
      let bs = 0, bn = 0;
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(y[i])) continue;
        bs += y[i]; bn++;
        if (side === "up" ? z[i] > zTh : z[i] < -zTh) v.push(y[i]);
      }
      const m = v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
      const sd = v.length > 2 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) : NaN;
      // f5 は5日重複するが、急変日は散発的なので重なりは小さい。CIは素朴な t 近似
      rows.push({ side, horizon: h, n: v.length, mean: m, ci: 1.96 * sd / Math.sqrt(Math.max(1, v.length)), base: bn ? bs / bn : NaN });
    }
  }
  return rows;
}
