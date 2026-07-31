"use client";

import React, { useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import AnalysisGuide from "./AnalysisGuide";
import {
  buildRegimeEdgeMap,
  REGIME_SCHEMES,
  type RegimeScheme,
  type RegimeEdgeCell,
} from "../../lib/regime-edge-map";
import { roundTripCost } from "../../lib/strategy-vs-benchmark";
import { representativeSpread } from "../../lib/spread-estimator";

interface Props {
  prices: PricePoint[];
}

type Metric = "sharpe" | "annualized" | "meanRet";

const METRICS: { value: Metric; label: string }[] = [
  { value: "sharpe", label: "年率シャープ" },
  { value: "annualized", label: "年率リターン" },
  { value: "meanRet", label: "平均日次" },
];

function metricValue(c: RegimeEdgeCell, m: Metric): number {
  return m === "sharpe" ? c.sharpe : m === "annualized" ? c.annualized : c.meanRet;
}
function fmtMetric(c: RegimeEdgeCell, m: Metric): string {
  if (m === "sharpe") return c.sharpe.toFixed(2);
  if (m === "annualized") return (c.annualized * 100).toFixed(1) + "%";
  return (c.meanRet * 100).toFixed(3) + "%";
}
function star(p: number): string { return p < 0.01 ? "***" : p < 0.05 ? "**" : p < 0.1 ? "*" : ""; }

function cellBg(v: number, maxAbs: number): string {
  const t = Math.min(1, Math.abs(v) / (maxAbs || 1e-9));
  return v > 0 ? `rgba(22,163,74,${0.08 + 0.72 * t})` : `rgba(220,38,38,${0.08 + 0.72 * t})`;
}

export default function RegimeEdgeMapChart({ prices }: Props) {
  const [scheme, setScheme] = useState<RegimeScheme>("vol");
  const [metric, setMetric] = useState<Metric>("sharpe");

  const [deduct, setDeduct] = useState(false);
  const [feeBps, setFeeBps] = useState(0);
  const spreadRT = useMemo(() => representativeSpread(prices), [prices]);
  const costRT = useMemo(
    () => roundTripCost({ enabled: deduct, spreadRT, feeBps }),
    [deduct, spreadRT, feeBps]
  );
  const map = useMemo(() => buildRegimeEdgeMap(prices, scheme, costRT), [prices, scheme, costRT]);

  const maxAbs = useMemo(() => {
    let mx = 1e-9;
    for (const row of map.rows) for (const c of row.byRegime) if (c) mx = Math.max(mx, Math.abs(metricValue(c, metric)));
    return mx;
  }, [map, metric]);

  if (prices.length < 260) {
    return <div className="text-xs text-gray-400 p-3">データが不足しています(260営業日以上推奨)。</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">レジーム別エッジマップ</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          各シグナルが「どの市場局面でだけ効くか」を一望。現在レジーム列(青)が、今どのエッジに賭けるべきかを示す。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          レジーム分類
          <select className="border rounded px-1 py-0.5" value={scheme} onChange={(e) => setScheme(e.target.value as RegimeScheme)}>
            {REGIME_SCHEMES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          指標
          <select className="border rounded px-1 py-0.5" value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        {map.nowRegime && (
          <span className="text-gray-500">
            現在の局面: <span className="text-blue-600 font-medium">{map.nowRegime}</span>
          </span>
        )}
        <label className="flex items-center gap-1.5 cursor-pointer" title="シグナルごとに回転率を実測し、往復コストを建玉日に配分して控除する">
          <input type="checkbox" checked={deduct} onChange={(e) => setDeduct(e.target.checked)} />
          <span className={deduct ? "font-medium text-gray-800" : "text-gray-600"}>コスト控除</span>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">片道</span>
          <input
            type="number" min={0} max={200} step={1} value={feeBps}
            onChange={(e) => setFeeBps(Math.max(0, Number(e.target.value) || 0))}
            className="w-14 px-1 py-0.5 border border-gray-200 rounded font-mono text-right"
            disabled={!deduct}
          />
          <span className="text-gray-500">bps</span>
        </label>
        <span className="text-gray-500">
          往復 <span className="font-mono">{(costRT * 100).toFixed(3)}%</span>
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 px-1.5">シグナル</th>
              <th className="text-right px-1.5 text-gray-400" title="年間往復回数。高いほどコストに弱い">回転/年</th>
              <th className="text-right px-1.5 text-gray-400">全体</th>
              {map.regimeOrder.map((r, j) => (
                <th
                  key={r}
                  className={`text-right px-1.5 ${r === map.nowRegime ? "text-blue-600 font-semibold" : ""}`}
                >
                  {r}
                  <div className="text-[9px] text-gray-400 font-normal">n={map.regimeCounts[j]}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {map.rows.map((row) => (
              <tr key={row.edge.id} className="border-b border-gray-100">
                <td className="py-1 px-1.5 whitespace-nowrap">
                  <span className="text-gray-700">{row.edge.label}</span>
                  <span className="text-gray-400 ml-1 text-[10px]">{row.edge.category}</span>
                </td>
                <td
                  className={`text-right px-1.5 font-mono ${row.tripsPerYear >= 50 ? "text-amber-700" : "text-gray-400"}`}
                  title={deduct ? `建玉日1日あたり −${(row.costPerDay * 100).toFixed(4)}% を控除` : undefined}
                >
                  {row.tripsPerYear.toFixed(0)}
                </td>
                <td className="text-right px-1.5 font-mono text-gray-500">
                  {row.overall ? fmtMetric(row.overall, metric) : "–"}
                </td>
                {row.byRegime.map((c, j) => {
                  const isNow = map.regimeOrder[j] === map.nowRegime;
                  if (!c) return <td key={j} className="text-right px-1.5 text-gray-300">–</td>;
                  const v = metricValue(c, metric);
                  const sig = c.pAdj < 0.05;
                  return (
                    <td
                      key={j}
                      className={`text-right px-1.5 font-mono ${isNow ? "ring-2 ring-inset ring-blue-400" : ""}`}
                      style={{ backgroundColor: cellBg(v, maxAbs) }}
                      title={`n=${c.n} / 勝率${Math.round(c.winRate * 100)}% / p_adj=${c.pAdj.toFixed(3)}`}
                    >
                      <span className={sig ? "font-semibold" : ""}>{fmtMetric(c, metric)}</span>
                      <span className="text-blue-700">{star(c.pAdj)}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-gray-400">
        緑=プラス/赤=マイナス、濃さ=絶対値。★=FDR補正後p値(**&lt;0.05)。青枠列=現在の局面。セルにマウスでn・勝率・p_adjを表示。
        「全体」列は参考(FDR非対象)。同じシグナルでも局面によって符号・強度が反転することに注目。
      </p>

      <AnalysisGuide title="レジーム別エッジマップの詳細理論">
        <p className="font-medium text-gray-700">1. なぜ局面別に見るのか</p>
        <p>
          エッジは常時効くわけではなく、特定の市場局面(レジーム)でだけ立つのが普通です。モメンタムは平穏な上昇相場で効き、
          高ボラの暴落局面では逆に損をする——このように「いつ効くか」を知らずに全期間平均だけ見ると、局面をまたいで
          相殺され、本当は使えるエッジを見落とします。本ツールは各シグナルの成績を局面ごとに分解します。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. レジームの定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">ボラ局面:</span> 直近20日の実現ボラ(日次リターンの標準偏差)を全期間の3分位で低/中/高に分類。</li>
          <li><span className="font-medium">トレンド局面:</span> 終値と200日移動平均の乖離で上昇(+3%超)/レンジ/下降(−3%未満)。</li>
          <li><span className="font-medium">ドローダウン局面:</span> 過去最高値からの下落率で平時(&gt;−5%)/調整(−5〜−15%)/暴落(&lt;−15%)。</li>
          <li><span className="font-medium">HMM 3状態:</span> 隠れマルコフモデルで日次リターンを弱気/中立/強気の潜在状態に分ける(全標本フィット=記述的)。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 各セルの計算</p>
        <p>
          セル値は「そのシグナルが建玉を持った日(活性日)のうち、その局面に属する日」の翌日リターン(建玉の符号を掛けた値)を集計したものです。
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"平均日次 = mean(建玉方向 × 翌日リターン)"}</li>
          <li>{"年率シャープ = (平均日次 / 標準偏差) × √252"}</li>
          <li>{"年率リターン = 平均日次 × 252"}</li>
          <li><span className="font-medium">t検定 + FDR補正:</span> 各セルが0と異なるかを検定し、全レジームセル横断でBenjamini-Hochberg補正。★が有意。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">横方向の変化:</span> 同じシグナルの行を左右に見て、局面で色・強度がどう変わるか。特定局面だけ濃い緑=そこ専用のエッジ。</li>
          <li><span className="font-medium">符号反転:</span> ある局面で緑・別局面で赤=局面を判定してからでないと使えない(全期間平均では消える)。</li>
          <li><span className="font-medium">青枠列:</span> 今の局面。この列で濃い緑かつ★のシグナルが、目下有効な候補。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>現在レジーム列を見て、稼働させるシグナルを切り替える(レジーム・スイッチング)。</li>
          <li>「全体」列では平凡でも特定局面で突出するシグナルを、局面フィルタ付きで運用する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">局面判定の遅延:</span> レジームは事後的に確定しやすく、リアルタイムでは誤判定が起きる。特にHMMは全標本フィットで、実運用より楽観的に見える。</li>
          <li><span className="font-medium">サンプル分割:</span> 局面ごとに日数が減り、暴落など稀な局面はNが小さくノイズが大きい。</li>
          <li><span className="font-medium">コスト:</span> 上の「コスト控除」をONにすると、シグナルごとに回転率 Σ|Δpos|/2 を実測し、総コスト（1往復あたり −ln(1−c)）を建玉日に均等配分してセル値から引く。<strong>回転の速いシグナルほど自動的に重く罰せられる</strong>ので、コスト後のセル比較が公平になる。「回転/年」列が50を超える行は琥珀色で警告している。既定はOFF（コスト前）。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
