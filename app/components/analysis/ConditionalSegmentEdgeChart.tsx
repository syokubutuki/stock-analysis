"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  buildStateFn,
  StateAxis,
  STATE_AXES,
  REVERSAL_AXES,
  CALENDAR_AXES,
  CANDLE_RUN_AXES,
} from "../../lib/conditional-forward-returns";
import { conditionalSegmentEdge, SegBucket } from "../../lib/open-close-edge";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const AXES: { value: StateAxis; label: string }[] = [
  ...REVERSAL_AXES, // 前日リターン/RSI(2)/連続下落 など短期向き(寄りの判断に効きやすい)
  ...STATE_AXES,
  ...CANDLE_RUN_AXES,
  ...CALENDAR_AXES,
];

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(3)}%`;
const fmtPct2 = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

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

// バケット別に日中(青)・夜間(赤)の平均リターンを上下ペア棒で描く。
function drawPairedBars(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  buckets: SegBucket[],
  nowLabel: string | null
) {
  const ml = 96, mr = 56, mt = 26, mb = 8;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;
  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("状態別 平均リターン（青=日中 寄→引 / 赤=夜間 引→翌寄, 0中心）", ml - 88, 14);

  const maxAbs = Math.max(
    1e-9,
    ...buckets.flatMap((b) => [Math.abs(b.intraday.meanFwd), Math.abs(b.overnight.meanFwd)])
  );
  const zeroX = ml + plotW / 2;
  const rowH = plotH / buckets.length;
  ctx.strokeStyle = "#9ca3af";
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(zeroX, mt);
  ctx.lineTo(zeroX, mt + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  const barH = Math.max(4, (rowH - 6) / 2);
  buckets.forEach((b, i) => {
    const y0 = mt + i * rowH;
    // ラベル
    ctx.fillStyle = b.label === nowLabel ? "#1d4ed8" : "#4b5563";
    ctx.font = `${b.label === nowLabel ? "bold " : ""}9px sans-serif`;
    ctx.textAlign = "right";
    const lbl = b.label.length > 13 ? b.label.slice(0, 12) + "…" : b.label;
    ctx.fillText(lbl, ml - 4, y0 + rowH / 2 + 3);

    const drawBar = (v: number, sig: boolean, cy: number, color: string) => {
      const w = (Math.abs(v) / maxAbs) * (plotW / 2 - 4);
      const x = v >= 0 ? zeroX : zeroX - w;
      ctx.fillStyle = sig ? color : color + "59"; // 非有意は薄く
      ctx.fillRect(x, cy - barH / 2, w, barH);
      ctx.fillStyle = "#374151";
      ctx.font = "8px sans-serif";
      ctx.textAlign = v >= 0 ? "left" : "right";
      ctx.fillText(fmtPct2(v), v >= 0 ? zeroX + w + 2 : zeroX - w - 2, cy + 3);
    };
    drawBar(b.intraday.meanFwd, b.intraday.significant, y0 + rowH / 2 - barH / 2 - 1, "#2563eb");
    drawBar(b.overnight.meanFwd, b.overnight.significant, y0 + rowH / 2 + barH / 2 + 1, "#dc2626");

    if (b.label === nowLabel) {
      ctx.strokeStyle = "#1d4ed8";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(2, y0 + 1, width - 4, rowH - 2);
    }
  });
}

export default function ConditionalSegmentEdgeChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [axis, setAxis] = useState<StateAxis>("prevRet");

  const result = useMemo(() => {
    if (prices.length < 250) return null;
    const st = buildStateFn(prices, axis);
    return conditionalSegmentEdge(prices, st);
  }, [prices, axis]);

  useEffect(() => {
    if (!result || result.buckets.length === 0 || !canvasRef.current) return;
    const init = initCanvas(canvasRef.current, 44 + result.buckets.length * 34);
    if (init) drawPairedBars(init.ctx, init.width, init.height, result.buckets, result.nowLabel);
  }, [result]);

  if (prices.length < 250) return null;
  if (!result || result.buckets.length === 0) return null;

  const nowBucket = result.buckets.find((b) => b.label === result.nowLabel) ?? null;
  const verdict = (b: SegBucket) => {
    const better = b.diff >= 0 ? "日中(寄→引デイトレ)" : "夜間(引→翌寄持ち越し)";
    const v = b.diff >= 0 ? b.intraday : b.overnight;
    return { better, mean: v.meanFwd, win: v.winRate, sig: v.significant, p: v.p, n: v.n };
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">条件付きエッジ：日中 vs 夜間（状態別にどちらの執行が有利か）</h3>
      </div>

      {/* 状態軸 */}
      <div className="flex gap-1 flex-wrap">
        {AXES.map((a) => (
          <button
            key={a.value}
            onClick={() => setAxis(a.value)}
            className={`px-2.5 py-1 text-xs rounded font-medium ${axis === a.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >
            {a.label}
          </button>
        ))}
      </div>

      <div className="text-[11px] text-gray-400">
        条件は「前日終値時点で確定する状態」で構成（＝当日の寄り前に判断可能）。全標本 {result.totalN}日 / 基準: 日中 {fmtPct(result.baseIntraday)}・夜間 {fmtPct(result.baseOvernight)}。
      </div>

      {/* 現在地サマリー */}
      {nowBucket && (() => {
        const v = verdict(nowBucket);
        return (
          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
            <span className="font-bold">現在の状態: {result.nowLabel}</span>
            {" → "}過去この状態では<span className="font-bold">「{v.better}」</span>が有利
            （平均 <span className="font-bold">{fmtPct(v.mean)}</span>・勝率 {(v.win * 100).toFixed(0)}%、n={v.n}）{" "}
            <StatBadge n={v.n} p={v.p} significant={v.sig} />
            <span className="block mt-0.5 text-blue-700/80">
              内訳: 日中 {fmtPct(nowBucket.intraday.meanFwd)}（勝率{(nowBucket.intraday.winRate * 100).toFixed(0)}%） / 夜間 {fmtPct(nowBucket.overnight.meanFwd)}（勝率{(nowBucket.overnight.winRate * 100).toFixed(0)}%）
            </span>
          </div>
        );
      })()}

      {/* 表 */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 px-2">状態</th>
              <th className="text-right px-2">n</th>
              <th className="text-right px-2">日中平均</th>
              <th className="text-left px-2">日中</th>
              <th className="text-right px-2">夜間平均</th>
              <th className="text-left px-2">夜間</th>
              <th className="text-right px-2">差(日中−夜間)</th>
              <th className="text-center px-2">有利</th>
            </tr>
          </thead>
          <tbody>
            {result.buckets.map((b) => {
              const isNow = b.label === result.nowLabel;
              const idBetter = b.diff >= 0;
              return (
                <tr key={b.label} className={`border-b border-gray-100 ${isNow ? "ring-2 ring-blue-400 ring-inset" : ""}`}>
                  <td className="py-1 px-2 font-medium text-gray-700">
                    {isNow && <span className="text-blue-600 mr-1">◀</span>}
                    {b.label}
                  </td>
                  <td className="text-right px-2 text-gray-600">{b.n}</td>
                  <td className="text-right px-2 tabular-nums" style={{ color: b.intraday.meanFwd >= 0 ? "#2563eb" : "#dc2626" }}>
                    {fmtPct(b.intraday.meanFwd)}
                  </td>
                  <td className="px-2"><StatBadge n={b.intraday.n} p={b.intraday.p} significant={b.intraday.significant} /></td>
                  <td className="text-right px-2 tabular-nums" style={{ color: b.overnight.meanFwd >= 0 ? "#2563eb" : "#dc2626" }}>
                    {fmtPct(b.overnight.meanFwd)}
                  </td>
                  <td className="px-2"><StatBadge n={b.overnight.n} p={b.overnight.p} significant={b.overnight.significant} /></td>
                  <td className="text-right px-2 font-medium tabular-nums text-gray-700">{fmtPct(b.diff)}</td>
                  <td className="text-center px-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${idBetter ? "bg-blue-100 text-blue-700" : "bg-red-100 text-red-700"}`}>
                      {idBetter ? "日中" : "夜間"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="relative"><canvas ref={canvasRef} /></div>

      <AnalysisGuide title="条件付き 日中/夜間エッジの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"始値・終値だけで執行する2大トレード——日中(寄→引のデイトレ)と夜間(引→翌寄の持ち越し)——の期待リターンが、『状態』によってどう変わるかを対比する。例えば『前日が大幅安だった翌日は、寄りから引けにかけて戻りやすい(=日中が有利)のか、それとも寄りに窓を空けて戻り切る(=夜間が有利)のか』を、過去の同条件日から定量化する。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算（先読みバイアスを排除）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>状態</strong>: i−1日（前日）の終値時点で確定する情報だけで判定。よって当日の寄り付き前に「日中で行くか・持ち越すか」を判断できる。</li>
          <li><strong>夜間リターン</strong>: r_on = O_t / C_t−1 − 1（前日終値→当日始値）。</li>
          <li><strong>日中リターン</strong>: r_id = C_t / O_t − 1（当日始値→当日終値）。</li>
          <li><strong>差</strong>: r_id − r_on。正なら日中、負なら夜間が有利。</li>
          <li><strong>有意性</strong>: 各セグメントで平均=0 の1標本t検定 → 状態バケット間を Benjamini-Hochberg FDR で補正（日中・夜間それぞれ別に補正）。95%CIは移動ブロックブートストラップ。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>条件付き期待値</strong>: 「Aという条件のもとでの平均」。無条件平均より状況に即している。</li>
          <li><strong>状態軸</strong>: 前日リターン分位・RSI(2)・連続下落日数・ボラレジーム・曜日や季節など。短期の寄り判断には「前日リターン」「RSI(2)」「連続下落」が効きやすい。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>上部バナー＝<strong>今の状態での推奨執行</strong>。日中が有利なら寄り買い→引け売り、夜間が有利なら引け買い→翌寄り売り。</li>
          <li>「有利」列と<strong>有意バッジ</strong>が一致する状態のみ信頼。差が大きくても両方非有意ならノイズの可能性。</li>
          <li>日中・夜間の符号が逆（片方プラス・片方マイナス）の状態は、執行時刻の選択がそのまま損益を分ける＝最も活用価値が高い。</li>
          <li>青字（プラス）が並ぶ状態は買い持ち、赤字（マイナス）が並ぶ状態は見送り/売り。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>「参考(n小)」バケットは標本が少なく平均が不安定。重視しない。</li>
          <li>取引コスト・スリッページ未控除。日中も夜間も毎日1往復約定するためコスト負けしやすい。</li>
          <li>夜間は窓（ギャップ）でリスクを取る。平均が良くても分散が大きい点に注意。</li>
          <li>状態境界は固定値。境界付近の日は別バケットに入り得る。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
