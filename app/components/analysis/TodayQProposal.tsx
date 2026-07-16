"use client";

// 株式原論「合流点」UI ─ 銘柄を選ぶと、全系(Corollary)が指す単一の建玉 q を提案する。
//
// このコンポーネントが原論ページの存在意義を確定させる:
// 21系の「P の記述」を、符号・大きさ・タイミング・期間という q の4成分に畳み込み、
// 各寄与を元の系カード(#C1 …)へトレース可能にする。命題4(分析の価値は q への翻訳で測る)を
// ページ構造そのもので体現する。

import { useEffect, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  synthesizeQ,
  DIMENSION_LABEL,
  type QDimension,
  type QContribution,
} from "../../lib/axioms/q-synthesis";
import AnalysisGuide from "./AnalysisGuide";
import QBacktestChart from "./QBacktestChart";

const PRESETS = [
  { ticker: "7203.T", label: "トヨタ" },
  { ticker: "6758.T", label: "ソニー" },
  { ticker: "9984.T", label: "SBG" },
  { ticker: "^N225", label: "日経225" },
  { ticker: "AAPL", label: "Apple" },
];

const DIM_ORDER: QDimension[] = ["sign", "size", "timing", "horizon", "friction"];

const DIM_COLOR: Record<QDimension, string> = {
  sign: "border-blue-200 bg-blue-50",
  size: "border-emerald-200 bg-emerald-50",
  timing: "border-amber-200 bg-amber-50",
  horizon: "border-violet-200 bg-violet-50",
  friction: "border-rose-200 bg-rose-50",
};

function ContribRow({ c }: { c: QContribution }) {
  return (
    <div className="flex items-baseline gap-2 py-1 text-xs">
      <a
        href={`#${c.corollaryId}`}
        className="shrink-0 rounded bg-indigo-600 px-1.5 py-0.5 font-bold text-white hover:bg-indigo-700"
        title="対応する系カードへ"
      >
        {c.corollaryId}
      </a>
      <div className="min-w-0">
        <span className="font-medium text-gray-800">{c.theory}: </span>
        <span className="font-mono text-gray-900">{c.value}</span>
        <div className="text-gray-500">{c.detail}</div>
      </div>
    </div>
  );
}

// /portfolio や個別分析からの deep-link(?ticker=)を初期銘柄に反映する。
function initialTicker(): string {
  if (typeof window !== "undefined") {
    const t = new URLSearchParams(window.location.search).get("ticker");
    if (t && t.trim()) return t.trim();
  }
  return "7203.T";
}

export default function TodayQProposal() {
  const [ticker, setTicker] = useState(initialTicker);
  const [input, setInput] = useState(ticker);
  const [prices, setPrices] = useState<PricePoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/stock?ticker=${encodeURIComponent(ticker)}&range=10y`
        );
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json.prices) {
          setError("取得失敗");
          setPrices(null);
        } else {
          setPrices(json.prices);
        }
      } catch {
        if (!cancelled) {
          setError("通信エラー");
          setPrices(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  const rec = useMemo(
    () => (prices ? synthesizeQ(prices) : null),
    [prices]
  );

  const submit = () => {
    const t = input.trim();
    if (t) setTicker(t);
  };

  return (
    <section className="rounded-xl border-2 border-indigo-300 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-gray-900">
            今日の q 提案 ─ 全系の合流点
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            21系（下の系カード）が指す建玉 q を、符号・大きさ・タイミング・期間に畳み込む。各寄与は系へリンク。
          </p>
        </div>
      </div>

      {/* 銘柄入力 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="7203.T / AAPL / ^N225"
          className="w-40 rounded-lg border border-gray-300 px-2 py-1 text-sm"
        />
        <button
          onClick={submit}
          className="rounded-lg bg-indigo-600 px-3 py-1 text-sm text-white hover:bg-indigo-700"
        >
          畳み込む
        </button>
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.ticker}
              onClick={() => {
                setInput(p.ticker);
                setTicker(p.ticker);
              }}
              className={`rounded px-2 py-0.5 text-xs ${
                ticker === p.ticker
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 hover:bg-gray-200"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {loading && <span className="text-xs text-gray-400">計算中…</span>}
        {error && <span className="text-xs text-rose-500">{error}</span>}
      </div>

      {/* 提案 q */}
      {rec && (
        <>
          <div className="mt-4 grid gap-2 sm:grid-cols-4">
            <div
              className={`rounded-lg border p-3 ${
                rec.sign === 1
                  ? "border-blue-300 bg-blue-50"
                  : rec.sign === -1
                    ? "border-rose-300 bg-rose-50"
                    : "border-gray-200 bg-gray-50"
              }`}
            >
              <div className="text-[11px] text-gray-500">符号</div>
              <div className="text-lg font-bold text-gray-900">{rec.signLabel}</div>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <div className="text-[11px] text-gray-500">大きさ |q|</div>
              <div className="text-lg font-bold text-gray-900">
                {(rec.sizeFraction * 100).toFixed(0)}%
              </div>
              <div className="text-[10px] text-gray-500">律速: {rec.sizeBinding}</div>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="text-[11px] text-gray-500">タイミング</div>
              <div className="text-sm font-bold text-gray-900">{rec.timingLabel}</div>
            </div>
            <div className="rounded-lg border border-violet-200 bg-violet-50 p-3">
              <div className="text-[11px] text-gray-500">保有期間</div>
              <div className="text-lg font-bold text-gray-900">{rec.horizonDays}営業日</div>
            </div>
          </div>

          {/* 新3系のサマリ(C17/C9/C10) */}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
            <span>
              レジーム: <b className="text-gray-700">{rec.regimeLabel}</b>（確信
              {(rec.regimeConfidence * 100).toFixed(0)}%, C17）
            </span>
            <span>
              曜日エッジ:{" "}
              <b className={rec.timingSignificant ? "text-emerald-600" : "text-gray-500"}>
                {rec.timingSignificant ? "FDR<0.10 で有意" : "FDR後 有意なし"}
              </b>
              （C9）
            </span>
            <span>
              コスト: 往復 <b className="text-gray-700">{(rec.assumedCost * 100).toFixed(2)}%</b>
              （C10 実推定）
            </span>
          </div>

          {/* capstone 一文 */}
          <p
            className={`mt-3 rounded-lg p-3 text-xs leading-relaxed ${
              rec.sign === 0 || rec.frictionWarn
                ? "bg-gray-100 text-gray-600"
                : "bg-indigo-50 text-indigo-900"
            }`}
          >
            {rec.note}
          </p>

          {/* 寄与内訳(次元別) */}
          <div className="mt-3">
            <div className="mb-1 text-xs font-bold text-gray-700">
              寄与内訳（各系 → q のどの成分を動かすか）
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {DIM_ORDER.map((dim) => {
                const rows = rec.contributions.filter((c) => c.dimension === dim);
                if (rows.length === 0) return null;
                return (
                  <div
                    key={dim}
                    className={`rounded-lg border p-2 ${DIM_COLOR[dim]}`}
                  >
                    <div className="mb-0.5 text-[11px] font-bold text-gray-600">
                      {DIMENSION_LABEL[dim]}
                    </div>
                    <div className="divide-y divide-white/60">
                      {rows.map((c, i) => (
                        <ContribRow key={i} c={c} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 配分ハンドオフ: 単一銘柄の q では決まらない C2/C18/C20 は /portfolio の領域 */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-indigo-300 bg-indigo-50/40 p-2 text-xs">
            <span className="text-gray-600">
              配分（C2 平均分散 / C18 多期間 / C20 分散の限界）は<b>単一銘柄では決まらない</b>。銘柄間の q はポートフォリオの領域へ。
            </span>
            <a
              href={`/portfolio?add=${encodeURIComponent(ticker)}`}
              className="shrink-0 rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-700"
            >
              {ticker} を /portfolio で配分検討 →
            </a>
          </div>

          {/* 検証: 上で主張した q が、実際に W を改善するかを過去に当てて確かめる(命題4) */}
          <div className="mt-4">
            {prices && <QBacktestChart key={ticker} prices={prices} />}
          </div>
        </>
      )}

      {!rec && !loading && prices && (
        <p className="mt-3 text-xs text-gray-500">
          データが不足しています（日次120本以上が必要）。
        </p>
      )}

      <AnalysisGuide title="この合流点の読み方と限界（株式原論）">
        <p className="font-medium text-gray-700">1. 何をしているか</p>
        <p>
          各系（下の21カード）は「P（価格）のある性質」を測る営みにすぎない。単体では命題4により
          価値ゼロ。ここではその測定を、我々が唯一動かせる建玉 q の
          <b>符号・大きさ・タイミング・保有期間</b>という4成分に翻訳し、単一の提案に畳み込む。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 各成分の決まり方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>符号</b>: 価格自身の分散比 VR(5) がトレンド系（&gt;1）か回帰系（&lt;1）かを判定し、
            順張り/逆張りの規則を選ぶ（C4/C8/C12）。ドリフトの t 値が閾値未満なら不参加（C16・命題3）。
          </li>
          <li>
            <b>大きさ</b>: 連続 Kelly f*=μ/σ²（C1/C14）を半分にし（C15）、1日 VaR 予算で上限を課し（C6）、
            期待対数成長率 g&gt;0 を確認する（C21）。もっとも厳しい制約が律速。
          </li>
          <li>
            <b>タイミング</b>: 曜日×曜日グリッドで滞在日あたり最良の建て/外し曜日（C9）。
          </li>
          <li>
            <b>保有期間</b>: 分散比 VR(h) を最大効率化する h*（C8）。回帰的なら長く、モメンタム的なら短く。
          </li>
          <li>
            <b>摩擦</b>: 粗エッジからコストを引いた純エッジ（C10・命題5）。負なら q=0 が最適。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>「上がりそう」ではなく「どう持つか」を直接読む。符号・大きさ・期間の3点が揃って初めて注文になる。</li>
          <li>不参加（符号0 or 摩擦負け）も明確な決定。無理に建てない根拠として使える。</li>
          <li>各寄与の系 ID をクリックすると、その導出鎖（会計恒等式からの一本道）に飛べる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            μ・σ・VR は<b>過去の推定</b>にすぎず将来を保証しない。VR による符号判定は単純化で、
            レジーム変化に弱い（C17 の信念加重は未反映）。
          </li>
          <li>
            曜日エッジ（C9）は<b>多重検定未補正</b>。ここでの最良セルは仮説であり、FDR/PBO 検証は
            edge 節・曜日エッジ節で別途行うこと。
          </li>
          <li>
            コストは仮のプレースホルダ（往復10bps）。実効スプレッド推定（C10 SpreadEstimator）に置換すべき。
          </li>
          <li>
            これは<b>単一銘柄</b>の q。銘柄間配分（C2/C18/C20）は /portfolio の領域で、ここでは扱わない。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">公理的位置づけ（株式原論）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>立脚する公準/命題</b>: 命題4（分析の価値定理）＝本節そのものの存在根拠。</li>
          <li><b>測る P の性質</b>: 全系の測定（ドリフト・分散・分散比・テール・暦依存）。</li>
          <li><b>変える q の選択</b>: 符号・大きさ・タイミング・保有期間の4成分すべて。</li>
          <li><b>摩擦の扱い</b>: 純エッジ＝粗エッジ−コスト。負なら建玉ゼロを提案（命題5）。</li>
        </ul>
      </AnalysisGuide>
    </section>
  );
}
