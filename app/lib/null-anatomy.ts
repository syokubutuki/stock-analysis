// 曜日構造の解剖 (Anatomy): F が棄却したあと「どこに・どんな構造があるか」を見る
// ==============================================================================
// ヌル較正 (null-calibration.ts) の F は全体検定(omnibus)であり、
// 「どこかに偏りがある」までしか言わない。棄却後に表を眺めて一番大きいスロットを
// 選ぶと、ヌル較正が暴いたはずの in-sample 選択バイアスを裏口から再導入してしまう。
//
// そこで本モジュールは F と同じ置換スキームを共有した事後分解を提供する:
//   ① maxT 置換 (Westfall-Young step-down)  … どのスロットか（FWER 補正済み）
//   ② SS_between 寄与シェア                  … F を作ったのは誰か
//   ③ 頑健性 (順位版/刈り込み版/LOWO/年別)   … 一発屋か持続構造か
//   ④ 層別置換                               … 「曜日」そのものか代理か
//   ⑤ Brown-Forsythe                         … 平均の構造か分散の構造か
//
// さらに null-calibration の構造的死角を埋める:
//   既定の slotShuffle は週末ギャップを金曜位置に固定するため「金→月」の曜日効果が
//   原理的に見えない。本モジュールは週末ギャップを独立した族として扱い、
//   「週をまたいでギャップ値を置換する」という別の帰無で検定する。
//   これにより 金引→月寄 / 木引→月寄 / 金引→火寄 … の差が maxT の同じ族に載る。
import { PricePoint } from "./types";
import { Decomposed, decompose, mulberry32 } from "./null-calibration";

export const WD = ["日", "月", "火", "水", "木", "金", "土"];

// ==============================================================================
// 族(family)とスロット
// ==============================================================================
export type Family = "intra" | "inner" | "weekend";
export const FAMILIES: Family[] = ["intra", "inner", "weekend"];

export const FAMILY_LABEL: Record<Family, string> = {
  intra: "日中（寄→引）",
  inner: "週内オーバーナイト（引→翌寄）",
  weekend: "週末ギャップ（金引→月寄ほか）",
};

export const FAMILY_NULL: Record<Family, string> = {
  intra: "同じ週の中で日中リターンを曜日間に置換",
  inner: "同じ週の中で週内オーバーナイトを曜日間に置換",
  weekend: "週末ギャップの値を週をまたいで置換（＝終了曜日→開始曜日のラベルだけを壊す）",
};

export interface SlotDef {
  key: string;
  family: Family;
  label: string; // "金引→月寄"
  n: number;
  span?: number; // weekend のみ: 休場暦日数の中央値
}

// ==============================================================================
// 観測の平坦化
// ==============================================================================
// すべての観測を「値 + 所属スロット + 交換可能ブロック」の平坦な配列にする。
// 置換はブロック内での値のシャッフルに統一されるので、族ごとに違う帰無
// （週内置換 / 週またぎ置換）を 1 本のコードで扱える。
export interface RawObs {
  slot: number;
  family: Family;
  v: number;
  dayIdx: number; // dec 上の添字（層別ラベルの参照用）
  date: string;
  week: number;
  year: number;
}

export interface AnatomyInput {
  slots: SlotDef[];
  obs: RawObs[];
  famStart: number[]; // 族ごとの開始位置（obs は族順に並ぶ）
  famEnd: number[];
  famSlotStart: number[]; // 族ごとの先頭スロット番号
  famSlotEnd: number[];
  nWeeks: number;
  years: number[];
  rarePairs: { label: string; n: number }[];
}

function pairLabel(endDow: number, startDow: number): string {
  return `${WD[endDow]}引→${WD[startDow]}寄`;
}

export function buildInput(dec: Decomposed, minPairN: number): AnatomyInput | null {
  const n = dec.time.length;

  // --- 週末ギャップのペアを数える（少数ペアは検定から外す） ---
  const pairCount = new Map<string, number>();
  const pairSpan = new Map<string, number[]>();
  const dayMs = 86400000;
  for (let i = 0; i < n; i++) {
    if (!dec.hasOver[i] || !dec.spansWeek[i]) continue;
    const a = dec.dow[i];
    const b = dec.dow[i + 1];
    if (a < 1 || a > 5 || b < 1 || b > 5) continue;
    const k = pairLabel(a, b);
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
    const span = Math.round(
      (Date.parse(dec.time[i + 1]) - Date.parse(dec.time[i])) / dayMs,
    );
    const arr = pairSpan.get(k);
    if (arr) arr.push(span);
    else pairSpan.set(k, [span]);
  }

  const slots: SlotDef[] = [];
  const famSlotStart: number[] = [];
  const famSlotEnd: number[] = [];

  // 族1: 日中（月〜金）
  famSlotStart.push(slots.length);
  const intraSlotOf = new Map<number, number>();
  for (let D = 1; D <= 5; D++) {
    intraSlotOf.set(D, slots.length);
    slots.push({ key: `intra-${D}`, family: "intra", label: `${WD[D]}（日中）`, n: 0 });
  }
  famSlotEnd.push(slots.length);

  // 族2: 週内オーバーナイト（月〜木始まり。金の夜は必ず週末ギャップになる）
  famSlotStart.push(slots.length);
  const innerSlotOf = new Map<number, number>();
  for (let D = 1; D <= 4; D++) {
    innerSlotOf.set(D, slots.length);
    slots.push({ key: `inner-${D}`, family: "inner", label: `${WD[D]}引→翌寄`, n: 0 });
  }
  famSlotEnd.push(slots.length);

  // 族3: 週末ギャップ（終了曜日→開始曜日のペア）
  famSlotStart.push(slots.length);
  const weekendSlotOf = new Map<string, number>();
  const rarePairs: { label: string; n: number }[] = [];
  const pairKeys = Array.from(pairCount.keys()).sort(
    (a, b) => (pairCount.get(b) ?? 0) - (pairCount.get(a) ?? 0),
  );
  for (const k of pairKeys) {
    const c = pairCount.get(k) ?? 0;
    if (c < minPairN) {
      rarePairs.push({ label: k, n: c });
      continue;
    }
    const spans = (pairSpan.get(k) ?? []).slice().sort((a, b) => a - b);
    weekendSlotOf.set(k, slots.length);
    slots.push({
      key: `wknd-${k}`,
      family: "weekend",
      label: k,
      n: 0,
      span: spans.length ? spans[Math.floor(spans.length / 2)] : 3,
    });
  }
  famSlotEnd.push(slots.length);

  // --- 観測を族順に並べる ---
  const obs: RawObs[] = [];
  const famStart: number[] = [];
  const famEnd: number[] = [];
  const yearOf = (t: string) => Number(t.slice(0, 4));

  famStart.push(obs.length);
  for (let i = 0; i < n; i++) {
    const D = dec.dow[i];
    const s = intraSlotOf.get(D);
    if (s === undefined) continue;
    if (!isFinite(dec.intra[i])) continue;
    obs.push({
      slot: s,
      family: "intra",
      v: dec.intra[i],
      dayIdx: i,
      date: dec.time[i],
      week: dec.weekId[i],
      year: yearOf(dec.time[i]),
    });
    slots[s].n++;
  }
  famEnd.push(obs.length);

  famStart.push(obs.length);
  for (let i = 0; i < n; i++) {
    if (!dec.hasOver[i] || dec.spansWeek[i]) continue;
    const s = innerSlotOf.get(dec.dow[i]);
    if (s === undefined) continue;
    if (!isFinite(dec.over[i])) continue;
    obs.push({
      slot: s,
      family: "inner",
      v: dec.over[i],
      dayIdx: i,
      date: dec.time[i],
      week: dec.weekId[i],
      year: yearOf(dec.time[i]),
    });
    slots[s].n++;
  }
  famEnd.push(obs.length);

  famStart.push(obs.length);
  for (let i = 0; i < n; i++) {
    if (!dec.hasOver[i] || !dec.spansWeek[i]) continue;
    const a = dec.dow[i];
    const b = dec.dow[i + 1];
    if (a < 1 || a > 5 || b < 1 || b > 5) continue;
    const s = weekendSlotOf.get(pairLabel(a, b));
    if (s === undefined) continue;
    if (!isFinite(dec.over[i])) continue;
    obs.push({
      slot: s,
      family: "weekend",
      v: dec.over[i],
      dayIdx: i,
      date: dec.time[i],
      week: dec.weekId[i],
      year: yearOf(dec.time[i]),
    });
    slots[s].n++;
  }
  famEnd.push(obs.length);

  if (obs.length < 100) return null;

  const yearSet = new Set<number>();
  for (const o of obs) yearSet.add(o.year);

  return {
    slots,
    obs,
    famStart,
    famEnd,
    famSlotStart,
    famSlotEnd,
    nWeeks: dec.nWeeks,
    years: Array.from(yearSet).sort((a, b) => a - b),
    rarePairs,
  };
}

// ==============================================================================
// ④ 層別軸: 「曜日」なのか、何かの代理なのか
// ==============================================================================
// 重要な前提: 既定の帰無は「週の中で」置換する。したがって週レベルの交絡
// （月内で何週目か・その週の営業日数・週次ボラ水準）は既に条件付けされていて
// 交絡になりえない。問題になるのは *週の中で特定の曜日に貼り付く* 日レベルの属性
// だけであり、以下の軸はすべて日レベルである。
export type AxisKey = "none" | "holiday" | "monthpos" | "gapspan" | "us";

export interface AxisMeta {
  key: AxisKey;
  label: string;
  desc: string;
  targets: Family[]; // この軸が制約する族（他の族は無層別のまま）
}

export const AXES: AxisMeta[] = [
  {
    key: "none",
    label: "無層別（基準）",
    desc: "週内で自由に置換。曜日の割当だけを壊した標準の帰無。",
    targets: [],
  },
  {
    key: "holiday",
    label: "連休文脈",
    desc: "通常/連休明け/連休前/連休に挟まれ の中でのみ置換。月曜が祝日なら火曜が連休明けになる——この機械的な貼り付きを曜日効果と誤認していないかを見る。",
    targets: ["intra", "inner"],
  },
  {
    key: "monthpos",
    label: "月内位置（月初/中盤/月末）",
    desc: "月内営業日順位が同じ区分の中でのみ置換。月末最終営業日はその月ごとに特定の曜日に落ちるため、月末効果が曜日効果に化けうる。",
    targets: ["intra", "inner", "weekend"],
  },
  {
    key: "gapspan",
    label: "休場暦日数（週末ギャップ用）",
    desc: "週末ギャップを同じ休場日数（3日/4日/5日以上）の中でのみ置換。金引→月寄=3日、木引→月寄=4日というように、ペアの違いは休場の長さとほぼ同義になる。この軸で生き残って初めて「休場の長さを超えた曜日効果」と言える。",
    targets: ["weekend"],
  },
  {
    key: "us",
    label: "前夜米国ビン（3分位）",
    desc: "前夜の米国リターンが同じ3分位の中でのみ置換。米国の大幅変動が特定曜日に偏っていた場合、それを曜日効果と読み違えていないかを見る。",
    targets: ["intra", "inner"],
  },
];

// 日レベルのラベルを作る。戻り値は dec 添字 → ラベル番号。
function holidayLabels(dec: Decomposed): number[] {
  const dayMs = 86400000;
  const n = dec.time.length;
  const t = dec.time.map((s) => Date.parse(s));
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const dow = dec.dow[i];
    const normalPrev = dow === 1 ? 3 : 1;
    const normalNext = dow === 5 ? 3 : 1;
    const gapPrev = i > 0 ? Math.round((t[i] - t[i - 1]) / dayMs) : normalPrev;
    const gapNext = i < n - 1 ? Math.round((t[i + 1] - t[i]) / dayMs) : normalNext;
    const post = gapPrev - normalPrev > 0;
    const pre = gapNext - normalNext > 0;
    out[i] = pre && post ? 3 : post ? 1 : pre ? 2 : 0;
  }
  return out;
}
export const HOLIDAY_LABELS = ["通常", "連休明け", "連休前", "連休に挟まれ"];

function monthPosLabels(dec: Decomposed): number[] {
  const n = dec.time.length;
  const monthOf = dec.time.map((s) => s.slice(0, 7));
  const total = new Map<string, number>();
  for (const m of monthOf) total.set(m, (total.get(m) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out = new Array<number>(n).fill(1);
  for (let i = 0; i < n; i++) {
    const m = monthOf[i];
    const r = (seen.get(m) ?? 0) + 1;
    seen.set(m, r);
    const tot = total.get(m) ?? 1;
    out[i] = r <= 2 ? 0 : r > tot - 2 ? 2 : 1;
  }
  return out;
}
export const MONTHPOS_LABELS = ["月初(1-2営業日)", "中盤", "月末(最後の2営業日)"];

function gapSpanLabels(dec: Decomposed): number[] {
  const dayMs = 86400000;
  const n = dec.time.length;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (!dec.hasOver[i]) continue;
    const span = Math.round((Date.parse(dec.time[i + 1]) - Date.parse(dec.time[i])) / dayMs);
    out[i] = span <= 3 ? 0 : span === 4 ? 1 : 2;
  }
  return out;
}
export const GAPSPAN_LABELS = ["3日(通常の週末)", "4日", "5日以上"];

// 前夜の米国リターン(直近の米国セッションの終値/前終値-1)を 3分位に割る。
function usLabels(dec: Decomposed, us: PricePoint[] | null): { lab: number[]; ok: boolean } {
  const n = dec.time.length;
  const out = new Array<number>(n).fill(0);
  if (!us || us.length < 60) return { lab: out, ok: false };

  const ut = us.map((p) => Date.parse(p.time));
  const uret: number[] = new Array(us.length).fill(NaN);
  for (let k = 1; k < us.length; k++) {
    if (us[k - 1].close > 0 && us[k].close > 0) uret[k] = us[k].close / us[k - 1].close - 1;
  }

  // 各国内営業日について「その日より前の最後の米国セッション」を二分探索で引く
  const raw: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const target = Date.parse(dec.time[i]);
    let lo = 0;
    let hi = us.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ut[mid] < target) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found >= 1 && isFinite(uret[found])) raw[i] = uret[found];
  }

  const valid = raw.filter((v) => isFinite(v)).sort((a, b) => a - b);
  if (valid.length < 60) return { lab: out, ok: false };
  const q1 = valid[Math.floor(valid.length / 3)];
  const q2 = valid[Math.floor((valid.length * 2) / 3)];
  for (let i = 0; i < n; i++) {
    if (!isFinite(raw[i])) out[i] = 1;
    else out[i] = raw[i] <= q1 ? 0 : raw[i] <= q2 ? 1 : 2;
  }
  return { lab: out, ok: true };
}
export const US_LABELS = ["下位1/3(米国安)", "中位1/3", "上位1/3(米国高)"];

export const AXIS_LABEL_NAMES: Record<AxisKey, string[]> = {
  none: ["全体"],
  holiday: HOLIDAY_LABELS,
  monthpos: MONTHPOS_LABELS,
  gapspan: GAPSPAN_LABELS,
  us: US_LABELS,
};

// ==============================================================================
// 統計量
// ==============================================================================
function quantileSorted(a: number[], q: number): number {
  if (a.length === 0) return 0;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

// 一元配置 F と、スロット別の t（族平均からの乖離）と SS_between 寄与シェアを
// 1 パスで作る。置換の下では族の総和が不変なので、族平均は固定点であり、
// 動くのは「どのスロットに乗るか」だけ ＝ これがちょうど正しい帰無になる。
interface FamCalc {
  f: number;
  ssb: number;
  t: Float64Array; // 族内スロット数ぶん
  contrib: Float64Array;
  mean: Float64Array;
  sd: Float64Array;
  cnt: Int32Array;
}

function famCalc(
  val: Float64Array,
  slotLocal: Int32Array,
  start: number,
  end: number,
  k: number,
  scratch: { sum: Float64Array; sq: Float64Array; cnt: Int32Array },
): FamCalc {
  const { sum, sq, cnt } = scratch;
  sum.fill(0, 0, k);
  sq.fill(0, 0, k);
  cnt.fill(0, 0, k);
  for (let p = start; p < end; p++) {
    const s = slotLocal[p];
    const v = val[p];
    sum[s] += v;
    sq[s] += v * v;
    cnt[s]++;
  }
  let N = 0;
  let tot = 0;
  let totSq = 0;
  let kNonEmpty = 0;
  for (let s = 0; s < k; s++) {
    if (cnt[s] > 0) kNonEmpty++;
    N += cnt[s];
    tot += sum[s];
    totSq += sq[s];
  }
  const mean = new Float64Array(k);
  const sd = new Float64Array(k);
  const t = new Float64Array(k);
  const contrib = new Float64Array(k);
  if (N <= kNonEmpty || kNonEmpty < 2) {
    return { f: 0, ssb: 0, t, contrib, mean, sd, cnt: cnt.slice(0, k) };
  }
  const grand = tot / N;
  let ssb = 0;
  for (let s = 0; s < k; s++) {
    if (cnt[s] === 0) continue;
    const m = sum[s] / cnt[s];
    mean[s] = m;
    const varS = cnt[s] > 1 ? Math.max(0, (sq[s] - cnt[s] * m * m) / (cnt[s] - 1)) : 0;
    sd[s] = Math.sqrt(varS);
    const c = cnt[s] * (m - grand) ** 2;
    ssb += c;
    contrib[s] = c;
    const se = sd[s] / Math.sqrt(cnt[s]);
    t[s] = se > 0 ? (m - grand) / se : 0;
  }
  // SS_within = SS_total - SS_between（1 パスで済ませる）
  const sst = totSq - N * grand * grand;
  const ssw = Math.max(0, sst - ssb);
  const dfb = kNonEmpty - 1;
  const dfw = N - kNonEmpty;
  const f = ssw > 0 && dfw > 0 ? ssb / dfb / (ssw / dfw) : 0;
  if (ssb > 0) for (let s = 0; s < k; s++) contrib[s] /= ssb;
  return { f, ssb, t, contrib, mean, sd, cnt: cnt.slice(0, k) };
}

// Brown-Forsythe: 各スロットの中央値からの絶対偏差 z に対する一元配置 F。
// 平均差ではなく「ばらつきの曜日構造」を検出する。中央値は置換ごとに変わるので毎回計算する。
function toBrownForsythe(
  val: Float64Array,
  slotLocal: Int32Array,
  start: number,
  end: number,
  k: number,
  out: Float64Array,
  buckets: Float64Array[],
  fill: Int32Array,
): void {
  fill.fill(0, 0, k);
  for (let p = start; p < end; p++) {
    const s = slotLocal[p];
    buckets[s][fill[s]++] = val[p];
  }
  const med = new Float64Array(k);
  for (let s = 0; s < k; s++) {
    const m = fill[s];
    if (m === 0) continue;
    const sub = buckets[s].subarray(0, m);
    sub.sort();
    med[s] = m % 2 ? sub[(m - 1) >> 1] : (sub[m / 2 - 1] + sub[m / 2]) / 2;
  }
  for (let p = start; p < end; p++) out[p] = Math.abs(val[p] - med[slotLocal[p]]);
}

// ==============================================================================
// 結果型
// ==============================================================================
export interface SlotStat {
  slot: number;
  key: string;
  family: Family;
  label: string;
  n: number;
  mean: number; // 平均リターン(小数)
  sd: number;
  t: number;
  pRaw: number; // 単独の置換 p（両側・多重補正なし）
  pAdj: number; // maxT step-down による FWER 補正 p
  contrib: number; // 族内 SS_between 寄与シェア
  tP95: number; // このスロット単独の |t| のヌル95%点
  // ⑤ 分散側
  volSd: number; // スロットの日次標準偏差(小数)
  tBF: number;
  pRawBF: number;
  pAdjBF: number;
}

export interface FamilyStat {
  family: Family;
  k: number;
  n: number;
  f: number;
  pF: number;
  f95: number;
  fRank: number;
  pRank: number;
  fWins: number;
  pWins: number;
  fBF: number;
  pBF: number;
}

export interface AxisResult {
  key: AxisKey;
  available: boolean;
  permRate: number; // 有効置換率（サイズ2以上のブロックに属する観測の割合）
  nBlocks: number;
  nSingleton: number;
  families: FamilyStat[];
  slots: SlotStat[];
  tCritFwer: number; // maxT ヌルの95%点（FWER 臨界値）
  tCritSingle: number; // 単独検定の95%点（スロット別 p95 の中央値）
  tCritFwerBF: number;
  tCritSingleBF: number;
}

export interface LowoStat {
  family: Family;
  fFull: number;
  top: { label: string; fWithout: number; drop: number }[]; // drop = 低下シェア
}

export interface YearPoint {
  year: number;
  mean: number;
  n: number;
}

export interface Robustness {
  lowo: LowoStat[];
  topSlot: number; // |t| 最大のスロット
  yearly: YearPoint[];
  signAgree: number; // 年別で全期間と同符号だった割合
}

export interface AnatomyParams {
  nIter: number;
  minPairN: number;
  seed: number;
  usTicker: string; // "" なら米国軸を使わない
}

export const DEFAULT_ANATOMY_PARAMS: AnatomyParams = {
  nIter: 1000,
  minPairN: 8,
  seed: 20260725,
  usTicker: "^GSPC",
};

export interface AnatomyResult {
  ok: boolean;
  reason?: string;
  slots: SlotDef[];
  axes: AxisResult[];
  robustness: Robustness | null;
  rarePairs: { label: string; n: number }[];
  nWeeks: number;
  nObs: number;
  usOk: boolean;
  params: AnatomyParams;
}

export function emptyAnatomy(params: AnatomyParams, reason: string): AnatomyResult {
  return {
    ok: false,
    reason,
    slots: [],
    axes: [],
    robustness: null,
    rarePairs: [],
    nWeeks: 0,
    nObs: 0,
    usOk: false,
    params,
  };
}

// ==============================================================================
// 本体
// ==============================================================================
export function runAnatomy(
  prices: PricePoint[],
  usPrices: PricePoint[] | null,
  params: AnatomyParams,
  onProgress?: (done: number, total: number) => void,
): AnatomyResult {
  const dec = decompose(prices);
  if (!dec) return emptyAnatomy(params, "データ不足（2本以上必要）");
  if (dec.nWeeks < 20) return emptyAnatomy(params, `週数が不足（${dec.nWeeks}週。20週以上必要）`);

  const input = buildInput(dec, params.minPairN);
  if (!input) return emptyAnatomy(params, "有効な観測が不足しています");

  const { slots, obs, famStart, famEnd, famSlotStart, famSlotEnd } = input;
  const nObs = obs.length;
  const nSlots = slots.length;

  // --- 位置 → 族内スロット、および値のペイロード ---
  const slotLocal = new Int32Array(nObs);
  const rawVal = new Float64Array(nObs);
  for (let p = 0; p < nObs; p++) {
    slotLocal[p] = obs[p].slot - famSlotStart[FAMILIES.indexOf(obs[p].family)];
    rawVal[p] = obs[p].v;
  }

  // 順位版・刈り込み版のペイロード（族内プールは置換で不変なので前計算できる）
  const rankVal = new Float64Array(nObs);
  const winsVal = new Float64Array(nObs);
  for (let f = 0; f < 3; f++) {
    const s = famStart[f];
    const e = famEnd[f];
    if (e <= s) continue;
    const idx = Array.from({ length: e - s }, (_, i) => s + i);
    idx.sort((a, b) => rawVal[a] - rawVal[b]);
    for (let r = 0; r < idx.length; r++) rankVal[idx[r]] = r + 1;
    const lo = rawVal[idx[Math.floor((idx.length - 1) * 0.025)]];
    const hi = rawVal[idx[Math.floor((idx.length - 1) * 0.975)]];
    for (let p = s; p < e; p++) winsVal[p] = Math.min(hi, Math.max(lo, rawVal[p]));
  }

  // --- 層別ラベル ---
  const holiday = holidayLabels(dec);
  const monthpos = monthPosLabels(dec);
  const gapspan = gapSpanLabels(dec);
  const usRes = usLabels(dec, params.usTicker ? usPrices : null);

  const labelOfAxis = (axis: AxisKey, p: number): number => {
    const d = obs[p].dayIdx;
    switch (axis) {
      case "holiday":
        return holiday[d];
      case "monthpos":
        return monthpos[d];
      case "gapspan":
        return gapspan[d];
      case "us":
        return usRes.lab[d];
      default:
        return 0;
    }
  };

  // 交換可能ブロックを組む。
  //   intra/inner : 族 × 週（× 層ラベル）
  //   weekend     : 族 全体（× 層ラベル）  ← ここが金→月の死角を開ける鍵
  function buildBlocks(axis: AxisMeta): { blocks: number[][]; permRate: number } {
    const map = new Map<string, number[]>();
    for (let p = 0; p < nObs; p++) {
      const fam = obs[p].family;
      const base = fam === "weekend" ? `w` : `${fam}-${obs[p].week}`;
      const lab = axis.targets.includes(fam) ? labelOfAxis(axis.key, p) : 0;
      const key = `${base}|${lab}`;
      const arr = map.get(key);
      if (arr) arr.push(p);
      else map.set(key, [p]);
    }
    const blocks = Array.from(map.values());
    let movable = 0;
    for (const b of blocks) if (b.length >= 2) movable += b.length;
    return { blocks, permRate: nObs ? movable / nObs : 0 };
  }

  // --- 反復計算の共通ルーチン ---
  const famK = [0, 1, 2].map((f) => famSlotEnd[f] - famSlotStart[f]);
  const maxK = Math.max(1, ...famK);
  const scratch = {
    sum: new Float64Array(maxK),
    sq: new Float64Array(maxK),
    cnt: new Int32Array(maxK),
  };
  const bfBuckets: Float64Array[][] = [0, 1, 2].map((f) =>
    Array.from({ length: Math.max(1, famK[f]) }, () => new Float64Array(famEnd[f] - famStart[f] + 1)),
  );
  const bfFill = new Int32Array(maxK);
  const bfOut = new Float64Array(nObs);
  const cur = new Float64Array(nObs);
  const curRank = new Float64Array(nObs);
  const curWins = new Float64Array(nObs);

  interface IterOut {
    f: number[];
    fRank: number[];
    fWins: number[];
    fBF: number[];
    t: Float64Array;
    tBF: Float64Array;
  }

  function evaluate(src: Int32Array | null, full: boolean): IterOut {
    if (src) {
      for (let p = 0; p < nObs; p++) {
        cur[p] = rawVal[src[p]];
        if (full) {
          curRank[p] = rankVal[src[p]];
          curWins[p] = winsVal[src[p]];
        }
      }
    } else {
      cur.set(rawVal);
      if (full) {
        curRank.set(rankVal);
        curWins.set(winsVal);
      }
    }
    const t = new Float64Array(nSlots);
    const tBF = new Float64Array(nSlots);
    const f: number[] = [];
    const fRank: number[] = [];
    const fWins: number[] = [];
    const fBF: number[] = [];
    for (let fi = 0; fi < 3; fi++) {
      const k = famK[fi];
      if (k < 2 || famEnd[fi] <= famStart[fi]) {
        f.push(0);
        fRank.push(0);
        fWins.push(0);
        fBF.push(0);
        continue;
      }
      const c = famCalc(cur, slotLocal, famStart[fi], famEnd[fi], k, scratch);
      f.push(c.f);
      for (let s = 0; s < k; s++) t[famSlotStart[fi] + s] = c.t[s];

      toBrownForsythe(cur, slotLocal, famStart[fi], famEnd[fi], k, bfOut, bfBuckets[fi], bfFill);
      const cb = famCalc(bfOut, slotLocal, famStart[fi], famEnd[fi], k, scratch);
      fBF.push(cb.f);
      for (let s = 0; s < k; s++) tBF[famSlotStart[fi] + s] = cb.t[s];

      if (full) {
        fRank.push(famCalc(curRank, slotLocal, famStart[fi], famEnd[fi], k, scratch).f);
        fWins.push(famCalc(curWins, slotLocal, famStart[fi], famEnd[fi], k, scratch).f);
      } else {
        fRank.push(0);
        fWins.push(0);
      }
    }
    return { f, fRank, fWins, fBF, t, tBF };
  }

  // 実測（置換なし）
  const actual = evaluate(null, true);

  // 実測のスロット別統計。
  // 平均・σ・n は「記述統計」なので族が検定不能（スロットが1種類しかない等）でも必ず埋める。
  // 寄与シェアだけは SS_between の分解なので、検定可能な族でのみ意味を持つ。
  const slotMean = new Float64Array(nSlots);
  const slotSd = new Float64Array(nSlots);
  const slotContrib = new Float64Array(nSlots);
  const slotN = new Int32Array(nSlots);
  {
    const sum = new Float64Array(nSlots);
    const sq = new Float64Array(nSlots);
    for (let p = 0; p < nObs; p++) {
      const g = obs[p].slot;
      sum[g] += rawVal[p];
      sq[g] += rawVal[p] * rawVal[p];
      slotN[g]++;
    }
    for (let g = 0; g < nSlots; g++) {
      const c = slotN[g];
      if (c === 0) continue;
      slotMean[g] = sum[g] / c;
      slotSd[g] =
        c > 1 ? Math.sqrt(Math.max(0, (sq[g] - c * slotMean[g] * slotMean[g]) / (c - 1))) : 0;
    }
  }
  for (let fi = 0; fi < 3; fi++) {
    const k = famK[fi];
    if (k < 2 || famEnd[fi] <= famStart[fi]) continue;
    const c = famCalc(rawVal, slotLocal, famStart[fi], famEnd[fi], k, scratch);
    for (let s = 0; s < k; s++) slotContrib[famSlotStart[fi] + s] = c.contrib[s];
  }

  // --- 軸ごとに置換ループ ---
  const usable = AXES.filter((a) => a.key !== "us" || usRes.ok);
  const totalWork = usable.length * params.nIter;
  let done = 0;

  const axisResults: AxisResult[] = [];
  for (let ax = 0; ax < usable.length; ax++) {
    const axis = usable[ax];
    const { blocks, permRate } = buildBlocks(axis);
    const movableBlocks = blocks.filter((b) => b.length >= 2);
    const nSingleton = blocks.length - movableBlocks.length;
    const isBaseline = axis.key === "none";

    const rnd = mulberry32(params.seed + ax * 7919);
    const src = new Int32Array(nObs);
    const nIter = params.nIter;

    const tNull = new Float64Array(nIter * nSlots);
    const tbNull = new Float64Array(nIter * nSlots);
    const fNull: number[][] = [[], [], []];
    const frNull: number[][] = [[], [], []];
    const fwNull: number[][] = [[], [], []];
    const fbNull: number[][] = [[], [], []];

    const scratchBlock: number[] = [];
    for (let it = 0; it < nIter; it++) {
      for (let p = 0; p < nObs; p++) src[p] = p;
      for (const b of movableBlocks) {
        scratchBlock.length = 0;
        for (const p of b) scratchBlock.push(p);
        for (let i = scratchBlock.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          const tmp = scratchBlock[i];
          scratchBlock[i] = scratchBlock[j];
          scratchBlock[j] = tmp;
        }
        for (let i = 0; i < b.length; i++) src[b[i]] = scratchBlock[i];
      }
      const o = evaluate(src, isBaseline);
      tNull.set(o.t, it * nSlots);
      tbNull.set(o.tBF, it * nSlots);
      for (let fi = 0; fi < 3; fi++) {
        fNull[fi].push(o.f[fi]);
        fbNull[fi].push(o.fBF[fi]);
        if (isBaseline) {
          frNull[fi].push(o.fRank[fi]);
          fwNull[fi].push(o.fWins[fi]);
        }
      }
      done++;
      if (onProgress && (done % 25 === 0 || done === totalWork)) onProgress(done, totalWork);
    }

    // --- maxT step-down (Westfall-Young) ---
    const stepDown = (tObs: Float64Array, tNul: Float64Array) => {
      const order = Array.from({ length: nSlots }, (_, s) => s).sort(
        (a, b) => Math.abs(tObs[b]) - Math.abs(tObs[a]),
      );
      const pAdj = new Float64Array(nSlots);
      const pRaw = new Float64Array(nSlots);
      const p95 = new Float64Array(nSlots);

      // 単独の p と p95
      const col: number[] = new Array(nIter);
      for (let s = 0; s < nSlots; s++) {
        let ge = 0;
        for (let it = 0; it < nIter; it++) {
          const v = Math.abs(tNul[it * nSlots + s]);
          col[it] = v;
          if (v >= Math.abs(tObs[s]) - 1e-15) ge++;
        }
        pRaw[s] = (ge + 1) / (nIter + 1);
        const sorted = col.slice().sort((a, b) => a - b);
        p95[s] = quantileSorted(sorted, 0.95);
      }

      // step-down: 観測 |t| の降順に、残りのスロット集合上での max|t| を帰無とする
      const counts = new Int32Array(nSlots);
      const running = new Float64Array(nIter).fill(0);
      for (let k = nSlots - 1; k >= 0; k--) {
        const s = order[k];
        for (let it = 0; it < nIter; it++) {
          const v = Math.abs(tNul[it * nSlots + s]);
          if (v > running[it]) running[it] = v;
          if (running[it] >= Math.abs(tObs[s]) - 1e-15) counts[k]++;
        }
      }
      let prev = 0;
      for (let k = 0; k < nSlots; k++) {
        const p = (counts[k] + 1) / (nIter + 1);
        prev = Math.max(prev, p); // 単調性の強制
        pAdj[order[k]] = prev;
      }

      // FWER 臨界値 = 全スロット上の max|t| のヌル95%点
      const maxes: number[] = new Array(nIter);
      for (let it = 0; it < nIter; it++) {
        let m = 0;
        for (let s = 0; s < nSlots; s++) {
          const v = Math.abs(tNul[it * nSlots + s]);
          if (v > m) m = v;
        }
        maxes[it] = m;
      }
      maxes.sort((a, b) => a - b);
      const singles = Array.from(p95).filter((v) => v > 0).sort((a, b) => a - b);
      return {
        pAdj,
        pRaw,
        p95,
        tCritFwer: quantileSorted(maxes, 0.95),
        tCritSingle: singles.length ? quantileSorted(singles, 0.5) : 0,
      };
    };

    const sdRaw = stepDown(actual.t, tNull);
    const sdBF = stepDown(actual.tBF, tbNull);

    const pOf = (nulls: number[], obsVal: number) => {
      if (nulls.length === 0) return 1;
      let ge = 0;
      for (const v of nulls) if (v >= obsVal - 1e-15) ge++;
      return (ge + 1) / (nulls.length + 1);
    };

    const families: FamilyStat[] = FAMILIES.map((fam, fi) => {
      const sortedF = fNull[fi].slice().sort((a, b) => a - b);
      return {
        family: fam,
        k: famK[fi],
        n: famEnd[fi] - famStart[fi],
        f: actual.f[fi],
        pF: pOf(fNull[fi], actual.f[fi]),
        f95: quantileSorted(sortedF, 0.95),
        fRank: actual.fRank[fi],
        pRank: isBaseline ? pOf(frNull[fi], actual.fRank[fi]) : 1,
        fWins: actual.fWins[fi],
        pWins: isBaseline ? pOf(fwNull[fi], actual.fWins[fi]) : 1,
        fBF: actual.fBF[fi],
        pBF: pOf(fbNull[fi], actual.fBF[fi]),
      };
    });

    const slotStats: SlotStat[] = slots.map((sd, s) => ({
      slot: s,
      key: sd.key,
      family: sd.family,
      label: sd.label,
      n: slotN[s],
      mean: slotMean[s],
      sd: slotSd[s],
      t: actual.t[s],
      pRaw: sdRaw.pRaw[s],
      pAdj: sdRaw.pAdj[s],
      contrib: slotContrib[s],
      tP95: sdRaw.p95[s],
      volSd: slotSd[s],
      tBF: actual.tBF[s],
      pRawBF: sdBF.pRaw[s],
      pAdjBF: sdBF.pAdj[s],
    }));

    axisResults.push({
      key: axis.key,
      available: true,
      permRate,
      nBlocks: blocks.length,
      nSingleton,
      families,
      slots: slotStats,
      tCritFwer: sdRaw.tCritFwer,
      tCritSingle: sdRaw.tCritSingle,
      tCritFwerBF: sdBF.tCritFwer,
      tCritSingleBF: sdBF.tCritSingle,
    });
  }

  // --- ③ 頑健性: leave-one-week-out と年別 ---
  const robustness = computeRobustness(
    input,
    rawVal,
    slotLocal,
    famStart,
    famEnd,
    famSlotStart,
    famK,
    scratch,
    actual.t,
  );

  return {
    ok: true,
    slots,
    axes: axisResults,
    robustness,
    rarePairs: input.rarePairs,
    nWeeks: input.nWeeks,
    nObs,
    usOk: usRes.ok,
    params,
  };
}

// 1 週を抜いたときに族 F がどれだけ落ちるか。
// 落ち幅が大きいほど「その 1 週だけで作られた構造」＝一発屋の疑いが濃い。
function computeRobustness(
  input: AnatomyInput,
  rawVal: Float64Array,
  slotLocal: Int32Array,
  famStart: number[],
  famEnd: number[],
  famSlotStart: number[],
  famK: number[],
  scratch: { sum: Float64Array; sq: Float64Array; cnt: Int32Array },
  tObs: Float64Array,
): Robustness {
  const { obs, slots } = input;
  const nObs = obs.length;

  // 週ごとの位置一覧
  const weekPos = new Map<number, number[]>();
  for (let p = 0; p < nObs; p++) {
    const arr = weekPos.get(obs[p].week);
    if (arr) arr.push(p);
    else weekPos.set(obs[p].week, [p]);
  }
  const weekLabel = new Map<number, string>();
  for (const [w, ps] of weekPos) {
    let first = obs[ps[0]].date;
    for (const p of ps) if (obs[p].date < first) first = obs[p].date;
    weekLabel.set(w, `${first} の週`);
  }

  const lowo: LowoStat[] = [];

  for (let fi = 0; fi < 3; fi++) {
    const k = famK[fi];
    if (k < 2 || famEnd[fi] <= famStart[fi]) {
      lowo.push({ family: FAMILIES[fi], fFull: 0, top: [] });
      continue;
    }
    const fFull = famCalc(rawVal, slotLocal, famStart[fi], famEnd[fi], k, scratch).f;
    const drops: { label: string; fWithout: number; drop: number }[] = [];

    for (const [w, ps] of weekPos) {
      // その週の観測を族平均で置き換える＝実質的に除外（配列長を保ったまま高速に）
      let touched = false;
      for (const p of ps) {
        if (p >= famStart[fi] && p < famEnd[fi]) touched = true;
      }
      if (!touched) continue;
      // 除外版を作る（対象族だけコピー）
      const s = famStart[fi];
      const e = famEnd[fi];
      const keep: number[] = [];
      const skip = new Set(ps);
      for (let p = s; p < e; p++) if (!skip.has(p)) keep.push(p);
      if (keep.length < 20) continue;
      const sub = new Float64Array(keep.length);
      const subSlot = new Int32Array(keep.length);
      for (let i = 0; i < keep.length; i++) {
        sub[i] = rawVal[keep[i]];
        subSlot[i] = slotLocal[keep[i]];
      }
      const fw = famCalc(sub, subSlot, 0, keep.length, k, scratch).f;
      drops.push({
        label: weekLabel.get(w) ?? `週${w}`,
        fWithout: fw,
        drop: fFull > 0 ? (fFull - fw) / fFull : 0,
      });
    }
    drops.sort((a, b) => b.drop - a.drop);
    lowo.push({ family: FAMILIES[fi], fFull, top: drops.slice(0, 5) });
  }

  // 年別: |t| 最大のスロットの平均を年ごとに見る
  let topSlot = 0;
  for (let s = 1; s < slots.length; s++) {
    if (Math.abs(tObs[s]) > Math.abs(tObs[topSlot])) topSlot = s;
  }
  const byYear = new Map<number, { sum: number; n: number }>();
  let totSum = 0;
  let totN = 0;
  for (let p = 0; p < nObs; p++) {
    if (obs[p].slot !== topSlot) continue;
    const y = obs[p].year;
    const a = byYear.get(y) ?? { sum: 0, n: 0 };
    a.sum += rawVal[p];
    a.n++;
    byYear.set(y, a);
    totSum += rawVal[p];
    totN++;
  }
  const fullSign = totN > 0 && totSum >= 0 ? 1 : -1;
  const yearly: YearPoint[] = Array.from(byYear.entries())
    .map(([year, a]) => ({ year, mean: a.n ? a.sum / a.n : 0, n: a.n }))
    .sort((a, b) => a.year - b.year);
  const counted = yearly.filter((y) => y.n >= 5);
  const agree = counted.filter((y) => (y.mean >= 0 ? 1 : -1) === fullSign).length;

  return {
    lowo,
    topSlot,
    yearly,
    signAgree: counted.length ? agree / counted.length : 0,
  };
}
