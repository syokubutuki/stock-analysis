// ストレス退避規則の頑健性（偶然との比較）。`docs/derisk-rule-design.md` §2.7。
// 研究 `research/bank-derisk/r14_robust.py` の (1) ランダム配置ヌルと (3) 定常ブロックブートストラップを写す。
//
// 問い: 規則が選んだ「現金でいる期間」は、同じ本数・同じ長さの期間を偶然の位置に置いたときより良いか。
//       そして「ルール − 買い持ち」の差は、日次リターンを並べ替え直しても符号が保たれるか。
//
// (1) ランダム配置ヌル
//     実際の現金化エピソードの長さの列を、重ならず隣接もしないように（Python の
//     `w[max(0,s-1):s+L+1].min()==1` 判定）ランダムな位置に逐次配置する。各エピソードは 30 回まで
//     位置を引き直し、どれかが置けなければ全体を最初から最大 50 回やり直す。
//     得た建玉で純リターン（同じ片道コスト）を作り、年率・最大DD・Sharpe の分布を得る。
//     `P(偶然 ≥ 実際)` が小さいほど「位置に意味がある」。最大DD は「偶然の方が浅い」割合。
// (2) 定常ブロックブートストラップ（Politis–Romano）
//     ブロック長を幾何分布（平均 blockLen）で引き、開始点を一様に引いて循環的に貼る。
//     純リターンと買い持ちリターンを**同じ添字**で再標本化し、差（ルール − 買い持ち）の分布を得る。
//     建玉そのものは再標本化しない（規則の経路依存を壊さず、日次リターンの並びだけを揺らす）。
//
// 乱数は mulberry32 でシード固定。numpy の乱数列とは一致しないので、研究の数字とは
// **分位の向きと桁**だけを照合する（§4.3、`research/bank-derisk/check-lib.mts`）。
//
// 純粋関数。Worker（`derisk-rule.worker.ts`）とテストから呼ぶ。

import { computeMetrics, netReturns, type DeriskMetrics } from "./derisk-rule";

// ───────────────────────── 乱数 ─────────────────────────

/** mulberry32。同じ seed からは常に同じ列が出る（アプリ他所と同じ実装）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 0 以上 n 未満の整数（numpy の `integers(0, n)` と同じ範囲）。 */
export function randInt(rand: () => number, n: number): number {
  return Math.min(n - 1, Math.floor(rand() * n));
}

/** 幾何分布（numpy の `geometric(p)`: 台は 1,2,…、P(k) = (1−p)^(k−1)·p、平均 1/p）。逆関数法。 */
export function geometric(rand: () => number, p: number): number {
  const u = rand();
  const k = Math.ceil(Math.log(1 - u) / Math.log(1 - p));
  return k < 1 || !Number.isFinite(k) ? 1 : k;
}

/** numpy `percentile` の既定（線形補間）。`sorted` は昇順。 */
export function percentile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const pos = (q / 100) * (n - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ───────────────────────── (1) ランダム配置ヌル ─────────────────────────

/** 建玉列から現金（w<0.5）の連続区間の長さを順に返す（Python `episodes(w)`）。 */
export function episodeLengths(w: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < w.length; ) {
    if (w[i] >= 0.5) { i++; continue; }
    let j = i;
    while (j < w.length && w[j] < 0.5) j++;
    out.push(j - i);
    i = j;
  }
  return out;
}

/**
 * 長さ `lens` の現金区間を、重ならず隣接もしないように偶然の位置へ置いた建玉列（Python `random_w`）。
 * 長さの順序は毎回シャッフルする。置けなければ `ok=false`（その時点の w を返す。研究と同じ扱い）。
 */
export function randomPlacement(n: number, lens: readonly number[], rand: () => number): { w: Float64Array; ok: boolean } {
  // Fisher–Yates（numpy の permutation に相当。列は一致しないが分布は同じ）
  const order = lens.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = randInt(rand, i + 1);
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  let w = new Float64Array(n).fill(1);
  for (let attempt = 0; attempt < 50; attempt++) {
    w = new Float64Array(n).fill(1);
    let ok = true;
    for (const L of order) {
      if (L >= n) { ok = false; break; }
      let placed = false;
      for (let t = 0; t < 30; t++) {
        const s = randInt(rand, n - L);
        let free = true;
        for (let k = Math.max(0, s - 1); k < Math.min(n, s + L + 1); k++) if (w[k] !== 1) { free = false; break; }
        if (free) { w.fill(0, s, s + L); placed = true; break; }
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return { w, ok: true };
  }
  return { w, ok: false };
}

// ───────────────────────── (2) 定常ブロックブートストラップ ─────────────────────────

/** 長さ N の再標本化添字（Python `sb(N, L)`）。ブロック長は幾何分布（平均 L）、開始点は一様、末尾は循環。 */
export function stationaryBootstrapIndex(N: number, L: number, rand: () => number): Int32Array {
  const idx = new Int32Array(N);
  let i = 0;
  while (i < N) {
    const s = randInt(rand, N);
    let l = geometric(rand, 1 / L);
    l = Math.min(l, N - i);
    for (let k = 0; k < l; k++) idx[i + k] = (s + k) % N;
    i += l;
  }
  return idx;
}

// ───────────────────────── まとめ ─────────────────────────

export type RobustKey = "cagr" | "maxDrawdown" | "sharpe";
export const ROBUST_KEYS: readonly RobustKey[] = ["cagr", "maxDrawdown", "sharpe"];
export const ROBUST_LABELS: Record<RobustKey, string> = { cagr: "年率", maxDrawdown: "最大DD", sharpe: "Sharpe" };

export interface NullSummary {
  key: RobustKey;
  actual: number;
  p5: number;
  p50: number;
  p95: number;
  /** P(偶然 ≥ 実際)。最大DD は負値なので「偶然の方が浅いか等しい」割合になる */
  pGe: number;
}

export interface BootSummary {
  key: RobustKey;
  /** 差（ルール − 買い持ち）。最大DD は正＝浅い */
  median: number;
  lo5: number;
  hi95: number;
  pPositive: number;
}

export interface RobustInput {
  /** 評価行の買い持ち対数リターン（寄り→翌寄り） */
  y: ArrayLike<number>;
  /** 評価行の建玉（1=保有・0=現金） */
  w: ArrayLike<number>;
  costOneWay: number;
  /** ランダム配置ヌルの回数（既定 1000） */
  nNull?: number;
  /** ブートストラップの回数（既定 2000） */
  nBoot?: number;
  /** 平均ブロック長（既定 20 営業日） */
  blockLen?: number;
  seed?: number;
}

export interface RobustResult {
  nEval: number;
  episodeLengths: number[];
  nNull: number;
  nBoot: number;
  blockLen: number;
  seed: number;
  actual: { rule: DeriskMetrics; buyHold: DeriskMetrics };
  null: NullSummary[];
  /** 配置に失敗した試行数（50 回やり直しても置けなかった回数。研究と同じく結果には含める） */
  nullPlacementFailed: number;
  boot: BootSummary[];
}

const pick = (m: DeriskMetrics, k: RobustKey): number => m[k];

export function computeRobustness(input: RobustInput): RobustResult | null {
  const n = input.y.length;
  if (n < 60 || input.w.length !== n) return null;
  const nNull = input.nNull ?? 1000;
  const nBoot = input.nBoot ?? 2000;
  const blockLen = input.blockLen ?? 20;
  const seed = input.seed ?? 20261023;
  const rand = mulberry32(seed);

  const y = Float64Array.from({ length: n }, (_, i) => input.y[i]);
  const w = Float64Array.from({ length: n }, (_, i) => input.w[i]);
  const ones = new Float64Array(n).fill(1);
  const net = netReturns(w, y, input.costOneWay);
  const rule = computeMetrics(net, w);
  const buyHold = computeMetrics(y, ones);
  const actual = { rule, buyHold };

  // (1) ランダム配置ヌル
  const lens = episodeLengths(w);
  const dist: Record<RobustKey, Float64Array> = {
    cagr: new Float64Array(nNull), maxDrawdown: new Float64Array(nNull), sharpe: new Float64Array(nNull),
  };
  let nullPlacementFailed = 0;
  for (let s = 0; s < nNull; s++) {
    const r = randomPlacement(n, lens, rand);
    if (!r.ok) nullPlacementFailed++;
    const m = computeMetrics(netReturns(r.w, y, input.costOneWay), r.w);
    for (const k of ROBUST_KEYS) dist[k][s] = pick(m, k);
  }
  const nullSummary: NullSummary[] = ROBUST_KEYS.map((k) => {
    const a = pick(rule, k);
    const sorted = Float64Array.from(dist[k]).sort();
    let ge = 0;
    for (let s = 0; s < nNull; s++) if (dist[k][s] >= a) ge++;
    return { key: k, actual: a, p5: percentile(sorted, 5), p50: percentile(sorted, 50), p95: percentile(sorted, 95), pGe: nNull > 0 ? ge / nNull : NaN };
  });

  // (2) 定常ブロックブートストラップ（差）
  const diff: Record<RobustKey, Float64Array> = {
    cagr: new Float64Array(nBoot), maxDrawdown: new Float64Array(nBoot), sharpe: new Float64Array(nBoot),
  };
  const nb = new Float64Array(n), yb = new Float64Array(n);
  for (let b = 0; b < nBoot; b++) {
    const ix = stationaryBootstrapIndex(n, blockLen, rand);
    for (let i = 0; i < n; i++) { nb[i] = net[ix[i]]; yb[i] = y[ix[i]]; }
    const mr = computeMetrics(nb, ones), mh = computeMetrics(yb, ones);
    for (const k of ROBUST_KEYS) diff[k][b] = pick(mr, k) - pick(mh, k);
  }
  const bootSummary: BootSummary[] = ROBUST_KEYS.map((k) => {
    const sorted = Float64Array.from(diff[k]).sort();
    let pos = 0;
    for (let b = 0; b < nBoot; b++) if (diff[k][b] > 0) pos++;
    return { key: k, median: percentile(sorted, 50), lo5: percentile(sorted, 5), hi95: percentile(sorted, 95), pPositive: nBoot > 0 ? pos / nBoot : NaN };
  });

  return {
    nEval: n, episodeLengths: lens, nNull, nBoot, blockLen, seed, actual,
    null: nullSummary, nullPlacementFailed, boot: bootSummary,
  };
}
