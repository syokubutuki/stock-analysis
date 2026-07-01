"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { computeAbsorption, AbsorptionResult } from "../../lib/us-spillover-absorption";
import { BinScheme } from "../../lib/us-spillover-core";
import { useAlignedDays, UsDriverButtons, BinSchemeButtons } from "./usSpilloverShared";
import {
  initCanvas, IntervalButtons, LoadingError, IntradayCaveat, drawTimeAxisLabels,
} from "./intradayShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

// 実現割合 f(t) 曲線(0%〜100%超)。100%線とギャップ寄与を参照線で示す(Canvas2D)。
function drawFraction(ctx: CanvasRenderingContext2D, W: number, H: number, res: AbsorptionResult) {
  const ml = 40, mr = 10, mt = 12, mb = 22;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const N = res.fraction.length;
  if (N < 2) return;
  const vals = res.fraction;
  const yMin = Math.min(0, ...vals) - 0.05;
  const yMax = Math.max(1.1, ...vals) + 0.05;
  const X = (i: number) => ml + (i / (N - 1)) * plotW;
  const Y = (v: number) => mt + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  // 参照線 0 / 1
  ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();
  ctx.strokeStyle = "#94a3b8"; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(ml, Y(1)); ctx.lineTo(ml + plotW, Y(1)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#64748b"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText("100%", ml - 3, Y(1) + 3);
  ctx.fillText("0%", ml - 3, Y(0) + 3);

  // ギャップ寄与(寄付=index0)に縦線
  ctx.strokeStyle = "#0ea5e9"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(X(0), mt); ctx.lineTo(X(0), mt + plotH); ctx.stroke();
  ctx.setLineDash([]);

  // 実現割合曲線
  ctx.strokeStyle = "#4338ca"; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < N; i++) { const x = X(i), y = Y(vals[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.stroke();
  // 点
  for (let i = 0; i < N; i++) { ctx.fillStyle = "#4338ca"; ctx.beginPath(); ctx.arc(X(i), Y(vals[i]), 1.8, 0, Math.PI * 2); ctx.fill(); }

  drawTimeAxisLabels(ctx, res.timeLabels, ml, plotW / N, H - 6);
}

const fmtPct0 = (v: number) => `${(v * 100).toFixed(0)}%`;

export default function UsAbsorptionChart({ ticker }: Props) {
  const [usTicker, setUsTicker] = useState("^GSPC");
  const [interval, setInterval] = useState("15m");
  const [scheme, setScheme] = useState<BinScheme>("tercile");
  const { data, loading, error } = useAlignedDays(ticker, interval, usTicker);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const result: AbsorptionResult | null = useMemo(
    () => (data ? computeAbsorption(data.aligned, data.grid, data.gmtoffset, scheme) : null),
    [data, scheme]
  );

  useEffect(() => {
    if (!result || !canvasRef.current) return;
    const init = initCanvas(canvasRef.current, 220);
    if (init) drawFraction(init.ctx, init.width, init.height, result);
  }, [result]);

  const overshoot = result ? Math.max(...result.fraction) : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">前夜米国の織り込み速度と日中の反転確率</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        <UsDriverButtons value={usTicker} onChange={setUsTicker} />
        <BinSchemeButtons value={scheme} onChange={setScheme} />
      </div>

      <LoadingError loading={loading} error={error} />
      {!loading && !error && data && !result && (
        <div className="text-xs text-gray-400">整合できた標本が不足しています。</div>
      )}

      {result && (
        <>
          <div className="rounded-md bg-indigo-50 border border-indigo-200 px-3 py-2 text-xs text-indigo-900">
            前夜米国の方向に対し、当日全体の値動きのうち <span className="font-bold">{fmtPct0(result.gapShare)}</span> は
            <span className="font-bold">寄りギャップ</span>で即座に実現（残り {fmtPct0(1 - result.gapShare)} が日中）。
            {overshoot > 1.08 && <> 途中で最大 <span className="font-bold">{fmtPct0(overshoot)}</span> まで行き過ぎ、その後戻す（オーバーシュート）。</>}
            {overshoot <= 1.08 && result.gapShare < 0.9 && <> 日中にかけてじわじわ100%へ収束（継続吸収）。</>}
          </div>

          <div className="relative"><canvas ref={canvasRef} /></div>
          <p className="text-[11px] text-gray-400">
            縦軸=当日全体(前日終値→引け)を100%とした実現割合 f(t)。青破線＝寄付(ギャップ)時点。
            100%線を超えて垂れる形＝寄りの行き過ぎ→戻し、下から100%へ近づく形＝日中の継続吸収。
          </p>

          {/* 反転確率テーブル */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">米国ビン</th>
                  <th className="text-right px-2">日数</th>
                  <th className="text-right px-2">前場勝率</th>
                  <th className="text-right px-2">後場反転率</th>
                  <th className="text-left px-2">有意性</th>
                </tr>
              </thead>
              <tbody>
                {result.reversals.filter((r) => r.n > 0).map((r) => (
                  <tr key={r.bin} className="border-b border-gray-100">
                    <td className="py-1 px-2">
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: r.color }} />
                        <span className="text-gray-700">{r.label}</span>
                      </span>
                    </td>
                    <td className="text-right px-2 text-gray-600">{r.n}</td>
                    <td className="text-right px-2 text-gray-600">{fmtPct0(r.morningWin)}</td>
                    <td className={`text-right px-2 font-medium ${r.reversalRate > 0.5 ? "text-red-700" : "text-green-700"}`}>{fmtPct0(r.reversalRate)}</td>
                    <td className="px-2"><StatBadge n={r.n} p={r.p} significant={r.p < 0.05} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-400">
            後場反転率=前場(寄り→正午)と後場(正午→引け)の符号が反対だった割合。50%より有意に高い＝後場は前場を打ち消しやすい（利確・逆張り検討）、低い＝トレンド継続。
          </p>
        </>
      )}

      <IntradayCaveat extra="全日を米国の符号で向き付けして平均。正午は時間格子の中央ビンで近似（前場/後場の厳密な境界ではない）。" />

      <AnalysisGuide title="織り込み速度・反転確率の詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"前夜の米国が示した方向へ、日本株が『いつ・どれだけ』動くか。寄りで一気に価格が付く(織り込み完了)のか、寄り後もじわじわ動く(継続)のか、あるいは寄りで行き過ぎて日中に戻す(オーバーシュート)のかを、時間の関数として測る。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"向き付け: 各日を米国の符号 s=sign(r_US) 倍する。これで『米国が上と言った日は上方向を正』に統一でき、上げの日と下げの日を平均で相殺せず足せる。"}</li>
          <li>{"前日終値基準の累積: F(t) = s·ln(P_t / 前日終値)。寄付時点は F=s·gap(ギャップ)、以降は s·(gap + 寄り基準の日中累積)。"}</li>
          <li>{"平均 M(t)=mean F(t)、実現割合 f(t)=M(t)/M(引け)。f(寄付)=ギャップが担う割合。"}</li>
          <li>{"反転率: 前場(寄り→正午)と後場(正午→引け)の符号が反対だった日の割合。米国ビン別に集計し、0.5との差をt検定。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>織り込み(price-in)</strong>: 既知情報が価格に反映され切ること。効率的なら寄りで100%織り込む。</li>
          <li><strong>オーバーシュート</strong>: 行き過ぎ。f(t)が一度100%超まで伸びて戻る形で現れる。</li>
          <li>例え: コップに水(情報)を注ぐ速度。寄りで一気に満杯(f≈1)か、少しずつ(f&lt;1から上昇)か、溢れさせてから減らす(f&gt;1→戻り)か。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>f(寄付)が小さく日中に上昇 → 寄りエントリーで継続を取りにいく余地。</li>
          <li>f が100%超へ伸びて戻る → ピーク時刻での利確、または戻りを狙う逆張り。</li>
          <li>後場反転率が高いビン → 前場の含み益は後場までに確定、引け越しは避ける。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>M(引け)が0近傍のビン(米国と無相関)では f が発散・不安定になる。エッジのある局面で使う。</li>
          <li>正午は時間格子の中央で近似しており、実際の昼休み前後と厳密には一致しない。</li>
          <li>符号での向き付けは大きさを無視するため、微小変動の日もフルに数える。方法1の分位パスと併読する。</li>
          <li>反転率のt検定はベルヌーイ近似。n が小さいビンは参考程度に。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
