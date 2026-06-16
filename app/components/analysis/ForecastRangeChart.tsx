"use client";

import { useEffect, useRef, useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeForecastRange } from "../../lib/forecast-range";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  prices: PricePoint[];
}

const HORIZONS = [1, 2, 3];

export default function ForecastRangeChart({ prices }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const result = useMemo(() => computeForecastRange(prices, HORIZONS), [prices]);

  // ファンチャート描画
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result.ok) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 260;
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

    const pad = { top: 18, right: 70, bottom: 28, left: 8 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const cur = result.currentPrice;
    // y範囲: 全ホライズンの95%バンド端
    let lo = cur, hi = cur;
    for (const h of result.horizons) {
      const b95 = h.bands.find((b) => b.level === 0.95)!;
      lo = Math.min(lo, b95.lowPrice);
      hi = Math.max(hi, b95.highPrice);
    }
    const margin = (hi - lo) * 0.08;
    lo -= margin; hi += margin;

    const maxH = HORIZONS[HORIZONS.length - 1];
    const toX = (d: number) => pad.left + (d / maxH) * plotW;
    const toY = (p: number) => pad.top + (1 - (p - lo) / (hi - lo)) * plotH;

    // x軸グリッド + ラベル
    ctx.strokeStyle = "#e5e7eb";
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (let d = 0; d <= maxH; d++) {
      const x = toX(d);
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, height - pad.bottom);
      ctx.stroke();
      ctx.fillText(d === 0 ? "現在" : `${d}日後`, x, height - 10);
    }

    // バンド(塗り): 95%→80%→50% の順に濃く重ねる。現在(d=0)を起点に。
    const bandStyles = [
      { level: 0.95, fill: "rgba(59,130,246,0.12)" },
      { level: 0.8, fill: "rgba(59,130,246,0.18)" },
      { level: 0.5, fill: "rgba(59,130,246,0.28)" },
    ];
    for (const bs of bandStyles) {
      ctx.fillStyle = bs.fill;
      ctx.beginPath();
      // 上端: 現在→各ホライズン
      ctx.moveTo(toX(0), toY(cur));
      for (const h of result.horizons) {
        const b = h.bands.find((x) => x.level === bs.level)!;
        ctx.lineTo(toX(h.horizon), toY(b.highPrice));
      }
      // 下端: 戻る
      for (let i = result.horizons.length - 1; i >= 0; i--) {
        const b = result.horizons[i].bands.find((x) => x.level === bs.level)!;
        ctx.lineTo(toX(result.horizons[i].horizon), toY(b.lowPrice));
      }
      ctx.lineTo(toX(0), toY(cur));
      ctx.closePath();
      ctx.fill();
    }

    // 正規分布95%レンジ(点線アウトライン、比較用)
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    for (const side of ["high", "low"] as const) {
      ctx.beginPath();
      ctx.moveTo(toX(0), toY(cur));
      for (const h of result.horizons) {
        const b = h.bands.find((x) => x.level === 0.95)!;
        ctx.lineTo(toX(h.horizon), toY(side === "high" ? b.highPriceNormal : b.lowPriceNormal));
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // 中央(ドリフト)パス
    ctx.strokeStyle = "#1d4ed8";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(cur));
    for (const h of result.horizons) ctx.lineTo(toX(h.horizon), toY(h.medianPrice));
    ctx.stroke();

    // 現在価格の水平線
    ctx.strokeStyle = "#6b7280";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(pad.left, toY(cur));
    ctx.lineTo(width - pad.right, toY(cur));
    ctx.stroke();
    ctx.setLineDash([]);

    // 右側に価格ラベル(3日後の各バンド端)
    const last = result.horizons[result.horizons.length - 1];
    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    const labels: { p: number; t: string; c: string }[] = [
      { p: last.bands.find((b) => b.level === 0.95)!.highPrice, t: `95% ${last.bands.find((b) => b.level === 0.95)!.highPrice.toFixed(1)}`, c: "#3b82f6" },
      { p: last.bands.find((b) => b.level === 0.5)!.highPrice, t: `50% ${last.bands.find((b) => b.level === 0.5)!.highPrice.toFixed(1)}`, c: "#2563eb" },
      { p: cur, t: `現在 ${cur.toFixed(1)}`, c: "#374151" },
      { p: last.bands.find((b) => b.level === 0.5)!.lowPrice, t: `50% ${last.bands.find((b) => b.level === 0.5)!.lowPrice.toFixed(1)}`, c: "#2563eb" },
      { p: last.bands.find((b) => b.level === 0.95)!.lowPrice, t: `95% ${last.bands.find((b) => b.level === 0.95)!.lowPrice.toFixed(1)}`, c: "#3b82f6" },
    ];
    for (const l of labels) {
      ctx.fillStyle = l.c;
      ctx.fillText(l.t, width - pad.right + 4, toY(l.p) + 3);
    }

    ctx.fillStyle = "#6b7280";
    ctx.textAlign = "left";
    ctx.font = "10px sans-serif";
    ctx.fillText("青帯=CF補正95/80/50%レンジ  点線=正規95%", pad.left, 12);
  }, [result]);

  if (!result.ok) {
    return (
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">短期予測レンジ (1〜3日)</h3>
        <div className="text-xs text-gray-500">{result.interpretation}</div>
      </div>
    );
  }

  const pct = (v: number) => (v * 100).toFixed(1) + "%";
  const prob = (v: number) => (v * 100).toFixed(0) + "%";

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">
        短期予測レンジ (1〜3日) — GARCH予測σ × Cornish-Fisher補正
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        現在価格 {result.currentPrice.toFixed(2)} を起点に、h日後リターン分布の分位点から予測価格帯を構成
      </p>

      {/* サマリー指標 */}
      <div className="grid grid-cols-4 gap-2 mb-3">
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">GARCH 1日σ</div>
          <div className="font-mono text-sm font-semibold text-blue-700">{pct(result.dailyVolGarch)}</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">標本σ(日次)</div>
          <div className="font-mono text-sm">{pct(result.dailyVolHist)}</div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">歪度</div>
          <div className={`font-mono text-sm ${result.skewness < 0 ? "text-red-600" : "text-green-600"}`}>
            {result.skewness.toFixed(2)}
          </div>
        </div>
        <div className="border rounded p-2 text-center">
          <div className="text-xs text-gray-500">超過尖度</div>
          <div className="font-mono text-sm">{result.excessKurtosis.toFixed(1)}</div>
        </div>
      </div>

      <canvas ref={canvasRef} />

      {/* ホライズン別テーブル */}
      <div className="mt-3 overflow-x-auto">
        <table className="text-xs w-full border-collapse">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="text-left py-1">ホライズン</th>
              <th className="text-right py-1">σ(累積)</th>
              <th className="text-right py-1">期待変動幅</th>
              <th className="text-right py-1">50%レンジ</th>
              <th className="text-right py-1">95%レンジ</th>
              <th className="text-right py-1">上昇確率</th>
            </tr>
          </thead>
          <tbody>
            {result.horizons.map((h) => {
              const b50 = h.bands.find((b) => b.level === 0.5)!;
              const b95 = h.bands.find((b) => b.level === 0.95)!;
              return (
                <tr key={h.horizon} className="border-b border-gray-100">
                  <td className="py-1 font-medium">{h.horizon}日後</td>
                  <td className="text-right font-mono">{pct(h.sigma)}</td>
                  <td className="text-right font-mono">±{h.expectedMove.toFixed(2)}%</td>
                  <td className="text-right font-mono">
                    {b50.lowPrice.toFixed(2)}〜{b50.highPrice.toFixed(2)}
                  </td>
                  <td className="text-right font-mono">
                    {b95.lowPrice.toFixed(2)}〜{b95.highPrice.toFixed(2)}
                  </td>
                  <td className={`text-right font-mono ${h.upProb >= 0.5 ? "text-green-600" : "text-red-600"}`}>
                    {prob(h.upProb)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 閾値到達確率 (3日後) */}
      <div className="mt-3">
        <div className="text-xs font-medium text-gray-600 mb-1">3日後の到達確率 (CF補正)</div>
        <div className="grid grid-cols-4 gap-2">
          {result.horizons[result.horizons.length - 1].probs.map((p) => (
            <div key={p.label} className="border rounded p-2 text-center">
              <div className="text-xs text-gray-500">{p.label}</div>
              <div className="font-mono text-sm font-semibold">{prob(p.prob)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="text-xs text-gray-600 mt-3">{result.interpretation}</div>

      <AnalysisGuide title="短期予測レンジの詳細理論">
        <p className="font-medium text-gray-700">1. この分析は何をしているか</p>
        <p>
          1〜3営業日という超短期では、価格の「方向(ドリフト)」はノイズに埋もれてほぼ予測できません。
          実務で意味があるのは「どれくらいの幅で、どんな形の分布で動くか」です。
          本パネルは現在価格を起点に、h日後の対数リターンの<strong>条件付き分布</strong>(平均・分散・歪度・尖度)を推定し、
          その分位点を価格に変換して予測レンジ帯(ファンチャート)として描きます。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 数式</p>
        <p>
          {"■ ボラティリティ予測 (GJR-GARCH(1,1))"}
          <br />
          {"σ²_{T+1} = ω + (α + γ·I_{ε_T<0})ε²_T + β·σ²_T   (実測の最終残差を使用)"}
          <br />
          {"σ²_{T+k} = ω + (α+β+γ/2)·σ²_{T+k-1}   (k≥2: 下落指標 I の期待値=0.5)"}
          <br />
          {"h日累積分散: Σ²_h = Σ_{k=1}^{h} σ²_{T+k}  (リターンが無相関と仮定)"}
          <br />
          {"h日標準偏差: σ_h = √(Σ²_h)"}
          <br /><br />
          {"■ 高次モーメントのスケーリング (iid近似)"}
          <br />
          {"歪度: S_h = S₁ / √h    超過尖度: K_h = K₁ / h"}
          <br />
          {"(独立同分布なら、合算するほど中心極限定理で正規に近づく)"}
          <br /><br />
          {"■ Cornish-Fisher 分位点補正"}
          <br />
          {"q_CF(z) = z + (z²−1)S/6 + (z³−3z)K/24 − (2z³−5z)S²/36"}
          <br />
          {"予測リターン分位点: r_p = μ·h + q_CF(z_p)·σ_h"}
          <br />
          {"予測価格: P_p = P_now · exp(r_p)"}
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>条件付き分散</strong>: 「今この瞬間の情報を所与としたときの」分散。直近のショックで増減する</li>
          <li><strong>持続性 (α+β+γ/2)</strong>: ボラの記憶の長さ。1に近いほど高ボラ・低ボラ状態が長く続く</li>
          <li><strong>歪度</strong>: 分布の左右の非対称性。負なら急落側の裾が厚い</li>
          <li><strong>超過尖度</strong>: 裾の厚さ。0が正規分布。プラスならファットテール(極端な動きが起きやすい)</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          天気予報の「降水確率と予想気温の幅」に近い発想です。明日の気温をピンポイントで当てるのは無理でも、
          「±3℃の範囲に8割収まる」とは言えます。GARCHは「昨日荒れたから今日も荒れやすい」という
          ボラのクラスタリング(群れる性質)を、Cornish-Fisherは「たまに起きる極端な寒波・熱波」を
          レンジ端に織り込む役割です。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>GARCH 1日σ {">"} 標本σ</strong>: 直近ショックでボラ拡大局面 → レンジは普段より広い</li>
          <li><strong>青帯</strong>: 内側50%・中間80%・外側95%の予測価格レンジ。日数とともに√で広がる</li>
          <li><strong>点線(正規95%)が青帯95%より内側</strong>: ファットテール/歪みで実際のリスクは正規想定より大きい</li>
          <li><strong>歪度が負</strong>: 下方向のレンジが上方向より広い(急落リスク優位)</li>
          <li><strong>上昇確率</strong>: 50%から大きく外れることは稀。±数%程度なら方向のエッジは弱いと考える</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>損切り/利確の置き場所</strong>: 95%レンジの外側に逆指値を置けば「通常変動での狩られ」を避けやすい</li>
          <li><strong>ポジションサイズ</strong>: 期待変動幅から「最大許容損失÷想定変動」で建玉量を逆算</li>
          <li><strong>オプション</strong>: CF95%レンジがインプライドの想定より広い→ボラ買い、狭い→ボラ売りの検討材料</li>
          <li><strong>エントリー回避</strong>: 持続性が高く高ボラ局面なら、レンジが広く狩られやすいので様子見も選択肢</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>ドリフト(中央パス)は日次平均×hで、超短期ではノイズ。方向の予測力はほぼ無いと割り切る</li>
          <li>iidスケーリング(S/√h, K/h)は自己相関やボラ・クラスタリングを無視した近似</li>
          <li>Cornish-Fisherは歪度・尖度が極端だと分位関数の単調性が崩れ、精度が落ちる</li>
          <li>イベント(決算・指標発表)やギャップは過去分布に含まれない突発リスクを過小評価しうる</li>
          <li>GARCHパラメータはグリッド+座標降下の近似推定。局所解の可能性がある</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
