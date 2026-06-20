"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useIntraday } from "../../hooks/useIntraday";
import { computeVwap, VwapResult } from "../../lib/vwap-analysis";
import {
  initCanvas, fmtPct, fmtSignedPct, IntervalButtons, ViewTabs, LoadingError,
  StatCell, IntradayCaveat,
} from "./intradayShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

type View = "sample" | "buckets";
const VIEWS: { value: View; label: string }[] = [
  { value: "sample", label: "VWAPバンド（直近日）" },
  { value: "buckets", label: "乖離Z→先行リターン" },
];
const HORIZONS = [3, 6, 12];

function drawSample(ctx: CanvasRenderingContext2D, W: number, H: number, r: VwapResult) {
  const s = r.sample;
  if (!s) return;
  const ml = 50, mr = 16, mt = 26, mb = 26;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const n = s.price.length;
  const all = [...s.price, ...s.upper2, ...s.lower2];
  const vmax = Math.max(...all), vmin = Math.min(...all);
  const pad = (vmax - vmin) * 0.05 || 1;
  const ys = (v: number) => mt + plotH - ((v - vmin + pad) / (vmax - vmin + 2 * pad)) * plotH;
  const xs = (i: number) => ml + (i / Math.max(1, n - 1)) * plotW;

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`VWAP±1σ/±2σ バンドと価格（${s.date}）`, ml, mt - 12);
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(vmax.toFixed(1), ml - 4, mt + 9);
  ctx.fillText(vmin.toFixed(1), ml - 4, mt + plotH);

  const line = (vals: number[], color: string, width: number, dash: number[] = []) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = xs(i), y = ys(vals[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke(); ctx.setLineDash([]);
  };
  line(s.upper2, "#fca5a5", 1, [3, 3]);
  line(s.lower2, "#fca5a5", 1, [3, 3]);
  line(s.upper1, "#93c5fd", 1, [2, 2]);
  line(s.lower1, "#93c5fd", 1, [2, 2]);
  line(s.vwap, "#7c3aed", 2);
  line(s.price, "#111827", 2);

  // 時刻ラベル（端と中央）
  ctx.fillStyle = "#6b7280"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
  [0, Math.floor(n / 2), n - 1].forEach((i) => ctx.fillText(s.labels[i], xs(i), mt + plotH + 14));
  ctx.textAlign = "left";
  ctx.fillStyle = "#7c3aed"; ctx.fillText("― VWAP", ml + 4, mt + 12);
  ctx.fillStyle = "#111827"; ctx.fillText("― 価格", ml + 60, mt + 12);
}

function drawBuckets(ctx: CanvasRenderingContext2D, W: number, H: number, r: VwapResult) {
  const ml = 50, mr = 16, mt = 28, mb = 40;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const n = r.buckets.length;
  const slot = plotW / n;
  const vals = r.buckets.map((b) => b.meanFwdPct);
  const amax = Math.max(0.01, ...vals.map(Math.abs));
  const y0 = mt + plotH / 2;
  const ys = (v: number) => y0 - (v / amax) * (plotH / 2 - 6);

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`VWAP乖離Z 別の ${r.horizonBars}バー先 平均リターン`, ml, mt - 12);
  ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(ml, y0); ctx.lineTo(ml + plotW, y0); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(`+${amax.toFixed(3)}%`, ml - 4, mt + 9);
  ctx.fillText(`-${amax.toFixed(3)}%`, ml - 4, mt + plotH);

  const barW = Math.max(4, slot * 0.5);
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    const x = ml + i * slot + (slot - barW) / 2;
    const yv = ys(v);
    ctx.fillStyle = v >= 0 ? "#16a34a" : "#dc2626";
    ctx.fillRect(x, Math.min(y0, yv), barW, Math.abs(yv - y0));
    ctx.fillStyle = "#374151"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(r.buckets[i].label, ml + i * slot + slot / 2, mt + plotH + 14);
    ctx.fillStyle = "#9ca3af";
    ctx.fillText(`n=${r.buckets[i].n}`, ml + i * slot + slot / 2, mt + plotH + 26);
  }
}

export default function VwapDeviationChart({ ticker }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [intervalKey, setIntervalKey] = useState("5m");
  const [view, setView] = useState<View>("sample");
  const [horizon, setHorizon] = useState(6);
  const { resp, loading, error } = useIntraday(ticker, intervalKey);

  const res = useMemo<VwapResult | null>(
    () => (resp ? computeVwap(resp.bars, resp.gmtoffset, horizon) : null),
    [resp, horizon]
  );

  useEffect(() => {
    if (!canvasRef.current || !res) return;
    const H = 340;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width } = init;
    if (view === "sample") drawSample(ctx, width, H, res);
    else drawBuckets(ctx, width, H, res);
  }, [view, res]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">VWAP乖離分析（回帰か継続か）</h3>
        <IntervalButtons value={intervalKey} onChange={setIntervalKey}
          options={[{ value: "5m", label: "5分足" }, { value: "15m", label: "15分足" }, { value: "30m", label: "30分足" }]} />
      </div>
      <ViewTabs value={view} onChange={setView} views={VIEWS} />
      <LoadingError loading={loading} error={error} />

      {!loading && !error && res && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-xs text-gray-500">対象 {res.nDays} 営業日 / {resp?.interval} 足</div>
            <span className="text-xs text-gray-400">｜先行 {res.horizonBars} バー:</span>
            {HORIZONS.map((h) => (
              <button key={h} onClick={() => setHorizon(h)}
                className={`px-2 py-0.5 text-xs rounded ${horizon === h ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{h}</button>
            ))}
          </div>

          <div className="relative"><canvas ref={canvasRef} /></div>

          {view === "buckets" && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="text-left py-1">乖離Z</th>
                      <th className="text-right">n</th>
                      <th className="text-right">平均先行R</th>
                      <th className="text-right">中央値</th>
                      <th className="text-right">勝率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.buckets.map((b) => (
                      <tr key={b.label} className="border-b border-gray-100">
                        <td className="py-1 font-medium">{b.label}</td>
                        <td className="text-right">{b.n}</td>
                        <td className={`text-right ${b.meanFwdPct >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(b.meanFwdPct / 100)}</td>
                        <td className={`text-right ${b.medianFwdPct >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(b.medianFwdPct / 100)}</td>
                        <td className="text-right">{fmtPct(b.winRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
                {"乖離Zが負（VWAP下方）のバケットで先行リターンがプラスなら平均回帰（押し目買いが効く）、Zが正でさらにプラスならトレンド（順張り継続）。両端で符号が逆なら明確な平均回帰、同符号ならトレンド地合い。"}
              </p>
            </>
          )}

          {view === "sample" && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <StatCell label="VWAP上抜け後 追随" value={fmtPct(res.crossUpFollow)} tone="up" />
              <StatCell label="（上抜けn）" value={`${res.crossUpN}`} />
              <StatCell label="VWAP下抜け後 追随" value={fmtPct(res.crossDownFollow)} tone="down" />
              <StatCell label="（下抜けn）" value={`${res.crossDownN}`} />
            </div>
          )}

          <IntradayCaveat extra="VWAPは日次リセット・15分遅延のためライブ運用には不向き。" />
        </>
      )}

      <AnalysisGuide title="VWAP乖離分析の詳細理論">
        <p className="font-medium text-gray-700">1. VWAPとは</p>
        <p>
          {"VWAP（Volume Weighted Average Price, 出来高加重平均価格）は、その日の約定を出来高で重み付けした平均値。機関投資家の平均的な約定コストの基準とされ、価格がVWAPからどれだけ離れているかは『買われ過ぎ/売られ過ぎ』の日内指標になる。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>典型価格 TP=(H+L+C)/3、VWAP_t = Σ_{`{i≤t}`}(TP_i·V_i) / Σ_{`{i≤t}`}V_i（各営業日で寄りからリセット）。</li>
          <li>乖離 dev_t=(C_t−VWAP_t)/VWAP_t。当日内の乖離標準偏差 σ_dev で標準化 z_t=dev_t/σ_dev（VWAPバンド±1σ/±2σに相当）。</li>
          <li>各時刻のzをバケット化し、hバー先リターン ln(C_{`{t+h}`}/C_t) の平均・勝率を集計。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Z負バケットの先行Rがプラス → 平均回帰。VWAP下方への乖離は買い候補。</li>
          <li>Z正バケットの先行Rもプラス → トレンド。VWAP上方でも追随する。</li>
          <li>上抜け/下抜け後の追随率が高ければVWAPブレイクが有効なシグナル。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>押し目買い: 平均回帰が確認できる銘柄でZ&lt;−1を買い場の目安に。</li>
          <li>利確: Z&gt;+2など過大乖離で利確を急ぐ判断材料に。</li>
          <li>執行: VWAP近辺はコスト基準。機関の動きに沿った約定の目安。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"トレンド日はVWAP回帰が効かず一方向に離れ続ける。レジーム判定と併用すること。"}</li>
          <li>{"出来高ゼロのバーや薄商い銘柄ではVWAPが不安定。"}</li>
          <li>{"Yahoo日中足は約15分遅延。当日のライブ判断には遅延を見込む。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
