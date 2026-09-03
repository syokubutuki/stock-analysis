"use client";

// σ は続くが μ は続かない ― (σ, μ) 平面での前半→後半の矢印。
//
// 設計の由来と、設計時に踏んだ間違い（反転率を頑健さの証拠に使いかけた件）は
// app/lib/mu-sigma-persistence.ts の冒頭に書いてある。要点だけ:
//
//   ・μ の順位相関は実測で 0.00。過去の μ ランキングは将来について何も言わない。
//   ・σ の順位相関は 0.42（Pearson 0.775）。水準は全体に上がるが順位は残る。
//   ・壁越え判定の反転が少なくても「頑健」ではない。margin（SE単位の余裕）で見ること。
//
// 横軸 σ・縦軸 μ の静的な散布図なので、規約どおり Canvas2D で描く（時間軸ではない）。

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { muSigmaPersistence, type PersistenceRow } from "../../lib/mu-sigma-persistence";
import { niceTicks, placeRect, type LabelRect } from "../../lib/axis-scale";
import { CHART_COLORS, DIRECTION_TEXT_CLASS } from "../../lib/chart-colors";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  tickers: string[];
  pricesByTicker: Record<string, PricePoint[]>;
  names?: Record<string, string>;
}

const pct = (x: number, d = 1) => (isFinite(x) ? `${(x * 100).toFixed(d)}%` : "—");
const pp = (x: number, d = 1) => (isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}pp` : "—");
const num = (x: number, d = 2) => (isFinite(x) ? x.toFixed(d) : "—");

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  if (width <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = CHART_COLORS.surface;
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

/** 短い銘柄名。ラベルが長いと平面が読めなくなる */
function shortName(r: PersistenceRow): string {
  const base = r.name.replace(/\s*(CORPORATION|CORP|GROUP|HOLDINGS|INC|LTD|CO)\.?\s*/gi, " ").trim();
  return (base || r.ticker).slice(0, 12);
}

export default function MuSigmaPersistenceChart({ tickers, pricesByTicker, names }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [showErrorBars, setShowErrorBars] = useState(true);

  const res = useMemo(
    () =>
      muSigmaPersistence(
        tickers
          .filter((t) => (pricesByTicker[t]?.length ?? 0) > 2)
          .map((t) => ({ ticker: t, name: names?.[t] ?? t, prices: pricesByTicker[t] }))
      ),
    [tickers, pricesByTicker, names]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || res.rows.length < 3) return;
    const draw = () => {
    const init = initCanvas(canvas, 380);
    if (!init) return;
    const { ctx, width, height } = init;
    const padL = 52;
    const padR = 16;
    const padT = 26;
    const padB = 36;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    // 定義域。誤差棒を出すときは棒の端まで入れる
    const xs = res.rows.flatMap((r) => [r.sigma1, r.sigma2]);
    const ys = res.rows.flatMap((r) =>
      showErrorBars
        ? [r.mu1 - r.seMu1, r.mu1 + r.seMu1, r.mu2 - r.seMu2, r.mu2 + r.seMu2]
        : [r.mu1, r.mu2]
    );
    let xMin = Math.min(0, ...xs);
    let xMax = Math.max(...xs);
    let yMin = Math.min(0, ...ys);
    let yMax = Math.max(...ys);
    const xPad = (xMax - xMin) * 0.08 || 0.02;
    const yPad = (yMax - yMin) * 0.08 || 0.02;
    xMin = Math.max(0, xMin - xPad);
    xMax += xPad;
    yMin -= yPad;
    yMax += yPad;

    const xOf = (v: number) => padL + ((v - xMin) / (xMax - xMin)) * plotW;
    const yOf = (v: number) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    // 複利ゼロ線 μ = σ²/2。この下は現物フルで持っても増えない領域
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(xOf(xMin), yOf(yMin));
    for (let px = 0; px <= plotW; px += 2) {
      const s = xMin + (px / plotW) * (xMax - xMin);
      ctx.lineTo(padL + px, yOf(Math.min(yMax, (s * s) / 2)));
    }
    ctx.lineTo(xOf(xMax), yOf(yMin));
    ctx.closePath();
    ctx.fillStyle = "rgba(220,38,38,0.06)";
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = "#7c3aed";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let px = 0; px <= plotW; px += 2) {
      const s = xMin + (px / plotW) * (xMax - xMin);
      const y = yOf((s * s) / 2);
      if (px === 0) ctx.moveTo(padL + px, y);
      else ctx.lineTo(padL + px, y);
    }
    ctx.stroke();

    // ゼロ線
    if (yMin < 0 && yMax > 0) {
      ctx.strokeStyle = CHART_COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, yOf(0));
      ctx.lineTo(padL + plotW, yOf(0));
      ctx.stroke();
    }

    // 誤差棒（後半の点にだけ。両方に出すと矢印が読めなくなる）
    if (showErrorBars) {
      ctx.strokeStyle = "rgba(30,58,138,0.35)";
      ctx.lineWidth = 1.2;
      for (const r of res.rows) {
        const x = xOf(r.sigma2);
        ctx.beginPath();
        ctx.moveTo(x, yOf(r.mu2 - r.seMu2));
        ctx.lineTo(x, yOf(r.mu2 + r.seMu2));
        ctx.stroke();
      }
    }

    // 矢印（前半 → 後半）
    for (const r of res.rows) {
      const x1 = xOf(r.sigma1), y1 = yOf(r.mu1);
      const x2 = xOf(r.sigma2), y2 = yOf(r.mu2);
      const up = r.dMu >= 0;
      ctx.strokeStyle = up ? "rgba(22,163,74,0.75)" : "rgba(220,38,38,0.75)";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      // 矢じり
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const h = 7;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - h * Math.cos(ang - 0.4), y2 - h * Math.sin(ang - 0.4));
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - h * Math.cos(ang + 0.4), y2 - h * Math.sin(ang + 0.4));
      ctx.stroke();
      // 始点（白抜き）と終点（塗り）
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = CHART_COLORS.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x1, y1, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = r.flipped ? "#dc2626" : "#1e3a8a";
      ctx.beginPath();
      ctx.arc(x2, y2, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // ラベル（衝突回避。埋まったら描かない＝脇役の作法は EfficientFrontierChart と同じ）。
    // 候補は終点の右→左→上→下の順。placeRect は採用した矩形を placed に push する。
    const placed: LabelRect[] = [];
    ctx.font = "10px sans-serif";
    for (const r of res.rows) {
      const label = shortName(r);
      const w = ctx.measureText(label).width + 4;
      const h = 12;
      const x = xOf(r.sigma2);
      const y = yOf(r.mu2);
      const candidates: LabelRect[] = [
        { x: x + 7, y: y - h / 2, w, h },
        { x: x - 7 - w, y: y - h / 2, w, h },
        { x: x - w / 2, y: y - 7 - h, w, h },
        { x: x - w / 2, y: y + 7, w, h },
      ].filter((c) => c.x >= padL && c.x + c.w <= padL + plotW && c.y >= padT && c.y + c.h <= padT + plotH);
      const rect = placeRect(candidates, placed, 2);
      if (!rect) continue;
      ctx.fillStyle = r.flipped ? "#b91c1c" : CHART_COLORS.ink;
      ctx.fillText(label, rect.x + 2, rect.y + 9);
    }

    // 軸
    ctx.strokeStyle = CHART_COLORS.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.stroke();
    ctx.fillStyle = CHART_COLORS.ink;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (const v of niceTicks(xMin, xMax, 5)) {
      ctx.fillText(`${(v * 100).toFixed(0)}%`, xOf(v), padT + plotH + 15);
    }
    ctx.textAlign = "right";
    for (const v of niceTicks(yMin, yMax, 5)) {
      ctx.fillText(`${(v * 100).toFixed(0)}%`, padL - 5, yOf(v) + 3);
    }
    ctx.textAlign = "left";
    ctx.fillText("σ（年率ボラティリティ）", padL, height - 4);
    ctx.font = "bold 10px sans-serif";
    ctx.fillStyle = "#6d28d9";
    ctx.fillText("紫の線 = 複利ゼロ線 μ=σ²/2（この下は増えない）", padL, 14);
    ctx.fillStyle = CHART_COLORS.ink;
    ctx.font = "10px sans-serif";
    ctx.save();
    ctx.translate(12, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("μ̂（年率算術平均）", 0, 0);
    ctx.restore();
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [res, showErrorBars]);

  if (res.rows.length < 3) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4 text-xs text-gray-600 leading-relaxed">
        <div className="font-bold text-gray-800 mb-1">σ は続くが μ は続かない：前半→後半で銘柄はどう動くか</div>
        <p>
          <strong>この分析は出せません。</strong>前半・後半に割るには
          <strong>全銘柄に共通する値動きが2年ぶん</strong>必要ですが、ウォッチリストに
          上場の新しい銘柄が多く、共通期間が足りません。
          {res.excluded.length > 0 && <>（{res.excluded.join("・")} を除外しても届きませんでした。）</>}
          上場から2年以上たった銘柄が3つ以上そろうと表示されます。
        </p>
      </div>
    );
  }

  // 順位相関そのものの標準誤差 ≈ 1/√(N−1)。N が小さいと 0.4 と 0.0 の差は誤差に
  // 埋もれるので、断定文を出す前に「この標本で判定できるか」を要求する。
  // 固定閾値（旧: |ρ|<0.25）だけだと、3銘柄でも同じ強さで言い切ってしまう。
  const seRho = 1 / Math.sqrt(Math.max(1, res.rows.length - 1));
  const decisive = res.rows.length >= 9; // seRho ≦ 0.354
  const muUseless = decisive && Math.abs(res.spearmanMu) < seRho;
  const sigmaHolds = decisive && res.spearmanSigma > seRho;
  const marginWeak = res.medMargin < 1;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div>
        <h3 className="font-bold text-gray-800">σ は続くが μ は続かない：前半→後半で銘柄はどう動くか</h3>
        <p className="text-xs text-gray-500 mt-1">
          共通日付で整列した {res.rows.length} 銘柄を、前半（{res.from1}〜{res.to1}）と
          後半（{res.from2}〜{res.to2}）に分割（各 {res.halfYears.toFixed(1)} 年）。
          白丸＝前半、色付き丸＝後半。
          {res.excluded.length > 0 && (
            <span className="block mt-1 text-amber-700">
              上場が新しく共通期間を縮めるため、{res.excluded.join("・")} を除外しています。
            </span>
          )}
        </p>
      </div>

      {/* ── 結論の2数字 ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
        <div className="p-2 rounded border border-blue-200 bg-blue-50">
          <div className="text-gray-500">σ の順位相関</div>
          <div className="font-mono font-bold text-base">{num(res.spearmanSigma)}</div>
          <div className="text-gray-500 text-[10px]">Pearson {num(res.pearsonSigma)}</div>
        </div>
        <div className="p-2 rounded border border-red-200 bg-red-50">
          <div className="text-gray-500">μ̂ の順位相関</div>
          <div className="font-mono font-bold text-base">{num(res.spearmanMu)}</div>
          <div className="text-gray-500 text-[10px]">Pearson {num(res.pearsonMu)}</div>
        </div>
        <div className="p-2 rounded border border-gray-200 bg-gray-50">
          <div className="text-gray-500">動いた量（中央値）</div>
          <div className="font-mono font-bold">|Δμ| {pct(res.medAbsDMu)}</div>
          <div className="text-gray-500 text-[10px]">|Δσ| {pct(res.medAbsDSigma)}</div>
        </div>
        <div className="p-2 rounded border border-amber-200 bg-amber-50">
          <div className="text-gray-500">Δμ / 推定誤差</div>
          <div className="font-mono font-bold text-base">{num(res.noiseRatio)}</div>
          <div className="text-gray-500 text-[10px]">≈1 なら誤差だけで説明できる</div>
        </div>
      </div>

      <div className="rounded border border-gray-300 bg-gray-50 p-3 text-xs leading-relaxed space-y-1.5">
        {!decisive && (
          <p>
            <strong className="text-amber-700">
              銘柄が {res.rows.length} 件しかないため、σ と μ̂ の順位相関を比べられません。
            </strong>
            順位相関それ自体の標準誤差が およそ ±{num(seRho)} あり、
            σ（{num(res.spearmanSigma)}）と μ̂（{num(res.spearmanMu)}）の差はこの誤差に飲まれます。
            <strong>9銘柄以上</strong>そろえてから読んでください。
          </p>
        )}
        {muUseless && (
          <p>
            <strong className="text-red-700">
              μ̂ の順位相関 {num(res.spearmanMu)} は、この銘柄数での誤差 ±{num(seRho)} と区別がつきません。
            </strong>
            つまり<strong>前半の μ の順位は、後半の μ について情報を持っていない</strong>ということです。
            「期待リターンの高い銘柄を選ぶ」は、この平面の上では実行できない操作です。
          </p>
        )}
        {sigmaHolds && (
          <p>
            一方 <strong className="text-blue-700">σ の順位相関 {num(res.spearmanSigma)} は誤差 ±{num(seRho)} より大きい</strong>。
            水準は全体で {pp(res.medDSigma)} 動きましたが、順位は保たれました。
            <strong>全員の身長が伸びても背の順は変わらない</strong>、という形です。
          </p>
        )}
        {isFinite(res.noiseRatio) && (
          <p>
            Δμ の大きさは推定誤差 √(SE₁²+SE₂²) の <strong>{num(res.noiseRatio)} 倍</strong>。
            {res.noiseRatio < 1.5 ? (
              <>
                {" "}つまり μ の暴れ方は<strong>推定誤差だけでほぼ説明できます</strong>。
                μ が本当に動いたのではなく、<strong>そもそも測れていない</strong>ということです。
              </>
            ) : (
              <>
                {" "}誤差だけでは説明できない大きさなので、μ は<strong>本当に動いています</strong>。
                いずれにせよ過去の μ から将来の μ は読めません。
              </>
            )}
          </p>
        )}
      </div>

      <label className="flex items-center gap-1.5 text-xs">
        <input type="checkbox" checked={showErrorBars} onChange={(e) => setShowErrorBars(e.target.checked)} />
        <span className="text-gray-700">後半の点に μ̂ の ±1SE 誤差棒を出す</span>
      </label>

      <div className="relative">
        <canvas ref={canvasRef} />
      </div>
      <p className="text-[11px] text-gray-600 -mt-2 leading-relaxed">
        {res.medAbsDMu > res.medAbsDSigma * 1.5 ? (
          <>
            縦（μ）の移動が横（σ）の {(res.medAbsDMu / Math.max(res.medAbsDSigma, 1e-9)).toFixed(1)} 倍で、
            矢印は<strong>縦に長く飛びます</strong>（中央値 |Δμ| {pct(res.medAbsDMu)} 対 |Δσ| {pct(res.medAbsDSigma)}）。
          </>
        ) : (
          <>
            この期間は<strong>横（σ）も一緒に動いています</strong>
            （中央値 |Δμ| {pct(res.medAbsDMu)} 対 |Δσ| {pct(res.medAbsDSigma)}）。
            σ の<strong>水準</strong>が全体でずれた期間なので、矢印は斜めに飛びます。
            それでも順位が保たれるかは上の順位相関で読んでください。
          </>
        )}
        誤差棒を出すと、縦の移動が<strong>誤差棒とほぼ同じ長さ</strong>であることが分かります。
        紫の線より下は複利で増えない領域です。
      </p>

      {/* ── 反転と判定余裕 ───────────────────────────────────────── */}
      <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs space-y-2">
        <div className="font-bold text-amber-900">壁越えの判定はどれだけ持ちこたえたか</div>
        <p className="text-amber-900 leading-relaxed">
          前半と後半で「μ̂ &gt; σ²/2」の判定が反転したのは <strong>{res.nFlipped}/{res.rows.length} 銘柄</strong>。
          {marginWeak ? (
            <>
              {" "}
              <strong>ただしこれを「判定が頑健だった」と読んではいけません。</strong>
              壁からの距離を SE(μ̂) 単位で測ると中央値でわずか <strong>{num(res.medMargin)}SE</strong> しかなく、
              反転しなかったのは頑健だったからではなく、
              <strong>たまたま両期間とも μ̂ が壁の同じ側に落ちただけ</strong>です。
            </>
          ) : (
            <>
              {" "}壁からの距離は中央値で {num(res.medMargin)}SE あり、判定はある程度の余裕を持っています。
            </>
          )}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {res.buckets.map((b) => (
            <div key={b.label} className="p-2 rounded border border-amber-300 bg-white">
              <div className="text-gray-500 text-[11px]">{b.label}（n={b.n}）</div>
              <div className="font-mono">
                反転 {b.flipped}/{b.n}　平均の壁 {pct(b.meanHurdle)}　判定余裕 {num(b.medMargin)}SE
              </div>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-amber-800 leading-relaxed">
          判定余裕は <span className="font-mono">margin = (μ−σ²/2)/(σ/√T) = √T·(μ/σ − σ/2)</span>。
          <strong>σ の減少関数</strong>なので、低ボラ銘柄ほど判定が誤差に強くなります。
          これが「低ボラを選ぶ」ことの厳密な根拠で、「ドラッグを避けるため」ではありません。
          ただし現実の水準では 1SE を切ることが多く、<strong>どの銘柄でも判定は誤差に飲まれています</strong>。
        </p>
      </div>

      {/* ── 明細表 ─────────────────────────────────────────────── */}
      <div className="overflow-x-auto">
        <table className="text-[11px] border-collapse min-w-full">
          <thead>
            <tr className="bg-gray-50">
              <th className="border border-gray-200 px-2 py-1 text-left">銘柄</th>
              <th className="border border-gray-200 px-2 py-1">σ 前半→後半</th>
              <th className="border border-gray-200 px-2 py-1">Δσ</th>
              <th className="border border-gray-200 px-2 py-1">μ̂ 前半→後半</th>
              <th className="border border-gray-200 px-2 py-1">Δμ</th>
              <th className="border border-gray-200 px-2 py-1">壁 前半→後半</th>
              <th className="border border-gray-200 px-2 py-1">判定余裕(SE)</th>
              <th className="border border-gray-200 px-2 py-1">壁越え</th>
            </tr>
          </thead>
          <tbody>
            {[...res.rows]
              .sort((a, b) => a.sigma1 - b.sigma1)
              .map((r) => (
                <tr key={r.ticker} className={r.flipped ? "bg-red-50" : ""}>
                  <th className="border border-gray-200 px-2 py-1 text-left font-normal whitespace-nowrap">
                    {shortName(r)}
                    <span className="ml-1 text-gray-400 font-mono">{r.ticker}</span>
                  </th>
                  <td className="border border-gray-200 px-2 py-1 text-center font-mono">
                    {pct(r.sigma1, 0)}→{pct(r.sigma2, 0)}
                  </td>
                  <td className={`border border-gray-200 px-2 py-1 text-center font-mono ${r.dSigma >= 0 ? DIRECTION_TEXT_CLASS.down : DIRECTION_TEXT_CLASS.up}`}>
                    {pp(r.dSigma)}
                  </td>
                  <td className="border border-gray-200 px-2 py-1 text-center font-mono">
                    {pct(r.mu1, 0)}→{pct(r.mu2, 0)}
                  </td>
                  <td className={`border border-gray-200 px-2 py-1 text-center font-mono font-bold ${r.dMu >= 0 ? DIRECTION_TEXT_CLASS.up : DIRECTION_TEXT_CLASS.down}`}>
                    {pp(r.dMu)}
                  </td>
                  <td className="border border-gray-200 px-2 py-1 text-center font-mono text-gray-500">
                    {pct(r.hurdle1)}→{pct(r.hurdle2)}
                  </td>
                  <td className={`border border-gray-200 px-2 py-1 text-center font-mono ${r.margin1 < 1 ? "text-amber-700" : ""}`}>
                    {num(r.margin1)}
                  </td>
                  <td className="border border-gray-200 px-2 py-1 text-center">
                    {r.above1 ? "○" : "×"}→{r.above2 ? "○" : "×"}
                    {r.flipped && <span className="ml-1 font-bold text-red-700">反転</span>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <AnalysisGuide title="σ と μ の持続性の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          「期待リターンの高い銘柄を選ぶ」という操作が実行可能かどうかを、横断データで直接確かめます。
          個別銘柄の <code>sim-kelly</code> は推定誤差の式から「μ は測れない」を示しましたが、
          あれは理屈です。ここでは<strong>実際に前半と後半で順位が保たれるか</strong>を測ります。
        </p>
        <p>
          同時に σ を対照として並べます。σ と μ で結果が違うことが本質で、
          片方だけを見ても「推定が難しい」以上のことは言えません。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式（省略なし）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>μ</strong>：年率算術平均リターン。<strong>σ</strong>：年率ボラティリティ。</li>
          <li><strong>T</strong>：各半分の暦年数。<strong>n</strong>：各半分の観測本数。</li>
        </ul>
        <p className="mt-2">
          <strong>(a) 推定誤差の非対称性。</strong>独立同分布のもとで
        </p>
        <p className="font-mono text-center my-1">SE(μ̂) = σ/√T,  SE(σ̂) ≈ σ/√(2n)</p>
        <p>
          日足なら n = 252T なので比は √504 ≈ 22.4 で一定。<strong>μ の推定は σ の推定より必ず約22倍粗い</strong>。
          この非対称性が、横断では「順位が保たれるかどうか」の差として現れます。
        </p>
        <p className="mt-2">
          <strong>(b) 順位相関。</strong>前半の推定値ベクトルと後半の推定値ベクトルの
          Spearman 順位相関を取ります。真の値が銘柄間で異なり、かつ時間で安定なら正になります。
          推定誤差が真の散らばりを圧倒すると 0 に近づきます。
          Pearson も併記しますが、<strong>外れ値1銘柄で大きく動く</strong>ので順位相関を主に読んでください。
        </p>
        <p className="mt-2">
          <strong>(c) Δμ が誤差で説明できるか。</strong>前半と後半の推定は独立なので、
          差の標準偏差は
        </p>
        <p className="font-mono text-center my-1">SD(μ̂₂ − μ̂₁) = √(SE₁² + SE₂²)</p>
        <p>
          実測の |Δμ| の中央値をこれで割った比を出します。<strong>1に近ければ
          「μ は動いていないが測れていない」</strong>、1より大きければ「μ が本当に動いた」。
          どちらでも「過去の μ から将来の μ は読めない」という結論は変わりません。
        </p>
        <p className="mt-2">
          <strong>(d) 判定余裕（margin）。</strong>現物フルで複利がプラスになる条件は μ &gt; σ²/2 です。
          この判定が推定誤差にどれだけ耐えるかは
        </p>
        <p className="font-mono text-center my-1">margin = (μ − σ²/2) / (σ/√T) = √T · (μ/σ − σ/2)</p>
        <p>
          σ で微分すると <span className="font-mono">−√T·(μ/σ² + 1/2) &lt; 0</span> なので、
          <strong>margin は σ の減少関数</strong>です。σ を下げると壁 σ²/2 が二乗で下がる一方、
          誤差 σ/√T は一乗でしか下がらないため、正味で判定が誤差に強くなります。
          <strong>これが「低ボラを選ぶ」ことの厳密な根拠</strong>で、
          「ボラティリティドラッグを避けるため」ではありません。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 専門用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>順位相関（Spearman）</strong>：値そのものではなく順位で測る相関。外れ値に強い。</li>
          <li><strong>持続性</strong>：ある期間で測った量が、次の期間でも同じ順序を保つ性質。</li>
          <li><strong>複利ゼロ線</strong>：μ = σ²/2 の放物線。これより下は現物フルで持っても増えない。</li>
          <li><strong>判定余裕（margin）</strong>：壁からの距離を推定の標準誤差で割ったもの。単位はSE。</li>
          <li><strong>共通日付整列</strong>：全銘柄に存在する日付だけを使って揃えること。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          <strong>身長と体調。</strong>クラスの生徒を毎年測ると、身長（σ）の順位はほぼそのまま残ります。
          全員が伸びても背の順は変わりません。一方その日の体調（μ）の順位は毎年入れ替わります。
          <strong>「去年いちばん元気だった子」は、今年について何も教えてくれません。</strong>
        </p>
        <p className="mt-2">
          そして重要なのは、体調の順位が入れ替わる理由が「本当に変わったから」とは限らないことです。
          体温計の誤差が個人差より大きければ、真の体調が一定でも順位はランダムに入れ替わります。
          Δμ / 推定誤差の比は、この2つを区別するための指標です。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>μ の順位相関が 0 付近なら、銘柄選択を μ で行うのは不可能です。</strong>
            これは「難しい」ではなく「情報がない」という意味です。
          </li>
          <li>
            <strong>σ の順位相関が正なら、σ による選択は実行可能です。</strong>
            ただし水準は動くので、絶対値ではなく順位で使ってください。
          </li>
          <li>
            <strong>反転率だけで頑健性を判断しないこと。</strong>反転が少なくても
            判定余裕が 1SE を切っていれば、それは頑健だったのではなく偶然です。
            必ず margin の列と一緒に読んでください。
          </li>
          <li>
            <strong>矢印が垂直に近いほど、話は単純です。</strong>
            横（σ）が動かず縦（μ）だけ動くなら、選択に使える情報は横軸にしかありません。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>銘柄選択の基準を、順位が保たれる量に置く。</strong>σ・流動性・
            ファクター感応度 b は測れて順位も残ります。μ は残りません。
          </li>
          <li>
            <strong>低ボラを選ぶ理由を言い換える。</strong>「ドラッグが小さいから」ではなく
            「越えるべき壁が低く、判定が推定誤差に強いから」。前者は実データで反証されますが、
            後者は σ の減少関数として常に成立します。
          </li>
          <li>
            <strong>過去リターン上位のスクリーニングを疑う。</strong>そのランキングの
            順位相関が 0 なら、上位銘柄は「たまたま上がった銘柄」の一覧に過ぎません。
          </li>
          <li>
            <strong>分散はこの平面で左に動く操作です。</strong>組み合わせると σ が下がり、
            紫の線から遠ざかります。相関を無視するとその移動が小さくなる話は
            「相関を無視すると成長率が削られる」のパネル群を参照してください。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>銘柄数がウォッチリストの数しかありません。</strong>順位相関はそれ自体の
            標準誤差が およそ 1/√(N−1) あり、10〜20銘柄では 0.4 と 0.0 の差が
            有意にならないことがあります。この標本では <strong>±{num(seRho)}</strong> です。
            上の結論文はこの誤差を超えたときだけ出し、8銘柄以下では
            <strong>結論そのものを出しません</strong>。符号と桁で読んでください。
          </li>
          <li>
            <strong>2分割は分割点の選び方に依存します。</strong>異なる点で割れば数値は動きます。
            結論（μ の順位相関が σ より大幅に低い）は頑健ですが、個々の数値は点推定です。
          </li>
          <li>
            <strong>生存者バイアス。</strong>いま保有・監視している銘柄だけを見ているので、
            上場廃止や大幅下落で外れた銘柄が含まれません。真の識別限界は表示よりさらに厳しくなります。
          </li>
          <li>
            <strong>SE の式は独立同分布を仮定しています。</strong>実際にはボラティリティ・
            クラスタリングがあるので、真の SE はここに出る値より大きくなります。
          </li>
          <li>
            <strong>σ の順位が残ることは「σ が予測できる」を意味しません。</strong>
            順位が残るのは、真の σ の銘柄間差が推定誤差より大きいからです。
            将来の σ の水準そのものはレジームで動きます（実測でも全体が {pp(res.medDSigma)} 動きました）。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
