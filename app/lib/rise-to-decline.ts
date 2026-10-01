import type { PricePoint } from "./types";
import { kaplanMeierDaily, survivalQuantile } from "./survival";

export type DeclineDefinition = "first-down" | "daily-drop" | "consecutive" | "drawdown" | "below-signal" | "future-peak";

export interface RiseToDeclineOptions {
  lookback: number;
  risePct: number;
  horizon: number;
  excludeOverlap: boolean;
  definition?: DeclineDefinition;
  dropPct?: number;
  consecutiveDays?: number;
}

export interface RiseToDeclineEvent {
  signalDate: string;
  /** 原系列上の位置。追跡区間の終端は、早期に条件が成立しても短縮しない。 */
  signalIndex: number;
  lookbackStartIndex: number;
  followupEndIndex: number;
  availableFollowup: number;
  risePct: number;
  duration: number;
  endDate: string;
  outcome: "decline" | "horizon" | "data-end" | "peak" | "incomplete";
}

export interface DeclineDay {
  day: number;
  atRisk: number;
  declines: number;
  censored: number;
  cumulativeProbability: number | null;
}

export interface RiseToDeclineResult {
  error: string | null;
  rawSignals: number;
  events: RiseToDeclineEvent[];
  days: DeclineDay[];
  bins: { from: number; to: number; count: number }[];
  observed: number;
  horizonCensored: number;
  endCensored: number;
  zeroFollowup: number;
  incomplete: number;
  peaksAtHorizon: number;
  median: number | null;
  quartiles: [number | null, number | null];
}

/**
 * 終値で判定する、上昇条件成立から選択した下落条件までの待ち時間。
 * 日数は入力価格のバー数。欠損を詰めたり修復したりしない。
 * 下落条件は右打ち切りを保持。未来の最高終値日は完全なH日窓だけで経験分布を作る。
 */
export function computeRiseToDecline(
  prices: PricePoint[],
  options: RiseToDeclineOptions,
): RiseToDeclineResult {
  const result: RiseToDeclineResult = {
    error: null, rawSignals: 0, events: [], days: [], bins: [],
    observed: 0, horizonCensored: 0, endCensored: 0, zeroFollowup: 0, incomplete: 0, peaksAtHorizon: 0,
    median: null, quartiles: [null, null],
  };
  const { lookback, risePct, horizon, excludeOverlap } = options;
  const { definition = "first-down", dropPct = 1, consecutiveDays = 2 } = options;
  if (!Number.isInteger(lookback) || lookback < 1 || lookback > 252
    || !Number.isFinite(risePct) || risePct <= 0 || risePct > 1000
    || !Number.isInteger(horizon) || horizon < 1 || horizon > 252) {
    result.error = "判定日数・追跡上限は1〜252の整数、上昇率は0より大きく1000以下で指定してください。";
    return result;
  }
  if (!["first-down", "daily-drop", "consecutive", "drawdown", "below-signal", "future-peak"].includes(definition)) {
    result.error = "集計する定義を選択してください。";
    return result;
  }
  if ((definition === "daily-drop" || definition === "drawdown")
    && (!Number.isFinite(dropPct) || dropPct <= 0 || dropPct >= 100)) {
    result.error = "下落率Xは0より大きく100未満で指定してください。";
    return result;
  }
  if (definition === "consecutive" && (!Number.isInteger(consecutiveDays) || consecutiveDays < 1 || consecutiveDays > horizon)) {
    result.error = "連続下落日数Kは1以上、追跡上限H以下の整数で指定してください。";
    return result;
  }
  if (prices.some((p, i) => !Number.isFinite(p.close) || p.close <= 0
    || !/^\d{4}-\d{2}-\d{2}$/.test(p.time) || (i > 0 && p.time <= prices[i - 1].time))) {
    result.error = "終値または日付の並びが不正なため集計できません。価格データを再取得してください。";
    return result;
  }
  if (prices.length <= lookback) {
    result.error = `少なくとも${lookback + 1}本の日足が必要です。分析期間を長くしてください。`;
    return result;
  }

  let nextAllowed = lookback;
  for (let t = lookback; t < prices.length; t++) {
    const rise = (prices[t].close / prices[t - lookback].close - 1) * 100;
    // 閾値ぴったりの事例が二進浮動小数の丸めで消えないための数値許容差。
    if (rise + 1e-10 < risePct) continue;
    result.rawSignals++;
    if (excludeOverlap && t < nextAllowed) continue;
    // 実際に下落した日ではなく、設定した追跡上限で間引く。未来の結果で標本を選ばない。
    nextAllowed = t + horizon + 1;
    const available = Math.min(horizon, prices.length - 1 - t);
    let duration = available;
    let outcome: RiseToDeclineEvent["outcome"] = available < horizon ? "data-end" : "horizon";
    if (definition === "future-peak") {
      if (available < horizon) {
        // 窓内の暫定最高値を打ち切り時刻と解釈することはできないため、KMには混ぜない。
        outcome = "incomplete";
      } else {
        duration = 1;
        for (let k = 2; k <= horizon; k++) {
          if (prices[t + k].close > prices[t + duration].close) duration = k;
        }
        outcome = "peak";
        if (duration === horizon) result.peaksAtHorizon++;
      }
    } else {
      let peak = prices[t].close;
      let streak = 0;
      for (let k = 1; k <= available; k++) {
        const close = prices[t + k].close;
        const previous = prices[t + k - 1].close;
        peak = Math.max(peak, close);
        streak = close < previous ? streak + 1 : 0;
        const dailyDrop = 100 * (1 - close / previous);
        const drawdown = 100 * (1 - close / peak);
        const occurred = definition === "first-down" ? close < previous
          : definition === "daily-drop" ? dailyDrop > 0 && dailyDrop + 1e-10 >= dropPct
            : definition === "consecutive" ? streak >= consecutiveDays
              : definition === "drawdown" ? drawdown > 0 && drawdown + 1e-10 >= dropPct
                : close < prices[t].close;
        if (occurred) {
          duration = k;
          outcome = "decline";
          break;
        }
      }
    }
    result.events.push({ signalDate: prices[t].time, signalIndex: t, lookbackStartIndex: t - lookback,
      followupEndIndex: t + available, availableFollowup: available,
      risePct: rise, duration, endDate: prices[t + duration].time, outcome });
    if (outcome === "decline" || outcome === "peak") result.observed++;
    else if (outcome === "incomplete") result.incomplete++;
    else if (outcome === "horizon") result.horizonCensored++;
    else result.endCensored++;
    if (duration === 0) result.zeroFollowup++;
  }

  const declines = Array<number>(horizon + 1).fill(0);
  for (const event of result.events) {
    if (event.outcome === "decline" || event.outcome === "peak") declines[event.duration]++;
  }
  if (definition === "future-peak") {
    let cumulativePeaks = 0;
    for (let day = 1; day <= horizon; day++) {
      cumulativePeaks += declines[day];
      result.days.push({ day, atRisk: result.observed, declines: declines[day], censored: 0,
        cumulativeProbability: result.observed > 0 ? cumulativePeaks / result.observed : null });
    }
  } else {
    // Kaplan–Meier（survival.ts と共通）: 同じ日に発生と打ち切りがあれば、両者をその日のリスク集合に含める。
    result.days = kaplanMeierDaily(
      result.events.map((e) => ({ time: e.duration, event: e.outcome === "decline" })),
      horizon,
    ).map((d) => ({ day: d.day, atRisk: d.atRisk, declines: d.events, censored: d.censored,
      cumulativeProbability: d.cumulativeProbability }));
  }
  result.median = survivalQuantile(result.days, 0.5);
  result.quartiles = [survivalQuantile(result.days, 0.25), survivalQuantile(result.days, 0.75)];

  const binWidth = Math.ceil(horizon / 20);
  for (let from = 1; from <= horizon; from += binWidth) {
    const to = Math.min(horizon, from + binWidth - 1);
    result.bins.push({ from, to, count: declines.slice(from, to + 1).reduce((sum, n) => sum + n, 0) });
  }
  return result;
}
