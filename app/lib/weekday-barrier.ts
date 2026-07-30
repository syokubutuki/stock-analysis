// 曜日ビン別 TP/SL ─ バリア設計の何が測れて何が測れないか（系C28）
//
// 一言結論（画面最上段に出すもの）:
//   σ単位のバリア（TP=+Aσ√H / SL=−Bσ√H）は、暦時間あたりのシャープレシオを一切変えない。
//   変えられるのは勝率・歪度・回転率・期待滞在時間だけである。
//     期待損益 = μ × 期待滞在時間 = μ·AB·H     （バリアは滞在時間しか動かさない）
//     暦時間シャープ = μ√T/σ                   （A, B に依存しない）
//
// したがって「期待値を最大化する TP/SL」の探索は、理想モデル下では
//   μ>0 → AB→∞（持ち切り）／μ<0 → 建てない
// という自明解にしか収束しない。格子探索が内点に最適解を返したなら、それは
//   (a) 経路依存性の証拠 か (b) 推定ノイズ のどちらかであり、両者の切り分けが本モジュールの仕事。
//
// 4層構成:
//   層0 設計盤   … 推定ゼロの閉形式（到達確率の厳密解・μ=0の4量・Wald・暦時間シャープ・コスト単調性）
//   層1 σ正規化  … %固定の格子で曜日別 best を出し、σ単位に直すと一点に集まるかを分散比で検定
//   層2 逸脱     … 理論値からのずれ3指標（到達確率・期待滞在・オーバーシュート）を曜日間で検定
//   層3 ヌル較正 … ①曜日ラベル破壊サロゲート ②一致ブラウン運動ヌル ③インターリーブ2分割OOS
//
// 層2/層3の設計上の注意（設計書§1.4 への補強）:
//   閉形式は「連続時間・時間切りなし」の値である。実測は 60分足6本や日足5本という粗い離散で、
//   しかも時間切り H で打ち切られる。したがって実測と閉形式の差には
//     (i) 本物の逸脱（自己相関・ボラクラスタ・ジャンプ） と (ii) 離散化と打ち切りの機械的効果
//   が混ざる。(ii) を分離するため、層3では「同じ離散構造・同じ打ち切り・同じ同足同時到達の
//   決着規則で走らせた iid ガウス（=一致ブラウン運動）」をヌルとして併置する。

import { IntradayBar, groupByDay } from "./intraday-core";
import { PricePoint } from "./types";
import {
  mean, std, tTest, benjaminiHochberg, fSurvival, studentTwoSidedP,
} from "./stats-significance";
import { chiSquareSurvival, normalTwoSidedP } from "./weekday-us-interaction";
import { mulberry32 } from "./us-spillover-core";

export const WD_ORDER = [1, 2, 3, 4, 5];
export const WD_LABELS: Record<number, string> = { 1: "月曜", 2: "火曜", 3: "水曜", 4: "木曜", 5: "金曜" };
export const WD_COLORS: Record<number, string> = {
  1: "#2563eb", 2: "#16a34a", 3: "#f59e0b", 4: "#db2777", 5: "#7c3aed",
};

// ───────────────────────── 層0: 閉形式（推定ゼロ） ─────────────────────────

export interface DesignBoard {
  A: number; B: number; H: number;
  S: number; // その期間のシャープ S = μ√H/σ
  hitProbExact: number; // P(TPに先に到達) = (1−e^{2BS})/(e^{−2AS}−e^{2BS})
  hitProbZeroMu: number; // μ=0 の極限 B/(A+B)
  skew: number; // (A−B)/√(AB)
  eTauH: number; // 期待滞在 E[τ]。μ=0 では ab/σ²=AB·H、μ≠0 では Wald から厳密に (a·p−b(1−p))/μ
  tradeSd: number; // 1トレードの標準偏差 √(AB)·σ√H
  nTrades: number; // 暦期間T に入るトレード数 T/(AB·H)
  expTotal: number; // 総期待値 μT（A,Bに不変）
  varTotal: number; // 総分散 σ²T（A,Bに不変）
  sharpeCal: number; // 暦時間シャープ μ√T/σ（A,Bに不変）
  costTotal: number; // 総コスト c·T/(AB·H)
  expAfterCost: number;
  sharpeAfterCost: number;
}

// (A,B,H) と μ,σ,T,c から層0の全量を返す。推定は一切しない（μ,σ は表示のための入力）。
export function designBoard(p: {
  A: number; B: number; H: number;
  mu: number; sigma: number; T: number; cost: number;
}): DesignBoard {
  const { A, B, H, mu, sigma, T, cost } = p;
  const S = sigma > 0 ? (mu * Math.sqrt(H)) / sigma : 0;
  const AB = A * B;
  // 到達確率の厳密解。S→0 で 0/0 になるので極限に落とす。
  let hit = B / (A + B);
  if (Math.abs(S) > 1e-9) {
    const num = 1 - Math.exp(2 * B * S);
    const den = Math.exp(-2 * A * S) - Math.exp(2 * B * S);
    if (Math.abs(den) > 1e-15) hit = num / den;
  }
  // 期待滞在 E[τ]。μ=0 なら ab/σ² = AB·H。μ≠0 では Wald の第1式 E[X_τ]=μ·E[τ] から厳密に
  //   E[τ] = (a·p − b·(1−p)) / μ        （a=Aσ√H, b=Bσ√H, p=到達確率の厳密解）
  // が出る。μ→0 で 0/0 なので極限 AB·H に落とす（S→0 で分子→AB·μ·H なので連続に繋がる）。
  // 回転数 → 総コスト → コスト後シャープに伝播するので、ここは近似で済ませない。
  let eTau = AB * H;
  if (Math.abs(S) > 1e-6 && mu !== 0) {
    const eX = A * sigma * Math.sqrt(H) * hit - B * sigma * Math.sqrt(H) * (1 - hit);
    const t = eX / mu;
    if (Number.isFinite(t) && t > 0) eTau = t;
  }
  const nTrades = eTau > 0 ? T / eTau : 0;
  const expTotal = mu * T;
  const varTotal = sigma * sigma * T;
  const costTotal = cost * nTrades;
  const sd = Math.sqrt(varTotal);
  return {
    A, B, H, S,
    hitProbExact: Math.min(1, Math.max(0, hit)),
    hitProbZeroMu: B / (A + B),
    skew: AB > 0 ? (A - B) / Math.sqrt(AB) : 0,
    eTauH: eTau,
    tradeSd: Math.sqrt(AB) * sigma * Math.sqrt(H),
    nTrades,
    expTotal,
    varTotal,
    sharpeCal: sd > 0 ? expTotal / sd : 0,
    costTotal,
    expAfterCost: expTotal - costTotal,
    sharpeAfterCost: sd > 0 ? (expTotal - costTotal) / sd : 0,
  };
}

// ───────────────────────── 経路（エントリー基準の対数リターン） ─────────────────────────

// 1ステップ = 60分足1本(日中モード) または 1営業日(数日モード)。
// 値はすべて「エントリー価格を0とする対数リターン」。
export interface PathStep { open: number; hi: number; lo: number; close: number; }

export interface BarrierPath {
  date: string; // エントリー日
  weekday: number; // 1..5
  steps: PathStep[];
}

export type BarrierMode = "intraday" | "multiday";
export type TieBreak = "pessimistic" | "optimistic";

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

// 日中モード: 60分足の各営業日を「寄りで建て、引けで時間切り」の1経路にする。
export function buildIntradayPaths(bars: IntradayBar[], gmtoffset: number): BarrierPath[] {
  const days = groupByDay(bars, gmtoffset);
  const out: BarrierPath[] = [];
  for (const d of days) {
    const wd = weekdayOf(d.date);
    if (!WD_ORDER.includes(wd) || d.bars.length < 3) continue;
    const E = d.bars[0].open;
    if (!(E > 0)) continue;
    const steps: PathStep[] = [];
    let bad = false;
    for (const b of d.bars) {
      if (!(b.open > 0) || !(b.high > 0) || !(b.low > 0) || !(b.close > 0)) { bad = true; break; }
      steps.push({
        open: Math.log(b.open / E), hi: Math.log(b.high / E),
        lo: Math.log(b.low / E), close: Math.log(b.close / E),
      });
    }
    if (bad || steps.length < 3) continue;
    out.push({ date: d.date, weekday: wd, steps });
  }
  return out;
}

// 数日モード: 各営業日の引けで建て、翌日から H 営業日を1ステップ=1日として辿る。
// 窓は重なる（毎日エントリー）。重なりは実効標本を H 分の1にするので、SEは √H 倍して報告する。
export function buildMultidayPaths(prices: PricePoint[], hDays: number): BarrierPath[] {
  const out: BarrierPath[] = [];
  for (let i = 0; i + hDays < prices.length; i++) {
    const wd = weekdayOf(prices[i].time);
    if (!WD_ORDER.includes(wd)) continue;
    const E = prices[i].close;
    if (!(E > 0)) continue;
    const steps: PathStep[] = [];
    let bad = false;
    for (let k = 1; k <= hDays; k++) {
      const q = prices[i + k];
      if (!(q.open > 0) || !(q.high > 0) || !(q.low > 0) || !(q.close > 0)) { bad = true; break; }
      steps.push({
        open: Math.log(q.open / E), hi: Math.log(q.high / E),
        lo: Math.log(q.low / E), close: Math.log(q.close / E),
      });
    }
    if (bad) continue;
    out.push({ date: prices[i].time, weekday: wd, steps });
  }
  return out;
}

// ───────────────────────── バリアの適用（1経路） ─────────────────────────

export type Outcome = "tp" | "sl" | "timeout";

export interface TradeResult {
  outcome: Outcome;
  ret: number; // 実現対数リターン（約定は「バリア、ただし寄りで飛び越していたらその寄り」）
  steps: number; // 決着までのステップ数
  overshoot: number; // バリアを超えて滑った幅（対数リターン、0以上）
}

// 上バリア +a、下バリア −b（ともに対数リターン、a,b>0）で経路を辿る。
// 同一ステップ内でどちらが先かは分からないため tie で決め打ちし、上下から挟む。
export function applyBarrier(steps: PathStep[], a: number, b: number, tie: TieBreak): TradeResult {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const hitTP = s.hi >= a;
    const hitSL = s.lo <= -b;
    if (!hitTP && !hitSL) continue;
    // ステップの寄りが既にバリアを越えているなら、約定はその寄り（ギャップ・ジャンプ）。
    const fillTP = s.open >= a ? s.open : a;
    const fillSL = s.open <= -b ? s.open : -b;
    const takeTP = hitTP && (!hitSL || tie === "optimistic");
    if (takeTP) {
      return { outcome: "tp", ret: fillTP, steps: i + 1, overshoot: Math.max(0, fillTP - a) };
    }
    return { outcome: "sl", ret: fillSL, steps: i + 1, overshoot: Math.max(0, -b - fillSL) };
  }
  const last = steps[steps.length - 1];
  return { outcome: "timeout", ret: last.close, steps: steps.length, overshoot: 0 };
}

// ───────────────────────── 曜日別の期間ボラ σ√H ─────────────────────────

export interface HorizonVol {
  byWeekday: Record<number, number>; // 曜日別 σ√H（時間切りまでの実現リターンの標準偏差）
  pooled: number;
  nByWeekday: Record<number, number>;
}

export function horizonVol(paths: BarrierPath[]): HorizonVol {
  const byWeekday: Record<number, number> = {};
  const nByWeekday: Record<number, number> = {};
  const all: number[] = [];
  for (const wd of WD_ORDER) {
    const rs = paths.filter((p) => p.weekday === wd).map((p) => p.steps[p.steps.length - 1].close);
    byWeekday[wd] = rs.length >= 3 ? std(rs) : 0;
    nByWeekday[wd] = rs.length;
    all.push(...rs);
  }
  return { byWeekday, pooled: all.length >= 3 ? std(all) : 0, nByWeekday };
}

// ───────────────────────── 集計（1つの (a,b) に対する実測量） ─────────────────────────

export interface BarrierStats {
  n: number;
  nTp: number;
  nSl: number;
  nTimeout: number;
  pHat: number; // 決着した取引のうちTPだった割合（時間切りは除く）
  nResolved: number;
  expPerTrade: number; // 1トレードの平均対数リターン
  expPerTime: number; // 単位時間(H)あたり期待値 = expPerTrade / meanTauH
  meanTauH: number; // 平均滞在（Hの倍数）
  sdPerTrade: number;
  winRate: number; // ret>0 の割合（時間切ちも含む）
  overshootMean: number; // 平均オーバーシュート（σ√H単位）
  rets: number[];
  tauH: number[];
  overshoots: number[];
}

// cost は往復コスト(対数リターン単位)。expPerTrade から差し引く。
export function aggregate(
  paths: BarrierPath[], a: number, b: number, tie: TieBreak, cost: number, hv: number
): BarrierStats {
  const rets: number[] = [], tauH: number[] = [], overshoots: number[] = [];
  let nTp = 0, nSl = 0, nTo = 0;
  for (const p of paths) {
    const r = applyBarrier(p.steps, a, b, tie);
    rets.push(r.ret - cost);
    tauH.push(r.steps / p.steps.length); // 1経路の全長を H=1 とする
    if (hv > 0 && r.overshoot > 0) overshoots.push(r.overshoot / hv);
    else overshoots.push(0);
    if (r.outcome === "tp") nTp++; else if (r.outcome === "sl") nSl++; else nTo++;
  }
  const n = rets.length;
  const mTau = n ? mean(tauH) : 0;
  const mRet = n ? mean(rets) : 0;
  const nResolved = nTp + nSl;
  return {
    n, nTp, nSl, nTimeout: nTo,
    pHat: nResolved > 0 ? nTp / nResolved : 0,
    nResolved,
    expPerTrade: mRet,
    expPerTime: mTau > 0 ? mRet / mTau : 0,
    meanTauH: mTau,
    sdPerTrade: n >= 3 ? std(rets) : 0,
    winRate: n ? rets.filter((r) => r > 0).length / n : 0,
    overshootMean: overshoots.length ? mean(overshoots) : 0,
    rets, tauH, overshoots,
  };
}

// ───────────────────────── 層1: 格子探索とσ正規化 ─────────────────────────

export interface GridCell {
  ai: number; bi: number; // 格子添字
  A: number; B: number; // σ単位のバリア幅
  tpPct: number; slPct: number; // 実際に使った絶対幅（対数リターン）
  expPerTrade: number;
  expPerTime: number;
  winRate: number;
  meanTauH: number;
  n: number;
}

export interface BestCell {
  A: number; B: number; tpPct: number; slPct: number;
  expPerTime: number; expPerTrade: number; winRate: number; meanTauH: number;
  ai: number; bi: number;
  interior: boolean; // 格子の内点か（縁でないか）
}

export interface WeekdayLayer1 {
  weekday: number;
  n: number;
  hv: number; // その曜日の σ√H
  // %固定の格子（全曜日共通の絶対幅）で探した best
  bestPct: BestCell | null;
  // σ単位の格子（曜日別の幅）で探した best
  bestSig: BestCell | null;
  // bestPct をσ単位に直した値（= tpPct / hv）
  pctBestAsSigma: { A: number; B: number } | null;
}

export interface Layer1Result {
  aLevels: number[]; // σ単位の格子（共通）
  bLevels: number[];
  byWeekday: WeekdayLayer1[];
  pooledGrid: GridCell[][]; // 全曜日プールのσ単位格子（[ai][bi]）
  pooledBest: BestCell | null;
  // 「%ではばらつく best が σ単位では一点に集まるか」の検定
  dispersion: {
    k: number; // 曜日数
    varLogPct: number; // Var[log TP%]（曜日間）
    varLogSig: number; // Var[log A]（曜日間）
    f: number; // varLogPct / varLogSig
    p: number; // F(k−1,k−1) 上側
    cvPct: number; // 参考: 変動係数
    cvSig: number;
    collapses: boolean; // σ正規化で有意に縮んだか
  } | null;
}

function levels(nGrid: number, lo: number, hi: number): number[] {
  if (nGrid <= 1) return [hi];
  return Array.from({ length: nGrid }, (_, i) => lo + ((hi - lo) * i) / (nGrid - 1));
}

function searchGrid(
  paths: BarrierPath[], aLv: number[], bLv: number[], hvForBarrier: number,
  tie: TieBreak, cost: number
): { grid: GridCell[][]; best: BestCell | null } {
  const grid: GridCell[][] = [];
  let best: BestCell | null = null;
  for (let ai = 0; ai < aLv.length; ai++) {
    const row: GridCell[] = [];
    for (let bi = 0; bi < bLv.length; bi++) {
      const a = aLv[ai] * hvForBarrier, b = bLv[bi] * hvForBarrier;
      const st = aggregate(paths, a, b, tie, cost, hvForBarrier);
      const cell: GridCell = {
        ai, bi, A: aLv[ai], B: bLv[bi], tpPct: a, slPct: b,
        expPerTrade: st.expPerTrade, expPerTime: st.expPerTime,
        winRate: st.winRate, meanTauH: st.meanTauH, n: st.n,
      };
      row.push(cell);
      if (!best || cell.expPerTime > best.expPerTime) {
        best = {
          A: cell.A, B: cell.B, tpPct: a, slPct: b,
          expPerTime: cell.expPerTime, expPerTrade: cell.expPerTrade,
          winRate: cell.winRate, meanTauH: cell.meanTauH, ai, bi,
          interior: ai > 0 && ai < aLv.length - 1 && bi > 0 && bi < bLv.length - 1,
        };
      }
    }
    grid.push(row);
  }
  return { grid, best };
}

export function runLayer1(
  paths: BarrierPath[], hv: HorizonVol, nGrid: number, aMax: number,
  tie: TieBreak, cost: number
): Layer1Result {
  const aLv = levels(nGrid, 0.25, aMax);
  const bLv = levels(nGrid, 0.25, aMax);

  const byWeekday: WeekdayLayer1[] = WD_ORDER.map((wd) => {
    const sub = paths.filter((p) => p.weekday === wd);
    const h = hv.byWeekday[wd] || 0;
    if (sub.length < 20 || h <= 0) {
      return { weekday: wd, n: sub.length, hv: h, bestPct: null, bestSig: null, pctBestAsSigma: null };
    }
    // %固定: 全曜日共通の絶対幅（プールσで作った格子）で探索する
    const pct = searchGrid(sub, aLv, bLv, hv.pooled, tie, cost);
    // σ単位: その曜日のσで幅を作って探索する
    const sig = searchGrid(sub, aLv, bLv, h, tie, cost);
    return {
      weekday: wd, n: sub.length, hv: h,
      bestPct: pct.best, bestSig: sig.best,
      pctBestAsSigma: pct.best ? { A: pct.best.tpPct / h, B: pct.best.slPct / h } : null,
    };
  });

  const pooled = searchGrid(paths, aLv, bLv, hv.pooled, tie, cost);

  // 分散比: log TP%（%単位のばらつき） vs log A（σ正規化後のばらつき）
  // log TP% = log A + log σ_dow なので、対数を取れば両者は同じ単位で比較できる。
  const usable = byWeekday.filter((w) => w.bestPct && w.pctBestAsSigma && w.hv > 0);
  let dispersion: Layer1Result["dispersion"] = null;
  if (usable.length >= 3) {
    const logPct = usable.map((w) => Math.log(w.bestPct!.tpPct));
    const logSig = usable.map((w) => Math.log(w.pctBestAsSigma!.A));
    const vP = std(logPct) ** 2, vS = std(logSig) ** 2;
    const k = usable.length;
    const f = vS > 0 ? vP / vS : 0;
    const pctVals = usable.map((w) => w.bestPct!.tpPct);
    const sigVals = usable.map((w) => w.pctBestAsSigma!.A);
    dispersion = {
      k,
      varLogPct: vP, varLogSig: vS, f,
      p: f > 0 ? fSurvival(f, k - 1, k - 1) : 1,
      cvPct: mean(pctVals) > 0 ? std(pctVals) / mean(pctVals) : 0,
      cvSig: mean(sigVals) > 0 ? std(sigVals) / mean(sigVals) : 0,
      collapses: f > 1 && fSurvival(f, k - 1, k - 1) < 0.05,
    };
  }

  return { aLevels: aLv, bLevels: bLv, byWeekday, pooledGrid: pooled.grid, pooledBest: pooled.best, dispersion };
}

// ───────────────────────── 層2: 理論からの逸脱 ─────────────────────────

export interface DeviationRow {
  weekday: number;
  n: number;
  nResolved: number;
  timeoutShare: number;
  // 到達確率
  pHat: number;
  pTheory: number; // B/(A+B)
  pSe: number;
  pZ: number;
  pP: number;
  // 期待滞在（Hの倍数）
  tauHat: number;
  tauTheory: number; // AB（Hの倍数）
  tauSe: number;
  tauT: number;
  tauP: number;
  // オーバーシュート（σ√H単位）
  overMean: number;
  overSe: number;
  overP: number;
}

export interface Layer2Result {
  A: number; B: number;
  rows: DeviationRow[];
  // 曜日間の差だけを検定する（水準そのものは μ 混入で解釈できない）
  cochranQ: number; // 到達確率の曜日間一致性
  cochranDf: number;
  cochranP: number;
  tauF: number; // 滞在時間の一元配置ANOVA
  tauFdf1: number; tauFdf2: number; tauFp: number;
  kruskalH: number; // オーバーシュートの Kruskal-Wallis
  kruskalDf: number; kruskalP: number;
  pAdj: number[]; // 上記3つのFDR補正後p（順: 到達確率/滞在/オーバーシュート）
  overlapFactor: number; // 重なり窓のSE膨張係数(√H)。日中モードは1
}

// 一元配置分散分析のF統計量。
function anovaF(groups: number[][]): { f: number; df1: number; df2: number; p: number } | null {
  const gs = groups.filter((g) => g.length >= 2);
  if (gs.length < 2) return null;
  const all = gs.flat();
  const gm = mean(all);
  let ssb = 0, ssw = 0;
  for (const g of gs) {
    const m = mean(g);
    ssb += g.length * (m - gm) ** 2;
    for (const v of g) ssw += (v - m) ** 2;
  }
  const df1 = gs.length - 1, df2 = all.length - gs.length;
  if (df2 <= 0 || ssw <= 0) return null;
  const f = (ssb / df1) / (ssw / df2);
  return { f, df1, df2, p: fSurvival(f, df1, df2) };
}

// Kruskal-Wallis 検定（順位に基づく分布の位置の差。正規性を仮定しない）。
function kruskalWallis(groups: number[][]): { h: number; df: number; p: number } | null {
  const gs = groups.filter((g) => g.length >= 2);
  if (gs.length < 2) return null;
  const all: { v: number; g: number }[] = [];
  gs.forEach((g, gi) => g.forEach((v) => all.push({ v, g: gi })));
  all.sort((x, y) => x.v - y.v);
  const N = all.length;
  // 平均順位（同値はタイ補正）
  const ranks = new Array(N).fill(0);
  let i = 0;
  const tieGroups: number[] = [];
  while (i < N) {
    let j = i;
    while (j + 1 < N && all[j + 1].v === all[i].v) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = r;
    if (j > i) tieGroups.push(j - i + 1);
    i = j + 1;
  }
  const sums = new Array(gs.length).fill(0);
  const ns = new Array(gs.length).fill(0);
  all.forEach((o, k) => { sums[o.g] += ranks[k]; ns[o.g]++; });
  let h = 0;
  for (let g = 0; g < gs.length; g++) h += (sums[g] * sums[g]) / ns[g];
  h = (12 / (N * (N + 1))) * h - 3 * (N + 1);
  // タイ補正
  const tieCorr = 1 - tieGroups.reduce((s, t) => s + (t ** 3 - t), 0) / (N ** 3 - N);
  if (tieCorr > 0) h /= tieCorr;
  const df = gs.length - 1;
  return { h, df, p: chiSquareSurvival(h, df) };
}

// Cochran の Q（k群の二項比率が等しいかの検定）。
// ここでは各曜日の「決着した取引のうちTP割合」を比較する。群サイズが異なるため
// 比率の重み付き χ² 統計量（Cochran 1954 の等質性検定）を用いる。
function cochranQProportions(succ: number[], tot: number[]): { q: number; df: number; p: number } | null {
  const idx = tot.map((t, i) => i).filter((i) => tot[i] >= 5);
  if (idx.length < 2) return null;
  const S = idx.reduce((s, i) => s + succ[i], 0);
  const N = idx.reduce((s, i) => s + tot[i], 0);
  const pBar = S / N;
  if (pBar <= 0 || pBar >= 1) return null;
  let q = 0;
  for (const i of idx) q += (tot[i] * (succ[i] / tot[i] - pBar) ** 2) / (pBar * (1 - pBar));
  const df = idx.length - 1;
  return { q, df, p: chiSquareSurvival(q, df) };
}

export function runLayer2(
  paths: BarrierPath[], hv: HorizonVol, A: number, B: number,
  tie: TieBreak, cost: number, overlapFactor: number
): Layer2Result {
  const pTheory = B / (A + B);
  const tauTheory = A * B; // Hの倍数
  const rows: DeviationRow[] = [];
  const tauGroups: number[][] = [];
  const overGroups: number[][] = [];
  const succ: number[] = [], tot: number[] = [];

  for (const wd of WD_ORDER) {
    const sub = paths.filter((p) => p.weekday === wd);
    const h = hv.byWeekday[wd] || 0;
    if (sub.length < 10 || h <= 0) {
      rows.push({
        weekday: wd, n: sub.length, nResolved: 0, timeoutShare: 0,
        pHat: 0, pTheory, pSe: NaN, pZ: 0, pP: 1,
        tauHat: 0, tauTheory, tauSe: NaN, tauT: 0, tauP: 1,
        overMean: 0, overSe: NaN, overP: 1,
      });
      succ.push(0); tot.push(0);
      tauGroups.push([]); overGroups.push([]);
      continue;
    }
    const st = aggregate(sub, A * h, B * h, tie, cost, h);
    // 到達確率: 二項の SE。重なり窓なら実効標本を 1/overlapFactor² に割り引く。
    const nEff = st.nResolved / (overlapFactor * overlapFactor);
    const pSe = nEff > 0 ? Math.sqrt((pTheory * (1 - pTheory)) / nEff) : NaN;
    const pZ = pSe > 0 ? (st.pHat - pTheory) / pSe : 0;
    // 期待滞在: 平均の t。理論値は AB（Hの倍数）。打ち切りがあるので上限1。
    const tSd = std(st.tauH);
    const tauSe = st.n > 1 ? (tSd / Math.sqrt(st.n)) * overlapFactor : NaN;
    const tauT = tauSe > 0 ? (st.meanTauH - Math.min(1, tauTheory)) / tauSe : 0;
    // オーバーシュート: 0 との差
    const ov = st.overshoots;
    const ovSe = ov.length > 1 ? (std(ov) / Math.sqrt(ov.length)) * overlapFactor : NaN;
    const ovT = tTest(ov);
    rows.push({
      weekday: wd, n: st.n, nResolved: st.nResolved,
      timeoutShare: st.n ? st.nTimeout / st.n : 0,
      pHat: st.pHat, pTheory, pSe, pZ, pP: normalTwoSidedP(pZ),
      tauHat: st.meanTauH, tauTheory, tauSe, tauT,
      tauP: st.n > 2 ? studentTwoSidedP(tauT, st.n - 1) : 1,
      overMean: st.overshootMean, overSe: ovSe,
      overP: ovT ? Math.min(1, ovT.p * overlapFactor) : 1,
    });
    succ.push(st.nTp); tot.push(st.nResolved);
    tauGroups.push(st.tauH);
    overGroups.push(ov);
  }

  const cq = cochranQProportions(succ, tot);
  const af = anovaF(tauGroups);
  const kw = kruskalWallis(overGroups);
  const raw = [cq ? cq.p : 1, af ? af.p : 1, kw ? kw.p : 1];
  return {
    A, B, rows,
    cochranQ: cq ? cq.q : 0, cochranDf: cq ? cq.df : 0, cochranP: cq ? cq.p : 1,
    tauF: af ? af.f : 0, tauFdf1: af ? af.df1 : 0, tauFdf2: af ? af.df2 : 0, tauFp: af ? af.p : 1,
    kruskalH: kw ? kw.h : 0, kruskalDf: kw ? kw.df : 0, kruskalP: kw ? kw.p : 1,
    pAdj: benjaminiHochberg(raw),
    overlapFactor,
  };
}

// ───────────────────────── 層3: ヌル較正・内点性・OOS ─────────────────────────

export interface NullSummary {
  n: number;
  // 曜日ラベル破壊サロゲート
  bestExpPerTime: number[]; // 各サロゲートの「曜日別best の平均」（昇順）
  dispF: number[]; // 各サロゲートの分散比F（昇順）
  cochranQ: number[]; // 各サロゲートの到達確率Cochran Q（昇順）
  tauF: number[]; // 各サロゲートの滞在時間ANOVA F（昇順）
  // 実測の分位点（0..1）
  pctBestExp: number;
  pctDispF: number;
  pctCochran: number;
  pctTauF: number;
}

export interface BrownianSummary {
  n: number;
  interiorShare: number; // 一致BMヌルで内点解が出た割合
  bestExpPerTime: number[]; // 昇順
  pctBestExp: number; // 実測プールbestの分位点
  actualInterior: boolean;
  // 離散化＋打ち切りの機械的効果を測るための、ヌルにおける実測量の中央値
  medPHat: number;
  medTauH: number;
  medOvershoot: number;
}

export interface OosRow {
  label: string;
  n: number;
  expPerTrade: number;
  expPerTime: number;
  sharpePerTrade: number;
  winRate: number;
  meanTauH: number;
}

export interface Layer3Result {
  surrogate: NullSummary | null;
  brownian: BrownianSummary | null;
  oos: OosRow[];
}

function quantileOf(sorted: number[], v: number): number {
  if (sorted.length === 0) return 0.5;
  let k = 0;
  while (k < sorted.length && sorted[k] <= v) k++;
  return k / sorted.length;
}

// 曜日ラベルだけを破壊する（経路はそのまま）。曜日構造ゼロと分かっているデータになる。
function shuffleWeekdays(paths: BarrierPath[], rnd: () => number): BarrierPath[] {
  const wds = paths.map((p) => p.weekday);
  for (let i = wds.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [wds[i], wds[j]] = [wds[j], wds[i]];
  }
  return paths.map((p, i) => ({ ...p, weekday: wds[i] }));
}

// 一致ブラウン運動: 実測と同じ本数・同じステップ数・同じ1ステップσで iid ガウスを歩かせ、
// 各ステップ内は m 分割して高値/安値を作る。離散化・時間切り・同足同時到達の決着規則が
// 生む「見かけの逸脱」の量をここで測る。
function brownianPaths(
  template: BarrierPath[], stepSigma: number, rnd: () => number, m = 8
): BarrierPath[] {
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const sSub = stepSigma / Math.sqrt(m);
  return template.map((t) => {
    const steps: PathStep[] = [];
    let x = 0;
    for (let i = 0; i < t.steps.length; i++) {
      const open = x;
      let hi = x, lo = x;
      for (let k = 0; k < m; k++) {
        x += sSub * gauss();
        if (x > hi) hi = x;
        if (x < lo) lo = x;
      }
      steps.push({ open, hi, lo, close: x });
    }
    return { date: t.date, weekday: t.weekday, steps };
  });
}

export function runLayer3(
  paths: BarrierPath[], hv: HorizonVol, l1: Layer1Result, l2: Layer2Result,
  params: { nGrid: number; aMax: number; tie: TieBreak; cost: number; nSurrogate: number; nBrownian: number; seed: number },
  onProgress?: (done: number, total: number) => void
): Layer3Result {
  const { nGrid, aMax, tie, cost, nSurrogate, nBrownian, seed } = params;
  const total = nSurrogate + nBrownian;
  let done = 0;
  const tick = () => { done++; if (onProgress && done % 10 === 0) onProgress(done, total); };

  // ── ① 曜日ラベル破壊サロゲート ──
  let surrogate: NullSummary | null = null;
  if (nSurrogate > 0 && paths.length >= 50) {
    const rnd = mulberry32(seed);
    const bests: number[] = [], fs: number[] = [], qs: number[] = [], tfs: number[] = [];
    for (let b = 0; b < nSurrogate; b++) {
      const sur = shuffleWeekdays(paths, rnd);
      const hvS = horizonVol(sur);
      const s1 = runLayer1(sur, hvS, nGrid, aMax, tie, cost);
      const s2 = runLayer2(sur, hvS, l2.A, l2.B, tie, cost, l2.overlapFactor);
      const perWd = s1.byWeekday.map((w) => w.bestSig?.expPerTime).filter((v): v is number => v !== undefined);
      if (perWd.length) bests.push(mean(perWd));
      if (s1.dispersion) fs.push(s1.dispersion.f);
      qs.push(s2.cochranQ);
      tfs.push(s2.tauF);
      tick();
    }
    bests.sort((a, b) => a - b); fs.sort((a, b) => a - b); qs.sort((a, b) => a - b); tfs.sort((a, b) => a - b);
    const actBest = mean(
      l1.byWeekday.map((w) => w.bestSig?.expPerTime).filter((v): v is number => v !== undefined)
    );
    surrogate = {
      n: nSurrogate,
      bestExpPerTime: bests, dispF: fs, cochranQ: qs, tauF: tfs,
      pctBestExp: quantileOf(bests, actBest),
      pctDispF: l1.dispersion ? quantileOf(fs, l1.dispersion.f) : 0.5,
      pctCochran: quantileOf(qs, l2.cochranQ),
      pctTauF: quantileOf(tfs, l2.tauF),
    };
  } else {
    done += nSurrogate;
  }

  // ── ② 一致ブラウン運動ヌル（離散化・打ち切り・決着規則の効果を測る） ──
  let brownian: BrownianSummary | null = null;
  if (nBrownian > 0 && paths.length >= 50 && hv.pooled > 0) {
    const rnd = mulberry32(seed ^ 0x5bf03635);
    const stepsPer = mean(paths.map((p) => p.steps.length));
    const stepSigma = hv.pooled / Math.sqrt(Math.max(1, stepsPer));
    const bests: number[] = [];
    let interior = 0;
    const ps: number[] = [], taus: number[] = [], ovs: number[] = [];
    for (let b = 0; b < nBrownian; b++) {
      const bp = brownianPaths(paths, stepSigma, rnd);
      const hvB = horizonVol(bp);
      const g = searchGrid(bp, l1.aLevels, l1.bLevels, hvB.pooled || hv.pooled, tie, cost);
      if (g.best) {
        bests.push(g.best.expPerTime);
        if (g.best.interior) interior++;
      }
      const st = aggregate(bp, l2.A * (hvB.pooled || hv.pooled), l2.B * (hvB.pooled || hv.pooled), tie, cost, hvB.pooled || hv.pooled);
      ps.push(st.pHat); taus.push(st.meanTauH); ovs.push(st.overshootMean);
      tick();
    }
    bests.sort((a, b) => a - b);
    const med = (v: number[]) => {
      if (!v.length) return 0;
      const s = [...v].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    brownian = {
      n: nBrownian,
      interiorShare: bests.length ? interior / bests.length : 0,
      bestExpPerTime: bests,
      pctBestExp: l1.pooledBest ? quantileOf(bests, l1.pooledBest.expPerTime) : 0.5,
      actualInterior: l1.pooledBest ? l1.pooledBest.interior : false,
      medPHat: med(ps), medTauH: med(taus), medOvershoot: med(ovs),
    };
  }

  // ── ③ インターリーブ2分割OOS ──
  const oos = runOos(paths, l1.aLevels, l1.bLevels, tie, cost);
  if (onProgress) onProgress(total, total);
  return { surrogate, brownian, oos };
}

// 偶数番目で学習→奇数番目で検定、逆も。曜日別バリア／共通バリア／バリアなしを比較する。
function runOos(
  paths: BarrierPath[], aLv: number[], bLv: number[], tie: TieBreak, cost: number
): OosRow[] {
  const even = paths.filter((_, i) => i % 2 === 0);
  const odd = paths.filter((_, i) => i % 2 === 1);
  if (even.length < 30 || odd.length < 30) return [];

  const collect = (
    train: BarrierPath[], test: BarrierPath[], mode: "perWd" | "pooled" | "none"
  ): { rets: number[]; taus: number[] } => {
    const rets: number[] = [], taus: number[] = [];
    const hvTr = horizonVol(train), hvTe = horizonVol(test);
    if (mode === "none") {
      for (const p of test) {
        rets.push(p.steps[p.steps.length - 1].close - cost);
        taus.push(1);
      }
      return { rets, taus };
    }
    if (mode === "pooled") {
      const g = searchGrid(train, aLv, bLv, hvTr.pooled, tie, cost);
      if (!g.best) return { rets, taus };
      for (const p of test) {
        const h = hvTe.pooled || hvTr.pooled;
        const r = applyBarrier(p.steps, g.best.A * h, g.best.B * h, tie);
        rets.push(r.ret - cost);
        taus.push(r.steps / p.steps.length);
      }
      return { rets, taus };
    }
    // 曜日別: 学習側で曜日ごとに best を出し、検定側の同じ曜日に当てる
    const bestByWd = new Map<number, BestCell>();
    for (const wd of WD_ORDER) {
      const sub = train.filter((p) => p.weekday === wd);
      const h = hvTr.byWeekday[wd] || 0;
      if (sub.length < 15 || h <= 0) continue;
      const g = searchGrid(sub, aLv, bLv, h, tie, cost);
      if (g.best) bestByWd.set(wd, g.best);
    }
    for (const p of test) {
      const bc = bestByWd.get(p.weekday);
      const h = hvTe.byWeekday[p.weekday] || hvTe.pooled;
      if (!bc || h <= 0) continue;
      const r = applyBarrier(p.steps, bc.A * h, bc.B * h, tie);
      rets.push(r.ret - cost);
      taus.push(r.steps / p.steps.length);
    }
    return { rets, taus };
  };

  const rows: OosRow[] = [];
  const specs: { label: string; mode: "perWd" | "pooled" | "none" }[] = [
    { label: "曜日別バリア（曜日ごとに最適A,B）", mode: "perWd" },
    { label: "全曜日共通バリア", mode: "pooled" },
    { label: "バリアなし（時間切りのみ）", mode: "none" },
  ];
  for (const s of specs) {
    const a = collect(even, odd, s.mode);
    const b = collect(odd, even, s.mode);
    const rets = [...a.rets, ...b.rets], taus = [...a.taus, ...b.taus];
    const n = rets.length;
    const m = n ? mean(rets) : 0;
    const sd = n >= 3 ? std(rets) : 0;
    const mt = n ? mean(taus) : 0;
    rows.push({
      label: s.label, n,
      expPerTrade: m,
      expPerTime: mt > 0 ? m / mt : 0,
      sharpePerTrade: sd > 0 ? m / sd : 0,
      winRate: n ? rets.filter((r) => r > 0).length / n : 0,
      meanTauH: mt,
    });
  }
  return rows;
}

// ───────────────────────── 全体オーケストレーション（Workerから呼ぶ） ─────────────────────────

export interface BarrierParams {
  mode: BarrierMode;
  hDays: number; // 数日モードの保有営業日数（日中モードは1）
  tie: TieBreak;
  costBp: number; // 往復コスト(bp)
  nGrid: number;
  aMax: number;
  refA: number; // 層2で使う基準バリア
  refB: number;
  nSurrogate: number;
  nBrownian: number;
  seed: number;
}

export interface BarrierResult {
  ok: boolean;
  reason?: string;
  mode: BarrierMode;
  n: number;
  from: string;
  to: string;
  hv: HorizonVol;
  muPerH: number; // 1期間(H)あたりの平均対数リターン（時間切りのみの実現値）
  sigmaPerH: number;
  layer1: Layer1Result | null;
  layer2: Layer2Result | null;
  layer3: Layer3Result | null;
  overlapFactor: number;
}

export function emptyBarrierResult(mode: BarrierMode, reason: string): BarrierResult {
  return {
    ok: false, reason, mode, n: 0, from: "", to: "",
    hv: { byWeekday: {}, pooled: 0, nByWeekday: {} },
    muPerH: 0, sigmaPerH: 0, layer1: null, layer2: null, layer3: null, overlapFactor: 1,
  };
}

export function runWeekdayBarrier(
  paths: BarrierPath[], params: BarrierParams,
  onProgress?: (done: number, total: number) => void
): BarrierResult {
  if (paths.length < 60) {
    return emptyBarrierResult(params.mode, `経路が不足（${paths.length}本。60本以上必要）`);
  }
  const hv = horizonVol(paths);
  if (!(hv.pooled > 0)) return emptyBarrierResult(params.mode, "ボラティリティを推定できません");

  const cost = params.costBp / 10000;
  // 重なり窓のSE膨張。日中モードは各日1本で独立なので1、数日モードは √H。
  const overlapFactor = params.mode === "multiday" ? Math.sqrt(params.hDays) : 1;

  const timeoutRets = paths.map((p) => p.steps[p.steps.length - 1].close);
  const layer1 = runLayer1(paths, hv, params.nGrid, params.aMax, params.tie, cost);
  const layer2 = runLayer2(paths, hv, params.refA, params.refB, params.tie, cost, overlapFactor);
  const layer3 = runLayer3(paths, hv, layer1, layer2, {
    nGrid: params.nGrid, aMax: params.aMax, tie: params.tie, cost,
    nSurrogate: params.nSurrogate, nBrownian: params.nBrownian, seed: params.seed,
  }, onProgress);

  return {
    ok: true,
    mode: params.mode,
    n: paths.length,
    from: paths[0].date,
    to: paths[paths.length - 1].date,
    hv,
    muPerH: mean(timeoutRets),
    sigmaPerH: hv.pooled,
    layer1, layer2, layer3,
    overlapFactor,
  };
}
