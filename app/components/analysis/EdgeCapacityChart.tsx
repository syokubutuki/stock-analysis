"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import AnalysisGuide from "./AnalysisGuide";
import { buildEdgeCatalog } from "../../lib/edge-trades";
import {
  capacityTable,
  computeCapacity,
  fmtYen,
  DEFAULT_CAPACITY_PARAMS,
  type CapacityResult,
} from "../../lib/edge-capacity";

interface Props {
  prices: PricePoint[];
}

const HEIGHT = 320;

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

function drawCurve(canvas: HTMLCanvasElement, r: CapacityResult, deflate: boolean) {
  const init = initCanvas(canvas, HEIGHT);
  if (!init) return;
  const { ctx, width, height } = init;
  const padL = 52, padR = 64, padT = 16, padB = 34;
  const w = width - padL - padR, h = height - padT - padB;
  const curve = deflate ? r.curveDeflated : r.curve;
  const kStarV = deflate ? r.kStarDeflated : r.kStar;
  const kBeV = deflate ? r.kBreakEvenDeflated : r.kBreakEven;
  if (w <= 0 || h <= 0 || curve.length === 0) return;

  const kMin = curve[0].k, kMax = curve[curve.length - 1].k;
  const xOf = (k: number) => padL + (Math.log(k / kMin) / Math.log(kMax / kMin)) * w;

  // 左軸: 年率純リターン% (0を必ず含める)
  const nets = curve.map((p) => p.netAnnualPct);
  const nMin = Math.min(0, ...nets), nMax = Math.max(0, ...nets);
  const yNet = (v: number) => padT + (1 - (v - nMin) / (nMax - nMin || 1)) * h;
  // 右軸: 年間期待利益(円)
  const profits = curve.map((p) => p.profitYen);
  const pMin = Math.min(0, ...profits), pMax = Math.max(0, ...profits);
  const yProf = (v: number) => padT + (1 - (v - pMin) / (pMax - pMin || 1)) * h;

  // グリッドとX軸目盛(対数: 10万/100万/1000万/1億/10億…)
  ctx.strokeStyle = "#e5e7eb"; ctx.fillStyle = "#9ca3af";
  ctx.font = "10px sans-serif"; ctx.textAlign = "center"; ctx.lineWidth = 1;
  for (let e = 5; e <= 11; e++) {
    const k = Math.pow(10, e);
    if (k < kMin || k > kMax) continue;
    const x = xOf(k);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + h); ctx.stroke();
    ctx.fillText(fmtYen(k), x, height - padB + 14);
  }
  // ゼロライン(左軸基準)
  ctx.strokeStyle = "#d1d5db";
  ctx.beginPath(); ctx.moveTo(padL, yNet(0)); ctx.lineTo(padL + w, yNet(0)); ctx.stroke();

  // 左軸目盛
  ctx.textAlign = "right"; ctx.fillStyle = "#2563eb";
  for (let i = 0; i <= 4; i++) {
    const v = nMin + ((nMax - nMin) * i) / 4;
    ctx.fillText(`${v.toFixed(0)}%`, padL - 6, yNet(v) + 3);
  }
  // 右軸目盛
  ctx.textAlign = "left"; ctx.fillStyle = "#059669";
  for (let i = 0; i <= 4; i++) {
    const v = pMin + ((pMax - pMin) * i) / 4;
    ctx.fillText(fmtYen(v), padL + w + 6, yProf(v) + 3);
  }

  // 縦線: K*(利益最大) / K_be(エッジ消滅) / K_liq(参加率上限)
  const marks: { k: number; color: string; label: string }[] = [];
  if (kStarV > 0) marks.push({ k: kStarV, color: "#059669", label: "K*" });
  if (kBeV > 0) marks.push({ k: kBeV, color: "#dc2626", label: "消滅" });
  if (r.kLiq > 0) marks.push({ k: r.kLiq, color: "#d97706", label: "流動性" });
  for (const m of marks) {
    if (m.k < kMin || m.k > kMax) continue;
    const x = xOf(m.k);
    ctx.strokeStyle = m.color; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + h); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = m.color; ctx.textAlign = "center";
    ctx.fillText(m.label, x, padT - 4 + 10);
  }

  // 曲線: 年間期待利益(緑)
  ctx.strokeStyle = "#059669"; ctx.lineWidth = 2; ctx.beginPath();
  curve.forEach((p, i) => {
    const x = xOf(p.k), y = yProf(p.profitYen);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // 曲線: 年率純リターン(青)
  ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2; ctx.beginPath();
  curve.forEach((p, i) => {
    const x = xOf(p.k), y = yNet(p.netAnnualPct);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // 凡例
  ctx.font = "10px sans-serif"; ctx.textAlign = "left";
  ctx.fillStyle = "#2563eb"; ctx.fillText("— 年率純リターン(左軸)", padL + 8, padT + 12);
  ctx.fillStyle = "#059669"; ctx.fillText("— 年間期待利益(右軸)", padL + 8, padT + 24);
}

export default function EdgeCapacityChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [impactY, setImpactY] = useState(DEFAULT_CAPACITY_PARAMS.impactY);
  const [auctionSharePct, setAuctionSharePct] = useState(DEFAULT_CAPACITY_PARAMS.auctionShare * 100);
  const [maxPartPct, setMaxPartPct] = useState(DEFAULT_CAPACITY_PARAMS.maxParticipation * 100);
  const [selectedId, setSelectedId] = useState<string>("");
  const [deflate, setDeflate] = useState(true); // 選択バイアス補正(既定ON=誠実な容量)

  const params = useMemo(
    () => ({
      ...DEFAULT_CAPACITY_PARAMS,
      impactY,
      auctionShare: auctionSharePct / 100,
      maxParticipation: maxPartPct / 100,
    }),
    [impactY, auctionSharePct, maxPartPct],
  );

  const catalog = useMemo(() => buildEdgeCatalog(prices), [prices]);
  const table = useMemo(() => capacityTable(prices, catalog, params), [prices, catalog, params]);

  const selected = useMemo(() => {
    const found = table.find((r) => r.edge.id === selectedId);
    if (found) return found;
    return table[0] ?? null;
  }, [table, selectedId]);

  useEffect(() => {
    if (!canvasRef.current || !selected) return;
    drawCurve(canvasRef.current, selected, deflate);
    const onResize = () => { if (canvasRef.current && selected) drawCurve(canvasRef.current, selected, deflate); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [selected, deflate]);

  if (prices.length < 300) {
    return <div className="text-xs text-gray-400 p-3">データが不足しています(300営業日以上必要)。</div>;
  }
  if (table.length === 0) {
    return <div className="text-xs text-gray-400 p-3">出来高データが無いため容量を推定できません(指数などは出来高0の場合があります)。</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">エッジ容量推定 — このエッジは何円まで運用できるか</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          平方根マーケットインパクト則で、資金量を増やすと自分の売買がエッジを食い潰していく様子を閉形式で解く。
          本物のエッジは容量制限付き——「いくらまでなら本物か」を金額で答える。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-1">
          インパクト係数Y
          <input type="range" min={0.3} max={2} step={0.1} value={impactY} onChange={(e) => setImpactY(Number(e.target.value))} />
          <span className="font-mono w-8">{impactY.toFixed(1)}</span>
        </label>
        <label className="flex items-center gap-1">
          オークション出来高比率
          <input type="range" min={3} max={30} step={1} value={auctionSharePct} onChange={(e) => setAuctionSharePct(Number(e.target.value))} />
          <span className="font-mono w-8">{auctionSharePct}%</span>
        </label>
        <label className="flex items-center gap-1">
          最大参加率
          <input type="range" min={1} max={30} step={1} value={maxPartPct} onChange={(e) => setMaxPartPct(Number(e.target.value))} />
          <span className="font-mono w-8">{maxPartPct}%</span>
        </label>
        <button
          onClick={() => setDeflate((v) => !v)}
          className={`px-2 py-0.5 rounded border text-[11px] ${deflate ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-300"}`}
          title="μを選択バイアス(方向2×カタログ本数)ぶん収縮させた誠実な容量。DSRと同じ発想。"
        >
          選択バイアス補正 {deflate ? "ON" : "OFF"}
        </button>
      </div>

      {/* 前提の要約 */}
      <div className="text-[11px] text-gray-500">
        円建てADV {fmtYen(table[0].advYen)} / オークション出来高 {fmtYen(table[0].auctionYen)} / 日次ボラ {(table[0].sigmaD * 100).toFixed(2)}% / 往復スプレッド {(table[0].spreadRT * 100).toFixed(3)}%
      </div>

      {/* 選択バイアス補正の説明 */}
      <div className={`text-[11px] rounded border p-2 ${deflate ? "bg-blue-50 border-blue-200 text-blue-900" : "bg-gray-50 border-gray-200 text-gray-500"}`}>
        {deflate ? (
          <>
            <b>選択バイアス補正ON（既定・誠実な容量）:</b> μから「帰無下で選択だけで生じる上振れ」
            E[max z]={table[0].haircutZ.toFixed(2)}σ を控除（方向2 × カタログ{catalog.length}本 = {2 * catalog.length}候補）。
            容量K・K_beはaの二乗で効くため、この控除だけで容量は大きく縮みます。最上位行のμ:
            {(table[0].muGross * 100).toFixed(3)}% → <b>{(table[0].muDeflated * 100).toFixed(3)}%</b>。
          </>
        ) : (
          <>
            <b>選択バイアス補正OFF（素のin-sample μ・楽観的）:</b> 方向の後知恵選択とカタログ最良選抜の上振れを
            そのまま容量に食わせています。K*・K_beは体系的に過大です。実運用の判断は補正ONで行ってください。
          </>
        )}
      </div>

      {/* 容量テーブル */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 px-1.5">エッジ</th>
              <th className="text-right px-1">方向</th>
              <th className="text-right px-1">μ/取引{deflate && "→μ̂"}</th>
              <th className="text-right px-1">|t|</th>
              <th className="text-right px-1">{deflate ? "補正後â" : "スプレッド後a"}</th>
              <th className="text-right px-1.5">K*(利益最大)</th>
              <th className="text-right px-1.5">消滅K_be</th>
              <th className="text-right px-1.5">流動性上限</th>
              <th className="text-right px-1.5">年間期待利益</th>
            </tr>
          </thead>
          <tbody>
            {table.map((r) => {
              const isSel = selected?.edge.id === r.edge.id;
              const aV = deflate ? r.aDeflated : r.a;
              const kStarV = deflate ? r.kStarDeflated : r.kStar;
              const kBeV = deflate ? r.kBreakEvenDeflated : r.kBreakEven;
              const profitV = deflate ? r.profitAtKEffDeflated : r.profitAtKEff;
              const dead = aV <= 0;
              return (
                <tr
                  key={r.edge.id}
                  onClick={() => setSelectedId(r.edge.id)}
                  className={`border-b border-gray-100 cursor-pointer ${isSel ? "bg-blue-50" : "hover:bg-gray-50"}`}
                >
                  <td className="py-1 px-1.5">{r.edge.label}</td>
                  <td className={`text-right px-1 font-mono ${r.direction === "long" ? "text-green-600" : "text-red-600"}`}>{r.direction === "long" ? "買" : "売"}</td>
                  <td className="text-right px-1 font-mono">
                    {(r.muGross * 100).toFixed(3)}%
                    {deflate && <span className="text-blue-600">→{(r.muDeflated * 100).toFixed(3)}%</span>}
                  </td>
                  <td className={`text-right px-1 font-mono ${Math.abs(r.tStat) > 2 ? "text-gray-800 font-bold" : "text-gray-400"}`}>{Math.abs(r.tStat).toFixed(1)}</td>
                  <td className={`text-right px-1 font-mono ${aV > 0 ? "" : "text-red-500"}`}>{(aV * 100).toFixed(3)}%</td>
                  <td className="text-right px-1.5 font-mono">{dead ? "—" : fmtYen(kStarV)}</td>
                  <td className="text-right px-1.5 font-mono">{dead ? "0円" : fmtYen(kBeV)}</td>
                  <td className="text-right px-1.5 font-mono text-amber-700">{fmtYen(r.kLiq)}</td>
                  <td className={`text-right px-1.5 font-mono ${profitV > 0 ? "text-green-700" : "text-gray-400"}`}>{dead ? "—" : fmtYen(profitV)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-gray-400">
        行クリックで下の容量曲線を切替。a≦0(赤)はスプレッドの時点でエッジが消えており、どの資金量でも実運用不可。
        |t|は素朴なt値で多重比較未補正——有意性の判定はスキャン系分析(FDR補正あり)側で行うこと。
      </p>

      {/* 容量曲線 */}
      {selected && (
        <div>
          <div className="text-xs text-gray-500 mb-1">
            {selected.edge.label}（{selected.direction === "long" ? "買い" : "売り"}・年{selected.edge.tradesPerYear.toFixed(0)}回・{deflate ? "選択バイアス補正後" : "素のμ"}）
            — 緑破線=K*(利益最大 {fmtYen(deflate ? selected.kStarDeflated : selected.kStar)}) / 赤破線=エッジ消滅({fmtYen(deflate ? selected.kBreakEvenDeflated : selected.kBreakEven)}) / 橙破線=流動性上限({fmtYen(selected.kLiq)})
          </div>
          <canvas ref={canvasRef} className="w-full rounded border border-gray-100" />
        </div>
      )}

      <AnalysisGuide title="エッジ容量推定の詳細理論">
        <p className="font-medium text-gray-700">1. エッジ容量とは</p>
        <p>
          市場のエッジ(統計的優位)には必ず「容量」があります。売買量が増えるほど自分の注文が価格を不利に動かし
          (マーケットインパクト)、ある資金量を超えるとエッジは自分の売買コストに食い潰されて消えます。
          伝説的なメダリオン・ファンドが外部資金を締め出して規模を制限し続けたのは、この容量の壁を理解していたからです。
          この分析は「この銘柄のこのエッジは、何円まで運用すると消えるか」を金額で答えます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          {"資金量Kを寄り/引けオークションで往復させる1取引の純エッジを μ_net(K) = μ − s − 2Y·σ_d·√(K/V_auc) と置きます。"}
          {"μは方向調整後のグロス1取引平均、sは往復スプレッド(Corwin-Schultz系推定)、第3項が平方根インパクト則"}
          {"(片道 Y·σ_d·√(参加率)、往復で2倍)です。V_auc = オークション比率 × 円建てADV(直近60日中央値)。"}
          {"a = μ − s、b = 2Y·σ_d/√V_auc と略記すると μ_net(K) = a − b√K。年間期待利益は Π(K) = f·K·(a − b√K)(f=年間取引回数)で、"}
          {"微分して K* = (2a/3b)²(利益最大)、μ_net = 0 から K_be = (a/b)²(エッジ消滅点)が閉形式で出ます。K_be = 2.25·K* の関係があります。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><span className="font-medium">マーケットインパクト:</span> 自分の注文が価格を動かして約定を不利にする効果。実証研究では注文量の平方根にほぼ比例します(平方根則)。</li>
          <li><span className="font-medium">ADV:</span> 1日平均売買代金。ここでは終値×出来高の直近中央値。</li>
          <li><span className="font-medium">参加率:</span> 自分の注文がその時間帯の出来高に占める割合。オークション出来高の10%を超えると自分が価格形成の主役になってしまう、という経験則で上限(橙線)を置いています。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          エッジは「井戸」のようなものです。小さなバケツ(少額)なら毎日汲めますが、大きなポンプ(大金)を突っ込むと
          水位が下がって(価格が動いて)汲める量はむしろ減ります。K*は「最も多く汲める最適なポンプの大きさ」、
          K_beは「1滴も汲めなくなるポンプの大きさ」です。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>青い曲線(年率純リターン)は資金量とともに単調に低下します。左端の値が「少額運用での実力」、ゼロと交わる点がK_be。</li>
          <li>緑の曲線(年間期待利益・円)は山形。頂点がK*で、それ以上資金を入れると利益額まで減り始めます。</li>
          <li>K* より流動性上限(橙)が左にあるなら、制約は「インパクト」ではなく「オークションの浅さ」。板の薄い銘柄でよく起きます。</li>
          <li>表のa(スプレッド控除後エッジ)が負なら、インパクト以前にスプレッドで死んでいるエッジです。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>個人の運用資金がK*より十分小さければ「容量の壁はまだ遠い」——エッジの統計的な真偽(FDR・DSR側の検定)だけに集中してよい。</li>
          <li>逆に狙う資金量がK_beに近いなら、そのエッジはその規模では存在しないのと同じ。より流動性の高い銘柄か、より頻度の低い戦略に移る。</li>
          <li>年間期待利益Π(K*)は「このエッジがこの銘柄から理論上引き出せる上限額」。複数銘柄への横展開の優先順位付けに使えます。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>平方根則の係数Yは市場・銘柄で0.5〜1程度と幅があり、ここでの金額は桁の目安です。スライダで感度を確認してください。</li>
          <li><span className="font-medium">μの選択バイアス補正(この分析の要点):</span> 素のμは(1)方向の後知恵選択と(2)カタログ最良選抜で体系的に上振れます。補正ONでは帰無下の選択上振れ E[max z]·SE(実効試行=方向2×カタログ本数、DSRと同じ発想)をμから控除。容量はâの二乗で効くため補正で大きく縮みます。それでも|t|は素朴値なので、真偽はスキャン系(FDR)・WF(DSR/PBO)・ヌル較正・SPAで別途判定してください。</li>
          <li>オークション出来高比率は市場実勢(東証は寄り引けで日中出来高の1〜2割程度)の近似で、銘柄ごとの実測ではありません。</li>
          <li>インパクトを「支払い切り」とみなす保守的モデルです。実際は一部が戻る(一時的インパクト)ため、真の容量はやや大きい可能性があります。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
