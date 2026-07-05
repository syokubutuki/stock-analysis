"use client";

// 前夜米国スピルオーバー分析7手法で共有するデータ配線とUI部品。
// 各コンポーネントは useAlignedDays で「JP日中足×前夜米国」の整合済みデータと時間格子を得る。

import { useMemo } from "react";
import { useIntraday } from "../../hooks/useIntraday";
import { useUsDaily, US_DRIVERS } from "../../hooks/useUsDaily";
import { groupByDay, buildBinGrid, BinGrid } from "../../lib/intraday-core";
import {
  computeUsReturns, alignJpUs, AlignedDay, UsReturn, BinScheme,
} from "../../lib/us-spillover-core";

export function intervalToMin(interval: string): number {
  const m = /^(\d+)m$/.exec(interval);
  return m ? Number(m[1]) : 15;
}

export interface AlignedData {
  aligned: AlignedDay[];
  us: UsReturn[]; // 前夜米国リターンの全系列(日付昇順)。未ペアの最新終値も含む(=寄り前の“ゆうべのNY”)
  grid: BinGrid | null;
  gmtoffset: number;
}

// JP日中足(ticker,interval) と 前夜米国(usTicker) を取得・整合して返す。
// useIntraday / useUsDaily がそれぞれモジュールキャッシュするため、複数コンポーネントで共有しても
// 実フェッチは1回で済む。
export function useAlignedDays(ticker: string, interval: string, usTicker: string) {
  const { resp, loading: il, error: ie } = useIntraday(ticker, interval);
  const { prices: usPrices, loading: ul, error: ue } = useUsDaily(usTicker);

  const data: AlignedData | null = useMemo(() => {
    if (!resp || resp.bars.length === 0 || !usPrices) return null;
    const days = groupByDay(resp.bars, resp.gmtoffset);
    const us = computeUsReturns(usPrices);
    const aligned = alignJpUs(days, us);
    const grid = buildBinGrid(resp.bars, resp.gmtoffset, intervalToMin(interval));
    return { aligned, us, grid, gmtoffset: resp.gmtoffset };
  }, [resp, usPrices, interval]);

  return { data, loading: il || ul, error: ie || ue };
}

// 米国ドライバ指数の選択ボタン。
export function UsDriverButtons({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1 flex-wrap text-xs">
      <span className="text-gray-500">前夜の米国:</span>
      {US_DRIVERS.map((d) => (
        <button
          key={d.ticker}
          onClick={() => onChange(d.ticker)}
          title={d.note}
          className={`px-2 py-0.5 rounded font-medium transition-colors ${
            value === d.ticker ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          {d.label}
        </button>
      ))}
    </div>
  );
}

const SCHEMES: { value: BinScheme; label: string }[] = [
  { value: "sign", label: "陰陽(2)" },
  { value: "tercile", label: "3分位" },
  { value: "quintile", label: "5分位" },
];

// 米国リターンのビン分割方式の選択ボタン。
export function BinSchemeButtons({ value, onChange }: { value: BinScheme; onChange: (v: BinScheme) => void }) {
  return (
    <div className="flex items-center gap-1 flex-wrap text-xs">
      <span className="text-gray-500">米国ビン:</span>
      {SCHEMES.map((s) => (
        <button
          key={s.value}
          onClick={() => onChange(s.value)}
          className={`px-2 py-0.5 rounded font-medium transition-colors ${
            value === s.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
