"use client";

// レジーム(相場基調) × 前夜米国 の交互作用: 日内平均累積パス。
// 「可変累積トレンド」(直近K日の累積対数リターン)で上昇/中立/下落基調に日を層別し、
// 各基調バケツの中で前夜米国ビン別の日内パスを描く。米国スピルオーバーの強さ・形が
// 相場基調で変わるか(moderation)を、基調ソース(銘柄/米国/一致背反)を切り替えて調べる。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeRegimeUsPaths, RegimeUsPathResult, RegimeSource } from "../../lib/regime-us-path";
import { BinScheme } from "../../lib/us-spillover-core";
import { useAlignedDays, UsDriverButtons } from "./usSpilloverShared";
import { US_DRIVERS } from "../../hooks/useUsDaily";
import { initCanvas, IntervalButtons, LoadingError, IntradayCaveat, fmtSignedPct } from "./intradayShared";
import {
  drawPathStats, PathLegend, PathSummaryTable, PairDiffMatrix, PathTimeline, TimelineDay,
} from "./intradayPathShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

const SOURCES: { value: RegimeSource; label: string; note: string }[] = [
  { value: "jp", label: "銘柄", note: "対象銘柄自身の累積トレンドで基調を判定（外生要因に対し内生・モメンタム的）" },
  { value: "us", label: "米国", note: "米国指数の累積トレンドで基調を判定（対象銘柄に外生・押し目か continuation か）" },
  { value: "concord", label: "一致/背反", note: "銘柄と米国のトレンドの一致・背反を1軸に畳んで同時利用" },
];

const US_SCHEMES: { value: BinScheme; label: string }[] = [
  { value: "sign", label: "陰陽(2)" },
  { value: "tercile", label: "3分位" },
];

const K_OPTIONS = [5, 10, 20, 60];

// ビンの前夜米国リターン範囲を表示用に整形（対数リターンを%相当で表示）。
function fmtBinRange(lo: number | null, hi: number | null): string {
  if (lo === null) return `≤ ${fmtSignedPct(hi!, 2)}`;
  if (hi === null) return `≥ ${fmtSignedPct(lo, 2)}`;
  return `${fmtSignedPct(lo, 2)} 〜 ${fmtSignedPct(hi, 2)}`;
}

export default function RegimeUsPathChart({ ticker }: Props) {
  const [usTicker, setUsTicker] = useState("^GSPC");
  const [interval, setInterval] = useState("60m");
  const [source, setSource] = useState<RegimeSource>("jp");
  const [k, setK] = useState(20);
  const [thresholdPct, setThresholdPct] = useState(2);
  const [usScheme, setUsScheme] = useState<BinScheme>("sign");
  const [showBand, setShowBand] = useState(true);
  const [showMedian, setShowMedian] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const { data, loading, error } = useAlignedDays(ticker, interval, usTicker);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const result: RegimeUsPathResult | null = useMemo(() => {
    if (!data) return null;
    return computeRegimeUsPaths(data.aligned, data.us, data.grid, data.gmtoffset, {
      source, K: k, thresholdPct, usScheme,
    });
  }, [data, source, k, thresholdPct, usScheme]);

  // 選択バケツ: 未選択/消滅時は「今日の基調」→ 最も標本の厚いバケツにフォールバック。
  const selected = useMemo(() => {
    if (!result) return null;
    const nonEmpty = result.buckets.filter((b) => b.n > 0);
    if (nonEmpty.length === 0) return null;
    const explicit = selectedKey && nonEmpty.find((b) => b.key === selectedKey);
    if (explicit) return explicit;
    const today = result.today && nonEmpty.find((b) => b.key === result.today!.regimeKey);
    if (today) return today;
    return nonEmpty.reduce((a, b) => (b.n > a.n ? b : a));
  }, [result, selectedKey]);

  useEffect(() => {
    if (!result || !selected || !canvasRef.current) return;
    const init = initCanvas(canvasRef.current, 260);
    if (init) drawPathStats(init.ctx, init.width, init.height, selected.usStats, result.timeLabels, result.maxAbs, { showBand, showMedian });
  }, [result, selected, showBand, showMedian]);

  const timelineDays: TimelineDay[] = useMemo(
    () => (result ? result.days.map((d) => ({ date: d.date, close: d.close, key: d.regimeKey })) : []),
    [result]
  );
  const colorOf = useCallback(
    (key: string) => result?.buckets.find((b) => b.key === key)?.color ?? "#9ca3af",
    [result]
  );

  const usLabel = US_DRIVERS.find((d) => d.ticker === usTicker)?.label ?? usTicker;
  const trendSubject = source === "us" ? `米国(${usLabel})` : source === "jp" ? "対象銘柄" : "銘柄と米国";

  // 前夜米国ビンの数値範囲(境界から各ビンの下限/上限を復元)。
  const binCount = result?.usBinLabels.length ?? 0;
  const binLo = (b: number): number | null => (b === 0 ? null : result!.usBinEdges[b - 1]);
  const binHi = (b: number): number | null => (b === binCount - 1 ? null : result!.usBinEdges[b]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">相場基調 × 前夜米国 交互作用：日内平均累積パス</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>

      {/* 基調ソース & 米国指数 & 米国ビン */}
      <div className="flex items-center gap-4 flex-wrap">
        <UsDriverButtons value={usTicker} onChange={setUsTicker} />
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">基調ソース:</span>
          {SOURCES.map((s) => (
            <button
              key={s.value}
              onClick={() => { setSource(s.value); setSelectedKey(null); }}
              title={s.note}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                source === s.value ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">前夜米国ビン:</span>
          {US_SCHEMES.map((s) => (
            <button
              key={s.value}
              onClick={() => setUsScheme(s.value)}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                usScheme === s.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* 可変累積 K & 閾値 & 表示 */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">累積日数 K:</span>
          {K_OPTIONS.map((v) => (
            <button
              key={v}
              onClick={() => { setK(v); setSelectedKey(null); }}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                k === v ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {v}日
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <span className="text-gray-500">基調しきい値 ±</span>
          <input
            type="range" min={0} max={8} step={0.5} value={thresholdPct}
            onChange={(e) => { setThresholdPct(Number(e.target.value)); setSelectedKey(null); }}
            className="w-28"
          />
          <span className="tabular-nums font-medium w-10">{thresholdPct.toFixed(1)}%</span>
        </label>
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
        <div className="text-xs text-gray-400">整合できた標本が不足しています（累積日数Kを小さくするか60分足を選択）。</div>
      )}

      {result && selected && (
        <>
          {/* 基調の定義 */}
          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2 text-[11px] text-gray-600">
            <span className="font-medium text-gray-700">基調の定義:</span>{" "}
            {trendSubject}の<span className="font-medium">直近{k}日の累積対数リターン</span>（当日を含まず＝寄り前に確定）が{" "}
            <span className="font-mono">≥ +{thresholdPct.toFixed(1)}%→上昇</span>、
            <span className="font-mono">≤ −{thresholdPct.toFixed(1)}%→下落</span>、その間→中立。
            {source === "concord" && "　銘柄と米国それぞれの符号を掛け合わせて一致（順行）/背反に5分類。"}
            {source === "us" && "　基調の窓から前夜当日は除外し、前夜米国ビン（下記）と重複させない。"}
          </div>

          {/* 今日の基調 */}
          {result.today && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 flex items-center gap-2 flex-wrap">
              <span className="font-bold">次セッションに入る時点の基調:</span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: colorOf(result.today.regimeKey) }} />
                <span className="font-bold">{result.today.label}</span>
              </span>
              <span className="text-blue-700">
                {result.today.jpTrend !== null && `　銘柄 直近${k}日 ${fmtSignedPct(result.today.jpTrend, 2)}`}
                {result.today.usTrend !== null && `　米国 直近${k}日 ${fmtSignedPct(result.today.usTrend, 2)}`}
              </span>
            </div>
          )}

          {/* 直近の前夜米国(=ビン軸)が今どのビンか＝現状の実測値 */}
          {result.latestUs && (
            <div className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900">
              {result.latestUs.unpaired && (
                <span className="inline-block mr-1 px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 text-[10px] font-bold align-middle">
                  寄り前・未反映
                </span>
              )}
              <span className="font-bold">直近の前夜米国（{result.latestUs.date}）: 前日終値比 {fmtSignedPct(result.latestUs.value, 2)}</span>
              {" → "}
              <span className="inline-flex items-center gap-1 align-middle">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: result.usBinColors[result.latestUs.bin] }} />
                <span className="font-bold">{result.usBinLabels[result.latestUs.bin]}</span>
              </span>
              <span className="text-indigo-700">
                {"　ビン範囲 "}{fmtBinRange(binLo(result.latestUs.bin), binHi(result.latestUs.bin))}
                {"　全体分布の下から "}{(result.latestUs.percentile * 100).toFixed(0)}{"%位"}
              </span>
            </div>
          )}

          {/* 前夜米国ビンの数値範囲(全ビン共通境界。◀今=直近の所属ビン) */}
          <div className="flex items-center gap-3 flex-wrap text-[11px]">
            <span className="text-gray-500">前夜{usLabel}ビン範囲:</span>
            {result.usBinLabels.map((label, b) => {
              const isToday = result.latestUs?.bin === b;
              return (
                <span key={b} className={`inline-flex items-center gap-1 rounded px-1 ${isToday ? "ring-1 ring-indigo-400 bg-indigo-50" : ""}`}>
                  <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: result.usBinColors[b] }} />
                  <span className="text-gray-600">
                    {label}
                    <span className="text-gray-400">（{fmtBinRange(binLo(b), binHi(b))}）</span>
                    {isToday && <span className="text-indigo-600 font-bold">◀今</span>}
                  </span>
                </span>
              );
            })}
          </div>

          {/* ── 基調間のスピルオーバー強度 比較(本命の表) ── */}
          <div className="space-y-1">
            <div className="text-xs font-medium text-gray-700">基調別 米国スピルオーバー強度（前夜{usLabel}の{usScheme === "sign" ? "陽−陰" : "最上位−最下位"}ビンの寄り→引け差）</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 px-2">基調</th>
                    <th className="text-right px-2">日数</th>
                    <th className="text-right px-2">スピルオーバー強度</th>
                    <th className="text-left px-2">有意性</th>
                    <th className="text-center px-2">表示</th>
                  </tr>
                </thead>
                <tbody>
                  {result.buckets.filter((b) => b.n > 0).map((b) => {
                    const isSel = selected.key === b.key;
                    return (
                      <tr key={b.key} className={`border-b border-gray-100 ${isSel ? "bg-indigo-50" : ""}`}>
                        <td className="py-1 px-2">
                          <span className="inline-flex items-center gap-1">
                            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: b.color }} />
                            <span className="text-gray-700">{b.label}</span>
                          </span>
                        </td>
                        <td className="text-right px-2 text-gray-600">{b.n}</td>
                        <td className={`text-right px-2 font-medium ${b.spilloverSpread >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(b.spilloverSpread)}</td>
                        <td className="px-2"><StatBadge n={b.n} p={b.spreadPAdj} significant={b.spreadPAdj < 0.05} /></td>
                        <td className="text-center px-2">
                          <button
                            onClick={() => setSelectedKey(b.key)}
                            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                              isSel ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                            }`}
                          >
                            {isSel ? "表示中" : "見る"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-gray-400">
              値が大きい基調ほど「前夜米国の方向が翌日日中に強く伝わる」。基調で値が符号反転/大小変化すれば、米国の効き方が地合い依存＝交互作用の実体。
            </p>
          </div>

          {/* ── 選択バケツ内: 前夜米国ビン別パス ── */}
          <div className="pt-3 border-t border-gray-100 space-y-3">
            <div className="text-xs text-gray-600">
              <span className="font-medium text-gray-700">選択中の基調:</span>{" "}
              <span className="inline-flex items-center gap-1 align-middle">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: selected.color }} />
                <span className="font-medium text-gray-700">{selected.label}</span>
              </span>
              <span className="text-gray-400">（n={selected.n}）— この基調の日を前夜{usLabel}ビンで分け、寄り基準の日内累積パスを描く。</span>
            </div>
            <PathLegend stats={selected.usStats} />
            <div className="relative"><canvas ref={canvasRef} /></div>

            <PathSummaryTable stats={selected.usStats} timeLabels={result.timeLabels} groupHeader="前夜米国ビン" />
            <PairDiffMatrix stats={selected.usStats} pairDiffs={selected.usPairDiffs} />
          </div>

          {/* ── 基調所属 × 原系列タイムライン ── */}
          <div className="pt-3 border-t border-gray-100 space-y-3">
            <div className="text-xs text-gray-600">
              <span className="font-medium text-gray-700">基調の分布確認:</span>{" "}
              <span className="text-gray-400">各立会日を所属基調の色●で原系列上にプロット。特定基調が一部期間に固まっていないか（見かけのエッジ）を確認。ホイールでズーム・ドラッグでパン。</span>
            </div>
            <div className="flex items-center gap-3 flex-wrap text-[11px]">
              {result.buckets.filter((b) => b.n > 0).map((b) => (
                <span key={b.key} className="inline-flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: b.color }} />
                  <span className="text-gray-600">{b.label}</span>
                </span>
              ))}
            </div>
            <PathTimeline days={timelineDays} colorOf={colorOf} />
          </div>
        </>
      )}

      <IntradayCaveat extra="基調(過去K日の累積トレンド)で母集団を層別した上に前夜米国ビンで割るため、各セルは薄くなる。標本の厚い60分足(約2年)を既定とする。" />

      <AnalysisGuide title="相場基調 × 前夜米国 交互作用パスの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"前夜米国スピルオーバー(前夜の米国が翌日日本の日中足にどう漏れ出すか)は、平均すると一つの形になるが、実際には『そのときの相場基調』で効き方が変わる可能性がある。例えば同じ前夜下落でも、上昇トレンドの押し目なら翌日は買い戻され、下落トレンドの続落なら翌日も垂れる、といった具合。この分析は相場基調を条件(moderator)として、米国の効き方(スピルオーバーの強さ・日内の形)が基調で変わるか=交互作用を切り分ける。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 基調の定義（可変累積トレンド）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"各立会日について、直近K日の累積対数リターン trend_K = Σ_{i=1..K} r(D−i) を算出。当日を含めないので寄り前に確定＝実運用可(先読みなし)。Kは5/10/20/60で可変(短期モメンタム〜中期トレンド)。"}</li>
          <li>{"しきい値T(%)で、trend_K ≥ +T→上昇基調、≤ −T→下落基調、その間→中立。Tを動かすと『どの程度の傾きを基調とみなすか』を任意に変えられる。"}</li>
          <li><strong>基調ソース</strong>{"は3通り: "}<strong>銘柄</strong>{"=対象銘柄自身のトレンド、"}<strong>米国</strong>{"=米国指数のトレンド、"}<strong>一致/背反</strong>{"=両者のトレンド符号を掛け合わせ、順行(両↑/両↓)・背反(自↑米↓/自↓米↑)に5分類し両方を同時に使う。"}</li>
          <li>{"前夜米国ビン(効果を測る軸)は全標本共通の境界で陰陽/3分位に分け、基調バケツ間で意味を揃える。米国ソースでは基調の窓から前夜当日を除外し、基調と前夜ビンの重複(共線性)を避ける。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"基調バケツごとに、その日を前夜米国ビン別に分け、寄り基準の累積対数リターン r(t)=ln(P_t/始値) の平均・中央値パスと95%帯(平均±1.96SE)、ピーク/ボトム時刻を算出。"}</li>
          <li>{"スピルオーバー強度 = 米国最上位ビン − 最下位ビン の寄り→引け平均差。基調間でこの値がどう変わるかが本分析の主眼。"}</li>
          <li>{"バケツ内の米国ビン間終端差はWelchのt検定→BHでFDR補正。強度の有意性も同補正後p値で表示。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>基調別スピルオーバー強度が大きく変わる</strong>: 米国の効き方は地合い依存。上表で強度が最大の基調が「米国追随が最も効く局面」。</li>
          <li><strong>強度が符号反転</strong>: ある基調では前夜米国と逆に動く(下落基調での戻し等)。逆張り条件の候補。</li>
          <li><strong>パスのピーク/ボトム時刻</strong>: その基調×米国ビンでの利確・手仕舞い時刻の目安。</li>
          <li><strong>タイムラインで基調が一部期間に固まる</strong>: その基調のエッジは特定レジームが作った見かけの可能性。全期間に散らばるほど信頼できる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>基調は寄り前に確定するので、当日の日内戦略(前夜米国に順張りか逆張りか)を基調で切り替えられる。</li>
          <li>「一致/背反」ソースで、自銘柄と米国のねじれ(背反・自弱米強など)だけを狙う条件を探す。片方の軸だけでは平均化されて消える交互作用エッジを拾う。</li>
          <li>前夜米国スピルオーバー(UsPathχ)・曜日×米国(WeekdayUsPathχ)と併読し、複数条件で同時に有意な局面だけを実運用に採る。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"基調3分割 × 前夜米国ビンで標本が薄くなる。5/15/30分足は約60日しか取れず不安定。60分足(約2年)を既定とし、各セルのnを確認する。"}</li>
          <li><strong>銘柄ソースは内生性</strong>{"に注意: 基調も日内も同じ系列から作るため、平均回帰/モメンタムの自己相関が交互作用に化けうる。米国ソース(外生)と見比べる。"}</li>
          <li>{"基調は連日続く(自己相関)ため独立標本でない。素のt値は甘めに出る。強度の再現性はタイムラインの偏りと合わせて判断。"}</li>
          <li>{"K・T・米国指数・ビン方式を動かすほど多重比較(forking paths)。出たエッジは探索段階の候補とし、別手法(WeekdayIntradayEdge等)で確定する。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
