// 曜日 × 前夜米国ビン のイベントスタディ（−K日 〜 +K日の日足経路）。
//
// 既存の「曜日×前夜米国ビン」分析はすべて当日1日で完結している。だが実際の建玉は翌日以降も
// 残ることが多く、知りたいのは「その日に効果があったか」ではなく「効果が持続するのか、
// 翌日以降に巻き戻されるのか」である。ここでは条件に合致した日をイベント日 t=0 とし、
// その前後 K 日の累積経路（イベント前日終値＝0）を重ねて平均する。
//
//   value(s) = ln( C_{t0+s} / C_{t0−1} ),  s = −K … +K   （s=−1 で必ず 0）
//
// −側は「その条件が出るまでにどんな経路をたどっていたか」（条件そのものの背景）、
// +側は「その後どうなったか」（持続か巻き戻しか）を表す。
//
// 統計上の要点: イベント窓(2K+1日)はイベント間隔より長いので、窓どうしが重なる。素朴に
// 各イベントを独立標本として扱うと信頼区間が不当に狭くなるため、信頼区間はイベント列の
// ブロック・ブートストラップ（連続するイベントを塊のまま再標本）で作る。

import { PricePoint } from "./types";
import {
  UsReturn, binEdges, binMeta, binOfValue, BinScheme, mulberry32,
} from "./us-spillover-core";
import { mean, tTest, benjaminiHochberg, quantileSorted } from "./stats-significance";

export type UsValueMode = "ret" | "intra";
export type EventGroupBy = "weekday" | "bin";

export const WD_LABELS: Record<number, string> = { 1: "月曜", 2: "火曜", 3: "水曜", 4: "木曜", 5: "金曜" };
const WD_COLORS: Record<number, string> = { 1: "#2563eb", 2: "#16a34a", 3: "#f59e0b", 4: "#db2777", 5: "#7c3aed" };

export interface EventBinInfo {
  bin: number; label: string; color: string; n: number;
  rangeLo: number | null; rangeHi: number | null;
}

export interface EventGroupStat {
  key: string;
  label: string;
  color: string;
  n: number;
  mean: number[]; // 各オフセットの平均累積リターン(長さ 2K+1)
  lo: number[]; // ブロックブート95%CI
  hi: number[];
  offP: number[]; // 各オフセットの平均が0と異なるかのp値(1標本t)
  offPAdj: number[]; // 上記のFDR補正後
  car0: number; // イベント当日までの累積(=イベント日の当日リターン)
  carPost: number; // +K日までの累積
  postDiff: number; // carPost − car0（＝イベント翌日以降の累積）
  postT: number;
  postP: number;
  postPAdj: number; // 群横断のFDR補正後
  postLo: number; // postDiff のブロックブートCI
  postHi: number;
  reversalRate: number; // 翌日以降がイベント日と逆符号だった割合
  dates: string[]; // イベント日
}

export interface EventStudyResult {
  offsets: number[];
  groups: EventGroupStat[];
  binInfos: EventBinInfo[];
  latestBin: number | null; // 直近の前夜米国が属するビン
  latestUsDate: string | null;
  latestUsValue: number;
  maxAbs: number;
  nTotal: number;
}

export interface EventStudyParams {
  prices: PricePoint[]; // JP日足(昇順)
  us: UsReturn[]; // 米国日足リターン(昇順)
  usMode: UsValueMode;
  scheme: BinScheme;
  k: number; // 前後の日数
  groupBy: EventGroupBy;
  filterBin: number | null; // groupBy="weekday" のとき、どのビンのイベントを見るか
  filterWeekday: number; // groupBy="bin" のとき、0=全曜日 / 1..5
}

// 各JP立会日に「その寄り前で最後に確定した米国立会日」のリターンを対応付ける(日足版の前夜整合)。
function alignUsToDaily(prices: PricePoint[], us: UsReturn[], usMode: UsValueMode): (number | null)[] {
  const sorted = [...us].sort((a, b) => a.date.localeCompare(b.date));
  const out: (number | null)[] = [];
  let j = 0;
  for (const p of prices) {
    while (j < sorted.length && sorted[j].date < p.time) j++;
    const idx = j - 1; // p.time より暦日が厳密に小さい最新
    if (idx < 0) { out.push(null); continue; }
    const v = usMode === "intra" ? sorted[idx].intra : sorted[idx].ret;
    out.push(isFinite(v) && v !== 0 ? v : null);
  }
  return out;
}

// UTC基準の曜日(1=月..5=金)。ローカルTZによる揺れを避ける。
function weekdayOf(time: string): number {
  return new Date(`${time}T00:00:00Z`).getUTCDay();
}

// イベント列のブロック・ブートストラップ。連続するイベントを塊のまま再標本し、
// 窓の重なりが生む相関を保存したまま平均経路の分布を作る。
function blockBootPaths(
  paths: number[][], B: number, seed: number
): { lo: number[]; hi: number[] } {
  const n = paths.length, T = paths[0].length;
  const lo = new Array(T).fill(0), hi = new Array(T).fill(0);
  if (n < 5) return { lo: paths[0].map(() => NaN), hi: paths[0].map(() => NaN) };
  const L = Math.max(1, Math.round(Math.cbrt(n)));
  const nBlocks = Math.ceil(n / L);
  const rng = mulberry32(seed);
  const samples: number[][] = Array.from({ length: T }, () => []);
  const acc = new Array(T);
  for (let b = 0; b < B; b++) {
    acc.fill(0);
    let cnt = 0;
    for (let blk = 0; blk < nBlocks && cnt < n; blk++) {
      const start = Math.floor(rng() * n);
      for (let j = 0; j < L && cnt < n; j++) {
        const p = paths[(start + j) % n];
        for (let t = 0; t < T; t++) acc[t] += p[t];
        cnt++;
      }
    }
    for (let t = 0; t < T; t++) samples[t].push(acc[t] / cnt);
  }
  for (let t = 0; t < T; t++) {
    samples[t].sort((a, b) => a - b);
    lo[t] = quantileSorted(samples[t], 0.025);
    hi[t] = quantileSorted(samples[t], 0.975);
  }
  return { lo, hi };
}

// スカラー列のブロックブート平均CI(postDiff用)。
function blockBootScalar(v: number[], B: number, seed: number): { lo: number; hi: number } {
  const n = v.length;
  if (n < 5) return { lo: NaN, hi: NaN };
  const L = Math.max(1, Math.round(Math.cbrt(n)));
  const nBlocks = Math.ceil(n / L);
  const rng = mulberry32(seed);
  const ms: number[] = [];
  for (let b = 0; b < B; b++) {
    let s = 0, cnt = 0;
    for (let blk = 0; blk < nBlocks && cnt < n; blk++) {
      const start = Math.floor(rng() * n);
      for (let j = 0; j < L && cnt < n; j++) { s += v[(start + j) % n]; cnt++; }
    }
    ms.push(s / cnt);
  }
  ms.sort((a, b) => a - b);
  return { lo: quantileSorted(ms, 0.025), hi: quantileSorted(ms, 0.975) };
}

export function computeUsBinEventStudy(p: EventStudyParams): EventStudyResult | null {
  const { prices, us, usMode, scheme, k, groupBy, filterBin, filterWeekday } = p;
  if (prices.length < 60 || us.length < 30) return null;

  const usVals = alignUsToDaily(prices, us, usMode);
  const present = usVals.filter((v): v is number => v !== null);
  if (present.length < 30) return null;
  const edges = binEdges(present, scheme);
  const meta = binMeta(scheme);
  const bins = usVals.map((v) => (v === null ? null : binOfValue(v, scheme, edges)));

  const binCounts = new Array(meta.count).fill(0);
  for (const b of bins) if (b !== null) binCounts[b]++;
  const binInfos: EventBinInfo[] = meta.labels.map((label, b) => ({
    bin: b, label, color: meta.colors[b], n: binCounts[b],
    rangeLo: b === 0 ? null : edges[b - 1],
    rangeHi: b === meta.count - 1 ? null : edges[b],
  }));

  // 直近の前夜米国(=これから寄る日の条件)
  const sortedUs = [...us].sort((a, b) => a.date.localeCompare(b.date));
  let latestUsDate: string | null = null, latestUsValue = 0, latestBin: number | null = null;
  for (let i = sortedUs.length - 1; i >= 0; i--) {
    const v = usMode === "intra" ? sortedUs[i].intra : sortedUs[i].ret;
    if (isFinite(v) && v !== 0) {
      latestUsDate = sortedUs[i].date; latestUsValue = v;
      latestBin = binOfValue(v, scheme, edges);
      break;
    }
  }

  const T = 2 * k + 1;
  const offsets = Array.from({ length: T }, (_, i) => i - k);

  // イベント日 i の累積経路。基準は i−1 の終値(=イベント前日終値)。
  const pathOf = (i: number): number[] | null => {
    if (i - k - 1 < 0 || i + k >= prices.length) return null;
    const base = prices[i - 1].close;
    if (!(base > 0)) return null;
    const out: number[] = [];
    for (let s = -k; s <= k; s++) {
      const c = prices[i + s].close;
      if (!(c > 0)) return null;
      out.push(Math.log(c / base));
    }
    return out;
  };

  // 群の定義
  interface RawGroup { key: string; label: string; color: string; idxs: number[]; }
  const raw: RawGroup[] = [];
  if (groupBy === "weekday") {
    for (const wd of [1, 2, 3, 4, 5]) {
      raw.push({ key: `wd${wd}`, label: WD_LABELS[wd], color: WD_COLORS[wd], idxs: [] });
    }
  } else {
    meta.labels.forEach((label, b) => {
      raw.push({ key: `bin${b}`, label, color: meta.colors[b], idxs: [] });
    });
  }

  for (let i = 0; i < prices.length; i++) {
    const b = bins[i];
    if (b === null) continue;
    const wd = weekdayOf(prices[i].time);
    if (wd < 1 || wd > 5) continue;
    if (groupBy === "weekday") {
      if (filterBin !== null && b !== filterBin) continue;
      raw[wd - 1].idxs.push(i);
    } else {
      if (filterWeekday !== 0 && wd !== filterWeekday) continue;
      raw[b].idxs.push(i);
    }
  }

  const groups: EventGroupStat[] = [];
  let maxAbs = 1e-6;
  let nTotal = 0;
  const postPs: number[] = [];

  for (const g of raw) {
    const paths: number[][] = [];
    const dates: string[] = [];
    for (const i of g.idxs) {
      const pth = pathOf(i);
      if (!pth) continue;
      paths.push(pth); dates.push(prices[i].time);
    }
    const n = paths.length;
    if (n === 0) {
      groups.push({
        key: g.key, label: g.label, color: g.color, n: 0,
        mean: new Array(T).fill(0), lo: new Array(T).fill(NaN), hi: new Array(T).fill(NaN),
        offP: new Array(T).fill(1), offPAdj: new Array(T).fill(1),
        car0: 0, carPost: 0, postDiff: 0, postT: 0, postP: 1, postPAdj: 1, postLo: NaN, postHi: NaN,
        reversalRate: 0.5, dates: [],
      });
      postPs.push(1);
      continue;
    }
    nTotal += n;

    const m = new Array(T).fill(0);
    const offP = new Array(T).fill(1);
    for (let t = 0; t < T; t++) {
      const col = paths.map((pp) => pp[t]);
      m[t] = mean(col);
      const tt = t === k - 1 ? null : tTest(col); // s=−1 は定義上ゼロなので検定しない
      offP[t] = tt ? tt.p : 1;
    }
    const offPAdj = benjaminiHochberg(offP);
    const ci = blockBootPaths(paths, 400, 0x9e3779b9 ^ g.key.length);

    const car0 = m[k]; // s=0
    const carPost = m[T - 1]; // s=+k
    const postVals = paths.map((pp) => pp[T - 1] - pp[k]); // イベント翌日以降の累積
    const pt = tTest(postVals);
    const pci = blockBootScalar(postVals, 500, 0x85ebca6b ^ g.key.length);
    const evtVals = paths.map((pp) => pp[k]);
    let rev = 0;
    for (let i = 0; i < n; i++) if ((evtVals[i] >= 0) !== (postVals[i] >= 0)) rev++;

    for (let t = 0; t < T; t++) {
      maxAbs = Math.max(maxAbs, Math.abs(m[t]));
      if (isFinite(ci.lo[t])) maxAbs = Math.max(maxAbs, Math.abs(ci.lo[t]), Math.abs(ci.hi[t]));
    }

    groups.push({
      key: g.key, label: g.label, color: g.color, n,
      mean: m, lo: ci.lo, hi: ci.hi, offP, offPAdj,
      car0, carPost,
      postDiff: mean(postVals),
      postT: pt ? pt.t : 0,
      postP: pt ? pt.p : 1,
      postPAdj: 1, // 全群が揃ってからFDR補正で埋める
      postLo: pci.lo, postHi: pci.hi,
      reversalRate: rev / n,
      dates,
    });
    postPs.push(pt ? pt.p : 1);
  }

  // 群横断の多重比較(翌日以降の累積が0と異なるか)はFDRで補正する。
  const adj = benjaminiHochberg(postPs);
  groups.forEach((g, i) => { g.postPAdj = adj[i]; });

  return {
    offsets, groups, binInfos, latestBin, latestUsDate, latestUsValue,
    maxAbs, nTotal,
  };
}
