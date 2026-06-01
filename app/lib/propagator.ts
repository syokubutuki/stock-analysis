/**
 * Price Propagator: 遷移確率密度の推定
 * 現在価格からN日後にどの価格帯に到達するかの確率分布を計算
 */
import { PricePoint } from "./types";

export interface PropagatorResult {
  /** 予測対象の日数リスト */
  horizons: number[];
  /** 各horizonでの価格帯ビン（現在価格からの変化率%） */
  bins: number[];
  /** heatmap[horizon_idx][bin_idx] = 遷移確率 (0-1) */
  heatmap: number[][];
  /** 各horizonでのパーセンタイル */
  percentiles: {
    p5: number[];
    p10: number[];
    p25: number[];
    p50: number[];
    p75: number[];
    p90: number[];
    p95: number[];
  };
  /** 最終価格 */
  lastPrice: number;
}

export function computePropagator(
  prices: PricePoint[],
  horizons: number[] = [5, 10, 20, 40, 60],
  nBins: number = 40
): PropagatorResult {
  const empty: PropagatorResult = {
    horizons,
    bins: [],
    heatmap: [],
    percentiles: { p5: [], p10: [], p25: [], p50: [], p75: [], p90: [], p95: [] },
    lastPrice: 0,
  };
  if (prices.length < 30) return empty;

  const closes = prices.map((p) => p.close);
  const lastPrice = closes[closes.length - 1];
  const maxHorizon = Math.max(...horizons);

  // 各horizonでの変化率を全ヒストリカルデータから収集
  const changesByHorizon: number[][] = horizons.map(() => []);

  for (let i = 0; i < closes.length - maxHorizon; i++) {
    const base = closes[i];
    for (let h = 0; h < horizons.length; h++) {
      const future = closes[i + horizons[h]];
      const change = ((future - base) / base) * 100; // %
      changesByHorizon[h].push(change);
    }
  }

  // ビン範囲を決定（全horizonのデータから）
  const allChanges = changesByHorizon.flat();
  if (allChanges.length === 0) return empty;
  allChanges.sort((a, b) => a - b);
  const lo = allChanges[Math.floor(allChanges.length * 0.01)];
  const hi = allChanges[Math.floor(allChanges.length * 0.99)];
  const range = hi - lo;
  const binMin = lo - range * 0.1;
  const binMax = hi + range * 0.1;
  const binWidth = (binMax - binMin) / nBins;
  const bins: number[] = [];
  for (let i = 0; i < nBins; i++) {
    bins.push(binMin + (i + 0.5) * binWidth);
  }

  // ヒートマップ作成
  const heatmap: number[][] = [];
  const percentiles = {
    p5: [] as number[],
    p10: [] as number[],
    p25: [] as number[],
    p50: [] as number[],
    p75: [] as number[],
    p90: [] as number[],
    p95: [] as number[],
  };

  for (let h = 0; h < horizons.length; h++) {
    const changes = changesByHorizon[h];
    const sorted = [...changes].sort((a, b) => a - b);
    const n = sorted.length;

    // ヒストグラム
    const hist = new Array(nBins).fill(0);
    for (const c of changes) {
      const idx = Math.floor((c - binMin) / binWidth);
      if (idx >= 0 && idx < nBins) hist[idx]++;
    }
    // 正規化
    const total = changes.length;
    heatmap.push(hist.map((v) => v / total));

    // パーセンタイル
    const pct = (p: number) => {
      const i = (p / 100) * (n - 1);
      const lo = Math.floor(i);
      const hi = Math.ceil(i);
      return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
    };
    percentiles.p5.push(pct(5));
    percentiles.p10.push(pct(10));
    percentiles.p25.push(pct(25));
    percentiles.p50.push(pct(50));
    percentiles.p75.push(pct(75));
    percentiles.p90.push(pct(90));
    percentiles.p95.push(pct(95));
  }

  return { horizons, bins, heatmap, percentiles, lastPrice };
}
