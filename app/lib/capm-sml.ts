// CAPM の「もう半分」= 証券市場線(SML)・β・Jensenのα
// ----------------------------------------------------------------------------
// 効率的フロンティア/CML(efficient-frontier.ts)が平均分散平面(σ-μ)を扱うのに対し、
// こちらは市場指数(ベンチマーク)を「市場ポートフォリオの代理」として、各銘柄の
//   β(市場感応度) / Jensenのα(市場で説明できない超過リターン) / Treynorレシオ
// を推定し、β-μ 平面に証券市場線(SML)を描く。
//
// CAPM: E[Rᵢ] − Rf = βᵢ (E[Rm] − Rf)。実現リターンが SML より上=市場リスク対比で割安(α>0)。
//
// βᵢ = Cov(rᵢ, rm) / Var(rm)。αᵢ(日次) = r̄ᵢ − [Rf_d + βᵢ(r̄m − Rf_d)]、年率は ×252。
// 入力の整列は portfolio-risk.ts の alignReturns を再利用(ベンチマークを先頭に連結)。
// ============================================================================

import { PricePoint } from "./types";
import { alignReturns } from "./portfolio-risk";
import { type MuMode } from "./efficient-frontier";

const TRADING_DAYS = 252;

// ---- μ の定義（対数平均 / 算術平均）----------------------------------------
//
// alignReturns が返すのは**対数**リターンなので、その平均×252 は「実現した幾何平均」で
// あって教科書の期待リターン μ ではない。両者の差はぴったり σᵢ²/2 で、σ=35% なら 6pp、
// σ=60% なら 19pp。**銘柄間でばらつく**のがここでの問題で、対数平均のまま α を出すと
// 高ボラ銘柄の α が systematically 過小評価される（β で説明されない部分に σᵢ²/2 の差が混ざる）。
//
// 既定は "log"（従来どおり・数値不変）。"arithmetic" にすると μ と α だけが算術平均ベースに
// 変わる。β・σ・相関は**対数リターンの共分散のまま**にしてあり、これは効率的フロンティア
// (efficient-frontier.ts) の muMode が μ だけを差し替え Σ を触らないのと同じ約束
// ——2つのパネルで同じ物差しを使うための整合。詳細は docs/portfolio-analysis-open-issues.md §1。
export type { MuMode };

export interface CapmAsset {
  ticker: string;
  beta: number;
  alphaAnnual: number; // Jensenのα(年率)
  corr: number; // 対市場相関
  mu: number; // 実現年率リターン
  sigma: number; // 実現年率ボラ
  treynor: number; // (μ−Rf)/β
  capmExpected: number; // Rf + β(μm−Rf) : SML上の理論期待リターン
  mispricing: number; // mu − capmExpected(=αの符号。正=割安)
}

export interface CapmResult {
  benchTicker: string;
  benchName: string;
  riskFree: number;
  nObs: number;
  /** μ・α の定義（"log" ＝ 従来どおりの対数平均）。 */
  muMode: MuMode;
  muMarket: number; // 市場の年率リターン
  sigMarket: number; // 市場の年率ボラ
  assets: CapmAsset[];
  betaMax: number; // 描画用 β 上限
  // 等加重ポートフォリオのCAPM指標(参考)
  portfolioBeta: number;
  portfolioAlphaAnnual: number;
  portfolioMu: number;
}

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

function variance(a: number[], m?: number): number {
  if (a.length < 2) return 0;
  const mu = m ?? mean(a);
  let s = 0;
  for (const v of a) s += (v - mu) * (v - mu);
  return s / (a.length - 1);
}

function covariance(a: number[], b: number[], ma?: number, mb?: number): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const muA = ma ?? mean(a);
  const muB = mb ?? mean(b);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - muA) * (b[i] - muB);
  return s / (n - 1);
}

export function computeCapm(
  series: { ticker: string; prices: PricePoint[] }[],
  benchTicker: string,
  benchName: string,
  benchPrices: PricePoint[],
  riskFreeRate: number, // 年率
  window: number,
  muMode: MuMode = "log"
): CapmResult | null {
  if (benchPrices.length < 3) return null;
  const valid = series.filter((s) => s.prices.length > 2);
  if (valid.length < 1) return null;

  // ベンチマークを先頭に連結して共通営業日で整列(=非同期でも共通日のみで揃う)
  const combined = [{ ticker: benchTicker, prices: benchPrices }, ...valid];
  const aligned = alignReturns(combined, window);
  if (aligned.tickers.length < 2) return null;

  const T = aligned.returns[0].length;
  if (T < 12) return null;

  const rm = aligned.returns[0];
  const meanRm = mean(rm);
  const varRm = variance(rm, meanRm);
  // β・σ・相関は常に対数リターンから（muMode は μ の定義だけを差し替える）。
  // 年率平均だけ muMode に従う: 算術平均は単純リターン expm1(r) の標本平均から直接取る
  // （対数正規の仮定を置かずに済む。growth-drag.ts の arithmeticAnnualMeans と同じ手続き）。
  const annualMean = (r: number[]) =>
    muMode === "arithmetic"
      ? mean(r.map((v) => Math.expm1(v))) * TRADING_DAYS
      : mean(r) * TRADING_DAYS;
  const muMarket = annualMean(rm);
  const sigMarket = Math.sqrt(Math.max(varRm, 0) * TRADING_DAYS);
  const sdRm = Math.sqrt(Math.max(varRm, 0));

  const assets: CapmAsset[] = [];
  for (let i = 1; i < aligned.tickers.length; i++) {
    const ri = aligned.returns[i];
    const meanRi = mean(ri);
    const varRi = variance(ri, meanRi);
    const cov = covariance(ri, rm, meanRi, meanRm);
    const beta = varRm > 0 ? cov / varRm : 0;
    const mu = annualMean(ri);
    const sigma = Math.sqrt(Math.max(varRi, 0) * TRADING_DAYS);
    const sdRi = Math.sqrt(Math.max(varRi, 0));
    const corr = sdRi > 0 && sdRm > 0 ? cov / (sdRi * sdRm) : 0;
    const capmExpected = riskFreeRate + beta * (muMarket - riskFreeRate);
    // α ＝ 実現 μ − SML 上の理論値。日次で引いて×252 しても同じ式になるので、
    // mispricing と同一の値を1か所で作る（2通りの計算を残さない）。
    const alphaAnnual = mu - capmExpected;
    const treynor = Math.abs(beta) > 1e-9 ? (mu - riskFreeRate) / beta : NaN;
    assets.push({
      ticker: aligned.tickers[i],
      beta,
      alphaAnnual,
      corr,
      mu,
      sigma,
      treynor,
      capmExpected,
      mispricing: mu - capmExpected,
    });
  }
  if (assets.length === 0) return null;

  // 等加重ポートフォリオ(参考): β_p = 平均β, α_p = 平均α
  const w = 1 / assets.length;
  const portfolioBeta = assets.reduce((s, a) => s + w * a.beta, 0);
  const portfolioAlphaAnnual = assets.reduce((s, a) => s + w * a.alphaAnnual, 0);
  const portfolioMu = assets.reduce((s, a) => s + w * a.mu, 0);

  const betaMax = Math.max(1.2, ...assets.map((a) => a.beta)) * 1.1;

  return {
    benchTicker,
    benchName,
    riskFree: riskFreeRate,
    nObs: T,
    muMode,
    muMarket,
    sigMarket,
    assets,
    betaMax,
    portfolioBeta,
    portfolioAlphaAnnual,
    portfolioMu,
  };
}
