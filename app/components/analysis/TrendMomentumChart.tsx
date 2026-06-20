"use client";

import { PricePoint } from "../../lib/types";
import { TREND_AXES } from "../../lib/conditional-forward-returns";
import ConditionalForwardChart from "./ConditionalForwardChart";

interface Props {
  prices: PricePoint[];
}

// 4.1/4.2/4.4/4.5 トレンド・モメンタム。共通の「状態→先行きリターン」エンジンを
// 12-1ヶ月モメンタム・52週高値距離・移動平均配列・モメンタム×ボラ(過熱) の軸で再利用する。
export default function TrendMomentumChart({ prices }: Props) {
  return (
    <ConditionalForwardChart
      prices={prices}
      axes={TREND_AXES}
      defaultAxis="tsMom"
      title="トレンド・モメンタムの先行きリターン（順張りアノマリー検証）"
    />
  );
}
