"use client";

// 対象選択による床の底上げ ── 系C25 の検証。
//
// C24 の床（市場＝等加重への参加）を前提に、観測可能な特性 X で対象をチルトすれば
// 床を底上げできるか（横断超過ドリフト Δμ>0）を純ウォークフォワードで検証する。
//   ・単位は特性ソート・ポートフォリオ（上位分位の束）＝idiosyncratic を分散。
//   ・超過ドリフトの t 値ハードル（C16 誤差割引）＋複数特性の BH-FDR（命題4）で採用を絞る。
//   ・N_eff（C20）と生存者バイアス（point-in-time 終端生存）を診断。
//   ・大半のチルトは床を超えない、が誠実な既定結果。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart, LineSeries, type IChartApi, type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeSelectionTilt, DEFAULT_TILT_PARAMS, TILT_SIGNAL_LABEL, TILT_SIGNAL_DESC,
  type TiltParams, type SelectionTiltResult, type TiltSignalId,
} from "../../lib/selection-tilt";
import { UNIVERSES, getUniverse } from "../../lib/universes";
import { fetchUniverse, parseTickerList } from "../../lib/universe-fetch";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";

interface Props {
  tickers: string[];
  pricesByTicker: Record<string, PricePoint[]>;
  names?: Record<string, string>;
}

type UniverseMode = "watchlist" | "paste" | string;

const pct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
const num2 = (v: number) => v.toFixed(2);

function Stat({
  label, value, tone, sub,
}: { label: string; value: string; tone?: "good" | "bad" | "neutral"; sub?: string }) {
  const c = tone === "good" ? "text-green-700" : tone === "bad" ? "text-red-700" : "text-gray-800";
  return (
    <div className="rounded border border-gray-200 px-2.5 py-1.5">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`text-sm font-bold font-mono ${c}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-400">{sub}</div>}
    </div>
  );
}

export default function SelectionTiltChart({ tickers, pricesByTicker }: Props) {
  const [quantile, setQuantile] = useState(DEFAULT_TILT_PARAMS.quantile);
  const [rebalanceDays, setRebalanceDays] = useState(DEFAULT_TILT_PARAMS.rebalanceDays);
  const [costBps, setCostBps] = useState(DEFAULT_TILT_PARAMS.costBps);
  const [tHurdle, setTHurdle] = useState(DEFAULT_TILT_PARAMS.tHurdle);

  // ユニバース: ウォッチリスト / プリセット(大型30・主要60) / 貼り付け
  const [uniMode, setUniMode] = useState<UniverseMode>("watchlist");
  const [pasteRaw, setPasteRaw] = useState("");
  const [pasteTickers, setPasteTickers] = useState<string[]>([]);
  const [fetched, setFetched] = useState<{ prices: Record<string, PricePoint[]>; names: Record<string, string> }>({ prices: {}, names: {} });
  const [fetching, setFetching] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [selected, setSelected] = useState<TiltSignalId>("momentum");

  const uniTickers = useMemo<string[]>(() => {
    if (uniMode === "watchlist") return tickers;
    if (uniMode === "paste") return pasteTickers;
    return getUniverse(uniMode)?.tickers.map((t) => t.ticker) ?? [];
  }, [uniMode, tickers, pasteTickers]);

  useEffect(() => {
    // ウォッチリスト時・空入力時は取得しない（空クリアは派生値 activePrices 側で処理）。
    if (uniMode === "watchlist" || uniTickers.length === 0) return;
    const ctrl = new AbortController();
    // 外部システム(API)からの取得。setState は非同期コールバック内に閉じる。
    const load = async () => {
      setFetching(true);
      setProgress({ done: 0, total: uniTickers.length });
      try {
        const res = await fetchUniverse(
          uniTickers,
          (done, total) => setProgress({ done, total }),
          ctrl.signal
        );
        if (ctrl.signal.aborted) return;
        const prices: Record<string, PricePoint[]> = {};
        const nm: Record<string, string> = {};
        const preset = getUniverse(uniMode);
        for (const [tk, v] of Object.entries(res)) {
          if (v.prices.length > 0) { prices[tk] = v.prices; nm[tk] = v.name; }
        }
        if (preset) for (const t of preset.tickers) if (!nm[t.ticker]) nm[t.ticker] = t.name;
        setFetched({ prices, names: nm });
      } finally {
        if (!ctrl.signal.aborted) setFetching(false);
      }
    };
    load();
    return () => ctrl.abort();
  }, [uniMode, uniTickers]);

  // 貼り付けで空入力のときは stale なフェッチ結果を見せない（setState-in-effect 回避）。
  const activePrices = useMemo<Record<string, PricePoint[]>>(
    () =>
      uniMode === "watchlist"
        ? pricesByTicker
        : uniMode === "paste" && pasteTickers.length === 0
          ? {}
          : fetched.prices,
    [uniMode, pricesByTicker, pasteTickers, fetched.prices]
  );
  const activeCount = Object.keys(activePrices).length;

  const result = useMemo<SelectionTiltResult | null>(() => {
    if (activeCount < 5) return null;
    const params: TiltParams = { quantile, rebalanceDays, costBps, tHurdle };
    return computeSelectionTilt(activePrices, params);
  }, [activePrices, activeCount, quantile, rebalanceDays, costBps, tHurdle]);

  const selResult = result?.signals.find((s) => s.signal === selected) ?? result?.signals[0];

  // 資産曲線（床 vs 選択チルト）── 横軸=時間なので lightweight-charts。
  const chartContainer = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!chartContainer.current || !result || !result.ok || !selResult) return;
    const el = chartContainer.current;
    const chart: IChartApi = createChart(el, {
      width: el.clientWidth,
      height: 260,
      layout: { background: { color: "#ffffff" }, textColor: "#374151" },
      grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
      rightPriceScale: { mode: 1, borderColor: "#e5e7eb" }, // 対数
      timeScale: { borderColor: "#e5e7eb" },
    });
    const floor = chart.addSeries(LineSeries, { color: "#9ca3af", lineWidth: 2, priceLineVisible: false });
    floor.setData(result.baselineEquity.map((p) => ({ time: p.time as Time, value: p.value })));
    const tilt = chart.addSeries(LineSeries, {
      color: selResult.passes ? "#16a34a" : "#2563eb", lineWidth: 2, priceLineVisible: false,
    });
    tilt.setData(selResult.equityTilt.map((p) => ({ time: p.time as Time, value: p.value })));
    chart.timeScale().fitContent();
    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); };
  }, [result, selResult]);

  const d = result?.diag;

  return (
    <div className="space-y-4">
      {/* ユニバース */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-gray-500">
          ユニバース
          <select
            value={uniMode}
            onChange={(e) => setUniMode(e.target.value)}
            className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm"
          >
            <option value="watchlist">ウォッチリスト（{tickers.length}銘柄）</option>
            {UNIVERSES.map((u) => (
              <option key={u.id} value={u.id}>{u.label}</option>
            ))}
            <option value="paste">貼り付け</option>
          </select>
        </label>
        {uniMode === "paste" && (
          <div className="flex items-end gap-1">
            <textarea
              value={pasteRaw}
              onChange={(e) => setPasteRaw(e.target.value)}
              placeholder="7203 6758 9984 ..."
              className="px-2 py-1 border border-gray-300 rounded text-xs w-52 h-9 resize-none"
            />
            <button
              onClick={() => setPasteTickers(parseTickerList(pasteRaw))}
              className="px-2 py-1.5 bg-gray-700 text-white rounded text-xs hover:bg-gray-600"
            >
              読込
            </button>
          </div>
        )}
        {fetching && (
          <span className="text-xs text-gray-400">取得中… {progress.done}/{progress.total}</span>
        )}
      </div>

      {/* パラメータ */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-gray-500">
          上位分位（ロング割合）
          <select value={quantile} onChange={(e) => setQuantile(parseFloat(e.target.value))}
            className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm">
            <option value={0.2}>上位20%</option>
            <option value={0.3}>上位30%</option>
            <option value={0.5}>上位50%</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-gray-500">
          リバランス間隔
          <select value={rebalanceDays} onChange={(e) => setRebalanceDays(parseInt(e.target.value))}
            className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm">
            <option value={5}>週次(5日)</option>
            <option value={21}>月次(21日)</option>
            <option value={63}>四半期(63日)</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-gray-500">
          片道コスト(bp)
          <input type="number" value={costBps} onChange={(e) => setCostBps(parseFloat(e.target.value) || 0)}
            step="5" className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm w-20 tabular-nums" />
        </label>
        <label className="flex flex-col text-xs text-gray-500">
          採用tハードル(C16)
          <input type="number" value={tHurdle} onChange={(e) => setTHurdle(parseFloat(e.target.value) || 0)}
            step="0.5" className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm w-20 tabular-nums" />
        </label>
      </div>

      {activeCount < 5 && (
        <div className="py-8 text-center text-gray-400 text-sm">
          横断チルトには最低5銘柄が必要です（十分な履歴つき）。ユニバースを大型30などに切り替えてください。
        </div>
      )}

      {result && !result.ok && (
        <div className="text-sm text-amber-600">{result.reason}</div>
      )}

      {result && result.ok && d && (
        <>
          {/* 診断 */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <Stat label="ユニバース" value={`${d.universeSize}銘柄`} sub={`${d.years.toFixed(1)}年 / ${d.nPeriods}期`} />
            <Stat label="横断相関 ρ̄" value={num2(d.avgPairCorr)} sub="残差相関の平均" />
            <Stat label="実効独立数 N_eff" value={d.nEff.toFixed(1)} tone={d.nEff < 3 ? "bad" : "neutral"} sub="C20: 底上げの上限" />
            <Stat
              label="終端まで生存"
              value={`${d.survivorsToEnd}/${d.universeSize}`}
              tone={d.survivorshipWarning ? "bad" : "neutral"}
              sub={d.survivorshipWarning ? "生存者バイアス疑い" : "point-in-time"}
            />
            <Stat label="床の年率(等加重)" value={pct(result.signals[0]?.annBaseline ?? 0)} sub="C24の床" />
            <Stat label="採用tハードル" value={num2(result.tHurdle)} sub="C16 誤差割引" />
          </div>

          {d.survivorshipWarning && (
            <p className="text-[11px] text-amber-600 bg-amber-50 rounded px-2 py-1">
              ⚠ ほぼ全銘柄が終端まで生存＝現在の主要リストは「過去の勝者」。超過は過大評価されうる。
              真の時点構成メンバー（上場廃止・統合で消えた銘柄）を含めて初めて正しく効く。
            </p>
          )}

          {/* シグナル別・超過ドリフト表 */}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1.5">
              特性チルト vs 床（等加重）── 床の底上げ Δμ と前向き検証
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 pr-2">特性</th>
                    <th className="text-right px-2">チルト年率</th>
                    <th className="text-right px-2">床の底上げΔμ</th>
                    <th className="text-right px-2">ネット底上げ</th>
                    <th className="text-right px-2">t値</th>
                    <th className="text-right px-2">FDR q</th>
                    <th className="text-right px-2">g(チルト)</th>
                    <th className="text-right px-2">最大DD</th>
                    <th className="text-right px-2">回転/年</th>
                    <th className="text-center px-2">判定</th>
                  </tr>
                </thead>
                <tbody>
                  {result.signals.map((s) => (
                    <tr
                      key={s.signal}
                      onClick={() => setSelected(s.signal)}
                      className={`border-b border-gray-100 cursor-pointer hover:bg-blue-50/40 ${
                        selected === s.signal ? "bg-blue-50/60" : ""
                      }`}
                    >
                      <td className="text-left py-1 pr-2 font-medium text-gray-700" title={TILT_SIGNAL_DESC[s.signal]}>
                        {TILT_SIGNAL_LABEL[s.signal]}
                      </td>
                      <td className="text-right px-2 tabular-nums">{pct(s.annTilt)}</td>
                      <td className={`text-right px-2 tabular-nums font-semibold ${s.excessAnn > 0 ? "text-green-600" : "text-red-600"}`}>
                        {pct(s.excessAnn)}
                      </td>
                      <td className={`text-right px-2 tabular-nums ${s.netExcessAnn > 0 ? "text-green-600" : "text-red-600"}`}>
                        {pct(s.netExcessAnn)}
                      </td>
                      <td className="text-right px-2 tabular-nums">{num2(s.excessT)}</td>
                      <td className={`text-right px-2 tabular-nums ${s.qValueBH < 0.1 ? "text-green-600" : "text-gray-500"}`}>
                        {s.qValueBH.toFixed(3)}
                      </td>
                      <td className="text-right px-2 tabular-nums">{pct(s.gTilt)}</td>
                      <td className="text-right px-2 tabular-nums text-red-600">{pct(s.maxDDTilt)}</td>
                      <td className="text-right px-2 tabular-nums text-gray-500">{s.turnoverPerYear.toFixed(1)}x</td>
                      <td className="text-center px-2">
                        {s.passes ? (
                          <span className="text-green-700 font-semibold">床超え</span>
                        ) : (
                          <span className="text-gray-400">床未達</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[11px] text-gray-500">
              採用条件（C16＋命題4）: <b>t &gt; {result.tHurdle}</b> かつ <b>FDR q &lt; 0.1</b> かつ ネット底上げ &gt; 0。
              行クリックで下のチャートに反映。※ネット＝回転コスト控除後（床にも同コスト会計を適用）。
            </p>
          </div>

          {/* 資産曲線 */}
          {selResult && (
            <div>
              <div className="text-xs font-semibold text-gray-700 mb-1">
                資産曲線: 床（灰）vs {TILT_SIGNAL_LABEL[selResult.signal]}チルト（{selResult.passes ? "緑=床超え" : "青=床未達"}）・対数軸
              </div>
              <div ref={chartContainer} className="w-full" />
            </div>
          )}

          <SelectionTiltGuide />
          <AxiomPlacement corollaryId="C25" />
        </>
      )}
    </div>
  );
}

function SelectionTiltGuide() {
  return (
    <AnalysisGuide title="対象選択による床の底上げ（横断ドリフト・チルト）の詳細理論">
      <p className="font-medium text-gray-700">1. 何を検証しているか</p>
      <p>
        C24 で「市場に参加すること（床）」の価値を確認した。次の問いは<b>「どの銘柄を厚く持てば、
        床（市場＝等加重）より高い床に立てるか」</b>。観測可能な特性 X（モメンタム・低ボラ等）で
        対象をチルトし、市場等加重に対する<b>超過ドリフト Δμ</b> を前向きに測る。
      </p>

      <p className="font-medium text-gray-700 mt-3">2. なぜ「個別銘柄」でなく「特性ソート・ポートフォリオ」か</p>
      <p>
        個別銘柄のドリフト μ̂ は推定誤差 SE=σ/√T が巨大で、「過去に一番上がった銘柄」を選ぶのは
        <b>生存者バイアス</b>そのもの。上位分位を<b>束ねて持つ</b>ことで idiosyncratic（固有ノイズ）を
        分散し、特性の横断ドリフトという構造成分だけを残す。これが選択を「当て」でなく「規律」にする。
      </p>

      <p className="font-medium text-gray-700 mt-3">3. 数式（分解と採用条件）</p>
      <p>{"超過 = Σ_i (w_i − 1/N)·dP_i,  E[超過] = Σ(E[w_i]−1/N)E[dP_i] + Σ Cov(w_i, dP_i)"}</p>
      <p>{"床の底上げ Δμ = μ_tilt − μ_floor,  採用 ⇔ t(Δμ) > κ(C16) ∧ BH-q < 0.1(命題4) ∧ ネット>0"}</p>
      <p>{"分散限界(C20): N_eff = N/(1+(N−1)ρ̄)  ← 底上げ幅の上限"}</p>

      <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
      <ul className="list-disc pl-4 space-y-1">
        <li><b>床の底上げΔμ</b>: 正なら特性が横断ドリフトを取れている。だが t 値と FDR を見るまで判断しない。</li>
        <li><b>t値・FDR q</b>: 複数特性から最良を選ぶと偽発見が出る。t&gt;κ かつ q&lt;0.1 を満たす「床超え」のみ実効。</li>
        <li><b>N_eff・回転/年</b>: N_eff が小さいと底上げは頭打ち。回転が速いほどコストが超過を食う（ネット底上げで確認）。</li>
        <li><b>大半は「床未達」</b>が誠実な既定結果。床超えが出ても、それは仮説であって保証ではない。</li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>「何を持つか」は当てる問題ではなく、床を前向きに超えるチルトを FDR で選ぶ規律問題。</li>
        <li>床超えの特性が無ければ、素直に床（市場等加重）に居るのが最適＝C24 に戻る。</li>
        <li>床超えがあっても、単位を束（分位ポートフォリオ）に保ち、回転を抑えてコストで消さない。</li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">6. 注意点・限界（重要）</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>
          <b>生存者バイアス</b>: プリセット/現在のウォッチリストは「過去の勝者」。終端まで生存が大半なら
          超過は過大評価される。真の時点構成メンバー（廃止・統合銘柄を含む）が要る（→C26 候補）。
        </li>
        <li>特性は価格ベースのみ（モメンタム・低ボラ・短期反転・トレンド）。バリュー/クオリティ等の
          ファンダメンタルは未取り込み。</li>
        <li>横断相関は危機時に ρ̄→1 で N_eff が縮み、底上げも消える（分散はタダではない）。</li>
        <li>過去の実現超過は将来の期待の不偏推定ではない（レジーム依存・混雑で減衰しうる）。</li>
      </ul>
    </AnalysisGuide>
  );
}
