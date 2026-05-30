"use client";

import { useEffect, useRef, memo } from "react";

interface Props {
  ticker: string;
}

function toTradingViewSymbol(ticker: string): string {
  // 4桁数字 (.T suffix from Yahoo) → TSE:XXXX
  const m = ticker.match(/^(\d{4})\.T$/i);
  if (m) return `TSE:${m[1]}`;
  // 4桁数字 (raw input) → TSE:XXXX
  if (/^\d{4}$/.test(ticker)) return `TSE:${ticker}`;
  return ticker;
}

function TradingViewWidget({ ticker }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Clear previous widget
    container.innerHTML = "";

    const symbol = toTradingViewSymbol(ticker);

    const script = document.createElement("script");
    script.src =
      "https://s.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol,
      interval: "D",
      timezone: "Asia/Tokyo",
      theme: "light",
      style: "1",
      locale: "ja",
      allow_symbol_change: false,
      hide_top_toolbar: false,
      hide_legend: false,
      save_image: false,
      calendar: false,
      support_host: "https://www.tradingview.com",
    });

    const wrapper = document.createElement("div");
    wrapper.className = "tradingview-widget-container__widget";
    wrapper.style.height = "100%";
    wrapper.style.width = "100%";
    container.appendChild(wrapper);
    container.appendChild(script);

    return () => {
      container.innerHTML = "";
    };
  }, [ticker]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">TradingView チャート</h3>
      <div
        ref={containerRef}
        className="tradingview-widget-container"
        style={{ height: 500, width: "100%" }}
      />
    </div>
  );
}

export default memo(TradingViewWidget);
