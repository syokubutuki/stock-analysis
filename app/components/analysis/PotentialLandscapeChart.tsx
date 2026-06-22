"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  buildPotentialLandscape,
  StateKind,
} from "../../lib/potential-landscape";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const KINDS: { key: StateKind; label: string }[] = [
  { key: "maDev", label: "移動平均乖離率(%)" },
  { key: "zscore", label: "Zスコア(σ)" },
];
const SMOOTH: { key: number; label: string }[] = [
  { key: 0.6, label: "細かい" },
  { key: 1.0, label: "標準" },
  { key: 1.7, label: "滑らか" },
];

export default function PotentialLandscapeChart({ prices }: Props) {
  const mainRef = useRef<HTMLCanvasElement>(null);
  const driftRef = useRef<HTMLCanvasElement>(null);
  const [kind, setKind] = useState<StateKind>("maDev");
  const [window, setWindow] = useState(50);
  const [horizon, setHorizon] = useState(5);
  const [smooth, setSmooth] = useState(1.0);

  const land = useMemo(
    () => buildPotentialLandscape(prices, { kind, window, horizon, smoothMult: smooth }),
    [prices, kind, window, horizon, smooth]
  );

  // ----- メイン: ポテンシャル地形 -----
  useEffect(() => {
    const canvas = mainRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = Math.min(parent.clientWidth, 560);
    const height = 280;
    const dpr = window2dpr();
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    if (!land) {
      ctx.fillStyle = "#9ca3af";
      ctx.font = "12px sans-serif";
      ctx.fillText("データが不足しています", 16, 24);
      return;
    }

    const ml = 44, mr = 14, mt = 16, mb = 34;
    const plotW = width - ml - mr;
    const plotH = height - mt - mb;
    const g = land.grid;
    const xMin = g[0], xMax = g[g.length - 1];
    const uMax = Math.max(...land.potential) || 1;
    const X = (x: number) => ml + ((x - xMin) / (xMax - xMin)) * plotW;
    const Y = (u: number) => mt + plotH - (u / uMax) * (plotH - 10);

    // 地形の塗り(谷=低い)
    ctx.beginPath();
    ctx.moveTo(X(g[0]), Y(land.potential[0]));
    for (let i = 1; i < g.length; i++) ctx.lineTo(X(g[i]), Y(land.potential[i]));
    ctx.lineTo(X(g[g.length - 1]), mt + plotH);
    ctx.lineTo(X(g[0]), mt + plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, mt, 0, mt + plotH);
    grad.addColorStop(0, "rgba(148,163,184,0.20)");
    grad.addColorStop(1, "rgba(59,130,246,0.18)");
    ctx.fillStyle = grad;
    ctx.fill();

    // 地形ライン
    ctx.beginPath();
    ctx.moveTo(X(g[0]), Y(land.potential[0]));
    for (let i = 1; i < g.length; i++) ctx.lineTo(X(g[i]), Y(land.potential[i]));
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = 2;
    ctx.stroke();

    // 0(現在位置)の縦線
    ctx.strokeStyle = "#e5e7eb";
    ctx.setLineDash([3, 3]);
    if (0 >= xMin && 0 <= xMax) {
      ctx.beginPath(); ctx.moveTo(X(0), mt); ctx.lineTo(X(0), mt + plotH); ctx.stroke();
    }
    ctx.setLineDash([]);

    // 谷・丘マーカー
    const uAt = (x: number) => {
      let i = 1; while (i < g.length && g[i] < x) i++;
      const t = (x - g[i - 1]) / (g[i] - g[i - 1]);
      return land.potential[i - 1] * (1 - t) + land.potential[i] * t;
    };
    for (const v of land.valleys) {
      ctx.fillStyle = "#10b981";
      ctx.beginPath(); ctx.arc(X(v.x), Y(uAt(v.x)), 5, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = "#065f46"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("谷", X(v.x), Y(uAt(v.x)) + 16);
    }
    for (const h of land.hills) {
      ctx.fillStyle = "#ef4444";
      ctx.beginPath(); ctx.arc(X(h.x), Y(uAt(h.x)), 5, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = "#991b1b"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("丘", X(h.x), Y(uAt(h.x)) - 10);
    }

    // ボール(現在)
    const bx = X(land.xNow);
    const by = Y(uAt(Math.max(xMin, Math.min(xMax, land.xNow))));
    ctx.fillStyle = "#f59e0b";
    ctx.strokeStyle = "#b45309";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(bx, by, 8, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();

    // ドリフト矢印(下り坂=流れ): μ>0 → 右へ, μ<0 → 左へ
    const dir = land.driftNow >= 0 ? 1 : -1;
    const arrowLen = Math.min(60, 12 + Math.abs(land.driftNow) * 1200);
    const ax = bx + dir * arrowLen;
    ctx.strokeStyle = dir > 0 ? "#059669" : "#dc2626";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(bx, by - 18); ctx.lineTo(ax, by - 18); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ax, by - 18);
    ctx.lineTo(ax - dir * 7, by - 22);
    ctx.lineTo(ax - dir * 7, by - 14);
    ctx.closePath(); ctx.fill();

    // 軸
    ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`状態 x (${land.unit})`, ml + plotW / 2, height - 6);
    ctx.textAlign = "left";
    ctx.fillText(`${xMin.toFixed(1)}`, ml, mt + plotH + 12);
    ctx.textAlign = "right";
    ctx.fillText(`${xMax.toFixed(1)}`, ml + plotW, mt + plotH + 12);
    ctx.save();
    ctx.translate(12, mt + plotH / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.fillStyle = "#6b7280";
    ctx.fillText("ポテンシャル U(x)", 0, 0);
    ctx.restore();
  }, [land]);

  // ----- ドリフト μ(x) -----
  useEffect(() => {
    const canvas = driftRef.current;
    if (!canvas || !land) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = Math.min(parent.clientWidth, 560);
    const height = 140;
    const dpr = window2dpr();
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const ml = 44, mr = 14, mt = 14, mb = 22;
    const plotW = width - ml - mr;
    const plotH = height - mt - mb;
    const g = land.grid;
    const xMin = g[0], xMax = g[g.length - 1];
    const dMax = Math.max(0.001, ...land.drift.map(Math.abs));
    const X = (x: number) => ml + ((x - xMin) / (xMax - xMin)) * plotW;
    const Y = (d: number) => mt + plotH / 2 - (d / dMax) * (plotH / 2 - 6);

    // ゼロ線
    ctx.strokeStyle = "#e5e7eb"; ctx.beginPath();
    ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();

    // μ(x) を符号で塗り分け
    for (let i = 1; i < g.length; i++) {
      ctx.beginPath();
      ctx.moveTo(X(g[i - 1]), Y(land.drift[i - 1]));
      ctx.lineTo(X(g[i]), Y(land.drift[i]));
      ctx.strokeStyle = land.drift[i] >= 0 ? "#059669" : "#dc2626";
      ctx.globalAlpha = 0.4 + 0.6 * land.density[i];
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 現在位置
    const cx = X(Math.max(xMin, Math.min(xMax, land.xNow)));
    ctx.strokeStyle = "#f59e0b"; ctx.setLineDash([3, 2]);
    ctx.beginPath(); ctx.moveTo(cx, mt); ctx.lineTo(cx, mt + plotH); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#6b7280"; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(`ドリフト μ(x) = ${land.horizon}日先期待リターン  (+${(dMax * 100).toFixed(1)}%上端)`, ml, mt - 2);
    ctx.textAlign = "right";
    ctx.fillText(`0`, ml - 4, Y(0) + 3);
  }, [land]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">ポテンシャル地形 (Potential / Drift Landscape)</h3>
      <p className="text-xs text-gray-500 mb-3">
        価格を「谷を転がるボール」と見立てる — 谷=平均回帰の引力点(フェアバリュー)、丘=不安定なブレイク領域。
        金色のボールが現在、矢印が次に動きやすい向き(ドリフト)
      </p>

      {/* コントロール */}
      <div className="flex flex-wrap gap-x-5 gap-y-2 mb-3 text-xs text-gray-600 items-center">
        <label className="flex items-center gap-1.5">
          状態
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as StateKind)}
            className="border border-gray-300 rounded px-1 py-0.5"
          >
            {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">
          MA期間 {window}日
          <input type="range" min={10} max={200} value={window}
            onChange={(e) => setWindow(Number(e.target.value))} className="w-32" />
        </label>
        <label className="flex items-center gap-2">
          フォワード {horizon}日
          <input type="range" min={1} max={40} value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))} className="w-28" />
        </label>
        <div className="flex items-center gap-1">
          平滑:
          {SMOOTH.map((s) => (
            <button key={s.key} onClick={() => setSmooth(s.key)}
              className={`px-2 py-0.5 rounded border ${
                smooth === s.key ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"}`}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* 統計カード */}
      {land && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
          <StatCard
            label="現在の状態 x"
            value={`${land.xNow >= 0 ? "+" : ""}${land.xNow.toFixed(2)}${land.unit}`}
            sub={`価格 ${land.priceNow.toFixed(1)} / MA ${land.smaNow.toFixed(1)}`}
          />
          <StatCard
            label={`ドリフト(${land.horizon}日先)`}
            value={`${land.driftNow >= 0 ? "+" : ""}${(land.driftNow * 100).toFixed(2)}%`}
            accent={land.driftNow >= 0 ? "pos" : "neg"}
            sub={land.driftNow >= 0 ? "上昇圧力" : "下落圧力"}
          />
          <StatCard
            label="平均回帰目標(最寄りの谷)"
            value={land.nearestValley ? land.nearestValley.price.toFixed(1) : "—"}
            sub={
              land.nearestValley
                ? `現在比 ${((land.nearestValley.price / land.priceNow - 1) * 100).toFixed(1)}%`
                : "谷が検出されません"
            }
          />
          <StatCard
            label="レジーム"
            value={
              land.regime === "meanRevert" ? "谷(平均回帰)"
                : land.regime === "momentum" ? "丘(順張り)" : "中立"
            }
            accent={land.regime === "meanRevert" ? "pos" : land.regime === "momentum" ? "neg" : undefined}
            sub={
              land.regime === "meanRevert" ? "逆張りが効きやすい"
                : land.regime === "momentum" ? "ブレイク追随向き" : "方向性薄い"
            }
          />
        </div>
      )}

      <div className="space-y-3">
        <div><canvas ref={mainRef} className="rounded border border-gray-100" /></div>
        <div><canvas ref={driftRef} className="rounded border border-gray-100" /></div>
      </div>

      <div className="text-xs text-gray-600 space-y-2 mt-3">
        <div className="p-2 bg-gray-50 rounded space-y-1">
          <p>
            <span className="font-medium">読み方:</span> ボールが
            <strong className="text-emerald-600">谷</strong>の中(かつ矢印が谷底を向く)なら、
            その谷の価格へ戻る平均回帰を狙える。
            <strong className="text-red-600">丘</strong>の上にいると、わずかな動きで
            どちらかへ転がり落ちる不安定状態=ブレイクに乗る方が有利。
          </p>
          <p>
            <span className="font-medium">使い方:</span> 「平均回帰目標」は最寄りの谷の価格。
            現在比がプラスなら上方の谷へ戻りやすく、マイナスなら下方の谷へ。
            下段のドリフト μ(x) が0を上→下に横切る点が安定な谷(フェアバリュー)です。
          </p>
        </div>
      </div>

      <AnalysisGuide title="ポテンシャル地形の詳細理論">
        <p className="font-medium text-gray-700">1. ポテンシャル地形とは</p>
        <p>
          物理では、ボールは坂(ポテンシャル)を転がり、谷の底で安定します。価格も同様に、
          「ある状態(例: 移動平均からの乖離)から、平均的にどちらへ動くか」という
          <strong>ドリフト(引力・斥力)</strong>を持ちます。これを地形図にすると、
          価格が引き寄せられる<strong>谷(フェアバリュー)</strong>と、
          そこから弾かれる<strong>丘(不安定点)</strong>が見えてきます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p className="mt-1">
          状態変数 x を「{KINDS.find((k) => k.key === kind)?.label}」とします。
          各日の x と、その後 {horizon} 日のリターン f を集め、
          状態ごとの期待リターン(ドリフト)をガウスカーネル回帰(Nadaraya-Watson)で推定します:
        </p>
        <p className="mt-1">{"μ(x) = Σ_i K(x−x_i)·f_i / Σ_i K(x−x_i),  K(u)=exp(−u²/2b²)"}</p>
        <p className="mt-1">
          バンド幅 b はSilvermanの目安。ポテンシャルは μ を積分して符号反転したものです:
        </p>
        <p className="mt-1">{"U(x) = −∫ μ(x) dx"}</p>
        <p className="mt-1">
          μ(x)&gt;0 (上昇圧力)の領域では U は下り坂、μ(x)&lt;0 では上り坂。
          U の極小=谷で μ が+から−へ変わる点=<strong>安定均衡(平均回帰の中心)</strong>、
          U の極大=丘で μ が−から+へ変わる点=<strong>不安定均衡</strong>です。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 直感的な例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>谷 = すり鉢の底。少しずれても転がって戻る=押し目・戻り売りが効く水準。</li>
          <li>丘 = 山の頂上。少し押されると一気に転がり落ちる=ブレイクして一方向に走る水準。</li>
          <li>矢印 = ボールにかかる重力の向き。次に動きやすい方向(ドリフト)。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>金色のボール</strong>が現在の状態。谷の斜面にいれば、矢印の向く谷底へ戻りやすい。</li>
          <li><strong>緑の谷マーカー</strong>=平均回帰の目標水準。価格に換算した値が「平均回帰目標」カード。</li>
          <li><strong>赤の丘マーカー</strong>=不安定点。ここを超えると逆側の谷まで転がりやすい(トレンド転換/加速)。</li>
          <li>下段の<strong>ドリフト μ(x)</strong>: 緑=上昇圧力, 赤=下落圧力。線が薄い領域は標本が少なく信頼度低。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>逆張り(レジーム=谷):</strong> ボールが谷の縁にあり矢印が谷底向き→谷の価格をターゲットに反転を狙う。</li>
          <li><strong>順張り(レジーム=丘):</strong> ボールが丘付近→ブレイク方向に追随。逆張りは禁物。</li>
          <li><strong>目標とストップ:</strong> 最寄りの谷=利確目標、丘の向こう側=トレンド転換のストップ基準に使える。</li>
          <li>MA期間・フォワード日数を保有スタイルに合わせ、地形の谷が安定して現れる設定を採用する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>地形は過去全体の平均像。レジームが変わると谷の位置もずれる(定常性の仮定)。</li>
          <li>端(密度の低い領域)は標本が少なく、谷・丘の検出が不安定。極端な乖離での判断は慎重に。</li>
          <li>平滑を強くすると谷が消え、弱くすると偽の谷が増える。複数設定で頑健性を確認すること。</li>
          <li>ドリフトは期待値であり、個々の試行のばらつき(分散)は別問題。サイズ管理は必須。</li>
          <li>記述的ツール。将来の収益を保証しない。他の根拠と併用すること。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

function window2dpr() {
  return typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
}

function StatCard({
  label, value, sub, accent,
}: {
  label: string; value: string; sub?: string; accent?: "pos" | "neg";
}) {
  const c = accent === "pos" ? "text-emerald-600" : accent === "neg" ? "text-red-600" : "text-gray-800";
  return (
    <div className="p-2 bg-gray-50 rounded text-xs">
      <div className="text-gray-500">{label}</div>
      <div className={`font-bold ${c}`}>{value}</div>
      {sub && <div className="text-gray-400">{sub}</div>}
    </div>
  );
}
