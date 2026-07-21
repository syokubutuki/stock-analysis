"use client";

// クロスセクション・ロングショート ── 小エッジの棲息域。
// ウォッチリスト全銘柄を毎リバランス日に横断ランクし、上位ロング/下位ショートの市場中立
// ブックを作る。IC・実効ブレッドス・基本法則IR vs 実現シャープ・コスト分岐点・point-in-time
// 在籍(生存者バイアス診断)を出す。理論の詳細は末尾の AnalysisGuide を参照。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart, LineSeries, type IChartApi, type ISeriesApi, type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeCrossSectional, DEFAULT_X_PARAMS, XSIGNAL_LABEL, XSIGNAL_DESC,
  type XSignalId, type XResult,
} from "../../lib/cross-sectional-edge";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  tickers: string[];
  pricesByTicker: Record<string, PricePoint[]>;
  names?: Record<string, string>;
}

const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
const num2 = (v: number) => v.toFixed(2);
const cls = (v: number) => (v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500");

function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: "good" | "bad" | "neutral"; sub?: string }) {
  const c = tone === "good" ? "text-green-700" : tone === "bad" ? "text-red-700" : "text-gray-800";
  return (
    <div className="rounded border border-gray-200 px-2.5 py-1.5">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`text-sm font-bold font-mono ${c}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-400">{sub}</div>}
    </div>
  );
}

export default function CrossSectionalEdgeChart({ tickers, pricesByTicker, names }: Props) {
  const [signal, setSignal] = useState<XSignalId>(DEFAULT_X_PARAMS.signal);
  const [rebalanceDays, setRebalanceDays] = useState(DEFAULT_X_PARAMS.rebalanceDays);
  const [quantile, setQuantile] = useState(DEFAULT_X_PARAMS.quantile);
  const [costBps, setCostBps] = useState(DEFAULT_X_PARAMS.costBps);

  const result = useMemo<XResult>(
    () => computeCrossSectional(pricesByTicker, names ?? {}, {
      ...DEFAULT_X_PARAMS, signal, rebalanceDays, quantile, costBps,
    }),
    [pricesByTicker, names, signal, rebalanceDays, quantile, costBps],
  );
  const ready = result.ok;

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line">[]>([]);

  useEffect(() => {
    if (!ready || !containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f5f5f5" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth, height: 260, crosshair: { mode: 0 },
      localization: { priceFormatter: (v: number) => `${(v * 100).toFixed(0)}%` },
      timeScale: { timeVisible: false, secondsVisible: false },
    });
    chartRef.current = chart;
    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }); };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); chartRef.current = null; seriesRef.current = []; };
  }, [ready]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !result.ok) return;
    for (const s of seriesRef.current) chart.removeSeries(s);
    seriesRef.current = [];
    const gross = chart.addSeries(LineSeries, { color: "#9ca3af", lineWidth: 1, title: "グロス", priceLineVisible: false });
    gross.setData(result.equity.map((e) => ({ time: e.time as Time, value: e.gross })));
    const net = chart.addSeries(LineSeries, { color: "#2563eb", lineWidth: 2, title: "ネット", priceLineVisible: false });
    net.setData(result.equity.map((e) => ({ time: e.time as Time, value: e.net })));
    seriesRef.current = [gross, net];
    if (containerRef.current && containerRef.current.clientWidth > 0) chart.applyOptions({ width: containerRef.current.clientWidth });
    chart.timeScale().fitContent();
  }, [result]);

  if (!result.ok) {
    return <div className="text-xs text-gray-500 p-3">{result.reason ?? "データ待ち"}</div>;
  }

  const irGap = result.sharpeRealizedGross - result.irTheoretical;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        ウォッチリスト全{tickers.length}銘柄を毎リバランス日に横断ランクし、
        <span className="font-medium">上位{(quantile * 100).toFixed(0)}%ロング / 下位{(quantile * 100).toFixed(0)}%ショート</span>の
        ダラー中立ブックを作ります。単名では breadth≈1 で頭打ちの小エッジを、多数同時ベットで初めて使える形にする
        ── 基本法則 <span className="font-medium">IR ≈ IC·√BR</span> の実践です。
      </p>

      {/* コントロール */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          シグナル
          <select className="border rounded px-1 py-0.5" value={signal} onChange={(e) => setSignal(e.target.value as XSignalId)}>
            {(Object.keys(XSIGNAL_LABEL) as XSignalId[]).map((s) => <option key={s} value={s}>{XSIGNAL_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          リバランス
          {[1, 5, 21].map((d) => (
            <button key={d} onClick={() => setRebalanceDays(d)} className={`px-1.5 py-0.5 rounded border ${rebalanceDays === d ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}>
              {d === 1 ? "毎日" : d === 5 ? "週次" : "月次"}
            </button>
          ))}
        </label>
        <label className="flex items-center gap-1">
          上下{(quantile * 100).toFixed(0)}%
          <input type="range" min={0.1} max={0.5} step={0.05} value={quantile} onChange={(e) => setQuantile(Number(e.target.value))} />
        </label>
        <label className="flex items-center gap-1">
          片道コスト
          {[0, 2, 5, 10].map((c) => (
            <button key={c} onClick={() => setCostBps(c)} className={`px-1.5 py-0.5 rounded border ${costBps === c ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}>{c}bp</button>
          ))}
        </label>
      </div>
      <p className="text-[11px] text-gray-500">{XSIGNAL_DESC[signal]}</p>

      {/* 生存者バイアス診断(point-in-time) */}
      <div className={`rounded border p-2 text-[11px] ${result.survivorWarn ? "bg-amber-50 border-amber-300 text-amber-800" : "bg-gray-50 border-gray-200 text-gray-600"}`}>
        <b>在籍(point-in-time):</b> {result.spans.length}銘柄中 {result.nExtendToEnd}銘柄が終端まで生存。
        {result.survivorWarn
          ? " 全銘柄が現存 = 生存者バイアスの可能性。廃止・上場来消滅した銘柄を含めると横断エッジは弱まる方向に補正されます(各銘柄のデータ期間を在籍窓として尊重し、退場後は自動除外しています)。"
          : " データが途中で終わる銘柄は退場日以降ブックから自動除外(廃止銘柄を正しく扱えています)。"}
      </div>

      {/* 主要指標 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="IC(平均・順位相関)" value={num2(result.icMean)} tone={result.icMean > 0 ? "good" : "bad"} sub={`t=${num2(result.icT)} / 的中${(result.hitRate * 100).toFixed(0)}%`} />
        <Stat label="実効ブレッドス" value={`${result.avgBreadth.toFixed(0)}銘柄`} sub={`年${result.breadthPerYear.toFixed(0)}ベット`} />
        <Stat label="理論IR (IC·√BR)" value={num2(result.irTheoretical)} sub="年率の上限目安" />
        <Stat label="実現シャープ(ネット)" value={num2(result.sharpeRealizedNet)} tone={result.sharpeRealizedNet > 0.5 ? "good" : "neutral"} sub={`グロス ${num2(result.sharpeRealizedGross)}`} />
        <Stat label="年率リターン(ネット)" value={pct(result.annNet)} tone={result.annNet > 0 ? "good" : "bad"} sub={`グロス ${pct(result.annGross)}`} />
        <Stat label="最大DD" value={pct(result.maxDD)} tone="bad" />
        <Stat label="回転(片道/年)" value={`${result.turnoverPerYear.toFixed(1)}回`} sub={`コスト分岐 ${isFinite(result.costBreakevenBps) ? result.costBreakevenBps.toFixed(1) + "bp" : "—"}`} />
        <Stat label="市場β(中立性)" value={num2(result.marketBeta)} tone={Math.abs(result.marketBeta) < 0.2 ? "good" : "bad"} sub="0に近いほど中立" />
      </div>

      {/* IR ギャップの解釈 */}
      <div className={`rounded-lg border p-3 text-sm ${result.icT >= 2 ? "bg-green-50 border-green-300" : "bg-gray-50 border-gray-300"}`}>
        <span className="font-medium">読み方: </span>
        IC={num2(result.icMean)}(t={num2(result.icT)})。
        {result.icT >= 2
          ? "横断シグナルは有意です。"
          : "横断シグナルは有意水準に届いていません。"}
        {" "}基本法則の理論IR {num2(result.irTheoretical)} に対し実現シャープ(グロス) {num2(result.sharpeRealizedGross)}
        {Math.abs(irGap) < 0.3 ? "(ほぼ整合)" : irGap < 0 ? "(実現が下振れ=分散不足/相関/執行の摩擦)" : "(実現が上振れ=たまたま or 非独立ベット)"}。
        コスト分岐点は{isFinite(result.costBreakevenBps) ? `${result.costBreakevenBps.toFixed(1)}bp` : "—"}
        {isFinite(result.costBreakevenBps) && result.costBreakevenBps < 10 ? "（薄い。回転の速いリバーサル系は現実の手数料で消えがち）" : ""}。
      </div>

      {/* エクイティ */}
      <div>
        <div className="text-xs text-gray-500 mb-1">
          市場中立ブックの累積リターン（灰=グロス / 青=ネット, ホイールでズーム）— {result.from}〜{result.to} / {result.years.toFixed(1)}年 / {result.nPeriods}リバランス
        </div>
        <div ref={containerRef} className="w-full" />
      </div>

      {/* 在籍テーブル */}
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-500">銘柄別 在籍期間(point-in-time)</summary>
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 px-1.5">銘柄</th>
                <th className="text-left px-1.5">在籍開始</th>
                <th className="text-left px-1.5">在籍終了</th>
                <th className="text-right px-1.5">本数</th>
                <th className="text-center px-1.5">終端生存</th>
              </tr>
            </thead>
            <tbody>
              {result.spans.map((sp) => (
                <tr key={sp.ticker} className="border-b border-gray-100">
                  <td className="py-1 px-1.5">{sp.name}<span className="text-gray-400 ml-1">{sp.ticker}</span></td>
                  <td className="px-1.5 font-mono text-gray-600">{sp.from}</td>
                  <td className="px-1.5 font-mono text-gray-600">{sp.to}</td>
                  <td className="text-right px-1.5 font-mono">{sp.nBars}</td>
                  <td className="text-center px-1.5">{sp.extendsToEnd ? "✓" : <span className="text-amber-600">退場</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <AnalysisGuide title="クロスセクション・ロングショートの詳細理論">
        <p className="font-medium text-gray-700">1. なぜ横断なのか(小エッジの棲息域)</p>
        <p>
          単一銘柄・時間軸のエッジは、同時ベット数(breadth)が実質1しかありません。運用の基本法則
          <span className="font-medium"> IR = IC·√BR</span>(情報比 = 情報係数 × 独立ベット数の平方根)より、
          breadth=1ではどんなに時間をかけても情報比は上がらず、本当に小さいエッジは検出も運用もできません
          (「検出力の壁」参照)。そこで毎日ユニバース全体を横断ランクし、多数の銘柄に同時に小さく賭ける。
          1本1本の的中率(IC)は0.02〜0.05でも、数十〜数百の独立ベットを束ねれば意味のある情報比になります。
          これがルネサンス/スタットアーブ流の「容量制限付きの小さなエッジ」の実像です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"各リバランス日 t に各銘柄のシグナル s_i(t) を因果的に計算(t日終値までの情報のみ)。"}</li>
          <li>{"横断ランクで上位qをロング・下位qをショート。等加重・ダラー中立: Σw_long = +L/2, Σw_short = −L/2(Lは総エクスポージャ)。"}</li>
          <li>{"ブック期リターン = Σ_i w_i·r_i(t→t+h)。"}</li>
          <li>{"IC = Spearman( s_i(t), r_i(t→t+h) ) を銘柄横断で計算。IC の t 値 = mean(IC)/std(IC)·√(期数)。"}</li>
          <li>{"理論IR = mean(IC)·√(年あたり独立ベット数 BR)、BR ≈ 平均採用銘柄数 × 年間リバランス回数。"}</li>
          <li>{"コスト分岐点 c* : mean(期リターン) − c*·2·mean(片道回転) = 0 を解いた片道コスト。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 実装したシグナル</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">短期リバーサル:</span> 前日/5日の相対負け組を買い勝ち組を売る。最も頑健だが回転が速く容量が小さい古典的小エッジ。</li>
          <li><span className="font-medium">クロスセクション・モメンタム:</span> 12-1月の相対勝ち組を買う。中期の持続。</li>
          <li><span className="font-medium">低ボラ:</span> 直近実現ボラの低い銘柄を買う。低ボラ・アノマリー。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. point-in-time と生存者バイアス(#5)</p>
        <p>
          各銘柄の在籍期間(既定=データが存在する期間)を窓として尊重し、上場前・退場後はブックに含めません。
          <span className="font-medium">廃止された銘柄をユニバースに含めれば、その退場日以降は自動的に外れ、生存者バイアスを避けられます</span>。
          全銘柄が現在まで生きている場合は警告を出します──「勝ち残った銘柄だけ」で測った横断エッジは実際より強く見えるためです。
          正しい検証には、当時のユニバース構成(時点構成メンバー)と廃止銘柄が要ります。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方・活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">IC の t 値 ≥ 2</span> で横断シグナルは有意。単名のエッジ検定より遥かに検出力が高い(breadthのおかげ)。</li>
          <li><span className="font-medium">理論IR vs 実現シャープ</span>: 大きく乖離するなら、ベットが独立でない(全銘柄が同じ因子で動く)か、執行摩擦で削れている。</li>
          <li><span className="font-medium">市場β ≈ 0</span> を確認。中立でなければ、成績は横断エッジでなく市場の方向で説明できてしまう。</li>
          <li><span className="font-medium">コスト分岐点</span>が現実の手数料+スプレッドより低いなら、そのシグナルは紙上のエッジ。回転を落とす(週次/月次)か低回転シグナルへ。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ウォッチリストは少数(数〜数十銘柄)で、真のクロスセクション(数百〜千)より breadth が小さく検出力も限定的です。銘柄を増やすほど IC の t 値は上がります。</li>
          <li>ショートには貸株料・逆日歩・規制があり(rakuten-margin参照)、ここでは片道コストの往復近似のみ。実務のショートコストは別途重い。</li>
          <li>容量: リバーサル系は回転が速く、平方根インパクトで容量が小さい。個別の容量は単名の「エッジ容量推定」を各脚に当てて概算してください。</li>
          <li>生存者バイアスの完全な排除には時点構成メンバーと廃止銘柄データが必要で、現状はユーザーが供給した銘柄群のデータ期間で近似しています。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
