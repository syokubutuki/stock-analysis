// 方法6: 前夜米国 → 当日日中の相関の「日内減衰」。
//
// 前夜米国リターン r_US と、当日の値動きの相関が時刻とともにどう変化するかを2つの曲線で見る。
//   累積相関 corrCum(t) = corr(r_US, 前日終値→時刻t の累積) : 時刻tまでに積み上がった連動の強さ
//   限界相関 corrMarg(t)= corr(r_US, 各時間ビンの増分)      : その時間帯に“新たに”入る米国連動
// 限界相関が寄り近辺で高く急速に減衰するほど、米国情報は寄りで速やかに吸収されている証拠。
// 逆に日中まで限界相関が残るなら、米国の記憶が長く効く=日中に追随余地がある。

import { AlignedDay, dayCumPath, pearson } from "./us-spillover-core";
import { BinGrid } from "./intraday-core";

export interface LeadLagResult {
  timeLabels: string[]; // ["寄付", ...時間ビン]
  corrCum: number[];
  corrMarg: number[];
  n: number;
  gapCorr: number; // 寄付(ギャップ)での相関
  endCorr: number; // 引けでの累積相関
  halfLifeLabel: string | null; // 限界相関がギャップ時の半分を下回る最初の時刻
}

export function computeLeadLag(
  aligned: AlignedDay[], grid: BinGrid | null, gmtoffset: number
): LeadLagResult | null {
  const rows = aligned.filter((a) => isFinite(a.us.ret));
  if (rows.length < 8 || !grid) return null;
  const G = grid.bins.length;
  const us = rows.map((a) => a.us.ret);

  // 各日: レベル L(0..G) と 増分 inc(0..G)
  const cumByDay = rows.map((a) => dayCumPath(a.jp, grid, gmtoffset));
  const T = G + 1;
  const corrCum = new Array(T).fill(0);
  const corrMarg = new Array(T).fill(0);
  for (let t = 0; t < T; t++) {
    const level: number[] = [], inc: number[] = [];
    rows.forEach((a, d) => {
      const gap = a.gap;
      const cum = cumByDay[d];
      const L = t === 0 ? gap : gap + cum[t - 1];
      const prevCum = t <= 1 ? 0 : cum[t - 2];
      const I = t === 0 ? gap : cum[t - 1] - prevCum;
      level.push(L); inc.push(I);
    });
    corrCum[t] = pearson(us, level);
    corrMarg[t] = pearson(us, inc);
  }

  const timeLabels = ["寄付", ...grid.bins.map((b) => b.label)];
  const gapCorr = corrMarg[0];
  const half = Math.abs(gapCorr) / 2;
  let halfLifeLabel: string | null = null;
  for (let t = 1; t < T; t++) {
    if (Math.abs(corrMarg[t]) < half) { halfLifeLabel = timeLabels[t]; break; }
  }

  return { timeLabels, corrCum, corrMarg, n: rows.length, gapCorr, endCorr: corrCum[T - 1], halfLifeLabel };
}
