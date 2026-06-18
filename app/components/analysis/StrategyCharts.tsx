"use client";

import { useEffect, useRef } from "react";
import { FeaturePoint } from "../../lib/feature-series";
import { SimResult, StrategyMode, ExitRule } from "../../lib/strategy-sim";

interface Props {
  features: FeaturePoint[];
  sim: SimResult;
  mode: StrategyMode;
}

const RULE_COLOR: Record<ExitRule, string> = {
  model: "#2563eb",
  fixed: "#f59e0b",
  atr: "#7c3aed",
};

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

export default function StrategyCharts({ features, sim, mode }: Props) {
  const priceRef = useRef<HTMLCanvasElement>(null);
  const equityRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const n = features.length;
    if (n < 2) return;
    const closes = features.map((f) => f.close);
    const PAD = 36;

    // ---- 価格パネル ----
    const pc = priceRef.current;
    if (pc) {
      const init = initCanvas(pc, 280);
      if (init) {
        const { ctx, width, height } = init;
        const min = Math.min(...closes);
        const max = Math.max(...closes);
        const range = max - min || 1;
        const x = (i: number) => PAD + (i / (n - 1)) * (width - PAD - 8);
        const y = (v: number) => height - 22 - ((v - min) / range) * (height - 22 - 8);

        // 悪化シグナルの帯(下部)
        for (let i = 0; i < n; i++) {
          if (sim.flags[i]?.deterioration) {
            ctx.fillStyle = "rgba(220,38,38,0.10)";
            ctx.fillRect(x(i) - 1, 8, 2, height - 30);
          }
        }
        // 終値ライン
        ctx.beginPath();
        ctx.strokeStyle = "#334155";
        ctx.lineWidth = 1.3;
        for (let i = 0; i < n; i++) {
          const px = x(i);
          const py = y(closes[i]);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();

        // マーカー
        const triangle = (px: number, py: number, up: boolean, color: string) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          if (up) {
            ctx.moveTo(px, py - 7);
            ctx.lineTo(px - 5, py + 2);
            ctx.lineTo(px + 5, py + 2);
          } else {
            ctx.moveTo(px, py + 7);
            ctx.lineTo(px - 5, py - 2);
            ctx.lineTo(px + 5, py - 2);
          }
          ctx.closePath();
          ctx.fill();
        };

        if (mode === "single" && sim.single) {
          const e = sim.single.entryIndex;
          triangle(x(e), y(closes[e]) + 12, true, "#2563eb");
          for (const r of sim.single.results) {
            triangle(x(r.exitIndex), y(closes[r.exitIndex]) - 12, false, RULE_COLOR[r.rule]);
          }
        } else {
          for (const m of sim.byRule.model.markers) {
            if (m.kind === "entry") triangle(x(m.index), y(m.price) + 12, true, "#16a34a");
            else triangle(x(m.index), y(m.price) - 12, false, "#dc2626");
          }
        }

        // 軸ラベル(日付3点・価格2点)
        ctx.fillStyle = "#9ca3af";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(features[0].time, PAD, height - 6);
        ctx.textAlign = "center";
        ctx.fillText(features[Math.floor(n / 2)].time, x(Math.floor(n / 2)), height - 6);
        ctx.textAlign = "right";
        ctx.fillText(features[n - 1].time, width - 8, height - 6);
        ctx.textAlign = "left";
        ctx.fillText(max.toFixed(0), 2, 14);
        ctx.fillText(min.toFixed(0), 2, height - 26);
      }
    }

    // ---- 損益曲線パネル(モードA/B) ----
    const ec = equityRef.current;
    if (ec && mode !== "single") {
      const init = initCanvas(ec, 200);
      if (init) {
        const { ctx, width, height } = init;
        const series: { key: string; data: number[]; color: string }[] = [
          { key: "Buy&Hold", data: sim.hold, color: "#9ca3af" },
          { key: "悪化シグナル", data: sim.byRule.model.equity, color: RULE_COLOR.model },
          { key: "固定−X%", data: sim.byRule.fixed.equity, color: RULE_COLOR.fixed },
          { key: "ATR", data: sim.byRule.atr.equity, color: RULE_COLOR.atr },
        ];
        let lo = Infinity;
        let hi = -Infinity;
        for (const s of series)
          for (const v of s.data) {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        const range = hi - lo || 1;
        const x = (i: number) => PAD + (i / (n - 1)) * (width - PAD - 8);
        const y = (v: number) => height - 22 - ((v - lo) / range) * (height - 22 - 18);

        // 1.0 基準線
        ctx.strokeStyle = "#e5e7eb";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD, y(1));
        ctx.lineTo(width - 8, y(1));
        ctx.stroke();

        for (const s of series) {
          ctx.beginPath();
          ctx.strokeStyle = s.color;
          ctx.lineWidth = s.key === "Buy&Hold" ? 1.5 : 1.5;
          if (s.key === "Buy&Hold") ctx.setLineDash([4, 3]);
          for (let i = 0; i < n; i++) {
            const px = x(i);
            const py = y(s.data[i]);
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
          }
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // 凡例
        ctx.font = "10px sans-serif";
        ctx.textAlign = "left";
        let lx = PAD;
        for (const s of series) {
          const last = s.data[n - 1];
          const label = `${s.key} ${((last - 1) * 100).toFixed(1)}%`;
          ctx.fillStyle = s.color;
          ctx.fillRect(lx, 6, 8, 8);
          ctx.fillStyle = "#374151";
          ctx.fillText(label, lx + 11, 14);
          lx += ctx.measureText(label).width + 28;
        }
      }
    }
  }, [features, sim, mode]);

  if (features.length < 2) {
    return <div className="text-sm text-gray-400 py-8 text-center">特徴量を計算中、またはデータ不足です。</div>;
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs text-gray-500 mb-1">
          価格と判断(▲エントリー / ▼出口、赤帯=悪化シグナル点灯日)
        </div>
        <canvas ref={priceRef} />
      </div>
      {mode !== "single" && (
        <div>
          <div className="text-xs text-gray-500 mb-1">損益曲線(正規化 1.0 = 開始時)</div>
          <canvas ref={equityRef} />
        </div>
      )}
    </div>
  );
}
