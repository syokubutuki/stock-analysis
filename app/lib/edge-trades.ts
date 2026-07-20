// 正準エッジ・カタログ: 日次OHLCだけで執行できる代表的トレード型を
// 「非重複・取引レベル」のリターン系列(手仕舞い日付き)として抽出する共有基盤。
//
// エッジ容量推定(edge-capacity.ts)・エッジ減衰検知(edge-decay.ts)・
// 前向き検証台帳(prospective-ledger.ts)の3分析で同じ取引系列を共用する。
// scanExecutionEdges(open-close-edge.ts)は「重なりあり全始点」でエッジの有無を検定するが、
// こちらは実際に執行できる非重複の取引列(=資金が1単位しかない現実)を再現する点が違う。
//
// リターンは常に「ロング1倍」で保存し、方向(long/short)の適用は利用側で行う。
// 日付は手仕舞い日(その取引の損益が確定した日)。

import { PricePoint } from "./types";
import { runStrategyTrades, TradeSpec, Side } from "./weekday-trade";

export interface EdgeTrade {
  date: string; // 手仕舞い日 "YYYY-MM-DD"
  ret: number; // ロング1倍の1取引リターン
}

export interface EdgeSeries {
  id: string;
  label: string;
  holdLabel: string; // 保有区間の説明(表示用)
  trades: EdgeTrade[]; // 時系列順・非重複
  tradesPerYear: number; // 実測の年間取引回数
}

const DOW_LABEL = ["日", "月", "火", "水", "木", "金", "土"];

function toDateStr(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function yearsSpan(prices: PricePoint[]): number {
  if (prices.length < 2) return 0;
  const t0 = new Date(prices[0].time).getTime();
  const t1 = new Date(prices[prices.length - 1].time).getTime();
  return Math.max((t1 - t0) / (365.25 * 24 * 3600 * 1000), 1e-6);
}

function fromSpec(prices: PricePoint[], spec: Omit<TradeSpec, "side">): EdgeTrade[] {
  const trades = runStrategyTrades(prices, { ...spec, side: "long" as Side });
  return trades.map((t) => ({ date: toDateStr(t.exitT), ret: t.ret }));
}

// 毎営業日成立する2型は直接ループ(runStrategyTradesは曜日指定が必須のため)。
function intradayTrades(prices: PricePoint[]): EdgeTrade[] {
  const out: EdgeTrade[] = [];
  for (const p of prices) {
    if (p.open > 0 && p.close > 0) out.push({ date: p.time.slice(0, 10), ret: p.close / p.open - 1 });
  }
  return out;
}

function overnightTrades(prices: PricePoint[]): EdgeTrade[] {
  const out: EdgeTrade[] = [];
  for (let i = 1; i < prices.length; i++) {
    const c = prices[i - 1].close;
    const o = prices[i].open;
    if (c > 0 && o > 0) out.push({ date: prices[i].time.slice(0, 10), ret: o / c - 1 });
  }
  return out;
}

// 正準エッジ一覧を構築する。約定は寄り/引けオークションのみを仮定。
export function buildEdgeCatalog(prices: PricePoint[]): EdgeSeries[] {
  const yrs = yearsSpan(prices);
  const make = (id: string, label: string, holdLabel: string, trades: EdgeTrade[]): EdgeSeries => ({
    id,
    label,
    holdLabel,
    trades,
    tradesPerYear: yrs > 0 ? trades.length / yrs : 0,
  });

  const list: EdgeSeries[] = [
    make("intraday", "日中（寄→引・毎日）", "日中約5時間", intradayTrades(prices)),
    make("overnight", "夜間（引→翌寄・毎日）", "夜間持ち越し", overnightTrades(prices)),
  ];

  for (let dow = 1; dow <= 5; dow++) {
    list.push(
      make(
        `dow${dow}-oc`,
        `${DOW_LABEL[dow]}曜の日中（寄→引）`,
        "日中約5時間",
        fromSpec(prices, { entryDow: dow, entryTiming: "open", exitDow: dow, exitTiming: "close" }),
      ),
    );
  }

  list.push(
    make(
      "w-mon-fri",
      "週内保有（月寄→金引）",
      "約5営業日",
      fromSpec(prices, { entryDow: 1, entryTiming: "open", exitDow: 5, exitTiming: "close" }),
    ),
    make(
      "weekend",
      "週末ギャップ（金引→月寄）",
      "週末2日",
      fromSpec(prices, { entryDow: 5, entryTiming: "close", exitDow: 1, exitTiming: "open" }),
    ),
  );

  return list.filter((e) => e.trades.length >= 30);
}

// 方向を適用した取引リターン列。direction="short" なら符号反転。
export function directedReturns(edge: EdgeSeries, direction: Side): number[] {
  const sign = direction === "short" ? -1 : 1;
  return edge.trades.map((t) => sign * t.ret);
}
