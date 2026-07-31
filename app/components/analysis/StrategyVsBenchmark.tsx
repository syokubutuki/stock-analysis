"use client";

// 戦略 vs バイ&ホールド の共通表示部品（trading-usability-improvements.md §5）
//
// 原型は CustomReturnChart の超過リターンバー。これを全戦略系で再利用できる部品に昇格し、
// 「取引コストを実額で控除する」「回転率を必ず併記する」を標準装備にした。
//
// 使い方: 日次対数リターン列（コスト控除前）と B&H の日次対数リターン列、
// および representativeSpread(prices) の値を渡すだけ。コストの ON/OFF と手数料は本部品が持つ。

import { useMemo, useState } from "react";
import AnalysisGuide from "./AnalysisGuide";
import {
  CostModel,
  compareLogStrategy,
  compareFromPositions,
  StrategyComparison,
} from "../../lib/strategy-vs-benchmark";
import { PricePoint } from "../../lib/types";

const pct = (v: number, d = 2) => `${(v * 100).toFixed(d)}%`;

interface CommonProps {
  /** representativeSpread(prices) の戻り値（往復スプレッド比率） */
  spreadRT: number;
  /** 戦略名（バーの文言に使う） */
  label?: string;
  /** 極値ベース等で執行不能な理論上限のとき true → 実現不可ラベルを維持する */
  unrealizable?: boolean;
  unrealizableNote?: string;
  /** 既定でコスト控除を ON にするか */
  defaultDeduct?: boolean;
}

type Props = CommonProps &
  (
    | {
        mode?: "returns";
        strategyDaily: number[];
        buyHoldDaily: number[];
        /** 1バーあたり往復回数。毎日建て直すなら 1（既定） */
        roundTripsPerBar?: number;
        /** 往復回数を実測して渡す場合（マスク型戦略など）。指定時は roundTripsPerBar より優先 */
        roundTrips?: number;
      }
    | {
        mode: "positions";
        prices: PricePoint[];
        positions: number[];
      }
  );

export default function StrategyVsBenchmark(props: Props) {
  const { spreadRT, label = "戦略", unrealizable, unrealizableNote, defaultDeduct = false } = props;
  const [deduct, setDeduct] = useState(defaultDeduct);
  const [feeBps, setFeeBps] = useState(0);

  const cost: CostModel = useMemo(
    () => ({ enabled: deduct, spreadRT, feeBps }),
    [deduct, spreadRT, feeBps]
  );

  // props は判別可能ユニオンなので、memo の依存に入れる値を先に安定した形で取り出す。
  // props オブジェクト自体を依存にすると毎レンダで同一性が変わり memo が無効化される。
  const isPositions = props.mode === "positions";
  const posPrices = props.mode === "positions" ? props.prices : null;
  const positions = props.mode === "positions" ? props.positions : null;
  const strategyDaily = props.mode === "positions" ? null : props.strategyDaily;
  const buyHoldDaily = props.mode === "positions" ? null : props.buyHoldDaily;
  const roundTripsPerBar = props.mode === "positions" ? undefined : props.roundTripsPerBar;
  const roundTrips = props.mode === "positions" ? undefined : props.roundTrips;

  const cmp: StrategyComparison | null = useMemo(() => {
    if (isPositions) {
      if (!posPrices || !positions || posPrices.length < 2) return null;
      return compareFromPositions({ prices: posPrices, positions, cost });
    }
    if (!strategyDaily || !buyHoldDaily) return null;
    if (strategyDaily.length === 0 || buyHoldDaily.length === 0) return null;
    return compareLogStrategy({ strategyDaily, buyHoldDaily, cost, roundTripsPerBar, roundTrips });
  }, [isPositions, posPrices, positions, strategyDaily, buyHoldDaily, roundTripsPerBar, roundTrips, cost]);

  if (!cmp) return null;

  const win = cmp.excessTotal > 0;
  const lose = cmp.excessTotal < 0;
  const tone = win
    ? "bg-green-50 border-green-200"
    : lose
    ? "bg-red-50 border-red-200"
    : "bg-gray-50 border-gray-200";
  const signed = (v: number, d = 2) => `${v > 0 ? "+" : ""}${pct(v, d)}`;
  const excessColor = win ? "text-green-700" : lose ? "text-red-700" : "";

  return (
    <div className="space-y-2">
      <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 p-3 rounded-lg border text-sm ${tone}`}>
        <span className="font-medium">
          {win ? `${label}がB&Hに勝っています` : lose ? `${label}がB&Hに負けています` : `${label}とB&Hが同等です`}
        </span>
        <span>
          B&H累積: <span className="font-mono">{pct(cmp.buyHold.totalReturn)}</span>
        </span>
        <span>
          {label}累積: <span className="font-mono">{pct(cmp.strategy.totalReturn)}</span>
        </span>
        <span>
          超過リターン: <span className={`font-mono font-medium ${excessColor}`}>{signed(cmp.excessTotal)}</span>
        </span>
        <span>
          超過年率: <span className={`font-mono font-medium ${excessColor}`}>{signed(cmp.excessAnnual)}</span>
        </span>
        <span>
          超過シャープ:{" "}
          <span className={`font-mono font-medium ${cmp.excessSharpe > 0 ? "text-green-700" : cmp.excessSharpe < 0 ? "text-red-700" : ""}`}>
            {cmp.excessSharpe > 0 ? "+" : ""}
            {cmp.excessSharpe.toFixed(3)}
          </span>
        </span>
      </div>

      {/* コスト制御と回転率 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-600">
        <label className="flex items-center gap-1.5 cursor-pointer" title="往復スプレッド＋手数料を各往復から控除する">
          <input type="checkbox" checked={deduct} onChange={(e) => setDeduct(e.target.checked)} />
          <span className={deduct ? "font-medium text-gray-800" : ""}>取引コストを控除</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-gray-500">片道手数料</span>
          <input
            type="number"
            min={0}
            max={200}
            step={1}
            value={feeBps}
            onChange={(e) => setFeeBps(Math.max(0, Number(e.target.value) || 0))}
            className="w-16 px-1.5 py-0.5 border border-gray-200 rounded font-mono text-right"
            disabled={!deduct}
          />
          <span className="text-gray-500">bps</span>
        </label>
        <span className="text-gray-500">
          推定往復スプレッド <span className="font-mono">{pct(spreadRT, 3)}</span>
        </span>
        <span className="text-gray-500">
          1往復コスト <span className="font-mono">{pct(cmp.costRT, 3)}</span>
        </span>
        <span className="text-gray-500">
          回転率 <span className="font-mono">{cmp.tripsPerYear.toFixed(0)}</span> 往復/年
        </span>
        {deduct && cmp.costTotal > 0 && (
          <span className="text-gray-500">
            総コスト <span className="font-mono text-red-700">−{pct(cmp.costTotal)}</span>
            （年率 −{pct(cmp.costAnnual)}）
          </span>
        )}
      </div>

      {cmp.flipsSign && (
        <div className="p-2 rounded border border-amber-200 bg-amber-50 text-xs text-amber-900">
          <span className="font-medium">コストで結論が反転しました。</span>
          コスト控除前は B&H に勝っていましたが（+{pct(cmp.strategyGross.totalReturn - cmp.buyHold.totalReturn)}）、
          年 {cmp.tripsPerYear.toFixed(0)} 往復ぶんのコストを払うと負けに転じます。この戦略のエッジは
          コストより小さいので、実行しても取りに行けません。
        </div>
      )}

      {unrealizable && (
        <div className="p-2 rounded border border-gray-300 bg-gray-100 text-xs text-gray-700">
          <span className="font-medium">実現不可（理論上限）:</span>{" "}
          {unrealizableNote ??
            "高値売り・安値買いなど、事後にしか分からない価格での約定を前提にしています。コスト控除後の数値も執行可能性を保証しません。"}
        </div>
      )}

      <AnalysisGuide title="超過リターンとコスト控除の読み方">
        <p className="font-medium text-gray-700">1. 何を比較しているか</p>
        <p>
          同じ期間・同じ銘柄で、「戦略の指示どおり建てた場合」と「初日に買って持ち続けた場合（バイ&ホールド、B&H）」の
          累積対数リターンを比べています。差が<span className="font-medium">超過リターン</span>です。B&H は
          何も判断しない基準線なので、超過がプラスでなければ「判断した意味がなかった」ことになります。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>{"累積対数リターン: R = Σ_t r_t,  r_t = ln(P_exit,t / P_entry,t)"}</p>
        <p>{"年率: R_annual = R / (N/252)  （252 = 年間営業日数）"}</p>
        <p>{"超過: ΔR = R_戦略 − R_B&H,  ΔSharpe = SR_戦略 − SR_B&H"}</p>
        <p>
          コストは建玉額に比例するので、富の推移は {"W ← W·(1+r)·(1−c)"} となり、対数をとると
          {" ln W ← ln W + r + ln(1−c)"}。つまり<span className="font-medium">1往復あたり ln(1−c) を足す</span>のが
          厳密な控除です（近似ではありません）。ここで
        </p>
        <p>{"c = 往復スプレッド + 2 × 片道手数料"}</p>
        <p>
          往復スプレッドは Corwin-Schultz 推定量の中央値（`representativeSpread`）を使っています。
          日足の高安から実効スプレッドを逆算した値で、板情報を使わない近似です。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <span className="font-medium">往復（ラウンドトリップ）</span>: 建てて畳むまでの1組。買って売る、
            または売って買い戻すまでを1往復と数えます。
          </li>
          <li>
            <span className="font-medium">回転率</span>: 年間の往復回数。毎日建て直す戦略は約252往復/年、
            B&H は期間全体で1往復です。
          </li>
          <li>
            <span className="font-medium">実効スプレッド</span>: 板の売値と買値の差。指値の見た目より広いことが多く、
            成行で往復すると実際に失う分。
          </li>
          <li>
            <span className="font-medium">bps</span>: ベーシスポイント。1bps = 0.01%。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          コストは「回転ドアの通行料」です。エッジ（1回あたりの期待利益）が通行料より大きいときだけ、
          通れば通るほど儲かります。逆にエッジが通行料より小さいと、
          <span className="font-medium">回すほど確実に負けます</span>。だから超過リターンだけでなく
          回転率を必ず見る必要があります。同じエッジでも、年252回転の戦略は年1回転の B&H の252倍の通行料を払います。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>緑（超過プラス）でも、<span className="font-medium">コスト控除をONにして緑が残るか</span>を必ず確認する。</li>
          <li>
            琥珀色の「コストで結論が反転しました」が出たら、その戦略は<span className="font-medium">紙の上だけのエッジ</span>。
            コストより小さいエッジは取りに行けません。
          </li>
          <li>
            超過リターンがプラスでも超過シャープがマイナスなら、リターンを増やした分以上にリスクを増やしています。
            レバレッジで B&H 側を揃えれば逆転しうるので、優位とは言えません。
          </li>
          <li>
            B&H 側にも1往復ぶんのコストを課しています（買って最後に売るため）。だから
            コストONで超過が悪化するのは、戦略側の回転率が高いときだけです。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            採用の最低条件は「コスト控除後に超過リターンと超過シャープがともにプラス」。片方だけなら見送る。
          </li>
          <li>
            回転率を下げる方向に設計を修正できないか考える。同じシグナルでも、保有期間を延ばせば
            コスト総額は回転率に比例して下がります。
          </li>
          <li>
            手数料 bps に自分の証券会社の実額を入れる。スプレッドは推定値ですが、手数料は既知なので、
            自分の条件での損益分岐が分かります。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <span className="font-medium">スプレッドは推定値</span>。Corwin-Schultz は日足の高安からの逆算なので、
            出来高が薄い銘柄では誤差が大きく、負値が出ることもあります（0にクリップしています）。
          </li>
          <li>
            <span className="font-medium">スリッページ・市場インパクトは含みません</span>。建玉が大きいほど
            実際のコストはここより悪化します（容量の議論は別分析）。
          </li>
          <li>
            <span className="font-medium">これはインサンプルの比較です</span>。パラメータを動かして超過リターンが
            最大になる設定を選ぶと、それだけで偽の超過が出ます。ヌル較正やウォークフォワードを別途通してください。
          </li>
          <li>
            <span className="font-medium">税は含みません</span>。実現益課税は回転率に比例して効くので、
            課税口座では回転の高い戦略がさらに不利になります。
          </li>
          <li>コストは全期間で一定と仮定しています。実際は流動性が枯れる局面で拡大します。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
