"use client";

// 今週の値動きの軌跡アナログ比較(日足)。
// 今週(直近L営業日)の経路を、①似た形の過去局面(similar) か ②前夜米国ビンで絞った過去局面(usbin)
// と突き合わせ、「今日(t=0)に至る経路(リードイン)」と「その後H日(フォワード)」を1枚で見る。
// すべて窓末=今日=0%に再基準化するため、t=0で全系列が収束し、左=形の比較 / 右=先読み分布 になる。

import { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { computeUsReturns, BinScheme } from "../../lib/us-spillover-core";
import { useUsDaily } from "../../hooks/useUsDaily";
import {
  computeWeeklyAnalog, WeeklyAnalogResult, AnalogMode, UsMode,
} from "../../lib/weekly-analog";
import { UsDriverButtons, BinSchemeButtons } from "./usSpilloverShared";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const L_PRESETS = [5, 10, 20];
const H_PRESETS = [5, 10, 20];
const K_PRESETS = [10, 20, 30];

function initCanvas(canvas: HTMLCanvasElement, height: number) {
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

function fmtPct(v: number, d = 1): string {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
}

function draw(ctx: CanvasRenderingContext2D, width: number, height: number, r: WeeklyAnalogResult) {
  const { L, H } = r;
  const ml = 46, mr = 16, mt = 22, mb = 24;
  const plotW = width - ml - mr, plotH = height - mt - mb;
  const tMin = -(L - 1), tMax = H, tSpan = tMax - tMin || 1;
  const xOf = (t: number) => ml + ((t - tMin) / tSpan) * plotW;

  // y範囲: 全系列(クエリ・選抜アナログ・帯・高安到達)から
  const all: number[] = [
    ...r.query.lead, ...r.query.leadHigh, ...r.query.leadLow,
    ...r.leadP25, ...r.leadP75, ...r.fwdP25, ...r.fwdP75,
    ...r.fwdHighMedian, ...r.fwdLowMedian,
  ];
  for (const s of r.selected) { all.push(...s.lead, ...s.forward); }
  const maxV = Math.max(0.01, ...all.map((v) => Math.abs(v)));
  const yOf = (v: number) => mt + plotH / 2 - (v / maxV) * (plotH / 2 - 4);

  // ゼロ線
  ctx.strokeStyle = "#e5e7eb"; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(ml, yOf(0)); ctx.lineTo(ml + plotW, yOf(0)); ctx.stroke();
  ctx.setLineDash([]);
  // y目盛
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(`+${(maxV * 100).toFixed(0)}%`, ml - 4, mt + 8);
  ctx.fillText("0%", ml - 4, yOf(0) + 3);
  ctx.fillText(`-${(maxV * 100).toFixed(0)}%`, ml - 4, mt + plotH);

  // t=0(今日)の縦線
  ctx.strokeStyle = "#cbd5e1"; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(xOf(0), mt); ctx.lineTo(xOf(0), mt + plotH); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#64748b"; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("今", xOf(0), mt - 6);
  ctx.fillStyle = "#94a3b8"; ctx.font = "9px sans-serif";
  ctx.fillText("← 今週の経路", xOf(tMin / 2), mt - 6);
  ctx.fillText("その後 →", xOf(H / 2), mt - 6);

  // フォワード 25-75 帯(t=0..H)
  ctx.fillStyle = "rgba(37,99,235,0.13)";
  ctx.beginPath();
  for (let m = 0; m <= H; m++) ctx[m === 0 ? "moveTo" : "lineTo"](xOf(m), yOf(r.fwdP75[m]));
  for (let m = H; m >= 0; m--) ctx.lineTo(xOf(m), yOf(r.fwdP25[m]));
  ctx.closePath(); ctx.fill();

  // リードイン 25-75 帯(t<0, 薄め)
  ctx.fillStyle = "rgba(100,116,139,0.10)";
  ctx.beginPath();
  for (let i = 0; i < L; i++) ctx[i === 0 ? "moveTo" : "lineTo"](xOf(tMin + i), yOf(r.leadP75[i]));
  for (let i = L - 1; i >= 0; i--) ctx.lineTo(xOf(tMin + i), yOf(r.leadP25[i]));
  ctx.closePath(); ctx.fill();

  // 各アナログ(最大40本, 連続: リードイン→フォワード)
  ctx.strokeStyle = "rgba(148,163,184,0.4)"; ctx.lineWidth = 1;
  const shown = r.selected.slice(0, 40);
  for (const s of shown) {
    ctx.beginPath();
    s.lead.forEach((v, i) => ctx[i === 0 ? "moveTo" : "lineTo"](xOf(tMin + i), yOf(v)));
    s.forward.forEach((v, m) => ctx.lineTo(xOf(m), yOf(v)));
    ctx.stroke();
  }

  // アナログのリードイン中央値(点線・比較用)
  ctx.strokeStyle = "#64748b"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
  ctx.beginPath();
  r.leadMedian.forEach((v, i) => ctx[i === 0 ? "moveTo" : "lineTo"](xOf(tMin + i), yOf(v)));
  ctx.stroke(); ctx.setLineDash([]);

  // フォワード 高値/安値 到達(MFE/MAE)の中央値: 緑上・赤下 + 薄いレンジ・コーン
  ctx.fillStyle = "rgba(16,163,74,0.06)";
  ctx.beginPath();
  for (let m = 0; m <= H; m++) ctx[m === 0 ? "moveTo" : "lineTo"](xOf(m), yOf(r.fwdHighMedian[m]));
  for (let m = H; m >= 0; m--) ctx.lineTo(xOf(m), yOf(r.fwdLowMedian[m]));
  ctx.closePath(); ctx.fill();
  ctx.setLineDash([3, 2]); ctx.lineWidth = 1.4;
  ctx.strokeStyle = "#16a34a";
  ctx.beginPath();
  r.fwdHighMedian.forEach((v, m) => ctx[m === 0 ? "moveTo" : "lineTo"](xOf(m), yOf(v)));
  ctx.stroke();
  ctx.strokeStyle = "#dc2626";
  ctx.beginPath();
  r.fwdLowMedian.forEach((v, m) => ctx[m === 0 ? "moveTo" : "lineTo"](xOf(m), yOf(v)));
  ctx.stroke();
  ctx.setLineDash([]);

  // フォワード中央値(太・青)
  ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2.6;
  ctx.beginPath();
  r.fwdMedian.forEach((v, m) => ctx[m === 0 ? "moveTo" : "lineTo"](xOf(m), yOf(v)));
  ctx.stroke();

  // 今週(クエリ)の日中レンジ(高安の縦バー=ローソクのヒゲ)
  ctx.strokeStyle = "rgba(15,23,42,0.35)"; ctx.lineWidth = 1;
  for (let i = 0; i < L; i++) {
    const xx = xOf(tMin + i);
    ctx.beginPath(); ctx.moveTo(xx, yOf(r.query.leadHigh[i])); ctx.lineTo(xx, yOf(r.query.leadLow[i])); ctx.stroke();
  }
  // 今週(クエリ)のリードイン終値(太・濃紺)
  ctx.strokeStyle = "#0f172a"; ctx.lineWidth = 2.8;
  ctx.beginPath();
  r.query.lead.forEach((v, i) => ctx[i === 0 ? "moveTo" : "lineTo"](xOf(tMin + i), yOf(v)));
  ctx.stroke();
  // 今日の点
  ctx.fillStyle = "#0f172a";
  ctx.beginPath(); ctx.arc(xOf(0), yOf(0), 3, 0, Math.PI * 2); ctx.fill();

  // x目盛
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  const step = Math.max(1, Math.round((tMax - tMin) / 6));
  for (let t = tMin; t <= tMax; t += step) ctx.fillText(t === 0 ? "0" : `${t > 0 ? "+" : ""}${t}d`, xOf(t), mt + plotH + 14);
}

export default function WeeklyAnalogChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [usTicker, setUsTicker] = useState("^IXIC");
  const [usMode, setUsMode] = useState<UsMode>("ret");
  const [scheme, setScheme] = useState<BinScheme>("tercile");
  const [mode, setMode] = useState<AnalogMode>("usbin");
  const [L, setL] = useState(5);
  const [H, setH] = useState(5);
  const [K, setK] = useState(20);
  const [selBinOverride, setSelBinOverride] = useState<number | null>(null);

  const { prices: usPrices, loading: usLoading, error: usError } = useUsDaily(usTicker);
  const us = useMemo(() => (usPrices ? computeUsReturns(usPrices) : []), [usPrices]);

  const result = useMemo(() => {
    if (us.length === 0) return null;
    return computeWeeklyAnalog({ prices, us, L, H, K, mode, usMode, scheme, selBinOverride });
  }, [prices, us, L, H, K, mode, usMode, scheme, selBinOverride]);

  useEffect(() => {
    if (!canvasRef.current || !result) return;
    const init = initCanvas(canvasRef.current, 280);
    if (init) draw(init.ctx, init.width, init.height, result);
  }, [result]);

  // US 切替でビン選択をリセット(今週の起点ビン既定に戻す)
  const resetBin = () => setSelBinOverride(null);

  if (prices.length < 120) {
    return <div className="text-sm text-gray-500">アナログ比較には約120営業日以上の履歴が必要です。</div>;
  }

  const Btn = ({ v, cur, set }: { v: number; cur: number; set: (n: number) => void }) => (
    <button onClick={() => set(v)} className={`px-2 py-0.5 rounded text-[11px] ${cur === v ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-600"}`}>{v}</button>
  );

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        今週(直近{L}営業日)の経路を、
        <span className="font-medium text-gray-700">似た形の過去局面</span>または
        <span className="font-medium text-gray-700">前夜米国ビンで絞った過去局面</span>と突き合わせ、
        今日(t=0)へ至る経路と<span className="font-medium text-gray-700">その後{H}日</span>の分布を重ねる。
      </p>

      {/* モード切替 */}
      <div className="inline-flex rounded overflow-hidden border border-gray-200 text-xs">
        {([["usbin", "前夜米国ビンで絞る"], ["similar", "似た形で絞る(アナログ)"]] as [AnalogMode, string][]).map(([m, lbl]) => (
          <button
            key={m}
            onClick={() => { setMode(m); resetBin(); }}
            className={`px-3 py-1 font-medium ${mode === m ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-100"}`}
          >{lbl}</button>
        ))}
      </div>

      {/* 共通パラメタ */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-600">
        <div className="flex items-center gap-1"><span>今週の窓 L:</span>{L_PRESETS.map((v) => <Btn key={v} v={v} cur={L} set={setL} />)}</div>
        <div className="flex items-center gap-1"><span>先行き H:</span>{H_PRESETS.map((v) => <Btn key={v} v={v} cur={H} set={setH} />)}</div>
        {mode === "similar" && (
          <div className="flex items-center gap-1"><span>近傍 K:</span>{K_PRESETS.map((v) => <Btn key={v} v={v} cur={K} set={setK} />)}</div>
        )}
      </div>

      {/* 米国ビン設定(usbin モード) */}
      {mode === "usbin" && (
        <div className="space-y-2">
          <div className="flex items-center gap-4 flex-wrap">
            <UsDriverButtons value={usTicker} onChange={(t) => { setUsTicker(t); resetBin(); }} />
            <div className="flex items-center gap-1 flex-wrap text-xs">
              <span className="text-gray-500">ビン基準:</span>
              {([["ret", "前日終値比"], ["intra", "日中"]] as [UsMode, string][]).map(([m, lbl]) => (
                <button
                  key={m}
                  onClick={() => { setUsMode(m); resetBin(); }}
                  className={`px-2 py-0.5 rounded font-medium ${usMode === m ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                >{lbl}</button>
              ))}
            </div>
            <BinSchemeButtons value={scheme} onChange={(s) => { setScheme(s); resetBin(); }} />
          </div>

          {result && (
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              <span className="text-gray-500">見るビン:</span>
              {result.binMetaObj.labels.map((label, b) => {
                const isSel = b === result.selBin;
                const isQuery = b === result.queryUsBin;
                return (
                  <button
                    key={b}
                    onClick={() => setSelBinOverride(b)}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded font-medium ${isSel ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                  >
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: result.binMetaObj.colors[b] }} />
                    {label}
                    <span className={`text-[10px] ${isSel ? "text-gray-300" : "text-gray-400"}`}>n={result.binCounts[b]}</span>
                    {isQuery && <span className={isSel ? "text-amber-300" : "text-blue-600"}>◀今週</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {usLoading && <div className="text-xs text-gray-400">米国指数を取得中…</div>}
      {usError && <div className="text-xs text-red-500">{usError}</div>}

      {result ? (
        <>
          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
            {mode === "usbin"
              ? <>前夜米国が<span className="font-bold">「{result.binMetaObj.labels[result.selBin]}」</span>で始まった過去 {result.selected.length} 週</>
              : <>今週の形に似た過去 {result.selected.length} 局面</>}
            {" → その後 "}{result.H}日の
            <span className="font-bold"> 終値中央値 {fmtPct(result.medianFinal)}</span>
            <span className="text-blue-700">（平均 {fmtPct(result.meanFinal)}｜勝率 {((result.upCount / (result.upCount + result.downCount || 1)) * 100).toFixed(0)}%）</span>
            <span className="block mt-0.5">
              到達の中央値: <span className="text-green-700 font-bold">高値 {fmtPct(result.medianMfe)}</span>（利確目安）／
              <span className="text-red-700 font-bold"> 安値 {fmtPct(result.medianMae)}</span>（損切り目安）
            </span>
          </div>

          <div className="relative"><canvas ref={canvasRef} /></div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-gray-400">
            <span><span className="inline-block w-4 h-0.5 align-middle" style={{ background: "#0f172a" }} /> 今週の経路(縦バー=日中高安)</span>
            <span><span className="inline-block w-4 h-0.5 align-middle" style={{ background: "#2563eb" }} /> その後の終値中央値</span>
            <span><span className="inline-block w-4 h-0.5 align-middle border-t border-dashed" style={{ borderColor: "#16a34a" }} /> 高値到達中央(MFE)</span>
            <span><span className="inline-block w-4 h-0.5 align-middle border-t border-dashed" style={{ borderColor: "#dc2626" }} /> 安値到達中央(MAE)</span>
            <span><span className="inline-block w-3 h-2 align-middle" style={{ background: "rgba(37,99,235,0.13)" }} /> 終値25–75%帯</span>
            <span>薄線=各事例</span>
          </div>

          {/* アナログ一覧 */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1 px-2">局面（週の起点〜今日相当）</th>
                  <th className="text-right px-2">前夜米国ビン</th>
                  {mode === "similar" && <th className="text-right px-2">形の距離</th>}
                  <th className="text-right px-2">高値到達</th>
                  <th className="text-right px-2">安値到達</th>
                  <th className="text-right px-2">終値{result.H}日後</th>
                </tr>
              </thead>
              <tbody>
                {result.selected.slice(0, 10).map((s) => (
                  <tr key={s.endIndex} className="border-b border-gray-100">
                    <td className="py-1 px-2 text-gray-700 tabular-nums">{s.startTime} 〜 {s.endTime}</td>
                    <td className="text-right px-2">
                      {s.usBin !== null
                        ? <span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: result.binMetaObj.colors[s.usBin] }} />{result.binMetaObj.labels[s.usBin]}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    {mode === "similar" && <td className="text-right px-2 text-gray-500 tabular-nums">{s.distance.toFixed(2)}</td>}
                    <td className="text-right px-2 text-green-600 tabular-nums">{fmtPct(s.mfe)}</td>
                    <td className="text-right px-2 text-red-600 tabular-nums">{fmtPct(s.mae)}</td>
                    <td className={`text-right px-2 font-medium tabular-nums ${s.forwardReturn >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtPct(s.forwardReturn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        !usLoading && <div className="text-xs text-gray-400">
          該当する過去局面が不足しています。窓 L を短く・先行き H を短く、ビンを粗く（陰陽/3分位）、または「似た形で絞る」に切り替えてください。
        </div>
      )}

      <AnalysisGuide title="今週の軌跡アナログ比較の詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"『今の値動きが過去のどの局面に似ていて、そのとき次に何が起きたか』を機械的に探す手法(アナログ予測)。今週(直近L営業日)の経路をクエリにして、過去から似た局面を集め、その"}<strong>その後H日</strong>{"の分布を重ねる。似た入口のあとに何が起きたかの経験分布を、確率的な先読みの材料にする。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 2つの絞り方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>前夜米国ビンで絞る</strong>: 窓の起点(週初め)の前夜米国が指定ビン(例: 米大幅高)だった過去週だけを集める。「同じ地合いで始まった週はその後どうなったか」。米国ビンは各JP立会日に『寄り前で最後に確定した米国立会日(暦日が厳密に小さい最新)』のリターンを対応付けて層別(祝日・連休も自動整合)。</li>
          <li><strong>似た形で絞る(アナログ)</strong>: 今週のリードイン形状に最も近い過去K局面を距離で探す。各窓を「窓末=0%の累積リターン列」にしz化(水準・ボラの差を吸収し"形"だけ比較)、ユークリッド距離が小さい順。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 図の読み方(すべて窓末=今日=0%に再基準化)</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>左側(t&lt;0, リードイン)</strong>: 今日に至る経路。<span className="text-gray-900 font-medium">濃紺の太線=今週</span>、点線=過去局面のリードイン中央値。両者の重なり具合で「似た入口か」を目視確認。全系列は t=0 で 0% に収束する。</li>
          <li><strong>右側(t&gt;0, フォワード)</strong>: その後の分布。<span className="text-blue-700 font-medium">青の太線=終値の中央値</span>、帯=終値25–75%、薄線=各事例。右肩上がり＆帯が上偏＝似た局面のあと上がりやすい。</li>
          <li><strong>高安到達(HL/MFE・MAE)</strong>: 終値だけでなく日中の高安も使う。<span className="text-green-700 font-medium">緑点線=高値到達の中央値(MFE)</span>＝その後どこまで上げたか(利確目安)、<span className="text-red-700 font-medium">赤点線=安値到達の中央値(MAE)</span>＝どこまで下げたか(損切り/含み損目安)。各時点までの running max/min を集計。緑赤に挟まれたコーンが「典型的な値幅」。今週の経路には縦バーで日中レンジ(高安)を重ねる。</li>
          <li>上部バナーの終値中央値・勝率に加え、到達の中央値(高値/安値)で利確幅・ストップ幅の当たりを付ける。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>中央値が明確にプラス＆勝率が高い＆帯が狭い＝翌週にかけて順張り妙味。逆なら手仕舞い/逆張り警戒。</li>
          <li>「前夜米国ビン」モードは、今夜の米国が確定した時点で来週の入口ビンが分かるため、地合い起点の先読みに使える。</li>
          <li>アナログ一覧の日付を本体チャートで確認し、当時の相場環境(暴落後/天井圏など)が今と整合するか吟味してから採用。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>「形・地合いが似ている」だけで因果はない。事例数が少ない(帯が広い/n小)ほど偶然に振られる。サイズを抑える。</li>
          <li>レジームが違えば同じ入口でも結果は変わる(過去の上げ相場と今の下げ相場など)。</li>
          <li>ユークリッド距離は時間のズレに弱い(等速比較)。窓L・先行きH・ビン粗さで結果は変わるため、複数設定で頑健性を確認する。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
