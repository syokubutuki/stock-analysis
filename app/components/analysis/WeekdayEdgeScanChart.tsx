"use client";

import React, { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { PricePoint } from "../../lib/types";
import AnalysisGuide from "./AnalysisGuide";
import {
  analyzeAtoms,
  scanWeekdayEdges,
  type AtomStat,
  type AtomYearGrid,
  type ScanSort,
} from "../../lib/weekday-scan";

interface Props {
  prices: PricePoint[];
}

// --- Canvas helper (プロジェクト規約のパターン) ---
function initCanvas(canvas: HTMLCanvasElement, height: number): { ctx: CanvasRenderingContext2D; width: number; height: number } | null {
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

function pct(v: number, d = 3): string { return (v * 100).toFixed(d) + "%"; }
function star(p: number | null): string {
  if (p === null) return "";
  return p < 0.01 ? "***" : p < 0.05 ? "**" : p < 0.1 ? "*" : "";
}
function colorCls(v: number): string { return v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-gray-500"; }

const SORT_LABELS: Record<ScanSort, string> = {
  pAdj: "FDR補正p値",
  absT: "|t統計量|",
  annualized: "年率リターン",
  sharpe: "Sharpe",
};

export default function WeekdayEdgeScanChart({ prices }: Props) {
  const spectrumRef = useRef<HTMLCanvasElement>(null);
  const clockRef = useRef<HTMLCanvasElement>(null);
  const atomYearRef = useRef<HTMLCanvasElement>(null);

  const [compound, setCompound] = useState(true);
  const [minTrades, setMinTrades] = useState(12);
  const [sort, setSort] = useState<ScanSort>("pAdj");
  const [onlySignificant, setOnlySignificant] = useState(false);
  const [rankingOpen, setRankingOpen] = useState(false);

  // 週内クロック/スペクトルの対象期間: 最新から直近 winLen 本の日足に絞る(0=全期間)。
  // 銘柄・期間の切替でデータ長が変わったら全期間に戻す。
  const [winLen, setWinLen] = useState(0);
  useEffect(() => { setWinLen(prices.length); }, [prices.length]);
  const effWinLen = winLen > 0 ? Math.min(winLen, prices.length) : prices.length;
  const windowedPrices = useMemo(
    () => (effWinLen >= prices.length ? prices : prices.slice(prices.length - effWinLen)),
    [prices, effWinLen],
  );
  const isFullWindow = effWinLen >= prices.length;

  // 全期間の素片分析(素片×年ヒートマップ用: 年次推移は全履歴が前提)
  const atomAnalysis = useMemo(() => analyzeAtoms(prices), [prices]);
  // 対象期間に絞った素片分析(エッジ・スペクトル / 週内クロック / 最良窓 用)
  const windowAnalysis = useMemo(() => analyzeAtoms(windowedPrices), [windowedPrices]);
  const scan = useMemo(
    () => scanWeekdayEdges(prices, { compound, minTrades, sort, bootstrapB: 800, bootstrapTopN: 40 }),
    [prices, compound, minTrades, sort],
  );

  const rows = useMemo(() => {
    const r = onlySignificant ? scan.stats.filter((s) => s.pAdj < 0.05) : scan.stats;
    return r.slice(0, 30);
  }, [scan.stats, onlySignificant]);

  const nSignificant = useMemo(() => scan.stats.filter((s) => s.pAdj < 0.05).length, [scan.stats]);

  // 週内クロックの標本規模: 各曜日(夜間素片)のnが対象週数、その総和が対象営業日数
  const clockSample = useMemo(() => {
    const counts = windowAnalysis.atoms.filter((a) => a.kind === "overnight").map((a) => a.n);
    const totalDays = counts.reduce((s, v) => s + v, 0);
    return { totalDays, minN: Math.min(...counts), maxN: Math.max(...counts) };
  }, [windowAnalysis]);

  // === エッジ・スペクトル(10素片の平均±SEと有意性) ===
  const drawSpectrum = useCallback((canvas: HTMLCanvasElement, atoms: AtomStat[]) => {
    const r = initCanvas(canvas, 220); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 16, bottom: 36, left: 52, right: 12 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const maxAbs = Math.max(...atoms.map((a) => Math.abs(a.mean) + a.se), 0.0005);
    const zeroY = pad.top + plotH / 2;

    // y軸グリッド
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(width - pad.right, zeroY); ctx.stroke();
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (const v of [-maxAbs, 0, maxAbs]) {
      const y = zeroY - (v / maxAbs) * (plotH / 2);
      ctx.fillText((v * 100).toFixed(3) + "%", pad.left - 5, y + 3);
    }

    const n = atoms.length;
    const slotW = plotW / n;
    const barW = slotW * 0.55;
    for (let i = 0; i < n; i++) {
      const a = atoms[i];
      const cx = pad.left + (i + 0.5) * slotW;
      const x = cx - barW / 2;
      const barH = (a.mean / maxAbs) * (plotH / 2);
      const sig = a.p !== null && a.p < 0.05;
      ctx.fillStyle = a.mean >= 0
        ? (sig ? "#16a34a" : "#86efac")
        : (sig ? "#dc2626" : "#fca5a5");
      ctx.fillRect(x, zeroY - Math.max(barH, 0), barW, Math.abs(barH));

      // 誤差バー(±SE)
      const seTop = zeroY - ((a.mean + a.se) / maxAbs) * (plotH / 2);
      const seBot = zeroY - ((a.mean - a.se) / maxAbs) * (plotH / 2);
      ctx.strokeStyle = "#374151"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, seTop); ctx.lineTo(cx, seBot); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - 3, seTop); ctx.lineTo(cx + 3, seTop); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - 3, seBot); ctx.lineTo(cx + 3, seBot); ctx.stroke();

      // 有意性スター
      const st = star(a.p);
      if (st) {
        ctx.fillStyle = "#2563eb"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
        ctx.fillText(st, cx, (barH >= 0 ? seTop : seBot) + (barH >= 0 ? -3 : 10));
      }

      // ラベル(曜日色分け)
      ctx.fillStyle = a.kind === "overnight" ? "#7c3aed" : "#0891b2";
      ctx.font = "8px sans-serif"; ctx.textAlign = "center";
      ctx.save();
      ctx.translate(cx, height - 20); ctx.rotate(-Math.PI / 6);
      ctx.fillText(a.label, 0, 0);
      ctx.restore();
    }
    // 凡例
    ctx.font = "8px sans-serif"; ctx.textAlign = "left";
    ctx.fillStyle = "#7c3aed"; ctx.fillText("■夜間(前C→当O)", pad.left, height - 4);
    ctx.fillStyle = "#0891b2"; ctx.fillText("■日中(当O→当C)", pad.left + 92, height - 4);
    ctx.fillStyle = "#2563eb"; ctx.fillText("★=p<0.05 / バー濃=有意", pad.left + 184, height - 4);
  }, []);

  // === 週内クロック(累積平均リターン曲線) ===
  const drawClock = useCallback((canvas: HTMLCanvasElement, cum: number[], atoms: AtomStat[], best: { from: number; to: number } | null) => {
    const r = initCanvas(canvas, 200); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 16, bottom: 34, left: 52, right: 12 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const lo = Math.min(...cum), hi = Math.max(...cum);
    const range = hi - lo || 0.001;
    const toY = (v: number) => pad.top + plotH * (1 - (v - lo) / range);
    const toX = (i: number) => pad.left + (plotW * i) / (cum.length - 1);

    // 推奨ロング窓のハイライト
    if (best) {
      ctx.fillStyle = "rgba(22,163,74,0.10)";
      ctx.fillRect(toX(best.from), pad.top, toX(best.to + 1) - toX(best.from), plotH);
    }

    // y軸
    ctx.fillStyle = "#999"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const v = lo + (range * i) / 4;
      const y = toY(v);
      ctx.fillText((v * 100).toFixed(3) + "%", pad.left - 5, y + 3);
      ctx.strokeStyle = "#f0f0f0"; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    }
    const zeroY = toY(0);
    if (zeroY >= pad.top && zeroY <= pad.top + plotH) {
      ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(width - pad.right, zeroY); ctx.stroke();
    }

    // 累積線
    ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2;
    ctx.beginPath();
    cum.forEach((v, i) => { const x = toX(i), y = toY(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();

    // 谷(最小)・山(最大)マーカー
    let minI = 0, maxI = 0;
    cum.forEach((v, i) => { if (v < cum[minI]) minI = i; if (v > cum[maxI]) maxI = i; });
    const mark = (i: number, color: string, label: string) => {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(toX(i), toY(cum[i]), 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.font = "8px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(label, toX(i), toY(cum[i]) - 6);
    };
    mark(minI, "#16a34a", "谷=買");
    mark(maxI, "#dc2626", "山=売");

    // x軸ラベル(素片境界)
    ctx.fillStyle = "#666"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("週初", toX(0), height - 18);
    atoms.forEach((a, i) => {
      ctx.save();
      ctx.translate(toX(i + 1), height - 20); ctx.rotate(-Math.PI / 6);
      ctx.fillStyle = "#999"; ctx.fillText(a.label, 0, 0);
      ctx.restore();
    });
  }, []);

  // === 素片×年ヒートマップ(エッジの持続/減衰) ===
  const drawAtomYear = useCallback((canvas: HTMLCanvasElement, atoms: AtomStat[], yearly: AtomYearGrid) => {
    const { years, grid, maxAbs } = yearly;
    const labelW = 56, headerH = 18, cellH = 20;
    const nRows = atoms.length, nCols = years.length;
    const totalH = headerH + nRows * cellH + 8;
    const r = initCanvas(canvas, totalH); if (!r) return;
    const { ctx, width } = r;
    const cellW = Math.max(18, (width - labelW - 6) / Math.max(nCols, 1));

    // ヘッダー(年)
    ctx.fillStyle = "#666"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    for (let j = 0; j < nCols; j++) {
      const ylabel = `'${String(years[j]).slice(2)}`;
      ctx.fillText(ylabel, labelW + j * cellW + cellW / 2, headerH - 5);
    }
    // 行
    for (let i = 0; i < nRows; i++) {
      const a = atoms[i];
      ctx.fillStyle = a.kind === "overnight" ? "#7c3aed" : "#0891b2";
      ctx.font = "9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(a.label, labelW - 4, headerH + i * cellH + cellH / 2 + 3);
      for (let j = 0; j < nCols; j++) {
        const v = grid[i][j];
        const x = labelW + j * cellW, y = headerH + i * cellH;
        if (v === null) {
          ctx.fillStyle = "#f3f4f6";
        } else {
          const tnorm = Math.min(1, Math.abs(v) / (maxAbs || 0.001));
          ctx.fillStyle = v > 0
            ? `rgba(22,163,74,${0.12 + 0.78 * tnorm})`
            : `rgba(220,38,38,${0.12 + 0.78 * tnorm})`;
        }
        ctx.fillRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
      }
    }
  }, []);

  useEffect(() => {
    if (spectrumRef.current) drawSpectrum(spectrumRef.current, windowAnalysis.atoms);
    if (clockRef.current) drawClock(clockRef.current, windowAnalysis.cumulative, windowAnalysis.atoms, windowAnalysis.bestLong);
    if (atomYearRef.current) drawAtomYear(atomYearRef.current, atomAnalysis.atoms, atomAnalysis.yearly);
  }, [atomAnalysis, windowAnalysis, drawSpectrum, drawClock, drawAtomYear]);

  if (prices.length < 60) {
    return <div className="text-xs text-gray-400 p-3">データが不足しています(60営業日以上必要)。</div>;
  }

  const bl = windowAnalysis.bestLong;
  const bs = windowAnalysis.bestShort;

  return (
    <div className="space-y-5">
      {/* ===== 共通コントロール ===== */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={compound} onChange={(e) => setCompound(e.target.checked)} />
          複利
        </label>
        <label className="flex items-center gap-1">
          最小トレード数
          <select className="border rounded px-1 py-0.5" value={minTrades} onChange={(e) => setMinTrades(Number(e.target.value))}>
            {[8, 12, 20, 30, 50].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      </div>

      {/* ===== 対象期間スライダー(スペクトル・週内クロック) ===== */}
      <div className="rounded border border-gray-100 bg-gray-50/60 p-2.5 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-gray-600 font-medium">対象期間（スペクトル・週内クロック）</span>
          <span className="text-gray-500">
            最新から直近{" "}
            <span className="font-mono text-gray-700">{effWinLen.toLocaleString()}</span> 本
            <span className="text-gray-400">（≈{(effWinLen / 252).toFixed(1)}年 / {clockSample.totalDays.toLocaleString()}営業日）</span>
            {isFullWindow && <span className="text-gray-400"> ・全期間</span>}
          </span>
          <div className="flex items-center gap-1 ml-auto">
            {([["3M", 63], ["6M", 126], ["1Y", 252], ["2Y", 504], ["3Y", 756]] as [string, number][])
              .filter(([, n]) => n < prices.length)
              .map(([lbl, n]) => (
                <button
                  key={lbl}
                  type="button"
                  onClick={() => setWinLen(n)}
                  className={`px-1.5 py-0.5 rounded text-[11px] ${!isFullWindow && effWinLen === n ? "bg-blue-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}
                >{lbl}</button>
              ))}
            <button
              type="button"
              onClick={() => setWinLen(prices.length)}
              className={`px-1.5 py-0.5 rounded text-[11px] ${isFullWindow ? "bg-blue-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}
            >全期間</button>
          </div>
        </div>
        <input
          type="range"
          min={60}
          max={prices.length}
          step={1}
          value={effWinLen}
          onChange={(e) => setWinLen(Number(e.target.value))}
          className="w-full accent-blue-600"
        />
        <p className="text-[10px] text-gray-400">
          スライダーを左に動かすほど新しい期間だけで集計し直します。曲線の形が期間で大きく変わる＝そのエッジは不安定。素片×年ヒートマップは全履歴のまま（年次推移を見るため）。
        </p>
      </div>

      {/* ===== (A) エッジ・スペクトル ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">エッジ・スペクトル: 週内10素片の平均対数リターン(±標準誤差・有意性)</div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={spectrumRef} /></div>
      </div>

      {/* ===== (A) 週内クロック ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">
          週内クロック: 素片を時間順に積み上げた累積平均リターン(谷で買い・山で売り)
          <span className="text-gray-400">
            {" "}｜対象 {clockSample.totalDays.toLocaleString()} 営業日（各曜日 n={clockSample.minN}〜{clockSample.maxN} 週）から算出
          </span>
        </div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={clockRef} /></div>
        <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          {bl && (
            <div className="p-2 bg-green-50 rounded border border-green-100">
              <span className="text-gray-500">最良ロング窓(素片の最大連続和):</span>{" "}
              <span className="font-medium text-green-700">{labelSpec(bl.spec)}</span>{" "}
              <span className="font-mono text-green-600">合計 {pct(bl.sum)}</span>
            </div>
          )}
          {bs && (
            <div className="p-2 bg-red-50 rounded border border-red-100">
              <span className="text-gray-500">最良ショート窓(最小連続和):</span>{" "}
              <span className="font-medium text-red-700">{labelSpec(bs.spec)}</span>{" "}
              <span className="font-mono text-red-600">合計 {pct(bs.sum)}</span>
            </div>
          )}
        </div>
      </div>

      {/* ===== (A) 素片×年ヒートマップ ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">素片 × 年 ヒートマップ: 各素片の平均リターンの年次推移(エッジの持続/減衰)</div>
        <div className="w-full rounded border border-gray-100 overflow-x-auto overflow-hidden"><canvas ref={atomYearRef} /></div>
        <p className="text-[10px] text-gray-400 mt-1">緑=プラス/赤=マイナス、濃さ=全セル最大絶対値に対する相対。横に同色が続く素片=持続的なエッジ。1年だけ極端=見かけ倒し。N&lt;2の年は灰色。</p>
      </div>

      {/* ===== (B) 戦略ランキング ===== */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <button
            type="button"
            onClick={() => setRankingOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
          >
            <span className="text-gray-400">{rankingOpen ? "▼" : "▶"}</span>
            戦略ランキング: 全{scan.nTested}組合せ(N≥{scan.minTrades})を検定・
            <span className="text-blue-600 font-medium">FDR補正後に有意なのは {nSignificant} 件</span>
          </button>
          {rankingOpen && (
            <div className="flex items-center gap-2 text-xs">
              <label className="flex items-center gap-1">
                並べ替え
                <select className="border rounded px-1 py-0.5" value={sort} onChange={(e) => setSort(e.target.value as ScanSort)}>
                  {(Object.keys(SORT_LABELS) as ScanSort[]).map((k) => <option key={k} value={k}>{SORT_LABELS[k]}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={onlySignificant} onChange={(e) => setOnlySignificant(e.target.checked)} />
                有意のみ
              </label>
            </div>
          )}
        </div>
        {!rankingOpen && (
          <p className="text-[10px] text-gray-400">上のタイトルをクリックすると全戦略のランキング表を表示します。</p>
        )}
        {rankingOpen && (<>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 px-1.5">戦略</th>
                <th className="text-center px-1">向き</th>
                <th className="text-right px-1">N</th>
                <th className="text-right px-1">年率</th>
                <th className="text-right px-1">Sharpe</th>
                <th className="text-right px-1">|t|</th>
                <th className="text-right px-1">p_adj</th>
                <th className="text-right px-1">年次勝率</th>
                <th className="text-center px-1">前後半</th>
                <th className="text-right px-1.5">ブートCI(平均)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s, i) => {
                const sig = s.pAdj < 0.05;
                return (
                  <tr key={i} className={`border-b border-gray-100 ${sig ? "bg-blue-50/50" : ""}`}>
                    <td className="py-1 px-1.5 font-mono whitespace-nowrap">{s.label}</td>
                    <td className={`text-center px-1 font-medium ${s.direction === "long" ? "text-green-600" : "text-red-600"}`}>{s.direction === "long" ? "買" : "売"}</td>
                    <td className="text-right px-1 text-gray-500">{s.n}</td>
                    <td className={`text-right px-1 font-mono ${colorCls(s.annualized)}`}>{pct(s.annualized, 1)}</td>
                    <td className="text-right px-1 font-mono text-gray-700">{s.sharpe.toFixed(2)}</td>
                    <td className="text-right px-1 font-mono text-gray-700">{s.t.toFixed(2)}</td>
                    <td className={`text-right px-1 font-mono ${sig ? "text-blue-600 font-medium" : "text-gray-400"}`}>{s.pAdj.toFixed(3)}{star(s.pAdj)}</td>
                    <td className="text-right px-1 font-mono text-gray-600">{Math.round(s.yearsPositive * 100)}%<span className="text-gray-400">({s.nYears})</span></td>
                    <td className="text-center px-1">{s.halfAgree ? <span className="text-green-600">✓</span> : <span className="text-gray-300">–</span>}</td>
                    <td className="text-right px-1.5 font-mono text-gray-600 whitespace-nowrap">
                      {s.ciLo !== null && s.ciHi !== null
                        ? <span className={s.ciLo > 0 || s.ciHi < 0 ? "text-blue-600" : "text-gray-400"}>[{pct(s.ciLo, 2)}, {pct(s.ciHi, 2)}]</span>
                        : <span className="text-gray-300">–</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-gray-400 mt-1">
          ブートCIは|t|上位40戦略のみ算出(移動ブロック・ブートストラップ800回)。CIが0をまたがない=平均が頑健に非ゼロ。
        </p>
        </>)}
      </div>

      <AnalysisGuide title="曜日タイミング好機スキャンの詳細理論">
        <p className="font-medium text-gray-700">1. この分析は何をしているか</p>
        <p>
          「各曜日のどのタイミング(始値/終値)で入り、どこで出れば統計的にリターンが偏っているか」を、
          ありうる全組合せから網羅的に探します。素朴に総当たりするとどれかは偶然良く見えてしまうため(データマイニング)、
          多重比較補正・年次安定性・ブートストラップで偽の好機をふるい落とすのが核心です。2つの見方を併用します。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. (A) 素片(atom)分解とは</p>
        <p>
          1週間を最小のリターン区間に割ります。各営業日は「夜間=前営業日終値→当日始値(月の夜間は週末ギャップ)」と
          「日中=当日始値→当日終値」の2区間に分かれ、月〜金で計10素片になります。対数リターンには加法性があるため、
          任意の「入口→出口」戦略のリターンは、またいだ素片リターンの<span className="font-medium">単純な和</span>になります。
        </p>
        <p>{"素片の平均: μ_k = (1/N_k) Σ ln(価格_終 / 価格_始)、標準誤差 SE_k = σ_k/√N_k"}</p>
        <p>
          <span className="font-medium">週内クロック</span>は素片平均を時間順に積み上げた累積曲線 C(j)=Σ_{"{k≤j}"} μ_k です。
          理屈上、累積の<span className="font-medium">谷で買い、山で売る</span>のが(その期間の)最良ロング窓で、これは
          「最大連続部分和」(Kadane法)で厳密に求まります。最小部分和が最良ショート窓です。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. (B) 戦略スキャンと統計的選別</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">総当たり:</span> エントリー(5曜日×始/終=10点)×エグジット(10点)=100組合せを検定。方向は平均の符号で買/売を自動選択。</li>
          <li><span className="font-medium">t検定:</span> 1トレード平均が0と異なるかを両側検定。t = μ·√N/σ、p値はt分布から算出。</li>
          <li><span className="font-medium">FDR補正(Benjamini-Hochberg):</span> 100個も検定すれば α=0.05 で約5件は偶然有意になる。
            p値を昇順に並べ p_adj_(i)=min_{"{k≥i}"} (m·p_(k)/k) で補正し、<span className="font-medium">p_adj&lt;0.05 を本物候補</span>とする。</li>
          <li><span className="font-medium">年次勝率:</span> 方向調整後リターンが「正だった年」の割合。高い=特定の年に依存しない持続的なエッジ。</li>
          <li><span className="font-medium">前後半一致(✓):</span> サンプルを前半・後半に割り、両方とも同符号か。アノマリーの減衰検出。</li>
          <li><span className="font-medium">ブロック・ブートストラップCI:</span> トレードの系列相関に頑健な95%信頼区間。連続するトレードをブロック長 L≈N^(1/3) で束ねて再標本化し平均の分布を作る。CIが0をまたがなければ頑健。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">エッジ・スペクトル:</span> 濃い緑/赤+★が付いた素片に、週内リターンの偏りが集中している。</li>
          <li><span className="font-medium">素片×年ヒートマップ:</span> 横に同色が続く素片=毎年効く持続的なエッジ。1年だけ極端な色=その年固有の偶然で、平均がそれに引っ張られている疑い。色が左右で反転していればアノマリーの減衰・消滅。</li>
          <li><span className="font-medium">ランキング表:</span> p_adj&lt;0.05(青ハイライト) かつ 年次勝率が高く 前後半✓ かつ ブートCIが0をまたがない——この4条件を満たす行が、最も信頼に足る好機。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>素片スペクトルで「夜間に上がり日中に下がる」等の構造を掴み、保有を稼げる区間に限定する。</li>
          <li>FDR・安定性・CIの全てを通った戦略のみを曜日トレード・シミュレータ(上のヒートマップ)に手入力して、エクイティ曲線・最大DD・コスト後を確認する。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">過剰適合:</span> 全てがイン・サンプル最適化。FDRを通っても将来も続く保証はない。年次安定性とCIは必要条件であって十分条件ではない。</li>
          <li><span className="font-medium">取引コスト:</span> 短い保有窓ほど回転が多くコストで消える。CIや年率はコスト・税・スリッページ未考慮。</li>
          <li><span className="font-medium">非定常性:</span> 月曜効果のように、有名になったアノマリーは裁定で消えやすい。前後半・年次の図を必ず併読。</li>
          <li><span className="font-medium">独立性の近似:</span> ブロック・ブートストラップは系列相関を緩和するが完全ではなく、構造変化(レジーム転換)は捉えない。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}

// SpecStat.spec / atom窓のラベル整形
function labelSpec(s: { entryDow: number; entryTiming: string; exitDow: number; exitTiming: string }): string {
  const dow = ["", "月", "火", "水", "木", "金"];
  const tm: Record<string, string> = { open: "始値", close: "終値" };
  return `${dow[s.entryDow]}${tm[s.entryTiming]} → ${dow[s.exitDow]}${tm[s.exitTiming]}`;
}
