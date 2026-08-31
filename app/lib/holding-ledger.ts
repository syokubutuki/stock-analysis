// 「同じ銘柄を、持ち方だけ変えたら終端富はどう変わるか」の対数加法分解。
//
// ## なぜこのファイルがあるか
//
// 既存の幾何リターン層（growth-drag.ts + pf-growth-intuition / pf-corr-drag /
// pf-growth-drag）は **ρ（相関）と W（総建玉）の軸**で「分散を無視して建玉を積む代償」を
// 説明している。しかし「高ボラ銘柄を回転させる vs 低ボラ銘柄を持ち切る」という
// **回転の軸**は、どのパネルも扱っていなかった。
//
// 実測（2026-08-29・285A.T 対 8306.T）で分かったのは、直感に反する次の事実である。
//
//   - キオクシア: μ=268% / σ=103% → ハードル σ²/2 = 52.7% を **μ が遥かに越えている**。
//     ボラティリティドラッグは巨大だが、この銘柄の成否を決めてはいない。
//   - つまり「高ボラ ＝ 幾何リターンが壊れる」は、実データの前で成立しない。
//   - 一方 SE(μ̂) = σ/√T = ±80.5pp は **ハードル 52.7pp より大きい**。
//     どの銘柄でも「壁を越えているか」は測定では決着しない（→ drift-identifiability.ts）。
//   - 符号が確定していて測れるのは **回転コストと税** だけ。しかも税の繰延喪失は
//     g に比例するので、**当たっている銘柄ほど回転の損失が大きい**。
//
// よってこのパネルの主張は「高ボラをやめろ」ではなく
// **「銘柄選択の当否とは独立に、回転は常に同じ割合を削る」**である。
// ドラッグの側と回転の側を**同じスケールの棒**で並べ、どちらが効いているかを
// 銘柄ごとに読者自身に判定させる。
//
// ## 2つの計算経路（役割が違う。片方だけにしないこと）
//
// 1. `decomposeLedger()` — 決定論的な加法分解。**説明用**。
//    各項が閉形式で出るのでウォーターフォールに落とせる。
//    前提: 在場期間のリターンは全期間の平均並み（＝タイミング技能ゼロ）。
//
// 2. `walkStrategy()` — 実際の日次リターン列を歩く**証拠側**。
//    ランダムに在場ブロックを選ぶ（＝プラセボ対照群）ので、1 の前提が
//    実データでどれだけ散らばるかが分布として出る。損益通算・追証・破産も扱える。
//
// 1 の値が 2 の分布の中心付近に落ちることが、1 の前提が妥当だったことの検証になる。

import { PricePoint } from "./types";
import { mulberry32, TRADING_DAYS, doublingYears } from "./growth-drag";
import { TAX_RATE, DEFAULT_MARGIN_RATE_LONG } from "./nisa-vs-taxable";

export { TAX_RATE, DEFAULT_MARGIN_RATE_LONG };

/** 1往復コストの上限。入力ミスで富が消えるのを防ぐ（strategy-vs-benchmark と同じ思想）。 */
const MAX_RT_COST = 0.5;

// ───────────────────────── 素材の統計量 ─────────────────────────

export interface SeriesStats {
  n: number; // 対数リターンの本数
  years: number;
  from: string;
  to: string;
  /** 年率**算術**平均。g の分解に入れるのは必ずこちら（mu-convention の 9pp 事故） */
  muArith: number;
  /** 年率ボラ（対数リターンの標本SD×√252） */
  sigma: number;
  /** ハードル σ²/2。g>0 ⟺ μ_arith > σ²/2 */
  hurdle: number;
  /** 実現した幾何成長率（対数平均×252）。μ_arith − σ²/2 とほぼ一致するはず */
  gRealized: number;
  /** 恒等式の残差（gRealized − (muArith − hurdle)）。実測で 1pp 以内に収まる */
  identityGap: number;
  /** SE(μ̂) = σ/√T（T は年数）。**頻度を上げても縮まない**（両端2点の恒等式） */
  seMu: number;
  /** μ̂ がハードルを越えていると言えるかの t 値。ほぼ常に有意にならない */
  tHurdle: number;
  /** 夜間（前日終値→当日始値）の年率対数ドリフト */
  overnight: number;
  /** 日中（当日始値→当日終値）の年率対数ドリフト */
  intraday: number;
}

export function seriesStats(prices: PricePoint[]): SeriesStats | null {
  if (prices.length < 60) return null;
  const logR: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const a = prices[i - 1].close;
    const b = prices[i].close;
    if (a > 0 && b > 0) logR.push(Math.log(b / a));
  }
  const n = logR.length;
  if (n < 50) return null;

  let sumSimple = 0;
  let sumLog = 0;
  for (const r of logR) {
    sumSimple += Math.expm1(r);
    sumLog += r;
  }
  const meanLog = sumLog / n;
  let ss = 0;
  for (const r of logR) ss += (r - meanLog) ** 2;
  const sigma = Math.sqrt((ss / (n - 1)) * TRADING_DAYS);
  const muArith = (sumSimple / n) * TRADING_DAYS;
  const gRealized = meanLog * TRADING_DAYS;
  const hurdle = (sigma * sigma) / 2;
  const years = n / TRADING_DAYS;
  const seMu = years > 0 ? sigma / Math.sqrt(years) : 0;

  // 夜間 / 日中の厳密分解。合計は日次対数リターンに一致する（近似ではない）。
  let sumOn = 0;
  let sumId = 0;
  let cnt = 0;
  for (let i = 1; i < prices.length; i++) {
    const prevC = prices[i - 1].close;
    const o = prices[i].open;
    const c = prices[i].close;
    if (prevC > 0 && o > 0 && c > 0) {
      sumOn += Math.log(o / prevC);
      sumId += Math.log(c / o);
      cnt++;
    }
  }

  return {
    n,
    years,
    from: prices[0].time,
    to: prices[prices.length - 1].time,
    muArith,
    sigma,
    hurdle,
    gRealized,
    identityGap: gRealized - (muArith - hurdle),
    seMu,
    tHurdle: seMu > 0 ? (muArith - hurdle) / seMu : 0,
    overnight: cnt > 0 ? (sumOn / cnt) * TRADING_DAYS : 0,
    intraday: cnt > 0 ? (sumId / cnt) * TRADING_DAYS : 0,
  };
}

/** 日次**単純**リターン。レバレッジ後の富は (1+q·r) で回るので、歩くときは単純が要る。 */
export function simpleReturns(prices: PricePoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const a = prices[i - 1].close;
    const b = prices[i].close;
    if (a > 0 && b > 0) out.push(b / a - 1);
  }
  return out;
}

// ───────────────────────── 1. 決定論的な加法分解（説明用） ─────────────────────────

export interface LedgerParams {
  /** 1回の建玉を何営業日持つか。B&H は Infinity 相当だが、UI では別枠で出す */
  holdDays: number;
  /** 市場にいる時間割合 θ（0〜1） */
  inMarket: number;
  /** 建玉倍率 q。1=現物フル、2=信用2倍 */
  leverage: number;
  /** 1往復コスト（比率）。spread-estimator の実測値を既定に */
  costRT: number;
  /** 実現益課税を効かせるか */
  taxEnabled: boolean;
  taxRate: number;
  /** 信用買方金利（年率）。q>1 のとき (q−1) に対してかかる */
  marginRate: number;
  /** B&H 側の清算までの年数。持ち切りも最後に一度だけ課税される */
  horizonYears: number;
}

export interface LedgerStep {
  key: string;
  label: string;
  /** この段の増減（年率対数） */
  delta: number;
  /** この段を適用した後の累積 */
  after: number;
  kind: "base" | "drag" | "cost" | "result";
}

export interface LedgerResult {
  /** 建玉1・持ち切り・税前の g（＝銘柄の素性） */
  gBuyHold: number;
  /** 持ち切りを horizonYears 後に清算したときの税引後年率 */
  gBuyHoldNet: number;
  /** レバレッジ後の期待 q·μ */
  expected: number;
  /** ドラッグ q²σ²/2。**q の二乗**で効く */
  drag: number;
  /** q μ − q²σ²/2 */
  gLevered: number;
  /** 在場割合による目減り（θ−1）·gLevered。技能ゼロ前提 */
  inMarketDelta: number;
  /** 年間往復回数 252θ/H */
  roundTrips: number;
  /** 回転コスト項（負） */
  costDelta: number;
  /** 信用金利項（負） */
  carryDelta: number;
  /** 税引前の合計 */
  gPreTax: number;
  /** 税の繰延喪失（負）。g に比例するので、当たっている銘柄ほど大きい */
  taxDelta: number;
  /** 最終的な年率対数成長率 */
  gNet: number;
  /** 倍化年数（gNet<=0 なら Infinity） */
  doublingYears: number;
  /** 持ち切り（税引後）との差 */
  vsBuyHold: number;
  /** ウォーターフォール用の段 */
  steps: LedgerStep[];
  /** 「ドラッグが削った量」と「回転が削った量」— 同じスケールで並べるための2値 */
  dragLoss: number;
  turnoverLoss: number;
}

/** e^x を年率対数に戻すときの、実現益課税1サイクル分。 */
function afterTaxAnnualLog(gPre: number, cyclesPerYear: number, taxRate: number): number {
  if (cyclesPerYear <= 0) return gPre;
  const perCycle = Math.expm1(gPre / cyclesPerYear);
  // 損失は損益通算されるものとして (1−τ) を対称に掛ける。正のドリフト下では
  // 実質「利益に τ を課す」に一致する。経路依存な厳密計算は nisa-vs-taxable.ts。
  const net = 1 + (1 - taxRate) * perCycle;
  if (net <= 1e-12) return -Infinity;
  return cyclesPerYear * Math.log(net);
}

export function decomposeLedger(s: SeriesStats, p: LedgerParams): LedgerResult {
  const q = Math.max(0, p.leverage);
  const theta = Math.min(1, Math.max(0, p.inMarket));
  const H = Math.max(1, p.holdDays);
  const c = Math.min(MAX_RT_COST, Math.max(0, p.costRT));
  const tau = p.taxEnabled ? Math.min(0.9, Math.max(0, p.taxRate)) : 0;

  const gBuyHold = s.muArith - s.hurdle;
  const gBuyHoldNet =
    p.horizonYears > 0 ? afterTaxAnnualLog(gBuyHold, 1 / p.horizonYears, tau) : gBuyHold;

  const expected = q * s.muArith;
  const drag = q * q * s.hurdle;
  const gLevered = expected - drag;

  const gIn = theta * gLevered;
  const inMarketDelta = gIn - gLevered;

  const roundTrips = (TRADING_DAYS * theta) / H;
  // 建玉 q 倍なら1往復で自己資本の q·c を失う。対数空間で厳密に控除する。
  const perRT = Math.log(1 - Math.min(MAX_RT_COST, q * c));
  const costDelta = roundTrips * perRT;

  const carryDelta = -theta * Math.max(0, q - 1) * p.marginRate;

  const gPreTax = gIn + costDelta + carryDelta;
  const cyclesPerYear = TRADING_DAYS * theta / H;
  const gNet = tau > 0 ? afterTaxAnnualLog(gPreTax, cyclesPerYear, tau) : gPreTax;
  const taxDelta = gNet - gPreTax;

  const steps: LedgerStep[] = [
    { key: "expected", label: `期待リターン q·μ（見かけ）`, delta: expected, after: expected, kind: "base" },
    { key: "drag", label: `ボラティリティドラッグ q²σ²/2`, delta: -drag, after: gLevered, kind: "drag" },
    { key: "inMarket", label: `市場にいない期間の取りこぼし`, delta: inMarketDelta, after: gIn, kind: "cost" },
    { key: "cost", label: `回転コスト（年${roundTrips.toFixed(0)}往復）`, delta: costDelta, after: gIn + costDelta, kind: "cost" },
    ...(carryDelta !== 0
      ? [{ key: "carry", label: "信用金利", delta: carryDelta, after: gPreTax, kind: "cost" as const }]
      : []),
    ...(tau > 0
      ? [{ key: "tax", label: "税の繰延喪失", delta: taxDelta, after: gNet, kind: "cost" as const }]
      : []),
    { key: "result", label: "実際に増える速さ（幾何成長率）", delta: gNet, after: gNet, kind: "result" },
  ];

  return {
    gBuyHold,
    gBuyHoldNet,
    expected,
    drag,
    gLevered,
    inMarketDelta,
    roundTrips,
    costDelta,
    carryDelta,
    gPreTax,
    taxDelta,
    gNet,
    doublingYears: doublingYears(gNet),
    vsBuyHold: gNet - gBuyHoldNet,
    steps,
    // 「ドラッグの側」と「回転の側」を同じスケールで並べるための2値。
    // ドラッグは q²σ²/2、回転は在場取りこぼし＋コスト＋キャリー＋税の合計。
    dragLoss: drag,
    turnoverLoss: -(inMarketDelta + costDelta + carryDelta + taxDelta),
  };
}

// ───────────────────── 2. 実データを歩く（プラセボ対照群） ─────────────────────

export interface WalkResult {
  /** 年率対数成長率 */
  g: number;
  /** 期間全体の富倍率 */
  wealth: number;
  roundTrips: number;
  /** 支払った売買コストの累計（初期資本比） */
  costPaid: number;
  /** 支払った税の累計（初期資本比） */
  taxPaid: number;
  /** 支払った信用金利の累計（初期資本比） */
  carryPaid: number;
  /** 最大ドローダウン（負の値） */
  maxDrawdown: number;
  /** 途中で資本がゼロ以下になったか（レバレッジ時のみ起こりうる） */
  ruined: boolean;
}

export interface WalkParams {
  leverage: number;
  costRT: number;
  taxEnabled: boolean;
  taxRate: number;
  marginRate: number;
}

/**
 * 日次単純リターン列を、`inMarket[i]` の在場フラグに従って歩く。
 *
 * コストは建玉時と手仕舞い時に片道ずつ（合計で q·costRT）。
 * 税は**手仕舞いのたびに**実現益へ課す。損失は繰越して以後の利益と通算する。
 * 期末に建玉が残っていれば、そこで清算したものとして1回だけ課税する。
 */
export function walkStrategy(
  returns: number[],
  inMarket: boolean[],
  p: WalkParams
): WalkResult {
  const q = Math.max(0, p.leverage);
  const c = Math.min(MAX_RT_COST, Math.max(0, p.costRT));
  const legCost = Math.min(MAX_RT_COST, (q * c) / 2);
  const tau = p.taxEnabled ? Math.min(0.9, Math.max(0, p.taxRate)) : 0;
  const dailyCarry = (Math.max(0, q - 1) * p.marginRate) / TRADING_DAYS;

  let w = 1;
  let peak = 1;
  let maxDD = 0;
  let entryW = 1;
  let lossPool = 0;
  let roundTrips = 0;
  let costPaid = 0;
  let taxPaid = 0;
  let carryPaid = 0;
  let prev = false;
  let ruined = false;

  const settle = () => {
    const fee = w * legCost;
    w -= fee;
    costPaid += fee;
    const gain = w - entryW;
    if (tau > 0) {
      if (gain > 0) {
        const offset = Math.min(gain, lossPool);
        lossPool -= offset;
        const taxable = gain - offset;
        const t = taxable * tau;
        w -= t;
        taxPaid += t;
      } else {
        lossPool += -gain;
      }
    }
    roundTrips++;
  };

  for (let i = 0; i < returns.length && !ruined; i++) {
    const cur = inMarket[i];
    if (cur && !prev) {
      const fee = w * legCost;
      w -= fee;
      costPaid += fee;
      entryW = w;
    }
    if (cur) {
      const mult = 1 + q * returns[i];
      if (mult <= 0) {
        w = 0;
        ruined = true;
        break;
      }
      w *= mult;
      if (dailyCarry > 0) {
        const cc = w * dailyCarry;
        w -= cc;
        carryPaid += cc;
      }
      if (w <= 0) {
        w = 0;
        ruined = true;
        break;
      }
    }
    if (!cur && prev) settle();
    if (w > peak) peak = w;
    const dd = w / peak - 1;
    if (dd < maxDD) maxDD = dd;
    prev = cur;
  }
  if (prev && !ruined) settle();

  const years = returns.length / TRADING_DAYS;
  return {
    g: w > 0 && years > 0 ? Math.log(w) / years : -Infinity,
    wealth: w,
    roundTrips,
    costPaid,
    taxPaid,
    carryPaid,
    maxDrawdown: maxDD,
    ruined,
  };
}

/** 全期間ずっと在場（＝バイ&ホールド）の在場フラグ。 */
export function alwaysIn(n: number): boolean[] {
  return new Array(n).fill(true);
}

/**
 * 長さ H のブロックに区切り、そのうち θ 割合を**ランダムに選んで**在場する。
 *
 * これがプラセボ対照群である。同じ回転率・同じ在場割合で、タイミングの中身だけを
 * 無作為にした群。実際のトレードがこの分布より右に出て初めて「技能」と言える
 * （検定は timing-value.ts の SPA / Reality Check が担当する）。
 */
export function randomBlocks(
  n: number,
  holdDays: number,
  inMarketFrac: number,
  rand: () => number
): boolean[] {
  const H = Math.max(1, Math.floor(holdDays));
  const flags = new Array<boolean>(n).fill(false);
  const nBlocks = Math.ceil(n / H);
  const want = Math.round(nBlocks * Math.min(1, Math.max(0, inMarketFrac)));
  // 部分シャッフルで want 個のブロックを重複なく選ぶ
  const idx = Array.from({ length: nBlocks }, (_, i) => i);
  for (let i = 0; i < want && i < nBlocks; i++) {
    const j = i + Math.floor(rand() * (nBlocks - i));
    const t = idx[i];
    idx[i] = idx[j];
    idx[j] = t;
  }
  for (let k = 0; k < want && k < nBlocks; k++) {
    const b = idx[k];
    for (let d = b * H; d < Math.min(n, (b + 1) * H); d++) flags[d] = true;
  }
  return flags;
}

export interface PlaceboResult {
  gs: number[];
  q05: number;
  q50: number;
  q95: number;
  mean: number;
  ruinRate: number;
  meanRoundTrips: number;
  meanTaxPaid: number;
  meanCostPaid: number;
}

export function placeboDistribution(
  returns: number[],
  p: WalkParams & { holdDays: number; inMarket: number; iters: number; seed: number }
): PlaceboResult {
  const rand = mulberry32(p.seed);
  const gs: number[] = [];
  let ruins = 0;
  let rt = 0;
  let tax = 0;
  let cost = 0;
  for (let it = 0; it < p.iters; it++) {
    const flags = randomBlocks(returns.length, p.holdDays, p.inMarket, rand);
    const r = walkStrategy(returns, flags, p);
    if (r.ruined || !isFinite(r.g)) {
      ruins++;
      continue;
    }
    gs.push(r.g);
    rt += r.roundTrips;
    tax += r.taxPaid;
    cost += r.costPaid;
  }
  const sorted = [...gs].sort((a, b) => a - b);
  const at = (f: number) =>
    sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(f * (sorted.length - 1))))];
  const m = gs.length ? gs.reduce((a, b) => a + b, 0) / gs.length : 0;
  return {
    gs,
    q05: at(0.05),
    q50: at(0.5),
    q95: at(0.95),
    mean: m,
    ruinRate: p.iters > 0 ? ruins / p.iters : 0,
    meanRoundTrips: gs.length ? rt / gs.length : 0,
    meanTaxPaid: gs.length ? tax / gs.length : 0,
    meanCostPaid: gs.length ? cost / gs.length : 0,
  };
}

// ───────────────────────── 表用のグリッド ─────────────────────────

export interface GridCell {
  holdDays: number;
  inMarket: number;
  gNet: number;
  doublingYears: number;
  vsBuyHold: number;
}

export function ledgerGrid(
  s: SeriesStats,
  base: LedgerParams,
  holdDaysList: number[],
  inMarketList: number[]
): GridCell[][] {
  return holdDaysList.map((H) =>
    inMarketList.map((th) => {
      const r = decomposeLedger(s, { ...base, holdDays: H, inMarket: th });
      return {
        holdDays: H,
        inMarket: th,
        gNet: r.gNet,
        doublingYears: r.doublingYears,
        vsBuyHold: r.vsBuyHold,
      };
    })
  );
}
