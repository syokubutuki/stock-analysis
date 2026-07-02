"use client";

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import AnalysisGuide from "./AnalysisGuide";
import { stackSignals, STACK_SCHEMES, type StackScheme, type StackResult } from "../../lib/signal-stacking";
import { buildSignalCatalog } from "../../lib/edge-signals";

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

const HEIGHT = 280;

export default function SignalStackingChart({ prices }: Props) {
  const corrRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  const catalog = useMemo(() => buildSignalCatalog(prices), [prices]);
  // null = 未操作(既定=先頭4シグナル)。ユーザーが触ると配列で確定。
  const [selectedRaw, setSelectedRaw] = useState<string[] | null>(null);
  const [scheme, setScheme] = useState<StackScheme>("equal");
  const [agreeK, setAgreeK] = useState(2);
  const [costBps, setCostBps] = useState(5);

  const defaultSel = useMemo(() => catalog.slice(0, Math.min(4, catalog.length)).map((s) => s.id), [catalog]);
  const selected = selectedRaw ?? defaultSel;

  const toggle = (id: string) =>
    setSelectedRaw((prev) => {
      const base = prev ?? defaultSel;
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });

  const result: StackResult | null = useMemo(
    () => (selected.length >= 1 ? stackSignals(prices, { ids: selected, scheme, agreeK, costBps }) : null),
    [prices, selected, scheme, agreeK, costBps],
  );

  // 相関行列ヒートマップ
  const drawCorr = useCallback((canvas: HTMLCanvasElement) => {
    if (!result || result.corr.length < 1) return;
    const { corr, labels } = result;
    const n = corr.length;
    const labelW = 96, headerH = 18;
    const cell = Math.max(26, Math.min(60, Math.floor((canvas.parentElement!.clientWidth - labelW - 6) / n)));
    const totalH = headerH + n * cell + 6;
    const r = initCanvas(canvas, totalH); if (!r) return;
    const { ctx } = r;
    ctx.font = "9px sans-serif";
    for (let j = 0; j < n; j++) {
      ctx.fillStyle = "#6b7280"; ctx.textAlign = "center";
      ctx.fillText(String(j + 1), labelW + j * cell + cell / 2, headerH - 5);
    }
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = "#374151"; ctx.textAlign = "right";
      ctx.fillText(`${i + 1}. ${labels[i].slice(0, 10)}`, labelW - 4, headerH + i * cell + cell / 2 + 3);
      for (let j = 0; j < n; j++) {
        const v = corr[i][j];
        const t = Math.min(1, Math.abs(v));
        // 正相関=赤(冗長)、負相関=青(分散に有利)
        ctx.fillStyle = v >= 0 ? `rgba(220,38,38,${0.1 + 0.75 * t})` : `rgba(37,99,235,${0.1 + 0.75 * t})`;
        const x = labelW + j * cell, y = headerH + i * cell;
        ctx.fillRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
        ctx.fillStyle = t > 0.5 ? "#fff" : "#374151"; ctx.textAlign = "center";
        ctx.fillText(v.toFixed(2), x + cell / 2, y + cell / 2 + 3);
      }
    }
  }, [result]);

  useEffect(() => { if (corrRef.current) drawCorr(corrRef.current); }, [drawCorr]);

  // エクイティ・チャート初期化
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: HEIGHT,
      crosshair: { mode: 0 },
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;
    seriesRef.current = chart.addSeries(LineSeries, { color: "#2563eb", lineWidth: 2, title: "合成エクイティ" });
    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }); };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null; seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    if (!result) { s.setData([]); return; }
    s.setData(result.combinedEquity.map((p) => ({ time: p.date as Time, value: p.value })));
    chartRef.current?.timeScale().fitContent();
  }, [result]);

  if (prices.length < 260) {
    return <div className="text-xs text-gray-400 p-3">データが不足しています(260営業日以上推奨)。</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">シグナル合成</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          相関の低いエッジを束ねると、単独より滑らかで高シャープなポートフォリオになる(分散効果)。合成の妙味を測る。
        </p>
      </div>

      {/* シグナル選択 */}
      <div className="flex flex-wrap gap-1">
        {catalog.map((s) => (
          <button
            key={s.id}
            onClick={() => toggle(s.id)}
            className={`px-2 py-0.5 text-xs rounded font-medium ${selected.includes(s.id) ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* 方式 */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          合成方式
          <select className="border rounded px-1 py-0.5" value={scheme} onChange={(e) => setScheme(e.target.value as StackScheme)}>
            {STACK_SCHEMES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        {scheme === "agreement" && (
          <label className="flex items-center gap-1">
            合意数 k
            <select className="border rounded px-1 py-0.5" value={agreeK} onChange={(e) => setAgreeK(Number(e.target.value))}>
              {Array.from({ length: Math.max(1, selected.length) }, (_, i) => i + 1).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <span className="text-gray-400">/ {selected.length}</span>
          </label>
        )}
        <label className="flex items-center gap-1">
          コスト
          <input type="range" min={0} max={20} step={1} value={costBps} onChange={(e) => setCostBps(Number(e.target.value))} />
          <span className="font-mono w-10">{costBps}bps</span>
        </label>
      </div>

      {!result ? (
        <div className="text-xs text-gray-400">シグナルを1つ以上選んでください。</div>
      ) : (
        <>
          {/* 指標 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2">
              <div className="text-[10px] text-blue-500">合成シャープ(年率)</div>
              <div className="text-base font-bold font-mono text-blue-700">{result.combinedSharpe.toFixed(2)}</div>
              <div className="text-[10px] text-gray-500">最良単独 {result.bestSingleSharpe.toFixed(2)}</div>
            </div>
            <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2">
              <div className="text-[10px] text-gray-500">年率リターン</div>
              <div className="text-base font-bold font-mono text-gray-700">{(result.combinedAnnReturn * 100).toFixed(1)}%</div>
            </div>
            <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2">
              <div className="text-[10px] text-gray-500">最大DD</div>
              <div className="text-base font-bold font-mono text-red-600">{(result.combinedMaxDD * 100).toFixed(1)}%</div>
            </div>
            <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2">
              <div className="text-[10px] text-gray-500">分散化比率</div>
              <div className="text-base font-bold font-mono text-gray-700">{result.diversification.toFixed(2)}</div>
              <div className="text-[10px] text-gray-500">稼働 {(result.combinedExposure * 100).toFixed(0)}%</div>
            </div>
          </div>

          {/* 相関行列 */}
          <div>
            <div className="text-xs text-gray-500 mb-1">シグナル間の相関(赤=正で冗長 / 青=負で分散に有利)</div>
            <div className="w-full rounded border border-gray-100 overflow-x-auto overflow-hidden"><canvas ref={corrRef} /></div>
          </div>

          {/* 合成エクイティ */}
          <div>
            <div className="text-xs text-gray-500 mb-1">合成エクイティ({STACK_SCHEMES.find((s) => s.value === scheme)?.label}、コスト{costBps}bps)</div>
            <div ref={containerRef} className="w-full rounded border border-gray-100" />
          </div>

          {/* 内訳表 */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-1.5">#</th>
                  <th className="text-left px-1.5">シグナル</th>
                  <th className="text-right px-1">単独Sharpe</th>
                  <th className="text-right px-1">年率</th>
                  <th className="text-right px-1">加重</th>
                  <th className="text-right px-1.5">貢献(除外時Δ)</th>
                </tr>
              </thead>
              <tbody>
                {result.perSignal.map((p, i) => (
                  <tr key={p.id} className="border-b border-gray-100">
                    <td className="py-1 px-1.5 text-gray-400">{i + 1}</td>
                    <td className="px-1.5">{p.label}</td>
                    <td className={`text-right px-1 font-mono ${p.sharpe > 0 ? "text-green-600" : "text-red-600"}`}>{p.sharpe.toFixed(2)}</td>
                    <td className="text-right px-1 font-mono text-gray-600">{(p.annReturn * 100).toFixed(1)}%</td>
                    <td className="text-right px-1 font-mono text-gray-600">{scheme === "agreement" ? "–" : (p.weight * 100).toFixed(0) + "%"}</td>
                    <td className={`text-right px-1.5 font-mono ${p.looDelta > 0 ? "text-blue-600 font-medium" : "text-gray-400"}`}>{p.looDelta >= 0 ? "+" : ""}{p.looDelta.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-gray-400">
            貢献=そのシグナルを外したときの合成シャープの低下幅。正で大=合成に不可欠。負=むしろ足を引っ張っている(外すと改善)。
          </p>
        </>
      )}

      <AnalysisGuide title="シグナル合成の詳細理論">
        <p className="font-medium text-gray-700">1. なぜ束ねるのか</p>
        <p>
          単独のエッジは、当たる時期と外す時期のムラが大きい。しかし<span className="font-medium">値動きの相関が低い</span>複数のエッジを
          組み合わせると、片方が沈む時にもう片方が支え、合計のブレ(リスク)が単純平均より小さくなります。同じリターンでもブレが減れば
          シャープ比(リスク当たり収益)が上がる——これが分散効果です。卵を1つの籠に盛らない、の統計版です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 3つの合成方式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">等加重:</span> 各シグナルの建玉を同じ重みで平均。最も素朴で頑健。</li>
          <li><span className="font-medium">逆分散加重:</span> ボラの低い(安定した)シグナルほど重みを厚くする。{"w_s ∝ 1/分散_s"}。少数の暴れ玉に振り回されにくい。</li>
          <li><span className="font-medium">k-of-n 合意:</span> n個中k個以上が同じ方向を向いたときだけフル建てし、それ以外は様子見。多数決フィルタで質の高いエントリーだけ拾う。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 指標の計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">相関行列:</span> シグナル間の日次リターン相関。青(負相関)が多いほど分散効果が大きい。赤(正相関)同士は冗長で、束ねてもリスクが減りにくい。</li>
          <li><span className="font-medium">分散化比率:</span> {"(Σ wₛσₛ) / σ_合成"}。1なら分散効果ゼロ、大きいほど相殺が効いている。</li>
          <li><span className="font-medium">貢献(Leave-One-Out):</span> そのシグナルを外したときの合成シャープの低下幅。正で大きいほど不可欠、負なら足を引っ張っている。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>合成シャープが「最良単独」を上回っていれば、束ねる価値がある。下回るなら、冗長・逆効果なシグナルが混ざっている。</li>
          <li>相関行列で青の多いペアを中心に選ぶと合成シャープが伸びやすい。</li>
          <li>貢献がマイナスのシグナルは外す。合意方式では k を上げると稼働率が下がる代わりに1トレードの質が上がる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>相関の低いエッジを2〜4本束ね、最大DDを抑えつつシャープを底上げした実運用ポートフォリオを組む。</li>
          <li>貢献表で「効いている本数」を絞り込み、回転・コストを抑える。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">相関は不安定:</span> 過去の相関は暴落時に一斉に1へ近づき(分散効果の消滅)、平時の推定は楽観的になりがち。</li>
          <li><span className="font-medium">加重の過剰最適化:</span> 逆分散加重も過去データ依存。ウォークフォワード(C)で束ね方の頑健性を必ず確認する。</li>
          <li><span className="font-medium">コスト:</span> 連続加重は建玉が細かく動きコストが嵩む。コストbpsを上げて実効シャープの残りを見る。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
