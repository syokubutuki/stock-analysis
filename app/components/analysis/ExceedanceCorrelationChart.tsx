"use client";

// 「下落時 “だけ” 相関が上がる」のか — exceedance correlation vs 2変量正規のヌル
//
// docs/portfolio-analysis-open-issues.md §4 の課題に対する新規分析。
// 既存の危機時相関（dcc.ts / pf-corr-drag）は「直近60日のボラが上位25%」という
// **上下対称**な定義なので、テールの非対称性そのものは検証できない。ここを埋める。
//
// 描画方式（CLAUDE.md の規約）: 横軸は時間ではなく「閾値 θ（標準偏差単位）」の静的図なので
// Canvas2D。ズームの価値がなく、一枚絵として読ませるのが正しい。

import { useEffect, useMemo, useRef, useState } from "react";
import { PortfolioData } from "../../hooks/usePortfolioData";
import { Horizon, HORIZON_CONFIG } from "../../lib/signal-digest";
import { alignReturns } from "../../lib/portfolio-risk";
import {
  ExceedanceResult,
  exceedanceCorrelation,
} from "../../lib/exceedance-correlation";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  data: PortfolioData;
  horizon?: Horizon;
}

/** テールを測るには標本が要るので、60日窓（デイトレ）は使わせない。 */
const TAIL_HORIZONS: Horizon[] = ["swing", "position"];

const HEIGHT = 340;
const DOWN_COLOR = "#b91c1c";
const UP_COLOR = "#2563eb";

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  if (width <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

const pv = (p: number) => (Number.isFinite(p) ? (p < 0.001 ? "<0.001" : p.toFixed(3)) : "—");
const cv = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const sv = (v: number, d = 2) =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}` : "—";

export default function ExceedanceCorrelationChart({ data, horizon = "position" }: Props) {
  // 窓はこの分析だけ独立に選べるようにする。テール標本は長い期間ほど増えるので、
  // 「窓を伸ばすと結論が変わるか」を試せること自体が診断になる。
  // テールの標本を確保するため、デイトレ窓（60日）は選択肢に出さない。
  const [win, setWin] = useState<Horizon>(horizon === "daytrade" ? "swing" : horizon);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const names: Record<string, string> = useMemo(() => {
    const m: Record<string, string> = {};
    for (const [t, v] of Object.entries(data)) m[t] = v.name || t;
    return m;
  }, [data]);

  const result: ExceedanceResult | null = useMemo(() => {
    const series = Object.entries(data)
      .filter(([, v]) => v.prices.length > 2)
      .map(([ticker, v]) => ({ ticker, prices: v.prices }));
    if (series.length < 2) return null;
    const aligned = alignReturns(series, HORIZON_CONFIG[win].window);
    if (aligned.tickers.length < 2) return null;
    return exceedanceCorrelation(aligned);
  }, [data, win]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result || !result.ok) return;
    const draw = () => drawSmile(canvas, result);
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [result]);

  if (!result) {
    return (
      <div className="text-xs text-gray-400">
        2銘柄以上の共通営業日が必要です。ウォッチリストに銘柄を追加してください。
      </div>
    );
  }

  const asymSig = Number.isFinite(result.asymMeanP) && result.asymMeanP < 0.05;
  const downSig = Number.isFinite(result.downExcessP) && result.downExcessP < 0.05;
  const verdict = !result.ok
    ? "判定不能"
    : asymSig && result.asymMean > 0
      ? "下落時だけ相関が上がっている"
      : asymSig && result.asymMean < 0
        ? "上昇時のほうが相関が高い（逆の非対称）"
        : "非対称性は検出されない";
  const verdictTone = !result.ok
    ? "border-gray-200 bg-gray-50 text-gray-600"
    : asymSig && result.asymMean > 0
      ? "border-red-300 bg-red-50 text-red-800"
      : asymSig
        ? "border-blue-300 bg-blue-50 text-blue-800"
        : "border-gray-200 bg-gray-50 text-gray-700";

  return (
    <div className="space-y-4">
      {/* ── 窓の選択 ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
        <span className="font-medium">期間</span>
        {TAIL_HORIZONS.map((h) => (
          <button
            key={h}
            onClick={() => setWin(h)}
            className={`px-2 py-0.5 rounded ${
              win === h ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"
            }`}
          >
            {HORIZON_CONFIG[h].label}
          </button>
        ))}
        {result.ok && (
          <span className="text-gray-400 tabular-nums">
            {result.tickers.length}銘柄 / {result.nPairs}ペア / {result.T}日 / ヌル{result.sims}本
          </span>
        )}
        <span className="text-[10px] text-gray-400">
          既定は最長窓。テールは標本が急に薄くなるので、短い窓だと θ=1.5σ が測れません。
        </span>
      </div>

      {!result.ok ? (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
          この構成では判定できませんでした（{result.reason}）。期間の長い窓を選ぶか、銘柄を増やしてください。
        </div>
      ) : (
        <>
          {/* ── 判定バナー ─────────────────────────────────────────── */}
          <div className={`rounded-lg border-2 px-3 py-2 ${verdictTone}`}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm font-bold">{verdict}</span>
              <span className="text-xs tabular-nums">
                平均非対称性 Ā = ρ⁻ − ρ⁺ = <strong>{sv(result.asymMean)}</strong>（両側 p ={" "}
                {pv(result.asymMeanP)}）
              </span>
              <span className="text-xs tabular-nums opacity-80">
                下側のヌル超過 <strong>{sv(result.downExcess)}</strong>（p = {pv(result.downExcessP)}）
                ／ 上側 <strong>{sv(result.upExcess)}</strong>（p = {pv(result.upExcessP)}）
              </span>
              <span className="text-xs tabular-nums opacity-80">
                総合 H = {cv(result.h, 3)}（p = {pv(result.hP)}）
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed">
              {asymSig && result.asymMean > 0 ? (
                <>
                  無条件相関が同じ<strong>2変量正規（完全対称・テール依存性ゼロ）</strong>を
                  {result.sims}本まわしたヌル分布と比べて、下側の相関が上側より
                  <strong>統計的に有意に高い</strong>。つまりあなたの組み合わせは
                  <strong>下げるときだけ一緒に動く</strong>——分散が最も必要な場面で最も効かない、
                  という最悪の性質を持っています。建玉上限は平時の相関ではなく
                  <strong>下側の相関</strong>で決めてください。
                  {Number.isFinite(result.upExcessP) && result.upExcessP < 0.05 && (
                    <>
                      {" "}なお<strong>上側もヌルより有意に高い</strong>（p = {pv(result.upExcessP)}）ので、
                      「テール全般で依存が強い（裾が厚い・ボラが固まる）」性質と
                      「下側だけ強い非対称」が<strong>重なって</strong>います。
                      前者はヌルを正規に取っていることの副作用でも生じるため、
                      <strong>確かなのは上下の差（Ā）のほう</strong>だと読んでください。
                    </>
                  )}
                </>
              ) : asymSig ? (
                <>
                  下側より<strong>上側</strong>の相関が有意に高い、という珍しい形です。
                  上昇局面で一斉に上がり、下げでは散らばる。分散という観点では
                  <strong>むしろ好ましい</strong>方向ですが、標本固有の可能性も高いので窓を変えて確かめてください。
                </>
              ) : (
                <>
                  下側の相関は<strong>2変量正規のヌルで説明できる範囲</strong>に収まっています。
                  下のグラフで<strong>実測（赤/青）がヌル帯（灰）の中に入っている</strong>のがそれです。
                  「テールでは相関が上がる」とよく言われますが、
                  <strong>この銘柄構成・この期間では検出できません</strong>。
                  ここで重要なのは、<strong>条件付きで測ると相関の絶対値は必ず下がる</strong>という点で
                  （ヌルの灰色線も下がっています）、その下がり方が正規と同じなら
                  <strong>それは「相関が下がった」のではなく測り方の性質</strong>です。
                </>
              )}
              {downSig && !asymSig && (
                <>
                  {" "}ただし下側は<strong>ヌルより有意に高い</strong>（p = {pv(result.downExcessP)}）——
                  上側も同時に高いので「テール全般で依存が強い」形です（対称なテール依存）。
                </>
              )}
            </p>
          </div>

          {/* ── スマイル図 ─────────────────────────────────────────── */}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1.5">
              exceedance correlation の形：実測 vs 2変量正規のヌル帯
            </div>
            <div className="relative">
              <canvas ref={canvasRef} className="w-full" />
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
              <span className="flex items-center gap-1">
                <span className="inline-block w-4 h-0.5" style={{ background: DOWN_COLOR }} />
                実測 ρ⁻（ともに −θ 以下の日）
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-4 h-0.5" style={{ background: UP_COLOR }} />
                実測 ρ⁺（ともに +θ 以上の日）
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-4 h-2 bg-gray-300 opacity-60" />
                ヌルの90%帯（2変量正規・同じ無条件相関・同じ標本数）
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-4 border-t border-dashed border-gray-500" />
                無条件相関 ρ̄ = {cv(result.rhoAll)}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-gray-500">
              <strong>灰色の帯より上に出ているところだけが「本物」</strong>です。
              実測が右肩下がりでも、ヌルも同じだけ下がっていれば、それは
              <strong>条件付けで標本を切り詰めた結果</strong>であって相関の変化ではありません。
            </p>
          </div>

          {/* ── 水準別の表 ─────────────────────────────────────────── */}
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] tabular-nums border-collapse">
              <thead>
                <tr className="text-gray-400 text-left border-b border-gray-200">
                  <th className="py-1 pr-2 font-medium">閾値 θ</th>
                  <th className="py-1 px-2 font-medium text-right">下側 ρ⁻</th>
                  <th className="py-1 px-2 font-medium text-right">ヌル平均</th>
                  <th className="py-1 px-2 font-medium text-right">p</th>
                  <th className="py-1 px-2 font-medium text-right">日数</th>
                  <th className="py-1 px-2 font-medium text-right">上側 ρ⁺</th>
                  <th className="py-1 px-2 font-medium text-right">ヌル平均</th>
                  <th className="py-1 px-2 font-medium text-right">p</th>
                  <th className="py-1 px-2 font-medium text-right">日数</th>
                  <th className="py-1 px-2 font-medium text-right">非対称 A</th>
                  <th className="py-1 pl-2 font-medium text-right">A の p</th>
                </tr>
              </thead>
              <tbody>
                {result.levels.map((l) => {
                  const sig = Number.isFinite(l.asymP) && l.asymP < 0.05;
                  return (
                    <tr
                      key={l.theta}
                      className={`border-b border-gray-100 ${l.ok ? "" : "text-gray-300"}`}
                    >
                      <td className="py-1 pr-2 text-gray-700">
                        ±{l.theta.toFixed(1)}σ
                        {l.theta === result.refTheta && (
                          <span className="ml-1 text-[9px] text-gray-400">参照</span>
                        )}
                      </td>
                      <td className="py-1 px-2 text-right font-medium" style={{ color: DOWN_COLOR }}>
                        {cv(l.down.corr)}
                      </td>
                      <td className="py-1 px-2 text-right text-gray-400">{cv(l.down.nullMean)}</td>
                      <td
                        className={`py-1 px-2 text-right ${
                          Number.isFinite(l.down.p) && l.down.p < 0.05 ? "text-red-700 font-medium" : "text-gray-400"
                        }`}
                      >
                        {pv(l.down.p)}
                      </td>
                      <td className="py-1 px-2 text-right text-gray-400">
                        {Number.isFinite(l.down.days) ? l.down.days.toFixed(0) : "—"}
                      </td>
                      <td className="py-1 px-2 text-right font-medium" style={{ color: UP_COLOR }}>
                        {cv(l.up.corr)}
                      </td>
                      <td className="py-1 px-2 text-right text-gray-400">{cv(l.up.nullMean)}</td>
                      <td
                        className={`py-1 px-2 text-right ${
                          Number.isFinite(l.up.p) && l.up.p < 0.05 ? "text-blue-700 font-medium" : "text-gray-400"
                        }`}
                      >
                        {pv(l.up.p)}
                      </td>
                      <td className="py-1 px-2 text-right text-gray-400">
                        {Number.isFinite(l.up.days) ? l.up.days.toFixed(0) : "—"}
                      </td>
                      <td className={`py-1 px-2 text-right ${sig ? "font-semibold" : ""}`}>
                        {sv(l.asym)}
                        <span className="text-gray-300">
                          {" "}
                          [{cv(l.asymLo)}, {cv(l.asymHi)}]
                        </span>
                      </td>
                      <td
                        className={`py-1 pl-2 text-right ${
                          sig ? "text-amber-700 font-medium" : "text-gray-400"
                        }`}
                      >
                        {pv(l.asymP)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-[10px] text-gray-400 mt-1">
              「日数」は有効ペアの平均条件付き日数（両銘柄が同時に閾値を超えた日）。
              {result.minObs}日未満のペアはその水準で除外しています。
              角括弧はヌルでの A の90%帯——<strong>実測 A がこの外に出ていれば非対称</strong>。
              θ を上げるほど日数が減り、帯は必ず広がります（＝厳しいテールほど判定は難しい）。
            </p>
          </div>

          {/* ── ペア別内訳 ─────────────────────────────────────────── */}
          {result.pairs.length > 0 && (
            <div className="overflow-x-auto">
              <div className="text-xs font-semibold text-gray-700 mb-1">
                ペア別（θ = ±{result.refTheta.toFixed(1)}σ・非対称性の大きい順）
              </div>
              <table className="w-full text-[11px] tabular-nums border-collapse">
                <thead>
                  <tr className="text-gray-400 text-left border-b border-gray-200">
                    <th className="py-1 pr-2 font-medium">ペア</th>
                    <th className="py-1 px-2 font-medium text-right">無条件 ρ</th>
                    <th className="py-1 px-2 font-medium text-right">下側 ρ⁻</th>
                    <th className="py-1 px-2 font-medium text-right">上側 ρ⁺</th>
                    <th className="py-1 px-2 font-medium text-right">A = ρ⁻−ρ⁺</th>
                    <th className="py-1 pl-2 font-medium text-right">p</th>
                  </tr>
                </thead>
                <tbody>
                  {result.pairs.slice(0, 12).map((p) => (
                    <tr key={`${p.a}|${p.b}`} className="border-b border-gray-100">
                      <td className="py-1 pr-2 text-gray-700">
                        <span className="font-medium">{p.a}</span>
                        <span className="text-gray-300"> × </span>
                        <span className="font-medium">{p.b}</span>
                        <span className="text-gray-400 ml-1 hidden sm:inline">
                          {names[p.a] && names[p.b] ? `${names[p.a]} / ${names[p.b]}` : ""}
                        </span>
                      </td>
                      <td className="py-1 px-2 text-right text-gray-600">{cv(p.rho)}</td>
                      <td className="py-1 px-2 text-right" style={{ color: DOWN_COLOR }}>
                        {cv(p.down)}
                      </td>
                      <td className="py-1 px-2 text-right" style={{ color: UP_COLOR }}>
                        {cv(p.up)}
                      </td>
                      <td className="py-1 px-2 text-right font-medium">{sv(p.asym)}</td>
                      <td
                        className={`py-1 pl-2 text-right ${
                          Number.isFinite(p.p) && p.p < 0.05 ? "text-amber-700 font-medium" : "text-gray-400"
                        }`}
                      >
                        {pv(p.p)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[10px] text-gray-400 mt-1">
                ペア単位の p は<strong>多重比較の補正をしていません</strong>。
                {result.nPairs} ペアあれば偶然 5% を切るペアが {(result.nPairs * 0.05).toFixed(1)} 個は出ます。
                <strong>個別ペアの p を拾い読みしないでください</strong>——判定は上のバナー（全ペア平均）で行い、
                この表は「どのペアが効いているか」を見るためだけに使います。
              </p>
            </div>
          )}
        </>
      )}

      <AnalysisGuide title="exceedance correlation（テール非対称性）の詳細理論">
        <p className="font-medium text-gray-700">1. 何を測っているか</p>
        <p>
          分散投資の前提は「みんながバラバラに動く」ことです。ところが実務でよく言われるのは
          <strong>「暴落のときだけ全部が一緒に落ちる」</strong>——つまり、
          <strong>分散が最も必要な場面でだけ分散が効かなくなる</strong>という性質です。
          この分析は、それが<strong>あなたの銘柄の組み合わせで本当に起きているのか</strong>を
          統計的に判定します。
        </p>
        <p>
          測るのは <strong>exceedance correlation（超過相関）</strong>——
          「2銘柄が<strong>ともに</strong>大きく下げた日だけを集めたときの相関 ρ⁻」と、
          「<strong>ともに</strong>大きく上げた日だけの相関 ρ⁺」です。
          前者が後者より高ければ、下側にだけ強い連動がある、ということになります。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. なぜ素朴な比較では絶対にダメか（この分析の核心）</p>
        <p>
          各銘柄を標準化して {" zᵢ = (rᵢ − 平均) / 標準偏差 "} とし、閾値 θ（標準偏差の単位）で
        </p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">
          ρ⁻(θ) = Corr(zᵢ, zⱼ | zᵢ ≤ −θ かつ zⱼ ≤ −θ) ／ ρ⁺(θ) = Corr(zᵢ, zⱼ | zᵢ ≥ +θ かつ zⱼ ≥ +θ)
        </p>
        <p>
          ここで<strong>絶対に踏んではいけない罠</strong>があります。標本を「大きく動いた日」で
          切って相関を測ると、<strong>真の分布が完全に対称な正規分布であっても</strong>、
          その値は無条件相関と一致しません（<strong>条件付けバイアス</strong>：
          Boyer-Gibson-Loretan 1999 / Forbes-Rigobon 2002）。
          両変数を同じ向きに切り詰めると、部分標本内では変数の散らばりが縮み、
          相関の推定値は<strong>むしろ下がる</strong>ことが多いのです。
          実際、下の表でヌル（＝完全対称な正規）の列を見てください。無条件 ρ̄ が 0.48 でも、
          {" θ=1.5 "} では 0.12 前後まで<strong>勝手に下がります</strong>。
        </p>
        <p>
          したがって「全期間 0.48、下側 0.28 だから下落時は相関が低い」も、
          「上側 0.09 より下側 0.28 が高いから非対称だ」も、
          <strong>それ単体では何も言っていません</strong>。基準がないからです。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 解法：同じ切り方をヌルにも適用する</p>
        <p>
          正しい比較対象は「無条件相関だけが同じで、<strong>テール依存性がゼロ・完全対称</strong>な世界」です。
          具体的には、実測の相関行列 R を Cholesky 分解して {" x = L·e "}（e は独立な標準正規）で
          <strong>同じ長さ T の多変量正規標本</strong>を作り、
          <strong>実測とまったく同じ手続き</strong>（標準化 → 閾値で条件付け → 相関）を通します。
          これを {" S "} 本繰り返せば、
          <strong>「正規だったら ρ⁻(θ) はどこにどれだけ散らばるか」</strong>という分布が得られます。
        </p>
        <p>
          条件付けバイアスも小標本バイアスも<strong>ヌル側に同じだけ入る</strong>ので、
          実測とヌルの<strong>差を取れば相殺</strong>されます。これが Longin-Solnik (2001) /
          Ang-Chen (2002) の枠組みで、本パネルの実装もこれに従っています。
        </p>
        <p>
          検定統計量は3つ。
        </p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">
          A(θ) = ρ⁻(θ) − ρ⁺(θ)  ／  Ā = mean_θ A(θ)  ／  H = √( mean( (ρ_実測 − ρ_ヌル平均)² ) )
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>A(θ)</strong>: 各閾値での非対称性。ヌルは完全対称なので {" E[A]=0 "}。
            両側 p は「ヌルで |A| がこれ以上になる割合」。
          </li>
          <li>
            <strong>Ā</strong>: 全閾値を通した平均。バナーの主判定はこれ（水準ごとに拾い読みしないため）。
          </li>
          <li>
            <strong>H</strong>: Ang-Chen 型の総合距離。上下どちらの向きでも「正規からの乖離」を1つの数にする。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>火事のときだけ全員が同じ出口へ走る</strong>: 普段はビルの中でバラバラに動いている人が、
            非常時には1つのドアに殺到する。平時の人流（無条件相関）を見ても、その混雑は予測できない。
          </li>
          <li>
            <strong>身長でクラスを切る</strong>: 「170cm以上の人だけ」を集めて身長と体重の相関を測ると、
            クラス全体で測るより<strong>必ず</strong>相関が下がります。集団の性質が変わったのではなく、
            <strong>切ったから</strong>下がった。灰色のヌル帯はこの「切ったぶん」を表しています。
          </li>
          <li>
            <strong>パラシュートの検査</strong>: 平時に開くかどうかは重要ではなく、落ちているときに開くかどうかが全て。
            ρ⁻ はまさに「落ちているときの相関」です。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            グラフの<strong>灰色の帯（ヌルの90%）から実測がはみ出した部分だけ</strong>が情報です。
            帯の中に収まっているなら「2変量正規で説明できる」＝<strong>非対称性の証拠なし</strong>。
          </li>
          <li>
            実測もヌルも θ とともに下がるのが普通です。<strong>下がり方の差</strong>を見てください。
            絶対値そのものには意味がありません。
          </li>
          <li>
            <strong>A の p &lt; 0.05 かつ A &gt; 0</strong> なら、下側だけ相関が上がる本物の非対称性。
            分散の効きが暴落時に落ちるので、<strong>建玉上限は ρ⁻ を使って引き直す</strong>べきです。
          </li>
          <li>
            θ を上げると日数が急減し（表の「日数」列）、CI は必ず広がります。
            <strong>θ=1.5 で有意でなくても「非対称でない」証拠にはなりません</strong>——単に標本が足りないだけかもしれない。
          </li>
          <li>
            ペア表は「どのペアが効いているか」の内訳です。多重比較の補正をしていないので、
            <strong>個別 p を拾い読みしない</strong>こと。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>建玉上限を ρ⁻ で引き直す</strong>。「相関だけを動かす」パネル（三本の崖）の ρ スライダーに
            ここで測った <strong>ρ⁻(θ=1)</strong> を入れると、暴落時に自分の崖がどこまで手前に来るかが読めます。
            平時の ρ で建玉を決めていると、そこが崖の向こう側になっていることがあります。
          </li>
          <li>
            <strong>銘柄の入れ替え基準にする</strong>。ペア表で A が大きいペアは
            「上げでは一緒に動かないのに下げでだけ一緒に落ちる」＝<strong>分散のうまみだけが無い</strong>組み合わせ。
            片方を外す候補になります。逆に A が負のペアは、暴落時にこそ効く貴重な組み合わせです。
          </li>
          <li>
            <strong>ヘッジの必要性の判断</strong>。非対称が有意なら、銘柄分散だけでは下側を守れないという結論なので、
            現金比率・指数プット・逆相関資産といった<strong>別の道具</strong>が要ります。
            有意でないなら、その保険料は払わなくてよい可能性が高い。
          </li>
          <li>
            危機時 ρ（pf-corr-drag の上下対称な定義）と<strong>合わせて</strong>読んでください。
            あちらは「荒れた時期に実際に実現する相関」、こちらは「下と上のどちらで上がるか」。
            両方が揃って初めて「暴落時に何が起きるか」の像になります。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>ヌルは「正規かどうか」も同時に検定してしまう</strong>。ヌルからの乖離は
            テール依存性だけでなく、<strong>裾の厚さ（尖度）やボラのクラスタリング</strong>でも生じます。
            厳密に「コピュラの非対称性だけ」を取り出したいなら、ヌル側も同じ GARCH で標準化した残差から
            作る必要があります（本実装はそこまでやっていません）。
            したがって<strong>有意＝非対称性の確定ではなく、「正規では説明できない何かがある」</strong>と読むのが正確です。
          </li>
          <li>
            <strong>条件は「両方が同時に超えた日」</strong>です。片方だけで条件付ける定義（Ang-Chen の一部の版）とは
            数値が変わります。両方条件は「本当に一緒に落ちた日」を見るぶん直感に近い一方、
            <strong>標本が急速に減る</strong>のが欠点です。
          </li>
          <li>
            <strong>全ペア平均で判定しています</strong>。銘柄数が多いと、少数の強い非対称ペアが平均に埋もれます。
            ペア表で内訳を必ず確認してください。
          </li>
          <li>
            θ=1.5 の水準は条件付き日数が十数日まで落ちることがあります。
            {" "}<strong>{result.minObs}日未満のペアは除外</strong>していますが、それでも
            この水準の数字は「参考」として扱ってください。
          </li>
          <li>
            <strong>過去の非対称性が将来も続く保証はありません</strong>。相関構造は政策・投資家層・
            指数採用などで変わります。窓（期間ボタン）を変えて結論が安定するかを必ず確認してください。
          </li>
          <li>
            モンテカルロ本数は銘柄数から自動調整（120〜400本）しています。p 値の解像度は
            <strong>1/(本数+1)</strong> が下限なので、「p = 0.008」のような値は「これ以上小さいかもしれない」と読みます。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// スマイル図（Canvas2D）
// 横軸 = 符号付き閾値（左が下側 −θ、右が上側 +θ）、縦軸 = 相関。
// 実測の折れ線と、ヌルの90%帯を重ねる。「帯からはみ出た部分だけが情報」を一枚で見せる。
// ────────────────────────────────────────────────────────────────────────────
function drawSmile(canvas: HTMLCanvasElement, r: ExceedanceResult) {
  const fit = initCanvas(canvas, HEIGHT);
  if (!fit) return;
  const { ctx, width, height } = fit;

  const padL = 46;
  const padR = 14;
  const padT = 16;
  const padB = 40;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  if (plotW < 80 || plotH < 80) return;

  const thetaMax = Math.max(...r.levels.map((l) => l.theta), 1);
  const values: number[] = [r.rhoAll];
  for (const l of r.levels) {
    for (const v of [
      l.down.corr, l.down.nullLo, l.down.nullHi,
      l.up.corr, l.up.nullLo, l.up.nullHi,
    ])
      if (Number.isFinite(v)) values.push(v);
  }
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const span = hi - lo || 0.2;
  lo -= span * 0.12;
  hi += span * 0.12;
  const range = hi - lo || 1;

  const xOf = (signed: number) => padL + ((signed + thetaMax) / (2 * thetaMax)) * plotW;
  const yOf = (v: number) => padT + ((hi - v) / range) * plotH;

  // 背景：下側（左半分）を薄赤、上側を薄青
  ctx.fillStyle = "#fef6f6";
  ctx.fillRect(padL, padT, plotW / 2, plotH);
  ctx.fillStyle = "#f5f8ff";
  ctx.fillRect(padL + plotW / 2, padT, plotW / 2, plotH);

  // グリッド
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const step = range > 1 ? 0.25 : range > 0.5 ? 0.1 : 0.05;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const y = yOf(v);
    ctx.strokeStyle = "#eceff1";
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillStyle = "#9ca3af";
    ctx.fillText(v.toFixed(2), padL - 6, y);
  }

  // 縦グリッド（θ 目盛り）
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const l of r.levels) {
    for (const s of l.theta === 0 ? [0] : [-l.theta, l.theta]) {
      const x = xOf(s);
      ctx.strokeStyle = s === 0 ? "#cbd5e1" : "#eceff1";
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = "#9ca3af";
      ctx.fillText(s === 0 ? "0" : `${s > 0 ? "+" : "−"}${Math.abs(s).toFixed(1)}σ`, x, padT + plotH + 6);
    }
  }

  // 無条件相関の基準線
  ctx.strokeStyle = "#64748b";
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, yOf(r.rhoAll));
  ctx.lineTo(padL + plotW, yOf(r.rhoAll));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.textAlign = "left";
  ctx.fillStyle = "#64748b";
  ctx.fillText(`無条件 ρ̄=${r.rhoAll.toFixed(2)}`, padL + 4, yOf(r.rhoAll) - 12);

  // 片側ぶんの点列を作る（down は x を負に、up は正に）
  const pts = (side: "down" | "up") =>
    r.levels
      .map((l) => ({
        x: side === "down" ? -l.theta : l.theta,
        v: side === "down" ? l.down.corr : l.up.corr,
        lo: side === "down" ? l.down.nullLo : l.up.nullLo,
        hi: side === "down" ? l.down.nullHi : l.up.nullHi,
      }))
      .filter((p) => Number.isFinite(p.v))
      .sort((a, b) => a.x - b.x);

  const band = (ps: { x: number; lo: number; hi: number }[]) => {
    const usable = ps.filter((p) => Number.isFinite(p.lo) && Number.isFinite(p.hi));
    if (usable.length < 2) return;
    ctx.fillStyle = "rgba(148,163,184,0.35)";
    ctx.beginPath();
    usable.forEach((p, i) => {
      const x = xOf(p.x);
      const y = yOf(p.hi);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    for (let i = usable.length - 1; i >= 0; i--) ctx.lineTo(xOf(usable[i].x), yOf(usable[i].lo));
    ctx.closePath();
    ctx.fill();
  };

  const line = (ps: { x: number; v: number }[], color: string) => {
    if (ps.length === 0) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ps.forEach((p, i) => {
      const x = xOf(p.x);
      const y = yOf(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = color;
    for (const p of ps) {
      ctx.beginPath();
      ctx.arc(xOf(p.x), yOf(p.v), 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const dn = pts("down");
  const up = pts("up");
  band(dn);
  band(up);
  line(dn, DOWN_COLOR);
  line(up, UP_COLOR);

  // 軸ラベル
  ctx.fillStyle = "#6b7280";
  ctx.textAlign = "center";
  ctx.fillText("← ともに下げた日（閾値 θ）　　ともに上げた日 →", padL + plotW / 2, height - 16);
  ctx.save();
  ctx.translate(11, padT + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("条件付き相関", 0, 0);
  ctx.restore();
}
