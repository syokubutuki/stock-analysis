"use client";

// as-of スナップショット: 過去のある1日に戻り、その日の画面に出ていた判断を再現して、
// その後に実際に起きたことと突き合わせる。
//
// 「あのとき何が見えていたか」を再現できることが前提で、それは蒸留層が
// 渡された価格配列しか見ない純粋関数だから成立する（prices.slice(0, k+1) を渡すだけ）。

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart, LineSeries, LineStyle,
  type IChartApi, type ISeriesApi, type Time,
} from "lightweight-charts";
import { PricePoint } from "../../lib/types";
import AnalysisGuide from "./AnalysisGuide";
import { Horizon, HORIZONS, HORIZON_CONFIG } from "../../lib/signal-digest";
import type { MarketRegime } from "../../lib/regime";
import { replayAt, FWD_HORIZONS, BAND_HORIZONS, AsOfPoint } from "../../lib/asof-replay";

interface Props {
  prices: PricePoint[];
  ticker: string;
}

const MAX_H = FWD_HORIZONS[FWD_HORIZONS.length - 1];

const DIR_LABEL: Record<string, string> = { up: "上", down: "下", flat: "中立" };
// 表記は市場状態ダッシュボード(MarketStateDashboard)と揃える
const REGIME_LABEL: Record<MarketRegime, string> = {
  uptrend: "上昇トレンド",
  downtrend: "下降トレンド",
  high_volatility: "高ボラティリティ",
  low_volatility: "低ボラティリティ",
  accelerating: "加速",
  decelerating: "減速",
};

function pct(v: number, d = 2): string {
  return isFinite(v) ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%` : "—";
}

function Card({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" | "warn" }) {
  const color = tone === "good" ? "text-green-700" : tone === "bad" ? "text-red-600" : tone === "warn" ? "text-amber-700" : "text-gray-800";
  return (
    <div className="rounded border border-gray-200 bg-white px-2 py-1.5">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-fg-muted">{sub}</div>}
    </div>
  );
}

export default function AsOfSnapshotChart({ prices, ticker }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<"Line"> | null>(null);
  const hiRef = useRef<ISeriesApi<"Line"> | null>(null);
  const loRef = useRef<ISeriesApi<"Line"> | null>(null);
  const midRef = useRef<ISeriesApi<"Line"> | null>(null);

  const [horizon, setHorizon] = useState<Horizon>("swing");

  // 選べる as-of の範囲: 蒸留層が動く最低本数 〜 最長ホライズンの実測が残る位置
  const range = useMemo(() => {
    const minBars = Math.max(60, Math.min(HORIZON_CONFIG[horizon].window, 252));
    return { min: minBars, max: prices.length - 1 - MAX_H };
  }, [prices.length, horizon]);

  // 既定は「1年前」。そこなら 63 日先まで実測が出揃っている。
  const [asOfIdx, setAsOfIdx] = useState<number>(() => Math.max(0, prices.length - 1 - 252));

  const valid = range.max >= range.min && prices.length > range.min + MAX_H;
  // 時間軸を変えると選べる範囲が動くので、描画側では常にクランプした値を使う
  // （state を書き戻すと再レンダリングが連鎖するため、派生値で吸収する）。
  const idx = Math.min(Math.max(asOfIdx, range.min), range.max);

  const point: AsOfPoint | null = useMemo(
    () => (valid ? replayAt(prices, idx, ticker, horizon) : null),
    [valid, prices, idx, ticker, horizon]
  );

  const hasChart = !!point;

  useEffect(() => {
    if (!hasChart || !containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f5f5f5" }, horzLines: { color: "#f5f5f5" } },
      width: containerRef.current.clientWidth,
      height: 260,
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: "#e5e7eb" },
      timeScale: { borderColor: "#e5e7eb" },
    });
    chartRef.current = chart;
    priceRef.current = chart.addSeries(LineSeries, { color: "#111827", lineWidth: 2, title: "終値" });
    midRef.current = chart.addSeries(LineSeries, { color: "#2563eb", lineWidth: 2, lineStyle: LineStyle.Dashed, title: "予測中央" });
    hiRef.current = chart.addSeries(LineSeries, { color: "#93c5fd", lineWidth: 1, title: "予測80%上限" });
    loRef.current = chart.addSeries(LineSeries, { color: "#93c5fd", lineWidth: 1, title: "予測80%下限" });
    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }); };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null; priceRef.current = null; hiRef.current = null; loRef.current = null; midRef.current = null;
    };
  }, [hasChart]);

  useEffect(() => {
    if (!point || !priceRef.current || !hiRef.current || !loRef.current || !midRef.current) return;
    const from = Math.max(0, point.idx - 120);
    const to = Math.min(prices.length - 1, point.idx + MAX_H);
    priceRef.current.setData(
      prices.slice(from, to + 1).map((p) => ({ time: p.time as Time, value: p.close }))
    );
    // 予測レンジは 1/5/21 日先の3点しか無いので、その3点＋起点を結んだ折れ線として描く。
    const base = point.close;
    const mid: { time: Time; value: number }[] = [{ time: prices[point.idx].time as Time, value: base }];
    const hi: typeof mid = [...mid];
    const lo: typeof mid = [...mid];
    BAND_HORIZONS.forEach((h, i) => {
      const hf = point.fc.horizons[i];
      const j = point.idx + h;
      if (!hf || j >= prices.length) return;
      const t = prices[j].time as Time;
      mid.push({ time: t, value: hf.medianPrice });
      const b80 = hf.bands.find((b) => Math.abs(b.level - 0.8) < 1e-9);
      if (b80) { hi.push({ time: t, value: b80.highPrice }); lo.push({ time: t, value: b80.lowPrice }); }
    });
    midRef.current.setData(point.fc.ok ? mid : []);
    hiRef.current.setData(point.fc.ok ? hi : []);
    loRef.current.setData(point.fc.ok ? lo : []);
    chartRef.current?.timeScale().fitContent();
  }, [point, prices]);

  if (!valid || !point) {
    return (
      <div className="text-xs text-fg-muted p-3">
        データが不足しています（時間軸「{HORIZON_CONFIG[horizon].label}」の再現には
        最低 {range.min + MAX_H} 本必要、現在 {prices.length} 本）。
      </div>
    );
  }

  const d = point.digest;
  const step = (n: number) => setAsOfIdx(Math.min(Math.max(idx + n, range.min), range.max));

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">as-of スナップショット — あの日の判断を再現して、その後と突き合わせる</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          選んだ日までの価格しか渡していないので、ここに出る判断は<span className="font-medium">その日の夜に画面へ出ていたもの</span>と同一です。
          下段でその後 1/5/21/63 営業日に実際に起きたことと照合します。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          時間軸
          <select className="border rounded px-1 py-0.5" value={horizon} onChange={(e) => setHorizon(e.target.value as Horizon)}>
            {HORIZONS.map((h) => (
              <option key={h} value={h}>{HORIZON_CONFIG[h].label}（窓{HORIZON_CONFIG[h].window}本）</option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1">
          <button onClick={() => step(-21)} className="px-1.5 py-0.5 rounded bg-gray-100 hover:bg-gray-200">≪1ヶ月</button>
          <button onClick={() => step(-5)} className="px-1.5 py-0.5 rounded bg-gray-100 hover:bg-gray-200">≪1週</button>
          <span className="font-mono font-semibold text-gray-800 px-1">{point.date}</span>
          <button onClick={() => step(5)} className="px-1.5 py-0.5 rounded bg-gray-100 hover:bg-gray-200">1週≫</button>
          <button onClick={() => step(21)} className="px-1.5 py-0.5 rounded bg-gray-100 hover:bg-gray-200">1ヶ月≫</button>
        </div>
        <input
          type="range" min={range.min} max={range.max} value={idx}
          onChange={(e) => setAsOfIdx(Number(e.target.value))}
          className="flex-1 min-w-[12rem] accent-blue-600"
        />
        <span className="text-fg-muted">
          選べる範囲 {prices[range.min].time} 〜 {prices[range.max].time}
        </span>
      </div>

      {/* ── その日に出ていた判断 ── */}
      <div>
        <div className="text-xs font-medium text-gray-700 mb-1">
          {point.date} 時点の判断（終値 {point.close.toFixed(1)}・この日までの{d.bars}本だけで計算）
        </div>
        {!d.ok && <div className="text-[11px] text-amber-700 mb-1">この時点ではデータ本数が足りず、蒸留層は判断を出しません。</div>}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-1.5">
          <Card label="方向" value={DIR_LABEL[d.direction] ?? d.direction}
            sub={`スコア ${d.regimeScore.toFixed(0)}`}
            tone={d.direction === "up" ? "good" : d.direction === "down" ? "bad" : undefined} />
          <Card label="レジーム" value={REGIME_LABEL[d.regime]} />
          <Card label="上昇確率(1日)" value={`${(d.upProb * 100).toFixed(1)}%`} />
          <Card label="ボラ予測(日次)" value={`${d.volForecastPct.toFixed(2)}%`}
            sub={d.volSpike ? "急拡大シグナル" : undefined} tone={d.volSpike ? "warn" : undefined} />
          <Card label="Hurst" value={d.hurst.toFixed(3)} sub={d.hurst < 0.5 ? "平均回帰寄り" : "持続寄り"} />
          <Card label="平均回帰z" value={d.meanRevZ.toFixed(2)} sub={`${HORIZON_CONFIG[horizon].zWindow}日平均から`} />
          <Card label="ドローダウン" value={`${d.drawdownPct.toFixed(1)}%`} />
          <Card label="CVaR95" value={`${d.cvar95Pct.toFixed(2)}%`} />
          <Card label="変化点" value={d.changePoint ? "検知" : "なし"}
            sub={`確率 ${(d.changePointProb * 100).toFixed(0)}%`} tone={d.changePoint ? "warn" : undefined} />
          {point.fc.ok && BAND_HORIZONS.map((h, i) => {
            const hf = point.fc.horizons[i];
            const b = hf?.bands.find((x) => Math.abs(x.level - 0.8) < 1e-9);
            if (!b) return null;
            return (
              <Card key={h} label={`予測レンジ80%(${h}日)`}
                value={`${b.lowPrice.toFixed(0)}〜${b.highPrice.toFixed(0)}`}
                sub={`上昇確率 ${(hf.upProb * 100).toFixed(0)}%`} />
            );
          })}
        </div>
      </div>

      <div>
        <div className="text-xs text-gray-500 mb-1">
          黒=終値 / 青点線=予測中央 / 水色=予測80%区間（1・5・21日先の3点を結んだもの）。as-of 以降が「その時まだ無かったデータ」。
        </div>
        <div ref={containerRef} className="w-full rounded border border-gray-100" />
      </div>

      {/* ── その後どうなったか ── */}
      <div>
        <div className="text-xs font-medium text-gray-700 mb-1">その後の実測との照合</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 px-1.5">先行き</th>
                <th className="text-right px-1.5">実測リターン</th>
                <th className="text-center px-1.5">方向の当否</th>
                <th className="text-right px-1.5">高値到達</th>
                <th className="text-right px-1.5">安値到達</th>
                <th className="text-right px-1.5">実現ボラ(日次)</th>
                <th className="text-right px-1.5">ボラ予測比</th>
                <th className="text-center px-1.5">80%区間</th>
              </tr>
            </thead>
            <tbody>
              {FWD_HORIZONS.map((h, hi) => {
                const f = point.fwd[hi];
                if (!f) return (
                  <tr key={h} className="border-b border-gray-100">
                    <td className="py-1 px-1.5">{h}日後</td>
                    <td colSpan={7} className="px-1.5 text-fg-muted">実測データがありません</td>
                  </tr>
                );
                const dirOk = d.direction === "flat" ? null
                  : (d.direction === "up") === (f.ret >= 0);
                const bandIdx = (BAND_HORIZONS as readonly number[]).indexOf(h);
                const hf = bandIdx >= 0 ? point.fc.horizons[bandIdx] : null;
                const b80 = hf?.bands.find((x) => Math.abs(x.level - 0.8) < 1e-9);
                const inBand = b80 ? f.logRet >= b80.lowReturn && f.logRet <= b80.highReturn : null;
                const volRatio = d.volForecastPct > 0 ? (f.realizedVolDaily * 100) / d.volForecastPct : NaN;
                return (
                  <tr key={h} className="border-b border-gray-100">
                    <td className="py-1 px-1.5 text-gray-600">{h}日後</td>
                    <td className={`text-right px-1.5 font-mono font-semibold ${f.ret >= 0 ? "text-green-700" : "text-red-600"}`}>{pct(f.ret)}</td>
                    <td className="text-center px-1.5">
                      {dirOk === null ? <span className="text-gray-300">中立</span>
                        : dirOk ? <span className="text-green-700">○</span> : <span className="text-red-500">×</span>}
                    </td>
                    <td className="text-right px-1.5 font-mono text-gray-600">{pct(f.mfe, 1)}</td>
                    <td className="text-right px-1.5 font-mono text-gray-600">{pct(f.mae, 1)}</td>
                    <td className="text-right px-1.5 font-mono text-gray-600">{(f.realizedVolDaily * 100).toFixed(2)}%</td>
                    <td className={`text-right px-1.5 font-mono ${isFinite(volRatio) && (volRatio > 1.5 || volRatio < 0.67) ? "text-amber-700" : "text-gray-600"}`}>
                      {isFinite(volRatio) ? `${volRatio.toFixed(2)}倍` : "—"}
                    </td>
                    <td className="text-center px-1.5">
                      {inBand === null ? <span className="text-gray-300">—</span>
                        : inBand ? <span className="text-green-700">内</span> : <span className="text-red-500">外</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-fg-muted mt-1">
          1日ぶんの当否には情報がほぼありません（コイン1回と同じ）。この画面は仕組みの確認用で、
          判定は次の「as-of スコアカード」でまとめて行ってください。
        </p>
      </div>

      <AnalysisGuide title="as-of スナップショットの詳細理論">
        <p className="font-medium text-gray-700">1. 何をしているか</p>
        <p>
          過去のある日 k を選び、<span className="font-medium">その日までの価格配列だけ</span>を蒸留層
          （方向・レジーム・上昇確率・ボラ予測・予測レンジ・変化点）に渡して、当時の判断を再構成します。
          そのうえで k+1〜k+63 営業日に実際に起きたことを並べ、判断ごとに当否を突き合わせます。
          バックテストが「戦略の損益」を測るのに対し、ここでは<span className="font-medium">情報そのものの当否</span>を測ります。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. なぜ先読みが入らないか</p>
        <p>
          {"computeDigest(prices, …) と computeForecastRange(prices, …) は、渡された配列の外を一切参照しない純粋関数です。したがって prices.slice(0, k+1) を渡した時点で、k 日より後の情報は物理的に到達できません。"}
          パラメータの再推定（GARCH の最尤推定、BOCPD の逐次更新、カルマンのレジーム分類）も
          すべてこの切り出しの内側で行われるので、いわゆる<span className="font-medium">先読みバイアス（look-ahead bias）</span>——
          将来のデータで推定した係数を過去に適用してしまう誤り——はこの軸では起こりません。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"実測リターン: R_h = C_{k+h}/C_k − 1"}</li>
          <li>{"高値/安値到達: MFE_h = max_{k<j≤k+h} H_j/C_k − 1、MAE_h = min_{k<j≤k+h} L_j/C_k − 1"}</li>
          <li>{"実現ボラ(日次): σ̂_h = sd{ ln(C_j/C_{j−1}) : k<j≤k+h }"}</li>
          <li>{"予測区間の内外: 名目水準 L の区間 [q_{(1−L)/2}, q_{(1+L)/2}] に ln(C_{k+h}/C_k) が入るか"}</li>
          <li>{"ボラ予測比: σ̂_h / σ̂^{GARCH}_{k}。1 を大きく超える＝そのとき想定より荒れた"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">方向の○×は1件では何も意味しません。</span>コイン投げ1回の結果と同じで、of course 当たることもあります。ここで見るべきは「当時どういう根拠でその判断が出ていたか」の質感です。</li>
          <li><span className="font-medium">80%区間の内外</span>は、5回に1回は外れるのが正常です。外れが続くなら区間が狭すぎ、一度も外れないなら広すぎます（＝役に立たない）。</li>
          <li><span className="font-medium">ボラ予測比</span>が 1.5 倍超・0.67 倍未満なら、その時点の想定と実際の荒れ方が大きく違ったということです。GARCH は急変の当日には追随できないので、変化点検知と併読します。</li>
          <li>予測中央（青点線）が実測から系統的に上/下にずれるなら、ドリフト推定が効いていない可能性があります。短期のドリフトはほぼ推定不能なので、これは想定内でもあります。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>「今日の画面をどこまで信じてよいか」を、過去の同じ画面で確かめる。特に<span className="font-medium">今と似た状況の日</span>（高ボラ・変化点直後・大きなドローダウン中）を選んで再現すると、その局面での判断の癖が見えます。</li>
          <li>予測レンジは<span className="font-medium">ストップ幅と利確目標の初期値</span>に使えます。80%区間の下限に置いたストップが実際どれくらいの頻度で刈られたかを、ここで数例確認してからスコアカードで統計を見ます。</li>
          <li>変化点が出た日を選んで前後を見比べると、「警告が出た後に実際に荒れたか」を目で確認できます。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">これは前向き検証ではありません。</span>先読みは排除できますが、「どの日を見るか」「どの判断を採点するか」を選んでいるのは今日の自分です。都合の良い日を探せば、いくらでも当たっている例を作れます。統計的な判定は必ずスコアカード側で行ってください。</li>
          <li>価格は配当・分割で遡及調整されます。当時の生の株価と表示値は完全には一致しません。</li>
          <li>再現しているのは蒸留層の判断であって、アプリの全パネルではありません。個別の分析パネルには、ここに載らない判断も多数あります。</li>
          <li>選べる期間の右端は「最長63営業日ぶんの実測が残っている日」までです。それより新しい日は、まだ採点できないので選べません。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
