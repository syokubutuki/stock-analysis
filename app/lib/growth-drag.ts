// 相関を無視してリターンを追う ＝ 長期成長率（幾何平均リターン）を削る操作
// ────────────────────────────────────────────────────────────────────────────
// docs/correlation-growth-drag-visualization.md を仕様書とする実装。
//
// 背骨となる3項分解（同ドキュメント §1）:
//
//   σ_p²  =  W²σ² · [ 1/N + (1−1/N)·ρ ]  =  W²σ²/N_eff ,  N_eff = N/(1+(N−1)ρ)
//
//   g     =  W·μ  −  W²σ²/(2N)  −  W²σ²(1−1/N)ρ/2
//            ~~~~     ~~~~~~~~~~     ~~~~~~~~~~~~~~~~
//            期待      単独ドラッグ      相関ドラッグ
//                    （避けられない）  （相関を無視した代償）
//
// 期待項は建玉 W に比例、ドラッグ項は W の二乗。だから建玉を増やすと期待は直線的に
// 伸びるのに、成長率はどこかで必ず折り返す。ρ はその折り返し点を左に引き寄せる。
//
//   N / N_eff   = 1 + (N−1)ρ      … ドラッグが何倍に膨らんだか（ボラティリティ税の倍率）
//   √(N/N_eff)  = √(1 + (N−1)ρ)   … 隠れレバレッジ倍率（思っていたリスクの何倍か）
//
// 【単位について】本ファイルの μ・Σ・g は **年率** で受け渡す。倍化年数 ln2/g が
// 年単位で意味を持つようにするため。日次系列からの換算は annualStats() を使う。
//
// 【算術平均と対数平均の取り違えに注意】aligned.returns は**対数**リターンなので、
// その平均×252 は既に幾何成長率 g そのものであって算術平均 μ ではない。ここは本
// パネルの主題そのものなので、μ は単純リターン exp(r)−1 の平均から取り、Σ は対数
// リターンの共分散から取る（差は3次の微小量）。annualStats() がこれを行う。
//
// すべて純関数・O(N²) 以下（N ≤ 30 のウォッチリスト規模）。Worker 不要。

import { niceTicks } from "./axis-scale";
import { AlignedReturns } from "./portfolio-risk";
import { powerIterationEigen } from "./ssa";

export const TRADING_DAYS = 252;

// ───────────────────────── 基本量（docs §10.1） ─────────────────────────

/** 幾何成長率 g ≈ μ − σ²/2（対数正規なら厳密）。μ は算術平均、σ はボラ（同一単位）。 */
export function geometricGrowth(mu: number, sigma: number): number {
  return mu - (sigma * sigma) / 2;
}

/** 等ウェイト・共通相関のときの実効銘柄数 N_eff = N/(1+(N−1)ρ)。 */
export function effectiveN(N: number, rho: number): number {
  if (N <= 1) return Math.max(N, 0);
  const d = 1 + (N - 1) * rho;
  if (!(d > 1e-9)) return N;
  return Math.min(N, N / d);
}

/**
 * 実データ版の実効銘柄数 N_eff = (Σw)² / (wᵀ R w)。
 * 等ウェイト・共通相関なら effectiveN(N, ρ) に一致する。
 * 相関だけでなくウェイトの偏りも織り込む（ρ=0 なら 1/Σŵ² ＝ ハーフィンダール逆数）。
 */
export function effectiveNFromWeights(w: number[], R: number[][]): number {
  const n = w.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += w[i];
  let q = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) q += w[i] * w[j] * R[i][j];
  }
  if (!(q > 1e-18)) return n;
  return Math.min(n, (sum * sum) / q);
}

/** 隠れレバレッジ倍率 √(N/N_eff)。「思っていたリスクの何倍か」。 */
export function hiddenLeverage(N: number, nEff: number): number {
  if (!(nEff > 1e-9)) return N > 0 ? Math.sqrt(N) : 1;
  return Math.sqrt(Math.max(N, 0) / nEff);
}

/** 倍化年数 ln2/g。g ≤ 0 は「永遠に来ない」＝ Infinity。 */
export function doublingYears(g: number): number {
  if (!(g > 1e-9)) return Infinity;
  return Math.LN2 / g;
}

/**
 * 倍化年数の表示。「永遠に来ない」という言い回しは doublingYears() が Infinity を返す
 * 契約と一対なので、関数の隣に置いて各パネルで書き写さないようにする
 * （YourPortfolioDragPanel / CorrelationDragChart / EfficientFrontierChart / GrowthIntuitionPanel 共通）。
 */
export function doublingYearsLabel(y: number): string {
  if (!isFinite(y)) return "永遠に来ない";
  if (y > 200) return "200年超";
  return `${y.toFixed(1)}年`;
}

// ───────────────────────── 年率統計（対数→算術の橋渡し） ─────────────────────────

export interface AnnualStats {
  tickers: string[];
  /** 算術平均リターン（年率）。単純リターン exp(r)−1 の平均×periodsPerYear。 */
  mu: number[];
  /** 共分散行列（年率）。対数リターンの標本共分散×periodsPerYear。 */
  cov: number[][];
  /** 相関行列（cov から導出）。 */
  corr: number[][];
  /** 各銘柄の年率ボラ √cov_ii。 */
  vol: number[];
  /** 実際に観測された対数平均×periodsPerYear（＝実現した幾何成長率）。 */
  logMean: number[];
  periods: number; // 標本数 T
}

/**
 * 対数リターン列から**算術平均リターン（年率）**を出す。
 *
 * ここがこのプロジェクトで最も取り違えやすい一点。`alignReturns` が返すのは対数リターン
 * なので、その平均×252 は「各銘柄の幾何平均（≒実現した成長率）」であって
 * 期待リターン μ ではない。両者の差は実測でぴったり σ²/2（σ=34% で 5.9pp、
 * σ=61% で 18.6pp）あり、**銘柄間でばらつく**ので取り違えると最適化まで歪む。
 *
 * 幾何成長率の分解 g ≈ μ_arith − σ_p²/2 に入れるべきなのは必ずこちら。
 * 対数平均を入れると σ²/2 を二重に引くことになる（実測で 9pp 過小評価）。
 * 平均は expm1 の標本平均から直接取るので、対数正規の仮定は要らない。
 */
export function arithmeticAnnualMeans(
  returns: number[][],
  periodsPerYear: number = TRADING_DAYS
): number[] {
  return returns.map((r) => {
    const T = r.length;
    if (T === 0) return 0;
    let s = 0;
    for (let t = 0; t < T; t++) s += Math.expm1(r[t]);
    return (s / T) * periodsPerYear;
  });
}

export function annualStats(
  aligned: AlignedReturns,
  periodsPerYear: number = TRADING_DAYS
): AnnualStats {
  const { tickers, returns } = aligned;
  const n = tickers.length;
  const T = returns[0]?.length ?? 0;
  const cov: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const corr: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const mu = new Array(n).fill(0);
  const logMean = new Array(n).fill(0);
  const vol = new Array(n).fill(0);
  if (n === 0 || T < 2) return { tickers, mu, cov, corr, vol, logMean, periods: T };

  // 算術平均は単純リターンから（対数平均を使うと g と μ を取り違える）
  const muArith = arithmeticAnnualMeans(returns, periodsPerYear);
  const logMeans: number[] = [];
  for (let i = 0; i < n; i++) {
    let sLog = 0;
    for (let t = 0; t < T; t++) sLog += returns[i][t];
    mu[i] = muArith[i];
    logMean[i] = (sLog / T) * periodsPerYear;
    logMeans.push(sLog / T);
  }

  for (let a = 0; a < n; a++) {
    for (let b = a; b < n; b++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += (returns[a][t] - logMeans[a]) * (returns[b][t] - logMeans[b]);
      const c = (s / (T - 1)) * periodsPerYear;
      cov[a][b] = c;
      cov[b][a] = c;
    }
  }
  for (let i = 0; i < n; i++) vol[i] = Math.sqrt(Math.max(cov[i][i], 0));
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      const d = vol[a] * vol[b];
      corr[a][b] = d > 1e-18 ? cov[a][b] / d : a === b ? 1 : 0;
    }
  }
  return { tickers, mu, cov, corr, vol, logMean, periods: T };
}

// ───────────────────────── 3項分解（G2 ウォーターフォール） ─────────────────────────

export interface DragDecomp {
  ok: boolean;
  /** W·μ ＝ 期待リターン（見かけ）。年率。 */
  expected: number;
  /** Σ w_i² σ_i² / 2 ＝ 単独ドラッグ（相関ゼロでも避けられない分）。年率・正の値。 */
  soloDrag: number;
  /** σ_p²/2 − soloDrag ＝ 相関ドラッグ（相関を無視した代償）。年率・正の値（負相関なら負）。 */
  corrDrag: number;
  /** g = expected − σ_p²/2 ＝ 実際に増える速さ。年率。 */
  growth: number;
  /** 相関がゼロだった場合の成長率 expected − soloDrag。倍化年数の対比に使う。 */
  growthNoCorr: number;
  /** ポートフォリオの年率ボラ σ_p。 */
  sigmaP: number;
  /** 総建玉 W = Σ w_i（分割なら 1、増し玉なら銘柄数ぶん）。 */
  exposure: number;
  nAssets: number;
  nEff: number;
  /** N / N_eff ＝ ボラティリティ税が何倍に膨らんだか。 */
  taxMultiple: number;
  hiddenLev: number;
  doublingYears: number;
  doublingYearsNoCorr: number;
  /** 平均相関（非対角の単純平均）。表示用。 */
  avgCorr: number;
}

export const EMPTY_DECOMP: DragDecomp = {
  ok: false,
  expected: 0,
  soloDrag: 0,
  corrDrag: 0,
  growth: 0,
  growthNoCorr: 0,
  sigmaP: 0,
  exposure: 0,
  nAssets: 0,
  nEff: 0,
  taxMultiple: 1,
  hiddenLev: 1,
  doublingYears: Infinity,
  doublingYearsNoCorr: Infinity,
  avgCorr: 0,
};

/**
 * 実データ版の3項分解。mu・cov は年率、w は正規化しない生のウェイト
 * （分割 = 合計1、増し玉 = 各1）。ウェイト 0 の銘柄は自動的に除外される。
 */
export function decomposeDrag(mu: number[], cov: number[][], w: number[]): DragDecomp {
  const idx: number[] = [];
  for (let i = 0; i < w.length; i++) if (Math.abs(w[i]) > 1e-12) idx.push(i);
  if (idx.length === 0) return EMPTY_DECOMP;

  let expected = 0;
  for (const i of idx) expected += w[i] * mu[i];

  let portVar = 0;
  for (const a of idx) for (const b of idx) portVar += w[a] * w[b] * cov[a][b];
  portVar = Math.max(portVar, 0);

  let soloDrag = 0;
  for (const i of idx) soloDrag += w[i] * w[i] * cov[i][i];
  soloDrag /= 2;

  const totalDrag = portVar / 2;
  const corrDrag = totalDrag - soloDrag;
  const growth = expected - totalDrag;
  const growthNoCorr = expected - soloDrag;

  // 相関行列とウェイトから N_eff
  const sub = idx.map((i) => w[i]);
  const R: number[][] = idx.map((a) =>
    idx.map((b) => {
      const d = Math.sqrt(Math.max(cov[a][a], 0) * Math.max(cov[b][b], 0));
      return d > 1e-18 ? cov[a][b] / d : a === b ? 1 : 0;
    })
  );
  const nAssets = idx.length;
  const nEff = effectiveNFromWeights(sub, R);
  const hiddenLev = hiddenLeverage(nAssets, nEff);
  const taxMultiple = nEff > 1e-9 ? nAssets / nEff : nAssets;

  let cs = 0;
  let cn = 0;
  for (let a = 0; a < nAssets; a++) {
    for (let b = a + 1; b < nAssets; b++) {
      cs += R[a][b];
      cn++;
    }
  }

  return {
    ok: true,
    expected,
    soloDrag,
    corrDrag,
    growth,
    growthNoCorr,
    sigmaP: Math.sqrt(portVar),
    exposure: idx.reduce((s, i) => s + w[i], 0),
    nAssets,
    nEff,
    taxMultiple,
    hiddenLev,
    doublingYears: doublingYears(growth),
    doublingYearsNoCorr: doublingYears(growthNoCorr),
    avgCorr: cn > 0 ? cs / cn : 0,
  };
}

// ───────────────────────── 崖（G1・Phase2 で使用） ─────────────────────────

/**
 * g(W) = W·μ − W²σ²/(2N) − W²σ²(1−1/N)ρ/2 を wGrid 上で評価する。
 * mu・sigmaSingle は年率、N は銘柄数、rho は共通相関。
 */
export function growthCurve(
  mu: number,
  sigmaSingle: number,
  N: number,
  rho: number,
  wGrid: number[]
): { w: number; g: number }[] {
  const s2 = sigmaSingle * sigmaSingle;
  const n = Math.max(N, 1);
  const solo = s2 / (2 * n);
  const corr = (s2 * (1 - 1 / n) * rho) / 2;
  return wGrid.map((w) => ({ w, g: w * mu - w * w * solo - w * w * corr }));
}

/** 成長率が最大になる建玉 W* = μ / σ_eff²（σ_eff = 単一ベット換算のボラ）。 */
export function peakExposure(mu: number, sigmaEff: number): number {
  const v = sigmaEff * sigmaEff;
  if (!(v > 1e-18)) return Infinity;
  return mu / v;
}

// ─────────────── iso-growth 等高線（G6・μ–σ 平面に重ねる地形図） ───────────────
//
// g = μ − σ²/2 が一定になる点の集合は μ = g + σ²/2、すなわち**上向きの放物線**。
// σ が大きいほど同じ g を保つのに高い μ が必要になる ＝ ボラティリティ税の分だけ上へ
// 持ち上がる。効率的フロンティアはこの等高線群を下向きに横切るので、
// 「フロンティアの右上端＝最も儲かる点」ではないことが図として出る。
//
// 描画（ピクセル変換）から独立した純粋なジオメトリなのでライブラリ側に置く。

/**
 * μ–σ 平面の矩形 [sigmaLo, sigmaHi] × [muLo, muHi] を覆う等高線の水準 g を列挙する。
 * g は σ について単調減少・μ について単調増加なので、値域は四隅から決まる。
 */
export function isoGrowthLevels(
  sigmaLo: number,
  sigmaHi: number,
  muLo: number,
  muHi: number,
  target = 9
): number[] {
  const gLo = geometricGrowth(muLo, sigmaHi); // 右下の隅が最小
  const gHi = geometricGrowth(muHi, sigmaLo); // 左上の隅が最大
  return niceTicks(gLo, gHi, target);
}

/**
 * 水準 g の等高線 μ = g + σ²/2 を σ ∈ [sigmaLo, sigmaHi] で標本化する。
 * muLo/muHi の外に出る点は落とす（矩形でクリップした可視部分だけを返す）。
 */
export function isoGrowthCurve(
  g: number,
  sigmaLo: number,
  sigmaHi: number,
  muLo: number,
  muHi: number,
  samples = 80
): { sigma: number; mu: number }[] {
  const out: { sigma: number; mu: number }[] = [];
  for (let i = 0; i <= samples; i++) {
    const sigma = sigmaLo + ((sigmaHi - sigmaLo) * i) / samples;
    const mu = g + (sigma * sigma) / 2;
    if (mu < muLo || mu > muHi) continue;
    out.push({ sigma, mu });
  }
  return out;
}

// ───────────────────────── 主成分の集中度（G5 3枚目の円グラフ） ─────────────────────────

/**
 * 相関行列 R の固有値から「あなたのポートフォリオは実質いくつの賭けか」を主成分で見る。
 * 相関行列の対角和は必ず n なので、寄与率は λ_k / n。PC1 が大きいほど
 * 「全銘柄が同じ1つの因子に乗っている」＝実質1つの賭け。
 *
 * 固有値は既存の powerIterationEigen（ssa.ts）を再利用する（同じ数値手続きを二重定義しない）。
 * 上位 topK 個だけを求め、残差は「その他」として 1 本にまとめる。
 */
export interface VarianceConcentration {
  /** 上位主成分の寄与率（合計 ≤ 1）。降順。 */
  shares: number[];
  /** 上位に入らなかったぶんの合計。 */
  rest: number;
  /** PC1 の寄与率。 */
  pc1: number;
  n: number;
}

export function varianceConcentration(R: number[][], topK = 3): VarianceConcentration {
  const n = R.length;
  if (n === 0) return { shares: [], rest: 0, pc1: 0, n: 0 };
  if (n === 1) return { shares: [1], rest: 0, pc1: 1, n: 1 };
  const k = Math.max(1, Math.min(topK, n));
  const { eigvals } = powerIterationEigen(R, n, k);
  const shares = eigvals.map((v) => Math.max(0, Math.min(1, v / n)));
  const used = shares.reduce((s, v) => s + v, 0);
  return { shares, rest: Math.max(0, 1 - used), pc1: shares[0] ?? 0, n };
}

// ───────────────────────── 台帳（T1） ─────────────────────────

/**
 * 組み入れモード。
 *  - "split": 100万を N 分割（総建玉は常に 1）。本物の分散。
 *  - "add"  : 各銘柄に同じ金額を張り続ける（総建玉は銘柄数ぶん）。＝実質レバレッジ。
 */
export type LedgerMode = "split" | "add";

export interface LedgerRow {
  ticker: string;
  name: string;
  /** 直前までのバスケット（等加重）との相関。1銘柄目は NaN。 */
  corrToPrev: number;
  expected: number;
  sigmaP: number;
  /** 総ドラッグ σ_p²/2（＝単独＋相関）。 */
  drag: number;
  soloDrag: number;
  corrDrag: number;
  growth: number;
  doublingYears: number;
  nEff: number;
  hiddenLev: number;
  exposure: number;
  /** 成長率が最大になった行（この次から足すほど遅くなる）。 */
  isPeak: boolean;
}

/**
 * 銘柄を order の順に1つずつ組み入れていく台帳。
 * 期待リターンの列が伸び続ける一方で、成長率の列がどこで沈み始めるかを見せる。
 *
 * exposure は総建玉の倍率（既定 1 ＝ 従来どおり）。"split" なら常に exposure、
 * "add" なら k×exposure が総建玉になる。
 */
export function incrementalLedger(
  aligned: AlignedReturns,
  order: string[],
  mode: LedgerMode,
  names?: Record<string, string>,
  periodsPerYear: number = TRADING_DAYS,
  exposure: number = 1
): LedgerRow[] {
  const st = annualStats(aligned, periodsPerYear);
  const pos = new Map<string, number>();
  aligned.tickers.forEach((t, i) => pos.set(t, i));
  const idxOrder = order.map((t) => pos.get(t)).filter((v): v is number => v !== undefined);
  if (idxOrder.length === 0) return [];

  const rows: LedgerRow[] = [];
  const included: number[] = [];

  for (const next of idxOrder) {
    // 追加前のバスケット（等加重）との相関
    let corrToPrev = NaN;
    if (included.length > 0) {
      // Corr(r_next, (1/k)Σ r_j) = Σ cov(next,j) / (k·σ_next·σ_basket)
      let covSum = 0;
      for (const j of included) covSum += st.cov[next][j];
      let basketVar = 0;
      for (const a of included) for (const b of included) basketVar += st.cov[a][b];
      const k = included.length;
      const denom = st.vol[next] * Math.sqrt(Math.max(basketVar, 0) / (k * k)) * k;
      corrToPrev = denom > 1e-18 ? covSum / denom : 0;
    }

    included.push(next);
    const k = included.length;
    const w = new Array(aligned.tickers.length).fill(0);
    for (const i of included) w[i] = mode === "split" ? exposure / k : exposure;

    const d = decomposeDrag(st.mu, st.cov, w);
    rows.push({
      ticker: aligned.tickers[next],
      name: names?.[aligned.tickers[next]] || aligned.tickers[next],
      corrToPrev,
      expected: d.expected,
      sigmaP: d.sigmaP,
      drag: d.soloDrag + d.corrDrag,
      soloDrag: d.soloDrag,
      corrDrag: d.corrDrag,
      growth: d.growth,
      doublingYears: d.doublingYears,
      nEff: d.nEff,
      hiddenLev: d.hiddenLev,
      exposure: d.exposure,
      isPeak: false,
    });
  }

  // 成長率が最大の行＝ここから先は足すほど遅くなる
  let best = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].growth > rows[best].growth) best = i;
  if (rows.length > 0) rows[best].isPeak = true;
  return rows;
}

/**
 * 「似た銘柄をどんどん買う」順序を作る。seed から始めて、以降は
 * 現在のバスケット（等加重）との相関が最も高い銘柄を貪欲に選ぶ。
 * seed 省略時は他銘柄との平均相関が最も高い銘柄（＝最も中心的な銘柄）。
 */
export function orderByCorrelation(
  aligned: AlignedReturns,
  universe?: string[],
  seed?: string
): string[] {
  const st = annualStats(aligned);
  const pos = new Map<string, number>();
  aligned.tickers.forEach((t, i) => pos.set(t, i));
  const pool = (universe ?? aligned.tickers)
    .map((t) => pos.get(t))
    .filter((v): v is number => v !== undefined);
  if (pool.length === 0) return [];

  let first = pool[0];
  const seedIdx = seed !== undefined ? pos.get(seed) : undefined;
  if (seedIdx !== undefined && pool.includes(seedIdx)) {
    first = seedIdx;
  } else {
    let bestAvg = -Infinity;
    for (const i of pool) {
      let s = 0;
      let n = 0;
      for (const j of pool) {
        if (i === j) continue;
        s += st.corr[i][j];
        n++;
      }
      const avg = n > 0 ? s / n : 0;
      if (avg > bestAvg) {
        bestAvg = avg;
        first = i;
      }
    }
  }

  const chosen = [first];
  const rest = pool.filter((i) => i !== first);
  while (rest.length > 0) {
    let bestI = 0;
    let bestC = -Infinity;
    for (let r = 0; r < rest.length; r++) {
      const i = rest[r];
      let s = 0;
      for (const j of chosen) s += st.corr[i][j];
      const avg = s / chosen.length;
      if (avg > bestC) {
        bestC = avg;
        bestI = r;
      }
    }
    chosen.push(rest[bestI]);
    rest.splice(bestI, 1);
  }
  return chosen.map((i) => aligned.tickers[i]);
}

// ───────────────────────── シミュレーション（U1 / S1 / S2・Phase2-3） ─────────────────────────

// seeded RNG（プロジェクト既存の mulberry32 パターン）。
// U3 エルゴード性デモ（GrowthIntuitionPanel）でもコイン投げに使うため export する。
// 同じ手続きを二重定義しないための共有。
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normals(rng: () => number, n: number): number[] {
  const out: number[] = [];
  while (out.length < n) {
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    const r = Math.sqrt(-2 * Math.log(u1));
    out.push(r * Math.cos(2 * Math.PI * u2));
    if (out.length < n) out.push(r * Math.sin(2 * Math.PI * u2));
  }
  return out;
}

export interface ShockOpts {
  N: number;
  T: number;
  paths: number;
  seed: number;
}

export interface Shocks {
  /** 共通ファクター [path][t] */
  f: number[][];
  /** 個別ノイズ [path][asset][t] */
  e: number[][][];
  opts: ShockOpts;
}

/**
 * 乱数だけを先に固定する。ρ スライダーを動かしても同じ f・e を混ぜ直すだけにすることで
 * 「同じ乱数の世界で、相関だけが変わった」ことを視覚的に保証する（docs §U1 / §10.6）。
 */
export function generateShocks(opts: ShockOpts): Shocks {
  const rng = mulberry32(opts.seed);
  const f: number[][] = [];
  const e: number[][][] = [];
  for (let p = 0; p < opts.paths; p++) {
    f.push(normals(rng, opts.T));
    const ea: number[][] = [];
    for (let i = 0; i < opts.N; i++) ea.push(normals(rng, opts.T));
    e.push(ea);
  }
  return { f, e, opts };
}

export interface SynthOpts {
  N: number;
  rho: number;
  /** 年率の算術平均リターン */
  mu: number;
  /** 年率ボラ（単独銘柄） */
  sigma: number;
  /** 期間の本数（営業日） */
  T: number;
  paths: number;
  seed: number;
  /** 総建玉（1 = 資産全額を等分） */
  exposure?: number;
  periodsPerYear?: number;
}

export interface SynthResult {
  /** 代表1パスの各銘柄の累積対数資産 [asset][t]（U1 の同期アニメ用） */
  perAsset: number[][];
  /** 各パスのポートフォリオ累積対数資産 [path][t]（S1 レース / S2 ファン用） */
  portfolio: number[][];
  shocks: Shocks;
}

/**
 * r_i,t = μ/T + σ_T·(√ρ·f_t + √(1−ρ)·e_i,t) で相関 ρ の合成系列を作る。
 * shocks を渡すと乱数を再利用する（ρ だけを変えた比較ができる）。
 */
export function synthPaths(opts: SynthOpts, shocks?: Shocks): SynthResult {
  const ppy = opts.periodsPerYear ?? TRADING_DAYS;
  const W = opts.exposure ?? 1;
  const sh =
    shocks && shocks.opts.N === opts.N && shocks.opts.T === opts.T && shocks.opts.paths === opts.paths
      ? shocks
      : generateShocks({ N: opts.N, T: opts.T, paths: opts.paths, seed: opts.seed });

  const rho = Math.min(Math.max(opts.rho, 0), 1);
  const cf = Math.sqrt(rho);
  const cn = Math.sqrt(1 - rho);
  const sigStep = opts.sigma / Math.sqrt(ppy);
  const muStep = opts.mu / ppy;

  const perAsset: number[][] = [];
  for (let i = 0; i < opts.N; i++) {
    const line: number[] = [0];
    let acc = 0;
    for (let t = 0; t < opts.T; t++) {
      const shock = cf * sh.f[0][t] + cn * sh.e[0][i][t];
      const r = muStep + sigStep * shock;
      acc += r - (sigStep * sigStep) / 2; // 対数資産（単純リターン→対数の変換ぶん）
      line.push(acc);
    }
    perAsset.push(line);
  }

  const portfolio: number[][] = [];
  for (let p = 0; p < opts.paths; p++) {
    const line: number[] = [0];
    let acc = 0;
    for (let t = 0; t < opts.T; t++) {
      let rp = 0;
      for (let i = 0; i < opts.N; i++) {
        const shock = cf * sh.f[p][t] + cn * sh.e[p][i][t];
        rp += (muStep + sigStep * shock) / opts.N;
      }
      rp *= W;
      acc += Math.log1p(Math.max(rp, -0.999));
      line.push(acc);
    }
    portfolio.push(line);
  }

  return { perAsset, portfolio, shocks: sh };
}

/** パス束 [path][t] から分位ファン [q][t] を作る。 */
export function quantileFan(paths: number[][], qs: number[]): number[][] {
  const T = paths[0]?.length ?? 0;
  const out: number[][] = qs.map(() => new Array(T).fill(0));
  const buf = new Array(paths.length).fill(0);
  for (let t = 0; t < T; t++) {
    for (let p = 0; p < paths.length; p++) buf[p] = paths[p][t];
    const sorted = [...buf].sort((a, b) => a - b);
    qs.forEach((q, qi) => {
      const idx = q * (sorted.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      out[qi][t] = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    });
  }
  return out;
}
