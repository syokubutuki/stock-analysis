"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BinScheme } from "../../lib/us-spillover-core";
import {
  digestionBinCounts, rowsInBin, holdingCurve, excursionCurve,
  HoldingPoint, ExcursionPoint,
} from "../../lib/us-digestion-core";
import { useAlignedDays, UsDriverButtons, BinSchemeButtons } from "./usSpilloverShared";
import {
  initCanvas, IntervalButtons, LoadingError, IntradayCaveat, fmtSignedPct, drawTimeAxisLabels, ViewTabs,
} from "./intradayShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

type View = "ir" | "excursion";
const VIEWS: { value: View; label: string }[] = [
  { value: "ir", label: "IR×保有期間" },
  { value: "excursion", label: "MFE/MAE" },
];

// IR(情報比)の保有期間曲線。横軸=保有時間, 縦軸=IR(無次元)。ピークに印。
function drawIR(ctx: CanvasRenderingContext2D, W: number, H: number, pts: HoldingPoint[], bestDt: number) {
  const ml = 38, mr = 10, mt = 12, mb = 22;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const N = pts.length;
  if (N < 1) return;
  const yMax = Math.max(0.2, ...pts.map((p) => Math.abs(p.ir))) * 1.15;
  const X = (i: number) => ml + (N === 1 ? plotW / 2 : (i / (N - 1)) * plotW);
  const Y = (v: number) => mt + (1 - (v + yMax) / (2 * yMax)) * plotH;
  ctx.strokeStyle = "#f0f0f0";
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(yMax.toFixed(2), ml - 3, mt + 8); ctx.fillText("0", ml - 3, Y(0) + 3); ctx.fillText((-yMax).toFixed(2), ml - 3, mt + plotH);
  ctx.strokeStyle = "#4338ca"; ctx.lineWidth = 2; ctx.beginPath();
  pts.forEach((p, i) => { const x = X(i), y = Y(p.ir); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  pts.forEach((p, i) => {
    ctx.fillStyle = p.dt === bestDt ? "#dc2626" : "#4338ca";
    ctx.beginPath(); ctx.arc(X(i), Y(p.ir), p.dt === bestDt ? 4 : 2, 0, Math.PI * 2); ctx.fill();
  });
  drawTimeAxisLabels(ctx, pts.map((p) => p.label), ml, plotW / N, H - 6);
}

// MFE(緑)/MAE(赤)エクスカーション曲線。横軸=保有時間, 縦軸=%。
function drawExcursion(ctx: CanvasRenderingContext2D, W: number, H: number, pts: ExcursionPoint[]) {
  const ml = 40, mr = 10, mt = 12, mb = 22;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const N = pts.length;
  if (N < 1) return;
  const yMax = Math.max(0.002, ...pts.map((p) => Math.max(Math.abs(p.mfe), Math.abs(p.mae)))) * 1.1;
  const X = (i: number) => ml + (N === 1 ? plotW / 2 : (i / (N - 1)) * plotW);
  const Y = (v: number) => mt + (1 - (v + yMax) / (2 * yMax)) * plotH;
  ctx.strokeStyle = "#f0f0f0";
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(fmtSignedPct(yMax, 1), ml - 3, mt + 8); ctx.fillText(fmtSignedPct(-yMax, 1), ml - 3, mt + plotH);
  const drawSeries = (key: "mfe" | "mae", color: string) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((p, i) => { const x = X(i), y = Y(p[key]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
  };
  drawSeries("mfe", "#16a34a");
  drawSeries("mae", "#dc2626");
  drawTimeAxisLabels(ctx, pts.map((p) => p.label), ml, plotW / N, H - 6);
}

export default function UsHoldingPeriodChart({ ticker }: Props) {
  const [usTicker, setUsTicker] = useState("^GSPC");
  const [interval, setInterval] = useState("15m");
  const [scheme, setScheme] = useState<BinScheme>("tercile");
  const [selBin, setSelBin] = useState(0);
  const [entryIdx, setEntryIdx] = useState(0);
  const [view, setView] = useState<View>("ir");
  const { data, loading, error } = useAlignedDays(ticker, interval, usTicker);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const counts = useMemo(() => (data ? digestionBinCounts(data.aligned, scheme) : []), [data, scheme]);
  const selBinSafe = counts.length > 0 && selBin < counts.length ? selBin : 0;
  const G = data?.grid?.bins.length ?? 0;
  const entrySafe = G > 1 ? Math.min(entryIdx, G - 2) : 0;

  const rows = useMemo(
    () => (data ? rowsInBin(data.aligned, scheme, selBinSafe) : []),
    [data, scheme, selBinSafe]
  );

  const holding = useMemo(
    () => (data?.grid && rows.length >= 5 ? holdingCurve(rows, data.grid, data.gmtoffset, entrySafe) : []),
    [data, rows, entrySafe]
  );
  const excursion = useMemo(
    () => (data?.grid && rows.length >= 5 ? excursionCurve(rows, data.grid, data.gmtoffset, entrySafe) : []),
    [data, rows, entrySafe]
  );

  const best = useMemo(() => {
    if (holding.length === 0) return null;
    return holding.reduce((a, b) => (Math.abs(b.ir) > Math.abs(a.ir) ? b : a));
  }, [holding]);

  useEffect(() => {
    if (!canvasRef.current) return;
    if (view === "ir" && holding.length === 0) return;
    if (view === "excursion" && excursion.length === 0) return;
    const init = initCanvas(canvasRef.current, 220);
    if (!init) return;
    if (view === "ir") drawIR(init.ctx, init.width, init.height, holding, best?.dt ?? -1);
    else drawExcursion(init.ctx, init.width, init.height, excursion);
  }, [view, holding, excursion, best]);

  const entryLabel = data?.grid?.bins[entrySafe]?.label ?? "";
  const mfePeak = useMemo(() => (excursion.length ? excursion.reduce((a, b) => (b.mfe > a.mfe ? b : a)) : null), [excursion]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">米国方向別 保有期間の最適化（IR×Δ / MFE・MAE）</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        <UsDriverButtons value={usTicker} onChange={setUsTicker} />
        <BinSchemeButtons value={scheme} onChange={setScheme} />
      </div>

      <LoadingError loading={loading} error={error} />

      {counts.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-gray-500">対象の前夜米国:</span>
            {counts.map((c) => (
              <button
                key={c.bin}
                onClick={() => setSelBin(c.bin)}
                className={`px-2 py-0.5 rounded font-medium ${selBinSafe === c.bin ? "text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                style={selBinSafe === c.bin ? { backgroundColor: c.color } : undefined}
              >
                {c.label}（n={c.n}）
              </button>
            ))}
          </div>
          {data?.grid && (
            <div className="flex items-center gap-1">
              <span className="text-gray-500">エントリー:</span>
              <select value={entrySafe} onChange={(e) => setEntryIdx(Number(e.target.value))} className="px-2 py-1 border border-gray-300 rounded">
                {data.grid.bins.slice(0, -1).map((b, i) => (
                  <option key={i} value={i}>{b.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {!loading && !error && data && rows.length < 5 && (
        <div className="text-xs text-gray-400">この米国ビンは標本が不足しています（別ビン/粗い足を選択）。</div>
      )}

      {holding.length > 0 && (
        <>
          {best && (
            <div className="rounded-md bg-indigo-50 border border-indigo-200 px-3 py-2 text-xs text-indigo-900">
              <span className="font-bold">{counts[selBinSafe]?.label}</span> の翌日、{entryLabel} 建てなら
              最適保有は <span className="font-bold">{best.label}</span> まで（{best.dt}本・
              平均 {fmtSignedPct(best.mean)}・IR {best.ir.toFixed(2)}）。
              {mfePeak && <> 含み益のピークは <span className="font-bold">{mfePeak.label}</span>（MFE {fmtSignedPct(mfePeak.mfe)}）→ 利確目安。</>}
            </div>
          )}

          <ViewTabs value={view} onChange={setView} views={VIEWS} />
          {view === "excursion" && (
            <div className="flex items-center gap-3 text-[11px]">
              <span className="inline-flex items-center gap-1"><span className="inline-block w-4 h-0.5" style={{ backgroundColor: "#16a34a" }} /><span className="text-gray-600">MFE(最大含み益)</span></span>
              <span className="inline-flex items-center gap-1"><span className="inline-block w-4 h-0.5" style={{ backgroundColor: "#dc2626" }} /><span className="text-gray-600">MAE(最大含み損)</span></span>
            </div>
          )}
          <div className="relative"><canvas ref={canvasRef} /></div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">手仕舞い</th>
                  <th className="text-right px-2">保有</th>
                  <th className="text-right px-2">平均</th>
                  <th className="text-right px-2">IR</th>
                  <th className="text-right px-2">日数</th>
                  <th className="text-left px-2">有意性</th>
                </tr>
              </thead>
              <tbody>
                {holding.map((h) => (
                  <tr key={h.dt} className={`border-b border-gray-100 ${best && h.dt === best.dt ? "bg-indigo-50" : ""}`}>
                    <td className="py-1 px-2 font-mono text-gray-700">{h.label}</td>
                    <td className="text-right px-2 text-gray-500">{h.dt}本</td>
                    <td className={`text-right px-2 font-medium ${h.mean >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(h.mean)}</td>
                    <td className="text-right px-2 font-mono text-gray-700">{h.ir.toFixed(2)}</td>
                    <td className="text-right px-2 text-gray-600">{h.n}</td>
                    <td className="px-2"><StatBadge n={h.n} p={h.p} significant={h.p < 0.05} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <IntradayCaveat extra="IR=平均/σ(1トレード当たりのリスク調整済み妙味)。MFE/MAEは米国符号で向き付け(米安の日はショート基準)。エントリーは寄り(始値近傍)を既定に、任意時刻を選べる。" />

      <AnalysisGuide title="保有期間最適化（IR×Δ / MFE・MAE）の詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"前夜米国の方向で日を分け、『ある時刻に建てたら、どれだけ持つのが最も得か』を保有時間の関数として測る。方法5(時刻×時刻の総当たり)が面なら、こちらはエントリーを固定した1本の断面で、リスク調整済みの最適保有と、含み益/含み損の時間発展をはっきり出す。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"保有期間曲線: エントリー時刻を固定し、各手仕舞い時刻までの窓リターン r=ln(P_j/P_i) を日ごとに集計。平均・情報比 IR=平均/標準偏差・t検定。IRのピークが最適保有Δ*。"}</li>
          <li>{"MFE/MAE: 建てた後の各時点までの『最大含み益(MFE)』『最大含み損(MAE)』を、米国符号で向き付け(米安の日はショート想定)して平均。MFEピーク時刻=利確目安、MAEの深さ=必要な損切り幅。"}</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>情報比(IR)</strong>: 平均リターンをそのばらつきσで割った、1回当たりのリスク調整妙味。大きいほど『薄いが安定した利益』。</li>
          <li><strong>MFE/MAE</strong>: 保有中に一度到達した最良/最悪の含み損益。例え: 山登りで到達した最高地点(MFE)と、途中で落ち込んだ最低地点(MAE)。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>IRピークのΔ*を保有時間の既定値に。ピーク後にIRが落ちるなら、それ以上持つのは無駄(消化完了)。</li>
          <li>MFEピーク時刻で利確、MAEの平均深さ＋αを損切り幅に設定。MFE≫|MAE|なら優位なトレード。</li>
          <li>方法5の最良ペアと、ここの最適Δ*が一致すれば信頼度が高い。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>米国ビンで層別するとnが小さく、IRピークが偶然のことも。StatBadgeとMFE/MAEの整合で確認。</li>
          <li>MFE/MAEは足の粗さに依存(細かい足ほど極値が深く出る)。同一足内で比較する。</li>
          <li>取引コスト・スリッページ未考慮。短い保有ほど相対的に効く。</li>
          <li>過去の最適Δ*が将来最適とは限らない。方法1/2/5と符号整合するものを採用。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
