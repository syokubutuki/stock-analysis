"use client";

import { useMemo, useState } from "react";
import { PortfolioData } from "../../hooks/usePortfolioData";
import { WatchlistItem, effectiveKind } from "../../lib/watchlist";
import { Horizon, HORIZON_CONFIG } from "../../lib/signal-digest";
import {
  alignReturns,
  correlationMatrix,
  portfolioRisk,
} from "../../lib/portfolio-risk";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  data: PortfolioData;
  watchlist: WatchlistItem[];
  horizon: Horizon;
}

// 相関値→セル背景色。正の相関=赤(集中リスク)、負=青(分散効果)。
function corrColor(c: number): string {
  if (c >= 0) return `rgba(220, 38, 38, ${Math.min(Math.abs(c), 1) * 0.75})`;
  return `rgba(37, 99, 235, ${Math.min(Math.abs(c), 1) * 0.75})`;
}

export default function PortfolioRiskPanel({ data, watchlist, horizon }: Props) {
  const [open, setOpen] = useState(true);

  const { corr, risk, names } = useMemo(() => {
    const series = Object.entries(data)
      .filter(([, v]) => v.prices.length > 2)
      .map(([ticker, v]) => ({ ticker, prices: v.prices }));
    const names: Record<string, string> = {};
    for (const [t, v] of Object.entries(data)) names[t] = v.name || t;

    const aligned = alignReturns(series, HORIZON_CONFIG[horizon].window);
    const corr = correlationMatrix(aligned);

    // 建玉(保有 & 株数>0)の時価でウェイト
    const rawWeights: Record<string, number> = {};
    for (const item of watchlist) {
      if (effectiveKind(item) !== "held") continue;
      const pos = item.position;
      const last = data[item.ticker]?.prices.at(-1)?.close;
      if (pos && pos.shares > 0 && last) {
        rawWeights[item.ticker] = pos.shares * last;
      }
    }
    const risk = portfolioRisk(aligned, rawWeights);
    return { corr, risk, names };
  }, [data, watchlist, horizon]);

  const yen = (v: number) => `¥${Math.round(v).toLocaleString()}`;
  const highCorrWarning =
    corr.avgCorr > 0.6 || (corr.topPairs[0]?.corr ?? 0) > 0.8;

  if (corr.tickers.length < 2) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4 text-sm text-gray-400">
        ポートフォリオ関係性分析には2銘柄以上の取得が必要です。
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-left"
      >
        <span
          className="inline-block transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▶
        </span>
        <span className="font-semibold text-gray-800">ポートフォリオ関係性・合算リスク</span>
        <span className="text-xs text-gray-400">
          ({HORIZON_CONFIG[horizon].label}窓 / 相関{corr.tickers.length}銘柄
          {risk.ok ? ` / 建玉${risk.components.length}銘柄` : ""})
        </span>
      </button>

      {open && (
        <div className="mt-4 space-y-5">
          {highCorrWarning && (
            <div className="bg-amber-50 text-amber-700 text-xs rounded p-2 border border-amber-200">
              ⚠ 平均相関 {corr.avgCorr.toFixed(2)}。銘柄間の連動が高く「分散しているつもりで実は同じ賭け」の可能性。
            </div>
          )}

          {/* 合算リスクのサマリー(建玉がある場合) */}
          {risk.ok ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <Card label="ポート年率Vol" value={`${(risk.portfolioVolAnnual * 100).toFixed(1)}%`} />
              <Card
                label="日次VaR95"
                value={`${risk.var95Pct.toFixed(2)}%`}
                sub={yen((risk.var95Pct / 100) * risk.totalMarketValue)}
                color="text-red-600"
              />
              <Card
                label="日次CVaR95"
                value={`${risk.cvar95Pct.toFixed(2)}%`}
                sub={yen((risk.cvar95Pct / 100) * risk.totalMarketValue)}
                color="text-red-600"
              />
              <Card label="有効銘柄数" value={risk.effectiveN.toFixed(1)} sub={`実${risk.components.length}銘柄`} />
              <Card
                label="分散比"
                value={risk.diversificationRatio.toFixed(2)}
                sub={risk.diversificationRatio > 1.3 ? "分散良好" : "分散弱い"}
              />
              <Card label="評価額合計" value={yen(risk.totalMarketValue)} />
            </div>
          ) : (
            <div className="text-xs text-gray-400">
              建玉(保有・株数)を入力すると、合算VaR・リスク寄与・集中度を表示します。相関行列は下に表示中。
            </div>
          )}

          {/* リスク寄与(建玉のみ) */}
          {risk.ok && (
            <div>
              <p className="text-xs font-medium text-gray-600 mb-2">
                リスク寄与率(どの銘柄が全体リスクを駆動しているか)
              </p>
              <div className="space-y-1.5">
                {risk.components.map((c) => {
                  const over = c.pctr > c.weight + 0.02; // 構成比よりリスク寄与が大=リスク偏在
                  return (
                    <div key={c.ticker} className="flex items-center gap-2 text-xs">
                      <span className="w-28 shrink-0 truncate text-gray-700">
                        {c.ticker}
                        <span className="text-gray-400 ml-1">{names[c.ticker]}</span>
                      </span>
                      <div className="flex-1 bg-gray-100 rounded h-4 relative overflow-hidden">
                        <div
                          className={`h-full ${over ? "bg-red-400" : "bg-blue-400"}`}
                          style={{ width: `${(c.pctr * 100).toFixed(1)}%` }}
                        />
                      </div>
                      <span className="w-32 shrink-0 text-right tabular-nums text-gray-500">
                        寄与{(c.pctr * 100).toFixed(0)}% / 構成{(c.weight * 100).toFixed(0)}%
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="text-[10px] text-gray-400 mt-1">
                赤=構成比以上にリスクを抱える銘柄(ボラ高 or 他銘柄と高相関)。
              </p>
            </div>
          )}

          {/* 相関ヒートマップ */}
          <div>
            <p className="text-xs font-medium text-gray-600 mb-2">
              相関行列(直近{HORIZON_CONFIG[horizon].window}本・対数リターン)
            </p>
            <div className="overflow-x-auto">
              <table className="border-collapse text-[10px]">
                <thead>
                  <tr>
                    <th className="p-1"></th>
                    {corr.tickers.map((t) => (
                      <th key={t} className="p-1 text-gray-500 font-medium whitespace-nowrap">
                        {t}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {corr.tickers.map((t, i) => (
                    <tr key={t}>
                      <td className="p-1 text-gray-500 font-medium whitespace-nowrap text-right pr-2">
                        {t}
                      </td>
                      {corr.tickers.map((_, j) => (
                        <td
                          key={j}
                          className="p-1 text-center tabular-nums w-10"
                          style={{
                            backgroundColor: i === j ? "#f3f4f6" : corrColor(corr.matrix[i][j]),
                            color:
                              i !== j && Math.abs(corr.matrix[i][j]) > 0.5 ? "#fff" : "#374151",
                          }}
                          title={`${corr.tickers[i]} × ${corr.tickers[j]}: ${corr.matrix[i][j].toFixed(2)}`}
                        >
                          {i === j ? "—" : corr.matrix[i][j].toFixed(2)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {corr.topPairs.length > 0 && (
              <p className="text-[10px] text-gray-500 mt-2">
                高相関ペア:{" "}
                {corr.topPairs
                  .slice(0, 3)
                  .map((p) => `${p.a}×${p.b}=${p.corr.toFixed(2)}`)
                  .join(" / ")}
              </p>
            )}
          </div>

          <AnalysisGuide title="ポートフォリオ関係性・合算リスクの詳細理論">
            <p className="font-medium text-gray-700">1. 何を見ているか</p>
            <p>
              個別銘柄の分析を足し合わせても「全体のリスク」は分かりません。複数銘柄を同時に保有すると、
              値動きが連動(相関)していれば分散効果は小さく、逆に動けばリスクは相殺されます。ここでは
              保有・狙い銘柄の<strong>銘柄間の関係</strong>と、建玉を加味した<strong>ポートフォリオ全体のリスク</strong>を計算します。
            </p>

            <p className="font-medium text-gray-700 mt-3">2. 数式</p>
            <p>
              各銘柄の対数リターン r_i を共通日付で整列し、相関係数
              {" ρ_ij = Cov(r_i, r_j) / (σ_i σ_j) "} で相関行列を作る。
              構成比 w_i(=時価/合計時価)と共分散行列 Σ から、ポートフォリオ分散は
              {" σ_p² = wᵀ Σ w "}。年率ボラは {" σ_p × √252 "}。
              リスク寄与率(component VaR)は {" PCTR_i = w_i (Σw)_i / σ_p² "} で、合計1になる。
              分散比 DR = {" (Σ w_i σ_i) / σ_p "}(各銘柄を別々に持った場合のリスク合計に対する低減度)。
              有効銘柄数 = {" 1 / Σ w_i² "}(ハーフィンダール指数の逆数)。
              VaR95/CVaR95 はポートフォリオ日次リターン系列 {" r_p,t = Σ w_i r_i,t "} の
              5%分位点と、それ以下の平均(履歴法・ファットテール対応)。
            </p>

            <p className="font-medium text-gray-700 mt-3">3. 用語</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><strong>相関係数</strong>: 2銘柄の連動度。+1=完全連動、0=無関係、−1=逆動き。</li>
              <li><strong>VaR95(バリュー・アット・リスク)</strong>: 95%の日は損失がこの範囲に収まる、という損失水準。</li>
              <li><strong>CVaR95</strong>: その悪い5%に入ったときの平均損失(VaRより踏み込んだ損失指標)。</li>
              <li><strong>リスク寄与率</strong>: 全体リスクのうち各銘柄が生んでいる割合。構成比と違い、相関とボラを織り込む。</li>
              <li><strong>有効銘柄数</strong>: 構成比の偏りを加味した「実質的に何銘柄に分散しているか」。</li>
            </ul>

            <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>相関ヒートマップが<strong>赤一色</strong>=全銘柄が連動。1つの悪材料で同時に下げる。</li>
              <li>リスク寄与率の棒が<strong>赤</strong>=構成比以上にリスクを抱える銘柄(高ボラ or 高相関)。</li>
              <li>有効銘柄数が実銘柄数より大きく下回る=一部銘柄に偏っている。</li>
              <li>分散比が1.3以上=分散がよく効いている。1.0近辺=分散できていない。</li>
            </ul>

            <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>新規エントリー前に、既存保有との相関を確認。高相関なら「同じ賭けの上乗せ」になる。</li>
              <li>リスク寄与が突出した銘柄を縮小すると、リターンを大きく削らずに全体リスクを下げられる。</li>
              <li>VaR(円)を自分の許容損失と比べ、ポジション全体のサイズが適正か判断する。</li>
            </ul>

            <p className="font-medium text-gray-700 mt-3">6. 注意点</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>相関・ボラは過去の値。急落時には相関が1へ近づき(危機時相関)、分散効果は想定より小さくなる。</li>
              <li>共通営業日でしか整列できないため、上場間もない銘柄や流動性の低い銘柄はデータ期間が短くなる。</li>
              <li>VaRは正規分布でなく履歴法だが、サンプル外の極端な事象は捉えられない。</li>
            </ul>
          </AnalysisGuide>
        </div>
      )}
    </div>
  );
}

function Card({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200 p-2.5">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`text-base font-bold ${color || "text-gray-800"}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-400">{sub}</div>}
    </div>
  );
}
