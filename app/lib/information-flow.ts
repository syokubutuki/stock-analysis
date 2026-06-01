// 情報フロー: Symbolic Transfer Entropy, Partial Information Decomposition, Rolling TE/MI

import { mutualInformation } from "./causal";

// シンボル化: 中央値ベースでnSymbolsレベルに分割
export function symbolize(values: number[], nSymbols: number = 3): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const thresholds: number[] = [];
  for (let i = 1; i < nSymbols; i++) {
    thresholds.push(sorted[Math.floor((i / nSymbols) * sorted.length)]);
  }
  return values.map((v) => {
    let sym = 0;
    for (const t of thresholds) {
      if (v > t) sym++;
    }
    return sym;
  });
}

// シンボル化TE (高速)
export function symbolicTransferEntropy(x: number[], y: number[], lag: number = 1, order: number = 2): number {
  const n = Math.min(x.length, y.length);
  if (n < lag + order + 10) return 0;

  const sx = symbolize(x);
  const sy = symbolize(y);

  // TE(X→Y) = H(Y_t+1 | Y_t^order) - H(Y_t+1 | Y_t^order, X_t-lag^order)
  // カウントベースの計算
  const counts3: Map<string, number> = new Map(); // (y_{t+1}, y_past, x_past)
  const counts2yx: Map<string, number> = new Map(); // (y_past, x_past)
  const counts2yy: Map<string, number> = new Map(); // (y_{t+1}, y_past)
  const counts1y: Map<string, number> = new Map(); // (y_past)
  let total = 0;

  for (let t = Math.max(order, lag + order - 1); t < n - 1; t++) {
    const yFuture = sy[t + 1];
    const yPast = sy.slice(t - order + 1, t + 1).join(",");
    const xPast = sx.slice(t - lag - order + 2, t - lag + 1).join(",");

    const key3 = `${yFuture}|${yPast}|${xPast}`;
    const key2yx = `${yPast}|${xPast}`;
    const key2yy = `${yFuture}|${yPast}`;

    counts3.set(key3, (counts3.get(key3) || 0) + 1);
    counts2yx.set(key2yx, (counts2yx.get(key2yx) || 0) + 1);
    counts2yy.set(key2yy, (counts2yy.get(key2yy) || 0) + 1);
    counts1y.set(yPast, (counts1y.get(yPast) || 0) + 1);
    total++;
  }

  if (total === 0) return 0;

  let te = 0;
  for (const [key3, c3] of counts3) {
    const parts = key3.split("|");
    const key2yx = `${parts[1]}|${parts[2]}`;
    const key2yy = `${parts[0]}|${parts[1]}`;

    const c2yx = counts2yx.get(key2yx) || 0;
    const c2yy = counts2yy.get(key2yy) || 0;
    const c1y = counts1y.get(parts[1]) || 0;

    if (c2yx > 0 && c2yy > 0 && c1y > 0) {
      const p3 = c3 / total;
      te += p3 * Math.log2((c3 * c1y) / (c2yx * c2yy));
    }
  }
  return Math.max(0, te);
}

// Partial Information Decomposition (PID): unique/redundant/synergy
export interface PIDResult {
  mi_target_src1: number;
  mi_target_src2: number;
  mi_target_joint: number;
  redundancy: number;
  unique1: number;
  unique2: number;
  synergy: number;
}

export function partialInfoDecomposition(
  target: number[], src1: number[], src2: number[], bins: number = 12
): PIDResult {
  const n = Math.min(target.length, src1.length, src2.length);
  if (n < 20) return { mi_target_src1: 0, mi_target_src2: 0, mi_target_joint: 0, redundancy: 0, unique1: 0, unique2: 0, synergy: 0 };

  const t = target.slice(0, n);
  const s1 = src1.slice(0, n);
  const s2 = src2.slice(0, n);

  const mi1 = mutualInformation(t, s1, bins);
  const mi2 = mutualInformation(t, s2, bins);

  // Joint MI using combined source
  const jointSrc = s1.map((v, i) => v + s2[i]); // simplified joint encoding
  const miJoint = mutualInformation(t, jointSrc, bins);

  // Williams-Beer minimum redundancy
  const redundancy = Math.min(mi1, mi2);
  const unique1 = mi1 - redundancy;
  const unique2 = mi2 - redundancy;
  const synergy = Math.max(0, miJoint - mi1 - mi2 + redundancy);

  return { mi_target_src1: mi1, mi_target_src2: mi2, mi_target_joint: miJoint, redundancy, unique1, unique2, synergy };
}

export interface RollingFlowPoint {
  time: string;
  value: number;
}

// ローリングTE (causal.tsのTEをwindowed版に)
export function rollingTransferEntropy(
  x: number[], y: number[], times: string[], window: number = 120, lag: number = 1, step: number = 5
): RollingFlowPoint[] {
  const result: RollingFlowPoint[] = [];
  const n = Math.min(x.length, y.length);
  for (let i = window - 1; i < n; i += step) {
    const sx = x.slice(i - window + 1, i + 1);
    const sy = y.slice(i - window + 1, i + 1);
    const te = symbolicTransferEntropy(sx, sy, lag);
    result.push({ time: times[i], value: te });
  }
  return result;
}

// ローリングMI
export function rollingMutualInformation(
  x: number[], y: number[], times: string[], window: number = 60
): RollingFlowPoint[] {
  const result: RollingFlowPoint[] = [];
  const n = Math.min(x.length, y.length);
  for (let i = window - 1; i < n; i++) {
    const sx = x.slice(i - window + 1, i + 1);
    const sy = y.slice(i - window + 1, i + 1);
    result.push({ time: times[i], value: mutualInformation(sx, sy) });
  }
  return result;
}
