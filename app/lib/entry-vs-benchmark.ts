// 週次エントリー戦略 vs Buy&Hold ── 「エントリー戦略だけが違う」条件での比較
// -------------------------------------------------------------------------------
// 銘柄・エントリー日・保有期間・資金配分をすべて同一に固定し、**週内のどこで建てるか**だけを
// 変えた戦略群を、同じ資金曲線の土俵で比べる。比較対象:
//   Buy&Hold（同一配分で持ちっぱなし）… ベンチマーク
//   毎週固定エントリー（月寄）        … 現行ルール
//   ランダムエントリー                … 「タイミングを選ばない」対照。M本の経路の中央値
//   週内均等エントリー                … 時間分散
//   完全後知恵 Best                   … 到達不能な上限（先読みあり）
//   最悪タイミング Worst              … 到達不能な下限（先読みあり）
//
// Best/Worst を必ず並べるのは、Fixed が Buy&Hold に勝ったとしても、それが
// 「Best〜Worst のどのあたりか」を見ないと勝ちの意味が分からないため。
// 全レンジの中で Fixed が Random の中央値付近にいるなら、それは実力ではなく引きの問題。
//
// 分解: 総リターンを 市場（床）/ 銘柄選択 / 資金配分 / エントリータイミング に加法分解する。
// 対数リターンで入れ子のベンチマーク列を作れば厳密に加法になる:
//   ln(1+R_strategy) = ln(1+R_market)
//                    + [ln(1+R_ewBH) − ln(1+R_market)]   … 銘柄選択（この銘柄群を選んだこと）
//                    + [ln(1+R_wBH)  − ln(1+R_ewBH)]     … 資金配分（加重と現金比率）
//                    + [ln(1+R_strat) − ln(1+R_wBH)]     … エントリータイミング
//
// 再利用: buildPanel / computeWeeklyAllocation（weekly-allocation.ts）、clusterStat
//         （intraday-basket.ts）、blockBootstrapCI（stats-significance.ts）、
//         studentTwoSidedP（us-spillover-core.ts）。

import { PricePoint } from "./types";
import { mean, std, blockBootstrapCI } from "./stats-significance";
import { clusterStat } from "./intraday-basket";
import { studentTwoSidedP } from "./us-spillover-core";
import {
  buildPanel, computeWeeklyAllocation, AllocPanel, AllocOptions, TickerPrices, Side,
} from "./weekly-allocation";

const WEEKS_PER_YEAR = 52;

export type StrategyKey = "bh" | "fixed" | "random" | "equal" | "best" | "worst";

export const STRATEGY_LABEL: Record<StrategyKey, string> = {
  bh: "Buy&Hold（同一配分）",
  fixed: "毎週固定エントリー（月寄）",
  random: "ランダムエントリー（中央値）",
  equal: "週内均等エントリー",
  best: "完全後知恵 Best（到達不能）",
  worst: "最悪タイミング Worst（下限）",
};

export const STRATEGY_NOTE: Record<StrategyKey, string> = {
  bh: "同じ配分で買ったら降りない。エントリー判断をしない対照",
  fixed: "毎週 月曜の寄付で建て、指定した出口で降りる",
  random: "毎週その週の有効スロットから一様乱数で選ぶ。M本の経路の中央Sharpe経路",
  equal: "毎週その週の全スロットに資金を等分して建てる",
  best: "その週で最も良かったスロットを事後に選ぶ。先読みありの上限",
  worst: "その週で最も悪かったスロットを事後に選ぶ。先読みありの下限",
};

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────── 成績指標 ─────────────────────────

export interface PerfStat {
  totalReturn: number;
  cagr: number;
  vol: number; // 年率
  sharpe: number;
  sortino: number;
  calmar: number;
  maxDD: number; // 負値
  winRate: number; // 週勝率
  profitFactor: number;
  avgWin: number;
  avgLoss: number; // 負値
  nTrades: number; // 建玉回数（銘柄×週×スロット）
  turnover: number; // 年間回転率（往復売買代金 / 資産）
  nWeeks: number;
  equity: number[]; // 資金曲線（初期1.0）
}

function maxDrawdown(equity: number[]): number {
  let peak = equity[0] ?? 1;
  let worst = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? v / peak - 1 : 0;
    if (dd < worst) worst = dd;
  }
  return worst;
}

function perf(rets: number[], nTrades: number, turnover: number): PerfStat {
  const T = rets.length;
  const equity: number[] = [1];
  for (const r of rets) equity.push(equity[equity.length - 1] * (1 + r));
  const total = equity[equity.length - 1] - 1;
  const years = T / WEEKS_PER_YEAR;
  const m = mean(rets);
  const sd = std(rets);
  const dn = Math.sqrt(mean(rets.map((r) => (r < 0 ? r * r : 0))));
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r < 0);
  const gross = wins.reduce((s, r) => s + r, 0);
  const bad = -losses.reduce((s, r) => s + r, 0);
  const dd = maxDrawdown(equity);
  const cagr = years > 0 && equity[equity.length - 1] > 0
    ? Math.pow(equity[equity.length - 1], 1 / years) - 1
    : 0;
  return {
    totalReturn: total,
    cagr,
    vol: sd * Math.sqrt(WEEKS_PER_YEAR),
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(WEEKS_PER_YEAR) : 0,
    sortino: dn > 0 ? (m / dn) * Math.sqrt(WEEKS_PER_YEAR) : 0,
    calmar: dd < 0 ? cagr / Math.abs(dd) : 0,
    maxDD: dd,
    winRate: T > 0 ? wins.length / T : 0,
    profitFactor: bad > 0 ? gross / bad : gross > 0 ? Infinity : 0,
    avgWin: wins.length ? mean(wins) : 0,
    avgLoss: losses.length ? mean(losses) : 0,
    nTrades,
    turnover,
    nWeeks: T,
    equity,
  };
}

// ───────────────────────── 差分検定 ─────────────────────────

export interface DiffTest {
  diff: number; // 週次平均リターン差（戦略 − ベンチマーク）
  ciLo: number; // 95%CI（ブロック・ブートストラップ）
  ciHi: number;
  stable: number; // ブートストラップで符号が一致した割合
  t: number; // クラスタ頑健t（銘柄×週プール、同一週=1クラスタ）
  p: number;
  nEff: number;
  cohensD: number; // 効果量（週次差の標準化）
  annualDiff: number; // 年率換算の差
}

function emptyDiff(): DiffTest {
  return { diff: 0, ciLo: 0, ciHi: 0, stable: 0, t: 0, p: 1, nEff: 0, cohensD: 0, annualDiff: 0 };
}

// 週次のポートフォリオ差系列（CI・効果量）と、銘柄×週の対応差（クラスタ頑健t）を併用する。
// ポートフォリオ系列は1週=1観測なのでクラスタが効かず、逆に銘柄×週は横断相関で過大有意になる。
// 両方を出して読み手に判断させる。
function diffTest(
  portDiff: number[], tradeDiff: number[], tradeKeys: string[]
): DiffTest {
  if (portDiff.length < 5) return emptyDiff();
  const m = mean(portDiff);
  const sd = std(portDiff);
  const ci = blockBootstrapCI(portDiff, 800);
  const cs = clusterStat(tradeDiff, tradeKeys);
  const t = cs && cs.se > 0 ? cs.mean / cs.se : 0;
  const df = Math.max(1, (cs ? cs.nDays : portDiff.length) - 1);
  return {
    diff: m,
    ciLo: ci ? ci.lo : 0,
    ciHi: ci ? ci.hi : 0,
    stable: ci ? ci.stable : 0,
    t,
    p: studentTwoSidedP(t, df),
    nEff: cs ? cs.nEff : 0,
    cohensD: sd > 0 ? m / sd : 0,
    annualDiff: m * WEEKS_PER_YEAR,
  };
}

// ───────────────────────── 戦略ごとの週次リターン ─────────────────────────

interface Series {
  port: number[]; // 週次ポートフォリオ・リターン
  trade: number[]; // 銘柄×週の建玉リターン（重み適用前の生リターン）
  keys: string[]; // trade と同じ順序の週キー
  nTrades: number;
  avgSlots: number; // 1建玉あたりの平均スロット数（均等分割は>1）
}

type SlotPick = (i: number, t: number, valid: number[]) => number[] | null;

// スロット選択規則からポートフォリオ系列を作る。valid はその週に建てられるスロット番号。
function buildSeries(panel: AllocPanel, w: number[], pick: SlotPick): Series {
  const K = panel.stocks.length;
  const T = panel.commonKeys.length;
  const port: number[] = [];
  const trade: number[] = [];
  const keys: string[] = [];
  let nTrades = 0;
  let slotSum = 0;
  for (let t = 0; t < T; t++) {
    let r = 0;
    for (let i = 0; i < K; i++) {
      const valid: number[] = [];
      for (let s = 0; s < panel.nSlots; s++) if (panel.RS[i][t][s] !== null) valid.push(s);
      if (valid.length === 0) continue;
      const chosen = pick(i, t, valid);
      if (!chosen || chosen.length === 0) continue;
      const ret = mean(chosen.map((s) => panel.RS[i][t][s]!));
      r += w[i] * ret;
      trade.push(ret);
      keys.push(panel.commonKeys[t]);
      nTrades++;
      slotSum += chosen.length;
    }
    port.push(r);
  }
  return { port, trade, keys, nTrades, avgSlots: nTrades > 0 ? slotSum / nTrades : 0 };
}

// Buy&Hold は週内のスロットではなく「月寄→翌週月寄」の連鎖。複利すると実際の持ちっぱなしと一致。
function buildBH(panel: AllocPanel, w: number[]): Series {
  const K = panel.stocks.length;
  const T = panel.commonKeys.length;
  const port: number[] = [];
  const trade: number[] = [];
  const keys: string[] = [];
  for (let t = 0; t < T; t++) {
    let r = 0;
    for (let i = 0; i < K; i++) {
      const v = panel.BH[i][t];
      if (v === null) continue;
      r += w[i] * v;
      trade.push(v);
      keys.push(panel.commonKeys[t]);
    }
    port.push(r);
  }
  // 建玉は最初の1回だけ（K銘柄）
  return { port, trade, keys, nTrades: K, avgSlots: 1 };
}

// ───────────────────────── 分解 ─────────────────────────

export interface Attribution {
  ok: boolean;
  years: number;
  // 年率対数寄与（合計が戦略の年率対数リターンに一致する）
  market: number;
  selection: number;
  allocation: number;
  timing: number;
  total: number;
  // 各層の資金曲線（年率対数リターン算出の元）
  marketAnnual: number; // 単利換算の参考値
  ewBhAnnual: number;
  wBhAnnual: number;
  stratAnnual: number;
  hasMarket: boolean;
  dominant: "market" | "selection" | "allocation" | "timing";
}

function logAnnual(rets: number[], years: number): number {
  if (years <= 0) return 0;
  let acc = 0;
  for (const r of rets) acc += Math.log(Math.max(1e-9, 1 + r));
  return acc / years;
}

// ───────────────────────── 結果 ─────────────────────────

export interface StrategyRow {
  key: StrategyKey;
  label: string;
  note: string;
  perf: PerfStat;
  diff: DiffTest; // vs Buy&Hold（同一配分）
  // ランダムのみ: M本の経路の散らばり
  spread?: { cagrLo: number; cagrHi: number; sharpeLo: number; sharpeHi: number; m: number };
  // Best〜Worst のレンジ内での位置（0=Worst, 1=Best）
  rankInRange: number;
}

export interface EntryVsBenchmarkResult {
  ok: boolean;
  reason?: string;
  nStocks: number;
  nWeeks: number;
  from: string;
  to: string;
  years: number;
  exposure: number;
  weights: { ticker: string; name: string; weight: number }[];
  rows: StrategyRow[];
  attribution: Attribution;
  benchmarkTicker?: string;
  skippedNoMonday: number;
}

export interface EntryVsBenchmarkOptions extends AllocOptions {
  randomPaths?: number;
  seed?: number;
  benchmarkPrices?: PricePoint[];
  benchmarkTicker?: string;
  weightMode?: "kelly" | "equal"; // 配分の出どころ
}

export function computeEntryVsBenchmark(
  stocks: TickerPrices[], opts: EntryVsBenchmarkOptions = {}
): EntryVsBenchmarkResult {
  const side: Side = opts.side ?? "long";
  const exitDay = Math.max(1, Math.min(5, opts.exitDay ?? 5));
  const M = Math.max(20, opts.randomPaths ?? 200);

  const empty: EntryVsBenchmarkResult = {
    ok: false, nStocks: 0, nWeeks: 0, from: "", to: "", years: 0, exposure: 0,
    weights: [], rows: [],
    attribution: {
      ok: false, years: 0, market: 0, selection: 0, allocation: 0, timing: 0, total: 0,
      marketAnnual: 0, ewBhAnnual: 0, wBhAnnual: 0, stratAnnual: 0,
      hasMarket: false, dominant: "timing",
    },
    skippedNoMonday: 0,
  };

  const bp = buildPanel(stocks, side, exitDay);
  if ("error" in bp) return { ...empty, reason: bp.error };
  const panel = bp.panel;
  const K = panel.stocks.length;
  const T = panel.commonKeys.length;
  const years = T / WEEKS_PER_YEAR;

  // 配分は pf-entry-sizing と同一のケリー解を使う（同じ前提で比べるため）
  const alloc = computeWeeklyAllocation(stocks, opts);
  let w: number[];
  if (opts.weightMode === "equal") {
    w = new Array(K).fill(1 / K);
  } else if (alloc.ok && alloc.perStock.length === K) {
    const byTicker = new Map(alloc.perStock.map((s) => [s.ticker, s.weight]));
    w = panel.stocks.map((s) => byTicker.get(s.ticker) ?? 0);
  } else {
    w = new Array(K).fill(1 / K);
  }
  const exposure = w.reduce((s, x) => s + x, 0);
  if (!(exposure > 1e-6)) {
    return { ...empty, reason: "最適配分が全額現金（この設定ではエッジが検出されていません）" };
  }

  // 週あたり往復回転率 = 2×建玉比率。年率は ×52。Buy&Hold は期間中1往復。
  const weeklyTurnover = 2 * exposure * WEEKS_PER_YEAR;
  const bhTurnover = years > 0 ? (2 * exposure) / years : 0;

  const bh = buildBH(panel, w);
  const fixed = buildSeries(panel, w, (i, t, v) => (v.includes(0) ? [0] : [v[0]]));
  const equal = buildSeries(panel, w, (i, t, v) => v);
  const best = buildSeries(panel, w, (i, t, v) => {
    let b = v[0];
    for (const s of v) if (panel.RS[i][t][s]! > panel.RS[i][t][b]!) b = s;
    return [b];
  });
  const worst = buildSeries(panel, w, (i, t, v) => {
    let b = v[0];
    for (const s of v) if (panel.RS[i][t][s]! < panel.RS[i][t][b]!) b = s;
    return [b];
  });

  // ランダム: M本引いて Sharpe 中央値の経路を代表にする（平均を取ると均等分割に潰れるため）
  const randPaths: { series: Series; p: PerfStat }[] = [];
  for (let m = 0; m < M; m++) {
    const rng = mulberry32((opts.seed ?? 20260726) + m * 7919);
    const s = buildSeries(panel, w, (i, t, v) => [v[Math.floor(rng() * v.length) % v.length]]);
    randPaths.push({ series: s, p: perf(s.port, s.nTrades, weeklyTurnover) });
  }
  randPaths.sort((a, b) => a.p.sharpe - b.p.sharpe);
  const randMid = randPaths[Math.floor(randPaths.length / 2)];
  const cagrs = randPaths.map((x) => x.p.cagr).sort((a, b) => a - b);
  const shs = randPaths.map((x) => x.p.sharpe).sort((a, b) => a - b);
  const qAt = (arr: number[], q: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(q * (arr.length - 1))))];

  const built: { key: StrategyKey; series: Series; turnover: number }[] = [
    { key: "bh", series: bh, turnover: bhTurnover },
    { key: "fixed", series: fixed, turnover: weeklyTurnover },
    { key: "random", series: randMid.series, turnover: weeklyTurnover },
    { key: "equal", series: equal, turnover: weeklyTurnover },
    { key: "best", series: best, turnover: weeklyTurnover },
    { key: "worst", series: worst, turnover: weeklyTurnover },
  ];

  // ベンチマーク（同一配分Buy&Hold）との対応差
  const bhTradeByKey = new Map<string, number[]>();
  bh.keys.forEach((k, idx) => {
    const arr = bhTradeByKey.get(k);
    if (arr) arr.push(bh.trade[idx]);
    else bhTradeByKey.set(k, [bh.trade[idx]]);
  });

  const perfs = new Map<StrategyKey, PerfStat>();
  for (const b of built) perfs.set(b.key, perf(b.series.port, b.series.nTrades, b.turnover));

  const bestCagr = perfs.get("best")!.cagr;
  const worstCagr = perfs.get("worst")!.cagr;
  const span = bestCagr - worstCagr;

  const rows: StrategyRow[] = built.map((b) => {
    const p = perfs.get(b.key)!;
    // 週次ポートフォリオ差
    const portDiff = b.series.port.map((r, t) => r - bh.port[t]);
    // 銘柄×週の対応差（同じ週・同じ銘柄で Buy&Hold 側の生リターンと突き合わせる）
    const tradeDiff: number[] = [];
    const tradeKeys: string[] = [];
    if (b.key !== "bh") {
      const cursor = new Map<string, number>();
      b.series.keys.forEach((k, idx) => {
        const c = cursor.get(k) ?? 0;
        const bhArr = bhTradeByKey.get(k);
        if (bhArr && c < bhArr.length) {
          tradeDiff.push(b.series.trade[idx] - bhArr[c]);
          tradeKeys.push(k);
        }
        cursor.set(k, c + 1);
      });
    }
    return {
      key: b.key,
      label: STRATEGY_LABEL[b.key],
      note: STRATEGY_NOTE[b.key],
      perf: p,
      diff: b.key === "bh" ? emptyDiff() : diffTest(portDiff, tradeDiff, tradeKeys),
      spread: b.key === "random"
        ? {
            cagrLo: qAt(cagrs, 0.05), cagrHi: qAt(cagrs, 0.95),
            sharpeLo: qAt(shs, 0.05), sharpeHi: qAt(shs, 0.95), m: M,
          }
        : undefined,
      rankInRange: span > 1e-12 ? (p.cagr - worstCagr) / span : 0.5,
    };
  });

  // ───────── 分解 ─────────
  const ewBh = buildBH(panel, new Array(K).fill(1 / K));
  const stratRets = fixed.port;
  let marketRets: number[] | null = null;
  if (opts.benchmarkPrices && opts.benchmarkPrices.length > 100) {
    const mp = buildPanel(
      [{ ticker: "__bench__", name: "bench", prices: opts.benchmarkPrices },
       { ticker: "__bench2__", name: "bench", prices: opts.benchmarkPrices }],
      side, exitDay
    );
    if (!("error" in mp)) {
      const keyOf = new Map(mp.panel.commonKeys.map((k, i) => [k, i]));
      const series: number[] = [];
      let matched = 0;
      for (const k of panel.commonKeys) {
        const idx = keyOf.get(k);
        const v = idx !== undefined ? mp.panel.BH[0][idx] : null;
        if (v === null || v === undefined) series.push(0);
        else { series.push(v); matched++; }
      }
      // 週が9割以上噛み合わないベンチマークは分解に使わない（0埋めで床を過小評価するため）
      if (matched >= 0.9 * T) marketRets = series;
    }
  }

  const stratAnnual = logAnnual(stratRets, years);
  const wBhAnnual = logAnnual(bh.port, years);
  const ewBhAnnual = logAnnual(ewBh.port, years);
  const marketAnnual = marketRets ? logAnnual(marketRets, years) : 0;
  const hasMarket = marketRets !== null;

  const attrMarket = hasMarket ? marketAnnual : 0;
  const attrSelection = ewBhAnnual - attrMarket;
  const attrAllocation = wBhAnnual - ewBhAnnual;
  const attrTiming = stratAnnual - wBhAnnual;
  const parts: [Attribution["dominant"], number][] = [
    ["market", Math.abs(attrMarket)],
    ["selection", Math.abs(attrSelection)],
    ["allocation", Math.abs(attrAllocation)],
    ["timing", Math.abs(attrTiming)],
  ];
  parts.sort((a, b) => b[1] - a[1]);

  return {
    ok: true,
    nStocks: K,
    nWeeks: T,
    from: panel.commonKeys[0],
    to: panel.commonKeys[T - 1],
    years,
    exposure,
    weights: panel.stocks.map((s, i) => ({ ticker: s.ticker, name: s.name, weight: w[i] })),
    rows,
    attribution: {
      ok: true, years,
      market: attrMarket,
      selection: attrSelection,
      allocation: attrAllocation,
      timing: attrTiming,
      total: stratAnnual,
      marketAnnual, ewBhAnnual, wBhAnnual, stratAnnual,
      hasMarket,
      dominant: parts[0][0],
    },
    benchmarkTicker: opts.benchmarkTicker,
    skippedNoMonday: panel.skippedNoMonday,
  };
}
