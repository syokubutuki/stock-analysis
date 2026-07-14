// 株式原論「合流点」エンジン ─ 全系(Corollary)を単一の建玉 q に還元する。
//
// docs/investment-axioms.md の核心: 我々が選べるのは価格 P ではなく建玉 q(t) だけ。
// 各分析(=P の記述)は、符号・大きさ・タイミング・保有期間のいずれかを通じて
// q へ翻訳されて初めて価値を持つ(命題4)。
//
// 本エンジンは、価格系列という「P の記述」を入力に取り、各系が示す寄与を計算し、
// それらを単一の推奨 q(符号/大きさ/タイミング/期間)に畳み込む。
// 各寄与は元の系 ID にトレースできる(UI で系カードへリンクする)。
//
// 設計思想: ここは「予測」をしない。命題1に従い、価格系列の構造(自己相関・ボラ・
// テール・暦依存)そのものが q の各成分を決める。予測精度ではなく Cov(q,dP) の構造が源泉。

import { PricePoint } from "../types";
import { kellyOptimal } from "../kelly-bs";
import { computeVarianceRatio } from "../variance-ratio";
import { runStrategyTrades, type Side } from "../weekday-trade";
import { representativeSpread } from "../spread-estimator";
import { tTest, benjaminiHochberg } from "../stats-significance";
import { fitHMM } from "../regime";

/** q の4自由度(+摩擦)。docs/investment-axioms.md 公準2。 */
export type QDimension = "sign" | "size" | "timing" | "horizon" | "friction";

export const DIMENSION_LABEL: Record<QDimension, string> = {
  sign: "符号（買/売/無）",
  size: "大きさ（資本比率 |q|）",
  timing: "タイミング（建てる/外す）",
  horizon: "保有期間",
  friction: "摩擦（コスト控除）",
};

/** 単一系からの寄与。UI は corollaryId で系カードへリンクする。 */
export interface QContribution {
  corollaryId: string; // "C1" など
  dimension: QDimension;
  theory: string; // 系の理論名(短縮)
  /** この系が計算した値の表示(例: "f* = 0.42")。 */
  value: string;
  /** その値が q をどう動かすかの一行説明。 */
  detail: string;
}

/** 畳み込まれた最終推奨 q。 */
export interface QRecommendation {
  sign: -1 | 0 | 1;
  signLabel: string; // ロング / ショート / 不参加
  /** 最終的な資本比率 |q|(0..)。sign=0 なら 0。 */
  sizeFraction: number;
  /** 大きさを決めた律速要因("Kelly" or "VaR上限" or "成長率ガード")。 */
  sizeBinding: string;
  /** タイミング(例: "火曜寄り建て → 金曜引け")。 */
  timingLabel: string;
  /** 最適保有期間(営業日)。 */
  horizonDays: number;
  /** 1往復あたり期待リターン(摩擦控除後、対数)。 */
  netEdgePerTrip: number;
  /** 摩擦控除後にエッジが消える(q=0推奨)なら true。 */
  frictionWarn: boolean;
  /** 使ったコスト仮定(1往復, 対数)。 */
  assumedCost: number;
  /** 最適比率での期待対数成長率(年率, C21)。 */
  expectedGrowth: number;
  /** 現在レジームのラベル(C17, HMM 最尤状態)。 */
  regimeLabel: string;
  /** レジーム確信度 max(π)∈[1/K,1](C17)。サイズ縮小率に使う。 */
  regimeConfidence: number;
  /** 曜日エッジが FDR<0.10 を生き残ったか(C9)。 */
  timingSignificant: boolean;
  contributions: QContribution[];
  /** capstone: この提案が命題4上どう正当化されるかの一文。 */
  note: string;
}

// --- 補助関数 -------------------------------------------------------------

/** 終値から日次対数リターンを作る。 */
function logReturns(prices: PricePoint[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1].close;
    const p1 = prices[i].close;
    if (p0 > 0 && p1 > 0) r.push(Math.log(p1 / p0));
  }
  return r;
}

function mean(a: number[]): number {
  let s = 0;
  for (const x of a) s += x;
  return a.length ? s / a.length : 0;
}

function std(a: number[], m: number): number {
  if (a.length < 2) return 0;
  let s = 0;
  for (const x of a) s += (x - m) ** 2;
  return Math.sqrt(s / (a.length - 1));
}

/** 下側 α 分位点(例 α=0.05)を返す(損失側なので通常は負)。 */
function quantile(a: number[], alpha: number): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(alpha * s.length)));
  return s[idx];
}

/** 任意ラグ h の分散比 VR(h)=Var(Σ_h r)/(h·Var(r))。重複窓で推定。 */
function varianceRatioAt(returns: number[], h: number): number {
  const n = returns.length;
  if (h <= 1 || n < h + 10) return 1;
  const m1 = mean(returns);
  let v1 = 0;
  for (const r of returns) v1 += (r - m1) ** 2;
  v1 /= n - 1;
  if (v1 <= 0) return 1;

  // 重複 h 期間和
  const sums: number[] = [];
  let running = 0;
  for (let i = 0; i < returns.length; i++) {
    running += returns[i];
    if (i >= h) running -= returns[i - h];
    if (i >= h - 1) sums.push(running);
  }
  const mh = mean(sums);
  let vh = 0;
  for (const s of sums) vh += (s - mh) ** 2;
  vh /= sums.length - 1;
  return vh / (h * v1);
}

// --- メイン: 系を単一 q に畳み込む ---------------------------------------

const FALLBACK_ROUND_TRIP_COST = 0.001; // 推定不能時のみ: 1往復 10bps

export function synthesizeQ(
  prices: PricePoint[],
  opts?: { costPerTrip?: number; tHurdle?: number; varBudget?: number }
): QRecommendation | null {
  const returns = logReturns(prices);
  if (returns.length < 120) return null;

  // C10: 取引コストを日足の高安から実推定(Corwin-Schultz は片道割合 → 往復は 2 倍)。
  const oneWaySpread = representativeSpread(prices);
  const estimatedCost =
    oneWaySpread > 0 && isFinite(oneWaySpread)
      ? 2 * oneWaySpread
      : FALLBACK_ROUND_TRIP_COST;
  const cost = opts?.costPerTrip ?? estimatedCost;
  const tHurdle = opts?.tHurdle ?? 1.0; // C16: エッジが SE の何倍でロバストか
  const varBudget = opts?.varBudget ?? 0.02; // C6: 1日 VaR 予算 2%

  const contributions: QContribution[] = [];

  const muDaily = mean(returns);
  const sigDaily = std(returns, muDaily);
  const n = returns.length;

  // ---- 符号(sign): C8/C4/C12 ────────────────────────────────────────
  // 価格自身の自己相関構造(分散比)がトレンド系か回帰系かを決め、それが符号の規則を決める。
  // 予測ではなく構造。エッジが有意でなければ不参加(命題3・公理3)。
  const vrRes = computeVarianceRatio(returns);
  const vr5 = vrRes.points.find((p) => p.q === 5)?.vr
    ?? vrRes.points.find((p) => p.q >= 4)?.vr
    ?? 1;

  const lookback = 20;
  const trail = returns.slice(-lookback);
  const trailSum = trail.reduce((a, b) => a + b, 0);

  // ドリフトの t 値(C16 ロバスト・ハードル)
  const tStat = sigDaily > 0 ? (muDaily * Math.sqrt(n)) / sigDaily : 0;

  let sign: -1 | 0 | 1 = 0;
  let signRule = "";
  if (vr5 > 1.05) {
    // モメンタム: 直近トレンドに順張り
    sign = trailSum > 0 ? 1 : trailSum < 0 ? -1 : 0;
    signRule = `分散比 VR(5)=${vr5.toFixed(2)}>1（モメンタム）→ 直近${lookback}日トレンドに順張り`;
  } else if (vr5 < 0.95) {
    // 平均回帰: 直近トレンドに逆張り(C4)
    sign = trailSum > 0 ? -1 : trailSum < 0 ? 1 : 0;
    signRule = `分散比 VR(5)=${vr5.toFixed(2)}<1（平均回帰）→ 直近${lookback}日に逆張り（C4）`;
  } else {
    // ランダムウォーク近傍: ドリフトの有意性のみで判定
    sign = tStat > tHurdle ? 1 : tStat < -tHurdle ? -1 : 0;
    signRule = `VR(5)≈1（構造なし）→ ドリフト t=${tStat.toFixed(2)}、|t|>${tHurdle} でのみ建玉`;
  }
  // C16: どの規則でも、駆動統計が弱すぎるなら不参加へ倒す
  if (sign !== 0 && Math.abs(tStat) < tHurdle && vr5 > 0.95 && vr5 < 1.05) {
    sign = 0;
  }

  contributions.push({
    corollaryId: vr5 < 0.95 ? "C4" : "C12",
    dimension: "sign",
    theory: vr5 < 0.95 ? "平均回帰トレード" : "条件付き戦略Φ",
    value: sign === 1 ? "ロング (+)" : sign === -1 ? "ショート (−)" : "不参加 (0)",
    detail: signRule,
  });
  contributions.push({
    corollaryId: "C16",
    dimension: "sign",
    theory: "ロバスト最適化",
    value: `t = ${tStat.toFixed(2)}`,
    detail:
      Math.abs(tStat) < tHurdle
        ? `ドリフトの t 値が閾値 ${tHurdle} 未満。エッジを誤差ぶん割り引くと符号は自信を持てない。`
        : `t 値が閾値 ${tHurdle} を超過。エッジは推定誤差に対して頑健。`,
  });

  // ---- レジーム信念(C17): 符号のゲート + サイズの縮小 ────────────────
  // HMM の現時点の状態確率 π を信念とし、信念加重ドリフト μ̄=Σπ_k·μ_k を見る。
  // 確信が薄い(遷移期)ほどサイズを縮め、信念が提案符号と食い違うなら不参加へ倒す。
  let regimeConfidence = 1;
  let regimeLabel = "単一レジーム";
  if (returns.length >= 200) {
    const hmm = fitHMM(returns, 3);
    const probs = hmm.stateProbabilities;
    const pi = probs[probs.length - 1] ?? [];
    if (pi.length > 0) {
      regimeConfidence = Math.max(...pi);
      const top = pi.indexOf(regimeConfidence);
      regimeLabel = hmm.stateLabels[top] ?? `状態${top}`;
      const beliefDrift = pi.reduce((s, p, k) => s + p * (hmm.stateMeans[k] ?? 0), 0);
      const conflict =
        sign !== 0 &&
        Math.sign(beliefDrift) === -sign &&
        Math.abs(beliefDrift) > 0.1 * sigDaily;
      contributions.push({
        corollaryId: "C17",
        dimension: "sign",
        theory: "レジーム切替下のΦ",
        value: `${regimeLabel}（確信 ${(regimeConfidence * 100).toFixed(0)}%）`,
        detail: conflict
          ? "信念加重ドリフトが提案符号と逆。遷移期の矛盾として不参加に倒す（q=0）。"
          : `確信 ${(regimeConfidence * 100).toFixed(0)}% をサイズ縮小率に反映（遷移期ほど建玉を絞る）。`,
      });
      if (conflict) sign = 0;
    }
  }

  // ---- 大きさ(size): C1/C14 → C15 → C6 → C21 ───────────────────────
  const kelly = kellyOptimal(returns);
  const kellyF = Math.abs(kelly.kellyFraction);
  const halfKelly = kellyF / 2; // C15: fractional Kelly(実務の安全側)

  // C6: VaR 上限。1日 5% VaR(単位建玉あたりの損失)で予算を割る。
  const var5 = -quantile(returns, 0.05); // 正の損失量
  const varCap = var5 > 0 ? varBudget / var5 : Infinity;

  let size = Math.min(halfKelly, varCap) * regimeConfidence; // C17: 遷移期に縮小
  let sizeBinding = halfKelly <= varCap ? "半Kelly（C15）" : "VaR上限（C6）";
  if (regimeConfidence < 0.95) {
    sizeBinding += ` ×レジーム確信${(regimeConfidence * 100).toFixed(0)}%（C17）`;
  }
  if (sign === 0) {
    size = 0;
    sizeBinding = "不参加のため 0";
  }

  // C21: 成長率ガード。選んだ f で g=f·μ−½f²σ²>0 を確認。
  const g = size * muDaily * sign - 0.5 * size * size * sigDaily * sigDaily;
  const gAnnual = g * 252;

  contributions.push({
    corollaryId: "C1",
    dimension: "size",
    theory: "Kelly 基準",
    value: `f* = ${kelly.kellyFraction.toFixed(2)}（年率μ=${(kelly.mu * 100).toFixed(0)}%, σ=${(kelly.sigma * 100).toFixed(0)}%）`,
    detail: `連続 Kelly f*=μ/σ²。実務は半Kelly ${halfKelly.toFixed(2)} から出発（C15）。`,
  });
  contributions.push({
    corollaryId: "C6",
    dimension: "size",
    theory: "VaR/CVaR 上限",
    value: `|q|_max = ${varCap === Infinity ? "∞" : varCap.toFixed(2)}`,
    detail: `1日5%VaR=${(var5 * 100).toFixed(1)}%。予算${(varBudget * 100).toFixed(0)}%で割ると建玉上限。${
      halfKelly > varCap ? "→ これが律速。" : "→ 半Kelly側が律速。"
    }`,
  });
  contributions.push({
    corollaryId: "C21",
    dimension: "size",
    theory: "非エルゴード性",
    value: `g = ${(gAnnual * 100).toFixed(1)}%/年`,
    detail:
      gAnnual > 0
        ? "選んだ大きさで期待対数成長率は正。時間平均で複利が伸びる。"
        : "期待対数成長率が非正。この大きさは長期で資本を減らす → 縮小すべき。",
  });

  // ---- タイミング(timing): C9 + FDR 補正 ───────────────────────────
  // 25通り(建て曜日×外し曜日)を総当たりし、各セルのトレード列に t 検定 → BH で FDR 補正。
  // FDR<0.10 を生き残ったセルのうち最良のみ採用(組合せ爆発による偽エッジを排除)。
  const side: Side = sign === -1 ? "short" : "long";
  const DOW = ["月", "火", "水", "木", "金"];
  type Cell = { e: number; x: number; edge: number; p: number; n: number };
  const cells: Cell[] = [];
  for (let e = 1; e <= 5; e++) {
    for (let x = 1; x <= 5; x++) {
      const trades = runStrategyTrades(prices, {
        entryDow: e, entryTiming: "open", exitDow: x, exitTiming: "close", side,
      });
      if (trades.length < 5) continue;
      const rets = trades.map((t) => t.ret);
      const tt = tTest(rets);
      if (!tt) continue;
      const edge = rets.reduce((a, b) => a + b, 0) / rets.length;
      cells.push({ e, x, edge, p: tt.p, n: rets.length });
    }
  }
  const adj = benjaminiHochberg(cells.map((c) => c.p));
  const sigCells = cells
    .map((c, i) => ({ ...c, q: adj[i] }))
    .filter((c) => c.q < 0.1 && c.edge > 0)
    .sort((a, b) => b.edge - a.edge);
  const bestCell = sigCells[0];
  const timingSignificant = !!bestCell;
  const timingLabel = bestCell
    ? `${DOW[bestCell.e - 1]}曜寄り建て → ${DOW[bestCell.x - 1]}曜引け`
    : "有意な曜日エッジなし（FDR後）→ 常時保有";
  contributions.push({
    corollaryId: "C9",
    dimension: "timing",
    theory: "カレンダー/曜日エッジ",
    value: timingLabel,
    detail: bestCell
      ? `${side}側25セル中 ${sigCells.length} セルが FDR<0.10 で有意。最良は ${(bestCell.edge * 100).toFixed(2)}%/往復（補正p=${bestCell.q.toFixed(3)}, n=${bestCell.n}）。`
      : `${side}側25セルを BH 補正すると有意なし。曜日 timing でエッジは取れない（多重検定を生き残らず）。`,
  });

  // ---- 保有期間(horizon): C8 ──────────────────────────────────────
  const horizons = [1, 2, 3, 5, 8, 13, 21];
  let bestH = 1, bestScore = -Infinity;
  for (const h of horizons) {
    const vr = varianceRatioAt(returns, h);
    if (vr <= 0) continue;
    const score = h / vr; // IR(h) ∝ √(h/VR(h)) の単調変換
    if (score > bestScore) {
      bestScore = score;
      bestH = h;
    }
  }
  const vrAtBest = varianceRatioAt(returns, bestH);
  contributions.push({
    corollaryId: "C8",
    dimension: "horizon",
    theory: "最適保有期間",
    value: `h* = ${bestH}営業日`,
    detail: `分散比 VR(${bestH})=${vrAtBest.toFixed(2)}。${
      vrAtBest < 1 ? "回帰的で長く持つほど効率的。" : vrAtBest > 1 ? "モメンタム的で短期が有利。" : "ほぼランダムウォーク。"
    }`,
  });

  // ---- 摩擦(friction): C10/命題5 ──────────────────────────────────
  const grossPerTrip = Math.abs(muDaily) * bestH; // 1往復の粗エッジ(概算)
  const netEdgePerTrip = grossPerTrip - cost;
  const frictionWarn = netEdgePerTrip <= 0;
  contributions.push({
    corollaryId: "C10",
    dimension: "friction",
    theory: "取引コスト/無取引帯",
    value: `純エッジ = ${(netEdgePerTrip * 100).toFixed(2)}%/往復`,
    detail: `粗エッジ ${(grossPerTrip * 100).toFixed(2)}% − コスト ${(cost * 100).toFixed(2)}%（Corwin-Schultz 実効スプレッド×2、片道${(oneWaySpread * 100).toFixed(2)}%）。${
      frictionWarn ? "摩擦負け → 建玉を持たない方がよい（命題5）。" : "エッジがコストを上回る。"
    }`,
  });

  const signLabel = sign === 1 ? "ロング" : sign === -1 ? "ショート" : "不参加";

  return {
    sign,
    signLabel,
    sizeFraction: frictionWarn ? 0 : size,
    sizeBinding: frictionWarn ? "摩擦負けのため 0" : sizeBinding,
    timingLabel,
    horizonDays: bestH,
    netEdgePerTrip,
    frictionWarn,
    assumedCost: cost,
    expectedGrowth: gAnnual,
    regimeLabel,
    regimeConfidence,
    timingSignificant,
    contributions,
    note:
      sign === 0 || frictionWarn
        ? "この銘柄は現在、符号か摩擦の関門で建玉ゼロが最適。分析はすべて『P の記述』にとどまり、q を動かす価値を生んでいない（命題4）。不参加もまた一つの決定。"
        : `全系が指す q は「${signLabel}・資本比率${(size * 100).toFixed(0)}%・${timingLabel}・${bestH}日保有」。各分析は独立に P を記述するが、その価値はこの単一の q への翻訳でのみ確定する（命題4）。`,
  };
}
