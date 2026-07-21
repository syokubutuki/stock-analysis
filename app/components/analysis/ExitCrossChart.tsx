"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  computeExitCross,
  TickerPrices,
  ExitCrossResult,
  DayCell,
  exitDayLabel,
} from "../../lib/exit-cross";
import { ExitSide, EntryTiming } from "../../lib/optimal-exit";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  tickers: string[];
  pricesByTicker: Record<string, PricePoint[]>;
  names?: Record<string, string>;
}

const bp = (v: number) => `${(v * 10000).toFixed(1)}bp`;

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

function drawBars(ctx: CanvasRenderingContext2D, width: number, height: number, r: ExitCrossResult) {
  const ml = 40;
  const mr = 12;
  const mt = 28;
  const mb = 38;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;
  const n = r.byDay.length;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("建てからh日目の引けで降りる → 横断プールの年率Sharpe（破線=金曜保持）", ml - 32, 14);

  const sharpes = r.byDay.map((c) => c.sharpe);
  const maxAbs = Math.max(0.3, ...sharpes.map((v) => Math.abs(v)), Math.abs(r.hold.sharpe));
  const zeroY = mt + plotH / 2;
  const scale = plotH / 2 / maxAbs;

  ctx.strokeStyle = "#d1d5db";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ml, zeroY);
  ctx.lineTo(ml + plotW, zeroY);
  ctx.stroke();

  const slot = plotW / n;
  const bw = Math.min(54, slot * 0.55);
  r.byDay.forEach((c, i) => {
    const cx = ml + slot * (i + 0.5);
    const h = c.sharpe * scale;
    const isBest = c.day === r.bestDay;
    const up = c.sharpe >= 0;
    ctx.fillStyle = isBest ? "rgba(37,99,235,0.85)" : up ? "rgba(37,99,235,0.4)" : "rgba(220,38,38,0.4)";
    if (up) ctx.fillRect(cx - bw / 2, zeroY - h, bw, h);
    else ctx.fillRect(cx - bw / 2, zeroY, bw, -h);
    ctx.fillStyle = "#374151";
    ctx.font = `${isBest ? "bold " : ""}10px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(c.sharpe.toFixed(2), cx, up ? zeroY - h - 4 : zeroY - h + 12);
    ctx.fillStyle = "#6b7280";
    ctx.font = "9px sans-serif";
    ctx.fillText(exitDayLabel(c.day), cx, mt + plotH + 13);
    ctx.fillText(`t=${c.t.toFixed(1)}`, cx, mt + plotH + 24);
  });

  const y = zeroY - r.hold.sharpe * scale;
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = "#6b7280";
  ctx.beginPath();
  ctx.moveTo(ml, y);
  ctx.lineTo(ml + plotW, y);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = "#6b7280";
  ctx.font = "8px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(`金曜保持 ${r.hold.sharpe.toFixed(2)}`, ml + plotW, y - 2);
}

function dayRow(c: DayCell, best: boolean) {
  return (
    <tr key={c.day} className={`border-b border-gray-100 ${best ? "bg-blue-50/60" : ""}`}>
      <td className="py-1 pr-2 text-gray-700">
        {best && "★ "}
        {exitDayLabel(c.day)}
      </td>
      <td className="py-1 px-2 text-right font-medium text-gray-900">{bp(c.mean)}</td>
      <td className="py-1 px-2 text-right text-gray-500">±{bp(c.se)}</td>
      <td className={`py-1 px-2 text-right font-medium ${Math.abs(c.t) >= 1.96 ? "text-blue-700" : "text-gray-400"}`}>
        {c.t.toFixed(2)}
      </td>
      <td className="py-1 px-2 text-right text-gray-700">{c.sharpe.toFixed(2)}</td>
      <td className="py-1 px-2 text-right text-gray-600">{(c.winRate * 100).toFixed(0)}%</td>
      <td className="py-1 pl-2 text-right text-gray-500">{Math.round(c.nEff)}</td>
    </tr>
  );
}

export default function ExitCrossChart({ tickers, pricesByTicker, names }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [side, setSide] = useState<ExitSide>("long");
  const [entryTiming, setEntryTiming] = useState<EntryTiming>("open");

  const result = useMemo(() => {
    const stocks: TickerPrices[] = tickers
      .map((t) => ({ ticker: t, name: names?.[t] ?? t, prices: pricesByTicker[t] ?? [] }))
      .filter((s) => s.prices.length > 0);
    return computeExitCross(stocks, { side, entryTiming, entryDow: 1 });
  }, [tickers, pricesByTicker, names, side, entryTiming]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result.ok) return;
    const init = initCanvas(canvas, 190);
    if (!init) return;
    drawBars(init.ctx, init.width, init.height, result);
  }, [result]);

  if (!result.ok) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="text-xs text-gray-500">曜日固定エグジット横断：{result.reason ?? "データ待ち"}</div>
      </div>
    );
  }

  const best = result.byDay[result.bestDay - 1];
  const beatsHold = best.sharpe > result.hold.sharpe + 1e-9;
  // 銘柄別の最良日分布
  const dist = new Map<number, number>();
  for (const p of result.perTicker) dist.set(p.bestDay, (dist.get(p.bestDay) ?? 0) + 1);
  const beatOwnHold = result.perTicker.filter((p) => p.bestSharpe > p.holdSharpe + 1e-9).length;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-800">
          曜日固定エグジット 横断：月曜Open建玉 → 週内どこで降りるのが最良か
        </h3>
        <span className="text-[10px] text-gray-400">
          {result.nTickers}銘柄プール / 同一週=1クラスタのクラスタ頑健SE / {result.from}〜{result.to}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-gray-500">方向</span>
          <select className="border border-gray-200 rounded px-1 py-0.5" value={side} onChange={(e) => setSide(e.target.value as ExitSide)}>
            <option value="long">買い（ロング）</option>
            <option value="short">売り（ショート）</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">建て</span>
          <select className="border border-gray-200 rounded px-1 py-0.5" value={entryTiming} onChange={(e) => setEntryTiming(e.target.value as EntryTiming)}>
            <option value="open">月曜 始値</option>
            <option value="close">月曜 終値</option>
          </select>
        </label>
      </div>

      {/* 判定 */}
      <div
        className={`mt-3 rounded p-2.5 text-xs border ${
          beatsHold ? "bg-blue-50 border-blue-200 text-blue-900" : "bg-gray-50 border-gray-200 text-gray-700"
        }`}
      >
        <div className="font-semibold">
          横断で最良の固定エグジットは <b>{exitDayLabel(result.bestDay)}の引け</b>
          （Sharpe {best.sharpe.toFixed(2)}、μ {bp(best.mean)}、クラスタ頑健 t={best.t.toFixed(2)}）
        </div>
        <div className="mt-1 leading-relaxed">
          {beatsHold
            ? `「金曜まで持つ」（Sharpe ${result.hold.sharpe.toFixed(2)}）より、週半ばで降りるほうが横断的に効率的でした。`
            : `週半ばで降りても「金曜まで持つ」（Sharpe ${result.hold.sharpe.toFixed(2)}）を超えられませんでした。`}
          {" "}μは水〜金でほぼ頭打ちになる一方ボラは積み上がるため、後半まで持つほどSharpeが落ちるのが典型です。
          個別の最良日は銘柄でばらつくので（下の異質性表）、共通の傾向と銘柄固有性を分けて読んでください。
        </div>
      </div>

      <div className="mt-3">
        <canvas ref={canvasRef} />
      </div>

      {/* 日別テーブル */}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 pr-2 font-medium">エグジット日</th>
              <th className="text-right py-1 px-2 font-medium">μ</th>
              <th className="text-right py-1 px-2 font-medium">SE</th>
              <th className="text-right py-1 px-2 font-medium">t</th>
              <th className="text-right py-1 px-2 font-medium">Sharpe</th>
              <th className="text-right py-1 px-2 font-medium">勝率</th>
              <th className="text-right py-1 pl-2 font-medium">nEff</th>
            </tr>
          </thead>
          <tbody>
            {result.byDay.map((c) => dayRow(c, c.day === result.bestDay))}
            <tr className="border-t border-gray-300 text-gray-600">
              <td className="py-1 pr-2">金曜まで持つ（単純保持）</td>
              <td className="py-1 px-2 text-right font-medium">{bp(result.hold.mean)}</td>
              <td className="py-1 px-2 text-right">±{bp(result.hold.se)}</td>
              <td className="py-1 px-2 text-right">{result.hold.t.toFixed(2)}</td>
              <td className="py-1 px-2 text-right">{result.hold.sharpe.toFixed(2)}</td>
              <td className="py-1 px-2 text-right">{(result.hold.winRate * 100).toFixed(0)}%</td>
              <td className="py-1 pl-2 text-right">{Math.round(result.hold.nEff)}</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-1 text-[10px] text-gray-400">
          μ・SEは銘柄×週プールの平均リターンとクラスタ頑健SE（同一週=1クラスタ）。t≥1.96で有意。
          のべ {result.byDay[0]?.nObs.toLocaleString()} 観測 → 実効標本 nEff ≈ {Math.round(best.nEff).toLocaleString()}（横断相関で目減り）。
          Sharpeはプール週次の年率換算（記述用）。
        </p>
      </div>

      {/* 銘柄別の異質性 */}
      <div className="mt-3">
        <div className="text-[11px] font-medium text-gray-700">
          銘柄別の最良固定日（{beatOwnHold}/{result.perTicker.length}銘柄で「最良固定日 &gt; 自分の金曜保持」）
        </div>
        <div className="mt-1 flex flex-wrap gap-x-1 gap-y-1 text-[10px]">
          {[1, 2, 3, 4, 5].map((d) => (
            <span key={d} className="inline-flex items-center gap-1 rounded bg-gray-50 border border-gray-200 px-1.5 py-0.5">
              <b className="text-gray-700">{exitDayLabel(d)}</b>
              <span className="text-gray-400">×{dist.get(d) ?? 0}</span>
            </span>
          ))}
        </div>
        <details className="mt-1 text-[11px]">
          <summary className="cursor-pointer text-gray-500 hover:text-gray-700">銘柄ごとの内訳</summary>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {result.perTicker.map((p) => (
              <span key={p.ticker} className="text-gray-600">
                {p.name}: <b>{exitDayLabel(p.bestDay)}</b>{" "}
                <span className="text-gray-400">
                  (Sh {p.bestSharpe.toFixed(2)} / 金曜 {p.holdSharpe.toFixed(2)})
                </span>
              </span>
            ))}
          </div>
        </details>
      </div>

      <AnalysisGuide title="曜日固定エグジット横断の詳細理論">
        <p className="font-medium text-gray-700">1. 何をしているか</p>
        <p>
          単一銘柄の「週内のどこで降りるのが最良か」（個別ページの最適手仕舞い）を、
          <b>ウォッチリスト全銘柄でプール</b>したものです。各銘柄で月曜Openに建て、
          「建てから h 日目の引けで必ず降りる」戦略を h=1..5 で作り、その週次リターンを
          銘柄×週で集めて平均・Sharpeを比べます。単一銘柄では「水曜が最良」が後知恵の
          ノイズかもしれませんが、多数銘柄で共通なら構造の可能性が高まります。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 横断相関に正直な検定（クラスタ頑健SE）</p>
        <p>
          同じ週は全銘柄がまとめて動くため、「銘柄×週=独立標本」と数えると標準誤差が過小＝偽の有意に
          なります。そこで<b>「同一週=1クラスタ」</b>（週の建て日をキー）としてクラスタ頑健SEを計算し、
          <b>実効標本数 nEff</b>（独立標本換算）を出します。nObs ≫ nEff なら横断相関が強く、
          銘柄を増やしても検出力は銘柄数倍にはなりません。これが横断プールの正直な検出力です。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>Sharpeが週半ばでピーク</b>を打ち後半で落ちるなら、「平均リターンは頭打ちなのにボラだけ積み上がる」ため、早めに降りるほうが効率的という意味です。</li>
          <li><b>クラスタ頑健 t</b>：各エグジット日の平均リターンが有意に正か。t≥2 なら横断的に頑健。</li>
          <li><b>銘柄別の最良日の分布</b>：「週半ばで降りる」傾向が共通でも、最適日（火/水/木）は銘柄で異なるのが普通。共通の傾向と銘柄固有性を分けて読む。</li>
          <li><b>「最良固定日 &gt; 自分の金曜保持」の銘柄数</b>：多ければ、早降りが幅広く効く証拠。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>保有期間の既定値</b>：ウォッチリスト全体で水曜がSharpe最良なら、週内トレードの標準手仕舞いを週半ばに置く根拠になる。</li>
          <li><b>銘柄別チューニング</b>：異質性表で自分の保有銘柄の最良日を確認し、銘柄ごとに手仕舞い日を変える。</li>
          <li><b>「金曜まで持つ」の再評価</b>：週末リスクを取って金曜まで持つ意味が薄い（Sharpeが落ちる）なら、早降りは無駄なリスク削減として正当化できる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>後知恵バイアス</b>：横断の「最良日」も、その期間で最良だった日です。将来の最良日を保証しません。個別ページの状態依存・適応最適（OOS）と併せて過信を避けてください。</li>
          <li><b>クラスタは週単位</b>。銘柄内の時系列自己相関は完全には吸収しません。</li>
          <li><b>コスト控除前</b>。早降りは往復回数を増やすため、実務では手仕舞いのたびにコストが乗ります（Sharpe改善がそれを上回るか要確認）。</li>
          <li><b>同業種・高相関の銘柄ばかりだと nEff は特に小さく</b>なり、見かけの有意は割り引いて読むべきです。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
