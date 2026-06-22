// 逆算した裁量基準を「ルール」に変換し、任意期間に適用するバックテスト
//
// 層A (criteria-score): 学習不要の決定論的スコア。各日の特徴ベクトルが
// 買い基準の中心 (μ_buy, σ_buy) にどれだけ近いかをガウシアン近接度で測る。
//   buyScore(t) = mean_f exp(-0.5 * ((x_f(t) - μ_buy,f) / σ_buy,f)^2)
// sellScore も同様。スコアが閾値を超えたら全力買い/全力売りする。
//
// 重要: 基準を導いた期間と同じ期間で適用するとインサンプル (look-ahead) になり
// 無意味。UI 側で「適用期間」を学習期間と分けられるようにすること。

import { PricePoint } from "./types";
import { CriterionStat, FeatureRecord } from "./discretionary-criteria";
import {
  Trade,
  generateHumanCurve,
  generateBuyAndHoldCurve,
} from "./discretionary-engine";

export interface FeatureProfile {
  // featureId -> { mean, std }
  [id: string]: { mean: number; std: number };
}

// CriterionStat[] (count>=minCount のもの) からプロファイルを作る。
export function buildProfile(
  stats: CriterionStat[],
  minCount = 2
): FeatureProfile {
  const prof: FeatureProfile = {};
  for (const s of stats) {
    if (s.count < minCount) continue;
    prof[s.id] = { mean: s.mean, std: s.std };
  }
  return prof;
}

// 1日のスコア (0..1)。共通して存在する特徴のみで平均。
function proximityScore(
  rec: FeatureRecord | undefined,
  profile: FeatureProfile,
  features: string[]
): number | null {
  if (!rec) return null;
  let sum = 0;
  let n = 0;
  for (const f of features) {
    const p = profile[f];
    const x = rec[f];
    if (!p || x === undefined || !Number.isFinite(x)) continue;
    // σ=0 (基準がほぼ一点) のときは微小値でガード
    const sigma = Math.max(p.std, 1e-9);
    const z = (x - p.mean) / sigma;
    sum += Math.exp(-0.5 * z * z);
    n++;
  }
  if (n === 0) return null;
  return sum / n;
}

export interface BacktestParams {
  applyPrices: PricePoint[]; // 適用期間の価格 (連続した部分系列)
  table: Map<string, FeatureRecord>; // 全期間の特徴テーブル
  buyProfile: FeatureProfile;
  sellProfile: FeatureProfile;
  features: string[]; // スコアに使う特徴ID
  buyThreshold: number; // この値以上で買い候補 (0..1)
  sellThreshold: number; // この値以上で売り候補 (0..1)
  initialCash: number;
  costRate: number;
}

export interface BacktestResult {
  trades: Trade[];
  humanCurve: { time: string; value: number }[];
  buyHoldCurve: { time: string; value: number }[];
  buyScores: { time: string; value: number }[];
  sellScores: { time: string; value: number }[];
  finalHumanPercent: number;
  finalBuyHoldPercent: number;
  tradeCount: number;
}

// 適用期間にルールを流して売買シグナル→資産曲線を生成する。
export function runCriteriaBacktest(params: BacktestParams): BacktestResult {
  const {
    applyPrices,
    table,
    buyProfile,
    sellProfile,
    features,
    buyThreshold,
    sellThreshold,
    initialCash,
    costRate,
  } = params;

  const buyScores: { time: string; value: number }[] = [];
  const sellScores: { time: string; value: number }[] = [];
  const signals: Trade[] = [];
  let holding = false;

  for (const p of applyPrices) {
    const rec = table.get(p.time);
    const bs = proximityScore(rec, buyProfile, features);
    const ss = proximityScore(rec, sellProfile, features);
    if (bs !== null) buyScores.push({ time: p.time, value: bs });
    if (ss !== null) sellScores.push({ time: p.time, value: ss });

    const buySig = bs !== null && bs >= buyThreshold && (ss === null || bs > ss);
    const sellSig =
      ss !== null && ss >= sellThreshold && (bs === null || ss >= bs);

    if (!holding && buySig) {
      signals.push({
        date: p.time,
        action: "buy",
        price: p.close,
        shares: 0,
        cash: 0,
        totalValue: 0,
      });
      holding = true;
    } else if (holding && sellSig) {
      signals.push({
        date: p.time,
        action: "sell",
        price: p.close,
        shares: 0,
        cash: 0,
        totalValue: 0,
      });
      holding = false;
    }
  }

  const humanCurve = generateHumanCurve(applyPrices, signals, initialCash, costRate);
  const buyHoldCurve = generateBuyAndHoldCurve(applyPrices, initialCash, costRate);

  const finalHuman = humanCurve.length ? humanCurve[humanCurve.length - 1].value : initialCash;
  const finalBH = buyHoldCurve.length ? buyHoldCurve[buyHoldCurve.length - 1].value : initialCash;

  return {
    trades: signals,
    humanCurve,
    buyHoldCurve,
    buyScores,
    sellScores,
    finalHumanPercent: initialCash > 0 ? (finalHuman / initialCash - 1) * 100 : 0,
    finalBuyHoldPercent: initialCash > 0 ? (finalBH / initialCash - 1) * 100 : 0,
    tradeCount: signals.length,
  };
}
