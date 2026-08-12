"use client";

// as-of スコアカード: 過去の多数の時点で判断を再現し、型ごとに正しい採点則で採点する。
//
// 単発の as-of 再現は「仕組みの確認」にしかならない。判定はここで行う。
// 方向は的中率だけ見ても意味がなく（上げ相場なら常に「上」で6割当たる）、
// 確率はブライアスコアを気候値と比べ、区間は名目被覆率と比べ、ボラ予測は
// Mincer–Zarnowitz 回帰で (a,b)=(0,1) を検定する——型ごとに採点則が違う。

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import AnalysisGuide from "./AnalysisGuide";
import { Horizon, HORIZONS, HORIZON_CONFIG } from "../../lib/signal-digest";
import {
  AsOfReplayResult, AsOfReplayParams, FWD_HORIZONS,
} from "../../lib/asof-replay";
import type { AsOfWorkerRequest, AsOfWorkerResponse } from "../../lib/asof-replay.worker";

interface Props {
  prices: PricePoint[];
  ticker: string;
}

const SPACINGS = [1, 5, 10, 21];
const LOOKBACKS = [3, 5, 10];

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

function fmt(v: number, d = 3): string {
  return isFinite(v) ? v.toFixed(d) : "—";
}
function fmtP(p: number): string {
  if (!isFinite(p)) return "—";
  return p < 0.001 ? "<.001" : p.toFixed(3);
}
function pctS(v: number, d = 1): string {
  return isFinite(v) ? `${(v * 100).toFixed(d)}%` : "—";
}

/** 較正図（信頼度ダイアグラム）: 予測確率 vs 実際に起きた割合。対角線に乗れば較正済み。 */
function drawReliability(canvas: HTMLCanvasElement, res: AsOfReplayResult) {
  const init = initCanvas(canvas, 200);
  if (!init) return;
  const { ctx, width, height } = init;
  const pad = { l: 38, r: 10, t: 12, b: 26 };
  const W = width - pad.l - pad.r, H = height - pad.t - pad.b;
  const X = (p: number) => pad.l + p * W;
  const Y = (p: number) => pad.t + (1 - p) * H;

  ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
  ctx.strokeRect(pad.l, pad.t, W, H);
  // 対角線（完全較正）
  ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(1), Y(1)); ctx.stroke();
  ctx.setLineDash([]);

  const colors = ["#2563eb", "#16a34a", "#d97706"];
  res.probability.forEach((ps, i) => {
    if (ps.n < 8) return;
    ctx.strokeStyle = colors[i % colors.length];
    ctx.fillStyle = colors[i % colors.length];
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let started = false;
    for (const b of ps.bins) {
      if (!b.n || !isFinite(b.obs) || !isFinite(b.pMean)) continue;
      const x = X(b.pMean), y = Y(b.obs);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    for (const b of ps.bins) {
      if (!b.n || !isFinite(b.obs) || !isFinite(b.pMean)) continue;
      const r = Math.max(1.5, Math.min(5, Math.sqrt(b.n) * 0.6));
      ctx.beginPath(); ctx.arc(X(b.pMean), Y(b.obs), r, 0, Math.PI * 2); ctx.fill();
    }
  });

  ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  for (const t of [0, 0.25, 0.5, 0.75, 1]) ctx.fillText(`${(t * 100).toFixed(0)}%`, X(t), height - 10);
  ctx.textAlign = "right";
  for (const t of [0, 0.5, 1]) ctx.fillText(`${(t * 100).toFixed(0)}%`, pad.l - 4, Y(t) + 3);
  ctx.textAlign = "left";
  ctx.fillText("予測確率 →", pad.l + 2, pad.t + 10);
  ctx.save(); ctx.translate(10, pad.t + H / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center"; ctx.fillText("実際に上げた割合", 0, 0); ctx.restore();
}

/** 区間の被覆率 vs 名目。棒が破線（名目）に届かなければ、その帯は狭すぎる。 */
function drawCoverage(canvas: HTMLCanvasElement, res: AsOfReplayResult) {
  const init = initCanvas(canvas, 200);
  if (!init) return;
  const { ctx, width, height } = init;
  const rows = res.intervals.filter((iv) => iv.n >= 8);
  const pad = { l: 60, r: 12, t: 12, b: 24 };
  const W = width - pad.l - pad.r, H = height - pad.t - pad.b;
  if (rows.length === 0) {
    ctx.fillStyle = "#9ca3af"; ctx.font = "11px sans-serif";
    ctx.fillText("区間を採点できる標本がありません", pad.l, pad.t + 20);
    return;
  }
  const bh = H / rows.length;
  const X = (v: number) => pad.l + v * W;
  rows.forEach((iv, i) => {
    const y = pad.t + i * bh;
    const ok = iv.coverage >= iv.covLo && iv.nominal >= iv.covLo && iv.nominal <= iv.covHi;
    ctx.fillStyle = ok ? "#86efac" : "#fca5a5";
    ctx.fillRect(pad.l, y + bh * 0.2, X(iv.coverage) - pad.l, bh * 0.6);
    // CI
    ctx.strokeStyle = "#374151"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X(iv.covLo), y + bh * 0.5); ctx.lineTo(X(iv.covHi), y + bh * 0.5);
    ctx.stroke();
    // 名目
    ctx.strokeStyle = "#111827"; ctx.setLineDash([3, 2]);
    ctx.beginPath(); ctx.moveTo(X(iv.nominal), y + bh * 0.12); ctx.lineTo(X(iv.nominal), y + bh * 0.88); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#374151"; ctx.font = "10px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(`${iv.h}日 ${(iv.level * 100).toFixed(0)}%`, pad.l - 4, y + bh * 0.62);
    ctx.textAlign = "left";
    ctx.fillText(pctS(iv.coverage, 0), Math.min(X(iv.coverage) + 3, width - 34), y + bh * 0.62);
  });
  ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
  for (const t of [0, 0.5, 1]) ctx.fillText(`${(t * 100).toFixed(0)}%`, X(t), height - 8);
}

/** ボラ予測 vs 実現ボラの散布＋MZ回帰線。45度線から離れるほど水準がずれている。 */
function drawMz(canvas: HTMLCanvasElement, res: AsOfReplayResult, hIdx: number) {
  const init = initCanvas(canvas, 200);
  if (!init) return;
  const { ctx, width, height } = init;
  const pad = { l: 42, r: 10, t: 12, b: 26 };
  const W = width - pad.l - pad.r, H = height - pad.t - pad.b;
  const h = FWD_HORIZONS[hIdx];
  const pts: { x: number; y: number }[] = [];
  for (const p of res.points) {
    const f = p.fwd[hIdx];
    if (!f || !p.fc.ok || !(p.fc.dailyVolGarch > 0) || !(f.realizedVolDaily > 0)) continue;
    pts.push({ x: p.fc.dailyVolGarch * 100, y: f.realizedVolDaily * 100 });
  }
  if (pts.length < 5) {
    ctx.fillStyle = "#9ca3af"; ctx.font = "11px sans-serif";
    ctx.fillText("標本不足", pad.l, pad.t + 20);
    return;
  }
  const mx = Math.max(...pts.map((p) => Math.max(p.x, p.y))) * 1.05;
  const X = (v: number) => pad.l + (v / mx) * W;
  const Y = (v: number) => pad.t + (1 - v / mx) * H;
  ctx.strokeStyle = "#e5e7eb"; ctx.strokeRect(pad.l, pad.t, W, H);
  ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(mx), Y(mx)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(37,99,235,0.45)";
  for (const p of pts) { ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 2.2, 0, Math.PI * 2); ctx.fill(); }
  const vs = res.vol[hIdx];
  if (vs && isFinite(vs.a) && isFinite(vs.b)) {
    ctx.strokeStyle = "#dc2626"; ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(vs.a + vs.b * 0)); ctx.lineTo(X(mx), Y(vs.a + vs.b * mx));
    ctx.stroke();
  }
  ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`${h}日先  灰破線=45度(完全予測) / 赤=MZ回帰`, pad.l + 2, pad.t + 10);
  ctx.textAlign = "center"; ctx.fillText("予測σ(日次%)", pad.l + W / 2, height - 8);
  ctx.save(); ctx.translate(11, pad.t + H / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText("実現σ(日次%)", 0, 0); ctx.restore();
}

export default function AsOfScorecardChart({ prices, ticker }: Props) {
  const [horizon, setHorizon] = useState<Horizon>("swing");
  const [spacing, setSpacing] = useState(5);
  const [lookbackYears, setLookbackYears] = useState(5);
  const [res, setRes] = useState<AsOfReplayResult | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [mzH, setMzH] = useState(1); // MZ 散布に出すホライズン(既定 5日)

  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const relRef = useRef<HTMLCanvasElement>(null);
  const covRef = useRef<HTMLCanvasElement>(null);
  const mzRef = useRef<HTMLCanvasElement>(null);

  const params: AsOfReplayParams = useMemo(
    () => ({ horizon, spacing, lookbackYears }), [horizon, spacing, lookbackYears]
  );

  // Worker の生成/破棄と、リクエスト送信を分ける（生成は1回きり）。
  useEffect(() => {
    const worker = new Worker(new URL("../../lib/asof-replay.worker.ts", import.meta.url));
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<AsOfWorkerResponse>) => {
      if (ev.data.reqId !== reqIdRef.current) return;
      if (ev.data.progress) setProgress(ev.data.progress);
      if (ev.data.result) { setRes(ev.data.result); setRunning(false); setProgress(null); }
    };
    return () => { worker.terminate(); workerRef.current = null; };
  }, []);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || prices.length < 200) return;
    reqIdRef.current += 1;
    setRunning(true);
    setProgress(null);
    const req: AsOfWorkerRequest = { reqId: reqIdRef.current, prices, ticker, params };
    worker.postMessage(req);
  }, [prices, ticker, params]);

  const redraw = useCallback(() => {
    if (!res || !res.ok) return;
    if (relRef.current) drawReliability(relRef.current, res);
    if (covRef.current) drawCoverage(covRef.current, res);
    if (mzRef.current) drawMz(mzRef.current, res, mzH);
  }, [res, mzH]);

  useEffect(() => { redraw(); }, [redraw]);
  useEffect(() => {
    window.addEventListener("resize", redraw);
    return () => window.removeEventListener("resize", redraw);
  }, [redraw]);

  if (prices.length < 200) {
    return <div className="text-xs text-fg-muted p-3">データが不足しています（200営業日以上必要）。</div>;
  }

  const ics = res?.ok ? res.ics : [];
  const icKeys = Array.from(new Set(ics.map((i) => i.key)));

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">as-of スコアカード — 多数の過去時点で判断を再現し、型ごとの採点則で採点する</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          方向は「常に多数派を言い続けた場合」と比べ、確率はブライアスコアを気候値と比べ、区間は名目被覆率と比べ、
          ボラ予測は Mincer–Zarnowitz 回帰で検定します。<span className="font-medium">当たった/外れたを数えるだけでは採点になりません。</span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          時間軸
          <select className="border rounded px-1 py-0.5" value={horizon} onChange={(e) => setHorizon(e.target.value as Horizon)}>
            {HORIZONS.map((h) => <option key={h} value={h}>{HORIZON_CONFIG[h].label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          as-of 間隔
          <select className="border rounded px-1 py-0.5" value={spacing} onChange={(e) => setSpacing(Number(e.target.value))}>
            {SPACINGS.map((s) => <option key={s} value={s}>{s}営業日ごと</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          対象期間
          <select className="border rounded px-1 py-0.5" value={lookbackYears} onChange={(e) => setLookbackYears(Number(e.target.value))}>
            {LOOKBACKS.map((y) => <option key={y} value={y}>直近{y}年</option>)}
          </select>
        </label>
        {running && (
          <span className="text-blue-600">
            再現中… {progress ? `${progress.done}/${progress.total}` : ""}
          </span>
        )}
      </div>

      {res && !res.ok && <div className="text-xs text-amber-700 p-2 bg-amber-50 rounded">{res.reason}</div>}

      {res?.ok && (
        <>
          <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] text-gray-700 space-y-0.5">
            <div>
              as-of 点 <span className="font-bold">{res.points.length}</span> 件（{res.firstDate} 〜 {res.lastDate}・{spacing}営業日ごと）
            </div>
            <div className="text-gray-500">
              実効標本数 —{" "}
              {FWD_HORIZONS.map((h, i) => (
                <span key={h} className="mr-2">{h}日: <span className="font-medium">{res.nEff[i].toFixed(0)}</span>（{res.overlap[i]}重に重複）</span>
              ))}
            </div>
            <div className="text-gray-500">
              先行き H 日を {spacing} 日ごとに評価すると標本は ceil(H/{spacing}) 重に重なります。
              素の件数で誤差を出すと信頼区間が実際の 1/√重複 に縮むため、下表の CI はすべてブロック・ブートストラップです。
            </div>
          </div>

          {/* ── 方向 ── */}
          <div>
            <div className="text-xs font-medium text-gray-700 mb-1">① 方向（up/down）— ヌルは「常に多数派方向」</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 px-1.5">先行き</th>
                    <th className="text-right px-1.5">採点数</th>
                    <th className="text-right px-1.5">中立で不採点</th>
                    <th className="text-right px-1.5">的中率</th>
                    <th className="text-center px-1.5">95%CI</th>
                    <th className="text-right px-1.5">多数派ヌル</th>
                    <th className="text-right px-1.5">PT統計量</th>
                    <th className="text-right px-1.5">p値</th>
                    <th className="text-center px-1.5">判定</th>
                  </tr>
                </thead>
                <tbody>
                  {res.direction.map((ds) => {
                    const beats = isFinite(ds.hit) && isFinite(ds.baseHit) && ds.hit > ds.baseHit;
                    const sig = isFinite(ds.ptP) && ds.ptP < 0.05;
                    return (
                      <tr key={ds.h} className="border-b border-gray-100">
                        <td className="py-1 px-1.5 text-gray-600">{ds.h}日後</td>
                        <td className="text-right px-1.5 font-mono">{ds.n}</td>
                        <td className="text-right px-1.5 font-mono text-fg-muted">{ds.nFlat}</td>
                        <td className="text-right px-1.5 font-mono font-semibold">{pctS(ds.hit)}</td>
                        <td className="text-center px-1.5 font-mono text-gray-500">
                          {isFinite(ds.hitLo) ? `${pctS(ds.hitLo)}–${pctS(ds.hitHi)}` : "—"}
                        </td>
                        <td className={`text-right px-1.5 font-mono ${beats ? "text-gray-500" : "text-red-600"}`}>{pctS(ds.baseHit)}</td>
                        <td className="text-right px-1.5 font-mono">{fmt(ds.ptStat, 2)}</td>
                        <td className="text-right px-1.5 font-mono">{fmtP(ds.ptP)}</td>
                        <td className="text-center px-1.5">
                          {sig && beats
                            ? <span className="text-green-700 font-medium">情報あり</span>
                            : <span className="text-fg-muted">裏付けなし</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-fg-muted mt-1">
              的中率が多数派ヌルを下回っているなら、その方向判断は「何も考えず上と言い続ける」より劣ります。
              PT検定は多数派当てを自動で割り引くので、こちらを主判定に使ってください。
            </p>
          </div>

          {/* ── 確率 ── */}
          <div>
            <div className="text-xs font-medium text-gray-700 mb-1">② 上昇確率 — ブライアスコアと較正</div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="text-left py-1 px-1.5">先行き</th>
                      <th className="text-right px-1.5">n</th>
                      <th className="text-right px-1.5">平均予測</th>
                      <th className="text-right px-1.5">実現率</th>
                      <th className="text-right px-1.5">Brier</th>
                      <th className="text-right px-1.5">気候値</th>
                      <th className="text-right px-1.5">BSS</th>
                      <th className="text-right px-1.5">較正誤差</th>
                      <th className="text-right px-1.5">分解能</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.probability.map((ps) => (
                      <tr key={ps.h} className="border-b border-gray-100">
                        <td className="py-1 px-1.5 text-gray-600">{ps.h}日後</td>
                        <td className="text-right px-1.5 font-mono">{ps.n}</td>
                        <td className="text-right px-1.5 font-mono">{pctS(ps.meanP)}</td>
                        <td className="text-right px-1.5 font-mono">{pctS(ps.obsRate)}</td>
                        <td className="text-right px-1.5 font-mono font-semibold">{fmt(ps.brier, 4)}</td>
                        <td className="text-right px-1.5 font-mono text-gray-500">{fmt(ps.brierClim, 4)}</td>
                        <td className={`text-right px-1.5 font-mono font-semibold ${ps.bss > 0 ? "text-green-700" : "text-red-600"}`}>{fmt(ps.bss, 4)}</td>
                        <td className="text-right px-1.5 font-mono text-gray-500">{fmt(ps.reliability, 4)}</td>
                        <td className="text-right px-1.5 font-mono text-gray-500">{fmt(ps.resolution, 4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[11px] text-fg-muted mt-1">
                  BSS ≤ 0 なら「常に基準率を答える」より悪い＝確率に情報がありません。
                  分解能がほぼ0なら、当たっていてもそれは基準率を言い当てているだけです。
                </p>
              </div>
              <div>
                <div className="text-[11px] text-gray-500 mb-0.5">較正図（点が対角線に乗れば「50%と言った時に5割上げた」）</div>
                <canvas ref={relRef} />
              </div>
            </div>
          </div>

          {/* ── 区間 ── */}
          <div>
            <div className="text-xs font-medium text-gray-700 mb-1">③ 予測レンジ（区間）— 名目被覆率との一致</div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="text-left py-1 px-1.5">先行き</th>
                      <th className="text-right px-1.5">名目</th>
                      <th className="text-right px-1.5">実測被覆</th>
                      <th className="text-center px-1.5">95%CI</th>
                      <th className="text-right px-1.5">幅(価格比)</th>
                      <th className="text-right px-1.5">pinball</th>
                      <th className="text-right px-1.5">LR_uc p</th>
                      <th className="text-center px-1.5">判定</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.intervals.map((iv, i) => {
                      const ok = isFinite(iv.lrUcP) && iv.lrUcP >= 0.05;
                      return (
                        <tr key={`${iv.h}-${iv.level}-${i}`} className="border-b border-gray-100">
                          <td className="py-1 px-1.5 text-gray-600">{iv.h}日後</td>
                          <td className="text-right px-1.5 font-mono text-gray-500">{pctS(iv.nominal, 0)}</td>
                          <td className="text-right px-1.5 font-mono font-semibold">{pctS(iv.coverage)}</td>
                          <td className="text-center px-1.5 font-mono text-gray-500">
                            {isFinite(iv.covLo) ? `${pctS(iv.covLo, 0)}–${pctS(iv.covHi, 0)}` : "—"}
                          </td>
                          <td className="text-right px-1.5 font-mono text-gray-500">{fmt(iv.meanWidthPct, 1)}%</td>
                          <td className="text-right px-1.5 font-mono text-gray-500">{fmt(iv.pinball, 4)}</td>
                          <td className="text-right px-1.5 font-mono">{fmtP(iv.lrUcP)}</td>
                          <td className="text-center px-1.5">
                            {ok ? <span className="text-green-700">整合</span>
                              : iv.coverage < iv.nominal ? <span className="text-red-600">狭すぎ</span> : <span className="text-amber-700">広すぎ</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="text-[11px] text-fg-muted mt-1">
                  「狭すぎ」ならストップが想定より高頻度で刈られます。「広すぎ」は外れないが役に立たない区間です。
                  重複窓のため独立性検定(LR_ind)は解釈できないので、無条件被覆(LR_uc)だけを判定に使っています。
                </p>
              </div>
              <div>
                <div className="text-[11px] text-gray-500 mb-0.5">被覆率 vs 名目（黒破線＝名目・横棒＝95%CI）</div>
                <canvas ref={covRef} />
              </div>
            </div>
          </div>

          {/* ── ボラ ── */}
          <div>
            <div className="text-xs font-medium text-gray-700 mb-1">④ ボラ予測 — Mincer–Zarnowitz 回帰</div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="text-left py-1 px-1.5">先行き</th>
                      <th className="text-right px-1.5">n</th>
                      <th className="text-right px-1.5">切片 a</th>
                      <th className="text-right px-1.5">傾き b</th>
                      <th className="text-right px-1.5">R²</th>
                      <th className="text-right px-1.5">相関</th>
                      <th className="text-right px-1.5">Wald p</th>
                      <th className="text-right px-1.5">QLIKE</th>
                      <th className="text-right px-1.5">予測/実現</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.vol.map((vs) => (
                      <tr key={vs.h} className="border-b border-gray-100">
                        <td className="py-1 px-1.5 text-gray-600">{vs.h}日後</td>
                        <td className="text-right px-1.5 font-mono">{vs.n}</td>
                        <td className="text-right px-1.5 font-mono">{fmt(vs.a, 4)}</td>
                        <td className={`text-right px-1.5 font-mono font-semibold ${isFinite(vs.b) && Math.abs(vs.b - 1) < 0.3 ? "text-green-700" : "text-amber-700"}`}>{fmt(vs.b, 3)}</td>
                        <td className="text-right px-1.5 font-mono">{fmt(vs.r2, 3)}</td>
                        <td className="text-right px-1.5 font-mono">{fmt(vs.corr, 3)}</td>
                        <td className="text-right px-1.5 font-mono">{fmtP(vs.waldP)}</td>
                        <td className="text-right px-1.5 font-mono text-gray-500">{fmt(vs.qlike, 3)}</td>
                        <td className="text-right px-1.5 font-mono text-gray-500">
                          {isFinite(vs.meanPred) && vs.meanReal > 0 ? `${(vs.meanPred / vs.meanReal).toFixed(2)}倍` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[11px] text-fg-muted mt-1">
                  理想は a=0・b=1。Wald p が小さいほど「予測がそのままの水準では使えない」ことを意味します。
                  b&lt;1 は予測が振れすぎ（縮めて使う）、予測/実現が 1 から離れるのは水準バイアスです。
                  ボラは方向と違い実際に予測できる量なので、ここは R² が 0.2〜0.5 出ても不思議ではありません。
                </p>
              </div>
              <div>
                <div className="flex items-center gap-2 text-[11px] text-gray-500 mb-0.5">
                  <span>散布図</span>
                  <select className="border rounded px-1 py-0.5" value={mzH} onChange={(e) => setMzH(Number(e.target.value))}>
                    {FWD_HORIZONS.map((h, i) => <option key={h} value={i}>{h}日先</option>)}
                  </select>
                </div>
                <canvas ref={mzRef} />
              </div>
            </div>
          </div>

          {/* ── IC ── */}
          <div>
            <div className="text-xs font-medium text-gray-700 mb-1">⑤ 連続量の判断 — 情報係数 IC（Spearman）</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 px-1.5">判断</th>
                    {FWD_HORIZONS.map((h) => <th key={h} className="text-center px-1.5">{h}日後 IC（95%CI）</th>)}
                  </tr>
                </thead>
                <tbody>
                  {icKeys.map((key) => {
                    const row = FWD_HORIZONS.map((h) => ics.find((i) => i.key === key && i.h === h));
                    const label = row.find((r) => r)?.label ?? key;
                    return (
                      <tr key={key} className="border-b border-gray-100">
                        <td className="py-1 px-1.5 text-gray-700">{label}</td>
                        {row.map((r, i) => {
                          if (!r || !isFinite(r.ic)) return <td key={i} className="text-center px-1.5 text-gray-300">—</td>;
                          const sig = isFinite(r.icLo) && (r.icLo > 0 || r.icHi < 0);
                          return (
                            <td key={i} className="text-center px-1.5 font-mono">
                              <span className={sig ? (r.ic > 0 ? "text-green-700 font-semibold" : "text-red-600 font-semibold") : "text-gray-600"}>
                                {fmt(r.ic, 3)}
                              </span>
                              <span className="text-fg-muted text-[10px]"> ({fmt(r.icLo, 2)},{fmt(r.icHi, 2)})</span>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-fg-muted mt-1">
              CI が 0 をまたぐものは「順位相関の証拠なし」。日次データの実務的な IC は 0.02〜0.05 程度で、
              0.1 を超えたら標本が薄いか、どこかに先読みが混じっていないかを疑う水準です。
              なお 6 判断 × 4 ホライズン = 24 検定を同時に見ているので、5% 有意は期待値で 1.2 件出ます。
            </p>
          </div>

          {/* ── イベント ── */}
          <div>
            <div className="text-xs font-medium text-gray-700 mb-1">⑥ 警告系の判断 — 出た後に本当に荒れたか</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 px-1.5">警告</th>
                    <th className="text-left px-1.5">先行き</th>
                    <th className="text-right px-1.5">発生数</th>
                    <th className="text-right px-1.5">発生時の実現σ</th>
                    <th className="text-right px-1.5">非発生時</th>
                    <th className="text-right px-1.5">t</th>
                    <th className="text-right px-1.5">p</th>
                    <th className="text-right px-1.5">発生後リターン</th>
                  </tr>
                </thead>
                <tbody>
                  {res.events.filter((e) => e.h === 21 || e.h === 5).map((e, i) => (
                    <tr key={`${e.key}-${e.h}-${i}`} className="border-b border-gray-100">
                      <td className="py-1 px-1.5 text-gray-700">{e.label}</td>
                      <td className="px-1.5 text-gray-500">{e.h}日</td>
                      <td className="text-right px-1.5 font-mono">{e.nEvent}</td>
                      <td className="text-right px-1.5 font-mono font-semibold">{fmt(e.volEvent, 2)}%</td>
                      <td className="text-right px-1.5 font-mono text-gray-500">{fmt(e.volNon, 2)}%</td>
                      <td className="text-right px-1.5 font-mono">{fmt(e.tStat, 2)}</td>
                      <td className="text-right px-1.5 font-mono">{fmtP(e.p)}</td>
                      <td className={`text-right px-1.5 font-mono ${e.retEvent >= 0 ? "text-green-700" : "text-red-600"}`}>{fmt(e.retEvent, 2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-fg-muted mt-1">
              変化点・ボラ急拡大は「その後荒れる」ことを主張する警告なので、実現σの差で採点します。
              リターンの符号を当てる装置ではないので、発生後リターンは参考値です。
            </p>
          </div>
        </>
      )}

      <AnalysisGuide title="as-of スコアカードの詳細理論">
        <p className="font-medium text-gray-700">1. なぜ「当たった回数」では採点にならないか</p>
        <p>
          株価は長期的に上昇するので、<span className="font-medium">「常に上」と言い続けるだけで的中率は5割を超えます</span>。
          日本株の日次データでも上昇日は約52%あり、10年の上げ相場なら60%近くになります。
          つまり的中率の絶対値は、判断の質ではなく相場の地合いを測っているにすぎません。
          同じことが確率にも区間にも起きます。採点には必ず<span className="font-medium">ヌル（何も知らない予測）</span>との比較が要ります。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 型ごとの採点則と数式</p>
        <p className="mt-1">■ 方向（up/down）— Pesaran–Timmermann 検定</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"的中率 P̂ = (1/n)Σ 1{sign(ŷ_t)=sign(y_t)}"}</li>
          <li>{"独立なら期待される的中率 P* = P_x·P_y + (1−P_x)(1−P_y)（P_x=予測が上の割合、P_y=実測が上の割合）"}</li>
          <li>{"PT = (P̂ − P*) / √(var(P̂) − var(P*)) → 標準正規"}</li>
          <li>この式は「上げ相場で常に上と言う」を自動的に割り引きます。P* が既に0.6なら、的中率0.6は情報ゼロと判定されます。</li>
        </ul>
        <p className="mt-2">■ 確率（上昇確率）— ブライアスコアと Murphy 分解</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"Brier = (1/n)Σ (p_t − o_t)²  （o_t は上げたら1）。小さいほど良い"}</li>
          <li>{"気候値 = ō(1−ō)。常に基準率 ō を答えるだけの予測のスコア"}</li>
          <li>{"BSS = 1 − Brier/気候値。0以下なら基準率以下＝情報なし"}</li>
          <li>{"Murphy 分解: Brier = 較正誤差 − 分解能 + 不確実性"}</li>
          <li>較正誤差＝「70%と言った時に本当に7割起きたか」のズレ。分解能＝「予測が基準率からどれだけ動いたか」。<span className="font-medium">分解能が0の予測は、完璧に較正されていても無価値</span>です（毎回52%と言うだけ）。</li>
        </ul>
        <p className="mt-2">■ 区間（予測レンジ）— Christoffersen 検定と pinball 損失</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"違反 I_t = 1{y_t ∉ [L_t, U_t]}。名目水準 L の区間なら期待違反率は 1−L"}</li>
          <li>{"LR_uc = −2[ ln 尤度(期待違反率) − ln 尤度(実測違反率) ] → χ²(1)"}</li>
          <li>{"pinball 損失: ρ_q(y,f) = q(y−f) if y≥f else (1−q)(f−y)。区間の上下端をそれぞれ分位点として採点"}</li>
          <li>被覆率が名目に一致しても、幅が広ければ役に立ちません。pinball は「当てつつ狭い」を評価します。</li>
        </ul>
        <p className="mt-2">■ ボラ予測 — Mincer–Zarnowitz 回帰</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"実現σ_t = a + b·予測σ_t + u_t を推定し、(a,b)=(0,1) を Wald 同時検定"}</li>
          <li>{"QLIKE = (1/n)Σ [ σ²_real/σ²_pred − ln(σ²_real/σ²_pred) − 1 ]。分散予測に対する適正損失"}</li>
          <li>重複窓の自己相関があるので、標準誤差は Newey–West（Bartlett 重み・ラグ=重複数−1）で補正しています。</li>
        </ul>
        <p className="mt-2">■ 連続量 — 情報係数 IC</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"IC = Spearman(判断値, 先行きリターン)。順位相関なので外れ値に強い"}</li>
          <li>CI は移動ブロック・ブートストラップ（ブロック長＝重複数）。重複窓を壊さずに再標本化します。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 重複窓と実効標本数</p>
        <p>
          {"先行き H 日を s 日ごとに評価すると、隣り合う標本は H−s 日ぶん同じ価格を共有します。重なりは ceil(H/s) 重で、実効標本数は nEff ≈ n / ceil(H/s) まで落ちます。"}
          例えば 63日先を5日ごとに評価した250点は、独立な情報としては<span className="font-medium">20点ぶんしかありません</span>。
          素の n で t 検定をすると、標準誤差が実際の 1/√13 に縮み、何もないところに有意が立ちます。
          この画面の CI がすべてブロック・ブートストラップなのはこのためです。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">方向に情報がないのが普通です。</span>短期リターンの符号は理論上ほぼ予測不能で、このアプリの他の分析（SPA検定 p=0.334、系C26 ドリフト識別限界）とも整合します。ここで「裏付けなし」が並ぶのは失敗ではなく、正しい測定結果です。</li>
          <li><span className="font-medium">ボラと区間は当たる可能性があります。</span>ボラはクラスタリングするので予測可能で、R² が 0.2〜0.5 出ても不自然ではありません。方向は当たらないがボラは当たる、という非対称は理論通りです。</li>
          <li>較正誤差が大きく分解能が小さい確率は、「言い方が下手」ではなく「そもそも情報がない」状態です。閾値をいじっても直りません。</li>
          <li>IC が 0.1 を超えたら喜ぶ前に疑ってください。日次でその水準は稀で、標本の薄さか実装の先読みを先に確認します。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">画面のどの数字を信じるかの優先順位づけ</span>に使います。ボラ・区間が較正されていて方向に情報がないなら、建てるかどうかは方向で決めず、<span className="font-medium">サイズとストップ幅を区間で決める</span>のが筋になります。</li>
          <li>区間が「狭すぎ」ならストップを予測レンジより外に置く必要があります。実測被覆率と名目の差が、そのまま広げるべき倍率の目安です。</li>
          <li>b&lt;1 のボラ予測は、そのまま使うと高ボラ局面でポジションを絞りすぎます。b で割り戻してからサイズ計算に入れます。</li>
          <li>時間軸（デイトレ/スイング/ポジション）を切り替えて、どの窓長で判断が最も較正されているかを確認します。窓長は判断の質を大きく変えます。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">これは前向き検証ではありません。</span>as-of の切り出しは厳密なので<span className="font-medium">先読みは排除できますが、探索バイアスは排除できません</span>。「どの判断を採点するか」「どの閾値を使うか」を決めているのは今日の自分です。年単位で待つ前向き検証台帳の代わりにはならず、待たずに標本を稼ぐ代わりに選択の自由度を抱えたままの検証、という位置づけです。</li>
          <li>この画面だけで 6判断×4ホライズン＋方向4＋確率3＋区間9＋ボラ4 ≒ 44 検定が同時に走っています。5% 有意は期待値で 2 件出ます。1つだけ光っている結果は、まず多重性を疑ってください（グローバル多重検定台帳を併読）。</li>
          <li>価格は配当・分割で遡及調整されるため、当時の生の株価とは一致しません。長期の過去ほどズレます。</li>
          <li>採点しているのは蒸留層の判断であって、アプリ全体ではありません。ここが良くても他のパネルの主張は保証されません。逆も同じです。</li>
          <li>単一銘柄の単一系列なので、ここでの結論を他銘柄に一般化することはできません。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
