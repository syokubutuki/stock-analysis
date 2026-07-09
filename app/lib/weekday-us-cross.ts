// 曜日 × 前夜米国ビン 交互作用パスの「ウォッチリスト横断」集計。
//
// 単一銘柄版(WeekdayUsPathChart / weekday-intraday-path)は、選んだ前夜米国ビンの翌日だけに
// 絞って曜日別の日内累積パスを描く。だがビン×曜日でセルが薄く、1銘柄では「その銘柄固有の癖」か
// 「地合い×曜日の共通構造」かを判別できない。本モジュールは同じ絞り込みを複数銘柄に一斉適用し、
//   - 各銘柄の (曜日 × 選択ビン) の終端リターン/ピーク時刻をスカラーに縮約してマトリクス化
//   - 全銘柄をプールした「横断コンセンサス」を日付クラスタ頑健SEで算出(intraday-basket に委譲)
// して、固有 vs 共通の切り分けと実効標本の底上げを行う。
//
// 前夜米国ビンの境界は「全銘柄で共通」に取る(銘柄横断で同じ米国リターン帯=同じ地合いを比較する)。
// 銘柄ごとに立会日が微妙に違っても、日付でデデュープした米国リターン集合から順位分割するため
// 一貫したビン帯と単一の「今日の所属ビン」を得る。

import { DayData, BinGrid } from "./intraday-core";
import {
  UsReturn, AlignedDay, BinScheme, BinMeta, binMeta, binEdges, binOfValue, alignJpUs,
} from "./us-spillover-core";
import { computeWeekdayPaths } from "./weekday-intraday-path";
import { poolWeekdayPaths, BasketPathResult } from "./intraday-basket";

export type UsMode = "ret" | "intra";

export const CROSS_WD_ORDER = [1, 2, 3, 4, 5];
export const CROSS_WD_LABELS: Record<number, string> = {
  1: "月", 2: "火", 3: "水", 4: "木", 5: "金",
};

// 横断集計に渡す1銘柄分。days は groupByDay の出力、gmtoffset はその銘柄の取引所オフセット。
export interface CrossStock {
  ticker: string;
  name?: string;
  days: DayData[];
  gmtoffset: number;
}

export function usValueOf(u: UsReturn, mode: UsMode): number {
  return mode === "intra" ? u.intra : u.ret;
}

// ───────────────────────── 前処理(整合・米国値の収集) ─────────────────────────

export interface AlignedStock {
  ticker: string;
  name?: string;
  gmtoffset: number;
  aligned: AlignedDay[];
}

export interface CrossPrep {
  stocks: AlignedStock[];
  usVals: number[]; // 前夜米国リターン(日付デデュープ・有限・非ゼロ)。ビン境界の母集団。
  latest: { date: string; value: number } | null; // 直近の前夜米国(未ペアの最新終値も採用)
  lastPairedUsDate: string | null; // 実際に翌日とペアした最新の米国立会日
}

export function prepCross(stocks: CrossStock[], us: UsReturn[], mode: UsMode): CrossPrep | null {
  const aligned: AlignedStock[] = stocks.map((s) => ({
    ticker: s.ticker,
    name: s.name,
    gmtoffset: s.gmtoffset,
    aligned: alignJpUs(s.days, us),
  }));
  // 前夜米国リターンを日付でデデュープ(同じ米国立会日は同じ値)。ビン境界の母集団にする。
  const byDate = new Map<string, number>();
  let lastPairedUsDate: string | null = null;
  for (const st of aligned) {
    for (const a of st.aligned) {
      const v = usValueOf(a.us, mode);
      if (!isFinite(v) || v === 0) continue;
      byDate.set(a.us.date, v);
      if (!lastPairedUsDate || a.us.date > lastPairedUsDate) lastPairedUsDate = a.us.date;
    }
  }
  const usVals = Array.from(byDate.values());
  if (usVals.length < 8) return null;

  // 直近の前夜米国(寄り前で最後に確定した米国。翌日未ペアの最新終値も採る)
  let latest: { date: string; value: number } | null = null;
  for (let i = us.length - 1; i >= 0; i--) {
    const v = usValueOf(us[i], mode);
    if (isFinite(v) && v !== 0) { latest = { date: us[i].date, value: v }; break; }
  }
  return { stocks: aligned, usVals, latest, lastPairedUsDate };
}

// ───────────────────────── ビン化(全銘柄共通の境界) ─────────────────────────

export interface CrossBinInfo {
  bin: number;
  label: string;
  color: string;
  nUsDays: number; // このビンに入る前夜米国立会日数(銘柄非依存)
  rangeLo: number | null;
  rangeHi: number | null;
}

export interface CrossBinning {
  edges: number[];
  meta: BinMeta;
  binInfos: CrossBinInfo[];
  todayBin: number; // 直近の前夜米国が属するビン
  todayUnpaired: boolean; // 直近が翌日未反映(寄り前)か
}

export function computeCrossBinning(prep: CrossPrep, scheme: BinScheme): CrossBinning {
  const meta = binMeta(scheme);
  const edges = binEdges(prep.usVals, scheme);
  const binOf = (v: number) => binOfValue(v, scheme, edges);
  const counts = new Array(meta.count).fill(0);
  for (const v of prep.usVals) counts[binOf(v)]++;
  const binInfos: CrossBinInfo[] = meta.labels.map((label, b) => ({
    bin: b, label, color: meta.colors[b], nUsDays: counts[b],
    rangeLo: b === 0 ? null : edges[b - 1],
    rangeHi: b === meta.count - 1 ? null : edges[b],
  }));
  const todayBin = prep.latest ? binOf(prep.latest.value) : Math.floor(meta.count / 2);
  const todayUnpaired = !!(prep.latest && prep.lastPairedUsDate && prep.latest.date > prep.lastPairedUsDate);
  return { edges, meta, binInfos, todayBin, todayUnpaired };
}

// ───────────────────────── 選択ビンでの横断マトリクス ─────────────────────────

// 1銘柄 × 1曜日 のセル。パスを終端リターンとピーク時刻に縮約したもの。
export interface CrossCell {
  weekday: number;
  n: number;
  endMean: number; // 寄り→引けの平均累積リターン
  endP: number; // 終端が0と異なるかの1標本t p値
  peakIdx: number; // 平均パスが最大の時間ビン
  troughIdx: number;
  peakLabel: string;
}

export interface CrossRow {
  ticker: string;
  name?: string;
  cells: (CrossCell | null)[]; // CROSS_WD_ORDER 順。該当日不足なら null
  nTotal: number; // 選択ビンで使えた立会日数(全曜日合計)
}

export interface CrossResult {
  rows: CrossRow[];
  consensus: BasketPathResult | null; // 全銘柄プールのクラスタ頑健コンセンサス
  timeLabels: string[];
  selBin: number;
}

// 選択した前夜米国ビンに絞り、各銘柄の曜日別終端/ピークと、全銘柄プールのコンセンサスを返す。
export function computeCrossRows(
  prep: CrossPrep,
  grid: BinGrid,
  scheme: BinScheme,
  mode: UsMode,
  edges: number[],
  selBin: number
): CrossResult {
  const timeLabels = grid.bins.map((x) => x.label);
  const inBin = (a: AlignedDay) => binOfValue(usValueOf(a.us, mode), scheme, edges) === selBin;

  const rows: CrossRow[] = [];
  const pooled: { ticker: string; name?: string; days: DayData[] }[] = [];

  for (const st of prep.stocks) {
    const selDays = st.aligned.filter(inBin).map((a) => a.jp);
    pooled.push({ ticker: st.ticker, name: st.name, days: selDays });
    const wp = computeWeekdayPaths(selDays, grid, st.gmtoffset);
    const cells: (CrossCell | null)[] = CROSS_WD_ORDER.map((wd) => {
      const b = wp?.bins.find((x) => x.weekday === wd);
      if (!b || b.n < 1) return null;
      return {
        weekday: wd, n: b.n, endMean: b.endMean, endP: b.endP,
        peakIdx: b.peakIdx, troughIdx: b.troughIdx,
        peakLabel: timeLabels[b.peakIdx] ?? "",
      };
    });
    rows.push({
      ticker: st.ticker, name: st.name, cells,
      nTotal: selDays.filter((d) => CROSS_WD_ORDER.includes(d.weekday)).length,
    });
  }

  // 横断コンセンサス: 全銘柄の選択ビン立会日をプールし、日付クラスタ頑健SEで曜日別に集計。
  const gmt = prep.stocks[0]?.gmtoffset ?? 0;
  const consensus = poolWeekdayPaths(pooled, grid, gmt);

  return { rows, consensus, timeLabels, selBin };
}
