"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PortfolioData } from "../../hooks/usePortfolioData";
import { useBenchmarkPrices, BENCHMARK_PRESETS } from "../../hooks/useBenchmarkPrices";
import { alignReturns } from "../../lib/portfolio-risk";
import {
  efficientFrontier,
  EfficientFrontierResult,
  PortfolioPoint,
  type MuMode,
} from "../../lib/efficient-frontier";
import { useSharedMuMode } from "../../lib/mu-mode-store";
import {
  geometricGrowth,
  doublingYears,
  doublingYearsLabel as yearsLabel,
  isoGrowthCurve,
  isoGrowthLevels,
} from "../../lib/growth-drag";
import { placeRect, type LabelRect } from "../../lib/axis-scale";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";

interface Props {
  data: PortfolioData;
  window?: number; // リターン窓(本) 既定 250
}

// Canvas 初期化(CLAUDE.md パターン / DPRスケール)
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

// シャープ比 → 色 (低:青 → 中:緑 → 高:赤)。雲の点彩色用。
function sharpeColor(sh: number, lo: number, hi: number, alpha: number): string {
  const t = hi > lo ? Math.max(0, Math.min(1, (sh - lo) / (hi - lo))) : 0.5;
  // 0:青(59,130,246) 0.5:緑(16,185,129) 1:赤(239,68,68)
  let r: number, g: number, b: number;
  if (t < 0.5) {
    const u = t / 0.5;
    r = 59 + (16 - 59) * u;
    g = 130 + (185 - 130) * u;
    b = 246 + (129 - 246) * u;
  } else {
    const u = (t - 0.5) / 0.5;
    r = 16 + (239 - 16) * u;
    g = 185 + (68 - 185) * u;
    b = 129 + (68 - 129) * u;
  }
  return `rgba(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)},${alpha})`;
}

type MarkerShape = "star" | "diamond" | "triangle" | "square";

// 種別マーカーの形状をパスとして引く(塗り/線は呼び出し側)
function drawMarkerShape(ctx: CanvasRenderingContext2D, x: number, y: number, kind: MarkerShape, r = 6.5) {
  ctx.beginPath();
  if (kind === "diamond") {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
  } else if (kind === "star") {
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 === 0 ? r + 0.5 : r * 0.45;
      const ang = (Math.PI / 5) * i - Math.PI / 2;
      const px = x + rr * Math.cos(ang), py = y + rr * Math.sin(ang);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  } else if (kind === "triangle") {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r * 0.9, y + r * 0.7);
    ctx.lineTo(x - r * 0.9, y + r * 0.7);
    ctx.closePath();
  } else {
    const s = r * 0.85;
    ctx.rect(x - s, y - s, s * 2, s * 2);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// テーブル見出し用の小さな形状グリフ(SVG)。チャートのマーカーと対応づける。
function ShapeGlyph({ shape, color }: { shape: MarkerShape; color: string }) {
  const c = color;
  let path: React.ReactNode;
  if (shape === "diamond") path = <polygon points="7,1 13,7 7,13 1,7" fill={c} />;
  else if (shape === "triangle") path = <polygon points="7,1 13,12 1,12" fill={c} />;
  else if (shape === "square") path = <rect x="2" y="2" width="10" height="10" fill={c} />;
  else
    path = (
      <polygon
        points="7,0.5 8.6,5 13.5,5 9.5,8 11,12.5 7,9.7 3,12.5 4.5,8 0.5,5 5.4,5"
        fill={c}
      />
    );
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0">
      {path}
    </svg>
  );
}

const PAD = { left: 56, right: 16, top: 16, bottom: 40 };
const HEIGHT = 420;

// G6 iso-growth 等高線の色（docs/correlation-growth-drag-visualization.md §G6）。
// 「最大成長点」は接点(最大シャープ)と別の場所にあることを示す主役なので独立した色を持たせる。
const ISO_COLOR = "#a5b4fc";
const ISO_LABEL = "#6366f1";
const GROWTH_COLOR = "#7c3aed";

/**
 * 真の幾何成長率 g = wᵀμ_arith − σ_p²/2。
 *
 * プロット軸の μ が対数平均（muMode="log"）のとき、軸から g を読むと σ²/2 を
 * 二重に引くことになる。実測での過小評価は 9.07pp（等加重の実現成長率 31.14% に対し、
 * 正しい式 31.15% / 対数μ版 22.07%）。倍化年数に翻訳するとこの差は年数で効くので、
 * 表と要約は必ず算術μから計算したこちらを出す。
 * muMode="arithmetic" のときは軸の μ と一致するので両者は同じ値になる。
 */
function trueGrowth(point: { weights: number[]; sigma: number }, muArith: number[]): number {
  let m = 0;
  for (let i = 0; i < point.weights.length; i++) m += point.weights[i] * (muArith[i] ?? 0);
  return m - (point.sigma * point.sigma) / 2;
}

// ラベルの白フチ縁取り。雲の点や等高線に重なっても読めるようにする。
function outlinedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string
) {
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export default function EfficientFrontierChart({ data, window: win = 250 }: Props) {
  const [open, setOpen] = useState(true);
  const [rfPct, setRfPct] = useState(0.5); // 年率Rf(%)
  const [showShort, setShowShort] = useState(false); // 空売り可(閉形式)レイヤの表示。既定オフ。
  const [benchTicker, setBenchTicker] = useState<string | null>("^N225"); // ベンチマーク指数(nullで非表示)
  const [useLW, setUseLW] = useState(true); // Ledoit-Wolf 共分散収縮
  const [useMuShrink, setUseMuShrink] = useState(true); // μ の Bayes-Stein 収縮
  const [maxWeightPct, setMaxWeightPct] = useState(100); // 1銘柄上限(%)。100=制約なし
  const [showBaselines, setShowBaselines] = useState(true); // 比較ベースラインの表示
  const [showIso, setShowIso] = useState(true); // G6: iso-growth 等高線と最大成長点
  // μ の定義。既定は "log"（従来の数値を変えない）。"arithmetic" は教科書の μ で、
  // 等高線・g・倍化年数が軸と厳密に整合する。優劣は OOS 検証で測る。
  // μ の定義は CAPM・SML パネルと**共有**する（片方だけ切り替えて物差しが食い違う事故を防ぐ）。
  const [muMode, setMuMode] = useSharedMuMode();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; vol: number; ret: number } | null>(null);

  const names: Record<string, string> = useMemo(() => {
    const m: Record<string, string> = {};
    for (const [t, v] of Object.entries(data)) m[t] = v.name || t;
    return m;
  }, [data]);

  const result: EfficientFrontierResult | null = useMemo(() => {
    const series = Object.entries(data)
      .filter(([, v]) => v.prices.length > 2)
      .map(([ticker, v]) => ({ ticker, prices: v.prices }));
    if (series.length < 2) return null;
    const aligned = alignReturns(series, win);
    if (aligned.tickers.length < 2) return null;
    return efficientFrontier(aligned, rfPct / 100, {
      monteCarlo: 4000,
      seed: 12345,
      covShrinkage: useLW,
      muShrinkage: useMuShrink,
      maxWeight: maxWeightPct / 100,
      muMode,
    });
  }, [data, win, rfPct, useLW, useMuShrink, maxWeightPct, muMode]);

  // ベンチマーク指数の単独リスク/リターン点(σ-μ平面への参照重ね)。
  // 最適化には混ぜず、指数自身の直近 win 本から年率化する。
  const bench = useBenchmarkPrices(benchTicker ?? "^N225");
  const benchPoint = useMemo(() => {
    if (!benchTicker || !bench.prices || bench.prices.length < 13) return null;
    const closes = bench.prices.filter((p) => p.close > 0).map((p) => p.close);
    let rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
    if (rets.length > win) rets = rets.slice(rets.length - win);
    if (rets.length < 12) return null;
    const m = rets.reduce((s, v) => s + v, 0) / rets.length;
    let vv = 0;
    for (const r of rets) vv += (r - m) * (r - m);
    vv /= rets.length - 1;
    const mu = m * 252;
    const sigma = Math.sqrt(Math.max(vv, 0) * 252);
    const sharpe = sigma > 0 ? (mu - rfPct / 100) / sigma : 0;
    return { name: bench.name, mu, sigma, sharpe };
  }, [benchTicker, bench.prices, bench.name, win, rfPct]);

  // 描画範囲(全プロット点を内包)
  const bounds = useMemo(() => {
    if (!result) return null;
    const xs: number[] = [0];
    const ys: number[] = [result.riskFree];
    const push = (sg: number, mu: number) => {
      xs.push(sg);
      ys.push(mu);
    };
    result.cloud.forEach((p) => push(p.sigma, p.mu));
    result.assets.forEach((p) => push(p.sigma, p.mu));
    result.curve.forEach((p) => push(p.sigma, p.mu));
    if (result.tangencyLongOnly) push(result.tangencyLongOnly.sigma, result.tangencyLongOnly.mu);
    if (result.minVarLongOnly) push(result.minVarLongOnly.sigma, result.minVarLongOnly.mu);
    if (result.maxGrowthLongOnly) push(result.maxGrowthLongOnly.sigma, result.maxGrowthLongOnly.mu);
    if (result.tangency) push(result.tangency.sigma, result.tangency.mu);
    if (benchPoint) push(benchPoint.sigma, benchPoint.mu);
    result.baselines.forEach((b) => push(b.point.sigma, b.point.mu));
    push(result.gmv.sigma, result.gmv.mu);
    const xMin = Math.min(...xs);
    let xMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    // クラウドの極端値で潰れないよう x は 99 パーセンタイル付近に制限
    const sortedX = result.cloud.map((p) => p.sigma).sort((a, b) => a - b);
    if (sortedX.length > 20) xMax = Math.min(xMax, sortedX[Math.floor(sortedX.length * 0.99)] * 1.1);
    const xPad = (xMax - xMin) * 0.05 || 0.01;
    const yPad = (yMax - yMin) * 0.08 || 0.01;
    return { xMin: Math.max(0, xMin - xPad), xMax: xMax + xPad, yMin: yMin - yPad, yMax: yMax + yPad };
  }, [result, benchPoint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result || !bounds) return;
    const init = initCanvas(canvas, HEIGHT);
    if (!init) return;
    const { ctx, width, height } = init;

    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;
    const sx = (v: number) =>
      PAD.left + ((v - bounds.xMin) / (bounds.xMax - bounds.xMin)) * plotW;
    const sy = (v: number) =>
      PAD.top + (1 - (v - bounds.yMin) / (bounds.yMax - bounds.yMin)) * plotH;

    // グリッド + 軸ラベル
    ctx.strokeStyle = "#e5e7eb";
    ctx.fillStyle = "#9ca3af";
    ctx.lineWidth = 1;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const v = bounds.yMin + ((bounds.yMax - bounds.yMin) * i) / yTicks;
      const y = sy(v);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(width - PAD.right, y);
      ctx.stroke();
      ctx.fillText(`${(v * 100).toFixed(0)}%`, PAD.left - 6, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const xTicks = 6;
    for (let i = 0; i <= xTicks; i++) {
      const v = bounds.xMin + ((bounds.xMax - bounds.xMin) * i) / xTicks;
      const x = sx(v);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, height - PAD.bottom);
      ctx.strokeStyle = "#f3f4f6";
      ctx.stroke();
      ctx.fillText(`${(v * 100).toFixed(0)}%`, x, height - PAD.bottom + 6);
    }
    // 軸タイトル
    ctx.fillStyle = "#6b7280";
    ctx.fillText("年率リスク σ (ボラティリティ)", PAD.left + plotW / 2, height - 14);
    ctx.save();
    ctx.translate(12, PAD.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    // 軸の μ が「対数平均（各銘柄の幾何平均に相当）」なのか「算術平均（教科書の μ）」なのかを
    // 軸に明記する。ここを「期待リターン」と一言で書くと 9pp のズレが誤読される。
    ctx.fillText(
      result.muMode === "arithmetic"
        ? "年率期待リターン μ（算術平均）"
        : "年率リターン μ（対数平均＝各銘柄の幾何平均）",
      0,
      0
    );
    ctx.restore();

    // ラベルの占有矩形。以降のラベルはこれと衝突しない位置を選ぶ（重なりの根絶）。
    const placed: LabelRect[] = [];

    // 点 (x,y) の周囲に「4方向 × 複数の距離」の候補矩形を近い順に並べる。
    // 近傍しか候補が無いと密集時に置き場所が消えてラベルが落ちるため、外側の環も用意する。
    const ringCandidates = (
      x: number,
      y: number,
      w: number,
      h: number,
      rings: number[] = [5, 13, 24]
    ): LabelRect[] => {
      const out: LabelRect[] = [];
      for (const g of rings) {
        out.push({ x: x + g, y: y - h / 2, w, h });
        out.push({ x: x - g - w, y: y - h / 2, w, h });
        out.push({ x: x + g, y: y + g, w, h });
        out.push({ x: x - g - w, y: y - g - h, w, h });
      }
      return out.filter((c) => c.x >= PAD.left && c.x + c.w <= width - PAD.right);
    };

    // G6: iso-growth 等高線 g = μ − σ²/2 ⇔ μ = g + σ²/2（docs §G6）
    // 上に凸ではなく「下に凸(上向き)の放物線群」。σ が大きいほど、同じ g を保つのに
    // より高い μ が必要になる ＝ ボラティリティ税の分だけ上へ持ち上がる。
    // フロンティアは右上へ伸びながらこの等高線群を**下向きに横切る**ので、
    // 「フロンティアの右上端＝最も儲かる点」ではないことが図として見える。
    //
    // 【描画順】線は雲の**下**（地形図なので主役を邪魔しない）／ラベルは雲の**上**。
    // 以前はラベルも雲の前に描いていたため、点群に埋もれて読めなかった。
    const isoCurves: { g: number; pts: { x: number; y: number }[] }[] = [];
    if (showIso) {
      const levels = isoGrowthLevels(bounds.xMin, bounds.xMax, bounds.yMin, bounds.yMax, 9);
      for (const g of levels) {
        const pts = isoGrowthCurve(g, bounds.xMin, bounds.xMax, bounds.yMin, bounds.yMax).map(
          (p) => ({ x: sx(p.sigma), y: sy(p.mu) })
        );
        if (pts.length < 2) continue;
        isoCurves.push({ g, pts });
        ctx.strokeStyle = ISO_COLOR;
        ctx.lineWidth = Math.abs(g) < 1e-9 ? 1.6 : 1; // g=0 の等高線だけ少し強く
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // B: モンテカルロ雲(ロングオンリー)
    const shs = result.cloud.map((p) => p.sharpe).sort((a, b) => a - b);
    const shLo = shs[Math.floor(shs.length * 0.05)] ?? 0;
    const shHi = shs[Math.floor(shs.length * 0.95)] ?? 1;
    for (const p of result.cloud) {
      ctx.fillStyle = sharpeColor(p.sharpe, shLo, shHi, 0.5);
      ctx.beginPath();
      ctx.arc(sx(p.sigma), sy(p.mu), 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // A: 効率的フロンティア双曲線(空売り可・閉形式)。効率的枝=実線緑, 非効率枝=破線灰。
    // 空売り可は現実的でないため既定では非表示。トグルで参照用に重ねられる。
    if (showShort) {
      const drawCurve = (eff: boolean, color: string, dash: number[]) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = eff ? 2.5 : 1.5;
        ctx.setLineDash(dash);
        ctx.beginPath();
        let started = false;
        for (const p of result.curve) {
          if (p.efficient !== eff) {
            started = false;
            continue;
          }
          const x = sx(p.sigma), y = sy(p.mu);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      };
      drawCurve(false, "#9ca3af", [4, 3]);
      drawCurve(true, "#059669", []);
    }

    // CML(資本市場線): Rf点から空売り無しの接点へ引く。傾き=接点の最大シャープ比。
    const tanLO = result.tangencyLongOnly;
    if (tanLO && tanLO.sigma > 0) {
      const slope = (tanLO.mu - result.riskFree) / tanLO.sigma;
      const sigMax = bounds.xMax;
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(sx(0), sy(result.riskFree));
      ctx.lineTo(sx(sigMax), sy(result.riskFree + slope * sigMax));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 個別銘柄。ラベル位置は占有矩形に登録して、以降のラベルと重ならないようにする。
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const a of result.assets) {
      const x = sx(a.sigma), y = sy(a.mu);
      if (x < PAD.left || x > width - PAD.right) continue;
      ctx.fillStyle = "#4b5563";
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      const tw = ctx.measureText(a.ticker).width;
      const cands = ringCandidates(x, y, tw, 10);
      const spot = placeRect(cands, placed) ?? cands[0];
      if (!spot) continue;
      ctx.textBaseline = "middle";
      outlinedText(ctx, a.ticker, spot.x, spot.y + 5, "#6b7280");
    }

    // Rf点
    ctx.fillStyle = "#f59e0b";
    ctx.beginPath();
    ctx.arc(sx(0), sy(result.riskFree), 3, 0, Math.PI * 2);
    ctx.fill();

    // ベンチマーク指数(市場)点。最適化には混ぜない参照点。●濃青+ラベル。
    if (benchPoint) {
      const bx = sx(benchPoint.sigma), by = sy(benchPoint.mu);
      if (bx >= PAD.left && bx <= width - PAD.right) {
        ctx.fillStyle = "#1d4ed8";
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bx, by, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.font = "bold 10px sans-serif";
        const tw = ctx.measureText(benchPoint.name).width;
        const cands = ringCandidates(bx, by, tw, 11, [8, 16, 26]);
        const spot = placeRect(cands, placed) ?? cands[0];
        if (spot) {
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          outlinedText(ctx, benchPoint.name, spot.x, spot.y, "#1d4ed8");
        }
      }
    }

    // マーカー描画ヘルパ。形状で種別を区別し、ラベルは白背景ピルで読みやすくする。
    // 位置は「希望方向 → 残り3方向」の順に試し、既に置かれたラベルと重ならない最初の
    // 候補を採る。以前は方向を固定していたため、点が近接するとピルが重なっていた。
    // valueText でラベル末尾の値を差し替えられる（★は S=Sharpe、▲は g=成長率）。
    const marker = (
      p: { sigma: number; mu: number; sharpe: number },
      color: string,
      kind: MarkerShape,
      label: string,
      dir: "ne" | "se" | "sw" | "nw",
      valueText?: string
    ) => {
      const x = sx(p.sigma), y = sy(p.mu);
      ctx.fillStyle = color;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      drawMarkerShape(ctx, x, y, kind);
      ctx.fill();
      ctx.stroke();

      // ラベル(値付き)を白背景ピルで
      const text = `${label}  ${valueText ?? `S=${p.sharpe.toFixed(2)}`}`;
      ctx.font = "bold 10px sans-serif";
      const tw = ctx.measureText(text).width;
      const padX = 4, padY = 2.5, gap = 9;
      const bw = tw + padX * 2, bh = 10 + padY * 2;
      // 候補は「4方向 × 3段の距離」。近い順に試すので、空いていれば従来どおり点の隣に付き、
      // 混み合っている場合だけ外側へ逃げる（引き出し線があるので離れても対応は追える）。
      // 近傍4方向だけだと、点が密集したときに逃げ場が無くなってピルが重なっていた。
      const order: Array<"ne" | "se" | "sw" | "nw"> = ["ne", "se", "nw", "sw"];
      const rot = order.indexOf(dir);
      const dirs = order.slice(rot).concat(order.slice(0, rot));
      const candidates: LabelRect[] = [];
      for (const ring of [1, 2.6, 4.4, 6.5]) {
        const g = gap * ring;
        for (const d of dirs) {
          const right = d === "ne" || d === "se";
          const below = d === "se" || d === "sw";
          candidates.push({
            x: right ? x + g : x - g - bw,
            y: below ? y + g : y - g - bh,
            w: bw,
            h: bh,
          });
        }
      }
      // プロット外へ出る候補は落とす
      const inside = candidates.filter(
        (c) =>
          c.x >= PAD.left &&
          c.x + c.w <= width - PAD.right &&
          c.y >= PAD.top &&
          c.y + c.h <= height - PAD.bottom
      );
      const box = placeRect(inside.length ? inside : candidates, placed) ??
        inside[0] ?? candidates[0];

      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      roundRect(ctx, box.x, box.y, bw, bh, 3);
      ctx.fill();
      ctx.stroke();
      // マーカーとピルを細い引き出し線で結ぶ（離れた位置に逃げても対応が分かるように）
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(
        Math.max(box.x, Math.min(x, box.x + bw)),
        Math.max(box.y, Math.min(y, box.y + bh))
      );
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(text, box.x + padX, box.y + bh / 2 + 0.5);
    };

    // 比較ベースライン(素朴な配分則)を小さな白丸で。1/N=等加重, RP=リスクパリティ, IV=逆ボラ。
    // 丸はここで描くが、**ラベルは主役マーカーの後**に回す（3文字の脇役が ★▲■ の
    // ラベル位置を先取りしないように、占有矩形の登録順＝優先順にする）。
    const baselineLabels: { x: number; y: number; short: string }[] = [];
    if (showBaselines) {
      for (const b of result.baselines) {
        const x = sx(b.point.sigma), y = sy(b.point.mu);
        if (x < PAD.left || x > width - PAD.right) continue;
        ctx.strokeStyle = "#94a3b8";
        ctx.fillStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        baselineLabels.push({
          x,
          y,
          short: b.key === "equal" ? "1/N" : b.key === "riskparity" ? "RP" : "IV",
        });
      }
    }

    // G6: 最大成長点を通る等高線だけは雲の上に濃く描く。この等高線が実現可能領域に
    // **接している**ことが「そこが最速」の視覚的な証明になる。
    const growthPt = showIso ? result.maxGrowthLongOnly : null;
    const gStar = growthPt ? geometricGrowth(growthPt.mu, growthPt.sigma) : 0;
    if (growthPt) {
      ctx.strokeStyle = GROWTH_COLOR;
      ctx.lineWidth = 1.8;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      isoGrowthCurve(gStar, bounds.xMin, bounds.xMax, bounds.yMin, bounds.yMax).forEach((p, i) =>
        i === 0 ? ctx.moveTo(sx(p.sigma), sy(p.mu)) : ctx.lineTo(sx(p.sigma), sy(p.mu))
      );
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 主役マーカー。ラベルは占有矩形で衝突回避するので、登録順＝優先順になる。
    // ★接点 → ▲最大成長（G6 の対比の主役）→ ■最小分散 の順。
    if (result.tangencyLongOnly) marker(result.tangencyLongOnly, "#dc2626", "star", "接点(市場)", "ne");
    // G6: 最大成長点(g = μ − σ²/2 最大・フル投資)。形状: ▲
    // ★と別の場所に立つことが要点。ラベルには Sharpe ではなく g を出す。
    if (growthPt) {
      marker(growthPt, GROWTH_COLOR, "triangle", "最大成長", "se", `g=${(gStar * 100).toFixed(1)}%`);
    }
    // ロングオンリー(上限付き)最小分散。形状: ■
    const minVolPt = result.minVarLongOnly ?? result.cloudMinVol;
    marker(minVolPt, "#0ea5e9", "square", "最小分散(LO)", "sw");
    // 空売り可(閉形式)の特異点。形状: ◆GMV。トグル時のみ参照表示。
    if (showShort) marker(result.gmv, "#2563eb", "diamond", "GMV(空売り可)", "nw");

    // 脇役のラベル(ベースライン 1/N・RP・IV)。主役の位置が確定した後に空いた側へ置く。
    ctx.font = "9px sans-serif";
    for (const b of baselineLabels) {
      const tw = ctx.measureText(b.short).width;
      // 主役のピルで近傍が埋まっていても外側の環へ逃げられるようにする。
      // それでも空きが無ければ描かない（重ねるより消すほうが読める）。
      const spot = placeRect(ringCandidates(b.x, b.y, tw, 9, [5, 13, 24, 36]), placed);
      if (!spot) continue;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      outlinedText(ctx, b.short, spot.x, spot.y + 4.5, "#64748b");
      // 離れた位置に逃げたときは点との対応が分かるように細い線で結ぶ
      if (Math.abs(spot.x - b.x) > 16 || Math.abs(spot.y + 4.5 - b.y) > 16) {
        ctx.strokeStyle = "#cbd5e1";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(spot.x + tw / 2, spot.y + 4.5);
        ctx.stroke();
      }
    }

    // G6: 等高線のラベルは**最後**（＝雲とマーカーの上）に描く。地形図の目盛りなので
    // 優先度は最下位で、置き場所が無ければ描かない。x アンカーを水準ごとに千鳥に
    // ずらして、ラベルが一列に溜まるのを避ける。
    if (isoCurves.length > 0) {
      ctx.font = "9px sans-serif";
      const anchors = [0.86, 0.62, 0.74, 0.5, 0.38];
      isoCurves.forEach(({ g, pts }, li) => {
        const targetX = PAD.left + plotW * anchors[li % anchors.length];
        let at = pts[0];
        for (const p of pts) if (Math.abs(p.x - targetX) < Math.abs(at.x - targetX)) at = p;
        const zero = Math.abs(g) < 1e-9;
        const text = zero ? "g=0%（資産が増えない境界）" : `g=${(g * 100).toFixed(0)}%`;
        const tw = ctx.measureText(text).width;
        const spot = placeRect(
          [
            { x: at.x - tw / 2, y: at.y - 13, w: tw, h: 10 },
            { x: at.x - tw / 2, y: at.y + 3, w: tw, h: 10 },
            { x: at.x + 4, y: at.y - 12, w: tw, h: 10 },
            { x: at.x - 4 - tw, y: at.y - 12, w: tw, h: 10 },
          ].filter((c) => c.x >= PAD.left && c.x + c.w <= width - PAD.right),
          placed
        );
        if (!spot) return;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        outlinedText(ctx, text, spot.x, spot.y, zero ? "#4f46e5" : ISO_LABEL);
      });
    }

    // ホバー十字
    if (hover) {
      ctx.strokeStyle = "#94a3b8";
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hover.x, PAD.top);
      ctx.lineTo(hover.x, height - PAD.bottom);
      ctx.moveTo(PAD.left, hover.y);
      ctx.lineTo(width - PAD.right, hover.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [result, bounds, hover, showShort, benchPoint, showBaselines, showIso]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !bounds) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const plotW = rect.width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    if (x < PAD.left || x > rect.width - PAD.right || y < PAD.top || y > HEIGHT - PAD.bottom) {
      setHover(null);
      return;
    }
    const vol = bounds.xMin + ((x - PAD.left) / plotW) * (bounds.xMax - bounds.xMin);
    const ret = bounds.yMin + (1 - (y - PAD.top) / plotH) * (bounds.yMax - bounds.yMin);
    setHover({ x, y, vol, ret });
  };

  if (Object.keys(data).length < 2) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4 text-sm text-gray-400">
        効率的フロンティアの描画には2銘柄以上の取得が必要です。
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 w-full text-left">
        <span className="inline-block transition-transform" style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>
          ▶
        </span>
        <span className="font-semibold text-gray-800">効率的フロンティア・資本市場線(CAPM)</span>
        <span className="text-xs text-gray-400">
          {result
            ? `(${result.tickers.length}銘柄 / ${result.nObs}本` +
              (result.lwShrinkage > 0 ? ` / LW δ=${result.lwShrinkage.toFixed(2)}` : "") +
              (result.muShrinkFactor > 0 ? ` / μ収縮 φ=${result.muShrinkFactor.toFixed(2)}` : "") +
              (result.shrinkage > 0 ? ` / リッジλ=${result.shrinkage}` : "") +
              ")"
            : ""}
        </span>
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          {!result ? (
            <div className="text-xs text-gray-400">
              共通営業日が不足しているか、共分散行列が特異です(銘柄が線形従属の可能性)。銘柄数や期間を見直してください。
            </div>
          ) : (
            <>
              {/* Rf スライダー */}
              <div className="flex items-center gap-3 text-xs text-gray-600">
                <span className="font-medium">無リスク金利 Rf</span>
                <input
                  type="range"
                  min={0}
                  max={5}
                  step={0.1}
                  value={rfPct}
                  onChange={(e) => setRfPct(parseFloat(e.target.value))}
                  className="w-48"
                />
                <span className="tabular-nums w-12">{rfPct.toFixed(1)}%</span>
                <label className="flex items-center gap-1.5 cursor-pointer select-none ml-2">
                  <input
                    type="checkbox"
                    checked={showShort}
                    onChange={(e) => setShowShort(e.target.checked)}
                  />
                  <span>空売り可(閉形式)を重ねる</span>
                </label>
              </div>

              {/* ベンチマーク指数の重ね(参照点。最適化には混ぜない) */}
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                <span className="font-medium">指数を重ねる</span>
                <button
                  onClick={() => setBenchTicker(null)}
                  className={`px-2 py-0.5 rounded ${benchTicker === null ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
                >
                  なし
                </button>
                {BENCHMARK_PRESETS.map((p) => (
                  <button
                    key={p.ticker}
                    onClick={() => setBenchTicker(p.ticker)}
                    className={`px-2 py-0.5 rounded ${benchTicker === p.ticker ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
                  >
                    {p.label}
                  </button>
                ))}
                <span className="text-gray-400">
                  ● 指数は「単独で持った場合」の位置。雲や接点より左上にあれば分散の余地あり。CML はこの Rf 点から接点(空売り無し)へ引いた線。
                </span>
              </div>

              {/* 推定の頑健化・制約・比較 */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-600">
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="checkbox" checked={useLW} onChange={(e) => setUseLW(e.target.checked)} />
                  <span>Ledoit-Wolf 収縮(Σ安定化)</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="checkbox" checked={useMuShrink} onChange={(e) => setUseMuShrink(e.target.checked)} />
                  <span>μ の Bayes-Stein 収縮</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="checkbox" checked={showBaselines} onChange={(e) => setShowBaselines(e.target.checked)} />
                  <span>ベースライン(1/N・RP・IV)</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="checkbox" checked={showIso} onChange={(e) => setShowIso(e.target.checked)} />
                  <span>成長率の等高線 g=μ−σ²/2 と最大成長点</span>
                </label>
                <label
                  className="flex items-center gap-1.5 cursor-pointer select-none"
                  title="μ を対数平均(従来)から算術平均(教科書の定義)へ切り替える。接点・CML・α・雲がすべて動く実験的トグル。CAPM・SML パネルと設定を共有するので、2つのパネルの物差しは常に一致する。"
                >
                  <input
                    type="checkbox"
                    checked={muMode === "arithmetic"}
                    onChange={(e) => setMuMode(e.target.checked ? "arithmetic" : "log")}
                  />
                  <span>
                    μ を<strong>算術平均</strong>で最適化
                    <span className="text-gray-400">（実験・既定オフ・CAPMパネルと共有）</span>
                  </span>
                </label>
                <span className="flex items-center gap-1.5">
                  <span className="font-medium">1銘柄上限</span>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    step={5}
                    value={maxWeightPct}
                    onChange={(e) => setMaxWeightPct(parseInt(e.target.value))}
                    className="w-28"
                  />
                  <span className="tabular-nums w-10">{maxWeightPct === 100 ? "なし" : `${maxWeightPct}%`}</span>
                </span>
              </div>

              {/* チャート */}
              <div className="relative">
                <canvas
                  ref={canvasRef}
                  onMouseMove={onMove}
                  onMouseLeave={() => setHover(null)}
                  className="w-full"
                  style={{ height: HEIGHT }}
                />
                {hover && (
                  <div className="absolute top-2 right-2 bg-white/90 border border-gray-200 rounded px-2 py-1 text-[10px] text-gray-600 tabular-nums pointer-events-none">
                    σ {(hover.vol * 100).toFixed(1)}% / μ {(hover.ret * 100).toFixed(1)}%
                  </div>
                )}
              </div>

              {/* 凡例 */}
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-gray-500 items-center">
                <LineLegend color="#f59e0b" label="資本市場線 CML" dashed />
                <PointLegend shape="star" color="#dc2626" label="接点=市場ポートフォリオ(空売り無し)" />
                <PointLegend shape="square" color="#0ea5e9" label="最小分散(空売り無し)" />
                {showIso && result.maxGrowthLongOnly && (
                  <PointLegend shape="triangle" color={GROWTH_COLOR} label="最大成長点(g=μ−σ²/2 最大)" />
                )}
                {showIso && (
                  <LineLegend color={ISO_COLOR} label="成長率 g の等高線(薄) / 最大成長点を通る等高線(濃紫)" dashed />
                )}
                {benchPoint && (
                  <span className="flex items-center gap-1.5">
                    <svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="#1d4ed8" /></svg>
                    指数(単独){benchPoint.name}
                  </span>
                )}
                {showBaselines && (
                  <span className="flex items-center gap-1.5">
                    <svg width="10" height="10"><circle cx="5" cy="5" r="3.5" fill="#ffffff" stroke="#94a3b8" strokeWidth="1.5" /></svg>
                    ベースライン(1/N・RP・IV)
                  </span>
                )}
                {showShort && <LineLegend color="#059669" label="効率的フロンティア(空売り可)" />}
                {showShort && <LineLegend color="#9ca3af" label="非効率枝" dashed />}
                {showShort && <PointLegend shape="diamond" color="#2563eb" label="GMV(空売り可)" />}
                <span className="text-gray-400">点群=ランダム配分(色=シャープ比 青低→緑→赤高)</span>
              </div>

              {/* G6: 等高線の読み方（フロンティアの右上端＝最良ではない） */}
              {showIso && result.maxGrowthLongOnly && result.tangencyLongOnly && (
                <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-xs text-gray-700">
                  <div className="font-semibold text-violet-800">
                    フロンティアの右上端は「最も儲かる点」ではありません
                  </div>
                  <p className="mt-1">
                    薄い破線は<strong>実質成長率 g = μ − σ²/2 が同じ点を結んだ等高線</strong>です。
                    σ が大きいほど同じ g を保つのに高い μ が必要になるため、等高線は
                    <strong>右へ行くほど持ち上がります</strong>。フロンティアは右上へ伸びながら
                    この等高線群を<strong>下向きに横切る</strong>——つまり右上へ行くほど g は下がります。
                    濃い紫の破線が実現可能領域に<strong>接する</strong>点（▲）が、実際に資産が最も速く増える配分です。
                  </p>
                  {(() => {
                    const tan = result.tangencyLongOnly;
                    const grw = result.maxGrowthLongOnly;
                    const gAxisTan = geometricGrowth(tan.mu, tan.sigma);
                    const gAxisGrw = geometricGrowth(grw.mu, grw.sigma);
                    const gTrueTan = trueGrowth(tan, result.muArith);
                    const gTrueGrw = trueGrowth(grw, result.muArith);
                    const logMode = result.muMode === "log";
                    return (
                      <>
                        <p className="mt-1.5 tabular-nums">
                          ★接点(最大シャープ)：μ {(tan.mu * 100).toFixed(1)}% / σ{" "}
                          {(tan.sigma * 100).toFixed(1)}% /{" "}
                          <strong>真の g {(gTrueTan * 100).toFixed(1)}%</strong>（2倍まで{" "}
                          {yearsLabel(doublingYears(gTrueTan))}）
                          <br />▲最大成長点：μ {(grw.mu * 100).toFixed(1)}% / σ{" "}
                          {(grw.sigma * 100).toFixed(1)}% /{" "}
                          <strong className="text-violet-800">
                            真の g {(gTrueGrw * 100).toFixed(1)}%
                          </strong>
                          （2倍まで {yearsLabel(doublingYears(gTrueGrw))}）
                        </p>
                        {logMode && (
                          <p className="mt-1 text-[10px] text-amber-700 tabular-nums">
                            ※ 上の g は<strong>算術平均 μ から計算した真の成長率</strong>です。
                            いまの軸（対数平均 μ）から等高線を読むと ★{(gAxisTan * 100).toFixed(1)}% /
                            ▲{(gAxisGrw * 100).toFixed(1)}% と{" "}
                            <strong>
                              {((gTrueGrw - gAxisGrw) * 100).toFixed(1)}pp ほど低く
                            </strong>
                            出ます（σ²/2 を二重に引くため）。
                            <strong>等高線から読める g は下限</strong>だと思ってください。
                            上の「μ を算術平均で最適化」を入れると軸と g が厳密に一致します。
                          </p>
                        )}
                        <p className="mt-1.5 text-[10px] text-gray-500">
                          ★と▲が離れているほど「シャープ比の最良」と「増える速さの最良」が食い違っています。
                          2つが一致するのは Rf=0 かつレバレッジ自由のときだけで、
                          <strong>シャープ比は成長率の代理指標にすぎません</strong>。
                          なお ▲ は<strong>フル投資(Σw=1・現金なし)</strong>の中での最速点です。現金を混ぜられるなら
                          最大成長は「接点 × ケリー比率 λ*=(μ−Rf)/σ²」で達成され、そちらの方が上に来ます
                          （その扱いは「相関だけを動かす：三本の崖」パネル）。
                        </p>
                      </>
                    );
                  })()}
                </div>
              )}

              {/* 代表ポートフォリオの構成(チャートのマーカーと色・形で対応) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                <WeightTable shape="star" color="#dc2626" title="接点(市場)ポートフォリオ" subtitle="最大シャープ・空売り無し(実装可能)" point={result.tangencyLongOnly} tickers={result.tickers} names={names} riskFree={result.riskFree} />
                <WeightTable shape="square" color="#0ea5e9" title="最小分散" subtitle="空売り無し・低リスク重視" point={result.minVarLongOnly ?? result.cloudMinVol} tickers={result.tickers} names={names} riskFree={result.riskFree} />
                {showIso && (
                  <WeightTable shape="triangle" color={GROWTH_COLOR} title="最大成長点" subtitle="g=μ−σ²/2 最大・空売り無し・フル投資" point={result.maxGrowthLongOnly} tickers={result.tickers} names={names} riskFree={result.riskFree} />
                )}
                {showShort && (
                  <WeightTable shape="diamond" color="#2563eb" title="GMV(大域最小分散)" subtitle="期待リターン推定に頑健・空売り可" point={result.gmv} tickers={result.tickers} names={names} riskFree={result.riskFree} />
                )}
              </div>

              {/* ベースラインとの比較(在サンプル位置) */}
              {showBaselines && (
                <BaselineTable
                  muArith={result.muArith}
                  muMode={result.muMode}
                  rows={[
                    result.tangencyLongOnly
                      ? { label: "接点(空売り無し)", point: result.tangencyLongOnly, accent: "#dc2626" }
                      : null,
                    result.minVarLongOnly
                      ? { label: "最小分散(空売り無し)", point: result.minVarLongOnly, accent: "#0ea5e9" }
                      : null,
                    showIso && result.maxGrowthLongOnly
                      ? { label: "最大成長点(g最大)", point: result.maxGrowthLongOnly, accent: GROWTH_COLOR }
                      : null,
                    ...result.baselines.map((b) => ({ label: b.label, point: b.point, accent: "#64748b" })),
                  ].filter((r): r is { label: string; point: PortfolioPoint; accent: string } => r !== null)}
                />
              )}

              <AnalysisGuide title="効率的フロンティア・資本市場線(CAPM)の詳細理論">
                <p className="font-medium text-gray-700">1. 何を見ているか</p>
                <p>
                  個別銘柄は「リスク(年率σ)とリターン(年率μ)」の1点で表せます。複数銘柄を様々な比率(ウェイト)で混ぜると、
                  混ぜ方しだいで様々な (σ, μ) が実現します。その中で<strong>「同じリスクなら最大リターン」になる組合せの集合</strong>が
                  <strong>効率的フロンティア</strong>です。さらに無リスク資産(現金・国債)を混ぜられるなら、フロンティアに接する直線
                  <strong>資本市場線(CML)</strong>が最良の選択肢になり、その接点が<strong>市場ポートフォリオ</strong>(=CAPMの理論上の最適リスク資産)です。
                </p>

                <p className="font-medium text-gray-700 mt-3">2. 数式</p>
                <p>
                  各銘柄の年率期待リターンを μ(=日次平均×252)、年率共分散行列を Σ(=日次共分散×252)とする。ウェイト w(Σwᵢ=1)の
                  ポートフォリオは {" μ_p = wᵀμ, σ_p² = wᵀΣw "}。Σ⁻¹ を使い
                  {" A = 1ᵀΣ⁻¹1, B = 1ᵀΣ⁻¹μ, C = μᵀΣ⁻¹μ, D = AC − B² "} と置くと、目標リターン μ_p に対する
                  最小分散は {" σ_p²(μ_p) = (A μ_p² − 2B μ_p + C) / D "}(これを掃引すると双曲線=フロンティア)。
                  大域最小分散 GMV は {" w = Σ⁻¹1 / A, μ_gmv = B/A, σ_gmv = √(1/A) "}。
                  接点(市場)ポートフォリオは {" w_tan = Σ⁻¹(μ − Rf·1) / [1ᵀΣ⁻¹(μ − Rf·1)] "}、
                  CML は {" μ = Rf + (μ_tan − Rf)/σ_tan · σ "}(傾き=接点の最大シャープ比)。
                </p>

                <p className="font-medium text-gray-700 mt-3">3. 用語</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li><strong>共分散行列 Σ</strong>: 各銘柄ペアの値動きの連動を表す行列。対角は各銘柄の分散。</li>
                  <li><strong>GMV(大域最小分散)</strong>: 期待リターンを一切使わず、リスクだけを最小化した組合せ。推定誤差に強い。</li>
                  <li><strong>接点/市場ポートフォリオ</strong>: Rf 点からフロンティアに引いた接線の接点。シャープ比が最大。</li>
                  <li><strong>シャープ比</strong>: (μ−Rf)/σ。リスク1単位あたりの超過リターン。CMLの傾きそのもの。</li>
                  <li><strong>ロングオンリー</strong>: 空売り(マイナスのウェイト)を許さない制約。現実の現物投資はこちら。</li>
                </ul>

                <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>緑の実線(効率的フロンティア)に近い点ほど効率的。線より内側の点(雲の大半)は「無駄なリスクを取っている」。</li>
                  <li>個別銘柄の点が線より右下にある=単独保有は非効率。混ぜることで左上(低リスク高リターン)へ動かせる。</li>
                  <li>CML(橙線)より上の領域は到達不可能。CML上の点(Rfと接点の配合)が最も効率的な選択肢。</li>
                  <li>既定表示は<strong>空売り無し(ロングオンリー)</strong>に統一: 雲=実現可能領域、★接点=その中で最大シャープの市場ポートフォリオ(射影勾配法で厳密最適化)、CMLは Rf からこの接点へ引く。負のウェイトを含まないので現物でそのまま実装できる。</li>
                  <li>「空売り可(閉形式)を重ねる」をオンにすると、教科書的な<strong>緑線=空売り可の理論縁</strong>と GMV を参照用に重ねられる。緑線と雲の上端の差が「空売り制約のコスト」。空売り可は現実的でないため既定では隠している。</li>
                </ul>

                <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>「接点(市場)ポートフォリオ」(空売り無し・最大シャープ)の構成比を、実際のリバランス目標として使える(空売り不要で実装可能)。</li>
                  <li>リスクを抑えたい局面では「最小分散」の構成比を採用。期待リターン推定に依存せず安定。</li>
                  <li>現在の保有が雲の内側にあるなら、同じリスクでフロンティアまでリターンを引き上げる余地がある。</li>
                  <li>Rf スライダーを動かし、金利環境の変化で最適配分(接点)がどう動くかを確認できる。</li>
                </ul>

                <p className="font-medium text-gray-700 mt-3">6. 推定の頑健化・制約・比較(このパネルの機能)</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li><strong>Ledoit-Wolf 収縮</strong>: 標本共分散 Σ を「対角(平均分散×単位行列)」へ最適強度 δ で引き寄せ、少標本での暴れを抑える。δ はデータから自動決定(ヘッダ表示)。</li>
                  <li><strong>μ の Bayes-Stein 収縮(Jorion)</strong>: 不安定な期待リターン μ を GMV リターンへ強度 φ で縮小。接点が極端な銘柄集中になるのを緩和する。</li>
                  <li><strong>1銘柄上限</strong>: ロングオンリー最適化に上限制約(例 30%)を課し、1〜2銘柄への集中を防いで分散を強制できる。</li>
                  <li><strong>ベースライン(1/N・RP・IV)</strong>: 等加重・リスクパリティ・逆ボラ加重の位置を重ねる。特に <strong>1/N は理論最適を実運用で上回りやすい</strong>謙虚な基準。</li>
                </ul>

                <p className="font-medium text-gray-700 mt-3">
                  7. 成長率の等高線と最大成長点(iso-growth / G6)
                </p>
                <p>
                  平均分散平面は「リスクとリターン」の地図ですが、
                  <strong>あなたの資産が実際に増える速さ</strong>はその2つの<em>組み合わせ</em>で決まります。
                  単純リターンの算術平均を μ、ボラを σ とすると、資産が増える速さ(幾何平均・実質成長率)は
                </p>
                <p className="font-mono text-[11px] bg-white rounded px-2 py-1">g ≈ μ − σ²/2</p>
                <p>
                  （{" log(1+x) ≈ x − x²/2 "} を期待値に取り {" E[x²] ≈ σ² "} としたもの。対数正規なら厳密）。
                  この {" σ²/2 "} が<strong>ボラティリティ・ドラッグ（ボラティリティ税）</strong>で、
                  値動きが荒いだけで自動的に取られる目減り分です。g が一定になる点の集合は
                </p>
                <p className="font-mono text-[11px] bg-white rounded px-2 py-1">μ = g + σ²/2</p>
                <p>
                  すなわち<strong>上向きの放物線</strong>で、これを薄い破線で重ねたものが iso-growth 等高線です。
                  右へ行くほど等高線が持ち上がるのは、σ が大きいほど同じ g を保つのに高い μ が
                  必要になるからです。フロンティアは右上へ伸びながらこの等高線群を
                  <strong>下向きに横切る</strong>ので、<strong>右上端は最良ではありません</strong>。
                </p>
                <p>
                  <strong>最大成長点(▲)</strong>は、空売り無し・フル投資({" w≥0, Σw=1 "})の中で
                  {" g = wᵀμ − wᵀΣw/2 "} を最大化した配分です。μ が線形・{" wᵀΣw "} が凸なので g は
                  <strong>凹関数</strong>——射影勾配上昇で大域最適に届きます(シャープ比最大化は擬凹で
                  多スタートを要するのとは対照的)。一階条件は
                </p>
                <p className="font-mono text-[11px] bg-white rounded px-2 py-1">
                  μ − Σw = 0 （制約が効かない内点解なら w ∝ Σ⁻¹μ）
                </p>
                <p>
                  接点(★)は {" w ∝ Σ⁻¹(μ − Rf·1) "} を Σw=1 に正規化した点なので、
                  <strong>両者は Rf=0 かつスケール自由でない限り一致しません</strong>。
                  フロンティア上では、等高線の傾き {" dμ/dσ = σ "} とフロンティアの傾きが等しくなる点が ▲ です。
                </p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>
                    <strong>読み方</strong>: ★と▲の距離が「シャープ比の最良」と「増える速さの最良」の食い違い。
                    比較表の Sharpe 列と g 列で最良行がずれることを確認できる。
                  </li>
                  <li>
                    <strong>活用</strong>: 長期の資産形成が目的なら、最大化すべきは Sharpe ではなく g。
                    倍化年数 {" ln2/g "} で見ると「Sharpe が 0.05 高い」より「g が 1% 高い」の方が効く。
                  </li>
                  <li>
                    <strong>現金・レバレッジを許すなら</strong>: 最大成長は「接点 × ケリー比率
                    {" λ* = (μ_tan−Rf)/σ_tan² "}」で達成され、{" g_max = Rf + Sharpe²/2 "}。
                    このときだけシャープ比最大化と成長率最大化が同じ答えを出す
                    （▲はあくまで<strong>現金なし</strong>の制約下の最速点）。
                  </li>
                  <li>
                    <strong>μ の定義（このパネルで最も注意が要る点）</strong>: 既定の軸の μ は
                    <strong>対数リターンの平均×252</strong>で、これは各銘柄の
                    <strong>幾何平均</strong>に相当します（教科書の平均分散最適化が想定する算術平均 μ
                    ではありません）。両者の差は実測でぴったり {" σᵢ²/2 "}。詳細は次項。
                  </li>
                </ul>

                <p className="font-medium text-gray-700 mt-3">
                  8. 対数平均 μ と算術平均 μ（実測値つき）
                </p>
                <p>
                  {" alignReturns "} が返すのは<strong>対数リターン</strong>なので、その平均×252 は
                  「実現した成長率」であって期待リターンではありません。日本株4銘柄・732営業日で
                  実測すると:
                </p>
                <p className="font-mono text-[11px] bg-white rounded px-2 py-1 whitespace-pre-wrap">
                  {`銘柄     σ      μ_log   μ_arith   差
7203.T  34.4%   11.4%   17.3%   +5.9pp
6758.T  34.2%   11.1%   17.0%   +5.9pp
9984.T  60.9%   38.4%   57.0%  +18.6pp
8306.T  34.5%   46.8%   52.7%   +5.9pp`}
                </p>
                <p>
                  差は {" σᵢ²/2 "} にぴったり一致します。効くのは水準ではなく
                  <strong>銘柄間のばらつき（ここでは 12.7pp）</strong>で、高ボラ銘柄が
                  「μ でも σ_p でも」二重に罰せられるため接点が低ボラ側へ寄ります。
                </p>
                <p>
                  <strong>どちらの式が現実を当てるか</strong>——等加重(日次リバランス)の
                  実現年率成長率を直接複利計算して照合しました:
                </p>
                <p className="font-mono text-[11px] bg-white rounded px-2 py-1 whitespace-pre-wrap">
                  {`実現値（実際に複利した結果）      31.14%  ← 正解
wᵀμ_arith − σ_p²/2（正しい式）    31.15%  誤差 +0.01pp
wᵀμ_log  − σ_p²/2（対数μで計算）  22.07%  誤差 −9.07pp
wᵀμ_log （引き算なし）            26.90%  誤差 −4.24pp`}
                </p>
                <p>
                  正しい式は<strong>0.01pp で当てます</strong>。対数 μ に {" −σ_p²/2 "} を
                  かけるのは σ²/2 の<strong>二重引き</strong>で 9pp 過小、逆に引き算を省くと
                  ポートフォリオ水準のイェンセン差で 4pp 過大。だから
                  <strong>表と要約の g は必ず算術 μ から計算</strong>しています。
                </p>
                <p>
                  <strong>ではなぜ既定を対数 μ のままにしているのか</strong>。接点への影響を
                  同じ実データで測ると、ウェイトは {" L1/2 = 36.6% "} も動くのに、
                  同一物差し（算術シャープ）での損失は <strong>0.024</strong>
                  （1.609 → 1.634、相対1.5%）しかありませんでした。平均分散最適化の
                  <strong>「最適解が平坦」</strong>という性質です。
                  ウェイトが大きく動いて目的関数がほとんど改善しないのは<strong>推定ノイズの兆候</strong>で、
                  算術 μ の方が標本分散も大きい。しかも Bayes-Stein 収縮（既定オン・実測 φ≈0.83）が
                  μ のばらつきを 17% に潰すので、実際の差はさらに小さくなります。
                  したがって<strong>理屈で決めず、下の「OOSウォークフォワード検証」の
                  「μ定義を比較」で実測してから既定を変える</strong>方針です。
                  「μ を算術平均で最適化」を入れれば、等高線・g・倍化年数が軸と厳密に整合した状態を
                  すぐ確認できます（接点・CML・α・雲もすべて動きます）。
                </p>

                <p className="font-medium text-gray-700 mt-3">9. 注意点</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li><strong>期待リターン μ の推定は極めて不安定</strong>。過去平均をそのまま使うフロンティア(特に接点)は将来に外れやすく、過学習しやすい。実務では GMV やリスクパリティの方が頑健なことが多い。</li>
                  <li>銘柄数が標本数に近い・高相関だと Σ が特異に近づき逆行列が暴れる。本実装は必要時に対角へ収縮(リッジ λ)を加えて安定化する(ヘッダに λ 表示)。</li>
                  <li>空売り可の閉形式はウェイトが大きな正負に振れることがある。現実に使うのはロングオンリー側。</li>
                  <li>共通営業日でしか整列できないため、上場間もない銘柄があると全体の期間が短くなる。過去≠未来。</li>
                </ul>
              </AnalysisGuide>

              <AxiomPlacement corollaryId="C2" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// 各配分則の在サンプル位置(σ/μ/Sharpe と有効銘柄数)を並べて比較する表。
function BaselineTable({
  rows,
  muArith,
  muMode,
}: {
  rows: { label: string; point: PortfolioPoint; accent: string }[];
  muArith: number[];
  muMode: MuMode;
}) {
  // 有効銘柄数 = 逆ハーフィンダール指数(集中度の逆数)。分散の効き具合の目安。
  const effN = (w: number[]) => {
    const s = w.reduce((a, b) => a + Math.abs(b), 0) || 1;
    const p = w.map((x) => Math.abs(x) / s);
    const h = p.reduce((a, x) => a + x * x, 0);
    return h > 0 ? 1 / h : 0;
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] tabular-nums">
        <thead>
          <tr className="text-gray-400 text-left border-b border-gray-200">
            <th className="py-1 pr-2 font-medium">配分則</th>
            <th className="py-1 px-2 font-medium text-right">μ</th>
            <th className="py-1 px-2 font-medium text-right">σ</th>
            <th className="py-1 px-2 font-medium text-right">Sharpe</th>
            {/* G6: シャープ比の隣に「実際に増える速さ」を必ず並べる(docs §S3)。
                g は必ず算術μから計算した真の値（対数μで計算すると 9pp 過小になる）。 */}
            <th className="py-1 px-2 font-medium text-right">真の g</th>
            <th className="py-1 px-2 font-medium text-right">2倍まで</th>
            <th className="py-1 pl-2 font-medium text-right">有効銘柄数</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const g = trueGrowth(r.point, muArith);
            return (
              <tr key={r.label} className="border-b border-gray-100">
                <td className="py-1 pr-2 text-gray-700">
                  <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: r.accent }} />
                  {r.label}
                </td>
                <td className="py-1 px-2 text-right text-gray-600">{(r.point.mu * 100).toFixed(1)}%</td>
                <td className="py-1 px-2 text-right text-gray-600">{(r.point.sigma * 100).toFixed(1)}%</td>
                <td className="py-1 px-2 text-right font-medium text-gray-800">{r.point.sharpe.toFixed(2)}</td>
                <td className={`py-1 px-2 text-right font-medium ${g > 0 ? "text-gray-800" : "text-red-700"}`}>
                  {(g * 100).toFixed(1)}%
                </td>
                <td className="py-1 px-2 text-right text-gray-500">{yearsLabel(doublingYears(g))}</td>
                <td className="py-1 pl-2 text-right text-gray-500">{effN(r.point.weights).toFixed(1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[10px] text-gray-400 mt-1">
        在サンプル(過去)での位置。<strong>1/N は理論最適を実運用でしばしば上回る</strong>ため、真の優劣は下のアウトオブサンプル検証で確認を。有効銘柄数=分散が実質何銘柄に効いているか。
        <strong>Sharpe が最良の行と g が最良の行は一致しません</strong>——長期の資産の伸びを決めるのは g のほう(倍化年数 ln2/g)。
        <br />
        「真の g」＝ {" wᵀμ_arith − σ_p²/2 "}（<strong>算術平均 μ から計算</strong>）。
        {muMode === "log" && (
          <>
            {" "}
            μ 列は<strong>対数平均</strong>なので、μ 列から {" μ−σ²/2 "} を暗算すると
            σ²/2 を二重に引いて g を過小評価します（実データで約 9pp）。
          </>
        )}
      </p>
    </div>
  );
}

function LineLegend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="20" height="8" viewBox="0 0 20 8" className="shrink-0">
        <line x1="0" y1="4" x2="20" y2="4" stroke={color} strokeWidth="2.5" strokeDasharray={dashed ? "4 3" : undefined} />
      </svg>
      {label}
    </span>
  );
}

function PointLegend({ shape, color, label }: { shape: MarkerShape; color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <ShapeGlyph shape={shape} color={color} />
      {label}
    </span>
  );
}

function WeightTable({
  shape,
  color,
  title,
  subtitle,
  point,
  tickers,
  names,
  riskFree,
}: {
  shape: MarkerShape;
  color: string;
  title: string;
  subtitle: string;
  point: PortfolioPoint | null;
  tickers: string[];
  names: Record<string, string>;
  riskFree: number;
}) {
  if (!point) {
    return (
      <div className="bg-gray-50 rounded-lg border border-gray-200 p-3 text-xs text-gray-400">
        <div className="flex items-center gap-1.5 font-medium text-gray-600">
          <ShapeGlyph shape={shape} color={color} />
          {title}
        </div>
        <div className="mt-2">この Rf では定義されません(接点が最小分散点より下)。Rf を調整してください。</div>
      </div>
    );
  }
  // ウェイト降順(絶対値)
  const rows = tickers
    .map((t, i) => ({ ticker: t, w: point.weights[i] }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200 border-l-4 p-3" style={{ borderLeftColor: color }}>
      <div className="flex items-center gap-1.5 font-medium text-gray-700 text-sm">
        <ShapeGlyph shape={shape} color={color} />
        {title}
      </div>
      <div className="text-[10px] text-gray-400 mb-2">{subtitle}</div>
      <div className="flex gap-3 text-[11px] text-gray-600 mb-2 tabular-nums">
        <span>μ {(point.mu * 100).toFixed(1)}%</span>
        <span>σ {(point.sigma * 100).toFixed(1)}%</span>
        <span>Sharpe {point.sharpe.toFixed(2)}</span>
      </div>
      <div className="space-y-1">
        {rows.map((r) => {
          const pct = r.w * 100;
          const neg = r.w < 0;
          return (
            <div key={r.ticker} className="flex items-center gap-2 text-[11px]">
              <span className="w-24 shrink-0 truncate text-gray-600" title={names[r.ticker]}>
                {r.ticker}
              </span>
              <div className="flex-1 bg-gray-200 rounded h-3 relative overflow-hidden">
                <div
                  className={`h-full ${neg ? "bg-red-400" : "bg-emerald-400"}`}
                  style={{ width: `${Math.min(Math.abs(pct), 100)}%` }}
                />
              </div>
              <span className={`w-12 text-right tabular-nums ${neg ? "text-red-500" : "text-gray-600"}`}>
                {pct >= 0 ? "+" : ""}
                {pct.toFixed(0)}%
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-gray-400 mt-2">赤=空売り(マイナス比率)。Rf={(riskFree * 100).toFixed(1)}%基準。</p>
    </div>
  );
}
