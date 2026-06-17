"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode } from "../../lib/series-mode";
import { computeWaveletCoherence } from "../../lib/wavelet-coherence";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode; // 受け取るが本図は「リターン×出来高変化」固定
}

// コヒーレンス 0..1 の色 (青=低 → 赤=高)
function cohColor(v: number): string {
  const t = Math.max(0, Math.min(1, v));
  if (t < 0.25) {
    const s = t / 0.25;
    return `rgb(${Math.round(20 + s * 0)}, ${Math.round(30 + s * 90)}, ${Math.round(120 + s * 80)})`;
  } else if (t < 0.5) {
    const s = (t - 0.25) / 0.25;
    return `rgb(0, ${Math.round(120 + s * 90)}, ${Math.round(200 - s * 80)})`;
  } else if (t < 0.75) {
    const s = (t - 0.5) / 0.25;
    return `rgb(${Math.round(s * 230)}, ${Math.round(210 + s * 30)}, ${Math.round(120 - s * 120)})`;
  } else {
    const s = (t - 0.75) / 0.25;
    return `rgb(${Math.round(230 + s * 25)}, ${Math.round(240 - s * 180)}, 0)`;
  }
}

export default function WaveletCoherenceChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 価格対数リターン × 出来高対数変化 (同一の time 軸に整列)
  const { x, y, times } = useMemo(() => {
    const closes = prices.map((p) => p.close);
    const vols = prices.map((p) => p.volume);
    const t = prices.map((p) => p.time);
    const xr: number[] = [];
    const yr: number[] = [];
    const tt: string[] = [];
    for (let i = 1; i < closes.length; i++) {
      const lr = closes[i] > 0 && closes[i - 1] > 0 ? Math.log(closes[i] / closes[i - 1]) : 0;
      const dv =
        vols[i] > 0 && vols[i - 1] > 0 ? Math.log(vols[i] / vols[i - 1]) : 0;
      xr.push(lr);
      yr.push(dv);
      tt.push(t[i]);
    }
    return { x: xr, y: yr, times: tt };
  }, [prices]);

  const result = useMemo(
    () => computeWaveletCoherence(x, y, times, 32),
    [x, y, times]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || result.coherence.length === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 280;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const numScales = result.coherence.length;
    const numTimes = result.coherence[0]?.length ?? 0;
    const cellW = width / numTimes;
    const cellH = height / numScales;

    // コヒーレンスのヒートマップ (上が短周期=高周波になるよう scale 昇順を上から)
    for (let si = 0; si < numScales; si++) {
      for (let ti = 0; ti < numTimes; ti++) {
        ctx.fillStyle = cohColor(result.coherence[si][ti]);
        ctx.fillRect(
          Math.floor(ti * cellW),
          Math.floor((numScales - 1 - si) * cellH),
          Math.ceil(cellW) + 1,
          Math.ceil(cellH) + 1
        );
      }
    }

    // 位相差の矢印 (コヒーレンスが高い領域のみ。間引いて描画)
    const stepT = Math.max(1, Math.floor(numTimes / 40));
    const stepS = Math.max(1, Math.floor(numScales / 12));
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 1;
    const arrowLen = Math.min(cellW * stepT, cellH * stepS) * 0.45;
    for (let si = 0; si < numScales; si += stepS) {
      for (let ti = 0; ti < numTimes; ti += stepT) {
        if (result.coherence[si][ti] < 0.5) continue;
        const cx = ti * cellW + (cellW * stepT) / 2;
        const cy = (numScales - 1 - si) * cellH + cellH / 2;
        // 位相 φ: 右向き(0)=同位相, 上向き(π/2)=x が y を先導
        const ang = -result.phase[si][ti]; // canvas は y 下向きなので符号反転
        const dx = Math.cos(ang) * arrowLen;
        const dy = Math.sin(ang) * arrowLen;
        ctx.beginPath();
        ctx.moveTo(cx - dx / 2, cy - dy / 2);
        ctx.lineTo(cx + dx / 2, cy + dy / 2);
        ctx.stroke();
        // 矢じり
        const head = arrowLen * 0.3;
        ctx.beginPath();
        ctx.moveTo(cx + dx / 2, cy + dy / 2);
        ctx.lineTo(
          cx + dx / 2 - head * Math.cos(ang - 0.5),
          cy + dy / 2 - head * Math.sin(ang - 0.5)
        );
        ctx.moveTo(cx + dx / 2, cy + dy / 2);
        ctx.lineTo(
          cx + dx / 2 - head * Math.cos(ang + 0.5),
          cy + dy / 2 - head * Math.sin(ang + 0.5)
        );
        ctx.stroke();
      }
    }

    // Y軸ラベル (周期)
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(0, 0, 44, height);
    ctx.fillStyle = "#333";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    const labelIdx = [0, Math.floor(numScales / 4), Math.floor(numScales / 2), Math.floor((numScales * 3) / 4), numScales - 1];
    for (const si of labelIdx) {
      const yy = (numScales - 1 - si) * cellH + cellH / 2;
      ctx.fillText(`${result.scales[si].toFixed(0)}d`, 4, yy + 3);
    }

    // X軸ラベル
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(0, height - 16, width, 16);
    ctx.fillStyle = "#666";
    const numLabels = Math.min(6, numTimes);
    for (let i = 0; i < numLabels; i++) {
      const ti = Math.floor((i / (numLabels - 1)) * (numTimes - 1));
      ctx.fillText(result.times[ti]?.slice(2) || "", ti * cellW, height - 4);
    }
  }, [result]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">
        ウェーブレットコヒーレンス (価格リターン × 出来高変化)
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        縦軸: 周期(日) / 横軸: 時間 / 色: コヒーレンス(青=無関係 → 赤=強い連動) / 矢印: 位相差
      </p>
      <div className="w-full rounded border border-gray-100 overflow-hidden">
        <canvas ref={canvasRef} />
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs text-gray-500 flex-wrap">
        <span>低 (0)</span>
        <div className="flex h-3 rounded overflow-hidden" style={{ width: 120 }}>
          {[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => (
            <div key={t} className="flex-1" style={{ backgroundColor: cohColor(t) }} />
          ))}
        </div>
        <span>高 (1)</span>
        <span className="ml-3">矢印 →: 同位相 / ↑: 価格が先行 / ↓: 出来高が先行 / ←: 逆位相</span>
      </div>

      <AnalysisGuide title="ウェーブレットコヒーレンスの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          スカログラム(単一系列のCWT)が「いつ・どの周期で変動が強かったか」を示すのに対し、ウェーブレットコヒーレンス(WTC)は<span className="font-medium">2つの系列が「いつ・どの周期で連動していたか」</span>を示します。ここでは同一銘柄の<span className="font-medium">価格リターン</span>と<span className="font-medium">出来高変化</span>のペアに適用し、価格と出来高の関係が時間スケールごとにどう変わるかを可視化します。相関係数が全期間・全周期で1つの値しか出さないのに対し、WTCは時間×周期の各点で局所相関を出します。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          各系列の連続ウェーブレット変換を Wₓ(s,t), Wᵧ(s,t) とする(s=スケール≈周期, t=時刻)。クロスウェーブレットスペクトルは
        </p>
        <p>{"Wₓᵧ(s,t) = Wₓ(s,t) · conj(Wᵧ(s,t))"}</p>
        <p>平滑化作用素 S(時間方向ガウス窓 + スケール方向平均)を用いて、コヒーレンスは</p>
        <p>{"R²(s,t) = |S(s⁻¹ Wₓᵧ)|² / [ S(s⁻¹|Wₓ|²) · S(s⁻¹|Wᵧ|²) ]"}</p>
        <p>
          0 ≤ R² ≤ 1。平滑化しないと R² は恒等的に1になるため、平滑化が本質です(局所的な「相関係数」を作る操作に相当)。位相差は
        </p>
        <p>{"φ(s,t) = arg( S(s⁻¹ Wₓᵧ) )"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">コヒーレンス:</span> 周波数領域版の相関係数。その周期・時点で2系列がどれだけ連動しているか(0=無関係, 1=完全連動)。</li>
          <li><span className="font-medium">位相差:</span> 2つの波のずれ。同じ周期の波がどちらが先に動くか(リード・ラグ)を角度で表す。</li>
          <li><span className="font-medium">スケール(周期):</span> Morletウェーブレットの幅。短いほど高周波(日々の細かい変動)、長いほど低周波(数ヶ月の大きな波)。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          2人のダンサーを想像してください。コヒーレンスは「2人がどれだけ息を合わせて踊っているか」(高い=ぴったり)、位相差は「どちらが半拍先に動くか」です。価格と出来高が「高コヒーレンス＆出来高先行」なら、出来高の急増が価格変動を先導している局面を意味します。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">赤い領域:</span> その周期・時点で価格と出来高が強く連動。</li>
          <li><span className="font-medium">矢印 → (右):</span> 同位相(価格上昇と出来高増加が同時)。</li>
          <li><span className="font-medium">矢印 ← (左):</span> 逆位相(価格上昇時に出来高減少など)。</li>
          <li><span className="font-medium">矢印 ↑:</span> 価格が出来高に先行 / <span className="font-medium">↓:</span> 出来高が価格に先行。</li>
          <li>矢印はコヒーレンス0.5以上の領域のみ描画(連動が弱い所の位相は意味を持たないため)。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">出来高先行(↓)＆高コヒーレンス:</span> 出来高急増が価格変動の先行指標として機能している局面。出来高ブレイクアウト戦略が有効。</li>
          <li><span className="font-medium">短周期帯の連動消失:</span> 価格と出来高の関係が崩れた = 需給バランスの変化。トレンド転換の前兆になりうる。</li>
          <li><span className="font-medium">長周期帯の持続的連動:</span> 構造的な需給トレンド(機関投資家の継続的な売買)を示唆。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">縁辺効果(COI):</span> 図の左右端では窓がデータをはみ出すため信頼性が低い。端の解釈は避ける。</li>
          <li><span className="font-medium">有意性は未検定:</span> 高コヒーレンスでも偶然の可能性がある。厳密にはサロゲート(モンテカルロ)検定が必要(本図では未実装)。</li>
          <li><span className="font-medium">出来高データの質:</span> 出来高の欠損・分割調整の影響を受ける。0出来高日はリターン0として扱われる。</li>
          <li>平滑化窓の選び方で見た目が変わる。本実装は時間方向ガウス(σ≈スケール)+スケール方向3点平均の標準的設定。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
