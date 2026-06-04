// Bai-Perron 構造変化検定（簡易版）
// CUSUM + Binary Segmentation による変化点検出

export interface BreakPoint {
  index: number;
  time: string;
  stat: number;     // 検定統計量
  meanBefore: number;
  meanAfter: number;
  varBefore: number;
  varAfter: number;
}

export interface StructuralBreakResult {
  breaks: BreakPoint[];
  cusum: { time: string; value: number }[];
  nSegments: number;
  interpretation: string;
}

// --- CUSUM (Cumulative Sum) ベースの変化点検出 ---
export function detectStructuralBreaks(
  values: number[],
  times: string[],
  maxBreaks: number = 5,
  minSegment: number = 30
): StructuralBreakResult {
  const n = values.length;
  if (n < 60) return emptyBreaks();

  // Compute CUSUM
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;

  const cusum: number[] = new Array(n);
  cusum[0] = values[0] - mean;
  for (let i = 1; i < n; i++) {
    cusum[i] = cusum[i - 1] + (values[i] - mean);
  }

  // Normalize
  let s2 = 0;
  for (const v of values) s2 += (v - mean) ** 2;
  s2 = Math.sqrt(s2 / n);
  const normalizedCusum = cusum.map(c => c / (s2 * Math.sqrt(n)));

  // Binary segmentation
  const breakIndices: number[] = [];
  findBreaks(values, 0, n - 1, breakIndices, maxBreaks, minSegment);

  // Sort and compute statistics
  breakIndices.sort((a, b) => a - b);

  const breaks: BreakPoint[] = breakIndices.map(idx => {
    const before = values.slice(Math.max(0, idx - minSegment), idx);
    const after = values.slice(idx, Math.min(n, idx + minSegment));

    const meanBefore = before.reduce((s, v) => s + v, 0) / before.length;
    const meanAfter = after.reduce((s, v) => s + v, 0) / after.length;

    let varBefore = 0;
    for (const v of before) varBefore += (v - meanBefore) ** 2;
    varBefore /= before.length;

    let varAfter = 0;
    for (const v of after) varAfter += (v - meanAfter) ** 2;
    varAfter /= after.length;

    // CUSUM statistic at break point
    const stat = Math.abs(normalizedCusum[idx]);

    return { index: idx, time: times[idx], stat, meanBefore, meanAfter, varBefore, varAfter };
  });

  // Filter significant breaks (stat > critical value ~1.36 for 5%)
  const significantBreaks = breaks.filter(b => b.stat > 1.0);

  const cusumData = normalizedCusum.map((v, i) => ({ time: times[i], value: v }));

  const interpretation = significantBreaks.length > 0
    ? `${significantBreaks.length}個の構造変化点を検出。` +
      significantBreaks.map(b =>
        `${b.time}: 平均 ${b.meanBefore.toFixed(4)}→${b.meanAfter.toFixed(4)}`
      ).join("、") + "。"
    : "統計的に有意な構造変化点は検出されず。";

  return {
    breaks: significantBreaks,
    cusum: cusumData,
    nSegments: significantBreaks.length + 1,
    interpretation,
  };
}

// Binary segmentation
function findBreaks(
  values: number[],
  start: number,
  end: number,
  result: number[],
  maxBreaks: number,
  minSegment: number
): void {
  if (result.length >= maxBreaks) return;
  if (end - start < minSegment * 2) return;

  // Find the point with maximum |CUSUM|
  let localMean = 0;
  for (let i = start; i <= end; i++) localMean += values[i];
  localMean /= end - start + 1;

  let cumSum = 0;
  let maxStat = 0;
  let bestIdx = -1;
  const len = end - start + 1;

  let s2 = 0;
  for (let i = start; i <= end; i++) s2 += (values[i] - localMean) ** 2;
  const stdDev = Math.sqrt(s2 / len);
  if (stdDev <= 0) return;

  for (let i = start; i <= end; i++) {
    cumSum += values[i] - localMean;
    const stat = Math.abs(cumSum) / (stdDev * Math.sqrt(len));

    if (i >= start + minSegment && i <= end - minSegment && stat > maxStat) {
      maxStat = stat;
      bestIdx = i;
    }
  }

  // Critical value for CUSUM (approximation)
  if (maxStat > 1.0 && bestIdx >= 0) {
    result.push(bestIdx);
    findBreaks(values, start, bestIdx - 1, result, maxBreaks, minSegment);
    findBreaks(values, bestIdx + 1, end, result, maxBreaks, minSegment);
  }
}

function emptyBreaks(): StructuralBreakResult {
  return { breaks: [], cusum: [], nSegments: 1, interpretation: "データ不足" };
}
