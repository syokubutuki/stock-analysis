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

const TRADING_DAYS = 252;

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
  window: number
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
  const rfDaily = riskFreeRate / TRADING_DAYS;
  const meanRm = mean(rm);
  const varRm = variance(rm, meanRm);
  const muMarket = meanRm * TRADING_DAYS;
  const sigMarket = Math.sqrt(Math.max(varRm, 0) * TRADING_DAYS);
  const sdRm = Math.sqrt(Math.max(varRm, 0));

  const assets: CapmAsset[] = [];
  for (let i = 1; i < aligned.tickers.length; i++) {
    const ri = aligned.returns[i];
    const meanRi = mean(ri);
    const varRi = variance(ri, meanRi);
    const cov = covariance(ri, rm, meanRi, meanRm);
    const beta = varRm > 0 ? cov / varRm : 0;
    const mu = meanRi * TRADING_DAYS;
    const sigma = Math.sqrt(Math.max(varRi, 0) * TRADING_DAYS);
    const sdRi = Math.sqrt(Math.max(varRi, 0));
    const corr = sdRi > 0 && sdRm > 0 ? cov / (sdRi * sdRm) : 0;
    const alphaAnnual = (meanRi - (rfDaily + beta * (meanRm - rfDaily))) * TRADING_DAYS;
    const capmExpected = riskFreeRate + beta * (muMarket - riskFreeRate);
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
    muMarket,
    sigMarket,
    assets,
    betaMax,
    portfolioBeta,
    portfolioAlphaAnnual,
    portfolioMu,
  };
}
