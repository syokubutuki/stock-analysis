// 方法3: 前夜米国情報の「織り込み速度」と日中の反転確率。
//
// (A) 織り込み速度: 各日を米国の符号で向き付けし、前日終値基準の累積対数リターンを
//     F(t)=sign(r_US)·ln(P_t/prevClose) と定義。平均 M(t)=mean F(t) は「米国が示した方向に
//     平均どれだけ進んだか」。実現割合 f(t)=M(t)/M(end) は当日全体の何%を時刻tまでに実現したか。
//     f が寄付で既に≈1なら“寄りで消化完了”、寄付>1で低下なら“行き過ぎ→戻し”、寄付<1で上昇なら
//     “日中もじわじわ織り込む”。
//
// (B) 反転確率: 前場(寄り→正午)と後場(正午→引け)の符号が反対になる割合を米国ビン別に集計。
//     米国が大きく動いた翌日ほど後場で反転しやすい/しにくいを検証する。

import { AlignedDay, dayCumPath, assignBins, binMeta, BinScheme, orientedMeanPath } from "./us-spillover-core";
import { BinGrid } from "./intraday-core";
import { mean, tTest } from "./stats-significance";

export interface ReversalBin {
  bin: number;
  label: string;
  color: string;
  n: number;
  morningWin: number; // 前場がプラスだった割合
  reversalRate: number; // 後場が前場と反対符号だった割合
  p: number; // reversalRate が 0.5 と異なるか(t検定)
}

export interface AbsorptionResult {
  timeLabels: string[]; // ["寄付", ...時間ビン]
  orientedMean: number[]; // M(t) 前日終値基準・米国方向に向き付けした平均(%)
  fraction: number[]; // f(t) = M(t)/M(end)
  endMean: number; // M(end)
  gapShare: number; // f(寄付) = ギャップが担う割合
  reversals: ReversalBin[];
}

const sgn = (x: number) => (x >= 0 ? 1 : -1);

export function computeAbsorption(
  aligned: AlignedDay[], grid: BinGrid | null, gmtoffset: number, scheme: BinScheme
): AbsorptionResult | null {
  const rows = aligned.filter((a) => isFinite(a.us.ret) && a.us.ret !== 0);
  if (rows.length < 8 || !grid) return null;
  const G = grid.bins.length;

  // 向き付けした前日終値基準の平均累積パス M(t) と実現割合 f(t)(共有プリミティブ)。
  const { path: M, fraction } = orientedMeanPath(rows, grid, gmtoffset);
  const endMean = M[G];
  const gapShare = fraction[0];

  const timeLabels = ["寄付", ...grid.bins.map((b) => b.label)];

  // 反転確率(米国ビン別)
  const binIdx = assignBins(rows.map((a) => a.us.ret), scheme);
  const meta = binMeta(scheme);
  const mid = Math.max(1, Math.floor(G / 2));
  const reversals: ReversalBin[] = [];
  for (let b = 0; b < meta.count; b++) {
    const idxs = rows.map((_, i) => i).filter((i) => binIdx[i] === b);
    if (idxs.length === 0) { reversals.push({ bin: b, label: meta.labels[b], color: meta.colors[b], n: 0, morningWin: 0, reversalRate: 0, p: 1 }); continue; }
    const revInd: number[] = []; // 0.5=反転, -0.5=順行 (t検定で mean=rate-0.5 を評価)
    let morningPos = 0;
    for (const i of idxs) {
      const cum = dayCumPath(rows[i].jp, grid, gmtoffset);
      const morning = cum[mid - 1];
      const afternoon = cum[G - 1] - cum[mid - 1];
      if (morning >= 0) morningPos++;
      const reversed = sgn(morning) !== sgn(afternoon) ? 1 : 0;
      revInd.push(reversed - 0.5);
    }
    const rate = mean(revInd.map((v) => v + 0.5));
    const tt = tTest(revInd);
    reversals.push({
      bin: b, label: meta.labels[b], color: meta.colors[b], n: idxs.length,
      morningWin: morningPos / idxs.length, reversalRate: rate, p: tt ? tt.p : 1,
    });
  }

  return { timeLabels, orientedMean: M, fraction, endMean, gapShare, reversals };
}
