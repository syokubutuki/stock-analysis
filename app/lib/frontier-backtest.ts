// ポートフォリオ配分則のアウトオブサンプル(ウォークフォワード)検証
// ----------------------------------------------------------------------------
// 各配分則(接点/最小分散/リスクパリティ/逆ボラ/等加重)を、過去 lookback 本だけで
// 推定 → 直後の rebalance 本を「未知の未来」として保有、を全期間で繰り返す。
// これにより「在サンプルの見かけ」ではなく実際に取れたであろうリターン(実現シャープ)
// を比較できる。1/N が理論最適を上回りやすい、という現象もここで検証できる。
//
// 手順: t=lookback から、rebalance 本ごとに直近 lookback 本で estimateWeights を再計算
// (前回解で暖機)。各日 t の実現リターンは Σ wᵢ(exp(rᵢ)−1)。窓の推定に日 t は含めない
// ので厳密にアウトオブサンプル。
// ============================================================================

import { AlignedReturns } from "./portfolio-risk";
import { estimateWeights, StrategyWeights } from "./efficient-frontier";

const TRADING_DAYS = 252;

export interface OosParams {
  lookback: number; // 推定に使う過去本数
  rebalance: number; // 再最適化間隔(本)
  rf: number; // 年率無リスク金利
  covShrinkage?: boolean;
  muShrinkage?: boolean;
  maxWeight?: number;
}

export interface OosStrategy {
  key: string;
  label: string;
  equity: { time: string; value: number }[]; // 累積(初期1)
  cagr: number; // 年率(幾何)
  annVol: number; // 年率ボラ
  sharpe: number; // 実現シャープ
  maxDrawdown: number; // 最大ドローダウン(負値)
  turnover: number; // 平均売買回転(片道, 1回の再配分あたり)
}

export interface OosResult {
  dates: string[];
  strategies: OosStrategy[];
  nRebalances: number;
  lookback: number;
  rebalance: number;
  nAssets: number;
}

const STRATS: { key: keyof StrategyWeights; label: string }[] = [
  { key: "tangency", label: "接点(最大シャープ)" },
  { key: "minVar", label: "最小分散" },
  { key: "riskParity", label: "リスクパリティ" },
  { key: "invVol", label: "逆ボラ加重" },
  { key: "equal", label: "等加重 1/N" },
];

export function runOosBacktest(aligned: AlignedReturns, params: OosParams): OosResult | null {
  const { returns, dates } = aligned;
  const k = returns.length;
  if (k < 2) return null;
  const T = returns[0]?.length ?? 0;
  const { lookback, rebalance, rf } = params;
  if (T < lookback + rebalance + 5) return null;

  const equalW = new Array(k).fill(1 / k);
  const seriesRet: Record<string, number[]> = {};
  const curWeights: Record<string, number[]> = {};
  const turnoverSum: Record<string, number> = {};
  for (const s of STRATS) {
    seriesRet[s.key] = [];
    curWeights[s.key] = equalW.slice();
    turnoverSum[s.key] = 0;
  }
  let warm: { tangency?: number[]; minVar?: number[] } = {};
  let rebalCount = 0;
  const oosDates: string[] = [];

  for (let t = lookback; t < T; t++) {
    if ((t - lookback) % rebalance === 0) {
      const win = returns.map((r) => r.slice(t - lookback, t));
      const w = estimateWeights(win, rf, params, warm);
      if (w) {
        warm = { tangency: w.tangency ?? undefined, minVar: w.minVar ?? undefined };
        for (const s of STRATS) {
          const nw = (w[s.key] as number[] | null) ?? curWeights[s.key];
          const old = curWeights[s.key];
          let to = 0;
          for (let i = 0; i < k; i++) to += Math.abs(nw[i] - old[i]);
          turnoverSum[s.key] += to / 2; // 片道
          curWeights[s.key] = nw;
        }
        rebalCount++;
      }
    }
    const simple = returns.map((r) => Math.expm1(r[t]));
    for (const s of STRATS) {
      const w = curWeights[s.key];
      let pr = 0;
      for (let i = 0; i < k; i++) pr += w[i] * simple[i];
      seriesRet[s.key].push(pr);
    }
    oosDates.push(dates[t]);
  }

  const n = oosDates.length;
  if (n < 2) return null;

  const strategies: OosStrategy[] = STRATS.map((s) => {
    const rets = seriesRet[s.key];
    const equity: { time: string; value: number }[] = [];
    let e = 1;
    let peak = 1;
    let mdd = 0;
    for (let i = 0; i < rets.length; i++) {
      e *= 1 + rets[i];
      equity.push({ time: oosDates[i], value: e });
      peak = Math.max(peak, e);
      mdd = Math.min(mdd, e / peak - 1);
    }
    const m = rets.reduce((a, b) => a + b, 0) / n;
    let v = 0;
    for (const r of rets) v += (r - m) * (r - m);
    v /= n > 1 ? n - 1 : 1;
    const sd = Math.sqrt(v);
    const annVol = sd * Math.sqrt(TRADING_DAYS);
    const annRet = m * TRADING_DAYS;
    const cagr = e > 0 ? Math.pow(e, TRADING_DAYS / n) - 1 : -1;
    const sharpe = annVol > 0 ? (annRet - rf) / annVol : 0;
    const turnover = rebalCount > 1 ? turnoverSum[s.key] / (rebalCount - 1) : 0;
    return { key: s.key, label: s.label, equity, cagr, annVol, sharpe, maxDrawdown: mdd, turnover };
  });

  return { dates: oosDates, strategies, nRebalances: rebalCount, lookback, rebalance, nAssets: k };
}
