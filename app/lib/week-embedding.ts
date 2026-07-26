// 週内Embedding(週の関数PCA / 固有週アトラス)。
//
// 目的: 「週」という対象を1本のベクトルにして低次元座標へ写し、過去の全週を1枚の地図(点群)にする。
// これは weekly-analog.ts の「局所・クエリ時最近傍法(今週に似た過去週を引く)」とは根本的に問いが違う。
// Embedding が答えるのは最近傍法が原理的に出せない3つ:
//   ① 大域構造(アトラス): そもそもどんな週の型が存在するか。母集団の地形。
//   ② 座標系そのもの: 固有週(eigen-week)= 週の形の直交基底(PC1≈週ドリフト, PC2≈月重心vs金重心, PC3≈曲率)。
//   ③ 形空間全体での結果の構造: 局所ではなく大域で「形→翌週リターン」に系統性があるか。
//
// 正直さの門番(このプロジェクトの null-calibration の精神):
//   Embedding は最強の偽パターン製造機(UMAP/t-SNE はノイズからでもクラスタを作る)。だから
//   主役は PCA 一択(線形・距離保存・軸が意味を持つ)。そして2つの主張を峻別する:
//     (a) 「形空間に構造がある」= 自明に真・無価値(形は自己相関する)。
//     (b) 「翌週リターンが形空間上に構造を持つ」= 唯一トレード可能・要ヌル検定＆OOS。
//   本モジュールは (b) を kNN-IC 統計 + ブロック順列ヌル + 学習/検証分割OOS で厳密に検定する。
//
// 特徴ベクトル(2系統を並べて比較):
//   level(水準あり): 前週末終値を0%とした週内累積対数リターン経路を5点に再標本化。週の方向(ドリフト)を含む。
//   shape(形状のみ): level を z化(平均・スケールを除去)。V字/Λ字/月重心などの純粋な形だけを残す。

import { PricePoint } from "./types";

export type EmbedVariant = "level" | "shape";

export interface EigenWeek {
  loading: number[]; // 5次元。固有週の「形」(経路空間の直交方向)
  explained: number; // 説明分散比(0..1)
}

export interface WeekPoint {
  weekKey: string; // その週の月曜(YYYY-MM-DD)
  startTime: string;
  endTime: string;
  path: number[]; // 5点。level系: 前週末=0%の累積%(表示用, ×100前)
  score: number[]; // PC座標(PC1,PC2,PC3...)。アトラスは score[0]×score[1]
  nextRet: number | null; // 翌週リターン(前向き結果, log)。最終週は null
  eraFrac: number; // 0(最古)..1(最新)。年代着色用
}

export interface EmbeddingView {
  variant: EmbedVariant;
  eigen: EigenWeek[]; // 上位(最大5)
  points: WeekPoint[]; // nextRet を持つ週のみ(検定対象)+ 最終週も座標のみ含む
  colMean: number[]; // 列平均(射影の中心)
  // ── ③(b) In-sample: 形空間で翌週リターンが予測できるか ──
  ic: number; // kNN-mean 予測と実測 nextRet の相関(2Dアトラス上)
  icNullMean: number; icNullSd: number; icP: number; // ブロック順列ヌルでの p
  // ── OOS: 学習期の基底で張った地図が、検証期の未来を予測するか ──
  oosIc: number; oosHit: number; oosP: number; // 検証IC・方向的中率・順列p
  nTrain: number; nTest: number;
  kNN: number; // 使用近傍数
}

export interface WeekEmbeddingResult {
  level: EmbeddingView;
  shape: EmbeddingView;
  nWeeks: number; // 特徴化できた週数
  nGrid: number; // 5(再標本化グリッド点数)
  currentPartial: { path: number[]; elapsed: number; startTime: string } | null; // 進行中の今週
  recentIdx: number[]; // 直近週(時系列軌跡用)の points 内インデックス列(古→新)
}

export interface WeekEmbeddingParams {
  prices: PricePoint[];
  kNN?: number; // 近傍数(既定: round(sqrt(n)) を 10..40 に丸め)
  trainFrac?: number; // OOS 学習期割合(既定 0.7)
  nPerm?: number; // 順列回数(既定 600)
  blockWeeks?: number; // 順列のブロック長(既定 4)。翌週リターンの系列相関を保存
  recentN?: number; // 時系列軌跡に描く直近週数(既定 12)
  seed?: number;
}

const NGRID = 5;

// ───────────────────────── 数値ユーティリティ ─────────────────────────

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const ma = mean(a), mb = mean(b);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = a[i] - ma, dy = b[i] - mb; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const den = Math.sqrt(sxx * syy);
  return den > 1e-15 ? sxy / den : 0;
}

// 対称行列の上位 r 固有ペア(べき乗法+デフレーション)。ssa.ts の powerIterationEigen と同型。
function symEig(C: number[][], m: number, r: number): { vals: number[]; vecs: number[][] } {
  const vecs: number[][] = [], vals: number[] = [];
  const W = C.map((row) => [...row]);
  for (let mode = 0; mode < r; mode++) {
    let v = new Array(m).fill(0).map((_, i) => Math.sin(i * 0.7 + mode * 1.3));
    let nrm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
    v = v.map((x) => x / (nrm || 1));
    for (let it = 0; it < 200; it++) {
      const w = new Array(m).fill(0);
      for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) w[i] += W[i][j] * v[j];
      nrm = Math.sqrt(w.reduce((a, b) => a + b * b, 0));
      if (nrm < 1e-15) break;
      const vn = w.map((x) => x / nrm);
      let diff = 0; for (let i = 0; i < m; i++) diff += (vn[i] - v[i]) ** 2;
      v = vn;
      if (diff < 1e-13) break;
    }
    let ev = 0;
    for (let i = 0; i < m; i++) { let s = 0; for (let j = 0; j < m; j++) s += W[i][j] * v[j]; ev += v[i] * s; }
    vals.push(Math.max(ev, 0));
    vecs.push(v);
    for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) W[i][j] -= ev * v[i] * v[j];
  }
  return { vals, vecs };
}

// ───────────────────────── 週の切り出しと特徴化 ─────────────────────────

// その日が属する週の月曜(YYYY-MM-DD)。UTC基準(weekly-analog と同じ)。
function weekKey(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateStr;
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return d.toISOString().slice(0, 10);
}

interface RawWeek { key: string; idxs: number[]; }

// 立会日を週(月曜起点)ごとに、暦順・連続で束ねる。
function groupWeeks(prices: PricePoint[]): RawWeek[] {
  const g = new Map<string, number[]>();
  const order: string[] = [];
  for (let i = 0; i < prices.length; i++) {
    const k = weekKey(prices[i].time);
    let a = g.get(k);
    if (!a) { a = []; g.set(k, a); order.push(k); }
    a.push(i);
  }
  return order.map((k) => ({ key: k, idxs: g.get(k)! }));
}

// 週内累積対数リターン経路を 5点グリッドへ線形再標本化。base=前週末終値(週初日の直前の立会日終値)。
// m日(4..6)の各日終値 c_j に対し g_j=log(c_j/base)。原座標 x=[0..1] を等間隔5点へ内挿。
function resamplePath(prices: PricePoint[], idxs: number[], baseIdx: number): number[] | null {
  const m = idxs.length;
  if (m < 4 || m > 6) return null;
  const base = prices[baseIdx]?.close;
  if (!(base > 0)) return null;
  const g: number[] = [];
  for (const i of idxs) {
    const c = prices[i].close;
    if (!(c > 0)) return null;
    g.push(Math.log(c / base));
  }
  // 原座標 x_orig[j] = j/(m-1) ∈ [0,1] を x_tgt[k]=k/(NGRID-1) へ線形内挿
  const out: number[] = [];
  for (let k = 0; k < NGRID; k++) {
    const xt = k / (NGRID - 1);
    const pos = xt * (m - 1);
    const lo = Math.floor(pos), hi = Math.min(m - 1, lo + 1);
    const frac = pos - lo;
    out.push(g[lo] + (g[hi] - g[lo]) * frac);
  }
  return out;
}

// z化(平均・スケール除去)。形状のみ抽出。定数経路(sd=0)は0ベクトル。
function zShape(v: number[]): number[] {
  const m = mean(v);
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length) || 1;
  return v.map((x) => (x - m) / sd);
}

// ───────────────────────── PCA(関数PCA) ─────────────────────────

interface PcaOut {
  colMean: number[];
  eigen: EigenWeek[];
  scores: number[][]; // n × k
}

// 特徴行列 X(n×d)を列中心化して共分散の固有分解。上位 k の固有週(loading)とスコアを返す。
// 符号は「loading の総和>=0」に固定(level: 上げ方向を正)。
function functionalPca(X: number[][], k: number): PcaOut {
  const n = X.length, d = X[0].length;
  const colMean = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) colMean[j] += row[j];
  for (let j = 0; j < d; j++) colMean[j] /= n;
  const Xc = X.map((row) => row.map((v, j) => v - colMean[j]));
  const C = Array.from({ length: d }, () => new Array(d).fill(0));
  for (const row of Xc) for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] += row[i] * row[j];
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] /= (n - 1);
  const totVar = C.reduce((s, row, i) => s + row[i], 0) || 1;
  const { vals, vecs } = symEig(C, d, Math.min(k, d));
  const eigen: EigenWeek[] = vecs.map((v, m) => {
    const sgn = v.reduce((s, x) => s + x, 0) >= 0 ? 1 : -1;
    return { loading: v.map((x) => x * sgn), explained: vals[m] / totVar };
  });
  const scores = Xc.map((row) =>
    eigen.map((e) => row.reduce((s, v, j) => s + v * e.loading[j], 0))
  );
  return { colMean, eigen, scores };
}

// 学習済み基底(colMean, eigen)へ任意の特徴ベクトルを射影。
function projectScore(x: number[], colMean: number[], eigen: EigenWeek[]): number[] {
  const xc = x.map((v, j) => v - colMean[j]);
  return eigen.map((e) => xc.reduce((s, v, j) => s + v * e.loading[j], 0));
}

// ───────────────────────── kNN-IC(形空間で翌週リターンが予測できるか) ─────────────────────────

// 近傍表: 各クエリ週の k近傍(参照集合内)のインデックス列。
// 重要: 近傍関係は coords/queryIdx/refIdx/k だけで決まり、y(翌週リターン)には依存しない。
// 順列検定は y をシャッフルするだけなので、近傍表は一度作れば全順列で使い回せる。
// (旧実装は順列ごとに距離行列を再構築+再ソートしており、10年データで約57秒かかっていた)
interface NeighborTable {
  queries: number[]; // 実際に予測できたクエリ(参照数 < k の点は除外済み)
  nbr: Int32Array; // queries[q] の近傍 = nbr[q*k .. q*k+k-1]
  k: number;
}

// 2Dアトラス座標(coords)上で、各クエリ点の k近傍(自己除外)を距離順に求める。
function buildNeighbors(
  coords: number[][], k: number, queryIdx: number[], refIdx: number[]
): NeighborTable {
  const queries: number[] = [];
  const flat: number[] = [];
  const dists: { d: number; ri: number }[] = [];
  for (const qi of queryIdx) {
    dists.length = 0;
    const qx = coords[qi][0], qy = coords[qi][1];
    for (const ri of refIdx) {
      if (ri === qi) continue;
      const dx = qx - coords[ri][0], dy = qy - coords[ri][1];
      dists.push({ d: dx * dx + dy * dy, ri });
    }
    if (dists.length < k) continue;
    dists.sort((a, b) => a.d - b.d); // 同距離は refIdx 順(V8のsortは安定)
    queries.push(qi);
    for (let j = 0; j < k; j++) flat.push(dists[j].ri);
  }
  return { queries, nbr: Int32Array.from(flat), k };
}

// 近傍表を使って kNN平均予測 ŷ と実測 y の相関(IC)・方向的中率を求める。y だけが可変。
function icFromNeighbors(
  nt: NeighborTable, y: number[]
): { ic: number; hit: number; pred: number[]; act: number[] } {
  const { queries, nbr, k } = nt;
  const m = queries.length;
  const pred = new Array<number>(m), act = new Array<number>(m);
  for (let q = 0; q < m; q++) {
    const off = q * k;
    let s = 0;
    for (let j = 0; j < k; j++) s += y[nbr[off + j]];
    pred[q] = s / k;
    act[q] = y[queries[q]];
  }
  const ic = pearson(pred, act);
  let hit = 0, hn = 0;
  for (let i = 0; i < m; i++) {
    if (Math.abs(pred[i]) < 1e-12) continue;
    hn++;
    if (Math.sign(pred[i]) === Math.sign(act[i])) hit++;
  }
  return { ic, hit: hn ? hit / hn : 0, pred, act };
}

// ブロック順列: nextRet をブロック長 bw の連続塊ごとにシャッフルして系列相関を保存。
function blockPermute(y: number[], bw: number, rng: () => number): number[] {
  const n = y.length;
  const nb = Math.ceil(n / bw);
  const blocks: number[][] = [];
  for (let b = 0; b < nb; b++) blocks.push(y.slice(b * bw, Math.min(n, (b + 1) * bw)));
  for (let i = blocks.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = blocks[i]; blocks[i] = blocks[j]; blocks[j] = t; }
  return blocks.flat();
}

// ───────────────────────── ビュー構築 ─────────────────────────

function buildView(
  variant: EmbedVariant,
  feats: number[][], // n × 5(level or shape 済み)
  metas: { weekKey: string; startTime: string; endTime: string; pathPct: number[] }[],
  nextRet: (number | null)[],
  kNN: number, trainFrac: number, nPerm: number, blockWeeks: number, seed: number
): EmbeddingView {
  const n = feats.length;
  const pca = functionalPca(feats, 5);

  const points: WeekPoint[] = metas.map((mm, i) => ({
    weekKey: mm.weekKey, startTime: mm.startTime, endTime: mm.endTime,
    path: mm.pathPct, score: pca.scores[i], nextRet: nextRet[i],
    eraFrac: n > 1 ? i / (n - 1) : 1,
  }));

  // 検定対象 = nextRet を持つ週
  const validIdx: number[] = [];
  for (let i = 0; i < n; i++) if (nextRet[i] != null && isFinite(nextRet[i] as number)) validIdx.push(i);
  const coords = pca.scores.map((s) => [s[0] ?? 0, s[1] ?? 0]);
  const y = nextRet.map((v) => (v == null ? 0 : v));

  // ── In-sample IC + ブロック順列ヌル(近傍表は順列不変なので1回だけ構築) ──
  const ntIn = buildNeighbors(coords, kNN, validIdx, validIdx);
  const insample = icFromNeighbors(ntIn, y);
  const rng = mulberry32(seed);
  let nullSum = 0, nullSumSq = 0, ge = 0;
  const yValid = validIdx.map((i) => y[i]);
  const ymap = y.slice();
  for (let p = 0; p < nPerm; p++) {
    const yperm = blockPermute(yValid, blockWeeks, rng);
    validIdx.forEach((idx, k) => { ymap[idx] = yperm[k]; });
    const r = icFromNeighbors(ntIn, ymap);
    nullSum += r.ic; nullSumSq += r.ic * r.ic;
    if (r.ic >= insample.ic - 1e-15) ge++;
  }
  const icNullMean = nPerm ? nullSum / nPerm : 0;
  const icNullVar = nPerm ? Math.max(0, nullSumSq / nPerm - icNullMean * icNullMean) : 0;
  const icP = (ge + 1) / (nPerm + 1);

  // ── OOS: 学習期の基底で全週を射影し、検証週を学習週近傍で予測 ──
  const nValid = validIdx.length;
  const nTrainV = Math.floor(nValid * trainFrac);
  const trainIdx = validIdx.slice(0, nTrainV);
  const testIdx = validIdx.slice(nTrainV);
  let oosIc = 0, oosHit = 0, oosP = 1;
  if (trainIdx.length >= kNN + 5 && testIdx.length >= 8) {
    // 学習期の特徴だけで基底を張り直す(未来を覗かない)
    const trainFeat = trainIdx.map((i) => feats[i]);
    const pcaTr = functionalPca(trainFeat, 5);
    const coordsTr = feats.map((f) => {
      const s = projectScore(f, pcaTr.colMean, pcaTr.eigen);
      return [s[0] ?? 0, s[1] ?? 0];
    });
    const ntOos = buildNeighbors(coordsTr, kNN, testIdx, trainIdx);
    const oos = icFromNeighbors(ntOos, y);
    oosIc = oos.ic; oosHit = oos.hit;
    // 検証集合のラベル順列で p 値(近傍は学習期のみ参照 → こちらも順列不変)
    const rng2 = mulberry32(seed ^ 0x9e3779b9);
    const yTest = testIdx.map((i) => y[i]);
    let ge2 = 0;
    const P2 = Math.min(nPerm, 400);
    const ymap2 = y.slice();
    for (let p = 0; p < P2; p++) {
      const yperm = blockPermute(yTest, blockWeeks, rng2);
      testIdx.forEach((idx, k) => { ymap2[idx] = yperm[k]; });
      const r = icFromNeighbors(ntOos, ymap2);
      if (r.ic >= oosIc - 1e-15) ge2++;
    }
    oosP = (ge2 + 1) / (P2 + 1);
  }

  return {
    variant, eigen: pca.eigen, points, colMean: pca.colMean,
    ic: insample.ic, icNullMean, icNullSd: Math.sqrt(icNullVar), icP,
    oosIc, oosHit, oosP, nTrain: trainIdx.length, nTest: testIdx.length, kNN,
  };
}

// ───────────────────────── 本体 ─────────────────────────

export function computeWeekEmbedding(params: WeekEmbeddingParams): WeekEmbeddingResult | null {
  const { prices } = params;
  const trainFrac = params.trainFrac ?? 0.7;
  const nPerm = params.nPerm ?? 600;
  const blockWeeks = params.blockWeeks ?? 4;
  const recentN = params.recentN ?? 12;
  const seed = params.seed ?? 0x51ed01;
  if (!prices || prices.length < 120) return null;

  const weeks = groupWeeks(prices);
  // 各週を特徴化(前週末=直前週の最終立会日を base に)。完全週(4..6日)のみ。
  const levelFeat: number[][] = [];
  const metas: { weekKey: string; startTime: string; endTime: string; pathPct: number[]; lastIdx: number }[] = [];
  for (let w = 0; w < weeks.length; w++) {
    const idxs = weeks[w].idxs;
    const baseIdx = idxs[0] - 1; // 週初日の直前の立会日
    if (baseIdx < 0) continue;
    const path = resamplePath(prices, idxs, baseIdx);
    if (!path) continue;
    levelFeat.push(path);
    metas.push({
      weekKey: weeks[w].key,
      startTime: prices[idxs[0]].time,
      endTime: prices[idxs[idxs.length - 1]].time,
      pathPct: path.map((v) => (Math.exp(v) - 1) * 100), // 累積%(表示用)
      lastIdx: idxs[idxs.length - 1],
    });
  }
  const n = levelFeat.length;
  if (n < 40) return null;

  // 翌週リターン(前向き結果): log(次の特徴週の最終終値 / 当該週の最終終値)。連続週でなくても可。
  const nextRet: (number | null)[] = metas.map((m, i) => {
    if (i + 1 >= n) return null;
    const cNow = prices[m.lastIdx].close, cNext = prices[metas[i + 1].lastIdx].close;
    if (!(cNow > 0) || !(cNext > 0)) return null;
    return Math.log(cNext / cNow);
  });

  const shapeFeat = levelFeat.map((v) => zShape(v));

  const kNN = params.kNN ?? Math.max(10, Math.min(40, Math.round(Math.sqrt(n))));

  const level = buildView("level", levelFeat, metas, nextRet, kNN, trainFrac, nPerm, blockWeeks, seed);
  const shape = buildView("shape", shapeFeat, metas, nextRet, kNN, trainFrac, nPerm, blockWeeks, seed ^ 0x1234);

  // 進行中の今週(最終週が不完全 = 4日未満 or 最後の立会日が週末でない)を検出
  let currentPartial: WeekEmbeddingResult["currentPartial"] = null;
  const lastWeek = weeks[weeks.length - 1];
  if (lastWeek && lastWeek.idxs.length >= 1) {
    const idxs = lastWeek.idxs;
    const baseIdx = idxs[0] - 1;
    // 最終週が特徴化済みなら「完了済み」。metas 末尾の endTime がこの週でなければ進行中扱い。
    const lastKey = lastWeek.key;
    const featured = metas.length > 0 && metas[metas.length - 1].weekKey === lastKey && idxs.length >= 4;
    if (!featured && baseIdx >= 0 && idxs.length >= 1) {
      const base = prices[baseIdx]?.close;
      if (base > 0) {
        const pathPct: number[] = [];
        let ok = true;
        for (const i of idxs) { const c = prices[i].close; if (!(c > 0)) { ok = false; break; } pathPct.push((c / base - 1) * 100); }
        if (ok) currentPartial = { path: pathPct, elapsed: idxs.length, startTime: prices[idxs[0]].time };
      }
    }
  }

  // 直近週の時系列軌跡(古→新)。points の末尾 recentN。
  const recentIdx: number[] = [];
  for (let i = Math.max(0, n - recentN); i < n; i++) recentIdx.push(i);

  return { level, shape, nWeeks: n, nGrid: NGRID, currentPartial, recentIdx };
}
