"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupByDay, buildBinGrid, IntradayBar } from "../../lib/intraday-core";
import {
  poolWeekdayPaths, poolWeekdayEdge, BasketPathResult, BasketEdgeResult, StockDays,
} from "../../lib/intraday-basket";
import { EdgeRankBy } from "../../lib/weekday-intraday-edge";
import { useIntradayBasket } from "../../hooks/useIntraday";
import { intervalToMin } from "./usSpilloverShared";
import {
  initCanvas, IntervalButtons, ViewTabs, LoadingError, IntradayCaveat, fmtSignedPct,
} from "./intradayShared";
import {
  drawPathStats, PathLegend, PathSummaryTable, PairDiffMatrix, PathTimeline, TimelineDay,
  usePathEvolution, PathEvolutionControls, PathDriftTable,
  PathDriftGuideSection,
} from "./intradayPathShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

type View = "path" | "edge";

const fmtHold = (bins: number, min: number) => {
  const t = bins * min;
  return t >= 60 ? `${(t / 60).toFixed(t % 60 ? 1 : 0)}h` : `${t}分`;
};

// 入力文字列を銘柄コード配列に分解(カンマ/空白区切り、重複・空白除去)。
function parseTickers(raw: string): string[] {
  return raw.split(/[,\s、]+/).map((s) => s.trim()).filter(Boolean);
}

export default function SectorBasketWeekdayChart({ ticker }: Props) {
  const [interval, setInterval] = useState("15m");
  const [view, setView] = useState<View>("path");
  const [extra, setExtra] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [rankBy, setRankBy] = useState<EdgeRankBy>("mean");
  const [showBand, setShowBand] = useState(true);
  const [showMedian, setShowMedian] = useState(false);
  const [showDist, setShowDist] = useState(false);

  const binMin = intervalToMin(interval);

  // 基準銘柄 + 追加銘柄。基準は常に先頭・削除不可。
  const tickers = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of [ticker, ...extra]) {
      const k = t.trim();
      if (k && !seen.has(k)) { seen.add(k); out.push(k); }
    }
    return out;
  }, [ticker, extra]);

  const { items, ok, loading, error } = useIntradayBasket(tickers, interval);

  const addTickers = useCallback(() => {
    const parsed = parseTickers(input);
    if (parsed.length === 0) return;
    setExtra((prev) => {
      const seen = new Set([ticker, ...prev]);
      const merged = [...prev];
      for (const t of parsed) if (!seen.has(t)) { seen.add(t); merged.push(t); }
      return merged;
    });
    setInput("");
  }, [input, ticker]);

  // 共通グリッド + 銘柄別 DayData。全銘柄の足を合わせてセッション範囲を決める。
  const prep = useMemo(() => {
    if (ok.length === 0) return null;
    const gmtoffset = ok[0].resp!.gmtoffset;
    const usable = ok.filter((it) => it.resp!.gmtoffset === gmtoffset);
    const allBars: IntradayBar[] = usable.flatMap((it) => it.resp!.bars);
    const grid = buildBinGrid(allBars, gmtoffset, binMin);
    const stocks: StockDays[] = usable.map((it) => ({
      ticker: it.ticker,
      name: it.resp!.name,
      days: groupByDay(it.resp!.bars, gmtoffset),
    }));
    return { grid, gmtoffset, stocks };
  }, [ok, binMin]);

  const pathResult: BasketPathResult | null = useMemo(() => {
    if (!prep) return null;
    return poolWeekdayPaths(prep.stocks, prep.grid, prep.gmtoffset);
  }, [prep]);

  const edgeResult: BasketEdgeResult | null = useMemo(() => {
    if (!prep) return null;
    return poolWeekdayEdge(prep.stocks, prep.grid, prep.gmtoffset, rankBy);
  }, [prep, rankBy]);

  // パス描画
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const evo = usePathEvolution(pathResult?.bins);
  useEffect(() => {
    if (view !== "path" || !pathResult || !canvasRef.current) return;
    const init = initCanvas(canvasRef.current, 260);
    if (init) drawPathStats(init.ctx, init.width, init.height, pathResult.bins, pathResult.timeLabels, pathResult.maxAbs, {
      showBand, showMedian,
      showSpaghetti: evo.showSpaghetti, showEras: evo.showEras, groupFilter: evo.groupFilter,
    });
  }, [view, pathResult, showBand, showMedian, evo.showSpaghetti, evo.showEras, evo.groupFilter]);

  // 原系列タイムライン(基準銘柄の日次終値上に曜日色●)
  const timelineDays: TimelineDay[] = useMemo(() => {
    if (!prep || prep.stocks.length === 0) return [];
    const base = prep.stocks[0];
    return base.days
      .filter((d) => d.weekday >= 1 && d.weekday <= 5)
      .map((d) => ({ date: d.date, close: d.close, key: String(d.weekday) }));
  }, [prep]);
  const colorOf = useCallback(
    (key: string) => pathResult?.bins.find((b) => String(b.weekday) === key)?.color ?? "#9ca3af",
    [pathResult]
  );

  const nStocks = ok.length;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">業種バスケット 曜日×日内（標本プール）</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>

      {/* ── バスケット構成 ── */}
      <div className="space-y-2">
        <div className="text-xs text-gray-600">
          <span className="font-medium text-gray-700">バスケット銘柄</span>
          <span className="text-gray-400">（同一業種＝日内の値動きが似ると仮定できる銘柄を足して標本を厚くする）</span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {tickers.map((t, i) => {
            const it = items.find((x) => x.ticker === t);
            const okItem = ok.find((x) => x.ticker === t);
            const isBase = i === 0;
            const bad = !!it && !!it.error;
            return (
              <span
                key={t}
                className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs border ${
                  bad ? "bg-red-50 border-red-200 text-red-600"
                  : isBase ? "bg-indigo-50 border-indigo-200 text-indigo-700"
                  : "bg-gray-50 border-gray-200 text-gray-700"
                }`}
                title={okItem?.resp?.name || (bad ? it!.error! : "")}
              >
                {isBase && <span className="text-[9px] px-1 rounded bg-indigo-600 text-white">基準</span>}
                <span className="font-medium">{t}</span>
                {bad && <span className="text-[10px]">取得不可</span>}
                {!isBase && (
                  <button
                    onClick={() => setExtra((prev) => prev.filter((x) => x !== t))}
                    className="text-gray-400 hover:text-red-600 ml-0.5"
                    aria-label="削除"
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTickers(); } }}
            placeholder="例: 8306, 8316, 8411（コード/カンマ区切り）"
            className="flex-1 min-w-0 rounded border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
          />
          <button
            onClick={addTickers}
            className="px-3 py-1 text-xs rounded font-medium bg-gray-800 text-white hover:bg-gray-700"
          >
            追加
          </button>
        </div>
      </div>

      <ViewTabs
        value={view}
        onChange={setView}
        views={[{ value: "path", label: "曜日×日内 平均パス" }, { value: "edge", label: "曜日 最良ロングウィンドウ" }]}
      />

      <LoadingError loading={loading} error={error} />
      {!loading && !error && ok.length > 0 && !pathResult && (
        <div className="text-xs text-gray-400">集計できる立会日が不足しています。</div>
      )}

      {/* ══════════ パスビュー ══════════ */}
      {view === "path" && pathResult && (
        <>
          <PathLegend stats={pathResult.bins} />
          <div className="flex items-center gap-4 flex-wrap">
            <label className="flex items-center gap-1 text-xs text-gray-600">
              <input type="checkbox" checked={showBand} onChange={(e) => setShowBand(e.target.checked)} />
              95%帯（日クラスタ頑健）
            </label>
            <label className="flex items-center gap-1 text-xs text-gray-600">
              <input type="checkbox" checked={showMedian} onChange={(e) => setShowMedian(e.target.checked)} />
              中央値パス（破線）
            </label>
          </div>
          <PathEvolutionControls stats={pathResult.bins} evo={evo} />
          <div className="relative"><canvas ref={canvasRef} /></div>

          <PathSummaryTable stats={pathResult.bins} timeLabels={pathResult.timeLabels} groupHeader="曜日" />
          <p className="text-[11px] text-gray-400">
            実線=平均・破線=中央値の日内累積リターン（{nStocks}銘柄プール）。▲=平均パスのピーク時刻（＝寄りロングの最良手仕舞い目安）／▽=ボトム時刻。
            95%帯は同一営業日の全銘柄を1クラスタとみなす頑健SEで算出（横断相関で幅が狭くなりすぎるのを防ぐ）。
            {(evo.showSpaghetti || evo.showEras) &&
              "個別日・時代分割は同一営業日の全銘柄をバスケット平均に畳んだ「1日1本」で描く（のべ銘柄×日で水増ししない）。"}
            {evo.showEras && "時代分割中は全期間平均を隠し、古い→直近ほど濃く太い線。▲▽は直近期の高安時刻。"}
          </p>

          {/* 標本の内訳: のべ / 独立日 / 実効 */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">曜日</th>
                  <th className="text-right px-2">のべ標本（銘柄×日）</th>
                  <th className="text-right px-2">独立営業日</th>
                  <th className="text-right px-2">実効標本数</th>
                  <th className="text-left px-2">プール効率</th>
                </tr>
              </thead>
              <tbody>
                {pathResult.bins.filter((b) => b.n > 0).map((b) => (
                  <tr key={b.key} className="border-b border-gray-100">
                    <td className="py-1 px-2">
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: b.color }} />
                        <span className="text-gray-700">{b.label}</span>
                      </span>
                    </td>
                    <td className="text-right px-2 text-gray-700 tabular-nums">{b.n}</td>
                    <td className="text-right px-2 text-gray-500 tabular-nums">{b.nDays}</td>
                    <td className="text-right px-2 font-medium text-gray-800 tabular-nums">{b.nEff.toFixed(1)}</td>
                    <td className="px-2 text-gray-500 tabular-nums">
                      {b.n > 0 ? `${((b.nEff / b.n) * 100).toFixed(0)}%` : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-400">
            「のべ標本」は素朴に数えた銘柄×日。同業種は同じ日に一斉に動くため独立ではなく、
            <strong>実効標本数</strong>（独立標本への換算値）が実際の情報量。プール効率が低い＝銘柄間相関が高く、
            銘柄を増やしてもnEffはあまり伸びない（帯を狭めるのは主に個別ノイズの相殺）。
          </p>

          <PairDiffMatrix stats={pathResult.bins} pairDiffs={pathResult.pairDiffs} />
          <PathDriftTable stats={pathResult.bins} timeLabels={pathResult.timeLabels} />

          {/* 銘柄別の寄与(「似ている」仮定の検証) */}
          {pathResult.perStock.length > 1 && (
            <div className="pt-3 border-t border-gray-100 space-y-2">
              <div className="text-xs font-medium text-gray-700">銘柄別 寄り→引け平均（似た動きかの確認）</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="text-left py-1 px-2">銘柄</th>
                      <th className="text-right px-2">日数</th>
                      <th className="text-right px-2">全体</th>
                      {pathResult.bins.map((b) => (
                        <th key={b.key} className="text-right px-2">{b.label.replace("曜", "")}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pathResult.perStock.map((s) => (
                      <tr key={s.ticker} className="border-b border-gray-100">
                        <td className="py-1 px-2 text-gray-700 font-medium" title={s.name}>{s.ticker}</td>
                        <td className="text-right px-2 text-gray-500">{s.nDays}</td>
                        <td className={`text-right px-2 font-medium ${s.endMean >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(s.endMean)}</td>
                        {pathResult.bins.map((b) => {
                          const v = s.perWeekday[b.weekday];
                          return (
                            <td key={b.key} className={`text-right px-2 tabular-nums ${isNaN(v) ? "text-gray-300" : v >= 0 ? "text-green-600" : "text-red-600"}`}>
                              {isNaN(v) ? "-" : fmtSignedPct(v, 1)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-gray-400">
                符号や大小が銘柄間でバラバラなら「似た動き」の仮定が崩れており、プール平均は業種代表として弱い。
                概ね同符号なら共通の曜日効果として信頼しやすい。
              </p>
            </div>
          )}

          {/* 原系列タイムライン(基準銘柄) */}
          <div className="pt-3 border-t border-gray-100 space-y-3">
            <button
              type="button"
              onClick={() => setShowDist((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-gray-900"
            >
              <span className="text-gray-400">{showDist ? "▼" : "▶"}</span>
              曜日分布の確認（基準銘柄）
            </button>
            {showDist && (
              <>
                <div className="text-xs text-gray-400">各立会日を曜日色●で基準銘柄の終値ライン上にプロット。特定曜日が一部期間に偏っていないか確認。</div>
                <PathLegend stats={pathResult.bins} withN={false} />
                <PathTimeline days={timelineDays} colorOf={colorOf} />
              </>
            )}
          </div>
        </>
      )}

      {/* ══════════ 最良ウィンドウビュー ══════════ */}
      {view === "edge" && edgeResult && (
        <>
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="text-gray-500">最良の基準:</span>
            {([{ value: "mean", label: "平均最大" }, { value: "t", label: "t値最大(頑健)" }] as { value: EdgeRankBy; label: string }[]).map((o) => (
              <button
                key={o.value}
                onClick={() => setRankBy(o.value)}
                className={`px-2 py-0.5 rounded font-medium transition-colors ${
                  rankBy === o.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">曜日</th>
                  <th className="text-right px-2">のべ</th>
                  <th className="text-right px-2">独立日</th>
                  <th className="text-right px-2">実効</th>
                  <th className="text-center px-2">買い建て</th>
                  <th className="text-center px-2">手仕舞い</th>
                  <th className="text-right px-2">保有</th>
                  <th className="text-right px-2">平均</th>
                  <th className="text-left px-2">日クラスタ95%CI</th>
                  <th className="text-right px-2">勝率</th>
                </tr>
              </thead>
              <tbody>
                {edgeResult.weekdays.map((w) => {
                  const b = w.best;
                  return (
                    <tr key={w.weekday} className="border-b border-gray-100">
                      <td className="py-1 px-2">
                        <span className="inline-flex items-center gap-1">
                          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: w.color }} />
                          <span className="text-gray-700 font-medium">{w.label}</span>
                        </span>
                      </td>
                      <td className="text-right px-2 text-gray-500">{w.nObs}</td>
                      <td className="text-right px-2 text-gray-500">{w.nDays}</td>
                      <td className="text-right px-2 font-medium text-gray-800 tabular-nums">{w.nEff.toFixed(1)}</td>
                      {b ? (
                        <>
                          <td className="text-center px-2 font-medium text-gray-700 tabular-nums">{b.entryLabel}</td>
                          <td className="text-center px-2 font-medium text-gray-700 tabular-nums">{b.exitLabel}</td>
                          <td className="text-right px-2 text-gray-500">{fmtHold(b.holdBins, binMin)}</td>
                          <td className={`text-right px-2 font-medium ${b.mean >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(b.mean)}</td>
                          <td className="px-2 text-gray-600 tabular-nums">
                            {w.ci ? (
                              <span title={`同符号率 ${(w.ci.stable * 100).toFixed(0)}%`}>
                                {fmtSignedPct(w.ci.lo, 1)}〜{fmtSignedPct(w.ci.hi, 1)}
                                {w.ci.lo > 0 || w.ci.hi < 0 ? <span className="text-green-600 font-bold"> ★</span> : null}
                              </span>
                            ) : <span className="text-gray-400">日数不足</span>}
                          </td>
                          <td className="text-right px-2 text-gray-600 tabular-nums">{(b.win * 100).toFixed(0)}%</td>
                        </>
                      ) : (
                        <td colSpan={6} className="px-2 text-gray-400">標本不足</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-400">
            全銘柄の立会日をプールし、曜日ごとに（買い建て時刻→手仕舞い時刻）の全組合せをロングで総当たりして最良ウィンドウを選出。
            95%CIは<strong>日付を丸ごと再標本する日クラスタ・ブートストラップ</strong>（同一日の全銘柄を1単位）で算出し、横断相関を壊さない。
            CIが0をまたがない（★）曜日が、プール後も残る候補。実効標本数が小さい行は見かけのnObsに惑わされないこと。
          </p>
        </>
      )}

      <IntradayCaveat extra="複数銘柄の日中足を同一営業日で束ねてプール。株価水準差は始値基準の対数リターンで吸収。異業種を混ぜると仮定が崩れる。" />

      <AnalysisGuide title="業種バスケット・プールの詳細理論">
        <p className="font-medium text-gray-700">1. 何を・なぜ</p>
        <p>
          {"5/15/30分足は約60営業日しか取れず、単一銘柄の曜日別は各12日前後と薄い。そこで同一業種(例: 銀行株)の複数銘柄は共通ファクターに乗って日内の値動きが似る、という仮定のもとで標本を混ぜ、曜日×日内パターンの推定を安定させる。目的は『曜日ごとに何時に建て何時に手仕舞うと日中リターンが最大か』を、単一銘柄より頑健に求めること。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"各銘柄・各立会日について、寄り基準の累積対数リターン r(t)=ln(P_t/始値) を共通の時間格子上で算出。株価水準の違う銘柄も比率(対数リターン)なので直接プールできる。"}</li>
          <li>{"曜日ごとに全銘柄×全日をプールし、各時刻の平均・中央値パスを取る。"}</li>
          <li>{"平均の標準誤差(SE)は日付クラスタに頑健な推定量で算出: Var(μ)=(1/N²)·Σ_d(Σ_{i∈d}(x_i−μ))²。同一営業日 d の全銘柄を1クラスタとして残差和を2乗合算する。素朴なσ/√Nは同日銘柄を独立と誤認して帯が狭くなりすぎる。"}</li>
          <li>{"最良ロングウィンドウの95%信頼区間は、日付を復元抽出する日クラスタ・ブートストラップ(同一日の全銘柄トレードを1束として再標本)で推定。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>横断相関</strong>: 同じ日に同業種の銘柄が一斉に同方向へ動く性質。これがあると銘柄を増やしても独立な情報は増えにくい。</li>
          <li><strong>実効標本数 nEff</strong>: のべ標本N(銘柄×日)を「独立標本なら何個ぶんか」に換算した数。nEff = (iid仮定の平均分散)/(クラスタ頑健分散)×N で計算し、1〜Nに収まる。銘柄間相関が高いほどnEffはNより大きく下回る。</li>
          <li><strong>クラスタ頑健SE</strong>: 同一日の観測をひとまとめに扱い、日内相関を吸収した標準誤差。プールした帯・p値・CIの信頼性の要。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>「曜日×日内 平均パス」でピーク▲時刻＝寄りロングの手仕舞い目安、ボトム▽時刻＝押し目買いの目安を業種平均として読む。</li>
          <li>「最良ロングウィンドウ」で曜日ごとの具体的な建て/手仕舞い時刻を得る。日クラスタCIが0をまたがない曜日だけを実運用の候補に絞る。</li>
          <li>実効標本数が十分に大きい曜日ほど推定は信頼できる。トレード対象の中核銘柄を基準に、値動きの似た同業種を2〜4銘柄足すのが目安。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"プールで下がるのは個別ノイズ由来のSEであって、日ごとの系統変動ではない。『標本がN倍』ではなく『業種平均パスの推定精度が上がる』と割り切る(実効標本数を必ず確認)。"}</li>
          <li>{"『似ている』は仮定。銘柄別テーブルで符号・大小がバラつく場合はプール平均を業種代表として使わない。異業種の混入は特に禁物。"}</li>
          <li>{"最良ウィンドウは総当たり選択のため見栄えの良い区間が必ず選ばれる(選択バイアス)。日クラスタCIと実効標本数で必ず割り引く。"}</li>
          <li>{"銘柄ごとにボラが大きく異なると高ボラ銘柄が平均を支配する。似たボラ帯の銘柄で組むのが無難。"}</li>
          <li>{"Yahoo日中足は約15分遅延・取得期間に上限あり。取引コスト・スリッページ・昼休みをまたぐ保有の非約定時間は未考慮。"}</li>
        </ul>
        <PathDriftGuideSection />
      </AnalysisGuide>
    </div>
  );
}
