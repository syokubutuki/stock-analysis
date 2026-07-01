"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { computeLeadLag, LeadLagResult } from "../../lib/us-spillover-leadlag";
import { useAlignedDays, UsDriverButtons } from "./usSpilloverShared";
import {
  initCanvas, IntervalButtons, LoadingError, IntradayCaveat, drawTimeAxisLabels,
} from "./intradayShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

// 累積相関(実線・藍)と限界相関(破線・橙)の日内推移。相関は[-1,1] → 静的曲線でCanvas2D。
function drawCorr(ctx: CanvasRenderingContext2D, W: number, H: number, res: LeadLagResult) {
  const ml = 34, mr = 10, mt = 12, mb = 22;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const N = res.timeLabels.length;
  if (N < 2) return;
  const yMax = Math.max(0.5, ...res.corrCum.map(Math.abs), ...res.corrMarg.map(Math.abs)) * 1.1;
  const X = (i: number) => ml + (i / (N - 1)) * plotW;
  const Y = (v: number) => mt + (1 - (v + yMax) / (2 * yMax)) * plotH;

  ctx.strokeStyle = "#f0f0f0";
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(yMax.toFixed(2), ml - 3, mt + 8);
  ctx.fillText("0", ml - 3, Y(0) + 3);
  ctx.fillText((-yMax).toFixed(2), ml - 3, mt + plotH);

  // 累積相関(実線)
  ctx.strokeStyle = "#4338ca"; ctx.lineWidth = 2; ctx.beginPath();
  res.corrCum.forEach((v, i) => { const x = X(i), y = Y(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  // 限界相関(破線)
  ctx.strokeStyle = "#ea580c"; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.beginPath();
  res.corrMarg.forEach((v, i) => { const x = X(i), y = Y(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke(); ctx.setLineDash([]);

  drawTimeAxisLabels(ctx, res.timeLabels, ml, plotW / N, H - 6);
}

export default function UsLeadLagChart({ ticker }: Props) {
  const [usTicker, setUsTicker] = useState("^GSPC");
  const [interval, setInterval] = useState("15m");
  const { data, loading, error } = useAlignedDays(ticker, interval, usTicker);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const result: LeadLagResult | null = useMemo(
    () => (data ? computeLeadLag(data.aligned, data.grid, data.gmtoffset) : null),
    [data]
  );

  useEffect(() => {
    if (!result || !canvasRef.current) return;
    const init = initCanvas(canvasRef.current, 220);
    if (init) drawCorr(init.ctx, init.width, init.height, result);
  }, [result]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">前夜米国 → 日中相関の減衰（米国の記憶は何時まで効くか）</h3>
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
            寄付時点の相関 <span className="font-bold">{result.gapCorr.toFixed(2)}</span>、引けでの累積相関 <span className="font-bold">{result.endCorr.toFixed(2)}</span>。
            {result.halfLifeLabel
              ? <> 米国連動の新規流入(限界相関)は <span className="font-bold">{result.halfLifeLabel}</span> 頃に寄付の半分以下へ減衰 → それ以降は米国材料が薄れる。</>
              : <> 限界相関が日中も高止まり → 米国の記憶が引けまで残るタイプ。</>}
          </div>

          <div className="flex items-center gap-3 flex-wrap text-[11px]">
            <span className="inline-flex items-center gap-1"><span className="inline-block w-4 h-0.5" style={{ backgroundColor: "#4338ca" }} /><span className="text-gray-600">累積相関(積み上がり)</span></span>
            <span className="inline-flex items-center gap-1"><span className="inline-block w-4 h-0.5 border-t-2 border-dashed" style={{ borderColor: "#ea580c" }} /><span className="text-gray-600">限界相関(その時間帯の新規流入)</span></span>
          </div>

          <div className="relative"><canvas ref={canvasRef} /></div>
          <p className="text-[11px] text-gray-400">
            限界相関が寄り(寄付〜寄り直後)で高く、その後0へ落ちるほど「米国は寄りで吸収」。日中まで正のままなら「米国順張りが日中も有効」。
            累積相関が寄付から伸びず横ばいなら、米国の影響は寄りギャップで完結している。
          </p>
        </>
      )}

      <IntradayCaveat extra="相関はピアソン相関(全日の r_US と当日各時点値)。符号は保持(向き付けしない)。" />

      <AnalysisGuide title="日内相関減衰（リード・ラグ）の詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"前夜米国の値動きと、当日の日本株の値動きの相関が、時刻とともにどう変化するか。米国という『先行情報』が日中のどのタイミングまで効き続けるか(記憶の長さ)を測る。相関が寄りで一気に立ち上がって以後フラットなら寄りで消化、日中も相関が伸び続けるなら追随余地がある。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"累積相関 corrCum(t) = corr(r_US, 前日終値→時刻t の累積対数リターン)。時刻tまでに積み上がった連動。"}</li>
          <li>{"限界相関 corrMarg(t) = corr(r_US, 時刻tの時間ビン増分)。その時間帯に新たに入る米国連動。"}</li>
          <li>{"相関はピアソン相関 corr(x,y)=Σ(xᵢ−x̄)(yᵢ−ȳ)/√(Σ(xᵢ−x̄)²·Σ(yᵢ−ȳ)²)。全営業日を1点として計算。"}</li>
          <li>{"半減時刻: 限界相関が寄付時の半分を初めて下回る時刻。米国情報の“吸収の速さ”の目安。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>リード・ラグ</strong>: 一方が先行(lead)し他方が遅れて追う(lag)関係。ここでは米国が先行。</li>
          <li><strong>限界(marginal)</strong>: 全体でなく「その1コマ分の追加寄与」。増分に対する相関。</li>
          <li>例え: やまびこ。叫んだ直後(寄り)に大きく返り、時間が経つほど小さくなる。返りが尾を引く谷ほど「記憶が長い」。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>限界相関が高い時間帯＝米国順張りが効く時間帯。半減時刻より前にエントリーを済ませる。</li>
          <li>累積相関が寄付以降ほぼ伸びない銘柄は、寄り(ギャップ)で勝負が決まり日中の米国由来エッジは薄い。</li>
          <li>方法1(パス)・方法3(織り込み速度)と同じ時間軸で並べ、方向・速度・相関の3視点で整合を取る。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>相関は線形の連動のみ。非線形(大変動時だけ連動)は捉えにくい。</li>
          <li>サンプルが少ないと相関は不安定(特に5/15分足は約60日)。値の絶対水準より曲線の形を見る。</li>
          <li>相関≠因果。共通要因(世界的リスクオン/オフ)が両者を動かしている可能性。</li>
          <li>限界相関はノイズを拾いやすく、細かい上下は誤差の範囲のことが多い。大局の減衰傾向で判断する。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
