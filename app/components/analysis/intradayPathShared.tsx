"use client";

// 日内累積パス層別コンポーネント(曜日/月内位置/曜日×米国)で共有する描画・UI部品。
// intraday-path-core の PathStat/PairDiff を受けて、Canvas2Dの重ね描き・凡例・
// 寄り→引けサマリー表・群間差マトリクス・原系列タイムラインを提供する。

import { useEffect, useRef, useState } from "react";
import {
  createChart, LineSeries, createSeriesMarkers,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time,
} from "lightweight-charts";
import { PathStat, PairDiff } from "../../lib/intraday-path-core";
import { fmtSignedPct, drawTimeAxisLabels } from "./intradayShared";
import StatBadge from "./StatBadge";

// 0..1 の不透明度を #rrggbb に付ける2桁16進に変換。
const alphaHex = (a: number) =>
  Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0");

export interface PathDrawOpts {
  showBand: boolean;
  showMedian: boolean;
  showSpaghetti?: boolean; // 個別日パスを新旧グラデーションで重ねる
  showEras?: boolean; // 時代分割(古→直近)の平均パスを描き、全期間平均は隠す
  groupFilter?: string | null; // PathStat.key。指定群だけ描画(null=全群)
}

// 群別の平均パス(+任意で中央値・95%帯・個別日・時代分割)とピーク/ボトム点をCanvasに重ね描く。
export function drawPathStats(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  stats: PathStat[], timeLabels: string[], maxAbs: number,
  opts: PathDrawOpts
) {
  const ml = 44, mr = 10, mt = 10, mb = 22;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const G = timeLabels.length;
  if (G < 2) return;

  const visible = stats.filter(
    (b) => b.n > 0 && (opts.groupFilter == null || b.key === opts.groupFilter)
  );

  // 時代分割の平均は全期間平均より標本が少なく振れるため、はみ出さないよう縦軸を広げる。
  // 個別日パスは外れ値が桁違いなのでスケールには含めず、プロット枠でクリップする。
  let yMax = maxAbs;
  if (opts.showEras) {
    for (const b of visible) for (const e of b.eras) for (const v of e.mean) {
      if (Math.abs(v) > yMax) yMax = Math.abs(v);
    }
  }
  yMax *= 1.05;
  const X = (g: number) => ml + (g / (G - 1)) * plotW;
  const Y = (v: number) => mt + (1 - (v + yMax) / (2 * yMax)) * plotH;

  // グリッド + ゼロ線
  ctx.strokeStyle = "#f0f0f0"; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const y = mt + (k / 4) * plotH; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + plotW, y); ctx.stroke(); }
  ctx.strokeStyle = "#d1d5db"; ctx.beginPath(); ctx.moveTo(ml, Y(0)); ctx.lineTo(ml + plotW, Y(0)); ctx.stroke();

  // 縦軸目盛
  ctx.fillStyle = "#9ca3af"; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(fmtSignedPct(yMax, 1), ml - 3, mt + 8);
  ctx.fillText("0", ml - 3, Y(0) + 3);
  ctx.fillText(fmtSignedPct(-yMax, 1), ml - 3, mt + plotH);

  const stroke = (vals: number[], color: string, width: number) => {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath();
    for (let g = 0; g < G; g++) { const x = X(g), y = Y(vals[g]); if (g === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  };

  // 個別日・時代分割は枠外へ出るので、プロット領域にクリップして描く。
  ctx.save();
  ctx.beginPath(); ctx.rect(ml, mt, plotW, plotH); ctx.clip();

  // 個別日パス(新旧グラデーション): 古い日ほど薄く細く、最新日ほど濃く太い。
  if (opts.showSpaghetti) {
    for (const b of visible) {
      const D = b.days.length;
      if (D === 0) continue;
      b.days.forEach((d, i) => {
        const t = D > 1 ? i / (D - 1) : 1; // 0=最古 1=最新
        stroke(d.values, b.color + alphaHex(0.05 + 0.3 * t), 0.5 + 1.0 * t);
      });
    }
  }

  // 95%帯
  if (opts.showBand) {
    for (const b of visible) {
      ctx.fillStyle = b.color + "22";
      ctx.beginPath();
      for (let g = 0; g < G; g++) ctx.lineTo(X(g), Y(b.hi[g]));
      for (let g = G - 1; g >= 0; g--) ctx.lineTo(X(g), Y(b.lo[g]));
      ctx.closePath(); ctx.fill();
    }
  }

  // 中央値パス(破線)
  if (opts.showMedian) {
    ctx.setLineDash([3, 3]);
    for (const b of visible) stroke(b.med, b.color + "cc", 1.5);
    ctx.setLineDash([]);
  }

  // 時代分割の平均パス(古→直近で濃く太く)。全期間平均は誤解を招くので描かない。
  if (opts.showEras) {
    for (const b of visible) {
      const K = b.eras.length;
      b.eras.forEach((e, i) => {
        const t = K > 1 ? i / (K - 1) : 1;
        stroke(e.mean, b.color + alphaHex(0.25 + 0.75 * t), 1.2 + 1.4 * t);
      });
    }
  } else {
    // 平均パス(実線)
    for (const b of visible) stroke(b.mean, b.color, 2);
  }

  ctx.restore();

  // ピーク(▲塗り)・ボトム(▽白抜き)マーカー。
  // 時代分割中は「直近の時代」の高安時刻に打つ(いま何時に高値/安値が付くのかを示す)。
  for (const b of visible) {
    const src = opts.showEras ? b.eras[b.eras.length - 1] : b;
    if (!src) continue;
    const px = X(src.peakIdx), py = Y(src.mean[src.peakIdx]);
    ctx.fillStyle = b.color;
    ctx.beginPath(); ctx.moveTo(px, py - 4); ctx.lineTo(px - 3.5, py + 2); ctx.lineTo(px + 3.5, py + 2); ctx.closePath(); ctx.fill();
    const tx = X(src.troughIdx), ty = Y(src.mean[src.troughIdx]);
    ctx.strokeStyle = b.color; ctx.lineWidth = 1.2; ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.moveTo(tx, ty + 4); ctx.lineTo(tx - 3.5, ty - 2); ctx.lineTo(tx + 3.5, ty - 2); ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  drawTimeAxisLabels(ctx, timeLabels, ml, plotW / G, H - 6);
}

// ───────────────────── 経時ドリフト(新旧グラデーション/時代分割) ─────────────────────

export interface PathEvolutionState {
  showSpaghetti: boolean;
  setShowSpaghetti: (v: boolean) => void;
  showEras: boolean;
  setShowEras: (v: boolean) => void;
  groupFilter: string | null; // stats に無いキーは自動で null 扱い
  setGroupFilter: (v: string | null) => void;
}

export function usePathEvolution(stats: PathStat[] | undefined): PathEvolutionState {
  const [showSpaghetti, setShowSpaghetti] = useState(false);
  const [showEras, setShowEras] = useState(false);
  const [rawFilter, setGroupFilter] = useState<string | null>(null);
  // 足種や条件を変えて群構成が入れ替わったら、消えたキーは選択解除扱いにする(効果を使わず純関数で解決)。
  const groupFilter =
    rawFilter != null && (stats ?? []).some((s) => s.key === rawFilter) ? rawFilter : null;
  return { showSpaghetti, setShowSpaghetti, showEras, setShowEras, groupFilter, setGroupFilter };
}

// 新旧グラデーション/時代分割のトグルと、見る群を1つに絞るチップ列。
export function PathEvolutionControls({ stats, evo }: { stats: PathStat[]; evo: PathEvolutionState }) {
  const withDays = stats.filter((s) => s.days.length > 0);
  if (withDays.length === 0) return null; // 日付が配線されていない群(=ドリフト非対応)
  const hasEras = stats.some((s) => s.eras.length > 0);

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <label className="flex items-center gap-1 text-xs text-gray-600">
        <input
          type="checkbox"
          checked={evo.showSpaghetti}
          onChange={(e) => evo.setShowSpaghetti(e.target.checked)}
        />
        個別日（古→新のグラデーション）
      </label>
      <label
        className={`flex items-center gap-1 text-xs ${hasEras ? "text-gray-600" : "text-gray-300"}`}
        title={hasEras ? "" : "時代分割には1群あたり8営業日以上が必要"}
      >
        <input
          type="checkbox"
          checked={evo.showEras && hasEras}
          disabled={!hasEras}
          onChange={(e) => evo.setShowEras(e.target.checked)}
        />
        時代分割（全期間平均を隠す）
      </label>
      {(evo.showSpaghetti || evo.showEras) && (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[11px] text-gray-400">群:</span>
          <button
            onClick={() => evo.setGroupFilter(null)}
            className={`px-2 py-0.5 text-xs rounded font-medium ${
              evo.groupFilter == null ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >全</button>
          {withDays.map((s) => (
            <button
              key={s.key}
              onClick={() => evo.setGroupFilter(evo.groupFilter === s.key ? null : s.key)}
              className="px-2 py-0.5 text-xs rounded font-medium"
              style={
                evo.groupFilter === s.key
                  ? { backgroundColor: s.color, color: "#fff" }
                  : { backgroundColor: "#f3f4f6", color: s.color }
              }
            >{s.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// 群ごとの「日内の形が変わってきたか」の検定表。
export function PathDriftTable({ stats, timeLabels }: { stats: PathStat[]; timeLabels: string[] }) {
  const rows = stats.filter((s) => s.drift && s.eras.length >= 2);
  if (rows.length === 0) return null;
  const anySig = rows.some(
    (s) => s.drift!.endP < 0.05 || s.drift!.peakP < 0.05 || s.drift!.troughP < 0.05
  );

  // ρ(順位相関)セル: 符号=移動方向、★=p<0.05。
  const rhoCell = (rho: number, p: number, kind: "peak" | "trough") => {
    const sig = p < 0.05;
    const dir = Math.abs(rho) < 0.02 ? "変化なし" : rho > 0 ? "後ろ倒し" : "前倒し";
    return (
      <td className={`text-right px-2 tabular-nums ${sig ? "font-bold bg-amber-50" : ""} ${
        sig ? (kind === "peak" ? "text-blue-700" : "text-red-700") : "text-gray-500"
      }`} title={`Spearman ρ=${rho.toFixed(3)} / p=${p.toFixed(3)}${sig ? ` → ${dir}` : ""}`}>
        {rho >= 0 ? "+" : ""}{rho.toFixed(2)}{sig ? `★${dir}` : ""}
      </td>
    );
  };

  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-gray-700">日内の形は変化してきたか（経時ドリフト検定）</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 px-2">群</th>
              <th className="text-right px-2">独立日</th>
              <th className="text-right px-2">最古期 終端</th>
              <th className="text-right px-2">直近期 終端</th>
              <th className="text-right px-2">差（直近−最古）</th>
              <th className="text-left px-2">有意性</th>
              <th className="text-right px-2">高値時刻 ρ</th>
              <th className="text-right px-2">安値時刻 ρ</th>
              <th className="text-center px-2">直近期の高安時刻</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const d = s.drift!;
              const last = s.eras[s.eras.length - 1];
              return (
                <tr key={s.key} className="border-b border-gray-100">
                  <td className="py-1 px-2">
                    <span className="inline-flex items-center gap-1">
                      <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
                      <span className="text-gray-700">{s.label}</span>
                    </span>
                  </td>
                  <td className="text-right px-2 text-gray-500 tabular-nums">{d.nRho}</td>
                  <td className={`text-right px-2 tabular-nums ${d.endEarly >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(d.endEarly)}</td>
                  <td className={`text-right px-2 tabular-nums ${d.endLate >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(d.endLate)}</td>
                  <td className={`text-right px-2 font-medium tabular-nums ${d.endDiff >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(d.endDiff)}</td>
                  <td className="px-2"><StatBadge n={Math.min(d.nEarly, d.nLate)} p={d.endP} significant={d.endP < 0.05} /></td>
                  {rhoCell(d.peakRho, d.peakP, "peak")}
                  {rhoCell(d.troughRho, d.troughP, "trough")}
                  <td className="text-center px-2 text-gray-600">
                    <span className="text-blue-600">▲</span> {timeLabels[last.peakIdx] ?? "-"}
                    <span className="text-gray-300 mx-1">/</span>
                    <span className="text-red-500">▽</span> {timeLabels[last.troughIdx] ?? "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-gray-400">
        {anySig
          ? "★=p<0.05。その群は期間内で日内の形が変わっている＝全期間平均は現在の姿を表していない。直近期の値を優先して読む。"
          : "有意なドリフトなし＝期間内で日内の形は安定しており、全期間平均をそのまま使ってよい。"}
        {" 終端差は最古期 vs 直近期のWelch検定。ρは「日付順位と各日の高値/安値時刻ビンのSpearman順位相関」で、+なら時刻が後ろ倒し・−なら前倒しに移動していることを示す。検定の単位は必ず独立な営業日(同一日の複数銘柄は日内平均に畳む)。"}
      </p>
    </div>
  );
}

// 経時ドリフト機能の解説。各コンポーネントの AnalysisGuide 内に差し込んで共有する。
export function PathDriftGuideSection() {
  return (
    <>
      <p className="font-medium text-gray-700 mt-3">経時ドリフト（新旧グラデーション / 時代分割）</p>
      <p>
        {"平均パスは「集計したN日のあいだ日内の形が変わっていない」ことを暗黙に仮定している(定常性の仮定)。しかし相場の癖は生き物で、アルゴリズムの普及や取引時間の変更、参加者の入れ替わりで数か月単位に変質する。直近だけ形が変わっていても、平均パスは何事もなかったかのように滑らかな1本を返してしまう。この節はその仮定そのものを点検する。"}
      </p>

      <p className="font-medium text-gray-700 mt-3">計算</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>{"個別日グラデーション: 群に属する各営業日の累積パスを日付順に並べ、最古を不透明度0.05・最新を0.35として線形に濃くし、線幅も0.5→1.5pxへ太くする。「最新ほど濃く太い」ため、直近の束が過去の束から離れていく様子がそのまま見える。"}</li>
        <li>{"時代分割: 群内を日付順に等分割し(N≥12なら3期、N≥8なら2期、それ未満は打ち切り)、各期だけの平均パスを描く。1期あたり4日を切ると平均は形状ではなく個別日のノイズになるため、意図的に分割を諦める。"}</li>
        <li>{"終端ドリフト検定: 最古期と直近期の寄り→引けリターンをWelchの2標本t検定で比較。等分散を仮定しないので期ごとにボラが違っても使える。"}</li>
        <li>{"高安時刻ドリフト検定: 各日について高値時刻ビン t_H(d)=argmax_g r_d(g)、安値時刻ビン t_L(d)=argmin_g r_d(g) を求め、日付順位との Spearman 順位相関 ρ を取る。p値は t=ρ·√((n−2)/(1−ρ²))、自由度 n−2 のt近似。同じ時刻に高値が集中してタイが多発するため、平均順位法でタイ補正している。"}</li>
        <li>{"検定の単位は必ず「独立な営業日」。同一日に複数観測がある場合(業種バスケットの複数銘柄)は、まずその日の平均パスに畳んでから分割・検定する。同じ日の銘柄は一斉に動く(横断相関)ため、のべ銘柄×日で並べるとp値が不当に小さくなる。"}</li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">用語</p>
      <ul className="list-disc pl-4 space-y-1">
        <li><strong>定常性</strong>: 統計的な性質(平均・分散・形)が時間によって変わらないこと。平均を取る行為はこれを仮定している。</li>
        <li><strong>経時ドリフト</strong>: 期間内でパターンが徐々に変質すること。急激な断絶(構造変化)と違い、ゆっくり移動するので平均では気づけない。</li>
        <li><strong>Spearman順位相関 ρ</strong>: 値そのものではなく順位どうしの相関。−1〜+1。ここでは +なら高安時刻が後ろ倒し、−なら前倒しに移動していることを意味する。直線的でない移動も拾えるのが利点。</li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">直感的な例え</p>
      <p>
        {"クラス全員の身長を平均しても「成長しているか」は分からないのと同じ。学年ごとに分けて平均を並べて初めて成長曲線が見える。時代分割はこの「学年分け」であり、ρは「学年と身長に順位の相関があるか」を測る検定にあたる。"}
      </p>

      <p className="font-medium text-gray-700 mt-3">結果の読み方</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>3本の時代パスがほぼ重なる → 形は安定。全期間平均をそのまま信じてよい。</li>
        <li>直近期だけ形が違う → 全期間平均は「もう存在しない過去の癖」を含んでいる。直近期の▲▽を優先して読む。</li>
        <li>高値時刻ρが有意に正（★後ろ倒し）→ 利確時刻を後ろへずらす根拠。負（★前倒し）なら早める根拠。</li>
        <li>終端差が有意 → その群の日中の伸びそのものが変質している。曜日効果が消滅/新生した可能性を疑う。</li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">投資判断への活用</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>執行時刻の更新: 高安時刻が後ろ倒しなら、過去平均のピーク時刻で利確すると「まだ伸びる前に降りる」ことになる。直近期のピークに合わせる。</li>
        <li>エッジの寿命判定: 終端差が有意にマイナス（直近ほど弱い）なら、そのアノマリーは既に裁定で消えかけている。建玉を落とす判断材料になる。</li>
        <li>バックテストの割引: 有意なドリフトがある群は、全期間で作った戦略の期待値を割り引いて考える（過去半分の好成績で数字が持ち上がっている）。</li>
      </ul>

      <p className="font-medium text-gray-700 mt-3">注意点・限界</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>{"最大の落とし穴は「見えた気になる」こと。人間は12本の線に濃淡が付くと必ず何らかのトレンドを見つけてしまう。グラデーションは仮説の発見に留め、判断は必ずドリフト検定表の★で行うこと。"}</li>
        <li>{"5/15/30分足は直近約60営業日しか取れず、曜日層別すると各12日前後。3分割すると1期4日で、その平均パスは形状ではなくノイズ。ドリフトを真面目に見るなら60分足(約2年)を選ぶこと。"}</li>
        <li>{"業種バスケットでプールしても独立日数は増えない(のべ標本が増えるだけ)ため、この制約は解けない。"}</li>
        <li>{"時代分割は等分割であって、変化点を推定しているわけではない。本当の構造変化がどこで起きたかを知りたい場合はBOCPD等の変化点検出を使う。"}</li>
        <li>{"ρの検定は多重比較を補正していない(群×高安で複数回検定している)。p=0.04程度の単発の★は偶然の可能性が十分ある。"}</li>
        <li>{"個別日パスは縦軸(平均基準)からはみ出すとクリップされる。外れ値日の全容は見えない。"}</li>
      </ul>
    </>
  );
}

// 群の色凡例。
export function PathLegend({ stats, withN = true }: { stats: PathStat[]; withN?: boolean }) {
  return (
    <div className="flex items-center gap-3 flex-wrap text-[11px]">
      {stats.map((b) => (
        <span key={b.key} className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: b.color }} />
          <span className="text-gray-600">{b.label}{withN ? `（n=${b.n}）` : ""}</span>
        </span>
      ))}
    </div>
  );
}

// 寄り→引けサマリー表(平均・中央値・ピーク/ボトム時刻・有意性)。
export function PathSummaryTable({
  stats, timeLabels, groupHeader,
}: { stats: PathStat[]; timeLabels: string[]; groupHeader: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 border-b border-gray-200">
            <th className="text-left py-1 px-2">{groupHeader}</th>
            <th className="text-right px-2">日数</th>
            <th className="text-right px-2">寄り→引け平均</th>
            <th className="text-right px-2">中央値</th>
            <th className="text-center px-2">ピーク時刻</th>
            <th className="text-center px-2">ボトム時刻</th>
            <th className="text-left px-2">有意性</th>
          </tr>
        </thead>
        <tbody>
          {stats.filter((b) => b.n > 0).map((b) => (
            <tr key={b.key} className="border-b border-gray-100">
              <td className="py-1 px-2">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: b.color }} />
                  <span className="text-gray-700">{b.label}</span>
                </span>
              </td>
              <td className="text-right px-2 text-gray-600">{b.n}</td>
              <td className={`text-right px-2 font-medium ${b.endMean >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(b.endMean)}</td>
              <td className={`text-right px-2 ${b.endMed >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtSignedPct(b.endMed)}</td>
              <td className="text-center px-2 text-gray-600">
                <span className="text-blue-600">▲</span> {timeLabels[b.peakIdx] ?? "-"} <span className="text-gray-400">({fmtSignedPct(b.mean[b.peakIdx])})</span>
              </td>
              <td className="text-center px-2 text-gray-600">
                <span className="text-red-500">▽</span> {timeLabels[b.troughIdx] ?? "-"} <span className="text-gray-400">({fmtSignedPct(b.mean[b.troughIdx])})</span>
              </td>
              <td className="px-2"><StatBadge n={b.n} p={b.endP} significant={b.endP < 0.05} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 群ペアの終端差マトリクス(上三角)。セル=差(行−列)、色=符号、★=FDR有意。
export function PairDiffMatrix({ stats, pairDiffs }: { stats: PathStat[]; pairDiffs: PairDiff[] }) {
  const active = stats.filter((s) => s.n >= 3);
  if (active.length < 2) return null;
  const lookup = new Map<string, PairDiff>();
  for (const d of pairDiffs) lookup.set(`${d.i}-${d.j}`, d);
  const anySig = pairDiffs.some((d) => d.pAdj < 0.05);

  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-gray-700">群間の寄り→引け差の検定（行 − 列）</div>
      <div className="overflow-x-auto">
        <table className="text-[11px] border-collapse">
          <thead>
            <tr>
              <th className="p-1"></th>
              {active.map((c) => (
                <th key={c.key} className="p-1 text-gray-600 font-medium">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {active.map((r) => {
              const ri = stats.indexOf(r);
              return (
                <tr key={r.key}>
                  <td className="p-1 text-gray-600 font-medium text-right">{r.label}</td>
                  {active.map((c) => {
                    const ci = stats.indexOf(c);
                    if (ri === ci) return <td key={c.key} className="p-1 text-center text-gray-300">—</td>;
                    const key = ri < ci ? `${ri}-${ci}` : `${ci}-${ri}`;
                    const d = lookup.get(key);
                    if (!d) return <td key={c.key} className="p-1 text-center text-gray-300">·</td>;
                    const diff = ri < ci ? d.diff : -d.diff;
                    const sig = d.pAdj < 0.05;
                    return (
                      <td
                        key={c.key}
                        title={`差 ${fmtSignedPct(diff)} / p=${d.p.toFixed(3)} / FDR ${d.pAdj.toFixed(3)}`}
                        className={`p-1 text-center tabular-nums ${sig ? "font-bold" : ""} ${diff >= 0 ? "text-green-700" : "text-red-700"} ${sig ? "bg-amber-50" : ""}`}
                      >
                        {fmtSignedPct(diff, 1)}{sig ? "★" : ""}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-gray-400">
        {anySig
          ? "★=FDR補正後も有意(p<0.05)。その群ペアは日内の伸びが統計的に異なる=曜日/条件効果の実体。"
          : "FDR補正後に有意なペアなし=群間の終端差は誤差の範囲。層別による日内パスの違いは断定できない。"}
        {" 値は行群−列群の寄り→引け平均差。"}
      </p>
    </div>
  );
}

// 原系列(日次終値)ライン上に、各立会日を群色●で重ねるズーム/パン可能タイムライン。
export interface TimelineDay { date: string; close: number; key: string; }
export function PathTimeline({
  days, colorOf,
}: { days: TimelineDay[]; colorOf: (key: string) => string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#ffffff" }, textColor: "#333" },
      grid: { vertLines: { color: "#f0f0f0" }, horzLines: { color: "#f0f0f0" } },
      width: containerRef.current.clientWidth,
      height: 240,
      crosshair: { mode: 0 },
      rightPriceScale: { visible: true },
      timeScale: { timeVisible: false, secondsVisible: false },
    });
    chartRef.current = chart;
    const series = chart.addSeries(LineSeries, { color: "#cbd5e1", lineWidth: 1, title: "原系列(終値)" });
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);
    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null; seriesRef.current = null; markersRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(days.filter((d) => d.close > 0).map((d) => ({ time: d.date as Time, value: d.close })));
    const markers: SeriesMarker<Time>[] = days.map((d) => ({
      time: d.date as Time, position: "inBar", color: colorOf(d.key), shape: "circle", size: 1,
    }));
    markersRef.current?.setMarkers(markers);
    if (containerRef.current && containerRef.current.clientWidth > 0) {
      chartRef.current?.applyOptions({ width: containerRef.current.clientWidth });
    }
    chartRef.current?.timeScale().fitContent();
  }, [days, colorOf]);

  return <div ref={containerRef} className="w-full rounded border border-gray-100" />;
}
