// 方法5: 前夜米国の方向別に、当日の最適な建て→手仕舞い時刻を全組合せスキャン。
//
// 米国ビンで日を層別し、そのサブサンプル内で「時刻i(建て)→時刻j(手仕舞い)」の全ペアについて
// 窓リターン r = ln(P_j / P_i) の平均・t検定を計算。多重比較をFDR補正し、統計的に好機の
// (建て,手仕舞い)を炙り出す。例:「米大幅安の翌日は寄り(9:00)売り→前引け(11:30)買い戻し」型。

import { AlignedDay, assignBins, binMeta, BinScheme, dayBinCloses, bootMeanCI } from "./us-spillover-core";
import { BinGrid } from "./intraday-core";
import { mean, tTest, benjaminiHochberg } from "./stats-significance";

export interface TimingCell {
  i: number; // 建て時刻ビン
  j: number; // 手仕舞い時刻ビン
  n: number;
  mean: number; // 窓リターン平均(ロング基準)
  p: number; // FDR補正済みp値
  significant: boolean;
  stable?: number; // ブート符号安定度(上位のみ)
}

export interface BinCount { bin: number; label: string; color: string; n: number; }

export interface TimingResult {
  binLabel: string;
  binColor: string;
  n: number;
  timeLabels: string[];
  cells: TimingCell[]; // i<j 全ペア
  best: TimingCell[]; // 有意かつ|平均|上位
  maxAbs: number;
}

export function binCounts(aligned: AlignedDay[], scheme: BinScheme): BinCount[] {
  const rows = aligned.filter((a) => isFinite(a.us.ret));
  const idx = assignBins(rows.map((a) => a.us.ret), scheme);
  const meta = binMeta(scheme);
  return meta.labels.map((label, b) => ({
    bin: b, label, color: meta.colors[b], n: idx.filter((v) => v === b).length,
  }));
}

export function computeTiming(
  aligned: AlignedDay[], grid: BinGrid | null, gmtoffset: number,
  scheme: BinScheme, selectedBin: number
): TimingResult | null {
  const rows = aligned.filter((a) => isFinite(a.us.ret));
  if (rows.length < 8 || !grid) return null;
  const binIdx = assignBins(rows.map((a) => a.us.ret), scheme);
  const meta = binMeta(scheme);
  const dayRows = rows.filter((_, i) => binIdx[i] === selectedBin);
  if (dayRows.length < 5) return null;

  const G = grid.bins.length;
  // 各日の時間ビン終値(前方補完済み)
  const closes = dayRows.map((a) => dayBinCloses(a.jp, grid, gmtoffset));

  const cells: TimingCell[] = [];
  const rawP: number[] = [];
  const means: number[] = [];
  const pairs: { i: number; j: number; rets: number[] }[] = [];
  for (let i = 0; i < G - 1; i++) {
    for (let j = i + 1; j < G; j++) {
      const rets: number[] = [];
      for (const c of closes) {
        if (c[i] > 0 && c[j] > 0) rets.push(Math.log(c[j] / c[i]));
      }
      if (rets.length < 5) continue;
      const tt = tTest(rets);
      pairs.push({ i, j, rets });
      means.push(mean(rets));
      rawP.push(tt ? tt.p : 1);
    }
  }
  if (pairs.length === 0) return null;
  const adjP = benjaminiHochberg(rawP);
  let maxAbs = 1e-9;
  pairs.forEach((pr, k) => {
    const m = means[k];
    maxAbs = Math.max(maxAbs, Math.abs(m));
    cells.push({ i: pr.i, j: pr.j, n: pr.rets.length, mean: m, p: adjP[k], significant: adjP[k] < 0.05 });
  });

  // 上位候補にブート安定度を付与
  const best = [...cells]
    .filter((c) => c.significant)
    .sort((a, b) => Math.abs(b.mean) - Math.abs(a.mean))
    .slice(0, 8)
    .map((c) => {
      const pr = pairs.find((p) => p.i === c.i && p.j === c.j)!;
      return { ...c, stable: bootMeanCI(pr.rets).stable };
    });

  return {
    binLabel: meta.labels[selectedBin], binColor: meta.colors[selectedBin],
    n: dayRows.length, timeLabels: grid.bins.map((x) => x.label), cells, best, maxAbs,
  };
}
