"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  DEFAULT_NULL_PARAMS,
  EVAL_MODE_LABEL,
  EvalMode,
  METRIC_GROUP,
  METRIC_KEYS,
  METRIC_LABEL,
  MetricKey,
  NULL_MODE_DESC,
  NULL_MODE_LABEL,
  NullCalibParams,
  NullCalibResult,
  NullMode,
  formatMetric,
  histogram,
} from "../../lib/null-calibration";
import type {
  NullCalibWorkerRequest,
  NullCalibWorkerResponse,
} from "../../lib/null-calibration.worker";
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

function drawHistogram(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  r: NullCalibResult,
  key: MetricKey,
) {
  const ml = 40;
  const mr = 16;
  const mt = 40;
  const mb = 34;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;

  const st = r.stats[key];
  const values = r.nulls.map((m) => m[key]);
  const h = histogram(values, 48, [st.actual]);
  const lo = h.edges[0];
  const hi = h.edges[h.edges.length - 1];
  const xOf = (v: number) => ml + ((v - lo) / (hi - lo)) * plotW;
  const yOf = (c: number) => mt + plotH - (c / Math.max(1, h.max)) * plotH;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`ヌル分布（曜日構造ゼロ）における「${METRIC_LABEL[key]}」`, ml, 14);
  ctx.fillStyle = "#6b7280";
  ctx.font = "9px sans-serif";
  ctx.fillText(
    `${r.nIter}回のサロゲート / ${NULL_MODE_LABEL[r.params.mode]}${
      METRIC_GROUP[key] === "performance" ? ` / ${EVAL_MODE_LABEL[r.params.evalMode]}` : ""
    }`,
    ml,
    27,
  );

  // 左端〜95%点＝「偶然だけで届いてしまう」域（発見なし域, 淡赤）。
  // 95%点より右＝「偶然では滅多に届かない」棄却域（緑）。
  // 実測がこのどちら側に落ちるかが、そのまま「発見か/床に埋没か」を意味する。
  const x95 = xOf(st.p95);
  ctx.fillStyle = "rgba(220,38,38,0.05)";
  ctx.fillRect(ml, mt, Math.max(0, x95 - ml), plotH);
  ctx.fillStyle = "rgba(22,163,74,0.09)";
  ctx.fillRect(x95, mt, Math.max(0, ml + plotW - x95), plotH);

  for (let i = 0; i < h.counts.length; i++) {
    const x0 = xOf(h.edges[i]);
    const x1 = xOf(h.edges[i + 1]);
    const y = yOf(h.counts[i]);
    ctx.fillStyle = h.edges[i] >= st.p95 ? "rgba(22,163,74,0.45)" : "rgba(107,114,128,0.45)";
    ctx.fillRect(x0, y, Math.max(0.5, x1 - x0 - 0.5), mt + plotH - y);
  }

  ctx.strokeStyle = "#d1d5db";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ml, mt + plotH);
  ctx.lineTo(ml + plotW, mt + plotH);
  ctx.stroke();

  const vline = (v: number, color: string, dash: number[], lw: number) => {
    const x = xOf(v);
    ctx.save();
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(x, mt);
    ctx.lineTo(x, mt + plotH);
    ctx.stroke();
    ctx.restore();
    return x;
  };

  // 域ラベル（塗り分けの意味を明示）
  ctx.font = "9px sans-serif";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(220,38,38,0.55)";
  ctx.textAlign = "left";
  ctx.fillText("偶然で届く域（発見なし）", ml + 3, mt + plotH - 4);
  ctx.fillStyle = "rgba(22,163,74,0.7)";
  ctx.textAlign = "right";
  ctx.fillText("棄却域（発見）", ml + plotW - 3, mt + 10);

  const xMed = vline(st.p50, "#6b7280", [3, 3], 1); // ヌル中央値 = 偽発見の床
  vline(st.p95, "#16a34a", [4, 3], 1);
  const xAct = vline(st.actual, "#dc2626", [], 2); // 実測

  ctx.font = "9px sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "#6b7280";
  ctx.fillText(`床（ヌル中央値）${formatMetric(key, st.p50)}`, xMed, mt - 4);
  ctx.fillStyle = "#16a34a";
  ctx.fillText(`95%点 ${formatMetric(key, st.p95)}`, x95, mt + plotH + 22);
  ctx.fillStyle = "#dc2626";
  ctx.font = "bold 10px sans-serif";
  ctx.fillText(`実測 ${formatMetric(key, st.actual)}`, xAct, mt + plotH + 11);
  // 実測が「偶然域の内側か／棄却域を突破したか」を実測線の直近に注記する。
  const beyond = st.actual > st.p95;
  ctx.font = "bold 9px sans-serif";
  ctx.fillStyle = beyond ? "#16a34a" : "#dc2626";
  ctx.textAlign = beyond ? "left" : "right";
  const noteX = beyond ? Math.min(xAct + 5, ml + plotW) : Math.max(xAct - 5, ml);
  ctx.fillText(beyond ? "床を突破 →" : "← 偶然の範囲内", noteX, mt + 22);

  ctx.fillStyle = "#9ca3af";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "center";
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    ctx.fillText(formatMetric(key, v), ml + (plotW * i) / 4, mt + plotH + 32);
  }
  ctx.textAlign = "right";
  ctx.fillText(`${h.max}`, ml - 4, mt + 8);
  ctx.fillText("0", ml - 4, mt + plotH);
}

const GROUP_LABEL: Record<"structure" | "performance", string> = {
  structure: "曜日構造の検定（検出力あり／この行で判断する）",
  performance: "戦略成績（床の測定用／曜日効果の検定には使えない）",
};

export default function NullCalibrationChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  const [nIter, setNIter] = useState(DEFAULT_NULL_PARAMS.nIter);
  const [mode, setMode] = useState<NullMode>(DEFAULT_NULL_PARAMS.mode);
  const [evalMode, setEvalMode] = useState<EvalMode>(DEFAULT_NULL_PARAMS.evalMode);
  const [costBps, setCostBps] = useState(DEFAULT_NULL_PARAMS.costBps);
  const [lookback, setLookback] = useState(DEFAULT_NULL_PARAMS.lookback);
  const [metric, setMetric] = useState<MetricKey>("fIntraday");
  const [result, setResult] = useState<NullCalibResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const params: NullCalibParams = useMemo(
    () => ({ ...DEFAULT_NULL_PARAMS, nIter, mode, evalMode, costBps, lookback }),
    [nIter, mode, evalMode, costBps, lookback],
  );

  useEffect(() => {
    const worker = new Worker(new URL("../../lib/null-calibration.worker.ts", import.meta.url));
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<NullCalibWorkerResponse>) => {
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
    if (!worker || prices.length < 60) return;
    reqIdRef.current++;
    setLoading(true);
    setProgress(null);
    const req: NullCalibWorkerRequest = { reqId: reqIdRef.current, prices, params };
    worker.postMessage(req);
  }, [prices, params]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result || !result.ok) return;
    const init = initCanvas(canvas, 260);
    if (!init) return;
    drawHistogram(init.ctx, init.width, init.height, result, metric);
  }, [result, metric]);

  const fi = result?.ok ? result.stats.fIntraday : null;
  const fo = result?.ok ? result.stats.fOvernight : null;
  const tr = result?.ok ? result.stats.totalReturn : null;
  const structureFound = !!(fi?.exceeds95 || fo?.exceeds95);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-800">
          ヌル較正：曜日最適化の「偽発見の床」
        </h3>
        <span className="text-[10px] text-gray-400">
          真のエッジがゼロでも出てしまう成績を測り、実測がそれを超えているかを判定する
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-gray-500">評価方式</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={evalMode}
            onChange={(e) => setEvalMode(e.target.value as EvalMode)}
          >
            {(Object.keys(EVAL_MODE_LABEL) as EvalMode[]).map((k) => (
              <option key={k} value={k}>
                {EVAL_MODE_LABEL[k]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1">
          <span className="text-gray-500">ヌルの作り方</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={mode}
            onChange={(e) => setMode(e.target.value as NullMode)}
          >
            {(Object.keys(NULL_MODE_LABEL) as NullMode[]).map((k) => (
              <option key={k} value={k}>
                {NULL_MODE_LABEL[k]}
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
            {[200, 500, 1000, 2000].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1">
          <span className="text-gray-500">コスト(bps)</span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            className="border border-gray-200 rounded px-1 py-0.5 w-14"
            value={costBps}
            onChange={(e) => setCostBps(Math.max(0, Number(e.target.value)))}
          />
        </label>

        {evalMode === "walkForward" && (
          <label className="flex items-center gap-1">
            <span className="text-gray-500">学習窓(本)</span>
            <select
              className="border border-gray-200 rounded px-1 py-0.5"
              value={lookback}
              onChange={(e) => setLookback(Number(e.target.value))}
            >
              {[63, 126, 252, 504, 0].map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? "全履歴" : v}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex items-center gap-1">
          <span className="text-gray-500">ヒストグラム</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={metric}
            onChange={(e) => setMetric(e.target.value as MetricKey)}
          >
            {METRIC_KEYS.map((k) => (
              <option key={k} value={k}>
                {METRIC_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="mt-2 text-[10px] text-gray-400 leading-relaxed">{NULL_MODE_DESC[mode]}</p>

      {/* 判定: 曜日構造の有無は F で判断する */}
      {result?.ok && fi && fo && tr && (
        <div
          className={`mt-3 rounded p-2.5 text-xs border ${
            structureFound
              ? "bg-green-50 border-green-200 text-green-900"
              : "bg-amber-50 border-amber-200 text-amber-900"
          }`}
        >
          <div className="font-semibold">
            {structureFound
              ? "曜日構造の証拠あり — ヌルの95%点を超えました"
              : "曜日構造の証拠なし — 実測はヌル分布の内側です"}
          </div>
          <div className="mt-1 leading-relaxed">
            日中 F = {fi.actual.toFixed(2)}（p = {fi.pValue.toFixed(3)}
            {fi.exceeds95 ? "・棄却" : ""}） / 週内オーバーナイト F = {fo.actual.toFixed(2)}（p ={" "}
            {fo.pValue.toFixed(3)}
            {fo.exceeds95 ? "・棄却" : ""}）。
            {structureFound
              ? "曜日ごとに平均リターンが偏っている証拠です。ただし「曜日に何かある」以上のことは言えません（月末効果やイベント日程の代理である可能性は排除できません）。"
              : "曜日ごとの平均リターンの偏りは、偶然のばらつきと区別できません。"}
          </div>
          <div className="mt-1.5 pt-1.5 border-t border-current/10 leading-relaxed">
            <b>床</b>：曜日構造が完全にゼロでも、
            {EVAL_MODE_LABEL[result.params.evalMode]}の累積リターンは中央値{" "}
            <b>{formatMetric("totalReturn", tr.p50)}</b>、95%点{" "}
            <b>{formatMetric("totalReturn", tr.p95)}</b> まで出ます。実測は{" "}
            <b>{formatMetric("totalReturn", tr.actual)}</b>（{(tr.pctile * 100).toFixed(1)}
            パーセンタイル）。
            {result.params.evalMode === "inSample" &&
              " 評価方式をウォークフォワードに切り替えると、この床がどこまで崩れるかを確認できます。"}
          </div>
        </div>
      )}

      {result && !result.ok && (
        <div className="mt-3 rounded p-2.5 text-xs bg-gray-50 border border-gray-200 text-gray-600">
          計算できません：{result.reason}
        </div>
      )}

      {loading && (
        <div className="mt-3 text-xs text-gray-400">
          計算中…{progress ? ` ${progress.done} / ${progress.total}` : ""}
        </div>
      )}

      <div className="mt-3">
        <canvas ref={canvasRef} />
      </div>

      {result?.ok && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 pr-2 font-medium">指標</th>
                <th className="text-right py-1 px-2 font-medium">実測</th>
                <th className="text-right py-1 px-2 font-medium">ヌル中央値</th>
                <th className="text-right py-1 px-2 font-medium">ヌル95%</th>
                <th className="text-right py-1 px-2 font-medium">ヌル99%</th>
                <th className="text-right py-1 px-2 font-medium">パーセンタイル</th>
                <th className="text-right py-1 pl-2 font-medium">p値</th>
              </tr>
            </thead>
            <tbody>
              {(["structure", "performance"] as const).map((g) => (
                <Fragment key={g}>
                  <tr className="bg-gray-50">
                    <td colSpan={7} className="py-1 px-1 text-[10px] font-medium text-gray-500">
                      {GROUP_LABEL[g]}
                    </td>
                  </tr>
                  {METRIC_KEYS.filter((k) => METRIC_GROUP[k] === g).map((k) => {
                    const s = result.stats[k];
                    return (
                      <tr
                        key={k}
                        className={`border-b border-gray-100 ${k === metric ? "bg-blue-50/50" : ""}`}
                      >
                        <td className="py-1 pr-2 text-gray-700">{METRIC_LABEL[k]}</td>
                        <td className="py-1 px-2 text-right font-medium text-gray-900">
                          {formatMetric(k, s.actual)}
                        </td>
                        <td className="py-1 px-2 text-right text-gray-500">
                          {formatMetric(k, s.p50)}
                        </td>
                        <td className="py-1 px-2 text-right text-gray-500">
                          {formatMetric(k, s.p95)}
                        </td>
                        <td className="py-1 px-2 text-right text-gray-500">
                          {formatMetric(k, s.p99)}
                        </td>
                        <td className="py-1 px-2 text-right text-gray-600">
                          {(s.pctile * 100).toFixed(1)}%
                        </td>
                        <td
                          className={`py-1 pl-2 text-right font-medium ${
                            g === "structure" && s.pValue < 0.05 ? "text-green-700" : "text-gray-400"
                          }`}
                        >
                          {s.pValue.toFixed(3)}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] text-gray-400 leading-relaxed">
            {result.nDays}本 / {result.nWeeks}週 / サロゲート{result.nIter}回。p値は片側モンテカルロ
            p =（ヌルが実測以上になった回数 + 1）/（反復数 + 1）。全指標「大きいほど良い／大きいほど構造あり」に符号を揃えてあります（最大DDは負値なので0に近いほど大）。
            F はリターン系列から直接計算するため<b>評価方式には依存しません</b>（全期間最適／ウォークフォワードで同じ値になります）。
          </p>
        </div>
      )}

      <AnalysisGuide title="ヌル較正の詳細理論">
        <p className="font-medium text-gray-700">1. 何をしているか</p>
        <p>
          「曜日トレード・シミュレータ」の最適プラン（bestCombination）は、週内の10スロットそれぞれで
          「買・売・無」のうち<b>実データ上で最も儲かった選択</b>を採ります。問題は、この選び方が
          <b>真のエッジがゼロでも必ずプラスを返す</b>ことです。最大値を選ぶ操作は、ノイズの上振れを
          拾い上げる操作でもあるからです。
        </p>
        <p>
          そこでこの分析は、<b>曜日構造が存在しないと分かっているデータ</b>（サロゲート）を数百〜数千本
          人工的に作り、まったく同じパイプラインを流します。そこで出てくる成績の分布が
          <b>「偽発見の床」</b>です。実データの成績がこの床を有意に超えていなければ、あなたは何も
          発見していません。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式：床が高くなる理由</p>
        <p>
          単利モードでは、スロット <i>s</i> の累積富は買で 1 + Σr、売で 1 − Σr、無で 1 です。
          最適選択はこの最大値なので：
        </p>
        <p className="pl-2">{"W_s = max(1 + Σr, 1 − Σr, 1) = 1 + |Σr|"}</p>
        <p>
          つまり<b>スロットの寄与は常に |Σr| ≥ 0 で、期待値は必ず正</b>です。真のドリフトがゼロ
          （Σr 〜 N(0, N_s·σ_s²)）でも、半正規分布の期待値から：
        </p>
        <p className="pl-2">{"E|Σr| = σ_s · √(2·N_s / π)"}</p>
        <p>
          <i>N_s</i> はそのスロットの出現回数（≒週数）、<i>σ_s</i> はスロット・リターンの標準偏差。
          10年（N_s ≈ 520）・σ_s ≈ 1% なら 1スロットあたり E|Σr| ≈ 18%。これが10スロット積み上がり、
          さらに複利で増幅されます。合成データ（エッジ完全ゼロ・10年）での実測では
          <b>累積リターンの床は中央値 +279%、95%点 +540%</b> でした。エッジゼロでこれです。
        </p>

        <p className="font-medium text-gray-700 mt-3">
          3. 決定的な注意：累積リターンでは曜日効果を検定できない
        </p>
        <p>
          置換は週内のドリフトを<b>消すのではなく、曜日間に再配置するだけ</b>です。したがって
          サロゲートは実データと同じ週次ドリフト総量を保ちます。そして最適化器は
          <b>ドリフトがどの曜日に乗っていようと拾えてしまう</b>ため、累積リターンは実データと
          サロゲートを区別できません。
        </p>
        <p>
          これは机上の懸念ではありません。合成データの月曜日中に<b>本物の +20bp/週 のエッジを
          植えて</b>検証したところ：累積リターンの p 値は <b>0.884</b>（検出失敗）、一方
          F（日中）の p 値は <b>0.003</b>（明確に棄却）でした。つまり——
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>累積リターンが測れるのは「床の高さ」だけ</b>であって、「曜日効果の有無」ではない。
          </li>
          <li>
            <b>曜日最適化の利益は曜日効果から来ていない</b>。全体ドリフト＋選択ボーナスから来ている。
          </li>
          <li>
            <b>曜日効果の有無は F 統計量で判断する</b>。表の「曜日構造の検定」行がそれです。
          </li>
        </ul>
        <p>
          F はスロット間の平均リターンのばらつき（一元配置分散分析の F 比）です。曜日効果が実在すれば
          特定スロットに平均が偏るので大きくなり、置換の下では5スロットは交換可能なので、
          これがちょうど正しい帰無分布になります。
        </p>
        <p className="pl-2">{"F = (SS_between / (k−1)) / (SS_within / (N−k))"}</p>
        <p>
          {"SS_between = Σ_s n_s (m_s − m̄)²"}（スロット平均の偏り）、
          {"SS_within = Σ_s Σ_j (r_sj − m_s)²"}（スロット内のばらつき）。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>サロゲート（代理データ）</b>：帰無仮説（＝曜日効果は無い）が真だと分かっているように
            人工的に作った価格系列。
          </li>
          <li>
            <b>置換検定</b>：実データの値を並べ替えて帰無分布を作る検定。分布を仮定しないので
            リターンの裾が厚くても妥当。
          </li>
          <li>
            <b>モンテカルロ p 値</b>：ヌルが実測以上になった割合。有限反復なのでゼロを返さないよう
            (回数+1)/(反復+1) と補正する。
          </li>
          <li>
            <b>in-sample 最適化バイアス</b>：同じデータで「選ぶ」と「測る」を両方やることで生じる
            上振れ。本分析が測っている当のもの。
          </li>
          <li>
            <b>偽発見の床</b>：エッジゼロでも到達してしまう成績水準。ヌル分布の中央値〜95%点。
          </li>
          <li>
            <b>ウォークフォワード</b>：各週の直前の履歴だけで再最適化し、その週に適用する運用。
            「選ぶ」と「測る」が時間で分離されるため床が原理的に消える。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 直感的な例え</p>
        <p>
          1000人にコインを10回ずつ投げさせると、必ず誰かが8回以上表を出します。その人を指して
          「予言者だ」と言えば明らかに誤りですが、<b>10スロットから最良の組合せを選ぶ操作は
          これと同じこと</b>をしています。ヌル較正とは「予言者を信じる前に、ただのコイン投げ大会の
          優勝者がどれくらいの成績を出すかを先に確かめておく」作業です。優勝者の平均が8回なら、
          あなたの8回には何の意味もありません。
        </p>

        <p className="font-medium text-gray-700 mt-3">6. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>まず F の行だけを見る</b>。p ≥ 0.05 なら曜日効果の証拠はありません。累積リターンが
            どれだけ立派でも、それは床の高さを見ているだけです。
          </li>
          <li>
            <b>F（日中）と F（夜間）を区別</b>：どちらが有意かで、曜日効果が日中セッションにあるのか
            オーバーナイトにあるのかが分かります。
          </li>
          <li>
            <b>累積リターンの「ヌル中央値」が最も重要な出力</b>です。これがあなたの既存の
            バックテスト成績を丸ごと飲み込む水準なら、その成績は最初から情報ゼロでした。
          </li>
          <li>
            <b>評価方式を切り替えて床を比較</b>：全期間最適の床は非常に高く、ウォークフォワードの床は
            ゼロ付近に落ちます（合成データでは +279% → −14%）。この差が「in-sample 最適化バイアスの
            正体」の可視化です。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>建玉を決める前の門番として使う</b>：曜日プランを採用する前に必ず通す。F が棄却しない
            プランに資金を置かない。
          </li>
          <li>
            <b>コスト(bps)を実際のスプレッド＋手数料に設定</b>して床と実測を同時に動かす。
            コストは実測を押し下げますが床も押し下げるので、両者の差こそが本当のエッジです。
          </li>
          <li>
            <b>期待値の較正</b>：ヌル95%点は「この銘柄・この期間で、偶然だけでどこまで良く見えるか」
            の上限。将来の期待リターンをこの水準未満に見積もる根拠になります。
          </li>
          <li>
            <b>F が棄却したときだけ</b>ウォークフォワードに進み、コスト控除後でも正なら
            それが実運用に近い期待値です。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">8. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>ヌルの作り方が結論を変えます</b>。既定の「週内スロット置換」は週末ギャップ・ボラ
            クラスタリング・日中/夜間の非対称を保存するため<b>最も保守的（床が高い＝厳しい）</b>です。
            合成データでの床の中央値は slotShuffle +267% → iid +390% と、構造を壊すほど床が
            不当に低く見えます。IID 再抽出を有意性の根拠に使ってはいけません。
          </li>
          <li>
            この検定が壊しているのは<b>曜日の割当だけ</b>です。棄却しても「曜日に何かある」以上の
            ことは言えず、それが月末効果やSQ・イベント日程の代理である可能性は排除できません。
          </li>
          <li>
            <b>週末ギャップは検定対象外</b>です。既定モードでは金曜後のギャップを固定するため、
            この F が問うているのは「週末ギャップを超えた曜日効果があるか」です。
          </li>
          <li>
            <b>この分析自体は、あなたの探索履歴全体を補正しません</b>。曜日スキャン・日内エッジ
            スキャン・銘柄選択まで含めた真の試行数はもっと大きく、DSR（walk-forward.ts）の
            nTrials はカタログ数しか数えていません。ここで p &lt; 0.05 が出ても、それは
            「この1回の検定」に対する補正にすぎません。
          </li>
          <li>
            <b>単一銘柄・10年では検出力が足りません</b>。t = SR·√T なので、10年で t = 3 に届くには
            年率シャープ0.95が必要です。p 値が大きいことは「エッジが無い」証明ではなく、多くの場合
            「この標本では何も言えない」という意味です。
          </li>
          <li>
            サロゲートは open/close のみを再構成しており、high/low・出来高はダミーです。
            この分析の枠内（スロット・リターンのみを使う）では十分ですが、他の分析に流用できません。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
