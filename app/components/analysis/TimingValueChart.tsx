"use client";

// タイミング判断の価値検定 (SPA / Reality Check)
// 週内クロック・固定カレンダールール・軌跡アナログというタイミングルール一族が、
// データ・スヌーピング(一族から最良を選ぶ選択バイアス)を補正した後でも
// バイ&ホールドに勝てるかを Hansen の SPA 検定で判定する。
// 理論の詳細は末尾の AnalysisGuide を参照。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  computeTimingValue,
  DEFAULT_TIMING_PARAMS,
  GROUP_LABEL,
  type RuleGroup,
  type SpaResult,
  type TimingValueResult,
} from "../../lib/timing-value";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
const pct2 = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const num2 = (v: number) => v.toFixed(2);
const cls = (v: number) => (v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500");

function fmtP(p: number): string {
  return p < 0.001 ? "<0.001" : p.toFixed(3);
}

function SpaBadge({ spa }: { spa: SpaResult }) {
  const sig = spa.pConsistent < 0.05;
  const c = sig
    ? "bg-green-100 text-green-700 border-green-300"
    : "bg-gray-100 text-gray-500 border-gray-300";
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${c}`}>
      SPA p={fmtP(spa.pConsistent)}
    </span>
  );
}

const GROUP_BADGE: Record<RuleGroup, string> = {
  wf: "bg-blue-50 text-blue-700 border-blue-200",
  fixed: "bg-amber-50 text-amber-700 border-amber-200",
  analog: "bg-purple-50 text-purple-700 border-purple-200",
};

const TOP_COLORS = ["#2563eb", "#f59e0b", "#8b5cf6"];

export default function TimingValueChart({ prices }: Props) {
  const [costBps, setCostBps] = useState(0);
  const [nBoot, setNBoot] = useState(DEFAULT_TIMING_PARAMS.nBoot);
  const [blockLen, setBlockLen] = useState(DEFAULT_TIMING_PARAMS.blockLen);

  const result = useMemo<TimingValueResult | null>(
    () =>
      computeTimingValue(prices, {
        ...DEFAULT_TIMING_PARAMS,
        costBps,
        nBoot,
        blockLen,
      }),
    [prices, costBps, nBoot, blockLen],
  );
  const ready = result !== null && result.ok;

  // 表示対象: B&H超過(年率差)上位3ルール
  const topRules = useMemo(() => {
    if (!result || !result.ok) return [];
    return result.rules.filter((r) => r.active).slice(0, 3);
  }, [result]);

  // === エクイティ曲線(横軸=日付なので lightweight-charts) ===
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line">[]>([]);

  useEffect(() => {
    if (!ready || !containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f5f5f5" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 280,
      crosshair: { mode: 0 },
      localization: { priceFormatter: (v: number) => `${(v * 100).toFixed(0)}%` },
      timeScale: { timeVisible: false, secondsVisible: false },
    });
    chartRef.current = chart;
    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
    };
  }, [ready]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !result || !result.ok) return;
    for (const s of seriesRef.current) chart.removeSeries(s);
    seriesRef.current = [];

    const bhs = chart.addSeries(LineSeries, {
      color: "#9ca3af", lineWidth: 1, title: "B&H", priceLineVisible: false, lastValueVisible: true,
    });
    bhs.setData(result.equity.map((e) => ({ time: e.time as Time, value: e.bh })));
    seriesRef.current.push(bhs);

    topRules.forEach((r, k) => {
      const s = chart.addSeries(LineSeries, {
        color: TOP_COLORS[k], lineWidth: k === 0 ? 2 : 1, title: r.label,
        priceLineVisible: false, lastValueVisible: true,
      });
      s.setData(
        result.equity.map((e) => ({ time: e.time as Time, value: e.values[r.id] ?? 0 })),
      );
      seriesRef.current.push(s);
    });

    if (containerRef.current && containerRef.current.clientWidth > 0) {
      chart.applyOptions({ width: containerRef.current.clientWidth });
    }
    chart.timeScale().fitContent();
  }, [result, topRules]);

  if (!result || !result.ok) {
    return (
      <div className="text-sm text-gray-500 p-4">
        {result?.reason ?? "データが不足しています。"}
      </div>
    );
  }

  const spa = result.spaAll;
  const sig = spa.pConsistent < 0.05;
  const snoopGap = result.minNaiveP < 0.05 && !sig;
  const best = result.rules.find((r) => r.id === result.bestRuleId);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        「週内クロックや過去の値動き軌跡を見てトレードのタイミングを決めること」に意味があるかを、
        個別ルールではなく<span className="font-medium">ルール一族全体</span>で検定します。
        学習型(ウォークフォワード週内クロック)・固定カレンダールール・軌跡アナログの
        全ルールをアウトオブサンプルで走らせ、B&Hとの差に
        <span className="font-medium"> SPA検定(データ・スヌーピング補正)</span>をかけます。
        「一族から最良を選んだらB&Hに勝てた」は選択バイアスで<span className="font-medium">必ず</span>起きるため、
        その分を補正した p 値だけが証拠になります。
      </p>

      {/* パラメータ */}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <div className="flex items-center gap-1">
          <span className="text-gray-500">片道コスト:</span>
          {[0, 2, 5, 10].map((c) => (
            <button
              key={c}
              onClick={() => setCostBps(c)}
              className={`px-2 py-0.5 rounded border ${costBps === c ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}
            >
              {c}bp
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-500">Boot反復:</span>
          {[500, 1000, 2000].map((b) => (
            <button
              key={b}
              onClick={() => setNBoot(b)}
              className={`px-2 py-0.5 rounded border ${nBoot === b ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}
            >
              {b}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-500">平均ブロック長:</span>
          {[5, 10, 21].map((l) => (
            <button
              key={l}
              onClick={() => setBlockLen(l)}
              className={`px-2 py-0.5 rounded border ${blockLen === l ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}
            >
              {l}日
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400">
          評価窓 {result.evalStart} 〜 {result.evalEnd}（{result.nDays}日 / {result.years.toFixed(1)}年）
        </span>
      </div>

      {/* 総合判定 */}
      <div className={`rounded-lg border p-3 text-sm space-y-1 ${sig ? "bg-green-50 border-green-300" : "bg-gray-50 border-gray-300"}`}>
        <div>
          <span className="font-medium">総合判定: </span>
          一族{spa.n}ルールの最良でも、スヌーピング補正後の
          <span className="font-bold"> SPA p = {fmtP(spa.pConsistent)}</span>
          （保守的 {fmtP(spa.pUpper)} / 甘め {fmtP(spa.pLower)}）。
          {sig
            ? " カレンダー系タイミング判断には統計的裏付けがあります。最良ルールの優位は偶然では説明しにくい水準です。"
            : " どのルールもB&Hに対する有意な優位を示せませんでした。この銘柄・期間では、週内クロックや軌跡を見てタイミングを計ることに統計的な裏付けはありません。"}
        </div>
        <div className="text-xs text-gray-500">
          最良ルール: {best?.label ?? "-"}（年率差 {best ? pct(best.annDiff) : "-"}）。
          未補正の最小 p = {fmtP(result.minNaiveP)}
          {snoopGap && (
            <span className="text-amber-700 font-medium">
              {" "}← 補正なしなら「有意」に見えるが、一族から選んだ時点でこの p 値は無効(これがスヌーピングの罠)。
            </span>
          )}
        </div>
      </div>

      {/* グループ別SPA */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(["wf", "fixed", "analog"] as RuleGroup[]).map((grp) => {
          const s = result.spaByGroup[grp];
          if (!s) return null;
          return (
            <div key={grp} className="rounded-lg border border-gray-200 p-3 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">{GROUP_LABEL[grp]}</span>
                <SpaBadge spa={s} />
              </div>
              <p className="text-xs text-gray-500">
                {grp === "wf" && "過去の曜日×日中/夜間パターンを毎週学習して翌週に適用する族。"}
                {grp === "fixed" && "週末回避・月曜回避・TOM等、当てはめのない古典カレンダー族。"}
                {grp === "analog" && "直近の値動き軌跡の過去近傍から翌週の方向を決める族。"}
              </p>
              <div className="text-xs text-gray-500">
                {s.n}ルール / 統計量 {num2(s.tStat)} / 保守的 p={fmtP(s.pUpper)}
              </div>
            </div>
          );
        })}
      </div>

      {/* エクイティ曲線 */}
      <div>
        <div className="text-xs text-gray-500 mb-1">
          評価窓の累積リターン（灰=B&H / 色付き=B&H超過上位3ルール, ホイールでズーム）
        </div>
        <div ref={containerRef} className="w-full" />
        <div className="flex flex-wrap gap-3 mt-1 text-xs text-gray-500">
          <span><span className="inline-block w-3 h-0.5 bg-gray-400 align-middle mr-1" />B&H（年率 {pct(result.bhAnn)} / Sharpe {num2(result.bhSharpe)}）</span>
          {topRules.map((r, k) => (
            <span key={r.id}>
              <span className="inline-block w-3 h-0.5 align-middle mr-1" style={{ background: TOP_COLORS[k] }} />
              {r.label}
            </span>
          ))}
        </div>
      </div>

      {/* ルール一覧 */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-gray-300 text-gray-500 text-xs">
              <th className="text-left py-1 px-2">ルール</th>
              <th className="text-left py-1 px-2">族</th>
              <th className="text-right py-1 px-2">年率</th>
              <th className="text-right py-1 px-2">Sharpe</th>
              <th className="text-right py-1 px-2">B&H差(年率)</th>
              <th className="text-right py-1 px-2">t</th>
              <th className="text-right py-1 px-2">未補正p</th>
              <th className="text-right py-1 px-2">滞在率</th>
              <th className="text-right py-1 px-2">売買/年</th>
            </tr>
          </thead>
          <tbody>
            {result.rules.map((r) => (
              <tr key={r.id} className={`border-b border-gray-100 ${r.active ? "" : "opacity-40"}`} title={r.desc}>
                <td className="py-1 px-2 text-gray-700">{r.label}</td>
                <td className="py-1 px-2">
                  <span className={`inline-block rounded border px-1 text-[10px] ${GROUP_BADGE[r.group]}`}>
                    {GROUP_LABEL[r.group]}
                  </span>
                </td>
                {r.active ? (
                  <>
                    <td className={`text-right px-2 ${cls(r.ann)}`}>{pct(r.ann)}</td>
                    <td className={`text-right px-2 ${cls(r.sharpe)}`}>{num2(r.sharpe)}</td>
                    <td className={`text-right px-2 font-medium ${cls(r.annDiff)}`}>{pct2(r.annDiff)}</td>
                    <td className="text-right px-2 text-gray-600">{num2(r.tStat)}</td>
                    <td className={`text-right px-2 ${r.pNaive < 0.05 ? "text-amber-600 font-medium" : "text-gray-500"}`}>{fmtP(r.pNaive)}</td>
                    <td className="text-right px-2 text-gray-500">{(r.exposure * 100).toFixed(0)}%</td>
                    <td className="text-right px-2 text-gray-500">{r.turnoverPerYear.toFixed(0)}</td>
                  </>
                ) : (
                  <td colSpan={7} className="text-right px-2 text-gray-400 text-xs">データ不足で未稼働（検定外）</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-gray-400 mt-1">
          「未補正p」はそのルール単独で見た片側ブートストラップp値。一族から良いものを選んだ後では
          この p 値は使えません（総合判定の SPA p が正しい基準）。B&Hとの比較は同一評価窓・同一コスト。
        </p>
      </div>

      <AnalysisGuide title="タイミング判断の価値検定（SPA）の詳細理論">
        <p className="font-medium text-gray-700">1. 何を検定しているか</p>
        <p>
          このセクションの各分析（曜日エッジスキャン、週内クロック、軌跡アナログ…）は
          「過去のカレンダーパターンや値動きの形」から売買タイミングの候補を提示します。
          しかし候補を眺めて最も良さそうなものを採用する行為には、
          <span className="font-medium">データ・スヌーピング（選択バイアス）</span>が必ず入り込みます。
          ここでは「タイミングルールの一族全体から最良を選ぶこと」自体を1つの行為とみなし、
          それがバイ&ホールド（B&H）に勝つ証拠になるかを検定します。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. ルール一族の構成（全てアウトオブサンプル）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">週内クロック学習(WF)</span>: 各週の直前 126/252/504 営業日だけで10スロット（曜日×日中/夜間）の最適サイドを再学習し、翌週に適用。未来の情報は使いません。</li>
          <li><span className="font-medium">固定カレンダー</span>: 日中のみ・夜間のみ・週末ギャップ回避・月曜回避・週後半のみ・月替わり(TOM)。パラメータを持たないため当てはめの余地がありません。</li>
          <li><span className="font-medium">軌跡アナログ</span>: 各週末に直近5日の対数リターン形状のK近傍（候補は全て過去、フォワードも決定時点までに実現済み）を探し、フォワード中央値の符号で翌週の建玉を決定。買/現金と買/売の2種。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 数式（SPA検定）</p>
        <p>
          全ルールが稼働した共通評価窓で、日次リターン差 d<sub>i,t</sub> = r<sub>i,t</sub> − r<sub>BH,t</sub>
          （i=ルール, t=営業日）を作ります。帰無仮説は
          「H<sub>0</sub>: max<sub>i</sub> E[d<sub>i</sub>] ≤ 0（どのルールもB&H以下）」。
          検定統計量は T = max<sub>i</sub> max(0, √m·d̄<sub>i</sub>/ω̂<sub>i</sub>)
          （m=日数, d̄<sub>i</sub>=平均差, ω̂<sub>i</sub>=ブートストラップ標準誤差）で、
          「一族の中で最も良く見えるルール」のt統計量です。
          帰無分布は<span className="font-medium">定常ブートストラップ</span>（Politis–Romano:
          平均長Lの幾何ブロックで日を再抽出。ボラ・クラスタリング等の系列相関を保存）で作ります。
          再抽出の時間インデックスは全ルールで共有するため、ルール間の相関（同じ日に皆勝つ/負ける）も保存されます。
        </p>
        <p>
          再センタリング（Hansen 2005）: ブートストラップ平均 d̄*<sub>b,i</sub> から
          μ̂<sub>i</sub> を引いて帰無を課します。μ̂ の選び方で3つの p 値が出ます:
          <span className="font-medium"> SPA<sub>u</sub></span>（全ルールを境界 E[d]=0 に置く。WhiteのReality Check相当、最も保守的）、
          <span className="font-medium"> SPA<sub>c</sub></span>（√(2 log log m) 閾値より明確に劣るルールだけ負の平均のまま残す。推奨）、
          <span className="font-medium"> SPA<sub>l</sub></span>（負の平均を全て残す。最も甘い）。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 用語と直感的な例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">データ・スヌーピング</span>: 宝くじを1000枚買って「当たった1枚」を見せられても、くじに予知能力があった証拠にはなりません。11のルールから最良を選ぶのも同じで、「最良の成績」は偶然だけでもかなり良く見えます。SPAは「1000枚買った」ことを知った上で、その当たりが偶然の範囲を超えるかを測ります。</li>
          <li><span className="font-medium">定常ブートストラップ</span>: 過去の日々を「数日〜数週間の塊」のままシャッフルして偽の歴史を大量に作る方法。荒れた日が続く性質（ボラの塊）を壊さないので、現実的な「偶然の分布」が得られます。</li>
          <li><span className="font-medium">未補正p vs SPA p</span>: 未補正pは「そのルールだけを最初から決め打ちしていた場合」の有意性。選んだ後に読むと過大評価になります。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">SPA p &lt; 0.05</span>: 一族の最良ルールの優位は選択バイアスでは説明できません。タイミング判断に裏付けあり。保守的(SPA<sub>u</sub>)でも有意ならかなり頑健。</li>
          <li><span className="font-medium">SPA p ≥ 0.05 だが未補正 min p &lt; 0.05</span>: 典型的なスヌーピングの罠。個別分析では「有意なエッジ」に見えても、探した候補の数を考えると偶然の範囲です。</li>
          <li>グループ別SPAで「どの発想（学習/固定/アナログ）に価値の芽があるか」を切り分けられます。ただしグループ別も一族の一部を切り出した多重検定なので、全体SPAより甘くなることに注意。</li>
          <li>コストを 2〜10bp に上げると、売買回数の多いWF・アナログ族から先に優位が消えます。実務ではコスト込みの判定を基準にしてください。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>このカレンダー節の他の分析で魅力的なパターンを見つけても、まずここでSPA pを確認する「最後の門番」として使ってください（ヌル較正が構造の門番、これが経済価値の門番）。</li>
          <li>SPAが非有意なら、タイミングを計るより「持ち方」（ボラ・ターゲティング、資産配分、コスト・税の最適化）に労力を移す方が期待値が高い、という実務的結論になります。</li>
          <li>有意な場合も、最良ルールをそのまま使うのではなく、有意性が滞在率の低さ（リスク回避）由来かリターン獲得由来かをSharpeと年率差で確認してから建玉に落とすべきです。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">一族の範囲</span>: ここで補正できるのは実装済み11ルールの選択だけ。実際の分析では銘柄・期間・表示パラメータも探索しているため、真のスヌーピングはさらに大きい＝実際のpはここより悪い方向です。</li>
          <li><span className="font-medium">検出力</span>: 評価窓が短いと本物のエッジも有意になりません。年率差の点推定と併せて判断してください。</li>
          <li><span className="font-medium">ベンチマークの選択</span>: B&H比較は「常時ロングからの改善」を問う設計です。空売り主体の運用の価値は別の基準（対現金）で測る必要があります。</li>
          <li><span className="font-medium">簡易アナログ</span>: ここでのアナログは本家（cal-weekly-analog）の軽量版（ユークリッド近傍・週次判断のみ）。本家の予測力そのものの検証は cal-weekly-analog-oos を参照。</li>
          <li><span className="font-medium">構造変化</span>: 過去に有意でも将来の継続は保証されません。定期的に再実行し、評価窓を分割して安定性を見るのが安全です。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
