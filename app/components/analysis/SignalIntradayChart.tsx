"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useIntraday } from "../../hooks/useIntraday";
import {
  computeSignalIntraday, SignalIntradayResult, SignalKey, SIGNAL_LABELS,
} from "../../lib/signal-intraday";
import {
  initCanvas, fmtPct, fmtSignedPct, IntervalButtons, LoadingError, IntradayCaveat,
  drawTimeAxisLabels,
} from "./intradayShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

const SIGNALS: SignalKey[] = ["rsiOversold", "rsiOverbought", "bigBull", "gapUp"];

function drawPaths(ctx: CanvasRenderingContext2D, W: number, H: number, r: SignalIntradayResult) {
  const ml = 44, mr = 16, mt = 28, mb = 26;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const n = r.binLabels.length;
  const xs = (i: number) => ml + (i / Math.max(1, n - 1)) * plotW;

  let vmax = 0.3, vmin = -0.3;
  for (const p of r.paths) for (const v of p) { if (v > vmax) vmax = v; if (v < vmin) vmin = v; }
  for (const v of r.avgPathPct) { if (v > vmax) vmax = v; if (v < vmin) vmin = v; }
  const ys = (v: number) => mt + plotH - ((v - vmin) / (vmax - vmin)) * plotH;

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("シグナル翌日の日中経路（細=各日 / 太=平均, 始値比%）", ml, mt - 12);

  const y0 = ys(0);
  ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(ml, y0); ctx.lineTo(ml + plotW, y0); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(vmax.toFixed(2), ml - 4, mt + 9); ctx.fillText(vmin.toFixed(2), ml - 4, mt + plotH);

  ctx.save(); ctx.beginPath(); ctx.rect(ml, mt, plotW, plotH); ctx.clip();
  for (const p of r.paths) {
    ctx.strokeStyle = "#94a3b844"; ctx.lineWidth = 0.8; ctx.beginPath();
    for (let i = 0; i < p.length; i++) { const x = xs(i), y = ys(p[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  }
  ctx.strokeStyle = "#7c3aed"; ctx.lineWidth = 2.4; ctx.beginPath();
  for (let i = 0; i < r.avgPathPct.length; i++) { const x = xs(i), y = ys(r.avgPathPct[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.stroke();
  ctx.restore();

  drawTimeAxisLabels(ctx, r.binLabels, ml, plotW / n, mt + plotH + 14);
}

export default function SignalIntradayChart({ ticker }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [intervalKey, setIntervalKey] = useState("60m");
  const [signal, setSignal] = useState<SignalKey>("rsiOversold");
  const { resp, loading, error } = useIntraday(ticker, intervalKey);
  const binMin = intervalKey === "60m" ? 60 : 30;

  const res = useMemo<SignalIntradayResult | null>(
    () => (resp ? computeSignalIntraday(resp.bars, resp.gmtoffset, signal, binMin) : null),
    [resp, signal, binMin]
  );

  useEffect(() => {
    if (!canvasRef.current || !res) return;
    const H = 320;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    drawPaths(init.ctx, init.width, H, res);
  }, [res]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">日足シグナル翌日の日中エントリー最適化</h3>
        <IntervalButtons value={intervalKey} onChange={setIntervalKey} />
      </div>
      <div className="flex gap-1 flex-wrap">
        {SIGNALS.map((s) => (
          <button key={s} onClick={() => setSignal(s)}
            className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${signal === s ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
            {SIGNAL_LABELS[s]}
          </button>
        ))}
      </div>
      <LoadingError loading={loading} error={error} />

      {!loading && !error && !res && (
        <div className="text-sm text-gray-400 py-6 text-center">この足ではシグナル日が不足しています（60分足を推奨）。</div>
      )}

      {!loading && !error && res && (
        <>
          <div className="text-xs text-gray-500">{SIGNAL_LABELS[res.signal]} の翌日: {res.nSignals}日 / 最良エントリー: <strong>{res.bestEntryLabel}</strong></div>
          <div className="relative"><canvas ref={canvasRef} /></div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1">エントリールール</th>
                  <th className="text-right">n</th>
                  <th className="text-right">引けまで平均R</th>
                  <th className="text-right">勝率</th>
                </tr>
              </thead>
              <tbody>
                {res.entryRules.map((rule) => (
                  <tr key={rule.label} className="border-b border-gray-100">
                    <td className="py-1 font-medium">{rule.label}</td>
                    <td className="text-right">{rule.n}</td>
                    <td className={`text-right ${rule.meanRetPct >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(rule.meanRetPct / 100)}</td>
                    <td className="text-right">{fmtPct(rule.winRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
            {"日足のシグナルが出た『翌日』、寄り後どの時刻に入ると引けまでの期待値が高いかを比較する。平均経路（紫）が寄り後に沈んでから引けへ戻る形なら、寄り直後ではなく押し目（30〜60分後）で入る方が有利。エントリールール表の期待Rで最適な入り方を選ぶ。"}
          </p>
          <IntradayCaveat extra="日足シグナルは日中足から再構成した日次OHLCで判定。シグナル日数が少ない点に注意。" />
        </>
      )}

      <AnalysisGuide title="日足シグナル×日中エントリーの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"日足の状態（RSI過熱・大陽線・ギャップ）が出た翌営業日に、寄り後どの時刻・どの方法でエントリーするのが最も有利かを日中足で測る。日足のシグナルと日内の執行タイミングを橋渡しする。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. シグナルと数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>RSI(14): ワイルダー平滑のRSI。&lt;30で売られ過ぎ、&gt;70で買われ過ぎ。</li>
          <li>大陽線: 前日の (引け−始値)/始値 &gt; +2%。ギャップアップ: 前日の窓 &gt; +0.5%。</li>
          <li>翌日経路: 翌日の各時間帯終値を始値比 (px−O)/O で正規化し、シグナル日で平均。</li>
          <li>エントリールール: 寄り成り/寄り30分後/寄り60分後 から引けまでのリターンと勝率を比較。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>シグナル翌日の平均経路の谷で入り、山で利確する時刻設計。</li>
          <li>「寄り成りより30分後の方が期待R高」なら、寄り天をやり過ごして押し目で入る。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"5分足は約60日でシグナル日が極端に少ない。60分足（約2年）の利用を推奨。"}</li>
          <li>{"日中足から再構成した日次OHLCを使うため、配当調整や厳密な日足とは差が出る場合がある。"}</li>
          <li>{"サンプル外での再現性を必ず確認すること。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
