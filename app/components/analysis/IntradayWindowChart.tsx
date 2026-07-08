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
import { useIntraday } from "../../hooks/useIntraday";
import {
  computeWindowWeekday, WindowWeekdayResult,
  computeWindowBinTiming,
} from "../../lib/intraday-window";
import {
  initCanvas, IntervalButtons, LoadingError, IntradayCaveat,
} from "./intradayShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

const WD_NAMES: Record<number, string> = { 0: "日", 1: "月", 2: "火", 3: "水", 4: "木", 5: "金", 6: "土" };
const fmtSigned = (v: number, d = 3) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;

// 5分位ビンの発散カラー（下位=赤 〜 上位=緑）
const BIN_COLORS = ["#dc2626", "#fb923c", "#9ca3af", "#4ade80", "#16a34a"];
const BIN_LABELS = ["最下位", "下位", "中位", "上位", "最上位"];
const fmtYM = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).slice(2)}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

// 曜日別 平均リターンの発散バー
function drawWeekdayBars(ctx: CanvasRenderingContext2D, W: number, H: number, res: WindowWeekdayResult) {
  const rows = res.rows;
  if (rows.length === 0) return;
  const ml = 8, mr = 64, mt = 10, mb = 8;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const maxAbs = Math.max(1e-9, ...rows.map((r) => Math.abs(r.mean)));
  const zeroX = ml + plotW / 2;
  const rowH = plotH / rows.length;

  ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(zeroX, mt); ctx.lineTo(zeroX, mt + plotH); ctx.stroke();
  ctx.setLineDash([]);

  rows.forEach((r, i) => {
    const cy = mt + i * rowH + rowH / 2;
    const w = (Math.abs(r.mean) / maxAbs) * (plotW / 2 - 4);
    const barH = Math.max(6, rowH * 0.5);
    const x = r.mean >= 0 ? zeroX : zeroX - w;
    ctx.fillStyle = r.signif ? (r.mean >= 0 ? "#16a34a" : "#dc2626") : (r.mean >= 0 ? "#16a34a66" : "#dc262666");
    ctx.fillRect(x, cy - barH / 2, w, barH);
    ctx.fillStyle = "#374151"; ctx.font = "9px sans-serif";
    ctx.textAlign = "left"; ctx.fillText(`${WD_NAMES[r.weekday]} ${fmtSigned(r.mean)}`, ml, cy - rowH / 2 + 9);
    ctx.textAlign = r.mean >= 0 ? "left" : "right";
    ctx.fillText(`n=${r.n}`, r.mean >= 0 ? zeroX + w + 3 : zeroX - w - 3, cy + 3);
  });
}

const TL_HEIGHT = 240;

export default function IntradayWindowChart({ ticker }: Props) {
  const [interval, setInterval] = useState("15m");
  const { resp, loading, error } = useIntraday(ticker, interval);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 分位ビン×原系列タイムライン（ズーム/パン可能な lightweight-charts）
  const tlContainerRef = useRef<HTMLDivElement>(null);
  const tlChartRef = useRef<IChartApi | null>(null);
  const tlSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const tlMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const [startMin, setStartMin] = useState<number | null>(null);
  const [endMin, setEndMin] = useState<number | null>(null);
  const [selectedWd, setSelectedWd] = useState<number | null>(null);
  const [showDist, setShowDist] = useState(false);

  // 利用可能ウィンドウ（ビン境界）
  const options = useMemo(() => {
    if (!resp || resp.bars.length === 0) return null;
    const probe = computeWindowWeekday(resp.bars, resp.gmtoffset, 0, 24 * 60, intervalToMin(interval));
    return probe?.windowOptions ?? null;
  }, [resp, interval]);

  // 初期ウィンドウ: 寄り後（最初のビン）→ 当日中盤
  useEffect(() => {
    if (!options || options.length === 0) return;
    setStartMin(options[0].minute);
    setEndMin(options[Math.min(options.length - 1, Math.max(1, Math.floor(options.length / 2)))].minute);
  }, [options]);

  const result = useMemo(() => {
    if (!resp || resp.bars.length === 0 || startMin === null || endMin === null) return null;
    return computeWindowWeekday(resp.bars, resp.gmtoffset, startMin, endMin, intervalToMin(interval));
  }, [resp, startMin, endMin, interval]);
  const showResult = !!result;

  useEffect(() => {
    if (!result || !canvasRef.current) return;
    const init = initCanvas(canvasRef.current, 24 + result.rows.length * 26);
    if (init) drawWeekdayBars(init.ctx, init.width, init.height, result);
  }, [result]);

  // 実際に用いる曜日：ユーザー選択が有効ならそれ、無ければ最も標本数の多い曜日（レンダー時に導出）
  const effectiveWd = useMemo(() => {
    if (!result || result.rows.length === 0) return null;
    if (selectedWd !== null && result.rows.some((r) => r.weekday === selectedWd)) return selectedWd;
    return [...result.rows].sort((a, b) => b.n - a.n)[0].weekday;
  }, [result, selectedWd]);

  // 分位ビン × 時間軸位置
  const timing = useMemo(() => {
    if (!resp || resp.bars.length === 0 || startMin === null || endMin === null || effectiveWd === null) return null;
    return computeWindowBinTiming(resp.bars, resp.gmtoffset, startMin, endMin, effectiveWd);
  }, [resp, startMin, endMin, effectiveWd]);

  // タイムラインチャート初期化（コンテナがDOMに出現したら生成）
  useEffect(() => {
    if (!showResult || !showDist || !tlContainerRef.current) return;
    const chart = createChart(tlContainerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: tlContainerRef.current.clientWidth,
      height: TL_HEIGHT,
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
  }, [showResult, showDist]);

  // タイムラインのデータ＆ビン色マーカー更新
  useEffect(() => {
    const series = tlSeriesRef.current;
    if (!series) return;
    if (!timing || timing.days.length === 0) {
      series.setData([]);
      tlMarkersRef.current?.setMarkers([]);
      return;
    }
    series.setData(
      timing.seriesDates.filter((s) => s.close > 0).map((s) => ({ time: s.date as Time, value: s.close }))
    );
    const markers: SeriesMarker<Time>[] = timing.days.map((d) => ({
      time: d.date as Time,
      position: "inBar",
      color: BIN_COLORS[d.bin] ?? "#9ca3af",
      shape: "circle",
      size: 1,
    }));
    tlMarkersRef.current?.setMarkers(markers);
    // 生成時にコンテナが hidden(width=0) だった場合に備え、可視化後の幅を反映
    if (tlContainerRef.current && tlContainerRef.current.clientWidth > 0) {
      tlChartRef.current?.applyOptions({ width: tlContainerRef.current.clientWidth });
    }
    tlChartRef.current?.timeScale().fitContent();
  }, [timing, showDist]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">任意時刻ウィンドウ × 曜日 クロス集計</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>

      <LoadingError loading={loading} error={error} />

      {options && startMin !== null && endMin !== null && (
        <div className="flex items-center gap-2 text-xs text-gray-600 flex-wrap rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
          <span className="font-medium text-gray-700">時刻ウィンドウ:</span>
          <select
            value={startMin}
            onChange={(e) => setStartMin(Number(e.target.value))}
            className="px-2 py-1 border border-gray-300 rounded"
          >
            {options.map((o) => (
              <option key={`s${o.minute}`} value={o.minute}>{o.label}</option>
            ))}
          </select>
          <span>〜</span>
          <select
            value={endMin}
            onChange={(e) => setEndMin(Number(e.target.value))}
            className="px-2 py-1 border border-gray-300 rounded"
          >
            {options.map((o) => (
              <option key={`e${o.minute}`} value={o.minute}>{o.label}</option>
            ))}
          </select>
          <span className="text-gray-400 ml-1">この時間帯で建て→手仕舞いした日次リターンを曜日別に集計</span>
        </div>
      )}

      {result && (
        <>
          {/* 全曜日サマリー */}
          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
            <span className="font-bold">全曜日まとめ</span>: 平均 <span className="font-bold">{fmtSigned(result.all.mean)}</span>
            ・勝率 <span className="font-bold">{(result.all.win * 100).toFixed(0)}%</span>（n={result.all.n}日）{" "}
            <StatBadge n={result.all.n} p={result.all.p} significant={result.all.signif} />
          </div>

          {/* 曜日別テーブル */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">曜日</th>
                  <th className="text-right px-2">日数</th>
                  <th className="text-right px-2">平均</th>
                  <th className="text-right px-2">中央値</th>
                  <th className="text-left px-2">勝率</th>
                  <th className="text-right px-2">σ</th>
                  <th className="text-left px-2">有意性</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.weekday} className="border-b border-gray-100">
                    <td className="py-1 px-2 font-medium text-gray-700">{WD_NAMES[r.weekday]}曜</td>
                    <td className="text-right px-2 text-gray-600">{r.n}</td>
                    <td className={`text-right px-2 font-medium ${r.mean >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSigned(r.mean)}</td>
                    <td className="text-right px-2 text-gray-600">{fmtSigned(r.median)}</td>
                    <td className="px-2">
                      <div className="flex items-center gap-1">
                        <div className="relative h-3 w-14 bg-gray-100 rounded-sm overflow-hidden">
                          <div className={`absolute inset-y-0 left-0 ${r.win >= 0.5 ? "bg-green-400" : "bg-red-400"}`} style={{ width: `${r.win * 100}%` }} />
                          <div className="absolute inset-y-0 left-1/2 w-px bg-gray-400" />
                        </div>
                        <span className="text-gray-600 tabular-nums">{(r.win * 100).toFixed(0)}%</span>
                      </div>
                    </td>
                    <td className="text-right px-2 text-gray-500">{(r.std * 100).toFixed(2)}%</td>
                    <td className="px-2"><StatBadge n={r.n} p={r.p} significant={r.signif} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="relative"><canvas ref={canvasRef} /></div>

          {/* ── 分位ビン × 原系列タイムライン ── */}
          <div className="pt-3 border-t border-gray-100 space-y-3">
            <button
              type="button"
              onClick={() => setShowDist((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-gray-900"
            >
              <span className="text-gray-400">{showDist ? "▼" : "▶"}</span>
              ビン位置の確認
            </button>
            {showDist && (
            <>
            <div className="flex items-center gap-2 text-xs text-gray-600 flex-wrap">
              <select
                value={effectiveWd ?? ""}
                onChange={(e) => setSelectedWd(Number(e.target.value))}
                className="px-2 py-1 border border-gray-300 rounded"
              >
                {result.rows.map((r) => (
                  <option key={r.weekday} value={r.weekday}>{WD_NAMES[r.weekday]}曜（n={r.n}）</option>
                ))}
              </select>
              <span className="text-gray-400">この曜日の窓リターンを5分位ビンに分け、原系列のどこに位置するかを表示</span>
            </div>

            {/* ビン凡例 */}
            <div className="flex items-center gap-3 flex-wrap text-[11px]">
              {BIN_COLORS.map((c, i) => (
                <span key={i} className="inline-flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: c }} />
                  <span className="text-gray-600">{BIN_LABELS[i]}リターン</span>
                </span>
              ))}
              <span className="text-gray-400">（灰=原系列の終値ライン／●=選択曜日の各日をビン色で。ドラッグでパン・ホイールでズーム）</span>
            </div>

            <div
              ref={tlContainerRef}
              className={`w-full rounded border border-gray-100 ${timing && timing.days.length > 0 ? "" : "hidden"}`}
            />

            {timing && timing.days.length > 0 ? (
              <>
                {/* ビン別 時間的位置サマリー */}
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-200">
                        <th className="text-left py-1 px-2">ビン</th>
                        <th className="text-right px-2">日数</th>
                        <th className="text-right px-2">リターン帯</th>
                        <th className="text-right px-2">平均</th>
                        <th className="text-left px-2">期間（初日〜最終日）</th>
                        <th className="text-right px-2">重心</th>
                        <th className="text-left px-2">時間分布</th>
                      </tr>
                    </thead>
                    <tbody>
                      {timing.bins.filter((b) => b.n > 0).map((b) => (
                        <tr key={b.bin} className="border-b border-gray-100">
                          <td className="py-1 px-2">
                            <span className="inline-flex items-center gap-1">
                              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: BIN_COLORS[b.bin] }} />
                              <span className="text-gray-700">{BIN_LABELS[b.bin]}</span>
                            </span>
                          </td>
                          <td className="text-right px-2 text-gray-500 tabular-nums">{fmtSigned(b.loR, 2)}〜{fmtSigned(b.hiR, 2)}</td>
                          <td className="text-right px-2 text-gray-600">{b.n}</td>
                          <td className={`text-right px-2 font-medium ${b.meanR >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSigned(b.meanR)}</td>
                          <td className="px-2 text-gray-600 tabular-nums">{b.firstDate}〜{b.lastDate}</td>
                          <td className="text-right px-2 text-gray-600 tabular-nums">{fmtYM(b.centroidMs)}</td>
                          <td className="px-2">
                            <div className="flex items-center gap-1">
                              <div className="relative h-2.5 w-16 bg-gray-100 rounded-sm overflow-hidden">
                                <div className={b.dispersion < 0.22 ? "absolute inset-y-0 left-0 bg-amber-400" : "absolute inset-y-0 left-0 bg-sky-400"} style={{ width: `${Math.min(100, (b.dispersion / 0.29) * 100)}%` }} />
                              </div>
                              <span className="text-gray-500">{b.dispersion < 0.22 ? "集中" : "分散"}</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-gray-400">
                  重心=その分位に入った日の平均日付。時間分布の「集中」はビンが特定期間に固まっている（レジーム依存）サイン、「分散」は全期間に均等＝安定したエッジの可能性。
                </p>
              </>
            ) : (
              <p className="text-xs text-gray-400">この曜日・ウィンドウでは有効な約定日がありません。</p>
            )}
            </>
            )}
          </div>
        </>
      )}

      <IntradayCaveat extra="ウィンドウ内に約定が無い日は除外。狭いウィンドウ・少ない曜日は特に標本が薄い。" />

      <AnalysisGuide title="任意時刻ウィンドウ × 曜日 集計の詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"『1日の中の特定の時間帯（例 寄り後30分、引け前30分）だけ持った場合のリターン』を曜日別に分けて集計する。寄り付き・引けにかけての需給の偏りが、曜日によってどう違うかを検証できる。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ウィンドウ・リターン</strong>: r = ln(終了時刻以前の最後のバー終値 / 開始時刻以降の最初のバー始値)。指定した時間帯だけ建玉したとみなす。</li>
          <li><strong>曜日バケット</strong>: 各営業日をその曜日に割り当て、平均・中央値・勝率・σ を集計。</li>
          <li><strong>有意性</strong>: 曜日ごとに平均=0 の t検定 → Benjamini-Hochberg FDR 補正。n≥8 かつ p&lt;0.05 を「有意」。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>時刻ウィンドウ</strong>: 取引所ローカル時刻での連続した時間帯。足の刻み（5/15/30/60分）の境界から選ぶ。</li>
          <li><strong>勝率</strong>: そのウィンドウのリターンがプラスだった日の割合。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>特定曜日×特定時間帯で平均がプラス・勝率＞50%・有意なら、デイトレのエントリー/手仕舞いタイミングの候補。</li>
          <li>「全曜日まとめ」より特定曜日が突出していれば曜日効果、全曜日で揃っていれば時間帯効果と解釈できる。</li>
          <li>寄り後と引け前でウィンドウを変え、どちらにエッジが寄るかを比較する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 分位ビン × 原系列タイムライン（深化）</p>
        <p>
          {"曜日別の平均・σは『その曜日を通算した1つの数字』に過ぎず、その値がいつ作られたか（全期間で安定なのか、特定時期に偏って生まれたのか）は分からない。そこで選択した曜日の窓リターン群を5つの分位ビンに分け、各日が原系列（暦日）のどこに位置するかを直接プロットする。"}
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>分位ビン（クインタイル）</strong>: その曜日の窓リターンを値の小さい順に並べ、ランクで均等に5分割する。最下位＝下位20%、最上位＝上位20%。各ビンの日数がほぼ等しくなるので時期の偏りを比較しやすい。</li>
          <li><strong>原系列タイムライン</strong>: 横軸＝暦日。背景の灰色ラインが原系列（日次終値）。その上に選択曜日の各日を所属ビンの色（赤=最下位〜緑=最上位）の●で重ねる。チャートは<strong>ホイールでズーム・ドラッグでパン</strong>でき、特定期間を拡大して細かく確認できる。</li>
          <li><strong>重心</strong>: あるビンに属する日の平均日付。ビンの「時間的な中心」を表す。</li>
          <li><strong>時間分布の集中/分散</strong>: ビン内の日付の標準偏差を全期間幅で正規化した値。値が小さい（集中）ほど、その分位の日が特定期間に固まっていることを意味する。直感的には「最上位リターンの月曜が全部この四半期に集中している＝その時期だけのレジーム効果」を見抜くための指標。</li>
        </ul>
        <p className="mt-1">数式: ビン割当 bin(i) = ⌊ rank(i) × B / N ⌋（rank=昇順順位0..N-1, B=ビン数5, N=その曜日の日数）。分散度 = std(暦日ms) / (期間全幅ms)。</p>
        <p className="font-medium text-gray-700 mt-3">読み方・活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>緑（上位）ドットが全期間に均等に散らばっていれば、その曜日のプラスエッジは時期によらず安定 → 実運用で信頼しやすい。</li>
          <li>緑が一部期間に集中（帯で固まる）していれば、平均のプラスはその時期のレジームが作っただけの見かけのエッジ → 直近で再現するとは限らない。</li>
          <li>背景の終値ラインと重ねることで「上昇局面でだけ上位ビンが出る」等、相場環境との連動も確認できる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Yahoo 日中足は約15分遅延・取得期間に上限（5/15/30分≈60日、60分≈2年）。曜日別だと各曜日の日数が非常に少ない。</li>
          <li>狭いウィンドウほど n が減り不安定。「参考(n小)」を重視しない。</li>
          <li>多数のウィンドウ・曜日を試すほど偶然の当たりを引きやすい（多重比較）。</li>
          <li>取引コスト・スリッページ未控除。日中の短いリターンでは特に効く。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

function intervalToMin(interval: string): number {
  const m = /^(\d+)m$/.exec(interval);
  return m ? Number(m[1]) : 15;
}
