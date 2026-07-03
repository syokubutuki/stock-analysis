"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import {
  computeWeekdayIntradayEdge, nextSessionWeekday,
  WeekdayIntradayEdgeResult, EdgeRankBy,
} from "../../lib/weekday-intraday-edge";
import { groupByDay, buildBinGrid } from "../../lib/intraday-core";
import { blockBootstrapCI } from "../../lib/stats-significance";
import { useIntraday } from "../../hooks/useIntraday";
import { intervalToMin } from "./usSpilloverShared";
import {
  initCanvas, IntervalButtons, LoadingError, IntradayCaveat, fmtSignedPct,
} from "./intradayShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

// エントリー時刻(縦) × エグジット時刻(横)のロング平均リターン・ヒートマップ。
// 時間軸方向のズームが価値を持たない静的な三角行列なのでCanvas2D。
function drawHeatmap(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  matrix: (number | null)[][], labels: string[], maxAbs: number,
  best: { i: number; j: number } | null
) {
  const G = labels.length;
  const ml = 44, mr = 10, mt = 18, mb = 26;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const cw = plotW / G, ch = plotH / G;

  for (let i = 0; i < G; i++) {
    for (let j = 0; j < G; j++) {
      const v = matrix[i][j];
      if (v == null) continue;
      const inten = Math.min(1, Math.abs(v) / maxAbs);
      const a = (0.12 + 0.88 * inten).toFixed(3);
      ctx.fillStyle = v >= 0 ? `rgba(22,163,74,${a})` : `rgba(220,38,38,${a})`;
      ctx.fillRect(ml + j * cw, mt + i * ch, Math.ceil(cw) + 0.5, Math.ceil(ch) + 0.5);
    }
  }
  if (best) {
    ctx.strokeStyle = "#111827"; ctx.lineWidth = 2;
    ctx.strokeRect(ml + best.j * cw, mt + best.i * ch, cw, ch);
  }

  // 軸ラベル
  ctx.fillStyle = "#6b7280"; ctx.font = "8px sans-serif";
  ctx.textAlign = "right";
  const everyY = G > 16 ? Math.ceil(G / 14) : 1;
  for (let i = 0; i < G; i++) { if (i % everyY) continue; ctx.fillText(labels[i], ml - 3, mt + i * ch + ch / 2 + 3); }
  ctx.textAlign = "center";
  const everyX = G > 16 ? Math.ceil(G / 12) : 1;
  for (let j = 0; j < G; j++) { if (j % everyX) continue; ctx.fillText(labels[j], ml + j * cw + cw / 2, H - mb + 10); }
  ctx.fillStyle = "#9ca3af"; ctx.textAlign = "left";
  ctx.fillText("縦=買い建て時刻 ／ 横=手仕舞い時刻（緑=ロング平均プラス／赤=マイナス、枠=最良）", ml, mt - 7);
}

const RANK_OPTS: { value: EdgeRankBy; label: string }[] = [
  { value: "mean", label: "平均最大" },
  { value: "t", label: "t値最大(頑健)" },
];

const fmtHold = (bins: number, min: number) => {
  const t = bins * min;
  return t >= 60 ? `${(t / 60).toFixed(t % 60 ? 1 : 0)}h` : `${t}分`;
};

export default function WeekdayIntradayEdgeChart({ ticker }: Props) {
  const [interval, setInterval] = useState("30m");
  const [rankBy, setRankBy] = useState<EdgeRankBy>("mean");
  const { resp, loading, error } = useIntraday(ticker, interval);

  const nextWd = useMemo(() => nextSessionWeekday(new Date()), []);
  const [selectedWd, setSelectedWd] = useState<number>(nextWd);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 最良ウィンドウの累積時系列(ズーム/パン可能な lightweight-charts)
  const eqContainerRef = useRef<HTMLDivElement>(null);
  const eqChartRef = useRef<IChartApi | null>(null);
  const eqSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  const binMin = intervalToMin(interval);

  const result: WeekdayIntradayEdgeResult | null = useMemo(() => {
    if (!resp || resp.bars.length === 0) return null;
    const days = groupByDay(resp.bars, resp.gmtoffset);
    const grid = buildBinGrid(resp.bars, resp.gmtoffset, binMin);
    return computeWeekdayIntradayEdge(days, grid, resp.gmtoffset, { rankBy });
  }, [resp, binMin, rankBy]);
  const showResult = !!result;

  const selected = result?.weekdays.find((w) => w.weekday === selectedWd) ?? null;

  // ヒートマップ描画
  useEffect(() => {
    if (!selected || !canvasRef.current) return;
    const G = result!.timeLabels.length;
    const hpx = Math.max(220, Math.min(460, 46 + G * 13));
    const init = initCanvas(canvasRef.current, hpx);
    if (init) drawHeatmap(init.ctx, init.width, init.height, selected.matrix, result!.timeLabels, result!.maxAbsMatrix, selected.best);
  }, [selected, result]);

  // 累積時系列チャート初期化(コンテナがDOMに出現したら生成)
  useEffect(() => {
    if (!showResult || !eqContainerRef.current) return;
    const chart = createChart(eqContainerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: eqContainerRef.current.clientWidth,
      height: 220,
      crosshair: { mode: 0 },
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false, secondsVisible: false },
    });
    eqChartRef.current = chart;
    eqSeriesRef.current = chart.addSeries(LineSeries, { color: "#7c3aed", lineWidth: 2, title: "累積(最良ウィンドウ)" });

    const onResize = () => {
      if (eqContainerRef.current) chart.applyOptions({ width: eqContainerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      eqChartRef.current = null;
      eqSeriesRef.current = null;
    };
  }, [showResult]);

  // 選択曜日の最良ウィンドウの累積リターン(％)を更新
  useEffect(() => {
    const series = eqSeriesRef.current;
    if (!series) return;
    if (!selected || selected.trades.length === 0) { series.setData([]); return; }
    series.applyOptions({ color: selected.color });
    let cum = 0;
    series.setData(
      selected.trades.map((t) => { cum += t.ret; return { time: t.date as Time, value: cum * 100 }; })
    );
    if (eqContainerRef.current && eqContainerRef.current.clientWidth > 0) {
      eqChartRef.current?.applyOptions({ width: eqContainerRef.current.clientWidth });
    }
    eqChartRef.current?.timeScale().fitContent();
  }, [selected]);

  // 最良ウィンドウのブロックブートストラップ95%CI(選択曜日のみ、系列相関に頑健)
  const ci = useMemo(() => {
    if (!selected || selected.trades.length < 5) return null;
    return blockBootstrapCI(selected.trades.map((t) => t.ret));
  }, [selected]);

  const WD_KANJI: Record<number, string> = { 1: "月", 2: "火", 3: "水", 4: "木", 5: "金" };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">曜日 × 日内タイミング エッジスキャン</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>
      <div className="flex items-center gap-4 flex-wrap text-xs">
        <div className="flex items-center gap-1">
          <span className="text-gray-500">最良の基準:</span>
          {RANK_OPTS.map((o) => (
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
        <span className="text-gray-400">
          次に売買する立会（推定）: <span className="font-medium text-indigo-600">{WD_KANJI[nextWd]}曜</span>
        </span>
      </div>

      <LoadingError loading={loading} error={error} />
      {!loading && !error && resp && !result && (
        <div className="text-xs text-gray-400">集計できる立会日が不足しています。</div>
      )}

      {result && (
        <>
          {/* ── 一覧: 各曜日の最良ロングウィンドウ ── */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">曜日</th>
                  <th className="text-right px-2">日数</th>
                  <th className="text-center px-2">買い建て</th>
                  <th className="text-center px-2">手仕舞い</th>
                  <th className="text-right px-2">保有</th>
                  <th className="text-right px-2">平均</th>
                  <th className="text-left px-2">勝率</th>
                  <th className="text-left px-2">有意性(FDR)</th>
                </tr>
              </thead>
              <tbody>
                {result.weekdays.map((w) => {
                  const b = w.best;
                  const isNext = w.weekday === nextWd;
                  return (
                    <tr
                      key={w.weekday}
                      onClick={() => setSelectedWd(w.weekday)}
                      className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${
                        selectedWd === w.weekday ? "bg-indigo-50" : ""
                      }`}
                    >
                      <td className="py-1 px-2">
                        <span className="inline-flex items-center gap-1">
                          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: w.color }} />
                          <span className="text-gray-700 font-medium">{w.label}</span>
                          {isNext && <span className="text-[9px] px-1 rounded bg-indigo-600 text-white">次</span>}
                        </span>
                      </td>
                      <td className="text-right px-2 text-gray-600">{w.nDays}</td>
                      {b ? (
                        <>
                          <td className="text-center px-2 font-medium text-gray-700 tabular-nums">{b.entryLabel}</td>
                          <td className="text-center px-2 font-medium text-gray-700 tabular-nums">{b.exitLabel}</td>
                          <td className="text-right px-2 text-gray-500">{fmtHold(b.holdBins, binMin)}</td>
                          <td className={`text-right px-2 font-medium ${b.mean >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(b.mean)}</td>
                          <td className="px-2 text-gray-600 tabular-nums">{(b.win * 100).toFixed(0)}%</td>
                          <td className="px-2"><StatBadge n={b.n} p={b.pAdj} significant={b.pAdj < 0.05} minN={12} /></td>
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
            各曜日について、日内の全（買い建て時刻→手仕舞い時刻）の組合せをロングで総当たりし、最も
            {rankBy === "t" ? "t値" : "平均リターン"}の大きいウィンドウを表示。行クリックで下の詳細を切替。
            有意性は全曜日×全ウィンドウ {result.nTested} 通りをFDR補正した後のp値。
          </p>

          {/* ── 詳細: 選択曜日のヒートマップ + 累積時系列 ── */}
          <div className="pt-3 border-t border-gray-100 space-y-3">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className="font-medium text-gray-700">詳細を見る曜日:</span>
              {result.weekdays.map((w) => (
                <button
                  key={w.weekday}
                  onClick={() => setSelectedWd(w.weekday)}
                  className={`px-2 py-0.5 rounded font-medium transition-colors ${
                    selectedWd === w.weekday ? "text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                  style={selectedWd === w.weekday ? { backgroundColor: w.color } : undefined}
                >
                  {w.label}
                </button>
              ))}
            </div>

            {selected && selected.best ? (
              <>
                <div className="rounded-md border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-gray-700">
                  <span className="font-bold" style={{ color: selected.color }}>{selected.label}</span> の最良ロング:
                  <span className="font-bold text-gray-800"> {selected.best.entryLabel}</span> に買い建て →
                  <span className="font-bold text-gray-800"> {selected.best.exitLabel}</span> に手仕舞い
                  （保有 {fmtHold(selected.best.holdBins, binMin)}）。
                  平均 <span className={`font-bold ${selected.best.mean >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(selected.best.mean)}</span>
                  ・勝率 {(selected.best.win * 100).toFixed(0)}%・n={selected.best.n}日
                  {ci && (
                    <>（95%CI {fmtSignedPct(ci.lo)}〜{fmtSignedPct(ci.hi)}・同符号 {(ci.stable * 100).toFixed(0)}%）</>
                  )}
                </div>

                <div className="text-xs text-gray-500">日内タイミング俯瞰（ヒートマップ）</div>
                <div className="relative"><canvas ref={canvasRef} /></div>

                <div className="text-xs text-gray-500">
                  最良ウィンドウの累積リターン（％・暦時間軸、ホイールでズーム／ドラッグでパン）
                </div>
                <div ref={eqContainerRef} className="w-full rounded border border-gray-100" />
                <p className="text-[11px] text-gray-400">
                  累積が右肩上がりで一定なら、その曜日・時間帯のロングエッジは全期間で安定。一部期間だけで
                  稼いで横ばいなら、その時期のレジームが作った見かけのエッジの可能性。
                </p>
              </>
            ) : (
              <p className="text-xs text-gray-400">この曜日は有効なウィンドウがありません。</p>
            )}
          </div>
        </>
      )}

      <IntradayCaveat extra="各時刻ビンの終値で（買い建て時刻→手仕舞い時刻）のロング1トレードを評価。同日内で完結し、オーバーナイトは含めない。" />

      <AnalysisGuide title="曜日×日内タイミング エッジスキャンの詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"『金曜は日中プラス』のような日次の曜日アノマリーは“1日を1つの数字（始値→終値）”に潰しているため、日内のどの時間帯で稼いでいるかまでは分からない。本分析は各曜日について、立会時間を時間格子に刻み、『何時に買って何時に手仕舞うか』の全ての組合せをロングで総当たり集計する。これにより、曜日ごとに最も大きなリターンが得られる具体的なエントリー/エグジット時刻を特定する。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"各立会日を時間格子に写像し、各時刻ビンの終値 P_t を得る（バーの無いビンは直前値で前方補完）。"}</li>
          <li>{"買い建て時刻 i と手仕舞い時刻 j（i<j）の全組合せについて、ロング1トレードの対数リターン r = ln(P_j / P_i) を、その曜日の全立会日で平均する。"}</li>
          <li>{"各ウィンドウで平均=0 の1標本t検定を行い、全曜日×全ウィンドウをまとめて Benjamini-Hochberg 法でFDR（偽発見率）補正する。"}</li>
          <li>{"各曜日の『最良ウィンドウ』は、補正基準（平均最大 or t値最大）で選ぶ。最良ウィンドウの各立会日リターンは累積時系列（エクイティカーブ）として暦時間軸に描く。"}</li>
          <li>{"最良ウィンドウの平均は、系列相関に頑健な移動ブロック・ブートストラップで95%信頼区間も推定する。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ウィンドウ</strong>: 「買い建て時刻→手仕舞い時刻」で区切った日内の保有区間。同じ営業日内で完結する。</li>
          <li><strong>ヒートマップ</strong>: 縦軸＝買い建て時刻、横軸＝手仕舞い時刻。セルの色がそのウィンドウのロング平均（緑=プラス／赤=マイナス、濃いほど大）。黒枠が最良ウィンドウ。上三角のみ有効（手仕舞いは建てより後）。</li>
          <li><strong>FDR補正</strong>: 多数のウィンドウを試すと偶然プラスに見えるものが必ず出る。それを割り引いた後のp値。</li>
          <li><strong>同符号率</strong>: ブートストラップ再標本の平均が点推定と同じ符号だった割合。高いほど符号が安定。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>一覧の「次」バッジは現在時刻から推定した次に売買する立会曜日。まずその行の最良ウィンドウ（買い建て/手仕舞い時刻）を執行計画の叩き台にする。</li>
          <li>ヒートマップで緑の濃い塊が「寄り付近で建て→前場で手仕舞い」等どの領域に出るかを見る。塊で広く緑なら頑健、点でだけ濃いなら過適合を疑う。</li>
          <li>累積時系列が全期間で緩やかに右肩上がりなら実運用で信頼しやすい。一部期間の急騰で稼いで横ばいなら、その時期限定のレジーム効果の可能性。</li>
          <li>有意性が「参考」かつ勝率が50%近辺なら、そのウィンドウは実質エッジ無しとみなす。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"最良ウィンドウは総当たりで選ぶため、たとえランダムなデータでも最も見栄えの良い区間が必ず選ばれる（選択バイアス）。FDR補正後p値・95%CI・累積の安定性を必ず併読する。"}</li>
          <li>{"Yahoo日中足は約15分遅延・取得期間に上限（5/15/30分足≈60日→曜日別は各約8日と非常に薄い、60分足≈2年）。細かい足×少ない曜日日数では最良ウィンドウは特に不安定。"}</li>
          <li>{"各時刻ビンの終値ベースで、取引コスト・スリッページ・寄り/引けの板の薄さは未考慮。短い保有ほどコスト影響が相対的に大きい。"}</li>
          <li>{"時間格子はデータ実測のセッション範囲から作る。東証の前場/後場の昼休みは連続扱いになる（昼休みをまたぐ保有は実際には約定できない時間を含む）点に留意。"}</li>
          <li>{"ロングのみを評価。最良でも平均がマイナスなら、その曜日は日中に買いのエッジが無い（売り/見送りを検討）。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
