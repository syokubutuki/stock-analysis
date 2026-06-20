// 1.1 ローソク足パターンの統計的エッジ。
// 代表的なパターンを検出し、出現後N日先リターンの分布・勝率・t検定・FDR補正で
// 「そのパターンは本当に効くのか（偶然でないか）」を確率で裏取りする。

import { PricePoint } from "./types";
import { mean, std, tTest, benjaminiHochberg } from "./stats-significance";

export type PatternKind =
  | "bullEngulf" | "bearEngulf" | "hammer" | "shootingStar"
  | "doji" | "morningStar" | "eveningStar" | "threeWhite" | "threeBlack" | "bullHarami" | "bearHarami";

export interface PatternMeta {
  kind: PatternKind;
  label: string;
  bias: "bull" | "bear";
}

export const PATTERNS: PatternMeta[] = [
  { kind: "bullEngulf", label: "強気包み線", bias: "bull" },
  { kind: "bearEngulf", label: "弱気包み線", bias: "bear" },
  { kind: "hammer", label: "ハンマー(たくり)", bias: "bull" },
  { kind: "shootingStar", label: "流れ星", bias: "bear" },
  { kind: "doji", label: "十字線(同時)", bias: "bull" },
  { kind: "morningStar", label: "明けの明星", bias: "bull" },
  { kind: "eveningStar", label: "宵の明星", bias: "bear" },
  { kind: "threeWhite", label: "赤三兵", bias: "bull" },
  { kind: "threeBlack", label: "黒三兵", bias: "bear" },
  { kind: "bullHarami", label: "強気はらみ", bias: "bull" },
  { kind: "bearHarami", label: "弱気はらみ", bias: "bear" },
];

interface C { o: number; h: number; l: number; c: number; body: number; range: number; up: boolean; }
function toC(p: PricePoint): C {
  const range = p.high - p.low || 1e-9;
  return { o: p.open, h: p.high, l: p.low, c: p.close, body: Math.abs(p.close - p.open), range, up: p.close > p.open };
}

// i 日にパターン kind が成立するか（i は確定足）
function detect(prices: PricePoint[], i: number, kind: PatternKind): boolean {
  if (i < 2) return false;
  const c0 = toC(prices[i]); // 当日
  const c1 = toC(prices[i - 1]); // 前日
  const c2 = toC(prices[i - 2]);
  const upperWick = c0.h - Math.max(c0.o, c0.c);
  const lowerWick = Math.min(c0.o, c0.c) - c0.l;
  switch (kind) {
    case "bullEngulf":
      return !c1.up && c0.up && c0.c >= c1.o && c0.o <= c1.c && c0.body > c1.body;
    case "bearEngulf":
      return c1.up && !c0.up && c0.o >= c1.c && c0.c <= c1.o && c0.body > c1.body;
    case "hammer":
      return lowerWick >= 2 * c0.body && upperWick <= c0.body * 0.6 && c0.body / c0.range < 0.4;
    case "shootingStar":
      return upperWick >= 2 * c0.body && lowerWick <= c0.body * 0.6 && c0.body / c0.range < 0.4;
    case "doji":
      return c0.body / c0.range < 0.1;
    case "morningStar":
      return !c2.up && c2.body / c2.range > 0.5 && c1.body / c1.range < 0.4 && c0.up && c0.c > (c2.o + c2.c) / 2;
    case "eveningStar":
      return c2.up && c2.body / c2.range > 0.5 && c1.body / c1.range < 0.4 && !c0.up && c0.c < (c2.o + c2.c) / 2;
    case "threeWhite":
      return c2.up && c1.up && c0.up && c1.c > c2.c && c0.c > c1.c && c1.o > c2.o && c0.o > c1.o;
    case "threeBlack":
      return !c2.up && !c1.up && !c0.up && c1.c < c2.c && c0.c < c1.c && c1.o < c2.o && c0.o < c1.o;
    case "bullHarami":
      return !c1.up && c1.body / c1.range > 0.5 && c0.up && c0.h <= c1.o && c0.l >= c1.c;
    case "bearHarami":
      return c1.up && c1.body / c1.range > 0.5 && !c0.up && c0.h <= c1.c && c0.l >= c1.o;
  }
}

export interface PatternEdge {
  meta: PatternMeta;
  n: number;
  meanFwd: number;
  medianFwd: number;
  winRate: number;
  std: number;
  p: number; // FDR補正後
  significant: boolean;
  recentTimes: string[]; // 直近の出現日（マーカー用）
}

export interface PatternEdgeResult {
  edges: PatternEdge[];
  horizon: number;
  recentBanner: { label: string; time: string; edge: PatternEdge }[]; // 直近5営業日の検出
}

export function patternEdges(prices: PricePoint[], horizon: number): PatternEdgeResult {
  const n = prices.length;
  const perPattern = new Map<PatternKind, { rets: number[]; times: string[] }>();
  for (const pm of PATTERNS) perPattern.set(pm.kind, { rets: [], times: [] });

  for (let i = 2; i < n - horizon; i++) {
    const entry = prices[i].close;
    if (!(entry > 0)) continue;
    const exit = prices[i + horizon].close;
    if (!(exit > 0)) continue;
    const r = (exit - entry) / entry;
    for (const pm of PATTERNS) {
      if (detect(prices, i, pm.kind)) {
        const g = perPattern.get(pm.kind)!;
        // 弱気パターンは「下落で当たり」なので符号反転して“パターンの効き”を評価
        g.rets.push(pm.bias === "bear" ? -r : r);
        g.times.push(prices[i].time);
      }
    }
  }

  const present = PATTERNS.filter((pm) => (perPattern.get(pm.kind)!.rets.length) >= 5);
  const pRaw = present.map((pm) => {
    const t = tTest(perPattern.get(pm.kind)!.rets);
    return t ? t.p : 1;
  });
  const pAdj = benjaminiHochberg(pRaw);

  const edges: PatternEdge[] = present.map((pm, k) => {
    const g = perPattern.get(pm.kind)!;
    const sorted = [...g.rets].sort((a, b) => a - b);
    return {
      meta: pm,
      n: g.rets.length,
      meanFwd: mean(g.rets),
      medianFwd: sorted[Math.floor(sorted.length / 2)],
      winRate: g.rets.filter((r) => r > 0).length / g.rets.length,
      std: std(g.rets),
      p: pAdj[k],
      significant: pAdj[k] < 0.05,
      recentTimes: g.times.slice(-30),
    };
  });
  edges.sort((a, b) => a.p - b.p || b.meanFwd - a.meanFwd);

  // 直近5営業日の検出（先行きNはまだ未確定でも検出のみ）
  const recentBanner: { label: string; time: string; edge: PatternEdge }[] = [];
  for (let i = Math.max(2, n - 5); i < n; i++) {
    for (const pm of PATTERNS) {
      if (detect(prices, i, pm.kind)) {
        const edge = edges.find((e) => e.meta.kind === pm.kind);
        if (edge) recentBanner.push({ label: pm.label, time: prices[i].time, edge });
      }
    }
  }

  return { edges, horizon, recentBanner };
}
