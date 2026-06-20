"use client";

import { PricePoint } from "../../lib/types";
import { CALENDAR_AXES } from "../../lib/conditional-forward-returns";
import ConditionalForwardChart from "./ConditionalForwardChart";

interface Props {
  prices: PricePoint[];
}

// 10.1/10.2/10.3/10.4 カレンダー・イベント効果。共通の「状態→先行きリターン」エンジンを
// 月末/月初・SQ週・連休前後・季節(Sell in May) の軸で再利用する。
export default function CalendarEffectChart({ prices }: Props) {
  return (
    <ConditionalForwardChart
      prices={prices}
      axes={CALENDAR_AXES}
      defaultAxis="monthPhase"
      title="カレンダー・イベント効果（月末/SQ/連休/季節の先行きリターン）"
    />
  );
}
