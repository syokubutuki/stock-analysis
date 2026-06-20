// アノマリー系分析の共通統計基盤。1標本t検定の両側p値、Benjamini-Hochberg FDR補正、
// 移動ブロック・ブートストラップ95%CIを提供する。weekday-scan.ts に閉じていた検定ロジックを
// 横断利用できるよう独立モジュールに切り出したもの。

export function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

export function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

export function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return quantileSorted(s, 0.5);
}

function lnGamma(z: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// 正則化不完全ベータ関数 I_x(a,b)。t分布の両側p値に使う。
function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnB = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnB) / a;
  let f = 1, c = 1, d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d; f = d;
  for (let i = 1; i <= 200; i++) {
    let num = (i * (b - i) * x) / ((a + 2 * i - 1) * (a + 2 * i));
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30; f *= d * c;
    num = (-(a + i) * (a + b + i) * x) / ((a + 2 * i) * (a + 2 * i + 1));
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    const delta = d * c; f *= delta;
    if (Math.abs(delta - 1) < 1e-10) break;
  }
  return front * f;
}

// 平均=0 という帰無仮説に対する1標本t検定の両側p値。
export function tTest(arr: number[]): { t: number; p: number } | null {
  const n = arr.length;
  if (n < 3) return null;
  const se = std(arr) / Math.sqrt(n);
  if (se === 0) return null;
  const t = mean(arr) / se;
  const df = n - 1;
  const x = df / (df + t * t);
  const p = Math.min(incompleteBeta(df / 2, 0.5, x), 1);
  return { t, p };
}

// Benjamini-Hochberg法によるFDR(偽発見率)補正。生p値配列 → 補正済みp値配列(同順)。
export function benjaminiHochberg(pvals: number[]): number[] {
  const m = pvals.length;
  if (m === 0) return [];
  const order = pvals.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adj = new Array(m).fill(1);
  let prev = 1;
  for (let k = m - 1; k >= 0; k--) {
    const rank = k + 1;
    const val = Math.min(1, (order[k].p * m) / rank);
    prev = Math.min(prev, val);
    adj[order[k].i] = prev;
  }
  return adj;
}

// 移動ブロック・ブートストラップで平均の95%CIを推定する。系列相関に頑健。
// ブロック長 L ≈ n^(1/3) で連続する観測を束ねて再標本化する。
export function blockBootstrapCI(
  data: number[],
  B = 800
): { lo: number; hi: number; stable: number } | null {
  const n = data.length;
  if (n < 5) return null;
  const L = Math.max(1, Math.round(Math.cbrt(n)));
  const nBlocks = Math.ceil(n / L);
  const pointSign = mean(data) >= 0 ? 1 : -1;
  const samples: number[] = [];
  let sameSign = 0;
  for (let b = 0; b < B; b++) {
    let sum = 0, cnt = 0;
    for (let blk = 0; blk < nBlocks && cnt < n; blk++) {
      const start = Math.floor(Math.random() * n);
      for (let j = 0; j < L && cnt < n; j++) {
        sum += data[(start + j) % n];
        cnt++;
      }
    }
    const m = sum / cnt;
    samples.push(m);
    if ((m >= 0 ? 1 : -1) === pointSign) sameSign++;
  }
  samples.sort((a, b) => a - b);
  return { lo: quantileSorted(samples, 0.025), hi: quantileSorted(samples, 0.975), stable: sameSign / B };
}
