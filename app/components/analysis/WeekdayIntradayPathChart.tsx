"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { computeWeekdayPaths, WeekdayPathResult } from "../../lib/weekday-intraday-path";
import { groupByDay, buildBinGrid } from "../../lib/intraday-core";
import { useIntraday } from "../../hooks/useIntraday";
import { intervalToMin } from "./usSpilloverShared";
import {
  initCanvas, IntervalButtons, LoadingError, IntradayCaveat, fmtSignedPct, drawTimeAxisLabels,
} from "./intradayShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

// 曜日別の日内平均累積パス(時間軸方向の“形” → 固定短区間の平均プロファイルなのでCanvas2D)
function drawPaths(
  ctx: CanvasRenderingContext2D, W: number, H: number, res: WeekdayPathResult, showBand: boolean
) {
  const ml = 44, mr = 10, mt = 10, mb = 22;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const G = res.timeLabels.length;
  if (G < 2) return;
  const yMax = res.maxAbs * 1.05;
  const X = (g: number) => ml + (g / (G - 1)) * plotW;
  const Y = (v: number) => mt + (1 - (v + yMax) / (2 * yMax)) * plotH;

  // グリッド + ゼロ線
  ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();

  // 縦軸目盛
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(fmtSignedPct(yMax, 1), ml - 3, mt + 8);
  ctx.fillText("0", ml - 3, Y(0) + 3);
  ctx.fillText(fmtSignedPct(-yMax, 1), ml - 3, mt + plotH);

  // バンド
  if (showBand) {
    for (const b of res.bins) {
      if (b.n === 0) continue;
      ctx.fillStyle = b.color + "22";
      ctx.beginPath();
      for (let g = 0; g < G; g++) ctx.lineTo(X(g), Y(b.hi[g]));
      for (let g = G - 1; g >= 0; g--) ctx.lineTo(X(g), Y(b.lo[g]));
      ctx.closePath(); ctx.fill();
    }
  }

  // 平均パス
  for (const b of res.bins) {
    if (b.n === 0) continue;
    ctx.strokeStyle = b.color; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let g = 0; g < G; g++) { const x = X(g), y = Y(b.path[g]); if (g === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  }

  drawTimeAxisLabels(ctx, res.timeLabels, ml, plotW / G, H - 6);
}

export default function WeekdayIntradayPathChart({ ticker }: Props) {
  const [interval, setInterval] = useState("15m");
  const [showBand, setShowBand] = useState(true);
  const { resp, loading, error } = useIntraday(ticker, interval);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 曜日別 × 原系列タイムライン(ズーム/パン可能な lightweight-charts)
  const tlContainerRef = useRef<HTMLDivElement>(null);
  const tlChartRef = useRef<IChartApi | null>(null);
  const tlSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const tlMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const result: WeekdayPathResult | null = useMemo(() => {
    if (!resp || resp.bars.length === 0) return null;
    const days = groupByDay(resp.bars, resp.gmtoffset);
    const grid = buildBinGrid(resp.bars, resp.gmtoffset, intervalToMin(interval));
    return computeWeekdayPaths(days, grid, resp.gmtoffset);
  }, [resp, interval]);
  const showResult = !!result;

  useEffect(() => {
    if (!result || !canvasRef.current) return;
    const init = initCanvas(canvasRef.current, 260);
    if (init) drawPaths(init.ctx, init.width, init.height, result, showBand);
  }, [result, showBand]);

  // タイムラインチャート初期化(コンテナがDOMに出現したら生成)
  useEffect(() => {
    if (!showResult || !tlContainerRef.current) return;
    const chart = createChart(tlContainerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: tlContainerRef.current.clientWidth,
      height: 240,
      crosshair: { mode: 0 },
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false, secondsVisible: false },
    });
    tlChartRef.current = chart;
    const series = chart.addSeries(LineSeries, { color: "#cbd5e1", lineWidth: 1, title: "原系列(終値)" });
    tlSeriesRef.current = series;
    tlMarkersRef.current = createSeriesMarkers(series, []);

    const onResize = () => {
      if (tlContainerRef.current) chart.applyOptions({ width: tlContainerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      tlChartRef.current = null;
      tlSeriesRef.current = null;
      tlMarkersRef.current = null;
    };
  }, [showResult]);

  // タイムラインのデータ＆曜日色マーカー更新
  useEffect(() => {
    const series = tlSeriesRef.current;
    if (!series) return;
    if (!result || result.days.length === 0) {
      series.setData([]);
      tlMarkersRef.current?.setMarkers([]);
      return;
    }
    series.setData(
      result.days.filter((d) => d.close > 0).map((d) => ({ time: d.date as Time, value: d.close }))
    );
    const colorOf = (wd: number) => result.bins.find((b) => b.weekday === wd)?.color ?? "#9ca3af";
    const markers: SeriesMarker<Time>[] = result.days.map((d) => ({
      time: d.date as Time,
      position: "inBar",
      color: colorOf(d.weekday),
      shape: "circle",
      size: 1,
    }));
    tlMarkersRef.current?.setMarkers(markers);
    if (tlContainerRef.current && tlContainerRef.current.clientWidth > 0) {
      tlChartRef.current?.applyOptions({ width: tlContainerRef.current.clientWidth });
    }
    tlChartRef.current?.timeScale().fitContent();
  }, [result]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">曜日 × 当日日内 平均累積パス</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        <label className="flex items-center gap-1 text-xs text-gray-600">
          <input type="checkbox" checked={showBand} onChange={(e) => setShowBand(e.target.checked)} />
          95%帯
        </label>
      </div>

      <LoadingError loading={loading} error={error} />
      {!loading && !error && resp && !result && (
        <div className="text-xs text-gray-400">集計できる立会日が不足しています。</div>
      )}

      {result && (
        <>
          {/* 凡例 */}
          <div className="flex items-center gap-3 flex-wrap text-[11px]">
            {result.bins.map((b) => (
              <span key={b.weekday} className="inline-flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: b.color }} />
                <span className="text-gray-600">{b.label}（n={b.n}）</span>
              </span>
            ))}
          </div>

          <div className="relative"><canvas ref={canvasRef} /></div>

          {/* 寄り→引け サマリー */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">曜日</th>
                  <th className="text-right px-2">日数</th>
                  <th className="text-right px-2">寄り→引け平均</th>
                  <th className="text-left px-2">有意性</th>
                </tr>
              </thead>
              <tbody>
                {result.bins.filter((b) => b.n > 0).map((b) => (
                  <tr key={b.weekday} className="border-b border-gray-100">
                    <td className="py-1 px-2">
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: b.color }} />
                        <span className="text-gray-700">{b.label}</span>
                      </span>
                    </td>
                    <td className="text-right px-2 text-gray-600">{b.n}</td>
                    <td className={`text-right px-2 font-medium ${b.endMean >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(b.endMean)}</td>
                    <td className="px-2"><StatBadge n={b.n} p={b.endP} significant={b.endP < 0.05} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-400">
            各線はその曜日の、寄り基準の日内平均累積リターン。右肩上がり＝日中も買われる、
            寄り直後にピークを打って垂れる＝寄り天フェード。曜日間で終端の高さ・途中の凹凸を比べる。
          </p>

          {/* ── 曜日 × 原系列タイムライン ── */}
          <div className="pt-3 border-t border-gray-100 space-y-3">
            <div className="text-xs text-gray-600">
              <span className="font-medium text-gray-700">曜日分布の確認:</span>{" "}
              <span className="text-gray-400">
                各立会日を曜日色の●で、原系列（対象銘柄の日次終値ライン）上に直接プロット。
                ホイールでズーム・ドラッグでパン。曜日は暦上ほぼ均等に分布するため、
                特定曜日の平均パスが一部期間のレジームに偏っていないかを確認できる。
              </span>
            </div>

            {/* 曜日凡例 */}
            <div className="flex items-center gap-3 flex-wrap text-[11px]">
              {result.bins.map((b) => (
                <span key={b.weekday} className="inline-flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: b.color }} />
                  <span className="text-gray-600">{b.label}</span>
                </span>
              ))}
              <span className="text-gray-400">（灰=原系列の終値ライン／●=各立会日を曜日色で）</span>
            </div>

            <div ref={tlContainerRef} className="w-full rounded border border-gray-100" />
          </div>
        </>
      )}

      <IntradayCaveat extra="寄り(始値)を0起点に、曜日ごとの日内の平均的な値動きの形を描く。" />

      <AnalysisGuide title="曜日×日内平均累積パスの詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"各立会日を曜日(月〜金)で分類し、寄り付きを基準に『1日を通してどんな形で値が動いたか』の平均を曜日ごとに重ねて描く。日次の曜日アノマリー(月曜が弱い等)は“1日を1つの数字(始値→終値や前日比)”に潰すため途中経過が見えないが、日内足でパスにすると『月曜は寄りで跳ねてすぐ戻す』『金曜は後場にじわ上げ』といった時間的な形が分かる。執行(寄りで入るか、引けまで待つか)の時刻設計に使う。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"各営業日について、寄り基準の累積対数リターン r(t) = ln(P_t / 始値) を時間格子上で算出(P_t=その時間ビンの終値、無ければ直前値で補完)。"}</li>
          <li>{"曜日(月=1〜金=5)で層別。曜日は暦上ほぼ均等に出るため、各曜日の日数がほぼ揃う。"}</li>
          <li>{"曜日ごとに各時刻の平均パスを取り、平均 ± 1.96·標準誤差(SE=σ/√n)を95%帯として重ねる。"}</li>
          <li>{"終端(寄り→引け)の平均が0と異なるかを1標本t検定で評価。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>右肩上がりで終端が高い曜日</strong>: その曜日は日中も買われやすい(寄り買い→引け利確が噛み合う)。</li>
          <li><strong>寄り直後に山→その後低下</strong>: 寄りで行き過ぎ日中に戻す曜日(フェード/寄り逆張り)。ピーク時刻が手仕舞いの目安。</li>
          <li><strong>帯(95%)が0線をまたぐ</strong>: その時刻の平均は0と区別できない=エッジ薄い。帯が0の片側に収まる時間帯・曜日が狙い目。</li>
          <li>曜日間で線がきれいに分かれるほど、日内の値動きの形に曜日効果が強い。重なるなら曜日で日中パターンは変わらない。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>継続型の曜日は寄りエントリー、フェード型の曜日は寄り逆張りと、曜日ごとに日中戦略を切り替える。</li>
          <li>パスのピーク/ボトム時刻が、その曜日での利確・手仕舞いの時間目安になる。</li>
          <li>日次の曜日リターン分析(WeekdayConditionalChart等)と併読: 日次で方向、パスで日中のタイミングを決める。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"5/15/30分足は約60日(約40営業日)しか取れず、曜日別では1曜日あたり約8日と薄い。パスがギザつき、平均は外れ値(大事件の日)に引っ張られる。帯の広がりで信頼度を確認する。"}</li>
          <li>{"60分足は約2年取れるため曜日別サンプルは厚いが、時間解像度は粗い。足種を変えて頑健性を見る。"}</li>
          <li>{"特定レジーム(強い上昇相場等)に観測期間が偏ると、地合いを曜日効果と誤認しうる。下のタイムラインで曜日色が全期間に均等散布かを確認する。"}</li>
          <li>{"時間格子はデータ実測のセッション範囲から作る。東証の前場/後場の昼休みは連続扱いになる点に留意。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
