// 前夜の米国株動向 → 翌日の日本株「日中足」への波及(スピルオーバー)分析の共通土台。
//
// 時差の要点: 米国正規セッションは日本時間の翌朝5〜6時に引ける。日本市場が9時に寄る時点で
// 「最後に確定している米国セッション」は、その暦日の直前(通常は前営業日)の米国立会日である。
// したがって日本の立会日 D に紐づく“前夜の米国”は「D より暦日が厳密に小さい最新の米国立会日」。
// 祝日・連休で複数日空いても、strictly-less の最新を採ることで自動的に正しい前夜へ整合する。
//
// リターンはすべて対数リターンで統一する(ギャップ+日中 = 当日 が厳密に加法になるため)。
//   米国 r_US   = ln(close_d / close_{d-1})            (前夜に判明している米国の値動き)
//   JP ギャップ = ln(open / prevClose)                 (休場中に開いた窓。ここで既に米国を織り込む)
//   JP 日中     = ln(close / open)                      (寄り後ザラ場。米国の“漏れ出し”を見る対象)
//   JP 当日     = ln(close / prevClose) = ギャップ + 日中
//
// このモジュールは数値計算のみ(UIなし)。各手法コンポーネントはここを起点に構築する。

import { PricePoint } from "./types";
import {
  DayData, BinGrid, binIndexOfMinute, localMinute,
} from "./intraday-core";
import { mean, quantileSorted } from "./stats-significance";

// ───────────────────────── 米国リターン系列 ─────────────────────────

export interface UsReturn {
  date: string; // 米国立会日 YYYY-MM-DD
  ret: number; // ln(close/prevClose) 前日終値比(オーバーナイト含む米国当日騰落)
  intra: number; // ln(close/open) 米国正規セッション内
}

// 米国日足から前日比・日中の対数リターンを算出する。
export function computeUsReturns(prices: PricePoint[]): UsReturn[] {
  const out: UsReturn[] = [];
  for (let i = 1; i < prices.length; i++) {
    const pc = prices[i - 1].close, c = prices[i].close, o = prices[i].open;
    if (!(pc > 0) || !(c > 0)) continue;
    out.push({ date: prices[i].time, ret: Math.log(c / pc), intra: o > 0 ? Math.log(c / o) : 0 });
  }
  return out;
}

// ───────────────────────── JP日中足 × 前夜米国 の整合 ─────────────────────────

export interface AlignedDay {
  jp: DayData; // 日本の日中足1営業日(intraday-core.groupByDay の要素)
  us: UsReturn; // 前夜に確定していた米国セッション
  gap: number; // JP 夜間ギャップ ln(open/prevClose)
  intra: number; // JP 日中 ln(close/open)
  full: number; // JP 当日 ln(close/prevClose) = gap + intra
}

// 各JP立会日に、その寄り前で最後に確定した米国立会日(暦日が厳密に小さい最新)を対応付ける。
// days・us とも日付昇順である前提(groupByDay / computeUsReturns の出力はソート済み)。
export function alignJpUs(days: DayData[], us: UsReturn[]): AlignedDay[] {
  const usSorted = [...us].sort((a, b) => a.date.localeCompare(b.date));
  const daysSorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const out: AlignedDay[] = [];
  let j = 0;
  for (const d of daysSorted) {
    while (j < usSorted.length && usSorted[j].date < d.date) j++;
    const idx = j - 1; // usSorted[j] は d.date 以上 → j-1 が「d より前の最新」
    if (idx < 0) continue;
    const u = usSorted[idx];
    const pc = d.prevClose, o = d.open, c = d.close;
    if (!(pc > 0) || !(o > 0) || !(c > 0)) continue;
    const gap = Math.log(o / pc), intra = Math.log(c / o);
    out.push({ jp: d, us: u, gap, intra, full: gap + intra });
  }
  return out;
}

// ───────────────────────── ビン化(米国リターンの層別) ─────────────────────────

export type BinScheme = "sign" | "tercile" | "quintile";

export interface BinMeta {
  scheme: BinScheme;
  count: number;
  labels: string[];
  colors: string[];
}

const BIN5_COLORS = ["#dc2626", "#fb923c", "#9ca3af", "#4ade80", "#16a34a"];
const BIN5_LABELS = ["米大幅安", "米安", "米中立", "米高", "米大幅高"];
const BIN3_COLORS = ["#dc2626", "#9ca3af", "#16a34a"];
const BIN3_LABELS = ["米安", "米中立", "米高"];
const SIGN_COLORS = ["#dc2626", "#16a34a"];
const SIGN_LABELS = ["米陰(下落)", "米陽(上昇)"];

export function binMeta(scheme: BinScheme): BinMeta {
  if (scheme === "sign") return { scheme, count: 2, labels: SIGN_LABELS, colors: SIGN_COLORS };
  if (scheme === "tercile") return { scheme, count: 3, labels: BIN3_LABELS, colors: BIN3_COLORS };
  return { scheme, count: 5, labels: BIN5_LABELS, colors: BIN5_COLORS };
}

// 値配列を指定スキームでビン番号(0..count-1)に割り当てる。
// sign: 符号のみ。tercile/quintile: 順位で均等分割(各ビンの標本数がほぼ等しくなる)。
export function assignBins(values: number[], scheme: BinScheme): number[] {
  if (scheme === "sign") return values.map((v) => (v >= 0 ? 1 : 0));
  const k = scheme === "tercile" ? 3 : 5;
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const bins = new Array(values.length).fill(0);
  const n = values.length;
  idx.forEach((o, rank) => {
    bins[o.i] = Math.min(k - 1, Math.floor((rank * k) / n));
  });
  return bins;
}

// ビン境界(内部しきい値)を返す。長さ = count-1。
// sign: [0]。tercile/quintile: assignBins と同じ順位均等分割の境界値(=各上位ビンの最小値)。
// これにより「新しい値(=今日の前夜米国)がどのビンに入るか」を閾値比較で判定できる。
export function binEdges(values: number[], scheme: BinScheme): number[] {
  if (scheme === "sign") return [0];
  const k = scheme === "tercile" ? 3 : 5;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return new Array(k - 1).fill(0);
  const edges: number[] = [];
  for (let b = 1; b < k; b++) {
    // assignBins: bin=floor(rank*k/n)。bin=b になる最小rankは ceil(b*n/k)。その値が境界。
    const rank = Math.min(n - 1, Math.ceil((b * n) / k));
    edges.push(sorted[rank]);
  }
  return edges;
}

// 単一の値が、与えた境界のもとで何番目のビンに入るか(0..count-1)。
// sign: v>=0 → 1。quantile: v が境界以上のものを数えたインデックス(境界値はその上位ビンに属す)。
export function binOfValue(v: number, scheme: BinScheme, edges: number[]): number {
  if (scheme === "sign") return v >= 0 ? 1 : 0;
  let b = 0;
  for (const e of edges) if (v >= e) b++;
  return b;
}

// ───────────────────────── 日内累積パス(共有時間格子) ─────────────────────────

// 1営業日のバー列を時間格子(BinGrid)に写像し、各ビン時点での終値を返す。
// バーの無いビンは直前値で前方補完。冒頭は寄り(day.open)を基準にする。
export function dayBinCloses(day: DayData, grid: BinGrid, gmtoffset: number): number[] {
  const closes = new Array(grid.bins.length).fill(NaN);
  for (const b of day.bars) {
    const m = localMinute(b.ts, gmtoffset);
    const bi = binIndexOfMinute(m, grid);
    closes[bi] = b.close; // バーは時刻昇順 → 各ビンは最後のバーが残る
  }
  let last = day.open;
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(closes[i])) closes[i] = last;
    else last = closes[i];
  }
  return closes;
}

// 寄り基準の累積対数リターン r(t) = ln(P_t / open) を時間格子上で返す。
export function dayCumPath(day: DayData, grid: BinGrid, gmtoffset: number): number[] {
  const o = day.open;
  if (!(o > 0)) return new Array(grid.bins.length).fill(0);
  return dayBinCloses(day, grid, gmtoffset).map((p) => (p > 0 ? Math.log(p / o) : 0));
}

// 各日を米国符号で向き付けした「前日終値基準の平均累積パス」M(t)。長さ T=G+1(index0=寄付=平均ギャップ)。
// F(t)=sign(r_US)·ln(P_t/prevClose) の日次平均。fraction=M(t)/M(引け) は消化の実現割合。
// computeAbsorption と UsDigestionBoundary が共有する中核プリミティブ。
export function orientedMeanPath(
  rows: AlignedDay[], grid: BinGrid, gmtoffset: number
): { path: number[]; fraction: number[] } {
  const G = grid.bins.length;
  const cum = rows.map((a) => dayCumPath(a.jp, grid, gmtoffset));
  const T = G + 1;
  const path = new Array(T).fill(0);
  for (let t = 0; t < T; t++) {
    const col = rows.map((a, d) => (a.us.ret >= 0 ? 1 : -1) * (t === 0 ? a.gap : a.gap + cum[d][t - 1]));
    path[t] = mean(col);
  }
  const end = path[T - 1];
  const fraction = path.map((v) => (Math.abs(end) > 1e-9 ? v / end : 0));
  return { path, fraction };
}

// ───────────────────────── 単回帰 y = α + β·x ─────────────────────────

export interface Regression {
  n: number;
  alpha: number;
  beta: number;
  r2: number;
  corr: number;
  seBeta: number;
  tBeta: number;
  pBeta: number; // β=0 の両側p値(t分布)
  meanX: number;
  meanY: number;
}

export function ols(x: number[], y: number[]): Regression | null {
  const n = Math.min(x.length, y.length);
  if (n < 5) return null;
  const mx = mean(x), my = mean(y);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  if (sxx <= 0) return null;
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  const corr = syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  // 残差分散から β の標準誤差
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const pred = alpha + beta * x[i];
    const e = y[i] - pred;
    sse += e * e;
  }
  const dof = n - 2;
  const sigma2 = dof > 0 ? sse / dof : 0;
  const seBeta = Math.sqrt(sigma2 / sxx);
  const tBeta = seBeta > 0 ? beta / seBeta : 0;
  const pBeta = dof > 0 ? studentTwoSidedP(tBeta, dof) : 1;
  return { n, alpha, beta, r2, corr, seBeta, tBeta, pBeta, meanX: mx, meanY: my };
}

// ───────────────────────── t分布の両側p値(自己完結) ─────────────────────────
// stats-significance.ts は1標本t検定しか公開していないため、回帰係数用に独立実装する。

function lnGamma(z: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnB = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnB) / a;
  let f = 1, c = 1, d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d; f = d;
  for (let i = 1; i <= 200; i++) {
    let num = (i * (b - i) * x) / ((a + 2 * i - 1) * (a + 2 * i));
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30; f *= d * c;
    num = (-(a + i) * (a + b + i) * x) / ((a + 2 * i) * (a + 2 * i + 1));
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    const delta = d * c; f *= delta;
    if (Math.abs(delta - 1) < 1e-10) break;
  }
  return front * f;
}

export function studentTwoSidedP(t: number, df: number): number {
  if (!isFinite(t) || df <= 0) return 1;
  const x = df / (df + t * t);
  return Math.min(1, incompleteBeta(df / 2, 0.5, x));
}

// ───────────────────────── 乱数・ブートストラップ ─────────────────────────

export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// 平均の95%ブート信頼区間 + 符号安定度(再標本平均が点推定と同符号だった割合)。
export function bootMeanCI(data: number[], B = 600, seed = 0x1234567): { lo: number; hi: number; stable: number } {
  const n = data.length;
  if (n < 3) { const m = mean(data); return { lo: m, hi: m, stable: 0.5 }; }
  const rng = mulberry32(seed);
  const sign = mean(data) >= 0 ? 1 : -1;
  const samples: number[] = [];
  let same = 0;
  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += data[Math.floor(rng() * n)];
    const m = sum / n;
    samples.push(m);
    if ((m >= 0 ? 1 : -1) === sign) same++;
  }
  samples.sort((a, b) => a - b);
  return { lo: quantileSorted(samples, 0.025), hi: quantileSorted(samples, 0.975), stable: same / B };
}

// 回帰係数βの95%ブート信頼区間(ペア・ブートストラップ)。
export function bootBetaCI(x: number[], y: number[], B = 500, seed = 0x2468ace): { lo: number; hi: number; stable: number } {
  const n = Math.min(x.length, y.length);
  const base = ols(x, y);
  if (!base || n < 8) return { lo: NaN, hi: NaN, stable: 0.5 };
  const rng = mulberry32(seed);
  const sign = base.beta >= 0 ? 1 : -1;
  const bs: number[] = [];
  let same = 0;
  const rx = new Array(n), ry = new Array(n);
  for (let b = 0; b < B; b++) {
    for (let i = 0; i < n; i++) { const k = Math.floor(rng() * n); rx[i] = x[k]; ry[i] = y[k]; }
    const r = ols(rx, ry);
    if (!r) continue;
    bs.push(r.beta);
    if ((r.beta >= 0 ? 1 : -1) === sign) same++;
  }
  bs.sort((a, b) => a - b);
  return { lo: quantileSorted(bs, 0.025), hi: quantileSorted(bs, 0.975), stable: bs.length ? same / bs.length : 0.5 };
}

// 相関係数(ピアソン)。
export function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const mx = mean(x), my = mean(y);
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}
