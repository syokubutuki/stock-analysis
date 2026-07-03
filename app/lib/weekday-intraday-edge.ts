// 曜日 × 日内エントリー/エグジット時刻の総当たりエッジスキャン。
//
// 「金曜は日中プラス」といった日次の曜日アノマリーを、日内足で一段深掘りする。各曜日について
// 立会時間帯を時間格子に区切り、格子上の全ての (買い建て時刻 i, 手仕舞い時刻 j>i) の組合せで
// ロング1トレードの平均リターンを総当たり集計する。そのうえで各曜日の最良ウィンドウ
// (最大平均 or 最大t値) を選び、日内のどの時間帯にロングのエッジが宿るかを一覧化する。
//
// 多重比較(全曜日×全ウィンドウ)による偽陽性を Benjamini-Hochberg FDR 補正で抑える。
// 最良ウィンドウの各立会日リターンは、累積時系列(エクイティカーブ)としても返し、
// エッジが全期間で安定か特定時期に偏るかを暦時間軸で確認できるようにする。
//
// 時間格子・日内価格ベクトルは intraday-core / us-spillover-core の既存関数を流用する。

import { DayData, BinGrid } from "./intraday-core";
import { dayBinCloses } from "./us-spillover-core";
import { mean, std, tTest, benjaminiHochberg } from "./stats-significance";

const WD_ORDER = [1, 2, 3, 4, 5];
const WD_LABELS: Record<number, string> = { 1: "月曜", 2: "火曜", 3: "水曜", 4: "木曜", 5: "金曜" };
const WD_COLORS: Record<number, string> = {
  1: "#2563eb", 2: "#16a34a", 3: "#f59e0b", 4: "#db2777", 5: "#7c3aed",
};

export type EdgeRankBy = "mean" | "t";

// 1つの日内ウィンドウ(買い建て時刻 i → 手仕舞い時刻 j)の統計。
export interface EdgeWindow {
  i: number; // 買い建て時刻の格子index
  j: number; // 手仕舞い時刻の格子index
  entryLabel: string; // "HH:MM"
  exitLabel: string; // "HH:MM"
  holdBins: number; // j - i(保有した格子コマ数)
  n: number; // トレード日数
  mean: number; // 1トレード平均 対数リターン
  std: number;
  win: number; // 勝率(プラスだった日の割合)
  t: number; // t値
  p: number; // 両側生p値
  pAdj: number; // BH-FDR補正後p値(全曜日×全ウィンドウで補正)
}

export interface WeekdayEdge {
  weekday: number; // 1..5
  label: string;
  color: string;
  nDays: number; // その曜日の立会日数
  best: EdgeWindow | null; // 最良ロングウィンドウ
  matrix: (number | null)[][]; // meanMatrix[i][j] = 平均リターン(j<=i や標本不足はnull)
  trades: { date: string; ret: number }[]; // 最良ウィンドウの各立会日リターン(日付昇順)→累積時系列用
}

export interface WeekdayIntradayEdgeResult {
  weekdays: WeekdayEdge[];
  timeLabels: string[]; // 格子時刻ラベル
  maxAbsMatrix: number; // ヒートマップ配色の基準(全セル最大絶対値)
  nTested: number; // 検定にかけたウィンドウ総数(FDRの母数)
  minDays: number;
}

export interface EdgeOptions {
  rankBy?: EdgeRankBy; // 最良ウィンドウの選定基準(平均最大 / t値最大)
  minDays?: number; // ウィンドウを採用する最小トレード日数
}

// 各曜日 × 全 (i<j) ウィンドウのロング平均を総当たりし、最良ウィンドウとヒートマップ行列を返す。
export function computeWeekdayIntradayEdge(
  days: DayData[], grid: BinGrid | null, gmtoffset: number, opts: EdgeOptions = {}
): WeekdayIntradayEdgeResult | null {
  if (!grid) return null;
  const G = grid.bins.length;
  if (G < 2) return null;
  const rankBy: EdgeRankBy = opts.rankBy ?? "mean";
  const minDays = opts.minDays ?? 6;
  const timeLabels = grid.bins.map((b) => b.label);

  // 曜日ごとに各立会日の「時刻→終値」ベクトル(dayBinCloses: 寄り基準で前方補完済み)を集める。
  const byWd = new Map<number, { date: string; px: number[] }[]>();
  for (const wd of WD_ORDER) byWd.set(wd, []);
  for (const d of days) {
    if (!(d.open > 0) || !WD_ORDER.includes(d.weekday)) continue;
    byWd.get(d.weekday)!.push({ date: d.date, px: dayBinCloses(d, grid, gmtoffset) });
  }

  // 全ウィンドウの生p値を貯めて後で一括FDR補正する。
  const globalP: number[] = [];
  interface Cand { i: number; j: number; n: number; mean: number; std: number; win: number; t: number; p: number; gi: number; }

  const perWd = WD_ORDER.map((wd) => {
    const rows = byWd.get(wd)!;
    const matrix: (number | null)[][] = Array.from({ length: G }, () => new Array(G).fill(null));
    const cands: Cand[] = [];
    for (let i = 0; i < G; i++) {
      for (let j = i + 1; j < G; j++) {
        const rets: number[] = [];
        for (const r of rows) {
          const a = r.px[i], b = r.px[j];
          if (a > 0 && b > 0) rets.push(Math.log(b / a));
        }
        if (rets.length < minDays) continue;
        const m = mean(rets), s = std(rets), n = rets.length;
        const win = rets.filter((v) => v > 0).length / n;
        const tt = tTest(rets);
        matrix[i][j] = m;
        const gi = globalP.length;
        globalP.push(tt ? tt.p : 1);
        cands.push({ i, j, n, mean: m, std: s, win, t: tt ? tt.t : 0, p: tt ? tt.p : 1, gi });
      }
    }
    return { wd, nDays: rows.length, matrix, cands };
  });

  const pAdjAll = benjaminiHochberg(globalP);

  let maxAbsMatrix = 1e-9;
  const weekdays: WeekdayEdge[] = perWd.map(({ wd, nDays, matrix, cands }) => {
    for (const row of matrix) for (const v of row) if (v != null) maxAbsMatrix = Math.max(maxAbsMatrix, Math.abs(v));

    // 最良ロングウィンドウ: rankBy に従い最大の平均 or t値を採る(いずれもロング=正方向の大きさ)。
    let best: EdgeWindow | null = null;
    let bestScore = -Infinity;
    for (const c of cands) {
      const score = rankBy === "t" ? c.t : c.mean;
      if (score > bestScore) {
        bestScore = score;
        best = {
          i: c.i, j: c.j, entryLabel: timeLabels[c.i], exitLabel: timeLabels[c.j], holdBins: c.j - c.i,
          n: c.n, mean: c.mean, std: c.std, win: c.win, t: c.t, p: c.p, pAdj: pAdjAll[c.gi],
        };
      }
    }

    // 最良ウィンドウの各立会日リターン(累積時系列用)。
    const trades: { date: string; ret: number }[] = [];
    if (best) {
      for (const r of byWd.get(wd)!) {
        const a = r.px[best.i], b = r.px[best.j];
        if (a > 0 && b > 0) trades.push({ date: r.date, ret: Math.log(b / a) });
      }
      trades.sort((x, y) => x.date.localeCompare(y.date));
    }

    return { weekday: wd, label: WD_LABELS[wd], color: WD_COLORS[wd], nDays, best, matrix, trades };
  });

  return { weekdays, timeLabels, maxAbsMatrix, nTested: globalP.length, minDays };
}

// 現在時刻から「次に売買する立会曜日」を推定する(取引所ローカル≈15時引けを目安)。
// 平日で概ね引け前(15時前)なら当日、引け後や週末なら次の平日を返す。
export function nextSessionWeekday(now: Date, closeHour = 15): number {
  const d = now.getDay();
  if (d >= 1 && d <= 5 && now.getHours() < closeHour) return d;
  const cursor = new Date(now);
  do { cursor.setDate(cursor.getDate() + 1); } while (cursor.getDay() === 0 || cursor.getDay() === 6);
  return cursor.getDay();
}
