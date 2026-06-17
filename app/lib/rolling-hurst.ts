// ローリングHurst指数 + サロゲート帯
//
// fractal.ts の computeDFA は「全期間で1つのHurst指数」を返す静的指標。
// ここではそれを移動窓で時系列化(ローリング化)し、さらに
// 「もし系列がランダム(記憶なし)だったらHurstはどの範囲に収まるか」を
// ブートストラップ・サロゲートで推定して信頼帯(サロゲート帯)を作る。
//
// 窓の外れ = 偶然では説明できない本物の持続性/反持続性。

// 単一窓の DFA-Hurst (fractal.ts のロジックを窓向けに軽量化したもの)
export function dfaHurst(values: number[]): number {
  const n = values.length;
  if (n < 16) return 0.5;

  const mean = values.reduce((a, b) => a + b, 0) / n;
  const profile = new Float64Array(n);
  let cum = 0;
  for (let i = 0; i < n; i++) {
    cum += values[i] - mean;
    profile[i] = cum;
  }

  const minScale = 4;
  const maxScale = Math.floor(n / 4);
  const numScales = 12;
  const scales: number[] = [];
  for (let i = 0; i < numScales; i++) {
    const s = Math.round(minScale * Math.pow(maxScale / minScale, i / (numScales - 1)));
    if (scales.length === 0 || s !== scales[scales.length - 1]) scales.push(s);
  }

  const logN: number[] = [];
  const logF: number[] = [];
  for (const s of scales) {
    const numSeg = Math.floor(n / s);
    if (numSeg < 1) continue;
    let totalVar = 0;
    let cnt = 0;
    for (let seg = 0; seg < numSeg; seg++) {
      const start = seg * s;
      let sx = 0, sy = 0, sxy = 0, sx2 = 0;
      for (let j = 0; j < s; j++) {
        sx += j;
        sy += profile[start + j];
        sxy += j * profile[start + j];
        sx2 += j * j;
      }
      const denom = s * sx2 - sx * sx;
      const a = denom !== 0 ? (s * sxy - sx * sy) / denom : 0;
      const b = (sy - a * sx) / s;
      let variance = 0;
      for (let j = 0; j < s; j++) {
        variance += (profile[start + j] - (a * j + b)) ** 2;
      }
      totalVar += variance / s;
      cnt++;
    }
    if (cnt > 0) {
      const F = Math.sqrt(totalVar / cnt);
      if (F > 0) {
        logN.push(Math.log10(s));
        logF.push(Math.log10(F));
      }
    }
  }
  return fitSlope(logN, logF);
}

function fitSlope(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0.5;
  const sx = x.reduce((a, b) => a + b, 0);
  const sy = y.reduce((a, b) => a + b, 0);
  const sxy = x.reduce((a, xi, i) => a + xi * y[i], 0);
  const sx2 = x.reduce((a, xi) => a + xi * xi, 0);
  const denom = n * sx2 - sx * sx;
  if (Math.abs(denom) < 1e-10) return 0.5;
  return (n * sxy - sx * sy) / denom;
}

export interface RollingHurstPoint {
  time: string;
  hurst: number;
}

export interface SurrogateBand {
  q025: number; // 2.5%分位点 (帯の下端)
  q50: number;  // 中央値 (≈0.5 想定)
  q975: number; // 97.5%分位点 (帯の上端)
  samples: number[]; // サロゲートHurstの分布 (ヒストグラム用)
}

export interface RollingHurstResult {
  series: RollingHurstPoint[];
  band: SurrogateBand;
  window: number;
  aboveRatio: number; // 帯の上(有意な持続性)に出た割合
  belowRatio: number; // 帯の下(有意な反持続性)に出た割合
}

// 移動窓でHurstを逐次計算
export function rollingHurstSeries(values: number[], times: string[], window: number): RollingHurstPoint[] {
  const out: RollingHurstPoint[] = [];
  for (let end = window; end <= values.length; end++) {
    const win = values.slice(end - window, end);
    out.push({ time: times[end - 1], hurst: dfaHurst(win) });
  }
  return out;
}

// Fisher-Yates シャッフル
function shuffled(arr: number[]): number[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// サロゲート帯: 系列の並びをシャッフル(=記憶を破壊, 周辺分布は保持)した
// 窓のHurstを B 回計算し、分位点を取る。
// 並びだけ壊すので「ランダムウォークなら窓Hurstはこの範囲」を表す帰無分布。
export function surrogateBand(values: number[], window: number, B: number): SurrogateBand {
  const samples: number[] = [];
  const W = Math.min(window, values.length);
  for (let b = 0; b < B; b++) {
    const sh = shuffled(values);
    // シャッフル系列の先頭窓(並びがランダムなので位置は不問)
    samples.push(dfaHurst(sh.slice(0, W)));
  }
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
  return { q025: q(0.025), q50: q(0.5), q975: q(0.975), samples };
}

export function computeRollingHurst(
  values: number[],
  times: string[],
  window: number,
  surrogateCount: number = 300
): RollingHurstResult {
  const series = rollingHurstSeries(values, times, window);
  const band = surrogateBand(values, window, surrogateCount);

  let above = 0, below = 0;
  for (const p of series) {
    if (p.hurst > band.q975) above++;
    else if (p.hurst < band.q025) below++;
  }
  const n = series.length || 1;

  return {
    series,
    band,
    window,
    aboveRatio: above / n,
    belowRatio: below / n,
  };
}
