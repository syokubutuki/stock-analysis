"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  BUCKET_LABEL,
  BucketKey,
  computeWeekendPremium,
  WeekendPremiumResult,
} from "../../lib/weekend-premium";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const BUCKETS: BucketKey[] = ["intraday", "weeknight", "weekend"];
const BUCKET_COLOR: Record<BucketKey, string> = {
  intraday: "#6b7280",
  weeknight: "#2563eb",
  weekend: "#dc2626",
};

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
const bp = (v: number) => `${(v * 10000).toFixed(1)}bp`;

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

type BarMetric = "annualRet" | "sharpe" | "logContribShare";
const BAR_LABEL: Record<BarMetric, string> = {
  annualRet: "年率リターン寄与",
  sharpe: "年率シャープ",
  logContribShare: "総ドリフト寄与（対数分解）",
};
const barValue = (r: WeekendPremiumResult, k: BucketKey, m: BarMetric) => r.buckets[k][m];
const barFmt = (m: BarMetric, v: number) => (m === "sharpe" ? v.toFixed(2) : pct1(v));

function drawBars(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  r: WeekendPremiumResult,
  metric: BarMetric,
) {
  const ml = 8;
  const mr = 8;
  const mt = 26;
  const mb = 40;
  const plotW = width - ml - mr;
  const plotH = height - mt - mb;

  ctx.fillStyle = "#374151";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`区間別 ${BAR_LABEL[metric]}`, ml, 14);

  const vals = BUCKETS.map((k) => barValue(r, k, metric));
  const maxAbs = Math.max(1e-9, ...vals.map((v) => Math.abs(v)));
  const zeroY = mt + plotH / 2;
  const scale = (plotH / 2) / maxAbs;

  ctx.strokeStyle = "#d1d5db";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ml, zeroY);
  ctx.lineTo(ml + plotW, zeroY);
  ctx.stroke();

  const slot = plotW / BUCKETS.length;
  const bw = slot * 0.5;
  BUCKETS.forEach((k, i) => {
    const v = barValue(r, k, metric);
    const cx = ml + slot * (i + 0.5);
    const h = v * scale;
    ctx.fillStyle = BUCKET_COLOR[k];
    if (v >= 0) ctx.fillRect(cx - bw / 2, zeroY - h, bw, h);
    else ctx.fillRect(cx - bw / 2, zeroY, bw, -h);

    ctx.fillStyle = "#374151";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(barFmt(metric, v), cx, v >= 0 ? zeroY - h - 5 : zeroY - h + 13);

    ctx.fillStyle = "#6b7280";
    ctx.font = "9px sans-serif";
    const lbl = k === "intraday" ? "日中" : k === "weeknight" ? "平日夜間" : "週末ギャップ";
    ctx.fillText(lbl, cx, mt + plotH + 14);
    ctx.fillText(`n=${r.buckets[k].n}`, cx, mt + plotH + 26);
  });
}

export default function WeekendPremiumChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [metric, setMetric] = useState<BarMetric>("annualRet");

  const result = useMemo(() => computeWeekendPremium(prices), [prices]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result.ok) return;
    const init = initCanvas(canvas, 200);
    if (!init) return;
    drawBars(init.ctx, init.width, init.height, result, metric);
  }, [result, metric]);

  const v = result.verdict;
  // μ_w が有意に正か / 週末を飛ばすと有意にSharpeがマシになるかでUIの色を決める
  const weekendHasPremium = result.ok && v.muWeekendPOneSided < 0.05;
  const skipSignificant = result.ok && v.sharpeDiffCI[0] > 0; // CI下限>0 = 有意に飛ばす方が良い
  const holdSignificant = result.ok && v.sharpeDiffCI[1] < 0; // CI上限<0 = 有意に持つ方が良い

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-800">
          週末プレミアム μ_w：週末を「持つべきか／飛ばすべきか」
        </h3>
        <span className="text-[10px] text-gray-400">
          日次を 日中／平日夜間／週末ギャップ に分解し、週末ギャップの正体を測る
        </span>
      </div>

      {!result.ok && (
        <div className="mt-3 rounded p-2.5 text-xs bg-gray-50 border border-gray-200 text-gray-600">
          計算できません：{result.reason}
        </div>
      )}

      {result.ok && (
        <>
          {/* 判定バナー */}
          <div
            className={`mt-3 rounded p-2.5 text-xs border ${
              holdSignificant
                ? "bg-blue-50 border-blue-200 text-blue-900"
                : skipSignificant
                  ? "bg-amber-50 border-amber-200 text-amber-900"
                  : "bg-gray-50 border-gray-200 text-gray-700"
            }`}
          >
            <div className="font-semibold">
              {holdSignificant
                ? "週末は持つべき — 飛ばすとSharpeが有意に悪化"
                : skipSignificant
                  ? "週末は飛ばすべき — 飛ばすとSharpeが有意に改善"
                  : "週末を持つ／飛ばすは、統計的にほぼ引き分け"}
            </div>
            <div className="mt-1 leading-relaxed">
              週末ギャップの平均 μ_w = <b>{bp(v.muWeekend)}</b>（95%CI [{bp(v.muWeekendCI[0])},{" "}
              {bp(v.muWeekendCI[1])}]、片側 p = {v.muWeekendPOneSided.toFixed(3)}）。
              {weekendHasPremium
                ? " プラスのプレミアムが有意に乗っています。"
                : " ゼロと区別できず、リスクを取る見返りが確認できません。"}
              {" "}週末を飛ばすと年率リターンは <b>{pct1(v.annualDiff)}</b>、シャープは{" "}
              <b>
                {v.sharpeDiff >= 0 ? "+" : ""}
                {v.sharpeDiff.toFixed(3)}
              </b>{" "}
              変化します（差の95%CI [{v.sharpeDiffCI[0].toFixed(3)}, {v.sharpeDiffCI[1].toFixed(3)}]）。
              {!skipSignificant &&
                !holdSignificant &&
                " CIが0をまたぐため、週末は「リターンのないリスク」で、持っても飛ばしても大差ありません。"}
            </div>
          </div>

          {/* 平均分散の1本の不等式 */}
          <div className="mt-2 rounded border border-gray-200 p-2.5 text-xs text-gray-700">
            <div className="font-medium text-gray-600">平均分散の判定式（分散1単位あたりリターン）</div>
            <div className="mt-1 flex items-center gap-2 flex-wrap font-mono text-[11px]">
              <span>
                週末ギャップ μ_w/σ_w² ={" "}
                <b className={v.retPerVarWeekend >= v.retPerVarWeekday ? "text-blue-700" : "text-amber-700"}>
                  {v.retPerVarWeekend.toFixed(2)}
                </b>
              </span>
              <span className="text-gray-400">
                {v.retPerVarWeekend < v.retPerVarWeekday ? "＜" : "≥"}
              </span>
              <span>
                週内 μ_wd/σ_wd² = <b className="text-blue-700">{v.retPerVarWeekday.toFixed(2)}</b>
              </span>
              <span className="text-gray-400">→</span>
              <span className="font-sans">
                {v.skipImprovesSharpe
                  ? "週末は週内より"
                  : "週末は週内と同等以上に"}
                <b>{v.skipImprovesSharpe ? "薄い" : "濃い"}</b>
                {v.skipImprovesSharpe ? "（飛ばす方向）" : "（持つ方向）"}
              </span>
            </div>
            <p className="mt-1 text-[10px] text-gray-400">
              左辺 &lt; 右辺なら、週末ギャップを外して週内に資金を集中した方が理論上シャープが上がります。ただし上のCIが実際に有意かどうかを最終判断にしてください。
            </p>
          </div>

          {/* 棒グラフ */}
          <div className="mt-3 flex items-center gap-2 text-xs">
            <span className="text-gray-500">グラフ指標</span>
            <select
              className="border border-gray-200 rounded px-1 py-0.5"
              value={metric}
              onChange={(e) => setMetric(e.target.value as BarMetric)}
            >
              {(Object.keys(BAR_LABEL) as BarMetric[]).map((m) => (
                <option key={m} value={m}>
                  {BAR_LABEL[m]}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-2">
            <canvas ref={canvasRef} />
          </div>

          {/* バケット表 */}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 pr-2 font-medium">区間</th>
                  <th className="text-right py-1 px-2 font-medium">n</th>
                  <th className="text-right py-1 px-2 font-medium">平均μ</th>
                  <th className="text-right py-1 px-2 font-medium">σ</th>
                  <th className="text-right py-1 px-2 font-medium">t</th>
                  <th className="text-right py-1 px-2 font-medium">p(μ&gt;0)</th>
                  <th className="text-right py-1 px-2 font-medium">勝率</th>
                  <th className="text-right py-1 px-2 font-medium">年率</th>
                  <th className="text-right py-1 px-2 font-medium">Sharpe</th>
                  <th className="text-right py-1 px-2 font-medium">μ/σ²</th>
                  <th className="text-right py-1 pl-2 font-medium">ドリフト寄与</th>
                </tr>
              </thead>
              <tbody>
                {BUCKETS.map((k) => {
                  const b = result.buckets[k];
                  return (
                    <tr key={k} className="border-b border-gray-100">
                      <td className="py-1 pr-2">
                        <span
                          className="inline-block w-2 h-2 rounded-full mr-1 align-middle"
                          style={{ background: BUCKET_COLOR[k] }}
                        />
                        <span className="text-gray-700">{BUCKET_LABEL[k]}</span>
                      </td>
                      <td className="py-1 px-2 text-right text-gray-500">{b.n}</td>
                      <td className="py-1 px-2 text-right font-medium text-gray-900">{bp(b.meanRet)}</td>
                      <td className="py-1 px-2 text-right text-gray-500">{pct(b.sd)}</td>
                      <td className="py-1 px-2 text-right text-gray-600">{b.t.toFixed(2)}</td>
                      <td
                        className={`py-1 px-2 text-right font-medium ${
                          b.pOneSided < 0.05 ? "text-blue-700" : "text-gray-400"
                        }`}
                      >
                        {b.pOneSided.toFixed(3)}
                      </td>
                      <td className="py-1 px-2 text-right text-gray-600">{pct1(b.winRate)}</td>
                      <td className="py-1 px-2 text-right text-gray-700">{pct1(b.annualRet)}</td>
                      <td className="py-1 px-2 text-right text-gray-700">{b.sharpe.toFixed(2)}</td>
                      <td className="py-1 px-2 text-right text-gray-600">{b.retPerVar.toFixed(2)}</td>
                      <td className="py-1 pl-2 text-right text-gray-600">{pct1(b.logContribShare)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-[10px] text-gray-400 leading-relaxed">
              {result.nDays}本 / {result.nWeeks}週（{result.from}〜{result.to}）。μ・σは1回あたりの単純リターン、bp=0.01%。
              「ドリフト寄与」は3区間の対数リターン和（=バイ&ホールドの対数リターン）に占める各区間の割合で、合計100%。
              年率・Sharpe は各区間を毎回複利したときの年率換算。<b>μ/σ²</b> は分散1単位あたりリターンで、判定式の主役です。
            </p>
          </div>

          <AnalysisGuide title="週末プレミアム分析の詳細理論">
            <p className="font-medium text-gray-700">1. 何を測っているか</p>
            <p>
              「月曜Openで建てて金曜Closeで手仕舞う」週内トレードは、金曜Close→月曜Openの
              <b>週末ギャップを捨てて</b>います。この分析はその週末ギャップの正体を測ります。
              週末に<b>リスクプレミアム μ_w</b> が乗っているなら、飛ばすことは報酬を捨てる行為（機会損失）。
              逆に週末が「リターンに乏しくリスクだけ高い」区間なら、飛ばすことでシャープが改善します。
            </p>
            <p>
              日次リターンを3区間に分解します：<b>日中</b>（始値→終値）、<b>平日夜間</b>（週内の
              終値→翌始値）、<b>週末ギャップ</b>（週境界をまたぐ終値→翌始値。金→月、連休は長い週末として含む）。
            </p>

            <p className="font-medium text-gray-700 mt-3">2. 数式：平均分散の1本の不等式</p>
            <p>
              ある区間を「持ち増す」ことがポートフォリオのシャープを上げる限界条件は、その区間の
              <b>分散1単位あたりリターン μ/σ²</b>（Kelly比・接点条件）が既存部分のそれを上回ること。
              週内(wd＝日中+平日夜間)と週末ギャップ(w)を比べると：
            </p>
            <p className="pl-2">{"週末を飛ばすとSharpeが改善  ⟺  μ_w / σ_w²  <  μ_wd / σ_wd²"}</p>
            <p>
              左辺＜右辺なら週末ギャップは「薄い」ので飛ばすが正解、左辺≥右辺なら「濃い」ので持つが正解。
              <b>μ_w の符号だけでは決まりません</b>——μ_w が正でも、そのリスク σ_w が大きすぎれば
              飛ばした方がシャープは上がります。導出：独立を仮定すると週次シャープは
              {" "}{"(m_wd+μ_w)/√(v_wd+σ_w²)"} で、これを {"m_wd/√v_wd"} と比べて整理すると上の不等式になります。
            </p>

            <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>
                <b>週末プレミアム μ_w</b>：週末ギャップ（金Close→月Open）の平均リターン。週末という
                長い休場リスクを取る見返り。
              </li>
              <li>
                <b>μ/σ²（分散1単位あたりリターン）</b>：その区間の「うまみ」をリスクで割った密度。
                最適な建玉ウェイトはこれに比例する（Kelly）。
              </li>
              <li>
                <b>ドリフト寄与</b>：バイ&ホールドの総対数リターンを3区間の対数和に分解したときの各区間の割合。
                「どこで儲けが出ているか」を加法的に示す。
              </li>
              <li>
                <b>常時ロード／週末飛ばし</b>：前者は週末も持ちっぱなし（≒B&H）、後者は金Closeで降りて
                月Openで戻る戦略。両者の差はちょうど週末ギャップ。
              </li>
            </ul>

            <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
            <p>
              週末ギャップは「金曜夜から月曜朝まで、市場が閉じている間ずっとポジションを握りしめる」こと。
              その間に良いニュースも悪いニュースも溜まります。もしその賭けに<b>平均してプラスの見返り</b>
              があるなら握る価値がありますが、見返りがゼロで<b>当たり外れ（分散）だけが大きい</b>なら、
              それはカジノに寄って帰るようなもの——期待値ゼロのスリルにリスクを払うだけです。
            </p>

            <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>
                <b>平日夜間の行に注目</b>：多くの株価指数・個別株で、ドリフトの大半は
                <b>平日オーバーナイト</b>に集中します（オーバーナイト・ドリフト異常）。日中がほぼゼロ〜
                マイナスでも驚かないでください。
              </li>
              <li>
                <b>週末ギャップの μ と p(μ&gt;0)</b>：p ≥ 0.05 なら週末プレミアムはゼロと区別できません。
                その場合、週末は「リターンのないリスク」です。
              </li>
              <li>
                <b>判定は Sharpe差のCIで最終確認</b>：CI下限&gt;0 なら有意に飛ばすべき、上限&lt;0 なら
                有意に持つべき、0をまたぐなら引き分け（＝どちらでもよいが、飛ばせばタダでリスクを減らせる）。
              </li>
              <li>
                <b>μ/σ² の大小</b>で方向を、<b>CI</b>で有意性を読む、の二段構えです。
              </li>
            </ul>

            <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>
                <b>週内トレードの根拠づけ</b>：週末プレミアムが有意でないなら、週末を飛ばす戦略は
                「エッジ」ではなく「無駄なリスクの削減」として正当化できます（過度な期待は禁物）。
              </li>
              <li>
                <b>建玉タイミングの再設計</b>：ドリフトが平日夜間に集中しているなら、日中でエントリー・
                エグジットするより<b>終値で建てて翌始値で降りる</b>方が、同じ銘柄でも効率的な可能性があります。
              </li>
              <li>
                <b>コスト勘案</b>：週末を飛ばすには毎週2回の余分な往復コストがかかります。Sharpe改善が
                そのコストを上回らなければ、飛ばす意味はありません（この分析はコスト控除前）。
              </li>
            </ul>

            <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>
                <b>オーバーナイト・リターンは外れ値に極端に敏感</b>です。始値の1本の異常プリント
                （分割・配当調整の不整合など）で σ と μ/σ² が大きく歪みます。σ が異様に大きい行が
                あれば、その銘柄のデータ品質を疑ってください（本分析はアプリ共通の調整済み価格を
                そのまま使い、外れ値処理はしていません）。
              </li>
              <li>
                <b>始値の執行可能性</b>：この分析は「始値で約定できる」前提です。寄付きの
                流動性・スリッページ次第で、オーバーナイト・ドリフトは実際には取りにくいことがあります。
              </li>
              <li>
                <b>μ/σ² の判定式は独立性を仮定</b>しています。週内と週末に強い相関があると近似が崩れるため、
                最終判断は必ず Sharpe差のブートストラップCIで行ってください。
              </li>
              <li>
                <b>これは方向（μ）の分析であり、曜日効果の検定ではありません</b>。「週末に何が乗っているか」
                を測るもので、月〜金の曜日別エッジは「ヌル較正」や「曜日タイミング好機スキャン」を併用してください。
              </li>
            </ul>
          </AnalysisGuide>
        </>
      )}
    </div>
  );
}
