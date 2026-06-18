"use client";

import { useState } from "react";
import {
  SignalEvent,
  SIGNAL_EVENTS,
  SIGNAL_EVENT_META,
  Horizon,
  HORIZON_CONFIG,
} from "../../lib/signal-digest";
import { BacktestResult, EventStat } from "../../lib/badge-backtest";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  result: BacktestResult | null;
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

// Tailwind は動的クラス名を生成しないため、リテラルで対応付ける。
const LABEL_COLOR: Record<string, string> = {
  red: "text-red-600",
  amber: "text-amber-600",
  green: "text-emerald-600",
};

function stat5(stats: EventStat[]): EventStat | undefined {
  return stats.find((s) => s.horizon === 5);
}

export default function BadgeTrackRecordPanel({ result, running, progress, onRun, horizon }: Props) {
  const [open, setOpen] = useState(true);

  const baseMedian = (h: number) => result?.baseRate.find((s) => s.horizon === h)?.median ?? 0;

  const eventRow = (ev: SignalEvent) => {
    if (!result) return null;
    const stats = result.byEvent[ev];
    const meta = SIGNAL_EVENT_META[ev];
    const n5 = stat5(stats)?.n ?? 0;
    const pDown5 = stat5(stats)?.pDown ?? 0;
    const accent =
      ev === "deterioration" ? "bg-red-50/60" : "";
    return (
      <tr key={ev} className={`border-t border-gray-100 ${accent}`}>
        <td className="px-2 py-1.5 whitespace-nowrap">
          <span className={`font-medium ${LABEL_COLOR[meta.color] ?? "text-gray-700"}`}>{meta.label}</span>
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-gray-400">{n5}</td>
        {result.evalHorizons.map((h) => {
          const s = stats.find((x) => x.horizon === h);
          const m = s?.median ?? 0;
          const lift = m - baseMedian(h);
          return (
            <td
              key={h}
              className={`px-2 py-1.5 text-right tabular-nums ${retColor(m)}`}
              title={`中央値${m.toFixed(2)}% / 地合い比 ${lift >= 0 ? "+" : ""}${lift.toFixed(2)}pt / 四分位 ${s?.p25.toFixed(1)}〜${s?.p75.toFixed(1)}% / n=${s?.n}`}
            >
              {m >= 0 ? "+" : ""}
              {m.toFixed(1)}
            </td>
          );
        })}
        <td className="px-2 py-1.5 text-right tabular-nums">
          <span className={pDown5 > 0.6 ? "text-red-600 font-medium" : "text-gray-500"}>
            {(pDown5 * 100).toFixed(0)}%
          </span>
        </td>
      </tr>
    );
  };

  const det = result ? stat5(result.byEvent.deterioration) : undefined;
  const detLift5 = det ? det.median - baseMedian(5) : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 w-full text-left">
        <span className="inline-block transition-transform" style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>
          ▶
        </span>
        <span className="font-semibold text-gray-800">判定の実績(バックテスト)</span>
        <span className="text-xs text-gray-400">
          シグナル点灯後の前方リターン分布（{HORIZON_CONFIG[horizon].label}・横断プール）
        </span>
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          <div className="flex items-center gap-3">
            <button
              onClick={onRun}
              disabled={running}
              className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {running ? "計算中…" : result ? "再計算" : "実績を計算"}
            </button>
            {running && (
              <span className="text-xs text-gray-400">
                {progress.done}/{progress.total} 銘柄(数十秒かかります)
              </span>
            )}
            {result && !running && (
              <span className="text-xs text-gray-400">
                {result.nStocks}銘柄 / {result.totalEvals.toLocaleString()}評価点 / {result.from}〜{result.to}
              </span>
            )}
          </div>

          {result?.ok ? (
            <>
              {det && det.n > 0 && (
                <div className="bg-red-50 text-red-700 text-xs rounded p-2 border border-red-200">
                  悪化シグナル点灯後5日:中央値 <b>{det.median.toFixed(1)}%</b>(地合い比 {detLift5 >= 0 ? "+" : ""}
                  {detLift5.toFixed(1)}pt)、続落確率 <b>{(det.pDown * 100).toFixed(0)}%</b>(n={det.n})。
                  {detLift5 < -0.5
                    ? " 地合いより明確に下振れ＝損切り警告に弁別力あり。"
                    : " 地合いとの差が小さい＝弁別力は限定的。閾値の見直し余地。"}
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500">
                      <th className="px-2 py-1 text-left font-medium">事象</th>
                      <th className="px-2 py-1 text-right font-medium">n</th>
                      {result.evalHorizons.map((h) => (
                        <th key={h} className="px-2 py-1 text-right font-medium">
                          {h}日
                        </th>
                      ))}
                      <th className="px-2 py-1 text-right font-medium">続落@5d</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SIGNAL_EVENTS.map(eventRow)}
                    <tr className="border-t-2 border-gray-200 text-gray-500">
                      <td className="px-2 py-1.5 whitespace-nowrap">ベースレート(無条件)</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-gray-400">
                        {stat5(result.baseRate)?.n ?? 0}
                      </td>
                      {result.evalHorizons.map((h) => {
                        const m = result.baseRate.find((x) => x.horizon === h)?.median ?? 0;
                        return (
                          <td key={h} className={`px-2 py-1.5 text-right tabular-nums ${retColor(m)}`}>
                            {m >= 0 ? "+" : ""}
                            {m.toFixed(1)}
                          </td>
                        );
                      })}
                      <td className="px-2 py-1.5 text-right tabular-nums text-gray-400">
                        {((stat5(result.baseRate)?.pDown ?? 0) * 100).toFixed(0)}%
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-gray-400">
                各セルは前方リターンの中央値(%)。ホバーで地合い比・四分位・標本数。色: 赤=下落 / 緑=上昇。
              </p>
            </>
          ) : (
            !running && (
              <p className="text-xs text-gray-400">
                「実績を計算」を押すと、各シグナルが過去に点灯した後のリターンを集計します。
              </p>
            )
          )}

          <AnalysisGuide title="判定の実績化(バックテスト)の詳細">
            <p className="font-medium text-gray-700">1. 何を見ているか</p>
            <p>
              バッジ(損切り警告など)の閾値は経験則です。これが<strong>過去に当たっていたか</strong>を確かめます。
              過去の各営業日を「その日までのデータだけ」で再現してシグナルを判定し、点灯後 1〜15 日のリターンを集めて分布にします。
              保有10銘柄ぶんを横断プールし、統計の母数を確保します。
            </p>
            <p className="font-medium text-gray-700 mt-3">2. 読み方</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><strong>中央値</strong>: 点灯後にだいたいどれだけ動いたか(%)。悪化シグナルなら負が深いほど「下落を先取りできた」。</li>
              <li><strong>地合い比(ホバー)</strong>: 無条件ベースレート(何もしない時の平均)との差。これが弁別力。差が小さいシグナルは「鳴っても鳴らなくても同じ」。</li>
              <li><strong>続落@5d</strong>: 点灯後5日でさらに下げた割合。損切り判断の信頼度に直結。</li>
              <li><strong>n</strong>: 標本数。小さいと統計的に当てにならない。</li>
            </ul>
            <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>ライブの損切り警告に、その実績(中央値・続落確率)を併記。数字で「今回も信じるか」を判断する。</li>
              <li>地合い比が小さい事象は、閾値を厳しくして空振りを減らす検討材料に。</li>
            </ul>
            <p className="font-medium text-gray-700 mt-3">4. 注意点</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>評価日を間引いている(既定3日刻み)ため、近接した観測は重複し独立試行ではない。標本数は額面より割り引いて見る。</li>
              <li>対象は直近3年。強気相場で得た実績は弱気相場で崩れる(レジーム依存)。期間表示を確認。</li>
              <li>手数料・スリッページ未考慮。前方リターンは終値ベースの理論値。</li>
            </ul>
          </AnalysisGuide>
        </div>
      )}
    </div>
  );
}
