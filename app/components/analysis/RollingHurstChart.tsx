"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import { computeRollingHurst, RollingHurstResult } from "../../lib/rolling-hurst";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

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

// メインチャート: ローリングHurst + サロゲート帯
function drawRolling(canvas: HTMLCanvasElement, result: RollingHurstResult) {
  const r = initCanvas(canvas, 240); if (!r) return;
  const { ctx, width, height } = r;
  const pad = { top: 20, bottom: 28, left: 44, right: 15 };
  const pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom;
  const data = result.series;
  const n = data.length;
  if (n < 2) {
    ctx.fillStyle = "#999"; ctx.font = "12px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("データ不足 (窓を小さくしてください)", width / 2, height / 2);
    return;
  }

  let minV = Math.min(result.band.q025, ...data.map((d) => d.hurst));
  let maxV = Math.max(result.band.q975, ...data.map((d) => d.hurst));
  minV = Math.min(minV, 0.4); maxV = Math.max(maxV, 0.6);
  const range = maxV - minV || 1;
  minV -= range * 0.05; maxV += range * 0.05;
  const fullRange = maxV - minV;

  const toX = (i: number) => pad.left + (i / (n - 1)) * pw;
  const toY = (v: number) => pad.top + ph * (1 - (v - minV) / fullRange);

  // サロゲート帯 (q025〜q975 の網掛け)
  ctx.fillStyle = "rgba(148,163,184,0.30)";
  ctx.fillRect(pad.left, toY(result.band.q975), pw, toY(result.band.q025) - toY(result.band.q975));
  // 帯の境界線
  ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
  for (const v of [result.band.q025, result.band.q975]) {
    ctx.beginPath(); ctx.moveTo(pad.left, toY(v)); ctx.lineTo(width - pad.right, toY(v)); ctx.stroke();
  }
  ctx.setLineDash([]);
  // サロゲート中央値
  ctx.strokeStyle = "#64748b"; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(pad.left, toY(result.band.q50)); ctx.lineTo(width - pad.right, toY(result.band.q50)); ctx.stroke();
  ctx.setLineDash([]);

  // H=0.5 基準線
  if (0.5 >= minV && 0.5 <= maxV) {
    ctx.strokeStyle = "#cbd5e1"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, toY(0.5)); ctx.lineTo(width - pad.right, toY(0.5)); ctx.stroke();
  }

  // Y軸
  ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = minV + (fullRange * i) / 4;
    ctx.fillText(v.toFixed(2), pad.left - 5, toY(v) + 3);
  }

  // Hurstライン
  ctx.strokeStyle = "#0f766e"; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = toX(i), y = toY(data[i].hurst);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 帯の外に出た点を強調 (上=赤=持続性, 下=青=反持続性)
  for (let i = 0; i < n; i++) {
    const h = data[i].hurst;
    let col = "";
    if (h > result.band.q975) col = "#dc2626";
    else if (h < result.band.q025) col = "#2563eb";
    if (col) {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(toX(i), toY(h), 1.6, 0, Math.PI * 2); ctx.fill();
    }
  }

  // X軸ラベル
  ctx.fillStyle = "#666"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  const numLabels = Math.min(6, n);
  for (let i = 0; i < numLabels; i++) {
    const ti = Math.floor((i / (numLabels - 1)) * (n - 1));
    ctx.fillText(data[ti].time.slice(2), toX(ti), height - 8);
  }

  ctx.fillStyle = "#333"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`ローリングHurst指数 (窓=${result.window}日)`, pad.left + 5, pad.top - 6);
}

// サロゲート帰無分布のヒストグラム
function drawHistogram(canvas: HTMLCanvasElement, result: RollingHurstResult) {
  const r = initCanvas(canvas, 150); if (!r) return;
  const { ctx, width, height } = r;
  const pad = { top: 18, bottom: 24, left: 30, right: 12 };
  const pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom;
  const s = result.band.samples;
  if (s.length < 2) return;

  const minV = Math.min(...s, result.band.q025);
  const maxV = Math.max(...s, result.band.q975);
  const span = maxV - minV || 1;
  const nbins = 28;
  const bins = new Array(nbins).fill(0);
  for (const v of s) {
    const b = Math.min(nbins - 1, Math.floor(((v - minV) / span) * nbins));
    bins[b]++;
  }
  const maxC = Math.max(...bins, 1);
  const toX = (v: number) => pad.left + ((v - minV) / span) * pw;

  // バー
  ctx.fillStyle = "#cbd5e1";
  const bw = pw / nbins;
  for (let i = 0; i < nbins; i++) {
    const h = (bins[i] / maxC) * ph;
    ctx.fillRect(pad.left + i * bw, pad.top + ph - h, bw - 1, h);
  }

  // 帯境界 (q025, q975) を赤線で
  ctx.strokeStyle = "#dc2626"; ctx.lineWidth = 1.5; ctx.setLineDash([3, 2]);
  for (const v of [result.band.q025, result.band.q975]) {
    ctx.beginPath(); ctx.moveTo(toX(v), pad.top); ctx.lineTo(toX(v), pad.top + ph); ctx.stroke();
  }
  ctx.setLineDash([]);

  // X軸
  ctx.fillStyle = "#666"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  for (let i = 0; i <= 4; i++) {
    const v = minV + (span * i) / 4;
    ctx.fillText(v.toFixed(2), pad.left + (pw * i) / 4, height - 8);
  }
  ctx.fillStyle = "#333"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("サロゲート(ランダム化)Hurstの帰無分布", pad.left + 2, pad.top - 5);
}

const WINDOW_OPTIONS = [60, 90, 120, 180, 252, 378, 504];

export default function RollingHurstChart({ prices, seriesMode }: Props) {
  const mainRef = useRef<HTMLCanvasElement>(null);
  const histRef = useRef<HTMLCanvasElement>(null);
  const [window_, setWindow] = useState(120);
  const [reroll, setReroll] = useState(0);

  const { values, times } = extractSeries(prices, seriesMode);

  const result = useMemo(
    () => computeRollingHurst(values, times, window_, 300),
    // reroll を依存に含めてサロゲート再抽選
    [prices, seriesMode, window_, reroll]
  );

  useEffect(() => {
    if (mainRef.current) drawRolling(mainRef.current, result);
    if (histRef.current) drawHistogram(histRef.current, result);
  }, [result]);

  const maxWindow = Math.max(60, Math.floor(values.length / 3));

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">ローリングHurst指数 + サロゲート帯</h3>
        <button
          onClick={() => setReroll((x) => x + 1)}
          className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
        >
          サロゲート再抽選
        </button>
      </div>

      {/* 窓スライダー */}
      <div className="flex items-center gap-3 text-xs text-gray-600 flex-wrap">
        <span className="font-medium">窓幅: {window_}日</span>
        <input
          type="range"
          min={30}
          max={maxWindow}
          step={10}
          value={Math.min(window_, maxWindow)}
          onChange={(e) => setWindow(Number(e.target.value))}
          className="flex-1 min-w-[160px]"
        />
        <div className="flex gap-1">
          {WINDOW_OPTIONS.filter((w) => w <= maxWindow).map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`px-2 py-0.5 rounded border ${
                window_ === w ? "bg-teal-600 text-white border-teal-600" : "border-gray-300 text-gray-600 hover:bg-gray-50"
              }`}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={mainRef} /></div>

      {/* 統計サマリ */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="bg-gray-50 rounded p-2">
          <div className="text-gray-500">サロゲート帯</div>
          <div className="font-mono text-gray-800">{result.band.q025.toFixed(3)} 〜 {result.band.q975.toFixed(3)}</div>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <div className="text-gray-500">帯中央値</div>
          <div className="font-mono text-gray-800">{result.band.q50.toFixed(3)}</div>
        </div>
        <div className="bg-red-50 rounded p-2">
          <div className="text-gray-500">上抜け(持続性)</div>
          <div className="font-mono text-red-700">{(result.aboveRatio * 100).toFixed(1)}%</div>
        </div>
        <div className="bg-blue-50 rounded p-2">
          <div className="text-gray-500">下抜け(反持続性)</div>
          <div className="font-mono text-blue-700">{(result.belowRatio * 100).toFixed(1)}%</div>
        </div>
      </div>

      <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={histRef} /></div>

      <AnalysisGuide title="ローリングHurst + サロゲート帯の詳細理論">
        <p className="font-medium text-gray-700">1. 静的指標のローリング化とは</p>
        <p>
          Hurst指数(DFAで推定)は本来「全期間で1つの値」しか出さない静的指標です。それでは「<span className="font-medium">今</span>トレンド相場なのか、平均回帰相場なのか」が分かりません。そこで過去 W 日の窓を1日ずつスライドさせ、各時点でHurstを計算して<span className="font-medium">時系列に変換</span>します。これがローリング化です。窓幅スライダーで W を変えられます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. Hurst指数の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">H ≈ 0.5:</span> ランダムウォーク(効率的市場)。記憶なし。</li>
          <li><span className="font-medium">H &gt; 0.5:</span> 持続性(トレンド傾向)。上げが上げを呼ぶ。順張り有利。</li>
          <li><span className="font-medium">H &lt; 0.5:</span> 反持続性(平均回帰傾向)。上げの後は下げが来やすい。逆張り有利。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. サロゲート帯とは何か(本機能の主役)</p>
        <p>
          ここが今回の肝です。問題は「H=0.55 と出たとき、それは<span className="font-medium">本物のトレンド</span>なのか、<span className="font-medium">短い窓だから偶然そう見えるだけ</span>なのか」が区別できないことです。窓が短いほどHurstは推定誤差で0.5から大きくぶれます。
        </p>
        <p>
          そこで<span className="font-medium">サロゲートデータ</span>(代理データ)を作ります。実データのリターンを<span className="font-medium">ランダムにシャッフル</span>すると、値の集合(分布)はそのままで、<span className="font-medium">時間的な並び(=記憶)だけが壊れます</span>。つまり「記憶のない、ランダムウォークと同じだが分布は本物そっくりな系列」になります。これで窓Hurstを何百回も計算すると、「<span className="font-medium">もし記憶が無かったらHurstはどの範囲に散らばるか</span>」という帰無分布が得られます。その2.5%〜97.5%区間が<span className="font-medium">サロゲート帯</span>(灰色の網掛け)です。
        </p>
        <p>{"p値 ≈ (帯の外に出た度合い)。帯の外 = 95%の確率で偶然では説明できない = 統計的に有意。"}</p>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          コイン投げで「表が5回連続」出たら偏ったコインだと思いますか? 公平なコインでも時々起きます。サロゲート帯は「<span className="font-medium">公平なコインを何百回も投げ直して作った『よくある範囲』</span>」です。あなたの結果がその範囲を超えて初めて「このコインは本当に偏っている(=本物のトレンド/平均回帰)」と言えます。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">緑線が灰色帯の中:</span> 観測されたHurstはランダムと区別できない。トレンド/回帰の主張に根拠が薄い。</li>
          <li><span className="font-medium">赤点(帯の上抜け):</span> 偶然では説明できない<span className="font-medium">本物の持続性</span>。順張りが効きやすい局面。</li>
          <li><span className="font-medium">青点(帯の下抜け):</span> 本物の<span className="font-medium">反持続性</span>。逆張りが効きやすい局面。</li>
          <li><span className="font-medium">下のヒストグラム:</span> サロゲート帰無分布そのもの。赤破線が帯の境界(2.5/97.5%点)。窓を狭めると分布が横に広がる(=誤差が大きく、有意と言うハードルが上がる)のが体感できます。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">メタゲート:</span> 「Hurstが帯の外にある期間だけ」トレンド/逆張り戦略を有効化する。帯の中の期間は様子見。これは生のHurstを盲信するより遥かに頑健です。</li>
          <li><span className="font-medium">レジーム転換の検知:</span> 上抜け(赤)→帯内→下抜け(青)の遷移は、トレンド相場から平均回帰相場への構造変化を示唆。</li>
          <li><span className="font-medium">窓幅の使い分け:</span> 短い窓=機敏だがノイズ大(帯が広い)。長い窓=安定だが反応が遅い。複数窓で同時に有意なら信頼度が高い。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>サロゲート帯は窓位置に依らず一定(シャッフルで定常化するため)。本来は窓ごとの非定常性も検定しうるが、計算量とのトレードオフで簡易版を採用。</li>
          <li>シャッフルは線形・非線形の<span className="font-medium">全ての時間構造</span>を壊すため、検出対象は「あらゆる種類の記憶」。特定の構造(線形自己相関のみ等)を検定したい場合は位相ランダム化など別のサロゲートが要る。</li>
          <li>サロゲートは毎回乱数で生成するため、再抽選ボタンで僅かに帯が揺れる(分位点は概ね安定)。</li>
          <li>DFAは最低でも数十点の窓が必要。窓を小さくしすぎるとHurst自体が不安定になる。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
