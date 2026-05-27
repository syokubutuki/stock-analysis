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

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function rotateY(p: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
}

function rotateX(p: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c };
}

function project(p: Vec3, fov: number, size: number): { sx: number; sy: number; depth: number } {
  const d = fov / (fov + p.z);
  return { sx: size / 2 + p.x * d, sy: size / 2 + p.y * d, depth: p.z };
}

function timeColor(t: number, alpha: number = 0.8): string {
  let r: number, g: number, b: number;
  if (t < 0.5) {
    const s = t * 2;
    r = Math.round(128 * (1 - s));
    g = Math.round(200 * s);
    b = Math.round(255 * (1 - s) + 255 * s);
  } else {
    const s = (t - 0.5) * 2;
    r = Math.round(0 + 255 * s);
    g = Math.round(200 + 55 * s);
    b = Math.round(255 * (1 - s));
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

function timeColorRGB(t: number): [number, number, number] {
  if (t < 0.5) {
    const s = t * 2;
    return [128 * (1 - s), 200 * s, 255];
  }
  const s = (t - 0.5) * 2;
  return [255 * s, 200 + 55 * s, 255 * (1 - s)];
}

export default function AttractorExplorer({ prices, seriesMode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tau, setTau] = useState(1);
  const [dim, setDim] = useState<2 | 3>(3);
  const [autoRotate, setAutoRotate] = useState(true);
  const [showTrail, setShowTrail] = useState(true);
  const [pointSize, setPointSize] = useState(2);

  // Comet animation state
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [trailLen, setTrailLen] = useState(40);
  const cometPosRef = useRef(0); // float position for smooth animation
  const [scrubValue, setScrubValue] = useState(0); // for the slider display

  // mouse interaction state
  const dragRef = useRef({ dragging: false, lastX: 0, lastY: 0 });
  const angleRef = useRef({ rx: 0.4, ry: 0.6 });
  const animRef = useRef<number>(0);

  const { values, times } = extractSeries(prices, seriesMode);

  const embedding = useMemo(
    () => takensEmbedding(values, times, tau, dim >= 3 ? 3 : 2),
    [values, times, tau, dim]
  );

  const normalized = useMemo(() => {
    if (embedding.length === 0) return [];
    const xs = embedding.map(p => p.x);
    const ys = embedding.map(p => p.y);
    const zs = dim === 3 ? embedding.map(p => p.z ?? 0) : embedding.map(() => 0);

    const center = (arr: number[]) => {
      const min = Math.min(...arr), max = Math.max(...arr);
      const range = max - min || 1;
      return arr.map(v => ((v - min) / range - 0.5) * 2);
    };

    const nx = center(xs), ny = center(ys), nz = center(zs);
    return nx.map((_, i) => ({
      x: nx[i], y: ny[i], z: nz[i], time: embedding[i].time,
    }));
  }, [embedding, dim]);

  // Reset comet position when data changes
  useEffect(() => {
    cometPosRef.current = 0;
    setScrubValue(0);
  }, [normalized.length, tau, dim]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || normalized.length === 0) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const size = Math.min(parent.clientWidth - 16, 500);
    const dpr = window.devicePixelRatio || 1;

    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, size, size);

    const rx = angleRef.current.rx;
    const ry = angleRef.current.ry;
    const fov = size * 0.8;
    const scale = size * 0.35;
    const n = normalized.length;
    const headIdx = Math.floor(cometPosRef.current);
    const isAnimating = playing || scrubValue > 0;

    // Transform all points
    const projected = normalized.map((p, i) => {
      let v: Vec3 = { x: p.x * scale, y: p.y * scale, z: p.z * scale };
      if (dim === 3) {
        v = rotateX(v, rx);
        v = rotateY(v, ry);
      }
      const s = project(v, fov, size);
      return { ...s, t: i / n, time: p.time };
    });

    // Sort by depth for painter's algorithm
    const indices = projected.map((_, i) => i);
    if (dim === 3) {
      indices.sort((a, b) => projected[b].depth - projected[a].depth);
    }

    // --- Draw background (dim context) ---
    // When comet is active, dim everything; otherwise use normal rendering
    const bgAlphaMultiplier = isAnimating ? 0.12 : 1.0;

    if (showTrail) {
      ctx.lineWidth = 0.5;
      for (let idx = 1; idx < projected.length; idx++) {
        const p0 = projected[idx - 1];
        const p1 = projected[idx];
        ctx.strokeStyle = timeColor(p1.t, 0.15 * bgAlphaMultiplier);
        ctx.beginPath();
        ctx.moveTo(p0.sx, p0.sy);
        ctx.lineTo(p1.sx, p1.sy);
        ctx.stroke();
      }
    }

    for (const i of indices) {
      const p = projected[i];
      const depthFactor = dim === 3 ? Math.max(0.3, (fov + p.depth) / (fov + scale)) : 1;
      const r = pointSize * depthFactor;
      ctx.fillStyle = timeColor(p.t, 0.85 * depthFactor * bgAlphaMultiplier);
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- Draw comet (bright moving point + trail) ---
    if (isAnimating && headIdx < n) {
      const tailStart = Math.max(0, headIdx - trailLen);

      // Comet trail: bright line segments with fade
      for (let i = tailStart + 1; i <= headIdx && i < n; i++) {
        const progress = (i - tailStart) / (headIdx - tailStart); // 0..1
        const p0 = projected[i - 1];
        const p1 = projected[i];
        const [cr, cg, cb] = timeColorRGB(p1.t);
        const alpha = progress * progress * 0.8; // quadratic fade-in
        const width = 0.5 + progress * 3;
        ctx.strokeStyle = `rgba(${Math.round(cr)},${Math.round(cg)},${Math.round(cb)},${alpha})`;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(p0.sx, p0.sy);
        ctx.lineTo(p1.sx, p1.sy);
        ctx.stroke();
      }

      // Comet trail dots with size/brightness gradient
      for (let i = tailStart; i <= headIdx && i < n; i++) {
        const progress = (i - tailStart) / Math.max(1, headIdx - tailStart);
        const p = projected[i];
        const depthFactor = dim === 3 ? Math.max(0.3, (fov + p.depth) / (fov + scale)) : 1;
        const [cr, cg, cb] = timeColorRGB(p.t);
        const dotAlpha = 0.15 + progress * 0.85;
        const dotSize = (pointSize * 0.5 + progress * pointSize * 1.5) * depthFactor;
        ctx.fillStyle = `rgba(${Math.round(cr)},${Math.round(cg)},${Math.round(cb)},${dotAlpha})`;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, dotSize, 0, Math.PI * 2);
        ctx.fill();
      }

      // Head: bright glowing point
      if (headIdx < n) {
        const head = projected[headIdx];
        const [hr, hg, hb] = timeColorRGB(head.t);

        // Outer glow
        const gradient = ctx.createRadialGradient(head.sx, head.sy, 0, head.sx, head.sy, pointSize * 6);
        gradient.addColorStop(0, `rgba(${Math.round(hr)},${Math.round(hg)},${Math.round(hb)},0.4)`);
        gradient.addColorStop(0.4, `rgba(${Math.round(hr)},${Math.round(hg)},${Math.round(hb)},0.1)`);
        gradient.addColorStop(1, `rgba(${Math.round(hr)},${Math.round(hg)},${Math.round(hb)},0)`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(head.sx, head.sy, pointSize * 6, 0, Math.PI * 2);
        ctx.fill();

        // Bright core
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(head.sx, head.sy, pointSize * 1.8, 0, Math.PI * 2);
        ctx.fill();

        // Colored ring
        ctx.strokeStyle = `rgb(${Math.round(hr)},${Math.round(hg)},${Math.round(hb)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(head.sx, head.sy, pointSize * 2.5, 0, Math.PI * 2);
        ctx.stroke();

        // Date label near head
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = "bold 11px monospace";
        const dateLabel = head.time;
        const labelX = Math.min(head.sx + 12, size - 80);
        const labelY = Math.max(head.sy - 10, 16);
        // label background
        const tw = ctx.measureText(dateLabel).width;
        ctx.fillStyle = "rgba(15,23,42,0.8)";
        ctx.fillRect(labelX - 3, labelY - 11, tw + 6, 15);
        ctx.fillStyle = `rgb(${Math.round(hr)},${Math.round(hg)},${Math.round(hb)})`;
        ctx.fillText(dateLabel, labelX, labelY);
      }
    }

    // --- Draw axes ---
    if (dim === 3) {
      const axisLen = scale * 0.3;
      const axes = [
        { dir: { x: axisLen, y: 0, z: 0 }, label: `r(t)`, color: "#ef4444" },
        { dir: { x: 0, y: axisLen, z: 0 }, label: `r(t-${tau})`, color: "#22c55e" },
        { dir: { x: 0, y: 0, z: axisLen }, label: `r(t-${2 * tau})`, color: "#3b82f6" },
      ];
      const origin: Vec3 = { x: -scale * 0.75, y: scale * 0.75, z: 0 };
      const o3 = rotateY(rotateX(origin, rx), ry);
      const oProj = project(o3, fov, size);

      for (const ax of axes) {
        const tip: Vec3 = { x: origin.x + ax.dir.x, y: origin.y + ax.dir.y, z: origin.z + ax.dir.z };
        const t3 = rotateY(rotateX(tip, rx), ry);
        const tProj = project(t3, fov, size);

        ctx.strokeStyle = ax.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(oProj.sx, oProj.sy);
        ctx.lineTo(tProj.sx, tProj.sy);
        ctx.stroke();

        ctx.fillStyle = ax.color;
        ctx.font = "11px monospace";
        ctx.fillText(ax.label, tProj.sx + 4, tProj.sy - 4);
      }
    } else {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "11px monospace";
      ctx.fillText("r(t)", size / 2 - 12, size - 6);
      ctx.save();
      ctx.translate(12, size / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`r(t-${tau})`, 0, 0);
      ctx.restore();
    }

    // info overlay
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "10px monospace";
    ctx.fillText(`n=${n}  dim=${dim}  \u03C4=${tau}`, 8, 14);
  }, [normalized, dim, tau, showTrail, pointSize, playing, scrubValue, trailLen]);

  // Animation loop
  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      if (autoRotate && dim === 3 && !dragRef.current.dragging) {
        angleRef.current.ry += 0.005;
      }
      // Advance comet
      if (playing && normalized.length > 0) {
        cometPosRef.current += speed;
        if (cometPosRef.current >= normalized.length) {
          cometPosRef.current = 0; // loop
        }
        setScrubValue(Math.floor(cometPosRef.current));
      }
      draw();
      animRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [draw, autoRotate, dim, playing, speed, normalized.length]);

  // Mouse handlers
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onMouseDown = (e: MouseEvent) => {
      dragRef.current = { dragging: true, lastX: e.clientX, lastY: e.clientY };
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current.dragging) return;
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      angleRef.current.ry += dx * 0.008;
      angleRef.current.rx += dy * 0.008;
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;
    };
    const onMouseUp = () => { dragRef.current.dragging = false; };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        dragRef.current = { dragging: true, lastX: t.clientX, lastY: t.clientY };
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!dragRef.current.dragging || e.touches.length !== 1) return;
      e.preventDefault();
      const t = e.touches[0];
      const dx = t.clientX - dragRef.current.lastX;
      const dy = t.clientY - dragRef.current.lastY;
      angleRef.current.ry += dx * 0.008;
      angleRef.current.rx += dy * 0.008;
      dragRef.current.lastX = t.clientX;
      dragRef.current.lastY = t.clientY;
    };
    const onTouchEnd = () => { dragRef.current.dragging = false; };

    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);

    return () => {
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  const handleScrub = (val: number) => {
    cometPosRef.current = val;
    setScrubValue(val);
    if (playing) setPlaying(false);
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-3">
        アトラクタ探索 (Takens埋め込み)
      </h3>

      {/* Embedding controls */}
      <div className="flex flex-wrap gap-4 mb-3 items-end text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">
            遅延 {"\u03C4"} = {tau}
          </span>
          <input
            type="range" min={1} max={20} value={tau}
            onChange={e => setTau(Number(e.target.value))}
            className="w-32 accent-blue-600"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">埋め込み次元</span>
          <div className="flex gap-1">
            {([2, 3] as const).map(d => (
              <button key={d}
                onClick={() => setDim(d)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  dim === d
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {d}D
              </button>
            ))}
          </div>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">点サイズ</span>
          <input
            type="range" min={1} max={5} step={0.5} value={pointSize}
            onChange={e => setPointSize(Number(e.target.value))}
            className="w-20 accent-blue-600"
          />
        </label>

        <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
          <input type="checkbox" checked={showTrail}
            onChange={e => setShowTrail(e.target.checked)}
            className="accent-blue-600"
          />
          軌跡
        </label>

        {dim === 3 && (
          <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" checked={autoRotate}
              onChange={e => setAutoRotate(e.target.checked)}
              className="accent-blue-600"
            />
            自動回転
          </label>
        )}
      </div>

      {/* Canvas */}
      <div className="flex justify-center">
        <canvas
          ref={canvasRef}
          className="rounded border border-gray-700 cursor-grab active:cursor-grabbing"
        />
      </div>

      {/* Comet playback controls */}
      <div className="mt-3 p-3 bg-gray-50 rounded border border-gray-200">
        <div className="flex items-center gap-3 mb-2">
          <button
            onClick={() => {
              if (!playing && scrubValue >= normalized.length - 1) {
                cometPosRef.current = 0;
                setScrubValue(0);
              }
              setPlaying(!playing);
            }}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              playing
                ? "bg-amber-500 text-white hover:bg-amber-600"
                : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {playing ? "||  一時停止" : "\u25B6  再生"}
          </button>
          <button
            onClick={() => { cometPosRef.current = 0; setScrubValue(0); setPlaying(false); }}
            className="px-3 py-1.5 rounded text-xs font-medium bg-gray-200 text-gray-600 hover:bg-gray-300 transition-colors"
          >
            リセット
          </button>

          <label className="flex flex-col gap-0.5 ml-2">
            <span className="text-[10px] text-gray-400">速度 x{speed}</span>
            <input
              type="range" min={0.5} max={8} step={0.5} value={speed}
              onChange={e => setSpeed(Number(e.target.value))}
              className="w-20 accent-blue-600"
            />
          </label>

          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-gray-400">尾長 {trailLen}</span>
            <input
              type="range" min={10} max={120} step={5} value={trailLen}
              onChange={e => setTrailLen(Number(e.target.value))}
              className="w-20 accent-blue-600"
            />
          </label>
        </div>

        {/* Time scrubber */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-400 w-20 shrink-0">
            {normalized[scrubValue]?.time ?? "---"}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(0, normalized.length - 1)}
            value={scrubValue}
            onChange={e => handleScrub(Number(e.target.value))}
            className="flex-1 accent-blue-600"
          />
          <span className="text-[10px] text-gray-400 w-20 text-right shrink-0">
            {normalized[normalized.length - 1]?.time ?? "---"}
          </span>
        </div>
      </div>

      {/* Legend */}
      <div className="mt-2 flex items-center justify-center gap-2 text-xs text-gray-500">
        <span>過去</span>
        <div className="w-32 h-2 rounded" style={{
          background: "linear-gradient(to right, rgb(128,0,255), rgb(0,200,255), rgb(255,255,0))"
        }} />
        <span>現在</span>
        {dim === 3 && <span className="ml-2 text-gray-400">| ドラッグで回転</span>}
      </div>

      <AnalysisGuide title="アトラクタ探索の使い方">
        <p><span className="font-medium">目的:</span> Takensの埋め込み定理に基づき、1次元時系列から元の力学系のアトラクタ(状態空間上の幾何学的構造)を再構成して可視化します。</p>
        <p><span className="font-medium">パラメータの調整:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">{"遅延 \u03C4 (tau):"}</span> 遅延座標の時間間隔。小さすぎると軸間の相関が高く対角線に潰れ、大きすぎると構造が失われます。自己相関関数が最初にゼロを横切る点や、相互情報量の最初の極小が目安になります。</li>
          <li><span className="font-medium">埋め込み次元:</span> 2Dは平面断面、3Dは立体構造を表示します。3Dでは奥行き方向の構造が見え、ストレンジアトラクタのフラクタル的折りたたみを観察できます。</li>
        </ul>
        <p><span className="font-medium">再生アニメーション:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">再生ボタン:</span> 光点がアトラクタ上を時間順に移動し、状態の遷移を動的に追跡できます。</li>
          <li><span className="font-medium">彗星テール:</span> 移動点の後方に残光が伸び、直近の軌道の方向と速度感を表現します。尾長スライダーで残光の長さを調整できます。</li>
          <li><span className="font-medium">タイムスクラバー:</span> 手動でドラッグして任意の時点にジャンプできます。急激なジャンプ(=レジーム変化)がどこで起きたか探索できます。</li>
        </ul>
        <p><span className="font-medium">読み取り方:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">明確な幾何学的構造(ループ・渦巻き):</span> 決定論的ダイナミクスの存在を示唆。パターンを利用した短期予測が可能かもしれません。</li>
          <li><span className="font-medium">一様に充填された球状の雲:</span> ランダム性が支配的。予測可能な構造は乏しい。</li>
          <li><span className="font-medium">複数の集塊・レジーム:</span> マルチモーダルな力学系。市場のレジーム切替を反映している可能性があります。</li>
          <li><span className="font-medium">光点が特定領域に滞留:</span> その状態に引き込まれている(アトラクタ)。突然の跳躍はレジーム転換のシグナルです。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
