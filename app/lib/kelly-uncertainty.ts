// 最適建玉 f* の「決まらなさ」を測る層。
//
// ## なぜこのファイルがあるか
//
// `kelly-bs.ts` の `kellyOptimal()` は実測 μ をそのまま f* = μ/σ² に入れて**点推定を1つ**返す。
// これは σ が小さい銘柄では無害だが、高ボラ・短期上場の銘柄で実害になる。
//
//   285A.T（キオクシア, 2024-12上場, 1.6年）: μ̂=268% / σ=103%
//     → f* = 254%（「信用2.5倍で買え」）
//     → 95%CI は 105% 〜 404%
//     → 将来 μ=10% と置けば f* = 9.5%
//   同じ銘柄・同じ σ で、**f\* が 26倍動く**。動かしているのは σ ではなく μ である。
//
// μ̂ は `ln(P_T/P_0)/T` という**両端2点の恒等式**なので、観測頻度を上げても精度は
// 1ミリも改善しない（`drift-identifiability.ts` の系C26）。一方 σ̂ は本数 n で
// `σ/√(2n)` と縮む。この非対称性が f* の不確かさの正体である。
//
// ## このファイルが足す2つの量
//
// 1. **壁**: g > 0 ⟺ μ > σ²/2。σ² で伸びるので高ボラ銘柄ほど高い。**正確に測れる。**
// 2. **誤差棒**: SE(μ̂) = σ/√T。**壁より長いことが多い。**
//
// 誤差棒が壁より長いなら「この銘柄は複利で増える」は**測定では主張できない**。
// そのとき残るのは「複利がプラスになるために信じなければならない年率 σ²/2 はいくつか」
// という問いだけで、これは誰でも判定できる（`requiredBelief`）。
//
// 数値の土台は `holding-ledger.ts` の `seriesStats()` を共有する。
// 同じページに並ぶ `sim-kelly` と `sim-holding-ledger` の μ・σ・壁が食い違わないため。

import { PricePoint } from "./types";
import { TRADING_DAYS, doublingYears } from "./growth-drag";
import { requiredYears } from "./drift-identifiability";
import type { SeriesStats } from "./holding-ledger";

export { requiredYears };

// ───────────────────────── ケリーの一点 ─────────────────────────

export interface KellyPoint {
  /** 前提として使った年率算術平均リターン */
  mu: number;
  /** f* = μ/σ²。g(f) を最大化する建玉倍率 */
  fStar: number;
  /** 半ケリー。成長率をほとんど落とさずに変動を大きく減らす実務解 */
  halfKelly: number;
  /** g(f*) = μ²/(2σ²) */
  gAtFStar: number;
  /** 建玉1（現物フル）のときの g = μ − σ²/2 */
  gAtOne: number;
  /** g(f)=0 に戻る建玉 f = 2μ/σ²。これ以上は増やすほど減る */
  ruinF: number;
  /** f* での倍化年数 */
  doublingAtFStar: number;
}

export function kellyAt(mu: number, sigma: number): KellyPoint {
  const s2 = sigma * sigma;
  if (!(s2 > 0) || !isFinite(mu)) {
    return { mu, fStar: 0, halfKelly: 0, gAtFStar: 0, gAtOne: 0, ruinF: 0, doublingAtFStar: Infinity };
  }
  const fStar = mu / s2;
  const gAtFStar = (mu * mu) / (2 * s2);
  return {
    mu,
    fStar,
    halfKelly: fStar / 2,
    gAtFStar,
    gAtOne: mu - s2 / 2,
    ruinF: 2 * fStar,
    doublingAtFStar: doublingYears(gAtFStar),
  };
}

/** g(f) = μf − σ²f²/2。横軸 f の静的曲線（時間軸ではないので Canvas2D で描く）。 */
export function growthAtF(mu: number, sigma: number, f: number): number {
  return mu * f - (sigma * sigma * f * f) / 2;
}

// ───────────────────────── 壁と誤差棒 ─────────────────────────

export interface WallAndError {
  /** 越えるべき壁 σ²/2。「複利がプラスになるために信じる必要がある年率」 */
  hurdle: number;
  muHat: number;
  seMu: number;
  /** SE(σ̂) ≈ σ/√(2n)。μ 側と比べて桁違いに小さいことを示すために持つ */
  seSigma: number;
  /** μ の精度が σ の精度の何倍粗いか */
  precisionRatio: number;
  /** (μ̂ − σ²/2)/SE(μ̂) */
  t: number;
  ciLo: number;
  ciHi: number;
  /**
   * **誤差棒（SE）が壁の高さより大きいか。**
   *
   * これは「壁を越えたと言えない」こととは**別の主張**なので混同しないこと。
   * 壁を越えたと言えるかは CI が壁をまたぐか（`ciCrossesWall`）で決まる。
   * こちらが意味するのは「g = μ − σ²/2 の推定誤差が壁そのものより大きい」＝
   * **増えるかどうかは言えても、どれだけ増えるかは決まっていない**、である。
   * f* = μ/σ² が数倍の幅で動くのはこの状態のときである。
   */
  errorExceedsWall: boolean;
  /** 95%CI が壁をまたぐか（＝有意に越えているとは言えない） */
  ciCrossesWall: boolean;
  /** 標本が短く、t 値を額面どおり読めないか（1レジームしか見ていない可能性） */
  shortSample: boolean;
  /**
   * 判定。`errorExceedsWall` 単独で「主張できない」と言うのは誤り
   * （t=2.66・CIが壁をまたがない状態でも SE>壁 は起こる）。
   */
  verdict: "below" | "undecidable" | "aboveButImprecise" | "above";
}

/** t 値を額面どおり読める最低年数。これ未満は「1つの相場つきしか見ていない」とみなす。 */
const MIN_YEARS_FOR_T = 3;

export function wallAndError(s: SeriesStats, z = 1.96): WallAndError {
  const seSigma = s.n > 1 ? s.sigma / Math.sqrt(2 * s.n) : Infinity;
  const ciLo = s.muArith - z * s.seMu;
  const ciHi = s.muArith + z * s.seMu;
  const errorExceedsWall = s.seMu > s.hurdle;
  const ciCrossesWall = ciLo <= s.hurdle && ciHi >= s.hurdle;
  const verdict: WallAndError["verdict"] =
    ciHi < s.hurdle
      ? "below"
      : ciCrossesWall
        ? "undecidable"
        : errorExceedsWall
          ? "aboveButImprecise"
          : "above";
  return {
    hurdle: s.hurdle,
    muHat: s.muArith,
    seMu: s.seMu,
    seSigma,
    precisionRatio: seSigma > 0 && isFinite(seSigma) ? s.seMu / seSigma : Infinity,
    t: s.tHurdle,
    ciLo,
    ciHi,
    errorExceedsWall,
    ciCrossesWall,
    shortSample: s.years < MIN_YEARS_FOR_T,
    verdict,
  };
}

/**
 * 「複利がプラスだと主張するために信じなければならない年率」＝ 壁そのもの。
 * σ=25% なら 3.1%、σ=65% なら 21.1%。**σ の二乗で伸びる**ので、
 * 高ボラ銘柄を正当化するには、誰も検証できない大きな見通しを信じる必要がある。
 */
export function requiredBelief(sigma: number): number {
  return (sigma * sigma) / 2;
}

/**
 * 真の μ が muBelief だったとして、μ > σ²/2 を有意水準 κ で示すのに必要な年数。
 * `drift-identifiability.ts` の `requiredYears` に委譲する（両パネルで式を揃えるため）。
 * muBelief が壁以下なら Infinity（どれだけ待っても示せない）。
 */
export function yearsToResolve(muBelief: number, sigma: number, kappa = 2): number {
  const excess = muBelief - requiredBelief(sigma);
  if (!(excess > 0)) return Infinity;
  return requiredYears(sigma, excess, kappa);
}

// ───────────────────────── 頻度ラダー（Merton の非対称性） ─────────────────────────

export interface FrequencyRow {
  /** 何営業日を1本に集計したか */
  days: number;
  label: string;
  nObs: number;
  /** 年率**対数**ドリフト。集計頻度によらず同じ値になる（両端2点の恒等式） */
  muLogAnn: number;
  /** SE(μ̂) = σ/√T。T は暦年数なので、これも集計頻度によらず同じ */
  seMuAnn: number;
  sigmaAnn: number;
  /** SE(σ̂) ≈ σ/√(2n)。本数が減るので**集計するほど粗くなる** */
  seSigmaAnn: number;
}

/**
 * 同じ期間を 1/5/21/63 日に集計し直して、μ̂ と σ̂ の精度がどう変わるかを並べる。
 *
 * **μ̂ と SE(μ̂) は行をまたいで動かない。** これが Merton の非対称性であり、
 * 「もっと細かく見れば期待リターンが分かる」が成立しないことの直接の証拠になる。
 * 動くのは σ̂ の精度だけ（本数が減るので粗くなる）。
 */
export function frequencyLadder(prices: PricePoint[], blocks = [1, 5, 21, 63]): FrequencyRow[] {
  const logR: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const a = prices[i - 1].close;
    const b = prices[i].close;
    if (a > 0 && b > 0) logR.push(Math.log(b / a));
  }
  const years = logR.length / TRADING_DAYS;
  if (logR.length < 2 || years <= 0) return [];

  // 本数が少なすぎる行は載せない。285A.T（1.6年）の 63日集計は n=6 になり、
  // σ̂ が 75%〜119% と暴れて SE(μ̂) がむしろ「良く」見える（見かけの改善）。
  // 非対称性を示すための表が、標本不足のノイズで逆の印象を与えてしまう。
  const MIN_BLOCKS = 20;
  return blocks
    .filter((k) => Math.floor(logR.length / k) >= MIN_BLOCKS)
    .map((k) => {
      // k 日ごとに畳む。端数は落とす（両端2点の恒等式が崩れない範囲で）。
      const agg: number[] = [];
      for (let i = 0; i + k <= logR.length; i += k) {
        let s = 0;
        for (let j = i; j < i + k; j++) s += logR[j];
        agg.push(s);
      }
      const n = agg.length;
      const mean = agg.reduce((a, b) => a + b, 0) / n;
      let ss = 0;
      for (const v of agg) ss += (v - mean) ** 2;
      const sdBlock = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
      const periodsPerYear = TRADING_DAYS / k;
      const sigmaAnn = sdBlock * Math.sqrt(periodsPerYear);
      // 実際に覆っている暦年数（端数を落とした分だけ短い）
      const coveredYears = (n * k) / TRADING_DAYS;
      return {
        days: k,
        label: k === 1 ? "日次" : `${k}日集計`,
        nObs: n,
        muLogAnn: mean * periodsPerYear,
        seMuAnn: coveredYears > 0 ? sigmaAnn / Math.sqrt(coveredYears) : Infinity,
        sigmaAnn,
        seSigmaAnn: n > 1 ? sigmaAnn / Math.sqrt(2 * n) : Infinity,
      };
    });
}

// ───────────────────────── f* の感度表 ─────────────────────────

export interface SensitivityRow {
  key: string;
  label: string;
  /** この行が「測定された値」ではなく前提であることを示す */
  assumed: boolean;
  point: KellyPoint;
}

/**
 * μ の前提を差し替えたときに f* がどこまで動くかの表。
 * **σ は一切動かさない。** 動いているのが μ だけであることを見せるのがこの表の目的。
 */
export function sensitivityRows(s: SeriesStats, belief: number): SensitivityRow[] {
  const rows: SensitivityRow[] = [
    { key: "hat", label: `実測 μ̂`, assumed: false, point: kellyAt(s.muArith, s.sigma) },
    { key: "lo", label: `μ̂ − 1SE`, assumed: false, point: kellyAt(s.muArith - s.seMu, s.sigma) },
    { key: "hi", label: `μ̂ + 1SE`, assumed: false, point: kellyAt(s.muArith + s.seMu, s.sigma) },
    { key: "belief", label: "あなたの前提", assumed: true, point: kellyAt(belief, s.sigma) },
  ];
  return rows;
}
