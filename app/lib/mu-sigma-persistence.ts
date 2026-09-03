// σ は続くが μ は続かない ― 横断での持続性の対比。
//
// ## なぜこのファイルがあるか
//
// `kelly-uncertainty.ts`（sim-kelly）は1銘柄について「μ は測れず σ は測れる」を
// 推定誤差の側から示した。SE(μ̂)/SE(σ̂) = √504 ≈ 22倍 は定数なので理屈は完結しているが、
// **理屈であって実測ではない**。同じことを横断データで直接見せるのがこの層である。
//
// 標本を前半/後半に割り、各銘柄を (σ, μ̂) 平面で「前半の点 → 後半の点」の矢印にする。
// 12銘柄・10年（各約4.9年）の実測（2026-08-31）:
//
//        Pearson   Spearman(順位)
//   σ      0.775        0.420
//   μ̂     −0.153        0.000     ← 順位相関が文字どおりゼロ
//
//   |Δσ| の中央値 7.6pp  vs  |Δμ| の中央値 18.1pp
//
// **前半で μ が一番高かった銘柄を知っていても、後半について何も分からない。**
// 一方 σ は水準が全体に上がった（+7.6pp）のに順位は保たれた。これは
// `sector-factor-stability` の「全員の身長が伸びても背の順は変わらない」と同じ構造である。
//
// ## 反転率を「頑健さの証拠」に使ってはいけない（設計時に踏んだ間違い）
//
// 実測では壁（σ²/2）越えの判定が反転したのは 12銘柄中 1銘柄だけだった。これを
// 「低ボラ銘柄は判定が頑健」の根拠にしかけたが、**間違いである**。壁からの距離を
// SE(μ̂) 単位で測ると、三菱UFJの前半ですら 0.43SE しかない。反転しなかったのは
// 頑健だったからではなく、**たまたま両期間とも μ̂ が正だっただけ**である。
//
// 正しい指標は `margin`（判定余裕）:
//
//   margin = (μ − σ²/2) / (σ/√T) = √T · (μ/σ − σ/2)
//
// これは **σ の減少関数**で、σ→0 で無限大に発散する。したがって
// **低ボラを選ぶ理由は「ドラッグを避ける」ことではなく「判定余裕が σ とともに増える」
// ことである** ── ただし現実の水準では、銀行株ですら margin < 1 で、
// 判定は依然として誤差に飲まれている。この2つを同時に言うのがこの層の結論であり、
// [[holding-ledger]] / [[kelly-uncertainty]] で積んだ話の締めになる。
//
// 反転率は「実際に何が起きたか」の記述として出すに留め、必ず medMargin と並べる。
//
// ## 実装上の要点
//
// - 銘柄ごとに異なる上場期間を持つので、**必ず共通日付に整列してから割る**
//   （`alignReturns`）。各銘柄の自前の履歴を半分にすると、前半/後半が銘柄ごとに
//   別の暦期間を指してしまい、横断相関が意味を失う。
// - μ は必ず算術（`annualStats` 経由）。対数μを使うと σ²/2 を二重に引く（mu-convention）。

import { PricePoint } from "./types";
import { alignReturns, type AlignedReturns } from "./portfolio-risk";
import { annualStats, TRADING_DAYS } from "./growth-drag";

export interface PersistenceRow {
  ticker: string;
  name: string;
  sigma1: number;
  sigma2: number;
  mu1: number;
  mu2: number;
  /** 壁 σ²/2。前半・後半それぞれの σ から決まる */
  hurdle1: number;
  hurdle2: number;
  seMu1: number;
  seMu2: number;
  /** μ̂ が壁を越えていたか */
  above1: boolean;
  above2: boolean;
  /** 前半と後半で壁越えの判定が反転したか */
  flipped: boolean;
  dSigma: number;
  dMu: number;
  /**
   * 壁からの距離を SE(μ̂) 単位で測った「判定の余裕」。
   *
   *   margin = (μ − σ²/2) / (σ/√T) = √T · (μ/σ − σ/2)
   *
   * **σ の減少関数**なので、低ボラ銘柄ほど判定が誤差に強い。これが
   * 「低ボラを選ぶ」ことの厳密な根拠であり、「ドラッグを避けるため」ではない。
   * 逆に、実測で反転が少なかったとしても margin が1を切っていれば
   * **頑健だったのではなく反転しなかっただけ**である。ここを取り違えないこと。
   */
  margin1: number;
  margin2: number;
}

export interface FlipBucket {
  label: string;
  n: number;
  flipped: number;
  /** この群の平均的な壁の高さ */
  meanHurdle: number;
  /** この群の判定余裕（SE単位）の中央値。1未満なら「判定は誤差に飲まれている」 */
  medMargin: number;
}

export interface PersistenceResult {
  rows: PersistenceRow[];
  /**
   * 共通窓を確保するために除外した銘柄（上場が新しい順に落とす）。
   *
   * `alignReturns` は全銘柄の共通日付の積集合を取るので、共通窓は
   * **いちばん上場が新しい1銘柄**に律速される。以前はそこで EMPTY を返しており、
   * 285A.T（2024-12上場）を1つ入れるだけで窓が413日に潰れ、画面が
   * 「見出しだけの空箱」になっていた。落とした銘柄は必ず画面に出すこと。
   */
  excluded: string[];
  /** 各半分の年数 */
  halfYears: number;
  from1: string;
  to1: string;
  from2: string;
  to2: string;
  pearsonSigma: number;
  spearmanSigma: number;
  pearsonMu: number;
  spearmanMu: number;
  medAbsDSigma: number;
  medAbsDMu: number;
  /** σ の水準が全体としてどれだけ動いたか（順位が保たれても水準は動く） */
  medDSigma: number;
  /**
   * |Δμ| が「純粋な推定誤差だけで説明できる大きさ」の何倍か。
   * 2つの独立推定の差の SE は √(SE1²+SE2²) なので、その中央値との比を取る。
   * ≈1 なら μ の動きはノイズで説明できる。≫1 なら μ は本当に動いている。
   * **どちらでも「過去の μ は将来の μ を予測しない」という結論は変わらない。**
   */
  noiseRatio: number;
  nFlipped: number;
  /**
   * 判定余裕（SE単位）の中央値。**反転率と一緒に読むこと。**
   * 反転が少なくても medMargin が1未満なら「頑健だった」のではなく
   * 「たまたま反転しなかった」だけである。
   */
  medMargin: number;
  /** σ の中央値で低ボラ群/高ボラ群に割ったときの反転率と判定余裕 */
  buckets: FlipBucket[];
}

const EMPTY: PersistenceResult = {
  rows: [], excluded: [], halfYears: 0, from1: "", to1: "", from2: "", to2: "",
  pearsonSigma: NaN, spearmanSigma: NaN, pearsonMu: NaN, spearmanMu: NaN,
  medAbsDSigma: NaN, medAbsDMu: NaN, medDSigma: NaN, noiseRatio: NaN,
  nFlipped: 0, medMargin: NaN, buckets: [],
};

function median(a: number[]): number {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return NaN;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    sa += (a[i] - ma) ** 2;
    sb += (b[i] - mb) ** 2;
  }
  return sa > 0 && sb > 0 ? sab / Math.sqrt(sa * sb) : NaN;
}

/** 同順位は平均順位にする（同値が出ても順位相関が歪まないように）。 */
function ranks(x: number[]): number[] {
  const idx = x.map((v, i) => ({ v, i })).sort((p, q) => p.v - q.v);
  const r = new Array<number>(x.length);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1].v === idx[k].v) j++;
    const avg = (k + j) / 2 + 1;
    for (let m = k; m <= j; m++) r[idx[m].i] = avg;
    k = j + 1;
  }
  return r;
}

function spearman(a: number[], b: number[]): number {
  return pearson(ranks(a), ranks(b));
}

/** AlignedReturns の一部区間を切り出す。annualStats は tickers と returns しか見ない。 */
function slice(aligned: AlignedReturns, from: number, to: number): AlignedReturns {
  return {
    tickers: aligned.tickers,
    dates: aligned.dates.slice(from, to),
    returns: aligned.returns.map((r) => r.slice(from, to)),
    vols: aligned.vols,
  };
}

/**
 * 共通日付で整列してから前半/後半に割り、各銘柄の (σ, μ̂) がどう動いたかを返す。
 *
 * `minHalfDays` は片方の半分に必要な最低営業日数。短すぎる半分から出した σ・μ は
 * 比較に耐えないので、満たさない場合は空の結果を返す（1年=252日を既定とする）。
 */
export function muSigmaPersistence(
  data: { ticker: string; name?: string; prices: PricePoint[] }[],
  minHalfDays = TRADING_DAYS
): PersistenceResult {
  const series = data
    .filter((d) => d.prices && d.prices.length > 2)
    .map((d) => ({ ticker: d.ticker, prices: d.prices }));
  if (series.length < 3) return EMPTY;

  // 共通窓は「いちばん上場が新しい銘柄」に律速される。窓が足りない間、開始日が
  // 遅い銘柄から順に落として残りで成立させる（PersistenceResult.excluded 参照）。
  const excluded: string[] = [];
  let pool = [...series];
  let aligned = alignReturns(pool, Number.MAX_SAFE_INTEGER);
  while (pool.length > 3 && (aligned.returns[0]?.length ?? 0) < minHalfDays * 2) {
    let worst = 0;
    for (let i = 1; i < pool.length; i++) {
      if (pool[i].prices[0].time > pool[worst].prices[0].time) worst = i;
    }
    excluded.push(pool[worst].ticker);
    pool = pool.filter((_, i) => i !== worst);
    aligned = alignReturns(pool, Number.MAX_SAFE_INTEGER);
  }

  const T = aligned.returns[0]?.length ?? 0;
  if (aligned.tickers.length < 3 || T < minHalfDays * 2) return { ...EMPTY, excluded };

  const mid = Math.floor(T / 2);
  const a1 = annualStats(slice(aligned, 0, mid));
  const a2 = annualStats(slice(aligned, mid, T));
  const years1 = mid / TRADING_DAYS;
  const years2 = (T - mid) / TRADING_DAYS;

  const nameOf = new Map(data.map((d) => [d.ticker, d.name || d.ticker]));


  const rows: PersistenceRow[] = aligned.tickers.map((tk, i) => {
    const sigma1 = a1.vol[i];
    const sigma2 = a2.vol[i];
    const mu1 = a1.mu[i];
    const mu2 = a2.mu[i];
    const hurdle1 = (sigma1 * sigma1) / 2;
    const hurdle2 = (sigma2 * sigma2) / 2;
    const above1 = mu1 > hurdle1;
    const above2 = mu2 > hurdle2;
    return {
      ticker: tk,
      name: nameOf.get(tk) ?? tk,
      sigma1, sigma2, mu1, mu2, hurdle1, hurdle2,
      seMu1: years1 > 0 ? sigma1 / Math.sqrt(years1) : Infinity,
      seMu2: years2 > 0 ? sigma2 / Math.sqrt(years2) : Infinity,
      above1, above2,
      flipped: above1 !== above2,
      dSigma: sigma2 - sigma1,
      dMu: mu2 - mu1,
      margin1: years1 > 0 && sigma1 > 0 ? (mu1 - hurdle1) / (sigma1 / Math.sqrt(years1)) : NaN,
      margin2: years2 > 0 && sigma2 > 0 ? (mu2 - hurdle2) / (sigma2 / Math.sqrt(years2)) : NaN,
    };
  });

  const s1 = rows.map((r) => r.sigma1);
  const s2 = rows.map((r) => r.sigma2);
  const m1 = rows.map((r) => r.mu1);
  const m2 = rows.map((r) => r.mu2);

  // 純粋な推定誤差だけで期待される |Δμ| の大きさ（2つの独立推定の差）
  const noiseSd = rows.map((r) => Math.sqrt(r.seMu1 ** 2 + r.seMu2 ** 2));
  const medNoise = median(noiseSd);
  const medAbsDMu = median(rows.map((r) => Math.abs(r.dMu)));

  // σ の中央値で2群に割り、壁の高さと反転率の関係を見る
  const medSigma1 = median(s1);
  const low = rows.filter((r) => r.sigma1 <= medSigma1);
  const high = rows.filter((r) => r.sigma1 > medSigma1);
  const bucket = (label: string, g: PersistenceRow[]): FlipBucket => ({
    label,
    n: g.length,
    flipped: g.filter((r) => r.flipped).length,
    meanHurdle: g.length ? g.reduce((s, r) => s + r.hurdle1, 0) / g.length : NaN,
    medMargin: median(g.map((r) => r.margin1).filter((v) => isFinite(v))),
  });

  return {
    rows,
    excluded,
    halfYears: years1,
    from1: aligned.dates[0] ?? "",
    to1: aligned.dates[mid - 1] ?? "",
    from2: aligned.dates[mid] ?? "",
    to2: aligned.dates[T - 1] ?? "",
    pearsonSigma: pearson(s1, s2),
    spearmanSigma: spearman(s1, s2),
    pearsonMu: pearson(m1, m2),
    spearmanMu: spearman(m1, m2),
    medAbsDSigma: median(rows.map((r) => Math.abs(r.dSigma))),
    medAbsDMu,
    medDSigma: median(rows.map((r) => r.dSigma)),
    noiseRatio: medNoise > 0 ? medAbsDMu / medNoise : NaN,
    nFlipped: rows.filter((r) => r.flipped).length,
    medMargin: median(rows.map((r) => r.margin1).filter((v) => isFinite(v))),
    buckets: [bucket("低ボラ群（σ中央値以下）", low), bucket("高ボラ群（σ中央値超）", high)],
  };
}
