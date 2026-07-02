// A. 条件ペア交互作用スキャナ。
// 2つの状態軸(RSI帯・ボラ・曜日・カレンダー等)の全ペアを総当たりし、各結合セルの
// N日先フォワードリターンを集計する。単なる平均ではなく「交互作用項」——
//   interaction = セル平均 − (行周辺平均 + 列周辺平均 − 総平均)
// ——を抽出し、2条件を独立に足しただけでは説明できない“相乗”のみを検出する。
// 全ペア横断で多重比較補正(BH-FDR)し、偽の掛け合わせをふるい落とす。
//
// 先読みバイアス回避: 状態は i 日終値時点で確定する情報のみ。フォワードは
// close: C[i]→C[i+N] / open: O[i+1]→O[i+1+N]。

import { PricePoint } from "./types";
import { StateAxis, StateFn, buildStateFn } from "./conditional-forward-returns";
import { mean, tTest, benjaminiHochberg, quantileSorted } from "./stats-significance";

export type ScanAxis = StateAxis | "weekday";

export interface AxisDesc { value: ScanAxis; label: string; }

// スキャン対象の軸カタログ(buildScanStateFn が対応する軸のみ)
export const SCAN_AXES: AxisDesc[] = [
  { value: "rsi", label: "RSI(14)帯" },
  { value: "rsi2", label: "RSI(2)帯" },
  { value: "vol", label: "ボラレジーム" },
  { value: "maDist", label: "200日線乖離" },
  { value: "trend", label: "トレンド状態" },
  { value: "bbPercentB", label: "ボリンジャー%b" },
  { value: "prevRet", label: "前日リターン分位" },
  { value: "downStreak", label: "連続下落日数" },
  { value: "pctFromHigh", label: "高値からの下落" },
  { value: "tsMom", label: "12-1ヶ月モメンタム" },
  { value: "dist52w", label: "52週高値からの距離" },
  { value: "maAlign", label: "移動平均配列" },
  { value: "candleRun", label: "陽連/陰連" },
  { value: "monthPhase", label: "月末/月初" },
  { value: "season", label: "季節(Sell in May)" },
  { value: "weekday", label: "曜日" },
];

const DOW_LABELS = ["", "月", "火", "水", "木", "金"];

function buildScanStateFn(prices: PricePoint[], axis: ScanAxis): StateFn {
  if (axis === "weekday") {
    const order = ["月", "火", "水", "木", "金"];
    return {
      order,
      stateOf: (i) => {
        const d = new Date(prices[i].time).getDay();
        return d >= 1 && d <= 5 ? DOW_LABELS[d] : null;
      },
    };
  }
  return buildStateFn(prices, axis as StateAxis);
}

export interface InteractionCell {
  axisX: ScanAxis; axisY: ScanAxis;
  axisXLabel: string; axisYLabel: string;
  labelX: string; labelY: string;
  n: number;
  meanFwd: number;
  baseline: number;      // そのペアの全標本平均
  additive: number;      // 行周辺 + 列周辺 − 総平均(独立仮定の予測)
  interaction: number;   // meanFwd − additive
  winRate: number;
  t: number;             // 交互作用の t(セル vs 加法予測)
  p: number;
  pAdj: number;
  ciLo: number | null;   // 交互作用の95%ブートCI
  ciHi: number | null;
  isNow: boolean;        // 現在の状態が属するセルか
}

export interface InteractionScanResult {
  cells: InteractionCell[];   // ソート済
  nTested: number;            // FDRの母数
  nSignificant: number;
  horizon: number;
  entry: "close" | "open";
}

export type InteractionSort = "pAdj" | "absInteraction" | "absMean";

export interface InteractionScanOptions {
  horizon?: number;
  entry?: "close" | "open";
  minN?: number;
  sort?: InteractionSort;
  bootstrapTopN?: number;
  boot?: number;
}

// 移動ブロック・ブートストラップで配列平均の95%CIを推定
function blockBootCI(arr: number[], B: number): { lo: number; hi: number } | null {
  const n = arr.length;
  if (n < 8) return null;
  const L = Math.max(1, Math.round(Math.cbrt(n)));
  const nBlocks = Math.ceil(n / L);
  const samples: number[] = [];
  for (let b = 0; b < B; b++) {
    let sum = 0, cnt = 0;
    for (let blk = 0; blk < nBlocks && cnt < n; blk++) {
      const start = Math.floor(Math.random() * n);
      for (let j = 0; j < L && cnt < n; j++) { sum += arr[(start + j) % n]; cnt++; }
    }
    samples.push(sum / cnt);
  }
  samples.sort((a, b) => a - b);
  return { lo: quantileSorted(samples, 0.025), hi: quantileSorted(samples, 0.975) };
}

export function scanInteractions(
  prices: PricePoint[],
  opts: InteractionScanOptions = {},
): InteractionScanResult {
  const horizon = opts.horizon ?? 5;
  const entry = opts.entry ?? "close";
  const minN = opts.minN ?? 20;
  const sort: InteractionSort = opts.sort ?? "pAdj";
  const boot = opts.boot ?? 600;
  const bootstrapTopN = opts.bootstrapTopN ?? 40;
  const n = prices.length;

  const lastUsable = entry === "close" ? n - horizon - 1 : n - horizon - 2;
  const fwd = (i: number): number | null => {
    let ep: number, xp: number;
    if (entry === "close") { ep = prices[i].close; xp = prices[i + horizon].close; }
    else { ep = prices[i + 1].open; xp = prices[i + 1 + horizon].open; }
    if (!(ep > 0) || !(xp > 0)) return null;
    return (xp - ep) / ep;
  };

  // 軸ごとの StateFn を一度だけ構築
  const fns = new Map<ScanAxis, StateFn>();
  for (const a of SCAN_AXES) fns.set(a.value, buildScanStateFn(prices, a.value));

  const lastLabel = (s: StateFn): string | null => {
    for (let i = n - 1; i >= 0; i--) { const l = s.stateOf(i); if (l !== null) return l; }
    return null;
  };

  interface Raw extends Omit<InteractionCell, "pAdj" | "ciLo" | "ciHi"> { rets: number[]; }
  const raws: Raw[] = [];

  for (let a = 0; a < SCAN_AXES.length; a++) {
    for (let b = a + 1; b < SCAN_AXES.length; b++) {
      const ax = SCAN_AXES[a], ay = SCAN_AXES[b];
      const sx = fns.get(ax.value)!, sy = fns.get(ay.value)!;
      const cell = new Map<string, number[]>();
      const rowArr = new Map<string, number[]>();
      const colArr = new Map<string, number[]>();
      const all: number[] = [];
      for (let i = 0; i <= lastUsable; i++) {
        const lx = sx.stateOf(i), ly = sy.stateOf(i);
        if (lx === null || ly === null) continue;
        const r = fwd(i);
        if (r === null) continue;
        (cell.get(`${lx}||${ly}`) ?? cell.set(`${lx}||${ly}`, []).get(`${lx}||${ly}`)!).push(r);
        (rowArr.get(lx) ?? rowArr.set(lx, []).get(lx)!).push(r);
        (colArr.get(ly) ?? colArr.set(ly, []).get(ly)!).push(r);
        all.push(r);
      }
      if (all.length < minN) continue;
      const grand = mean(all);
      const nowX = lastLabel(sx), nowY = lastLabel(sy);

      for (const lx of sx.order) for (const ly of sy.order) {
        const arr = cell.get(`${lx}||${ly}`);
        if (!arr || arr.length < minN) continue;
        const rowM = mean(rowArr.get(lx)!);
        const colM = mean(colArr.get(ly)!);
        const additive = rowM + colM - grand;
        const m = mean(arr);
        const interaction = m - additive;
        // 交互作用の有意性: セルリターンを加法予測ぶんシフトして0との差を検定
        const shifted = arr.map((r) => r - additive);
        const tt = tTest(shifted);
        raws.push({
          axisX: ax.value, axisY: ay.value,
          axisXLabel: ax.label, axisYLabel: ay.label,
          labelX: lx, labelY: ly,
          n: arr.length,
          meanFwd: m, baseline: grand, additive, interaction,
          winRate: arr.filter((r) => r > 0).length / arr.length,
          t: tt ? tt.t : 0, p: tt ? tt.p : 1,
          isNow: lx === nowX && ly === nowY,
          rets: shifted,
        });
      }
    }
  }

  const pAdj = benjaminiHochberg(raws.map((r) => r.p));

  // |t|上位のみブートCI(交互作用ぶんシフト済配列)
  const tOrder = raws.map((_, i) => i).sort((a, b) => Math.abs(raws[b].t) - Math.abs(raws[a].t));
  const bootSet = new Set(tOrder.slice(0, bootstrapTopN));

  const cells: InteractionCell[] = raws.map((r, i) => {
    const ci = bootSet.has(i) ? blockBootCI(r.rets, boot) : null;
    const { rets, ...rest } = r; void rets;
    return { ...rest, pAdj: pAdj[i], ciLo: ci ? ci.lo : null, ciHi: ci ? ci.hi : null };
  });

  const sorters: Record<InteractionSort, (a: InteractionCell, b: InteractionCell) => number> = {
    pAdj: (a, b) => a.pAdj - b.pAdj || Math.abs(b.interaction) - Math.abs(a.interaction),
    absInteraction: (a, b) => Math.abs(b.interaction) - Math.abs(a.interaction),
    absMean: (a, b) => Math.abs(b.meanFwd) - Math.abs(a.meanFwd),
  };
  cells.sort(sorters[sort]);

  return {
    cells,
    nTested: raws.length,
    nSignificant: cells.filter((c) => c.pAdj < 0.05).length,
    horizon,
    entry,
  };
}

// 選択ペアのヒートマップ用: 行×列の平均フォワードと交互作用を返す
export interface PairGrid {
  xOrder: string[]; yOrder: string[];
  meanCells: Map<string, { mean: number; interaction: number; n: number; p: number }>;
  baseline: number;
  nowX: string | null; nowY: string | null;
  maxAbsMean: number;
}

export function buildPairGrid(
  prices: PricePoint[],
  axisX: ScanAxis,
  axisY: ScanAxis,
  horizon: number,
  entry: "close" | "open",
  minN: number,
): PairGrid {
  const n = prices.length;
  const sx = buildScanStateFn(prices, axisX);
  const sy = buildScanStateFn(prices, axisY);
  const lastUsable = entry === "close" ? n - horizon - 1 : n - horizon - 2;
  const fwd = (i: number): number | null => {
    let ep: number, xp: number;
    if (entry === "close") { ep = prices[i].close; xp = prices[i + horizon].close; }
    else { ep = prices[i + 1].open; xp = prices[i + 1 + horizon].open; }
    if (!(ep > 0) || !(xp > 0)) return null;
    return (xp - ep) / ep;
  };
  const cell = new Map<string, number[]>();
  const rowArr = new Map<string, number[]>();
  const colArr = new Map<string, number[]>();
  const all: number[] = [];
  for (let i = 0; i <= lastUsable; i++) {
    const lx = sx.stateOf(i), ly = sy.stateOf(i);
    if (lx === null || ly === null) continue;
    const r = fwd(i);
    if (r === null) continue;
    (cell.get(`${lx}||${ly}`) ?? cell.set(`${lx}||${ly}`, []).get(`${lx}||${ly}`)!).push(r);
    (rowArr.get(lx) ?? rowArr.set(lx, []).get(lx)!).push(r);
    (colArr.get(ly) ?? colArr.set(ly, []).get(ly)!).push(r);
    all.push(r);
  }
  const grand = all.length ? mean(all) : 0;
  const meanCells = new Map<string, { mean: number; interaction: number; n: number; p: number }>();
  let maxAbsMean = 1e-9;
  for (const lx of sx.order) for (const ly of sy.order) {
    const arr = cell.get(`${lx}||${ly}`);
    if (!arr || arr.length < minN) continue;
    const additive = mean(rowArr.get(lx)!) + mean(colArr.get(ly)!) - grand;
    const m = mean(arr);
    const tt = tTest(arr.map((r) => r - additive));
    maxAbsMean = Math.max(maxAbsMean, Math.abs(m));
    meanCells.set(`${lx}||${ly}`, { mean: m, interaction: m - additive, n: arr.length, p: tt ? tt.p : 1 });
  }
  const lastLabel = (s: StateFn) => {
    for (let i = n - 1; i >= 0; i--) { const l = s.stateOf(i); if (l !== null) return l; }
    return null;
  };
  return {
    xOrder: sx.order, yOrder: sy.order, meanCells, baseline: grand,
    nowX: lastLabel(sx), nowY: lastLabel(sy), maxAbsMean,
  };
}
