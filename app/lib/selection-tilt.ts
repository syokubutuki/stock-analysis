// 系C25「対象選択による床の底上げ（横断ドリフト・チルトの前向き検証）」の計算層。
//
// C24 の床（市場＝等加重への参加）を前提に、観測可能な特性 X で対象をチルトすれば
// 床を底上げできるか（横断超過ドリフト Δμ>0）を、純ウォークフォワードで検証する。
//
// 設計の核心（ユーザーが警告した「過去実績最大の銘柄を選ぶ＝生存者バイアス」を避ける）:
//   ・単位は個別銘柄でなく「特性ソート・ポートフォリオ（上位分位の束）」＝idiosyncratic を分散。
//   ・各リバランスで特性を過去データのみから作り直す（公準3・非先読み）。
//   ・超過ドリフトの t 値ハードル（C16 誤差割引）＋複数特性の BH-FDR（命題4）で採用を絞る。
//   ・底上げ幅は横断相関 ρ̄ による N_eff（C20）で頭打ち。生存者バイアスを point-in-time で診断。
//
// 既存の cross-sectional-edge.ts は「市場中立ロングショート（IC/ブレッドス）」で別物。
// 本モジュールは「床（等加重）に対するロングオンリー超過」に特化し、自己完結で実装する。

import { PricePoint } from "./types";
import { mean, std, tTest, benjaminiHochberg } from "./stats-significance";

export type TiltSignalId = "momentum" | "lowvol" | "shortrev" | "trend";

export const TILT_SIGNAL_LABEL: Record<TiltSignalId, string> = {
  momentum: "モメンタム(12-1月)",
  lowvol: "低ボラティリティ(60日)",
  shortrev: "短期リバーサル(5日)",
  trend: "トレンド(200日MA乖離)",
};

export const TILT_SIGNAL_DESC: Record<TiltSignalId, string> = {
  momentum: "過去12ヶ月(直近1ヶ月除く)の相対勝ち組を厚めに持つ。中期の持続性で床を底上げできるか。",
  lowvol: "直近60日の実現ボラが低い銘柄を厚めに持つ。低ボラ・アノマリー。",
  shortrev: "直近5日で相対的に負けた銘柄を厚めに持つ。短期の反発（回転が速くコストに弱い）。",
  trend: "200日移動平均からの上方乖離が大きい銘柄を厚めに持つ。順張り。",
};

export const TILT_SIGNALS: TiltSignalId[] = ["momentum", "lowvol", "shortrev", "trend"];

/** 特性計算に必要な最小履歴（全シグナル共通＝床の母集団を一致させる）。 */
const MIN_HISTORY = 252;

export interface TiltParams {
  quantile: number; // 上位何割をロングするか(0.2..0.5)
  rebalanceDays: number; // リバランス間隔(営業日, 既定21≒月次)
  costBps: number; // 片道コスト(bp)。回転に比例して控除
  tHurdle: number; // C16: 超過ドリフト採用の t ハードル(既定2.0)
}

export const DEFAULT_TILT_PARAMS: TiltParams = {
  quantile: 0.3,
  rebalanceDays: 21,
  costBps: 10,
  tHurdle: 2.0,
};

export interface EquityPoint {
  time: string;
  value: number;
}

export interface TiltSignalResult {
  signal: TiltSignalId;
  nPeriods: number;
  annTilt: number; // チルト(ロングオンリー)の年率ドリフト
  annBaseline: number; // 床(等加重)の年率ドリフト
  excessAnn: number; // 床の底上げ = annTilt − annBaseline(グロス)
  netExcessAnn: number; // コスト控除後の底上げ
  excessT: number; // 期間別超過の t 値(非重複リバランス→ほぼ独立)
  pValue: number; // 両側 p 値
  qValueBH: number; // 複数特性の BH-FDR 補正後 q 値
  gTilt: number; // 時間平均成長率(C21)
  gBaseline: number;
  sharpeTilt: number;
  sharpeBaseline: number;
  maxDDTilt: number;
  maxDDBaseline: number;
  avgLong: number; // 平均ロング銘柄数
  turnoverPerYear: number; // チルトの年あたり片道回転
  passes: boolean; // q<0.1 かつ t>hurdle かつ netExcess>0
  equityTilt: EquityPoint[];
}

export interface TiltDiagnostics {
  universeSize: number;
  survivorsToEnd: number; // データが終端まで届く銘柄数
  survivorshipWarning: boolean; // 大半が終端まで生存＝生存者バイアスの疑い
  avgPairCorr: number; // 横断残差相関の平均(≥0にクランプ)
  nEff: number; // 実効独立数 N/(1+(N−1)ρ̄)(C20)
  from: string;
  to: string;
  years: number;
  nPeriods: number;
}

export interface SelectionTiltResult {
  ok: boolean;
  reason?: string;
  signals: TiltSignalResult[]; // excessAnn 降順
  baselineEquity: EquityPoint[]; // 床(等加重)の資産曲線
  diag: TiltDiagnostics;
  tHurdle: number;
}

// --- 内部ユーティリティ ------------------------------------------------------
interface Series {
  ticker: string;
  dates: string[];
  closes: number[];
  idxByDate: Map<string, number>;
}

function buildSeries(ticker: string, prices: PricePoint[]): Series | null {
  const dates: string[] = [];
  const closes: number[] = [];
  const idxByDate = new Map<string, number>();
  for (const p of prices) {
    if (p.close > 0) {
      idxByDate.set(p.time, dates.length);
      dates.push(p.time);
      closes.push(p.close);
    }
  }
  if (dates.length < MIN_HISTORY + 30) return null;
  return { ticker, dates, closes, idxByDate };
}

/** 特性スコア（高いほどロング優先）。i は当該銘柄の自身インデックス。過去データのみ使用。 */
function score(sig: TiltSignalId, s: Series, i: number): number | null {
  const c = s.closes;
  if (sig === "momentum") {
    if (i < 252) return null;
    return c[i - 21] / c[i - 252] - 1; // 12-1 モメンタム
  }
  if (sig === "shortrev") {
    if (i < 5) return null;
    return -(c[i] / c[i - 5] - 1); // 負け組を優先
  }
  if (sig === "trend") {
    if (i < 200) return null;
    let sum = 0;
    for (let k = i - 199; k <= i; k++) sum += c[k];
    const ma = sum / 200;
    return ma > 0 ? c[i] / ma - 1 : null;
  }
  // lowvol: 直近60日の実現ボラの負値
  if (i < 60) return null;
  const rets: number[] = [];
  for (let k = i - 59; k <= i; k++) {
    if (c[k - 1] > 0) rets.push(c[k] / c[k - 1] - 1);
  }
  return rets.length ? -std(rets) : null;
}

function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.min(mdd, v / peak - 1);
  }
  return mdd;
}

/** 期間リターン列 → 資産曲線・g・シャープ・年率・最大DD。periodsPerYear で年率化。 */
function seriesMetrics(rets: number[], periodsPerYear: number, times: string[]) {
  const equity: EquityPoint[] = [];
  let eq = 1;
  let g = 0;
  let gN = 0;
  for (let i = 0; i < rets.length; i++) {
    eq *= 1 + rets[i];
    equity.push({ time: times[i], value: eq });
    if (1 + rets[i] > 0) {
      g += Math.log(1 + rets[i]);
      gN++;
    }
  }
  const m = mean(rets);
  const sd = std(rets);
  const eqVals = equity.map((p) => p.value);
  return {
    equity,
    annDrift: m * periodsPerYear,
    growthRate: gN ? (g / gN) * periodsPerYear : 0,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(periodsPerYear) : 0,
    maxDD: maxDrawdown(eqVals),
  };
}

/** 横断相関の平均ペアと実効独立数（C20 診断）。直近 win 日の日次リターンで。 */
function crossCorrelation(seriesList: Series[], win = 252): { rho: number; nEff: number } {
  const N = seriesList.length;
  if (N < 2) return { rho: 0, nEff: N };
  // 共通の直近日付軸を作る（全銘柄が持つ日付の交差）。
  let common: string[] | null = null;
  for (const s of seriesList) {
    const tail = new Set(s.dates.slice(-win - 1));
    common = common === null ? [...tail] : common.filter((d) => tail.has(d));
  }
  common = (common ?? []).sort();
  if (common.length < 30) return { rho: 0, nEff: N };
  // 各銘柄の日次リターン列（共通日付上）。
  const retMat: number[][] = seriesList.map((s) => {
    const r: number[] = [];
    for (let k = 1; k < common!.length; k++) {
      const i0 = s.idxByDate.get(common![k - 1]);
      const i1 = s.idxByDate.get(common![k]);
      if (i0 != null && i1 != null && s.closes[i0] > 0) r.push(s.closes[i1] / s.closes[i0] - 1);
      else r.push(0);
    }
    return r;
  });
  let sum = 0;
  let cnt = 0;
  for (let a = 0; a < N; a++) {
    for (let b = a + 1; b < N; b++) {
      const x = retMat[a];
      const y = retMat[b];
      const mx = mean(x);
      const my = mean(y);
      let num = 0;
      let dx = 0;
      let dy = 0;
      for (let k = 0; k < x.length; k++) {
        num += (x[k] - mx) * (y[k] - my);
        dx += (x[k] - mx) ** 2;
        dy += (y[k] - my) ** 2;
      }
      const den = Math.sqrt(dx * dy);
      if (den > 0) {
        sum += num / den;
        cnt++;
      }
    }
  }
  const rho = cnt ? Math.max(0, sum / cnt) : 0;
  const nEff = rho > 0 ? N / (1 + (N - 1) * rho) : N;
  return { rho, nEff };
}

/** 片道回転（0.5·Σ|Δw|）を等加重集合の入れ替えから計算。 */
function oneWayTurnover(prev: Set<string>, next: Set<string>): number {
  if (prev.size === 0) return next.size ? 1 : 0; // 初回は全建て
  const wPrev = prev.size ? 1 / prev.size : 0;
  const wNext = next.size ? 1 / next.size : 0;
  let sum = 0;
  const all = new Set([...prev, ...next]);
  for (const t of all) {
    const a = prev.has(t) ? wPrev : 0;
    const b = next.has(t) ? wNext : 0;
    sum += Math.abs(b - a);
  }
  return sum / 2;
}

// --- メイン ------------------------------------------------------------------
export function computeSelectionTilt(
  pricesByTicker: Record<string, PricePoint[]>,
  params: TiltParams
): SelectionTiltResult {
  const { quantile, rebalanceDays, costBps, tHurdle } = params;

  const seriesList: Series[] = [];
  for (const [tk, pr] of Object.entries(pricesByTicker)) {
    const s = buildSeries(tk, pr);
    if (s) seriesList.push(s);
  }
  if (seriesList.length < 5) {
    return emptyResult("横断チルトには最低5銘柄が必要です（十分な履歴つき）。", tHurdle);
  }

  // 参照カレンダー＝全銘柄の日付の和集合（ソート）。
  const dateSet = new Set<string>();
  for (const s of seriesList) for (const d of s.dates) dateSet.add(d);
  const refDates = [...dateSet].sort();
  if (refDates.length < MIN_HISTORY + rebalanceDays + 10) {
    return emptyResult("共通期間が短すぎます。", tHurdle);
  }

  // リバランス参照日インデックス。
  const rebalanceIdx: number[] = [];
  for (let r = MIN_HISTORY; r + rebalanceDays < refDates.length; r += rebalanceDays) {
    rebalanceIdx.push(r);
  }
  if (rebalanceIdx.length < 8) {
    return emptyResult("リバランス回数が不足しています（期間を延ばすか間隔を詰めてください）。", tHurdle);
  }

  const periodsPerYear = 252 / rebalanceDays;
  const oneWayCost = costBps / 1e4;

  // 期間別の床リターンと、各シグナルのチルトリターン。
  const times: string[] = [];
  const baseRets: number[] = [];
  const tiltRets: Record<TiltSignalId, number[]> = {
    momentum: [],
    lowvol: [],
    shortrev: [],
    trend: [],
  };
  const tiltNetRets: Record<TiltSignalId, number[]> = {
    momentum: [],
    lowvol: [],
    shortrev: [],
    trend: [],
  };
  const prevLong: Record<TiltSignalId, Set<string>> = {
    momentum: new Set(),
    lowvol: new Set(),
    shortrev: new Set(),
    trend: new Set(),
  };
  let prevBase: Set<string> = new Set();
  const turnoverSum: Record<TiltSignalId, number> = {
    momentum: 0,
    lowvol: 0,
    shortrev: 0,
    trend: 0,
  };
  let avgLongSum = 0;
  let avgLongCnt = 0;

  for (const r of rebalanceIdx) {
    const d = refDates[r];
    const d2 = refDates[r + rebalanceDays];
    times.push(d2);

    // 適格集合 E: d と d2 の両方に在籍し、i>=MIN_HISTORY(特性計算に足る履歴)。
    interface Elig {
      s: Series;
      i: number;
      fwd: number;
    }
    const elig: Elig[] = [];
    for (const s of seriesList) {
      const i = s.idxByDate.get(d);
      const j = s.idxByDate.get(d2);
      if (i == null || j == null || i < MIN_HISTORY) continue;
      if (!(s.closes[i] > 0 && s.closes[j] > 0)) continue;
      elig.push({ s, i, fwd: s.closes[j] / s.closes[i] - 1 });
    }
    if (elig.length < 5) {
      // この期間は横断が薄い→床のみ記録し全シグナル0超過(欠測ではなく中立)。
      baseRets.push(0);
      for (const sig of TILT_SIGNALS) {
        tiltRets[sig].push(0);
        tiltNetRets[sig].push(0);
      }
      continue;
    }

    // 床＝適格の等加重。
    const baseSet = new Set(elig.map((e) => e.s.ticker));
    const baseRet = mean(elig.map((e) => e.fwd));
    const baseTurn = oneWayTurnover(prevBase, baseSet);
    prevBase = baseSet;
    baseRets.push(baseRet - baseTurn * oneWayCost); // 床にも同じコスト会計（公平化）

    const nLong = Math.max(1, Math.round(elig.length * quantile));
    avgLongSum += nLong;
    avgLongCnt++;

    for (const sig of TILT_SIGNALS) {
      // 特性スコアで降順→上位 nLong をロング。スコア欠測は末尾扱い(除外)。
      const scored = elig
        .map((e) => ({ e, v: score(sig, e.s, e.i) }))
        .filter((x) => x.v != null) as { e: Elig; v: number }[];
      if (scored.length < nLong) {
        tiltRets[sig].push(baseRet);
        tiltNetRets[sig].push(baseRet - baseTurn * oneWayCost);
        continue;
      }
      scored.sort((a, b) => b.v - a.v);
      const longSet = scored.slice(0, nLong);
      const tiltRet = mean(longSet.map((x) => x.e.fwd));
      const longTickers = new Set(longSet.map((x) => x.e.s.ticker));
      const turn = oneWayTurnover(prevLong[sig], longTickers);
      prevLong[sig] = longTickers;
      turnoverSum[sig] += turn;
      tiltRets[sig].push(tiltRet);
      tiltNetRets[sig].push(tiltRet - turn * oneWayCost);
    }
  }

  const nPeriods = baseRets.length;
  const years = nPeriods / periodsPerYear;
  const base = seriesMetrics(baseRets, periodsPerYear, times);

  // 各シグナルの超過統計。
  const rawResults: (Omit<TiltSignalResult, "qValueBH" | "passes"> & { pRaw: number })[] = [];
  for (const sig of TILT_SIGNALS) {
    const tilt = seriesMetrics(tiltRets[sig], periodsPerYear, times);
    const tiltNet = seriesMetrics(tiltNetRets[sig], periodsPerYear, times);
    const excessSeries = tiltRets[sig].map((v, k) => v - baseRets[k]);
    const tt = tTest(excessSeries);
    const excessAnn = tilt.annDrift - base.annDrift;
    const netExcessAnn = tiltNet.annDrift - base.annDrift;
    const turnoverPerYear = (turnoverSum[sig] / Math.max(1, nPeriods)) * periodsPerYear;
    rawResults.push({
      signal: sig,
      nPeriods,
      annTilt: tilt.annDrift,
      annBaseline: base.annDrift,
      excessAnn,
      netExcessAnn,
      excessT: tt ? tt.t : 0,
      pValue: tt ? tt.p : 1,
      pRaw: tt ? tt.p : 1,
      gTilt: tilt.growthRate,
      gBaseline: base.growthRate,
      sharpeTilt: tilt.sharpe,
      sharpeBaseline: base.sharpe,
      maxDDTilt: tilt.maxDD,
      maxDDBaseline: base.maxDD,
      avgLong: avgLongCnt ? avgLongSum / avgLongCnt : 0,
      turnoverPerYear,
      equityTilt: tiltNet.equity,
    });
  }

  // BH-FDR（命題4）。
  const qvals = benjaminiHochberg(rawResults.map((r) => r.pRaw));
  const signals: TiltSignalResult[] = rawResults.map((r, k) => {
    const qValueBH = qvals[k];
    const passes = qValueBH < 0.1 && r.excessT > tHurdle && r.netExcessAnn > 0;
    const { pRaw, ...rest } = r;
    void pRaw;
    return { ...rest, qValueBH, passes };
  });
  signals.sort((a, b) => b.excessAnn - a.excessAnn);

  // 診断（生存者バイアス・N_eff）。
  const lastRef = refDates[refDates.length - 1];
  const lastIdx = refDates.length - 1;
  let survivors = 0;
  for (const s of seriesList) {
    const li = refDates.indexOf(s.dates[s.dates.length - 1]);
    if (li >= lastIdx - 5) survivors++; // 終端±5営業日以内まで届く
  }
  const { rho, nEff } = crossCorrelation(seriesList);

  const diag: TiltDiagnostics = {
    universeSize: seriesList.length,
    survivorsToEnd: survivors,
    survivorshipWarning: survivors / seriesList.length > 0.9,
    avgPairCorr: rho,
    nEff,
    from: times[0] ?? refDates[MIN_HISTORY],
    to: lastRef,
    years,
    nPeriods,
  };

  return { ok: true, signals, baselineEquity: base.equity, diag, tHurdle };
}

function emptyResult(reason: string, tHurdle: number): SelectionTiltResult {
  return {
    ok: false,
    reason,
    signals: [],
    baselineEquity: [],
    diag: {
      universeSize: 0,
      survivorsToEnd: 0,
      survivorshipWarning: false,
      avgPairCorr: 0,
      nEff: 0,
      from: "",
      to: "",
      years: 0,
      nPeriods: 0,
    },
    tHurdle,
  };
}
