// 「下落時<em>だけ</em>相関が上がる」のか — exceedance correlation と2変量正規のヌル
// ============================================================================
// docs/portfolio-analysis-open-issues.md §4 の課題に対する実装。
//
// 【何が問題だったか】
// 既存の危機時相関（dcc.ts の stressCorrelation）は「直近60日のバスケット実現ボラが
// 上位25%の日」でレジームを切る。事前情報だけで切るので条件付けバイアスが入らない
// 正しい定義だが、**上下対称**なので「上昇の荒れ」も危機に含まれる。つまり
//
//     下落時 "だけ" 相関が上がる（テールの非対称性）
//
// という、分散投資にとって最も致命的な性質を検証できない。本ファイルはそこを埋める。
//
// 【なぜ素朴な部分標本比較ではダメか】
// 「両方とも −1σ 以下の日だけ取って相関を測る」と、たとえ真の分布が
// **完全に対称な2変量正規**であっても、条件付けによる切り詰めで相関の値は動く
// （Boyer-Gibson-Loretan 1999 / Forbes-Rigobon 2002）。したがって
// 「下側で 0.7、全体で 0.4 だから下落時に相関が上がる」は**何も言っていない**。
//
// 【解法：同じ切り方をヌルにも適用する】
// 実測と**同じ条件付け・同じ標本数**を、無条件相関だけを一致させた2変量正規
// （テール依存性ゼロ・完全対称）に適用し、その分布と比べる。条件付けバイアスは
// 両側に同じだけ効くので**差を取れば相殺**される。これが Longin-Solnik (2001) /
// Ang-Chen (2002) の考え方で、本実装は
//
//   ρ⁻(θ) = Corr(zᵢ, zⱼ | zᵢ ≤ −θ, zⱼ ≤ −θ)   下側 exceedance correlation
//   ρ⁺(θ) = Corr(zᵢ, zⱼ | zᵢ ≥ +θ, zⱼ ≥ +θ)   上側
//
// を θ = 0, 0.5, 1.0, 1.5（標準偏差単位）で測り、
//   ① 実測 vs ヌル（各 θ・各サイド）
//   ② 非対称性 A(θ) = ρ⁻(θ) − ρ⁺(θ)（ヌルでは対称なので E[A]=0）
//   ③ 総合統計量 H = √( mean( (ρ_実測 − ρ_ヌル平均)² ) )（Ang-Chen 型）
// をモンテカルロで検定する。
//
// 【ヌルの作り方】無条件の相関行列 R を Cholesky 分解し、同じ長さ T の多変量正規標本を
// S 本作る。標本ごとに**実測と同じ手続き（標準化 → 条件付け → 相関）**を通すので、
// 小標本バイアスも標本サイズ依存の癖もヌル側に自動的に入る。
//
// すべて純関数・依存は portfolio-risk の型のみ。Worker 不要（S は計算量から自動調整）。

import { AlignedReturns } from "./portfolio-risk";

/** 閾値（標準偏差単位）。0 は「ともに平均以下 / 以上」。 */
export const DEFAULT_THETAS = [0, 0.5, 1.0, 1.5];

/** 条件付き標本がこの日数を下回るペアはその水準で捨てる（相関が意味を持たないため）。 */
const MIN_OBS = 10;

export interface ExceedanceSide {
  /** 実測の平均ペア相関。有効ペアが無ければ NaN。 */
  corr: number;
  /** ヌル（2変量正規）の平均。 */
  nullMean: number;
  nullLo: number;
  nullHi: number;
  /** 片側 p 値 ＝ ヌルで実測以上になる割合（＝「正規でも普通に起きる」確率）。 */
  p: number;
  /** 実測で有効だったペア数。 */
  pairs: number;
  /** 有効ペアの平均条件付き日数。 */
  days: number;
}

export interface ExceedanceLevel {
  theta: number;
  down: ExceedanceSide;
  up: ExceedanceSide;
  /** 非対称性 A = ρ⁻ − ρ⁺（正なら下側のほうが相関が高い）。 */
  asym: number;
  asymNullMean: number;
  asymLo: number;
  asymHi: number;
  /** 両側 p 値（|A| がヌルでこれ以上になる割合）。 */
  asymP: number;
  /** この水準が使えたか（両サイドとも有効ペアがある）。 */
  ok: boolean;
}

export interface ExceedancePair {
  a: string;
  b: string;
  /** 無条件相関。 */
  rho: number;
  /** 参照水準（既定 θ=1.0）での下側／上側。 */
  down: number;
  up: number;
  asym: number;
  /** 非対称性の両側 p 値（このペア単独）。 */
  p: number;
}

export interface ExceedanceResult {
  ok: boolean;
  reason: string;
  tickers: string[];
  T: number;
  nPairs: number;
  /** 無条件の平均相関（ヌルの入力）。 */
  rhoAll: number;
  levels: ExceedanceLevel[];
  /** 参照水準（ペア表と見出しに使う θ）。 */
  refTheta: number;
  /** Ang-Chen 型の総合統計量（下側・上側をまとめた乖離の大きさ）。 */
  h: number;
  hP: number;
  /** 下側だけ／上側だけの乖離。符号付き平均（正＝ヌルより高い）。 */
  downExcess: number;
  downExcessP: number;
  upExcess: number;
  upExcessP: number;
  /** 全水準を通した平均非対称性と両側 p。 */
  asymMean: number;
  asymMeanP: number;
  /** 参照水準でのペア別内訳（非対称性の降順）。 */
  pairs: ExceedancePair[];
  /** 実際に走ったモンテカルロ本数。 */
  sims: number;
  minObs: number;
}

const EMPTY = (reason: string): ExceedanceResult => ({
  ok: false, reason, tickers: [], T: 0, nPairs: 0, rhoAll: 0, levels: [],
  refTheta: 1, h: 0, hP: 1, downExcess: 0, downExcessP: 1, upExcess: 0, upExcessP: 1,
  asymMean: 0, asymMeanP: 1, pairs: [], sims: 0, minObs: MIN_OBS,
});

// ───────────────────────── 数値ユーティリティ ─────────────────────────

/** seeded RNG（プロジェクト共通の mulberry32）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cholesky 分解 R = L Lᵀ。標本相関行列は T < n や強い共線性で半正定値になりうるので、
 * 失敗したら対角に微小なジッタを足して再試行する（相関構造をほぼ変えずに正定値にする）。
 */
function cholesky(R: number[][]): number[][] | null {
  const n = R.length;
  for (let attempt = 0; attempt < 5; attempt++) {
    const jitter = attempt === 0 ? 0 : Math.pow(10, -8 + attempt);
    const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = R[i][j] + (i === j ? jitter : 0);
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) {
          if (s <= 1e-12) {
            ok = false;
            break;
          }
          L[i][i] = Math.sqrt(s);
        } else {
          L[i][j] = s / L[j][j];
        }
      }
    }
    if (ok) return L;
  }
  return null;
}

function quantileOf(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * Math.min(Math.max(q, 0), 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** 標本を平均0・標準偏差1に標準化する（実測とヌルで同じ手続きを通すために必ず両方に適用）。 */
function standardize(rows: number[][]): number[][] {
  return rows.map((r) => {
    const T = r.length;
    if (T < 2) return r.slice();
    let m = 0;
    for (let t = 0; t < T; t++) m += r[t];
    m /= T;
    let v = 0;
    for (let t = 0; t < T; t++) v += (r[t] - m) * (r[t] - m);
    v /= T - 1;
    const sd = Math.sqrt(Math.max(v, 1e-24));
    return r.map((x) => (x - m) / sd);
  });
}

// ───────────────────────── 中核：条件付き相関 ─────────────────────────

/**
 * 全ペア × 全水準の exceedance correlation を1度に計算して out に詰める。
 * out.down / out.up は [pair * L + level] の平坦配列で、有効標本が足りなければ NaN。
 * 実測にもヌル標本にも**同じこの関数**を通す（＝条件付けバイアスを両側に同じだけ入れる）。
 */
function exceedanceRaw(
  z: number[][],
  thetas: number[],
  minObs: number,
  out: { down: Float64Array; up: Float64Array; downDays: Float64Array; upDays: Float64Array }
) {
  const n = z.length;
  const T = z[0]?.length ?? 0;
  const L = thetas.length;
  let pair = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = z[i];
      const b = z[j];
      for (let l = 0; l < L; l++) {
        const th = thetas[l];
        // 下側と上側を1パスで
        let dsx = 0, dsy = 0, dxx = 0, dyy = 0, dxy = 0, dm = 0;
        let usx = 0, usy = 0, uxx = 0, uyy = 0, uxy = 0, um = 0;
        for (let t = 0; t < T; t++) {
          const x = a[t];
          const y = b[t];
          if (x <= -th && y <= -th) {
            dsx += x; dsy += y; dxx += x * x; dyy += y * y; dxy += x * y; dm++;
          }
          if (x >= th && y >= th) {
            usx += x; usy += y; uxx += x * x; uyy += y * y; uxy += x * y; um++;
          }
        }
        const idx = pair * L + l;
        out.down[idx] = corrFromSums(dsx, dsy, dxx, dyy, dxy, dm, minObs);
        out.up[idx] = corrFromSums(usx, usy, uxx, uyy, uxy, um, minObs);
        out.downDays[idx] = dm;
        out.upDays[idx] = um;
      }
      pair++;
    }
  }
}

function corrFromSums(
  sx: number, sy: number, sxx: number, syy: number, sxy: number, m: number, minObs: number
): number {
  if (m < minObs) return NaN;
  const mx = sx / m;
  const my = sy / m;
  const cov = sxy / m - mx * my;
  const vx = sxx / m - mx * mx;
  const vy = syy / m - my * my;
  if (!(vx > 1e-18) || !(vy > 1e-18)) return NaN;
  const c = cov / Math.sqrt(vx * vy);
  return Math.min(1, Math.max(-1, c));
}

/** 平坦配列から、水準ごとの「有効ペア平均」を取り出す。 */
function levelMeans(flat: Float64Array, nPairs: number, L: number): { mean: number[]; count: number[] } {
  const mean = new Array(L).fill(NaN);
  const count = new Array(L).fill(0);
  for (let l = 0; l < L; l++) {
    let s = 0;
    let c = 0;
    for (let p = 0; p < nPairs; p++) {
      const v = flat[p * L + l];
      if (Number.isFinite(v)) {
        s += v;
        c++;
      }
    }
    mean[l] = c > 0 ? s / c : NaN;
    count[l] = c;
  }
  return { mean, count };
}

// ───────────────────────── 本体 ─────────────────────────

export interface ExceedanceOpts {
  thetas?: number[];
  /** モンテカルロ本数。未指定なら計算量から自動決定（120〜500）。 */
  sims?: number;
  seed?: number;
  minObs?: number;
  /** ペア表と見出しに使う参照水準（既定 1.0）。 */
  refTheta?: number;
}

export function exceedanceCorrelation(
  aligned: AlignedReturns,
  opts: ExceedanceOpts = {}
): ExceedanceResult {
  const thetas = opts.thetas ?? DEFAULT_THETAS;
  const minObs = opts.minObs ?? MIN_OBS;
  const seed = opts.seed ?? 20260727;
  const L = thetas.length;

  const { tickers, returns } = aligned;
  const n = tickers.length;
  const T = n > 0 ? returns[0].length : 0;
  if (n < 2) return EMPTY("銘柄数不足（2銘柄以上必要）");
  if (T < 120) return EMPTY(`期間不足（リターン${T}日 / 最低120日）`);

  const nPairs = (n * (n - 1)) / 2;
  const z = standardize(returns);

  // 無条件の相関行列（標準化済みなので内積/T-1 がそのまま相関）
  const R: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  let rhoSum = 0;
  for (let i = 0; i < n; i++) {
    R[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += z[i][t] * z[j][t];
      const c = Math.min(1, Math.max(-1, s / (T - 1)));
      R[i][j] = c;
      R[j][i] = c;
      rhoSum += c;
    }
  }
  const rhoAll = rhoSum / nPairs;

  const Lmat = cholesky(R);
  if (!Lmat) return EMPTY("相関行列が正定値でない（銘柄が重複している可能性）");

  // 実測
  const alloc = () => ({
    down: new Float64Array(nPairs * L),
    up: new Float64Array(nPairs * L),
    downDays: new Float64Array(nPairs * L),
    upDays: new Float64Array(nPairs * L),
  });
  const emp = alloc();
  exceedanceRaw(z, thetas, minObs, emp);
  const empDown = levelMeans(emp.down, nPairs, L);
  const empUp = levelMeans(emp.up, nPairs, L);
  const empDownDays = levelMeans(emp.downDays, nPairs, L);
  const empUpDays = levelMeans(emp.upDays, nPairs, L);

  // モンテカルロ本数：ペア数 × 水準数 × T が支配項。銘柄数が増えると1本あたりが重くなるので
  // 「総演算量が一定」になるよう自動調整する（4銘柄なら 400本 ≒ 0.2秒、20銘柄でも 120本 ≒ 1.5秒）。
  // 下限 120 は p 値の解像度（1/121 ≒ 0.008）を確保するため。
  const perSim = T * n * n + nPairs * L * T;
  const sims = Math.max(
    120,
    Math.min(400, Math.round(opts.sims ?? Math.max(120, 5e7 / Math.max(perSim, 1))))
  );

  const rand = mulberry32(seed);
  // Box-Muller（2つずつ作る）
  let spare: number | null = null;
  const gauss = () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  };

  const sim = alloc();
  const e: number[][] = Array.from({ length: n }, () => new Array(T).fill(0));
  const x: number[][] = Array.from({ length: n }, () => new Array(T).fill(0));

  // ヌル分布の蓄積
  const nullDown: number[][] = Array.from({ length: L }, () => []);
  const nullUp: number[][] = Array.from({ length: L }, () => []);
  const nullAsym: number[][] = Array.from({ length: L }, () => []);
  // ペア別（参照水準）の非対称性が実測以上になった回数
  let refIdx = 0;
  for (let l = 1; l < L; l++) {
    if (Math.abs(thetas[l] - (opts.refTheta ?? 1.0)) < Math.abs(thetas[refIdx] - (opts.refTheta ?? 1.0)))
      refIdx = l;
  }
  const pairAsymEmp = new Float64Array(nPairs);
  for (let p = 0; p < nPairs; p++) {
    pairAsymEmp[p] = emp.down[p * L + refIdx] - emp.up[p * L + refIdx];
  }
  const pairExceed = new Int32Array(nPairs);
  const pairValid = new Int32Array(nPairs);

  for (let s = 0; s < sims; s++) {
    for (let i = 0; i < n; i++) for (let t = 0; t < T; t++) e[i][t] = gauss();
    // x = L·e（同じ無条件相関を持つ2変量正規・テール依存性ゼロ・完全対称）
    for (let i = 0; i < n; i++) {
      const xi = x[i];
      for (let t = 0; t < T; t++) {
        let v = 0;
        for (let k = 0; k <= i; k++) v += Lmat[i][k] * e[k][t];
        xi[t] = v;
      }
    }
    const zs = standardize(x);
    exceedanceRaw(zs, thetas, minObs, sim);
    const sd = levelMeans(sim.down, nPairs, L);
    const su = levelMeans(sim.up, nPairs, L);
    for (let l = 0; l < L; l++) {
      if (Number.isFinite(sd.mean[l])) nullDown[l].push(sd.mean[l]);
      if (Number.isFinite(su.mean[l])) nullUp[l].push(su.mean[l]);
      if (Number.isFinite(sd.mean[l]) && Number.isFinite(su.mean[l]))
        nullAsym[l].push(sd.mean[l] - su.mean[l]);
    }
    for (let p = 0; p < nPairs; p++) {
      const a = sim.down[p * L + refIdx] - sim.up[p * L + refIdx];
      if (!Number.isFinite(a) || !Number.isFinite(pairAsymEmp[p])) continue;
      pairValid[p]++;
      if (Math.abs(a) >= Math.abs(pairAsymEmp[p])) pairExceed[p]++;
    }
  }

  // 水準ごとの集計
  const levels: ExceedanceLevel[] = [];
  const side = (
    empMean: number,
    dist: number[],
    pairs: number,
    days: number
  ): ExceedanceSide => {
    const sorted = [...dist].sort((a, b) => a - b);
    const m = dist.length ? dist.reduce((s, v) => s + v, 0) / dist.length : NaN;
    const p =
      dist.length && Number.isFinite(empMean)
        ? (dist.filter((v) => v >= empMean).length + 1) / (dist.length + 1)
        : NaN;
    return {
      corr: empMean,
      nullMean: m,
      nullLo: quantileOf(sorted, 0.05),
      nullHi: quantileOf(sorted, 0.95),
      p,
      pairs,
      days,
    };
  };

  for (let l = 0; l < L; l++) {
    const d = side(empDown.mean[l], nullDown[l], empDown.count[l], empDownDays.mean[l]);
    const u = side(empUp.mean[l], nullUp[l], empUp.count[l], empUpDays.mean[l]);
    const asym = d.corr - u.corr;
    const dist = nullAsym[l];
    const sorted = [...dist].sort((a, b) => a - b);
    const asymNullMean = dist.length ? dist.reduce((s, v) => s + v, 0) / dist.length : NaN;
    const asymP =
      dist.length && Number.isFinite(asym)
        ? (dist.filter((v) => Math.abs(v) >= Math.abs(asym)).length + 1) / (dist.length + 1)
        : NaN;
    levels.push({
      theta: thetas[l],
      down: d,
      up: u,
      asym,
      asymNullMean,
      asymLo: quantileOf(sorted, 0.05),
      asymHi: quantileOf(sorted, 0.95),
      asymP,
      ok: Number.isFinite(d.corr) && Number.isFinite(u.corr),
    });
  }

  // 総合統計量。ヌル側の H* も同じヌル平均を使って作り、その分布で p を出す
  // （モンテカルロ検定。ヌル平均を同じ標本から取っているぶん保守的に働く）。
  // 使える水準のインデックスだけを回す。
  const useIdx: number[] = [];
  for (let l = 0; l < L; l++) {
    if (levels[l].ok && Number.isFinite(levels[l].down.nullMean) && Number.isFinite(levels[l].up.nullMean))
      useIdx.push(l);
  }
  const hOf = (dv: number[], uv: number[]) => {
    let s = 0;
    let c = 0;
    for (const l of useIdx) {
      const dd = dv[l] - levels[l].down.nullMean;
      const du = uv[l] - levels[l].up.nullMean;
      if (!Number.isFinite(dd) || !Number.isFinite(du)) continue;
      s += dd * dd + du * du;
      c += 2;
    }
    return c > 0 ? Math.sqrt(s / c) : NaN;
  };
  const hEmp = hOf(empDown.mean, empUp.mean);

  // sims 本ぶんの H*・下側超過・上側超過・平均非対称性
  const hNull: number[] = [];
  const dExNull: number[] = [];
  const uExNull: number[] = [];
  const aMeanNull: number[] = [];
  const minLen = useIdx.length
    ? Math.min(...useIdx.map((l) => Math.min(nullDown[l].length, nullUp[l].length)))
    : 0;
  for (let s = 0; s < minLen; s++) {
    const dv = new Array(L).fill(NaN);
    const uv = new Array(L).fill(NaN);
    for (const l of useIdx) {
      dv[l] = nullDown[l][s];
      uv[l] = nullUp[l][s];
    }
    hNull.push(hOf(dv, uv));
    let ds = 0, us = 0, as = 0, c = 0;
    for (const l of useIdx) {
      ds += dv[l] - levels[l].down.nullMean;
      us += uv[l] - levels[l].up.nullMean;
      as += dv[l] - uv[l];
      c++;
    }
    dExNull.push(c ? ds / c : NaN);
    uExNull.push(c ? us / c : NaN);
    aMeanNull.push(c ? as / c : NaN);
  }
  const meanOver = (pick: (lv: ExceedanceLevel) => number) =>
    useIdx.length ? useIdx.reduce((s, l) => s + pick(levels[l]), 0) / useIdx.length : NaN;
  const downExcess = meanOver((lv) => lv.down.corr - lv.down.nullMean);
  const upExcess = meanOver((lv) => lv.up.corr - lv.up.nullMean);
  const asymMean = meanOver((lv) => lv.asym);
  const pOneSided = (dist: number[], v: number) =>
    dist.length && Number.isFinite(v)
      ? (dist.filter((d) => d >= v).length + 1) / (dist.length + 1)
      : NaN;
  const pTwoSided = (dist: number[], v: number) =>
    dist.length && Number.isFinite(v)
      ? (dist.filter((d) => Math.abs(d) >= Math.abs(v)).length + 1) / (dist.length + 1)
      : NaN;

  // ペア表（参照水準）
  const pairs: ExceedancePair[] = [];
  let p = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairs.push({
        a: tickers[i],
        b: tickers[j],
        rho: R[i][j],
        down: emp.down[p * L + refIdx],
        up: emp.up[p * L + refIdx],
        asym: pairAsymEmp[p],
        p: pairValid[p] > 0 ? (pairExceed[p] + 1) / (pairValid[p] + 1) : NaN,
      });
      p++;
    }
  }
  pairs.sort((a, b) => (Number.isFinite(b.asym) ? b.asym : -Infinity) - (Number.isFinite(a.asym) ? a.asym : -Infinity));

  return {
    ok: useIdx.length > 0,
    reason: useIdx.length > 0 ? "" : "条件付き標本がどの水準でも不足（期間が短いか銘柄が少ない）",
    tickers,
    T,
    nPairs,
    rhoAll,
    levels,
    refTheta: thetas[refIdx],
    h: hEmp,
    hP: pOneSided(hNull, hEmp),
    downExcess,
    downExcessP: pOneSided(dExNull, downExcess),
    upExcess,
    upExcessP: pOneSided(uExNull, upExcess),
    asymMean,
    asymMeanP: pTwoSided(aMeanNull, asymMean),
    pairs,
    sims,
    minObs,
  };
}
