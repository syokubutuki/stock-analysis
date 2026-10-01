"use client";

// 値動き条件別の将来分布・売買検証（cond-nday-move）。
// ① 条件成立後の分布（後から分かった値動き）② 当時の情報だけで実行できる売買 ③ 頑健性と過剰適合、
// を画面上で分けて出す。計算は app/lib/nday-move*.ts、仕様は docs/nday-move.md。

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { PricePoint } from "../../lib/types";
import type { PeriodKey } from "../../hooks/useAnalysisData";
import { SANITIZER_VERSION, type PriceSanityReport } from "../../lib/price-sanity";
import { useBenchmarkPrices } from "../../hooks/useBenchmarkPrices";
import {
  type AnalysisRange, type MoveCondition, type MoveDirection, type ThresholdUnit, type TriggerMode,
  auditPrices, validateCondition,
} from "../../lib/nday-move";
import { computeDistribution } from "../../lib/nday-move-paths";
import { computeTrades, type CapitalModel, type CostModel } from "../../lib/nday-move-trades";
import { buildExport, downloadText, parseExport, priceFingerprint, toCsv, type NdayMoveSettings } from "../../lib/nday-move-export";
import NdayMoveDistribution from "./NdayMoveDistribution";
import NdayMoveTrades from "./NdayMoveTrades";
import NdayMoveRobustness, { configFromInputs, defaultGridInputs, gridFromInputs, useRobustnessWorker, type GridInputs } from "./NdayMoveRobustness";
import NdayMoveGuide from "./NdayMoveGuide";
import { Notice, TabButton, buttonClass, inputClass, labelClass, pctPointsSigned, yen } from "./ndayMoveShared";

interface Props {
  prices: PricePoint[];
  period: PeriodKey;
  ticker: string;
  dataQuality?: PriceSanityReport;
}

type Tab = "dist" | "trades" | "robust";

interface Inputs {
  direction: MoveDirection;
  lookback: string;
  threshold: string;
  unit: ThresholdUnit;
  trigger: TriggerMode;
  horizon: string;
  excludeOverlap: boolean;
  drawdownPct: string;
  holdDays: string;
  commissionPct: string;
  slippagePct: string;
  initialCapital: string;
  allocationPct: string;
  lotSize: string;
}

const DEFAULT_INPUTS: Inputs = {
  direction: "down", lookback: "5", threshold: "5", unit: "pct", trigger: "edge", horizon: "10", excludeOverlap: true,
  drawdownPct: "3", holdDays: "5", commissionPct: "0", slippagePct: "0.05", initialCapital: "1000000", allocationPct: "100", lotSize: "0",
};

const SETTINGS_KEY = "sa:nday-move:settings:v1";
const TRIALS_KEY = "sa:nday-move:trials:v1";
const SEED = 20260930;
/** ページの期間セレクタと同じ本数（useAnalysisData.ts の PERIOD_DAYS と揃える） */
const PERIOD_BARS: Record<PeriodKey, number> = { "1m": 21, "3m": 63, "6m": 126, "1y": 252, "2y": 504, "3y": 756, "5y": 1260, "10y": 2520 };
const PERIOD_LABEL: Record<PeriodKey, string> = { "1m": "1か月", "3m": "3か月", "6m": "6か月", "1y": "1年", "2y": "2年", "3y": "3年", "5y": "5年", "10y": "10年" };

function loadInputs(): Inputs {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_INPUTS;
    const parsed = JSON.parse(raw) as Partial<Inputs>;
    return { ...DEFAULT_INPUTS, ...parsed };
  } catch {
    return DEFAULT_INPUTS;
  }
}

function loadTrials(): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(TRIALS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

/** 市場の騰落を並べるベンチマーク。指数そのものと投信は対象外。 */
function benchmarkFor(ticker: string): string | null {
  if (ticker.startsWith("^")) return null;
  if (ticker.endsWith(".T")) return "^N225";
  if (/^[0-9A-Z]{8}$/.test(ticker)) return null;
  return "^GSPC";
}

const toInt = (s: string) => (/^\s*\d+\s*$/.test(s) ? Number(s) : NaN);

export default function NdayMoveChart({ prices, period, ticker, dataQuality }: Props) {
  const [inputs, setInputs] = useState<Inputs>(loadInputs);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [tab, setTab] = useState<Tab>("dist");
  const [gridInputs, setGridInputs] = useState<GridInputs>(() => defaultGridInputs(loadInputs().unit));
  const [selectedEvent, setSelectedEvent] = useState<{ key: string; index: number } | null>(null);
  const [selectedTrade, setSelectedTrade] = useState<{ key: string; index: number } | null>(null);
  const [trials, setTrials] = useState<Record<string, string[]>>(loadTrials);
  const [importMessage, setImportMessage] = useState<{ tone: "info" | "warn"; lines: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { run: robustRun, start: startRobust, cancel: cancelRobust } = useRobustnessWorker();

  const benchTicker = benchmarkFor(ticker);
  const bench = useBenchmarkPrices(benchTicker ?? "^N225");
  const benchPrices = benchTicker ? bench.prices : null;

  useEffect(() => {
    try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(inputs)); } catch { /* 保存できなくても計算は続ける */ }
  }, [inputs]);

  const audit = useMemo(() => auditPrices(prices), [prices]);

  // 分析期間（日付 → 添字）
  const range = useMemo<AnalysisRange | null>(() => {
    if (prices.length === 0) return null;
    const start = startDate ? prices.findIndex((p) => p.time >= startDate) : 0;
    let end = prices.length - 1;
    if (endDate) {
      end = -1;
      for (let i = prices.length - 1; i >= 0; i--) if (prices[i].time <= endDate) { end = i; break; }
    }
    if (start < 0 || end < 0 || end <= start) return null;
    return { start, end };
  }, [prices, startDate, endDate]);

  const deferred = useDeferredValue(inputs);
  const computing = deferred !== inputs;
  const condition = useMemo<MoveCondition>(() => ({
    direction: deferred.direction, lookback: toInt(deferred.lookback), threshold: Number(deferred.threshold),
    unit: deferred.unit, trigger: deferred.trigger,
  }), [deferred]);
  const conditionError = validateCondition(condition);
  const horizon = toInt(deferred.horizon);
  const holdDays = toInt(deferred.holdDays);
  const cost = useMemo<CostModel>(() => ({ commissionPct: Number(deferred.commissionPct), slippagePct: Number(deferred.slippagePct) }), [deferred]);
  const capital = useMemo<CapitalModel>(() => ({
    initialCapital: Number(deferred.initialCapital), allocationPct: Number(deferred.allocationPct), lotSize: toInt(deferred.lotSize),
  }), [deferred]);

  const distKey = `${JSON.stringify(condition)}|${deferred.horizon}|${deferred.excludeOverlap}|${deferred.drawdownPct}|${range?.start}-${range?.end}|${prices.length}`;
  const tradeKey = `${JSON.stringify(condition)}|${deferred.holdDays}|${JSON.stringify(cost)}|${JSON.stringify(capital)}|${range?.start}-${range?.end}|${prices.length}`;

  const distribution = useMemo(() => {
    if (!range || conditionError) return null;
    return computeDistribution(prices, audit, condition, range, {
      horizon, excludeOverlap: deferred.excludeOverlap, drawdownPct: Number(deferred.drawdownPct),
    }, benchPrices);
  }, [prices, audit, condition, range, conditionError, horizon, deferred.excludeOverlap, deferred.drawdownPct, benchPrices]);

  const trades = useMemo(() => {
    if (!range || conditionError) return null;
    return computeTrades(prices, audit, condition, range, { holdDays, cost, capital }, { bootstrapDraws: 1000, placeboDraws: 1000, seed: SEED });
  }, [prices, audit, condition, range, conditionError, holdDays, cost, capital]);

  // 手で試した条件の記録（この端末・銘柄ごと）。条件が1.5秒落ち着いたら1件として数える。
  const trialKey = `${deferred.direction}|n${deferred.lookback}|p${deferred.threshold}${deferred.unit}|${deferred.trigger}|H${deferred.horizon}|h${deferred.holdDays}`;
  useEffect(() => {
    if (conditionError || !range) return;
    const timer = window.setTimeout(() => {
      setTrials((prev) => {
        const list = prev[ticker] ?? [];
        if (list.includes(trialKey)) return prev;
        const next = { ...prev, [ticker]: [...list, trialKey].slice(-500) };
        try { window.localStorage.setItem(TRIALS_KEY, JSON.stringify(next)); } catch { /* 記録できなくても続ける */ }
        return next;
      });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [trialKey, ticker, conditionError, range]);
  const triedCount = (trials[ticker] ?? []).length;
  const resetTrials = useCallback(() => {
    setTrials((prev) => {
      const next = { ...prev, [ticker]: [] };
      try { window.localStorage.setItem(TRIALS_KEY, JSON.stringify(next)); } catch { /* 無視 */ }
      return next;
    });
  }, [ticker]);

  // ③ の条件（格子・費用・資金・期間・データが同じなら、前の結果を使い回す）
  const robustConfig = useMemo(() => configFromInputs(gridInputs, deferred.unit, deferred.trigger, cost, capital), [gridInputs, deferred.unit, deferred.trigger, cost, capital]);
  const robustKey = `${JSON.stringify(robustConfig)}|${range?.start}-${range?.end}|${prices.length}|${prices.at(-1)?.time}|${prices.at(-1)?.close}`;
  const runRobust = useCallback(() => {
    if (!range) return;
    startRobust({ prices, audit, range, config: robustConfig }, robustKey);
  }, [range, startRobust, prices, audit, robustConfig, robustKey]);

  const set = (key: keyof Inputs) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value;
    setInputs((prev) => {
      const next = { ...prev, [key]: value } as Inputs;
      if (key === "unit" && value !== prev.unit) next.threshold = value === "pct" ? "5" : "2";
      return next;
    });
    if (key === "unit") setGridInputs((g) => ({ ...g, thresholds: defaultGridInputs(e.target.value as ThresholdUnit).thresholds }));
  };

  const applyPagePeriod = () => {
    const bars = PERIOD_BARS[period];
    setStartDate(prices.length > bars ? prices[prices.length - bars].time : "");
    setEndDate("");
  };

  const pNow = Number(inputs.threshold);
  const unitText = (v: number) => (inputs.unit === "pct" ? `${v}%` : `${v}σ`);
  const rangeText = range ? `${prices[range.start].time}〜${prices[range.end].time}（${(range.end - range.start + 1).toLocaleString("ja-JP")}本）` : "—";
  const conditionSentence = `${ticker}：分析期間 ${rangeText}。過去${inputs.lookback}営業日の終値の騰落率 100×(C[t]/C[t−${inputs.lookback}]−1)${inputs.unit === "sigma" ? "を事前ボラで基準化した値" : ""}が ${inputs.direction === "down" ? `−${unitText(pNow)} 以下` : `+${unitText(pNow)} 以上`}になった日（${inputs.trigger === "edge" ? "不成立→成立の立ち上がり" : "成立日すべて"}）を0日目とし、その後${inputs.horizon}営業日を観測${inputs.excludeOverlap ? "（観測窓の重なる事例は除外）" : "（重なりを許す）"}。売買は0日目の終値で判定 → 翌営業日の始値で買い → 保有${inputs.holdDays}日目の終値で売り（片道 ${(Number(inputs.commissionPct) + Number(inputs.slippagePct)).toFixed(3)}%、初期資金${yen(Number(inputs.initialCapital))}）。`;

  const eventSel = selectedEvent && selectedEvent.key === distKey ? selectedEvent.index : null;
  const tradeSel = selectedTrade && selectedTrade.key === tradeKey ? selectedTrade.index : null;
  const robustResultForExport = robustRun.result && robustRun.key === robustKey ? robustRun.result : null;

  // ───────── 出力 ─────────
  const settingsForExport = (): NdayMoveSettings => ({
    direction: inputs.direction, lookback: toInt(inputs.lookback), threshold: Number(inputs.threshold), unit: inputs.unit, trigger: inputs.trigger,
    horizon: toInt(inputs.horizon), excludeOverlap: inputs.excludeOverlap, drawdownPct: Number(inputs.drawdownPct), holdDays: toInt(inputs.holdDays),
    cost: { commissionPct: Number(inputs.commissionPct), slippagePct: Number(inputs.slippagePct) },
    capital: { initialCapital: Number(inputs.initialCapital), allocationPct: Number(inputs.allocationPct), lotSize: toInt(inputs.lotSize) },
    startDate: range ? prices[range.start].time : "", endDate: range ? prices[range.end].time : "",
    grid: gridFromInputs(gridInputs), walkForward: robustConfig.walkForward, cscvS: robustConfig.cscv.S, seed: SEED,
  });
  const fileStem = `${ticker}-nday-move-${new Date().toISOString().slice(0, 10)}`;
  const exportJson = () => {
    if (!range) return;
    const d = distribution;
    const t = trades;
    const r = robustResultForExport;
    const envelope = buildExport({
      generatedAt: new Date().toISOString(), ticker, sanitizerVersion: SANITIZER_VERSION, dataQuality: dataQuality ?? null,
      data: priceFingerprint(prices, 0, prices.length - 1), analysis: priceFingerprint(prices, range.start, range.end),
      settings: settingsForExport(),
      notes: [
        "価格は /api/stock の配当・分割調整後（終値=調整後終値、始値等も同じ倍率）。配当は価格に含まれ、別途加算していない。税引前。",
        "待機資金の利息は0%。片道の費用を買い・売りそれぞれに掛ける。",
        "①は事後の値動きの記述で、売買の成績ではない。③のウォークフォワード・CSCVは擬似アウトオブサンプル。",
        `出来高0で4本値が同値の行: ${audit.noTradeBars.length}件（約定させない）。`,
        r ? "③は書き出し時の条件で計算済みの結果を含む。" : "③は未計算か、条件が変わったため含めていない。",
      ],
      results: {
        distribution: d && !d.error ? {
          counts: d.counts, finalPct: d.finalPct, maxPct: d.maxPct, minPct: d.minPct, gapPct: d.gapPct,
          firstDownMedian: d.firstDownMedian, drawdownMedian: d.drawdownMedian, minDayHist: d.minDayHist, maxDayHist: d.maxDayHist,
          bands: d.bands, baseline: d.baseline, byPreVol: d.byPreVol, byMarket: d.byMarket,
          events: d.events.map((e) => ({ date: e.date, movePct: e.movePct, z: e.z, available: e.available, complete: e.complete, pathPct: e.pathPct, minDay: e.minDay, minPct: e.minPct, maxDay: e.maxDay, maxPct: e.maxPct, firstDown: e.firstDown, drawdown: e.drawdown, gapPct: e.gapPct, touchesNoTrade: e.touchesNoTrade })),
        } : null,
        trades: t && !t.error ? {
          evalStartDate: prices[t.evalStart]?.time, stats: t.stats, strategy: t.strategy, buyHold: t.buyHold, breakEven: t.breakEven,
          predictive: t.predictive, placebo: t.placebo ? { percentile: t.placebo.percentile, completed: t.placebo.completed, trades: t.placebo.trades, holdDays: t.placebo.holdDays, actualTotal: t.placebo.actualTotal, seed: t.placebo.seed } : null,
          trades: t.trades, skipped: t.skipped,
        } : null,
        robustness: r ? {
          evalStartDate: r.evalStartDate, endDate: r.endDate, candidates: r.candidates, buyHold: r.buyHold,
          walkForward: { status: r.walkForward.status, reason: r.walkForward.reason, folds: r.walkForward.folds, strategy: r.walkForward.strategy, buyHold: r.walkForward.buyHold, cashFolds: r.walkForward.cashFolds },
          cscvStatus: r.cscvStatus,
          cscv: r.cscv ? { S: r.cscv.S, T: r.cscv.T, blockLength: r.cscv.blockLength, dropped: r.cscv.dropped, N: r.cscv.N, distinctN: r.cscv.distinctN, combinations: r.cscv.combinations, pbo: r.cscv.pbo, probLoss: r.cscv.probLoss, degradation: r.cscv.degradation, dominance: { first: r.cscv.dominance.first, second: r.cscv.dominance.second }, selectedCount: r.cscv.selectedCount } : null,
        } : null,
        manualTrials: triedCount,
      },
    });
    downloadText(`${fileStem}.json`, JSON.stringify(envelope, null, 2), "application/json");
  };
  const exportEventsCsv = () => {
    if (!distribution) return;
    downloadText(`${fileStem}-events.csv`, toCsv(
      ["condition_date", "move_pct", "z_sigma", "gap_pct", "final_pct", "max_day", "max_pct", "min_day", "min_pct", "first_down_day", "first_down_observed", "drawdown_day", "drawdown_observed", "observed_days", "complete", "market_lookback_pct", "touches_no_trade_bar"],
      distribution.events.map((e) => [e.date, e.movePct, e.z, e.gapPct, e.finalPct, e.maxDay, e.maxPct, e.minDay, e.minPct, e.firstDown.time, e.firstDown.observed, e.drawdown.time, e.drawdown.observed, e.available, e.complete, e.marketLookbackPct, e.touchesNoTrade]),
    ), "text/csv");
  };
  const exportTradesCsv = () => {
    if (!trades) return;
    downloadText(`${fileStem}-trades.csv`, toCsv(
      ["signal_date", "move_pct", "entry_date", "entry_price_adjusted", "exit_date", "exit_price_adjusted", "status", "holding_bars", "gross_return", "net_return", "net_log", "shares", "cash_out", "cash_in", "mae_close", "mfe_close", "exit_delayed", "suspect_fill"],
      trades.trades.map((t) => [t.signalDate, t.movePct, t.entryDate, t.entryPrice, t.exitDate, t.exitPrice, t.status, t.holdingBars, t.grossReturn, t.netReturn, t.netLog, t.shares, t.cashOut, t.cashIn, t.maeClose, t.mfeClose, t.exitDelayed, t.suspectFill]),
    ), "text/csv");
  };
  const exportCandidatesCsv = () => {
    const r = robustResultForExport;
    if (!r) return;
    downloadText(`${fileStem}-candidates.csv`, toCsv(
      ["direction", "lookback_n", "threshold_p", "unit", "hold_h", "signals", "trades", "mean_net", "median_net", "win_rate", "log_growth", "cagr", "sharpe", "max_drawdown", "exposure", "eval_start", "eval_end"],
      r.candidates.map((c) => [c.direction, c.lookback, c.threshold, inputs.unit, c.hold, c.signals, c.trades, c.meanNet, c.medianNet, c.winRate, c.logGrowth, c.cagr, c.sharpe, c.maxDrawdown, c.exposure, r.evalStartDate, r.endDate]),
    ), "text/csv");
  };
  const importJson = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    const parsed = parseExport(text, { ticker, prices });
    if (parsed.error || !parsed.settings) {
      setImportMessage({ tone: "warn", lines: [parsed.error ?? "読み込めませんでした。"] });
      return;
    }
    const s = parsed.settings;
    setInputs({
      direction: s.direction, lookback: String(s.lookback), threshold: String(s.threshold), unit: s.unit, trigger: s.trigger,
      horizon: String(s.horizon), excludeOverlap: s.excludeOverlap, drawdownPct: String(s.drawdownPct), holdDays: String(s.holdDays),
      commissionPct: String(s.cost.commissionPct), slippagePct: String(s.cost.slippagePct),
      initialCapital: String(s.capital.initialCapital), allocationPct: String(s.capital.allocationPct), lotSize: String(s.capital.lotSize),
    });
    setStartDate(s.startDate);
    setEndDate(s.endDate);
    setGridInputs({
      down: s.grid.directions.includes("down"), up: s.grid.directions.includes("up"),
      lookbacks: s.grid.lookbacks.join(", "), thresholds: s.grid.thresholds.join(", "), holds: s.grid.holds.join(", "),
      minTrainYears: String(s.walkForward.minTrainYears), minTrades: String(s.walkForward.minTrades), S: String(s.cscvS),
    });
    setImportMessage({ tone: parsed.warnings.length > 0 ? "warn" : "info", lines: parsed.warnings.length > 0 ? parsed.warnings : ["条件を読み込みました。書き出し時と同じデータなので、同じ結果になります（③は「計算する」で再計算）。"] });
  };

  // ───────── 描画 ─────────
  if (prices.length === 0) return <p role="status" className="rounded bg-gray-50 p-4 text-sm text-gray-600">価格データを読み込んでいます…</p>;
  if (audit.error) return <p role="alert" className="rounded bg-amber-50 p-3 text-sm text-amber-900">{audit.error}</p>;

  const noTradeDates = audit.noTradeBars.map((i) => prices[i].time);

  return (
    <div className="space-y-4 text-sm">
      <p className="text-gray-600">直前 n 営業日の値動きが条件を満たした後に、①実際にどんな値動きが分布していたか、②当時の情報だけで実行できる買いのみの売買の成績、③その成績が過剰適合でないか、を分けて示します。</p>

      <fieldset className="rounded border border-gray-200 p-3">
        <legend className="px-1 text-xs font-medium">条件（①②③で共通）</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className={labelClass}>方向
            <select className={inputClass} value={inputs.direction} onChange={set("direction")}>
              <option value="down">下落（p%以上下げた後）</option>
              <option value="up">上昇（p%以上上げた後）</option>
            </select>
          </label>
          <label className={labelClass}>判定期間 n（営業日）<input className={inputClass} type="number" inputMode="numeric" min="1" max="252" step="1" value={inputs.lookback} onChange={set("lookback")} /></label>
          <label className={labelClass}>閾値 p（{inputs.unit === "pct" ? "%" : "σ"}）<input className={inputClass} type="number" inputMode="decimal" min="0.01" step="any" value={inputs.threshold} onChange={set("threshold")} /></label>
          <label className={labelClass}>閾値の単位
            <select className={inputClass} value={inputs.unit} onChange={set("unit")}>
              <option value="pct">単純騰落率（%）</option>
              <option value="sigma">事前ボラで基準化（σ）</option>
            </select>
          </label>
          <label className={labelClass}>イベントの数え方
            <select className={inputClass} value={inputs.trigger} onChange={set("trigger")}>
              <option value="edge">不成立→成立の日だけ（既定）</option>
              <option value="every">成立した日すべて</option>
            </select>
          </label>
          <label className={labelClass}>その後の観測期間 H（営業日）<input className={inputClass} type="number" inputMode="numeric" min="1" max="252" step="1" value={inputs.horizon} onChange={set("horizon")} /></label>
          <label className={labelClass}>反落の幅 q（%・①の指標）<input className={inputClass} type="number" inputMode="decimal" min="0.1" max="99" step="any" value={inputs.drawdownPct} onChange={set("drawdownPct")} /></label>
          <label className="flex items-end gap-2 pb-1 text-xs text-gray-700"><input type="checkbox" checked={inputs.excludeOverlap} onChange={set("excludeOverlap")} />観測窓の重なるイベントを除く（採用日の翌日から H 日以内の候補を除外）</label>
        </div>
      </fieldset>

      <fieldset className="rounded border border-gray-200 p-3">
        <legend className="px-1 text-xs font-medium">分析期間と売買の設定（②③で使用）</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className={labelClass}>開始日<input className={inputClass} type="date" value={startDate || prices[0].time} min={prices[0].time} max={prices[prices.length - 1].time} onChange={(e) => setStartDate(e.target.value)} /></label>
          <label className={labelClass}>終了日<input className={inputClass} type="date" value={endDate || prices[prices.length - 1].time} min={prices[0].time} max={prices[prices.length - 1].time} onChange={(e) => setEndDate(e.target.value)} /></label>
          <div className="col-span-2 flex flex-wrap items-end gap-2">
            <button type="button" className={buttonClass} onClick={() => { setStartDate(""); setEndDate(""); }}>取得した全期間</button>
            <button type="button" className={buttonClass} onClick={applyPagePeriod}>ページの期間（{PERIOD_LABEL[period]}）</button>
          </div>
          <label className={labelClass}>保有日数 h（営業日）
            <input className={inputClass} type="number" inputMode="numeric" min="1" max="252" step="1" value={inputs.holdDays} onChange={set("holdDays")} />
            <span className="mt-1 flex gap-1">{["3", "5", "10"].map((v) => <button key={v} type="button" className={`rounded border px-2 py-0.5 ${inputs.holdDays === v ? "border-blue-600 bg-blue-50" : "border-gray-300"}`} onClick={() => setInputs((p) => ({ ...p, holdDays: v }))}>{v}</button>)}</span>
          </label>
          <label className={labelClass}>手数料（片道 %）<input className={inputClass} type="number" inputMode="decimal" min="0" step="any" value={inputs.commissionPct} onChange={set("commissionPct")} /></label>
          <label className={labelClass}>スリッページ（片道 %）<input className={inputClass} type="number" inputMode="decimal" min="0" step="any" value={inputs.slippagePct} onChange={set("slippagePct")} /></label>
          <label className={labelClass}>初期資金（円）<input className={inputClass} type="number" inputMode="numeric" min="1" step="any" value={inputs.initialCapital} onChange={set("initialCapital")} /></label>
          <label className={labelClass}>1回の投入比率（%）<input className={inputClass} type="number" inputMode="decimal" min="1" max="100" step="any" value={inputs.allocationPct} onChange={set("allocationPct")} /></label>
          <label className={labelClass}>売買単位（株・0＝端数株）<input className={inputClass} type="number" inputMode="numeric" min="0" step="1" value={inputs.lotSize} onChange={set("lotSize")} /></label>
        </div>
      </fieldset>

      <p className="rounded bg-gray-50 p-3 text-xs leading-relaxed text-gray-800" aria-live="polite"><strong>現在の条件：</strong>{conditionSentence}{computing && <span className="ml-2 text-gray-500">（計算中…）</span>}</p>
      {conditionError && <p role="alert" className="rounded bg-amber-50 p-3 text-amber-900">{conditionError}</p>}
      {!range && <p role="alert" className="rounded bg-amber-50 p-3 text-amber-900">分析期間が正しくありません。開始日を終了日より前にし、取得できた範囲（{prices[0].time}〜{prices[prices.length - 1].time}）の中で選んでください。</p>}

      <div className="space-y-2 text-xs">
        <Notice tone="muted">
          データ：{ticker} の日足 {prices[0].time}〜{prices[prices.length - 1].time}（{prices.length.toLocaleString("ja-JP")}本、取得は最長10年。上場が遅い銘柄は上場日から）。
          価格は配当・分割の調整後（配当込み・税引前）。1行を1営業日として数えます。
          {dataQuality && (dataQuality.repaired.length > 0 || dataQuality.suspects.length > 0) && <> 取得時に価格の修復{dataQuality.repaired.length}件・疑い{dataQuality.suspects.length}件があります（ページ上部の表示を参照）。</>}
        </Notice>
        {audit.closeOnly && <Notice tone="warn">この系列は終値しか配信されていません（投信の基準価額など）。①の分布は計算できますが、始値で約定する②③は計算できません。</Notice>}
        {noTradeDates.length > 0 && <Notice tone="warn">出来高0で4本値が前日終値と同じ行が{noTradeDates.length}件あります（{noTradeDates.slice(0, 4).join("、")}{noTradeDates.length > 4 ? " ほか" : ""}）。休場日の擬似行か売買のなかった日で、その日の寄りでは約定させません。</Notice>}
        {benchTicker && bench.error && <Notice tone="muted">市場（{benchTicker}）の価格を取得できなかったため、市場の騰落の列は空欄です。</Notice>}
      </div>

      <div role="tablist" aria-label="分析の区分" className="flex flex-wrap gap-1 border-b border-gray-300">
        <TabButton id="nday-tab-dist" controls="nday-panel-dist" active={tab === "dist"} onClick={() => setTab("dist")}>① 事後の分布（後知恵を含む）</TabButton>
        <TabButton id="nday-tab-trades" controls="nday-panel-trades" active={tab === "trades"} onClick={() => setTab("trades")}>② 実行可能な売買（当時の情報のみ）</TabButton>
        <TabButton id="nday-tab-robust" controls="nday-panel-robust" active={tab === "robust"} onClick={() => setTab("robust")}>③ 頑健性・過剰適合（擬似OOS）</TabButton>
      </div>

      <div role="tabpanel" id={`nday-panel-${tab}`} aria-labelledby={`nday-tab-${tab}`}>
        {tab === "dist" && range && distribution && (distribution.error
          ? <p role="alert" className="rounded bg-amber-50 p-3 text-amber-900">{distribution.error}</p>
          : <NdayMoveDistribution prices={prices} range={range} condition={condition} result={distribution} drawdownPct={Number(deferred.drawdownPct)} excludeOverlap={deferred.excludeOverlap}
              benchName={benchTicker && benchPrices ? (bench.name || benchTicker) : null} selected={eventSel} onSelect={(index) => setSelectedEvent({ key: distKey, index })} />)}
        {tab === "trades" && range && trades && (
          <NdayMoveTrades prices={prices} range={range} condition={condition} analysis={trades} holdDays={holdDays} capital={capital} selected={tradeSel} onSelect={(index) => setSelectedTrade({ key: tradeKey, index })} />
        )}
        {tab === "robust" && range && (audit.closeOnly
          ? <Notice tone="warn">終値しか配信されていない系列では、始値で約定する売買の頑健性は検証できません。</Notice>
          : <NdayMoveRobustness unit={deferred.unit} inputs={gridInputs} setInputs={setGridInputs} runState={robustRun} configKey={robustKey}
              onRun={runRobust} onCancel={cancelRobust}
              current={{ direction: condition.direction, lookback: condition.lookback, threshold: condition.threshold, hold: holdDays }}
              currentTrades={trades?.trades ?? []} triedCount={triedCount} onResetTried={resetTrials} />)}
      </div>

      <section className="space-y-2 rounded border border-gray-200 p-3">
        <h4 className="text-xs font-medium">条件と結果の保存・出力（再現用）</h4>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} onClick={exportJson} disabled={!range}>条件と結果をJSONで保存</button>
          <button type="button" className={buttonClass} onClick={exportEventsCsv} disabled={!distribution || !!distribution.error}>イベント一覧CSV</button>
          <button type="button" className={buttonClass} onClick={exportTradesCsv} disabled={!trades || !!trades.error}>取引一覧CSV</button>
          <button type="button" className={buttonClass} onClick={exportCandidatesCsv} disabled={!robustResultForExport}>候補台帳CSV</button>
          <button type="button" className={buttonClass} onClick={() => fileRef.current?.click()}>JSONを読み込んで条件を復元</button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={importJson} />
        </div>
        <p className="text-[11px] text-gray-500">JSON には計算条件・分析期間・取得データの範囲と指紋（前日比から計算。配当調整で水準が遡って変わっても一致する）・価格修復の記録・乱数の種・結果を含みます。読み込むと条件を戻し、データが書き出し時と違えば知らせます。</p>
        {importMessage && <Notice tone={importMessage.tone === "warn" ? "warn" : "info"}>{importMessage.lines.map((l) => <p key={l}>{l}</p>)}</Notice>}
      </section>

      {distribution && !distribution.error && distribution.finalPct && (
        <p className="sr-only">要約：{distribution.counts.adopted}件のイベント、{inputs.horizon}日後の中央値 {pctPointsSigned(distribution.finalPct.q50)}。</p>
      )}
      <NdayMoveGuide />
    </div>
  );
}
