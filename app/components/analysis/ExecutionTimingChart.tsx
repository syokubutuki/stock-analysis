"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useIntraday } from "../../hooks/useIntraday";
import {
  computeExecutionTiming, ExecResult, ExecBin, Side, Leg,
} from "../../lib/execution-timing";
import {
  initCanvas, fmtSignedPct, IntervalButtons, ViewTabs, LoadingError, IntradayCaveat,
} from "./intradayShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

const LEGS: { value: Leg; label: string }[] = [
  { value: "open", label: "寄り(エントリー)" },
  { value: "close", label: "引け(エグジット)" },
];

function drawBins(ctx: CanvasRenderingContext2D, W: number, H: number, res: ExecResult) {
  const ml = 54, mr: number = 16, mt = 28, mb = 40;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const bins = res.bins;
  const n = bins.length;
  const slot = plotW / n;

  const amax = Math.max(
    0.02,
    ...bins.map((b) => Math.abs(b.meanImprovePct)),
    ...bins.map((b) => Math.abs(b.ciLoPct)),
    ...bins.map((b) => Math.abs(b.ciHiPct)),
  );
  const y0 = mt + plotH / 2;
  const ys = (v: number) => y0 - (v / amax) * (plotH / 2 - 8);

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`${res.markLabel}比 約定改善（${res.side === "buy" ? "買い" : "売り"}・正=有利）`, ml, mt - 12);
  // ゼロ線(=成行マーク基準)
  ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(ml, y0); ctx.lineTo(ml + plotW, y0); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(`+${amax.toFixed(3)}%`, ml - 4, mt + 9);
  ctx.fillText(`-${amax.toFixed(3)}%`, ml - 4, mt + plotH);

  const barW = Math.max(6, slot * 0.42);
  bins.forEach((b, i) => {
    const cx = ml + i * slot + slot / 2;
    const x = cx - barW / 2;
    const v = b.meanImprovePct;
    const yv = ys(v);
    const isBest = res.best && b.barOffset === res.best.barOffset;
    ctx.fillStyle = b.isMark
      ? "#9ca3af"
      : v >= 0 ? (isBest ? "#15803d" : "#16a34a") : "#dc2626";
    ctx.fillRect(x, Math.min(y0, yv), barW, Math.abs(yv - y0) || 1);

    // CI ひげ(マーク以外)
    if (!b.isMark) {
      ctx.strokeStyle = "#4b5563"; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, ys(b.ciLoPct)); ctx.lineTo(cx, ys(b.ciHiPct));
      ctx.moveTo(cx - 3, ys(b.ciLoPct)); ctx.lineTo(cx + 3, ys(b.ciLoPct));
      ctx.moveTo(cx - 3, ys(b.ciHiPct)); ctx.lineTo(cx + 3, ys(b.ciHiPct));
      ctx.stroke();
    }
    if (isBest) {
      ctx.strokeStyle = "#15803d"; ctx.lineWidth = 2;
      ctx.strokeRect(ml + i * slot + 1, mt + 1, slot - 2, plotH - 2);
    }

    // ラベル・n
    ctx.fillStyle = isBest ? "#15803d" : "#374151"; ctx.font = `${isBest ? "bold " : ""}9px sans-serif`; ctx.textAlign = "center";
    ctx.fillText(b.label, cx, mt + plotH + 14);
    ctx.fillStyle = "#9ca3af"; ctx.font = "8px sans-serif";
    ctx.fillText(`n=${b.n}`, cx, mt + plotH + 26);
  });
}

export default function ExecutionTimingChart({ ticker }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [intervalKey, setIntervalKey] = useState("5m");
  const [leg, setLeg] = useState<Leg>("open");
  const [side, setSide] = useState<Side>("buy");
  const { resp, loading, error } = useIntraday(ticker, intervalKey);

  const res = useMemo<ExecResult | null>(
    () => (resp ? computeExecutionTiming(resp.bars, resp.gmtoffset, side, leg, resp.interval) : null),
    [resp, side, leg]
  );

  useEffect(() => {
    if (!canvasRef.current || !res) return;
    const H = 320;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    drawBins(init.ctx, init.width, H, res);
  }, [res]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">寄り/引け 近傍 約定タイミング最適化</h3>
        <IntervalButtons value={intervalKey} onChange={setIntervalKey}
          options={[{ value: "5m", label: "5分足" }, { value: "15m", label: "15分足" }, { value: "30m", label: "30分足" }]} />
      </div>

      <div className="flex items-center justify-between flex-wrap gap-2">
        <ViewTabs value={leg} onChange={setLeg} views={LEGS} />
        <div className="flex gap-1">
          {(["buy", "sell"] as const).map((s) => (
            <button key={s} onClick={() => setSide(s)}
              className={`px-2.5 py-1 text-xs rounded font-medium ${side === s ? (s === "buy" ? "bg-green-600 text-white" : "bg-red-600 text-white") : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
              {s === "buy" ? "買い約定" : "売り約定"}
            </button>
          ))}
        </div>
      </div>

      <LoadingError loading={loading} error={error} />

      {!loading && !error && res && (
        <>
          <div className="text-xs text-gray-500">
            対象 {res.nDays} 営業日 / {resp?.interval} 足。
            {res.leg === "open" ? "寄り付き後どれだけ待つか" : "引け前どれだけ早く手仕舞うか"}を比較（基準＝{res.markLabel}での成行）。
            {res.intervalNote && <span className="text-amber-600"> ※{res.intervalNote}</span>}
          </div>

          {/* 現在地サマリー */}
          {res.best ? (
            <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">
              <span className="font-bold">
                「{res.best.label}」に{res.side === "buy" ? "買う" : "売る"}と{res.markLabel}比 平均{" "}
                {fmtSignedPct(res.best.meanImprovePct / 100)} 有利
              </span>
              （勝率 {(res.best.winRate * 100).toFixed(0)}%、95%CI {fmtSignedPct(res.best.ciLoPct / 100)}〜{fmtSignedPct(res.best.ciHiPct / 100)}、n={res.best.n}）。
              {res.leg === "open" ? "寄り成りより待つ価値あり。" : "引け成りより早めの手仕舞いが有利。"}
            </div>
          ) : (
            <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
              {res.markLabel}での成行を上回る（CIが0をまたがない）オフセットは見つからなかった → <span className="font-medium">成行約定で十分</span>。待つほど価格のばらつき（タイミングリスク）が増えるだけの可能性。
            </div>
          )}

          <div className="relative"><canvas ref={canvasRef} /></div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">約定位置</th>
                  <th className="text-right px-2">n</th>
                  <th className="text-right px-2">マーク比改善</th>
                  <th className="text-left px-2">95%CI</th>
                  <th className="text-right px-2">勝率</th>
                  <th className="text-right px-2">VWAP比</th>
                  <th className="text-right px-2">タイミングリスク</th>
                </tr>
              </thead>
              <tbody>
                {res.bins.map((b: ExecBin) => {
                  const isBest = res.best && b.barOffset === res.best.barOffset;
                  return (
                    <tr key={b.barOffset} className={`border-b border-gray-100 ${isBest ? "ring-2 ring-green-400 ring-inset" : ""}`}>
                      <td className="py-1 px-2 font-medium text-gray-700">
                        {isBest && <span className="text-green-600 mr-1">◀</span>}
                        {b.label}{b.isMark && <span className="text-gray-400">（成行・基準）</span>}
                      </td>
                      <td className="text-right px-2 text-gray-600">{b.n}</td>
                      <td className={`text-right px-2 font-medium tabular-nums ${b.isMark ? "text-gray-400" : b.meanImprovePct >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {b.isMark ? "—" : fmtSignedPct(b.meanImprovePct / 100)}
                      </td>
                      <td className="px-2 text-gray-500 whitespace-nowrap tabular-nums">
                        {b.isMark ? "—" : `${fmtSignedPct(b.ciLoPct / 100)}〜${fmtSignedPct(b.ciHiPct / 100)}`}
                      </td>
                      <td className="text-right px-2 text-gray-600 tabular-nums">{b.isMark ? "—" : `${(b.winRate * 100).toFixed(0)}%`}</td>
                      <td className={`text-right px-2 tabular-nums ${b.meanVsVwapPct >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {fmtSignedPct(b.meanVsVwapPct / 100)}
                      </td>
                      <td className="text-right px-2 text-gray-500 tabular-nums">{b.driftStdPct.toFixed(2)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <IntradayCaveat extra="約定価格は各オフセット時点のバー始値/終値で近似（板・気配は未取得）。成行のスリッページ・手数料は別途。" />
        </>
      )}

      <AnalysisGuide title="約定タイミング最適化の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"日足の戦略分析は『始値ちょうど・終値ちょうどで約定できる』前提で組むが、実際の注文は寄り付き直後や引け直前のどこかで約定する。寄り成りで即座に約定するのと、数分待って（引けなら数分早めて）約定するのとで、その売買方向にとって平均的にどちらが有利かを、複数営業日の分足から定量化する。日足の始値/終値エッジを『実際に取れる価格』で割り引く精緻化。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>公式マーク</strong>: 寄り側＝当日始値、引け側＝当日終値。これを成行で約定する基準（改善=0）とする。</li>
          <li><strong>約定改善</strong>（方向考慮）: 買い = (マーク − 約定価格)/マーク、売り = (約定価格 − マーク)/マーク。正なら成行より有利。</li>
          <li><strong>約定価格</strong>: 寄り後 +k分（または引け −k分）時点のバー価格で近似。k ∈ {`{0,5,10,15,30}`}分。</li>
          <li><strong>95%CI / stable</strong>: 営業日をまたいだ改善の移動ブロックブートストラップ信頼区間。CIが0をまたがなければ「待つ/早める価値あり」。</li>
          <li><strong>VWAP比</strong>: 当日VWAP（出来高加重平均＝中立な公正値）に対する約定品質。絶対基準での良し悪し。</li>
          <li><strong>タイミングリスク</strong>: マークからの価格変化の標準偏差。待つほど約定価格が日替わりでブレる度合い。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>成行(マーク)</strong>: 寄り/引けの板に即座にぶつける約定。基準点。</li>
          <li><strong>実装ショートフォール</strong>: 「狙った価格」と「実際に約定できた価格」の差。本分析はこれを時刻別に可視化したもの。</li>
          <li><strong>VWAP</strong>: その日の出来高加重平均価格。機関の平均約定コストの目安で、執行品質の中立ベンチマーク。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>上部バナー＝<strong>最良の約定位置</strong>（成行を有意に上回るもの）。寄り側で正＝寄り直後の高値掴みを避け待つと得、引け側で正＝引け間際の不利を避け早めると得。</li>
          <li>緑バーでも<strong>CIひげが0をまたぐ</strong>なら誤差の範囲。またがないビンだけ信頼する。</li>
          <li>どのビンも0近傍＝<strong>成行で十分</strong>。無駄に待つとタイミングリスク（約定のブレ）が増えるだけ。</li>
          <li>VWAP比が一貫して正のビン＝機関の平均より良い約定ができている時間帯。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>サンプルが薄い</strong>: 5分足で約40営業日。CI・勝率とあわせ過剰解釈を避ける。</li>
          <li>板・気配は取得できないため、約定価格はバー価格での近似。真のスリッページ（成行の食い込み）は含まない。</li>
          <li>Yahoo分足は約15分遅延。当日のライブ執行判断には使えない（過去傾向の把握用）。</li>
          <li>「待つ」戦略は価格が逆行した日に機会損失。平均の改善とタイミングリスクのトレードオフで判断する。</li>
          <li>東証は昼休みで前場/後場に分かれる。寄り直後30分は前場内に収まる前提。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
