"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode } from "../../lib/series-mode";
import {
  computeWeeklyPhaseAttractor,
  computeRecurrenceLagProfile,
  computeWeeklySpectrum,
  computeRollingPL,
  computePhaseAugmentedSimplex,
  computeWeeklyPhaseKM,
  PhaseMode,
  PHASE_MODE_LABELS,
  WEEKDAY_LABELS,
  WEEKDAY_COLORS,
} from "../../lib/weekly-phase-attractor";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

export default function WeeklyPhaseAttractorChart({ prices, seriesMode }: Props) {
  const [tau, setTau] = useState(2);
  const [dim, setDim] = useState<2 | 3>(2);
  const [phaseMode, setPhaseMode] = useState<PhaseMode>("calendar");
  const [phaseWeight, setPhaseWeight] = useState(1);
  const [seed, setSeed] = useState(0); // サロゲート再抽選トリガ

  const scatterRef = useRef<HTMLCanvasElement>(null);
  const surroRef = useRef<HTMLCanvasElement>(null);
  const lagRef = useRef<HTMLCanvasElement>(null);
  const specRef = useRef<HTMLCanvasElement>(null);
  const rollRef = useRef<HTMLCanvasElement>(null);

  const result = useMemo(
    () => computeWeeklyPhaseAttractor(prices, seriesMode, { tau, dim, phaseMode }),
    // seed を依存に含めてサロゲートを引き直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prices, seriesMode, tau, dim, phaseMode, seed]
  );

  const significant = result.ok && result.PL > result.surrogateQ95;

  // フェーズ2: 裏取り
  const lagResult = useMemo(
    () => computeRecurrenceLagProfile(prices, seriesMode, { tau, dim, phaseMode }),
    [prices, seriesMode, tau, dim, phaseMode]
  );
  const spectrumResult = useMemo(
    () => computeWeeklySpectrum(prices, seriesMode),
    [prices, seriesMode]
  );

  // フェーズ3: ローリングPL(t) — 窓ごとサロゲートで有意性判定
  const rollResult = useMemo(
    () =>
      result.ok
        ? computeRollingPL(prices, seriesMode, {
            tau,
            dim,
            phaseMode,
            globalThreshold: result.surrogateQ95,
          })
        : null,
    [prices, seriesMode, tau, dim, phaseMode, result]
  );

  // 曜日条件付き KM (週次位相のドリフト/拡散/累積経路)
  const kmResult = useMemo(
    () => computeWeeklyPhaseKM(prices, phaseMode),
    [prices, phaseMode]
  );

  // フェーズ3-E: 位相つき Simplex 予測スキル比較
  const simplexResult = useMemo(
    () =>
      computePhaseAugmentedSimplex(prices, seriesMode, { tau, dim, phaseMode, phaseWeight }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prices, seriesMode, tau, dim, phaseMode, phaseWeight, seed]
  );

  // 散布図 + 重心巡回パス
  useEffect(() => {
    const canvas = scatterRef.current;
    if (!canvas || !result.ok) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = Math.min(parent.clientWidth - 16, 560);
    const height = 360;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const margin = 40;
    const xs = result.points.map((p) => p.x);
    const ys = result.points.map((p) => p.y);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const xr = xMax - xMin || 1, yr = yMax - yMin || 1;
    const sx = (x: number) => margin + ((x - xMin) / xr) * (width - margin * 2);
    const sy = (y: number) => height - margin - ((y - yMin) / yr) * (height - margin * 2);

    // 軸
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.strokeRect(margin, margin, width - margin * 2, height - margin * 2);
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    ctx.fillText("r(t)", width - margin - 24, height - margin + 14);
    ctx.save();
    ctx.translate(margin - 14, margin + 24);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`r(t-${tau})`, 0, 0);
    ctx.restore();

    // 全点
    for (const p of result.points) {
      ctx.fillStyle = WEEKDAY_COLORS[p.phase] + "66";
      ctx.beginPath();
      ctx.arc(sx(p.x), sy(p.y), 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 重心巡回パス (月→火→…→金→月)
    const present = result.centroids2d
      .map((c, k) => ({ c, k }))
      .filter((o) => !isNaN(o.c.x));
    if (present.length >= 2) {
      ctx.strokeStyle = "#374151";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      present.forEach((o, idx) => {
        const px = sx(o.c.x), py = sy(o.c.y);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      // 閉じる
      ctx.lineTo(sx(present[0].c.x), sy(present[0].c.y));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 重心ノード
    for (const o of present) {
      const px = sx(o.c.x), py = sy(o.c.y);
      ctx.fillStyle = WEEKDAY_COLORS[o.k];
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 9px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(WEEKDAY_LABELS[o.k], px, py);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
  }, [result, tau]);

  // サロゲート帰無分布ヒストグラム
  useEffect(() => {
    const canvas = surroRef.current;
    if (!canvas || !result.ok) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = Math.min(parent.clientWidth - 16, 560);
    const height = 200;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const margin = 36;
    const all = [...result.surrogatePL, result.PL];
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const range = hi - lo || 1;
    const nBins = 40;
    const bins = new Array(nBins).fill(0);
    for (const v of result.surrogatePL) {
      const b = Math.min(nBins - 1, Math.floor(((v - lo) / range) * nBins));
      bins[b]++;
    }
    const maxBin = Math.max(...bins, 1);
    const px = (v: number) => margin + ((v - lo) / range) * (width - margin * 2);
    const barW = (width - margin * 2) / nBins;

    // バー
    ctx.fillStyle = "#cbd5e1";
    for (let i = 0; i < nBins; i++) {
      const h = (bins[i] / maxBin) * (height - margin * 2);
      ctx.fillRect(margin + i * barW, height - margin - h, barW - 0.5, h);
    }
    // 軸線
    ctx.strokeStyle = "#e5e7eb";
    ctx.beginPath();
    ctx.moveTo(margin, height - margin);
    ctx.lineTo(width - margin, height - margin);
    ctx.stroke();

    // 95%閾値
    const q = px(result.surrogateQ95);
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(q, margin - 6);
    ctx.lineTo(q, height - margin);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#d97706";
    ctx.font = "9px sans-serif";
    ctx.fillText("95%閾値", q + 3, margin + 4);

    // 観測PL
    const o = px(result.PL);
    ctx.strokeStyle = significant ? "#dc2626" : "#6b7280";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(o, margin - 6);
    ctx.lineTo(o, height - margin);
    ctx.stroke();
    ctx.fillStyle = significant ? "#dc2626" : "#6b7280";
    ctx.font = "bold 10px sans-serif";
    const label = `観測PL=${result.PL.toFixed(2)}`;
    const lw = ctx.measureText(label).width;
    ctx.fillText(label, Math.min(o + 4, width - margin - lw), margin + 14);

    // X軸ラベル
    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px sans-serif";
    ctx.fillText(lo.toFixed(2), margin, height - margin + 12);
    ctx.fillText(hi.toFixed(2), width - margin - 20, height - margin + 12);
    ctx.fillText("← サロゲート(曜日シャッフル)のF比分布", margin, 14);
  }, [result, significant]);

  // フェーズ2-a: リカレンスのラグ構造 RR(ℓ)
  useEffect(() => {
    const canvas = lagRef.current;
    if (!canvas || !lagResult.ok) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = Math.min(parent.clientWidth - 16, 560);
    const height = 200;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const margin = 36;
    const n = lagResult.rr.length;
    const maxRR = Math.max(...lagResult.rr, lagResult.baselineRR) || 1;
    const barW = (width - margin * 2) / n;
    const meanRR = lagResult.rr.reduce((a, b) => a + b, 0) / n;

    for (let i = 0; i < n; i++) {
      const lag = lagResult.lags[i];
      const h = (lagResult.rr[i] / maxRR) * (height - margin * 2);
      ctx.fillStyle = lag % 5 === 0 ? "#dc2626" : "#cbd5e1";
      ctx.fillRect(margin + i * barW, height - margin - h, barW - 1, h);
      if (lag % 5 === 0) {
        ctx.fillStyle = "#9ca3af";
        ctx.font = "8px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(`${lag}`, margin + i * barW + barW / 2, height - margin + 10);
        ctx.textAlign = "left";
      }
    }
    // 平均線
    const my = height - margin - (meanRR / maxRR) * (height - margin * 2);
    ctx.strokeStyle = "#6b7280";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(margin, my);
    ctx.lineTo(width - margin, my);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#6b7280";
    ctx.font = "9px sans-serif";
    ctx.fillText("平均", width - margin - 22, my - 3);
    ctx.fillStyle = "#9ca3af";
    ctx.fillText("RR(ℓ): ラグℓのリカレンス率 (赤=週次ラグ5,10,15…)", margin, 14);
  }, [lagResult]);

  // フェーズ2-b: Lomb-Scargle スペクトル (短周期域)
  useEffect(() => {
    const canvas = specRef.current;
    if (!canvas || !spectrumResult.ok) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = Math.min(parent.clientWidth - 16, 560);
    const height = 200;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const margin = 36;
    // 短周期域 2〜30営業日に絞る
    const pts = spectrumResult.spectrum
      .filter((p) => p.period >= 2 && p.period <= 30)
      .sort((a, b) => a.period - b.period);
    if (pts.length < 2) return;
    const pMin = 2, pMax = 30;
    const maxPow = Math.max(...pts.map((p) => p.power), 3) || 1;
    const sx = (period: number) =>
      margin + ((period - pMin) / (pMax - pMin)) * (width - margin * 2);
    const sy = (pow: number) => height - margin - (pow / maxPow) * (height - margin * 2);

    // 周期5の縦線
    ctx.strokeStyle = "#16a34a";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(sx(5), margin - 6);
    ctx.lineTo(sx(5), height - margin);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#16a34a";
    ctx.font = "9px sans-serif";
    ctx.fillText("周期5(週)", sx(5) + 3, margin + 4);

    // スペクトル線
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = sx(p.period), y = sy(p.power);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // X軸目盛
    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    [2, 5, 10, 21, 30].forEach((p) => {
      ctx.fillText(`${p}`, sx(p), height - margin + 12);
    });
    ctx.textAlign = "left";
    ctx.fillText("Lomb-Scargle パワー vs 周期(営業日)", margin, 14);
  }, [spectrumResult]);

  // フェーズ3: ローリングPL(t)
  useEffect(() => {
    const canvas = rollRef.current;
    if (!canvas || !rollResult || !rollResult.ok || rollResult.points.length < 2) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = Math.min(parent.clientWidth - 16, 560);
    const height = 200;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const margin = 36;
    const pts = rollResult.points;
    const n = pts.length;
    const maxPL =
      Math.max(...pts.map((p) => Math.max(p.PL, p.threshold)), rollResult.globalThreshold) || 1;
    const sx = (i: number) => margin + (i / (n - 1)) * (width - margin * 2);
    const sy = (pl: number) => height - margin - (pl / maxPL) * (height - margin * 2);

    // 窓ごと95%閾値 (薄いグレー線)
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = sx(i), y = sy(p.threshold);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // PL(t)
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = sx(i), y = sy(p.PL);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // 窓ごと有意の点を強調
    for (let i = 0; i < n; i++) {
      if (pts[i].significant) {
        ctx.fillStyle = "#dc2626";
        ctx.beginPath();
        ctx.arc(sx(i), sy(pts[i].PL), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px sans-serif";
    ctx.fillText(pts[0].time, margin, height - margin + 12);
    ctx.textAlign = "right";
    ctx.fillText(pts[n - 1].time, width - margin, height - margin + 12);
    ctx.textAlign = "left";
    ctx.fillText(`ローリングPL(t) 窓=${rollResult.window}日 (赤=窓ごと有意=チルト有効 / 灰=窓ごと95%閾値)`, margin, 14);
  }, [rollResult]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">週内位相アトラクタ (動力学的週内アノマリー)</h3>
      <p className="text-xs text-gray-500 mb-3">
        Takens埋め込み空間で軌道が週次位相(曜日)にロックしているか — 平均の差ではなく軌道の幾何 — を検証
      </p>

      {/* Controls */}
      <div className="flex flex-wrap gap-4 mb-3 items-end text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">遅延 {"τ"} = {tau}</span>
          <input type="range" min={1} max={5} value={tau}
            onChange={(e) => setTau(Number(e.target.value))} className="w-28 accent-blue-600" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">次元</span>
          <div className="flex gap-1">
            {([2, 3] as const).map((d) => (
              <button key={d} onClick={() => setDim(d)}
                className={`px-3 py-1 rounded text-xs font-medium ${dim === d ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                {d}D
              </button>
            ))}
          </div>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">位相の定義</span>
          <div className="flex gap-1">
            {(Object.keys(PHASE_MODE_LABELS) as PhaseMode[]).map((pm) => (
              <button key={pm} onClick={() => setPhaseMode(pm)}
                className={`px-3 py-1 rounded text-xs font-medium ${phaseMode === pm ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                {PHASE_MODE_LABELS[pm]}
              </button>
            ))}
          </div>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">位相座標の重み = {phaseWeight.toFixed(1)}</span>
          <input type="range" min={0} max={3} step={0.1} value={phaseWeight}
            onChange={(e) => setPhaseWeight(Number(e.target.value))} className="w-28 accent-blue-600" />
        </label>
        <button onClick={() => setSeed((s) => s + 1)}
          className="px-2 py-1 rounded text-xs text-gray-500 bg-gray-100 hover:bg-gray-200">
          サロゲート再抽選
        </button>
      </div>

      {!result.ok ? (
        <div className="text-sm text-gray-500 py-8 text-center">
          {result.message ?? "計算できませんでした"}
        </div>
      ) : (
        <>
          {/* 判定 */}
          <div className={`mb-3 rounded border p-3 text-sm ${significant ? "bg-red-50 border-red-200" : "bg-gray-50 border-gray-200"}`}>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
              <span className={`font-bold ${significant ? "text-red-700" : "text-gray-600"}`}>
                {significant ? "週次位相ロック: 有意" : "週次位相ロック: 非有意"}
              </span>
              <span className="text-gray-600">PL(F比) = <b>{result.PL.toFixed(3)}</b></span>
              <span className="text-gray-600">95%閾値 = {result.surrogateQ95.toFixed(3)}</span>
              <span className="text-gray-600">
                p値 = <b>{result.pValue.toFixed(4)}</b>
              </span>
              <span className="text-gray-400 text-xs">n={result.n}, サロゲート={result.surrogatePL.length}</span>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {significant
                ? "観測F比がサロゲート(曜日ランダム)の95%を超過。曜日整合は自己相関だけでは説明できない。"
                : "観測F比がサロゲートの範囲内。週次位相ロックの証拠は乏しい(=テクニカルにはトレード不可)。"}
            </p>
          </div>

          {/* 散布図 */}
          <div className="flex justify-center">
            <canvas ref={scatterRef} className="rounded border border-gray-200" />
          </div>
          {/* 凡例 */}
          <div className="mt-2 flex items-center justify-center gap-3 text-xs text-gray-600">
            {WEEKDAY_LABELS.map((l, k) => (
              <span key={k} className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-full" style={{ background: WEEKDAY_COLORS[k] }} />
                {l}
              </span>
            ))}
            <span className="text-gray-400">(大きい点=曜日重心 / 破線=巡回パス)</span>
          </div>

          {/* サロゲートヒストグラム */}
          <div className="flex justify-center mt-4">
            <canvas ref={surroRef} className="rounded border border-gray-200" />
          </div>

          {/* 曜日別統計テーブル */}
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-xs text-center border-collapse">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="py-1 px-2 text-left">曜日</th>
                  <th className="py-1 px-2">点数</th>
                  <th className="py-1 px-2">重心 r(t)</th>
                  <th className="py-1 px-2">重心 r(t-{tau})</th>
                  <th className="py-1 px-2">ストロボ分散比</th>
                </tr>
              </thead>
              <tbody>
                {result.weekdayStats.map((w, k) => (
                  <tr key={k} className="border-b border-gray-100">
                    <td className="py-1 px-2 text-left">
                      <span className="inline-block w-2.5 h-2.5 rounded-full mr-1 align-middle" style={{ background: w.color }} />
                      {w.label}
                    </td>
                    <td className="py-1 px-2">{w.count}</td>
                    <td className="py-1 px-2 font-mono">{w.count > 0 ? w.centroid[0].toExponential(2) : "—"}</td>
                    <td className="py-1 px-2 font-mono">{w.count > 0 ? w.centroid[1].toExponential(2) : "—"}</td>
                    <td className={`py-1 px-2 font-mono ${!isNaN(w.dispersionRatio) && w.dispersionRatio < 0.95 ? "text-red-600 font-bold" : ""}`}>
                      {isNaN(w.dispersionRatio) ? "—" : w.dispersionRatio.toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[10px] text-gray-400 mt-1">
              ストロボ分散比 = 曜日内平均分散 / 全体平均分散。&lt;1 (赤) なら全体より集中 = その曜日が不動点的(ボラ季節性・位相ロックの兆候)。
            </p>
          </div>

          {/* フェーズ2: 裏取り */}
          <div className="mt-6 pt-4 border-t border-gray-200">
            <h4 className="font-semibold text-gray-700 text-sm mb-2">裏取り (独立な証拠)</h4>

            <div className="text-xs text-gray-600 mb-1">
              リカレンスのラグ構造 —{" "}
              {lagResult.ok ? (
                <span className={lagResult.weeklyPeak ? "text-red-600 font-bold" : "text-gray-500"}>
                  {lagResult.weeklyPeak ? "ラグ5にピークあり(週次再帰)" : "ラグ5に明確なピークなし"}
                </span>
              ) : (
                "—"
              )}
            </div>
            <div className="flex justify-center">
              <canvas ref={lagRef} className="rounded border border-gray-200" />
            </div>

            <div className="text-xs text-gray-600 mt-4 mb-1">
              Lomb-Scargle 周期検定 —{" "}
              {spectrumResult.ok ? (
                <span className={spectrumResult.weeklyPeak && spectrumResult.weeklyPeak.fap < 0.05 ? "text-red-600 font-bold" : "text-gray-500"}>
                  {spectrumResult.interpretation}
                </span>
              ) : (
                "—"
              )}
            </div>
            <div className="flex justify-center">
              <canvas ref={specRef} className="rounded border border-gray-200" />
            </div>
          </div>

          {/* フェーズ3: 非定常監視 */}
          <div className="mt-6 pt-4 border-t border-gray-200">
            <h4 className="font-semibold text-gray-700 text-sm mb-2">
              ローリング位相ロック (非定常監視 / メタゲート)
            </h4>
            {rollResult && rollResult.ok ? (
              <>
                <p className="text-xs text-gray-600 mb-1">
                  窓ごと有意の期間割合 = <b>{(rollResult.aboveRatio * 100).toFixed(1)}%</b>
                  <span className="text-gray-400">
                    {" "}— 各窓を自分のサロゲートで検定。有意な期間だけ曜日チルトを有効化(メタゲート)
                  </span>
                </p>
                <div className="flex justify-center">
                  <canvas ref={rollRef} className="rounded border border-gray-200" />
                </div>
                <p className="text-[10px] text-gray-400 mt-1">
                  全期間で有意でも、位相ロックは出現/消滅を繰り返す(非定常)。常時ではなく閾値超の窓でのみ運用する。
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-500 py-4 text-center">
                ローリングに必要なデータが不足しています
              </p>
            )}
          </div>

          {/* フェーズ3-E: 位相つき予測スキル */}
          <div className="mt-6 pt-4 border-t border-gray-200">
            <h4 className="font-semibold text-gray-700 text-sm mb-2">
              位相つき Simplex 予測 (週内構造はトレードに効くか)
            </h4>
            {simplexResult.ok ? (
              <>
                <div className={`rounded border p-3 text-sm mb-2 ${simplexResult.improves ? "bg-red-50 border-red-200" : "bg-gray-50 border-gray-200"}`}>
                  <span className={`font-bold ${simplexResult.improves ? "text-red-700" : "text-gray-600"}`}>
                    {simplexResult.improves ? "週内位相が予測を改善: 効く" : "週内位相による予測改善: なし"}
                  </span>
                  <span className="text-gray-600 ml-3">
                    Δρ = <b>{simplexResult.deltaRho >= 0 ? "+" : ""}{simplexResult.deltaRho.toFixed(4)}</b>
                  </span>
                </div>
                <table className="w-full text-xs text-center border-collapse">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="py-1 px-2 text-left">モデル</th>
                      <th className="py-1 px-2">予測スキル ρ</th>
                      <th className="py-1 px-2">方向的中率</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-gray-100">
                      <td className="py-1 px-2 text-left">埋め込みのみ (ベースライン)</td>
                      <td className="py-1 px-2 font-mono">{simplexResult.rhoBase.toFixed(4)}</td>
                      <td className="py-1 px-2 font-mono">{(simplexResult.dirBase * 100).toFixed(1)}%</td>
                    </tr>
                    <tr className="border-b border-gray-100">
                      <td className="py-1 px-2 text-left font-medium">埋め込み + 週次位相</td>
                      <td className={`py-1 px-2 font-mono ${simplexResult.improves ? "text-red-600 font-bold" : ""}`}>{simplexResult.rhoAug.toFixed(4)}</td>
                      <td className="py-1 px-2 font-mono">{(simplexResult.dirAug * 100).toFixed(1)}%</td>
                    </tr>
                    <tr className="border-b border-gray-100 text-gray-400">
                      <td className="py-1 px-2 text-left">位相シャッフル対照</td>
                      <td className="py-1 px-2 font-mono">{simplexResult.rhoShuffled.toFixed(4)}</td>
                      <td className="py-1 px-2">—</td>
                    </tr>
                  </tbody>
                </table>
                <p className="text-[10px] text-gray-400 mt-1">
                  位相つきρが ベースライン と 位相シャッフル対照 の両方を上回って初めて「効く」。
                  対照を超えない改善は座標追加の見かけ。位相座標の重みスライダーで感度を確認。
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-500 py-4 text-center">{simplexResult.message ?? "計算不可"}</p>
            )}
          </div>

          {/* 曜日条件付き KM: トレード適用 */}
          <div className="mt-6 pt-4 border-t border-gray-200">
            <h4 className="font-semibold text-gray-700 text-sm mb-2">
              曜日条件付き Kramers-Moyal (トレード適用: リスク季節性 & 方向バイアス)
            </h4>
            {kmResult.ok ? (
              <>
                <table className="w-full text-xs text-center border-collapse">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="py-1 px-2 text-left">曜日</th>
                      <th className="py-1 px-2">点数</th>
                      <th className="py-1 px-2">ドリフト μ (日次)</th>
                      <th className="py-1 px-2">拡散 σ (ボラ)</th>
                      <th className="py-1 px-2">週内累積</th>
                    </tr>
                  </thead>
                  <tbody>
                    {WEEKDAY_LABELS.map((l, k) => (
                      <tr key={k} className="border-b border-gray-100">
                        <td className="py-1 px-2 text-left">
                          <span className="inline-block w-2.5 h-2.5 rounded-full mr-1 align-middle" style={{ background: WEEKDAY_COLORS[k] }} />
                          {l}
                        </td>
                        <td className="py-1 px-2">{kmResult.counts[k]}</td>
                        <td className={`py-1 px-2 font-mono ${kmResult.drift[k] >= 0 ? "text-green-600" : "text-red-600"}`}>
                          {(kmResult.drift[k] * 100).toFixed(3)}%
                        </td>
                        <td className={`py-1 px-2 font-mono ${k === kmResult.highVolPhase ? "text-red-600 font-bold" : k === kmResult.lowVolPhase ? "text-blue-600" : ""}`}>
                          {(kmResult.diffusion[k] * 100).toFixed(3)}%
                        </td>
                        <td className={`py-1 px-2 font-mono ${k === kmResult.entryPhase ? "text-blue-600 font-bold" : k === kmResult.exitPhase ? "text-green-600 font-bold" : ""}`}>
                          {(kmResult.cumulative[k] * 100).toFixed(3)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs text-gray-600">
                  <p>
                    <b>リスク季節性 (§6.1, 最も堅い)</b>: 高ボラ曜日 =
                    <span className="text-red-600 font-bold"> {WEEKDAY_LABELS[kmResult.highVolPhase]}</span>
                    → サイズ/ストップ縮小。低ボラ =
                    <span className="text-blue-600 font-bold"> {WEEKDAY_LABELS[kmResult.lowVolPhase]}</span>。
                  </p>
                  <p>
                    <b>方向バイアス (§6.3, 弱い修飾子)</b>: 累積の谷 =
                    <span className="text-blue-600 font-bold"> {WEEKDAY_LABELS[kmResult.entryPhase]}</span>
                    (積み増し候補) / ピーク =
                    <span className="text-green-600 font-bold"> {WEEKDAY_LABELS[kmResult.exitPhase]}</span>
                    (軽量化候補)。
                  </p>
                </div>
                <p className="text-[10px] text-gray-400 mt-1">
                  週次位相 φ(曜日) を状態変数とした KM。ドリフト μ(φ)=曜日別平均リターン、拡散 σ(φ)=曜日別ボラ。
                  累積=月から金への μ の累積。方向バイアスはローリングPLが有意な期間のみ適用すること(メタゲート)。
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-500 py-4 text-center">{kmResult.message ?? "計算不可"}</p>
            )}
          </div>

          <AnalysisGuide title="週内位相アトラクタの詳細理論">
            <p className="font-medium text-gray-700">1. 何を検証しているか</p>
            <p>
              曜日アノマリー(「月曜は平均リターンが低い」等の1次モーメントの差)ではなく、
              <b>位相空間上の軌道の幾何</b>が取引週(5営業日)に同期しているかを検証します。
              株価リターンを週次クロックで周期駆動された力学系
              {" dx/dt = F(x, φ(t)) "}とみなし、ドリフト F が週次位相 φ(=曜日) に依存するか
              ——すなわち軌道が周期5の<b>リミットサイクル(閉軌道)</b>の骨格を持つか——を問います。
            </p>

            <p className="font-medium text-gray-700 mt-3">2. 数式</p>
            <p>{"埋め込みベクトル v(t) = ( r(t), r(t-τ), … , r(t-(m-1)τ) )"}</p>
            <p>{"曜日 k の重心 μ_k = (1/n_k) Σ_{φ(t)=k} v(t)、全体重心 μ̄"}</p>
            <p>{"曜日間平方和 S_between = Σ_k n_k ‖μ_k − μ̄‖²"}</p>
            <p>{"曜日内平方和 S_within = Σ_k Σ_{φ(t)=k} ‖v(t) − μ_k‖²"}</p>
            <p>{"位相ロック統計量 PL = [S_between/(K−1)] / [S_within/(N−K)]   (K=5)"}</p>
            <p>これは位相空間版の一元配置分散分析の F 比です。PL が大きいほど同一曜日が位相空間で塊になる=位相ロック。</p>

            <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><b>位相ロック</b>: 系の状態が外部の周期(ここでは曜日サイクル)に同期して動くこと。信号機に合わせて車の流れが周期化するイメージ。</li>
              <li><b>リミットサイクル</b>: 力学系が引き込まれる閉じた周期軌道。重心が月→火→…→金→月と環状に並べば、その骨格。</li>
              <li><b>ストロボ写像(週次ポアンカレ断面)</b>: 毎週同じ曜日で1点だけ抜き出す操作。クリーンな週次サイクルなら抜いた点は1点に収束する。</li>
              <li><b>サロゲート</b>: 帰無仮説のもとで生成した擬似データ。ここでは曜日ラベルをシャッフルし、埋め込み幾何・自己相関は保持したまま曜日整合だけ破壊する。</li>
              <li><b>位相の定義</b>: 「実曜日」=カレンダー上の曜日。「営業日位相」=系列先頭に揃え1営業日ごとに+1する5周期(祝日リセット無視)。動力学モデルに忠実なのは後者、外生カレンダー要因の検証には前者。</li>
            </ul>

            <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
            <p>
              位相ロックは「信号機に同期した車の流れ」。信号(曜日)に合わせて車群(価格状態)が同じ場所・同じタイミングを周期的に通るなら、
              次にどこへ行くか読める。逆に車がバラバラに走っていれば(=雲状)、曜日は何の手がかりにもならない。
            </p>

            <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><b>散布図</b>: 同色(同曜日)が固まり、重心(大きい点)が環状の巡回パスを描けば週次サイクルの骨格。一様な雲なら構造なし。</li>
              <li><b>サロゲート分布</b>: 観測PL(赤/灰の縦線)が95%閾値(橙破線)の右にあれば有意。p値&lt;0.05が目安。</li>
              <li><b>ストロボ分散比</b>: 曜日別の集中度。&lt;1の曜日はその曜日の状態が特に集中=不動点的(ボラ季節性の兆候)。</li>
              <li><b>リカレンスのラグ構造</b>: RR(ℓ)がラグ5・10・15(赤)で平均より突出すれば週次の再帰=独立な傍証。</li>
              <li><b>Lomb-Scargle</b>: 周期5(緑線)にピーク&FAP&lt;5%なら週次の正弦的周期成分が有意。散布・サロゲートと別原理の裏取り。</li>
              <li><b>ローリングPL(t)</b>: 全期間有意でも位相ロックは出没する(非定常)。各窓を<b>窓ごとサロゲート</b>で検定し、有意な窓(赤点)だけ運用するのがメタゲート。灰線は窓ごと95%閾値。</li>
              <li><b>位相つきSimplex</b>: 埋め込み座標に週次位相 (cos,sin) を足して予測スキルρが上がるか。ベースライン<b>と</b>位相シャッフル対照の両方を上回れば「週内構造はトレードに効く」最終確認。改善ゼロなら構造があっても予測には使えない(リスク/執行タイミングのみ)。</li>
              <li><b>曜日条件付きKM</b>: 拡散σ(φ)の高い曜日はサイズ縮小(§6.1, 最も堅い)。累積の谷曜日で積み増し・ピーク曜日で軽量化(§6.3)。ただし方向はローリングPLが有意な期間のみ。</li>
            </ul>

            <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><b>位相条件付きリスク(最も堅い)</b>: ストロボ分散比が高い曜日はサイズ/ストップを縮小。リターン季節性よりボラ季節性は持続的。</li>
              <li><b>実行タイミング</b>: 既に決めた建玉を、高ボラ曜日を避けサイクルの谷の曜日で執行。</li>
              <li><b>方向バイアス(弱い修飾子)</b>: 重心パスの谷の曜日で積み増し、ピーク曜日で軽量化。主シグナルへの±の小修正に留める。</li>
              <li><b>メタゲート</b>: ローリングでPLが閾値超の期間だけ曜日チルトを有効化、減衰したら無効化(非定常対策)。</li>
            </ul>

            <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><b>周期5は分解能ギリギリ</b>。{"m·τ ≈ 5"}になるよう{"τ"}を選ぶと週内ループを捉えやすい(既定{"τ=2,m=2–3"})。</li>
              <li><b>外生カレンダー要因との交絡</b>(月曜効果・SQ・先物ロール・雇用統計)。決定論的アトラクタと外生周期駆動の区別はつかない。</li>
              <li><b>非定常</b>。曜日効果は減衰・反転する。全期間集計は誤判定の元——ローリング検証(将来拡張)が必須。</li>
              <li><b>多重検定</b>。複数銘柄・複数設定を試すと偽陽性が増える。サロゲートp値を必ず確認。</li>
              <li><b>期待値</b>。狙うのは強い単独アルファでなく、弱いが安定したバイアス/実行最適化/リスク季節性。</li>
            </ul>
          </AnalysisGuide>
        </>
      )}
    </div>
  );
}
