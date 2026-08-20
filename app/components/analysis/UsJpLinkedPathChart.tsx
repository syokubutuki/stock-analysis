"use client";

// 前夜米国の「日中経路」→ 当日日本の「日内経路」を連結して見る。
//
// 既存のスピルオーバー分析は前夜の米国を終値の1点(±何%)に潰している。この分析は米国指数の
// 日中足も取得し、経路そのもの(一本調子か・引け際に伸びたか・往って来いか)で層別して、
// 当日の日本の日内パスがどう変わるかを見る。左に米国セッション、右に当日の日本を並べ、
// 同じ縦軸(対数リターン)の上で1つの物語として読む。
//
// 計算は lib/us-jp-linked-path.ts。ここは配線と描画のみ。

import { useEffect, useMemo, useRef, useState } from "react";
import { useIntraday } from "../../hooks/useIntraday";
import { US_DRIVERS } from "../../hooks/useUsDaily";
import { groupByDay, buildBinGrid } from "../../lib/intraday-core";
import { BinScheme } from "../../lib/us-spillover-core";
import {
  buildUsSessionPaths, linkJpUs, buildLinkGroups, computeLinkedPaths, incrementalShapeTest,
  LinkedResult, LinkedDay, LinkGroupMode, LINK_GROUP_MODES, LinkTarget, LINK_TARGETS, UsSessionPath,
} from "../../lib/us-jp-linked-path";
import { WD_LABELS } from "../../lib/today-vs-expected";
import { intervalToMin, UsDriverButtons, BinSchemeButtons } from "./usSpilloverShared";
import {
  initCanvas, IntervalButtons, LoadingError, IntradayCaveat, fmtSignedPct, fmtPct, drawTimeAxisLabels,
} from "./intradayShared";
import {
  PathCanvas, PathLegend, PairDiffMatrix, usePathEvolution, PathEvolutionControls, PathDriftTable,
} from "./intradayPathShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";
import { CHART_COLORS } from "../../lib/chart-colors";

interface Props { ticker: string; }

const WD_FILTERS: { value: number; label: string }[] = [
  { value: 0, label: "全曜日" },
  { value: 1, label: "月" }, { value: 2, label: "火" }, { value: 3, label: "水" },
  { value: 4, label: "木" }, { value: 5, label: "金" },
];

// ───────────────────────── 米国セッションの平均経路 ─────────────────────────

function drawUsPaths(
  ctx: CanvasRenderingContext2D, W: number, H: number, r: LinkedResult,
  todayPath: number[] | null, groupFilter: string | null
) {
  const ml = 46, mr = 10, mt = 10, mb = 20;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const G = r.usLabels.length;
  if (G < 2) return;
  let yMax = r.maxAbsUs;
  if (todayPath) for (const v of todayPath) yMax = Math.max(yMax, Math.abs(v));
  yMax *= 1.1;
  const X = (g: number) => ml + (g / (G - 1)) * plotW;
  const Y = (v: number) => mt + (1 - (v + yMax) / (2 * yMax)) * plotH;

  ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 1;
  for (let k = 0; k <= 3; k++) { const y = mt + (k / 3) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();

  ctx.fillStyle = CHART_COLORS.ink; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(fmtSignedPct(yMax, 1), ml - 3, mt + 8);
  ctx.fillText("0", ml - 3, Y(0) + 3);
  ctx.fillText(fmtSignedPct(-yMax, 1), ml - 3, mt + plotH);

  ctx.save();
  ctx.beginPath(); ctx.rect(ml, mt, plotW, plotH); ctx.clip();
  for (const g of r.groups) {
    if (g.idxs.length === 0) continue;
    if (groupFilter != null && g.key !== groupFilter) continue;
    ctx.strokeStyle = g.color; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < G; i++) { const x = X(i), y = Y(g.usMean[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  }
  if (todayPath) {
    ctx.strokeStyle = "#111827"; ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < Math.min(G, todayPath.length); i++) { const x = X(i), y = Y(todayPath[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  }
  ctx.restore();

  drawTimeAxisLabels(ctx, r.usLabels, ml, plotW / G, H - 6);
}

// ───────────────────────── 本体 ─────────────────────────

export default function UsJpLinkedPathChart({ ticker }: Props) {
  const [usTicker, setUsTicker] = useState("^IXIC");
  const [interval, setInterval] = useState("60m");
  const [mode, setMode] = useState<LinkGroupMode>("shape");
  const [scheme, setScheme] = useState<BinScheme>("tercile");
  const [wdFilter, setWdFilter] = useState(0);
  const [target, setTarget] = useState<LinkTarget>("intra");
  const [showBand, setShowBand] = useState(true);
  const [showMedian, setShowMedian] = useState(false);

  const jp = useIntraday(ticker, interval);
  const us = useIntraday(usTicker, interval);
  const usCanvasRef = useRef<HTMLCanvasElement>(null);

  // JP・US双方の日中足を営業日にまとめ、前夜整合して連結行を作る。
  const built = useMemo(() => {
    if (!jp.resp || !us.resp || jp.resp.bars.length === 0 || us.resp.bars.length === 0) return null;
    const bin = intervalToMin(interval);
    const jpDays = groupByDay(jp.resp.bars, jp.resp.gmtoffset);
    const jpGrid = buildBinGrid(jp.resp.bars, jp.resp.gmtoffset, bin);
    const usDays = groupByDay(us.resp.bars, us.resp.gmtoffset);
    const usGrid = buildBinGrid(us.resp.bars, us.resp.gmtoffset, bin);
    if (!jpGrid || !usGrid) return null;
    const usPaths = buildUsSessionPaths(usDays, usGrid, us.resp.gmtoffset);
    const rows = linkJpUs(jpDays, usPaths);
    if (rows.length < 20) return null;
    // 「今夜の米国」= 最後にペアが成立したJP立会日より新しい米国セッション(まだ日本が寄っていない)
    const lastJp = rows[rows.length - 1].jp.date;
    const unpaired = usPaths.filter((u) => u.date >= lastJp);
    const latestUs: UsSessionPath | null = unpaired.length ? unpaired[unpaired.length - 1] : null;
    return { rows, jpGrid, usGrid, jpGmt: jp.resp.gmtoffset, latestUs };
  }, [jp.resp, us.resp, interval]);

  const rows: LinkedDay[] = useMemo(
    () => (built ? built.rows.filter((r) => wdFilter === 0 || r.jp.weekday === wdFilter) : []),
    [built, wdFilter]
  );

  const result: LinkedResult | null = useMemo(() => {
    if (!built || rows.length < 10) return null;
    const grouping = buildLinkGroups(rows, mode, scheme, built.latestUs, built.usGrid.bins.length);
    if (!grouping) return null;
    return computeLinkedPaths(rows, grouping, built.usGrid, built.jpGrid, built.jpGmt);
  }, [built, rows, mode, scheme]);

  const inc = useMemo(() => (rows.length ? incrementalShapeTest(rows, target) : null), [rows, target]);
  const evo = usePathEvolution(result?.jpStats);

  useEffect(() => {
    if (!result || !usCanvasRef.current) return;
    const init = initCanvas(usCanvasRef.current, 170);
    if (init) drawUsPaths(init.ctx, init.width, init.height, result, result.todayUs?.path ?? null, evo.groupFilter);
  }, [result, evo.groupFilter]);

  const loading = jp.loading || us.loading;
  const error = jp.error || (us.error ? `米国指数の日中足: ${us.error}` : null);
  const usLabel = US_DRIVERS.find((d) => d.ticker === usTicker)?.label ?? usTicker;
  const modeMeta = LINK_GROUP_MODES.find((m) => m.value === mode)!;
  const targetMeta = LINK_TARGETS.find((t) => t.value === target)!;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">前夜米国の日中経路 → 当日日本：連続パス</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <UsDriverButtons value={usTicker} onChange={setUsTicker} />
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">層別:</span>
          {LINK_GROUP_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setMode(m.value)}
              title={m.note}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                mode === m.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >{m.label}</button>
          ))}
        </div>
        {mode !== "shape" && <BinSchemeButtons value={scheme} onChange={setScheme} />}
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">曜日:</span>
          {WD_FILTERS.map((w) => (
            <button
              key={w.value}
              onClick={() => setWdFilter(w.value)}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                wdFilter === w.value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >{w.label}</button>
          ))}
        </div>
      </div>

      <LoadingError loading={loading} error={error} />
      {!loading && !error && !result && (
        <div className="text-xs text-fg-muted">
          連結できる立会日が不足しています（60分足を選ぶ／曜日の絞り込みを外す）。米国指数の日中足が取得できない場合もあります。
        </div>
      )}

      {result && (
        <>
          {result.todayUs && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
              <span className="inline-block mr-1 px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 text-[10px] font-bold align-middle">寄り前</span>
              <span className="font-bold">今夜の{usLabel}（{result.todayUs.date}）: 日中 {fmtSignedPct(result.todayUs.intra)}／終盤1/3 {fmtSignedPct(result.todayUs.finish)}／経路効率 {fmtPct(result.todayUs.efficiency, 0)}</span>
              {result.todayGroup != null && result.groups[result.todayGroup] && (
                <> → <span className="font-bold">{result.groups[result.todayGroup].label}</span> 型（下の黒線が今夜の経路）</>
              )}
            </div>
          )}

          <div className="text-xs text-gray-600">
            <span className="font-medium text-gray-700">層別:</span>{" "}
            <span className="text-gray-500">{modeMeta.note}。連結 {result.n} 日{wdFilter ? `（${WD_LABELS[wdFilter]}のみ）` : ""}。</span>
          </div>

          <PathLegend stats={result.jpStats} />

          <div className="space-y-1">
            <div className="text-xs font-medium text-gray-700">① 前夜の米国セッション（米国の寄り＝0）</div>
            <div className="relative"><canvas ref={usCanvasRef} /></div>
          </div>

          <div className="space-y-1">
            <div className="text-xs font-medium text-gray-700">② 当日の日本（日本の寄り＝0）</div>
            <div className="flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-1 text-xs text-gray-600">
                <input type="checkbox" checked={showBand} onChange={(e) => setShowBand(e.target.checked)} />
                95%帯
              </label>
              <label className="flex items-center gap-1 text-xs text-gray-600">
                <input type="checkbox" checked={showMedian} onChange={(e) => setShowMedian(e.target.checked)} />
                中央値パス（破線）
              </label>
            </div>
            <PathEvolutionControls stats={result.jpStats} evo={evo} />
            <PathCanvas
              stats={result.jpStats}
              timeLabels={result.jpLabels}
              maxAbs={result.maxAbsJp}
              opts={{
                showBand, showMedian,
                showSpaghetti: evo.showSpaghetti, showEras: evo.showEras, groupFilter: evo.groupFilter,
              }}
            />
          </div>

          <p className="text-[11px] text-gray-500">
            {"上下で基準が違う点に注意。上は米国指数の当日寄り基準、下は日本銘柄の当日寄り基準で、別々の資産なので水準を跨いで足し算はできない。読み方は「上の形の違いが、下の形の違いに繋がっているか」。夜間ギャップ(米国を寄り付きでどれだけ織り込んだか)は下表に別掲する。"}
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">米国の経路タイプ</th>
                  <th className="text-right px-2">日数</th>
                  <th className="text-left px-2">米国側の特徴</th>
                  <th className="text-right px-2">JP夜間ギャップ平均</th>
                  <th className="text-right px-2">JP寄り→引け平均</th>
                  <th className="text-center px-2">ピーク時刻</th>
                  <th className="text-left px-2">日中の有意性</th>
                </tr>
              </thead>
              <tbody>
                {result.groups.map((g, i) => {
                  const s = result.jpStats[i];
                  if (!s || s.n === 0) return null;
                  return (
                    <tr key={g.key} className="border-b border-gray-100">
                      <td className="py-1 px-2">
                        <span className="inline-flex items-center gap-1">
                          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: g.color }} />
                          <span className="text-gray-700">{g.label}</span>
                          {result.todayGroup === i && <span className="text-blue-600 text-[10px]">◀今夜</span>}
                        </span>
                      </td>
                      <td className="text-right px-2 text-gray-600">{s.n}</td>
                      <td className="px-2 text-gray-500 text-[11px]">{g.desc}</td>
                      <td className={`text-right px-2 tabular-nums ${result.gapMeans[i] >= 0 ? "text-green-700" : "text-red-600"}`}>{fmtSignedPct(result.gapMeans[i])}</td>
                      <td className={`text-right px-2 font-medium tabular-nums ${s.endMean >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(s.endMean)}</td>
                      <td className="text-center px-2 text-gray-600">{result.jpLabels[s.peakIdx] ?? "-"}</td>
                      <td className="px-2"><StatBadge n={s.n} p={s.endP} significant={s.endP < 0.05} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <PairDiffMatrix stats={result.jpStats} pairDiffs={result.pairDiffs} />
          <PathDriftTable stats={result.jpStats} timeLabels={result.jpLabels} />

          {/* 増分F検定: 終値の1点で説明できる分を除いて、経路の形に説明力が残っているか */}
          <div className="space-y-2 pt-3 border-t border-gray-100">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-xs font-medium text-gray-700">③ 経路の形は「終値の1点」を超えた説明力を持つか（増分F検定）</div>
              <div className="flex items-center gap-1 flex-wrap text-xs">
                <span className="text-gray-500">目的変数:</span>
                {LINK_TARGETS.map((t) => (
                  <button
                    key={t.value}
                    onClick={() => setTarget(t.value)}
                    title={t.note}
                    className={`px-2 py-0.5 rounded font-medium transition-colors ${
                      target === t.value ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}
                  >{t.label}</button>
                ))}
              </div>
            </div>

            {inc ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">終値の1点だけ R²</div>
                    <div className="font-bold text-gray-800">{fmtPct(inc.r2Base, 2)}</div>
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">＋経路の形 R²</div>
                    <div className="font-bold text-gray-800">{fmtPct(inc.r2Full, 2)}</div>
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">増分 ΔR²</div>
                    <div className={`font-bold ${inc.p < 0.05 ? "text-green-700" : "text-gray-800"}`}>{fmtPct(inc.dR2, 2)}</div>
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">増分F（q={inc.q}）</div>
                    <div className="font-bold text-gray-800">{inc.f.toFixed(2)}</div>
                    <div className="text-[10px] text-fg-muted">p = {inc.p.toFixed(4)}</div>
                  </div>
                </div>

                <div className={`rounded-md px-3 py-2 text-xs ${
                  inc.p < 0.05 ? "bg-green-50 text-green-900 border border-green-200" : "bg-gray-50 text-gray-700 border border-gray-200"
                }`}>
                  {inc.p < 0.05
                    ? `${targetMeta.label}は、前夜米国の終値だけでは説明しきれない。経路の形（終盤の勢い・日中の最大/最小）に追加の説明力がある（p=${inc.p.toFixed(4)}）＝「同じ+2%」を形で区別する価値がある。`
                    : `${targetMeta.label}に対して、経路の形は終値の1点を超える説明力を持たない（p=${inc.p.toFixed(3)}）。前夜米国はスカラー1つに潰して構わない、という従来の扱いが支持される。`}
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-200">
                        <th className="text-left py-1 px-2">説明変数</th>
                        <th className="text-right px-2">係数</th>
                        <th className="text-right px-2">t値</th>
                        <th className="text-right px-2">p値</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inc.coefs.map((c) => (
                        <tr key={c.name} className="border-b border-gray-100">
                          <td className="py-1 px-2 text-gray-700">{c.name}</td>
                          <td className="text-right px-2 tabular-nums text-gray-800">{c.beta.toFixed(4)}</td>
                          <td className="text-right px-2 tabular-nums text-gray-600">{c.t.toFixed(2)}</td>
                          <td className={`text-right px-2 tabular-nums ${c.p < 0.05 ? "font-bold text-gray-900" : "text-gray-500"}`}>{c.p.toFixed(3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[10px] text-fg-muted">
                  {"係数は対数リターン単位（説明変数が1（=100%）動いたときの目的変数の変化）。標準誤差は等分散を仮定した通常のOLS。"}
                </p>
              </>
            ) : (
              <div className="text-xs text-fg-muted">増分F検定には40日以上必要です。</div>
            )}
          </div>
        </>
      )}

      <IntradayCaveat extra="米国指数の日中足も同じ制約を受ける（60分足で約2年）。米国と日本の両方の日中足が揃った日だけが対象になるため、日数は単独の分析より少なくなる。" />

      <AnalysisGuide title="米国→日本 連続パスの詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"前夜の米国を「終値が何%動いたか」の1点に潰すのが従来のスピルオーバー分析だった。しかし日本が寄り付く時点で確定しているのは数字1つではなく、米国セッションの経路そのものである。同じ+2%でも、寄りから一本調子で上げて高値引けした日と、下げていて引け際30分で急伸した日、朝高で失速して結局+2%の日では、残っている勢いが違う。この分析は米国指数の日中足を取得して経路を作り、その形で層別したうえで、当日の日本の日内パスを並べて描く。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"米国経路: u(t) = ln(P^US_t / O^US)（米国の寄り基準の累積対数リターン）。時間格子は日本側と同じ足種で作る。"}</li>
          <li>{"形の特徴量: 終盤の勢い f = ln(C/P_{2/3})、日中最大 max_t u(t)、日中最小 min_t u(t)、経路効率 e = |u(T)| / Σ_t|u(t)−u(t−1)|（1に近いほど一本調子）、逆行 a = 終値方向と逆向きの最大到達。"}</li>
          <li>{"日本側: ギャップ g = ln(O/C_prev)、日内 r(t) = ln(P_t/O)、当日 = g + r(T)。対数なので加法。"}</li>
          <li>{"経路クラスタ: 各米国経路を z 化 z(u) = (u − mean(u))/sd(u) し、k-means(k=3) で3類型に分ける。初期値は終端値の分位で決め、群番号は終端平均の昇順に振り直す（実行ごとに色の意味が変わらないようにする）。"}</li>
          <li>{"増分F検定: 基準モデル y = a + b₁·r^US_(前日終値比) + b₂·r^US_(日中)、完全モデル = 基準 + b₃·f + b₄·max + b₅·min。"}<br />
            {"F = ((SSE_base − SSE_full)/q) / (SSE_full/(n−p_full))、q=3。P(F>f) は不完全ベータ関数 I_{d₂/(d₂+d₁f)}(d₂/2, d₁/2) で求める。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>経路効率</strong>: 終点までの距離を、実際に歩いた道のりで割った値。1なら一直線、0.2なら行ったり来たりしながら結局少し動いた、という意味。</li>
          <li><strong>終盤1/3の勢い</strong>: 米国セッションの最後の1/3のリターン。引け際のポジション調整や翌日への持ち越し意欲を反映する。</li>
          <li><strong>k-means</strong>: 似た形どうしを3つのグループに自動で分ける手法。各グループの「代表的な形」（重心）との距離が最小になるように振り分ける。</li>
          <li><strong>増分F検定</strong>: 説明変数を追加してR²が上がったとき、その上昇が偶然の範囲かを判定する検定。変数を増やせばR²は必ず上がるので、上がり幅を自由度で割って評価する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          {"リレーのバトンパスに似ている。前走者(米国)がゴールした位置(終値)だけでなく、加速しながら渡したのか、失速しながら渡したのかで、次走者(日本)の走り出しは変わる。従来の分析は「何m進んだか」しか見ていなかった。ここでは前走者の走り方そのものを見る。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>上の米国経路が違うのに下の日本パスが重なる</strong>: 日本は米国の「終値」しか見ていない。形で条件付ける意味は無い。</li>
          <li><strong>同じ終値水準でも「引け強」型の翌日だけ日中が伸びる</strong>: 勢いの持ち越しがある。寄り付きで買い、日中を取る戦略の候補。</li>
          <li><strong>ギャップ平均は同じなのに日中平均が違う</strong>: 寄り付きでは形を織り込めておらず、ザラ場で織り込みが進んでいる＝寄り後に取れる余地。</li>
          <li><strong>③のp値が0.05未満</strong>: 経路の形は終値では代替できない情報を持つ。ここが本分析の存在意義そのもの。</li>
          <li><strong>③のp値が大きい</strong>: 形は追加情報を持たない。上の絵の違いは目の錯覚か、標本の偶然。従来の終値ビンで十分。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>③が有意なときだけ、寄り前に米国の「形」を見て当日の日中戦略（継続か逆張りか）を切り替える。有意でないなら終値ビンの判断に戻す。</li>
          <li>今夜の米国が属する型（上部バナー）を確認し、その型の日本側パスのピーク時刻を執行時刻の目安にする。</li>
          <li>ギャップ平均と日中平均を分けて読み、「寄りで織り込み済み＝日中は取れない」型を避ける。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"米国と日本の両方の日中足が必要で、60分足でも約2年。3類型に分けると1型あたり150日前後、曜日を絞ると30日規模まで落ちる。"}</li>
          <li>{"上下のパネルは基準が別（米国の寄り／日本の寄り）。同じ縦軸に見えるが水準を跨いで足し算してはいけない。銘柄と指数ではボラの絶対水準も違う。"}</li>
          <li>{"k-meansのクラスタ数3は恣意的。データが本当に3つの型を持つ保証はない（どんなデータでも3つに分かれてしまう）。"}</li>
          <li>{"増分F検定は等分散・独立を仮定した通常のOLS標準誤差を使っている。ボラのクラスタリングがあるため、p値はやや楽観的に出る傾向がある。"}</li>
          <li>{"層別モード・曜日・目的変数を切り替えて有意なものを探す行為は多重検定になる。ここでは補正していないので、p=0.03程度の単発は割り引いて読むこと。"}</li>
          <li>{"米国指数の日中足はYahooの配信で、時間帯によっては最終バーが未確定のことがある。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
