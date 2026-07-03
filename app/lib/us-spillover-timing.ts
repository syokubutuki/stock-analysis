// 方法5: 前夜米国の方向別に、当日の最適な建て→手仕舞い時刻を全組合せスキャン。
//
// 米国ビンで日を層別し、そのサブサンプル内で「時刻i(建て)→時刻j(手仕舞い)」の全ペアについて
// 窓リターン r = ln(P_j / P_i) の平均・t検定を計算。多重比較をFDR補正し、統計的に好機の
// (建て,手仕舞い)を炙り出す。例:「米大幅安の翌日は寄り(9:00)売り→前引け(11:30)買い戻し」型。

import { AlignedDay, assignBins, binMeta, BinScheme, dayBinCloses, bootMeanCI, mulberry32 } from "./us-spillover-core";
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
  const rows = aligned.filter((a) => isFinite(a.us.ret) && a.us.ret !== 0);
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
  const rows = aligned.filter((a) => isFinite(a.us.ret) && a.us.ret !== 0);
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

// 機能8: 窓選択のデータスヌーピング防御。全 (i,j) 窓の中の最大|t|統計の帰無分布を
// 「各日の日内パスを独立に符号反転(sign-flip)」で構築し、観測最大|t|の族全体p値を返す。
// 帰無仮説: 各日の日内パスは平均0で符号対称(=時刻構造による一貫したエッジは無い)。
// FDR(個別窓ごと)より厳しく、「多数試したうえで最良窓が本物か」を1つの検定で判定する。
export interface MaxStatResult { p: number; obsMaxT: number; iters: number; n: number; }

export function maxStatPermutation(
  aligned: AlignedDay[], grid: BinGrid | null, gmtoffset: number,
  scheme: BinScheme, selectedBin: number, iters = 200, seed = 0x51ed2a
): MaxStatResult | null {
  const rows = aligned.filter((a) => isFinite(a.us.ret) && a.us.ret !== 0);
  if (!grid || rows.length < 8) return null;
  const binIdx = assignBins(rows.map((a) => a.us.ret), scheme);
  const dayRows = rows.filter((_, i) => binIdx[i] === selectedBin);
  const n = dayRows.length;
  if (n < 5) return null;
  const G = grid.bins.length;
  // 各日: 寄り基準の累積対数 L_g = ln(P_g / P_0)。窓(i,j)リターン = L_j − L_i。
  const Ls = dayRows.map((a) => {
    const c = dayBinCloses(a.jp, grid, gmtoffset);
    const p0 = c[0];
    return c.map((p) => (p > 0 && p0 > 0 ? Math.log(p / p0) : 0));
  });

  const maxAbsT = (paths: number[][]): number => {
    let best = 0;
    for (let i = 0; i < G - 1; i++) {
      for (let j = i + 1; j < G; j++) {
        let s = 0, s2 = 0;
        for (const L of paths) { const w = L[j] - L[i]; s += w; s2 += w * w; }
        const m = s / n;
        const varr = (s2 - n * m * m) / (n - 1);
        if (varr > 0) { const t = Math.abs(m / Math.sqrt(varr / n)); if (t > best) best = t; }
      }
    }
    return best;
  };

  const obs = maxAbsT(Ls);
  const rng = mulberry32(seed);
  let ge = 0;
  for (let it = 0; it < iters; it++) {
    const flip = Ls.map((L) => (rng() < 0.5 ? L.map((v) => -v) : L));
    if (maxAbsT(flip) >= obs) ge++;
  }
  return { p: (ge + 1) / (iters + 1), obsMaxT: obs, iters, n };
}
