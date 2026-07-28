// 系C26「個別銘柄のドリフトは同定できるか（μ の識別限界）」の計算層。
//
// C25（特性ソート・ポートフォリオ）の一段手前に残る問いは
//   「個別銘柄の μ を直接見て、ドリフトの高い銘柄を選べばよいのでは？」
// これに正面から答える。答えは数式の側で先に決まっている:
//
//   μ̂ の標準誤差は SE(μ̂) = σ/√T（Merton 1980）。σ と違い、サンプリング頻度を上げても縮まない。
//   実際、対数リターンの標本平均は μ̂ = log(P_T/P_0)/T ＝ 両端の2点しか使わない恒等式で、
//   日足を分足にしても μ̂ の値そのものが変わらない。情報は「期間の長さ」からしか来ない。
//
// σ=30%/年・T=10年 なら SE(μ̂)≈9.5pp/年。市場に対する超過 Δμ=5pp を t>2 で拾うには
//   T* = (κσ/Δμ)² = (2×0.30/0.05)² ≈ 144年 が要る。個別銘柄のドリフト同定は原理的に不可能に近い。
//
// さらに N 銘柄から μ̂ 最大を選ぶと、真の μ が全銘柄同一でも勝者は
//   E[μ̂_max − μ̄] ≈ SE·√(2 ln N) だけ上振れて見える（winner's curse＝生存者バイアスの中核）。
//
// 本モジュールはこれを「主張」でなく「実測」として出す:
//   L1 銘柄別ドリフト表（μ̂・SE・t・95%CI・必要年数 T*・α/β）
//   L2 winner's curse（真のμ同一というヌルの下でトップがどれだけ抜けて見えるかをブート実測）
//   L3 Merton の非対称性（サンプリング頻度を上げても μ̂ の SE は縮まない／σ̂ は √n で縮む）
//   L4 James-Stein 収縮と順位の不安定性（見かけの差のうち何割がノイズか・順位95%CI）
//   L5 前向き検証（「過去ドリフト上位」を1特性として WF で床＝等加重に勝てるか）
//
// 誠実な既定結果は「同定不能」。それが C24（参加）と C25（特性ソート）を選択でなく強制にする。

import { PricePoint } from "./types";
import { mean, std, tTest, benjaminiHochberg } from "./stats-significance";

const TRADING_DAYS = 252;
/** パネルに必要な最小営業日数（≒2年）。 */
const MIN_PANEL_DAYS = 500;

export interface DriftIdParams {
  /** C16 の t ハードル（採用に必要な |t|）。 */
  kappa: number;
  /** 必要年数 T* を測る対象の超過ドリフト（年率, 例 0.05=5pp）。 */
  targetExcess: number;
  /** ブートストラップ反復回数。 */
  nBoot: number;
  /** 移動ブロック長（営業日）。系列相関と横断相関を保つ。 */
  blockDays: number;
  /** 前向き検証で「過去ドリフト」を測る窓（年）。 */
  lookbackYears: number;
  /** 前向き検証のリバランス間隔（営業日）。 */
  rebalanceDays: number;
  /** 前向き検証でロングする上位分位。 */
  quantile: number;
  /** 片道コスト（bp）。 */
  costBps: number;
  /** 乱数シード（再現性）。 */
  seed: number;
}

export const DEFAULT_DRIFT_ID_PARAMS: DriftIdParams = {
  kappa: 2.0,
  targetExcess: 0.05,
  nBoot: 2000,
  blockDays: 21,
  lookbackYears: 3,
  rebalanceDays: 21,
  quantile: 0.3,
  costBps: 10,
  seed: 20260729,
};

export interface TickerDrift {
  ticker: string;
  /** 年率 対数ドリフト μ̂_log（＝成長率の推定）。 */
  muLog: number;
  /** 年率 算術ドリフト（期待リターン）。 */
  muArith: number;
  /** 年率ボラ σ̂。 */
  sigma: number;
  /** SE(μ̂) = σ/√T。サンプリング頻度では縮まない。 */
  seMu: number;
  /** t = μ̂/SE（μ=0 に対する検定）。 */
  tMu: number;
  ciMuLo: number;
  ciMuHi: number;

  /** 市場（等加重）に対する超過ドリフト Δμ（年率, 対数）。 */
  excessMu: number;
  /** 超過のトラッキング誤差（年率）。 */
  excessSigma: number;
  seExcess: number;
  tExcess: number;
  ciExLo: number;
  ciExHi: number;
  pExcess: number;
  /** 全銘柄横断の BH-FDR 補正後 q 値。 */
  qExcess: number;

  /** 観測された Δμ を t>κ にするのに必要な年数 T*=(κσ_ex/Δμ)²。 */
  requiredYearsObserved: number;
  /** 目標 Δμ（targetExcess）を t>κ で検出するのに必要な年数。 */
  requiredYearsTarget: number;

  /** 市場回帰: r_i = α + β·r_mkt + ε。 */
  beta: number;
  alpha: number;
  seAlpha: number;
  tAlpha: number;

  /** ブートでの順位（1=最上位）の 5%/95% 分位と1位確率。 */
  rankLo: number;
  rankHi: number;
  pRankTop: number;
  /** 観測順位（muLog 降順, 1始まり）。 */
  rankObserved: number;

  /** James-Stein 収縮後の μ。 */
  muShrunk: number;
  /** データが終端まで届くか（生存者バイアス診断）。 */
  survivesToEnd: boolean;
  /** |t_excess| > κ かつ q<0.1。既定ではほぼ全銘柄 false。 */
  identifiable: boolean;
}

export interface WinnerCurse {
  nBoot: number;
  /** 観測: μ̂ 最大 − 横断平均（年率）。 */
  topLeadObserved: number;
  /** 観測: μ̂ 最大 − 2位（年率）。 */
  gapObserved: number;
  /** 観測: μ̂ 最大 − 最小（年率）。 */
  spreadObserved: number;
  /** ヌル（真の μ が全銘柄同一）下での「最大 − 平均」の平均＝勝者の見かけ上の上振れ。 */
  topLeadNullMean: number;
  /** 同 95 分位。 */
  topLeadNull95: number;
  /** 同 スプレッド（最大−最小）の平均。 */
  spreadNullMean: number;
  spreadNull95: number;
  /** 理論近似 SE·√(2 ln N)。 */
  theoryApprox: number;
  /** 観測の topLead がヌル分布のどこにあるか（片側 p）。 */
  pTopLead: number;
  /** 観測のスプレッドがヌル分布のどこにあるか（片側 p）。 */
  pSpread: number;
  /** ヒストグラム描画用（topLead のヌル分布）。 */
  hist: { binLo: number; binHi: number; count: number }[];
  /** 勝者の名目 μ̂ のうちノイズで説明される割合（topLeadNullMean / topLeadObserved）。 */
  noiseShare: number;
}

export interface ShrinkResult {
  /** 残存比率 c（0=全部ノイズ・1=全部本物）。 */
  c: number;
  grandMean: number;
  spreadBefore: number;
  spreadAfter: number;
  /** 平均推定分散 s²（＝SE² の平均）。 */
  meanSe: number;
  /** 順位のブート安定性: 観測順位とブート順位の平均 Spearman。 */
  rankSpearman: number;
}

export interface FreqRow {
  days: number;
  label: string;
  nObs: number;
  muAnn: number;
  seMuAnn: number;
  sigmaAnn: number;
  seSigmaAnn: number;
}

export interface EquityPoint {
  time: string;
  value: number;
}

export interface WalkForwardResult {
  nPeriods: number;
  years: number;
  annTilt: number;
  annFloor: number;
  excessAnn: number;
  netExcessAnn: number;
  tExcess: number;
  pExcess: number;
  turnoverPerYear: number;
  avgLong: number;
  equityTilt: EquityPoint[];
  equityFloor: EquityPoint[];
  passes: boolean;
}

export interface DriftIdResult {
  ok: boolean;
  reason?: string;
  rows: TickerDrift[];
  panel: {
    from: string;
    to: string;
    years: number;
    nDays: number;
    nTickers: number;
    dropped: string[];
  };
  /** 市場（等加重）自身のドリフト＝C24 の床。 */
  market: { muLog: number; muArith: number; sigma: number; seMu: number; tMu: number };
  winner: WinnerCurse;
  shrink: ShrinkResult;
  /** ticker → 頻度ラダー。"__MKT__" は等加重市場。 */
  freqLadders: Record<string, FreqRow[]>;
  wf: WalkForwardResult | null;
  survivorsToEnd: number;
  verdict: {
    identifiableCount: number;
    /** 目標 Δμ を現在の期間で検出する検出力があるか（T ≥ T*_target の銘柄数）。 */
    poweredCount: number;
    /** 全銘柄の T*_target の中央値（年）。 */
    medianRequiredYears: number;
  };
  kappa: number;
  targetExcess: number;
}

// --- 乱数（再現性のため seeded） -------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantileOf(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** 単回帰 y = a + b·x。 */
function ols(x: number[], y: number[]): { a: number; b: number; resid: number[] } {
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i] - mx) * (y[i] - my);
    den += (x[i] - mx) ** 2;
  }
  const b = den > 0 ? num / den : 0;
  const a = my - b * mx;
  const resid = y.map((v, i) => v - a - b * x[i]);
  return { a, b, resid };
}

/**
 * k 日集計の対数リターンから頻度ラダー1行を作る。
 * μ̂ は集計頻度に依らない（telescoping: Σr = log(P_T/P_0)）が、σ̂ の精度は観測数で決まる。
 */
function freqRow(logRets: number[], k: number, label: string): FreqRow {
  const agg: number[] = [];
  for (let i = 0; i + k <= logRets.length; i += k) {
    let s = 0;
    for (let j = 0; j < k; j++) s += logRets[i + j];
    agg.push(s);
  }
  const n = agg.length;
  const perYear = TRADING_DAYS / k;
  const m = n ? mean(agg) : 0;
  const sd = n > 1 ? std(agg) : 0;
  const muAnn = m * perYear;
  const sigmaAnn = sd * Math.sqrt(perYear);
  const years = n / perYear;
  return {
    days: k,
    label,
    nObs: n,
    muAnn,
    seMuAnn: years > 0 ? sigmaAnn / Math.sqrt(years) : 0,
    sigmaAnn,
    // SE(σ̂) ≈ σ/√(2n)（正規近似）。観測数 n が増えるほど縮む＝μ との非対称性。
    seSigmaAnn: n > 1 ? sigmaAnn / Math.sqrt(2 * n) : 0,
  };
}

function oneWayTurnover(prev: Set<string>, next: Set<string>): number {
  if (prev.size === 0) return next.size ? 1 : 0;
  const wPrev = prev.size ? 1 / prev.size : 0;
  const wNext = next.size ? 1 / next.size : 0;
  let sum = 0;
  for (const t of new Set([...prev, ...next])) {
    sum += Math.abs((next.has(t) ? wNext : 0) - (prev.has(t) ? wPrev : 0));
  }
  return sum / 2;
}

// --- メイン ------------------------------------------------------------------
export function computeDriftIdentifiability(
  pricesByTicker: Record<string, PricePoint[]>,
  params: DriftIdParams
): DriftIdResult {
  const { kappa, targetExcess, nBoot, blockDays, lookbackYears, rebalanceDays, quantile, costBps, seed } =
    params;

  // 1) 各銘柄の日付→終値。共通日付（全銘柄が値を持つ日）でパネルを組む。
  const maps: Record<string, Map<string, number>> = {};
  const lastDateOf: Record<string, string> = {};
  const allTickers = Object.keys(pricesByTicker).filter((tk) => (pricesByTicker[tk]?.length ?? 0) > 0);
  for (const tk of allTickers) {
    const m = new Map<string, number>();
    for (const p of pricesByTicker[tk]) if (p.close > 0) m.set(p.time, p.close);
    maps[tk] = m;
    const dates = [...m.keys()].sort();
    lastDateOf[tk] = dates[dates.length - 1] ?? "";
  }
  if (allTickers.length < 3) return empty("個別ドリフトの識別限界には最低3銘柄が必要です。", params);

  const globalLast = Object.values(lastDateOf).sort().pop() ?? "";

  // 終端まで届かない銘柄は共通日付を潰すので、まず終端到達で足切り（診断は残す）。
  const dropped: string[] = [];
  const alive: string[] = [];
  for (const tk of allTickers) {
    // 終端の 10 営業日以内まで届くものだけをパネルに入れる。
    if (lastDateOf[tk] >= shiftBack(globalLast, 20)) alive.push(tk);
    else dropped.push(tk);
  }
  if (alive.length < 3) return empty("共通期間を持つ銘柄が3未満です。", params);

  // 共通日付＝全銘柄の交差。
  let common: string[] = [...maps[alive[0]].keys()];
  for (let i = 1; i < alive.length; i++) {
    const m = maps[alive[i]];
    common = common.filter((d) => m.has(d));
  }
  common.sort();
  if (common.length < MIN_PANEL_DAYS) {
    return empty(
      `共通期間が短すぎます（${common.length}営業日 < ${MIN_PANEL_DAYS}）。銘柄数を絞るか期間の長い銘柄に替えてください。`,
      params
    );
  }

  // 2) 日次対数リターン行列（銘柄 × 日）。
  const T = common.length - 1;
  const R: number[][] = alive.map((tk) => {
    const m = maps[tk];
    const r: number[] = new Array(T);
    for (let t = 0; t < T; t++) {
      const p0 = m.get(common[t])!;
      const p1 = m.get(common[t + 1])!;
      r[t] = Math.log(p1 / p0);
    }
    return r;
  });
  const N = alive.length;
  const years = T / TRADING_DAYS;

  // 市場＝等加重（対数リターンの横断平均）。
  const mkt: number[] = new Array(T);
  for (let t = 0; t < T; t++) {
    let s = 0;
    for (let i = 0; i < N; i++) s += R[i][t];
    mkt[t] = s / N;
  }

  // 3) L1 銘柄別ドリフト表。
  const pRaw: number[] = [];
  const partial: (Omit<
    TickerDrift,
    "qExcess" | "rankLo" | "rankHi" | "pRankTop" | "rankObserved" | "muShrunk" | "identifiable"
  >)[] = [];

  for (let i = 0; i < N; i++) {
    const r = R[i];
    const muLog = mean(r) * TRADING_DAYS;
    const muArith = mean(r.map((v) => Math.exp(v) - 1)) * TRADING_DAYS;
    const sigma = std(r) * Math.sqrt(TRADING_DAYS);
    const seMu = sigma / Math.sqrt(years); // ＝ σ/√T。頻度では縮まない。
    const tMu = seMu > 0 ? muLog / seMu : 0;

    const d = r.map((v, t) => v - mkt[t]);
    const excessMu = mean(d) * TRADING_DAYS;
    const excessSigma = std(d) * Math.sqrt(TRADING_DAYS);
    const seExcess = excessSigma / Math.sqrt(years);
    const tExcess = seExcess > 0 ? excessMu / seExcess : 0;
    const tt = tTest(d);
    pRaw.push(tt ? tt.p : 1);

    const { a, b, resid } = ols(mkt, r);
    const alpha = a * TRADING_DAYS;
    const seAlpha = (std(resid) * Math.sqrt(TRADING_DAYS)) / Math.sqrt(years);

    partial.push({
      ticker: alive[i],
      muLog,
      muArith,
      sigma,
      seMu,
      tMu,
      ciMuLo: muLog - 1.96 * seMu,
      ciMuHi: muLog + 1.96 * seMu,
      excessMu,
      excessSigma,
      seExcess,
      tExcess,
      ciExLo: excessMu - 1.96 * seExcess,
      ciExHi: excessMu + 1.96 * seExcess,
      pExcess: tt ? tt.p : 1,
      requiredYearsObserved: excessMu !== 0 ? (kappa * excessSigma / Math.abs(excessMu)) ** 2 : Infinity,
      requiredYearsTarget: targetExcess > 0 ? (kappa * excessSigma / targetExcess) ** 2 : Infinity,
      beta: b,
      alpha,
      seAlpha,
      tAlpha: seAlpha > 0 ? alpha / seAlpha : 0,
      survivesToEnd: lastDateOf[alive[i]] >= shiftBack(globalLast, 5),
    });
  }
  const qvals = benjaminiHochberg(pRaw);

  // 4) L2/L4 ブートストラップ（移動ブロック）。ブロックは全銘柄で共有＝横断相関を保つ。
  const L = Math.max(1, Math.min(blockDays, Math.floor(T / 4)));
  const nBlocks = Math.max(1, Math.floor(T / L));
  const usedLen = nBlocks * L;

  // 前置和（生／中心化）。中心化系列は「真の μ が全銘柄同一」というヌルを課す。
  const prefRaw: Float64Array[] = [];
  const prefNull: Float64Array[] = [];
  for (let i = 0; i < N; i++) {
    const m = mean(R[i]);
    const a = new Float64Array(T + 1);
    const b = new Float64Array(T + 1);
    for (let t = 0; t < T; t++) {
      a[t + 1] = a[t] + R[i][t];
      b[t + 1] = b[t] + (R[i][t] - m);
    }
    prefRaw.push(a);
    prefNull.push(b);
  }

  const rand = mulberry32(seed);
  const scale = TRADING_DAYS / usedLen; // 合計 → 年率
  const nullTopLead: number[] = [];
  const nullSpread: number[] = [];
  const rankCount: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  let spearmanSum = 0;

  const muObs = partial.map((p) => p.muLog);
  const obsRankIdx = muObs
    .map((v, i) => ({ v, i }))
    .sort((x, y) => y.v - x.v)
    .map((o) => o.i);
  const obsRank = new Array(N).fill(0);
  obsRankIdx.forEach((idx, k) => (obsRank[idx] = k + 1));

  const starts = new Array(nBlocks).fill(0);
  const muNull = new Array(N).fill(0);
  const muRaw = new Array(N).fill(0);
  for (let b = 0; b < nBoot; b++) {
    for (let k = 0; k < nBlocks; k++) starts[k] = Math.floor(rand() * (T - L + 1));
    for (let i = 0; i < N; i++) {
      let sNull = 0;
      let sRaw = 0;
      const pn = prefNull[i];
      const pr = prefRaw[i];
      for (let k = 0; k < nBlocks; k++) {
        const s = starts[k];
        sNull += pn[s + L] - pn[s];
        sRaw += pr[s + L] - pr[s];
      }
      muNull[i] = sNull * scale;
      muRaw[i] = sRaw * scale;
    }
    // ヌル: 勝者の見かけ上のリード。
    let mx = -Infinity;
    let mn = Infinity;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      if (muNull[i] > mx) mx = muNull[i];
      if (muNull[i] < mn) mn = muNull[i];
      sum += muNull[i];
    }
    nullTopLead.push(mx - sum / N);
    nullSpread.push(mx - mn);

    // 生データ側: 順位の安定性。
    const ord = muRaw
      .map((v, i) => ({ v, i }))
      .sort((x, y) => y.v - x.v);
    let dsum = 0;
    ord.forEach((o, k) => {
      rankCount[o.i][k]++;
      const dd = k + 1 - obsRank[o.i];
      dsum += dd * dd;
    });
    spearmanSum += 1 - (6 * dsum) / (N * (N * N - 1));
  }

  nullTopLead.sort((a, b) => a - b);
  nullSpread.sort((a, b) => a - b);

  const muMean = mean(muObs);
  const muSorted = [...muObs].sort((a, b) => b - a);
  const topLeadObserved = muSorted[0] - muMean;
  const gapObserved = muSorted[0] - (muSorted[1] ?? muSorted[0]);
  const spreadObserved = muSorted[0] - muSorted[muSorted.length - 1];
  const meanSe = mean(partial.map((p) => p.seMu));
  const pTopLead = nullTopLead.filter((v) => v >= topLeadObserved).length / Math.max(1, nullTopLead.length);
  const pSpread = nullSpread.filter((v) => v >= spreadObserved).length / Math.max(1, nullSpread.length);
  const topLeadNullMean = mean(nullTopLead);

  const winner: WinnerCurse = {
    nBoot,
    topLeadObserved,
    gapObserved,
    spreadObserved,
    topLeadNullMean,
    topLeadNull95: quantileOf(nullTopLead, 0.95),
    spreadNullMean: mean(nullSpread),
    spreadNull95: quantileOf(nullSpread, 0.95),
    theoryApprox: meanSe * Math.sqrt(2 * Math.log(Math.max(2, N))),
    pTopLead,
    pSpread,
    hist: histogram(nullTopLead, 28),
    noiseShare: topLeadObserved > 0 ? Math.min(1, topLeadNullMean / topLeadObserved) : 1,
  };

  // 5) L4 James-Stein 収縮。見かけの散らばりのうち推定誤差で説明される分を削る。
  const ss = muObs.reduce((acc, v) => acc + (v - muMean) ** 2, 0);
  const s2 = mean(partial.map((p) => p.seMu ** 2));
  const c = N > 3 && ss > 0 ? Math.max(0, Math.min(1, 1 - ((N - 3) * s2) / ss)) : 0;
  const shrink: ShrinkResult = {
    c,
    grandMean: muMean,
    spreadBefore: spreadObserved,
    spreadAfter: c * spreadObserved,
    meanSe,
    rankSpearman: nBoot > 0 ? spearmanSum / nBoot : 0,
  };

  // 6) 行の完成（q値・順位CI・収縮後μ・判定）。
  const rows: TickerDrift[] = partial.map((p, i) => {
    const counts = rankCount[i];
    let cum = 0;
    let lo = 1;
    let hi = N;
    for (let k = 0; k < N; k++) {
      cum += counts[k];
      if (cum >= 0.05 * nBoot) {
        lo = k + 1;
        break;
      }
    }
    cum = 0;
    for (let k = 0; k < N; k++) {
      cum += counts[k];
      if (cum >= 0.95 * nBoot) {
        hi = k + 1;
        break;
      }
    }
    const q = qvals[i];
    return {
      ...p,
      qExcess: q,
      rankLo: lo,
      rankHi: hi,
      pRankTop: nBoot > 0 ? counts[0] / nBoot : 0,
      rankObserved: obsRank[i],
      muShrunk: muMean + c * (p.muLog - muMean),
      identifiable: Math.abs(p.tExcess) > kappa && q < 0.1,
    };
  });
  rows.sort((a, b) => b.muLog - a.muLog);

  // 7) L3 頻度ラダー（全銘柄＋市場）。
  const freqLadders: Record<string, FreqRow[]> = {};
  const ladder = (r: number[]) => [
    freqRow(r, 1, "日次"),
    freqRow(r, 5, "週次(5日)"),
    freqRow(r, 21, "月次(21日)"),
    freqRow(r, 63, "四半期(63日)"),
  ];
  for (let i = 0; i < N; i++) freqLadders[alive[i]] = ladder(R[i]);
  freqLadders["__MKT__"] = ladder(mkt);

  // 8) L5 前向き検証（「過去ドリフト上位」を1特性として WF）。
  const wf = walkForwardPastDrift(alive, maps, common, {
    lookbackDays: Math.round(lookbackYears * TRADING_DAYS),
    rebalanceDays,
    quantile,
    costBps,
  });

  const marketMu = mean(mkt) * TRADING_DAYS;
  const marketSigma = std(mkt) * Math.sqrt(TRADING_DAYS);
  const marketSe = marketSigma / Math.sqrt(years);

  const reqTargets = rows.map((r) => r.requiredYearsTarget).sort((a, b) => a - b);

  return {
    ok: true,
    rows,
    panel: {
      from: common[0],
      to: common[common.length - 1],
      years,
      nDays: T,
      nTickers: N,
      dropped,
    },
    market: {
      muLog: marketMu,
      muArith: mean(mkt.map((v) => Math.exp(v) - 1)) * TRADING_DAYS,
      sigma: marketSigma,
      seMu: marketSe,
      tMu: marketSe > 0 ? marketMu / marketSe : 0,
    },
    winner,
    shrink,
    freqLadders,
    wf,
    survivorsToEnd: rows.filter((r) => r.survivesToEnd).length,
    verdict: {
      identifiableCount: rows.filter((r) => r.identifiable).length,
      poweredCount: rows.filter((r) => r.requiredYearsTarget <= years).length,
      medianRequiredYears: quantileOf(reqTargets, 0.5),
    },
    kappa,
    targetExcess,
  };
}

// --- 前向き検証（過去ドリフト上位のチルト） ---------------------------------
function walkForwardPastDrift(
  tickers: string[],
  maps: Record<string, Map<string, number>>,
  common: string[],
  opt: { lookbackDays: number; rebalanceDays: number; quantile: number; costBps: number }
): WalkForwardResult | null {
  const { lookbackDays, rebalanceDays, quantile, costBps } = opt;
  const closes: Record<string, number[]> = {};
  for (const tk of tickers) closes[tk] = common.map((d) => maps[tk].get(d)!);

  const idx: number[] = [];
  for (let r = lookbackDays; r + rebalanceDays < common.length; r += rebalanceDays) idx.push(r);
  if (idx.length < 8) return null;

  const periodsPerYear = TRADING_DAYS / rebalanceDays;
  const oneWayCost = costBps / 1e4;
  const times: string[] = [];
  const floorRets: number[] = [];
  const tiltRets: number[] = [];
  const tiltNetRets: number[] = [];
  let prevLong = new Set<string>();
  let prevFloor = new Set<string>();
  let turnSum = 0;
  let longSum = 0;

  for (const r of idx) {
    const d2 = common[r + rebalanceDays];
    times.push(d2);
    const elig = tickers.map((tk) => {
      const c = closes[tk];
      return {
        tk,
        score: Math.log(c[r] / c[r - lookbackDays]), // 過去 lookback の実現ドリフト
        fwd: c[r + rebalanceDays] / c[r] - 1,
      };
    });
    const floorSet = new Set(elig.map((e) => e.tk));
    const floorRet = mean(elig.map((e) => e.fwd));
    const floorTurn = oneWayTurnover(prevFloor, floorSet);
    prevFloor = floorSet;
    floorRets.push(floorRet - floorTurn * oneWayCost);

    const nLong = Math.max(1, Math.round(elig.length * quantile));
    longSum += nLong;
    elig.sort((a, b) => b.score - a.score);
    const longs = elig.slice(0, nLong);
    const tiltRet = mean(longs.map((e) => e.fwd));
    const longSet = new Set(longs.map((e) => e.tk));
    const turn = oneWayTurnover(prevLong, longSet);
    prevLong = longSet;
    turnSum += turn;
    tiltRets.push(tiltRet);
    tiltNetRets.push(tiltRet - turn * oneWayCost);
  }

  const build = (rets: number[]): EquityPoint[] => {
    let eq = 1;
    return rets.map((v, i) => {
      eq *= 1 + v;
      return { time: times[i], value: eq };
    });
  };
  const n = tiltRets.length;
  const excess = tiltRets.map((v, i) => v - floorRets[i]);
  const tt = tTest(excess);
  const annTilt = mean(tiltRets) * periodsPerYear;
  const annFloor = mean(floorRets) * periodsPerYear;
  const annNet = mean(tiltNetRets) * periodsPerYear;

  return {
    nPeriods: n,
    years: n / periodsPerYear,
    annTilt,
    annFloor,
    excessAnn: annTilt - annFloor,
    netExcessAnn: annNet - annFloor,
    tExcess: tt ? tt.t : 0,
    pExcess: tt ? tt.p : 1,
    turnoverPerYear: (turnSum / Math.max(1, n)) * periodsPerYear,
    avgLong: longSum / Math.max(1, n),
    equityTilt: build(tiltNetRets),
    equityFloor: build(floorRets),
    passes: (tt ? tt.t : 0) > 2 && annNet - annFloor > 0,
  };
}

// --- 補助 --------------------------------------------------------------------
function histogram(sorted: number[], bins: number): { binLo: number; binHi: number; count: number }[] {
  if (sorted.length === 0) return [];
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  const w = (hi - lo) / bins || 1;
  const out = Array.from({ length: bins }, (_, k) => ({
    binLo: lo + k * w,
    binHi: lo + (k + 1) * w,
    count: 0,
  }));
  for (const v of sorted) {
    const k = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / w)));
    out[k].count++;
  }
  return out;
}

/** "YYYY-MM-DD" を n 暦日だけ戻した文字列（終端到達判定の緩衝用）。 */
function shiftBack(date: string, n: number): string {
  if (!date) return date;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function empty(reason: string, params: DriftIdParams): DriftIdResult {
  return {
    ok: false,
    reason,
    rows: [],
    panel: { from: "", to: "", years: 0, nDays: 0, nTickers: 0, dropped: [] },
    market: { muLog: 0, muArith: 0, sigma: 0, seMu: 0, tMu: 0 },
    winner: {
      nBoot: 0,
      topLeadObserved: 0,
      gapObserved: 0,
      spreadObserved: 0,
      topLeadNullMean: 0,
      topLeadNull95: 0,
      spreadNullMean: 0,
      spreadNull95: 0,
      theoryApprox: 0,
      pTopLead: 1,
      pSpread: 1,
      hist: [],
      noiseShare: 1,
    },
    shrink: { c: 0, grandMean: 0, spreadBefore: 0, spreadAfter: 0, meanSe: 0, rankSpearman: 0 },
    freqLadders: {},
    wf: null,
    survivorsToEnd: 0,
    verdict: { identifiableCount: 0, poweredCount: 0, medianRequiredYears: Infinity },
    kappa: params.kappa,
    targetExcess: params.targetExcess,
  };
}

/**
 * 教科書的な必要年数（実データ不要のスケール感）。
 * T* = (κ·σ / Δμ)²  ── σ=30%/年・Δμ=5pp・κ=2 なら 144年。
 */
export function requiredYears(sigma: number, deltaMu: number, kappa: number): number {
  if (deltaMu === 0) return Infinity;
  return (kappa * sigma / Math.abs(deltaMu)) ** 2;
}
