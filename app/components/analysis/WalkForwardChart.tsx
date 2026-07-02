"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import AnalysisGuide from "./AnalysisGuide";
import { runWalkForward, type WalkMode, type WalkForwardResult } from "../../lib/walk-forward";
import { buildSignalCatalog } from "../../lib/edge-signals";

interface Props {
  prices: PricePoint[];
}

const HEIGHT = 300;

function Badge({ label, value, tone, sub }: { label: string; value: string; tone: "good" | "bad" | "neutral"; sub?: string }) {
  const cls = tone === "good" ? "bg-green-50 border-green-200 text-green-700"
    : tone === "bad" ? "bg-red-50 border-red-200 text-red-700"
    : "bg-gray-50 border-gray-200 text-gray-700";
  return (
    <div className={`rounded border px-3 py-2 ${cls}`}>
      <div className="text-[10px] opacity-70">{label}</div>
      <div className="text-base font-bold font-mono">{value}</div>
      {sub && <div className="text-[10px] opacity-70">{sub}</div>}
    </div>
  );
}

export default function WalkForwardChart({ prices }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const isSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const oosSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  const [mode, setMode] = useState<WalkMode>("select");
  const [signalId, setSignalId] = useState<string>("");
  const [folds, setFolds] = useState(6);
  const [costBps, setCostBps] = useState(5);

  const catalog = useMemo(() => buildSignalCatalog(prices), [prices]);
  const effectiveSignalId = signalId || (catalog[0]?.id ?? "");

  const result: WalkForwardResult | null = useMemo(
    () => runWalkForward(prices, { mode, signalId: effectiveSignalId, folds, costBps }),
    [prices, mode, effectiveSignalId, folds, costBps],
  );

  // チャート初期化(一度だけ)
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: HEIGHT,
      crosshair: { mode: 0 },
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false },
    });
    chartRef.current = chart;
    isSeriesRef.current = chart.addSeries(LineSeries, { color: "#9ca3af", lineWidth: 2, title: "IS(検証除外)", lineStyle: LineStyle.Dotted });
    oosSeriesRef.current = chart.addSeries(LineSeries, { color: "#2563eb", lineWidth: 2, title: "OOS(実戦相当)" });
    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }); };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null; isSeriesRef.current = null; oosSeriesRef.current = null;
    };
  }, []);

  // エクイティ更新
  useEffect(() => {
    const isS = isSeriesRef.current, oosS = oosSeriesRef.current;
    if (!isS || !oosS) return;
    if (!result) { isS.setData([]); oosS.setData([]); return; }
    const isData: { time: Time; value: number }[] = [];
    const oosData: { time: Time; value: number }[] = [];
    let lastIs: { time: Time; value: number } | null = null;
    for (const p of result.equity) {
      if (!p.oos) { const pt = { time: p.date as Time, value: p.value }; isData.push(pt); lastIs = pt; }
      else oosData.push({ time: p.date as Time, value: p.value });
    }
    // 連続性のためOOS先頭にIS末尾を継ぐ
    if (lastIs && oosData.length > 0) oosData.unshift(lastIs);
    isS.setData(isData);
    oosS.setData(oosData);
    chartRef.current?.timeScale().fitContent();
  }, [result]);

  if (prices.length < 400) {
    return <div className="text-xs text-gray-400 p-3">データが不足しています(400営業日以上必要)。</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">ウォークフォワード頑健性</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          「過去に効いた」ではなく「先で効くか」。過去だけで選んだ戦略を、その先の未知区間で評価し、過剰最適化を露出させる。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="flex gap-1">
          {(["select", "fixed"] as WalkMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2.5 py-1 rounded font-medium ${mode === m ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {m === "select" ? "IS選抜(カタログ最良)" : "固定シグナル"}
            </button>
          ))}
        </div>
        {mode === "fixed" && (
          <label className="flex items-center gap-1">
            シグナル
            <select className="border rounded px-1 py-0.5" value={effectiveSignalId} onChange={(e) => setSignalId(e.target.value)}>
              {catalog.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1">
          フォールド数
          <select className="border rounded px-1 py-0.5" value={folds} onChange={(e) => setFolds(Number(e.target.value))}>
            {[4, 5, 6, 8, 10].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          コスト
          <input type="range" min={0} max={20} step={1} value={costBps} onChange={(e) => setCostBps(Number(e.target.value))} />
          <span className="font-mono w-10">{costBps}bps</span>
        </label>
      </div>

      {!result ? (
        <div className="text-xs text-gray-400">この設定では有効なフォールドを構成できません(フォールド数を減らすか期間を延ばしてください)。</div>
      ) : (
        <>
          {/* 頭出し指標 */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
            <Badge label="IS シャープ(年率)" value={result.isSharpeMean.toFixed(2)} tone="neutral" sub="過去最適の見かけ" />
            <Badge label="OOS シャープ(年率)" value={result.oosSharpeMean.toFixed(2)} tone={result.oosSharpeMean > 0 ? "good" : "bad"} sub="実戦相当" />
            <Badge label="減衰比 OOS/IS" value={result.decay.toFixed(2)} tone={result.decay > 0.5 ? "good" : "bad"} sub="1に近いほど頑健" />
            <Badge label="DSR" value={(result.dsr * 100).toFixed(0) + "%"} tone={result.dsr > 0.9 ? "good" : result.dsr > 0.5 ? "neutral" : "bad"} sub={`試行${result.nTrials}補正`} />
            <Badge label="PBO" value={(result.pbo * 100).toFixed(0) + "%"} tone={result.pbo < 0.3 ? "good" : result.pbo > 0.5 ? "bad" : "neutral"} sub="過剰最適化確率" />
          </div>

          {/* エクイティ曲線 */}
          <div>
            <div className="text-xs text-gray-500 mb-1">
              ウォークフォワード・エクイティ（{result.signalLabel}、コスト{result.costBps}bps）
              — 灰点線=検証除外の初期IS期間 / 青=各フォールドがIS期間だけで選んだ戦略の実戦リターン
            </div>
            <div ref={containerRef} className="w-full rounded border border-gray-100" />
          </div>

          {/* フォールド表 */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-1.5">OOS期間</th>
                  <th className="text-left px-1.5">IS選抜シグナル</th>
                  <th className="text-right px-1">IS Sharpe</th>
                  <th className="text-right px-1">OOS Sharpe</th>
                  <th className="text-right px-1.5">OOS順位</th>
                </tr>
              </thead>
              <tbody>
                {result.folds.map((f, i) => (
                  <tr key={i} className="border-b border-gray-100">
                    <td className="py-1 px-1.5 font-mono whitespace-nowrap text-gray-600">{f.oosStartDate}〜{f.oosEndDate}</td>
                    <td className="px-1.5">{f.selectedLabel}</td>
                    <td className="text-right px-1 font-mono text-gray-500">{f.isSharpe.toFixed(2)}</td>
                    <td className={`text-right px-1 font-mono ${f.oosSharpe > 0 ? "text-green-600" : "text-red-600"}`}>{f.oosSharpe.toFixed(2)}</td>
                    <td className="text-right px-1.5 font-mono text-gray-600">{Math.round(f.oosRank * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-gray-400">
            OOS順位=そのフォールドのOOSで、選抜シグナルがカタログ中どれだけ上位か(100%=最良)。IS選抜が毎回OOSでも上位なら頑健、下位に沈むなら過剰最適化。
          </p>
        </>
      )}

      <AnalysisGuide title="ウォークフォワード頑健性の詳細理論">
        <p className="font-medium text-gray-700">1. なぜ必要か</p>
        <p>
          あらゆるバックテストは「過去に最も効いた」を選ぶため、偶然のノイズに過剰適合(オーバーフィット)しがちです。
          過去全体で最良に見える戦略が、将来もそうとは限りません。ウォークフォワードは時間を過去(IS)と未来(OOS)に分け、
          <span className="font-medium">過去だけで選んだ戦略を、その先の未知期間で採点</span>することで、実戦に近い成績を測ります。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 手順(アンカー式)</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>時系列を時間順にK個のブロックへ分割。</li>
          <li>各フォールドで、先頭からそのブロック直前まで(IS)で<span className="font-medium">シャープ最大のシグナルを選抜</span>(選抜モード)。固定モードは指定シグナルをそのまま使う。</li>
          <li>選んだ戦略を<span className="font-medium">次のブロック(OOS)</span>で運用し、成績を記録。これをブロックを進めながら繰り返す。</li>
          <li>OOSリターンを連結したものが、擬似的な「実戦エクイティ」。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 頭出し指標</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">減衰比 OOS/IS:</span> OOSシャープ ÷ ISシャープ。1に近いほど過去の優位が未来に持続。0以下なら過去の勝ちは見かけ倒し。</li>
          <li><span className="font-medium">DSR (Deflated Sharpe Ratio):</span> 「N個も試せばどれか高シャープに見える」効果を補正した、シャープが真に正である確率。
            {" "}{"DSR = Φ( (SR − SR₀)·√(n−1) / √(1 − γ₃·SR + (γ₄−1)/4·SR²) )"}。SR₀は試行数Nから決まる“偶然の最高シャープ”の期待値。90%超なら本物らしい。</li>
          <li><span className="font-medium">PBO (Probability of Backtest Overfitting):</span> IS最良戦略がOOSで中央値を下回る頻度。高い(&gt;50%)ほど「過去の勝者は未来の敗者」で、選抜が過剰最適化に支配されている。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>青のOOS曲線が右肩上がりで、減衰比が高く、DSR高・PBO低——この4点が揃えば、その探索プロセス自体が信頼できる。</li>
          <li>フォールド表でISとOOSのSharpeが大きく乖離する行=その時期に過剰最適化が起きた。OOS順位が低い行が続けばPBOが上がる。</li>
          <li>コストbpsを上げるとOOSが崩れるなら、それは実運用で消えるエッジ。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>交互作用スキャン(A)やレジームマップ(B)で見つけた候補が、ここで頑健なら初めて実運用の土俵に乗る。</li>
          <li>コスト感度スライダで、自分の売買コストに合わせた実効エッジの残り方を確認する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">単一時系列:</span> 1銘柄の履歴での分割のため、フォールド数を増やすとOOSが短くなり推定が不安定。</li>
          <li><span className="font-medium">カタログ依存:</span> 選抜対象は用意したシグナルの範囲。真に良い戦略がカタログ外なら発見できない。</li>
          <li><span className="font-medium">DSR/PBOは近似:</span> 独立試行や正規性など理想化した仮定に基づく目安であり、絶対的な合否判定ではない。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
