// 系C29 P2「この順位は来年も同じか」── 感応度 b の持続性・順位安定性・構造変化・非対称性。
//
// P1（sector-factor-select.ts）が答えたのは「今の b を測れるか」だけだった。
// 実測は t=8.2〜13.4 / James-Stein 収縮率 3〜5% で、**統計誤差はもう論点ではない**。
// にもかかわらず、その順位表を発注に使ってよいかは何も分かっていない。P1 が測ったのは
// 「過去3年の平均的な b」であって「明日から先の b」ではないため。
//
// b が動く原因は統計ではなく実在の経済的変化である（デュレーション短縮・貸出構成の入替・
// 金融政策レジームの転換・再編）。よって本ファイルは b̂ を3つに割る:
//
//   b̂_{i,t} = β_i + η_{i,t} + e_{i,t}
//     β_i     恒久成分（来期も残る。選別に使えるのはここだけ）
//     η_{i,t} 一時成分（実在するが来期には消える）      ← P1 は手つかず
//     e_{i,t} 推定誤差（標本ノイズ）                    ← P1 の JS 収縮が潰した
//
// 中核の推定量は「窓をずらした横断共分散」。窓が重ならなければ e は独立なので
//   Cov_i(b̂_{i,t}, b̂_{i,t+h}) = Var(β) + Cov(η_t, η_{t+h})
// となり、e を別途モデル化せずに済む。持続率は
//   π(h) = Cov_i(b̂_t, b̂_{t+h}) / [ Var_i(b̂) − mean_i(SE_i²) ]
// で、分母から推定誤差を除かないと減衰バイアスで過小評価になる。
//
// π はそのまま建玉の強さに翻訳される（§6.1 の二段収縮）:
//   b_forecast,i = b̄ + π·(b_JS,i − b̄),   w_i ∝ b_forecast,i / σ_ε,i²
// π=0 なら自動的に w ∝ 1/σ_ε²（実質リスクパリティ＝選別しない）へ退避する。
// 「持続性が無いなら選別するな」が別ルールでなく同じ式から出るのがこの設計の要。
//
// 【検出力の壁】N=16 の横断相関なので π の SE は 1/√(N−3) ≈ 0.28。単発では 0.3 と 0.8 を
// 区別できない。よって (a) 窓ペアを多数使い (b) ペア単位のブロック・ブートで CI を出し
// (c) h を複数取って減衰曲線で見て (d) 銘柄ラベルの横断シャッフルでヌルを併記する。
// **CI が 0 を跨いだら「持続性は測れていない」が結論**であり、等加重に寄せる（C16）。
//
// 設計: docs/sector-factor-stability.md

import { PricePoint } from "./types";
import {
  buildPanel,
  olsNW,
  orthogonalize,
  leaveOneOut,
  mulberry32,
  prevSessionRateDiff,
  type FactorPrices,
  type FactorSource,
  type ReturnPanel,
} from "./sector-factor-select";
import { benjaminiHochberg, studentTwoSidedP, quantileSorted } from "./stats-significance";

const TRADING_DAYS = 252;

// ════════════════════════════════════════════════════════════════════════════
// パラメータ
// ════════════════════════════════════════════════════════════════════════════

export interface StabilityParams {
  factorSource: FactorSource;
  /** 全体の標本長（営業日）。 */
  window: number;
  /** ローリング推定窓。π はこの長さの推定量に対して定義される。 */
  rollWindow: number;
  /** ローリングの刻み。 */
  rollStep: number;
  /** π を測る先読み日数 h の集合。 */
  horizons: number[];
  /** topK 生存率の k。 */
  topK: number;
  /** 1銘柄あたりのウェイト上限。 */
  maxWeight: number;
  /** ペア単位ブロック・ブートの反復数。 */
  nBoot: number;
  /**
   * supWald のヌルを作る時間ブロック長（営業日）。
   *
   * 設計書は「窓長と同じ 250日」を挙げていたが、それだと 2400日 が 10 ブロックにしかならず、
   * 再標本化しても片方のレジームが偏って残る＝**臨界値が過大**になる（実測で crit95 が
   * supW の3倍前後まで膨らみ、どの銘柄も検出できなかった）。ヌルが表すべきなのは
   * 「b は一定・ただしボラのクラスタリングは残る」なので、日次の従属が概ね収まる四半期に取る。
   */
  blockLen: number;
  /** ヌル（横断シャッフル）の反復数。 */
  nPerm: number;
  /** supWald の分割点探索の両端トリム。 */
  trim: number;
  /** 片道コスト（bps）。リバランス間隔の最適化に使う。 */
  costBps: number;
  /** 非対称ペナルティ λ（S' の計算）。 */
  lambda: number;
  /**
   * セクター因子の年率期待リターン m（＝投資家の見立て）。
   * **推定値ではなく仮定**。§6.2 のコスト曲線はチルトの粗利を金額に落とさないと
   * コストと比較できないため、ここだけ外から与える。UI に必ず「仮定」と明示すること。
   */
  assumedFactorReturn: number;
  seed: number;
}

export const DEFAULT_STABILITY_PARAMS: StabilityParams = {
  factorSource: "etf",
  window: 2400,
  rollWindow: 250,
  rollStep: 21,
  horizons: [63, 125, 250, 500],
  topK: 5,
  maxWeight: 0.35,
  nBoot: 300,
  blockLen: 63,
  nPerm: 500,
  trim: 0.15,
  costBps: 10,
  lambda: 1,
  assumedFactorReturn: 0.05,
  seed: 42,
};

/**
 * 分割点の事後ラベル（検定には使わない）。
 * 後知恵で日付を選ぶと必ず有意になるので、データに分割点を探させ、政策日は
 * 「見つかった点が経済的に説明できるか」の確認だけに使う。
 */
export const BOJ_POLICY_EVENTS: { date: string; label: string }[] = [
  { date: "2016-01-29", label: "マイナス金利導入決定" },
  { date: "2016-09-21", label: "イールドカーブ・コントロール導入" },
  { date: "2018-07-31", label: "長期金利の変動幅を柔軟化" },
  { date: "2022-12-20", label: "YCC 変動幅拡大(±0.25→±0.5%)" },
  { date: "2023-07-28", label: "YCC 運用柔軟化" },
  { date: "2023-10-31", label: "YCC 再柔軟化(1.0%を目途)" },
  { date: "2024-03-19", label: "マイナス金利解除・YCC 撤廃" },
  { date: "2024-07-31", label: "追加利上げ(0.25%)" },
  { date: "2025-01-24", label: "追加利上げ(0.5%)" },
];

// ════════════════════════════════════════════════════════════════════════════
// 型
// ════════════════════════════════════════════════════════════════════════════

/**
 * ローリング推定の1時点。
 * 配列は StabilityResult.tickers と同じ並び（Record より軽く、描画でもそのまま使える）。
 */
export interface RollPoint {
  /** 窓の終端日。 */
  date: string;
  /** 窓の始端日。 */
  from: string;
  b: number[];
  bSe: number[];
  /** 固有ボラ（年率）。 */
  sigmaEps: number[];
  /** S = b/σ_ε。 */
  score: number[];
}

export interface PersistencePoint {
  h: number;
  /** 持続率（重複窓の推定誤差共分散を補正済み）。 */
  pi: number;
  lo: number;
  hi: number;
  /** ヌル（銘柄ラベル横断シャッフル）の 95% 点。 */
  nullHi: number;
  nPairs: number;
  /** 重なりを織り込んだ実効ペア数。 */
  nEffPairs: number;
  /** 窓の重なり率 φ = max(0, 1 − h/rollWindow)。0 なら非重複。 */
  overlap: number;
}

export interface PersistenceResult {
  curve: PersistencePoint[];
  /** exp(−h/τ) フィットの τ（営業日）。フィット不能なら null。 */
  tau: number | null;
  halfLife: number | null;
  /** 意思決定に使う π（CI 下限を 0..1 にクランプした保守値）。 */
  piForDecision: number;
  /** 判断の基準にした h。 */
  decisionH: number;
  /** その h での点推定と CI。 */
  piPoint: number;
  piLo: number;
  piHi: number;
  /** CI 下限がヌル 95% 点を超えない＝持続性を測れていない。 */
  indistinguishableFromNull: boolean;
}

export interface RankStabilityPoint {
  h: number;
  rankIcB: number;
  rankIcS: number;
  icLo: number;
  icHi: number;
  topKSurvival: number;
  /** 完全ランダム入替の期待値 k/N。これが「安定」のゼロ点。 */
  survivalNull: number;
  /** 実際に発生するウェイト回転（L1・両側合計）。 */
  turnover: number;
  nPairs: number;
}

export interface RankStabilityResult {
  byHorizon: RankStabilityPoint[];
  /** 分位遷移行列（decisionH）。行=今期分位, 列=来期分位, 値=確率。 */
  transition: number[][];
  quantiles: number;
  transitionH: number;
}

export interface BreakRow {
  ticker: string;
  supW: number;
  bootP: number;
  q: number;
  breakDate: string | null;
  bBefore: number;
  bAfter: number;
  /** W(s) の経路（描画用）。 */
  path: { date: string; w: number }[];
  /** ブート臨界値（95%）。 */
  crit95: number;
}

export interface BreakResult {
  byTicker: BreakRow[];
  /**
   * 等加重バスケット（＝銘柄に共通する成分）に対する同じ検定。
   *
   * これが無いと解釈を誤る。個別銘柄で分割点が続々見つかっても、それが**全銘柄に共通の
   * 水準変化**なら順位は動いておらず、選別（＝相対の話）は何も壊れていない。
   * 共通行が有意で個別の分割点が同じ時期に集中しているなら、「b の水準が共通して動いた」
   * であって「銘柄ごとに構造が変わった」ではない。FDR には含めない（別の問い）。
   */
  common: BreakRow | null;
  consensusBreaks: { date: string; votes: number; nearestEvent: string | null; gapDays: number | null }[];
  recommendWindowFrom: string | null;
  nBootDone: number;
  warnings: string[];
}

export interface AsymmetryRow {
  ticker: string;
  bPlus: number;
  bMinus: number;
  deltaT: number;
  deltaP: number;
  deltaQ: number;
  bMktUp: number;
  bMktDown: number;
  mktDeltaT: number;
  mktDeltaP: number;
  mktDeltaQ: number;
  bRateUp: number;
  bRateDown: number;
  rateDeltaT: number;
  rateAvailable: boolean;
  sigmaEps: number;
  /** P1 と同じ S = b/σ_ε（対称の b を使った基準値）。 */
  score: number;
  /** 非対称ペナルティ後の S'。 */
  scoreAdj: number;
  verdict: "理想形" | "対称" | "下げで強まる（要注意）" | "暴落増幅";
}

export interface AsymmetryResult {
  byTicker: AsymmetryRow[];
  lambda: number;
  rateAvailable: boolean;
  warnings: string[];
}

export interface DecisionResult {
  /** 起点にした窓の終端日（＝最新のローリング推定）。 */
  asOf: string;
  /** 最新窓の b（生）。 */
  bRaw: number[];
  /** James-Stein 収縮後（推定誤差 e の除去）。 */
  bJs: number[];
  /** 二段収縮後の予測 b（η の割引）。 */
  bForecast: number[];
  /** JS 収縮率。 */
  shrinkFactor: number;
  bMean: number;
  /** π=1（＝P1 と同じ式）のウェイト。 */
  weightBase: number[];
  /** 二段収縮後のウェイト。 */
  weight: number[];
  /** 両者の総変動距離 0.5·Σ|w−w_base|。 */
  tiltReduction: number;
  /** 最適リバランス間隔（営業日）。τ が出ないと null。 */
  rebalanceDays: number | null;
  costCurve: { days: number; staleness: number; cost: number; total: number; turnover: number }[];
  /** 銘柄別の安定度 1 − sd_t(b̂)/mean_t(SE)。 */
  trust: number[];
  /** チルトの粗利（年率）。assumedFactorReturn を仮定した値。 */
  grossEdge: number;
}

export interface StabilityPanelExport {
  tickers: string[];
  dates: string[];
  ret: number[][];
  market: number[];
  /** 全銘柄共通のセクター因子（etf モード）。 */
  factor: number[];
  /** 銘柄別のセクター因子（basket モードの leave-one-out）。 */
  factors?: number[][];
}

export interface StabilityResult {
  params: StabilityParams;
  tickers: string[];
  names: Record<string, string>;
  dateFrom: string;
  dateTo: string;
  nObs: number;
  usedFactorSource: FactorSource;
  rolls: RollPoint[];
  persistence: PersistenceResult;
  rankStability: RankStabilityResult;
  asymmetry: AsymmetryResult;
  decision: DecisionResult;
  /** L2-C は Worker で別途計算するのでここでは null。 */
  breaks: BreakResult | null;
  /** Worker へ渡す素材。 */
  panel: StabilityPanelExport;
  warnings: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// 数値ユーティリティ
// ════════════════════════════════════════════════════════════════════════════

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

function variance(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1);
}

/** 横断共分散（標本共分散・不偏）。 */
function covar(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (n - 1);
}

/** 平均順位（同値は平均）を返す。 */
function ranks(a: number[]): number[] {
  const idx = a.map((v, i) => ({ v, i })).sort((p, q) => p.v - q.v);
  const r = new Array(a.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k].i] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(a: number[], b: number[]): number {
  const va = variance(a);
  const vb = variance(b);
  return va > 0 && vb > 0 ? covar(a, b) / Math.sqrt(va * vb) : 0;
}

function spearman(a: number[], b: number[]): number {
  return pearson(ranks(a), ranks(b));
}

/** 降順の上位 k のインデックス集合。 */
function topSet(a: number[], k: number): Set<number> {
  const idx = a.map((v, i) => ({ v, i })).sort((p, q) => q.v - p.v);
  return new Set(idx.slice(0, k).map((x) => x.i));
}

/**
 * James-Stein 収縮（横断平均へ）。P1 と同じ式。
 *   b_JS = b̄ + max(0, 1 − (N−3)·mean(SE²)/Σ(b−b̄)²)·(b − b̄)
 */
function jamesStein(b: number[], se: number[]): { shrunk: number[]; factor: number; mean: number } {
  const N = b.length;
  const bMean = mean(b);
  if (N < 4) return { shrunk: [...b], factor: 0, mean: bMean };
  const ss = b.reduce((s, v) => s + (v - bMean) * (v - bMean), 0);
  const s2 = mean(se.map((v) => v * v));
  if (ss <= 0) return { shrunk: b.map(() => bMean), factor: 1, mean: bMean };
  const c = Math.max(0, 1 - ((N - 3) * s2) / ss);
  return { shrunk: b.map((v) => bMean + c * (v - bMean)), factor: 1 - c, mean: bMean };
}

/** long-only ＋ 1銘柄上限。合計1に正規化（P1 の capWeights と同じ）。 */
function capWeights(raw: number[], maxWeight: number): number[] {
  let w = raw.map((v) => Math.max(0, v));
  let sum = w.reduce((s, v) => s + v, 0);
  if (sum <= 0) return raw.map(() => 0);
  w = w.map((v) => v / sum);
  for (let iter = 0; iter < 20; iter++) {
    const over = w.map((v) => v > maxWeight + 1e-9);
    if (!over.some(Boolean)) break;
    const fixed = w.reduce((s, v, i) => s + (over[i] ? maxWeight : 0), 0);
    const freeSum = w.reduce((s, v, i) => s + (over[i] ? 0 : v), 0);
    const room = Math.max(0, 1 - fixed);
    w = w.map((v, i) => (over[i] ? maxWeight : freeSum > 0 ? (v / freeSum) * room : 0));
  }
  sum = w.reduce((s, v) => s + v, 0);
  return sum > 0 ? w.map((v) => v / sum) : w;
}

/** b（＝予測 b）と σ_ε から topK・上限つきウェイトを作る。P1 と同じ w ∝ b/σ_ε²。 */
function weightsFrom(bF: number[], sigmaEps: number[], topK: number, maxWeight: number): number[] {
  const score = bF.map((v, i) => (sigmaEps[i] > 0 ? v / sigmaEps[i] : 0));
  const keep = topSet(score, Math.max(1, Math.min(topK, bF.length)));
  const raw = bF.map((v, i) =>
    keep.has(i) && sigmaEps[i] > 0 ? v / (sigmaEps[i] * sigmaEps[i]) : 0
  );
  return capWeights(raw, maxWeight);
}

// ════════════════════════════════════════════════════════════════════════════
// ① ローリング推定
// ════════════════════════════════════════════════════════════════════════════

/**
 * 各銘柄が使うセクター因子（basket なら leave-one-out）。
 *
 * **市場への直交化はここでは行わない。** Frisch-Waugh により、回帰
 *   r ~ [1, M, F]  と  r ~ [1, M, F − aM]
 * は F の係数 b と残差が完全に一致する（M の係数だけが変わる）。b と σ_ε しか使わない
 * ローリングでは直交化は不要で、窓ごとの余計な回帰を省ける。
 * 一方 L2-D の符号分割では 1{F<0} の中身が変わるため、あちらでは必ず直交化する。
 */
function rollFactors(panel: ReturnPanel, source: FactorSource): number[][] {
  const N = panel.ret.length;
  if (source === "etf" && panel.etf) {
    const F = panel.etf;
    return Array.from({ length: N }, () => F);
  }
  return Array.from({ length: N }, (_, i) => leaveOneOut(panel, i));
}

export function buildRolls(
  panel: ReturnPanel,
  factors: number[][],
  rollWindow: number,
  rollStep: number
): RollPoint[] {
  const T = panel.market.length;
  const N = panel.ret.length;
  const ends: number[] = [];
  // 最新の窓が必ず終端に一致するよう後ろから刻む。
  for (let e = T; e >= rollWindow; e -= rollStep) ends.push(e);
  ends.reverse();

  const out: RollPoint[] = [];
  for (const e of ends) {
    const s = e - rollWindow;
    const M = panel.market.slice(s, e);
    const b: number[] = [];
    const bSe: number[] = [];
    const sig: number[] = [];
    const sc: number[] = [];
    let ok = true;
    for (let i = 0; i < N; i++) {
      const y = panel.ret[i].slice(s, e);
      const F = factors[i].slice(s, e);
      const X: number[][] = [];
      for (let t = 0; t < y.length; t++) X.push([1, M[t], F[t]]);
      const fit = olsNW(y, X, 5);
      if (!fit) {
        ok = false;
        break;
      }
      const se = fit.sigmaResid * Math.sqrt(TRADING_DAYS);
      b.push(fit.beta[2]);
      bSe.push(fit.se[2]);
      sig.push(se);
      sc.push(se > 0 ? fit.beta[2] / se : 0);
    }
    if (!ok) continue;
    out.push({ date: panel.dates[e - 1], from: panel.dates[s], b, bSe, sigmaEps: sig, score: sc });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// ② L2-A 持続性 ＋ L2-B 順位安定性（同じペア集合の上で計算する）
// ════════════════════════════════════════════════════════════════════════════

interface Pair {
  a: number; // roll index t
  b: number; // roll index t+h
}

interface PairStats {
  /** 補正前の横断共分散の平均。 */
  covRaw: number;
  /** 推定誤差の重複ぶんを引いた分子。 */
  numer: number;
  /** 分母 Var_i(b̂) − mean_i(SE²)。 */
  denom: number;
  pi: number;
  rankIcB: number;
  rankIcS: number;
  survival: number;
  turnover: number;
}

/**
 * ペア集合に対する π と順位指標。
 *
 * 【重複窓の補正】窓長 L に対し h < L だと2つの窓は (L−h)/L だけ標本を共有し、
 * 推定誤差 e が相関する。共有割合 φ に対し Cov(e_t, e_{t+h}) ≈ φ·SE² なので
 *   分子 = Cov_i(b̂_t, b̂_{t+h}) − φ·mean_i(SE_t·SE_{t+h})
 * とする。補正しないと h が短いほど π が機械的に 1 に近づく（持続性ではなく重複）。
 * **この補正は観測側にだけ掛け、ヌル側には掛けない。** ラベルをシャッフルすると
 * 重複由来の共分散も一緒に壊れるため、ヌルは補正なしで 0 中心になるのが正しい。
 */
function pairStats(
  rolls: RollPoint[],
  pairs: Pair[],
  overlap: number,
  topK: number,
  correct: boolean,
  /** "pi" は π だけ（ブート/ヌルの内側用）。順位統計は重いので省く。 */
  need: "pi" | "all"
): PairStats | null {
  if (pairs.length === 0) return null;
  let sCov = 0;
  let sErr = 0;
  let sDen = 0;
  let sIcB = 0;
  let sIcS = 0;
  let sSurv = 0;
  const k = Math.max(1, Math.min(topK, rolls[0].b.length));

  for (const p of pairs) {
    const r1 = rolls[p.a];
    const r2 = rolls[p.b];
    sCov += covar(r1.b, r2.b);
    let e = 0;
    let se1 = 0;
    let se2 = 0;
    for (let i = 0; i < r1.b.length; i++) {
      e += r1.bSe[i] * r2.bSe[i];
      se1 += r1.bSe[i] * r1.bSe[i];
      se2 += r2.bSe[i] * r2.bSe[i];
    }
    const n1 = r1.b.length;
    sErr += e / n1;
    sDen += (variance(r1.b) - se1 / n1 + (variance(r2.b) - se2 / n1)) / 2;
    if (need === "all") {
      sIcB += spearman(r1.b, r2.b);
      sIcS += spearman(r1.score, r2.score);
      const t1 = topSet(r1.score, k);
      const t2 = topSet(r2.score, k);
      let hit = 0;
      for (const x of t1) if (t2.has(x)) hit++;
      sSurv += hit / k;
    }
  }

  const n = pairs.length;
  const covRaw = sCov / n;
  const numer = correct ? covRaw - overlap * (sErr / n) : covRaw;
  const denom = sDen / n;
  return {
    covRaw,
    numer,
    denom,
    pi: denom > 1e-12 ? numer / denom : 0,
    rankIcB: sIcB / n,
    rankIcS: sIcS / n,
    survival: sSurv / n,
    turnover: 0,
  };
}

function computePersistenceAndRanks(
  rolls: RollPoint[],
  params: StabilityParams,
  warnings: string[]
): { persistence: PersistenceResult; rank: RankStabilityResult } {
  const R = rolls.length;
  const N = rolls[0]?.b.length ?? 0;
  const rand = mulberry32(params.seed);
  const curve: PersistencePoint[] = [];
  const byHorizon: RankStabilityPoint[] = [];

  const horizons = params.horizons.filter((h) => Math.round(h / params.rollStep) >= 1);
  const sets = horizons
    .map((h) => {
      const off = Math.round(h / params.rollStep);
      const pairs: Pair[] = [];
      for (let i = 0; i + off < R; i++) pairs.push({ a: i, b: i + off });
      return { h, off, pairs, overlap: Math.max(0, 1 - h / params.rollWindow) };
    })
    .filter((s) => s.pairs.length >= 3);

  // ── ヌル: 各時点で銘柄ラベルを独立にシャッフル ───────────────
  // シャッフルは h に依存しないので、1回の並べ替えで全 h ぶんの π を取る。
  // 補正はヌル側に掛けない（ラベルを崩すと重複由来の共分散も一緒に消えるため、
  // 補正済みの観測値と補正なしのヌルを比べるのが正しい対応になる）。
  const nullPi: number[][] = sets.map(() => []);
  const shuffled: RollPoint[] = rolls.map((r) => ({ ...r }));
  for (let it = 0; it < params.nPerm; it++) {
    for (let r = 0; r < R; r++) {
      const perm = [...Array(N).keys()];
      for (let i = N - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      shuffled[r] = {
        ...rolls[r],
        b: perm.map((p) => rolls[r].b[p]),
        bSe: perm.map((p) => rolls[r].bSe[p]),
      };
    }
    sets.forEach((s, k) => {
      const st = pairStats(shuffled, s.pairs, s.overlap, params.topK, false, "pi");
      if (st) nullPi[k].push(st.pi);
    });
  }
  nullPi.forEach((a) => a.sort((x, y) => x - y));

  for (let k = 0; k < sets.length; k++) {
    const { h, pairs, overlap } = sets[k];
    const pt = pairStats(rolls, pairs, overlap, params.topK, true, "all");
    if (!pt) continue;

    // ── ペア単位のブロック・ブート ────────────────────────────
    // ブロック長は「1ペアが覆う時間 = rollWindow + h」を刻みで割った本数。
    // これ以上離れたペアはほぼ独立なので、重なりを正直に CI へ反映できる。
    const blockPairs = Math.max(1, Math.ceil((params.rollWindow + h) / params.rollStep));
    const nBlocks = Math.max(1, Math.ceil(pairs.length / blockPairs));
    const piBoot: number[] = [];
    const icBoot: number[] = [];
    for (let it = 0; it < params.nBoot; it++) {
      const sample: Pair[] = [];
      for (let bIdx = 0; bIdx < nBlocks; bIdx++) {
        const start = Math.floor(rand() * Math.max(1, pairs.length - blockPairs + 1));
        for (let j = 0; j < blockPairs && sample.length < pairs.length; j++) {
          sample.push(pairs[Math.min(pairs.length - 1, start + j)]);
        }
      }
      const st = pairStats(rolls, sample, overlap, params.topK, true, "all");
      if (st) {
        piBoot.push(st.pi);
        icBoot.push(st.rankIcS);
      }
    }
    piBoot.sort((a, b) => a - b);
    icBoot.sort((a, b) => a - b);

    curve.push({
      h,
      pi: pt.pi,
      lo: piBoot.length ? quantileSorted(piBoot, 0.025) : NaN,
      hi: piBoot.length ? quantileSorted(piBoot, 0.975) : NaN,
      nullHi: nullPi[k].length ? quantileSorted(nullPi[k], 0.95) : NaN,
      nPairs: pairs.length,
      nEffPairs: (pairs.length * params.rollStep) / (params.rollWindow + h),
      overlap,
    });
    byHorizon.push({
      h,
      rankIcB: pt.rankIcB,
      rankIcS: pt.rankIcS,
      icLo: icBoot.length ? quantileSorted(icBoot, 0.025) : NaN,
      icHi: icBoot.length ? quantileSorted(icBoot, 0.975) : NaN,
      topKSurvival: pt.survival,
      survivalNull: Math.min(1, params.topK / Math.max(1, N)),
      turnover: pt.turnover,
      nPairs: pairs.length,
    });
  }

  // ── 減衰フィット π(h)=exp(−h/τ) ────────────────────────────
  // ln π = −h/τ の原点通過回帰。π≤0 の点は落とす。
  let tau: number | null = null;
  const usable = curve.filter((c) => c.pi > 0.02 && c.pi < 1.5);
  if (usable.length >= 2) {
    let num = 0;
    let den = 0;
    for (const c of usable) {
      num += c.h * Math.log(Math.min(0.999, c.pi));
      den += c.h * c.h;
    }
    const u = den > 0 ? -num / den : 0; // u = 1/τ
    if (u > 1e-9) tau = 1 / u;
  }

  // ── 判断に使う点 ──────────────────────────────────────────
  const target = 250;
  let dec = curve[0];
  for (const c of curve) if (Math.abs(c.h - target) < Math.abs(dec.h - target)) dec = c;
  const indist = !dec || !(dec.lo > Math.max(0, dec.nullHi));
  const piForDecision = !dec || indist ? 0 : Math.max(0, Math.min(1, dec.lo));

  if (indist && dec) {
    warnings.push(
      `π(${dec.h}日) の 95%CI 下限 ${Number.isFinite(dec.lo) ? dec.lo.toFixed(2) : "—"} が ` +
        `ヌル95%点 ${Number.isFinite(dec.nullHi) ? dec.nullHi.toFixed(2) : "—"} を超えていない。` +
        `**持続性はこの標本では測れていない**ので、二段収縮は π=0（＝チルトを畳んで w ∝ 1/σ_ε²）に退避する。`
    );
  }
  if (tau !== null && tau * Math.LN2 > params.window) {
    warnings.push(
      `半減期 ${Math.round(tau * Math.LN2)}日 は標本長 ${params.window}日 を超えており、減衰曲線の外挿である。` +
        `「観測できた範囲では減衰が見えない」以上のことは言えない（＝リバランス間隔の最適点も弱くしか決まらない）。`
    );
  }
  if (curve.some((c) => c.pi > 1.05)) {
    warnings.push(
      "π が 1 を超えている h がある。持続率は定義上 1 が上限なので、これは分母（推定誤差を除いた真の散らばり）の" +
        "見積りが保守的すぎることを意味する。CI が 1 を含むなら「ほぼ完全に持続」と読んでよい。"
    );
  }
  if (curve.some((c) => c.overlap > 0)) {
    warnings.push(
      `h < ローリング窓（${params.rollWindow}日）の点は2つの推定窓が標本を共有するため、` +
        `推定誤差の重複分 φ·mean(SE²) を分子から引いて補正してある（φ は図に併記）。補正前の値より必ず小さく出る。`
    );
  }

  // ── 遷移行列（decisionH）────────────────────────────────
  const Q = Math.min(4, Math.max(2, Math.floor(N / 3)));
  const transition: number[][] = Array.from({ length: Q }, () => new Array(Q).fill(0));
  const decOff = dec ? Math.round(dec.h / params.rollStep) : 0;
  if (dec) {
    for (let i = 0; i + decOff < R; i++) {
      const q1 = quantileGroup(rolls[i].score, Q);
      const q2 = quantileGroup(rolls[i + decOff].score, Q);
      for (let a = 0; a < N; a++) transition[q1[a]][q2[a]]++;
    }
    for (let r = 0; r < Q; r++) {
      const s = transition[r].reduce((x, y) => x + y, 0);
      if (s > 0) for (let c = 0; c < Q; c++) transition[r][c] /= s;
    }
  }

  return {
    persistence: {
      curve,
      tau,
      halfLife: tau !== null ? tau * Math.LN2 : null,
      piForDecision,
      decisionH: dec?.h ?? 0,
      piPoint: dec?.pi ?? 0,
      piLo: dec?.lo ?? NaN,
      piHi: dec?.hi ?? NaN,
      indistinguishableFromNull: indist,
    },
    rank: {
      byHorizon,
      transition,
      quantiles: Q,
      transitionH: dec?.h ?? 0,
    },
  };
}

/** 値を Q 分位に割る（0 = 最下位群）。 */
function quantileGroup(v: number[], Q: number): number[] {
  const order = v.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const g = new Array(v.length).fill(0);
  order.forEach((o, pos) => {
    g[o.i] = Math.min(Q - 1, Math.floor((pos * Q) / v.length));
  });
  return g;
}

// ════════════════════════════════════════════════════════════════════════════
// ③ L2-D 非対称性
// ════════════════════════════════════════════════════════════════════════════

/**
 * 交互作用ダミー1本の回帰で b を状態別に割る。部分標本に切らない理由は、
 * 切ると各群の SE が膨らみ、かつ条件付けバイアスが入るため。
 *
 *   r = α + γ·D + c·M + b·F + δ·(F·D) + ε      →  b|D=0 = b,  b|D=1 = b + δ
 *
 * 水準ダミー D 自体も入れる（設計書の式には無いが、D と F·D は相関するので
 * D を落とすと δ に水準差が混入しうる。df は 2400 中の1本で無視できる）。
 */
function splitFit(
  y: number[],
  M: number[],
  F: number[],
  D: number[]
): { b0: number; b1: number; delta: number; t: number; p: number; sigmaResid: number } | null {
  const X: number[][] = [];
  for (let t = 0; t < y.length; t++) X.push([1, D[t], M[t], F[t], F[t] * D[t]]);
  const fit = olsNW(y, X, 5);
  if (!fit) return null;
  const b0 = fit.beta[3];
  const delta = fit.beta[4];
  const t = fit.t[4];
  return {
    b0,
    b1: b0 + delta,
    delta,
    t,
    p: studentTwoSidedP(t, Math.max(1, fit.n - 5)),
    sigmaResid: fit.sigmaResid,
  };
}

export function computeAsymmetry(
  panel: ReturnPanel,
  ratePrices: PricePoint[] | null,
  source: FactorSource,
  params: StabilityParams
): AsymmetryResult {
  const T = panel.market.length;
  const N = panel.ret.length;
  const warnings: string[] = [];

  // 符号の条件付けは「市場を抜いたセクターだけの動き」で行う必要があるので、
  // ここでは必ず直交化する（ローリングと違い 1{F<0} の中身が変わる）。
  const rawSector = source === "etf" && panel.etf ? panel.etf : panel.basket;
  const Fcommon = orthogonalize(rawSector, panel.market);

  let rateDiff: (number | null)[] | null = null;
  if (ratePrices && ratePrices.length > 30) {
    rateDiff = prevSessionRateDiff(panel.dates, ratePrices).diff;
  } else {
    warnings.push("金利プロキシが無いため、金利の符号別 b（賭けの本丸）は測れない。");
  }

  const rows: AsymmetryRow[] = [];
  const pF: number[] = [];
  const pM: number[] = [];

  for (let i = 0; i < N; i++) {
    const F =
      source === "basket" ? orthogonalize(leaveOneOut(panel, i), panel.market) : Fcommon;
    const y = panel.ret[i];
    const M = panel.market;

    const fSign = splitFit(y, M, F, F.map((v) => (v < 0 ? 1 : 0)));
    const mSign = splitFit(y, M, F, M.map((v) => (v < 0 ? 1 : 0)));
    if (!fSign || !mSign) continue;

    let rateUp = NaN;
    let rateDown = NaN;
    let rateT = NaN;
    let rateOk = false;
    if (rateDiff) {
      const yy: number[] = [];
      const mm: number[] = [];
      const ff: number[] = [];
      const dd: number[] = [];
      for (let t = 0; t < T; t++) {
        const d = rateDiff[t];
        if (d === null || !Number.isFinite(d)) continue;
        yy.push(y[t]);
        mm.push(M[t]);
        ff.push(F[t]);
        dd.push(d < 0 ? 1 : 0);
      }
      const rf = yy.length >= 240 ? splitFit(yy, mm, ff, dd) : null;
      if (rf) {
        rateUp = rf.b0;
        rateDown = rf.b1;
        rateT = rf.t;
        rateOk = true;
      }
    }

    const sigmaEps = fSign.sigmaResid * Math.sqrt(TRADING_DAYS);
    // 対称の b（＝P1 と同じ値）は F・M 双方の分割を入れない素の回帰から取る。
    const X: number[][] = [];
    for (let t = 0; t < T; t++) X.push([1, M[t], F[t]]);
    const plain = olsNW(y, X, 5);
    const bSym = plain ? plain.beta[2] : (fSign.b0 + fSign.b1) / 2;

    pF.push(fSign.p);
    pM.push(mSign.p);
    rows.push({
      ticker: panel.tickers[i],
      bPlus: fSign.b0,
      bMinus: fSign.b1,
      deltaT: fSign.t,
      deltaP: fSign.p,
      deltaQ: 1,
      bMktUp: mSign.b0,
      bMktDown: mSign.b1,
      mktDeltaT: mSign.t,
      mktDeltaP: mSign.p,
      mktDeltaQ: 1,
      bRateUp: rateUp,
      bRateDown: rateDown,
      rateDeltaT: rateT,
      rateAvailable: rateOk,
      sigmaEps,
      score: sigmaEps > 0 ? bSym / sigmaEps : 0,
      scoreAdj: 0,
      verdict: "対称",
    });
  }

  const qF = benjaminiHochberg(pF);
  const qM = benjaminiHochberg(pM);
  rows.forEach((r, i) => {
    r.deltaQ = qF[i];
    r.mktDeltaQ = qM[i];
    // S' = (b⁺ − λ·max(0, b⁻ − b⁺))/σ_ε
    const pen = Math.max(0, r.bMinus - r.bPlus);
    r.scoreAdj = r.sigmaEps > 0 ? (r.bPlus - params.lambda * pen) / r.sigmaEps : 0;

    const mktWorse = r.mktDeltaQ < 0.1 && r.bMktDown > r.bMktUp;
    const downWorse = r.deltaQ < 0.1 && r.bMinus > r.bPlus;
    const rateGood = r.rateAvailable && Math.abs(r.rateDeltaT) >= 2 && r.bRateUp > r.bRateDown;
    r.verdict = mktWorse
      ? "暴落増幅"
      : downWorse
        ? "下げで強まる（要注意）"
        : rateGood
          ? "理想形"
          : "対称";
  });

  const amp = rows.filter((r) => r.verdict === "暴落増幅");
  if (amp.length > 0) {
    warnings.push(
      `市場下落日にセクター露出が有意に増える銘柄が ${amp.length} 本ある（${amp.slice(0, 4).map((r) => r.ticker).join(", ")}${amp.length > 4 ? " ほか" : ""}）。` +
        `平均の b が同じでも、これらは「分散のつもりが暴落時に集中する」建玉であり、C11（ドローダウン管理）と衝突する。`
    );
  }

  return { byTicker: rows, lambda: params.lambda, rateAvailable: rateDiff !== null, warnings };
}

// ════════════════════════════════════════════════════════════════════════════
// ④ 建玉への翻訳（§6）
// ════════════════════════════════════════════════════════════════════════════

function computeDecision(
  rolls: RollPoint[],
  persistence: PersistenceResult,
  params: StabilityParams
): DecisionResult {
  const last = rolls[rolls.length - 1];
  const N = last.b.length;
  const js = jamesStein(last.b, last.bSe);
  const pi = persistence.piForDecision;
  const bForecast = js.shrunk.map((v) => js.mean + pi * (v - js.mean));

  const weightBase = weightsFrom(js.shrunk, last.sigmaEps, params.topK, params.maxWeight);
  const weight = weightsFrom(bForecast, last.sigmaEps, params.topK, params.maxWeight);
  let tv = 0;
  for (let i = 0; i < N; i++) tv += Math.abs(weight[i] - weightBase[i]);
  const tiltReduction = tv / 2;

  // ── 銘柄別の安定度 1 − sd_t(b̂ − b̄_t)/mean_t(SE) ─────────────
  //
  // 【重要】生の b̂_{i,t} の時系列 sd を使ってはいけない。実データでは全銘柄の b が
  // 揃って動く（銀行全体で 2020年 0.6 → 現在 0.85）。この**共通の水準変化は選別を
  // 一切損なわない**（順位は不変）のに、生の sd で測ると全銘柄が「不安定」と出る。
  // 実際 π(1年)≈0.97 と生 sd 版の trust が全銘柄マイナスという矛盾が出た。
  // 選別に効くのは銘柄固有のズレなので、各時点で横断平均を抜いてから測る。
  // （横断中心化は各銘柄の分散を 1/N だけ削るので、N が小さいと安定側にわずかに偏る。）
  const trust: number[] = [];
  const bBar = rolls.map((r) => mean(r.b));
  for (let i = 0; i < N; i++) {
    const series = rolls.map((r, t) => r.b[i] - bBar[t]);
    const seMean = mean(rolls.map((r) => r.bSe[i]));
    const sd = Math.sqrt(variance(series));
    trust.push(seMean > 0 ? 1 - sd / seMean : 0);
  }

  // ── リバランス間隔（§6.2）────────────────────────────────
  // チルトの粗利 = m·(Σw_i b_i − b̄)。m は仮定（推定値ではない）。
  const bw = weight.reduce((s, w, i) => s + w * last.b[i], 0);
  const grossEdge = params.assumedFactorReturn * (bw - mean(last.b));

  // 実際のウェイト回転を測る: 各ローリング時点で同じ方針のウェイトを作り、
  // 間隔 Δt 離れた時点間の L1 差の平均を取る。仮定ではなく実測値。
  const wSeries = rolls.map((r) => {
    const j = jamesStein(r.b, r.bSe);
    const bf = j.shrunk.map((v) => j.mean + pi * (v - j.mean));
    return weightsFrom(bf, r.sigmaEps, params.topK, params.maxWeight);
  });

  const costCurve: DecisionResult["costCurve"] = [];
  const tau = persistence.tau;
  const c = params.costBps / 10000;
  const maxOff = Math.min(rolls.length - 2, Math.round(750 / params.rollStep));
  for (let off = 1; off <= maxOff; off++) {
    const days = off * params.rollStep;
    let l1 = 0;
    let n = 0;
    for (let i = 0; i + off < rolls.length; i++) {
      let s = 0;
      for (let a = 0; a < N; a++) s += Math.abs(wSeries[i + off][a] - wSeries[i][a]);
      l1 += s;
      n++;
    }
    if (n === 0) continue;
    const turnover = l1 / n;
    // 陳腐化: 保有期間 Δt にわたる露出保持率の平均は (τ/Δt)(1−e^{−Δt/τ})。
    // その 1 − がチルトの粗利のうち取り逃がす割合。
    const retention = tau !== null && tau > 0 ? (tau / days) * (1 - Math.exp(-days / tau)) : 1;
    const staleness = Math.max(0, grossEdge * (1 - retention));
    const cost = c * turnover * (TRADING_DAYS / days);
    costCurve.push({ days, staleness, cost, total: staleness + cost, turnover });
  }
  let rebalanceDays: number | null = null;
  if (tau !== null && costCurve.length > 0 && grossEdge > 0) {
    let best = costCurve[0];
    for (const p of costCurve) if (p.total < best.total) best = p;
    rebalanceDays = best.days;
  }

  return {
    asOf: last.date,
    bRaw: last.b,
    bJs: js.shrunk,
    bForecast,
    shrinkFactor: js.factor,
    bMean: js.mean,
    weightBase,
    weight,
    tiltReduction,
    rebalanceDays,
    costCurve,
    trust,
    grossEdge,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// ⑤ L2-C 構造変化（Worker から呼ぶ。累積和で分割点探索を O(1) 化する）
// ════════════════════════════════════════════════════════════════════════════

function inv3(a: number[]): number[] | null {
  // a は行優先 9 要素。
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
  const c0 = a4 * a8 - a5 * a7;
  const c1 = a5 * a6 - a3 * a8;
  const c2 = a3 * a7 - a4 * a6;
  const det = a0 * c0 + a1 * c1 + a2 * c2;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  const d = 1 / det;
  return [
    c0 * d,
    (a2 * a7 - a1 * a8) * d,
    (a1 * a5 - a2 * a4) * d,
    c1 * d,
    (a0 * a8 - a2 * a6) * d,
    (a2 * a3 - a0 * a5) * d,
    c2 * d,
    (a1 * a6 - a0 * a7) * d,
    (a0 * a4 - a1 * a3) * d,
  ];
}

interface Prefix {
  xx: Float64Array; // (T+1)*9
  xy: Float64Array; // (T+1)*3
  yy: Float64Array; // (T+1)
  T: number;
}

function buildPrefix(y: number[], M: number[], F: number[], idx: number[] | null): Prefix {
  const T = idx ? idx.length : y.length;
  const xx = new Float64Array((T + 1) * 9);
  const xy = new Float64Array((T + 1) * 3);
  const yy = new Float64Array(T + 1);
  for (let t = 0; t < T; t++) {
    const s = idx ? idx[t] : t;
    const x = [1, M[s], F[s]];
    const yv = y[s];
    for (let i = 0; i < 9; i++) xx[(t + 1) * 9 + i] = xx[t * 9 + i];
    for (let i = 0; i < 3; i++) xy[(t + 1) * 3 + i] = xy[t * 3 + i];
    yy[t + 1] = yy[t] + yv * yv;
    for (let i = 0; i < 3; i++) {
      xy[(t + 1) * 3 + i] += x[i] * yv;
      for (let j = 0; j < 3; j++) xx[(t + 1) * 9 + i * 3 + j] += x[i] * x[j];
    }
  }
  return { xx, xy, yy, T };
}

/** 区間 [a,b) の OLS から b（F の係数）とその同分散 SE を返す。 */
function segB(p: Prefix, a: number, b: number): { b: number; se2: number } | null {
  const n = b - a;
  if (n < 30) return null;
  const A: number[] = new Array(9);
  for (let i = 0; i < 9; i++) A[i] = p.xx[b * 9 + i] - p.xx[a * 9 + i];
  const cv: number[] = new Array(3);
  for (let i = 0; i < 3; i++) cv[i] = p.xy[b * 3 + i] - p.xy[a * 3 + i];
  const inv = inv3(A);
  if (!inv) return null;
  const beta = [0, 0, 0];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) beta[i] += inv[i * 3 + j] * cv[j];
  const yy = p.yy[b] - p.yy[a];
  const sse = yy - (beta[0] * cv[0] + beta[1] * cv[1] + beta[2] * cv[2]);
  const s2 = sse > 0 ? sse / (n - 3) : 0;
  return { b: beta[2], se2: s2 * inv[8] };
}

interface ScanOut {
  supW: number;
  at: number;
  bBefore: number;
  bAfter: number;
  path: number[];
}

function supWaldScan(p: Prefix, splits: number[]): ScanOut {
  let supW = 0;
  let at = -1;
  let bB = 0;
  let bA = 0;
  const path: number[] = [];
  for (const s of splits) {
    const f1 = segB(p, 0, s);
    const f2 = segB(p, s, p.T);
    if (!f1 || !f2) {
      path.push(0);
      continue;
    }
    const v = f1.se2 + f2.se2;
    const w = v > 0 ? ((f1.b - f2.b) * (f1.b - f2.b)) / v : 0;
    path.push(w);
    if (w > supW) {
      supW = w;
      at = s;
      bB = f1.b;
      bA = f2.b;
    }
  }
  return { supW, at, bBefore: bB, bAfter: bA, path };
}

export function computeBreaks(
  panel: StabilityPanelExport,
  params: Pick<StabilityParams, "trim" | "rollStep" | "nBoot" | "blockLen" | "seed">,
  onProgress?: (done: number, total: number) => void
): BreakResult {
  const T = panel.market.length;
  const N = panel.tickers.length;
  const warnings: string[] = [];
  const lo = Math.floor(T * params.trim);
  const hi = Math.ceil(T * (1 - params.trim));
  const splits: number[] = [];
  for (let s = lo; s <= hi; s += params.rollStep) splits.push(s);
  if (splits.length < 5) {
    return {
      byTicker: [],
      common: null,
      consensusBreaks: [],
      recommendWindowFrom: null,
      nBootDone: 0,
      warnings: ["標本が短く分割点を探索できない。"],
    };
  }

  const rand = mulberry32(params.seed);
  const nBlocks = Math.ceil(T / params.blockLen);
  // ヌルの索引列は全銘柄で共有する（横断相関を壊さない）。
  const bootIdx: number[][] = [];
  for (let it = 0; it < params.nBoot; it++) {
    const idx: number[] = [];
    for (let k = 0; k < nBlocks && idx.length < T; k++) {
      const start = Math.floor(rand() * Math.max(1, T - params.blockLen));
      for (let j = 0; j < params.blockLen && idx.length < T; j++) idx.push(start + j);
    }
    bootIdx.push(idx);
  }

  const scanOne = (ticker: string, y: number[], F: number[]): { row: BreakRow; p: number } => {
    const obs = supWaldScan(buildPrefix(y, panel.market, F, null), splits);
    let ge = 0;
    const dist: number[] = [];
    for (const idx of bootIdx) {
      const r = supWaldScan(buildPrefix(y, panel.market, F, idx), splits);
      dist.push(r.supW);
      if (r.supW >= obs.supW) ge++;
    }
    dist.sort((a, b) => a - b);
    const p = (1 + ge) / (bootIdx.length + 1);
    return {
      p,
      row: {
        ticker,
        supW: obs.supW,
        bootP: p,
        q: 1,
        breakDate: obs.at >= 0 ? panel.dates[Math.min(panel.dates.length - 1, obs.at)] : null,
        bBefore: obs.bBefore,
        bAfter: obs.bAfter,
        path: splits.map((s, k) => ({ date: panel.dates[Math.min(panel.dates.length - 1, s)], w: obs.path[k] })),
        crit95: dist.length ? quantileSorted(dist, 0.95) : 0,
      },
    };
  };

  const rows: BreakRow[] = [];
  const pvals: number[] = [];
  for (let i = 0; i < N; i++) {
    const F = panel.factors ? panel.factors[i] : panel.factor;
    const r = scanOne(panel.tickers[i], panel.ret[i], F);
    rows.push(r.row);
    pvals.push(r.p);
    onProgress?.(i + 1, N + 1);
  }

  // 共通成分（等加重バスケット）。個別の分割点が「共通の水準変化」なのかを切り分ける。
  const T2 = panel.market.length;
  const eq = new Array(T2).fill(0);
  for (let t = 0; t < T2; t++) {
    let s = 0;
    for (let i = 0; i < N; i++) s += panel.ret[i][t];
    eq[t] = s / N;
  }
  const commonRow = scanOne("＊共通（等加重）", eq, panel.factor).row;
  commonRow.q = commonRow.bootP;
  onProgress?.(N + 1, N + 1);

  const q = benjaminiHochberg(pvals);
  rows.forEach((r, i) => (r.q = q[i]));

  // ── 分割点の票を集計（有意な銘柄のみ）─────────────────────
  const votes = new Map<string, number>();
  for (const r of rows) {
    if (r.q < 0.1 && r.breakDate) votes.set(r.breakDate, (votes.get(r.breakDate) ?? 0) + 1);
  }
  const consensusBreaks = [...votes.entries()]
    .map(([date, v]) => {
      let nearest: string | null = null;
      let gap: number | null = null;
      for (const e of BOJ_POLICY_EVENTS) {
        const d = Math.abs((new Date(date).getTime() - new Date(e.date).getTime()) / 86400000);
        if (gap === null || d < gap) {
          gap = d;
          nearest = e.label;
        }
      }
      return { date, votes: v, nearestEvent: gap !== null && gap <= 60 ? nearest : null, gapDays: gap };
    })
    .sort((a, b) => b.votes - a.votes || a.date.localeCompare(b.date));

  let recommendWindowFrom: string | null = null;
  if (consensusBreaks.length > 0) {
    const top = consensusBreaks[0];
    const idx = panel.dates.indexOf(top.date);
    const remaining = idx >= 0 ? panel.dates.length - idx : 0;
    if (top.votes >= Math.max(3, Math.ceil(N * 0.25))) {
      if (remaining >= 250) recommendWindowFrom = top.date;
      else
        warnings.push(
          `分割点 ${top.date} に ${top.votes} 票が集中しているが、以降の標本が ${remaining} 日しかない（250日未満）。` +
            `この場合は窓を切り替えるのではなく **b の推定自体を見送る＝等加重**が正しい。`
        );
    }
  }
  const nSig = rows.filter((r) => r.q < 0.1).length;
  if (nSig === 0) {
    warnings.push(
      "BH-FDR 後に構造変化が有意な銘柄は無い。長い窓を使ってよい（分散が減るぶん有利）。" +
        "ただし検出力は高くないので「変化が無い」の証明ではない。"
    );
  } else if (commonRow.bootP < 0.1) {
    const sameSign = rows.filter((r) => r.q < 0.1 && Math.sign(r.bAfter - r.bBefore) === Math.sign(commonRow.bAfter - commonRow.bBefore)).length;
    warnings.push(
      `共通成分（等加重バスケット）自体に分割点がある（p=${commonRow.bootP.toFixed(3)}, ` +
        `b ${commonRow.bBefore.toFixed(2)}→${commonRow.bAfter.toFixed(2)}）。` +
        `個別の有意 ${nSig} 本のうち ${sameSign} 本が同じ向きなので、これは**銘柄ごとの構造変化ではなく b の水準が揃って動いた**もの。` +
        `水準の共通変化は順位を変えないので選別（相対の話）は壊れていない。壊れるのは「b の絶対値」を使う建玉サイズのほう。`
    );
  }

  return { byTicker: rows, common: commonRow, consensusBreaks, recommendWindowFrom, nBootDone: bootIdx.length, warnings };
}

// ════════════════════════════════════════════════════════════════════════════
// 本体
// ════════════════════════════════════════════════════════════════════════════

export function computeSectorStability(
  pricesByTicker: Record<string, PricePoint[]>,
  factors: FactorPrices,
  paramsIn: Partial<StabilityParams> = {},
  names: Record<string, string> = {}
): StabilityResult | null {
  const params = { ...DEFAULT_STABILITY_PARAMS, ...paramsIn };
  const warnings: string[] = [];

  const panel = buildPanel(pricesByTicker, factors.market, factors.sector, params.window);
  if (!panel) return null;
  const T = panel.market.length;
  if (T < params.rollWindow + params.rollStep * 6) {
    warnings.push(
      `標本 ${T} 日ではローリング窓 ${params.rollWindow} 日の推定が ${Math.floor((T - params.rollWindow) / params.rollStep) + 1} 点しか取れない。窓を短くすること。`
    );
    if (T < params.rollWindow + params.rollStep * 3) return null;
  }

  let usedFactorSource: FactorSource = params.factorSource;
  if (params.factorSource === "etf" && !panel.etf) {
    usedFactorSource = "basket";
    warnings.push("セクターETFの履歴が窓長に足りないため、等加重バスケット（leave-one-out）に自動退避した。");
  }

  const facs = rollFactors(panel, usedFactorSource);
  const rolls = buildRolls(panel, facs, params.rollWindow, params.rollStep);
  if (rolls.length < 6) return null;

  const { persistence, rank } = computePersistenceAndRanks(rolls, params, warnings);
  const decision = computeDecision(rolls, persistence, params);

  // 回転率だけは決定後のウェイト系列で測り直して rankStability に載せる。
  const wSeries = rolls.map((r) => {
    const j = jamesStein(r.b, r.bSe);
    const bf = j.shrunk.map((v) => j.mean + persistence.piForDecision * (v - j.mean));
    return weightsFrom(bf, r.sigmaEps, params.topK, params.maxWeight);
  });
  for (const row of rank.byHorizon) {
    const off = Math.round(row.h / params.rollStep);
    let s = 0;
    let n = 0;
    for (let i = 0; i + off < rolls.length; i++) {
      let l1 = 0;
      for (let a = 0; a < wSeries[i].length; a++) l1 += Math.abs(wSeries[i + off][a] - wSeries[i][a]);
      s += l1;
      n++;
    }
    row.turnover = n > 0 ? s / n : 0;
  }

  const asymmetry = computeAsymmetry(panel, factors.rate, usedFactorSource, params);

  const N = panel.ret.length;
  if (N < 8) {
    warnings.push(
      `銘柄が ${N} 本しかない。π の標準誤差は概ね 1/√(N−3) = ${(1 / Math.sqrt(Math.max(1, N - 3))).toFixed(2)} で、` +
        `点推定だけでは 0.3 と 0.8 を区別できない。CI とヌルを必ず併せて読むこと。`
    );
  }
  if (panel.droppedForHistory.length > 0) {
    warnings.push(
      `履歴がこの窓（${params.window}日）に足りないため ${panel.droppedForHistory.length} 銘柄を外した（${panel.droppedForHistory.join(", ")}）。`
    );
  }
  if (panel.glitchesFixed > 0) {
    warnings.push(`価格スケール破損として ${panel.glitchesFixed} 点のリターンを 0 に置換した（取得層の修復を通り抜けた分）。`);
  }

  const panelExport: StabilityPanelExport = {
    tickers: panel.tickers,
    dates: panel.dates,
    ret: panel.ret,
    market: panel.market,
    factor: facs[0],
    factors: usedFactorSource === "basket" ? facs : undefined,
  };

  return {
    params,
    tickers: panel.tickers,
    names,
    dateFrom: panel.dates[0],
    dateTo: panel.dates[panel.dates.length - 1],
    nObs: T,
    usedFactorSource,
    rolls,
    persistence,
    rankStability: rank,
    asymmetry,
    decision,
    breaks: null,
    panel: panelExport,
    warnings: [...warnings, ...asymmetry.warnings],
  };
}
