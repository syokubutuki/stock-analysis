// 方法1: 前夜米国の方向ビン × 当日日内の平均累積パス(イベントスタディ)。
//
// 前夜米国リターンでその日を層別し、寄り(open)を基準にした累積対数リターン r(t)=ln(P_t/open) の
// 日内平均パスをビンごとに描く。米国高の翌日が「ギャップ継続型(上げ続ける)」か
// 「寄り天フェード型(寄り後に戻す)」か、その“形”を直接可視化する。

import {
  AlignedDay, UsReturn, dayCumPath, assignBins, binMeta, binEdges, binOfValue, BinScheme,
} from "./us-spillover-core";
import { BinGrid } from "./intraday-core";
import { mean, std, tTest } from "./stats-significance";

// ビン分けに使う前夜米国リターンの種類。
//   ret   = ln(close/prevClose) 前日終値比(オーバーナイト含む米国当日騰落)
//   intra = ln(close/open)      米国正規セッション内(日中)リターン
export type UsBinMode = "ret" | "intra";

export interface PathBin {
  bin: number;
  label: string;
  color: string;
  n: number;
  rangeLo: number | null; // このビンの前夜米国リターン下限(nullは-∞側)
  rangeHi: number | null; // 上限(nullは+∞側)
  path: number[]; // 各時間ビンでの平均累積リターン
  lo: number[]; // 平均 ± 1.96·SE
  hi: number[];
  endMean: number; // 寄り→引けの平均(パス終端)
  endP: number; // 終端が0と異なるかのt検定p値
}

// 原系列タイムライン用: 整合できた各JP立会日と、その前夜米国リターンで割り当てたビン。
export interface PathDay {
  date: string; // JP立会日 YYYY-MM-DD(原系列上の位置)
  close: number; // JP日次終値(原系列ライン)
  bin: number; // 前夜米国リターンで割り当てたビン番号
  usDate: string; // 対応する前夜の米国立会日
  usRet: number; // 前夜米国の対数リターン
}

export interface PathResult {
  bins: PathBin[];
  timeLabels: string[];
  maxAbs: number; // 縦軸スケール
  days: PathDay[]; // 整合各日のビン所属(原系列色分け用)、JP日付昇順
  usMode: UsBinMode; // ビン分けに使った前夜米国リターンの種類
  edges: number[]; // ビン境界(前夜米国リターン)。長さ=count-1
  today: {
    usDate: string; // 判定に使った直近の米国立会日
    value: number; // その前夜米国リターン(usModeに一致)
    bin: number; // 属するビン番号
    percentile: number; // 全標本中の累積順位(0..1)
    unpaired: boolean; // まだJP立会とペアになっていない最新米国終値か(=寄り前の“ゆうべのNY”)
  } | null;
}

export function computePaths(
  aligned: AlignedDay[], grid: BinGrid | null, gmtoffset: number, scheme: BinScheme,
  usMode: UsBinMode = "ret",
  us: UsReturn[] = [],
): PathResult | null {
  const usVal = (a: AlignedDay) => (usMode === "intra" ? a.us.intra : a.us.ret);
  const rows = aligned.filter((a) => isFinite(usVal(a)) && usVal(a) !== 0);
  if (rows.length < 8 || !grid) return null;
  const vals = rows.map(usVal);
  const binIdx = assignBins(vals, scheme);
  const edges = binEdges(vals, scheme);
  const meta = binMeta(scheme);
  const G = grid.bins.length;

  const byBin: number[][][] = Array.from({ length: meta.count }, () => []);
  rows.forEach((a, i) => byBin[binIdx[i]].push(dayCumPath(a.jp, grid, gmtoffset)));

  // 原系列(JP日次終値)上での色分け用に、各整合日のビン所属を日付昇順で保持。
  const days: PathDay[] = rows
    .map((a, i) => ({
      date: a.jp.date, close: a.jp.close, bin: binIdx[i], usDate: a.us.date, usRet: usVal(a),
    }))
    .sort((p, q) => p.date.localeCompare(q.date));

  const bins: PathBin[] = [];
  let maxAbs = 1e-6;
  for (let b = 0; b < meta.count; b++) {
    const mat = byBin[b];
    const path = new Array(G).fill(0), lo = new Array(G).fill(0), hi = new Array(G).fill(0);
    if (mat.length > 0) {
      for (let g = 0; g < G; g++) {
        const col = mat.map((p) => p[g]);
        const m = mean(col), se = mat.length > 1 ? std(col) / Math.sqrt(mat.length) : 0;
        path[g] = m; lo[g] = m - 1.96 * se; hi[g] = m + 1.96 * se;
        maxAbs = Math.max(maxAbs, Math.abs(hi[g]), Math.abs(lo[g]));
      }
    }
    const endCol = mat.map((p) => p[G - 1]);
    const tt = tTest(endCol);
    bins.push({
      bin: b, label: meta.labels[b], color: meta.colors[b], n: mat.length,
      rangeLo: b === 0 ? null : edges[b - 1],
      rangeHi: b === meta.count - 1 ? null : edges[b],
      path, lo, hi, endMean: path[G - 1], endP: tt ? tt.p : 1,
    });
  }

  // 「今日の状況」= 現時点で確定している最新の米国終値。
  // 生の米国系列(us)が渡されていれば、まだJP立会とペアになっていない“ゆうべのNY”(未ペアの最新)も採用する。
  // これにより日本のプレマーケット(寄り前)でも、今朝方に引けた最新米国で即ビン判定できる。
  const usMode2 = (u: UsReturn) => (usMode === "intra" ? u.intra : u.ret);
  const last = rows[rows.length - 1];
  let tDate = last.us.date;
  let tv = usVal(last);
  for (let i = us.length - 1; i >= 0; i--) {
    const v = usMode2(us[i]);
    if (isFinite(v) && v !== 0) { tDate = us[i].date; tv = v; break; } // us は日付昇順 → 末尾が最新
  }
  const sortedVals = [...vals].sort((a, b) => a - b);
  const below = sortedVals.filter((v) => v <= tv).length;
  const today = {
    usDate: tDate,
    value: tv,
    bin: binOfValue(tv, scheme, edges),
    percentile: below / sortedVals.length,
    unpaired: tDate > last.us.date, // 最後にペア成立した米国日より新しい＝未ペア
  };

  return { bins, timeLabels: grid.bins.map((x) => x.label), maxAbs, days, usMode, edges, today };
}
