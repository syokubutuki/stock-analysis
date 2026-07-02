// 前夜米国「情報の消化時間」に関するエッジ探索の共有プリミティブ。
// us-spillover-core.ts(整合・ビン化・時間格子・回帰)の上に、以下を純関数で提供する。
//   - 保有期間の最適化(holdingCurve / excursionCurve)
//   - 消化完了点の推定とレジーム反転(orientedMeanPath / estimateTau / changePointDrift / reversalSplit)
//   - 反転の生存/ハザード分析(hazardCurve)
//   - 消化“進捗”を時間軸にした探索と速度層別(progressResample / stratifyBySpeed)
// UsHoldingPeriodChart / UsDigestionBoundaryChart / UsEventTimeChart が消費する。

import { DayData, BinGrid, localMinute, binIndexOfMinute } from "./intraday-core";
import {
  AlignedDay, dayBinCloses, dayCumPath, assignBins, binMeta, BinScheme,
} from "./us-spillover-core";
import { mean, std, tTest, quantileSorted } from "./stats-significance";

const sgn = (x: number) => (x >= 0 ? 1 : -1);

// ───────────────────────── ビン補助 ─────────────────────────

export interface BinCount { bin: number; label: string; color: string; n: number; }

export function digestionBinCounts(aligned: AlignedDay[], scheme: BinScheme): BinCount[] {
  const rows = aligned.filter((a) => isFinite(a.us.ret));
  const idx = assignBins(rows.map((a) => a.us.ret), scheme);
  const meta = binMeta(scheme);
  return meta.labels.map((label, b) => ({ bin: b, label, color: meta.colors[b], n: idx.filter((v) => v === b).length }));
}

export function rowsInBin(aligned: AlignedDay[], scheme: BinScheme, selBin: number): AlignedDay[] {
  const rows = aligned.filter((a) => isFinite(a.us.ret));
  const idx = assignBins(rows.map((a) => a.us.ret), scheme);
  return rows.filter((_, i) => idx[i] === selBin);
}

// 各時間ビンの高値/安値(バー無しビンは終値で補完)。MFE/MAE 用。
export function dayBinHighLow(day: DayData, grid: BinGrid, gmtoffset: number): { hi: number[]; lo: number[] } {
  const closes = dayBinCloses(day, grid, gmtoffset);
  const hi = closes.slice(), lo = closes.slice();
  for (const b of day.bars) {
    const m = localMinute(b.ts, gmtoffset);
    const bi = binIndexOfMinute(m, grid);
    hi[bi] = Math.max(hi[bi], b.high);
    lo[bi] = Math.min(lo[bi], b.low);
  }
  return { hi, lo };
}

// ───────────────────────── 機能1: 保有期間曲線 ─────────────────────────

export interface HoldingPoint {
  dt: number; // 保有ビン数
  label: string; // 手仕舞い時刻
  n: number;
  mean: number; // 窓リターン平均(ロング基準)
  ir: number; // 情報比 = mean/σ
  p: number;
}

// エントリーを entryIdx に固定し、各手仕舞い時刻までの窓リターンの平均・IR・t検定を返す。
export function holdingCurve(rows: AlignedDay[], grid: BinGrid, gmtoffset: number, entryIdx: number): HoldingPoint[] {
  const G = grid.bins.length;
  const closes = rows.map((a) => dayBinCloses(a.jp, grid, gmtoffset));
  const out: HoldingPoint[] = [];
  for (let j = entryIdx + 1; j < G; j++) {
    const rets: number[] = [];
    for (const c of closes) if (c[entryIdx] > 0 && c[j] > 0) rets.push(Math.log(c[j] / c[entryIdx]));
    if (rets.length < 3) continue;
    const m = mean(rets), s = std(rets), tt = tTest(rets);
    out.push({ dt: j - entryIdx, label: grid.bins[j].label, n: rets.length, mean: m, ir: s > 0 ? m / s : 0, p: tt ? tt.p : 1 });
  }
  return out;
}

// ───────────────────────── 機能2: MFE/MAE エクスカーション ─────────────────────────

export interface ExcursionPoint {
  dt: number;
  label: string;
  n: number;
  mfe: number; // 平均 最大含み益(米国方向に向き付け)
  mae: number; // 平均 最大含み損(負値)
}

// entryIdx からの保有時間ごとに、米国符号で向き付けした MFE/MAE の平均を返す。
export function excursionCurve(rows: AlignedDay[], grid: BinGrid, gmtoffset: number, entryIdx: number): ExcursionPoint[] {
  const G = grid.bins.length;
  const per = rows.map((a) => {
    const { hi, lo } = dayBinHighLow(a.jp, grid, gmtoffset);
    const closes = dayBinCloses(a.jp, grid, gmtoffset);
    return { hi, lo, pe: closes[entryIdx], s: sgn(a.us.ret) };
  });
  const out: ExcursionPoint[] = [];
  for (let j = entryIdx + 1; j < G; j++) {
    const mfes: number[] = [], maes: number[] = [];
    for (const d of per) {
      if (!(d.pe > 0)) continue;
      let fav = -Infinity, adv = Infinity;
      for (let k = entryIdx + 1; k <= j; k++) {
        // ロング(s>0): 有利=高値方向, 不利=安値方向。ショート(s<0)は逆。
        const favK = d.s > 0 ? Math.log(d.hi[k] / d.pe) : Math.log(d.pe / d.lo[k]);
        const advK = d.s > 0 ? Math.log(d.lo[k] / d.pe) : Math.log(d.pe / d.hi[k]);
        if (favK > fav) fav = favK;
        if (advK < adv) adv = advK;
      }
      if (isFinite(fav)) mfes.push(fav);
      if (isFinite(adv)) maes.push(adv);
    }
    if (mfes.length < 3) continue;
    out.push({ dt: j - entryIdx, label: grid.bins[j].label, n: mfes.length, mfe: mean(mfes), mae: mean(maes) });
  }
  return out;
}

// ───────────────────────── 機能3/4/7: 向き付け平均パスと境界 ─────────────────────────

export interface OrientedPath {
  path: number[]; // 長さ T=G+1。index0=寄付(=平均ギャップ), 前日終値基準・米国方向に向き付け
  fraction: number[]; // path / path[end]
  timeLabels: string[]; // ["寄付", ...時間ビン]
}

export function orientedMeanPath(rows: AlignedDay[], grid: BinGrid, gmtoffset: number): OrientedPath {
  const G = grid.bins.length;
  const cum = rows.map((a) => dayCumPath(a.jp, grid, gmtoffset));
  const T = G + 1;
  const path = new Array(T).fill(0);
  for (let t = 0; t < T; t++) {
    const col = rows.map((a, d) => sgn(a.us.ret) * (t === 0 ? a.gap : a.gap + cum[d][t - 1]));
    path[t] = mean(col);
  }
  const end = path[T - 1];
  const fraction = path.map((v) => (Math.abs(end) > 1e-9 ? v / end : 0));
  return { path, fraction, timeLabels: ["寄付", ...grid.bins.map((b) => b.label)] };
}

// f(t) が初めて95%到達する時刻(無ければ最大点)を消化完了τとする。返り値は T のindex(0..G)。
export function estimateTau(fraction: number[]): number {
  for (let t = 1; t < fraction.length; t++) if (fraction[t] >= 0.95) return t;
  let bi = 1, bv = -Infinity;
  for (let t = 1; t < fraction.length; t++) if (fraction[t] > bv) { bv = fraction[t]; bi = t; }
  return bi;
}

// drift(平均パス増分)系列の平均シフト変化点。返り値は増分配列のindex(=境界ビン)。
export function changePointDrift(inc: number[]): number {
  const n = inc.length;
  if (n < 4) return Math.max(1, Math.floor(n / 2));
  const sse = (arr: number[]) => { const m = mean(arr); return arr.reduce((s, v) => s + (v - m) ** 2, 0); };
  let best = 1, bestSSE = Infinity;
  for (let k = 1; k < n; k++) {
    const v = sse(inc.slice(0, k)) + sse(inc.slice(k));
    if (v < bestSSE) { bestSSE = v; best = k; }
  }
  return best;
}

export interface ReversalSplit {
  boundaryBin: number; // cum配列のindex
  preMean: number; preP: number; // (寄り→境界) 米国方向に向き付け
  postMean: number; postP: number; // (境界→引け)
  reversed: boolean;
}

// 境界(T index tauIdx)で日内を2分し、前後の向き付けリターンの符号を検定。
export function reversalSplit(rows: AlignedDay[], grid: BinGrid, gmtoffset: number, tauIdx: number): ReversalSplit {
  const G = grid.bins.length;
  const bIdx = Math.max(0, Math.min(G - 1, tauIdx - 1));
  const pre: number[] = [], post: number[] = [];
  for (const a of rows) {
    const cum = dayCumPath(a.jp, grid, gmtoffset);
    const s = sgn(a.us.ret);
    pre.push(s * cum[bIdx]);
    post.push(s * (cum[G - 1] - cum[bIdx]));
  }
  const tp = tTest(pre), tq = tTest(post);
  const preMean = mean(pre), postMean = mean(post);
  return { boundaryBin: bIdx, preMean, preP: tp ? tp.p : 1, postMean, postP: tq ? tq.p : 1, reversed: preMean > 0 && postMean < 0 };
}

export interface HazardPoint { g: number; label: string; atRisk: number; events: number; hazard: number; survival: number; }

// 「米国方向の含み益を吐き出す(向き付け累積が正→0以下に転じる)」反転イベントのハザード/生存曲線。
export function hazardCurve(rows: AlignedDay[], grid: BinGrid, gmtoffset: number): HazardPoint[] {
  const G = grid.bins.length;
  const eventBin = rows.map((a) => {
    const cum = dayCumPath(a.jp, grid, gmtoffset);
    const s = sgn(a.us.ret);
    let started = false;
    for (let g = 0; g < G; g++) {
      const oc = s * cum[g];
      if (oc > 0) started = true;
      if (started && oc <= 0) return g;
    }
    return Infinity;
  });
  const out: HazardPoint[] = [];
  let survival = 1;
  for (let g = 0; g < G; g++) {
    const atRisk = eventBin.filter((e) => e >= g).length;
    const events = eventBin.filter((e) => e === g).length;
    const h = atRisk > 0 ? events / atRisk : 0;
    survival *= 1 - h;
    out.push({ g, label: grid.bins[g].label, atRisk, events, hazard: h, survival });
  }
  return out;
}

// ───────────────────────── 機能5: 消化進捗を軸にしたエッジ ─────────────────────────

export interface ProgressPoint {
  level: number; // 進捗率(0..1.5 等)
  n: number;
  postMean: number; // その進捗到達後、引けまでの向き付け残余リターン平均
  postP: number;
  avgTimeIdx: number; // 到達した平均時間ビン
}

// 各日の向き付け累積(寄り基準)をその日の引け値で正規化し、進捗levelに初到達した後の残余を集計。
export function progressResample(rows: AlignedDay[], grid: BinGrid, gmtoffset: number, levels: number[]): ProgressPoint[] {
  const G = grid.bins.length;
  const per = rows
    .map((a) => { const cum = dayCumPath(a.jp, grid, gmtoffset); const s = sgn(a.us.ret); const C = cum.map((v) => s * v); return { C, E: C[G - 1] }; })
    .filter((d) => d.E > 1e-6);
  const out: ProgressPoint[] = [];
  for (const L of levels) {
    const posts: number[] = [], times: number[] = [];
    for (const d of per) {
      let g0 = -1;
      for (let g = 0; g < G; g++) if (d.C[g] / d.E >= L) { g0 = g; break; }
      if (g0 < 0) continue;
      posts.push(d.C[G - 1] - d.C[g0]);
      times.push(g0);
    }
    if (posts.length < 3) continue;
    const tt = tTest(posts);
    out.push({ level: L, n: posts.length, postMean: mean(posts), postP: tt ? tt.p : 1, avgTimeIdx: mean(times) });
  }
  return out;
}

// ───────────────────────── 機能6: 消化速度による層別 ─────────────────────────

export interface SpeedGroup { label: string; n: number; afternoonMean: number; afternoonP: number; medianReachIdx: number; }

// 各日を「向き付け累積が自日終値の50%に到達する時刻」で fast/slow に中央値分割し、後場(中央→引け)の
// 向き付けリターンを比較する。遅い日ほど日中に持続エッジが残るか、を検証する。
export function stratifyBySpeed(rows: AlignedDay[], grid: BinGrid, gmtoffset: number): { fast: SpeedGroup; slow: SpeedGroup; timeLabels: string[] } | null {
  const G = grid.bins.length;
  const mid = Math.max(1, Math.floor(G / 2));
  const per = rows
    .map((a) => {
      const cum = dayCumPath(a.jp, grid, gmtoffset);
      const s = sgn(a.us.ret);
      const C = cum.map((v) => s * v);
      const E = C[G - 1];
      let reach = G;
      if (E > 1e-6) for (let g = 0; g < G; g++) if (C[g] / E >= 0.5) { reach = g; break; }
      return { reach, afternoon: C[G - 1] - C[mid - 1], E };
    })
    .filter((d) => d.E > 1e-6);
  if (per.length < 8) return null;
  const medR = quantileSorted(per.map((d) => d.reach).sort((a, b) => a - b), 0.5);
  const fast = per.filter((d) => d.reach <= medR);
  const slow = per.filter((d) => d.reach > medR);
  const summarize = (arr: typeof per, label: string): SpeedGroup => {
    const a = arr.map((d) => d.afternoon);
    const tt = tTest(a);
    return { label, n: arr.length, afternoonMean: mean(a), afternoonP: tt ? tt.p : 1, medianReachIdx: quantileSorted(arr.map((d) => d.reach).sort((x, y) => x - y), 0.5) };
  };
  return {
    fast: summarize(fast, "速い(寄りで消化)"),
    slow: summarize(slow, "遅い(日中も進行)"),
    timeLabels: grid.bins.map((b) => b.label),
  };
}
