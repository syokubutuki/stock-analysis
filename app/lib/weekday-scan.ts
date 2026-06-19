// 曜日×注文タイミング(始値/終値)の全組合せから「統計的に意味のある好機」を選り分ける計算群。
//
// 2つの相補的なアプローチを提供する:
//   (A) 素片(atom)分解 — 1週間を最小リターン区間に割り、どこにエッジが宿るかを分解可視化する。
//   (B) 戦略スキャン   — 全エントリー→エグジット組合せを総当たりし、FDR多重比較補正・年次安定性・
//                        ブロックブートストラップCIで「データマイニングの偽陽性」を排除して順位付けする。
import { PricePoint } from "./types";
import {
  computeStrategy,
  type TradeSpec,
  type Timing,
  type Side,
} from "./weekday-trade";

// ============================================================
// 統計ユーティリティ(本ファイル内で自己完結)
// ============================================================
function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// 正則化不完全ベータ関数 I_x(a,b)。t分布の両側p値に使う。
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
function lnGamma(z: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
// 平均=0 という帰無仮説に対する1標本t検定の両側p値。
function tTestStat(arr: number[]): { t: number; p: number } | null {
  const n = arr.length;
  if (n < 3) return null;
  const se = std(arr) / Math.sqrt(n);
  if (se === 0) return null;
  const t = mean(arr) / se;
  const df = n - 1;
  const x = df / (df + t * t);
  const p = Math.min(incompleteBeta(df / 2, 0.5, x), 1);
  return { t, p };
}

// Benjamini-Hochberg法によるFDR(偽発見率)補正。生p値配列 → 補正済みp値配列(同順)。
export function benjaminiHochberg(pvals: number[]): number[] {
  const m = pvals.length;
  if (m === 0) return [];
  const order = pvals.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adj = new Array(m).fill(1);
  let prev = 1;
  // 大きい順位から min を累積して単調性を担保する
  for (let k = m - 1; k >= 0; k--) {
    const rank = k + 1;
    const val = Math.min(1, (order[k].p * m) / rank);
    prev = Math.min(prev, val);
    adj[order[k].i] = prev;
  }
  return adj;
}

// ============================================================
// (A) 素片(atom)分解
// ------------------------------------------------------------
// 1週間を「夜間(前営業日終値→当日始値)」「日中(当日始値→当日終値)」の対数リターンに分け、
// 曜日ごとに 月夜→月日中→火夜→…→金日中 の10素片として集計する。
// (月夜=週末ギャップを自然に含む。祝日にも頑健: 各素片を前営業日からの素朴な比で定義する)
// ============================================================
export interface AtomStat {
  key: string;                       // "1-overnight" など
  label: string;                     // "月夜" / "月日中"
  dow: number;                       // 1..5
  kind: "overnight" | "intraday";
  n: number;
  mean: number;                      // 平均 対数リターン
  std: number;
  se: number;                        // 標準誤差 = std/√n
  t: number | null;
  p: number | null;                  // 両側p値
}

const DOW_KANJI = ["", "月", "火", "水", "木", "金"];

// 素片×年: 各素片の年別平均リターン(エッジの持続/減衰を見る)
export interface AtomYearGrid {
  years: number[];                   // 昇順の年
  grid: (number | null)[][];         // grid[atomIdx][yearIdx] = その年その素片の平均(N<2はnull)
  maxAbs: number;                    // 色濃度の基準(全セル最大絶対値)
}

export interface AtomAnalysis {
  atoms: AtomStat[];                 // 長さ10、週内の時間順
  cumulative: number[];             // 長さ11、累積平均(0始まり)。週内クロック
  bestLong: { from: number; to: number; sum: number; spec: TradeSpec } | null;  // 最大部分和 → 買い好機窓
  bestShort: { from: number; to: number; sum: number; spec: TradeSpec } | null; // 最小部分和 → 売り好機窓
  yearly: AtomYearGrid;             // 素片×年ヒートマップ用
}

// 素片 index → TradeSpec の境界変換。
// 窓 [a..b] の入口=素片aの始端、出口=素片bの終端。
function atomBoundaryEntry(k: number): { dow: number; timing: Timing } {
  const dow = Math.floor(k / 2) + 1;
  const isOvernight = k % 2 === 0;
  if (isOvernight) {
    // 夜間の始端=前営業日の終値(月の前は金)
    const prevDow = dow === 1 ? 5 : dow - 1;
    return { dow: prevDow, timing: "close" };
  }
  return { dow, timing: "open" }; // 日中の始端=当日始値
}
function atomBoundaryExit(k: number): { dow: number; timing: Timing } {
  const dow = Math.floor(k / 2) + 1;
  const isOvernight = k % 2 === 0;
  if (isOvernight) return { dow, timing: "open" }; // 夜間の終端=当日始値
  return { dow, timing: "close" };                  // 日中の終端=当日終値
}
function windowToSpec(from: number, to: number, side: Side): TradeSpec {
  const e = atomBoundaryEntry(from);
  const x = atomBoundaryExit(to);
  return { entryDow: e.dow, entryTiming: e.timing, exitDow: x.dow, exitTiming: x.timing, side };
}

// 最大(符号+1)/最小(符号-1)の連続部分和をKadane法で求める。
function bestSubarray(means: number[], sign: 1 | -1): { from: number; to: number; sum: number } | null {
  let best = -Infinity, bestFrom = 0, bestTo = 0;
  let cur = 0, curFrom = 0;
  for (let i = 0; i < means.length; i++) {
    const v = sign * means[i];
    if (cur <= 0) { cur = v; curFrom = i; }
    else cur += v;
    if (cur > best) { best = cur; bestFrom = curFrom; bestTo = i; }
  }
  if (best <= 0) return null;
  return { from: bestFrom, to: bestTo, sum: sign * best };
}

export function analyzeAtoms(prices: PricePoint[]): AtomAnalysis {
  // 10素片のリターン配列(全期間 / 年別)
  const buckets: number[][] = Array.from({ length: 10 }, () => []);
  const byYear: Map<number, number[][]> = new Map(); // year → 10素片の配列
  for (let i = 1; i < prices.length; i++) {
    const p = prices[i], prev = prices[i - 1];
    const dt = new Date(p.time);
    const d = dt.getDay();
    if (d < 1 || d > 5) continue;
    const pc = prev.close, o = p.open, c = p.close;
    if (!(pc > 0) || !(o > 0) || !(c > 0)) continue;
    const on = Math.log(o / pc), id = Math.log(c / o);
    const k0 = (d - 1) * 2; // overnight
    buckets[k0].push(on);
    buckets[k0 + 1].push(id); // intraday
    const y = dt.getFullYear();
    let yb = byYear.get(y);
    if (!yb) { yb = Array.from({ length: 10 }, () => []); byYear.set(y, yb); }
    yb[k0].push(on);
    yb[k0 + 1].push(id);
  }
  const atoms: AtomStat[] = buckets.map((arr, k) => {
    const dow = Math.floor(k / 2) + 1;
    const kind: "overnight" | "intraday" = k % 2 === 0 ? "overnight" : "intraday";
    const m = mean(arr), s = std(arr), n = arr.length;
    const tt = tTestStat(arr);
    return {
      key: `${dow}-${kind}`,
      label: `${DOW_KANJI[dow]}${kind === "overnight" ? "夜" : "日中"}`,
      dow, kind, n, mean: m, std: s,
      se: n > 0 ? s / Math.sqrt(n) : 0,
      t: tt ? tt.t : null,
      p: tt ? tt.p : null,
    };
  });
  const means = atoms.map((a) => a.mean);
  const cumulative = [0];
  for (let i = 0; i < means.length; i++) cumulative.push(cumulative[i] + means[i]);

  const maxSub = bestSubarray(means, 1);
  const minSub = bestSubarray(means, -1);

  // 素片×年グリッド
  const years = Array.from(byYear.keys()).sort((a, b) => a - b);
  const grid: (number | null)[][] = Array.from({ length: 10 }, () => []);
  let yMaxAbs = 0;
  for (let k = 0; k < 10; k++) {
    for (const y of years) {
      const arr = byYear.get(y)![k];
      if (arr.length < 2) { grid[k].push(null); continue; }
      const m = mean(arr);
      grid[k].push(m);
      yMaxAbs = Math.max(yMaxAbs, Math.abs(m));
    }
  }
  const yearly: AtomYearGrid = { years, grid, maxAbs: yMaxAbs };

  return {
    atoms,
    cumulative,
    yearly,
    bestLong: maxSub ? { ...maxSub, spec: windowToSpec(maxSub.from, maxSub.to, "long") } : null,
    bestShort: minSub ? { ...minSub, spec: windowToSpec(minSub.from, minSub.to, "short") } : null,
  };
}

// ============================================================
// (B) 戦略スキャン(全組合せ総当たり + 統計的選別)
// ============================================================
export interface SpecStat {
  spec: TradeSpec;          // 推奨方向(平均の符号)を反映した最終スペック
  label: string;
  n: number;
  direction: Side;          // 推奨方向
  meanTrade: number;        // 方向調整後の1トレード平均リターン
  annualized: number;       // 方向調整後の年率
  sharpe: number;           // 方向調整後(|·|)
  exposure: number;
  maxDD: number;
  t: number;                // |t|(方向に依らない)
  p: number;                // 両側生p値
  pAdj: number;             // BH補正後p値
  yearsPositive: number;    // 方向調整後リターンが正だった年の割合(0..1)
  nYears: number;
  halfAgree: boolean;       // 前半・後半とも全体と同符号か
  ciLo: number | null;      // ブロックブートストラップ95%CI(1トレード平均, 方向調整後)
  ciHi: number | null;
  ciStable: number | null;  // 点推定と同符号だったブートストラップ標本の割合(0..1)
}

export type ScanSort = "pAdj" | "absT" | "annualized" | "sharpe";

export interface ScanResult {
  stats: SpecStat[];        // ソート済み
  nTested: number;          // 検定にかけた組合せ数(FDRの母数)
  minTrades: number;
}

const TIMINGS: Timing[] = ["open", "close"];
const DOWS = [1, 2, 3, 4, 5];
const TIMING_KANJI: Record<Timing, string> = { open: "始", close: "終" };

function specLabel(s: TradeSpec): string {
  return `${DOW_KANJI[s.entryDow]}${TIMING_KANJI[s.entryTiming]}→${DOW_KANJI[s.exitDow]}${TIMING_KANJI[s.exitTiming]}`;
}

// 移動ブロック・ブートストラップで1トレード平均の95%CIを推定する。
// 系列相関に頑健: ブロック長 L ≈ n^(1/3) で連続するトレードを束ねて再標本化する。
function blockBootstrapMean(rets: number[], B: number): { lo: number; hi: number; stable: number } | null {
  const n = rets.length;
  if (n < 5) return null;
  const L = Math.max(1, Math.round(Math.cbrt(n)));
  const nBlocks = Math.ceil(n / L);
  const pointSign = mean(rets) >= 0 ? 1 : -1;
  const samples: number[] = [];
  let sameSign = 0;
  for (let b = 0; b < B; b++) {
    let sum = 0, cnt = 0;
    for (let blk = 0; blk < nBlocks && cnt < n; blk++) {
      const start = Math.floor(Math.random() * n);
      for (let j = 0; j < L && cnt < n; j++) {
        sum += rets[(start + j) % n];
        cnt++;
      }
    }
    const m = sum / cnt;
    samples.push(m);
    if ((m >= 0 ? 1 : -1) === pointSign) sameSign++;
  }
  samples.sort((a, b) => a - b);
  return { lo: quantileSorted(samples, 0.025), hi: quantileSorted(samples, 0.975), stable: sameSign / B };
}

export interface ScanOptions {
  compound?: boolean;
  minTrades?: number;
  bootstrapB?: number;
  bootstrapTopN?: number;  // |t|上位この件数だけCIを計算(重いので限定)
  sort?: ScanSort;
}

export function scanWeekdayEdges(prices: PricePoint[], opts: ScanOptions = {}): ScanResult {
  const compound = opts.compound ?? true;
  const minTrades = opts.minTrades ?? 12;
  const bootstrapB = opts.bootstrapB ?? 800;
  const bootstrapTopN = opts.bootstrapTopN ?? 40;
  const sort: ScanSort = opts.sort ?? "pAdj";

  interface Raw {
    base: TradeSpec;        // long基準スペック
    rets: number[];         // long基準の1トレードリターン列
    exitYears: number[];    // 各トレードの出口年
    t: number;
    p: number;
  }
  const raws: Raw[] = [];

  for (const eDow of DOWS) for (const eT of TIMINGS) {
    for (const xDow of DOWS) for (const xT of TIMINGS) {
      const base: TradeSpec = { entryDow: eDow, entryTiming: eT, exitDow: xDow, exitTiming: xT, side: "long" };
      const res = computeStrategy(prices, base, compound);
      if (res.nTrades < minTrades) continue;
      const rets = res.trades.map((t) => t.ret);
      const tt = tTestStat(rets);
      if (!tt) continue;
      const exitYears = res.trades.map((t) => new Date(t.exitT).getFullYear());
      raws.push({ base, rets, exitYears, t: tt.t, p: tt.p });
    }
  }

  const pvals = raws.map((r) => r.p);
  const pAdj = benjaminiHochberg(pvals);

  // |t|上位は後でブートストラップにかけるため、補正後に並べてindexを把握
  const tOrder = raws
    .map((_, i) => i)
    .sort((a, b) => Math.abs(raws[b].t) - Math.abs(raws[a].t));
  const bootSet = new Set(tOrder.slice(0, bootstrapTopN));

  const stats: SpecStat[] = raws.map((r, i) => {
    const direction: Side = mean(r.rets) >= 0 ? "long" : "short";
    const sign = direction === "long" ? 1 : -1;
    const adjRets = sign === 1 ? r.rets : r.rets.map((v) => -v);
    const finalSpec: TradeSpec = { ...r.base, side: direction };
    const fres = computeStrategy(prices, finalSpec, compound);

    // 年次安定性
    const byYear: Record<number, number[]> = {};
    for (let k = 0; k < adjRets.length; k++) {
      (byYear[r.exitYears[k]] ||= []).push(adjRets[k]);
    }
    const yearMeans = Object.values(byYear).map((a) => mean(a));
    const nYears = yearMeans.length;
    const yearsPositive = nYears ? yearMeans.filter((v) => v > 0).length / nYears : 0;
    const half = Math.floor(adjRets.length / 2);
    const m1 = mean(adjRets.slice(0, half));
    const m2 = mean(adjRets.slice(half));
    const halfAgree = m1 > 0 && m2 > 0;

    let ciLo: number | null = null, ciHi: number | null = null, ciStable: number | null = null;
    if (bootSet.has(i)) {
      const ci = blockBootstrapMean(adjRets, bootstrapB);
      if (ci) { ciLo = ci.lo; ciHi = ci.hi; ciStable = ci.stable; }
    }

    return {
      spec: finalSpec,
      label: specLabel(finalSpec),
      n: r.rets.length,
      direction,
      meanTrade: mean(adjRets),
      annualized: sign * fres.annualized,
      sharpe: Math.abs(fres.sharpe),
      exposure: fres.exposure,
      maxDD: fres.maxDD,
      t: Math.abs(r.t),
      p: r.p,
      pAdj: pAdj[i],
      yearsPositive,
      nYears,
      halfAgree,
      ciLo, ciHi, ciStable,
    };
  });

  const cmp: Record<ScanSort, (a: SpecStat, b: SpecStat) => number> = {
    pAdj: (a, b) => a.pAdj - b.pAdj || b.t - a.t,
    absT: (a, b) => b.t - a.t,
    annualized: (a, b) => Math.abs(b.annualized) - Math.abs(a.annualized),
    sharpe: (a, b) => b.sharpe - a.sharpe,
  };
  stats.sort(cmp[sort]);

  return { stats, nTested: raws.length, minTrades };
}
