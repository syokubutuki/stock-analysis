"use client";

// ケリー基準の最適建玉 f* と、その「決まらなさ」。
//
// ## この作り替えの理由（2026-08-31）
//
// 旧版は `kellyOptimal()` の点推定を1つ出すだけだった（f* と半ケリーの縦線、g(f) の放物線）。
// σ が小さい銘柄では無害だが、実測すると次のようになる。
//
//   285A.T（キオクシア, 上場1.6年）: μ̂=264% σ=103% → **f* = 250%（信用2.5倍を推奨）**
//   8306.T（三菱UFJ, 10年）:        μ̂=27%  σ=28%  → **f* = 334%（信用3.3倍を推奨）**
//
// 高ボラ銘柄だけの問題ではない。**退屈な銀行株にも3.3倍を勧めていた。**
// 旧版の防御は `kellyFraction > 2` のとき文言に「リスクが高い」と一行足すだけだった。
//
// 原因は f* = μ/σ² の μ が測れないことにある。σ は測れる。この非対称性は定数で、
// 日足なら **SE(μ̂)/SE(σ̂) = √(2·252) = 22.4 倍**（銘柄にも期間にも依存しない）。
//
// よってこのパネルは f* の値を「答え」として出さない。出すのは次の3つである。
//   ① 越えるべき壁 σ²/2 と、μ̂ の誤差棒を同じ数直線に並べる（誤差棒のほうが長い）
//   ② μ の前提を動かすと f* がどこまで動くか（g(f) 放物線の束）
//   ③ 「複利プラスを主張するために信じる必要がある年率」＝壁、への翻訳
//
// 横軸は f や年率リターンで時間軸ではないので、規約どおり Canvas2D で描く。

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { seriesStats } from "../../lib/holding-ledger";
import {
  kellyAt,
  growthAtF,
  wallAndError,
  requiredBelief,
  yearsToResolve,
  frequencyLadder,
  sensitivityRows,
} from "../../lib/kelly-uncertainty";
import { doublingYears, doublingYearsLabel } from "../../lib/growth-drag";
import { niceTicks } from "../../lib/axis-scale";
import { CHART_COLORS } from "../../lib/chart-colors";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const pct = (x: number, d = 1) => (isFinite(x) ? `${(x * 100).toFixed(d)}%` : "—");
const pp = (x: number, d = 1) => (isFinite(x) ? `${(x * 100).toFixed(d)}pp` : "—");

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

export default function KellyChart({ prices }: Props) {
  const wallRef = useRef<HTMLCanvasElement>(null);
  const curveRef = useRef<HTMLCanvasElement>(null);

  const stats = useMemo(() => seriesStats(prices), [prices]);
  const ladder = useMemo(() => frequencyLadder(prices), [prices]);

  // 「あなたの前提」。既定は株式のリスクプレミアム相当（6%）。
  // 実測 μ̂ を既定にすると、また点推定を答えとして提示することになるので、そうしない。
  const [beliefPct, setBeliefPct] = useState(6);
  const belief = beliefPct / 100;

  const wall = useMemo(() => (stats ? wallAndError(stats) : null), [stats]);
  const rows = useMemo(() => (stats ? sensitivityRows(stats, belief) : null), [stats, belief]);
  const beliefYears = useMemo(
    () => (stats ? yearsToResolve(belief, stats.sigma) : Infinity),
    [stats, belief]
  );

  // ── ① 壁と誤差棒（ヒーロー） ──────────────────────────────────────
  useEffect(() => {
    const canvas = wallRef.current;
    if (!canvas || !stats || !wall) return;
    const draw = () => {
    const init = initCanvas(canvas, 132);
    if (!init) return;
    const { ctx, width, height } = init;
    const padL = 12;
    const padR = 12;
    const padT = 30;
    const padB = 26;
    const plotW = width - padL - padR;
    const midY = padT + (height - padT - padB) / 2;

    let lo = Math.min(0, wall.ciLo, wall.hurdle);
    let hi = Math.max(wall.ciHi, wall.hurdle * 1.15, 0);
    const span = hi - lo || 0.1;
    lo -= span * 0.08;
    hi += span * 0.08;
    const xOf = (v: number) => padL + ((v - lo) / (hi - lo)) * plotW;

    // 壁の左右で背景を塗り分ける。左＝複利で増えない領域。
    const xw = Math.max(padL, Math.min(padL + plotW, xOf(wall.hurdle)));
    ctx.fillStyle = "#fef2f2";
    ctx.fillRect(padL, padT, xw - padL, height - padT - padB);
    ctx.fillStyle = "#f0fdf4";
    ctx.fillRect(xw, padT, padL + plotW - xw, height - padT - padB);

    // ゼロ線
    if (0 > lo && 0 < hi) {
      ctx.strokeStyle = CHART_COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xOf(0), padT);
      ctx.lineTo(xOf(0), padT + (height - padT - padB));
      ctx.stroke();
    }

    // 壁 σ²/2
    ctx.strokeStyle = "#7c3aed";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(xw, padT);
    ctx.lineTo(xw, padT + (height - padT - padB));
    ctx.stroke();
    ctx.fillStyle = "#6d28d9";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = xw > padL + plotW * 0.6 ? "right" : "left";
    ctx.fillText(`複利ゼロ線 σ²/2 = ${pct(wall.hurdle)}`, xw + (xw > padL + plotW * 0.6 ? -6 : 6), padT - 16);
    ctx.font = "10px sans-serif";
    ctx.fillStyle = CHART_COLORS.ink;
    ctx.fillText("← この左は増えない", xw + (xw > padL + plotW * 0.6 ? -6 : 6), padT - 4);

    // μ̂ の誤差棒（±2SE 細 / ±1SE 太）
    const clampX = (v: number) => Math.max(padL, Math.min(padL + plotW, xOf(v)));
    ctx.strokeStyle = "#1e3a8a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(clampX(stats.muArith - 2 * wall.seMu), midY);
    ctx.lineTo(clampX(stats.muArith + 2 * wall.seMu), midY);
    ctx.stroke();
    for (const s of [-2, 2]) {
      const x = clampX(stats.muArith + s * wall.seMu);
      ctx.beginPath();
      ctx.moveTo(x, midY - 7);
      ctx.lineTo(x, midY + 7);
      ctx.stroke();
    }
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(clampX(stats.muArith - wall.seMu), midY);
    ctx.lineTo(clampX(stats.muArith + wall.seMu), midY);
    ctx.stroke();
    ctx.fillStyle = "#1e3a8a";
    ctx.beginPath();
    ctx.arc(clampX(stats.muArith), midY, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`μ̂ = ${pct(stats.muArith)}`, clampX(stats.muArith), midY - 14);
    ctx.font = "10px sans-serif";
    ctx.fillStyle = CHART_COLORS.ink;
    ctx.fillText(`±1SE ${pp(wall.seMu)}（太）／ ±2SE（細）`, clampX(stats.muArith), midY + 24);

    // 目盛り
    ctx.strokeStyle = CHART_COLORS.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + (height - padT - padB));
    ctx.lineTo(padL + plotW, padT + (height - padT - padB));
    ctx.stroke();
    ctx.fillStyle = CHART_COLORS.ink;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (const v of niceTicks(lo, hi, 6)) {
      const x = xOf(v);
      ctx.beginPath();
      ctx.moveTo(x, padT + (height - padT - padB));
      ctx.lineTo(x, padT + (height - padT - padB) + 4);
      ctx.stroke();
      ctx.fillText(`${(v * 100).toFixed(0)}%`, x, padT + (height - padT - padB) + 15);
    }
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [stats, wall]);

  // ── ② g(f) の束 ──────────────────────────────────────────────────
  useEffect(() => {
    const canvas = curveRef.current;
    if (!canvas || !stats || !wall) return;
    const draw = () => {
    const init = initCanvas(canvas, 290);
    if (!init) return;
    const { ctx, width, height } = init;
    const padL = 50;
    const padR = 14;
    const padT = 26;
    const padB = 34;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const hat = kellyAt(stats.muArith, stats.sigma);
    const fMax = Math.min(8, Math.max(2.5, hat.ruinF * 1.25));
    const zs = [-2, -1, 0, 1, 2];
    const mus = zs.map((z) => stats.muArith + z * wall.seMu);

    let gHi = -Infinity;
    let gLo = Infinity;
    for (const m of mus) {
      for (let i = 0; i <= 40; i++) {
        const g = growthAtF(m, stats.sigma, (i / 40) * fMax);
        if (g > gHi) gHi = g;
        if (g < gLo) gLo = g;
      }
    }
    gHi = Math.max(gHi, 0.02);
    gLo = Math.min(gLo, 0);
    const gPad = (gHi - gLo) * 0.08;
    gHi += gPad;
    gLo -= gPad;

    const xOf = (f: number) => padL + (f / fMax) * plotW;
    const yOf = (g: number) => padT + plotH - ((g - gLo) / (gHi - gLo)) * plotH;

    // f* の帯（μ̂ の95%CIから）
    const fLo = Math.max(0, Math.min(fMax, kellyAt(wall.ciLo, stats.sigma).fStar));
    const fHi = Math.max(0, Math.min(fMax, kellyAt(wall.ciHi, stats.sigma).fStar));
    if (fHi > fLo) {
      ctx.fillStyle = "#dbeafe";
      ctx.fillRect(xOf(fLo), padT, xOf(fHi) - xOf(fLo), plotH);
    }

    // ±2SE の帯（曲線の間を塗る）
    const curve = (m: number) => {
      const pts: [number, number][] = [];
      for (let px = 0; px <= plotW; px += 2) {
        const f = (px / plotW) * fMax;
        pts.push([padL + px, yOf(growthAtF(m, stats.sigma, f))]);
      }
      return pts;
    };
    const top = curve(mus[4]);
    const bot = curve(mus[0]);
    ctx.fillStyle = "rgba(37,99,235,0.10)";
    ctx.beginPath();
    top.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    for (let i = bot.length - 1; i >= 0; i--) ctx.lineTo(bot[i][0], bot[i][1]);
    ctx.closePath();
    ctx.fill();

    // ゼロ線
    ctx.strokeStyle = CHART_COLORS.reference;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, yOf(0));
    ctx.lineTo(padL + plotW, yOf(0));
    ctx.stroke();
    ctx.setLineDash([]);

    // 5本の曲線
    zs.forEach((z, i) => {
      ctx.strokeStyle = z === 0 ? "#1d4ed8" : "#93c5fd";
      ctx.lineWidth = z === 0 ? 2.5 : 1;
      ctx.beginPath();
      curve(mus[i]).forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
    });

    // 縦線マーカー
    const vline = (f: number, color: string, label: string, dash: boolean, level: number) => {
      if (!(f > 0) || f > fMax) return;
      const x = xOf(f);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      if (dash) ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = "bold 10px sans-serif";
      const flip = x > padL + plotW * 0.65;
      ctx.textAlign = flip ? "right" : "left";
      ctx.fillText(label, x + (flip ? -4 : 4), padT + 11 + level * 12);
    };
    vline(1, CHART_COLORS.neutral, "現物フル 100%", true, 0);
    vline(hat.fStar, "#1d4ed8", `実測 f* ${pct(hat.fStar, 0)}`, false, 1);
    vline(hat.ruinF, "#dc2626", `破産線 ${pct(hat.ruinF, 0)}`, true, 2);
    const bf = kellyAt(belief, stats.sigma).fStar;
    vline(bf, "#b45309", `あなたの前提 ${pct(bf, 0)}`, false, 3);

    // 軸
    ctx.strokeStyle = CHART_COLORS.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();
    ctx.fillStyle = CHART_COLORS.ink;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (let i = 0; i <= 4; i++) {
      const f = (i / 4) * fMax;
      ctx.fillText(`${(f * 100).toFixed(0)}%`, xOf(f), padT + plotH + 15);
    }
    ctx.textAlign = "right";
    for (const v of niceTicks(gLo, gHi, 4)) {
      ctx.fillText(`${(v * 100).toFixed(0)}%`, padL - 5, yOf(v) + 3);
    }
    ctx.textAlign = "left";
    ctx.fillText("建玉 f（自己資本比）", padL, height - 4);
    ctx.font = "bold 10px sans-serif";
    ctx.fillStyle = "#1d4ed8";
    ctx.fillText("g(f) ＝ 年率成長率。帯は μ̂ の ±2SE", padL, 14);
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [stats, wall, belief]);

  if (!stats || !wall || !rows) return null;

  const hat = kellyAt(stats.muArith, stats.sigma);
  const beliefPoint = kellyAt(belief, stats.sigma);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div>
        <h3 className="font-bold text-gray-800">ケリー基準の最適建玉 f*：複利の壁 σ²/2 と μ の誤差棒</h3>
        <p className="text-xs text-gray-500 mt-1">
          {stats.from} 〜 {stats.to}（{stats.n}営業日 = {stats.years.toFixed(1)}年）。
          期間セレクタを動かすと、σ はほとんど変わらないのに <strong>SE(μ̂) だけが大きく動きます</strong>。
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
        <div className="p-2 rounded border border-blue-200 bg-blue-50">
          <div className="text-gray-500">μ̂（年率算術）</div>
          <div className="font-mono font-bold">{pct(stats.muArith)}</div>
          <div className="text-gray-500 text-[10px]">±{pp(wall.seMu)}</div>
        </div>
        <div className="p-2 rounded border border-gray-200 bg-gray-50">
          <div className="text-gray-500">σ（年率）</div>
          <div className="font-mono font-bold">{pct(stats.sigma)}</div>
          <div className="text-gray-500 text-[10px]">±{pp(wall.seSigma, 2)}</div>
        </div>
        <div className="p-2 rounded border border-purple-200 bg-purple-50">
          <div className="text-gray-500">壁 σ²/2</div>
          <div className="font-mono font-bold">{pct(wall.hurdle)}</div>
          <div className="text-gray-500 text-[10px]">越えないと増えない</div>
        </div>
        <div className="p-2 rounded border border-gray-200 bg-gray-50">
          <div className="text-gray-500">g(建玉100%)</div>
          <div className="font-mono font-bold">{pct(hat.gAtOne)}</div>
          <div className="text-gray-500 text-[10px]">倍化 {doublingYearsLabel(doublingYears(hat.gAtOne))}</div>
        </div>
        <div className="p-2 rounded border border-amber-200 bg-amber-50">
          <div className="text-gray-500">精度比 SE(μ̂)/SE(σ̂)</div>
          <div className="font-mono font-bold">{wall.precisionRatio.toFixed(0)}倍</div>
          <div className="text-gray-500 text-[10px]">日足なら常に √504</div>
        </div>
        <div className="p-2 rounded border border-gray-200 bg-gray-50">
          <div className="text-gray-500">t（μ̂ vs 壁）</div>
          <div className="font-mono font-bold">{wall.t.toFixed(2)}</div>
          <div className="text-gray-500 text-[10px]">95%CI {pct(wall.ciLo, 0)}〜{pct(wall.ciHi, 0)}</div>
        </div>
      </div>

      {/* ── ① 壁と誤差棒 ─────────────────────────────────────────── */}
      <div className="space-y-1">
        <div className="text-xs font-bold text-gray-800">① 越えるべき壁と、測定の分解能</div>
        <div className="relative">
          <canvas ref={wallRef} />
        </div>
        <div
          className={`text-xs rounded border p-2.5 leading-relaxed space-y-1.5 ${
            wall.verdict === "above"
              ? "border-green-300 bg-green-50 text-green-900"
              : wall.verdict === "below"
                ? "border-red-300 bg-red-50 text-red-900"
                : "border-amber-300 bg-amber-50 text-amber-900"
          }`}
        >
          <p>
            {wall.verdict === "undecidable" && (
              <>
                <strong>95%信頼区間（{pct(wall.ciLo, 0)}〜{pct(wall.ciHi, 0)}）が壁をまたいでいます。</strong>
                「この銘柄は複利で増える」を<strong>測定では主張できません</strong>。
              </>
            )}
            {wall.verdict === "below" && (
              <>
                <strong>95%信頼区間の上端（{pct(wall.ciHi, 0)}）が壁（{pct(wall.hurdle)}）に届いていません。</strong>
                この期間に限れば、現物フルで持つと<strong>複利ではマイナス</strong>だったということです。
              </>
            )}
            {wall.verdict === "aboveButImprecise" && (
              <>
                95%信頼区間（{pct(wall.ciLo, 0)}〜{pct(wall.ciHi, 0)}）は壁を越えています（t={wall.t.toFixed(2)}）。
                ただし<strong>誤差棒（±{pp(wall.seMu)}）が壁（{pct(wall.hurdle)}）そのものより大きい</strong>。
                つまり<strong>増えるかどうかは言えても、どれだけ増えるかは決まっていません</strong>。
                下の f* が数倍の幅で動くのはこのためです。
              </>
            )}
            {wall.verdict === "above" && (
              <>
                95%信頼区間（{pct(wall.ciLo, 0)}〜{pct(wall.ciHi, 0)}）は壁を越えており、
                誤差棒（±{pp(wall.seMu)}）も壁（{pct(wall.hurdle)}）より小さい。
                この期間に限れば、水準もある程度は絞れています。
              </>
            )}
          </p>
          {wall.shortSample && (
            <p className="text-[11px]">
              <strong>ただし標本は {stats.years.toFixed(1)} 年しかありません。</strong>
              t 値を額面どおり読まないでください。1つの相場つきしか見ていない可能性が高く、
              上場からの期間が短い銘柄では、実現した高い成長率は「その期間そうだった」以上の意味を持ちません。
            </p>
          )}
        </div>
      </div>

      {/* ── 必要な信念 ───────────────────────────────────────────── */}
      <div className="rounded border border-amber-300 bg-amber-50 p-3 space-y-2">
        <div className="text-xs font-bold text-amber-900">必要な信念への翻訳</div>
        <p className="text-xs text-amber-900 leading-relaxed">
          この銘柄が複利でプラスになると主張するには、将来の年率期待リターンが
          <strong className="mx-1 font-mono text-sm">{pct(requiredBelief(stats.sigma))}</strong>
          以上だと<strong>信じる</strong>必要があります。これは σ だけで決まるので正確に測れます。
          いくらだと信じるかは、測定では決まりません。
        </p>
        <label className="block space-y-1">
          <span className="text-xs text-amber-900">
            あなたの前提：<strong className="font-mono">{beliefPct}%</strong>
            {belief < requiredBelief(stats.sigma) && (
              <strong className="ml-2 text-red-700">← 壁に届かない（複利ではマイナス）</strong>
            )}
          </span>
          <input
            type="range"
            min={-10}
            max={80}
            step={1}
            value={beliefPct}
            onChange={(e) => setBeliefPct(Number(e.target.value))}
            className="w-full"
            aria-label="将来の期待リターンの前提（年率%）"
          />
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
          <div className="p-2 rounded border border-amber-300 bg-white">
            <div className="text-gray-500">この前提での f*</div>
            <div className="font-mono font-bold">{pct(beliefPoint.fStar, 0)}</div>
          </div>
          <div className="p-2 rounded border border-amber-300 bg-white">
            <div className="text-gray-500">この前提での g(100%)</div>
            <div className="font-mono font-bold">{pct(beliefPoint.gAtOne)}</div>
          </div>
          <div className="p-2 rounded border border-amber-300 bg-white">
            <div className="text-gray-500">壁越えの決着に必要な年数</div>
            <div className="font-mono font-bold">
              {isFinite(beliefYears) ? `${beliefYears < 1000 ? beliefYears.toFixed(0) : "1000超"}年` : "永遠に無理"}
            </div>
          </div>
        </div>
        <p className="text-[11px] text-amber-800 leading-relaxed">
          「決着に必要な年数」は T* = (κσ/Δμ)²（κ=2、Δμ = 前提 − 壁）。前提が壁以下なら、
          どれだけ待っても示せません。同じ式は横断ダッシュボードの「個別ドリフトの識別限界」でも使っています。
        </p>
      </div>

      {/* ── ② g(f) の束 ─────────────────────────────────────────── */}
      <div className="space-y-1">
        <div className="text-xs font-bold text-gray-800">② 最適建玉 f* は μ の誤差でどこまで動くか</div>
        <div className="relative">
          <canvas ref={curveRef} />
        </div>
        <p className="text-[11px] text-gray-600 leading-relaxed">
          放物線 g(f) = μf − σ²f²/2 を μ̂ の ±2SE で束にしたもの。
          <strong>σ は一本も動かしていません</strong>（曲がり具合が全部同じなのはそのため）。
          動いているのは μ だけで、それだけで頂点の位置＝最適建玉が水色の帯の幅ぶん動きます。
        </p>
      </div>

      {/* ── f* 感度表 ───────────────────────────────────────────── */}
      <div className="space-y-1">
        <div className="text-xs font-bold text-gray-800">③ μ の前提ごとの f*（σ は固定）</div>
        <div className="overflow-x-auto">
          <table className="text-[11px] border-collapse min-w-full">
            <thead>
              <tr className="bg-gray-50">
                <th className="border border-gray-200 px-2 py-1 text-left">μ の前提</th>
                <th className="border border-gray-200 px-2 py-1">μ</th>
                <th className="border border-gray-200 px-2 py-1">f* = μ/σ²</th>
                <th className="border border-gray-200 px-2 py-1">半ケリー</th>
                <th className="border border-gray-200 px-2 py-1">g(建玉100%)</th>
                <th className="border border-gray-200 px-2 py-1">倍化年数</th>
                <th className="border border-gray-200 px-2 py-1">破産線</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={r.assumed ? "bg-amber-50" : ""}>
                  <th className="border border-gray-200 px-2 py-1 text-left font-normal">
                    {r.label}
                    {r.assumed && <span className="ml-1 px-1 rounded bg-amber-200 text-amber-900">仮定</span>}
                  </th>
                  <td className="border border-gray-200 px-2 py-1 text-center font-mono">{pct(r.point.mu)}</td>
                  <td
                    className={`border border-gray-200 px-2 py-1 text-center font-mono font-bold ${
                      r.point.fStar > 1 || r.point.fStar < 0 ? "text-red-700" : ""
                    }`}
                  >
                    {pct(r.point.fStar, 0)}
                  </td>
                  <td className="border border-gray-200 px-2 py-1 text-center font-mono">{pct(r.point.halfKelly, 0)}</td>
                  <td className="border border-gray-200 px-2 py-1 text-center font-mono">{pct(r.point.gAtOne)}</td>
                  <td className="border border-gray-200 px-2 py-1 text-center font-mono">
                    {doublingYearsLabel(doublingYears(r.point.gAtOne))}
                  </td>
                  <td className="border border-gray-200 px-2 py-1 text-center font-mono">{pct(r.point.ruinF, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-gray-500">
          赤字は建玉100%超（＝信用取引が必要）と、負の f*。<strong>実測 μ̂ をそのまま入れると、多くの銘柄で
          レバレッジを推奨する値が出ます</strong>。それは銘柄が良いからではなく、μ̂ が
          「その期間に上がった」以上の意味を持たないからです。
          f* が負の行は「その前提なら買いではなく売り」という意味で、②の図には縦線を描いていません。
        </p>
      </div>

      {/* ── 頻度ラダー ──────────────────────────────────────────── */}
      {ladder.length >= 2 && (
        <div className="space-y-1">
          <div className="text-xs font-bold text-gray-800">
            ④ 細かく見れば μ が分かるのか（同じ期間を集計し直す）
          </div>
          <div className="overflow-x-auto">
            <table className="text-[11px] border-collapse min-w-full">
              <thead>
                <tr className="bg-gray-50">
                  <th className="border border-gray-200 px-2 py-1 text-left">集計</th>
                  <th className="border border-gray-200 px-2 py-1">本数</th>
                  <th className="border border-gray-200 px-2 py-1">μ（対数・年率）</th>
                  <th className="border border-gray-200 px-2 py-1">SE(μ̂)</th>
                  <th className="border border-gray-200 px-2 py-1">σ（年率）</th>
                  <th className="border border-gray-200 px-2 py-1" title="日次σに対する (σ_k/σ_1)²。1から離れるほど平均回帰/トレンドがある">
                    分散比
                  </th>
                  <th className="border border-gray-200 px-2 py-1">SE(σ̂)</th>
                </tr>
              </thead>
              <tbody>
                {ladder.map((r) => (
                  <tr key={r.days}>
                    <th className="border border-gray-200 px-2 py-1 text-left font-normal bg-gray-50">{r.label}</th>
                    <td className="border border-gray-200 px-2 py-1 text-center font-mono">{r.nObs}</td>
                    <td className="border border-gray-200 px-2 py-1 text-center font-mono">{pct(r.muLogAnn)}</td>
                    <td className="border border-gray-200 px-2 py-1 text-center font-mono font-bold">±{pp(r.seMuAnn)}</td>
                    <td className="border border-gray-200 px-2 py-1 text-center font-mono">{pct(r.sigmaAnn)}</td>
                    <td
                      className={`border border-gray-200 px-2 py-1 text-center font-mono ${
                        isFinite(r.varianceRatio) && Math.abs(r.varianceRatio - 1) > 0.2 ? "text-amber-700 font-bold" : "text-gray-500"
                      }`}
                    >
                      {isFinite(r.varianceRatio) ? r.varianceRatio.toFixed(2) : "—"}
                    </td>
                    <td className="border border-gray-200 px-2 py-1 text-center font-mono">±{pp(r.seSigmaAnn, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-600 leading-relaxed">
            <strong>μ の列はほとんど動きません。</strong>μ̂ = ln(P<sub>T</sub>/P<sub>0</sub>)/T は
            途中の経路が全部打ち消し合う<strong>両端2点の恒等式</strong>だからです。
            SE(μ̂) = σ/√T の σ は集計水準ごとに測り直しているので、
            <strong>分散比が 1 から離れた行では SE(μ̂) も一緒に動きます</strong>（琥珀色の行）。
            平均回帰があると長い集計で σ が下がり、SE も下がって見えます。
            これは <strong>μ の精度が上がったのではなく、別の性質（分散比）を測っている</strong>だけです。
            集計を粗くして確実に悪化するのは SE(σ̂) の列で、本数が減るぶんです。
            逆に言えば、日足を分足にしても μ の精度は 1ミリも改善しません。
          </p>
        </div>
      )}

      <AnalysisGuide title="最適建玉 f* と推定誤差の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          長期的に資産を最も速く増やす建玉比率（ケリー基準 f*）と、
          <strong>その値がどれだけ決まっていないか</strong>を同時に見ます。
          f* の値そのものを「答え」として提示しないのがこのパネルの方針です。
          f* = μ/σ² の分子 μ は測れず、分母 σ は測れるので、
          f* の不確かさは実質的に μ の不確かさそのものになります。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式（省略なし）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>μ</strong>：年率算術平均リターン。<strong>σ</strong>：年率ボラティリティ。</li>
          <li><strong>f</strong>：自己資本に対する建玉比率（1＝現物フル、2＝信用2倍）。</li>
          <li><strong>T</strong>：標本の暦年数。<strong>n</strong>：観測本数（日足なら n = 252T）。</li>
        </ul>
        <p className="mt-2">
          <strong>(a) 成長率。</strong> 建玉 f の富は Π(1+f·r<sub>t</sub>) で回るので、
          ln(1+x) ≈ x − x²/2 の展開と E[r²] ≈ Var(r) から
        </p>
        <p className="font-mono text-center my-1">g(f) = μ·f − σ²f²/2</p>
        <p>
          f についての上に凸な二次関数です。凹なので最大値はただ一つで、局所解に落ちる心配はありません。
        </p>
        <p className="mt-2">
          <strong>(b) ケリー比率。</strong> dg/df = μ − σ²f = 0 より
        </p>
        <p className="font-mono text-center my-1">f* = μ/σ²,  g(f*) = μ²/(2σ²)</p>
        <p>
          g(f) = 0 のもう一つの根は <strong>f = 2f* = 2μ/σ²</strong>。ここまで建玉を増やすと、
          期待リターンがプラスでも成長率はゼロになります。それを超えると増やすほど減ります。
        </p>
        <p className="mt-2">
          <strong>(c) 複利の壁。</strong> f = 1（現物フル）のとき g(1) = μ − σ²/2。よって
        </p>
        <p className="font-mono text-center my-1">g(1) &gt; 0 ⟺ μ &gt; σ²/2</p>
        <p>
          この <strong>σ²/2</strong> が「越えるべき壁」です。<strong>σ の二乗で伸びます。</strong>
          σ=25% なら年3.1%、σ=65% なら年21.1%。後者を正当化するには、
          年21%以上の見通しを信じる必要があります。
        </p>
        <p className="mt-2">
          <strong>(d) 推定誤差の非対称性。</strong> 独立同分布を仮定すると
        </p>
        <p className="font-mono text-center my-1">SE(μ̂) = σ/√T,  SE(σ̂) ≈ σ/√(2n)</p>
        <p>
          <strong>SE(μ̂) は T（暦年数）だけに依存し、n には依存しません。</strong>
          μ̂ = ln(P<sub>T</sub>/P<sub>0</sub>)/T は途中の項が打ち消し合う両端2点の恒等式だからです。
          日足を分足にしても n は増えますが T は変わらないので、精度は一切改善しません。
          日足（n = 252T）での比は
        </p>
        <p className="font-mono text-center my-1">SE(μ̂)/SE(σ̂) = √(2n)/√T = √504 ≈ 22.4</p>
        <p>
          <strong>銘柄にも期間にも依存しない定数です。</strong>μ の精度は σ の精度より必ず約22倍粗い。
        </p>
        <p className="mt-2">
          <strong>(e) 決着に必要な年数。</strong> μ &gt; σ²/2 を t 値 κ で示すには
          (μ − σ²/2)/(σ/√T) ≥ κ が必要なので
        </p>
        <p className="font-mono text-center my-1">T* = (κ·σ / (μ − σ²/2))²</p>
        <p>
          σ=30%・壁を 5pp 上回る前提・κ=2 なら T* = 144年。前提が壁以下なら T* は無限大です。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 専門用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ケリー基準</strong>：長期の対数成長率を最大化する賭け金比率。破産確率をゼロに保つ。</li>
          <li><strong>半ケリー</strong>：f*/2。成長率を約25%しか落とさずに変動を半分にする実務解。</li>
          <li><strong>破産線</strong>：g(f)=0 に戻る建玉 2f*。増やすほど減る領域の入口。</li>
          <li><strong>複利の壁 σ²/2</strong>：現物フルで複利プラスになるために μ が越えるべき水準。</li>
          <li><strong>標準誤差（SE）</strong>：推定値のばらつき。±1SE におよそ68%、±2SE に約95%が入る。</li>
          <li><strong>両端2点の恒等式</strong>：途中の値が打ち消し合い、始点と終点だけで決まる量。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          <strong>坂の勾配と、地面の揺れ。</strong> μ は坂の勾配、σ は足元の揺れです。
          揺れの大きさは1歩ごとに観測できるので、歩数を増やせばすぐ正確に分かります。
          しかし勾配は「出発点と現在地の標高差 ÷ 歩いた時間」でしか測れません。
          <strong>歩幅を細かくしても標高差は変わらない</strong>ので、勾配の精度は上がりません。
          長く歩く以外に方法がなく、そして揺れが大きいほど標高差はノイズに埋もれます。
        </p>
        <p className="mt-2">
          <strong>なぜ f* を信じてはいけないか。</strong> f* = 勾配 ÷ 揺れ<sup>2</sup> です。
          分母は正確に分かるのに、分子は22倍粗い。その比を小数点以下まで出して
          「最適な建玉は254%」と言うのは、粗い数字を正確な数字で割って
          正確な答えが出たように見せているだけです。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>①の図で誤差棒と壁の長さを比べる。</strong>誤差棒のほうが長ければ、
            「この銘柄は複利で増える」は測定では言えません。多くの個別銘柄がこの状態です。
          </li>
          <li>
            <strong>②の帯の幅が f* の決まらなさ。</strong>帯が広ければ、
            表示されている f* は「その期間そうだった」以上の意味を持ちません。
          </li>
          <li>
            <strong>③で赤字（100%超）が出たら疑う。</strong>実測 μ̂ を入れると、
            高ボラ銘柄でも低ボラ銘柄でもレバレッジ推奨が出ます。
            それは μ̂ が過去の実現値だからで、将来の期待ではありません。
          </li>
          <li>
            <strong>④は μ の列と分散比の列を並べて読む。</strong>
            μ の列が動かないのが本題です。SE(μ̂) が動いた行は、隣の分散比を見てください。
            1 から離れていれば原因は平均回帰・トレンドであって、μ の精度ではありません。
          </li>
          <li>
            <strong>期間セレクタを動かしてみる。</strong>σ はあまり変わらないのに
            SE(μ̂) だけが大きく動きます。それが μ の測りにくさの正体です。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>f* は目標ではなく上限として使う。</strong>μ を過大評価すると
            f* も過大になり、破産線 2f* を越えてしまいます。μ の推定誤差を考えると
            実務は半ケリー以下、さらに VaR などの独立した上限と併用するのが妥当です。
          </li>
          <li>
            <strong>測れる側の量で意思決定を組む。</strong>σ・壁・売買コスト・税は測れて
            符号も確定しています。μ は測れません。改善は測れる側から着手してください。
          </li>
          <li>
            <strong>低ボラを選ぶ理由を取り違えない。</strong>ドラッグを避けるためではなく、
            <strong>越えるべき壁が低く、必要な信念が小さくて済むから</strong>です。
            年3%を信じるのと年21%を信じるのでは、必要な確信の質が違います。
          </li>
          <li>
            <strong>回転の話とは別勘定。</strong>建玉の大きさ（このパネル）と、
            売買頻度（「持ち方の対数台帳」）は独立に効きます。両方を見てください。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>SE の式は独立同分布を仮定しています。</strong>実際のリターンには
            ボラティリティ・クラスタリングと自己相関があるので、真の SE はここに出る値より
            <strong>大きい</strong>のが普通です。つまり不確かさは表示より深刻です。
          </li>
          <li>
            <strong>g(f) はガウス近似です。</strong>ファットテールの下では実効ケリーはより小さく、
            大きなジャンプがあると f が小さくても破産しえます（1日 −1/f の下落で全損）。
          </li>
          <li>
            <strong>信用金利・売買コスト・税を含みません。</strong>f &gt; 1 には借入コストがかかります。
            それらを含めた比較は「持ち方の対数台帳」を参照してください。
          </li>
          <li>
            <strong>μ̂ は生存バイアスを受けています。</strong>上場が続いている銘柄だけを見ているので、
            実際の識別限界は表示よりさらに厳しくなります。
          </li>
          <li>
            <strong>「決着に必要な年数」は同じ μ・σ が続く前提です。</strong>
            数十年のあいだ企業の性質が一定だという仮定自体が現実的ではありません。
            つまりこの数字は下限であり、実際には決着しません。
          </li>
          <li>
            <strong>他のパネルは点推定を使い続けています。</strong>
            「総合スコアカード」と公理系の建玉合成は `kellyOptimal()` の f* をそのまま参照するので、
            そちらの数字を読むときは本パネルの誤差棒を併せて見てください。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
