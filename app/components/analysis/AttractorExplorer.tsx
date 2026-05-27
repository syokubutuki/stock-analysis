"use client";

import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { takensEmbedding } from "../../lib/nonlinear";
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

export default function AttractorExplorer({ prices, seriesMode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tau, setTau] = useState(1);
  const [dim, setDim] = useState<2 | 3>(3);

  // Comet state
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.5);
  const [trailLen, setTrailLen] = useState(200);
  const cometPosRef = useRef(0);
  const [scrubValue, setScrubValue] = useState(0);
  const animRef = useRef<number>(0);

  // Camera state (refs to avoid re-render on drag)
  const angleRef = useRef({ rx: 0.4, ry: 0.6 });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ active: boolean; button: number; lastX: number; lastY: number }>({
    active: false, button: 0, lastX: 0, lastY: 0,
  });

  const { values, times } = extractSeries(prices, seriesMode);

  const embedding = useMemo(
    () => takensEmbedding(values, times, tau, dim >= 3 ? 3 : 2),
    [values, times, tau, dim]
  );

  const { points: normalized, ranges } = useMemo(() => {
    if (embedding.length === 0) return { points: [], ranges: { xMin: 0, xMax: 0, yMin: 0, yMax: 0, zMin: 0, zMax: 0 } };
    const xs = embedding.map(p => p.x);
    const ys = embedding.map(p => p.y);
    const zs = dim === 3 ? embedding.map(p => p.z ?? 0) : embedding.map(() => 0);
    const stats = (arr: number[]) => {
      const mn = Math.min(...arr), mx = Math.max(...arr), r = mx - mn || 1;
      return { mn, mx, r, norm: arr.map(v => ((v - mn) / r - 0.5) * 2) };
    };
    const sx = stats(xs), sy = stats(ys), sz = stats(zs);
    const pts = sx.norm.map((_, i) => ({ x: sx.norm[i], y: sy.norm[i], z: sz.norm[i], time: embedding[i].time }));
    return { points: pts, ranges: { xMin: sx.mn, xMax: sx.mx, yMin: sy.mn, yMax: sy.mx, zMin: sz.mn, zMax: sz.mx } };
  }, [embedding, dim]);

  useEffect(() => {
    cometPosRef.current = 0; setScrubValue(0);
    zoomRef.current = 1; panRef.current = { x: 0, y: 0 };
  }, [normalized.length, tau, dim]);

  // Project a single normalized point to screen coords
  const projectPoint = useCallback((p: { x: number; y: number; z: number }, size: number) => {
    const margin = 50;
    const plot = (size - margin * 2) * zoomRef.current;
    const cx = size / 2 + panRef.current.x;
    const cy = size / 2 + panRef.current.y;
    let v: Vec3 = { x: p.x, y: p.y, z: p.z };
    if (dim === 3) {
      v = rotateX(v, angleRef.current.rx);
      v = rotateY(v, angleRef.current.ry);
    }
    const depthScale = dim === 3 ? 1 / (1 + v.z * 0.15) : 1;
    const sx = cx + v.x * depthScale * plot / 2;
    const sy = cy - v.y * depthScale * plot / 2;
    return { sx, sy, depth: v.z };
  }, [dim]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || normalized.length === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const size = Math.min(parent.clientWidth - 16, 720);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // White background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);

    const n = normalized.length;
    const headIdx = Math.min(Math.floor(cometPosRef.current), n - 1);
    const isAnimating = playing || scrubValue > 0;

    // Project all
    const pts = normalized.map(p => projectPoint(p, size));

    // Color function: blue -> red
    const segColor = (t: number, alpha: number) => {
      const r = Math.round(50 + 200 * t);
      const g = Math.round(100 * (1 - t * 0.6));
      const b = Math.round(210 * (1 - t));
      return `rgba(${r},${g},${b},${alpha})`;
    };

    // --- Full trajectory ---
    const lineAlpha = isAnimating ? 0.18 : 0.6;
    ctx.lineWidth = isAnimating ? 1 : 1.5;
    ctx.lineJoin = "round";
    for (let i = 1; i < n; i++) {
      ctx.strokeStyle = segColor(i / n, lineAlpha);
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].sx, pts[i - 1].sy);
      ctx.lineTo(pts[i].sx, pts[i].sy);
      ctx.stroke();
    }

    // --- Comet ---
    if (isAnimating && headIdx >= 0) {
      const tailStart = Math.max(0, headIdx - trailLen);

      // Trail line
      for (let i = tailStart + 1; i <= headIdx; i++) {
        const progress = (i - tailStart) / (headIdx - tailStart || 1);
        ctx.strokeStyle = segColor(i / n, 0.2 + progress * 0.8);
        ctx.lineWidth = 1 + progress * 3;
        ctx.beginPath();
        ctx.moveTo(pts[i - 1].sx, pts[i - 1].sy);
        ctx.lineTo(pts[i].sx, pts[i].sy);
        ctx.stroke();
      }

      // Head
      const h = pts[headIdx];
      // Glow
      const grad = ctx.createRadialGradient(h.sx, h.sy, 0, h.sx, h.sy, 14);
      grad.addColorStop(0, "rgba(59,130,246,0.4)");
      grad.addColorStop(1, "rgba(59,130,246,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(h.sx, h.sy, 14, 0, Math.PI * 2);
      ctx.fill();
      // Core
      ctx.fillStyle = "#1d4ed8";
      ctx.beginPath();
      ctx.arc(h.sx, h.sy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Date label
      const dateStr = normalized[headIdx]?.time ?? "";
      ctx.font = "bold 11px monospace";
      const tw = ctx.measureText(dateStr).width;
      const lx = Math.min(h.sx + 10, size - tw - 10);
      const ly = Math.max(h.sy - 10, 16);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(lx - 3, ly - 12, tw + 6, 16);
      ctx.strokeStyle = "rgba(0,0,0,0.1)";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(lx - 3, ly - 12, tw + 6, 16);
      ctx.fillStyle = "#1e3a5f";
      ctx.fillText(dateStr, lx, ly);
    }

    // --- Axes & Ticks ---
    const fmtTick = (v: number) => Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(3);

    if (dim === 3) {
      const ox = 36, oy = size - 36;
      const axes = [
        { dx: 0.25, dy: 0, dz: 0, label: "r(t)", color: "#dc2626" },
        { dx: 0, dy: 0.25, dz: 0, label: `r(t-${tau})`, color: "#16a34a" },
        { dx: 0, dy: 0, dz: 0.25, label: `r(t-${2 * tau})`, color: "#2563eb" },
      ];
      for (const ax of axes) {
        let v: Vec3 = { x: ax.dx, y: ax.dy, z: ax.dz };
        v = rotateX(v, angleRef.current.rx);
        v = rotateY(v, angleRef.current.ry);
        const ex = ox + v.x * 45, ey = oy - v.y * 45;
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
    } else {
      // 2D: draw grid lines and tick values
      const margin = 50;
      const plot = (size - margin * 2) * zoomRef.current;
      const cx = size / 2 + panRef.current.x;
      const cy = size / 2 + panRef.current.y;
      const tickCount = 5;

      ctx.font = "9px monospace";
      ctx.textAlign = "center";

      for (let i = 0; i <= tickCount; i++) {
        const t = (i / tickCount - 0.5) * 2; // -1 to 1
        const xPx = cx + t * plot / 2;
        const yPx = cy - t * plot / 2;
        const xVal = ranges.xMin + (i / tickCount) * (ranges.xMax - ranges.xMin);
        const yVal = ranges.yMin + (i / tickCount) * (ranges.yMax - ranges.yMin);

        // X-axis ticks
        if (xPx > 30 && xPx < size - 10) {
          ctx.strokeStyle = "#e5e7eb";
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(xPx, 30);
          ctx.lineTo(xPx, size - 30);
          ctx.stroke();
          ctx.fillStyle = "#9ca3af";
          ctx.fillText(fmtTick(xVal), xPx, size - 16);
        }
        // Y-axis ticks
        if (yPx > 10 && yPx < size - 30) {
          ctx.strokeStyle = "#e5e7eb";
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(30, yPx);
          ctx.lineTo(size - 10, yPx);
          ctx.stroke();
          ctx.fillStyle = "#9ca3af";
          ctx.textAlign = "right";
          ctx.fillText(fmtTick(yVal), 28, yPx + 3);
          ctx.textAlign = "center";
        }
      }

      // Axis labels
      ctx.fillStyle = "#6b7280";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("r(t)", size / 2, size - 4);
      ctx.save();
      ctx.translate(10, size / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`r(t-${tau})`, 0, 0);
      ctx.restore();
      ctx.textAlign = "left";
    }

    // Info
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px monospace";
    ctx.textAlign = "left";
    ctx.fillText(`n=${n}  dim=${dim}  \u03C4=${tau}  zoom=${zoomRef.current.toFixed(1)}x`, 6, 14);
  }, [normalized, dim, tau, playing, scrubValue, trailLen, projectPoint]);

  // Render loop
  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      if (playing && normalized.length > 0) {
        cometPosRef.current += speed;
        if (cometPosRef.current >= normalized.length) cometPosRef.current = 0;
        setScrubValue(Math.floor(cometPosRef.current));
      }
      draw();
      animRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [draw, playing, speed, normalized.length]);

  // Mouse / touch handlers: left-drag=rotate, right-drag=pan, wheel=zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onDown = (x: number, y: number, button: number) => {
      dragRef.current = { active: true, button, lastX: x, lastY: y };
    };
    const onMove = (x: number, y: number) => {
      const d = dragRef.current;
      if (!d.active) return;
      const dx = x - d.lastX, dy = y - d.lastY;
      if (d.button === 0 && dim === 3) {
        // Left drag: rotate
        angleRef.current.ry -= dx * 0.008;
        angleRef.current.rx -= dy * 0.008;
      } else if (d.button === 2 || (d.button === 0 && dim === 2)) {
        // Right drag (3D) or left drag (2D): pan
        panRef.current.x += dx;
        panRef.current.y += dy;
      }
      d.lastX = x;
      d.lastY = y;
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
  }, [dim]);

  const handleScrub = (val: number) => {
    cometPosRef.current = val;
    setScrubValue(val);
    if (playing) setPlaying(false);
  };

  const handleReset = () => {
    cometPosRef.current = 0;
    setScrubValue(0);
    setPlaying(false);
  };

  const handleResetView = () => {
    angleRef.current = { rx: 0.4, ry: 0.6 };
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">アトラクタ探索 (Takens埋め込み)</h3>

      {/* Controls */}
      <div className="flex flex-wrap gap-4 mb-3 items-end text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">遅延 {"\u03C4"} = {tau}</span>
          <input type="range" min={1} max={20} value={tau}
            onChange={e => setTau(Number(e.target.value))} className="w-28 accent-blue-600" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">次元</span>
          <div className="flex gap-1">
            {([2, 3] as const).map(d => (
              <button key={d} onClick={() => setDim(d)}
                className={`px-3 py-1 rounded text-xs font-medium ${dim === d ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                {d}D
              </button>
            ))}
          </div>
        </label>
        <button onClick={handleResetView}
          className="px-2 py-1 rounded text-xs text-gray-500 bg-gray-100 hover:bg-gray-200">
          視点リセット
        </button>
      </div>

      {/* Canvas */}
      <div className="flex justify-center">
        <canvas ref={canvasRef}
          className="rounded border border-gray-200 cursor-grab active:cursor-grabbing" />
      </div>

      {/* Operation hint */}
      <div className="mt-1 text-center text-[10px] text-gray-400">
        {dim === 3 ? "左ドラッグ: 回転 / 右ドラッグ: 移動 / ホイール: ズーム" : "ドラッグ: 移動 / ホイール: ズーム"}
      </div>

      {/* Playback */}
      <div className="mt-2 p-3 bg-gray-50 rounded border border-gray-200">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <button onClick={() => {
            if (!playing && scrubValue >= normalized.length - 1) { cometPosRef.current = 0; setScrubValue(0); }
            setPlaying(!playing);
          }} className={`px-3 py-1.5 rounded text-xs font-medium ${playing ? "bg-amber-500 text-white" : "bg-blue-600 text-white"}`}>
            {playing ? "||  停止" : "\u25B6  再生"}
          </button>
          <button onClick={handleReset}
            className="px-3 py-1.5 rounded text-xs font-medium bg-gray-200 text-gray-600 hover:bg-gray-300">
            リセット
          </button>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-gray-400">速度 x{speed}</span>
            <input type="range" min={0.1} max={8} step={0.1} value={speed}
              onChange={e => setSpeed(Number(e.target.value))} className="w-20 accent-blue-600" />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-gray-400">尾長 {trailLen}</span>
            <input type="range" min={10} max={300} step={10} value={trailLen}
              onChange={e => setTrailLen(Number(e.target.value))} className="w-20 accent-blue-600" />
          </label>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-400 w-20 shrink-0">{normalized[scrubValue]?.time ?? "---"}</span>
          <input type="range" min={0} max={Math.max(0, normalized.length - 1)} value={scrubValue}
            onChange={e => handleScrub(Number(e.target.value))} className="flex-1 accent-blue-600" />
          <span className="text-[10px] text-gray-400 w-20 text-right shrink-0">{normalized[normalized.length - 1]?.time ?? "---"}</span>
        </div>
      </div>

      {/* Legend */}
      <div className="mt-2 flex items-center justify-center gap-2 text-xs text-gray-500">
        <span>過去</span>
        <div className="w-28 h-2 rounded" style={{ background: "linear-gradient(to right, #3b82f6, #ef4444)" }} />
        <span>現在</span>
      </div>

      <AnalysisGuide title="アトラクタ探索の使い方">
        <p><span className="font-medium">目的:</span> Takensの埋め込み定理に基づき、1次元時系列から力学系のアトラクタを再構成して可視化します。</p>
        <p><span className="font-medium">操作:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li>3D: 左ドラッグで回転、右ドラッグで平行移動、ホイールで拡大縮小</li>
          <li>2D: ドラッグで平行移動、ホイールで拡大縮小</li>
        </ul>
        <p><span className="font-medium">パラメータ:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">{"遅延 \u03C4:"}</span> 遅延座標の時間間隔。ACFの最初のゼロクロスや相互情報量の最初の極小が目安。</li>
          <li><span className="font-medium">次元:</span> 2Dは平面断面、3Dは立体構造。</li>
        </ul>
        <p><span className="font-medium">再生:</span> 光点がアトラクタ上を時間順に移動。スクラバーで任意の時点にジャンプ可能。</p>
        <p><span className="font-medium">読み取り方:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">ループ・渦巻き:</span> 決定論的構造。短期予測に活用できる可能性。</li>
          <li><span className="font-medium">一様な雲:</span> ランダム性が支配的。</li>
          <li><span className="font-medium">光点の滞留・跳躍:</span> アトラクタへの引き込みとレジーム変化。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
