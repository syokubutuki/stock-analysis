"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { fullCCMAnalysis, type CCMPoint } from "../../lib/ccm";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: string;
}

export default function CCMChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const result = useMemo(() => fullCCMAnalysis(prices), [prices]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const allCurves: { pts: CCMPoint[]; color: string; label: string }[] = [
      { pts: result.returnToVol, color: "#2563eb", label: "Return→Vol" },
      { pts: result.volToReturn, color: "#dc2626", label: "Vol→Return" },
      { pts: result.returnToVolume, color: "#059669", label: "Return→Volume" },
      { pts: result.volumeToReturn, color: "#f59e0b", label: "Volume→Return" },
    ];

    const hasCurves = allCurves.some((c) => c.pts.length > 0);
    if (!hasCurves) return;

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
    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, width, height);

    const pad = { top: 25, right: 15, bottom: 35, left: 55 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    // Axes
    let maxL = 0, maxRho = 0, minRho = 0;
    for (const c of allCurves) {
      for (const p of c.pts) {
        if (p.librarySize > maxL) maxL = p.librarySize;
        if (p.rho > maxRho) maxRho = p.rho;
        if (p.rho < minRho) minRho = p.rho;
      }
    }
    maxRho = Math.max(maxRho, 0.5);
    minRho = Math.min(minRho, -0.1);

    const toX = (l: number) => pad.left + (l / maxL) * plotW;
    const toY = (r: number) => pad.top + (1 - (r - minRho) / (maxRho - minRho)) * plotH;

    // Grid
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.5;
    for (let r = Math.ceil(minRho * 5) / 5; r <= maxRho; r += 0.2) {
      ctx.beginPath();
      ctx.moveTo(pad.left, toY(r));
      ctx.lineTo(width - pad.right, toY(r));
      ctx.stroke();
    }

    // Zero line
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(pad.left, toY(0));
    ctx.lineTo(width - pad.right, toY(0));
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw curves
    for (const curve of allCurves) {
      if (curve.pts.length === 0) continue;

      ctx.strokeStyle = curve.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < curve.pts.length; i++) {
        const x = toX(curve.pts[i].librarySize);
        const y = toY(curve.pts[i].rho);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Points
      ctx.fillStyle = curve.color;
      for (const pt of curve.pts) {
        ctx.beginPath();
        ctx.arc(toX(pt.librarySize), toY(pt.rho), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Legend
    ctx.font = "10px sans-serif";
    let ly = pad.top + 5;
    for (const curve of allCurves) {
      if (curve.pts.length === 0) continue;
      ctx.fillStyle = curve.color;
      ctx.fillRect(width - pad.right - 120, ly - 4, 10, 3);
      ctx.fillStyle = "#374151";
      ctx.textAlign = "left";
      ctx.fillText(curve.label, width - pad.right - 106, ly);
      ly += 14;
    }

    // Axis labels
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("ライブラリサイズ L", width / 2, height - 5);
    ctx.textAlign = "right";
    for (let r = Math.ceil(minRho * 5) / 5; r <= maxRho; r += 0.2) {
      ctx.fillText(r.toFixed(1), pad.left - 5, toY(r) + 3);
    }
    ctx.save();
    ctx.translate(12, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("Cross-map rho", 0, 0);
    ctx.restore();

    ctx.fillStyle = "#374151";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("CCM: L vs rho 収束プロット", width / 2, 14);
  }, [result]);

  const hasData = result.returnToVol.length > 0 || result.returnToVolume.length > 0;
  if (!hasData) return null;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">
        収束交差写像 (CCM) - 非線形因果分析
      </h3>

      <div className="flex flex-wrap gap-2 mb-3">
        <span className={`text-xs px-2 py-1 rounded ${result.convergenceReturnVol ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"}`}>
          Return→Vol: {result.convergenceReturnVol ? "因果あり" : "因果なし"}
        </span>
        <span className={`text-xs px-2 py-1 rounded ${result.convergenceReturnVolume ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
          Return→Volume: {result.convergenceReturnVolume ? "因果あり" : "因果なし"}
        </span>
      </div>

      <canvas ref={canvasRef} />

      <p className="text-xs text-gray-600 mt-2">{result.interpretation}</p>

      <AnalysisGuide title="CCM非線形因果分析の詳細理論">
        <p className="font-medium text-gray-700">1. CCMとは</p>
        <p>
          Sugihara et al. (2012)が提案した非線形因果推論手法です。
          Granger因果が線形モデルに基づくのに対し、CCMはTakens埋め込み定理を利用して
          非線形な動的システムの因果関係を検出します。
          「XがYに影響しているなら、Xの影子多様体からYを予測できるはず」という
          逆説的な論理に基づいています。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>{"1. Takens埋め込み: M_X = {(x_t, x_{t-tau}, ..., x_{t-(E-1)*tau})}"}</p>
        <p>{"2. 最近傍E+1点の距離重み付き予測: Y_hat = Sigma w_i * y_i / Sigma w_i"}</p>
        <p>{"3. rho = Pearson(Y_hat, Y_actual)"}</p>
        <p>{"4. 収束性チェック: rhoがライブラリサイズLの増加とともに増加すれば因果"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>各曲線: ライブラリサイズLを増やしたときの交差写像予測精度</li>
          <li>rhoが収束的に増加: 因果関係の証拠（ライブラリが大きいほど予測精度が向上）</li>
          <li>rhoが平坦 or 減少: 因果関係なし</li>
          <li>双方向に因果がある場合: フィードバックループの存在を示唆</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Return→Vol因果あり: レバレッジ効果（下落→ボラ上昇）の非線形構造を確認</li>
          <li>Volume→Return因果あり: 出来高が価格変動の先行指標として利用可能</li>
          <li>Granger因果と結果が異なる場合: 非線形な因果メカニズムの存在を示唆</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>計算量 O(L*N*E) のため、N≤1000にサブサンプリングしている</li>
          <li>埋め込み次元E=3, 遅延tau=1はデフォルト値。最適値は別途調整が必要</li>
          <li>ノイズが多い場合、収束パターンが不明瞭になる</li>
          <li>CCMは決定論的システムを仮定しており、純粋に確率的な過程には適さない</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
