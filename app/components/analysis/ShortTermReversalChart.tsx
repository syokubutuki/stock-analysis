"use client";

import { PricePoint } from "../../lib/types";
import { REVERSAL_AXES } from "../../lib/conditional-forward-returns";
import ConditionalForwardChart from "./ConditionalForwardChart";

interface Props {
  prices: PricePoint[];
}

// 5.1 短期リバーサル・エッジ。共通の「状態→先行きリターン」エンジンを
// RSI(2)・連続下落日数・直近高値からの下落 という逆張り向け状態軸で再利用する。
export default function ShortTermReversalChart({ prices }: Props) {
  return (
    <ConditionalForwardChart
      prices={prices}
      axes={REVERSAL_AXES}
      defaultAxis="rsi2"
      title="短期リバーサル・エッジ（押し目買い/戻り売りの定量化）"
    />
  );
}
