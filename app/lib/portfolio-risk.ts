// ポートフォリオ関係性分析 (方向D)
// 複数銘柄のリターン系列を共通日付で整列し、相関行列・合算VaR/CVaR・
// 集中度・各銘柄のリスク寄与を算出する。単一銘柄分析と違い「銘柄間」を見る。
//
// 設計: ダッシュボードが取得済みの価格(PortfolioData)をそのまま渡す。
// 相関行列は全銘柄を対象、加重ポートフォリオ指標は建玉(株数>0)のみを対象。

import { PricePoint } from "./types";

export interface AlignedReturns {
  tickers: string[];
  dates: string[]; // リターンの対象日(length T)
  returns: number[][]; // [asset][t] 対数リターン
  vols: number[]; // 各資産の日次標準偏差
}

// 共通日付で対数リターンを整列する。
export function alignReturns(
  series: { ticker: string; prices: PricePoint[] }[],
  window: number
): AlignedReturns {
  const valid = series.filter((s) => s.prices.length > 2);
  if (valid.length < 2) return { tickers: [], dates: [], returns: [], vols: [] };

  // 各銘柄の date->close マップ
  const maps = valid.map((s) => {
    const m = new Map<string, number>();
    for (const p of s.prices) if (p.close > 0) m.set(p.time, p.close);
    return m;
  });

  // 共通日付(全銘柄に存在)の積集合
  let common = [...maps[0].keys()];
  for (let i = 1; i < maps.length; i++) {
    const mi = maps[i];
    common = common.filter((d) => mi.has(d));
  }
  common.sort();
  if (common.length < 12) return { tickers: [], dates: [], returns: [], vols: [] };

  // 直近 window+1 日に限定
  if (common.length > window + 1) common = common.slice(common.length - (window + 1));

  const returns: number[][] = [];
  for (const m of maps) {
    const r: number[] = [];
    for (let t = 1; t < common.length; t++) {
      const c0 = m.get(common[t - 1])!;
      const c1 = m.get(common[t])!;
      r.push(c0 > 0 && c1 > 0 ? Math.log(c1 / c0) : 0);
    }
    returns.push(r);
  }

  const vols = returns.map((r) => std(r));

  return {
    tickers: valid.map((s) => s.ticker),
    dates: common.slice(1),
    returns,
    vols,
  };
}

export interface CorrelationMatrix {
  tickers: string[];
  matrix: number[][];
  avgCorr: number; // 非対角の平均
  topPairs: { a: string; b: string; corr: number }[]; // 相関の高い順
}

export function correlationMatrix(aligned: AlignedReturns): CorrelationMatrix {
  const { tickers, returns } = aligned;
  const n = tickers.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const pairs: { a: string; b: string; corr: number }[] = [];
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const c = pearson(returns[i], returns[j]);
      matrix[i][j] = c;
      matrix[j][i] = c;
      pairs.push({ a: tickers[i], b: tickers[j], corr: c });
      sum += c;
      count++;
    }
  }
  pairs.sort((x, y) => y.corr - x.corr);
  return {
    tickers,
    matrix,
    avgCorr: count > 0 ? sum / count : 0,
    topPairs: pairs.slice(0, 5),
  };
}

export interface RiskComponent {
  ticker: string;
  weight: number; // 構成比(0-1)
  marketValue: number;
  vol: number; // 日次σ
  pctr: number; // リスク寄与率(0-1, 合計1)
}

export interface PortfolioRisk {
  ok: boolean;
  components: RiskComponent[];
  totalMarketValue: number;
  portfolioVolDaily: number;
  portfolioVolAnnual: number;
  var95Pct: number; // 日次VaR95(正の損失率, %)
  cvar95Pct: number; // 日次CVaR95(正の損失率, %)
  diversificationRatio: number; // 加重平均σ / ポートσ (>1で分散効果)
  effectiveN: number; // 1/Σw² 有効銘柄数
}

// rawWeights: ticker -> 時価(株数×現在値)。建玉のみ。
export function portfolioRisk(
  aligned: AlignedReturns,
  rawWeights: Record<string, number>
): PortfolioRisk {
  const empty: PortfolioRisk = {
    ok: false,
    components: [],
    totalMarketValue: 0,
    portfolioVolDaily: 0,
    portfolioVolAnnual: 0,
    var95Pct: 0,
    cvar95Pct: 0,
    diversificationRatio: 0,
    effectiveN: 0,
  };

  // 加重対象(時価>0 かつ整列に含まれる)を抽出
  const idx: number[] = [];
  for (let i = 0; i < aligned.tickers.length; i++) {
    const mv = rawWeights[aligned.tickers[i]];
    if (mv && mv > 0) idx.push(i);
  }
  if (idx.length < 1) return empty;

  const totalMarketValue = idx.reduce((a, i) => a + rawWeights[aligned.tickers[i]], 0);
  if (totalMarketValue <= 0) return empty;

  const w = idx.map((i) => rawWeights[aligned.tickers[i]] / totalMarketValue);
  const subReturns = idx.map((i) => aligned.returns[i]);
  const subVols = idx.map((i) => aligned.vols[i]);
  const T = subReturns[0].length;
  const k = idx.length;

  // 共分散行列(daily)
  const means = subReturns.map((r) => mean(r));
  const cov: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let a = 0; a < k; a++) {
    for (let b = a; b < k; b++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += (subReturns[a][t] - means[a]) * (subReturns[b][t] - means[b]);
      const c = T > 1 ? s / (T - 1) : 0;
      cov[a][b] = c;
      cov[b][a] = c;
    }
  }

  // ポートフォリオ分散 σ_p² = wᵀΣw, (Σw)_i
  const sigmaW = new Array(k).fill(0); // Σw
  for (let a = 0; a < k; a++) {
    let s = 0;
    for (let b = 0; b < k; b++) s += cov[a][b] * w[b];
    sigmaW[a] = s;
  }
  let portVar = 0;
  for (let a = 0; a < k; a++) portVar += w[a] * sigmaW[a];
  const portVol = Math.sqrt(Math.max(portVar, 0));

  // 各銘柄のリスク寄与率 pctr_i = w_i (Σw)_i / σ_p²
  const components: RiskComponent[] = idx.map((origIdx, a) => ({
    ticker: aligned.tickers[origIdx],
    weight: w[a],
    marketValue: rawWeights[aligned.tickers[origIdx]],
    vol: subVols[a],
    pctr: portVar > 0 ? (w[a] * sigmaW[a]) / portVar : 0,
  }));
  components.sort((x, y) => y.pctr - x.pctr);

  // 履歴ベースのポートフォリオ日次リターン系列 → VaR/CVaR(ファットテール対応)
  const portRet: number[] = [];
  for (let t = 0; t < T; t++) {
    let r = 0;
    for (let a = 0; a < k; a++) r += w[a] * subReturns[a][t];
    portRet.push(r);
  }
  const var95 = -percentile(portRet, 0.05); // 正の損失率(対数リターン)
  const tail = portRet.filter((r) => r <= -var95);
  const cvar95 = tail.length > 0 ? -mean(tail) : var95;

  // 分散比・有効銘柄数
  const weightedAvgVol = w.reduce((acc, wi, a) => acc + wi * subVols[a], 0);
  const diversificationRatio = portVol > 0 ? weightedAvgVol / portVol : 0;
  const effectiveN = 1 / w.reduce((acc, wi) => acc + wi * wi, 0);

  return {
    ok: true,
    components,
    totalMarketValue,
    portfolioVolDaily: portVol,
    portfolioVolAnnual: portVol * Math.sqrt(252),
    var95Pct: var95 * 100,
    cvar95Pct: cvar95 * 100,
    diversificationRatio,
    effectiveN,
  };
}

// 任意の相関行列 R とボラ σ から、建玉ウェイトでのパラメトリック日次リスクを出す。
// DCC現在/下落日相関などを差し込んで「相関だけが変わったらVaRがどう動くか」を比較する用途。
// R/vols は aligned.tickers と同じ並び・長さ。
export interface StressRisk {
  ok: boolean;
  volDaily: number;
  volAnnual: number;
  var95Pct: number; // 正規パラメトリック日次VaR95(正の損失率, %)
  cvar95Pct: number; // 正規パラメトリックES95(%)
}

const Z95 = 1.6448536;
const ES95_FACTOR = 2.0627128; // φ(z95)/0.05

export function stressRiskFromCorr(
  aligned: AlignedReturns,
  rawWeights: Record<string, number>,
  R: number[][],
  vols: number[]
): StressRisk {
  const empty: StressRisk = { ok: false, volDaily: 0, volAnnual: 0, var95Pct: 0, cvar95Pct: 0 };
  const idx: number[] = [];
  for (let i = 0; i < aligned.tickers.length; i++) {
    const mv = rawWeights[aligned.tickers[i]];
    if (mv && mv > 0) idx.push(i);
  }
  if (idx.length < 1 || R.length !== aligned.tickers.length) return empty;
  const total = idx.reduce((a, i) => a + rawWeights[aligned.tickers[i]], 0);
  if (total <= 0) return empty;
  const w = idx.map((i) => rawWeights[aligned.tickers[i]] / total);

  let varSum = 0;
  for (let a = 0; a < idx.length; a++) {
    for (let b = 0; b < idx.length; b++) {
      const ia = idx[a];
      const ib = idx[b];
      varSum += w[a] * w[b] * R[ia][ib] * vols[ia] * vols[ib];
    }
  }
  const volDaily = Math.sqrt(Math.max(varSum, 0));
  return {
    ok: true,
    volDaily,
    volAnnual: volDaily * Math.sqrt(252),
    var95Pct: Z95 * volDaily * 100,
    cvar95Pct: ES95_FACTOR * volDaily * 100,
  };
}

// ---- 数値ユーティリティ ----

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

function std(a: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1));
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  const denom = Math.sqrt(va * vb);
  return denom > 0 ? cov / denom : 0;
}

// 線形補間による分位点(p: 0-1)
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
