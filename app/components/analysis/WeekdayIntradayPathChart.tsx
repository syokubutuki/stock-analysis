"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeWeekdayPaths, WeekdayPathResult } from "../../lib/weekday-intraday-path";
import { groupByDay, buildBinGrid } from "../../lib/intraday-core";
import { useIntraday } from "../../hooks/useIntraday";
import { intervalToMin } from "./usSpilloverShared";
import { initCanvas, IntervalButtons, LoadingError, IntradayCaveat } from "./intradayShared";
import {
  drawPathStats, PathLegend, PathSummaryTable, PairDiffMatrix, PathTimeline, TimelineDay,
} from "./intradayPathShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

export default function WeekdayIntradayPathChart({ ticker }: Props) {
  const [interval, setInterval] = useState("15m");
  const [showBand, setShowBand] = useState(true);
  const [showMedian, setShowMedian] = useState(false);
  const [showDist, setShowDist] = useState(false);
  const { resp, loading, error } = useIntraday(ticker, interval);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const result: WeekdayPathResult | null = useMemo(() => {
    if (!resp || resp.bars.length === 0) return null;
    const days = groupByDay(resp.bars, resp.gmtoffset);
    const grid = buildBinGrid(resp.bars, resp.gmtoffset, intervalToMin(interval));
    return computeWeekdayPaths(days, grid, resp.gmtoffset);
  }, [resp, interval]);

  useEffect(() => {
    if (!result || !canvasRef.current) return;
    const init = initCanvas(canvasRef.current, 260);
    if (init) drawPathStats(init.ctx, init.width, init.height, result.bins, result.timeLabels, result.maxAbs, { showBand, showMedian });
  }, [result, showBand, showMedian]);

  const timelineDays: TimelineDay[] = useMemo(
    () => (result ? result.days.map((d) => ({ date: d.date, close: d.close, key: String(d.weekday) })) : []),
    [result]
  );
  const colorOf = useCallback(
    (key: string) => result?.bins.find((b) => String(b.weekday) === key)?.color ?? "#9ca3af",
    [result]
  );

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
        <label className="flex items-center gap-1 text-xs text-gray-600">
          <input type="checkbox" checked={showMedian} onChange={(e) => setShowMedian(e.target.checked)} />
          中央値パス（破線）
        </label>
      </div>

      <LoadingError loading={loading} error={error} />
      {!loading && !error && resp && !result && (
        <div className="text-xs text-gray-400">集計できる立会日が不足しています。</div>
      )}

      {result && (
        <>
          <PathLegend stats={result.bins} />
          <div className="relative"><canvas ref={canvasRef} /></div>

          <PathSummaryTable stats={result.bins} timeLabels={result.timeLabels} groupHeader="曜日" />
          <p className="text-[11px] text-gray-400">
            実線=平均・破線=中央値の日内累積リターン。▲=平均パスのピーク時刻／▽=ボトム時刻（利確・手仕舞いの目安）。
            右肩上がり＝日中も買われる、寄り直後にピーク→垂れる＝寄り天フェード。平均と中央値が大きく離れる曜日は少数の異常日が形を作っている。
          </p>

          <PairDiffMatrix stats={result.bins} pairDiffs={result.pairDiffs} />

          {/* ── 曜日 × 原系列タイムライン ── */}
          <div className="pt-3 border-t border-gray-100 space-y-3">
            <button
              type="button"
              onClick={() => setShowDist((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-gray-900"
            >
              <span className="text-gray-400">{showDist ? "▼" : "▶"}</span>
              曜日分布の確認
            </button>
            {showDist && (
              <>
                <div className="text-xs text-gray-400">
                  各立会日を曜日色の●で、原系列（対象銘柄の日次終値ライン）上に直接プロット。ホイールでズーム・ドラッグでパン。
                  特定曜日の平均パスが一部期間のレジームに偏っていないかを確認できる。
                </div>
                <PathLegend stats={result.bins} withN={false} />
                <PathTimeline days={timelineDays} colorOf={colorOf} />
              </>
            )}
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
          <li>{"曜日(月=1〜金=5)で層別。曜日ごとに各時刻の平均パス・中央値パスを取り、平均 ± 1.96·標準誤差(SE=σ/√n)を95%帯として重ねる。"}</li>
          <li>{"平均パスが最大/最小になる時刻をピーク(▲)/ボトム(▽)として抽出。終端(寄り→引け)が0と異なるかを1標本t検定で、曜日ペア間で終端が異なるかをWelchの2標本t検定→BHでFDR補正して評価。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>平均 vs 中央値</strong>: 実線(平均)と破線(中央値)が近ければ形は安定。大きく離れる曜日は少数の大変動日が平均を歪めているので割り引く。</li>
          <li><strong>ピーク▲/ボトム▽の時刻</strong>: 継続型の曜日ではピーク時刻が利確、フェード型ではピーク時刻が手仕舞い(その後は戻す)の目安。</li>
          <li><strong>差の検定マトリクス</strong>: ★(FDR有意)が付くペアだけが「日内の伸びが統計的に本当に違う曜日」。無ければ曜日で日中パターンは変わらないと判断。</li>
          <li><strong>帯(95%)が0線をまたぐ</strong>: その時刻の平均は0と区別できない=エッジ薄い。帯が0の片側に収まる時間帯・曜日が狙い目。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>継続型の曜日は寄りエントリー、フェード型の曜日は寄り逆張りと、曜日ごとに日中戦略を切り替える。</li>
          <li>ピーク▲/ボトム▽の時刻が、その曜日での利確・手仕舞いの時間目安。差の検定で有意な曜日だけを実運用の対象に絞る。</li>
          <li>日次の曜日リターン分析(WeekdayConditionalChart等)と併読: 日次で方向、パスで日中のタイミングを決める。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"5/15/30分足は約60日(約40営業日)しか取れず、曜日別では1曜日あたり約8日と薄い。平均はギザつき外れ値に弱いので中央値・差の検定と併読する。"}</li>
          <li>{"60分足は約2年取れるため曜日別サンプルは厚いが、時間解像度は粗い。足種を変えて頑健性を見る。"}</li>
          <li>{"特定レジーム(強い上昇相場等)に観測期間が偏ると地合いを曜日効果と誤認しうる。下のタイムラインで曜日色が全期間に均等散布かを確認する。"}</li>
          <li>{"時間格子はデータ実測のセッション範囲から作る。東証の前場/後場の昼休みは連続扱いになる点に留意。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
