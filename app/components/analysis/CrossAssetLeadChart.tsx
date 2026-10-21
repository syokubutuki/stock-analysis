"use client";

// クロスアセット先行指標スキャン。金・BTC・コモディティ・金利・為替・信用・海外金融株の
// 「前夜の動き」が、この銘柄の寄り付きの窓／寄り後／翌日／5日先に先行するかを一覧にする。
// 計算は app/lib/cross-asset-lead.ts、族補正（円環シフトの帰無）は Worker。

import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, LineSeries, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  LEAD_CANDIDATES, LEAD_GROUPS, GAP_MODEL_TICKERS, HORIZON_LABEL, LEAD_HORIZONS, FEAT_LABEL,
  buildJpTargets, alignFeature, fitGapModel, rollingCorr, bigMoves,
  type LeadCell, type LeadFeat, type LeadHorizon, type LeadScanResult, type AlignedFeature,
} from "../../lib/cross-asset-lead";
import type { CrossAssetLeadWorkerResponse } from "../../lib/cross-asset-lead.worker";
import { useBenchmarkSet } from "../../hooks/useBenchmarkSet";
import { describeSanityReport } from "../../lib/price-sanity";
import AnalysisGuide from "./AnalysisGuide";

const TICKERS = LEAD_CANDIDATES.map((c) => c.ticker);
const LABEL = new Map(LEAD_CANDIDATES.map((c) => [c.ticker, c.label]));
const N_NULL = 300;

const pct = (v: number, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%` : "—");
const fx = (v: number, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "—");

/** t 値を色に。|t|≥2 から色が付き、族補正で有意なら濃い枠。 */
function cellStyle(t: number): React.CSSProperties {
  if (!Number.isFinite(t)) return { background: "#f9fafb", color: "#9ca3af" };
  const a = Math.min(Math.abs(t), 10);
  if (a < 2) return { background: "#ffffff", color: "#6b7280" };
  const k = Math.min(1, (a - 2) / 8) * 0.75 + 0.15;
  return t > 0
    ? { background: `rgba(37, 99, 235, ${k})`, color: k > 0.5 ? "#fff" : "#1e3a8a" }
    : { background: `rgba(220, 38, 38, ${k})`, color: k > 0.5 ? "#fff" : "#7f1d1d" };
}

function toTs(time: string): UTCTimestamp {
  return (Date.parse(`${time}T00:00:00Z`) / 1000) as UTCTimestamp;
}

export default function CrossAssetLeadChart({ prices, ticker }: { prices: PricePoint[]; ticker: string }) {
  const set = useBenchmarkSet(TICKERS);
  const [feat, setFeat] = useState<LeadFeat>("d1");
  const [selected, setSelected] = useState<string>("GC=F");
  const [scan, setScan] = useState<{ key: string; result: LeadScanResult } | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  const targets = useMemo(() => buildJpTargets(prices), [prices]);

  const aligned = useMemo(() => {
    if (set.loading) return null;
    const m = new Map<string, AlignedFeature>();
    for (const c of LEAD_CANDIDATES) {
      const e = set.entries.get(c.ticker);
      if (e && e.prices.length > 300) m.set(c.ticker, alignFeature(targets.times, e.prices, c.kind));
    }
    return m;
  }, [set.loading, set.entries, targets]);

  const scanKey = `${ticker}|${targets.times.length}|${targets.times[targets.times.length - 1] ?? ""}|${aligned ? aligned.size : 0}`;

  useEffect(() => {
    const worker = new Worker(new URL("../../lib/cross-asset-lead.worker.ts", import.meta.url));
    workerRef.current = worker;
    return () => { worker.terminate(); workerRef.current = null; };
  }, []);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || !aligned || aligned.size === 0 || targets.times.length < 500) return;
    const reqId = ++reqIdRef.current;
    worker.onmessage = (ev: MessageEvent<CrossAssetLeadWorkerResponse>) => {
      if (ev.data.reqId !== reqIdRef.current) return;
      if (ev.data.ok && ev.data.result) { setScan({ key: scanKey, result: ev.data.result }); setScanError(null); }
      else setScanError(ev.data.error ?? "計算に失敗しました");
    };
    const features = LEAD_CANDIDATES.filter((c) => aligned.has(c.ticker)).map((c) => {
      const a = aligned.get(c.ticker)!;
      return { ticker: c.ticker, d1: a.d1, d5: a.d5 };
    });
    worker.postMessage({ reqId, targets, features, nNull: N_NULL });
  }, [aligned, targets, scanKey]);

  const result = scan && scan.key === scanKey ? scan.result : null;

  const cellMap = useMemo(() => {
    const m = new Map<string, LeadCell>();
    if (result) for (const c of result.cells) m.set(`${c.ticker}|${c.feat}|${c.horizon}`, c);
    return m;
  }, [result]);

  const gapModel = useMemo(() => {
    if (!aligned) return null;
    const feats = GAP_MODEL_TICKERS.filter((t) => aligned.has(t)).map((t) => {
      const a = aligned.get(t)!;
      return { ticker: t, d1: a.d1, nextD1: a.nextD1 };
    });
    return feats.length ? fitGapModel(targets, feats) : null;
  }, [aligned, targets]);

  const selAligned = aligned?.get(selected) ?? null;
  const rolling = useMemo(() => {
    if (!selAligned) return null;
    return {
      gap: rollingCorr(targets.times, targets.gap, selAligned.d1),
      id: rollingCorr(targets.times, targets.id, selAligned.d1),
    };
  }, [selAligned, targets]);
  const moves = useMemo(() => (selAligned ? bigMoves(targets, selAligned.d1) : null), [selAligned, targets]);

  // ローリング相関（横軸が日付なので lightweight-charts）
  const chartBox = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  useEffect(() => {
    if (!chartBox.current || !rolling) return;
    const chart = createChart(chartBox.current, {
      height: 220,
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      rightPriceScale: { borderColor: "#e5e7eb" },
      timeScale: { timeVisible: false, borderColor: "#e5e7eb" },
      autoSize: true,
    });
    chartRef.current = chart;
    const g = chart.addSeries(LineSeries, { color: "#2563eb", lineWidth: 2, title: "窓との相関", priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
    const d = chart.addSeries(LineSeries, { color: "#ea580c", lineWidth: 2, title: "寄り→引けとの相関", priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
    const z = chart.addSeries(LineSeries, { color: "#9ca3af", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
    g.setData(rolling.gap.map((p) => ({ time: toTs(p.time), value: p.value })));
    d.setData(rolling.id.map((p) => ({ time: toTs(p.time), value: p.value })));
    if (rolling.gap.length) z.setData(rolling.gap.map((p) => ({ time: toTs(p.time), value: 0 })));
    chart.timeScale().fitContent();
    return () => { chart.remove(); chartRef.current = null; };
  }, [rolling]);

  const repaired = useMemo(() => {
    const out: string[] = [];
    for (const [t, e] of set.entries) {
      const msg = describeSanityReport(e.dataQuality);
      if (msg && e.dataQuality && (e.dataQuality.repaired.length > 0 || e.dataQuality.suspects.length > 0)) out.push(`${LABEL.get(t) ?? t}: ${msg}`);
    }
    return out;
  }, [set.entries]);

  if (prices.length < 500) {
    return <p className="text-sm text-fg-muted">日足が500本以上必要です（現在 {prices.length} 本）。</p>;
  }

  const tradableBest = result
    ? result.cells
        .filter((c) => c.horizon !== "gap")
        .sort((a, b) => a.pFamily - b.pFamily || Math.abs(b.t) - Math.abs(a.t))[0]
    : null;
  const gapBest = result
    ? result.cells.filter((c) => c.horizon === "gap" && c.feat === "d1").sort((a, b) => Math.abs(b.t) - Math.abs(a.t))[0]
    : null;
  const gold = cellMap.get(`GC=F|d1|gap`);
  const btc = cellMap.get(`BTC-USD|d1|gap`);
  const goldTr = result ? result.cells.filter((c) => c.ticker === "GC=F" && c.horizon !== "gap").sort((a, b) => a.pFamily - b.pFamily)[0] : null;
  const btcTr = result ? result.cells.filter((c) => c.ticker === "BTC-USD" && c.horizon !== "gap").sort((a, b) => a.pFamily - b.pFamily)[0] : null;

  const usStale = aligned ? (() => {
    const lastJp = targets.times[targets.times.length - 1];
    const us = aligned.get("^GSPC");
    return !us?.latestTime || us.latestTime < lastJp ? us?.latestTime ?? null : null;
  })() : null;

  return (
    <div className="space-y-4 text-sm text-fg-body">
      {/* 結論カード */}
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded border border-blue-200 bg-blue-50 p-3">
          <div className="text-[11px] text-blue-800 font-medium">寄り付きの窓（前日終値→始値）</div>
          <div className="mt-1 text-lg font-semibold text-blue-900">
            {gapModel ? `説明できる: 時間外R² ${(gapModel.oosR2 * 100).toFixed(0)}%` : "計算中…"}
          </div>
          <div className="text-[11px] text-blue-800 mt-1 leading-relaxed">
            {gapBest ? <>最も強いのは <b>{LABEL.get(gapBest.ticker)}</b>（t={fx(gapBest.t, 1)}）。</> : null}
            ただし窓は寄り付いた瞬間に終わっているので、<b>寄りで建てる人には取れない</b>。
          </div>
        </div>
        <div className={`rounded border p-3 ${result && result.nFamilySig > 0 ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-gray-50"}`}>
          <div className="text-[11px] text-gray-700 font-medium">寄り後（売買できる部分）</div>
          <div className="mt-1 text-lg font-semibold text-gray-900">
            {result ? (result.nFamilySig > 0 ? `族補正後も残る: ${result.nFamilySig} / ${result.nTests}` : `先行指標なし（0 / ${result.nTests}）`) : "検定中…"}
          </div>
          <div className="text-[11px] text-gray-600 mt-1 leading-relaxed">
            {tradableBest ? (
              <>
                最も強い候補でも {LABEL.get(tradableBest.ticker)}（{FEAT_LABEL[tradableBest.feat]}→{HORIZON_LABEL[tradableBest.horizon]}）
                t={fx(tradableBest.t, 2)}・族補正 p={tradableBest.pFamily.toFixed(2)}。
                {result ? <>偶然でも最大 |t| は {result.nullQ95.id?.toFixed(1)} 程度まで出る。</> : null}
              </>
            ) : null}
          </div>
        </div>
        <div className="rounded border border-gray-200 bg-white p-3">
          <div className="text-[11px] text-gray-700 font-medium">金とビットコイン</div>
          <div className="mt-1 text-[12px] leading-relaxed">
            <div>
              <b>金</b>: 窓 t={fx(gold?.t ?? NaN, 1)}
              {goldTr ? <>／寄り後の最良 t={fx(goldTr.t, 1)}（p={goldTr.pFamily.toFixed(2)}）</> : null}
            </div>
            <div>
              <b>BTC</b>: 窓 t={fx(btc?.t ?? NaN, 1)}・米国株を除くと {fx(btc?.tCtrl ?? NaN, 1)}
              {btcTr ? <>／寄り後の最良 t={fx(btcTr.t, 1)}（p={btcTr.pFamily.toFixed(2)}）</> : null}
            </div>
          </div>
          <div className="text-[11px] text-gray-500 mt-1">|t|&lt;2 は「関係が見えない」。下の表で他の候補と比べられる。</div>
        </div>
      </div>

      {/* 寄り付き窓の予想 */}
      {gapModel ? (
        <div className="rounded border border-gray-200 p-3">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="font-semibold text-gray-800">次の寄り付きの窓の目安</span>
            <span className="text-[11px] text-fg-muted">
              {GAP_MODEL_TICKERS.map((t) => LABEL.get(t)).join("・")} の前夜1日の変化で回帰（{gapModel.n}日、時間外R² {(gapModel.oosR2 * 100).toFixed(1)}%）
            </span>
          </div>
          {usStale !== null ? (
            <p className="mt-2 text-[12px] text-gray-600">
              最後の立会日（{gapModel.lastTime}）より後の米国の終値がまだありません（米国の最新 {usStale ?? "—"}）。
              次の寄りの目安は、米国の取引終了後（日本時間の朝6〜7時）に更新されます。
              直近の寄りは 当てはめ {pct(gapModel.lastPred)} ／ 実際 {pct(gapModel.lastActual)}。
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap items-baseline gap-x-4">
              <span className="text-2xl font-semibold" style={{ color: gapModel.nextPred >= 0 ? "#1d4ed8" : "#b91c1c" }}>
                {pct(gapModel.nextPred)}
              </span>
              <span className="text-[12px] text-gray-600">
                ±{(gapModel.residSd * 100).toFixed(2)}%（1σ。外れる幅のほうが大きいことに注意）
              </span>
            </div>
          )}
          <table className="mt-2 w-full text-[11px] border-collapse">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 pr-2 font-medium">指標</th>
                <th className="text-right py-1 px-2 font-medium">係数β</th>
                <th className="text-right py-1 px-2 font-medium">t</th>
                <th className="text-right py-1 px-2 font-medium">直近の変化</th>
                <th className="text-right py-1 pl-2 font-medium">寄与</th>
              </tr>
            </thead>
            <tbody>
              {gapModel.coef.map((c) => {
                const kind = LEAD_CANDIDATES.find((x) => x.ticker === c.ticker)?.kind;
                return (
                  <tr key={c.ticker} className="border-b border-gray-100">
                    <td className="py-1 pr-2">{LABEL.get(c.ticker)}</td>
                    <td className="py-1 px-2 text-right">{c.beta.toFixed(3)}</td>
                    <td className="py-1 px-2 text-right">{fx(c.t, 1)}</td>
                    <td className="py-1 px-2 text-right">{usStale !== null ? "—" : kind === "diff" ? `${fx(c.nextX, 3)}%pt` : pct(c.nextX)}</td>
                    <td className="py-1 pl-2 text-right">{usStale !== null ? "—" : pct(c.contribution, 3)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* ヒートマップ表 */}
      <div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-gray-800">候補 × いつの値動きに先行するか（t値）</span>
          {(["d1", "d5"] as LeadFeat[]).map((f) => (
            <button key={f} type="button" onClick={() => setFeat(f)}
              className={`px-2 py-0.5 rounded border ${feat === f ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-700 border-gray-300"}`}>
              {FEAT_LABEL[f]}
            </button>
          ))}
          <span className="text-fg-muted">
            {set.loading ? `参照系列を取得中 ${set.done}/${set.total}` : result ? `${result.firstTime}〜${result.lastTime}・${result.nDays}日` : scanError ?? "検定中（帰無分布を計算しています）…"}
          </span>
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-[11px] border-collapse min-w-[560px]">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 pr-2 font-medium">候補</th>
                {LEAD_HORIZONS.map((h) => (
                  <th key={h} className="text-center py-1 px-1 font-medium">
                    {HORIZON_LABEL[h]}
                    <div className="text-[9px] font-normal">{h === "gap" ? "売買できない" : "寄りで建てて取れる"}</div>
                  </th>
                ))}
                <th className="text-right py-1 pl-2 font-medium">米国株を除いた<br />窓の t</th>
              </tr>
            </thead>
            <tbody>
              {LEAD_GROUPS.map((g) => (
                <GroupRows key={g} group={g} feat={feat} cellMap={cellMap} selected={selected} onSelect={setSelected}
                  available={aligned} failed={set.failed} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-[10px] text-fg-muted leading-relaxed">
          青＝候補が上がると銘柄も上がる、赤＝逆。色は |t|≥2 から。<b>太枠</b>は売買できる3列の全 {result?.nTests ?? "—"} 検定で
          族補正（円環シフト {N_NULL} 回の最大|t|）後も p&lt;0.05 のもの。行をクリックすると下に詳細が出る。
          「直近5日の変化」の列は5日先と重なるので、t は Newey–West で補正済み。
        </p>
      </div>

      {/* 選択候補の詳細 */}
      {selAligned ? (
        <div className="rounded border border-gray-200 p-3">
          <div className="font-semibold text-gray-800">{LABEL.get(selected)} の詳細</div>
          <DetailStats cellMap={cellMap} ticker={selected} />
          <div className="mt-2 text-[11px] text-gray-600">過去1年（250立会日）のローリング相関。関係は一定ではない。</div>
          <div ref={chartBox} className="mt-1 w-full" style={{ height: 220 }} />
          {moves ? (
            <div className="mt-3 overflow-x-auto">
              <div className="text-[11px] text-gray-600">前夜に大きく動いた日（過去250日の標準偏差の2倍超）の、その後の平均</div>
              <table className="mt-1 w-full text-[11px] border-collapse min-w-[480px]">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 pr-2 font-medium">前夜</th>
                    {LEAD_HORIZONS.map((h) => <th key={h} className="text-right py-1 px-2 font-medium">{HORIZON_LABEL[h]}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {(["up", "down"] as const).map((side) => (
                    <tr key={side} className="border-b border-gray-100">
                      <td className="py-1 pr-2">{side === "up" ? "急騰" : "急落"}（n={moves.find((r) => r.side === side)?.n ?? 0}）</td>
                      {LEAD_HORIZONS.map((h) => {
                        const r = moves.find((x) => x.side === side && x.horizon === h)!;
                        const sig = Number.isFinite(r.mean) && Math.abs(r.mean - r.base) > r.ci && r.n >= 30;
                        return (
                          <td key={h} className={`py-1 px-2 text-right ${sig ? "font-semibold text-gray-900" : "text-gray-500"}`}>
                            {pct(r.mean)}<span className="text-[9px]"> ±{(r.ci * 100).toFixed(2)}</span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr>
                    <td className="py-1 pr-2 text-gray-500">全日の平均</td>
                    {LEAD_HORIZONS.map((h) => (
                      <td key={h} className="py-1 px-2 text-right text-gray-500">{pct(moves.find((x) => x.side === "up" && x.horizon === h)!.base)}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
              <p className="mt-1 text-[10px] text-fg-muted">太字は全日の平均と95%幅の外にあるもの（候補ごとに見ているので多重比較の補正はしていない。参考）。</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {repaired.length || set.failed.length ? (
        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800 space-y-0.5">
          {set.failed.length ? <div>取得できなかった系列: {set.failed.map((t) => LABEL.get(t) ?? t).join("、")}（表から除外）</div> : null}
          {repaired.length ? (
            <details>
              <summary className="cursor-pointer">
                データ品質: 参照系列 {repaired.length} 本で、修復または急変動の注記があります（金利・VIX・暗号資産の急変は本物の動きであることが多い）
              </summary>
              <div className="mt-1 space-y-0.5">
                {repaired.map((m) => <div key={m}>{m}</div>)}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      <AnalysisGuide title="クロスアセット先行指標スキャンの詳細理論">
        <p className="font-medium text-gray-700">1. 手法の概要</p>
        <p>
          金・ビットコイン・銅・原油・米金利・社債・為替・海外の金融株・VIX など{LEAD_CANDIDATES.length}系列について、
          「日本の寄り付き前までに分かっている動き」が、この銘柄のその後の値動きに先行するかを測ります。
          先行の相手を<b>4つの時間帯に分けている</b>のが要点です。①寄り付きの窓（前日終値→当日始値）、
          ②寄り→引け、③寄り→翌日の寄り、④寄り→5営業日後の寄り。
        </p>
        <p>
          ①は海外の夜間の動きと<b>同時に</b>進んでいるので、強く相関して当然です。しかも寄り付いた瞬間に終わっているため、
          寄りで注文を出す人はこの部分を取れません。「先行指標が見つかった」と言えるのは②〜④で関係が残る場合だけです。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          日本の立会日 D について、O_D・C_D を始値・終値とします。ターゲットは
          {" "}gap_D = ln(O_D / C_(D−1))、id_D = ln(C_D / O_D)、oo_D = ln(O_(D+1) / O_D)、f5_D = ln(O_(D+5) / O_D)。
        </p>
        <p>
          候補 X は「日付が D より厳密に小さい最新の足の終値」X*_D を使います（先読み防止）。米国の終値は日本時間の朝5〜7時、
          ビットコインの日足は日本時間9時（UTC0時）、為替は8〜9時に閉じるので、どれも寄り付き前に分かっています。
          説明変数は 1日変化 d1_D = ln X*_D − ln X*_(D−1)、5日変化 d5_D = ln X*_D − ln X*_(D−5)（金利は ln を取らず水準差 %pt）。
        </p>
        <p>
          各組について単回帰 y_D = a + b·x_D + e_D を当て、t = b̂ / SE(b̂) を出します。
          SE は不均一分散に頑健な HC0（f5 は5日の重複があるので Newey–West、ラグ4、Bartlett 重み）:
          {" "}Var(b̂) = [Σ u_i² + 2 Σ_(l=1..4) (1 − l/5) Σ_i u_i u_(i−l)] / S_xx²、u_i = (x_i − x̄)·ê_i。
        </p>
        <p>
          <b>族補正</b>：売買できる3つの時間帯のそれぞれで、全候補×2特徴（{LEAD_CANDIDATES.length * 2}本）の |t| の最大値 M を取ります。
          y の系列を丸ごと s 日ずらす（円環シフト）と、両者の自己相関やボラの塊はそのままで時点の対応だけが壊れます。
          これを {N_NULL} 回繰り返して M の帰無分布を作り、族補正 p = (#{"{"}M* ≥ |t|{"}"} + 1) / ({N_NULL} + 1) とします。
          50本も試せば偶然でも |t|≈3 は出る、という事実をそのまま差し引く方法です。
        </p>
        <p>
          <b>時間外 R²</b>：各日について「その日より前のデータだけ」で回帰を当て直して予測 ŷ を作り（全期間の40%の位置から開始）、
          R²_oos = 1 − Σ(y − ŷ)² / Σ y² を出します。基準は「予測ゼロ」なので、負なら何もしないほうが当たっています。
        </p>
        <p>
          <b>寄り付き窓の目安</b>：gap_D = a + Σ_k β_k·d1_k,D + e_D を {GAP_MODEL_TICKERS.map((t) => LABEL.get(t)).join("・")} で当てます。
          次の寄りの目安は β̂ と「最新の終値 − 最後の日本立会日の時点の値」の積の和、各項がその指標の寄与です。
          時間外 R² は21日ごとに拡大窓で再推定して測っています。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 専門用語の日本語定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>先行指標</b>：その動きが分かった時点で、まだ起きていない値動きの向きを当てられる系列。同時に動くだけの系列は先行指標ではない。</li>
          <li><b>窓（ギャップ）</b>：前日の終値と当日の始値の差。夜間に起きたことを寄り付きで一度に織り込んだ分。</li>
          <li><b>t値</b>：係数がゼロから標準誤差の何倍離れているか。|t|≥2 で「1回だけ試したなら偶然では出にくい」。</li>
          <li><b>族補正</b>：たくさん試した中の最大値は偶然でも大きくなる。その最大値の出方と比べて有意かを判定し直すこと。</li>
          <li><b>円環シフト</b>：系列を時間方向にずらし、はみ出した分を先頭に回すこと。系列の性質を保ったまま関係だけを壊す。</li>
          <li><b>時間外 R²</b>：過去だけで作った予測が、まだ見ていない日をどれだけ当てたか。標本内の R² より必ず厳しい。</li>
          <li><b>MOVE</b>：米国債の予想変動率の指数（債券版 VIX）。<b>ハイイールド債</b>：信用格付けの低い社債。信用不安で先に下がりやすい。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          天気予報で言えば、窓の列は「家を出た瞬間に雨が降っていたか」を窓の外の濡れた地面で当てるようなものです。よく当たりますが、
          出かける前に傘を持つ判断には役立ちません。役に立つのは「午後に雨が降るか」を朝の空で当てる列（寄り後の3列）です。
          そこが白いなら、朝の空模様はもう全部「今の天気」に反映されていて、午後のことは何も教えてくれないということです。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>窓の列で |t|≥5 なら、その系列は寄り付きの値段を決めている（例：米金融株・米金利）。売買の先行指標ではなく「寄りの目安」。</li>
          <li>寄り後の3列で太枠（族補正 p&lt;0.05）が1つもなければ、先行指標は<b>見つからなかった</b>。|t| が 2〜3 あっても、族補正 p が 0.2 以上なら偶然と区別できない。</li>
          <li>太枠があっても、時間外 R² が 0.5% 未満・年別の符号が7割未満の年でしか揃わないなら、売買に使うには弱い。</li>
          <li>ローリング相関が 0 の線を何度もまたぐ候補は、関係の向きそのものが時代で変わっている。</li>
          <li>寄り付き窓の目安の ±1σ が予想値より大きいなら、方向も外れうる。目安はあくまで中心。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <p>
          寄りで建てるか迷うとき、窓の目安で「寄りがどのあたりに付きそうか」を見て、指値の置き場所や、PTS・夜間先物で先に動くかの判断に使えます。
          一方、寄り後の列が白い限り、金やビットコインの値動きを見て当日〜数日の売買の向きを変えても、平均的には何も得られません。
          建玉の大きさを変えたいなら、方向でなく「荒れ具合」（VIX・ボラ・ドローダウン）を見るほうが検証で支持されています
          （同じ銀行株での研究: docs/bank-derisk-research.md）。
        </p>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>使えるのは /api/stock の10年分だけ。研究用に2006年からの長期データで確かめると、米金融株・S&P500・ユーロ円が寄り後まで先行していた（日中 t=5〜6）のは<b>2008〜09年の金融危機の2年間だけ</b>で、2010年以降は消えるか逆向き（寄りで行き過ぎて戻る）になっていた。危機の再来で戻る可能性はあるが、事前のVIXが30以上の日に絞っても2010年以降は再現しない。</li>
          <li>銘柄によっては「S&P500 の前夜1日の変化 → 寄り→引け」の負の関係（米国高の翌日は寄りで行き過ぎて日中に戻す）が族補正を通る（1615.T で p≈0.04）。これは既知の現象で、同じ銀行株での研究では片道10bpのコストで半減、20bpで消え、2008〜09年は逆符号だった。太枠でも売買の根拠にするには弱い。</li>
          <li>日足の終値どうしの比較なので、日本の取引時間中に海外で起きた動き（アジア時間の金・BTC）は「前夜1日の変化」に混ざる。日中足で時刻を揃えれば別の結果になりうる。</li>
          <li>先物（金・銅・原油・日経先物CME）は限月の乗り換え日に価格が跳ぶことがある。1日の跳びは t に効くが、族補正の帰無も同じデータで作っているので判定は崩れにくい。</li>
          <li>寄り付き窓モデルの説明変数は、メガバンク3行での事前研究（前進選択）を参考に経済的な理由で固定した。この銘柄のために選び直してはいないが、選び方の分だけ時間外 R² は甘く見える可能性がある。</li>
          <li>線形の関係しか見ていない。急変日の表は閾値型の関係を補うが、候補ごとの参考で多重比較の補正はしていない。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

function GroupRows({
  group, feat, cellMap, selected, onSelect, available, failed,
}: {
  group: string;
  feat: LeadFeat;
  cellMap: Map<string, LeadCell>;
  selected: string;
  onSelect: (t: string) => void;
  available: Map<string, AlignedFeature> | null;
  failed: string[];
}) {
  const rows = LEAD_CANDIDATES.filter((c) => c.group === group);
  return (
    <>
      <tr>
        <td colSpan={6} className="pt-2 pb-0.5 text-[10px] font-semibold text-gray-500">{group}</td>
      </tr>
      {rows.map((c) => {
        const missing = failed.includes(c.ticker) || (available !== null && !available.has(c.ticker));
        const gapCtrl = cellMap.get(`${c.ticker}|d1|gap`)?.tCtrl ?? NaN;
        return (
          <tr key={c.ticker} onClick={() => onSelect(c.ticker)}
            className={`cursor-pointer border-b border-gray-100 ${selected === c.ticker ? "bg-amber-50" : "hover:bg-gray-50"}`}>
            <td className={`py-1 pr-2 whitespace-nowrap ${selected === c.ticker ? "font-semibold" : ""}`}>
              {selected === c.ticker ? "▶ " : null}
              {c.label}
              <span className="ml-1 text-[9px] text-gray-400">{c.ticker}</span>
              {missing ? <span className="ml-1 text-[9px] text-amber-700">取得失敗</span> : null}
            </td>
            {LEAD_HORIZONS.map((h: LeadHorizon) => {
              const cell = cellMap.get(`${c.ticker}|${feat}|${h}`);
              const sig = cell && Number.isFinite(cell.pFamily) && cell.pFamily < 0.05;
              const title = cell
                ? `β=${cell.beta.toPrecision(3)} / 相関 ${cell.r.toFixed(3)} / n=${cell.n}` +
                  (Number.isFinite(cell.oosR2) ? ` / 時間外R² ${(cell.oosR2 * 100).toFixed(2)}%` : "") +
                  ` / 正の年 ${cell.yearsPos}/${cell.years}` +
                  (Number.isFinite(cell.pFamily) ? ` / 族補正p ${cell.pFamily.toFixed(3)}` : "")
                : "";
              return (
                <td key={h} title={title} className="py-1 px-1 text-center tabular-nums"
                  style={{ ...cellStyle(cell?.t ?? NaN), outline: sig ? "2px solid #111827" : undefined, outlineOffset: -2 }}>
                  {cell ? fx(cell.t, 1) : "…"}
                </td>
              );
            })}
            <td className="py-1 pl-2 text-right tabular-nums text-gray-600">{fx(gapCtrl, 1)}</td>
          </tr>
        );
      })}
    </>
  );
}

function DetailStats({ cellMap, ticker }: { cellMap: Map<string, LeadCell>; ticker: string }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-[11px] border-collapse min-w-[560px]">
        <thead>
          <tr className="text-gray-500 border-b border-gray-200">
            <th className="text-left py-1 pr-2 font-medium">前夜1日の変化 →</th>
            <th className="text-right py-1 px-2 font-medium">相関</th>
            <th className="text-right py-1 px-2 font-medium">t</th>
            <th className="text-right py-1 px-2 font-medium">米国株を除いた t</th>
            <th className="text-right py-1 px-2 font-medium">時間外R²</th>
            <th className="text-right py-1 px-2 font-medium">正の年</th>
            <th className="text-right py-1 px-2 font-medium">前半/後半の相関</th>
            <th className="text-right py-1 pl-2 font-medium">族補正p</th>
          </tr>
        </thead>
        <tbody>
          {LEAD_HORIZONS.map((h) => {
            const c = cellMap.get(`${ticker}|d1|${h}`);
            return (
              <tr key={h} className="border-b border-gray-100">
                <td className="py-1 pr-2">{HORIZON_LABEL[h]}</td>
                <td className="py-1 px-2 text-right">{c ? c.r.toFixed(3) : "…"}</td>
                <td className="py-1 px-2 text-right">{c ? fx(c.t, 2) : "…"}</td>
                <td className="py-1 px-2 text-right">{c ? fx(c.tCtrl, 2) : "…"}</td>
                <td className="py-1 px-2 text-right">{c && Number.isFinite(c.oosR2) ? `${(c.oosR2 * 100).toFixed(2)}%` : "—"}</td>
                <td className="py-1 px-2 text-right">{c ? `${c.yearsPos}/${c.years}` : "…"}</td>
                <td className="py-1 px-2 text-right">{c ? `${c.rFirst.toFixed(2)} / ${c.rSecond.toFixed(2)}` : "…"}</td>
                <td className="py-1 pl-2 text-right">{c && Number.isFinite(c.pFamily) ? c.pFamily.toFixed(3) : h === "gap" ? "対象外" : "…"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
