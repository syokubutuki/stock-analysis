"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { TpSlResult } from "../../lib/tp-sl-optimizer";
import type { TpSlWorkerRequest, TpSlWorkerResponse } from "../../lib/tp-sl-optimizer.worker";
import { representativeSpread } from "../../lib/spread-estimator";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

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

function drawHeatmap(ctx: CanvasRenderingContext2D, width: number, r: TpSlResult, unitLabel: (v: number) => string) {
  const ml = 56, mr = 12, mt = 36, mb = 30;
  const nT = r.tpLevels.length, nS = r.slLevels.length;
  const cw = (width - ml - mr) / nS;
  const ch = 26;
  const height = mt + nT * ch + mb;
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("TP×SL 期待リターン（★=最大, 緑=高い）", ml - 48, 14);
  ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("→ 損切り SL", ml + (width - ml - mr) / 2, 28);

  const maxAbs = Math.max(1e-9, ...r.cells.map((c) => Math.abs(c.expReturn)));
  // 軸ラベル
  ctx.save();
  ctx.translate(14, mt + (nT * ch) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = "#6b7280"; ctx.textAlign = "center";
  ctx.fillText("利確 TP ↑", 0, 0);
  ctx.restore();

  r.tpLevels.forEach((tp, ti) => {
    const y = mt + (nT - 1 - ti) * ch; // TP大を上に
    ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(unitLabel(tp), ml - 4, y + ch / 2 + 3);
    r.slLevels.forEach((sl, si) => {
      const cell = r.cells.find((c) => c.tp === tp && c.sl === sl)!;
      const x = ml + si * cw;
      const t = Math.min(1, Math.abs(cell.expReturn) / maxAbs);
      ctx.fillStyle = cell.expReturn >= 0 ? `rgba(22,163,74,${0.12 + t * 0.6})` : `rgba(220,38,38,${0.12 + t * 0.6})`;
      ctx.fillRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
      if (r.best && cell.tp === r.best.tp && cell.sl === r.best.sl) {
        ctx.fillStyle = "#111827"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center";
        ctx.fillText("★", x + cw / 2, y + ch / 2 + 4);
        ctx.strokeStyle = "#111827"; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, cw - 2, ch - 2);
      }
    });
  });
  // SLラベル
  ctx.fillStyle = "#6b7280"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
  r.slLevels.forEach((sl, si) => ctx.fillText(unitLabel(sl), ml + si * cw + cw / 2, mt + nT * ch + 12));
  return height;
}

function drawMfeMae(ctx: CanvasRenderingContext2D, width: number, height: number, r: TpSlResult) {
  const ml = 48, mr = 14, mt = 22, mb = 22;
  const plotW = width - ml - mr, plotH = height - mt - mb;
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("保有日数別 平均MFE（含み益）/ MAE（含み損）", ml, 13);
  const maxV = Math.max(0.01, ...r.mfeMae.flatMap((p) => [p.meanMFE, p.meanMAE]));
  const n = r.mfeMae.length;
  const xOf = (i: number) => ml + (i / Math.max(1, n - 1)) * plotW;
  const yOf = (v: number) => mt + plotH - (v / maxV) * plotH;
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(`${(maxV * 100).toFixed(1)}%`, ml - 4, mt + 8);
  ctx.fillText("0", ml - 4, mt + plotH);
  const line = (key: "meanMFE" | "meanMAE", color: string) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    r.mfeMae.forEach((p, i) => ctx[i === 0 ? "moveTo" : "lineTo"](xOf(i), yOf(p[key])));
    ctx.stroke();
  };
  line("meanMFE", "#16a34a");
  line("meanMAE", "#dc2626");
  ctx.font = "9px sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "#9ca3af";
  for (let i = 0; i < n; i += Math.max(1, Math.round(n / 6))) ctx.fillText(`${r.mfeMae[i].hold}d`, xOf(i), mt + plotH + 14);
  ctx.textAlign = "left";
  ctx.fillStyle = "#16a34a"; ctx.fillText("■MFE", ml + 4, mt + 10);
  ctx.fillStyle = "#dc2626"; ctx.fillText("■MAE", ml + 50, mt + 10);
}

export default function TpSlOptimizerChart({ prices }: Props) {
  const heatRef = useRef<HTMLCanvasElement>(null);
  const mfeRef = useRef<HTMLCanvasElement>(null);
  const [unit, setUnit] = useState<"atr" | "pct">("atr");
  const [maxHold, setMaxHold] = useState(20);
  const [deductCost, setDeductCost] = useState(false);
  const [result, setResult] = useState<TpSlResult | null>(null);
  const [loading, setLoading] = useState(false);

  const spread = useMemo(() => representativeSpread(prices), [prices]);

  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  // Worker 起動
  useEffect(() => {
    const worker = new Worker(new URL("../../lib/tp-sl-optimizer.worker.ts", import.meta.url));
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<TpSlWorkerResponse>) => {
      if (ev.data.reqId !== reqIdRef.current) return;
      setResult(ev.data.result);
      setLoading(false);
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // 計算リクエスト
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || prices.length < 260) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    const req: TpSlWorkerRequest = {
      reqId,
      prices,
      opts: { unit, maxHold, entryStep: 1, costPerTrade: deductCost ? spread : 0 },
    };
    worker.postMessage(req);
  }, [prices, unit, maxHold, deductCost, spread]);

  const unitLabel = (v: number) => (unit === "atr" ? `${v}×ATR` : `${(v * 100).toFixed(0)}%`);

  useEffect(() => {
    if (!heatRef.current || !result) return;
    const ul = (v: number) => (result.unit === "atr" ? `${v}×ATR` : `${(v * 100).toFixed(0)}%`);
    const h = 36 + result.tpLevels.length * 26 + 30;
    const init = initCanvas(heatRef.current, h);
    if (init) drawHeatmap(init.ctx, init.width, result, ul);
  }, [result]);

  useEffect(() => {
    if (!mfeRef.current || !result) return;
    const init = initCanvas(mfeRef.current, 170);
    if (init) drawMfeMae(init.ctx, init.width, 170, result);
  }, [result]);

  if (prices.length < 260) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">最適 TP/SL（保有期間別 MFE/MAE）</h3>
        <div className="flex items-center gap-1 text-xs">
          {(["atr", "pct"] as const).map((u) => (
            <button key={u} onClick={() => setUnit(u)} className={`px-2 py-0.5 rounded ${unit === u ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>
              {u === "atr" ? "ATR倍" : "%固定"}
            </button>
          ))}
          <span className="ml-2 text-gray-500">保有上限:</span>
          {[10, 20, 40].map((h) => (
            <button key={h} onClick={() => setMaxHold(h)} className={`px-2 py-0.5 rounded ${maxHold === h ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{h}日</button>
          ))}
          <button
            onClick={() => setDeductCost((v) => !v)}
            className={`ml-2 px-2 py-0.5 rounded ${deductCost ? "bg-amber-500 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
            title={`往復コスト ${(spread * 100).toFixed(3)}% を控除`}
          >
            コスト控除{deductCost ? `(${(spread * 100).toFixed(2)}%)` : ""}
          </button>
        </div>
      </div>

      {loading && <div className="text-xs text-gray-400">計算中...（Web Worker）</div>}

      {result?.best && (
        <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">
          推奨: 利確 <span className="font-bold">{unitLabel(result.best.tp)}</span> / 損切り <span className="font-bold">{unitLabel(result.best.sl)}</span>
          {" → "}期待リターン <span className="font-bold">{(result.best.expReturn * 100).toFixed(2)}%</span>・勝率 {(result.best.winRate * 100).toFixed(0)}%
          {result.unit === "pct" && <>・期待R {result.best.expR.toFixed(2)}</>}
          （エントリー {result.nEntries}件・当日引け建てロング{deductCost ? "・コスト控除後" : ""}）
        </div>
      )}

      <div className="relative"><canvas ref={heatRef} /></div>
      <div className="relative"><canvas ref={mfeRef} /></div>

      <AnalysisGuide title="最適TP/SL・MFE/MAEの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"エントリー後の値動き経路を使い、『利確(TP)と損切り(SL)をどこに置けば期待値が最大になるか』を総当たりで評価する。併せて、保有日数ごとに含み益(MFE)・含み損(MAE)の平均がどう伸びるかを見て、利確/損切りの目安と最適な保有期間を探る。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>MFE</strong> (Maximum Favorable Excursion)＝保有中の最大含み益、<strong>MAE</strong> (Maximum Adverse Excursion)＝最大含み損。</li>
          <li><strong>TP/SLシミュレーション</strong>: 当日引けで建て、以後の各日の高値がTPに達したら利確、安値がSLに達したら損切り（同日両ヒットはSL優先＝保守的）、満了時は引けで手仕舞い。</li>
          <li>単位は<strong>ATR倍</strong>（ボラ調整）または<strong>%固定</strong>。各セルでエントリー全件の平均リターン・勝率を算出。</li>
          <li><strong>期待R</strong>＝平均リターン ÷ 損切り幅（1トレードのリスクを1Rとした倍数）。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ヒートマップの<strong>★（最大セル）</strong>が期待値最大のTP/SL。緑が濃い帯＝有利な組合せ。</li>
          <li>MFE曲線が頭打ちになる保有日数＝それ以上持っても含み益が伸びにくい＝利確/手仕舞いの目安。</li>
          <li>MAEの平均＝典型的な逆行幅。SLをこれより内側に置くと“通常の揺れ”で狩られやすい。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>全日エントリーの平均なので、特定シグナルの最適TP/SLとは異なる（無条件ベースライン）。</li>
          <li>過去データへの最適化＝過剰最適化のリスク。サンプル外・ブートストラップで頑健性確認を。</li>
          <li>同日にTP/SL両方届いた場合の順序は日足では不明（本実装はSL優先で保守的に評価）。</li>
          <li>「コスト控除」ONで、高安スプレッド推定（CSの中央値）を往復取引コストとして各トレードから差し引く。スリッページ・ギャップでの想定外約定は別途。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
