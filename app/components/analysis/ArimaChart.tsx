"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries, SERIES_MODE_LABELS } from "../../lib/series-mode";
import { confidenceBound, type ACFPoint } from "../../lib/autocorrelation";
import { qqPlot } from "../../lib/distribution";
import {
  type SarimaSpec,
  type GridRanges,
  formatSpec,
} from "../../lib/sarima";
import type { SarimaWorkerResponse } from "../../lib/sarima.worker";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

const SEASON_OPTIONS = [
  { value: 0, label: "なし" },
  { value: 5, label: "週次 (5)" },
  { value: 21, label: "月次 (21)" },
  { value: 63, label: "四半期 (63)" },
  { value: 252, label: "年次 (252)" },
];

const RANGES: GridRanges = {
  pMax: 3,
  dMax: 2,
  qMax: 3,
  PMax: 1,
  DMax: 1,
  QMax: 1,
};

export default function ArimaChart({ prices, seriesMode }: Props) {
  const { values, times } = useMemo(
    () => extractSeries(prices, seriesMode),
    [prices, seriesMode]
  );

  const [season, setSeason] = useState(0);
  const [horizon, setHorizon] = useState(20);
  const [manualSpec, setManualSpec] = useState<SarimaSpec | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [loading, setLoading] = useState(true);
  const [resp, setResp] = useState<SarimaWorkerResponse | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  // Worker 起動
  useEffect(() => {
    const worker = new Worker(
      new URL("../../lib/sarima.worker.ts", import.meta.url)
    );
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<SarimaWorkerResponse>) => {
      if (ev.data.reqId !== reqIdRef.current) return; // 古い応答は破棄
      setResp(ev.data);
      setLoading(false);
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // 計算リクエスト送信
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || values.length < 60) {
      if (values.length < 60) setLoading(false);
      return;
    }
    const reqId = ++reqIdRef.current;
    setLoading(true);
    worker.postMessage({
      reqId,
      values,
      s: season,
      horizon,
      ranges: RANGES,
      manualSpec,
      topN: 8,
    });
  }, [values, season, horizon, manualSpec]);

  // season 変更時は手動指定をリセット
  const handleSeasonChange = (s: number) => {
    setSeason(s);
    setManualSpec(null);
  };

  const fit = resp?.fit ?? null;
  const forecast = resp?.forecast ?? null;
  const diag = resp?.diagnostics ?? null;

  // ---- 予測チャート (lightweight-charts) ----
  const fcRef = useRef<HTMLDivElement>(null);
  const fcApi = useRef<IChartApi | null>(null);
  useEffect(() => {
    if (!fcRef.current || !fit || !forecast) return;
    if (fcApi.current) {
      fcApi.current.remove();
      fcApi.current = null;
    }
    const chart = createChart(fcRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: fcRef.current.clientWidth,
      height: 260,
      timeScale: { timeVisible: false },
    });
    fcApi.current = chart;

    const showN = Math.min(120, values.length);
    const start = values.length - showN;

    const actual = chart.addSeries(LineSeries, {
      color: "#2563eb",
      lineWidth: 2,
      title: "実績",
    });
    actual.setData(
      values
        .slice(start)
        .map((v, i) => ({ time: times[start + i] as Time, value: v }))
    );

    const fittedData = fit.fitted
      .map((v, i) =>
        !isNaN(v) && i >= start ? { time: times[i] as Time, value: v } : null
      )
      .filter(Boolean) as { time: Time; value: number }[];
    if (fittedData.length) {
      const fs = chart.addSeries(LineSeries, {
        color: "#f59e0b",
        lineWidth: 1,
        lineStyle: 2,
        title: "フィット",
      });
      fs.setData(fittedData);
    }

    if (forecast.point.length) {
      const fTimes = generateFutureDates(times[times.length - 1], forecast.point.length);
      const ps = chart.addSeries(LineSeries, {
        color: "#059669",
        lineWidth: 2,
        title: "予測",
      });
      ps.setData(fTimes.map((t, i) => ({ time: t as Time, value: forecast.point[i] })));

      const us = chart.addSeries(LineSeries, {
        color: "#059669",
        lineWidth: 1,
        lineStyle: 2,
        title: "95%上限",
      });
      us.setData(fTimes.map((t, i) => ({ time: t as Time, value: forecast.upper95[i] })));

      const ls = chart.addSeries(LineSeries, {
        color: "#059669",
        lineWidth: 1,
        lineStyle: 2,
        title: "95%下限",
      });
      ls.setData(fTimes.map((t, i) => ({ time: t as Time, value: forecast.lower95[i] })));
    }

    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => {
      if (fcRef.current && fcApi.current)
        fcApi.current.applyOptions({ width: fcRef.current.clientWidth });
    });
    ro.observe(fcRef.current);
    return () => {
      ro.disconnect();
      if (fcApi.current) {
        fcApi.current.remove();
        fcApi.current = null;
      }
    };
  }, [fit, forecast, values, times]);

  // ---- 残差チャート ----
  const rsRef = useRef<HTMLDivElement>(null);
  const rsApi = useRef<IChartApi | null>(null);
  useEffect(() => {
    if (!rsRef.current || !fit) return;
    if (rsApi.current) {
      rsApi.current.remove();
      rsApi.current = null;
    }
    const chart = createChart(rsRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: rsRef.current.clientWidth,
      height: 110,
      timeScale: { timeVisible: false },
    });
    rsApi.current = chart;
    const data = fit.residuals
      .map((v, i) => (!isNaN(v) ? { time: times[i] as Time, value: v } : null))
      .filter(Boolean) as { time: Time; value: number }[];
    if (data.length) {
      const s = chart.addSeries(LineSeries, {
        color: "#94a3b8",
        lineWidth: 1,
        title: "残差",
      });
      s.setData(data);
      chart.timeScale().fitContent();
    }
    const ro = new ResizeObserver(() => {
      if (rsRef.current && rsApi.current)
        rsApi.current.applyOptions({ width: rsRef.current.clientWidth });
    });
    ro.observe(rsRef.current);
    return () => {
      ro.disconnect();
      if (rsApi.current) {
        rsApi.current.remove();
        rsApi.current = null;
      }
    };
  }, [fit, times]);

  // ---- Canvas: ACF/PACF・QQ ----
  const seriesAcfRef = useRef<HTMLCanvasElement>(null);
  const seriesPacfRef = useRef<HTMLCanvasElement>(null);
  const residAcfRef = useRef<HTMLCanvasElement>(null);
  const residPacfRef = useRef<HTMLCanvasElement>(null);
  const qqRef = useRef<HTMLCanvasElement>(null);

  const nResid = useMemo(
    () => (fit ? fit.residuals.filter((v) => !isNaN(v)).length : 0),
    [fit]
  );

  useEffect(() => {
    if (resp?.diffAcf) {
      const bound = confidenceBound(resp.diffAcf.w.length);
      if (seriesAcfRef.current)
        drawACF(seriesAcfRef.current, resp.diffAcf.acf, bound, "差分系列 ACF");
      if (seriesPacfRef.current)
        drawACF(seriesPacfRef.current, resp.diffAcf.pacf, bound, "差分系列 PACF");
    }
    if (diag) {
      const bound = confidenceBound(nResid);
      if (residAcfRef.current)
        drawACF(residAcfRef.current, diag.residAcf, bound, "残差 ACF");
      if (residPacfRef.current)
        drawACF(residPacfRef.current, diag.residPacf, bound, "残差 PACF");
    }
    if (fit && qqRef.current) {
      const r = fit.residuals.filter((v) => !isNaN(v));
      drawQQ(qqRef.current, qqPlot(r));
    }
  }, [resp, diag, fit, nResid]);

  const setSpecField = useCallback(
    (field: keyof SarimaSpec, val: number) => {
      const base: SarimaSpec =
        manualSpec ?? fit?.spec ?? { p: 1, d: 1, q: 0, P: 0, D: 0, Q: 0, s: season };
      const next = { ...base, [field]: val, s: season };
      if (season <= 1) {
        next.P = 0;
        next.D = 0;
        next.Q = 0;
      }
      setManualSpec(next);
    },
    [manualSpec, fit, season]
  );

  const modeLabel = SERIES_MODE_LABELS[seriesMode];

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">
        SARIMA モデル推定・予測
      </h3>
      <p className="text-xs text-gray-400 mb-3">
        入力系列: {modeLabel}（季節・差分・自己回帰・移動平均を統合した時系列モデル）
      </p>

      {/* コントロール */}
      <div className="flex flex-wrap items-center gap-3 mb-3 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-gray-500">季節周期 s</span>
          <select
            value={season}
            onChange={(e) => handleSeasonChange(Number(e.target.value))}
            className="border rounded px-1 py-0.5"
          >
            {SEASON_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-gray-500">予測 {horizon}日</span>
          <input
            type="range"
            min={5}
            max={60}
            step={1}
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
          />
        </label>
        <button
          onClick={() => setShowManual((v) => !v)}
          className="text-blue-600 hover:underline"
        >
          {showManual ? "手動設定を隠す" : "手動でモデルを指定"}
        </button>
        {manualSpec && (
          <button
            onClick={() => setManualSpec(null)}
            className="text-gray-500 hover:underline"
          >
            自動選択に戻す
          </button>
        )}
      </div>

      {/* 手動 spec */}
      {showManual && (
        <div className="flex flex-wrap gap-3 mb-3 p-2 bg-gray-50 rounded text-xs">
          {(["p", "d", "q"] as const).map((f) => (
            <Stepper
              key={f}
              label={f}
              value={(manualSpec ?? fit?.spec)?.[f] ?? 0}
              max={f === "d" ? RANGES.dMax : RANGES.qMax}
              onChange={(v) => setSpecField(f, v)}
            />
          ))}
          {season > 1 &&
            (["P", "D", "Q"] as const).map((f) => (
              <Stepper
                key={f}
                label={f}
                value={(manualSpec ?? fit?.spec)?.[f] ?? 0}
                max={1}
                onChange={(v) => setSpecField(f, v)}
              />
            ))}
        </div>
      )}

      {loading && (
        <div className="text-xs text-gray-400 py-6 text-center animate-pulse">
          モデルを推定中…（グリッド探索）
        </div>
      )}

      {!loading && values.length < 60 && (
        <div className="text-xs text-gray-400 py-6 text-center">
          データが不足しています（60点以上必要）
        </div>
      )}

      {!loading && fit && (
        <>
          {/* 最適モデル要約 */}
          <div className="bg-blue-50 text-blue-800 rounded p-2 text-xs mb-3">
            <span className="font-semibold">
              {manualSpec ? "指定モデル: " : "最適モデル: "}
              {formatSpec(fit.spec)}
            </span>
            <span className="ml-2">
              AIC={fit.aic.toFixed(1)} / BIC={fit.bic.toFixed(1)} / logL=
              {fit.loglik.toFixed(1)} / σ={Math.sqrt(fit.sigma2).toFixed(6)}
            </span>
          </div>

          {/* 推定モデル式 */}
          <div className="mb-3 text-xs">
            <div className="text-gray-500 mb-1">推定モデル式</div>
            <div className="font-mono bg-gray-50 rounded p-2 break-all leading-relaxed">
              {buildEquation(fit)}
            </div>
          </div>

          {/* 係数表 */}
          {fit.coeffStats.length > 0 && (
            <div className="mb-3 overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-gray-500 border-b">
                    <th className="text-left py-1 pr-2">係数</th>
                    <th className="text-right px-2">推定値</th>
                    <th className="text-right px-2">標準誤差</th>
                    <th className="text-right px-2">t値</th>
                    <th className="text-right px-2">p値</th>
                    <th className="text-center pl-2">有意</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {fit.coeffStats.map((c) => (
                    <tr key={c.name} className="border-b border-gray-50">
                      <td className="py-1 pr-2">{c.name}</td>
                      <td className="text-right px-2">{c.est.toFixed(4)}</td>
                      <td className="text-right px-2 text-gray-500">
                        {c.se.toFixed(4)}
                      </td>
                      <td className="text-right px-2">{c.t.toFixed(2)}</td>
                      <td className="text-right px-2">{c.pValue.toFixed(3)}</td>
                      <td className="text-center pl-2">
                        {c.pValue < 0.01
                          ? "***"
                          : c.pValue < 0.05
                          ? "**"
                          : c.pValue < 0.1
                          ? "*"
                          : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 候補ランキング */}
          {resp && resp.candidates.length > 0 && (
            <div className="mb-3">
              <div className="text-xs text-gray-500 mb-1">
                候補モデル（AIC昇順・クリックで選択）
              </div>
              <div className="flex flex-wrap gap-1">
                {resp.candidates.map((cand, i) => {
                  const selected = formatSpec(cand.spec) === formatSpec(fit.spec);
                  return (
                    <button
                      key={i}
                      onClick={() => setManualSpec(cand.spec)}
                      className={`text-xs font-mono px-2 py-0.5 rounded border ${
                        selected
                          ? "bg-blue-600 text-white border-blue-600"
                          : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                      }`}
                      title={`AIC=${cand.aic.toFixed(1)} BIC=${cand.bic.toFixed(1)}`}
                    >
                      {formatSpec(cand.spec)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 予測チャート */}
          <div className="text-xs text-gray-500 mb-1">
            実績 + フィット + 予測 ({horizon}日先・95%信頼区間)
          </div>
          <div ref={fcRef} />

          {/* 残差チャート */}
          <div className="text-xs text-gray-500 mb-1 mt-3">モデル残差</div>
          <div ref={rsRef} />

          {/* 診断: 系列 ACF/PACF */}
          <div className="mt-4">
            <div className="text-xs font-medium text-gray-600 mb-1">
              差分系列の自己相関（次数 p, q の同定）
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="w-full overflow-hidden rounded border border-gray-100">
                <canvas ref={seriesAcfRef} />
              </div>
              <div className="w-full overflow-hidden rounded border border-gray-100">
                <canvas ref={seriesPacfRef} />
              </div>
            </div>
          </div>

          {/* 診断: 残差 ACF/PACF */}
          <div className="mt-3">
            <div className="text-xs font-medium text-gray-600 mb-1">
              残差の自己相関（モデル適合度・帯内なら良好）
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="w-full overflow-hidden rounded border border-gray-100">
                <canvas ref={residAcfRef} />
              </div>
              <div className="w-full overflow-hidden rounded border border-gray-100">
                <canvas ref={residPacfRef} />
              </div>
            </div>
          </div>

          {/* 診断パネル */}
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Ljung-Box */}
            {diag && (
              <div className="p-2 bg-gray-50 rounded text-xs">
                <div className="font-medium text-gray-600 mb-1">
                  Ljung-Box 検定（残差の白色性）
                </div>
                <div className="font-mono">
                  Q({diag.ljungBox.lags})={diag.ljungBox.stat.toFixed(2)} / df=
                  {diag.ljungBox.df} / p={diag.ljungBox.pValue.toFixed(3)}
                </div>
                <div
                  className={
                    diag.ljungBox.pValue > 0.05 ? "text-green-600" : "text-orange-600"
                  }
                >
                  {diag.ljungBox.pValue > 0.05
                    ? "✓ 残差はホワイトノイズと整合（モデル適合良好）"
                    : "✗ 残差に自己相関が残存（次数の見直し推奨）"}
                </div>
              </div>
            )}
            {/* Jarque-Bera */}
            {diag && (
              <div className="p-2 bg-gray-50 rounded text-xs">
                <div className="font-medium text-gray-600 mb-1">
                  残差正規性（Jarque-Bera）
                </div>
                <div className="font-mono">
                  JB={diag.jarqueBera.stat.toFixed(2)} / p=
                  {diag.jarqueBera.pValue.toFixed(3)} / 歪度=
                  {diag.jarqueBera.skew.toFixed(2)} / 尖度=
                  {diag.jarqueBera.kurt.toFixed(2)}
                </div>
                <div
                  className={
                    diag.jarqueBera.pValue > 0.05 ? "text-green-600" : "text-orange-600"
                  }
                >
                  {diag.jarqueBera.pValue > 0.05
                    ? "✓ 正規分布と整合（信頼区間が妥当）"
                    : "✗ 非正規（裾が厚い／歪み・信頼区間は過小評価の恐れ）"}
                </div>
              </div>
            )}
            {/* ADF / KPSS */}
            {resp?.adfLevel && (
              <div className="p-2 bg-gray-50 rounded text-xs">
                <div className="font-medium text-gray-600 mb-1">
                  単位根検定（差分次数 d の根拠）
                </div>
                <div className="font-mono">
                  ADF(原)={resp.adfLevel.testStat.toFixed(2)} p=
                  {resp.adfLevel.pValue.toFixed(3)}
                  {resp.adfDiff &&
                    ` / ADF(差分)=${resp.adfDiff.testStat.toFixed(2)} p=${resp.adfDiff.pValue.toFixed(3)}`}
                </div>
                <div className="text-gray-500">
                  {resp.adfLevel.isStationary
                    ? "原系列は定常（d=0 で可）"
                    : "原系列は非定常（d≥1 が必要）"}
                  {resp.kpssLevel &&
                    ` / KPSS: ${resp.kpssLevel.isStationary ? "定常" : "非定常"}`}
                </div>
              </div>
            )}
            {/* QQ プロット */}
            <div className="p-2 bg-gray-50 rounded">
              <div className="text-xs font-medium text-gray-600 mb-1">
                残差 QQ プロット
              </div>
              <div className="w-full overflow-hidden">
                <canvas ref={qqRef} />
              </div>
            </div>
          </div>
        </>
      )}

      <AnalysisGuide title="SARIMAモデルの詳細理論">
        <p className="font-medium text-gray-700">1. SARIMAとは</p>
        <p>
          SARIMA（季節自己回帰和分移動平均モデル）は、時系列を
          <b>自己回帰(AR)</b>・<b>移動平均(MA)</b>・<b>差分(I)</b>に加えて
          <b>季節成分</b>まで取り込んだモデルです。「昨日までの流れ（AR）」と
          「直近の予測の外れ方（MA）」、さらに「曜日や月ごとの周期的なクセ（季節）」
          を同時に考慮して将来を予測します。天気予報で「昨日の気温」だけでなく
          「例年この時期の傾向」も使うのと同じ発想です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式（バックシフト演算子 B）</p>
        <p>
          {"B はラグ演算子（B·y_t = y_{t-1}）。SARIMA(p,d,q)(P,D,Q)_s は"}
          <br />
          {"φ(B)·Φ(Bˢ)·(1−B)ᵈ·(1−Bˢ)ᴰ·y_t = c + θ(B)·Θ(Bˢ)·ε_t"}
          <br />
          {"φ(B)=1−φ₁B−…−φ_pBᵖ （非季節AR）"}
          <br />
          {"Φ(Bˢ)=1−Φ₁Bˢ−…−Φ_PB^{sP} （季節AR）"}
          <br />
          {"θ(B)=1+θ₁B+…+θ_qB^q （非季節MA）"}
          <br />
          {"Θ(Bˢ)=1+Θ₁Bˢ+…+Θ_QB^{sQ} （季節MA）"}
          <br />
          {"(1−B)ᵈ=d階差分、(1−Bˢ)ᴰ=s期離れた季節差分、ε_t=ホワイトノイズ"}
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>自己回帰(AR)</b>: 過去の自分自身の値で現在を説明する項。</li>
          <li><b>移動平均(MA)</b>: 過去の予測誤差（ショック）で現在を補正する項。</li>
          <li><b>差分(I=和分)</b>: 隣接値の引き算。トレンドを除去し定常化する操作。</li>
          <li><b>季節差分</b>: s期前との差（例: 1週間前との差）。周期的トレンドを除去。</li>
          <li><b>単位根/定常性</b>: 平均・分散が時間で一定なら「定常」。非定常なら差分が必要。</li>
          <li><b>ホワイトノイズ</b>: 自己相関のない純粋なランダム。残差がこれなら理想的。</li>
          <li><b>AIC/BIC</b>: モデルの当てはまりと複雑さのバランスを測る指標。小さいほど良い。BICはより簡潔なモデルを好む。</li>
          <li><b>Ljung-Box検定</b>: 残差に自己相関が残っていないか調べる検定。p&gt;0.05で「白色」と判断。</li>
          <li><b>Hannan-Rissanen法</b>: MA項を含むモデルを2段階の回帰で高速・安定に推定する手法。本実装が採用。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 推定とモデル選択の流れ</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>系列を差分(d)・季節差分(D)して定常化 → 差分系列のACF/PACFで次数の当たりをつける。</li>
          <li>(p,d,q)(P,D,Q) の組合せを総当たりし、AICが最小のモデルを自動選択（Web Workerで非同期計算）。</li>
          <li>MA項はHannan-Rissanen2段階法（①長いARで誤差を推定 ②その誤差を説明変数に回帰）で推定。</li>
          <li>候補ボタンやスライダーで手動指定も可能。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>係数の符号</b>: φ₁&gt;0=モメンタム（同方向継続）、φ₁&lt;0=平均回帰（反転）。</li>
          <li><b>p値（係数）</b>: 0.05未満で統計的に有意（***/**/*）。有意でない項は過剰。</li>
          <li><b>残差ACF/PACF</b>: ほぼ信頼帯（青帯）内に収まればモデルは十分。帯を超えるラグが残れば次数不足。</li>
          <li><b>Ljung-Box</b>: p&gt;0.05なら残差はホワイトノイズ＝適合良好。</li>
          <li><b>QQ/Jarque-Bera</b>: 点が直線に乗り p&gt;0.05なら正規。外れると信頼区間が過小評価。</li>
          <li><b>予測の信頼区間</b>: 急速に広がる＝予測の不確実性が高い。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>季節成分(P,D,Q)が有意 → 曜日・月次などのアノマリー（周期的クセ）が存在する可能性。</li>
          <li>AR/MA項が有意 → 自己相関があり短期方向性の予測やテクニカルが効く余地。</li>
          <li>有意な項が無くR²/適合が低い → ランダムウォークに近く、効率的市場と整合（予測困難）。</li>
          <li>予測点と信頼区間を、ポジションサイズやリスク許容度の参考に。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>株価のSARIMA予測は一般に精度が低い（効率的市場仮説）。点予測の過信は禁物。</li>
          <li>過剰なパラメータは過剰適合を招く。AIC/BICと有意性で簡潔なモデルを選ぶ。</li>
          <li>構造変化（regime shift）がある区間では過去のパラメータが将来に通用しない。</li>
          <li>Hannan-Rissanenは近似最尤であり、小標本では厳密MLEと係数が乖離しうる。</li>
          <li>信頼区間は残差の正規性・等分散・定常性を前提。ボラティリティクラスタリングがある場合は過小評価になりやすい（GARCH併用を検討）。</li>
          <li>入力系列がリターン系のとき、追加の差分dは意味が重複しうる（通常d=0が選ばれる）。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

// ---- Stepper ----
function Stepper({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-gray-500 w-4">{label}</span>
      <button
        className="w-5 h-5 border rounded disabled:opacity-30"
        disabled={value <= 0}
        onClick={() => onChange(Math.max(0, value - 1))}
      >
        −
      </button>
      <span className="font-mono w-4 text-center">{value}</span>
      <button
        className="w-5 h-5 border rounded disabled:opacity-30"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        +
      </button>
    </div>
  );
}

// ---- 推定モデル式の文字列化 ----
function buildEquation(fit: {
  spec: SarimaSpec;
  c: number;
  ar: number[];
  ma: number[];
  sar: number[];
  sma: number[];
}): string {
  const { spec } = fit;
  const s = spec.s;
  const arStr = poly("B", fit.ar, "φ", -1);
  const sarStr = s > 1 && fit.sar.length ? poly(`B^${s}`, fit.sar, "Φ", -1) : "";
  const maStr = poly("B", fit.ma, "θ", 1);
  const smaStr = s > 1 && fit.sma.length ? poly(`B^${s}`, fit.sma, "Θ", 1) : "";
  const dStr = spec.d ? `(1−B)${spec.d > 1 ? "^" + spec.d : ""}` : "";
  const DStr = spec.D && s > 1 ? `(1−B^${s})${spec.D > 1 ? "^" + spec.D : ""}` : "";

  const lhs = `${arStr}${sarStr}${dStr}${DStr} y_t`;
  const rhs = `${fit.c >= 0 ? "" : "−"}${Math.abs(fit.c).toExponential(2)} + ${maStr}${smaStr} ε_t`;
  return `${lhs} = ${rhs}`;
}

// poly: 1 (±) coeff·B ... sign=-1 → "1 − 0.32B"、sign=1 → "1 + 0.32B"
function poly(base: string, coeffs: number[], _sym: string, sign: number): string {
  if (!coeffs.length) return "";
  let out = "(1";
  coeffs.forEach((c, i) => {
    const v = sign * c; // 表示用の実係数（AR は −φ）
    const sgn = v >= 0 ? " + " : " − ";
    const power = i === 0 ? base : `${base}${base.includes("^") ? "·" + (i + 1) : "^" + (i + 1)}`;
    out += `${sgn}${Math.abs(v).toFixed(3)}${power}`;
  });
  out += ")";
  return out;
}

// ---- ACF/PACF Canvas 描画（ACFChart のパターンを踏襲）----
function drawACF(
  canvas: HTMLCanvasElement,
  data: ACFPoint[],
  bound: number,
  title: string
) {
  const parent = canvas.parentElement;
  if (!parent) return;
  const width = parent.clientWidth || 320;
  const height = 170;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);

  const margin = { top: 20, right: 10, bottom: 20, left: 40 };
  const pw = width - margin.left - margin.right;
  const ph = height - margin.top - margin.bottom;
  const plot = data.filter((d) => d.lag > 0);
  if (!plot.length) return;

  const maxLag = plot[plot.length - 1].lag;
  const maxVal = Math.max(1, ...plot.map((d) => Math.abs(d.value)));
  const barW = Math.max(2, pw / maxLag - 2);
  const toX = (lag: number) => margin.left + (lag / maxLag) * pw;
  const toY = (v: number) => margin.top + ph / 2 - (v / maxVal) * (ph / 2);

  ctx.fillStyle = "rgba(59,130,246,0.1)";
  ctx.fillRect(margin.left, toY(bound), pw, toY(-bound) - toY(bound));
  ctx.strokeStyle = "rgba(59,130,246,0.4)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(margin.left, toY(bound));
  ctx.lineTo(width - margin.right, toY(bound));
  ctx.moveTo(margin.left, toY(-bound));
  ctx.lineTo(width - margin.right, toY(-bound));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = "#999";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(margin.left, toY(0));
  ctx.lineTo(width - margin.right, toY(0));
  ctx.stroke();

  for (const d of plot) {
    const x = toX(d.lag) - barW / 2;
    const y0 = toY(0);
    const y1 = toY(d.value);
    ctx.fillStyle = Math.abs(d.value) > bound ? "#ef4444" : "#3b82f6";
    ctx.fillRect(x, Math.min(y0, y1), barW, Math.abs(y1 - y0));
  }

  ctx.fillStyle = "#333";
  ctx.font = "bold 11px sans-serif";
  ctx.fillText(title, margin.left + 5, margin.top - 5);
  ctx.fillStyle = "#999";
  ctx.font = "10px sans-serif";
  ctx.fillText("Lag", width / 2 - 8, height - 3);
}

// ---- QQ プロット Canvas ----
function drawQQ(
  canvas: HTMLCanvasElement,
  pts: { theoretical: number; observed: number }[]
) {
  const parent = canvas.parentElement;
  if (!parent) return;
  const width = parent.clientWidth || 280;
  const height = 180;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx || !pts.length) return;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);

  const margin = { top: 10, right: 10, bottom: 24, left: 36 };
  const pw = width - margin.left - margin.right;
  const ph = height - margin.top - margin.bottom;
  const xs = pts.map((p) => p.theoretical).filter(isFinite);
  const ys = pts.map((p) => p.observed).filter(isFinite);
  const xMin = Math.min(...xs),
    xMax = Math.max(...xs);
  const yMin = Math.min(...ys),
    yMax = Math.max(...ys);
  const lo = Math.min(xMin, yMin),
    hi = Math.max(xMax, yMax);
  const toX = (v: number) => margin.left + ((v - xMin) / (xMax - xMin || 1)) * pw;
  const toY = (v: number) => margin.top + ph - ((v - yMin) / (yMax - yMin || 1)) * ph;

  // y=x 基準線
  ctx.strokeStyle = "#d1d5db";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(toX(lo), toY(lo));
  ctx.lineTo(toX(hi), toY(hi));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#3b82f6";
  for (const p of pts) {
    if (!isFinite(p.theoretical) || !isFinite(p.observed)) continue;
    ctx.beginPath();
    ctx.arc(toX(p.theoretical), toY(p.observed), 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = "#999";
  ctx.font = "10px sans-serif";
  ctx.fillText("理論分位", width / 2 - 18, height - 4);
}

// ---- 将来営業日生成 ----
function generateFutureDates(lastDate: string, count: number): string[] {
  const dates: string[] = [];
  const d = new Date(lastDate);
  let added = 0;
  while (added < count) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    dates.push(`${yyyy}-${mm}-${dd}`);
    added++;
  }
  return dates;
}
