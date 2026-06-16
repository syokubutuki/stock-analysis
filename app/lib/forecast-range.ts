// 短期(1〜3日)予測レンジ: GJR-GARCH予測σ × 多日累積分散 × Cornish-Fisher歪み補正
//
// 超短期ではドリフト(方向)はほぼ予測不能で、勝負は「値動きの幅と分布の形」。
// このモジュールは現在価格を起点に、h日後リターンの条件付き分布(平均・分散・歪度・尖度)を
// 推定し、その分位点から予測価格レンジ(ファンチャート)を構成する。

import { fitGJR } from "./gjr-egarch";

export interface ForecastBand {
  level: number;       // 信頼区間(0.5/0.8/0.95)
  lowReturn: number;   // 下側の対数リターン分位点
  highReturn: number;  // 上側の対数リターン分位点
  lowPrice: number;    // 下側予測価格
  highPrice: number;   // 上側予測価格
  // 正規分布(歪み補正なし)での比較用価格
  lowPriceNormal: number;
  highPriceNormal: number;
}

export interface ThresholdProb {
  label: string;       // 例: "+3%以上"
  prob: number;        // CF補正後の確率(0-1)
}

export interface HorizonForecast {
  horizon: number;       // 日数
  sigma: number;         // h日累積対数リターンの標準偏差
  drift: number;         // h日期待対数リターン
  skew: number;          // h日スケールの歪度
  excessKurt: number;    // h日スケールの超過尖度
  medianPrice: number;   // 中央(ドリフト)パス価格
  expectedMove: number;  // 期待絶対変動幅(価格、片側1σ相当のレンジ幅%)
  bands: ForecastBand[];
  probs: ThresholdProb[];
  upProb: number;        // h日後にプラスとなる確率(CF補正)
}

export interface ForecastRangeResult {
  ok: boolean;
  currentPrice: number;
  dailyVolGarch: number;   // GARCH 1日先予測σ(対数リターン)
  dailyVolHist: number;    // 標本標準偏差(対数リターン)
  skewness: number;        // 日次リターンの歪度
  excessKurtosis: number;  // 日次リターンの超過尖度
  persistence: number;     // GARCH持続性 α+β+γ/2
  meanDaily: number;       // 日次平均対数リターン
  horizons: HorizonForecast[];
  interpretation: string;
}

// --- 数値ユーティリティ ---
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Cornish-Fisher 分位点変換: 標準正規分位 z を歪度S・超過尖度Kで補正
function cornishFisherQuantile(z: number, S: number, K: number): number {
  return (
    z +
    ((z * z - 1) * S) / 6 +
    ((z * z * z - 3 * z) * K) / 24 -
    ((2 * z * z * z - 5 * z) * S * S) / 36
  );
}

// 両側信頼区間に対応する標準正規分位 (上側)
const LEVEL_Z: { level: number; z: number }[] = [
  { level: 0.5, z: 0.6744898 },
  { level: 0.8, z: 1.2815516 },
  { level: 0.95, z: 1.959964 },
];

// 目標リターン x 以下となる確率を CF補正分布で求める。
// CF分位関数 r(z)=μ+σ·q_CF(z,S,K) は中心域で単調なので、二分法で z を逆算し Φ(z) を返す。
function cfProbBelow(x: number, mu: number, sigma: number, S: number, K: number): number {
  if (sigma <= 0) return x >= mu ? 1 : 0;
  let lo = -6, hi = 6;
  const target = (x - mu) / sigma;
  // q_CF が単調増加である中心域に限定
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const q = cornishFisherQuantile(mid, S, K);
    if (q < target) lo = mid;
    else hi = mid;
  }
  return normalCdf((lo + hi) / 2);
}

// GJR-GARCH の h日先までの条件付き分散経路を予測し、累積分散を返す。
// σ²_{T+1} = ω + (α + γ·I_{ε_T<0})ε²_T + β·σ²_T   (実測の最終残差を使用)
// σ²_{T+k} = ω + (α + β + γ/2)·σ²_{T+k-1}          (k≥2: I の期待値0.5)
function garchVarPath(
  omega: number,
  alpha: number,
  beta: number,
  gamma: number,
  lastVar: number,
  lastReturn: number,
  maxH: number
): { stepVar: number[]; cumVar: number[] } {
  const persistence = alpha + beta + gamma / 2;
  const stepVar: number[] = [];
  const indicator = lastReturn < 0 ? 1 : 0;
  let v = omega + (alpha + gamma * indicator) * lastReturn * lastReturn + beta * lastVar;
  for (let k = 1; k <= maxH; k++) {
    stepVar.push(v);
    v = omega + persistence * v;
  }
  const cumVar: number[] = [];
  let acc = 0;
  for (let k = 0; k < maxH; k++) {
    acc += stepVar[k];
    cumVar.push(acc);
  }
  return { stepVar, cumVar };
}

export function computeForecastRange(
  prices: { close: number }[],
  horizons: number[] = [1, 2, 3]
): ForecastRangeResult {
  const empty: ForecastRangeResult = {
    ok: false,
    currentPrice: 0,
    dailyVolGarch: 0,
    dailyVolHist: 0,
    skewness: 0,
    excessKurtosis: 0,
    persistence: 0,
    meanDaily: 0,
    horizons: [],
    interpretation: "データ不足(60本以上の価格が必要)",
  };

  const closes = prices.map((p) => p.close).filter((c) => c > 0);
  if (closes.length < 60) return empty;

  // 対数リターン
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const n = returns.length;
  const currentPrice = closes[closes.length - 1];

  // モーメント
  let mu = 0;
  for (const r of returns) mu += r;
  mu /= n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const r of returns) {
    const d = r - mu;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n; m3 /= n; m4 /= n;
  const sd = Math.sqrt(m2);
  const S = sd > 0 ? m3 / sd ** 3 : 0;
  const K = sd > 0 ? m4 / sd ** 4 - 3 : 0;

  // GJR-GARCHで1日先以降の分散を予測
  const gjr = fitGJR(returns);
  const lastVar = gjr.conditionalVol.length > 0
    ? gjr.conditionalVol[gjr.conditionalVol.length - 1] ** 2
    : m2;
  const lastReturn = returns[n - 1];
  const maxH = Math.max(...horizons);
  const { cumVar } = garchVarPath(
    gjr.omega, gjr.alpha, gjr.beta, gjr.gamma, lastVar, lastReturn, maxH
  );
  const dailyVolGarch = Math.sqrt(cumVar[0]);
  const persistence = gjr.alpha + gjr.beta + gjr.gamma / 2;

  const horizonForecasts: HorizonForecast[] = horizons.map((h) => {
    const varH = cumVar[h - 1];
    const sigmaH = Math.sqrt(varH);
    const driftH = mu * h;
    // iid近似での高次モーメントのスケーリング
    const skewH = S / Math.sqrt(h);
    const kurtH = K / h;
    const medianPrice = currentPrice * Math.exp(driftH);

    const bands: ForecastBand[] = LEVEL_Z.map(({ level, z }) => {
      const zLowCF = cornishFisherQuantile(-z, skewH, kurtH);
      const zHighCF = cornishFisherQuantile(z, skewH, kurtH);
      const lowReturn = driftH + zLowCF * sigmaH;
      const highReturn = driftH + zHighCF * sigmaH;
      return {
        level,
        lowReturn,
        highReturn,
        lowPrice: currentPrice * Math.exp(lowReturn),
        highPrice: currentPrice * Math.exp(highReturn),
        lowPriceNormal: currentPrice * Math.exp(driftH - z * sigmaH),
        highPriceNormal: currentPrice * Math.exp(driftH + z * sigmaH),
      };
    });

    // 閾値到達確率(CF補正)
    const thresholds = [0.05, 0.03, -0.03, -0.05];
    const probs: ThresholdProb[] = thresholds.map((t) => {
      const below = cfProbBelow(t, driftH, sigmaH, skewH, kurtH);
      if (t > 0) return { label: `+${(t * 100).toFixed(0)}%以上`, prob: 1 - below };
      return { label: `${(t * 100).toFixed(0)}%以下`, prob: below };
    });
    const upProb = 1 - cfProbBelow(0, driftH, sigmaH, skewH, kurtH);
    // 期待絶対変動幅(半正規近似 √(2/π)·σ を%表記)
    const expectedMove = sigmaH * Math.sqrt(2 / Math.PI) * 100;

    return {
      horizon: h,
      sigma: sigmaH,
      drift: driftH,
      skew: skewH,
      excessKurt: kurtH,
      medianPrice,
      expectedMove,
      bands,
      probs,
      upProb,
    };
  });

  // 解釈文
  const h3 = horizonForecasts[horizonForecasts.length - 1];
  const band95_3 = h3.bands.find((b) => b.level === 0.95);
  const volTrend = dailyVolGarch > sd
    ? "上昇局面(直近のショックでボラ拡大)"
    : "低下局面(平穏化に向かう)";
  const skewNote = Math.abs(S) > 0.3
    ? `歪度${S.toFixed(2)}が${S < 0 ? "負(急落側に裾が厚い)" : "正(急騰側に裾が厚い)"}で、レンジは${S < 0 ? "下方向" : "上方向"}に非対称。`
    : "歪みは小さく分布はほぼ対称。";
  const kurtNote = K > 1
    ? `超過尖度${K.toFixed(1)}が大きくファットテール。正規前提よりレンジ端の到達確率が高い。`
    : "";
  const interpretation = band95_3
    ? `GARCH予測の1日σ=${(dailyVolGarch * 100).toFixed(2)}%(標本σ=${(sd * 100).toFixed(2)}%、${volTrend})。` +
      `3日後の95%予測レンジは ${band95_3.lowPrice.toFixed(2)} 〜 ${band95_3.highPrice.toFixed(2)}` +
      `(${(band95_3.lowReturn * 100).toFixed(1)}% 〜 +${(band95_3.highReturn * 100).toFixed(1)}%)。` +
      skewNote + kurtNote
    : "計算できませんでした。";

  return {
    ok: true,
    currentPrice,
    dailyVolGarch,
    dailyVolHist: sd,
    skewness: S,
    excessKurtosis: K,
    persistence,
    meanDaily: mu,
    horizons: horizonForecasts,
    interpretation,
  };
}
