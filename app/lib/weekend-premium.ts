// 週末プレミアム μ_w の実測：週末を「持つべきか／飛ばすべきか」を1本の不等式で判定する
// -------------------------------------------------------------------------------
// 動機（曜日トレードの手前にある、より根源的な問い）:
//   月曜Openで建てて金曜Closeで手仕舞う「週内だけ持つ」戦略は、金曜Close→月曜Open の
//   週末ギャップを"捨てて"いる。その週末ギャップにリスクプレミアム μ_w が付いているなら、
//   飛ばすことはプレミアムを捨てる行為（＝機会損失）になる。逆に週末ギャップが
//   「リターンに乏しくリスクだけ高い」区間なら、飛ばすことでシャープが改善する。
//
// そこで日次リターンを3つの区間(バケット)に分解して、それぞれの平均・リスク・
// リスク調整後の魅力を測る:
//   1) 日中        open_i → close_i               （毎営業日）
//   2) 平日夜間    close_i → open_{i+1}（週内）    （週をまたがない持ち越し）
//   3) 週末ギャップ close_i → open_{i+1}（週境界）  （金→月。連休は長い週末として含む）
//
// ■ 判定の核心（平均分散の1本の不等式）
//   ある区間を「持ち増す」ことがポートフォリオのシャープを上げる限界条件は、その区間の
//   「分散1単位あたりリターン」 μ/σ² が、既存部分のそれを上回ること（Kelly/接点条件）。
//   したがって:
//       週末を飛ばすとシャープが改善する  ⟺  μ_w/σ_w²  <  μ_wd/σ_wd²
//   ここで wd=週内(日中+平日夜間)。左辺＜右辺なら週末ギャップは"薄い"ので飛ばすが正解、
//   左辺≥右辺なら週末ギャップは"濃い"ので持つのが正解。μ_w の符号だけでは決まらない。
//
// null-calibration.ts の decompose と同じ週境界規則(曜日が前日以下→新しい週)を使う。

import { PricePoint } from "./types";
import { mean, std, tTest, quantileSorted } from "./stats-significance";

export type BucketKey = "intraday" | "weeknight" | "weekend";

export const BUCKET_LABEL: Record<BucketKey, string> = {
  intraday: "日中（始値→終値）",
  weeknight: "平日夜間（週内の持ち越し）",
  weekend: "週末ギャップ（金→月・連休含む）",
};

// mulberry32: 再現性のあるシード付き乱数
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SegObs {
  r: number; // 単純リターン
  logr: number; // 対数リターン（総ドリフト寄与の加法分解用）
  calDays: number; // その区間が覆う暦日数（週末ギャップは通常3）
  weekIdx: number; // ブートストラップのブロック単位（週）
}

export interface BucketStat {
  key: BucketKey;
  n: number;
  meanRet: number; // μ（1回あたり平均リターン）
  sd: number; // σ
  t: number; // 平均=0 に対する t
  pOneSided: number; // H1: μ>0 の片側p
  winRate: number;
  annualRet: number; // 年率換算リターン寄与（複利, その区間だけを毎回複利）
  annualVol: number; // 年率換算ボラティリティ
  sharpe: number; // 年率シャープ
  perCalDayMean: number; // μ / 平均暦日数（1暦日あたりに正規化）
  retPerVar: number; // μ/σ²（分散1単位あたりリターン＝判定の主役）
  logContribShare: number; // 総対数ドリフトに占める割合
  avgCalDays: number;
}

export interface WeekendVerdict {
  // 平均分散の1本の不等式
  retPerVarWeekend: number; // μ_w/σ_w²
  retPerVarWeekday: number; // μ_wd/σ_wd²（週内=日中+平日夜間）
  skipImprovesSharpe: boolean; // 左辺 < 右辺 なら true（＝飛ばすべき）
  // 2戦略の直接比較
  alwaysInSharpe: number; // 常時ロング（週末も持つ）
  weekdayOnlySharpe: number; // 週末を飛ばす
  sharpeDiff: number; // weekdayOnly − alwaysIn（>0 なら飛ばす方が良い）
  sharpeDiffCI: [number, number]; // ペア・ブロックBootstrap 95%CI
  alwaysInAnnual: number;
  weekdayOnlyAnnual: number;
  annualDiff: number; // weekdayOnly − alwaysIn
  // 週末プレミアムそのもの
  muWeekend: number;
  muWeekendCI: [number, number]; // μ_w のBootstrap 95%CI
  muWeekendPOneSided: number; // H1: μ_w>0
}

export interface WeekendPremiumResult {
  ok: boolean;
  reason?: string;
  buckets: Record<BucketKey, BucketStat>;
  verdict: WeekendVerdict;
  nDays: number;
  nWeeks: number;
  from: string;
  to: string;
}

// 日次 → 週境界付きの分解。
function decomposeSegments(prices: PricePoint[]) {
  const n = prices.length;
  const dow = prices.map((p) => new Date(p.time).getDay());
  const tMs = prices.map((p) => new Date(p.time).getTime());
  // 週番号: 曜日が前日以下 → 新しい週
  const weekId: number[] = new Array(n);
  let w = -1;
  for (let i = 0; i < n; i++) {
    if (i === 0 || dow[i] <= dow[i - 1]) w++;
    weekId[i] = w;
  }

  const intraday: SegObs[] = [];
  const weeknight: SegObs[] = [];
  const weekend: SegObs[] = [];

  for (let i = 0; i < n; i++) {
    const o = prices[i].open;
    const c = prices[i].close;
    if (o > 0 && c > 0) {
      intraday.push({ r: c / o - 1, logr: Math.log(c / o), calDays: 0, weekIdx: weekId[i] });
    }
    if (i < n - 1) {
      const c1 = prices[i].close;
      const o2 = prices[i + 1].open;
      if (c1 > 0 && o2 > 0) {
        const calDays = Math.max(1, Math.round((tMs[i + 1] - tMs[i]) / 86400000));
        const obs: SegObs = {
          r: o2 / c1 - 1,
          logr: Math.log(o2 / c1),
          calDays,
          weekIdx: weekId[i],
        };
        if (weekId[i + 1] !== weekId[i]) weekend.push(obs);
        else weeknight.push(obs);
      }
    }
  }
  return { intraday, weeknight, weekend, nWeeks: w + 1 };
}

function annualizeFactor(segs: SegObs[], nDays: number): number {
  // その区間が「1年に何回起きるか」= n / (総年数)。年率化に使う。
  const years = nDays / 252 || 1;
  return segs.length / years;
}

function bucketStat(key: BucketKey, segs: SegObs[], nDays: number, totalLog: number): BucketStat {
  const rs = segs.map((s) => s.r);
  const m = mean(rs);
  const sd = std(rs);
  const tt = tTest(rs);
  const t = tt ? tt.t : 0;
  const pOne = tt ? (m > 0 ? tt.p / 2 : 1 - tt.p / 2) : 1;
  const perYear = annualizeFactor(segs, nDays);
  // 年率リターン: その区間を毎回複利したときの幾何平均を年率換算
  const geoMean = segs.length ? Math.exp(segs.reduce((s, x) => s + x.logr, 0) / segs.length) - 1 : 0;
  const annualRet = Math.pow(1 + geoMean, perYear) - 1;
  const annualVol = sd * Math.sqrt(perYear);
  const sharpe = annualVol > 0 ? annualRet / annualVol : 0;
  const avgCalDays = segs.length
    ? segs.reduce((s, x) => s + Math.max(1, x.calDays), 0) / segs.length
    : 1;
  const logSum = segs.reduce((s, x) => s + x.logr, 0);
  return {
    key,
    n: segs.length,
    meanRet: m,
    sd,
    t,
    pOneSided: pOne,
    winRate: rs.length ? rs.filter((r) => r > 0).length / rs.length : 0,
    annualRet,
    annualVol,
    sharpe,
    perCalDayMean: key === "intraday" ? m : m / Math.max(1, avgCalDays),
    retPerVar: sd > 0 ? m / (sd * sd) : 0,
    logContribShare: totalLog !== 0 ? logSum / totalLog : 0,
    avgCalDays: key === "intraday" ? 1 : avgCalDays,
  };
}

// 週ごとに (週内リターン, 週末ギャップリターン) を対にして返す。ペア・ブロックBootstrapの単位。
interface WeekPair {
  weekdayLog: number; // その週の日中+平日夜間の対数リターン合計
  weekendLog: number; // その週を閉じる週末ギャップの対数リターン（無ければ0）
}

function buildWeekPairs(
  intraday: SegObs[],
  weeknight: SegObs[],
  weekend: SegObs[],
  nWeeks: number,
): WeekPair[] {
  const wd = Array.from({ length: nWeeks }, () => 0);
  const we = Array.from({ length: nWeeks }, () => 0);
  for (const s of intraday) wd[s.weekIdx] += s.logr;
  for (const s of weeknight) wd[s.weekIdx] += s.logr;
  for (const s of weekend) we[s.weekIdx] += s.logr; // weekIdx は「その週を閉じる」ギャップ
  const pairs: WeekPair[] = [];
  for (let i = 0; i < nWeeks; i++) pairs.push({ weekdayLog: wd[i], weekendLog: we[i] });
  return pairs;
}

function sharpeFromWeekly(logs: number[]): { annual: number; vol: number; sharpe: number } {
  if (logs.length < 2) return { annual: 0, vol: 0, sharpe: 0 };
  const simple = logs.map((l) => Math.exp(l) - 1);
  const m = mean(simple);
  const sd = std(simple);
  const annual = Math.pow(1 + m, 52) - 1;
  const vol = sd * Math.sqrt(52);
  return { annual, vol, sharpe: vol > 0 ? annual / vol : 0 };
}

export function computeWeekendPremium(prices: PricePoint[], seed = 20260718): WeekendPremiumResult {
  const empty: WeekendPremiumResult = {
    ok: false,
    reason: "",
    buckets: {
      intraday: bucketStat("intraday", [], 1, 0),
      weeknight: bucketStat("weeknight", [], 1, 0),
      weekend: bucketStat("weekend", [], 1, 0),
    },
    verdict: {
      retPerVarWeekend: 0,
      retPerVarWeekday: 0,
      skipImprovesSharpe: false,
      alwaysInSharpe: 0,
      weekdayOnlySharpe: 0,
      sharpeDiff: 0,
      sharpeDiffCI: [0, 0],
      alwaysInAnnual: 0,
      weekdayOnlyAnnual: 0,
      annualDiff: 0,
      muWeekend: 0,
      muWeekendCI: [0, 0],
      muWeekendPOneSided: 1,
    },
    nDays: prices.length,
    nWeeks: 0,
    from: prices[0]?.time ?? "",
    to: prices[prices.length - 1]?.time ?? "",
  };

  if (prices.length < 60) return { ...empty, reason: "データ不足（60本以上必要）" };

  const { intraday, weeknight, weekend, nWeeks } = decomposeSegments(prices);
  if (weekend.length < 20) return { ...empty, reason: `週末ギャップの標本が不足（${weekend.length}個）` };

  const nDays = prices.length;
  // 総対数ドリフト（3バケットの対数和＝B&Hの対数リターンに一致）
  const totalLog =
    intraday.reduce((s, x) => s + x.logr, 0) +
    weeknight.reduce((s, x) => s + x.logr, 0) +
    weekend.reduce((s, x) => s + x.logr, 0);

  const buckets: Record<BucketKey, BucketStat> = {
    intraday: bucketStat("intraday", intraday, nDays, totalLog),
    weeknight: bucketStat("weeknight", weeknight, nDays, totalLog),
    weekend: bucketStat("weekend", weekend, nDays, totalLog),
  };

  // 週内(=日中+平日夜間)を1バケットに束ねた retPerVar
  const weekdaySegs = intraday.concat(weeknight);
  const wdRs = weekdaySegs.map((s) => s.r);
  const muWd = mean(wdRs);
  const sdWd = std(wdRs);
  const retPerVarWeekday = sdWd > 0 ? muWd / (sdWd * sdWd) : 0;
  const retPerVarWeekend = buckets.weekend.retPerVar;

  // 週ペアで2戦略のシャープを算出（週次リターンで年率化）
  const pairs = buildWeekPairs(intraday, weeknight, weekend, nWeeks);
  const alwaysInLogs = pairs.map((p) => p.weekdayLog + p.weekendLog);
  const weekdayLogs = pairs.map((p) => p.weekdayLog);
  const alwaysIn = sharpeFromWeekly(alwaysInLogs);
  const weekdayOnly = sharpeFromWeekly(weekdayLogs);

  // ペア・ブロックBootstrap: 週を単位に復元抽出して Sharpe差 と μ_w のCIを得る
  const rnd = mulberry32(seed);
  const B = 2000;
  const diffs: number[] = [];
  const muWeekends: number[] = [];
  const weekendRs = weekend.map((s) => s.r);
  const nW = pairs.length;
  for (let b = 0; b < B; b++) {
    const idx: number[] = new Array(nW);
    for (let i = 0; i < nW; i++) idx[i] = Math.floor(rnd() * nW);
    const ai: number[] = new Array(nW);
    const wo: number[] = new Array(nW);
    for (let i = 0; i < nW; i++) {
      ai[i] = alwaysInLogs[idx[i]];
      wo[i] = weekdayLogs[idx[i]];
    }
    diffs.push(sharpeFromWeekly(wo).sharpe - sharpeFromWeekly(ai).sharpe);
    // μ_w: 週末ギャップ標本から直接ブート（週末が無い週は寄与しないので週末標本を直接再抽出）
    let sm = 0;
    for (let i = 0; i < weekendRs.length; i++) sm += weekendRs[Math.floor(rnd() * weekendRs.length)];
    muWeekends.push(sm / weekendRs.length);
  }
  diffs.sort((a, b) => a - b);
  muWeekends.sort((a, b) => a - b);

  const muWeekend = buckets.weekend.meanRet;
  const weTt = tTest(weekendRs);
  const muWePOne = weTt ? (muWeekend > 0 ? weTt.p / 2 : 1 - weTt.p / 2) : 1;

  const verdict: WeekendVerdict = {
    retPerVarWeekend,
    retPerVarWeekday,
    skipImprovesSharpe: retPerVarWeekend < retPerVarWeekday,
    alwaysInSharpe: alwaysIn.sharpe,
    weekdayOnlySharpe: weekdayOnly.sharpe,
    sharpeDiff: weekdayOnly.sharpe - alwaysIn.sharpe,
    sharpeDiffCI: [quantileSorted(diffs, 0.025), quantileSorted(diffs, 0.975)],
    alwaysInAnnual: alwaysIn.annual,
    weekdayOnlyAnnual: weekdayOnly.annual,
    annualDiff: weekdayOnly.annual - alwaysIn.annual,
    muWeekend,
    muWeekendCI: [quantileSorted(muWeekends, 0.025), quantileSorted(muWeekends, 0.975)],
    muWeekendPOneSided: muWePOne,
  };

  return {
    ok: true,
    buckets,
    verdict,
    nDays,
    nWeeks,
    from: prices[0].time,
    to: prices[prices.length - 1].time,
  };
}
