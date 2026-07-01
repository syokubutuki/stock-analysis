"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { computePaths, PathResult } from "../../lib/us-spillover-path";
import { BinScheme } from "../../lib/us-spillover-core";
import { useAlignedDays, UsDriverButtons, BinSchemeButtons } from "./usSpilloverShared";
import { US_DRIVERS } from "../../hooks/useUsDaily";
import {
  initCanvas, IntervalButtons, LoadingError, IntradayCaveat, fmtSignedPct, drawTimeAxisLabels,
} from "./intradayShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

// US方向ビン別の日内平均累積パス(時間軸方向の“形” → 固定短区間の平均プロファイルなのでCanvas2D)
function drawPaths(
  ctx: CanvasRenderingContext2D, W: number, H: number, res: PathResult, showBand: boolean
) {
  const ml = 44, mr = 10, mt = 10, mb = 22;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const G = res.timeLabels.length;
  if (G < 2) return;
  const yMax = res.maxAbs * 1.05;
  const X = (g: number) => ml + (g / (G - 1)) * plotW;
  const Y = (v: number) => mt + (1 - (v + yMax) / (2 * yMax)) * plotH;

  // グリッド + ゼロ線
  ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();

  // 縦軸目盛
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(fmtSignedPct(yMax, 1), ml - 3, mt + 8);
  ctx.fillText("0", ml - 3, Y(0) + 3);
  ctx.fillText(fmtSignedPct(-yMax, 1), ml - 3, mt + plotH);

  // バンド
  if (showBand) {
    for (const b of res.bins) {
      if (b.n === 0) continue;
      ctx.fillStyle = b.color + "22";
      ctx.beginPath();
      for (let g = 0; g < G; g++) ctx.lineTo(X(g), Y(b.hi[g]));
      for (let g = G - 1; g >= 0; g--) ctx.lineTo(X(g), Y(b.lo[g]));
      ctx.closePath(); ctx.fill();
    }
  }

  // 平均パス
  for (const b of res.bins) {
    if (b.n === 0) continue;
    ctx.strokeStyle = b.color; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let g = 0; g < G; g++) { const x = X(g), y = Y(b.path[g]); if (g === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  }

  drawTimeAxisLabels(ctx, res.timeLabels, ml, plotW / G, H - 6);
}

export default function UsPathChart({ ticker }: Props) {
  const [usTicker, setUsTicker] = useState("^GSPC");
  const [interval, setInterval] = useState("15m");
  const [scheme, setScheme] = useState<BinScheme>("tercile");
  const [showBand, setShowBand] = useState(true);
  const { data, loading, error } = useAlignedDays(ticker, interval, usTicker);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const result: PathResult | null = useMemo(
    () => (data ? computePaths(data.aligned, data.grid, data.gmtoffset, scheme) : null),
    [data, scheme]
  );

  useEffect(() => {
    if (!result || !canvasRef.current) return;
    const init = initCanvas(canvasRef.current, 260);
    if (init) drawPaths(init.ctx, init.width, init.height, result, showBand);
  }, [result, showBand]);

  const usLabel = US_DRIVERS.find((d) => d.ticker === usTicker)?.label ?? usTicker;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">前夜米国ビン × 当日日内 平均累積パス</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        <UsDriverButtons value={usTicker} onChange={setUsTicker} />
        <BinSchemeButtons value={scheme} onChange={setScheme} />
        <label className="flex items-center gap-1 text-xs text-gray-600">
          <input type="checkbox" checked={showBand} onChange={(e) => setShowBand(e.target.checked)} />
          95%帯
        </label>
      </div>

      <LoadingError loading={loading} error={error} />
      {!loading && !error && data && !result && (
        <div className="text-xs text-gray-400">整合できた標本が不足しています。</div>
      )}

      {result && (
        <>
          {/* 凡例 */}
          <div className="flex items-center gap-3 flex-wrap text-[11px]">
            {result.bins.map((b) => (
              <span key={b.bin} className="inline-flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: b.color }} />
                <span className="text-gray-600">{b.label}（n={b.n}）</span>
              </span>
            ))}
          </div>

          <div className="relative"><canvas ref={canvasRef} /></div>

          {/* 寄り→引け サマリー */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">米国ビン</th>
                  <th className="text-right px-2">日数</th>
                  <th className="text-right px-2">寄り→引け平均</th>
                  <th className="text-left px-2">有意性</th>
                </tr>
              </thead>
              <tbody>
                {result.bins.filter((b) => b.n > 0).map((b) => (
                  <tr key={b.bin} className="border-b border-gray-100">
                    <td className="py-1 px-2">
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: b.color }} />
                        <span className="text-gray-700">{b.label}</span>
                      </span>
                    </td>
                    <td className="text-right px-2 text-gray-600">{b.n}</td>
                    <td className={`text-right px-2 font-medium ${b.endMean >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(b.endMean)}</td>
                    <td className="px-2"><StatBadge n={b.n} p={b.endP} significant={b.endP < 0.05} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-400">
            各線は前夜 {usLabel} のビンに属する日の、寄り基準の平均累積リターン。右肩上がり＝日中も買われる、
            寄り直後にピークを打って垂れる＝寄り天フェード。
          </p>
        </>
      )}

      <IntradayCaveat extra="寄り(始値)を0起点に日内の平均的な値動きの形を描く。ビン間で終端の高さ・途中の凹凸を比較する。" />

      <AnalysisGuide title="日内平均累積パス（イベントスタディ）の詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"前夜の米国の強弱でその日を分類し、寄り付きを基準に『1日を通してどんな形で値が動いたか』の平均を重ねて描く。回帰(方法2)は“1日を1つの数字(始値→終値)”に潰すため途中経過が見えないが、パスにすると『寄りで跳ねてすぐ戻す』『じわじわ上げる』といった時間的な形が分かる。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"各営業日について、寄り基準の累積対数リターン r(t) = ln(P_t / 始値) を時間格子上で算出(P_t=その時間ビンの終値、無ければ直前値で補完)。"}</li>
          <li>{"前夜米国リターンでビン分割(陰陽/3分位/5分位)。分位は順位で均等分割するので各ビンの日数がほぼ揃う。"}</li>
          <li>{"ビンごとに各時刻の平均パスを取り、平均 ± 1.96·標準誤差(SE=σ/√n)を95%帯として重ねる。"}</li>
          <li>{"終端(寄り→引け)の平均が0と異なるかを1標本t検定で評価。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>右肩上がりで終端が高い</strong>: そのビンの日は日中も同方向に伸びる(継続/順張り有利)。</li>
          <li><strong>寄り直後に山→その後低下</strong>: 寄りで行き過ぎ、日中に戻す(フェード/逆張り有利)。ピーク時刻が手仕舞いの目安。</li>
          <li><strong>帯(95%)が0線をまたぐ</strong>: その時刻の平均は0と区別できない=エッジ薄い。帯が0の片側に収まる時間帯が狙い目。</li>
          <li>ビン間で線が上下にきれいに並ぶ(米大幅高が最上、米大幅安が最下)ほど、米国→日中の連動が強い。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>継続型のビンでは寄りエントリー、フェード型のビンでは寄り逆張りと、ビンごとに戦略を切り替える。</li>
          <li>パスのピーク/ボトム時刻が、そのビンでの利確・手仕舞いの時間目安になる(方法5で厳密にスキャン)。</li>
          <li>方法2のβと併読: βで方向、パスでタイミングを決める。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>分位を細かくするほど1ビンの日数が減り、パスがギザつく。5/15分足は約60日しか取れないため、5分位×多足だと各ビン数日になり不安定。</li>
          <li>平均パスは外れ値(大事件の日)に引っ張られる。帯の広がりで信頼度を確認する。</li>
          <li>特定レジーム(強い上昇相場等)に日が偏ると、米国と無関係な地合いを米国効果と誤認しうる。</li>
          <li>時間格子はデータ実測のセッション範囲から作る。前場/後場の昼休みは連続扱いになる点に留意。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
