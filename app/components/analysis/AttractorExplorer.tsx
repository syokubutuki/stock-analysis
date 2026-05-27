"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { takensEmbedding } from "../../lib/nonlinear";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Plotly = any;

function loadPlotly(): Promise<Plotly> {
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
  const plotlyRef = useRef<Plotly>(null);
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

  const { values, times } = extractSeries(prices, seriesMode);

  const embedding = useMemo(
    () => takensEmbedding(values, times, tau, dim >= 3 ? 3 : 2),
    [values, times, tau, dim]
  );

  // Data arrays for Plotly
  const plotData = useMemo(() => {
    if (embedding.length === 0) return { x: [], y: [], z: [], times: [] as string[], colors: [] as number[] };
    const x = embedding.map(p => p.x);
    const y = embedding.map(p => p.y);
    const z = dim === 3 ? embedding.map(p => p.z ?? 0) : [];
    const colors = embedding.map((_, i) => i);
    const t = embedding.map(p => p.time);
    return { x, y, z, times: t, colors };
  }, [embedding, dim]);

  useEffect(() => { cometPosRef.current = 0; setScrubValue(0); }, [plotData.x.length, tau, dim]);

  // Load Plotly and create initial plot
  useEffect(() => {
    loadPlotly().then(P => { plotlyRef.current = P; setLoaded(true); });
  }, []);

  // Draw / update the Plotly chart
  useEffect(() => {
    const P = plotlyRef.current;
    const el = plotRef.current;
    if (!P || !el || plotData.x.length === 0) return;

    const n = plotData.x.length;
    const headIdx = Math.min(Math.floor(cometPosRef.current), n - 1);
    const isAnimating = playing || scrubValue > 0;

    const hovertemplate = dim === 3
      ? "x(t): %{x:.4f}<br>x(t-τ): %{y:.4f}<br>x(t-2τ): %{z:.4f}<br>%{text}<extra></extra>"
      : "x(t): %{x:.4f}<br>x(t-τ): %{y:.4f}<br>%{text}<extra></extra>";

    const traces: Plotly[] = [];

    // Main trajectory
    const mainTrace: Plotly = {
      x: plotData.x,
      y: plotData.y,
      text: plotData.times,
      hovertemplate,
      mode: "lines+markers",
      marker: {
        size: 2.5,
        color: plotData.colors,
        colorscale: [[0, "#3b82f6"], [1, "#ef4444"]],
        opacity: isAnimating ? 0.15 : 0.7,
      },
      line: {
        width: isAnimating ? 0.5 : 1.5,
        color: "rgba(100,140,200," + (isAnimating ? "0.15" : "0.4") + ")",
      },
    };

    if (dim === 3) {
      mainTrace.z = plotData.z;
      mainTrace.type = "scatter3d";
    } else {
      mainTrace.type = "scatter";
    }
    traces.push(mainTrace);

    // Comet trail + head
    if (isAnimating && headIdx >= 0) {
      const tailStart = Math.max(0, headIdx - trailLen);
      const trailX = plotData.x.slice(tailStart, headIdx + 1);
      const trailY = plotData.y.slice(tailStart, headIdx + 1);
      const trailT = plotData.times.slice(tailStart, headIdx + 1);
      const trailColors = trailX.map((_, i) => i / trailX.length);
      const trailSizes = trailX.map((_, i) => 2 + (i / trailX.length) * 6);

      const cometTrace: Plotly = {
        x: trailX,
        y: trailY,
        text: trailT,
        hovertemplate,
        mode: "lines+markers",
        marker: {
          size: trailSizes,
          color: trailColors,
          colorscale: [[0, "rgba(100,160,255,0.2)"], [1, "#ffffff"]],
          line: { width: 0 },
        },
        line: { width: 2.5, color: "rgba(120,180,255,0.6)" },
        showlegend: false,
      };

      if (dim === 3) {
        cometTrace.z = plotData.z.slice(tailStart, headIdx + 1);
        cometTrace.type = "scatter3d";
      } else {
        cometTrace.type = "scatter";
      }
      traces.push(cometTrace);

      // Head marker
      const headTrace: Plotly = {
        x: [plotData.x[headIdx]],
        y: [plotData.y[headIdx]],
        text: [plotData.times[headIdx]],
        hovertemplate,
        mode: "markers+text",
        textposition: "top right",
        textfont: { size: 11, color: "#fff", family: "monospace" },
        marker: { size: 12, color: "#ffffff", line: { width: 2, color: "#3b82f6" } },
        showlegend: false,
      };
      if (dim === 3) {
        headTrace.z = [plotData.z[headIdx]];
        headTrace.type = "scatter3d";
      } else {
        headTrace.type = "scatter";
      }
      traces.push(headTrace);
    }

    const layout: Plotly = {
      margin: { l: 40, r: 20, t: 30, b: 40 },
      paper_bgcolor: "#0f172a",
      plot_bgcolor: "#0f172a",
      font: { color: "#94a3b8", size: 10 },
      showlegend: false,
      ...(dim === 3 ? {
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

    // Use react to avoid re-creating the plot when only the comet moves
    if (el.children.length > 0 && (el as Plotly).data) {
      P.react(el, traces, layout, config);
    } else {
      P.newPlot(el, traces, layout, config);
    }
  }, [loaded, plotData, dim, tau, playing, scrubValue, trailLen]);

  // Comet animation loop
  useEffect(() => {
    if (!playing) return;
    let running = true;
    const loop = () => {
      if (!running) return;
      cometPosRef.current += speed;
      if (cometPosRef.current >= plotData.x.length) cometPosRef.current = 0;
      setScrubValue(Math.floor(cometPosRef.current));
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
