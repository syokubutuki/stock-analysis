// ACF (自己相関関数) / PACF (偏自己相関関数)

export interface ACFPoint {
  lag: number;
  value: number;
}

// 自己相関関数
export function acf(values: number[], maxLag: number = 30): ACFPoint[] {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  if (variance === 0) return [];

  const result: ACFPoint[] = [{ lag: 0, value: 1 }];
  for (let lag = 1; lag <= Math.min(maxLag, n - 1); lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) {
      sum += (values[i] - mean) * (values[i + lag] - mean);
    }
    result.push({ lag, value: sum / (n * variance) });
  }
  return result;
}

// 偏自己相関関数 (Levinson-Durbin アルゴリズム)
export function pacf(values: number[], maxLag: number = 30): ACFPoint[] {
  const acfValues = acf(values, maxLag);
  if (acfValues.length < 2) return [];

  const r = acfValues.map((a) => a.value); // r[0]=1, r[1], r[2], ...
  const result: ACFPoint[] = [{ lag: 0, value: 1 }];
  const mLag = Math.min(maxLag, r.length - 1);

  // Levinson-Durbin
  const phi: number[][] = [];
  for (let i = 0; i <= mLag; i++) {
    phi.push(new Array(mLag + 1).fill(0));
  }

  phi[1][1] = r[1];
  result.push({ lag: 1, value: r[1] });

  for (let k = 2; k <= mLag; k++) {
    let num = r[k];
    for (let j = 1; j < k; j++) {
      num -= phi[k - 1][j] * r[k - j];
    }
    let den = 1;
    for (let j = 1; j < k; j++) {
      den -= phi[k - 1][j] * r[j];
    }
    phi[k][k] = den !== 0 ? num / den : 0;

    for (let j = 1; j < k; j++) {
      phi[k][j] = phi[k - 1][j] - phi[k][k] * phi[k - 1][k - j];
    }

    result.push({ lag: k, value: phi[k][k] });
  }

  return result;
}

// 95%信頼区間 (±1.96/√n)
export function confidenceBound(n: number): number {
  return 1.96 / Math.sqrt(n);
}
