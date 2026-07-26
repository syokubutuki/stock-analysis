// 週次エントリーの「配分」と「タイミング配分」を1本の最適化として解く
// -------------------------------------------------------------------------------
// 問い:
//   ① 銘柄ごとに資産の何%を割り当てるのが最適か
//   ② 月曜Openに全額を賭けてよいのか（週内で最良のエントリー時刻とは限らない）
//
// この2つは別問題ではない。決定変数を「銘柄 i をスロット s（月寄/月引/火寄/…）で建てる重み
// w_{i,s}」と置き、残り 1−Σw を現金とすれば、①は w の銘柄方向の解、②は w がスロット方向に
// 集中するか・Σw<1（現金を残す）かどうか、という同じ解の別の断面になる。
//
// 実装は4層:
//   ① 配分      … 週次トレードリターン行列 → μ̃(経験ベイズ縮小)・Σ(Ledoit-Wolf) → ケリー配分
//   ② 後知恵ギャップ … 「週内の最良エントリー」は到達不能な上限。月寄 vs 週内平均 vs 完全予見
//   ③ 時間分散  … 資本を先頭 k スロットに等分したときの確実性等価 CE(k) を掃引
//   ④ 待つ価値  … エントリーの最適停止（状態=経過スロット×月寄比z）を後退帰納で解きOOS検定
//
// 決定的に効くのは Σ の非対角。全銘柄を同じ月曜に建てて同じ日に降りるので、リターンは強く
// 横断相関する。個別にケリーを出して足すと総エクスポージャーが N/N_eff 倍オーバーベットになる。
//
// 再利用: buildTradeWeeks の週境界思想（optimal-exit.ts）、clusterStat（intraday-basket.ts）、
//         ledoitWolf / invertMatrix（efficient-frontier.ts）、binOfZ / binCenter（optimal-exit.ts）。

import { PricePoint } from "./types";
import { mean, std } from "./stats-significance";
import { clusterStat } from "./intraday-basket";
import { ledoitWolf, invertMatrix } from "./efficient-frontier";
import { binOfZ, OPTIMAL_EXIT_CONST } from "./optimal-exit";

const { N_BINS } = OPTIMAL_EXIT_CONST;
const WEEKS_PER_YEAR = 52;

export type Side = "long" | "short";
export type Timing = "open" | "close";

export interface TickerPrices {
  ticker: string;
  name?: string;
  prices: PricePoint[];
}

// ───────────────────────── エントリー・スロット ─────────────────────────
// 週内で建てうる時刻。金曜引けは出口側なのでエントリー候補から外す。
export interface SlotDef {
  dow: number; // 1=月 … 5=金
  timing: Timing;
  label: string;
}

export const SLOTS: SlotDef[] = [
  { dow: 1, timing: "open", label: "月寄" },
  { dow: 1, timing: "close", label: "月引" },
  { dow: 2, timing: "open", label: "火寄" },
  { dow: 2, timing: "close", label: "火引" },
  { dow: 3, timing: "open", label: "水寄" },
  { dow: 3, timing: "close", label: "水引" },
  { dow: 4, timing: "open", label: "木寄" },
  { dow: 4, timing: "close", label: "木引" },
  { dow: 5, timing: "open", label: "金寄" },
];

export const EXIT_LABEL = ["月引", "火引", "水引", "木引", "金引"];

// ───────────────────────── 週の切り出し ─────────────────────────

function dowOf(time: string): number {
  return new Date(`${time.slice(0, 10)}T00:00:00Z`).getUTCDay();
}

// その日が属する週の月曜日の日付（全銘柄で共通のキー。祝日で月曜が無くてもズレない）
function weekKey(time: string): string {
  const d = new Date(`${time.slice(0, 10)}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7; // 月曜からの経過日数
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

// 建玉前日までの直近 lookback 本の日次対数リターンσ（先読み無し）
function trailingSigma(prices: PricePoint[], beforeIdx: number, lookback: number): number {
  const rs: number[] = [];
  for (let i = Math.max(1, beforeIdx - lookback + 1); i <= beforeIdx; i++) {
    const a = prices[i - 1].close;
    const b = prices[i].close;
    if (a > 0 && b > 0) rs.push(Math.log(b / a));
  }
  const s = std(rs);
  return s > 0 ? s : 0.01;
}

export interface TickerWeek {
  key: string; // 週キー（その週の月曜日）
  slotRet: (number | null)[]; // スロット s で建て、出口まで持ったときのリターン（side適用後）
  slotZ: (number | null)[]; // 月寄基準の累積対数リターン / σ（side適用後。高い=不利な建値）
  sigma: number;
}

// 1銘柄を「週×スロット」のリターン表に変換する。
// exitDay: その週の h 番目の営業日の引けで降りる（h=5 なら金曜引け＝週末持ち切り）。
// 月曜が休場の週は月寄基準が取れないため除外する（基準点を揺らさない）。
export function buildTickerWeeks(
  prices: PricePoint[], side: Side, exitDay: number, volLookback = 20
): { weeks: TickerWeek[]; skippedNoMonday: number } {
  const sgn = side === "long" ? 1 : -1;
  const n = prices.length;

  const byWeek = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = weekKey(prices[i].time);
    const arr = byWeek.get(k);
    if (arr) arr.push(i);
    else byWeek.set(k, [i]);
  }

  const weeks: TickerWeek[] = [];
  let skippedNoMonday = 0;

  for (const [key, idxs] of byWeek) {
    if (idxs.length < 1) continue;
    const first = idxs[0];
    if (first < volLookback) continue; // σ推定に履歴不足
    if (dowOf(prices[first].time) !== 1) { skippedNoMonday++; continue; }

    const sigma = trailingSigma(prices, first - 1, volLookback);
    const base = prices[first].open; // 月寄＝基準点
    if (!(base > 0)) continue;

    // 出口: h 番目の営業日の引け（週が短ければ最終営業日）
    const exitPos = Math.min(exitDay, idxs.length) - 1;
    const exitPx = prices[idxs[exitPos]].close;
    if (!(exitPx > 0)) continue;

    // dow → その週での営業日位置
    const posOfDow = new Map<number, number>();
    idxs.forEach((gi, pos) => {
      const d = dowOf(prices[gi].time);
      if (!posOfDow.has(d)) posOfDow.set(d, pos);
    });

    const slotRet: (number | null)[] = [];
    const slotZ: (number | null)[] = [];
    for (const s of SLOTS) {
      const pos = posOfDow.get(s.dow);
      // 出口より厳密に手前でのみ建てられる（出口当日は寄りのみ可）
      const usable =
        pos !== undefined && (pos < exitPos || (pos === exitPos && s.timing === "open"));
      if (!usable) { slotRet.push(null); slotZ.push(null); continue; }
      const bar = prices[idxs[pos!]];
      const px = s.timing === "open" ? bar.open : bar.close;
      if (!(px > 0)) { slotRet.push(null); slotZ.push(null); continue; }
      slotRet.push((exitPx / px - 1) * sgn);
      slotZ.push((Math.log(px / base) / sigma) * sgn);
    }
    if (slotRet[0] === null) continue; // 月寄が取れない週は使わない
    weeks.push({ key, slotRet, slotZ, sigma });
  }

  weeks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { weeks, skippedNoMonday };
}

// ───────────────────────── 制約集合への射影 ─────────────────────────
// {0 ≤ w_i ≤ cap, Σw ≤ budget} へのユークリッド射影。
// KKT より w = clip(v−τ, 0, cap)、τ≥0 は Σw<budget なら 0（現金が残る）。
function projectCappedBudget(v: number[], cap: number, budget: number): number[] {
  const clip = (x: number) => Math.min(cap, Math.max(0, x));
  const plain = v.map(clip);
  if (plain.reduce((s, x) => s + x, 0) <= budget + 1e-12) return plain;
  const sumAt = (tau: number) => v.reduce((s, vi) => s + clip(vi - tau), 0);
  let lo = 0;
  let hi = Math.max(...v);
  // Σ(hi)=0 になるまで上限を伸ばす保険
  for (let g = 0; g < 60 && sumAt(hi) > budget; g++) hi = hi * 2 + 1;
  for (let it = 0; it < 100; it++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > budget) lo = mid;
    else hi = mid;
  }
  return v.map((vi) => clip(vi - (lo + hi) / 2));
}

function matVec(M: number[][], v: number[]): number[] {
  return M.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
}
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function quad(S: number[][], w: number[]): number {
  return dot(w, matVec(S, w));
}

// max  μᵀw − (γ/2)·wᵀΣw   s.t. 0 ≤ w ≤ cap, Σw ≤ budget
// Σ は半正定値なので目的関数は凹。射影勾配上昇（バックトラッキング）で大域最適に収束する。
function solveKelly(
  mu: number[], S: number[][], gamma: number, cap: number, budget: number
): number[] {
  const k = mu.length;
  const obj = (w: number[]) => dot(mu, w) - (gamma / 2) * quad(S, w);
  const inits: number[][] = [
    new Array(k).fill(0),
    new Array(k).fill(Math.min(cap, budget / k)),
  ];
  let best = inits[0];
  let bestV = -Infinity;
  for (const init of inits) {
    let w = projectCappedBudget(init.slice(), cap, budget);
    let cur = obj(w);
    let lr = 1;
    for (let iter = 0; iter < 500; iter++) {
      const Sw = matVec(S, w);
      const grad = mu.map((m, i) => m - gamma * Sw[i]);
      let improved = false;
      for (let bt = 0; bt < 40; bt++) {
        const cand = projectCappedBudget(w.map((wi, i) => wi + lr * grad[i]), cap, budget);
        const cv = obj(cand);
        if (cv > cur + 1e-16) { w = cand; cur = cv; lr *= 1.3; improved = true; break; }
        lr *= 0.5;
      }
      if (!improved || lr < 1e-14) break;
    }
    if (cur > bestV) { bestV = cur; best = w; }
  }
  return best;
}

// 特異なら対角にリッジを足して逆行列を得る
function safeInverse(S: number[][]): number[][] | null {
  let inv = invertMatrix(S);
  if (inv) return inv;
  const k = S.length;
  const avg = S.reduce((s, row, i) => s + row[i], 0) / k;
  for (const lam of [0.01, 0.05, 0.1, 0.25, 0.5]) {
    inv = invertMatrix(S.map((row, i) => row.map((v, j) => (i === j ? v + lam * avg : v))));
    if (inv) return inv;
  }
  return null;
}

// ───────────────────────── 戦略の要約 ─────────────────────────

export interface StratStat {
  mean: number; // 週次平均リターン
  sd: number;
  sharpe: number; // 年率
  winRate: number;
  n: number;
  meanSlot: number; // 平均エントリー・スロット番号（0=月寄）
}

function summarize(rets: number[], slots: number[]): StratStat {
  const m = mean(rets);
  const sd = std(rets);
  return {
    mean: m,
    sd,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(WEEKS_PER_YEAR) : 0,
    winRate: rets.length ? rets.filter((r) => r > 0).length / rets.length : 0,
    n: rets.length,
    meanSlot: slots.length ? mean(slots) : 0,
  };
}

// ───────────────────────── ④ エントリーの最適停止 ─────────────────────────
// 状態 = (スロット s, 月寄比 z のビン)。価値 = そこで建てたときの出口までの期待リターン。
//   V(S−1, b) = E[R_{S−1} | b]                      … 最終候補スロット＝強制エントリー
//   V(s, b)   = max( E[R_s | b],  E[V(next(s), b')] ) … 即エントリー vs 見送り
// 標本が薄いビンは「即エントリー」に倒す（＝素朴ルールの月寄/直近スロットを既定にし、
// 証拠のある所でだけ逸脱する。ヌル較正の教訓＝最適化は必ず良く見える）。

export type EntryAction = "enter" | "wait";

export interface EntryPolicy {
  action: EntryAction[][]; // [S][N_BINS]
  value: number[][];
  imm: number[][]; // 即エントリーの期待リターン
  cont: number[][]; // 見送りの継続価値
  count: number[][];
  nFit: number;
}

interface EntryObs {
  key: string;
  slotRet: (number | null)[];
  slotZ: (number | null)[];
}

const MIN_BIN = 12;

function nextValid(o: EntryObs, s: number, S: number): number {
  for (let t = s + 1; t < S; t++) if (o.slotRet[t] !== null) return t;
  return -1;
}

function solveEntryPolicy(obs: EntryObs[], S: number): EntryPolicy {
  const action: EntryAction[][] = Array.from({ length: S }, () => new Array<EntryAction>(N_BINS).fill("enter"));
  const value: number[][] = Array.from({ length: S }, () => new Array<number>(N_BINS).fill(0));
  const imm: number[][] = Array.from({ length: S }, () => new Array<number>(N_BINS).fill(NaN));
  const cont: number[][] = Array.from({ length: S }, () => new Array<number>(N_BINS).fill(NaN));
  const count: number[][] = Array.from({ length: S }, () => new Array<number>(N_BINS).fill(0));

  // (s,bin) に属する観測を集める
  const at: EntryObs[][][] = Array.from({ length: S }, () => Array.from({ length: N_BINS }, () => [] as EntryObs[]));
  for (const o of obs) {
    for (let s = 0; s < S; s++) {
      if (o.slotRet[s] === null || o.slotZ[s] === null) continue;
      at[s][binOfZ(o.slotZ[s]!)].push(o);
    }
  }
  // 各スロットの全体平均（薄いビンのフォールバック）
  const slotMean: number[] = [];
  for (let s = 0; s < S; s++) {
    const v = obs.map((o) => o.slotRet[s]).filter((x): x is number => x !== null);
    slotMean.push(v.length ? mean(v) : 0);
  }

  for (let s = S - 1; s >= 0; s--) {
    for (let b = 0; b < N_BINS; b++) {
      const list = at[s][b];
      count[s][b] = list.length;
      const ev = list.length ? mean(list.map((o) => o.slotRet[s]!)) : slotMean[s];
      imm[s][b] = ev;
      if (s === S - 1) { value[s][b] = ev; action[s][b] = "enter"; continue; }
      // 継続価値: 各観測が次に建てうるスロットへ移ったときの V
      let cv = ev;
      if (list.length > 0) {
        let sum = 0;
        let cnt = 0;
        for (const o of list) {
          const ns = nextValid(o, s, S);
          if (ns < 0) { sum += o.slotRet[s]!; cnt++; continue; } // 次が無い＝ここで建てるしかない
          sum += value[ns][binOfZ(o.slotZ[ns]!)];
          cnt++;
        }
        if (cnt > 0) cv = sum / cnt;
      }
      cont[s][b] = cv;
      if (list.length >= MIN_BIN && cv > ev) { value[s][b] = cv; action[s][b] = "wait"; }
      else { value[s][b] = ev; action[s][b] = "enter"; }
    }
  }
  return { action, value, imm, cont, count, nFit: obs.length };
}

function applyEntryPolicy(pol: EntryPolicy, o: EntryObs, S: number): { ret: number; slot: number } | null {
  for (let s = 0; s < S; s++) {
    if (o.slotRet[s] === null || o.slotZ[s] === null) continue;
    const ns = nextValid(o, s, S);
    if (ns < 0 || pol.action[s][binOfZ(o.slotZ[s]!)] === "enter") {
      return { ret: o.slotRet[s]!, slot: s };
    }
  }
  return null;
}

// ───────────────────────── 結果の型 ─────────────────────────

export interface StockAlloc {
  ticker: string;
  name: string;
  muRaw: number; // 週次平均リターン（生）
  se: number; // その標準誤差
  muShrunk: number; // 経験ベイズ縮小後
  b: number; // 縮小係数（1=生を信じる, 0=横断コンセンサスに寄せ切る）
  sigma: number; // 週次σ
  sharpe: number; // 年率（生μ基準）
  soloKelly: number; // 単独ケリー f·μ̃/σ²（相関を無視した素朴な配分）
  weight: number; // 最適配分
}

export interface SlotStat {
  slot: number;
  label: string;
  mean: number;
  se: number; // クラスタ頑健（同一週=1クラスタ）
  t: number;
  sharpe: number;
  nObs: number;
  nWeeks: number;
  nEff: number;
}

export interface SplitPoint {
  k: number;
  mu: number;
  sigma: number;
  sharpe: number;
  ce: number; // 確実性等価 μ − (γ/2)σ²
}

export interface WeeklyAllocResult {
  ok: boolean;
  reason?: string;
  nStocks: number;
  nWeeks: number;
  from: string;
  to: string;
  skippedNoMonday: number;
  nSlots: number;
  slotLabels: string[];

  // ① 配分
  perStock: StockAlloc[];
  muGrand: number; // 横断コンセンサス（クラスタ頑健）
  muGrandSe: number;
  tau: number; // 銘柄間の真のばらつき（縮小の分子）
  rhoBar: number; // 平均ペア相関
  nEffStocks: number; // 実効銘柄数 N/(1+(N−1)ρ̄)
  exposure: number; // Σw
  cash: number; // 1−Σw
  soloSum: number; // 単独ケリーの単純合計
  overbet: number; // soloSum / exposure
  uncGross: number; // 無制約ケリー Σ|w| （推定誤差の増幅を見る）
  port: { mu: number; sigma: number; sharpe: number; growth: number }; // 週次μσ・年率Sharpe・年率成長率近似

  // ② 後知恵ギャップ
  slotStats: SlotStat[];
  bestSlot: number;
  hindsight: { best: number; monOpen: number; equalAll: number; worst: number };
  pMonBest: number;
  monVsAvg: { diff: number; se: number; t: number; nEff: number };

  // ③ 時間分散
  split: SplitPoint[];
  bestK: number;

  // ④ 待つ価値
  policy: EntryPolicy;
  waitOOS: StratStat;
  waitIS: StratStat;
  monFixed: StratStat;
  equalSplit: StratStat;
  // 「待つ − 月寄固定」の対応のある差（同一週=1クラスタ）。Sharpeの大小比較だけで判定しないための門番。
  waitVsMon: { diff: number; se: number; t: number; nEff: number };
}

export interface AllocOptions {
  side?: Side;
  exitDay?: number; // 1..5（既定=5=金曜引け）
  kellyFraction?: number; // f（既定=0.25）
  maxWeight?: number; // 1銘柄上限（既定=0.3）
  budget?: number; // 総エクスポージャー上限（既定=1.0＝レバ無し）
  muShrink?: boolean;
}

function emptyStrat(): StratStat {
  return { mean: 0, sd: 0, sharpe: 0, winRate: 0, n: 0, meanSlot: 0 };
}

// ───────────────────────── 本体 ─────────────────────────

export function computeWeeklyAllocation(
  stocks: TickerPrices[], opts: AllocOptions = {}
): WeeklyAllocResult {
  const side = opts.side ?? "long";
  const exitDay = Math.max(1, Math.min(5, opts.exitDay ?? 5));
  const f = Math.max(0.01, Math.min(1, opts.kellyFraction ?? 0.25));
  const gamma = 1 / f;
  const cap = Math.max(0.01, Math.min(1, opts.maxWeight ?? 0.3));
  const budget = Math.max(0.05, opts.budget ?? 1);
  const muShrink = opts.muShrink ?? true;
  // 出口が h 日目の引けなら、建てられるのは「h−1日目の引けまで」＋「h日目の寄り」＝ 2h−1 スロット
  const nSlots = Math.max(1, Math.min(SLOTS.length, 2 * exitDay - 1));
  const slotLabels = SLOTS.slice(0, nSlots).map((s) => s.label);

  const empty: WeeklyAllocResult = {
    ok: false, nStocks: 0, nWeeks: 0, from: "", to: "", skippedNoMonday: 0,
    nSlots, slotLabels,
    perStock: [], muGrand: 0, muGrandSe: 0, tau: 0, rhoBar: 0, nEffStocks: 0,
    exposure: 0, cash: 1, soloSum: 0, overbet: 0, uncGross: 0,
    port: { mu: 0, sigma: 0, sharpe: 0, growth: 0 },
    slotStats: [], bestSlot: 0,
    hindsight: { best: 0, monOpen: 0, equalAll: 0, worst: 0 },
    pMonBest: 0, monVsAvg: { diff: 0, se: 0, t: 0, nEff: 0 },
    split: [], bestK: 1,
    policy: solveEntryPolicy([], nSlots),
    waitOOS: emptyStrat(), waitIS: emptyStrat(), monFixed: emptyStrat(), equalSplit: emptyStrat(),
    waitVsMon: { diff: 0, se: 0, t: 0, nEff: 0 },
  };

  const usable = stocks.filter((s) => s.prices.length >= 260);
  if (usable.length < 2) return { ...empty, reason: "有効な銘柄が不足（2銘柄以上・各260本以上必要）" };

  // 各銘柄を週×スロット表に
  const built = usable.map((s) => ({
    ticker: s.ticker,
    name: s.name ?? s.ticker,
    ...buildTickerWeeks(s.prices, side, exitDay),
  }));
  const kept = built.filter((b) => b.weeks.length >= 40);
  if (kept.length < 2) return { ...empty, reason: "トレード週の取れる銘柄が不足（各40週以上必要）" };

  // 共通週（全銘柄で揃う週だけを共分散パネルに使う）
  const counts = new Map<string, number>();
  for (const b of kept) for (const w of b.weeks) counts.set(w.key, (counts.get(w.key) ?? 0) + 1);
  const commonKeys = Array.from(counts.entries())
    .filter(([, c]) => c === kept.length)
    .map(([k]) => k)
    .sort();
  if (commonKeys.length < 40) {
    return { ...empty, reason: `全銘柄で揃う週が不足（${commonKeys.length}週。40週以上必要）` };
  }
  const keyIndex = new Map(commonKeys.map((k, i) => [k, i]));
  const T = commonKeys.length;
  const K = kept.length;

  // 銘柄 × 共通週 の「基準プラン（月寄建て → exitDay引け）」リターン行列
  const R: number[][] = Array.from({ length: K }, () => new Array(T).fill(0));
  // 銘柄 × 共通週 × スロット
  const RS: (number | null)[][][] = Array.from({ length: K }, () =>
    Array.from({ length: T }, () => new Array<number | null>(nSlots).fill(null))
  );
  const ZS: (number | null)[][][] = Array.from({ length: K }, () =>
    Array.from({ length: T }, () => new Array<number | null>(nSlots).fill(null))
  );
  kept.forEach((b, i) => {
    for (const w of b.weeks) {
      const t = keyIndex.get(w.key);
      if (t === undefined) continue;
      R[i][t] = w.slotRet[0]!;
      for (let s = 0; s < nSlots; s++) { RS[i][t][s] = w.slotRet[s]; ZS[i][t][s] = w.slotZ[s]; }
    }
  });

  // ───────── ① μ の経験ベイズ縮小 ─────────
  const muRaw = R.map((r) => mean(r));
  const sdRaw = R.map((r) => std(r));
  const seRaw = sdRaw.map((s) => s / Math.sqrt(T));

  // 横断コンセンサス μ̄（銘柄×週をプールし、同一週=1クラスタでSEを頑健化）
  const poolVals: number[] = [];
  const poolKeys: string[] = [];
  for (let i = 0; i < K; i++) for (let t = 0; t < T; t++) { poolVals.push(R[i][t]); poolKeys.push(commonKeys[t]); }
  const grand = clusterStat(poolVals, poolKeys);
  const muGrand = grand ? grand.mean : mean(muRaw);
  const muGrandSe = grand ? grand.se : 0;

  // τ² = 銘柄間分散 − 平均推定分散（負なら0＝銘柄差は全部ノイズ）
  const crossVar = K > 1
    ? muRaw.reduce((s, m) => s + (m - mean(muRaw)) ** 2, 0) / (K - 1)
    : 0;
  const avgSe2 = mean(seRaw.map((s) => s * s));
  const tau2 = Math.max(0, crossVar - avgSe2);
  const tau = Math.sqrt(tau2);
  const bShrink = seRaw.map((se) => (muShrink ? (tau2 > 0 ? tau2 / (tau2 + se * se) : 0) : 1));
  const muTilde = muRaw.map((m, i) => muGrand + bShrink[i] * (m - muGrand));

  // ───────── ① Σ（Ledoit-Wolf 収縮）と実効銘柄数 ─────────
  const { cov: Sigma } = ledoitWolf(R, muRaw);
  let rhoSum = 0;
  let rhoN = 0;
  for (let a = 0; a < K; a++) {
    for (let b = a + 1; b < K; b++) {
      const d = Math.sqrt(Math.max(Sigma[a][a], 1e-18) * Math.max(Sigma[b][b], 1e-18));
      if (d > 0) { rhoSum += Sigma[a][b] / d; rhoN++; }
    }
  }
  const rhoBar = rhoN > 0 ? rhoSum / rhoN : 0;
  const rhoDenom = 1 + (K - 1) * rhoBar;
  const nEffStocks = rhoDenom > 1e-6 ? Math.min(K, K / rhoDenom) : K;

  // ───────── ① ケリー配分 ─────────
  const w = solveKelly(muTilde, Sigma, gamma, cap, budget);
  const exposure = w.reduce((s, x) => s + x, 0);
  const soloKelly = muTilde.map((m, i) => {
    const v = Math.max(Sigma[i][i], 1e-18);
    return Math.max(0, (f * m) / v);
  });
  const soloSum = soloKelly.reduce((s, x) => s + x, 0);

  const inv = safeInverse(Sigma);
  const uncGross = inv
    ? matVec(inv, muTilde).reduce((s, x) => s + Math.abs(f * x), 0)
    : 0;

  const portMu = dot(muTilde, w);
  const portSd = Math.sqrt(Math.max(quad(Sigma, w), 0));
  const port = {
    mu: portMu,
    sigma: portSd,
    sharpe: portSd > 0 ? (portMu / portSd) * Math.sqrt(WEEKS_PER_YEAR) : 0,
    growth: (portMu - (portSd * portSd) / 2) * WEEKS_PER_YEAR,
  };

  const perStock: StockAlloc[] = kept.map((b, i) => ({
    ticker: b.ticker,
    name: b.name,
    muRaw: muRaw[i],
    se: seRaw[i],
    muShrunk: muTilde[i],
    b: bShrink[i],
    sigma: Math.sqrt(Math.max(Sigma[i][i], 0)),
    sharpe: sdRaw[i] > 0 ? (muRaw[i] / sdRaw[i]) * Math.sqrt(WEEKS_PER_YEAR) : 0,
    soloKelly: soloKelly[i],
    weight: w[i],
  }));

  // ───────── ② スロット別の統計と後知恵ギャップ ─────────
  const slotStats: SlotStat[] = [];
  for (let s = 0; s < nSlots; s++) {
    const vals: number[] = [];
    const keys: string[] = [];
    for (let i = 0; i < K; i++) for (let t = 0; t < T; t++) {
      const v = RS[i][t][s];
      if (v !== null) { vals.push(v); keys.push(commonKeys[t]); }
    }
    const cs = clusterStat(vals, keys);
    const m = mean(vals);
    const sd = std(vals);
    slotStats.push({
      slot: s,
      label: slotLabels[s],
      mean: cs ? cs.mean : m,
      se: cs ? cs.se : 0,
      t: cs && cs.se > 0 ? cs.mean / cs.se : 0,
      sharpe: sd > 0 ? (m / sd) * Math.sqrt(WEEKS_PER_YEAR) : 0,
      nObs: vals.length,
      nWeeks: cs ? cs.nDays : 0,
      nEff: cs ? cs.nEff : 0,
    });
  }
  let bestSlot = 0;
  for (let s = 1; s < nSlots; s++) if (slotStats[s].sharpe > slotStats[bestSlot].sharpe) bestSlot = s;

  // 各(銘柄,週)での 完全予見の最良/最悪・月寄・全スロット等分
  const hBest: number[] = [];
  const hWorst: number[] = [];
  const hMon: number[] = [];
  const hEq: number[] = [];
  const diffVals: number[] = [];
  const diffKeys: string[] = [];
  let monBest = 0;
  let monCases = 0;
  for (let i = 0; i < K; i++) {
    for (let t = 0; t < T; t++) {
      const avail = RS[i][t].filter((x): x is number => x !== null);
      if (avail.length < 2 || RS[i][t][0] === null) continue;
      const mo = RS[i][t][0]!;
      const eq = mean(avail);
      hBest.push(Math.max(...avail));
      hWorst.push(Math.min(...avail));
      hMon.push(mo);
      hEq.push(eq);
      diffVals.push(mo - eq);
      diffKeys.push(commonKeys[t]);
      monCases++;
      if (mo >= Math.max(...avail) - 1e-12) monBest++;
    }
  }
  const dcs = clusterStat(diffVals, diffKeys);
  const monVsAvg = {
    diff: dcs ? dcs.mean : mean(diffVals),
    se: dcs ? dcs.se : 0,
    t: dcs && dcs.se > 0 ? dcs.mean / dcs.se : 0,
    nEff: dcs ? dcs.nEff : 0,
  };

  // ───────── ③ 時間分散 k 掃引 ─────────
  // 週ごとに「全銘柄等加重 × 先頭 k スロット等分」の実現リターン系列を作り、CE(k) を比べる
  const split: SplitPoint[] = [];
  for (let k = 1; k <= nSlots; k++) {
    const series: number[] = [];
    for (let t = 0; t < T; t++) {
      const perStockRet: number[] = [];
      for (let i = 0; i < K; i++) {
        const av = RS[i][t].slice(0, k).filter((x): x is number => x !== null);
        if (av.length > 0) perStockRet.push(mean(av));
      }
      if (perStockRet.length > 0) series.push(mean(perStockRet));
    }
    const m = mean(series);
    const sd = std(series);
    split.push({
      k,
      mu: m,
      sigma: sd,
      sharpe: sd > 0 ? (m / sd) * Math.sqrt(WEEKS_PER_YEAR) : 0,
      ce: m - (gamma / 2) * sd * sd,
    });
  }
  let bestK = 1;
  for (let k = 2; k <= nSlots; k++) if (split[k - 1].ce > split[bestK - 1].ce) bestK = k;

  // ───────── ④ 待つ価値（エントリー最適停止・インターリーブ2分割OOS） ─────────
  const obs: EntryObs[] = [];
  for (let t = 0; t < T; t++) {
    for (let i = 0; i < K; i++) {
      if (RS[i][t][0] === null) continue;
      obs.push({ key: commonKeys[t], slotRet: RS[i][t], slotZ: ZS[i][t] });
    }
  }
  // 週単位で2分割（同一週を学習と検定に跨がせない＝横断相関の漏れを断つ）
  const evenWeek = new Set(commonKeys.filter((_, t) => t % 2 === 0));
  const trainA = obs.filter((o) => evenWeek.has(o.key));
  const trainB = obs.filter((o) => !evenWeek.has(o.key));
  const polFull = solveEntryPolicy(obs, nSlots);
  const polA = solveEntryPolicy(trainA, nSlots);
  const polB = solveEntryPolicy(trainB, nSlots);

  const oosR: number[] = [];
  const oosS: number[] = [];
  const isR: number[] = [];
  const isS: number[] = [];
  const monR: number[] = [];
  const eqR: number[] = [];
  const wvmVals: number[] = [];
  const wvmKeys: string[] = [];
  for (const o of obs) {
    const pol = evenWeek.has(o.key) ? polB : polA; // 相手ブロックの方策を適用
    const a = applyEntryPolicy(pol, o, nSlots);
    if (a) { oosR.push(a.ret); oosS.push(a.slot); }
    const b = applyEntryPolicy(polFull, o, nSlots);
    if (b) { isR.push(b.ret); isS.push(b.slot); }
    if (o.slotRet[0] !== null) monR.push(o.slotRet[0]!);
    const av = o.slotRet.filter((x): x is number => x !== null);
    if (av.length) eqR.push(mean(av));
    // 同一(銘柄,週)での対応のある差。Sharpeの大小だけで「待ちが勝った」と言わないための検定。
    if (a && o.slotRet[0] !== null) { wvmVals.push(a.ret - o.slotRet[0]!); wvmKeys.push(o.key); }
  }
  const wcs = clusterStat(wvmVals, wvmKeys);
  const waitVsMon = {
    diff: wcs ? wcs.mean : mean(wvmVals),
    se: wcs ? wcs.se : 0,
    t: wcs && wcs.se > 0 ? wcs.mean / wcs.se : 0,
    nEff: wcs ? wcs.nEff : 0,
  };

  return {
    ok: true,
    nStocks: K,
    nWeeks: T,
    from: commonKeys[0],
    to: commonKeys[commonKeys.length - 1],
    skippedNoMonday: built.reduce((s, b) => s + b.skippedNoMonday, 0),
    nSlots,
    slotLabels,
    perStock,
    muGrand, muGrandSe, tau,
    rhoBar, nEffStocks,
    exposure, cash: Math.max(0, 1 - exposure),
    soloSum, overbet: exposure > 1e-9 ? soloSum / exposure : 0,
    uncGross,
    port,
    slotStats, bestSlot,
    hindsight: {
      best: mean(hBest), monOpen: mean(hMon), equalAll: mean(hEq), worst: mean(hWorst),
    },
    pMonBest: monCases > 0 ? monBest / monCases : 0,
    monVsAvg,
    split, bestK,
    policy: polFull,
    waitOOS: summarize(oosR, oosS),
    waitIS: summarize(isR, isS),
    monFixed: summarize(monR, monR.map(() => 0)),
    equalSplit: summarize(eqR, eqR.map(() => (nSlots - 1) / 2)),
    waitVsMon,
  };
}
