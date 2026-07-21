// エッジ容量推定: 「このエッジは何円まで運用すると消えるか」を閉形式で解く。
//
// 本物の市場エッジはほぼ例外なく容量制限付き(規模を大きくすると自分の売買が価格を動かして
// エッジを食い潰す)。メダリオン・ファンドが規模を意図的に制限したのはこのため。
// ここでは平方根マーケットインパクト則を使い、資金量Kの関数として純エッジを解析的に評価する。
//
// モデル(1取引・往復):
//   グロス1取引エッジ μ (方向調整後・割合)
//   往復スプレッド s = representativeSpread (Corwin-Schultz系推定)
//   インパクト(片道) = Y·σ_d·√(K / V_auction)   … 平方根則(Almgren, Gatheral)
//     Y: インパクト係数(実証では0.5〜1程度)  σ_d: 日次ボラ
//     V_auction = auctionShare × ADV_yen (寄り/引けオークションに出る円建て出来高)
//   純1取引エッジ: μ_net(K) = μ − s − 2Y·σ_d·√(K/V_auction) = a − b·√K
//     a = μ − s,  b = 2Y·σ_d/√V_auction
//   年間期待利益: Π(K) = f·K·(a − b√K)   f: 年間取引回数
//
// 閉形式解:
//   dΠ/dK = f·(a − (3/2)b√K) = 0  →  K* = (2a/3b)²   (利益最大の資金量)
//   Π(K*) = f·a·K*/3
//   μ_net(K)=0  →  K_be = (a/b)²                      (純エッジが消える資金量)
//   流動性制約:  K_liq = maxParticipation × V_auction (オークションを歪めない上限)

import { PricePoint } from "./types";
import { mean, std, median } from "./stats-significance";
import { representativeSpread } from "./spread-estimator";
import { Side } from "./weekday-trade";
import { EdgeSeries, directedReturns } from "./edge-trades";

export interface CapacityParams {
  impactY: number; // 平方根則係数Y
  auctionShare: number; // ADVに占めるオークション出来高比率(0..1)
  maxParticipation: number; // オークション出来高に対する最大参加率(0..1)
  advWindow: number; // 円建てADVの測定窓(営業日)
  volWindow: number; // 日次ボラの測定窓(営業日)
  nTrials: number; // このμがいくつの候補から選ばれたか(=選択バイアス補正の母数)。1なら方向選択のみ
}

export const DEFAULT_CAPACITY_PARAMS: CapacityParams = {
  impactY: 1.0,
  auctionShare: 0.1,
  maxParticipation: 0.1,
  advWindow: 60,
  volWindow: 250,
  nTrials: 1,
};

// ---------------------------------------------------------------
// 選択バイアス補正(μの収縮)
// ---------------------------------------------------------------
// 容量は a = μ − spread に強く依存し(K_be=(a/b)²)、μ が過大だと容量が体系的に過大に出る。
// μ の過大評価は2段の選択から生じる:
//   (1) 方向の後知恵選択: direction=sign(平均) としてから |平均| を μ にするので、
//       真のエッジがゼロでも μ=|標本平均| は正に振れる。
//   (2) カタログからの勝者選択: M本のエッジから最良を見ると、全て真にゼロでも
//       最大 z は E[max] だけ上振れる。
// そこで DSR(Deflated Sharpe)と同じ発想で、μ から「帰無下で選択だけで生じる上振れ」
// E[max z]·SE を控除する。実効試行数 = 2·nTrials(方向2×カタログ本数)。
function invNormalCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  let q: number, r: number;
  if (p < plow) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= phigh) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// nTrials 個の標準正規の期待最大値(De Prado 2014 の近似)。
function expectedMaxZ(nTrials: number): number {
  const M = Math.max(1, Math.round(nTrials));
  if (M <= 1) return 0;
  const EULER = 0.5772156649015329;
  return (1 - EULER) * invNormalCdf(1 - 1 / M) + EULER * invNormalCdf(1 - 1 / (M * Math.E));
}

export interface CapacityCurvePoint {
  k: number; // 資金量(円)
  netAnnualPct: number; // 年率純リターン(%) = f·(a − b√K)·100
  profitYen: number; // 年間期待利益(円) = f·K·(a − b√K)
}

export interface CapacityResult {
  edge: EdgeSeries;
  direction: Side; // 全期間平均の符号から決めた推奨方向
  muGross: number; // 方向調整後1取引平均(割合)
  tStat: number; // μの素朴なt値(参考)
  spreadRT: number; // 往復スプレッド(割合)
  a: number; // スプレッド控除後エッジ
  b: number; // インパクト係数(√円あたり)
  advYen: number; // 円建てADV
  auctionYen: number; // オークション出来高(円)
  sigmaD: number; // 日次ボラ
  kStar: number; // 利益最大の資金量(円)
  kBreakEven: number; // 純エッジが消える資金量(円)
  kLiq: number; // 参加率制約の上限(円)
  kEff: number; // min(kStar, kLiq)
  profitAtKEff: number; // K_effでの年間期待利益(円)
  netAnnualAtKEffPct: number; // K_effでの年率純リターン(%)
  curve: CapacityCurvePoint[];
  // --- 選択バイアス補正版(μを収縮させた誠実な容量) ---
  nTrials: number; // 補正母数(=方向2×カタログ本数)
  haircutZ: number; // 控除した選択上振れ(σ単位) E[max z]
  muDeflated: number; // 収縮後μ = max(0, μ − E[max z]·SE)
  aDeflated: number; // muDeflated − spread
  kStarDeflated: number;
  kBreakEvenDeflated: number;
  kEffDeflated: number;
  profitAtKEffDeflated: number;
  netAnnualAtKEffDeflatedPct: number;
  curveDeflated: CapacityCurvePoint[];
}

// 直近windowの円建てADV(中央値: 出来高スパイクに頑健)。
function advYenOf(prices: PricePoint[], window: number): number {
  const tail = prices.slice(-window);
  const vals = tail.map((p) => p.close * p.volume).filter((v) => v > 0);
  if (vals.length < Math.min(20, window / 2)) return 0;
  return median(vals);
}

function dailyVol(prices: PricePoint[], window: number): number {
  const tail = prices.slice(-Math.min(window + 1, prices.length));
  const rets: number[] = [];
  for (let i = 1; i < tail.length; i++) {
    if (tail[i - 1].close > 0 && tail[i].close > 0) rets.push(Math.log(tail[i].close / tail[i - 1].close));
  }
  if (rets.length < 20) return 0;
  return std(rets);
}

export function computeCapacity(
  prices: PricePoint[],
  edge: EdgeSeries,
  params: CapacityParams = DEFAULT_CAPACITY_PARAMS,
): CapacityResult | null {
  const advYen = advYenOf(prices, params.advWindow);
  const sigmaD = dailyVol(prices, params.volWindow);
  if (advYen <= 0 || sigmaD <= 0 || edge.trades.length < 30) return null;

  const rawMean = mean(edge.trades.map((t) => t.ret));
  const direction: Side = rawMean >= 0 ? "long" : "short";
  const rets = directedReturns(edge, direction);
  const mu = mean(rets);
  const sd = std(rets);
  const tStat = sd > 0 ? (mu / (sd / Math.sqrt(rets.length))) : 0;

  const spreadRT = representativeSpread(prices);
  const auctionYen = params.auctionShare * advYen;
  const a = mu - spreadRT;
  const b = (2 * params.impactY * sigmaD) / Math.sqrt(auctionYen);
  const f = edge.tradesPerYear;

  const kLiq = params.maxParticipation * auctionYen;

  // 選択バイアス補正: 実効試行数 = 2(方向) × nTrials(カタログ本数)。
  const se = sd / Math.sqrt(rets.length);
  const haircutZ = expectedMaxZ(2 * Math.max(1, params.nTrials));
  const muDeflated = Math.max(0, mu - haircutZ * se);
  const aDeflated = muDeflated - spreadRT;

  const kSet = (aa: number) => {
    if (aa > 0 && b > 0) return { kStar: Math.pow((2 * aa) / (3 * b), 2), kBe: Math.pow(aa / b, 2) };
    return { kStar: 0, kBe: 0 };
  };
  const { kStar, kBe: kBreakEven } = kSet(a);
  const { kStar: kStarDeflated, kBe: kBreakEvenDeflated } = kSet(aDeflated);

  const kEff = Math.min(kStar, kLiq);
  const kEffDeflated = Math.min(kStarDeflated, kLiq);
  const netAt = (k: number, aa: number) => (k > 0 ? aa - b * Math.sqrt(k) : aa);
  const profitAtKEff = f * kEff * netAt(kEff, a);
  const netAnnualAtKEffPct = f * netAt(kEff, a) * 100;
  const profitAtKEffDeflated = f * kEffDeflated * netAt(kEffDeflated, aDeflated);
  const netAnnualAtKEffDeflatedPct = f * netAt(kEffDeflated, aDeflated) * 100;

  // 対数グリッドの容量曲線。上限はK_be・K_liqの大きい方を少し超えるまで。
  const kMax = Math.max(kBreakEven * 1.5, kLiq * 2, 1e7);
  const kMin = 1e5; // 10万円から
  const steps = 120;
  const mkCurve = (aa: number): CapacityCurvePoint[] => {
    const out: CapacityCurvePoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const k = kMin * Math.pow(kMax / kMin, i / steps);
      const net = netAt(k, aa);
      out.push({ k, netAnnualPct: f * net * 100, profitYen: f * k * net });
    }
    return out;
  };
  const curve = mkCurve(a);
  const curveDeflated = mkCurve(aDeflated);

  return {
    edge, direction, muGross: mu, tStat, spreadRT, a, b,
    advYen, auctionYen, sigmaD,
    kStar, kBreakEven, kLiq, kEff, profitAtKEff, netAnnualAtKEffPct, curve,
    nTrials: params.nTrials, haircutZ, muDeflated, aDeflated,
    kStarDeflated, kBreakEvenDeflated, kEffDeflated,
    profitAtKEffDeflated, netAnnualAtKEffDeflatedPct, curveDeflated,
  };
}

export function capacityTable(
  prices: PricePoint[],
  catalog: EdgeSeries[],
  params: CapacityParams = DEFAULT_CAPACITY_PARAMS,
): CapacityResult[] {
  // 収縮の母数はカタログ本数。呼び出し側で nTrials を渡していなければカタログ長を採用。
  const nTrials = params.nTrials > 1 ? params.nTrials : Math.max(1, catalog.length);
  const p = { ...params, nTrials };
  const out: CapacityResult[] = [];
  for (const e of catalog) {
    const r = computeCapacity(prices, e, p);
    if (r) out.push(r);
  }
  // 実現可能な年間利益の降順(補正後で並べる=誠実な優先順位)
  out.sort((x, y) => y.profitAtKEffDeflated - x.profitAtKEffDeflated);
  return out;
}

// 金額の短縮表記(表示用): 1.2億円 / 3400万円 / 12万円
export function fmtYen(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(abs >= 1e9 ? 0 : 1)}億円`;
  if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString()}万円`;
  return `${sign}${Math.round(abs).toLocaleString()}円`;
}
