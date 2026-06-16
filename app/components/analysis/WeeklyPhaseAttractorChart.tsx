"use client";

import { RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode } from "../../lib/series-mode";
import {
  computeWeeklyPhaseAttractor,
  computeRecurrenceLagProfile,
  computeWeeklySpectrum,
  computeRollingPL,
  computePhaseAugmentedSimplex,
  computePhaseAugmentedSmap,
  computeRegimeStratifiedPL,
  computeAdaptivePhaseAttractor,
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

interface Vec3 { x: number; y: number; z: number }

function rotateY(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
}
function rotateX(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c };
}

// 視点プリセット (各平面に正対する回転角)
type View3D = "free" | "xy" | "xz" | "yz";
const VIEW_ANGLES: Record<Exclude<View3D, "free">, { rx: number; ry: number }> = {
  xy: { rx: 0, ry: 0 },              // X横・Y縦 (Z方向から)
  xz: { rx: -Math.PI / 2, ry: 0 },   // X横・Z縦 (Y方向から)
  yz: { rx: 0, ry: Math.PI / 2 },    // Z横・Y縦 (X方向から)
};
const FREE_ANGLE = { rx: 0.5, ry: 0.7 };

export default function WeeklyPhaseAttractorChart({ prices, seriesMode }: Props) {
  const [tau, setTau] = useState(2);
  const [dim, setDim] = useState<2 | 3>(2);
  const [phaseMode, setPhaseMode] = useState<PhaseMode>("calendar");
  const [phaseWeight, setPhaseWeight] = useState(1);
  const [seed, setSeed] = useState(0); // サロゲート再抽選トリガ
  const [view, setView] = useState<View3D>("free"); // 3D視点プリセット

  const scatterRef = useRef<HTMLCanvasElement>(null);
  // 3D散布図のカメラ状態 (再描画を避けるため ref)
  const angleRef = useRef({ ...FREE_ANGLE });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ active: boolean; button: number; lastX: number; lastY: number }>({
    active: false, button: 0, lastX: 0, lastY: 0,
  });
  const animRef = useRef<number>(0);
  // 3面まとめ (小窓: XY / XZ / YZ 正射影)
  const planeXYRef = useRef<HTMLCanvasElement>(null);
  const planeXZRef = useRef<HTMLCanvasElement>(null);
  const planeYZRef = useRef<HTMLCanvasElement>(null);
  const surroRef = useRef<HTMLCanvasElement>(null);
  const lagRef = useRef<HTMLCanvasElement>(null);
  const specRef = useRef<HTMLCanvasElement>(null);
  const rollRef = useRef<HTMLCanvasElement>(null);
  const smapRef = useRef<HTMLCanvasElement>(null);

  const result = useMemo(
    () => computeWeeklyPhaseAttractor(prices, seriesMode, { tau, dim, phaseMode }),
    // seed を依存に含めてサロゲートを引き直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prices, seriesMode, tau, dim, phaseMode, seed]
  );

  const significant = result.ok && result.PL > result.surrogateQ95;
  const is3D = dim === 3;

  // 3D散布図/3面まとめ用に点群・重心を共有レンジで [-1,1] 正規化
  const cloud3d = useMemo(() => {
    if (!result.ok || !is3D || result.points.length === 0) {
      return { points: [] as { x: number; y: number; z: number; phase: number }[],
        centroids: [] as { x: number; y: number; z: number; k: number }[] };
    }
    const xs = result.points.map((p) => p.x);
    const ys = result.points.map((p) => p.y);
    const zs = result.points.map((p) => p.z);
    const stat = (arr: number[]) => {
      const mn = Math.min(...arr), mx = Math.max(...arr);
      return { mn, r: mx - mn || 1 };
    };
    const sx = stat(xs), sy = stat(ys), sz = stat(zs);
    const nx = (v: number) => ((v - sx.mn) / sx.r - 0.5) * 2;
    const ny = (v: number) => ((v - sy.mn) / sy.r - 0.5) * 2;
    const nz = (v: number) => ((v - sz.mn) / sz.r - 0.5) * 2;
    const points = result.points.map((p) => ({ x: nx(p.x), y: ny(p.y), z: nz(p.z), phase: p.phase }));
    const centroids = result.centroids3d
      .map((c, k) => ({ c, k }))
      .filter((o) => !isNaN(o.c.x))
      .map((o) => ({ x: nx(o.c.x), y: ny(o.c.y), z: nz(o.c.z), k: o.k }));
    return { points, centroids };
  }, [result, is3D]);

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

  // A. 位相つき S-map (θスイープ)
  const smapResult = useMemo(
    () => computePhaseAugmentedSmap(prices, seriesMode, { tau, dim, phaseMode, phaseWeight }),
    [prices, seriesMode, tau, dim, phaseMode, phaseWeight]
  );

  // B1. レジーム層別PL
  const regimeResult = useMemo(
    () => computeRegimeStratifiedPL(prices, seriesMode, { tau, dim, phaseMode }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prices, seriesMode, tau, dim, phaseMode, seed]
  );

  // B3. 適応的位相 (Hilbert)
  const adaptiveResult = useMemo(
    () => computeAdaptivePhaseAttractor(prices, seriesMode, { tau, dim }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prices, seriesMode, tau, dim, seed]
  );

  // フェーズ3-E: 位相つき Simplex 予測スキル比較
  const simplexResult = useMemo(
    () =>
      computePhaseAugmentedSimplex(prices, seriesMode, { tau, dim, phaseMode, phaseWeight }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prices, seriesMode, tau, dim, phaseMode, phaseWeight, seed]
  );

  // 散布図 + 重心巡回パス (2Dモード: 従来の固定平面投影)
  useEffect(() => {
    if (is3D) return; // 3Dはインタラクティブ描画(別effect)
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
  }, [result, tau, is3D]);

  // 3D散布図: 1点を回転+透視投影してスクリーン座標へ
  const projectPoint = useCallback((p: Vec3, size: number) => {
    const margin = 50;
    const plot = (size - margin * 2) * zoomRef.current;
    const cx = size / 2 + panRef.current.x;
    const cy = size / 2 + panRef.current.y;
    let v: Vec3 = { x: p.x, y: p.y, z: p.z };
    v = rotateX(v, angleRef.current.rx);
    v = rotateY(v, angleRef.current.ry);
    const depthScale = 1 / (1 + v.z * 0.15);
    return { sx: cx + v.x * depthScale * plot / 2, sy: cy - v.y * depthScale * plot / 2, depth: v.z };
  }, []);

  // 3D散布図 (インタラクティブ): 曜日色点群 + 重心ノード + 巡回パス
  const draw3D = useCallback(() => {
    const canvas = scatterRef.current;
    if (!canvas || !is3D || cloud3d.points.length === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const size = Math.min(parent.clientWidth - 16, 560);
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

    // 全点を投影し、奥のものから描画 (簡易デプスソート)
    const proj = cloud3d.points.map((p) => ({ ...projectPoint(p, size), phase: p.phase }));
    const order = proj.map((_, i) => i).sort((a, b) => proj[b].depth - proj[a].depth);
    for (const i of order) {
      const pr = proj[i];
      ctx.fillStyle = WEEKDAY_COLORS[pr.phase] + "55";
      ctx.beginPath();
      ctx.arc(pr.sx, pr.sy, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 重心巡回パス (月→火→…→金→月)
    const cen = cloud3d.centroids
      .map((c) => ({ ...projectPoint(c, size), k: c.k }))
      .sort((a, b) => a.k - b.k);
    if (cen.length >= 2) {
      ctx.strokeStyle = "#374151";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      cen.forEach((c, idx) => (idx === 0 ? ctx.moveTo(c.sx, c.sy) : ctx.lineTo(c.sx, c.sy)));
      ctx.lineTo(cen[0].sx, cen[0].sy);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 重心ノード (奥から)
    for (const c of cen.slice().sort((a, b) => b.depth - a.depth)) {
      ctx.fillStyle = WEEKDAY_COLORS[c.k];
      ctx.beginPath();
      ctx.arc(c.sx, c.sy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 9px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(WEEKDAY_LABELS[c.k], c.sx, c.sy);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }

    // 3軸ガイド (右下)
    const ox = 40, oy = size - 40;
    const axes = [
      { dx: 0.3, dy: 0, dz: 0, label: "r(t)", color: "#dc2626" },
      { dx: 0, dy: 0.3, dz: 0, label: `r(t-${tau})`, color: "#16a34a" },
      { dx: 0, dy: 0, dz: 0.3, label: `r(t-${2 * tau})`, color: "#2563eb" },
    ];
    for (const ax of axes) {
      let v: Vec3 = { x: ax.dx, y: ax.dy, z: ax.dz };
      v = rotateX(v, angleRef.current.rx);
      v = rotateY(v, angleRef.current.ry);
      const ex = ox + v.x * 50, ey = oy - v.y * 50;
      ctx.strokeStyle = ax.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.fillStyle = ax.color;
      ctx.font = "10px sans-serif";
      ctx.fillText(ax.label, ex + 4, ey - 4);
    }
  }, [cloud3d, is3D, tau, projectPoint]);

  // 3D描画ループ (ドラッグ反映のため継続描画)
  useEffect(() => {
    if (!is3D) return;
    let running = true;
    const loop = () => {
      if (!running) return;
      draw3D();
      animRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [draw3D, is3D]);

  // 3D散布図のマウス/タッチ操作: 左ドラッグ=回転 / 右ドラッグ=移動 / ホイール=ズーム
  useEffect(() => {
    const canvas = scatterRef.current;
    if (!canvas || !is3D) return;

    const onDown = (x: number, y: number, button: number) => {
      dragRef.current = { active: true, button, lastX: x, lastY: y };
    };
    const onMove = (x: number, y: number) => {
      const d = dragRef.current;
      if (!d.active) return;
      const dx = x - d.lastX, dy = y - d.lastY;
      if (d.button === 0) {
        angleRef.current.ry -= dx * 0.008;
        angleRef.current.rx -= dy * 0.008;
        setView((v) => (v === "free" ? v : "free")); // 手動回転で自由視点に
      } else {
        panRef.current.x += dx;
        panRef.current.y += dy;
      }
      d.lastX = x; d.lastY = y;
    };
    const onUp = () => { dragRef.current.active = false; };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.92 : 1.08;
      zoomRef.current = Math.max(0.3, Math.min(10, zoomRef.current * factor));
    };
    const onContext = (e: MouseEvent) => e.preventDefault();
    const md = (e: MouseEvent) => onDown(e.clientX, e.clientY, e.button);
    const mm = (e: MouseEvent) => onMove(e.clientX, e.clientY);
    const ts = (e: TouchEvent) => {
      if (e.touches.length === 1) { e.preventDefault(); onDown(e.touches[0].clientX, e.touches[0].clientY, 0); }
    };
    const tm = (e: TouchEvent) => {
      if (e.touches.length === 1) { e.preventDefault(); onMove(e.touches[0].clientX, e.touches[0].clientY); }
    };

    canvas.addEventListener("mousedown", md);
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContext);
    canvas.addEventListener("touchstart", ts, { passive: false });
    canvas.addEventListener("touchmove", tm, { passive: false });
    canvas.addEventListener("touchend", onUp);
    return () => {
      canvas.removeEventListener("mousedown", md);
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContext);
      canvas.removeEventListener("touchstart", ts);
      canvas.removeEventListener("touchmove", tm);
      canvas.removeEventListener("touchend", onUp);
    };
  }, [is3D]);

  // 3面まとめ (小窓): XY / XZ / YZ への固定正射影
  useEffect(() => {
    if (!is3D || cloud3d.points.length === 0) return;
    const planes: {
      ref: RefObject<HTMLCanvasElement | null>;
      hx: (p: { x: number; y: number; z: number }) => number;
      vy: (p: { x: number; y: number; z: number }) => number;
      hLabel: string; vLabel: string;
    }[] = [
      { ref: planeXYRef, hx: (p) => p.x, vy: (p) => p.y, hLabel: "r(t)", vLabel: `r(t-${tau})` },
      { ref: planeXZRef, hx: (p) => p.x, vy: (p) => p.z, hLabel: "r(t)", vLabel: `r(t-${2 * tau})` },
      { ref: planeYZRef, hx: (p) => p.y, vy: (p) => p.z, hLabel: `r(t-${tau})`, vLabel: `r(t-${2 * tau})` },
    ];
    for (const pl of planes) {
      const canvas = pl.ref.current;
      if (!canvas) continue;
      const parent = canvas.parentElement;
      if (!parent) continue;
      const size = Math.max(120, Math.min(parent.clientWidth - 4, 200));
      const dpr = window.devicePixelRatio || 1;
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);

      const m = 18;
      // 正規化済み [-1,1] を描画域へ
      const sx = (h: number) => m + ((h + 1) / 2) * (size - m * 2);
      const sy = (v: number) => size - m - ((v + 1) / 2) * (size - m * 2);
      ctx.strokeStyle = "#f3f4f6";
      ctx.lineWidth = 1;
      ctx.strokeRect(m, m, size - m * 2, size - m * 2);

      for (const p of cloud3d.points) {
        ctx.fillStyle = WEEKDAY_COLORS[p.phase] + "55";
        ctx.beginPath();
        ctx.arc(sx(pl.hx(p)), sy(pl.vy(p)), 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      const cen = cloud3d.centroids.slice().sort((a, b) => a.k - b.k);
      if (cen.length >= 2) {
        ctx.strokeStyle = "#374151";
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        cen.forEach((c, i) => (i === 0
          ? ctx.moveTo(sx(pl.hx(c)), sy(pl.vy(c)))
          : ctx.lineTo(sx(pl.hx(c)), sy(pl.vy(c)))));
        ctx.lineTo(sx(pl.hx(cen[0])), sy(pl.vy(cen[0])));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const c of cen) {
        ctx.fillStyle = WEEKDAY_COLORS[c.k];
        ctx.beginPath();
        ctx.arc(sx(pl.hx(c)), sy(pl.vy(c)), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.fillStyle = "#9ca3af";
      ctx.font = "9px sans-serif";
      ctx.fillText(pl.hLabel, size - m - ctx.measureText(pl.hLabel).width, size - 5);
      ctx.save();
      ctx.translate(11, m + ctx.measureText(pl.vLabel).width);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(pl.vLabel, 0, 0);
      ctx.restore();
    }
  }, [cloud3d, is3D, tau]);

  // 視点プリセット適用 / リセット
  const applyView = useCallback((v: View3D) => {
    setView(v);
    if (v !== "free") angleRef.current = { ...VIEW_ANGLES[v] };
    else angleRef.current = { ...FREE_ANGLE };
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
  }, []);

  // データ・設定変更時にズーム/パンをリセット
  useEffect(() => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
  }, [result.points.length, tau, dim, phaseMode]);

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

  // A: S-map θスイープ (ρ vs θ)
  useEffect(() => {
    const canvas = smapRef.current;
    if (!canvas || !smapResult.ok) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = Math.min(parent.clientWidth - 16, 560);
    const height = 220;
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
    const th = smapResult.thetas;
    const nT = th.length;
    const allRho = [...smapResult.rhoBase, ...smapResult.rhoAug];
    const rMax = Math.max(...allRho, 0.05);
    const rMin = Math.min(...allRho, 0);
    const rr = rMax - rMin || 1;
    const sx = (i: number) => margin + (i / (nT - 1)) * (width - margin * 2);
    const sy = (rho: number) => height - margin - ((rho - rMin) / rr) * (height - margin * 2);

    // ゼロ線
    if (rMin < 0) {
      ctx.strokeStyle = "#e5e7eb";
      ctx.beginPath(); ctx.moveTo(margin, sy(0)); ctx.lineTo(width - margin, sy(0)); ctx.stroke();
    }
    const drawCurve = (rho: number[], color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      rho.forEach((v, i) => { const x = sx(i), y = sy(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke();
      rho.forEach((v, i) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(sx(i), sy(v), 2.5, 0, Math.PI * 2); ctx.fill(); });
    };
    drawCurve(smapResult.rhoBase, "#2563eb");
    drawCurve(smapResult.rhoAug, "#dc2626");

    // X軸ラベル
    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    th.forEach((t, i) => ctx.fillText(`${t}`, sx(i), height - margin + 12));
    ctx.textAlign = "left";
    ctx.fillText("予測スキルρ vs θ (青=埋め込みのみ / 赤=+週次位相)", margin, 14);
    ctx.fillText("θ (0=大域線形 → 大=局所非線形)", margin, height - 6);
  }, [smapResult]);

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

      {/* 3D視点プリセット (3Dモードのみ) */}
      {is3D && result.ok && (
        <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
          <span className="text-xs text-gray-500">視点</span>
          {([
            { v: "free", label: "自由回転" },
            { v: "xy", label: "X-Y面" },
            { v: "xz", label: "X-Z面" },
            { v: "yz", label: "Y-Z面" },
          ] as const).map((o) => (
            <button key={o.v} onClick={() => applyView(o.v)}
              className={`px-3 py-1 rounded text-xs font-medium ${view === o.v ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
              {o.label}
            </button>
          ))}
          <span className="text-[10px] text-gray-400">
            X=r(t) / Y=r(t-{tau}) / Z=r(t-{2 * tau})
          </span>
        </div>
      )}

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
            <canvas ref={scatterRef}
              className={`rounded border border-gray-200 ${is3D ? "cursor-grab active:cursor-grabbing" : ""}`} />
          </div>
          {is3D && (
            <div className="mt-1 text-center text-[10px] text-gray-400">
              左ドラッグ: 回転 / 右ドラッグ: 移動 / ホイール: ズーム（視点ボタンで各面に正対）
            </div>
          )}

          {/* 3面まとめ (3Dモードのみ): XY / XZ / YZ への正射影 */}
          {is3D && (
            <div className="mt-3">
              <p className="text-xs text-gray-500 mb-1">3面投影まとめ (各方向から見た形)</p>
              <div className="grid grid-cols-3 gap-2">
                {([
                  { ref: planeXYRef, title: "X-Y面 (r(t) × r(t-" + tau + "))" },
                  { ref: planeXZRef, title: "X-Z面 (r(t) × r(t-" + 2 * tau + "))" },
                  { ref: planeYZRef, title: "Y-Z面 (r(t-" + tau + ") × r(t-" + 2 * tau + "))" },
                ] as const).map((p, i) => (
                  <div key={i} className="flex flex-col items-center">
                    <span className="text-[10px] text-gray-400 mb-0.5">{p.title}</span>
                    <canvas ref={p.ref} className="rounded border border-gray-200 w-full" />
                  </div>
                ))}
              </div>
            </div>
          )}
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

          {/* B1: レジーム層別PL */}
          <div className="mt-6 pt-4 border-t border-gray-200">
            <h4 className="font-semibold text-gray-700 text-sm mb-2">
              レジーム層別 位相ロック (週内構造はどのボラ状態で出るか)
            </h4>
            {regimeResult.ok ? (
              <>
                <table className="w-full text-xs text-center border-collapse">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="py-1 px-2 text-left">レジーム</th>
                      <th className="py-1 px-2">点数</th>
                      <th className="py-1 px-2">PL</th>
                      <th className="py-1 px-2">95%閾値</th>
                      <th className="py-1 px-2">p値</th>
                      <th className="py-1 px-2">判定</th>
                    </tr>
                  </thead>
                  <tbody>
                    {([
                      { label: "高ボラ期", d: regimeResult.high },
                      { label: "低ボラ期", d: regimeResult.low },
                      { label: "全期間", d: regimeResult.all },
                    ] as const).map((row, i) => {
                      const sig = row.d.PL > row.d.q95;
                      return (
                        <tr key={i} className="border-b border-gray-100">
                          <td className="py-1 px-2 text-left">{row.label}</td>
                          <td className="py-1 px-2">{row.d.n}</td>
                          <td className={`py-1 px-2 font-mono ${sig ? "text-red-600 font-bold" : ""}`}>{row.d.PL.toFixed(3)}</td>
                          <td className="py-1 px-2 font-mono text-gray-400">{row.d.q95.toFixed(3)}</td>
                          <td className="py-1 px-2 font-mono">{row.d.pValue.toFixed(4)}</td>
                          <td className={`py-1 px-2 ${sig ? "text-red-600 font-bold" : "text-gray-400"}`}>{sig ? "有意" : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="text-[10px] text-gray-400 mt-1">
                  日次対数リターンの{21}日ローリングσ中央値で高/低ボラに2分し、各レジームで位相ロックを別々に検定。
                  片方だけ有意なら「週内構造はそのボラ状態でのみ出現」= メタゲートをボラ軸でも条件付け可能。
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-500 py-4 text-center">{regimeResult.message ?? "計算不可"}</p>
            )}
          </div>

          {/* B3: 適応的位相 */}
          <div className="mt-6 pt-4 border-t border-gray-200">
            <h4 className="font-semibold text-gray-700 text-sm mb-2">
              適応的位相 (固定5でなくデータ駆動の瞬時位相)
            </h4>
            {adaptiveResult.ok ? (
              <>
                <p className="text-xs text-gray-600 mb-1">
                  採用IMF = <b>{adaptiveResult.selectedImf}</b>（平均周期 {adaptiveResult.selectedPeriod.toFixed(1)} 営業日, {adaptiveResult.nGroups}分割）
                </p>
                <table className="w-full text-xs text-center border-collapse">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="py-1 px-2 text-left">位相の定義</th>
                      <th className="py-1 px-2">PL</th>
                      <th className="py-1 px-2">95%閾値</th>
                      <th className="py-1 px-2">p値</th>
                      <th className="py-1 px-2">判定</th>
                    </tr>
                  </thead>
                  <tbody>
                    {([
                      { label: "適応的位相 (Hilbert)", d: adaptiveResult.adaptive },
                      { label: "カレンダー曜日", d: adaptiveResult.calendar },
                    ] as const).map((row, i) => {
                      const sig = row.d.PL > row.d.q95;
                      return (
                        <tr key={i} className="border-b border-gray-100">
                          <td className="py-1 px-2 text-left">{row.label}</td>
                          <td className={`py-1 px-2 font-mono ${sig ? "text-red-600 font-bold" : ""}`}>{row.d.PL.toFixed(3)}</td>
                          <td className="py-1 px-2 font-mono text-gray-400">{row.d.q95.toFixed(3)}</td>
                          <td className="py-1 px-2 font-mono">{row.d.pValue.toFixed(4)}</td>
                          <td className={`py-1 px-2 ${sig ? "text-red-600 font-bold" : "text-gray-400"}`}>{sig ? "有意" : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="text-[10px] text-gray-400 mt-1">
                  EMDで週次近傍のIMFを抽出→Hilbert変換で瞬時位相→{adaptiveResult.nGroups}分割して位相ロックを検定。
                  適応的位相のPLがカレンダー曜日を上回れば、市場の内在サイクルは暦の曜日とずれている可能性。
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-500 py-4 text-center">{adaptiveResult.message ?? "計算不可"}</p>
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

          {/* A: S-map θスイープ */}
          <div className="mt-6 pt-4 border-t border-gray-200">
            <h4 className="font-semibold text-gray-700 text-sm mb-2">
              S-map θスイープ (非線形性テスト & 位相つき局所線形予測)
            </h4>
            {smapResult.ok ? (
              <>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm mb-2">
                  <span className={`font-bold ${smapResult.nonlinear ? "text-red-700" : "text-gray-600"}`}>
                    {smapResult.nonlinear ? "非線形性: あり" : "非線形性: 乏しい"}
                  </span>
                  <span className="text-gray-600">最適θ = <b>{smapResult.bestThetaBase}</b></span>
                  <span className="text-gray-600">ρ(θ=0)={smapResult.rhoLinearBase.toFixed(3)} → ρ_best={smapResult.rhoBestBase.toFixed(3)}</span>
                  <span className={smapResult.phaseHelps ? "text-red-600 font-bold" : "text-gray-400"}>
                    {smapResult.phaseHelps ? "位相つきで更に改善" : "位相つきの追加改善なし"}
                  </span>
                </div>
                <div className="flex justify-center">
                  <canvas ref={smapRef} className="rounded border border-gray-200" />
                </div>
                <p className="text-[10px] text-gray-400 mt-1">
                  θを上げると局所線形(非線形)モデルに近づく。ρがθ&gt;0で改善すれば非線形性の証拠(Sugihara-May)。
                  赤(位相つき)が青(埋め込みのみ)の最大を上回れば、週内位相は非線形予測にも効く。
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-500 py-4 text-center">{smapResult.message ?? "計算不可"}</p>
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
