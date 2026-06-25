"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PortfolioData } from "../../hooks/usePortfolioData";
import { alignReturns } from "../../lib/portfolio-risk";
import {
  efficientFrontier,
  EfficientFrontierResult,
  PortfolioPoint,
} from "../../lib/efficient-frontier";
import AnalysisGuide from "./AnalysisGuide";

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

const PAD = { left: 56, right: 16, top: 16, bottom: 40 };
const HEIGHT = 420;

export default function EfficientFrontierChart({ data, window: win = 250 }: Props) {
  const [open, setOpen] = useState(true);
  const [rfPct, setRfPct] = useState(0.5); // 年率Rf(%)
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
    return efficientFrontier(aligned, rfPct / 100, { monteCarlo: 4000, seed: 12345 });
  }, [data, win, rfPct]);

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
    if (result.tangency) push(result.tangency.sigma, result.tangency.mu);
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
  }, [result]);

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
    ctx.fillText("年率期待リターン μ", 0, 0);
    ctx.restore();

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

    // A: 効率的フロンティア双曲線(効率的枝=実線緑, 非効率枝=破線灰)
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

    // CML(資本市場線)
    if (result.cml.length === 2) {
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(sx(result.cml[0].sigma), sy(result.cml[0].mu));
      ctx.lineTo(sx(result.cml[1].sigma), sy(result.cml[1].mu));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 個別銘柄
    ctx.fillStyle = "#6b7280";
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
      ctx.fillStyle = "#6b7280";
      ctx.fillText(a.ticker, x + 5, y);
    }

    // Rf点
    ctx.fillStyle = "#f59e0b";
    ctx.beginPath();
    ctx.arc(sx(0), sy(result.riskFree), 3, 0, Math.PI * 2);
    ctx.fill();

    // マーカー描画ヘルパ
    const marker = (p: { sigma: number; mu: number }, color: string, kind: "star" | "diamond" | "circle", label: string) => {
      const x = sx(p.sigma), y = sy(p.mu);
      ctx.fillStyle = color;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (kind === "diamond") {
        ctx.moveTo(x, y - 6);
        ctx.lineTo(x + 6, y);
        ctx.lineTo(x, y + 6);
        ctx.lineTo(x - 6, y);
        ctx.closePath();
      } else if (kind === "star") {
        for (let i = 0; i < 10; i++) {
          const r = i % 2 === 0 ? 7 : 3;
          const ang = (Math.PI / 5) * i - Math.PI / 2;
          const px = x + r * Math.cos(ang), py = y + r * Math.sin(ang);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
      } else {
        ctx.arc(x, y, 5, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(label, x + 8, y - 8);
    };

    // ロングオンリー最適(雲の代表点)
    marker(result.cloudMinVol, "#0ea5e9", "circle", "最小分散(LO)");
    marker(result.cloudBestSharpe, "#7c3aed", "circle", "最大Sharpe(LO)");
    // 閉形式の特異点
    marker(result.gmv, "#2563eb", "diamond", "GMV");
    if (result.tangency) marker(result.tangency, "#dc2626", "star", "接点(市場)");

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
  }, [result, bounds, hover]);

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
          {result ? `(${result.tickers.length}銘柄 / ${result.nObs}本${result.shrinkage > 0 ? ` / 収縮λ=${result.shrinkage}` : ""})` : ""}
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
                <span className="text-gray-400">
                  CML はこの Rf 点から接点へ引いた線。Rf を上げると接点(市場ポートフォリオ)が移動します。
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
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
                <Legend color="#059669" label="効率的フロンティア(空売り可・実線)" />
                <Legend color="#9ca3af" label="非効率枝(破線)" />
                <Legend color="#f59e0b" label="資本市場線 CML" />
                <Legend color="#2563eb" label="GMV(大域最小分散)" />
                <Legend color="#dc2626" label="接点=市場ポートフォリオ" />
                <Legend color="#7c3aed" label="最大Sharpe(ロングオンリー)" />
                <Legend color="#0ea5e9" label="最小分散(ロングオンリー)" />
                <span className="text-gray-400">点群=ランダム配分(色=シャープ比 青低→緑→赤高)</span>
              </div>

              {/* 代表ポートフォリオの構成 */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                <WeightTable title="接点(市場)ポートフォリオ" subtitle="最大シャープ・空売り可" point={result.tangency} tickers={result.tickers} names={names} riskFree={result.riskFree} />
                <WeightTable title="最大Sharpe(ロングオンリー)" subtitle="空売り無し・実装可能" point={result.cloudBestSharpe} tickers={result.tickers} names={names} riskFree={result.riskFree} />
                <WeightTable title="GMV(大域最小分散)" subtitle="期待リターン推定に頑健" point={result.gmv} tickers={result.tickers} names={names} riskFree={result.riskFree} />
              </div>

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
                  <li>本実装は2種類を重ねて表示: <strong>緑線=空売り可の理論縁</strong>、<strong>雲=空売り無しの現実的領域</strong>。両者の差が「空売り制約のコスト」。</li>
                </ul>

                <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>「最大Sharpe(ロングオンリー)」の構成比を、実際のリバランス目標として使える(空売り不要で実装可能)。</li>
                  <li>リスクを抑えたい局面では GMV の構成比を採用。期待リターン推定に依存せず安定。</li>
                  <li>現在の保有が雲の内側にあるなら、同じリスクでフロンティアまでリターンを引き上げる余地がある。</li>
                  <li>Rf スライダーを動かし、金利環境の変化で最適配分(接点)がどう動くかを確認できる。</li>
                </ul>

                <p className="font-medium text-gray-700 mt-3">6. 注意点</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li><strong>期待リターン μ の推定は極めて不安定</strong>。過去平均をそのまま使うフロンティア(特に接点)は将来に外れやすく、過学習しやすい。実務では GMV やリスクパリティの方が頑健なことが多い。</li>
                  <li>銘柄数が標本数に近い・高相関だと Σ が特異に近づき逆行列が暴れる。本実装は必要時に対角へ収縮(リッジ λ)を加えて安定化する(ヘッダに λ 表示)。</li>
                  <li>空売り可の閉形式はウェイトが大きな正負に振れることがある。現実に使うのはロングオンリー側。</li>
                  <li>共通営業日でしか整列できないため、上場間もない銘柄があると全体の期間が短くなる。過去≠未来。</li>
                </ul>
              </AnalysisGuide>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function WeightTable({
  title,
  subtitle,
  point,
  tickers,
  names,
  riskFree,
}: {
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
        <div className="font-medium text-gray-600">{title}</div>
        <div className="mt-2">この Rf では定義されません(接点が最小分散点より下)。Rf を調整してください。</div>
      </div>
    );
  }
  // ウェイト降順(絶対値)
  const rows = tickers
    .map((t, i) => ({ ticker: t, w: point.weights[i] }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200 p-3">
      <div className="font-medium text-gray-700 text-sm">{title}</div>
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
