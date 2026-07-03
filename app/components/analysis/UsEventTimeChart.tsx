"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  progressResample, stratifyBySpeed, ProgressPoint, SpeedGroup,
} from "../../lib/us-digestion-core";
import { useAlignedDays, UsDriverButtons } from "./usSpilloverShared";
import {
  initCanvas, IntervalButtons, LoadingError, IntradayCaveat, fmtSignedPct,
} from "./intradayShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

const LEVELS = [0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5];

// 進捗level=×gap(横) × その到達後の前向きリターン(縦%)のバー。level=1.0(=ギャップ相当)に基準線。
function drawProgress(ctx: CanvasRenderingContext2D, W: number, H: number, pts: ProgressPoint[]) {
  const ml = 42, mr = 10, mt = 12, mb = 26;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const N = pts.length;
  if (N < 1) return;
  const yMax = Math.max(1e-4, ...pts.map((p) => Math.abs(p.postMean))) * 1.15;
  const slot = plotW / N;
  const Y = (v: number) => mt + (1 - (v + yMax) / (2 * yMax)) * plotH;
  ctx.strokeStyle = "#f0f0f0";
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(fmtSignedPct(yMax, 1), ml - 3, mt + 8); ctx.fillText(fmtSignedPct(-yMax, 1), ml - 3, mt + plotH);
  pts.forEach((p, i) => {
    const x = ml + i * slot, w = Math.max(2, slot - 4);
    const y0 = Y(0), y1 = Y(p.postMean);
    ctx.fillStyle = p.postMean >= 0 ? "#16a34a" : "#dc2626";
    ctx.fillRect(x + 2, Math.min(y0, y1), w, Math.abs(y1 - y0));
    ctx.fillStyle = "#6b7280"; ctx.textAlign = "center";
    ctx.fillText(`${p.level}×`, x + slot / 2, H - 14);
    ctx.fillText(`n${p.n}`, x + slot / 2, H - 4);
  });
  // level=1.0×gap の位置に基準線
  const idx100 = pts.findIndex((p) => Math.abs(p.level - 1) < 1e-6);
  if (idx100 >= 0) {
    const x = ml + idx100 * slot + slot / 2;
    ctx.strokeStyle = "#0ea5e9"; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, mt); ctx.lineTo(x, mt + plotH); ctx.stroke(); ctx.setLineDash([]);
  }
}

function SpeedBar({ g, maxAbs }: { g: SpeedGroup; maxAbs: number }) {
  const w = (Math.abs(g.afternoonMean) / maxAbs) * 100;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 text-right text-gray-600">{g.label}</span>
      <div className="flex-1 h-4 bg-gray-100 rounded relative overflow-hidden">
        <div className="absolute inset-y-0 left-1/2 w-px bg-gray-400" />
        <div
          className={`absolute inset-y-0 ${g.afternoonMean >= 0 ? "bg-green-500 left-1/2" : "bg-red-500 right-1/2"}`}
          style={{ width: `${w / 2}%` }}
        />
      </div>
      <span className={`w-16 text-right font-medium ${g.afternoonMean >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(g.afternoonMean)}</span>
      <StatBadge n={g.n} p={g.afternoonP} significant={g.afternoonP < 0.05} />
    </div>
  );
}

export default function UsEventTimeChart({ ticker }: Props) {
  const [usTicker, setUsTicker] = useState("^GSPC");
  const [interval, setInterval] = useState("15m");
  const { data, loading, error } = useAlignedDays(ticker, interval, usTicker);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const rows = useMemo(() => (data ? data.aligned.filter((a) => isFinite(a.us.ret) && a.us.ret !== 0) : []), [data]);
  const progress = useMemo(
    () => (data?.grid && rows.length ? progressResample(rows, data.grid, data.gmtoffset, LEVELS) : []),
    [data, rows]
  );
  const speed = useMemo(
    () => (data?.grid && rows.length ? stratifyBySpeed(rows, data.grid, data.gmtoffset) : null),
    [data, rows]
  );

  useEffect(() => {
    if (progress.length === 0 || !canvasRef.current) return;
    const init = initCanvas(canvasRef.current, 210);
    if (init) drawProgress(init.ctx, init.width, init.height, progress);
  }, [progress]);

  const overshoot = progress.find((p) => Math.abs(p.level - 1.25) < 1e-6);
  const speedMaxAbs = speed ? Math.max(1e-4, Math.abs(speed.fast.afternoonMean), Math.abs(speed.slow.afternoonMean)) : 1;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">消化イベント時間分析（進捗率軸のエッジ / 消化速度層別）</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>
      <UsDriverButtons value={usTicker} onChange={setUsTicker} />

      <LoadingError loading={loading} error={error} />
      {!loading && !error && data && progress.length === 0 && (
        <div className="text-xs text-gray-400">整合できた標本が不足しています。</div>
      )}

      {progress.length > 0 && (
        <>
          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-700">
            日中の値動きが『夜間ギャップの何倍(×gap)』まで進んだ“後”、引けまでに前向きに取れる値動き。基準は寄り前に判明するギャップなので先読みなし。
            {overshoot && overshoot.postMean < 0 && <> ギャップの1.25倍(行き過ぎ)到達後は平均 <span className="font-bold text-red-700">{fmtSignedPct(overshoot.postMean)}</span> と逆行 → オーバーシュートの戻り取り。</>}
          </div>

          <div className="text-xs text-gray-500">日中進捗(夜間ギャップの倍数 ×gap)× 到達後→引けの前向きリターン</div>
          <div className="relative"><canvas ref={canvasRef} /></div>
          <p className="text-[11px] text-gray-400">
            緑=到達後まだ同方向に伸びる / 赤=到達後は逆行。青破線=1.0×gap(ギャップ相当)。基準を未来の引け値でなく前夜ギャップにしたので、選抜に先読みが入らない。
          </p>

          {speed && (
            <div className="pt-3 border-t border-gray-100 space-y-2">
              <div className="text-xs text-gray-500">消化速度で層別した後場(正午→引け)の向き付けリターン</div>
              <SpeedBar g={speed.fast} maxAbs={speedMaxAbs} />
              <SpeedBar g={speed.slow} maxAbs={speedMaxAbs} />
              <p className="text-[11px] text-gray-400">
                速い日=ギャップ半分への到達が早い、遅い日=遅い。分類は到達時刻(過去)のみで決め、後場リターンは前向き測定。遅い日の後場が有意にプラスなら「寄りで進みきらない日を選んで日中順張り」が有効。
              </p>
            </div>
          )}
        </>
      )}

      <IntradayCaveat extra="進捗=各日の向き付け累積÷夜間ギャップの大きさ|gap|(寄り前に判明=未来非依存)。消化速度=累積がギャップ半分に到達する時刻の早さ。" />

      <AnalysisGuide title="消化イベント時間分析（進捗軸・速度層別）の詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"壁時計の時刻(9:30, 10:00…)でなく、『日中の値動きが前夜ギャップの何倍まで進んだか』を時間軸に据え直す。基準を寄り前に判明する夜間ギャップにすることで、消化が速い日と遅い日を同じ土俵にそろえつつ、選抜に未来(引け値)を使わない。時計時刻だと混ざってボケるエッジがくっきり出る。さらに消化速度で日を分け、遅い日に持続エッジが残るかを調べる。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"進捗(×gap): 各日の向き付け累積(寄り基準)C(t)を、夜間ギャップの大きさ|gap|で正規化。C(t)/|gap|。1で日中がギャップ相当まで進行、1超で行き過ぎ。|gap|は寄り前に確定=未来非依存。"}</li>
          <li>{"進捗軸エッジ: 各level(×gap)に初到達した“後”、引けまでの前向きリターン C(引け)−C(到達時刻) を集計・t検定。選抜は到達時刻までの過去パスだけに依存。低levelで大きく正、1×付近で0、1×超で負なら順当。"}</li>
          <li>{"消化速度: 向き付け累積が |gap| の半分に達する時刻の早さ。中央値で fast/slow に二分(分類は過去のみ)。"}</li>
          <li>{"層別比較: fast/slow それぞれの後場(正午→引け)の前向きリターンを平均・t検定。"}</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 用語・例え</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>イベント時間(business time)</strong>: カレンダー時刻でなく、出来事の進み具合で測る時間。ここでは消化進捗。</li>
          <li><strong>正規化</strong>: 各日のスケール差を割り算で揃えること。速い日も遅い日も『進捗%』という共通座標に載る。</li>
          <li>例え: マラソンを『経過時間』でなく『コースの何%地点』で比較する。ペースが違う走者でも同じ地点で比べられる。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>残余が大きい低進捗のうちにエントリー、100%接近で手仕舞い、100%超で逆張り、と進捗をトリガーにする。</li>
          <li>「遅い日ほど後場エッジが残る」なら、寄りで消化が進んでいない日(進捗が低いまま)を選んで日中順張り。</li>
          <li>方法3(織り込み速度)の“平均”に対し、こちらは日ごとの速度差を活用する点が違う。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>基準は夜間ギャップ|gap|。ギャップがほぼ無い日(|gap|≈0)は進捗が暴れるため除外している。ギャップが出る銘柄・地合いで使う。</li>
          <li>進捗の基準は寄り前に判明するため選抜に先読みは無いが、後場リターン等の“結果”は当然事後値。リアルタイムでは到達levelをトリガーに使う。</li>
          <li>速度層別は中央値分割で各群の n が半減。StatBadge を確認。</li>
          <li>向き付け前提のため、米国と無相関な銘柄では意味が薄い(方法7と併読)。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
