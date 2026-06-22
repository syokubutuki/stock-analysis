"use client";

import { CriterionStat, DerivedCriteria } from "../../lib/discretionary-criteria";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  criteria: DerivedCriteria;
}

function fmt(v: number, unit: string): string {
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  const s = v.toFixed(digits);
  return unit ? `${s}${unit}` : s;
}

// 全期間分布の中で平均値がどこに位置するかを示すバー
function DistributionBar({ stat, accent }: { stat: CriterionStat; accent: string }) {
  const range = stat.fullMax - stat.fullMin;
  const toPct = (v: number) => (range > 0 ? ((v - stat.fullMin) / range) * 100 : 50);
  const meanPct = Math.max(0, Math.min(100, toPct(stat.mean)));
  const loPct = Math.max(0, Math.min(100, toPct(stat.mean - stat.std)));
  const hiPct = Math.max(0, Math.min(100, toPct(stat.mean + stat.std)));

  return (
    <div className="relative h-2 w-full rounded-full bg-gray-100">
      <div
        className="absolute h-2 rounded-full opacity-30"
        style={{
          left: `${loPct}%`,
          width: `${Math.max(1, hiPct - loPct)}%`,
          backgroundColor: accent,
        }}
      />
      <div
        className="absolute top-1/2 h-3 w-1 -translate-y-1/2 rounded-full"
        style={{ left: `calc(${meanPct}% - 2px)`, backgroundColor: accent }}
      />
    </div>
  );
}

function interpret(stat: CriterionStat): string | null {
  if (stat.count < 2) return null;
  if (stat.percentile <= 20) return "全期間でも低め";
  if (stat.percentile >= 80) return "全期間でも高め";
  return null;
}

function CriteriaTable({
  title,
  stats,
  count,
  accent,
}: {
  title: string;
  stats: CriterionStat[];
  count: number;
  accent: string;
}) {
  return (
    <div className="flex-1 min-w-[280px]">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="font-semibold" style={{ color: accent }}>
          {title}
        </h3>
        <span className="text-xs text-gray-500">{count}回の取引から</span>
      </div>
      {count === 0 ? (
        <p className="text-sm text-gray-400 py-4">
          チャート上で{title.includes("買") ? "買い" : "売り"}を打つと基準が表示されます
        </p>
      ) : (
        <div className="space-y-2.5">
          {stats.map((s) => {
            const hint = interpret(s);
            return (
              <div key={s.id} className="text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-gray-600" title={s.description}>
                    {s.label}
                  </span>
                  <span className="font-mono font-medium text-gray-900">
                    {fmt(s.mean, s.unit)}
                    <span className="text-gray-400 font-normal"> ±{fmt(s.std, "")}</span>
                  </span>
                </div>
                <DistributionBar stat={s} accent={accent} />
                <div className="flex justify-between text-[11px] text-gray-400 mt-0.5">
                  <span>
                    範囲 {fmt(s.min, "")}〜{fmt(s.max, s.unit)}
                  </span>
                  <span>
                    {hint && <span style={{ color: accent }}>{hint} · </span>}
                    全期間中 {s.percentile.toFixed(0)}%地点
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function DiscretionaryCriteriaPanel({ criteria }: Props) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="mb-3">
        <h2 className="font-bold text-gray-900">逆算した裁量トレードの基準</h2>
        <p className="text-xs text-gray-500 mt-1">
          ルールを決めるのではなく、あなたが実際に売買したタイミングから「どんな数値の局面で動いているか」を集計しています。
          点が多いほど基準が安定します。バーは全期間の分布の中での位置 (中央のマーカー=平均、帯=±標準偏差)。
        </p>
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-4">
        <CriteriaTable title="買いの基準" stats={criteria.buy} count={criteria.buyCount} accent="#16a34a" />
        <CriteriaTable title="売りの基準" stats={criteria.sell} count={criteria.sellCount} accent="#dc2626" />
      </div>
      <p className="text-[11px] text-gray-400 mt-3">
        ※ これは過去の売買傾向の「記述」であり、将来の利益を保証するものではありません。
      </p>

      <AnalysisGuide title="逆算分析の詳細理論">
        <p className="font-medium text-gray-700">1. 何をしているか</p>
        <p>
          一般的なテクニカル分析は「RSIが30以下になったら買う」のように<strong>ルール→売買</strong>の順で考えます。
          ここではその逆で、あなたが実際にチャート上で打った売買の日付を集め、その各日における10種類の特徴量
          (RSI・MACDヒストグラム・ボリンジャー%B・25日乖離率・モメンタム・出来高比・実現ボラ・レンジ内位置・当日リターン)
          を後から測定します。<strong>売買→基準</strong>の順に「無意識の癖」を数値として浮かび上がらせるのが目的です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          ある特徴量 f について、買った日の集合を B とすると、買い基準の中心と散らばりは
          {" "}平均 μ = (1/|B|) Σ x_f、標準偏差 σ = √((1/|B|) Σ (x_f − μ)²) で表します。
          さらに全期間の分布の中で μ が下から何%の位置かをパーセンタイル
          {" "}P = (μ以下の日数 / 全日数) × 100 として算出します。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>標準偏差(±)</strong>: あなたの売買がどれだけ一貫しているか。小さいほど毎回似た局面で売買している。</li>
          <li><strong>パーセンタイル</strong>: 全期間の分布の中での位置。例えばRSIの買い平均が20%地点なら、普段より売られすぎの局面を選んで買っている。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>±の帯が狭い特徴量ほど、あなたが強く意識している基準。</li>
          <li>パーセンタイルが両端 (20%以下 / 80%以上) に寄る特徴量は「珍しい局面」を狙う癖を示す。</li>
          <li>買いと売りで方向が逆になっている特徴量 (例: 買いはRSI低・売りはRSI高) は、あなたの戦略が逆張り型であることを示す。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>自分でも気づいていなかった売買の癖を言語化し、再現性のあるルールへ昇華できる。</li>
          <li>この基準は下のバックテストでそのまま「ルール」として任意期間に適用し、汎化するか検証できる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>売買回数が少ない (目安: 各5回未満) と平均・標準偏差が不安定で、偶然の癖を拾ってしまう。</li>
          <li>これは過去の「記述」であって、利益を出す売買だったかは別問題。良い癖も悪い癖も等しく数値化される。</li>
          <li>相場のレジーム (強気/弱気) が変われば、同じ基準が通用するとは限らない。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
