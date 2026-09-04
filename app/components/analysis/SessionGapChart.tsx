"use client";

import { DirectionGlyph, directionClass } from "./DirectionValue";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  buildGapDays,
  weekdayStrip,
  gapSummary,
  metricOf,
  CONTEXT_META,
  CONTEXT_ORDER,
  METRICS,
  WD_LABELS,
  type GapContext,
  type Metric,
} from "../../lib/session-gap";
import AnalysisGuide from "./AnalysisGuide";
import AccessibleCanvas from "./AccessibleCanvas";
import StrategyVsBenchmark from "./StrategyVsBenchmark";
import { countRoundTrips } from "../../lib/strategy-vs-benchmark";
import { representativeSpread } from "../../lib/spread-estimator";
import { CHART_COLORS } from "../../lib/chart-colors";

interface Props {
  prices: PricePoint[];
}

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

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

type Mode = "weekday" | "context";

export default function SessionGapChart({ prices }: Props) {
  const stripRef = useRef<HTMLCanvasElement>(null);
  const matrixRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<Mode>("weekday");
  const [metric, setMetric] = useState<Metric>("gap");

  const [stratCtx, setStratCtx] = useState<GapContext | "all">("postBreak");

  const days = useMemo(() => buildGapDays(prices), [prices]);
  const strip = useMemo(() => weekdayStrip(days, metric), [days, metric]);
  const summary = useMemo(() => gapSummary(days, metric), [days, metric]);

  // 「選んだ休場コンテキストの日だけ、選んだ区間を建てる」戦略。
  // 区間（夜間/日中/当日）は日ごとに独立に建てて畳むので、選択日1日＝1往復。
  // metricOf は単利なので対数に直して共通層に渡す（cost は対数空間で厳密に効く）。
  const gapStrategy = useMemo(() => {
    const toLog = (r: number) => (Number.isFinite(r) && r > -1 ? Math.log(1 + r) : 0);
    const mask = days.map((d) => stratCtx === "all" || d.context === stratCtx);
    const strategyDaily = days.map((d, i) => (mask[i] ? toLog(metricOf(d, metric)) : 0));
    const buyHoldDaily = days.map((d) => toLog(d.fullday));
    return {
      strategyDaily,
      buyHoldDaily,
      roundTrips: countRoundTrips(mask, false),
      nSel: mask.filter(Boolean).length,
    };
  }, [days, metric, stratCtx]);
  const spreadRT = useMemo(() => (prices.length === 0 ? 0 : representativeSpread(prices)), [prices]);

  // 決定論的ジッター（点が完全に重ならないよう横方向に散らす）
  const jitter = (i: number) => {
    const x = Math.sin(i * 12.9898) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1; // -1..1
  };

  // ストリップ描画
  const stripDescription = useMemo(() => {
    if (days.length === 0) return "曜日×休場コンテキストの散布図。標本が不足しています。";
    return `各立会日を曜日（横軸）ごとに縦に並べ、休場コンテキスト（連休明け・連休前・挟まれ）で色分けした散布図。全${days.length}日の無条件平均は${(summary.baselineMean * 100).toFixed(3)}%（勝率${(summary.baselineWin * 100).toFixed(0)}%、n=${summary.baselineN}）です。`;
  }, [days, summary]);

  const matrixDescription = useMemo(() => {
    if (summary.matrix.length === 0) return "曜日×休場コンテキストのヒートマップ。標本が不足しています。";
    const live = summary.matrix.filter((c) => c.n > 0);
    if (live.length === 0) return "曜日×休場コンテキストのヒートマップ。標本が不足しています。";
    const hi = live.reduce((a, b) => (b.mean > a.mean ? b : a));
    const lo = live.reduce((a, b) => (b.mean < a.mean ? b : a));
    return `曜日（横）×休場コンテキスト（縦）のヒートマップ。無条件平均${(summary.baselineMean * 100).toFixed(3)}%に対し、最も高いセルは${(hi.mean * 100).toFixed(3)}%（n=${hi.n}）、最も低いセルは${(lo.mean * 100).toFixed(3)}%（n=${lo.n}）です。`;
  }, [summary]);

  useEffect(() => {
    if (mode !== "weekday" || !stripRef.current || days.length === 0) return;
    const H = 360;
    const init = initCanvas(stripRef.current, H);
    if (!init) return;
    const { ctx, width } = init;
    const ml = 50, mr = 14, mt = 24, mb = 34;
    const plotW = width - ml - mr, plotH = H - mt - mb;
    const zeroY = mt + plotH / 2;
    const maxAbs = strip.maxAbs;
    const yOf = (v: number) => {
      const cl = Math.max(-maxAbs, Math.min(maxAbs, v));
      return zeroY - (cl / maxAbs) * (plotH / 2 - 4);
    };
    // 軸
    ctx.strokeStyle = "#d1d5db"; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(ml, zeroY); ctx.lineTo(ml + plotW, zeroY); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = CHART_COLORS.ink; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(`+${(maxAbs * 100).toFixed(1)}%`, ml - 6, mt + 8);
    ctx.fillText("0", ml - 6, zeroY + 3);
    ctx.fillText(`-${(maxAbs * 100).toFixed(1)}%`, ml - 6, mt + plotH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("曜日別 値動き散布（休場コンテキストで色分け）", ml, 14);

    const dows = [1, 2, 3, 4, 5];
    const slot = plotW / dows.length;
    const half = slot * 0.34;

    // 各曜日: 通常を先に薄く、特殊コンテキストを上に濃く
    dows.forEach((dow, di) => {
      const cx = ml + di * slot + slot / 2;
      const colDays = strip.days.filter((d) => d.dow === dow);
      const drawOrder: GapContext[] = ["normal", "preBreak", "postBreak", "sandwiched"];
      for (const ctx0 of drawOrder) {
        const meta = CONTEXT_META[ctx0];
        const special = ctx0 !== "normal";
        ctx.fillStyle = special ? meta.color : "rgba(156,163,175,0.45)";
        for (const d of colDays) {
          if (d.context !== ctx0) continue;
          const v = metricOf(d, metric);
          const x = cx + jitter(d.i) * half;
          const y = yOf(v);
          const r = special ? 2.6 : 1.6;
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }
      }
      // コンテキスト別 平均ティック
      for (const ctx0 of CONTEXT_ORDER) {
        const cm = strip.cellMean.get(`${dow}|${ctx0}`);
        if (!cm || cm.n < 3) continue;
        const y = yOf(cm.mean);
        ctx.strokeStyle = CONTEXT_META[ctx0].color;
        ctx.lineWidth = ctx0 === "normal" ? 1.5 : 2.5;
        ctx.beginPath(); ctx.moveTo(cx - half, y); ctx.lineTo(cx + half, y); ctx.stroke();
      }
      ctx.lineWidth = 1;
      ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(`${WD_LABELS[dow]}`, cx, mt + plotH + 16);
    });

    // 凡例
    ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    let lx = ml;
    for (const c of CONTEXT_ORDER) {
      const meta = CONTEXT_META[c];
      ctx.fillStyle = meta.color;
      ctx.beginPath(); ctx.arc(lx + 4, H - 8, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#6b7280";
      ctx.fillText(meta.label, lx + 10, H - 5);
      lx += 14 + ctx.measureText(meta.label).width + 14;
    }
  }, [mode, strip, days, metric]);

  // 行列ヒートマップ描画
  useEffect(() => {
    if (mode !== "context" || !matrixRef.current) return;
    const rows: GapContext[] = ["postBreak", "preBreak", "sandwiched"];
    const H = 30 + rows.length * 40 + 24;
    const init = initCanvas(matrixRef.current, H);
    if (!init) return;
    const { ctx, width } = init;
    const ml = 86, mr = 14, mt = 24, mb = 24;
    const dows = [1, 2, 3, 4, 5];
    const cellW = (width - ml - mr) / dows.length;
    const cellH = (H - mt - mb) / rows.length;
    const maxAbs = summary.maxAbsMatrix;
    const colorFor = (v: number) => {
      const t = Math.max(-1, Math.min(1, v / maxAbs));
      if (t >= 0) return `rgba(22,163,74,${0.12 + 0.78 * t})`;
      return `rgba(220,38,38,${0.12 + 0.78 * -t})`;
    };
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("曜日 × 休場コンテキスト 平均リターン（★=同曜日の通常日と有意差）", ml - 0, 14);

    dows.forEach((dow, di) => {
      ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(WD_LABELS[dow], ml + di * cellW + cellW / 2, mt - 6);
    });
    rows.forEach((rc, ri) => {
      ctx.fillStyle = CONTEXT_META[rc].color; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(CONTEXT_META[rc].label, ml - 6, mt + ri * cellH + cellH / 2 + 3);
      dows.forEach((dow, di) => {
        const cell = summary.matrix.find((c) => c.dow === dow && c.context === rc);
        const x = ml + di * cellW, y = mt + ri * cellH;
        ctx.fillStyle = cell ? colorFor(cell.mean) : "#f3f4f6";
        ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
        if (cell) {
          ctx.fillStyle = "#111827"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
          ctx.fillText(`${(cell.mean * 100).toFixed(2)}%`, x + cellW / 2, y + cellH / 2 - 1);
          ctx.fillStyle = "#6b7280"; ctx.font = "8px sans-serif";
          ctx.fillText(`n=${cell.n}${cell.significant ? " ★" : ""}`, x + cellW / 2, y + cellH / 2 + 11);
        }
      });
    });
  }, [mode, summary]);

  if (prices.length < 120 || days.length === 0) return null;

  const today = summary.today;
  const todayMeta = today ? CONTEXT_META[today.context] : null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">休場コンテキスト別 曜日値動き（連休・祝日の歪み検出）</h3>
        <div className="flex gap-1 text-xs">
          {(["weekday", "context"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`px-2 py-0.5 rounded ${mode === m ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>
              {m === "weekday" ? "曜日×色分け散布" : "コンテキスト検定"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-gray-500">指標:</span>
        {METRICS.map((mt) => (
          <button key={mt.value} onClick={() => setMetric(mt.value)} title={mt.desc}
            className={`px-2 py-0.5 rounded ${metric === mt.value ? "bg-gray-800 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>
            {mt.label}
          </button>
        ))}
      </div>

      {today && todayMeta && (
        <div className="text-xs rounded px-2 py-1 border" style={{ borderColor: todayMeta.color, color: todayMeta.color, background: `${todayMeta.color}10` }}>
          直近データ（{today.date}・{WD_LABELS[today.dow]}曜）の文脈: <b>{todayMeta.label}</b>
          {today.context !== "normal" && `（前ギャップ${today.gapPrev}日 / 後ギャップ${today.gapNext}日）`}
          ｜{METRICS.find((m) => m.value === metric)?.label}={fmtPct(metricOf(today, metric))}
        </div>
      )}

      {mode === "weekday" && (
        <>
          <div className="relative"><AccessibleCanvas ref={stripRef} description={stripDescription} /></div>
          <p className="text-xs text-gray-500">
            {"各点が1日の値動き。灰=通常日、それ以外は連休・祝日に隣接した日。太い横線が各コンテキストの平均。色付きの点・線が灰色の雲から外れていれば、その曜日は前後の休場で普段と違う動きをしている。"}
          </p>
        </>
      )}

      {mode === "context" && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-gray-500 border-b">
                  <th className="text-left py-1 pr-2">コンテキスト</th>
                  <th className="text-right px-2">n</th>
                  <th className="text-right px-2">平均</th>
                  <th className="text-right px-2">通常との差</th>
                  <th className="text-right px-2">勝率</th>
                  <th className="text-right px-2">95%CI</th>
                  <th className="text-right px-2">安定度</th>
                  <th className="text-right pl-2">p(対通常)</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b text-gray-600">
                  <td className="py-1 pr-2 font-medium" style={{ color: CONTEXT_META.normal.color }}>通常日（基準）</td>
                  <td className="text-right px-2">{summary.baselineN}</td>
                  <td className="text-right px-2">{fmtPct(summary.baselineMean)}</td>
                  <td className="text-right px-2">—</td>
                  <td className="text-right px-2">{(summary.baselineWin * 100).toFixed(0)}%</td>
                  <td className="text-right px-2">—</td>
                  <td className="text-right px-2">—</td>
                  <td className="text-right pl-2">—</td>
                </tr>
                {summary.contexts.map((c) => (
                  <tr key={c.context} className="border-b">
                    <td className="py-1 pr-2 font-medium" style={{ color: CONTEXT_META[c.context].color }}>{CONTEXT_META[c.context].label}</td>
                    <td className="text-right px-2">{c.n}</td>
                    <td className="text-right px-2">{fmtPct(c.mean)}</td>
                    <td className={`text-right px-2 font-medium ${directionClass(c.diffVsNormal)}`}><DirectionGlyph value={c.diffVsNormal} />{fmtPct(c.diffVsNormal)}</td>
                    <td className="text-right px-2">{(c.win * 100).toFixed(0)}%</td>
                    <td className="text-right px-2 text-gray-500">{fmtPct(c.ciLo)}〜{fmtPct(c.ciHi)}</td>
                    <td className="text-right px-2 text-gray-500">{(c.stable * 100).toFixed(0)}%</td>
                    <td className={`text-right pl-2 ${c.significant ? "font-bold text-blue-700" : "text-fg-muted"}`}>{c.pVsNormal.toFixed(3)}{c.significant ? " ★" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="relative"><AccessibleCanvas ref={matrixRef} description={matrixDescription} /></div>
          {summary.contexts.length === 0 && (
            <p className="text-xs text-amber-600">{"標本が少なく、連休前後の日を十分に集計できません（より長い期間を選択してください）。"}</p>
          )}
        </>
      )}

      {/* 文脈別セグメント戦略を B&H と比較（選択日1日＝1往復でコストを実額控除） */}
      {days.length > 0 && (
        <div className="pt-2 border-t border-gray-100 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h4 className="text-sm font-medium text-gray-700">
              文脈別セグメント戦略 vs バイ&ホールド（
              {stratCtx === "all" ? "全営業日" : CONTEXT_META[stratCtx].label}の
              {METRICS.find((m) => m.value === metric)?.label}だけ建てる・n={gapStrategy.nSel}）
            </h4>
            <select
              value={stratCtx}
              onChange={(e) => setStratCtx(e.target.value as GapContext | "all")}
              className="text-xs px-2 py-1 border border-gray-200 rounded bg-white"
            >
              <option value="all">全営業日</option>
              {CONTEXT_ORDER.map((c) => (
                <option key={c} value={c}>
                  {CONTEXT_META[c].label}
                </option>
              ))}
            </select>
          </div>
          <StrategyVsBenchmark
            strategyDaily={gapStrategy.strategyDaily}
            buyHoldDaily={gapStrategy.buyHoldDaily}
            roundTrips={gapStrategy.roundTrips}
            spreadRT={spreadRT}
            label="文脈別セグメント"
          />
        </div>
      )}

      <AnalysisGuide title="休場コンテキスト別 曜日分析の詳細理論">
        <p className="font-medium text-gray-700">1. なぜこの分析が必要か</p>
        <p>{"単純に曜日（月〜金）で値動きを分けると、前後の市場の開閉に動きが歪む。月曜は常に土日の2日分の窓を跨ぐが、月曜が祝日なら火曜が『実質月曜』として大きなギャップを引き受ける。逆に金曜が祝日なら、木曜が『実質金曜』として週末（連休）の持ち越しリスクを避けた手仕舞い売りを浴びやすい。曜日ラベルだけではこれらが通常日に混ざってしまい、本当の曜日効果が見えなくなる。"}</p>

        <p className="font-medium text-gray-700 mt-3">2. 休場コンテキストの定義（数式）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>前ギャップ <code>gapPrev</code> = 前立会日からの暦日数、後ギャップ <code>gapNext</code> = 翌立会日までの暦日数。</li>
          <li>その曜日の正常ギャップ: <code>normalPrev = (月曜なら3, それ以外1)</code>、<code>normalNext = (金曜なら3, それ以外1)</code>。週末ぶんを織り込んだ基準。</li>
          <li>超過: <code>excessPrev = gapPrev − normalPrev</code>、<code>excessNext = gapNext − normalNext</code>。</li>
          <li>分類: <code>excessPrev{">"}0</code> → <b>連休明け</b>、<code>excessNext{">"}0</code> → <b>連休前</b>、両方 → <b>連休はさみ（孤立立会）</b>、どちらも0 → <b>通常日</b>。</li>
          <li>例: 月曜が祝日 → 火曜は前立会日が金曜なので gapPrev=4、normalPrev(火)=1 → excessPrev=3 → 連休明け。金曜が祝日 → 木曜は翌立会日が月曜なので gapNext=4、normalNext(木)=1 → excessNext=3 → 連休前。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 直感的な例え</p>
        <p>{"『正常ギャップ』は通勤時間の平年並み。月曜の3日ギャップは“月曜はいつも遠回り”という織り込み済みの距離で、超過0。祝日で道がさらに塞がれた分（超過ギャップ）だけを『今日は普段と違う』と色を変えて浮かび上がらせる。"}</p>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>曜日×色分け散布</b>: 各点が1日。灰の雲が通常日。色付きの点（赤=連休明け/青=連休前/紫=孤立）が灰の雲から上下に外れ、太い横線（コンテキスト平均）がずれていれば、その曜日は休場の前後で普段と違う動きをしている。</li>
          <li><b>コンテキスト検定</b>: 連休明け/連休前/孤立の平均が通常日とどれだけ違うか。p(対通常)は順列検定をFDR補正した値で、★なら偶然では説明しにくい差。安定度はブートストラップで符号が保たれた割合。</li>
          <li>行列ヒートマップ: 曜日ごとに、どの休場文脈が効くか。★は同曜日の通常日との有意差。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>連休前に有意なマイナス（手仕舞い売り）が出る銘柄なら、連休前日のロング持ち越しを避ける／その日に拾う候補とする。</li>
          <li>連休明けの夜間ギャップがプラスに偏るなら、連休最終立会日の引けでの持ち越しが有利な可能性。</li>
          <li>曜日アノマリーを検証する際、連休前後の日を除いた『純粋な通常日』だけで効果が残るかを確認でき、見せかけの曜日効果を排除できる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>連休前後の日は数が少なく（年に十数回）、検定力が低い。nと安定度を必ず確認する。</li>
          <li>暦日ギャップから休場を推定するため、データ欠損（取引はあったが価格が無い日）があると誤判定する。半日立会などは区別しない。</li>
          <li>上の「文脈別セグメント戦略 vs B&H」パネルで取引コストを実額控除できる（表・ヒートマップはコスト前）。区間は日ごとに建てて畳むので選択日1日＝1往復と数えており、回転率が高くコストが強く効く。</li>
          <li>ギャップは寄付の流動性が薄い時間帯に集中するため、実際の約定は推定スプレッドより不利になりやすい。パネルの数値も楽観側と考えること。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
