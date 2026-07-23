// 系C24「参加の価値（株式リスクプレミアムという床）」の計算層。
//
// docs/investment-axioms.md / corollaries.ts C24 の実装。核心の主張:
//   タイミング/サイジングのエッジ Cov(q,dP) ≈ 0（本プロジェクトの前向き検証の帰結）を
//   命題1の分解に代入すると、損益は「参加項 Σ E[q_i]·E[dP_i]」だけに畳まれる。
//   よって残る唯一のレバーは「何に・どれだけ居るか」。最大で最も頑健な E[dP_i] が
//   株式リスクプレミアム＝床。ここでは市場代理（ETF/指数）でその床を実測する。
//
// ただし床は「長期・国際分散された市場」でのみ頑健で、単一国市場では一世代消えうる
// （日本株 1989末〜2019 の約30年、床が平ら〜負）。ゆえに「対象（国・市場）の選択」こそ
// 床そのものを左右する。この不安定性はエントリー時刻スイープ（overlapping窓）で可視化する。
//
// すべて純関数（fetch なし）。市場代理の取得はコンポーネント側で行う。

import { PricePoint } from "./types";

export const TRADING_DAYS = 252;

// --- 標準正規分布 CDF（床が正か＝片側検定の p 値に使う） -----------------------
function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26（|誤差|<1.5e-7）
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// --- 基本統計 --------------------------------------------------------------
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}
function sampleSd(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let v = 0;
  for (const x of xs) v += (x - m) ** 2;
  return Math.sqrt(v / (n - 1));
}
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.min(mdd, v / peak - 1);
  }
  return mdd;
}

/** 日次単純リターン（時刻つき）。0以下や欠損はスキップ。 */
export function dailyReturns(prices: PricePoint[]): { time: string; r: number }[] {
  const out: { time: string; r: number }[] = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1].close;
    const p1 = prices[i].close;
    if (p0 > 0 && p1 > 0) out.push({ time: prices[i].time, r: p1 / p0 - 1 });
  }
  return out;
}

// --- 型 --------------------------------------------------------------------
export interface PremiumStats {
  nDays: number;
  years: number;
  /** 年率ドリフト（日次算術平均 × 252）。 */
  annualDrift: number;
  /** 年率ボラ（日次sd × √252）。 */
  annualVol: number;
  /** 年率無リスク金利（入力）。 */
  rf: number;
  /** 床の高さ ＝ annualDrift − rf（株式リスクプレミアムの実測）。 */
  premium: number;
  /** 年率ドリフトの標準誤差 = σ_annual/√years = 252·s_daily/√N。 */
  seAnnual: number;
  /** t 値 = premium / seAnnual（＝ SE(μ̂)=σ/√T の帰結）。 */
  tValue: number;
  /** 床>0 の片側 p 値。 */
  pValueOneSided: number;
  /** 片側5%（t>1.645）で床が有意に正か。 */
  significant: boolean;
}

export interface EquityPoint {
  time: string;
  value: number;
}

export interface ParticipationMetrics {
  /** 時間平均成長率 g = mean(log(1+r))×252（C21: 実際に生きる成長率）。 */
  growthRate: number;
  sharpe: number;
  /** 最大ドローダウン（負値）＝床を受け取るために耐える経路の谷。 */
  maxDrawdown: number;
  totalReturn: number;
  annualReturn: number;
}

export interface HorizonSweep {
  holdDays: number;
  holdLabel: string;
  /** 各エントリー時刻から holdDays 保有したときの年率リターン（overlapping窓）。 */
  annualized: number[];
  n: number;
  mean: number;
  median: number;
  sd: number;
  min: number;
  max: number;
  /** 床が負になった窓の割合（＝単一窓では床が消えうる証拠）。 */
  shareNegative: number;
}

export interface ParticipationResult {
  premium: PremiumStats;
  participation: ParticipationMetrics;
  /** 参加（買い持ち・初期1）の資産曲線。 */
  equity: EquityPoint[];
  /** エントリー時刻スイープ（タイミングは分散のみ動かす／床の不安定性）。 */
  sweep: HorizonSweep;
  /** データエラーとして除外した異常日数（|日次r|>50%。Yahoo の誤 adjClose 等）。透明性のため公開。 */
  droppedOutliers: number;
}

/**
 * データエラーの上限。個別株の値幅制限・指数・ETF のいずれも1日で ±50% は超えない。
 * これを超える日次リターンは Yahoo の誤 adjClose（例: 1306.T/1475.T の ~10倍スパイク）とみなす。
 */
export const MAX_DAILY_RETURN = 0.5;

// --- 床の高さ（実現プレミアムと有意性） --------------------------------------
export function premiumStats(rets: number[], rf: number): PremiumStats {
  const n = rets.length;
  const mDaily = mean(rets);
  const sDaily = sampleSd(rets);
  const years = n / TRADING_DAYS;
  const annualDrift = mDaily * TRADING_DAYS;
  const annualVol = sDaily * Math.sqrt(TRADING_DAYS);
  const premium = annualDrift - rf;
  // SE(年率ドリフト) = 252·s_daily/√N。t は日次でも年率でもスケールが相殺され一致。
  const seAnnual = n > 1 ? (TRADING_DAYS * sDaily) / Math.sqrt(n) : Infinity;
  const tValue = seAnnual > 0 && isFinite(seAnnual) ? premium / seAnnual : 0;
  const pValueOneSided = 1 - normalCdf(tValue);
  return {
    nDays: n,
    years,
    annualDrift,
    annualVol,
    rf,
    premium,
    seAnnual,
    tValue,
    pValueOneSided,
    significant: tValue > 1.645,
  };
}

// --- 参加（買い持ち）の指標と資産曲線 ----------------------------------------
export function participationCurve(
  dr: { time: string; r: number }[]
): { equity: EquityPoint[]; metrics: ParticipationMetrics } {
  const equity: EquityPoint[] = [];
  const rets: number[] = [];
  let eq = 1;
  let g = 0;
  let gN = 0;
  for (const { time, r } of dr) {
    eq *= 1 + r;
    equity.push({ time, value: eq });
    rets.push(r);
    if (1 + r > 0) {
      g += Math.log(1 + r);
      gN++;
    }
  }
  const eqVals = equity.map((p) => p.value);
  const last = eqVals[eqVals.length - 1] ?? 1;
  const years = rets.length / TRADING_DAYS;
  const m = mean(rets);
  const sd = sampleSd(rets);
  const metrics: ParticipationMetrics = {
    growthRate: gN ? (g / gN) * TRADING_DAYS : 0,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(TRADING_DAYS) : 0,
    maxDrawdown: maxDrawdown(eqVals),
    totalReturn: last - 1,
    annualReturn: years > 0 && last > 0 ? Math.pow(last, 1 / years) - 1 : 0,
  };
  return { equity, metrics };
}

// --- エントリー時刻スイープ（タイミング無関係の実証／床の不安定性） --------------
export function horizonSweep(
  prices: PricePoint[],
  holdDays: number,
  holdLabel: string
): HorizonSweep {
  const annualized: number[] = [];
  for (let i = 0; i + holdDays < prices.length; i++) {
    const p0 = prices[i].close;
    const p1 = prices[i + holdDays].close;
    if (!(p0 > 0 && p1 > 0)) continue;
    const ratio = p1 / p0;
    annualized.push(Math.pow(ratio, TRADING_DAYS / holdDays) - 1);
  }
  const n = annualized.length;
  const neg = annualized.filter((x) => x < 0).length;
  return {
    holdDays,
    holdLabel,
    annualized,
    n,
    mean: mean(annualized),
    median: median(annualized),
    sd: sampleSd(annualized),
    min: n ? Math.min(...annualized) : 0,
    max: n ? Math.max(...annualized) : 0,
    shareNegative: n ? neg / n : 0,
  };
}

export interface ParticipationOptions {
  /** 年率無リスク金利（既定0＝日本の実勢に近い）。 */
  rf?: number;
  /** スイープの保有日数（既定252≒1年）。 */
  holdDays?: number;
  /** スイープの保有ラベル（既定 "1年"）。 */
  holdLabel?: string;
}

/**
 * 市場代理の価格列から「参加の価値（床）」を丸ごと計算する。
 * prices は adjClose（分配金調整済み）であるほど床の実測が正しくなる。
 */
export function computeParticipation(
  prices: PricePoint[],
  opts?: ParticipationOptions
): ParticipationResult | null {
  const rf = opts?.rf ?? 0;
  const holdDays = opts?.holdDays ?? TRADING_DAYS;
  const holdLabel = opts?.holdLabel ?? "1年";
  if (prices.length < holdDays + 30) return null;

  const drRaw = dailyReturns(prices);
  if (drRaw.length < 30) return null;

  // データエラー除外（透明）: |日次r|>50% は誤 adjClose とみなし落とす。落とした数は公開する。
  const dr = drRaw.filter((d) => Math.abs(d.r) <= MAX_DAILY_RETURN);
  const droppedOutliers = drRaw.length - dr.length;

  // スイープ用に、除外後リターンから価格系列を再構成（1本の異常ティックがスイープ窓も汚すため）。
  const p0 = prices.find((p) => p.close > 0)?.close ?? 1;
  const cleanedPrices: PricePoint[] = [];
  let v = p0;
  for (const d of dr) {
    v *= 1 + d.r;
    cleanedPrices.push({ time: d.time, open: v, high: v, low: v, close: v, volume: 0 });
  }

  const premium = premiumStats(dr.map((d) => d.r), rf);
  const { equity, metrics } = participationCurve(dr);
  const sweep = horizonSweep(cleanedPrices, holdDays, holdLabel);

  return { premium, participation: metrics, equity, sweep, droppedOutliers };
}
