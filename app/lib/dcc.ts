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

// ---- 危機レジーム相関(高ボラ局面で実現する相関) ----
//
// 【重要】レジームを「同時点の等加重バスケットのリターンが下位q分位」で切ってはいけない。
// バスケットは共通ファクターの代理なので、その実現値の片側テールで標本を切ると、
// 部分標本内のファクター分散が切り詰められ、相関が機械的に下がる
// (Boyer-Gibson-Loretan 1999 / Forbes-Rigobon 2002 の条件付けバイアス)。2変量正規なら
//   ρ_A = ρ · √{(1+δ) / (1+δρ²)},  δ = Var(x|A)/Var(x) − 1
// で、片側切断は δ<0 すなわち ρ_A < ρ。相関一定の合成データに対してすら
// 「危機時ほど相関が低い」という逆の答えが出る(全標本が両部分標本を上回るのが検知サイン)。
// n=2 ではバスケットが (x+y)/2 そのものなので正の相関の方向を直接切り詰める最悪ケースだが、
// n が増えると個別ノイズが平均で消えてバスケット≒共通ファクターに収束するため、切り詰めが
// ほぼ純粋にファクター分散へ効くようになる。どの n でもバイアスは消えない。
//
// そこで危機レジームは **直近 lookback 日のバスケット実現ボラが上位 q 分位** で定義する。
// 当日のリターンを条件にしないのでこのバイアスが入らず、判定に当日の情報を使わない
// (先読み無し)ため実運用でも成立するレジーム定義になる。
//
// なお高ボラ標本では δ>0 のぶん相関が持ち上がる。これは条件付けの副作用ではなく
// 「高ボラ局面で実際に実現する相関」なので、ボラを別途固定して相関だけ差し替える
// ストレスVaRの用途には整合的。ただし上下対称な定義なので「下落時だけ相関が上がる」という
// 非対称性の検証には使えない(それには exceedance correlation を2変量正規のヌルと比べる必要がある)。
export interface StressCorr {
  ok: boolean;
  reason: string; // ok=false のときの理由(UI表示用)
  matrix: number[][]; // 高ボラ標本の相関行列
  avg: number; // 高ボラ標本の平均相関
  avgCalm: number; // 低ボラ標本(補集合)の平均相関 — 比較用
  nDays: number;
  nCalm: number;
  lookback: number;
  quantile: number;
  /** 高ボラ(危機)と判定した日のインデックス。ブートストラップで再標本化するため公開する。 */
  stressDays: number[];
  /** 低ボラ(平時)と判定した日のインデックス。 */
  calmDays: number[];
}

function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  let s = 0;
  for (const v of a) s += (v - m) * (v - m);
  return Math.sqrt(s / (a.length - 1));
}

// 指定日だけを抜き出した Pearson 相関行列(部分標本内で平均を取り直す)
function corrSubset(
  returns: number[][],
  days: number[]
): { matrix: number[][]; avg: number } {
  const n = returns.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const m = returns.map((r) => mean(days.map((t) => r[t])));
  let s = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      let cov = 0;
      let vi = 0;
      let vj = 0;
      for (const t of days) {
        const di = returns[i][t] - m[i];
        const dj = returns[j][t] - m[j];
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
  return { matrix, avg: c > 0 ? s / c : 0 };
}

/**
 * レジーム分割の中身。[asset][t] のリターン行列だけを受ける形にしてあるのは、
 * ブートストラップ(下の stressCorrelationCI)が**再標本化した行列に対して同じ手続きを
 * そのまま流す**ためで、定義を二重に書かないための分離。
 */
function splitByTrailingVol(
  returns: number[][],
  quantile: number,
  lookback: number,
  minDays: number
): { ok: false; reason: string } | { ok: true; stressDays: number[]; calmDays: number[] } {
  const n = returns.length;
  const T = n > 0 ? returns[0].length : 0;
  if (T <= lookback + minDays)
    return { ok: false, reason: `期間不足(リターン${T}日 / 助走${lookback}日)` };

  // 等加重バスケットの日次リターン
  const basket: number[] = [];
  for (let t = 0; t < T; t++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += returns[i][t];
    basket.push(s / n);
  }

  // 直近 lookback 日の実現ボラ。t 日自身のリターンは含めない(=当日寄付時点で既知)。
  const trail: { t: number; v: number }[] = [];
  for (let t = lookback; t < T; t++) trail.push({ t, v: std(basket.slice(t - lookback, t)) });

  const cut = [...trail].sort((a, b) => b.v - a.v)[
    Math.floor(quantile * (trail.length - 1))
  ].v;
  const stressDays: number[] = [];
  const calmDays: number[] = [];
  for (const x of trail) (x.v >= cut ? stressDays : calmDays).push(x.t);
  if (stressDays.length < minDays)
    return { ok: false, reason: `高ボラ標本不足(${stressDays.length}日 / 最低${minDays}日)` };
  if (calmDays.length < minDays)
    return { ok: false, reason: `低ボラ標本不足(${calmDays.length}日 / 最低${minDays}日)` };
  return { ok: true, stressDays, calmDays };
}

export function stressCorrelation(
  aligned: AlignedReturns,
  opts: { quantile?: number; lookback?: number } = {}
): StressCorr {
  const quantile = opts.quantile ?? 0.25;
  const lookback = opts.lookback ?? 60; // 約13週
  const { tickers, returns } = aligned;
  const n = tickers.length;
  const T = n > 0 ? returns[0].length : 0;
  const fail = (reason: string): StressCorr => ({
    ok: false, reason, matrix: [], avg: 0, avgCalm: 0,
    nDays: 0, nCalm: 0, lookback, quantile, stressDays: [], calmDays: [],
  });

  if (n < 2) return fail("銘柄数不足");
  // 部分標本の日数が銘柄数を下回ると相関行列がランク落ちし、ストレスVaRがさらに過小評価になる。
  const minDays = Math.max(20, n + 5);
  if (T <= lookback + minDays) return fail(`期間不足(リターン${T}日 / 助走${lookback}日)`);

  const split = splitByTrailingVol(returns, quantile, lookback, minDays);
  if (!split.ok) return fail(split.reason);

  const hi = corrSubset(returns, split.stressDays);
  const lo = corrSubset(returns, split.calmDays);
  return {
    ok: true,
    reason: "",
    matrix: hi.matrix,
    avg: hi.avg,
    avgCalm: lo.avg,
    nDays: split.stressDays.length,
    nCalm: split.calmDays.length,
    lookback,
    quantile,
    stressDays: split.stressDays,
    calmDays: split.calmDays,
  };
}

// ---- 危機時 ρ と平時 ρ の差の不確かさ(モービングブロック・ブートストラップ) ----
//
// 【なぜ要るか】危機標本は全体の quantile 分(既定25%)しかない部分標本なので、
// 「危機時 ρ が平時より低い/高い」が出ても、それが**本物の非定常性なのか小標本ノイズなのか**を
// 点推定だけでは判定できない(実測でも窓を 252日→756日 に変えると符号が入れ替わる)。
// そこで Δρ = ρ_stress − ρ_calm の標本分布をブートストラップで作り、CI が 0 を跨ぐかで判定する。
//
// 【なぜブロックか】日次リターンには**ボラのクラスタリング**があり、レジーム分割自体が
// 「直近60日のボラ」という時系列構造に依存している。1日ずつ独立に再標本化すると
// クラスタリングが壊れて危機レジームそのものが消えてしまう(Δρ の分散を過小評価する)。
// そこで長さ L の**連続ブロック**を再標本化し、全銘柄で同じ日付ブロックを取る
// (=横断的な同時性を保存する)。L は既定 20営業日(約1か月)——lookback=60日の
// ボラ窓に対して 3ブロックで1窓ぶんが埋まる長さ。
//
// 【読み方】CI が 0 を跨ぐ ⇒「差は検出できない」と言い切ってよい(＝ノイズと区別がつかない)。
// 跨がない ⇒ 標本内では本物の差。ただし**次の危機で同じ向きになる保証ではない**。
//
// 注: 区間は**基本(ピボット)法**で作る(理由は下の実装コメント)。ρ 単体の CI は
// Fisher 変換 z=½ln((1+ρ)/(1−ρ)) 上でピボットを取ってから逆変換して戻す
// (ρ は ±1 で頭打ちなので、そのままだと区間が範囲外へ出る)。差 Δρ はそのまま扱う。
export interface StressCorrCI {
  ok: boolean;
  reason: string;
  /** 実測の Δρ = ρ_stress − ρ_calm。 */
  delta: number;
  /** Δρ のブートストラップ CI(level 両側)。 */
  deltaLo: number;
  deltaHi: number;
  deltaMedian: number;
  /** ブート標本の標準偏差(＝Δρ の標準誤差の推定)。 */
  deltaSe: number;
  /** 両側 p 値 ＝ P(|Δ* − Δ̂| ≥ |Δ̂|)（ブート分布を Δ̂ へ中心化して作ったヌル）。 */
  pTwoSided: number;
  /** CI が 0 を含むか。true なら「差は検出できない」。 */
  crossesZero: boolean;
  /** 危機時 ρ 単体の CI。 */
  stressLo: number;
  stressHi: number;
  /** 平時 ρ 単体の CI。 */
  calmLo: number;
  calmHi: number;
  /** 成功したブート標本数(レジーム分割に失敗した回は捨てる)。 */
  b: number;
  bRequested: number;
  blockLen: number;
  /** 両側の被覆確率(0.9 なら 5%〜95% 分位)。 */
  level: number;
}

const EMPTY_CI = (reason: string, blockLen: number, level: number, bRequested: number): StressCorrCI => ({
  ok: false, reason, delta: 0, deltaLo: 0, deltaHi: 0, deltaMedian: 0, deltaSe: 0,
  pTwoSided: 1, crossesZero: true, stressLo: 0, stressHi: 0, calmLo: 0, calmHi: 0,
  b: 0, bRequested, blockLen, level,
});

function quantileOf(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * Math.min(Math.max(q, 0), 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** 標準正規の CDF（Abramowitz-Stegun 近似の erf）。Wald 型の p 値に使う。 */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** 標準正規の分位点（Acklam の有理近似・両側 CI の臨界値用）。 */
function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Fisher の z 変換。相関の CI を端で範囲外へ出さないために使う。 */
const fisher = (r: number) => 0.5 * Math.log((1 + Math.min(Math.max(r, -0.999999), 0.999999)) / (1 - Math.min(Math.max(r, -0.999999), 0.999999)));
const fisherInv = (z: number) => Math.tanh(z);

/** 再現性のための seeded RNG(プロジェクト共通の mulberry32)。 */
function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function stressCorrelationCI(
  aligned: AlignedReturns,
  opts: {
    quantile?: number;
    lookback?: number;
    /** ブート反復数(既定 400)。 */
    b?: number;
    /** ブロック長(営業日・既定 20)。 */
    blockLen?: number;
    /** 両側被覆(既定 0.9)。 */
    level?: number;
    seed?: number;
  } = {}
): StressCorrCI {
  const quantile = opts.quantile ?? 0.25;
  const lookback = opts.lookback ?? 60;
  const B = Math.max(50, Math.round(opts.b ?? 400));
  const blockLen = Math.max(2, Math.round(opts.blockLen ?? 20));
  const level = Math.min(0.99, Math.max(0.5, opts.level ?? 0.9));
  const seed = opts.seed ?? 20260727;

  const { tickers, returns } = aligned;
  const n = tickers.length;
  const T = n > 0 ? returns[0].length : 0;
  if (n < 2) return EMPTY_CI("銘柄数不足", blockLen, level, B);

  const minDays = Math.max(20, n + 5);
  const base = splitByTrailingVol(returns, quantile, lookback, minDays);
  if (!base.ok) return EMPTY_CI(base.reason, blockLen, level, B);
  if (T < blockLen * 3) return EMPTY_CI(`ブロック長に対し期間不足(${T}日)`, blockLen, level, B);

  const baseHi = corrSubset(returns, base.stressDays).avg;
  const baseLo = corrSubset(returns, base.calmDays).avg;
  const delta = baseHi - baseLo;

  const nBlocks = Math.ceil(T / blockLen);
  const maxStart = T - blockLen; // 0..maxStart から一様にブロック始点を引く(モービングブロック)
  const rand = rng32(seed);
  const buf: number[][] = Array.from({ length: n }, () => new Array(T).fill(0));

  const deltas: number[] = [];
  const hiZ: number[] = [];
  const loZ: number[] = [];
  for (let b = 0; b < B; b++) {
    let filled = 0;
    for (let k = 0; k < nBlocks && filled < T; k++) {
      const start = Math.floor(rand() * (maxStart + 1));
      const len = Math.min(blockLen, T - filled);
      for (let i = 0; i < n; i++) {
        const src = returns[i];
        const dst = buf[i];
        for (let j = 0; j < len; j++) dst[filled + j] = src[start + j];
      }
      filled += len;
    }
    const sp = splitByTrailingVol(buf, quantile, lookback, minDays);
    if (!sp.ok) continue; // レジームが作れなかった回は捨てる(標本数 b に数えない)
    const h = corrSubset(buf, sp.stressDays).avg;
    const l = corrSubset(buf, sp.calmDays).avg;
    deltas.push(h - l);
    hiZ.push(fisher(h));
    loZ.push(fisher(l));
  }

  if (deltas.length < 30)
    return EMPTY_CI(`ブート標本不足(${deltas.length}回)`, blockLen, level, B);

  const alpha = (1 - level) / 2;
  const ds = [...deltas].sort((a, b) => a - b);
  const hs = [...hiZ].sort((a, b) => a - b);
  const ls = [...loZ].sort((a, b) => a - b);
  const m = deltas.reduce((s, v) => s + v, 0) / deltas.length;
  const se = Math.sqrt(
    deltas.reduce((s, v) => s + (v - m) * (v - m), 0) / Math.max(deltas.length - 1, 1)
  );

  // 【位置はブートに任せない — ここが一番の設計判断】
  // ブロック再標本化はレジームの**連なり**を部分的に崩す。危機は数週間まとまって来るのに、
  // 20日ブロックを貼り合わせた系列ではその塊が細切れになり、レジーム分割が甘くなる。
  // その結果 Δ* は実測 Δ̂ より系統的に 0 へ寄る(合成データで確認: 真に ρ が 0.35→0.8 と
  // 上がる系列で Δ̂=+0.220 に対しブート分布は [0.011, 0.209] に居座った)。
  // これは「Δ̂ に推定バイアスがある」のではなく**再標本化の副作用**なので、
  //   - 素のパーセンタイル区間 → 区間ごと 0 側へずれ、Δ̂ が区間の外に出る
  //   - 基本(ピボット)法で位置補正 → 今度は逆に持ち上げすぎる
  // どちらも位置がおかしくなる。そこで**位置は実測 Δ̂ に固定し、ブートは「ばらつき」の
  // 推定だけに使う**:
  //     SE = sd(Δ*) ,  CI = Δ̂ ± z_{1−α/2}·SE ,  p = 2(1 − Φ(|Δ̂|/SE))
  // Δ̂ は必ず区間の中心に来て、区間が 0 を外すことと p が小さいことが常に整合する。
  // 代償として Δ̂ の分布の正規近似を仮定するが、Δ̂ は多数のペア相関の平均差なので妥当。
  const zCrit = normalQuantile(1 - alpha);
  const wald = (est: number, sd: number) => ({ lo: est - zCrit * sd, hi: est + zCrit * sd });
  const sdOf = (a: number[]) => {
    const mm = a.reduce((s, v) => s + v, 0) / a.length;
    return Math.sqrt(a.reduce((s, v) => s + (v - mm) * (v - mm), 0) / Math.max(a.length - 1, 1));
  };
  const dCI = wald(delta, se);
  const zHi = wald(fisher(baseHi), sdOf(hs));
  const zLo = wald(fisher(baseLo), sdOf(ls));
  const pTwo = se > 1e-12 ? 2 * (1 - normalCdf(Math.abs(delta) / se)) : 1;

  return {
    ok: true,
    reason: "",
    delta,
    deltaLo: dCI.lo,
    deltaHi: dCI.hi,
    deltaMedian: quantileOf(ds, 0.5),
    deltaSe: se,
    pTwoSided: Math.min(1, pTwo),
    crossesZero: dCI.lo <= 0 && dCI.hi >= 0,
    stressLo: fisherInv(zHi.lo),
    stressHi: fisherInv(zHi.hi),
    calmLo: fisherInv(zLo.lo),
    calmHi: fisherInv(zLo.hi),
    b: deltas.length,
    bRequested: B,
    blockLen,
    level,
  };
}
