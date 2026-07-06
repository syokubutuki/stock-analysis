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
  shrinkage: number; // 共分散に加えた収縮係数 λ (0 なら無し)

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

// 空売り無し(w≥0, Σw=1)でシャープ比を最大化する接点ポートフォリオ。
// 射影勾配上昇(バックトラッキング)を複数初期値から回して最良を採る。
// この長期制約付き問題は擬凹だが、等配分・単一銘柄の各頂点・MC最良を初期値にすれば実用上大域最適へ収束する。
function maxSharpeLongOnly(
  mu: number[],
  S: number[][],
  rf: number,
  inits: number[][]
): PortfolioPoint | null {
  const evalW = (w: number[]) => {
    const sg = Math.sqrt(Math.max(quad(S, w), 0));
    const m = dot(w, mu);
    return { sh: sg > 0 ? (m - rf) / sg : -Infinity, sg, m };
  };
  let best: PortfolioPoint | null = null;
  for (const init of inits) {
    let w = projectSimplex(init.slice());
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
        const cand = projectSimplex(w.map((wi, i) => wi + lr * grad[i]));
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
  shrinkage?: number; // 共分散収縮 λ (既定 自動: 特異時のみ)
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

  // 年率の期待リターンベクトル μ
  const mu = returns.map((r) => mean(r) * TRADING_DAYS);

  // 年率共分散行列 Σ (日次共分散 ×252)
  const means = returns.map((r) => mean(r));
  const Sigma: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let a = 0; a < k; a++) {
    for (let b = a; b < k; b++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += (returns[a][t] - means[a]) * (returns[b][t] - means[b]);
      const c = (T > 1 ? s / (T - 1) : 0) * TRADING_DAYS;
      Sigma[a][b] = c;
      Sigma[b][a] = c;
    }
  }

  // 収縮(リッジ): 特異/不安定な Σ を安定化。指定が無ければ、逆行列が取れない時だけ
  // 対角平均の小さな割合を加える。
  let lambda = opts.shrinkage ?? 0;
  const applyShrink = (lam: number) => {
    const avgDiag = Sigma.reduce((s, row, i) => s + row[i], 0) / k;
    return Sigma.map((row, i) => row.map((v, j) => (i === j ? v + lam * avgDiag : v)));
  };
  let S = lambda > 0 ? applyShrink(lambda) : Sigma.map((r) => r.slice());
  let Inv = invertMatrix(S);
  if (!Inv) {
    // 段階的に収縮を強めて逆行列を確保
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
  const invMu = matVec(Inv, mu); // Σ⁻¹μ
  const A = dot(ones, invOnes); // 1ᵀΣ⁻¹1
  const B = dot(ones, invMu); // 1ᵀΣ⁻¹μ
  const C = dot(mu, invMu); // μᵀΣ⁻¹μ
  const D = A * C - B * B; // 判別式

  const sharpeOf = (m: number, sg: number) => (sg > 0 ? (m - riskFreeRate) / sg : 0);

  // --- GMV(大域最小分散) ---
  const wGmv = invOnes.map((v) => v / A);
  const muGmv = B / A;
  const sigGmv = Math.sqrt(Math.max(1 / A, 0));
  const gmv: PortfolioPoint = { weights: wGmv, mu: muGmv, sigma: sigGmv, sharpe: sharpeOf(muGmv, sigGmv) };

  // --- 個別銘柄 ---
  const assets = tickers.map((t, i) => {
    const sg = Math.sqrt(Math.max(S[i][i], 0));
    return { ticker: t, mu: mu[i], sigma: sg, sharpe: sharpeOf(mu[i], sg) };
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

  // --- 空売り無しの接点(最大シャープ)を厳密最適化 ---
  const loInits: number[][] = [new Array(k).fill(1 / k), bestSharpe.weights.slice()];
  for (let i = 0; i < k; i++) {
    const e = new Array(k).fill(0);
    e[i] = 1;
    loInits.push(e);
  }
  const tangencyLongOnly = maxSharpeLongOnly(mu, S, riskFreeRate, loInits);

  return {
    tickers,
    riskFree: riskFreeRate,
    nObs: T,
    shrinkage: lambda,
    curve,
    gmv,
    tangency,
    cml,
    assets,
    cloud,
    cloudBestSharpe: bestSharpe,
    cloudMinVol: minVol,
    tangencyLongOnly,
  };
}
