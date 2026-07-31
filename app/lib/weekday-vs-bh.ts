// 曜日トレード（月曜に建て金曜に手仕舞い、週末をまたがない）が
// バイ&ホールド（B&H, 常時ロング）に対して「どれくらい統計的に優位か」を検定する純粋関数群。
//
// ■ 核心アイデア（重複の罠を避ける）
// この戦略と B&H は保有区間が大きく重複する（戦略は B&H の部分集合）。したがって日次リターンの
// 単純な2標本検定は自己相関・重複でp値が過小になり誤り。正しくは「差の非重複部分」を直接見る。
// すべてを価格イベント間の区間(segment)に分解し、対数リターンで書くと厳密に:
//   log(B&H資産) − log(戦略資産) = Σ_(戦略が捨てた区間) log(1+r)
// つまり戦略が B&H に勝つ ⟺ 「捨てた区間（主に週末ギャップ 金終値→月始値）の平均が負」。
// 本モジュールはこの週次の超過リターン e_w = 戦略_w − B&H_w = −(捨てた区間) を主標本として検定する。
//
// 提供する検定:
//  1) 週末ギャップ検定    : 週次超過 e_w の平均>0 の片側t検定 + 移動ブロックBootstrap CI
//  2) Sharpe差検定        : Jobson–Korkie–Memmel の解析z検定 + ペア・ブロックBootstrap
//  3) 週次ペア差の頑健検定: Wilcoxon符号順位検定 + 符号検定（非正規・外れ値に頑健）
//  4) 年率差Bootstrap CI  : 年率リターン差の95%信頼区間（ペア・ブロックBootstrap）
//
// ■ 取引コスト（docs/weekday-vs-bh-cost.md）
// この戦略は年52往復、B&H は期間全体で1往復＝回転率が 500 倍以上違う。したがってコストは
// 「注記」ではなく検定の内部に入れないと結論が変わる。ここでは単一の costRT を唯一の課金源とし、
//   経路B（日次の富ループ）: 建玉 pos[] が変化した区間の先頭で片道1レグぶん課金
//   経路A（週次の超過）    : 同じレグ数ぶんを対数で控除し、B&H の1往復を週へ均等配分
// の両方へ伝播させる。片方だけに入れると①③（週次）と②④（日次）が矛盾した結論を出す。
// 1レグの控除は ln(1−c)/2。2レグで厳密に ln(1−c) になり、経路A・Bが c² の誤差なく一致する
// （strategy-vs-benchmark.ts の「1往復あたり ln(1−c)」と同一規約）。
// なお costRT に依らず常に Break-even（このエッジが吸収できる往復コスト）を算出する。

import { PricePoint } from "./types";
import { runStrategyTrades, type Timing } from "./weekday-trade";
import { mean, std, quantileSorted, median, tTest } from "./stats-significance";
import { representativeSpread } from "./spread-estimator";

export type { Timing };

export interface VsBHSpec {
  entryTiming: Timing; // 月曜の建て（始値/終値）
  exitTiming: Timing; // 金曜の手仕舞い（始値/終値）
  // 往復コスト（比率）= 往復スプレッド + 2×片道手数料。既定 0（＝控除なし・従来の値）。
  // strategy-vs-benchmark.ts の roundTripCost() と同じ規約で作った値を渡すこと。
  costRT?: number;
}

// ---------- 数値ユーティリティ ----------
// mulberry32: 再現性のあるシード付き乱数（Bootstrapで使用）
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 誤差関数と標準正規CDF（正規近似のp値に使用）
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// tTest は両側p。平均の符号から片側（H1: 平均>0）のp値を得る。
function oneSidedTP(arr: number[]): { t: number; pOneSided: number } | null {
  const r = tTest(arr);
  if (!r) return null;
  const m = mean(arr);
  const pOne = m > 0 ? r.p / 2 : 1 - r.p / 2;
  return { t: r.t, pOneSided: pOne };
}

// ---------- 区間(segment)分解 ----------
// 各営業日 i に対し始値=ordinal 2i, 終値=2i+1。
//   intraday_i : 区間開始ordinal 2i   → その日の終値で確定（log open_i→close_i）
//   overnight_i: 区間開始ordinal 2i+1 → 翌営業日始値で確定（log close_i→open_{i+1}）
interface Seg {
  logret: number;
  isClose: boolean; // 日中区間（その日の終値で確定）か
}

function buildSegments(prices: PricePoint[]): Seg[] {
  const segs: Seg[] = [];
  for (let i = 0; i < prices.length; i++) {
    const o = prices[i].open, c = prices[i].close;
    segs.push({ logret: o > 0 && c > 0 ? Math.log(c / o) : 0, isClose: true }); // intraday_i
    if (i < prices.length - 1) {
      const o2 = prices[i + 1].open;
      segs.push({ logret: c > 0 && o2 > 0 ? Math.log(o2 / c) : 0, isClose: false }); // overnight_i
    }
  }
  return segs;
}

// ---------- 出力型 ----------
export interface Metrics {
  totalReturn: number; // 累積リターン（0始まり）
  annualized: number; // 幾何年率
  sharpe: number; // 年率Sharpe（日次から）
  maxDD: number; // 最大ドローダウン（負値）
  exposure: number; // 市場滞在率（区間ベース 0..1）
}

export interface EquityRow {
  time: string; // "YYYY-MM-DD"
  strat: number; // 戦略の累積リターン
  bh: number; // B&Hの累積リターン
}

export interface WeekendTest {
  nWeeks: number;
  excessMeanWeekly: number; // 週次超過 e_w の平均（簡易リターン）
  excessMedianWeekly: number;
  meanSkip: number; // 捨てた区間の平均対数リターン（週あたり合計の平均）
  weekendGapMean: number | null; // 金終値→次営業日始値（週末ギャップ）区間の平均（参考）
  t: number | null;
  pOneSided: number | null; // H1: 戦略>B&H
  bootLo: number | null; // 週次超過平均の95%CI下限
  bootHi: number | null;
  bootProbPositive: number | null; // Bootで超過平均>0となる割合
}

export interface RobustTest {
  nWeeks: number;
  posFraction: number; // e_w>0 の割合
  wilcoxonZ: number | null;
  wilcoxonP: number | null; // 片側 H1: 中央値>0
  signZ: number | null;
  signP: number | null; // 片側
}

export interface SharpeDiffTest {
  sharpeStrat: number;
  sharpeBH: number;
  delta: number; // 年率Sharpe差（戦略 − B&H）
  jkmZ: number | null;
  jkmP: number | null; // 片側 H1: 差>0
  bootLo: number | null;
  bootHi: number | null;
  bootProbPositive: number | null;
}

export interface AnnualDiffTest {
  delta: number; // 年率リターン差（戦略 − B&H）
  lo: number; // 95%CI
  hi: number;
  probPositive: number;
}

// 損益分岐コスト。コスト控除の ON/OFF に依らず、常にコスト前の週次超過 e_w から算出する。
// 「この戦略のエッジは往復◯bp まで吸収できる」を出し、利用者が自分の手数料と突き合わせられるようにする。
// スプレッド推定（Corwin-Schultz）自体が誤差の大きい推定量なので、単一の ON/OFF より
// 損益分岐のほうが判断材料として頑健である（docs/weekday-vs-bh-cost.md §6.1）。
export interface BreakevenInfo {
  perRoundTripMean: number; // c*      = mean(e_w)：期待値がゼロになる往復コスト（負なら吸収余地なし）
  perRoundTripSig95: number; // c*(95%) = mean − 1.645·σ/√n：片側5%で有意でなくなる往復コスト
  tripsPerYearStrat: number; // 戦略の回転率（≈52往復/年）
  tripsPerYearBH: number; // B&H の回転率（= 1/years）
  spreadRT: number; // representativeSpread(prices)（参考表示）
  annualDragAtSpread: number; // 推定スプレッドで年間いくら削られるか（対数、正値）
}

export interface VsBHResult {
  meta: {
    entryTiming: Timing;
    exitTiming: Timing;
    nDays: number;
    years: number;
    nWeeks: number;
    costRT: number; // 実際に適用した往復コスト
    roundTrips: number; // 期間内の戦略側往復回数（レグ数/2）
  };
  metrics: { strat: Metrics; bh: Metrics };
  equity: EquityRow[];
  weekend: WeekendTest;
  robust: RobustTest;
  sharpe: SharpeDiffTest;
  annual: AnnualDiffTest;
  breakeven: BreakevenInfo;
}

// ---------- 指標計算 ----------
function metricsFromDaily(dailyRet: number[], nDays: number, exposure: number): Metrics {
  const total = dailyRet.reduce((w, r) => w * (1 + r), 1) - 1;
  const years = nDays / 252 || 1;
  const annualized = Math.pow(1 + total, 1 / years) - 1;
  const m = mean(dailyRet), s = std(dailyRet);
  const sharpe = s > 0 ? (m / s) * Math.sqrt(252) : 0;
  // 最大DD
  let W = 1, peak = 1, maxDD = 0;
  for (const r of dailyRet) {
    W *= 1 + r;
    peak = Math.max(peak, W);
    const dd = (W - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return { totalReturn: total, annualized, sharpe, maxDD, exposure };
}

// 幾何年率とSharpeを日次配列から（Bootstrap内で使用、順序に依らない統計）
function bootStats(dailyRet: number[]): { annual: number; sharpe: number } {
  const m = mean(dailyRet), s = std(dailyRet);
  const meanLog = mean(dailyRet.map((r) => Math.log(1 + r)));
  return { annual: Math.exp(252 * meanLog) - 1, sharpe: s > 0 ? (m / s) * Math.sqrt(252) : 0 };
}

// ---------- メイン ----------
export function computeVsBH(prices: PricePoint[], spec: VsBHSpec, seed = 20260710): VsBHResult | null {
  const n = prices.length;
  if (n < 40) return null;

  const segs = buildSegments(prices);
  const nSeg = segs.length;

  // 戦略の保有区間を、既存シミュレータと同じトレード定義から作る（数値を一致させる）。
  const trades = runStrategyTrades(prices, {
    entryDow: 1, entryTiming: spec.entryTiming, exitDow: 5, exitTiming: spec.exitTiming, side: "long",
  });
  if (trades.length < 5) return null;

  // 保有フラグ pos[s]∈{0,1}: 各トレードの保有ordinal範囲 [E, X-1] を立てる。
  const pos = new Array(nSeg).fill(0);
  for (const tr of trades) {
    const E = 2 * tr.entryIdx + (spec.entryTiming === "open" ? 0 : 1);
    const X = 2 * tr.exitIdx + (spec.exitTiming === "open" ? 0 : 1);
    for (let s = E; s < X && s < nSeg; s++) pos[s] = 1;
  }

  // ===== 取引コスト =====
  // 建玉 pos[] が変化する区間の先頭＝約定。そこに片道1レグを立てる。
  // legs[s] は「区間 s の先頭で発生するレグ数」、legs[nSeg] は期間末に建玉が残っていた場合の手仕舞い。
  const costRT = Number.isFinite(spec.costRT) && (spec.costRT as number) > 0
    ? Math.min(0.5, spec.costRT as number)
    : 0;
  const halfLegLog = costRT > 0 ? Math.log(1 - costRT) / 2 : 0; // 1レグ＝ln(1−c)/2（2レグで厳密に ln(1−c)）
  const legs = new Array(nSeg + 1).fill(0);
  {
    let prevP = 0;
    for (let s = 0; s < nSeg; s++) {
      if (pos[s] !== prevP) legs[s] += 1;
      prevP = pos[s];
    }
    if (prevP !== 0) legs[nSeg] += 1; // 最終週が期間末で切れている場合に畳む
  }
  let totalLegs = 0;
  for (const v of legs) totalLegs += v;

  // 日次リターン系列（戦略 / B&H）を区間から再構成。dailyW は各営業日の終値時点の富。
  // 約定日（月曜・金曜）に課金するので dailyStrat にのこぎり状の成分が入り σ がわずかに増える。
  // 「平均だけシフトさせた場合」より Sharpe の低下がわずかに大きくなるが、これは忠実さの代償であって
  // バグではない（docs/weekday-vs-bh-cost.md §7.3）。解析式 Δt = −c√n/σ は経路A（週次）には
  // 厳密に当てはまるが、経路Bの Sharpe には当てはまらない。
  let Ws = 1, Wb = 1;
  const dailyStrat: number[] = [];
  const dailyBH: number[] = [];
  const equity: EquityRow[] = [];
  let prevWs = 1, prevWb = 1;
  let held = 0;
  // B&H も現実には建てて畳むので期間全体で1往復ぶんを払う（回転率の非対称性を誠実に出すため）。
  Wb *= Math.exp(halfLegLog); // 期間先頭の買い付け
  for (let s = 0; s < nSeg; s++) {
    const r = Math.exp(segs[s].logret) - 1; // 区間の簡易リターン
    Wb *= 1 + r;
    if (legs[s] > 0) Ws *= Math.exp(halfLegLog * legs[s]); // 区間先頭で約定＝片道課金
    if (pos[s] === 1) { Ws *= 1 + r; held++; }
    if (s === nSeg - 1) {
      if (legs[nSeg] > 0) Ws *= Math.exp(halfLegLog * legs[nSeg]);
      Wb *= Math.exp(halfLegLog); // 期間末尾の売却
    }
    if (segs[s].isClose) {
      const i = s / 2; // 営業日index
      dailyStrat.push(Ws / prevWs - 1);
      dailyBH.push(Wb / prevWb - 1);
      prevWs = Ws; prevWb = Wb;
      equity.push({ time: prices[i].time, strat: Ws - 1, bh: Wb - 1 });
    }
  }
  const exposure = nSeg ? held / nSeg : 0;

  const metricsStrat = metricsFromDaily(dailyStrat, n, exposure);
  const metricsBH = metricsFromDaily(dailyBH, n, 1);

  // ===== 週次サンプル（トレード＝月→金サイクルごと）=====
  // サイクル w の範囲 [E_w, nextE-1]。B&H_w = Σ 全区間、戦略_w = Σ 保有区間、
  // 超過 e_w = 戦略_w − B&H_w = −(捨てた区間 [X_w, nextE-1])。
  const excessLog: number[] = []; // e_w（対数, コスト後）
  const excessSimple: number[] = []; // e_w（簡易, コスト後。表示・頑健検定用）
  const excessGross: number[] = []; // e_w（簡易, コスト前。Break-even の算出用）
  const skipLog: number[] = []; // 捨てた区間の合計対数（週あたり）
  const weekendGaps: number[] = []; // 金終値→次営業日始値の単一区間（参考）
  // B&H の1往復を週へ均等配分する。週次系列を均質に保つため（Wilcoxon・符号検定は標本の均質性を仮定）。
  // 金額としては ln(1−c)/446週 で無視できるが、経路A/Bの不変量を厳密に成立させるために入れる。
  const bhShare = trades.length > 0 ? (halfLegLog * 2) / trades.length : 0;
  for (let w = 0; w < trades.length; w++) {
    const tr = trades[w];
    const E = 2 * tr.entryIdx + (spec.entryTiming === "open" ? 0 : 1);
    const X = 2 * tr.exitIdx + (spec.exitTiming === "open" ? 0 : 1);
    const isLast = w + 1 >= trades.length;
    const nextE = !isLast
      ? 2 * trades[w + 1].entryIdx + (spec.entryTiming === "open" ? 0 : 1)
      : nSeg;
    let sHeld = 0, sAll = 0, sSkip = 0;
    for (let s = E; s < nextE && s < nSeg; s++) {
      sAll += segs[s].logret;
      if (s < X) sHeld += segs[s].logret;
      else sSkip += segs[s].logret;
    }
    // 経路Bと同一のレグ数で課金する（週の範囲 [E, nextE) に落ちるレグ。最終週は期間末の手仕舞いも含む）。
    // これにより Σ_w の合計が経路Bの総コストと厳密に一致し、§7.2 の不変量が成り立つ。
    let legLog = 0;
    for (let s = E; s < nextE && s < nSeg; s++) legLog += halfLegLog * legs[s];
    if (isLast) legLog += halfLegLog * legs[nSeg];
    // 対数側で引いてから exp する。単利側を −c で引くと O(c²) の不整合が生じ、
    // 同じコストのはずの①と③が違う結論を出す（§7.1）。
    excessLog.push(sHeld - sAll + legLog - bhShare);
    excessSimple.push(Math.exp(sHeld + legLog) - Math.exp(sAll + bhShare));
    excessGross.push(Math.exp(sHeld) - Math.exp(sAll));
    skipLog.push(sSkip);
    // 金曜終値の直後の区間（overnight_exitIdx）＝週末ギャップ
    const gapOrd = 2 * tr.exitIdx + 1;
    if (spec.exitTiming === "close" && gapOrd < nSeg && !segs[gapOrd].isClose) {
      weekendGaps.push(segs[gapOrd].logret);
    }
  }
  const nWeeks = excessLog.length;

  // ===== 1) 週末ギャップ検定（週次超過の片側t + Bootstrap CI）=====
  const tRes = oneSidedTP(excessLog);
  const wkBoot = blockBootMean(excessSimple, 1500, seed);
  const weekend: WeekendTest = {
    nWeeks,
    excessMeanWeekly: mean(excessSimple),
    excessMedianWeekly: median(excessSimple),
    meanSkip: mean(skipLog),
    weekendGapMean: weekendGaps.length ? mean(weekendGaps) : null,
    t: tRes ? tRes.t : null,
    pOneSided: tRes ? tRes.pOneSided : null,
    bootLo: wkBoot ? wkBoot.lo : null,
    bootHi: wkBoot ? wkBoot.hi : null,
    bootProbPositive: wkBoot ? wkBoot.probPositive : null,
  };

  // ===== 3) 頑健検定（Wilcoxon符号順位 + 符号検定）=====
  const robust = robustPairedTest(excessSimple);

  // ===== 2) Sharpe差検定（JKM 解析z + ペアBootstrap）=====
  const sharpe = sharpeDiffTest(dailyStrat, dailyBH, metricsStrat.sharpe, metricsBH.sharpe, seed + 1);

  // ===== 4) 年率差Bootstrap CI =====
  const annual = annualDiffTest(dailyStrat, dailyBH, seed + 2);

  // ===== Break-even（コスト前の e_w から算出。costRT の値には依らない）=====
  const years = n / 252;
  const roundTrips = totalLegs / 2;
  const gMean = mean(excessGross);
  const gSd = std(excessGross);
  const spreadRT = representativeSpread(prices);
  const breakeven: BreakevenInfo = {
    perRoundTripMean: gMean,
    // 片側5%（z=1.645）で有意でなくなる往復コスト。負なら「コストゼロでも有意でない」。
    perRoundTripSig95: nWeeks > 1 ? gMean - 1.645 * (gSd / Math.sqrt(nWeeks)) : gMean,
    tripsPerYearStrat: years > 0 ? roundTrips / years : 0,
    tripsPerYearBH: years > 0 ? 1 / years : 0,
    spreadRT,
    annualDragAtSpread:
      spreadRT > 0 && spreadRT < 1 && years > 0
        ? -Math.log(1 - spreadRT) * (roundTrips / years)
        : 0,
  };

  return {
    meta: {
      entryTiming: spec.entryTiming,
      exitTiming: spec.exitTiming,
      nDays: n,
      years,
      nWeeks,
      costRT,
      roundTrips,
    },
    metrics: { strat: metricsStrat, bh: metricsBH },
    equity,
    weekend,
    robust,
    sharpe,
    annual,
    breakeven,
  };
}

// ---------- 検定の実装 ----------

// 移動ブロックBootstrapで平均の95%CIと「平均>0の割合」を推定（系列相関に頑健）。
function blockBootMean(
  data: number[],
  B: number,
  seed: number
): { lo: number; hi: number; probPositive: number } | null {
  const n = data.length;
  if (n < 8) return null;
  const rng = mulberry32(seed);
  const L = Math.max(1, Math.round(Math.cbrt(n)));
  const nBlocks = Math.ceil(n / L);
  const samples: number[] = [];
  let pos = 0;
  for (let b = 0; b < B; b++) {
    let sum = 0, cnt = 0;
    for (let blk = 0; blk < nBlocks && cnt < n; blk++) {
      const start = Math.floor(rng() * n);
      for (let j = 0; j < L && cnt < n; j++) { sum += data[(start + j) % n]; cnt++; }
    }
    const m = sum / cnt;
    samples.push(m);
    if (m > 0) pos++;
  }
  samples.sort((a, b) => a - b);
  return { lo: quantileSorted(samples, 0.025), hi: quantileSorted(samples, 0.975), probPositive: pos / B };
}

// Wilcoxon符号順位検定 + 符号検定（片側 H1: 中央値>0）。同順位は平均順位で処理。
function robustPairedTest(d: number[]): RobustTest {
  const nz = d.filter((v) => v !== 0);
  const n = nz.length;
  const posFraction = d.length ? d.filter((v) => v > 0).length / d.length : 0;
  if (n < 8) {
    return { nWeeks: d.length, posFraction, wilcoxonZ: null, wilcoxonP: null, signZ: null, signP: null };
  }
  // --- Wilcoxon符号順位 ---
  const abs = nz.map((v, i) => ({ a: Math.abs(v), sign: v > 0 ? 1 : -1, i })).sort((x, y) => x.a - y.a);
  const ranks = new Array(n).fill(0);
  let k = 0;
  while (k < n) {
    let j = k;
    while (j + 1 < n && abs[j + 1].a === abs[k].a) j++;
    const avgRank = (k + 1 + j + 1) / 2; // 1始まりの平均順位
    for (let t = k; t <= j; t++) ranks[t] = avgRank;
    k = j + 1;
  }
  let Wplus = 0;
  for (let t = 0; t < n; t++) if (abs[t].sign > 0) Wplus += ranks[t];
  const muW = (n * (n + 1)) / 4;
  const varW = (n * (n + 1) * (2 * n + 1)) / 24;
  const zW = varW > 0 ? (Wplus - muW) / Math.sqrt(varW) : 0;
  const pW = 1 - normalCdf(zW); // 片側 H1: 正に偏る

  // --- 符号検定（正規近似）---
  const kPos = nz.filter((v) => v > 0).length;
  const zS = (kPos - n / 2) / Math.sqrt(n / 4);
  const pS = 1 - normalCdf(zS);

  return { nWeeks: d.length, posFraction, wilcoxonZ: zW, wilcoxonP: pW, signZ: zS, signP: pS };
}

// Jobson–Korkie–Memmel の Sharpe差検定 + ペア・ブロックBootstrap。
// JKM分散: θ = (1/T)[2(1−ρ) + ½(SRa² + SRb² − 2·SRa·SRb·ρ²)]、z = (SRa−SRb)/√θ。
// （SR は日次Sharpe。iid正規を仮定するため、頑健化のためBootstrapも併記）
function sharpeDiffTest(
  a: number[],
  b: number[],
  sharpeAnnA: number,
  sharpeAnnB: number,
  seed: number
): SharpeDiffTest {
  const T = a.length;
  const delta = sharpeAnnA - sharpeAnnB;
  let jkmZ: number | null = null, jkmP: number | null = null;
  if (T > 30) {
    const ma = mean(a), mb = mean(b), sa = std(a), sb = std(b);
    if (sa > 0 && sb > 0) {
      let cov = 0;
      for (let i = 0; i < T; i++) cov += (a[i] - ma) * (b[i] - mb);
      cov /= T - 1;
      const rho = cov / (sa * sb);
      const sra = ma / sa, srb = mb / sb; // 日次Sharpe
      const theta = (1 / T) * (2 * (1 - rho) + 0.5 * (sra * sra + srb * srb - 2 * sra * srb * rho * rho));
      if (theta > 0) {
        jkmZ = (sra - srb) / Math.sqrt(theta);
        jkmP = 1 - normalCdf(jkmZ); // 片側 H1: 戦略>B&H
      }
    }
  }
  // ペア・ブロックBootstrap（同一ブロック添字で両系列を再標本化）
  const boot = pairedBlockBoot(a, b, 1500, seed, (ra, rb) => bootStats(ra).sharpe - bootStats(rb).sharpe);
  return {
    sharpeStrat: sharpeAnnA,
    sharpeBH: sharpeAnnB,
    delta,
    jkmZ,
    jkmP,
    bootLo: boot ? boot.lo : null,
    bootHi: boot ? boot.hi : null,
    bootProbPositive: boot ? boot.probPositive : null,
  };
}

// 年率リターン差のペア・ブロックBootstrap CI。
function annualDiffTest(a: number[], b: number[], seed: number): AnnualDiffTest {
  const delta = bootStats(a).annual - bootStats(b).annual;
  const boot = pairedBlockBoot(a, b, 1500, seed, (ra, rb) => bootStats(ra).annual - bootStats(rb).annual);
  return {
    delta,
    lo: boot ? boot.lo : delta,
    hi: boot ? boot.hi : delta,
    probPositive: boot ? boot.probPositive : delta > 0 ? 1 : 0,
  };
}

// 2系列を同一の移動ブロック添字で再標本化し、statistic(ra,rb) の分布から95%CIと正の割合を返す。
function pairedBlockBoot(
  a: number[],
  b: number[],
  B: number,
  seed: number,
  statistic: (ra: number[], rb: number[]) => number
): { lo: number; hi: number; probPositive: number } | null {
  const n = a.length;
  if (n < 30) return null;
  const rng = mulberry32(seed);
  const L = Math.max(1, Math.round(Math.cbrt(n)));
  const nBlocks = Math.ceil(n / L);
  const samples: number[] = [];
  let pos = 0;
  const ra: number[] = [], rb: number[] = [];
  for (let bIter = 0; bIter < B; bIter++) {
    ra.length = 0; rb.length = 0;
    for (let blk = 0; blk < nBlocks && ra.length < n; blk++) {
      const start = Math.floor(rng() * n);
      for (let j = 0; j < L && ra.length < n; j++) {
        const idx = (start + j) % n;
        ra.push(a[idx]); rb.push(b[idx]);
      }
    }
    const v = statistic(ra, rb);
    if (Number.isFinite(v)) {
      samples.push(v);
      if (v > 0) pos++;
    }
  }
  if (samples.length < 10) return null;
  samples.sort((x, y) => x - y);
  return { lo: quantileSorted(samples, 0.025), hi: quantileSorted(samples, 0.975), probPositive: pos / samples.length };
}
