// 業種バスケット(同一業種の複数銘柄)で日中足の標本をプールし、曜日×日内の
// 平均累積パスと最良ロングウィンドウを集計する。
//
// 【なぜプールするか】5/15/30分足は約60営業日しか取れず、曜日別では各12日前後と薄い。
// 同一業種の銘柄は共通ファクターに乗って似た日内パターンを描く、という仮定のもと複数銘柄を
// 混ぜて標本を厚くする。ただし同じ日には銀行株が一斉に動く(横断相関)ため、
// 「銘柄数×日数」を素朴に独立標本と数えると過大評価になる。ある月曜のショックは全銘柄で共有され、
// 独立な情報量は日数側に律速される。
//
// 【対策】
//  1. すべて始値基準の累積対数リターンで扱う(株価水準の違う銘柄を直接比較できる)。
//  2. 平均の標準誤差は「日付クラスタ」に頑健な推定量(cluster-robust / CR)で出す。
//     同一営業日の全銘柄を1クラスタとみなし、クラスタ内相関を吸収した正直な帯を描く。
//  3. 実効標本数 nEff = (iid仮定の分散) / (CR分散) × N を併記し、
//     「見かけのN」ではなく「独立標本に換算した数」を示す。
//  4. 最良ウィンドウの信頼区間は、日付を丸ごと再標本する「日クラスタ・ブートストラップ」で出す。

import { DayData, BinGrid } from "./intraday-core";
import { dayCumPath } from "./us-spillover-core";
import { PathStat, PairDiff, buildPathEvolution } from "./intraday-path-core";
import { computeWeekdayIntradayEdge, EdgeRankBy, EdgeWindow } from "./weekday-intraday-edge";
import { mean, std, median, benjaminiHochberg, quantileSorted } from "./stats-significance";
import { studentTwoSidedP } from "./us-spillover-core";

const WD_ORDER = [1, 2, 3, 4, 5];
const WD_LABELS: Record<number, string> = { 1: "月曜", 2: "火曜", 3: "水曜", 4: "木曜", 5: "金曜" };
const WD_COLORS: Record<number, string> = {
  1: "#2563eb", 2: "#16a34a", 3: "#f59e0b", 4: "#db2777", 5: "#7c3aed",
};

// バスケットに入れる1銘柄分の日次データ(共通グリッドに写像する前)。
export interface StockDays {
  ticker: string;
  name?: string;
  days: DayData[];
}

// ───────────────────────── クラスタ頑健な平均統計 ─────────────────────────

export interface ClusterStat {
  mean: number;
  se: number; // クラスタ頑健SE
  nDays: number; // クラスタ数(=独立な営業日数)
  nObs: number; // 観測数(=銘柄×日 のべ数)
  nEff: number; // 実効標本数(独立標本換算)
}

// 値の配列 vals と、それぞれが属する日付キー dates(同一日=同一クラスタ)から、
// 平均・クラスタ頑健SE・実効標本数を計算する。
// CR分散: Var(μ) = (1/N²)·Σ_d ( Σ_{i∈d}(x_i−μ) )²  (同一日の残差和を2乗して合算)
export function clusterStat(vals: number[], dates: string[]): ClusterStat | null {
  const N = vals.length;
  if (N < 2) return null;
  const mu = mean(vals);
  const byDate = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    byDate.set(dates[i], (byDate.get(dates[i]) ?? 0) + (vals[i] - mu));
  }
  let s = 0;
  for (const g of byDate.values()) s += g * g;
  const crVar = s / (N * N);
  const se = Math.sqrt(Math.max(crVar, 0));
  const nDays = byDate.size;
  // iid仮定の平均分散 = σ²/N。nEff = iidVar/CRVar (∈[1,N])。
  const sampVar = std(vals) ** 2;
  const iidVar = sampVar / N;
  let nEff = crVar > 0 && iidVar > 0 ? (iidVar / crVar) * N : N;
  if (!isFinite(nEff) || nEff < 1) nEff = 1;
  if (nEff > N) nEff = N;
  return { mean: mu, se, nDays, nObs: N, nEff };
}

// ───────────────────────── 曜日×日内 平均累積パス(プール版) ─────────────────────────

export interface BasketPathBin extends PathStat {
  weekday: number;
  nDays: number; // 独立な営業日数(クラスタ数)
  nEff: number; // 実効標本数(終端リターン基準)
}

// 各銘柄が各曜日にどれだけ寄与し、終端リターンがどの向きかを示す(「似ている」仮定の検証用)。
export interface StockContribution {
  ticker: string;
  name?: string;
  nDays: number; // 使えた立会日数(全曜日合計)
  endMean: number; // 全期間の寄り→引け平均
  perWeekday: Record<number, number>; // 曜日→寄り→引け平均(その銘柄単独)
}

export interface BasketPathResult {
  bins: BasketPathBin[];
  timeLabels: string[];
  maxAbs: number;
  pairDiffs: PairDiff[];
  perStock: StockContribution[];
  nStocks: number;
  totalObs: number; // のべ銘柄×日
}

interface WdBucket {
  paths: number[][]; // 各行=1銘柄1日の始値基準累積パス(長さG)
  dates: string[]; // paths と同じ順序の営業日
}

// バスケットの全銘柄・全立会日を共通グリッドに写像し、曜日ごとにプールした平均累積パスを返す。
export function poolWeekdayPaths(
  stocks: StockDays[], grid: BinGrid | null, gmtoffset: number
): BasketPathResult | null {
  if (!grid) return null;
  const G = grid.bins.length;
  if (G < 2) return null;

  const buckets = new Map<number, WdBucket>();
  for (const wd of WD_ORDER) buckets.set(wd, { paths: [], dates: [] });

  const perStock: StockContribution[] = [];
  for (const st of stocks) {
    const rows = st.days.filter((d) => d.open > 0 && WD_ORDER.includes(d.weekday));
    if (rows.length === 0) continue;
    const perWd: Record<number, number[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
    const allEnds: number[] = [];
    for (const d of rows) {
      const path = dayCumPath(d, grid, gmtoffset);
      const b = buckets.get(d.weekday)!;
      b.paths.push(path);
      b.dates.push(d.date);
      const end = path[G - 1];
      perWd[d.weekday].push(end);
      allEnds.push(end);
    }
    perStock.push({
      ticker: st.ticker,
      name: st.name,
      nDays: rows.length,
      endMean: allEnds.length ? mean(allEnds) : 0,
      perWeekday: Object.fromEntries(
        WD_ORDER.map((wd) => [wd, perWd[wd].length ? mean(perWd[wd]) : NaN])
      ) as Record<number, number>,
    });
  }

  let maxAbs = 1e-6;
  const bins: BasketPathBin[] = WD_ORDER.map((wd) => {
    const { paths, dates } = buckets.get(wd)!;
    const M = paths.length;
    const m = new Array(G).fill(0), md = new Array(G).fill(0);
    const lo = new Array(G).fill(0), hi = new Array(G).fill(0);
    let endStat: ClusterStat | null = null;
    if (M > 0) {
      for (let g = 0; g < G; g++) {
        const col = paths.map((p) => p[g]);
        const cs = clusterStat(col, dates);
        const mu = cs ? cs.mean : mean(col);
        const se = cs ? cs.se : 0;
        m[g] = mu; md[g] = median(col);
        lo[g] = mu - 1.96 * se; hi[g] = mu + 1.96 * se;
        maxAbs = Math.max(maxAbs, Math.abs(hi[g]), Math.abs(lo[g]), Math.abs(md[g]));
      }
      endStat = clusterStat(paths.map((p) => p[G - 1]), dates);
    }
    let peakIdx = 0, troughIdx = 0;
    for (let g = 1; g < G; g++) {
      if (m[g] > m[peakIdx]) peakIdx = g;
      if (m[g] < m[troughIdx]) troughIdx = g;
    }
    const endValues = paths.map((p) => p[G - 1]);
    const endMean = endStat ? endStat.mean : 0;
    const endP = endStat && endStat.se > 0
      ? studentTwoSidedP(endMean / endStat.se, Math.max(1, endStat.nDays - 1))
      : 1;
    // 経時ドリフト。同一日の複数銘柄はバスケット平均に畳まれるので、
    // 時代分割も検定も「独立な営業日」単位になる(のべ銘柄×日で水増ししない)。
    const evo = buildPathEvolution(paths, dates, G);
    return {
      key: String(wd), label: WD_LABELS[wd], color: WD_COLORS[wd],
      n: M, mean: m, med: md, lo, hi,
      endMean, endMed: md[G - 1], endP, endValues, peakIdx, troughIdx,
      days: evo.days, eras: evo.eras, drift: evo.drift,
      weekday: wd,
      nDays: endStat ? endStat.nDays : 0,
      nEff: endStat ? endStat.nEff : 0,
    };
  });

  const pairDiffs = pooledPairwiseEndDiffs(bins, buckets, G);

  return {
    bins, timeLabels: grid.bins.map((x) => x.label), maxAbs, pairDiffs,
    perStock, nStocks: perStock.length,
    totalObs: bins.reduce((s, b) => s + b.n, 0),
  };
}

// 曜日ペアの終端差を、クラスタ頑健SEで2標本比較して FDR 補正する。
function pooledPairwiseEndDiffs(
  bins: BasketPathBin[], buckets: Map<number, WdBucket>, G: number
): PairDiff[] {
  const stats = WD_ORDER.map((wd) => {
    const { paths, dates } = buckets.get(wd)!;
    return clusterStat(paths.map((p) => p[G - 1]), dates);
  });
  const pairs: { i: number; j: number; diff: number; p: number }[] = [];
  for (let i = 0; i < WD_ORDER.length; i++) {
    for (let j = i + 1; j < WD_ORDER.length; j++) {
      const a = stats[i], b = stats[j];
      if (!a || !b || a.nDays < 2 || b.nDays < 2) continue;
      const seD = Math.sqrt(a.se * a.se + b.se * b.se);
      if (seD <= 0) continue;
      const diff = a.mean - b.mean;
      const df = Math.max(1, Math.min(a.nDays, b.nDays) - 1);
      const p = studentTwoSidedP(diff / seD, df);
      pairs.push({ i, j, diff, p });
    }
  }
  const adj = benjaminiHochberg(pairs.map((x) => x.p));
  return pairs.map((x, k) => ({ ...x, pAdj: adj[k] }));
}

// ───────────────────────── 曜日 最良ロングウィンドウ(プール版) ─────────────────────────

export interface BasketEdgeWeekday {
  weekday: number;
  label: string;
  color: string;
  nObs: number; // のべ銘柄×日
  nDays: number; // 独立営業日数
  nEff: number; // 実効標本数(最良ウィンドウ基準)
  best: EdgeWindow | null;
  ci: { lo: number; hi: number; stable: number } | null; // 日クラスタ・ブートストラップ95%CI
}

export interface BasketEdgeResult {
  weekdays: BasketEdgeWeekday[];
  timeLabels: string[];
  nTested: number;
}

// 全銘柄の立会日を連結してプールし、曜日ごとの最良ロングウィンドウを総当たりで選ぶ。
// 選定・平均は既存 computeWeekdayIntradayEdge に委譲(平均は横断相関に不偏)。
// 有意性は「日クラスタ・ブートストラップCI」と「実効標本数」で正直に評価し直す。
export function poolWeekdayEdge(
  stocks: StockDays[], grid: BinGrid | null, gmtoffset: number, rankBy: EdgeRankBy
): BasketEdgeResult | null {
  if (!grid) return null;
  const allDays: DayData[] = [];
  for (const st of stocks) {
    for (const d of st.days) allDays.push(d);
  }
  if (allDays.length === 0) return null;

  const base = computeWeekdayIntradayEdge(allDays, grid, gmtoffset, { rankBy });
  if (!base) return null;

  const weekdays: BasketEdgeWeekday[] = base.weekdays.map((w) => {
    const dates = w.trades.map((t) => t.date);
    const rets = w.trades.map((t) => t.ret);
    const cs = rets.length >= 2 ? clusterStat(rets, dates) : null;
    const ci = dateClusterBootstrapCI(w.trades);
    return {
      weekday: w.weekday, label: w.label, color: w.color,
      nObs: rets.length, nDays: cs ? cs.nDays : 0, nEff: cs ? cs.nEff : 0,
      best: w.best, ci,
    };
  });

  return { weekdays, timeLabels: base.timeLabels, nTested: base.nTested };
}

// 日付を丸ごと再標本する移動ブロック無しのクラスタ・ブートストラップ。
// 同一営業日の全銘柄トレードを1単位として非復元的に束ね、日付を復元抽出する。
// これにより横断相関(同じ日に全銘柄が一斉に動く)を壊さずに平均の分布を得る。
export function dateClusterBootstrapCI(
  trades: { date: string; ret: number }[], B = 800
): { lo: number; hi: number; stable: number } | null {
  const byDate = new Map<string, number[]>();
  for (const t of trades) {
    const arr = byDate.get(t.date);
    if (arr) arr.push(t.ret); else byDate.set(t.date, [t.ret]);
  }
  const dateKeys = Array.from(byDate.keys());
  const K = dateKeys.length;
  if (K < 5) return null;
  const groups = dateKeys.map((d) => byDate.get(d)!);
  const allMean = mean(trades.map((t) => t.ret));
  const pointSign = allMean >= 0 ? 1 : -1;
  const samples: number[] = [];
  let sameSign = 0;
  for (let b = 0; b < B; b++) {
    let sum = 0, cnt = 0;
    for (let k = 0; k < K; k++) {
      const g = groups[Math.floor(Math.random() * K)];
      for (const v of g) { sum += v; cnt++; }
    }
    const m = cnt > 0 ? sum / cnt : 0;
    samples.push(m);
    if ((m >= 0 ? 1 : -1) === pointSign) sameSign++;
  }
  samples.sort((a, b) => a - b);
  return { lo: quantileSorted(samples, 0.025), hi: quantileSorted(samples, 0.975), stable: sameSign / B };
}

export { WD_ORDER, WD_LABELS, WD_COLORS };
