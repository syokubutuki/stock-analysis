// 日内累積パスを「群(曜日・月内位置・条件セル等)」で層別集計する共通土台。
//
// weekday-intraday-path / turn-of-month-path / 曜日×米国交互作用 が共有する。
// 各群の平均パス・中央値パス・95%帯(平均±1.96SE)・ピーク/ボトム時刻・終端(寄り→引け)の
// 平均と有意性を算出し、さらに群間で終端が有意に異なるかのペア比較(Welch t + FDR)を行う。
//
// 【経時ドリフト】平均パスは「N日のあいだ日内の形が変わっていない(定常)」を暗黙に仮定する。
// 直近だけ形が変わっていても平均は何事もなかったように出るため、群内をさらに日付順で
// 時代分割(古い→直近)し、形状が変化してきたかを検定付きで示す(buildPathEvolution)。

import { mean, std, median, tTest, benjaminiHochberg } from "./stats-significance";
import { studentTwoSidedP } from "./us-spillover-core";

// 1群 = 同じラベルに属する日の累積パス集合。各 path は長さ G(時間ビン数)。
export interface PathGroup {
  key: string;
  label: string;
  color: string;
  paths: number[][];
  // paths と同じ順序の営業日。与えると経時ドリフト(days/eras/drift)を算出する。
  // 同一日に複数観測(バスケットの複数銘柄)がある場合は日内平均に畳んでから扱う。
  dates?: string[];
}

// 個別日の累積パス(日付昇順)。同一日の複数観測は畳んだ後の1本。
export interface DayPath {
  date: string;
  values: number[]; // 長さG
  end: number; // 寄り→引け
  peakIdx: number; // その日の高値時刻ビン(argmax)
  troughIdx: number; // その日の安値時刻ビン(argmin)
}

// 群内を日付順に等分割した「時代」。古い→直近の順に並ぶ。
export interface PathEra {
  key: string;
  label: string;
  n: number;
  from: string; // 期間の最初の営業日
  to: string; // 期間の最後の営業日
  mean: number[]; // その時代だけの平均パス
  endMean: number;
  peakIdx: number; // その時代の平均パスの高値時刻
  troughIdx: number; // 同 安値時刻
}

// 形状が経時変化しているかの検定。
export interface PathDrift {
  nEarly: number;
  nLate: number;
  endEarly: number; // 最古の時代の終端平均
  endLate: number; // 直近の時代の終端平均
  endDiff: number; // 直近 − 最古
  endP: number; // 上記差の Welch 2標本t検定 p値
  // 高安「時刻」のドリフト: 日付順位 と 各日の高値/安値時刻ビン の Spearman 順位相関。
  // ρ>0 = 時刻が後ろ倒しに移動、ρ<0 = 前倒し。
  peakRho: number;
  peakP: number;
  troughRho: number;
  troughP: number;
  nRho: number; // 順位相関に使った日数
}

export interface PathStat {
  key: string;
  label: string;
  color: string;
  n: number;
  mean: number[]; // 各時間ビンの平均累積リターン
  med: number[]; // 各時間ビンの中央値累積リターン(外れ値に頑健)
  lo: number[]; // 平均 − 1.96·SE
  hi: number[]; // 平均 + 1.96·SE
  endMean: number; // 寄り→引けの平均(平均パス終端)
  endMed: number; // 寄り→引けの中央値
  endP: number; // 終端平均が0と異なるかの1標本t検定p値
  endValues: number[]; // 各日の終端(寄り→引け)累積リターン。群間比較に使う
  peakIdx: number; // 平均パスが最大になる時間ビン
  troughIdx: number; // 平均パスが最小になる時間ビン
  // ── 経時ドリフト(PathGroup.dates を与えた場合のみ中身が入る) ──
  days: DayPath[]; // 個別日パス(日付昇順)。新旧グラデーション描画用
  eras: PathEra[]; // 時代分割の平均パス(古→新)。標本不足なら空
  drift: PathDrift | null; // 形状変化の検定。標本不足なら null
}

// 群間で終端リターンが異なるかのペア比較(Welchの2標本t検定 → BHでFDR補正)。
export interface PairDiff {
  i: number; // stats のインデックス
  j: number;
  diff: number; // endMean_i − endMean_j
  p: number; // 生p値
  pAdj: number; // FDR補正後p値
}

// ───────────────────────── 経時ドリフト ─────────────────────────

// 同順位に平均順位を割り当てるランク変換(Spearmanのタイ補正に必須)。
function avgRanks(v: number[]): number[] {
  const idx = v.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const r = new Array(v.length).fill(0);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1].x === idx[k].x) j++;
    const rank = (k + j) / 2 + 1; // 同値は平均順位
    for (let m = k; m <= j; m++) r[idx[m].i] = rank;
    k = j + 1;
  }
  return r;
}

// Spearman順位相関(タイ補正済)と、t近似による両側p値。
function spearman(x: number[], y: number[]): { rho: number; p: number } | null {
  const n = x.length;
  if (n < 5) return null;
  const rx = avgRanks(x), ry = avgRanks(y);
  const mx = mean(rx), my = mean(ry);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - mx, dy = ry[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null; // 全日で同じ時刻に高値=順位相関は定義できない
  const rho = sxy / Math.sqrt(sxx * syy);
  if (Math.abs(rho) >= 1) return { rho, p: 0 };
  const t = rho * Math.sqrt((n - 2) / (1 - rho * rho));
  return { rho, p: studentTwoSidedP(t, n - 2) };
}

function argMax(a: number[]): number {
  let k = 0;
  for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i;
  return k;
}
function argMin(a: number[]): number {
  let k = 0;
  for (let i = 1; i < a.length; i++) if (a[i] < a[k]) k = i;
  return k;
}

const ERA_LABELS: Record<number, string[]> = {
  2: ["前半", "直近半分"],
  3: ["古い1/3", "中間1/3", "直近1/3"],
};

// 群の個別日パスを日付昇順に整え、時代分割の平均パスと形状ドリフトの検定を返す。
//
// 同一日に複数観測(バスケットの複数銘柄)がある場合は、まずその日の平均パスに畳む。
// 同じ日の銘柄は一斉に動く(横断相関)ため素朴に並べると独立日数を水増ししてしまい、
// ドリフト検定のp値が不当に小さくなる。畳むことで検定の単位を必ず「独立な営業日」にする。
export function buildPathEvolution(
  paths: number[][], dates: string[], G: number
): { days: DayPath[]; eras: PathEra[]; drift: PathDrift | null } {
  if (paths.length === 0 || dates.length !== paths.length || G < 2) {
    return { days: [], eras: [], drift: null };
  }

  // 1) 同一日を平均に畳む
  const byDate = new Map<string, { sum: number[]; k: number }>();
  for (let i = 0; i < paths.length; i++) {
    const cur = byDate.get(dates[i]);
    if (cur) {
      for (let g = 0; g < G; g++) cur.sum[g] += paths[i][g];
      cur.k++;
    } else {
      byDate.set(dates[i], { sum: paths[i].slice(0, G), k: 1 });
    }
  }
  const days: DayPath[] = Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, { sum, k }]) => {
      const values = sum.map((s) => s / k);
      return { date, values, end: values[G - 1], peakIdx: argMax(values), troughIdx: argMin(values) };
    });

  const n = days.length;
  // 2) 時代分割。1期あたり4日を切ると平均パスは形状でなく個別日ノイズになるため打ち切る。
  const K = n >= 12 ? 3 : n >= 8 ? 2 : 0;
  const eras: PathEra[] = [];
  for (let e = 0; e < K; e++) {
    const from = Math.floor((e * n) / K), to = Math.floor(((e + 1) * n) / K);
    const slice = days.slice(from, to);
    const m = new Array(G).fill(0);
    for (let g = 0; g < G; g++) m[g] = mean(slice.map((d) => d.values[g]));
    eras.push({
      key: `era${e}`,
      label: ERA_LABELS[K][e],
      n: slice.length,
      from: slice[0].date,
      to: slice[slice.length - 1].date,
      mean: m,
      endMean: m[G - 1],
      peakIdx: argMax(m),
      troughIdx: argMin(m),
    });
  }

  // 3) ドリフト検定: 終端は最古 vs 直近の Welch、高安時刻は日付順位との Spearman。
  let drift: PathDrift | null = null;
  if (K >= 2) {
    const early = days.slice(0, Math.floor(n / K));
    const late = days.slice(n - Math.floor(n / K));
    const eEnd = early.map((d) => d.end), lEnd = late.map((d) => d.end);
    const w = welchP(lEnd, eEnd);
    const rank = days.map((_, i) => i);
    const pk = spearman(rank, days.map((d) => d.peakIdx));
    const tr = spearman(rank, days.map((d) => d.troughIdx));
    drift = {
      nEarly: early.length,
      nLate: late.length,
      endEarly: mean(eEnd),
      endLate: mean(lEnd),
      endDiff: mean(lEnd) - mean(eEnd),
      endP: w ? w.p : 1,
      peakRho: pk ? pk.rho : 0,
      peakP: pk ? pk.p : 1,
      troughRho: tr ? tr.rho : 0,
      troughP: tr ? tr.p : 1,
      nRho: n,
    };
  }

  return { days, eras, drift };
}

export function buildPathStats(groups: PathGroup[], G: number): { stats: PathStat[]; maxAbs: number } {
  let maxAbs = 1e-6;
  const stats: PathStat[] = groups.map((grp) => {
    const mat = grp.paths;
    const m = new Array(G).fill(0), md = new Array(G).fill(0), lo = new Array(G).fill(0), hi = new Array(G).fill(0);
    if (mat.length > 0) {
      for (let g = 0; g < G; g++) {
        const col = mat.map((p) => p[g]);
        const mm = mean(col), se = mat.length > 1 ? std(col) / Math.sqrt(mat.length) : 0;
        m[g] = mm; md[g] = median(col); lo[g] = mm - 1.96 * se; hi[g] = mm + 1.96 * se;
        maxAbs = Math.max(maxAbs, Math.abs(hi[g]), Math.abs(lo[g]), Math.abs(md[g]));
      }
    }
    // ピーク/ボトム(平均パスの最大・最小時間ビン)
    let peakIdx = 0, troughIdx = 0;
    for (let g = 1; g < G; g++) {
      if (m[g] > m[peakIdx]) peakIdx = g;
      if (m[g] < m[troughIdx]) troughIdx = g;
    }
    const endValues = mat.map((p) => p[G - 1]);
    const tt = tTest(endValues);
    const evo = grp.dates
      ? buildPathEvolution(mat, grp.dates, G)
      : { days: [], eras: [], drift: null };
    return {
      key: grp.key, label: grp.label, color: grp.color, n: mat.length,
      mean: m, med: md, lo, hi,
      endMean: m[G - 1], endMed: md[G - 1], endP: tt ? tt.p : 1,
      endValues, peakIdx, troughIdx,
      days: evo.days, eras: evo.eras, drift: evo.drift,
    };
  });
  return { stats, maxAbs };
}

// Welch(等分散を仮定しない)2標本t検定の両側p値。
function welchP(a: number[], b: number[]): { t: number; p: number } | null {
  const n1 = a.length, n2 = b.length;
  if (n1 < 3 || n2 < 3) return null;
  const m1 = mean(a), m2 = mean(b);
  const v1 = std(a) ** 2, v2 = std(b) ** 2;
  const s = v1 / n1 + v2 / n2;
  if (s <= 0) return null;
  const t = (m1 - m2) / Math.sqrt(s);
  const df = (s * s) / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
  return { t, p: studentTwoSidedP(t, df) };
}

// 全群ペアの終端リターン差を検定し、FDR補正後p値を付す。
export function pairwiseEndDiffs(stats: PathStat[]): PairDiff[] {
  const pairs: { i: number; j: number; diff: number; p: number }[] = [];
  for (let i = 0; i < stats.length; i++) {
    for (let j = i + 1; j < stats.length; j++) {
      if (stats[i].n < 3 || stats[j].n < 3) continue;
      const w = welchP(stats[i].endValues, stats[j].endValues);
      if (!w) continue;
      pairs.push({ i, j, diff: stats[i].endMean - stats[j].endMean, p: w.p });
    }
  }
  const adj = benjaminiHochberg(pairs.map((x) => x.p));
  return pairs.map((x, k) => ({ ...x, pAdj: adj[k] }));
}
