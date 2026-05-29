import { PricePoint } from "./types";

export interface BenchmarkPoint {
  time: string;
  stockNorm: number;  // normalized to 100
  benchNorm: number;
  excessReturn: number; // stock log return - bench log return
}

export interface BenchmarkStats {
  beta: number;
  alpha: number;         // annualized
  correlation: number;
  trackingError: number; // annualized
  informationRatio: number;
  stockReturn: number;   // total
  benchReturn: number;
  excessReturn: number;
}

// Align two price series by date (inner join)
export function alignSeries(
  stock: PricePoint[],
  bench: PricePoint[]
): { stock: PricePoint[]; bench: PricePoint[] } {
  const benchMap = new Map<string, PricePoint>();
  for (const p of bench) benchMap.set(p.time, p);

  const alignedStock: PricePoint[] = [];
  const alignedBench: PricePoint[] = [];

  for (const s of stock) {
    const b = benchMap.get(s.time);
    if (b) {
      alignedStock.push(s);
      alignedBench.push(b);
    }
  }

  return { stock: alignedStock, bench: alignedBench };
}

export function computeBenchmarkSeries(
  stock: PricePoint[],
  bench: PricePoint[]
): BenchmarkPoint[] {
  if (stock.length < 2 || bench.length < 2) return [];

  const baseStock = stock[0].close;
  const baseBench = bench[0].close;
  if (baseStock <= 0 || baseBench <= 0) return [];

  const result: BenchmarkPoint[] = [];
  for (let i = 0; i < stock.length; i++) {
    const sRet = i > 0 && stock[i - 1].close > 0
      ? Math.log(stock[i].close / stock[i - 1].close)
      : 0;
    const bRet = i > 0 && bench[i - 1].close > 0
      ? Math.log(bench[i].close / bench[i - 1].close)
      : 0;

    result.push({
      time: stock[i].time,
      stockNorm: (stock[i].close / baseStock) * 100,
      benchNorm: (bench[i].close / baseBench) * 100,
      excessReturn: sRet - bRet,
    });
  }
  return result;
}

export function computeBenchmarkStats(
  stock: PricePoint[],
  bench: PricePoint[]
): BenchmarkStats {
  if (stock.length < 10) {
    return {
      beta: 0, alpha: 0, correlation: 0,
      trackingError: 0, informationRatio: 0,
      stockReturn: 0, benchReturn: 0, excessReturn: 0,
    };
  }

  const sReturns: number[] = [];
  const bReturns: number[] = [];
  for (let i = 1; i < stock.length; i++) {
    if (stock[i - 1].close > 0 && bench[i - 1].close > 0) {
      sReturns.push(Math.log(stock[i].close / stock[i - 1].close));
      bReturns.push(Math.log(bench[i].close / bench[i - 1].close));
    }
  }

  const n = sReturns.length;
  if (n < 5) {
    return {
      beta: 0, alpha: 0, correlation: 0,
      trackingError: 0, informationRatio: 0,
      stockReturn: 0, benchReturn: 0, excessReturn: 0,
    };
  }

  const sMean = sReturns.reduce((a, b) => a + b, 0) / n;
  const bMean = bReturns.reduce((a, b) => a + b, 0) / n;

  let cov = 0, sVar = 0, bVar = 0;
  for (let i = 0; i < n; i++) {
    cov += (sReturns[i] - sMean) * (bReturns[i] - bMean);
    sVar += (sReturns[i] - sMean) ** 2;
    bVar += (bReturns[i] - bMean) ** 2;
  }
  cov /= n;
  sVar /= n;
  bVar /= n;

  const beta = bVar > 0 ? cov / bVar : 0;
  const alpha = (sMean - beta * bMean) * 252; // annualized
  const correlation = sVar > 0 && bVar > 0
    ? cov / Math.sqrt(sVar * bVar)
    : 0;

  // Tracking error
  const excessReturns = sReturns.map((s, i) => s - bReturns[i]);
  const exMean = excessReturns.reduce((a, b) => a + b, 0) / n;
  const teVariance = excessReturns.reduce((a, v) => a + (v - exMean) ** 2, 0) / (n - 1);
  const trackingError = Math.sqrt(teVariance) * Math.sqrt(252);
  const informationRatio = trackingError > 0 ? (exMean * 252) / trackingError : 0;

  const stockReturn = stock.length >= 2
    ? (stock[stock.length - 1].close / stock[0].close) - 1
    : 0;
  const benchReturn = bench.length >= 2
    ? (bench[bench.length - 1].close / bench[0].close) - 1
    : 0;

  return {
    beta, alpha, correlation, trackingError, informationRatio,
    stockReturn, benchReturn, excessReturn: stockReturn - benchReturn,
  };
}

// Rolling beta
export interface RollingBetaPoint {
  time: string;
  beta: number;
  correlation: number;
}

export function rollingBeta(
  stock: PricePoint[],
  bench: PricePoint[],
  window: number = 60
): RollingBetaPoint[] {
  const result: RollingBetaPoint[] = [];
  for (let i = window; i < stock.length; i++) {
    const sSlice = stock.slice(i - window, i + 1);
    const bSlice = bench.slice(i - window, i + 1);
    const stats = computeBenchmarkStats(sSlice, bSlice);
    result.push({
      time: stock[i].time,
      beta: stats.beta,
      correlation: stats.correlation,
    });
  }
  return result;
}

// Rule-based auto summary
export function generateComparisonSummary(
  label: string,
  stats: BenchmarkStats
): string {
  const parts: string[] = [];

  // Beta characterization
  if (stats.beta > 1.5) parts.push(`${label}に対しβ=${stats.beta.toFixed(2)}と非常に高感応度 (市場の1.5倍以上変動するハイリスク銘柄)`);
  else if (stats.beta > 1.2) parts.push(`${label}に対しβ=${stats.beta.toFixed(2)}と高め (市場以上に変動する攻撃的な銘柄)`);
  else if (stats.beta > 0.8) parts.push(`${label}に対しβ=${stats.beta.toFixed(2)}で市場並みの感応度`);
  else if (stats.beta > 0.5) parts.push(`${label}に対しβ=${stats.beta.toFixed(2)}と低め (市場より安定的な防御銘柄)`);
  else parts.push(`${label}に対しβ=${stats.beta.toFixed(2)}と極めて低い (市場との連動が弱い)`);

  // Correlation
  if (stats.correlation > 0.8) parts.push(`相関${stats.correlation.toFixed(2)}で強い連動性あり`);
  else if (stats.correlation > 0.5) parts.push(`相関${stats.correlation.toFixed(2)}で中程度の連動`);
  else if (stats.correlation > 0.2) parts.push(`相関${stats.correlation.toFixed(2)}で連動性が低く分散投資効果が期待できる`);
  else parts.push(`相関${stats.correlation.toFixed(2)}でほぼ無相関 (独自の値動き)`);

  // Alpha
  const alphaPct = (stats.alpha * 100).toFixed(1);
  if (stats.alpha > 0.1) parts.push(`年率α=+${alphaPct}%と大幅に上回る超過収益`);
  else if (stats.alpha > 0.03) parts.push(`年率α=+${alphaPct}%のプラス超過収益`);
  else if (stats.alpha > -0.03) parts.push(`αはほぼゼロで${label}並みのリターン`);
  else if (stats.alpha > -0.1) parts.push(`年率α=${alphaPct}%で${label}を下回る`);
  else parts.push(`年率α=${alphaPct}%と大幅に劣後`);

  // Information Ratio
  if (stats.informationRatio > 0.5) parts.push(`IR=${stats.informationRatio.toFixed(2)}でリスク調整後も良好`);
  else if (stats.informationRatio < -0.5) parts.push(`IR=${stats.informationRatio.toFixed(2)}でリスク対比のリターンが低い`);

  return parts.join("。") + "。";
}
