// Volatility Smile Estimation
// Backus-Foresi-Wu approximation from historical skewness/kurtosis

export interface SmilePoint {
  moneyness: number; // K/S ratio
  impliedVol: number; // annualized
}

export interface VolSmileResult {
  smile: SmilePoint[];
  atmVol: number;
  skew: number; // 25-delta risk reversal proxy
  convexity: number; // butterfly spread proxy
  sourceSkewness: number;
  sourceKurtosis: number;
  interpretation: string;
}

export function estimateVolSmile(returns: number[]): VolSmileResult {
  const n = returns.length;
  const empty: VolSmileResult = {
    smile: [],
    atmVol: 0,
    skew: 0,
    convexity: 0,
    sourceSkewness: 0,
    sourceKurtosis: 0,
    interpretation: "データが不足しています。",
  };
  if (n < 50) return empty;

  // モーメント計算
  let m1 = 0, m2 = 0, m3 = 0, m4 = 0;
  for (const r of returns) {
    m1 += r;
    m2 += r * r;
    m3 += r * r * r;
    m4 += r * r * r * r;
  }
  m1 /= n;
  m2 /= n;
  m3 /= n;
  m4 /= n;

  const variance = m2 - m1 * m1;
  if (variance < 1e-16) return empty;

  const sigma = Math.sqrt(variance);
  const skewness = (m3 - 3 * m1 * m2 + 2 * m1 ** 3) / (sigma ** 3);
  const excessKurtosis = (m4 - 4 * m1 * m3 + 6 * m1 * m1 * m2 - 3 * m1 ** 4) / (sigma ** 4) - 3;

  // ATM vol (年率化)
  const atmVol = sigma * Math.sqrt(252);

  // Backus-Foresi-Wu approximation
  // sigma_imp(m) ≈ sigma_ATM * [1 + lambda1 * d + lambda2 * (d^2 - 1)]
  // d = log(K/S) / (sigma_ATM * sqrt(T))
  // lambda1 ∝ skewness, lambda2 ∝ excess kurtosis
  // T = 1/12 (1ヶ月オプションを想定)
  const T = 1 / 12;
  const sqrtT = Math.sqrt(T);
  const lambda1 = -skewness / 6;
  const lambda2 = excessKurtosis / 24;

  // スマイル曲線生成: moneyness 0.80 ~ 1.20
  const smile: SmilePoint[] = [];
  for (let i = 0; i <= 40; i++) {
    const moneyness = 0.80 + i * 0.01;
    const d = Math.log(moneyness) / (atmVol * sqrtT);
    const iv = atmVol * (1 + lambda1 * d + lambda2 * (d * d - 1));
    // IVが負にならないようにクランプ
    smile.push({ moneyness, impliedVol: Math.max(iv, atmVol * 0.1) });
  }

  // スキュー: 25-delta相当 (OTMプット - OTMコール)
  const put25 = smile.find((s) => Math.abs(s.moneyness - 0.90) < 0.006);
  const call25 = smile.find((s) => Math.abs(s.moneyness - 1.10) < 0.006);
  const skew = put25 && call25 ? put25.impliedVol - call25.impliedVol : 0;

  // コンベクシティ: バタフライ (OTM平均 - ATM)
  const atm = smile.find((s) => Math.abs(s.moneyness - 1.0) < 0.006);
  const convexity =
    put25 && call25 && atm
      ? (put25.impliedVol + call25.impliedVol) / 2 - atm.impliedVol
      : 0;

  // 解釈
  let interpretation = `ATMボラティリティ: ${(atmVol * 100).toFixed(1)}%。`;

  if (Math.abs(skewness) < 0.3) {
    interpretation += "リターン分布の歪度が小さく、スマイルはほぼ対称です。";
  } else if (skewness < -0.3) {
    interpretation += `負の歪度(${skewness.toFixed(2)})により左側（OTMプット側）のIVが高く、典型的なボラティリティスキューを示しています。下落リスクへの保険需要を反映しています。`;
  } else {
    interpretation += `正の歪度(${skewness.toFixed(2)})により右側（OTMコール側）のIVが高い、非典型的なパターンです。`;
  }

  if (excessKurtosis > 1) {
    interpretation += `超過尖度(${excessKurtosis.toFixed(2)})が大きく、スマイルの曲率が強い（テールリスクが高い）です。`;
  }

  return {
    smile,
    atmVol,
    skew,
    convexity,
    sourceSkewness: skewness,
    sourceKurtosis: excessKurtosis,
    interpretation,
  };
}
