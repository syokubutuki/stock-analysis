"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { logReturns } from "../../lib/transforms";
import { buildOrdinalNetwork } from "../../lib/ordinal-network";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

// パターンの意味を日本語で
const PATTERN_LABELS: Record<string, string> = {
  "012": "連続上昇",
  "021": "上げて下げ(山)",
  "102": "下げて上げ(谷)",
  "120": "上→横→下",
  "201": "下→横→上",
  "210": "連続下降",
};

export default function OrdinalNetwork({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const closes = prices.map((p) => p.close);
  const lr = logReturns(closes);
  const network = useMemo(() => buildOrdinalNetwork(lr, 3, 1), [prices]);

  // ネットワーク描画
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || network.nodes.length === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 350;
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

    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(cx, cy) - 60;

    // ノード配置 (円形)
    const nodePositions = new Map<string, { x: number; y: number }>();
    const n = network.nodes.length;
    network.nodes.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      nodePositions.set(node.pattern, {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      });
    });

    // エッジ描画
    const maxEdgeWeight = Math.max(...network.edges.map((e) => e.weight));
    for (const edge of network.edges) {
      const from = nodePositions.get(edge.from);
      const to = nodePositions.get(edge.to);
      if (!from || !to) continue;

      const alpha = 0.1 + 0.6 * (edge.weight / maxEdgeWeight);
      const lineWidth = 0.5 + 3 * (edge.weight / maxEdgeWeight);

      if (edge.from === edge.to) {
        // 自己ループ
        ctx.strokeStyle = `rgba(239, 68, 68, ${alpha})`;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        const loopRadius = 20;
        ctx.arc(from.x, from.y - 25, loopRadius, 0.5, Math.PI * 2 - 0.5);
        ctx.stroke();
      } else {
        // 矢印付きエッジ
        ctx.strokeStyle = `rgba(59, 130, 246, ${alpha})`;
        ctx.lineWidth = lineWidth;

        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const nx = dx / dist;
        const ny = dy / dist;

        // ノード境界からオフセット
        const startX = from.x + nx * 22;
        const startY = from.y + ny * 22;
        const endX = to.x - nx * 22;
        const endY = to.y - ny * 22;

        // 曲線(双方向エッジの区別のため)
        const perpX = -ny * 15;
        const perpY = nx * 15;
        const midX = (startX + endX) / 2 + perpX;
        const midY = (startY + endY) / 2 + perpY;

        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.quadraticCurveTo(midX, midY, endX, endY);
        ctx.stroke();

        // 矢印
        const arrowSize = 6;
        const angle = Math.atan2(endY - midY, endX - midX);
        ctx.fillStyle = `rgba(59, 130, 246, ${alpha})`;
        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(
          endX - arrowSize * Math.cos(angle - 0.4),
          endY - arrowSize * Math.sin(angle - 0.4)
        );
        ctx.lineTo(
          endX - arrowSize * Math.cos(angle + 0.4),
          endY - arrowSize * Math.sin(angle + 0.4)
        );
        ctx.closePath();
        ctx.fill();
      }
    }

    // ノード描画
    const maxFreq = Math.max(...network.nodes.map((n) => n.frequency));
    for (const node of network.nodes) {
      const pos = nodePositions.get(node.pattern);
      if (!pos) continue;

      const nodeRadius = 12 + 10 * (node.frequency / maxFreq);

      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#333";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, nodeRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // パターン名
      ctx.fillStyle = "#333";
      ctx.font = "bold 10px monospace";
      ctx.textAlign = "center";
      ctx.fillText(node.pattern, pos.x, pos.y + 3);

      // 頻度ラベル
      ctx.font = "9px sans-serif";
      ctx.fillStyle = "#666";
      const label = PATTERN_LABELS[node.pattern] || "";
      ctx.fillText(label, pos.x, pos.y + nodeRadius + 12);
      ctx.fillText(`${(node.frequency * 100).toFixed(1)}%`, pos.x, pos.y + nodeRadius + 23);
    }

    ctx.textAlign = "start";
  }, [network]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">
        Ordinal Pattern Transition Network
      </h3>

      <div className="w-full rounded border border-gray-100 overflow-hidden">
        <canvas ref={canvasRef} />
      </div>

      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">遷移エントロピー</div>
          <div className="font-mono font-medium">{network.transitionEntropy.toFixed(3)}</div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">自己遷移率</div>
          <div className={`font-mono font-medium ${network.selfTransitionRate > 0.25 ? "text-orange-600" : ""}`}>
            {(network.selfTransitionRate * 100).toFixed(1)}%
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">禁止パターン数</div>
          <div className={`font-mono font-medium ${network.numForbiddenPatterns > 0 ? "text-red-600" : ""}`}>
            {network.numForbiddenPatterns} / {network.totalPatterns}
          </div>
        </div>
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-gray-500">出現パターン数</div>
          <div className="font-mono font-medium">{network.nodes.length}</div>
        </div>
      </div>

      <AnalysisGuide title="Ordinal Pattern Transition Networkの読み方">
        <p><span className="font-medium">概要:</span> Permutation Entropyの発展版です。連続する3点の「順序パターン」(上昇・下降の並び)をノードとし、あるパターンから次のパターンへの遷移をエッジとした有向ネットワークを構築しています。</p>
        <p><span className="font-medium">6つのパターン (order=3):</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">012 (連続上昇):</span> 3日連続で株価が上がるパターン</li>
          <li><span className="font-medium">210 (連続下降):</span> 3日連続で株価が下がるパターン</li>
          <li><span className="font-medium">021 (山):</span> 上がってから下がる</li>
          <li><span className="font-medium">102 (谷):</span> 下がってから上がる</li>
        </ul>
        <p><span className="font-medium">エッジ(矢印)の太さ:</span> 遷移確率に比例。太い矢印ほど、そのパターンの後に次のパターンが来やすい。</p>
        <p><span className="font-medium">指標の解釈:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">遷移エントロピー:</span> 全遷移の不確実性。低い = 特定の遷移パターンが支配的 = 予測しやすい。</li>
          <li><span className="font-medium">自己遷移率:</span> 同じパターンが連続する割合。高い = トレンド持続(連続上昇→連続上昇)やレンジ(山→山)が多い。</li>
          <li><span className="font-medium">禁止パターン:</span> 一度も出現しないパターンの数。ランダム系列では禁止パターンは0。存在する場合は決定論的構造の証拠。</li>
        </ul>
        <p><span className="font-medium">トレードへの活用:</span> 「連続上昇(012)の後に連続上昇が来やすい」ならモメンタム効果の証拠。「連続上昇の後に山(021)が来やすい」ならリバーサルの可能性。この遷移確率を実際のエントリー・エグジットルールに組み込めます。</p>
      </AnalysisGuide>
    </div>
  );
}
