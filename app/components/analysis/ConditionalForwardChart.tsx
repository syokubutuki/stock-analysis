"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import {
  conditionalForwardReturns,
  buildStateFn,
  buildStateSeries,
  STATE_AXES,
  StateAxis,
  StateSeries,
  ForwardStats,
} from "../../lib/conditional-forward-returns";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  axes?: { value: StateAxis; label: string }[];
  title?: string;
  defaultAxis?: StateAxis;
  minBars?: number;
}

const HORIZONS = [1, 5, 10, 20];

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

// 0中心の発散カラー（負=赤, 正=緑）。intensity を絶対値の大きさに比例させる。
function retBg(v: number, maxAbs: number): string {
  const t = maxAbs > 0 ? Math.min(1, Math.abs(v) / maxAbs) : 0;
  if (v >= 0) return `rgba(22, 163, 74, ${0.08 + t * 0.55})`; // green-600
  return `rgba(220, 38, 38, ${0.08 + t * 0.55})`; // red-600
}

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

// 発散棒（各バケットの平均フォワードリターン）
function drawDivergingBars(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  buckets: ForwardStats[],
  nowLabel: string | null
) {
  const ml = 8, mr = 60, mt = 22, mb = 8;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;
  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("バケット別 N日先 平均リターン（0中心）", ml, 14);

  const maxAbs = Math.max(1e-9, ...buckets.map((b) => Math.abs(b.meanFwd)));
  const zeroX = ml + plotW / 2;
  const rowH = plotH / buckets.length;
  ctx.strokeStyle = "#9ca3af";
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(zeroX, mt);
  ctx.lineTo(zeroX, mt + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  buckets.forEach((b, i) => {
    const cy = mt + i * rowH + rowH / 2;
    const w = (Math.abs(b.meanFwd) / maxAbs) * (plotW / 2 - 4);
    const barH = Math.max(6, rowH * 0.5);
    const x = b.meanFwd >= 0 ? zeroX : zeroX - w;
    ctx.fillStyle = b.significant
      ? b.meanFwd >= 0 ? "#16a34a" : "#dc2626"
      : b.meanFwd >= 0 ? "#16a34a66" : "#dc262666";
    ctx.fillRect(x, cy - barH / 2, w, barH);
    // 値ラベル
    ctx.fillStyle = "#374151";
    ctx.font = "9px sans-serif";
    ctx.textAlign = b.meanFwd >= 0 ? "left" : "right";
    ctx.fillText(fmtPct(b.meanFwd), b.meanFwd >= 0 ? zeroX + w + 3 : zeroX - w - 3, cy + 3);
    // 現在バケットを強調
    if (b.label === nowLabel) {
      ctx.strokeStyle = "#1d4ed8";
      ctx.lineWidth = 2;
      ctx.strokeRect(ml - 2, cy - rowH / 2 + 1, plotW + mr - 4, rowH - 2);
      ctx.fillStyle = "#1d4ed8";
      ctx.font = "bold 9px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText("◀現在", ml + plotW + mr - 2, cy + 3);
    }
  });
}

// 年次持続性ストリップ（バケット×年の符号ヒートマップ）
function drawYearStrip(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  buckets: ForwardStats[]
) {
  const years = Array.from(new Set(buckets.flatMap((b) => b.byYear.map((y) => y.year)))).sort((a, b) => a - b);
  if (years.length === 0) return;
  const ml = 92, mr = 8, mt = 22, mb = 16;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;
  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("年次持続性（緑=その年プラス / 赤=マイナス）", ml - 84, 14);

  const cw = plotW / years.length;
  const rowH = plotH / buckets.length;
  const maxAbs = Math.max(1e-9, ...buckets.flatMap((b) => b.byYear.map((y) => Math.abs(y.meanFwd))));

  buckets.forEach((b, i) => {
    const y0 = mt + i * rowH;
    ctx.fillStyle = "#4b5563";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(b.label.length > 11 ? b.label.slice(0, 10) + "…" : b.label, ml - 4, y0 + rowH / 2 + 3);
    const map = new Map(b.byYear.map((y) => [y.year, y.meanFwd]));
    years.forEach((yr, j) => {
      const x = ml + j * cw;
      if (map.has(yr)) {
        ctx.fillStyle = retBg(map.get(yr)!, maxAbs);
        ctx.fillRect(x + 0.5, y0 + 0.5, cw - 1, rowH - 1);
      } else {
        ctx.fillStyle = "#f3f4f6";
        ctx.fillRect(x + 0.5, y0 + 0.5, cw - 1, rowH - 1);
      }
    });
  });
  // 年ラベル（間引き）
  ctx.fillStyle = "#9ca3af";
  ctx.font = "8px sans-serif";
  ctx.textAlign = "center";
  const step = Math.ceil(years.length / 12);
  years.forEach((yr, j) => {
    if (j % step === 0) ctx.fillText(`'${String(yr).slice(2)}`, ml + j * cw + cw / 2, mt + plotH + 11);
  });
}

// 状態を決める指標の実値を時系列で描く（しきい値帯つき）。「なぜその状態か」を可視化。
function drawIndicator(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  series: StateSeries,
  times: string[]
) {
  const ml = 8, mr = 52, mt = 20, mb = 16;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;
  const vals = series.values;
  const n = vals.length;
  const finite = vals.filter((v): v is number => v != null && isFinite(v));
  if (finite.length < 2) return;
  let vmin = Math.min(...finite, ...series.thresholds.map((t) => t.value));
  let vmax = Math.max(...finite, ...series.thresholds.map((t) => t.value));
  const pad = (vmax - vmin) * 0.08 || 1;
  vmin -= pad; vmax += pad;
  const ys = (v: number) => mt + plotH - ((v - vmin) / (vmax - vmin)) * plotH;
  const xs = (i: number) => ml + (i / Math.max(1, n - 1)) * plotW;

  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`判定指標の推移: ${series.label}（点線=バケット境界）`, ml, 13);

  // しきい値ライン
  series.thresholds.forEach((t) => {
    const y = ys(t.value);
    ctx.strokeStyle = "#cbd5e1"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#94a3b8"; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    const lbl = series.unit === "%" ? `${t.value >= 0 ? "+" : ""}${t.value.toFixed(0)}%` : `${t.value}${series.unit}`;
    ctx.fillText(lbl, ml + plotW + 3, y + 3);
  });

  // 値ライン
  ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 1.5; ctx.beginPath();
  let started = false;
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (v == null || !isFinite(v)) { started = false; continue; }
    const x = xs(i), y = ys(v);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 直近値マーカー
  for (let i = n - 1; i >= 0; i--) {
    const v = vals[i];
    if (v == null || !isFinite(v)) continue;
    const x = xs(i), y = ys(v);
    ctx.fillStyle = "#1d4ed8"; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#1d4ed8"; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "right";
    const lbl = series.unit === "%" ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : `${v.toFixed(series.unit === "" ? 2 : 0)}${series.unit}`;
    ctx.fillText(`現在 ${lbl}`, ml + plotW, mt - 6);
    break;
  }

  // 時刻ラベル（端と中央）
  ctx.fillStyle = "#9ca3af"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
  [0, Math.floor(n / 2), n - 1].forEach((i) => { if (times[i]) ctx.fillText(times[i], xs(i), mt + plotH + 12); });
}

export default function ConditionalForwardChart({
  prices,
  axes = STATE_AXES,
  title = "状態 → 先行きリターン表（条件付き期待値）",
  defaultAxis,
  minBars = 250,
}: Props) {
  const barRef = useRef<HTMLCanvasElement>(null);
  const yearRef = useRef<HTMLCanvasElement>(null);
  const indRef = useRef<HTMLCanvasElement>(null);
  const [axis, setAxis] = useState<StateAxis>(defaultAxis ?? axes[0].value);
  const [horizon, setHorizon] = useState(5);
  const [entry, setEntry] = useState<"close" | "open">("close");

  const result = useMemo(() => {
    if (prices.length < minBars) return null;
    const st = buildStateFn(prices, axis);
    return conditionalForwardReturns(prices, st, horizon, { entry });
  }, [prices, axis, horizon, entry, minBars]);

  const indicator = useMemo<StateSeries | null>(
    () => (prices.length >= minBars ? buildStateSeries(prices, axis) : null),
    [prices, axis, minBars]
  );

  useEffect(() => {
    if (!result || result.buckets.length === 0) return;
    if (barRef.current) {
      const init = initCanvas(barRef.current, 40 + result.buckets.length * 30);
      if (init) drawDivergingBars(init.ctx, init.width, init.height, result.buckets, result.nowLabel);
    }
    if (yearRef.current) {
      const init = initCanvas(yearRef.current, 40 + result.buckets.length * 26);
      if (init) drawYearStrip(init.ctx, init.width, init.height, result.buckets);
    }
  }, [result]);

  useEffect(() => {
    if (!indicator || !indRef.current) return;
    const init = initCanvas(indRef.current, 150);
    if (init) drawIndicator(init.ctx, init.width, init.height, indicator, prices.map((p) => p.time));
  }, [indicator, prices]);

  if (prices.length < minBars || !result) return null;

  const hasBuckets = result.buckets.length > 0;
  const maxAbs = Math.max(1e-9, ...result.buckets.map((b) => Math.abs(b.meanFwd)));
  const nowBucket = result.buckets.find((b) => b.label === result.nowLabel) ?? null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">{title}</h3>
        <div className="flex gap-1">
          {(["close", "open"] as const).map((e) => (
            <button
              key={e}
              onClick={() => setEntry(e)}
              className={`px-2.5 py-1 text-xs rounded font-medium ${entry === e ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {e === "close" ? "当日引け建て" : "翌日寄り建て"}
            </button>
          ))}
        </div>
      </div>

      {/* 状態軸 */}
      <div className="flex gap-1 flex-wrap">
        {axes.map((a) => (
          <button
            key={a.value}
            onClick={() => setAxis(a.value)}
            className={`px-2.5 py-1 text-xs rounded font-medium ${axis === a.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >
            {a.label}
          </button>
        ))}
      </div>

      {/* ホライズン */}
      <div className="flex items-center gap-2 text-xs text-gray-600">
        <span>先行き日数 N:</span>
        {HORIZONS.map((h) => (
          <button
            key={h}
            onClick={() => setHorizon(h)}
            className={`px-2 py-0.5 rounded ${horizon === h ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
          >
            {h}日
          </button>
        ))}
        <span className="ml-auto text-gray-400">全標本 {result.totalN}日 / 基準平均 {fmtPct(result.baselineMean)}・勝率 {(result.baselineWin * 100).toFixed(0)}%</span>
      </div>

      {/* 判定指標の推移（なぜその状態かを可視化） */}
      {indicator ? (
        <div className="relative"><canvas ref={indRef} /></div>
      ) : (
        <p className="text-[11px] text-gray-400">この軸（{axes.find((a) => a.value === axis)?.label}）は数値指標として表示できないため、推移グラフは省略します。</p>
      )}

      {/* 現在バナー */}
      {nowBucket && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          <span className="font-bold">現在の状態: {result.nowLabel}</span>
          {" → "}過去同状態の{horizon}日先は{" "}
          <span className="font-bold">平均 {fmtPct(nowBucket.meanFwd)}</span>・勝率{" "}
          <span className="font-bold">{(nowBucket.winRate * 100).toFixed(0)}%</span>
          {" "}（n={nowBucket.n}、95%CI {fmtPct(nowBucket.ciLow)}〜{fmtPct(nowBucket.ciHigh)}）{" "}
          <StatBadge n={nowBucket.n} p={nowBucket.p} significant={nowBucket.significant} />
        </div>
      )}

      {!hasBuckets && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-900">
          この期間・この軸では集計対象のサンプルがありません（「{axes.find((a) => a.value === axis)?.label}」は十分な履歴が必要です）。
          上の指標推移は表示されています。期間を長くするか、別の軸（RSI(2)・前日リターン等）をお試しください。
        </div>
      )}

      {/* 表 */}
      {hasBuckets && (<>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 px-2">状態</th>
              <th className="text-right px-2">n</th>
              <th className="text-right px-2">平均{horizon}日</th>
              <th className="text-right px-2">中央値</th>
              <th className="text-left px-2">勝率</th>
              <th className="text-right px-2">σ</th>
              <th className="text-left px-2">95%CI</th>
              <th className="text-left px-2">有意性</th>
            </tr>
          </thead>
          <tbody>
            {result.buckets.map((b) => {
              const isNow = b.label === result.nowLabel;
              return (
                <tr
                  key={b.label}
                  className={`border-b border-gray-100 ${isNow ? "ring-2 ring-blue-400 ring-inset" : ""}`}
                >
                  <td className="py-1 px-2 font-medium text-gray-700">
                    {isNow && <span className="text-blue-600 mr-1">◀</span>}
                    {b.label}
                  </td>
                  <td className="text-right px-2 text-gray-600">{b.n}</td>
                  <td className="text-right px-2 font-medium" style={{ background: retBg(b.meanFwd, maxAbs) }}>
                    {fmtPct(b.meanFwd)}
                  </td>
                  <td className="text-right px-2 text-gray-600">{fmtPct(b.medianFwd)}</td>
                  <td className="px-2">
                    <div className="flex items-center gap-1">
                      <div className="relative h-3 w-14 bg-gray-100 rounded-sm overflow-hidden">
                        <div
                          className={`absolute inset-y-0 left-0 ${b.winRate >= 0.5 ? "bg-green-400" : "bg-red-400"}`}
                          style={{ width: `${b.winRate * 100}%` }}
                        />
                        <div className="absolute inset-y-0 left-1/2 w-px bg-gray-400" />
                      </div>
                      <span className="text-gray-600 tabular-nums">{(b.winRate * 100).toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="text-right px-2 text-gray-500">{(b.stdFwd * 100).toFixed(2)}%</td>
                  <td className="px-2 text-gray-500 whitespace-nowrap">{fmtPct(b.ciLow)}〜{fmtPct(b.ciHigh)}</td>
                  <td className="px-2"><StatBadge n={b.n} p={b.p} significant={b.significant} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="relative"><canvas ref={barRef} /></div>
      <div className="relative"><canvas ref={yearRef} /></div>
      </>)}

      <AnalysisGuide title="状態→先行きリターン表の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"『いまこの状態（RSIの帯・ボラの大小・200日線からの乖離・トレンドの強さ）にあるとき、その先N日でどれだけ上がり/下がりやすいか』を、過去の全該当日から集計する。各分析がバラバラに出していた断片を、共通の“条件付き期待値”の枠で統一して提示する。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算（先読みバイアスを排除）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>状態</strong>: i 日の終値時点で確定する情報だけで判定（RSI(14)・直近20日実現ボラの3分位・200日SMA乖離・Kaufman効率比＋20日傾き）。</li>
          <li><strong>フォワードリターン</strong>: r = (exit − entry) / entry。当日引け建てなら entry=当日C・exit=N日後C。翌日寄り建てなら entry=翌日O・exit=N日後の翌日O。</li>
          <li><strong>勝率</strong>: r&gt;0 の割合。<strong>平均</strong>と<strong>中央値</strong>を併記（外れ値の影響を判断）。</li>
          <li><strong>95%CI</strong>: 移動ブロック・ブートストラップ（系列相関に頑健）。</li>
          <li><strong>有意性</strong>: 平均=0 の1標本t検定 → 複数バケットを Benjamini-Hochberg FDR で多重比較補正。pAdj&lt;0.05 を「有意」。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>条件付き期待値</strong>: 「Aという条件のもとでのリターンの平均」。無条件の平均より状況に即した期待値。</li>
          <li><strong>Kaufman効率比</strong>: 純変化÷変化の総量。1に近いほど一直線（強トレンド）、0に近いほどジグザグ（レンジ）。トレンドの“純度”の物差し。</li>
          <li><strong>FDR</strong>: 多数のバケットを同時に検定すると偶然の“当たり”が混ざる。その偽発見の割合を抑える補正。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>上部の<strong>現在バナー</strong>＝今日の状態での過去成績。これがそのまま「今この状況で何が起きやすいか」。</li>
          <li>平均が基準平均（全標本）より明確に高く、勝率＞50%、かつ<strong>有意</strong>なバケット＝エッジのある状況。順張り/逆張りの根拠に。</li>
          <li>下段の<strong>年次持続性</strong>で緑（プラス年）が安定して続くか確認。最近だけ赤ならアノマリーは減衰している。</li>
          <li>σ（分散）が大きいバケットはストップを広め・サイズ小さめに。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>「参考(n小)」のバケットは標本が少なく平均が不安定。重視しない。</li>
          <li>取引コスト・スリッページは未控除。短いNでは特に効く。</li>
          <li>状態境界（RSI=30 等）は固定値。境界付近は誤差が出やすい。</li>
          <li>有意でも経済的に意味のある大きさかは別問題（統計的有意≠実用的有意）。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
