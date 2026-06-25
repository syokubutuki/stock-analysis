// TWAP/VWAP 分割約定の効果分析。
//
// 1点約定(寄成/引成)の代わりに、窓内で分割約定する場合の「平均フィル(バイアス)」と
// 「フィルのばらつき(タイミングリスク)」のトレードオフを測る。
//   ・TWAP_W : 窓内バーの等加重平均(等時間分割)
//   ・VWAP_W : 窓内バーの出来高加重平均(出来高比例分割。執行ベンチの定番)
// 当日フルVWAPを公正値ベンチに、方向考慮の約定品質 q を集計。窓を延ばすほど分散は縮むが
// ドリフトリスクが乗る、という平均-分散の執行フロンティアを描く土台。

import { IntradayBar, groupByDay } from "./intraday-core";
import { mean, std, blockBootstrapCI } from "./stats-significance";
import { dayVwap, Side, Leg } from "./execution-timing";

export interface SliceMethod {
  id: string;
  label: string;
  windowMin: number; // 0=単発
  n: number;
  meanQPct: number; // 当日VWAP比 約定品質(方向考慮, %)
  qCiLoPct: number; qCiHiPct: number;
  fillStdPct: number; // (P−マーク)/マーク の標準偏差(%) = タイミングリスク
  isMeanPct: number; // 実装ショートフォール平均(マーク基準, %)
  isSingle: boolean;
}

export interface SlicedResult {
  side: Side;
  leg: Leg;
  intervalMin: number;
  nDays: number;
  methods: SliceMethod[];
  single: SliceMethod | null;
  best: SliceMethod | null; // 平均が単発以上で分散最小
  markLabel: string;
}

const WINDOWS = [15, 30, 60];

function intervalMinutes(interval: string): number {
  const m = /^(\d+)\s*m$/.exec(interval);
  return m ? parseInt(m[1], 10) : 5;
}

// 寄り側=先頭からW分 / 引け側=末尾W分 のバー範囲で TWAP・VWAP を返す。
function windowAvg(
  bars: IntradayBar[], gmtoffset: number, leg: Leg, windowMin: number,
  localMin: (ts: number) => number
): { twap: number; vwap: number } | null {
  const openMin = localMin(bars[0].ts);
  const lastMin = localMin(bars[bars.length - 1].ts);
  let sum = 0, cnt = 0, pv = 0, vol = 0;
  for (const b of bars) {
    const el = localMin(b.ts);
    const inWin = leg === "open" ? (el - openMin) <= windowMin : (lastMin - el) <= windowMin;
    if (!inWin || !(b.close > 0)) continue;
    const typical = (b.high + b.low + b.close) / 3;
    sum += b.close; cnt++;
    pv += typical * (b.volume || 0); vol += b.volume || 0;
  }
  if (cnt === 0) return null;
  return { twap: sum / cnt, vwap: vol > 0 ? pv / vol : sum / cnt };
}

export function computeSlicedExecution(
  bars: IntradayBar[],
  gmtoffset: number,
  side: Side,
  leg: Leg,
  interval: string
): SlicedResult | null {
  const days = groupByDay(bars, gmtoffset);
  if (days.length < 5) return null;
  const iv = intervalMinutes(interval);
  const sgn = side === "buy" ? 1 : -1;
  const localMin = (ts: number) => ((Math.floor((ts + gmtoffset) / 60) % 1440) + 1440) % 1440;

  // 手法ごとに q / drift / IS を蓄積
  interface Acc { q: number[]; drift: number[]; is: number[] }
  const mk = (): Acc => ({ q: [], drift: [], is: [] });
  const single = mk();
  const windows = WINDOWS.filter((w) => w >= iv); // 足より短い窓は無意味
  const twapAcc = new Map<number, Acc>(windows.map((w) => [w, mk()]));
  const vwapAcc = new Map<number, Acc>(windows.map((w) => [w, mk()]));

  let usedDays = 0;
  for (const day of days) {
    const bs = day.bars;
    if (bs.length < 2) continue;
    const fullV = dayVwap(bs);
    if (!(fullV > 0)) continue;
    const mark = leg === "open" ? bs[0].open : bs[bs.length - 1].close;
    if (!(mark > 0)) continue;
    usedDays++;

    const push = (acc: Acc, p: number) => {
      acc.q.push(sgn * (fullV - p) / fullV);
      acc.drift.push((p - mark) / mark);
      acc.is.push(sgn * (p - mark) / mark);
    };
    push(single, mark);
    for (const w of windows) {
      const wa = windowAvg(bs, gmtoffset, leg, w, localMin);
      if (!wa) continue;
      push(twapAcc.get(w)!, wa.twap);
      push(vwapAcc.get(w)!, wa.vwap);
    }
  }
  if (usedDays < 5) return null;

  const toMethod = (id: string, label: string, windowMin: number, acc: Acc, isSingle: boolean): SliceMethod => {
    const ci = acc.q.length >= 8 ? blockBootstrapCI(acc.q, 500) : null;
    const m = mean(acc.q);
    return {
      id, label, windowMin, n: acc.q.length,
      meanQPct: m * 100,
      qCiLoPct: (ci ? ci.lo : m) * 100,
      qCiHiPct: (ci ? ci.hi : m) * 100,
      fillStdPct: std(acc.drift) * 100,
      isMeanPct: mean(acc.is) * 100,
      isSingle,
    };
  };

  const markLabel = leg === "open" ? "寄成" : "引成";
  const methods: SliceMethod[] = [toMethod("single", `単発(${markLabel})`, 0, single, true)];
  for (const w of windows) {
    methods.push(toMethod(`twap${w}`, `TWAP ${w}分`, w, twapAcc.get(w)!, false));
    methods.push(toMethod(`vwap${w}`, `VWAP ${w}分`, w, vwapAcc.get(w)!, false));
  }

  const singleM = methods.find((m) => m.isSingle) ?? null;
  // 平均品質が単発以上(劣化しない)で、フィル分散が最小の分割手法
  const best = singleM
    ? methods
        .filter((m) => !m.isSingle && m.meanQPct >= singleM.meanQPct - 1e-9 && m.fillStdPct < singleM.fillStdPct)
        .sort((a, b) => a.fillStdPct - b.fillStdPct)[0] ?? null
    : null;

  return { side, leg, intervalMin: iv, nDays: usedDays, methods, single: singleM, best, markLabel };
}
