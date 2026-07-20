"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type IPriceLine,
  type Time,
  type SeriesMarker,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import AnalysisGuide from "./AnalysisGuide";
import { buildEdgeCatalog } from "../../lib/edge-trades";
import { computeDecay, DEFAULT_DECAY_PARAMS, type DecayResult } from "../../lib/edge-decay";

interface Props {
  prices: PricePoint[];
}

function Badge({ label, value, tone, sub }: { label: string; value: string; tone: "good" | "bad" | "neutral"; sub?: string }) {
  const cls = tone === "good" ? "bg-green-50 border-green-200 text-green-700"
    : tone === "bad" ? "bg-red-50 border-red-200 text-red-700"
    : "bg-gray-50 border-gray-200 text-gray-700";
  return (
    <div className={`rounded border px-3 py-2 ${cls}`}>
      <div className="text-[10px] opacity-70">{label}</div>
      <div className="text-base font-bold font-mono">{value}</div>
      {sub && <div className="text-[10px] opacity-70">{sub}</div>}
    </div>
  );
}

function baseChart(el: HTMLDivElement, height: number, timeVisible: boolean): IChartApi {
  return createChart(el, {
    layout: { background: { color: "#ffffff" }, textColor: "#333" },
    grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
    width: el.clientWidth,
    height,
    crosshair: { mode: 0 },
    rightPriceScale: { visible: true },
    timeScale: { timeVisible: false, visible: timeVisible },
  });
}

// 3ペインの時間軸を相互同期する
function syncCharts(charts: IChartApi[]) {
  const unsubs: (() => void)[] = [];
  for (const src of charts) {
    const handler = (range: { from: number; to: number } | null) => {
      if (!range) return;
      for (const dst of charts) {
        if (dst !== src) dst.timeScale().setVisibleLogicalRange(range);
      }
    };
    src.timeScale().subscribeVisibleLogicalRangeChange(handler);
    unsubs.push(() => src.timeScale().unsubscribeVisibleLogicalRangeChange(handler));
  }
  return () => unsubs.forEach((u) => u());
}

export default function EdgeDecayChart({ prices }: Props) {
  const eqRef = useRef<HTMLDivElement>(null);
  const lrRef = useRef<HTMLDivElement>(null);
  const cuRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<IChartApi[]>([]);
  const seriesRef = useRef<{
    eqIS: ISeriesApi<"Line">; eqOOS: ISeriesApi<"Line">;
    lr: ISeriesApi<"Line">; cu: ISeriesApi<"Line">;
  } | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<{ series: ISeriesApi<"Line">; line: IPriceLine }[]>([]);

  const [edgeId, setEdgeId] = useState<string>("");
  const [isFracPct, setIsFracPct] = useState(DEFAULT_DECAY_PARAMS.isFrac * 100);
  const [cusumH, setCusumH] = useState(DEFAULT_DECAY_PARAMS.cusumH);

  const catalog = useMemo(() => buildEdgeCatalog(prices), [prices]);
  const effectiveId = edgeId || (catalog[0]?.id ?? "");

  const result: DecayResult | null = useMemo(() => {
    const edge = catalog.find((e) => e.id === effectiveId);
    if (!edge) return null;
    return computeDecay(edge, { ...DEFAULT_DECAY_PARAMS, isFrac: isFracPct / 100, cusumH });
  }, [catalog, effectiveId, isFracPct, cusumH]);

  // チャート初期化(一度だけ)
  useEffect(() => {
    if (!eqRef.current || !lrRef.current || !cuRef.current) return;
    const eq = baseChart(eqRef.current, 240, false);
    const lr = baseChart(lrRef.current, 160, false);
    const cu = baseChart(cuRef.current, 160, true);
    const eqIS = eq.addSeries(LineSeries, { color: "#9ca3af", lineWidth: 2, title: "IS(発見期間)", lineStyle: LineStyle.Dotted });
    const eqOOS = eq.addSeries(LineSeries, { color: "#2563eb", lineWidth: 2, title: "OOS(監視期間)" });
    const lrS = lr.addSeries(LineSeries, { color: "#7c3aed", lineWidth: 2, title: "SPRT logLR" });
    const cuS = cu.addSeries(LineSeries, { color: "#d97706", lineWidth: 2, title: "CUSUM" });
    chartsRef.current = [eq, lr, cu];
    seriesRef.current = { eqIS, eqOOS, lr: lrS, cu: cuS };
    markersRef.current = createSeriesMarkers(eqOOS, []);
    const unsync = syncCharts([eq, lr, cu]);
    const onResize = () => {
      if (eqRef.current) eq.applyOptions({ width: eqRef.current.clientWidth });
      if (lrRef.current) lr.applyOptions({ width: lrRef.current.clientWidth });
      if (cuRef.current) cu.applyOptions({ width: cuRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      unsync();
      [eq, lr, cu].forEach((c) => c.remove());
      chartsRef.current = [];
      seriesRef.current = null;
      markersRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  // データ更新
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    // 前回の価格ライン・マーカーを消してから引き直す(積み重なり防止)
    for (const { series, line } of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];
    markersRef.current?.setMarkers([]);
    if (!result) {
      s.eqIS.setData([]); s.eqOOS.setData([]); s.lr.setData([]); s.cu.setData([]);
      return;
    }
    const isData: { time: Time; value: number }[] = [];
    const oosData: { time: Time; value: number }[] = [];
    const lrData: { time: Time; value: number }[] = [];
    const cuData: { time: Time; value: number }[] = [];
    let lastIs: { time: Time; value: number } | null = null;
    for (const p of result.points) {
      const t = p.date as Time;
      if (!p.oos) { const pt = { time: t, value: p.equity }; isData.push(pt); lastIs = pt; }
      else {
        oosData.push({ time: t, value: p.equity });
        lrData.push({ time: t, value: p.logLR });
        cuData.push({ time: t, value: p.cusum });
      }
    }
    if (lastIs && oosData.length > 0) oosData.unshift(lastIs);
    s.eqIS.setData(isData);
    s.eqOOS.setData(oosData);
    s.lr.setData(lrData);
    s.cu.setData(cuData);

    // SPRT境界とCUSUM閾値
    priceLinesRef.current.push(
      { series: s.lr, line: s.lr.createPriceLine({ price: result.sprtUpper, color: "#059669", lineWidth: 1, lineStyle: LineStyle.Dashed, title: "健在確定" }) },
      { series: s.lr, line: s.lr.createPriceLine({ price: result.sprtLower, color: "#dc2626", lineWidth: 1, lineStyle: LineStyle.Dashed, title: "消滅確定" }) },
      { series: s.lr, line: s.lr.createPriceLine({ price: 0, color: "#d1d5db", lineWidth: 1, lineStyle: LineStyle.Dotted, title: "" }) },
      { series: s.cu, line: s.cu.createPriceLine({ price: cusumH, color: "#dc2626", lineWidth: 1, lineStyle: LineStyle.Dashed, title: "警報" }) },
    );

    // イベントマーカー
    const markers: SeriesMarker<Time>[] = [];
    if (result.sprtCrossDate) {
      markers.push({
        time: result.sprtCrossDate as Time,
        position: "aboveBar",
        color: result.sprtState === "alive" ? "#059669" : "#dc2626",
        shape: result.sprtState === "alive" ? "arrowUp" : "arrowDown",
        text: result.sprtState === "alive" ? "SPRT健在" : "SPRT消滅",
      });
    }
    if (result.cusumAlarmDate) {
      markers.push({ time: result.cusumAlarmDate as Time, position: "belowBar", color: "#d97706", shape: "circle", text: "CUSUM警報" });
    }
    markers.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    markersRef.current?.setMarkers(markers);

    chartsRef.current.forEach((c) => c.timeScale().fitContent());
  }, [result, cusumH]);

  if (prices.length < 400) {
    return <div className="text-xs text-gray-400 p-3">データが不足しています(400営業日以上必要)。</div>;
  }

  const stateBadge = result
    ? result.sprtState === "alive"
      ? { v: "健在(証拠十分)", tone: "good" as const }
      : result.sprtState === "dead"
        ? { v: "消滅(証拠十分)", tone: "bad" as const }
        : { v: "未決(監視継続)", tone: "neutral" as const }
    : null;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">エッジ減衰・死亡検知 — このエッジはまだ生きているか</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          発見期間(IS)のエッジを、その後の取引でSPRT(いつ覗いても誤り率が壊れない逐次検定)とCUSUMで監視。
          「効かなくなったのにいつまでも信じ続ける」ことを統計的に防ぐ。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          エッジ
          <select className="border rounded px-1 py-0.5" value={effectiveId} onChange={(e) => setEdgeId(e.target.value)}>
            {catalog.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          発見期間(IS)割合
          <select className="border rounded px-1 py-0.5" value={isFracPct} onChange={(e) => setIsFracPct(Number(e.target.value))}>
            {[30, 40, 50, 60].map((v) => <option key={v} value={v}>{v}%</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          CUSUM閾値h
          <select className="border rounded px-1 py-0.5" value={cusumH} onChange={(e) => setCusumH(Number(e.target.value))}>
            {[4, 5, 6].map((v) => <option key={v} value={v}>{v}σ</option>)}
          </select>
        </label>
      </div>

      {!result ? (
        <div className="text-xs text-gray-400">
          この設定では監視を構成できません。IS期間の平均が負(そもそも発見期間にエッジが無い)か、取引数が不足しています。
          別のエッジを選ぶか、IS割合を変えてください。
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
            <Badge label="SPRT判定" value={stateBadge!.v} tone={stateBadge!.tone} sub={result.sprtCrossDate ?? `logLR ${result.points[result.points.length - 1].logLR.toFixed(1)}`} />
            <Badge label="IS μ/取引" value={`${(result.muIS * 100).toFixed(3)}%`} tone="neutral" sub={`${result.direction === "long" ? "買い" : "売り"}・n=${result.nIS}`} />
            <Badge
              label="OOS μ/取引"
              value={`${(result.muOOS * 100).toFixed(3)}%`}
              tone={result.muOOS > 0 ? "good" : "bad"}
              sub={`n=${result.nOOS}・IS比${result.muIS !== 0 ? ((result.muOOS / result.muIS) * 100).toFixed(0) : "—"}%`}
            />
            <Badge label="CUSUM警報" value={result.cusumAlarmDate ?? "なし"} tone={result.cusumAlarmDate ? "bad" : "good"} sub={`閾値 ${cusumH}σ`} />
            <Badge
              label="経時減衰傾き"
              value={`${(result.trendSlopePerYear * 100).toFixed(3)}%/年`}
              tone={result.trendT < -2 ? "bad" : "neutral"}
              sub={`t=${result.trendT.toFixed(1)} p=${result.trendP.toFixed(3)}`}
            />
          </div>

          <div>
            <div className="text-xs text-gray-500 mb-1">
              累積エクイティ（灰点線=IS発見期間 / 青=OOS監視期間、IS/OOS境界 {result.splitDate}）
            </div>
            <div ref={eqRef} className="w-full rounded border border-gray-100" />
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">
              SPRT累積対数尤度比 — 緑破線を上抜け=「エッジ健在」の証拠十分 / 赤破線を下抜け=「エッジ不在」の証拠十分
            </div>
            <div ref={lrRef} className="w-full rounded border border-gray-100" />
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">
              CUSUM(下方シフト検知) — 赤破線超え=ISの水準からの陥落を警報。SPRTより早いが誤警報も出やすい早期警戒線
            </div>
            <div ref={cuRef} className="w-full rounded border border-gray-100" />
          </div>

          {/* 時代別テーブル */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-1.5">時代</th>
                  <th className="text-right px-1">n</th>
                  <th className="text-right px-1">μ/取引</th>
                  <th className="text-right px-1.5">95%CI</th>
                  <th className="text-right px-1.5">年率Sharpe</th>
                </tr>
              </thead>
              <tbody>
                {result.eras.map((e, i) => (
                  <tr key={i} className="border-b border-gray-100">
                    <td className="py-1 px-1.5 font-mono text-gray-600">{e.label}</td>
                    <td className="text-right px-1 font-mono">{e.n}</td>
                    <td className={`text-right px-1 font-mono ${e.meanTrade > 0 ? "text-green-600" : "text-red-600"}`}>{(e.meanTrade * 100).toFixed(3)}%</td>
                    <td className="text-right px-1.5 font-mono text-gray-500">[{(e.ciLo * 100).toFixed(3)}%, {(e.ciHi * 100).toFixed(3)}%]</td>
                    <td className="text-right px-1.5 font-mono">{e.sharpe.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <AnalysisGuide title="エッジ減衰・死亡検知の詳細理論">
        <p className="font-medium text-gray-700">1. なぜ必要か</p>
        <p>
          エッジの死に方は2通りです。(a) 最初から偽発見だった(データマイニングの産物)、(b) 本物だったが、
          発見・公表・裁定によって食い潰された。学術研究(McLean &amp; Pontiff 2016)では、論文で公表されたアノマリーは
          公表後にリターンが平均3〜4割減衰することが知られています。問題は「効かなくなったことに、いつ気付けるか」。
          毎日成績を見てt検定すると、覗くたびに偽陽性の機会が増えて誤り率が壊れます(多重比較)。
          これを解決するのが逐次検定です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          {"SPRT(Wald 1945)は H1「μ=μ_IS(健在)」vs H0「μ=0(不在)」の対数尤度比を取引ごとに累積します: "}
          {"λ_i = (μ_IS·r_i − μ_IS²/2)/σ²、L_t = Σλ_i。L_t ≥ ln((1−β)/α) で H1 採択(健在確定)、"}
          {"L_t ≤ ln(β/(1−α)) で H0 採択(消滅確定)。α=β=5% なら境界は約 ±2.94。"}
          {"この検定は「いつ停止してもよい」ことが保証されており(anytime-valid)、毎日覗いても誤り率が α を超えません。"}
          {"CUSUMは z_i=(r_i−μ_IS)/σ に対し S_i = max(0, S_{i−1} − z_i − k)、k = μ_IS/(2σ)。"}
          {"kは「μ_IS から 0 へのシフト」を最速検知する基準値で、S_i が h(4〜6σ)を超えたら警報です。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 直感的な例え</p>
        <p>
          SPRTは「裁判」です。取引1回ごとに健在説と消滅説それぞれの証拠を天秤に載せ、どちらかの証拠が
          「合理的疑いを超えた」時点で判決を出します。CUSUMは「ダムの水位計」で、ISの水準を下回る取引が
          続くと水位が上がり、警報線を超えたら異変とみなします。裁判(SPRT)は慎重で遅く、水位計(CUSUM)は
          敏感で早いが誤報もある——2つを並走させるのはそのためです。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>SPRTが緑破線を上抜けたら、ISのエッジはOOSでも実在した可能性が高い(誤り率5%管理下)。</li>
          <li>赤破線を下抜けたら「OOSにμ_IS級のエッジは無い」。撤退判断の統計的根拠になります。</li>
          <li>どちらにも達しない「未決」は情報不足。エッジが小さいほど判決には多くの取引が必要です。</li>
          <li>logLRの「傾き」も情報です。右肩上がり=日々健在の証拠が積み上がっている。水平〜下向き=期待リターンがゼロに近い。</li>
          <li>時代別テーブルとCUSUM警報日で「いつから死んだか」を突き止められます。経時傾きが有意に負なら、公表・混雑による漸進的減衰のパターン。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>採用中の戦略には撤退基準を「事前に」決めておく: 例「SPRTが消滅判定 or CUSUM警報が出たら建玉を落とす」。事後の裁量判断はサンクコストバイアスに負けます。</li>
          <li>SPRT未決のうちは建玉を小さく、健在確定後に規模を上げる、という段階的なサイジングにも使えます。</li>
          <li>IS割合を動かして判定が大きく変わるなら、そのエッジの「発見」自体が期間依存で脆い証拠です。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>正規尤度・分散既知の近似を使っています。リターンの裾が厚い銘柄では境界到達がやや過信になりえます。</li>
          <li>H1をIS推定値μ_ISに置くため、ISが過大推定(勝者バイアス)だと消滅判定が出やすくなります。これは保守側の誤りで、実運用上はむしろ安全です。</li>
          <li>エッジ選択そのものをこの画面で最適化する(いろいろ試して良いものを選ぶ)と、それ自体が新たな多重比較になります。候補選定はスキャン系のFDR補正を通してから。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
