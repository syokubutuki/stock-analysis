"use client";

import { useState } from "react";
import { Horizon, HORIZON_CONFIG } from "../../lib/signal-digest";
import {
  StopCompareResult,
  ExitRule,
  EXIT_RULE_LABEL,
} from "../../lib/stop-compare";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  result: StopCompareResult | null;
  running: boolean;
  progress: { done: number; total: number };
  onRun: () => void;
  horizon: Horizon;
}

function retColor(v: number): string {
  if (v <= -0.05) return "text-red-600";
  if (v >= 0.05) return "text-emerald-600";
  return "text-gray-500";
}

const RULE_ACCENT: Record<ExitRule, string> = {
  model: "bg-blue-50/60",
  fixed: "",
  atr: "",
};

export default function StopComparePanel({ result, running, progress, onRun, horizon }: Props) {
  const [open, setOpen] = useState(true);

  const model = result?.rules.find((r) => r.rule === "model");
  const atr = result?.rules.find((r) => r.rule === "atr");

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 w-full text-left">
        <span className="inline-block transition-transform" style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>
          ▶
        </span>
        <span className="font-semibold text-gray-800">損切り出口の比較(モデル vs 機械ストップ)</span>
        <span className="text-xs text-gray-400">中立エントリーで出口ルールだけを比較・{HORIZON_CONFIG[horizon].label}</span>
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          <div className="flex items-center gap-3">
            <button
              onClick={onRun}
              disabled={running}
              className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {running ? "計算中…" : result ? "再計算" : "比較を計算"}
            </button>
            {running && (
              <span className="text-xs text-gray-400">
                {progress.done}/{progress.total} 銘柄(数十秒〜1分)
              </span>
            )}
            {result && !running && (
              <span className="text-xs text-gray-400">
                {result.nStocks}銘柄 / {result.nTrades.toLocaleString()}トレード / {result.from}〜{result.to}
              </span>
            )}
          </div>

          {result?.ok ? (
            <>
              {model && atr && result.warnTrades > 0 && (
                <div className="bg-blue-50 text-blue-800 text-xs rounded p-2 border border-blue-200">
                  悪化シグナルでの手仕舞いは、トレーリングATRストップより中央値で{" "}
                  <b>{result.leadDaysVsAtr >= 0 ? `${result.leadDaysVsAtr.toFixed(0)}日早く` : `${(-result.leadDaysVsAtr).toFixed(0)}日遅く`}</b>
                  出られ、ピークからの戻し幅は{" "}
                  <b>{result.giveBackDiffVsAtr >= 0 ? `${result.giveBackDiffVsAtr.toFixed(1)}pt浅い` : `${(-result.giveBackDiffVsAtr).toFixed(1)}pt深い`}</b>
                  (n={result.warnTrades})。
                  {result.leadDaysVsAtr > 0 && result.giveBackDiffVsAtr > 0
                    ? " 損切りの遅れ改善に寄与。"
                    : " 機械ストップに対する優位は限定的。"}
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500">
                      <th className="px-2 py-1 text-left font-medium">出口ルール</th>
                      <th className="px-2 py-1 text-right font-medium">トレード</th>
                      <th className="px-2 py-1 text-right font-medium">実現中央値</th>
                      <th className="px-2 py-1 text-right font-medium">平均</th>
                      <th className="px-2 py-1 text-right font-medium">損失率</th>
                      <th className="px-2 py-1 text-right font-medium">損失中央値</th>
                      <th className="px-2 py-1 text-right font-medium">最悪</th>
                      <th className="px-2 py-1 text-right font-medium">戻し幅</th>
                      <th className="px-2 py-1 text-right font-medium">保有日数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rules.map((r) => (
                      <tr key={r.rule} className={`border-t border-gray-100 ${RULE_ACCENT[r.rule]}`}>
                        <td className="px-2 py-1.5 whitespace-nowrap font-medium text-gray-700">
                          {EXIT_RULE_LABEL[r.rule]}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-gray-400">{r.n}</td>
                        <td className={`px-2 py-1.5 text-right tabular-nums ${retColor(r.medianRet)}`}>
                          {r.medianRet >= 0 ? "+" : ""}
                          {r.medianRet.toFixed(2)}%
                        </td>
                        <td className={`px-2 py-1.5 text-right tabular-nums ${retColor(r.meanRet)}`}>
                          {r.meanRet >= 0 ? "+" : ""}
                          {r.meanRet.toFixed(2)}%
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">
                          {(r.pLoss * 100).toFixed(0)}%
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-red-600">
                          {r.medianLoss.toFixed(2)}%
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-red-600">
                          {r.worst.toFixed(1)}%
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">
                          {r.medianGiveBack.toFixed(2)}%
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-gray-400">
                          {r.medianHold.toFixed(0)}日
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-gray-400">
                戻し幅=手仕舞い時のピークからの下落幅(0に近いほど高値近くで出られた=遅れが小さい)。実現リターンは終値ベース・手数料未考慮。
              </p>
            </>
          ) : (
            !running && (
              <p className="text-xs text-gray-400">
                「比較を計算」で、中立エントリー(5日ごと・最大15日保有)に対し、悪化シグナル・固定−5%・トレーリングATRの3つの出口を当てはめて比較します。
              </p>
            )
          )}

          <AnalysisGuide title="損切り出口比較の詳細">
            <p className="font-medium text-gray-700">1. 何を比べているか</p>
            <p>
              「悪化シグナルで手仕舞いする」やり方が、機械的なストップ(取得来 −5% / トレーリングATR)より
              <strong>早く・浅く損切りできるか</strong>を検証します。エントリーの巧拙を排除するため、
              全銘柄で5日ごとに機械的に建玉し(中立エントリー)、出口ルールだけを差し替えて比較します。
            </p>
            <p className="font-medium text-gray-700 mt-3">2. ルール</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><strong>モデル</strong>: 悪化シグナル(下方反転 or 変化点)が点灯した日の終値で手仕舞い。</li>
              <li><strong>固定 −5%</strong>: 取得値から5%下落で手仕舞い。</li>
              <li><strong>トレーリングATR</strong>: 直近ピークから 2.5×ATR(14日)下落で手仕舞い。</li>
              <li>いずれも最大15日保有(到達時は時間切れ手仕舞い)。</li>
            </ul>
            <p className="font-medium text-gray-700 mt-3">3. 読み方</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><strong>損失率・損失中央値・最悪</strong>: 損切りの効きを見る。小さいほど損失を抑えられている。</li>
              <li><strong>戻し幅</strong>: 手仕舞い時にピークからどれだけ下げていたか。0に近い=高値近くで素早く出られた=遅れが小さい。</li>
              <li><strong>上部サマリー</strong>: モデルがATRストップより何日早く・何pt浅く出られたか。あなたの「損切りが遅れる」痛点に直結。</li>
            </ul>
            <p className="font-medium text-gray-700 mt-3">4. 注意点</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>中立エントリーは「どこでも等確率で買う」前提。実際のエントリーの良し悪しは含まない(出口だけの比較)。</li>
              <li>近接したエントリーは値動きが重複し独立試行ではない。標本数は割り引いて見る。</li>
              <li>終値ベース・手数料/スリッページ未考慮。寄り引けのギャップは反映されない。</li>
              <li>対象は直近2年。レジームが変われば結果も変わる。</li>
            </ul>
          </AnalysisGuide>
        </div>
      )}
    </div>
  );
}
