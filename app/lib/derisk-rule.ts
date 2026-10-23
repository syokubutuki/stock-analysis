// ストレス退避規則（stress-hyst）の計算層。`docs/derisk-rule-design.md` §2。
//
// 規則: 4つのストレス指標のうち kIn=2 個以上が点灯したら、その日の寄りから全額現金。
//       全指標が calmN=5 営業日連続で消灯したら、その日の寄りから保有に戻る。
// 研究: `research/bank-derisk/`（r9 グリッド 972設定・r13 最終規則・r14 頑健性・r15 コスト感度・
//       r16 V字対策は全変種不成立）。結論は `docs/bank-derisk-research.md`。
//
// 時刻の規約（先読み防止。研究 `common.py` と同じ）:
//   行 t ＝ 日本の立会日 t。判断は t の朝7時（JST）。
//   日本側の特徴量は t−1 までの終値だけ（Python の shift(1)）。t の始値はまだ出ていない。
//   米国側（VIX・KRE）は日付が t より厳密に小さい最新の行（`asofIndex`）。
//   派生量（VIX/20日平均・KRE の 60日高値比）は**米国側の暦で計算してから** asof で引く。
//
// Python との対応で落とし穴になる点（設計書 §2.3）:
//   ・実現ボラは標本標準偏差（ddof=1）
//   ・日本側 dd60 は min_periods=20、KRE の dd60 は min_periods=60（非対称のまま写す）
//   ・4指標が揃わない行は状態機械を**飛ばす**（0点灯として扱わない）
//   ・純リターンの初日に片道1回分のコストを課す（`net_ret` の `fillna(w.abs())`）
//   ・年率換算は研究と同じ 245 営業日（アプリ他所の 252 と違う。ガイドに明記する）
//
// 純粋関数。React・DOM・fetch を持ち込まない。Worker とサーバー route の両方から呼べる。

import type { PricePoint } from "./types";
import { asofIndex } from "./asof-align";
import { followsTseCalendar, tseClosureReason } from "./tse-calendar";

/** 年率換算の営業日数。研究文書の数字（年率 10.4% / 最大DD −33.6% / Sharpe 0.48）と突き合わせるため 245。 */
export const TRADING_DAYS_PER_YEAR = 245;

export interface DeriskParams {
  /** VIX 終値 ÷ 直近20日平均 がこれを上回ると点灯 */
  vixRatio: number;
  /** 5日実現ボラ ÷ 60日実現ボラ がこれを上回ると点灯 */
  volRatio: number;
  /** 直近60日高値からの下落（比率）がこれを下回ると点灯 */
  dd60: number;
  /** KRE の直近60日高値からの下落（比率）がこれを下回ると点灯 */
  kreDd60: number;
  /** 点灯数 ≥ kIn で現金へ */
  kIn: number;
  /** 点灯数 ≤ kOut が calmN 営業日連続で保有へ */
  calmN: number;
  kOut: number;
}

/** 研究で確定した設定（r13 `hyst(k_in=2, calm_n=5, k_out=0)`）。画面の既定はこれで固定。 */
export const RESEARCH_PARAMS: DeriskParams = {
  vixRatio: 1.25,
  volRatio: 1.8,
  dd60: -0.12,
  kreDd60: -0.12,
  kIn: 2,
  calmN: 5,
  kOut: 0,
};

export type LightKey = "vixRatio" | "volRatio" | "dd60" | "kreDd60";
export const LIGHT_KEYS: readonly LightKey[] = ["vixRatio", "volRatio", "dd60", "kreDd60"];

export const LIGHT_LABELS: Record<LightKey, string> = {
  vixRatio: "VIX ÷ 20日平均",
  volRatio: "5日ボラ ÷ 60日ボラ",
  dd60: "60日高値からの下落",
  kreDd60: "米地銀(KRE) 60日高値からの下落",
};

export interface DeriskInput {
  /** 対象銘柄の日足（調整後 OHLC。/api/stock の 10y または max） */
  target: PricePoint[];
  /** ^VIX の日足（close だけ使う） */
  vix: PricePoint[];
  /** KRE の日足（close だけ使う） */
  kre: PricePoint[];
  /** 次の立会日の算出に使う（東証暦に従う系列か）。省略時は暦日の翌平日 */
  ticker?: string;
  params?: Partial<DeriskParams>;
  /** 片道コスト（比率）。既定 0.0005（5bp） */
  costOneWay?: number;
  /**
   * 状態機械と評価をこの日付以降の行から始める（特徴量の暖機にはそれ以前の行も使う）。
   * 研究の `D[D.index >= "2006-09-01"]` に相当。省略時は有効な最初の行から。
   */
  startTime?: string;
}

export interface Light {
  key: LightKey;
  label: string;
  value: number;
  threshold: number;
  lit: boolean;
  /**
   * 点灯までの余裕。**正＝安全側**（負なら点灯中）。
   * 比率型（vixRatio / volRatio）は 1 − value/threshold、下落型（dd60 / kreDd60）は value − threshold（比率差）。
   */
  margin: number;
}

export interface DeriskRow {
  time: string;
  vixRatio: number;
  volRatio: number;
  dd60: number;
  kreDd60: number;
  stress: number;
  /** 建玉（1=保有・0=現金）。この行の寄りから適用 */
  w: 0 | 1;
  /** 寄り→翌寄りの対数リターン。最終行は null */
  yOo: number | null;
  /** 既定コストでの純リターン（w·yOo − c·|Δw|）。yOo が無い行は null */
  net: number | null;
  /** 使った米国行の日付（VIX と KRE のうち古い方） */
  usAsOf: string;
}

export interface DeriskState {
  /** 判断日（この日の寄りから建玉を適用） */
  time: string;
  stress: number;
  holding: boolean;
  /** 現金中の復帰カウント（消灯が連続した営業日数）。保有中は 0 */
  calm: number;
  lights: Light[];
  /** 使った米国行の日付（VIX と KRE のうち古い方） */
  usAsOf: string;
  vixAsOf: string;
  kreAsOf: string;
  /** 米国行が直前の日本立会日より古い（＝その日の米国終値が未着。朝6〜7時に更新される） */
  usStale: boolean;
}

export interface DeriskMetrics {
  nDays: number;
  /** 年率（245日換算、exp(Σnet/yrs) − 1） */
  cagr: number;
  /** 年率ボラ */
  vol: number;
  sharpe: number;
  /** 最大ドローダウン（負の比率） */
  maxDrawdown: number;
  /** 市場滞在率 mean(w) */
  inMarket: number;
  /** 回転 Σ|Δw| / 年（初日分は含まない） */
  turnover: number;
  /** 期間累積 exp(Σnet) − 1 */
  total: number;
}

export interface CashEpisode {
  start: string;
  /** 継続中なら null */
  end: string | null;
  days: number;
  /** 退避日に点いていた指標 */
  litAtEntry: LightKey[];
  /** 区間中の買い持ち累積（寄り→翌寄り）。負＝守れた、正＝逃した。評価できる行が無ければ null */
  bhReturn: number | null;
}

export interface DeriskEra {
  label: string;
  from: string;
  to: string | null;
  rule: DeriskMetrics | null;
  buyHold: DeriskMetrics | null;
}

export interface DeriskResult {
  params: DeriskParams;
  costOneWay: number;
  rows: DeriskRow[];
  /** 有効行の先頭日（状態機械は経路依存なので、履歴の開始日を画面に出す） */
  historyStart: string | null;
  /** 最終有効行（＝データ最終日の朝7時時点）の状態 */
  latest: DeriskState | null;
  /** 次の立会日の朝7時時点の状態（4指標が揃わなければ null） */
  next: DeriskState | null;
  metrics: { rule: DeriskMetrics; buyHold: DeriskMetrics } | null;
  byEra: DeriskEra[];
  costSensitivity: { costBp: number; rule: DeriskMetrics }[];
  episodes: CashEpisode[];
}

// ───────────────────────── 基礎統計 ─────────────────────────

/** 標本標準偏差（ddof=1）。n<2 は NaN。 */
export function sampleStd(xs: ArrayLike<number>, from = 0, to = xs.length): number {
  const n = to - from;
  if (n < 2) return NaN;
  let m = 0;
  for (let i = from; i < to; i++) m += xs[i];
  m /= n;
  let s = 0;
  for (let i = from; i < to; i++) s += (xs[i] - m) ** 2;
  return Math.sqrt(s / (n - 1));
}

// ───────────────────────── 特徴量 ─────────────────────────

/**
 * 米国側: x[j] ÷ mean(x[j−w+1..j])。j < w−1 は NaN（pandas `rolling(w).mean()` の既定 min_periods=w）。
 */
export function ratioToRollingMean(x: ArrayLike<number>, window: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  let sum = 0;
  for (let j = 0; j < x.length; j++) {
    sum += x[j];
    if (j >= window) sum -= x[j - window];
    if (j >= window - 1) out[j] = x[j] / (sum / window);
  }
  return out;
}

/**
 * x[j] ÷ max(x[max(0,j−w+1)..j]) − 1。窓内の本数が minPeriods 未満なら NaN
 * （pandas `rolling(w, min_periods=m).max()`）。
 */
export function drawdownFromRollingHigh(x: ArrayLike<number>, window: number, minPeriods: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  for (let j = 0; j < x.length; j++) {
    const from = Math.max(0, j - window + 1);
    if (j - from + 1 < minPeriods) continue;
    let mx = -Infinity;
    for (let i = from; i <= j; i++) if (x[i] > mx) mx = x[i];
    out[j] = x[j] / mx - 1;
  }
  return out;
}

export interface JpFeatures {
  /** 添字 t = 0..n（t=n は「次の立会日」）。未定義は NaN */
  volRatio: Float64Array;
  dd60: Float64Array;
}

/**
 * 日本側の特徴量。行 t は t−1 までの終値だけを使う（Python の shift(1)）。
 *   volRatio[t] = sd(r[t−5..t−1]) / sd(r[t−60..t−1])、r[i] = ln c[i] − ln c[i−1]
 *   dd60[t]     = c[t−1] / max(c[max(0,t−60)..t−1]) − 1（有効本数 ≥ 20）
 * 配列長は n+1 で、t=n が「データ最終日の翌営業日」の判断に使う値。
 */
export function jpFeatures(closes: ArrayLike<number>): JpFeatures {
  const n = closes.length;
  const r = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) r[i] = Math.log(closes[i]) - Math.log(closes[i - 1]);
  const volRatio = new Float64Array(n + 1).fill(NaN);
  const dd60 = new Float64Array(n + 1).fill(NaN);
  for (let t = 0; t <= n; t++) {
    // 5日／60日の窓は r[t−k..t−1]。r[0] は未定義なので t−60 ≥ 1。
    if (t - 60 >= 1) {
      const v5 = sampleStd(r, t - 5, t);
      const v60 = sampleStd(r, t - 60, t);
      volRatio[t] = v5 / v60; // 0/0 → NaN（未定義）、x/0 → Infinity（点灯）。pandas と同じ
    }
    const from = Math.max(0, t - 60);
    if (t >= 1 && t - from >= 20) {
      let mx = -Infinity;
      for (let i = from; i < t; i++) if (closes[i] > mx) mx = closes[i];
      dd60[t] = closes[t - 1] / mx - 1;
    }
  }
  return { volRatio, dd60 };
}

// ───────────────────────── 状態機械 ─────────────────────────

/**
 * Python `r13_variants.hyst()` の逐語訳。stress[i] は有効行 i の点灯数。
 * 戻り値の w[i] は行 i の寄りから適用する建玉。`calm` は各行処理後の復帰カウント。
 */
export function runHysteresis(
  stress: ArrayLike<number>,
  p: Pick<DeriskParams, "kIn" | "calmN" | "kOut">,
  initial: { cur: 0 | 1; calm: number } = { cur: 1, calm: 0 },
): { w: Uint8Array; calm: Int32Array; final: { cur: 0 | 1; calm: number } } {
  const n = stress.length;
  const w = new Uint8Array(n);
  const calmOut = new Int32Array(n);
  let cur: 0 | 1 = initial.cur;
  let calm = initial.calm;
  for (let i = 0; i < n; i++) {
    if (cur === 1) {
      if (stress[i] >= p.kIn) {
        cur = 0;
        calm = 0;
      }
    } else {
      calm = stress[i] <= p.kOut ? calm + 1 : 0;
      if (calm >= p.calmN) cur = 1;
    }
    w[i] = cur;
    calmOut[i] = cur === 1 ? 0 : calm;
  }
  return { w, calm: calmOut, final: { cur, calm: cur === 1 ? 0 : calm } };
}

export function countLights(f: Record<LightKey, number>, p: DeriskParams): number {
  return (
    (f.vixRatio > p.vixRatio ? 1 : 0) +
    (f.volRatio > p.volRatio ? 1 : 0) +
    (f.dd60 < p.dd60 ? 1 : 0) +
    (f.kreDd60 < p.kreDd60 ? 1 : 0)
  );
}

export function buildLights(f: Record<LightKey, number>, p: DeriskParams): Light[] {
  const ratio = (key: "vixRatio" | "volRatio"): Light => ({
    key, label: LIGHT_LABELS[key], value: f[key], threshold: p[key],
    lit: f[key] > p[key], margin: 1 - f[key] / p[key],
  });
  const dd = (key: "dd60" | "kreDd60"): Light => ({
    key, label: LIGHT_LABELS[key], value: f[key], threshold: p[key],
    lit: f[key] < p[key], margin: f[key] - p[key],
  });
  return [ratio("vixRatio"), ratio("volRatio"), dd("dd60"), dd("kreDd60")];
}

// ───────────────────────── 評価 ─────────────────────────

/** 純リターン列。dw[0] = |w[0]|（初日に片道1回分を課す。Python `net_ret` と同じ）。 */
export function netReturns(w: ArrayLike<number>, y: ArrayLike<number>, costOneWay: number): Float64Array {
  const out = new Float64Array(w.length);
  for (let i = 0; i < w.length; i++) {
    const dw = i === 0 ? Math.abs(w[0]) : Math.abs(w[i] - w[i - 1]);
    out[i] = w[i] * y[i] - costOneWay * dw;
  }
  return out;
}

/** 研究 `r15_final.py` / `r9_grid.stats` と同じ式。 */
export function computeMetrics(net: ArrayLike<number>, w: ArrayLike<number>): DeriskMetrics {
  const n = net.length;
  const yrs = n / TRADING_DAYS_PER_YEAR;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += net[i];
  const mean = sum / n;
  const sd = sampleStd(net);
  let eq = 0, peak = -Infinity, mdd = 0;
  for (let i = 0; i < n; i++) {
    eq += net[i];
    const e = Math.exp(eq);
    if (e > peak) peak = e;
    const dd = e / peak - 1;
    if (dd < mdd) mdd = dd;
  }
  let inMarket = 0, turn = 0;
  for (let i = 0; i < n; i++) {
    inMarket += w[i];
    if (i >= 1) turn += Math.abs(w[i] - w[i - 1]);
  }
  return {
    nDays: n,
    cagr: Math.exp(sum / yrs) - 1,
    vol: sd * Math.sqrt(TRADING_DAYS_PER_YEAR),
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR) : NaN,
    maxDrawdown: mdd,
    inMarket: inMarket / n,
    turnover: turn / yrs,
    total: Math.exp(sum) - 1,
  };
}

/** 研究の時代区分（r13 / 研究文書 §5.1）。10y データでは最初の2つが空になる。 */
export const ERAS: { label: string; from: string; to: string | null }[] = [
  { label: "2006-09〜2009", from: "2006-09-01", to: "2009-12-31" },
  { label: "2010〜2012", from: "2010-01-01", to: "2012-12-31" },
  { label: "2013〜2017", from: "2013-01-01", to: "2017-12-31" },
  { label: "2018〜", from: "2018-01-01", to: null },
];

export const COST_SENSITIVITY_BP = [0, 5, 10, 20];

// ───────────────────────── 暦 ─────────────────────────

/** `time` の次の立会日。東証暦に従う銘柄は休場日表で飛ばし、それ以外は翌平日。 */
export function nextTradingDay(time: string, ticker?: string): string {
  const tse = ticker ? followsTseCalendar(ticker) : false;
  const d = new Date(`${time}T00:00:00Z`);
  for (let i = 0; i < 30; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (tse && tseClosureReason(iso) !== null) continue;
    return iso;
  }
  return d.toISOString().slice(0, 10);
}

// ───────────────────────── 本体 ─────────────────────────

function sortedCopy(p: PricePoint[]): PricePoint[] {
  return [...p].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/** NaN の行を除いた (time, value) 列。asof の候補から未定義行を外す（研究 `asof_us` の dropna）。 */
function definedSeries(times: string[], values: Float64Array): { times: string[]; values: number[] } {
  const t: string[] = [], v: number[] = [];
  for (let i = 0; i < times.length; i++) {
    if (!Number.isNaN(values[i])) { t.push(times[i]); v.push(values[i]); }
  }
  return { times: t, values: v };
}

export function computeDerisk(input: DeriskInput): DeriskResult {
  const params: DeriskParams = { ...RESEARCH_PARAMS, ...(input.params ?? {}) };
  const cost = input.costOneWay ?? 0.0005;
  const target = sortedCopy(input.target);
  const vix = sortedCopy(input.vix);
  const kre = sortedCopy(input.kre);
  const n = target.length;
  const empty: DeriskResult = {
    params, costOneWay: cost, rows: [], historyStart: null, latest: null, next: null,
    metrics: null, byEra: [], costSensitivity: [], episodes: [],
  };
  if (n < 2 || vix.length === 0 || kre.length === 0) return empty;

  const times = target.map((p) => p.time);
  const closes = target.map((p) => p.close);
  const opens = target.map((p) => p.open);
  const jp = jpFeatures(closes);

  // 米国側は米国の暦で派生量を作ってから asof（未定義の行は候補から外す）。
  const vixD = definedSeries(vix.map((p) => p.time), ratioToRollingMean(vix.map((p) => p.close), 20));
  const kreD = definedSeries(kre.map((p) => p.time), drawdownFromRollingHigh(kre.map((p) => p.close), 60, 60));

  const nextTime = nextTradingDay(times[n - 1], input.ticker);
  const jpTimesExt = [...times, nextTime];
  const vIdx = asofIndex(jpTimesExt, vixD.times);
  const kIdx = asofIndex(jpTimesExt, kreD.times);

  const featAt = (t: number): (Record<LightKey, number> & { vixAsOf: string; kreAsOf: string }) | null => {
    const vi = vIdx[t], ki = kIdx[t];
    if (vi < 0 || ki < 0) return null;
    const f = { vixRatio: vixD.values[vi], volRatio: jp.volRatio[t], dd60: jp.dd60[t], kreDd60: kreD.values[ki] };
    if (Number.isNaN(f.vixRatio) || Number.isNaN(f.volRatio) || Number.isNaN(f.dd60) || Number.isNaN(f.kreDd60)) return null;
    return { ...f, vixAsOf: vixD.times[vi], kreAsOf: kreD.times[ki] };
  };

  // 有効行（4指標が揃い、startTime 以降）だけを状態機械に通す。
  const validT: number[] = [];
  const feats: (Record<LightKey, number> & { vixAsOf: string; kreAsOf: string })[] = [];
  for (let t = 0; t < n; t++) {
    if (input.startTime && times[t] < input.startTime) continue;
    const f = featAt(t);
    if (!f) continue;
    validT.push(t);
    feats.push(f);
  }
  if (validT.length === 0) return empty;

  const stress = feats.map((f) => countLights(f, params));
  const hy = runHysteresis(stress, params);

  const rows: DeriskRow[] = validT.map((t, i) => {
    const f = feats[i];
    const yOo = t + 1 < n && opens[t] > 0 && opens[t + 1] > 0 ? Math.log(opens[t + 1] / opens[t]) : null;
    return {
      time: times[t], vixRatio: f.vixRatio, volRatio: f.volRatio, dd60: f.dd60, kreDd60: f.kreDd60,
      stress: stress[i], w: hy.w[i] as 0 | 1, yOo, net: null,
      usAsOf: f.vixAsOf < f.kreAsOf ? f.vixAsOf : f.kreAsOf,
    };
  });

  // 評価は yOo のある行（最終行は未定義）。Python の dropna(subset=["y_oo", …]) と同じ集合。
  const evalIdx: number[] = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].yOo !== null) evalIdx.push(i);
  const yEval = Float64Array.from(evalIdx, (i) => rows[i].yOo as number);
  const wEval = Float64Array.from(evalIdx, (i) => rows[i].w);
  const netEval = netReturns(wEval, yEval, cost);
  evalIdx.forEach((i, k) => { rows[i].net = netEval[k]; });

  let metrics: DeriskResult["metrics"] = null;
  const byEra: DeriskEra[] = [];
  const costSensitivity: DeriskResult["costSensitivity"] = [];
  if (evalIdx.length > 0) {
    const ones = new Float64Array(evalIdx.length).fill(1);
    metrics = { rule: computeMetrics(netEval, wEval), buyHold: computeMetrics(yEval, ones) };
    const evalTimes = evalIdx.map((i) => rows[i].time);
    for (const era of ERAS) {
      const sel: number[] = [];
      for (let k = 0; k < evalTimes.length; k++) {
        const tm = evalTimes[k];
        if (tm >= era.from && (era.to === null || tm <= era.to)) sel.push(k);
      }
      if (sel.length === 0) { byEra.push({ ...era, rule: null, buyHold: null }); continue; }
      const nE = Float64Array.from(sel, (k) => netEval[k]);
      const wE = Float64Array.from(sel, (k) => wEval[k]);
      const yE = Float64Array.from(sel, (k) => yEval[k]);
      byEra.push({ ...era, rule: computeMetrics(nE, wE), buyHold: computeMetrics(yE, new Float64Array(sel.length).fill(1)) });
    }
    for (const bp of COST_SENSITIVITY_BP) {
      costSensitivity.push({ costBp: bp, rule: computeMetrics(netReturns(wEval, yEval, bp / 1e4), wEval) });
    }
  }

  // 現金化エピソード（状態機械を通した全有効行の上で数える）。
  const episodes: CashEpisode[] = [];
  for (let i = 0; i < rows.length; ) {
    if (rows[i].w !== 0) { i++; continue; }
    let j = i;
    let bhSum = 0, bhN = 0;
    while (j < rows.length && rows[j].w === 0) {
      const y = rows[j].yOo;
      if (y !== null) { bhSum += y; bhN++; }
      j++;
    }
    const f = feats[i];
    episodes.push({
      start: rows[i].time,
      end: j < rows.length ? rows[j - 1].time : null,
      days: j - i,
      litAtEntry: buildLights(f, params).filter((l) => l.lit).map((l) => l.key),
      bhReturn: bhN > 0 ? Math.exp(bhSum) - 1 : null,
    });
    i = j;
  }

  const stateOf = (t: number, f: Record<LightKey, number> & { vixAsOf: string; kreAsOf: string }, st: number, cur: 0 | 1, calm: number): DeriskState => {
    const usAsOf = f.vixAsOf < f.kreAsOf ? f.vixAsOf : f.kreAsOf;
    const prevJp = t >= 1 ? times[t - 1] : null;
    return {
      time: jpTimesExt[t], stress: st, holding: cur === 1, calm: cur === 1 ? 0 : calm,
      lights: buildLights(f, params), usAsOf, vixAsOf: f.vixAsOf, kreAsOf: f.kreAsOf,
      usStale: prevJp !== null && usAsOf < prevJp,
    };
  };

  const last = rows.length - 1;
  const latest = stateOf(validT[last], feats[last], stress[last], hy.w[last] as 0 | 1, hy.calm[last]);

  let next: DeriskState | null = null;
  const fNext = featAt(n);
  if (fNext) {
    const stNext = countLights(fNext, params);
    const step = runHysteresis([stNext], params, hy.final);
    next = stateOf(n, fNext, stNext, step.w[0] as 0 | 1, step.calm[0]);
  }

  return {
    params, costOneWay: cost, rows, historyStart: rows[0].time, latest, next,
    metrics, byEra, costSensitivity, episodes,
  };
}
