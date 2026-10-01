// 値動き条件（n日単純騰落率）の判定・イベント抽出・データ監査。
// 「値動き条件別の将来分布・売買検証」（cond-nday-move）の土台。仕様は docs/nday-move.md。
//
// ## 既存のイベントスタディとの違い（混同しないこと）
// `event-study.ts` は **1日の対数リターン** ln(C[t]/C[t−1]) で発火し、条件を満たす日を毎回数え、
// 対数累積で経路を描く。ここは **n日の単純騰落率** 100(C[t]/C[t−n] − 1) で判定し、
// 既定では「不成立→成立」の立ち上がりだけをイベントにする。両者は別の分析で、互いに流用しない。
//
// ## 期間の約束（as-of）
// 分析期間 [start, end] は「イベントとして数える日」と「将来を観測してよい範囲」を決める。
// 判定に使う過去（C[t−n]・前日の判定・σの推定窓）は期間の開始前にさかのぼってよい
// （その日の時点で分かっている情報だから）。将来の観測は end で打ち切り、end より先は見ない
// （end を過去に置いて検証用に残した区間を、分布や売買が覗かないため）。
//
// ## 1行＝1営業日
// 日数は取得できた日足の本数で数え、欠損を詰めたり補ったりしない（rise-to-decline と同じ規約）。
// ただし出来高0で4本値が同値の行（休場日の擬似行・売買のなかった日）は「約定できない日」として
// 監査で拾い、売買では約定させない。データ取得層での除外は別タスクで扱う。

import type { PricePoint } from "./types";

export type MoveDirection = "down" | "up";
/** edge = 不成立→成立の立ち上がりだけ / every = 条件を満たした日すべて */
export type TriggerMode = "edge" | "every";
/** pct = 単純騰落率の閾値（%） / sigma = 事前ボラで基準化した閾値（σ） */
export type ThresholdUnit = "pct" | "sigma";

/** σ単位の判定に使う事前ボラの推定窓（営業日）。判定区間 [t−n, t] と重ねない。 */
export const SIGMA_WINDOW = 60;
/** 閾値ちょうどの事例が二進浮動小数の丸めで消えないための許容差。 */
export const THRESHOLD_EPS = 1e-10;

export interface MoveCondition {
  direction: MoveDirection;
  /** 判定期間 n（営業日） */
  lookback: number;
  /** 閾値 p（unit が pct なら %、sigma なら σ の倍数）。正の値 */
  threshold: number;
  unit: ThresholdUnit;
  trigger: TriggerMode;
}

/** 分析期間。prices の添字で両端を含む。 */
export interface AnalysisRange {
  start: number;
  end: number;
}

export interface PriceAudit {
  error: string | null;
  /** 投信型（全バーで4本値が同値かつ出来高0）。始値がないので売買検証はできない。 */
  closeOnly: boolean;
  /** 出来高0かつ4本値が同値の行（休場日の擬似行・売買のなかった日）。約定させない。 */
  noTradeBars: number[];
  /** 出来高はあるが4本値が同値の行（値幅制限の張り付きの疑い）。約定に旗を立てる。 */
  singlePriceBars: number[];
}

export interface Trigger {
  index: number;
  date: string;
  /** 100(C[t]/C[t−n] − 1) */
  movePct: number;
  /** σ単位の値 ln(C[t]/C[t−n]) / (σ̂·√n)。σ̂ を推定できなければ null */
  z: number | null;
}

export interface TriggerScan {
  /** 期間内で条件を満たした日数（立ち上がりかどうかを問わない） */
  conditionDays: number;
  /** trigger 設定に従うイベント候補（重複除外の前） */
  triggers: Trigger[];
  /** 立ち上がり判定で、判定できる最初の日にすでに成立していた日（立ち上がりか分からないので除外） */
  leading: Trigger | null;
  /** 期間内で条件を判定できる最初の日。判定できる日が無ければ null */
  firstSignalIndex: number | null;
}

// ───────────────────────── 監査 ─────────────────────────

function isFlatBar(p: PricePoint): boolean {
  return p.open === p.close && p.high === p.close && p.low === p.close;
}

/**
 * 系列の妥当性と、売買の約定に関わる行の監査。
 * 終値・日付の並びが壊れていれば error を返し、呼び出し側は集計しない（独自修復はしない）。
 */
export function auditPrices(prices: PricePoint[]): PriceAudit {
  const audit: PriceAudit = { error: null, closeOnly: false, noTradeBars: [], singlePriceBars: [] };
  if (prices.length === 0) {
    audit.error = "価格データがありません。";
    return audit;
  }
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    if (!Number.isFinite(p.close) || p.close <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(p.time)
      || (i > 0 && p.time <= prices[i - 1].time)) {
      audit.error = "終値または日付の並びが不正なため集計できません。価格データを再取得してください。";
      return audit;
    }
  }
  audit.closeOnly = prices.every((p) => isFlatBar(p) && !(p.volume > 0));
  if (audit.closeOnly) return audit;
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    const openOk = Number.isFinite(p.open) && p.open > 0;
    if (!openOk || (isFlatBar(p) && !(p.volume > 0))) audit.noTradeBars.push(i);
    else if (isFlatBar(p)) audit.singlePriceBars.push(i);
  }
  return audit;
}

/** 添字の集合を O(1) で引けるようにする。 */
export function indexSet(indices: number[], length: number): Uint8Array {
  const set = new Uint8Array(length);
  for (const i of indices) if (i >= 0 && i < length) set[i] = 1;
  return set;
}

// ───────────────────────── 条件の判定 ─────────────────────────

export function movePct(prices: PricePoint[], t: number, lookback: number): number {
  return 100 * (prices[t].close / prices[t - lookback].close - 1);
}

/**
 * 事前ボラ σ̂（日次対数リターンの標本標準偏差）。推定窓は t−n で終わる SIGMA_WINDOW 本のリターン
 * （添字 t−n−W+1 … t−n）で、判定区間 [t−n, t] の値動きを含めない。
 * 判定区間を含めると、大きく動いた日ほど σ̂ が膨らみ z が機械的に縮む。
 */
export function preEventSigma(prices: PricePoint[], t: number, lookback: number, window = SIGMA_WINDOW): number | null {
  const last = t - lookback;
  const first = last - window + 1;
  if (first < 1) return null;
  let sum = 0;
  let sq = 0;
  for (let i = first; i <= last; i++) {
    const r = Math.log(prices[i].close / prices[i - 1].close);
    sum += r;
    sq += r * r;
  }
  const mean = sum / window;
  const variance = (sq - window * mean * mean) / (window - 1);
  return variance > 0 ? Math.sqrt(variance) : null;
}

export function zScore(prices: PricePoint[], t: number, lookback: number): number | null {
  const sigma = preEventSigma(prices, t, lookback);
  if (sigma === null) return null;
  return Math.log(prices[t].close / prices[t - lookback].close) / (sigma * Math.sqrt(lookback));
}

/** 条件を判定できる最初の添字（全データの先頭から数える）。 */
export function firstComputableIndex(condition: MoveCondition): number {
  return condition.unit === "sigma" ? condition.lookback + SIGMA_WINDOW : condition.lookback;
}

/** t 日に条件が成立しているか。判定できなければ null。 */
export function conditionAt(prices: PricePoint[], t: number, condition: MoveCondition): boolean | null {
  if (t < firstComputableIndex(condition) || t >= prices.length) return null;
  const sign = condition.direction === "down" ? -1 : 1;
  if (condition.unit === "pct") {
    const r = movePct(prices, t, condition.lookback);
    return sign * r + THRESHOLD_EPS >= condition.threshold;
  }
  const z = zScore(prices, t, condition.lookback);
  if (z === null) return null;
  return sign * z + THRESHOLD_EPS >= condition.threshold;
}

export function validateCondition(condition: MoveCondition): string | null {
  const { lookback, threshold } = condition;
  if (!Number.isInteger(lookback) || lookback < 1 || lookback > 252) {
    return "判定期間 n は 1〜252 の整数で指定してください。";
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > (condition.unit === "pct" ? 1000 : 50)) {
    return condition.unit === "pct"
      ? "騰落率の閾値 p は 0 より大きく 1000 以下（%）で指定してください。"
      : "σ単位の閾値は 0 より大きく 50 以下で指定してください。";
  }
  if (condition.direction !== "down" && condition.direction !== "up") return "方向を選択してください。";
  if (condition.trigger !== "edge" && condition.trigger !== "every") return "イベントの数え方を選択してください。";
  if (condition.unit !== "pct" && condition.unit !== "sigma") return "閾値の単位を選択してください。";
  return null;
}

/**
 * 期間内のイベント候補を拾う（重複除外の前）。
 * edge: t 日に成立かつ t−1 日に不成立。t−1 日を判定できない（データ先頭）ときは
 *       立ち上がりか分からないので leading として除外する。
 * every: 成立した日すべて。
 */
export function scanTriggers(prices: PricePoint[], condition: MoveCondition, range: AnalysisRange): TriggerScan {
  const scan: TriggerScan = { conditionDays: 0, triggers: [], leading: null, firstSignalIndex: null };
  const from = Math.max(range.start, firstComputableIndex(condition));
  if (from > range.end) return scan;
  scan.firstSignalIndex = from;
  let prev = conditionAt(prices, from - 1, condition);
  for (let t = from; t <= range.end; t++) {
    const current = conditionAt(prices, t, condition);
    if (current === true) {
      scan.conditionDays++;
      const trigger: Trigger = {
        index: t, date: prices[t].time, movePct: movePct(prices, t, condition.lookback),
        z: zScore(prices, t, condition.lookback),
      };
      if (condition.trigger === "every") scan.triggers.push(trigger);
      else if (prev === false) scan.triggers.push(trigger);
      else if (prev === null) scan.leading = trigger;
    }
    prev = current;
  }
  return scan;
}

export interface AdoptedEvents {
  adopted: Trigger[];
  /** 採用した事例の観測窓（t+1 … t+H）の中で出たため除外した候補 */
  overlapExcluded: Trigger[];
}

/**
 * 観測窓の重なりを除く（①分布用）。古い順に採用し、採用日 t の次は t+H+1 以降から探す。
 * 実際に下落・反発した日で間引き間隔を変えない（未来の結果で標本を選ばないため）。
 */
export function adoptEvents(triggers: Trigger[], horizon: number, excludeOverlap: boolean): AdoptedEvents {
  if (!excludeOverlap) return { adopted: [...triggers], overlapExcluded: [] };
  const adopted: Trigger[] = [];
  const overlapExcluded: Trigger[] = [];
  let nextAllowed = -Infinity;
  for (const trigger of triggers) {
    if (trigger.index < nextAllowed) {
      overlapExcluded.push(trigger);
      continue;
    }
    adopted.push(trigger);
    nextAllowed = trigger.index + horizon + 1;
  }
  return { adopted, overlapExcluded };
}

// ───────────────────────── 小道具 ─────────────────────────

/** シード付き乱数（mulberry32）。同じ seed からは常に同じ列が出る。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Quantiles {
  n: number;
  mean: number;
  min: number;
  q10: number;
  q25: number;
  q50: number;
  q75: number;
  q90: number;
  max: number;
}

/** 線形補間の分位点（R の type 7）。 */
export function quantileOf(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarize(values: number[]): Quantiles | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    n: sorted.length, mean, min: sorted[0], max: sorted[sorted.length - 1],
    q10: quantileOf(sorted, 0.1), q25: quantileOf(sorted, 0.25), q50: quantileOf(sorted, 0.5),
    q75: quantileOf(sorted, 0.75), q90: quantileOf(sorted, 0.9),
  };
}

/** 日付文字列の差（暦日）。 */
export function calendarDays(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}
