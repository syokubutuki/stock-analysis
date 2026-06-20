"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useIntraday } from "../../hooks/useIntraday";
import { computeGapIntraday, GapIntradayResult } from "../../lib/gap-intraday";
import {
  initCanvas, fmtPct, fmtSignedPct, IntervalButtons, LoadingError, IntradayCaveat,
} from "./intradayShared";
import { minuteToLabel } from "../../lib/intraday-core";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

function drawFillHist(ctx: CanvasRenderingContext2D, W: number, H: number, r: GapIntradayResult) {
  const ml = 40, mr = 16, mt = 26, mb = 26;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const n = r.fillTimeHist.length;
  if (n === 0) return;
  const slot = plotW / n;
  const barW = Math.max(3, slot * 0.7);
  const maxC = Math.max(1, ...r.fillTimeHist.map((b) => b.count));

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("窓埋め（前日終値到達）の時刻分布", ml, mt - 12);
  for (let i = 0; i < n; i++) {
    const h = (r.fillTimeHist[i].count / maxC) * (plotH - 6);
    const x = ml + i * slot + (slot - barW) / 2;
    ctx.fillStyle = "#0ea5e9cc"; ctx.fillRect(x, mt + plotH - h, barW, h);
    ctx.fillStyle = "#6b7280"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(r.fillTimeHist[i].label, x + barW / 2, mt + plotH + 12);
  }
}

export default function GapIntradayChart({ ticker }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [intervalKey, setIntervalKey] = useState("5m");
  const { resp, loading, error } = useIntraday(ticker, intervalKey);
  const res = useMemo<GapIntradayResult | null>(
    () => (resp ? computeGapIntraday(resp.bars, resp.gmtoffset) : null),
    [resp]
  );

  useEffect(() => {
    if (!canvasRef.current || !res) return;
    const H = 220;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    drawFillHist(init.ctx, init.width, H, res);
  }, [res]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">ギャップ後の日中挙動（窓埋め vs gap-and-go）</h3>
        <IntervalButtons value={intervalKey} onChange={setIntervalKey} />
      </div>
      <LoadingError loading={loading} error={error} />

      {!loading && !error && res && (
        <>
          <div className="text-xs text-gray-500">
            対象 {res.nDays} 営業日 / 上窓 {res.upGapDays}日・下窓 {res.downGapDays}日
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1">窓の種類</th>
                  <th className="text-right">日数</th>
                  <th className="text-right">窓埋め率</th>
                  <th className="text-right">埋め時刻(中央)</th>
                  <th className="text-right">継続率</th>
                  <th className="text-right">寄→引 平均</th>
                </tr>
              </thead>
              <tbody>
                {res.buckets.map((b) => (
                  <tr key={b.label} className="border-b border-gray-100">
                    <td className="py-1 font-medium text-gray-800">{b.label}</td>
                    <td className="text-right">{b.n}</td>
                    <td className="text-right">{fmtPct(b.fillRate)}</td>
                    <td className="text-right">{b.medFillMin ? minuteToLabel(b.medFillMin) : "—"}</td>
                    <td className="text-right">{fmtPct(b.contRate)}</td>
                    <td className={`text-right ${b.closeMeanPct >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(b.closeMeanPct / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="relative"><canvas ref={canvasRef} /></div>

          <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
            {"窓埋め率が高い窓種は『寄り後に前日終値へ戻る（fade）』傾向＝逆張り（窓埋め狙い）が有利。継続率が高ければ gap-and-go（窓方向に伸びる）＝順張りが有利。埋め時刻分布は、窓埋めが前場に集中するか後場までかかるかを示す。"}
          </p>
          <IntradayCaveat />
        </>
      )}

      <AnalysisGuide title="ギャップ後の日中挙動の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"寄り付きの窓（ギャップ）が、その日のうちに埋まる（前日終値へ戻る）か、窓方向へ伸びる（gap-and-go）かを分足で実測する。日足のギャップ分析を日中の時間情報で裏取りし、寄り直後の戦略選択（順張り/逆張り）を判断する。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 数式・定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ギャップ g=(始値−前日終値)/前日終値。|g|の中央値の1.5倍で大小を分け、上窓/下窓×大小の4区分に分類。</li>
          <li>窓埋め: 当日中に価格が前日終値へ到達したか（上窓ならLow≤前日終値、下窓ならHigh≥前日終値）。最初の到達バーの時刻を記録。</li>
          <li>継続率（gap-and-go）: 窓方向に引けまで伸びた割合（上窓かつ引け&gt;始値、下窓かつ引け&lt;始値）。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>窓埋め率が高い→寄り戻り（fade）を狙う逆張り。利確目標は前日終値。</li>
          <li>継続率が高い→窓方向の順張り。寄り直後の押し目/戻りでエントリー。</li>
          <li>埋め時刻が前場集中なら、前場のうちに窓埋めトレードを完了する設計に。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"窓の発生数は限られ、区分ごとのnが小さくなりやすい。日数を必ず確認。"}</li>
          <li>{"薄商い銘柄の窓は信頼性が低く、決算・ニュース起因の窓は性質が異なる。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
