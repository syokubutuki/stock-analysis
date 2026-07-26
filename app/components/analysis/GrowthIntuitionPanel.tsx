"use client";

// 数式ゼロで「掛け算の世界」を体に入れる ── docs/correlation-growth-drag-visualization.md Phase 3
//
// 構成は仕様書 §10.2 / §10.5 Phase 3 のとおり:
//
//   U2 ±10%ゲーム        クリックするたび資産が動く。平均は 0% のままなのに資産は減る。
//   U3 エルゴード性デモ    Peters のコイン投げ。100人が1回 vs 1人が100回。
//   T2 ±x% 往復表         振れ幅の二乗で減ることを表で確認する。
//
// このパネルだけは**実データを一切使わない**（仕様書 §10.2「データ不要・常時表示可」）。
// 相関も銘柄数も出てこない。ここで扱うのは「算術平均と幾何平均は別物」という 1 点だけで、
// pf-corr-drag（相関だけを動かす）／pf-growth-drag（実データの3項分解）の土台になる。
//
// 描画方式（仕様書 §10.3 / CLAUDE.md の規約）:
//   U2 の資産曲線     横軸は「クリック回数」で日付ではない → Canvas2D
//   U3 の左（100人）  横軸はリターン%（分布）→ Canvas2D
//   U3 の右（1人100回）横軸は投げた回数で日付ではなく、合成データなので期間の拡大に意味がない
//                      → Canvas2D（pf-corr-drag と同じ判断）
//
// 乱数は growth-drag.ts の mulberry32 を import して使う（同じ手続きを二重定義しない）。

import { useEffect, useMemo, useRef, useState } from "react";
import { mulberry32 } from "../../lib/growth-drag";
import AnalysisGuide from "./AnalysisGuide";

// ── 定数 ───────────────────────────────────────────────────────────────────
/** U2 の元本。100万円を仮の投下資金とする（仕様書 §U2）。 */
const CAPITAL = 1_000_000;
/** U3 Peters のコイン投げ: 表 +50% / 裏 −40%（期待値 +5%/回）。 */
const COIN_UP = 0.5;
const COIN_DOWN = -0.4;
/** U3 の人数と投げる回数。 */
const PEOPLE = 100;
const TOSSES = 100;
/** T2 の既定行（仕様書 §T2）。 */
const T2_SWINGS = [10, 20, 30, 50];

const manYen = (v: number) => `${(v / 10000).toFixed(1)}万円`;
const signPct = (v: number, d = 1) => `${v >= 0 ? "+" : "−"}${(Math.abs(v) * 100).toFixed(d)}%`;

// Canvas 初期化（CLAUDE.md のパターン / DPR スケール）
function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  if (width <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

/** 白フチつきテキスト（背景の線に重なっても読めるように）。 */
function outlined(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string
) {
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#fafafa";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// ────────────────────────────────────────────────────────────────────────────
// 二項分布の上側確率 P(H ≥ h)（フェアコイン）。
// 「100回投げて増えている人は何%か」を乱数ではなく厳密に出すために使う。
// pmf(0)=0.5^n から pmf(k+1)=pmf(k)·(n−k)/(k+1) で漸化。倍精度で桁は溢れない。
// ────────────────────────────────────────────────────────────────────────────
function binomUpperTail(n: number, h: number): number {
  if (h <= 0) return 1;
  if (h > n) return 0;
  let pmf = Math.pow(0.5, n);
  let acc = 0;
  for (let k = 0; k <= n; k++) {
    if (k >= h) acc += pmf;
    pmf = (pmf * (n - k)) / (k + 1);
  }
  return Math.min(1, Math.max(0, acc));
}

export default function GrowthIntuitionPanel() {
  // ══════════════════════════════════════════════════════════════════════════
  // U2 ±10%ゲーム
  // ══════════════════════════════════════════════════════════════════════════
  const [swingPct, setSwingPct] = useState(10); // 振れ幅スライダー（5%〜50%・仕様書 §U2）
  const [moves, setMoves] = useState<number[]>([]); // +1 = 上げ / −1 = 下げ
  const x = swingPct / 100;

  const game = useMemo(() => {
    const path = [CAPITAL];
    let v = CAPITAL;
    let sumR = 0;
    let ups = 0;
    for (const m of moves) {
      const r = m > 0 ? x : -x;
      sumR += r;
      if (m > 0) ups++;
      v *= 1 + r;
      path.push(v);
    }
    const n = moves.length;
    const arith = n > 0 ? sumR / n : 0; // 算術平均リターン（常時表示するのがこの体験の要）
    const geo = n > 0 ? Math.pow(v / CAPITAL, 1 / n) - 1 : 0; // 1回あたりの実質
    return { path, final: v, arith, geo, n, ups, downs: n - ups };
  }, [moves, x]);

  const push = (m: number) => setMoves((prev) => [...prev, m]);
  const pushAlternating = (count: number) =>
    setMoves((prev) => [...prev, ...Array.from({ length: count }, (_, i) => (i % 2 === 0 ? 1 : -1))]);

  const gameCanvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = gameCanvas.current;
    if (!canvas) return;
    const draw = () => drawGame(canvas, game.path, game.arith);
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [game]);

  // ══════════════════════════════════════════════════════════════════════════
  // U3 エルゴード性デモ（Peters のコイン投げ）
  // ══════════════════════════════════════════════════════════════════════════
  const [coinSeed, setCoinSeed] = useState(20260726);

  // 期待値（集団平均）と時間平均成長率は、乱数に依らない理論値として先に出しておく。
  const coinTheory = useMemo(() => {
    const ensemble = (COIN_UP + COIN_DOWN) / 2; // +5%/回
    const perToss = Math.sqrt((1 + COIN_UP) * (1 + COIN_DOWN)) - 1; // √(1.5×0.6)−1 = −5.13%/回
    // 100回投げて資産が増えるのは「表が h 回以上」のとき。h は log の閾値から決まる。
    const thresh = (TOSSES * Math.log(1 / (1 + COIN_DOWN))) / Math.log((1 + COIN_UP) / (1 + COIN_DOWN));
    const hNeeded = Math.floor(thresh) + 1;
    return { ensemble, perToss, hNeeded, pGain: binomUpperTail(TOSSES, hNeeded) };
  }, []);

  const coin = useMemo(() => {
    const rng = mulberry32(coinSeed);
    // 左パネル: 100人が1回ずつ
    const people: number[] = [];
    for (let i = 0; i < PEOPLE; i++) people.push(rng() < 0.5 ? COIN_UP : COIN_DOWN);
    const peopleMean = people.reduce((s, v) => s + v, 0) / PEOPLE;
    const peopleUp = people.filter((v) => v > 0).length;

    // 右パネル: 1人が100回
    const path = [1];
    let w = 1;
    let heads = 0;
    for (let t = 0; t < TOSSES; t++) {
      const up = rng() < 0.5;
      if (up) heads++;
      w *= 1 + (up ? COIN_UP : COIN_DOWN);
      path.push(w);
    }
    return { people, peopleMean, peopleUp, path, final: w, heads };
  }, [coinSeed]);

  const peopleCanvas = useRef<HTMLCanvasElement | null>(null);
  const pathCanvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c1 = peopleCanvas.current;
    const c2 = pathCanvas.current;
    const draw = () => {
      if (c1) drawPeople(c1, coin.people, coin.peopleMean);
      if (c2) drawSinglePath(c2, coin.path);
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [coin]);

  // ══════════════════════════════════════════════════════════════════════════
  // T2 ±x% 往復表
  // ══════════════════════════════════════════════════════════════════════════
  const t2Rows = useMemo(() => {
    const list = [...T2_SWINGS];
    if (!list.includes(swingPct)) list.push(swingPct);
    list.sort((a, b) => a - b);
    return list.map((p) => {
      const s = p / 100;
      const two = (1 + s) * (1 - s); // 2回後の倍率 = 1 − x²
      const ten = Math.pow(two, 5); // 10回（5往復）後
      return {
        swing: p,
        two,
        twoTotal: CAPITAL * two,
        ten,
        tenTotal: CAPITAL * ten,
        perStep: Math.sqrt(two) - 1, // 1回あたりの実質（幾何）
        approx: -(s * s) / 2, // 近似 −x²/2
        isCurrent: p === swingPct,
      };
    });
  }, [swingPct]);

  return (
    <div className="space-y-6">
      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* U2 ±10%ゲーム                                                      */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <div>
        <div className="text-sm font-semibold text-gray-800">
          ① ±{swingPct}% ゲーム：平均は 0% のまま。それでも資産は減る
        </div>
        <p className="mt-0.5 text-[11px] text-gray-500">
          ボタンを交互に押してください。上に出ている「あなたの平均リターン」は 0.0% を指し続けます。
          それでも資産は元本を割っていきます。<strong>これが算術平均と幾何平均の違いの全部です。</strong>
        </p>

        <div className="mt-2 rounded-lg border-2 border-blue-200 bg-blue-50 p-3">
          {/* 常時表示する「平均リターン」と資産 */}
          <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
            <div>
              <div className="text-[10px] text-gray-500">あなたの平均リターン（算術平均）</div>
              <div className="text-2xl font-bold tabular-nums text-blue-700">
                {game.n === 0 ? "0.0%" : signPct(game.arith)}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-gray-500">資産（元本 {manYen(CAPITAL)}）</div>
              <div
                className={`text-3xl font-bold tabular-nums ${
                  game.final >= CAPITAL ? "text-green-700" : "text-red-700"
                }`}
              >
                {manYen(game.final)}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-gray-500">元本との差</div>
              <div
                className={`text-xl font-bold tabular-nums ${
                  game.final >= CAPITAL ? "text-green-700" : "text-red-700"
                }`}
              >
                {game.final >= CAPITAL ? "+" : "−"}
                {manYen(Math.abs(game.final - CAPITAL))}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-gray-500">1回あたりの実質（幾何平均）</div>
              <div className="text-xl font-bold tabular-nums text-red-700">
                {game.n === 0 ? "—" : signPct(game.geo, 2)}
              </div>
            </div>
            <div className="text-[11px] text-gray-500 tabular-nums">
              {game.n} 回（上げ {game.ups} / 下げ {game.downs}）
            </div>
          </div>

          {/* 操作ボタン */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => push(1)}
              className="px-4 py-1.5 rounded-lg bg-green-600 text-white text-sm font-bold hover:bg-green-700"
            >
              +{swingPct}%
            </button>
            <button
              onClick={() => push(-1)}
              className="px-4 py-1.5 rounded-lg bg-red-600 text-white text-sm font-bold hover:bg-red-700"
            >
              −{swingPct}%
            </button>
            <button
              onClick={() => pushAlternating(10)}
              className="px-3 py-1.5 rounded-lg border border-blue-300 bg-white text-blue-700 text-xs hover:bg-blue-50"
            >
              交互に10回押す
            </button>
            <button
              onClick={() => setMoves([])}
              className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-600 text-xs hover:bg-gray-50"
            >
              リセット
            </button>
            <label className="flex items-center gap-2 text-xs text-gray-600 ml-auto">
              <span className="text-gray-500">振れ幅</span>
              <input
                type="range"
                min={5}
                max={50}
                step={1}
                value={swingPct}
                onChange={(e) => setSwingPct(Number(e.target.value))}
                className="w-32 accent-blue-600"
              />
              <span className="w-9 text-right tabular-nums font-semibold">{swingPct}%</span>
            </label>
          </div>
        </div>

        <div className="mt-2">
          <canvas ref={gameCanvas} className="w-full" />
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          灰色の破線＝「平均リターンどおりに複利で増えたつもりの線」。交互に押していると平均は 0% なので
          この線は元本の高さで水平のままです。<strong>青い実線（実際の資産）はその下へ沈み続けます。</strong>
          振れ幅を大きくすると沈み方が急に速くなります——減り方は振れ幅の
          <strong>二乗</strong>で効くからです（{`x²/2`}）。
        </p>
      </div>

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* U3 エルゴード性デモ                                                */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <div className="border-t border-gray-100 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-gray-800">
              ② 「みんなの平均」と「あなたの人生」は別物（エルゴード性）
            </div>
            <p className="mt-0.5 text-[11px] text-gray-500">
              コインを投げ、表なら資産が <strong className="text-green-700">+50%</strong>、裏なら{" "}
              <strong className="text-red-700">−40%</strong>。1回あたりの期待値は{" "}
              <strong>{signPct(coinTheory.ensemble)}</strong>{" "}
              ——どう見ても得なゲームです。ところが<strong>同じゲームを1人が続けると資産は減ります。</strong>
            </p>
          </div>
          <button
            onClick={() => setCoinSeed((s) => s + 1)}
            className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-700 text-xs hover:bg-gray-50 shrink-0"
          >
            🎲 もう一度投げる
          </button>
        </div>

        <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 左: 100人が1回ずつ */}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1">
              100人が<strong className="text-blue-700">1回ずつ</strong>投げた（集団平均）
            </div>
            <canvas ref={peopleCanvas} className="w-full" />
            <p className="mt-1 text-[11px] text-gray-500">
              この100人の平均は <strong className="text-blue-700">{signPct(coin.peopleMean)}</strong>
              （理論値 {signPct(coinTheory.ensemble)}）。
              表が出たのは {coin.peopleUp} 人 / {PEOPLE} 人。
              <strong>集団で見れば確かに増えています。</strong>これが「期待リターン」です。
            </p>
          </div>

          {/* 右: 1人が100回 */}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1">
              1人が<strong className="text-red-700">100回</strong>投げた（時間平均）
            </div>
            <canvas ref={pathCanvas} className="w-full" />
            <p className="mt-1 text-[11px] text-gray-500">
              この人の最終資産は元本の{" "}
              <strong className={coin.final >= 1 ? "text-green-700" : "text-red-700"}>
                {coin.final >= 0.01 ? `${coin.final.toFixed(3)} 倍` : `${coin.final.toExponential(2)} 倍`}
              </strong>
              （表 {coin.heads} 回 / {TOSSES} 回）。1回あたりの実質は理論上{" "}
              <strong className="text-red-700">{signPct(coinTheory.perToss, 2)}</strong>（
              {`√(1.5×0.6)−1`}）。
              <strong>
                {" "}「もう一度」を押しても、ほぼ必ず下がります
              </strong>
              ——100回投げて増えている人は{" "}
              <strong>{(coinTheory.pGain * 100).toFixed(1)}%</strong>{" "}
              だけ（表が {coinTheory.hNeeded} 回以上必要・二項分布の厳密値）。
            </p>
          </div>
        </div>

        <div className="mt-2 rounded-lg bg-gray-50 border border-gray-200 p-3 text-xs text-gray-700">
          期待リターンは<strong>左の世界</strong>の言葉（大勢の平均）。
          あなたの資産が実際に増える速さは<strong>右の世界</strong>の言葉（1人の時間平均）。
          この2つが一致しないことを<strong>非エルゴード性</strong>と呼びます。
          株式投資は右の世界で起きます。だから
          <strong>「期待リターンが正」は「資産が増える」を意味しません。</strong>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* T2 ±x% 往復表                                                      */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <div className="border-t border-gray-100 pt-4">
        <div className="text-sm font-semibold text-gray-800">
          ③ ±x% を往復するだけで、いくら減るか
        </div>
        <p className="mt-0.5 text-[11px] text-gray-500">
          上がって、同じ率だけ下がる。算術平均は全部ゼロです。それでも資産は必ず減り、
          <strong>減り方は振れ幅の二乗で効きます</strong>。元本 {manYen(CAPITAL)}。
        </p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-300 text-gray-500">
                <th className="text-left py-1 px-2 font-medium">値動き</th>
                <th className="text-right py-1 px-2 font-medium">算術平均</th>
                <th className="text-right py-1 px-2 font-medium">2回後の資産</th>
                <th className="text-right py-1 px-2 font-medium">実質</th>
                <th className="text-right py-1 px-2 font-medium">10回（5往復）後</th>
                <th className="text-right py-1 px-2 font-medium">実質</th>
                <th className="text-right py-1 px-2 font-medium">1回あたり</th>
                <th className="text-right py-1 px-2 font-medium">近似 −x²/2</th>
              </tr>
            </thead>
            <tbody>
              {t2Rows.map((r) => (
                <tr
                  key={r.swing}
                  className={`border-b border-gray-100 ${
                    r.isCurrent ? "bg-blue-50 font-semibold" : ""
                  }`}
                >
                  <td className="py-1.5 px-2 whitespace-nowrap">
                    <span className="text-green-700">+{r.swing}%</span>
                    <span className="text-gray-400"> / </span>
                    <span className="text-red-700">−{r.swing}%</span>
                    {r.isCurrent && (
                      <span className="ml-1.5 text-[10px] text-blue-600 font-normal">← 上のゲーム</span>
                    )}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-gray-500">0%</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{manYen(r.twoTotal)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-red-700">
                    {signPct(r.two - 1)}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{manYen(r.tenTotal)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-red-700">
                    {signPct(r.ten - 1)}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-gray-600">
                    {signPct(r.perStep, 2)}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-gray-400">
                    {signPct(r.approx, 2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-[11px] text-gray-500">
          2回後の倍率はちょうど {`(1+x)(1−x) = 1 − x²`}。振れ幅が 3 倍になると目減りは
          <strong>9 倍</strong>になります。右端の列は近似 {`−x²/2`}（1回あたり）で、
          「1回あたりの実質」とほぼ一致します。この {`x²/2`} が
          <strong>ボラティリティ税（σ²/2）の正体</strong>です。σ=30% なら年 4.5% が
          値動きの荒さだけで消えます。
        </p>
      </div>

      {/* ══════════════════════════════════════════════════════════════════ */}
      <AnalysisGuide title="算術平均と幾何平均・ボラティリティ税・エルゴード性の詳細理論">
        <p className="font-medium text-gray-700">1. 手法の概要</p>
        <p>
          このパネルは<strong>実データを使いません</strong>。扱うのは
          「<strong>平均という言葉が2種類ある</strong>」という 1 点だけです。
        </p>
        <p>
          「期待リターン」は<strong>足し算の世界</strong>の言葉です。100人が1回ずつ賭けたときの、
          100人の平均。でもあなたの資産は<strong>掛け算</strong>で増えます。
          今年の結果に来年の結果を<strong>掛ける</strong>。掛け算の世界では、上下に揺れること自体が
          資産を削ります。+10% と −10% を繰り返すと、平均は 0% なのに資産は減っていく。
          この「揺れの分の目減り」を<strong>ボラティリティ税</strong>（ボラティリティ・ドラッグ）と呼びます。
        </p>
        <p>
          ①のゲームは、その目減りを<strong>クリックで体験</strong>します。
          ②のコイン投げは、期待値がはっきり正（+5%/回）のゲームでも
          <strong>1人が続けると必ず負ける</strong>ことを見せます。
          ③の表は、目減りが振れ幅の<strong>二乗</strong>で効くことを数字で確認します。
          この3つが、この先のパネル（相関だけを動かす／相関が食べた分／効率的フロンティア）で使う
          {" g = μ − σ²/2 "} という式の中身です。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          対数リターン {" r_t = log(P_t / P_{t−1}) "}、資産の成長は {" W_T = W_0 · exp(Σ r_t) "}。
          算術平均（期待リターン）を {" μ_a = E[単純リターン] "}、
          幾何平均（実質成長率）を {" g = E[log(1+単純リターン)] "} とします。
          {" log(1+x) ≈ x − x²/2 "} を期待値に取り {" E[x²] ≈ σ² "} とすると
        </p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">g ≈ μ_a − σ²/2</p>
        <p>
          （対数正規分布なら近似ではなく<strong>厳密</strong>）。この {" σ²/2 "} が
          ボラティリティ・ドラッグです。
        </p>
        <p>
          <strong>③の往復表の厳密な計算</strong>: +x% と −x% を1回ずつなら
        </p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">
          (1+x)(1−x) = 1 − x²  ／ 1回あたりの幾何平均 = √(1−x²) − 1 ≈ −x²/2
        </p>
        <p>
          最後の近似は {" √(1−u) ≈ 1 − u/2 "} から。算術平均は {" (x + (−x))/2 = 0 "} なので、
          差の {" x²/2 "} がそのままドラッグです。x=10% なら 0.5%/回、x=30% なら 4.5%/回。
          <strong>x が 3 倍で目減りは 9 倍</strong>。
        </p>
        <p>
          <strong>②のコイン投げ（Peters 2011）</strong>: 表で {" ×1.5 "}、裏で {" ×0.6 "}。
        </p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">
          集団平均（1回）  = (1.5 + 0.6)/2 − 1 = +5.0%{"\n"}
          時間平均（1回）  = √(1.5 × 0.6) − 1 = √0.9 − 1 = −5.13%
        </p>
        <p>
          n 回後の資産は {" 1.5^H · 0.6^(n−H) "}（H は表の回数、{" H ~ Binomial(n, 1/2) "}）。
          資産が増える条件 {" H·log1.5 + (n−H)·log0.6 > 0 "} を H について解くと
        </p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">
          H &gt; n · log(1/0.6) / log(1.5/0.6) = n × 0.5575
        </p>
        <p>
          n=100 なら H ≥ {coinTheory.hNeeded}。その確率は二項分布の上側確率で
          <strong>{(coinTheory.pGain * 100).toFixed(1)}%</strong>。
          パネルの数字は乱数ではなくこの厳密計算です
          （{" P(H≥h) = Σ_{k≥h} C(n,k)·2^{−n} "}）。
          期待値が正なのに大半が負けるのは、勝つ少数の勝ち幅が指数的に大きく、
          <strong>平均だけをその少数が押し上げている</strong>からです。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>算術平均（期待リターン）</strong>: 各回のリターンを単純に足して回数で割ったもの。
            「大勢の人の平均」に相当し、あなた1人の資産の伸びとは一致しない。
          </li>
          <li>
            <strong>幾何平均（実質成長率 g）</strong>: 資産が実際に増えていく速さ。掛け算の平均
            （n回後の倍率の n乗根）。長期投資で意味を持つのはこちらだけ。
          </li>
          <li>
            <strong>ボラティリティ・ドラッグ（ボラティリティ税）</strong>: 算術平均と幾何平均の差
            {" σ²/2 "}。値動きが荒いだけで自動的に取られる目減り分。
            <strong>誰かに払っているのではなく、掛け算の構造そのものから出てくる</strong>。
          </li>
          <li>
            <strong>エルゴード性</strong>: 「大勢を1回」の平均と「1人を長く」の平均が一致する性質。
            一致するなら<em>エルゴード的</em>。資産の増減は掛け算なので<strong>非エルゴード的</strong>で、
            2つの平均はずれる。②の左右のパネルがそのずれそのもの。
          </li>
          <li>
            <strong>時間平均 / 集団平均</strong>: 前者が1人の長期（＝あなたの人生）、
            後者が多数の1回（＝期待値）。投資判断で使うべきは前者。
          </li>
          <li>
            <strong>倍化年数</strong>: {" ln2/g "}。成長率を「2倍になるまで何年か」に翻訳したもの。
            g≤0 なら永遠に来ない。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>階段</strong>: 1段上がって1段下がれば元に戻る。でも「10% 上がって 10% 下がる」は
            元に戻らない（99%）。<strong>掛け算の世界では上りと下りが非対称</strong>。
            下りの 10% は、大きくなった資産に掛かるから。
          </li>
          <li>
            <strong>山道の平均時速</strong>: 行き 60km/h・帰り 20km/h の「平均」は 40km/h ではなく
            30km/h（調和平均）。<strong>平均という言葉が2種類ある</strong>ことの日常例。
          </li>
          <li>
            <strong>穴の空いたバケツ</strong>: 期待リターン＝蛇口の水量、ボラ＝バケツの穴。
            水量を増やしても、穴が<strong>もっと速く</strong>大きくなれば水位は下がる（穴は二乗で効く）。
          </li>
          <li>
            <strong>宝くじの期待値</strong>: 「1枚あたりの期待値」は全員の平均。
            あなたが毎年買い続けたときの資産の推移とは別物。②の右パネルはこれと同じ構造。
          </li>
          <li>
            <strong>ロシアンルーレット</strong>: 賞金を上げれば期待値はいくらでも正にできる。
            それでも続ければ必ず終わる。<strong>期待値が正でも時間平均が負なら、続けてはいけない</strong>。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            ①で「交互に押す」と、上の<strong>平均リターンは 0.0% で固定</strong>されたまま、
            資産だけが減ります。この 2 つの数字が同時に見えていることが要点です。
          </li>
          <li>
            ①の灰色破線は「平均リターンで複利したつもりの線」。
            <strong>実線と破線の開きが、あなたが払ったボラティリティ税</strong>です。
          </li>
          <li>
            振れ幅スライダーを 10% → 30% にすると、10回後の目減りが約 9 倍になります
            （③の表の「10回後」列で確認できます）。
          </li>
          <li>
            ②の左（集団）は増え、右（1人）は減る。<strong>同じゲームです</strong>。
            違うのは「平均の取り方」だけ。
          </li>
          <li>
            ②の右で <strong>「もう一度」を何度押しても結論が変わらない</strong>ことを確認してください。
            下がるのは運が悪かったからではなく、構造だからです（増える人は {(coinTheory.pGain * 100).toFixed(1)}% だけ）。
          </li>
          <li>
            ③の「1回あたり」と「近似 −x²/2」がほぼ一致することが、
            {" g ≈ μ − σ²/2 "} という式が現実に効いている証拠です。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>「期待リターン」で銘柄を選ぶのをやめる</strong>。比べるべきは
            {" μ − σ²/2 "}。期待リターンが 1% 高くてもボラが 30% → 40% になれば
            {" (0.16−0.09)/2 = 3.5% "} 失うので差し引きで負けます。
          </li>
          <li>
            <strong>ボラを下げる工夫は、リターンを上げる工夫と同じ価値がある</strong>。
            σ を 40% → 30% に下げるのは、期待リターンを +3.5% 上げるのと等価です。
            銘柄探しより先に、値動きの荒さを下げる（分散・建玉を落とす）方が確実。
          </li>
          <li>
            <strong>レバレッジは税を二乗で増やす</strong>。建玉を2倍にすると期待は2倍だが
            ドラッグは4倍。この非対称が次のパネル（三本の崖）の主題です。
          </li>
          <li>
            <strong>大きく下げた後の「同じ率の戻り」では戻らない</strong>。
            −50% の後は +100% が必要（③の表の逆算）。撤退ラインを決める根拠になります。
          </li>
          <li>
            成長率は %ではなく<strong>倍化年数</strong>で持つ。g=7% なら 9.9年、g=5% なら 13.9年。
            「2% の差」は「4年の差」です。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>ここは合成データ・思考実験です</strong>。振れ幅もコインの倍率もあなたが選んだ前提で、
            実測値ではありません。実データでの分解は
            「相関が食べた分：期待リターンと『実際に増える速さ』のズレ」パネルを見てください。
          </li>
          <li>
            <strong>{" g ≈ μ − σ²/2 "} は2次近似</strong>です。
            テールが厚い（尖度が高い）分布ではドラッグを<strong>過小評価</strong>します。
            ②のコインのように大きく飛ぶ分布では、近似ではなく厳密計算
            （{" E[log(1+r)] "}）を使うべきです。
          </li>
          <li>
            <strong>「ボラを下げれば必ず得」ではありません</strong>。
            リターンを犠牲にしてボラを下げれば g は下がります。効くのは
            <strong>μ を保ったままボラを下げる</strong>操作（＝相関の低い分散）だけです。
          </li>
          <li>
            ①のゲームは<strong>上げと下げが同じ確率・同じ率</strong>という単純化です。
            現実のリターン分布は非対称で、上下の率も一定ではありません。
          </li>
          <li>
            ②の「1人が100回」は<strong>たった1つの標本</strong>です。1本の軌跡が下がったこと自体は
            何も証明しません。証明しているのは、その隣に書いてある
            <strong>厳密な確率（{(coinTheory.pGain * 100).toFixed(1)}%）</strong>のほうです。
          </li>
          <li>
            <strong>非エルゴード性は「賭けるな」という主張ではありません</strong>。
            賭けの<strong>大きさ</strong>（建玉）を、時間平均が正になる範囲に収めよという主張です。
            Peters のコインも、資産の一部だけを賭ければ時間平均は正にできます
            （これがケリー基準で、次のパネルの主題です）。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// U2 資産曲線（Canvas2D）
// 横軸は「クリック回数」で日付ではないため、CLAUDE.md の規約どおり Canvas2D。
// ────────────────────────────────────────────────────────────────────────────
function drawGame(canvas: HTMLCanvasElement, path: number[], arith: number) {
  const H = 190;
  const fit = initCanvas(canvas, H);
  if (!fit) return;
  const { ctx, width, height } = fit;

  const padL = 58;
  const padR = 14;
  const padT = 14;
  const padB = 32; // 目盛りラベルと軸キャプションが重ならない高さを確保
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  if (plotW < 60 || plotH < 40) return;

  const n = path.length - 1;
  // 横軸は最低10ステップ分の幅を確保（1回押しただけで極端に拡大しないように）
  const steps = Math.max(n, 10);
  // 「平均リターンで複利したつもりの線」＝ CAPITAL·(1+arith)^k
  const expected = Array.from({ length: n + 1 }, (_, k) => CAPITAL * Math.pow(1 + arith, k));

  let lo = CAPITAL;
  let hi = CAPITAL;
  for (const v of [...path, ...expected]) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || CAPITAL * 0.1;
  lo -= span * 0.12;
  hi += span * 0.12;
  const range = hi - lo || 1;

  const xOf = (k: number) => padL + (k / steps) * plotW;
  const yOf = (v: number) => padT + ((hi - v) / range) * plotH;

  // 元本より下を薄赤に
  const yCap = yOf(CAPITAL);
  if (yCap > padT && yCap < padT + plotH) {
    ctx.fillStyle = "#fef2f2";
    ctx.fillRect(padL, yCap, plotW, padT + plotH - yCap);
  }

  // グリッドと縦軸ラベル（万円）
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  const stepY = niceStep(range / 4);
  for (let v = Math.ceil(lo / stepY) * stepY; v <= hi; v += stepY) {
    const y = yOf(v);
    ctx.strokeStyle = "#eceff1";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillStyle = "#9ca3af";
    ctx.fillText(`${(v / 10000).toFixed(0)}万`, padL - 6, y + 3);
  }

  // 元本ライン
  ctx.strokeStyle = "#9ca3af";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, yCap);
  ctx.lineTo(padL + plotW, yCap);
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padT, plotW, plotH);
  ctx.clip();

  // 平均リターンで複利したつもりの線（灰破線）
  ctx.strokeStyle = "#94a3b8";
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  expected.forEach((v, k) => {
    const px = xOf(k);
    const py = yOf(v);
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.setLineDash([]);

  // 実際の資産（青の実線 + 節点）
  ctx.strokeStyle = "#1d4ed8";
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  path.forEach((v, k) => {
    const px = xOf(k);
    const py = yOf(v);
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  if (n <= 40) {
    ctx.fillStyle = "#1d4ed8";
    path.forEach((v, k) => {
      ctx.beginPath();
      ctx.arc(xOf(k), yOf(v), 2.4, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // 終端の値
  if (n > 0) {
    const ex = xOf(n);
    const ey = yOf(path[n]);
    ctx.beginPath();
    ctx.arc(ex, ey, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = "#1d4ed8";
    ctx.stroke();
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = ex > padL + plotW * 0.7 ? "right" : "left";
    const dx = ex > padL + plotW * 0.7 ? -10 : 10;
    outlined(ctx, `${(path[n] / 10000).toFixed(1)}万円`, ex + dx, ey + 4, "#1d4ed8");
  }
  ctx.restore();

  // 軸ラベル
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "#9ca3af";
  const tick = steps <= 12 ? 2 : Math.ceil(steps / 8);
  for (let k = 0; k <= steps; k += tick) ctx.fillText(`${k}`, xOf(k), padT + plotH + 14);
  ctx.textAlign = "left";
  ctx.fillText("押した回数 →", padL, height - 4);
  if (n === 0) {
    ctx.textAlign = "center";
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "#9ca3af";
    ctx.fillText(
      "ボタンを押すと、ここに資産の推移が出ます",
      padL + plotW / 2,
      padT + plotH / 2
    );
  }
}

// 目盛りの刻み幅を切りのいい値へ。2.5 を刻みに入れておかないと 2〜5 の間が 5 に丸められ、
// 目盛りが 1 本しか出ない範囲（例: 幅 21万 → 50万刻み）が生じる。
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / exp;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return m * exp;
}

// ────────────────────────────────────────────────────────────────────────────
// U3 左: 100人が1回ずつ（Canvas2D・横軸はリターン% ＝ 分布なので規約どおり）
// 1回のコイン投げは2値なので、ヒストグラムの階級は 2 本。1人＝1個の丸で積む
// （度数を「人」として数えられるほうが、初心者には棒より伝わる）。
// ────────────────────────────────────────────────────────────────────────────
function drawPeople(canvas: HTMLCanvasElement, people: number[], mean: number) {
  const H = 230;
  const fit = initCanvas(canvas, H);
  if (!fit) return;
  const { ctx, width, height } = fit;

  const padL = 14;
  const padR = 14;
  const padT = 18;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  if (plotW < 80 || plotH < 60) return;

  const rLo = -0.6;
  const rHi = 0.7;
  const xOf = (r: number) => padL + ((r - rLo) / (rHi - rLo)) * plotW;

  const nUp = people.filter((v) => v > 0).length;
  const nDown = people.length - nUp;
  const maxCount = Math.max(nUp, nDown, 1);

  // 積む丸の大きさ（多いほうが枠に収まるように）
  const dotR = Math.max(2.2, Math.min(5, (plotH * 0.9) / (2 * maxCount)));
  const cols = 5; // 1段に5人ずつ並べて高さを抑える
  const rows = Math.ceil(maxCount / cols);
  const rowH = Math.min(2 * dotR + 1.5, (plotH * 0.92) / Math.max(rows, 1));

  const baseY = padT + plotH;

  // 0% の縦線
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(xOf(0), padT);
  ctx.lineTo(xOf(0), baseY);
  ctx.stroke();

  const drawColumn = (r: number, count: number, color: string) => {
    const cx = xOf(r);
    const spread = Math.min(cols * (2 * dotR + 1.5), plotW * 0.28);
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const px = cx - spread / 2 + (spread / cols) * (col + 0.5);
      const py = baseY - 4 - row * rowH - dotR;
      ctx.beginPath();
      ctx.arc(px, py, dotR, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    // 階級のラベル（率と人数）
    ctx.textAlign = "center";
    ctx.font = "bold 11px sans-serif";
    const topY = baseY - 8 - Math.ceil(count / cols) * rowH;
    outlined(ctx, `${count}人`, cx, Math.max(topY, padT + 10), color);
  };

  drawColumn(COIN_DOWN, nDown, "#dc2626");
  drawColumn(COIN_UP, nUp, "#16a34a");

  // 平均の縦線（＝期待リターン）
  const mx = xOf(mean);
  ctx.strokeStyle = "#1d4ed8";
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mx, padT);
  ctx.lineTo(mx, baseY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = mean > 0.05 ? "right" : "left";
  outlined(
    ctx,
    `平均 ${mean >= 0 ? "+" : "−"}${(Math.abs(mean) * 100).toFixed(1)}%`,
    mx + (mean > 0.05 ? -5 : 5),
    padT + 10,
    "#1d4ed8"
  );

  // 横軸
  ctx.strokeStyle = "#9ca3af";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, baseY);
  ctx.lineTo(padL + plotW, baseY);
  ctx.stroke();
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "#9ca3af";
  for (const r of [-0.4, -0.2, 0, 0.2, 0.5]) {
    ctx.fillText(`${r > 0 ? "+" : ""}${(r * 100).toFixed(0)}%`, xOf(r), baseY + 14);
  }
  ctx.fillText("1回投げた結果（1つの丸＝1人）", padL + plotW / 2, height - 6);
}

// ────────────────────────────────────────────────────────────────────────────
// U3 右: 1人が100回（Canvas2D・対数目盛り）
// 横軸は「投げた回数」で日付ではなく、合成データなので期間の拡大に意味がない。
// pf-corr-drag と同じ判断で Canvas2D（仕様書 §10.3）。
// 資産は指数的に動くので縦軸は対数にする（線形だと 0 に張り付いて何も見えない）。
// ────────────────────────────────────────────────────────────────────────────
function drawSinglePath(canvas: HTMLCanvasElement, path: number[]) {
  const H = 230;
  const fit = initCanvas(canvas, H);
  if (!fit) return;
  const { ctx, width, height } = fit;

  const padL = 44;
  const padR = 14;
  const padT = 16;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  if (plotW < 80 || plotH < 60) return;

  const n = path.length - 1;
  // 理論の2本: 集団平均どおり（1.05^k）と時間平均どおり（√0.9^k）
  const gEnsemble = Math.log(1 + (COIN_UP + COIN_DOWN) / 2);
  const gTime = Math.log(Math.sqrt((1 + COIN_UP) * (1 + COIN_DOWN)));

  const logs = path.map((v) => Math.log(Math.max(v, 1e-300)));
  let lo = 0;
  let hi = 0;
  for (const v of [...logs, gEnsemble * n, gTime * n]) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  lo -= span * 0.08;
  hi += span * 0.08;
  const range = hi - lo;

  const xOf = (k: number) => padL + (k / n) * plotW;
  const yOf = (lv: number) => padT + ((hi - lv) / range) * plotH;

  // 元本より下を薄赤に
  const y1 = yOf(0);
  if (y1 > padT && y1 < padT + plotH) {
    ctx.fillStyle = "#fef2f2";
    ctx.fillRect(padL, y1, plotW, padT + plotH - y1);
  }

  // 対数グリッド（10のべき）
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  const decLo = Math.ceil(lo / Math.LN10);
  const decHi = Math.floor(hi / Math.LN10);
  const decStep = Math.max(1, Math.ceil((decHi - decLo + 1) / 6));
  for (let d = decLo; d <= decHi; d += decStep) {
    const y = yOf(d * Math.LN10);
    ctx.strokeStyle = "#eceff1";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillStyle = "#9ca3af";
    const label =
      d === 0 ? "×1" : d > 0 ? `×10${sup(d)}` : `÷10${sup(-d)}`;
    ctx.fillText(label, padL - 6, y + 3);
  }

  // 元本ライン
  ctx.strokeStyle = "#9ca3af";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, y1);
  ctx.lineTo(padL + plotW, y1);
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padT, plotW, plotH);
  ctx.clip();

  const straight = (g: number, color: string, dash: number[]) => {
    ctx.strokeStyle = color;
    ctx.setLineDash(dash);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(0));
    ctx.lineTo(xOf(n), yOf(g * n));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  straight(gEnsemble, "#2563eb", [5, 4]); // 期待値どおり（+5%/回）
  straight(gTime, "#b45309", [3, 3]); // 時間平均どおり（−5.13%/回）

  // 実際の1人の軌跡
  ctx.strokeStyle = "#dc2626";
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  logs.forEach((lv, k) => {
    const px = xOf(k);
    const py = yOf(lv);
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // ラベル（2本の理論線）
  ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "right";
  outlined(ctx, "期待値どおり +5%/回", xOf(n) - 4, yOf(gEnsemble * n) - 5, "#2563eb");
  outlined(ctx, "実質 −5.1%/回", xOf(n) - 4, yOf(gTime * n) + 12, "#b45309");

  // 終端
  const ey = yOf(logs[n]);
  ctx.beginPath();
  ctx.arc(xOf(n), ey, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = "#dc2626";
  ctx.stroke();
  ctx.restore();

  // 軸
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "#9ca3af";
  for (let k = 0; k <= n; k += Math.max(1, Math.round(n / 5))) {
    ctx.fillText(`${k}`, xOf(k), padT + plotH + 14);
  }
  ctx.fillText("投げた回数（横軸は合成時間・日付に意味はありません）", padL + plotW / 2, height - 6);
}

/** 10のべき乗表示用の上付き数字。 */
function sup(d: number): string {
  const map: Record<string, string> = {
    "0": "⁰",
    "1": "¹",
    "2": "²",
    "3": "³",
    "4": "⁴",
    "5": "⁵",
    "6": "⁶",
    "7": "⁷",
    "8": "⁸",
    "9": "⁹",
  };
  return String(d)
    .split("")
    .map((c) => map[c] ?? c)
    .join("");
}
