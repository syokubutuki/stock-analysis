"use client";

import { DirectionGlyph } from "./DirectionValue";

// 参加の価値（床）の銘柄横断比較 ── 系C24 の横断版。
//
// ParticipationPremiumChart が「市場代理1本の床」を測るのに対し、ここでは
// ウォッチリスト全銘柄に computeParticipation を適用し、各銘柄の床を
//   実現プレミアム μ−r ± SE・t値・片側p / g・シャープ・最大DD / 床が負の窓率
// で横並びにして「ソートして見比べる」。市場代理の床を基準線として重ね、
// 各銘柄の床が市場の床を上回るか（＝生存者バイアスに注意しつつ）を可視化する。
//
// 重要: 個別銘柄のドリフト差を過去実績で選ぶのは生存者バイアスで危うい（C24解説）。
// この表は「選ぶ根拠」ではなく「床の不確かさ（SE=σ/√T の壁）を横断で体感する」ためのもの。

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  computeParticipation,
  type ParticipationResult,
} from "../../lib/participation-premium";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";
import { CHART_COLORS } from "../../lib/chart-colors";

interface Props {
  tickers: string[];
  pricesByTicker: Record<string, PricePoint[]>;
  names?: Record<string, string>;
}

// 市場代理プリセット（ParticipationPremiumChart と同一の考え方）。
const PROXY_PRESETS: { id: string; label: string }[] = [
  { id: "1321", label: "日経225 ETF (1321・分配金込み)" },
  { id: "^N225", label: "日経225 指数（配当抜き）" },
  { id: "^GSPC", label: "S&P500 指数（米国）" },
];

const HOLD_OPTIONS: { days: number; label: string }[] = [
  { days: 252, label: "1年" },
  { days: 756, label: "3年" },
  { days: 1260, label: "5年" },
];

const pct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;

// ── ソート ──────────────────────────────────────────────────────────────────
type SortKey =
  | "name" | "premium" | "se" | "t" | "p" | "g" | "sharpe" | "mdd" | "shareNeg" | "years";

const COLUMNS: { key: SortKey; label: string; dir: "asc" | "desc"; hint: string }[] = [
  { key: "name", label: "銘柄", dir: "asc", hint: "コード / 名称" },
  { key: "premium", label: "プレミアム", dir: "desc", hint: "実現プレミアム μ−r（年率）＝床の高さ" },
  { key: "se", label: "±SE", dir: "asc", hint: "年率ドリフトの標準誤差 σ/√T（小さいほど確か）" },
  { key: "t", label: "t値", dir: "desc", hint: "premium/SE。>1.645 で床が片側5%有意" },
  { key: "p", label: "片側p", dir: "asc", hint: "床>0 の片側p値（小さいほど確か）" },
  { key: "g", label: "g", dir: "desc", hint: "時間平均成長率（C21・実際に生きる成長）" },
  { key: "sharpe", label: "Sharpe", dir: "desc", hint: "リスク調整後（rf=0）" },
  { key: "mdd", label: "最大DD", dir: "desc", hint: "床を得る対価の谷（0に近いほど浅い）" },
  { key: "shareNeg", label: "床<0窓%", dir: "asc", hint: "スイープで床が負になった窓の割合" },
  { key: "years", label: "年数", dir: "desc", hint: "観測年数（T が長いほど床が確か）" },
];

interface CrossRow {
  ticker: string;
  name: string;
  r: ParticipationResult;
}

function sortVal(row: CrossRow, key: SortKey): number | string {
  const p = row.r.premium;
  const m = row.r.participation;
  const s = row.r.sweep;
  switch (key) {
    case "name": return row.name;
    case "premium": return p.premium;
    case "se": return p.seAnnual;
    case "t": return p.tValue;
    case "p": return p.pValueOneSided;
    case "g": return m.growthRate;
    case "sharpe": return m.sharpe;
    case "mdd": return m.maxDrawdown;
    case "shareNeg": return s.shareNegative;
    case "years": return p.years;
  }
}

function Stat({
  label, value, tone, sub,
}: { label: string; value: string; tone?: "good" | "bad" | "neutral"; sub?: string }) {
  const c = tone === "good" ? "text-green-700" : tone === "bad" ? "text-red-700" : "text-gray-800";
  return (
    <div className="rounded border border-gray-200 px-2.5 py-1.5">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`text-sm font-bold font-mono ${c}`}>{value}</div>
      {sub && <div className="text-[10px] text-fg-muted">{sub}</div>}
    </div>
  );
}

export default function ParticipationCrossChart({ tickers, pricesByTicker, names }: Props) {
  const [rfPct, setRfPct] = useState("0");
  const [holdDays, setHoldDays] = useState(252);
  const [sortKey, setSortKey] = useState<SortKey>("t");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // 市場代理（床の基準線）を自前取得。
  const [proxy, setProxy] = useState("1321");
  const [proxyPrices, setProxyPrices] = useState<PricePoint[]>([]);
  const [proxyName, setProxyName] = useState("");
  const [proxyLoading, setProxyLoading] = useState(false);

  useEffect(() => {
    if (!proxy) return;
    let cancelled = false;
    const run = async () => {
      setProxyLoading(true);
      try {
        const res = await fetch(`/api/stock?ticker=${encodeURIComponent(proxy)}&range=10y`);
        const json = await res.json();
        if (cancelled) return;
        if (res.ok && json.prices?.length) {
          setProxyPrices(json.prices as PricePoint[]);
          setProxyName(json.name || proxy);
        } else {
          setProxyPrices([]);
        }
      } catch {
        if (!cancelled) setProxyPrices([]);
      } finally {
        if (!cancelled) setProxyLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [proxy]);

  const holdLabel = useMemo(
    () => HOLD_OPTIONS.find((h) => h.days === holdDays)?.label ?? `${holdDays}日`,
    [holdDays]
  );
  const rf = useMemo(() => (parseFloat(rfPct) || 0) / 100, [rfPct]);

  // 各銘柄の床を実測。純関数・軽量なのでメインスレッドで useMemo（Worker不要）。
  const rows = useMemo<CrossRow[]>(() => {
    const out: CrossRow[] = [];
    for (const tk of tickers) {
      const prices = pricesByTicker[tk];
      if (!prices || prices.length === 0) continue;
      const r = computeParticipation(prices, { rf, holdDays, holdLabel });
      if (!r) continue;
      out.push({ ticker: tk, name: names?.[tk] || tk, r });
    }
    return out;
  }, [tickers, pricesByTicker, names, rf, holdDays, holdLabel]);

  // 市場の床（基準）。
  const marketResult = useMemo<ParticipationResult | null>(() => {
    if (proxyPrices.length === 0) return null;
    return computeParticipation(proxyPrices, { rf, holdDays, holdLabel });
  }, [proxyPrices, rf, holdDays, holdLabel]);
  const marketPremium = marketResult?.premium.premium ?? 0;

  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      const va = sortVal(a, sortKey);
      const vb = sortVal(b, sortKey);
      if (typeof va === "string" && typeof vb === "string") {
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return sortDir === "asc"
        ? (va as number) - (vb as number)
        : (vb as number) - (va as number);
    });
    return arr;
  }, [rows, sortKey, sortDir]);

  const onSort = (key: SortKey, dir: "asc" | "desc") => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(dir); }
  };

  // 横断サマリ。
  const summary = useMemo(() => {
    const n = rows.length;
    const positive = rows.filter((x) => x.r.premium.premium > 0).length;
    const significant = rows.filter((x) => x.r.premium.significant).length;
    const aboveMarket = marketResult
      ? rows.filter((x) => x.r.premium.premium > marketPremium).length
      : 0;
    return { n, positive, significant, aboveMarket };
  }, [rows, marketResult, marketPremium]);

  // ── プレミアム±SE の横断棒（横軸=リターン値なので Canvas2D） ──────────────
  const barCanvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = barCanvas.current;
    if (!canvas) return;
    drawPremiumBars(canvas, sorted, marketResult ? marketPremium : null, marketResult ? (proxyName || proxy) : "");
  }, [sorted, marketResult, marketPremium, proxyName, proxy]);

  const hasData = tickers.length > 0;

  return (
    <div className="space-y-4">
      {/* コントロール */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-gray-500">
          無リスク金利(年率%)
          <input
            type="number"
            value={rfPct}
            onChange={(e) => setRfPct(e.target.value)}
            step="0.1"
            className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm w-20 tabular-nums"
          />
        </label>
        <label className="flex flex-col text-xs text-gray-500">
          床&lt;0窓の保有
          <div className="mt-0.5 flex gap-1 bg-gray-100 rounded p-0.5">
            {HOLD_OPTIONS.map((h) => (
              <button
                key={h.days}
                onClick={() => setHoldDays(h.days)}
                className={`px-2 py-0.5 text-xs rounded ${
                  holdDays === h.days ? "bg-white text-blue-600 shadow-sm" : "text-gray-500"
                }`}
              >
                {h.label}
              </button>
            ))}
          </div>
        </label>
        <label className="flex flex-col text-xs text-gray-500">
          市場の床（基準）
          <select
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            className="mt-0.5 px-2 py-1 border border-gray-300 rounded text-sm"
          >
            {PROXY_PRESETS.map((pr) => (
              <option key={pr.id} value={pr.id}>{pr.label}</option>
            ))}
          </select>
        </label>
        {proxyLoading && <span className="text-xs text-fg-muted">基準取得中…</span>}
      </div>

      {!hasData && (
        <div className="py-8 text-center text-fg-muted text-sm">
          ウォッチリストに銘柄がありません。
        </div>
      )}

      {hasData && rows.length === 0 && (
        <div className="py-8 text-center text-fg-muted text-sm">
          床の実測に十分な履歴（約1年以上の日足）がある銘柄がありません。
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/* 横断サマリ */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="対象銘柄" value={`${summary.n}`} sub="床を実測できた数" />
            <Stat
              label="床が正(μ−r>0)"
              value={`${summary.positive}/${summary.n}`}
              tone={summary.positive > summary.n / 2 ? "good" : "neutral"}
            />
            <Stat
              label="床が有意(t>1.645)"
              value={`${summary.significant}/${summary.n}`}
              tone={summary.significant > 0 ? "good" : "neutral"}
              sub="片側5%"
            />
            <Stat
              label="市場の床を上回る"
              value={marketResult ? `${summary.aboveMarket}/${summary.n}` : "—"}
              sub={marketResult ? `基準 ${pct(marketPremium)}（${proxyName || proxy}）` : "基準未取得"}
            />
          </div>

          {/* プレミアム±SE 棒グラフ */}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1.5">
              各銘柄の床（実現プレミアム ± SE・現在の並び順）
            </div>
            <canvas ref={barCanvas} className="w-full" />
            <p className="mt-1 text-[11px] text-gray-500">
              バー＝実現プレミアム μ−r（年率）、ひげ＝±SE。緑=正・濃緑=t&gt;1.645で有意、赤=負。
              {marketResult && <>青破線＝市場の床（{pct(marketPremium)}）。</>}
              SE が premium より大きい（ひげが0をまたぐ）銘柄は、床が正とは言い切れない。
            </p>
          </div>

          {/* ソート可能テーブル */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-gray-300">
                  {COLUMNS.map((col) => {
                    const active = sortKey === col.key;
                    return (
                      <th
                        key={col.key}
                        title={col.hint}
                        onClick={() => onSort(col.key, col.dir)}
                        className={`px-2 py-1.5 cursor-pointer select-none whitespace-nowrap ${
                          col.key === "name" ? "text-left" : "text-right"
                        } ${active ? "text-blue-600" : "text-gray-500 hover:text-gray-800"}`}
                      >
                        {col.label}
                        <span className="ml-0.5 inline-block w-2">
                          {active ? (sortDir === "asc" ? "▲" : "▼") : ""}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => {
                  const p = row.r.premium;
                  const m = row.r.participation;
                  const s = row.r.sweep;
                  const above = marketResult && p.premium > marketPremium;
                  return (
                    <tr
                      key={row.ticker}
                      className="border-b border-gray-100 hover:bg-gray-50"
                    >
                      <td className="px-2 py-1 text-left">
                        <span className="font-mono text-gray-800">{row.ticker}</span>
                        {row.name && row.name !== row.ticker && (
                          <span className="ml-1 text-fg-muted">{row.name}</span>
                        )}
                      </td>
                      <td className={`px-2 py-1 text-right font-mono font-semibold ${
                        p.premium >= 0 ? "text-green-700" : "text-red-700"
                      }`}>
                      <DirectionGlyph value={p.premium} />{pct(p.premium)}
                        {above && <span className="ml-0.5 text-blue-500" title="市場の床を上回る">▲</span>}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-gray-500">
                        ±{(p.seAnnual * 100).toFixed(1)}%
                      </td>
                      <td className={`px-2 py-1 text-right font-mono ${
                        p.significant ? "text-green-700 font-semibold" : "text-gray-700"
                      }`}>
                        {p.tValue.toFixed(2)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-gray-500">
                        {p.pValueOneSided.toFixed(3)}
                      </td>
                      <td className={`px-2 py-1 text-right font-mono ${
                        m.growthRate >= 0 ? "text-gray-800" : "text-red-700"
                      }`}>
                        {pct(m.growthRate)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-gray-700">
                        {m.sharpe.toFixed(2)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-red-700">
                        {pct(m.maxDrawdown)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-gray-600">
                        {(s.shareNegative * 100).toFixed(0)}%
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-gray-500">
                        {p.years.toFixed(1)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-500">
            列見出しクリックで並べ替え。既定は t値降順（＝床が確かな順）。個別銘柄の床を
            過去実績で選ぶのは生存者バイアスで危うい（→解説5）。この表は「選ぶ根拠」ではなく
            床の不確かさ（SE=σ/√T の壁）を横断で体感するためのもの。
          </p>

          <ParticipationCrossGuide />
          <AxiomPlacement corollaryId="C24" />
        </>
      )}
    </div>
  );
}

// ── Canvas2D：プレミアム±SE の横断棒（横軸=リターン値。CLAUDE.md の initCanvas パターン） ──
function drawPremiumBars(
  canvas: HTMLCanvasElement,
  rows: CrossRow[],
  marketPremium: number | null,
  marketLabel: string
) {
  const parent = canvas.parentElement;
  if (!parent) return;
  const width = parent.clientWidth;
  const rowH = 22;
  const padT = 8;
  const padB = 28;
  const padL = 118;
  const padR = 14;
  const height = padT + padB + Math.max(1, rows.length) * rowH;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);

  if (rows.length === 0) return;

  const plotW = width - padL - padR;

  // 定義域（全銘柄の premium±SE と 市場の床 と 0 を包む）。
  let lo = 0;
  let hi = 0;
  for (const row of rows) {
    const p = row.r.premium;
    lo = Math.min(lo, p.premium - p.seAnnual);
    hi = Math.max(hi, p.premium + p.seAnnual);
  }
  if (marketPremium !== null) {
    lo = Math.min(lo, marketPremium);
    hi = Math.max(hi, marketPremium);
  }
  const spanPad = (hi - lo || 0.1) * 0.05;
  lo -= spanPad;
  hi += spanPad;
  const range = hi - lo || 1;
  const xOf = (v: number) => padL + ((v - lo) / range) * plotW;

  // ゼロ線。
  const zx = xOf(0);
  ctx.strokeStyle = CHART_COLORS.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(zx, padT);
  ctx.lineTo(zx, padT + rows.length * rowH);
  ctx.stroke();

  // 市場の床（基準線）。
  if (marketPremium !== null) {
    const mx = xOf(marketPremium);
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(mx, padT);
    ctx.lineTo(mx, padT + rows.length * rowH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.font = "11px sans-serif";
  ctx.textBaseline = "middle";

  rows.forEach((row, i) => {
    const p = row.r.premium;
    const cy = padT + i * rowH + rowH / 2;

    // ラベル（左）。
    ctx.fillStyle = "#374151";
    ctx.textAlign = "right";
    const label = row.name && row.name !== row.ticker ? row.name : row.ticker;
    const clipped = label.length > 9 ? label.slice(0, 8) + "…" : label;
    ctx.fillText(clipped, padL - 6, cy);

    // バー（0→premium）。
    const x0 = zx;
    const x1 = xOf(p.premium);
    const barTop = cy - 5;
    const barH = 10;
    ctx.fillStyle = p.premium < 0
      ? "#f87171"
      : p.significant
      ? "#15803d"
      : "#86efac";
    ctx.fillRect(Math.min(x0, x1), barTop, Math.abs(x1 - x0), barH);

    // ±SE ひげ。
    const lx = xOf(p.premium - p.seAnnual);
    const rx = xOf(p.premium + p.seAnnual);
    ctx.strokeStyle = "#6b7280";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx, cy);
    ctx.lineTo(rx, cy);
    ctx.moveTo(lx, cy - 3);
    ctx.lineTo(lx, cy + 3);
    ctx.moveTo(rx, cy - 3);
    ctx.lineTo(rx, cy + 3);
    ctx.stroke();

    // 値ラベル（バー端）。
    ctx.fillStyle = "#4b5563";
    ctx.font = "10px sans-serif";
    if (p.premium >= 0) {
      ctx.textAlign = "left";
      ctx.fillText(pct(p.premium), rx + 3, cy);
    } else {
      ctx.textAlign = "right";
      ctx.fillText(pct(p.premium), lx - 3, cy);
    }
    ctx.font = "11px sans-serif";
  });

  // x軸ラベル（下端）。
  ctx.fillStyle = CHART_COLORS.ink;
  ctx.font = "10px sans-serif";
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText(`${(lo * 100).toFixed(0)}%`, padL, height - 8);
  ctx.textAlign = "center";
  ctx.fillText("0%", zx, height - 8);
  ctx.textAlign = "right";
  ctx.fillText(`${(hi * 100).toFixed(0)}%`, width - padR, height - 8);
  if (marketPremium !== null) {
    const mx = xOf(marketPremium);
    ctx.fillStyle = "#2563eb";
    ctx.textAlign = "center";
    const lbl = `市場の床${marketLabel ? `(${marketLabel})` : ""}`;
    ctx.fillText(lbl, Math.min(Math.max(mx, padL + 40), width - padR - 40), height - 20);
  }
}

// ── 解説（CLAUDE.md 規約: AnalysisGuide 必須） ───────────────────────────────
function ParticipationCrossGuide() {
  return (
    <AnalysisGuide title="床の銘柄横断比較の詳細理論">
      <p className="font-medium text-gray-700">1. 何を比較しているか</p>
      <p>
        「参加の価値（株式リスクプレミアムという床）」＝居るだけで受け取るドリフト μ−r を、
        ウォッチリストの各銘柄について実測し、横並びに<b>ソートして見比べる</b>。単一の市場代理で
        床を測る C24 の基本パネルに対し、こちらは<b>横断で床の高さと不確かさを比較</b>する。
        市場代理の床を基準線として重ね、各銘柄の床がそれを上回るかを可視化する。
      </p>

      <p className="font-medium text-gray-700 mt-3">2. 数式（列の定義）</p>
      <p>{"実現プレミアム（床）= μ̂_annual − r,  μ̂_annual = mean(日次r)×252"}</p>
      <p>{"標準誤差 SE = σ_annual/√T = 252·s_daily/√N,  t = (μ̂_annual − r)/SE"}</p>
      <p>{"g（時間平均成長率）= mean(log(1+r))×252,  Sharpe = (μ̂/σ̂)×√252"}</p>
      <p>{"床<0窓% = スイープ（保有h日・overlapping窓）で年率リターンが負になった窓の割合"}</p>

      <p className="font-medium text-gray-700 mt-3">3. 用語</p>
      <ul className="list-disc pl-4 space-y-1">
        <li><b>床</b>：タイミング/サイジングのエッジが無いとき損益に残る「参加項」＝実現プレミアム。</li>
        <li><b>SE（標準誤差）</b>：ドリフト推定のばらつき。σ/√T ゆえ<b>期間 T でしか縮まない</b>。</li>
        <li><b>t値</b>：床が0からSE何個分離れているか。&gt;1.645 で片側5%有意（床が正と言える）。</li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
      <p>
        床＝各銘柄の「地面の高さ」、SE＝「霧の濃さ」。プレミアムが高く見えても霧（ひげ）が
        0をまたぐなら、その高さは測定誤差かもしれない。t値は「霧を突き抜けて地面が見えるか」の尺度。
      </p>

      <p className="font-medium text-gray-700 mt-3">5. 結果の読み方・投資判断への活用</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>既定は<b>t値降順</b>＝床が確かな順。プレミアムの絶対値ではなく「確からしさ」で並べるのが誠実。</li>
        <li>棒グラフで<b>ひげ（±SE）が0をまたぐ</b>銘柄は、床が正とは言い切れない（見かけの高さ）。</li>
        <li>「床&lt;0窓%」が高い銘柄は、単一の入口では床が負にもなる＝入口タイミング依存が強い。</li>
        <li>「市場の床を上回る（▲）」銘柄が多くても、それは<b>過去の実現値</b>。次段の底上げ検証は
          C25（対象選択チルト）へ。</li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">6. 注意点・限界（重要）</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>
          <b>個別銘柄のドリフト差を過去実績で選ぶのは生存者バイアスで危うい</b>。上位に来た銘柄は
          「たまたま良かった過去」を含む。この表は<b>選ぶ根拠ではなく、床の不確かさを体感する</b>もの。
        </li>
        <li>10年程度の標本では、市場プレミアムでさえ t が有意化しにくい（SE=σ/√T の壁）。個別銘柄は
          さらにボラが高く SE が大きい＝t は小さくなりがち。</li>
        <li>「床が負の窓」% はスイープが overlapping 窓のため各点は独立でない（分布形状の把握用）。</li>
        <li>過去の実現プレミアムは将来の期待の不偏推定ではない（レジーム・バリュエーション依存）。</li>
      </ul>
    </AnalysisGuide>
  );
}
