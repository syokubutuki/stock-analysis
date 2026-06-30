"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import {
  computeWeekClockDaily,
  computeWeekClockIntraday,
  WeekClockDaily,
  WeekClockIntraday,
  AnchorMode,
} from "../../lib/week-clock";
import { useIntraday } from "../../hooks/useIntraday";
import {
  initCanvas,
  IntervalButtons,
  ViewTabs,
  LoadingError,
  StatCell,
  IntradayCaveat,
} from "./intradayShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
  ticker: string;
}

type Gran = "daily" | "intraday";
type DailyView = "candle" | "band";
const DAILY_VIEWS: { value: DailyView; label: string }[] = [
  { value: "candle", label: "累積足＋中央値" },
  { value: "band", label: "分布帯" },
];

const pctStr = (v: number, d = 2) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;

// ───────────────────────── 日足: 累積足 ─────────────────────────
function drawDailyCandle(ctx: CanvasRenderingContext2D, W: number, H: number, r: WeekClockDaily) {
  const ml = 52, mr = 16, mt = 26, mb = 26;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const slots = r.slots.filter((s) => s.n > 0);
  if (slots.length === 0) return;

  // Y範囲: meanHigh の最大・meanLow の最小に余白
  let yMax = 0, yMin = 0;
  for (const s of slots) {
    if (s.meanHigh > yMax) yMax = s.meanHigh;
    if (s.p90 > yMax) yMax = s.p90;
    if (s.meanLow < yMin) yMin = s.meanLow;
    if (s.p10 < yMin) yMin = s.p10;
  }
  const pad = (yMax - yMin) * 0.08 || 0.005;
  yMax += pad; yMin -= pad;
  const yOf = (v: number) => mt + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  const origin = r.anchorMode === "monday" ? "月曜始値" : "週初日の始値";
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`${origin}=0 を原点とした累積OHLC（実体=平均終値, ヒゲ=平均累積高安）`, ml, mt - 12);

  // Yグリッド & ゼロ線
  ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = yMin + ((yMax - yMin) * i) / ticks;
    const y = yOf(v);
    ctx.strokeStyle = Math.abs(v) < 1e-9 ? "#9ca3af" : "#f1f1f1";
    ctx.setLineDash(Math.abs(v) < 1e-9 ? [3, 3] : []);
    ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke();
    ctx.fillStyle = "#9ca3af"; ctx.fillText(`${(v * 100).toFixed(1)}%`, ml - 5, y + 3);
  }
  ctx.setLineDash([]);
  const y0 = yOf(0);
  ctx.fillStyle = "#6b7280"; ctx.textAlign = "left"; ctx.font = "9px sans-serif";
  ctx.fillText(origin, ml + 2, y0 - 3);

  const slot = plotW / slots.length;
  const bw = Math.min(34, slot * 0.5);

  // 累積足（全スロット open=0 を共有）
  slots.forEach((s, i) => {
    const cx = ml + i * slot + slot / 2;
    const up = s.meanClose >= 0;
    const col = up ? "#16a34a" : "#dc2626";
    // ヒゲ（累積高安）
    ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, yOf(s.meanHigh)); ctx.lineTo(cx, yOf(s.meanLow)); ctx.stroke();
    // 実体（0 ～ meanClose）
    const yc = yOf(s.meanClose);
    const top = Math.min(y0, yc), bot = Math.max(y0, yc);
    ctx.fillStyle = up ? "#16a34acc" : "#dc2626cc";
    ctx.fillRect(cx - bw / 2, top, bw, Math.max(1, bot - top));
  });

  // 中央値終値パス（線）
  ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 2; ctx.beginPath();
  slots.forEach((s, i) => {
    const cx = ml + i * slot + slot / 2;
    const y = yOf(s.medianClose);
    if (i === 0) ctx.moveTo(cx, y); else ctx.lineTo(cx, y);
  });
  ctx.stroke();
  slots.forEach((s, i) => {
    const cx = ml + i * slot + slot / 2;
    ctx.fillStyle = "#1d4ed8"; ctx.beginPath(); ctx.arc(cx, yOf(s.medianClose), 2.5, 0, Math.PI * 2); ctx.fill();
  });

  // X軸ラベル & n
  ctx.textAlign = "center"; ctx.font = "10px sans-serif";
  slots.forEach((s, i) => {
    const cx = ml + i * slot + slot / 2;
    ctx.fillStyle = "#374151"; ctx.fillText(s.label, cx, mt + plotH + 14);
    ctx.fillStyle = "#9ca3af"; ctx.font = "8px sans-serif";
    ctx.fillText(`n=${s.n}`, cx, mt + plotH + 23);
    ctx.font = "10px sans-serif";
  });

  // 凡例
  ctx.textAlign = "left"; ctx.font = "9px sans-serif";
  ctx.fillStyle = "#1d4ed8"; ctx.fillText("─ 中央値の終値パス", ml + 4, mt + 12);
}

// ───────────────────────── 日足: 分布帯 ─────────────────────────
function drawDailyBand(ctx: CanvasRenderingContext2D, W: number, H: number, r: WeekClockDaily) {
  const ml = 52, mr = 16, mt = 26, mb = 26;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const slots = r.slots.filter((s) => s.n > 0);
  if (slots.length === 0) return;

  let yMax = 0, yMin = 0;
  for (const s of slots) { if (s.p90 > yMax) yMax = s.p90; if (s.p10 < yMin) yMin = s.p10; }
  const pad = (yMax - yMin) * 0.08 || 0.005;
  yMax += pad; yMin -= pad;
  const yOf = (v: number) => mt + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("週初比 終値リターンの分布（帯=10–90%/25–75%, 線=中央値）", ml, mt - 12);

  ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  for (let i = 0; i <= 5; i++) {
    const v = yMin + ((yMax - yMin) * i) / 5;
    const y = yOf(v);
    ctx.strokeStyle = Math.abs(v) < 1e-9 ? "#9ca3af" : "#f1f1f1";
    ctx.setLineDash(Math.abs(v) < 1e-9 ? [3, 3] : []);
    ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke();
    ctx.fillStyle = "#9ca3af"; ctx.fillText(`${(v * 100).toFixed(1)}%`, ml - 5, y + 3);
  }
  ctx.setLineDash([]);

  const slot = plotW / slots.length;
  const xOf = (i: number) => ml + i * slot + slot / 2;
  const ribbon = (lo: (s: typeof slots[number]) => number, hi: (s: typeof slots[number]) => number, color: string) => {
    ctx.fillStyle = color; ctx.beginPath();
    slots.forEach((s, i) => { const x = xOf(i), y = yOf(hi(s)); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    for (let i = slots.length - 1; i >= 0; i--) ctx.lineTo(xOf(i), yOf(lo(slots[i])));
    ctx.closePath(); ctx.fill();
  };
  ribbon((s) => s.p10, (s) => s.p90, "#3b82f622");
  ribbon((s) => s.p25, (s) => s.p75, "#3b82f644");

  ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 2; ctx.beginPath();
  slots.forEach((s, i) => { const x = xOf(i), y = yOf(s.medianClose); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();

  ctx.textAlign = "center"; ctx.font = "10px sans-serif";
  slots.forEach((s, i) => {
    ctx.fillStyle = "#374151"; ctx.fillText(s.label, xOf(i), mt + plotH + 14);
    ctx.fillStyle = "#9ca3af"; ctx.font = "8px sans-serif";
    ctx.fillText(`${(s.upRate * 100).toFixed(0)}%↑`, xOf(i), mt + plotH + 23);
    ctx.font = "10px sans-serif";
  });
}

// ───────────────────────── 日中足: 連続クロック ─────────────────────────
function drawIntradayClock(ctx: CanvasRenderingContext2D, W: number, H: number, r: WeekClockIntraday) {
  const ml = 52, mr = 16, mt = 26, mb = 30;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const pts = r.points;
  if (pts.length < 2) return;

  let yMax = 0, yMin = 0;
  for (const p of pts) { if (p.meanHigh > yMax) yMax = p.meanHigh; if (p.meanLow < yMin) yMin = p.meanLow; }
  const pad = (yMax - yMin) * 0.08 || 0.005;
  yMax += pad; yMin -= pad;
  const yOf = (v: number) => mt + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  const xOf = (i: number) => ml + (i / (pts.length - 1)) * plotW;

  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 1; ctx.strokeRect(ml, mt, plotW, plotH);
  const originLabel = r.anchorMode === "monday" ? "月曜寄り" : "週初日寄り";
  ctx.fillStyle = "#374151"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`${originLabel}=0 からの週内クロック（帯=平均累積高安, 線=平均終値）`, ml, mt - 12);

  ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  for (let i = 0; i <= 5; i++) {
    const v = yMin + ((yMax - yMin) * i) / 5;
    const y = yOf(v);
    ctx.strokeStyle = Math.abs(v) < 1e-9 ? "#9ca3af" : "#f4f4f4";
    ctx.setLineDash(Math.abs(v) < 1e-9 ? [3, 3] : []);
    ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke();
    ctx.fillStyle = "#9ca3af"; ctx.fillText(`${(v * 100).toFixed(1)}%`, ml - 5, y + 3);
  }
  ctx.setLineDash([]);

  // 高安エンベロープ
  ctx.fillStyle = "#3b82f622"; ctx.beginPath();
  pts.forEach((p, i) => { const x = xOf(i), y = yOf(p.meanHigh); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(xOf(i), yOf(pts[i].meanLow));
  ctx.closePath(); ctx.fill();

  // 曜日区切り & ラベル
  ctx.textAlign = "center";
  pts.forEach((p, i) => {
    if (!p.isWeekdayStart) return;
    const x = xOf(i);
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, mt); ctx.lineTo(x, mt + plotH); ctx.stroke();
    ctx.fillStyle = "#374151"; ctx.font = "bold 10px sans-serif";
    ctx.fillText(p.label.split(" ")[0], x + 16, mt + plotH + 14);
  });

  // 平均終値パス
  ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 2; ctx.beginPath();
  pts.forEach((p, i) => { const x = xOf(i), y = yOf(p.meanClose); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();

  // 終点ラベル（最終スロットの引け）
  const last = pts[pts.length - 1];
  ctx.fillStyle = "#1d4ed8"; ctx.textAlign = "left"; ctx.font = "9px sans-serif";
  ctx.fillText(`${last.label.split(" ")[0]}引け ${pctStr(last.meanClose)}`, ml + 4, mt + 12);
}

const H = 340;

export default function WeekClockChart({ prices, ticker }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gran, setGran] = useState<Gran>("daily");
  const [anchorMode, setAnchorMode] = useState<AnchorMode>("monday");
  const [dailyView, setDailyView] = useState<DailyView>("candle");
  const [intervalKey, setIntervalKey] = useState("30m");

  const daily = useMemo<WeekClockDaily | null>(
    () => (prices.length >= 10 ? computeWeekClockDaily(prices, anchorMode) : null),
    [prices, anchorMode]
  );

  const { resp, loading, error } = useIntraday(gran === "intraday" ? ticker : "", intervalKey);
  const binMinutes = intervalKey === "60m" ? 60 : intervalKey === "15m" ? 15 : intervalKey === "5m" ? 5 : 30;
  const intra = useMemo<WeekClockIntraday | null>(
    () => (gran === "intraday" && resp ? computeWeekClockIntraday(resp.bars, resp.gmtoffset, binMinutes, anchorMode) : null),
    [gran, resp, binMinutes, anchorMode]
  );

  useEffect(() => {
    if (!canvasRef.current) return;
    const init = initCanvas(canvasRef.current, H);
    if (!init) return;
    const { ctx, width } = init;
    if (gran === "daily") {
      if (!daily) return;
      if (dailyView === "candle") drawDailyCandle(ctx, width, H, daily);
      else drawDailyBand(ctx, width, H, daily);
    } else if (intra) {
      drawIntradayClock(ctx, width, H, intra);
    }
  }, [gran, daily, dailyView, intra]);

  if (prices.length < 10) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">週内クロック（月曜始値基準の累積OHLC）</h3>
        <div className="flex gap-1">
          <button
            onClick={() => setGran("daily")}
            className={`px-2.5 py-1 text-xs rounded font-medium ${gran === "daily" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >日足</button>
          <button
            onClick={() => setGran("intraday")}
            className={`px-2.5 py-1 text-xs rounded font-medium ${gran === "intraday" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >日中足</button>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 items-center">
          <span className="text-xs text-gray-500">原点:</span>
          {([["monday", "月曜のみ"], ["firstday", "週初日"]] as [AnchorMode, string][]).map(([m, l]) => (
            <button
              key={m}
              onClick={() => setAnchorMode(m)}
              className={`px-2 py-0.5 text-xs rounded ${anchorMode === m ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >{l}</button>
          ))}
        </div>
        {gran === "daily" && <ViewTabs value={dailyView} onChange={setDailyView} views={DAILY_VIEWS} />}
        {gran === "intraday" && <IntervalButtons value={intervalKey} onChange={setIntervalKey} />}
      </div>

      {gran === "intraday" && <LoadingError loading={loading} error={error} />}

      <div className="relative"><canvas ref={canvasRef} /></div>

      {gran === "daily" && daily && (
        <>
          <div className="text-xs text-gray-500">
            対象 {daily.nWeeks} 週（{anchorMode === "monday" ? "月曜のある週のみ・暦の曜日で整列" : "各週の最初の営業日を原点・営業日序数で整列"}）
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 text-xs">
            {daily.slots.filter((s) => s.n > 0).map((s) => (
              <StatCell
                key={s.dow}
                label={`${s.label}・週初比`}
                value={`${pctStr(s.meanClose)}（${(s.upRate * 100).toFixed(0)}%↑）`}
                tone={s.meanClose >= 0 ? "up" : "down"}
              />
            ))}
          </div>
          <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
            {anchorMode === "monday"
              ? "各曜日のローソクは「月曜始値を0としたその曜日終値までの累積OHLC」。実体=平均終値、ヒゲ上端=週初からの平均累積高値、下端=平均累積安値。青線は中央値の終値パス。終値が右肩上がりなら週内ドリフトは上向き、ヒゲが早い曜日で大きく開くなら週前半に値幅が出やすい。"
              : "各スロットは「その週の最初の営業日の始値を0とした、n営業日目終値までの累積OHLC」。祝日で月曜が無い週も『1日目＝原点』で揃えるため、暦の曜日ではなく営業日序数で整列する（曜日混入による経路の歪みを回避）。実体=平均終値、ヒゲ=平均累積高安、青線=中央値の終値パス。"}
          </p>
        </>
      )}

      {gran === "intraday" && intra && !loading && !error && (
        <>
          <div className="text-xs text-gray-500">
            対象 {intra.nWeeks} 週 / {resp?.interval} 足 / {binMinutes}分ビン
            {resp?.timezone ? `（${resp.timezone}）` : ""}
          </div>
          <p className="text-xs text-gray-600 bg-gray-50 rounded p-2 leading-relaxed">
            {"月曜寄り付きを0として、週内の時間帯ごとに累積終値（青線）と累積高安の帯（水色）を平均。週のどの時間帯で上昇/下落が進み、いつ高値・安値を付けやすいかを連続的に追える。"}
          </p>
          <IntradayCaveat />
        </>
      )}

      <AnalysisGuide title="週内クロック（週内アノマリーの累積版）の詳細理論">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"曜日アノマリーの多くは『各曜日の単日リターン』を平均する。これは“点”の情報で、週の中で価格が描く“経路の形”は見えない。本分析は月曜の始値を毎週の原点(=0)に固定し、そこからの累積した値動き（週初比の終値ドリフトと、到達した高値・安値の広がり）を多数の週で重ね合わせる。『典型的な1週間の形』——どの曜日・時間帯で上げ切るか、いつ高安を付けるか、週後半に戻すか——を捉えるのが目的。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式（週 w、その週の月曜始値 O_mon）</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"正規化: 価格 p を原点比の対数リターン r = ln(p / O_mon) に変換。月曜始値では r=0。"}</li>
          <li>{"累積終値: cumClose(d) = ln(C_d / O_mon)。C_d はその曜日(または時間帯)の終値。"}</li>
          <li>{"累積高値: cumHigh(d) = ln( max_{i≤d} H_i / O_mon )（週初からその時点までの高値の走査最大）。"}</li>
          <li>{"累積安値: cumLow(d) = ln( min_{i≤d} L_i / O_mon )（同・走査最小）。"}</li>
          <li>{"集約: 各曜日(時間帯)スロットで cumClose の平均・中央値・分位点(10/25/75/90%)、cumHigh・cumLow の平均、cumClose>0 の割合(週初比プラス確率)を多数週で計算。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 用語</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>原点(アンカー)と整列</strong>: 毎週リセットする基準点。<strong>月曜のみ</strong>モードは月曜始値を原点とし、月曜が無い祝日週は除外して<strong>暦の曜日</strong>(月〜金)で集計する。<strong>週初日</strong>モードはその週最初の営業日の始値を原点とし、<strong>営業日序数</strong>(1日目〜5日目)で集計する。後者で曜日集計にすると、祝日週の火曜が別原点(火曜始値)のまま火曜スロットに混入し経路が歪むため、序数整列でこれを防いでいる。</li>
          <li><strong>走査最大/最小</strong>: 週初から現時点までの最大値・最小値（ランニング極値）。週が到達したレンジの“外枠”を表す。</li>
          <li><strong>累積足</strong>: open を常に0(月曜始値)に固定したローソク。実体が右へ伸び、ヒゲが週の経過とともに広がる。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>中央値の終値パスが右肩上がり → 週を通じて上方ドリフト。途中で山を作って戻すなら週央が高い「週内反転」型。</li>
          <li>累積高値のヒゲが早い曜日で大きく開く → 週前半に上値を試しやすい（週初の戻り売り/利確が有効な兆候）。</li>
          <li>累積安値が金曜にかけて深くなる → 週末にかけて売られやすい。</li>
          <li>分布帯（10–90%）が広い曜日 → その曜日時点でのばらつきが大きく、平均は当てにしにくい。upRate(週初比プラス確率)と併読する。</li>
          <li>日中足クロックでは、特定曜日の特定時間帯（例: 金曜後場）で青線が折れる位置＝週の高安形成時刻の目安。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>週またぎスイングのエントリー/イグジット曜日選び（『曜日トレード・シミュレータ』『曜日エッジスキャン』の裏付け）。</li>
          <li>累積高安のヒゲから、週内の利確目標・想定レンジ（≒平均的な上下到達幅）を見積もる。</li>
          <li>週内反転型なら週央の高値で手仕舞い、上方ドリフト型なら金曜引けまでホールド、と週内の保有設計に使う。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"曜日アノマリーは時期で減衰する。期間セレクタを変えて持続性を確認すること。"}</li>
          <li>{"祝日週はスロットが欠ける。週数n（各StatCell併記）が少ない曜日の平均は不安定。"}</li>
          <li>{"累積高安の平均は『各週がその時点までに到達した極値』の平均であり、毎週必ずそこまで動くわけではない（外枠の期待値）。"}</li>
          <li>{"日中足はYahooの取得期間が短く（5/15/30分足≈60日→十数週）、サンプルが薄い。60分足は約2年取れるが粒度は粗い。"}</li>
          <li>{"対数リターンで集計しているため、表示%は厳密には連続複利。小さい値ではほぼ単利%と一致する。"}</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
