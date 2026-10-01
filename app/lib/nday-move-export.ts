// 計算条件・取得期間・結果を、あとで同じ計算をやり直せる形で書き出す／読み戻す。
//
// ## 価格の指紋
// /api/stock の価格は配当・分割の調整後で、新しい権利落ちのたびに**過去の水準が遡って変わる**
// （比率は変わらない）。水準で照合すると、データが同じでも一致しない。そこで
// 日付と前日比の対数（10⁻⁶ で丸め）から FNV-1a の指紋を作る。水準の遡及調整には動じず、
// 行の欠落・追加・値の書き換えには反応する。
//
// ## CSV
// Excel で文字化けしないよう先頭に BOM を付ける。値は RFC 4180 の規則で引用する。

import type { PricePoint } from "./types";
import type { PriceSanityReport } from "./price-sanity";
import type { MoveDirection, ThresholdUnit, TriggerMode } from "./nday-move";
import type { CapitalModel, CostModel } from "./nday-move-trades";
import type { GridSpec } from "./nday-move-robustness";

export const NDAY_MOVE_EXPORT_KIND = "nday-move-analysis";
export const NDAY_MOVE_EXPORT_VERSION = 1;

export interface NdayMoveSettings {
  direction: MoveDirection;
  lookback: number;
  threshold: number;
  unit: ThresholdUnit;
  trigger: TriggerMode;
  horizon: number;
  excludeOverlap: boolean;
  drawdownPct: number;
  holdDays: number;
  cost: CostModel;
  capital: CapitalModel;
  /** 分析期間（両端を含む日付） */
  startDate: string;
  endDate: string;
  grid: GridSpec;
  walkForward: { minTrainYears: number; minTrades: number };
  cscvS: number;
  seed: number;
}

export interface DataFingerprint {
  firstDate: string;
  lastDate: string;
  bars: number;
  fingerprint: string;
}

export interface ExportEnvelope {
  kind: typeof NDAY_MOVE_EXPORT_KIND;
  version: number;
  generatedAt: string;
  ticker: string;
  sanitizerVersion: number;
  dataQuality: PriceSanityReport | null;
  /** 取得できた全期間 */
  data: DataFingerprint;
  /** 分析に使った期間 */
  analysis: DataFingerprint;
  settings: NdayMoveSettings;
  notes: string[];
  results: unknown;
}

export function priceFingerprint(prices: PricePoint[], from: number, to: number): DataFingerprint {
  let h = 0x811c9dc5;
  const mix = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
  };
  for (let i = from; i <= to; i++) {
    const ratio = i > from ? Math.round(1e6 * Math.log(prices[i].close / prices[i - 1].close)) : 0;
    mix(`${prices[i].time}:${ratio};`);
  }
  return {
    firstDate: prices[from]?.time ?? "",
    lastDate: prices[to]?.time ?? "",
    bars: Math.max(0, to - from + 1),
    fingerprint: h.toString(16).padStart(8, "0"),
  };
}

export function buildExport(input: Omit<ExportEnvelope, "kind" | "version">): ExportEnvelope {
  return { kind: NDAY_MOVE_EXPORT_KIND, version: NDAY_MOVE_EXPORT_VERSION, ...input };
}

type Cell = string | number | boolean | null | undefined;

function csvCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && !Number.isFinite(value)) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return `﻿${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export interface ImportResult {
  settings: NdayMoveSettings | null;
  envelope: ExportEnvelope | null;
  error: string | null;
  warnings: string[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * 書き出した JSON を読み、条件を復元する。現在のデータと指紋が違えば警告する
 * （データが更新された・銘柄が違う・期間が違うなど。数値は再現しないことがある）。
 */
export function parseExport(text: string, current: { ticker: string; prices: PricePoint[] }): ImportResult {
  const fail = (error: string): ImportResult => ({ settings: null, envelope: null, error, warnings: [] });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("JSON として読めません。書き出したファイルを選んでください。");
  }
  const env = parsed as Partial<ExportEnvelope>;
  if (!env || env.kind !== NDAY_MOVE_EXPORT_KIND) return fail("この分析で書き出したファイルではありません。");
  if (env.version !== NDAY_MOVE_EXPORT_VERSION) return fail(`対応していない版です（${String(env.version)}）。`);
  const s = env.settings as Partial<NdayMoveSettings> | undefined;
  if (!s || (s.direction !== "down" && s.direction !== "up") || !isNum(s.lookback) || !isNum(s.threshold)
    || (s.unit !== "pct" && s.unit !== "sigma") || (s.trigger !== "edge" && s.trigger !== "every")
    || !isNum(s.horizon) || typeof s.excludeOverlap !== "boolean" || !isNum(s.drawdownPct) || !isNum(s.holdDays)
    || !s.cost || !isNum(s.cost.commissionPct) || !isNum(s.cost.slippagePct)
    || !s.capital || !isNum(s.capital.initialCapital) || !isNum(s.capital.allocationPct) || !isNum(s.capital.lotSize)
    || typeof s.startDate !== "string" || typeof s.endDate !== "string"
    || !s.grid || !Array.isArray(s.grid.directions) || !Array.isArray(s.grid.lookbacks)
    || !Array.isArray(s.grid.thresholds) || !Array.isArray(s.grid.holds)
    || !s.walkForward || !isNum(s.walkForward.minTrainYears) || !isNum(s.walkForward.minTrades)
    || !isNum(s.cscvS) || !isNum(s.seed)) {
    return fail("計算条件の項目が欠けているか壊れています。");
  }
  const settings = s as NdayMoveSettings;
  const warnings: string[] = [];
  if (env.ticker !== current.ticker) warnings.push(`銘柄が違います（ファイル: ${String(env.ticker)} / 現在: ${current.ticker}）。条件だけを読み込みました。`);
  const from = current.prices.findIndex((p) => p.time >= settings.startDate);
  let to = -1;
  for (let i = current.prices.length - 1; i >= 0; i--) if (current.prices[i].time <= settings.endDate) { to = i; break; }
  if (from < 0 || to < from) {
    warnings.push("ファイルの分析期間が、現在取得できているデータの範囲にありません。");
  } else if (env.analysis && env.ticker === current.ticker) {
    const now = priceFingerprint(current.prices, from, to);
    if (now.fingerprint !== env.analysis.fingerprint || now.bars !== env.analysis.bars) {
      warnings.push(`分析期間の価格データが書き出し時と一致しません（書き出し時 ${env.analysis.bars}本・指紋 ${env.analysis.fingerprint} / 現在 ${now.bars}本・指紋 ${now.fingerprint}）。配信元の修正や再取得で値が変わった可能性があり、結果は完全には再現しません。`);
    }
  }
  return { settings, envelope: env as ExportEnvelope, error: null, warnings };
}

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
