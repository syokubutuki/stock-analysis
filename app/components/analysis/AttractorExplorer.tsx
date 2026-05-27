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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PlotlyType = any;

function loadPlotly(): Promise<PlotlyType> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window as any).__Plotly) return Promise.resolve((window as any).__Plotly);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    s.onload = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const P = (window as any).Plotly;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__Plotly = P;
      resolve(P);
    };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

export default function AttractorExplorer({ prices, seriesMode }: Props) {
  const plotRef = useRef<HTMLDivElement>(null);
  const plotlyRef = useRef<PlotlyType>(null);
  const [tau, setTau] = useState(1);
  const [dim, setDim] = useState<2 | 3>(3);
  const [loaded, setLoaded] = useState(false);

  // Comet state
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.5);
  const [trailLen, setTrailLen] = useState(200);
  const cometPosRef = useRef(0);
  const [scrubValue, setScrubValue] = useState(0);
  const animRef = useRef<number>(0);
  const plotCreatedRef = useRef(false);

  const { values, times } = extractSeries(prices, seriesMode);

  const embedding = useMemo(
    () => takensEmbedding(values, times, tau, dim >= 3 ? 3 : 2),
    [values, times, tau, dim]
  );

  const plotData = useMemo(() => {
    if (embedding.length === 0) return { x: [] as number[], y: [] as number[], z: [] as number[], times: [] as string[], colors: [] as number[] };
    return {
      x: embedding.map(p => p.x),
      y: embedding.map(p => p.y),
      z: dim === 3 ? embedding.map(p => p.z ?? 0) : [],
      times: embedding.map(p => p.time),
      colors: embedding.map((_, i) => i),
    };
  }, [embedding, dim]);

  useEffect(() => { cometPosRef.current = 0; setScrubValue(0); }, [plotData.x.length, tau, dim]);

  // Load Plotly
  useEffect(() => {
    loadPlotly().then(P => { plotlyRef.current = P; setLoaded(true); });
  }, []);

  // Create plot (only when data/dim/tau changes, NOT on comet movement)
  useEffect(() => {
    const P = plotlyRef.current;
    const el = plotRef.current;
    if (!P || !el || plotData.x.length === 0) return;

    const is3d = dim === 3;
    const traceType = is3d ? "scatter3d" : "scatter";

    const hovertemplate = is3d
      ? "x(t): %{x:.4f}<br>x(t-τ): %{y:.4f}<br>x(t-2τ): %{z:.4f}<br>%{text}<extra></extra>"
      : "x(t): %{x:.4f}<br>x(t-τ): %{y:.4f}<br>%{text}<extra></extra>";

    // Trace 0: main trajectory (always visible)
    const mainTrace: PlotlyType = {
      x: plotData.x, y: plotData.y,
      ...(is3d ? { z: plotData.z } : {}),
      text: plotData.times,
      hovertemplate,
      type: traceType,
      mode: "lines+markers",
      marker: { size: 2.5, color: plotData.colors, colorscale: [[0, "#3b82f6"], [1, "#ef4444"]], opacity: 0.7 },
      line: { width: 1.5, color: "rgba(100,140,200,0.4)" },
    };

    // Trace 1: comet trail (initially empty)
    const cometTrace: PlotlyType = {
      x: [], y: [],
      ...(is3d ? { z: [] } : {}),
      text: [], hovertemplate,
      type: traceType,
      mode: "lines+markers",
      marker: { size: [], color: [], colorscale: [[0, "rgba(100,160,255,0.2)"], [1, "#ffffff"]], line: { width: 0 } },
      line: { width: 2.5, color: "rgba(120,180,255,0.6)" },
      showlegend: false,
    };

    // Trace 2: head marker (initially empty)
    const headTrace: PlotlyType = {
      x: [], y: [],
      ...(is3d ? { z: [] } : {}),
      text: [], hovertemplate,
      type: traceType,
      mode: "markers+text",
      textposition: "top right",
      textfont: { size: 11, color: "#fff", family: "monospace" },
      marker: { size: 12, color: "#ffffff", line: { width: 2, color: "#3b82f6" } },
      showlegend: false,
    };

    const layout: PlotlyType = {
      margin: { l: 40, r: 20, t: 30, b: 40 },
      paper_bgcolor: "#0f172a",
      plot_bgcolor: "#0f172a",
      font: { color: "#94a3b8", size: 10 },
      showlegend: false,
      ...(is3d ? {
        scene: {
          xaxis: { title: "r(t)", gridcolor: "#1e293b", zerolinecolor: "#334155", color: "#94a3b8" },
          yaxis: { title: `r(t-${tau})`, gridcolor: "#1e293b", zerolinecolor: "#334155", color: "#94a3b8" },
          zaxis: { title: `r(t-${2 * tau})`, gridcolor: "#1e293b", zerolinecolor: "#334155", color: "#94a3b8" },
          bgcolor: "#0f172a",
          dragmode: "orbit",
        },
      } : {
        xaxis: { title: "r(t)", gridcolor: "#1e293b", zerolinecolor: "#334155", color: "#94a3b8" },
        yaxis: { title: `r(t-${tau})`, gridcolor: "#1e293b", zerolinecolor: "#334155", color: "#94a3b8", scaleanchor: "x" },
        dragmode: "zoom",
      }),
    };

    const config = { responsive: true, displayModeBar: true, scrollZoom: true };

    P.newPlot(el, [mainTrace, cometTrace, headTrace], layout, config);
    plotCreatedRef.current = true;

    return () => {
      if (el) P.purge(el);
      plotCreatedRef.current = false;
    };
  }, [loaded, plotData, dim, tau]);

  // Update comet traces via restyle (no full redraw, preserves camera)
  const updateComet = useCallback((headIdx: number) => {
    const P = plotlyRef.current;
    const el = plotRef.current;
    if (!P || !el || !plotCreatedRef.current || plotData.x.length === 0) return;

    const n = plotData.x.length;
    const idx = Math.min(Math.max(0, headIdx), n - 1);
    const is3d = dim === 3;

    if (idx <= 0) {
      // Hide comet traces
      P.restyle(el, { x: [[]], y: [[]], ...(is3d ? { z: [[]] } : {}), text: [[]], "marker.size": [[]], "marker.color": [[]] }, [1]);
      P.restyle(el, { x: [[]], y: [[]], ...(is3d ? { z: [[]] } : {}), text: [[]] }, [2]);
      // Restore main trace opacity
      P.restyle(el, { "marker.opacity": 0.7, "line.width": 1.5, "line.color": "rgba(100,140,200,0.4)" }, [0]);
      return;
    }

    // Dim main trace
    P.restyle(el, { "marker.opacity": 0.15, "line.width": 0.5, "line.color": "rgba(100,140,200,0.12)" }, [0]);

    const tailStart = Math.max(0, idx - trailLen);
    const trailX = plotData.x.slice(tailStart, idx + 1);
    const trailY = plotData.y.slice(tailStart, idx + 1);
    const trailZ = is3d ? plotData.z.slice(tailStart, idx + 1) : [];
    const trailT = plotData.times.slice(tailStart, idx + 1);
    const trailColors = trailX.map((_, i) => i / trailX.length);
    const trailSizes = trailX.map((_, i) => 2 + (i / trailX.length) * 6);

    // Update trail (trace 1)
    P.restyle(el, {
      x: [trailX], y: [trailY],
      ...(is3d ? { z: [trailZ] } : {}),
      text: [trailT],
      "marker.size": [trailSizes],
      "marker.color": [trailColors],
    }, [1]);

    // Update head (trace 2)
    P.restyle(el, {
      x: [[plotData.x[idx]]],
      y: [[plotData.y[idx]]],
      ...(is3d ? { z: [[plotData.z[idx]]] } : {}),
      text: [[plotData.times[idx]]],
    }, [2]);
  }, [plotData, dim, trailLen]);

  // React to scrubValue changes (from animation or manual scrub)
  useEffect(() => {
    updateComet(scrubValue);
  }, [scrubValue, updateComet]);

  // Animation loop — only updates ref + scrubValue, does NOT trigger full Plotly redraw
  useEffect(() => {
    if (!playing) return;
    let running = true;
    const loop = () => {
      if (!running) return;
      cometPosRef.current += speed;
      if (cometPosRef.current >= plotData.x.length) cometPosRef.current = 0;
      const newVal = Math.floor(cometPosRef.current);
      setScrubValue(prev => prev === newVal ? prev : newVal);
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [playing, speed, plotData.x.length]);

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
      </div>

      {/* Plotly chart */}
      <div ref={plotRef} style={{ width: "100%", height: dim === 3 ? 600 : 500 }} />
      {!loaded && <div className="text-center text-sm text-gray-400 py-8">3Dエンジン読み込み中...</div>}

      {/* Playback */}
      <div className="mt-3 p-3 bg-gray-50 rounded border border-gray-200">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <button onClick={() => {
            if (!playing && scrubValue >= plotData.x.length - 1) { cometPosRef.current = 0; setScrubValue(0); }
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
            <input type="range" min={0.5} max={8} step={0.5} value={speed}
              onChange={e => setSpeed(Number(e.target.value))} className="w-20 accent-blue-600" />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-gray-400">尾長 {trailLen}</span>
            <input type="range" min={10} max={300} step={10} value={trailLen}
              onChange={e => setTrailLen(Number(e.target.value))} className="w-20 accent-blue-600" />
          </label>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-400 w-20 shrink-0">{plotData.times[scrubValue] ?? "---"}</span>
          <input type="range" min={0} max={Math.max(0, plotData.x.length - 1)} value={scrubValue}
            onChange={e => handleScrub(Number(e.target.value))} className="flex-1 accent-blue-600" />
          <span className="text-[10px] text-gray-400 w-20 text-right shrink-0">{plotData.times[plotData.times.length - 1] ?? "---"}</span>
        </div>
      </div>

      {/* Legend */}
      <div className="mt-2 flex items-center justify-center gap-2 text-xs text-gray-500">
        <span>過去</span>
        <div className="w-28 h-2 rounded" style={{ background: "linear-gradient(to right, #3b82f6, #ef4444)" }} />
        <span>現在</span>
        <span className="ml-2 text-gray-400">| ドラッグ: 回転 / スクロール: 拡大縮小</span>
      </div>

      <AnalysisGuide title="アトラクタ探索の使い方">
        <p><span className="font-medium">目的:</span> Takensの埋め込み定理に基づき、1次元時系列から力学系のアトラクタを再構成して可視化します。</p>
        <p><span className="font-medium">操作:</span> 3Dモードではドラッグで回転、スクロールで拡大縮小、右ドラッグで平行移動できます。</p>
        <p><span className="font-medium">パラメータ:</span></p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">{"遅延 \u03C4:"}</span> 遅延座標の時間間隔。小さすぎると対角線に潰れ、大きすぎると構造が崩れます。ACFの最初のゼロクロスや相互情報量の最初の極小が目安。</li>
          <li><span className="font-medium">次元:</span> 2Dは平面断面、3Dは立体構造。</li>
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
