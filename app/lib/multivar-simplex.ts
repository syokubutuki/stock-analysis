// 12.3 多変量埋め込みでの近傍予測（simplex projection の多変量版）。
// OHLC由来の特徴ベクトル(リターン/レンジ/ボラ)で状態空間を作り、現在に似た過去の状態の
// 「次の動き」から翌日リターンを予測する。予測力(相関ρ)で非線形予測の有効性を測る。

import { PricePoint } from "./types";

const LN2 = Math.log(2);

interface Vec { v: number[]; nextRet: number; idx: number; }

function buildVectors(prices: PricePoint[], emb: number): Vec[] {
  // 特徴: [ret, range, gkVol] を emb 日分連結
  const feats: number[][] = [];
  for (let i = 1; i < prices.length; i++) {
    const p = prices[i];
    const ret = prices[i - 1].close > 0 ? Math.log(p.close / prices[i - 1].close) : 0;
    const range = (p.high - p.low) / p.close;
    const gk = Math.sqrt(Math.max(0, 0.5 * Math.log(p.high / p.low) ** 2 - (2 * LN2 - 1) * Math.log(p.close / p.open) ** 2));
    feats.push([ret, range, gk]);
  }
  // 標準化
  const D = 3;
  const mean = new Array(D).fill(0), sd = new Array(D).fill(0);
  for (const f of feats) for (let j = 0; j < D; j++) mean[j] += f[j];
  for (let j = 0; j < D; j++) mean[j] /= feats.length;
  for (const f of feats) for (let j = 0; j < D; j++) sd[j] += (f[j] - mean[j]) ** 2;
  for (let j = 0; j < D; j++) sd[j] = Math.sqrt(sd[j] / feats.length) || 1;
  const z = feats.map((f) => f.map((x, j) => (x - mean[j]) / sd[j]));

  const vecs: Vec[] = [];
  for (let i = emb - 1; i < z.length - 1; i++) {
    const v: number[] = [];
    for (let k = 0; k < emb; k++) v.push(...z[i - k]);
    vecs.push({ v, nextRet: feats[i + 1][0], idx: i });
  }
  return vecs;
}

function dist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

export interface SimplexResult {
  points: { predicted: number; actual: number }[];
  rho: number; // 予測と実現の相関
  currentForecast: number; // 直近状態からの翌日予測
  emb: number;
  nNeighbors: number;
}

export function multivarSimplex(prices: PricePoint[], emb = 3): SimplexResult | null {
  const vecs = buildVectors(prices, emb);
  if (vecs.length < 100) return null;
  const K = emb * 3 + 1; // 近傍数
  const points: { predicted: number; actual: number }[] = [];

  // 各ベクトルについて、時間的に離れた近傍K個で次リターンを予測（leave-near-out）
  for (let t = 0; t < vecs.length; t++) {
    const target = vecs[t];
    const cand: { d: number; nr: number }[] = [];
    for (let s = 0; s < vecs.length; s++) {
      if (Math.abs(vecs[s].idx - target.idx) <= emb) continue; // 近接窓を除外
      cand.push({ d: dist(target.v, vecs[s].v), nr: vecs[s].nextRet });
    }
    cand.sort((a, b) => a.d - b.d);
    const knn = cand.slice(0, K);
    const d0 = knn[0].d || 1e-9;
    let wsum = 0, psum = 0;
    for (const c of knn) { const w = Math.exp(-c.d / d0); wsum += w; psum += w * c.nr; }
    points.push({ predicted: wsum > 0 ? psum / wsum : 0, actual: target.nextRet });
  }

  // ρ
  const pr = points.map((p) => p.predicted), ac = points.map((p) => p.actual);
  const mp = pr.reduce((s, v) => s + v, 0) / pr.length, ma = ac.reduce((s, v) => s + v, 0) / ac.length;
  let cov = 0, vp = 0, va = 0;
  for (let i = 0; i < pr.length; i++) { cov += (pr[i] - mp) * (ac[i] - ma); vp += (pr[i] - mp) ** 2; va += (ac[i] - ma) ** 2; }
  const rho = vp > 0 && va > 0 ? cov / Math.sqrt(vp * va) : 0;

  return { points, rho, currentForecast: points.length ? points[points.length - 1].predicted : 0, emb, nNeighbors: K };
}
