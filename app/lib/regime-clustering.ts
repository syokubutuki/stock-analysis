// 12.2 特徴量クラスタリングによるレジーム分類。
// 日次特徴(リターン/ボラ/レンジ/出来高)を標準化し k-means でクラスタリング。
// 現在がどの市場タイプにいるか、各タイプの先行き成績を集計する。

import { PricePoint } from "./types";

const LN2 = Math.log(2);

interface Feat { ret: number; vol: number; range: number; volm: number; }

function featuresOf(prices: PricePoint[]): { feats: Feat[]; startIdx: number } {
  const feats: Feat[] = [];
  const volMean: number[] = [];
  let vsum = 0;
  for (let i = 0; i < prices.length; i++) { vsum += prices[i].volume; if (i >= 20) vsum -= prices[i - 20].volume; volMean.push(i >= 19 ? vsum / 20 : NaN); }
  const startIdx = 20;
  for (let i = startIdx; i < prices.length; i++) {
    const p = prices[i];
    const ret = prices[i - 1].close > 0 ? Math.log(p.close / prices[i - 1].close) : 0;
    const gkVar = 0.5 * Math.log(p.high / p.low) ** 2 - (2 * LN2 - 1) * Math.log(p.close / p.open) ** 2;
    const vol = Math.sqrt(Math.max(0, gkVar));
    const range = (p.high - p.low) / p.close;
    const volm = volMean[i] > 0 ? Math.log(p.volume / volMean[i]) : 0;
    feats.push({ ret, vol, range, volm });
  }
  return { feats, startIdx };
}

function standardize(feats: Feat[]): number[][] {
  const keys: (keyof Feat)[] = ["ret", "vol", "range", "volm"];
  const means: Record<string, number> = {}, sds: Record<string, number> = {};
  for (const k of keys) {
    const vals = feats.map((f) => f[k]);
    const m = vals.reduce((s, v) => s + v, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length) || 1;
    means[k] = m; sds[k] = sd;
  }
  return feats.map((f) => keys.map((k) => (f[k] - means[k]) / sds[k]));
}

function kmeans(X: number[][], k: number, iters = 30): number[] {
  const n = X.length, d = X[0].length;
  // k-means++ 風の初期化（決定的: 等間隔シード）
  const centroids: number[][] = [];
  for (let c = 0; c < k; c++) centroids.push([...X[Math.floor((c + 0.5) * n / k)]]);
  const assign = new Array(n).fill(0);
  for (let it = 0; it < iters; it++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        let dist = 0;
        for (let j = 0; j < d; j++) dist += (X[i][j] - centroids[c][j]) ** 2;
        if (dist < bd) { bd = dist; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; changed = true; }
    }
    const sums = Array.from({ length: k }, () => new Array(d).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) { counts[assign[i]]++; for (let j = 0; j < d; j++) sums[assign[i]][j] += X[i][j]; }
    for (let c = 0; c < k; c++) if (counts[c] > 0) for (let j = 0; j < d; j++) centroids[c][j] = sums[c][j] / counts[c];
    if (!changed) break;
  }
  return assign;
}

export interface ClusterStat {
  id: number; label: string; n: number;
  meanRet: number; meanVol: number; fwdMean: number; // 翌日平均
}
export interface ClusterResult {
  assignTimes: { time: string; cluster: number }[];
  clusters: ClusterStat[];
  currentCluster: number;
  k: number;
}

const PALETTE = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed"];

export function clusterRegimes(prices: PricePoint[], k = 4): ClusterResult | null {
  const { feats, startIdx } = featuresOf(prices);
  if (feats.length < k * 10) return null;
  const X = standardize(feats);
  const assign = kmeans(X, k);

  const assignTimes = assign.map((c, i) => ({ time: prices[startIdx + i].time, cluster: c }));
  const clusters: ClusterStat[] = [];
  for (let c = 0; c < k; c++) {
    const idxs: number[] = [];
    assign.forEach((a, i) => { if (a === c) idxs.push(i); });
    if (idxs.length === 0) continue;
    const meanRet = idxs.reduce((s, i) => s + feats[i].ret, 0) / idxs.length;
    const meanVol = idxs.reduce((s, i) => s + feats[i].vol, 0) / idxs.length;
    // 翌日リターン
    const fwds: number[] = [];
    for (const i of idxs) {
      const gi = startIdx + i;
      if (gi + 1 < prices.length && prices[gi].close > 0) fwds.push(prices[gi + 1].close / prices[gi].close - 1);
    }
    const fwdMean = fwds.length ? fwds.reduce((s, v) => s + v, 0) / fwds.length : 0;
    const label = `${meanRet >= 0 ? "上昇" : "下落"}・${meanVol > 0.015 ? "高ボラ" : "低ボラ"}`;
    clusters.push({ id: c, label, n: idxs.length, meanRet, meanVol, fwdMean });
  }
  return { assignTimes, clusters, currentCluster: assign[assign.length - 1], k };
}

export function clusterColor(id: number): string { return PALETTE[id % PALETTE.length]; }
