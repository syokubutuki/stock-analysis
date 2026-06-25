"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { useIntraday } from "../../hooks/useIntraday";
import {
  computeSignalExecution, SignalExecResult, ExecCell,
} from "../../lib/signal-execution";
import { Side } from "../../lib/execution-timing";
import {
  buildStateFn, StateAxis, STATE_AXES, REVERSAL_AXES, CANDLE_RUN_AXES, CALENDAR_AXES,
} from "../../lib/conditional-forward-returns";
import {
  initCanvas, fmtSignedPct, IntervalButtons, LoadingError, IntradayCaveat,
} from "./intradayShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; ticker: string; }

const AXES: { value: StateAxis; label: string }[] = [
  ...REVERSAL_AXES, ...STATE_AXES, ...CANDLE_RUN_AXES, ...CALENDAR_AXES,
];

function cellBg(v: number, maxAbs: number, faded: boolean): string {
  const t = maxAbs > 0 ? Math.min(1, Math.abs(v) / maxAbs) : 0;
  const a = (faded ? 0.04 : 0.12) + t * (faded ? 0.18 : 0.6);
  return v >= 0 ? `rgba(22,163,74,${a})` : `rgba(220,38,38,${a})`;
}

function drawHeatmap(ctx: CanvasRenderingContext2D, W: number, H: number, res: SignalExecResult) {
  const ml = 70, mr = 12, mt = 30, mb = 30;
  const nr = res.entryLabels.length, nc = res.exitLabels.length;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const cw = plotW / nc, ch = plotH / nr;

  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("エントリー(行) × エグジット(列) 1取引平均リターン", ml - 60, 16);

  const present = res.cells.filter((c) => c.n >= 1);
  const maxAbs = Math.max(0.05, ...present.map((c) => Math.abs(c.meanPct)));
  const cellOf = (ei: number, xi: number) => res.cells.find((c) => c.ei === ei && c.xi === xi);

  // 列ラベル
  ctx.font = "9px sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "#4b5563";
  for (let xi = 0; xi < nc; xi++) ctx.fillText(res.exitLabels[xi], ml + xi * cw + cw / 2, mt + plotH + 14);
  // 行ラベル
  ctx.textAlign = "right";
  for (let ei = 0; ei < nr; ei++) ctx.fillText(res.entryLabels[ei], ml - 4, mt + ei * ch + ch / 2 + 3);

  for (let ei = 0; ei < nr; ei++) {
    for (let xi = 0; xi < nc; xi++) {
      const x = ml + xi * cw, y = mt + ei * ch;
      const c = cellOf(ei, xi);
      if (!c || c.n === 0) {
        ctx.fillStyle = "#f3f4f6"; ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
        continue;
      }
      const faded = !c.significant;
      ctx.fillStyle = cellBg(c.meanPct, maxAbs, faded);
      ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
      // 値・n
      ctx.fillStyle = "#374151"; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(fmtSignedPct(c.meanPct / 100), x + cw / 2, y + ch / 2 - 1);
      ctx.fillStyle = "#9ca3af"; ctx.font = "8px sans-serif";
      ctx.fillText(`n=${c.n}`, x + cw / 2, y + ch / 2 + 11);
      // 有意セルに枠
      if (c.significant) { ctx.strokeStyle = "#16a34a"; ctx.lineWidth = 1; ctx.strokeRect(x + 1, y + 1, cw - 2, ch - 2); }
      // 最良セル強調
      if (res.best && c.ei === res.best.ei && c.xi === res.best.xi) {
        ctx.strokeStyle = "#15803d"; ctx.lineWidth = 2.5; ctx.strokeRect(x + 2, y + 2, cw - 4, ch - 4);
      }
      // 成行セルに印
      if (c.isNaive) { ctx.fillStyle = "#6b7280"; ctx.font = "7px sans-serif"; ctx.textAlign = "left"; ctx.fillText("成行", x + 3, y + 9); }
    }
  }
}

function drawPath(ctx: CanvasRenderingContext2D, W: number, H: number, res: SignalExecResult) {
  const ml = 44, mr = 12, mt = 22, mb = 22;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const n = res.avgPathPct.length;
  if (n < 2) return;
  const all = [...res.avgPathPct, ...res.paths.flat()];
  const vmax = Math.max(0.1, ...all), vmin = Math.min(-0.1, ...all);
  const ys = (v: number) => mt + plotH - ((v - vmin) / (vmax - vmin)) * plotH;
  const xs = (i: number) => ml + (i / (n - 1)) * plotW;

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("シグナル翌日の経路（寄り比%・細線=個別/太線=平均）", ml, mt - 8);
  // ゼロ線
  ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]); ctx.beginPath();
  ctx.moveTo(ml, ys(0)); ctx.lineTo(ml + plotW, ys(0)); ctx.stroke(); ctx.setLineDash([]);

  ctx.strokeStyle = "rgba(59,130,246,0.18)"; ctx.lineWidth = 1;
  for (const p of res.paths) {
    ctx.beginPath();
    for (let i = 0; i < p.length; i++) { const x = xs(i), y = ys(p[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  }
  ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i < n; i++) { const x = xs(i), y = ys(res.avgPathPct[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.stroke();

  ctx.fillStyle = "#9ca3af"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
  [0, Math.floor(n / 2), n - 1].forEach((i) => ctx.fillText(res.binLabels[i] ?? "", xs(i), mt + plotH + 12));
}

export default function SignalExecutionChart({ prices, ticker }: Props) {
  const heatRef = useRef<HTMLCanvasElement>(null);
  const pathRef = useRef<HTMLCanvasElement>(null);
  const [intervalKey, setIntervalKey] = useState("60m");
  const [axis, setAxis] = useState<StateAxis>("rsi2");
  const [bucketLabel, setBucketLabel] = useState<string>("");
  const [side, setSide] = useState<Side>("buy");
  const { resp, loading, error } = useIntraday(ticker, intervalKey);

  const stateFn = useMemo(
    () => (prices.length >= 250 ? buildStateFn(prices, axis) : null),
    [prices, axis]
  );
  // 軸変更時はバケットを先頭にリセット
  const bucketOptions = stateFn?.order ?? [];
  const effectiveBucket = bucketOptions.includes(bucketLabel) ? bucketLabel : (bucketOptions[0] ?? "");

  const res = useMemo<SignalExecResult | null>(() => {
    if (!resp || !stateFn || !effectiveBucket) return null;
    return computeSignalExecution(prices, resp.bars, resp.gmtoffset, resp.interval, stateFn, effectiveBucket, side);
  }, [resp, stateFn, effectiveBucket, side, prices]);

  useEffect(() => {
    if (heatRef.current && res) {
      const init = initCanvas(heatRef.current, 40 + res.entryLabels.length * 38);
      if (init) drawHeatmap(init.ctx, init.width, init.height, res);
    }
    if (pathRef.current && res && res.avgPathPct.length >= 2) {
      const init = initCanvas(pathRef.current, 180);
      if (init) drawPath(init.ctx, init.width, init.height, res);
    }
  }, [res]);

  if (prices.length < 250) return null;

  const lbl = (c: ExecCell) => `${res!.entryLabels[c.ei]}→${res!.exitLabels[c.xi]}`;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">日足シグナル × 最適約定時刻</h3>
        <IntervalButtons value={intervalKey} onChange={setIntervalKey}
          options={[{ value: "60m", label: "60分足", note: "直近約2年・シグナル数を稼げる" }, { value: "5m", label: "5分足", note: "直近約60日・細かいが少数" }, { value: "15m", label: "15分足" }]} />
      </div>

      {/* シグナル軸 */}
      <div className="space-y-1.5">
        <div className="flex gap-1 flex-wrap">
          {AXES.map((a) => (
            <button key={a.value} onClick={() => { setAxis(a.value); setBucketLabel(""); }}
              className={`px-2.5 py-1 text-xs rounded font-medium ${axis === a.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
              {a.label}
            </button>
          ))}
        </div>
        {/* バケット(シグナル条件) */}
        <div className="flex gap-1 flex-wrap items-center">
          <span className="text-xs text-gray-400">シグナル条件:</span>
          {bucketOptions.map((b) => (
            <button key={b} onClick={() => setBucketLabel(b)}
              className={`px-2 py-0.5 text-xs rounded ${effectiveBucket === b ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
              {b}
            </button>
          ))}
          <span className="ml-auto flex gap-1">
            {(["buy", "sell"] as const).map((s) => (
              <button key={s} onClick={() => setSide(s)}
                className={`px-2 py-0.5 text-xs rounded font-medium ${side === s ? (s === "buy" ? "bg-green-600 text-white" : "bg-red-600 text-white") : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                {s === "buy" ? "買い" : "売り"}
              </button>
            ))}
          </span>
        </div>
      </div>

      <LoadingError loading={loading} error={error} />

      {!loading && !error && res && (
        <>
          <div className="text-xs text-gray-500">
            シグナル「{effectiveBucket}」翌日を{side === "buy" ? "買い" : "売り"}。
            日足全期間で {res.nSignalTotal} 回発生 → うち <span className="font-medium">{res.nWithIntraday}</span> 日が{resp?.interval}足の窓内（格子に使用）。
          </div>

          {/* 現在地サマリー */}
          {res.best ? (
            <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">
              <span className="font-bold">最適約定: 〈{lbl(res.best)}〉 平均 {fmtSignedPct(res.best.meanPct / 100)}</span>
              （勝率 {(res.best.winRate * 100).toFixed(0)}%、95%CI {fmtSignedPct(res.best.ciLoPct / 100)}〜{fmtSignedPct(res.best.ciHiPct / 100)}、n={res.best.n}）。
              {res.naive && <> 成行〈寄成→引成〉{fmtSignedPct(res.naive.meanPct / 100)} 比 <span className="font-bold">{res.improvePct! >= 0 ? "+" : ""}{(res.improvePct!).toFixed(3)}pt</span> 改善。</>}
              <span className="block mt-0.5 text-green-700/80">非シグナル日の同枠平均 {fmtSignedPct(res.best.baseMeanPct / 100)}（n={res.best.baseN}）との差がシグナルの寄与。</span>
            </div>
          ) : (
            <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
              CIが0をまたがない（有意な）約定時刻は見つからなかった → この足・このシグナルでは<span className="font-medium">時刻最適化の頑健なエッジは検出されず</span>。n不足の可能性大（60分足やより高頻度なシグナル条件を試す）。
            </div>
          )}

          <div className="relative"><canvas ref={heatRef} /></div>
          <div className="relative"><canvas ref={pathRef} /></div>

          <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
            {"緑＝平均プラス（その売買方向に有利）・赤＝マイナス。濃いほど大きい。緑枠＝95%CIが0をまたがないセル、太枠＝最適。『成行』印のセル（寄成→引成）が基準で、そこより濃い緑のセルが約定時刻の改善余地。n が小さいセルは参考に留める。"}
          </p>

          <IntradayCaveat extra="シグナルは前日終値で確定・約定は翌日（先読みなし）。約定価格はバー価格で近似（板・気配・成行スリッページは未反映）。" />
        </>
      )}

      <AnalysisGuide title="日足シグナル×最適約定時刻の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"日足で確定したシグナル（例: RSI(2)が極端に売られ過ぎ、前日が大幅安、陰線3連）が出た『翌日』、当日内のどの時刻に建て・どの時刻に手仕舞うのが最も有利かを、シグナル翌日の分足から求める。日足の状態分析（条件付き期待値）と、当日内の約定タイミング最適化を橋渡しする分析。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算（先読みバイアスを排除）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>シグナル</strong>: フル日足で <code>状態(s日終値時点)=選択バケット</code> の翌営業日 s+1 をエントリー対象に（s日終値で確定 → 翌日約定なので先読みなし）。</li>
          <li><strong>エントリー×エグジット格子</strong>: 行=建て時刻 {"{寄成,寄+15,+30,+60,+120分}"}、列=手仕舞い時刻 {"{寄+60,+120,+180分,引成}"}。各セルの1取引リターン r=(出口価格−入口価格)/入口価格（売りは符号反転）をシグナル翌日で平均。</li>
          <li><strong>有意性</strong>: 各セルの移動ブロックブートストラップ95%CI。CIが0をまたがなければ「有意（緑枠）」。</li>
          <li><strong>ベースライン</strong>: 同じ格子を非シグナル日でも集計。シグナル日との差がシグナルの真の寄与。</li>
          <li><strong>成行比改善</strong>: 最適セル平均 − 寄成→引成（成行）平均。約定時刻を工夫して得られる上乗せ。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>シグナル</strong>: 日足の状態が特定条件に入ること。`条件付き分析`の状態軸・バケットをそのまま流用。</li>
          <li><strong>約定時刻格子</strong>: 「いつ買って・いつ売るか」の全組合せ表。最も濃い緑が最良の時間取り。</li>
          <li><strong>実装ショートフォール</strong>: 狙い（成行）と実約定の差。本分析は時刻別にそれを最適化する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>上部バナー＝<strong>最適な建て/手仕舞い時刻</strong>。例「寄+30分→引成」が成行より優れていれば、寄り直後の不利を避け30分待って建てるのが有利。</li>
          <li>緑枠（有意）かつ成行セルより濃いセルだけを採用。<strong>n が小さい・CIが0をまたぐ</strong>セルはノイズ。</li>
          <li>翌日経路（下段）で平均が右肩上がりなら日中順張り、寄り高後に垂れるなら寄り直後の利確が有利、と形から執行方針を読む。</li>
          <li>非シグナル日との差が小さいなら、それは「シグナル効果」ではなく銘柄の常時的な日内クセ。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>最もサンプルが薄い分析</strong>: シグナル日 ∩ 分足窓。60分足（約2年）でも稀シグナルは n が一桁になる。CI・ベースライン差を主指標に、過剰解釈を避ける。</li>
          <li>格子の最適セルはインサンプル最良点＝過剰最適化の恐れ。ブートCIで割り引く。</li>
          <li>板・気配は取得不可。約定価格はバー価格の近似で、成行の食い込み（スリッページ）・手数料は別途。</li>
          <li>Yahoo分足は約15分遅延。過去傾向の把握用で、当日のライブ執行判断には使えない。</li>
          <li>東証は昼休みで前場/後場に分割。経過分は寄りからの素朴な経過で測るため、昼を跨ぐ時刻はビン欠損を含む。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
