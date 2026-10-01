// CSCV（Combinatorially Symmetric Cross-Validation）によるバックテスト過剰適合確率 PBO。
// Bailey, Borwein, López de Prado, Zhu "The Probability of Backtest Overfitting"
// (https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf) の Algorithm 2.3 をそのまま実装する。
//
// 1. 行列 M（T 行 × N 列）: 列 n は試した候補 n の成績系列。行は全候補で同じ日付に揃っていること。
// 2. 行を等しい大きさの連続した S 個（偶数）の塊 M_s に分ける。
// 3. S 個から S/2 個を選ぶ全組合せ C_S（S=16 なら 12,870 通り。論文本文の 12,780 は誤植）。
// 4. 各組合せ c について、選んだ塊（元の順）を訓練 J、残りを検証 J̄ とし、各候補の成績
//    （ここではシャープレシオ）R^c, R̄^c を計算する。訓練で最良の候補 n* を選び、
//    検証での相対順位 ω̄_c = r̄_{n*} / (N + 1)（r̄ は昇順の順位、最良が N）とロジット
//    λ_c = ln(ω̄_c / (1 − ω̄_c)) を求める。
// 5. PBO = ∫_{−∞}^{0} f(λ) dλ ＝ λ_c ≤ 0 となる組合せの割合（訓練で最良の候補が、検証で候補の
//    中央値以下に落ちる割合）。
//
// PBO は「候補の集まりから最良を選ぶ手順」の評価であって、個別の規則の勝率や損失確率ではない。
// 論文の他の出力（性能劣化・損失確率・確率優越）は別の指標として返す。
//
// 実装上の約束:
// - 塊の大きさを揃えるため、T を S で割った余りの行は**古い側**から落とす（件数を返す）。
// - シャープレシオは行の平均÷標本標準偏差（n−1）。分散0（全行が同値＝取引なし等）は 0 とする。
// - 訓練で最良が同点なら、列の並びで先の候補を選ぶ（決定的）。
// - 検証の順位は同順位を平均順位で扱う（mid-rank）。
// - PBO を最適化の目的関数に使ってはいけない（論文 §5.2 の警告）。

export interface CscvResult {
  S: number;
  T: number;
  blockLength: number;
  /** 塊の大きさを揃えるために落とした古い行の数 */
  dropped: number;
  N: number;
  /** 内容の異なる列の数（同一の成績系列は同順位になり、順位の粒度を増やさない） */
  distinctN: number;
  combinations: number;
  pbo: number;
  logits: number[];
  /** 各組合せの n* の訓練・検証シャープ（年率） */
  isSelected: number[];
  oosSelected: number[];
  /** R̄_{n*} = α + β R_{n*} の最小二乗 */
  degradation: { slope: number; intercept: number; r2: number } | null;
  /** 検証で n* の成績が負になった割合（損失確率。PBO とは別物） */
  probLoss: number;
  /** 各列が n* に選ばれた回数 */
  selectedCount: number[];
  /**
   * 確率優越: 選んだ候補の検証成績の分布が、無作為に1つ選んだ場合（全候補・全組合せの検証成績の
   * 混合）の分布を上回るか。grid は x の格子、cdf* は各分布の累積分布。
   */
  dominance: { first: boolean; second: boolean; grid: number[]; cdfSelected: number[]; cdfRandom: number[] };
}

function popcount(x: number): number {
  let c = 0;
  while (x) { x &= x - 1; c++; }
  return c;
}

function sharpeOf(sum: number, sq: number, n: number): number {
  if (n < 2) return 0;
  const mean = sum / n;
  const variance = (sq - n * mean * mean) / (n - 1);
  if (!(variance > 1e-20)) return 0;
  return mean / Math.sqrt(variance);
}

function columnKey(column: ArrayLike<number>, from: number): string {
  // FNV-1a 32bit を2本（異なる初期値）。同一列の判定に使うだけなので衝突は実害が小さい。
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = from; i < column.length; i++) {
    const v = Math.round(column[i] * 1e12);
    const lo = v | 0;
    const hi = Math.floor(v / 4294967296) | 0;
    h1 = Math.imul(h1 ^ lo, 16777619) >>> 0;
    h1 = Math.imul(h1 ^ hi, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ hi, 2246822519) >>> 0;
    h2 = Math.imul(h2 ^ lo, 3266489917) >>> 0;
  }
  return `${h1.toString(16)}-${h2.toString(16)}`;
}

/**
 * @param columns N 本の成績系列（各長さ T、同じ日付に揃っていること）
 * @param S 偶数の分割数（2〜16）
 * @param annualize シャープの年率換算係数（日次なら √252）。順位・符号には影響しない
 */
export function cscvPbo(
  columns: ArrayLike<number>[],
  S: number,
  annualize = Math.sqrt(252),
  onProgress?: (done: number, total: number) => void,
): CscvResult {
  const N = columns.length;
  if (N < 2) throw new Error("CSCV には2本以上の候補が必要です。");
  if (!Number.isInteger(S) || S < 2 || S > 16 || S % 2 !== 0) throw new Error("S は 2〜16 の偶数で指定してください。");
  const T = columns[0].length;
  if (columns.some((c) => c.length !== T)) throw new Error("候補の成績系列の長さが揃っていません（同じ日付の行列が必要）。");
  const blockLength = Math.floor(T / S);
  if (blockLength < 2) throw new Error("行数が少なすぎて S 個の塊に分けられません。");
  const dropped = T - blockLength * S;

  // 塊ごとの和と二乗和
  const blockSum: Float64Array[] = [];
  const blockSq: Float64Array[] = [];
  const totalSum = new Float64Array(N);
  const totalSq = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const bs = new Float64Array(S);
    const bq = new Float64Array(S);
    const col = columns[n];
    for (let s = 0; s < S; s++) {
      let sum = 0, sq = 0;
      const from = dropped + s * blockLength;
      for (let i = from; i < from + blockLength; i++) {
        const v = col[i];
        sum += v;
        sq += v * v;
      }
      bs[s] = sum;
      bq[s] = sq;
      totalSum[n] += sum;
      totalSq[n] += sq;
    }
    blockSum.push(bs);
    blockSq.push(bq);
  }
  const distinctN = new Set(columns.map((c) => columnKey(c, dropped))).size;

  const masks: number[] = [];
  for (let m = 0; m < 1 << S; m++) if (popcount(m) === S / 2) masks.push(m);
  const half = (S / 2) * blockLength;
  const logits: number[] = [];
  const isSelected: number[] = [];
  const oosSelected: number[] = [];
  const selectedCount = Array<number>(N).fill(0);
  const pooledRandom = new Float32Array(masks.length * N);
  const isSharpe = new Float64Array(N);
  const oosSharpe = new Float64Array(N);

  masks.forEach((mask, ci) => {
    for (let n = 0; n < N; n++) {
      let sum = 0, sq = 0;
      const bs = blockSum[n];
      const bq = blockSq[n];
      for (let s = 0; s < S; s++) {
        if (mask & (1 << s)) { sum += bs[s]; sq += bq[s]; }
      }
      isSharpe[n] = sharpeOf(sum, sq, half);
      oosSharpe[n] = sharpeOf(totalSum[n] - sum, totalSq[n] - sq, half);
      pooledRandom[ci * N + n] = oosSharpe[n] * annualize;
    }
    let best = 0;
    for (let n = 1; n < N; n++) if (isSharpe[n] > isSharpe[best]) best = n;
    const x = oosSharpe[best];
    let below = 0, equal = 0;
    for (let n = 0; n < N; n++) {
      const d = oosSharpe[n] - x;
      if (Math.abs(d) <= 1e-12) equal++;
      else if (d < 0) below++;
    }
    const rank = below + (equal + 1) / 2;
    const omega = rank / (N + 1);
    logits.push(Math.log(omega / (1 - omega)));
    isSelected.push(isSharpe[best] * annualize);
    oosSelected.push(x * annualize);
    selectedCount[best]++;
    if (onProgress && (ci % 500 === 0 || ci === masks.length - 1)) onProgress(ci + 1, masks.length);
  });

  const C = masks.length;
  const pbo = logits.filter((l) => l <= 0).length / C;
  const probLoss = oosSelected.filter((v) => v < 0).length / C;

  let degradation: CscvResult["degradation"] = null;
  {
    const mx = isSelected.reduce((a, b) => a + b, 0) / C;
    const my = oosSelected.reduce((a, b) => a + b, 0) / C;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < C; i++) {
      const dx = isSelected[i] - mx;
      const dy = oosSelected[i] - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    if (sxx > 0) {
      const slope = sxy / sxx;
      degradation = { slope, intercept: my - slope * mx, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 0 };
    }
  }

  // 確率優越（x の格子上で累積分布を比べる）
  const sortedSel = [...oosSelected].sort((a, b) => a - b);
  const sortedAll = Float32Array.from(pooledRandom).sort();
  const lo = Math.min(sortedSel[0], sortedAll[0]);
  const hi = Math.max(sortedSel[sortedSel.length - 1], sortedAll[sortedAll.length - 1]);
  const gridSize = 101;
  const grid: number[] = [];
  const cdfSelected: number[] = [];
  const cdfRandom: number[] = [];
  const cdfAt = (sorted: ArrayLike<number>, x: number) => {
    let a = 0, b = sorted.length;
    while (a < b) { const m = (a + b) >> 1; if (sorted[m] <= x) a = m + 1; else b = m; }
    return a / sorted.length;
  };
  for (let g = 0; g < gridSize; g++) {
    const x = hi > lo ? lo + ((hi - lo) * g) / (gridSize - 1) : lo;
    grid.push(x);
    cdfSelected.push(cdfAt(sortedSel, x));
    cdfRandom.push(cdfAt(sortedAll, x));
  }
  const tol = 1e-9;
  const first = cdfSelected.every((v, g) => v <= cdfRandom[g] + tol) && cdfSelected.some((v, g) => v < cdfRandom[g] - tol);
  let area = 0;
  let second = true;
  let strictly = false;
  for (let g = 1; g < gridSize; g++) {
    const dx = grid[g] - grid[g - 1];
    area += 0.5 * dx * ((cdfRandom[g] - cdfSelected[g]) + (cdfRandom[g - 1] - cdfSelected[g - 1]));
    if (area < -tol) second = false;
    if (area > tol) strictly = true;
  }

  return {
    S, T, blockLength, dropped, N, distinctN, combinations: C,
    pbo, logits, isSelected, oosSelected, degradation, probLoss, selectedCount,
    dominance: { first, second: second && strictly, grid, cdfSelected, cdfRandom },
  };
}
