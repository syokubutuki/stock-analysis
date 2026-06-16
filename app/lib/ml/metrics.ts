/** 二値分類の評価指標 (純関数 / 純TypeScript実装) */

/**
 * ROC-AUC (Area Under the ROC Curve)。
 * Mann–Whitney U / ランクベースで実装する。
 * scores: 連続スコア (確率や log-odds 等)、labels: 0/1。
 * 全サンプルが同一クラスの場合は判定不能のため 0.5 を返す。
 */
export function rocAuc(scores: number[], labels: number[]): number {
  const n = Math.min(scores.length, labels.length);
  if (n === 0) return 0.5;

  // スコアでソートし、同点には平均ランクを割り当てる
  const idx = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => scores[a] - scores[b],
  );
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n - 1 && scores[idx[j + 1]] === scores[idx[i]]) j++;
    // ランクは 1-based。[i..j] の平均ランク
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]] = avgRank;
    i = j + 1;
  }

  let sumRankPos = 0;
  let nPos = 0;
  for (let k = 0; k < n; k++) {
    if (labels[k] === 1) {
      sumRankPos += ranks[k];
      nPos++;
    }
  }
  const nNeg = n - nPos;
  if (nPos === 0 || nNeg === 0) return 0.5;

  // AUC = (ΣrankPos − nPos(nPos+1)/2) / (nPos * nNeg)
  const auc = (sumRankPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
  return auc;
}

/**
 * Balanced Accuracy = (TPR + TNR) / 2。
 * preds: 0/1 の予測、labels: 0/1 の正解。
 */
export function balancedAccuracy(preds: number[], labels: number[]): number {
  const { tp, fp, fn, tn } = confusion(preds, labels);
  const pos = tp + fn;
  const neg = tn + fp;
  // クラスが片方しか無い場合はそのクラスのみで評価
  const tpr = pos > 0 ? tp / pos : 1;
  const tnr = neg > 0 ? tn / neg : 1;
  if (pos === 0 && neg === 0) return 0;
  if (pos === 0) return tnr;
  if (neg === 0) return tpr;
  return (tpr + tnr) / 2;
}

/**
 * Log Loss (交差エントロピー)。
 * 確率を 1e-15 でクリップして log(0) を避ける。
 */
export function logLoss(probs: number[], labels: number[]): number {
  const n = Math.min(probs.length, labels.length);
  if (n === 0) return 0;
  const eps = 1e-15;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.min(1 - eps, Math.max(eps, probs[i]));
    const y = labels[i];
    sum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return sum / n;
}

/**
 * Brier Score = 平均二乗誤差 (確率 − 正解)。
 */
export function brierScore(probs: number[], labels: number[]): number {
  const n = Math.min(probs.length, labels.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = probs[i] - labels[i];
    sum += d * d;
  }
  return sum / n;
}

/**
 * 混同行列。preds・labels はともに 0/1。
 */
export function confusion(
  preds: number[],
  labels: number[],
): { tp: number; fp: number; fn: number; tn: number } {
  const n = Math.min(preds.length, labels.length);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < n; i++) {
    const p = preds[i] >= 0.5 ? 1 : 0;
    const y = labels[i] >= 0.5 ? 1 : 0;
    if (p === 1 && y === 1) tp++;
    else if (p === 1 && y === 0) fp++;
    else if (p === 0 && y === 1) fn++;
    else tn++;
  }
  return { tp, fp, fn, tn };
}
