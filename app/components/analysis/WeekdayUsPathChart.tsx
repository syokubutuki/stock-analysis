"use client";

// 曜日 × 前夜米国 の交互作用: 日内平均累積パス。
// 既存の曜日層別(computeWeekdayPaths)を、前夜米国リターンのビンで絞り込んだ部分集合に適用する。
// 前夜米国を符号2値ではなく 3分位/5分位のビンに細分し、「どのビンの翌日か」を切り替えて
// 曜日別の日内パスを見比べ、曜日効果が地合い(米国の強弱)で反転しないか(交互作用)を確認する。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeWeekdayPaths, WeekdayPathResult } from "../../lib/weekday-intraday-path";
import { DayData } from "../../lib/intraday-core";
import {
  assignBins, binEdges, binMeta, binOfValue, BinScheme, AlignedDay, UsReturn,
} from "../../lib/us-spillover-core";
import { useAlignedDays, UsDriverButtons, BinSchemeButtons } from "./usSpilloverShared";
import { US_DRIVERS } from "../../hooks/useUsDaily";
import { initCanvas, IntervalButtons, LoadingError, IntradayCaveat, fmtSignedPct } from "./intradayShared";
import {
  drawPathStats, PathLegend, PathSummaryTable, PairDiffMatrix, PathTimeline, TimelineDay,
  usePathEvolution, PathEvolutionControls, PathDriftTable,
  PathDriftGuideSection,
} from "./intradayPathShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

// ビン分けに使う前夜米国リターンの種類。
type UsMode = "ret" | "intra";
const US_MODES: { value: UsMode; label: string; formula: string }[] = [
  { value: "ret", label: "前日終値比", formula: "ln(当日終値 / 前日終値)（オーバーナイト含む米国当日騰落）" },
  { value: "intra", label: "日中", formula: "ln(当日終値 / 当日始値)（米国正規セッション内の値動き）" },
];

// ビンの前夜米国リターン範囲を表示用に整形（対数リターンを%相当で表示）。
function fmtBinRange(lo: number | null, hi: number | null): string {
  if (lo === null) return `≤ ${fmtSignedPct(hi!, 2)}`;
  if (hi === null) return `≥ ${fmtSignedPct(lo, 2)}`;
  return `${fmtSignedPct(lo, 2)} 〜 ${fmtSignedPct(hi, 2)}`;
}

interface BinInfo {
  bin: number;
  label: string;
  color: string;
  n: number;
  rangeLo: number | null;
  rangeHi: number | null;
}

export default function WeekdayUsPathChart({ ticker }: Props) {
  const [usTicker, setUsTicker] = useState("^IXIC"); // 既定=NASDAQ
  const [interval, setInterval] = useState("60m");
  const [scheme, setScheme] = useState<BinScheme>("tercile"); // 既定=3分位
  const [usMode, setUsMode] = useState<UsMode>("ret"); // 既定=前日終値比
  // selBinRaw=null のとき「直近の前夜米国が属するビン」を自動表示。番号を選ぶと手動固定。
  const [selBinRaw, setSelBinRaw] = useState<number | null>(null);

  // 前夜米国指数・ビン基準・分位を変えたら選択を解除し、その条件での直近ビンを再表示する。
  const setUsTickerAndReset = useCallback((t: string) => { setUsTicker(t); setSelBinRaw(null); }, []);
  const setUsModeAndReset = useCallback((m: UsMode) => { setUsMode(m); setSelBinRaw(null); }, []);
  const setSchemeAndReset = useCallback((s: BinScheme) => { setScheme(s); setSelBinRaw(null); }, []);
  const [showBand, setShowBand] = useState(true);
  const [showMedian, setShowMedian] = useState(false);
  const [showDist, setShowDist] = useState(false);
  const { data, loading, error } = useAlignedDays(ticker, interval, usTicker);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 前夜米国リターンをビン化し、各ビンのメタ情報・今日の所属ビンを求める(選択ビンには依らない)。
  const binning = useMemo(() => {
    if (!data || !data.grid) return null;
    const usVal = (a: AlignedDay) => (usMode === "intra" ? a.us.intra : a.us.ret);
    const rows = data.aligned.filter((a) => isFinite(usVal(a)) && usVal(a) !== 0);
    if (rows.length < 8) return null;
    const vals = rows.map(usVal);
    const binIdx = assignBins(vals, scheme);
    const edges = binEdges(vals, scheme);
    const meta = binMeta(scheme);
    const binInfos: BinInfo[] = meta.labels.map((label, b) => ({
      bin: b, label, color: meta.colors[b],
      n: binIdx.filter((x) => x === b).length,
      rangeLo: b === 0 ? null : edges[b - 1],
      rangeHi: b === meta.count - 1 ? null : edges[b],
    }));
    // 今日(未ペアの最新米国終値も採用) → どのビンか
    const usMode2 = (u: UsReturn) => (usMode === "intra" ? u.intra : u.ret);
    const last = rows[rows.length - 1];
    let tDate = last.us.date, tv = usVal(last);
    for (let i = data.us.length - 1; i >= 0; i--) {
      const v = usMode2(data.us[i]);
      if (isFinite(v) && v !== 0) { tDate = data.us[i].date; tv = v; break; }
    }
    const today = { usDate: tDate, value: tv, bin: binOfValue(tv, scheme, edges), unpaired: tDate > last.us.date };
    return { rows, binIdx, meta, binInfos, today };
  }, [data, scheme, usMode]);

  // 選択ビン: 未選択(null)なら直近の前夜米国が属するビン、選択済みなら範囲内にクランプ。
  const selBin = binning
    ? Math.min(selBinRaw ?? binning.today.bin, binning.meta.count - 1)
    : (selBinRaw ?? 1);

  // 選択した前夜米国ビンの部分集合に対する曜日別パス。
  const result: WeekdayPathResult | null = useMemo(() => {
    if (!binning || !data?.grid) return null;
    const days: DayData[] = binning.rows.filter((_, i) => binning.binIdx[i] === selBin).map((a) => a.jp);
    return computeWeekdayPaths(days, data.grid, data.gmtoffset);
  }, [binning, selBin, data]);

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
    () => (result ? result.days.map((d) => ({ date: d.date, close: d.close, key: String(d.weekday) })) : []),
    [result]
  );
  const colorOf = useCallback(
    (key: string) => result?.bins.find((b) => String(b.weekday) === key)?.color ?? "#9ca3af",
    [result]
  );

  const usLabel = US_DRIVERS.find((d) => d.ticker === usTicker)?.label ?? usTicker;
  const modeMeta = US_MODES.find((m) => m.value === usMode)!;
  const selInfo = binning?.binInfos.find((b) => b.bin === selBin) ?? null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">曜日 × 前夜米国ビン 交互作用：日内平均累積パス</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        <UsDriverButtons value={usTicker} onChange={setUsTickerAndReset} />
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">ビン基準:</span>
          {US_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setUsModeAndReset(m.value)}
              title={m.formula}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                usMode === m.value ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <BinSchemeButtons value={scheme} onChange={setSchemeAndReset} />
      </div>

      {/* 前夜米国ビンの選択(このビンの翌日に絞って曜日別パスを描く) */}
      {binning && (
        <div className="flex items-center gap-1.5 flex-wrap text-xs">
          <span className="text-gray-500">見る前夜米国ビン:</span>
          {binning.binInfos.map((b) => {
            const isSel = b.bin === selBin;
            const isToday = binning.today.bin === b.bin;
            return (
              <button
                key={b.bin}
                onClick={() => setSelBinRaw(b.bin)}
                title={`前夜米国リターン範囲 ${fmtBinRange(b.rangeLo, b.rangeHi)}｜n=${b.n}`}
                className={`flex flex-col items-start gap-0.5 px-2 py-1 rounded font-medium transition-colors ${
                  isSel ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: b.color }} />
                  {b.label}
                  <span className={isSel ? "text-gray-300" : "text-gray-400"}>(n={b.n})</span>
                  {isToday && <span className={isSel ? "text-amber-300" : "text-blue-600"}>◀今</span>}
                </span>
                <span className={`text-[10px] font-normal tabular-nums ${isSel ? "text-gray-300" : "text-gray-400"}`}>
                  {fmtBinRange(b.rangeLo, b.rangeHi)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* 直近の前夜米国がどのビンか */}
      {binning && selInfo && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          {binning.today.unpaired && (
            <span className="inline-block mr-1 px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 text-[10px] font-bold align-middle">
              寄り前・未反映
            </span>
          )}
          <span className="font-bold">直近の前夜米国（{binning.today.usDate}）: {modeMeta.label} {fmtSignedPct(binning.today.value, 2)}</span>
          {" → "}
          <span className="font-bold">{binning.binInfos[binning.today.bin]?.label}</span>
          {binning.today.bin === selBin
            ? <span className="text-blue-700">　（今このビンを表示中）</span>
            : <button onClick={() => setSelBinRaw(binning.today.bin)} className="ml-1 underline text-blue-700 hover:text-blue-900">このビンを見る</button>}
        </div>
      )}

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

      {result && selInfo && (
        <>
          <div className="text-xs text-gray-600">
            <span className="font-medium text-gray-700">条件:</span>{" "}
            <span className="text-gray-500">
              前夜 {usLabel} の{modeMeta.label}リターンが「{selInfo.label}」（{fmtBinRange(selInfo.rangeLo, selInfo.rangeHi)}｜n={selInfo.n}）だった日に限定した、曜日別の日内累積パス。
            </span>
          </div>
          <PathLegend stats={result.bins} />
          <PathEvolutionControls stats={result.bins} evo={evo} />
          <div className="relative"><canvas ref={canvasRef} /></div>

          <PathSummaryTable stats={result.bins} timeLabels={result.timeLabels} groupHeader="曜日" />
          <p className="text-[11px] text-gray-400">
            選んだ前夜米国ビンに絞った上での曜日別パス。ビンを切り替えて、同じ曜日の形がビン間で反転・強弱するか（交互作用）を見る。
            例: 金曜は米大幅高なら継続・米大幅安ならフェード、など地合いの強さ依存の曜日癖を切り分ける。
            {evo.showEras && "「時代分割」中は全期間平均を隠し、古い→直近ほど濃く太い線で描く。▲▽は直近期の高安時刻。"}
            {evo.showSpaghetti && "個別日は最新ほど濃く太い。枠外に出た日はクリップされる（縦軸は平均基準のため）。"}
          </p>

          <PairDiffMatrix stats={result.bins} pairDiffs={result.pairDiffs} />
          <PathDriftTable stats={result.bins} timeLabels={result.timeLabels} />

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
                <div className="text-xs text-gray-400">絞り込み後の各立会日を曜日色●で原系列上にプロット。ホイールでズーム・ドラッグでパン。</div>
                <PathLegend stats={result.bins} withN={false} />
                <PathTimeline days={timelineDays} colorOf={colorOf} />
              </>
            )}
          </div>
        </>
      )}

      <IntradayCaveat extra="前夜米国ビンで母集団を分割し、さらに曜日で5分割するため、1ビン×曜日の標本は薄くなる。分位を細かくするほど各セルは数日になり不安定。標本の厚い60分足(約2年)を既定とする。" />

      <AnalysisGuide title="曜日×前夜米国ビン 交互作用パスの詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"曜日効果(曜日ごとの日内パス)が、前夜の米国の強弱という地合いで変わるか=『交互作用』を見る。曜日と米国を別々に見ると打ち消し合って平均化されるが、『米大幅高の金曜』『米大幅安の月曜』のように掛け合わせると初めて現れるエッジがある。前夜米国リターンをビン(符号2値/3分位/5分位)に分け、選んだ1ビンの翌日だけに絞って曜日別の平均累積パスを描く。ビンを切り替えて見比べることで、単なる陽/陰では潰れてしまう『地合いの強さ』依存の曜日癖まで解像度を上げて確認できる。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"各JP立会日に、その寄り前で最後に確定した米国セッションを対応付け(前夜整合)。前夜米国リターンでビン化(符号/3分位/5分位)。分位は順位で均等分割するので各ビンの日数がほぼ揃う。"}</li>
          <li>{"ビン基準のリターンは選択可能: 前日終値比 ln(C/前日C)＝オーバーナイト込みの米国当日騰落、または 日中 ln(C/O)＝米国正規セッション内の値動き。"}</li>
          <li>{"選んだビンの翌日だけに絞り、曜日(月〜金)別に寄り基準の累積対数リターンの平均・中央値パス・95%帯を算出、ピーク/ボトム時刻を抽出。"}</li>
          <li>{"終端(寄り→引け)の有意性(1標本t)と曜日ペア差(Welch t→FDR)を検定。各ビンの前夜米国リターン範囲と、直近の前夜米国がどのビンに入るかも表示。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ビンをまたぐと同じ曜日の形が反転/強弱する</strong>: その曜日の日内パターンは地合い依存 → 単独の曜日分析では見えない交互作用エッジ。</li>
          <li><strong>どのビンでも形が同じ</strong>: 曜日効果は米国と独立。曜日単独の分析で十分。</li>
          <li><strong>特定の掛け合わせ(例 米大幅高×金曜)だけ終端が有意</strong>: その条件日だけを狙う戦略の候補。3分位/5分位に細分すると、陰陽では平均化されて消えていた極端ビン(米大幅高/大幅安)だけの反応が浮き出ることがある。</li>
          <li><strong>ビン間で単調に変化する</strong>(例 米安→米中立→米高で終端が右肩上がり): 曜日効果が地合いの強さに用量反応的に依存。閾値でなく連続的な調整が有効。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ビンを切り替えて、地合いの強さに応じて曜日戦略を反転/加減させるか判断する。まず陰陽で大枠を掴み、効きそうなら3分位/5分位に細分して極端ビンの反応を確認する。</li>
          <li>前夜米国のビンは寄り前に判明している(上部バナーで直近の所属ビンを即判定)ため、当日の日内戦略(継続/フェード)を寄り時点で選べる。「このビンを見る」で今夜の条件に対応する曜日パスへ即移動できる。</li>
          <li>前夜米国スピルオーバー(前夜米国ビン×当日日内パス)と曜日パスの橋渡し。両者で有意な条件だけを実運用に採用する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"母集団を米国ビンで分割する上に曜日で5分割するため、1セルは非常に薄い。特に5分位では1ビンあたり全体の1/5、そこから曜日で更に1/5になり数日規模になる。5/15/30分足では成立しにくく、60分足(約2年)を既定とする。"}</li>
          <li>{"分割(ビン数×曜日)を細かくするほど見かけのパターンが出やすい(多重比較)。差の検定★とタイムラインの偏り、各セルのnで過剰解釈を防ぐ。"}</li>
          <li>{"米国指数の選択(S&P500/NASDAQ/ダウ等)とビン基準(前日終値比/日中)で結果は変わる。対象銘柄と連動の強い指数を選ぶ。"}</li>
        </ul>
        <PathDriftGuideSection />
      </AnalysisGuide>
    </div>
  );
}
