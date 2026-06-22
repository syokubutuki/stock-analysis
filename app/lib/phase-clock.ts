// 位相時計 (Cycle Phase Clock)
// 株価の卓越サイクルが「今どの位相にいるか」を時計の文字盤に投影し、
// 各位相セクターの後に実際どう動いたか(フォワードリターン)で色付けする。
//
// 重要: 位相は必ず因果的(過去データのみ)に推定する。
//   Morletや解析信号(Hilbert)は両側窓/全系列FFTで未来を覗くため、
//   売買タイミング指標としては先読みバイアスになる。
//   ここでは Ehlers流の「複素復調 (complex demodulation)」を用いる:
//     1. 因果EMAで長期トレンドを除去 → 周期成分 residual
//     2. residual を搬送波 e^{-i·2πt/P} でベースバンドへ周波数変換
//     3. 因果EMAでローパス → ベースバンド複素振幅 y(t)
//     4. 瞬時位相 Φ(t) = (2πt/P + arg y(t)) mod 2π, 振幅 A(t) = 2|y(t)|
//   すべて過去から現在までの値のみで計算されるため未来を使わない。

import { StateFn } from "./conditional-forward-returns";

export interface PhaseClock {
  phase: (number | null)[]; // 瞬時位相 [0,2π), warmup区間は null
  amplitude: number[];      // サイクル振幅 A(t) (>=0)
  cyclic: number[];         // トレンド除去後の周期成分 residual
  period: number;           // 使用した周期 P [日]
  warmup: number;           // 立ち上がり区間 (これ未満の index は無効)
  ampMedian: number;        // 有効区間の振幅中央値 (強弱判定の基準)
  nowPhase: number | null;  // 最新足の位相
  nowAmp: number | null;    // 最新足の振幅
}

// 因果的な指数移動平均
function causalEMA(x: number[], alpha: number): number[] {
  const out = new Array(x.length);
  let s = x.length > 0 ? x[0] : 0;
  for (let i = 0; i < x.length; i++) {
    s += alpha * (x[i] - s);
    out[i] = s;
  }
  return out;
}

const TWO_PI = 2 * Math.PI;
function wrap2pi(x: number): number {
  return ((x % TWO_PI) + TWO_PI) % TWO_PI;
}

// 指定周期 P の位相時計を構築する。
export function buildPhaseClock(values: number[], period: number): PhaseClock {
  const n = values.length;
  const P = Math.max(2, period);

  // --- 1. 因果的トレンド除去 (高域通過) ---
  const trendSpan = 3 * P;
  const trend = causalEMA(values, 2 / (trendSpan + 1));
  const resid = new Array(n);
  for (let i = 0; i < n; i++) resid[i] = values[i] - trend[i];

  // --- 2,3. 複素復調 + 因果ローパス ---
  const w = TWO_PI / P;
  const aSmooth = 2 / (P + 1);
  const phase: (number | null)[] = new Array(n).fill(null);
  const amplitude = new Array(n).fill(0);
  const warmup = Math.min(n - 1, Math.round(trendSpan + 2 * P));

  let emaRe = 0;
  let emaIm = 0;
  for (let i = 0; i < n; i++) {
    const c = Math.cos(w * i);
    const s = Math.sin(w * i);
    // residual · e^{-i·w·i} = residual·(cos − i·sin)
    const hr = resid[i] * c;
    const hi = -resid[i] * s;
    if (i === 0) { emaRe = hr; emaIm = hi; }
    else { emaRe += aSmooth * (hr - emaRe); emaIm += aSmooth * (hi - emaIm); }

    const amp = 2 * Math.hypot(emaRe, emaIm);
    amplitude[i] = amp;
    if (i >= warmup) {
      const theta = Math.atan2(emaIm, emaRe);
      phase[i] = wrap2pi(w * i + theta);
    }
  }

  // 有効区間の振幅中央値
  const validAmp = amplitude.slice(warmup).filter((a) => a > 0).sort((a, b) => a - b);
  const ampMedian = validAmp.length ? validAmp[Math.floor(validAmp.length / 2)] : 0;

  // 最新の有効値
  let nowPhase: number | null = null;
  let nowAmp: number | null = null;
  for (let i = n - 1; i >= 0; i--) {
    if (phase[i] !== null) { nowPhase = phase[i]; nowAmp = amplitude[i]; break; }
  }

  return { phase, amplitude, cyclic: resid, period: P, warmup, ampMedian, nowPhase, nowAmp };
}

// 位相時計を conditionalForwardReturns 用の状態関数に変換する。
// sectors: 文字盤を何分割するか。strongOnly: 振幅が中央値以上の「サイクルが効いている日」のみ採用。
export function phaseStateFn(clock: PhaseClock, sectors: number, strongOnly: boolean): StateFn {
  const K = Math.max(2, sectors);
  const step = TWO_PI / K;
  const order: string[] = [];
  for (let s = 0; s < K; s++) {
    const center = ((s + 0.5) * 360) / K;
    order.push(`${Math.round(center)}°`);
  }
  return {
    order,
    stateOf: (i) => {
      const ph = clock.phase[i];
      if (ph === null) return null;
      if (strongOnly && clock.amplitude[i] < clock.ampMedian) return null;
      let s = Math.floor(ph / step);
      if (s >= K) s = K - 1;
      return order[s];
    },
  };
}

// 卓越周期(最もサイクル振幅が大きい周期)を候補グリッドから推定する。
export function dominantPeriod(values: number[], candidates?: number[]): number {
  const grid = candidates ?? [5, 7, 9, 11, 14, 17, 21, 26, 32, 40, 50, 63, 80, 100, 120];
  let best = grid[0];
  let bestScore = -Infinity;
  for (const P of grid) {
    if (values.length < 4 * P) continue;
    const clk = buildPhaseClock(values, P);
    // 有効区間の平均振幅をスコアに(周期に対する正規化のためPで割らない素の強度)
    let sum = 0;
    let cnt = 0;
    for (let i = clk.warmup; i < clk.amplitude.length; i++) { sum += clk.amplitude[i]; cnt++; }
    const score = cnt > 0 ? sum / cnt : 0;
    if (score > bestScore) { bestScore = score; best = P; }
  }
  return best;
}
