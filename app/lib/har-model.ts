// 2.2/2.3 HARモデル（Heterogeneous AutoRegressive model of Realized Volatility）。
// 日次の実現分散RVを、日(1日)・週(5日)・月(22日)平均で説明する回帰。シンプルだが
// ボラ予測の定番。レンジ由来（Garman-Klass）の日次分散を観測値に使い、終値法より
// 効率的な入力でボラを予測する（提案2.2の「レンジベースをボラモデルの観測値に」を体現）。

import { PricePoint } from "./types";

const LN2 = Math.log(2);
const TRADING_DAYS = 252;

// Garman-Klass 日次分散（非年率）。RVの代理に使う。
function gkDailyVar(p: PricePoint): number {
  const { open: O, high: H, low: L, close: C } = p;
  if (!(O > 0 && H > 0 && L > 0 && C > 0)) return NaN;
  return Math.max(0, 0.5 * Math.log(H / L) ** 2 - (2 * LN2 - 1) * Math.log(C / O) ** 2);
}

// 4x4 までの線形連立を解く（ガウス・ジョルダン）。
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row[n]);
}

export interface HARResult {
  coef: { b0: number; bd: number; bw: number; bm: number };
  r2: number;
  fitted: { time: string; actual: number; fitted: number }[]; // 年率σ%（=√(RV×252）×100）
  forecastVol: number; // 翌日予測（年率σ）
  n: number;
}

export function fitHAR(prices: PricePoint[]): HARResult | null {
  const n = prices.length;
  if (n < 60) return null;
  const rv = prices.map(gkDailyVar);

  // 説明変数 RV_d, RV_w(5), RV_m(22)
  const rows: { t: number; y: number; xd: number; xw: number; xm: number }[] = [];
  for (let t = 22; t < n - 1; t++) {
    if (isNaN(rv[t])) continue;
    const xd = rv[t];
    let sw = 0, okw = true;
    for (let k = 0; k < 5; k++) { if (isNaN(rv[t - k])) okw = false; sw += rv[t - k]; }
    let sm = 0, okm = true;
    for (let k = 0; k < 22; k++) { if (isNaN(rv[t - k])) okm = false; sm += rv[t - k]; }
    const y = rv[t + 1];
    if (!okw || !okm || isNaN(y)) continue;
    rows.push({ t, y, xd, xw: sw / 5, xm: sm / 22 });
  }
  if (rows.length < 30) return null;

  // 正規方程式 X'X β = X'y （X=[1,xd,xw,xm]）
  const XtX = Array.from({ length: 4 }, () => new Array(4).fill(0));
  const Xty = new Array(4).fill(0);
  for (const r of rows) {
    const x = [1, r.xd, r.xw, r.xm];
    for (let a = 0; a < 4; a++) {
      Xty[a] += x[a] * r.y;
      for (let b = 0; b < 4; b++) XtX[a][b] += x[a] * x[b];
    }
  }
  const beta = solve(XtX, Xty);
  if (!beta) return null;
  const [b0, bd, bw, bm] = beta;

  // R² と fitted
  const yMean = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  let ssRes = 0, ssTot = 0;
  const annVol = (v: number) => Math.sqrt(Math.max(0, v) * TRADING_DAYS) * 100;
  const fitted = rows.map((r) => {
    const pred = b0 + bd * r.xd + bw * r.xw + bm * r.xm;
    ssRes += (r.y - pred) ** 2;
    ssTot += (r.y - yMean) ** 2;
    return { time: prices[r.t + 1].time, actual: annVol(r.y), fitted: annVol(pred) };
  });
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // 翌日予測（最新の RV_d/w/m で）
  const last = n - 1;
  let sw = 0, sm = 0;
  for (let k = 0; k < 5; k++) sw += rv[last - k] || 0;
  for (let k = 0; k < 22; k++) sm += rv[last - k] || 0;
  const fc = b0 + bd * (rv[last] || 0) + bw * (sw / 5) + bm * (sm / 22);

  return { coef: { b0, bd, bw, bm }, r2, fitted, forecastVol: annVol(fc) / 100, n: rows.length };
}
