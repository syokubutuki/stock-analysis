"use client";

import React, { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { PricePoint } from "../../lib/types";
import AnalysisGuide from "./AnalysisGuide";
import AxiomPlacement from "./AxiomPlacement";
import {
  analyzeAtoms,
  scanWeekdayEdges,
  type AtomStat,
  type AtomYearGrid,
  type ScanSort,
} from "../../lib/weekday-scan";
import { CHART_COLORS } from "../../lib/chart-colors";

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
function colorCls(v: number): string { return v > 0 ? "text-green-700" : v < 0 ? "text-red-600" : "text-gray-500"; }

const SORT_LABELS: Record<ScanSort, string> = {
  pAdj: "FDR補正p値",
  absT: "|t統計量|",
  annualized: "年率リターン",
  sharpe: "Sharpe",
};

export default function WeekdayEdgeScanChart({ prices }: Props) {
  const overviewRef = useRef<HTMLCanvasElement>(null);
  const spectrumRef = useRef<HTMLCanvasElement>(null);
  const clockRef = useRef<HTMLCanvasElement>(null);
  const atomYearRef = useRef<HTMLCanvasElement>(null);

  const [compound, setCompound] = useState(true);
  const [minTrades, setMinTrades] = useState(12);
  const [sort, setSort] = useState<ScanSort>("pAdj");
  const [onlySignificant, setOnlySignificant] = useState(false);
  const [rankingOpen, setRankingOpen] = useState(false);

  // 週内クロック/スペクトルの対象期間。2モード:
  //  - "latest":  最新起点。窓長 winLen を変え、右端は常に最新。
  //  - "rolling": 一定期間ローリング。窓長を固定し、右端 winEnd を過去方向へスライド。
  const [winMode, setWinMode] = useState<"latest" | "rolling">("latest");
  const [winLen, setWinLen] = useState(0);   // 窓長(本)。0=全期間扱い
  const [winEnd, setWinEnd] = useState(0);   // 窓の右端インデックス(1..prices.length)。0=最新
  // ローリング窓のアニメーション再生(窓の位置を過去→最新へ自動スライド)
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(30);   // 再生速度(本/秒)
  const [loop, setLoop] = useState(true);   // 最新に到達したら先頭へ戻す
  // 週内クロックの縦(リターン)軸スケール。
  //  - "off":      現状の自動伸縮(窓の中身に合わせる)。
  //  - "envelope": この窓長で取りうる全ローリング位置の累積振幅を包む固定スケール(0対称)。
  //  - "manual":   手動 ±yManual%。
  // このモードはスペクトルと週内クロックで共有する(同じ窓の2つの見方なので、
  // 片方だけ自動伸縮だと「振幅が変わったのか目盛が変わったのか」が読めなくなる)。
  const [yFix, setYFix] = useState<"off" | "envelope" | "manual">("off");
  const [yManual, setYManual] = useState(0.5);       // 手動固定時の片側レンジ(%): 週内クロック(累積)
  const [yManualSpec, setYManualSpec] = useState(0.2); // 同: エッジ・スペクトル(素片平均)
  const winEndRef = useRef(winEnd);
  useEffect(() => { winEndRef.current = winEnd; }, [winEnd]);
  // 銘柄・期間の切替でデータ長が変わったら全期間・最新起点に戻す。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWinMode("latest");
    setWinLen(prices.length);
    setWinEnd(prices.length);
    setPlaying(false);
    setYFix("off");
  }, [prices.length]);

  const effEnd = winEnd > 0 ? Math.min(winEnd, prices.length) : prices.length;
  const rawLen = winLen > 0 ? winLen : prices.length;
  const effWinLen = Math.min(rawLen, effEnd);
  const windowedPrices = useMemo(
    () => prices.slice(effEnd - effWinLen, effEnd),
    [prices, effEnd, effWinLen],
  );
  const isFullWindow = winMode === "latest" && effWinLen >= prices.length;
  const barsAfter = prices.length - effEnd; // 窓の右端から最新までの本数(ローリング位置)
  const winStartDate = windowedPrices[0]?.time ?? "";
  const winEndDate = windowedPrices[windowedPrices.length - 1]?.time ?? "";

  // 窓が「どういう局面か」を一言で添えるための素性(騰落・年率ボラ)。
  // スペクトル/クロックの形と、原系列上の位置(上昇局面か暴落局面か)を結び付けて読むため。
  const winStats = useMemo(() => {
    const w = windowedPrices;
    if (w.length < 3) return null;
    const rs: number[] = [];
    for (let i = 1; i < w.length; i++) rs.push(Math.log(w[i].close / w[i - 1].close));
    const m = rs.reduce((s, v) => s + v, 0) / rs.length;
    const v2 = rs.reduce((s, v) => s + (v - m) * (v - m), 0) / Math.max(1, rs.length - 1);
    return { ret: Math.log(w[w.length - 1].close / w[0].close), vol: Math.sqrt(v2 * 252) };
  }, [windowedPrices]);

  // リサイズ時にCanvas群を再描画する(2カラム→1カラムの折返しで幅が変わるため)
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => {
    const onResize = () => setResizeTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 固定窓長プリセットを設定(ローリングでも共通)。最新起点では右端を最新に保つ。
  const setLen = useCallback((n: number) => {
    setWinLen(n);
    setWinEnd((prev) => {
      const end = prev > 0 ? Math.min(prev, prices.length) : prices.length;
      return Math.max(end, n); // 窓が右端を超えないように
    });
  }, [prices.length]);

  // モード切替。ローリングは固定窓長が必要なので、全期間だった場合は既定1年に。
  const switchMode = useCallback((m: "latest" | "rolling") => {
    if (m === "rolling") {
      setWinLen((prev) => {
        const cur = prev > 0 ? Math.min(prev, prices.length) : prices.length;
        return cur >= prices.length ? Math.min(252, prices.length - 1) : cur;
      });
    } else {
      setPlaying(false); // 最新起点モードでは位置アニメーションは無効
    }
    setWinEnd(prices.length);
    setWinMode(m);
  }, [prices.length]);

  // ローリング窓のアニメーション: 窓の右端(winEnd)を speed[本/秒] で前進させる。
  // フレーム落ちに依存しないよう経過時間で歩幅を決める(requestAnimationFrame)。
  useEffect(() => {
    if (!playing || winMode !== "rolling") return;
    const startPos = Math.min(winLen > 0 ? winLen : prices.length, prices.length);
    let cur = winEndRef.current;
    if (cur >= prices.length) cur = startPos; // 端で再生した場合は先頭から
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      acc += speed * dt;
      if (acc >= 1) {
        cur += Math.floor(acc); acc -= Math.floor(acc);
        if (cur >= prices.length) {
          if (loop) {
            cur = startPos;
          } else {
            setWinEnd(prices.length); setPlaying(false); return;
          }
        }
        setWinEnd(cur);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, winMode, speed, loop, winLen, prices.length]);

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

  // 縦軸「固定(全位置)」用のエンベロープ: 現在の窓長 effWinLen を保ったまま
  // 全ローリング位置をスライドし、どの位置でもクリップしない片側レンジ(0対称)を求める。
  // これに合わせて軸を固定すれば、窓を動かしても目盛が動かず、局面ごとの
  // 「振幅そのものの大小」を直接比較できる。位置数は最大~200点に間引いて軽量化。
  //  - clock:    累積パス |C(j)| の最大
  //  - spectrum: 素片の |μ_k| + SE_k の最大(誤差バーの先端まで入るように)
  const yEnvelope = useMemo(() => {
    const specOf = (atoms: AtomStat[]) => Math.max(...atoms.map((a) => Math.abs(a.mean) + a.se), 0.00005);
    const L = effWinLen;
    if (L >= prices.length) {
      // 単一窓(全期間): その唯一の窓の振幅をそのまま採用。
      // atomAnalysis は prices のみ依存で安定 → 再生(winEnd変化)中に再計算されない。
      return {
        clock: Math.max(...atomAnalysis.cumulative.map((v) => Math.abs(v)), 0.0001),
        spectrum: specOf(atomAnalysis.atoms),
      };
    }
    // 短窓ほど各素片平均が平滑化されず振幅が大きく振れるため、全期間値では包み切れず
    // クリップされる。窓長に依らず必ず全ローリング位置を走査して最大値を採る。
    const step = Math.max(1, Math.floor((prices.length - L) / 200));
    let clock = 0.0001, spectrum = 0.00005;
    for (let end = L; end <= prices.length; end += step) {
      const a = analyzeAtoms(prices.slice(end - L, end));
      for (const v of a.cumulative) { const av = Math.abs(v); if (av > clock) clock = av; }
      const s = specOf(a.atoms); if (s > spectrum) spectrum = s;
    }
    return { clock, spectrum };
  }, [prices, effWinLen, atomAnalysis]);

  // 各図に渡す固定レンジ(片側)。null=自動伸縮。モードは2図で共有し、
  // 手動値だけは桁が違う(素片平均 ≪ 累積)ので図ごとに持つ。
  const clockFixedRange =
    yFix === "off" ? null : yFix === "manual" ? Math.max(0.0001, yManual / 100) : yEnvelope.clock;
  const spectrumFixedRange =
    yFix === "off" ? null : yFix === "manual" ? Math.max(0.00005, yManualSpec / 100) : yEnvelope.spectrum;

  // === 原系列ミニマップ(全期間の株価 + 現在の窓の位置) ===
  // 時間軸チャートだが、ここでの目的は「全履歴のどこを集計しているか」の一望と
  // ドラッグでの窓移動(ブラシ)。ズーム/パンで全体像が失われると役目を果たさないため、
  // 例外的に Canvas2D を採用する。
  const overviewGeom = useRef<{ left: number; plotW: number; n: number } | null>(null);
  const dragRef = useRef<{ grabOffset: number } | null>(null);

  const drawOverview = useCallback((canvas: HTMLCanvasElement, pts: PricePoint[], from: number, to: number, mode: "latest" | "rolling") => {
    const r = initCanvas(canvas, 128); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 12, bottom: 18, left: 52, right: 12 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const n = pts.length;
    if (n < 2 || plotW <= 0) return;
    overviewGeom.current = { left: pad.left, plotW, n };

    // 対数スケール(10年で数倍動く系列でも窓ごとの相対変化を等しく見せる)
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { const v = Math.log(p.close); if (v < lo) lo = v; if (v > hi) hi = v; }
    const rng = hi - lo || 0.001;
    const toX = (i: number) => pad.left + (plotW * i) / (n - 1);
    const toY = (v: number) => pad.top + plotH * (1 - (Math.log(v) - lo) / rng);

    // 年グリッド
    ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    let prevYear = "";
    for (let i = 0; i < n; i++) {
      const y = pts[i].time.slice(0, 4);
      if (y !== prevYear) {
        if (prevYear) {
          ctx.strokeStyle = "#eceff3"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(toX(i), pad.top); ctx.lineTo(toX(i), pad.top + plotH); ctx.stroke();
          ctx.fillStyle = "#b0b6be"; ctx.fillText(`'${y.slice(2)}`, toX(i), height - 6);
        }
        prevYear = y;
      }
    }

    // 窓の帯
    const x0 = toX(Math.max(0, from));
    const x1 = toX(Math.min(n - 1, to - 1));
    ctx.fillStyle = "rgba(37,99,235,0.10)";
    ctx.fillRect(x0, pad.top, Math.max(2, x1 - x0), plotH);

    // 価格ライン: 全期間は淡いグレー、窓の中だけ青で太く
    ctx.strokeStyle = "#c6cbd2"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = toX(i), y = toY(pts[i].close); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
    ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) {
      const x = toX(i), y = toY(pts[i].close);
      if (i === Math.max(0, from)) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 窓の両端(ローリング時は右端＝いま集計を打ち切っている時点)
    ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 1;
    for (const [x, solid] of [[x0, mode === "latest"], [x1, true]] as [number, boolean][]) {
      ctx.setLineDash(solid ? [] : [3, 2]);
      ctx.beginPath(); ctx.moveTo(x, pad.top - 3); ctx.lineTo(x, pad.top + plotH + 3); ctx.stroke();
    }
    ctx.setLineDash([]);
    // 掴める端のハンドル
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(x0 - 1.5, pad.top - 5, 3, 5);
    ctx.fillRect(x1 - 1.5, pad.top - 5, 3, 5);

    // y軸(価格)
    ctx.fillStyle = "#aab0b8"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 2; i++) {
      const v = Math.exp(lo + (rng * i) / 2);
      ctx.fillText(v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1), pad.left - 5, pad.top + plotH * (1 - i / 2) + 3);
    }

    // 窓の期間ラベル(帯の上)
    ctx.fillStyle = "#2563eb"; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    const lbl = `${pts[Math.max(0, from)]?.time ?? ""} 〜 ${pts[Math.min(n - 1, to - 1)]?.time ?? ""}`;
    const tw = ctx.measureText(lbl).width;
    ctx.fillText(lbl, Math.min(Math.max(pad.left, x0), width - pad.right - tw), 9);
  }, []);

  // ミニマップ上のドラッグで窓を動かす(ローリング=位置、最新起点=窓長)
  const idxFromPointer = useCallback((e: React.PointerEvent<HTMLCanvasElement>): number | null => {
    const g = overviewGeom.current; if (!g) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = (e.clientX - rect.left - g.left) / g.plotW;
    return Math.max(0, Math.min(g.n - 1, Math.round(t * (g.n - 1))));
  }, []);

  const moveWindowTo = useCallback((idx: number) => {
    if (winMode === "rolling") {
      const off = dragRef.current?.grabOffset ?? Math.floor(effWinLen / 2);
      const start = Math.max(0, Math.min(prices.length - effWinLen, idx - off));
      setWinEnd(start + effWinLen);
    } else {
      // 最新起点: 掴んだ点が窓の左端になる = 窓長を決める
      setWinLen(Math.max(60, Math.min(prices.length, prices.length - idx)));
      setWinEnd(prices.length);
    }
  }, [winMode, effWinLen, prices.length]);

  const onOverviewDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const idx = idxFromPointer(e); if (idx === null) return;
    setPlaying(false);
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = effEnd - effWinLen;
    // 窓の内側を掴んだらその相対位置を保って平行移動、外側なら掴んだ点を中心へ
    dragRef.current = { grabOffset: idx >= start && idx < effEnd ? idx - start : Math.floor(effWinLen / 2) };
    moveWindowTo(idx);
  }, [idxFromPointer, moveWindowTo, effEnd, effWinLen]);

  const onOverviewMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    const idx = idxFromPointer(e); if (idx === null) return;
    moveWindowTo(idx);
  }, [idxFromPointer, moveWindowTo]);

  const onOverviewUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  // === エッジ・スペクトル(10素片の平均±SEと有意性) ===
  const drawSpectrum = useCallback((canvas: HTMLCanvasElement, atoms: AtomStat[], fixedRange: number | null) => {
    const r = initCanvas(canvas, 220); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 16, bottom: 36, left: 52, right: 12 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    // fixedRange 指定時は 0 対称の固定スケール。未指定なら窓の中身に合わせて自動伸縮。
    const maxAbs = fixedRange != null ? fixedRange : Math.max(...atoms.map((a) => Math.abs(a.mean) + a.se), 0.0005);
    const zeroY = pad.top + plotH / 2;

    // y軸グリッド
    ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(width - pad.right, zeroY); ctx.stroke();
    ctx.fillStyle = CHART_COLORS.ink; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
    for (const v of [-maxAbs, 0, maxAbs]) {
      const y = zeroY - (v / maxAbs) * (plotH / 2);
      ctx.fillText((v * 100).toFixed(3) + "%", pad.left - 5, y + 3);
    }

    const n = atoms.length;
    const slotW = plotW / n;
    const barW = slotW * 0.55;

    // バー・誤差バー・★はプロット領域にクリップ(固定レンジが小さいと枠外へ出るため)
    ctx.save();
    ctx.beginPath(); ctx.rect(pad.left, pad.top, plotW, plotH); ctx.clip();
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
    }
    ctx.restore();

    // ラベル(曜日色分け)はプロット領域の外なのでクリップ解除後に描く
    for (let i = 0; i < n; i++) {
      const a = atoms[i];
      const cx = pad.left + (i + 0.5) * slotW;
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
  const drawClock = useCallback((canvas: HTMLCanvasElement, cum: number[], atoms: AtomStat[], best: { from: number; to: number } | null, fixedRange: number | null) => {
    const r = initCanvas(canvas, 200); if (!r) return;
    const { ctx, width, height } = r;
    const pad = { top: 16, bottom: 34, left: 52, right: 12 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    // fixedRange 指定時は 0 対称の固定スケール。未指定なら窓の中身に合わせて自動伸縮。
    const lo = fixedRange != null ? -fixedRange : Math.min(...cum);
    const hi = fixedRange != null ? fixedRange : Math.max(...cum);
    const range = hi - lo || 0.001;
    const toY = (v: number) => pad.top + plotH * (1 - (v - lo) / range);
    const toX = (i: number) => pad.left + (plotW * i) / (cum.length - 1);

    // 推奨ロング窓のハイライト
    if (best) {
      ctx.fillStyle = "rgba(22,163,74,0.10)";
      ctx.fillRect(toX(best.from), pad.top, toX(best.to + 1) - toX(best.from), plotH);
    }

    // y軸
    ctx.fillStyle = CHART_COLORS.ink; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
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

    // 累積線・マーカーはプロット領域にクリップ(手動固定でレンジが小さいと曲線が枠外へ出るため)
    ctx.save();
    ctx.beginPath(); ctx.rect(pad.left, pad.top, plotW, plotH); ctx.clip();

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
    ctx.restore();

    // x軸ラベル(素片境界)
    ctx.fillStyle = "#666"; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("週初", toX(0), height - 18);
    atoms.forEach((a, i) => {
      ctx.save();
      ctx.translate(toX(i + 1), height - 20); ctx.rotate(-Math.PI / 6);
      ctx.fillStyle = CHART_COLORS.ink; ctx.fillText(a.label, 0, 0);
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
    if (overviewRef.current) drawOverview(overviewRef.current, prices, effEnd - effWinLen, effEnd, winMode);
    if (spectrumRef.current) drawSpectrum(spectrumRef.current, windowAnalysis.atoms, spectrumFixedRange);
    if (clockRef.current) drawClock(clockRef.current, windowAnalysis.cumulative, windowAnalysis.atoms, windowAnalysis.bestLong, clockFixedRange);
    if (atomYearRef.current) drawAtomYear(atomYearRef.current, atomAnalysis.atoms, atomAnalysis.yearly);
  }, [prices, effEnd, effWinLen, winMode, resizeTick, atomAnalysis, windowAnalysis, clockFixedRange, spectrumFixedRange, drawOverview, drawSpectrum, drawClock, drawAtomYear]);

  if (prices.length < 60) {
    return <div className="text-xs text-fg-muted p-3">データが不足しています(60営業日以上必要)。</div>;
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

      {/* ===== 対象期間コントロール(スペクトル・週内クロック) ===== */}
      <div className="rounded border border-gray-100 bg-gray-50/60 p-2.5 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-gray-600 font-medium">対象期間（スペクトル・週内クロック）</span>
          {/* モード切替 */}
          <div className="inline-flex rounded overflow-hidden border border-gray-200">
            {([["latest", "最新起点"], ["rolling", "ローリング"]] as [typeof winMode, string][]).map(([m, lbl]) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className={`px-2 py-0.5 text-[11px] ${winMode === m ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-100"}`}
              >{lbl}</button>
            ))}
          </div>
          <span className="text-gray-500">
            <span className="font-mono text-gray-700">{winStartDate}</span> 〜 <span className="font-mono text-gray-700">{winEndDate}</span>
            <span className="text-fg-muted">（{effWinLen.toLocaleString()}本 ≈{(effWinLen / 252).toFixed(1)}年 / {clockSample.totalDays.toLocaleString()}営業日）</span>
            {isFullWindow && <span className="text-fg-muted"> ・全期間</span>}
          </span>
          {winStats && (
            <span className="text-fg-muted">
              窓内 <span className={`font-mono ${colorCls(winStats.ret)}`}>{winStats.ret >= 0 ? "+" : ""}{(winStats.ret * 100).toFixed(1)}%</span>
              {" "}・年率σ <span className="font-mono text-gray-600">{(winStats.vol * 100).toFixed(1)}%</span>
            </span>
          )}
        </div>

        {/* 窓長プリセット(共通) */}
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-gray-500 mr-0.5">窓長</span>
          {([["1M", 21], ["2M", 42], ["3M", 63], ["6M", 126], ["1Y", 252], ["2Y", 504], ["3Y", 756]] as [string, number][])
            .filter(([, n]) => n < prices.length)
            .map(([lbl, n]) => (
              <button
                key={lbl}
                type="button"
                onClick={() => setLen(n)}
                className={`px-1.5 py-0.5 rounded text-[11px] ${!isFullWindow && effWinLen === n ? "bg-blue-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}
              >{lbl}</button>
            ))}
          {winMode === "latest" && (
            <button
              type="button"
              onClick={() => setWinLen(prices.length)}
              className={`px-1.5 py-0.5 rounded text-[11px] ${isFullWindow ? "bg-blue-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}
            >全期間</button>
          )}
        </div>

        {/* 原系列ミニマップ: 全履歴のどこを集計しているかを一望し、ドラッグで窓を動かす */}
        <div className="w-full rounded border border-gray-200 bg-white overflow-hidden">
          <canvas
            ref={overviewRef}
            className="touch-none cursor-ew-resize"
            onPointerDown={onOverviewDown}
            onPointerMove={onOverviewMove}
            onPointerUp={onOverviewUp}
            onPointerCancel={onOverviewUp}
          />
        </div>
        <p className="text-[10px] text-fg-muted">
          青い帯＝いま下のスペクトル／週内クロックが集計している期間（原系列の対数スケール）。
          {winMode === "rolling"
            ? "帯をドラッグすると窓ごと平行移動、帯の外をクリックするとその日を中心に移動します。"
            : "グラフをドラッグすると掴んだ日が窓の左端になり、窓長が変わります（右端は常に最新）。"}
        </p>

        {winMode === "latest" ? (
          <>
            <input
              type="range"
              min={60}
              max={prices.length}
              step={1}
              value={effWinLen}
              onChange={(e) => { setWinLen(Number(e.target.value)); setWinEnd(prices.length); }}
              className="w-full accent-blue-600"
              aria-label="窓長"
            />
            <p className="text-[10px] text-fg-muted">
              スライダーで窓長を変更（右端は常に最新）。左に動かすほど新しい期間だけで集計し直します。曲線の形が期間で大きく変わる＝そのエッジは不安定。素片×年ヒートマップは全履歴のまま（年次推移を見るため）。
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPlaying((v) => !v)}
                className={`px-2 py-0.5 rounded text-[11px] whitespace-nowrap ${playing ? "bg-amber-500 text-white hover:bg-amber-600" : "bg-blue-600 text-white hover:bg-blue-700"}`}
                aria-label={playing ? "停止" : "再生"}
              >{playing ? "⏸ 停止" : "▶ 再生"}</button>
              <input
                type="range"
                min={effWinLen}
                max={prices.length}
                step={1}
                value={effEnd}
                onChange={(e) => { setPlaying(false); setWinEnd(Number(e.target.value)); }}
                className="w-full accent-blue-600"
                aria-label="窓の位置(右端)"
              />
              <button
                type="button"
                onClick={() => { setPlaying(false); setWinEnd(prices.length); }}
                disabled={barsAfter === 0}
                className={`px-1.5 py-0.5 rounded text-[11px] whitespace-nowrap ${barsAfter === 0 ? "bg-gray-100 text-fg-muted" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"}`}
              >最新へ</button>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              <label className="flex items-center gap-1 text-gray-500">
                速度
                <select className="border rounded px-1 py-0.5" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                  {([["ゆっくり(8本/秒)", 8], ["標準(30本/秒)", 30], ["速い(80本/秒)", 80], ["最速(200本/秒)", 200]] as [string, number][])
                    .map(([lbl, v]) => <option key={v} value={v}>{lbl}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1 text-gray-500">
                <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
                ループ
              </label>
              {/* 進捗バー(窓の位置) */}
              <div className="flex items-center gap-1 flex-1 min-w-[120px]">
                <div className="relative h-1 flex-1 rounded bg-gray-200 overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0 bg-blue-500"
                    style={{ width: `${prices.length > effWinLen ? ((effEnd - effWinLen) / (prices.length - effWinLen)) * 100 : 100}%` }}
                  />
                </div>
                <span className="font-mono text-fg-muted tabular-nums">{winEndDate}</span>
              </div>
            </div>
            <p className="text-[10px] text-fg-muted">
              固定した窓長（上のプリセット。<span className="font-medium">1M/2M</span> など短い窓ほど変化が細かく見えます）を保ったまま、<span className="font-medium">▶ 再生</span>で窓の位置を過去→最新へ自動スライドし、曜日リターン（スペクトル・週内クロック）の移り変わりをアニメーションで確認できます。スライダーを掴む／「最新へ」で一時停止（現在は最新から <span className="font-mono">{barsAfter.toLocaleString()}</span> 本前で終了）。素片×年ヒートマップは全履歴のまま。
            </p>
          </>
        )}

        {/* 縦(リターン)軸スケール: スペクトルと週内クロックで共通 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] pt-1.5 border-t border-gray-200">
          <span className="text-gray-600 font-medium">縦軸（スペクトル・週内クロック共通）</span>
          <div className="inline-flex rounded overflow-hidden border border-gray-200">
            {([["off", "自動"], ["envelope", "固定(全位置)"], ["manual", "固定(手動)"]] as [typeof yFix, string][]).map(([m, lbl]) => (
              <button
                key={m}
                type="button"
                onClick={() => setYFix(m)}
                className={`px-2 py-0.5 ${yFix === m ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-100"}`}
              >{lbl}</button>
            ))}
          </div>
          {yFix === "manual" && (
            <>
              {/* 素片平均(≈0.1%台)と累積(≈1%台)は桁が違うので入力は図ごと */}
              <label className="flex items-center gap-1 text-gray-500">
                スペクトル ±
                <input
                  type="number"
                  min={0.01}
                  step={0.05}
                  value={yManualSpec}
                  onChange={(e) => setYManualSpec(Math.max(0.005, Number(e.target.value) || 0.005))}
                  className="w-16 border rounded px-1 py-0.5 text-right"
                  aria-label="エッジ・スペクトルの縦軸の片側レンジ(%)"
                />
                %
              </label>
              <label className="flex items-center gap-1 text-gray-500">
                クロック ±
                <input
                  type="number"
                  min={0.05}
                  step={0.05}
                  value={yManual}
                  onChange={(e) => setYManual(Math.max(0.01, Number(e.target.value) || 0.01))}
                  className="w-16 border rounded px-1 py-0.5 text-right"
                  aria-label="週内クロックの縦軸の片側レンジ(%)"
                />
                %
              </label>
            </>
          )}
          {yFix === "envelope" && (
            <span className="text-fg-muted">
              スペクトル ±{(yEnvelope.spectrum * 100).toFixed(3)}% ／ クロック ±{(yEnvelope.clock * 100).toFixed(3)}%
              （この窓長の全ローリング位置を包む）
            </span>
          )}
          {yFix !== "off" && (
            <span className="text-fg-muted">窓の位置・窓長を動かしても目盛が固定されるので、局面ごとの振幅の大小をそのまま比較できます。</span>
          )}
        </div>
      </div>

      {/* ===== (A) エッジ・スペクトル / 週内クロック(同じ窓の2つの見方を並べて同時に見る) ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-4 gap-y-3 items-start">
      <div>
        <div className="text-xs text-gray-500 mb-1">
          エッジ・スペクトル: 週内10素片の平均対数リターン(±標準誤差・有意性)
          {yFix !== "off" && <span className="text-blue-500">｜縦軸固定 ±{(spectrumFixedRange! * 100).toFixed(3)}%</span>}
        </div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={spectrumRef} /></div>
      </div>

      {/* ===== (A) 週内クロック ===== */}
      <div>
        <div className="text-xs text-gray-500 mb-1">
          週内クロック: 素片を時間順に積み上げた累積平均リターン(谷で買い・山で売り)
          <span className="text-fg-muted">
            {" "}｜対象 {clockSample.totalDays.toLocaleString()} 営業日（各曜日 n={clockSample.minN}〜{clockSample.maxN} 週）から算出
          </span>
          {yFix !== "off" && <span className="text-blue-500">｜縦軸固定 ±{(clockFixedRange! * 100).toFixed(3)}%</span>}
        </div>
        <div className="w-full rounded border border-gray-100 overflow-hidden"><canvas ref={clockRef} /></div>
      </div>
      </div>

      {/* 最良窓(週内クロックの最大/最小連続部分和) */}
      <div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          {bl && (
            <div className="p-2 bg-green-50 rounded border border-green-100">
              <span className="text-gray-500">最良ロング窓(素片の最大連続和):</span>{" "}
              <span className="font-medium text-green-700">{labelSpec(bl.spec)}</span>{" "}
              <span className="font-mono text-green-700">合計 {pct(bl.sum)}</span>
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
        <p className="text-[10px] text-fg-muted mt-1">緑=プラス/赤=マイナス、濃さ=全セル最大絶対値に対する相対。横に同色が続く素片=持続的なエッジ。1年だけ極端=見かけ倒し。N&lt;2の年は灰色。</p>
      </div>

      {/* ===== (B) 戦略ランキング ===== */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <button
            type="button"
            onClick={() => setRankingOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
          >
            <span className="text-gray-500">{rankingOpen ? "▼" : "▶"}</span>
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
          <p className="text-[10px] text-fg-muted">上のタイトルをクリックすると全戦略のランキング表を表示します。</p>
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
                    <td className={`text-center px-1 font-medium ${s.direction === "long" ? "text-green-700" : "text-red-600"}`}>{s.direction === "long" ? "買" : "売"}</td>
                    <td className="text-right px-1 text-gray-500">{s.n}</td>
                    <td className={`text-right px-1 font-mono ${colorCls(s.annualized)}`}>{pct(s.annualized, 1)}</td>
                    <td className="text-right px-1 font-mono text-gray-700">{s.sharpe.toFixed(2)}</td>
                    <td className="text-right px-1 font-mono text-gray-700">{s.t.toFixed(2)}</td>
                    <td className={`text-right px-1 font-mono ${sig ? "text-blue-600 font-medium" : "text-fg-muted"}`}>{s.pAdj.toFixed(3)}{star(s.pAdj)}</td>
                    <td className="text-right px-1 font-mono text-gray-600">{Math.round(s.yearsPositive * 100)}%<span className="text-fg-muted">({s.nYears})</span></td>
                    <td className="text-center px-1">{s.halfAgree ? <span className="text-green-700">✓</span> : <span className="text-gray-500">–</span>}</td>
                    <td className="text-right px-1.5 font-mono text-gray-600 whitespace-nowrap">
                      {s.ciLo !== null && s.ciHi !== null
                        ? <span className={s.ciLo > 0 || s.ciHi < 0 ? "text-blue-600" : "text-fg-muted"}>[{pct(s.ciLo, 2)}, {pct(s.ciHi, 2)}]</span>
                        : <span className="text-gray-500">–</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-fg-muted mt-1">
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
          <li><span className="font-medium">原系列ミニマップ:</span> 青い帯が、その下のスペクトル・週内クロックが集計している期間そのもの。
            曜日効果は<span className="font-medium">局面依存</span>なので、「いま見ている曲線がどの相場から出てきたのか」を必ず突き合わせる。
            上昇トレンド中の窓では全素片が上方に、暴落局面の窓では夜間素片だけが大きく負に振れる、といった形で現れる。
            帯をドラッグ（またはローリング＋▶再生）して曲線の形が窓の位置でころころ変わるなら、そのエッジは局面固有＝将来に持ち越せない。
            窓内の騰落・年率σの表示は、その窓が強気/弱気・平穏/荒れのどれかを一言で示す。</li>
          <li><span className="font-medium">エッジ・スペクトル:</span> 濃い緑/赤+★が付いた素片に、週内リターンの偏りが集中している。</li>
          <li><span className="font-medium">縦軸の固定（スペクトル・クロック共通）:</span> 自動伸縮のままだと、窓を動かしたとき
            「振幅が変わった」のか「目盛が変わった」のか区別できず、<span className="font-medium">形しか比べられない</span>。
            「固定(全位置)」はその窓長で取りうる全ローリング位置を包む目盛に揃えるので、
            どの局面のエッジが<span className="font-medium">絶対値として大きいか</span>を直接比較できる
            （例: 平穏期の素片平均は目盛いっぱいに見えても、暴落期に比べれば数分の一しかない）。
            2図で同じモードが効くため、素片単位の偏り(スペクトル)と積み上げ後の到達点(クロック)を同じ土俵で読める。</li>
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

      <AxiomPlacement corollaryId="C9" />
    </div>
  );
}

// SpecStat.spec / atom窓のラベル整形
function labelSpec(s: { entryDow: number; entryTiming: string; exitDow: number; exitTiming: string }): string {
  const dow = ["", "月", "火", "水", "木", "金"];
  const tm: Record<string, string> = { open: "始値", close: "終値" };
  return `${dow[s.entryDow]}${tm[s.entryTiming]} → ${dow[s.exitDow]}${tm[s.exitTiming]}`;
}
