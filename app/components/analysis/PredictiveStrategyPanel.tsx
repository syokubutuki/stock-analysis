"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { GBDT, type GBDTParams, DEFAULT_GBDT_PARAMS } from "../../lib/ml/gbdt";
import {
  FEATURE_LIBRARY,
  maxLookback,
  computeFeatureVector,
  enabledFeatureList,
  standardizeMatrixCausal,
} from "../../lib/ml/features";
import { rocAuc, balancedAccuracy, logLoss } from "../../lib/ml/metrics";
import {
  fitPlatt,
  applyPlatt,
  fitIsotonic,
  applyIsotonic,
  type PlattModel,
  type IsotonicModel,
} from "../../lib/ml/calibration";
import AnalysisGuide from "./AnalysisGuide";
import { listScenarios, getActiveId, reconcileTrades } from "../../lib/discretionary-store";
import { holdingStateByDate } from "../../lib/discretionary-policy";

// ── 型定義 ─────────────────────────────────────────

type PredictionTarget = "strategy" | "strategy_high" | "close_up" | "discretionary";

const TARGET_OPTIONS: { value: PredictionTarget; label: string; desc: string }[] = [
  { value: "strategy", label: "戦略リターン方向", desc: "選択中の戦略リターンが正か負か" },
  { value: "strategy_high", label: "大幅上昇", desc: "戦略リターンが閾値を超えるか" },
  { value: "close_up", label: "終値上昇", desc: "翌日終値が当日終値より高いか" },
  { value: "discretionary", label: "あなたの裁量を再現", desc: "裁量トレードタブで保存した建玉状態 (ロング/手仕舞い) を当てる" },
];

type PositionMode = "longOnly" | "longShort";
type CalibrationMode = "none" | "platt" | "isotonic";

const CALIBRATION_OPTIONS: { value: CalibrationMode; label: string }[] = [
  { value: "none", label: "なし" },
  { value: "platt", label: "Platt (シグモイド)" },
  { value: "isotonic", label: "Isotonic (単調)" },
];

export interface PredictionReturn {
  time: string;
  cumReturn: number;
}

/** 各テスト日のモデル予測 (色分け表示用) */
export interface DailyPrediction {
  time: string;
  proba: number; // 上昇確率 (較正後)
  predicted: 0 | 1; // proba ≧ longThr で 1 (上昇予測)
  actual: 0 | 1; // 実際に上昇したか
  position: -1 | 0 | 1; // 建玉 (ロング/現金/ショート)
  ret: number; // その日の実現リターン (戦略リターン)
  windowIdx: number; // 何番目のWalk-Forward窓のテストか
}

export interface PredictionResult {
  returns: PredictionReturn[];
  daily: DailyPrediction[];
  metrics: {
    accuracy: number;
    precision: number;
    recall: number;
    f1: number;
    auc: number;
    balancedAcc: number;
    logLoss: number;
    baseRate: number;
    totalReturn: number;
    bhReturn: number;
    longCount: number;
    shortCount: number;
    cashCount: number;
    totalDays: number;
  };
  importance: { label: string; value: number }[];
}

// ── 未来予測 (アウトオブサンプル / 再帰多段) ───────
/** 予測した未来1日分 */
export interface ForecastDay {
  time: string;
  proba: number; // モデルの上昇確率
  expRet: number; // その日の期待対数リターン
  close: number; // 予測終値
  upper: number; // +σ√h コーン上限
  lower: number; // −σ√h コーン下限
}

export interface FutureForecast {
  horizon: number;
  trainEnd: string; // 学習に使った最終日
  lastClose: number; // 起点の実終値
  muUp: number; // 学習窓の上昇日平均リターン
  muDown: number; // 学習窓の下落日平均リターン
  sigma: number; // 終値間リターンの日次標準偏差
  history: { time: string; close: number }[]; // 描画用の直近実終値
  days: ForecastDay[];
  cumExpRet: number; // 期間合計の期待対数リターン
}

interface Props {
  prices: PricePoint[];
  dailyReturns: (number | null)[];
  effectiveStart: string;
  effectiveEnd: string;
  onResult: (result: PredictionResult | null) => void;
  ticker?: string; // target=discretionary 用: 裁量シナリオの読込元
}

// ── 学習進捗 ──────────────────────────────────────

interface TrainingProgress {
  phase: "features" | "training" | "scoring";
  currentWindow: number;
  totalWindows: number;
  trainPeriod: [string, string];
  testPeriod: [string, string];
  treesBuilt: number;
  totalTrees: number;
  runningAccuracy: number;
  runningReturn: number;
  longCount: number;
  shortCount: number;
}

// ── Walk-Forward (非同期・進捗コールバック付き) ────

interface WFConfig {
  enabled: Set<string>;
  paramMap: Record<string, Record<string, number>>;
  modelParams: GBDTParams;
  trainWindow: number;
  testWindow: number;
  embargo: number; // 学習終端とテスト開始の間に空ける日数 (リーク防止)
  standardize: boolean; // 特徴量を因果的ローリングz-scoreで標準化
  standardizeWindow: number;
  calibration: CalibrationMode; // 確率較正の方式
  autoThreshold: boolean; // 検証分割でロング閾値を自動最適化
  validationFraction: number; // 学習窓のうち検証に回す割合
  target: PredictionTarget;
  targetReturnThreshold: number;
  holdingState?: Map<string, number>; // target=discretionary 用: 日付→建玉状態
  positionMode: PositionMode;
  longThreshold: number;
  shortThreshold: number;
  startDate: string;
  endDate: string;
}

function yieldToUI(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// 確率 → log-odds (Platt較正の入力に使う)。端点をクリップして発散を防ぐ
function logit(p: number): number {
  const c = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(c / (1 - c));
}

// 検証データ上でバランス正答率を最大化するロング閾値を探索する
function tuneThreshold(probas: number[], labels: number[]): number {
  let best = 0.5;
  let bestScore = -1;
  for (let thr = 0.3; thr <= 0.7 + 1e-9; thr += 0.01) {
    const preds = probas.map((p) => (p >= thr ? 1 : 0));
    const score = balancedAccuracy(preds, labels);
    if (score > bestScore) {
      bestScore = score;
      best = thr;
    }
  }
  return Math.round(best * 100) / 100;
}

async function runWalkForwardAsync(
  prices: PricePoint[],
  dailyReturns: (number | null)[],
  cfg: WFConfig,
  onProgress: (p: TrainingProgress) => void,
  abortRef: { current: boolean },
): Promise<PredictionResult | null> {
  const lb = maxLookback(cfg.enabled, cfg.paramMap);
  const featureList = enabledFeatureList(cfg.enabled);
  if (featureList.length === 0) return null;

  // Phase: features
  onProgress({
    phase: "features", currentWindow: 0, totalWindows: 0,
    trainPeriod: ["", ""], testPeriod: ["", ""],
    treesBuilt: 0, totalTrees: 0,
    runningAccuracy: 0, runningReturn: 0, longCount: 0, shortCount: 0,
  });
  await yieldToUI();

  let allX: number[][] = [];
  const allY: number[] = [];
  const allTimes: string[] = [];
  const allReturns: number[] = [];

  for (let i = lb; i < prices.length - 1; i++) {
    const nextRet = dailyReturns[i + 1];
    if (nextRet == null) continue;
    const vec = computeFeatureVector(prices, i, cfg.enabled, cfg.paramMap);
    if (vec.some((v) => !isFinite(v))) continue;

    let y: number;
    switch (cfg.target) {
      case "strategy": y = nextRet > 0 ? 1 : 0; break;
      case "strategy_high": y = nextRet > cfg.targetReturnThreshold ? 1 : 0; break;
      case "close_up": y = prices[i + 1].close > prices[i].close ? 1 : 0; break;
      case "discretionary": y = cfg.holdingState?.get(prices[i + 1].time) ?? 0; break;
    }

    allX.push(vec);
    allY.push(y);
    allTimes.push(prices[i + 1].time);
    allReturns.push(nextRet);
  }

  if (allX.length < cfg.trainWindow + cfg.testWindow) return null;

  // 特徴量の因果的標準化 (過去のみ参照、リークなし)
  if (cfg.standardize) {
    allX = standardizeMatrixCausal(allX, cfg.standardizeWindow);
  }

  let testStart = allTimes.findIndex((t) => t >= cfg.startDate);
  if (testStart < cfg.trainWindow) testStart = cfg.trainWindow;
  const endIdx = allTimes.findLastIndex((t) => t <= cfg.endDate);
  if (endIdx < testStart) return null;

  // ウィンドウ数を事前計算
  const windowStarts: number[] = [];
  for (let w = testStart; w <= endIdx; w += cfg.testWindow) windowStarts.push(w);
  const totalWindows = windowStarts.length;

  const predictions: {
    time: string; actual: number; ret: number; proba: number;
    longThr: number; shortThr: number; windowIdx: number;
  }[] = [];
  const totalImportance = new Array<number>(featureList.length).fill(0);
  let nModels = 0;

  // 進捗指標用 (ウィンドウごとに更新)
  let runningCorrect = 0;
  let runningTotal = 0;
  let runningCumReturn = 0;
  let runningLong = 0;
  let runningShort = 0;

  const useVal = cfg.calibration !== "none" || cfg.autoThreshold;

  // Phase: training
  for (let wi = 0; wi < totalWindows; wi++) {
    if (abortRef.current) return null;

    const wStart = windowStarts[wi];
    // embargo: 学習終端をテスト開始より embargo 日手前に下げる
    const trainEnd = wStart - cfg.embargo;
    const trainStart = Math.max(0, trainEnd - cfg.trainWindow);
    const wEnd = Math.min(wStart + cfg.testWindow, endIdx + 1);
    if (trainEnd - trainStart < 30) continue;

    // 検証分割 (較正・閾値最適化を行う場合のみ学習窓の末尾を確保)
    let fitEnd = trainEnd;
    let valStart = trainEnd; // valStart === trainEnd なら検証なし
    if (useVal) {
      const trainLen = trainEnd - trainStart;
      const valLen = Math.max(20, Math.floor(trainLen * cfg.validationFraction));
      if (trainLen - valLen >= 30) {
        fitEnd = trainEnd - valLen;
        valStart = fitEnd;
      }
    }

    onProgress({
      phase: "training",
      currentWindow: wi + 1,
      totalWindows,
      trainPeriod: [allTimes[trainStart], allTimes[trainEnd - 1]],
      testPeriod: [allTimes[wStart], allTimes[Math.min(wEnd - 1, allTimes.length - 1)]],
      treesBuilt: 0,
      totalTrees: cfg.modelParams.nEstimators,
      runningAccuracy: runningTotal > 0 ? runningCorrect / runningTotal : 0,
      runningReturn: runningCumReturn,
      longCount: runningLong,
      shortCount: runningShort,
    });
    await yieldToUI();

    const fitX = allX.slice(trainStart, fitEnd);
    const fitY = allY.slice(trainStart, fitEnd);

    const model = new GBDT(cfg.modelParams);
    model.fit(fitX, fitY);

    // 検証分割で確率較正と閾値最適化を行う
    let platt: PlattModel | null = null;
    let iso: IsotonicModel | null = null;
    let longThr = cfg.longThreshold;
    const shortThr = cfg.shortThreshold;

    if (valStart < trainEnd) {
      const valRaw: number[] = [];
      const valY: number[] = [];
      for (let j = valStart; j < trainEnd; j++) {
        valRaw.push(model.predictProba(allX[j]));
        valY.push(allY[j]);
      }
      if (cfg.calibration === "platt") {
        platt = fitPlatt(valRaw.map(logit), valY);
      } else if (cfg.calibration === "isotonic") {
        iso = fitIsotonic(valRaw, valY);
      }
      // 較正後の確率で閾値を最適化
      if (cfg.autoThreshold) {
        const valCal = valRaw.map((p) =>
          platt ? applyPlatt(logit(p), platt) : iso ? applyIsotonic(p, iso) : p,
        );
        longThr = tuneThreshold(valCal, valY);
      }
    }

    const calibrate = (raw: number): number =>
      platt ? applyPlatt(logit(raw), platt) : iso ? applyIsotonic(raw, iso) : raw;

    const imp = model.featureImportance();
    for (let f = 0; f < imp.length; f++) totalImportance[f] += imp[f];
    nModels++;

    for (let j = wStart; j < wEnd; j++) {
      const proba = calibrate(model.predictProba(allX[j]));
      predictions.push({ time: allTimes[j], actual: allY[j], ret: allReturns[j], proba, longThr, shortThr, windowIdx: wi });

      // ポジション判定 (進捗用)
      let position = 0;
      if (proba >= longThr) { position = 1; runningLong++; }
      else if (cfg.positionMode === "longShort" && proba <= shortThr) { position = -1; runningShort++; }

      const predicted = proba >= longThr ? 1 : 0;
      if (predicted === allY[j]) runningCorrect++;
      runningTotal++;
      runningCumReturn += position * allReturns[j];
    }
  }

  if (predictions.length === 0) return null;

  // Phase: scoring
  onProgress({
    phase: "scoring", currentWindow: totalWindows, totalWindows,
    trainPeriod: ["", ""], testPeriod: ["", ""],
    treesBuilt: cfg.modelParams.nEstimators, totalTrees: cfg.modelParams.nEstimators,
    runningAccuracy: runningTotal > 0 ? runningCorrect / runningTotal : 0,
    runningReturn: runningCumReturn,
    longCount: runningLong, shortCount: runningShort,
  });
  await yieldToUI();

  // 最終指標
  let tp = 0, fp = 0, fn = 0, tn = 0;
  let cumReturn = 0, bhReturn = 0;
  let longCount = 0, shortCount = 0, cashCount = 0;
  const returns: PredictionReturn[] = [];
  const daily: DailyPrediction[] = [];
  const probaArr: number[] = [];
  const predArr: number[] = [];
  const actualArr: number[] = [];

  for (const p of predictions) {
    let position: -1 | 0 | 1 = 0;
    if (p.proba >= p.longThr) { position = 1; longCount++; }
    else if (cfg.positionMode === "longShort" && p.proba <= p.shortThr) { position = -1; shortCount++; }
    else { cashCount++; }

    const predicted: 0 | 1 = p.proba >= p.longThr ? 1 : 0;
    if (predicted === 1 && p.actual === 1) tp++;
    else if (predicted === 1 && p.actual === 0) fp++;
    else if (predicted === 0 && p.actual === 1) fn++;
    else tn++;

    probaArr.push(p.proba);
    predArr.push(predicted);
    actualArr.push(p.actual);

    cumReturn += position * p.ret;
    bhReturn += p.ret;
    returns.push({ time: p.time, cumReturn });
    daily.push({
      time: p.time, proba: p.proba, predicted,
      actual: (p.actual === 1 ? 1 : 0), position, ret: p.ret, windowIdx: p.windowIdx,
    });
  }

  const total = predictions.length;
  const accuracy = (tp + tn) / total;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const auc = rocAuc(probaArr, actualArr);
  const balancedAcc = balancedAccuracy(predArr, actualArr);
  const ll = logLoss(probaArr, actualArr);
  const baseRate = actualArr.reduce((a, b) => a + b, 0) / total;

  const importance = featureList.map((f, i) => ({
    label: f.label, value: nModels > 0 ? totalImportance[i] / nModels : 0,
  }));
  importance.sort((a, b) => b.value - a.value);

  return {
    returns,
    daily,
    metrics: {
      accuracy, precision, recall, f1, auc, balancedAcc, logLoss: ll, baseRate,
      totalReturn: cumReturn, bhReturn, longCount, shortCount, cashCount, totalDays: total,
    },
    importance,
  };
}

// ── 未来予測 (再帰多段) ───────────────────────────

interface ForecastConfig {
  enabled: Set<string>;
  paramMap: Record<string, Record<string, number>>;
  modelParams: GBDTParams;
  trainWindow: number;
  standardize: boolean;
  standardizeWindow: number;
  target: PredictionTarget;
  targetReturnThreshold: number;
  holdingState?: Map<string, number>;
}

// 翌営業日(週末をスキップ)。祝日は考慮しない簡易版
function nextBusinessDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

// rawHist の末尾行を、直近 window 行(末尾含む)の平均・分散で標準化する。
// standardizeMatrixCausal と同じ trailing 因果セマンティクスを1行分だけ再現。
function standardizeLastRow(rawHist: number[][], window: number): number[] {
  const t = rawHist.length - 1;
  const f = rawHist[t].length;
  const w = Math.max(1, Math.floor(window));
  const start = Math.max(0, t - w + 1);
  const count = t - start + 1;
  const out = new Array<number>(f).fill(0);
  for (let c = 0; c < f; c++) {
    let sum = 0;
    let sumSq = 0;
    for (let k = start; k <= t; k++) {
      const x = rawHist[k][c];
      sum += x;
      sumSq += x * x;
    }
    const m = sum / count;
    const variance = Math.max(0, sumSq / count - m * m);
    const sd = Math.sqrt(variance);
    out[c] = count >= 2 && sd > 1e-9 ? (rawHist[t][c] - m) / sd : 0;
  }
  return out;
}

async function runFutureForecastAsync(
  prices: PricePoint[],
  dailyReturns: (number | null)[],
  cfg: ForecastConfig,
  horizon: number,
  abortRef: { current: boolean },
): Promise<FutureForecast | null> {
  const lb = maxLookback(cfg.enabled, cfg.paramMap);
  const featureList = enabledFeatureList(cfg.enabled);
  if (featureList.length === 0) return null;
  if (prices.length < lb + 30) return null;

  // 全履歴の生特徴量 (i = lb .. prices.length-1)。末尾行は予測の起点。
  const rawAll: number[][] = [];
  const idxAll: number[] = [];
  for (let i = lb; i < prices.length; i++) {
    const vec = computeFeatureVector(prices, i, cfg.enabled, cfg.paramMap);
    if (vec.some((v) => !isFinite(v))) continue;
    rawAll.push(vec);
    idxAll.push(i);
  }
  if (rawAll.length < 30) return null;

  // 学習ラベル: 各行 i は features[i] → return[i+1] の向き。末尾行は次の値が無いので除外。
  const trainRaw: number[][] = [];
  const trainY: number[] = [];
  for (let r = 0; r < rawAll.length; r++) {
    const i = idxAll[r];
    if (i + 1 >= prices.length) break; // 末尾(起点)はラベル無し
    const nextRet = dailyReturns[i + 1];
    if (nextRet == null) continue;
    let y: number;
    switch (cfg.target) {
      case "strategy": y = nextRet > 0 ? 1 : 0; break;
      case "strategy_high": y = nextRet > cfg.targetReturnThreshold ? 1 : 0; break;
      case "close_up": y = prices[i + 1].close > prices[i].close ? 1 : 0; break;
      case "discretionary": y = cfg.holdingState?.get(prices[i + 1].time) ?? 0; break;
    }
    trainRaw.push(rawAll[r]);
    trainY.push(y);
  }
  if (trainRaw.length < 30) return null;

  // 因果的標準化 (リークなし)。学習行・起点行・将来行で同じ trailing 窓を使う。
  let stdAll: number[][] = rawAll;
  if (cfg.standardize) {
    stdAll = standardizeMatrixCausal(rawAll, cfg.standardizeWindow);
  }

  // 学習窓は直近 trainWindow 行に限定。標準化済み行列から対応分を抜く。
  const trainCount = Math.min(cfg.trainWindow, trainRaw.length);
  // trainRaw は rawAll の (ラベル有り) 先頭から並ぶので、標準化版も同じ並びで作り直す
  const stdTrainAll: number[][] = [];
  for (let r = 0; r < rawAll.length; r++) {
    const i = idxAll[r];
    if (i + 1 >= prices.length) break;
    const nextRet = dailyReturns[i + 1];
    if (nextRet == null) continue;
    stdTrainAll.push(stdAll[r]);
  }
  const fitX = stdTrainAll.slice(stdTrainAll.length - trainCount);
  const fitY = trainY.slice(trainY.length - trainCount);

  const model = new GBDT(cfg.modelParams);
  model.fit(fitX, fitY);
  if (abortRef.current) return null;

  // 価格換算用の統計: 直近 trainWindow 本の終値間対数リターン
  const c2c: number[] = [];
  const c2cStart = Math.max(1, prices.length - cfg.trainWindow);
  for (let i = c2cStart; i < prices.length; i++) {
    c2c.push(Math.log(prices[i].close / prices[i - 1].close));
  }
  const pos = c2c.filter((r) => r > 0);
  const neg = c2c.filter((r) => r < 0);
  const muUp = pos.length > 0 ? pos.reduce((a, b) => a + b, 0) / pos.length : 0;
  const muDown = neg.length > 0 ? neg.reduce((a, b) => a + b, 0) / neg.length : 0;
  const cMean = c2c.reduce((a, b) => a + b, 0) / c2c.length;
  const sigma = Math.sqrt(
    c2c.reduce((a, v) => a + (v - cMean) ** 2, 0) / Math.max(1, c2c.length),
  );

  // 直近出来高平均 (合成バー用)
  const volWin = Math.min(20, prices.length);
  let avgVol = 0;
  for (let i = prices.length - volWin; i < prices.length; i++) avgVol += prices[i].volume;
  avgVol /= volWin;

  // ── 再帰多段予測 ──
  const ext = prices.slice(); // 合成バーを順次 push
  const rawHist = rawAll.slice(); // 標準化の trailing 窓用
  let curVec = cfg.standardize ? stdAll[stdAll.length - 1] : rawAll[rawAll.length - 1];

  const lastClose = prices[prices.length - 1].close;
  const days: ForecastDay[] = [];
  let cumLog = 0;

  for (let h = 1; h <= horizon; h++) {
    if (abortRef.current) return null;
    const p = model.predictProba(curVec);
    const r = p * muUp + (1 - p) * muDown;
    cumLog += r;

    const prevClose = ext[ext.length - 1].close;
    const newClose = prevClose * Math.exp(r);
    const open = prevClose;
    const typicalRange = prevClose * sigma;
    const high = Math.max(open, newClose) + typicalRange * 0.5;
    const low = Math.max(newClose * 0.5, Math.min(open, newClose) - typicalRange * 0.5);
    const time = nextBusinessDay(ext[ext.length - 1].time);
    ext.push({ time, open, high, low, close: newClose, volume: avgVol });

    // コーン: 起点からの不確実性は σ√h で拡大
    const halfWidth = sigma * Math.sqrt(h);
    days.push({
      time,
      proba: p,
      expRet: r,
      close: newClose,
      upper: newClose * Math.exp(halfWidth),
      lower: newClose * Math.exp(-halfWidth),
    });

    // 次ステップの起点特徴量を合成バーから再計算
    const rawVec = computeFeatureVector(ext, ext.length - 1, cfg.enabled, cfg.paramMap);
    if (rawVec.some((v) => !isFinite(v))) break;
    rawHist.push(rawVec);
    curVec = cfg.standardize ? standardizeLastRow(rawHist, cfg.standardizeWindow) : rawVec;

    if (h % 5 === 0) await yieldToUI();
  }

  if (days.length === 0) return null;

  // 描画用の直近実終値 (最大120本)
  const histLen = Math.min(120, prices.length);
  const history = prices
    .slice(prices.length - histLen)
    .map((q) => ({ time: q.time, close: q.close }));

  return {
    horizon: days.length,
    trainEnd: prices[prices.length - 1].time,
    lastClose,
    muUp,
    muDown,
    sigma,
    history,
    days,
    cumExpRet: cumLog,
  };
}

// ── 未来予測チャート (実績終値 + 予測パス + コーン) ──

function ForecastChart({ forecast }: { forecast: FutureForecast }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart: IChartApi = createChart(ref.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: ref.current.clientWidth,
      height: 260,
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });

    const fmt = (v: number) => v.toFixed(2);
    const last = forecast.history[forecast.history.length - 1];

    // 実績終値 (青)
    const actual = chart.addSeries(LineSeries, {
      color: "#2563eb", lineWidth: 2,
      priceFormat: { type: "custom", formatter: fmt }, title: "実績終値",
    });
    actual.setData(forecast.history.map((h) => ({ time: h.time as Time, value: h.close })));

    // コーン上限・下限 (淡いオレンジ破線)。起点を先頭に付けて連続させる
    const coneOpts = (key: "upper" | "lower") => [
      { time: last.time as Time, value: last.close },
      ...forecast.days.map((d) => ({ time: d.time as Time, value: d[key] })),
    ];
    for (const key of ["upper", "lower"] as const) {
      const s = chart.addSeries(LineSeries, {
        color: "#fcd34d", lineWidth: 1, lineStyle: 2,
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      });
      s.setData(coneOpts(key));
    }

    // 予測終値 (オレンジ実線)。起点を先頭に付けて実績と連続させる
    const fc = chart.addSeries(LineSeries, {
      color: "#f59e0b", lineWidth: 2,
      priceFormat: { type: "custom", formatter: fmt }, title: "予測",
    });
    fc.setData([
      { time: last.time as Time, value: last.close },
      ...forecast.days.map((d) => ({ time: d.time as Time, value: d.close })),
    ]);

    chart.timeScale().fitContent();

    const onResize = () => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
    };
  }, [forecast]);

  return <div ref={ref} className="w-full rounded border border-gray-100" />;
}

// ── 進捗表示コンポーネント ────────────────────────

function TrainingProgressPanel({ progress }: { progress: TrainingProgress }) {
  const pct = progress.totalWindows > 0
    ? (progress.currentWindow / progress.totalWindows) * 100
    : 0;

  const phaseLabel =
    progress.phase === "features" ? "特徴量を計算中..." :
    progress.phase === "scoring" ? "最終スコアを集計中..." :
    `Walk-Forward ${progress.currentWindow}/${progress.totalWindows}`;

  return (
    <div className="rounded-lg bg-slate-900 text-slate-100 p-4 space-y-3 font-mono text-xs overflow-hidden">
      {/* ヘッダー */}
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75 animate-ping" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-indigo-500" />
        </span>
        <span className="text-indigo-300 font-semibold tracking-wide">GBDT Training</span>
        <span className="text-slate-500 ml-auto">{phaseLabel}</span>
      </div>

      {/* プログレスバー */}
      <div className="relative h-2 bg-slate-700 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300 ease-out"
          style={{
            width: `${pct}%`,
            background: "linear-gradient(90deg, #6366f1, #818cf8, #a5b4fc)",
            boxShadow: "0 0 8px rgba(99, 102, 241, 0.6)",
          }}
        />
        {/* シマー */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.15) 50%, transparent 100%)",
            backgroundSize: "200% 100%",
            animation: "shimmer 1.5s ease-in-out infinite",
          }}
        />
      </div>

      {/* ウィンドウ情報 */}
      {progress.phase === "training" && (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            <div>
              <span className="text-slate-500">学習期間 </span>
              <span className="text-emerald-400">{progress.trainPeriod[0]}</span>
              <span className="text-slate-600"> → </span>
              <span className="text-emerald-400">{progress.trainPeriod[1]}</span>
            </div>
            <div>
              <span className="text-slate-500">テスト期間 </span>
              <span className="text-amber-400">{progress.testPeriod[0]}</span>
              <span className="text-slate-600"> → </span>
              <span className="text-amber-400">{progress.testPeriod[1]}</span>
            </div>
          </div>

          {/* リアルタイム指標 */}
          <div className="flex gap-4 pt-1 border-t border-slate-700">
            <ProgressStat label="正答率" value={`${(progress.runningAccuracy * 100).toFixed(1)}%`} color="text-cyan-400" />
            <ProgressStat
              label="累積リターン"
              value={`${progress.runningReturn >= 0 ? "+" : ""}${(progress.runningReturn * 100).toFixed(2)}%`}
              color={progress.runningReturn >= 0 ? "text-emerald-400" : "text-red-400"}
            />
            <ProgressStat label="ロング" value={`${progress.longCount}`} color="text-blue-400" />
            {progress.shortCount > 0 && (
              <ProgressStat label="ショート" value={`${progress.shortCount}`} color="text-rose-400" />
            )}
          </div>
        </>
      )}

      {/* shimmer keyframes */}
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

function ProgressStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div className="text-slate-500 text-[10px]">{label}</div>
      <div className={`font-semibold ${color}`}>{value}</div>
    </div>
  );
}

// ── Walk-Forward 分割スキームの図解 ─────────────────
// 学習窓・Embargo・テスト窓が時間方向にどう転がるかを模式図で示す。
// 実際のスライダー値に連動するので設定の理解にも使える。

function WalkForwardDiagram({
  trainWindow, testWindow, embargo,
}: { trainWindow: number; testWindow: number; embargo: number }) {
  const rows = 4;
  const total = trainWindow + embargo + testWindow + (rows - 1) * testWindow;
  const W = 560, H = 150;
  const ml = 8, mr = 8, mt = 8, mb = 22;
  const plotW = W - ml - mr;
  const rowH = (H - mt - mb) / rows;
  const barH = rowH * 0.62;
  const sx = (v: number) => ml + (v / total) * plotW;

  const blocks: { row: number; x0: number; x1: number; kind: "train" | "embargo" | "test" }[] = [];
  for (let k = 0; k < rows; k++) {
    const testStart = trainWindow + embargo + k * testWindow;
    const trainEnd = testStart - embargo;
    const trainStart = trainEnd - trainWindow;
    blocks.push({ row: k, x0: trainStart, x1: trainEnd, kind: "train" });
    if (embargo > 0) blocks.push({ row: k, x0: trainEnd, x1: testStart, kind: "embargo" });
    blocks.push({ row: k, x0: testStart, x1: testStart + testWindow, kind: "test" });
  }

  const colors: Record<string, string> = {
    train: "#34d399", embargo: "#94a3b8", test: "#fbbf24",
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 170 }}>
      {/* 時間軸 */}
      <line x1={ml} y1={H - mb + 4} x2={W - mr} y2={H - mb + 4} stroke="#cbd5e1" strokeWidth={1} />
      <text x={ml} y={H - 6} fontSize={10} fill="#94a3b8">過去</text>
      <text x={W - mr} y={H - 6} fontSize={10} fill="#94a3b8" textAnchor="end">時間 →（直近）</text>

      {blocks.map((b, i) => {
        const y = mt + b.row * rowH + (rowH - barH) / 2;
        const x = sx(b.x0);
        const w = sx(b.x1) - sx(b.x0);
        return (
          <g key={i}>
            <rect x={x} y={y} width={Math.max(1, w)} height={barH} rx={2}
              fill={colors[b.kind]} opacity={b.kind === "embargo" ? 0.5 : 0.85} />
            {b.kind === "train" && w > 50 && (
              <text x={x + w / 2} y={y + barH / 2 + 3} fontSize={9} fill="#065f46" textAnchor="middle">学習 {trainWindow}日</text>
            )}
            {b.kind === "test" && w > 30 && (
              <text x={x + w / 2} y={y + barH / 2 + 3} fontSize={9} fill="#92400e" textAnchor="middle">テスト{testWindow}</text>
            )}
          </g>
        );
      })}
      {Array.from({ length: rows }).map((_, k) => (
        <text key={`r${k}`} x={ml} y={mt + k * rowH + 9} fontSize={8} fill="#64748b">窓{k + 1}</text>
      ))}
    </svg>
  );
}

// ── メインコンポーネント ──────────────────────────

export default function PredictiveStrategyPanel({
  prices,
  dailyReturns,
  effectiveStart,
  effectiveEnd,
  onResult,
  ticker,
}: Props) {
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(FEATURE_LIBRARY.filter((f) => f.defaultEnabled).map((f) => f.id)),
  );
  const [paramMap, setParamMap] = useState<Record<string, Record<string, number>>>(() => {
    const m: Record<string, Record<string, number>> = {};
    for (const f of FEATURE_LIBRARY) {
      if (f.params.length > 0) m[f.id] = Object.fromEntries(f.params.map((p) => [p.name, p.default]));
    }
    return m;
  });

  const [modelParams, setModelParams] = useState<GBDTParams>({ ...DEFAULT_GBDT_PARAMS });
  const [trainWindow, setTrainWindow] = useState(252);
  const [testWindow, setTestWindow] = useState(21);
  const [embargo, setEmbargo] = useState(1);

  const [standardize, setStandardize] = useState(true);
  const [standardizeWindow, setStandardizeWindow] = useState(252);
  const [calibration, setCalibration] = useState<CalibrationMode>("none");
  const [autoThreshold, setAutoThreshold] = useState(false);
  const [validationFraction, setValidationFraction] = useState(0.2);

  const [target, setTarget] = useState<PredictionTarget>("strategy");
  const [targetReturnThreshold, setTargetReturnThreshold] = useState(0.005);

  const [positionMode, setPositionMode] = useState<PositionMode>("longOnly");
  const [longThreshold, setLongThreshold] = useState(0.5);
  const [shortThreshold, setShortThreshold] = useState(0.4);

  const [showFeatures, setShowFeatures] = useState(false);
  const [showModelParams, setShowModelParams] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showSplit, setShowSplit] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<PredictionResult | null>(null);
  const [progress, setProgress] = useState<TrainingProgress | null>(null);
  const [discWarning, setDiscWarning] = useState<string | null>(null);

  // 未来予測 (アウトオブサンプル)
  const [horizon, setHorizon] = useState(21);
  const [forecast, setForecast] = useState<FutureForecast | null>(null);
  const [isForecasting, setIsForecasting] = useState(false);
  const [forecastError, setForecastError] = useState<string | null>(null);

  const abortRef = useRef(false);

  const toggleFeature = useCallback((id: string) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const updateParam = useCallback((fid: string, pname: string, v: number) => {
    setParamMap((prev) => ({ ...prev, [fid]: { ...prev[fid], [pname]: v } }));
  }, []);

  const updateModelParam = useCallback((key: keyof GBDTParams, v: number) => {
    setModelParams((prev) => ({ ...prev, [key]: v }));
  }, []);

  const enabledCount = enabled.size;

  const run = useCallback(async () => {
    abortRef.current = false;
    setDiscWarning(null);

    // target=discretionary: 裁量タブで保存した建玉状態をラベルにする
    let holdingState: Map<string, number> | undefined;
    if (target === "discretionary") {
      if (!ticker) {
        setDiscWarning("銘柄が未選択のため裁量データを読み込めません。");
        return;
      }
      const list = listScenarios(ticker);
      const active = list.find((s) => s.id === getActiveId(ticker)) ?? list[0];
      if (!active || active.trades.length === 0) {
        setDiscWarning(
          "この銘柄の裁量シナリオが保存されていません。「裁量トレード」タブで売買して保存してください。",
        );
        return;
      }
      const rec = reconcileTrades(active.trades, prices);
      holdingState = holdingStateByDate(prices, rec.trades);
      if (![...holdingState.values()].some((v) => v === 1)) {
        setDiscWarning("ロング状態の日がありません (買い→売りの保有区間が必要)。");
        return;
      }
    }

    setIsRunning(true);
    setResult(null);
    setProgress(null);

    const res = await runWalkForwardAsync(
      prices, dailyReturns,
      {
        enabled, paramMap, modelParams, trainWindow, testWindow, embargo,
        standardize, standardizeWindow, calibration, autoThreshold, validationFraction,
        target, targetReturnThreshold, holdingState, positionMode, longThreshold, shortThreshold,
        startDate: effectiveStart, endDate: effectiveEnd,
      },
      setProgress,
      abortRef,
    );

    setResult(res);
    onResult(res);
    setIsRunning(false);
    setProgress(null);
  }, [prices, dailyReturns, enabled, paramMap, modelParams, trainWindow, testWindow, embargo, standardize, standardizeWindow, calibration, autoThreshold, validationFraction, target, targetReturnThreshold, positionMode, longThreshold, shortThreshold, effectiveStart, effectiveEnd, onResult, ticker]);

  const cancel = useCallback(() => {
    abortRef.current = true;
  }, []);

  // target=discretionary 用: 裁量シナリオの建玉状態を読み込む (警告文字列を返す場合は失敗)
  const loadHoldingState = useCallback((): Map<string, number> | string | undefined => {
    if (target !== "discretionary") return undefined;
    if (!ticker) return "銘柄が未選択のため裁量データを読み込めません。";
    const list = listScenarios(ticker);
    const active = list.find((s) => s.id === getActiveId(ticker)) ?? list[0];
    if (!active || active.trades.length === 0) {
      return "この銘柄の裁量シナリオが保存されていません。「裁量トレード」タブで売買して保存してください。";
    }
    const rec = reconcileTrades(active.trades, prices);
    const hs = holdingStateByDate(prices, rec.trades);
    if (![...hs.values()].some((v) => v === 1)) {
      return "ロング状態の日がありません (買い→売りの保有区間が必要)。";
    }
    return hs;
  }, [target, ticker, prices]);

  const runForecast = useCallback(async () => {
    abortRef.current = false;
    setForecastError(null);

    let holdingState: Map<string, number> | undefined;
    if (target === "discretionary") {
      const hs = loadHoldingState();
      if (typeof hs === "string") { setForecastError(hs); return; }
      holdingState = hs;
    }

    setIsForecasting(true);
    setForecast(null);

    const fc = await runFutureForecastAsync(
      prices, dailyReturns,
      {
        enabled, paramMap, modelParams, trainWindow,
        standardize, standardizeWindow, target, targetReturnThreshold, holdingState,
      },
      horizon,
      abortRef,
    );

    if (!fc) setForecastError("データが不足しているか特徴量が無効で、未来予測を生成できませんでした。");
    setForecast(fc);
    setIsForecasting(false);
  }, [prices, dailyReturns, enabled, paramMap, modelParams, trainWindow, standardize, standardizeWindow, target, targetReturnThreshold, horizon, loadHoldingState]);

  return (
    <div className="border border-indigo-200 rounded-lg bg-indigo-50/40 p-3 space-y-3">
      <h4 className="font-bold text-sm text-indigo-800">GBDT 予測モデル</h4>

      {/* 予測対象 & ポジションモード */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">予測対象</label>
          <select value={target} onChange={(e) => setTarget(e.target.value as PredictionTarget)}
            className="px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500">
            {TARGET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        {target === "strategy_high" && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">リターン閾値</label>
            <input type="number" min={0.001} max={0.1} step={0.001} value={targetReturnThreshold}
              onChange={(e) => setTargetReturnThreshold(Number(e.target.value))}
              className="w-20 px-2 py-1.5 text-xs border border-gray-300 rounded text-center" />
            <span className="text-xs text-gray-400 ml-1">({(targetReturnThreshold * 100).toFixed(1)}%)</span>
          </div>
        )}
        <div>
          <label className="block text-xs text-gray-500 mb-1">ポジション</label>
          <select value={positionMode} onChange={(e) => setPositionMode(e.target.value as PositionMode)}
            className="px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500">
            <option value="longOnly">ロングのみ</option>
            <option value="longShort">ロング & ショート</option>
          </select>
        </div>
      </div>

      <div className="text-xs text-gray-400">
        {TARGET_OPTIONS.find((o) => o.value === target)?.desc}
        {positionMode === "longOnly"
          ? " → 確率≧ロング閾値で買い、それ以外は現金保持"
          : " → 確率≧ロング閾値で買い、確率≦ショート閾値で売り、中間は現金保持"}
      </div>

      {/* 学習・予測期間の設定 (任意に指定可能) */}
      <div className="rounded-lg border border-indigo-200 bg-white/60 p-3 space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-xs font-semibold text-indigo-800">学習・予測期間の設定</span>
          <button onClick={() => setShowSplit((v) => !v)}
            className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">
            {showSplit ? "▾ 分割方法を隠す" : "▸ 分割方法を図解で見る"}
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <ParamInput label="学習に使う期間 (日)" value={trainWindow} min={60} max={1500} step={10}
            onChange={setTrainWindow} />
          <ParamInput label="予測(テスト)窓 (日)" value={testWindow} min={5} max={252} step={1}
            onChange={setTestWindow} />
          <ParamInput label="Embargo (日)" value={embargo} min={0} max={21} step={1}
            onChange={setEmbargo} />
          <div>
            <div className="text-gray-500 mb-0.5">予測対象期間</div>
            <div className="px-2 py-1 border border-gray-200 rounded bg-gray-50 text-gray-600 truncate"
              title={`${effectiveStart} 〜 ${effectiveEnd}`}>
              {effectiveStart?.slice(2)} 〜 {effectiveEnd?.slice(2)}
            </div>
          </div>
        </div>
        <div className="text-[11px] text-gray-400">
          予測対象期間は上の「開始日／終了日」で指定します。この区間を「予測窓 {testWindow}日」ずつに区切り、各区切りの直前
          {trainWindow}日（Embargo {embargo}日を除く）で学習する Walk-Forward 方式です。
        </div>
        {showSplit && (
          <div className="space-y-2 pt-1">
            <WalkForwardDiagram trainWindow={trainWindow} testWindow={testWindow} embargo={embargo} />
            <div className="text-[11px] text-gray-500 space-y-1">
              <p>
                <span className="text-emerald-600 font-medium">緑=学習期間</span>・
                <span className="text-slate-500 font-medium">灰=Embargo</span>・
                <span className="text-amber-600 font-medium">黄=テスト(予測)期間</span>。
                時間を右に進めながら、学習窓とテスト窓を「テスト窓の幅」ずつスライドさせて繰り返します。
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>各窓では <span className="font-medium">必ず過去だけで学習し、その直後の未来でテスト</span>します（未来情報のリークなし）。</li>
                <li>Embargo は学習終端とテスト開始の間に空ける日数。特徴量の参照窓の重なりによる漏れを防ぎます。</li>
                <li>テスト窓を全期間つなぎ合わせたものが、下の「日次予測」と各種スコアになります。</li>
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* 特徴量選択 */}
      <div>
        <button onClick={() => setShowFeatures((v) => !v)}
          className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">
          {showFeatures ? "▾" : "▸"} 特徴量選択 ({enabledCount}個選択中)
        </button>
        {showFeatures && (
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {FEATURE_LIBRARY.map((f) => (
              <div key={f.id} className="flex flex-col gap-0.5">
                <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input type="checkbox" checked={enabled.has(f.id)} onChange={() => toggleFeature(f.id)}
                    className="rounded border-gray-300" />
                  <span className={enabled.has(f.id) ? "text-gray-800" : "text-gray-400"}>{f.label}</span>
                </label>
                {enabled.has(f.id) && f.params.map((p) => (
                  <div key={p.name} className="flex items-center gap-1 ml-5 text-xs">
                    <span className="text-gray-400 whitespace-nowrap">{p.label}:</span>
                    <input type="number" min={p.min} max={p.max} step={p.step}
                      value={paramMap[f.id]?.[p.name] ?? p.default}
                      onChange={(e) => updateParam(f.id, p.name, Number(e.target.value))}
                      className="w-14 px-1 py-0.5 border border-gray-300 rounded text-center" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* モデルパラメータ */}
      <div>
        <button onClick={() => setShowModelParams((v) => !v)}
          className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">
          {showModelParams ? "▾" : "▸"} モデルパラメータ
        </button>
        {showModelParams && (
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
            <ParamInput label="木の数" value={modelParams.nEstimators} min={5} max={200} step={5}
              onChange={(v) => updateModelParam("nEstimators", v)} />
            <ParamInput label="学習率" value={modelParams.learningRate} min={0.01} max={0.5} step={0.01}
              onChange={(v) => updateModelParam("learningRate", v)} />
            <ParamInput label="最大深度" value={modelParams.maxDepth} min={1} max={8} step={1}
              onChange={(v) => updateModelParam("maxDepth", v)} />
            <ParamInput label="最小葉サンプル" value={modelParams.minSamplesLeaf} min={1} max={30} step={1}
              onChange={(v) => updateModelParam("minSamplesLeaf", v)} />
            <ParamInput label="L2正則化 λ" value={modelParams.lambda} min={0} max={10} step={0.5}
              onChange={(v) => updateModelParam("lambda", v)} />
            <ParamInput label="最小分割ゲイン γ" value={modelParams.gamma} min={0} max={5} step={0.1}
              onChange={(v) => updateModelParam("gamma", v)} />
            <ParamInput label="最小子重み" value={modelParams.minChildWeight} min={0} max={20} step={0.5}
              onChange={(v) => updateModelParam("minChildWeight", v)} />
            <ParamInput label="行サンプル比" value={modelParams.subsample} min={0.1} max={1} step={0.05}
              onChange={(v) => updateModelParam("subsample", v)} />
            <ParamInput label="列サンプル比" value={modelParams.colsample} min={0.1} max={1} step={0.05}
              onChange={(v) => updateModelParam("colsample", v)} />
            <ParamInput label="正例重み" value={modelParams.scalePosWeight} min={0.5} max={10} step={0.5}
              onChange={(v) => updateModelParam("scalePosWeight", v)} />
            <ParamInput label="乱数シード" value={modelParams.seed} min={0} max={9999} step={1}
              onChange={(v) => updateModelParam("seed", v)} />
          </div>
        )}
      </div>

      {/* 学習・検証設定 */}
      <div>
        <button onClick={() => setShowAdvanced((v) => !v)}
          className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">
          {showAdvanced ? "▾" : "▸"} 学習・検証設定
        </button>
        {showAdvanced && (
          <div className="mt-2 space-y-2 text-xs">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <div>
                <div className="text-gray-500 mb-0.5">確率較正</div>
                <select value={calibration} onChange={(e) => setCalibration(e.target.value as CalibrationMode)}
                  className="w-full px-2 py-1 border border-gray-300 rounded">
                  {CALIBRATION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <ParamInput label="検証割合" value={validationFraction} min={0.1} max={0.5} step={0.05}
                onChange={setValidationFraction} />
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={standardize} onChange={(e) => setStandardize(e.target.checked)}
                  className="rounded border-gray-300" />
                <span className="text-gray-700">特徴量を標準化 (因果的z-score)</span>
              </label>
              {standardize && (
                <div className="flex items-center gap-1">
                  <span className="text-gray-400">窓:</span>
                  <input type="number" min={20} max={1000} step={10} value={standardizeWindow}
                    onChange={(e) => setStandardizeWindow(Number(e.target.value))}
                    className="w-16 px-1 py-0.5 border border-gray-300 rounded text-center" />
                </div>
              )}
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={autoThreshold} onChange={(e) => setAutoThreshold(e.target.checked)}
                  className="rounded border-gray-300" />
                <span className="text-gray-700">ロング閾値を自動最適化</span>
              </label>
            </div>
            <div className="text-gray-400">
              Embargo = 学習終端とテスト開始の間に空ける日数（リーク防止）。較正/閾値最適化は学習窓の末尾{(validationFraction * 100).toFixed(0)}%を検証に使用。
            </div>
          </div>
        )}
      </div>

      {/* 閾値 & 実行 */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-gray-600">ロング閾値{autoThreshold ? "(自動)" : ""}:</span>
            <input type="range" min={0.3} max={0.9} step={0.01} disabled={autoThreshold}
              value={longThreshold} onChange={(e) => setLongThreshold(Number(e.target.value))}
              className="w-20 disabled:opacity-40" />
            <span className="font-mono text-indigo-700 w-10">{longThreshold.toFixed(2)}</span>
          </div>
          {positionMode === "longShort" && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-600">ショート閾値:</span>
              <input type="range" min={0.1} max={0.7} step={0.01}
                value={shortThreshold} onChange={(e) => setShortThreshold(Number(e.target.value))}
                className="w-20" />
              <span className="font-mono text-red-600 w-10">{shortThreshold.toFixed(2)}</span>
            </div>
          )}
          {!isRunning ? (
            <button onClick={run} disabled={enabledCount === 0}
              className="px-3 py-1.5 text-xs font-medium rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">
              学習実行
            </button>
          ) : (
            <button onClick={cancel}
              className="px-3 py-1.5 text-xs font-medium rounded bg-red-500 text-white hover:bg-red-600">
              中止
            </button>
          )}
        </div>
        {positionMode === "longShort" && !isRunning && (
          <div className="text-xs text-gray-400">
            確率 ≧ {longThreshold.toFixed(2)} → ロング(買い)　|
            確率 ≦ {shortThreshold.toFixed(2)} → ショート(売り)　|
            中間 → 現金保持
          </div>
        )}
        {discWarning && (
          <div className="bg-amber-50 text-amber-700 rounded p-2 text-xs">⚠ {discWarning}</div>
        )}
      </div>

      {/* 学習進捗 */}
      {isRunning && progress && <TrainingProgressPanel progress={progress} />}

      {/* 結果 */}
      {!isRunning && result && (
        <div className="space-y-3">
          <div className="text-[11px] text-gray-400">
            日次の上昇/下落予測は、上の累積リターンチャート直下に同一時間軸で色分け表示しています。
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs">
            <MetricCell label="正答率" value={pct(result.metrics.accuracy)} />
            <MetricCell label="バランス正答率" value={pct(result.metrics.balancedAcc)}
              color={result.metrics.balancedAcc > 0.5 ? "text-green-600" : "text-red-600"} />
            <MetricCell label="AUC" value={result.metrics.auc.toFixed(3)}
              color={result.metrics.auc > 0.5 ? "text-green-600" : "text-red-600"} />
            <MetricCell label="ベースレート" value={pct(result.metrics.baseRate)} />
            <MetricCell label="適合率" value={pct(result.metrics.precision)} />
            <MetricCell label="再現率" value={pct(result.metrics.recall)} />
            <MetricCell label="F1スコア" value={result.metrics.f1.toFixed(3)} />
            <MetricCell label="LogLoss" value={result.metrics.logLoss.toFixed(4)} />
            <MetricCell label="予測累積リターン" value={pct(result.metrics.totalReturn)}
              color={result.metrics.totalReturn > 0 ? "text-green-600" : "text-red-600"} />
            <MetricCell label="B&H累積リターン" value={pct(result.metrics.bhReturn)}
              color={result.metrics.bhReturn > 0 ? "text-green-600" : "text-red-600"} />
            <MetricCell label="超過リターン"
              value={(result.metrics.totalReturn - result.metrics.bhReturn > 0 ? "+" : "") + pct(result.metrics.totalReturn - result.metrics.bhReturn)}
              color={result.metrics.totalReturn > result.metrics.bhReturn ? "text-green-700" : "text-red-700"} />
            <MetricCell label="ロング/ショート/現金"
              value={`${result.metrics.longCount}/${result.metrics.shortCount}/${result.metrics.cashCount}`} />
          </div>

          {result.importance.length > 0 && (
            <div>
              <div className="text-xs text-gray-500 mb-1">特徴量重要度</div>
              <div className="space-y-0.5">
                {result.importance.map((item) => {
                  const maxVal = result.importance[0].value;
                  const w = maxVal > 0 ? (item.value / maxVal) * 100 : 0;
                  return (
                    <div key={item.label} className="flex items-center gap-2 text-xs">
                      <span className="w-28 text-gray-600 truncate text-right">{item.label}</span>
                      <div className="flex-1 h-3 bg-gray-100 rounded overflow-hidden">
                        <div className="h-full bg-indigo-400 rounded" style={{ width: `${w}%` }} />
                      </div>
                      <span className="w-10 text-gray-500 font-mono text-right">{(item.value * 100).toFixed(0)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {result === null && !isRunning && (
        <div className="text-xs text-gray-400">特徴量を選択し「学習実行」を押してください</div>
      )}

      {/* ── 未来予測 (アウトオブサンプル) ── */}
      <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3 space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h5 className="text-sm font-semibold text-amber-800">未来予測（アウトオブサンプル）</h5>
            <p className="text-[11px] text-gray-500 mt-0.5">
              直近の最新日まで学習に使い、その先のまだ起きていない日を再帰的に予測して価格パスを描きます。
            </p>
          </div>
          <div className="flex items-end gap-2">
            <div>
              <label className="block text-xs text-gray-500 mb-1">予測日数</label>
              <input type="number" min={1} max={63} step={1} value={horizon}
                onChange={(e) => setHorizon(Math.max(1, Math.min(63, Number(e.target.value) || 1)))}
                className="w-20 px-2 py-1.5 text-xs border border-gray-300 rounded text-center" />
            </div>
            <button onClick={runForecast} disabled={isForecasting || enabledCount === 0}
              className="px-3 py-1.5 text-xs font-medium rounded bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed">
              {isForecasting ? "予測中..." : `未来${horizon}日を予測`}
            </button>
          </div>
        </div>

        {forecastError && (
          <div className="bg-amber-50 text-amber-700 rounded p-2 text-xs">⚠ {forecastError}</div>
        )}

        {forecast && !isForecasting && (() => {
          const last = forecast.days[forecast.days.length - 1];
          const totalRet = Math.exp(forecast.cumExpRet) - 1; // 単純リターン換算
          const up = forecast.days.filter((d) => d.proba >= 0.5).length;
          return (
            <div className="space-y-2">
              <ForecastChart forecast={forecast} />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500">
                <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-blue-600" /> 実績終値</span>
                <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-amber-500" /> 予測パス</span>
                <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5" style={{ background: "#fcd34d" }} /> ±σ√h コーン</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs">
                <MetricCell label="起点(学習最終日)" value={forecast.trainEnd.slice(2)} />
                <MetricCell label="起点終値" value={forecast.lastClose.toFixed(2)} />
                <MetricCell label={`${forecast.horizon}日後 予測終値`} value={last.close.toFixed(2)}
                  color={last.close >= forecast.lastClose ? "text-green-600" : "text-red-600"} />
                <MetricCell label="期間 期待リターン" value={(totalRet >= 0 ? "+" : "") + (totalRet * 100).toFixed(2) + "%"}
                  color={totalRet >= 0 ? "text-green-600" : "text-red-600"} />
                <MetricCell label="上昇予測日数" value={`${up}/${forecast.horizon}`} />
                <MetricCell label="日次ボラ σ" value={(forecast.sigma * 100).toFixed(2) + "%"} />
                <MetricCell label="上昇日平均 μ↑" value={"+" + (forecast.muUp * 100).toFixed(2) + "%"} color="text-green-600" />
                <MetricCell label="下落日平均 μ↓" value={(forecast.muDown * 100).toFixed(2) + "%"} color="text-red-600" />
              </div>
              <div className="text-[11px] text-gray-400">
                予測は確率を期待リターン（期待r = p·μ↑ + (1−p)·μ↓）に換算した中心シナリオです。
                日が進むほど合成データを再帰利用するため不確実性が増し、コーン（±σ√h）が広がります。
                価格パスは終値方向に対する予測なので、上の「予測対象」を<span className="font-medium">「終値上昇」</span>にすると最も整合します。
              </div>
            </div>
          );
        })()}

        {!forecast && !isForecasting && !forecastError && (
          <div className="text-[11px] text-gray-400">
            「未来{horizon}日を予測」を押すと、現在の特徴量・モデル設定・学習窓（{trainWindow}日）で未来の価格パスを推定します。
          </div>
        )}
      </div>

      <AnalysisGuide title="GBDT予測モデルの詳細理論">
        <p className="font-medium text-gray-700">1. GBDT(勾配ブースティング決定木)とは</p>
        <p>
          多数の浅い決定木を順番に足し合わせ、前の木が外した部分を次の木が補正していくアンサンブル学習です。
          ここでは「翌日のリターン方向(上がるか下がるか)」を予測する二値分類器として用います。
          1本の木が弱い予測器(weak learner)でも、誤差を少しずつ埋めるように何十本も重ねることで強い予測器になります。
          本実装は <span className="font-medium">XGBoost型</span>(2次のニュートン法で葉の値を決める方式)です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          予測のスコア(log-odds) F を初期値 F₀ = ln(正例数/負例数) から始め、木を1本追加するたびに
          {" "}F ← F + η·f(x) と更新します(η は学習率)。確率は p = σ(F) = 1/(1+e⁻ᶠ)。
        </p>
        <p>
          ロジスティック損失に対し、各サンプルの勾配 gᵢ = pᵢ − yᵢ、ヘシアン hᵢ = pᵢ(1−pᵢ) を計算します
          (yᵢ は正解ラベル0/1)。木の葉(終端ノード)の出力値は、その葉に落ちたサンプルで
        </p>
        <p>{"  w* = − Σgᵢ / (Σhᵢ + λ)"}</p>
        <p>
          と1ステップのニュートン法で決めます。λ は L2正則化で、葉の値を0方向へ縮約し過学習を抑えます。
          分割(枝分かれ)の良し悪しは次のゲインで評価します:
        </p>
        <p>{"  Gain = ½·[ G_L²/(H_L+λ) + G_R²/(H_R+λ) − G²/(H+λ) ] − γ"}</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">G, H:</span> ノード内の勾配・ヘシアンの合計。L/R は左右の子。</li>
          <li><span className="font-medium">γ(最小分割ゲイン):</span> この値を上回る改善が無い分割は行わない(枝刈り)。</li>
          <li><span className="font-medium">最小子重み:</span> 子ノードの Σh がこの値未満になる分割を禁止し、少数サンプルへの過適合を防ぐ。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">勾配ブースティング:</span> 損失関数の勾配方向に予測を少しずつ修正する逐次学習法。</li>
          <li><span className="font-medium">ヘシアン:</span> 損失の2階微分。曲率の情報で、更新幅を適切にスケールする(ニュートン法)。</li>
          <li><span className="font-medium">行/列サブサンプリング:</span> 各木の学習に使う行(日)・列(特徴)をランダムに一部だけ使う手法。木ごとに視点を変え、過学習を抑え汎化性能を高める。</li>
          <li><span className="font-medium">scale_pos_weight(正例重み):</span> 正例が少ない不均衡データで、正例の勾配・ヘシアンを重み付けして学習バランスを取る。</li>
          <li><span className="font-medium">Embargo:</span> 学習期間の終わりとテスト期間の始まりの間に空ける空白日数。特徴量の参照窓が重なって未来情報が漏れる(リーク)のを防ぐ。</li>
          <li><span className="font-medium">確率較正(キャリブレーション):</span> モデルが出す確率を実際の的中頻度に合わせて補正すること。Plattはシグモイド、Isotonicは単調関数で補正する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ブースティングは「先生(各木)が順番に答案を採点し、間違えた問題に重点的に印を付けていく」イメージ。次の先生はその印を見て弱点を補強します。</li>
          <li>サブサンプリングは「複数の専門家にわざと一部の情報だけ見せて意見を聞き、多数決を取る」ようなもの。全員が同じ偏りに陥るのを防ぎます。</li>
          <li>確率較正は「いつも自信過剰な予報士の『降水確率80%』を、過去の的中率を見て『実は60%』と読み替える」作業です。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">正答率 vs ベースレート:</span> ベースレート(正例の割合)は「常に多数派を予測」した場合の正答率。正答率がこれを上回って初めて予測に価値があります。</li>
          <li><span className="font-medium">バランス正答率:</span> (上昇の的中率+下落の的中率)/2。クラス不均衡でも騙されない指標。0.5が当てずっぽうの基準。</li>
          <li><span className="font-medium">AUC:</span> 確率の順位付け能力。0.5でランダム、0.55を超えれば金融データでは有意な部類、0.6超は良好。1.0が完璧。</li>
          <li><span className="font-medium">LogLoss:</span> 確率の正確さ(小さいほど良い)。較正を入れると改善しやすい。</li>
          <li><span className="font-medium">特徴量重要度:</span> 各特徴が分割でどれだけ損失を減らしたかの割合。どの情報が効いているかの目安。</li>
          <li><span className="font-medium">日次予測ストリップ:</span> 上の累積リターンチャート直下に同一時間軸で表示。「予測」行はモデルがその日に上昇(緑)/下落(赤)どちらを予測したか、色の濃さは確信度。「実際」行は実現方向、「的中」行は予測と実際が一致したか。緑と赤の縦位置が揃っているほど当たっています。累積リターン曲線と日付を突き合わせて、どの局面で当たり/外れだったかを確認できます。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>予測確率がロング閾値以上の日だけ買う/ショート閾値以下で売る、という規律あるルール化に使えます。</li>
          <li>「ロング閾値を自動最適化」は検証期間でバランス正答率が最大になる閾値を選び、勘に頼らない設定を助けます。</li>
          <li>特徴量重要度から、その銘柄で効いている要因(モメンタム/平均回帰/ボラ/カレンダー等)を把握し、戦略の解釈に役立てます。</li>
          <li>予測累積リターンが B&H(買い持ち)を超過して初めて、能動的売買のコストに見合う可能性があります。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>翌日方向の予測は本質的にノイズが大きく、現実的な正答率の上限は52〜55%程度。過度な期待は禁物です。</li>
          <li>Walk-Forward(過去で学習→直後の未来でテスト)とEmbargoでリークを抑えていますが、特徴量の参照窓が長いほどEmbargoを大きく取る必要があります。</li>
          <li>取引コスト(手数料・スプレッド・スリッページ)は含みません。実運用では超過リターンがコストに消えることがあります。</li>
          <li>木の数を増やしすぎ・深くしすぎ・正則化(λ,γ)が弱すぎると過学習します。サブサンプリングと検証指標(AUC/バランス正答率)で確認してください。</li>
          <li>標準化や較正は学習窓内の過去情報のみで行い未来を使いませんが、レジーム急変時には過去統計が外れることがあります。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">8. 未来予測（アウトオブサンプル）の仕組み</p>
        <p>
          Walk-Forward が「過去で学習→既知の直後でテスト（答え合わせ可能）」なのに対し、未来予測は
          <span className="font-medium">入手できる最新日まで全て学習に使い、まだ起きていない先の日を当てに行く</span>本番運用と同じ設定です。
          GBDTは「翌日の方向（上がる確率 p）」しか出さないため、これを次の手順で価格パスに変換し、再帰的に未来へ伸ばします。
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">確率→期待リターン:</span> 学習窓の終値間リターンから、上昇日の平均 μ↑ と下落日の平均 μ↓ を求め、
            その日の期待対数リターンを <span className="font-mono">r = p·μ↑ + (1−p)·μ↓</span> とします（p が高いほど μ↑ 寄りの上昇ドリフト）。</li>
          <li><span className="font-medium">合成バーの生成:</span> 予測終値 <span className="font-mono">Close′ = Close·e^r</span> を作り、始値=前日終値・高安はσ幅で補完した仮想ローソクを履歴に追加します。</li>
          <li><span className="font-medium">再帰:</span> 追加した合成バーから特徴量を再計算し、次の日の p を予測…を予測日数だけ繰り返します（多段予測）。</li>
          <li><span className="font-medium">信頼度コーン:</span> ランダムウォーク近似で、起点からの不確実性は時間の平方根で広がります。h日後の帯は
            <span className="font-mono"> Close′·e^(±σ√h)</span>（σ=日次ボラ）で、約±1標準偏差（およそ68%）の範囲の目安です。</li>
        </ul>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><span className="font-medium">読み方:</span> オレンジの実線が中心シナリオ（期待値）、淡いコーンが「この辺りに収まりやすい」範囲。コーンが早く広がる銘柄ほど予測の確度は低いと解釈します。</li>
          <li><span className="font-medium">整合性:</span> 価格パスは終値方向の予測なので、上の「予測対象」を「終値上昇」にすると p の意味と最も合います（戦略リターン方向のままでも方向シグナルとして利用可）。</li>
          <li><span className="font-medium">限界:</span> 多段予測は誤差が累積し、合成バーを入力に使うため後半ほど信頼性が落ちます。μ↑/μ↓・σ は過去窓の平均でしかなく、急変・イベント・ジャンプは表現できません。中心線は「平均的にこうなりやすい」程度の参考であり、点予測の的中を保証するものではありません。較正（Platt/Isotonic）は未来予測には適用していません。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

// ── ヘルパー ───────────────────────────────────────

function pct(v: number): string {
  return (v * 100).toFixed(2) + "%";
}

function MetricCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="p-1.5 bg-white rounded border border-gray-100">
      <div className="text-gray-400">{label}</div>
      <div className={`font-mono font-medium ${color ?? ""}`}>{value}</div>
    </div>
  );
}

function ParamInput({
  label, value, min, max, step, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="text-gray-500 mb-0.5">{label}</div>
      <input type="number" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full px-2 py-1 border border-gray-300 rounded text-center" />
    </div>
  );
}
