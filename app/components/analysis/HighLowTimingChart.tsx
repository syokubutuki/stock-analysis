"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import {
  computeHighLowTiming,
  HighLowTimingResult,
  IntradayBar,
} from "../../lib/highlow-timing";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  ticker: string;
}

interface IntradayResponse {
  symbol: string;
  interval: string;
  range: string;
  gmtoffset: number;
  timezone: string;
  bars: IntradayBar[];
  error?: string;
}

// 足種ごとに取得期間が変わる(細かい足ほど短い)。Yahooの上限に合わせる。
const INTERVALS = [
  { value: "5m", label: "5分足", note: "直近約60日" },
  { value: "15m", label: "15分足", note: "直近約60日" },
  { value: "60m", label: "60分足", note: "直近約2年" },
] as const;

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

function minuteLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = Math.round(minute % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export default function HighLowTimingChart({ ticker }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [interval, setInterval] = useState<string>("5m");
  const [resp, setResp] = useState<IntradayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResp(null);
    fetch(`/api/intraday?ticker=${encodeURIComponent(ticker)}&interval=${interval}`)
      .then(async (r) => {
        const json = (await r.json()) as IntradayResponse;
        if (cancelled) return;
        if (!r.ok) {
          setError(json.error || "日中足の取得に失敗しました");
          return;
        }
        setResp(json);
      })
      .catch(() => {
        if (!cancelled) setError("ネットワークエラー");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, interval]);

  const result: HighLowTimingResult | null = useMemo(() => {
    if (!resp || resp.bars.length === 0) return null;
    return computeHighLowTiming(resp.bars, resp.gmtoffset, 30);
  }, [resp]);

  useEffect(() => {
    if (!canvasRef.current || !result || result.bins.length === 0) return;
    const H = 360;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width } = init;

    const ml = 44, mr = 16, mt = 24, gap = 36;
    const plotW = width - ml - mr;
    const paneH = (H - mt - gap - 24) / 2;
    const n = result.bins.length;
    const slot = plotW / n;
    const barW = Math.max(2, slot * 0.7);

    const maxHigh = Math.max(1, ...result.highCounts);
    const maxLow = Math.max(1, ...result.lowCounts);

    const drawPane = (
      counts: number[],
      maxV: number,
      top: number,
      color: string,
      title: string,
      medianMinute: number
    ) => {
      // 枠と軸
      ctx.strokeStyle = "#d1d5db";
      ctx.lineWidth = 1;
      ctx.strokeRect(ml, top, plotW, paneH);

      ctx.fillStyle = "#374151";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(title, ml, top - 7);

      // y軸目盛(0 と max)
      ctx.fillStyle = "#9ca3af";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText("0", ml - 5, top + paneH);
      ctx.fillText(String(maxV), ml - 5, top + 9);

      // バー
      for (let i = 0; i < n; i++) {
        const h = (counts[i] / maxV) * (paneH - 6);
        const x = ml + i * slot + (slot - barW) / 2;
        const y = top + paneH - h;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, barW, h);
        if (counts[i] > 0) {
          ctx.fillStyle = "#6b7280";
          ctx.font = "8px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(String(counts[i]), x + barW / 2, y - 2);
        }
      }

      // 中央値の縦線
      const mIdx = (medianMinute - result.bins[0].startMinute) / result.binMinutes;
      const mx = ml + Math.max(0, Math.min(n, mIdx)) * slot;
      ctx.strokeStyle = "#111827";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(mx, top);
      ctx.lineTo(mx, top + paneH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#111827";
      ctx.font = "8px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(`中央値 ${minuteLabel(medianMinute)}`, mx + 3, top + 9);
    };

    drawPane(result.highCounts, maxHigh, mt, "#ef4444cc", "高値が付いた時間帯（日数）", result.highMedianMinute);
    drawPane(result.lowCounts, maxLow, mt + paneH + gap, "#3b82f6cc", "安値が付いた時間帯（日数）", result.lowMedianMinute);

    // x軸ラベル(下段の下に時刻)。混雑を避け1つおきに表示
    ctx.fillStyle = "#6b7280";
    ctx.font = "8px sans-serif";
    ctx.textAlign = "center";
    const labelEvery = n > 14 ? 2 : 1;
    const baseY = mt + paneH + gap + paneH + 12;
    for (let i = 0; i < n; i++) {
      if (i % labelEvery !== 0) continue;
      ctx.fillText(result.bins[i].label, ml + i * slot + slot / 2, baseY);
    }
  }, [result]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">高値・安値の時間帯分布</h3>
        <div className="flex gap-1">
          {INTERVALS.map((iv) => (
            <button
              key={iv.value}
              onClick={() => setInterval(iv.value)}
              title={iv.note}
              className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                interval === iv.value
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {iv.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="text-sm text-gray-400 py-8 text-center">日中足を取得中...</div>}
      {error && (
        <div className="bg-amber-50 text-amber-700 rounded-lg p-3 text-sm">{error}</div>
      )}

      {result && !loading && (
        <>
          <div className="text-xs text-gray-500">
            対象 {result.nDays} 営業日 / {resp?.interval} 足 /
            取引所時刻 {minuteLabel(result.sessionStartMinute)}–{minuteLabel(result.sessionEndMinute)}
            {resp?.timezone ? `（${resp.timezone}）` : ""}
          </div>
          <div className="relative">
            <canvas ref={canvasRef} />
          </div>

          {/* 統計サマリー */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <Stat label="高値が寄り直後" value={`${(result.highOpenShare * 100).toFixed(0)}%`} />
            <Stat label="高値が引け直前" value={`${(result.highCloseShare * 100).toFixed(0)}%`} />
            <Stat label="安値が寄り直後" value={`${(result.lowOpenShare * 100).toFixed(0)}%`} />
            <Stat label="安値が引け直前" value={`${(result.lowCloseShare * 100).toFixed(0)}%`} />
            <Stat label="高値時刻の中央値" value={minuteLabel(result.highMedianMinute)} />
            <Stat label="安値時刻の中央値" value={minuteLabel(result.lowMedianMinute)} />
            <Stat
              label="高安どちらが先か"
              value={result.highMedianMinute < result.lowMedianMinute ? "高値が先（上→下）" : "安値が先（下→上）"}
            />
            <Stat
              label="高安同時バー"
              value={`${result.sameBarDays}日 (${((result.sameBarDays / result.nDays) * 100).toFixed(0)}%)`}
            />
          </div>
        </>
      )}

      <AnalysisGuide title="高値・安値の時間帯分布の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"日足のOHLCには「その日の高値・安値が何時に付いたか」という時刻情報が含まれません(1日1組のOHLCしかないため)。本分析では実際の日中足(5分足など)を取得し、各営業日について"}
          <strong>高値を付けたバー</strong>{"と"}<strong>安値を付けたバー</strong>
          {"の取引所ローカル時刻を特定して、時間帯ごとに集計します。「寄り付き偏重か」「大引け偏重か」「ザラ場中盤か」といった日中の癖を可視化します。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算手順と数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"各バーの取引所ローカル秒 = ((ts + gmtoffset) mod 86400)。ここで ts はUNIX秒(UTC)、gmtoffset は取引所のUTCオフセット秒(日本株なら +32400)。"}</li>
          <li>{"営業日 d = floor((ts + gmtoffset) / 86400) でバーを日ごとにグループ化。"}</li>
          <li>{"各日 d について、高値時刻 t_H(d) = argmax_t High_t、安値時刻 t_L(d) = argmin_t Low_t。同値が複数バーに跨る場合は最も早いバー(最初のタッチ)を採用。"}</li>
          <li>{"時刻を30分刻みのビンに割り当て、ビンごとに該当日数をカウント → ヒストグラム。"}</li>
          <li>{"寄り直後シェア = (最初のビンで高値/安値が付いた日数) / 全日数。引け直前シェアも同様に最終ビンで算出。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>日中足(intraday bars)</strong>: 1日を細分した足。5分足なら1日に数十本のOHLCが存在する。</li>
          <li><strong>gmtoffset</strong>: 取引所のタイムゾーンとUTCの時差(秒)。これでUTC時刻をニューヨーク時間/日本時間へ正しく変換する。</li>
          <li><strong>中央値の縦線</strong>: 高値(安値)が付いた時刻の中央値。分布の「重心」の目安。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>高値の山が<strong>最初のビン(寄り)</strong>に集中 → 寄り高で始まり後は垂れる「寄り天」型が多い。</li>
          <li>高値の山が<strong>最後のビン(引け)</strong>に集中 → 引けにかけて買われる「大引け強」型。</li>
          <li>高値中央値 &lt; 安値中央値 なら「先に高値→後で安値」=日中は下落基調、逆なら上昇基調が示唆される。</li>
          <li>高安が両端(寄りと引け)に割れていれば日中レンジが広く振れやすい。中盤に集中するなら値動きが穏やか。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>執行タイミング</strong>: 安値が寄り直後に集中する銘柄は、寄り底狙いの押し目買いが機能しやすい。高値が引けに集中するなら大引け成行売りが有利。</li>
          <li><strong>デイトレ戦略</strong>: 「寄り天」型なら寄り付き戻り売り、「引け強」型なら後場の押し目買い→引け処分、と時間帯戦略を組める。</li>
          <li><strong>逆指値の置き方</strong>: 安値到達が後場に偏るなら、前場のうちは浅いストップが狩られにくい。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"Yahooの日中足は取得期間に制約があり、5分足/15分足は直近約60日、60分足でも約2年まで。長期の構造的傾向の断定には使えない(直近の癖の把握に留める)。"}</li>
          <li>{"足の粒度より細かい時刻は分からない(5分足なら高値時刻は5分単位の解像度)。"}</li>
          <li>{"高値と安値が同一バー内で同時に付いた日(上下髭の大きい日)は時刻に曖昧さが残るため別途カウントを表示している。比率が高い銘柄は解釈に注意。"}</li>
          <li>{"投資信託や流動性の低い銘柄は日中足が提供されず取得できない場合がある。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded p-2">
      <div className="text-gray-500">{label}</div>
      <div className="font-bold text-gray-800">{value}</div>
    </div>
  );
}
