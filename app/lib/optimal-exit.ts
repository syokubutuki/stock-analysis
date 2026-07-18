// ① 状態依存の最適手仕舞い：月曜Openで建てた後、いつ降りるか
// -------------------------------------------------------------------------------
// 「週後半リターンを1発で当てる」ではなく、状態上の最適停止問題として解く。
// 各週、指定タイミング(既定=月曜Open)で建て、以降の各営業日の引けで「手仕舞う/続ける」を選ぶ。
// 状態 = (保有日数 h, ボラ単位の含み損益 z)。z = 建値からの累積対数リターン / 建玉時σ。
// σ で標準化することで、高ボラ週も低ボラ週も同じ物差しに載る（レジーム非依存の方策になる）。
//
// 価値関数を後退帰納法で解く（当てるのは「リターン」ではなく「価値関数」）:
//   V(H, z)   = z                         … 金曜引け=強制手仕舞い（実現 z）
//   V(h, z)   = max( z, E[V(h+1, z') | h, z] )   … 即時手仕舞い vs 継続
// 継続価値 E[·] は過去の全トレード週から経験的に推定する（(h,z)ビンの遷移を数える）。
// これにより各保有日の停止境界 z*(h) が出る。利確側(zが高い)と損切り側(zが低い)の
// 両方の境界がデータから内生的に立ち上がる（モメンタムなら「伸ばす」、平均回帰なら「早降り」）。
//
// 過剰最適化を避けるため、方策の評価はインターリーブ2分割で行う（偶数週で学習→奇数週で検定、
// および逆）。ヌル較正で学んだとおり、in-sample の停止方策は必ず良く見えるため。

import { PricePoint } from "./types";
import { mean, std } from "./stats-significance";

export type ExitSide = "long" | "short";
export type EntryTiming = "open" | "close";

// ---------------------------------------------------------------
// トレード週の構築
// ---------------------------------------------------------------
export interface TradeWeek {
  entryTime: string;
  entryPrice: number;
  sigma: number; // 建玉時の日次σ（対数リターン標準偏差）
  // 各保有日 h(1..L) の引けにおける z（ボラ単位の含み損益）と生リターン
  z: number[]; // 長さ L
  ret: number[]; // 単純リターン（side適用後）長さ L
  weekIdx: number;
}

const H_MAX = 5;

// 週境界: 曜日が前日以下 → 新しい週（祝日で月曜が飛んでも頑健）
function weekIds(prices: PricePoint[]): number[] {
  const n = prices.length;
  const dow = prices.map((p) => new Date(p.time).getDay());
  const ids = new Array(n);
  let w = -1;
  for (let i = 0; i < n; i++) {
    if (i === 0 || dow[i] <= dow[i - 1]) w++;
    ids[i] = w;
  }
  return ids;
}

// 建玉時の日次σ: 直前 lookback 本の対数リターン標準偏差
function trailingSigma(prices: PricePoint[], entryIdx: number, lookback = 20): number {
  const rs: number[] = [];
  for (let i = Math.max(1, entryIdx - lookback + 1); i <= entryIdx; i++) {
    const a = prices[i - 1].close;
    const b = prices[i].close;
    if (a > 0 && b > 0) rs.push(Math.log(b / a));
  }
  const s = std(rs);
  return s > 0 ? s : 0.01;
}

export interface BuildOptions {
  entryDow?: number; // 建て曜日（既定=1=月）
  entryTiming?: EntryTiming; // 既定=open
  side?: ExitSide;
  volLookback?: number;
}

export function buildTradeWeeks(prices: PricePoint[], opts: BuildOptions = {}): TradeWeek[] {
  const entryDow = opts.entryDow ?? 1;
  const entryTiming = opts.entryTiming ?? "open";
  const side = opts.side ?? "long";
  const volLookback = opts.volLookback ?? 20;
  const sgn = side === "long" ? 1 : -1;

  const n = prices.length;
  const ids = weekIds(prices);
  const dow = prices.map((p) => new Date(p.time).getDay());

  // 週ごとの営業日インデックス
  const byWeek = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const arr = byWeek.get(ids[i]);
    if (arr) arr.push(i);
    else byWeek.set(ids[i], [i]);
  }

  const weeks: TradeWeek[] = [];
  for (const [wIdx, idxs] of byWeek) {
    // 建て日: その週で entryDow に一致する最初の営業日（無ければ週の初日）
    let entryPos = idxs.findIndex((i) => dow[i] === entryDow);
    if (entryPos < 0) entryPos = 0;
    const entryIdx = idxs[entryPos];
    if (entryIdx < volLookback) continue; // σ推定に履歴不足

    const entryPrice = entryTiming === "open" ? prices[entryIdx].open : prices[entryIdx].close;
    if (!(entryPrice > 0)) continue;
    const sigma = trailingSigma(prices, entryIdx, volLookback);

    // 保有ノード: 建て日の引け以降、その週の各営業日の引け（最大 H_MAX ノード）
    const z: number[] = [];
    const ret: number[] = [];
    for (let k = entryPos; k < idxs.length && z.length < H_MAX; k++) {
      const c = prices[idxs[k]].close;
      if (!(c > 0)) break;
      const logr = Math.log(c / entryPrice) * sgn;
      z.push(logr / sigma);
      ret.push((c / entryPrice - 1) * sgn);
    }
    if (z.length >= 1) {
      weeks.push({ entryTime: prices[entryIdx].time, entryPrice, sigma, z, ret, weekIdx: wIdx });
    }
  }
  weeks.sort((a, b) => a.weekIdx - b.weekIdx);
  return weeks;
}

// ---------------------------------------------------------------
// z ビン
// ---------------------------------------------------------------
const Z_MAX = 4;
const N_BINS = 16; // 幅 0.5σ
const BIN_W = (2 * Z_MAX) / N_BINS;

export function binOfZ(z: number): number {
  let b = Math.floor((z + Z_MAX) / BIN_W);
  if (b < 0) b = 0;
  if (b >= N_BINS) b = N_BINS - 1;
  return b;
}
export function binCenter(b: number): number {
  return -Z_MAX + (b + 0.5) * BIN_W;
}

// ---------------------------------------------------------------
// 後退帰納法で方策を解く
// ---------------------------------------------------------------
export type Action = "exit" | "hold";

export interface Policy {
  // policy[h-1][bin] : 保有日 h(1..H_MAX)・ビン bin での行動
  action: Action[][]; // [H_MAX][N_BINS]
  value: number[][]; // V(h,bin)（z単位）
  exitVal: number[][]; // 即時手仕舞い価値（z単位）
  contVal: number[][]; // 継続価値（z単位）
  count: number[][]; // 各(h,bin)の標本数
  // 停止境界: 各保有日で「利確側=これ以上なら降りる下限z」「損切り側=これ以下なら降りるz上限」
  tpBoundary: (number | null)[]; // 長さ H_MAX
  slBoundary: (number | null)[];
  nWeeksFit: number;
}

// 疎なビンでの過学習を防ぐ最小標本数。これ未満のビンは「継続」に倒す（exit させない）。
const MIN_BIN = 8;

// 学習週集合から DP を解く
function solvePolicy(weeks: TradeWeek[]): Policy {
  const action: Action[][] = Array.from({ length: H_MAX }, () => new Array<Action>(N_BINS).fill("hold"));
  const value: number[][] = Array.from({ length: H_MAX }, () => new Array<number>(N_BINS).fill(0));
  const exitVal: number[][] = Array.from({ length: H_MAX }, () => new Array<number>(N_BINS).fill(NaN));
  const contVal: number[][] = Array.from({ length: H_MAX }, () => new Array<number>(N_BINS).fill(NaN));
  const count: number[][] = Array.from({ length: H_MAX }, () => new Array<number>(N_BINS).fill(0));

  // 各(h,bin)に属する週の z を集める（h は1-indexed → 配列は h-1）
  const zAt: number[][][] = Array.from({ length: H_MAX }, () => Array.from({ length: N_BINS }, () => [] as number[]));
  // 継続用: (h,bin) の週が h+1 でどのビンに移るか
  const nextBin: number[][][] = Array.from({ length: H_MAX }, () => Array.from({ length: N_BINS }, () => [] as number[]));

  for (const w of weeks) {
    const L = w.z.length;
    for (let h = 1; h <= Math.min(L, H_MAX); h++) {
      const b = binOfZ(w.z[h - 1]);
      zAt[h - 1][b].push(w.z[h - 1]);
      if (h < L && h < H_MAX) nextBin[h - 1][b].push(binOfZ(w.z[h]));
    }
  }

  // 終端 h=H_MAX: 強制手仕舞い
  for (let b = 0; b < N_BINS; b++) {
    const zs = zAt[H_MAX - 1][b];
    count[H_MAX - 1][b] = zs.length;
    const ev = zs.length ? mean(zs) : binCenter(b);
    exitVal[H_MAX - 1][b] = ev;
    value[H_MAX - 1][b] = ev;
    action[H_MAX - 1][b] = "exit";
  }

  // 後退帰納 h = H_MAX-1 .. 1
  for (let h = H_MAX - 1; h >= 1; h--) {
    for (let b = 0; b < N_BINS; b++) {
      const zs = zAt[h - 1][b];
      count[h - 1][b] = zs.length;
      const ev = zs.length ? mean(zs) : binCenter(b);
      exitVal[h - 1][b] = ev;
      // 継続価値: このビンの週が h+1 で移った先の V の平均
      const nexts = nextBin[h - 1][b];
      let cv: number;
      if (nexts.length > 0) {
        let s = 0;
        for (const nb of nexts) s += value[h][nb];
        cv = s / nexts.length;
      } else {
        cv = ev; // 継続先が観測されない → 継続の旨みは無いとみなす
      }
      contVal[h - 1][b] = cv;
      // 標本が薄いビンは exit 判定を信頼できない → 継続に倒す（過学習・孤立ノイズ排除）。
      if (zs.length >= MIN_BIN && ev >= cv) {
        value[h - 1][b] = ev;
        action[h - 1][b] = "exit";
      } else {
        value[h - 1][b] = Math.max(cv, zs.length >= MIN_BIN ? ev : -Infinity);
        action[h - 1][b] = "hold";
      }
    }
  }

  // 停止境界の抽出（各保有日）
  const tpBoundary: (number | null)[] = new Array(H_MAX).fill(null);
  const slBoundary: (number | null)[] = new Array(H_MAX).fill(null);
  for (let h = 1; h <= H_MAX; h++) {
    // 利確側: 上位ビンから下りて、exit が続く最下限 z
    let tp: number | null = null;
    for (let b = N_BINS - 1; b >= N_BINS / 2; b--) {
      if (action[h - 1][b] === "exit" && count[h - 1][b] > 0) tp = binCenter(b) - BIN_W / 2;
      else break;
    }
    // 損切り側: 下位ビンから上って、exit が続く最上限 z
    let sl: number | null = null;
    for (let b = 0; b < N_BINS / 2; b++) {
      if (action[h - 1][b] === "exit" && count[h - 1][b] > 0) sl = binCenter(b) + BIN_W / 2;
      else break;
    }
    if (h < H_MAX) {
      tpBoundary[h - 1] = tp;
      slBoundary[h - 1] = sl;
    }
  }

  return {
    action, value, exitVal, contVal, count, tpBoundary, slBoundary,
    nWeeksFit: weeks.length,
  };
}

// 方策を1週に適用して実現リターンを得る
function applyPolicy(policy: Policy, w: TradeWeek): { ret: number; heldDays: number; z: number } {
  const L = w.z.length;
  for (let h = 1; h <= L; h++) {
    if (h >= L || h >= H_MAX) {
      // 最終ノード=強制手仕舞い
      return { ret: w.ret[h - 1], heldDays: h, z: w.z[h - 1] };
    }
    const b = binOfZ(w.z[h - 1]);
    if (policy.action[h - 1][b] === "exit") {
      return { ret: w.ret[h - 1], heldDays: h, z: w.z[h - 1] };
    }
  }
  const last = L - 1;
  return { ret: w.ret[last], heldDays: L, z: w.z[last] };
}

// ---------------------------------------------------------------
// 戦略の要約
// ---------------------------------------------------------------
export interface StratStat {
  meanRet: number;
  sharpe: number; // トレード単位（年率=×√52）
  winRate: number;
  meanHeld: number;
  meanZ: number;
  n: number;
}

function summarize(rets: number[], helds: number[], zs: number[]): StratStat {
  const m = mean(rets);
  const sd = std(rets);
  return {
    meanRet: m,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(52) : 0,
    winRate: rets.length ? rets.filter((r) => r > 0).length / rets.length : 0,
    meanHeld: helds.length ? mean(helds) : 0,
    meanZ: zs.length ? mean(zs) : 0,
    n: rets.length,
  };
}

export interface OptimalExitResult {
  ok: boolean;
  reason?: string;
  policy: Policy; // 全データで学習した方策（可視化用）
  // 戦略比較（インターリーブ2分割のOOS）
  optimalOOS: StratStat;
  holdToEnd: StratStat; // 常に金曜引けまで
  exitDay1: StratStat; // 建て日引けで即降り
  // 参考: in-sample の最適方策（過剰最適化の目安）
  optimalIS: StratStat;
  nWeeks: number;
  from: string;
  to: string;
  side: ExitSide;
}

export function computeOptimalExit(prices: PricePoint[], opts: BuildOptions = {}): OptimalExitResult {
  const side = opts.side ?? "long";
  const weeks = buildTradeWeeks(prices, opts);

  const emptyPolicy = solvePolicy([]);
  const empty: OptimalExitResult = {
    ok: false,
    policy: emptyPolicy,
    optimalOOS: summarize([], [], []),
    holdToEnd: summarize([], [], []),
    exitDay1: summarize([], [], []),
    optimalIS: summarize([], [], []),
    nWeeks: weeks.length,
    from: prices[0]?.time ?? "",
    to: prices[prices.length - 1]?.time ?? "",
    side,
  };
  if (weeks.length < 60) return { ...empty, reason: `トレード週が不足（${weeks.length}週。60週以上必要）` };

  // 全データ方策（表示用）
  const fullPolicy = solvePolicy(weeks);

  // インターリーブ2分割OOS: 偶数週で学習→奇数週で検定、逆も。過剰最適化を排して評価。
  const even = weeks.filter((_, i) => i % 2 === 0);
  const odd = weeks.filter((_, i) => i % 2 === 1);
  const polEven = solvePolicy(even);
  const polOdd = solvePolicy(odd);

  const oosRet: number[] = [];
  const oosHeld: number[] = [];
  const oosZ: number[] = [];
  const isRet: number[] = [];
  const isHeld: number[] = [];
  const isZ: number[] = [];
  const holdRet: number[] = [];
  const holdHeld: number[] = [];
  const holdZ: number[] = [];
  const d1Ret: number[] = [];
  const d1Held: number[] = [];
  const d1Z: number[] = [];

  weeks.forEach((w, i) => {
    // OOS: そのブロックの相手方策を適用
    const oosPol = i % 2 === 0 ? polOdd : polEven;
    const o = applyPolicy(oosPol, w);
    oosRet.push(o.ret); oosHeld.push(o.heldDays); oosZ.push(o.z);
    // IS: 全データ方策（過剰最適化の目安）
    const is = applyPolicy(fullPolicy, w);
    isRet.push(is.ret); isHeld.push(is.heldDays); isZ.push(is.z);
    // ベースライン: 常に最終ノードまで
    const last = w.z.length - 1;
    holdRet.push(w.ret[last]); holdHeld.push(w.z.length); holdZ.push(w.z[last]);
    // ベースライン: 建て日引けで即降り
    d1Ret.push(w.ret[0]); d1Held.push(1); d1Z.push(w.z[0]);
  });

  return {
    ok: true,
    policy: fullPolicy,
    optimalOOS: summarize(oosRet, oosHeld, oosZ),
    holdToEnd: summarize(holdRet, holdHeld, holdZ),
    exitDay1: summarize(d1Ret, d1Held, d1Z),
    optimalIS: summarize(isRet, isHeld, isZ),
    nWeeks: weeks.length,
    from: prices[0].time,
    to: prices[prices.length - 1].time,
    side,
  };
}

export const OPTIMAL_EXIT_CONST = { H_MAX, N_BINS, Z_MAX, BIN_W };
