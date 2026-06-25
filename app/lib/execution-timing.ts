// 寄り/引け 近傍 約定ビン最適化。
//
// 日足の始値/終値エッジ(open-close-edge.ts)は「公式始値・終値ちょうどで約定できる」前提だが、
// 実際の約定は寄り付き直後・引け直前のどこかに置かれる。本モジュールは分足を使い、
// 「公式マーク(寄成/引成)で即時約定する代わりに N分待つ／N分早めると、その売買方向にとって
// 約定価格がどれだけ改善するか」を、複数営業日にわたって集計しブートCI付きで評価する。
//
// 主指標 improvement(オフセット, 方向):
//   買い: (公式マーク − 約定価格) / 公式マーク   … 安く買えれば正
//   売り: (約定価格 − 公式マーク) / 公式マーク   … 高く売れれば正
// オフセット0(=公式マーク)の improvement は定義上0で、待つ/早める価値の基準線になる。
// 副指標として当日VWAP比の約定品質、約定価格のばらつき(タイミングリスク)を併記する。

import { IntradayBar, groupByDay } from "./intraday-core";
import { mean, std, blockBootstrapCI } from "./stats-significance";

export type Side = "buy" | "sell";
export type Leg = "open" | "close";

export interface ExecBin {
  offsetMin: number; // 寄り側=寄り後の経過分 / 引け側=引け前の残り分
  barOffset: number; // マークから何バー離れているか
  label: string; // "寄成" / "+10分" / "引成" / "−10分"
  n: number;
  meanImprovePct: number; // 公式マーク比の約定改善(方向考慮, %)
  ciLoPct: number;
  ciHiPct: number;
  stable: number; // ブートで点推定と同符号だった割合(0..1)
  winRate: number; // improvement>0 の割合
  meanVsVwapPct: number; // 当日VWAP比の約定品質(方向考慮, %)
  driftStdPct: number; // 公式マークからの価格変化の標準偏差(%) = タイミングリスク
  isMark: boolean; // 公式マーク(オフセット0)か
}

export interface ExecResult {
  nDays: number;
  side: Side;
  leg: Leg;
  intervalMin: number;
  markLabel: string; // "公式始値" / "公式終値"
  bins: ExecBin[];
  best: ExecBin | null; // 待つ/早める側(オフセット>0)で平均改善が最大かつ有意なもの
  intervalNote: string | null; // 足が粗くて候補が削られた等の注記
}

function intervalMinutes(interval: string): number {
  const m = /^(\d+)\s*m$/.exec(interval);
  if (m) return parseInt(m[1], 10);
  const h = /^(\d+)\s*h$/.exec(interval) || /^(\d+)\s*m?o?$/.exec(interval);
  if (interval === "60m") return 60;
  return h ? parseInt(h[1], 10) : 5;
}

// 当日全バーの出来高加重平均価格(中立的な「公正値」ベンチマーク)。出来高ゼロ時は典型価格平均。
export function dayVwap(bars: IntradayBar[]): number {
  let pv = 0, v = 0, tpSum = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    const vol = b.volume || 0;
    pv += tp * vol; v += vol; tpSum += tp;
  }
  return v > 0 ? pv / v : bars.length ? tpSum / bars.length : 0;
}

const OFFSETS_MIN = [0, 5, 10, 15, 30];

export function computeExecutionTiming(
  bars: IntradayBar[],
  gmtoffset: number,
  side: Side,
  leg: Leg,
  interval: string
): ExecResult | null {
  const days = groupByDay(bars, gmtoffset);
  if (days.length < 5) return null;
  const iv = intervalMinutes(interval);

  // オフセット(分) → バー数。粗い足では小さいオフセットがマークに潰れるので重複排除。
  const barSet = new Map<number, number>(); // barOffset → offsetMin(代表)
  for (const om of OFFSETS_MIN) {
    const bo = Math.round(om / iv);
    if (!barSet.has(bo)) barSet.set(bo, om);
  }
  const barOffsets = [...barSet.keys()].sort((a, b) => a - b);
  const droppedCoarse = OFFSETS_MIN.length - barOffsets.length;

  // 各バーオフセットに対し、全営業日の improvement / vsVwap / drift を集める。
  const improveBy = new Map<number, number[]>();
  const vsVwapBy = new Map<number, number[]>();
  const driftBy = new Map<number, number[]>();
  for (const bo of barOffsets) { improveBy.set(bo, []); vsVwapBy.set(bo, []); driftBy.set(bo, []); }

  let usedDays = 0;
  for (const day of days) {
    const bs = day.bars;
    const last = bs.length - 1;
    if (last < Math.max(...barOffsets)) continue; // バー不足の日は除外
    const vwap = dayVwap(bs);
    if (!(vwap > 0)) continue;
    const mark = leg === "open" ? bs[0].open : bs[last].close;
    if (!(mark > 0)) continue;
    usedDays++;

    for (const bo of barOffsets) {
      // マークからbo分だけ「待つ(寄り)」or「早める(引け)」位置の約定価格
      let price: number;
      if (bo === 0) {
        price = mark;
      } else if (leg === "open") {
        price = bs[bo].open; // 寄り後 bo バー経過時点の価格
      } else {
        price = bs[last - bo].close; // 引け bo バー前の価格
      }
      if (!(price > 0)) continue;

      const drift = (price - mark) / mark; // 公式マークからの価格変化(符号そのまま)
      const improve = side === "buy" ? (mark - price) / mark : (price - mark) / mark;
      const vsVwap = side === "buy" ? (vwap - price) / vwap : (price - vwap) / vwap;
      improveBy.get(bo)!.push(improve);
      vsVwapBy.get(bo)!.push(vsVwap);
      driftBy.get(bo)!.push(drift);
    }
  }
  if (usedDays < 5) return null;

  const bins: ExecBin[] = barOffsets.map((bo) => {
    const imp = improveBy.get(bo)!;
    const ci = bo === 0 ? null : blockBootstrapCI(imp, 600);
    const offsetMin = barSet.get(bo)!;
    const sign = leg === "open" ? "+" : "−";
    const label = bo === 0 ? (leg === "open" ? "寄成" : "引成") : `${sign}${offsetMin}分`;
    return {
      offsetMin,
      barOffset: bo,
      label,
      n: imp.length,
      meanImprovePct: mean(imp) * 100,
      ciLoPct: ci ? ci.lo * 100 : 0,
      ciHiPct: ci ? ci.hi * 100 : 0,
      stable: ci ? ci.stable : 1,
      winRate: imp.length ? imp.filter((v) => v > 0).length / imp.length : 0,
      meanVsVwapPct: mean(vsVwapBy.get(bo)!) * 100,
      driftStdPct: std(driftBy.get(bo)!) * 100,
      isMark: bo === 0,
    };
  });

  // 待つ/早める候補のうち、平均改善が正・CIが0をまたがない中で最大
  const best = bins
    .filter((b) => !b.isMark && b.meanImprovePct > 0 && b.ciLoPct > 0 && b.n >= 10)
    .sort((a, b) => b.meanImprovePct - a.meanImprovePct)[0] ?? null;

  return {
    nDays: usedDays,
    side,
    leg,
    intervalMin: iv,
    markLabel: leg === "open" ? "公式始値" : "公式終値",
    bins,
    best,
    intervalNote: droppedCoarse > 0 ? `${interval}足のため一部の近接オフセットはマークに統合` : null,
  };
}
