"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useIntraday } from "../../hooks/useIntraday";
import {
  computeRealizedVol, computeOvernightIntraday, computeSignature, computeVolumeClock,
  RvResult, OvernightResult, SignatureResult, VolumeClockResult,
} from "../../lib/realized-vol";
import {
  initCanvas, fmtSignedPct, IntervalButtons, ViewTabs, LoadingError,
  StatCell, IntradayCaveat,
} from "./intradayShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

type View = "rv" | "overnight" | "signature" | "volclock";
const VIEWS: { value: View; label: string }[] = [
  { value: "rv", label: "実現ボラ/HAR" },
  { value: "overnight", label: "夜間/日中分解" },
  { value: "signature", label: "自己相関/間隔" },
  { value: "volclock", label: "出来高クロック" },
];

const intervalToMin = (iv: string) => (iv === "60m" ? 60 : iv === "30m" ? 30 : iv === "15m" ? 15 : 5);

function drawRv(ctx: CanvasRenderingContext2D, W: number, H: number, r: RvResult) {
  const ml = 44, mr = 16, mt = 28, mb = 24;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const n = r.days.length;
  const xs = (i: number) => ml + (i / Math.max(1, n - 1)) * plotW;
  const vals = r.days.map((d) => d.annVolPct);
  const rrVals = r.days.map((d) => d.rrVolPct);
  const vmax = Math.max(1, ...vals, ...rrVals);
  const ys = (v: number) => mt + plotH - (v / vmax) * plotH;

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("年率実現ボラ（黒=RV, 青=実現レンジ, ◆=ジャンプ日, 紫=HAR予測）", ml, mt - 12);
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(`${vmax.toFixed(0)}%`, ml - 4, mt + 9); ctx.fillText("0", ml - 4, mt + plotH);

  const line = (a: number[], color: string, w: number) => {
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = xs(i), y = ys(a[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  };
  line(rrVals, "#3b82f6aa", 1);
  line(vals, "#111827", 1.5);

  // ジャンプ日マーカー
  for (let i = 0; i < n; i++) {
    if (r.days[i].isJump) {
      ctx.fillStyle = "#f59e0b";
      const x = xs(i), y = ys(vals[i]);
      ctx.beginPath(); ctx.moveTo(x, y - 3); ctx.lineTo(x + 3, y); ctx.lineTo(x, y + 3); ctx.lineTo(x - 3, y); ctx.closePath(); ctx.fill();
    }
  }
  // HAR予測（日付整合は末尾寄せ近似: predicted配列の各dateをdays indexに対応）
  if (r.har) {
    const dateToIdx = new Map(r.days.map((d, i) => [d.date, i]));
    ctx.strokeStyle = "#7c3aed"; ctx.lineWidth = 1.5; ctx.setLineDash([3, 2]); ctx.beginPath();
    let started = false;
    for (const p of r.har.predicted) {
      const i = dateToIdx.get(p.date);
      if (i == null) continue;
      const x = xs(i), y = ys(p.predAnnPct);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.setLineDash([]);
  }
}

function drawOvernight(ctx: CanvasRenderingContext2D, W: number, H: number, r: OvernightResult) {
  const ml = 48, mr = 16, mt = 28, mb = 24;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const n = r.cumOvernight.length;
  const xs = (i: number) => ml + (i / Math.max(1, n - 1)) * plotW;
  const all = [...r.cumOvernight.map((p) => p.value), ...r.cumIntraday.map((p) => p.value), 1];
  const vmax = Math.max(...all), vmin = Math.min(...all);
  const pad = (vmax - vmin) * 0.05 || 0.05;
  const ys = (v: number) => mt + plotH - ((v - vmin + pad) / (vmax - vmin + 2 * pad)) * plotH;

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("累積エクイティ（青=夜間取り / 緑=日中取り, 始点=1）", ml, mt - 12);
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(vmax.toFixed(2), ml - 4, mt + 9); ctx.fillText(vmin.toFixed(2), ml - 4, mt + plotH);

  // 1.0 ライン
  const y1 = ys(1);
  ctx.strokeStyle = "#e5e7eb"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(ml, y1); ctx.lineTo(ml + plotW, y1); ctx.stroke(); ctx.setLineDash([]);

  const line = (arr: { value: number }[], color: string) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < arr.length; i++) { const x = xs(i), y = ys(arr[i].value); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  };
  line(r.cumOvernight, "#3b82f6");
  line(r.cumIntraday, "#16a34a");
}

function drawSignature(ctx: CanvasRenderingContext2D, W: number, H: number, r: SignatureResult) {
  const ml = 44, mr = 16, mt = 24, gap = 36;
  const plotW = W - ml - mr;
  const paneH = (H - mt - gap - 24) / 2;

  // 上: ACF
  {
    const n = r.acf.length, slot = plotW / n, barW = Math.max(3, slot * 0.6);
    const amax = Math.max(0.05, ...r.acf.map((a) => Math.abs(a.value)));
    const y0 = mt + paneH / 2;
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, paneH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("日中リターンの自己相関 ρ(k)", ml, mt - 7);
    ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(ml, y0); ctx.lineTo(ml + plotW, y0); ctx.stroke(); ctx.setLineDash([]);
    for (let i = 0; i < n; i++) {
      const v = r.acf[i].value;
      const x = ml + i * slot + (slot - barW) / 2;
      const h = (v / amax) * (paneH / 2 - 4);
      ctx.fillStyle = v >= 0 ? "#0ea5e9" : "#ef4444";
      ctx.fillRect(x, h >= 0 ? y0 - h : y0, barW, Math.abs(h));
      ctx.fillStyle = "#6b7280"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(`${r.acf[i].lag}`, ml + i * slot + slot / 2, mt + paneH + 10);
    }
  }
  // 下: シグネチャープロット
  {
    const top = mt + paneH + gap;
    const n = r.signature.length, slot = plotW / Math.max(1, n - 1);
    const vmax = Math.max(1, ...r.signature.map((s) => s.annVolPct));
    const vmin = Math.min(...r.signature.map((s) => s.annVolPct));
    const pad = (vmax - vmin) * 0.1 || 1;
    const ys = (v: number) => top + paneH - ((v - vmin + pad) / (vmax - vmin + 2 * pad)) * paneH;
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, top, plotW, paneH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("シグネチャープロット（サンプリング間隔→年率ボラ）", ml, top - 7);
    ctx.strokeStyle = "#7c3aed"; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = ml + i * slot, y = ys(r.signature[i].annVolPct); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
    ctx.fillStyle = "#7c3aed";
    for (let i = 0; i < n; i++) { const x = ml + i * slot, y = ys(r.signature[i].annVolPct); ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = "#6b7280"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    for (let i = 0; i < n; i++) ctx.fillText(`${r.signature[i].stepMin}分`, ml + i * slot, top + paneH + 11);
  }
}

function drawVolClock(ctx: CanvasRenderingContext2D, W: number, H: number, r: VolumeClockResult) {
  const ml = 44, mr = 16, mt = 28, mb = 28;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const n = r.timeHist.length;
  const slot = plotW / n;
  const maxC = Math.max(1, ...r.timeHist.map((b) => b.count), ...r.volHist.map((b) => b.count));
  const scaleT = (c: number) => (c / maxC);
  const norm = (hist: { count: number }[]) => {
    const tot = hist.reduce((s, b) => s + b.count, 0) || 1;
    return hist.map((b) => b.count / tot);
  };
  const tN = norm(r.timeHist), vN = norm(r.volHist);
  const mx = Math.max(...tN, ...vN) || 1;

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("標準化リターン分布（灰=時間バー, 紫=出来高バー）", ml, mt - 12);

  const drawHist = (vals: number[], color: string, offset: number) => {
    const bw = Math.max(1.5, slot * 0.4);
    for (let i = 0; i < n; i++) {
      const h = (vals[i] / mx) * plotH;
      ctx.fillStyle = color;
      ctx.fillRect(ml + i * slot + offset, mt + plotH - h, bw, h);
    }
  };
  drawHist(tN, "#9ca3afcc", slot * 0.1);
  drawHist(vN, "#7c3aedcc", slot * 0.5);
  // x軸 (z)
  ctx.fillStyle = "#6b7280"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
  for (let i = 0; i < n; i += Math.ceil(n / 8)) ctx.fillText(r.timeHist[i].center.toFixed(0) + "σ", ml + i * slot + slot / 2, mt + plotH + 14);
  void scaleT;
}

export default function RealizedVolChart({ ticker }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [intervalKey, setIntervalKey] = useState("5m");
  const [view, setView] = useState<View>("rv");
  const { resp, loading, error } = useIntraday(ticker, intervalKey);

  const baseMin = intervalToMin(intervalKey);
  const rv = useMemo<RvResult | null>(() => (resp ? computeRealizedVol(resp.bars, resp.gmtoffset) : null), [resp]);
  const ov = useMemo<OvernightResult | null>(() => (resp ? computeOvernightIntraday(resp.bars, resp.gmtoffset) : null), [resp]);
  const sig = useMemo<SignatureResult | null>(() => (resp ? computeSignature(resp.bars, resp.gmtoffset, baseMin) : null), [resp, baseMin]);
  const vc = useMemo<VolumeClockResult | null>(() => (resp ? computeVolumeClock(resp.bars, resp.gmtoffset) : null), [resp]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const H = view === "signature" ? 360 : 320;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width } = init;
    if (view === "rv" && rv) drawRv(ctx, width, H, rv);
    else if (view === "overnight" && ov) drawOvernight(ctx, width, H, ov);
    else if (view === "signature" && sig) drawSignature(ctx, width, H, sig);
    else if (view === "volclock" && vc) drawVolClock(ctx, width, H, vc);
  }, [view, rv, ov, sig, vc]);

  const ready = (view === "rv" && rv) || (view === "overnight" && ov) || (view === "signature" && sig) || (view === "volclock" && vc);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">マイクロ構造の代理（実現ボラ・夜間/日中・出来高クロック）</h3>
        <IntervalButtons value={intervalKey} onChange={setIntervalKey} />
      </div>
      <ViewTabs value={view} onChange={setView} views={VIEWS} />
      <LoadingError loading={loading} error={error} />

      {!loading && !error && !ready && (
        <div className="text-sm text-gray-400 py-6 text-center">この足ではサンプルが不足しています（HARは25営業日以上必要）。</div>
      )}

      {!loading && !error && ready && (
        <>
          <div className="relative"><canvas ref={canvasRef} /></div>

          {view === "rv" && rv && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <StatCell label="平均 年率ボラ" value={`${rv.meanAnnVolPct.toFixed(1)}%`} />
                <StatCell label="ジャンプ日" value={`${rv.jumpDays}日`} />
                <StatCell label="HAR R²" value={rv.har ? rv.har.r2.toFixed(3) : "—"} />
                <StatCell label="HAR係数(日/週/月)" value={rv.har ? `${rv.har.bd.toFixed(2)}/${rv.har.bw.toFixed(2)}/${rv.har.bm.toFixed(2)}` : "—"} />
              </div>
              <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
                {"分足から測った実現ボラ（黒）は終値間より精度が高い。橙◆=ジャンプ日（バイパワー変動でジャンプ成分が大）、紫破線=HARモデル（日/週/月の実現ボラから翌日を予測）。ボラの割高/割安判定とポジションサイズ調整に使う。"}
              </p>
            </>
          )}

          {view === "overnight" && ov && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <StatCell label="夜間 平均R" value={fmtSignedPct(ov.onMeanPct / 100)} tone={ov.onMeanPct >= 0 ? "up" : "down"} />
                <StatCell label="日中 平均R" value={fmtSignedPct(ov.idMeanPct / 100)} tone={ov.idMeanPct >= 0 ? "up" : "down"} />
                <StatCell label="夜間 Sharpe" value={ov.onSharpe.toFixed(2)} />
                <StatCell label="夜間の分散寄与" value={`${(ov.onVarShare * 100).toFixed(0)}%`} />
              </div>
              <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
                {"「引け買い→翌寄り売り（夜間取り, 青）」と「寄り買い→引け売り（日中取り, 緑）」の累積比較。どちらの時間帯にリターンが集中しているか（オーバーナイト・ドリフト）と、夜間ギャップが全体リスクのどれだけを占めるか（持ち越しリスク）を分離できる。"}
              </p>
            </>
          )}

          {view === "signature" && sig && (
            <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
              {"上=日中リターンの自己相関。ラグ1が負ならビッドアスク・バウンス（売買の往復）由来のノイズの兆候。下=サンプリング間隔ごとの年率ボラ（シグネチャープロット）。間隔を細かくするほどボラが膨らむなら、マイクロ構造ノイズが効いている＝実現ボラ推定は5分など適度な間隔が無難。"}
            </p>
          )}

          {view === "volclock" && vc && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <StatCell label="時間バー 超過尖度" value={vc.timeKurt.toFixed(2)} />
                <StatCell label="出来高バー 超過尖度" value={vc.volKurt.toFixed(2)} />
                <StatCell label="時間バー σ" value={`${vc.timeStd.toFixed(3)}%`} />
                <StatCell label="出来高バー σ" value={`${vc.volStd.toFixed(3)}%`} />
              </div>
              <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
                {"等時間バーを等出来高バー（情報時間）に置き換えると、リターン分布の裾（超過尖度）が小さくなり正規分布に近づくのが一般的。出来高バーの尖度が時間バーより小さければ、出来高ベースで見た方が分散が安定し、イベント時間での分析に向く。"}
              </p>
            </>
          )}

          <IntradayCaveat />
        </>
      )}

      <AnalysisGuide title="マイクロ構造代理分析の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"板・ティックが無くても、分足から『真のボラ（実現ボラ）』『夜間と日中のリスク分解』『売買ノイズの度合い』『情報時間での分布』を近似する。ボラ予測・持ち越し判断・サンプリング設計に役立つ。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>実現分散</strong> RV_d=Σ_i r_{`{d,i}`}²（r=分足対数リターン）、年率ボラ=√(252·RV)。</li>
          <li><strong>バイパワー変動</strong> BV=(π/2)Σ|r_i||r_{`{i-1}`}|。ジャンプ成分=max(0, RV−BV)。BVは連続変動のみを拾うのでRVとの差がジャンプ。</li>
          <li><strong>HAR-RV</strong>: RV_{`{d+1}`}=β0+βd·RV_d+βw·RV_週+βm·RV_月。日/週/月の記憶でボラを予測。</li>
          <li><strong>夜間/日中</strong>: r_ON=ln(O/C_prev)、r_ID=ln(C/O)。分散寄与=Var(ON)/Var(ON+ID)。</li>
          <li><strong>シグネチャー</strong>: サンプリング間隔Δを変えてRV(Δ)を描く。Δ→0でRVが発散すればマイクロ構造ノイズの存在。</li>
          <li><strong>出来高クロック</strong>: 累積出来高が閾値を超えるごとにバーを区切る（情報時間）。リターン分布の正規性が改善する。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方・活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>実現ボラが過去比で割高/割安→ポジションサイズやオプション戦略の判断。</li>
          <li>ジャンプ日が多い銘柄はギャップリスクが高い。</li>
          <li>夜間に分散・ドリフトが集中→持ち越しの是非を判断。</li>
          <li>ラグ1自己相関が負→ノイズ大。実現ボラ推定は間隔を粗めに。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"HARは25営業日以上が必要。5分足60日でぎりぎり。係数は不安定になり得る。"}</li>
          <li>{"マイクロ構造ノイズのため、1分足など細かすぎる足はRVを過大評価する。"}</li>
          <li>{"出来高ゼロのバーがあると出来高クロックが不安定。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
