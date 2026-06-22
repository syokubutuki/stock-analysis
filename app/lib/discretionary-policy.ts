// 層B: 裁量トレードの「方策(policy)」をモデルで学習する
//
// クリック日 (買い/売りの瞬間) だけをラベルにすると正例が数個しかなく過学習する。
// そこで「建玉状態」をラベルにする: 買い→売りの間は長期保有(y=1)、売り→次の買いの
// 間は手仕舞い(y=0)。これでスパースなクリックが全日ラベルの密な二値分類になり、
// 「この人ならこの局面でロングを持つか?」を GBDT で安定して学習できる。
//
// 評価はウォークフォワード (過去のみで学習→未来を予測、embargo付き) で行い、
// インサンプルの楽観を排除する。

import { PricePoint } from "./types";
import { Trade } from "./discretionary-engine";
import { FEATURE_DEFS, FeatureRecord } from "./discretionary-criteria";
import { GBDT, GBDTParams, DEFAULT_GBDT_PARAMS } from "./ml/gbdt";
import { rocAuc } from "./ml/metrics";

const FEATURE_IDS = FEATURE_DEFS.map((d) => d.id);

// 各日の建玉状態 (1=ロング保有, 0=手仕舞い) を trades から復元する。
export function holdingStateByDate(
  prices: PricePoint[],
  trades: Trade[]
): Map<string, number> {
  const sorted = [...trades].sort((a, b) => (a.date < b.date ? -1 : 1));
  const map = new Map<string, number>();
  let holding = 0;
  let ti = 0;
  for (const p of prices) {
    while (ti < sorted.length && sorted[ti].date === p.time) {
      holding = sorted[ti].action === "buy" ? 1 : 0;
      ti++;
    }
    map.set(p.time, holding);
  }
  return map;
}

export interface PolicySample {
  date: string;
  x: number[];
  y: number;
}

// 全特徴が揃う日だけを学習サンプルにする。
export function buildPolicySamples(
  prices: PricePoint[],
  trades: Trade[],
  table: Map<string, FeatureRecord>
): PolicySample[] {
  const state = holdingStateByDate(prices, trades);
  const samples: PolicySample[] = [];
  for (const p of prices) {
    const rec = table.get(p.time);
    if (!rec) continue;
    const x: number[] = [];
    let ok = true;
    for (const id of FEATURE_IDS) {
      const v = rec[id];
      if (v === undefined || !Number.isFinite(v)) {
        ok = false;
        break;
      }
      x.push(v);
    }
    if (!ok) continue;
    samples.push({ date: p.time, x, y: state.get(p.time) ?? 0 });
  }
  return samples;
}

export interface PolicyResult {
  dates: string[];
  // 全データで学習したスコア (インサンプル / オーバーレイ用・楽観的)
  inSampleScore: number[];
  // ウォークフォワードの out-of-sample スコア (評価用・null=学習期間で予測なし)
  oosScore: (number | null)[];
  oosAuc: number; // OOS スコアの ROC-AUC
  posRate: number; // ロング状態の割合
  importance: { id: string; label: string; value: number }[];
  nSamples: number;
  warning: string | null;
}

export interface PolicyConfig {
  trainMin: number; // ウォークフォワードの最小学習本数
  step: number; // 再学習間隔 (本)
  embargo: number; // 学習末尾と予測の間に空ける本数 (リーク防止)
  params?: Partial<GBDTParams>;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  trainMin: 120,
  step: 21,
  embargo: 5,
};

// scalePosWeight をクラス比から自動設定する。
function autoParams(y: number[], override?: Partial<GBDTParams>): GBDTParams {
  const pos = y.reduce((a, b) => a + b, 0);
  const neg = y.length - pos;
  const spw = pos > 0 ? Math.min(10, Math.max(0.1, neg / pos)) : 1;
  return {
    ...DEFAULT_GBDT_PARAMS,
    maxDepth: 3,
    nEstimators: 40,
    lambda: 2.0, // 少数データ向けに正則化を強める
    minChildWeight: 3.0,
    scalePosWeight: spw,
    ...override,
  };
}

export function runPolicyModel(
  prices: PricePoint[],
  trades: Trade[],
  table: Map<string, FeatureRecord>,
  config: PolicyConfig = DEFAULT_POLICY_CONFIG
): PolicyResult | null {
  const samples = buildPolicySamples(prices, trades, table);
  if (samples.length < 30) return null;

  const X = samples.map((s) => s.x);
  const Y = samples.map((s) => s.y);
  const dates = samples.map((s) => s.date);
  const pos = Y.reduce((a, b) => a + b, 0);
  const posRate = pos / Y.length;

  // ── インサンプル (全データ学習) ──
  const fullParams = autoParams(Y, config.params);
  const fullModel = new GBDT(fullParams);
  fullModel.fit(X, Y);
  const inSampleScore = X.map((x) => fullModel.predictProba(x));

  const importanceRaw = fullModel.featureImportance();
  const importance = FEATURE_DEFS.map((d, i) => ({
    id: d.id,
    label: d.label,
    value: importanceRaw[i] ?? 0,
  })).sort((a, b) => b.value - a.value);

  // ── ウォークフォワード (OOS) ──
  const oosScore: (number | null)[] = new Array(X.length).fill(null);
  const { trainMin, step, embargo } = config;
  for (let testStart = trainMin; testStart < X.length; testStart += step) {
    const trainEnd = testStart - embargo;
    if (trainEnd < 30) continue;
    const trainX = X.slice(0, trainEnd);
    const trainY = Y.slice(0, trainEnd);
    // 学習データに両クラスが無いと学習できない
    const tp = trainY.reduce((a, b) => a + b, 0);
    if (tp === 0 || tp === trainY.length) continue;
    const model = new GBDT(autoParams(trainY, config.params));
    model.fit(trainX, trainY);
    const testEnd = Math.min(X.length, testStart + step);
    for (let i = testStart; i < testEnd; i++) {
      oosScore[i] = model.predictProba(X[i]);
    }
  }

  // OOS AUC (予測がある区間のみ)
  const oosScores: number[] = [];
  const oosLabels: number[] = [];
  for (let i = 0; i < X.length; i++) {
    if (oosScore[i] !== null) {
      oosScores.push(oosScore[i] as number);
      oosLabels.push(Y[i]);
    }
  }
  const oosAuc =
    oosScores.length > 10 && oosLabels.some((v) => v === 1) && oosLabels.some((v) => v === 0)
      ? rocAuc(oosScores, oosLabels)
      : 0.5;

  // 警告
  let warning: string | null = null;
  const buyCount = trades.filter((t) => t.action === "buy").length;
  const sellCount = trades.filter((t) => t.action === "sell").length;
  if (buyCount < 3 || sellCount < 3) {
    warning =
      "売買回数が少なく (各3回未満)、学習結果は不安定です。ラベルは「建玉状態」で密化していますが、参考程度に。";
  } else if (posRate < 0.05 || posRate > 0.95) {
    warning =
      "ロング/手仕舞いの一方に極端に偏っており、モデルが多数派を当てているだけの可能性があります。";
  }

  return {
    dates,
    inSampleScore,
    oosScore,
    oosAuc,
    posRate,
    importance,
    nSamples: X.length,
    warning,
  };
}

// スコア系列を「長期保有/手仕舞い」シグナルに変換し売買トレードを生成する。
// score>=enter で買い、score<exit で売り (ヒステリシス)。null は前状態を維持。
export function scoresToTrades(
  prices: PricePoint[],
  dates: string[],
  scores: (number | null)[],
  enter = 0.5,
  exit = 0.5
): Trade[] {
  const scoreByDate = new Map<string, number | null>();
  dates.forEach((d, i) => scoreByDate.set(d, scores[i]));
  const trades: Trade[] = [];
  let holding = false;
  for (const p of prices) {
    const s = scoreByDate.get(p.time);
    if (s === undefined || s === null) continue;
    if (!holding && s >= enter) {
      trades.push({ date: p.time, action: "buy", price: p.close, shares: 0, cash: 0, totalValue: 0 });
      holding = true;
    } else if (holding && s < exit) {
      trades.push({ date: p.time, action: "sell", price: p.close, shares: 0, cash: 0, totalValue: 0 });
      holding = false;
    }
  }
  return trades;
}
