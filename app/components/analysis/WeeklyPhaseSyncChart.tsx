"use client";

import { useEffect, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  computeWeeklyPhaseSync,
  PhaseSyncResult,
  WEEKDAY_LABELS,
} from "../../lib/weekly-phase-attractor";
import AnalysisGuide from "./AnalysisGuide";

// 既定バスケット: 米セクターETF (同一市場・同一タイムゾーンで週次位相を比較)
const DEFAULT_BASKET = "XLK,XLF,XLE,XLV,XLY,XLP,XLI,XLU,XLB";

export default function WeeklyPhaseSyncChart() {
  const [input, setInput] = useState(DEFAULT_BASKET);
  const [result, setResult] = useState<PhaseSyncResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);

  const circleRef = useRef<HTMLCanvasElement>(null);

  const run = async () => {
    const tickers = input
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tickers.length < 2) {
      setError("2銘柄以上を入力してください");
      return;
    }
    setLoading(true);
    setError(null);
    setFailed([]);
    try {
      const fetched = await Promise.all(
        tickers.map(async (ticker) => {
          try {
            const res = await fetch(`/api/stock?ticker=${encodeURIComponent(ticker)}&range=10y`);
            const json = await res.json();
            if (!res.ok || !json.prices) return { ticker, prices: null as PricePoint[] | null };
            return { ticker, prices: json.prices as PricePoint[] };
          } catch {
            return { ticker, prices: null as PricePoint[] | null };
          }
        })
      );
      const ok = fetched.filter((f) => f.prices && f.prices.length > 100) as {
        ticker: string;
        prices: PricePoint[];
      }[];
      const bad = fetched.filter((f) => !f.prices || f.prices.length <= 100).map((f) => f.ticker);
      setFailed(bad);
      if (ok.length < 2) {
        setError("有効な銘柄が2つ未満でした");
        setResult(null);
        return;
      }
      setResult(computeWeeklyPhaseSync(ok, "calendar"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const canvas = circleRef.current;
    if (!canvas || !result || !result.ok) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const size = Math.min(parent.clientWidth - 16, 420);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);

    const cx = size / 2, cy = size / 2;
    const R = size / 2 - 40;

    // 単位円
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // 曜日の方角ガイド (位相 k → 角度 2πk/5)
    for (let k = 0; k < 5; k++) {
      const ang = (2 * Math.PI * k) / 5;
      const x = cx + Math.cos(ang) * R;
      const y = cy + Math.sin(ang) * R;
      ctx.fillStyle = "#9ca3af";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(WEEKDAY_LABELS[k], cx + Math.cos(ang) * (R + 14), cy + Math.sin(ang) * (R + 14) + 3);
      ctx.strokeStyle = "#f3f4f6";
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.textAlign = "left";

    const maxAmp = Math.max(...result.items.map((i) => i.amplitude), 1e-9);

    // 各銘柄のベクトル
    for (const it of result.items) {
      const rad = 0.3 + 0.65 * (it.amplitude / maxAmp);
      const x = cx + Math.cos(it.preferredPhaseRad) * R * rad;
      const y = cy + Math.sin(it.preferredPhaseRad) * R * rad;
      ctx.strokeStyle = "rgba(37,99,235,0.25)";
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = "#2563eb";
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#1e3a5f";
      ctx.font = "9px monospace";
      ctx.fillText(it.ticker, x + 6, y + 3);
    }

    // 秩序変数(合成ベクトル)
    const rx = cx + Math.cos(result.meanPhaseRad) * R * result.orderParameter;
    const ry = cy + Math.sin(result.meanPhaseRad) * R * result.orderParameter;
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(rx, ry);
    ctx.stroke();
    ctx.fillStyle = "#dc2626";
    ctx.beginPath();
    ctx.arc(rx, ry, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    ctx.fillText("赤=秩序変数(同期度)  青=各銘柄の選好位相", 8, size - 8);
  }, [result]);

  const syncLevel =
    result && result.ok
      ? result.orderParameter > 0.7
        ? "強い同期 (市場全体の週次クロック)"
        : result.orderParameter > 0.4
        ? "中程度の同期"
        : "ほぼ非同期 (個別要因が支配的)"
      : "";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">週次位相同期 (マルチ銘柄 Kuramoto)</h3>
      <p className="text-xs text-gray-500 mb-3">
        複数銘柄の週次選好位相(ピーク曜日)が揃うかを Kuramoto 秩序変数で測定。市場全体の週次クロックか個別要因かを判別
      </p>

      <div className="flex flex-wrap gap-2 mb-3 items-end text-sm">
        <label className="flex flex-col gap-1 flex-1 min-w-[240px]">
          <span className="text-xs text-gray-500">銘柄 (カンマ/空白区切り)</span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="px-2 py-1 border border-gray-300 rounded text-xs font-mono"
            placeholder="XLK,XLF,XLE,..."
          />
        </label>
        <button
          onClick={run}
          disabled={loading}
          className="px-4 py-1.5 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "取得中…" : "取得して計算"}
        </button>
        <button
          onClick={() => setInput(DEFAULT_BASKET)}
          className="px-2 py-1.5 rounded text-xs text-gray-500 bg-gray-100 hover:bg-gray-200"
        >
          既定に戻す
        </button>
      </div>

      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
      {failed.length > 0 && (
        <p className="text-xs text-amber-600 mb-2">取得失敗/データ不足: {failed.join(", ")}</p>
      )}

      {result && result.ok && (
        <>
          <div className={`mb-3 rounded border p-3 text-sm ${result.orderParameter > 0.7 ? "bg-red-50 border-red-200" : "bg-gray-50 border-gray-200"}`}>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
              <span className="font-bold text-gray-700">{syncLevel}</span>
              <span className="text-gray-600">秩序変数 r = <b>{result.orderParameter.toFixed(3)}</b></span>
              <span className="text-gray-600">振幅加重 r_w = {result.weightedOrder.toFixed(3)}</span>
              <span className="text-gray-400 text-xs">{result.items.length}銘柄</span>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              r≈1: 全銘柄が同じ曜日にピーク=市場共通の週次クロック。r≈0: バラバラ=個別要因が支配的。
            </p>
          </div>

          <div className="flex justify-center">
            <canvas ref={circleRef} className="rounded border border-gray-200" />
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs text-center border-collapse">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="py-1 px-2 text-left">銘柄</th>
                  <th className="py-1 px-2">ピーク曜日</th>
                  <th className="py-1 px-2">週次パターン強度(振幅)</th>
                </tr>
              </thead>
              <tbody>
                {result.items
                  .slice()
                  .sort((a, b) => b.amplitude - a.amplitude)
                  .map((it) => (
                    <tr key={it.ticker} className="border-b border-gray-100">
                      <td className="py-1 px-2 text-left font-mono">{it.ticker}</td>
                      <td className="py-1 px-2">{WEEKDAY_LABELS[it.peakPhase]}</td>
                      <td className="py-1 px-2 font-mono">{(it.amplitude * 100).toFixed(3)}%</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!result && !loading && (
        <p className="text-sm text-gray-500 py-6 text-center">
          「取得して計算」を押すと各銘柄を取得して同期度を計算します
        </p>
      )}

      <AnalysisGuide title="週次位相同期 (Kuramoto) の詳細理論">
        <p className="font-medium text-gray-700">1. 何を検証しているか</p>
        <p>
          単一銘柄の週内アトラクタ分析を多銘柄に拡張し、各銘柄の「週次の選好位相(どの曜日にリターンがピークになるか)」が
          銘柄間で揃っているかを測ります。揃っていれば市場全体に共通の週次クロックが存在し、揃っていなければ個別要因が支配的です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>{"各銘柄の曜日別平均リターン μ_k から第1高調波: a=Σμ_k cos(2πk/5), b=Σμ_k sin(2πk/5)"}</p>
        <p>{"選好位相 θ = atan2(b, a)、週次パターン強度(振幅) A = √(a²+b²)"}</p>
        <p>{"Kuramoto 秩序変数 r = |(1/N) Σ_j exp(iθ_j)|  ∈ [0,1]"}</p>
        <p>{"振幅加重 r_w = |Σ A_j exp(iθ_j)| / Σ A_j"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>選好位相</b>: その銘柄の週次リターン周期の位相角。曜日円上の方角に対応。</li>
          <li><b>秩序変数 r</b>: 全銘柄の位相ベクトルの平均の長さ。1に近いほど位相が揃っている(同期)。</li>
          <li><b>第1高調波</b>: 週次パターンを1つの正弦波で近似した成分。位相と振幅で表す。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          メトロノームを多数並べたとき、全部が同じ拍で振れていれば r≈1(同期)、バラバラなら r≈0。
          ここでは各銘柄が「週のどのタイミングで強くなるか」のメトロノーム。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>円上で青点(各銘柄)が一方向に集まり、赤の合成ベクトルが長い → 強い同期。</li>
          <li>青点が円全体に散らばり赤が短い → 非同期。</li>
          <li>振幅が大きい銘柄ほど週次パターンが強い(円の外側)。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>強い同期: 市場共通の週次バイアス。指数レベルで曜日リスク調整・執行タイミング最適化が有効。</li>
          <li>非同期: 銘柄固有の週次要因。ペア/分散の文脈で個別に扱う。</li>
          <li>同期の時間変化(別途ローリング化)はレジーム指標になりうる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>異なる市場/タイムゾーンの銘柄を混ぜると曜日定義がずれる。既定は米セクターETFで統一。</li>
          <li>選好位相は曜日平均リターン(1次モーメント)由来。動力学的位相ロック(PL)とは別物。</li>
          <li>全期間集計のため非定常。曜日効果の減衰・反転に注意。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
