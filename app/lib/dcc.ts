// 動的条件付き相関 DCC (Engle 2002) と危機時相関 (方向D 高度化)
//
// 静的なPearson相関は「暴落時に相関が1へ近づく(危機時相関)」性質を捉えられず、
// 平時のリスクを過小評価する。DCCは時間変化する相関を推定し、
//   1. 各銘柄を GARCH(1,1) の条件付きボラで標準化 → 標準化残差 z
//   2. 無条件相関 Q̄ を基準に Q_t = (1-a-b)Q̄ + a·z_{t-1}z_{t-1}ᵀ + b·Q_{t-1}
//   3. R_t = diag(Q_t)^{-1/2} Q_t diag(Q_t)^{-1/2}
// a,b は対角化を避けるためペアワイズ複合尤度(closed-form 2変量正規)で推定する。
//
// 既存 garch.ts(fitGarch の conditionalVol)を標準化に再利用。

import { fitGarch } from "./garch";
import { AlignedReturns } from "./portfolio-risk";

export interface DCCResult {
  ok: boolean;
  a: number;
  b: number;
  tickers: string[];
  avgCorrSeries: number[]; // 各時点 t の非対角平均相関
  uncondAvgCorr: number; // 無条件(Q̄)の平均相関 = 平時
  currentAvgCorr: number; // 最新 R_T の平均相関 = 現在
  peakAvgCorr: number; // 期間中の最大平均相関
  currentR: number[][]; // R_T
  uncondR: number[][]; // Q̄(正規化済み)
  condVols: number[]; // 各銘柄の現在の条件付き日次ボラ σ_i,T
}

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

function offDiagMean(R: number[][]): number {
  const n = R.length;
  if (n < 2) return 0;
  let s = 0;
  let c = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      s += R[i][j];
      c++;
    }
  return c > 0 ? s / c : 0;
}

function corrOfStd(z: number[][]): number[][] {
  // z は既に(ほぼ)単位分散の標準化残差。Pearson相関を取る。
  const n = z.length;
  const R: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    R[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const a = z[i];
      const b = z[j];
      const T = a.length;
      const ma = mean(a);
      const mb = mean(b);
      let cov = 0;
      let va = 0;
      let vb = 0;
      for (let t = 0; t < T; t++) {
        const da = a[t] - ma;
        const db = b[t] - mb;
        cov += da * db;
        va += da * da;
        vb += db * db;
      }
      const c = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
      R[i][j] = c;
      R[j][i] = c;
    }
  }
  return R;
}

// qii,t 系列(q̄_ii = 1)を a,b で生成
function qiiSeries(zi: number[], a: number, b: number): number[] {
  const T = zi.length;
  const out = new Array(T).fill(1);
  let q = 1;
  for (let t = 0; t < T; t++) {
    out[t] = q;
    q = (1 - a - b) * 1 + a * zi[t] * zi[t] + b * q;
  }
  return out;
}

// ペアワイズ複合対数尤度(R依存部分のみ)
function compositeLL(z: number[][], qbar: number[][], a: number, b: number): number {
  const n = z.length;
  const T = z[0].length;
  // qii を各資産で前計算
  const qii = z.map((zi) => qiiSeries(zi, a, b));
  let ll = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let qij = qbar[i][j];
      const zi = z[i];
      const zj = z[j];
      for (let t = 0; t < T; t++) {
        const rho = qij / Math.sqrt(qii[i][t] * qii[j][t]);
        const r2 = Math.min(Math.max(rho * rho, 0), 0.999999);
        const om = 1 - r2;
        ll += -0.5 * (Math.log(om) + (zi[t] * zi[t] + zj[t] * zj[t] - 2 * rho * zi[t] * zj[t]) / om - (zi[t] * zi[t] + zj[t] * zj[t]));
        // 更新
        qij = (1 - a - b) * qbar[i][j] + a * zi[t] * zj[t] + b * qij;
      }
    }
  }
  return ll;
}

function estimateAB(z: number[][], qbar: number[][]): { a: number; b: number } {
  const aGrid = [0.01, 0.02, 0.03, 0.05, 0.08, 0.12];
  const bGrid = [0.7, 0.8, 0.85, 0.9, 0.94, 0.97];
  let best = { a: 0.04, b: 0.93, ll: -Infinity };
  for (const a of aGrid) {
    for (const b of bGrid) {
      if (a + b >= 0.999) continue;
      const ll = compositeLL(z, qbar, a, b);
      if (ll > best.ll) best = { a, b, ll };
    }
  }
  return { a: best.a, b: best.b };
}

export function computeDCC(aligned: AlignedReturns): DCCResult {
  const { tickers, returns } = aligned;
  const n = tickers.length;
  const empty: DCCResult = {
    ok: false,
    a: 0,
    b: 0,
    tickers,
    avgCorrSeries: [],
    uncondAvgCorr: 0,
    currentAvgCorr: 0,
    peakAvgCorr: 0,
    currentR: [],
    uncondR: [],
    condVols: [],
  };
  if (n < 2 || returns[0].length < 50) return empty;
  const T = returns[0].length;

  // 各銘柄を GARCH 条件付きボラで標準化
  const z: number[][] = [];
  const condVols: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = returns[i];
    const m = mean(r);
    const dem = r.map((v) => v - m);
    const g = fitGarch(dem);
    const vol = g.conditionalVol;
    z.push(dem.map((v, t) => (vol[t] > 1e-9 ? v / vol[t] : 0)));
    condVols.push(vol[vol.length - 1]);
  }

  const qbar = corrOfStd(z);
  const { a, b } = estimateAB(z, qbar);

  // 全相関行列の再帰(平均相関の時系列 + 最新 R_T)
  let Qprev = qbar.map((row) => [...row]);
  const avgCorrSeries: number[] = [];
  let currentR: number[][] = qbar;
  for (let t = 0; t < T; t++) {
    let Qt: number[][];
    if (t === 0) {
      Qt = qbar.map((row) => [...row]);
    } else {
      Qt = Array.from({ length: n }, () => new Array(n).fill(0));
      for (let i = 0; i < n; i++) {
        for (let j = i; j < n; j++) {
          const v =
            (1 - a - b) * qbar[i][j] + a * z[i][t - 1] * z[j][t - 1] + b * Qprev[i][j];
          Qt[i][j] = v;
          Qt[j][i] = v;
        }
      }
    }
    // 正規化 → R_t
    const R: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        R[i][j] = Qt[i][j] / Math.sqrt(Qt[i][i] * Qt[j][j]);
      }
    }
    avgCorrSeries.push(offDiagMean(R));
    Qprev = Qt;
    if (t === T - 1) currentR = R;
  }

  return {
    ok: true,
    a,
    b,
    tickers,
    avgCorrSeries,
    uncondAvgCorr: offDiagMean(qbar),
    currentAvgCorr: offDiagMean(currentR),
    peakAvgCorr: Math.max(...avgCorrSeries),
    currentR,
    uncondR: qbar,
    condVols,
  };
}

// ---- 下落日相関(危機時の代理) ----
// 等加重バスケットの下位 quantile に入る日だけで相関を計算する。
export interface DownsideCorr {
  ok: boolean;
  matrix: number[][];
  avg: number; // 下落日の平均相関
  nDays: number;
}

export function downsideCorrelation(
  aligned: AlignedReturns,
  quantile = 0.25
): DownsideCorr {
  const { tickers, returns } = aligned;
  const n = tickers.length;
  const T = n > 0 ? returns[0].length : 0;
  if (n < 2 || T < 20) return { ok: false, matrix: [], avg: 0, nDays: 0 };

  // 等加重バスケットの日次リターン
  const basket: number[] = [];
  for (let t = 0; t < T; t++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += returns[i][t];
    basket.push(s / n);
  }
  const sorted = [...basket].sort((x, y) => x - y);
  const thresh = sorted[Math.floor(quantile * (sorted.length - 1))];
  const days: number[] = [];
  for (let t = 0; t < T; t++) if (basket[t] <= thresh) days.push(t);
  if (days.length < 10) return { ok: false, matrix: [], avg: 0, nDays: days.length };

  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  let s = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const ai = days.map((t) => returns[i][t]);
      const aj = days.map((t) => returns[j][t]);
      const mi = mean(ai);
      const mj = mean(aj);
      let cov = 0;
      let vi = 0;
      let vj = 0;
      for (let k = 0; k < days.length; k++) {
        const di = ai[k] - mi;
        const dj = aj[k] - mj;
        cov += di * dj;
        vi += di * di;
        vj += dj * dj;
      }
      const corr = vi > 0 && vj > 0 ? cov / Math.sqrt(vi * vj) : 0;
      matrix[i][j] = corr;
      matrix[j][i] = corr;
      s += corr;
      c++;
    }
  }
  return { ok: true, matrix, avg: c > 0 ? s / c : 0, nDays: days.length };
}
