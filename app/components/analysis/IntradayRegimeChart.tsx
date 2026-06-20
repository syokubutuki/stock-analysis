"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useIntraday } from "../../hooks/useIntraday";
import {
  computeRegime, computeAnalog, computeSessionSplit,
  RegimeResult, AnalogResult, SessionResult, RegimeLabel,
} from "../../lib/intraday-regime";
import {
  initCanvas, fmtPct, fmtSignedPct, IntervalButtons, ViewTabs, LoadingError,
  StatCell, IntradayCaveat,
} from "./intradayShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

type View = "regime" | "analog" | "session";
const VIEWS: { value: View; label: string }[] = [
  { value: "regime", label: "トレンド/レンジ" },
  { value: "analog", label: "経路アナログ" },
  { value: "session", label: "前場→後場" },
];

const LABEL_COLOR: Record<RegimeLabel, string> = { up: "#16a34a", down: "#dc2626", range: "#9ca3af" };
const LABEL_NAME: Record<RegimeLabel, string> = { up: "強トレンド上", down: "強トレンド下", range: "レンジ" };

function drawRegime(ctx: CanvasRenderingContext2D, W: number, H: number, r: RegimeResult) {
  const ml = 40, mr = 16, mt = 28, mb = 24;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const n = r.days.length;
  const slot = plotW / Math.max(1, n);
  const barW = Math.max(1, slot * 0.7);

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("日別の効率比ER（色=レジーム, 破線=閾値）", ml, mt - 12);
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText("1.0", ml - 4, mt + 9); ctx.fillText("0", ml - 4, mt + plotH);

  // 閾値線
  const yTh = mt + plotH - r.erThreshold * plotH;
  ctx.strokeStyle = "#f59e0b"; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(ml, yTh); ctx.lineTo(ml + plotW, yTh); ctx.stroke(); ctx.setLineDash([]);

  for (let i = 0; i < n; i++) {
    const d = r.days[i];
    const h = d.er * plotH;
    const x = ml + i * slot + (slot - barW) / 2;
    ctx.fillStyle = LABEL_COLOR[d.label];
    ctx.fillRect(x, mt + plotH - h, barW, h);
  }
}

function drawAnalog(ctx: CanvasRenderingContext2D, W: number, H: number, a: AnalogResult) {
  const ml = 44, mr = 16, mt = 28, mb = 24;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const L = a.maxLen;
  const xs = (i: number) => ml + (i / Math.max(1, L - 1)) * plotW;

  let vmax = 0.5, vmin = -0.5;
  for (const nb of a.neighbors) for (const v of nb.fullPath) { if (v > vmax) vmax = v; if (v < vmin) vmin = v; }
  for (const v of a.queryPath) { if (v > vmax) vmax = v; if (v < vmin) vmin = v; }
  const ys = (v: number) => mt + plotH - ((v - vmin) / (vmax - vmin)) * plotH;

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`直近日(${a.queryDate})に似た過去${a.n}日の続き（始値比%）`, ml, mt - 12);

  // 0ライン・cutoff線
  const y0 = ys(0);
  ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(ml, y0); ctx.lineTo(ml + plotW, y0); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(vmax.toFixed(2), ml - 4, mt + 9); ctx.fillText(vmin.toFixed(2), ml - 4, mt + plotH);
  const xc = xs(a.cutoffBars - 1);
  ctx.strokeStyle = "#c7d2fe"; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(xc, mt); ctx.lineTo(xc, mt + plotH); ctx.stroke(); ctx.setLineDash([]);

  ctx.save(); ctx.beginPath(); ctx.rect(ml, mt, plotW, plotH); ctx.clip();
  // 近傍の続き（細線）
  for (const nb of a.neighbors) {
    ctx.strokeStyle = "#94a3b855"; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < nb.fullPath.length; i++) { const x = xs(i), y = ys(nb.fullPath[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  }
  // クエリ経路（太線）
  ctx.strokeStyle = "#111827"; ctx.lineWidth = 2.4; ctx.beginPath();
  for (let i = 0; i < a.queryPath.length; i++) { const x = xs(i), y = ys(a.queryPath[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.stroke();
  ctx.restore();
}

function drawSession(ctx: CanvasRenderingContext2D, W: number, H: number, s: SessionResult) {
  const ml = 44, mr = 16, mt = 28, mb = 30;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const xs0 = s.points.map((p) => p.amPct), ys0 = s.points.map((p) => p.pmPct);
  const ax = Math.max(0.5, ...xs0.map(Math.abs)), ay = Math.max(0.5, ...ys0.map(Math.abs));
  const xs = (v: number) => ml + ((v + ax) / (2 * ax)) * plotW;
  const ys = (v: number) => mt + plotH - ((v + ay) / (2 * ay)) * plotH;

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("前場リターン(横) vs 後場リターン(縦) %", ml, mt - 12);

  // 軸0線
  ctx.strokeStyle = "#e5e7eb";
  ctx.beginPath(); ctx.moveTo(xs(0), mt); ctx.lineTo(xs(0), mt + plotH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ml, ys(0)); ctx.lineTo(ml + plotW, ys(0)); ctx.stroke();

  for (const p of s.points) {
    ctx.fillStyle = p.pmPct >= 0 ? "#16a34a99" : "#dc262699";
    ctx.beginPath(); ctx.arc(xs(p.amPct), ys(p.pmPct), 2.5, 0, Math.PI * 2); ctx.fill();
  }
  // 回帰直線
  ctx.strokeStyle = "#7c3aed"; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(xs(-ax), ys(s.alpha + s.beta * -ax));
  ctx.lineTo(xs(ax), ys(s.alpha + s.beta * ax));
  ctx.stroke();
}

export default function IntradayRegimeChart({ ticker }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [intervalKey, setIntervalKey] = useState("5m");
  const [view, setView] = useState<View>("regime");
  const { resp, loading, error } = useIntraday(ticker, intervalKey);

  const binMin = intervalKey === "60m" ? 60 : intervalKey === "30m" ? 30 : intervalKey === "15m" ? 15 : 5;
  const regime = useMemo<RegimeResult | null>(() => (resp ? computeRegime(resp.bars, resp.gmtoffset) : null), [resp]);
  const analog = useMemo<AnalogResult | null>(() => (resp ? computeAnalog(resp.bars, resp.gmtoffset) : null), [resp]);
  const session = useMemo<SessionResult | null>(() => (resp ? computeSessionSplit(resp.bars, resp.gmtoffset, binMin) : null), [resp, binMin]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const H = 320;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width } = init;
    if (view === "regime" && regime) drawRegime(ctx, width, H, regime);
    else if (view === "analog" && analog) drawAnalog(ctx, width, H, analog);
    else if (view === "session" && session) drawSession(ctx, width, H, session);
  }, [view, regime, analog, session]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">当日内の状態（どういう日か）</h3>
        <IntervalButtons value={intervalKey} onChange={setIntervalKey} />
      </div>
      <ViewTabs value={view} onChange={setView} views={VIEWS} />
      <LoadingError loading={loading} error={error} />

      {!loading && !error && (
        <>
          {view === "regime" && regime && (
            <>
              <div className="text-xs text-gray-500">対象 {regime.nDays} 営業日 / 効率比閾値 {regime.erThreshold}</div>
              <div className="relative"><canvas ref={canvasRef} /></div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="text-left py-1">当日レジーム</th>
                      <th className="text-right">日数</th>
                      <th className="text-right">翌日平均R</th>
                      <th className="text-right">翌日勝率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {regime.buckets.map((b) => (
                      <tr key={b.label} className="border-b border-gray-100">
                        <td className="py-1 font-medium" style={{ color: LABEL_COLOR[b.label] }}>{LABEL_NAME[b.label]}</td>
                        <td className="text-right">{b.count}</td>
                        <td className={`text-right ${b.nextMeanPct >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(b.nextMeanPct / 100)}</td>
                        <td className="text-right">{fmtPct(b.nextWin)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
                {"効率比ER=純変化/総変化（1に近いほどトレンド、0に近いほどレンジ/ノイズ）。緑/赤=強トレンド日、灰=レンジ日。レジーム別の翌日成績に偏りがあれば、当日タイプから翌日方針（順張り継続か反転狙いか）を立てられる。"}
              </p>
            </>
          )}

          {view === "analog" && analog && (
            <>
              <div className="text-xs text-gray-500">直近日 {analog.queryDate} / 前半{analog.cutoffBars}バーで類似検索 / 近傍{analog.n}日</div>
              <div className="relative"><canvas ref={canvasRef} /></div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <StatCell label="近傍の引け平均" value={fmtSignedPct(analog.meanClosePct / 100)} tone={analog.meanClosePct >= 0 ? "up" : "down"} />
                <StatCell label="近傍の上昇率" value={fmtPct(analog.winRate)} />
                <StatCell label="引け25%点" value={fmtSignedPct(analog.q25 / 100)} />
                <StatCell label="引け75%点" value={fmtSignedPct(analog.q75 / 100)} />
              </div>
              <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
                {"太線=直近日の前半経路、細線=それに似た過去日の『その後の続き』。似た立ち上がりの日が引けに向けてどう動いたかの分布を示す。占いではなく分布として扱い、近傍数が少ない点に注意。"}
              </p>
            </>
          )}

          {view === "session" && session && (
            <>
              <div className="text-xs text-gray-500">
                対象 {session.nDays} 営業日 / {session.hasTwoSessions ? "前場・後場の2セッション" : "午前・午後で分割"}
              </div>
              <div className="relative"><canvas ref={canvasRef} /></div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <StatCell label="相関 r" value={session.corr.toFixed(3)} tone={session.corr >= 0 ? "up" : "down"} />
                <StatCell label="傾き β" value={session.beta.toFixed(3)} />
                <StatCell label="決定係数 R²" value={session.r2.toFixed(3)} />
                <StatCell label="切片 α(%)" value={session.alpha.toFixed(3)} />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="text-left py-1">前場の状態</th>
                      <th className="text-right">日数</th>
                      <th className="text-right">後場平均R</th>
                      <th className="text-right">後場勝率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {session.buckets.map((b) => (
                      <tr key={b.label} className="border-b border-gray-100">
                        <td className="py-1 font-medium">{b.label}</td>
                        <td className="text-right">{b.n}</td>
                        <td className={`text-right ${b.pmMeanPct >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(b.pmMeanPct / 100)}</td>
                        <td className="text-right">{fmtPct(b.pmWin)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
                {"前場リターンと後場リターンの関係。β>0なら継続（前場高→後場高）、β<0なら反転（前場高→後場安）。昼休み時点で後場の方向に賭ける/手仕舞う判断に使う。"}
              </p>
            </>
          )}

          <IntradayCaveat />
        </>
      )}

      <AnalysisGuide title="当日内の状態分析の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"当日が『トレンド日かレンジ日か』『過去のどの日に似ているか』『前場の動きが後場に効くか』を測り、順張り/逆張りの戦略スイッチと持ち越し/手仕舞いの判断に落とし込む。"}</p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>Kaufman効率比</strong>: ER=|C_last−C_first| / Σ|C_i−C_{`{i-1}`}|。「まっすぐ進んだ距離÷歩いた総距離」。1=完全トレンド、0=往来。</li>
          <li><strong>分散比</strong>: VR(q)=Var(q期間和) / (q·Var(1期間))。&gt;1でトレンド、&lt;1で平均回帰。</li>
          <li><strong>経路アナログ</strong>: 各日の始値比経路 p_i=(C_i−O)/O を正規化し、直近日の前半とのDTW（伸縮を許す波形距離）距離で近傍K日を抽出。その続き（引けまで）の分布を見る。</li>
          <li><strong>前場→後場</strong>: r_AM=(C_前場−O)/O、r_PM=(C_引け−O_後場)/O_後場。単回帰 r_PM=α+β·r_AM の β・相関で継続/反転を判定。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ERが高い日が多い銘柄はトレンドフォロー向き、低ければ逆張り（レンジ）向き。</li>
          <li>レジーム別の翌日成績に偏りがあれば、当日タイプが翌日の先行サインになる。</li>
          <li>近傍日の引け分布が偏っていれば、似た立ち上がりからの先行きの傾向が読める。</li>
          <li>β&gt;0は前場の勢いが後場も続く、β&lt;0は前場と逆に振れやすい。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>トレンド日判定→順張り、レンジ日→VWAP/バンド逆張りへ戦略を切替。</li>
          <li>アナログの分布で当日の引けの当たりを付け、利確/持ち越しを決める。</li>
          <li>前場→後場の関係から、昼の段階で後場ポジションを調整。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"当日確定前のERは暫定値。日中はリアルタイムに変化する。"}</li>
          <li>{"アナログの近傍プールは5分足60日で小さい。過去の繰り返しを前提にしすぎないこと。"}</li>
          <li>{"前場/後場分割はバー時刻の最大ギャップ（昼休み）で行う。単一セッション市場では午前/午後の便宜分割になる。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
