"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { computeTiming, binCounts, maxStatPermutation, TimingResult, MaxStatResult } from "../../lib/us-spillover-timing";
import { BinScheme } from "../../lib/us-spillover-core";
import { useAlignedDays, UsDriverButtons, BinSchemeButtons } from "./usSpilloverShared";
import {
  initCanvas, IntervalButtons, LoadingError, IntradayCaveat, fmtSignedPct,
} from "./intradayShared";
import StatBadge from "./StatBadge";
import AnalysisGuide from "./AnalysisGuide";

interface Props { ticker: string; }

// (建てi × 手仕舞いj) 平均窓リターンのヒートマップ(上三角)。時系列でない2D格子 → Canvas2D。
function drawHeatmap(ctx: CanvasRenderingContext2D, W: number, H: number, res: TimingResult) {
  const G = res.timeLabels.length;
  const ml = 30, mr = 8, mt = 8;
  const cell = Math.max(6, Math.min(22, Math.floor((W - ml - mr) / G)));
  const gridW = cell * G;
  const colr = (v: number) => {
    const t = Math.max(-1, Math.min(1, v / res.maxAbs));
    if (t >= 0) { const a = Math.round(t * 200 + 30); return `rgba(22,163,74,${(a / 255).toFixed(2)})`; }
    const a = Math.round(-t * 200 + 30); return `rgba(220,38,38,${(a / 255).toFixed(2)})`;
  };
  for (const c of res.cells) {
    const x = ml + c.j * cell, y = mt + c.i * cell;
    ctx.fillStyle = colr(c.mean);
    ctx.fillRect(x, y, cell - 1, cell - 1);
    if (c.significant) { ctx.strokeStyle = "#1f2937"; ctx.lineWidth = 1.2; ctx.strokeRect(x + 0.5, y + 0.5, cell - 2, cell - 2); }
  }
  // 軸ラベル(間引き)
  ctx.fillStyle = "#6b7280"; ctx.font = "8px sans-serif";
  const every = G > 12 ? Math.ceil(G / 10) : 1;
  ctx.textAlign = "center";
  for (let j = 0; j < G; j++) if (j % every === 0) ctx.fillText(res.timeLabels[j], ml + j * cell + cell / 2, mt + gridW + 12);
  ctx.textAlign = "right";
  for (let i = 0; i < G; i++) if (i % every === 0) ctx.fillText(res.timeLabels[i], ml - 2, mt + i * cell + cell / 2 + 3);
  ctx.textAlign = "left"; ctx.fillStyle = "#9ca3af";
  ctx.fillText("行=建て / 列=手仕舞い（緑=ロング有利, 赤=ショート有利, 枠=有意）", ml, mt + gridW + 24);
}

export default function UsTimingEdgeChart({ ticker }: Props) {
  const [usTicker, setUsTicker] = useState("^GSPC");
  const [interval, setInterval] = useState("15m");
  const [scheme, setScheme] = useState<BinScheme>("tercile");
  const [selBin, setSelBin] = useState(0);
  const { data, loading, error } = useAlignedDays(ticker, interval, usTicker);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const counts = useMemo(() => (data ? binCounts(data.aligned, scheme) : []), [data, scheme]);

  // スキーム変更で選択ビンが範囲外になり得るためレンダー時にクランプ(effectでsetStateしない)
  const selBinSafe = counts.length > 0 && selBin < counts.length ? selBin : 0;

  const result: TimingResult | null = useMemo(
    () => (data ? computeTiming(data.aligned, data.grid, data.gmtoffset, scheme, selBinSafe) : null),
    [data, scheme, selBinSafe]
  );

  // 機能8: 族補正(max統計順列)。重いのでボタン起動。パラメータkeyで結果の陳腐化を判定(effectでsetStateしない)。
  const permKey = `${ticker}|${usTicker}|${interval}|${scheme}|${selBinSafe}`;
  const [perm, setPerm] = useState<{ key: string; res: MaxStatResult | null }>({ key: "", res: null });
  const [permBusy, setPermBusy] = useState(false);
  const permShown = perm.key === permKey ? perm.res : null;
  const runPerm = () => {
    if (!data) return;
    setPermBusy(true);
    // 同期計算だがUIにbusyを反映させるため次フレームで実行
    requestAnimationFrame(() => {
      const r = maxStatPermutation(data.aligned, data.grid, data.gmtoffset, scheme, selBinSafe, 300);
      setPerm({ key: permKey, res: r });
      setPermBusy(false);
    });
  };

  useEffect(() => {
    if (!result || !canvasRef.current) return;
    const G = result.timeLabels.length;
    const h = Math.min(22, Math.max(6, Math.floor((canvasRef.current.parentElement?.clientWidth ?? 600) / G))) * G + 40;
    const init = initCanvas(canvasRef.current, h);
    if (init) drawHeatmap(init.ctx, init.width, init.height, result);
  }, [result]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-gray-800">米国方向別 最適エントリー/エグジット時刻スキャン</h3>
        <IntervalButtons value={interval} onChange={setInterval} />
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        <UsDriverButtons value={usTicker} onChange={setUsTicker} />
        <BinSchemeButtons value={scheme} onChange={setScheme} />
      </div>

      <LoadingError loading={loading} error={error} />

      {counts.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap text-xs">
          <span className="text-gray-500">対象の前夜米国:</span>
          {counts.map((c) => (
            <button
              key={c.bin}
              onClick={() => setSelBin(c.bin)}
              className={`px-2 py-0.5 rounded font-medium ${selBinSafe === c.bin ? "text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
              style={selBinSafe === c.bin ? { backgroundColor: c.color } : undefined}
            >
              {c.label}（n={c.n}）
            </button>
          ))}
        </div>
      )}

      {!loading && !error && data && !result && (
        <div className="text-xs text-gray-400">この米国ビンは標本が不足しています（別のビン/粗い足を選択）。</div>
      )}

      {result && (
        <>
          <div className="relative"><canvas ref={canvasRef} /></div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={runPerm}
              disabled={permBusy}
              className="px-2 py-0.5 text-xs rounded bg-gray-800 text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {permBusy ? "検定中…" : "族補正(max統計順列)を実行"}
            </button>
            {permShown && (
              <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium ${
                permShown.p < 0.05 ? "bg-green-100 text-green-700 border-green-300" : "bg-gray-100 text-gray-500 border-gray-300"}`}>
                {permShown.p < 0.05 ? "族補正後も有意" : "族補正では非有意"}
                <span className="opacity-70">p={permShown.p < 0.001 ? "<.001" : permShown.p.toFixed(3)}・max|t|={permShown.obsMaxT.toFixed(2)}</span>
              </span>
            )}
            <span className="text-[11px] text-gray-400">全窓の最大|t|の帰無分布で、最良窓が偶然でないかを1検定で判定（FDRより厳格）</span>
          </div>

          <div className="space-y-1">
            <div className="text-xs font-medium text-gray-700">{result.binLabel} の翌日・好機タイミング上位（FDR有意）</div>
            {result.best.length === 0 ? (
              <p className="text-xs text-gray-400">この条件では有意な時刻ペアは検出されませんでした。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-200">
                      <th className="text-left py-1 px-2">建て → 手仕舞い</th>
                      <th className="text-left px-2">方向</th>
                      <th className="text-right px-2">平均</th>
                      <th className="text-right px-2">日数</th>
                      <th className="text-right px-2">符号安定</th>
                      <th className="text-left px-2">有意性</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.best.map((c, k) => (
                      <tr key={k} className="border-b border-gray-100">
                        <td className="py-1 px-2 font-mono text-gray-700">{result.timeLabels[c.i]} → {result.timeLabels[c.j]}</td>
                        <td className="px-2">{c.mean >= 0 ? <span className="text-green-700">ロング</span> : <span className="text-red-700">ショート</span>}</td>
                        <td className={`text-right px-2 font-medium ${c.mean >= 0 ? "text-green-700" : "text-red-700"}`}>{fmtSignedPct(c.mean)}</td>
                        <td className="text-right px-2 text-gray-600">{c.n}</td>
                        <td className="text-right px-2 text-gray-600">{c.stable != null ? `${(c.stable * 100).toFixed(0)}%` : "—"}</td>
                        <td className="px-2"><StatBadge n={c.n} p={c.p} significant={c.significant} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <IntradayCaveat extra="平均はロング(建て→手仕舞いで上昇)を正とする。マイナス=その時間帯はショートが有利。多重比較をFDRで補正済みだが、米国ビンで層別するとn激減 → 参考(n小)を過信しない。" />

      <AnalysisGuide title="米国方向別 タイミングスキャンの詳細">
        <p className="font-medium text-gray-700">1. 何を見ているか</p>
        <p>
          {"前夜米国の強弱で日を分けたうえで、『その条件の日は1日の中のどの時間帯を持つのが得か』を、建て時刻×手仕舞い時刻の全組合せで総当たり評価する。方法1のパスが平均的な形なら、こちらは具体的な売買時刻ペアの損益と有意性に落とし込む。"}
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 計算</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>{"米国ビンを1つ選び、その日群に限定。各日の時間ビン終値を用意(バーの無いビンは直前値で補完)。"}</li>
          <li>{"全ペア i<j について窓リターン r = ln(P_j / P_i) を日ごとに算出し、平均・1標本t検定。"}</li>
          <li>{"多数のペアを試すため Benjamini-Hochberg でFDR(偽発見率)補正。補正後 p<0.05 を有意とする。"}</li>
          <li>{"上位候補には移動ブロック・ブートストラップの符号安定度(再標本で符号が保たれる割合)を付す。"}</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">3. 読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ヒートマップの行=建て時刻、列=手仕舞い時刻。緑=その区間はロングが平均プラス、赤=ショートが有利。黒枠=FDR有意。</li>
          <li>右上ほど長い保有(寄り→引け)、対角線近くほど短い保有。枠付きの濃いセルが狙い目。</li>
          <li>上位表の「符号安定」が高い(≧90%)ほど、再標本しても効果の向きがブレず信頼しやすい。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>「米大幅安→翌日9:00売り/11:30買い戻し」のような、条件付きデイトレ・ルールの候補を直接得る。</li>
          <li>ロング/ショートの向きと保有時間帯がセットで出るので、そのままエントリー/エグジット計画に使える。</li>
          <li>方法2のβ・方法1のパスと符号が一致する候補ほど、理屈と実測が揃い信頼度が高い。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>米国ビンで層別するとサンプルが激減(5/15分足は各ビン数日〜十数日)。FDR後も偶然の当たりが残りうる。</li>
          <li>取引コスト・スリッページ・寄り引けの約定ズレ未考慮。短い窓ほど相対的に効く。</li>
          <li>過去の最良ペアが将来も最良とは限らない(過剰最適化)。方法1/2と整合する候補のみ採用する。</li>
          <li>時間格子は実測セッション範囲から生成。昼休みを挟むペアは連続保有として扱う点に注意。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
