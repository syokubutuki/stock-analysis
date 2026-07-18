"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  buildEventStateFn,
  eventCatalog,
  EVENT_PROVENANCE,
  Region,
} from "../../lib/event-calendar";
import { conditionalForwardReturns, ForwardResult } from "../../lib/conditional-forward-returns";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const CATALOG = eventCatalog();

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

function drawBars(ctx: CanvasRenderingContext2D, width: number, height: number, r: ForwardResult) {
  const ml = 8;
  const mr = 8;
  const mt = 28;
  const mb = 46;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;
  const n = r.buckets.length;
  if (n === 0) return;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`イベント反応日の${r.horizon}日先リターン（点線=全体平均）`, ml, 14);

  const vals = r.buckets.map((b) => b.meanFwd);
  const maxAbs = Math.max(1e-9, r.baselineMean, ...vals.map((v) => Math.abs(v)));
  const zeroY = mt + plotH / 2;
  const scale = plotH / 2 / maxAbs;

  // 全体平均の点線
  const baseY = zeroY - r.baselineMean * scale;
  ctx.strokeStyle = "#9ca3af";
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(ml, baseY);
  ctx.lineTo(ml + plotW, baseY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = "#d1d5db";
  ctx.beginPath();
  ctx.moveTo(ml, zeroY);
  ctx.lineTo(ml + plotW, zeroY);
  ctx.stroke();

  const slot = plotW / n;
  const bw = Math.min(48, slot * 0.6);
  r.buckets.forEach((b, i) => {
    const cx = ml + slot * (i + 0.5);
    const h = b.meanFwd * scale;
    const up = b.meanFwd >= 0;
    ctx.fillStyle = b.significant
      ? up
        ? "rgba(22,163,74,0.85)"
        : "rgba(220,38,38,0.85)"
      : up
        ? "rgba(22,163,74,0.4)"
        : "rgba(220,38,38,0.4)";
    if (up) ctx.fillRect(cx - bw / 2, zeroY - h, bw, h);
    else ctx.fillRect(cx - bw / 2, zeroY, bw, -h);

    ctx.fillStyle = "#374151";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(pct(b.meanFwd), cx, up ? zeroY - h - 4 : zeroY - h + 12);

    // ラベル（短縮）
    ctx.fillStyle = "#6b7280";
    ctx.font = "9px sans-serif";
    const short = b.label.split("（")[0];
    ctx.save();
    ctx.translate(cx, mt + plotH + 6);
    ctx.rotate(-Math.PI / 9);
    ctx.textAlign = "right";
    ctx.fillText(short, 0, 0);
    ctx.fillText(`n=${b.n}`, 6, 12);
    ctx.restore();
  });
}

export default function EventCalendarChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [market, setMarket] = useState<Region>("JP");
  const [horizon, setHorizon] = useState(3);
  const [entry, setEntry] = useState<"close" | "open">("close");
  const [selected, setSelected] = useState<string[]>(CATALOG.map((e) => e.id));

  const result = useMemo(() => {
    if (prices.length < 200 || selected.length === 0) return null;
    const state = buildEventStateFn(prices, { market, selected });
    return conditionalForwardReturns(prices, state, horizon, { entry });
  }, [prices, market, selected, horizon, entry]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result || result.buckets.length === 0) return;
    const init = initCanvas(canvas, 220);
    if (!init) return;
    drawBars(init.ctx, init.width, init.height, result);
  }, [result]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const anySig = result?.buckets.some((b) => b.significant) ?? false;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-800">
          イベントカレンダー条件付け：FOMC・CPI・雇用統計・日銀・SQ の先行きリターン
        </h3>
        <span className="text-[10px] text-gray-400">曜日という代理変数ではなく、実イベント日で層別</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-gray-500">この銘柄の市場</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={market}
            onChange={(e) => setMarket(e.target.value as Region)}
          >
            <option value="JP">日本株（米国イベントは翌営業日反応）</option>
            <option value="US">米国株（当日反応）</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">先行き日数</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
          >
            {[1, 2, 3, 5, 10].map((h) => (
              <option key={h} value={h}>
                {h}日
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">建て</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={entry}
            onChange={(e) => setEntry(e.target.value as "close" | "open")}
          >
            <option value="close">反応日 終値</option>
            <option value="open">反応日 翌始値</option>
          </select>
        </label>
      </div>

      {/* イベント選択 */}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {CATALOG.map((e) => (
          <label key={e.id} className="flex items-center gap-1 text-gray-600">
            <input type="checkbox" checked={selected.includes(e.id)} onChange={() => toggle(e.id)} />
            {e.label.split("（")[0]}
            <span className="text-[9px] text-gray-400">[{EVENT_PROVENANCE[e.id]}]</span>
          </label>
        ))}
      </div>

      {result && result.buckets.length > 0 ? (
        <>
          <div
            className={`mt-3 rounded p-2.5 text-xs border ${
              anySig ? "bg-green-50 border-green-200 text-green-900" : "bg-gray-50 border-gray-200 text-gray-700"
            }`}
          >
            {anySig
              ? "FDR補正後も有意なイベント効果があります（★の行）。多重比較を通過した候補です。"
              : "FDR補正後に有意なイベント効果はありません。単一銘柄では検出力が足りない可能性が高く、示唆的な行はクロスセクション（/portfolio）でプールして確認してください。"}
            {" "}全体平均（baseline）= {pct(result.baselineMean)}／勝率 {(result.baselineWin * 100).toFixed(0)}%。
          </div>

          <div className="mt-3">
            <canvas ref={canvasRef} />
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 pr-2 font-medium">イベント反応日</th>
                  <th className="text-right py-1 px-2 font-medium">n</th>
                  <th className="text-right py-1 px-2 font-medium">μ先行き</th>
                  <th className="text-right py-1 px-2 font-medium">対baseline</th>
                  <th className="text-right py-1 px-2 font-medium">勝率</th>
                  <th className="text-right py-1 px-2 font-medium">95%CI</th>
                  <th className="text-right py-1 pl-2 font-medium">p(FDR)</th>
                </tr>
              </thead>
              <tbody>
                {result.buckets.map((b) => {
                  const excess = b.meanFwd - result.baselineMean;
                  return (
                    <tr key={b.label} className={`border-b border-gray-100 ${b.significant ? "bg-green-50/50" : ""}`}>
                      <td className="py-1 pr-2 text-gray-700">
                        {b.significant && "★ "}
                        {b.label}
                      </td>
                      <td className="py-1 px-2 text-right text-gray-500">{b.n}</td>
                      <td className="py-1 px-2 text-right font-medium text-gray-900">{pct(b.meanFwd)}</td>
                      <td className={`py-1 px-2 text-right ${excess >= 0 ? "text-green-700" : "text-red-700"}`}>
                        {excess >= 0 ? "+" : ""}
                        {pct(excess)}
                      </td>
                      <td className="py-1 px-2 text-right text-gray-600">{(b.winRate * 100).toFixed(0)}%</td>
                      <td className="py-1 px-2 text-right text-gray-500">
                        [{pct(b.ciLow)}, {pct(b.ciHigh)}]
                      </td>
                      <td
                        className={`py-1 pl-2 text-right font-medium ${
                          b.significant ? "text-green-700" : "text-gray-400"
                        }`}
                      >
                        {b.p.toFixed(3)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="mt-3 rounded p-2.5 text-xs bg-gray-50 border border-gray-200 text-gray-600">
          イベントを1つ以上選び、200本以上のデータが必要です。
        </div>
      )}

      <AnalysisGuide title="イベントカレンダー条件付けの詳細理論">
        <p className="font-medium text-gray-700">1. なぜイベント日で条件付けるか</p>
        <p>
          曜日効果は、本質的に<b>イベント日程のノイズの多い代理変数</b>にすぎません。「月曜が弱い」の
          正体が「週末にFOMCや週明けの米国指標が反映されるから」なら、曜日ではなく
          <b>FOMC・CPI・雇用統計・日銀・SQ という本体</b>を直接見るべきです。この分析は、各営業日を
          「どのイベントの反応日か」で層別し、その先の数日リターンを全体平均（baseline）と比べます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 反応日と時差の扱い</p>
        <p>
          米国イベント（FOMC/CPI/雇用統計）は日本時間の夜に出るため、日本株が反応するのは
          <b>イベント日の翌営業日</b>です。米国株なら当日。そこで「この銘柄の市場」の設定と各イベントの
          発生市場（日米）が一致するかで反応日を切り替えます：
        </p>
        <p className="pl-2">{"同一市場 → 反応日 = イベント日以降で最初の営業日（当日反応）"}</p>
        <p className="pl-2">{"異なる市場 → 反応日 = イベント日より後で最初の営業日（翌営業日反応）"}</p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>先行きリターン（forward return）</b>：反応日の終値（または翌始値）で建て、h日後に手仕舞ったときのリターン。</li>
          <li><b>baseline（全体平均）</b>：全営業日から測った同じh日先リターンの平均。イベント効果はこれとの差で読む。</li>
          <li><b>FDR補正</b>：複数イベントを同時に検定するので、Benjamini–Hochberg法で偽発見率を抑えたp値。</li>
          <li><b>SQ</b>：株価指数先物・オプションの特別清算指数算出日（毎月第2金曜、3/6/9/12月がメジャーSQ）。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>「対baseline」列</b>が、そのイベントの上乗せ（または剥落）。符号と大きさを見る。</li>
          <li><b>p(FDR) と ★</b>：多重比較を通過して初めて「発見」。★が無ければ、示唆にとどめる。</li>
          <li><b>単一銘柄で有意が出にくいのは正常</b>です。イベントは年8〜12回しかなく、10年でも n≈80〜120。検出力が足りません。</li>
          <li>示唆的な行（例: 日銀日が弱い、SQが強い）は、<b>クロスセクション（/portfolio）でプール</b>して確認するのが筋です。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>イベント前後のポジション調整</b>：有意に負のイベント（例: 特定銘柄の日銀日）があれば、その前に建玉を落とす根拠になる。</li>
          <li><b>曜日戦略の再解釈</b>：曜日エッジが特定イベント日に集中しているなら、それは曜日ではなくイベントのエッジ。イベントで直接組むほうが素直。</li>
          <li><b>スピルオーバーの確認</b>：日本株での「米CPI翌日」の符号は、前夜米国スピルオーバー分析と突き合わせられる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界（データ出所）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>日程データの出所</b>：雇用統計（毎月第1金曜）とSQ（第2金曜）は<b>暦規則で厳密生成</b>しており正確です。
            一方 <b>FOMC・CPI・日銀は静的な日付表（best-effort）</b>で、抜けや数日のずれの可能性があります
            （各行のタグ [静的表/暦規則] を参照）。反応日は「イベント日以降/以後の最初の営業日」に丸めるため、
            休日ずれや軽微な誤差は<b>ノイズとして減衰し、偽のエッジは作りません</b>（検出力が落ちるだけ）。
          </li>
          <li>正確を期すなら、静的表の日付を公式スケジュール（FRB/BLS/日銀）で更新してください。</li>
          <li>
            <b>イベントの重なり</b>：同じ営業日に複数イベントが当たる場合、選択順で先勝ちの1つに割り当てます
            （二重計上は避けるが、交絡は残る）。
          </li>
          <li><b>コスト控除前・イベント時刻の粒度は日足</b>。日中のイベント直後の値動きは日足では捉えきれません。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
