"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  computeEventStudy,
  type TriggerCond,
  type EventStudyResult,
} from "../../lib/event-study";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

const pct = (v: number, d = 2) => (v * 100 >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";

const COND_OPTIONS: { value: TriggerCond; label: string }[] = [
  { value: "up", label: "上昇 (≧ +しきい値)" },
  { value: "down", label: "下落 (≦ −しきい値)" },
  { value: "abs", label: "急変 (|変化| ≧ しきい値)" },
];

const HORIZON_OPTIONS = [5, 10, 20, 40, 60];
const TABLE_HORIZONS = [1, 3, 5, 10, 20, 40, 60];

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export default function EventStudyChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ベンチマーク（トリガー系列）
  const [benchTicker, setBenchTicker] = useState("^N225");
  const [benchInput, setBenchInput] = useState("^N225");
  const [benchPrices, setBenchPrices] = useState<PricePoint[] | null>(null);
  const [benchName, setBenchName] = useState("日経225");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 条件設定
  const [source, setSource] = useState<"bench" | "self">("bench");
  const [cond, setCond] = useState<TriggerCond>("up");
  const [thresholdPct, setThresholdPct] = useState(2);
  const [horizon, setHorizon] = useState(20);
  const [showPaths, setShowPaths] = useState(true);

  // ベンチマークデータ取得
  useEffect(() => {
    let aborted = false;
    const run = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch(`/api/stock?ticker=${encodeURIComponent(benchTicker)}&range=10y`);
        const json = await res.json();
        if (aborted) return;
        if (!res.ok || !json.prices) {
          setBenchPrices(null);
          setLoadError("ベンチマークデータを取得できません");
        } else {
          setBenchPrices(json.prices);
          setBenchName(json.name || benchTicker);
        }
      } catch {
        if (!aborted) { setBenchPrices(null); setLoadError("ネットワークエラー"); }
      } finally {
        if (!aborted) setLoading(false);
      }
    };
    run();
    return () => { aborted = true; };
  }, [benchTicker]);

  const triggerSeries = source === "self" ? prices : benchPrices;
  const triggerLabel = source === "self" ? "分析銘柄" : benchName;

  const result: EventStudyResult | null = useMemo(() => {
    if (!triggerSeries || triggerSeries.length === 0) return null;
    return computeEventStudy(prices, triggerSeries, cond, thresholdPct, horizon);
  }, [prices, triggerSeries, cond, thresholdPct, horizon]);

  // 描画
  useEffect(() => {
    if (!canvasRef.current) return;
    const h = 380;
    const init = initCanvas(canvasRef.current, h);
    if (!init) return;
    const { ctx, width, height } = init;

    if (!result || result.nUsable === 0) {
      ctx.fillStyle = "#9ca3af";
      ctx.font = "12px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(
        loading ? "データ取得中..." : "条件を満たすイベントがありません（しきい値を下げてください）",
        width / 2, height / 2
      );
      return;
    }

    const { meanPath, medianPath, p25Path, p75Path, baselineMean, events } = result;
    const N = horizon;
    const ml = 52, mr = 16, mt = 16, mb = 36;
    const plotW = width - ml - mr;
    const plotH = height - mt - mb;

    // y範囲: 個別パスの外れ値を抑えるため5-95%タイルとバンド/平均で決める
    const flat = events.flatMap(e => e.path);
    const sortedFlat = [...flat].sort((a, b) => a - b);
    let yMin = Math.min(percentile(sortedFlat, 0.05), ...p25Path, ...baselineMean, 0);
    let yMax = Math.max(percentile(sortedFlat, 0.95), ...p75Path, ...baselineMean, 0);
    const padY = (yMax - yMin) * 0.08 || 0.01;
    yMin -= padY; yMax += padY;
    const yRange = yMax - yMin || 0.01;

    const xAt = (k: number) => ml + (plotW * k) / N;
    const yAt = (v: number) => mt + plotH - ((v - yMin) / yRange) * plotH;
    const clampY = (y: number) => Math.max(mt, Math.min(mt + plotH, y));

    // グリッド + y軸ラベル
    ctx.strokeStyle = "#eef0f2"; ctx.lineWidth = 1;
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    const nGrid = 6;
    for (let g = 0; g <= nGrid; g++) {
      const v = yMin + (yRange * g) / nGrid;
      const y = yAt(v);
      ctx.strokeStyle = Math.abs(v) < 1e-9 ? "#d1d5db" : "#eef0f2";
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      ctx.fillStyle = "#9ca3af";
      ctx.fillText((v * 100).toFixed(1) + "%", ml - 5, y + 3);
    }

    // ゼロライン強調
    const zeroY = yAt(0);
    ctx.strokeStyle = "#9ca3af"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(ml, zeroY); ctx.lineTo(width - mr, zeroY); ctx.stroke();
    ctx.setLineDash([]);

    // 25-75%バンド
    ctx.beginPath();
    for (let k = 0; k <= N; k++) ctx.lineTo(xAt(k), yAt(p75Path[k]));
    for (let k = N; k >= 0; k--) ctx.lineTo(xAt(k), yAt(p25Path[k]));
    ctx.closePath();
    ctx.fillStyle = "rgba(59,130,246,0.10)";
    ctx.fill();

    // 個別イベントパス（薄色スパゲッティ）
    if (showPaths) {
      ctx.lineWidth = 0.6;
      for (const e of events) {
        ctx.strokeStyle = e.path[N] >= 0 ? "rgba(16,185,129,0.18)" : "rgba(239,68,68,0.18)";
        ctx.beginPath();
        for (let k = 0; k <= N; k++) {
          const x = xAt(k), y = clampY(yAt(e.path[k]));
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    // 無条件平均（比較基準・グレー破線）
    ctx.strokeStyle = "#9ca3af"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
    ctx.beginPath();
    for (let k = 0; k <= N; k++) { const x = xAt(k), y = yAt(baselineMean[k]); if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
    ctx.setLineDash([]);

    // 中央値（緑）
    ctx.strokeStyle = "#10b981"; ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let k = 0; k <= N; k++) { const x = xAt(k), y = yAt(medianPath[k]); if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();

    // 条件付き平均（青・太）
    ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2.6;
    ctx.beginPath();
    for (let k = 0; k <= N; k++) { const x = xAt(k), y = yAt(meanPath[k]); if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
    // 終点マーカー
    ctx.fillStyle = "#2563eb";
    ctx.beginPath(); ctx.arc(xAt(N), yAt(meanPath[N]), 3.5, 0, Math.PI * 2); ctx.fill();

    // x軸ラベル
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    const xStep = N <= 20 ? 5 : N <= 40 ? 10 : 10;
    for (let k = 0; k <= N; k += xStep) ctx.fillText(`${k}`, xAt(k), height - mb + 14);
    ctx.fillText("経過営業日", ml + plotW / 2, height - 4);

    // 枠
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
    ctx.strokeRect(ml, mt, plotW, plotH);
  }, [result, horizon, showPaths, loading]);

  // テーブル用の選択ホライズン
  const tableRows = useMemo(() => {
    if (!result) return [];
    return TABLE_HORIZONS.filter(k => k <= horizon).map(k => result.perK[k]).filter(Boolean);
  }, [result, horizon]);

  const finalStat = result && result.nUsable > 0 ? result.perK[horizon] : null;
  const baselineFinal = result && result.baselineMean.length > 0 ? result.baselineMean[horizon] : 0;
  const edge = finalStat ? finalStat.mean - baselineFinal : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">条件付きイベントスタディ（始点重ね描き）</h3>
      <p className="text-xs text-gray-500">
        「{triggerLabel}」が指定条件を満たした日を起点(0%)に揃え、その後の<span className="font-medium">分析銘柄</span>の累積リターンを重ねて傾向を可視化します。
      </p>

      {/* 条件設定 */}
      <div className="flex flex-wrap items-end gap-3 text-xs">
        <div>
          <div className="text-gray-400 mb-1">トリガー系列</div>
          <div className="flex gap-1">
            {([["bench", "ベンチマーク"], ["self", "分析銘柄自身"]] as ["bench" | "self", string][]).map(([v, l]) => (
              <button key={v} onClick={() => setSource(v)}
                className={`px-2 py-1 rounded border transition-colors ${source === v ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-200 hover:bg-gray-100"}`}>
                {l}
              </button>
            ))}
          </div>
        </div>

        {source === "bench" && (
          <div>
            <div className="text-gray-400 mb-1">ベンチマーク銘柄</div>
            <form onSubmit={(e) => { e.preventDefault(); const t = benchInput.trim(); if (t) setBenchTicker(/^\d{4}$/.test(t) ? t : t.toUpperCase()); }}
              className="flex gap-1 items-center">
              <input value={benchInput} onChange={(e) => setBenchInput(e.target.value)}
                placeholder="^N225 / 7203 等"
                className="w-28 px-1.5 py-1 border border-gray-300 rounded focus:outline-none focus:border-blue-400" />
              <button type="submit" className="px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">設定</button>
            </form>
          </div>
        )}

        <div>
          <div className="text-gray-400 mb-1">条件</div>
          <select value={cond} onChange={(e) => setCond(e.target.value as TriggerCond)}
            className="px-2 py-1 border border-gray-300 rounded bg-white focus:outline-none focus:border-blue-400">
            {COND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div>
          <div className="text-gray-400 mb-1">しきい値 (%)</div>
          <input type="number" step={0.5} min={0} value={thresholdPct}
            onChange={(e) => setThresholdPct(Math.max(0, Number(e.target.value)))}
            className="w-20 px-1.5 py-1 border border-gray-300 rounded focus:outline-none focus:border-blue-400" />
        </div>

        <div>
          <div className="text-gray-400 mb-1">観察日数</div>
          <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}
            className="px-2 py-1 border border-gray-300 rounded bg-white focus:outline-none focus:border-blue-400">
            {HORIZON_OPTIONS.map(h => <option key={h} value={h}>{h}日</option>)}
          </select>
        </div>

        <label className="flex items-center gap-1 cursor-pointer text-gray-500 pb-1">
          <input type="checkbox" checked={showPaths} onChange={(e) => setShowPaths(e.target.checked)} className="accent-blue-600" />
          個別パスを表示
        </label>
      </div>

      {loadError && <div className="text-xs text-red-500">{loadError}</div>}

      {/* サマリー */}
      {result && result.nUsable > 0 && finalStat && (
        <div className={`flex flex-wrap gap-x-4 gap-y-1 p-3 rounded-lg border text-xs ${finalStat.mean > 0 ? "bg-green-50 border-green-200" : finalStat.mean < 0 ? "bg-red-50 border-red-200" : "bg-gray-50 border-gray-200"}`}>
          <span className="font-medium text-gray-700">
            トリガー {result.nTrigger}回（完全な{horizon}日を確保 {result.nUsable}回）
          </span>
          <span>{horizon}日後 平均: <span className="font-mono font-medium">{pct(finalStat.mean)}</span></span>
          <span>中央値: <span className="font-mono">{pct(finalStat.median)}</span></span>
          <span>上昇確率: <span className="font-mono">{(finalStat.winRate * 100).toFixed(0)}%</span></span>
          <span>無条件平均: <span className="font-mono text-gray-500">{pct(baselineFinal)}</span></span>
          <span>超過(エッジ): <span className={`font-mono font-medium ${edge > 0 ? "text-green-700" : edge < 0 ? "text-red-700" : ""}`}>{pct(edge)}</span></span>
        </div>
      )}

      {/* チャート */}
      <div className="relative w-full rounded border border-gray-100 overflow-hidden">
        <canvas ref={canvasRef} />
      </div>

      {/* 凡例 */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-blue-600" />条件付き平均</span>
        <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-emerald-500" />中央値</span>
        <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-blue-300" />25–75%帯</span>
        <span className="flex items-center gap-1"><span className="inline-block w-4 border-t border-dashed border-gray-400" />無条件平均(基準)</span>
        <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-emerald-300" />上昇イベント / <span className="inline-block w-4 h-0.5 bg-red-300" />下落イベント</span>
      </div>

      {/* テーブル */}
      {tableRows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-1 px-2 text-left text-gray-500 font-medium">経過日数</th>
                <th className="py-1 px-2 text-center text-gray-500 font-medium">平均</th>
                <th className="py-1 px-2 text-center text-gray-500 font-medium">中央値</th>
                <th className="py-1 px-2 text-center text-gray-500 font-medium">σ</th>
                <th className="py-1 px-2 text-center text-gray-500 font-medium">上昇確率</th>
                <th className="py-1 px-2 text-center text-gray-500 font-medium">無条件平均</th>
                <th className="py-1 px-2 text-center text-gray-500 font-medium">超過</th>
                <th className="py-1 px-2 text-center text-gray-500 font-medium">N</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((s) => {
                const base = result!.baselineMean[s.k];
                const ex = s.mean - base;
                return (
                  <tr key={s.k} className="border-b border-gray-100">
                    <td className="py-1 px-2 font-medium text-gray-700">{s.k}日後</td>
                    <td className={`py-1 px-2 text-center font-mono ${s.mean >= 0 ? "text-green-600" : "text-red-600"}`}>{pct(s.mean)}</td>
                    <td className={`py-1 px-2 text-center font-mono ${s.median >= 0 ? "text-green-600" : "text-red-600"}`}>{pct(s.median)}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-500">{(s.std * 100).toFixed(2)}%</td>
                    <td className={`py-1 px-2 text-center font-mono ${s.winRate >= 0.5 ? "text-green-600" : "text-red-600"}`}>{(s.winRate * 100).toFixed(0)}%</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-500">{pct(base)}</td>
                    <td className={`py-1 px-2 text-center font-mono font-medium ${ex > 0 ? "text-green-700" : ex < 0 ? "text-red-700" : ""}`}>{pct(ex)}</td>
                    <td className="py-1 px-2 text-center font-mono text-gray-400">{s.n}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AnalysisGuide title="条件付きイベントスタディの詳細理論">
        <p className="font-medium text-gray-700">1. イベントスタディとは</p>
        <p>「ある出来事（イベント）が起きた後、価格は平均的にどう動くか」を、過去の同種イベントを多数重ね合わせて調べる手法です。例えば「日経平均が+2%以上上昇した翌日以降、対象銘柄はどう動いたか」を、過去の全該当日について<span className="font-medium">起点を0%に揃えて</span>平均化します。多数の事例を重ねることで、ノイズが打ち消され「平均的な反応（傾向）」が浮かび上がります。天気予報で「この気圧配置の翌日は晴れが多い」と過去事例から確率を見るのに似ています。</p>

        <p className="font-medium text-gray-700 mt-3">2. 計算手順と数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>トリガー系列（例: 日経225）と分析銘柄を日付で内部結合し、両方が揃う営業日のみ使用します。</li>
          <li>トリガー日 t₀ の判定: トリガー系列の当日対数リターン r = ln(C_t / C_&#123;t-1&#125;) が条件を満たす日を抽出。上昇条件なら r ≧ θ、下落条件なら r ≦ −θ、急変条件なら |r| ≧ θ（θ=しきい値）。</li>
          <li>各 t₀ について、分析銘柄の<span className="font-medium">始点揃え累積対数リターン</span>を計算: {"path_k = ln(P_{t0+k} / P_{t0})"}（k=0,1,…,N）。定義より path₀ = 0。</li>
          <li>全イベントについて各 k で平均・中央値・25/75%タイル・上昇確率を集計します。平均パス {"= (1/M) Σ_i path_k^(i)"}（M=イベント数）。</li>
          <li>比較基準として、条件を付けない全営業日起点の平均パス（無条件平均）も計算します。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">始点揃え（重ね描き）</span>: 各イベント発生日を時刻0として横軸を揃え、縦軸を発生時点=0%とすること。異なる時期のイベントを同じ土俵で比較できます。</li>
          <li><span className="font-medium">25–75%帯</span>: 各経過日でイベントを並べたときの下位25%〜上位75%の範囲。ばらつき（不確実性）の目安です。</li>
          <li><span className="font-medium">無条件平均（基準）</span>: 条件なしで「適当な日に買って k 日保有」した場合の平均。条件付き平均がこれを上回って初めて「条件に意味がある」と言えます。</li>
          <li><span className="font-medium">超過（エッジ）</span>: 条件付き平均 − 無条件平均。イベント条件が生み出す上乗せリターン。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>青い平均線が右肩上がりで無条件平均（灰破線）を上回る → そのイベント後は<span className="font-medium">買い優位</span>の傾向（モメンタム/連れ高）。</li>
          <li>平均線が右肩下がり → イベント後は<span className="font-medium">反落</span>しやすい（過熱の反動、平均回帰）。</li>
          <li>平均と中央値が乖離 → 分布が歪んでいる。平均が正でも中央値が負なら「稀な大幅高が平均を押し上げているだけ」で、勝率は低い可能性。</li>
          <li>25–75%帯が広い → ばらつきが大きく傾向の信頼度は低い。帯が狭く平均が0から離れているほど傾向は明確。</li>
          <li>上昇確率が50%から大きく離れるほど方向性が強い。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">連れ高/連れ安の確認</span>: ベンチマーク（日経・セクター指数）が大きく動いた後、対象銘柄が遅れて追随するか先に織り込むかを把握し、エントリーのタイミングを設計。</li>
          <li><span className="font-medium">押し目/戻り売りの根拠</span>: 「自身が−X%下落した後、平均的にN日で戻すか」を見て、逆張りの保有期間と利確目安を決める。</li>
          <li><span className="font-medium">保有期間の最適化</span>: 平均線がどの経過日でピークを付けるかが、そのイベント起点の利確タイミングの目安になります。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">オーバーラップ</span>: 近接した複数のトリガーは観察期間が重複し、サンプルが独立でないため統計的有意性は過大評価されがちです。N（イベント数）が少ないときは特に偶然の可能性に注意。</li>
          <li><span className="font-medium">先読みバイアスなし設計</span>: 起点はトリガー当日の終値であり、その時点で観測可能な情報のみを使います。ただし当日終値での約定を前提とするため、実際の執行とはズレ得ます。</li>
          <li><span className="font-medium">取引コスト未考慮</span>: 手数料・スプレッド・スリッページは含みません。</li>
          <li><span className="font-medium">レジーム依存</span>: 過去の傾向は市場環境（強気/弱気・低ボラ/高ボラ）に依存し、将来も続く保証はありません。期間を区切って安定性を確認することを推奨します。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
