"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { useIntraday } from "../../hooks/useIntraday";
import { computeEdgeDiscount, EdgeDiscountResult, DiscountedEdge } from "../../lib/edge-discount";
import {
  initCanvas, fmtSignedPct, IntervalButtons, LoadingError, IntradayCaveat, StatCell,
} from "./intradayShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; ticker: string; }

const K_OPTIONS = [5, 10, 15];

function drawDiscount(ctx: CanvasRenderingContext2D, W: number, H: number, rows: DiscountedEdge[]) {
  const ml = 120, mr = 56, mt = 24, mb = 8;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const n = rows.length;
  if (n === 0) return;
  const rowH = plotH / n;
  const maxAbs = Math.max(0.05, ...rows.flatMap((r) => [Math.abs(r.grossPct), Math.abs(r.effPct)]));
  const zeroX = ml + plotW / 2;

  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("グロス(目盛)→実効エッジ(棒) ％／取引", ml - 112, 14);
  ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(zeroX, mt); ctx.lineTo(zeroX, mt + plotH); ctx.stroke(); ctx.setLineDash([]);

  rows.forEach((r, i) => {
    const cy = mt + i * rowH + rowH / 2;
    ctx.fillStyle = "#4b5563"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    const lbl = r.label.length > 16 ? r.label.slice(0, 15) + "…" : r.label;
    ctx.fillText(lbl, ml - 6, cy + 3);
    // 実効バー
    const wEff = (Math.abs(r.effPct) / maxAbs) * (plotW / 2 - 4);
    const xEff = r.effPct >= 0 ? zeroX : zeroX - wEff;
    ctx.fillStyle = r.survives ? "#16a34a" : r.effPct >= 0 ? "#facc15" : "#dc2626";
    ctx.fillRect(xEff, cy - rowH * 0.28, wEff, rowH * 0.56);
    // グロス位置に目盛
    const xGross = zeroX + (r.grossPct / maxAbs) * (plotW / 2 - 4);
    ctx.strokeStyle = "#1f2937"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(xGross, cy - rowH * 0.36); ctx.lineTo(xGross, cy + rowH * 0.36); ctx.stroke();
    // 実効値ラベル
    ctx.fillStyle = "#374151"; ctx.font = "8px sans-serif"; ctx.textAlign = r.effPct >= 0 ? "left" : "right";
    ctx.fillText(fmtSignedPct(r.effPct / 100), r.effPct >= 0 ? zeroX + wEff + 3 : zeroX - wEff - 3, cy + 3);
  });
}

export default function EdgeDiscountChart({ prices, ticker }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [intervalKey, setIntervalKey] = useState("5m");
  const [kMin, setKMin] = useState(10);
  const [useSpread, setUseSpread] = useState(true);
  const { resp, loading, error } = useIntraday(ticker, intervalKey);

  const res = useMemo<EdgeDiscountResult | null>(
    () => (resp ? computeEdgeDiscount(prices, resp.bars, resp.gmtoffset, resp.interval, kMin, useSpread) : null),
    [resp, prices, kMin, useSpread]
  );

  const sigRows = useMemo(() => (res ? res.edges.filter((e) => e.grossSignificant) : []), [res]);

  useEffect(() => {
    if (!canvasRef.current || sigRows.length === 0) return;
    const init = initCanvas(canvasRef.current, 36 + sigRows.length * 26);
    if (init) drawDiscount(init.ctx, init.width, init.height, sigRows);
  }, [sigRows]);

  if (prices.length < 250) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">エッジ割引（公式マーク vs 約定可能価格）</h3>
        <IntervalButtons value={intervalKey} onChange={setIntervalKey}
          options={[{ value: "5m", label: "5分足" }, { value: "15m", label: "15分足" }]} />
      </div>

      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-gray-500">約定窓:</span>
        {K_OPTIONS.map((k) => (
          <button key={k} onClick={() => setKMin(k)}
            className={`px-2 py-0.5 rounded ${kMin === k ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{k}分</button>
        ))}
        <button onClick={() => setUseSpread((v) => !v)}
          className={`ml-2 px-2.5 py-1 rounded font-medium ${useSpread ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
          スプレッド控除{useSpread ? "ON" : "OFF"}
        </button>
      </div>

      <LoadingError loading={loading} error={error} />

      {!loading && !error && res && (
        <>
          <div className={`rounded-md border px-3 py-2 text-xs ${res.nSurvive > 0 ? "border-green-200 bg-green-50 text-green-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
            グロスで有意な <span className="font-bold">{res.nGrossSignificant}</span> 本のエッジ中、現実約定（寄り/引けの約定ズレ{useSpread ? "＋スプレッド" : ""}控除）後も<span className="font-bold">生き残るのは {res.nSurvive} 本</span>。
            {res.nSurvive === 0 && " → 始値/終値ちょうど約定の前提が崩れるとエッジは消える。"}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <StatCell label={`寄りギャップ平均(${res.gaps.kMin}分VWAP)`} value={fmtSignedPct(res.gaps.meanOpenPct / 100)} tone={res.gaps.meanOpenPct >= 0 ? "up" : "down"} />
            <StatCell label="引けギャップ平均" value={fmtSignedPct(res.gaps.meanClosePct / 100)} tone={res.gaps.meanClosePct >= 0 ? "up" : "down"} />
            <StatCell label="往復スプレッド" value={`${res.gaps.spreadRoundTripPct.toFixed(3)}%`} />
            <StatCell label="計測日数" value={`${res.gaps.nDays}日`} />
          </div>

          {sigRows.length > 0 && <div className="relative"><canvas ref={canvasRef} /></div>}

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">トレード型</th>
                  <th className="text-center px-2">方向</th>
                  <th className="text-right px-2">n</th>
                  <th className="text-right px-2">グロス</th>
                  <th className="text-right px-2">寄り割引</th>
                  <th className="text-right px-2">引け割引</th>
                  <th className="text-right px-2">スプレッド</th>
                  <th className="text-right px-2">実効</th>
                  <th className="text-center px-2">生存</th>
                </tr>
              </thead>
              <tbody>
                {res.edges.map((e) => (
                  <tr key={e.label} className={`border-b border-gray-100 ${e.survives ? "bg-green-50/40" : ""}`}>
                    <td className="py-1 px-2 font-medium text-gray-700 whitespace-nowrap">{e.label}</td>
                    <td className="text-center px-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${e.direction === "long" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                        {e.direction === "long" ? "買い" : "売り"}
                      </span>
                    </td>
                    <td className="text-right px-2 text-gray-600 tabular-nums">{e.n}</td>
                    <td className="text-right px-2 tabular-nums text-gray-700">{fmtSignedPct(e.grossPct / 100)}</td>
                    <td className={`text-right px-2 tabular-nums ${e.openTermPct >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(e.openTermPct / 100)}</td>
                    <td className={`text-right px-2 tabular-nums ${e.closeTermPct >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(e.closeTermPct / 100)}</td>
                    <td className="text-right px-2 tabular-nums text-gray-500">{fmtSignedPct(e.spreadTermPct / 100)}</td>
                    <td className={`text-right px-2 font-bold tabular-nums ${e.effPct >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(e.effPct / 100)}</td>
                    <td className="text-center px-2">
                      {e.grossSignificant
                        ? <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${e.survives ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-500"}`}>{e.survives ? "生存" : "消滅"}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <IntradayCaveat extra="ギャップは直近の分足窓で計測し長期エッジに適用（執行ギャップの定常性を仮定）。約定可能価格はk分VWAPでの近似。" />
        </>
      )}

      <AnalysisGuide title="エッジ割引の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"日足の始値/終値トレード分析（売買時刻スキャン）は『始値・終値ちょうどで約定できる』前提でグロスエッジを出す。だが寄り付き・引けのオークション値（公式マーク）と、実際に成行で取れる価格（寄り/引け近傍の数分VWAP）にはズレがある。このズレ＋スプレッドを各トレード型のグロスエッジから差し引いた『実効エッジ』を求め、現実の執行で生き残るエッジだけを選別する。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>約定可能価格</strong>: 寄り後 k分VWAP Ô、引け前 k分VWAP Ĉ（成行を数分に分けて出した時に取れる平均の近似）。</li>
          <li><strong>フィルギャップ</strong>: gapOpen=(Ô−O)/O、gapClose=(Ĉ−C)/C。平均が0から系統的にズレていれば「マークでは取れない」恒常コスト。</li>
          <li><strong>実効エッジ</strong>: ロングは r_net ≈ r_gross + gapExit − gapEntry。方向を掛けて meanEff = グロス + 方向·(出口ギャップ − 入口ギャップ) − 往復スプレッド。</li>
          <li><strong>生存</strong>: グロスがFDR有意 かつ 実効エッジ&gt;0。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>公式マーク</strong>: 取引所が確定する始値/終値（オークション値）。バックテストが使う価格。</li>
          <li><strong>約定可能価格</strong>: 現実に成行でぶつけて取れる価格。寄り直後は気配が薄く滑りやすい。</li>
          <li><strong>実装ショートフォール</strong>: 狙った価格と実約定の差。本分析はそれを系統的に推定して割り引く。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>バナーの<strong>生存本数</strong>＝現実に使えるエッジの数。0なら『理論上のエッジ』に過ぎない。</li>
          <li>表の<strong>実効</strong>列が正かつ<strong>生存</strong>のトレード型だけを実戦候補に。</li>
          <li>寄りギャップ平均が正で大きい銘柄＝寄り成りの買いは不利（マークより高く約定）。引けで建てる/手仕舞う設計が有利な場合がある。</li>
          <li>スプレッド控除ON/OFFで、コストがエッジを食う度合いを確認。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ギャップは直近の分足窓（5分足≈60日）で計測し、長期エッジに一律適用する＝執行ギャップの定常性を仮定。</li>
          <li>板・気配は取得不可。約定可能価格はk分VWAPの近似で、真の成行食い込み（サイズ依存）は含まない。</li>
          <li>スプレッドはCorwin-Schultz推定の中央値を往復コストとして使用（既存のコスト控除と同流儀）。</li>
          <li>Yahoo分足は約15分遅延。過去傾向の割引推定であり、ライブ約定保証ではない。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
