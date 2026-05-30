"use client";

import { useState, useCallback, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { GBDT, type GBDTParams, DEFAULT_GBDT_PARAMS } from "../../lib/ml/gbdt";
import {
  FEATURE_LIBRARY,
  maxLookback,
  computeFeatureVector,
  enabledFeatureList,
} from "../../lib/ml/features";

// ── 型定義 ─────────────────────────────────────────

export interface PredictionReturn {
  time: string;
  cumReturn: number;
}

export interface PredictionResult {
  returns: PredictionReturn[];
  metrics: {
    accuracy: number;
    precision: number;
    recall: number;
    f1: number;
    totalReturn: number;
    bhReturn: number;
    tradeCount: number;
    totalDays: number;
  };
  importance: { label: string; value: number }[];
}

interface Props {
  prices: PricePoint[];
  /** 各日の戦略リターン (nullは取引不可) */
  dailyReturns: (number | null)[];
  effectiveStart: string;
  effectiveEnd: string;
  onResult: (result: PredictionResult | null) => void;
}

// ── Walk-Forward バックテスト ──────────────────────

function runWalkForward(
  prices: PricePoint[],
  dailyReturns: (number | null)[],
  enabled: Set<string>,
  paramMap: Record<string, Record<string, number>>,
  modelParams: GBDTParams,
  trainWindow: number,
  testWindow: number,
  threshold: number,
  startDate: string,
  endDate: string,
): PredictionResult | null {
  const lb = maxLookback(enabled, paramMap);
  const featureList = enabledFeatureList(enabled);
  if (featureList.length === 0) return null;

  // 全データに対して特徴量 & ターゲットを構築
  // X[k] = features(day i), y[k] = 1 if return(day i+1) > 0
  // time[k] = prices[i+1].time (実際に取引する日)
  const allX: number[][] = [];
  const allY: number[] = [];
  const allTimes: string[] = [];
  const allReturns: number[] = [];

  for (let i = lb; i < prices.length - 1; i++) {
    const nextRet = dailyReturns[i + 1];
    if (nextRet == null) continue;

    const vec = computeFeatureVector(prices, i, enabled, paramMap);
    if (vec.some((v) => !isFinite(v))) continue;

    allX.push(vec);
    allY.push(nextRet > 0 ? 1 : 0);
    allTimes.push(prices[i + 1].time);
    allReturns.push(nextRet);
  }

  if (allX.length < trainWindow + testWindow) return null;

  // startDate以降でテストが始まるインデックスを探す
  let testStart = allTimes.findIndex((t) => t >= startDate);
  if (testStart < trainWindow) testStart = trainWindow;

  const endIdx = allTimes.findLastIndex((t) => t <= endDate);
  if (endIdx < testStart) return null;

  // Walk-Forward実行
  const predictions: {
    time: string;
    predicted: number;
    actual: number;
    ret: number;
    proba: number;
  }[] = [];

  // 特徴量重要度を累積
  const totalImportance = new Array<number>(featureList.length).fill(0);
  let nModels = 0;

  for (let wStart = testStart; wStart <= endIdx; wStart += testWindow) {
    const trainEnd = wStart;
    const trainStart = Math.max(0, trainEnd - trainWindow);
    const wEnd = Math.min(wStart + testWindow, endIdx + 1);

    if (trainEnd - trainStart < 30) continue; // 最低30サンプル

    const trainX = allX.slice(trainStart, trainEnd);
    const trainY = allY.slice(trainStart, trainEnd);

    const model = new GBDT(modelParams);
    model.fit(trainX, trainY);

    // 特徴量重要度を累積
    const imp = model.featureImportance();
    for (let f = 0; f < imp.length; f++) totalImportance[f] += imp[f];
    nModels++;

    // テスト期間で予測
    for (let j = wStart; j < wEnd; j++) {
      const proba = model.predictProba(allX[j]);
      predictions.push({
        time: allTimes[j],
        predicted: proba >= threshold ? 1 : 0,
        actual: allY[j],
        ret: allReturns[j],
        proba,
      });
    }
  }

  if (predictions.length === 0) return null;

  // 指標計算
  let tp = 0, fp = 0, fn = 0, tn = 0;
  let cumReturn = 0;
  let bhReturn = 0;
  const returns: PredictionReturn[] = [];

  for (const p of predictions) {
    if (p.predicted === 1 && p.actual === 1) tp++;
    else if (p.predicted === 1 && p.actual === 0) fp++;
    else if (p.predicted === 0 && p.actual === 1) fn++;
    else tn++;

    if (p.predicted === 1) cumReturn += p.ret;
    bhReturn += p.ret;
    returns.push({ time: p.time, cumReturn });
  }

  const accuracy = (tp + tn) / predictions.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  // 正規化した特徴量重要度
  const importance = featureList.map((f, i) => ({
    label: f.label,
    value: nModels > 0 ? totalImportance[i] / nModels : 0,
  }));
  importance.sort((a, b) => b.value - a.value);

  return {
    returns,
    metrics: {
      accuracy,
      precision,
      recall,
      f1,
      totalReturn: cumReturn,
      bhReturn,
      tradeCount: tp + fp,
      totalDays: predictions.length,
    },
    importance,
  };
}

// ── コンポーネント ─────────────────────────────────

export default function PredictiveStrategyPanel({
  prices,
  dailyReturns,
  effectiveStart,
  effectiveEnd,
  onResult,
}: Props) {
  // 特徴量
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(FEATURE_LIBRARY.filter((f) => f.defaultEnabled).map((f) => f.id)),
  );
  const [paramMap, setParamMap] = useState<Record<string, Record<string, number>>>(() => {
    const m: Record<string, Record<string, number>> = {};
    for (const f of FEATURE_LIBRARY) {
      if (f.params.length > 0) {
        m[f.id] = Object.fromEntries(f.params.map((p) => [p.name, p.default]));
      }
    }
    return m;
  });

  // モデルパラメータ
  const [modelParams, setModelParams] = useState<GBDTParams>({ ...DEFAULT_GBDT_PARAMS });
  const [trainWindow, setTrainWindow] = useState(252);
  const [testWindow, setTestWindow] = useState(21);
  const [threshold, setThreshold] = useState(0.5);

  // UI
  const [showFeatures, setShowFeatures] = useState(false);
  const [showModelParams, setShowModelParams] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<PredictionResult | null>(null);

  const toggleFeature = useCallback((id: string) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const updateParam = useCallback((featureId: string, paramName: string, value: number) => {
    setParamMap((prev) => ({
      ...prev,
      [featureId]: { ...prev[featureId], [paramName]: value },
    }));
  }, []);

  const updateModelParam = useCallback((key: keyof GBDTParams, value: number) => {
    setModelParams((prev) => ({ ...prev, [key]: value }));
  }, []);

  const enabledCount = enabled.size;

  const run = useCallback(() => {
    setIsRunning(true);
    // 非同期でUIを更新してからバックテスト実行
    requestAnimationFrame(() => {
      const res = runWalkForward(
        prices,
        dailyReturns,
        enabled,
        paramMap,
        modelParams,
        trainWindow,
        testWindow,
        threshold,
        effectiveStart,
        effectiveEnd,
      );
      setResult(res);
      onResult(res);
      setIsRunning(false);
    });
  }, [prices, dailyReturns, enabled, paramMap, modelParams, trainWindow, testWindow, threshold, effectiveStart, effectiveEnd, onResult]);

  return (
    <div className="border border-indigo-200 rounded-lg bg-indigo-50/40 p-3 space-y-3">
      <h4 className="font-bold text-sm text-indigo-800">GBDT 予測モデル</h4>

      {/* 特徴量選択 */}
      <div>
        <button
          onClick={() => setShowFeatures((v) => !v)}
          className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
        >
          {showFeatures ? "▾" : "▸"} 特徴量選択 ({enabledCount}個選択中)
        </button>
        {showFeatures && (
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {FEATURE_LIBRARY.map((f) => (
              <div key={f.id} className="flex flex-col gap-0.5">
                <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enabled.has(f.id)}
                    onChange={() => toggleFeature(f.id)}
                    className="rounded border-gray-300"
                  />
                  <span className={enabled.has(f.id) ? "text-gray-800" : "text-gray-400"}>
                    {f.label}
                  </span>
                </label>
                {enabled.has(f.id) &&
                  f.params.map((p) => (
                    <div key={p.name} className="flex items-center gap-1 ml-5 text-xs">
                      <span className="text-gray-400 whitespace-nowrap">{p.label}:</span>
                      <input
                        type="number"
                        min={p.min}
                        max={p.max}
                        step={p.step}
                        value={paramMap[f.id]?.[p.name] ?? p.default}
                        onChange={(e) => updateParam(f.id, p.name, Number(e.target.value))}
                        className="w-14 px-1 py-0.5 border border-gray-300 rounded text-center"
                      />
                    </div>
                  ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* モデルパラメータ */}
      <div>
        <button
          onClick={() => setShowModelParams((v) => !v)}
          className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
        >
          {showModelParams ? "▾" : "▸"} モデルパラメータ
        </button>
        {showModelParams && (
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
            <ParamInput label="木の数" value={modelParams.nEstimators} min={5} max={100} step={5}
              onChange={(v) => updateModelParam("nEstimators", v)} />
            <ParamInput label="学習率" value={modelParams.learningRate} min={0.01} max={0.5} step={0.01}
              onChange={(v) => updateModelParam("learningRate", v)} />
            <ParamInput label="最大深度" value={modelParams.maxDepth} min={1} max={8} step={1}
              onChange={(v) => updateModelParam("maxDepth", v)} />
            <ParamInput label="最小葉サンプル" value={modelParams.minSamplesLeaf} min={1} max={30} step={1}
              onChange={(v) => updateModelParam("minSamplesLeaf", v)} />
            <ParamInput label="学習窓 (日)" value={trainWindow} min={60} max={1000} step={10}
              onChange={setTrainWindow} />
            <ParamInput label="テスト窓 (日)" value={testWindow} min={5} max={63} step={1}
              onChange={setTestWindow} />
          </div>
        )}
      </div>

      {/* 閾値 & 実行 */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-600">確率閾値:</span>
          <input
            type="range"
            min={0.3}
            max={0.7}
            step={0.01}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="w-24"
          />
          <span className="font-mono text-indigo-700 w-10">{threshold.toFixed(2)}</span>
        </div>
        <button
          onClick={run}
          disabled={isRunning || enabledCount === 0}
          className="px-3 py-1.5 text-xs font-medium rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRunning ? "学習中..." : "学習実行"}
        </button>
      </div>

      {/* 結果 */}
      {result && (
        <div className="space-y-2">
          {/* 指標 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs">
            <MetricCell label="正答率" value={pct(result.metrics.accuracy)} />
            <MetricCell label="適合率" value={pct(result.metrics.precision)} />
            <MetricCell label="再現率" value={pct(result.metrics.recall)} />
            <MetricCell label="F1スコア" value={result.metrics.f1.toFixed(3)} />
            <MetricCell
              label="予測累積リターン"
              value={pct(result.metrics.totalReturn)}
              color={result.metrics.totalReturn > 0 ? "text-green-600" : "text-red-600"}
            />
            <MetricCell
              label="B&H累積リターン"
              value={pct(result.metrics.bhReturn)}
              color={result.metrics.bhReturn > 0 ? "text-green-600" : "text-red-600"}
            />
            <MetricCell
              label="超過リターン"
              value={(result.metrics.totalReturn - result.metrics.bhReturn > 0 ? "+" : "") + pct(result.metrics.totalReturn - result.metrics.bhReturn)}
              color={result.metrics.totalReturn > result.metrics.bhReturn ? "text-green-700" : "text-red-700"}
            />
            <MetricCell
              label="取引日/全日"
              value={`${result.metrics.tradeCount}/${result.metrics.totalDays}`}
            />
          </div>

          {/* 特徴量重要度 */}
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
                        <div
                          className="h-full bg-indigo-400 rounded"
                          style={{ width: `${w}%` }}
                        />
                      </div>
                      <span className="w-10 text-gray-500 font-mono text-right">
                        {(item.value * 100).toFixed(0)}%
                      </span>
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
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="text-gray-500 mb-0.5">{label}</div>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full px-2 py-1 border border-gray-300 rounded text-center"
      />
    </div>
  );
}
