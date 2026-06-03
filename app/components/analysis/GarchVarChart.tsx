"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeGarchVar } from "../../lib/simulation";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; }

function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

export default function GarchVarChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const result = useMemo(() => computeGarchVar(prices), [prices]);

  useEffect(() => {
    if (!canvasRef.current || result.dates.length === 0) return;
    const H = 350;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width, height } = init;
    const ml = 50, mr = 20, mt = 30, mb = 30;
    const plotW = width - ml - mr, plotH = height - mt - mb;
    const n = result.returns.length;

    const allVals = [...result.returns, ...result.var95];
    const minV = Math.min(...allVals);
    const maxV = Math.max(...allVals);
    const rangeV = maxV - minV || 0.01;

    const xFrom = (i: number) => ml + (i / (n - 1)) * plotW;
    const yFrom = (v: number) => mt + plotH - ((v - minV) / rangeV) * plotH;

    // Returns as dots
    for (let i = 0; i < n; i++) {
      const x = xFrom(i), y = yFrom(result.returns[i]);
      const violated = result.returns[i] < result.var95[i];
      ctx.beginPath(); ctx.arc(x, y, violated ? 2.5 : 1, 0, Math.PI * 2);
      ctx.fillStyle = violated ? "#ef4444" : "rgba(148, 163, 184, 0.4)";
      ctx.fill();
    }

    // VaR95 line
    ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xFrom(i), y = yFrom(result.var95[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // VaR99 line
    ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xFrom(i), y = yFrom(result.var99[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.setLineDash([]);

    // Zero line
    const y0 = yFrom(0);
    ctx.strokeStyle = "#374151"; ctx.lineWidth = 0.5; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(ml, y0); ctx.lineTo(width - mr, y0); ctx.stroke();
    ctx.setLineDash([]);

    // Grid
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = mt + (plotH * i) / 5;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(width - mr, y); ctx.stroke();
      const val = maxV - (rangeV * i) / 5;
      ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText((val * 100).toFixed(1) + "%", ml - 4, y + 3);
    }

    // Legend
    ctx.font = "10px sans-serif"; ctx.textAlign = "left";
    const lx = ml + 10;
    ctx.fillStyle = "rgba(148, 163, 184, 0.4)";
    ctx.beginPath(); ctx.arc(lx + 3, mt + 8, 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#374151"; ctx.fillText("リターン", lx + 10, mt + 12);
    ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(lx + 70, mt + 8); ctx.lineTo(lx + 88, mt + 8); ctx.stroke();
    ctx.fillText("95%損失限界", lx + 92, mt + 12);
    ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(lx + 160, mt + 8); ctx.lineTo(lx + 178, mt + 8); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText("99%損失限界", lx + 182, mt + 12);
    ctx.fillStyle = "#ef4444";
    ctx.beginPath(); ctx.arc(lx + 253, mt + 8, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#374151"; ctx.fillText("限界超過", lx + 260, mt + 12);

    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 12px sans-serif";
    ctx.fillText("日次リターンと損失限界線 (VaR)", ml, mt - 10);
  }, [result]);

  if (result.dates.length === 0) return null;

  const n = result.returns.length;
  const violationRate95 = ((result.violations95 / n) * 100).toFixed(2);
  const violationRate99 = ((result.violations99 / n) * 100).toFixed(2);
  const pass95 = result.kupiecTest95.pass;
  const pass99 = result.kupiecTest99.pass;

  const bothPass = pass95 && pass99;
  const bothFail = !pass95 && !pass99;
  const summaryColor = bothPass ? "green" : bothFail ? "red" : "yellow";
  const summaryBg = summaryColor === "green" ? "bg-green-50 border-green-300" : summaryColor === "red" ? "bg-red-50 border-red-300" : "bg-yellow-50 border-yellow-300";
  const summaryIcon = summaryColor === "green" ? "text-green-600" : summaryColor === "red" ? "text-red-600" : "text-yellow-600";
  const summaryText = bothPass
    ? "このVaRモデルは過去のデータに対して適切に機能しています。損失限界線を超える回数が統計的に妥当な範囲内です。"
    : bothFail
      ? "VaRモデルが95%・99%の両水準で不適切です。実際の損失が限界線を超える頻度が想定と大きく乖離しており、リスクの見積もりを見直す必要があります。"
      : !pass95
        ? "95%水準のVaRモデルが不適切です。日常的なリスク見積もりが実態とずれている可能性があります。"
        : "99%水準のVaRモデルが不適切です。極端な損失（テールリスク）の見積もりが甘い可能性があります。";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div>
        <h3 className="font-bold text-gray-800">GARCH VaR予測 — リスク損失の限界線</h3>
        <p className="text-xs text-gray-500 mt-0.5">条件付き異分散モデルによるテールリスクの動的推定とバックテスト検証</p>
      </div>
      <div className="relative"><canvas ref={canvasRef} /></div>

      {/* 総合判定サマリー */}
      <div className={`p-3 rounded border ${summaryBg} flex items-start gap-2`}>
        <span className={`font-bold text-lg leading-none ${summaryIcon}`}>
          {summaryColor === "green" ? "OK" : summaryColor === "red" ? "NG" : "!"}
        </span>
        <div className="text-sm">
          <span className={`font-bold ${summaryIcon}`}>
            総合判定: {bothPass ? "合格" : bothFail ? "不合格" : "一部不合格"}
          </span>
          <p className="text-gray-600 mt-0.5">{summaryText}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="p-3 bg-amber-50 rounded border border-amber-200">
          <div className="font-medium text-amber-800 mb-1">95%損失限界のバックテスト</div>
          <div className="space-y-0.5">
            <div>違反率: <span className="font-mono font-bold">{violationRate95}%</span> <span className="text-gray-500">(期待: 5.00%)</span></div>
            <div>違反回数: <span className="font-mono">{result.violations95}回</span> / 期待 {result.expectedViolations95.toFixed(1)}回</div>
            <div className={pass95 ? "text-green-600 font-bold mt-1" : "text-red-600 font-bold mt-1"}>
              {pass95 ? "合格 — モデルは適切" : "不合格 — モデルは不適切"}
            </div>
            {!pass95 && (
              <div className="text-red-500 mt-0.5">
                {result.violations95 > result.expectedViolations95
                  ? "想定より損失超過が多く、リスクを過小評価しています"
                  : "想定より損失超過が少なく、リスクを過大評価（保守的すぎ）しています"}
              </div>
            )}
            <details className="mt-1">
              <summary className="text-gray-500 cursor-pointer">統計的詳細</summary>
              <div className="mt-1 text-gray-600">
                <div>Kupiec LR: <span className="font-mono">{result.kupiecTest95.statistic.toFixed(2)}</span></div>
                <div>p値: <span className="font-mono">{result.kupiecTest95.pValue.toFixed(3)}</span> <span className="text-gray-400">(0.05以上で合格)</span></div>
              </div>
            </details>
          </div>
        </div>
        <div className="p-3 bg-red-50 rounded border border-red-200">
          <div className="font-medium text-red-800 mb-1">99%損失限界のバックテスト</div>
          <div className="space-y-0.5">
            <div>違反率: <span className="font-mono font-bold">{violationRate99}%</span> <span className="text-gray-500">(期待: 1.00%)</span></div>
            <div>違反回数: <span className="font-mono">{result.violations99}回</span> / 期待 {result.expectedViolations99.toFixed(1)}回</div>
            <div className={pass99 ? "text-green-600 font-bold mt-1" : "text-red-600 font-bold mt-1"}>
              {pass99 ? "合格 — モデルは適切" : "不合格 — テールリスクを過小評価の可能性"}
            </div>
            {!pass99 && (
              <div className="text-red-500 mt-0.5">
                {result.violations99 > result.expectedViolations99
                  ? "極端な損失が想定以上に頻発しています。正規分布では捉えきれないファットテールの存在を示唆します"
                  : "極端な損失が想定より少なく、リスク資本を過大に確保している可能性があります"}
              </div>
            )}
            <details className="mt-1">
              <summary className="text-gray-500 cursor-pointer">統計的詳細</summary>
              <div className="mt-1 text-gray-600">
                <div>Kupiec LR: <span className="font-mono">{result.kupiecTest99.statistic.toFixed(2)}</span></div>
                <div>p値: <span className="font-mono">{result.kupiecTest99.pValue.toFixed(3)}</span> <span className="text-gray-400">(0.05以上で合格)</span></div>
              </div>
            </details>
          </div>
        </div>
      </div>

      <AnalysisGuide title="GARCH VaR予測の詳細解説">
        <p className="font-medium text-gray-700">1. VaRとは</p>
        <p>VaR（Value at Risk）は「明日、最悪どれくらい損するか？」を数値で示す指標です。例えば「95% VaR = -2%」とは、「100日のうち95日はこの水準より損しない（＝5日だけこれ以上の損失がありうる）」という意味です。</p>
        <p className="mt-1">天気予報の降水確率に例えると分かりやすいでしょう。「降水確率5%」と言われたら傘を持たない人が多いように、「95%の確率でこの損失額以内に収まる」と言われたらその範囲は許容できるという感覚です。VaRは「その許容ラインがどこにあるか」を教えてくれます。</p>

        <p className="font-medium text-gray-700 mt-3">2. GARCHモデルの仕組み</p>
        <p>株価のボラティリティ（値動きの激しさ）は一定ではなく、大きく動いた日の翌日はまた大きく動きやすい性質があります。GARCHモデルはこの「ボラティリティの連鎖」を捉えるモデルです。</p>
        <p className="mt-1">海の波に例えると、嵐の後の海はしばらく荒れ続け、徐々に凪いでいきます。GARCHモデルはこの「波の減衰」を数式で表現します。</p>
        <p className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">{"σ²_t = ω + α × r²_{t-1} + β × σ²_{t-1}"}</p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li><strong>σ²_t</strong>: 今日の予測ボラティリティ（波の大きさ）</li>
          <li><strong>ω</strong>: ベースとなる最低限のボラティリティ（凪の日でもゼロにはならない）</li>
          <li><strong>α × r²_t-1</strong>: 昨日の実際のショック（急な波）の影響。αが大きいほど急変に敏感</li>
          <li><strong>β × σ²_t-1</strong>: 昨日までのボラティリティの持続。βが大きいほど荒れが長引く</li>
          <li><strong>α + β &lt; 1</strong> であれば、ボラティリティはいずれ平常水準に戻る（定常条件）</li>
        </ul>
        <p className="mt-1">こうして求めた日々のボラティリティ σ_t に正規分布の分位点（95%なら -1.645、99%なら -2.326）を掛けてVaRを算出します。</p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>VaR（バリュー・アット・リスク）</strong>: 一定の確率で起こりうる最大損失額。リスク管理の基本指標</li>
          <li><strong>条件付きボラティリティ</strong>: 直近の市場状況を加味して推定した「今日のボラティリティ」。過去の固定値ではなく日々変動する</li>
          <li><strong>バックテスト</strong>: 過去のデータで予測モデルの精度を検証すること。「予測がどれだけ当たっていたか」を事後的に確認する</li>
          <li><strong>Kupiecテスト</strong>: VaRの「限界超過回数」が統計的に妥当かを検定する手法。超過が多すぎても少なすぎても不合格になる</li>
          <li><strong>限界超過（違反）</strong>: 実際のリターンがVaR線を下回った日。つまりVaRの予測を超える損失が発生した日</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. チャートの読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>灰色の小さな点</strong>: 各日の実際のリターン（日次騰落率）。0%より上はプラス、下はマイナス</li>
          <li><strong>黄色の実線（95%損失限界）</strong>: 「20日に1日くらいしかこの線を下回らないはず」の水準</li>
          <li><strong>赤い破線（99%損失限界）</strong>: 「100日に1日くらいしかこの線を下回らないはず」の水準。より極端な損失の限界</li>
          <li><strong>赤い大きな点（限界超過）</strong>: 実際に95%損失限界を突破した日。この点が多すぎるとモデルの信頼性に問題がある</li>
          <li>VaR線が下に広がっている時期はモデルが「ボラティリティが高い（＝リスクが大きい）」と判断している期間</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 結果の解釈</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>バックテスト合格</strong>: VaRの予測精度が統計的に妥当。モデルがリスクを適切に見積もれている</li>
          <li><strong>バックテスト不合格（超過が多い）</strong>: VaRがリスクを過小評価。実際は想定以上に損失が発生しやすい。株価にファットテール（極端な値動きが正規分布より頻繁に起きる性質）がある可能性</li>
          <li><strong>バックテスト不合格（超過が少ない）</strong>: VaRが保守的すぎる。必要以上にリスクを大きく見積もっており、投資機会を逃している可能性</li>
          <li><strong>赤い点が固まって出現</strong>: ボラティリティの急変にモデルが追いつけていない。構造変化やショック時に注意が必要</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ポジションサイジング</strong>: VaRが大きい（線が下に広い）時期は、許容損失額に合わせてポジションを縮小する判断材料になる</li>
          <li><strong>ストップロス設定</strong>: 99% VaR水準を参考にストップロスを設定すると、通常の変動では引っかからない程度の「安全マージン」を持てる</li>
          <li><strong>VaR線の拡大時</strong>: ボラティリティ上昇局面では新規エントリーを控え、既存ポジションのヘッジ強化を検討する</li>
          <li><strong>バックテスト不合格時</strong>: モデルの信頼度が低いため、VaRの数値を額面通り信じず、より保守的なリスク管理を行う</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>正規分布の仮定</strong>: 実際の株価リターンは正規分布より裾が厚い（ファットテール）ことが多く、VaRを超える損失が想定より頻繁に起きる場合がある</li>
          <li><strong>構造変化への弱さ</strong>: リーマンショックやコロナショックのような市場構造の急変には、過去のデータに基づくモデルでは対応が遅れる</li>
          <li><strong>VaR ≠ 最大損失</strong>: VaRはあくまで「この確率で収まる範囲」であり、VaRを超えた場合にどれだけ損するか（Expected Shortfall）は別の指標が必要</li>
          <li><strong>単一銘柄のみ</strong>: ポートフォリオ全体のリスクは、銘柄間の相関を考慮した別の計算が必要</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
