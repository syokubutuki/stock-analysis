// 寄り前情報アナログ: 「曜日 × 前夜米国ビン」で束ねた上に、さらに“今日に至る経路”が
// 似ている過去日だけを選び、その日内パスを重ねる。
//
// 動機: 曜日×米国ビンの条件セルは、たとえば「木曜 × 米大幅高」の 40 日をひとまとめに平均する。
// だがその 40 日の中には「3日下げ続けた末の木曜」も「高値追いの最中の木曜」も混じっている。
// 寄り前に確定している情報はビンと曜日だけではない ── 前日までの値動きの“形”も分かっている。
// ここではその形の近さで候補をさらに絞り、束の中の「今日に似た日」の日内パスだけを重ねる。
//
// 使う情報はすべて寄り付き前に確定しているものに限る(先読みなし):
//   ・曜日             … 暦から確定
//   ・前夜米国リターン  … 日本時間の早朝に確定
//   ・直近K日の日足形状 … 前日終値まで(当日は一切使わない)
//
// 中核の問い: 「形の近さ」で絞ると本当に予測が良くなるのか。近傍を選ぶ手続きは自由度が高く、
// 何もない場所にもそれらしい平均パスを描いてしまう。したがって本モジュールは重ね描きと同時に、
// 必ず 3 つの比較対象を並べる。
//   ① アナログ(近傍k本)  ② 条件セル平均(距離を使わない)  ③ 無条件平均(全過去日)
// さらにウォークフォワードOOSで①②③の予測力(IC・方向的中率・損失)を測り、
// 「近傍をランダムにk本選んだ」ヌルの分布と突き合わせて p 値を出す。

import { BinGrid } from "./intraday-core";
import { AlignedDay, dayCumPath, mulberry32 } from "./us-spillover-core";
import { zShape, dtw } from "./weekly-analog";
import { lastBarBin } from "./today-vs-expected";
import { mean, std, quantileSorted, tTest, blockBootstrapCI } from "./stats-significance";

// 候補日に課す事前フィルタ。標本が薄いときは緩める。
export type AnalogCond = "both" | "us" | "weekday" | "none";
export const ANALOG_CONDS: { value: AnalogCond; label: string; note: string }[] = [
  { value: "both", label: "曜日×米国", note: "同じ曜日かつ同じ前夜米国ビンの過去日だけを候補にする（最も濃いが候補は最少）" },
  { value: "us", label: "米国のみ", note: "前夜米国ビンだけ一致（曜日は問わない）" },
  { value: "weekday", label: "曜日のみ", note: "曜日だけ一致（前夜米国は問わない）" },
  { value: "none", label: "無条件", note: "全過去日を候補にし、形の近さだけで選ぶ" },
];

export type AnalogMetric = "euclid" | "dtw";
export type AnalogWeight = "uniform" | "kernel";

export interface IntradayAnalogParams {
  rows: AlignedDay[]; // 前夜米国が有効な整合日(日付昇順)
  binIdx: number[]; // rows と同順の前夜米国ビン番号
  usValues: number[]; // rows と同順の前夜米国リターン(表示用)
  grid: BinGrid;
  gmtoffset: number;
  leadLen: number; // 直近K日(前日まで)の日足形状の長さ
  k: number; // 近傍の本数
  cond: AnalogCond;
  metric: AnalogMetric;
  weight: AnalogWeight;
  targetDate?: string | null; // 未指定なら最新の立会日
}

export interface AnalogNeighbor {
  idx: number; // rows のインデックス
  date: string;
  weekday: number;
  bin: number;
  usValue: number;
  dist: number; // 形状距離(小さいほど今日に似ている)
  weight: number; // 集計に使った重み(合計1)
  end: number; // その日の寄り→引け
  gap: number; // 夜間ギャップ ln(open/prevClose)
  path: number[]; // 日内累積パス(寄り基準)
  full: number[]; // リードイン(日足K日)→ギャップ→日内 を1本に繋いだ連続パス(前日終値=0基準)
}

// 各時刻の集計パス。分位は重み付き。
export interface AnalogAgg {
  n: number;
  mean: number[];
  med: number[];
  q25: number[];
  q75: number[];
  end: number; // 終端(寄り→引け)の代表値 = 加重中央値
}

// 予測子1つ分のOOS成績。
export interface AnalogOos {
  label: string;
  n: number;
  ic: number; // 予測終端 と 実現終端 の Spearman 順位相関
  icP: number;
  hit: number; // 方向的中率
  hitP: number; // 二項検定(片側でなく両側の正規近似)
  rmse: number;
  pathCorr: number; // 予測パス形状 と 実現パスの相関の平均(経路採点)
}

export interface AnalogOosResult {
  analog: AnalogOos;
  cell: AnalogOos;
  uncond: AnalogOos;
  nullIc: number[]; // ランダムk本ヌルのIC分布(昇順)
  nullIcMean: number;
  icNullP: number; // 実測ICがヌル分布のどこにあるか(上側p値)
  lossMean: number; // 平均損失差 (条件セルの二乗誤差 − アナログの二乗誤差)。正=アナログが良い
  lossT: number;
  lossP: number;
  lossLo: number; // ブロックブートCI
  lossHi: number;
  firstDate: string;
  lastDate: string;
}

export interface IntradayAnalogResult {
  timeLabels: string[]; // 日内の時刻ラベル
  fullLabels: string[]; // 連続パスの横軸ラベル(−K日 … −1日 / 寄り / 時刻…)
  leadLen: number; // 連続パスの左側(日足)の点数
  target: {
    date: string; weekday: number; bin: number; usValue: number; gap: number;
    path: number[]; full: number[]; lastIdx: number; lead: number[]; // lead=直近K日の日足(前日終値=0)
  };
  neighbors: AnalogNeighbor[];
  analog: AnalogAgg;
  cell: AnalogAgg;
  uncond: AnalogAgg;
  nCand: number; // 条件を満たした候補日数
  maxAbs: number; // 縦軸スケール
  novelty: number; // 0..1。1に近いほど「今日に似た前例が薄い」
  oos: AnalogOosResult | null;
}

// ───────────────────────── 距離・重み ─────────────────────────

// 窓長で正規化したユークリッド距離(K を変えても距離の桁が揃う)。
function euclidNorm(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / a.length);
}

function shapeDistance(a: number[], b: number[], metric: AnalogMetric): number {
  if (metric === "dtw") return dtw(a, b, Math.max(1, Math.round(a.length * 0.25)));
  return euclidNorm(a, b);
}

// 距離→重み。kernel は Nadaraya-Watson(ガウス核)。帯域は選抜距離の中央値(0なら等重み)。
function distWeights(dists: number[], mode: AnalogWeight): number[] {
  const n = dists.length;
  if (n === 0) return [];
  if (mode === "uniform") return new Array(n).fill(1 / n);
  const sorted = [...dists].sort((a, b) => a - b);
  const h = quantileSorted(sorted, 0.5) || 1e-9;
  const raw = dists.map((d) => Math.exp(-((d / h) ** 2)));
  const s = raw.reduce((acc, v) => acc + v, 0);
  return s > 0 ? raw.map((v) => v / s) : new Array(n).fill(1 / n);
}

// 重み付き分位(値でソートし累積重みが q を跨ぐ点を線形補間)。
function wQuantile(values: number[], weights: number[], q: number): number {
  const n = values.length;
  if (n === 0) return 0;
  if (n === 1) return values[0];
  const idx = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
  const total = idx.reduce((s, o) => s + o.w, 0);
  if (total <= 0) return idx[Math.floor(n / 2)].v;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const lo = acc / total;
    acc += idx[i].w;
    const hi = acc / total;
    if (q <= hi) {
      if (hi - lo <= 0 || i === 0) return idx[i].v;
      const t = (q - lo) / (hi - lo);
      return idx[i - 1].v + t * (idx[i].v - idx[i - 1].v);
    }
  }
  return idx[n - 1].v;
}

// 重み付きの平均/中央値/四分位パスを各点で集計する。
// ends/idxs を与えると、終端(寄り→引け)の加重中央値を別途持つ(表示パスは連続パスでも、
// 売買の単位である寄り→引けを混ぜないため)。
function aggregate(
  paths: number[][], weights: number[], T: number,
  ends?: number[], idxs?: number[]
): AnalogAgg {
  const n = paths.length;
  const empty = new Array(T).fill(0);
  if (n === 0) return { n: 0, mean: empty, med: empty, q25: empty, q75: empty, end: 0 };
  const m = new Array(T).fill(0), md = new Array(T).fill(0);
  const q25 = new Array(T).fill(0), q75 = new Array(T).fill(0);
  for (let g = 0; g < T; g++) {
    const col = paths.map((p) => p[g]);
    m[g] = col.reduce((s, v, i) => s + v * weights[i], 0);
    md[g] = wQuantile(col, weights, 0.5);
    q25[g] = wQuantile(col, weights, 0.25);
    q75[g] = wQuantile(col, weights, 0.75);
  }
  const end = ends && idxs ? wQuantile(idxs.map((i) => ends[i]), weights, 0.5) : md[T - 1];
  return { n, mean: m, med: md, q25, q75, end };
}

// ───────────────────────── 順位相関・検定 ─────────────────────────

function avgRanks(v: number[]): number[] {
  const idx = v.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const r = new Array(v.length).fill(0);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1].x === idx[k].x) j++;
    const rank = (k + j) / 2 + 1;
    for (let m = k; m <= j; m++) r[idx[m].i] = rank;
    k = j + 1;
  }
  return r;
}

function pearsonOf(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const mx = mean(x), my = mean(y);
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

// Spearman順位相関(タイ補正済)。
function spearmanOf(x: number[], y: number[]): number {
  return pearsonOf(avgRanks(x), avgRanks(y));
}

// 正規近似の両側p値。
function normalTwoSidedP(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.min(1, 2 * p);
}

// 予測列と実現列からOOS成績をまとめる。
function scorePredictor(
  label: string, pred: number[], actual: number[], pathCorrs: number[]
): AnalogOos {
  const n = pred.length;
  if (n < 5) {
    return { label, n, ic: 0, icP: 1, hit: 0.5, hitP: 1, rmse: 0, pathCorr: 0 };
  }
  const ic = spearmanOf(pred, actual);
  // IC の p 値: t = ρ√((n−2)/(1−ρ²))。標本は「日」なので独立性はおおむね妥当。
  const tStat = Math.abs(ic) < 1 ? ic * Math.sqrt((n - 2) / (1 - ic * ic)) : 0;
  const icP = normalTwoSidedP(tStat);
  let hits = 0, se = 0;
  for (let i = 0; i < n; i++) {
    if ((pred[i] >= 0) === (actual[i] >= 0)) hits++;
    se += (pred[i] - actual[i]) ** 2;
  }
  const hit = hits / n;
  const hitP = normalTwoSidedP((hit - 0.5) * 2 * Math.sqrt(n));
  return { label, n, ic, icP, hit, hitP, rmse: Math.sqrt(se / n), pathCorr: pathCorrs.length ? mean(pathCorrs) : 0 };
}

// ───────────────────────── リードイン(寄り前に確定している経路) ─────────────────────────

// 対象日 t の「前日終値を0とする直近K日の日足累積対数リターン」。当日の情報は一切使わない。
// rows は立会日の昇順。t-1, t-2, ... の終値だけを見る。
function buildLead(rows: AlignedDay[], t: number, L: number): number[] | null {
  if (t - L < 0) return null;
  const base = rows[t - 1].jp.close;
  if (!(base > 0)) return null;
  const out: number[] = [];
  for (let i = t - L; i <= t - 1; i++) {
    const c = rows[i].jp.close;
    if (!(c > 0)) return null;
    out.push(Math.log(c / base));
  }
  return out;
}

// ───────────────────────── 本体 ─────────────────────────

const NULL_B = 200; // ランダムk本ヌルの反復回数

export function computeIntradayAnalog(p: IntradayAnalogParams): IntradayAnalogResult | null {
  const { rows, binIdx, usValues, grid, gmtoffset, leadLen, k, cond, metric, weight } = p;
  const G = grid.bins.length;
  if (G < 2 || rows.length < leadLen + 12) return null;

  // 全立会日の日内パスと終端、リードイン形状を一度だけ用意する。
  const paths = rows.map((a) => dayCumPath(a.jp, grid, gmtoffset));
  const ends = paths.map((pp) => pp[G - 1]);
  const rawLeads: (number[] | null)[] = rows.map((_, i) => buildLead(rows, i, leadLen));
  const leads: (number[] | null)[] = rawLeads.map((l) => (l ? zShape(l) : null));

  // 連続パス: 前日終値を0として「直近K日の日足 → 夜間ギャップ → 当日日内」を1本に繋ぐ。
  // 対数リターンなので単純な足し算で繋がる(ギャップ+日中=当日)。
  const T = leadLen + 1 + G;
  const fulls: (number[] | null)[] = rows.map((a, i) => {
    const l = rawLeads[i];
    if (!l) return null;
    return [...l, a.gap, ...paths[i].map((v) => v + a.gap)];
  });

  const tIdx = p.targetDate
    ? rows.findIndex((a) => a.jp.date === p.targetDate)
    : rows.length - 1;
  if (tIdx < 0) return null;
  const targetLead = leads[tIdx];
  if (!targetLead) return null;

  // 候補判定: 対象日より前の日だけ(先読み排除)。cond で曜日/ビンを一致させる。
  const matches = (i: number, ref: number) => {
    if (leads[i] === null) return false;
    const okUs = cond === "both" || cond === "us" ? binIdx[i] === binIdx[ref] : true;
    const okWd = cond === "both" || cond === "weekday" ? rows[i].jp.weekday === rows[ref].jp.weekday : true;
    return okUs && okWd;
  };

  // ── 表示用: 対象日の近傍選抜 ──
  const cand: number[] = [];
  for (let i = 0; i < tIdx; i++) if (matches(i, tIdx)) cand.push(i);
  if (cand.length < 3) return null;

  const dists = cand.map((i) => shapeDistance(targetLead, leads[i]!, metric));
  const order = cand.map((i, j) => ({ i, d: dists[j] })).sort((a, b) => a.d - b.d);
  const sel = order.slice(0, Math.min(k, order.length));
  const selDists = sel.map((o) => o.d);
  const selW = distWeights(selDists, weight);

  const neighbors: AnalogNeighbor[] = sel.map((o, j) => ({
    idx: o.i,
    date: rows[o.i].jp.date,
    weekday: rows[o.i].jp.weekday,
    bin: binIdx[o.i],
    usValue: usValues[o.i],
    dist: o.d,
    weight: selW[j],
    end: ends[o.i],
    gap: rows[o.i].gap,
    path: paths[o.i],
    full: fulls[o.i]!,
  }));

  // 集計はすべて連続パス(リードイン→ギャップ→日内)の上で行う。終端 end だけは
  // 「寄り→引け」で持ち、売買判断(寄りで建てて引けで降りる)と単位を揃える。
  const analog = aggregate(sel.map((o) => fulls[o.i]!), selW, T, ends, sel.map((o) => o.i));
  const cellW = new Array(cand.length).fill(1 / cand.length);
  const cellAgg = aggregate(cand.map((i) => fulls[i]!), cellW, T, ends, cand);
  const allPrior: number[] = [];
  for (let i = 0; i < tIdx; i++) if (fulls[i] !== null) allPrior.push(i);
  const uncondW = new Array(allPrior.length).fill(1 / Math.max(1, allPrior.length));
  const uncond = aggregate(allPrior.map((i) => fulls[i]!), uncondW, T, ends, allPrior);

  // novelty: 「今日の最近傍距離」が、過去の各日の最近傍距離の分布の何分位にあるか。
  // 1に近いほど前例が薄い＝重ねた過去日は形が似ていない(アナログが効かない局面)。
  const refDists: number[] = [];
  const step = Math.max(1, Math.floor(tIdx / 160));
  for (let r = leadLen + 1; r < tIdx; r += step) {
    if (!leads[r]) continue;
    let best = Infinity;
    for (let i = 0; i < r; i++) {
      if (!matches(i, r)) continue;
      const d = shapeDistance(leads[r]!, leads[i]!, metric);
      if (d < best) best = d;
    }
    if (isFinite(best)) refDists.push(best);
  }
  refDists.sort((a, b) => a - b);
  const d0 = selDists.length ? selDists[0] : Infinity;
  const novelty = refDists.length
    ? refDists.filter((d) => d <= d0).length / refDists.length
    : 0.5;

  // 縦軸スケール(近傍・条件セル・無条件の四分位帯 + 対象日の実測)。
  let maxAbs = 1e-6;
  for (const g of [analog, cellAgg, uncond]) {
    for (let i = 0; i < T; i++) maxAbs = Math.max(maxAbs, Math.abs(g.q25[i]), Math.abs(g.q75[i]));
  }
  for (const v of fulls[tIdx] ?? []) maxAbs = Math.max(maxAbs, Math.abs(v));

  // ── OOS検証: 過去日を順に「今日」に見立てて、その時点で使える情報だけで予測する ──
  const oos = runOos(rows, binIdx, paths, ends, leads, matches, {
    k, metric, weight, leadLen, G,
  });

  const timeLabels = grid.bins.map((b) => b.label);
  const fullLabels = [
    ...Array.from({ length: leadLen }, (_, i) => `−${leadLen - i}日`),
    "寄り",
    ...timeLabels,
  ];
  return {
    timeLabels,
    fullLabels,
    leadLen,
    target: {
      date: rows[tIdx].jp.date,
      weekday: rows[tIdx].jp.weekday,
      bin: binIdx[tIdx],
      usValue: usValues[tIdx],
      gap: rows[tIdx].gap,
      path: paths[tIdx],
      full: fulls[tIdx]!,
      // 場中なら実測が到達しているビンまで(前方補完による偽の平坦線を描かないため)
      lastIdx: lastBarBin(rows[tIdx].jp, grid, gmtoffset),
      lead: rawLeads[tIdx]!,
    },
    neighbors,
    analog,
    cell: cellAgg,
    uncond,
    nCand: cand.length,
    maxAbs,
    novelty,
    oos,
  };
}

// ウォークフォワードOOS。各対象日について「その日より前」の情報だけで3種の予測を作り、
// 実現した寄り→引けと突き合わせる。近傍をランダムに選ぶヌルも同じ枠組みで走らせる。
function runOos(
  rows: AlignedDay[],
  binIdx: number[],
  paths: number[][],
  ends: number[],
  leads: (number[] | null)[],
  matches: (i: number, ref: number) => boolean,
  cfg: { k: number; metric: AnalogMetric; weight: AnalogWeight; leadLen: number; G: number }
): AnalogOosResult | null {
  const { k, metric, weight, leadLen, G } = cfg;
  const N = rows.length;
  const MIN_CAND = 20; // 候補がこれ未満の日は「まだ推定できない」として飛ばす

  const actual: number[] = [], pA: number[] = [], pC: number[] = [], pU: number[] = [];
  const corrA: number[] = [], corrC: number[] = [];
  const lossDiff: number[] = [];
  const nullPred: number[][] = Array.from({ length: NULL_B }, () => []);
  const rng = mulberry32(0x5eed1234);
  const dates: string[] = [];

  for (let t = leadLen + 1; t < N; t++) {
    const lt = leads[t];
    if (!lt) continue;
    const cand: number[] = [];
    for (let i = 0; i < t; i++) if (matches(i, t)) cand.push(i);
    if (cand.length < MIN_CAND) continue;

    const ds = cand.map((i) => shapeDistance(lt, leads[i]!, metric));
    const ord = cand.map((i, j) => ({ i, d: ds[j] })).sort((a, b) => a.d - b.d);
    const sel = ord.slice(0, Math.min(k, ord.length));
    const w = distWeights(sel.map((o) => o.d), weight);

    const predA = wQuantile(sel.map((o) => ends[o.i]), w, 0.5);
    const predC = mean(cand.map((i) => ends[i]));
    const predU = mean(ends.slice(0, t));

    // 経路採点: 予測パス(近傍の加重平均 / 条件セル平均)と実現パスの形の一致。
    const meanPathA = new Array(G).fill(0), meanPathC = new Array(G).fill(0);
    for (let g = 0; g < G; g++) {
      meanPathA[g] = sel.reduce((s, o, j) => s + paths[o.i][g] * w[j], 0);
      meanPathC[g] = mean(cand.map((i) => paths[i][g]));
    }
    corrA.push(pearsonOf(paths[t], meanPathA));
    corrC.push(pearsonOf(paths[t], meanPathC));

    actual.push(ends[t]);
    pA.push(predA); pC.push(predC); pU.push(predU);
    lossDiff.push((predC - ends[t]) ** 2 - (predA - ends[t]) ** 2);
    dates.push(rows[t].jp.date);

    // ヌル: 同じ候補集合から距離を無視して k 本を無作為抽出(選抜手続きだけを壊す)。
    const m = Math.min(k, cand.length);
    for (let b = 0; b < NULL_B; b++) {
      const picked: number[] = [];
      for (let j = 0; j < m; j++) picked.push(ends[cand[Math.floor(rng() * cand.length)]]);
      nullPred[b].push(wQuantile(picked, new Array(m).fill(1 / m), 0.5));
    }
  }

  if (actual.length < 20) return null;

  const analog = scorePredictor("アナログ(近傍k本)", pA, actual, corrA);
  const cell = scorePredictor("条件セル平均", pC, actual, corrC);
  const uncond = scorePredictor("無条件平均", pU, actual, []);

  const nullIc = nullPred.map((pp) => spearmanOf(pp, actual)).sort((a, b) => a - b);
  const ge = nullIc.filter((v) => v >= analog.ic).length;
  const icNullP = (ge + 1) / (nullIc.length + 1);

  const lt = tTest(lossDiff);
  const lci = blockBootstrapCI(lossDiff);

  return {
    analog, cell, uncond,
    nullIc,
    nullIcMean: mean(nullIc),
    icNullP,
    lossMean: mean(lossDiff),
    lossT: lt ? lt.t : 0,
    lossP: lt ? lt.p : 1,
    lossLo: lci ? lci.lo : NaN,
    lossHi: lci ? lci.hi : NaN,
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
  };
}

// 表示用: 標準偏差(近傍の終端のばらつき)。
export function neighborSpread(ns: AnalogNeighbor[]): number {
  return std(ns.map((n) => n.end));
}
