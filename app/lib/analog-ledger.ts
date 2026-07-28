// アナログ予測の前向き検証台帳(改善C): 予測を「凍結」し、凍結後に到着したデータだけで採点する。
//
// OOS 検証(weekly-analog-oos.ts)は各週末で as-of 再計算するウォークフォワードであり、
// 設定を触れば結果が動く。「その設定を選んだこと自体」が過去を見た後の選択なので、
// どれだけ厳密に組んでも探索の痕跡は完全には消えない。最も誠実な検証は本物の前向き検証——
// 予測を日付とともに固定し、まだ存在しなかった未来のデータでのみ評価する——である
// (臨床試験の事前登録 pre-registration の投資版)。edge節の prospective-ledger.ts と同じ思想で、
// 対象を「エッジの取引列」から「アナログの予測経路」に置き換えたもの。
//
// 凍結するのは終点だけでなく経路一式(中央値パス・25–75%帯・高安到達 MFE/MAE)。
// 再訪のたびに実際に辿った経路を重ね、方向・帯の被覆・高安到達を突き合わせる。
// 凍結後にパラメータを差し替えられないことが、この検証の価値の源泉。

import { PricePoint } from "./types";
import { AnalogMode, DistMetric, WindowAlign, WeightMode, UsMode, WeeklyAnalogResult } from "./weekly-analog";
import { BinScheme } from "./us-spillover-core";
import { spearman } from "./weekly-analog-oos";
import { median as medianOf } from "./stats-significance";

const STORAGE_KEY = "analog-ledger:v1";
const MAX_ENTRIES = 600;

export interface AnalogLedgerSettings {
  mode: AnalogMode;
  metric: DistMetric;
  align: WindowAlign;
  weight: WeightMode;
  volNorm: boolean;
  pool: boolean;
  L: number; H: number; K: number;
  usTicker: string;
  usMode: UsMode;
  scheme: BinScheme;
  selBin: number;
  binLabel: string;
  // 個別銘柄タブ側にしかない調整。横断版から凍結した記録では既定値が入る。
  dtwBandFrac?: number; // DTW バンド幅(窓長比)。metric="dtw" のときのみ効く
  hlWeight?: number;    // HL レンジ距離の重み γ
}

export interface AnalogLedgerEntry {
  id: string;
  ticker: string;
  name?: string;
  frozenAt: string;  // 凍結操作を行った実日付
  asOf: string;      // 予測基準日 = 凍結時点の最終立会日(この日の終値が経路の起点0%)
  settings: AnalogLedgerSettings;
  label: string;     // 設定の短い説明(表示用)
  // ── 凍結される予測(長さ H+1、[0]=0) ──
  predPath: number[];
  predP25: number[];
  predP75: number[];
  predMedian: number; // H日後の終値中央値
  predMfe: number; predMae: number;
  // ── 凍結時に根拠としていた in-sample 指標(後から「何を見て張ったか」を検証するため) ──
  nSelected: number;
  nEff: number;
  diffMedian: number;
  diffP: number;
  novelty: number;
  winRate: number;
}

export function loadAnalogLedger(): AnalogLedgerEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AnalogLedgerEntry[]) : [];
  } catch {
    return [];
  }
}

function saveAnalogLedger(entries: AnalogLedgerEntry[]) {
  if (typeof window === "undefined") return;
  try {
    // 古い順に切り詰め(台帳は補助機能なので容量超過で壊れないことを優先)
    const trimmed = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // 容量超過などは黙って無視
  }
}

export function settingsLabel(s: AnalogLedgerSettings): string {
  const modeL = s.mode === "similar" ? "似た形" : s.mode === "usbin" ? `米国ビン:${s.binLabel}` : `アンサンブル:${s.binLabel}`;
  const winL = s.align === "week" ? "週境界" : `直近${s.L}`;
  const band = s.metric === "dtw" && s.dtwBandFrac != null ? `/帯${Math.round(s.dtwBandFrac * 100)}%` : "";
  const hl = s.hlWeight ? `/HLγ${s.hlWeight.toFixed(1)}` : "";
  return `${modeL}/${s.metric === "dtw" ? "DTW" : "ユークリッド"}${band}/${winL}/H${s.H}${s.weight === "kernel" ? "/カーネル" : ""}${s.volNorm ? "/σ" : ""}${s.pool ? "/プール" : ""}${hl}`;
}

// 同一の予測(銘柄×基準日×設定)は一度しか凍結できない。
// 後から条件を変えて記録し直せると前向き検証の意味が消えるため、既存があればスキップする。
export function entryKey(ticker: string, asOf: string, s: AnalogLedgerSettings): string {
  // DTW バンドはユークリッド時は無関係なので鍵に含めない(同じ予測が別記録になるのを防ぐ)
  const band = s.metric === "dtw" ? String(s.dtwBandFrac ?? 0.25) : "-";
  return [ticker, asOf, s.mode, s.metric, s.align, s.weight, s.volNorm ? 1 : 0, s.pool ? 1 : 0,
    s.L, s.H, s.K, s.usTicker, s.usMode, s.scheme, s.selBin, band, s.hlWeight ?? 0].join("|");
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface FreezeInput {
  ticker: string;
  name?: string;
  res: WeeklyAnalogResult;
}

// 現在表示中の予測をまとめて凍結する。戻り値は {追加, 重複でスキップ}。
export function freezeAnalogPredictions(
  inputs: FreezeInput[], settings: AnalogLedgerSettings
): { added: number; skipped: number; entries: AnalogLedgerEntry[] } {
  const entries = loadAnalogLedger();
  const existing = new Set(entries.map((e) => entryKey(e.ticker, e.asOf, e.settings)));
  const label = settingsLabel(settings);
  const frozenAt = todayIso();
  let added = 0, skipped = 0;
  for (const inp of inputs) {
    const r = inp.res;
    const asOf = r.query.endTime;
    const key = entryKey(inp.ticker, asOf, settings);
    if (existing.has(key)) { skipped++; continue; }
    const denom = r.upCount + r.downCount || 1;
    entries.push({
      id: `${inp.ticker}-${asOf}-${Date.now()}-${added}`,
      ticker: inp.ticker,
      name: inp.name,
      frozenAt, asOf, settings, label,
      predPath: r.fwdMedian.slice(),
      predP25: r.fwdP25.slice(),
      predP75: r.fwdP75.slice(),
      predMedian: r.medianFinal,
      predMfe: r.medianMfe,
      predMae: r.medianMae,
      nSelected: r.selected.length,
      nEff: r.nEff,
      diffMedian: r.diffMedian,
      diffP: r.diffP,
      novelty: r.novelty,
      winRate: r.upCount / denom,
    });
    existing.add(key);
    added++;
  }
  saveAnalogLedger(entries);
  return { added, skipped, entries: loadAnalogLedger() };
}

export function removeAnalogEntry(id: string): AnalogLedgerEntry[] {
  const entries = loadAnalogLedger().filter((e) => e.id !== id);
  saveAnalogLedger(entries);
  return entries;
}

export function clearAnalogLedger(): AnalogLedgerEntry[] {
  saveAnalogLedger([]);
  return [];
}

// 手動バックアップ用。localStorage はブラウザを変えると消えるため、
// 前向き検証を年単位で続けるならエクスポートして保管する。
export function exportAnalogLedger(): string {
  return JSON.stringify(loadAnalogLedger(), null, 2);
}

export function importAnalogLedger(json: string): { added: number; skipped: number; entries: AnalogLedgerEntry[] } {
  let incoming: AnalogLedgerEntry[];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return { added: 0, skipped: 0, entries: loadAnalogLedger() };
    incoming = parsed as AnalogLedgerEntry[];
  } catch {
    return { added: 0, skipped: 0, entries: loadAnalogLedger() };
  }
  const entries = loadAnalogLedger();
  const existing = new Set(entries.map((e) => entryKey(e.ticker, e.asOf, e.settings)));
  let added = 0, skipped = 0;
  for (const e of incoming) {
    if (!e || !e.ticker || !e.asOf || !e.settings || !Array.isArray(e.predPath)) { skipped++; continue; }
    const key = entryKey(e.ticker, e.asOf, e.settings);
    if (existing.has(key)) { skipped++; continue; }
    entries.push(e); existing.add(key); added++;
  }
  saveAnalogLedger(entries);
  return { added, skipped, entries: loadAnalogLedger() };
}

// ───────────────────────── 採点 ─────────────────────────

export type AnalogVerdict = "waiting" | "partial" | "verified" | "stale";

export interface AnalogLedgerEval {
  entry: AnalogLedgerEntry;
  verdict: AnalogVerdict;
  daysDone: number;   // 基準日以降に到着した立会日数(最大 H)
  actPath: number[];  // 実測の終値累積パス(長さ daysDone+1、[0]=0)
  actMfe: number; actMae: number; // これまでの高値/安値到達
  actFinal: number;   // 直近時点の累積リターン(daysDone=H なら確定値)
  dirHit: boolean | null;   // 方向一致(daysDone>=1 で暫定、H で確定)
  coverage: number;   // 実測が予測25–75%帯に入った日の割合
  mfeReached: boolean; // 予測 MFE 水準に到達したか(利確目標に届いたか)
  maeReached: boolean; // 予測 MAE 水準に到達したか(損切り水準に触れたか)
  err: number;        // 実測 − 予測(終点)。正＝予測より上振れ
}

// 基準日の位置を価格系列から引く。祝日等でズレた場合は「基準日以下の最後の立会日」を採用。
function indexOfAsOf(prices: PricePoint[], asOf: string): number {
  let lo = 0, hi = prices.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (prices[mid].time <= asOf) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans < 0) return -1;
  return prices[ans].time === asOf ? ans : -1; // 厳密一致のみ採点(データ差し替え時の取り違えを防ぐ)
}

export function evaluateAnalogEntry(entry: AnalogLedgerEntry, prices: PricePoint[] | undefined): AnalogLedgerEval | null {
  if (!prices || prices.length === 0) return null;
  const H = entry.settings.H;
  const idx = indexOfAsOf(prices, entry.asOf);
  if (idx < 0) {
    // 基準日が価格系列に無い(期間フィルタで落ちた/データ更新でズレた)
    return {
      entry, verdict: "stale", daysDone: 0, actPath: [0], actMfe: 0, actMae: 0, actFinal: NaN,
      dirHit: null, coverage: NaN, mfeReached: false, maeReached: false, err: NaN,
    };
  }
  const baseC = prices[idx].close;
  if (!(baseC > 0)) return null;
  const avail = Math.min(H, prices.length - 1 - idx);
  const actPath: number[] = [0];
  let runH = (prices[idx].high > 0 ? prices[idx].high : baseC) / baseC - 1;
  let runL = (prices[idx].low > 0 ? prices[idx].low : baseC) / baseC - 1;
  let covHit = 0, covTot = 0;
  for (let m = 1; m <= avail; m++) {
    const p = prices[idx + m];
    if (!p || !(p.close > 0)) break;
    const c = p.close / baseC - 1;
    actPath.push(c);
    runH = Math.max(runH, (p.high > 0 ? p.high : p.close) / baseC - 1);
    runL = Math.min(runL, (p.low > 0 ? p.low : p.close) / baseC - 1);
    const lo = entry.predP25[m], hi = entry.predP75[m];
    if (isFinite(lo) && isFinite(hi)) {
      covTot++;
      if (c >= Math.min(lo, hi) && c <= Math.max(lo, hi)) covHit++;
    }
  }
  const daysDone = actPath.length - 1;
  const actFinal = daysDone >= 1 ? actPath[daysDone] : NaN;
  const verdict: AnalogVerdict = daysDone >= H ? "verified" : daysDone >= 1 ? "partial" : "waiting";
  return {
    entry, verdict, daysDone, actPath,
    actMfe: runH, actMae: runL, actFinal,
    dirHit: daysDone >= 1 && entry.predMedian !== 0 ? Math.sign(actFinal) === Math.sign(entry.predMedian) : null,
    coverage: covTot ? covHit / covTot : NaN,
    mfeReached: runH >= entry.predMfe,
    maeReached: runL <= entry.predMae,
    err: daysDone >= 1 ? actFinal - entry.predMedian : NaN,
  };
}

export interface AnalogLedgerSummary {
  nTotal: number;
  nVerified: number;   // H日ぶん出揃った記録
  nPartial: number;
  nWaiting: number;
  nStale: number;
  dirHitRate: number;  // 確定分の方向的中率
  coverage: number;    // 確定分の帯被覆率(名目0.5)
  medianErr: number;   // 実測−予測 の中央値(正＝予測が控えめ)
  mfeReachRate: number; // 予測MFEに到達した割合(較正なら≒0.5)
  maeReachRate: number; // 予測MAEに触れた割合(較正なら≒0.5)
  ic: number;          // 確定分の Spearman(予測終値中央, 実測終点)
  medianPred: number; medianAct: number;
}

export function summarizeAnalogLedger(evals: AnalogLedgerEval[]): AnalogLedgerSummary {
  const ver = evals.filter((e) => e.verdict === "verified");
  const n = ver.length;
  const dirs = ver.filter((e) => e.dirHit !== null);
  const covs = ver.map((e) => e.coverage).filter((v) => isFinite(v));
  return {
    nTotal: evals.length,
    nVerified: n,
    nPartial: evals.filter((e) => e.verdict === "partial").length,
    nWaiting: evals.filter((e) => e.verdict === "waiting").length,
    nStale: evals.filter((e) => e.verdict === "stale").length,
    dirHitRate: dirs.length ? dirs.filter((e) => e.dirHit).length / dirs.length : NaN,
    coverage: covs.length ? covs.reduce((s, v) => s + v, 0) / covs.length : NaN,
    medianErr: n ? medianOf(ver.map((e) => e.err).filter((v) => isFinite(v))) : NaN,
    mfeReachRate: n ? ver.filter((e) => e.mfeReached).length / n : NaN,
    maeReachRate: n ? ver.filter((e) => e.maeReached).length / n : NaN,
    ic: n >= 5 ? spearman(ver.map((e) => e.entry.predMedian), ver.map((e) => e.actFinal)) : NaN,
    medianPred: n ? medianOf(ver.map((e) => e.entry.predMedian)) : NaN,
    medianAct: n ? medianOf(ver.map((e) => e.actFinal)) : NaN,
  };
}
