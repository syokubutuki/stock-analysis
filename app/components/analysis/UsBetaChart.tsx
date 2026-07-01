"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { computeBeta, BetaResult, BetaLine } from "../../lib/us-spillover-beta";
import {
  useAlignedDays, UsDriverButtons,
} from "./usSpilloverShared";
import { US_DRIVERS } from "../../hooks/useUsDaily";
import {
  initCanvas, IntervalButtons, LoadingError, IntradayCaveat, fmtSignedPct, ViewTabs,
} from "./intradayShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

type Target = "gap" | "intra" | "full";
const TARGETS: { value: Target; label: string }[] = [
  { value: "gap", label: "ギャップ" },
  { value: "intra", label: "日中" },
  { value: "full", label: "当日" },
];

const fmtBeta = (v: number) => (isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "—");
const fmtPct0 = (v: number) => (isFinite(v) ? `${(v * 100).toFixed(0)}%` : "—");

function targetOf(s: { gap: number; intra: number; full: number }, t: Target) {
  return t === "gap" ? s.gap : t === "intra" ? s.intra : s.full;
}

// r_US(横) × 選択ターゲット(縦) の散布 + OLS回帰線(時間軸でない静的図 → Canvas2D)
function drawScatter(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  pts: { x: number; y: number }[], line: BetaLine, targetLabel: string
) {
  const ml = 44, mr = 12, mt = 12, mb = 28;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  if (pts.length === 0) return;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const xMax = Math.max(1e-4, ...xs.map(Math.abs));
  const yMax = Math.max(1e-4, ...ys.map(Math.abs));
  const X = (x: number) => ml + ((x + xMax) / (2 * xMax)) * plotW;
  const Y = (y: number) => mt + (1 - (y + yMax) / (2 * yMax)) * plotH;

  // ゼロ軸
  ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X(0), mt); ctx.lineTo(X(0), mt + plotH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();

  // 象限の淡い着色ヒント(順張り=左下/右上緑, 逆張り=左上/右下赤)は省き、点のみ
  for (const p of pts) {
    ctx.fillStyle = p.y >= 0 ? "#16a34a99" : "#dc262699";
    ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 2.4, 0, Math.PI * 2); ctx.fill();
  }

  // 回帰線
  const { alpha, beta } = line.reg;
  ctx.strokeStyle = "#4338ca"; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(X(-xMax), Y(alpha + beta * -xMax));
  ctx.lineTo(X(xMax), Y(alpha + beta * xMax));
  ctx.stroke();

  // 軸ラベル
  ctx.fillStyle = "#6b7280"; ctx.font = "9px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("前夜 米国リターン →", ml + plotW / 2, H - 8);
  ctx.save();
  ctx.translate(11, mt + plotH / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText(`JP ${targetLabel} →`, 0, 0);
  ctx.restore();
  // 目盛(±xMax, ±yMax)
  ctx.textAlign = "left"; ctx.fillStyle = "#9ca3af";
  ctx.fillText(fmtSignedPct(yMax, 1), ml + 2, mt + 9);
  ctx.fillText(fmtSignedPct(-yMax, 1), ml + 2, mt + plotH - 2);
  ctx.textAlign = "right";
  ctx.fillText(fmtSignedPct(xMax, 1), ml + plotW, Y(0) - 3);
  ctx.textAlign = "left";
  ctx.fillText(fmtSignedPct(-xMax, 1), ml, Y(0) - 3);
}

function BetaCard({ title, line, tone, hint }: { title: string; line: BetaLine; tone: string; hint: string }) {
  const { reg, ci } = line;
  return (
    <div className={`p-2 rounded border ${tone}`}>
      <div className="text-gray-500">{title}</div>
      <div className="font-mono font-medium text-base">{fmtBeta(reg.beta)}</div>
      <div className="text-[10px] text-gray-400">
        95%CI [{fmtBeta(ci.lo)}, {fmtBeta(ci.hi)}]
      </div>
      <div className="mt-0.5">
        <StatBadge n={reg.n} p={reg.pBeta} significant={reg.pBeta < 0.05} />
      </div>
      <div className="text-[10px] text-gray-400 mt-0.5">{hint}</div>
    </div>
  );
}

export default function UsBetaChart({ ticker }: Props) {
  const [usTicker, setUsTicker] = useState("^GSPC");
  const [interval, setInterval] = useState("60m");
  const [target, setTarget] = useState<Target>("intra");
  const { data, loading, error } = useAlignedDays(ticker, interval, usTicker);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const result: BetaResult | null = useMemo(
    () => (data ? computeBeta(data.aligned) : null),
    [data]
  );

  const scatterPts = useMemo(() => {
    if (!result) return [];
    return result.samples.map((s) => ({ x: s.us, y: targetOf(s, target) }));
  }, [result, target]);

  const activeLine = result
    ? target === "gap" ? result.gap : target === "intra" ? result.intra : result.full
    : null;

  useEffect(() => {
    if (!result || !activeLine || !canvasRef.current) return;
    const init = initCanvas(canvasRef.current, 240);
    if (init) drawScatter(init.ctx, init.width, init.height, scatterPts, activeLine,
      TARGETS.find((t) => t.value === target)!.label);
  }, [result, activeLine, scatterPts, target]);

  const usLabel = US_DRIVERS.find((d) => d.ticker === usTicker)?.label ?? usTicker;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">
          前夜米国 → 当日スピルオーバーβ（ギャップ織り込み分解）
        </h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <UsDriverButtons value={usTicker} onChange={setUsTicker} />
      </div>

      <LoadingError loading={loading} error={error} />
      {!loading && !error && data && !result && (
        <div className="text-xs text-gray-400">整合できた標本が不足しています（日中足の期間が短い可能性）。</div>
      )}

      {result && activeLine && (
        <>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <BetaCard title="β_gap（ギャップ）" line={result.gap}
              tone="border-sky-200 bg-sky-50" hint="米国が寄りで織り込まれる度合い" />
            <BetaCard title="β_intra（日中）" line={result.intra}
              tone={result.reaction === "fade" ? "border-red-200 bg-red-50" : result.reaction === "momentum" ? "border-emerald-200 bg-emerald-50" : "border-gray-200 bg-gray-50"}
              hint="日中への漏れ出し（符号が要点）" />
            <BetaCard title="β_full（当日）" line={result.full}
              tone="border-gray-200 bg-gray-50" hint="当日トータルの感応度" />
          </div>

          {/* 解釈バナー */}
          <div className={`rounded-md px-3 py-2 text-xs ${
            result.reaction === "fade" ? "bg-red-50 text-red-900 border border-red-200"
              : result.reaction === "momentum" ? "bg-emerald-50 text-emerald-900 border border-emerald-200"
              : "bg-gray-50 text-gray-700 border border-gray-200"}`}>
            <span className="font-bold">
              {result.reaction === "fade" ? "過剰反応→日中フェード型" : result.reaction === "momentum" ? "過小反応→日中継続型" : "日中は中立"}
            </span>
            {"："}
            前夜 {usLabel} の動きのうち、寄りギャップで <span className="font-bold">{fmtPct0(result.absorption)}</span> を消化し、
            日中へ <span className="font-bold">{fmtPct0(result.leak)}</span> が漏れ出す（β_full基準）。
            {result.reaction === "fade" && " 寄りで行き過ぎ、日中は逆方向に戻しやすい → 寄り逆張りの候補。"}
            {result.reaction === "momentum" && " 寄り後も同方向に続きやすい → 寄り順張りの候補。"}
            {result.reaction === "neutral" && " 日中の追随/反転は統計的にはっきりしない。"}
          </div>

          {/* 散布図 */}
          <div className="pt-2 border-t border-gray-100 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-500">縦軸(JP):</span>
              <ViewTabs value={target} onChange={setTarget} views={TARGETS} />
              <span className="text-[11px] text-gray-400">緑=プラス日 / 赤=マイナス日・青線=OLS回帰</span>
            </div>
            <div className="relative"><canvas ref={canvasRef} /></div>
            <p className="text-[11px] text-gray-400">
              回帰の傾き=β（相関 {activeLine.reg.corr.toFixed(2)} / R² {activeLine.reg.r2.toFixed(2)} / n={activeLine.reg.n}）。
              点が右上・左下に集まるほど正の感応、右下・左上に散るほど逆行。
            </p>
          </div>
        </>
      )}

      <IntradayCaveat extra="前夜米国=当該立会日の寄り前で最後に確定した米国正規セッション（祝日・連休は自動で前営業日に整合）。60分足はサンプルが多く回帰が安定、5/15分足は約60日と薄い。" />

      <AnalysisGuide title="スピルオーバーβ・ギャップ織り込み分解の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"米国市場は日本時間の翌朝に引ける。日本が寄り付く時点で前夜の米国の値動きは『既知の情報』であり、まず寄りのギャップ(窓)に織り込まれる。問題は“どれだけ寄りで消化され、どれだけ日中に持ち越されるか”。ここでは前夜の米国リターンを説明変数に、当日JPの『ギャップ』『日中』『当日トータル』をそれぞれ回帰し、影響が寄りで完結するか日中へ漏れるかを分離する。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"前夜米国: r_US = ln(米国終値 / 米国前日終値)。当該JP立会日の寄り前で最後に確定した米国セッションを用いる。"}</li>
          <li>{"JP ギャップ: gap = ln(始値 / 前日終値)。JP 日中: intra = ln(終値 / 始値)。JP 当日: full = ln(終値 / 前日終値) = gap + intra。"}</li>
          <li>{"回帰: gap = α₁ + β_gap·r_US、intra = α₂ + β_intra·r_US、full = α₃ + β_full·r_US。対数の加法性より β_full = β_gap + β_intra。"}</li>
          <li>{"消化率 absorption = β_gap / β_full、漏れ率 leak = β_intra / β_full。両者の和は1。"}</li>
          <li>{"βの標準誤差 se(β)=√(σ²/Σ(x−x̄)²)、σ²=残差二乗和/(n−2)。t=β/se(β) からt分布両側p値。95%CIはペア・ブートストラップ。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>スピルオーバー(波及)</strong>: ある市場の変動が別の市場へ染み出す現象。ここでは米国→日本。</li>
          <li><strong>ギャップ(窓)</strong>: 前日終値と当日始値の差。休場中に到着した情報(＝米国)を寄り付きが一気に価格へ反映した跡。</li>
          <li><strong>過剰反応 / 過小反応</strong>: 寄りが情報を“行き過ぎて”価格付けたのが過剰反応(→日中で戻る)、“控えめ”なのが過小反応(→日中も続く)。</li>
          <li>例え: ニュースを聞いた瞬間に値段を全部つけ切る(消化)か、開場後もじわじわ調整する(漏れ)か。β_intra はその“やり残し”の符号。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>β_intra &gt; 0（継続型）</strong>: 米国高の翌日は寄り後も上がりやすい → 寄り順張り(寄り買い→引け売り)の候補。</li>
          <li><strong>β_intra &lt; 0（フェード型）</strong>: 寄りで行き過ぎ日中に戻す → 寄り逆張り(寄りで売り→戻り待ち)の候補。</li>
          <li><strong>absorption が高い(≈1)</strong>: 米国は寄りでほぼ消化され、日中に取れるエッジは小さい。</li>
          <li>縦軸を『ギャップ』にすると織り込みの強さ、『日中』にすると取引可能なエッジの向きが直接見える。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>β_intra が小さくても有意でなければ実運用に足りない。StatBadge の n・p を必ず確認する(5/15分足は n が小)。</li>
          <li>線形回帰なので、大幅安の日だけ非対称に反応する等の非線形は捉えられない（→ 方法1の分位パスで補完）。</li>
          <li>ドライバ指数の選択で結果は変わる。ハイテク銘柄は S&P500 より NASDAQ/SOX が効くことがある（→ 方法7で比較）。</li>
          <li>為替(円)や日本固有材料も寄りに混じる。ここで測るのは“米国で説明できる分”のみ。</li>
          <li>取引コスト・スリッページ・寄り成りの約定価格ズレは未考慮。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
