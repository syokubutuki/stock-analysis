"use client";

// 曜日 × 前夜米国ビン のイベントスタディ（−K日 〜 +K日の日足経路）。
//
// 「曜日×前夜米国ビン」の分析はどれも当日1日で完結している。この分析は条件に合致した日を
// イベント日 t=0 とし、その前後K日の累積経路を重ねて平均する。左側はその条件が出るまでの背景、
// 右側は効果が持続するのか巻き戻されるのかを示す。
//
// 計算は lib/us-bin-event-study.ts。ここは配線と描画のみ。

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { useUsDaily, US_DRIVERS } from "../../hooks/useUsDaily";
import { computeUsReturns, BinScheme } from "../../lib/us-spillover-core";
import {
  computeUsBinEventStudy, EventStudyResult, EventGroupBy, UsValueMode, WD_LABELS,
} from "../../lib/us-bin-event-study";
import { initCanvas, fmtSignedPct, fmtPct } from "./intradayShared";
import { BinSchemeButtons, UsDriverButtons } from "./usSpilloverShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";
import { CHART_COLORS } from "../../lib/chart-colors";

interface Props { prices: PricePoint[]; }

const US_MODES: { value: UsValueMode; label: string }[] = [
  { value: "ret", label: "前日終値比" },
  { value: "intra", label: "日中" },
];
const K_OPTS = [3, 5, 10];
const GROUP_BYS: { value: EventGroupBy; label: string }[] = [
  { value: "weekday", label: "曜日別（ビンを固定）" },
  { value: "bin", label: "米国ビン別（曜日を固定）" },
];
const WD_FILTERS = [0, 1, 2, 3, 4, 5];

function drawEventPaths(
  ctx: CanvasRenderingContext2D, W: number, H: number, r: EventStudyResult,
  opts: { showCI: boolean; focus: string | null }
) {
  const ml = 48, mr = 10, mt = 12, mb = 24;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const T = r.offsets.length;
  if (T < 3) return;
  const yMax = r.maxAbs * 1.08;
  const X = (i: number) => ml + (i / (T - 1)) * plotW;
  const Y = (v: number) => mt + (1 - (v + yMax) / (2 * yMax)) * plotH;

  ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();

  ctx.fillStyle = CHART_COLORS.ink; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(fmtSignedPct(yMax, 1), ml - 3, mt + 8);
  ctx.fillText("0", ml - 3, Y(0) + 3);
  ctx.fillText(fmtSignedPct(-yMax, 1), ml - 3, mt + plotH);

  // イベント日(s=0)の位置に縦線
  const zi = r.offsets.indexOf(0);
  if (zi >= 0) {
    ctx.setLineDash([4, 3]); ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(zi), mt); ctx.lineTo(X(zi), mt + plotH); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#b45309"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("イベント日", X(zi), mt + 9);
  }

  ctx.save();
  ctx.beginPath(); ctx.rect(ml, mt, plotW, plotH); ctx.clip();

  const visible = r.groups.filter((g) => g.n > 0 && (opts.focus == null || g.key === opts.focus));

  if (opts.showCI) {
    for (const g of visible) {
      if (!isFinite(g.lo[0])) continue;
      ctx.fillStyle = g.color + "22";
      ctx.beginPath();
      for (let i = 0; i < T; i++) ctx.lineTo(X(i), Y(g.hi[i]));
      for (let i = T - 1; i >= 0; i--) ctx.lineTo(X(i), Y(g.lo[i]));
      ctx.closePath(); ctx.fill();
    }
  }

  for (const g of visible) {
    ctx.strokeStyle = g.color; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < T; i++) { const x = X(i), y = Y(g.mean[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
    // FDR補正後に有意なオフセットへ●
    for (let i = 0; i < T; i++) {
      if (g.offPAdj[i] >= 0.05) continue;
      ctx.fillStyle = g.color;
      ctx.beginPath(); ctx.arc(X(i), Y(g.mean[i]), 2.6, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();

  ctx.fillStyle = "#6b7280"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
  const every = T > 15 ? Math.ceil(T / 12) : 1;
  for (let i = 0; i < T; i++) {
    if (i % every !== 0 && r.offsets[i] !== 0) continue;
    const s = r.offsets[i];
    ctx.fillText(s === 0 ? "0" : s > 0 ? `+${s}` : `${s}`, X(i), H - 8);
  }
}

export default function UsBinEventStudyChart({ prices }: Props) {
  const [usTicker, setUsTicker] = useState("^IXIC");
  const [usMode, setUsMode] = useState<UsValueMode>("ret");
  const [scheme, setScheme] = useState<BinScheme>("tercile");
  const [k, setK] = useState(5);
  const [groupBy, setGroupBy] = useState<EventGroupBy>("weekday");
  const [filterBinRaw, setFilterBin] = useState<number | null>(null);
  const [filterWeekday, setFilterWeekday] = useState(0);
  const [showCI, setShowCI] = useState(true);
  const [focus, setFocus] = useState<string | null>(null);

  const { prices: usPrices, loading, error } = useUsDaily(usTicker);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const us = useMemo(() => (usPrices ? computeUsReturns(usPrices) : []), [usPrices]);

  // 未選択なら「直近の前夜米国が属するビン」を見る。ビン数はスキームで変わるのでクランプする。
  const probe = useMemo(
    () => (us.length ? computeUsBinEventStudy({
      prices, us, usMode, scheme, k, groupBy: "bin", filterBin: null, filterWeekday: 0,
    }) : null),
    [prices, us, usMode, scheme, k]
  );
  const nBins = probe?.binInfos.length ?? 3;
  const filterBin = groupBy === "weekday"
    ? Math.min(filterBinRaw ?? probe?.latestBin ?? 1, nBins - 1)
    : null;

  const result = useMemo(
    () => (us.length ? computeUsBinEventStudy({
      prices, us, usMode, scheme, k, groupBy, filterBin, filterWeekday,
    }) : null),
    [prices, us, usMode, scheme, k, groupBy, filterBin, filterWeekday]
  );

  useEffect(() => {
    if (!result || !canvasRef.current) return;
    const init = initCanvas(canvasRef.current, 280);
    if (init) drawEventPaths(init.ctx, init.width, init.height, result, { showCI, focus });
  }, [result, showCI, focus]);

  const usLabel = US_DRIVERS.find((d) => d.ticker === usTicker)?.label ?? usTicker;
  const selBinInfo = result && filterBin !== null ? result.binInfos[filterBin] : null;

  // 「持続 or 巻き戻し」の要約(FDR補正後に有意な群だけを拾う)。
  const summary = useMemo(() => {
    if (!result) return [];
    return result.groups
      .filter((g) => g.n >= 10 && g.postPAdj < 0.05)
      .map((g) => ({
        label: g.label,
        kind: (g.car0 >= 0) === (g.postDiff >= 0) ? "持続" : "巻き戻し",
        car0: g.car0, post: g.postDiff, p: g.postPAdj,
      }));
  }, [result]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <h3 className="font-bold text-gray-800">曜日 × 前夜米国ビン のイベントスタディ（前後{k}日の日足経路）</h3>

      <div className="flex items-center gap-4 flex-wrap">
        <UsDriverButtons value={usTicker} onChange={setUsTicker} />
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">ビン基準:</span>
          {US_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setUsMode(m.value)}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                usMode === m.value ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >{m.label}</button>
          ))}
        </div>
        <BinSchemeButtons value={scheme} onChange={setScheme} />
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">前後:</span>
          {K_OPTS.map((v) => (
            <button
              key={v}
              onClick={() => setK(v)}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                k === v ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >±{v}日</button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">層別:</span>
          {GROUP_BYS.map((g) => (
            <button
              key={g.value}
              onClick={() => { setGroupBy(g.value); setFocus(null); }}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                groupBy === g.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >{g.label}</button>
          ))}
        </div>
        {groupBy === "weekday" && result && (
          <div className="flex items-center gap-1 flex-wrap text-xs">
            <span className="text-gray-500">前夜米国ビン:</span>
            {result.binInfos.map((b) => (
              <button
                key={b.bin}
                onClick={() => setFilterBin(b.bin)}
                title={`n=${b.n}`}
                className={`px-2 py-0.5 rounded font-medium transition-colors ${
                  filterBin === b.bin ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: b.color }} />
                {b.label}
                {result.latestBin === b.bin && <span className="ml-1 text-blue-600">◀今</span>}
              </button>
            ))}
          </div>
        )}
        {groupBy === "bin" && (
          <div className="flex items-center gap-1 flex-wrap text-xs">
            <span className="text-gray-500">曜日:</span>
            {WD_FILTERS.map((w) => (
              <button
                key={w}
                onClick={() => setFilterWeekday(w)}
                className={`px-2 py-0.5 rounded font-medium transition-colors ${
                  filterWeekday === w ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >{w === 0 ? "全曜日" : WD_LABELS[w]}</button>
            ))}
          </div>
        )}
        <label className="flex items-center gap-1 text-xs text-gray-600">
          <input type="checkbox" checked={showCI} onChange={(e) => setShowCI(e.target.checked)} />
          95%CI（ブロックブート）
        </label>
      </div>

      {loading && <div className="text-sm text-fg-muted py-8 text-center">米国指数を取得中...</div>}
      {error && <div className="bg-amber-50 text-amber-700 rounded-lg p-3 text-sm">{error}</div>}
      {!loading && !error && !result && (
        <div className="text-xs text-fg-muted">イベント日が不足しています（期間を広げる／ビンを粗くする）。</div>
      )}

      {result && (
        <>
          {result.latestUsDate && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
              <span className="font-bold">直近の前夜{usLabel}（{result.latestUsDate}）: {fmtSignedPct(result.latestUsValue)}</span>
              {result.latestBin !== null && result.binInfos[result.latestBin] && (
                <> → <span className="font-bold">{result.binInfos[result.latestBin].label}</span></>
              )}
              {groupBy === "weekday" && selBinInfo && (
                <span className="text-blue-700">　（表示中: {selBinInfo.label} n={selBinInfo.n}）</span>
              )}
            </div>
          )}

          {/* 群の凡例(クリックで1群に絞る) */}
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <button
              onClick={() => setFocus(null)}
              className={`px-2 py-0.5 rounded font-medium ${focus == null ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600"}`}
            >全群</button>
            {result.groups.filter((g) => g.n > 0).map((g) => (
              <button
                key={g.key}
                onClick={() => setFocus(focus === g.key ? null : g.key)}
                className="px-2 py-0.5 rounded font-medium"
                style={focus === g.key ? { backgroundColor: g.color, color: "#fff" } : { backgroundColor: "#f3f4f6", color: g.color }}
              >{g.label}（n={g.n}）</button>
            ))}
          </div>

          <div className="relative"><canvas ref={canvasRef} /></div>
          <p className="text-[11px] text-gray-500">
            {"縦軸はイベント前日終値=0の累積対数リターン。s=−1 で全群が0に収束するのは定義による（そこを基準にしているため）。●はFDR補正後もその日の平均が0と異なる点。左側＝その条件が出るまでの背景、右側＝その後。"}
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">群</th>
                  <th className="text-right px-2">イベント数</th>
                  <th className="text-right px-2">当日 CAR(0)</th>
                  <th className="text-right px-2">+{k}日 CAR</th>
                  <th className="text-right px-2">翌日以降の累積</th>
                  <th className="text-right px-2">95%CI</th>
                  <th className="text-left px-2">有意性(FDR)</th>
                  <th className="text-right px-2">反転率</th>
                </tr>
              </thead>
              <tbody>
                {result.groups.filter((g) => g.n > 0).map((g) => (
                  <tr key={g.key} className="border-b border-gray-100">
                    <td className="py-1 px-2">
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: g.color }} />
                        <span className="text-gray-700">{g.label}</span>
                      </span>
                    </td>
                    <td className="text-right px-2 text-gray-600">{g.n}</td>
                    <td className={`text-right px-2 tabular-nums ${g.car0 >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(g.car0)}</td>
                    <td className={`text-right px-2 tabular-nums ${g.carPost >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(g.carPost)}</td>
                    <td className={`text-right px-2 font-medium tabular-nums ${g.postDiff >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(g.postDiff)}</td>
                    <td className="text-right px-2 text-gray-500 tabular-nums text-[10px]">
                      {isFinite(g.postLo) ? `[${fmtSignedPct(g.postLo, 1)}, ${fmtSignedPct(g.postHi, 1)}]` : "—"}
                    </td>
                    <td className="px-2"><StatBadge n={g.n} p={g.postPAdj} significant={g.postPAdj < 0.05} /></td>
                    <td className="text-right px-2 text-gray-600 tabular-nums">{fmtPct(g.reversalRate, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={`rounded-md px-3 py-2 text-xs ${summary.length ? "bg-green-50 text-green-900 border border-green-200" : "bg-gray-50 text-gray-700 border border-gray-200"}`}>
            <span className="font-bold">翌日以降の判定: </span>
            {summary.length === 0
              ? `どの群も「翌日以降の累積」がFDR補正後に0と有意には異ならない。＝この条件の効果はイベント当日で完結しており、翌日以降に持ち越す根拠はない（逆に、翌日に巻き戻される根拠も無い）。`
              : summary.map((s) => `${s.label}: ${s.kind}（当日 ${fmtSignedPct(s.car0)} → 翌日以降 ${fmtSignedPct(s.post)}, FDR p=${s.p.toFixed(3)}）`).join("／")}
          </div>
        </>
      )}

      <p className="text-xs text-fg-muted leading-relaxed">
        {"※ イベント窓(2K+1日)はイベント間隔より長いため窓どうしが重なる。CIは通常の標準誤差ではなくイベント列のブロック・ブートストラップで作っている（重なりが生む相関を保存するため）。それでも重なりの影響は完全には除けない。"}
      </p>

      <AnalysisGuide title="イベントスタディ（前後K日の日足経路）の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"「木曜×米大幅高の日は日中が伸びる」といった条件付き効果が見つかったとき、次に問うべきは『それは翌日以降も残るのか』である。当日で完結する効果なら大引けで必ず手仕舞う必要があるし、数日持続するなら持ち越しに意味がある。逆に翌日に巻き戻されるなら、それは一時的な需給の歪みであって、当日の終値で降りないと利益が消える。この分析は条件に合致した日をイベント日t=0とし、その前後K日の累積経路を重ねて平均することで、効果の寿命を可視化する。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"イベント経路: v_i(s) = ln( C_{t_i+s} / C_{t_i−1} )、s = −K … +K。基準はイベント前日終値なので v_i(−1) = 0。"}</li>
          <li>{"平均累積異常リターン CAR(s) = (1/n)·Σ_i v_i(s)。ここでは市場モデルによる調整はせず、素のリターンを使う（条件そのものが市場全体の状態＝前夜米国だから）。"}</li>
          <li>{"翌日以降の累積: post_i = v_i(+K) − v_i(0)。これが持続/巻き戻しの判定量。1標本t検定＋ブロックブートCIで評価し、群横断でBenjamini-HochbergのFDR補正をかける。"}</li>
          <li>{"反転率 = #{ i : sign(v_i(0)) ≠ sign(post_i) } / n。5割なら翌日以降はコイン投げ。"}</li>
          <li>{"ブロック・ブートストラップ: イベント列を長さ L=⌈n^{1/3}⌉ の連続塊で再標本し、平均経路をB=400回作って分位から95%CIを取る。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>イベントスタディ</strong>: 決算発表や指数組入れなど「ある出来事」の前後のリターンを揃えて平均する分析手法。ここでの出来事は「特定の曜日に、特定の前夜米国ビンで寄り付いたこと」。</li>
          <li><strong>CAR（累積異常リターン）</strong>: イベント時点を起点に累積したリターン。本来は市場モデルの残差を累積するが、ここでは条件自体が市場状態なので素のリターンを使う。</li>
          <li><strong>イベント窓</strong>: 平均を取る前後の期間。ここでは ±K日。</li>
          <li><strong>窓の重なり</strong>: イベントが5日おきに起きるのに窓が11日あると、隣のイベントの窓と同じ日を共有する。標本が独立でなくなり、素朴な標準誤差は狭くなりすぎる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          {"薬の効き目を測るのに似ている。投与した日（t=0）だけ熱が下がっても、翌日ぶり返すなら対症療法にすぎない。数日下がったままなら治療になっている。左側（投与前の経過）を見るのも同じ理由で、『そもそも熱が上がり続けていた人にだけ投与していた』のなら、下がったのは薬のせいではなく自然経過かもしれない。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>0の後も同じ向きに伸びる（持続）</strong>: 翌日以降も建玉を持つ価値がある。効果は情報の織り込み過程。</li>
          <li><strong>0の直後に戻る（巻き戻し）</strong>: 当日の動きは一時的な需給の歪み。大引けで必ず手仕舞う。逆張りの候補にもなる。</li>
          <li><strong>翌日以降のCIが0を跨ぐ</strong>: 持続とも巻き戻しとも言えない。既定の解釈はこれ（＝当日で完結）。</li>
          <li><strong>左側（−K〜−1）が既に大きく傾いている</strong>: その条件は特定の相場局面でしか出ていない。効果と見えたものが単なるトレンドの続きである可能性を疑う。</li>
          <li><strong>反転率が5割から大きく外れる</strong>: 平均だけでなく個々の日でも一貫している。平均が一部の大きな日に引っ張られていないかの確認になる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>手仕舞い時刻の決定: 巻き戻し型なら当日大引け、持続型なら+K日まで保有、という保有期間の根拠になる。</li>
          <li>当日の日中分析（曜日×米国ビンの日内パス）と併読する。日中で有意 かつ 翌日以降も持続、の条件だけが持ち越しに値する。</li>
          <li>左側の傾きを見て、その条件が「特定の相場局面の産物」でないかを確認してから採用する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"窓の重なりは完全には除けない。ブロックブートは相関を保存するが、ブロック長の選択(n^{1/3})は経験則にすぎない。"}</li>
          <li>{"曜日×ビンでイベントを絞ると1群あたり数十日規模になる。±10日の窓では実効的な独立標本はさらに少ない。"}</li>
          <li>{"市場モデルによる調整をしていないので、CARには市場全体のドリフト（右肩上がりの地合い）が乗っている。+側が全群で正に傾く場合はまずこれを疑う。"}</li>
          <li>{"曜日・ビン・K・指数・ビン基準の組合せを切り替えて有意なものを探す行為は多重検定になる。群横断のFDRは補正しているが、設定探索そのものは補正していない。"}</li>
          <li>{"配当落ちや株式分割の影響は調整済み終値に依存する。極端な外れ値日（決算・突発ニュース）が少数のイベントに紛れると平均が振られる。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
