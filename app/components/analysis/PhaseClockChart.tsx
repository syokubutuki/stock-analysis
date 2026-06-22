"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import { SeriesMode, extractSeries } from "../../lib/series-mode";
import {
  buildPhaseClock,
  phaseStateFn,
  dominantPeriod,
} from "../../lib/phase-clock";
import { conditionalForwardReturns } from "../../lib/conditional-forward-returns";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  seriesMode: SeriesMode;
}

const SECTOR_OPTIONS = [8, 12, 16, 24];

export default function PhaseClockChart({ prices, seriesMode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [userPeriod, setUserPeriod] = useState<number | null>(null); // null = 自動
  const [sectors, setSectors] = useState(12);
  const [horizon, setHorizon] = useState(10);
  const [strongOnly, setStrongOnly] = useState(true);

  const { values } = extractSeries(prices, seriesMode);

  const autoPeriod = useMemo(() => dominantPeriod(values), [values]);
  const period = userPeriod ?? autoPeriod;

  const clock = useMemo(() => buildPhaseClock(values, period), [values, period]);

  const state = useMemo(
    () => phaseStateFn(clock, sectors, strongOnly),
    [clock, sectors, strongOnly]
  );

  const fwd = useMemo(
    () => conditionalForwardReturns(prices, state, horizon, { boot: 300 }),
    [prices, state, horizon]
  );

  // セクター index → 統計 にマップ
  const sectorStats = useMemo(() => {
    const arr: (typeof fwd.buckets[number] | null)[] = new Array(sectors).fill(null);
    for (const b of fwd.buckets) {
      const idx = state.order.indexOf(b.label);
      if (idx >= 0) arr[idx] = b;
    }
    return arr;
  }, [fwd, state, sectors]);

  const maxAbs = useMemo(() => {
    let m = 1e-9;
    for (const b of fwd.buckets) m = Math.max(m, Math.abs(b.meanFwd - fwd.baselineMean));
    return m;
  }, [fwd]);

  // 現在のセクター
  const nowSector = useMemo(() => {
    if (fwd.nowLabel === null) return null;
    const idx = state.order.indexOf(fwd.nowLabel);
    return idx >= 0 ? idx : null;
  }, [fwd, state]);
  const nowStat = nowSector !== null ? sectorStats[nowSector] : null;
  const ampRatio =
    clock.nowAmp !== null && clock.ampMedian > 0 ? clock.nowAmp / clock.ampMedian : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const size = Math.min(parent.clientWidth, 420);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2 - 30;
    const step = (2 * Math.PI) / sectors;

    // 位相→画面角(12時=0°, 時計回り)
    const sx = (ph: number, r: number) => cx + r * Math.sin(ph);
    const sy = (ph: number, r: number) => cy - r * Math.cos(ph);

    // 各セクターの扇を平均フォワードで色付け
    for (let s = 0; s < sectors; s++) {
      const a0 = s * step;
      const a1 = (s + 1) * step;
      const st = sectorStats[s];
      let fill = "#f3f4f6";
      if (st) {
        const d = (st.meanFwd - fwd.baselineMean) / maxAbs; // -1..1
        const t = Math.max(-1, Math.min(1, d));
        if (t >= 0) {
          const alpha = 0.15 + 0.65 * t;
          fill = `rgba(16,185,129,${alpha.toFixed(3)})`; // 緑
        } else {
          const alpha = 0.15 + 0.65 * -t;
          fill = `rgba(239,68,68,${alpha.toFixed(3)})`; // 赤
        }
      }
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      // canvas.arc は3時=0,時計回り。画面角 ph に対応する標準角 = ph - π/2。
      ctx.arc(cx, cy, R, a0 - Math.PI / 2, a1 - Math.PI / 2);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 有意なセクターに枠
      if (st && st.significant) {
        ctx.beginPath();
        ctx.arc(cx, cy, R, a0 - Math.PI / 2, a1 - Math.PI / 2);
        ctx.strokeStyle = "#111827";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      // セクター中央にフォワード%ラベル(分割が粗いときのみ)
      if (st && sectors <= 12) {
        const mid = (a0 + a1) / 2;
        const lr = R * 0.66;
        ctx.fillStyle = "#374151";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`${(st.meanFwd * 100).toFixed(1)}%`, sx(mid, lr), sy(mid, lr));
      }
    }

    // 外周リング
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 1;
    ctx.stroke();

    // 12/3/6/9時の目盛りラベル
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const ticks: [number, string][] = [
      [0, "0°"],
      [Math.PI / 2, "90°"],
      [Math.PI, "180°"],
      [(3 * Math.PI) / 2, "270°"],
    ];
    for (const [ph, lbl] of ticks) {
      ctx.fillText(lbl, sx(ph, R + 14), sy(ph, R + 14));
    }

    // 現在位相の針
    if (clock.nowPhase !== null) {
      const ratio = ampRatio === null ? 1 : Math.max(0.3, Math.min(1.2, ampRatio));
      const needleR = R * Math.min(1, 0.55 + 0.4 * ratio);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(sx(clock.nowPhase, needleR), sy(clock.nowPhase, needleR));
      ctx.strokeStyle = "#1d4ed8";
      ctx.lineWidth = 3;
      ctx.stroke();
      // 針先
      ctx.beginPath();
      ctx.arc(sx(clock.nowPhase, needleR), sy(clock.nowPhase, needleR), 5, 0, 2 * Math.PI);
      ctx.fillStyle = "#1d4ed8";
      ctx.fill();
    }
    // 中心
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, 2 * Math.PI);
    ctx.fillStyle = "#111827";
    ctx.fill();
  }, [sectorStats, sectors, maxAbs, clock, ampRatio, fwd.baselineMean]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-bold text-gray-800 mb-1">位相時計 (Cycle Phase Clock)</h3>
      <p className="text-xs text-gray-500 mb-3">
        卓越サイクルの「今の位相」を文字盤の針で示し、各位相の後に実際どう動いたか(フォワードリターン)で色付け
        — 緑=上昇しやすい位相 / 赤=下落しやすい位相
      </p>

      {/* コントロール */}
      <div className="flex flex-wrap gap-x-5 gap-y-2 mb-3 text-xs text-gray-600 items-center">
        <label className="flex items-center gap-2">
          周期 P = {period}日
          <input
            type="range" min={4} max={120}
            value={period}
            onChange={(e) => setUserPeriod(Number(e.target.value))}
            className="w-40"
          />
          <button
            onClick={() => setUserPeriod(null)}
            className={`px-2 py-0.5 rounded border ${
              userPeriod === null
                ? "bg-blue-600 text-white border-blue-600"
                : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
            }`}
          >
            自動({autoPeriod}日)
          </button>
        </label>
        <label className="flex items-center gap-2">
          フォワード {horizon}日
          <input
            type="range" min={1} max={60}
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
            className="w-36"
          />
        </label>
        <label className="flex items-center gap-1.5">
          分割
          <select
            value={sectors}
            onChange={(e) => setSectors(Number(e.target.value))}
            className="border border-gray-300 rounded px-1 py-0.5"
          >
            {SECTOR_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={strongOnly}
            onChange={(e) => setStrongOnly(e.target.checked)}
          />
          強サイクル日のみ
        </label>
      </div>

      {/* 統計カード */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <StatCard
          label="現在の位相"
          value={clock.nowPhase !== null ? `${Math.round((clock.nowPhase * 180) / Math.PI)}°` : "—"}
          sub={nowSector !== null ? `セクター ${state.order[nowSector]}` : undefined}
        />
        <StatCard
          label={`この位相の${horizon}日先`}
          value={nowStat ? `${(nowStat.meanFwd * 100).toFixed(2)}%` : "—"}
          sub={nowStat ? `勝率 ${(nowStat.winRate * 100).toFixed(0)}% / n=${nowStat.n}` : undefined}
          accent={nowStat ? (nowStat.meanFwd > fwd.baselineMean ? "pos" : "neg") : undefined}
          badge={nowStat?.significant ? "有意" : undefined}
        />
        <StatCard
          label="サイクル強度(今)"
          value={ampRatio !== null ? `${ampRatio.toFixed(2)}×` : "—"}
          sub={ampRatio !== null ? (ampRatio >= 1 ? "強(平常以上)" : "弱(平常未満)") : undefined}
        />
        <StatCard
          label="基準(全標本平均)"
          value={`${(fwd.baselineMean * 100).toFixed(2)}%`}
          sub={`勝率 ${(fwd.baselineWin * 100).toFixed(0)}%`}
        />
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-start">
        <div>
          <canvas ref={canvasRef} className="rounded border border-gray-100" />
          <div className="text-xs text-gray-400 mt-1">
            12時=位相0°(直近のサイクル天井基準), 時計回りに位相が進む / 青い針=現在 / 黒枠=統計的に有意
          </div>
        </div>
        <div className="text-xs text-gray-600 space-y-2 flex-1 min-w-0">
          <p>
            針が今サイクルのどこにいるかを示します。針が指すセクターの色が
            <strong className="text-emerald-600">緑</strong>なら、過去その位相にいた後は
            平均的に上昇しており、<strong className="text-red-600">赤</strong>なら下落していました。
          </p>
          <div className="p-2 bg-gray-50 rounded space-y-1">
            <p>
              <span className="font-medium">使い方:</span> 針が赤セクターから緑セクターへ
              入る境目が、サイクル的な押し目買いの目安。逆に緑→赤の境目は利確/手仕舞いの目安。
            </p>
            <p>
              <span className="font-medium">サイクル強度</span>が1×未満のときは
              サイクルが弱く位相シグナルの信頼度が落ちるため、「強サイクル日のみ」を
              ONにして強い局面だけで検証するのが安全です。
            </p>
          </div>
          {fwd.nowLabel === null && (
            <p className="text-amber-600">
              データが不足しているか立ち上がり区間のため、現在位相を判定できません。
            </p>
          )}
        </div>
      </div>

      <AnalysisGuide title="位相時計の詳細理論">
        <p className="font-medium text-gray-700">1. 位相時計とは</p>
        <p>
          株価には強弱はあるものの、しばしば「上げては下げ」を繰り返す
          <strong>サイクル(周期的な振動)</strong>が含まれます。位相時計は、その卓越サイクルが
          「今ひと回りのうちどの位置(位相)にいるか」を時計の針で表し、
          過去に同じ位相にいた後どう動いたかを文字盤の色で示す道具です。
          「観覧車の今の高さと、この後の動き」を一目で結びつけます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 位相の求め方(複素復調)</p>
        <p>
          サイクルの位相を出すには複素数表現が必要ですが、Hilbert変換やMorletは
          計算に未来の値を使うため、売買判断に使うと
          <strong>先読みバイアス</strong>になります。そこで本ツールは過去の値だけで計算できる
          <strong>複素復調(complex demodulation)</strong>を使います。
        </p>
        <ul className="list-disc pl-4 space-y-1 mt-1">
          <li>因果的EMAで長期トレンドを引き去り、周期成分 r(t) を取り出す。</li>
          <li>{"搬送波を掛けて周波数変換: y₀(t) = r(t)·e^{-i·2πt/P}"}。</li>
          <li>{"因果的EMAでローパス → ベースバンド複素振幅 y(t) ≈ (A/2)·e^{iθ(t)}"}。</li>
          <li>{"瞬時位相 Φ(t) = (2πt/P + θ(t)) mod 2π、振幅 A(t) = 2|y(t)|"}。</li>
        </ul>
        <p className="mt-1">
          P は周期。位相0°はサイクルの山(直近の天井)付近、180°は谷付近に対応しますが、
          実際の売買意味は文字盤の色(後述)で自動的に較正されるため、定義の向きを気にする必要はありません。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 文字盤の色付け</p>
        <p>
          各日を位相セクターに割り当て、その{horizon}日後までの実際のリターンを集計します
          (建値=当日終値)。セクター平均が全体平均より高ければ緑、低ければ赤で、
          色の濃さは差の大きさです。t検定をBenjamini-Hochberg(FDR)補正した上で
          有意(p&lt;0.05)なセクターには黒枠を付けます。
        </p>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>青い針</strong>が現在の位相。針の長さは現在のサイクル強度に比例。</li>
          <li>針が<strong>緑セクター</strong>を指す=この位相からは過去上昇しやすかった→押し目買い寄り。</li>
          <li>針が<strong>赤セクター</strong>を指す=下落しやすかった→利確/様子見寄り。</li>
          <li><strong>赤→緑の境目</strong>はサイクル的な買い場、<strong>緑→赤の境目</strong>は売り場の目安。</li>
          <li>黒枠のセクターほど統計的根拠が強い。枠なしは偶然の可能性が残る。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>「自動」で卓越周期を検出し、針が緑域に入る局面をエントリー候補にする。</li>
          <li>フォワード日数を保有予定期間に合わせ、その期間で効く位相を選ぶ。</li>
          <li>「強サイクル日のみ」をONにし、サイクルがはっきり効いている局面に絞ると精度が上がる。</li>
          <li>他のシグナル(RSIやトレンド状態)と位相が一致したときだけ動く、という重ね使いが有効。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>サイクルは常に存在するわけではない。強度が低い局面では位相は雑音同然。</li>
          <li>卓越周期は時間とともに変化する。1つの固定Pが将来も有効とは限らない。</li>
          <li>セクターを細かくしすぎると各バケットの標本が減り、有意性が出にくくなる。</li>
          <li>複素復調のEMAには位相遅れがあり、転換点の検出が数日遅れることがある。</li>
          <li>記述的ツールであり、将来の利益を保証しない。必ず他の根拠と併用すること。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
  badge,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "pos" | "neg";
  badge?: string;
}) {
  const valueColor =
    accent === "pos" ? "text-emerald-600" : accent === "neg" ? "text-red-600" : "text-gray-800";
  return (
    <div className="p-2 bg-gray-50 rounded text-xs">
      <div className="text-gray-500 flex items-center gap-1">
        {label}
        {badge && (
          <span className="px-1 rounded bg-gray-900 text-white text-[10px]">{badge}</span>
        )}
      </div>
      <div className={`font-bold ${valueColor}`}>{value}</div>
      {sub && <div className="text-gray-400">{sub}</div>}
    </div>
  );
}
