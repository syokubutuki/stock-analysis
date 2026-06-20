"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useIntraday } from "../../hooks/useIntraday";
import {
  computeIntradayProfile, computeOpeningRange, computeWeekdayTimeProfile,
  ProfileResult, OpeningRangeResult, WeekdayTimeResult,
} from "../../lib/intraday-profile";
import {
  initCanvas, fmtPct, fmtSignedPct, IntervalButtons, ViewTabs, LoadingError,
  StatCell, drawTimeAxisLabels, IntradayCaveat,
} from "./intradayShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

type View = "profile" | "drift" | "or" | "weekday";
const VIEWS: { value: View; label: string }[] = [
  { value: "profile", label: "ボラ・出来高" },
  { value: "drift", label: "方向ドリフト" },
  { value: "or", label: "オープニングレンジ" },
  { value: "weekday", label: "曜日×時刻" },
];

const WD_NAMES: Record<number, string> = { 0: "日", 1: "月", 2: "火", 3: "水", 4: "木", 5: "金", 6: "土" };
const OR_OPTIONS = [15, 30, 60];

// ── 描画: ボラ・出来高プロファイル ──
function drawProfile(ctx: CanvasRenderingContext2D, W: number, H: number, p: ProfileResult) {
  const ml = 44, mr = 16, mt = 24, gap = 36;
  const plotW = W - ml - mr;
  const paneH = (H - mt - gap - 24) / 2;
  const n = p.bins.length;
  const slot = plotW / n;
  const barW = Math.max(2, slot * 0.7);

  const pane = (vals: number[], top: number, color: string, title: string, fmt: (v: number) => string) => {
    const maxV = Math.max(1e-9, ...vals);
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, top, plotW, paneH);
    ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(title, ml, top - 7);
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    ctx.fillText("0", ml - 5, top + paneH); ctx.fillText(fmt(maxV), ml - 5, top + 9);
    for (let i = 0; i < n; i++) {
      const h = (vals[i] / maxV) * (paneH - 6);
      const x = ml + i * slot + (slot - barW) / 2;
      ctx.fillStyle = color; ctx.fillRect(x, top + paneH - h, barW, h);
    }
  };
  pane(p.bins.map((b) => b.volumeShare), mt, "#0ea5e9cc", "出来高プロファイル（1日出来高に占める割合）", (v) => `${(v * 100).toFixed(0)}%`);
  pane(p.bins.map((b) => b.rangePct), mt + paneH + gap, "#f43f5ecc", "時間帯ボラ（平均値幅 (高-安)/始値 %）", (v) => `${v.toFixed(2)}%`);
  drawTimeAxisLabels(ctx, p.bins.map((b) => b.label), ml, slot, mt + paneH + gap + paneH + 12);
}

// ── 描画: 方向ドリフト（棒=各ビンμ, 線=累積） ──
function drawDrift(ctx: CanvasRenderingContext2D, W: number, H: number, p: ProfileResult) {
  const ml = 48, mr = 44, mt = 28, mb = 28;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const n = p.bins.length;
  const slot = plotW / n;
  const drifts = p.bins.map((b) => b.driftPct);
  const amax = Math.max(0.01, ...drifts.map(Math.abs));
  const ys = (v: number) => mt + plotH / 2 - (v / amax) * (plotH / 2 - 4);

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("時刻別の平均リターン（棒, 濃色=有意）と累積ドリフト（線）", ml, mt - 12);

  // 0ライン
  const y0 = ys(0);
  ctx.strokeStyle = "#9ca3af"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(ml, y0); ctx.lineTo(ml + plotW, y0); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(`+${amax.toFixed(3)}%`, ml - 4, mt + 9);
  ctx.fillText(`-${amax.toFixed(3)}%`, ml - 4, mt + plotH);

  const barW = Math.max(2, slot * 0.6);
  for (let i = 0; i < n; i++) {
    const v = drifts[i];
    const x = ml + i * slot + (slot - barW) / 2;
    const yv = ys(v);
    const up = v >= 0;
    const sig = p.bins[i].driftSignif;
    ctx.fillStyle = up ? (sig ? "#16a34a" : "#86efac") : (sig ? "#dc2626" : "#fca5a5");
    ctx.fillRect(x, Math.min(y0, yv), barW, Math.abs(yv - y0));
  }

  // 累積ドリフト（右軸）
  const cmax = Math.max(0.01, ...p.cumDriftPct.map(Math.abs));
  const yc = (v: number) => mt + plotH / 2 - (v / cmax) * (plotH / 2 - 4);
  ctx.strokeStyle = "#111827"; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = ml + i * slot + slot / 2;
    const y = yc(p.cumDriftPct[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = "#111827"; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`累積 ${p.cumDriftPct[n - 1] >= 0 ? "+" : ""}${p.cumDriftPct[n - 1].toFixed(2)}%`, ml + plotW + 4, mt + 12);

  drawTimeAxisLabels(ctx, p.bins.map((b) => b.label), ml, slot, mt + plotH + 14);
}

// ── 描画: 曜日×時刻ヒートマップ ──
function drawWeekdayHeat(ctx: CanvasRenderingContext2D, W: number, H: number, wt: WeekdayTimeResult) {
  const ml = 34, mr = 16, mt = 26, mb = 22;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const nRows = wt.weekdays.length;
  const nCols = wt.binLabels.length;
  const rowH = plotH / nRows;
  const cellW = plotW / nCols;

  // 色スケール（全セルの|drift|の95%点で正規化）
  const flat: number[] = [];
  for (const row of wt.grid) for (const c of row) if (c.n >= wt.minNHidden) flat.push(Math.abs(c.driftPct));
  flat.sort((a, b) => a - b);
  const scale = flat.length ? Math.max(1e-6, flat[Math.floor(flat.length * 0.95)]) : 1e-6;

  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("曜日×時刻の平均リターン（緑=上昇/赤=下落, 枠=FDR有意）", ml, mt - 12);

  for (let r = 0; r < nRows; r++) {
    const y = mt + r * rowH;
    for (let c = 0; c < nCols; c++) {
      const cell = wt.grid[r][c];
      const x = ml + c * cellW;
      if (cell.n < wt.minNHidden) {
        ctx.fillStyle = "#f3f4f6";
      } else {
        const t = Math.min(1, Math.abs(cell.driftPct) / scale);
        ctx.fillStyle = cell.driftPct >= 0
          ? `rgba(22,163,74,${0.1 + t * 0.85})`
          : `rgba(220,38,38,${0.1 + t * 0.85})`;
      }
      ctx.fillRect(x, y, cellW + 0.5, rowH - 1);
      if (cell.signif) {
        ctx.strokeStyle = "#111827"; ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 0.75, y + 0.75, cellW - 1.5, rowH - 2);
      }
    }
    ctx.fillStyle = "#374151"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(WD_NAMES[wt.weekdays[r]], ml - 3, y + rowH / 2 + 3);
  }
  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  drawTimeAxisLabels(ctx, wt.binLabels, ml, cellW, mt + plotH + 12);
}

export default function IntradayProfileChart({ ticker }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [intervalKey, setIntervalKey] = useState("5m");
  const [view, setView] = useState<View>("profile");
  const [orMin, setOrMin] = useState(30);
  const { resp, loading, error } = useIntraday(ticker, intervalKey);

  const binMinutes = intervalKey === "60m" ? 60 : 30;

  const profile = useMemo<ProfileResult | null>(
    () => (resp ? computeIntradayProfile(resp.bars, resp.gmtoffset, binMinutes) : null),
    [resp, binMinutes]
  );
  const orRes = useMemo<OpeningRangeResult | null>(
    () => (resp ? computeOpeningRange(resp.bars, resp.gmtoffset, orMin) : null),
    [resp, orMin]
  );
  const weekday = useMemo<WeekdayTimeResult | null>(
    () => (resp ? computeWeekdayTimeProfile(resp.bars, resp.gmtoffset, binMinutes) : null),
    [resp, binMinutes]
  );

  useEffect(() => {
    if (!canvasRef.current) return;
    if (view === "or") return;
    const H = view === "weekday" ? 320 : 360;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width } = init;
    if (view === "profile" && profile) drawProfile(ctx, width, H, profile);
    else if (view === "drift" && profile) drawDrift(ctx, width, H, profile);
    else if (view === "weekday" && weekday) drawWeekdayHeat(ctx, width, H, weekday);
  }, [view, profile, weekday]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">時間帯プロファイル（いつ動くか）</h3>
        <IntervalButtons value={intervalKey} onChange={setIntervalKey} />
      </div>
      <ViewTabs value={view} onChange={setView} views={VIEWS} />
      <LoadingError loading={loading} error={error} />

      {!loading && !error && profile && (
        <>
          <div className="text-xs text-gray-500">
            対象 {profile.nDays} 営業日 / {resp?.interval} 足 / {binMinutes}分ビン
            {resp?.timezone ? `（${resp.timezone}）` : ""}
          </div>

          {view !== "or" && <div className="relative"><canvas ref={canvasRef} /></div>}

          {view === "profile" && (
            <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
              {"上=時間帯ごとの平均出来高シェア、下=平均値幅。両者が膨らむ時間帯ほど約定しやすく動きやすい。一般に寄り・引けが高く昼が薄いU字。スリッページを避けたい執行は中間帯、勢いを取りたい順張りは高ボラ帯に置く。"}
            </p>
          )}

          {view === "drift" && (
            <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
              {"棒=各時間帯の平均リターン（濃色=FDR補正後も有意）、黒線=寄りからの累積ドリフト（平均的な1日の形）。特定の時間帯に有意なドリフトがあれば、その方向・時刻にエントリー/手仕舞いを寄せる根拠になる。"}
            </p>
          )}

          {view === "weekday" && weekday && (
            <>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 text-xs">
                {weekday.weekdays.map((w) => (
                  <StatCell key={w} label={`${WD_NAMES[w]}曜`} value={`${weekday.nDaysByWeekday[w]}日`} />
                ))}
              </div>
              <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
                {`緑=上昇/赤=下落の平均リターン、色の濃さ=大きさ。黒枠=多重比較(FDR)補正後も有意なセル。灰=サンプル不足(n<${weekday.minNHidden})。「金曜後場は弱い」等の曜日×時刻の癖を、見かけのパターンと統計的に有意なエッジに切り分けて読む。`}
              </p>
            </>
          )}

          {view === "or" && orRes && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">OR時間:</span>
                {OR_OPTIONS.map((m) => (
                  <button
                    key={m}
                    onClick={() => setOrMin(m)}
                    className={`px-2 py-0.5 text-xs rounded ${orMin === m ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                  >{m}分</button>
                ))}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <StatCell label="平均ORW（始値比）" value={`${orRes.meanOrWidthPct.toFixed(2)}%`} />
                <StatCell label="当日高値がOR内" value={fmtPct(orRes.highInOrShare)} />
                <StatCell label="当日安値がOR内" value={fmtPct(orRes.lowInOrShare)} />
                <StatCell label="ORブレイク後 1ORW到達" value={fmtPct(orRes.reach1R)} />
                <StatCell label="上抜け追随率" value={fmtPct(orRes.upFollowThrough)} tone="up" />
                <StatCell label="上抜け後 平均R" value={fmtSignedPct(orRes.expUpRetPct / 100)} tone={orRes.expUpRetPct >= 0 ? "up" : "down"} />
                <StatCell label="下抜け追随率" value={fmtPct(orRes.downFollowThrough)} tone="down" />
                <StatCell label="下抜け後 平均R" value={fmtSignedPct(orRes.expDownRetPct / 100)} tone={orRes.expDownRetPct >= 0 ? "up" : "down"} />
              </div>
              <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
                {`寄り後${orRes.orMinutes}分の高安(OR)を基準に、上下ブレイク後どれだけ引けまで追随したか（=だましでない割合, 上抜けn=${orRes.upBreakDays}/下抜けn=${orRes.downBreakDays}）。追随率が高ければORブレイク順張り、低ければだまし狙いの逆張りが向く。1ORW/2ORW到達率は利確目標設定の目安。`}
              </p>
            </div>
          )}

          <IntradayCaveat />
        </>
      )}

      <AnalysisGuide title="時間帯プロファイル分析の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"日中足を取引所ローカルの時刻ビンに畳み込み、複数営業日を横断して『いつボラ・出来高が高いか（約定しやすさ）』『いつ方向が偏るか（日内アノマリー）』『寄り直後のレンジ突破がどれだけ本物か』『曜日×時刻の複合エッジ』を測る。執行（エントリー/手仕舞い）の時刻を最適化することが目的。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ボラ</strong>: 各バーの値幅 (High−Low)/Open を時刻ビンで平均。出来高シェアは binVol/dayVol を日平均。</li>
          <li><strong>方向ドリフト</strong>: {"ビンbの平均 μ(b)=mean ln(C/O)。各ビンに1標本t検定→Benjamini-HochbergでFDR補正。累積 Cum(b)=Σ_{b'≤b} μ(b')。"}</li>
          <li><strong>オープニングレンジ</strong>: 寄り後k分の高値ORH・安値ORL・幅ORW=ORH−ORL。上抜け=後続バーでHigh&gt;ORH。追随率=上抜け日のうち引け&gt;ORHの割合。1ORW到達=ブレイク後にORW分だけ方向拡張した割合。</li>
          <li><strong>曜日×時刻</strong>: セル(曜日w, 時刻b)で ln(C/O) を集計→μ・t検定。全セルまとめてFDR補正、n&lt;閾値は非表示。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ドリフト</strong>: リターンの平均的な偏り（方向）。ボラ（振れ幅）とは別物で、符号を持つ。</li>
          <li><strong>FDR（偽発見率）</strong>: 多数のビン/セルを同時に検定すると偶然の「有意」が混ざる。これを抑えるBenjamini-Hochberg補正後のp値で判定する。</li>
          <li><strong>追随（フォロースルー）</strong>: ブレイク後にその方向へ引けまで続くこと。だまし（戻る）の対義。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>出来高・ボラがU字（寄り引け高）なら、寄り引けはスリッページ大。指値は中間帯が有利。</li>
          <li>方向ドリフトで前場に有意なプラスがあれば「寄り買い→前場利確」が噛み合う。</li>
          <li>OR追随率が高い銘柄はブレイク順張り、低い銘柄は逆張りが向く。</li>
          <li>曜日×時刻ヒートで黒枠（FDR有意）のセルだけを実エッジとして扱う。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>約定タイミング: 流動性の高い時間に分割発注しコストを抑える。</li>
          <li>日計りの方向: 有意なドリフト時間帯にエントリー/手仕舞いを合わせる。</li>
          <li>OR戦略: 追随率と1ORW/2ORW到達率からエントリー条件と利確目標を設計。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"5/15/30分足は約60日（約40営業日）しかなく、曜日別では曜日あたり約8日。FDR・最小n閾値で過剰解釈を防いでいるが、断定は禁物。"}</li>
          <li>{"Yahoo日中足は約15分遅延。リアルタイム執行の判断には遅延を考慮すること。"}</li>
          <li>{"東証は前場/後場の2セッション。昼休みのビンは欠損として平均から外れる。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
