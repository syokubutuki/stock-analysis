"use client";

// 合成ブック: 弱いエッジN本を束ねたときの Sharpe・テール相関・総容量の食い合い。
// 同一銘柄で複数エッジを回すと同じオークション流動性を食い合い、総容量は個別の和にならない。
// 理論の詳細は末尾の AnalysisGuide を参照。

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { buildEdgeCatalog } from "../../lib/edge-trades";
import { mean } from "../../lib/stats-significance";
import {
  computeEdgeBook, DEFAULT_BOOK_PARAMS, type EdgeBookResult,
} from "../../lib/edge-book";
import { fmtYen } from "../../lib/edge-capacity";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const num2 = (v: number) => v.toFixed(2);
const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

function corrColor(c: number): string {
  // 青(負)〜白(0)〜赤(正)
  const a = Math.min(1, Math.abs(c));
  if (c >= 0) return `rgba(220,38,38,${0.12 + a * 0.6})`;
  return `rgba(37,99,235,${0.12 + a * 0.6})`;
}

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

function drawHeatmap(canvas: HTMLCanvasElement, result: EdgeBookResult) {
  const M = result.legs.length;
  const cell = Math.min(48, Math.max(26, Math.floor(360 / Math.max(1, M))));
  const labelW = 92;
  const height = labelW + M * cell + 8;
  const init = initCanvas(canvas, height);
  if (!init) return;
  const { ctx } = init;
  ctx.font = "10px sans-serif";
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < M; j++) {
      const x = labelW + j * cell, y = labelW + i * cell;
      ctx.fillStyle = i === j ? "#e5e7eb" : corrColor(result.corr[i][j]);
      ctx.fillRect(x, y, cell - 1, cell - 1);
      ctx.fillStyle = "#374151"; ctx.textAlign = "center";
      ctx.fillText(i === j ? "1" : result.corr[i][j].toFixed(2), x + cell / 2, y + cell / 2 + 3);
    }
    // 行ラベル
    ctx.fillStyle = "#6b7280"; ctx.textAlign = "right";
    const short = result.legs[i].label.length > 10 ? result.legs[i].label.slice(0, 10) + "…" : result.legs[i].label;
    ctx.fillText(short, labelW - 4, labelW + i * cell + cell / 2 + 3);
    // 列ラベル(回転)
    ctx.save();
    ctx.translate(labelW + i * cell + cell / 2, labelW - 4);
    ctx.rotate(-Math.PI / 4);
    ctx.textAlign = "left"; ctx.fillStyle = "#6b7280";
    ctx.fillText(short, 0, 0);
    ctx.restore();
  }
}

export default function EdgeBookChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const catalog = useMemo(() => buildEdgeCatalog(prices), [prices]);

  const [selected, setSelected] = useState<string[]>([]);
  const [costBps, setCostBps] = useState(0);
  const [contention, setContention] = useState(-1); // -1=自動

  // 初期選択: 1取引あたりのエッジ(|平均|)が大きい上位3本。スプレッドを越えて容量が
  // 出やすく、食い合いの目減りが具体的な金額で見える(日中/夜間の微小エッジだけだと0円になる)。
  useEffect(() => {
    if (catalog.length > 0 && selected.length === 0) {
      const ranked = [...catalog]
        .map((e) => ({ id: e.id, m: Math.abs(mean(e.trades.map((t) => t.ret))) }))
        .sort((a, b) => b.m - a.m)
        .slice(0, Math.min(3, catalog.length))
        .map((x) => x.id);
      setSelected(ranked);
    }
  }, [catalog, selected.length]);

  const result = useMemo<EdgeBookResult>(
    () => computeEdgeBook(prices, catalog, selected, { ...DEFAULT_BOOK_PARAMS, costBps, contention }),
    [prices, catalog, selected, costBps, contention],
  );

  useEffect(() => {
    if (!canvasRef.current || !result.ok) return;
    drawHeatmap(canvasRef.current, result);
    const onResize = () => { if (canvasRef.current && result.ok) drawHeatmap(canvasRef.current, result); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [result]);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  if (prices.length < 300) {
    return <div className="text-xs text-gray-400 p-3">データが不足しています(300営業日以上必要)。</div>;
  }
  if (catalog.length < 2) {
    return <div className="text-xs text-gray-400 p-3">合成できるエッジが足りません。</div>;
  }

  const divGain = result.bookSharpe - Math.max(...result.legs.map((l) => l.sharpe), 0);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">合成ブック — 弱いエッジN本を束ねる（分散・テール・食い合い）</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          複数エッジを合成するとSharpeは上がるが、危機時は相関が跳ねて分散効果が消える(テール相関)。
          さらに同一銘柄では同じオークション流動性を食い合うため、<span className="font-medium">総容量は個別の和にならない</span>。
        </p>
      </div>

      {/* エッジ選択 */}
      <div className="flex flex-wrap gap-1.5">
        {catalog.map((e) => (
          <button
            key={e.id}
            onClick={() => toggle(e.id)}
            className={`px-2 py-0.5 rounded border text-[11px] ${selected.includes(e.id) ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}
          >
            {e.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-1">
          片道コスト
          {[0, 2, 5, 10].map((c) => (
            <button key={c} onClick={() => setCostBps(c)} className={`px-1.5 py-0.5 rounded border ${costBps === c ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}>{c}bp</button>
          ))}
        </label>
        <label className="flex items-center gap-1">
          競合度φ
          <button onClick={() => setContention(-1)} className={`px-1.5 py-0.5 rounded border ${contention < 0 ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}>自動</button>
          <input type="range" min={0} max={1} step={0.05} value={contention < 0 ? result.contentionAuto : contention} onChange={(e) => setContention(Number(e.target.value))} />
          <span className="font-mono w-8">{result.contentionUsed.toFixed(2)}</span>
        </label>
      </div>

      {!result.ok ? (
        <div className="text-xs text-gray-500 p-2">{result.reason}</div>
      ) : (
        <>
          {/* 分散・テール */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="rounded border border-gray-200 px-2.5 py-1.5">
              <div className="text-[10px] text-gray-500">合成Sharpe(逆ボラ加重)</div>
              <div className={`text-sm font-bold font-mono ${result.bookSharpe > 0 ? "text-green-700" : "text-red-700"}`}>{num2(result.bookSharpe)}</div>
              <div className="text-[10px] text-gray-400">単体最良 +{num2(divGain)} / 無相関上限 {num2(result.sumSharpeIfIndep)}</div>
            </div>
            <div className="rounded border border-gray-200 px-2.5 py-1.5">
              <div className="text-[10px] text-gray-500">分散比</div>
              <div className="text-sm font-bold font-mono text-gray-800">{num2(result.diversification)}×</div>
              <div className="text-[10px] text-gray-400">{result.diversification > 1.2 ? "分散効果あり" : "ほぼ効かず"}</div>
            </div>
            <div className="rounded border border-gray-200 px-2.5 py-1.5">
              <div className="text-[10px] text-gray-500">平均相関 → テール相関</div>
              <div className="text-sm font-bold font-mono text-gray-800">{num2(result.avgCorr)} → <span className={result.tailCorr > result.avgCorr + 0.1 ? "text-red-700" : "text-gray-800"}>{num2(result.tailCorr)}</span></div>
              <div className="text-[10px] text-gray-400">{result.tailCorr > result.avgCorr + 0.1 ? "危機時に相関上昇=分散消失" : "テールでも安定"}</div>
            </div>
            <div className="rounded border border-gray-200 px-2.5 py-1.5">
              <div className="text-[10px] text-gray-500">合成の年率 / 最大DD</div>
              <div className={`text-sm font-bold font-mono ${result.bookAnn > 0 ? "text-green-700" : "text-red-700"}`}>{pct(result.bookAnn)}</div>
              <div className="text-[10px] text-gray-400">DD {pct(result.bookMaxDD)} / 日次CVaR5% {pct(result.bookCVaR5)}</div>
            </div>
          </div>

          {/* 相関ヒートマップ */}
          <div>
            <div className="text-xs text-gray-500 mb-1">エッジ間 日次相関（青=負・赤=正）— 低いほど分散が効く</div>
            <canvas ref={canvasRef} className="w-full" />
          </div>

          {/* 容量の食い合い */}
          <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 space-y-2">
            <div className="text-sm font-semibold text-amber-900">総容量の食い合い（同じオークションを共有）</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <div className="rounded border border-gray-200 bg-white px-2.5 py-1.5">
                <div className="text-[10px] text-gray-500">個別容量の単純和(誤った期待)</div>
                <div className="text-sm font-bold font-mono text-gray-500 line-through">{fmtYen(result.kNaiveSum)}</div>
              </div>
              <div className="rounded border border-gray-200 bg-white px-2.5 py-1.5">
                <div className="text-[10px] text-gray-500">食い合い後の総容量</div>
                <div className="text-sm font-bold font-mono text-amber-800">{fmtYen(result.kBookContended)}</div>
                <div className="text-[10px] text-gray-400">競合係数 M/(1+φ(M−1)) = {result.contentionFactor.toFixed(2)}×（φ={result.contentionUsed.toFixed(2)}）</div>
              </div>
              <div className="rounded border border-gray-200 bg-white px-2.5 py-1.5">
                <div className="text-[10px] text-gray-500">目減り</div>
                <div className="text-sm font-bold font-mono text-red-700">
                  {result.kNaiveSum > 0 ? `−${((1 - result.kBookContended / result.kNaiveSum) * 100).toFixed(0)}%` : "—"}
                </div>
                <div className="text-[10px] text-gray-400">{result.contentionUsed > 0.5 ? "同時執行が多く食い合い大" : "執行が分散し食い合い小"}</div>
              </div>
            </div>
            {result.kNaiveSum <= 0 && (
              <p className="text-[11px] text-amber-900/90 font-medium">
                この銘柄では選んだエッジがスプレッドを越えず容量が0円です(容量推定パネルと整合)。
                食い合いの考え方は上の<span className="font-medium">競合係数 {result.contentionFactor.toFixed(2)}×</span>で確認を
                (φ=0で本数ぶん加算、φ=1で単一と同じ)。スプレッドの薄い銘柄なら金額でも目減りが見えます。
              </p>
            )}
            <p className="text-[11px] text-amber-900/70">
              φ(競合度)は選んだエッジの取引日の重なりから自動推定。日中と夜間のように「同じ日でも別セッション」なら
              実際の食い合いは推定より小さいので、スライダで下げて感度を見てください。
              なお各脚の容量は<span className="font-medium">選択バイアス補正前</span>のグロス値です(食い合いという別軸を見せるため)。
              補正後の誠実な容量は「エッジ容量推定」パネルを参照。
            </p>
          </div>

          {/* 脚テーブル */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-1.5">エッジ</th>
                  <th className="text-right px-1">方向</th>
                  <th className="text-right px-1">単体Sharpe</th>
                  <th className="text-right px-1">年率</th>
                  <th className="text-right px-1">配分(逆ボラ)</th>
                  <th className="text-right px-1.5">単体K_be</th>
                </tr>
              </thead>
              <tbody>
                {result.legs.map((l) => (
                  <tr key={l.id} className="border-b border-gray-100">
                    <td className="py-1 px-1.5">{l.label}</td>
                    <td className={`text-right px-1 ${l.direction === "long" ? "text-green-600" : "text-red-600"}`}>{l.direction === "long" ? "買" : "売"}</td>
                    <td className="text-right px-1 font-mono">{num2(l.sharpe)}</td>
                    <td className="text-right px-1 font-mono">{pct(l.annReturn)}</td>
                    <td className="text-right px-1 font-mono text-gray-500">{(l.weight * 100).toFixed(0)}%</td>
                    <td className="text-right px-1.5 font-mono">{l.kBreakEven > 0 ? fmtYen(l.kBreakEven) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <AnalysisGuide title="合成ブックの詳細理論">
        <p className="font-medium text-gray-700">1. なぜ合成するのか、なぜ単純和にならないのか</p>
        <p>
          弱いエッジは1本では使えなくても、相関の低い複数を束ねるとリスクが打ち消し合い、合成ブックの
          シャープは個々より上がります(分散効果)。しかし2つの落とし穴があります。第一に、危機時にはあらゆる
          エッジの相関が1へ跳ね上がり、分散効果が最も欲しい局面で消えます(テール相関)。第二に、同一銘柄で
          複数エッジを回すと、それらは<span className="font-medium">同じ寄り/引けオークションの流動性を食い合う</span>ため、
          総容量は個別容量の単純な足し算にはなりません。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>各エッジを共通カレンダー上の日次P&Lストリーム(非稼働日=0)に直し、ピアソン相関・逆ボラ加重の合成ストリームを作る。</li>
          <li>{"分散比 = Σ w_i·σ_i / σ_book。1より大きいほど分散が効いている。"}</li>
          <li>{"テール相関 = 合成ブックの下位decile(悪い日)だけに限定した平均ペア相関。平均相関より大きければ危機時に分散が消える。"}</li>
          <li>{"容量の食い合い: 等配分で各エッジが見る実効フロー = K(1+φ(M−1))/M(φ=競合度∈[0,1])。ブック損益分岐 K_be,book = (ā/b)²·M/(1+φ(M−1))。"}</li>
          <li>{"競合係数 M/(1+φ(M−1)) は φ=0(完全にずらして執行)で M(容量が加算)、φ=1(完全同時)で 1(本数を増やしても総容量は増えない)。"}</li>
          <li>{"ā = 頻度加重した収縮後エッジ、b = 2Y·σ/√V_auc(エッジ容量推定と共通)。φは取引日の重なり(Jaccard)から自動推定。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 直感的な例え</p>
        <p>
          エッジは複数の井戸、オークション流動性は共通の地下水脈です。井戸を増やせば普段は多く汲めますが、
          同じ時刻に一斉に汲む(φ=1)と水位が下がって1本ぶんしか取れません。時間をずらして汲めば(φ=0)本数ぶん増えます。
          テール相関は「日照りの日は全部の井戸が同時に枯れる」現象です。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">合成Sharpe &gt; 単体最良</span>かつ<span className="font-medium">分散比 &gt; 1.2</span>なら、束ねる価値がある。</li>
          <li><span className="font-medium">テール相関 ≫ 平均相関</span>なら、その分散効果は平常時だけの見せかけ。危機用のヘッジやレバ抑制が要る。</li>
          <li><span className="font-medium">食い合い後の総容量</span>が単純和より大きく目減りしているなら、同時執行を避ける(時間分散)か、別銘柄に横展開する。</li>
          <li>φを自動→手動で下げると、時間をずらして執行した場合にどこまで容量を回復できるかが分かる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>日次ストリーム化は「exit日にP&Lを置く」近似で、日中の執行タイミングの細部は捨象しています。</li>
          <li>φの自動推定は取引日の重なりベースで、日中と夜間のように「同日別セッション」を過大評価しがち。手動で下げて確認を。</li>
          <li>相関・Sharpeは実現値で、将来の相関は変わります。特にテール相関は標本が少なく不安定です。</li>
          <li>容量は単体の「エッジ容量推定」と同じ平方根インパクト則・オークション前提に依存します(桁の目安)。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
