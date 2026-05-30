"use client";

import { useState, useCallback, useRef } from "react";
import { PricePoint } from "../../lib/types";
import { GBDT, type GBDTParams, DEFAULT_GBDT_PARAMS } from "../../lib/ml/gbdt";
import {
  FEATURE_LIBRARY,
  maxLookback,
  computeFeatureVector,
  enabledFeatureList,
} from "../../lib/ml/features";

// ── 型定義 ─────────────────────────────────────────

type PredictionTarget = "strategy" | "strategy_high" | "close_up";

const TARGET_OPTIONS: { value: PredictionTarget; label: string; desc: string }[] = [
  { value: "strategy", label: "戦略リターン方向", desc: "選択中の戦略リターンが正か負か" },
  { value: "strategy_high", label: "大幅上昇", desc: "戦略リターンが閾値を超えるか" },
  { value: "close_up", label: "終値上昇", desc: "翌日終値が当日終値より高いか" },
];

type PositionMode = "longOnly" | "longShort";

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
    longCount: number;
    shortCount: number;
    cashCount: number;
    totalDays: number;
  };
  importance: { label: string; value: number }[];
}

interface Props {
  prices: PricePoint[];
  dailyReturns: (number | null)[];
  effectiveStart: string;
  effectiveEnd: string;
  onResult: (result: PredictionResult | null) => void;
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
  target: PredictionTarget;
  targetReturnThreshold: number;
  positionMode: PositionMode;
  longThreshold: number;
  shortThreshold: number;
  startDate: string;
  endDate: string;
}

function yieldToUI(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
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

  const allX: number[][] = [];
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
    }

    allX.push(vec);
    allY.push(y);
    allTimes.push(prices[i + 1].time);
    allReturns.push(nextRet);
  }

  if (allX.length < cfg.trainWindow + cfg.testWindow) return null;

  let testStart = allTimes.findIndex((t) => t >= cfg.startDate);
  if (testStart < cfg.trainWindow) testStart = cfg.trainWindow;
  const endIdx = allTimes.findLastIndex((t) => t <= cfg.endDate);
  if (endIdx < testStart) return null;

  // ウィンドウ数を事前計算
  const windowStarts: number[] = [];
  for (let w = testStart; w <= endIdx; w += cfg.testWindow) windowStarts.push(w);
  const totalWindows = windowStarts.length;

  const predictions: { time: string; actual: number; ret: number; proba: number }[] = [];
  const totalImportance = new Array<number>(featureList.length).fill(0);
  let nModels = 0;

  // 進捗指標用 (ウィンドウごとに更新)
  let runningCorrect = 0;
  let runningTotal = 0;
  let runningCumReturn = 0;
  let runningLong = 0;
  let runningShort = 0;

  // Phase: training
  for (let wi = 0; wi < totalWindows; wi++) {
    if (abortRef.current) return null;

    const wStart = windowStarts[wi];
    const trainEnd = wStart;
    const trainStart = Math.max(0, trainEnd - cfg.trainWindow);
    const wEnd = Math.min(wStart + cfg.testWindow, endIdx + 1);
    if (trainEnd - trainStart < 30) continue;

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

    const trainX = allX.slice(trainStart, trainEnd);
    const trainY = allY.slice(trainStart, trainEnd);

    const model = new GBDT(cfg.modelParams);
    model.fit(trainX, trainY);

    const imp = model.featureImportance();
    for (let f = 0; f < imp.length; f++) totalImportance[f] += imp[f];
    nModels++;

    for (let j = wStart; j < wEnd; j++) {
      const proba = model.predictProba(allX[j]);
      predictions.push({ time: allTimes[j], actual: allY[j], ret: allReturns[j], proba });

      // ポジション判定 (進捗用)
      let position = 0;
      if (proba >= cfg.longThreshold) { position = 1; runningLong++; }
      else if (cfg.positionMode === "longShort" && proba <= cfg.shortThreshold) { position = -1; runningShort++; }

      const predicted = proba >= cfg.longThreshold ? 1 : 0;
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

  for (const p of predictions) {
    let position = 0;
    if (p.proba >= cfg.longThreshold) { position = 1; longCount++; }
    else if (cfg.positionMode === "longShort" && p.proba <= cfg.shortThreshold) { position = -1; shortCount++; }
    else { cashCount++; }

    const predicted = p.proba >= cfg.longThreshold ? 1 : 0;
    if (predicted === 1 && p.actual === 1) tp++;
    else if (predicted === 1 && p.actual === 0) fp++;
    else if (predicted === 0 && p.actual === 1) fn++;
    else tn++;

    cumReturn += position * p.ret;
    bhReturn += p.ret;
    returns.push({ time: p.time, cumReturn });
  }

  const total = predictions.length;
  const accuracy = (tp + tn) / total;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  const importance = featureList.map((f, i) => ({
    label: f.label, value: nModels > 0 ? totalImportance[i] / nModels : 0,
  }));
  importance.sort((a, b) => b.value - a.value);

  return {
    returns,
    metrics: { accuracy, precision, recall, f1, totalReturn: cumReturn, bhReturn, longCount, shortCount, cashCount, totalDays: total },
    importance,
  };
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

// ── メインコンポーネント ──────────────────────────

export default function PredictiveStrategyPanel({
  prices,
  dailyReturns,
  effectiveStart,
  effectiveEnd,
  onResult,
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

  const [target, setTarget] = useState<PredictionTarget>("strategy");
  const [targetReturnThreshold, setTargetReturnThreshold] = useState(0.005);

  const [positionMode, setPositionMode] = useState<PositionMode>("longOnly");
  const [longThreshold, setLongThreshold] = useState(0.5);
  const [shortThreshold, setShortThreshold] = useState(0.4);

  const [showFeatures, setShowFeatures] = useState(false);
  const [showModelParams, setShowModelParams] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<PredictionResult | null>(null);
  const [progress, setProgress] = useState<TrainingProgress | null>(null);

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
    setIsRunning(true);
    setResult(null);
    setProgress(null);

    const res = await runWalkForwardAsync(
      prices, dailyReturns,
      {
        enabled, paramMap, modelParams, trainWindow, testWindow,
        target, targetReturnThreshold, positionMode, longThreshold, shortThreshold,
        startDate: effectiveStart, endDate: effectiveEnd,
      },
      setProgress,
      abortRef,
    );

    setResult(res);
    onResult(res);
    setIsRunning(false);
    setProgress(null);
  }, [prices, dailyReturns, enabled, paramMap, modelParams, trainWindow, testWindow, target, targetReturnThreshold, positionMode, longThreshold, shortThreshold, effectiveStart, effectiveEnd, onResult]);

  const cancel = useCallback(() => {
    abortRef.current = true;
  }, []);

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
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-gray-600">ロング閾値:</span>
            <input type="range" min={0.3} max={0.9} step={0.01}
              value={longThreshold} onChange={(e) => setLongThreshold(Number(e.target.value))}
              className="w-20" />
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
      </div>

      {/* 学習進捗 */}
      {isRunning && progress && <TrainingProgressPanel progress={progress} />}

      {/* 結果 */}
      {!isRunning && result && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs">
            <MetricCell label="正答率" value={pct(result.metrics.accuracy)} />
            <MetricCell label="適合率" value={pct(result.metrics.precision)} />
            <MetricCell label="再現率" value={pct(result.metrics.recall)} />
            <MetricCell label="F1スコア" value={result.metrics.f1.toFixed(3)} />
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
