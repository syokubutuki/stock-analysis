"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PortfolioData } from "../../hooks/usePortfolioData";
import { alignReturns } from "../../lib/portfolio-risk";
import { michaudResample, ResampleResult } from "../../lib/frontier-resample";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  data: PortfolioData;
  window?: number;
}

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

const PAD = { left: 56, right: 16, top: 16, bottom: 40 };
const HEIGHT = 400;

export default function ResampledFrontierChart({ data, window: win = 250 }: Props) {
  const [open, setOpen] = useState(true);
  const [rfPct, setRfPct] = useState(0.5);
  const [nBoot, setNBoot] = useState(300);
  const [maxWeightPct, setMaxWeightPct] = useState(100);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ResampleResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const names: Record<string, string> = useMemo(() => {
    const m: Record<string, string> = {};
    for (const [t, v] of Object.entries(data)) m[t] = v.name || t;
    return m;
  }, [data]);

  const aligned = useMemo(() => {
    const series = Object.entries(data)
      .filter(([, v]) => v.prices.length > 2)
      .map(([ticker, v]) => ({ ticker, prices: v.prices }));
    if (series.length < 2) return null;
    return alignReturns(series, win);
  }, [data, win]);

  const run = () => {
    if (!aligned) {
      setErr("共通営業日が不足しています(2銘柄以上)。");
      return;
    }
    setRunning(true);
    setErr(null);
    setTimeout(() => {
      try {
        const res = michaudResample(aligned, rfPct / 100, {
          covShrinkage: true,
          muShrinkage: true,
          maxWeight: maxWeightPct / 100,
          nBoot,
          seed: 20240701,
        });
        if (!res) setErr("計算に失敗しました(標本不足・特異行列の可能性)。");
        setResult(res);
      } catch (e) {
        setErr(String((e as Error)?.message || e));
        setResult(null);
      } finally {
        setRunning(false);
      }
    }, 30);
  };

  const bounds = useMemo(() => {
    if (!result) return null;
    const xs: number[] = [0];
    const ys: number[] = [result.riskFree];
    const add = (p: { sigma: number; mu: number }) => {
      xs.push(p.sigma);
      ys.push(p.mu);
    };
    result.tangencyCloud.forEach(add);
    result.minVarCloud.forEach(add);
    if (result.tangencyInSample) add(result.tangencyInSample);
    if (result.minVarInSample) add(result.minVarInSample);
    let xMax = Math.max(...xs);
    const sortedX = [...xs].sort((a, b) => a - b);
    if (sortedX.length > 20) xMax = Math.min(xMax, sortedX[Math.floor(sortedX.length * 0.98)] * 1.1);
    const xMin = Math.min(...xs);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const xPad = (xMax - xMin) * 0.08 || 0.01;
    const yPad = (yMax - yMin) * 0.1 || 0.01;
    return { xMin: Math.max(0, xMin - xPad), xMax: xMax + xPad, yMin: yMin - yPad, yMax: yMax + yPad };
  }, [result]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result || !bounds) return;
    const c = initCanvas(canvas, HEIGHT);
    if (!c) return;
    const { ctx, width, height } = c;
    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;
    const sx = (v: number) => PAD.left + ((v - bounds.xMin) / (bounds.xMax - bounds.xMin)) * plotW;
    const sy = (v: number) => PAD.top + (1 - (v - bounds.yMin) / (bounds.yMax - bounds.yMin)) * plotH;

    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 5; i++) {
      const v = bounds.yMin + ((bounds.yMax - bounds.yMin) * i) / 5;
      const y = sy(v);
      ctx.strokeStyle = "#f3f4f6";
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(width - PAD.right, y);
      ctx.stroke();
      ctx.fillText(`${(v * 100).toFixed(0)}%`, PAD.left - 6, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 0; i <= 6; i++) {
      const v = bounds.xMin + ((bounds.xMax - bounds.xMin) * i) / 6;
      const x = sx(v);
      ctx.strokeStyle = "#f3f4f6";
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, height - PAD.bottom);
      ctx.stroke();
      ctx.fillText(`${(v * 100).toFixed(0)}%`, x, height - PAD.bottom + 6);
    }
    ctx.fillStyle = "#6b7280";
    ctx.fillText("年率リスク σ", PAD.left + plotW / 2, height - 14);
    ctx.save();
    ctx.translate(12, PAD.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("年率期待リターン μ", 0, 0);
    ctx.restore();

    // リサンプル雲
    const dot = (p: { sigma: number; mu: number }, color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx(p.sigma), sy(p.mu), 1.6, 0, Math.PI * 2);
      ctx.fill();
    };
    result.minVarCloud.forEach((p) => dot(p, "rgba(14,165,233,0.35)"));
    result.tangencyCloud.forEach((p) => dot(p, "rgba(220,38,38,0.30)"));

    // マーカー(単発=中空, Michaud=塗り)
    const mark = (
      p: { sigma: number; mu: number } | null,
      color: string,
      filled: boolean,
      label: string
    ) => {
      if (!p) return;
      const x = sx(p.sigma), y = sy(p.mu);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.fillStyle = filled ? color : "#ffffff";
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x + 9, y);
    };
    mark(result.minVarInSample, "#0ea5e9", false, "最小分散(単発)");
    mark(result.tangencyInSample, "#dc2626", false, "接点(単発)");
    mark(result.minVarMichaud, "#0369a1", true, "最小分散(Michaud)");
    mark(result.tangencyMichaud, "#b91c1c", true, "接点(Michaud)");
  }, [result, bounds]);

  const stability = useMemo(() => {
    if (!result) return [];
    return [...result.stability].sort((a, b) => b.tanMean - a.tanMean);
  }, [result]);
  const maxMean = Math.max(0.01, ...stability.map((s) => s.tanMean + s.tanStd));

  if (Object.keys(data).length < 2) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 w-full text-left">
        <span className="inline-block transition-transform" style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>
          ▶
        </span>
        <span className="font-semibold text-gray-800">Michaud リサンプリング(頑健フロンティア)</span>
        <span className="text-xs text-gray-400">
          {result ? `(${result.tickers.length}銘柄 / ${result.nBoot}回 / ${result.nObs}本)` : ""}
        </span>
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-600">
            <span className="font-medium">Rf</span>
            <input type="range" min={0} max={5} step={0.1} value={rfPct} onChange={(e) => setRfPct(parseFloat(e.target.value))} className="w-24" />
            <span className="tabular-nums w-10">{rfPct.toFixed(1)}%</span>
            <span className="font-medium ml-1">ブート回数</span>
            <div className="flex gap-1">
              {[100, 300, 600].map((v) => (
                <button
                  key={v}
                  onClick={() => setNBoot(v)}
                  className={`px-2 py-0.5 rounded ${nBoot === v ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
                >
                  {v}
                </button>
              ))}
            </div>
            <span className="flex items-center gap-1.5">
              <span className="font-medium">1銘柄上限</span>
              <input type="range" min={10} max={100} step={5} value={maxWeightPct} onChange={(e) => setMaxWeightPct(parseInt(e.target.value))} className="w-24" />
              <span className="tabular-nums w-10">{maxWeightPct === 100 ? "なし" : `${maxWeightPct}%`}</span>
            </span>
            <button onClick={run} disabled={running || !aligned} className="px-3 py-1 bg-gray-800 text-white rounded hover:bg-gray-700 disabled:opacity-50">
              {running ? "計算中…" : result ? "再計算" : "リサンプリング実行"}
            </button>
          </div>

          {err && <div className="text-xs text-red-500">{err}</div>}

          {!result ? (
            <div className="text-xs text-gray-400">
              「リサンプリング実行」で、履歴をブートストラップして接点・最小分散を何度も解き直し、最適点の揺れ(信頼雲)と推定誤差に頑健な平均配分(Michaud)を求めます。
            </div>
          ) : (
            <>
              <canvas ref={canvasRef} className="w-full" style={{ height: HEIGHT }} />

              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-gray-500 items-center">
                <Dot color="rgba(220,38,38,0.5)" label="接点の揺れ(リサンプル雲)" />
                <Dot color="rgba(14,165,233,0.5)" label="最小分散の揺れ" />
                <span className="flex items-center gap-1.5">
                  <svg width="12" height="12"><circle cx="6" cy="6" r="4.5" fill="#fff" stroke="#dc2626" strokeWidth="2" /></svg>
                  単発推定(揺れの中心)
                </span>
                <span className="flex items-center gap-1.5">
                  <svg width="12" height="12"><circle cx="6" cy="6" r="4.5" fill="#b91c1c" /></svg>
                  Michaud平均(頑健配分)
                </span>
              </div>

              {/* ウェイト安定度(接点) */}
              <div>
                <div className="text-xs font-medium text-gray-700 mb-1">接点ウェイトの安定度(平均 ± 標準偏差)</div>
                <div className="space-y-1">
                  {stability.map((s) => (
                    <div key={s.ticker} className="flex items-center gap-2 text-[11px]">
                      <span className="w-24 shrink-0 truncate text-gray-600" title={names[s.ticker]}>
                        {s.ticker}
                      </span>
                      <div className="flex-1 bg-gray-100 rounded h-3 relative overflow-hidden">
                        {/* ±1σ 帯 */}
                        <div
                          className="absolute h-full bg-red-200"
                          style={{
                            left: `${(Math.max(0, s.tanMean - s.tanStd) / maxMean) * 100}%`,
                            width: `${(Math.min(maxMean, s.tanMean + s.tanStd) - Math.max(0, s.tanMean - s.tanStd)) / maxMean * 100}%`,
                          }}
                        />
                        {/* 平均 */}
                        <div className="absolute top-0 h-full w-0.5 bg-red-600" style={{ left: `${(s.tanMean / maxMean) * 100}%` }} />
                      </div>
                      <span className="w-24 text-right tabular-nums text-gray-600 shrink-0">
                        {(s.tanMean * 100).toFixed(0)}% ±{(s.tanStd * 100).toFixed(0)}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-gray-400 mt-1">
                  σ(ばらつき)が大きい銘柄ほど、そのウェイトは推定誤差に振られやすく<strong>信頼できない</strong>。σが小さい銘柄の配分ほど頑健。
                </p>
              </div>

              <AnalysisGuide title="Michaud リサンプリングの詳細理論">
                <p className="font-medium text-gray-700">1. 何を見ているか</p>
                <p>
                  平均分散最適化は入力の推定誤差に極端に敏感で、データが少し変わるだけで最適ウェイトが大きく動きます。
                  ここでは履歴を<strong>ブートストラップ(復元抽出)して何度も最適化をやり直し</strong>、得られた最適点を σ-μ 平面に散らして
                  「最適点がどれだけ揺れるか」を可視化します。さらに各回のウェイトを<strong>平均</strong>したものが Michaud 配分で、単発の最適化より頑健です。
                </p>

                <p className="font-medium text-gray-700 mt-3">2. 手順</p>
                <p>
                  元の日次リターン(T本)から T本を復元抽出して擬似履歴を作り(同時点の相関は保たれる)、その都度 μ・Σ を再推定して
                  空売り無しの接点・最小分散を解く。各解を<strong>元サンプルのモデルで評価</strong>して σ-μ に打点。これを {result.nBoot} 回繰り返す。
                  平均ウェイト {"w̄ = (1/B) Σ_b w_b"} を正規化したものが Michaud 配分。
                </p>

                <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>雲が<strong>広いほど推定が不安定</strong>=その最適化は信用しづらい。狭ければ頑健。</li>
                  <li>中空マーカー(単発)と塗りマーカー(Michaud)がずれるほど、単発解は運任せの偏りを含む。</li>
                  <li>下のウェイト安定度で σ が大きい銘柄は「入れるべきか自信が持てない」。小さい銘柄の配分は信頼できる。</li>
                </ul>

                <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>単発の接点より Michaud 平均配分を採用すると、リバランスのたびに大きく組み替える無駄を減らせる。</li>
                  <li>ウェイト σ の大きい銘柄は小さめに、または見送る判断材料になる(過信の抑制)。</li>
                  <li>雲が広い局面は最適化自体を控え、等加重やリスクパリティに寄せる根拠になる。</li>
                </ul>

                <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>ブートストラップは時系列の自己相関・ボラクラスタリングを壊す(iid 仮定)。厳密にはブロック・ブートが望ましい。</li>
                  <li>平均ウェイトは制約(上限)を厳密には満たさないことがある(正規化で吸収)。</li>
                  <li>頑健化は「過去の揺れ」に対して。構造変化(レジーム転換)には別途対処が要る。</li>
                </ul>
              </AnalysisGuide>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Dot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="10" height="10"><circle cx="5" cy="5" r="4" fill={color} /></svg>
      {label}
    </span>
  );
}
