"use client";

import { useEffect, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  conditionalForwardReturns,
  buildCustomStateFn,
  CUSTOM_METRICS,
  CustomMetric,
} from "../../lib/conditional-forward-returns";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  minBars?: number;
}

const HORIZONS = [1, 5, 10, 20];
const BIN_OPTIONS = [3, 4, 5, 6, 8, 10];
const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

function retBg(v: number, maxAbs: number): string {
  const t = maxAbs > 0 ? Math.min(1, Math.abs(v) / maxAbs) : 0;
  if (v >= 0) return `rgba(22, 163, 74, ${0.08 + t * 0.55})`;
  return `rgba(220, 38, 38, ${0.08 + t * 0.55})`;
}

export default function CustomBucketChart({ prices, minBars = 250 }: Props) {
  const [metric, setMetric] = useState<CustomMetric>("rsi");
  const desc = CUSTOM_METRICS.find((m) => m.value === metric)!;

  const [param, setParam] = useState(desc.defaultParam);
  const [mode, setMode] = useState<"fixed" | "quantile">("fixed");
  const [thresholdText, setThresholdText] = useState(desc.defaultThresholds.join(", "));
  const [bins, setBins] = useState(4);
  const [horizon, setHorizon] = useState(5);
  const [entry, setEntry] = useState<"close" | "open">("close");

  // 指標切替時に既定パラメータ/閾値へリセット
  useEffect(() => {
    setParam(desc.defaultParam);
    setThresholdText(desc.defaultThresholds.join(", "));
  }, [metric, desc]);

  const thresholds = useMemo(
    () =>
      thresholdText
        .split(/[,、\s]+/)
        .map((s) => Number(s.trim()))
        .filter((x) => Number.isFinite(x)),
    [thresholdText]
  );

  const result = useMemo(() => {
    if (prices.length < minBars) return null;
    const st = buildCustomStateFn(prices, { metric, param, mode, thresholds, bins });
    return conditionalForwardReturns(prices, st, horizon, { entry });
  }, [prices, metric, param, mode, thresholds, bins, horizon, entry, minBars]);

  if (prices.length < minBars) return null;
  if (!result || result.buckets.length === 0) return null;

  const maxAbs = Math.max(1e-9, ...result.buckets.map((b) => Math.abs(b.meanFwd)));
  const nowBucket = result.buckets.find((b) => b.label === result.nowLabel) ?? null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">カスタム条件ビルダー（任意の指標・閾値・分位）</h3>
        <div className="flex gap-1">
          {(["close", "open"] as const).map((e) => (
            <button
              key={e}
              onClick={() => setEntry(e)}
              className={`px-2.5 py-1 text-xs rounded font-medium ${entry === e ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {e === "close" ? "当日引け建て" : "翌日寄り建て"}
            </button>
          ))}
        </div>
      </div>

      {/* 指標 */}
      <div className="flex gap-1 flex-wrap">
        {CUSTOM_METRICS.map((m) => (
          <button
            key={m.value}
            onClick={() => setMetric(m.value)}
            className={`px-2.5 py-1 text-xs rounded font-medium ${metric === m.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* パラメータ + 分割方法 */}
      <div className="flex items-center gap-3 text-xs text-gray-600 flex-wrap rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
        {desc.paramLabel && (
          <span className="flex items-center gap-1">
            {desc.paramLabel}:
            <input
              type="number"
              min={1}
              max={500}
              value={param}
              onChange={(e) => setParam(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
              className="w-16 px-1.5 py-0.5 border border-gray-300 rounded"
            />
            日
          </span>
        )}
        <div className="flex gap-1 ml-1">
          {(["fixed", "quantile"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2 py-0.5 rounded ${mode === m ? "bg-indigo-600 text-white" : "bg-white border border-gray-200 hover:bg-gray-100"}`}
            >
              {m === "fixed" ? "固定閾値" : "等頻度分位"}
            </button>
          ))}
        </div>
        {mode === "fixed" ? (
          <span className="flex items-center gap-1">
            境界({desc.unit || "値"}, カンマ区切り):
            <input
              type="text"
              value={thresholdText}
              onChange={(e) => setThresholdText(e.target.value)}
              className="w-40 px-1.5 py-0.5 border border-gray-300 rounded font-mono"
              placeholder={desc.defaultThresholds.join(", ")}
            />
            <button
              onClick={() => setThresholdText(desc.defaultThresholds.join(", "))}
              className="px-1.5 py-0.5 rounded bg-white border border-gray-200 hover:bg-gray-100"
            >
              既定
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1">
            分割数:
            {BIN_OPTIONS.map((b) => (
              <button
                key={b}
                onClick={() => setBins(b)}
                className={`px-2 py-0.5 rounded ${bins === b ? "bg-indigo-600 text-white" : "bg-white border border-gray-200 hover:bg-gray-100"}`}
              >
                {b}
              </button>
            ))}
          </span>
        )}
      </div>

      {/* ホライズン */}
      <div className="flex items-center gap-2 text-xs text-gray-600 flex-wrap">
        <span>先行き日数 N:</span>
        {HORIZONS.map((h) => (
          <button
            key={h}
            onClick={() => setHorizon(h)}
            className={`px-2 py-0.5 rounded ${horizon === h ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
          >
            {h}日
          </button>
        ))}
        <span className="ml-auto text-gray-400">全標本 {result.totalN}日 / 基準平均 {fmtPct(result.baselineMean)}・勝率 {(result.baselineWin * 100).toFixed(0)}%</span>
      </div>

      {/* 現在バナー */}
      {nowBucket && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          <span className="font-bold">現在の状態: {result.nowLabel}</span>
          {" → "}過去同状態の{horizon}日先は{" "}
          <span className="font-bold">平均 {fmtPct(nowBucket.meanFwd)}</span>・勝率{" "}
          <span className="font-bold">{(nowBucket.winRate * 100).toFixed(0)}%</span>
          {" "}（n={nowBucket.n}、95%CI {fmtPct(nowBucket.ciLow)}〜{fmtPct(nowBucket.ciHigh)}）{" "}
          <StatBadge n={nowBucket.n} p={nowBucket.p} significant={nowBucket.significant} />
        </div>
      )}

      {/* 表 */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 px-2">状態（{desc.label}）</th>
              <th className="text-right px-2">n</th>
              <th className="text-right px-2">平均{horizon}日</th>
              <th className="text-right px-2">中央値</th>
              <th className="text-left px-2">勝率</th>
              <th className="text-left px-2">95%CI</th>
              <th className="text-left px-2">有意性</th>
            </tr>
          </thead>
          <tbody>
            {result.buckets.map((b) => {
              const isNow = b.label === result.nowLabel;
              return (
                <tr key={b.label} className={`border-b border-gray-100 ${isNow ? "ring-2 ring-blue-400 ring-inset" : ""}`}>
                  <td className="py-1 px-2 font-medium text-gray-700">
                    {isNow && <span className="text-blue-600 mr-1">◀</span>}
                    {b.label}
                  </td>
                  <td className="text-right px-2 text-gray-600">{b.n}</td>
                  <td className="text-right px-2 font-medium" style={{ background: retBg(b.meanFwd, maxAbs) }}>
                    {fmtPct(b.meanFwd)}
                  </td>
                  <td className="text-right px-2 text-gray-600">{fmtPct(b.medianFwd)}</td>
                  <td className="px-2">
                    <div className="flex items-center gap-1">
                      <div className="relative h-3 w-14 bg-gray-100 rounded-sm overflow-hidden">
                        <div
                          className={`absolute inset-y-0 left-0 ${b.winRate >= 0.5 ? "bg-green-400" : "bg-red-400"}`}
                          style={{ width: `${b.winRate * 100}%` }}
                        />
                        <div className="absolute inset-y-0 left-1/2 w-px bg-gray-400" />
                      </div>
                      <span className="text-gray-600 tabular-nums">{(b.winRate * 100).toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="px-2 text-gray-500 whitespace-nowrap">{fmtPct(b.ciLow)}〜{fmtPct(b.ciHigh)}</td>
                  <td className="px-2"><StatBadge n={b.n} p={b.p} significant={b.significant} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <AnalysisGuide title="カスタム条件ビルダーの詳細">
        <p className="font-medium text-gray-700">1. 何ができるか</p>
        <p>
          {"既存の条件付き分析は閾値（RSI=30/50/70 等）が固定だが、ここでは指標・窓長・バケット境界を自分で指定できる。『自分の閾値感覚』で、状態ごとの先行きリターン（期待値・勝率・有意性）を検証するためのツール。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 操作</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>指標</strong>: RSI / 移動平均乖離 / 実現ボラ / モメンタム(ROC) / 前日リターン / 高値からの下落 / ボリンジャー%b。</li>
          <li><strong>窓長</strong>: 指標の計算期間（RSIの期間、SMAの本数、ボラの窓長など）。これが #7「ローリング窓長の任意入力」も兼ねる。</li>
          <li><strong>固定閾値</strong>: 境界をカンマ区切りで入力（表示単位）。例 RSIで「20, 50, 80」と入れると4バケットに分かれる。</li>
          <li><strong>等頻度分位</strong>: 全標本を同数ずつ k 分割。各バケットのサンプル数が揃い、有意性検定が安定する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 計算（先読みバイアスを排除）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>状態は i 日終値時点で確定する指標のみで判定。フォワードリターンは当日引け（or 翌日寄り）から N 日先。</li>
          <li>平均・中央値・勝率・95%CI（移動ブロック・ブートストラップ）・有意性（t検定→Benjamini-Hochberg FDR補正）を各バケットに付与。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>境界を動かして、平均が基準平均より明確に高く・勝率＞50%・有意なバケットを探す＝エッジのある状況。</li>
          <li>窓長を変えて感応度を確認。特定の窓長だけで効く場合は過剰最適化の疑い。</li>
          <li>上部の現在バナーが「今日の状態」での過去成績。そのままエントリー検討材料になる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>境界やビン数を細かくするほど各バケットの n が減り、平均・有意性が不安定になる。「参考(n小)」を重視しない。</li>
          <li>多数の閾値を試すほど偶然の「当たり」を引きやすい（多重比較）。FDRバッジと年次の再現性で確認を。</li>
          <li>等頻度分位の境界は全標本から決めるため、厳密には弱い先読みを含む。</li>
          <li>取引コスト・スリッページ未控除。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
