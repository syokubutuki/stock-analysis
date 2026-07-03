"use client";

// 曜日 × 前夜米国 の交互作用: 日内平均累積パス。
// 既存の曜日層別(computeWeekdayPaths)を、前夜米国リターンの符号で絞り込んだ部分集合に適用する。
// 「米陽の翌日」と「米陰の翌日」で曜日別の日内パスを切り替えて見比べ、
// 曜日効果が地合い(米国)で反転しないか(交互作用)を確認する。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeWeekdayPaths, WeekdayPathResult } from "../../lib/weekday-intraday-path";
import { DayData } from "../../lib/intraday-core";
import { useAlignedDays, UsDriverButtons } from "./usSpilloverShared";
import { US_DRIVERS } from "../../hooks/useUsDaily";
import { initCanvas, IntervalButtons, LoadingError, IntradayCaveat } from "./intradayShared";
import {
  drawPathStats, PathLegend, PathSummaryTable, PairDiffMatrix, PathTimeline, TimelineDay,
} from "./intradayPathShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

type UsFilter = "all" | "up" | "down";
const US_FILTERS: { value: UsFilter; label: string }[] = [
  { value: "all", label: "全て" },
  { value: "up", label: "米陽（前夜上昇）" },
  { value: "down", label: "米陰（前夜下落）" },
];

export default function WeekdayUsPathChart({ ticker }: Props) {
  const [usTicker, setUsTicker] = useState("^GSPC");
  const [interval, setInterval] = useState("60m");
  const [usFilter, setUsFilter] = useState<UsFilter>("up");
  const [showBand, setShowBand] = useState(true);
  const [showMedian, setShowMedian] = useState(false);
  const { data, loading, error } = useAlignedDays(ticker, interval, usTicker);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const result: WeekdayPathResult | null = useMemo(() => {
    if (!data || !data.grid) return null;
    const kept = data.aligned.filter((a) => {
      if (!isFinite(a.us.ret)) return false;
      if (usFilter === "up") return a.us.ret > 0;
      if (usFilter === "down") return a.us.ret < 0;
      return true;
    });
    const days: DayData[] = kept.map((a) => a.jp);
    return computeWeekdayPaths(days, data.grid, data.gmtoffset);
  }, [data, usFilter]);

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

  const usLabel = US_DRIVERS.find((d) => d.ticker === usTicker)?.label ?? usTicker;
  const filterLabel = US_FILTERS.find((f) => f.value === usFilter)?.label ?? "";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">曜日 × 前夜米国 交互作用：日内平均累積パス</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        <UsDriverButtons value={usTicker} onChange={setUsTicker} />
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span className="text-gray-500">前夜米国:</span>
          {US_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setUsFilter(f.value)}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                usFilter === f.value ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
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
      {!loading && !error && data && !result && (
        <div className="text-xs text-gray-400">該当する立会日が不足しています（絞り込みを緩めるか60分足を選択）。</div>
      )}

      {result && (
        <>
          <div className="text-xs text-gray-600">
            <span className="font-medium text-gray-700">条件:</span>{" "}
            <span className="text-gray-500">前夜 {usLabel} が「{filterLabel}」だった日に限定した、曜日別の日内累積パス。</span>
          </div>
          <PathLegend stats={result.bins} />
          <div className="relative"><canvas ref={canvasRef} /></div>

          <PathSummaryTable stats={result.bins} timeLabels={result.timeLabels} groupHeader="曜日" />
          <p className="text-[11px] text-gray-400">
            前夜米国の符号で絞った上での曜日別パス。「米陽」と「米陰」で切り替え、同じ曜日の形が反転するか（交互作用）を見る。
            例: 金曜は米陽なら継続・米陰ならフェード、など地合い依存の曜日癖を切り分ける。
          </p>

          <PairDiffMatrix stats={result.bins} pairDiffs={result.pairDiffs} />

          <div className="pt-3 border-t border-gray-100 space-y-3">
            <div className="text-xs text-gray-600">
              <span className="font-medium text-gray-700">曜日分布の確認:</span>{" "}
              <span className="text-gray-400">絞り込み後の各立会日を曜日色●で原系列上にプロット。ホイールでズーム・ドラッグでパン。</span>
            </div>
            <PathLegend stats={result.bins} withN={false} />
            <PathTimeline days={timelineDays} colorOf={colorOf} />
          </div>
        </>
      )}

      <IntradayCaveat extra="前夜米国の符号で母集団を半分に絞るため、曜日別サンプルは特に薄くなる。標本の厚い60分足(約2年)を既定とする。" />

      <AnalysisGuide title="曜日×前夜米国 交互作用パスの詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"曜日効果(曜日ごとの日内パス)が、前夜の米国の強弱という地合いで変わるか=『交互作用』を見る。曜日と米国を別々に見ると打ち消し合って平均化されるが、『米陽の金曜』『米陰の月曜』のように掛け合わせると初めて現れるエッジがある。前夜米国リターンの符号(陽/陰)で日を絞り込み、その部分集合で曜日別の平均累積パスを描く。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"各JP立会日に、その寄り前で最後に確定した米国セッションを対応付け(前夜整合)。前夜米国リターンの符号で全体/米陽/米陰に絞る。"}</li>
          <li>{"絞った部分集合で曜日(月〜金)別に寄り基準の累積対数リターンの平均・中央値パス・95%帯を算出、ピーク/ボトム時刻を抽出。"}</li>
          <li>{"終端(寄り→引け)の有意性(1標本t)と曜日ペア差(Welch t→FDR)を検定。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>米陽と米陰で同じ曜日の形が反転</strong>: その曜日の日内パターンは地合い依存 → 単独の曜日分析では見えない交互作用エッジ。</li>
          <li><strong>どちらでも形が同じ</strong>: 曜日効果は米国と独立。曜日単独の分析で十分。</li>
          <li><strong>特定の掛け合わせ(例 米陽×金曜)だけ終端が有意</strong>: その条件日だけを狙う戦略の候補。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>米陽/米陰を切り替えて、地合いに応じて曜日戦略を反転させるか判断する。</li>
          <li>前夜米国の符号は寄り前に判明しているため、当日の日内戦略(継続/フェード)を寄り時点で選べる。</li>
          <li>前夜米国スピルオーバー(UsPathChart)と曜日パスの橋渡し。両者で有意な条件だけを実運用に採用する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"母集団を米国符号で半分に絞る上に曜日で5分割するため、1セルは非常に薄い。5/15/30分足では成立しにくく、60分足(約2年)を既定とする。"}</li>
          <li>{"分割を細かくするほど見かけのパターンが出やすい(多重比較)。差の検定★とタイムラインの偏りで過剰解釈を防ぐ。"}</li>
          <li>{"米国指数の選択(S&P500/NASDAQ/ダウ等)で結果は変わる。対象銘柄と連動の強い指数を選ぶ。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
