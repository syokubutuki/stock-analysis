// 2資産のリバランス／動的配分で、値動きそのものから超過リターンを取れるか
// ============================================================================
// 動機となった観察: 「銀行株と日経平均は逆相関に見える。銀行が上がる日は日経が下げ、
// 日経が上がる日は銀行が下げている。ならば上がったほうを売って下がったほうを買う
// だけで、ドリフトとは別に儲かるのではないか」。
//
// この直観は**ボラティリティ収穫（Shannon's demon / リバランス・プレミアム）**として
// 実在する。ただし本ファイルが測るのは「実在するか」ではなく**いくら取れるか**で、
// 答えは σ_diff² に対して線形・μ差に対して敗ける、という不等式に落ちる。
//
// ─────────────────────────────────────────────────────────────────────────────
// 【骨格1】リバランス・プレミアムは「相関」ではなく「差のボラ」で決まる
//
// 連続リバランス（常にウェイト w を維持）の幾何成長率は
//     g_rebal(w) = w·μ_A + (1−w)·μ_B − σ_p(w)²/2
// 各資産を単独で持ったときの幾何成長率の加重平均は
//     Σ w·g   = w·μ_A + (1−w)·μ_B − ½[ w·σ_A² + (1−w)·σ_B² ]
// 差を取ると μ が消えて分散だけが残る:
//
//     P(w) ≡ g_rebal(w) − Σ w·g
//          = ½[ w·σ_A² + (1−w)·σ_B² ] − ½·σ_p(w)²
//          = ½·w(1−w)·[ σ_A² + σ_B² − 2ρ·σ_A·σ_B ]
//          = ½·w(1−w)·σ_diff²                      ← σ_diff² = Var(r_A − r_B)
//
// つまり**リバランスで取れる分は、2資産の差のボラの2乗だけで決まる**。ρ が低いほど
// σ_diff が大きくなるので「相関が低いほど効く」は正しいが、効いているのは ρ 自体では
// なく σ_diff である。ρ=+0.6 でも σ_A, σ_B が大きければプレミアムは出るし、
// ρ=−1 でも2資産が同じ動きの鏡像で σ_diff が小さければ出ない。
//
// 【骨格2】放置（Buy&Hold）は「最良の1つ」へ収束する
//
// 買って放置した富は W_BH(T) = w·e^{g_A·T} + (1−w)·e^{g_B·T} なので
//     g_BH(T) = (1/T)·ln[ w·e^{g_A T} + (1−w)·e^{g_B T} ]  ─→  max(g_A, g_B)   (T→∞)
// 勝ったほうのウェイトが勝手に増えるからである。一方リバランスは定義上ウェイトを
// 戻し続けるので「混ぜたもの」へ収束する。したがって g_A > g_B のとき
//
//     放置の勝者ドリフト利得 = g_BH − Σ w·g  ─→  (1−w)·(g_A − g_B)   (T→∞)
//
// 【骨格3】ゆえに、リバランスが放置に勝つ条件は
//
//     ½·w(1−w)·σ_diff²  >  (1−w)·Δg     ⟺     **½·w·σ_diff² > Δg**
//                                        ⟺     **σ_diff > √(2Δg/w)**
//
// w=0.5 なら σ_diff > √(4·Δg) = 2√Δg。年率の幾何成長率の差が 9.5pp あるなら、
// 差のボラが 62% ないとリバランスは元が取れない。**プレミアムは Δg に対して
// 二次的に小さい**というのが本パネルの中心的な結論である。
//
// 【骨格4】動的配分に必要なのは σ ではなく μ の時変を当てること
//
// 「その日の値動きで最適に配分を変える」ルールが静的リバランスに勝つには、
// 配分の変化が**将来の μ の差**と相関していなければならない。σ の予測可能性
// （ボラのクラスタリング）は強いが、μ の予測可能性は弱い（`drift-identifiability.ts` /
// `mu-sigma-persistence.ts` の結論）。加えて全振り型のルールは年 100 回転を超えるため、
// 往復コスト c に対して年 τ·c を先に払う。ゆえに各ルールには
//   ① 静的リバランスとの差
//   ② そのルールが偶然の水準を超えているか（**巡回シフトによるランダマイゼーション検定**）
//   ③ 損益分岐コスト（これ以上のコストなら負ける c）
// の3つを必ず併記する。
//
// 【検定の作り方】巡回シフト・ヌル
// ルールが作ったウェイト列 w_t を、乱数で選んだオフセットぶん**巡回シフト**して
// リターンにぶつけ直す。ウェイトの周辺分布・自己相関・回転率をすべて保ったまま、
// 「リターンとの時間的な対応」だけを壊す。したがって
//     p = #{ シフト版の g ≥ 実測の g } / S
// は「このルールの中身（いつ乗り換えるか）が効いているか」だけを問う片側p値になる。
// 回転率やウェイトの偏りで自動的に有利／不利になる分はヌル側にも同じだけ入る。
//
// すべて純関数・O(S·T)（S=既定500, T≤2500）。Worker 不要。乱数はシード付き。

import { alignSeries } from "./benchmark";
import { normalCdf } from "./derivatives-core";
import { mean, quantileSorted, std, studentTwoSidedP } from "./stats-significance";
import { PricePoint } from "./types";
import { adfTest } from "./unit-root";
import { computeVarianceRatio } from "./variance-ratio";

export const TRADING_DAYS = 252;

// ───────────────────────── 仕様 ─────────────────────────

/** リバランスの頻度。`band` は乖離幅で発火する方式、`never` は買って放置。 */
export type RebalanceFreq = "daily" | "weekly" | "monthly" | "quarterly" | "yearly" | "band" | "never";

export const FREQ_LABEL: Record<RebalanceFreq, string> = {
  daily: "毎日",
  weekly: "毎週(5日)",
  monthly: "毎月(21日)",
  quarterly: "四半期(63日)",
  yearly: "毎年(252日)",
  band: "乖離バンド",
  never: "放置(B&H)",
};

/** 頻度 → 発火間隔（営業日）。`band` / `never` は間隔を持たない。 */
const FREQ_INTERVAL: Record<RebalanceFreq, number | null> = {
  daily: 1, weekly: 5, monthly: 21, quarterly: 63, yearly: 252, band: null, never: null,
};

export const FREQ_ORDER: RebalanceFreq[] = ["daily", "weekly", "monthly", "quarterly", "yearly", "band", "never"];

/** 動的配分ルール。`static` / `bh` は比較の基準であって「動的」ではない。 */
export type RuleKey =
  | "static"
  | "bh"
  | "contrarian"
  | "momentum"
  | "userSwitch"
  | "userSwitchInv"
  | "spreadZ"
  | "volParity"
  | "kelly";

export const RULE_ORDER: RuleKey[] = [
  "static", "bh", "contrarian", "momentum", "userSwitch", "userSwitchInv", "spreadZ", "volParity", "kelly",
];

export const RULE_LABEL: Record<RuleKey, string> = {
  static: "定期リバランス（基準）",
  bh: "買って放置（B&H）",
  contrarian: "逆張り全振り：前日負けた側へ100%",
  momentum: "順張り全振り：前日勝った側へ100%",
  userSwitch: "指数が上げた翌日は個別株へ100%",
  userSwitchInv: "指数が下げた翌日は個別株へ100%",
  spreadZ: "スプレッドz連動（連続配分）",
  volParity: "逆ボラ配分（リスクパリティ）",
  kelly: "ローリング平均分散（μ縮小つき）",
};

export const RULE_NOTE: Record<RuleKey, string> = {
  static: "指定した頻度でウェイトを w に戻すだけ。動的ルールはすべてこれに勝てるかで評価する。",
  bh: "初日に配分したあと一切触らない。勝った側のウェイトが自然に増えていく。",
  contrarian: "「上がったほうを売って下がったほうを買う」の極端版。前日のスプレッド符号だけで全額を移す。",
  momentum: "逆張りの鏡像。前日勝った側に全額を置く。逆張りが負けるならこちらが勝つはずという対照群。",
  userSwitch: "指数の前日の符号だけで切り替える。指数が上げた日の翌日に個別株へ乗り換える形。",
  userSwitchInv: "userSwitch の鏡像。どちらの向きが正しいかを事前に決めないための対照群。",
  spreadZ: "累積スプレッドの z スコアに比例して連続的に傾ける。全振りより回転率が低い。",
  volParity: "直近ボラの逆数で配分。μ を一切使わないので「σ だけで戦う」基準になる。",
  kelly: "直近窓の μ・Σ から g を最大化する w を解く。μ は共通平均へ縮小する（μ は識別しにくいため）。",
};

export interface RebalanceSpec {
  /** 資産A（＝検索中の銘柄）の目標ウェイト。0..1。 */
  weightA: number;
  /** 静的リバランスの頻度。 */
  freq: RebalanceFreq;
  /** `band` 方式で発火する乖離幅（絶対値、ウェイト単位）。 */
  bandPct: number;
  /** 往復コスト（比率）。資産を x だけ入れ替えると x·costRT を払う。 */
  costRT: number;
  /** 動的ルールの推定窓（営業日）。 */
  lookback: number;
  /** kelly の μ 縮小率。1 で μ 差を完全に無視（＝σ だけで配分）。 */
  shrinkMu: number;
  /** spreadZ の傾き。w = clip(w0 − zGain·z)。 */
  zGain: number;
  /** 巡回シフト・ヌルの反復数。 */
  nullDraws: number;
  /** 乱数シード。 */
  seed: number;
}

export const DEFAULT_REBALANCE_SPEC: RebalanceSpec = {
  weightA: 0.5,
  freq: "monthly",
  bandPct: 0.05,
  costRT: 0.002,
  lookback: 60,
  shrinkMu: 0.5,
  zGain: 0.5,
  nullDraws: 500,
  seed: 20260910,
};

// ───────────────────────── 結果の型 ─────────────────────────

/** 前提の検査。「逆相関だから儲かる」が成り立っているかを最初に確かめる。 */
export interface PairStats {
  n: number;
  years: number;
  from: string;
  to: string;
  /** 日次対数リターンの相関。 */
  rho: number;
  /** 相関の標準誤差と両側p（H0: ρ=0）。 */
  rhoSE: number;
  rhoP: number;
  /** A の B に対するβ。 */
  beta: number;
  /** 年率の算術平均リターン。 */
  muA: number;
  muB: number;
  /** 年率ボラ。 */
  sigmaA: number;
  sigmaB: number;
  /** 単独保有の幾何成長率（年率）。 */
  gA: number;
  gB: number;
  /** 差 r_A − r_B の年率ボラ。リバランス・プレミアムの唯一の原資。 */
  sigmaDiff: number;
  /** B が下げた日に A が上げた割合。「逆相関」の体感を数える。 */
  pAUpGivenBDown: number;
  pAUpGivenBUp: number;
  /** corr(r_A − r_B, r_B)。β<1 なら負になる＝「相対では逆に見える」正体。 */
  rhoSpreadVsB: number;
  /** ローリング窓での ρ。 */
  rollWindow: number;
  rhoRollMin: number;
  rhoRollMedian: number;
  rhoRollLast: number;
  rhoRollNegShare: number;
  /** 前日の B → 翌日のスプレッド。動的ルールの原資があるか。 */
  leadLagCorr: number;
  leadLagT: number;
  /** スプレッドの lag1 自己相関（正なら順張り、負なら逆張りが効く向き）。 */
  spreadAcf1: number;
  spreadAcf1T: number;
}

export interface RollingRhoRow {
  time: string;
  rho: number;
}

export interface SimStats {
  /** コスト控除後の年率幾何成長率。 */
  g: number;
  /** コスト控除前。 */
  gGross: number;
  /** 年率ボラ。 */
  vol: number;
  sharpe: number;
  /** 対数エクイティの最大下落幅（正値）。 */
  maxDD: number;
  /** 最終富（初期1）。 */
  finalWealth: number;
  /** 年間の入れ替え量 Σ|Δw| / 年。全振りルールは 1 回の切替で 1 進む。 */
  turnoverPerYear: number;
  /** 年率で払ったコスト（対数リターン単位、正値）。 */
  costAnnual: number;
}

export interface CurvePoint {
  time: string;
  value: number;
}

export interface SimRun {
  key: string;
  label: string;
  stats: SimStats;
  /** 累積対数リターン（コスト控除後）。 */
  equity: CurvePoint[];
  /** 各日の期首における A のウェイト。 */
  weights: CurvePoint[];
  /** 日次対数リターン（コスト控除後）。検定で使う。 */
  daily: number[];
}

/** リバランス・プレミアムの分解（骨格1〜3）。 */
export interface PremiumDecomposition {
  weightA: number;
  /** Σ w·g（単独保有の幾何成長率の加重平均）。 */
  blended: number;
  /** 理論プレミアム ½·w(1−w)·σ_diff²。 */
  theory: number;
  /** 実測の連続（毎日）リバランス − Σ w·g。 */
  measured: number;
  /** 実測の放置 − Σ w·g（＝勝者ドリフト利得）。 */
  bhDrift: number;
  /** T→∞ での勝者ドリフト利得 (1−w)·|Δg|（w は良いほうのウェイトに読み替える）。 */
  bhDriftAsymptotic: number;
  /** 毎日リバランス − 放置。正ならリバランスが勝っている。 */
  netVsBH: number;
  /** 勝つために必要な σ_diff = √(2·Δg / w_better)。実測 σ_diff と比べる。 */
  sigmaDiffRequired: number;
  /** 良いほうの資産（"A" | "B"）と Δg = |g_A − g_B|。 */
  better: "A" | "B";
  deltaG: number;
  /**
   * **長期（T→∞）で**リバランスが勝てるか（sigmaDiff > sigmaDiffRequired）。
   * 有限期間の勝敗は `netVsBH` の符号で、これとは一致しないことがある。
   */
  rebalanceWins: boolean;
  /**
   * 放置がリバランスを追い越す保有年数 T*。
   *
   * g_rebal は保有年数に依らない定数だが、g_BH(T) は max(g_A,g_B) へ**単調に増える**ので、
   * 長期で放置が負ける場合を除き必ず交点がある。ただし収束は指数関数の和の飽和なので
   * 非常に遅く、「長期では放置が勝つ」が実際の投資期間で成り立つとは限らない。
   * ここを出さないと、②のカードの判定（T→∞）と実測（有限期間）が矛盾して見える。
   *
   * `null` は長期でもリバランスが勝つ（交点なし）、`Infinity` は探索した 200 年内に
   * 追い越さない、という意味。
   */
  crossoverYears: number | null;
}

export interface FreqRow {
  freq: RebalanceFreq;
  stats: SimStats;
  /** 放置との差（コスト控除後、年率）。 */
  vsBH: number;
}

export interface WeightSweepRow {
  w: number;
  /** 毎日リバランスの実測 g。 */
  gRebal: number;
  /** 放置の実測 g。 */
  gBH: number;
  /** 選択中の頻度での実測 g。 */
  gFreq: number;
  /** Σ w·g。 */
  blended: number;
  /** 理論プレミアム。 */
  theory: number;
}

export interface RuleRow {
  key: RuleKey;
  label: string;
  note: string;
  stats: SimStats;
  /** 静的リバランスとの年率 g の差（コスト控除後）。 */
  vsStatic: number;
  /** 放置との年率 g の差（コスト控除後）。 */
  vsBH: number;
  /** 静的リバランスとの Sharpe 差の JKM 片側p（H1: ルール > 静的）。 */
  jkmZ: number | null;
  jkmP: number | null;
  /** 巡回シフト・ヌルの片側p（H1: 実測 g がシフト版より大きい）。 */
  nullP: number | null;
  /** ヌル分布の中央値 g と 95% 上側。 */
  nullMedian: number | null;
  nullHi: number | null;
  /** ヌル分布（描画用、最大400点にダウンサンプル）。 */
  nullSample: number[];
  /**
   * これ以上のコストなら静的リバランスに負ける往復コスト。
   * 負なら**コストがゼロでも既に負けている**、Infinity なら回転率で負けていない、
   * NaN は基準自身（比較対象がない）。
   */
  breakevenCostRT: number;
}

/**
 * 「β<1 だから、指数が上げる日は相対的に負け、下げる日は相対的に勝つ」という構造から
 * 収益を取りにいく経路を、全部同じ土俵で測る。
 *
 * **最初に潰しておくこと。** corr(r_A − r_B, r_B) < 0 それ自体は収益源ではない。
 * これは β<1 の言い換えにすぎず、平均リターンについて何も言っていない。この構造を
 * 「使う」には〈指数が下げる日〉を事前に知る必要があり、それが分かるなら指数を
 * 空売りすればよいので、この経路は予測不可能性の壁の向こう側にある。
 * ここで測るのは、**予測を要求しない**形に組み替えたときに何が残るか、である。
 *
 * 分解 r_A = α + β·r_B + ε を土台に置くと、経路は次の6つに尽きる:
 *
 *   ① α を取りにいく（β調整ロング・ショート ＝ 低βレバレッジ / BAB）
 *      … 市場を消して α + ε だけ残す。原資は α。空売りコストが分岐点を作る。
 *   ② 素朴な1:1ペア（A買い・B売り）
 *      … β を無視するので (β−1)·r_B が残り、市場に対して純ショートが混じる。
 *   ③ 相対の平均回帰（ペアトレード）
 *      … 対数比 ln(A/B) が定常で、かつ半減期が短ければ乖離を売買できる。
 *        原資は**平均回帰そのもの**で、6つのうちこれだけが「相対で動く」を直接換金する。
 *   ④ 非対称β（下方βが上方βより小さいか）
 *      … 下げでだけ β が小さいなら、g = μ − σ²/2 の σ² 側を非対称に削れる。
 *   ⑤ ヘッジ比率の適正化
 *      … 1単位ヘッジは (1−β) だけ過剰ヘッジ。新しい収益ではなく**取りこぼしの回収**。
 *   ⑥ リバランス・プレミアムへの寄与
 *      … σ_diff² = (β−1)²σ_B² + σ_ε²。β<1 が σ_diff をどれだけ押し上げているか。
 */
export interface RelativeRoutes {
  /**
   * 市場モデル r_A = α + β·r_B + ε の β。**単利リターンで推定する。**
   *
   * `PairStats.beta`（対数リターン ρ·σ_A/σ_B）とは 0.01 程度ずれる。どちらも正しいが、
   * ここでは 1/β 単位ロング・1 単位ショートという**建玉比率をそのまま使う**ので、
   * 富の合成と同じ単位（単利）で推定した β でなければならない。
   */
  beta: number;

  // ① β調整ロング・ショート（＝BAB）
  /** α = μ_A − β·μ_B（年率、算術）。 */
  alphaAnn: number;
  alphaT: number;
  alphaP: number;
  /** 残差ボラ σ_ε（年率）。 */
  residVol: number;
  /** 情報比 α/σ_ε。 */
  infoRatio: number;
  /** BAB 形式（A を 1/β 単位ロング・B を 1 単位ショート）の年率リターンと Sharpe。 */
  babAnn: number;
  babVol: number;
  babSharpe: number;
  /**
   * 総キャリーの分岐点（年率）。BAB は B を 1 単位ショート・A を 1/β 単位ロングするので、
   * 「貸株料＋逆日歩（B の 1 単位ぶん）」と「買方金利（A の 1/β 単位ぶん）」の合計が
   * これを超えると収益が消える。**空売り料だけと比べると過小評価になる。**
   */
  carryBreakeven: number;

  // ② 素朴な1:1ペア
  pairAnn: number;
  pairVol: number;
  pairSharpe: number;
  pairT: number;
  /** 1:1 ペアに残る市場エクスポージャー β−1。負なら実質的に指数ショートを抱えている。 */
  residualBeta: number;

  // ③ 相対の平均回帰（ペアトレード）
  /** 対数比 ln(A/B) をトレンド除去した残差に対する ADF（定常なら平均回帰）。 */
  adfStat: number;
  adfP: number;
  adfStationary: boolean;
  /** AR(1) 係数 φ と、そこから出る半減期（営業日）。φ≥1 なら null。 */
  ouPhi: number;
  halfLifeDays: number | null;
  /**
   * スプレッド日次リターンの分散比 VR(q)。1未満なら平均回帰の向き。
   *
   * **ただし判定には使わない。** Lo–MacKinlay の分散頑健 z はこの用途では検出力が無く、
   * φ=0.97（半減期23日）の OU を植え込んで ADF=−5.6 が出る標本でも VR の z は −0.5 程度に
   * しかならない。有意性をゲートにすると本物の平均回帰まで否決してしまうので、
   * ここでは**傾向を見るための記述統計**として持つに留める（q が増えるにつれ 1 から
   * 下へ離れていくか）。
   */
  vr: { q: number; vr: number; z: number; significant: boolean }[];
  /**
   * 平均回帰があるか。**定常であること（ADF）と、半減期が実務的な長さであること**の連言。
   * 定常でも半減期が数年なら、建玉を寝かせる期間が長すぎて戦略として成立しない。
   */
  meanReverting: boolean;
  /** `meanReverting` の閾値（営業日）。半減期がこれを超えたら取引可能とみなさない。 */
  halfLifeLimitDays: number;

  // ④ 非対称β
  /** B が下げた日／上げた日それぞれの β。 */
  betaDown: number;
  betaUp: number;
  /** β⁻ − β⁺ の t と両側p（交互作用ダミー回帰）。負に有意なら下げで鈍い＝望ましい。 */
  betaAsymT: number;
  betaAsymP: number;

  // ⑤ ヘッジ比率の適正化
  /** 1単位ヘッジしたときに捨てている年率リターン (1−β)·μ_B。 */
  overHedgeCostAnn: number;

  // ⑥ σ_diff への寄与
  /** β=1 だったときの σ_diff（＝σ_ε）。 */
  sigmaDiffAtBeta1: number;
  /** β<1 が σ_diff を押し上げている分（年率、実測 − σ_ε）。 */
  sigmaDiffLift: number;
}

export interface RebalanceResult {
  pair: PairStats;
  routes: RelativeRoutes;
  rollingRho: RollingRhoRow[];
  decomposition: PremiumDecomposition;
  freqRows: FreqRow[];
  weightSweep: WeightSweepRow[];
  ruleRows: RuleRow[];
  /** 描画用のエクイティ曲線（A単独 / B単独 / 静的 / 放置 / 選択中の動的ルール）。 */
  curves: SimRun[];
  /** 選択中の動的ルール（curves の最後）。 */
  selectedRule: RuleKey;
  spec: RebalanceSpec;
}

// ───────────────────────── 小道具 ─────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (!(da > 0) || !(db > 0)) return 0;
  return num / Math.sqrt(da * db);
}

function clip(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ───────────────────────── シミュレータ ─────────────────────────

/**
 * 配分方針。`i` 期（i−1 の引け → i の引け）に持つ A のウェイトを返す。
 * `drifted` は前期のリターンで自然に動いたあとのウェイトで、これをそのまま返せば
 * 「何もしない（放置）」になる。**i−1 までの情報しか使ってはいけない。**
 */
type Policy = (i: number, drifted: number) => number;

interface SimCore {
  daily: number[];
  equity: CurvePoint[];
  weights: CurvePoint[];
  turnover: number;
  costLog: number;
}

/**
 * 2資産の富の推移。
 *   富:      W ← W · (1 + w·rA + (1−w)·rB) · (1 − |Δw|·c)
 *   ウェイト: w' ← w·(1+rA) / (1 + w·rA + (1−w)·rB)
 * コストは比例なので対数空間で厳密に引ける（strategy-vs-benchmark.ts と同じ規約）。
 * 入れ替え量 |Δw| は「A を |Δw| 売って B を |Δw| 買う」＝ notional |Δw| の1往復。
 */
function simulate(
  rA: number[], rB: number[], times: string[], policy: Policy, costRT: number, w0: number
): SimCore {
  const T = rA.length;
  const daily: number[] = [];
  const equity: CurvePoint[] = [];
  const weights: CurvePoint[] = [];
  let cum = 0, turnover = 0, costLog = 0;
  let drifted = w0;
  for (let i = 0; i < T; i++) {
    const target = clip(policy(i, drifted), -1, 2);
    const dw = Math.abs(target - drifted);
    turnover += dw;
    const cost = costRT > 0 && dw > 0 ? -Math.log(1 - Math.min(0.5, dw * costRT)) : 0;
    costLog += cost;
    const gross = target * rA[i] + (1 - target) * rB[i];
    // 全振り＋大きな下落で富が消える組み合わせは、対数が発散する前に打ち切る
    const growth = Math.max(1e-8, 1 + gross);
    const r = Math.log(growth) - cost;
    cum += r;
    daily.push(r);
    equity.push({ time: times[i], value: cum });
    weights.push({ time: times[i], value: target });
    drifted = growth > 1e-8 ? (target * (1 + rA[i])) / growth : target;
  }
  return { daily, equity, weights, turnover, costLog };
}

function statsOf(core: SimCore): SimStats {
  const n = core.daily.length;
  if (n === 0) {
    return { g: 0, gGross: 0, vol: 0, sharpe: 0, maxDD: 0, finalWealth: 1, turnoverPerYear: 0, costAnnual: 0 };
  }
  const years = n / TRADING_DAYS;
  let sum = 0;
  for (const v of core.daily) sum += v;
  const vol = std(core.daily) * Math.sqrt(TRADING_DAYS);
  let cumv = 0, peak = 0, maxDD = 0;
  for (const v of core.daily) {
    cumv += v;
    if (cumv > peak) peak = cumv;
    const dd = peak - cumv;
    if (dd > maxDD) maxDD = dd;
  }
  const g = sum / years;
  return {
    g,
    gGross: (sum + core.costLog) / years,
    vol,
    sharpe: vol > 0 ? g / vol : 0,
    maxDD,
    finalWealth: Math.exp(sum),
    turnoverPerYear: core.turnover / years,
    costAnnual: core.costLog / years,
  };
}

/** 指定頻度でウェイトを w へ戻すだけの方針。 */
function staticPolicy(freq: RebalanceFreq, w: number, band: number): Policy {
  const interval = FREQ_INTERVAL[freq];
  if (freq === "never") return (_i, drifted) => drifted;
  if (freq === "band") return (_i, drifted) => (Math.abs(drifted - w) > band ? w : drifted);
  const k = interval ?? 1;
  return (i, drifted) => (i % k === 0 ? w : drifted);
}

// ───────────────────────── 動的ルール ─────────────────────────

interface RuleInputs {
  rA: number[];
  rB: number[];
  /** 対数リターンのスプレッド ln(1+rA) − ln(1+rB)。 */
  spread: number[];
  spec: RebalanceSpec;
}

/**
 * ルールごとの方針を作る。**すべて i−1 までの情報しか読まない**（`spread[i-1]` まで）。
 * 立ち上がり（窓が埋まるまで）は静的ウェイト w に落とす。
 */
function rulePolicy(key: RuleKey, inp: RuleInputs): Policy {
  const { rA, rB, spread, spec } = inp;
  const w = spec.weightA;
  const L = Math.max(10, Math.round(spec.lookback));

  switch (key) {
    case "static":
      return staticPolicy(spec.freq, w, spec.bandPct);
    case "bh":
      return (_i, drifted) => drifted;
    case "contrarian":
      return (i) => (i === 0 ? w : spread[i - 1] < 0 ? 1 : 0);
    case "momentum":
      return (i) => (i === 0 ? w : spread[i - 1] > 0 ? 1 : 0);
    case "userSwitch":
      return (i) => (i === 0 ? w : rB[i - 1] > 0 ? 1 : 0);
    case "userSwitchInv":
      return (i) => (i === 0 ? w : rB[i - 1] < 0 ? 1 : 0);
    case "spreadZ":
      return (i) => {
        if (i < L) return w;
        // 直近 L 日の累積スプレッドを、その分布の中で z 化する
        const win = spread.slice(i - L, i);
        const m = mean(win), s = std(win);
        if (!(s > 0)) return w;
        let cum = 0;
        for (let k = Math.max(0, i - Math.round(L / 4)); k < i; k++) cum += spread[k];
        const nEff = Math.min(i, Math.round(L / 4));
        const z = (cum - m * nEff) / (s * Math.sqrt(Math.max(1, nEff)));
        return clip(w - spec.zGain * z * w, 0, 1);
      };
    case "volParity":
      return (i) => {
        if (i < L) return w;
        const sa = std(rA.slice(i - L, i)), sb = std(rB.slice(i - L, i));
        if (!(sa > 0) || !(sb > 0)) return w;
        return clip((1 / sa) / (1 / sa + 1 / sb), 0, 1);
      };
    case "kelly":
      return (i) => {
        if (i < L) return w;
        const a = rA.slice(i - L, i), b = rB.slice(i - L, i);
        const ma = mean(a), mb = mean(b);
        const sa = std(a), sb = std(b);
        if (!(sa > 0) || !(sb > 0)) return w;
        const rho = corr(a, b);
        const varDiff = sa * sa + sb * sb - 2 * rho * sa * sb;
        if (!(varDiff > 1e-12)) return w;
        // μ は識別しにくいので共通平均へ縮小する（shrinkMu=1 で μ 差を捨てる）
        const grand = (ma + mb) / 2;
        const k = clip(spec.shrinkMu, 0, 1);
        const muA = ma + (grand - ma) * k;
        const muB = mb + (grand - mb) * k;
        const wStar = (muA - muB + sb * sb - rho * sa * sb) / varDiff;
        return clip(wStar, 0, 1);
      };
  }
}

// ───────────────────────── 検定 ─────────────────────────

/**
 * JKM の Sharpe 差検定（片側 H1: a > b）。
 * θ = (1/T)[2(1−ρ) + ½(SRa² + SRb² − 2·SRa·SRb·ρ²)]、z = (SRa−SRb)/√θ。
 * （vol-targeting.ts / weekday-vs-bh.ts と同じ式）
 */
function jkmSharpeDiff(a: number[], b: number[]): { z: number | null; p: number | null } {
  const T = Math.min(a.length, b.length);
  if (T <= 30) return { z: null, p: null };
  const ma = mean(a), mb = mean(b), sa = std(a), sb = std(b);
  if (!(sa > 0) || !(sb > 0)) return { z: null, p: null };
  let cov = 0;
  for (let i = 0; i < T; i++) cov += (a[i] - ma) * (b[i] - mb);
  cov /= T - 1;
  const rho = cov / (sa * sb);
  const sra = ma / sa, srb = mb / sb;
  const theta = (1 / T) * (2 * (1 - rho) + 0.5 * (sra * sra + srb * srb - 2 * sra * srb * rho * rho));
  if (!(theta > 0)) return { z: null, p: null };
  const z = (sra - srb) / Math.sqrt(theta);
  return { z, p: 1 - normalCdf(z) };
}

/**
 * 巡回シフト・ヌル。ウェイト列を丸ごと回してリターンにぶつけ直す。
 * 周辺分布・自己相関・回転率は保存され、**リターンとの時間対応だけ**が壊れる。
 */
function circularShiftNull(
  weights: number[], rA: number[], rB: number[], costRT: number, draws: number, seed: number
): { median: number; hi: number; sample: number[] } | null {
  const T = weights.length;
  if (T < 60 || draws < 20) return null;
  // ウェイトがほぼ動かないルール（静的リバランス・放置）では、巡回シフトしても
  // 同じ配分を同じ期間に当てているだけなので、この検定は何も問うていない。
  if (std(weights) < 0.02) return null;
  const rng = mulberry32(seed);
  const years = T / TRADING_DAYS;
  const out: number[] = [];
  for (let d = 0; d < draws; d++) {
    const off = 1 + Math.floor(rng() * (T - 1));
    let cum = 0, prev = weights[(off - 1 + T) % T];
    for (let i = 0; i < T; i++) {
      const wt = weights[(i + off) % T];
      const dw = Math.abs(wt - prev);
      prev = wt;
      const cost = costRT > 0 && dw > 0 ? -Math.log(1 - Math.min(0.5, dw * costRT)) : 0;
      cum += Math.log(Math.max(1e-8, 1 + wt * rA[i] + (1 - wt) * rB[i])) - cost;
    }
    out.push(cum / years);
  }
  if (out.length < 20) return null;
  const sorted = out.slice().sort((x, y) => x - y);
  return {
    median: quantileSorted(sorted, 0.5),
    hi: quantileSorted(sorted, 0.95),
    sample: sorted,
  };
}

/**
 * 損益分岐往復コスト。コスト以外は同じなので、g の差はコスト項の差だけで動く:
 *   g(c) = g_gross − (Σ|Δw| / years) · (−ln(1 − c)) ≒ g_gross − turnover·c
 * ルールと基準の g が一致する c を1次で解く（c は小さいので線形近似で十分）。
 * 分母が 0 以下（回転率がルール側で小さい）なら「コストでは負けない」＝ Infinity。
 */
function breakevenCost(ruleGross: number, ruleTurnover: number, baseGross: number, baseTurnover: number): number {
  const dTurn = ruleTurnover - baseTurnover;
  const dGross = ruleGross - baseGross;
  if (!(dTurn > 1e-9)) return dGross >= 0 ? Infinity : -Infinity;
  return dGross / dTurn;
}

/**
 * 放置の幾何成長率がリバランスを追い越す保有年数 T* を探す。
 *   g_BH(T) = (1/T)·ln[ w·e^(g_A·T) + (1−w)·e^(g_B·T) ]
 * は T について単調増加で max(g_A,g_B) へ収束するので、g_rebal がその上限より
 * 小さければ交点がただ1つある。指数がオーバーフローしないよう、良いほうの
 * 成長率を括り出してから log-sum-exp で評価する。
 */
function bhOvertakeYears(w: number, gA: number, gB: number, gRebal: number): number | null {
  const gMax = Math.max(gA, gB);
  if (gRebal >= gMax) return null; // 長期でもリバランスが勝つ（交点なし）
  const gBH = (T: number): number => {
    if (!(T > 0)) return 0;
    // ln[w·e^(gA·T) + (1−w)·e^(gB·T)] = gMax·T + ln[w·e^((gA−gMax)T) + (1−w)·e^((gB−gMax)T)]
    const inner = w * Math.exp((gA - gMax) * T) + (1 - w) * Math.exp((gB - gMax) * T);
    return gMax + (inner > 0 ? Math.log(inner) / T : 0);
  };
  const HI = 200;
  if (gBH(HI) < gRebal) return Infinity; // 200年でも追い越さない
  let lo = 1e-3, hi = HI;
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (gBH(mid) < gRebal) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}


// ───────────────────── β<1 の構造から収益を取る経路 ─────────────────────

/** 切片つき単回帰 y = a + b·x。t 値まで返す。 */
function ols1(x: number[], y: number[]): { a: number; b: number; bT: number; aT: number; resid: number[] } {
  const n = Math.min(x.length, y.length);
  const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  const b = sxx > 0 ? sxy / sxx : 0;
  const a = my - b * mx;
  const resid: number[] = [];
  for (let i = 0; i < n; i++) resid.push(y[i] - a - b * x[i]);
  const df = Math.max(1, n - 2);
  let sse = 0;
  for (const e of resid) sse += e * e;
  const s2 = sse / df;
  const seB = sxx > 0 ? Math.sqrt(s2 / sxx) : Infinity;
  const seA = Math.sqrt(s2 * (1 / n + (mx * mx) / (sxx > 0 ? sxx : Infinity)));
  return { a, b, bT: seB > 0 ? b / seB : 0, aT: seA > 0 ? a / seA : 0, resid };
}

/**
 * 「相対では逆に動く」構造から収益を取りにいく6つの経路を、同じ標本で測る。
 * 入力は単利リターン（富の合成に使う量）と対数リターン（統計に使う量）の両方。
 */
function computeRelativeRoutes(
  rA: number[], rB: number[], lA: number[], lB: number[], pair: PairStats
): RelativeRoutes {
  const T = rA.length;
  const D = TRADING_DAYS;

  // ① α と残差（市場モデル r_A = α + β·r_B + ε を単利で推定）
  const mkt = ols1(rB, rA);
  const beta = mkt.b;
  const alphaAnn = mkt.a * D;
  const residVol = std(mkt.resid) * Math.sqrt(D);
  // α の t は日次回帰の切片の t（自己相関は小さいので OLS の se をそのまま使う）
  const alphaT = mkt.aT;
  const alphaP = studentTwoSidedP(alphaT, Math.max(1, T - 2));
  const infoRatio = residVol > 0 ? alphaAnn / residVol : 0;

  // BAB: A を 1/β 単位・B を 1 単位ショート ⇒ 市場βは (1/β)·β − 1 = 0
  const k = Math.abs(beta) > 1e-6 ? 1 / beta : 0;
  const bab: number[] = [];
  for (let i = 0; i < T; i++) bab.push(k * rA[i] - rB[i]);
  const babAnn = mean(bab) * D;
  const babVol = std(bab) * Math.sqrt(D);
  // ロング 1/β 単位＋ショート 1 単位を賄うキャリーの上限。片側だけと比べないこと。
  const carryBreakeven = babAnn;

  // ② 素朴な1:1ペア（β を無視するので β−1 の市場エクスポージャーが残る）
  const pairR: number[] = [];
  for (let i = 0; i < T; i++) pairR.push(rA[i] - rB[i]);
  const pairAnn = mean(pairR) * D;
  const pairVol = std(pairR) * Math.sqrt(D);
  const pairT = pairVol > 0 ? (pairAnn / pairVol) * Math.sqrt(T / D) : 0;

  // ③ 相対の平均回帰。対数比 x_t = ln(A_t/B_t) は強いトレンドを持つので、
  //    まず時間トレンドを外し、その残差に ADF と AR(1) を当てる（ペアトレードの標準手順）。
  const x: number[] = [];
  let cum = 0;
  for (let i = 0; i < T; i++) { cum += lA[i] - lB[i]; x.push(cum); }
  const tIdx = x.map((_, i) => i);
  const detr = ols1(tIdx, x).resid;
  const adf = adfTest(detr);
  const ar = ols1(detr.slice(0, -1), detr.slice(1));
  const ouPhi = ar.b;
  const halfLifeDays = ouPhi > 0 && ouPhi < 1 ? Math.log(2) / -Math.log(ouPhi) : null;
  const vrRes = computeVarianceRatio(pairR.map((_, i) => lA[i] - lB[i]));
  const vr = vrRes.points.map((p) => ({ q: p.q, vr: p.vr, z: p.zStat, significant: p.significant }));
  // 「平均回帰がある」＝ADF が定常を言い、**かつ半減期が1年以内**。
  // VR の有意性はゲートにしない（上の doc コメントのとおり検出力が無い）。
  const halfLifeLimitDays = TRADING_DAYS;
  const meanReverting =
    adf.isStationary && halfLifeDays !== null && halfLifeDays <= halfLifeLimitDays;

  // ④ 非対称β。r_A = a + b·r_B + c·(r_B·1{r_B<0}) + … の交互作用項で β⁻−β⁺ を直接検定する。
  //    2変数回帰になるので、交互作用項を r_B の残差へ直交化してから単回帰にする
  //    （Frisch–Waugh–Lovell。単回帰の道具のまま正しい t が出る）。
  const inter = rB.map((v) => (v < 0 ? v : 0));
  const interOrth = ols1(rB, inter).resid;
  const asym = ols1(interOrth, mkt.resid);
  const betaDownMinusUp = asym.b;
  const betaAsymT = asym.bT;
  const betaAsymP = studentTwoSidedP(betaAsymT, Math.max(1, T - 3));
  const down: number[] = [], downA: number[] = [], up: number[] = [], upA: number[] = [];
  for (let i = 0; i < T; i++) {
    if (rB[i] < 0) { down.push(rB[i]); downA.push(rA[i]); }
    else { up.push(rB[i]); upA.push(rA[i]); }
  }
  const betaDown = down.length > 10 ? ols1(down, downA).b : beta;
  const betaUp = up.length > 10 ? ols1(up, upA).b : beta;
  void betaDownMinusUp;

  // ⑤ 1単位ヘッジの過剰分 (1−β)·μ_B
  const overHedgeCostAnn = (1 - beta) * pair.muB;

  // ⑥ σ_diff² = (β−1)²σ_B² + σ_ε²。β=1 なら σ_ε だけが残る。
  const sigmaDiffAtBeta1 = residVol;
  const sigmaDiffLift = pair.sigmaDiff - sigmaDiffAtBeta1;

  return {
    beta,
    alphaAnn, alphaT, alphaP, residVol, infoRatio,
    babAnn, babVol, babSharpe: babVol > 0 ? babAnn / babVol : 0, carryBreakeven,
    pairAnn, pairVol, pairSharpe: pairVol > 0 ? pairAnn / pairVol : 0, pairT,
    residualBeta: beta - 1,
    adfStat: adf.testStat, adfP: adf.pValue, adfStationary: adf.isStationary,
    ouPhi, halfLifeDays, vr, meanReverting, halfLifeLimitDays,
    betaDown, betaUp, betaAsymT, betaAsymP,
    overHedgeCostAnn,
    sigmaDiffAtBeta1, sigmaDiffLift,
  };
}

// ───────────────────────── 入口 ─────────────────────────

/**
 * 資産A（検索中の銘柄）と資産B（相方＝既定は指数）の2資産で、
 * リバランス・プレミアムと動的配分ルールを丸ごと評価する。
 */
export function computeRebalance(
  pricesA: PricePoint[],
  pricesB: PricePoint[],
  spec: RebalanceSpec,
  selectedRule: RuleKey = "contrarian"
): RebalanceResult | null {
  if (pricesA.length < 120 || pricesB.length < 120) return null;
  const { stock: A, bench: B } = alignSeries(pricesA, pricesB);
  if (A.length < 120) return null;

  // 単利リターン（富の合成に使う）と対数リターン（統計に使う）を両方持つ
  const rA: number[] = [], rB: number[] = [], lA: number[] = [], lB: number[] = [], times: string[] = [];
  for (let i = 1; i < A.length; i++) {
    const a0 = A[i - 1].close, a1 = A[i].close, b0 = B[i - 1].close, b1 = B[i].close;
    if (!(a0 > 0) || !(a1 > 0) || !(b0 > 0) || !(b1 > 0)) continue;
    rA.push(a1 / a0 - 1);
    rB.push(b1 / b0 - 1);
    lA.push(Math.log(a1 / a0));
    lB.push(Math.log(b1 / b0));
    times.push(A[i].time);
  }
  const T = rA.length;
  if (T < 120) return null;
  const years = T / TRADING_DAYS;
  const spread = lA.map((v, i) => v - lB[i]);

  // ───── 前提の検査 ─────
  const rho = corr(lA, lB);
  const sigmaA = std(lA) * Math.sqrt(TRADING_DAYS);
  const sigmaB = std(lB) * Math.sqrt(TRADING_DAYS);
  const muA = mean(rA) * TRADING_DAYS;
  const muB = mean(rB) * TRADING_DAYS;
  const gA = mean(lA) * TRADING_DAYS;
  const gB = mean(lB) * TRADING_DAYS;
  const sigmaDiff = std(spread) * Math.sqrt(TRADING_DAYS);
  const rhoSE = T > 3 ? (1 - rho * rho) / Math.sqrt(T - 1) : NaN;
  const rhoZ = rhoSE > 0 ? rho / rhoSE : 0;
  const bDown = lA.filter((_, i) => lB[i] < 0);
  const bUp = lA.filter((_, i) => lB[i] > 0);
  const leadLag = corr(lB.slice(0, -1), spread.slice(1));
  const acf1 = corr(spread.slice(0, -1), spread.slice(1));

  const rollWindow = 60;
  const rollingRho: RollingRhoRow[] = [];
  for (let i = rollWindow; i <= T; i++) {
    rollingRho.push({ time: times[i - 1], rho: corr(lA.slice(i - rollWindow, i), lB.slice(i - rollWindow, i)) });
  }
  const rollVals = rollingRho.map((r) => r.rho).sort((x, y) => x - y);

  const pair: PairStats = {
    n: T,
    years,
    from: times[0],
    to: times[T - 1],
    rho,
    rhoSE,
    rhoP: 2 * (1 - normalCdf(Math.abs(rhoZ))),
    beta: std(lB) > 0 ? (rho * std(lA)) / std(lB) : 0,
    muA, muB, sigmaA, sigmaB, gA, gB, sigmaDiff,
    pAUpGivenBDown: bDown.length > 0 ? bDown.filter((v) => v > 0).length / bDown.length : 0,
    pAUpGivenBUp: bUp.length > 0 ? bUp.filter((v) => v > 0).length / bUp.length : 0,
    rhoSpreadVsB: corr(spread, lB),
    rollWindow,
    rhoRollMin: rollVals.length > 0 ? rollVals[0] : 0,
    rhoRollMedian: rollVals.length > 0 ? quantileSorted(rollVals, 0.5) : 0,
    rhoRollLast: rollingRho.length > 0 ? rollingRho[rollingRho.length - 1].rho : 0,
    rhoRollNegShare: rollVals.length > 0 ? rollVals.filter((v) => v < 0).length / rollVals.length : 0,
    leadLagCorr: leadLag,
    leadLagT: leadLag * Math.sqrt(T),
    spreadAcf1: acf1,
    spreadAcf1T: acf1 * Math.sqrt(T),
  };

  const routes = computeRelativeRoutes(rA, rB, lA, lB, pair);

  // ───── 分解（骨格1〜3）─────
  const w = clip(spec.weightA, 0, 1);
  const dailyCore = simulate(rA, rB, times, staticPolicy("daily", w, spec.bandPct), spec.costRT, w);
  const bhCore = simulate(rA, rB, times, staticPolicy("never", w, spec.bandPct), spec.costRT, w);
  const blended = w * gA + (1 - w) * gB;
  const theory = 0.5 * w * (1 - w) * sigmaDiff * sigmaDiff;
  const better: "A" | "B" = gA >= gB ? "A" : "B";
  const deltaG = Math.abs(gA - gB);
  const wBetter = better === "A" ? w : 1 - w;
  const sigmaDiffRequired = wBetter > 1e-6 ? Math.sqrt((2 * deltaG) / wBetter) : Infinity;
  const dailyG = statsOf(dailyCore).g;
  const crossoverYears = bhOvertakeYears(w, gA, gB, dailyG);
  const decomposition: PremiumDecomposition = {
    weightA: w,
    blended,
    theory,
    measured: statsOf(dailyCore).g - blended,
    bhDrift: statsOf(bhCore).g - blended,
    bhDriftAsymptotic: (1 - wBetter) * deltaG,
    netVsBH: statsOf(dailyCore).g - statsOf(bhCore).g,
    sigmaDiffRequired,
    better,
    deltaG,
    rebalanceWins: sigmaDiff > sigmaDiffRequired,
    crossoverYears,
  };

  // ───── 頻度の掃引 ─────
  const bhStats = statsOf(bhCore);
  const freqRows: FreqRow[] = FREQ_ORDER.map((f) => {
    const core = f === "daily" ? dailyCore : f === "never" ? bhCore
      : simulate(rA, rB, times, staticPolicy(f, w, spec.bandPct), spec.costRT, w);
    const st = statsOf(core);
    return { freq: f, stats: st, vsBH: st.g - bhStats.g };
  });

  // ───── ウェイトの掃引 ─────
  const weightSweep: WeightSweepRow[] = [];
  for (let k = 0; k <= 20; k++) {
    const wk = k / 20;
    const d = statsOf(simulate(rA, rB, times, staticPolicy("daily", wk, spec.bandPct), spec.costRT, wk));
    const h = statsOf(simulate(rA, rB, times, staticPolicy("never", wk, spec.bandPct), spec.costRT, wk));
    const f = statsOf(simulate(rA, rB, times, staticPolicy(spec.freq, wk, spec.bandPct), spec.costRT, wk));
    weightSweep.push({
      w: wk,
      gRebal: d.g,
      gBH: h.g,
      gFreq: f.g,
      blended: wk * gA + (1 - wk) * gB,
      theory: 0.5 * wk * (1 - wk) * sigmaDiff * sigmaDiff,
    });
  }

  // ───── 動的ルール ─────
  const inputs: RuleInputs = { rA, rB, spread, spec };
  const runs = new Map<RuleKey, { core: SimCore; stats: SimStats }>();
  for (const key of RULE_ORDER) {
    const core = key === "bh" ? bhCore
      : key === "static" && spec.freq === "daily" ? dailyCore
      : simulate(rA, rB, times, rulePolicy(key, inputs), spec.costRT, w);
    runs.set(key, { core, stats: statsOf(core) });
  }
  const base = runs.get("static")!;

  const ruleRows: RuleRow[] = RULE_ORDER.map((key, idx) => {
    const run = runs.get(key)!;
    const jkm = key === "static" ? { z: null, p: null } : jkmSharpeDiff(run.core.daily, base.core.daily);
    const wSeq = run.core.weights.map((p) => p.value);
    const nul = circularShiftNull(wSeq, rA, rB, spec.costRT, spec.nullDraws, spec.seed + idx * 977);
    let nullP: number | null = null;
    if (nul) {
      const ge = nul.sample.filter((v) => v >= run.stats.g).length;
      nullP = (ge + 1) / (nul.sample.length + 1);
    }
    // ヌル分布は描画用に最大400点へ間引く
    const sample = nul ? (nul.sample.length <= 400 ? nul.sample
      : nul.sample.filter((_, i) => i % Math.ceil(nul.sample.length / 400) === 0)) : [];
    return {
      key,
      label: RULE_LABEL[key],
      note: RULE_NOTE[key],
      stats: run.stats,
      vsStatic: run.stats.g - base.stats.g,
      vsBH: run.stats.g - bhStats.g,
      jkmZ: jkm.z,
      jkmP: jkm.p,
      nullP,
      nullMedian: nul ? nul.median : null,
      nullHi: nul ? nul.hi : null,
      nullSample: sample,
      breakevenCostRT: key === "static" ? NaN : breakevenCost(
        run.stats.gGross, run.stats.turnoverPerYear, base.stats.gGross, base.stats.turnoverPerYear
      ),
    };
  });

  // ───── 描画する曲線 ─────
  const onlyA = simulate(rA, rB, times, () => 1, 0, 1);
  const onlyB = simulate(rA, rB, times, () => 0, 0, 0);
  const staticRun = runs.get("static")!;
  const selRun = runs.get(selectedRule)!;
  const curves: SimRun[] = [
    { key: "onlyA", label: "資産A 単独", stats: statsOf(onlyA), equity: onlyA.equity, weights: onlyA.weights, daily: onlyA.daily },
    { key: "onlyB", label: "資産B 単独", stats: statsOf(onlyB), equity: onlyB.equity, weights: onlyB.weights, daily: onlyB.daily },
    { key: "bh", label: RULE_LABEL.bh, stats: bhStats, equity: bhCore.equity, weights: bhCore.weights, daily: bhCore.daily },
    { key: "static", label: `${FREQ_LABEL[spec.freq]}リバランス`, stats: staticRun.stats, equity: staticRun.core.equity, weights: staticRun.core.weights, daily: staticRun.core.daily },
    { key: selectedRule, label: RULE_LABEL[selectedRule], stats: selRun.stats, equity: selRun.core.equity, weights: selRun.core.weights, daily: selRun.core.daily },
  ];

  return { pair, routes, rollingRho, decomposition, freqRows, weightSweep, ruleRows, curves, selectedRule, spec };
}
