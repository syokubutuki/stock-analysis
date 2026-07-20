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
}

export const DEFAULT_CAPACITY_PARAMS: CapacityParams = {
  impactY: 1.0,
  auctionShare: 0.1,
  maxParticipation: 0.1,
  advWindow: 60,
  volWindow: 250,
};

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

  let kStar = 0;
  let kBreakEven = 0;
  if (a > 0 && b > 0) {
    kStar = Math.pow((2 * a) / (3 * b), 2);
    kBreakEven = Math.pow(a / b, 2);
  }
  const kEff = Math.min(kStar, kLiq);
  const netAt = (k: number) => (k > 0 ? a - b * Math.sqrt(k) : a);
  const profitAtKEff = f * kEff * netAt(kEff);
  const netAnnualAtKEffPct = f * netAt(kEff) * 100;

  // 対数グリッドの容量曲線。上限はK_be・K_liqの大きい方を少し超えるまで。
  const kMax = Math.max(kBreakEven * 1.5, kLiq * 2, 1e7);
  const kMin = 1e5; // 10万円から
  const curve: CapacityCurvePoint[] = [];
  const steps = 120;
  for (let i = 0; i <= steps; i++) {
    const k = kMin * Math.pow(kMax / kMin, i / steps);
    const net = netAt(k);
    curve.push({ k, netAnnualPct: f * net * 100, profitYen: f * k * net });
  }

  return {
    edge, direction, muGross: mu, tStat, spreadRT, a, b,
    advYen, auctionYen, sigmaD,
    kStar, kBreakEven, kLiq, kEff, profitAtKEff, netAnnualAtKEffPct, curve,
  };
}

export function capacityTable(
  prices: PricePoint[],
  catalog: EdgeSeries[],
  params: CapacityParams = DEFAULT_CAPACITY_PARAMS,
): CapacityResult[] {
  const out: CapacityResult[] = [];
  for (const e of catalog) {
    const r = computeCapacity(prices, e, params);
    if (r) out.push(r);
  }
  // 実現可能な年間利益の降順
  out.sort((x, y) => y.profitAtKEff - x.profitAtKEff);
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
