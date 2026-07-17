// ヌル較正 (Stage 4): 曜日スロット最適化の「偽発見の床」を測る
// -------------------------------------------------------------
// bestCombination は 10 スロットそれぞれで max(買W, 売W, 1) を全期間の実データ上で
// 選ぶ。これは in-sample の引数最大化なので、真のエッジが完全にゼロでも
// 各スロットは |Σr| 相当の見かけ益を生み、10 スロット分が積み上がる。
//
// そこで「真の曜日構造がゼロだと分かっているデータ」(サロゲート)を大量に作り、
// まったく同じパイプラインを流して指標の分布を得る。これが偽発見の床であり、
// 実測値はこの分布を有意に上回って初めて「発見」と呼べる。
//
// サロゲートは曜日の割当だけを壊し、ボラティリティ・クラスタリング / 分布の裾 /
// ドリフト / 日中・オーバーナイトの非対称性といった「曜日効果ではない」構造は
// できるだけ保存する。保存する構造が多いほど保守的(=床が高く出る)な検定になる。
import { PricePoint } from "./types";
import {
  bestCombination,
  computePlan,
  computeWalkForward,
  PlanGapFill,
} from "./weekday-trade";

// ---------------------------------------------------------------
// 乱数
// ---------------------------------------------------------------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rnd: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

// ---------------------------------------------------------------
// 分解 / 再構成
// ---------------------------------------------------------------
// 各営業日を (日中リターン, 直後のオーバーナイトリターン) の対に分解する。
// bestCombination のスロット定義と同一の粒度なので、この対を並べ替えることが
// そのまま「どの曜日にどのリターンが乗るか」の並べ替えになる。
export interface Decomposed {
  time: string[];
  dow: number[];
  intra: number[]; // close/open - 1
  over: number[]; // open[i+1]/close[i] - 1 (最終日は 0)
  hasOver: boolean[]; // 最終日のみ false
  weekId: number[]; // 週グループ番号
  spansWeek: boolean[]; // その日の over が週境界(=週末ギャップ)をまたぐか
  base: number; // 初日の始値
  nWeeks: number;
}

export function decompose(prices: PricePoint[]): Decomposed | null {
  const n = prices.length;
  if (n < 2) return null;

  const time: string[] = [];
  const dow: number[] = [];
  const intra: number[] = [];
  const over: number[] = [];
  const hasOver: boolean[] = [];

  for (let i = 0; i < n; i++) {
    const p = prices[i];
    time.push(p.time);
    dow.push(new Date(p.time).getDay());
    intra.push(p.open > 0 ? p.close / p.open - 1 : 0);
    if (i < n - 1 && p.close > 0 && prices[i + 1].open > 0) {
      over.push(prices[i + 1].open / p.close - 1);
      hasOver.push(true);
    } else {
      over.push(0);
      hasOver.push(false);
    }
  }

  // 週グループ: 曜日が前日以下 → 新しい週。
  // weekday-trade.ts の weekStartIndices と同一規則(祝日で月曜が飛んでも頑健)。
  const weekId: number[] = new Array(n);
  let w = -1;
  for (let i = 0; i < n; i++) {
    if (i === 0 || dow[i] <= dow[i - 1]) w++;
    weekId[i] = w;
  }

  const spansWeek: boolean[] = new Array(n);
  for (let i = 0; i < n; i++) {
    spansWeek[i] = hasOver[i] ? weekId[i + 1] !== weekId[i] : false;
  }

  return {
    time,
    dow,
    intra,
    over,
    hasOver,
    weekId,
    spansWeek,
    base: prices[0].open > 0 ? prices[0].open : 100,
    nWeeks: w + 1,
  };
}

// リターン列 → 価格列。実カレンダー(time/dow)はそのままに、値動きだけを差し替える。
// bestCombination / computePlan は open・close・dow・t しか参照しないため、
// high/low/volume は整合する範囲のダミーで足りる。
export function rebuild(dec: Decomposed, intra: number[], over: number[]): PricePoint[] {
  const n = dec.time.length;
  const out: PricePoint[] = new Array(n);
  let open = dec.base;
  for (let i = 0; i < n; i++) {
    let close = open * (1 + intra[i]);
    if (!(close > 0) || !isFinite(close)) close = open;
    out[i] = {
      time: dec.time[i],
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: 0,
    };
    let next = close * (1 + over[i]);
    if (!(next > 0) || !isFinite(next)) next = close;
    open = next;
  }
  return out;
}

function weekGroups(dec: Decomposed): number[][] {
  const g: number[][] = Array.from({ length: dec.nWeeks }, () => []);
  for (let i = 0; i < dec.weekId.length; i++) g[dec.weekId[i]].push(i);
  return g;
}

// ---------------------------------------------------------------
// サロゲート生成
// ---------------------------------------------------------------
export type NullMode = "slotShuffle" | "dayShuffle" | "blockBootstrap" | "iid";

export const NULL_MODE_LABEL: Record<NullMode, string> = {
  slotShuffle: "週内スロット置換（推奨・最も保守的）",
  dayShuffle: "週内・日単位置換",
  blockBootstrap: "定常ブロック・ブートストラップ",
  iid: "IID 再抽出（最も攻撃的）",
};

export const NULL_MODE_DESC: Record<NullMode, string> = {
  slotShuffle:
    "週内で日中リターンを曜日間に置換し、オーバーナイトは週末ギャップを金曜位置に固定したまま週内分のみ置換。週末ギャップの3日分という機械的構造・日中/夜間のボラ非対称・ボラクラスタリング・ドリフトを全て保存し、曜日の割当だけを壊す。",
  dayShuffle:
    "(日中, オーバーナイト) を対のまま週内で置換。日内の日中→夜間の連関は保つが、週末ギャップの位置も動くため週内ボラ形状が変わる。",
  blockBootstrap:
    "平均長 L の幾何ブロックで日を再抽出（Politis-Romano）。ボラクラスタリングを保ちつつ曜日整合を壊す。週をまたぐ再標本なので週構造そのものも崩れる。",
  iid: "日を独立同分布で再抽出。無条件分布(裾の厚さ)以外の全構造を破壊する。床の下限の目安。",
};

interface Surrogate {
  intra: number[];
  over: number[];
}

// 週内で「日中」と「週内オーバーナイト」を別々に置換する。
// 週末ギャップ(spansWeek)と over 欠損日は動かさないので、
// 「金曜後は3日分のギャップ」という機械的構造が保存される。
function surrogateSlotShuffle(dec: Decomposed, groups: number[][], rnd: () => number): Surrogate {
  const intra = dec.intra.slice();
  const over = dec.over.slice();
  for (const idx of groups) {
    const iv = idx.map((i) => dec.intra[i]);
    shuffleInPlace(iv, rnd);
    idx.forEach((i, k) => {
      intra[i] = iv[k];
    });

    const inner = idx.filter((i) => dec.hasOver[i] && !dec.spansWeek[i]);
    const ov = inner.map((i) => dec.over[i]);
    shuffleInPlace(ov, rnd);
    inner.forEach((i, k) => {
      over[i] = ov[k];
    });
  }
  return { intra, over };
}

function surrogateDayShuffle(dec: Decomposed, groups: number[][], rnd: () => number): Surrogate {
  const intra = dec.intra.slice();
  const over = dec.over.slice();
  for (const idx of groups) {
    const perm = idx.slice();
    shuffleInPlace(perm, rnd);
    idx.forEach((i, k) => {
      intra[i] = dec.intra[perm[k]];
      over[i] = dec.over[perm[k]];
    });
  }
  return { intra, over };
}

// 定常ブートストラップ: 確率 1/L で新しい開始点に飛び、それ以外は循環的に次の日へ進む。
function surrogateBlock(dec: Decomposed, rnd: () => number, meanBlock: number): Surrogate {
  const n = dec.intra.length;
  const intra: number[] = new Array(n);
  const over: number[] = new Array(n);
  const p = 1 / Math.max(2, meanBlock);
  let src = Math.floor(rnd() * n);
  for (let i = 0; i < n; i++) {
    if (i > 0 && rnd() < p) src = Math.floor(rnd() * n);
    intra[i] = dec.intra[src];
    over[i] = dec.over[src];
    src = (src + 1) % n;
  }
  return { intra, over };
}

function surrogateIid(dec: Decomposed, rnd: () => number): Surrogate {
  const n = dec.intra.length;
  const intra: number[] = new Array(n);
  const over: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = Math.floor(rnd() * n);
    intra[i] = dec.intra[s];
    over[i] = dec.over[s];
  }
  return { intra, over };
}

function makeSurrogate(
  dec: Decomposed,
  groups: number[][],
  rnd: () => number,
  params: NullCalibParams,
): Surrogate {
  switch (params.mode) {
    case "slotShuffle":
      return surrogateSlotShuffle(dec, groups, rnd);
    case "dayShuffle":
      return surrogateDayShuffle(dec, groups, rnd);
    case "blockBootstrap":
      return surrogateBlock(dec, rnd, params.meanBlock);
    case "iid":
      return surrogateIid(dec, rnd);
  }
}

// ---------------------------------------------------------------
// 評価
// ---------------------------------------------------------------
// inSample   = bestCombination で全期間最適化 → 同じ期間で評価(現行UIの既定挙動)
// walkForward= 各週の直前 lookback 本だけで再最適化 → その週に適用(真のOOS)
export type EvalMode = "inSample" | "walkForward";

export const EVAL_MODE_LABEL: Record<EvalMode, string> = {
  inSample: "全期間最適（bestCombination）",
  walkForward: "ウォークフォワード（真のOOS）",
};

export interface NullCalibParams {
  nIter: number;
  mode: NullMode;
  evalMode: EvalMode;
  costBps: number;
  compound: boolean;
  gapFill: PlanGapFill;
  meanBlock: number; // blockBootstrap の平均ブロック長
  lookback: number; // walkForward の学習窓長(本)
  seed: number;
}

export const DEFAULT_NULL_PARAMS: NullCalibParams = {
  nIter: 500,
  mode: "slotShuffle",
  evalMode: "inSample",
  costBps: 0,
  compound: true,
  gapFill: "cash",
  meanBlock: 10,
  lookback: 252,
  seed: 12345,
};

export interface NullMetrics {
  // --- 戦略成績: 「床」の測定用。曜日効果の検出力は無い(下記コメント参照) ---
  totalReturn: number;
  annualized: number;
  sharpe: number;
  maxDD: number;
  exposure: number;
  // --- 曜日構造そのものの検定: 検出力がある ---
  fIntraday: number;
  fOvernight: number;
}

export const METRIC_KEYS = [
  "fIntraday",
  "fOvernight",
  "totalReturn",
  "annualized",
  "sharpe",
  "maxDD",
  "exposure",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export const METRIC_LABEL: Record<MetricKey, string> = {
  fIntraday: "曜日間ばらつき F（日中）",
  fOvernight: "曜日間ばらつき F（週内オーバーナイト）",
  totalReturn: "累積リターン",
  annualized: "年率リターン",
  sharpe: "シャープ",
  maxDD: "最大ドローダウン",
  exposure: "市場滞在率",
};

// 指標の役割。戦略成績は「床がどれだけ高いか」を示すが、曜日効果の検定には使えない。
export type MetricGroup = "structure" | "performance";
export const METRIC_GROUP: Record<MetricKey, MetricGroup> = {
  fIntraday: "structure",
  fOvernight: "structure",
  totalReturn: "performance",
  annualized: "performance",
  sharpe: "performance",
  maxDD: "performance",
  exposure: "performance",
};

export const METRIC_IS_PCT: Record<MetricKey, boolean> = {
  fIntraday: false,
  fOvernight: false,
  totalReturn: true,
  annualized: true,
  sharpe: false,
  maxDD: true,
  exposure: true,
};

export function formatMetric(k: MetricKey, v: number): string {
  return METRIC_IS_PCT[k] ? `${(v * 100).toFixed(1)}%` : v.toFixed(2);
}

// ---------------------------------------------------------------
// 曜日構造の直接検定（F 統計量）
// ---------------------------------------------------------------
// なぜ戦略成績では曜日効果を検定できないか:
//   置換は週内のドリフトを「消す」のではなく「曜日間に再配置する」だけなので、
//   サロゲートは実データと同じ週次ドリフト総量を保つ。そして最適化器はドリフトが
//   どの曜日に乗っていようと拾えるため、累積リターンは実データとサロゲートを
//   区別できない。実際、月曜に本物のエッジを植えても累積リターンの p 値は動かない。
//   → 累積リターンが測れるのは「床の高さ」だけであって、「曜日効果の有無」ではない。
//
// そこで曜日効果そのものを検定する統計量として、スロット間の平均リターンの
// ばらつき(一元配置分散分析の F 比)を用いる。曜日効果が実在すれば特定スロットに
// 平均が偏るので F は大きくなり、置換の下では 5 スロットは交換可能なので
// これがちょうど正しい帰無分布になる。
function fStat(groups: number[][]): number {
  const nonEmpty = groups.filter((g) => g.length > 0);
  const k = nonEmpty.length;
  if (k < 2) return 0;

  let N = 0;
  let sum = 0;
  for (const g of nonEmpty) {
    for (const v of g) {
      N++;
      sum += v;
    }
  }
  if (N <= k) return 0;
  const grand = sum / N;

  let ssb = 0;
  let ssw = 0;
  for (const g of nonEmpty) {
    const m = g.reduce((a, b) => a + b, 0) / g.length;
    ssb += g.length * (m - grand) ** 2;
    for (const v of g) ssw += (v - m) ** 2;
  }
  const dfb = k - 1;
  const dfw = N - k;
  if (!(ssw > 0) || dfw <= 0) return 0;
  return ssb / dfb / (ssw / dfw);
}

// bestCombination と同一のスロット定義で曜日別にリターンを集める。
// 週末ギャップ(spansWeek)は slotShuffle で固定される=交換可能でないため
// オーバーナイト群から除外する（＝「週末ギャップを超えた曜日効果があるか」を問う）。
export function weekdayF(
  dec: Decomposed,
  intra: number[],
  over: number[],
): { intraday: number; overnight: number } {
  const gIntra: number[][] = Array.from({ length: 5 }, () => []);
  const gOver: number[][] = Array.from({ length: 5 }, () => []);
  for (let i = 0; i < dec.dow.length; i++) {
    const D = dec.dow[i];
    if (D < 1 || D > 5) continue;
    gIntra[D - 1].push(intra[i]);
    if (dec.hasOver[i] && !dec.spansWeek[i]) gOver[D - 1].push(over[i]);
  }
  return { intraday: fStat(gIntra), overnight: fStat(gOver) };
}

// 全指標「大きいほど良い / 大きいほど構造あり」に符号を揃えてある
// （maxDD は負値なので 0 に近いほど大）。
function metricsFor(
  dec: Decomposed,
  intra: number[],
  over: number[],
  params: NullCalibParams,
): NullMetrics {
  const prices = rebuild(dec, intra, over);
  const r =
    params.evalMode === "walkForward"
      ? computeWalkForward(prices, params.lookback, params.gapFill, params.costBps, params.compound)
      : computePlan(
          prices,
          bestCombination(prices, params.compound).legs,
          params.gapFill,
          params.costBps,
          params.compound,
        );
  const f = weekdayF(dec, intra, over);
  return {
    totalReturn: r.totalReturn,
    annualized: r.annualized,
    sharpe: r.sharpe,
    maxDD: r.maxDD,
    exposure: r.exposure,
    fIntraday: f.intraday,
    fOvernight: f.overnight,
  };
}

// ---------------------------------------------------------------
// 集計
// ---------------------------------------------------------------
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface MetricStat {
  actual: number;
  mean: number;
  sd: number;
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  pctile: number; // 実測がヌル分布の何パーセンタイルか (0..1)
  pValue: number; // ヌルが実測以上になる割合 (+1 補正)
  exceeds95: boolean;
}

function summarize(actual: number, nulls: number[]): MetricStat {
  const sorted = nulls.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const mean = n ? sorted.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(sorted.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const ge = sorted.filter((v) => v >= actual).length;
  const p95 = quantile(sorted, 0.95);
  return {
    actual,
    mean,
    sd,
    p05: quantile(sorted, 0.05),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    p95,
    p99: quantile(sorted, 0.99),
    pctile: n ? (n - ge) / n : 0,
    // モンテカルロ p 値の +1 補正 (Davison & Hinkley)。0 を返さないための標準的処置。
    pValue: (ge + 1) / (n + 1),
    exceeds95: n > 0 && actual > p95,
  };
}

export interface NullCalibResult {
  ok: boolean;
  reason?: string;
  actual: NullMetrics;
  nulls: NullMetrics[];
  stats: Record<MetricKey, MetricStat>;
  nIter: number;
  nDays: number;
  nWeeks: number;
  params: NullCalibParams;
}

const ZERO_METRICS: NullMetrics = {
  totalReturn: 0,
  annualized: 0,
  sharpe: 0,
  maxDD: 0,
  exposure: 0,
  fIntraday: 0,
  fOvernight: 0,
};

export function emptyResult(params: NullCalibParams, reason: string): NullCalibResult {
  const stats = {} as Record<MetricKey, MetricStat>;
  for (const k of METRIC_KEYS) stats[k] = summarize(0, [0]);
  return {
    ok: false,
    reason,
    actual: ZERO_METRICS,
    nulls: [],
    stats,
    nIter: 0,
    nDays: 0,
    nWeeks: 0,
    params,
  };
}

export function runNullCalibration(
  prices: PricePoint[],
  params: NullCalibParams,
  onProgress?: (done: number, total: number) => void,
): NullCalibResult {
  const dec = decompose(prices);
  if (!dec) return emptyResult(params, "データ不足（2本以上必要）");
  if (dec.nWeeks < 12) return emptyResult(params, `週数が不足（${dec.nWeeks}週。12週以上必要）`);

  const groups = weekGroups(dec);

  // 実測もサロゲートと同一の再構成経路を通し、床と厳密に同じ土俵に乗せる。
  const actual = metricsFor(dec, dec.intra, dec.over, params);

  const rnd = mulberry32(params.seed);
  const nulls: NullMetrics[] = [];
  for (let it = 0; it < params.nIter; it++) {
    const s = makeSurrogate(dec, groups, rnd, params);
    nulls.push(metricsFor(dec, s.intra, s.over, params));
    if (onProgress && (it % 10 === 9 || it === params.nIter - 1)) onProgress(it + 1, params.nIter);
  }

  const stats = {} as Record<MetricKey, MetricStat>;
  for (const k of METRIC_KEYS) {
    stats[k] = summarize(
      actual[k],
      nulls.map((m) => m[k]),
    );
  }

  return {
    ok: true,
    actual,
    nulls,
    stats,
    nIter: params.nIter,
    nDays: dec.time.length,
    nWeeks: dec.nWeeks,
    params,
  };
}

// ---------------------------------------------------------------
// 描画補助
// ---------------------------------------------------------------
export interface Histogram {
  edges: number[]; // 長さ nBins+1
  counts: number[]; // 長さ nBins
  max: number;
}

export function histogram(values: number[], nBins: number, extra: number[] = []): Histogram {
  const all = values.concat(extra);
  if (all.length === 0) return { edges: [0, 1], counts: [0], max: 0 };
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (!(hi > lo)) {
    hi = lo + 1;
    lo -= 1;
  }
  const pad = (hi - lo) * 0.03;
  lo -= pad;
  hi += pad;
  const w = (hi - lo) / nBins;
  const edges = Array.from({ length: nBins + 1 }, (_, i) => lo + i * w);
  const counts = new Array(nBins).fill(0);
  for (const v of values) {
    let b = Math.floor((v - lo) / w);
    if (b < 0) b = 0;
    if (b >= nBins) b = nBins - 1;
    counts[b]++;
  }
  return { edges, counts, max: Math.max(...counts) };
}
