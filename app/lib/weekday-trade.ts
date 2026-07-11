// 曜日トレード・シミュレータの計算ロジック
// 任意の曜日 × 注文タイミング(始値/終値)で売買した場合の累積リターンを算出し、
// バイ&ホールドと比較するための純粋関数群。
import { PricePoint } from "./types";

export type Timing = "open" | "close";
export type Side = "long" | "short";

export interface TradeSpec {
  entryDow: number; // 1=月 .. 5=金 (Date.getDay() と同じ)
  entryTiming: Timing;
  exitDow: number;
  exitTiming: Timing;
  side: Side;
}

interface DayPt {
  t: number; // 時刻(ms)
  dow: number;
  open: number;
  close: number;
}

function toDayPts(prices: PricePoint[]): DayPt[] {
  return prices.map((p) => {
    const d = new Date(p.time);
    return { t: d.getTime(), dow: d.getDay(), open: p.open, close: p.close };
  });
}

export interface Trade {
  entryIdx: number;
  exitIdx: number;
  entryT: number;
  exitT: number;
  ret: number; // side適用後の符号付きリターン
}

// イベント順序(ordinal): 各営業日に対し始値=2*i, 終値=2*i+1。
// これにより「同日内で始値→終値」「翌週まで持ち越し」を一貫して判定する。
export function runStrategyTrades(prices: PricePoint[], spec: TradeSpec): Trade[] {
  const pts = toDayPts(prices);
  const n = pts.length;
  const trades: Trade[] = [];
  let i = 0;
  while (i < n) {
    if (pts[i].dow !== spec.entryDow) {
      i++;
      continue;
    }
    const entryOrd = 2 * i + (spec.entryTiming === "open" ? 0 : 1);
    const entryPrice = spec.entryTiming === "open" ? pts[i].open : pts[i].close;
    let exitIdx = -1;
    let exitPrice = 0;
    for (let j = i; j < n; j++) {
      if (pts[j].dow !== spec.exitDow) continue;
      const exitOrd = 2 * j + (spec.exitTiming === "open" ? 0 : 1);
      if (exitOrd > entryOrd) {
        exitIdx = j;
        exitPrice = spec.exitTiming === "open" ? pts[j].open : pts[j].close;
        break;
      }
    }
    if (exitIdx < 0) break; // これ以上トレード成立せず
    if (entryPrice > 0 && exitPrice > 0) {
      const rLong = exitPrice / entryPrice - 1;
      const ret = spec.side === "long" ? rLong : -rLong;
      trades.push({ entryIdx: i, exitIdx, entryT: pts[i].t, exitT: pts[exitIdx].t, ret });
    }
    i = exitIdx + 1; // ポジション解消後の翌日から次のエントリーを探索
  }
  return trades;
}

export interface EquityPoint {
  t: number;
  v: number;
}

export interface StrategyResult {
  trades: Trade[];
  equity: EquityPoint[]; // v = 累積リターン(0始まり)
  totalReturn: number;
  nTrades: number;
  winRate: number;
  avgTrade: number;
  stdTrade: number;
  sharpe: number; // トレード単位Sharpeを年率化
  maxDD: number; // 負の値
  exposure: number; // 市場滞在率(0..1)
  heldDays: number; // 延べ市場滞在日数(Σ exitIdx−entryIdx+1)
  annualized: number;
}

export function computeStrategy(prices: PricePoint[], spec: TradeSpec, compound: boolean): StrategyResult {
  const trades = runStrategyTrades(prices, spec);
  const equity: EquityPoint[] = [];
  let cum = 1;
  let sum = 0;
  if (trades.length > 0) equity.push({ t: trades[0].entryT, v: 0 });
  for (const tr of trades) {
    if (compound) {
      cum *= 1 + tr.ret;
      equity.push({ t: tr.exitT, v: cum - 1 });
    } else {
      sum += tr.ret;
      equity.push({ t: tr.exitT, v: sum });
    }
  }
  const rets = trades.map((t) => t.ret);
  const total = equity.length ? equity[equity.length - 1].v : 0;
  const nTrades = trades.length;
  const wins = rets.filter((r) => r > 0).length;
  const avg = rets.length ? rets.reduce((s, v) => s + v, 0) / rets.length : 0;
  const variance = rets.length > 1 ? rets.reduce((s, v) => s + (v - avg) ** 2, 0) / (rets.length - 1) : 0;
  const sd = Math.sqrt(variance);

  const totalDays = prices.length;
  const years = totalDays / 252 || 1;
  const tradesPerYear = nTrades / years;
  const sharpe = sd > 0 ? (avg / sd) * Math.sqrt(tradesPerYear) : 0;

  let held = 0;
  for (const tr of trades) held += tr.exitIdx - tr.entryIdx + 1;
  const exposure = totalDays ? Math.min(1, held / totalDays) : 0;

  let peak = -Infinity;
  let maxDD = 0;
  for (const e of equity) {
    const w = 1 + e.v; // 富(wealth)に換算してDDを測る
    peak = Math.max(peak, w);
    const dd = (w - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  const annualized = compound ? Math.pow(1 + total, 1 / years) - 1 : total / years;
  return {
    trades,
    equity,
    totalReturn: total,
    nTrades,
    winRate: nTrades ? wins / nTrades : 0,
    avgTrade: avg,
    stdTrade: sd,
    sharpe,
    maxDD,
    exposure,
    heldDays: held,
    annualized,
  };
}

export function buyHoldEquity(prices: PricePoint[], compound: boolean): EquityPoint[] {
  if (prices.length < 1) return [];
  const out: EquityPoint[] = [];
  const c0 = prices[0].close || 1;
  let sum = 0;
  for (let i = 0; i < prices.length; i++) {
    const t = new Date(prices[i].time).getTime();
    if (compound) {
      out.push({ t, v: prices[i].close / c0 - 1 });
    } else {
      if (i > 0) sum += (prices[i].close - prices[i - 1].close) / (prices[i - 1].close || 1);
      out.push({ t, v: sum });
    }
  }
  return out;
}

export interface BHMetrics {
  totalReturn: number;
  annualized: number;
  maxDD: number;
  sharpe: number;
}

export function buyHoldMetrics(prices: PricePoint[], compound: boolean): BHMetrics {
  const eq = buyHoldEquity(prices, compound);
  const total = eq.length ? eq[eq.length - 1].v : 0;
  const years = prices.length / 252 || 1;
  const annualized = compound ? Math.pow(1 + total, 1 / years) - 1 : total / years;
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) rets.push((prices[i].close - prices[i - 1].close) / (prices[i - 1].close || 1));
  const avg = rets.length ? rets.reduce((s, v) => s + v, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, v) => s + (v - avg) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = sd > 0 ? (avg / sd) * Math.sqrt(252) : 0;
  let peak = -Infinity;
  let maxDD = 0;
  for (const e of eq) {
    const w = 1 + e.v;
    peak = Math.max(peak, w);
    const dd = (w - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return { totalReturn: total, annualized, maxDD, sharpe };
}

// =============================================================
// 週内プラン（複数レグ連結）: セグメント×ポジションベクトル方式
// -------------------------------------------------------------
// すべてを「価格イベント間の区間(segment)」に分解し、各区間に目標ポジション
// (+1 long / -1 short / 0 flat)を割り当てて全区間の積で1本のエクイティを作る。
//   ・日中(intraday) :  open_i → close_i        return = close_i/open_i − 1
//   ・オーバーナイト   :  close_i → open_{i+1}    return = open_{i+1}/close_i − 1
// 区間index:  intraday_i = 2i,  overnight_i = 2i+1  （総数 2n−1）
// これによりバイ&ホールドは「全区間 pos=+1」の特殊ケースとなり、戦略と同一基盤で
// 公平に比較できる。複数レグを並べれば exposure を 1.0 に近づけられる。
// =============================================================

export type PlanGapFill = "cash" | "hold";

export interface PlanResult {
  equity: EquityPoint[]; // 日次。v = 累積リターン(0始まり)
  totalReturn: number;
  grossReturn: number; // コスト控除前
  annualized: number;
  sharpe: number;
  maxDD: number;
  exposure: number; // 非ゼロ区間の割合(0..1)
  nTurnovers: number; // ポジション変更回数(往復で2)
  totalCost: number; // コストで失った富の割合(近似, 富比)
  nSegments: number;
}

export interface Segment {
  ret: number;
  t: number;
  isClose: boolean; // 日中区間(=その日の終値で確定)か
  days: number; // 持ち越し暦日数(日中=0, オーバーナイト=翌立会日までの暦日数)。信用金利・貸株料の日割り計算用。
}

function buildSegments(pts: DayPt[]): Segment[] {
  const segs: Segment[] = [];
  for (let i = 0; i < pts.length; i++) {
    // intraday_i (同日内なので持ち越し0日)
    const o = pts[i].open, c = pts[i].close;
    segs.push({ ret: o > 0 ? c / o - 1 : 0, t: pts[i].t, isClose: true, days: 0 });
    // overnight_i (最終日には存在しない)。金→月は暦日で3日=週末分の金利が乗る。
    if (i < pts.length - 1) {
      const c2 = pts[i + 1].open;
      const days = Math.max(1, Math.round((pts[i + 1].t - pts[i].t) / 86400000));
      segs.push({ ret: c > 0 ? c2 / c - 1 : 0, t: pts[i + 1].t, isClose: false, days });
    }
  }
  return segs;
}

// 1レグを「毎週」スキャンし、覆うセグメント区間 [first,last] を pos に書き込む。
// gapFill==="hold" は置換(overlay)、"cash" は加算(複数ロングで exposure を積む)。
function applyLeg(pts: DayPt[], pos: number[], leg: TradeSpec, gapFill: PlanGapFill): void {
  const n = pts.length;
  const sgn = leg.side === "long" ? 1 : -1;
  let i = 0;
  while (i < n) {
    if (pts[i].dow !== leg.entryDow) { i++; continue; }
    const entryOrd = 2 * i + (leg.entryTiming === "open" ? 0 : 1);
    let j = -1;
    for (let k = i; k < n; k++) {
      if (pts[k].dow !== leg.exitDow) continue;
      const exitOrd = 2 * k + (leg.exitTiming === "open" ? 0 : 1);
      if (exitOrd > entryOrd) { j = k; break; }
    }
    if (j < 0) break;
    const first = 2 * i + (leg.entryTiming === "open" ? 0 : 1);
    const last = leg.exitTiming === "open" ? 2 * j - 1 : 2 * j;
    const lo = Math.max(0, first), hi = Math.min(pos.length - 1, last);
    for (let s = lo; s <= hi; s++) {
      pos[s] = gapFill === "hold" ? sgn : pos[s] + sgn;
    }
    i = j + 1;
  }
}

// セグメント列とセグメント毎の目標ポジション(-1..+1)を構築する。
// computePlan と後段の税シミュレータ(nisa-vs-taxable.ts)が同一のプレタックス経路を
// 共有できるよう、ここを唯一の生成源とする。
export interface PositionVector {
  segs: Segment[];
  pos: number[]; // segs と同長。各区間の目標ポジション(-1/0/+1)
}

export function buildPositionVector(prices: PricePoint[], legs: TradeSpec[], gapFill: PlanGapFill): PositionVector {
  const pts = toDayPts(prices);
  const segs = buildSegments(pts);
  const nSeg = segs.length;
  // ポジションベクトル: hold は既定+1(常時ロング)を legs が置換、cash は既定0を加算
  const pos = new Array(nSeg).fill(gapFill === "hold" ? 1 : 0);
  for (const leg of legs) applyLeg(pts, pos, leg, gapFill);
  // 加算モードはレバレッジを避けるため [-1,1] にクランプ
  for (let s = 0; s < nSeg; s++) pos[s] = Math.max(-1, Math.min(1, pos[s]));
  return { segs, pos };
}

// セグメント列 + 目標ポジションベクトルから富の推移(エクイティ)と諸指標を計算する共通ルーチン。
// computePlan(固定プラン)と computeWalkForward(逐次)で同一の会計・コスト・年率化を共有する。
function equityFromPositions(
  pts: DayPt[],
  segs: Segment[],
  pos: number[],
  costBps: number,
  compound: boolean,
): PlanResult {
  const n = pts.length;
  const nSeg = segs.length;
  const empty: PlanResult = {
    equity: [], totalReturn: 0, grossReturn: 0, annualized: 0, sharpe: 0,
    maxDD: 0, exposure: 0, nTurnovers: 0, totalCost: 0, nSegments: nSeg,
  };
  if (n < 2 || nSeg < 1) return empty;

  const costRate = costBps / 10000;
  let W = 1, Wg = 1; // 純資産 / グロス(コスト控除前)
  let prevPos = 0, nTurn = 0, inMarket = 0;
  const dailyW: number[] = [];
  for (let s = 0; s < nSeg; s++) {
    const p = pos[s];
    if (p !== prevPos) {
      const turn = Math.abs(p - prevPos);
      W *= 1 - costRate * turn;
      nTurn++;
      prevPos = p;
    }
    if (p !== 0) inMarket++;
    const m = 1 + p * segs[s].ret;
    W *= m; Wg *= m;
    if (segs[s].isClose) dailyW.push(W); // その日の終値時点の富
  }
  // 最終ポジションを手仕舞う際のコスト
  if (prevPos !== 0) { W *= 1 - costRate * Math.abs(prevPos); nTurn++; }

  // 日次リターン → エクイティ
  const dailyRet: number[] = [];
  for (let i = 0; i < dailyW.length; i++) dailyRet.push(dailyW[i] / (i > 0 ? dailyW[i - 1] : 1) - 1);
  const equity: EquityPoint[] = [];
  let cum = 1, sum = 0;
  // 日次の時刻は intraday 区間の時刻(=その営業日)
  for (let i = 0; i < dailyW.length; i++) {
    if (compound) { cum *= 1 + dailyRet[i]; equity.push({ t: pts[i].t, v: cum - 1 }); }
    else { sum += dailyRet[i]; equity.push({ t: pts[i].t, v: sum }); }
  }

  const total = equity.length ? equity[equity.length - 1].v : 0;
  const gross = Wg - 1;
  const years = n / 252 || 1;
  const annualized = compound ? Math.pow(1 + total, 1 / years) - 1 : total / years;
  const avg = dailyRet.length ? dailyRet.reduce((a, b) => a + b, 0) / dailyRet.length : 0;
  const variance = dailyRet.length > 1 ? dailyRet.reduce((a, v) => a + (v - avg) ** 2, 0) / (dailyRet.length - 1) : 0;
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? (avg / sd) * Math.sqrt(252) : 0;

  let peak = -Infinity, maxDD = 0;
  for (const e of equity) {
    const w = 1 + e.v;
    peak = Math.max(peak, w);
    const dd = (w - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  return {
    equity, totalReturn: total, grossReturn: gross, annualized, sharpe, maxDD,
    exposure: nSeg ? inMarket / nSeg : 0,
    nTurnovers: nTurn,
    totalCost: gross - total,
    nSegments: nSeg,
  };
}

export function computePlan(
  prices: PricePoint[],
  legs: TradeSpec[],
  gapFill: PlanGapFill,
  costBps: number,
  compound: boolean,
): PlanResult {
  const pts = toDayPts(prices);
  const { segs, pos } = buildPositionVector(prices, legs, gapFill);
  return equityFromPositions(pts, segs, pos, costBps, compound);
}

// =============================================================
// 逐次(ウォークフォワード)運用
// -------------------------------------------------------------
// 各営業週について、その週が始まる直前の「直近 lookback 本」だけで最適プラン
// (bestCombination の10スロット・サイド)を求め、その週の売買にそのまま適用する。
// 週が進むごとに学習窓をスライドして再最適化するため、各週の建玉は
// 「その時点までに観測可能な情報のみ」で決まる真のアウトオブサンプル運用になる。
// 学習に使える履歴が不足する序盤は建玉なし(cash)/常時ロング(hold)のまま待機する。
// =============================================================
export interface WalkForwardResult extends PlanResult {
  nWeeks: number;         // 履歴中の総営業週数
  nActiveWeeks: number;   // 実際に最適化して売買した週数(学習データが足りた週)
  firstTradeDate: string | null; // 最初に売買を開始した週の初日
  lookback: number;       // 使用した学習窓長(本)
}

// 週境界の判定: 曜日が前日以下になった位置を新しい週の開始とみなす(祝日で月曜等が飛んでも頑健)。
function weekStartIndices(pts: DayPt[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0 || pts[i].dow <= pts[i - 1].dow) starts.push(i);
  }
  return starts;
}

export function computeWalkForward(
  prices: PricePoint[],
  lookback: number,     // 学習窓長(本)。<=0 で全利用可能履歴
  gapFill: PlanGapFill,
  costBps: number,
  compound: boolean,
  minTrainBars = 25,    // 最低学習本数(約5週。これ未満の週は待機)
): WalkForwardResult {
  const pts = toDayPts(prices);
  const n = pts.length;
  const segs = buildSegments(pts);
  const nSeg = segs.length;
  const pos: number[] = new Array(nSeg).fill(gapFill === "hold" ? 1 : 0);
  const starts = weekStartIndices(pts);

  let nActiveWeeks = 0;
  let firstTradeIdx = -1;
  for (let g = 0; g < starts.length; g++) {
    const startIdx = starts[g];
    const endIdx = (g + 1 < starts.length ? starts[g + 1] : n) - 1;
    const from = lookback > 0 ? Math.max(0, startIdx - lookback) : 0;
    if (startIdx - from < minTrainBars) continue; // 学習データ不足 → この週は待機(既定ポジション)

    const combo = bestCombination(prices.slice(from, startIdx), compound);
    const sides = combo.slots.map((s) => s.side);
    nActiveWeeks++;
    if (firstTradeIdx < 0) firstTradeIdx = startIdx;

    // この週の各営業日の日中/オーバーナイト・セグメントに、学習窓のサイドを書き込む。
    for (let i = startIdx; i <= endIdx; i++) {
      const D = pts[i].dow;
      if (D < 1 || D > 5) continue;
      const sgn = (slot: number): number => {
        const sd = sides[slot];
        return sd === "long" ? 1 : sd === "short" ? -1 : (gapFill === "hold" ? 1 : 0);
      };
      pos[2 * i] = sgn(2 * (D - 1));                       // 日中
      if (2 * i + 1 < nSeg) pos[2 * i + 1] = sgn(2 * (D - 1) + 1); // オーバーナイト(金曜は週末ギャップ)
    }
  }

  const base = equityFromPositions(pts, segs, pos, costBps, compound);
  return {
    ...base,
    nWeeks: starts.length,
    nActiveWeeks,
    firstTradeDate: firstTradeIdx >= 0 ? prices[firstTradeIdx].time : null,
    lookback: lookback > 0 ? lookback : n,
  };
}

// =============================================================
// 最適プラン（買+売の非重複組合せ）
// -------------------------------------------------------------
// 週内クロックを 10 の「スロット(価格イベント間の区間)」に分解する:
//   偶数スロット 2(D-1)   = 曜日D の日中 (D始値→D終値)
//   奇数スロット 2(D-1)+1 = 曜日D 後のオーバーナイト (D終値→翌営業日始値)
//   ※ 金曜後(奇数, D=5, スロット9)は週末ギャップ(金終→月始)。
// プランの富は W = Π_s Π_(スロットsの各出現) (1 + pos_s · r) と書け、スロット毎に
// 因数分解できる。したがって各スロットの pos∈{+1(買),-1(売),0(無)} を独立に選んで
// そのスロットの累積富を最大化すれば、(無レバ・単位ポジション・非重複という枠内で)
// 大域的に最大リターンの組合せが得られる。連続する同符号スロットを環状に連結して
// レグ列(TradeSpec[])に戻すと、そのまま連結モードで再現できる。
// =============================================================

export interface ComboSlot {
  slot: number; // 0..9
  side: Side | "flat";
  n: number;
  longW: number; // 買いで通したときの富(compound)/1+Σr(単純)
  shortW: number; // 売りで通したときの富
}

export interface BestCombination {
  legs: TradeSpec[];
  slots: ComboSlot[];
  nLong: number;
  nShort: number;
  coverage: number; // 非flatスロットの割合(0..1)=週内滞在率
}

// スロット境界 → (曜日, タイミング)
function slotStart(slot: number): { dow: number; timing: Timing } {
  const D = Math.floor(slot / 2) + 1; // 1..5
  return slot % 2 === 0 ? { dow: D, timing: "open" } : { dow: D, timing: "close" };
}
function slotEnd(slot: number): { dow: number; timing: Timing } {
  const D = Math.floor(slot / 2) + 1;
  // 偶数(日中): D終値で確定 / 奇数(オーバーナイト): 翌営業日始値で確定(金→月)
  return slot % 2 === 0 ? { dow: D, timing: "close" } : { dow: D === 5 ? 1 : D + 1, timing: "open" };
}

// 各スロットの最適サイドから、連続する同符号ランを環状に連結してレグ列を作る。
function mergeSlotsToLegs(slots: ComboSlot[]): TradeSpec[] {
  const sides = slots.map((s) => s.side);
  if (sides.every((s) => s === "flat")) return [];
  // 前スロットと符号が変わる位置を開始点にする(全て同符号なら start=0 のまま=週内連続1レグ)。
  let start = 0;
  for (let k = 0; k < 10; k++) {
    if (sides[k] !== sides[(k + 9) % 10]) { start = k; break; }
  }
  const legs: TradeSpec[] = [];
  let k = 0;
  while (k < 10) {
    const s = (start + k) % 10;
    const side = sides[s];
    if (side === "flat") { k++; continue; }
    let len = 1;
    while (k + len < 10 && sides[(start + k + len) % 10] === side) len++;
    const st = slotStart(s);
    const en = slotEnd((start + k + len - 1) % 10);
    legs.push({ entryDow: st.dow, entryTiming: st.timing, exitDow: en.dow, exitTiming: en.timing, side: side as Side });
    k += len;
  }
  return legs;
}

// スロット毎のサイド指定(長さ10, 0=月日中..9=金オーバーナイト)からレグ列を組む。
// 手動の週内スロット・グリッドUIから戦略を構築する用途。
export function legsFromSlotSides(sides: (Side | "flat")[]): TradeSpec[] {
  const padded: (Side | "flat")[] = Array.from({ length: 10 }, (_, i) => sides[i] ?? "flat");
  return mergeSlotsToLegs(padded.map((side, slot) => ({ slot, side, n: 0, longW: 0, shortW: 0 })));
}

export function bestCombination(prices: PricePoint[], compound: boolean, minSamples = 5): BestCombination {
  const pts = toDayPts(prices);
  const n = pts.length;
  const slotRets: number[][] = Array.from({ length: 10 }, () => []);
  for (let i = 0; i < n; i++) {
    const D = pts[i].dow;
    if (D < 1 || D > 5) continue;
    const o = pts[i].open, c = pts[i].close;
    if (o > 0) slotRets[2 * (D - 1)].push(c / o - 1); // 日中
    if (i < n - 1 && c > 0) slotRets[2 * (D - 1) + 1].push(pts[i + 1].open / c - 1); // オーバーナイト
  }
  const slots: ComboSlot[] = slotRets.map((rets, slot) => {
    let longW: number, shortW: number;
    if (compound) {
      longW = rets.reduce((w, r) => w * (1 + r), 1);
      shortW = rets.reduce((w, r) => w * (1 - r), 1);
    } else {
      const sum = rets.reduce((a, b) => a + b, 0);
      longW = 1 + sum;
      shortW = 1 - sum;
    }
    // 富を最大化: max(買W, 売W, 1)。両方 <1(高ボラ・ゼロドリフトのボラ引き)なら無ポジが最良。
    let side: Side | "flat" = "flat";
    if (rets.length >= minSamples) {
      if (longW >= shortW && longW > 1) side = "long";
      else if (shortW > 1) side = "short";
    }
    return { slot, side, n: rets.length, longW, shortW };
  });
  const legs = mergeSlotsToLegs(slots);
  const nLong = slots.filter((s) => s.side === "long").length;
  const nShort = slots.filter((s) => s.side === "short").length;
  return { legs, slots, nLong, nShort, coverage: (nLong + nShort) / 10 };
}

export type MatrixMetric = "perDay" | "total" | "sharpe" | "winRate";

// 全25通り(エントリー曜日 × エグジット曜日)の指標グリッド。row=エントリー, col=エグジット (0=月..4=金)
export function weekdayMatrix(
  prices: PricePoint[],
  entryTiming: Timing,
  exitTiming: Timing,
  side: Side,
  compound: boolean,
  metric: MatrixMetric,
): (number | null)[][] {
  const grid: (number | null)[][] = [];
  for (let e = 1; e <= 5; e++) {
    const row: (number | null)[] = [];
    for (let x = 1; x <= 5; x++) {
      const res = computeStrategy(prices, { entryDow: e, entryTiming, exitDow: x, exitTiming, side }, compound);
      if (res.nTrades < 3) {
        row.push(null);
        continue;
      }
      const perDay = res.heldDays > 0 ? res.totalReturn / res.heldDays : 0; // 1滞在日あたり平均リターン
      row.push(metric === "perDay" ? perDay : metric === "total" ? res.totalReturn : metric === "sharpe" ? res.sharpe : res.winRate);
    }
    grid.push(row);
  }
  return grid;
}
