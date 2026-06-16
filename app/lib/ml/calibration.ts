/** 確率較正 (Platt scaling / Isotonic regression) 純TypeScript実装 */

// ── Platt scaling ──────────────────────────────────
// スコア s に対し p = 1/(1+exp(a*s+b)) を当てる (ロジスティック回帰)。
// パラメータ a, b をニュートン法で推定する。

export interface PlattModel {
  a: number;
  b: number;
}

/**
 * Platt scaling のパラメータ a, b を推定する。
 * scores: 連続スコア、labels: 0/1。
 * 過学習を抑えるため Platt(1999) の正則化された目標値 (t+, t-) を用いる。
 */
export function fitPlatt(scores: number[], labels: number[]): PlattModel {
  const n = Math.min(scores.length, labels.length);
  if (n === 0) return { a: -1, b: 0 };

  let nPos = 0;
  let nNeg = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] === 1) nPos++;
    else nNeg++;
  }
  // 正則化された目標確率 (端点を避けることで数値安定化)
  const hiTarget = (nPos + 1) / (nPos + 2);
  const loTarget = 1 / (nNeg + 2);
  const t = new Array<number>(n);
  for (let i = 0; i < n; i++) t[i] = labels[i] === 1 ? hiTarget : loTarget;

  // 初期値: a=0, b=log((N-+1)/(N++1))
  let a = 0;
  let b = Math.log((nNeg + 1) / (nPos + 1));

  const maxIter = 100;
  const minStep = 1e-10;
  const sigma = 1e-12;

  for (let iter = 0; iter < maxIter; iter++) {
    // 勾配・ヘシアン (2x2)
    let h11 = sigma;
    let h22 = sigma;
    let h21 = 0;
    let g1 = 0;
    let g2 = 0;
    for (let i = 0; i < n; i++) {
      const fApB = scores[i] * a + b;
      // p = 1/(1+exp(fApB)) を数値安定に計算
      let p: number;
      let q: number;
      if (fApB >= 0) {
        const e = Math.exp(-fApB);
        p = e / (1 + e);
        q = 1 / (1 + e);
      } else {
        const e = Math.exp(fApB);
        p = 1 / (1 + e);
        q = e / (1 + e);
      }
      const d2 = p * q;
      const d1 = t[i] - p;
      h11 += scores[i] * scores[i] * d2;
      h22 += d2;
      h21 += scores[i] * d2;
      g1 += scores[i] * d1;
      g2 += d1;
    }

    if (Math.abs(g1) < 1e-5 && Math.abs(g2) < 1e-5) break;

    // ニュートン方向: H * delta = g を解く (2x2)
    const det = h11 * h22 - h21 * h21;
    if (Math.abs(det) < 1e-15) break;
    const dA = -(h22 * g1 - h21 * g2) / det;
    const dB = -(-h21 * g1 + h11 * g2) / det;
    const gd = g1 * dA + g2 * dB;

    // バックトラッキング直線探索
    let step = 1;
    while (step >= minStep) {
      const newA = a + step * dA;
      const newB = b + step * dB;
      let newF = 0;
      for (let i = 0; i < n; i++) {
        const fApB = scores[i] * newA + newB;
        if (fApB >= 0) {
          newF += t[i] * fApB + Math.log(1 + Math.exp(-fApB));
        } else {
          newF += (t[i] - 1) * fApB + Math.log(1 + Math.exp(fApB));
        }
      }
      // 目的関数 (負の対数尤度) が十分減れば採用
      if (newF < currentNll(scores, t, a, b, n) + 1e-4 * step * gd) {
        a = newA;
        b = newB;
        break;
      }
      step /= 2;
    }
    if (step < minStep) break;
  }

  return { a, b };
}

// Platt 目的関数 (負の対数尤度) を数値安定に計算する補助関数
function currentNll(
  scores: number[],
  t: number[],
  a: number,
  b: number,
  n: number,
): number {
  let f = 0;
  for (let i = 0; i < n; i++) {
    const fApB = scores[i] * a + b;
    if (fApB >= 0) {
      f += t[i] * fApB + Math.log(1 + Math.exp(-fApB));
    } else {
      f += (t[i] - 1) * fApB + Math.log(1 + Math.exp(fApB));
    }
  }
  return f;
}

/** Platt scaling を適用して較正済み確率を返す。 */
export function applyPlatt(score: number, model: PlattModel): number {
  const fApB = score * model.a + model.b;
  if (fApB >= 0) {
    const e = Math.exp(-fApB);
    return e / (1 + e);
  }
  const e = Math.exp(fApB);
  return 1 / (1 + e);
}

// ── Isotonic regression ────────────────────────────
// PAV (Pool Adjacent Violators) で単調増加な区分定数関数を構築する。

export interface IsotonicModel {
  // 昇順に並んだスコアのしきい値と、対応する較正済み確率
  x: number[];
  y: number[];
}

/**
 * 等調回帰 (単調増加) を PAV で当てる。
 * scores: 連続スコア、labels: 0/1。
 */
export function fitIsotonic(scores: number[], labels: number[]): IsotonicModel {
  const n = Math.min(scores.length, labels.length);
  if (n === 0) return { x: [], y: [] };

  // スコア昇順にソート (同点は安定順)
  const idx = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => scores[a] - scores[b],
  );

  // 各ブロック: value (加重平均), weight (件数), xMax (ブロック内最大スコア)
  const blockVal: number[] = [];
  const blockW: number[] = [];
  const blockX: number[] = [];

  for (const i of idx) {
    let v = labels[i];
    let w = 1;
    const xx = scores[i];
    // 直前ブロックと単調性が崩れていればプール (併合)
    while (blockVal.length > 0 && blockVal[blockVal.length - 1] >= v) {
      const pv = blockVal.pop()!;
      const pw = blockW.pop()!;
      blockX.pop();
      v = (pv * pw + v * w) / (pw + w);
      w = pw + w;
    }
    blockVal.push(v);
    blockW.push(w);
    blockX.push(xx);
  }

  // ブロックの代表スコア (右端) と較正値を展開
  // 各ブロックは [前ブロックの xMax, 当ブロックの xMax] を担当
  return { x: blockX, y: blockVal };
}

/**
 * 等調回帰モデルを適用して較正済み確率を返す。
 * しきい値間は線形補間し、範囲外は端点でクランプする。
 */
export function applyIsotonic(score: number, model: IsotonicModel): number {
  const { x, y } = model;
  const m = x.length;
  if (m === 0) return 0.5;
  if (m === 1) return y[0];
  if (score <= x[0]) return y[0];
  if (score >= x[m - 1]) return y[m - 1];

  // 二分探索で score を挟む区間を見つけ線形補間する
  let lo = 0;
  let hi = m - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= score) lo = mid;
    else hi = mid;
  }
  const x0 = x[lo];
  const x1 = x[hi];
  if (x1 === x0) return y[lo];
  const tt = (score - x0) / (x1 - x0);
  return y[lo] + tt * (y[hi] - y[lo]);
}
