"use client";

// 曜日 × 前夜米国ビン 交互作用パスの「ウォッチリスト横断」比較。
// 単一銘柄版(WeekdayUsPathChart)を全銘柄に一斉適用し、選んだ前夜米国ビンの翌日に絞った
// 曜日別の「終端リターン(寄り→引け)」と「上値ピーク時刻」を、銘柄×曜日のヒートマップで俯瞰する。
// 末尾に全銘柄をプールした横断コンセンサス行(日付クラスタ頑健SE)を置き、
// あるエッジが1銘柄固有か・ウォッチリスト共通の地合い×曜日構造かを切り分ける。

import { useMemo, useState } from "react";
import { useIntradayBasket } from "../../hooks/useIntraday";
import { useUsDaily, US_DRIVERS } from "../../hooks/useUsDaily";
import { groupByDay, buildBinGrid, BinGrid } from "../../lib/intraday-core";
import { computeUsReturns, BinScheme } from "../../lib/us-spillover-core";
import {
  UsMode, CrossStock, prepCross, computeCrossBinning, computeCrossRows,
  CrossCell, CROSS_WD_ORDER, CROSS_WD_LABELS,
} from "../../lib/weekday-us-cross";
import { UsDriverButtons, BinSchemeButtons, intervalToMin } from "./usSpilloverShared";
import { IntervalButtons, LoadingError, IntradayCaveat, fmtSignedPct } from "./intradayShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  tickers: string[];
  names?: Record<string, string>; // ticker -> 表示名
}

type Sheet = "end" | "peak";

const US_MODES: { value: UsMode; label: string; formula: string }[] = [
  { value: "ret", label: "前日終値比", formula: "ln(当日終値 / 前日終値)（オーバーナイト含む米国当日騰落）" },
  { value: "intra", label: "日中", formula: "ln(当日終値 / 当日始値)（米国正規セッション内）" },
];

function fmtBinRange(lo: number | null, hi: number | null): string {
  if (lo === null) return `≤ ${fmtSignedPct(hi!, 2)}`;
  if (hi === null) return `≥ ${fmtSignedPct(lo, 2)}`;
  return `${fmtSignedPct(lo, 2)} 〜 ${fmtSignedPct(hi, 2)}`;
}

// 終端リターンの発散配色(緑=正/赤=負、|値|で濃度)。
function endBg(v: number | null, scale: number): string {
  if (v === null || scale <= 0) return "transparent";
  const t = Math.max(-1, Math.min(1, v / scale));
  const a = Math.min(0.85, Math.abs(t) * 0.85 + 0.06);
  return t >= 0 ? `rgba(22,163,74,${a})` : `rgba(220,38,38,${a})`;
}
function endText(v: number | null, scale: number): string {
  if (v === null || scale <= 0) return "#9ca3af";
  return Math.abs(v / scale) > 0.55 ? "#ffffff" : "#111827";
}
// ピーク時刻の逐次配色(朝=淡い青 → 大引け=濃い青)。
function peakBg(idx: number, G: number): string {
  if (G <= 1) return "rgba(37,99,235,0.12)";
  const t = idx / (G - 1);
  return `rgba(37,99,235,${0.1 + t * 0.55})`;
}
function star(p: number): string {
  return p < 0.01 ? "★★" : p < 0.05 ? "★" : p < 0.1 ? "☆" : "";
}

export default function WeekdayUsCrossChart({ tickers, names }: Props) {
  const [usTicker, setUsTicker] = useState("^IXIC");
  const [interval, setInterval] = useState("60m");
  const [scheme, setScheme] = useState<BinScheme>("tercile");
  const [usMode, setUsMode] = useState<UsMode>("ret");
  const [selBinRaw, setSelBinRaw] = useState<number | null>(null); // null=直近ビン自動
  const [sheet, setSheet] = useState<Sheet>("end");

  // 米国指数・ビン基準・分位を変えたら選択を解除し、直近ビン自動表示に戻す。
  const setUsTickerR = (t: string) => { setUsTicker(t); setSelBinRaw(null); };
  const setUsModeR = (m: UsMode) => { setUsMode(m); setSelBinRaw(null); };
  const setSchemeR = (s: BinScheme) => { setScheme(s); setSelBinRaw(null); };

  const uniqTickers = useMemo(
    () => Array.from(new Set(tickers.filter((t) => t && t.trim()))),
    [tickers]
  );
  const { ok, loading: bl, error: be } = useIntradayBasket(uniqTickers, interval);
  const { prices: usPrices, loading: ul, error: ue } = useUsDaily(usTicker);
  const loading = bl || ul;
  const error = be || ue;

  // 全銘柄の日次データ + 共通グリッド(ビン数最大の銘柄を基準)を組み立てる。
  const built = useMemo(() => {
    if (ok.length === 0 || !usPrices) return null;
    const min = intervalToMin(interval);
    const stocks: CrossStock[] = [];
    let grid: BinGrid | null = null;
    for (const it of ok) {
      const resp = it.resp!;
      const days = groupByDay(resp.bars, resp.gmtoffset);
      const g = buildBinGrid(resp.bars, resp.gmtoffset, min);
      if (g && (!grid || g.bins.length > grid.bins.length)) grid = g;
      stocks.push({ ticker: it.ticker, name: names?.[it.ticker], days, gmtoffset: resp.gmtoffset });
    }
    if (!grid) return null;
    const us = computeUsReturns(usPrices);
    return { stocks, grid, us };
  }, [ok, usPrices, interval, names]);

  const prep = useMemo(
    () => (built ? prepCross(built.stocks, built.us, usMode) : null),
    [built, usMode]
  );
  const binning = useMemo(
    () => (prep ? computeCrossBinning(prep, scheme) : null),
    [prep, scheme]
  );
  const selBin = binning ? Math.min(selBinRaw ?? binning.todayBin, binning.meta.count - 1) : 0;

  const result = useMemo(
    () => (prep && built && binning ? computeCrossRows(prep, built.grid, scheme, usMode, binning.edges, selBin) : null),
    [prep, built, binning, scheme, usMode, selBin]
  );

  // 終端リターンの配色スケール(全セル+コンセンサスの|終端|の90パーセンタイル)。
  const endScale = useMemo(() => {
    if (!result) return 0.01;
    const vals: number[] = [];
    for (const r of result.rows) for (const c of r.cells) if (c) vals.push(Math.abs(c.endMean));
    if (result.consensus) for (const b of result.consensus.bins) vals.push(Math.abs(b.endMean));
    if (vals.length === 0) return 0.01;
    vals.sort((a, b) => a - b);
    return Math.max(vals[Math.floor(vals.length * 0.9)] || vals[vals.length - 1], 0.002);
  }, [result]);

  const usLabel = US_DRIVERS.find((d) => d.ticker === usTicker)?.label ?? usTicker;
  const modeMeta = US_MODES.find((m) => m.value === usMode)!;
  const selInfo = binning?.binInfos.find((b) => b.bin === selBin) ?? null;
  const G = built?.grid.bins.length ?? 0;

  if (uniqTickers.length < 2) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4 text-sm text-gray-500">
        曜日×前夜米国の横断比較には、ウォッチリストに2銘柄以上が必要です。
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">曜日 × 前夜米国ビン 交互作用：ウォッチリスト横断</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>
      <p className="text-xs text-gray-500">
        選んだ前夜米国ビンの翌日に絞り、各銘柄の曜日別「終端リターン(寄り→引け)」または「上値ピーク時刻」を横断比較。
        末尾の<span className="font-medium text-gray-700">横断平均</span>行は全銘柄をプールし、同一営業日の相関を吸収したクラスタ頑健統計。
      </p>

      <div className="flex items-center gap-4 flex-wrap">
        <UsDriverButtons value={usTicker} onChange={setUsTickerR} />
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">ビン基準:</span>
          {US_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setUsModeR(m.value)}
              title={m.formula}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                usMode === m.value ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <BinSchemeButtons value={scheme} onChange={setSchemeR} />
      </div>

      {/* 前夜米国ビンの選択 */}
      {binning && (
        <div className="flex items-center gap-1.5 flex-wrap text-xs">
          <span className="text-gray-500">見る前夜米国ビン:</span>
          {binning.binInfos.map((b) => {
            const isSel = b.bin === selBin;
            const isToday = binning.todayBin === b.bin;
            return (
              <button
                key={b.bin}
                onClick={() => setSelBinRaw(b.bin)}
                title={`前夜米国リターン範囲 ${fmtBinRange(b.rangeLo, b.rangeHi)}｜米国立会日 n=${b.nUsDays}`}
                className={`flex flex-col items-start gap-0.5 px-2 py-1 rounded font-medium transition-colors ${
                  isSel ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: b.color }} />
                  {b.label}
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
      {binning && prep?.latest && selInfo && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          {binning.todayUnpaired && (
            <span className="inline-block mr-1 px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 text-[10px] font-bold align-middle">
              寄り前・未反映
            </span>
          )}
          <span className="font-bold">直近の前夜米国（{prep.latest.date}）: {modeMeta.label} {fmtSignedPct(prep.latest.value, 2)}</span>
          {" → "}
          <span className="font-bold">{binning.binInfos[binning.todayBin]?.label}</span>
          {binning.todayBin === selBin
            ? <span className="text-blue-700">　（今このビンを表示中）</span>
            : <button onClick={() => setSelBinRaw(binning.todayBin)} className="ml-1 underline text-blue-700 hover:text-blue-900">このビンを見る</button>}
        </div>
      )}

      {/* 表示シート切替 */}
      <div className="flex items-center gap-1 flex-wrap text-xs">
        <span className="text-gray-500">表示:</span>
        {([["end", "終端リターン(寄り→引け)"], ["peak", "上値ピーク時刻"]] as [Sheet, string][]).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setSheet(v)}
            className={`px-2.5 py-1 rounded font-medium transition-colors ${
              sheet === v ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <LoadingError loading={loading} error={error} />

      {result && selInfo && (
        <>
          <div className="text-xs text-gray-600">
            <span className="font-medium text-gray-700">条件:</span>{" "}
            <span className="text-gray-500">
              前夜 {usLabel} の{modeMeta.label}リターンが「{selInfo.label}」（{fmtBinRange(selInfo.rangeLo, selInfo.rangeHi)}）だった翌日に限定。
              {sheet === "end"
                ? " セル=その曜日の寄り→引け平均。緑=上昇/赤=下落、★は終端が有意(★★<1% / ★<5% / ☆<10%)。"
                : " セル=平均パスが最大になる時刻(利確の目安)。色が濃いほど遅い時刻。"}
            </span>
          </div>

          <CrossHeatmap sheet={sheet} result={result} endScale={endScale} G={G} names={names} />

          <p className="text-[11px] text-gray-400">
            列(曜日)方向に色が銘柄をまたいで揃う＝そのビンでの曜日効果はウォッチリスト共通(地合い×曜日の構造)。
            1銘柄だけ突出＝個別要因かノイズ。ビンを切り替え、同じ曜日列の色が反転/強弱するか(交互作用)を見る。
          </p>
        </>
      )}

      <IntradayCaveat extra="前夜米国ビン×曜日で母集団を細分するため各セルは薄い。3分位を既定とし、5分位は横断平均行のみ実効標本が確保されやすい。銘柄数が多いほど横断平均の検定力は上がる。" />

      <AnalysisGuide title="曜日×前夜米国ビン 横断比較の詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"単一銘柄の『曜日×前夜米国ビン 交互作用パス』を、ウォッチリスト全銘柄に同じ条件で一斉適用したもの。"}
          {"選んだ前夜米国ビン(例: 米大幅高)の翌日だけに絞り、曜日別の日内パスを『終端リターン(寄り→引け)』または『上値ピーク時刻』という1つの数字に縮約して、銘柄×曜日のヒートマップにする。"}
          {"単一銘柄では『その銘柄固有の癖』か『地合い×曜日の共通構造』かを判別できないが、横断で並べると、同じ曜日列が多数銘柄で同じ符号に揃うか(共通)、1銘柄だけ突出するか(固有/ノイズ)が一目で分かる。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"前夜米国ビンの境界は全銘柄共通に取る(日付でデデュープした米国リターン集合を順位分割)。銘柄横断で『同じ米国リターン帯=同じ地合い』を比較するため。"}</li>
          <li>{"各銘柄で、選択ビンの翌立会日を曜日別に集計し、寄り基準の累積対数リターン r(t)=ln(P_t/寄り) の平均パスを算出。終端=r(引け)の平均、ピーク=平均パスが最大の時間ビン。"}</li>
          <li>{"横断平均行は全銘柄の該当日をプールし、平均・SEを『日付クラスタ頑健』推定量で計算。同一営業日は全銘柄が相関して動くため、素朴に銘柄×日を独立標本と数えず、日をクラスタとして相関を吸収する。実効標本数 nEff も併記。"}</li>
          <li>{"各セルの終端有意性は1標本t、横断平均行はクラスタ頑健SEでのt。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ある曜日列が銘柄をまたいで同色に揃う</strong>: そのビンでの曜日効果はウォッチリスト共通＝個別銘柄でなく市場構造(前夜米国スピルオーバー×曜日)由来。再現性が高くロバスト。</li>
          <li><strong>横断平均行が有意(★)で nEff も十分</strong>: 単一銘柄では薄くて言えなかったエッジが、プールで検定力を得て初めて有意になった状態。最も信頼できる。</li>
          <li><strong>1銘柄だけ極端</strong>: その銘柄固有の要因(決算・需給)かノイズ。横断で浮くので過剰解釈を避けられる。</li>
          <li><strong>ビンを変えると同じ曜日列の色が反転</strong>: 曜日効果が地合い依存(交互作用)。ピーク時刻シートでは、地合いで利確タイミング(前場/後場)がずれるかを見る。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>今夜の前夜米国は寄り前に確定(上部バナーで所属ビンを即判定)。そのビン列を見て、明日の曜日で最も効く銘柄・向きにその日のトレードを寄せる。</li>
          <li>横断平均で共通エッジと確認できた条件だけを実運用に採用し、1銘柄だけのシグナルは見送る(過学習の回避)。</li>
          <li>全銘柄が同じビン×曜日で同方向＝ブックが地合いに集中(分散していない)。逆行する銘柄があればヘッジ/分散の候補。</li>
          <li>ピーク時刻シートで、条件日の利確タイミングが銘柄間でどれだけ揃うか/ずれるかを見て、手仕舞い時刻の標準化や銘柄別調整を判断。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"前夜米国ビン×曜日で母集団を細分するため各セルは薄い。単一銘柄セルの終端は3分位で1セル数十日、5分位では数日規模。5分位は横断平均行(プール)でのみ実効標本が確保されやすい。"}</li>
          <li>{"横断平均は『銘柄が似た反応をする』ことを前提にプールする。値がさ/低位・業種・米国連動度が大きく違う銘柄を混ぜると平均が歪む。クラスタ頑健SEは相関は吸収するが、母集団の異質性そのものは補正しない。"}</li>
          <li>{"多重比較(銘柄×曜日×ビンの多数のセル)で見かけの有意が出やすい。★の数だけでなく横断的な一貫性・nEffを重視する。"}</li>
          <li>{"米国指数の選択とビン基準(前日終値比/日中)で結果は変わる。ウォッチリスト全体と連動の強い指数を選ぶ。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

// ───────────────────────── ヒートマップ表 ─────────────────────────

function CrossHeatmap({
  sheet, result, endScale, G, names,
}: {
  sheet: Sheet;
  result: NonNullable<ReturnType<typeof computeCrossRows>>;
  endScale: number;
  G: number;
  names?: Record<string, string>;
}) {
  const cellOf = (cells: (CrossCell | null)[], wd: number) => cells.find((c) => c && c.weekday === wd) ?? null;

  const renderCell = (c: CrossCell | null, endP?: number) => {
    if (!c || c.n < 1) return <span className="text-gray-300">—</span>;
    if (sheet === "end") {
      const bg = endBg(c.endMean, endScale);
      const color = endText(c.endMean, endScale);
      return (
        <div style={{ backgroundColor: bg, color }} className="rounded px-1 py-1 leading-tight" title={`n=${c.n}｜終端 ${fmtSignedPct(c.endMean)}｜p=${(endP ?? c.endP).toFixed(3)}`}>
          <div className="font-semibold tabular-nums">{fmtSignedPct(c.endMean, 1)}</div>
          <div className="text-[9px] opacity-80">{star(endP ?? c.endP)}{c.n < 5 && <span className="ml-0.5">n{c.n}</span>}</div>
        </div>
      );
    }
    // peak
    const bg = peakBg(c.peakIdx, G);
    const late = G > 1 && c.peakIdx / (G - 1) > 0.55;
    return (
      <div style={{ backgroundColor: bg, color: late ? "#fff" : "#111827" }} className="rounded px-1 py-1 leading-tight tabular-nums" title={`n=${c.n}｜ピーク ${c.peakLabel}｜終端 ${fmtSignedPct(c.endMean)}`}>
        <div className="font-semibold">{c.peakLabel || "—"}</div>
        {c.n < 5 && <div className="text-[9px] opacity-80">n{c.n}</div>}
      </div>
    );
  };

  const cons = result.consensus;

  return (
    <div className="overflow-x-auto">
      <table className="text-[11px] w-full border-collapse">
        <thead>
          <tr className="text-gray-500">
            <th className="text-left font-medium px-2 py-1 sticky left-0 bg-white">銘柄</th>
            {CROSS_WD_ORDER.map((wd) => (
              <th key={wd} className="font-medium px-1 py-1 text-center min-w-[52px]">{CROSS_WD_LABELS[wd]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r) => (
            <tr key={r.ticker} className="border-t border-gray-100">
              <td className="px-2 py-1 sticky left-0 bg-white">
                <div className="font-medium text-gray-700 truncate max-w-[120px]" title={r.ticker}>
                  {names?.[r.ticker] || r.ticker}
                </div>
                <div className="text-[9px] text-gray-400">n={r.nTotal}</div>
              </td>
              {CROSS_WD_ORDER.map((wd) => (
                <td key={wd} className="px-0.5 py-0.5 text-center">{renderCell(cellOf(r.cells, wd))}</td>
              ))}
            </tr>
          ))}
          {cons && (
            <tr className="border-t-2 border-gray-300 bg-gray-50">
              <td className="px-2 py-1 sticky left-0 bg-gray-50">
                <div className="font-bold text-gray-800">横断平均</div>
                <div className="text-[9px] text-gray-400">{cons.nStocks}銘柄プール</div>
              </td>
              {CROSS_WD_ORDER.map((wd) => {
                const b = cons.bins.find((x) => x.weekday === wd);
                if (!b || b.n < 1) return <td key={wd} className="px-0.5 py-0.5 text-center"><span className="text-gray-300">—</span></td>;
                const cell: CrossCell = {
                  weekday: wd, n: b.n, endMean: b.endMean, endP: b.endP,
                  peakIdx: b.peakIdx, troughIdx: b.troughIdx, peakLabel: result.timeLabels[b.peakIdx] ?? "",
                };
                return (
                  <td key={wd} className="px-0.5 py-0.5 text-center" title={`のべ${b.n}｜独立${b.nDays}日｜実効${b.nEff.toFixed(1)}`}>
                    {renderCell(cell, b.endP)}
                  </td>
                );
              })}
            </tr>
          )}
        </tbody>
      </table>
      {sheet === "peak" && (
        <div className="flex items-center gap-2 text-[10px] text-gray-400 mt-1">
          <span>色の濃さ = ピーク時刻の遅さ</span>
          <span className="inline-block w-16 h-2 rounded" style={{ background: "linear-gradient(90deg, rgba(37,99,235,0.1), rgba(37,99,235,0.65))" }} />
          <span>朝 → 大引け</span>
        </div>
      )}
    </div>
  );
}
