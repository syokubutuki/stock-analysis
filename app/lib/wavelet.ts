// ウェーブレット変換 (Morlet連続ウェーブレット CWT)

export interface ScalogramPoint {
  timeIndex: number;
  scaleIndex: number;
  power: number;
}

export interface ScalogramResult {
  matrix: Float64Array[]; // [scaleIndex][timeIndex]
  scales: number[];       // 各スケールの周期(日)
  times: string[];
  maxPower: number;
}

// Morletウェーブレット (ω₀ = 6)
function morletReal(t: number, scale: number): number {
  const omega0 = 6;
  const x = t / scale;
  return (
    Math.pow(Math.PI, -0.25) *
    Math.exp(-0.5 * x * x) *
    Math.cos(omega0 * x) /
    Math.sqrt(scale)
  );
}

function morletImag(t: number, scale: number): number {
  const omega0 = 6;
  const x = t / scale;
  return (
    Math.pow(Math.PI, -0.25) *
    Math.exp(-0.5 * x * x) *
    Math.sin(omega0 * x) /
    Math.sqrt(scale)
  );
}

// CWT計算
export function computeCWT(
  values: number[],
  times: string[],
  numScales: number = 40
): ScalogramResult {
  const n = values.length;
  // 平均除去
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const centered = values.map((v) => v - mean);

  // スケール: 2日〜n/2日 を対数等間隔で
  const minScale = 2;
  const maxScale = Math.min(n / 2, 256);
  const scales: number[] = [];
  for (let i = 0; i < numScales; i++) {
    const s = minScale * Math.pow(maxScale / minScale, i / (numScales - 1));
    scales.push(s);
  }

  const matrix: Float64Array[] = [];
  let maxPower = 0;

  for (let si = 0; si < scales.length; si++) {
    const scale = scales[si];
    const row = new Float64Array(n);
    const halfWindow = Math.min(Math.ceil(scale * 4), Math.floor(n / 2));

    for (let t = 0; t < n; t++) {
      let realSum = 0;
      let imagSum = 0;
      for (let dt = -halfWindow; dt <= halfWindow; dt++) {
        const idx = t + dt;
        if (idx < 0 || idx >= n) continue;
        realSum += centered[idx] * morletReal(dt, scale);
        imagSum += centered[idx] * morletImag(dt, scale);
      }
      const power = realSum * realSum + imagSum * imagSum;
      row[t] = power;
      if (power > maxPower) maxPower = power;
    }
    matrix.push(row);
  }

  return { matrix, scales, times, maxPower };
}
