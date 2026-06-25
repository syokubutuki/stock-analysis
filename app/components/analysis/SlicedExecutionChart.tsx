"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useIntraday } from "../../hooks/useIntraday";
import { computeSlicedExecution, SlicedResult, SliceMethod } from "../../lib/sliced-execution";
import { Side, Leg } from "../../lib/execution-timing";
import {
  initCanvas, fmtSignedPct, IntervalButtons, ViewTabs, LoadingError, IntradayCaveat,
} from "./intradayShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

const LEGS: { value: Leg; label: string }[] = [
  { value: "open", label: "寄り約定" },
  { value: "close", label: "引け約定" },
];

function colorOf(m: SliceMethod): string {
  if (m.isSingle) return "#6b7280";
  return m.id.startsWith("vwap") ? "#7c3aed" : "#2563eb";
}

// 平均フィル品質(y) × フィル分散=タイミングリスク(x) の散布図。左上が優位。
function drawFrontier(ctx: CanvasRenderingContext2D, W: number, H: number, res: SlicedResult) {
  const ml = 54, mr = 16, mt = 26, mb = 34;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const ms = res.methods;
  const xMax = Math.max(0.05, ...ms.map((m) => m.fillStdPct)) * 1.1;
  const qAbs = Math.max(0.03, ...ms.map((m) => Math.abs(m.meanQPct))) * 1.15;
  const xs = (v: number) => ml + (v / xMax) * plotW;
  const ys = (v: number) => mt + plotH / 2 - (v / qAbs) * (plotH / 2 - 6);

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("平均フィル品質(↑良) × タイミングリスク(→大)", ml, mt - 12);
  // q=0 線
  ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(ml, ys(0)); ctx.lineTo(ml + plotW, ys(0)); ctx.stroke(); ctx.setLineDash([]);
  // 軸ラベル
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(`+${qAbs.toFixed(3)}%`, ml - 4, mt + 9);
  ctx.fillText(`-${qAbs.toFixed(3)}%`, ml - 4, mt + plotH);
  ctx.textAlign = "center";
  ctx.fillText(`分散 ${xMax.toFixed(2)}% →`, ml + plotW - 30, mt + plotH + 22);

  ms.forEach((m) => {
    const x = xs(m.fillStdPct), y = ys(m.meanQPct);
    const isBest = res.best && m.id === res.best.id;
    ctx.fillStyle = colorOf(m);
    ctx.beginPath(); ctx.arc(x, y, m.isSingle ? 5 : 4, 0, Math.PI * 2); ctx.fill();
    if (isBest) { ctx.strokeStyle = "#15803d"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = "#374151"; ctx.font = "8px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(m.label, x + 7, y + 3);
  });
}

function drawBars(ctx: CanvasRenderingContext2D, W: number, H: number, res: SlicedResult) {
  const ml = 80, mr = 50, mt = 26, mb = 8;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const ms = res.methods;
  const rowH = plotH / ms.length;
  const amax = Math.max(0.03, ...ms.map((m) => Math.max(Math.abs(m.meanQPct), Math.abs(m.qCiLoPct), Math.abs(m.qCiHiPct))));
  const zeroX = ml + plotW / 2;
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("手法別 平均フィル品質（VWAP比・CI）", ml - 72, 14);
  ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(zeroX, mt); ctx.lineTo(zeroX, mt + plotH); ctx.stroke(); ctx.setLineDash([]);

  ms.forEach((m, i) => {
    const cy = mt + i * rowH + rowH / 2;
    ctx.fillStyle = "#4b5563"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(m.label, ml - 6, cy + 3);
    const w = (Math.abs(m.meanQPct) / amax) * (plotW / 2 - 4);
    const x = m.meanQPct >= 0 ? zeroX : zeroX - w;
    ctx.fillStyle = colorOf(m);
    ctx.fillRect(x, cy - rowH * 0.22, w, rowH * 0.44);
    // CIひげ
    ctx.strokeStyle = "#374151"; ctx.lineWidth = 1;
    const xl = zeroX + (m.qCiLoPct / amax) * (plotW / 2 - 4);
    const xh = zeroX + (m.qCiHiPct / amax) * (plotW / 2 - 4);
    ctx.beginPath(); ctx.moveTo(xl, cy); ctx.lineTo(xh, cy);
    ctx.moveTo(xl, cy - 3); ctx.lineTo(xl, cy + 3); ctx.moveTo(xh, cy - 3); ctx.lineTo(xh, cy + 3); ctx.stroke();
    ctx.fillStyle = "#374151"; ctx.font = "8px sans-serif"; ctx.textAlign = m.meanQPct >= 0 ? "left" : "right";
    ctx.fillText(fmtSignedPct(m.meanQPct / 100), m.meanQPct >= 0 ? zeroX + w + 3 : zeroX - w - 3, cy + 3);
  });
}

type View = "frontier" | "bars";
const VIEWS: { value: View; label: string }[] = [
  { value: "frontier", label: "執行フロンティア" },
  { value: "bars", label: "手法別 品質" },
];

export default function SlicedExecutionChart({ ticker }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [intervalKey, setIntervalKey] = useState("5m");
  const [leg, setLeg] = useState<Leg>("open");
  const [side, setSide] = useState<Side>("buy");
  const [view, setView] = useState<View>("frontier");
  const { resp, loading, error } = useIntraday(ticker, intervalKey);

  const res = useMemo<SlicedResult | null>(
    () => (resp ? computeSlicedExecution(resp.bars, resp.gmtoffset, side, leg, resp.interval) : null),
    [resp, side, leg]
  );

  useEffect(() => {
    if (!canvasRef.current || !res) return;
    const H = 300;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    if (view === "frontier") drawFrontier(init.ctx, init.width, H, res);
    else drawBars(init.ctx, init.width, H, res);
  }, [res, view]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">TWAP/VWAP 分割約定の効果</h3>
        <IntervalButtons value={intervalKey} onChange={setIntervalKey}
          options={[{ value: "5m", label: "5分足" }, { value: "15m", label: "15分足" }]} />
      </div>

      <div className="flex items-center justify-between flex-wrap gap-2">
        <ViewTabs value={leg} onChange={setLeg} views={LEGS} />
        <div className="flex gap-1">
          {(["buy", "sell"] as const).map((s) => (
            <button key={s} onClick={() => setSide(s)}
              className={`px-2.5 py-1 text-xs rounded font-medium ${side === s ? (s === "buy" ? "bg-green-600 text-white" : "bg-red-600 text-white") : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
              {s === "buy" ? "買い" : "売り"}
            </button>
          ))}
        </div>
      </div>
      <ViewTabs value={view} onChange={setView} views={VIEWS} />

      <LoadingError loading={loading} error={error} />

      {!loading && !error && res && (
        <>
          <div className="text-xs text-gray-500">
            対象 {res.nDays} 営業日 / {resp?.interval} 足。基準＝{res.markLabel}での単発約定。{view === "frontier" ? "左上（高品質・低リスク）が優位。" : ""}
          </div>

          {res.best && res.single ? (
            <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">
              <span className="font-bold">「{res.best.label}」が単発より有利</span>：タイミングリスク {res.single.fillStdPct.toFixed(2)}% → <span className="font-bold">{res.best.fillStdPct.toFixed(2)}%</span> に圧縮（平均フィルは {fmtSignedPct(res.best.meanQPct / 100)}、単発 {fmtSignedPct(res.single.meanQPct / 100)} 以上を維持）。分割約定の価値あり。
            </div>
          ) : (
            <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
              平均フィルを落とさずタイミングリスクを下げる分割は見つからなかった → <span className="font-medium">単発約定で十分</span>（分割するとドリフトで平均が劣化）。
            </div>
          )}

          <div className="relative"><canvas ref={canvasRef} /></div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">約定手法</th>
                  <th className="text-right px-2">n</th>
                  <th className="text-right px-2">平均品質(VWAP比)</th>
                  <th className="text-left px-2">95%CI</th>
                  <th className="text-right px-2">タイミングリスク</th>
                  <th className="text-right px-2">実装ショートフォール</th>
                </tr>
              </thead>
              <tbody>
                {res.methods.map((m) => {
                  const isBest = res.best && m.id === res.best.id;
                  return (
                    <tr key={m.id} className={`border-b border-gray-100 ${isBest ? "ring-2 ring-green-400 ring-inset" : ""} ${m.isSingle ? "bg-gray-50/60" : ""}`}>
                      <td className="py-1 px-2 font-medium text-gray-700">
                        {isBest && <span className="text-green-600 mr-1">◀</span>}{m.label}
                      </td>
                      <td className="text-right px-2 text-gray-600">{m.n}</td>
                      <td className={`text-right px-2 tabular-nums ${m.meanQPct >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(m.meanQPct / 100)}</td>
                      <td className="px-2 text-gray-500 whitespace-nowrap tabular-nums">{fmtSignedPct(m.qCiLoPct / 100)}〜{fmtSignedPct(m.qCiHiPct / 100)}</td>
                      <td className="text-right px-2 text-gray-600 tabular-nums">{m.fillStdPct.toFixed(2)}%</td>
                      <td className={`text-right px-2 tabular-nums ${m.isMeanPct >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(m.isMeanPct / 100)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <IntradayCaveat extra="板・深さ無しのため真のマーケットインパクトは未モデル化。捉えているのは価格経路の平均化による分散低減（インパクト削減効果は過小評価）。" />
        </>
      )}

      <AnalysisGuide title="TWAP/VWAP分割約定の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"1点約定（寄成/引成）の代わりに、注文を窓内で分割して約定する場合の損得を測る。分割すると1点の偶然（その瞬間の高安・スプレッド）に左右されにくくなり約定価格のばらつき（タイミングリスク）が下がる一方、執行中に価格が動くドリフトリスクが乗る。この平均-分散のトレードオフを可視化する。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>TWAP_W</strong>: 窓W分内バーの等加重平均（等時間分割）。<strong>VWAP_W</strong>: 出来高加重平均（出来高比例分割＝執行ベンチの定番）。</li>
          <li><strong>平均品質 q</strong>: 当日フルVWAP（中立な公正値）比、方向考慮 q=方向·(VWAP_full − P)/VWAP_full。正＝公正値より良い約定。</li>
          <li><strong>タイミングリスク</strong>: (P − マーク)/マーク の標準偏差。分割で縮むのが主効用。</li>
          <li><strong>実装ショートフォール</strong>: 到達価格（マーク）基準の約定差 方向·(P − マーク)/マーク の平均。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>TWAP/VWAP</strong>: 時間で均等に割るか、出来高に比例して割るか。VWAPはベンチ一致だが寄り/引けの高スプレッド時間に約定が集中しがち。</li>
          <li><strong>執行フロンティア</strong>: 縦=平均フィル品質、横=タイミングリスクの散布図。左上（高品質・低リスク）が優れた執行。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>散布図で単発（灰）より<strong>左（低リスク）かつ同等以上の高さ</strong>にある点＝分割する価値のある手法。</li>
          <li>大きいサイズ・薄商い銘柄では分割でばらつき・インパクトを抑えられる。小サイズなら単発で十分なことが多い。</li>
          <li>TWAPとVWAPで優劣が分かれる場合、その銘柄の出来高分布（U字の強さ）に依存。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>板・深さ無しのため<strong>真のマーケットインパクトは測れない</strong>。捉えているのは価格経路の平均化による分散低減で、インパクト削減効果は過小評価。</li>
          <li>分割は執行中のドリフト（価格逆行）リスクを増やす。トレンド日には不利になりうる。</li>
          <li>足より短い窓は計測不能（5分足で15/30/60分窓）。サンプルも薄いためCI併記。</li>
          <li>Yahoo分足は約15分遅延。ライブ執行ではなく過去傾向の把握用。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
