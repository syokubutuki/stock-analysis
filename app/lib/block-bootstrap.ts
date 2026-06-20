// 13.4 ブロック・ブートストラップでの頑健性。
// エクイティ（日次リターン列）をブロック単位で再標本化し、最終リターン・シャープの
// 信頼区間を出す。過剰最適化や偶然の好成績を見破る。

import { PricePoint } from "./types";

function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface BootstrapResult {
  actualTerminal: number; actualSharpe: number;
  terminalLo: number; terminalHi: number; terminalMedian: number;
  sharpeLo: number; sharpeHi: number; sharpeMedian: number;
  pPositive: number; // 最終リターンが正だったブート標本の割合
  samples: number[]; // 最終リターン分布（ヒスト用）
}

export function blockBootstrap(prices: PricePoint[], B = 1000): BootstrapResult | null {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) if (prices[i - 1].close > 0) r.push(prices[i].close / prices[i - 1].close - 1);
  const n = r.length;
  if (n < 60) return null;
  const L = Math.max(5, Math.round(Math.cbrt(n)) * 2);
  const nBlocks = Math.ceil(n / L);

  const ann = Math.sqrt(252);
  const actualTerminal = r.reduce((eq, x) => eq * (1 + x), 1) - 1;
  const actualSharpe = std(r) > 0 ? (mean(r) / std(r)) * ann : 0;

  const terms: number[] = [], sharpes: number[] = [];
  for (let b = 0; b < B; b++) {
    const sample: number[] = [];
    for (let blk = 0; blk < nBlocks; blk++) {
      const start = Math.floor(Math.random() * n);
      for (let j = 0; j < L && sample.length < n; j++) sample.push(r[(start + j) % n]);
    }
    terms.push(sample.reduce((eq, x) => eq * (1 + x), 1) - 1);
    sharpes.push(std(sample) > 0 ? (mean(sample) / std(sample)) * ann : 0);
  }
  const ts = [...terms].sort((a, b) => a - b), ss = [...sharpes].sort((a, b) => a - b);
  return {
    actualTerminal, actualSharpe,
    terminalLo: quantile(ts, 0.05), terminalHi: quantile(ts, 0.95), terminalMedian: quantile(ts, 0.5),
    sharpeLo: quantile(ss, 0.05), sharpeHi: quantile(ss, 0.95), sharpeMedian: quantile(ss, 0.5),
    pPositive: terms.filter((t) => t > 0).length / B,
    samples: terms,
  };
}
