"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { computeVol, VolResult } from "../../lib/us-spillover-vol";
import { Regression } from "../../lib/us-spillover-core";
import { useAlignedDays, UsDriverButtons } from "./usSpilloverShared";
import {
  initCanvas, IntervalButtons, LoadingError, IntradayCaveat, fmtPct, drawTimeAxisLabels,
} from "./intradayShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

// |r_US|(横, ≥0) × 当日実現ボラ(縦) の散布 + 回帰(Canvas2D)
function drawVolScatter(ctx: CanvasRenderingContext2D, W: number, H: number, pts: { x: number; y: number }[], reg: Regression) {
  const ml = 44, mr = 10, mt = 10, mb = 26;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  if (pts.length === 0) return;
  const xMax = Math.max(1e-4, ...pts.map((p) => p.x));
  const yMax = Math.max(1e-4, ...pts.map((p) => p.y));
  const X = (x: number) => ml + (x / xMax) * plotW;
  const Y = (y: number) => mt + (1 - y / yMax) * plotH;

  ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(ml, mt + plotH); ctx.lineTo(ml + plotW, mt + plotH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ml, mt); ctx.lineTo(ml, mt + plotH); ctx.stroke();

  for (const p of pts) { ctx.fillStyle = "#6366f199"; ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 2.4, 0, Math.PI * 2); ctx.fill(); }

  ctx.strokeStyle = "#dc2626"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(X(0), Y(reg.alpha)); ctx.lineTo(X(xMax), Y(reg.alpha + reg.beta * xMax)); ctx.stroke();

  ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("前夜 |米国リターン| →", ml + plotW / 2, H - 8);
  ctx.save(); ctx.translate(11, mt + plotH / 2); ctx.rotate(-Math.PI / 2); ctx.fillText("当日 実現ボラ →", 0, 0); ctx.restore();
  ctx.textAlign = "right"; ctx.fillStyle = "#9ca3af";
  ctx.fillText(fmtPct(yMax, 1), ml - 3, mt + 8);
  ctx.textAlign = "left"; ctx.fillText(fmtPct(xMax, 1), ml + plotW - 20, mt + plotH - 3);
}

// |US|大きさ別の日内ボラプロファイル(Canvas2D)
function drawVolPaths(ctx: CanvasRenderingContext2D, W: number, H: number, res: VolResult) {
  const ml = 44, mr = 10, mt = 10, mb = 22;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const G = res.timeLabels.length;
  if (G < 2) return;
  const yMax = res.maxVol * 1.05;
  const X = (g: number) => ml + (g / (G - 1)) * plotW;
  const Y = (v: number) => mt + (1 - v / yMax) * plotH;
  ctx.strokeStyle = "#f0f0f0";
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  for (const p of res.volPaths) {
    if (p.n === 0) continue;
    ctx.strokeStyle = p.color; ctx.lineWidth = 2; ctx.beginPath();
    for (let g = 0; g < G; g++) { const x = X(g), y = Y(p.path[g]); if (g === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  }
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(fmtPct(yMax, 1), ml - 3, mt + 8);
  drawTimeAxisLabels(ctx, res.timeLabels, ml, plotW / G, H - 6);
}

export default function UsVolSpilloverChart({ ticker }: Props) {
  const [usTicker, setUsTicker] = useState("^GSPC");
  const [interval, setInterval] = useState("15m");
  const { data, loading, error } = useAlignedDays(ticker, interval, usTicker);
  const scatterRef = useRef<HTMLCanvasElement>(null);
  const pathRef = useRef<HTMLCanvasElement>(null);

  const result: VolResult | null = useMemo(
    () => (data ? computeVol(data.aligned, data.grid, data.gmtoffset) : null),
    [data]
  );

  useEffect(() => {
    if (!result || !scatterRef.current) return;
    const init = initCanvas(scatterRef.current, 220);
    if (init) drawVolScatter(init.ctx, init.width, init.height, result.samples.map((s) => ({ x: s.absUs, y: s.vol })), result.volReg);
  }, [result]);

  useEffect(() => {
    if (!result || !pathRef.current) return;
    const init = initCanvas(pathRef.current, 200);
    if (init) drawVolPaths(init.ctx, init.width, init.height, result);
  }, [result]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">ボラティリティ・スピルオーバー（米国の荒れ → 当日の荒れ）</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>
      <UsDriverButtons value={usTicker} onChange={setUsTicker} />

      <LoadingError loading={loading} error={error} />
      {!loading && !error && data && !result && (
        <div className="text-xs text-gray-400">整合できた標本が不足しています。</div>
      )}

      {result && (
        <>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="p-2 rounded border border-red-200 bg-red-50">
              <div className="text-gray-500">実現ボラ 感応 β</div>
              <div className="font-mono font-medium text-base">{result.volReg.beta.toFixed(2)}</div>
              <div className="text-[10px] text-gray-400">相関 {result.volReg.corr.toFixed(2)} / R² {result.volReg.r2.toFixed(2)}</div>
              <div className="mt-0.5"><StatBadge n={result.volReg.n} p={result.volReg.pBeta} significant={result.volReg.pBeta < 0.05} /></div>
            </div>
            <div className="p-2 rounded border border-amber-200 bg-amber-50">
              <div className="text-gray-500">高安レンジ 感応 β</div>
              <div className="font-mono font-medium text-base">{result.rangeReg.beta.toFixed(2)}</div>
              <div className="text-[10px] text-gray-400">相関 {result.rangeReg.corr.toFixed(2)} / R² {result.rangeReg.r2.toFixed(2)}</div>
              <div className="mt-0.5"><StatBadge n={result.rangeReg.n} p={result.rangeReg.pBeta} significant={result.rangeReg.pBeta < 0.05} /></div>
            </div>
          </div>

          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-700">
            前夜米国の変動が1%大きいほど、当日の実現ボラは約 <span className="font-bold">{fmtPct(result.volReg.beta * 0.01, 2)}</span> 増える傾向。
            {result.volReg.pBeta < 0.05 ? " 統計的に有意 → 米国が荒れた翌日は建玉を軽く・想定レンジを広く。" : " 有意ではない → この銘柄では米国ボラの波及は弱い。"}
          </div>

          <div className="pt-2 border-t border-gray-100 space-y-1">
            <div className="text-xs text-gray-500">|米国リターン| × 当日実現ボラ（散布・回帰）</div>
            <div className="relative"><canvas ref={scatterRef} /></div>
          </div>

          <div className="pt-2 border-t border-gray-100 space-y-2">
            <div className="text-xs text-gray-500">日内ボラプロファイル（米国変動の大きさ3分位別）</div>
            <div className="flex items-center gap-3 flex-wrap text-[11px]">
              {result.volPaths.map((p) => (
                <span key={p.label} className="inline-flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: p.color }} />
                  <span className="text-gray-600">{p.label}（n={p.n}）</span>
                </span>
              ))}
            </div>
            <div className="relative"><canvas ref={pathRef} /></div>
            <p className="text-[11px] text-gray-400">
              赤(米国大変動)の線が寄り直後に高く盛り上がるほど、荒れた米国の翌日は「寄り集中型」のボラ。
              終日高止まりなら終日荒れる。
            </p>
          </div>
        </>
      )}

      <IntradayCaveat extra="実現ボラ=日中各バーのGarman-Klass分散の合計の平方根。レンジ=ln(高値/安値)。" />

      <AnalysisGuide title="ボラティリティ・スピルオーバーの詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"リターンの『向き』ではなく『激しさ』の波及。米国が大きく動いた(上下どちらでも)日の翌日、日本株の日中ボラティリティが膨らむか。ボラは連続して高い/低い状態が続く性質(ボラティリティ・クラスタリング)があり、それが市場間で伝播するかを測る。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"当日の実現ボラ: 日中各バーの Garman-Klass 分散 σ²_GK = 0.5·(ln(H/L))² − (2ln2−1)·(ln(C/O))² を合計し平方根。O,H,L,C はバーの四本値。"}</li>
          <li>{"高安レンジ: ln(当日高値 / 当日安値)。日中の値幅の素朴な尺度。"}</li>
          <li>{"回帰: 実現ボラ = α + β·|r_US|。|r_US| は前夜米国リターンの絶対値(=変動の大きさ)。"}</li>
          <li>{"日内プロファイル: |r_US| を3分位に分け、各時間ビンの平均バーボラをビン別に描く。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>実現ボラ(realized volatility)</strong>: 実際に観測された値動きから測ったボラ。将来予想でなく事後の実測値。</li>
          <li><strong>Garman-Klass</strong>: 四本値(高安始終)を使い、終値だけより効率よく分散を推定する式。</li>
          <li><strong>クラスタリング</strong>: 嵐は連日続く、凪も続く。ボラの自己相関。例え: 池に大きな石(米国の大変動)を落とすと、翌日まで波(日本のボラ)が残る。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>βが有意に正 → 米国が荒れた翌日は建玉サイズを落とし、損切り/利確幅(想定レンジ)を広げる。</li>
          <li>寄り集中型なら、寄り直後のブレイクアウト/ストラドル的な戦略が機能しやすい時間帯を特定できる。</li>
          <li>方向(方法2)×大きさ(本手法)を組み合わせ、「方向は米国順張り・サイズはボラ連動で調整」といった運用に使う。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>実現ボラは足の粗さに依存(5分足と60分足でスケールが違う)。同一足の中で比較する。</li>
          <li>GK分散は窓(オーバーナイトギャップ)を含まない。ギャップの荒れは別途ギャップ分析で。</li>
          <li>出来高急増・イベント(決算・指標)日が混じると外れ値になりうる。散布の裾を確認する。</li>
          <li>相関≠因果。共通の世界的リスク要因(VIX等)が両市場を同時に動かしている可能性。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
