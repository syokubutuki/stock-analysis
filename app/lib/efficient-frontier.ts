// 効率的フロンティア (Markowitz mean-variance) + 資本市場線 (CAPM CML)
// ----------------------------------------------------------------------------
// 複数銘柄のリターンから、平均分散平面 (横:σ, 縦:μ) における
//   A. 閉形式フロンティア(空売り可): Σ⁻¹ から双曲線を解析的に描く。
//      GMV(大域最小分散)・接点(=市場)ポートフォリオ・CML(資本市場線)も算出。
//   B. モンテカルロ点群(ロングオンリー): ランダムウェイトを多数生成して散布。
//      ロングオンリー制約下の実現可能領域と、その中の最大シャープ/最小分散を示す。
// の両方を計算する。A は教科書的な滑らかな縁、B は現実的(空売り無し)な雲。
//
// 入力は portfolio-risk.ts の AlignedReturns(共通営業日で整列済みの対数リターン)。
// 日次の平均・共分散を 252 倍して年率化する。
// ============================================================================

import { AlignedReturns } from "./portfolio-risk";

const TRADING_DAYS = 252;

export interface FrontierPoint {
  sigma: number; // 年率ボラ
  mu: number; // 年率期待リターン
}

export interface PortfolioPoint extends FrontierPoint {
  weights: number[]; // tickers と同じ並び
  sharpe: number; // (mu - Rf)/sigma
}

export interface CloudPoint extends FrontierPoint {
  sharpe: number;
}

export interface EfficientFrontierResult {
  tickers: string[];
  riskFree: number; // 年率Rf
  nObs: number; // リターン標本数
  shrinkage: number; // 共分散に加えたリッジ収縮係数 λ (0 なら無し)
  lwShrinkage: number; // Ledoit-Wolf 収縮強度 δ (0〜1, 0なら未適用)
  muShrinkFactor: number; // μ の Bayes-Stein 収縮強度 φ (0〜1, GMVへの引き寄せ度)

  // A: 閉形式(空売り可)
  curve: { sigma: number; mu: number; efficient: boolean }[]; // efficient=GMVより上(効率的枝)
  gmv: PortfolioPoint; // 大域最小分散ポートフォリオ
  tangency: PortfolioPoint | null; // 接点(市場)ポートフォリオ。Rf>GMV収益等で未定義ならnull
  cml: FrontierPoint[]; // 資本市場線 (0,Rf)→接点 の2点(描画用に延長)

  // 個別銘柄(散布用)
  assets: { ticker: string; sigma: number; mu: number; sharpe: number }[];

  // B: モンテカルロ(ロングオンリー)
  cloud: CloudPoint[];
  cloudBestSharpe: PortfolioPoint; // 雲の中の最大シャープ(ロングオンリー接点近似)
  cloudMinVol: PortfolioPoint; // 雲の中の最小分散(ロングオンリーGMV近似)

  // 空売り無し(ロングオンリー)接点=市場ポートフォリオ。射影勾配法で厳密最適化。
  // 超過リターンが全て非正で正のシャープが得られない場合は null。
  tangencyLongOnly: PortfolioPoint | null;
  minVarLongOnly: PortfolioPoint | null; // 空売り無し(上限付き)最小分散
  maxWeight: number; // 適用した1銘柄上限 (1=制約なし)

  // 比較ベースライン(素朴な配分則)。等加重・リスクパリティ・逆ボラ。
  baselines: { key: string; label: string; point: PortfolioPoint }[];
}

// --- 数値ユーティリティ ---------------------------------------------------

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

// ガウス・ジョルダン法による逆行列(部分ピボット選択)。特異なら null。
function invertMatrix(src: number[][]): number[][] | null {
  const n = src.length;
  // [A | I] の拡大行列
  const a = src.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    }
    if (Math.abs(a[piv][col]) < 1e-14) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    const d = a[col][col];
    for (let c = 0; c < 2 * n; c++) a[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let c = 0; c < 2 * n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row) => row.slice(n));
}

function matVec(M: number[][], v: number[]): number[] {
  return M.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// wᵀ Σ w
function quad(Sigma: number[][], w: number[]): number {
  return dot(w, matVec(Sigma, w));
}

// Ledoit-Wolf 収縮(恒等スケール・ターゲット)。日次リターンから標本共分散 S(1/T)を作り、
// Σ_shrunk = δ·μ_avg·I + (1−δ)·S を返す。δ* は解析的な最適収縮強度。
// 参照: Ledoit & Wolf (2004) "A well-conditioned estimator...". 恒等ターゲットは ρ=0 なので δ=κ/T=(π/γ)/T。
function ledoitWolf(returns: number[][], means: number[]): { cov: number[][]; delta: number } {
  const k = returns.length;
  const T = returns[0]?.length ?? 0;
  const S: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let a = 0; a < k; a++) {
    for (let b = a; b < k; b++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += (returns[a][t] - means[a]) * (returns[b][t] - means[b]);
      const c = T > 0 ? s / T : 0;
      S[a][b] = c;
      S[b][a] = c;
    }
  }
  if (T < 2 || k < 2) return { cov: S, delta: 0 };
  let muAvg = 0;
  for (let i = 0; i < k; i++) muAvg += S[i][i];
  muAvg /= k;
  // γ = ||S − μ_avg·I||_F²
  let gamma = 0;
  for (let a = 0; a < k; a++)
    for (let b = 0; b < k; b++) {
      const d = S[a][b] - (a === b ? muAvg : 0);
      gamma += d * d;
    }
  // π = (1/T) Σ_t ||x_t x_tᵀ − S||_F²
  let pi = 0;
  for (let t = 0; t < T; t++) {
    for (let a = 0; a < k; a++) {
      const xa = returns[a][t] - means[a];
      for (let b = 0; b < k; b++) {
        const xb = returns[b][t] - means[b];
        const d = xa * xb - S[a][b];
        pi += d * d;
      }
    }
  }
  pi /= T;
  let delta = gamma > 0 ? pi / gamma / T : 0;
  delta = Math.max(0, Math.min(1, delta));
  const cov = S.map((row, i) => row.map((v, j) => (1 - delta) * v + (i === j ? delta * muAvg : 0)));
  return { cov, delta };
}

// 確率単体 {w≥0, Σw=1} へのユークリッド射影 (Wang & Carreira-Perpiñán 2013)。
function projectSimplex(v: number[]): number[] {
  const n = v.length;
  const u = [...v].sort((a, b) => b - a);
  let cssum = 0;
  let theta = 0;
  for (let j = 0; j < n; j++) {
    cssum += u[j];
    const t = (cssum - 1) / (j + 1);
    if (u[j] - t > 0) theta = t;
  }
  return v.map((x) => Math.max(x - theta, 0));
}

// 上限付き単体 {0≤w≤cap, Σw=1} への射影。双対変数 τ を二分探索:
// w_i(τ)=clip(v_i−τ, 0, cap) は τ に単調減少なので Σ=1 となる τ を挟み撃ち。
function projectCappedSimplex(v: number[], cap: number): number[] {
  const n = v.length;
  if (cap >= 1) return projectSimplex(v);
  if (cap * n <= 1 + 1e-12) return new Array(n).fill(1 / n); // 実質 equal しか実行可能
  const sumAt = (tau: number) =>
    v.reduce((s, vi) => s + Math.min(cap, Math.max(0, vi - tau)), 0);
  let lo = Math.min(...v) - cap; // sumAt(lo) ≥ 1
  let hi = Math.max(...v); // sumAt(hi) = 0
  for (let it = 0; it < 80; it++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid;
    else hi = mid;
  }
  const tau = (lo + hi) / 2;
  return v.map((vi) => Math.min(cap, Math.max(0, vi - tau)));
}

// 長期制約(上限付き)で分散 wᵀΣw を最小化する射影勾配降下。多スタートで最良を採る。
function minVarLongOnly(S: number[][], cap: number, inits: number[][]): PortfolioPoint | null {
  const proj = (v: number[]) => (cap < 1 ? projectCappedSimplex(v, cap) : projectSimplex(v));
  const varOf = (w: number[]) => quad(S, w);
  let best: number[] | null = null;
  let bestV = Infinity;
  for (const init of inits) {
    let w = proj(init.slice());
    let cur = varOf(w);
    let lr = 1;
    for (let iter = 0; iter < 400; iter++) {
      const grad = matVec(S, w); // ∇(wᵀΣw)=2Σw(定数倍は step で吸収)
      let improved = false;
      for (let bt = 0; bt < 30; bt++) {
        const cand = proj(w.map((wi, i) => wi - lr * grad[i]));
        const cv = varOf(cand);
        if (cv < cur - 1e-16) {
          w = cand;
          cur = cv;
          lr *= 1.3;
          improved = true;
          break;
        }
        lr *= 0.5;
      }
      if (!improved || lr < 1e-12) break;
    }
    if (cur < bestV) {
      bestV = cur;
      best = w.slice();
    }
  }
  return best ? { weights: best, mu: 0, sigma: Math.sqrt(Math.max(bestV, 0)), sharpe: 0 } : null;
}

// リスクパリティ(等リスク寄与 ERC)。乗法的減衰更新の不動点反復。
function riskParity(S: number[][]): number[] {
  const k = S.length;
  // 逆ボラ初期化
  let w = S.map((row, i) => 1 / Math.sqrt(Math.max(row[i], 1e-12)));
  let sum = w.reduce((s, v) => s + v, 0);
  w = w.map((v) => v / sum);
  for (let iter = 0; iter < 300; iter++) {
    const Sw = matVec(S, w);
    const total = dot(w, Sw); // = σ_p²
    if (total <= 0) break;
    const target = total / k;
    let maxErr = 0;
    const wNew = w.map((wi, i) => {
      const rc = wi * Sw[i]; // リスク寄与
      maxErr = Math.max(maxErr, Math.abs(rc / total - 1 / k));
      const factor = rc > 1e-18 ? Math.sqrt(target / rc) : 1;
      return wi * factor;
    });
    sum = wNew.reduce((s, v) => s + v, 0);
    w = wNew.map((v) => v / sum);
    if (maxErr < 1e-6) break;
  }
  return w;
}

// 空売り無し(w≥0, Σw=1)でシャープ比を最大化する接点ポートフォリオ。
// 射影勾配上昇(バックトラッキング)を複数初期値から回して最良を採る。
// この長期制約付き問題は擬凹だが、等配分・単一銘柄の各頂点・MC最良を初期値にすれば実用上大域最適へ収束する。
function maxSharpeLongOnly(
  mu: number[],
  S: number[][],
  rf: number,
  inits: number[][],
  cap = 1
): PortfolioPoint | null {
  const proj = (v: number[]) => (cap < 1 ? projectCappedSimplex(v, cap) : projectSimplex(v));
  const evalW = (w: number[]) => {
    const sg = Math.sqrt(Math.max(quad(S, w), 0));
    const m = dot(w, mu);
    return { sh: sg > 0 ? (m - rf) / sg : -Infinity, sg, m };
  };
  let best: PortfolioPoint | null = null;
  for (const init of inits) {
    let w = proj(init.slice());
    let cur = evalW(w);
    let lr = 1;
    for (let iter = 0; iter < 400; iter++) {
      const sg = cur.sg;
      if (sg <= 0) break;
      const exc = cur.m - rf;
      const Sw = matVec(S, w);
      // ∂S/∂wᵢ = μᵢ/σ − (μᵀw−Rf)(Σw)ᵢ/σ³
      const grad = mu.map((mi, i) => mi / sg - (exc * Sw[i]) / (sg * sg * sg));
      let improved = false;
      for (let bt = 0; bt < 30; bt++) {
        const cand = proj(w.map((wi, i) => wi + lr * grad[i]));
        const cs = evalW(cand);
        if (cs.sh > cur.sh + 1e-12) {
          w = cand;
          cur = cs;
          lr *= 1.3;
          improved = true;
          break;
        }
        lr *= 0.5;
      }
      if (!improved || lr < 1e-10) break;
    }
    if (cur.sh > 0 && cur.sg > 0 && (!best || cur.sh > best.sharpe)) {
      best = { weights: w.slice(), mu: cur.m, sigma: cur.sg, sharpe: cur.sh };
    }
  }
  return best;
}

// 乱数 (seeded, 再現性のため)
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// --- 本体 ----------------------------------------------------------------

export interface FrontierOptions {
  monteCarlo?: number; // 雲の点数 (既定 4000)
  curvePoints?: number; // 双曲線の分割数 (既定 80)
  shrinkage?: number; // リッジ収縮 λ (既定 自動: 特異時のみ)
  covShrinkage?: boolean; // Ledoit-Wolf 共分散収縮を使う (既定 true)
  muShrinkage?: boolean; // μ の Bayes-Stein 収縮を使う (既定 true)
  maxWeight?: number; // ロングオンリー最適化の1銘柄上限 (0〜1, 既定 1=制約なし)
  seed?: number;
}

export function efficientFrontier(
  aligned: AlignedReturns,
  riskFreeRate: number, // 年率 (例 0.005)
  opts: FrontierOptions = {}
): EfficientFrontierResult | null {
  const { tickers, returns } = aligned;
  const k = tickers.length;
  if (k < 2) return null;
  const T = returns[0]?.length ?? 0;
  if (T < 12) return null;

  const mcN = opts.monteCarlo ?? 4000;
  const curveN = opts.curvePoints ?? 80;
  const rng = mulberry32(opts.seed ?? 0x9e3779b9);

  const covShrink = opts.covShrinkage ?? true;
  const muShrink = opts.muShrinkage ?? true;
  const maxWeight = Math.max(0, Math.min(1, opts.maxWeight ?? 1));

  // 日次平均と年率の生・期待リターン(個別銘柄の散布は生μで表示)
  const means = returns.map((r) => mean(r));
  const muRaw = means.map((m) => m * TRADING_DAYS);

  // 年率共分散行列 Σ。既定は Ledoit-Wolf 収縮(恒等ターゲット)で常時安定化する。
  let lwDelta = 0;
  let SigmaDaily: number[][];
  if (covShrink) {
    const lw = ledoitWolf(returns, means);
    SigmaDaily = lw.cov;
    lwDelta = lw.delta;
  } else {
    SigmaDaily = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let a = 0; a < k; a++) {
      for (let b = a; b < k; b++) {
        let s = 0;
        for (let t = 0; t < T; t++) s += (returns[a][t] - means[a]) * (returns[b][t] - means[b]);
        const c = T > 1 ? s / (T - 1) : 0;
        SigmaDaily[a][b] = c;
        SigmaDaily[b][a] = c;
      }
    }
  }
  const Sigma = SigmaDaily.map((row) => row.map((v) => v * TRADING_DAYS));

  // リッジ収縮フォールバック: 収縮後もなお特異なら対角へ小さく加える。
  let lambda = opts.shrinkage ?? 0;
  const applyShrink = (lam: number) => {
    const avgDiag = Sigma.reduce((s, row, i) => s + row[i], 0) / k;
    return Sigma.map((row, i) => row.map((v, j) => (i === j ? v + lam * avgDiag : v)));
  };
  let S = lambda > 0 ? applyShrink(lambda) : Sigma.map((r) => r.slice());
  let Inv = invertMatrix(S);
  if (!Inv) {
    for (const lam of [0.01, 0.05, 0.1, 0.25, 0.5]) {
      lambda = lam;
      S = applyShrink(lam);
      Inv = invertMatrix(S);
      if (Inv) break;
    }
  }
  if (!Inv) return null;

  const ones = new Array(k).fill(1);
  const invOnes = matVec(Inv, ones); // Σ⁻¹1
  const A = dot(ones, invOnes); // 1ᵀΣ⁻¹1

  // --- μ の Bayes-Stein 収縮(Jorion 1986): GMVリターンへ引き寄せ、μ推定の不安定さを抑える ---
  //   φ = (k+2) / [ (k+2) + T·(μ−μ0·1)ᵀΣ⁻¹(μ−μ0·1) ],  μ0 = GMVリターン。
  //   年率 Σ⁻¹ を使うため二次形式は ×252 されるので日次換算に戻す。
  let mu = muRaw.slice();
  let muShrinkFactor = 0;
  {
    const invMuRaw = matVec(Inv, muRaw);
    const B0 = dot(ones, invMuRaw);
    const muGmv0 = A !== 0 ? B0 / A : 0;
    if (muShrink && k > 2) {
      const diff = muRaw.map((m) => m - muGmv0);
      const qAnnual = dot(diff, matVec(Inv, diff));
      const qDaily = qAnnual / TRADING_DAYS;
      const phi = qDaily > 0 ? (k + 2) / (k + 2 + T * qDaily) : 0;
      muShrinkFactor = Math.max(0, Math.min(1, phi));
      mu = muRaw.map((m) => (1 - muShrinkFactor) * m + muShrinkFactor * muGmv0);
    }
  }

  const invMu = matVec(Inv, mu); // Σ⁻¹μ
  const B = dot(ones, invMu); // 1ᵀΣ⁻¹μ
  const C = dot(mu, invMu); // μᵀΣ⁻¹μ
  const D = A * C - B * B; // 判別式

  const sharpeOf = (m: number, sg: number) => (sg > 0 ? (m - riskFreeRate) / sg : 0);

  // --- GMV(大域最小分散) ---
  const wGmv = invOnes.map((v) => v / A);
  const muGmv = B / A;
  const sigGmv = Math.sqrt(Math.max(1 / A, 0));
  const gmv: PortfolioPoint = { weights: wGmv, mu: muGmv, sigma: sigGmv, sharpe: sharpeOf(muGmv, sigGmv) };

  // --- 個別銘柄(散布は生μ=実現リターンで表示) ---
  const assets = tickers.map((t, i) => {
    const sg = Math.sqrt(Math.max(S[i][i], 0));
    return { ticker: t, mu: muRaw[i], sigma: sg, sharpe: sharpeOf(muRaw[i], sg) };
  });

  // --- 双曲線(空売り可) ---
  // μ_p を GMV周辺〜資産の最大μ超まで掃引し σ²(μ_p)=(A μ²−2B μ+C)/D。
  const muHi = Math.max(...mu, muGmv);
  const muLo = Math.min(...mu, muGmv);
  const span = Math.max(muHi - muLo, 1e-6);
  const from = muLo - span * 0.15;
  const to = muHi + span * 0.35;
  const curve: { sigma: number; mu: number; efficient: boolean }[] = [];
  for (let i = 0; i <= curveN; i++) {
    const m = from + ((to - from) * i) / curveN;
    const v = (A * m * m - 2 * B * m + C) / D;
    if (v <= 0 || !isFinite(v)) continue;
    curve.push({ mu: m, sigma: Math.sqrt(v), efficient: m >= muGmv });
  }

  // --- 接点(市場)ポートフォリオ + CML ---
  const excess = mu.map((m) => m - riskFreeRate);
  const z = matVec(Inv, excess); // Σ⁻¹(μ−Rf)
  const denom = dot(ones, z);
  let tangency: PortfolioPoint | null = null;
  let cml: FrontierPoint[] = [];
  if (Math.abs(denom) > 1e-12) {
    const wTan = z.map((v) => v / denom);
    const muTan = dot(wTan, mu);
    const sigTan = Math.sqrt(Math.max(quad(S, wTan), 0));
    // 接点が GMV より上(効率的枝の上側)にあるときだけ正規の市場ポートフォリオ
    if (muTan >= muGmv && sigTan > 0) {
      tangency = { weights: wTan, mu: muTan, sigma: sigTan, sharpe: sharpeOf(muTan, sigTan) };
      const slope = (muTan - riskFreeRate) / sigTan;
      const sigMax = Math.max(sigTan * 1.4, ...assets.map((a) => a.sigma));
      cml = [
        { sigma: 0, mu: riskFreeRate },
        { sigma: sigMax, mu: riskFreeRate + slope * sigMax },
      ];
    }
  }

  // --- B: モンテカルロ(ロングオンリー) ---
  const cloud: CloudPoint[] = [];
  let bestSharpe: PortfolioPoint = gmv;
  let minVol: PortfolioPoint = gmv;
  let bestSh = -Infinity;
  let minV = Infinity;
  for (let s = 0; s < mcN; s++) {
    // ディリクレ近似: 指数乱数を正規化(集中度を変えて偏った配分も生成)
    const conc = 0.3 + rng() * 1.2;
    const raw = new Array(k);
    let sum = 0;
    for (let i = 0; i < k; i++) {
      // Gamma(conc,1) 近似は重いので -log(u)^(1/conc) 風の簡便サンプリング
      const u = rng();
      const g = Math.pow(-Math.log(u + 1e-12), 1 / conc);
      raw[i] = g;
      sum += g;
    }
    if (sum <= 0) continue;
    const w = raw.map((v) => v / sum);
    const m = dot(w, mu);
    const sg = Math.sqrt(Math.max(quad(S, w), 0));
    const sh = sharpeOf(m, sg);
    cloud.push({ mu: m, sigma: sg, sharpe: sh });
    if (sh > bestSh) {
      bestSh = sh;
      bestSharpe = { weights: w, mu: m, sigma: sg, sharpe: sh };
    }
    if (sg < minV) {
      minV = sg;
      minVol = { weights: w, mu: m, sigma: sg, sharpe: sh };
    }
  }

  // --- 空売り無し(上限付き)の接点・最小分散を厳密最適化 ---
  const loInits: number[][] = [new Array(k).fill(1 / k), bestSharpe.weights.slice(), minVol.weights.slice()];
  for (let i = 0; i < k; i++) {
    const e = new Array(k).fill(0);
    e[i] = 1;
    loInits.push(e);
  }
  const tangencyLongOnly = maxSharpeLongOnly(mu, S, riskFreeRate, loInits, maxWeight);
  const minVarRaw = minVarLongOnly(S, maxWeight, loInits);
  const minVarLongOnlyPoint: PortfolioPoint | null = minVarRaw
    ? {
        weights: minVarRaw.weights,
        sigma: minVarRaw.sigma,
        mu: dot(minVarRaw.weights, mu),
        sharpe: sharpeOf(dot(minVarRaw.weights, mu), minVarRaw.sigma),
      }
    : null;

  // --- 比較ベースライン(素朴な配分則) ---
  const pointOf = (w: number[]): PortfolioPoint => {
    const m = dot(w, mu);
    const sg = Math.sqrt(Math.max(quad(S, w), 0));
    return { weights: w, mu: m, sigma: sg, sharpe: sharpeOf(m, sg) };
  };
  const wEqual = new Array(k).fill(1 / k);
  const wInvVol = (() => {
    const iv = tickers.map((_, i) => 1 / Math.sqrt(Math.max(S[i][i], 1e-12)));
    const s = iv.reduce((a, b) => a + b, 0);
    return iv.map((v) => v / s);
  })();
  const wRp = riskParity(S);
  const baselines = [
    { key: "equal", label: "等加重 (1/N)", point: pointOf(wEqual) },
    { key: "riskparity", label: "リスクパリティ", point: pointOf(wRp) },
    { key: "invvol", label: "逆ボラ加重", point: pointOf(wInvVol) },
  ];

  return {
    tickers,
    riskFree: riskFreeRate,
    nObs: T,
    shrinkage: lambda,
    lwShrinkage: lwDelta,
    muShrinkFactor,
    curve,
    gmv,
    tangency,
    cml,
    assets,
    cloud,
    cloudBestSharpe: bestSharpe,
    cloudMinVol: minVol,
    tangencyLongOnly,
    minVarLongOnly: minVarLongOnlyPoint,
    maxWeight,
    baselines,
  };
}

// ============================================================================
// アウトオブサンプル検証・リサンプリング用の軽量ウェイト推定
// フロンティア全体(雲・双曲線)は作らず、各配分則のウェイトだけを返す。
// ローリング再最適化で毎窓呼ばれるため、warm(前回解)で暖機して収束を速める。
// ============================================================================

export interface StrategyWeights {
  tangency: number[] | null; // 空売り無し最大シャープ
  minVar: number[] | null; // 空売り無し最小分散
  riskParity: number[];
  invVol: number[];
  equal: number[];
}

// 推定モデル(年率共分散 S・収縮後μ・生μ)。リサンプリング/OOSで共有。
export interface EstimatedModel {
  k: number;
  T: number;
  S: number[][]; // 年率共分散(収縮後)
  mu: number[]; // 年率期待リターン(Bayes-Stein収縮後)
  muRaw: number[]; // 年率期待リターン(生)
}

// 共分散(Ledoit-Wolf)・μ(Bayes-Stein)を推定してモデルを返す。特異なら null。
export function buildModel(
  returns: number[][],
  opts: { covShrinkage?: boolean; muShrinkage?: boolean } = {}
): EstimatedModel | null {
  const k = returns.length;
  const T = returns[0]?.length ?? 0;
  if (k < 2 || T < 12) return null;
  const covShrink = opts.covShrinkage ?? true;
  const muShrink = opts.muShrinkage ?? true;

  const means = returns.map((r) => mean(r));
  const muRaw = means.map((m) => m * TRADING_DAYS);

  let SigmaDaily: number[][];
  if (covShrink) {
    SigmaDaily = ledoitWolf(returns, means).cov;
  } else {
    SigmaDaily = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let a = 0; a < k; a++) {
      for (let b = a; b < k; b++) {
        let s = 0;
        for (let t = 0; t < T; t++) s += (returns[a][t] - means[a]) * (returns[b][t] - means[b]);
        const c = T > 1 ? s / (T - 1) : 0;
        SigmaDaily[a][b] = c;
        SigmaDaily[b][a] = c;
      }
    }
  }
  let S = SigmaDaily.map((row) => row.map((v) => v * TRADING_DAYS));
  let Inv = invertMatrix(S);
  if (!Inv) {
    for (const lam of [0.01, 0.05, 0.1, 0.25, 0.5]) {
      const avg = S.reduce((s, row, i) => s + row[i], 0) / k;
      const S2 = S.map((row, i) => row.map((v, j) => (i === j ? v + lam * avg : v)));
      Inv = invertMatrix(S2);
      if (Inv) {
        S = S2;
        break;
      }
    }
  }
  if (!Inv) return null;

  const ones = new Array(k).fill(1);
  const A = dot(ones, matVec(Inv, ones));

  let mu = muRaw.slice();
  if (muShrink && k > 2) {
    const invMuRaw = matVec(Inv, muRaw);
    const muGmv0 = A !== 0 ? dot(ones, invMuRaw) / A : 0;
    const diff = muRaw.map((m) => m - muGmv0);
    const qDaily = dot(diff, matVec(Inv, diff)) / TRADING_DAYS;
    const phi = qDaily > 0 ? Math.max(0, Math.min(1, (k + 2) / (k + 2 + T * qDaily))) : 0;
    mu = muRaw.map((m) => (1 - phi) * m + phi * muGmv0);
  }
  return { k, T, S, mu, muRaw };
}

// モデルから各配分則のウェイトを解く。
export function weightsFromModel(
  model: EstimatedModel,
  rf: number,
  maxWeight = 1,
  warm?: { tangency?: number[]; minVar?: number[] }
): StrategyWeights {
  const { k, S, mu } = model;
  const cap = Math.max(0, Math.min(1, maxWeight));
  const invVol = (() => {
    const iv = S.map((row, i) => 1 / Math.sqrt(Math.max(row[i], 1e-12)));
    const s = iv.reduce((a, b) => a + b, 0);
    return iv.map((v) => v / s);
  })();
  const equal = new Array(k).fill(1 / k);

  const shInits: number[][] = [];
  if (warm?.tangency && warm.tangency.length === k) shInits.push(warm.tangency.slice());
  shInits.push(equal.slice(), invVol.slice());
  const tangency = maxSharpeLongOnly(mu, S, rf, shInits, cap);

  const mvInits: number[][] = [];
  if (warm?.minVar && warm.minVar.length === k) mvInits.push(warm.minVar.slice());
  mvInits.push(equal.slice(), invVol.slice());
  const minVar = minVarLongOnly(S, cap, mvInits);

  return {
    tangency: tangency?.weights ?? null,
    minVar: minVar?.weights ?? null,
    riskParity: riskParity(S),
    invVol,
    equal,
  };
}

export function estimateWeights(
  returns: number[][],
  rf: number,
  opts: { covShrinkage?: boolean; muShrinkage?: boolean; maxWeight?: number } = {},
  warm?: { tangency?: number[]; minVar?: number[] }
): StrategyWeights | null {
  const model = buildModel(returns, opts);
  if (!model) return null;
  return weightsFromModel(model, rf, opts.maxWeight ?? 1, warm);
}

// ポートフォリオ点(σ/μ/Sharpe)を与えられたモデルで評価。
export function evaluatePortfolio(model: EstimatedModel, w: number[], rf: number): PortfolioPoint {
  const m = dot(w, model.mu);
  const sg = Math.sqrt(Math.max(quad(model.S, w), 0));
  return { weights: w, mu: m, sigma: sg, sharpe: sg > 0 ? (m - rf) / sg : 0 };
}
