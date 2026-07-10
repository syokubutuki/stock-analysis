"use client";

// 曜日トレード（月曜に建て・金曜に手仕舞い、週末をまたがない）が
// バイ&ホールドに対して「どれくらい統計的に優位か」を4つの検定で定量化して見せる。
// 詳しい理論は末尾の AnalysisGuide を参照。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { computeVsBH, type Timing, type VsBHResult } from "../../lib/weekday-vs-bh";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const TIMING_LABEL: Record<Timing, string> = { open: "始値", close: "終値" };
const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const pct3 = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(3)}%`;
const num2 = (v: number) => v.toFixed(2);
const cls = (v: number) => (v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500");

// p値 → 星付き表示
function pStars(p: number | null): { text: string; sig: boolean } {
  if (p === null || Number.isNaN(p)) return { text: "-", sig: false };
  const star = p < 0.01 ? "***" : p < 0.05 ? "**" : p < 0.1 ? "*" : "";
  return { text: `${p < 0.001 ? "<0.001" : p.toFixed(3)}${star}`, sig: p < 0.05 };
}

function PBadge({ p, label }: { p: number | null; label: string }) {
  const s = pStars(p);
  const c = s.sig ? "bg-green-100 text-green-700 border-green-300" : "bg-gray-100 text-gray-500 border-gray-300";
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium ${c}`}>
      {label} <span className="opacity-80">p={s.text}</span>
    </span>
  );
}

export default function WeekdayVsBuyHoldChart({ prices }: Props) {
  const [entryTiming, setEntryTiming] = useState<Timing>("open");
  const [exitTiming, setExitTiming] = useState<Timing>("close");

  const result = useMemo<VsBHResult | null>(
    () => computeVsBH(prices, { entryTiming, exitTiming }),
    [prices, entryTiming, exitTiming],
  );
  const hasResult = result !== null; // コンテナは result 有効時のみ描画されるので初期化effectの依存に入れる

  // === エクイティ曲線（横軸=日付なので lightweight-charts）===
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line">[]>([]);

  useEffect(() => {
    if (!hasResult || !containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f5f5f5" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 280,
      crosshair: { mode: 0 },
      rightPriceScale: { visible: true },
      localization: { priceFormatter: (v: number) => `${(v * 100).toFixed(0)}%` },
      timeScale: { timeVisible: false, secondsVisible: false },
    });
    chartRef.current = chart;
    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
    };
  }, [hasResult]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !result) return;
    for (const s of seriesRef.current) chart.removeSeries(s);
    seriesRef.current = [];
    const bhRows = result.equity.map((e) => ({ time: e.time as Time, value: e.bh }));
    const stRows = result.equity.map((e) => ({ time: e.time as Time, value: e.strat }));
    const bhs = chart.addSeries(LineSeries, {
      color: "#9ca3af", lineWidth: 1, title: "B&H", priceLineVisible: false, lastValueVisible: true,
    });
    bhs.setData(bhRows);
    const sts = chart.addSeries(LineSeries, {
      color: "#2563eb", lineWidth: 2, title: "月→金戦略", priceLineVisible: false, lastValueVisible: true,
    });
    sts.setData(stRows);
    seriesRef.current = [bhs, sts];
    if (containerRef.current && containerRef.current.clientWidth > 0) {
      chart.applyOptions({ width: containerRef.current.clientWidth });
    }
    chart.timeScale().fitContent();
  }, [result]);

  if (!result) {
    return (
      <div className="text-sm text-gray-500 p-4">
        データが不足しています（40営業日・5トレード以上が必要）。
      </div>
    );
  }

  const { metrics, weekend, robust, sharpe, annual, meta } = result;
  const excessTotal = metrics.strat.totalReturn - metrics.bh.totalReturn;
  const excessAnnual = metrics.strat.annualized - metrics.bh.annualized;

  // 総合判定: 主要4検定のうち有意(p<0.05・片側は優位方向)な数
  const verdicts = [
    weekend.pOneSided,
    robust.wilcoxonP,
    sharpe.jkmP,
    annual.probPositive !== undefined ? (annual.lo > 0 ? 0.01 : 1) : null,
  ];
  const sigCount = verdicts.filter((p) => p !== null && p < 0.05).length;

  return (
    <div className="space-y-4">
      {/* 説明 */}
      <p className="text-sm text-gray-600">
        「月曜に建て・金曜に手仕舞い、週末をまたがない（金→月は現金）」戦略が
        <span className="font-medium">バイ&ホールド（常時保有）</span>にどれくらい統計的に優位かを検定します。
        両者の差は<span className="font-medium">戦略が捨てる区間（主に週末ギャップ）</span>だけなので、
        その非重複部分を直接検定します。
      </p>

      {/* タイミング選択 */}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <div className="flex items-center gap-1">
          <span className="text-gray-500">月曜の建て:</span>
          {(["open", "close"] as Timing[]).map((t) => (
            <button
              key={t}
              onClick={() => setEntryTiming(t)}
              className={`px-2 py-0.5 rounded border ${entryTiming === t ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}
            >
              {TIMING_LABEL[t]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-500">金曜の手仕舞い:</span>
          {(["open", "close"] as Timing[]).map((t) => (
            <button
              key={t}
              onClick={() => setExitTiming(t)}
              className={`px-2 py-0.5 rounded border ${exitTiming === t ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}
            >
              {TIMING_LABEL[t]}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400">
          {meta.nWeeks}週 / {meta.years.toFixed(1)}年
        </span>
      </div>

      {/* 総合判定 */}
      <div className={`rounded-lg border p-3 text-sm ${sigCount >= 3 ? "bg-green-50 border-green-300" : sigCount >= 1 ? "bg-amber-50 border-amber-300" : "bg-gray-50 border-gray-300"}`}>
        <span className="font-medium">総合判定: </span>
        主要4検定のうち<span className="font-bold">{sigCount}/4</span>が有意（p&lt;0.05）。
        {sigCount >= 3
          ? " 戦略のB&Hに対する優位性は統計的に頑健です。"
          : sigCount >= 1
          ? " 一部の検定で優位ですが、頑健とは言い切れません。"
          : " 統計的に有意な優位性は検出されませんでした（差は偶然の範囲）。"}
      </div>

      {/* エクイティ曲線 */}
      <div>
        <div className="text-xs text-gray-500 mb-1">累積リターン（青=月→金戦略 / 灰=B&H, ホイールでズーム）</div>
        <div ref={containerRef} className="w-full" />
      </div>

      {/* 指標比較表 */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-gray-300 text-gray-500 text-xs">
              <th className="text-left py-1 px-2">指標</th>
              <th className="text-right py-1 px-2">月→金戦略</th>
              <th className="text-right py-1 px-2">バイ&ホールド</th>
              <th className="text-right py-1 px-2">差</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-100">
              <td className="py-1 px-2 text-gray-600">総リターン</td>
              <td className={`text-right px-2 ${cls(metrics.strat.totalReturn)}`}>{pct(metrics.strat.totalReturn)}</td>
              <td className={`text-right px-2 ${cls(metrics.bh.totalReturn)}`}>{pct(metrics.bh.totalReturn)}</td>
              <td className={`text-right px-2 font-medium ${cls(excessTotal)}`}>{pct(excessTotal)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1 px-2 text-gray-600">年率リターン</td>
              <td className={`text-right px-2 ${cls(metrics.strat.annualized)}`}>{pct(metrics.strat.annualized)}</td>
              <td className={`text-right px-2 ${cls(metrics.bh.annualized)}`}>{pct(metrics.bh.annualized)}</td>
              <td className={`text-right px-2 font-medium ${cls(excessAnnual)}`}>{pct(excessAnnual)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1 px-2 text-gray-600">年率Sharpe</td>
              <td className={`text-right px-2 ${cls(metrics.strat.sharpe)}`}>{num2(metrics.strat.sharpe)}</td>
              <td className={`text-right px-2 ${cls(metrics.bh.sharpe)}`}>{num2(metrics.bh.sharpe)}</td>
              <td className={`text-right px-2 font-medium ${cls(sharpe.delta)}`}>{num2(sharpe.delta)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1 px-2 text-gray-600">最大DD</td>
              <td className={`text-right px-2 ${cls(metrics.strat.maxDD)}`}>{pct(metrics.strat.maxDD)}</td>
              <td className={`text-right px-2 ${cls(metrics.bh.maxDD)}`}>{pct(metrics.bh.maxDD)}</td>
              <td className={`text-right px-2 font-medium ${cls(metrics.strat.maxDD - metrics.bh.maxDD)}`}>{pct(metrics.strat.maxDD - metrics.bh.maxDD)}</td>
            </tr>
            <tr>
              <td className="py-1 px-2 text-gray-600">市場滞在率</td>
              <td className="text-right px-2 text-gray-700">{(metrics.strat.exposure * 100).toFixed(0)}%</td>
              <td className="text-right px-2 text-gray-700">100%</td>
              <td className="text-right px-2 text-gray-500">{((metrics.strat.exposure - 1) * 100).toFixed(0)}%</td>
            </tr>
          </tbody>
        </table>
        <p className="text-xs text-gray-400 mt-1">
          戦略は市場滞在率が低い（週末は現金）ため、総リターンではなく<span className="font-medium">Sharpe（リスク調整後）</span>での比較が公平です。
        </p>
      </div>

      {/* 4検定カード */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* 1. 週末ギャップ検定 */}
        <div className="rounded-lg border border-gray-200 p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">① 週末ギャップ検定</span>
            <PBadge p={weekend.pOneSided} label="片側t" />
          </div>
          <p className="text-xs text-gray-500">週次の超過リターン e = 戦略 − B&H の平均が正か（片側t検定）。</p>
          <div className="text-sm space-y-0.5">
            <div className="flex justify-between"><span className="text-gray-500">週次超過（平均）</span><span className={cls(weekend.excessMeanWeekly)}>{pct3(weekend.excessMeanWeekly)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">捨てた区間の平均（対数）</span><span className={cls(weekend.meanSkip)}>{pct3(weekend.meanSkip)}</span></div>
            {weekend.weekendGapMean !== null && (
              <div className="flex justify-between"><span className="text-gray-500">うち週末ギャップ平均</span><span className={cls(weekend.weekendGapMean)}>{pct3(weekend.weekendGapMean)}</span></div>
            )}
            {weekend.bootLo !== null && weekend.bootHi !== null && (
              <div className="flex justify-between"><span className="text-gray-500">超過平均の95%CI(Boot)</span><span className="text-gray-700">[{pct3(weekend.bootLo)}, {pct3(weekend.bootHi)}]</span></div>
            )}
          </div>
        </div>

        {/* 2. Sharpe差検定 */}
        <div className="rounded-lg border border-gray-200 p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">② Sharpe差検定</span>
            <PBadge p={sharpe.jkmP} label="JKM" />
          </div>
          <p className="text-xs text-gray-500">リスク調整後の優位。Jobson–Korkie–Memmel検定＋Bootstrap。</p>
          <div className="text-sm space-y-0.5">
            <div className="flex justify-between"><span className="text-gray-500">Sharpe差（年率）</span><span className={cls(sharpe.delta)}>{num2(sharpe.delta)}</span></div>
            {sharpe.jkmZ !== null && (
              <div className="flex justify-between"><span className="text-gray-500">JKM統計量 z</span><span className="text-gray-700">{num2(sharpe.jkmZ)}</span></div>
            )}
            {sharpe.bootLo !== null && sharpe.bootHi !== null && (
              <div className="flex justify-between"><span className="text-gray-500">差の95%CI(Boot)</span><span className="text-gray-700">[{num2(sharpe.bootLo)}, {num2(sharpe.bootHi)}]</span></div>
            )}
            {sharpe.bootProbPositive !== null && (
              <div className="flex justify-between"><span className="text-gray-500">差&gt;0 の確率(Boot)</span><span className="text-gray-700">{(sharpe.bootProbPositive * 100).toFixed(0)}%</span></div>
            )}
          </div>
        </div>

        {/* 3. 頑健検定 */}
        <div className="rounded-lg border border-gray-200 p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">③ 週次ペア差の頑健検定</span>
            <PBadge p={robust.wilcoxonP} label="Wilcoxon" />
          </div>
          <p className="text-xs text-gray-500">非正規・外れ値に頑健。符号順位＋符号検定（片側 中央値&gt;0）。</p>
          <div className="text-sm space-y-0.5">
            <div className="flex justify-between"><span className="text-gray-500">超過が正の週の割合</span><span className={cls(robust.posFraction - 0.5)}>{(robust.posFraction * 100).toFixed(1)}%</span></div>
            {robust.wilcoxonZ !== null && (
              <div className="flex justify-between"><span className="text-gray-500">Wilcoxon z</span><span className="text-gray-700">{num2(robust.wilcoxonZ)}</span></div>
            )}
            <div className="flex justify-between items-center"><span className="text-gray-500">符号検定</span><PBadge p={robust.signP} label="sign" /></div>
          </div>
        </div>

        {/* 4. 年率差Bootstrap CI */}
        <div className="rounded-lg border border-gray-200 p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">④ 年率差 Bootstrap CI</span>
            <PBadge p={annual.lo > 0 ? 0.01 : 1} label={annual.lo > 0 ? "CI>0" : "CI∋0"} />
          </div>
          <p className="text-xs text-gray-500">年率リターン差の95%信頼区間。CIが0を跨がなければ有意。</p>
          <div className="text-sm space-y-0.5">
            <div className="flex justify-between"><span className="text-gray-500">年率差（点推定）</span><span className={cls(annual.delta)}>{pct(annual.delta)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">95%CI</span><span className="text-gray-700">[{pct(annual.lo)}, {pct(annual.hi)}]</span></div>
            <div className="flex justify-between"><span className="text-gray-500">差&gt;0 の確率(Boot)</span><span className="text-gray-700">{(annual.probPositive * 100).toFixed(0)}%</span></div>
          </div>
        </div>
      </div>

      <AnalysisGuide title="対バイ&ホールド優位性検定の詳細理論">
        <p className="font-medium text-gray-700">1. 何を検定しているか</p>
        <p>
          「月曜に建て・金曜に手仕舞い、週末をまたがない」戦略が、単純に持ち続ける
          バイ&ホールド（B&H）よりも統計的に優れているかを判定します。素朴に両者の総リターンを
          並べるだけでは「その差が偶然か実力か」が分からないため、確率的な検定で優位性を測ります。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. なぜ単純な2標本検定ではダメか（重複の罠）</p>
        <p>
          この戦略は B&H の保有区間の<span className="font-medium">部分集合</span>です（両者とも平日は保有し、
          違いは週末だけ）。標本が大きく重なり、かつ日次リターンには自己相関があるため、
          日次リターンを2群に分けて t検定すると p値が過小評価され、偽陽性を招きます。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 差の分解（この分析の核）</p>
        <p>
          すべてを価格イベント間の区間（segment）に分解します。営業日 i について、
          日中区間 r<sub>intraday</sub> = log(終値<sub>i</sub>/始値<sub>i</sub>)、
          夜間区間 r<sub>overnight</sub> = log(始値<sub>i+1</sub>/終値<sub>i</sub>)。
          対数リターンは加法的なので、全期間について厳密に次が成り立ちます:
        </p>
        <p className="pl-2">{"log(B&H資産) − log(戦略資産) = Σ_(戦略が捨てた区間) log(1+r)"}</p>
        <p>
          戦略が捨てる区間は、月曜の建て前・金曜の手仕舞い後、そして<span className="font-medium">週末ギャップ（金曜終値→月曜始値）</span>です。
          したがって「戦略が B&H に勝つ」⟺「捨てた区間の平均リターンが負」。これはいわゆる
          <span className="font-medium">週末効果</span>そのもので、重複しない差の部分だけを取り出して検定できます。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 4つの検定</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <span className="font-medium">① 週末ギャップ検定</span>: 週次の超過リターン e<sub>w</sub> = 戦略<sub>w</sub> − B&H<sub>w</sub>
            （= −捨てた区間）の平均が正かを<span className="font-medium">片側t検定</span>。系列相関に頑健な
            <span className="font-medium">移動ブロック・ブートストラップ</span>で95%信頼区間も推定。ブロック長 L ≈ n<sup>1/3</sup>。
          </li>
          <li>
            <span className="font-medium">② Sharpe差検定</span>: 戦略は週末に現金化して滞在率が低いので、総リターンではなく
            リスク調整後の Sharpe で公平に比較。<span className="font-medium">Jobson–Korkie–Memmel</span>の解析検定
            θ = (1/T)[2(1−ρ) + ½(SR<sub>a</sub>² + SR<sub>b</sub>² − 2·SR<sub>a</sub>SR<sub>b</sub>ρ²)]、z = (SR<sub>a</sub>−SR<sub>b</sub>)/√θ。
            iid正規を仮定するため、ペア・ブロックBootstrapも併記して頑健化。
          </li>
          <li>
            <span className="font-medium">③ 週次ペア差の頑健検定</span>: 分布が非正規・外れ値が多い場合に備え、
            <span className="font-medium">Wilcoxon符号順位検定</span>と<span className="font-medium">符号検定</span>で
            「超過の中央値が0より大きいか」を検定。平均に依存しないので少数の極端な週に振り回されません。
          </li>
          <li>
            <span className="font-medium">④ 年率差 Bootstrap CI</span>: 年率リターン差そのものの95%信頼区間を
            ペア・ブロックBootstrapで推定。区間が0を跨がなければ実務的に意味のある差と解釈できます。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>各カードの緑バッジ（p&lt;0.05）は「その検定で有意に優位」を意味します。星は *** p&lt;0.01 / ** p&lt;0.05 / * p&lt;0.1。</li>
          <li><span className="font-medium">総合判定</span>で 4検定中いくつが有意かを表示。3つ以上なら優位性は頑健と考えられます。</li>
          <li>週末ギャップ検定の「捨てた区間の平均」が明確に負なら、戦略の優位は週末効果に由来すると分かります。</li>
          <li>Sharpe差のBootstrap「差&gt;0の確率」が95%以上なら、リスク調整後でも優位である確信度が高い。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>優位が頑健なら、週末リスク（金曜終値→月曜始値の裸のギャップ）を避ける運用に合理性があります。</li>
          <li>建て/手仕舞いのタイミング（始値/終値）を切り替え、どの区切りが最も優位かを比較できます。</li>
          <li>Sharpeが改善しても総リターンが劣る場合は、余った現金（週末）を別資産に回すことで初めて実利になります。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">取引コスト未考慮</span>: 毎週2回の売買コスト・スリッページを引くと優位は縮みます。週次超過が数bpなら実務では消えがち。</li>
          <li><span className="font-medium">祝日の扱い</span>: 月曜が休場の週はその週の建てを見送る（既存シミュレータと同じ定義）。連休の週末ギャップは通常より大きくなります。</li>
          <li><span className="font-medium">構造変化</span>: 週末効果は時代・銘柄で消えたり反転したりします。期間セレクタを変えて安定性を確認してください。</li>
          <li><span className="font-medium">単一銘柄・多重検定</span>: タイミングを総当たりで探すと偶然の「勝ち」を拾いやすい。複数銘柄・期間での再現性を重視してください。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
