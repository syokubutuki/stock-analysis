// タイミング判断の価値検定 (SPA / Reality Check)
// -------------------------------------------------------------
// 「週内クロックや過去の値動き軌跡を見てトレードのタイミングを決めること」に
// 統計的な裏付けがあるかを、個別ルールではなく「ルール一族(ファミリー)」の
// レベルで検定する。
//
// 既存の検証層との分担:
//   - ヌル較正(null-calibration): 曜日"構造"が存在するか(F検定)と偽発見の床
//   - アナログOOS(weekly-analog-oos): 予測器の情報係数(IC)
//   - 本モジュール: その上の「経済的価値」— タイミングルール一族から最良を
//     選ぶという行為が、選択バイアス(データ・スヌーピング)を補正した後でも
//     バイ&ホールドに勝てるか — を Hansen (2005) の SPA 検定で問う。
//
// 全ルールはアウトオブサンプルで正直に構成する:
//   - 学習型(WF): 各週の直前 lookback 本のみで bestCombination を再学習
//   - 固定カレンダールール: パラメータを持たない(=当てはめが無い)
//   - 軌跡アナログ: 各週末時点までの履歴だけで近傍探索して翌週の建玉を決定
// 共通の評価窓(全ルールが稼働した日以降)で日次リターンを揃え、
// d_i,t = r_i,t − r_BH,t の平均が正のルールが一族に存在するかを検定する。
import { PricePoint } from "./types";
import { bestCombination } from "./weekday-trade";

// ---------------------------------------------------------------
// パラメータ
// ---------------------------------------------------------------
export interface TimingValueParams {
  costBps: number; // 片道コスト(bp)。建玉変更量 |Δpos| に比例して課金
  nBoot: number; // 定常ブートストラップ反復数
  blockLen: number; // 平均ブロック長(日)。系列相関の保存強度
  seed: number;
}

export const DEFAULT_TIMING_PARAMS: TimingValueParams = {
  costBps: 0,
  nBoot: 1000,
  blockLen: 10,
  seed: 20260719,
};

export type RuleGroup = "wf" | "fixed" | "analog";

export const GROUP_LABEL: Record<RuleGroup, string> = {
  wf: "週内クロック学習(WF)",
  fixed: "固定カレンダー",
  analog: "軌跡アナログ",
};

export interface RuleResult {
  id: string;
  label: string;
  group: RuleGroup;
  desc: string;
  active: boolean; // データ不足で稼働できなかったルールは false(検定から除外)
  // 以下は評価窓での成績
  ann: number; // 年率リターン
  sharpe: number; // 年率シャープ
  exposure: number; // 市場滞在率(セグメント基準)
  turnoverPerYear: number; // 年あたり建玉変更回数
  meanDiff: number; // 日次 d̄ = mean(r_rule − r_bh)
  annDiff: number; // d̄ × 252
  tStat: number; // √m·d̄/ω̂ (ω̂はブートストラップ標準誤差)
  pNaive: number; // このルール単独の片側ブートストラップp値(スヌーピング未補正)
}

export interface SpaResult {
  n: number; // 検定対象ルール数
  tStat: number; // max_i max(0, √m·d̄_i/ω̂_i)
  pLower: number; // SPA_l: 最も甘い(全ての負の平均を帰無に残す)
  pConsistent: number; // SPA_c: 推奨(閾値超の劣後ルールのみ残す)
  pUpper: number; // SPA_u: 最も保守的(White の Reality Check 相当)
}

export interface TimingEquityRow {
  time: string;
  bh: number;
  values: Record<string, number>; // ruleId → 累積リターン
}

export interface TimingValueResult {
  ok: boolean;
  reason?: string;
  evalStart: string;
  evalEnd: string;
  nDays: number; // 評価窓の日数
  years: number;
  bhAnn: number;
  bhSharpe: number;
  rules: RuleResult[]; // annDiff 降順
  spaAll: SpaResult;
  spaByGroup: Record<RuleGroup, SpaResult | null>;
  bestRuleId: string;
  minNaiveP: number; // 一族内の最小の未補正p値(スヌーピングの見え方)
  equity: TimingEquityRow[]; // 評価窓の累積リターン(全ルール+BH)
  params: TimingValueParams;
}

// ---------------------------------------------------------------
// 乱数
// ---------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------
// 日次グリッド
// ---------------------------------------------------------------
interface Grid {
  n: number;
  time: string[];
  dow: number[];
  g: number[]; // g[t] = open[t]/close[t-1] − 1 (day t へ入るオーバーナイト。t=0 は 0)
  d: number[]; // d[t] = close[t]/open[t] − 1 (day t の日中)
  weekEnds: number[]; // 各週の最終営業日インデックス
  weekStartOf: number[]; // 各日 → その週の開始インデックス
  spansWeekAfter: boolean[]; // day i の直後のオーバーナイトが週境界(週末ギャップ)か
  inTom: boolean[]; // 月替わり(月末2営業日+月初3営業日)か
  lr: number[]; // 対数リターン ln(close[t]/close[t-1]) (t=0 は 0)
  cumLr: number[]; // lr の累積和。区間リターン = exp(cumLr[b]−cumLr[a]) − 1
}

function buildGrid(prices: PricePoint[]): Grid | null {
  const n = prices.length;
  if (n < 2) return null;
  const time: string[] = new Array(n);
  const dow: number[] = new Array(n);
  const g: number[] = new Array(n).fill(0);
  const d: number[] = new Array(n).fill(0);
  const lr: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const p = prices[i];
    time[i] = p.time;
    dow[i] = new Date(p.time).getDay();
    if (p.open > 0) d[i] = p.close / p.open - 1;
    if (i > 0 && prices[i - 1].close > 0) {
      if (p.open > 0) g[i] = p.open / prices[i - 1].close - 1;
      if (p.close > 0) lr[i] = Math.log(p.close / prices[i - 1].close);
    }
  }

  // 週境界: 曜日が前日以下 → 新しい週(weekday-trade.ts と同一規則)
  const weekStartOf: number[] = new Array(n);
  let ws = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && dow[i] <= dow[i - 1]) ws = i;
    weekStartOf[i] = ws;
  }
  const weekEnds: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === n - 1 || weekStartOf[i + 1] !== weekStartOf[i]) weekEnds.push(i);
  }
  const spansWeekAfter: boolean[] = new Array(n).fill(false);
  for (let i = 0; i < n - 1; i++) spansWeekAfter[i] = weekStartOf[i + 1] !== weekStartOf[i];

  // 月替わり(TOM): 各月の最終2営業日+最初3営業日
  const inTom: boolean[] = new Array(n).fill(false);
  let mStart = 0;
  const monthOf = (i: number) => time[i].slice(0, 7);
  for (let i = 0; i <= n; i++) {
    if (i === n || (i > 0 && monthOf(i) !== monthOf(i - 1))) {
      const mEnd = i - 1; // 月の最終営業日
      for (let j = Math.max(mStart, mEnd - 1); j <= mEnd; j++) inTom[j] = true; // 月末2日
      for (let j = mStart; j < Math.min(mStart + 3, i); j++) inTom[j] = true; // 月初3日
      mStart = i;
    }
  }

  const cumLr: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) cumLr[i] = cumLr[i - 1] + lr[i];

  return { n, time, dow, g, d, weekEnds, weekStartOf, spansWeekAfter, inTom, lr, cumLr };
}

// ---------------------------------------------------------------
// ルール = ポジション系列 (pIn[i]: day i の日中 / pOv[i]: day i 直後のオーバーナイト)
// ---------------------------------------------------------------
interface RuleDef {
  id: string;
  label: string;
  group: RuleGroup;
  desc: string;
  pIn: number[];
  pOv: number[];
  activeFrom: number; // このインデックス以降ルールが「決定済み」(それ以前は評価対象外)。-1=稼働不能
}

function zeros(n: number): number[] {
  return new Array(n).fill(0);
}

function fixedRules(grid: Grid): RuleDef[] {
  const { n, dow, spansWeekAfter, inTom } = grid;
  const defs: RuleDef[] = [];

  {
    const pIn = zeros(n).fill(1);
    defs.push({
      id: "fx-daytime", label: "日中のみ保有", group: "fixed",
      desc: "毎日 始値で買い終値で手仕舞い。夜間・週末を一切持たない。",
      pIn, pOv: zeros(n), activeFrom: 0,
    });
  }
  {
    const pOv = zeros(n);
    for (let i = 0; i < n - 1; i++) pOv[i] = 1;
    defs.push({
      id: "fx-overnight", label: "夜間のみ保有", group: "fixed",
      desc: "毎日 終値で買い翌始値で手仕舞い(週末ギャップ含む)。日中を持たない。",
      pIn: zeros(n), pOv, activeFrom: 0,
    });
  }
  {
    const pIn = zeros(n).fill(1);
    const pOv = zeros(n);
    for (let i = 0; i < n - 1; i++) pOv[i] = spansWeekAfter[i] ? 0 : 1;
    defs.push({
      id: "fx-skip-weekend", label: "週末ギャップだけ回避", group: "fixed",
      desc: "常時保有だが金曜終値で降り月曜始値で乗り直す。",
      pIn, pOv, activeFrom: 0,
    });
  }
  {
    const pIn = zeros(n);
    const pOv = zeros(n);
    for (let i = 0; i < n; i++) pIn[i] = dow[i] === 1 ? 0 : 1;
    for (let i = 0; i < n - 1; i++) pOv[i] = spansWeekAfter[i] ? 0 : 1;
    defs.push({
      id: "fx-skip-monday", label: "週末+月曜日中を回避", group: "fixed",
      desc: "金曜終値で降り月曜終値で乗り直す(「月曜は下げる」アノマリーの実装)。",
      pIn, pOv, activeFrom: 0,
    });
  }
  {
    const pIn = zeros(n);
    const pOv = zeros(n);
    for (let i = 0; i < n; i++) pIn[i] = dow[i] >= 3 && dow[i] <= 5 ? 1 : 0;
    for (let i = 0; i < n - 1; i++) pOv[i] = dow[i] === 3 || dow[i] === 4 ? 1 : 0;
    defs.push({
      id: "fx-late-week", label: "週後半のみ(水始値→金終値)", group: "fixed",
      desc: "週前半を避け、水曜始値で買い金曜終値で手仕舞う。",
      pIn, pOv, activeFrom: 0,
    });
  }
  {
    const pIn = zeros(n);
    const pOv = zeros(n);
    for (let i = 0; i < n; i++) pIn[i] = inTom[i] ? 1 : 0;
    for (let i = 0; i < n - 1; i++) pOv[i] = inTom[i] && inTom[i + 1] ? 1 : 0;
    defs.push({
      id: "fx-tom", label: "月替わり(TOM)のみ", group: "fixed",
      desc: "月末2営業日+月初3営業日だけ保有(turn-of-the-month 効果)。",
      pIn, pOv, activeFrom: 0,
    });
  }
  return defs;
}

// 学習型: 各週の直前 lookback 本で bestCombination を再学習(真のウォークフォワード)。
// 学習窓が丸ごと確保できる週から稼働させ、それ以前は未稼働として評価窓から外す。
function wfRule(prices: PricePoint[], grid: Grid, lookback: number): RuleDef {
  const { n, dow } = grid;
  const pIn = zeros(n);
  const pOv = zeros(n);
  let activeFrom = -1;
  const sgn = (s: "long" | "short" | "flat") => (s === "long" ? 1 : s === "short" ? -1 : 0);

  // 週開始インデックス列
  const starts: number[] = [];
  for (let i = 0; i < n; i++) if (i === 0 || dow[i] <= dow[i - 1]) starts.push(i);

  for (let w = 0; w < starts.length; w++) {
    const s = starts[w];
    if (s < lookback) continue;
    const combo = bestCombination(prices.slice(s - lookback, s), true);
    if (activeFrom < 0) activeFrom = s;
    const e = (w + 1 < starts.length ? starts[w + 1] : n) - 1;
    for (let i = s; i <= e; i++) {
      const D = dow[i];
      if (D < 1 || D > 5) continue;
      pIn[i] = sgn(combo.slots[2 * (D - 1)].side);
      if (i < n - 1) pOv[i] = sgn(combo.slots[2 * (D - 1) + 1].side);
    }
  }
  return {
    id: `wf-${lookback}`, label: `週内クロックWF(直近${lookback}日で学習)`, group: "wf",
    desc: `毎週、直前${lookback}営業日だけで10スロット(曜日×日中/夜間)の最適サイドを再学習し翌週に適用。`,
    pIn, pOv, activeFrom,
  };
}

// 軌跡アナログ(簡易・正直版): 各週末に直近 L 日の対数リターン形状の K 近傍
// (すべて過去、フォワードも決定時点までに実現済みの窓のみ)を探し、
// フォワード中央値の符号で翌週の建玉を決める。
// ※ 本家 computeWeeklyAnalog の予測力検証(IC)は cal-weekly-analog-oos が担当。
//    ここでは「建玉決定ルールとしての経済的価値」を同じ土俵で測るための軽量実装。
function analogRule(grid: Grid, longShort: boolean): RuleDef {
  const { n, lr, cumLr, weekEnds } = grid;
  const L = 5, H = 5, K = 25, MIN_CANDS = 40;
  const pIn = zeros(n);
  const pOv = zeros(n);
  let activeFrom = -1;

  for (let k = 0; k < weekEnds.length - 1; k++) {
    const e = weekEnds[k]; // 決定時点(この週末の終値まで観測済み)
    const e2 = weekEnds[k + 1]; // 適用対象は翌週(e+1 .. e2)
    if (e < L) continue;

    // 候補: 過去の週末 e' で、特徴量(直近L日)とフォワード(H日先)が e までに実現済みのもの
    const cands: { dist: number; fwd: number }[] = [];
    for (let j = 0; j < k; j++) {
      const ep = weekEnds[j];
      if (ep < L || ep + H > e) continue;
      let dist = 0;
      for (let l = 0; l < L; l++) {
        const diff = lr[e - l] - lr[ep - l];
        dist += diff * diff;
      }
      cands.push({ dist, fwd: Math.exp(cumLr[ep + H] - cumLr[ep]) - 1 });
    }
    if (cands.length < MIN_CANDS) continue;

    cands.sort((a, b) => a.dist - b.dist);
    const fwds = cands.slice(0, Math.min(K, cands.length)).map((c) => c.fwd).sort((a, b) => a - b);
    const m = fwds.length;
    const yhat = m % 2 === 1 ? fwds[(m - 1) / 2] : (fwds[m / 2 - 1] + fwds[m / 2]) / 2;
    const pos = yhat > 0 ? 1 : longShort ? -1 : 0;

    if (activeFrom < 0) activeFrom = e + 1;
    for (let i = e; i < e2; i++) pOv[i] = pos; // 週末ギャップ含め持ち越す
    for (let i = e + 1; i <= e2; i++) pIn[i] = pos;
  }

  return {
    id: longShort ? "an-longshort" : "an-longcash",
    label: longShort ? "軌跡アナログ(買/売)" : "軌跡アナログ(買/現金)",
    group: "analog",
    desc: `各週末に直近${L}日の値動き形状のK近傍(K=${K}, 全て過去)を探し、フォワード中央値の符号で翌週を${longShort ? "買い/売り" : "買い/現金"}。`,
    pIn, pOv, activeFrom,
  };
}

// ---------------------------------------------------------------
// 日次リターン化
// ---------------------------------------------------------------
function dailyReturns(grid: Grid, pIn: number[], pOv: number[], costRate: number): { r: number[]; turns: number } {
  const { n, g, d } = grid;
  const r: number[] = new Array(n).fill(0);
  let turns = 0;
  for (let t = 1; t < n; t++) {
    const mOv = 1 + pOv[t - 1] * g[t];
    const mIn = 1 + pIn[t] * d[t];
    // 建玉変更: 前日終値(日中→夜間)と当日始値(夜間→日中)
    const turn = Math.abs(pOv[t - 1] - pIn[t - 1]) + Math.abs(pIn[t] - pOv[t - 1]);
    if (turn > 0) turns++;
    r[t] = mOv * mIn * (1 - costRate * turn) - 1;
  }
  return { r, turns };
}

function perf(r: number[], from: number, to: number): { ann: number; sharpe: number } {
  const m = to - from + 1;
  if (m < 2) return { ann: 0, sharpe: 0 };
  let sum = 0, cum = 1;
  for (let t = from; t <= to; t++) { sum += r[t]; cum *= 1 + r[t]; }
  const mean = sum / m;
  let v = 0;
  for (let t = from; t <= to; t++) v += (r[t] - mean) ** 2;
  const sd = Math.sqrt(v / (m - 1));
  const ann = Math.pow(Math.max(1e-9, cum), 252 / m) - 1;
  return { ann, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0 };
}

// ---------------------------------------------------------------
// SPA 検定 (Hansen 2005)
// ---------------------------------------------------------------
function spaForSubset(
  idxs: number[], // 対象ルールのインデックス
  dbar: number[], // 各ルールの d̄
  omega: number[], // 各ルールの ω̂ = √m × sd_b(d̄*)
  bootMeans: Float64Array, // B×nRules の d̄*_{b,i}
  nRules: number,
  B: number,
  mDays: number,
): SpaResult {
  const sq = Math.sqrt(mDays);
  const thr = Math.sqrt(2 * Math.log(Math.log(Math.max(3, mDays)))); // 2loglog(n) 閾値
  let T = 0;
  for (const i of idxs) if (omega[i] > 0) T = Math.max(T, (sq * dbar[i]) / omega[i]);
  T = Math.max(0, T);

  // 再センタリング μ̂: l=min(0,d̄) / c=閾値超の劣後のみ d̄ / u=0
  const muL: number[] = [], muC: number[] = [], muU: number[] = [];
  for (const i of idxs) {
    muL.push(Math.min(0, dbar[i]));
    muC.push(sq * dbar[i] < -thr * omega[i] ? dbar[i] : 0);
    muU.push(0);
  }

  let geL = 0, geC = 0, geU = 0;
  for (let b = 0; b < B; b++) {
    let tL = 0, tC = 0, tU = 0;
    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k];
      if (!(omega[i] > 0)) continue;
      const z = bootMeans[b * nRules + i] - dbar[i];
      tL = Math.max(tL, (sq * (z + muL[k])) / omega[i]);
      tC = Math.max(tC, (sq * (z + muC[k])) / omega[i]);
      tU = Math.max(tU, (sq * (z + muU[k])) / omega[i]);
    }
    if (tL >= T) geL++;
    if (tC >= T) geC++;
    if (tU >= T) geU++;
  }
  return {
    n: idxs.length,
    tStat: T,
    pLower: (geL + 1) / (B + 1),
    pConsistent: (geC + 1) / (B + 1),
    pUpper: (geU + 1) / (B + 1),
  };
}

// ---------------------------------------------------------------
// メイン
// ---------------------------------------------------------------
export function computeTimingValue(
  prices: PricePoint[],
  params: TimingValueParams,
): TimingValueResult | null {
  const grid = buildGrid(prices);
  if (!grid) return null;
  const { n, time } = grid;
  if (n < 400) {
    return {
      ok: false, reason: `データ不足(${n}営業日)。学習窓+評価窓のため最低400営業日必要です。`,
      evalStart: "", evalEnd: "", nDays: 0, years: 0, bhAnn: 0, bhSharpe: 0,
      rules: [], spaAll: { n: 0, tStat: 0, pLower: 1, pConsistent: 1, pUpper: 1 },
      spaByGroup: { wf: null, fixed: null, analog: null },
      bestRuleId: "", minNaiveP: 1, equity: [], params,
    };
  }

  const costRate = params.costBps / 10000;

  // --- ルール一族の構築 ---
  const lookbacks = [126, 252, 504].filter((lb) => lb + 60 < n);
  const defs: RuleDef[] = [
    ...lookbacks.map((lb) => wfRule(prices, grid, lb)),
    ...fixedRules(grid),
    analogRule(grid, false),
    analogRule(grid, true),
  ];

  // --- 日次リターン ---
  const bhIn = zeros(n).fill(1);
  const bhOv = zeros(n);
  for (let i = 0; i < n - 1; i++) bhOv[i] = 1;
  const bh = dailyReturns(grid, bhIn, bhOv, costRate); // B&H は建玉変更なし→コスト0

  const active = defs.filter((d) => d.activeFrom >= 0);
  if (active.length < 2) return null;

  // 評価窓: 全稼働ルールが決定済みになった翌日以降
  const evalFrom = Math.max(1, ...active.map((d) => d.activeFrom + 1));
  const evalTo = n - 1;
  const mDays = evalTo - evalFrom + 1;
  if (mDays < 120) {
    return {
      ok: false, reason: `評価窓が不足(${mDays}日)。全ルール稼働後に最低120営業日必要です。`,
      evalStart: "", evalEnd: "", nDays: 0, years: 0, bhAnn: 0, bhSharpe: 0,
      rules: [], spaAll: { n: 0, tStat: 0, pLower: 1, pConsistent: 1, pUpper: 1 },
      spaByGroup: { wf: null, fixed: null, analog: null },
      bestRuleId: "", minNaiveP: 1, equity: [], params,
    };
  }

  const nR = active.length;
  const rets = active.map((d) => dailyReturns(grid, d.pIn, d.pOv, costRate));

  // 差分 d_{i,t} を評価窓で平坦化 (rule-major)
  const diffs = new Float64Array(nR * mDays);
  const dbar: number[] = new Array(nR).fill(0);
  for (let i = 0; i < nR; i++) {
    const r = rets[i].r;
    let s = 0;
    for (let t = 0; t < mDays; t++) {
      const v = r[evalFrom + t] - bh.r[evalFrom + t];
      diffs[i * mDays + t] = v;
      s += v;
    }
    dbar[i] = s / mDays;
  }

  // --- 定常ブートストラップ(Politis–Romano)。時間インデックスを全ルールで共有し
  //     横断相関(同じ日の再抽出)を保存する ---
  const B = params.nBoot;
  const rnd = mulberry32(params.seed);
  const pCont = 1 - 1 / Math.max(2, params.blockLen);
  const bootMeans = new Float64Array(B * nR);
  const sums = new Float64Array(nR);
  for (let b = 0; b < B; b++) {
    sums.fill(0);
    let src = Math.floor(rnd() * mDays);
    for (let t = 0; t < mDays; t++) {
      if (t > 0 && rnd() >= pCont) src = Math.floor(rnd() * mDays);
      for (let i = 0; i < nR; i++) sums[i] += diffs[i * mDays + src];
      src = (src + 1) % mDays;
    }
    for (let i = 0; i < nR; i++) bootMeans[b * nR + i] = sums[i] / mDays;
  }

  // ω̂_i = √m × sd_b(d̄*_{b,i})
  const omega: number[] = new Array(nR).fill(0);
  for (let i = 0; i < nR; i++) {
    let mu = 0;
    for (let b = 0; b < B; b++) mu += bootMeans[b * nR + i];
    mu /= B;
    let v = 0;
    for (let b = 0; b < B; b++) v += (bootMeans[b * nR + i] - mu) ** 2;
    omega[i] = Math.sqrt(mDays) * Math.sqrt(v / Math.max(1, B - 1));
  }

  // --- ルール別成績と未補正p値 ---
  const bhPerf = perf(bh.r, evalFrom, evalTo);
  const years = mDays / 252;
  const ruleResults: RuleResult[] = [];
  const activeIdx: number[] = [];
  for (let i = 0; i < nR; i++) {
    const def = active[i];
    const p = perf(rets[i].r, evalFrom, evalTo);
    // 滞在率: 評価窓の日中+夜間セグメントのうち建玉が入っている割合
    let inMkt = 0;
    for (let t = evalFrom; t <= evalTo; t++) {
      if (def.pIn[t] !== 0) inMkt++;
      if (t < n - 1 && def.pOv[t] !== 0) inMkt++;
    }
    // 未補正 p: P(d̄* − d̄ ≥ d̄) — 単独ルールの片側ブートストラップ検定
    let ge = 0;
    for (let b = 0; b < B; b++) if (bootMeans[b * nR + i] - dbar[i] >= dbar[i]) ge++;
    ruleResults.push({
      id: def.id, label: def.label, group: def.group, desc: def.desc, active: true,
      ann: p.ann, sharpe: p.sharpe,
      exposure: inMkt / (2 * mDays),
      turnoverPerYear: rets[i].turns / (n / 252),
      meanDiff: dbar[i], annDiff: dbar[i] * 252,
      tStat: omega[i] > 0 ? (Math.sqrt(mDays) * dbar[i]) / omega[i] : 0,
      pNaive: (ge + 1) / (B + 1),
    });
    activeIdx.push(i);
  }
  // 稼働できなかったルールも一覧に載せる(検定外)
  for (const def of defs) {
    if (def.activeFrom < 0) {
      ruleResults.push({
        id: def.id, label: def.label, group: def.group, desc: def.desc, active: false,
        ann: 0, sharpe: 0, exposure: 0, turnoverPerYear: 0,
        meanDiff: 0, annDiff: 0, tStat: 0, pNaive: 1,
      });
    }
  }

  // --- SPA (全体 + グループ別) ---
  const spaAll = spaForSubset(activeIdx, dbar, omega, bootMeans, nR, B, mDays);
  const spaByGroup: Record<RuleGroup, SpaResult | null> = { wf: null, fixed: null, analog: null };
  for (const grp of ["wf", "fixed", "analog"] as RuleGroup[]) {
    const idxs = activeIdx.filter((i) => active[i].group === grp);
    if (idxs.length > 0) spaByGroup[grp] = spaForSubset(idxs, dbar, omega, bootMeans, nR, B, mDays);
  }

  // --- エクイティ(評価窓) ---
  const equity: TimingEquityRow[] = [];
  const cums = new Array(nR).fill(1);
  let bhCum = 1;
  for (let t = evalFrom; t <= evalTo; t++) {
    bhCum *= 1 + bh.r[t];
    const values: Record<string, number> = {};
    for (let i = 0; i < nR; i++) {
      cums[i] *= 1 + rets[i].r[t];
      values[active[i].id] = cums[i] - 1;
    }
    equity.push({ time: time[t], bh: bhCum - 1, values });
  }

  const sorted = [...ruleResults].sort((a, b) => Number(b.active) - Number(a.active) || b.annDiff - a.annDiff);
  const best = sorted[0];
  const minNaiveP = Math.min(...ruleResults.filter((r) => r.active).map((r) => r.pNaive));

  return {
    ok: true,
    evalStart: time[evalFrom],
    evalEnd: time[evalTo],
    nDays: mDays,
    years,
    bhAnn: bhPerf.ann,
    bhSharpe: bhPerf.sharpe,
    rules: sorted,
    spaAll,
    spaByGroup,
    bestRuleId: best ? best.id : "",
    minNaiveP,
    equity,
    params,
  };
}
