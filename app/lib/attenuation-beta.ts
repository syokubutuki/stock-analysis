import { PricePoint } from "./types";

// ============================================================================
// 減衰バイアス補正β (Attenuation-corrected Beta)
// ----------------------------------------------------------------------------
// 説明変数(ベンチマークのリターン)に測定ノイズ(マイクロ構造ノイズ・非同期取引
// による stale price)が乗ると、回帰係数βはゼロ方向に縮む(減衰バイアス /
// regression dilution)。本モジュールは
//   ・素朴な同時点β  (OLS, 減衰している)
//   ・Dimson β       (前後ラグを足し込み、非同期取引を補正した真の感応度)
// を計算し、信頼性比 λ = βOLS / βDimson でノイズの影響を定量化する。
// λ<1 ほど「測定器が粗く、真のβを取りこぼしている」ことを意味する。
// ============================================================================

export interface LagBeta {
  lag: number; // -K..+K (負=ベンチがstockに先行)
  beta: number;
}

export interface AttenuationBetaResult {
  n: number; // 回帰に使った標本数
  betaOLS: number; // 同時点のみの素朴β(減衰)
  betaDimson: number; // ラグ補正β(真の市場感応度)
  alpha: number; // 同時点回帰の切片(日次)
  rSquared: number; // 同時点回帰の決定係数
  corr: number; // 同時点相関
  reliability: number; // λ = betaOLS / betaDimson (0..)
  attenuation: number; // 1 - λ : 取りこぼした感応度の割合
  lagBetas: LagBeta[]; // 各ラグの寄与
  hedgeNaive: number; // 素朴βで組むヘッジ比率
  hedgeCorrected: number; // 補正βで組むヘッジ比率
  residualBeta: number; // 素朴βでヘッジした時に残る市場エクスポージャ
}

// 連続営業日の対数リターンを date->value のマップで返す
function logReturnMap(prices: PricePoint[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1].close;
    const cur = prices[i].close;
    if (prev > 0 && cur > 0) m.set(prices[i].time, Math.log(cur / prev));
  }
  return m;
}

// 多重線形回帰 (normal equations + ガウス消去)。
// X は各行が説明変数ベクトル(切片含む)、y は目的変数。係数ベクトルを返す。
function multipleRegression(X: number[][], y: number[]): number[] | null {
  const k = X[0].length;
  // XtX (k×k) と Xty (k)
  const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty: number[] = new Array(k).fill(0);
  for (let r = 0; r < X.length; r++) {
    const row = X[r];
    for (let a = 0; a < k; a++) {
      Xty[a] += row[a] * y[r];
      for (let b = 0; b < k; b++) XtX[a][b] += row[a] * row[b];
    }
  }
  // ガウス消去 (部分ピボット選択)
  const A = XtX.map((row, i) => [...row, Xty[i]]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    const d = A[col][col];
    for (let c = col; c <= k; c++) A[col][c] /= d;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = A[r][col];
      for (let c = col; c <= k; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row) => row[k]);
}

export function attenuationBeta(
  prices: PricePoint[],
  benchPrices: PricePoint[],
  maxLag = 1
): AttenuationBetaResult | null {
  const sMap = logReturnMap(prices);
  const bMap = logReturnMap(benchPrices);

  // 共通営業日(stock側に存在し、必要な全ラグのbenchが存在する日)を抽出
  const benchTimes = [...bMap.keys()].sort();
  const benchIndex = new Map<string, number>();
  benchTimes.forEach((t, i) => benchIndex.set(t, i));

  const sVals: number[] = [];
  const bLagVals: number[][] = []; // [行][ラグ-K..+K]
  const stockTimes = [...sMap.keys()].sort();

  for (const t of stockTimes) {
    const idx = benchIndex.get(t);
    if (idx === undefined) continue;
    if (idx - maxLag < 0 || idx + maxLag >= benchTimes.length) continue;
    const lags: number[] = [];
    let ok = true;
    for (let l = -maxLag; l <= maxLag; l++) {
      const bt = benchTimes[idx + l];
      const v = bMap.get(bt);
      if (v === undefined) {
        ok = false;
        break;
      }
      lags.push(v);
    }
    if (!ok) continue;
    sVals.push(sMap.get(t)!);
    bLagVals.push(lags);
  }

  const n = sVals.length;
  if (n < 40) return null;

  // --- 同時点OLS (切片+benchの当日リターン) ---
  const contempIdx = maxLag; // ラグ0の列
  const X1 = bLagVals.map((row) => [1, row[contempIdx]]);
  const ols = multipleRegression(X1, sVals);
  if (!ols) return null;
  const alpha = ols[0];
  const betaOLS = ols[1];

  // 相関とR²
  const meanS = sVals.reduce((a, v) => a + v, 0) / n;
  const meanB = bLagVals.reduce((a, r) => a + r[contempIdx], 0) / n;
  let cov = 0,
    varS = 0,
    varB = 0;
  for (let i = 0; i < n; i++) {
    const ds = sVals[i] - meanS;
    const db = bLagVals[i][contempIdx] - meanB;
    cov += ds * db;
    varS += ds * ds;
    varB += db * db;
  }
  const corr = varS > 0 && varB > 0 ? cov / Math.sqrt(varS * varB) : 0;
  const rSquared = corr * corr;

  // --- Dimson β (切片+全ラグの多重回帰、傾きを合計) ---
  const Xall = bLagVals.map((row) => [1, ...row]);
  const dim = multipleRegression(Xall, sVals);
  const lagBetas: LagBeta[] = [];
  let betaDimson = betaOLS;
  if (dim) {
    betaDimson = 0;
    for (let l = -maxLag; l <= maxLag; l++) {
      const coef = dim[1 + (l + maxLag)];
      lagBetas.push({ lag: l, beta: coef });
      betaDimson += coef;
    }
  }

  // 信頼性比 λ。符号が揃い、補正βが素朴βより大きいときに意味を持つ。
  let reliability = betaDimson !== 0 ? betaOLS / betaDimson : 1;
  if (!isFinite(reliability)) reliability = 1;
  // 異常値の暴れを抑える(0〜1.5にクリップ)
  reliability = Math.max(0, Math.min(1.5, reliability));
  const attenuation = 1 - reliability;

  return {
    n,
    betaOLS,
    betaDimson,
    alpha,
    rSquared,
    corr,
    reliability,
    attenuation,
    lagBetas,
    hedgeNaive: betaOLS,
    hedgeCorrected: betaDimson,
    residualBeta: betaDimson - betaOLS,
  };
}
