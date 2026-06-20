// 3.2 高安スプレッド推定（Corwin-Schultz / Abdi-Ranaldo）＋ 3.1 Amihud非流動性。
// 板・約定データ無しに、日足の高値・安値・終値だけから実効スプレッド（取引コスト）と
// 流動性を近似する。レンジ（高安）は分散＋スプレッド両方を含むが、連続2日に共通する
// 成分からスプレッドを分離できる、という発想。

import { PricePoint } from "./types";

export interface SpreadPoint {
  time: string;
  cs: number; // Corwin-Schultz 実効スプレッド（割合）
  ar: number; // Abdi-Ranaldo
  amihud: number; // Amihud非流動性（×1e6, スケール済）
}

const K = 3 - 2 * Math.sqrt(2);

// 1日ペア (t, t+1) の Corwin-Schultz スプレッド推定。
function csPair(p0: PricePoint, p1: PricePoint): number {
  const h0 = p0.high, l0 = p0.low, h1 = p1.high, l1 = p1.low;
  if (!(h0 > 0 && l0 > 0 && h1 > 0 && l1 > 0)) return NaN;
  const beta = Math.log(h0 / l0) ** 2 + Math.log(h1 / l1) ** 2;
  const hMax = Math.max(h0, h1);
  const lMin = Math.min(l0, l1);
  const gamma = Math.log(hMax / lMin) ** 2;
  const alpha = (Math.sqrt(2 * beta) - Math.sqrt(beta)) / K - Math.sqrt(gamma / K);
  const s = (2 * (Math.exp(alpha) - 1)) / (1 + Math.exp(alpha));
  return Math.max(0, s); // 負値は0クリップ
}

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

// ローリング（窓 window 日）でスプレッド/非流動性の時系列を返す。
export function estimateSpread(prices: PricePoint[], window = 21): SpreadPoint[] {
  const n = prices.length;
  if (n < window + 2) return [];

  // 日次系列
  const csDaily: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n - 1; i++) csDaily[i] = csPair(prices[i], prices[i + 1]);

  // Abdi-Ranaldo: η_t = (lnH+lnL)/2, c_t=lnC。S=2√(max(0, E[(c−η)(c−η_next)]))
  const eta: number[] = new Array(n).fill(NaN);
  const c: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (prices[i].high > 0 && prices[i].low > 0 && prices[i].close > 0) {
      eta[i] = (Math.log(prices[i].high) + Math.log(prices[i].low)) / 2;
      c[i] = Math.log(prices[i].close);
    }
  }
  const arDaily: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n - 1; i++) {
    if (!isNaN(c[i]) && !isNaN(eta[i]) && !isNaN(eta[i + 1])) {
      arDaily[i] = (c[i] - eta[i]) * (c[i] - eta[i + 1]);
    }
  }

  // Amihud: |r_t| / (出来高×終値)。流動性が低いほど大。スケール ×1e9 で見やすく。
  const amDaily: number[] = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const dv = prices[i].volume * prices[i].close;
    if (dv > 0 && prices[i - 1].close > 0) {
      amDaily[i] = (Math.abs(Math.log(prices[i].close / prices[i - 1].close)) / dv) * 1e9;
    }
  }

  const out: SpreadPoint[] = [];
  for (let i = window; i < n; i++) {
    const cs = mean(csDaily.slice(i - window + 1, i + 1).filter((v) => !isNaN(v)));
    const arCov = mean(arDaily.slice(i - window + 1, i + 1).filter((v) => !isNaN(v)));
    const ar = 2 * Math.sqrt(Math.max(0, arCov));
    const amihud = mean(amDaily.slice(i - window + 1, i + 1).filter((v) => !isNaN(v)));
    out.push({ time: prices[i].time, cs, ar, amihud });
  }
  return out;
}

// 取引コスト控除用の代表スプレッド（割合, 片道）。ローリングCSスプレッドの中央値を
// 頑健な推定として返す。バックテストのコスト控除のデフォルト値に使う。
export function representativeSpread(prices: PricePoint[], window = 21): number {
  const series = estimateSpread(prices, window);
  const vals = series.map((s) => s.cs).filter((v) => v > 0 && isFinite(v)).sort((a, b) => a - b);
  if (vals.length === 0) return 0;
  return vals[Math.floor(vals.length / 2)];
}
