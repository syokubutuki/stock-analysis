"use client";

// 週内Embedding(週の関数PCA / 固有週アトラス)。
// 各週を「前週末=0%の週内累積経路(5点)」ベクトルにして関数PCAで2D座標へ写し、過去の全週を1枚の地図にする。
// weekly-analog(局所・最近傍で今週に似た過去週を引く)とは違い、これは大域の地形図:
//   ① どんな週の型が存在するか(点群の形)
//   ② 固有週 = 週の形の直交基底(PC1≈週ドリフト, PC2≈月重心vs金重心, PC3≈曲率)
//   ③ 形空間全体で「形→翌週リターン」に系統性があるか(結果フィールド着色 + kNN-IC検定 + OOS)
// 正直さの門番: 地図は必ずクラスタに見える(偽パターン)。ゆえに翌週リターンの予測力を
// ブロック順列ヌルと学習/検証OOSで検定し、ヌルを超えなければ「使うな」と赤で言う。

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  computeWeekEmbedding, WeekEmbeddingResult, EmbeddingView, EmbedVariant,
} from "../../lib/week-embedding";
import AnalysisGuide from "./AnalysisGuide";
import { CHART_COLORS } from "../../lib/chart-colors";

interface Props { prices: PricePoint[]; }

type ColorMode = "outcome" | "era";

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

// 発散カラーマップ(青=負, 灰=0, 赤=正)。t ∈ [-1,1]。
function divergeColor(t: number, alpha = 1): string {
  const x = Math.max(-1, Math.min(1, t));
  let r: number, g: number, b: number;
  if (x >= 0) { r = 220; g = Math.round(220 - 160 * x); b = Math.round(220 - 170 * x); }
  else { const a = -x; r = Math.round(220 - 170 * a); g = Math.round(220 - 120 * a); b = 220; }
  return `rgba(${r},${g},${b},${alpha})`;
}
// 年代カラーマップ(古=薄灰 → 新=濃青紫)。f ∈ [0,1]。
function eraColor(f: number, alpha = 1): string {
  const r = Math.round(200 - 120 * f), g = Math.round(200 - 150 * f), b = Math.round(210 - 40 * f);
  return `rgba(${r},${g},${b},${alpha})`;
}

// 固有週(loading 5点)を小さな折れ線で描く。
function drawEigen(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, loading: number[], color: string, label: string, sub: string) {
  const n = loading.length;
  const amp = Math.max(1e-6, ...loading.map((v) => Math.abs(v)));
  const xOf = (i: number) => x0 + (i / (n - 1)) * w;
  const yOf = (v: number) => y0 + h / 2 - (v / amp) * (h / 2 - 3);
  ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0, yOf(0)); ctx.lineTo(x0 + w, yOf(0)); ctx.stroke();
  ctx.strokeStyle = color; ctx.lineWidth = 1.8;
  ctx.beginPath();
  loading.forEach((v, i) => ctx[i === 0 ? "moveTo" : "lineTo"](xOf(i), yOf(v)));
  ctx.stroke();
  ctx.fillStyle = color;
  loading.forEach((v, i) => { ctx.beginPath(); ctx.arc(xOf(i), yOf(v), 1.8, 0, Math.PI * 2); ctx.fill(); });
  ctx.fillStyle = "#374151"; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(label, x0, y0 - 3);
  ctx.fillStyle = CHART_COLORS.ink; ctx.font = "8px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(sub, x0 + w, y0 - 3);
}

// アトラス(PC1×PC2 散布)+ 直近週の時系列軌跡 + 最新週マーカー。
function drawAtlas(
  canvas: HTMLCanvasElement, view: EmbeddingView, result: WeekEmbeddingResult,
  colorMode: ColorMode, showTraj: boolean
) {
  const init = initCanvas(canvas, 300);
  if (!init) return;
  const { ctx, width, height } = init;
  const pts = view.points;
  if (pts.length < 3) return;
  const ml = 8, mr = 8, mt = 20, mb = 8;
  const plotW = width - ml - mr, plotH = height - mt - mb;

  const xs = pts.map((p) => p.score[0] ?? 0), ys = pts.map((p) => p.score[1] ?? 0);
  const xMin = Math.min(...xs), xMax = Math.max(...xs), yMin = Math.min(...ys), yMax = Math.max(...ys);
  const padX = (xMax - xMin) * 0.05 || 1, padY = (yMax - yMin) * 0.05 || 1;
  const xOf = (v: number) => ml + ((v - (xMin - padX)) / ((xMax + padX) - (xMin - padX))) * plotW;
  const yOf = (v: number) => mt + plotH - ((v - (yMin - padY)) / ((yMax + padY) - (yMin - padY))) * plotH;

  // 結果着色のスケール(robust: 絶対値の90分位)
  const rets = pts.map((p) => p.nextRet).filter((v): v is number => v != null && isFinite(v)).map((v) => Math.abs(v)).sort((a, b) => a - b);
  const scale = rets.length ? (rets[Math.floor(rets.length * 0.9)] || rets[rets.length - 1] || 0.02) : 0.02;

  // 0軸
  ctx.strokeStyle = "#eceff3"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(xOf(0), mt); ctx.lineTo(xOf(0), mt + plotH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ml, yOf(0)); ctx.lineTo(ml + plotW, yOf(0)); ctx.stroke();
  ctx.setLineDash([]);

  // 点
  for (const p of pts) {
    let color: string;
    if (colorMode === "era") color = eraColor(p.eraFrac, 0.8);
    else if (p.nextRet == null) color = "rgba(200,200,200,0.35)";
    else color = divergeColor((p.nextRet as number) / scale, 0.82);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(xOf(p.score[0] ?? 0), yOf(p.score[1] ?? 0), 3, 0, Math.PI * 2); ctx.fill();
  }

  // 直近週の時系列軌跡(古→新, フェード)
  if (showTraj && result.recentIdx.length >= 2) {
    const ri = result.recentIdx;
    for (let k = 1; k < ri.length; k++) {
      const a = pts[ri[k - 1]], b = pts[ri[k]];
      const alpha = 0.2 + 0.6 * (k / (ri.length - 1));
      ctx.strokeStyle = `rgba(37,99,235,${alpha})`; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(xOf(a.score[0] ?? 0), yOf(a.score[1] ?? 0)); ctx.lineTo(xOf(b.score[0] ?? 0), yOf(b.score[1] ?? 0)); ctx.stroke();
    }
    // 最新完了週マーカー
    const last = pts[ri[ri.length - 1]];
    ctx.fillStyle = "#1d4ed8"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(xOf(last.score[0] ?? 0), yOf(last.score[1] ?? 0), 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#1d4ed8"; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("最新週", xOf(last.score[0] ?? 0) + 7, yOf(last.score[1] ?? 0) + 3);
  }

  // タイトル + 軸ラベル
  const e0 = view.eigen[0], e1 = view.eigen[1];
  ctx.fillStyle = "#374151"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(view.variant === "level" ? "アトラス(水準あり)" : "アトラス(形状のみ)", ml, 12);
  ctx.fillStyle = CHART_COLORS.ink; ctx.font = "8px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(`PC1→ ${(e0.explained * 100).toFixed(0)}% / PC2↑ ${(e1 ? e1.explained * 100 : 0).toFixed(0)}%`, ml + plotW, 12);
}

function pctP(p: number): string { return p < 0.001 ? "<.001" : p.toFixed(3); }

// 信頼度バッジ: OOSでヌルを超え、符号がin-sampleと一致し、in-sampleも有意 → 緑。
// in-sampleは有意だがOOS未確認 → 黄。in-sampleがヌルを超えない → 赤(=形空間に翌週予測力なし)。
function verdict(v: EmbeddingView): { level: "green" | "amber" | "red"; label: string } {
  const inSig = v.icP < 0.05;
  const oosSig = v.oosP < 0.05 && Math.sign(v.oosIc) === Math.sign(v.ic) && Math.abs(v.oosIc) > 0.02;
  if (inSig && oosSig) return { level: "green", label: "予測力あり(OOS確認)" };
  if (inSig) return { level: "amber", label: "in-sampleのみ有意(OOS未確認)" };
  return { level: "red", label: "翌週予測力なし(ヌル内)" };
}

const BADGE: Record<string, string> = {
  green: "bg-emerald-100 text-emerald-800 border-emerald-300",
  amber: "bg-amber-100 text-amber-800 border-amber-300",
  red: "bg-rose-100 text-rose-800 border-rose-300",
};

function ViewPanel({ view, result, colorMode, showTraj }: { view: EmbeddingView; result: WeekEmbeddingResult; colorMode: ColorMode; showTraj: boolean }) {
  const atlasRef = useRef<HTMLCanvasElement>(null);
  const eigenRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (atlasRef.current) drawAtlas(atlasRef.current, view, result, colorMode, showTraj);
    if (eigenRef.current) {
      const init = initCanvas(eigenRef.current, 90);
      if (init) {
        const { ctx, width } = init;
        const labels = ["PC1", "PC2", "PC3"];
        const subs = view.variant === "level"
          ? ["週ドリフト", "月↔金 重心", "週中の曲率"]
          : ["形の傾き", "V字↔Λ字", "うねり"];
        const cols = ["#1d4ed8", "#059669", "#d97706"];
        const cw = width / 3;
        for (let i = 0; i < 3 && i < view.eigen.length; i++) {
          drawEigen(ctx, i * cw + 8, 18, cw - 20, 60, view.eigen[i].loading, cols[i], labels[i] + " " + subs[i], `${(view.eigen[i].explained * 100).toFixed(0)}%`);
        }
      }
    }
    const onResize = () => {
      if (atlasRef.current) drawAtlas(atlasRef.current, view, result, colorMode, showTraj);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [view, result, colorMode, showTraj]);

  const vd = verdict(view);
  return (
    <div className="border border-gray-200 rounded-lg p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold text-gray-700">{view.variant === "level" ? "水準あり(週の方向を含む)" : "形状のみ(方向を除去)"}</span>
        <span className={`text-[11px] px-2 py-0.5 rounded border ${BADGE[vd.level]}`}>{vd.label}</span>
      </div>
      <div className="w-full"><canvas ref={atlasRef} /></div>
      <div className="w-full mt-1"><canvas ref={eigenRef} /></div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-gray-600">
        <div>In-sample IC: <b className="text-gray-800">{view.ic.toFixed(3)}</b></div>
        <div>ヌル平均: {view.icNullMean.toFixed(3)} ± {view.icNullSd.toFixed(3)}</div>
        <div>順列 p: <b className={view.icP < 0.05 ? "text-emerald-700" : "text-rose-700"}>{pctP(view.icP)}</b></div>
        <div>近傍数 k: {view.kNN}</div>
        <div className="col-span-2 border-t border-gray-100 mt-1 pt-1">OOS(学習{view.nTrain}週→検証{view.nTest}週)</div>
        <div>OOS IC: <b className="text-gray-800">{view.oosIc.toFixed(3)}</b></div>
        <div>方向的中: {(view.oosHit * 100).toFixed(0)}%</div>
        <div>OOS p: <b className={view.oosP < 0.05 ? "text-emerald-700" : "text-rose-700"}>{pctP(view.oosP)}</b></div>
      </div>
    </div>
  );
}

export default function WeekEmbeddingChart({ prices }: Props) {
  const [colorMode, setColorMode] = useState<ColorMode>("outcome");
  const [showTraj, setShowTraj] = useState(true);

  const result = useMemo(() => {
    try { return computeWeekEmbedding({ prices }); } catch { return null; }
  }, [prices]);

  if (!result) {
    return <div className="text-sm text-gray-500 p-4">週数が不足しています（完全週40週以上が必要）。より長い期間で表示してください。</div>;
  }

  const cur = result.currentPartial;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-500">{result.nWeeks}週を埋め込み</span>
        <div className="flex rounded overflow-hidden border border-gray-300">
          <button onClick={() => setColorMode("outcome")} className={`px-2 py-1 ${colorMode === "outcome" ? "bg-gray-800 text-white" : "bg-white text-gray-600"}`}>翌週リターンで着色</button>
          <button onClick={() => setColorMode("era")} className={`px-2 py-1 ${colorMode === "era" ? "bg-gray-800 text-white" : "bg-white text-gray-600"}`}>年代で着色</button>
        </div>
        <label className="flex items-center gap-1 text-gray-600">
          <input type="checkbox" checked={showTraj} onChange={(e) => setShowTraj(e.target.checked)} /> 直近軌跡
        </label>
        {colorMode === "outcome" && (
          <span className="flex items-center gap-1 text-gray-500">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: divergeColor(-1) }} />翌週安
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: divergeColor(1) }} />翌週高
          </span>
        )}
      </div>

      {cur && (
        <div className="text-[11px] text-gray-600 bg-blue-50 border border-blue-100 rounded px-2 py-1">
          今週（進行中・{cur.elapsed}日経過）: {cur.path.map((v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`).join(" → ")}
          <span className="text-fg-muted">（完了後にアトラスへ点として着地します）</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <ViewPanel view={result.level} result={result} colorMode={colorMode} showTraj={showTraj} />
        <ViewPanel view={result.shape} result={result} colorMode={colorMode} showTraj={showTraj} />
      </div>

      <AnalysisGuide title="週内Embedding（週の関数PCA・固有週アトラス）の詳細理論">
        <p className="font-medium text-gray-700">1. 何をしているか</p>
        <p>
          1週間の値動きを1本のベクトルにして、低次元の平面へ写し、過去の全週を1枚の「地図」（点群）にする手法です。
          各週を <b>前週末終値を0%とした週内累積対数リターンの経路</b> として捉え、休場で日数が違っても5点に再標本化して長さを揃えます。
          似た形の週は地図上で近くに、違う形の週は遠くに配置されます。
        </p>
        <p className="mt-1">
          既存の「今週の軌跡アナログ」が<b>今週に似た過去週を局所的に引く（最近傍法）</b>のに対し、本手法は<b>週という対象の全体地形</b>を見せます。
          最近傍法が原理的に出せない3つ ― ①どんな週の型が存在するか ②週の形の直交した軸は何か ③形空間の全域で結果に系統性があるか ― を可視化します。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>{"週 w の特徴ベクトル（水準あり）: g_w = [ log(c_1/c_0), …, log(c_5/c_0) ]（c_0 = 前週末終値, c_j = 週内 j 番目の終値を5点へ内挿）"}</p>
        <p>{"形状のみ: s_w = (g_w − mean(g_w)) / std(g_w)  … 週全体のドリフトとスケールを除去し、V字/Λ字/重心などの「純粋な形」だけを残す"}</p>
        <p>{"関数PCA: 列中心化した特徴行列 X（n週×5）の共分散 C = XᵀX/(n−1) を固有分解。"}</p>
        <p>{"  固有ベクトル v_k（=固有週, 5次元の基本形）と固有値 λ_k。各週のスコア（座標）: z_{w,k} = (g_w − μ)·v_k。"}</p>
        <p>{"  説明分散比 = λ_k / Σλ。地図は (z_{w,1}, z_{w,2})（PC1×PC2 平面）。"}</p>
        <p>{"翌週リターン（前向き結果）: y_w = log(c_last^{w+1} / c_last^{w})。"}</p>
        <p>{"予測力 IC: 各週の y を地図上の k 近傍の平均 ŷ_w = mean_{j∈NN_k(w)} y_j で予測し、corr(ŷ, y)。"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>Embedding（埋め込み）</b>: 高次元の対象を、近さ＝類似度になるように低次元座標へ写すこと。</li>
          <li><b>関数PCA（固有週）</b>: 経路そのものを主成分分析すること。得られる主成分は「基本となる週の形」で、任意の週はその重ね合わせで表せる。</li>
          <li><b>PC1/PC2/PC3</b>: 経験上それぞれ「週全体のドリフト（上げ週／下げ週）」「月曜重心↔金曜重心の傾き」「週中の曲率（V字↔逆V字）」に対応。</li>
          <li><b>IC（情報係数）</b>: 予測と実測の相関。0.05超で実務的に意味あり、と言われる控えめな指標。</li>
          <li><b>OOS（アウト・オブ・サンプル）</b>: 学習に使っていない期間での検証。過学習を暴く。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          週の形を「星座」に例えると、この地図は夜空全体を1枚に描いた星図です。似た星座は近くに集まります。
          <b>固有週</b>は「どんな星座もこの数個の基本形の合成で描ける」という基本パーツ。
          そして<b>翌週リターンで着色</b>するのは、星図の上に「この辺りの星座の翌晩は晴れ、この辺りは雨」と天気を塗る作業です。
          もし色が滑らかな地形（青い谷と赤い丘）になっていれば予測に使えますが、<b>塩胡椒のランダムな散らばり</b>なら、それは幻の模様です。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>点群の形</b>: いくつかの塊に割れていれば週の型が離散的、雲状に連続なら型は連続体。</li>
          <li><b>固有週の折れ線</b>: PC1が右上がりなら「上げ週」方向。各週はこれらの重ね合わせ。説明分散比が大きい軸ほど週の違いを支配する。</li>
          <li><b>着色（翌週リターン）</b>: 青＝翌週安、赤＝翌週高。滑らかな勾配＝予測可能。バラバラ＝予測不能。</li>
          <li><b>直近軌跡</b>: 直近12週を時系列に結んだ線。地図上を移動していれば地合いのレジームが動いている証拠。</li>
          <li><b>信頼度バッジ</b>: <span className="text-emerald-700">緑=予測力あり(OOS確認)</span> / <span className="text-amber-700">黄=in-sampleのみ有意</span> / <span className="text-rose-700">赤=翌週予測力なし（ヌル内）</span>。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>バッジが<b>緑</b>のとき、今週が完了して地図の「赤い領域」に着地したなら、翌週ロングの期待値が母集団平均より高いと読める（建玉判断に接続）。</li>
          <li><b>固有週の分解</b>で、自分の相場観（例「月重心の週は続かない」）が実データの直交軸として存在するかを検証できる。</li>
          <li><b>年代着色</b>で点群が動いていれば、古いパターン統計をそのまま使うのは危険というレジーム警告になる。</li>
          <li>「水準あり」と「形状のみ」で結論が変わるかを見る。方向を除いても予測力が残るなら、それは<b>形そのもの</b>の情報。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>地図は必ずクラスタに見える</b>: これが最大の罠。ノイズからでも模様は生まれる。だから<b>色（翌週リターン）の構造だけ</b>を、ブロック順列ヌルと分けて検定している。</li>
          <li><b>2つの主張を混同しない</b>: 「形空間に構造がある」は自明（形は自己相関する）。トレード可能なのは「翌週リターンが形空間上に構造を持つ」方だけ。</li>
          <li><b>順列 p が0.05超（赤）</b>なら、どんなに綺麗な地図でも翌週予測には使えない。これは正直な負けの結論で、それ自体が有用な情報。</li>
          <li><b>ブロック順列</b>（4週塊）で翌週リターンの系列相関を保存し、偽の有意を防いでいる。</li>
          <li>PCAは線形。非線形な多様体構造（UMAP等）は距離を歪めるため本手法では採用していない（解釈可能性と正直さを優先）。</li>
          <li>休場週は5点へ再標本化しているため、日数の違う週の形は近似。極端に短い週（3日以下）は除外。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
