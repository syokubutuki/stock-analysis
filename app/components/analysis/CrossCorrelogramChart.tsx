"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { crossCorrelogram } from "../../lib/distribution-extended";
import { confidenceBound } from "../../lib/autocorrelation";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

export default function CrossCorrelogramChart({ prices }: Props) {
  const chartRef = useRef<HTMLCanvasElement>(null);

  // 夜間リターン vs 日中リターン
  const { overnight, intraday, n } = useMemo(() => {
    const ov: number[] = [], id: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      const prevClose = prices[i - 1].close;
      const open = prices[i].open;
      const close = prices[i].close;
      if (prevClose > 0 && open > 0 && close > 0) {
        ov.push(Math.log(open / prevClose));
        id.push(Math.log(close / open));
      }
    }
    return { overnight: ov, intraday: id, n: ov.length };
  }, [prices]);

  const ccf = useMemo(() => crossCorrelogram(overnight, intraday, 20), [overnight, intraday]);
  const bound = confidenceBound(n);

  useEffect(() => {
    if (!chartRef.current || ccf.length < 2) return;
    const r = initCanvas(chartRef.current, 220); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 25, bottom: 25, left: 50, right: 15 };
    const pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom;

    const maxLag = Math.max(...ccf.map(d => Math.abs(d.lag)));
    const maxVal = Math.max(1, ...ccf.map(d => Math.abs(d.value)));
    const barW = Math.max(2, pw / ccf.length - 2);

    const toX = (lag: number) => pad.left + ((lag + maxLag) / (2 * maxLag)) * pw;
    const toY = (v: number) => pad.top + ph / 2 - (v / maxVal) * (ph / 2);

    // 信頼区間
    ctx.fillStyle = "rgba(59, 130, 246, 0.1)";
    ctx.fillRect(pad.left, toY(bound), pw, toY(-bound) - toY(bound));
    ctx.strokeStyle = "rgba(59, 130, 246, 0.4)"; ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, toY(bound)); ctx.lineTo(width - pad.right, toY(bound));
    ctx.moveTo(pad.left, toY(-bound)); ctx.lineTo(width - pad.right, toY(-bound));
    ctx.stroke(); ctx.setLineDash([]);

    // ゼロ線
    ctx.strokeStyle = "#999"; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(pad.left, toY(0)); ctx.lineTo(width - pad.right, toY(0)); ctx.stroke();

    // ゼロラグの垂直線
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(toX(0), pad.top); ctx.lineTo(toX(0), pad.top + ph); ctx.stroke();
    ctx.setLineDash([]);

    // バー
    for (const d of ccf) {
      const x = toX(d.lag) - barW / 2;
      const y0 = toY(0), y1 = toY(d.value);
      const isNeg = d.lag < 0;
      ctx.fillStyle = Math.abs(d.value) > bound
        ? "#ef4444"
        : isNeg ? "#f59e0b" : "#3b82f6";
      ctx.fillRect(x, Math.min(y0, y1), barW, Math.abs(y1 - y0));
    }

    // ラベル
    ctx.fillStyle = "#333"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("クロスコレログラム: 夜間リターン ↔ 日中リターン", pad.left + 5, pad.top - 8);
    ctx.font = "9px sans-serif"; ctx.fillStyle = "#999"; ctx.textAlign = "center";
    ctx.fillText("← 日中が先行 | Lag | 夜間が先行 →", width / 2, height - 5);

    // Y軸
    ctx.fillStyle = "#999"; ctx.textAlign = "right";
    for (let i = -2; i <= 2; i++) {
      const v = (i / 2) * maxVal;
      if (Math.abs(v) > maxVal) continue;
      ctx.fillText(v.toFixed(2), pad.left - 5, toY(v) + 3);
    }
  }, [ccf, bound]);

  // 最も有意なラグ
  const significantLags = ccf.filter(d => Math.abs(d.value) > bound);
  const maxCCF = ccf.reduce((best, d) => Math.abs(d.value) > Math.abs(best.value) ? d : best, { lag: 0, value: 0 });

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">クロスコレログラム (夜間↔日中)</h3>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">最大相関ラグ</div>
          <div className="font-mono font-medium">
            Lag {maxCCF.lag} ({maxCCF.value.toFixed(4)})
          </div>
          <div className="text-gray-400">
            {maxCCF.lag < 0 ? "日中→夜間の影響" : maxCCF.lag > 0 ? "夜間→日中の影響" : "同時"}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">有意なラグ数</div>
          <div className={`font-mono font-medium ${significantLags.length > 3 ? "text-orange-600" : ""}`}>
            {significantLags.length}個
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">同時相関 CCF(0)</div>
          <div className={`font-mono font-medium ${Math.abs(ccf.find(d => d.lag === 0)?.value ?? 0) > bound ? "text-red-600" : ""}`}>
            {ccf.find(d => d.lag === 0)?.value.toFixed(4) ?? "-"}
          </div>
        </div>
      </div>

      <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={chartRef} /></div>

      <AnalysisGuide title="クロスコレログラムの詳細理論">
        <p className="font-medium text-gray-700">クロスコレログラム (CCF) の定義</p>
        <p>2つの時系列 X(t) と Y(t) に対して、クロスコレログラム(相互相関関数)は CCF(k) = Corr(Xₜ, Yₜ₊ₖ) で定義されます。ここでは X = 夜間リターン ln(Openₜ/Closeₜ₋₁)、Y = 日中リターン ln(Closeₜ/Openₜ) としています。</p>

        <p className="font-medium text-gray-700 mt-3">ラグの解釈</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>CCF(k &gt; 0): 今日の夜間リターンと k日後の日中リターンの相関。「夜間の情報が将来の日中に伝播する」</li>
          <li>CCF(k &lt; 0): 今日の日中リターンと |k|日前の夜間リターンの相関。「日中の情報が過去の夜間と関連する」= 日中リターンが先行指標</li>
          <li>CCF(0): 同じ日の夜間と日中の相関。負の値 → ギャップ反転効果（朝大きく上がったら日中は下がる）</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">ACFとの違い</p>
        <p>ACFは同一系列の自己相関を測定しますが、CCFは2つの異なる系列間のラグ相関を測定します。リターンを「夜間」と「日中」に分解することで、市場の情報伝播の方向性とタイミングを分析できます。</p>

        <p className="font-medium text-gray-700 mt-3">実務への示唆</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>CCF(0) &lt; 0 かつ有意 → 朝のギャップと日中の動きが逆。寄付きの過剰反応→日中に修正されるパターン。ギャップ反転戦略が有効</li>
          <li>CCF(1) &gt; 0 かつ有意 → 今日の夜間の動きが明日の日中に継続。オーバーナイト保有のモメンタム戦略を検討</li>
          <li>CCF(-1) が有意 → 昨日の日中の情報が今朝のギャップに反映。前日引けでのポジション調整が有効</li>
          <li>有意なラグなし → 夜間と日中は独立に動いている。分離した戦略で個別に最適化すべき</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
