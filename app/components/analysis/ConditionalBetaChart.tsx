"use client";

import { useEffect, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { conditionalBeta } from "../../lib/conditional-beta";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";

interface Props {
  prices: PricePoint[];
}

const PRESETS = [
  { ticker: "^N225", label: "日経225" },
  { ticker: "^GSPC", label: "S&P500" },
  { ticker: "1306.T", label: "TOPIX(ETF)" },
];

export default function ConditionalBetaChart({ prices }: Props) {
  const [benchTicker, setBenchTicker] = useState("^N225");
  const [benchPrices, setBenchPrices] = useState<PricePoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true); setError(null);
      try {
        const res = await fetch(`/api/stock?ticker=${encodeURIComponent(benchTicker)}&range=10y`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json.prices) { setError("ベンチマーク取得失敗"); setBenchPrices(null); }
        else setBenchPrices(json.prices);
      } catch { if (!cancelled) { setError("通信エラー"); setBenchPrices(null); } }
      finally { if (!cancelled) setLoading(false); }
    };
    run();
    return () => { cancelled = true; };
  }, [benchTicker]);

  const res = useMemo(() => (benchPrices ? conditionalBeta(prices, benchPrices) : null), [prices, benchPrices]);

  if (prices.length < 60) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">条件付きベータ・下方ベータ（地合い別の感応度）</h3>
        <div className="flex gap-1 text-xs">
          {PRESETS.map((p) => (
            <button key={p.ticker} onClick={() => setBenchTicker(p.ticker)} className={`px-2 py-0.5 rounded ${benchTicker === p.ticker ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{p.label}</button>
          ))}
        </div>
      </div>

      {loading && <div className="text-xs text-gray-400">ベンチマーク読み込み中...</div>}
      {error && <div className="text-xs text-red-500">{error}</div>}

      {res && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="p-2 rounded border border-gray-200 bg-gray-50"><div className="text-gray-500">全体β</div><div className="font-mono font-bold">{res.betaAll.toFixed(2)}</div></div>
            <div className="p-2 rounded border border-green-200 bg-green-50"><div className="text-gray-500">上昇相場β</div><div className="font-mono font-bold">{res.betaUp.toFixed(2)}</div></div>
            <div className="p-2 rounded border border-red-200 bg-red-50"><div className="text-gray-500">下落相場β</div><div className="font-mono font-bold">{res.betaDown.toFixed(2)}</div></div>
            <div className="p-2 rounded border border-red-200 bg-red-50"><div className="text-gray-500">下方β</div><div className="font-mono font-bold">{res.downsideBeta.toFixed(2)}</div></div>
          </div>
          <div className={`rounded-md border px-3 py-2 text-xs ${res.betaDown > res.betaUp ? "border-red-200 bg-red-50 text-red-900" : "border-green-200 bg-green-50 text-green-900"}`}>
            {res.betaDown > res.betaUp
              ? "下落相場でのβが上昇相場より大きい＝地合い悪化時に大きく下げる『脆い』プロファイル。"
              : "上昇相場でのβが下落相場より大きい＝上げに強く下げに粘る『有利な非対称性』。"}
            （相関 {res.corr.toFixed(2)} / 上昇日 {res.nUp} ・下落日 {res.nDown}）
          </div>
        </>
      )}

      <AnalysisGuide title="条件付きベータの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>{"市場(ベンチ)に対する感応度βを『上昇相場』と『下落相場』で分けて測る。同じβ1.0でも、上げに強く下げに弱いのか、その逆かで投資妙味は正反対。"}</p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>β</strong> = Cov(銘柄, ベンチ) / Var(ベンチ)。</li>
          <li><strong>上昇相場β</strong>: ベンチがプラスの日だけで回帰。<strong>下落相場β</strong>: マイナスの日だけ。</li>
          <li><strong>下方β</strong>: ベンチが平均以下の日だけで回帰。下振れ時の感応度。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>下落相場β＞上昇相場β＝下げに弱い。守りたい局面では避ける/ヘッジ。</li>
          <li>上昇相場β＞下落相場β＝有利な非対称性。攻めの局面で選好。</li>
          <li>下方βが高い銘柄はポートフォリオの分散効果が地合い悪化時に消えやすい。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>上昇日/下落日で分けると標本が減り、βが不安定になりやすい。</li>
          <li>βは線形・一定を仮定。非線形な感応度は捉えない。</li>
          <li>ベンチの選択で結論が変わる。</li>
        </ul>
      </AnalysisGuide>

      <AxiomPlacement corollaryId="C7" />
    </div>
  );
}
