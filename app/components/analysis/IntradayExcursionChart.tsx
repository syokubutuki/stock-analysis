"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useIntraday } from "../../hooks/useIntraday";
import { computeExcursion, ExcursionResult, Direction } from "../../lib/intraday-excursion";
import {
  initCanvas, fmtPct, IntervalButtons, ViewTabs, LoadingError,
  StatCell, IntradayCaveat,
} from "./intradayShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

type View = "dist" | "grid";
const VIEWS: { value: View; label: string }[] = [
  { value: "dist", label: "MFE/MAE分布" },
  { value: "grid", label: "TP/SL最適化" },
];

function drawDist(ctx: CanvasRenderingContext2D, W: number, H: number, r: ExcursionResult) {
  const ml = 40, mr = 16, mt = 24, gap = 36;
  const plotW = W - ml - mr;
  const paneH = (H - mt - gap - 20) / 2;

  const pane = (hist: { center: number; count: number }[], top: number, color: string, title: string) => {
    const n = hist.length;
    if (n === 0) return;
    const slot = plotW / n;
    const barW = Math.max(2, slot * 0.8);
    const maxC = Math.max(1, ...hist.map((b) => b.count));
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, top, plotW, paneH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(title, ml, top - 7);
    for (let i = 0; i < n; i++) {
      const h = (hist[i].count / maxC) * (paneH - 6);
      const x = ml + i * slot + (slot - barW) / 2;
      ctx.fillStyle = color; ctx.fillRect(x, top + paneH - h, barW, h);
      if (i % Math.ceil(n / 8) === 0) {
        ctx.fillStyle = "#9ca3af"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
        ctx.fillText(hist[i].center.toFixed(1), x + barW / 2, top + paneH + 11);
      }
    }
  };
  pane(r.mfeHist, mt, "#16a34acc", "MFE 最大含み益の分布（%）");
  pane(r.maeHist, mt + paneH + gap, "#dc2626cc", "MAE 最大含み損の分布（%）");
}

function drawGrid(ctx: CanvasRenderingContext2D, W: number, H: number, r: ExcursionResult) {
  const ml = 70, mr = 16, mt = 30, mb = 30;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const rows = r.tpLevels.length, cols = r.slLevels.length;
  const cw = plotW / cols, ch = plotH / rows;
  let amax = 0;
  for (const row of r.grid) for (const c of row) amax = Math.max(amax, Math.abs(c.expR));
  amax = Math.max(0.1, amax);

  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("TP×SL 別の期待R（緑=プラス, 枠=最良）", ml, mt - 14);
  ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("損切りSL →", ml + plotW / 2, mt + plotH + 22);
  ctx.save(); ctx.translate(ml - 52, mt + plotH / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText("利確TP →", 0, 0); ctx.restore();

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const c = r.grid[i][j];
      const x = ml + j * cw, y = mt + i * ch;
      const t = Math.min(1, Math.abs(c.expR) / amax);
      ctx.fillStyle = c.expR >= 0 ? `rgba(22,163,74,${0.12 + t * 0.8})` : `rgba(220,38,38,${0.12 + t * 0.8})`;
      ctx.fillRect(x, y, cw - 1, ch - 1);
      ctx.fillStyle = "#111827"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(c.expR.toFixed(2), x + cw / 2, y + ch / 2 + 3);
      if (r.best && Math.abs(c.tpPct - r.best.tpPct) < 1e-6 && Math.abs(c.slPct - r.best.slPct) < 1e-6) {
        ctx.strokeStyle = "#111827"; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, cw - 3, ch - 3);
      }
    }
    ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(`${r.tpLevels[i].toFixed(2)}%`, ml - 4, mt + i * ch + ch / 2 + 3);
  }
  for (let j = 0; j < cols; j++) {
    ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`${r.slLevels[j].toFixed(2)}%`, ml + j * cw + cw / 2, mt + plotH + 11);
  }
}

export default function IntradayExcursionChart({ ticker }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [intervalKey, setIntervalKey] = useState("5m");
  const [view, setView] = useState<View>("dist");
  const [direction, setDirection] = useState<Direction>("long");
  const { resp, loading, error } = useIntraday(ticker, intervalKey);

  const res = useMemo<ExcursionResult | null>(
    () => (resp ? computeExcursion(resp.bars, resp.gmtoffset, direction) : null),
    [resp, direction]
  );

  useEffect(() => {
    if (!canvasRef.current || !res) return;
    const H = view === "grid" ? 320 : 340;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width } = init;
    if (view === "dist") drawDist(ctx, width, H, res);
    else drawGrid(ctx, width, H, res);
  }, [view, res]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">当日内 MFE/MAE と TP/SL最適化</h3>
        <IntervalButtons value={intervalKey} onChange={setIntervalKey} />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <ViewTabs value={view} onChange={setView} views={VIEWS} />
        <div className="flex gap-1">
          {(["long", "short"] as Direction[]).map((d) => (
            <button key={d} onClick={() => setDirection(d)}
              className={`px-2 py-0.5 text-xs rounded ${direction === d ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
              {d === "long" ? "ロング(寄り買い)" : "ショート(寄り売り)"}
            </button>
          ))}
        </div>
      </div>
      <LoadingError loading={loading} error={error} />

      {!loading && !error && res && (
        <>
          <div className="text-xs text-gray-500">対象 {res.nDays} 営業日 / 寄りエントリー / 日中レンジ中央値 {res.medRangePct.toFixed(2)}%</div>
          <div className="relative"><canvas ref={canvasRef} /></div>

          {view === "dist" && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <StatCell label="MFE 平均" value={`${res.meanMfePct.toFixed(2)}%`} tone="up" />
              <StatCell label="MFE 中央値" value={`${res.medMfePct.toFixed(2)}%`} tone="up" />
              <StatCell label="MAE 平均" value={`${res.meanMaePct.toFixed(2)}%`} tone="down" />
              <StatCell label="MAE 中央値" value={`${res.medMaePct.toFixed(2)}%`} tone="down" />
            </div>
          )}

          {view === "grid" && res.best && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <StatCell label="最良 利確TP" value={`${res.best.tpPct.toFixed(2)}%`} />
              <StatCell label="最良 損切りSL" value={`${res.best.slPct.toFixed(2)}%`} />
              <StatCell label="期待R" value={res.best.expR.toFixed(2)} tone={res.best.expR >= 0 ? "up" : "down"} />
              <StatCell label="勝率" value={fmtPct(res.best.winRate)} />
            </div>
          )}

          <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
            {view === "dist"
              ? "MFE=エントリー後の最大含み益、MAE=最大含み損。MFE分布が右に厚ければ利確を引っ張る余地があり、MAE分布の裾が深ければ損切りを浅くするとヒゲで切られやすい。両者のバランスでTP/SL水準を設計する。"
              : "各セル=その利確TP×損切りSLで寄りエントリーを当日経路に適用した期待R（=損益/SL）。緑が濃いほど期待値が高い。黒枠=最良の組合せ。同一バーでTP/SL両方ヒット時はSL優先の保守的評価。"}
          </p>
          <IntradayCaveat extra="格子の最良点はサンプル内最適のため過剰最適化に注意（要サンプル外検証）。" />
        </>
      )}

      <AnalysisGuide title="MFE/MAE・TP/SL最適化の詳細理論">
        <p className="font-medium text-gray-700">1. MFE/MAEとは</p>
        <p>{"MFE（Maximum Favorable Excursion, 最大有利変動）はエントリー後にどれだけ含み益が伸びたかの最大値、MAE（Maximum Adverse Excursion, 最大不利変動）はどれだけ含み損を抱えたかの最大値。トレード中の『最大のプラス/マイナス』の分布を見ることで、利確目標と損切り幅の妥当な水準を逆算できる。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>エントリー価格 E=当日寄り。ロングなら MFE=max_t(High_t−E)/E、MAE=min_t(Low_t−E)/E。ショートは符号反転。</li>
          <li>R倍数: 各日の損益 ÷ 損切り幅SL。期待R=平均R倍数。利確TP・SLは日中レンジ中央値の倍率で格子化。</li>
          <li>格子探索: バーを時系列に走査し、先にSL価格へ触れたら−SL、TP価格へ触れたら+TP、どちらも無ければ引けで決済（時間切り）。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>MFE中央値が大きい→利確を引っ張れる余地。小さい→早めの利確が有利。</li>
          <li>MAEの裾が深い→浅いSLはヒゲで切られやすい。適度な余裕が必要。</li>
          <li>TP/SL格子の緑の濃いセルが安定して並ぶ領域が実戦的な水準。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>日計りの利確/損切り水準の設計。期待Rが最大化される付近を起点に。</li>
          <li>時間切り（引け手仕舞い）を併用すると持ち越しリスクを避けられる。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"格子の最良点はサンプル内での最適化。サンプル外（別期間）で再現するかの確認が不可欠（過剰最適化の罠）。"}</li>
          <li>{"同一バー内のTP/SL同時ヒットはSL優先の保守的評価。実際の約定順序は不明。"}</li>
          <li>{"5分足の解像度では、バー内の到達順序やスリッページは捨象される。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
