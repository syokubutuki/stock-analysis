"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { findAnalogs, AnalogResult } from "../../lib/historical-analog";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const LS = [20, 40, 60];
const MS = [10, 20, 40];
const KS = [10, 20, 30];

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
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

function drawPaths(ctx: CanvasRenderingContext2D, width: number, height: number, r: AnalogResult, M: number) {
  const ml = 48, mr = 14, mt = 20, mb = 24;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;
  // y範囲
  const all = r.neighbors.flatMap((nb) => nb.futurePath).concat(r.p25, r.p75);
  const maxV = Math.max(0.01, ...all.map(Math.abs));
  const yOf = (v: number) => mt + plotH / 2 - (v / maxV) * (plotH / 2 - 4);
  const xOf = (m: number) => ml + (m / M) * plotW;

  // グリッド・ゼロ線
  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`類似${r.neighbors.length}件のその後${M}日（薄線=各事例 / 太線=中央値 / 帯=25–75%）`, ml, 13);
  ctx.strokeStyle = "#e5e7eb";
  ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(ml, yOf(0)); ctx.lineTo(ml + plotW, yOf(0)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(`+${(maxV * 100).toFixed(0)}%`, ml - 4, mt + 8);
  ctx.fillText("0%", ml - 4, yOf(0) + 3);
  ctx.fillText(`-${(maxV * 100).toFixed(0)}%`, ml - 4, mt + plotH);

  // 25-75帯
  ctx.fillStyle = "rgba(37,99,235,0.12)";
  ctx.beginPath();
  for (let m = 0; m <= M; m++) ctx[m === 0 ? "moveTo" : "lineTo"](xOf(m), yOf(r.p75[m]));
  for (let m = M; m >= 0; m--) ctx.lineTo(xOf(m), yOf(r.p25[m]));
  ctx.closePath();
  ctx.fill();

  // 各事例
  ctx.strokeStyle = "rgba(148,163,184,0.5)";
  ctx.lineWidth = 1;
  for (const nb of r.neighbors) {
    ctx.beginPath();
    nb.futurePath.forEach((v, m) => ctx[m === 0 ? "moveTo" : "lineTo"](xOf(m), yOf(v)));
    ctx.stroke();
  }
  // 中央値
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  r.medianPath.forEach((v, m) => ctx[m === 0 ? "moveTo" : "lineTo"](xOf(m), yOf(v)));
  ctx.stroke();
  // x軸
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  for (let m = 0; m <= M; m += Math.max(1, Math.round(M / 5))) ctx.fillText(`+${m}d`, xOf(m), mt + plotH + 14);
}

export default function HistoricalAnalogChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [L, setL] = useState(40);
  const [M, setM] = useState(20);
  const [K, setK] = useState(20);

  const result = useMemo(() => findAnalogs(prices, L, M, K), [prices, L, M, K]);

  useEffect(() => {
    if (!canvasRef.current || !result) return;
    const init = initCanvas(canvasRef.current, 260);
    if (init) drawPaths(init.ctx, init.width, init.height, result, M);
  }, [result, M]);

  if (prices.length < 100) return null;

  const Btn = ({ v, cur, set }: { v: number; cur: number; set: (n: number) => void }) => (
    <button onClick={() => set(v)} className={`px-2 py-0.5 rounded ${cur === v ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{v}</button>
  );

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">ヒストリカル・アナログ（類似局面検索）</h3>

      <div className="flex flex-wrap gap-3 text-xs text-gray-600">
        <div className="flex items-center gap-1"><span>窓 L:</span>{LS.map((v) => <Btn key={v} v={v} cur={L} set={setL} />)}</div>
        <div className="flex items-center gap-1"><span>先行き M:</span>{MS.map((v) => <Btn key={v} v={v} cur={M} set={setM} />)}</div>
        <div className="flex items-center gap-1"><span>近傍 K:</span>{KS.map((v) => <Btn key={v} v={v} cur={K} set={setK} />)}</div>
      </div>

      {result ? (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          直近{L}日の形に似た過去{result.neighbors.length}件 → その後{M}日の
          <span className="font-bold"> 中央値 {result.medianFinal >= 0 ? "+" : ""}{(result.medianFinal * 100).toFixed(1)}%</span>
          （上昇 {result.upCount}件 / 下落 {result.downCount}件）。
        </div>
      ) : (
        <div className="text-xs text-gray-400">データ不足（期間を長くしてください）</div>
      )}

      <div className="relative"><canvas ref={canvasRef} /></div>

      {result && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 px-2">類似局面（窓末日）</th>
                <th className="text-right px-2">距離</th>
                <th className="text-right px-2">その後{M}日</th>
              </tr>
            </thead>
            <tbody>
              {result.neighbors.slice(0, 8).map((nb) => (
                <tr key={nb.endIndex} className="border-b border-gray-100">
                  <td className="py-1 px-2 text-gray-700">{nb.endTime}</td>
                  <td className="text-right px-2 text-gray-500">{nb.distance.toFixed(2)}</td>
                  <td className={`text-right px-2 font-medium ${nb.futureReturn >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {nb.futureReturn >= 0 ? "+" : ""}{(nb.futureReturn * 100).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AnalysisGuide title="ヒストリカル・アナログの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"『今の値動きの形に一番似ていた過去はいつで、その後どうなったか』を機械的に探す。直近L日の波形をクエリにして、過去の全期間からよく似た窓を距離で順位付けし、上位K件の“その後M日”を重ねて分布を見る。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>正規化</strong>: 各窓を「初日比の対数リターン列」にし、さらにzスコア化。株価水準やボラの大小を吸収し“形”だけを比較。</li>
          <li><strong>距離</strong>: 正規化波形同士のユークリッド距離。小さいほど似ている。</li>
          <li><strong>先読み防止</strong>: 直近窓と時間的に重なる候補は除外。各近傍の窓末を0%として以降M日の累積リターンを整列。</li>
          <li><strong>中央値パス・25–75%帯</strong>: 各ステップで近傍の分布を集計。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>中央値パスが右肩上がり＆帯が上側に偏る＝似た形のあと上がりやすい。上昇件数/下落件数の比も確認。</li>
          <li>帯が広い＝先行きのばらつきが大きく、確信度は低い。サイズを抑える。</li>
          <li>類似局面の日付を本体チャートで確認し、当時の地合い（暴落後・天井圏等）が今と整合するか吟味。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>「形が似ている」だけで因果はない。少数事例（K小）は偶然に振られやすい。</li>
          <li>レジームが違えば同じ形でも結果は変わる（過去の上げ相場と今の下げ相場など）。</li>
          <li>ユークリッド距離は時間のズレに弱い（DTWで緩和可能だが本実装は等速比較）。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
