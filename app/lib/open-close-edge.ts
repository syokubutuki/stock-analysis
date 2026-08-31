// 始値/終値だけで執行するトレードの「最適な売買時刻」と「条件付きエッジ」を測る計算群。
//
// 日足では1日に観測できる執行価格は始値(O)と終値(C)の2点しかない。ここから組めるトレードは
//   ・日中(intraday)     : 当日O → 当日C          （デイトレ。寄り買い→引け売り）
//   ・夜間(overnight)    : 前日C → 当日O          （持ち越し。引け買い→翌寄り売り）
//   ・引→引(closeToClose): C_t → C_{t+N}
//   ・寄→寄(openToOpen)  : O_t → O_{t+N}
//   ・寄→引(openToClose) : O_t → C_{t+N}
//   ・引→寄(closeToOpen) : C_t → O_{t+N}
// の6系統 × 保有日数 N に展開できる。
//
// (A) scanExecutionEdges … 上記を無条件で総当たりし、t検定→Benjamini-Hochberg FDR補正→
//     移動ブロックブートストラップCI→年次安定性で「データマイニングの偽陽性」を排除して順位付け。
//     weekday-scan.ts の scanWeekdayEdges を「曜日を固定しない・保有日数を掃引する」版にしたもの。
// (B) conditionalSegmentEdge … 状態(RSI帯・ボラ・前日リターン等)別に、日中と夜間どちらに
//     妙味が出るかを対比する。条件は「前日終値時点で確定する情報」のみで構成し先読みを排除。
//
// いずれも始点 i を1日刻みで全採用する(窓は重なる)。系列相関による t 値の過大評価は
// ブロックブートストラップCIと年次符号一致で補完する。conditional-forward-returns.ts と同じ流儀。

import { PricePoint } from "./types";
import {
  mean,
  std,
  tTest,
  benjaminiHochberg,
  blockBootstrapCI,
} from "./stats-significance";
import { StateFn } from "./conditional-forward-returns";
import { CostModel, ZERO_COST, roundTripCost } from "./strategy-vs-benchmark";

type Timing = "open" | "close";
type Side = "long" | "short";

// ============================================================
// (A) 売買時刻スキャン
// ============================================================
export interface TradeDef {
  id: string;
  label: string;
  entry: Timing;
  exit: Timing;
  nDays: number; // 出口日 = 入口日 + nDays
  cadence: number; // 独立に建て直せる間隔(営業日)。年率換算・最大DDの非重複サンプリングに使う
}

export interface EdgeStat {
  def: TradeDef;
  n: number;
  direction: Side; // 推奨方向(平均の符号)
  meanTrade: number; // 方向調整後の1取引平均リターン
  annualized: number; // 方向調整後の年率(同じ型を繰り返し執行した想定)
  sharpe: number; // 方向調整後の年率Sharpe
  winRate: number; // 方向調整後の勝率
  maxDD: number; // 非重複エクイティの最大ドローダウン(負値)
  t: number; // |t|
  p: number; // 両側生p値
  pAdj: number; // FDR補正後
  significant: boolean; // pAdj < 0.05
  yearsPositive: number; // 方向調整後リターンが正だった年の割合(0..1)
  nYears: number;
  // ── コスト（2026-08-31 追加）──────────────────────────────────────────
  // このスキャンは cadence が 1〜21日の型を**同じ表で順位付けする**。夜間持ち越しは
  // 年252往復、21日保有は年12往復で、コストを引かないと高回転の型に systematic な
  // 下駄を履かせたまま比較することになる。実測往復コスト 0.3%（銀行株）でも
  // 夜間型は年 −75%、1.0%（キオクシア）なら年 −250% で、グロスの順位は意味を失う。
  /** 年間往復回数 252/cadence。コストの総額はこれで決まるので必ず併記する */
  roundTripsPerYear: number;
  /** コスト控除前の1取引平均（方向調整後） */
  grossMeanTrade: number;
  /** コスト控除前の年率 */
  grossAnnualized: number;
  /** コストが年率で削った量（grossAnnualized − annualized）。0 ならコスト無効 */
  costDrag: number;
  /** グロスでは正だった期待値がコストで非正に落ちたか */
  flippedByCost: boolean;
  halfAgree: boolean; // 前半・後半とも全体と同符号
  ciLo: number | null;
  ciHi: number | null;
  ciStable: number | null;
}

export type EdgeSort = "pAdj" | "absT" | "annualized" | "sharpe";

export interface ScanExecResult {
  stats: EdgeStat[];
  nTested: number; // 検定数(FDRの母数)
  minTrades: number;
  best: EdgeStat | null; // 有意な中で最も信頼できる(pAdj最小)もの
  /** 実際に効かせた1往復あたりのコスト率。0 なら未控除 */
  costRT: number;
  /** グロスでは期待値が正だったのにコストで非正へ落ちた型の数 */
  nFlippedByCost: number;
}

const TRADING_DAYS = 252;

// 各トレード型の重なりあり(全始点)リターン列と出口年を返す。
function tradeReturns(prices: PricePoint[], def: TradeDef): { rets: number[]; years: number[] } {
  const n = prices.length;
  const rets: number[] = [];
  const years: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = i + def.nDays;
    if (j >= n) break;
    const entryOrd = 2 * i + (def.entry === "open" ? 0 : 1);
    const exitOrd = 2 * j + (def.exit === "open" ? 0 : 1);
    if (exitOrd <= entryOrd) continue; // 同時刻以前は無効(例: O→Oで同日は除外)
    const eP = def.entry === "open" ? prices[i].open : prices[i].close;
    const xP = def.exit === "open" ? prices[j].open : prices[j].close;
    if (!(eP > 0) || !(xP > 0)) continue;
    rets.push(xP / eP - 1);
    years.push(new Date(prices[j].time).getFullYear());
  }
  return { rets, years };
}

// 非重複(cadence刻み)に間引いた系列から累積エクイティの最大DDを測る。
function nonOverlapMaxDD(rets: number[], cadence: number): number {
  const step = Math.max(1, Math.round(cadence));
  let w = 1, peak = 1, maxDD = 0;
  for (let i = 0; i < rets.length; i += step) {
    w *= 1 + rets[i];
    peak = Math.max(peak, w);
    const dd = (w - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD;
}

export interface ScanExecOptions {
  horizons?: number[];
  minTrades?: number;
  bootstrapB?: number;
  bootstrapTopN?: number;
  sort?: EdgeSort;
  /**
   * 往復コスト。既定は無効（ZERO_COST）で、有効にすると**検定を含む全統計量が
   * ネットで再計算される**（t・p・FDR・CI・Sharpe・最大DD・年次符号すべて）。
   * 「エッジがあるか」ではなく「**取り出せるエッジがあるか**」を検定するため。
   */
  cost?: CostModel;
}

const TIMING_KANJI: Record<Timing, string> = { open: "寄", close: "引" };

function buildTradeDefs(horizons: number[]): TradeDef[] {
  const defs: TradeDef[] = [];
  // 当日内・1晩の特別ケース
  defs.push({ id: "intraday", label: "寄→引(日中デイトレ)", entry: "open", exit: "close", nDays: 0, cadence: 1 });
  defs.push({ id: "overnight", label: "引→翌寄(夜間持ち越し)", entry: "close", exit: "open", nDays: 1, cadence: 1 });
  for (const N of horizons) {
    defs.push({ id: `cc${N}`, label: `引→引 ${N}日保有`, entry: "close", exit: "close", nDays: N, cadence: N });
    defs.push({ id: `oo${N}`, label: `寄→寄 ${N}日保有`, entry: "open", exit: "open", nDays: N, cadence: N });
    defs.push({ id: `oc${N}`, label: `寄→引 ${N}日保有`, entry: "open", exit: "close", nDays: N, cadence: N });
    if (N >= 2) defs.push({ id: `co${N}`, label: `引→寄 ${N}日保有`, entry: "close", exit: "open", nDays: N, cadence: N });
  }
  return defs;
}

export function scanExecutionEdges(prices: PricePoint[], opts: ScanExecOptions = {}): ScanExecResult {
  const horizons = opts.horizons ?? [1, 2, 3, 5, 10, 21];
  const minTrades = opts.minTrades ?? 30;
  const bootstrapB = opts.bootstrapB ?? 800;
  const bootstrapTopN = opts.bootstrapTopN ?? 30;
  const sort: EdgeSort = opts.sort ?? "pAdj";

  const defs = buildTradeDefs(horizons);

  // 1往復あたりの控除率。富は W *= (1+r)(1−c) で回るので、1取引リターンへの反映は
  // (1+r)(1−c)−1 が**厳密**（strategy-vs-benchmark.ts の対数空間控除と同じもの）。
  const costRT = roundTripCost(opts.cost ?? ZERO_COST);

  interface Raw {
    def: TradeDef;
    /** 方向調整後・コスト控除前 */
    adj: number[];
    /** 方向調整後・コスト控除後。costRT=0 なら adj と同一 */
    net: number[];
    years: number[];
    direction: Side;
    t: number;
    p: number;
  }
  const raws: Raw[] = [];
  for (const def of defs) {
    const { rets, years } = tradeReturns(prices, def);
    if (rets.length < minTrades) continue;
    // 方向はグロスの符号で決める（コストは方向に依らない定率なので順序を変えない）
    const direction: Side = mean(rets) >= 0 ? "long" : "short";
    const adj = direction === "long" ? rets : rets.map((v) => -v);
    const net = costRT > 0 ? adj.map((v) => (1 + v) * (1 - costRT) - 1) : adj;
    // 検定はネットで行う。costRT=0 のときは従来と同一の |t|・p になる
    // （両側検定なので、方向調整で符号が反転しても値は変わらない）。
    const tt = tTest(net);
    if (!tt) continue;
    raws.push({ def, adj, net, years, direction, t: tt.t, p: tt.p });
  }

  const pAdj = benjaminiHochberg(raws.map((r) => r.p));

  // |t|上位のみブートCIを計算(重いので限定)
  const tOrder = raws.map((_, i) => i).sort((a, b) => Math.abs(raws[b].t) - Math.abs(raws[a].t));
  const bootSet = new Set(tOrder.slice(0, bootstrapTopN));

  const stats: EdgeStat[] = raws.map((r, i) => {
    const direction = r.direction;
    const adj = r.net; // 以降の統計量はすべてネットで計算する
    const m = mean(adj);
    const sd = std(adj);
    const periodsPerYear = TRADING_DAYS / Math.max(1, r.def.cadence);
    const annualized = Math.pow(1 + m, periodsPerYear) - 1;
    const grossMeanTrade = mean(r.adj);
    const grossAnnualized = Math.pow(1 + grossMeanTrade, periodsPerYear) - 1;
    const sharpe = sd > 0 ? (m / sd) * Math.sqrt(periodsPerYear) : 0;
    const maxDD = nonOverlapMaxDD(adj, r.def.cadence);

    // 年次安定性
    const byYear: Record<number, number[]> = {};
    for (let k = 0; k < adj.length; k++) (byYear[r.years[k]] ||= []).push(adj[k]);
    const yearMeans = Object.values(byYear).map((a) => mean(a));
    const nYears = yearMeans.length;
    const yearsPositive = nYears ? yearMeans.filter((v) => v > 0).length / nYears : 0;
    const half = Math.floor(adj.length / 2);
    const halfAgree = mean(adj.slice(0, half)) > 0 && mean(adj.slice(half)) > 0;

    let ciLo: number | null = null, ciHi: number | null = null, ciStable: number | null = null;
    if (bootSet.has(i)) {
      const ci = blockBootstrapCI(adj, bootstrapB);
      if (ci) { ciLo = ci.lo; ciHi = ci.hi; ciStable = ci.stable; }
    }

    return {
      def: r.def,
      n: r.net.length,
      direction,
      meanTrade: m,
      annualized,
      sharpe,
      winRate: adj.filter((v) => v > 0).length / adj.length,
      maxDD,
      t: Math.abs(r.t),
      p: r.p,
      pAdj: pAdj[i],
      significant: pAdj[i] < 0.05,
      yearsPositive,
      nYears,
      halfAgree,
      ciLo, ciHi, ciStable,
      roundTripsPerYear: periodsPerYear,
      grossMeanTrade,
      grossAnnualized,
      costDrag: grossAnnualized - annualized,
      flippedByCost: grossMeanTrade > 0 && m <= 0,
    };
  });

  const cmp: Record<EdgeSort, (a: EdgeStat, b: EdgeStat) => number> = {
    pAdj: (a, b) => a.pAdj - b.pAdj || b.t - a.t,
    absT: (a, b) => b.t - a.t,
    annualized: (a, b) => Math.abs(b.annualized) - Math.abs(a.annualized),
    sharpe: (a, b) => b.sharpe - a.sharpe,
  };
  stats.sort(cmp[sort]);

  // 「最も信頼できる」= 有意かつ年次過半数同符号の中で pAdj 最小。
  // meanTrade > 0 の条件はコスト導入で必要になった。控除前は方向調整で平均が必ず
  // 非負だったが、控除後は「有意に負け続ける型」が現れる（両側検定なので、
  // 大きく負の平均は有意に出る）。それを「最も信頼できるエッジ」に選ばせない。
  const best = stats
    .filter((s) => s.significant && s.meanTrade > 0 && s.yearsPositive >= 0.5 && s.n >= minTrades)
    .sort((a, b) => a.pAdj - b.pAdj || b.t - a.t)[0] ?? null;

  return {
    stats,
    nTested: raws.length,
    minTrades,
    best,
    costRT,
    nFlippedByCost: stats.filter((s) => s.flippedByCost).length,
  };
}

export { TIMING_KANJI };

// ============================================================
// (B) 条件付きセグメントエッジ（日中 vs 夜間）
// ============================================================
export interface SegStats {
  n: number;
  meanFwd: number;
  winRate: number;
  std: number;
  ciLow: number;
  ciHigh: number;
  p: number; // FDR補正後
  significant: boolean;
}

export interface SegBucket {
  label: string;
  n: number;
  intraday: SegStats; // 当日O→当日C
  overnight: SegStats; // 前日C→当日O
  diff: number; // 日中平均 − 夜間平均
}

export interface SegResult {
  buckets: SegBucket[];
  order: string[];
  nowLabel: string | null;
  baseIntraday: number; // 全標本の日中平均
  baseOvernight: number;
  baseWinIntraday: number;
  baseWinOvernight: number;
  totalN: number;
}

function segStatsOf(rets: number[], pAdj: number): SegStats {
  const m = mean(rets);
  const ci = blockBootstrapCI(rets, 500);
  return {
    n: rets.length,
    meanFwd: m,
    winRate: rets.length ? rets.filter((r) => r > 0).length / rets.length : 0,
    std: std(rets),
    ciLow: ci ? ci.lo : m,
    ciHigh: ci ? ci.hi : m,
    p: pAdj,
    significant: pAdj < 0.05,
  };
}

// state.stateOf(i-1)（前日終値時点で確定）で当日 i の日中・夜間リターンを条件付ける。
export function conditionalSegmentEdge(prices: PricePoint[], state: StateFn): SegResult {
  const n = prices.length;
  const grouped = new Map<string, { id: number[]; on: number[] }>();
  const allId: number[] = [];
  const allOn: number[] = [];

  for (let i = 1; i < n; i++) {
    const label = state.stateOf(i - 1); // 前日終値時点の状態 → 当日の執行判断に使える
    if (label === null) continue;
    const prevC = prices[i - 1].close, o = prices[i].open, c = prices[i].close;
    if (!(prevC > 0) || !(o > 0) || !(c > 0)) continue;
    const rOn = o / prevC - 1; // 夜間(持ち越し)
    const rId = c / o - 1; // 日中(デイトレ)
    let g = grouped.get(label);
    if (!g) { g = { id: [], on: [] }; grouped.set(label, g); }
    g.id.push(rId); g.on.push(rOn);
    allId.push(rId); allOn.push(rOn);
  }

  const present = state.order.filter((o) => grouped.has(o));
  // 日中・夜間それぞれで t検定 → FDR(別々に補正)
  const pIdRaw = present.map((l) => { const t = tTest(grouped.get(l)!.id); return t ? t.p : 1; });
  const pOnRaw = present.map((l) => { const t = tTest(grouped.get(l)!.on); return t ? t.p : 1; });
  const pIdAdj = benjaminiHochberg(pIdRaw);
  const pOnAdj = benjaminiHochberg(pOnRaw);

  const buckets: SegBucket[] = present.map((label, k) => {
    const g = grouped.get(label)!;
    const intraday = segStatsOf(g.id, pIdAdj[k]);
    const overnight = segStatsOf(g.on, pOnAdj[k]);
    return {
      label,
      n: g.id.length,
      intraday,
      overnight,
      diff: intraday.meanFwd - overnight.meanFwd,
    };
  });

  let nowLabel: string | null = null;
  for (let i = n - 1; i >= 0; i--) { const l = state.stateOf(i); if (l !== null) { nowLabel = l; break; } }

  return {
    buckets,
    order: present,
    nowLabel,
    baseIntraday: mean(allId),
    baseOvernight: mean(allOn),
    baseWinIntraday: allId.length ? allId.filter((r) => r > 0).length / allId.length : 0,
    baseWinOvernight: allOn.length ? allOn.filter((r) => r > 0).length / allOn.length : 0,
    totalN: allId.length,
  };
}
