"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  LineStyle,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import {
  Cell,
  DEFAULT_WU_PARAMS,
  DowBeta,
  FILTER_LABEL,
  FILTER_WHY,
  TARGETS,
  TARGET_META,
  Target,
  WD,
  WuOne,
  WuParams,
  WuResult,
} from "../../lib/weekday-us-interaction";
import type {
  WuWorkerRequest,
  WuWorkerResponse,
} from "../../lib/weekday-us-interaction.worker";
import { US_DRIVERS, useUsDaily } from "../../hooks/useUsDaily";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

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

const bp = (v: number) => `${v >= 0 ? "+" : ""}${(v * 10000).toFixed(1)}bp`;
const num = (v: number, d = 2) => (isFinite(v) ? v.toFixed(d) : "—");
const pStr = (p: number) => (p < 0.001 ? "<0.001" : p.toFixed(3));

// 曜日ごとの色。⑥の3ペインと年別ヒートマップで共通に使う。
const DOW_COLOR = ["#dc2626", "#ea580c", "#16a34a", "#2563eb", "#7c3aed"];

// ---------------------------------------------------------------------------
// A: 曜日別スピルオーバーβ（95%CI付き）と共通βの帯
// ---------------------------------------------------------------------------
// over のときスロットは「その曜日の引け→翌営業日の寄り」なので、金＝週末ギャップになる。
// 曜日名だけだと日中の分析と取り違えるため、表記を切り替える。
const dowName = (d: number, isOver: boolean) => (isOver ? `${WD[d]}夜` : WD[d]);

function drawBeta(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  one: WuOne,
  targetLabel: string,
  isOver: boolean,
) {
  const ml = 46;
  const mr = 14;
  const mt = 42;
  const mb = 40;
  const pw = width - ml - mr;
  const ph = height - mt - mb;

  const ds = one.dows.filter((d) => isFinite(d.beta));
  if (ds.length === 0) return;
  const pooled = one.homBeta.pooled;
  const pse = one.homBeta.pooledSe;
  const lo = Math.min(0, pooled - 2 * pse, ...ds.map((d) => d.betaLo));
  const hi = Math.max(0, pooled + 2 * pse, ...ds.map((d) => d.betaHi));
  const pad = (hi - lo) * 0.12 || 0.1;
  const yLo = lo - pad;
  const yHi = hi + pad;
  const yOf = (v: number) => mt + ph - ((v - yLo) / (yHi - yLo)) * ph;
  const bw = pw / 5;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(
    `曜日別スピルオーバーβ — ${targetLabel} を${isOver ? "当夜" : "前夜"}の米国リターンに回帰`,
    ml,
    14,
  );
  ctx.fillStyle = "#6b7280";
  ctx.font = "9px sans-serif";
  ctx.fillText(
    `縦棒=HC3の95%信頼区間 / 灰帯=5曜日共通β ${num(pooled)} ±2SE / 帯から外れた曜日が「米国の伝わり方が違う曜日」`,
    ml,
    27,
  );

  // 共通βの帯
  ctx.fillStyle = "rgba(107,114,128,0.14)";
  ctx.fillRect(ml, yOf(pooled + 2 * pse), pw, Math.abs(yOf(pooled - 2 * pse) - yOf(pooled + 2 * pse)));
  ctx.strokeStyle = "#6b7280";
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(ml, yOf(pooled));
  ctx.lineTo(ml + pw, yOf(pooled));
  ctx.stroke();
  ctx.setLineDash([]);

  // ゼロ線
  if (yLo < 0 && yHi > 0) {
    ctx.strokeStyle = "#d1d5db";
    ctx.beginPath();
    ctx.moveTo(ml, yOf(0));
    ctx.lineTo(ml + pw, yOf(0));
    ctx.stroke();
  }

  one.dows.forEach((d, i) => {
    if (!isFinite(d.beta)) return;
    const x = ml + i * bw + bw / 2;
    const outside = d.betaLo > pooled || d.betaHi < pooled;
    const color = outside ? "#dc2626" : "#2563eb";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, yOf(d.betaLo));
    ctx.lineTo(x, yOf(d.betaHi));
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 6, yOf(d.betaLo));
    ctx.lineTo(x + 6, yOf(d.betaLo));
    ctx.moveTo(x - 6, yOf(d.betaHi));
    ctx.lineTo(x + 6, yOf(d.betaHi));
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, yOf(d.beta), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = outside ? "bold 10px sans-serif" : "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(num(d.beta), x, yOf(d.betaHi) - 6);
  });

  ctx.strokeStyle = "#d1d5db";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ml, mt + ph);
  ctx.lineTo(ml + pw, mt + ph);
  ctx.stroke();

  ctx.fillStyle = "#6b7280";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  one.dows.forEach((d, i) => {
    ctx.fillText(`${dowName(d.dow, isOver)}（n=${d.n}）`, ml + i * bw + bw / 2, mt + ph + 15);
  });
  ctx.fillStyle = "#9ca3af";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = yLo + ((yHi - yLo) * i) / 4;
    ctx.fillText(num(v), ml - 5, yOf(v) + 3);
  }
  ctx.save();
  ctx.translate(12, mt + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("β（米国1%あたり）", 0, 0);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// B: 上下非対称 β⁺ / β⁻
// ---------------------------------------------------------------------------
function drawAsym(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  one: WuOne,
  isOver: boolean,
) {
  const ml = 46;
  const mr = 14;
  const mt = 42;
  const mb = 40;
  const pw = width - ml - mr;
  const ph = height - mt - mb;

  const vals: number[] = [];
  for (const d of one.dows) {
    if (isFinite(d.betaUp)) vals.push(d.betaUp + 1.96 * d.betaUpSe, d.betaUp - 1.96 * d.betaUpSe);
    if (isFinite(d.betaDn)) vals.push(d.betaDn + 1.96 * d.betaDnSe, d.betaDn - 1.96 * d.betaDnSe);
  }
  if (vals.length === 0) return;
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const pad = (hi - lo) * 0.12 || 0.1;
  const yLo = lo - pad;
  const yHi = hi + pad;
  const yOf = (v: number) => mt + ph - ((v - yLo) / (yHi - yLo)) * ph;
  const bw = pw / 5;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("上下非対称：米国が上げた夜 β⁺ / 下げた夜 β⁻", ml, 14);
  ctx.fillStyle = "#6b7280";
  ctx.font = "9px sans-serif";
  ctx.fillText(
    "同じ曜日で β⁺ と β⁻ が離れているほど「悪材料と好材料の伝わり方が違う」。曜日ごとにその差の向きが揃っているかを見る。",
    ml,
    27,
  );

  ctx.strokeStyle = "#d1d5db";
  ctx.beginPath();
  ctx.moveTo(ml, yOf(0));
  ctx.lineTo(ml + pw, yOf(0));
  ctx.stroke();

  one.dows.forEach((d, i) => {
    const x0 = ml + i * bw;
    const pairs: { v: number; se: number; c: string; dx: number }[] = [
      { v: d.betaUp, se: d.betaUpSe, c: "#2563eb", dx: bw * 0.32 },
      { v: d.betaDn, se: d.betaDnSe, c: "#dc2626", dx: bw * 0.68 },
    ];
    for (const p of pairs) {
      if (!isFinite(p.v)) continue;
      const x = x0 + p.dx;
      const y0 = yOf(0);
      const y1 = yOf(p.v);
      ctx.fillStyle = p.c + "66";
      ctx.fillRect(x - bw * 0.13, Math.min(y0, y1), bw * 0.26, Math.abs(y1 - y0));
      ctx.strokeStyle = p.c;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, yOf(p.v - 1.96 * p.se));
      ctx.lineTo(x, yOf(p.v + 1.96 * p.se));
      ctx.stroke();
      ctx.fillStyle = p.c;
      ctx.font = "9px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(num(p.v), x, yOf(p.v + 1.96 * p.se) - 4);
    }
    if (isFinite(d.asymP) && d.asymP < 0.05) {
      ctx.fillStyle = "#b45309";
      ctx.font = "bold 9px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("非対称*", x0 + bw / 2, mt + 10);
    }
  });

  ctx.strokeStyle = "#d1d5db";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ml, mt + ph);
  ctx.lineTo(ml + pw, mt + ph);
  ctx.stroke();
  ctx.fillStyle = "#6b7280";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  one.dows.forEach((d, i) =>
    ctx.fillText(dowName(d.dow, isOver), ml + i * bw + bw / 2, mt + ph + 15),
  );
  ctx.fillStyle = "#9ca3af";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = yLo + ((yHi - yLo) * i) / 4;
    ctx.fillText(num(v), ml - 5, yOf(v) + 3);
  }
  ctx.textAlign = "left";
  ctx.fillStyle = "#2563eb";
  ctx.fillText("■ β⁺（米国が上げた夜）", ml + 2, mt + ph + 30);
  ctx.fillStyle = "#dc2626";
  ctx.fillText("■ β⁻（米国が下げた夜）", ml + 130, mt + ph + 30);
}

// ---------------------------------------------------------------------------
export default function WeekdayUsInteractionChart({ prices }: Props) {
  const betaRef = useRef<HTMLCanvasElement>(null);
  const asymRef = useRef<HTMLCanvasElement>(null);
  const rollRef = useRef<HTMLDivElement>(null);
  const qRef = useRef<HTMLDivElement>(null);
  const brkRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  const [target, setTarget] = useState<Target>(DEFAULT_WU_PARAMS.target);
  const [nBins, setNBins] = useState(DEFAULT_WU_PARAMS.nBins);
  const [nIter, setNIter] = useState(DEFAULT_WU_PARAMS.nIter);
  const [costBps, setCostBps] = useState(DEFAULT_WU_PARAMS.costBps);
  const [rollWeeks, setRollWeeks] = useState(DEFAULT_WU_PARAMS.rollWeeks);
  const [usTicker, setUsTicker] = useState("^GSPC");
  const [result, setResult] = useState<WuResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const { prices: usPrices, loading: usLoading, error: usError } = useUsDaily(usTicker);

  const params: WuParams = useMemo(
    () => ({ ...DEFAULT_WU_PARAMS, target, nBins, nIter, costBps, rollWeeks }),
    [target, nBins, nIter, costBps, rollWeeks],
  );

  useEffect(() => {
    const worker = new Worker(new URL("../../lib/weekday-us-interaction.worker.ts", import.meta.url));
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<WuWorkerResponse>) => {
      if (ev.data.reqId !== reqIdRef.current) return;
      if (ev.data.progress) setProgress(ev.data.progress);
      if (ev.data.result) {
        setResult(ev.data.result);
        setLoading(false);
        setProgress(null);
      }
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || prices.length < 260 || usLoading || !usPrices) return;
    reqIdRef.current++;
    // Worker への投入という外部システムの同期に付随する進捗表示。
    setLoading(true);
    setProgress(null);
    const req: WuWorkerRequest = { reqId: reqIdRef.current, prices, usPrices, params };
    worker.postMessage(req);
  }, [prices, params, usPrices, usLoading]);

  const main = result?.ok ? result.main : null;

  useEffect(() => {
    const c = betaRef.current;
    if (!c || !main) return;
    const init = initCanvas(c, 270);
    if (init)
      drawBeta(init.ctx, init.width, init.height, main, TARGET_META[target].label, target === "over");
  }, [main, target]);

  useEffect(() => {
    const c = asymRef.current;
    if (!c || !main) return;
    const init = initCanvas(c, 270);
    if (init) drawAsym(init.ctx, init.width, init.height, main, target === "over");
  }, [main, target]);

  // ⑥ 時代依存：ローリングβ / ローリングQ / 構造変化 sup-Wald の3ペイン。
  // 横軸が日付で、期間の細部を拡大して見る価値があるので lightweight-charts を使う。
  // コンテナは result が出てから条件レンダリングされるため、依存に result を入れる。
  const era = result?.ok ? result.era : null;
  useEffect(() => {
    if (!era || !rollRef.current || !qRef.current || !brkRef.current) return;
    if (era.rolling.length < 5) return;

    const mk = (el: HTMLDivElement, height: number) =>
      createChart(el, {
        layout: { background: { color: "#ffffff" }, textColor: "#333" },
        grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f5f5f5" } },
        width: el.clientWidth,
        height,
        crosshair: { mode: 0 },
        rightPriceScale: { visible: true },
        timeScale: { timeVisible: false },
      });

    const c1 = mk(rollRef.current, 230);
    const c2 = mk(qRef.current, 130);
    const c3 = mk(brkRef.current, 130);

    // 同じ窓末日付が重複しないよう保険をかける（時刻は昇順かつ一意である必要がある）
    const seen = new Set<string>();
    const pts = era.rolling.filter((p) => {
      if (seen.has(p.date)) return false;
      seen.add(p.date);
      return true;
    });

    for (let d = 0; d < 5; d++) {
      const s = c1.addSeries(LineSeries, {
        color: DOW_COLOR[d],
        lineWidth: 2,
        title: target === "over" ? `${WD[d + 1]}夜` : `${WD[d + 1]}曜`,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      s.setData(
        pts
          .filter((p) => isFinite(p.beta[d]))
          .map((p) => ({ time: p.date as Time, value: p.beta[d] })),
      );
    }
    const pooledS = c1.addSeries(LineSeries, {
      color: "#9ca3af",
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      title: "共通β",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    pooledS.setData(
      pts.filter((p) => isFinite(p.pooled)).map((p) => ({ time: p.date as Time, value: p.pooled })),
    );

    const qs = c2.addSeries(LineSeries, {
      color: "#111827",
      lineWidth: 2,
      title: "Q（曜日差）",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    qs.setData(pts.map((p) => ({ time: p.date as Time, value: p.q })));
    qs.createPriceLine({
      price: era.chi2Crit95,
      color: "#dc2626",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "χ²(4) 95%",
    });

    if (era.brk) {
      const bs = c3.addSeries(LineSeries, {
        color: "#7c3aed",
        lineWidth: 2,
        title: "sup-Wald",
        priceLineVisible: false,
        lastValueVisible: false,
      });
      const bseen = new Set<string>();
      bs.setData(
        era.brk.grid
          .filter((g) => {
            if (bseen.has(g.date)) return false;
            bseen.add(g.date);
            return true;
          })
          .map((g) => ({ time: g.date as Time, value: g.w })),
      );
      bs.createPriceLine({
        price: era.brk.crit95,
        color: "#dc2626",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "置換95%",
      });
    }

    // 時間軸の同期は「同じ x 点を持つ」β と Q のあいだだけに限る。
    // 両者は同一の窓末日付列なのでロジカル(バー番号)同期が厳密に一致する。
    // sup-Wald は x が「分割点」で意味も張る期間も違うため、独立させる
    // （異なる範囲どうしを相互に setVisibleRange すると、互いに範囲を
    //  狭め合うラチェットが起きて表示が勝手に縮んでいく）。
    const charts: IChartApi[] = [c1, c2, c3];
    for (const c of charts) c.timeScale().fitContent();
    let lock = false;
    const pair: IChartApi[] = [c1, c2];
    for (const src of pair) {
      src.timeScale().subscribeVisibleLogicalRangeChange(() => {
        if (lock) return;
        lock = true;
        const r = src.timeScale().getVisibleLogicalRange();
        if (r) for (const dst of pair) if (dst !== src) dst.timeScale().setVisibleLogicalRange(r);
        lock = false;
      });
    }

    const onResize = () => {
      if (rollRef.current) c1.applyOptions({ width: rollRef.current.clientWidth });
      if (qRef.current) c2.applyOptions({ width: qRef.current.clientWidth });
      if (brkRef.current) c3.applyOptions({ width: brkRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      for (const c of charts) c.remove();
    };
  }, [era, target]);

  // 交互作用セルの表示補助
  const binLabels = useMemo(() => {
    if (!main) return [];
    const e = main.binEdges;
    const labs: string[] = [];
    for (let b = 0; b <= e.length; b++) {
      if (b === 0) labs.push(`≤ ${(e[0] * 100).toFixed(2)}%`);
      else if (b === e.length) labs.push(`> ${(e[e.length - 1] * 100).toFixed(2)}%`);
      else labs.push(`${(e[b - 1] * 100).toFixed(2)}〜${(e[b] * 100).toFixed(2)}%`);
    }
    return labs;
  }, [main]);

  const cellAt = (one: WuOne, d: number, b: number): Cell | undefined =>
    one.cells.find((c) => c.dow === d && c.bin === b);

  const maxAbsDelta = useMemo(
    () => (main ? Math.max(1e-9, ...main.cells.map((c) => Math.abs(c.delta))) : 1),
    [main],
  );

  const survivorCells = useMemo(
    () => (main ? main.cells.filter((c) => c.pAdj < 0.05).sort((a, b) => a.pAdj - b.pAdj) : []),
    [main],
  );

  // 最も共通βから外れた曜日
  const outlier: DowBeta | null = useMemo(() => {
    if (!main) return null;
    const cand = main.dows.filter((d) => isFinite(d.beta) && d.betaSe > 0);
    if (!cand.length) return null;
    return cand.reduce((a, b) =>
      Math.abs(a.beta - main.homBeta.pooled) / a.betaSe >=
      Math.abs(b.beta - main.homBeta.pooled) / b.betaSe
        ? a
        : b,
    );
  }, [main]);

  const tm = TARGET_META[target];
  const isOver = target === "over";
  // over のスロットは「その曜日の引け→翌営業日の寄り」。金＝週末ギャップなので表記を分ける。
  const dn = (d: number) => (isOver ? `${WD[d]}夜` : `${WD[d]}曜`);
  const betaRejects = !!main && main.homBeta.pPerm < 0.05 && main.homBeta.pWald < 0.05;
  const betaSplit = !!main && main.homBeta.pPerm < 0.05 !== main.homBeta.pWald < 0.05;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-800">
          曜日 × 前夜米国：交互作用の解剖（日足・フル標本）
        </h3>
        <span className="text-[10px] text-fg-muted">
          米国の「伝わり方」が曜日で違うかを、ビンではなく連続回帰で判定する
        </span>
      </div>

      <p className="mt-2 text-[11px] text-gray-500 leading-relaxed">
        ヌル較正の解剖④「前夜米国ビンで層別」は、米国で説明できる分を実測とヌルの両方から
        消して<b>「米国を超えた曜日効果が残るか」</b>を問う操作でした。ここはその真逆で、
        <b>「曜日効果の大きさが米国の状態に依存するか」</b>を問います。 r = μ + α(曜日) + β(米国)
        + γ(交互作用) のうち、β は既知で巨大、α は解剖が検定済み。
        <b>未検証なのは γ だけ</b>です。
      </p>

      {/* 操作 */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-gray-500">目的変数</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={target}
            onChange={(e) => setTarget(e.target.value as Target)}
          >
            {TARGETS.map((t) => (
              <option key={t} value={t}>
                {TARGET_META[t].label}
                {TARGET_META[t].tradable ? "" : "（取引不可）"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">米国ビン</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={nBins}
            onChange={(e) => setNBins(Number(e.target.value))}
          >
            {[3, 5].map((v) => (
              <option key={v} value={v}>
                {v}分位
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">反復</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={nIter}
            onChange={(e) => setNIter(Number(e.target.value))}
          >
            {[500, 1000, 2000].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">ローリング窓</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={rollWeeks}
            onChange={(e) => setRollWeeks(Number(e.target.value))}
          >
            {[52, 104, 156].map((v) => (
              <option key={v} value={v}>
                {v}週（各曜日{v}本）
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">往復コスト(bps)</span>
          <input
            type="number"
            min={0}
            max={100}
            className="border border-gray-200 rounded px-1 py-0.5 w-14"
            value={costBps}
            onChange={(e) => setCostBps(Math.max(0, Number(e.target.value)))}
          />
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">米国ドライバ</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={usTicker}
            onChange={(e) => setUsTicker(e.target.value)}
          >
            {US_DRIVERS.map((d) => (
              <option key={d.ticker} value={d.ticker}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="mt-2 text-[10px] text-fg-muted leading-relaxed">
        {tm.desc}
      </p>

      {usError && (
        <div className="mt-3 rounded p-2.5 text-xs bg-amber-50 border border-amber-200 text-amber-800">
          米国指数の取得に失敗しました：{usError}
        </div>
      )}
      {loading && (
        <div className="mt-3 text-xs text-fg-muted">
          計算中…{progress ? ` ${progress.done} / ${progress.total}` : ""}
        </div>
      )}
      {result && !result.ok && (
        <div className="mt-3 rounded p-2.5 text-xs bg-gray-50 border border-gray-200 text-gray-600">
          計算できません：{result.reason}
        </div>
      )}

      {main && result?.ok && (
        <>
          {/* ---------- 判定サマリー ---------- */}
          <div
            className={`mt-3 rounded p-2.5 text-xs border ${
              betaRejects
                ? "bg-green-50 border-green-200 text-green-900"
                : betaSplit
                  ? "bg-amber-50 border-amber-200 text-amber-900"
                  : "bg-gray-50 border-gray-200 text-gray-700"
            }`}
          >
            <div className="font-semibold">
              {betaRejects
                ? "米国の伝わり方は曜日で違う — β の均一性を棄却"
                : betaSplit
                  ? "判定が割れています（置換 p と HC3 Wald p が食い違う）"
                  : "米国の伝わり方が曜日で違うとは言えません"}
            </div>
            <div className="mt-1 leading-relaxed">
              Cochran Q = {num(main.homBeta.q)}（df={main.homBeta.df}）、
              <b>置換 p = {pStr(main.homBeta.pPerm)}</b> / HC3 Wald p ={" "}
              {pStr(main.homBeta.pWald)}、I² = {(main.homBeta.i2 * 100).toFixed(0)}%。 共通β ={" "}
              {num(main.homBeta.pooled)}。
              {outlier && (
                <>
                  {" "}
                  最も外れているのは <b>{dn(outlier.dow)}</b> の β = {num(outlier.beta)}（共通βから{" "}
                  {num((outlier.beta - main.homBeta.pooled) / outlier.betaSe)}SE）。
                </>
              )}
            </div>
            {!tm.tradable && (
              <div className="mt-1.5 pt-1.5 border-t border-current/10 leading-relaxed text-[11px]">
                <b>注意：この目的変数は取引不可能です。</b>
                {target === "gap"
                  ? "ギャップの曜日差は寄り付いた時点で既に起きています。月曜がここで大きいのは62時間ぶんの情報が乗るからで、発見ではなく構造です。"
                  : "当日リターンはギャップが支配的なので、曜日差はギャップ由来になりがちです。判断は日中か夜間で行ってください。"}
              </div>
            )}
            {betaSplit && (
              <div className="mt-1.5 pt-1.5 border-t border-current/10 leading-relaxed text-[11px]">
                置換 p は「u の分布が曜日で違う」ことを均してしまい、HC3 Wald
                はレバレッジ構造をそのまま使います。両者が食い違うときは
                <b>結論を保留する</b>のが正しい扱いです。月曜だけ σ(前夜米国) が大きいことが
                原因になりやすく、下の表の σ(u) 列で確認できます。
              </div>
            )}
          </div>

          {/* ---------- ① 曜日別β ---------- */}
          <section className="mt-5">
            <h4 className="text-xs font-semibold text-gray-700">
              ① 曜日別スピルオーバーβ（本命の判定）
            </h4>
            <p className="mt-1 text-[10px] text-gray-500 leading-relaxed">
              答える問い：<b>{isOver ? "当夜" : "前夜"}の米国が1%動いたとき、日本の反応の大きさは曜日で違うか。</b>{" "}
              ビンで3値に潰さず連続量のまま扱うので、同じ標本で検出力がはるかに高くなります。
              判定はここで行い、下のヒートマップは「どのセルか」を見るための表示です。
            </p>
            <div className="mt-2">
              <canvas ref={betaRef} />
            </div>

            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 pr-2 font-medium">曜日</th>
                    <th className="text-right py-1 px-2 font-medium">n</th>
                    <th className="text-right py-1 px-2 font-medium">β</th>
                    <th className="text-right py-1 px-2 font-medium">HC3 SE</th>
                    <th className="text-right py-1 px-2 font-medium">95%CI</th>
                    <th className="text-right py-1 px-2 font-medium">共通βとの差</th>
                    <th className="text-right py-1 px-2 font-medium">
                      σ({target === "over" ? "当夜" : "前夜"}米国)
                    </th>
                    <th className="text-right py-1 px-2 font-medium">
                      {target === "over" ? "引→翌寄" : "前引→寄"} 時間
                    </th>
                    <th className="text-right py-1 px-2 font-medium">1σあたり</th>
                    <th className="text-right py-1 pl-2 font-medium">α（米国0のとき）</th>
                  </tr>
                </thead>
                <tbody>
                  {main.dows.map((d) => {
                    const z = d.betaSe > 0 ? (d.beta - main.homBeta.pooled) / d.betaSe : 0;
                    const out = Math.abs(z) > 1.96;
                    return (
                      <tr key={d.dow} className="border-b border-gray-100">
                        <td className="py-1 pr-2 text-gray-700">{dn(d.dow)}</td>
                        <td className="py-1 px-2 text-right text-gray-500">{d.n}</td>
                        <td
                          className={`py-1 px-2 text-right font-medium ${
                            out ? "text-red-700" : "text-gray-900"
                          }`}
                        >
                          {num(d.beta)}
                        </td>
                        <td className="py-1 px-2 text-right text-fg-muted">{num(d.betaSe)}</td>
                        <td className="py-1 px-2 text-right text-gray-500">
                          [{num(d.betaLo)}, {num(d.betaHi)}]
                        </td>
                        <td
                          className={`py-1 px-2 text-right ${out ? "text-red-700" : "text-gray-500"}`}
                        >
                          {num(z)}SE
                        </td>
                        <td className="py-1 px-2 text-right text-gray-500">
                          {(d.sdU * 100).toFixed(2)}%
                        </td>
                        <td
                          className={`py-1 px-2 text-right ${
                            d.meanHours > 40 ? "text-blue-700 font-medium" : "text-fg-muted"
                          }`}
                        >
                          {d.meanHours.toFixed(0)}h
                        </td>
                        <td className="py-1 px-2 text-right text-gray-700">{bp(d.impact)}</td>
                        <td className="py-1 pl-2 text-right text-gray-500">{bp(d.alpha)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-1 text-[10px] text-fg-muted leading-relaxed">
                {target === "over" ? (
                  <>
                    <b>引→翌寄 時間</b>が金曜だけ大きいのが要点です（当日引け→翌営業日寄りの平均
                    経過時間。金曜は約66時間＝週末ギャップ）。この行の β は
                    <b>「当夜の米国セッションが翌朝の寄りにどれだけ反映されたか」</b>で、
                    1 に近いほど完全反映、小さいほど反映不足（あるいは既に織り込み済み）を意味します。
                  </>
                ) : (
                  <>
                    <b>前引→寄 時間</b>が月曜だけ大きいのが、この分析の出発点です（前営業日引け→
                    当日寄りの平均経過時間。月曜は約62時間で、間に土日の情報空白を含む）。
                    <b>σ(前夜米国)</b> もそれに応じて大きくなります。
                  </>
                )}{" "}
                <b>1σあたり</b>＝β×σ(u) は「その曜日の典型的な米国変動が何bpの反応を生むか」で、
                βそのものより経済的に比較しやすい量です。 <b>α</b>{" "}
                は米国がゼロだったときの平均リターン＝米国で説明できない曜日の素の偏り （均一性:
                置換 p = {pStr(main.homAlpha.pPerm)}）。
              </p>
            </div>
          </section>

          {/* ---------- ② 上下非対称 ---------- */}
          <section className="mt-5">
            <h4 className="text-xs font-semibold text-gray-700">② 上下非対称 β⁺ / β⁻</h4>
            <p className="mt-1 text-[10px] text-gray-500 leading-relaxed">
              答える問い：<b>「米国安への反応」と「米国高への反応」の差が曜日で違うか。</b>{" "}
              実務で効くのはたいていこの形（例：月曜は米国安にだけ過剰反応する）で、
              単一のβでは平均されて消えてしまいます。
            </p>
            <div className="mt-2">
              <canvas ref={asymRef} />
            </div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 pr-2 font-medium">曜日</th>
                    <th className="text-right py-1 px-2 font-medium">β⁺（米国高）</th>
                    <th className="text-right py-1 px-2 font-medium">β⁻（米国安）</th>
                    <th className="text-right py-1 px-2 font-medium">β⁺−β⁻</th>
                    <th className="text-right py-1 pl-2 font-medium">非対称 p</th>
                  </tr>
                </thead>
                <tbody>
                  {main.dows.map((d) => (
                    <tr key={d.dow} className="border-b border-gray-100">
                      <td className="py-1 pr-2 text-gray-700">{dn(d.dow)}</td>
                      <td className="py-1 px-2 text-right text-gray-900">
                        {num(d.betaUp)}
                        <span className="text-fg-muted"> ±{num(1.96 * d.betaUpSe)}</span>
                      </td>
                      <td className="py-1 px-2 text-right text-gray-900">
                        {num(d.betaDn)}
                        <span className="text-fg-muted"> ±{num(1.96 * d.betaDnSe)}</span>
                      </td>
                      <td className="py-1 px-2 text-right text-gray-700">
                        {num(d.betaUp - d.betaDn)}
                      </td>
                      <td
                        className={`py-1 pl-2 text-right font-medium ${
                          d.asymP < 0.05 ? "text-amber-700" : "text-fg-muted"
                        }`}
                      >
                        {pStr(d.asymP)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-[10px] text-fg-muted leading-relaxed">
                <b>β⁺ の曜日均一性</b>: Q = {num(main.homBetaUp.q)}、置換 p ={" "}
                {pStr(main.homBetaUp.pPerm)} / Wald p = {pStr(main.homBetaUp.pWald)}。{" "}
                <b>β⁻ の曜日均一性</b>: Q = {num(main.homBetaDn.q)}、置換 p ={" "}
                {pStr(main.homBetaDn.pPerm)} / Wald p = {pStr(main.homBetaDn.pWald)}。
                非対称 p は同一曜日内の β⁺ と β⁻ の差に対する両側 z 検定で、
                <b>曜日をまたぐ多重性は補正していません</b>（5回の検定なので目安として 0.01
                を閾値に読んでください）。
              </p>
            </div>
          </section>

          {/* ---------- ③ 交互作用の全体検定 + セル ---------- */}
          <section className="mt-5">
            <h4 className="text-xs font-semibold text-gray-700">
              ③ 交互作用の全体検定とセル・ヒートマップ
            </h4>
            <p className="mt-1 text-[10px] text-gray-500 leading-relaxed">
              答える問い：<b>曜日×米国ビンのどのマスに構造があるか。</b>{" "}
              F_int は二重中心化した交互作用成分 γ̂ = μ̂(d,b) − 行平均 − 列平均 + 総平均 に対する F
              比で、加法効果（曜日の主効果・米国の主効果）に厳密に直交します。
              セルの色は<b>そのビンの全曜日平均からの乖離</b>、印は maxT
              でセル全体の偽陽性率を5%に抑えた判定です。
            </p>
            <div
              className={`mt-2 rounded p-2 text-[11px] border ${
                main.fIntP < 0.05
                  ? "bg-green-50 border-green-200 text-green-900"
                  : "bg-gray-50 border-gray-200 text-gray-600"
              }`}
            >
              <b>F_int = {num(main.fInt)}</b>（置換 p = {pStr(main.fIntP)}、ヌル95%点{" "}
              {num(main.fInt95)}）
              {main.fIntP < 0.05
                ? " — 曜日効果の大きさは米国の状態に依存します。"
                : " — 加法モデル（曜日効果 ＋ 米国効果）で足りており、交互作用の証拠はありません。"}
              {survivorCells.length > 0 && (
                <>
                  {" "}
                  多重補正後も残ったセル：
                  {survivorCells
                    .map(
                      (c) =>
                        `${dn(c.dow)}×${binLabels[c.bin]}（${bp(c.mean)}, n=${c.n}, 補正p=${c.pAdj.toFixed(3)}）`,
                    )
                    .join(" / ")}
                </>
              )}
            </div>

            <div className="mt-2 overflow-x-auto">
              <table className="text-[11px] border-collapse w-full">
                <thead>
                  <tr className="text-gray-500">
                    <th className="text-left py-1 pr-2 font-medium">
                      曜日＼{isOver ? "当夜" : "前夜"}米国
                    </th>
                    {binLabels.map((l, b) => (
                      <th key={b} className="py-1 px-1 font-medium text-center">
                        <div>{l}</div>
                        <div className="text-[9px] text-fg-muted font-normal">
                          全曜日平均 {bp(main.binMeans[b])}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[1, 2, 3, 4, 5].map((d) => (
                    <tr key={d}>
                      <td className="py-1 pr-2 text-gray-700">{dn(d)}</td>
                      {binLabels.map((_, b) => {
                        const c = cellAt(main, d, b);
                        if (!c || c.n === 0)
                          return (
                            <td key={b} className="py-1 px-1 text-center text-gray-300">
                              —
                            </td>
                          );
                        const mag = Math.min(1, Math.abs(c.delta) / maxAbsDelta);
                        const col =
                          c.delta >= 0
                            ? `rgba(22,163,74,${0.08 + 0.5 * mag})`
                            : `rgba(220,38,38,${0.08 + 0.5 * mag})`;
                        const mark =
                          c.pAdj < 0.05 ? "★" : c.pRaw < 0.05 ? "†" : "";
                        return (
                          <td key={b} className="py-0.5 px-0.5">
                            <div
                              className="rounded-sm px-1 py-1 text-center"
                              style={{ background: col }}
                              title={`平均 ${bp(c.mean)} / ビン平均からの乖離 ${bp(c.delta)} / t=${num(c.t)} / 単独p=${c.pRaw.toFixed(3)} / 補正p=${c.pAdj.toFixed(3)}`}
                            >
                              <div className="font-medium text-gray-900">
                                {bp(c.mean)}
                                {mark && (
                                  <span
                                    className={
                                      c.pAdj < 0.05 ? "text-green-700" : "text-amber-600"
                                    }
                                  >
                                    {mark}
                                  </span>
                                )}
                              </div>
                              <div className="text-[9px] text-gray-500">
                                n={c.n} / 差{bp(c.delta)}
                              </div>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-[10px] text-fg-muted leading-relaxed">
                <span className="text-green-700">★</span>＝maxT 補正後も有意（セル
                {main.cells.filter((c) => c.n >= 10).length}個で FWER 5%）、
                <span className="text-amber-600">†</span>
                ＝単独では有意だが補正で消える。臨界値は |t| ={" "}
                {num(main.tCritFwer)}（補正後）vs {num(main.tCritSingle)}（単独）。
                <b>†だけのセルを発見と呼んではいけません</b>——
                {main.cells.filter((c) => c.n >= 10).length}
                マスから最大を選ぶだけでその水準には到達します。
              </p>
            </div>
          </section>

          {/* ---------- ④ 経済的変換 ---------- */}
          <section className="mt-5">
            <h4 className="text-xs font-semibold text-gray-700">④ 経済的変換：建玉になるか</h4>
            <p className="mt-1 text-[10px] text-gray-500 leading-relaxed">
              答える問い：<b>統計的な差は、往復コストを引いても残るか。</b>{" "}
              統計的有意と経済的有意はまったく別物です。
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 pr-2 font-medium">条件</th>
                    <th className="text-right py-1 px-2 font-medium">出現</th>
                    <th className="text-right py-1 px-2 font-medium">平均</th>
                    <th className="text-right py-1 px-2 font-medium">コスト後</th>
                    <th className="text-right py-1 px-2 font-medium">年あたり回数</th>
                    <th className="text-right py-1 px-2 font-medium">年率寄与</th>
                    <th className="text-right py-1 pl-2 font-medium">補正p</th>
                  </tr>
                </thead>
                <tbody>
                  {main.cells
                    .filter((c) => c.n >= 10)
                    .slice()
                    .sort((a, b) => Math.abs(b.mean) - Math.abs(a.mean))
                    .slice(0, 6)
                    .map((c) => {
                      const years = Math.max(1, result.nWeeks / 52);
                      const perYear = c.n / years;
                      const net = Math.abs(c.mean) - costBps / 10000;
                      const annual = net * perYear;
                      return (
                        <tr key={`${c.dow}-${c.bin}`} className="border-b border-gray-100">
                          <td className="py-1 pr-2 text-gray-700">
                            {dn(c.dow)} × {isOver ? "当夜" : "前夜"}米国 {binLabels[c.bin]}
                            <span className="text-fg-muted">
                              {" "}
                              → {tm.short}を{c.mean >= 0 ? "買" : "売"}
                            </span>
                          </td>
                          <td className="py-1 px-2 text-right text-gray-500">{c.n}回</td>
                          <td
                            className={`py-1 px-2 text-right font-medium ${
                              c.mean >= 0 ? "text-gray-900" : "text-red-700"
                            }`}
                          >
                            {bp(c.mean)}
                          </td>
                          <td
                            className={`py-1 px-2 text-right font-medium ${
                              net > 0 ? "text-green-700" : "text-fg-muted"
                            }`}
                          >
                            {bp(net)}
                          </td>
                          <td className="py-1 px-2 text-right text-gray-500">
                            {perYear.toFixed(0)}
                          </td>
                          <td
                            className={`py-1 px-2 text-right ${
                              annual > 0 ? "text-gray-800" : "text-fg-muted"
                            }`}
                          >
                            {(annual * 100).toFixed(1)}%
                          </td>
                          <td
                            className={`py-1 pl-2 text-right ${
                              c.pAdj < 0.05 ? "text-green-700 font-medium" : "text-fg-muted"
                            }`}
                          >
                            {c.pAdj.toFixed(3)}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
              <p className="mt-1 text-[10px] text-fg-muted leading-relaxed">
                方向は平均の符号に合わせた片側建玉として計算しています（コスト後＝|平均|−往復コスト）。
                <b>補正 p が 0.05 を超えている行に資金を置いてはいけません</b>
                。年率寄与が魅力的に見えても、それは
                {main.cells.filter((c) => c.n >= 10).length}マスから最大を選んだ結果だからです。
                {outlier && isFinite(outlier.beta) && (
                  <>
                    {" "}
                    β の差を金額に直すと：{dn(outlier.dow)}は共通βに対して{" "}
                    {num(outlier.beta - main.homBeta.pooled)} ぶん感応度が違うので、
                    {isOver ? "当夜" : "前夜"}の米国が1σ（{(outlier.sdU * 100).toFixed(2)}%）動いた日に{" "}
                    <b>{bp((outlier.beta - main.homBeta.pooled) * outlier.sdU)}</b>{" "}
                    の差になります（往復コスト {costBps}bps と比較してください）。
                  </>
                )}
              </p>
            </div>
          </section>

          {/* ---------- ⑤ 頑健性 ---------- */}
          <section className="mt-5">
            <h4 className="text-xs font-semibold text-gray-700">⑤ 頑健性：標本を変えても残るか</h4>
            <p className="mt-1 text-[10px] text-gray-500 leading-relaxed">
              答える問い：<b>その交互作用は、連休を除いても・時代を割っても残るか。</b>{" "}
              連休は「前夜米国が複数セッションぶんになる」月曜の構造を拡大したものなので、
              交互作用の主因が連休なら除外で崩れます。
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 pr-2 font-medium">標本</th>
                    <th className="text-right py-1 px-2 font-medium">n</th>
                    <th className="text-right py-1 px-2 font-medium">共通β</th>
                    <th className="text-right py-1 px-2 font-medium">Q（β均一性）</th>
                    <th className="text-right py-1 px-2 font-medium">置換p / Wald p</th>
                    <th className="text-right py-1 px-2 font-medium">F_int（p）</th>
                    <th className="text-left py-1 pl-2 font-medium">最も外れた曜日</th>
                  </tr>
                </thead>
                <tbody>
                  {[main, ...result.robust].map((o) => {
                    const cand = o.dows.filter((d) => isFinite(d.beta) && d.betaSe > 0);
                    const out = cand.length
                      ? cand.reduce((a, b) =>
                          Math.abs(a.beta - o.homBeta.pooled) / a.betaSe >=
                          Math.abs(b.beta - o.homBeta.pooled) / b.betaSe
                            ? a
                            : b,
                        )
                      : null;
                    return (
                      <tr
                        key={o.filter}
                        className={`border-b border-gray-100 ${o.filter === "all" ? "bg-blue-50/40" : ""}`}
                      >
                        <td className="py-1 pr-2 text-gray-700">{FILTER_LABEL[o.filter]}</td>
                        <td className="py-1 px-2 text-right text-gray-500">{o.n}</td>
                        <td className="py-1 px-2 text-right text-gray-700">
                          {num(o.homBeta.pooled)}
                        </td>
                        <td className="py-1 px-2 text-right text-gray-700">{num(o.homBeta.q)}</td>
                        <td
                          className={`py-1 px-2 text-right font-medium ${
                            o.homBeta.pPerm < 0.05 && o.homBeta.pWald < 0.05
                              ? "text-green-700"
                              : "text-fg-muted"
                          }`}
                        >
                          {pStr(o.homBeta.pPerm)} / {pStr(o.homBeta.pWald)}
                        </td>
                        <td
                          className={`py-1 px-2 text-right ${
                            o.fIntP < 0.05 ? "text-green-700 font-medium" : "text-fg-muted"
                          }`}
                        >
                          {num(o.fInt)}（{pStr(o.fIntP)}）
                        </td>
                        <td className="py-1 pl-2 text-gray-600">
                          {out
                            ? `${dn(out.dow)} β=${num(out.beta)}（${num((out.beta - o.homBeta.pooled) / out.betaSe)}SE）`
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <ul className="mt-1 text-[10px] text-fg-muted leading-relaxed list-disc pl-4 space-y-0.5">
                {[...result.robust].map((o) => (
                  <li key={o.filter}>
                    <b>{FILTER_LABEL[o.filter]}</b>：{FILTER_WHY[o.filter]}
                  </li>
                ))}
                <li>
                  前半／後半の分割点は <b>{result.splitDate}</b>。
                  前半と後半で「最も外れた曜日」が入れ替わっていたら、それは構造ではなく標本ゆらぎです。
                </li>
              </ul>
            </div>
          </section>

          {/* ---------- ⑥ 時代依存 ---------- */}
          <section className="mt-5">
            <h4 className="text-xs font-semibold text-gray-700">
              ⑥ 時代依存：いつ・どう変わったか
            </h4>
            <p className="mt-1 text-[10px] text-gray-500 leading-relaxed">
              答える問い：<b>その構造は今もあるのか、それとも昔の話か。</b>{" "}
              ⑤の前半/後半は「時代依存があるかもしれない」と気づく最低限で、
              <b>いつ・どう変わったかは見えません</b>。ここでは連続的な推移として見ます。
              ホイールでズーム、ドラッグで移動できます（上の2ペインは同じ窓末日付なので時間軸が同期します。sup-Wald は x が「分割点」で意味が違うため独立です）。
            </p>

            {era && era.rolling.length >= 5 ? (
              <>
                {era.brk && (
                  <div
                    className={`mt-2 rounded p-2 text-[11px] border ${
                      era.brk.pPerm < 0.05
                        ? "bg-amber-50 border-amber-200 text-amber-900"
                        : "bg-gray-50 border-gray-200 text-gray-600"
                    }`}
                  >
                    <b>構造変化点</b>：sup-Wald = {num(era.brk.bestW)}（置換 p ={" "}
                    {pStr(era.brk.pPerm)}、ヌル95%点 {num(era.brk.crit95)}）、最も割れる時点は{" "}
                    <b>{era.brk.bestDate}</b>。
                    {era.brk.pPerm < 0.05
                      ? " β のベクトルはこの時点の前後で有意に違います。全期間の推定値は「平均された別物」なので、直近側だけで再推定してください。"
                      : " 全期間で β が一定という仮定は棄却されません。⑤で前半/後半の p が割れていても、それは分割位置の任意性の範囲です。"}
                  </div>
                )}

                <div className="mt-2">
                  <div className="text-[10px] text-gray-500 mb-0.5">
                    ローリング曜日別β（窓 {era.rollWeeks}週＝各曜日 {era.rollWeeks}本・窓末で描画）。
                    線が交差・反転していれば「どの曜日が効くか」自体が時代で入れ替わっています。
                  </div>
                  <div ref={rollRef} />
                  <div className="flex flex-wrap gap-3 mt-1 text-[10px]">
                    {[1, 2, 3, 4, 5].map((d) => (
                      <span key={d} className="flex items-center gap-1">
                        <span
                          className="inline-block w-3 h-0.5"
                          style={{ background: DOW_COLOR[d - 1] }}
                        />
                        <span style={{ color: DOW_COLOR[d - 1] }}>{dn(d)}</span>
                      </span>
                    ))}
                    <span className="flex items-center gap-1 text-fg-muted">
                      <span className="inline-block w-3 h-0.5 bg-gray-400" />
                      共通β
                    </span>
                  </div>
                </div>

                <div className="mt-3">
                  <div className="text-[10px] text-gray-500 mb-0.5">
                    ローリング Q（曜日差そのものの強さ）。赤線＝χ²(4) の95%点 9.49。
                    <b>この線を超えている区間が「曜日差が立っていた時代」</b>です。
                  </div>
                  <div ref={qRef} />
                </div>

                {era.brk && (
                  <div className="mt-3">
                    <div className="text-[10px] text-gray-500 mb-0.5">
                      sup-Wald（各時点で前後に割ったときの β ベクトルの差）。<b>横軸は「分割点の日付」</b>で上2ペイン（窓末）とは意味が違うため、ズームは独立です。山の位置が変化点の候補、赤線＝置換ヌルの95%点。
                    </div>
                    <div ref={brkRef} />
                  </div>
                )}

                {era.brk && (
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-[11px] border-collapse">
                      <thead>
                        <tr className="text-gray-500 border-b border-gray-200">
                          <th className="text-left py-1 pr-2 font-medium">区間</th>
                          <th className="text-right py-1 px-2 font-medium">n</th>
                          {[1, 2, 3, 4, 5].map((d) => (
                            <th key={d} className="text-right py-1 px-2 font-medium">
                              {dn(d)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {[
                          {
                            k: "before",
                            label: `〜 ${era.brk.bestDate} 以前`,
                            n: era.brk.nBefore,
                            b: era.brk.beforeBeta,
                            se: era.brk.beforeSe,
                          },
                          {
                            k: "after",
                            label: `${era.brk.bestDate} 以降`,
                            n: era.brk.nAfter,
                            b: era.brk.afterBeta,
                            se: era.brk.afterSe,
                          },
                        ].map((row) => (
                          <tr key={row.k} className="border-b border-gray-100">
                            <td className="py-1 pr-2 text-gray-700">{row.label}</td>
                            <td className="py-1 px-2 text-right text-gray-500">{row.n}</td>
                            {[0, 1, 2, 3, 4].map((d) => (
                              <td key={d} className="py-1 px-2 text-right text-gray-900">
                                {num(row.b[d])}
                                <span className="text-fg-muted"> ±{num(1.96 * row.se[d])}</span>
                              </td>
                            ))}
                          </tr>
                        ))}
                        <tr className="bg-gray-50">
                          <td className="py-1 pr-2 text-gray-600" colSpan={2}>
                            差（以降 − 以前）
                          </td>
                          {[0, 1, 2, 3, 4].map((d) => {
                            const diff = era.brk!.afterBeta[d] - era.brk!.beforeBeta[d];
                            const s = Math.sqrt(
                              era.brk!.afterSe[d] ** 2 + era.brk!.beforeSe[d] ** 2,
                            );
                            const z = s > 0 ? diff / s : NaN;
                            return (
                              <td
                                key={d}
                                className={`py-1 px-2 text-right font-medium ${
                                  Math.abs(z) > 1.96 ? "text-red-700" : "text-gray-500"
                                }`}
                              >
                                {num(diff)}
                                <span className="text-fg-muted"> ({num(z)}SE)</span>
                              </td>
                            );
                          })}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}

                {/* 年別 β ヒートマップ */}
                {era.yearly.length > 0 && (
                  <div className="mt-3 overflow-x-auto">
                    <div className="text-[10px] text-gray-500 mb-0.5">
                      年別 β（各年・各曜日で独立に推定）。色は共通βからの乖離で、
                      <span className="text-red-700">赤</span>＝共通より小さい／
                      <span className="text-green-700">緑</span>＝大きい。
                      <b>年をまたいで符号や順位が入れ替わるなら、それは構造ではなく標本ゆらぎです。</b>
                    </div>
                    <table className="w-full text-[11px] border-collapse">
                      <thead>
                        <tr className="text-gray-500">
                          <th className="text-left py-1 pr-2 font-medium">年</th>
                          {[1, 2, 3, 4, 5].map((d) => (
                            <th key={d} className="py-1 px-1 font-medium text-center">
                              {dn(d)}
                            </th>
                          ))}
                          <th className="text-right py-1 px-2 font-medium">共通β</th>
                          <th className="text-right py-1 pl-2 font-medium">Q（p）</th>
                        </tr>
                      </thead>
                      <tbody>
                        {era.yearly.map((yb) => (
                          <tr key={yb.year}>
                            <td className="py-1 pr-2 text-gray-700">{yb.year}</td>
                            {[0, 1, 2, 3, 4].map((d) => {
                              if (!isFinite(yb.beta[d]))
                                return (
                                  <td key={d} className="py-1 px-1 text-center text-gray-300">
                                    —
                                  </td>
                                );
                              const dev = yb.beta[d] - yb.pooled;
                              const mag = Math.min(1, Math.abs(dev) / 0.5);
                              const col =
                                dev >= 0
                                  ? `rgba(22,163,74,${0.06 + 0.45 * mag})`
                                  : `rgba(220,38,38,${0.06 + 0.45 * mag})`;
                              return (
                                <td key={d} className="py-0.5 px-0.5">
                                  <div
                                    className="rounded-sm px-1 py-1 text-center text-gray-900"
                                    style={{ background: col }}
                                    title={`n=${yb.n[d]} / se=${num(yb.se[d])}`}
                                  >
                                    {num(yb.beta[d])}
                                  </div>
                                </td>
                              );
                            })}
                            <td className="py-1 px-2 text-right text-gray-600">
                              {num(yb.pooled)}
                            </td>
                            <td
                              className={`py-1 pl-2 text-right ${
                                yb.pWald < 0.05 ? "text-green-700 font-medium" : "text-fg-muted"
                              }`}
                            >
                              {num(yb.q)}（{pStr(yb.pWald)}）
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-1 text-[10px] text-fg-muted leading-relaxed">
                      年別の Q は 1年ぶん（各曜日 約50本）しかないので、
                      <b>個別の年の p 値は検出力がほぼありません</b>
                      。ここで見るべきは有意性ではなく<b>符号と順位の安定性</b>です。
                      またローリング窓は重なっているので、Q が連続して95%線を超えていても
                      それは独立した証拠の積み重ねではありません（多重性も未補正）。
                      判定はあくまで①の全期間 Q と、この節の sup-Wald で行ってください。
                    </p>
                  </div>
                )}
              </>
            ) : (
              <div className="mt-2 text-[11px] text-gray-500">
                期間が短く、ローリング推定に必要な窓が取れません（ローリング窓を短くするか、
                期間を10年にしてください）。
              </div>
            )}
          </section>

          <p className="mt-4 text-[10px] text-fg-muted leading-relaxed">
            {result.nDays}日 / {result.nWeeks}週 / 置換{main ? result.params.nIter : 0}回 × 4標本。
            ドライバ＝{US_DRIVERS.find((d) => d.ticker === usTicker)?.label ?? usTicker}
            （国内営業日ごとに「その日の寄り付きより厳密に前の、最後の米国セッション」の終値騰落率）。
            オーバーナイトを選んだときだけドライバは「当夜の米国セッション」に切り替わります。
            標準誤差はすべて HC3（不均一分散頑健）。
          </p>
        </>
      )}

      <AnalysisGuide title="曜日×前夜米国 交互作用：詳細理論">
        <p className="font-medium text-gray-700">1. 何を問うているか — ④の層別との違い</p>
        <p>
          曜日構造の解剖（cal-null-anatomy）の層別軸「前夜米国ビン」は、米国ビンの
          <b>内側で</b>置換します。米国で説明できる分を実測とヌルの両方から同時に消すので、
          残った棄却は「米国を超えた曜日効果」を意味しました。
        </p>
        <p>
          本分析はその<b>真逆</b>です。米国を消すのではなく、
          <b>米国の状態ごとに曜日効果を見る</b>。二元配置で書けば：
        </p>
        <p className="pl-2">{"r = μ + α_d(曜日) + β_b(米国) + γ_{d,b}(交互作用) + ε"}</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>β</b> は既知で巨大（スピルオーバーそのもの）。発見ではありません。
          </li>
          <li>
            <b>α</b> は cal-null-anatomy が maxT で検定済み。
          </li>
          <li>
            <b>γ だけが未検証</b>です。④で「棄却の構図は変わらず」だったことは
            「曜日効果は米国の代理ではない」を意味するだけで、
            <b>「曜日と米国が無関係」ではありません</b>。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">
          2. なぜ γ は「実在すべき」理由があるのか — 62時間 vs 15時間
        </p>
        <p>
          これはデータマイニングではありません。<b>「前夜米国」という変数の定義自体が
          曜日によって違う</b>からです。
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            JP月曜の「前夜米国」＝米国<b>金曜</b>セッション。引け（金15:00 JST）から
            寄り（月9:00 JST）まで約<b>62時間</b>で、間に<b>土日の情報空白</b>を含みます。
          </li>
          <li>JP火〜金の「前夜米国」＝前日の単一セッション。約15時間。</li>
        </ul>
        <p>したがって事前に予想できることがあります：</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>β_gap,月 は他曜日より高いはず</b>。48時間ぶんの情報が寄りにまとめて乗るからです。
            ①の表の「引→寄 時間」と「σ(前夜米国)」の列で、この構造をデータとして確認できます。
          </li>
          <li>
            <b>では β_intra,月 は？</b> 週末に溜まった情報が月曜の寄りで消化しきれず日中に
            漏れるなら正になります。<b>これは反証可能な事前仮説</b>であり、事後に見つけた
            パターンとは統計的な地位が違います。
          </li>
        </ul>
        <p>
          連休明けは同じ構造の拡大版なので、⑤の「連休明け／連休前を除外」は
          この仮説の直接の検証になります。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. なぜビンではなく連続回帰で判定するのか</p>
        <p>
          3分位ビンは連続量 u を3値に潰します。同じ標本で検出力を捨てる行為なので、
          <b>判定は連続回帰で行い、ビンのヒートマップは「どこか」を見る表示に留めます</b>。
          これは cal-null-calib で「累積リターンではなく F で判定する」としたのと同じ構図です。
        </p>
        <p className="pl-2">{"r_i = a_{d(i)} + b_{d(i)} · u_i + ε_i"}</p>
        <p>
          帰無仮説は <b>H₀: b_月 = b_火 = b_水 = b_木 = b_金</b>。5曜日の回帰は互いに素な標本の
          上で走るので係数は独立であり、均一性は Cochran の Q で書けます：
        </p>
        <p className="pl-2">
          {"Q = Σ_d w_d (b_d − b̄_w)²,   w_d = 1/se_d²,   b̄_w = Σ w_d b_d / Σ w_d"}
        </p>
        <p>
          Q は χ²(k−1) に従います。<b>I² = max(0, (Q−df)/Q)</b> は「群間のばらつきのうち
          偶然では説明できない割合」で、Q が有意でも I² が小さければ実質的な差は小さいと読みます。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. HC3 標準誤差が必須である理由</p>
        <p>
          リターン系列は分散が状態依存（ボラティリティ・クラスタリング）なので、
          素の OLS 標準誤差は<b>必ず過小</b>になります。曜日間で β を比べる本分析では、
          過小な SE は Q を膨らませて偽の棄却を生みます。そこで HC3 を使います：
        </p>
        <p className="pl-2">
          {"Var(β̂) = (X'X)⁻¹ [ Σ_i x_i x_i' e_i² / (1−h_i)² ] (X'X)⁻¹"}
        </p>
        <p>
          <i>e_i</i> は残差、<i>{"h_i = x_i'(X'X)⁻¹x_i"}</i> はレバレッジ。HC0 が e_i² をそのまま
          使うのに対し、HC3 は <b>(1−h_i)²</b> で割ることで「その点自身が回帰線を引っ張った分」を
          補正します。米国が −5% といった外れ値の日はレバレッジが高く、
          HC0 だと標準誤差を過小評価するので、この補正が効きます。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 置換の帰無と、その限界</p>
        <p>
          帰無は<b>「週内で (y, u) をペアのまま曜日ラベルごと置換」</b>です。
          ペアを壊さないので共通β・u の周辺分布・週レベルの構造はすべて保存され、
          <b>曜日ラベルだけ</b>が壊れます。これは「その (y,u) の組は、同じ週の別の曜日に
          起きていてもおかしくなかったか」を問う操作です。
        </p>
        <p>
          <b>ただし重大な限界があります。</b>u の分布は曜日で違います（月曜は62時間ぶんで
          分散が大きい）。置換はこれを均してしまうので、群ごとのレバレッジ
          {"Σ(u−ū)²"} が実測と帰無で変わります。したがって：
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>置換 p と HC3 Wald p を必ず併走させ、両者が一致するかを見ます。</b>
            Wald は分布仮定に頼りますがレバレッジ構造はそのまま使い、置換は分布仮定に
            頼りませんがレバレッジを均します。互いの弱点が違うので、
            <b>一致したときだけ結論を出す</b>のが正しい扱いです。
          </li>
          <li>食い違ったときは判定を保留し、σ(u) の列で原因を確認してください。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 目的変数の選択が最重要</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>寄りギャップ</b>：米国の織り込み度そのもの。曜日差が出ても
            <b>寄り付いた時点で既に起きている</b>ので取引できません。月曜がここで大きいのは
            §2 の構造そのもので、発見ではありません。
          </li>
          <li>
            <b>日中（寄→引）</b>：寄りで消化しきれず漏れ出した分。
            <b>曜日差が建玉に変換できる唯一の経路</b>です。既定値がこれである理由です。
          </li>
          <li>
            <b>オーバーナイト（引→翌寄）</b>：当夜の米国セッションの反映率そのもの。
            金曜のこれが週末ギャップです。cal-null-anatomy が maxT で検出した
            「木引→翌寄」の正体（米国木曜セッションの反映不足か、金曜寄り前の週末リスク回避か）を
            ここで分離できます。
          </li>
          <li>
            <b>当日（前日引→引）</b>：ギャップが支配的なので曜日差はギャップ由来になりがちで、
            単独では判断材料になりません。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 上下非対称 β⁺ / β⁻</p>
        <p>実務で効くのはたいていこの形です。</p>
        <p className="pl-2">{"r_i = a_d + b⁺_d · max(u_i, 0) + b⁻_d · min(u_i, 0)"}</p>
        <p>
          max と min は互いに素な台の上に乗るので {"Σ up·dn ≡ 0"} となり、設計行列は疎になります
          （実装はこの構造を使って逆行列を閉形式で解いています）。 b⁺ と b⁻ が離れているほど
          「悪材料と好材料の伝わり方が違う」。単一の β ではこの差が平均されて消えるため、
          <b>β が均一でも β⁻ だけ曜日で違う</b>ということが普通に起こります。
        </p>

        <p className="font-medium text-gray-700 mt-3">8. 交互作用 F_int の作り方</p>
        <p>セル平均 μ̂(d,b) から、加法効果を差し引いた成分を取り出します：</p>
        <p className="pl-2">
          {"γ̂_{d,b} = μ̂_{d,b} − mean_b(μ̂_{d,·}) − mean_d(μ̂_{·,b}) + mean(μ̂)"}
        </p>
        <p>
          行平均・列平均・総平均を<b>セル平均の非加重平均</b>で取るのが要点です。こうすると
          セル数の偏りに関わらず γ̂ は加法効果（α_d と β_b）に<b>厳密に直交</b>します。
          したがって置換が α を壊してしまうことは問題になりません——統計量が α を見ていないからです。
        </p>
        <p className="pl-2">
          {"F_int = [ Σ n_{d,b} γ̂²_{d,b} / (D−1)(B−1) ] / [ SS_within / (N − DB) ]"}
        </p>
        <p>
          セル別の判定には別の統計量を使います。{"δ_{d,b} = μ̂_{d,b} − μ̂_{·,b}"}
          （そのビンの全曜日平均からの乖離）の t 値で、これを全セルの maxT step-down にかけます。
          「米国がこの状態のとき、この曜日は他の曜日と違うか」という、
          トレーダーが実際に知りたい形になっています。
        </p>

        <p className="font-medium text-gray-700 mt-3">9. 標本の壁</p>
        <p>
          5曜日 × 3ビン = 15セル。日足10年でも各セル約160日しかなく、
          <b>交互作用の検出には明らかに足りません</b>。これが「ビンではなく連続回帰」を
          推す3つ目の理由であり、同時に<b>日足版が日中足版より優れる理由</b>でもあります——
          既存のスピルオーバー分析群は60分足ベースで、履歴が2〜3年しか取れません。
        </p>
        <p>
          5分位を選ぶとセルは25個になり、各約95日。maxT の臨界値が上がって検出力は落ちます。
          <b>3分位を既定にしているのはこのためです</b>。5分位は「形を見る」ためだけに使ってください。
        </p>

        <p className="font-medium text-gray-700 mt-3">
          9-2. 時代依存をどう見るか（⑥）— sup-Wald 構造変化検定
        </p>
        <p>
          前半/後半の2分割は「時代依存があるかもしれない」と気づく最低限であって、
          <b>いつ・どう変わったかは見えません</b>。しかも分割位置は恣意的で、
          真の変化点がずれていれば検出力を失います。そこで⑥では3つの見方を重ねます。
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>ローリング曜日別β</b>：窓を1週ずつ滑らせて各曜日の β を再推定します。
            線が交差・反転していれば「どの曜日が効くか」自体が時代で入れ替わっており、
            全期間の推定値は<b>平均された別物</b>ということになります。
          </li>
          <li>
            <b>ローリング Q</b>：曜日差そのものの強さの推移です。χ²(4) の95%点 9.49
            を超えている区間が「曜日差が立っていた時代」。
            <b>窓は重なっているので、連続して超えていても独立した証拠の積み重ねではありません</b>
            （多重性も未補正）。あくまで形を見るためのものです。
          </li>
          <li>
            <b>sup-Wald 構造変化検定</b>：分割点を全探索し、前後で β ベクトルがどれだけ違うかの
            Wald 統計量の<b>最大値</b>を取ります。
          </li>
        </ul>
        <p className="pl-2">
          {"W(τ) = Σ_d (b_d^{前} − b_d^{後})² / (se_d^{前}² + se_d^{後}²),   sup-Wald = max_τ W(τ)"}
        </p>
        <p>
          「最大を取る」操作をしているので、<b>χ² 分布をそのまま当てはめてはいけません</b>
          （これは maxT と同じ問題です）。帰無分布は置換で作ります：
          <b>週をブロック単位で並べ替える</b>。単純な週シャッフルだとボラティリティ・
          クラスタリング（緩やかなレジーム）まで壊してしまい、実測の sup-Wald が
          不当に大きく見えます。そこで四半期（13週）ぶんのブロックで局所の粘りを残しています。
        </p>
        <p>
          なお sup-Wald の<b>探索</b>だけは古典的 SE を使っています。HC3 は分割ごとに残差が必要で
          前置き集計できず、全探索×置換の計算量に乗らないためです。実測と帰無で同じ統計量を
          使う以上、置換検定としての妥当性は保たれます（効率は落ちます）。
          <b>表示する係数はすべて HC3 で取り直しています</b>。
        </p>
        <p>
          <b>棄却されたときの意味は重大です</b>。「全期間の β」は存在しない量を推定していたことに
          なるので、直近側の区間だけで推定し直し、①〜④の判断もその区間でやり直してください。
          棄却されないなら、⑤で前半/後半の p が割れて見えても、それは分割位置の任意性の範囲です。
        </p>
        <p>
          <b>年別 β の表</b>は最も粗いが最も直感的な見方です。1年ぶん（各曜日 約50本）しかないので
          <b>個別の年の p 値には検出力がほぼありません</b>。ここで見るべきは有意性ではなく、
          <b>符号と順位の安定性</b>です。年をまたいで順位が入れ替わるなら、
          全期間 p 値が示すよりずっと危険です。
        </p>

        <p className="font-medium text-gray-700 mt-3">10. 結果の読み方（推奨する順番）</p>
        <ol className="list-decimal pl-4 space-y-1">
          <li>
            <b>目的変数が取引可能か確認する。</b>ギャップと当日は、どんなに綺麗な差が出ても
            建玉になりません。
          </li>
          <li>
            <b>①で置換 p と Wald p が両方 0.05 未満か。</b>片方だけなら保留。
            I² も併読して、有意でも実質差が小さくないかを見ます。
          </li>
          <li>
            <b>②で β⁺／β⁻ のどちらに差があるか。</b>β⁻ だけなら「悪材料の日の曜日差」で、
            建玉の向きが変わります。
          </li>
          <li>
            <b>③のヒートマップで ★ が付いたセルだけを見る。</b>† は「素朴な分析なら
            発見と報告されていたが、マス数を数えると消えるもの」です。
          </li>
          <li>
            <b>④でコスト後に残るか。</b>統計的有意と経済的有意は別物です。
          </li>
          <li>
            <b>⑤で連休除外・時代分割に耐えるか。</b>連休除外で崩れるなら、
            見つけていたのは「連休明けの情報量」であって曜日ではありません
            （それはそれで暦から事前に分かるので、むしろ使いやすい条件です）。
          </li>
          <li>
            <b>⑥で今もあるのかを確認する。</b>sup-Wald が棄却したら全期間の β は
            存在しない量なので、直近側の区間で全部やり直します。棄却しなくても、
            ローリング Q が直近で沈んでいるなら建玉は小さくすべきです。
          </li>
        </ol>

        <p className="font-medium text-gray-700 mt-3">11. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>ヘッジ比率を曜日で変える</b>：β が曜日で違うなら、米国先物での日本株ヘッジは
            曜日ごとに枚数を変えるべきです。①の β をそのままヘッジ比率に使えます。
          </li>
          <li>
            <b>曜日条件付きのフェード</b>：β_intra が負に大きい曜日は「寄りで行き過ぎ、日中に戻す」
            曜日です。米国が大きく動いた翌日の寄りで逆張りする根拠になります。
          </li>
          <li>
            <b>β⁻ の曜日差はテールヘッジの設計に使う</b>：米国安の翌日に特に弱い曜日があるなら、
            その曜日だけプットを厚くする（あるいは建玉を落とす）判断ができます。
          </li>
          <li>
            <b>1σあたり（β×σ(u)）で比較する</b>：β そのものより、その曜日の典型的な米国変動が
            何bpの反応を生むかのほうが経済的に比較しやすい量です。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">12. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>探索履歴全体は補正していません</b>。maxT が数えているのは「このヒートマップの
            セル」だけです。目的変数4種 × ドライバ4種 × ビン2種 を切り替えて眺めた回数は
            補正に入っていません。<b>最初に見る目的変数を決めてから開くべき分析</b>です。
          </li>
          <li>
            <b>非対称 p は曜日間の多重性を補正していません</b>（5回の検定）。目安として 0.01
            を閾値に読んでください。
          </li>
          <li>
            <b>米国の「前夜」は暦ベースで引いています</b>。夏時間の切り替わりや、
            米国が休場で日本が開いている日（そのときは前々営業日の米国が引かれます）は
            厳密には扱いが変わります。日足の粒度ではこの誤差は小さいですが、
            日中足の精密な整合が要るなら既存のスピルオーバー分析群を使ってください。
          </li>
          <li>
            <b>β は同時点の因果ではありません</b>。米国と日本が共通の第三の要因
            （為替・商品・世界的なリスクオフ）に同時反応している分も β に含まれます。
            曜日差の解釈にはこの点が効いてきます。
          </li>
          <li>
            <b>単一銘柄では検出力が足りません</b>。β の曜日差は指数（^N225 など）や
            ウォッチリスト横断のほうがはるかにきれいに出ます。ここで棄却しないことは
            「差が無い」証明ではなく、多くの場合「この標本では何も言えない」という意味です。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
