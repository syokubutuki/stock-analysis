"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { logReturns } from "../../lib/transforms";
import { computeCWT } from "../../lib/wavelet";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

function heatColor(value: number, max: number): string {
  const t = Math.min(1, Math.sqrt(value / (max + 1e-20)));
  // 黒→青→緑→黄→赤
  if (t < 0.25) {
    const s = t / 0.25;
    return `rgb(0, 0, ${Math.round(s * 200)})`;
  } else if (t < 0.5) {
    const s = (t - 0.25) / 0.25;
    return `rgb(0, ${Math.round(s * 200)}, ${Math.round(200 - s * 100)})`;
  } else if (t < 0.75) {
    const s = (t - 0.5) / 0.25;
    return `rgb(${Math.round(s * 255)}, ${Math.round(200 + s * 55)}, 0)`;
  } else {
    const s = (t - 0.75) / 0.25;
    return `rgb(255, ${Math.round(255 - s * 200)}, 0)`;
  }
}

export default function WaveletChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const closes = prices.map((p) => p.close);
  const times = prices.map((p) => p.time);
  const lr = logReturns(closes);
  const lrTimes = times.slice(1);

  const scalogram = useMemo(
    () => computeCWT(lr, lrTimes, 30),
    [prices]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || scalogram.matrix.length === 0) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 250;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const numScales = scalogram.matrix.length;
    const numTimes = scalogram.matrix[0]?.length || 0;

    const cellW = width / numTimes;
    const cellH = height / numScales;

    for (let si = 0; si < numScales; si++) {
      for (let ti = 0; ti < numTimes; ti++) {
        ctx.fillStyle = heatColor(scalogram.matrix[si][ti], scalogram.maxPower);
        ctx.fillRect(
          Math.floor(ti * cellW),
          Math.floor((numScales - 1 - si) * cellH),
          Math.ceil(cellW) + 1,
          Math.ceil(cellH) + 1
        );
      }
    }

    // Y軸ラベル (周期)
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(0, 0, 50, height);
    ctx.fillStyle = "#333";
    ctx.font = "10px sans-serif";
    const labelIndices = [0, Math.floor(numScales / 4), Math.floor(numScales / 2), Math.floor(numScales * 3 / 4), numScales - 1];
    for (const si of labelIndices) {
      const y = (numScales - 1 - si) * cellH + cellH / 2;
      ctx.fillText(`${scalogram.scales[si].toFixed(0)}d`, 4, y + 3);
    }

    // X軸ラベル (時刻)
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(0, height - 16, width, 16);
    ctx.fillStyle = "#666";
    const numLabels = Math.min(6, numTimes);
    for (let i = 0; i < numLabels; i++) {
      const ti = Math.floor((i / (numLabels - 1)) * (numTimes - 1));
      const x = ti * cellW;
      ctx.fillText(lrTimes[ti]?.slice(5) || "", x, height - 4);
    }
  }, [scalogram]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">ウェーブレットスカログラム (Morlet CWT)</h3>
      <p className="text-xs text-gray-500 mb-3">
        縦軸: 周期(日) / 横軸: 時間 / 色: パワー (暗→明 = 低→高)
      </p>
      <div className="w-full rounded border border-gray-100 overflow-hidden">
        <canvas ref={canvasRef} />
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
        <span>低パワー</span>
        <div className="flex h-3 rounded overflow-hidden" style={{ width: 120 }}>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <div
              key={t}
              className="flex-1"
              style={{ backgroundColor: heatColor(t * 100, 100) }}
            />
          ))}
        </div>
        <span>高パワー</span>
      </div>

      <AnalysisGuide title="ウェーブレットスカログラムの読み方">
        <p><span className="font-medium">ウェーブレット変換とは:</span> FFTが「全期間での周波数成分」を見るのに対し、ウェーブレットは「いつ、どの周期の成分が強かったか」を同時に把握できます。ここではMorletウェーブレット(ω₀=6)を使用した連続ウェーブレット変換(CWT)を行っています。</p>
        <p><span className="font-medium">スカログラムの読み方:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">横軸:</span> 時間(左が過去、右が現在)</li>
          <li><span className="font-medium">縦軸:</span> 周期(下が短周期=高周波、上が長周期=低周波)</li>
          <li><span className="font-medium">色:</span> 暗い(黒〜青)= パワーが低い(その時点・周期での変動が小さい)。明るい(黄〜赤)= パワーが高い(強い変動)。</li>
        </ul>
        <p><span className="font-medium">パターンの解釈:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">特定の周期帯に横に伸びる明るい領域:</span> その周期の変動が持続的に強い = 安定した周期性が存在。</li>
          <li><span className="font-medium">縦に伸びる明るい領域:</span> ある時点で全周期帯にわたって変動が増大 = ショックやレジーム変化が発生。</li>
          <li><span className="font-medium">島状の明るいスポット:</span> 一時的に特定の周期が卓越した = その期間にのみ有効だったサイクル。</li>
        </ul>
        <p><span className="font-medium">トレードへの活用:</span> 現在時点(右端)で特定の周期帯にパワーが集中していれば、その周期に合わせた売買サイクルが有効な可能性があります。逆にパワーが全体的に低ければ、明確なサイクルが存在しない(ランダム)ことを示唆します。FFTと異なり、周期性の「出現と消失」のタイミングが分かるのがウェーブレットの最大の利点です。</p>
      </AnalysisGuide>
    </div>
  );
}
