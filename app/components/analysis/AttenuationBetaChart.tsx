"use client";

import { useEffect, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { attenuationBeta } from "../../lib/attenuation-beta";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const PRESETS = [
  { ticker: "^N225", label: "日経225" },
  { ticker: "1306.T", label: "TOPIX(ETF)" },
  { ticker: "^GSPC", label: "S&P500" },
];

const LAGS = [1, 2, 3];

export default function AttenuationBetaChart({ prices }: Props) {
  const [benchTicker, setBenchTicker] = useState("^N225");
  const [benchPrices, setBenchPrices] = useState<PricePoint[] | null>(null);
  const [maxLag, setMaxLag] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/stock?ticker=${encodeURIComponent(benchTicker)}&range=10y`
        );
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json.prices) {
          setError("ベンチマーク取得失敗");
          setBenchPrices(null);
        } else setBenchPrices(json.prices);
      } catch {
        if (!cancelled) {
          setError("通信エラー");
          setBenchPrices(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [benchTicker]);

  const res = useMemo(
    () => (benchPrices ? attenuationBeta(prices, benchPrices, maxLag) : null),
    [prices, benchPrices, maxLag]
  );

  if (prices.length < 60) return null;

  const maxAbsLagBeta = res
    ? Math.max(0.001, ...res.lagBetas.map((l) => Math.abs(l.beta)))
    : 1;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">
          減衰バイアス補正β（ノイズで縮んだ市場感応度を補正）
        </h3>
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <div className="flex gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.ticker}
                onClick={() => setBenchTicker(p.ticker)}
                className={`px-2 py-0.5 rounded ${
                  benchTicker === p.ticker
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 hover:bg-gray-200"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 text-gray-600">
            <span>ラグ:</span>
            {LAGS.map((l) => (
              <button
                key={l}
                onClick={() => setMaxLag(l)}
                className={`px-2 py-0.5 rounded ${
                  maxLag === l
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-100 hover:bg-gray-200"
                }`}
              >
                ±{l}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && (
        <div className="text-xs text-gray-400">ベンチマーク読み込み中...</div>
      )}
      {error && <div className="text-xs text-red-500">{error}</div>}

      {res && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="p-2 rounded border border-gray-200 bg-gray-50">
              <div className="text-gray-500">素朴β (同時点OLS)</div>
              <div className="font-mono font-medium text-base">
                {res.betaOLS.toFixed(3)}
              </div>
              <div className="text-[10px] text-gray-400">ノイズで縮小</div>
            </div>
            <div className="p-2 rounded border border-emerald-200 bg-emerald-50">
              <div className="text-gray-500">補正β (Dimson)</div>
              <div className="font-mono font-medium text-base text-emerald-700">
                {res.betaDimson.toFixed(3)}
              </div>
              <div className="text-[10px] text-gray-400">真の市場感応度</div>
            </div>
            <div className="p-2 rounded border border-amber-200 bg-amber-50">
              <div className="text-gray-500">信頼性比 λ</div>
              <div className="font-mono font-medium text-base text-amber-700">
                {res.reliability.toFixed(2)}
              </div>
              <div className="text-[10px] text-gray-400">
                取りこぼし {(res.attenuation * 100).toFixed(0)}%
              </div>
            </div>
            <div className="p-2 rounded border border-gray-200 bg-gray-50">
              <div className="text-gray-500">相関 / R²</div>
              <div className="font-mono font-medium">
                {res.corr.toFixed(2)} / {res.rSquared.toFixed(2)}
              </div>
              <div className="text-[10px] text-gray-400">n={res.n}</div>
            </div>
          </div>

          {/* ラグ別β寄与 */}
          <div className="border border-gray-100 rounded p-3">
            <div className="text-xs text-gray-500 mb-2">
              ラグ別β寄与（ラグ0=当日、負=ベンチが先行。前後ラグの山が大きいほど非同期取引の影響大）
            </div>
            <div className="space-y-1">
              {res.lagBetas.map((l) => {
                const w = (Math.abs(l.beta) / maxAbsLagBeta) * 100;
                const isContemp = l.lag === 0;
                return (
                  <div key={l.lag} className="flex items-center gap-2 text-xs">
                    <span className="w-12 text-right font-mono text-gray-500">
                      {l.lag > 0 ? `+${l.lag}` : l.lag}
                    </span>
                    <div className="flex-1 h-4 bg-gray-100 rounded relative overflow-hidden">
                      <div
                        className={`h-full ${
                          isContemp ? "bg-blue-500" : "bg-indigo-400"
                        }`}
                        style={{ width: `${w}%` }}
                      />
                    </div>
                    <span className="w-14 text-right font-mono text-gray-600">
                      {l.beta.toFixed(3)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ヘッジ含意 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
            <div className="p-2 rounded border border-gray-200">
              <div className="text-gray-500">素朴ヘッジ比率</div>
              <div className="font-mono">
                ベンチを {res.hedgeNaive.toFixed(2)} 単位ショート
              </div>
            </div>
            <div className="p-2 rounded border border-emerald-200 bg-emerald-50">
              <div className="text-gray-500">補正ヘッジ比率</div>
              <div className="font-mono text-emerald-700">
                ベンチを {res.hedgeCorrected.toFixed(2)} 単位ショート
              </div>
            </div>
            <div
              className={`p-2 rounded border ${
                Math.abs(res.residualBeta) > 0.1
                  ? "border-red-200 bg-red-50"
                  : "border-gray-200"
              }`}
            >
              <div className="text-gray-500">素朴ヘッジ時の残存β</div>
              <div
                className={`font-mono ${
                  Math.abs(res.residualBeta) > 0.1 ? "text-red-600" : ""
                }`}
              >
                {res.residualBeta >= 0 ? "+" : ""}
                {res.residualBeta.toFixed(3)}
              </div>
              <div className="text-[10px] text-gray-400">
                市場中立のつもりが残る方向性
              </div>
            </div>
          </div>
        </>
      )}

      <AnalysisGuide title="減衰バイアス補正βの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {
            "個別株のリターンを市場指数のリターンで回帰した傾きがβ(市場感応度)。ところが指数側のリターンには『測定ノイズ』が乗っている——構成銘柄の一部が直近約定しておらず価格が古い(非同期取引・stale price)、ビッド/アスクの跳ね、丸めなど。説明変数にノイズが乗ると回帰の傾きは必ずゼロ方向に縮む(減衰バイアス)。つまり素朴なβは“真の感応度より小さく”出る。これを前後ラグを足し込むDimson法で補正する。"
          }
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            {
              "観測した指数リターン xᵒᵇˢ = x(真値) + u(測定ノイズ)。素朴OLSの傾きは βᵒᵇˢ = β·Var(x)/(Var(x)+Var(u)) = β·λ。λ=Var(x)/(Var(x)+Var(u)) を『信頼性比』と呼び、0〜1。ノイズが多いほどλが小さく、βが縮む。"
            }
          </li>
          <li>
            {
              "補正: βᵗʳᵘᵉ = βᵒᵇˢ / λ。本ツールはλを直接推定する代わりに、Dimson β = Σₖ βₖ(前後±Kラグの指数リターンで多重回帰した傾きの合計)で真の感応度を近似し、λ ≈ βOLS / βDimson と逆算する。"
            }
          </li>
          <li>
            {
              "残存β = βDimson − βOLS。素朴βだけでヘッジ(指数を空売り)すると、この分だけ市場エクスポージャが消し残る。"
            }
          </li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>減衰バイアス</strong>
            : 物差しの目盛りがブレていると、対象の長さを測るほど『平均化されて小さく』見える現象。ノイズの多い指数で測るほどβは過小評価される。
          </li>
          <li>
            <strong>非同期取引</strong>
            : 指数の中の小型株などが当日まだ約定しておらず、価格が“昨日のまま”。すると個別株の本当の反応が翌日の指数に現れ、当日だけ見ると相関が薄まる。前日・翌日ラグを足すと回復する。
          </li>
          <li>
            例え: エコー(やまびこ)。本当の声(感応度)は一度に返らず、前後にずれて返ってくる。全部足して初めて本来の声量がわかる。
          </li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方・投資判断</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>λ が小さい(例 0.7 以下)</strong>
            ほど、その銘柄×指数の組はノイズの影響が大きい。流動性の低い銘柄・寄り引けが薄い銘柄で起きやすい。
          </li>
          <li>
            <strong>市場中立/ヘッジ</strong>
            : ペアトレや指数ヘッジは素朴βだと過小ヘッジになり、相場全体が動いた時に想定外の損益(残存β)が出る。補正βでヘッジ枚数を決める。
          </li>
          <li>
            <strong>β中立ポートフォリオ</strong>
            やリスクパリティのβ入力も、素朴βだと市場リスクを取り過ぎる。補正βで組み直す。
          </li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            ラグを増やすほどノイズの多い係数を足すので、βDimsonの分散が増える。±1〜±2で十分なことが多い。
          </li>
          <li>
            真にβが時間変動する局面(レジーム変化)では、減衰でなく構造変化を拾っている可能性。条件付きβと併読する。
          </li>
          <li>
            λは符号が揃う前提。相関が極端に低い(R²がほぼ0)銘柄ではλが暴れるため、相関の十分ある組で使う。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
