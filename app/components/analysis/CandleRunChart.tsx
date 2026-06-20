"use client";

import { PricePoint } from "../../lib/types";
import { CANDLE_RUN_AXES } from "../../lib/conditional-forward-returns";
import ConditionalForwardChart from "./ConditionalForwardChart";

interface Props {
  prices: PricePoint[];
}

// 1.4 連続ローソクの幾何パターン。陽線/陰線の連続（陽連・陰連）の長さを状態とし、
// その後N日のリターンを集計して「勢いの継続 vs 反転」を定量化する。
export default function CandleRunChart({ prices }: Props) {
  return (
    <ConditionalForwardChart
      prices={prices}
      axes={CANDLE_RUN_AXES}
      defaultAxis="candleRun"
      title="連続ローソク（陽連/陰連）の先行きリターン"
    />
  );
}
