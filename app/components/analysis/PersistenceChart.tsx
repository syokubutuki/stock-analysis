"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { conditionalForwardReturns, buildStateFn, STATE_AXES, StateAxis } from "../../lib/conditional-forward-returns";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; }

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

export default function PersistenceChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [axis, setAxis] = useState<StateAxis>("rsi");

  const data = useMemo(() => {
    if (prices.length < 600) return null;
    const mid = Math.floor(prices.length / 2);
    const first = prices.slice(0, mid), second = prices.slice(mid);
    const r1 = conditionalForwardReturns(first, buildStateFn(first, axis), 5, { boot: 0 });
    const r2 = conditionalForwardReturns(second, buildStateFn(second, axis), 5, { boot: 0 });
    const m2 = new Map(r2.buckets.map((b) => [b.label, b.meanFwd]));
    const pairs = r1.buckets
      .filter((b) => m2.has(b.label))
      .map((b) => ({ label: b.label, first: b.meanFwd, second: m2.get(b.label)! }));
    if (pairs.length < 3) return null;
    // 相関
    const xs = pairs.map((p) => p.first), ys = pairs.map((p) => p.second);
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length, my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
    const corr = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
    const agree = pairs.filter((p) => Math.sign(p.first) === Math.sign(p.second)).length / pairs.length;
    return { pairs, corr, agree };
  }, [prices, axis]);

  useEffect(() => {
    if (!canvasRef.current || !data) return;
    const init = initCanvas(canvasRef.current, 240);
    if (!init) return;
    const { ctx, width } = init;
    const sz = 240, ml = 44, mt = 16, mb = 28;
    const plotW = Math.min(width, sz) - ml - 12, plotH = sz - mt - mb;
    const all = data.pairs.flatMap((p) => [p.first, p.second]);
    const mx = Math.max(0.005, ...all.map(Math.abs));
    const xOf = (v: number) => ml + ((v + mx) / (2 * mx)) * plotW;
    const yOf = (v: number) => mt + plotH - ((v + mx) / (2 * mx)) * plotH;
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("前半 vs 後半の状態別平均（対角=再現）", ml, 12);
    ctx.strokeStyle = "#e5e7eb"; ctx.beginPath(); ctx.moveTo(xOf(-mx), yOf(-mx)); ctx.lineTo(xOf(mx), yOf(mx)); ctx.stroke();
    ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(xOf(0), mt); ctx.lineTo(xOf(0), mt + plotH); ctx.moveTo(ml, yOf(0)); ctx.lineTo(ml + plotW, yOf(0)); ctx.stroke();
    for (const p of data.pairs) {
      const same = Math.sign(p.first) === Math.sign(p.second);
      ctx.fillStyle = same ? "#16a34a" : "#dc2626";
      ctx.beginPath(); ctx.arc(xOf(p.first), yOf(p.second), 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = "#9ca3af"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("前半→", ml + plotW / 2, mt + plotH + 14);
  }, [data]);

  if (prices.length < 600 || !data) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">持続性・サンプル外検証（前半/後半の再現性）</h3>

      <div className="flex gap-1 flex-wrap">
        {STATE_AXES.map((a) => (
          <button key={a.value} onClick={() => setAxis(a.value)} className={`px-2.5 py-1 text-xs rounded font-medium ${axis === a.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{a.label}</button>
        ))}
      </div>

      <div className={`rounded-md border px-3 py-2 text-xs ${data.corr > 0.5 ? "border-green-200 bg-green-50 text-green-900" : data.corr < 0 ? "border-red-200 bg-red-50 text-red-900" : "border-gray-200 bg-gray-50 text-gray-700"}`}>
        前半・後半の状態別平均の相関 = <span className="font-bold">{data.corr.toFixed(2)}</span>
        ／ 符号一致率 <span className="font-bold">{(data.agree * 100).toFixed(0)}%</span>
        {data.corr > 0.5 ? "（エッジは再現性が高い）" : data.corr < 0 ? "（前半と後半で逆転＝不安定）" : "（再現性は限定的）"}
      </div>

      <div className="relative"><canvas ref={canvasRef} /></div>
      <div className="text-xs text-gray-500">緑=前半後半で符号一致（再現） / 赤=逆転。対角線に乗るほど安定したエッジ。</div>

      <AnalysisGuide title="持続性・サンプル外検証の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"見つけたエッジ（状態別のリターン差）が『たまたま前半の期間で出ただけ』でないかを確かめる。期間を前半/後半に分け、同じ状態が後半でも同じ傾向を示すかを見る（疑似的なサンプル外検証）。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>データを前半・後半に2分割し、各々で状態別のN日先平均リターンを算出。</li>
          <li>各状態の (前半平均, 後半平均) を散布。<strong>相関</strong>が高い＝再現性が高い。対角線付近に並ぶほど安定。</li>
          <li>符号一致率＝前半後半で方向が一致した状態の割合。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>相関が高いエッジだけを実戦投入。低い/負のエッジはデータマイニングの疑い。</li>
          <li>後半で消えているエッジ＝アノマリーの賞味期限切れ。使わない。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>2分割は標本を半減させ、各推定が不安定になる。あくまで頑健性の目安。</li>
          <li>前半後半で市場レジームが違うと、エッジが消えても手法が悪いとは限らない。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
