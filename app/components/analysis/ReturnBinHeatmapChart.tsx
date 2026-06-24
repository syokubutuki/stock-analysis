"use client";

import { useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  stateByReturnBin,
  buildStateFn,
  STATE_AXES,
  REVERSAL_AXES,
  TREND_AXES,
  CANDLE_RUN_AXES,
  CALENDAR_AXES,
  StateAxis,
  BinMode,
} from "../../lib/conditional-forward-returns";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  minBars?: number;
}

const ALL_AXES: { value: StateAxis; label: string }[] = [
  ...STATE_AXES,
  ...REVERSAL_AXES,
  ...TREND_AXES,
  ...CANDLE_RUN_AXES,
  ...CALENDAR_AXES,
];

const HORIZONS = [1, 5, 10, 20];
const STEP_OPTIONS = [0.5, 1, 2, 3]; // %
const BIN_OPTIONS = [4, 5, 6, 8, 10];

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

// セル背景: ビンの符号で色相（負=赤 / 正=緑 / 中立=灰）、頻度で濃さ。
function cellBg(sign: number, freq: number, maxFreq: number): string {
  const t = maxFreq > 0 ? Math.min(1, freq / maxFreq) : 0;
  const a = 0.06 + t * 0.62;
  if (sign > 0) return `rgba(22, 163, 74, ${a})`;
  if (sign < 0) return `rgba(220, 38, 38, ${a})`;
  return `rgba(107, 114, 128, ${a})`;
}

export default function ReturnBinHeatmapChart({ prices, minBars = 250 }: Props) {
  const [axis, setAxis] = useState<StateAxis>(ALL_AXES[0].value);
  const [horizon, setHorizon] = useState(5);
  const [entry, setEntry] = useState<"close" | "open">("close");
  const [binMode, setBinMode] = useState<BinMode>("step");
  const [stepPct, setStepPct] = useState(1);
  const [maxAbsPct, setMaxAbsPct] = useState(5);
  const [bins, setBins] = useState(6);

  const result = useMemo(() => {
    if (prices.length < minBars) return null;
    const st = buildStateFn(prices, axis);
    return stateByReturnBin(prices, st, horizon, { mode: binMode, stepPct, maxAbsPct, bins }, { entry });
  }, [prices, axis, horizon, entry, binMode, stepPct, maxAbsPct, bins, minBars]);

  if (prices.length < minBars) return null;
  if (!result || result.rows.length === 0) return null;

  const nowRow = result.rows.find((r) => r.label === result.nowLabel) ?? null;
  // 現在状態の最頻ビン
  const nowTopBin = nowRow
    ? result.binLabels[nowRow.freqs.indexOf(Math.max(...nowRow.freqs))]
    : null;
  const nowUpShare = nowRow
    ? result.binLabels.reduce((acc, _l, j) => acc + (result.binSigns[j] > 0 ? nowRow.freqs[j] : 0), 0)
    : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">状態 × 先行きリターンビン 分布ヒートマップ</h3>
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

      {/* 状態軸 */}
      <div className="flex gap-1 flex-wrap">
        {ALL_AXES.map((a) => (
          <button
            key={a.value}
            onClick={() => setAxis(a.value)}
            className={`px-2.5 py-1 text-xs rounded font-medium ${axis === a.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >
            {a.label}
          </button>
        ))}
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
        <span className="ml-auto text-gray-400">全標本 {result.totalN}日</span>
      </div>

      {/* リターンビン設定 */}
      <div className="flex items-center gap-3 text-xs text-gray-600 flex-wrap rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
        <span className="font-medium text-gray-700">リターンビン:</span>
        <div className="flex gap-1">
          {(["step", "quantile"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setBinMode(m)}
              className={`px-2 py-0.5 rounded ${binMode === m ? "bg-indigo-600 text-white" : "bg-white border border-gray-200 hover:bg-gray-100"}`}
            >
              {m === "step" ? "固定幅" : "等頻度分位"}
            </button>
          ))}
        </div>
        {binMode === "step" ? (
          <>
            <span className="ml-2">幅:</span>
            {STEP_OPTIONS.map((s) => (
              <button
                key={s}
                onClick={() => setStepPct(s)}
                className={`px-2 py-0.5 rounded ${stepPct === s ? "bg-indigo-600 text-white" : "bg-white border border-gray-200 hover:bg-gray-100"}`}
              >
                {s}%
              </button>
            ))}
            <span className="ml-2">範囲: ±</span>
            <input
              type="number"
              min={1}
              max={30}
              step={1}
              value={maxAbsPct}
              onChange={(e) => setMaxAbsPct(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
              className="w-14 px-1.5 py-0.5 border border-gray-300 rounded"
            />
            <span>%（外側はまとめ）</span>
          </>
        ) : (
          <>
            <span className="ml-2">分割数:</span>
            {BIN_OPTIONS.map((b) => (
              <button
                key={b}
                onClick={() => setBins(b)}
                className={`px-2 py-0.5 rounded ${bins === b ? "bg-indigo-600 text-white" : "bg-white border border-gray-200 hover:bg-gray-100"}`}
              >
                {b}
              </button>
            ))}
          </>
        )}
      </div>

      {/* 現在バナー */}
      {nowRow && nowTopBin && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          <span className="font-bold">現在の状態: {result.nowLabel}</span>
          {" → "}過去同状態の{horizon}日先は{" "}
          <span className="font-bold">{(nowUpShare * 100).toFixed(0)}%が上昇</span>
          {"、最頻ビン= "}
          <span className="font-bold">{nowTopBin}</span>
          {"（平均 "}
          <span className="font-bold">{fmtPct(nowRow.meanFwd)}</span>
          {"、n="}{nowRow.n}）
        </div>
      )}

      {/* ヒートマップ表 */}
      <div className="overflow-x-auto">
        <table className="text-xs border-collapse">
          <thead>
            <tr className="text-gray-500">
              <th className="text-left py-1 px-2 sticky left-0 bg-white">状態 ＼ {horizon}日リターン</th>
              <th className="text-right px-2">n</th>
              <th className="text-right px-2">平均</th>
              {result.binLabels.map((bl) => (
                <th key={bl} className="px-1 py-1 text-center font-medium whitespace-nowrap" style={{ minWidth: 52 }}>
                  {bl}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => {
              const isNow = row.label === result.nowLabel;
              return (
                <tr
                  key={row.label}
                  className={`${row.isBaseline ? "border-t-2 border-gray-300" : "border-t border-gray-100"} ${isNow ? "ring-2 ring-blue-400 ring-inset" : ""}`}
                >
                  <td className={`py-1 px-2 font-medium whitespace-nowrap sticky left-0 bg-white ${row.isBaseline ? "text-gray-500 italic" : "text-gray-700"}`}>
                    {isNow && <span className="text-blue-600 mr-1">◀</span>}
                    {row.label}
                  </td>
                  <td className="text-right px-2 text-gray-500">{row.n}</td>
                  <td className={`text-right px-2 font-medium ${row.meanFwd >= 0 ? "text-green-700" : "text-red-700"}`}>
                    {fmtPct(row.meanFwd)}
                  </td>
                  {row.freqs.map((f, j) => (
                    <td
                      key={j}
                      className="px-1 py-1 text-center text-gray-700 tabular-nums"
                      style={{ background: row.isBaseline ? undefined : cellBg(result.binSigns[j], f, result.maxFreq) }}
                      title={`${row.label} / ${result.binLabels[j]}: ${row.counts[j]}回 (${(f * 100).toFixed(1)}%)`}
                    >
                      {f > 0.004 ? `${(f * 100).toFixed(0)}` : ""}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] text-gray-400">
        セルの数値＝その状態における各リターンビンの出現割合(%)。色の濃さ＝割合の高さ、色相＝ビンの符号(緑=上昇/赤=下落)。
      </div>

      <AnalysisGuide title="状態×リターンビン分布の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"『いまこの状態にあるとき、その先N日のリターンがどの帯（ビン）に落ちやすいか』を、行=状態・列=リターンビンの分布として見る。条件付き期待値（平均）は一点に潰してしまうが、ここでは分布の形そのもの──上下どちらに偏るか、裾（大きな上昇/下落）がどれだけ厚いか──を確認できる。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算（先読みバイアスを排除）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>状態</strong>: i 日終値時点で確定する情報のみで判定（RSI帯・ボラレジーム・移動平均乖離・連続ローソク・カレンダー等から選択）。</li>
          <li><strong>フォワードリターン</strong>: r = (exit − entry) / entry。当日引け建てなら entry=当日C・exit=N日後C。翌日寄り建てなら翌日Oベース。</li>
          <li><strong>ビン分割</strong>:
            <ul className="list-disc pl-4">
              <li><strong>固定幅</strong>: 中央0を挟んで指定幅(例1%)で等間隔に区切る。±範囲の外側は「以下/以上」のまとめビンに集約。リターンの絶対水準で見たいときに。</li>
              <li><strong>等頻度分位</strong>: 全標本を同数ずつ k 個に分ける。各ビンのサンプル数が揃うため、偏りの“形”を比較しやすい。</li>
            </ul>
          </li>
          <li><strong>行内正規化</strong>: 各セルは「その状態の中での割合」= counts / n。状態ごとにサンプル数が違っても比較できる。</li>
          <li><strong>基準行（全体）</strong>: 無条件の分布。各状態行をこれと比べ、どちらにシフトしているかを読む。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ビン</strong>: リターンを区切った帯。例「+1%〜+2%」。</li>
          <li><strong>等頻度分位</strong>: 値の大小で同数ずつに分ける分け方。各帯の人数が等しい。</li>
          <li><strong>裾（テール）</strong>: 分布の両端＝大きな上昇/下落の領域。ここが厚いほど“跳ねる”状態。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>状態行の色が<strong>右側(緑)に偏る</strong>＝その状態の後は上昇に傾きやすい。順張りの後押し材料。</li>
          <li>基準行より<strong>左の赤ビンが薄く・右の緑ビンが濃い</strong>状態を探すと、相対的に有利な局面が見える。</li>
          <li>平均はプラスでも<strong>両端の裾が厚い</strong>状態は、当たれば大きいが外すと深い。ストップとサイズで管理。</li>
          <li>上部の<strong>現在バナー</strong>＝今日の状態での上昇割合と最頻ビン。そのまま「今この状況で起きやすい結果」。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ビンを細かくする/状態を細分化すると各セルのサンプルが減り、割合が不安定になる。n の小さい行は重視しない。</li>
          <li>等頻度分位の境界は全標本から決めるため、厳密には弱い先読みを含む（分布の記述としては実用上問題小）。</li>
          <li>これは「予測」ではなく過去の<strong>条件付き分布の記述</strong>。将来の同一性は保証されない。</li>
          <li>取引コスト・スリッページは未控除。短いNでは特に効く。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
