"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import AnalysisGuide from "./AnalysisGuide";
import { buildEdgeCatalog } from "../../lib/edge-trades";
import {
  loadLedger,
  freezeEdge,
  removeEntry,
  evaluateEntry,
  type LedgerEntry,
  type LedgerEval,
  type LedgerVerdict,
} from "../../lib/prospective-ledger";

interface Props {
  prices: PricePoint[];
  ticker: string;
}

const VERDICT_LABEL: Record<LedgerVerdict, { text: string; cls: string }> = {
  alive: { text: "健在確定", cls: "bg-green-50 text-green-700 border-green-200" },
  dead: { text: "消滅確定", cls: "bg-red-50 text-red-700 border-red-200" },
  undecided: { text: "未決", cls: "bg-gray-50 text-gray-600 border-gray-200" },
  waiting: { text: "データ待ち", cls: "bg-amber-50 text-amber-700 border-amber-200" },
};

export default function ProspectiveLedgerChart({ prices, ticker }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [freezeEdgeId, setFreezeEdgeId] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [message, setMessage] = useState<string>("");

  useEffect(() => { setEntries(loadLedger()); }, []);

  const catalog = useMemo(() => buildEdgeCatalog(prices), [prices]);
  const effectiveFreezeId = freezeEdgeId || (catalog[0]?.id ?? "");

  // 現在銘柄のエントリだけ、今のデータで採点する
  const evals = useMemo(() => {
    const map = new Map<string, LedgerEval>();
    for (const e of entries) {
      if (e.ticker !== ticker) continue;
      const ev = evaluateEntry(e, catalog);
      if (ev) map.set(e.id, ev);
    }
    return map;
  }, [entries, ticker, catalog]);

  const selectedEval = useMemo(() => {
    if (selectedId && evals.has(selectedId)) return evals.get(selectedId)!;
    const first = entries.find((e) => e.ticker === ticker && evals.has(e.id));
    return first ? evals.get(first.id)! : null;
  }, [selectedId, evals, entries, ticker]);

  const hasChart = !!selectedEval && selectedEval.equity.length > 1;

  // チャートはコンテナが条件付きレンダリングのため、出現フラグを依存に含めて生成する
  useEffect(() => {
    if (!hasChart || !containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 220,
      crosshair: { mode: 0 },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;
    seriesRef.current = chart.addSeries(LineSeries, { color: "#2563eb", lineWidth: 2, title: "OOSエクイティ" });
    seriesRef.current.createPriceLine({ price: 1, color: "#d1d5db", lineWidth: 1, lineStyle: LineStyle.Dotted, title: "" });
    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }); };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null; seriesRef.current = null;
    };
  }, [hasChart]);

  useEffect(() => {
    if (!seriesRef.current || !selectedEval) return;
    seriesRef.current.setData(selectedEval.equity.map((p) => ({ time: p.date as Time, value: p.value })));
    chartRef.current?.timeScale().fitContent();
  }, [selectedEval]);

  const onFreeze = () => {
    const edge = catalog.find((e) => e.id === effectiveFreezeId);
    if (!edge) return;
    const dup = entries.find((e) => e.ticker === ticker && e.edgeId === edge.id);
    if (dup) {
      setMessage(`${edge.label} は ${dup.frozenAt} に凍結済みです(重複凍結は境界が動くだけで意味がありません)。`);
      return;
    }
    const entry = freezeEdge(ticker, edge);
    if (entry) {
      setEntries(loadLedger());
      setSelectedId(entry.id);
      setMessage(`凍結しました: ${edge.label}(境界 ${entry.freezeDataEnd})。明日以降の新データだけで採点されます。`);
    }
  };

  const onRemove = (id: string) => {
    removeEntry(id);
    setEntries(loadLedger());
  };

  if (prices.length < 300) {
    return <div className="text-xs text-gray-400 p-3">データが不足しています(300営業日以上必要)。</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">前向き検証台帳 — 凍結して、未来のデータだけで採点する</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          臨床試験の事前登録の投資版。エッジを今日の日付で凍結し、以後に到着した新しいデータのみで成績とSPRT判定を更新する。
          バックテストと違い、この成績には後知恵が一切混ざらない。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          凍結するエッジ
          <select className="border rounded px-1 py-0.5" value={effectiveFreezeId} onChange={(e) => setFreezeEdgeId(e.target.value)}>
            {catalog.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <button onClick={onFreeze} className="px-3 py-1 rounded bg-blue-600 text-white font-medium hover:bg-blue-700">
          {ticker} で凍結
        </button>
        {message && <span className="text-gray-500">{message}</span>}
      </div>

      {entries.length === 0 ? (
        <div className="text-xs text-gray-400 p-3 bg-gray-50 rounded">
          台帳は空です。エッジを凍結すると、ここに行が追加され、以後アプリを開くたびに「凍結後の新データだけ」で成績が更新されていきます。
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 px-1.5">銘柄</th>
                <th className="text-left px-1.5">エッジ</th>
                <th className="text-left px-1">凍結日</th>
                <th className="text-right px-1">IS Sharpe</th>
                <th className="text-right px-1">OOS n</th>
                <th className="text-right px-1">OOS μ/取引</th>
                <th className="text-right px-1">OOS Sharpe</th>
                <th className="text-right px-1">OOS累積</th>
                <th className="text-center px-1.5">SPRT判定</th>
                <th className="px-1" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const ev = evals.get(e.id) ?? null;
                const mine = e.ticker === ticker;
                const isSel = selectedEval?.entry.id === e.id;
                const verdict = ev ? VERDICT_LABEL[ev.verdict] : null;
                return (
                  <tr
                    key={e.id}
                    onClick={() => mine && setSelectedId(e.id)}
                    className={`border-b border-gray-100 ${mine ? "cursor-pointer" : "opacity-50"} ${isSel ? "bg-blue-50" : mine ? "hover:bg-gray-50" : ""}`}
                  >
                    <td className="py-1 px-1.5 font-mono">{e.ticker}</td>
                    <td className="px-1.5">{e.edgeLabel}（{e.direction === "long" ? "買" : "売"}）</td>
                    <td className="px-1 font-mono text-gray-500">{e.frozenAt}</td>
                    <td className="text-right px-1 font-mono text-gray-500">{e.sharpeIS.toFixed(2)}</td>
                    {ev ? (
                      <>
                        <td className="text-right px-1 font-mono">{ev.nOOS}</td>
                        <td className={`text-right px-1 font-mono ${ev.muOOS > 0 ? "text-green-600" : "text-red-600"}`}>{(ev.muOOS * 100).toFixed(3)}%</td>
                        <td className="text-right px-1 font-mono">{ev.sharpeOOS.toFixed(2)}</td>
                        <td className={`text-right px-1 font-mono ${ev.cumOOS > 0 ? "text-green-600" : "text-red-600"}`}>{(ev.cumOOS * 100).toFixed(1)}%</td>
                        <td className="text-center px-1.5">
                          <span className={`inline-block rounded border px-1.5 py-0.5 ${verdict!.cls}`}>{verdict!.text}</span>
                        </td>
                      </>
                    ) : (
                      <td colSpan={5} className="px-1.5 text-gray-400">{mine ? "評価不能(エッジ定義が変更された可能性)" : "この銘柄を検索すると採点されます"}</td>
                    )}
                    <td className="text-right px-1">
                      <button
                        onClick={(ev2) => { ev2.stopPropagation(); onRemove(e.id); }}
                        className="text-gray-300 hover:text-red-500"
                        title="台帳から削除"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasChart && selectedEval && (
        <div>
          <div className="text-xs text-gray-500 mb-1">
            {selectedEval.entry.edgeLabel} の凍結後エクイティ（境界 {selectedEval.entry.freezeDataEnd} より後の取引のみ・点線=元本）
            — SPRT logLR {selectedEval.logLR.toFixed(2)}（健在確定 {selectedEval.sprtUpper.toFixed(1)} / 消滅確定 {selectedEval.sprtLower.toFixed(1)}）
          </div>
          <div ref={containerRef} className="w-full rounded border border-gray-100" />
        </div>
      )}

      <AnalysisGuide title="前向き検証台帳の詳細理論">
        <p className="font-medium text-gray-700">1. なぜ必要か</p>
        <p>
          バックテストの成績は、どれだけ丁寧に補正しても「同じ過去データの中で発見と検証を繰り返した」産物です。
          FDR補正・DSR・ウォークフォワードは偽発見を減らしますが、ゼロにはできません。唯一混じり気のない検証は、
          <span className="font-medium">仮説を日付とともに固定し、その時点で存在しなかったデータだけで採点する</span>ことです。
          医学研究が臨床試験の事前登録(pre-registration)を義務化したのと同じ理屈で、これは「事後的に都合の良い
          仮説へ差し替える」道を物理的に塞ぎます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 仕組み</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>「凍結」ボタンで、エッジの定義・方向・IS統計量(μ_IS, σ_IS)と<span className="font-medium">凍結時点の最終取引日(境界)</span>をブラウザに保存します。</li>
          <li>以後この画面を開くたび、境界より後に成立した取引だけでOOS成績を再計算します。境界以前のデータは金輪際、成績に算入されません。</li>
          <li>判定には凍結時のμ_IS・σ_ISを使ったSPRT(逐次確率比検定)を用います。毎日覗いても誤り率が壊れない(anytime-valid)ため、日々の監視に耐えます。数式はエッジ減衰・死亡検知の解説を参照。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">データ待ち:</span> 凍結直後。取引が成立するまで成績はつきません(週次エッジなら数週間かかります)。</li>
          <li><span className="font-medium">未決:</span> まだ証拠不足。OOSのμがIS並みならlogLRは着実に上がっていきます。</li>
          <li><span className="font-medium">健在確定 / 消滅確定:</span> 誤り率5%管理下での判決。バックテスト上のどんな指標よりも重い証拠です。</li>
          <li>IS SharpeとOOS Sharpeの比較が「後知恵の割引率」の実測値になります。多くの研究でOOSはISの5〜7割に減衰します。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>実弾を入れる前に、候補エッジをまず凍結して数か月「紙上運用」する。健在方向に証拠が積み上がってから資金を入れる。</li>
          <li>複数エッジを同時に凍結して比較するのは正当(それぞれ独立に前向き採点されるため)。ただし「良かったものだけ後から選ぶ」なら、その選択自体の多重性は自分で意識すること。</li>
          <li>採用中のエッジが消滅確定になったら撤退——という規律を、凍結時に決めておくのが理想です。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>台帳はこのブラウザのlocalStorageに保存されます。ブラウザを変える・履歴を消すと台帳も消えます。</li>
          <li>正準エッジ(寄/引執行の代表型)のみ凍結できます。任意のカスタム戦略の凍結は対象外です。</li>
          <li>成績は約定できた前提のグロス値です。実効値はエッジ割引(スプレッド・マーク乖離)と容量推定を併読してください。</li>
          <li>凍結が誠実でも、「凍結する候補を過去データで選んだ」事実は消えません。前向き検証は最後の関門であって、免罪符ではありません。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
