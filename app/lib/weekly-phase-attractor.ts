// 週内位相アトラクタ — 動力学的な週内アノマリーの検証
// 設計: WEEKLY_PHASE_ATTRACTOR.md (フェーズ1: 検証コア)
//
// (a) 曜日リターンアノマリー(1次モーメント)ではなく
// (b) 軌道の幾何の週次位相ロック(リミットサイクルの骨格)を検証する。
//
// 手順:
//   1. Takens遅延座標で位相空間を再構成
//   2. 各埋め込みベクトルに週次位相 φ(t) を付与 (実曜日 or 営業日位相)
//   3. 位相ロック統計量 PL = 一元配置分散分析のF比 (曜日間分散/曜日内分散)
//   4. 曜日ラベルシャッフルサロゲートで帰無分布を構築し p値を算出

import { PricePoint } from "./types";
import { SeriesMode, extractSeries } from "./series-mode";
import { takensEmbedding } from "./nonlinear";
import { computeLombScargle } from "./lomb-scargle";
import { computeEMD, hilbertTransform } from "./emd";

export type PhaseMode = "calendar" | "business";

export const PHASE_MODE_LABELS: Record<PhaseMode, string> = {
  calendar: "実曜日",
  business: "営業日位相",
};

export const WEEKDAY_LABELS = ["月", "火", "水", "木", "金"];
export const WEEKDAY_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#db2777", "#dc2626"];

const K = 5; // 取引週 = 5営業日

// 日付文字列 → 0=月 .. 4=金, 週末/不正は -1
function weekdayIndex(time: string): number {
  const d = new Date(time);
  if (isNaN(d.getTime())) return -1;
  const g = d.getUTCDay(); // 0=日 .. 6=土
  if (g === 0 || g === 6) return -1;
  return g - 1;
}

export interface WeekdayStat {
  label: string;
  color: string;
  count: number;
  centroid: number[]; // m次元の重心
  // ストロボ写像収束度: 曜日内平均分散 / 全体平均分散
  // < 1 なら全体より集中 = 不動点的(位相ロックの兆候)
  dispersionRatio: number;
}

export interface WeeklyPhaseResult {
  ok: boolean;
  message?: string;
  dim: number;
  tau: number;
  phaseMode: PhaseMode;
  n: number; // 解析に使った点数
  // 2D散布用の射影座標(埋め込み第1・第2成分)
  points: { x: number; y: number; phase: number; time: string }[];
  centroids2d: { x: number; y: number }[]; // [5] 巡回パス用
  weekdayStats: WeekdayStat[];
  // 位相ロック検定
  PL: number; // 観測F比
  surrogatePL: number[]; // サロゲートF比の分布
  surrogateMean: number;
  surrogateStd: number;
  surrogateQ95: number; // 95%分位点 (有意閾値)
  pValue: number;
}

interface FResult {
  PL: number;
  centroids: number[][];
  counts: number[];
  groupSpread: number[]; // 曜日内平方和(曜日別)
  groupsPresent: number;
}

// 一元配置分散分析のF比を多次元で計算 (nGroups: 位相のグループ数, 既定=週=5)
function fRatio(V: number[][], P: number[], m: number, nGroups: number = K): FResult {
  const N = V.length;
  const sum: number[][] = Array.from({ length: nGroups }, () => new Array(m).fill(0));
  const counts = new Array(nGroups).fill(0);
  const overall = new Array(m).fill(0);

  for (let i = 0; i < N; i++) {
    const k = P[i];
    counts[k]++;
    const v = V[i];
    for (let j = 0; j < m; j++) {
      sum[k][j] += v[j];
      overall[j] += v[j];
    }
  }
  for (let j = 0; j < m; j++) overall[j] /= N;

  const centroids: number[][] = sum.map((s, k) =>
    counts[k] > 0 ? s.map((v) => v / counts[k]) : new Array(m).fill(NaN)
  );

  let sBetween = 0;
  let groupsPresent = 0;
  for (let k = 0; k < nGroups; k++) {
    if (counts[k] === 0) continue;
    groupsPresent++;
    let d = 0;
    for (let j = 0; j < m; j++) {
      const dd = centroids[k][j] - overall[j];
      d += dd * dd;
    }
    sBetween += counts[k] * d;
  }

  let sWithin = 0;
  const groupSpread = new Array(nGroups).fill(0);
  for (let i = 0; i < N; i++) {
    const k = P[i];
    let d = 0;
    const v = V[i];
    for (let j = 0; j < m; j++) {
      const dd = v[j] - centroids[k][j];
      d += dd * dd;
    }
    sWithin += d;
    groupSpread[k] += d;
  }

  const dfB = Math.max(1, groupsPresent - 1);
  const dfW = Math.max(1, N - groupsPresent);
  const PL = sWithin > 0 ? (sBetween / dfB) / (sWithin / dfW) : 0;

  return { PL, centroids, counts, groupSpread, groupsPresent };
}

// Fisher-Yates シャッフル (in-place)
function shuffleInPlace(arr: number[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// 埋め込み + 位相付与 + 週末除外をまとめて構築 (各関数で再利用)
interface VPT {
  V: number[][];
  P: number[];
  T: string[];
  m: number;
}
function buildVPT(
  prices: PricePoint[],
  seriesMode: SeriesMode,
  tau: number,
  dim: 2 | 3,
  phaseMode: PhaseMode
): VPT {
  const { values, times } = extractSeries(prices, seriesMode);
  const emb = takensEmbedding(values, times, tau, dim);
  const m = dim;
  const allVectors: number[][] = emb.map((p) =>
    dim >= 3 ? [p.x, p.y, p.z ?? 0] : [p.x, p.y]
  );
  const allTimes = emb.map((p) => p.time);

  let allPhases: number[];
  if (phaseMode === "calendar") {
    allPhases = allTimes.map(weekdayIndex);
  } else {
    // 営業日位相: 系列先頭の実曜日に揃え、以降は1営業日ごとに +1 (祝日リセット無視)
    const start0 = allTimes.length ? Math.max(0, weekdayIndex(allTimes[0])) : 0;
    allPhases = allTimes.map((_, i) => (start0 + i) % K);
  }

  const V: number[][] = [];
  const P: number[] = [];
  const T: string[] = [];
  for (let i = 0; i < allVectors.length; i++) {
    if (allPhases[i] < 0) continue; // 週末/不正を除外
    V.push(allVectors[i]);
    P.push(allPhases[i]);
    T.push(allTimes[i]);
  }
  return { V, P, T, m };
}

export function computeWeeklyPhaseAttractor(
  prices: PricePoint[],
  seriesMode: SeriesMode,
  opts: { tau: number; dim: 2 | 3; phaseMode: PhaseMode; surrogateCount?: number }
): WeeklyPhaseResult {
  const { tau, dim, phaseMode } = opts;
  const B = opts.surrogateCount ?? 499;
  const empty: WeeklyPhaseResult = {
    ok: false,
    dim,
    tau,
    phaseMode,
    n: 0,
    points: [],
    centroids2d: [],
    weekdayStats: [],
    PL: 0,
    surrogatePL: [],
    surrogateMean: 0,
    surrogateStd: 0,
    surrogateQ95: 0,
    pValue: 1,
  };

  const { V, P, T, m } = buildVPT(prices, seriesMode, tau, dim, phaseMode);
  const N = V.length;
  if (N < 50) {
    return { ...empty, message: "データ点が不足しています(50点以上必要)" };
  }

  // 観測F比
  const obs = fRatio(V, P, m);
  if (obs.groupsPresent < 2) {
    return { ...empty, message: "曜日グループが不足しています" };
  }

  // 全体平均と全体分散(ストロボ収束度の基準)
  const overall = new Array(m).fill(0);
  for (let i = 0; i < N; i++) for (let j = 0; j < m; j++) overall[j] += V[i][j];
  for (let j = 0; j < m; j++) overall[j] /= N;
  let overallSS = 0;
  for (let i = 0; i < N; i++) {
    let d = 0;
    for (let j = 0; j < m; j++) {
      const dd = V[i][j] - overall[j];
      d += dd * dd;
    }
    overallSS += d;
  }
  const overallMeanVar = overallSS / N;

  const weekdayStats: WeekdayStat[] = [];
  const centroids2d: { x: number; y: number }[] = [];
  for (let k = 0; k < K; k++) {
    const cnt = obs.counts[k];
    const cent = obs.centroids[k];
    const meanVar = cnt > 0 ? obs.groupSpread[k] / cnt : 0;
    weekdayStats.push({
      label: WEEKDAY_LABELS[k],
      color: WEEKDAY_COLORS[k],
      count: cnt,
      centroid: cnt > 0 ? cent : new Array(m).fill(0),
      dispersionRatio: overallMeanVar > 0 && cnt > 0 ? meanVar / overallMeanVar : NaN,
    });
    centroids2d.push(cnt > 0 ? { x: cent[0], y: cent[1] } : { x: NaN, y: NaN });
  }

  // サロゲート: 曜日ラベルをシャッフルしてF比を再計算 (埋め込み幾何・自己相関は保持)
  const surrogatePL: number[] = [];
  const Pwork = P.slice();
  for (let b = 0; b < B; b++) {
    shuffleInPlace(Pwork);
    surrogatePL.push(fRatio(V, Pwork, m).PL);
  }
  const surrogateMean = surrogatePL.reduce((a, b) => a + b, 0) / B;
  const surrogateStd = Math.sqrt(
    surrogatePL.reduce((a, b) => a + (b - surrogateMean) ** 2, 0) / B
  );
  const sorted = surrogatePL.slice().sort((a, b) => a - b);
  const surrogateQ95 = sorted[Math.min(B - 1, Math.floor(0.95 * B))];
  // 片側p値: サロゲートが観測以上になった割合 (+1補正)
  let ge = 0;
  for (const s of surrogatePL) if (s >= obs.PL) ge++;
  const pValue = (1 + ge) / (B + 1);

  // 2D散布点(全曜日)
  const points = V.map((v, i) => ({ x: v[0], y: v[1], phase: P[i], time: T[i] }));

  return {
    ok: true,
    dim,
    tau,
    phaseMode,
    n: N,
    points,
    centroids2d,
    weekdayStats,
    PL: obs.PL,
    surrogatePL,
    surrogateMean,
    surrogateStd,
    surrogateQ95,
    pValue,
  };
}

// ============================================================================
// フェーズ2: 裏取り (リカレンスのラグ構造 / Lomb-Scargle 周期5)
// ============================================================================

// 距離計算
function dist2(a: number[], b: number[]): number {
  let d = 0;
  for (let j = 0; j < a.length; j++) {
    const dd = a[j] - b[j];
    d += dd * dd;
  }
  return d;
}

export interface RecurrenceLagResult {
  ok: boolean;
  message?: string;
  lags: number[]; // 1..maxLag
  rr: number[]; // RR(ℓ): ラグℓのリカレンス率
  epsilon: number; // 近傍半径
  baselineRR: number; // 目標リカレンス率(=ε決定の基準)
  weeklyLags: number[]; // 5,10,15,...
  weeklyPeak: boolean; // ℓ=5 が局所極大かつベースライン超
}

// 3.C リカレンスのラグ構造: RR(ℓ) = ラグℓで近傍にいるペアの割合
// 週内アトラクタなら ℓ=5,10,15 にピークが立つ
export function computeRecurrenceLagProfile(
  prices: PricePoint[],
  seriesMode: SeriesMode,
  opts: { tau: number; dim: 2 | 3; phaseMode: PhaseMode; maxLag?: number; targetRR?: number }
): RecurrenceLagResult {
  const maxLag = opts.maxLag ?? 20;
  const targetRR = opts.targetRR ?? 0.1;
  const empty: RecurrenceLagResult = {
    ok: false,
    lags: [],
    rr: [],
    epsilon: 0,
    baselineRR: targetRR,
    weeklyLags: [],
    weeklyPeak: false,
  };

  const { V } = buildVPT(prices, seriesMode, opts.tau, opts.dim, opts.phaseMode);
  const N = V.length;
  if (N < 50 + maxLag) return { ...empty, message: "データ点が不足しています" };

  // ε決定: ランダムサンプルしたペア距離の targetRR 分位点
  const sample: number[] = [];
  const trials = Math.min(4000, N * 4);
  for (let s = 0; s < trials; s++) {
    const i = Math.floor(Math.random() * N);
    const j = Math.floor(Math.random() * N);
    if (i === j) continue;
    sample.push(Math.sqrt(dist2(V[i], V[j])));
  }
  sample.sort((a, b) => a - b);
  const epsilon = sample[Math.floor(targetRR * sample.length)] || 1e-9;
  const eps2 = epsilon * epsilon;

  const lags: number[] = [];
  const rr: number[] = [];
  for (let l = 1; l <= maxLag; l++) {
    let cnt = 0;
    for (let i = 0; i + l < N; i++) {
      if (dist2(V[i], V[i + l]) < eps2) cnt++;
    }
    lags.push(l);
    rr.push(cnt / (N - l));
  }

  // 週次ラグの判定: ℓ=5 が両隣より大きく、かつ全ラグ平均を上回るか
  const weeklyLags = lags.filter((l) => l % 5 === 0);
  const meanRR = rr.reduce((a, b) => a + b, 0) / rr.length;
  const idx5 = 4; // lags[4] = 5
  const weeklyPeak =
    rr.length > 6 &&
    rr[idx5] > rr[idx5 - 1] &&
    rr[idx5] > rr[idx5 + 1] &&
    rr[idx5] > meanRR;

  return { ok: true, lags, rr, epsilon, baselineRR: targetRR, weeklyLags, weeklyPeak };
}

export interface WeeklySpectrumResult {
  ok: boolean;
  message?: string;
  spectrum: { period: number; power: number }[];
  powerAt5: number; // 周期5付近の最大パワー
  weeklyPeak?: { period: number; power: number; fap: number };
  interpretation: string;
}

// 3.D Lomb-Scargle 周期5検定
// 取引日インデックスを擬似日付として渡し、週次(5営業日)を周期5として検出する
export function computeWeeklySpectrum(
  prices: PricePoint[],
  seriesMode: SeriesMode
): WeeklySpectrumResult {
  const { values } = extractSeries(prices, seriesMode);
  if (values.length < 60) {
    return { ok: false, spectrum: [], powerAt5: 0, interpretation: "データ不足" };
  }
  // 取引日 i を i 日目の擬似日付に変換 (等間隔 → 週次=周期5)
  const base = Date.UTC(2000, 0, 1);
  const pseudoTimes = values.map((_, i) =>
    new Date(base + i * 86400000).toISOString().slice(0, 10)
  );
  const ls = computeLombScargle(values, pseudoTimes, 400);
  const spectrum = ls.spectrum.map((p) => ({ period: p.period, power: p.power }));

  // 周期 [4,6] のレンジで最大パワーとピーク
  let powerAt5 = 0;
  for (const p of spectrum) {
    if (p.period >= 4 && p.period <= 6 && p.power > powerAt5) powerAt5 = p.power;
  }
  const weeklyPeak = ls.peakPeriods.find((p) => p.period >= 4 && p.period <= 6);

  const interpretation = weeklyPeak
    ? `周期${weeklyPeak.period.toFixed(1)}営業日(≈1週)にピーク。パワー=${weeklyPeak.power.toFixed(2)}, FAP=${(weeklyPeak.fap * 100).toFixed(1)}%。${weeklyPeak.fap < 0.05 ? "統計的に有意。" : "有意水準には届かず。"}`
    : `周期4〜6営業日に明確なピークなし(周期5付近の最大パワー=${powerAt5.toFixed(2)})。週次の正弦的周期成分は乏しい。`;

  return { ok: true, spectrum, powerAt5, weeklyPeak, interpretation };
}

// ============================================================================
// フェーズ3: 非定常対策 (ローリング位相ロック PL(t))
// ============================================================================

export interface RollingPLResult {
  ok: boolean;
  message?: string;
  // significant: 窓ごとサロゲートの95%超 / pValue: 窓ごと片側p値
  points: { time: string; PL: number; threshold: number; significant: boolean; pValue: number }[];
  globalThreshold: number; // 全期間サロゲートの95%閾値 (参考線)
  window: number;
  aboveRatio: number; // 窓ごと有意の期間割合
}

// ローリングPL(t): 窓ごとに位相ロックF比 + 窓ごとサロゲート(曜日シャッフル)で有意性を判定。
// 有意な期間だけ曜日チルトを有効化する (メタゲート, §6.4)。
export function computeRollingPL(
  prices: PricePoint[],
  seriesMode: SeriesMode,
  opts: {
    tau: number;
    dim: 2 | 3;
    phaseMode: PhaseMode;
    window?: number;
    step?: number;
    globalThreshold: number;
    surrogateB?: number;
  }
): RollingPLResult {
  const window = opts.window ?? 252;
  const step = opts.step ?? 21;
  const B = opts.surrogateB ?? 99;
  const empty: RollingPLResult = {
    ok: false,
    points: [],
    globalThreshold: opts.globalThreshold,
    window,
    aboveRatio: 0,
  };

  const { V, P, T, m } = buildVPT(prices, seriesMode, opts.tau, opts.dim, opts.phaseMode);
  const N = V.length;
  if (N < window + step) return { ...empty, message: "ローリングに必要なデータが不足" };

  const points: RollingPLResult["points"] = [];
  let above = 0;
  for (let start = 0; start + window <= N; start += step) {
    const Vw = V.slice(start, start + window);
    const Pw = P.slice(start, start + window);
    const f = fRatio(Vw, Pw, m);
    if (f.groupsPresent < 2) continue;

    // 窓ごとサロゲート
    const surr: number[] = [];
    const Ps = Pw.slice();
    for (let b = 0; b < B; b++) {
      shuffleInPlace(Ps);
      surr.push(fRatio(Vw, Ps, m).PL);
    }
    surr.sort((a, b) => a - b);
    const q95 = surr[Math.min(B - 1, Math.floor(0.95 * B))];
    let ge = 0;
    for (const s of surr) if (s >= f.PL) ge++;
    const pValue = (1 + ge) / (B + 1);
    const significant = f.PL > q95;

    points.push({ time: T[start + window - 1], PL: f.PL, threshold: q95, significant, pValue });
    if (significant) above++;
  }
  const aboveRatio = points.length ? above / points.length : 0;

  return { ok: true, points, globalThreshold: opts.globalThreshold, window, aboveRatio };
}

// ============================================================================
// 曜日条件付き Kramers-Moyal (週次位相を状態変数とした ドリフト/拡散/累積経路)
// ============================================================================

export interface WeeklyPhaseKMResult {
  ok: boolean;
  message?: string;
  drift: number[]; // μ(φ)=E[r|曜日], length 5
  diffusion: number[]; // σ(φ)=std(r|曜日), length 5
  cumulative: number[]; // 月→金の累積平均リターン経路, length 5
  counts: number[];
  entryPhase: number; // 累積の谷 = 積み増し候補 (§6.3)
  exitPhase: number; // 累積のピーク = 軽量化候補 (§6.3)
  highVolPhase: number; // 拡散最大 = サイズ縮小候補 (§6.1)
  lowVolPhase: number; // 拡散最小
}

// 価格条件付け(データ分割で脆弱)ではなく、週次位相 φ を状態変数とした KM。
// 日次対数リターンを増分とし、曜日ごとのドリフト/拡散と週内累積経路を出す。
// seriesMode によらず close→logReturn を増分に使う(KMは増分のモデルのため)。
export function computeWeeklyPhaseKM(
  prices: PricePoint[],
  phaseMode: PhaseMode
): WeeklyPhaseKMResult {
  const empty: WeeklyPhaseKMResult = {
    ok: false, drift: [], diffusion: [], cumulative: [], counts: [],
    entryPhase: 0, exitPhase: 0, highVolPhase: 0, lowVolPhase: 0,
  };
  const closes = prices.map((p) => p.close);
  const times = prices.map((p) => p.time);
  const r: number[] = [];
  const rt: string[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      r.push(Math.log(closes[i] / closes[i - 1]));
      rt.push(times[i]);
    }
  }
  if (r.length < 50) return { ...empty, message: "データ不足" };

  let phases: number[];
  if (phaseMode === "calendar") {
    phases = rt.map(weekdayIndex);
  } else {
    const start0 = Math.max(0, weekdayIndex(rt[0]));
    phases = rt.map((_, i) => (start0 + i) % K);
  }

  const sum = new Array(K).fill(0);
  const sumSq = new Array(K).fill(0);
  const counts = new Array(K).fill(0);
  for (let i = 0; i < r.length; i++) {
    const k = phases[i];
    if (k < 0) continue;
    sum[k] += r[i];
    sumSq[k] += r[i] * r[i];
    counts[k]++;
  }

  const drift = new Array(K).fill(0);
  const diffusion = new Array(K).fill(0);
  for (let k = 0; k < K; k++) {
    if (counts[k] > 0) {
      drift[k] = sum[k] / counts[k];
      diffusion[k] = Math.sqrt(Math.max(0, sumSq[k] / counts[k] - drift[k] * drift[k]));
    }
  }

  const cumulative = new Array(K).fill(0);
  let acc = 0;
  for (let k = 0; k < K; k++) {
    acc += drift[k];
    cumulative[k] = acc;
  }

  const argmin = (a: number[]) => a.reduce((bi, v, i) => (v < a[bi] ? i : bi), 0);
  const argmax = (a: number[]) => a.reduce((bi, v, i) => (v > a[bi] ? i : bi), 0);

  return {
    ok: true,
    drift,
    diffusion,
    cumulative,
    counts,
    entryPhase: argmin(cumulative),
    exitPhase: argmax(cumulative),
    highVolPhase: argmax(diffusion),
    lowVolPhase: argmin(diffusion),
  };
}

// ============================================================================
// フェーズ3-E: 位相つき Simplex 予測 (週内構造がトレードに効くかの最終確認)
// ============================================================================

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  const den = Math.sqrt(va * vb);
  return den > 1e-15 ? cov / den : 0;
}

// Simplex 予測コア: coords 空間で k近傍 → v0 の次値を加重平均で予測
// cur[t] = 現在値, 戻り値は actual / predicted / 現在値 (方向判定用)
function simplexCore(
  coords: number[][],
  v0: number[],
  k: number,
  libFrac = 0.7
): { actual: number[]; predicted: number[]; cur: number[] } {
  const n = coords.length;
  const libSize = Math.floor(n * libFrac);
  const dimC = coords[0].length;
  const actual: number[] = [];
  const predicted: number[] = [];
  const cur: number[] = [];

  for (let t = libSize; t < n - 1; t++) {
    const dists: { idx: number; dist: number }[] = [];
    for (let j = 0; j < libSize; j++) {
      if (j + 1 >= n) continue;
      let d = 0;
      for (let c = 0; c < dimC; c++) {
        const dd = coords[t][c] - coords[j][c];
        d += dd * dd;
      }
      dists.push({ idx: j, dist: Math.sqrt(d) });
    }
    if (dists.length === 0) continue;
    dists.sort((a, b) => a.dist - b.dist);
    const neighbors = dists.slice(0, k);
    const minDist = neighbors[0].dist || 1e-10;
    let weightSum = 0, predVal = 0;
    for (const nb of neighbors) {
      const w = Math.exp(-nb.dist / minDist);
      predVal += w * v0[nb.idx + 1];
      weightSum += w;
    }
    if (weightSum > 0) {
      actual.push(v0[t + 1]);
      predicted.push(predVal / weightSum);
      cur.push(v0[t]);
    }
  }
  return { actual, predicted, cur };
}

function dirAccuracy(actual: number[], predicted: number[], cur: number[]): number {
  let hit = 0, tot = 0;
  for (let i = 0; i < actual.length; i++) {
    const da = actual[i] - cur[i];
    const dp = predicted[i] - cur[i];
    if (da === 0) continue;
    tot++;
    if (da * dp > 0) hit++;
  }
  return tot > 0 ? hit / tot : 0;
}

export interface PhaseSimplexResult {
  ok: boolean;
  message?: string;
  n: number;
  rhoBase: number;
  rhoAug: number;
  rhoShuffled: number; // 位相シャッフル対照(平均)
  dirBase: number;
  dirAug: number;
  deltaRho: number; // rhoAug - rhoBase
  improves: boolean; // 位相つきが ベースライン超 かつ シャッフル対照超
}

// 3.E 埋め込み座標に週次位相 (cos,sin) を加えて Simplex 予測スキルが上がるか
// 上がる(かつ位相シャッフルでは上がらない)なら、週内構造は予測=トレードに効く
export function computePhaseAugmentedSimplex(
  prices: PricePoint[],
  seriesMode: SeriesMode,
  opts: { tau: number; dim: 2 | 3; phaseMode: PhaseMode; phaseWeight?: number; nShuffle?: number }
): PhaseSimplexResult {
  const phaseWeight = opts.phaseWeight ?? 1;
  const nShuffle = opts.nShuffle ?? 20;
  const empty: PhaseSimplexResult = {
    ok: false, n: 0, rhoBase: 0, rhoAug: 0, rhoShuffled: 0,
    dirBase: 0, dirAug: 0, deltaRho: 0, improves: false,
  };

  const { V, P, m } = buildVPT(prices, seriesMode, opts.tau, opts.dim, opts.phaseMode);
  const n = V.length;
  if (n < 80) return { ...empty, message: "予測に必要なデータが不足(80点以上)" };

  // 埋め込み座標を z-score 標準化 (位相座標と距離スケールを揃える)
  const mean = new Array(m).fill(0);
  for (const v of V) for (let j = 0; j < m; j++) mean[j] += v[j];
  for (let j = 0; j < m; j++) mean[j] /= n;
  const std = new Array(m).fill(0);
  for (const v of V) for (let j = 0; j < m; j++) std[j] += (v[j] - mean[j]) ** 2;
  for (let j = 0; j < m; j++) std[j] = Math.sqrt(std[j] / n) || 1;

  const baseCoords = V.map((v) => v.map((x, j) => (x - mean[j]) / std[j]));
  const v0 = V.map((v) => v[0]); // 予測対象の生系列(seriesModeの値)

  const phaseCos = P.map((p) => phaseWeight * Math.cos((2 * Math.PI * p) / K));
  const phaseSin = P.map((p) => phaseWeight * Math.sin((2 * Math.PI * p) / K));
  const augCoords = baseCoords.map((c, i) => [...c, phaseCos[i], phaseSin[i]]);

  const k = m + 1;
  const base = simplexCore(baseCoords, v0, k);
  const aug = simplexCore(augCoords, v0, k);
  const rhoBase = pearson(base.actual, base.predicted);
  const rhoAug = pearson(aug.actual, aug.predicted);
  const dirBase = dirAccuracy(base.actual, base.predicted, base.cur);
  const dirAug = dirAccuracy(aug.actual, aug.predicted, aug.cur);

  // 位相シャッフル対照: 位相ラベルをシャッフルして同じ拡張をしても改善しないはず
  let rhoShufSum = 0;
  const Pw = P.slice();
  for (let s = 0; s < nShuffle; s++) {
    shuffleInPlace(Pw);
    const sc = Pw.map((p) => phaseWeight * Math.cos((2 * Math.PI * p) / K));
    const ss = Pw.map((p) => phaseWeight * Math.sin((2 * Math.PI * p) / K));
    const shufCoords = baseCoords.map((c, i) => [...c, sc[i], ss[i]]);
    const r = simplexCore(shufCoords, v0, k);
    rhoShufSum += pearson(r.actual, r.predicted);
  }
  const rhoShuffled = rhoShufSum / nShuffle;

  const deltaRho = rhoAug - rhoBase;
  const improves = rhoAug > rhoBase && rhoAug > rhoShuffled + 0.005;

  return {
    ok: true,
    n: base.actual.length,
    rhoBase,
    rhoAug,
    rhoShuffled,
    dirBase,
    dirAug,
    deltaRho,
    improves,
  };
}

// ============================================================================
// A. 位相つき S-map (θスイープ): 非線形性テスト + 位相が予測に効くか
// ============================================================================

// ガウス消去(部分ピボット, p<=6)
function gaussSolve(A: number[][], b: number[]): number[] | null {
  const p = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++)
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= p; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[p] / row[i]);
}

// 重み付き最小二乗 (正規方程式 + 軽いリッジ)
function solveWLS(X: number[][], y: number[], w: number[]): number[] | null {
  const n = X.length, p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const wi = w[i];
    if (wi <= 0) continue;
    for (let a = 0; a < p; a++) {
      b[a] += wi * X[i][a] * y[i];
      for (let c = 0; c < p; c++) A[a][c] += wi * X[i][a] * X[i][c];
    }
  }
  for (let a = 0; a < p; a++) A[a][a] += 1e-8;
  return gaussSolve(A, b);
}

// S-map コア: θで局所性を制御した重み付き局所線形回帰
// θ=0 → 大域線形(AR的), θ大 → 局所線形(非線形)。計算量を抑えるため窓を制限。
function smapCore(
  coords: number[][],
  v0: number[],
  theta: number,
  maxLib = 500,
  maxPred = 300
): number {
  const n = coords.length;
  const dimC = coords[0].length;
  const predCount = Math.min(maxPred, Math.floor(n * 0.3));
  if (predCount < 20) return 0;
  const predStart = n - 1 - predCount;
  const libStart = Math.max(0, predStart - maxLib);
  const actual: number[] = [], predicted: number[] = [];

  for (let t = predStart; t < n - 1; t++) {
    const dists: number[] = [];
    let dsum = 0, dcnt = 0;
    for (let j = libStart; j < predStart; j++) {
      let d = 0;
      for (let c = 0; c < dimC; c++) { const dd = coords[t][c] - coords[j][c]; d += dd * dd; }
      d = Math.sqrt(d);
      dists.push(d); dsum += d; dcnt++;
    }
    const dbar = dcnt > 0 ? dsum / dcnt : 1;
    const X: number[][] = [], y: number[] = [], w: number[] = [];
    let idx = 0;
    for (let j = libStart; j < predStart; j++) {
      const wj = Math.exp(-theta * dists[idx++] / (dbar || 1e-10));
      w.push(wj);
      X.push([1, ...coords[j]]);
      y.push(v0[j + 1]);
    }
    const beta = solveWLS(X, y, w);
    if (!beta) continue;
    let pred = beta[0];
    for (let c = 0; c < dimC; c++) pred += beta[c + 1] * coords[t][c];
    actual.push(v0[t + 1]); predicted.push(pred);
  }
  return pearson(actual, predicted);
}

export interface PhaseSmapResult {
  ok: boolean;
  message?: string;
  thetas: number[];
  rhoBase: number[]; // 埋め込みのみ
  rhoAug: number[]; // 埋め込み+週次位相
  bestThetaBase: number;
  rhoLinearBase: number; // θ=0
  rhoBestBase: number;
  nonlinear: boolean; // θ>0 で予測改善 = 非線形
  phaseHelps: boolean; // 位相つきがベースライン最大を上回る
}

export function computePhaseAugmentedSmap(
  prices: PricePoint[],
  seriesMode: SeriesMode,
  opts: { tau: number; dim: 2 | 3; phaseMode: PhaseMode; phaseWeight?: number }
): PhaseSmapResult {
  const phaseWeight = opts.phaseWeight ?? 1;
  const thetas = [0, 0.1, 0.3, 0.5, 1, 2, 4, 8];
  const empty: PhaseSmapResult = {
    ok: false, thetas, rhoBase: [], rhoAug: [],
    bestThetaBase: 0, rhoLinearBase: 0, rhoBestBase: 0, nonlinear: false, phaseHelps: false,
  };
  const { V, P, m } = buildVPT(prices, seriesMode, opts.tau, opts.dim, opts.phaseMode);
  const n = V.length;
  if (n < 120) return { ...empty, message: "S-mapに必要なデータが不足(120点以上)" };

  const mean = new Array(m).fill(0);
  for (const v of V) for (let j = 0; j < m; j++) mean[j] += v[j];
  for (let j = 0; j < m; j++) mean[j] /= n;
  const std = new Array(m).fill(0);
  for (const v of V) for (let j = 0; j < m; j++) std[j] += (v[j] - mean[j]) ** 2;
  for (let j = 0; j < m; j++) std[j] = Math.sqrt(std[j] / n) || 1;
  const baseCoords = V.map((v) => v.map((x, j) => (x - mean[j]) / std[j]));
  const augCoords = baseCoords.map((c, i) => [
    ...c,
    phaseWeight * Math.cos((2 * Math.PI * P[i]) / K),
    phaseWeight * Math.sin((2 * Math.PI * P[i]) / K),
  ]);
  const v0 = V.map((v) => v[0]);

  const rhoBase = thetas.map((th) => smapCore(baseCoords, v0, th));
  const rhoAug = thetas.map((th) => smapCore(augCoords, v0, th));

  let bestIdx = 0;
  for (let i = 1; i < rhoBase.length; i++) if (rhoBase[i] > rhoBase[bestIdx]) bestIdx = i;
  const rhoBestBase = rhoBase[bestIdx];
  const rhoLinearBase = rhoBase[0];
  const nonlinear = thetas[bestIdx] > 0 && rhoBestBase > rhoLinearBase + 0.02;
  const phaseHelps = Math.max(...rhoAug) > rhoBestBase + 0.005;

  return {
    ok: true, thetas, rhoBase, rhoAug,
    bestThetaBase: thetas[bestIdx], rhoLinearBase, rhoBestBase, nonlinear, phaseHelps,
  };
}

// ============================================================================
// B1. レジーム層別 位相ロック (週内構造はどのボラ状態で出るか)
// ============================================================================

export interface RegimeStratifiedResult {
  ok: boolean;
  message?: string;
  volThreshold: number; // ローリングσの中央値
  high: { PL: number; pValue: number; q95: number; n: number };
  low: { PL: number; pValue: number; q95: number; n: number };
  all: { PL: number; pValue: number; q95: number; n: number };
}

function plWithSurrogate(V: number[][], P: number[], m: number, B = 299): { PL: number; pValue: number; q95: number } {
  const f = fRatio(V, P, m);
  const surr: number[] = [];
  const Pw = P.slice();
  for (let b = 0; b < B; b++) {
    shuffleInPlace(Pw);
    surr.push(fRatio(V, Pw, m).PL);
  }
  surr.sort((a, b) => a - b);
  const q95 = surr[Math.min(B - 1, Math.floor(0.95 * B))];
  let ge = 0;
  for (const s of surr) if (s >= f.PL) ge++;
  return { PL: f.PL, pValue: (1 + ge) / (B + 1), q95 };
}

export function computeRegimeStratifiedPL(
  prices: PricePoint[],
  seriesMode: SeriesMode,
  opts: { tau: number; dim: 2 | 3; phaseMode: PhaseMode; volWindow?: number }
): RegimeStratifiedResult {
  const volWindow = opts.volWindow ?? 21;
  const empty: RegimeStratifiedResult = {
    ok: false, volThreshold: 0,
    high: { PL: 0, pValue: 1, q95: 0, n: 0 },
    low: { PL: 0, pValue: 1, q95: 0, n: 0 },
    all: { PL: 0, pValue: 1, q95: 0, n: 0 },
  };
  const { V, P, T, m } = buildVPT(prices, seriesMode, opts.tau, opts.dim, opts.phaseMode);
  const n = V.length;
  if (n < 120) return { ...empty, message: "層別に必要なデータが不足" };

  // 日次対数リターンのローリングσを date→vol で引く
  const closes = prices.map((p) => p.close);
  const times = prices.map((p) => p.time);
  const r: number[] = [], rt: string[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) { r.push(Math.log(closes[i] / closes[i - 1])); rt.push(times[i]); }
  }
  const volMap = new Map<string, number>();
  for (let i = volWindow - 1; i < r.length; i++) {
    let s = 0, mu = 0;
    for (let j = i - volWindow + 1; j <= i; j++) mu += r[j];
    mu /= volWindow;
    for (let j = i - volWindow + 1; j <= i; j++) s += (r[j] - mu) ** 2;
    volMap.set(rt[i], Math.sqrt(s / volWindow));
  }

  const vols: number[] = [];
  const idxVol: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = volMap.get(T[i]);
    idxVol.push(v ?? NaN);
    if (v !== undefined && !isNaN(v)) vols.push(v);
  }
  if (vols.length < 80) return { ...empty, message: "ボラ算出に必要なデータが不足" };
  const sortedVol = vols.slice().sort((a, b) => a - b);
  const volThreshold = sortedVol[Math.floor(sortedVol.length / 2)];

  const Vh: number[][] = [], Ph: number[] = [], Vl: number[][] = [], Pl: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = idxVol[i];
    if (isNaN(v)) continue;
    if (v >= volThreshold) { Vh.push(V[i]); Ph.push(P[i]); }
    else { Vl.push(V[i]); Pl.push(P[i]); }
  }
  if (Vh.length < 40 || Vl.length < 40) return { ...empty, message: "各レジームの点数が不足" };

  const all = { ...plWithSurrogate(V, P, m), n };
  const high = { ...plWithSurrogate(Vh, Ph, m), n: Vh.length };
  const low = { ...plWithSurrogate(Vl, Pl, m), n: Vl.length };

  return { ok: true, volThreshold, high, low, all };
}

// ============================================================================
// B3. 適応的位相 (Hilbert): 固定5でなくデータ駆動の瞬時位相で位相ロック検証
// ============================================================================

function meanPeriod(data: number[]): number {
  let mean = 0;
  for (const v of data) mean += v;
  mean /= data.length;
  let crossings = 0;
  for (let i = 1; i < data.length; i++) if ((data[i - 1] - mean) * (data[i] - mean) < 0) crossings++;
  return crossings >= 4 ? (2 * data.length) / crossings : Infinity;
}

export interface AdaptivePhaseResult {
  ok: boolean;
  message?: string;
  selectedImf: string;
  selectedPeriod: number; // 採用IMFの平均周期(営業日)
  nGroups: number;
  adaptive: { PL: number; pValue: number; q95: number };
  calendar: { PL: number; pValue: number; q95: number };
  n: number;
}

export function computeAdaptivePhaseAttractor(
  prices: PricePoint[],
  seriesMode: SeriesMode,
  opts: { tau: number; dim: 2 | 3; targetPeriod?: number; nGroups?: number }
): AdaptivePhaseResult {
  const targetPeriod = opts.targetPeriod ?? 5;
  const nGroups = opts.nGroups ?? 5;
  const empty: AdaptivePhaseResult = {
    ok: false, selectedImf: "", selectedPeriod: 0, nGroups,
    adaptive: { PL: 0, pValue: 1, q95: 0 },
    calendar: { PL: 0, pValue: 1, q95: 0 }, n: 0,
  };

  const { values, times } = extractSeries(prices, seriesMode);
  if (values.length < 150) return { ...empty, message: "適応的位相に必要なデータが不足" };

  const { imfs } = computeEMD(values, 6);
  if (imfs.length === 0) return { ...empty, message: "IMFが抽出できませんでした" };
  // 目標周期(週)に最も近いIMFを選ぶ
  let best = -1, bestDiff = Infinity, bestPeriod = 0;
  imfs.forEach((imf, i) => {
    const per = meanPeriod(imf.data);
    if (!isFinite(per)) return;
    const diff = Math.abs(per - targetPeriod);
    if (diff < bestDiff) { bestDiff = diff; best = i; bestPeriod = per; }
  });
  if (best < 0) return { ...empty, message: "週次近傍のIMFがありません" };

  const { phase } = hilbertTransform(imfs[best].data);

  // 埋め込みと位相を整列 (最も新しい座標の時刻に対応する位相)
  const emb = takensEmbedding(values, times, opts.tau, opts.dim);
  const start = (opts.dim - 1) * opts.tau;
  const V: number[][] = [];
  const Pa: number[] = []; // 適応的位相のビン
  const T: string[] = [];
  emb.forEach((p, i) => {
    const srcIdx = start + i;
    const ph = phase[srcIdx];
    if (ph === undefined) return;
    const bin = Math.min(nGroups - 1, Math.max(0, Math.floor(((ph + Math.PI) / (2 * Math.PI)) * nGroups)));
    V.push(opts.dim >= 3 ? [p.x, p.y, p.z ?? 0] : [p.x, p.y]);
    Pa.push(bin);
    T.push(p.time);
  });
  const m = opts.dim;
  const n = V.length;
  if (n < 100) return { ...empty, message: "整列後の点数が不足" };

  // 適応的位相のPL (nGroups群)
  const surrA = (Pin: number[]) => {
    const f = fRatio(V, Pin, m, nGroups);
    const B = 299;
    const surr: number[] = [];
    const Pw = Pin.slice();
    for (let b = 0; b < B; b++) { shuffleInPlace(Pw); surr.push(fRatio(V, Pw, m, nGroups).PL); }
    surr.sort((a, b) => a - b);
    const q95 = surr[Math.min(B - 1, Math.floor(0.95 * B))];
    let ge = 0; for (const s of surr) if (s >= f.PL) ge++;
    return { PL: f.PL, pValue: (1 + ge) / (B + 1), q95 };
  };
  const adaptive = surrA(Pa);

  // 比較用カレンダー位相 (同じVに対し曜日)
  const Pc = T.map(weekdayIndex);
  const Vc: number[][] = [], Pcf: number[] = [];
  for (let i = 0; i < V.length; i++) if (Pc[i] >= 0) { Vc.push(V[i]); Pcf.push(Pc[i]); }
  const fc = fRatio(Vc, Pcf, m, 5);
  const Bc = 299; const surrc: number[] = []; const Pcw = Pcf.slice();
  for (let b = 0; b < Bc; b++) { shuffleInPlace(Pcw); surrc.push(fRatio(Vc, Pcw, m, 5).PL); }
  surrc.sort((a, b) => a - b);
  const q95c = surrc[Math.min(Bc - 1, Math.floor(0.95 * Bc))];
  let gec = 0; for (const s of surrc) if (s >= fc.PL) gec++;
  const calendar = { PL: fc.PL, pValue: (1 + gec) / (Bc + 1), q95: q95c };

  return {
    ok: true,
    selectedImf: imfs[best].label,
    selectedPeriod: bestPeriod,
    nGroups,
    adaptive,
    calendar,
    n,
  };
}

// ============================================================================
// B4. 一般周期アトラクタ (月内=21 / 四半期内=63 へ拡張)
// ============================================================================

export interface PeriodicPhaseResult {
  ok: boolean;
  message?: string;
  period: number;
  n: number;
  points: { x: number; y: number; phase: number; time: string }[];
  centroids2d: { x: number; y: number }[];
  groupStats: { phase: number; count: number; dispersionRatio: number }[];
  PL: number;
  surrogateQ95: number;
  pValue: number;
}

export function computePeriodicPhaseAttractor(
  prices: PricePoint[],
  seriesMode: SeriesMode,
  opts: { tau: number; dim: 2 | 3; period: number; surrogateCount?: number }
): PeriodicPhaseResult {
  const { period } = opts;
  const B = opts.surrogateCount ?? 299;
  const empty: PeriodicPhaseResult = {
    ok: false, period, n: 0, points: [], centroids2d: [], groupStats: [],
    PL: 0, surrogateQ95: 0, pValue: 1,
  };
  const { values, times } = extractSeries(prices, seriesMode);
  const emb = takensEmbedding(values, times, opts.tau, opts.dim);
  if (emb.length < period * 10 + 50) return { ...empty, message: "この周期に必要なデータが不足" };

  const m = opts.dim;
  const V = emb.map((p) => (opts.dim >= 3 ? [p.x, p.y, p.z ?? 0] : [p.x, p.y]));
  const T = emb.map((p) => p.time);
  // 営業日位相: 埋め込み点のインデックス mod period
  const P = emb.map((_, i) => i % period);
  const n = V.length;

  const f = fRatio(V, P, m, period);
  if (f.groupsPresent < 2) return { ...empty, message: "周期グループが不足" };

  // 全体平均分散(分散比の基準)
  const overall = new Array(m).fill(0);
  for (const v of V) for (let j = 0; j < m; j++) overall[j] += v[j];
  for (let j = 0; j < m; j++) overall[j] /= n;
  let overallSS = 0;
  for (const v of V) { let d = 0; for (let j = 0; j < m; j++) { const dd = v[j] - overall[j]; d += dd * dd; } overallSS += d; }
  const overallMeanVar = overallSS / n;

  const groupStats = [];
  const centroids2d = [];
  for (let k = 0; k < period; k++) {
    const cnt = f.counts[k];
    const cent = f.centroids[k];
    const meanVar = cnt > 0 ? f.groupSpread[k] / cnt : 0;
    groupStats.push({
      phase: k,
      count: cnt,
      dispersionRatio: overallMeanVar > 0 && cnt > 0 ? meanVar / overallMeanVar : NaN,
    });
    centroids2d.push(cnt > 0 ? { x: cent[0], y: cent[1] } : { x: NaN, y: NaN });
  }

  const surr: number[] = [];
  const Pw = P.slice();
  for (let b = 0; b < B; b++) { shuffleInPlace(Pw); surr.push(fRatio(V, Pw, m, period).PL); }
  surr.sort((a, b) => a - b);
  const surrogateQ95 = surr[Math.min(B - 1, Math.floor(0.95 * B))];
  let ge = 0; for (const s of surr) if (s >= f.PL) ge++;
  const pValue = (1 + ge) / (B + 1);

  const points = V.map((v, i) => ({ x: v[0], y: v[1], phase: P[i], time: T[i] }));

  return { ok: true, period, n, points, centroids2d, groupStats, PL: f.PL, surrogateQ95, pValue };
}

// ============================================================================
// B2. 週次位相同期 (Kuramoto): 複数銘柄の選好曜日が揃うか
// ============================================================================

export interface PhaseSyncItem {
  ticker: string;
  preferredPhaseRad: number; // 第1高調波の位相角
  amplitude: number; // 高調波振幅 (週次パターンの強さ)
  peakPhase: number; // ドリフト最大の曜日 0..4
  ok: boolean;
}

export interface PhaseSyncResult {
  ok: boolean;
  message?: string;
  items: PhaseSyncItem[];
  orderParameter: number; // r = |(1/N)Σ exp(iθ)| (無加重)
  weightedOrder: number; // 振幅加重
  meanPhaseRad: number;
}

// 1銘柄の週次選好位相を計算
function weeklyPreferredPhase(prices: PricePoint[], phaseMode: PhaseMode): PhaseSyncItem | null {
  const km = computeWeeklyPhaseKM(prices, phaseMode);
  if (!km.ok) return null;
  let a = 0, b = 0;
  for (let k = 0; k < K; k++) {
    a += km.drift[k] * Math.cos((2 * Math.PI * k) / K);
    b += km.drift[k] * Math.sin((2 * Math.PI * k) / K);
  }
  return {
    ticker: "",
    preferredPhaseRad: Math.atan2(b, a),
    amplitude: Math.sqrt(a * a + b * b),
    peakPhase: km.drift.reduce((bi, v, i) => (v > km.drift[bi] ? i : bi), 0),
    ok: true,
  };
}

export function computeWeeklyPhaseSync(
  series: { ticker: string; prices: PricePoint[] }[],
  phaseMode: PhaseMode
): PhaseSyncResult {
  const items: PhaseSyncItem[] = [];
  for (const s of series) {
    const it = weeklyPreferredPhase(s.prices, phaseMode);
    if (it) items.push({ ...it, ticker: s.ticker });
  }
  if (items.length < 2) {
    return { ok: false, message: "2銘柄以上必要", items, orderParameter: 0, weightedOrder: 0, meanPhaseRad: 0 };
  }
  let cx = 0, cy = 0, wcx = 0, wcy = 0, wsum = 0;
  for (const it of items) {
    cx += Math.cos(it.preferredPhaseRad);
    cy += Math.sin(it.preferredPhaseRad);
    wcx += it.amplitude * Math.cos(it.preferredPhaseRad);
    wcy += it.amplitude * Math.sin(it.preferredPhaseRad);
    wsum += it.amplitude;
  }
  const N = items.length;
  const orderParameter = Math.sqrt(cx * cx + cy * cy) / N;
  const weightedOrder = wsum > 0 ? Math.sqrt(wcx * wcx + wcy * wcy) / wsum : 0;
  const meanPhaseRad = Math.atan2(cy, cx);
  return { ok: true, items, orderParameter, weightedOrder, meanPhaseRad };
}
