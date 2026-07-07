"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PortfolioData } from "../../hooks/usePortfolioData";
import { useBenchmarkPrices, BENCHMARK_PRESETS } from "../../hooks/useBenchmarkPrices";
import { computeCapm, CapmResult } from "../../lib/capm-sml";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  data: PortfolioData;
  window?: number; // リターン窓(本) 既定 250
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

export default function CapmSmlChart({ data, window: win = 250 }: Props) {
  const [open, setOpen] = useState(true);
  const [benchTicker, setBenchTicker] = useState("^N225");
  const [rfPct, setRfPct] = useState(0.5);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoverTicker, setHoverTicker] = useState<string | null>(null);

  const bench = useBenchmarkPrices(benchTicker);
  const benchPreset = BENCHMARK_PRESETS.find((p) => p.ticker === benchTicker);
  const isUsBench = benchPreset?.region === "US";

  const names: Record<string, string> = useMemo(() => {
    const m: Record<string, string> = {};
    for (const [t, v] of Object.entries(data)) m[t] = v.name || t;
    return m;
  }, [data]);

  const result: CapmResult | null = useMemo(() => {
    if (!bench.prices || bench.prices.length < 3) return null;
    const series = Object.entries(data)
      .filter(([, v]) => v.prices.length > 2)
      .map(([ticker, v]) => ({ ticker, prices: v.prices }));
    if (series.length < 1) return null;
    return computeCapm(series, benchTicker, bench.name, bench.prices, rfPct / 100, win);
  }, [data, bench.prices, bench.name, benchTicker, rfPct, win]);

  const bounds = useMemo(() => {
    if (!result) return null;
    const betas = result.assets.map((a) => a.beta);
    const mus = result.assets.map((a) => a.mu);
    const xMin = Math.min(0, ...betas) - 0.1;
    const xMax = Math.max(1.1, ...betas) * 1.1;
    const ys = [...mus, result.muMarket, result.riskFree];
    let yMin = Math.min(...ys);
    let yMax = Math.max(...ys);
    const yPad = (yMax - yMin) * 0.12 || 0.02;
    yMin -= yPad;
    yMax += yPad;
    return { xMin, xMax, yMin, yMax };
  }, [result]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result || !bounds) return;
    const init = initCanvas(canvas, HEIGHT);
    if (!init) return;
    const { ctx, width, height } = init;
    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;
    const sx = (v: number) => PAD.left + ((v - bounds.xMin) / (bounds.xMax - bounds.xMin)) * plotW;
    const sy = (v: number) => PAD.top + (1 - (v - bounds.yMin) / (bounds.yMax - bounds.yMin)) * plotH;

    // グリッド + 軸
    ctx.strokeStyle = "#e5e7eb";
    ctx.fillStyle = "#9ca3af";
    ctx.lineWidth = 1;
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
      ctx.fillText(v.toFixed(1), x, height - PAD.bottom + 6);
    }
    // β=0 と μ=0 の基準線
    ctx.strokeStyle = "#e5e7eb";
    ctx.beginPath();
    if (bounds.yMin < 0 && bounds.yMax > 0) {
      ctx.moveTo(PAD.left, sy(0));
      ctx.lineTo(width - PAD.right, sy(0));
    }
    ctx.stroke();

    // 軸タイトル
    ctx.fillStyle = "#6b7280";
    ctx.fillText("β(市場感応度)", PAD.left + plotW / 2, height - 14);
    ctx.save();
    ctx.translate(12, PAD.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("年率リターン μ", 0, 0);
    ctx.restore();

    // SML: (0, Rf) → (1, μm) を延長
    const slope = result.muMarket - result.riskFree;
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(sx(bounds.xMin), sy(result.riskFree + slope * bounds.xMin));
    ctx.lineTo(sx(bounds.xMax), sy(result.riskFree + slope * bounds.xMax));
    ctx.stroke();
    ctx.setLineDash([]);

    // Rf点 と 市場点(β=1)
    ctx.fillStyle = "#f59e0b";
    ctx.beginPath();
    ctx.arc(sx(0), sy(result.riskFree), 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1d4ed8";
    ctx.beginPath();
    ctx.arc(sx(1), sy(result.muMarket), 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1d4ed8";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(`市場(${result.benchName})`, sx(1) + 7, sy(result.muMarket) - 4);

    // 各銘柄点(SMLより上=割安=緑, 下=割高=赤)
    ctx.font = "10px sans-serif";
    for (const a of result.assets) {
      const x = sx(a.beta);
      const y = sy(a.mu);
      const under = a.mispricing >= 0; // 割安
      const hovered = hoverTicker === a.ticker;
      ctx.fillStyle = under ? "#059669" : "#dc2626";
      ctx.beginPath();
      ctx.arc(x, y, hovered ? 5.5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      // αの見える化: 実現点からSML上の理論点へ縦線
      const yCapm = sy(a.capmExpected);
      ctx.strokeStyle = under ? "rgba(5,150,105,0.4)" : "rgba(220,38,38,0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, yCapm);
      ctx.stroke();
      ctx.fillStyle = hovered ? "#111827" : "#6b7280";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(a.ticker, x + 6, y);
    }
  }, [result, bounds, hoverTicker]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !result || !bounds) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const plotW = rect.width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const sx = (v: number) => PAD.left + ((v - bounds.xMin) / (bounds.xMax - bounds.xMin)) * plotW;
    const sy = (v: number) => PAD.top + (1 - (v - bounds.yMin) / (bounds.yMax - bounds.yMin)) * plotH;
    let best: string | null = null;
    let bestD = 12 * 12;
    for (const a of result.assets) {
      const dx = sx(a.beta) - mx;
      const dy = sy(a.mu) - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = a.ticker;
      }
    }
    setHoverTicker(best);
  };

  if (Object.keys(data).length < 1) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 w-full text-left">
        <span className="inline-block transition-transform" style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>
          ▶
        </span>
        <span className="font-semibold text-gray-800">証券市場線(SML)・β・Jensenのα(CAPM)</span>
        <span className="text-xs text-gray-400">
          {result ? `(対 ${result.benchName} / ${result.assets.length}銘柄 / ${result.nObs}本)` : ""}
        </span>
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          {/* コントロール: ベンチマーク選択 + Rf */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-600">
            <span className="font-medium">市場(ベンチマーク)</span>
            <div className="flex gap-1">
              {BENCHMARK_PRESETS.map((p) => (
                <button
                  key={p.ticker}
                  onClick={() => setBenchTicker(p.ticker)}
                  className={`px-2 py-0.5 rounded ${
                    benchTicker === p.ticker ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <span className="font-medium ml-2">無リスク金利 Rf</span>
            <input
              type="range"
              min={0}
              max={5}
              step={0.1}
              value={rfPct}
              onChange={(e) => setRfPct(parseFloat(e.target.value))}
              className="w-32"
            />
            <span className="tabular-nums w-10">{rfPct.toFixed(1)}%</span>
            {bench.loading && <span className="text-gray-400">指数取得中…</span>}
          </div>

          {isUsBench && (
            <div className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
              米国指数は<strong>ドル建て・時差(前日終値)</strong>のため、日本株との β は非同期取引で過小評価されがちです(Epps効果)。
              円建ての実感やヘッジ比率に使うなら、為替(USDJPY)調整と Dimson 補正(個別分析の減衰β)を併用してください。
            </div>
          )}

          {!result ? (
            <div className="text-xs text-gray-400">
              {bench.error
                ? `指数の取得に失敗しました(${bench.error})。`
                : "共通営業日が不足しています。銘柄数・期間・ベンチマークを見直してください。"}
            </div>
          ) : (
            <>
              <div className="relative">
                <canvas
                  ref={canvasRef}
                  onMouseMove={onMove}
                  onMouseLeave={() => setHoverTicker(null)}
                  className="w-full"
                  style={{ height: HEIGHT }}
                />
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-gray-500 items-center">
                <span className="flex items-center gap-1.5">
                  <svg width="20" height="8">
                    <line x1="0" y1="4" x2="20" y2="4" stroke="#2563eb" strokeWidth="2" strokeDasharray="4 3" />
                  </svg>
                  証券市場線 SML(理論期待リターン)
                </span>
                <Dot color="#1d4ed8" label={`市場ポートフォリオ(β=1)`} />
                <Dot color="#059669" label="SMLより上=割安(α>0)" />
                <Dot color="#dc2626" label="SMLより下=割高(α<0)" />
                <Dot color="#f59e0b" label="無リスク金利 Rf" />
              </div>

              {/* β/α 表 */}
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] tabular-nums">
                  <thead>
                    <tr className="text-gray-400 text-left border-b border-gray-200">
                      <th className="py-1 pr-2 font-medium">銘柄</th>
                      <th className="py-1 px-2 font-medium text-right">β</th>
                      <th className="py-1 px-2 font-medium text-right">α(年率)</th>
                      <th className="py-1 px-2 font-medium text-right">実現μ</th>
                      <th className="py-1 px-2 font-medium text-right">CAPM期待</th>
                      <th className="py-1 px-2 font-medium text-right">相関</th>
                      <th className="py-1 px-2 font-medium text-right">Treynor</th>
                      <th className="py-1 pl-2 font-medium text-right">判定</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...result.assets]
                      .sort((a, b) => b.mispricing - a.mispricing)
                      .map((a) => {
                        const under = a.mispricing >= 0;
                        return (
                          <tr
                            key={a.ticker}
                            className={`border-b border-gray-100 ${hoverTicker === a.ticker ? "bg-blue-50" : ""}`}
                            onMouseEnter={() => setHoverTicker(a.ticker)}
                            onMouseLeave={() => setHoverTicker(null)}
                          >
                            <td className="py-1 pr-2 text-gray-700">
                              <span className="font-medium">{a.ticker}</span>
                              <span className="text-gray-400 ml-1 hidden sm:inline truncate">{names[a.ticker]}</span>
                            </td>
                            <td className="py-1 px-2 text-right text-gray-700">{a.beta.toFixed(2)}</td>
                            <td className={`py-1 px-2 text-right ${a.alphaAnnual >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                              {a.alphaAnnual >= 0 ? "+" : ""}
                              {(a.alphaAnnual * 100).toFixed(1)}%
                            </td>
                            <td className="py-1 px-2 text-right text-gray-600">{(a.mu * 100).toFixed(1)}%</td>
                            <td className="py-1 px-2 text-right text-gray-400">{(a.capmExpected * 100).toFixed(1)}%</td>
                            <td className="py-1 px-2 text-right text-gray-500">{a.corr.toFixed(2)}</td>
                            <td className="py-1 px-2 text-right text-gray-500">
                              {isFinite(a.treynor) ? (a.treynor * 100).toFixed(1) : "—"}
                            </td>
                            <td className={`py-1 pl-2 text-right font-medium ${under ? "text-emerald-600" : "text-red-600"}`}>
                              {under ? "割安" : "割高"}
                            </td>
                          </tr>
                        );
                      })}
                    <tr className="border-t-2 border-gray-300 text-gray-700 font-medium">
                      <td className="py-1 pr-2">等加重PF</td>
                      <td className="py-1 px-2 text-right">{result.portfolioBeta.toFixed(2)}</td>
                      <td className={`py-1 px-2 text-right ${result.portfolioAlphaAnnual >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                        {result.portfolioAlphaAnnual >= 0 ? "+" : ""}
                        {(result.portfolioAlphaAnnual * 100).toFixed(1)}%
                      </td>
                      <td className="py-1 px-2 text-right">{(result.portfolioMu * 100).toFixed(1)}%</td>
                      <td className="py-1 px-2 text-right text-gray-400" colSpan={4}></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <AnalysisGuide title="証券市場線(SML)・β・Jensenのα の詳細理論">
                <p className="font-medium text-gray-700">1. 何を見ているか</p>
                <p>
                  効率的フロンティア/CML が「リスク σ 対リターン」を見るのに対し、SML は<strong>市場全体との連動(β)対リターン</strong>を見ます。
                  CAPM では、分散投資で消せない<strong>市場リスク(β)</strong>だけがリターンで報われ、個別要因(分散で消せる)は報われないと考えます。
                  各銘柄が理論線(SML)より上にあれば、市場リスクの割にリターンが高い=<strong>割安(α&gt;0)</strong>、下なら割高です。
                </p>

                <p className="font-medium text-gray-700 mt-3">2. 数式</p>
                <p>
                  {" βᵢ = Cov(rᵢ, r_m) / Var(r_m) "}(市場が1%動くとき銘柄が平均何%動くか)。
                  CAPM の期待リターンは {" E[Rᵢ] = Rf + βᵢ(E[R_m] − Rf) "}(=SML)。
                  Jensenのα は実現リターンと理論の差 {" αᵢ = R̄ᵢ − [Rf + βᵢ(R̄_m − Rf)] "}(年率換算)。
                  Treynorレシオ = {" (μᵢ − Rf) / βᵢ "}(市場リスク1単位あたり超過リターン)。
                </p>

                <p className="font-medium text-gray-700 mt-3">3. 用語</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li><strong>β(ベータ)</strong>: 市場感応度。β&gt;1で市場より値動きが激しい、β&lt;1で穏やか、β&lt;0で逆行。</li>
                  <li><strong>Jensenのα</strong>: 市場エクスポージャーで説明できない超過リターン。銘柄選択の「腕」の指標。</li>
                  <li><strong>市場ポートフォリオ</strong>: ここでは選んだ指数(日経225等)を代理として使用。β=1・α=0の基準点。</li>
                  <li><strong>Treynorレシオ</strong>: シャープ比の分母をσでなくβにしたもの。分散済みPFの評価に向く。</li>
                </ul>

                <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>点が青いSMLより<strong>上=割安</strong>(緑)、<strong>下=割高</strong>(赤)。縦線の長さがαの大きさ。</li>
                  <li>右にある(β大)ほど景気・相場全体に振られやすい。左(β小)は相場に鈍い守りの銘柄。</li>
                  <li>等加重PFのβが自分の「相場全体への賭け金」。β≒1なら実質的に指数を持っているのに近い。</li>
                </ul>

                <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>αが継続的に正の銘柄は選別の価値あり。ただし過去のαが将来続く保証はない(平均回帰しやすい)。</li>
                  <li>PFのβが高すぎると感じたら、低β銘柄や現金を足してβを目標水準へ調整(β=市場への露出のダイヤル)。</li>
                  <li>効率的フロンティアの接点(空売り無し)とSMLの割安銘柄を照合すると、配分と選別の両面から裏取りできる。</li>
                </ul>

                <p className="font-medium text-gray-700 mt-3">6. 注意点</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>βは推定誤差が大きく、期間・窓で揺れる。単一の点推定を過信しない。</li>
                  <li>指数は「真の市場ポートフォリオ」ではなくその代理。指数の選び方でα・βは変わる。</li>
                  <li>米国指数×日本株は通貨(ドル建て)と時差(非同期)でβが下方バイアス。上部の注意を参照。</li>
                  <li>CAPMは単一ファクター。規模・バリュー等の効果は説明できず、αにそれらが混入する。</li>
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
      <svg width="10" height="10">
        <circle cx="5" cy="5" r="4" fill={color} />
      </svg>
      {label}
    </span>
  );
}
