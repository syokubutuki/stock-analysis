"use client";

// あなたのポートフォリオの「相関が食べた分」 ── docs/correlation-growth-drag-visualization.md Phase 1
//
// 「相関を無視してリターンを追う」＝ 長期成長率（幾何平均リターン）を削る操作、
// であることを実データで一目で示す。構成は仕様書 §10.5 Phase 1 のとおり:
//
//   G2 ウォーターフォール（期待 → −単独ドラッグ → −相関ドラッグ → 実際の成長率）
//   U5 隠れレバレッジカード（実質何銘柄／√(N/N_eff)／ボラティリティ税の倍率）
//   T1 1銘柄ずつ足していく台帳（期待は伸び続け、g は沈む）
//   S3 倍化年数への翻訳（%ではなく「2倍になるまで何年」で見せる）
//
// 既存資産の再利用: alignReturns（portfolio-risk.ts）で共通日付整列、建玉ウェイトの
// 抽出は PortfolioRiskPanel と同一ロジック。計算は純関数・O(N²) でメインスレッド useMemo。

import { useEffect, useMemo, useRef, useState } from "react";
import { PortfolioData } from "../../hooks/usePortfolioData";
import { WatchlistItem, effectiveKind } from "../../lib/watchlist";
import { Horizon, HORIZON_CONFIG } from "../../lib/signal-digest";
import { alignReturns, portfolioRisk, type RiskComponent } from "../../lib/portfolio-risk";
import {
  annualStats,
  decomposeDrag,
  doublingYearsLabel as yearsLabel,
  incrementalLedger,
  orderByCorrelation,
  varianceConcentration,
  EMPTY_DECOMP,
  type DragDecomp,
  type LedgerMode,
  type LedgerRow,
  type VarianceConcentration,
} from "../../lib/growth-drag";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  data: PortfolioData;
  watchlist: WatchlistItem[];
  horizon: Horizon;
}

type WeightSource = "held" | "equal";

const pct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
const pctAbs = (v: number, d = 1) => `${(Math.abs(v) * 100).toFixed(d)}%`;

// 倍化年数の表示（「永遠に来ない」＝ g ≤ 0・仕様書 §S3）は growth-drag.ts の
// doublingYearsLabel に集約した。doublingYears() が Infinity を返す契約と一対のため。

function manYen(v: number): string {
  const m = v / 10000;
  if (Math.abs(m) >= 1000) return `${(m / 10000).toFixed(2)}億円`;
  return `${m.toFixed(1)}万円`;
}

export default function YourPortfolioDragPanel({ data, watchlist, horizon }: Props) {
  // 建玉が無いユーザーでも意味を持つように、等ウェイトへ切り替えられる（仕様書 §10.2）。
  const [source, setSource] = useState<WeightSource>("held");
  const [ledgerMode, setLedgerMode] = useState<LedgerMode>("add");
  // 総建玉 W（現金を含む資産に対する株式の比率）。100% がフル現物、200% が信用2倍。
  // 3項分解の期待項は W に比例、ドラッグ項は W の二乗で効く（仕様書 §1）。
  const [exposure, setExposure] = useState(1);

  const base = useMemo(() => {
    const series = Object.entries(data)
      .filter(([, v]) => v.prices.length > 2)
      .map(([ticker, v]) => ({ ticker, prices: v.prices }));
    const names: Record<string, string> = {};
    for (const [t, v] of Object.entries(data)) names[t] = v.name || t;

    const aligned = alignReturns(series, HORIZON_CONFIG[horizon].window);

    // 建玉（保有・株数>0）の時価。PortfolioRiskPanel と同一の抽出ロジック。
    const rawWeights: Record<string, number> = {};
    for (const item of watchlist) {
      if (effectiveKind(item) !== "held") continue;
      const pos = item.position;
      const last = data[item.ticker]?.prices.at(-1)?.close;
      if (pos && pos.shares > 0 && last) rawWeights[item.ticker] = pos.shares * last;
    }
    const heldTickers = aligned.tickers.filter((t) => (rawWeights[t] ?? 0) > 0);
    const totalMV = heldTickers.reduce((s, t) => s + rawWeights[t], 0);

    return { aligned, names, rawWeights, heldTickers, totalMV };
  }, [data, watchlist, horizon]);

  const { aligned, names, rawWeights, heldTickers, totalMV } = base;
  const hasHeld = heldTickers.length >= 2;
  // 建玉が2銘柄未満なら自動的に等ウェイトへ倒す（表示が空になるのを避ける）。
  const effSource: WeightSource = source === "held" && hasHeld ? "held" : "equal";

  // ── 構成比（合計1）。総建玉 W はこの上に掛ける ────────────────────────
  const shares: number[] = useMemo(() => {
    const n = aligned.tickers.length;
    const w = new Array(n).fill(0);
    if (n === 0) return w;
    if (effSource === "held") {
      aligned.tickers.forEach((t, i) => {
        const mv = rawWeights[t] ?? 0;
        w[i] = totalMV > 0 ? mv / totalMV : 0;
      });
    } else {
      for (let i = 0; i < n; i++) w[i] = 1 / n;
    }
    return w;
  }, [aligned, effSource, rawWeights, totalMV]);

  // ── 3項分解（G2 / U5 / S3 の共通の元） ────────────────────────────────
  const decomp: DragDecomp = useMemo(() => {
    if (aligned.tickers.length < 2) return EMPTY_DECOMP;
    const st = annualStats(aligned);
    return decomposeDrag(st.mu, st.cov, shares.map((s) => s * exposure));
  }, [aligned, shares, exposure]);

  // 円換算の基準額。建玉があればその評価額、無ければ100万円を仮の投下資金とする。
  const capital = effSource === "held" && totalMV > 0 ? totalMV : 1_000_000;
  const capitalIsReal = effSource === "held" && totalMV > 0;

  // ── T1 台帳 ────────────────────────────────────────────────────────────
  const ledger: LedgerRow[] = useMemo(() => {
    if (aligned.tickers.length < 2) return [];
    const universe = effSource === "held" ? heldTickers : aligned.tickers;
    if (universe.length < 2) return [];
    // 建玉モードなら最大の建玉を起点に、そこから「似た銘柄」を足していく。
    let seed: string | undefined;
    if (effSource === "held") {
      seed = [...universe].sort((a, b) => (rawWeights[b] ?? 0) - (rawWeights[a] ?? 0))[0];
    }
    const order = orderByCorrelation(aligned, universe, seed);
    return incrementalLedger(aligned, order, ledgerMode, names, undefined, exposure);
  }, [aligned, effSource, heldTickers, rawWeights, ledgerMode, names, exposure]);

  // ── T3 分割 vs 追加（総建玉スライダーとは独立の定義比較） ──────────────
  const splitAdd = useMemo(() => {
    if (aligned.tickers.length < 2) return null;
    const st = annualStats(aligned);
    const active: number[] = shares.map((s) => (s > 1e-12 ? 1 : 0));
    const n = active.reduce((a, b) => a + b, 0);
    if (n < 2) return null;
    const split = decomposeDrag(st.mu, st.cov, active.map((a) => a / n));
    const add = decomposeDrag(st.mu, st.cov, active);
    // 出発点＝構成比が最大の1銘柄に全額を集中させた場合。
    // 「分割で σ_p が下がる／追加で上がる」は、この1銘柄を基準にした比較。
    let top = -1;
    for (let i = 0; i < active.length; i++) {
      if (active[i] && (top < 0 || shares[i] > shares[top])) top = i;
    }
    const solo = decomposeDrag(st.mu, st.cov, active.map((_, i) => (i === top ? 1 : 0)));
    return { split, add, solo, n, soloTicker: top >= 0 ? aligned.tickers[top] : "" };
  }, [aligned, shares]);

  // ── G5 リスクの二つの顔（配分 / PCTR / 主成分） ────────────────────────
  const faces = useMemo(() => {
    if (aligned.tickers.length < 2) return null;
    // PCTR は既存 portfolio-risk.ts の実装をそのまま流用する（仕様書 §G5）。
    // 等ウェイト表示のときは各銘柄の時価が等しい仮想の建玉を渡す。
    const rw: Record<string, number> = {};
    aligned.tickers.forEach((t, i) => {
      if (shares[i] > 1e-12) rw[t] = shares[i];
    });
    const risk = portfolioRisk(aligned, rw);
    if (!risk.ok || risk.components.length < 2) return null;

    const st = annualStats(aligned);
    const idx = aligned.tickers
      .map((t, i) => (shares[i] > 1e-12 ? i : -1))
      .filter((i) => i >= 0);
    const R = idx.map((a) => idx.map((b) => st.corr[a][b]));
    const pc: VarianceConcentration = varianceConcentration(R, 3);
    return { components: risk.components, pc };
  }, [aligned, shares]);

  // ── G2 ウォーターフォール（横軸=リターン値の静的図なので Canvas2D） ──────
  const wfCanvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = wfCanvas.current;
    if (!canvas || !decomp.ok) return;
    const draw = () => drawWaterfall(canvas, decomp, capital);
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [decomp, capital]);

  // ── G5 リスクの二つの顔（円グラフ3枚・静的図なので Canvas2D） ────────────
  const facesCanvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = facesCanvas.current;
    if (!canvas || !faces) return;
    const draw = () => drawTwoFaces(canvas, faces.components, faces.pc, names);
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [faces, names]);

  if (aligned.tickers.length < 2) {
    return (
      <div className="py-8 text-center text-gray-400 text-sm">
        共通日付で整列できる銘柄が2つ以上必要です（ウォッチリストに銘柄を追加してください）。
      </div>
    );
  }

  const corrShare =
    decomp.soloDrag + decomp.corrDrag > 1e-9
      ? decomp.corrDrag / (decomp.soloDrag + decomp.corrDrag)
      : 0;

  // 「相関のせいで2倍になるのが何年遅れるか」。両方が有限のときだけ年数で言える
  // （g≤0 側は Infinity になるので、そのときは年数ではなく「永遠に来ない」と言う）。
  const delayYears =
    isFinite(decomp.doublingYearsNoCorr) && isFinite(decomp.doublingYears)
      ? decomp.doublingYears - decomp.doublingYearsNoCorr
      : null;

  return (
    <div className="space-y-5">
      {/* コントロール */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-gray-500">
          ウェイトの取り方
          <div className="mt-0.5 flex gap-1 bg-gray-100 rounded p-0.5">
            <button
              onClick={() => setSource("held")}
              disabled={!hasHeld}
              className={`px-2 py-0.5 text-xs rounded ${
                effSource === "held" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500"
              } ${!hasHeld ? "opacity-40 cursor-not-allowed" : ""}`}
            >
              建玉ベース
            </button>
            <button
              onClick={() => setSource("equal")}
              className={`px-2 py-0.5 text-xs rounded ${
                effSource === "equal" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500"
              }`}
            >
              ウォッチリスト等ウェイト
            </button>
          </div>
        </label>
        {/* 総建玉 W: 期待は W に比例、ドラッグは W の二乗（仕様書 §1） */}
        <label className="flex flex-col text-xs text-gray-500">
          総建玉（資産に対する株式の比率）
          <span className="mt-0.5 flex items-center gap-2">
            <input
              type="range"
              min={0.05}
              max={3}
              step={0.05}
              value={exposure}
              onChange={(e) => setExposure(Number(e.target.value))}
              className="w-40 accent-gray-700"
            />
            <span className="w-12 text-right tabular-nums font-semibold text-gray-700">
              {(exposure * 100).toFixed(0)}%
            </span>
            {exposure !== 1 && (
              <button
                onClick={() => setExposure(1)}
                className="text-[10px] text-blue-600 underline"
              >
                100%に戻す
              </button>
            )}
          </span>
        </label>

        <div className="text-[11px] text-gray-400 pb-1">
          {effSource === "held"
            ? `建玉${decomp.nAssets}銘柄・評価額 ¥${Math.round(totalMV).toLocaleString()}`
            : `全${decomp.nAssets}銘柄を等ウェイト（仮の投下資金100万円で円換算）`}
          {" / "}
          直近{HORIZON_CONFIG[horizon].window}本・年率換算
          {exposure !== 1 &&
            ` / 総建玉${(exposure * 100).toFixed(0)}%として計算（構成比はそのまま）`}
          {!hasHeld && source === "held" && " / 建玉が2銘柄未満のため等ウェイト表示"}
        </div>
      </div>

      {/* ── U5 隠れレバレッジカード ─────────────────────────────────────── */}
      {/* 見出しは日常の言葉で言い切り、記号（N_eff・√(N/N_eff)・ρ）は各数字の真下に
          小さく併記する。専門語を消すのではなく、**入口に置かない**のが方針。 */}
      <div className="rounded-lg border-2 border-red-200 bg-red-50 p-4">
        <div className="text-sm font-bold text-gray-800">
          {decomp.nAssets} 銘柄に分けたつもりが、実際は{" "}
          <span className="text-red-700 tabular-nums text-lg">{decomp.nEff.toFixed(1)} 銘柄</span>{" "}
          ぶんにしか分かれていません
        </div>
        <div className="mt-2.5 flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <div className="text-[10px] text-gray-500">
              {decomp.nAssets}銘柄が、本当に分かれている数
            </div>
            <div className="text-3xl font-bold text-red-700 tabular-nums">
              {decomp.nEff.toFixed(1)} <span className="text-lg">銘柄ぶん</span>
            </div>
            <div className="text-[10px] text-gray-400">実効銘柄数 N_eff</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500">
              値動きの荒さで取られる目減りの倍率
            </div>
            <div className="text-3xl font-bold text-red-700 tabular-nums">
              {decomp.taxMultiple.toFixed(1)} <span className="text-lg">倍</span>
            </div>
            <div className="text-[10px] text-gray-400">ボラティリティ税の倍率 N / N_eff</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500">2倍になるのが遅れる年数</div>
            <div className="text-3xl font-bold text-red-700 tabular-nums">
              {delayYears != null ? (
                <>
                  +{delayYears.toFixed(1)} <span className="text-lg">年</span>
                </>
              ) : isFinite(decomp.doublingYearsNoCorr) ? (
                <span className="text-xl">永遠に来ない</span>
              ) : (
                <span className="text-xl text-gray-400">—</span>
              )}
            </div>
            <div className="text-[10px] text-gray-400">
              倍化年数 ln2/g の差（相関ゼロとの比較）
            </div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500">思っていたリスクの何倍を負っているか</div>
            <div className="text-2xl font-bold text-gray-700 tabular-nums">
              {decomp.hiddenLev.toFixed(2)} <span className="text-base">倍</span>
            </div>
            <div className="text-[10px] text-gray-400">隠れレバレッジ √(N/N_eff)</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500">銘柄どうしの「似かた」の平均</div>
            <div className="text-2xl font-bold text-gray-700 tabular-nums">
              {decomp.avgCorr.toFixed(2)}
            </div>
            <div className="text-[10px] text-gray-400">平均相関 ρ</div>
          </div>
        </div>

        {/* 銘柄アイコン: N 個のうち N_eff 個分だけが点灯する */}
        <div className="mt-3 flex flex-wrap gap-1">
          {Array.from({ length: Math.min(decomp.nAssets, 40) }, (_, i) => {
            const fill = Math.max(0, Math.min(1, decomp.nEff - i));
            return (
              <div
                key={i}
                className="relative w-5 h-5 rounded-sm bg-gray-300 overflow-hidden"
                title={`${i + 1}銘柄目（実効 ${(fill * 100).toFixed(0)}%）`}
              >
                <div
                  className="absolute inset-y-0 left-0 bg-red-500"
                  style={{ width: `${fill * 100}%` }}
                />
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-gray-700">
          四角は {decomp.nAssets} 銘柄。<strong>赤く塗られているぶんだけが本当に分かれています</strong>。
          灰色は「分散しているつもりだったのに、消えている」ぶんです。
          値動きの荒さだけで毎年取られる目減りが、ちゃんと分かれていた場合の{" "}
          <strong className="text-red-700 text-base tabular-nums">
            {decomp.taxMultiple.toFixed(1)} 倍
          </strong>{" "}
          になっている、ということです。
          <span className="text-gray-500">
            （専門用語では<strong>ボラティリティ税</strong>が N / N_eff = {decomp.nAssets} /{" "}
            {decomp.nEff.toFixed(1)} 倍）
          </span>
          {delayYears != null && (
            <>
              {" "}同じ期待リターンのまま、資産が2倍になるのが{" "}
              <strong>{yearsLabel(decomp.doublingYearsNoCorr)}</strong> から{" "}
              <strong className="text-red-700">{yearsLabel(decomp.doublingYears)}</strong>{" "}
              へ延びています。
            </>
          )}
        </p>
      </div>

      {/* ── G2 ウォーターフォール ───────────────────────────────────────── */}
      <div>
        <div className="text-xs font-semibold text-gray-700 mb-1.5">
          期待リターンは、どこへ消えたのか（年率・3項分解）
        </div>
        <canvas ref={wfCanvas} className="w-full" />
        <p className="mt-1 text-[11px] text-gray-500">
          青＝期待リターン（見かけ） / 灰＝単独ドラッグ（分散しても残る分） /{" "}
          <strong className="text-red-600">赤＝相関ドラッグ（相関を無視した代償）</strong> /
          緑＝実際に増える速さ。
          {corrShare > 0 && (
            <>
              {" "}ドラッグ全体のうち <strong>{(corrShare * 100).toFixed(0)}%</strong> が相関由来。
            </>
          )}
          {capitalIsReal
            ? ` 円は総資産 ${manYen(totalMV)}（＝総建玉100%のときの株式時価）に対する年額。`
            : " 円は仮の総資産100万円に対する年額。"}
        </p>
      </div>

      {/* ── S3 倍化年数への翻訳 ─────────────────────────────────────────── */}
      <div>
        <div className="text-xs font-semibold text-gray-700 mb-1.5">
          「2倍になるまで何年か」への翻訳
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-300 text-gray-500">
                <th className="text-left py-1 px-2 font-medium">シナリオ</th>
                <th className="text-right py-1 px-2 font-medium">期待リターン</th>
                <th className="text-right py-1 px-2 font-medium">ドラッグ</th>
                <th className="text-right py-1 px-2 font-medium">実質成長率 g</th>
                <th className="text-right py-1 px-2 font-medium">資産が2倍になるまで</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="py-1.5 px-2 text-gray-700">もし相関がゼロだったら</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{pct(decomp.expected)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-gray-500">
                  −{pctAbs(decomp.soloDrag)}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums font-semibold text-green-700">
                  {pct(decomp.growthNoCorr)}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums font-semibold text-green-700">
                  {yearsLabel(decomp.doublingYearsNoCorr)}
                </td>
              </tr>
              <tr className="bg-red-50">
                <td className="py-1.5 px-2 text-gray-800 font-medium">今のあなた（実測の相関）</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{pct(decomp.expected)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-red-600">
                  −{pctAbs(decomp.soloDrag + decomp.corrDrag)}
                </td>
                <td
                  className={`py-1.5 px-2 text-right tabular-nums font-semibold ${
                    decomp.growth > 0 ? "text-gray-800" : "text-red-700"
                  }`}
                >
                  {pct(decomp.growth)}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums font-bold text-red-700">
                  {yearsLabel(decomp.doublingYears)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          期待リターンは<strong>2行とも同じ</strong>です。変わったのは相関だけ。それでも
          {isFinite(decomp.doublingYearsNoCorr) && isFinite(decomp.doublingYears) ? (
            <>
              {" "}2倍になるまでが <strong>{yearsLabel(decomp.doublingYearsNoCorr)}</strong> から{" "}
              <strong className="text-red-700">{yearsLabel(decomp.doublingYears)}</strong> に延びました。
            </>
          ) : (
            <> 倍化までの時間が大きく変わります。</>
          )}
        </p>
      </div>

      {/* ── T1 1銘柄ずつ足していく台帳 ──────────────────────────────────── */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
          <div className="text-xs font-semibold text-gray-700">
            1銘柄ずつ足していく台帳（相関の高い順＝「似た銘柄をどんどん買う」の再現）
          </div>
          <div className="flex gap-1 bg-gray-100 rounded p-0.5">
            <button
              onClick={() => setLedgerMode("add")}
              className={`px-2 py-0.5 text-xs rounded ${
                ledgerMode === "add" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500"
              }`}
            >
              追加（各銘柄に同額を張り足す）
            </button>
            <button
              onClick={() => setLedgerMode("split")}
              className={`px-2 py-0.5 text-xs rounded ${
                ledgerMode === "split" ? "bg-white text-blue-600 shadow-sm" : "text-gray-500"
              }`}
            >
              分割（同じ資金をN分割）
            </button>
          </div>
        </div>
        <p className="text-[11px] text-gray-500 mb-2">
          {ledgerMode === "add" ? (
            <>
              <strong>前提</strong>: 1銘柄あたり同じ金額を張り続ける（＝現金を減らす／信用を使う）。
              総建玉は銘柄数ぶんに膨らみます。これが「分散投資したつもりが、実際はレバレッジを掛けていただけ」の正体です。
            </>
          ) : (
            <>
              <strong>前提</strong>: 同じ資金を N 分割する（総建玉は常に100%）。
              こちらは本物の分散で、相関が1未満なら成長率は必ず改善します。上の「追加」と見比べてください。
            </>
          )}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-300 text-gray-500">
                <th className="text-left py-1 px-2 font-medium">追加</th>
                <th className="text-right py-1 px-2 font-medium" title="追加前のバスケットとの相関">
                  既存との相関
                </th>
                <th className="text-right py-1 px-2 font-medium">総建玉</th>
                <th className="text-right py-1 px-2 font-medium">期待リターン</th>
                <th className="text-right py-1 px-2 font-medium">σ_p</th>
                <th className="text-right py-1 px-2 font-medium">ドラッグ</th>
                <th className="text-right py-1 px-2 font-medium">実質成長率 g</th>
                <th className="text-right py-1 px-2 font-medium">2倍まで</th>
                <th className="text-right py-1 px-2 font-medium">N_eff</th>
                <th className="text-right py-1 px-2 font-medium">隠れレバ</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((r, i) => {
                const prev = i > 0 ? ledger[i - 1] : null;
                const expUp = prev ? r.expected > prev.expected + 1e-9 : false;
                const gDown = prev ? r.growth < prev.growth - 1e-9 : false;
                return (
                  <tr
                    key={r.ticker}
                    className={`border-b border-gray-100 ${r.isPeak ? "bg-amber-50" : ""}`}
                  >
                    <td className="py-1.5 px-2 whitespace-nowrap">
                      <span className="text-gray-400">{i + 1}.</span>{" "}
                      <span className="text-gray-800">{r.ticker}</span>{" "}
                      <span className="text-gray-400">{r.name}</span>
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-gray-600">
                      {isNaN(r.corrToPrev) ? "—" : r.corrToPrev.toFixed(2)}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-gray-500">
                      {(r.exposure * 100).toFixed(0)}%
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-blue-700">
                      {pct(r.expected)} {expUp && <span className="text-green-600">↑</span>}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-gray-600">
                      {pctAbs(r.sigmaP)}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-red-600">
                      −{pctAbs(r.drag)}
                    </td>
                    <td
                      className={`py-1.5 px-2 text-right tabular-nums font-semibold ${
                        r.growth > 0 ? "text-gray-800" : "text-red-700"
                      }`}
                    >
                      {pct(r.growth)} {gDown && <span className="text-red-600">↓</span>}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-gray-600">
                      {yearsLabel(r.doublingYears)}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-gray-600">
                      {r.nEff.toFixed(2)}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-gray-600">
                      {r.hiddenLev.toFixed(2)}×
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {ledger.length > 0 && (
          <p className="mt-1 text-[11px] text-gray-500">
            黄色の行＝成長率が最大になった地点（{ledger.findIndex((r) => r.isPeak) + 1}銘柄目）。
            {ledger.findIndex((r) => r.isPeak) < ledger.length - 1 ? (
              <strong className="text-amber-700">
                {" "}ここから先は、足すほど遅くなります。
              </strong>
            ) : (
              <> この標本ではまだ折り返していません。</>
            )}
            {" "}期待リターンの列（青）は伸び続けるのに、成長率の列が沈んでいく——同じ行の中で矢印が逆を向くのが、この分析の主題です。
          </p>
        )}
      </div>

      {/* ── G5 リスクの二つの顔 ─────────────────────────────────────────── */}
      {faces && (
        <div>
          <div className="text-xs font-semibold text-gray-700 mb-1.5">
            リスクの二つの顔：見た目の分散と、本当の分散
          </div>
          <canvas ref={facesCanvas} className="w-full" />
          <p className="mt-1 text-[11px] text-gray-500">
            左＝お金の配り方（見た目の分散）。中＝<strong>リスク寄与率 PCTR</strong>
            （そのリスクを誰が作っているか）。右＝主成分の寄与率（値動きの型がいくつあるか）。
            {(() => {
              // 「配分とリスクのズレ」が最も大きい銘柄を名指しする。
              // 上位N銘柄の合計だと両者がほぼ一致してしまい、ズレが見えないことがある。
              let top = faces.components[0];
              for (const c of faces.components) {
                if (c.pctr - c.weight > top.pctr - top.weight) top = c;
              }
              const gap = top.pctr - top.weight;
              if (gap < 0.03) {
                return (
                  <>
                    {" "}この2枚はほぼ同じ形＝
                    <strong>お金の配り方どおりのリスク配分</strong>になっています
                    （最大のズレでも{(gap * 100).toFixed(1)}ポイント）。
                  </>
                );
              }
              return (
                <>
                  {" "}
                  <strong>{top.ticker}</strong> はお金では
                  <strong>{(top.weight * 100).toFixed(0)}%</strong>なのに、
                  <strong className="text-red-600">
                    リスクでは{(top.pctr * 100).toFixed(0)}%
                  </strong>
                  を作っています（+{(gap * 100).toFixed(0)}ポイント）。
                </>
              );
            })()}{" "}
            そして値動きの{" "}
            <strong className="text-red-600">
              {(faces.pc.pc1 * 100).toFixed(0)}%
            </strong>{" "}
            が第1主成分（＝全銘柄に共通の1つの波）で説明できます。
            {faces.pc.pc1 > 0.5 && (
              <strong> あなたのポートフォリオは、実質1つの賭けです。</strong>
            )}
          </p>
        </div>
      )}

      {/* ── T3 分割 vs 追加 ──────────────────────────────────────────────── */}
      {splitAdd && (
        <div>
          <div className="text-xs font-semibold text-gray-700 mb-1.5">
            分割 vs 追加：同じ「{splitAdd.n}銘柄に分散」でも、正体が違う
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-gray-300 text-gray-500">
                  <th className="text-left py-1 px-2 font-medium"> </th>
                  <th className="text-right py-1 px-2 font-medium">
                    出発点：1銘柄に集中
                    <div className="font-normal text-gray-400">
                      {manYen(capital)}を{splitAdd.soloTicker}だけに
                    </div>
                  </th>
                  <th className="text-right py-1 px-2 font-medium text-green-700">
                    A: 分割
                    <div className="font-normal text-gray-400">
                      {manYen(capital)}を{splitAdd.n}分割
                    </div>
                  </th>
                  <th className="text-right py-1 px-2 font-medium text-red-700">
                    B: 追加
                    <div className="font-normal text-gray-400">
                      各銘柄に{manYen(capital)}ずつ
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 px-2 text-gray-600">総建玉</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">100%</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">
                    100%<span className="text-gray-400">（不変）</span>
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-red-700 font-semibold">
                    {(splitAdd.add.exposure * 100).toFixed(0)}%
                  </td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 px-2 text-gray-600">期待リターン</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">
                    {pct(splitAdd.solo.expected)}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums">
                    {pct(splitAdd.split.expected)}
                    <span className="text-gray-400">（ほぼ不変）</span>
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-blue-700">
                    {pct(splitAdd.add.expected)}{" "}
                    <span className="text-green-600">↑{splitAdd.n}倍</span>
                  </td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 px-2 text-gray-600">σ_p（振れ幅）</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">
                    {pctAbs(splitAdd.solo.sigmaP)}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-green-700">
                    {pctAbs(splitAdd.split.sigmaP)} ↓
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-red-700">
                    {pctAbs(splitAdd.add.sigmaP)} ↑
                  </td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 px-2 text-gray-600">ドラッグ</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">
                    −{pctAbs(splitAdd.solo.soloDrag + splitAdd.solo.corrDrag)}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-green-700">
                    −{pctAbs(splitAdd.split.soloDrag + splitAdd.split.corrDrag)}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-red-700">
                    −{pctAbs(splitAdd.add.soloDrag + splitAdd.add.corrDrag)}
                  </td>
                </tr>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <td className="py-1.5 px-2 text-gray-700 font-medium">実質成長率 g</td>
                  <td className="py-1.5 px-2 text-right tabular-nums font-semibold">
                    {pct(splitAdd.solo.growth)}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums font-semibold text-green-700">
                    {pct(splitAdd.split.growth)}{" "}
                    {splitAdd.split.growth > splitAdd.solo.growth ? "↑" : "↓"}
                  </td>
                  <td
                    className={`py-1.5 px-2 text-right tabular-nums font-semibold ${
                      splitAdd.add.growth < splitAdd.split.growth ? "text-red-700" : "text-gray-800"
                    }`}
                  >
                    {pct(splitAdd.add.growth)}{" "}
                    {splitAdd.add.growth < splitAdd.split.growth ? "↓" : "↑"}
                  </td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 px-2 text-gray-600">2倍まで</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">
                    {yearsLabel(splitAdd.solo.doublingYears)}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-green-700">
                    {yearsLabel(splitAdd.split.doublingYears)}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-red-700">
                    {yearsLabel(splitAdd.add.doublingYears)}
                  </td>
                </tr>
                <tr>
                  <td className="py-1.5 px-2 text-gray-600">正体</td>
                  <td className="py-1.5 px-2 text-right text-gray-500">集中</td>
                  <td className="py-1.5 px-2 text-right font-semibold text-green-700">
                    本物の分散
                  </td>
                  <td className="py-1.5 px-2 text-right font-semibold text-red-700">
                    レバレッジ
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-gray-500">
            A は<strong>資金を分ける</strong>操作、B は<strong>資金を足す</strong>操作です。
            A なら相関が1未満である限り成長率は必ず改善しますが、B は期待リターンが{splitAdd.n}倍に
            なる代わりにドラッグが{splitAdd.n}²倍の方向に効くので、相関次第で悪化します。
            <strong className="text-red-700">
              「分散投資したつもりが、実際はレバレッジを掛けていただけ」＝ B を A だと思っている状態。
            </strong>{" "}
            この表は総建玉スライダーとは独立で、定義どおり A=100% / B={splitAdd.n}×100% で計算しています。
          </p>
        </div>
      )}

      <AnalysisGuide title="幾何成長率とボラティリティ・ドラッグの詳細理論">
        <p className="font-medium text-gray-700">1. 手法の概要</p>
        <p>
          「期待リターン」は<strong>足し算の世界</strong>の言葉です。100人が1回ずつ賭けたときの、100人の平均。
          でもあなたの資産は<strong>掛け算</strong>で増えます。今年の結果に来年の結果を掛ける。
          掛け算の世界では、上下に揺れること自体が資産を削ります。+10%と−10%を繰り返すと、
          平均は0%なのに資産は減っていく。この「揺れの分の目減り」を<strong>ボラティリティ税</strong>
          （ボラティリティ・ドラッグ）と呼びます。
        </p>
        <p>
          銘柄を足すと期待リターンは足し算で増えます。でも税は<strong>二乗</strong>で増えます。
          しかも、似た値動きの銘柄を足すと揺れは打ち消し合わず、そのまま積み上がる。
          だから「良さそうな銘柄を見つけるたびに買い足す」は、期待リターンを増やしながら、
          それ以上の速さで税を増やす操作になります。
          <strong>
            10銘柄持っていても、値動きがそっくりなら、それは1銘柄を10倍の大きさで持っているのと同じです。
          </strong>
          このパネルは、その「消えている分」をあなたの実データで測ります。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          対数リターン {" r_t = log(P_t / P_{t−1}) "}、資産の成長は {" W_T = W_0 · exp(Σ r_t) "}。
          算術平均（期待リターン）を μ_a、幾何平均（実質成長率）を g とすると、
          {" log(1+x) ≈ x − x²/2 "} を期待値に取り {" E[x²] ≈ σ² "} として
        </p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">g ≈ μ_a − σ²/2</p>
        <p>
          （対数正規分布なら近似ではなく厳密）。この {" σ²/2 "} がボラティリティ・ドラッグです。
          ポートフォリオの分散は {" σ_p² = Σ_i Σ_j w_i w_j σ_i σ_j ρ_ij "}。
          等ウェイト・共通 σ・共通 ρ なら
        </p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">
          σ_p² = σ²[ 1/N + (1−1/N)ρ ] = σ²/N_eff , N_eff = N/(1+(N−1)ρ)
        </p>
        <p>総建玉 W のときの成長率は3項に分解できます（本パネルのウォーターフォールそのもの）。</p>
        <p className="font-mono text-[11px] bg-white rounded px-2 py-1">
          g(W) = W·μ − W²σ²/(2N) − W²σ²(1−1/N)ρ/2
        </p>
        <p>
          第1項が期待（W に<strong>比例</strong>）、第2項が単独ドラッグ、第3項が相関ドラッグ
          （どちらも W の<strong>二乗</strong>）。実データでは
          {" 単独ドラッグ = Σ w_i²σ_i²/2 "}、{" 相関ドラッグ = σ_p²/2 − 単独ドラッグ "} として計算しています。
        </p>
        <p>
          最適建玉は {" W* = μ / σ_single² "}（{" σ_single = σ/√N_eff "}）、フルケリー比は
          {" λ = W / W* "} で、{" g(λ)/g_max = 2λ − λ² "}。λ=1 で最大、
          <strong>λ=2 で成長率ちょうどゼロ、λ&gt;2 では資産が減っていきます</strong>（期待値は増え続けているのに）。
        </p>
        <p>
          <strong>「相関を無視する」の数学的な意味</strong>: ρ を 0 と誤認して W* を計算すると、
          真の最適の {" √(1+(N−1)ρ) "} 倍の建玉を持つことになります。すなわち
          {" λ_true = √(N/N_eff) "}。N=10, ρ=0.5 なら λ=2.35 で {" 2λ−λ² = −0.82 "}、
          成長率は最大値の −82%、つまり資産は減っていきます。
        </p>
        <p className="text-[11px] text-gray-500">
          実装上の注意: 対数リターンの平均×252 は既に g そのものであって μ_a ではありません。
          本パネルは μ_a を単純リターン {" exp(r)−1 "} の平均から、Σ を対数リターンの共分散から取っています。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>算術平均（期待リターン）</strong>: 各期のリターンを単純に平均したもの。
            「大勢の人の平均」に相当し、あなた1人の資産の伸びとは一致しない。
          </li>
          <li>
            <strong>幾何平均（実質成長率 g）</strong>: 資産が実際に増えていく速さ。
            掛け算の平均。長期投資で意味を持つのはこちらだけ。
          </li>
          <li>
            <strong>ボラティリティ・ドラッグ（ボラティリティ税）</strong>: 算術平均と幾何平均の差 σ²/2。
            値動きが荒いだけで自動的に取られる目減り分。
          </li>
          <li>
            <strong>実効銘柄数 N_eff</strong>: {" (Σw)²/(wᵀRw) "}。
            相関とウェイトの偏りを織り込んだ「実質的に何個の別々の賭けを持っているか」。
          </li>
          <li>
            <strong>N / N_eff</strong>: {" 1+(N−1)ρ "}。
            <strong>払っているボラティリティ税が、本当に分散できていた場合の何倍か</strong>。
          </li>
          <li>
            <strong>隠れレバレッジ</strong>: {" √(N/N_eff) "}。思っていたリスクの何倍を実際に負っているか。
          </li>
          <li>
            <strong>倍化年数</strong>: {" ln2/g "}。成長率を「2倍になるまで何年か」に翻訳したもの。
          </li>
          <li>
            <strong>総建玉 W</strong>: 現金を含む資産に対する株式の比率。100% がフル現物、200% が信用2倍。
            期待項は W に<strong>比例</strong>、ドラッグ項は W の<strong>二乗</strong>で効く。
          </li>
          <li>
            <strong>リスク寄与率 PCTR</strong>: {" w_i(Σw)_i / σ_p² "}（合計1）。
            ポートフォリオ全体の分散のうち、その銘柄が作り出している割合。
            お金の配分と違って<strong>相関を通じた波及も含む</strong>ので、
            少数の銘柄に偏りやすい。
          </li>
          <li>
            <strong>主成分の寄与率</strong>: 相関行列 R の固有値 λ_k を対角和 n で割ったもの。
            第1主成分 PC1 が大きいほど「全銘柄が共通の1つの波に乗っている」＝
            <strong>値動きの型が1つしかない</strong>。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>卵とカゴとトラック</strong>: 卵を10個のカゴに分けたが、カゴを全部同じトラックに載せている。
            事故れば全部割れる。カゴの数（銘柄数）ではなく<strong>トラックの数（N_eff）</strong>が本当の分散。
          </li>
          <li>
            <strong>占い師</strong>: 別々の10人の占い師に聞く（ρ=0）のと、1人の占い師に10回聞く（ρ=1）のは違う。
            後者は自信が10倍になるだけで、情報は1つ分。
          </li>
          <li>
            <strong>和音とボリューム</strong>: 違う音を重ねると和音（分散）。同じ音を10個重ねても音量が10倍になるだけ
            （レバレッジ）。うるさいだけで曲は豊かにならない。
          </li>
          <li>
            <strong>穴の空いたバケツ</strong>: 期待リターン＝蛇口の水量、ボラ＝バケツの穴。
            相関の高い銘柄を足すと蛇口は太くなるが、穴は<strong>もっと速く</strong>大きくなる（穴は二乗で効く）。
          </li>
          <li>
            <strong>山道の平均時速</strong>: 行き60km/h・帰り20km/hの「平均」は40km/hではなく30km/h（調和平均）。
            平均という言葉が2種類あることの日常例。
          </li>
          <li>
            <strong>階段</strong>: 1段上がって1段下がれば元に戻る。でも「10%上がって10%下がる」は元に戻らない（99%）。
            掛け算の世界では上りと下りが非対称。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            ウォーターフォールで<strong>一番長い赤い棒</strong>が相関ドラッグなら、あなたの成長率を削っている
            主犯は「銘柄の選び方」ではなく「似た銘柄を並べたこと」。
          </li>
          <li>
            N / N_eff = 5.5 なら、<strong>払っている税は本物の分散の5.5倍</strong>。
            銘柄数を増やしても、この数字が下がらなければ分散にはなっていない。
          </li>
          <li>
            隠れレバレッジが 2 を超える＝フルケリー比 λ&gt;2 の目安。
            {" g(λ)/g_max = 2λ−λ² "} が負に入る領域で、<strong>建玉を減らすことが唯一の改善策</strong>。
          </li>
          <li>
            台帳で「期待リターン ↑」と「成長率 ↓」が同じ行で逆を向いたら、その追加は<strong>もう足し算になっていない</strong>。
            黄色い行より下は、買うほど遅くなる領域。
          </li>
          <li>
            倍化年数が「永遠に来ない」と出たら、g ≤ 0。期待リターンが正でも資産は増えません。
          </li>
          <li>
            <strong>円グラフの左と中で色の面積が食い違うほど危ない</strong>。
            お金は10%しか置いていない銘柄がリスクの30%を作っているなら、
            それはあなたのポートフォリオの「本当の重心」がそこにあるということ。
          </li>
          <li>
            <strong>PC1 が 50% を超えたら、実質1つの賭け</strong>。銘柄数をいくら増やしても、
            値動きの型が1つしかないなら分散にはなっていません。
          </li>
          <li>
            <strong>分割 vs 追加の表は、同じ「N銘柄に分散」の2つの意味を切り分けます</strong>。
            A（分割）は必ず改善、B（追加）は相関次第で悪化。自分がやっているのがどちらかを
            総建玉の行で確認してください。
          </li>
          <li>
            <strong>総建玉スライダー</strong>を動かすと、期待リターンは直線的に、ドラッグは
            二乗で伸びます。成長率が折り返す（下がり始める）建玉が、あなたの上限の目安です。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>買い増しの前に N_eff の変化を見る</strong>。銘柄数が増えても N_eff が増えないなら、
            それは分散ではなく既存ポジションの増量。
          </li>
          <li>
            <strong>同業種の追加は「分散」ではなく「増し玉」と認識する</strong>。台帳の「既存との相関」列が
            0.6 を超える銘柄の追加は、実質的にレバレッジを上げる操作。
          </li>
          <li>
            <strong>建玉上限を λ&lt;1 から逆算する</strong>。隠れレバレッジが 1 を大きく超えるなら、
            総建玉をその倍率で割った水準まで落とすと成長率が最大に近づく。
          </li>
          <li>
            相関の低い銘柄を1つ加えるほうが、期待リターンの高い似た銘柄を3つ加えるより g を上げることがある。
            台帳の「分割」モードで確かめられる。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <strong>μ の推定誤差は σ の推定誤差よりはるかに大きい</strong>。
            期待リターンの列は過去平均であり、将来の期待値ではない。ケリー最適点そのものは信用できないので、
            判断は必ず <strong>λ&lt;1 の側（建玉を減らす側）に倒す</strong>。
          </li>
          <li>
            <strong>相関は非定常で、テール時に上がる</strong>。ここで使う相関は平時の平均であり、
            暴落時にはさらに 1 へ寄って N_eff は今より小さくなる。危機時の相関は
            「ポートフォリオ・リスク分析」の DCC・危機時相関を参照。
          </li>
          <li>
            {" g ≈ μ−σ²/2 "} は2次近似。テールが厚い（尖度が高い）分布では
            ドラッグを<strong>過小評価</strong>する。実際の目減りはこの表より大きくなりうる。
          </li>
          <li>
            過去相関が将来相関を保証しない。銘柄数が少ない・期間が短いと相関行列の推定誤差が大きく、
            N_eff も不安定になる。
          </li>
          <li>
            台帳の並び順は「相関の高い順」に固定した思考実験であり、推奨する組み入れ順ではない。
            「似た銘柄をどんどん買う」とどうなるかを再現するためのもの。
          </li>
          <li>
            共通営業日でしか整列できないため、上場間もない銘柄があると全体のデータ期間が短くなる。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// G5 リスクの二つの顔（Canvas2D・円グラフ3枚）
// 円グラフは横軸が時間でない静的図なので規約どおり Canvas2D。
// 左と中は「同じ色＝同じ銘柄」を厳守する（見た目の分散と本当の分散を目で重ねるため）。
// ────────────────────────────────────────────────────────────────────────────
const PIE_COLORS = [
  "#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#ea580c", "#0d9488",
  "#4f46e5", "#b91c1c", "#15803d", "#a16207", "#6d28d9",
];

function drawTwoFaces(
  canvas: HTMLCanvasElement,
  components: RiskComponent[],
  pc: VarianceConcentration,
  names: Record<string, string>
) {
  const parent = canvas.parentElement;
  if (!parent) return;
  const width = parent.clientWidth;
  if (width <= 0) return;
  const height = 232;
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

  // 配分の大きい順に固定し、両方の円で同じ順・同じ色を使う
  const order = [...components].sort((a, b) => b.weight - a.weight);
  const colorOf = (i: number) => PIE_COLORS[i % PIE_COLORS.length];

  const colW = width / 3;
  const r = Math.max(34, Math.min(58, colW * 0.3));
  const cy = 26 + r;

  const pie = (
    cx: number,
    slices: { v: number; color: string }[],
    title: string,
    sub: string
  ) => {
    ctx.textAlign = "center";
    ctx.font = "bold 11px sans-serif";
    ctx.fillStyle = "#374151";
    ctx.fillText(title, cx, 14);
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "#9ca3af";
    ctx.fillText(sub, cx, 26);

    const total = slices.reduce((s, x) => s + Math.max(x.v, 0), 0) || 1;
    let a0 = -Math.PI / 2;
    for (const s of slices) {
      const frac = Math.max(s.v, 0) / total;
      const a1 = a0 + frac * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a0, a1);
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.strokeStyle = "#fafafa";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      a0 = a1;
    }
  };

  // ① 資産配分
  pie(
    colW * 0.5,
    order.map((c, i) => ({ v: c.weight, color: colorOf(i) })),
    "見た目の分散",
    "お金の配り方"
  );
  // ② リスク寄与率 PCTR
  pie(
    colW * 1.5,
    order.map((c, i) => ({ v: Math.max(c.pctr, 0), color: colorOf(i) })),
    "本当の分散",
    "リスク寄与率 PCTR"
  );
  // ③ 主成分の寄与率
  const pcSlices = [
    ...pc.shares.map((v, i) => ({
      v,
      color: i === 0 ? "#dc2626" : i === 1 ? "#f59e0b" : "#3b82f6",
    })),
    { v: pc.rest, color: "#d1d5db" },
  ];
  pie(colW * 2.5, pcSlices, "値動きの型はいくつか", "主成分の寄与率");

  // 凡例（上位3件＋その他）
  const legend = (cx: number, rows: { label: string; color: string; v: number }[]) => {
    let y = cy + r + 16;
    ctx.textAlign = "left";
    ctx.font = "10px sans-serif";
    for (const row of rows) {
      const x = cx - colW * 0.42;
      ctx.fillStyle = row.color;
      ctx.fillRect(x, y - 7, 8, 8);
      ctx.fillStyle = "#4b5563";
      const maxW = colW * 0.84 - 44;
      let label = row.label;
      while (ctx.measureText(label).width > maxW && label.length > 2) {
        label = label.slice(0, -1);
      }
      ctx.fillText(label, x + 12, y);
      ctx.textAlign = "right";
      ctx.fillStyle = "#111827";
      ctx.fillText(`${(row.v * 100).toFixed(0)}%`, cx + colW * 0.42, y);
      ctx.textAlign = "left";
      y += 13;
    }
  };

  const top = order.slice(0, 3);
  const restW = order.slice(3).reduce((s, c) => s + c.weight, 0);
  const restP = order.slice(3).reduce((s, c) => s + Math.max(c.pctr, 0), 0);
  legend(
    colW * 0.5,
    [
      ...top.map((c, i) => ({
        label: `${c.ticker} ${names[c.ticker] ?? ""}`.trim(),
        color: colorOf(i),
        v: c.weight,
      })),
      ...(order.length > 3 ? [{ label: `他${order.length - 3}銘柄`, color: "#d1d5db", v: restW }] : []),
    ]
  );
  legend(
    colW * 1.5,
    [
      ...top.map((c, i) => ({
        label: `${c.ticker} ${names[c.ticker] ?? ""}`.trim(),
        color: colorOf(i),
        v: Math.max(c.pctr, 0),
      })),
      ...(order.length > 3 ? [{ label: `他${order.length - 3}銘柄`, color: "#d1d5db", v: restP }] : []),
    ]
  );
  legend(
    colW * 2.5,
    [
      ...pc.shares.map((v, i) => ({
        label: `第${i + 1}主成分`,
        color: i === 0 ? "#dc2626" : i === 1 ? "#f59e0b" : "#3b82f6",
        v,
      })),
      { label: "その他", color: "#d1d5db", v: pc.rest },
    ]
  );
}

// ────────────────────────────────────────────────────────────────────────────
// G2 ウォーターフォール（Canvas2D・initCanvas パターン）
// 横軸はリターン値（時間軸ではない）ので規約どおり Canvas2D で描く。
// ────────────────────────────────────────────────────────────────────────────
function drawWaterfall(canvas: HTMLCanvasElement, d: DragDecomp, capital: number) {
  const parent = canvas.parentElement;
  if (!parent) return;
  const width = parent.clientWidth;
  const rowH = 46;
  const padT = 10;
  const padB = 30;
  const padL = 104;
  const padR = 12;
  const rows = 4;
  const height = padT + padB + rows * rowH;
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

  const afterSolo = d.expected - d.soloDrag;
  const segments = [
    { from: 0, to: d.expected, label: "期待リターン（見かけ）", value: d.expected, color: "#3b82f6", strong: false },
    { from: d.expected, to: afterSolo, label: "単独ドラッグ（分散しても残る分）", value: -d.soloDrag, color: "#9ca3af", strong: false },
    { from: afterSolo, to: d.growth, label: "相関ドラッグ（相関を無視した代償）", value: -d.corrDrag, color: "#dc2626", strong: true },
    { from: 0, to: d.growth, label: "実際に増える速さ（幾何成長率）", value: d.growth, color: "#16a34a", strong: true },
  ];

  // 定義域
  let lo = 0;
  let hi = 0;
  for (const s of segments) {
    lo = Math.min(lo, s.from, s.to);
    hi = Math.max(hi, s.from, s.to);
  }
  const span = hi - lo || 0.1;
  lo -= span * 0.06;
  hi += span * 0.06;
  const range = hi - lo || 1;
  const plotW = width - padL - padR;
  const xOf = (v: number) => padL + ((v - lo) / range) * plotW;

  // ゼロ線
  const zx = xOf(0);
  ctx.strokeStyle = "#9ca3af";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(zx, padT);
  ctx.lineTo(zx, padT + rows * rowH);
  ctx.stroke();

  const barH = 20;
  segments.forEach((s, i) => {
    const yTop = padT + i * rowH + (rowH - barH) / 2 - 3;
    const x0 = xOf(Math.min(s.from, s.to));
    const x1 = xOf(Math.max(s.from, s.to));
    const w = Math.max(x1 - x0, 1.5);

    // 段差をつなぐ点線（前の段の到達点から降りてくる）
    if (i > 0 && i < 3) {
      const cx = xOf(s.from);
      ctx.save();
      ctx.strokeStyle = "#cbd5e1";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, padT + (i - 1) * rowH + (rowH - barH) / 2 - 3 + barH);
      ctx.lineTo(cx, yTop);
      ctx.stroke();
      ctx.restore();
    }

    ctx.fillStyle = s.color;
    ctx.fillRect(x0, yTop, w, barH);
    if (s.strong) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 - 1.5, yTop - 1.5, w + 3, barH + 3);
    }

    // 左ガター: 値（%）と円換算
    ctx.textAlign = "right";
    ctx.fillStyle = s.value >= 0 ? "#111827" : "#b91c1c";
    ctx.font = "bold 13px ui-monospace, monospace";
    ctx.fillText(`${s.value >= 0 ? "+" : "−"}${(Math.abs(s.value) * 100).toFixed(1)}%`, padL - 10, yTop + 12);
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    const yen = s.value * capital;
    ctx.fillText(
      `${yen >= 0 ? "" : "▲"}${manYen(Math.abs(yen))}`,
      padL - 10,
      yTop + 24
    );

    // ラベル: ①棒の右 ②（右に出ないなら）棒の中に白抜き ③（棒が細くて入らないなら）棒の左
    // ドラッグの棒は短くなりがちで、②のまま描くと背景に白文字が乗って読めなくなる。
    ctx.font = s.strong ? "bold 12px sans-serif" : "12px sans-serif";
    const textW = ctx.measureText(s.label).width;
    if (x1 + 8 + textW < width - padR) {
      ctx.textAlign = "left";
      ctx.fillStyle = s.strong ? s.color : "#4b5563";
      ctx.fillText(s.label, x1 + 8, yTop + 14);
    } else if (w > textW + 14) {
      ctx.textAlign = "right";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(s.label, x1 - 6, yTop + 14);
    } else {
      ctx.textAlign = "right";
      ctx.fillStyle = s.strong ? s.color : "#4b5563";
      ctx.fillText(s.label, x0 - 8, yTop + 14);
    }
  });

  // 目盛り
  ctx.textAlign = "center";
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#9ca3af";
  ctx.strokeStyle = "#e5e7eb";
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = lo + (range * i) / ticks;
    const x = xOf(v);
    ctx.beginPath();
    ctx.moveTo(x, padT + rows * rowH);
    ctx.lineTo(x, padT + rows * rowH + 4);
    ctx.stroke();
    ctx.fillText(`${(v * 100).toFixed(0)}%`, x, padT + rows * rowH + 16);
  }
  ctx.textAlign = "left";
  ctx.fillStyle = "#9ca3af";
  ctx.fillText("年率リターン", padL, height - 4);
}
