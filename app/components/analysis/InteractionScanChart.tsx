"use client";

import React, { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { PricePoint } from "../../lib/types";
import AnalysisGuide from "./AnalysisGuide";
import {
  scanInteractions,
  buildPairGrid,
  SCAN_AXES,
  type ScanAxis,
  type InteractionSort,
} from "../../lib/interaction-scan";

interface Props {
  prices: PricePoint[];
}

function initCanvas(canvas: HTMLCanvasElement, height: number): { ctx: CanvasRenderingContext2D; width: number; height: number } | null {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

function pct(v: number, d = 3): string { return (v * 100).toFixed(d) + "%"; }
function star(p: number): string { return p < 0.01 ? "***" : p < 0.05 ? "**" : p < 0.1 ? "*" : ""; }
function colorCls(v: number): string { return v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500"; }

const SORT_LABELS: Record<InteractionSort, string> = {
  pAdj: "FDR補正p値",
  absInteraction: "|交互作用|",
  absMean: "|平均リターン|",
};

const HORIZONS = [1, 2, 3, 5, 10, 21];

export default function InteractionScanChart({ prices }: Props) {
  const heatRef = useRef<HTMLCanvasElement>(null);

  const [horizon, setHorizon] = useState(5);
  const [entry, setEntry] = useState<"close" | "open">("close");
  const [minN, setMinN] = useState(20);
  const [sort, setSort] = useState<InteractionSort>("pAdj");
  const [onlySignificant, setOnlySignificant] = useState(false);
  const [pairX, setPairX] = useState<ScanAxis | null>(null);
  const [pairY, setPairY] = useState<ScanAxis | null>(null);

  const scan = useMemo(
    () => scanInteractions(prices, { horizon, entry, minN, sort, bootstrapTopN: 40, boot: 600 }),
    [prices, horizon, entry, minN, sort],
  );

  const rows = useMemo(() => {
    const r = onlySignificant ? scan.cells.filter((c) => c.pAdj < 0.05) : scan.cells;
    return r.slice(0, 30);
  }, [scan.cells, onlySignificant]);

  // 選択ペア(未選択なら先頭セルの軸ペア)
  const activePair = useMemo<{ x: ScanAxis; y: ScanAxis } | null>(() => {
    if (pairX && pairY && pairX !== pairY) return { x: pairX, y: pairY };
    const top = scan.cells[0];
    if (!top) return null;
    return { x: top.axisX, y: top.axisY };
  }, [pairX, pairY, scan.cells]);

  const grid = useMemo(
    () => (activePair ? buildPairGrid(prices, activePair.x, activePair.y, horizon, entry, minN) : null),
    [prices, activePair, horizon, entry, minN],
  );

  const axisLabel = useCallback((a: ScanAxis) => SCAN_AXES.find((x) => x.value === a)?.label ?? a, []);

  // === ペア・ヒートマップ(行=Y状態 / 列=X状態、色=平均フォワード) ===
  const drawHeat = useCallback((canvas: HTMLCanvasElement) => {
    if (!grid) return;
    const { xOrder, yOrder, meanCells, nowX, nowY, maxAbsMean } = grid;
    const labelW = 96, headerH = 40, cellH = 30;
    const nCols = xOrder.length, nRows = yOrder.length;
    const totalH = headerH + nRows * cellH + 10;
    const r = initCanvas(canvas, totalH); if (!r) return;
    const { ctx, width } = r;
    const cellW = Math.max(40, (width - labelW - 8) / Math.max(nCols, 1));

    // 列ヘッダー(X状態)
    ctx.fillStyle = "#374151"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    for (let j = 0; j < nCols; j++) {
      ctx.save();
      ctx.translate(labelW + j * cellW + cellW / 2, headerH - 6);
      ctx.rotate(-Math.PI / 12);
      ctx.fillText(xOrder[j].slice(0, 10), 0, 0);
      ctx.restore();
    }
    for (let i = 0; i < nRows; i++) {
      // 行ラベル(Y状態)
      ctx.fillStyle = "#374151"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(yOrder[i].slice(0, 12), labelW - 5, headerH + i * cellH + cellH / 2 + 3);
      for (let j = 0; j < nCols; j++) {
        const c = meanCells.get(`${xOrder[j]}||${yOrder[i]}`);
        const x = labelW + j * cellW, y = headerH + i * cellH;
        if (!c) {
          ctx.fillStyle = "#f3f4f6";
          ctx.fillRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
          continue;
        }
        const t = Math.min(1, Math.abs(c.mean) / (maxAbsMean || 0.001));
        ctx.fillStyle = c.mean > 0 ? `rgba(22,163,74,${0.1 + 0.8 * t})` : `rgba(220,38,38,${0.1 + 0.8 * t})`;
        ctx.fillRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
        // 平均値 + 有意マーカー
        ctx.fillStyle = t > 0.55 ? "#fff" : "#111827";
        ctx.font = "9px sans-serif"; ctx.textAlign = "center";
        ctx.fillText(`${(c.mean * 100).toFixed(2)}%${star(c.p)}`, x + cellW / 2, y + cellH / 2 - 1);
        ctx.fillStyle = t > 0.55 ? "rgba(255,255,255,0.8)" : "#6b7280";
        ctx.font = "8px sans-serif";
        ctx.fillText(`n=${c.n}`, x + cellW / 2, y + cellH / 2 + 10);
        // 現在セルを枠で強調
        if (xOrder[j] === nowX && yOrder[i] === nowY) {
          ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2.5;
          ctx.strokeRect(x + 1.5, y + 1.5, cellW - 3, cellH - 3);
        }
      }
    }
  }, [grid]);

  useEffect(() => {
    if (heatRef.current) drawHeat(heatRef.current);
  }, [drawHeat]);

  if (prices.length < 120) {
    return <div className="text-xs text-gray-400 p-3">データが不足しています(120営業日以上必要)。</div>;
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">条件ペア交互作用スキャナ</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          2つの状態を掛け合わせたとき、単独効果の足し算を超える“相乗”がどこにあるかを全ペア総当たりで探索。
        </p>
      </div>

      {/* コントロール */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          保有日数N
          <select className="border rounded px-1 py-0.5" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
            {HORIZONS.map((v) => <option key={v} value={v}>{v}日</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          建て
          <select className="border rounded px-1 py-0.5" value={entry} onChange={(e) => setEntry(e.target.value as "close" | "open")}>
            <option value="close">当日終値</option>
            <option value="open">翌日始値</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          最小N
          <select className="border rounded px-1 py-0.5" value={minN} onChange={(e) => setMinN(Number(e.target.value))}>
            {[10, 20, 30, 50].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          並べ替え
          <select className="border rounded px-1 py-0.5" value={sort} onChange={(e) => setSort(e.target.value as InteractionSort)}>
            {(Object.keys(SORT_LABELS) as InteractionSort[]).map((k) => <option key={k} value={k}>{SORT_LABELS[k]}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={onlySignificant} onChange={(e) => setOnlySignificant(e.target.checked)} />
          有意のみ
        </label>
      </div>

      {/* ランキング表 */}
      <div>
        <div className="text-xs text-gray-500 mb-1">
          全{scan.nTested}セルを検定・
          <span className="text-blue-600 font-medium">FDR補正後に交互作用が有意なのは {scan.nSignificant} 件</span>
          （交互作用 = セル平均 −〔両条件を独立に足した予測〕）
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 px-1.5">条件X</th>
                <th className="text-left px-1.5">条件Y</th>
                <th className="text-right px-1">N</th>
                <th className="text-right px-1">セル平均</th>
                <th className="text-right px-1">加法予測</th>
                <th className="text-right px-1">交互作用</th>
                <th className="text-right px-1">勝率</th>
                <th className="text-right px-1">p_adj</th>
                <th className="text-right px-1.5">交互作用CI</th>
                <th className="text-center px-1">今</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c, i) => {
                const sig = c.pAdj < 0.05;
                return (
                  <tr
                    key={i}
                    className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${sig ? "bg-blue-50/50" : ""}`}
                    onClick={() => { setPairX(c.axisX); setPairY(c.axisY); }}
                  >
                    <td className="py-1 px-1.5 whitespace-nowrap">
                      <span className="text-gray-400">{c.axisXLabel}:</span> {c.labelX}
                    </td>
                    <td className="px-1.5 whitespace-nowrap">
                      <span className="text-gray-400">{c.axisYLabel}:</span> {c.labelY}
                    </td>
                    <td className="text-right px-1 text-gray-500">{c.n}</td>
                    <td className={`text-right px-1 font-mono ${colorCls(c.meanFwd)}`}>{pct(c.meanFwd, 2)}</td>
                    <td className="text-right px-1 font-mono text-gray-400">{pct(c.additive, 2)}</td>
                    <td className={`text-right px-1 font-mono font-medium ${colorCls(c.interaction)}`}>{pct(c.interaction, 2)}</td>
                    <td className="text-right px-1 font-mono text-gray-600">{Math.round(c.winRate * 100)}%</td>
                    <td className={`text-right px-1 font-mono ${sig ? "text-blue-600 font-medium" : "text-gray-400"}`}>{c.pAdj.toFixed(3)}{star(c.pAdj)}</td>
                    <td className="text-right px-1.5 font-mono text-gray-600 whitespace-nowrap">
                      {c.ciLo !== null && c.ciHi !== null
                        ? <span className={c.ciLo > 0 || c.ciHi < 0 ? "text-blue-600" : "text-gray-400"}>[{pct(c.ciLo, 2)}, {pct(c.ciHi, 2)}]</span>
                        : <span className="text-gray-300">–</span>}
                    </td>
                    <td className="text-center px-1">{c.isNow ? <span className="text-blue-600 font-bold">●</span> : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-gray-400 mt-1">
          行クリックでそのペアのヒートマップに切替。交互作用CIは|t|上位40セルのみ算出(移動ブロック・ブートストラップ600回)。CIが0をまたがない=相乗が頑健。
        </p>
      </div>

      {/* ペア・ヒートマップ */}
      {activePair && grid && (
        <div>
          <div className="flex flex-wrap items-center gap-2 text-xs mb-1">
            <span className="text-gray-500">ペア・ヒートマップ</span>
            <select className="border rounded px-1 py-0.5" value={activePair.x} onChange={(e) => setPairX(e.target.value as ScanAxis)}>
              {SCAN_AXES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
            <span className="text-gray-400">×</span>
            <select className="border rounded px-1 py-0.5" value={activePair.y} onChange={(e) => setPairY(e.target.value as ScanAxis)}>
              {SCAN_AXES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
            <span className="text-gray-400">
              ｜列={axisLabel(activePair.x)} / 行={axisLabel(activePair.y)}、全体平均 {pct(grid.baseline, 2)}
            </span>
          </div>
          <div className="w-full rounded border border-gray-100 overflow-x-auto overflow-hidden"><canvas ref={heatRef} /></div>
          <p className="text-[10px] text-gray-400 mt-1">
            緑=プラス/赤=マイナス、濃さ=絶対値。★=交互作用のp値(セルが加法予測から乖離)。青枠=現在の状態が属するセル。空白=N不足。
          </p>
        </div>
      )}

      <AnalysisGuide title="条件ペア交互作用スキャナの詳細理論">
        <p className="font-medium text-gray-700">1. この分析は何をしているか</p>
        <p>
          「RSIが売られ過ぎ」「ボラが高い」のような単独条件は既に個別に調べられます。しかし本当のエッジは、
          しばしば<span className="font-medium">2つの条件が同時に成立したときだけ</span>現れます(例: 高ボラ かつ 月曜)。
          本ツールは状態軸の全ペア×全バケットを総当たりし、「掛け合わせで初めて立つ」偏りを検出します。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 交互作用項とは</p>
        <p>
          単純にセル平均が大きいだけでは、「Xが良い」「Yが良い」の単独効果を足しただけかもしれません。
          そこで<span className="font-medium">加法モデルの予測</span>を基準に置きます。
        </p>
        <p>{"加法予測 = (行=Xの周辺平均) + (列=Yの周辺平均) − (総平均)"}</p>
        <p>{"交互作用 = セル平均 − 加法予測"}</p>
        <p>
          交互作用が正で大きいほど、「XとYを重ねると、それぞれ単独から期待される以上に上がる」相乗を意味します。
          料理に例えれば、塩と旨味それぞれの効果を足した以上に、両方入れると美味しくなる——その“余剰”が交互作用です。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 統計的選別</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">t検定:</span> セルの各フォワードリターンから加法予測を引いた値が0と異なるかを検定。有意なら交互作用は偶然でない。</li>
          <li><span className="font-medium">FDR補正(Benjamini-Hochberg):</span> 数百セルを検定するため、p値を全セル横断で補正。p_adj&lt;0.05 を本物候補とする。</li>
          <li><span className="font-medium">ブロック・ブートストラップCI:</span> 系列相関に頑健な交互作用の95%信頼区間。0をまたがなければ頑健。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ランキングは「セル平均」でなく「交互作用」で見る。加法予測とセル平均が近い行は、単独効果の寄せ集めに過ぎない。</li>
          <li>交互作用が大 かつ p_adj&lt;0.05 かつ CIが0をまたがない行が、掛け合わせ固有の頑健なエッジ。</li>
          <li>ヒートマップの青枠=現在の状態セル。今まさにその組合せに居るなら、そのセルの偏りが目先の期待値。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>単独では弱いシグナルでも、有意な交互作用を持つ相手条件でフィルタすると期待値が跳ねる——エントリー条件の絞り込みに使う。</li>
          <li>現在セル(青枠)の偏りとNを見て、「今はどちらに賭けるべきか/様子見か」を即断する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">セルの薄さ:</span> 掛け合わせるとサンプルが急減する。最小Nを上げないと少数の外れ値で交互作用が過大に出る。</li>
          <li><span className="font-medium">過剰適合:</span> 全てイン・サンプル。FDRを通っても将来続く保証はない。ウォークフォワード(後段)で必ず検証する。</li>
          <li><span className="font-medium">2次まで:</span> 3条件以上の高次交互作用は爆発的にセルが薄くなるため対象外。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
