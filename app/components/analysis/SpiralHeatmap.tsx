"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

interface DayData {
  date: string;
  dayOfWeek: number; // 0=Sun, 1=Mon, ..., 6=Sat
  month: number;
  returnVal: number;
}

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const MONTH_LABELS = ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];

function returnColor(val: number, maxAbs: number): string {
  const t = Math.min(1, Math.abs(val) / (maxAbs || 1));
  const intensity = Math.round(50 + 205 * t);
  if (val > 0) return `rgb(0, ${intensity}, ${Math.round(intensity * 0.6)})`;
  if (val < 0) return `rgb(${intensity}, ${Math.round(intensity * 0.3)}, ${Math.round(intensity * 0.3)})`;
  return "#e5e7eb";
}

export default function SpiralHeatmap({ prices, seriesMode }: Props) {
  const calendarRef = useRef<HTMLCanvasElement>(null);
  const polarRef = useRef<HTMLCanvasElement>(null);

  const { values, times } = extractSeries(prices, seriesMode);
  const dayData: DayData[] = useMemo(() => {
    // "close" モードでは生の終値が返るため、リターンを自前で計算する
    if (seriesMode === "close") {
      return values.slice(1).map((v, i) => {
        const dateStr = times[i + 1];
        const d = new Date(dateStr);
        return {
          date: dateStr,
          dayOfWeek: d.getDay(),
          month: d.getMonth(),
          returnVal: values[i] !== 0 ? (v - values[i]) / values[i] : 0,
        };
      });
    }
    // diff / logReturn モードでは既にリターン系列
    return values.map((r, i) => {
      const dateStr = times[i];
      const d = new Date(dateStr);
      return {
        date: dateStr,
        dayOfWeek: d.getDay(),
        month: d.getMonth(),
        returnVal: r,
      };
    });
  }, [values, times, seriesMode]);

  const maxAbs = useMemo(
    () => Math.max(...dayData.map((d) => Math.abs(d.returnVal)), 0.001),
    [dayData]
  );

  // 曜日別・月別集計
  const dowStats = useMemo(() => {
    const stats = Array.from({ length: 7 }, () => ({ sum: 0, count: 0, posCount: 0 }));
    for (const d of dayData) {
      stats[d.dayOfWeek].sum += d.returnVal;
      stats[d.dayOfWeek].count++;
      if (d.returnVal > 0) stats[d.dayOfWeek].posCount++;
    }
    return stats.map((s) => ({
      mean: s.count > 0 ? s.sum / s.count : 0,
      count: s.count,
      winRate: s.count > 0 ? s.posCount / s.count : 0,
    }));
  }, [dayData]);

  const monthStats = useMemo(() => {
    const stats = Array.from({ length: 12 }, () => ({ sum: 0, count: 0, posCount: 0 }));
    for (const d of dayData) {
      stats[d.month].sum += d.returnVal;
      stats[d.month].count++;
      if (d.returnVal > 0) stats[d.month].posCount++;
    }
    return stats.map((s) => ({
      mean: s.count > 0 ? s.sum / s.count : 0,
      count: s.count,
      winRate: s.count > 0 ? s.posCount / s.count : 0,
    }));
  }, [dayData]);

  // カレンダーヒートマップ
  useEffect(() => {
    const canvas = calendarRef.current;
    if (!canvas || dayData.length === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const weeks = Math.ceil(dayData.length / 5) + 1;
    const cellSize = Math.min(Math.floor((width - 40) / weeks), 12);
    const height = cellSize * 7 + 50;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, width, height);

    const offsetX = 30;
    const offsetY = 15;

    // 曜日ラベル
    ctx.fillStyle = "#999";
    ctx.font = "9px sans-serif";
    for (let dow = 0; dow < 7; dow++) {
      ctx.fillText(DOW_LABELS[dow], 2, offsetY + dow * cellSize + cellSize - 2);
    }

    // 日次セルを描画
    let weekCol = 0;
    let prevMonth = -1;
    for (const d of dayData) {
      const date = new Date(d.date);
      const dow = date.getDay();
      const month = date.getMonth();

      if (month !== prevMonth && prevMonth !== -1 && dow <= 1) {
        weekCol++;
      }
      prevMonth = month;

      const x = offsetX + weekCol * cellSize;
      const y = offsetY + dow * cellSize;

      ctx.fillStyle = returnColor(d.returnVal, maxAbs);
      ctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);

      if (dow === 6) weekCol++;
    }
  }, [dayData, maxAbs]);

  // 極座標リターンマップ (曜日)
  useEffect(() => {
    const canvas = polarRef.current;
    if (!canvas || dayData.length === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const size = Math.min(parent.clientWidth, 300);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const maxR = size / 2 - 30;

    // 同心円グリッド
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.5;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (maxR * i) / 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 曜日の放射線 (月〜金 = 5分割)
    const tradingDays = [1, 2, 3, 4, 5]; // Mon-Fri
    for (const dow of tradingDays) {
      const angle = ((dow - 1) / 5) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + maxR * Math.cos(angle), cy + maxR * Math.sin(angle));
      ctx.stroke();

      // ラベル
      ctx.fillStyle = "#666";
      ctx.font = "10px sans-serif";
      const lx = cx + (maxR + 15) * Math.cos(angle);
      const ly = cy + (maxR + 15) * Math.sin(angle);
      ctx.textAlign = "center";
      ctx.fillText(DOW_LABELS[dow], lx, ly + 3);
    }

    // データ点をプロット
    for (const d of dayData) {
      if (d.dayOfWeek === 0 || d.dayOfWeek === 6) continue; // 休日除外
      const angle = ((d.dayOfWeek - 1) / 5) * Math.PI * 2 - Math.PI / 2;
      const r = (Math.abs(d.returnVal) / maxAbs) * maxR;
      const jitter = (Math.random() - 0.5) * 0.15;
      const a = angle + jitter;

      const px = cx + r * Math.cos(a);
      const py = cy + r * Math.sin(a);

      ctx.fillStyle = d.returnVal > 0
        ? "rgba(38, 166, 154, 0.4)"
        : "rgba(239, 83, 80, 0.4)";
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.textAlign = "start";
  }, [dayData, maxAbs]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">カレンダー分析</h3>

      <div className="text-xs text-gray-500 mb-1">リターンヒートマップ (緑=上昇 / 赤=下落 / 濃さ=変動幅)</div>
      <div className="w-full rounded border border-gray-100 overflow-x-auto overflow-hidden">
        <canvas ref={calendarRef} />
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 極座標 */}
        <div>
          <div className="text-xs text-gray-500 mb-1">極座標リターンマップ (曜日別)</div>
          <div className="flex justify-center rounded border border-gray-100 overflow-hidden">
            <canvas ref={polarRef} />
          </div>
        </div>

        {/* 曜日・月別統計 */}
        <div className="space-y-3">
          <div>
            <div className="text-xs text-gray-500 mb-1">曜日別平均リターン</div>
            <div className="grid grid-cols-5 gap-1 text-xs">
              {[1, 2, 3, 4, 5].map((dow) => (
                <div key={dow} className="p-1.5 bg-gray-50 rounded text-center">
                  <div className="font-medium">{DOW_LABELS[dow]}</div>
                  <div className={`font-mono ${dowStats[dow].mean > 0 ? "text-green-600" : "text-red-600"}`}>
                    {(dowStats[dow].mean * 100).toFixed(3)}%
                  </div>
                  <div className="text-gray-400">勝率{(dowStats[dow].winRate * 100).toFixed(0)}%</div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">月別平均リターン</div>
            <div className="grid grid-cols-6 gap-1 text-xs">
              {monthStats.map((s, m) => (
                s.count > 0 && (
                  <div key={m} className="p-1 bg-gray-50 rounded text-center">
                    <div className="font-medium text-gray-600">{MONTH_LABELS[m]}</div>
                    <div className={`font-mono ${s.mean > 0 ? "text-green-600" : "text-red-600"}`}>
                      {(s.mean * 100).toFixed(2)}%
                    </div>
                  </div>
                )
              ))}
            </div>
          </div>
        </div>
      </div>

      <AnalysisGuide title="カレンダー分析の読み方">
        <p><span className="font-medium">カレンダーヒートマップ:</span> 各営業日のリターンを色で表現しています。緑は上昇、赤は下落、色の濃さが変動の大きさを表します。連続した色のパターンからトレンドの持続期間やレジーム変化が視覚的に分かります。</p>
        <p><span className="font-medium">極座標リターンマップ:</span> 曜日を角度方向、リターンの大きさを半径方向に配置した散布図です。特定の曜日に点が偏っていればアノマリーの可能性があります。</p>
        <p><span className="font-medium">カレンダーアノマリー:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">曜日効果:</span> 特定の曜日に統計的に有意なリターン差がある現象。歴史的に月曜は下落傾向(ウィークエンド効果)、金曜は上昇傾向が報告されている。</li>
          <li><span className="font-medium">月次効果:</span> 特定の月にリターンが偏る現象。1月効果(January Effect)が有名。日本株では3月(年度末)や12月(税金対策売り)にパターンが出ることも。</li>
          <li><span className="font-medium">勝率:</span> 上昇日の割合。50%から大きく乖離している曜日・月は、バイアスが存在する可能性。</li>
        </ul>
        <p><span className="font-medium">注意:</span> カレンダーアノマリーはサンプル期間に強く依存します。短期間のデータでは偶然の偏りに過ぎない可能性が高いため、長い期間(2年以上)で一貫したパターンが見られる場合にのみ信頼すべきです。</p>
      </AnalysisGuide>
    </div>
  );
}
