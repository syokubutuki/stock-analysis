"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeTurnOfMonthPaths, TomPathResult } from "../../lib/turn-of-month-path";
import { groupByDay, buildBinGrid } from "../../lib/intraday-core";
import { useIntraday } from "../../hooks/useIntraday";
import { intervalToMin } from "./usSpilloverShared";
import { initCanvas, IntervalButtons, LoadingError, IntradayCaveat } from "./intradayShared";
import {
  drawPathStats, PathLegend, PathSummaryTable, PairDiffMatrix, PathTimeline, TimelineDay,
  usePathEvolution, PathEvolutionControls, PathDriftTable,
  PathDriftGuideSection,
} from "./intradayPathShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

const WINDOWS = [2, 3, 5];

export default function TurnOfMonthPathChart({ ticker }: Props) {
  const [interval, setInterval] = useState("60m");
  const [windowK, setWindowK] = useState(3);
  const [showBand, setShowBand] = useState(true);
  const [showMedian, setShowMedian] = useState(false);
  const [showDist, setShowDist] = useState(false);
  const { resp, loading, error } = useIntraday(ticker, interval);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const result: TomPathResult | null = useMemo(() => {
    if (!resp || resp.bars.length === 0) return null;
    const days = groupByDay(resp.bars, resp.gmtoffset);
    const grid = buildBinGrid(resp.bars, resp.gmtoffset, intervalToMin(interval));
    return computeTurnOfMonthPaths(days, grid, resp.gmtoffset, windowK);
  }, [resp, interval, windowK]);

  const evo = usePathEvolution(result?.bins);

  useEffect(() => {
    if (!result || !canvasRef.current) return;
    const init = initCanvas(canvasRef.current, 260);
    if (init) drawPathStats(init.ctx, init.width, init.height, result.bins, result.timeLabels, result.maxAbs, {
      showBand, showMedian,
      showSpaghetti: evo.showSpaghetti, showEras: evo.showEras, groupFilter: evo.groupFilter,
    });
  }, [result, showBand, showMedian, evo.showSpaghetti, evo.showEras, evo.groupFilter]);

  const timelineDays: TimelineDay[] = useMemo(
    () => (result ? result.days.map((d) => ({ date: d.date, close: d.close, key: d.group })) : []),
    [result]
  );
  const colorOf = useCallback(
    (key: string) => result?.bins.find((b) => b.group === key)?.color ?? "#9ca3af",
    [result]
  );

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">月内位置（月初/中旬/月末）× 当日日内 平均累積パス</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span className="text-gray-500">月初/月末とみなす営業日数:</span>
          {WINDOWS.map((k) => (
            <button
              key={k}
              onClick={() => setWindowK(k)}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                windowK === k ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {k}日
            </button>
          ))}
        </div>
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
          <PathEvolutionControls stats={result.bins} evo={evo} />
          <div className="relative"><canvas ref={canvasRef} /></div>

          <PathSummaryTable stats={result.bins} timeLabels={result.timeLabels} groupHeader="月内位置" />
          <p className="text-[11px] text-gray-400">
            実線=平均・破線=中央値。▲=ピーク時刻／▽=ボトム時刻。月末群・月初群が中旬群と形が違えば、
            月替わりのフロー（月末のリバランス売買、月初の資金流入）が日内の値動きに現れているサイン。
            {evo.showEras && "「時代分割」中は全期間平均を隠し、古い→直近ほど濃く太い線で描く。▲▽は直近期の高安時刻。"}
            {evo.showSpaghetti && "個別日は最新ほど濃く太い。枠外に出た日はクリップされる（縦軸は平均基準のため）。"}
          </p>

          <PairDiffMatrix stats={result.bins} pairDiffs={result.pairDiffs} />
          <PathDriftTable stats={result.bins} timeLabels={result.timeLabels} />

          {/* ── 月内位置 × 原系列タイムライン ── */}
          <div className="pt-3 border-t border-gray-100 space-y-3">
            <button
              type="button"
              onClick={() => setShowDist((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-gray-900"
            >
              <span className="text-gray-400">{showDist ? "▼" : "▶"}</span>
              分布の確認
            </button>
            {showDist && (
            <>
            <div className="text-xs text-gray-600">
              <span className="text-gray-400">
                各立会日を月内位置の色（緑=月初/灰=中旬/赤=月末）の●で原系列（日次終値）上にプロット。
                ホイールでズーム・ドラッグでパン。
              </span>
            </div>
            <PathLegend stats={result.bins} withN={false} />
            <PathTimeline days={timelineDays} colorOf={colorOf} />
            </>
            )}
          </div>
        </>
      )}

      <IntradayCaveat extra="月足の少ない5/15/30分足では月末/月初のサンプルが特に薄い。標本の厚い60分足(約2年)を既定とする。" />

      <AnalysisGuide title="月内位置×日内平均累積パスの詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"月末はインデックスファンドのリバランスや機関投資家の月次評価に伴う売買、月初は年金・給与由来の資金流入が集中しやすい。この『月替わり(turn-of-month)効果』が日次リターンだけでなく、日内の値動きの形にも出るかを、寄り基準の平均累積パスで月初/中旬/月末に分けて可視化する。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"各立会日を、その暦月の営業日並びの中で先頭K日=月初・末尾K日=月末・それ以外=中旬に分類(Kは2/3/5日で選択)。"}</li>
          <li>{"群ごとに寄り基準の累積対数リターン r(t)=ln(P_t/始値) の平均・中央値パスと95%帯を描き、ピーク/ボトム時刻を抽出。"}</li>
          <li>{"終端(寄り→引け)の有意性(1標本t)と、群間差(Welch t→FDR補正)を検定。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>月末群が右肩上がり</strong>: 月末に買い需要(リバランス買い等) → 月末は引けにかけて強い。</li>
          <li><strong>月初群が突出</strong>: 月初の資金流入で寄り〜前場に上昇圧力。差の検定★で中旬と有意差があれば実エッジ。</li>
          <li><strong>3群が重なる</strong>: 当該銘柄では月替わり効果が日内パスに出ていない。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>月末・月初に有意な日内ドリフトがあれば、その数日だけ寄り〜引けの保有方向を傾ける。</li>
          <li>ピーク▲時刻を月末買いの利確目安に。中旬との差が有意な群だけを対象に絞る。</li>
          <li>日次のカレンダー効果分析(CalendarEffectChart)と併読し、方向は日次・タイミングは日内で決める。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"5/15/30分足は約60日=3ヶ月弱しかなく、月末群は数日と極端に薄い。標本の厚い60分足(約2年=24ヶ月)を既定とする。"}</li>
          <li>{"月末効果は月次で相関しうる(同じレジームの月が続く)。中央値・タイムラインで一部期間への偏りを確認する。"}</li>
          <li>{"K(境界日数)を変えると分類が変わる。複数Kで頑健なパターンだけを信頼する。"}</li>
        </ul>
        <PathDriftGuideSection />
      </AnalysisGuide>
    </div>
  );
}
