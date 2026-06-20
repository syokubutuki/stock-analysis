"use client";

import { useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { kellyOptimal } from "../../lib/kelly-bs";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; }

interface Signal { dim: string; verdict: "強気" | "中立" | "弱気"; score: number; detail: string; }

function sma(prices: PricePoint[], period: number): number {
  const n = prices.length;
  if (n < period) return NaN;
  let s = 0;
  for (let i = n - period; i < n; i++) s += prices[i].close;
  return s / period;
}

export default function ConsolidatedScorecardChart({ prices }: Props) {
  const data = useMemo(() => {
    if (prices.length < 260) return null;
    const n = prices.length;
    const c = prices[n - 1].close;
    const signals: Signal[] = [];

    // トレンド
    const s200 = sma(prices, 200);
    signals.push({ dim: "長期トレンド", verdict: c > s200 ? "強気" : "弱気", score: c > s200 ? 1 : -1, detail: `200日線 ${c > s200 ? "上" : "下"}（${(((c - s200) / s200) * 100).toFixed(1)}%）` });

    // MA配列
    const s5 = sma(prices, 5), s25 = sma(prices, 25), s75 = sma(prices, 75);
    const bull = s5 > s25 && s25 > s75, bear = s5 < s25 && s25 < s75;
    signals.push({ dim: "MA配列", verdict: bull ? "強気" : bear ? "弱気" : "中立", score: bull ? 1 : bear ? -1 : 0, detail: bull ? "完全強気配列" : bear ? "完全弱気配列" : "混在" });

    // 12-1モメンタム
    const mom = prices[n - 21].close / prices[n - 252].close - 1;
    signals.push({ dim: "モメンタム(12-1M)", verdict: mom > 0.02 ? "強気" : mom < -0.02 ? "弱気" : "中立", score: mom > 0.02 ? 1 : mom < -0.02 ? -1 : 0, detail: `${(mom * 100).toFixed(1)}%` });

    // RSI(14)
    let ag = 0, al = 0;
    for (let i = n - 14; i < n; i++) { const d = prices[i].close - prices[i - 1].close; if (d > 0) ag += d; else al -= d; }
    const rsi = al > 0 ? 100 - 100 / (1 + ag / al) : 100;
    signals.push({ dim: "RSI(14)", verdict: rsi < 30 ? "強気" : rsi > 70 ? "弱気" : "中立", score: rsi < 30 ? 1 : rsi > 70 ? -1 : 0, detail: `${rsi.toFixed(0)}（${rsi < 30 ? "売られ過ぎ" : rsi > 70 ? "買われ過ぎ" : "中立"}）` });

    // ドローダウン
    let peak = -Infinity;
    for (let i = n - 252; i < n; i++) peak = Math.max(peak, prices[i].close);
    const dd = (c - peak) / peak;
    signals.push({ dim: "ドローダウン", verdict: dd > -0.05 ? "強気" : dd < -0.2 ? "弱気" : "中立", score: dd > -0.05 ? 1 : dd < -0.2 ? -1 : 0, detail: `高値から ${(dd * 100).toFixed(1)}%` });

    // ボラレジーム
    const rr: number[] = [];
    for (let i = n - 20; i < n; i++) rr.push(Math.log(prices[i].close / prices[i - 1].close));
    const m = rr.reduce((s, v) => s + v, 0) / rr.length;
    const vol = Math.sqrt(rr.reduce((s, v) => s + (v - m) ** 2, 0) / rr.length) * Math.sqrt(252);
    signals.push({ dim: "ボラ環境", verdict: vol < 0.2 ? "強気" : vol > 0.4 ? "弱気" : "中立", score: vol < 0.2 ? 1 : vol > 0.4 ? -1 : 0, detail: `年率 ${(vol * 100).toFixed(0)}%` });

    // ケリー
    const rets: number[] = [];
    for (let i = 1; i < n; i++) rets.push(prices[i].close / prices[i - 1].close - 1);
    const k = kellyOptimal(rets);
    signals.push({ dim: "ケリー(期待値)", verdict: k.kellyFraction > 0.3 ? "強気" : k.kellyFraction <= 0 ? "弱気" : "中立", score: k.kellyFraction > 0.3 ? 1 : k.kellyFraction <= 0 ? -1 : 0, detail: `f*=${(k.kellyFraction * 100).toFixed(0)}%` });

    const total = signals.reduce((s, x) => s + x.score, 0);
    const maxTotal = signals.length;
    const pct = ((total + maxTotal) / (2 * maxTotal)) * 100; // 0-100
    return { signals, total, pct };
  }, [prices]);

  if (prices.length < 260 || !data) return null;
  const overall = data.pct >= 65 ? "強気" : data.pct <= 35 ? "弱気" : "中立";
  const ocolor = overall === "強気" ? "#16a34a" : overall === "弱気" ? "#dc2626" : "#6b7280";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-bold text-gray-800">総合スコアカード（多分析の所見を1枚に集約）</h3>

      <div className="rounded-md border px-3 py-3 text-center" style={{ borderColor: ocolor, background: ocolor + "12" }}>
        <div className="text-xs text-gray-500">総合判定</div>
        <div className="text-2xl font-bold" style={{ color: ocolor }}>{overall}</div>
        <div className="text-xs text-gray-500">スコア {data.pct.toFixed(0)}/100（{data.total >= 0 ? "+" : ""}{data.total}/±{data.signals.length}）</div>
        <div className="mt-2 h-2 bg-gray-200 rounded-full overflow-hidden">
          <div className="h-full" style={{ width: `${data.pct}%`, background: ocolor }} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
        {data.signals.map((s) => {
          const col = s.verdict === "強気" ? "#16a34a" : s.verdict === "弱気" ? "#dc2626" : "#6b7280";
          return (
            <div key={s.dim} className="flex items-center justify-between p-2 rounded border border-gray-200 bg-gray-50">
              <div><div className="font-medium text-gray-700">{s.dim}</div><div className="text-gray-500 text-[10px]">{s.detail}</div></div>
              <span className="px-2 py-0.5 rounded text-white font-medium" style={{ background: col }}>{s.verdict}</span>
            </div>
          );
        })}
      </div>

      <AnalysisGuide title="総合スコアカードの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"トレンド・モメンタム・RSI・ドローダウン・ボラ・期待値(ケリー)など複数の観点の所見を1枚に集約し、強気/中立/弱気を一目で把握する。個別チャートを横断した総合判断の出発点。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 集計方法</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>各次元を強気(+1)/中立(0)/弱気(−1)で採点し、合計を0-100スコアに正規化。</li>
          <li>長期トレンド=200日線、MA配列=5/25/75、モメンタム=12-1ヶ月、RSI(14)、DD=252日高値比、ボラ=20日年率、ケリー=期待値の符号。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>総合が強気かつ各次元が揃う＝順張りの好機。バラつく＝様子見。</li>
          <li>トレンドは強気だがRSI買われ過ぎ・高ボラ＝過熱。一部利確の判断。</li>
          <li>弱気が並ぶ＝防御（縮小・撤退・ヘッジ）。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>各次元を等ウェイトで単純合算しており、銘柄特性は反映しない。</li>
          <li>順張り指標(トレンド)と逆張り指標(RSI)が混在するため、相場局面で解釈を補正する。</li>
          <li>あくまでスクリーニングの出発点。最終判断は個別分析で裏取りを。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
