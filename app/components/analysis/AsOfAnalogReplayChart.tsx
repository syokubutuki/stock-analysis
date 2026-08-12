"use client";

// as-of アナログ経路リプレイ: 過去の各週末に戻って「そのとき出ていた予測経路」を再現し、
// 実際に辿った経路を1枚ずつ重ねて並べる。
//
// 既存の「アナログ予測のOOS検証」(cal-weekly-analog-oos) は同じ再現を集計値に畳んで出す。
// 集計は判定には要るが、平均の裏で個々の予測がどう外れたかは見えない——
// 「終点は当たったが途中で大きく沈んだ」「帯が広すぎて当たり前に入っていた」は平均に埋もれる。
// ここでは同じ計算(runWeeklyAnalogOos)の点を畳まずに並べ、目で確認できるようにする。

import React, { useEffect, useMemo, useState } from "react";
import { PricePoint } from "../../lib/types";
import AnalysisGuide from "./AnalysisGuide";
import { useUsDaily } from "../../hooks/useUsDaily";
import { useAnalogWorker } from "../../hooks/useAnalogWorker";
import { computeUsReturns, BinScheme } from "../../lib/us-spillover-core";
import { AnalogMode, DistMetric, WindowAlign } from "../../lib/weekly-analog";
import { OosResult, OosPredPoint, OosSetting } from "../../lib/weekly-analog-oos";

interface Props {
  prices: PricePoint[];
  ticker: string;
}

const H_CHOICES = [5, 10, 21];
const SHOW_CHOICES = [8, 16, 32];

function pct(v: number, d = 1): string {
  return isFinite(v) ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%` : "—";
}
function fmt(v: number, d = 3): string {
  return isFinite(v) ? v.toFixed(d) : "—";
}

/**
 * 1つの as-of の予測と実測を重ねる小さな図。
 * 薄青帯=予測25–75% / 青点線=予測中央 / 黒線=実際に辿った経路。
 */
function PathCell({ p, H, scale }: { p: OosPredPoint; H: number; scale: number }) {
  const W = 132, HT = 56, padX = 4, padY = 5;
  const X = (m: number) => padX + (m / H) * (W - 2 * padX);
  const clamp = (v: number) => Math.max(-scale, Math.min(scale, v));
  const Y = (v: number) => HT / 2 - (clamp(v) / scale) * (HT / 2 - padY);
  const line = (arr: number[]) => arr.map((v, m) => `${m === 0 ? "M" : "L"}${X(m).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const hasBand = !!p.p25 && !!p.p75 && p.p25.length > 1;
  const up = hasBand ? p.p75!.map((v, m) => `${X(m).toFixed(1)},${Y(v).toFixed(1)}`) : [];
  const lo = hasBand ? p.p25!.map((v, m) => `${X(m).toFixed(1)},${Y(v).toFixed(1)}`).reverse() : [];

  // 帯被覆(この1件ぶん)
  let covHit = 0, covTot = 0;
  if (hasBand && p.pathAct) {
    for (let m = 1; m < Math.min(p.pathAct.length, p.p25!.length); m++) {
      const a = p.pathAct[m], l = Math.min(p.p25![m], p.p75![m]), h = Math.max(p.p25![m], p.p75![m]);
      if (!isFinite(a) || !isFinite(l) || !isFinite(h)) continue;
      covTot++; if (a >= l && a <= h) covHit++;
    }
  }
  const dirOk = isFinite(p.yhat) && p.yhat !== 0 ? Math.sign(p.yact) === Math.sign(p.yhat) : null;

  return (
    <div className="rounded border border-gray-200 bg-white px-1.5 py-1">
      <div className="flex items-center justify-between text-[10px] text-gray-500">
        <span className="font-mono">{p.date}</span>
        <span>
          {dirOk === null ? <span className="text-gray-300">—</span>
            : dirOk ? <span className="text-green-600">○</span> : <span className="text-red-500">×</span>}
        </span>
      </div>
      <svg width={W} height={HT} style={{ overflow: "visible" }}>
        <line x1={padX} y1={HT / 2} x2={W - padX} y2={HT / 2} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="2 2" />
        {hasBand && <path d={`M${up.join(" L")} L${lo.join(" L")} Z`} fill="rgba(37,99,235,0.12)" />}
        {p.pathHat && <path d={line(p.pathHat)} fill="none" stroke="#2563eb" strokeWidth={1.4} strokeDasharray="3 2" />}
        {p.pathAct && p.pathAct.length > 1 && <path d={line(p.pathAct)} fill="none" stroke="#111827" strokeWidth={1.7} />}
      </svg>
      <div className="flex items-center justify-between text-[10px] tabular-nums">
        <span className="text-blue-600">予{pct(p.yhat)}</span>
        <span className={p.yact >= 0 ? "text-green-700 font-medium" : "text-red-600 font-medium"}>実{pct(p.yact)}</span>
        <span className="text-fg-muted">被{covTot ? `${Math.round((covHit / covTot) * 100)}%` : "—"}</span>
      </div>
    </div>
  );
}

export default function AsOfAnalogReplayChart({ prices, ticker }: Props) {
  const [mode, setMode] = useState<AnalogMode>("similar");
  const [metric, setMetric] = useState<DistMetric>("euclid");
  const [align, setAlign] = useState<WindowAlign>("week");
  const [H, setH] = useState(10);
  const [K, setK] = useState(20);
  const [maxWeeks, setMaxWeeks] = useState(104);
  const [show, setShow] = useState(16);
  const [usTicker, setUsTicker] = useState("^IXIC");
  const [scheme] = useState<BinScheme>("tercile");
  // 結果は「どの設定で得たか」(sig)と一緒に持つ。running は state を書かずに sig の差で判定する
  // （effect の中で同期的に setState すると再レンダリングが連鎖するため）。
  const [state, setState] = useState<{ sig: string; oos: OosResult | null; err: string | null }>(
    { sig: "", oos: null, err: null }
  );

  const { prices: usPrices, loading: usLoading } = useUsDaily(usTicker);
  const us = useMemo(() => (usPrices ? computeUsReturns(usPrices) : []), [usPrices]);
  const { run } = useAnalogWorker();

  const setting: OosSetting = useMemo(
    () => ({ mode, metric, align, L: 5, K, weight: "uniform", volNorm: false }),
    [mode, metric, align, K]
  );

  const needsUs = mode !== "similar";
  const ready = prices.length >= 300 && (!needsUs || us.length > 0);

  const sig = useMemo(
    () => JSON.stringify([ticker, prices.length, mode, metric, align, H, K, maxWeeks, needsUs ? usTicker : "", us.length]),
    [ticker, prices.length, mode, metric, align, H, K, maxWeeks, needsUs, usTicker, us.length]
  );

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    run({ kind: "oos", prices, us, setting, scheme, H, maxWeeks }).then((resp) => {
      if (!alive) return;
      setState({ sig, oos: resp.oos ?? null, err: resp.error ?? null });
    });
    return () => { alive = false; };
  }, [ready, run, prices, us, setting, scheme, H, maxWeeks, sig]);

  const oos = state.sig === sig ? state.oos : null;
  const err = state.sig === sig ? state.err : null;
  const running = ready && state.sig !== sig;

  const points = oos?.points ?? [];
  const shown = points.slice(-show).reverse(); // 新しい順

  // 全セル共通のスケール（1枚ごとに伸縮すると「大きく外した」が見えなくなる）
  const scale = useMemo(() => {
    let mx = 0.01;
    for (const p of shown) {
      for (const arr of [p.p25, p.p75, p.pathAct, p.pathHat]) {
        if (!arr) continue;
        for (const v of arr) if (isFinite(v)) mx = Math.max(mx, Math.abs(v));
      }
    }
    return mx;
  }, [shown]);

  if (prices.length < 300) {
    return <div className="text-xs text-fg-muted p-3">データが不足しています（300営業日以上必要）。</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">as-of アナログ経路リプレイ — 過去の各週末の予測を畳まずに並べる</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          各週末で、その週末までの価格だけを使ってアナログ予測を作り直し、実際に辿った経路を重ねます。
          集計値（IC・被覆率）は判定に必要ですが、<span className="font-medium">平均の裏で個々の予測がどう外れたか</span>は
          並べないと見えません。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          モード
          <select className="border rounded px-1 py-0.5" value={mode} onChange={(e) => setMode(e.target.value as AnalogMode)}>
            <option value="similar">似た形</option>
            <option value="usbin">米国ビン</option>
            <option value="ensemble">アンサンブル</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          距離
          <select className="border rounded px-1 py-0.5" value={metric} onChange={(e) => setMetric(e.target.value as DistMetric)}>
            <option value="euclid">ユークリッド</option>
            <option value="dtw">DTW</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          窓
          <select className="border rounded px-1 py-0.5" value={align} onChange={(e) => setAlign(e.target.value as WindowAlign)}>
            <option value="week">週境界</option>
            <option value="trailing">直近5日</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          先行きH
          <select className="border rounded px-1 py-0.5" value={H} onChange={(e) => setH(Number(e.target.value))}>
            {H_CHOICES.map((h) => <option key={h} value={h}>{h}日</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          近傍K
          <input type="number" min={5} max={60} value={K} onChange={(e) => setK(Math.max(5, Math.min(60, Number(e.target.value) || 20)))}
            className="border rounded px-1 py-0.5 w-14" />
        </label>
        <label className="flex items-center gap-1">
          検証週数
          <select className="border rounded px-1 py-0.5" value={maxWeeks} onChange={(e) => setMaxWeeks(Number(e.target.value))}>
            {[52, 104, 156].map((w) => <option key={w} value={w}>{w}週</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          表示件数
          <select className="border rounded px-1 py-0.5" value={show} onChange={(e) => setShow(Number(e.target.value))}>
            {SHOW_CHOICES.map((s) => <option key={s} value={s}>{s}件</option>)}
          </select>
        </label>
        {needsUs && (
          <label className="flex items-center gap-1">
            米国
            <select className="border rounded px-1 py-0.5" value={usTicker} onChange={(e) => setUsTicker(e.target.value)}>
              <option value="^IXIC">NASDAQ</option>
              <option value="^GSPC">S&amp;P500</option>
              <option value="^DJI">NYダウ</option>
            </select>
          </label>
        )}
        {(running || usLoading) && <span className="text-blue-600">再現中…</span>}
      </div>

      {err && <div className="text-xs text-red-600 p-2 bg-red-50 rounded">{err}</div>}
      {needsUs && !usLoading && us.length === 0 && (
        <div className="text-xs text-amber-700 p-2 bg-amber-50 rounded">米国指数を取得できませんでした。「似た形」モードなら米国データ無しで動きます。</div>
      )}

      {oos && (
        <>
          <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] text-gray-700 space-y-0.5">
            <div>
              再現した週末 <span className="font-bold">{oos.n}</span> 件（重複を畳んだ実効 <span className="font-bold">{oos.nEff.toFixed(0)}</span> 件・先行き{oos.H}日）
            </div>
            <div>
              終点IC <span className="font-bold">{fmt(oos.ic)}</span>
              <span className="text-gray-500">（95%CI {fmt(oos.icLo, 2)}〜{fmt(oos.icHi, 2)}）</span>
              <span className="mx-1.5 text-gray-300">|</span>
              方向的中 <span className="font-bold">{(oos.hit * 100).toFixed(0)}%</span>
              <span className="text-gray-500">（多数派ヌル {(oos.baseHit * 100).toFixed(0)}%）</span>
              <span className="mx-1.5 text-gray-300">|</span>
              分位の単調性 {fmt(oos.monotone, 2)}
            </div>
            {oos.path && (
              <div>
                帯被覆 <span className="font-bold">{(oos.path.coverage * 100).toFixed(0)}%</span>
                <span className="text-gray-500">（名目50%・CI {(oos.path.coverageLo * 100).toFixed(0)}–{(oos.path.coverageHi * 100).toFixed(0)}%・平均幅{(oos.path.bandWidth * 100).toFixed(1)}pt）</span>
                <span className="mx-1.5 text-gray-300">|</span>
                高値到達 {(oos.path.mfeTouch * 100).toFixed(0)}% / 安値到達 {(oos.path.maeTouch * 100).toFixed(0)}%
                <span className="text-gray-500">（較正なら各≒50%）</span>
                {oos.path.shapeOk && (
                  <>
                    <span className="mx-1.5 text-gray-300">|</span>
                    形の一致 {fmt(oos.path.shapeCorr, 2)}
                    <span className="text-gray-500">（ヌル {fmt(oos.path.shapeCorrNull, 2)}・p={oos.path.shapeCorrP < 0.001 ? "<.001" : oos.path.shapeCorrP.toFixed(3)}）</span>
                  </>
                )}
              </div>
            )}
            {(oos.icLo <= 0 && oos.icHi >= 0) && (
              <div className="text-amber-700">
                終点ICの95%CIが0をまたいでいます＝この設定の予測に順位相関の証拠はありません。個々のセルで当たっているものは偶然の範囲です。
              </div>
            )}
          </div>

          <div>
            <div className="text-xs text-gray-500 mb-1">
              新しい順・全セル共通スケール（±{(scale * 100).toFixed(1)}%）。
              <span className="text-blue-600">青点線=予測中央</span> / 薄青帯=予測25–75% / <span className="text-gray-900">黒線=実測経路</span>。
              ○×は終点方向の当否、「被」は実測が帯に入っていた日の割合。
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1.5">
              {shown.map((p) => <PathCell key={p.date} p={p} H={oos.H} scale={scale} />)}
            </div>
            {shown.length === 0 && <div className="text-xs text-fg-muted">再現できた週末がありません。</div>}
          </div>
        </>
      )}

      <AnalysisGuide title="as-of アナログ経路リプレイの詳細理論">
        <p className="font-medium text-gray-700">1. 何をしているか</p>
        <p>
          過去の各週末 t について、<span className="font-medium">その週末までの価格だけ</span>から
          「今の形に似た過去の窓」を探し、その後の経路の中央値・25–75%帯・高安到達を予測として構成します。
          そのうえで実際に辿った経路を重ね、1件ずつカードにして並べます。計算そのものは
          「アナログ予測のOOS検証」と同一（同じ関数を呼んでいます）で、違いは
          <span className="font-medium">集計に畳まずに個票を出す</span>点だけです。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. なぜ個票が要るか</p>
        <p>
          集計値は「平均的にどうだったか」しか答えません。しかし実務で効くのは、
          <span className="font-medium">外れ方の質</span>です。同じ被覆率50%でも
        </p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ほぼ全件が帯の内側すれすれ ＝ 帯が広すぎて情報がない</li>
          <li>半数は中央付近・半数は大きく外 ＝ 予測できる週とできない週が分かれている</li>
        </ul>
        <p>
          では意味が全く違います。前者は帯を狭めるべきで、後者は「どの週なら効くか」の条件を探すべきです。
          平均値だけを見ているとこの区別がつきません。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 数式と定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"予測終点 ŷ_t = median{ 選抜された過去窓の H 日後累積リターン }"}</li>
          <li>{"実測終点 y_t = C_{t+H}/C_t − 1"}</li>
          <li>{"終点IC = Spearman(ŷ, y)。順位相関なので外れ値に強い"}</li>
          <li>{"帯被覆 = (1/Σm) Σ_t Σ_m 1{ P25_{t,m} ≤ act_{t,m} ≤ P75_{t,m} }。名目は 0.5"}</li>
          <li>{"実効週数 nEff ≈ n / ceil(H/5)。H 日先を週次で評価すると標本が重なるため"}</li>
          <li>{"形の一致 = 予測増分と実測増分の Pearson 相関を Fisher-z 平均。ヌルは巡回シフト（予測と実測の対応だけを壊す）"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">まず上段の CI を見ます。</span>終点ICの95%CIが0をまたぐなら、下のカードで当たって見えるものは全て偶然の範囲です。個票は「なぜ外れたか」を考える材料であって、当たりを数える場所ではありません。</li>
          <li><span className="font-medium">帯被覆が50%を大きく下回る</span>なら、その帯を「5割の確率で収まる範囲」として読むのは誤りです。ストップ幅に使うと想定より高頻度で刈られます。</li>
          <li><span className="font-medium">高値到達・安値到達</span>は較正されていれば各50%です。安値到達だけが50%を大きく超えるなら、下方向のリスクを系統的に過小評価しています。</li>
          <li>黒線が帯を大きく突き抜けるカードが特定の時期に固まっているなら、レジームが変わって「似た過去」が機能しなくなった可能性があります。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>方向でなく<span className="font-medium">値幅</span>に使うのが基本です。方向ICが0でも、帯が較正されていればストップ幅・利確目標の初期値としては機能します。</li>
          <li>外したカードの日付を控え、その週に何があったか（決算・指数イベント・急変）を確認します。「前例が薄い週は外す」なら、novelty を発注の足切りに使えます。</li>
          <li>設定（モード・距離・窓・H・K）を変えて individual のカードがどう動くかを見ると、その設定が本当に形を捉えているのか、単にノイズに追随しているのかが分かります。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">設定を選んでいるのは今日の自分です。</span>as-of の切り出しは厳密で先読みはありませんが、良く見える設定を探して回せば、いくらでも当たっているカードの並びを作れます。設定を変えるたびに多重性が増えることを忘れないでください。判定は必ず CI と、多重比較を補正したカタログ・スキャン側で行います。</li>
          <li>週末の重複により実効標本数は表示の n よりずっと小さくなります（H=10 なら約半分）。</li>
          <li>価格は配当・分割で遡及調整されるため、当時の生の株価とは一致しません。</li>
          <li>米国ビン/アンサンブルのビン境界は、その as-of までに観測された米国リターンの分位で決まります（未来の分位は使っていません）。ただし境界は時点ごとに動くので、モード間で「同じビン」を比較することはできません。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
