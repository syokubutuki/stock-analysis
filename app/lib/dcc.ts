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
    nDays: 0, nCalm: 0, lookback, quantile,
  });

  if (n < 2) return fail("銘柄数不足");
  // 部分標本の日数が銘柄数を下回ると相関行列がランク落ちし、ストレスVaRがさらに過小評価になる。
  const minDays = Math.max(20, n + 5);
  if (T <= lookback + minDays) return fail(`期間不足(リターン${T}日 / 助走${lookback}日)`);

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
    return fail(`高ボラ標本不足(${stressDays.length}日 / 最低${minDays}日)`);
  if (calmDays.length < minDays)
    return fail(`低ボラ標本不足(${calmDays.length}日 / 最低${minDays}日)`);

  const hi = corrSubset(returns, stressDays);
  const lo = corrSubset(returns, calmDays);
  return {
    ok: true,
    reason: "",
    matrix: hi.matrix,
    avg: hi.avg,
    avgCalm: lo.avg,
    nDays: stressDays.length,
    nCalm: calmDays.length,
    lookback,
    quantile,
  };
}
