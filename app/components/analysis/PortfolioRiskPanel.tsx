"use client";

import { useMemo, useState } from "react";
import { PortfolioData } from "../../hooks/usePortfolioData";
import { WatchlistItem, effectiveKind } from "../../lib/watchlist";
import { Horizon, HORIZON_CONFIG } from "../../lib/signal-digest";
import {
  alignReturns,
  correlationMatrix,
  portfolioRisk,
  stressRiskFromCorr,
} from "../../lib/portfolio-risk";
import { computeDCC, downsideCorrelation } from "../../lib/dcc";
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

  const { corr, risk, names, aligned, rawWeights } = useMemo(() => {
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
    return { corr, risk, names, aligned, rawWeights };
  }, [data, watchlist, horizon]);

  // DCC・危機時相関は重い(銘柄ごとGARCH)ので展開時のみ計算する。
  const [dccOpen, setDccOpen] = useState(false);
  const dcc = useMemo(() => {
    if (!dccOpen || aligned.tickers.length < 2) return null;
    const d = computeDCC(aligned);
    if (!d.ok) return null;
    const down = downsideCorrelation(aligned, 0.25);
    // 相関だけを差し替えてVaRを比較(ボラは現在の条件付きσで固定)
    const calm = stressRiskFromCorr(aligned, rawWeights, d.uncondR, d.condVols);
    const now = stressRiskFromCorr(aligned, rawWeights, d.currentR, d.condVols);
    const crash =
      down.ok && down.matrix.length === aligned.tickers.length
        ? stressRiskFromCorr(aligned, rawWeights, down.matrix, d.condVols)
        : null;
    return { d, down, calm, now, crash };
  }, [dccOpen, aligned, rawWeights]);

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

          {/* 危機時相関(DCC) */}
          <div className="border-t border-gray-100 pt-4">
            <button
              onClick={() => setDccOpen((v) => !v)}
              className="flex items-center gap-2 text-sm font-medium text-gray-700"
            >
              <span className="inline-block transition-transform" style={{ transform: dccOpen ? "rotate(90deg)" : "rotate(0deg)" }}>
                ▶
              </span>
              危機時相関(DCC・動的条件付き相関)
              {!dccOpen && <span className="text-xs text-gray-400 font-normal">クリックで計算</span>}
            </button>

            {dccOpen && (
              dcc ? (
                <div className="mt-3 space-y-4">
                  {/* 平時 → 現在 → ピーク */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <Card label="平時の平均相関" value={dcc.d.uncondAvgCorr.toFixed(2)} />
                    <Card
                      label="現在の平均相関"
                      value={dcc.d.currentAvgCorr.toFixed(2)}
                      color={dcc.d.currentAvgCorr > dcc.d.uncondAvgCorr + 0.1 ? "text-red-600" : "text-gray-800"}
                      sub={`平時比 ${dcc.d.currentAvgCorr >= dcc.d.uncondAvgCorr ? "+" : ""}${(dcc.d.currentAvgCorr - dcc.d.uncondAvgCorr).toFixed(2)}`}
                    />
                    <Card label="期間ピーク相関" value={dcc.d.peakAvgCorr.toFixed(2)} />
                    <Card label="下落日の平均相関" value={dcc.down.ok ? dcc.down.avg.toFixed(2) : "—"} sub={dcc.down.ok ? `下位25%・${dcc.down.nDays}日` : "データ不足"} color="text-red-600" />
                  </div>

                  {/* 平均相関の推移 */}
                  <div>
                    <p className="text-xs font-medium text-gray-600 mb-1">平均相関の推移(DCC, a={dcc.d.a.toFixed(2)} b={dcc.d.b.toFixed(2)})</p>
                    <Sparkline values={dcc.d.avgCorrSeries} baseline={dcc.d.uncondAvgCorr} />
                  </div>

                  {/* ストレスVaR比較 */}
                  {dcc.now.ok && (
                    <div>
                      <p className="text-xs font-medium text-gray-600 mb-2">
                        相関シナリオ別の日次VaR95(ボラは現在水準で固定、相関のみ差し替え)
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <ScenarioCard label="平時相関" risk={dcc.calm} totalMV={risk.totalMarketValue} yen={yen} />
                        <ScenarioCard label="現在(DCC)" risk={dcc.now} totalMV={risk.totalMarketValue} yen={yen} highlight />
                        <ScenarioCard label="下落日相関(危機)" risk={dcc.crash} totalMV={risk.totalMarketValue} yen={yen} danger />
                      </div>
                      {dcc.crash?.ok && dcc.calm.ok && dcc.calm.var95Pct > 0 && (
                        <p className="text-[10px] text-gray-500 mt-2">
                          危機時は相関上昇で分散効果が消え、VaRが平時比 約
                          {(dcc.crash.var95Pct / dcc.calm.var95Pct).toFixed(2)}倍に拡大。
                        </p>
                      )}
                    </div>
                  )}

                  {!dcc.now.ok && (
                    <p className="text-xs text-gray-400">建玉(株数)を入力するとストレスVaR比較を表示します。</p>
                  )}

                  <AnalysisGuide title="DCC・危機時相関の詳細理論">
                    <p className="font-medium text-gray-700">1. なぜ動的相関が必要か</p>
                    <p>
                      相関は一定ではありません。とくに<strong>暴落時には多くの銘柄が一斉に下げ、相関が1へ近づく</strong>(危機時相関)。
                      平時の静的相関で計算した分散効果やVaRは、肝心の急落局面で過小評価になります。DCCは相関の時間変化を推定します。
                    </p>
                    <p className="font-medium text-gray-700 mt-3">2. 数式(Engle 2002)</p>
                    <p>
                      各銘柄をGARCH(1,1)の条件付きボラ σ_i,t で標準化:{" z_i,t = r_i,t / σ_i,t "}。
                      無条件相関 Q̄ を基準に、{" Q_t = (1-a-b)Q̄ + a·z_{t-1}z_{t-1}ᵀ + b·Q_{t-1} "}。
                      これを正規化して相関行列 {" R_t = diag(Q_t)^{-1/2} Q_t diag(Q_t)^{-1/2} "}。
                      a は直近ショックへの反応、b は相関の粘り(persistence)。本実装は多変量の行列計算を避け、
                      ペアワイズ複合尤度(2変量正規)で a,b を推定。
                    </p>
                    <p className="font-medium text-gray-700 mt-3">3. 用語</p>
                    <ul className="list-disc pl-4 space-y-1">
                      <li><strong>標準化残差 z</strong>: リターンをその時々のボラで割り、ボラ変動の影響を除いた「純粋な連動成分」。</li>
                      <li><strong>下落日相関</strong>: バスケットが下位25%下落した日だけで測った相関。危機時相関の簡便な代理。</li>
                      <li><strong>ストレスVaR</strong>: ボラを現在水準に固定し、相関だけを各シナリオに差し替えて計算したVaR。相関上昇の影響だけを取り出す。</li>
                    </ul>
                    <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
                    <ul className="list-disc pl-4 space-y-1">
                      <li>「現在の平均相関」が「平時」を大きく上回る=既に連動が高まり、分散が効きにくい局面。</li>
                      <li>推移グラフのスパイク=過去に相関が急騰した(危機が起きた)時点。</li>
                      <li>危機シナリオVaRが平時の何倍か=暴落時にどれだけリスクが膨らむかの目安。</li>
                    </ul>
                    <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
                    <ul className="list-disc pl-4 space-y-1">
                      <li>危機VaRが許容を超えるなら、平時に見えている分散は「見せかけ」。ヘッジや銘柄入れ替えを検討。</li>
                      <li>相関が既に上昇中なら、新規の同方向ポジションは上乗せリスクが大きい。</li>
                    </ul>
                    <p className="font-medium text-gray-700 mt-3">6. 注意点</p>
                    <ul className="list-disc pl-4 space-y-1">
                      <li>a,bはペアワイズ複合尤度の粗いグリッド推定。厳密な多変量MLEではない。</li>
                      <li>下落日相関は標本が少ないと不安定(最低10日必要)。</li>
                      <li>ストレスVaRは正規パラメトリック(ファットテール未考慮)。履歴VaRは上の合算リスク欄を参照。</li>
                    </ul>
                  </AnalysisGuide>
                </div>
              ) : (
                <p className="mt-3 text-xs text-gray-400">
                  DCC計算には2銘柄以上・各50本以上のリターンが必要です。
                </p>
              )
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

function ScenarioCard({
  label,
  risk,
  totalMV,
  yen,
  highlight,
  danger,
}: {
  label: string;
  risk: { ok: boolean; var95Pct: number } | null;
  totalMV: number;
  yen: (v: number) => string;
  highlight?: boolean;
  danger?: boolean;
}) {
  const border = danger
    ? "border-red-300 bg-red-50"
    : highlight
    ? "border-blue-300 bg-blue-50"
    : "border-gray-200 bg-gray-50";
  return (
    <div className={`rounded-lg border p-2.5 ${border}`}>
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`text-base font-bold ${danger ? "text-red-600" : "text-gray-800"}`}>
        {risk?.ok ? `${risk.var95Pct.toFixed(2)}%` : "—"}
      </div>
      {risk?.ok && <div className="text-[10px] text-gray-400">{yen((risk.var95Pct / 100) * totalMV)}</div>}
    </div>
  );
}

// 平均相関の推移を小さな折れ線で。baseline(無条件相関)を点線で示す。
function Sparkline({ values, baseline }: { values: number[]; baseline: number }) {
  if (values.length < 2) return null;
  const W = 600;
  const H = 60;
  const min = Math.min(...values, baseline);
  const max = Math.max(...values, baseline);
  const range = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - ((v - min) / range) * (H - 4) - 2;
  const path = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const baseY = y(baseline).toFixed(1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-14" preserveAspectRatio="none">
      <line x1="0" y1={baseY} x2={W} y2={baseY} stroke="#9ca3af" strokeWidth="1" strokeDasharray="4 3" />
      <path d={path} fill="none" stroke="#dc2626" strokeWidth="1.5" />
    </svg>
  );
}
