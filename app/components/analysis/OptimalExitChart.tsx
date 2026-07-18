"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  computeOptimalExit,
  ExitSide,
  EntryTiming,
  OPTIMAL_EXIT_CONST,
  binCenter,
  StratStat,
} from "../../lib/optimal-exit";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const { H_MAX, N_BINS } = OPTIMAL_EXIT_CONST;
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

function drawPolicy(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  action: import("../../lib/optimal-exit").Action[][],
  count: number[][],
) {
  const ml = 64;
  const mr = 12;
  const mt = 30;
  const mb = 26;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;
  const cw = plotW / H_MAX;
  const ch = plotH / N_BINS;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("最適手仕舞い方策（赤=降りる / 緑=続ける、濃さ=標本数）", ml - 56, 14);

  let maxC = 1;
  for (let h = 0; h < H_MAX; h++) for (let b = 0; b < N_BINS; b++) maxC = Math.max(maxC, count[h][b]);

  for (let h = 0; h < H_MAX; h++) {
    for (let b = 0; b < N_BINS; b++) {
      const x = ml + h * cw;
      const y = mt + (N_BINS - 1 - b) * ch; // z大を上に
      const c = count[h][b];
      const alpha = c === 0 ? 0.04 : 0.15 + 0.7 * Math.min(1, c / (maxC * 0.5));
      const exit = action[h][b] === "exit" && c > 0;
      ctx.fillStyle =
        c === 0 ? "rgba(0,0,0,0.03)" : exit ? `rgba(220,38,38,${alpha})` : `rgba(22,163,74,${alpha})`;
      ctx.fillRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
    }
  }

  // z軸ラベル（左）
  ctx.fillStyle = "#6b7280";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "right";
  for (let b = 0; b < N_BINS; b += 2) {
    const y = mt + (N_BINS - 1 - b) * ch + ch / 2;
    ctx.fillText(`${binCenter(b).toFixed(1)}σ`, ml - 4, y + 3);
  }
  // 保有日ラベル（下）
  ctx.textAlign = "center";
  for (let h = 0; h < H_MAX; h++) {
    ctx.fillText(`h=${h + 1}`, ml + h * cw + cw / 2, mt + plotH + 14);
  }
  ctx.save();
  ctx.translate(12, mt + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("含み損益 z（σ単位）↑", 0, 0);
  ctx.restore();
}

function statCard(label: string, s: StratStat, highlight: "good" | "base" | "over" | null) {
  const bg =
    highlight === "good"
      ? "bg-green-50 border-green-200"
      : highlight === "over"
        ? "bg-amber-50 border-amber-200"
        : "bg-gray-50 border-gray-200";
  return (
    <div className={`rounded border p-2 ${bg}`}>
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className="text-sm font-semibold text-gray-900">Sharpe {s.sharpe.toFixed(2)}</div>
      <div className="text-[10px] text-gray-600">
        μ {pct(s.meanRet)} / 勝率 {(s.winRate * 100).toFixed(0)}% / 保有 {s.meanHeld.toFixed(1)}d
      </div>
    </div>
  );
}

export default function OptimalExitChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [side, setSide] = useState<ExitSide>("long");
  const [entryTiming, setEntryTiming] = useState<EntryTiming>("open");

  const result = useMemo(
    () => computeOptimalExit(prices, { side, entryTiming, entryDow: 1 }),
    [prices, side, entryTiming],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result.ok) return;
    const init = initCanvas(canvas, 300);
    if (!init) return;
    drawPolicy(init.ctx, init.width, init.height, result.policy.action, result.policy.count);
  }, [result]);

  const beatsHold = result.ok && result.optimalOOS.sharpe > result.holdToEnd.sharpe;
  const overfitGap = result.ok ? result.optimalIS.sharpe - result.optimalOOS.sharpe : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-800">
          状態依存の最適手仕舞い：月曜Open建玉後、いつ降りるか
        </h3>
        <span className="text-[10px] text-gray-400">
          ボラ単位の含み損益z×保有日を状態に、後退帰納法で停止方策を解く
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-gray-500">方向</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={side}
            onChange={(e) => setSide(e.target.value as ExitSide)}
          >
            <option value="long">買い（ロング）</option>
            <option value="short">売り（ショート）</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">建てタイミング</span>
          <select
            className="border border-gray-200 rounded px-1 py-0.5"
            value={entryTiming}
            onChange={(e) => setEntryTiming(e.target.value as EntryTiming)}
          >
            <option value="open">月曜 始値</option>
            <option value="close">月曜 終値</option>
          </select>
        </label>
      </div>

      {result.ok ? (
        <>
          <div
            className={`mt-3 rounded p-2.5 text-xs border ${
              beatsHold ? "bg-green-50 border-green-200 text-green-900" : "bg-gray-50 border-gray-200 text-gray-700"
            }`}
          >
            <div className="font-semibold">
              {beatsHold
                ? `最適手仕舞いはOOSで「金曜まで持つ」を上回る（Sharpe ${result.optimalOOS.sharpe.toFixed(2)} vs ${result.holdToEnd.sharpe.toFixed(2)}）`
                : `最適手仕舞いはOOSで「金曜まで持つ」を超えられない（Sharpe ${result.optimalOOS.sharpe.toFixed(2)} vs ${result.holdToEnd.sharpe.toFixed(2)}）`}
            </div>
            <div className="mt-1 leading-relaxed">
              in-sample の最適方策は Sharpe {result.optimalIS.sharpe.toFixed(2)} と見栄えしますが、これは
              <b>過剰最適化の見かけ</b>です。学習と検定を分けたOOSでは{" "}
              {result.optimalOOS.sharpe.toFixed(2)}（ギャップ {overfitGap >= 0 ? "+" : ""}
              {overfitGap.toFixed(2)}）まで縮みます。
              {beatsHold
                ? " OOSでも上回るなら、状態依存の手仕舞いに小さな価値があります。"
                : " このケースでは、凝った手仕舞いより「金曜まで持つ」単純ルールが実質最良です。"}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
            {statCard("最適手仕舞い（OOS）", result.optimalOOS, beatsHold ? "good" : null)}
            {statCard("金曜まで持つ", result.holdToEnd, "base")}
            {statCard("建て日引けで即降り", result.exitDay1, "base")}
            {statCard("最適（IS・過剰最適化の目安）", result.optimalIS, "over")}
          </div>

          <div className="mt-3">
            <canvas ref={canvasRef} />
          </div>

          <p className="mt-1 text-[10px] text-gray-400 leading-relaxed">
            {result.nWeeks}週（{result.from}〜{result.to}）。z = 建値からの累積対数リターン ÷ 建玉時の日次σ。
            方策は全データ学習（可視化用）。Sharpe はトレード単位を年率化（×√52）。赤い帯（降りる）は多くの銘柄で
            「zが高く伸びきった後半日」に限られ、大半は緑（金曜まで継続）になります。
          </p>

          <AnalysisGuide title="状態依存の最適手仕舞いの詳細理論">
            <p className="font-medium text-gray-700">1. 何をしているか</p>
            <p>
              「週後半リターンを1発で当てる」のではなく、<b>いつ降りるか</b>を最適停止問題として解きます。
              月曜Openで建てた後、各営業日の引けで「手仕舞う／続ける」を選べるとき、
              その時点の状態に応じた最適な行動をデータから求めます。
            </p>
            <p>
              状態は2つ：<b>保有日数 h</b>（週内のどこにいるか。金曜で強制手仕舞い）と、
              <b>ボラ単位の含み損益 z</b>（建値からの累積リターンを建玉時の日次σで割ったもの）。
              σで割ることで、高ボラ週も低ボラ週も同じ物差しに載り、レジームに依存しない方策になります。
            </p>

            <p className="font-medium text-gray-700 mt-3">2. 数式：後退帰納法</p>
            <p>価値関数 V を週の終わりから逆向きに解きます：</p>
            <p className="pl-2">{"V(H, z) = z          （金曜引け＝強制手仕舞い、実現 z）"}</p>
            <p className="pl-2">{"V(h, z) = max( z ,  E[ V(h+1, z') | h, z ] )"}</p>
            <p>
              第1項は<b>今降りて z を実現</b>、第2項は<b>続けたときの期待価値</b>。継続価値の期待は
              過去の全トレード週から経験的に推定します（(h, zビン)ごとに翌日どのビンへ動いたかを数える）。
              各ビンで「今降りる価値 ≥ 続ける価値」なら降りる。こうして<b>停止境界 z*(h)</b> が
              データから内生的に立ち上がります。利確側（zが高い）と損切り側（zが低い）の両方が、
              モメンタムか平均回帰かに応じて自動的に決まります。
            </p>

            <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><b>価値関数 V(h,z)</b>：状態(h,z)から最適に行動したときに期待できる最終リターン（σ単位）。</li>
              <li><b>後退帰納法</b>：終端（金曜）から逆向きに各状態の最適行動を確定していく動的計画法。</li>
              <li><b>停止境界</b>：それを超えたら降りるべき z の閾値。利確側・損切り側の2本。</li>
              <li><b>z（標準化含み損益）</b>：含み損益を日次σで割った値。「今、何σ動いたか」。</li>
            </ul>

            <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
            <p>
              ポーカーで「降りるか続けるか」を、手札（z）と残りラウンド（h）を見て決めるのに似ています。
              強い手（zが高い）なら普通は続けたいが、これ以上は伸びにくいと分かっているなら利確して降りる。
              後退帰納法は「最終ラウンドから逆算して、各局面での最善手」を全部埋めておく作業です。
            </p>

            <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>
                <b>OOS と IS のギャップに注目</b>：in-sample（学習と同じ週で評価）の最適方策は必ず良く見えます。
                学習と検定を分けたOOSこそが実力。ギャップが大きいほど「凝った手仕舞い」は罠です。
              </li>
              <li>
                <b>OOS が「金曜まで持つ」を超えるか</b>：超えなければ、状態依存の手仕舞いに実益はありません。
                多くの流動銘柄でこれは僅差、または逆転します。
              </li>
              <li>
                <b>方策ヒートマップ</b>：赤（降りる）が「zが高く伸びきった後半日」に集中し、大半が緑（継続）なら、
                「基本は金曜まで持ち、大きく含み益が乗った終盤だけ利確」という素直な結論です。
              </li>
            </ul>

            <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><b>利確ラインの目安</b>：停止境界の利確側 z を「何σ乗ったら利を伸ばさず降りるか」に使う。</li>
              <li><b>保有期間の設計</b>：OOS平均保有日数が、その銘柄で報われる保有の長さの目安。</li>
              <li>
                <b>過剰最適化の自己検診</b>：この分析のIS/OOSギャップは、あなたの他の手仕舞いルールが
                どれだけ楽観バイアスを含むかの物差しになります。
              </li>
            </ul>

            <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>
                <b>引け価格でしか手仕舞えない前提</b>です。日中のザラ場での利確・損切りは扱いません
                （日中の最適化は「保有期間別 最適TP/SL」を併用）。
              </li>
              <li>
                <b>標本の薄いzビンは信頼できない</b>ため、一定数未満のビンは自動的に「継続」に倒しています。
                極端なzの境界（±3.5σ付近）はほぼ観測されない領域の外挿です。
              </li>
              <li>
                <b>コスト控除前</b>。早降りは往復回数を増やすため、実務では手仕舞いのたびにコストが乗ります。
              </li>
              <li>
                方策は経験的遷移に基づくため、<b>レジームが変われば最適行動も変わります</b>。σ標準化で一定は
                吸収しますが、構造変化には追随しません。
              </li>
            </ul>
          </AnalysisGuide>
        </>
      ) : (
        <div className="mt-3 rounded p-2.5 text-xs bg-gray-50 border border-gray-200 text-gray-600">
          計算できません：{result.reason}
        </div>
      )}
    </div>
  );
}
