// 横断分析ライブラリ: 構造スコアカード, 出来高プロファイル, 最適保有期間, ボラ期間構造, レジーム別テクニカル

import { PricePoint } from "./types";

// ========== ヘルパー ==========

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}
function stddev(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length);
}

// ========== 1. 構造スコアカード ==========

export interface StructureScore {
  category: string;
  label: string;
  value: string;
  score: number;   // -1 ~ 1 の正規化スコア
  color: "red" | "orange" | "green" | "blue" | "gray";
  detail: string;
}

export function computeStructureScorecard(prices: PricePoint[]): StructureScore[] {
  const closes = prices.map(p => p.close);
  const n = closes.length;
  if (n < 30) return [];

  const lr: number[] = [];
  for (let i = 1; i < n; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      lr.push(Math.log(closes[i] / closes[i - 1]));
    }
  }

  const m = mean(lr);
  const s = stddev(lr);
  const scores: StructureScore[] = [];

  // 1. トレンド強度
  const annualReturn = m * 252;
  const trendScore = Math.max(-1, Math.min(1, annualReturn / 0.3));
  scores.push({
    category: "トレンド",
    label: "年率リターン",
    value: (annualReturn * 100).toFixed(1) + "%",
    score: trendScore,
    color: annualReturn > 0.05 ? "green" : annualReturn < -0.05 ? "red" : "gray",
    detail: annualReturn > 0.1 ? "強い上昇トレンド" : annualReturn > 0 ? "緩やかな上昇" : annualReturn > -0.1 ? "緩やかな下落" : "強い下落トレンド",
  });

  // 2. ボラティリティ水準
  const annualVol = s * Math.sqrt(252);
  scores.push({
    category: "ボラティリティ",
    label: "年率ボラティリティ",
    value: (annualVol * 100).toFixed(1) + "%",
    score: Math.min(1, annualVol / 0.5),
    color: annualVol > 0.4 ? "red" : annualVol > 0.25 ? "orange" : "green",
    detail: annualVol > 0.4 ? "非常に高い変動性" : annualVol > 0.25 ? "中程度の変動性" : "低い変動性",
  });

  // 3. 正規性 (JB検定)
  const m3 = lr.reduce((a, v) => a + ((v - m) / s) ** 3, 0) / lr.length;
  const m4 = lr.reduce((a, v) => a + ((v - m) / s) ** 4, 0) / lr.length - 3;
  const jb = (lr.length / 6) * (m3 ** 2 + m4 ** 2 / 4);
  const jbReject = jb > 5.99; // χ²(2) 5%臨界値
  scores.push({
    category: "分布",
    label: "正規性 (JB)",
    value: `JB=${jb.toFixed(1)}`,
    score: jbReject ? 1 : 0,
    color: jbReject ? "red" : "green",
    detail: jbReject ? `棄却 (歪度=${m3.toFixed(2)}, 尖度=${m4.toFixed(2)})` : "正規分布に近い",
  });

  // 4. 効率性 (ACF(1))
  const v = lr.reduce((a, x) => a + (x - m) ** 2, 0) / lr.length;
  let acf1 = 0;
  if (v > 0) {
    for (let i = 0; i < lr.length - 1; i++) {
      acf1 += (lr[i] - m) * (lr[i + 1] - m);
    }
    acf1 /= lr.length * v;
  }
  const acf1Sig = Math.abs(acf1) > 1.96 / Math.sqrt(lr.length);
  scores.push({
    category: "効率性",
    label: "自己相関 ACF(1)",
    value: acf1.toFixed(4),
    score: acf1,
    color: acf1Sig ? (acf1 > 0 ? "blue" : "orange") : "green",
    detail: acf1Sig
      ? (acf1 > 0 ? "正の自己相関 → モメンタム傾向" : "負の自己相関 → リバージョン傾向")
      : "有意な自己相関なし → 効率的市場",
  });

  // 5. ボラクラスタリング (ACF of r²)
  const lrSq = lr.map(r => r * r);
  const mSq = mean(lrSq);
  const vSq = lrSq.reduce((a, x) => a + (x - mSq) ** 2, 0) / lrSq.length;
  let acfSq1 = 0;
  if (vSq > 0) {
    for (let i = 0; i < lrSq.length - 1; i++) {
      acfSq1 += (lrSq[i] - mSq) * (lrSq[i + 1] - mSq);
    }
    acfSq1 /= lrSq.length * vSq;
  }
  scores.push({
    category: "ボラクラスタ",
    label: "ACF(r², lag1)",
    value: acfSq1.toFixed(4),
    score: acfSq1,
    color: acfSq1 > 0.1 ? "orange" : "green",
    detail: acfSq1 > 0.2 ? "強いボラティリティクラスタリング" : acfSq1 > 0.1 ? "中程度のクラスタリング" : "弱いクラスタリング",
  });

  // 6. Hurst指数の簡易推定 (R/S法)
  const hurst = estimateHurst(lr);
  scores.push({
    category: "記憶性",
    label: "Hurst指数 (簡易)",
    value: hurst.toFixed(3),
    score: (hurst - 0.5) * 2,
    color: hurst > 0.6 ? "blue" : hurst < 0.4 ? "orange" : "green",
    detail: hurst > 0.6 ? "長期記憶 → トレンド持続" : hurst < 0.4 ? "反持続性 → ミーンリバージョン" : "ランダムウォークに近い (H≈0.5)",
  });

  // 7. 最大ドローダウン
  let peak = -Infinity, maxDD = 0;
  let cumRet = 0;
  for (const r of lr) {
    cumRet += r;
    if (cumRet > peak) peak = cumRet;
    const dd = peak - cumRet;
    if (dd > maxDD) maxDD = dd;
  }
  scores.push({
    category: "リスク",
    label: "最大ドローダウン",
    value: (maxDD * 100).toFixed(1) + "%",
    score: -Math.min(1, maxDD / 0.5),
    color: maxDD > 0.3 ? "red" : maxDD > 0.15 ? "orange" : "green",
    detail: maxDD > 0.3 ? "深刻なドローダウン歴" : maxDD > 0.15 ? "中程度のドローダウン" : "ドローダウンは限定的",
  });

  // 8. シャープレシオ
  const sharpe = s > 0 ? (m * 252) / (s * Math.sqrt(252)) : 0;
  scores.push({
    category: "リスク調整",
    label: "シャープレシオ",
    value: sharpe.toFixed(3),
    score: Math.max(-1, Math.min(1, sharpe / 2)),
    color: sharpe > 1 ? "green" : sharpe > 0 ? "blue" : "red",
    detail: sharpe > 1 ? "優秀なリスク調整リターン" : sharpe > 0.5 ? "良好" : sharpe > 0 ? "正だが低い" : "負のリスク調整リターン",
  });

  return scores;
}

function estimateHurst(values: number[]): number {
  const n = values.length;
  if (n < 20) return 0.5;
  const sizes = [10, 20, 40, 80, 160].filter(s => s <= n / 2);
  if (sizes.length < 2) return 0.5;

  const logN: number[] = [], logRS: number[] = [];
  for (const size of sizes) {
    const nBlocks = Math.floor(n / size);
    let rsSum = 0;
    for (let b = 0; b < nBlocks; b++) {
      const block = values.slice(b * size, (b + 1) * size);
      const bm = mean(block);
      const bs = stddev(block);
      if (bs <= 0) continue;
      let cumDev = 0, maxDev = -Infinity, minDev = Infinity;
      for (const v of block) {
        cumDev += v - bm;
        maxDev = Math.max(maxDev, cumDev);
        minDev = Math.min(minDev, cumDev);
      }
      rsSum += (maxDev - minDev) / bs;
    }
    if (nBlocks > 0) {
      logN.push(Math.log(size));
      logRS.push(Math.log(rsSum / nBlocks));
    }
  }

  if (logN.length < 2) return 0.5;
  // Linear regression
  const mX = mean(logN), mY = mean(logRS);
  let num = 0, den = 0;
  for (let i = 0; i < logN.length; i++) {
    num += (logN[i] - mX) * (logRS[i] - mY);
    den += (logN[i] - mX) ** 2;
  }
  return den > 0 ? Math.max(0, Math.min(1, num / den)) : 0.5;
}

// ========== 2. 出来高プロファイル ==========

export interface VolumeProfileBin {
  priceCenter: number;
  volume: number;
  buyVolume: number;   // close > open の日の出来高
  sellVolume: number;  // close < open の日の出来高
  density: number;     // 正規化した比率
}

export interface VolumeProfileResult {
  bins: VolumeProfileBin[];
  poc: number;         // Point of Control (最大出来高価格)
  vah: number;         // Value Area High (70%出来高の上限)
  val: number;         // Value Area Low (70%出来高の下限)
  totalVolume: number;
}

export function computeVolumeProfile(prices: PricePoint[], nBins: number = 40): VolumeProfileResult {
  if (prices.length < 5) {
    return { bins: [], poc: 0, vah: 0, val: 0, totalVolume: 0 };
  }

  const allPrices = prices.flatMap(p => [p.high, p.low]);
  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const range = maxPrice - minPrice || 1;
  const binWidth = range / nBins;

  const bins: VolumeProfileBin[] = Array.from({ length: nBins }, (_, i) => ({
    priceCenter: minPrice + (i + 0.5) * binWidth,
    volume: 0,
    buyVolume: 0,
    sellVolume: 0,
    density: 0,
  }));

  let totalVolume = 0;
  for (const p of prices) {
    // 各日の出来高をHigh-Lowの範囲に均等に分配
    const lowIdx = Math.max(0, Math.min(nBins - 1, Math.floor((p.low - minPrice) / binWidth)));
    const highIdx = Math.max(0, Math.min(nBins - 1, Math.floor((p.high - minPrice) / binWidth)));
    const span = highIdx - lowIdx + 1;
    const volPerBin = p.volume / span;

    for (let i = lowIdx; i <= highIdx; i++) {
      bins[i].volume += volPerBin;
      if (p.close >= p.open) {
        bins[i].buyVolume += volPerBin;
      } else {
        bins[i].sellVolume += volPerBin;
      }
    }
    totalVolume += p.volume;
  }

  // 密度の正規化
  const maxVol = Math.max(...bins.map(b => b.volume), 1);
  for (const b of bins) b.density = b.volume / maxVol;

  // POC
  const pocBin = bins.reduce((best, b) => b.volume > best.volume ? b : best, bins[0]);
  const poc = pocBin.priceCenter;

  // Value Area (70%の出来高が含まれる価格範囲)
  const targetVol = totalVolume * 0.7;
  const pocIdx = bins.indexOf(pocBin);
  let vaVol = pocBin.volume;
  let vaLow = pocIdx, vaHigh = pocIdx;

  while (vaVol < targetVol && (vaLow > 0 || vaHigh < nBins - 1)) {
    const addLow = vaLow > 0 ? bins[vaLow - 1].volume : 0;
    const addHigh = vaHigh < nBins - 1 ? bins[vaHigh + 1].volume : 0;
    if (addLow >= addHigh && vaLow > 0) {
      vaLow--;
      vaVol += addLow;
    } else if (vaHigh < nBins - 1) {
      vaHigh++;
      vaVol += addHigh;
    } else {
      vaLow--;
      vaVol += addLow;
    }
  }

  return {
    bins,
    poc,
    vah: bins[vaHigh].priceCenter + binWidth / 2,
    val: bins[vaLow].priceCenter - binWidth / 2,
    totalVolume,
  };
}

// ========== 3. 最適保有期間分析 ==========

export interface HoldingPeriodStats {
  days: number;
  meanReturn: number;
  stdReturn: number;
  sharpe: number;
  winRate: number;
  maxReturn: number;
  minReturn: number;
  medianReturn: number;
  n: number;
}

export function computeHoldingPeriods(prices: PricePoint[], maxDays: number = 60): HoldingPeriodStats[] {
  const closes = prices.map(p => p.close);
  const n = closes.length;
  const periods = [1, 2, 3, 5, 7, 10, 15, 20, 30, 40, 60].filter(d => d <= maxDays && d < n);

  return periods.map(days => {
    const returns: number[] = [];
    for (let i = 0; i < n - days; i++) {
      if (closes[i] > 0 && closes[i + days] > 0) {
        returns.push(Math.log(closes[i + days] / closes[i]));
      }
    }
    if (returns.length < 3) {
      return { days, meanReturn: 0, stdReturn: 0, sharpe: 0, winRate: 0, maxReturn: 0, minReturn: 0, medianReturn: 0, n: 0 };
    }

    const sorted = [...returns].sort((a, b) => a - b);
    const m = mean(returns);
    const s = stddev(returns);
    const annFactor = 252 / days;

    return {
      days,
      meanReturn: m,
      stdReturn: s,
      sharpe: s > 0 ? (m * annFactor) / (s * Math.sqrt(annFactor)) : 0,
      winRate: returns.filter(r => r > 0).length / returns.length,
      maxReturn: sorted[sorted.length - 1],
      minReturn: sorted[0],
      medianReturn: sorted[Math.floor(sorted.length / 2)],
      n: returns.length,
    };
  });
}

// ========== 4. ボラティリティ期間構造 ==========

export interface VolTermPoint {
  time: string;
  vol5: number;
  vol20: number;
  vol60: number;
  vol120: number;
  ratio_5_20: number;    // 短期/中期比率
  ratio_20_60: number;   // 中期/長期比率
}

export function computeVolTermStructure(prices: PricePoint[]): VolTermPoint[] {
  const closes = prices.map(p => p.close);
  const n = closes.length;
  if (n < 121) return [];

  const lr: number[] = [];
  for (let i = 1; i < n; i++) {
    lr.push(closes[i - 1] > 0 && closes[i] > 0 ? Math.log(closes[i] / closes[i - 1]) : 0);
  }

  const result: VolTermPoint[] = [];
  for (let i = 119; i < lr.length; i++) {
    const vol = (window: number) => {
      const slice = lr.slice(i - window + 1, i + 1);
      return stddev(slice) * Math.sqrt(252);
    };

    const v5 = vol(5);
    const v20 = vol(20);
    const v60 = vol(60);
    const v120 = vol(120);

    result.push({
      time: prices[i + 1].time,
      vol5: v5,
      vol20: v20,
      vol60: v60,
      vol120: v120,
      ratio_5_20: v20 > 0 ? v5 / v20 : 1,
      ratio_20_60: v60 > 0 ? v20 / v60 : 1,
    });
  }
  return result;
}

// ========== 5. レジーム別テクニカル有効性 ==========

export interface RegimeTechnicalResult {
  regime: string;
  regimeIdx: number;
  n: number;
  // RSIシグナル
  rsiBuySignals: number;
  rsiBuyWinRate: number;
  rsiBuyAvgReturn: number;
  rsiSellSignals: number;
  rsiSellWinRate: number;
  rsiSellAvgReturn: number;
  // MACDシグナル
  macdBuySignals: number;
  macdBuyWinRate: number;
  macdBuyAvgReturn: number;
  macdSellSignals: number;
  macdSellWinRate: number;
  macdSellAvgReturn: number;
  // 全体統計
  avgReturn: number;
  avgVol: number;
}

export function computeRegimeTechnical(prices: PricePoint[]): RegimeTechnicalResult[] {
  const n = prices.length;
  if (n < 60) return [];

  const closes = prices.map(p => p.close);

  // --- RSI計算 ---
  const rsi = computeRSIValues(closes, 14);

  // --- MACD計算 ---
  const macd = computeMACDValues(closes);

  // --- 簡易レジーム分類 (ボラティリティベース, 3状態) ---
  const lr: number[] = [];
  for (let i = 1; i < n; i++) {
    lr.push(closes[i - 1] > 0 ? Math.log(closes[i] / closes[i - 1]) : 0);
  }

  const volWindow = 20;
  const rollingVol: number[] = [];
  for (let i = 0; i < lr.length; i++) {
    if (i < volWindow - 1) { rollingVol.push(0); continue; }
    const slice = lr.slice(i - volWindow + 1, i + 1);
    rollingVol.push(stddev(slice));
  }

  // ボラティリティの三分位でレジーム分類
  const validVols = rollingVol.filter(v => v > 0);
  const sortedVols = [...validVols].sort((a, b) => a - b);
  const q33 = sortedVols[Math.floor(sortedVols.length * 0.33)] || 0;
  const q66 = sortedVols[Math.floor(sortedVols.length * 0.66)] || Infinity;

  const regimeLabels = ["低ボラティリティ", "中ボラティリティ", "高ボラティリティ"];
  const regimes: number[] = rollingVol.map(v =>
    v <= q33 ? 0 : v <= q66 ? 1 : 2
  );

  // --- 各レジームでのシグナル評価 ---
  const results: RegimeTechnicalResult[] = regimeLabels.map((label, ri) => ({
    regime: label,
    regimeIdx: ri,
    n: 0,
    rsiBuySignals: 0, rsiBuyWinRate: 0, rsiBuyAvgReturn: 0,
    rsiSellSignals: 0, rsiSellWinRate: 0, rsiSellAvgReturn: 0,
    macdBuySignals: 0, macdBuyWinRate: 0, macdBuyAvgReturn: 0,
    macdSellSignals: 0, macdSellWinRate: 0, macdSellAvgReturn: 0,
    avgReturn: 0, avgVol: 0,
  }));

  // 各レジームのリターン/シグナル集計
  const regimeReturns: number[][] = [[], [], []];
  const regimeVols: number[][] = [[], [], []];
  const rsiBuyReturns: number[][] = [[], [], []];
  const rsiSellReturns: number[][] = [[], [], []];
  const macdBuyReturns: number[][] = [[], [], []];
  const macdSellReturns: number[][] = [[], [], []];

  for (let i = volWindow; i < lr.length - 5; i++) {
    const reg = regimes[i];
    regimeReturns[reg].push(lr[i]);
    regimeVols[reg].push(rollingVol[i]);

    // 翌5日リターン (シグナル後のパフォーマンス)
    let fwdRet = 0;
    for (let j = 1; j <= 5 && i + j < lr.length; j++) {
      fwdRet += lr[i + j];
    }

    // RSIシグナル (prices[i+1]に対応するRSI)
    const rsiIdx = i; // rsi配列はlrと同じインデックス
    if (rsiIdx < rsi.length) {
      if (rsi[rsiIdx] < 30) rsiBuyReturns[reg].push(fwdRet);
      if (rsi[rsiIdx] > 70) rsiSellReturns[reg].push(fwdRet);
    }

    // MACDシグナル (ゴールデンクロス/デッドクロス)
    if (i > 0 && i < macd.histogram.length) {
      if (macd.histogram[i] > 0 && macd.histogram[i - 1] <= 0) macdBuyReturns[reg].push(fwdRet);
      if (macd.histogram[i] < 0 && macd.histogram[i - 1] >= 0) macdSellReturns[reg].push(fwdRet);
    }
  }

  for (let ri = 0; ri < 3; ri++) {
    const r = results[ri];
    r.n = regimeReturns[ri].length;
    r.avgReturn = mean(regimeReturns[ri]) * 252;
    r.avgVol = mean(regimeVols[ri]) * Math.sqrt(252);

    r.rsiBuySignals = rsiBuyReturns[ri].length;
    r.rsiBuyWinRate = r.rsiBuySignals > 0 ? rsiBuyReturns[ri].filter(r => r > 0).length / r.rsiBuySignals : 0;
    r.rsiBuyAvgReturn = mean(rsiBuyReturns[ri]);

    r.rsiSellSignals = rsiSellReturns[ri].length;
    r.rsiSellWinRate = r.rsiSellSignals > 0 ? rsiSellReturns[ri].filter(r => r > 0).length / r.rsiSellSignals : 0;
    r.rsiSellAvgReturn = mean(rsiSellReturns[ri]);

    r.macdBuySignals = macdBuyReturns[ri].length;
    r.macdBuyWinRate = r.macdBuySignals > 0 ? macdBuyReturns[ri].filter(r => r > 0).length / r.macdBuySignals : 0;
    r.macdBuyAvgReturn = mean(macdBuyReturns[ri]);

    r.macdSellSignals = macdSellReturns[ri].length;
    r.macdSellWinRate = r.macdSellSignals > 0 ? macdSellReturns[ri].filter(r => r > 0).length / r.macdSellSignals : 0;
    r.macdSellAvgReturn = mean(macdSellReturns[ri]);
  }

  return results;
}

// RSI内部計算 (PricePointなしでclose配列から直接)
function computeRSIValues(closes: number[], period: number = 14): number[] {
  const result: number[] = [];
  if (closes.length < period + 1) return result;

  const gains: number[] = [], losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // paddingしてlr配列と同じ長さにする
  for (let i = 0; i < period; i++) result.push(50);

  const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
  result.push(100 - 100 / (1 + rs));

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
    result.push(100 - 100 / (1 + rs));
  }
  return result;
}

// MACD内部計算
function computeMACDValues(closes: number[]): { macd: number[]; signal: number[]; histogram: number[] } {
  const ema = (values: number[], period: number): number[] => {
    const result: number[] = [values[0]];
    const k = 2 / (period + 1);
    for (let i = 1; i < values.length; i++) {
      result.push(values[i] * k + result[i - 1] * (1 - k));
    }
    return result;
  };

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = ema(macdLine, 9);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);

  // lr配列と揃えるため先頭を1つ削る
  return {
    macd: macdLine.slice(1),
    signal: signalLine.slice(1),
    histogram: histogram.slice(1),
  };
}
