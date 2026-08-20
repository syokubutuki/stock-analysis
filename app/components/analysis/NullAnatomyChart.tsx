"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  AXES,
  AnatomyParams,
  AnatomyResult,
  AxisKey,
  AxisResult,
  DEFAULT_ANATOMY_PARAMS,
  FAMILIES,
  FAMILY_LABEL,
  FAMILY_NULL,
  Family,
  SlotDef,
  SlotStat,
} from "../../lib/null-anatomy";
import type {
  AnatomyWorkerRequest,
  AnatomyWorkerResponse,
} from "../../lib/null-anatomy.worker";
import { US_DRIVERS, useUsDaily } from "../../hooks/useUsDaily";
import AnalysisGuide from "./AnalysisGuide";
import { CHART_COLORS } from "../../lib/chart-colors";

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
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

// 有意性の3段階。「単独では有意だが多重補正で消える」を独立の色にすることが肝で、
// これが見えないと「10個から一番大きいのを選んだ」代償を体感できない。
type Verdict = "fwer" | "single" | "none";
function verdictOf(pAdj: number, pRaw: number): Verdict {
  if (pAdj < 0.05) return "fwer";
  if (pRaw < 0.05) return "single";
  return "none";
}
const VERDICT_FILL: Record<Verdict, string> = {
  fwer: "rgba(22,163,74,0.65)",
  single: "rgba(217,119,6,0.5)",
  none: "rgba(156,163,175,0.45)",
};
const VERDICT_TEXT: Record<Verdict, string> = {
  fwer: "text-green-700",
  single: "text-amber-600",
  none: "text-fg-muted",
};
const VERDICT_LABEL: Record<Verdict, string> = {
  fwer: "多重補正後も有意",
  single: "単独では有意（補正で消滅）",
  none: "有意でない",
};

// ---------------------------------------------------------------------------
// ①/⑤ 共通: |t| の棒と 2 本の臨界線
// ---------------------------------------------------------------------------
function drawTChart(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  slots: SlotDef[],
  ax: AxisResult,
  mode: "mean" | "vol",
) {
  const ml = 34;
  const mr = 12;
  const mt = 46;
  const mb = 46;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;

  const tOf = (s: SlotStat) => Math.abs(mode === "mean" ? s.t : s.tBF);
  const vOf = (s: SlotStat) =>
    mode === "mean" ? verdictOf(s.pAdj, s.pRaw) : verdictOf(s.pAdjBF, s.pRawBF);
  const critF = mode === "mean" ? ax.tCritFwer : ax.tCritFwerBF;
  const critS = mode === "mean" ? ax.tCritSingle : ax.tCritSingleBF;

  const stats = ax.slots;
  const n = stats.length;
  if (n === 0) return;
  const yMax = Math.max(critF * 1.15, ...stats.map(tOf)) * 1.12 || 1;
  const yOf = (v: number) => mt + plotH - (v / yMax) * plotH;
  const bw = plotW / n;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(
    mode === "mean"
      ? "① スロット別 |t|（平均の偏り）と多重比較の臨界値"
      : "⑤ スロット別 |t|（ばらつきの偏り／Brown-Forsythe）",
    ml,
    14,
  );
  ctx.fillStyle = "#6b7280";
  ctx.font = "9px sans-serif";
  ctx.fillText(
    `帰無: ${AXES.find((a) => a.key === ax.key)?.label ?? ""} / 赤線を超えた棒だけが「発見」`,
    ml,
    27,
  );

  // 族の背景帯
  let x = ml;
  for (const fam of FAMILIES) {
    const cnt = stats.filter((s) => s.family === fam).length;
    if (cnt === 0) continue;
    const w = cnt * bw;
    ctx.fillStyle = fam === "intra" ? "#ffffff" : fam === "inner" ? "rgba(59,130,246,0.05)" : "rgba(168,85,247,0.07)";
    ctx.fillRect(x, mt, w, plotH);
    ctx.fillStyle = CHART_COLORS.ink;
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      fam === "intra" ? "日中" : fam === "inner" ? "週内オーバーナイト" : "週末ギャップ",
      x + w / 2,
      mt - 6,
    );
    x += w;
    if (x < ml + plotW - 1) {
      ctx.strokeStyle = "#e5e7eb";
      ctx.beginPath();
      ctx.moveTo(x, mt);
      ctx.lineTo(x, mt + plotH);
      ctx.stroke();
    }
  }

  // 棒
  stats.forEach((s, i) => {
    const v = tOf(s);
    const x0 = ml + i * bw + bw * 0.18;
    const w = bw * 0.64;
    const y = yOf(v);
    ctx.fillStyle = VERDICT_FILL[vOf(s)];
    ctx.fillRect(x0, y, w, mt + plotH - y);

    // 棒の上: 平均(bp) または 日次ボラ(%)
    ctx.fillStyle = "#4b5563";
    ctx.font = "8px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(mode === "mean" ? bp(s.mean) : pct(s.volSd), x0 + w / 2, Math.max(mt + 8, y - 3));
  });

  // 臨界線
  const hline = (v: number, color: string, dash: number[], label: string, above: boolean) => {
    if (!(v > 0) || v > yMax) return;
    const y = yOf(v);
    ctx.save();
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ml, y);
    ctx.lineTo(ml + plotW, y);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = color;
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(label, ml + plotW - 2, above ? y - 3 : y + 10);
  };
  hline(critS, CHART_COLORS.neutral, [3, 3], `単独検定の95%点 ${critS.toFixed(2)}`, false);
  hline(critF, "#dc2626", [5, 3], `多重補正(maxT)の95%点 ${critF.toFixed(2)}`, true);

  // 軸
  ctx.strokeStyle = "#d1d5db";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ml, mt + plotH);
  ctx.lineTo(ml + plotW, mt + plotH);
  ctx.stroke();

  ctx.fillStyle = CHART_COLORS.ink;
  ctx.font = "9px sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 3; i++) {
    const v = (yMax * i) / 3;
    ctx.fillText(v.toFixed(1), ml - 4, yOf(v) + 3);
  }
  ctx.save();
  ctx.translate(10, mt + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("|t|", 0, 0);
  ctx.restore();

  // スロット名（斜め）
  ctx.textAlign = "right";
  ctx.font = "9px sans-serif";
  stats.forEach((s, i) => {
    ctx.save();
    ctx.translate(ml + i * bw + bw / 2 + 4, mt + plotH + 8);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = vOf(s) === "none" ? CHART_COLORS.ink : "#374151";
    ctx.fillText(slots[s.slot]?.label ?? s.label, 0, 0);
    ctx.restore();
  });
}

// ---------------------------------------------------------------------------
export default function NullAnatomyChart({ prices }: Props) {
  const tRef = useRef<HTMLCanvasElement>(null);
  const vRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  const [nIter, setNIter] = useState(DEFAULT_ANATOMY_PARAMS.nIter);
  const [minPairN, setMinPairN] = useState(DEFAULT_ANATOMY_PARAMS.minPairN);
  const [usTicker, setUsTicker] = useState<string>(DEFAULT_ANATOMY_PARAMS.usTicker);
  const [axisKey, setAxisKey] = useState<AxisKey>("none");
  const [result, setResult] = useState<AnatomyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const { prices: usPrices, loading: usLoading } = useUsDaily(usTicker);

  const params: AnatomyParams = useMemo(
    () => ({ ...DEFAULT_ANATOMY_PARAMS, nIter, minPairN, usTicker }),
    [nIter, minPairN, usTicker],
  );

  useEffect(() => {
    const worker = new Worker(new URL("../../lib/null-anatomy.worker.ts", import.meta.url));
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<AnatomyWorkerResponse>) => {
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

  // 米国データは任意。取得を待つのは usTicker を選んでいる間だけ。
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || prices.length < 120) return;
    if (usTicker && usLoading) return;
    reqIdRef.current++;
    // Worker への投入という外部システムの同期に付随する進捗表示。設定するのは
    // このエフェクトの依存に入っていない state なので再実行は連鎖しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setProgress(null);
    const req: AnatomyWorkerRequest = {
      reqId: reqIdRef.current,
      prices,
      usPrices: usTicker ? usPrices : null,
      params,
    };
    worker.postMessage(req);
  }, [prices, params, usPrices, usLoading, usTicker]);

  const axis = useMemo(
    () => result?.axes.find((a) => a.key === axisKey) ?? result?.axes[0] ?? null,
    [result, axisKey],
  );
  const baseline = useMemo(() => result?.axes.find((a) => a.key === "none") ?? null, [result]);

  useEffect(() => {
    const c = tRef.current;
    if (!c || !result?.ok || !axis) return;
    const init = initCanvas(c, 290);
    if (init) drawTChart(init.ctx, init.width, init.height, result.slots, axis, "mean");
  }, [result, axis]);

  useEffect(() => {
    const c = vRef.current;
    if (!c || !result?.ok || !axis) return;
    const init = initCanvas(c, 290);
    if (init) drawTChart(init.ctx, init.width, init.height, result.slots, axis, "vol");
  }, [result, axis]);

  const survivors = useMemo(
    () => (axis ? axis.slots.filter((s) => s.pAdj < 0.05).sort((a, b) => a.pAdj - b.pAdj) : []),
    [axis],
  );
  const volSurvivors = useMemo(
    () => (axis ? axis.slots.filter((s) => s.pAdjBF < 0.05).sort((a, b) => a.pAdjBF - b.pAdjBF) : []),
    [axis],
  );

  const famStat = (a: AxisResult, f: Family) => a.families.find((x) => x.family === f);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-800">
          曜日構造の解剖：どこに・どんな構造があるか（週末ギャップ込み）
        </h3>
        <span className="text-[10px] text-fg-muted">
          F が棄却したあと、選択バイアスを再導入せずに中身を特定する
        </span>
      </div>

      <p className="mt-2 text-[11px] text-gray-500 leading-relaxed">
        ヌル較正の F は「どこかに偏りがある」までしか言わない全体検定です。棄却後に表を眺めて
        一番大きいスロットを選ぶと、ヌル較正が暴いたはずの選択バイアスを裏口から再導入することに
        なります。ここでは<b>同じ置換スキームを共有した事後分解</b>で中身を特定します。
        さらにヌル較正の死角だった<b>週末ギャップ（金引→月寄ほか）を独立した族として検定対象に
        含めます</b>——週内置換ではギャップが金曜位置に固定されるため原理的に見えなかった部分です。
      </p>

      {/* 操作 */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-gray-500">帰無（層別軸）</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={axisKey}
            onChange={(e) => setAxisKey(e.target.value as AxisKey)}
          >
            {AXES.filter((a) => result?.axes.some((r) => r.key === a.key) ?? a.key === "none").map(
              (a) => (
                <option key={a.key} value={a.key}>
                  {a.label}
                </option>
              ),
            )}
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
          <span className="text-gray-500">週末ペア最小n</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={minPairN}
            onChange={(e) => setMinPairN(Number(e.target.value))}
          >
            {[5, 8, 15, 30].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">米国ドライバ</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={usTicker}
            onChange={(e) => setUsTicker(e.target.value)}
          >
            <option value="">使わない</option>
            {US_DRIVERS.map((d) => (
              <option key={d.ticker} value={d.ticker}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </div>

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

      {result?.ok && axis && baseline && (
        <>
          {/* ---------- サマリー ---------- */}
          <div
            className={`mt-3 rounded p-2.5 text-xs border ${
              survivors.length
                ? "bg-green-50 border-green-200 text-green-900"
                : "bg-amber-50 border-amber-200 text-amber-900"
            }`}
          >
            <div className="font-semibold">
              {survivors.length
                ? `多重補正後も生き残ったスロット: ${survivors.length}個`
                : "多重補正後に生き残ったスロットはありません"}
            </div>
            <div className="mt-1 leading-relaxed">
              {survivors.length ? (
                <>
                  {survivors.map((s, i) => (
                    <span key={s.key}>
                      {i > 0 && " / "}
                      <b>{s.label}</b> {bp(s.mean)}（|t|={Math.abs(s.t).toFixed(2)}、補正p=
                      {s.pAdj.toFixed(3)}）
                    </span>
                  ))}
                  。 これらは「{axis.slots.length}
                  個のスロットから一番大きいものを選んだ」代償を払ったうえで残った偏りです。
                </>
              ) : (
                <>
                  最大の |t| は{" "}
                  <b>
                    {
                      axis.slots.reduce((a, b) => (Math.abs(a.t) >= Math.abs(b.t) ? a : b)).label
                    }
                  </b>{" "}
                  の{" "}
                  {Math.abs(
                    axis.slots.reduce((a, b) => (Math.abs(a.t) >= Math.abs(b.t) ? a : b)).t,
                  ).toFixed(2)}
                  ですが、多重補正の臨界値 {axis.tCritFwer.toFixed(2)}{" "}
                  に届きません。「{axis.slots.length}個から最大を選ぶ」だけでこの水準には到達します。
                </>
              )}
            </div>
            {volSurvivors.length > 0 && (
              <div className="mt-1.5 pt-1.5 border-t border-current/10 leading-relaxed">
                <b>ばらつき側</b>では {volSurvivors.map((s) => s.label).join(" / ")}{" "}
                が補正後も有意です（⑤参照）。方向は出ませんが建玉サイズに直結します。
              </div>
            )}
          </div>

          {/* ---------- ① maxT ---------- */}
          <section className="mt-5">
            <h4 className="text-xs font-semibold text-gray-700">
              ① どのスロットか — maxT 置換（Westfall–Young step-down）
            </h4>
            <p className="mt-1 text-[10px] text-gray-500 leading-relaxed">
              答える問い：<b>偏りはどのスロットにあるか。</b>{" "}
              各サロゲートで全スロットの t を計算し、その<b>最大値だけ</b>
              を記録してヌル分布を作ります。「たくさんの中から一番大きいのを選んだ」ことを
              正しく罰する唯一の方法で、族全体で偽陽性率を 5% に抑えます（FWER）。
              下の赤線を超えた棒だけが発見です。灰線（単独検定の95%点）との差が
              <b>多重性の代償</b>そのものです。
            </p>
            <div className="mt-2">
              <canvas ref={tRef} />
            </div>
            <div className="mt-1 flex flex-wrap gap-3 text-[10px]">
              {(["fwer", "single", "none"] as const).map((v) => (
                <span key={v} className="flex items-center gap-1">
                  <span
                    className="inline-block w-3 h-3 rounded-sm"
                    style={{ background: VERDICT_FILL[v] }}
                  />
                  <span className={VERDICT_TEXT[v]}>{VERDICT_LABEL[v]}</span>
                </span>
              ))}
            </div>

            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 pr-2 font-medium">スロット</th>
                    <th className="text-right py-1 px-2 font-medium">n</th>
                    <th className="text-right py-1 px-2 font-medium">平均</th>
                    <th className="text-right py-1 px-2 font-medium">日次σ</th>
                    <th className="text-right py-1 px-2 font-medium">t</th>
                    <th className="text-right py-1 px-2 font-medium">単独p</th>
                    <th className="text-right py-1 px-2 font-medium">補正p(maxT)</th>
                    <th className="text-right py-1 pl-2 font-medium">F寄与</th>
                  </tr>
                </thead>
                <tbody>
                  {FAMILIES.map((fam) => {
                    const rows = axis.slots.filter((s) => s.family === fam);
                    if (rows.length === 0) return null;
                    const fs = famStat(axis, fam);
                    return (
                      <Fragment key={fam}>
                        <tr className="bg-gray-50">
                          <td colSpan={8} className="py-1 px-1 text-[10px] text-gray-500">
                            <b>{FAMILY_LABEL[fam]}</b>
                            {fs && fs.k >= 2 ? (
                              <>
                                {" "}
                                — 族F = {fs.f.toFixed(2)}（p = {fs.pF.toFixed(3)}、ヌル95%点{" "}
                                {fs.f95.toFixed(2)}）
                              </>
                            ) : fam === "weekend" ? (
                              " — 週末ペアが1種類しかないため族内比較は不能。期間を延ばすか「週末ペア最小n」を下げてください"
                            ) : (
                              " — スロットが1種類しかないため族内比較は不能"
                            )}
                            <span className="text-fg-muted"> ／ 帰無: {FAMILY_NULL[fam]}</span>
                          </td>
                        </tr>
                        {rows.map((s) => {
                          const v = verdictOf(s.pAdj, s.pRaw);
                          return (
                            <tr key={s.key} className="border-b border-gray-100">
                              <td className="py-1 pr-2 text-gray-700">{s.label}</td>
                              <td className="py-1 px-2 text-right text-gray-500">{s.n}</td>
                              <td
                                className={`py-1 px-2 text-right font-medium ${
                                  s.mean >= 0 ? "text-gray-900" : "text-red-700"
                                }`}
                              >
                                {bp(s.mean)}
                              </td>
                              <td className="py-1 px-2 text-right text-fg-muted">{pct(s.sd)}</td>
                              <td className="py-1 px-2 text-right text-gray-700">
                                {s.t.toFixed(2)}
                              </td>
                              <td className="py-1 px-2 text-right text-fg-muted">
                                {s.pRaw.toFixed(3)}
                              </td>
                              <td
                                className={`py-1 px-2 text-right font-medium ${VERDICT_TEXT[v]}`}
                              >
                                {s.pAdj.toFixed(3)}
                              </td>
                              <td className="py-1 pl-2 text-right text-gray-500">
                                {(s.contrib * 100).toFixed(0)}%
                              </td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {result.rarePairs.length > 0 && (
              <p className="mt-1 text-[10px] text-fg-muted">
                標本が少なく除外した週末ペア：
                {result.rarePairs.map((r) => `${r.label}(${r.n}回)`).join("、")}
                （最小n を下げると検定に含められますが、少数群は t が暴れて maxT
                の臨界値を押し上げ、他のスロットの検出力を奪います）
              </p>
            )}
          </section>

          {/* ---------- ② F の分解 ---------- */}
          <section className="mt-5">
            <h4 className="text-xs font-semibold text-gray-700">
              ② F を作ったのは誰か — SS_between の寄与シェア
            </h4>
            <p className="mt-1 text-[10px] text-gray-500 leading-relaxed">
              答える問い：<b>族の F は一つのスロットが作ったのか、全体に散っているのか。</b>{" "}
              検定ではなく記述です。F = 2.8 が「月曜だけで 70%」なのか「5曜日に均等に散った」のかで
              意味がまったく違います。①で拾えなかった弱い偏りの分布もここに見えます。
            </p>
            <div className="mt-2 space-y-3">
              {FAMILIES.map((fam) => {
                const rows = axis.slots.filter((s) => s.family === fam);
                const fs = famStat(axis, fam);
                if (rows.length < 2 || !fs) return null;
                return (
                  <div key={fam}>
                    <div className="text-[10px] text-gray-500">
                      <b>{FAMILY_LABEL[fam]}</b> — F = {fs.f.toFixed(2)}（p = {fs.pF.toFixed(3)}）
                    </div>
                    <div className="mt-1 space-y-0.5">
                      {rows
                        .slice()
                        .sort((a, b) => b.contrib - a.contrib)
                        .map((s) => (
                          <div key={s.key} className="flex items-center gap-2 text-[10px]">
                            <span className="w-24 shrink-0 text-gray-600 truncate">{s.label}</span>
                            <span className="flex-1 h-3 bg-gray-100 rounded-sm overflow-hidden">
                              <span
                                className="block h-full rounded-sm"
                                style={{
                                  width: `${Math.max(0.5, s.contrib * 100)}%`,
                                  background: VERDICT_FILL[verdictOf(s.pAdj, s.pRaw)],
                                }}
                              />
                            </span>
                            <span className="w-10 text-right text-gray-500 tabular-nums">
                              {(s.contrib * 100).toFixed(0)}%
                            </span>
                            <span
                              className={`w-14 text-right tabular-nums ${
                                s.mean >= 0 ? "text-gray-600" : "text-red-600"
                              }`}
                            >
                              {bp(s.mean)}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ---------- ③ 頑健性 ---------- */}
          <section className="mt-5">
            <h4 className="text-xs font-semibold text-gray-700">
              ③ 一発屋か、持続する構造か — 順位版／刈り込み版／1週抜き／年別
            </h4>
            <p className="mt-1 text-[10px] text-gray-500 leading-relaxed">
              答える問い：<b>その偏りは平均の持続的なズレか、それとも数日の極値の産物か。</b>{" "}
              リターンは裾が厚いので、生の F は数日の暴落・暴騰に支配されがちです。順位版
              （Kruskal–Wallis 相当）と刈り込み版（上下2.5%を切り詰め）が同時に棄却して初めて
              「平均のズレ」と言えます。1週抜きは、たった1週間を除くと F が何割落ちるかを見ます。
            </p>

            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 pr-2 font-medium">族</th>
                    <th className="text-right py-1 px-2 font-medium">生F（p）</th>
                    <th className="text-right py-1 px-2 font-medium">順位版F（p）</th>
                    <th className="text-right py-1 px-2 font-medium">刈り込み版F（p）</th>
                    <th className="text-left py-1 pl-2 font-medium">読み</th>
                  </tr>
                </thead>
                <tbody>
                  {FAMILIES.map((fam) => {
                    const fs = famStat(baseline, fam);
                    if (!fs || fs.k < 2) return null;
                    const robust = fs.pF < 0.05 && fs.pRank < 0.05 && fs.pWins < 0.05;
                    const fragile = fs.pF < 0.05 && (fs.pRank >= 0.05 || fs.pWins >= 0.05);
                    return (
                      <tr key={fam} className="border-b border-gray-100">
                        <td className="py-1 pr-2 text-gray-700">{FAMILY_LABEL[fam]}</td>
                        <td className="py-1 px-2 text-right text-gray-700">
                          {fs.f.toFixed(2)}（{fs.pF.toFixed(3)}）
                        </td>
                        <td className="py-1 px-2 text-right text-gray-700">
                          {fs.fRank.toFixed(2)}（{fs.pRank.toFixed(3)}）
                        </td>
                        <td className="py-1 px-2 text-right text-gray-700">
                          {fs.fWins.toFixed(2)}（{fs.pWins.toFixed(3)}）
                        </td>
                        <td
                          className={`py-1 pl-2 ${
                            robust ? "text-green-700" : fragile ? "text-red-700" : "text-fg-muted"
                          }`}
                        >
                          {robust
                            ? "3つとも棄却 — 平均のズレとして頑健"
                            : fragile
                              ? "生Fのみ棄却 — 数日の極値が正体の疑い"
                              : "棄却せず"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-1 text-[10px] text-fg-muted">
                順位版・刈り込み版は無層別（基準）の帰無でのみ計算します。層別軸を切り替えても
                この行は変わりません。
              </p>
            </div>

            {result.robustness && (
              <>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-[11px] border-collapse">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-200">
                        <th className="text-left py-1 pr-2 font-medium">族</th>
                        <th className="text-right py-1 px-2 font-medium">F（全期間）</th>
                        <th className="text-left py-1 px-2 font-medium">最も効いている1週</th>
                        <th className="text-right py-1 px-2 font-medium">その週を抜くとF</th>
                        <th className="text-right py-1 pl-2 font-medium">低下率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.robustness.lowo.map((l) => {
                        const t0 = l.top[0];
                        if (!t0) return null;
                        return (
                          <tr key={l.family} className="border-b border-gray-100">
                            <td className="py-1 pr-2 text-gray-700">{FAMILY_LABEL[l.family]}</td>
                            <td className="py-1 px-2 text-right text-gray-700">
                              {l.fFull.toFixed(2)}
                            </td>
                            <td className="py-1 px-2 text-gray-600">{t0.label}</td>
                            <td className="py-1 px-2 text-right text-gray-700">
                              {t0.fWithout.toFixed(2)}
                            </td>
                            <td
                              className={`py-1 pl-2 text-right font-medium ${
                                t0.drop > 0.3
                                  ? "text-red-700"
                                  : t0.drop > 0.15
                                    ? "text-amber-600"
                                    : "text-green-700"
                              }`}
                            >
                              {(t0.drop * 100).toFixed(0)}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="mt-1 text-[10px] text-fg-muted">
                    低下率 30% 超（赤）は「たった1週間で F の3割が作られている」という意味で、
                    構造ではなく事件を見ています。10% 未満なら全期間に薄く広がった構造です。
                  </p>
                </div>

                <div className="mt-3">
                  <div className="text-[10px] text-gray-500">
                    <b>{result.slots[result.robustness.topSlot]?.label}</b>（|t|
                    最大のスロット）の年別平均 — 全期間と同符号だった年:{" "}
                    <b
                      className={
                        result.robustness.signAgree >= 0.7
                          ? "text-green-700"
                          : result.robustness.signAgree >= 0.55
                            ? "text-amber-600"
                            : "text-red-700"
                      }
                    >
                      {(result.robustness.signAgree * 100).toFixed(0)}%
                    </b>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {result.robustness.yearly.map((y) => {
                      const mag = Math.min(1, Math.abs(y.mean) / 0.004);
                      const bgc =
                        y.mean >= 0
                          ? `rgba(22,163,74,${0.15 + 0.55 * mag})`
                          : `rgba(220,38,38,${0.15 + 0.55 * mag})`;
                      return (
                        <div
                          key={y.year}
                          className="w-14 rounded-sm text-center py-1"
                          style={{ background: bgc }}
                          title={`${y.year}年 ${bp(y.mean)} (n=${y.n})`}
                        >
                          <div className="text-[9px] text-gray-700">{y.year}</div>
                          <div className="text-[9px] font-medium text-gray-900">{bp(y.mean)}</div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-[10px] text-fg-muted">
                    符号一致率が 70% 未満なら、全期間の平均が正でも「毎年そうだった」わけでは
                    ありません。運用は年単位で行うので、ここが割れている構造に賭けるのは
                    全期間 p 値が示すよりずっと危険です。
                  </p>
                </div>
              </>
            )}
          </section>

          {/* ---------- ④ 層別置換 ---------- */}
          <section className="mt-5">
            <h4 className="text-xs font-semibold text-gray-700">
              ④ 「曜日」そのものか、何かの代理か — 層別置換
            </h4>
            <p className="mt-1 text-[10px] text-gray-500 leading-relaxed">
              答える問い：<b>見つけたのは曜日効果か、それとも別の効果が曜日の衣装を着たものか。</b>{" "}
              置換を層の内側に制限すると、その層で説明できる分は実測とヌルの両方から同時に消えます。
              層別しても F が棄却し続ければ「その交絡を超えた曜日効果」。層別した途端に崩れれば、
              見つけていたのは<b>その交絡</b>です。
            </p>
            <p className="mt-1 text-[10px] text-gray-500 leading-relaxed">
              なお<b>週レベルの交絡（月内で何週目か・その週の営業日数・週次ボラ水準）は既に
              条件付けされています</b>
              。基準の帰無が「週の中で」しか置換しないためで、これらは原理的に交絡になりえません。
              問題になるのは<b>週の中で特定の曜日に貼り付く日レベルの属性</b>だけであり、
              下の軸はすべてそれです。
            </p>

            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 pr-2 font-medium">層別軸</th>
                    <th className="text-right py-1 px-2 font-medium">有効置換率</th>
                    {FAMILIES.map((f) => (
                      <th key={f} className="text-right py-1 px-2 font-medium">
                        {f === "intra" ? "日中" : f === "inner" ? "週内夜間" : "週末ギャップ"} F（p）
                      </th>
                    ))}
                    <th className="text-left py-1 pl-2 font-medium">読み</th>
                  </tr>
                </thead>
                <tbody>
                  {result.axes.map((a) => {
                    const meta = AXES.find((m) => m.key === a.key);
                    const killed: string[] = [];
                    for (const f of FAMILIES) {
                      const b = famStat(baseline, f);
                      const c = famStat(a, f);
                      if (!b || !c || b.k < 2) continue;
                      if (a.key !== "none" && b.pF < 0.05 && c.pF >= 0.1)
                        killed.push(f === "intra" ? "日中" : f === "inner" ? "週内夜間" : "週末");
                    }
                    return (
                      <tr
                        key={a.key}
                        className={`border-b border-gray-100 ${
                          a.key === axisKey ? "bg-blue-50/50" : ""
                        }`}
                      >
                        <td className="py-1 pr-2 text-gray-700">
                          <button
                            className="text-left hover:underline"
                            onClick={() => setAxisKey(a.key)}
                            title="この帰無で①②⑤を描き直す"
                          >
                            {meta?.label ?? a.key}
                          </button>
                        </td>
                        <td
                          className={`py-1 px-2 text-right ${
                            a.permRate < 0.5 ? "text-red-600" : "text-gray-500"
                          }`}
                        >
                          {(a.permRate * 100).toFixed(0)}%
                        </td>
                        {FAMILIES.map((f) => {
                          const c = famStat(a, f);
                          if (!c || c.k < 2)
                            return (
                              <td key={f} className="py-1 px-2 text-right text-fg-muted">
                                —
                              </td>
                            );
                          return (
                            <td
                              key={f}
                              className={`py-1 px-2 text-right ${
                                c.pF < 0.05 ? "text-green-700 font-medium" : "text-gray-500"
                              }`}
                            >
                              {c.f.toFixed(2)}（{c.pF.toFixed(3)}）
                            </td>
                          );
                        })}
                        <td className="py-1 pl-2 text-[10px]">
                          {a.key === "none" ? (
                            <span className="text-fg-muted">基準</span>
                          ) : killed.length ? (
                            <span className="text-red-700">
                              {killed.join("・")}の棄却が消滅 — この軸の代理である疑い
                            </span>
                          ) : (
                            <span className="text-fg-muted">棄却の構図は変わらず</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <ul className="mt-2 text-[10px] text-gray-500 leading-relaxed list-disc pl-4 space-y-1">
              {AXES.filter((m) => result.axes.some((a) => a.key === m.key) && m.key !== "none").map(
                (m) => (
                  <li key={m.key}>
                    <b>{m.label}</b>：{m.desc}
                  </li>
                ),
              )}
              {!result.usOk && usTicker && (
                <li className="text-amber-600">
                  前夜米国ビンは米国データを整合できなかったため表示していません。
                </li>
              )}
            </ul>
            <p className="mt-1 text-[10px] text-fg-muted leading-relaxed">
              <b>有効置換率</b>
              ＝サイズ2以上のブロックに属する観測の割合。層を細かく切りすぎるとブロックが
              1個ずつに割れ、値が動かせなくなって検定は「棄却しない」だけの空箱になります。
              この値が 50% を下回った軸（赤）の p 値は、検出力の消滅であって
              交絡の証明ではありません。とくに<b>休場暦日数</b>では、3日ギャップの群が
              金引→月寄 だけになるため、そのスロットは原理的に検定不能（p=1）になります——
              これは「同じ休場日数の中に比較対象がない」という正しい結論です。
            </p>
          </section>

          {/* ---------- ⑤ 平均か分散か ---------- */}
          <section className="mt-5">
            <h4 className="text-xs font-semibold text-gray-700">
              ⑤ 平均の構造か、ばらつきの構造か — Brown–Forsythe
            </h4>
            <p className="mt-1 text-[10px] text-gray-500 leading-relaxed">
              答える問い：<b>曜日で違うのは「どちらへ動くか」か、「どれだけ動くか」か。</b>{" "}
              ①〜④の F は平均差しか見ていません。各値をそのスロットの中央値からの絶対偏差に
              置き換えて同じ検定を回すと、ばらつきの曜日構造が見えます。方向は出ませんが、
              <b>建玉サイズと損切り幅には直結します</b>。実務では平均差より頑健に出ます。
            </p>
            <div className="mt-2">
              <canvas ref={vRef} />
            </div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    <th className="text-left py-1 pr-2 font-medium">族</th>
                    <th className="text-right py-1 px-2 font-medium">BF統計量F</th>
                    <th className="text-right py-1 px-2 font-medium">p</th>
                    <th className="text-left py-1 pl-2 font-medium">最もσが大きい／小さいスロット</th>
                  </tr>
                </thead>
                <tbody>
                  {FAMILIES.map((fam) => {
                    const fs = famStat(axis, fam);
                    const rows = axis.slots.filter((s) => s.family === fam);
                    if (!fs || fs.k < 2 || rows.length < 2) return null;
                    const hi = rows.reduce((a, b) => (a.volSd >= b.volSd ? a : b));
                    const lo = rows.reduce((a, b) => (a.volSd <= b.volSd ? a : b));
                    return (
                      <tr key={fam} className="border-b border-gray-100">
                        <td className="py-1 pr-2 text-gray-700">{FAMILY_LABEL[fam]}</td>
                        <td className="py-1 px-2 text-right text-gray-700">{fs.fBF.toFixed(2)}</td>
                        <td
                          className={`py-1 px-2 text-right font-medium ${
                            fs.pBF < 0.05 ? "text-green-700" : "text-fg-muted"
                          }`}
                        >
                          {fs.pBF.toFixed(3)}
                        </td>
                        <td className="py-1 pl-2 text-gray-600">
                          最大 <b>{hi.label}</b> {pct(hi.volSd)} ／ 最小 <b>{lo.label}</b>{" "}
                          {pct(lo.volSd)}
                          <span className="text-fg-muted">
                            {" "}
                            （比 {(hi.volSd / Math.max(1e-9, lo.volSd)).toFixed(2)}倍）
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <p className="mt-4 text-[10px] text-fg-muted leading-relaxed">
            {result.nObs}観測 / {result.nWeeks}週 / サロゲート{result.params.nIter}回 ×{" "}
            {result.axes.length}軸。 p 値は片側モンテカルロ p =（ヌルが実測以上になった回数 +
            1）/（反復数 + 1）。 スロットの t は<b>族平均からの乖離</b>
            で、置換の下では族の総和が不変なので、これがちょうど正しい帰無になります。
            <b>層別軸を切り替えても実測値（平均・t・寄与シェア）は変わりません</b>
            。変わるのは帰無分布＝p 値だけです。
          </p>
        </>
      )}

      <AnalysisGuide title="曜日構造の解剖：詳細理論">
        <p className="font-medium text-gray-700">1. なぜ F だけでは足りないのか</p>
        <p>
          ヌル較正の F 統計量（一元配置分散分析の F 比）は<b>全体検定（omnibus test）</b>です。
          「5つのスロット平均がすべて等しい」という帰無仮説を棄却しますが、
          <b>どのスロットが・どちら向きに・どれだけ違うのかは構造的に捨てています</b>。
          F は各スロットの偏差を二乗して足し合わせるので、符号も個体も消えるからです。
        </p>
        <p>
          そこで棄却後に表を眺めて「月曜の日中が一番大きいからこれだ」と選ぶと、
          <b>ヌル較正が暴いたはずの in-sample 選択バイアスを裏口から再導入</b>することになります。
          10スロットから最大を選ぶ操作は、`bestCombination` が10スロットで最良の売買を選ぶ操作と
          数学的に同じものです。「発見の床」を測ったその足で床を踏み抜いてはいけません。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. ① maxT 置換（Westfall–Young step-down）</p>
        <p>
          各スロット <i>s</i> について、族平均からの乖離の t 統計量を作ります：
        </p>
        <p className="pl-2">{"t_s = (m_s − m̄) / (σ_s / √n_s)"}</p>
        <p>
          <i>m_s</i> はスロット平均、<i>m̄</i> は族全体の平均、<i>σ_s</i> はスロット内の標準偏差、
          <i>n_s</i> は標本数。σ をスロットごとに取るのは、週末ギャップのように群ごとに
          ばらつきが大きく違う場合に備えるためです（4日ギャップは3日ギャップより自然にσが大きい）。
        </p>
        <p>
          置換の下では族の総和が不変なので <i>m̄</i> は固定点であり、動くのは
          「どのスロットに値が乗るか」だけ。これがちょうど正しい帰無になります。
        </p>
        <p>そのうえで、各サロゲートについて</p>
        <p className="pl-2">{"T_max = max_s |t_s^null|"}</p>
        <p>
          を記録し、<b>この最大値の分布</b>を臨界値に使います。これが単一ステップ maxT です。
          本実装はさらに step-down を行います：観測 |t| の降順に並べ、
          <i>k</i> 番目のスロットの帰無を「まだ棄却していない集合 {"{k, k+1, …}"} 上の max|t|」
          に取り替えることで、既に棄却したスロットを帰無から外し、検出力を上げます。
        </p>
        <p className="pl-2">
          {"p_adj(k) = max_{j ≤ k} [ #{ max_{i ≥ j} |t_i^null| ≥ |t_{(j)}^obs| } + 1 ] / (B + 1)"}
        </p>
        <p>
          最後に単調性（順位が下のスロットの p が上を下回らない）を強制します。この手続きは
          <b>族全体の FWER（1つでも偽陽性を出す確率）を 5% に抑えます</b>。
          Bonferroni と違い、スロット間の相関（同じ週の日中リターン同士は相関する）を
          置換が自動的に織り込むので、過剰に保守的になりません。
        </p>
        <p>
          チャートの<b>灰線</b>は単独検定の95%点、<b>赤線</b>は maxT の95%点です。
          この2本の差が「たくさんの中から選んだ」代償を目に見える形にしたものです。
          橙色の棒（単独では有意だが補正で消える）は、素朴な分析なら「発見」として
          報告されていたものです。
        </p>

        <p className="font-medium text-gray-700 mt-3">
          3. 週末ギャップ（金引→月寄）の死角をどう開けたか
        </p>
        <p>
          ヌル較正の既定モード（週内スロット置換）は、週末ギャップを<b>金曜位置に固定</b>します。
          「金曜の後は3日分のギャップ」という機械的構造を保存するための正しい設計ですが、
          代償として<b>週末ギャップの曜日効果は原理的に検定できません</b>——
          動かさないものは検定できないからです。
        </p>
        <p>
          本モジュールは週末ギャップを<b>独立した第3の族</b>として扱い、別の帰無を当てます：
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            各週末ギャップを「<b>終了曜日 → 開始曜日</b>」のペアでラベル付けする
            （金引→月寄、木引→月寄、金引→火寄 …）。日本株では月曜・金曜の祝日が多いため、
            10年あれば主要ペアは十分な標本数になります。
          </li>
          <li>
            帰無＝<b>ギャップの値を週をまたいで置換する</b>。ペアのラベルだけを壊し、
            週末ギャップの周辺分布（裾の厚さ・3日分のスケール）は完全に保存します。
          </li>
          <li>
            この族のスロットも日中・週内夜間と<b>同じ maxT の族に入れる</b>ので、
            「13スロットから最大を選んだ」代償が週末ギャップにも正しく課されます。
          </li>
        </ul>
        <p>
          <b>決定的な注意</b>：ペアの違いは<b>休場の長さとほぼ同義</b>です。金引→月寄は3日、
          木引→月寄と金引→火寄は4日。したがってこの族の棄却は、そのままでは
          「曜日効果」ではなく「休場が長いほどドリフトが積み上がる」という当たり前の事実を
          拾っただけかもしれません。それを切り分けるのが④の
          <b>休場暦日数による層別</b>で、同じ休場日数の中でだけ置換します。
          3日群は金引→月寄しか含まないため検定不能（p=1）になりますが、これは
          「同じ休場日数の中に比較対象が存在しない」という正しい結論であって、実装の欠陥ではありません。
          4日群（木引→月寄 vs 金引→火寄）の比較こそが、休場の長さを制御した
          真の「曜日効果」の検定です。
        </p>
        <p>
          また、<b>「週末ギャップ全体 vs 週内夜間」の水準差はここでは検定できません</b>。
          どちらの帰無も族の平均を動かさないため、その差は置換の下で定数だからです。
          この問いは週末プレミアム（cal-weekend-premium）の担当で、そちらは区間の
          性質そのものを比較する別の枠組みを使っています。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. ② SS_between の分解</p>
        <p>F の分子は各スロットの偏差二乗和です：</p>
        <p className="pl-2">{"SS_between = Σ_s n_s (m_s − m̄)²"}</p>
        <p>
          したがってスロット <i>s</i> の寄与シェアは {"n_s (m_s − m̄)² / SS_between"} で、
          合計は 100% になります。これは検定ではなく<b>記述</b>です。
          同じ F = 2.8 でも「1スロットが 70%」と「5スロットが均等に 20% ずつ」では
          意味がまったく違い、前者は単一の曜日仮説、後者は「曜日全体で形が違う」という
          より弱く広い主張になります。①で個別に棄却できなかった弱い偏りも、
          ここには分布として現れます。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. ③ 頑健性の3点セット</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>順位版 F（Kruskal–Wallis 相当）</b>：値を族内の順位に置き換えて同じ F を計算します。
            置換は族内のプールを動かさないので順位は各観測に貼り付いたまま移動し、
            これがそのまま KW の置換分布になります。<b>裾の厚さの影響を完全に除去</b>します。
          </li>
          <li>
            <b>刈り込み版 F</b>：族内の上下 2.5% を切り詰め（winsorize）た値で F を計算します。
            順位版が「順序しか使わない」のに対し、こちらは<b>大きさの情報を残しつつ極値だけを潰す</b>
            中間的な検定です。
          </li>
          <li>
            <b>1週抜き（leave-one-week-out）</b>：各週を1つずつ除いて F を再計算し、
            最も落ちる週を報告します。低下率が 30% を超えるなら、あなたは構造ではなく
            <b>1つの事件</b>を見ています。
          </li>
          <li>
            <b>年別の符号一致率</b>：|t| 最大のスロットについて、年ごとの平均が
            全期間の符号と一致した割合。運用は年単位で行われるので、ここが 70% を割る構造は
            全期間 p 値が示すよりずっと危険です。
          </li>
        </ul>
        <p>
          <b>読み方の要点</b>：生 F が棄却して順位版が棄却しないとき、それは
          「特定の曜日に極端な日が偏っていた」ことを意味します。これは<b>平均のズレではなく
          分散・裾の構造</b>なので、方向性のトレードには使えません（⑤へ）。
        </p>

        <p className="font-medium text-gray-700 mt-3">6. ④ 層別置換による交絡の切り分け</p>
        <p>
          層別置換とは、シャッフルの範囲を層の内側に閉じ込めることです。層で説明できる分は
          実測とヌルの両方から同時に消えるので、<b>残った棄却は「層を超えた曜日効果」</b>だけになります。
        </p>
        <p>
          ここで重要なのは、<b>どの交絡が本当に交絡なのか</b>を正しく見極めることです。
          基準の帰無は「週の中で」しか置換しません。したがって：
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>週レベルの属性は既に条件付けされている</b>——月内で何週目か、その週の営業日数
            （4日週か5日週か）、週次のボラティリティ水準。これらはリターンが週をまたがない以上、
            原理的に交絡になりえません。層別軸として追加しても何も起きません。
          </li>
          <li>
            <b>交絡になりうるのは日レベルの属性だけ</b>——週の中で特定の曜日に貼り付くもの。
            連休明けは（月曜が祝日なら）火曜に貼り付き、月末最終営業日はその月ごとに
            特定の曜日に落ち、大きな米国変動があった翌日は特定の曜日になります。
          </li>
        </ul>
        <p>
          <b>有効置換率</b>は、サイズ2以上のブロックに属する観測の割合です。層を細かく切りすぎると
          ブロックが1個ずつに割れ、値が動かせなくなります。このとき検定は必ず「棄却しない」——
          しかしそれは<b>交絡の証明ではなく検出力の消滅</b>です。有効置換率が 50% を下回った軸の
          p 値を「代理だった証拠」として読んではいけません。
        </p>

        <p className="font-medium text-gray-700 mt-3">7. ⑤ Brown–Forsythe（平均か分散か）</p>
        <p>
          各観測をそのスロットの<b>中央値からの絶対偏差</b>に置き換えます：
        </p>
        <p className="pl-2">{"z_si = | r_si − median_s |"}</p>
        <p>
          この <i>z</i> に対して同じ一元配置 F を計算したものが Brown–Forsythe 統計量です。
          平均ではなく中央値を使うのが Levene 検定との違いで、
          <b>リターンのように裾が厚い分布では中央値版でなければ検定が壊れます</b>。
          置換ごとにスロットの中央値は変わるので、毎反復で再計算しています。
        </p>
        <p>
          曜日ボラ構造は方向を与えないので「月曜に買う」といった判断には使えませんが、
          <b>建玉サイズ・損切り幅・オプションの期日選択には直結します</b>。
          σ が 1.3 倍違うスロットで同じ枚数を建てるのは、リスク量を 1.3 倍にしているのと同じです。
          実務上、平均差より分散差のほうが安定して検出されます（平均は SNR が低いため）。
        </p>

        <p className="font-medium text-gray-700 mt-3">8. 直感的な例え</p>
        <p>
          クラス40人にテストをさせて「最高点の生徒は本当に優秀か」を問うとします。
          F 検定は「このクラスに点差はあるか」を答えるだけで、誰が優秀かは答えません。
          最高点の生徒を後から指差すのは<b>くじ引きの当選者を予言者と呼ぶ</b>のと同じです。
          maxT 置換は「答案をシャッフルして最高点を何度も測り、
          <b>ただのくじ引きで最高点がどこまで行くか</b>を先に確かめる」作業にあたります。
          その水準を超えた生徒だけが優秀です。
        </p>
        <p>
          層別置換はここに条件を足します。「同じ塾に通っている生徒どうしでだけ答案を
          シャッフルする」と、塾の効果は実測とヌルの両方から消え、残るのは
          <b>塾では説明できない個人の実力</b>だけになります。連休文脈や月内位置での層別は、
          まさにこれをやっています。
        </p>

        <p className="font-medium text-gray-700 mt-3">9. 結果の読み方（推奨する順番）</p>
        <ol className="list-decimal pl-4 space-y-1">
          <li>
            <b>①の赤線を超えた棒があるか</b>。無ければここで終わりです。橙の棒は
            「素朴な分析なら発見と報告されていたが、多重性を数えると消えるもの」で、
            むしろ<b>これが見えることが本分析の価値</b>です。
          </li>
          <li>
            <b>②でその棒が族の F を独占しているか</b>。独占していれば単一スロットの仮説、
            散っていれば「曜日全体で形が違う」という別の主張になります。
          </li>
          <li>
            <b>③で順位版・刈り込み版も棄却しているか、1週抜きで崩れないか、年別の符号が揃うか</b>。
            どれか1つでも割れたら、そこで止めるのが正しい運用です。
          </li>
          <li>
            <b>④で層別しても生き残るか</b>。有効置換率を必ず併読すること。
            週末ギャップについては<b>休場暦日数の層別が必須</b>です。
          </li>
          <li>
            <b>⑤で平均側と分散側のどちらに構造があるかを確定</b>。分散側だけなら、
            方向のトレードではなくサイジングの話になります。
          </li>
          <li>
            ここまで生き残ったスロットだけを、ヌル較正のウォークフォワードと
            タイミング価値検定（cal-timing-value）に渡します。
          </li>
        </ol>

        <p className="font-medium text-gray-700 mt-3">10. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>建玉を置くスロットを1つに絞る根拠として使う</b>。10スロットの最適組合せではなく、
            ①で補正 p を通った<b>単一スロット</b>だけを建てる。これが「発見」に対応する最小の建玉です。
          </li>
          <li>
            <b>平均 bp をコストと直接比較する</b>。①の表の平均が往復コスト（スプレッド＋手数料）を
            下回るなら、統計的に有意でも経済的には無意味です。日中スロットの往復は
            通常 5〜10bp 以上を要求します。
          </li>
          <li>
            <b>⑤の σ でサイズを決める</b>。同じ枚数ではなく、σ に反比例した枚数にすることで
            スロット間のリスクを揃えられます。
          </li>
          <li>
            <b>④で代理と判明したら、代理のほうを直接使う</b>。連休明けや月末が正体なら、
            それは暦から<b>事前に完全に分かる</b>ので、曜日より使いやすい条件です。
            発見が壊れたのではなく、発見の中身が変わっただけです。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">11. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>この分析はあなたの探索履歴全体を補正しません</b>。maxT が数えているのは
            「この族の13スロット」だけです。銘柄選択・期間選択・日内エッジスキャン・
            条件付き分析まで含めた真の試行数はもっと大きく、ここで補正 p &lt; 0.05 が出ても
            それは<b>この1回の検定の中での多重性</b>にすぎません。
          </li>
          <li>
            <b>週末ギャップの族は標本数が少ない</b>。10年で約500週、そのうち非標準ペアは
            数十回しかありません。少数群は t が暴れて maxT の臨界値を押し上げ、
            他のスロットの検出力を奪います。「週末ペア最小n」を下げるときはこの副作用を意識してください。
          </li>
          <li>
            <b>週末ギャップの置換は週の時間順序を壊します</b>。値を週をまたいで入れ替えるため、
            週次のボラティリティ・クラスタリングは保存されません。ペアのラベル効果を
            検定するには十分ですが、この帰無を他の目的に流用しないでください。
          </li>
          <li>
            <b>層別軸は互いに独立に評価しています</b>。連休文脈と月内位置を<b>同時に</b>
            層別した場合の結果は表にありません（ブロックが割れて有効置換率が急落するため）。
            2つ以上の交絡が同時に効いている場合、本分析は過小評価します。
          </li>
          <li>
            <b>単一銘柄・10年では検出力が足りません</b>。t = SR·√T なので、10年で t = 3 に
            届くには年率シャープ 0.95 が必要です。しかも maxT はさらに高い臨界値を要求します。
            <b>補正 p が大きいことは「構造が無い」証明ではなく、多くの場合
            「この標本では何も言えない」という意味</b>です。横断（複数銘柄プール）で
            標本を増やすのが本筋で、それは pf-weekday-cross-section の担当です。
          </li>
          <li>
            棄却しても「曜日に何かある」以上のことは言えません。④で潰せる交絡は
            実装した軸だけであり、SQ・決算集中日・指数リバランスなど未実装の暦要因は
            残っています。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
