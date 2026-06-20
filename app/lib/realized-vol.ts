// マイクロ構造の代理分析（板・ティック不要、分足で近似）。
//   C1: 実現ボラ(RV)・実現レンジ(RR)・バイパワー変動(BV)・ジャンプ分離 + HAR-RV予測
//   C2: オーバーナイト vs 日中の分解（累積エクイティ・分散寄与）
//   C3: 日中リターンの自己相関 + シグネチャープロット（サンプリング間隔依存）
//   C4: 出来高クロック（等出来高バー）と時間バーのリターン分布比較

import { IntradayBar, groupByDay, logReturn, meanOf, stdOf, DayData } from "./intraday-core";

const ANN = 252;

// ───────────────────────── C1: 実現ボラ + HAR ─────────────────────────

export interface RvDay {
  date: string;
  rv: number;       // 実現分散（日次, 二乗和）
  annVolPct: number; // 年率実現ボラ（%）
  rrVolPct: number;  // 実現レンジ由来ボラ（%）
  jumpShare: number; // (RV-BV)/RV のジャンプ寄与
  isJump: boolean;
}
export interface HarFit {
  b0: number; bd: number; bw: number; bm: number; r2: number;
  predicted: { date: string; actualAnnPct: number; predAnnPct: number }[];
}
export interface RvResult {
  nDays: number;
  days: RvDay[];
  har: HarFit | null;
  meanAnnVolPct: number;
  jumpDays: number;
}

function dayReturns(day: DayData): number[] {
  const cs = day.bars.map((b) => b.close);
  const r: number[] = [];
  for (let i = 1; i < cs.length; i++) r.push(logReturn(cs[i - 1], cs[i]));
  return r;
}

// 多変数OLS（正規方程式 + ガウス消去）。X は各行 [1, x1, x2, ...]。
function ols(X: number[][], y: number[]): number[] | null {
  const n = X.length, k = X[0].length;
  if (n <= k) return null;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  // ガウス消去
  const M = XtX.map((row, i) => [...row, Xty[i]]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let c = col; c <= k; c++) M[col][c] /= d;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c <= k; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[k]);
}

export function computeRealizedVol(bars: IntradayBar[], gmtoffset: number): RvResult | null {
  const days = groupByDay(bars, gmtoffset);
  if (days.length < 25) return null;

  const rvDays: RvDay[] = days.map((day) => {
    const r = dayReturns(day);
    const rv = r.reduce((s, v) => s + v * v, 0);
    // バイパワー変動
    let bv = 0;
    for (let i = 1; i < r.length; i++) bv += Math.abs(r[i]) * Math.abs(r[i - 1]);
    bv *= Math.PI / 2;
    // 実現レンジ
    let rr = 0;
    for (const b of day.bars) {
      if (b.high > 0 && b.low > 0) { const lr = Math.log(b.high / b.low); rr += (lr * lr) / (4 * Math.log(2)); }
    }
    const jump = rv > 0 ? Math.max(0, (rv - bv) / rv) : 0;
    return {
      date: day.date, rv,
      annVolPct: Math.sqrt(ANN * rv) * 100,
      rrVolPct: Math.sqrt(ANN * rr) * 100,
      jumpShare: jump,
      isJump: jump > 0.5,
    };
  });

  // HAR-RV: RV_{d+1} = b0 + bd·RV_d + bw·RV_week + bm·RV_month
  const rvArr = rvDays.map((d) => d.rv);
  const X: number[][] = [], Y: number[] = [], idx: number[] = [];
  for (let i = 21; i < rvArr.length - 1; i++) {
    const rvD = rvArr[i];
    const rvW = meanOf(rvArr.slice(i - 4, i + 1));
    const rvM = meanOf(rvArr.slice(i - 21, i + 1));
    X.push([1, rvD, rvW, rvM]);
    Y.push(rvArr[i + 1]);
    idx.push(i + 1);
  }
  let har: HarFit | null = null;
  const coef = X.length > 6 ? ols(X, Y) : null;
  if (coef) {
    const [b0, bd, bw, bm] = coef;
    const yMean = meanOf(Y);
    let ssRes = 0, ssTot = 0;
    const predicted: HarFit["predicted"] = [];
    for (let j = 0; j < X.length; j++) {
      const pred = b0 + bd * X[j][1] + bw * X[j][2] + bm * X[j][3];
      ssRes += (Y[j] - pred) ** 2;
      ssTot += (Y[j] - yMean) ** 2;
      predicted.push({
        date: rvDays[idx[j]].date,
        actualAnnPct: Math.sqrt(ANN * Math.max(0, Y[j])) * 100,
        predAnnPct: Math.sqrt(ANN * Math.max(0, pred)) * 100,
      });
    }
    har = { b0, bd, bw, bm, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0, predicted };
  }

  return {
    nDays: days.length,
    days: rvDays,
    har,
    meanAnnVolPct: meanOf(rvDays.map((d) => d.annVolPct)),
    jumpDays: rvDays.filter((d) => d.isJump).length,
  };
}

// ───────────────────────── C2: オーバーナイト/日中 ─────────────────────────

export interface OvernightResult {
  nDays: number;
  cumOvernight: { date: string; value: number }[];
  cumIntraday: { date: string; value: number }[];
  onMeanPct: number; idMeanPct: number;
  onSharpe: number; idSharpe: number;
  onVarShare: number; // 夜間分散 / 全体分散
}

export function computeOvernightIntraday(bars: IntradayBar[], gmtoffset: number): OvernightResult | null {
  const days = groupByDay(bars, gmtoffset);
  if (days.length < 5) return null;

  const onRets: number[] = [], idRets: number[] = [], totRets: number[] = [];
  const cumOvernight: { date: string; value: number }[] = [];
  const cumIntraday: { date: string; value: number }[] = [];
  let cumOn = 0, cumId = 0;

  for (const day of days) {
    const id = logReturn(day.open, day.close);
    idRets.push(id);
    cumId += id;
    cumIntraday.push({ date: day.date, value: Math.exp(cumId) });

    if (!isNaN(day.prevClose) && day.prevClose > 0) {
      const on = logReturn(day.prevClose, day.open);
      onRets.push(on);
      totRets.push(on + id);
      cumOn += on;
    }
    cumOvernight.push({ date: day.date, value: Math.exp(cumOn) });
  }

  const sharpe = (a: number[]) => { const s = stdOf(a); return s > 0 ? (meanOf(a) / s) * Math.sqrt(ANN) : 0; };
  const varOn = stdOf(onRets) ** 2;
  const varTot = stdOf(totRets) ** 2;

  return {
    nDays: days.length,
    cumOvernight, cumIntraday,
    onMeanPct: meanOf(onRets) * 100,
    idMeanPct: meanOf(idRets) * 100,
    onSharpe: sharpe(onRets),
    idSharpe: sharpe(idRets),
    onVarShare: varTot > 0 ? varOn / varTot : 0,
  };
}

// ───────────────────────── C3: 自己相関 + シグネチャー ─────────────────────────

export interface SignatureResult {
  acf: { lag: number; value: number }[];
  signature: { stepMin: number; annVolPct: number }[];
  baseIntervalMin: number;
}

export function computeSignature(
  bars: IntradayBar[], gmtoffset: number, baseIntervalMin: number, maxLag = 10
): SignatureResult | null {
  const days = groupByDay(bars, gmtoffset);
  if (days.length === 0) return null;
  const dayRets = days.map(dayReturns).filter((r) => r.length > maxLag + 2);
  if (dayRets.length === 0) return null;

  // 自己相関（日跨ぎなし, プールして推定）
  const all = dayRets.flat();
  const m = meanOf(all);
  const v = all.reduce((s, x) => s + (x - m) ** 2, 0) / all.length;
  const acf: { lag: number; value: number }[] = [];
  for (let lag = 1; lag <= maxLag; lag++) {
    let num = 0, cnt = 0;
    for (const r of dayRets) {
      for (let t = 0; t + lag < r.length; t++) { num += (r[t] - m) * (r[t + lag] - m); cnt++; }
    }
    acf.push({ lag, value: v > 0 && cnt > 0 ? num / cnt / v : 0 });
  }

  // シグネチャープロット: k本ごとにサンプリングした実現ボラ
  const steps = [1, 2, 3, 4, 6, 8, 12].filter((k) => k <= maxLag + 2);
  const signature = steps.map((k) => {
    const rvs: number[] = [];
    for (const day of days) {
      const cs = day.bars.map((b) => b.close);
      let rv = 0, cnt = 0;
      for (let i = k; i < cs.length; i += k) { const lr = logReturn(cs[i - k], cs[i]); rv += lr * lr; cnt++; }
      if (cnt > 0) rvs.push(rv);
    }
    // 1日あたりRVの平均を、k本=1ステップ前提で年率換算
    const meanRv = meanOf(rvs);
    return { stepMin: k * baseIntervalMin, annVolPct: Math.sqrt(ANN * meanRv) * 100 };
  });

  return { acf, signature, baseIntervalMin };
}

// ───────────────────────── C4: 出来高クロック ─────────────────────────

export interface HistBin { center: number; count: number; }
export interface VolumeClockResult {
  nTimeBars: number;
  nVolBars: number;
  timeStd: number; volStd: number;
  timeKurt: number; volKurt: number; // 超過尖度
  timeHist: HistBin[]; volHist: HistBin[];
}

function excessKurtosis(a: number[]): number {
  if (a.length < 4) return 0;
  const m = meanOf(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length;
  if (v <= 0) return 0;
  const m4 = a.reduce((s, x) => s + (x - m) ** 4, 0) / a.length;
  return m4 / (v * v) - 3;
}

function stdHist(a: number[], nBins = 21): HistBin[] {
  if (a.length === 0) return [];
  const m = meanOf(a), s = stdOf(a) || 1;
  const z = a.map((x) => (x - m) / s);
  const lo = -4, hi = 4, w = (hi - lo) / nBins;
  const bins: HistBin[] = Array.from({ length: nBins }, (_, i) => ({ center: lo + w * (i + 0.5), count: 0 }));
  for (const v of z) {
    let idx = Math.floor((v - lo) / w);
    if (idx < 0) idx = 0; if (idx >= nBins) idx = nBins - 1;
    bins[idx].count++;
  }
  return bins;
}

export function computeVolumeClock(bars: IntradayBar[], gmtoffset: number): VolumeClockResult | null {
  const days = groupByDay(bars, gmtoffset);
  if (days.length === 0) return null;

  const timeRets: number[] = [];
  const volRets: number[] = [];

  for (const day of days) {
    const bs = day.bars;
    if (bs.length < 4) continue;
    // 時間バーのリターン
    for (let i = 1; i < bs.length; i++) timeRets.push(logReturn(bs[i - 1].close, bs[i].close));

    // 等出来高バー: 1日を時間バー本数と同数の等出来高バーに分ける
    const totalVol = bs.reduce((s, b) => s + (b.volume || 0), 0);
    if (totalVol <= 0) continue;
    const target = bs.length;
    const threshold = totalVol / target;
    let acc = 0;
    const volBarCloses: number[] = [bs[0].open];
    for (const b of bs) {
      acc += b.volume || 0;
      if (acc >= threshold) { volBarCloses.push(b.close); acc -= threshold; }
    }
    if (volBarCloses[volBarCloses.length - 1] !== bs[bs.length - 1].close) volBarCloses.push(bs[bs.length - 1].close);
    for (let i = 1; i < volBarCloses.length; i++) volRets.push(logReturn(volBarCloses[i - 1], volBarCloses[i]));
  }

  if (timeRets.length === 0 || volRets.length === 0) return null;

  return {
    nTimeBars: timeRets.length,
    nVolBars: volRets.length,
    timeStd: stdOf(timeRets) * 100,
    volStd: stdOf(volRets) * 100,
    timeKurt: excessKurtosis(timeRets),
    volKurt: excessKurtosis(volRets),
    timeHist: stdHist(timeRets),
    volHist: stdHist(volRets),
  };
}
