"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  orientedMeanPath, estimateTau, changePointDrift, reversalSplit, hazardCurve,
  OrientedPath, ReversalSplit, HazardPoint,
} from "../../lib/us-digestion-core";
import { AlignedDay } from "../../lib/us-spillover-core";
import { BinGrid } from "../../lib/intraday-core";
import { useAlignedDays, UsDriverButtons } from "./usSpilloverShared";
import {
  initCanvas, IntervalButtons, LoadingError, IntradayCaveat, fmtSignedPct, drawTimeAxisLabels,
} from "./intradayShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

interface BoundaryResult {
  op: OrientedPath;
  tauThreshIdx: number; // T index
  tauCPIdx: number; // T index
  revThresh: ReversalSplit;
  revCP: ReversalSplit;
  hazard: HazardPoint[];
}

function compute(rows: AlignedDay[], grid: BinGrid, gmtoffset: number): BoundaryResult | null {
  if (rows.length < 8) return null;
  const op = orientedMeanPath(rows, grid, gmtoffset);
  const tauThreshIdx = estimateTau(op.fraction);
  const inc = op.path.slice(1).map((v, i) => v - op.path[i]);
  // changePointDrift の返り k は「増分inc[0..k-1]=ビン0..k-1が第1レジーム」の分割点。
  // 境界の累積は cum[k-1]、これは reversalSplit の T-index 表現で tauIdx=k(bIdx=k-1)に一致する。
  const tauCPIdx = changePointDrift(inc);
  return {
    op, tauThreshIdx, tauCPIdx,
    revThresh: reversalSplit(rows, grid, gmtoffset, tauThreshIdx),
    revCP: reversalSplit(rows, grid, gmtoffset, tauCPIdx),
    hazard: hazardCurve(rows, grid, gmtoffset),
  };
}

// 向き付け平均パス(前日終値基準・%)。τ(閾値/変化点)に縦線。
function drawPath(ctx: CanvasRenderingContext2D, W: number, H: number, res: BoundaryResult) {
  const ml = 42, mr = 10, mt = 12, mb = 22;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const p = res.op.path;
  const N = p.length;
  if (N < 2) return;
  const yMax = Math.max(1e-4, ...p.map(Math.abs)) * 1.1;
  const X = (i: number) => ml + (i / (N - 1)) * plotW;
  const Y = (v: number) => mt + (1 - (v + yMax) / (2 * yMax)) * plotH;
  ctx.strokeStyle = "#f0f0f0";
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(fmtSignedPct(yMax, 1), ml - 3, mt + 8); ctx.fillText("0", ml - 3, Y(0) + 3); ctx.fillText(fmtSignedPct(-yMax, 1), ml - 3, mt + plotH);

  const vline = (idx: number, color: string, label: string, up: boolean) => {
    const x = X(idx);
    ctx.strokeStyle = color; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x, mt); ctx.lineTo(x, mt + plotH); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.textAlign = "center"; ctx.fillText(label, x, up ? mt + 8 : mt + plotH - 2);
  };
  vline(res.tauThreshIdx, "#0ea5e9", "τ閾値", true);
  vline(res.tauCPIdx, "#ea580c", "τ変化点", false);

  ctx.strokeStyle = "#4338ca"; ctx.lineWidth = 2; ctx.beginPath();
  p.forEach((v, i) => { const x = X(i), y = Y(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  drawTimeAxisLabels(ctx, res.op.timeLabels, ml, plotW / N, H - 6);
}

// 反転ハザード(橙バー)と生存曲線(藍線)。0..1軸。
function drawHazard(ctx: CanvasRenderingContext2D, W: number, H: number, hz: HazardPoint[]) {
  const ml = 34, mr = 10, mt = 10, mb = 22;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const N = hz.length;
  if (N < 2) return;
  const hMax = Math.max(0.1, ...hz.map((h) => h.hazard)) * 1.1;
  const X = (i: number) => ml + (i / (N - 1)) * plotW;
  const slot = plotW / N;
  ctx.strokeStyle = "#f0f0f0";
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  // ハザードバー(左軸: 0..hMax)
  hz.forEach((h, i) => {
    const bh = (h.hazard / hMax) * plotH;
    ctx.fillStyle = "#f59e0b88"; ctx.fillRect(ml + i * slot + 1, mt + plotH - bh, Math.max(1, slot - 2), bh);
  });
  // 生存曲線(右軸: 0..1)
  ctx.strokeStyle = "#4338ca"; ctx.lineWidth = 2; ctx.beginPath();
  hz.forEach((h, i) => { const x = X(i), y = mt + (1 - h.survival) * plotH; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(hMax.toFixed(2), ml - 3, mt + 8);
  drawTimeAxisLabels(ctx, hz.map((h) => h.label), ml, slot, H - 6);
}

const RevRow = ({ label, rev }: { label: string; rev: ReversalSplit }) => (
  <div className={`p-2 rounded border text-xs ${rev.reversed ? "border-purple-200 bg-purple-50" : "border-gray-200 bg-gray-50"}`}>
    <div className="text-gray-500">{label}{rev.reversed && <span className="ml-1 text-purple-700 font-bold">反転あり</span>}</div>
    <div className="flex gap-3 mt-0.5">
      <span>前 <span className={`font-medium ${rev.preMean >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(rev.preMean)}</span> <span className="text-gray-400">p={rev.preP < 0.001 ? "<.001" : rev.preP.toFixed(3)}</span></span>
      <span>後 <span className={`font-medium ${rev.postMean >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(rev.postMean)}</span> <span className="text-gray-400">p={rev.postP < 0.001 ? "<.001" : rev.postP.toFixed(3)}</span></span>
    </div>
  </div>
);

export default function UsDigestionBoundaryChart({ ticker }: Props) {
  const [usTicker, setUsTicker] = useState("^GSPC");
  const [interval, setInterval] = useState("15m");
  const { data, loading, error } = useAlignedDays(ticker, interval, usTicker);
  const pathRef = useRef<HTMLCanvasElement>(null);
  const hzRef = useRef<HTMLCanvasElement>(null);

  const rows = useMemo(() => (data ? data.aligned.filter((a) => isFinite(a.us.ret) && a.us.ret !== 0) : []), [data]);
  const result = useMemo(
    () => (data?.grid && rows.length ? compute(rows, data.grid, data.gmtoffset) : null),
    [data, rows]
  );

  useEffect(() => {
    if (!result || !pathRef.current) return;
    const init = initCanvas(pathRef.current, 210);
    if (init) drawPath(init.ctx, init.width, init.height, result);
  }, [result]);
  useEffect(() => {
    if (!result || !hzRef.current) return;
    const init = initCanvas(hzRef.current, 170);
    if (init) drawHazard(init.ctx, init.width, init.height, result.hazard);
  }, [result]);

  const tauThreshLabel = result ? result.op.timeLabels[result.tauThreshIdx] : "";
  const tauCPLabel = result ? result.op.timeLabels[result.tauCPIdx] : "";
  // 生存が50%を切る時刻
  const halfSurvival = result?.hazard.find((h) => h.survival < 0.5)?.label ?? null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">消化完了点(τ)とレジーム反転・反転ハザード</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>
      <UsDriverButtons value={usTicker} onChange={setUsTicker} />

      <LoadingError loading={loading} error={error} />
      {!loading && !error && data && !result && (
        <div className="text-xs text-gray-400">整合できた標本が不足しています。</div>
      )}

      {result && (
        <>
          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-700">
            消化完了 τ ≈ <span className="font-bold text-sky-700">{tauThreshLabel}</span>(閾値法) / <span className="font-bold text-orange-700">{tauCPLabel}</span>(変化点法)。
            {result.revCP.reversed || result.revThresh.reversed
              ? " τ前は米国方向へ継続、τ後は逆行(戻し)する折り返しを検出 → τ前は順張り・τ以降は利確/逆張り。"
              : " τ後も明確な逆行は無く、消化後は横ばい傾向。"}
            {halfSurvival && <> 米国方向の含み益が半数の日で崩れるのは <span className="font-bold">{halfSurvival}</span> 頃。</>}
          </div>

          <div className="text-xs text-gray-500">向き付け平均パス（前日終値基準・米国方向を正）と2つのτ推定</div>
          <div className="relative"><canvas ref={pathRef} /></div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <RevRow label={`τ=${tauThreshLabel}(閾値)で分割`} rev={result.revThresh} />
            <RevRow label={`τ=${tauCPLabel}(変化点)で分割`} rev={result.revCP} />
          </div>

          <div className="pt-2 border-t border-gray-100 space-y-1">
            <div className="flex items-center gap-3 flex-wrap text-[11px]">
              <span className="text-gray-500">反転ハザード & 生存曲線</span>
              <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3" style={{ backgroundColor: "#f59e0b88" }} /><span className="text-gray-600">ハザード(その時刻で崩れる確率)</span></span>
              <span className="inline-flex items-center gap-1"><span className="inline-block w-4 h-0.5" style={{ backgroundColor: "#4338ca" }} /><span className="text-gray-600">生存率(まだ崩れていない割合)</span></span>
            </div>
            <div className="relative"><canvas ref={hzRef} /></div>
            <p className="text-[11px] text-gray-400">
              ハザードが低い時間帯＝安全に持てる窓。生存率が急落する時刻より前に利確/手仕舞いするのが定石。
            </p>
          </div>
        </>
      )}

      <IntradayCaveat extra="全日を米国符号で向き付け(米安の日は下落を正)。τ=消化完了時刻。反転=前半が米国方向、後半が逆方向。" />

      <AnalysisGuide title="消化完了点・レジーム反転・ハザードの詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"前夜米国の影響が『いつ消化し終わるか(τ)』を推定し、そのτの前後でエッジの向きが変わる(継続→反転)かを検定する。さらに、米国方向の含み益が時間とともに崩れるリスクを生存時間分析で可視化し、安全に持てる時間帯を特定する。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"向き付け平均パス: 各日を米国符号で向き付けし、前日終値基準の累積を平均。消化の平均的な進行を1本の線にする。"}</li>
          <li>{"τの2推定 — 閾値法: 実現割合 f(t)=平均累積/引け平均 が初めて95%に達する時刻。変化点法: パス増分(drift)系列を平均シフトが最小SSEになる位置で2分割した境界。両者が近ければτは頑健。"}</li>
          <li>{"反転検定: τで日内を(寄り→τ)と(τ→引け)に分け、各区間の向き付けリターンの符号を t検定。前が正・後が負なら『継続→反転』。"}</li>
          <li>{"反転ハザード: 向き付け累積が正から0以下へ転じる(=米国方向の含み益が崩れる)を反転イベントとし、各時刻のハザード率=崩れた日/その時刻まで生存していた日、生存率=∏(1−ハザード)。"}</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>消化完了τ</strong>: 前夜の材料が価格に織り込まれ切る時刻。以降は米国由来の新規情報は乏しい。</li>
          <li><strong>変化点(change-point)</strong>: 系列の性質(ここでは日内driftの平均)が切り替わる境界。</li>
          <li><strong>ハザード率</strong>: 「今まだ生きている個体が、この瞬間に死ぬ確率」。医学の生存解析と同じ発想で、含み益の“寿命”を測る。例え: 走者がまだ先頭なら、次の1区間で抜かれる確率。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>τまで順張り、τ以降は利確または逆張り。2つのτ推定が一致する時刻は特に信頼できる切替点。</li>
          <li>反転が有意なら『τ前に入り、τで手仕舞い、必要なら逆に張り直す』が基本戦略。</li>
          <li>ハザードが跳ねる/生存率が急落する時刻より前に手仕舞う。安全窓(低ハザード)にだけ建玉を残す。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>向き付けは米国連動が前提。方法7でR²が低い(米国で説明できない)銘柄ではτ・反転が不安定。</li>
          <li>閾値法は引け平均が0近傍だと発散しやすい。変化点法と食い違う時は解釈を慎重に。</li>
          <li>サンプルが薄いと反転検定・ハザードのnが小さい。p値とともに参考程度に。</li>
          <li>単一変化点を仮定しており、複数の切替がある日内構造は近似になる。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
