"use client";

import { useMemo, useState } from "react";
import { useIntraday } from "../../hooks/useIntraday";
import { useUsDaily, US_DRIVERS } from "../../hooks/useUsDaily";
import { groupByDay } from "../../lib/intraday-core";
import {
  computeDriverScores, computeDivergence, DriverInput, DriverResult, DivergenceStat,
} from "../../lib/us-spillover-driver";
import {
  IntervalButtons, LoadingError, IntradayCaveat, fmtSignedPct,
} from "./intradayShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

const fmtPct0 = (v: number) => `${(v * 100).toFixed(0)}%`;

export default function UsDriverChart({ ticker }: Props) {
  const [interval, setInterval] = useState("15m");
  const [selDriver, setSelDriver] = useState<string | null>(null);
  const { resp, loading: il, error: ie } = useIntraday(ticker, interval);

  // 4指数を固定で取得(フックは無条件・件数固定)。各 useUsDaily はモジュールキャッシュ共有。
  const gspc = useUsDaily("^GSPC");
  const ixic = useUsDaily("^IXIC");
  const sox = useUsDaily("^SOX");
  const dji = useUsDaily("^DJI");
  const priceMap: Record<string, ReturnType<typeof useUsDaily>> = {
    "^GSPC": gspc, "^IXIC": ixic, "^SOX": sox, "^DJI": dji,
  };
  const usLoading = gspc.loading || ixic.loading || sox.loading || dji.loading;

  const inputs: DriverInput[] = US_DRIVERS.map((d) => ({
    ticker: d.ticker, label: d.label, prices: priceMap[d.ticker]?.prices ?? null,
  }));

  const days = useMemo(() => (resp && resp.bars.length ? groupByDay(resp.bars, resp.gmtoffset) : null), [resp]);

  const result: DriverResult | null = useMemo(
    () => (days ? computeDriverScores(days, inputs) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [days, gspc.prices, ixic.prices, sox.prices, dji.prices]
  );

  const activeDriver = selDriver ?? result?.best ?? null;
  const divergence: DivergenceStat | null = useMemo(() => {
    if (!days || !activeDriver) return null;
    const inp = inputs.find((i) => i.ticker === activeDriver);
    return inp ? computeDivergence(days, inp) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, activeDriver, gspc.prices, ixic.prices, sox.prices, dji.prices]);

  const maxR2 = result ? Math.max(0.01, ...result.scores.map((s) => s.r2Full)) : 1;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">支配ドライバ指数の特定 と 乖離日分析</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>

      <LoadingError loading={il} error={ie} />
      {usLoading && <div className="text-xs text-gray-400">米国指数を取得中...</div>}
      {!il && !ie && days && !result && (
        <div className="text-xs text-gray-400">整合できた標本が不足しています。</div>
      )}

      {result && (
        <>
          {/* R²ランキング */}
          <div className="space-y-1">
            <div className="text-xs text-gray-500">当日リターンの説明力 R²（前夜どの米国指数で最もよく説明できるか）</div>
            {result.scores.map((s) => (
              <div key={s.ticker} className="flex items-center gap-2 text-xs">
                <span className="w-20 text-right text-gray-600">{s.label}</span>
                <div className="flex-1 h-4 bg-gray-100 rounded relative overflow-hidden">
                  <div
                    className={`h-full ${s.ticker === result.best ? "bg-indigo-600" : "bg-indigo-300"}`}
                    style={{ width: `${(s.r2Full / maxR2) * 100}%` }}
                  />
                </div>
                <span className="w-24 text-right font-mono text-gray-600">R² {s.r2Full.toFixed(3)}</span>
                <span className="w-16 text-right font-mono text-gray-400">相関 {s.corrFull.toFixed(2)}</span>
              </div>
            ))}
          </div>

          <div className="rounded-md bg-indigo-50 border border-indigo-200 px-3 py-2 text-xs text-indigo-900">
            この銘柄の支配ドライバは <span className="font-bold">{result.scores[0].label}</span>（R² {result.scores[0].r2Full.toFixed(3)}・相関 {result.scores[0].corrFull.toFixed(2)}）。
            他の手法(β・パス等)もこの指数を選ぶと連動が最も鮮明に出る。
          </div>

          {/* 日中感応の詳細テーブル */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">指数</th>
                  <th className="text-right px-2">日数</th>
                  <th className="text-right px-2">当日β</th>
                  <th className="text-right px-2">当日R²</th>
                  <th className="text-right px-2">日中β</th>
                  <th className="text-left px-2">日中有意性</th>
                </tr>
              </thead>
              <tbody>
                {result.scores.map((s) => (
                  <tr key={s.ticker} className="border-b border-gray-100">
                    <td className="py-1 px-2 font-medium text-gray-700">{s.label}</td>
                    <td className="text-right px-2 text-gray-600">{s.n}</td>
                    <td className="text-right px-2 font-mono">{s.betaFull.toFixed(2)}</td>
                    <td className="text-right px-2 font-mono text-gray-600">{s.r2Full.toFixed(3)}</td>
                    <td className="text-right px-2 font-mono">{s.betaIntra.toFixed(2)}</td>
                    <td className="px-2"><StatBadge n={s.n} p={s.pIntra} significant={s.pIntra < 0.05} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 乖離日分析 */}
          <div className="pt-3 border-t border-gray-100 space-y-2">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className="text-gray-500">乖離日分析の対象指数:</span>
              {result.scores.map((s) => (
                <button
                  key={s.ticker}
                  onClick={() => setSelDriver(s.ticker)}
                  className={`px-2 py-0.5 rounded font-medium ${activeDriver === s.ticker ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {divergence ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div className="p-2 rounded border border-gray-200 bg-gray-50">
                    <div className="text-gray-500">同符号日(米国追随)</div>
                    <div className="font-mono">n={divergence.alignedN}</div>
                    <div className={`font-medium ${divergence.intraAligned >= 0 ? "text-green-700" : "text-red-700"}`}>日中 {fmtSignedPct(divergence.intraAligned)}</div>
                  </div>
                  <div className="p-2 rounded border border-purple-200 bg-purple-50">
                    <div className="text-gray-500">逆符号日(米国無視)</div>
                    <div className="font-mono">n={divergence.divergeN}</div>
                    <div className={`font-medium ${divergence.intraDiverge >= 0 ? "text-green-700" : "text-red-700"}`}>日中 {fmtSignedPct(divergence.intraDiverge)}</div>
                  </div>
                  <div className="p-2 rounded border border-amber-200 bg-amber-50">
                    <div className="text-gray-500">逆符号日→米国方向へ修正</div>
                    <div className="font-mono font-medium text-base text-amber-700">{fmtPct0(divergence.followUsRate)}</div>
                    <div className="text-[10px] text-gray-400">日中が米国符号だった割合</div>
                  </div>
                  <div className="p-2 rounded border border-gray-200 bg-gray-50 flex items-center">
                    <StatBadge n={divergence.divergeN} p={divergence.pDiverge} significant={divergence.pDiverge < 0.05} />
                  </div>
                </div>
                <div className={`rounded-md px-3 py-2 text-xs border ${
                  divergence.followUsRate > 0.55 ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                    : divergence.followUsRate < 0.45 ? "bg-red-50 border-red-200 text-red-900"
                    : "bg-gray-50 border-gray-200 text-gray-700"}`}>
                  {divergence.followUsRate > 0.55
                    ? "寄りが米国と逆に開いた日でも、日中は米国方向へ戻りやすい → 米国に逆らったギャップは“フェード(埋め)”の候補。"
                    : divergence.followUsRate < 0.45
                    ? "寄りが米国と逆に開いた日は、日中もギャップ方向へ続きやすい → 国内独自材料が優勢。米国逆張りは禁物。"
                    : "逆符号日の日中方向は米国/ギャップどちらにも偏らず、明確なエッジは出ていない。"}
                </div>
              </>
            ) : (
              <p className="text-xs text-gray-400">逆符号(乖離)日が少なく分析できません。</p>
            )}
          </div>
        </>
      )}

      <IntradayCaveat extra="R²=説明できた分散の割合(0〜1)。乖離日=寄りギャップの符号が前夜米国と反対だった日。" />

      <AnalysisGuide title="ドライバ選択・乖離日分析の詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"『前夜の米国』と一口に言っても、S&P500(全体)・NASDAQ(ハイテク)・SOX(半導体)・NYダウ(景気敏感大型)では中身が違う。銘柄ごとに“最も効く米国指数(支配ドライバ)”は異なる。まず4指数の説明力を比べて主ドライバを特定し、次にその指数と日本の寄りが食い違った日(乖離日)に何が起きるかを調べる。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"各指数について 当日 full = α + β·r_US を回帰し、決定係数 R² = 説明できた分散の割合(=corr²) を比較。R²最大が支配ドライバ。"}</li>
          <li>{"日中 intra への β も併記(取引可能なエッジの向き)。"}</li>
          <li>{"乖離日: sign(JPギャップ) ≠ sign(r_US) の日。逆に、同符号日は米国に素直に寄り付いた日。"}</li>
          <li>{"修正率 followUsRate: 乖離日のうち日中の符号が米国と一致した(=米国方向へ戻した)割合。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>R²(決定係数)</strong>: 説明変数がターゲットの変動をどれだけ説明できるかの割合。1に近いほど連動が強い。</li>
          <li><strong>支配ドライバ</strong>: その銘柄を最もよく動かす外部指数。半導体株ならSOX、内需株ならダウ寄り、など。</li>
          <li>例え: 複数のラジオ局(指数)のうち、その銘柄が一番はっきり受信している周波数を探す作業。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>他の手法(方法1〜6)のドライバ選択を、ここで特定した支配指数に合わせると連動が最も鮮明になる。</li>
          <li>修正率が高い → 米国に逆らった寄りは埋められやすい(ギャップ・フェード)。低い → 国内材料優勢で逆張り危険。</li>
          <li>複数指数のβが割れる(例: SOXにだけ強く反応)なら、その銘柄のテーマ性(半導体等)を裏付ける。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>指数間は相互に高相関(S&P500とNASDAQ等)。R²の僅差は誤差の範囲のことが多く、明確に突出した指数のみ信頼する。</li>
          <li>乖離日は元々少なく(特に主ドライバでは稀)、修正率の n が小さくなりがち。StatBadgeを確認。</li>
          <li>SOX等は取得できない時期・銘柄がある。取得失敗した指数はランキングから除外される。</li>
          <li>為替(円)や日本固有のイベントが乖離の主因のこともあり、米国だけで乖離を説明し切れない。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
