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
  const [autoRotate, setAutoRotate] = useState(true);

  // Comet state
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [trailLen, setTrailLen] = useState(50);
  const cometPosRef = useRef(0);
  const [scrubValue, setScrubValue] = useState(0);

  const dragRef = useRef({ dragging: false, lastX: 0, lastY: 0 });
  const angleRef = useRef({ rx: 0.4, ry: 0.6 });
  const animRef = useRef<number>(0);

  const { values, times } = extractSeries(prices, seriesMode);

  const embedding = useMemo(
    () => takensEmbedding(values, times, tau, dim >= 3 ? 3 : 2),
    [values, times, tau, dim]
  );

  // Normalize to [-1, 1]
  const normalized = useMemo(() => {
    if (embedding.length === 0) return [];
    const xs = embedding.map(p => p.x);
    const ys = embedding.map(p => p.y);
    const zs = dim === 3 ? embedding.map(p => p.z ?? 0) : embedding.map(() => 0);
    const norm = (arr: number[]) => {
      const mn = Math.min(...arr), mx = Math.max(...arr), r = mx - mn || 1;
      return arr.map(v => ((v - mn) / r - 0.5) * 2);
    };
    const nx = norm(xs), ny = norm(ys), nz = norm(zs);
    return nx.map((_, i) => ({ x: nx[i], y: ny[i], z: nz[i], time: embedding[i].time }));
  }, [embedding, dim]);

  useEffect(() => { cometPosRef.current = 0; setScrubValue(0); }, [normalized.length, tau, dim]);

  // Project all points (shared between draw calls)
  const projectAll = useCallback((size: number) => {
    const margin = 40;
    const plot = size - margin * 2;
    const rx = angleRef.current.rx, ry = angleRef.current.ry;

    return normalized.map((p, i) => {
      let v: Vec3 = { x: p.x, y: p.y, z: p.z };
      if (dim === 3) {
        v = rotateX(v, rx);
        v = rotateY(v, ry);
      }
      // Orthographic-ish projection: slight depth scaling for 3D
      const depthScale = dim === 3 ? 1 / (1 + v.z * 0.15) : 1;
      const sx = margin + (v.x * depthScale + 1) / 2 * plot;
      const sy = margin + (-v.y * depthScale + 1) / 2 * plot; // flip y
      return { sx, sy, depth: v.z, t: i / normalized.length, time: p.time };
    });
  }, [normalized, dim]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || normalized.length === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const size = Math.min(parent.clientWidth - 16, 520);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, size, size);

    const pts = projectAll(size);
    const n = pts.length;
    const headIdx = Math.min(Math.floor(cometPosRef.current), n - 1);
    const isAnimating = playing || scrubValue > 0;

    // --- Full trajectory line (always visible) ---
    // Simple blue->red gradient via segments
    const lineAlpha = isAnimating ? 0.25 : 0.7;
    ctx.lineWidth = isAnimating ? 1 : 1.5;
    ctx.lineJoin = "round";
    for (let i = 1; i < n; i++) {
      const t = i / n;
      // blue(0) -> red(1)
      const r = Math.round(60 + 195 * t);
      const g = Math.round(130 * (1 - t * 0.7));
      const b = Math.round(220 * (1 - t));
      ctx.strokeStyle = `rgba(${r},${g},${b},${lineAlpha})`;
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].sx, pts[i - 1].sy);
      ctx.lineTo(pts[i].sx, pts[i].sy);
      ctx.stroke();
    }

    // --- Comet overlay ---
    if (isAnimating && headIdx >= 0) {
      const tailStart = Math.max(0, headIdx - trailLen);

      // Bright trail: thickening line that fades in
      for (let i = tailStart + 1; i <= headIdx; i++) {
        const progress = (i - tailStart) / (headIdx - tailStart || 1);
        const t = i / n;
        const r = Math.round(60 + 195 * t);
        const g = Math.round(130 * (1 - t * 0.7));
        const b = Math.round(220 * (1 - t));
        ctx.strokeStyle = `rgba(${r},${g},${b},${0.2 + progress * 0.8})`;
        ctx.lineWidth = 1 + progress * 3;
        ctx.beginPath();
        ctx.moveTo(pts[i - 1].sx, pts[i - 1].sy);
        ctx.lineTo(pts[i].sx, pts[i].sy);
        ctx.stroke();
      }

      // Head glow
      const h = pts[headIdx];
      const ht = headIdx / n;
      const hr = Math.round(60 + 195 * ht);
      const hg = Math.round(130 * (1 - ht * 0.7));
      const hb = Math.round(220 * (1 - ht));

      // Soft glow
      const grad = ctx.createRadialGradient(h.sx, h.sy, 0, h.sx, h.sy, 14);
      grad.addColorStop(0, `rgba(${hr},${hg},${hb},0.5)`);
      grad.addColorStop(1, `rgba(${hr},${hg},${hb},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(h.sx, h.sy, 14, 0, Math.PI * 2);
      ctx.fill();

      // White core
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(h.sx, h.sy, 4, 0, Math.PI * 2);
      ctx.fill();

      // Date label
      ctx.font = "bold 11px monospace";
      const lx = Math.min(h.sx + 10, size - 82);
      const ly = Math.max(h.sy - 8, 16);
      const tw = ctx.measureText(h.time).width;
      ctx.fillStyle = "rgba(15,23,42,0.85)";
      ctx.fillRect(lx - 2, ly - 11, tw + 4, 14);
      ctx.fillStyle = `rgb(${hr},${hg},${hb})`;
      ctx.fillText(h.time, lx, ly);
    }

    // --- Axes ---
    if (dim === 3) {
      const rx = angleRef.current.rx, ry = angleRef.current.ry;
      const axLen = 0.25;
      const ox = 30, oy = size - 30;
      const axes = [
        { dx: axLen, dy: 0, dz: 0, label: "r(t)", color: "#f87171" },
        { dx: 0, dy: axLen, dz: 0, label: `r(t-${tau})`, color: "#4ade80" },
        { dx: 0, dy: 0, dz: axLen, label: `r(t-${2 * tau})`, color: "#60a5fa" },
      ];
      for (const ax of axes) {
        let v: Vec3 = { x: ax.dx, y: ax.dy, z: ax.dz };
        v = rotateX(v, rx);
        v = rotateY(v, ry);
        const ex = ox + v.x * 50, ey = oy - v.y * 50;
        ctx.strokeStyle = ax.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.fillStyle = ax.color;
        ctx.font = "10px monospace";
        ctx.fillText(ax.label, ex + 3, ey - 3);
      }
    } else {
      ctx.fillStyle = "#64748b";
      ctx.font = "10px monospace";
      ctx.fillText("r(t) \u2192", size / 2 - 14, size - 8);
      ctx.save();
      ctx.translate(10, size / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`r(t-${tau}) \u2192`, 0, 0);
      ctx.restore();
    }

    // Info
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "10px monospace";
    ctx.fillText(`n=${n}  dim=${dim}  \u03C4=${tau}`, 8, 14);
    if (dim === 3) ctx.fillText("drag to rotate", size - 96, 14);
  }, [projectAll, normalized, dim, tau, playing, scrubValue, trailLen]);

  // Render loop
  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      if (autoRotate && dim === 3 && !dragRef.current.dragging) {
        angleRef.current.ry += 0.004;
      }
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
  }, [draw, autoRotate, dim, playing, speed, normalized.length]);

  // Mouse / touch
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onDown = (x: number, y: number) => { dragRef.current = { dragging: true, lastX: x, lastY: y }; };
    const onMove = (x: number, y: number) => {
      if (!dragRef.current.dragging) return;
      angleRef.current.ry += (x - dragRef.current.lastX) * 0.008;
      angleRef.current.rx += (y - dragRef.current.lastY) * 0.008;
      dragRef.current.lastX = x;
      dragRef.current.lastY = y;
    };
    const onUp = () => { dragRef.current.dragging = false; };
    const md = (e: MouseEvent) => onDown(e.clientX, e.clientY);
    const mm = (e: MouseEvent) => onMove(e.clientX, e.clientY);
    const ts = (e: TouchEvent) => { if (e.touches.length === 1) { e.preventDefault(); onDown(e.touches[0].clientX, e.touches[0].clientY); } };
    const tm = (e: TouchEvent) => { if (e.touches.length === 1) { e.preventDefault(); onMove(e.touches[0].clientX, e.touches[0].clientY); } };
    canvas.addEventListener("mousedown", md);
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("touchstart", ts, { passive: false });
    canvas.addEventListener("touchmove", tm, { passive: false });
    canvas.addEventListener("touchend", onUp);
    return () => {
      canvas.removeEventListener("mousedown", md);
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("touchstart", ts);
      canvas.removeEventListener("touchmove", tm);
      canvas.removeEventListener("touchend", onUp);
    };
  }, []);

  const handleScrub = (val: number) => {
    cometPosRef.current = val;
    setScrubValue(val);
    if (playing) setPlaying(false);
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
        {dim === 3 && (
          <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" checked={autoRotate}
              onChange={e => setAutoRotate(e.target.checked)} className="accent-blue-600" />
            自動回転
          </label>
        )}
      </div>

      {/* Canvas */}
      <div className="flex justify-center">
        <canvas ref={canvasRef} className="rounded border border-gray-700 cursor-grab active:cursor-grabbing" />
      </div>

      {/* Playback */}
      <div className="mt-3 p-3 bg-gray-50 rounded border border-gray-200">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <button onClick={() => {
            if (!playing && scrubValue >= normalized.length - 1) { cometPosRef.current = 0; setScrubValue(0); }
            setPlaying(!playing);
          }} className={`px-3 py-1.5 rounded text-xs font-medium ${playing ? "bg-amber-500 text-white" : "bg-blue-600 text-white"}`}>
            {playing ? "||  停止" : "\u25B6  再生"}
          </button>
          <button onClick={() => { cometPosRef.current = 0; setScrubValue(0); setPlaying(false); }}
            className="px-3 py-1.5 rounded text-xs font-medium bg-gray-200 text-gray-600 hover:bg-gray-300">
            リセット
          </button>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-gray-400">速度 x{speed}</span>
            <input type="range" min={0.5} max={8} step={0.5} value={speed}
              onChange={e => setSpeed(Number(e.target.value))} className="w-20 accent-blue-600" />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-gray-400">尾長 {trailLen}</span>
            <input type="range" min={10} max={150} step={5} value={trailLen}
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
        <p><span className="font-medium">パラメータ:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">{"遅延 \u03C4:"}</span> 遅延座標の時間間隔。小さすぎると対角線に潰れ、大きすぎると構造が崩れます。ACFの最初のゼロクロスや相互情報量の最初の極小が目安。</li>
          <li><span className="font-medium">次元:</span> 2Dは平面断面、3Dは立体構造。3Dではドラッグで回転できます。</li>
        </ul>
        <p><span className="font-medium">再生:</span> 光点がアトラクタ上を時間順に移動します。スクラバーで任意の時点にジャンプ可能。</p>
        <p><span className="font-medium">読み取り方:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">ループ・渦巻き:</span> 決定論的構造の存在。短期予測に活用できる可能性。</li>
          <li><span className="font-medium">一様な雲:</span> ランダム性が支配的。</li>
          <li><span className="font-medium">光点の滞留・跳躍:</span> アトラクタへの引き込みとレジーム変化。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
