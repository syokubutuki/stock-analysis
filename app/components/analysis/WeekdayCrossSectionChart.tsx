"use client";

import { useMemo } from "react";
import { PricePoint } from "../../lib/types";
import {
  computeWeekdayCrossSection,
  TickerPrices,
  WD_LABEL,
  CellStat,
  FSummary,
} from "../../lib/weekday-cross-section";
import AnalysisGuide from "./AnalysisGuide";

interface Props {
  tickers: string[];
  pricesByTicker: Record<string, PricePoint[]>;
  names?: Record<string, string>;
}

const bp = (v: number) => `${(v * 10000).toFixed(1)}bp`;

// t 統計量 → 背景色（青=正で有意, 赤=負で有意）
function tColor(t: number): string {
  const a = Math.min(1, Math.abs(t) / 4);
  if (t >= 0) return `rgba(37,99,235,${0.08 + a * 0.5})`;
  return `rgba(220,38,38,${0.08 + a * 0.5})`;
}

function cellTd(c: CellStat | null, key: number) {
  if (!c) return <td key={key} className="py-1 px-2 text-center text-gray-300">—</td>;
  const sig = Math.abs(c.t) >= 1.96;
  return (
    <td key={key} className="py-1 px-2 text-right" style={{ background: tColor(c.t) }}>
      <div className={`font-medium ${sig ? "text-gray-900" : "text-gray-600"}`}>{bp(c.mean)}</div>
      <div className="text-[9px] text-gray-500">t={c.t.toFixed(2)}</div>
    </td>
  );
}

function FBlock({ label, f }: { label: string; f: FSummary }) {
  const excess = f.nReject05 > f.expected05 * 2;
  return (
    <div className="rounded border border-gray-200 p-2">
      <div className="text-[11px] font-medium text-gray-700">{label}の曜日効果 F</div>
      <div className="text-[10px] text-gray-600 mt-0.5 leading-relaxed">
        中央値 F = <b>{f.medianF.toFixed(2)}</b> / 5%棄却{" "}
        <b className={excess ? "text-blue-700" : "text-gray-500"}>
          {f.nReject05}/{f.nTickers}
        </b>{" "}
        （偶然の期待 {f.expected05.toFixed(1)}）/ 1%棄却 {f.nReject01}
      </div>
      <div className="text-[10px] text-gray-500 mt-0.5">
        {excess
          ? "偶然の期待をはっきり超える棄却数 → 共通の曜日構造あり"
          : "棄却数は偶然の範囲内 → 共通の曜日構造は見えない"}
        {f.perTicker[0] && `（最大: ${f.perTicker[0].name} F=${f.perTicker[0].F.toFixed(2)}）`}
      </div>
    </div>
  );
}

export default function WeekdayCrossSectionChart({ tickers, pricesByTicker, names }: Props) {
  const result = useMemo(() => {
    const stocks: TickerPrices[] = tickers
      .map((t) => ({ ticker: t, name: names?.[t] ?? t, prices: pricesByTicker[t] ?? [] }))
      .filter((s) => s.prices.length > 0);
    return computeWeekdayCrossSection(stocks);
  }, [tickers, pricesByTicker, names]);

  if (!result.ok) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="text-xs text-gray-500">
          クロスセクション分析：{result.reason ?? "データ待ち"}
        </div>
      </div>
    );
  }

  const w = result.weekend.pooled;
  const poolFactor = w && w.nEff > 0 ? w.nObs / w.nEff : 0;
  const weekendSig = w ? Math.abs(w.t) >= 1.96 : false;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-800">
          クロスセクション：銘柄×週プール（横断相関に正直な検出力）
        </h3>
        <span className="text-[10px] text-gray-400">
          {result.nTickers}銘柄 / のべ{result.nObsTotal.toLocaleString()}観測 / {result.from}〜{result.to}
        </span>
      </div>

      {/* nEff の目減り */}
      {w && (
        <div className="mt-3 rounded p-2.5 text-xs bg-blue-50 border border-blue-200 text-blue-900">
          <div className="font-semibold">
            のべ {w.nObs.toLocaleString()} 観測 → 実効標本 nEff ={" "}
            <b>{Math.round(w.nEff).toLocaleString()}</b>（{poolFactor.toFixed(1)}分の1に目減り）
          </div>
          <div className="mt-1 leading-relaxed">
            同じ日は全銘柄がまとめて動くため、{result.nTickers}銘柄プールしても独立標本は{result.nTickers}
            倍にはなりません。クラスタ頑健SE（同一日=1クラスタ）で数えた実効標本は{" "}
            {Math.round(w.nEff / w.nDays)}銘柄ぶん相当（独立営業日 {w.nDays} 日 ×）。
            <b>これが横断プールの正直な検出力</b>です。
          </div>
        </div>
      )}

      {/* 週末プレミアム */}
      {w && (
        <div className="mt-2 rounded border border-gray-200 p-2.5 text-xs">
          <div className="font-medium text-gray-700">週末プレミアム μ_w（横断プール）</div>
          <div className="mt-1 text-gray-700">
            μ_w = <b>{bp(w.mean)}</b> ± {bp(w.se)}（クラスタ頑健SE）、t ={" "}
            <b className={weekendSig ? "text-blue-700" : "text-gray-500"}>{w.t.toFixed(2)}</b>
            {result.weekend.bootCI &&
              `、日クラスタBoot 95%CI [${bp(result.weekend.bootCI.lo)}, ${bp(result.weekend.bootCI.hi)}]`}
            。
            <span className={weekendSig ? "text-blue-700" : "text-gray-600"}>
              {weekendSig
                ? " プールすると週末プレミアムが有意に検出されました。"
                : " 銘柄をプールしても週末プレミアムはゼロと区別できません（週末は「リターンのないリスク」）。"}
            </span>
          </div>
        </div>
      )}

      {/* 曜日 × セッション */}
      <div className="mt-3 overflow-x-auto">
        <div className="text-[11px] font-medium text-gray-700 mb-1">
          曜日 × セッション 横断プール（青=正で有意 / 赤=負で有意、t=クラスタ頑健）
        </div>
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left py-1 pr-2 font-medium">セッション</th>
              {[1, 2, 3, 4, 5].map((d) => (
                <th key={d} className="text-right py-1 px-2 font-medium">
                  {WD_LABEL[d]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-100">
              <td className="py-1 pr-2 text-gray-700">日中（始→終）</td>
              {result.weekdayIntraday.map((c, i) => cellTd(c, i))}
            </tr>
            <tr>
              <td className="py-1 pr-2 text-gray-700">平日夜間（終→翌始）</td>
              {result.weekdayOvernight.map((c, i) => cellTd(c, i))}
            </tr>
          </tbody>
        </table>
      </div>

      {/* F 検定 */}
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
        <FBlock label="日中" f={result.fIntraday} />
        <FBlock label="夜間" f={result.fOvernight} />
      </div>

      {/* 銘柄別 週末平均 */}
      {result.weekend.perTicker.length > 0 && (
        <details className="mt-3 text-[11px]">
          <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
            銘柄別の週末ギャップ平均（プールの内訳）
          </summary>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {result.weekend.perTicker.map((p) => (
              <span key={p.ticker} className="text-gray-600">
                {p.name}: <b className={p.mean >= 0 ? "text-blue-700" : "text-red-700"}>{bp(p.mean)}</b>
                <span className="text-gray-400"> (n={p.n})</span>
              </span>
            ))}
          </div>
        </details>
      )}

      <AnalysisGuide title="クロスセクション・プールの詳細理論">
        <p className="font-medium text-gray-700">1. なぜ銘柄をプールするか</p>
        <p>
          単一銘柄・10年では、週末プレミアムや曜日効果を検定する<b>検出力が足りません</b>。
          t = SR·√T なので、10年（T≈520週）で t = 3 に届くには年率シャープ0.95が必要ですが、
          曜日ルールでそんな数字は出ません。そこで複数銘柄をプールして標本を増やします。
        </p>

        <p className="font-medium text-gray-700 mt-3">2. 素朴なプールの罠と、クラスタ頑健SE</p>
        <p>
          ただし「銘柄×日 = 独立標本」と数えると<b>大嘘</b>になります。同じ日は全銘柄がまとめて
          上下する（横断相関）ので、それを無視すると標準誤差が過小に出て<b>偽の有意</b>を量産します。
        </p>
        <p>
          そこで<b>「同一日 = 1クラスタ」</b>としてクラスタ頑健SEを計算します：
        </p>
        <p className="pl-2">{"Var(μ) = (1/N²) · Σ_d ( Σ_{i∈d}(x_i − μ) )²"}</p>
        <p>
          各営業日 d の銘柄残差を<b>先に日ごとに足してから</b>2乗するのがミソで、同一日の銘柄間相関を
          丸ごと吸収します。この分散から<b>実効標本数 nEff</b>（独立標本に換算すると何個ぶんか）が出ます。
          銘柄を増やしても nEff は銘柄数倍にはならず、相関のぶん目減りします。これが横断プールの
          <b>正直な検出力</b>です。
        </p>

        <p className="font-medium text-gray-700 mt-3">3. 用語の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>クラスタ頑健SE</b>：同一クラスタ（ここでは同一営業日）内の相関を許した標準誤差。</li>
          <li><b>nEff（実効標本数）</b>：横断相関を割り引いた「独立標本換算の個数」。nObs ≫ nEff なら相関が強い。</li>
          <li><b>日クラスタ・ブートストラップ</b>：同一日の全銘柄を1束として日付を復元抽出し、横断相関を壊さずに平均のCIを得る方法。</li>
          <li><b>曜日効果 F</b>：曜日5群の平均リターンのばらつき（一元配置ANOVAのF比）。銘柄ごとに計算。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">4. 直感的な例え</p>
        <p>
          満員電車で「今日は揺れたか」を100人に聞いても、独立した100の証言にはなりません。全員同じ
          電車に乗っているので、実質<b>1つの証言</b>に近い。銘柄プールも同じで、同じ日に同じ相場を
          浴びた8銘柄は「8つの独立標本」ではなく、相関のぶん少ない実効標本にしかなりません。
          nEff はその「実質何人ぶんの独立証言か」です。
        </p>

        <p className="font-medium text-gray-700 mt-3">5. 結果の読み方</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>nEff の目減り</b>：nObs と nEff の差が、横断相関の強さそのもの。プールの限界を示します。</li>
          <li>
            <b>週末プレミアム</b>：プールしても t が 2 に届かなければ、週末プレミアムは（この銘柄群では）
            本当に無いと考えるべきです。単一銘柄の非有意が「標本不足」なのか「本当にゼロ」なのかを、
            プールが切り分けます。
          </li>
          <li>
            <b>曜日×セッション表</b>：クラスタ頑健 t が濃い青のセルが、横断的に頑健な曜日×時間帯の
            エッジ候補。多くの銘柄でドリフトは<b>週前半の夜間</b>に出やすい傾向があります。
          </li>
          <li>
            <b>F の棄却数</b>：偶然の期待（5%×銘柄数）をはっきり超えて棄却する銘柄が多ければ、
            共通の曜日構造の証拠。日中で棄却が少なく夜間で多い、といった非対称も読めます。
          </li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">6. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><b>個別で埋もれたエッジの発掘</b>：単一銘柄では非有意でも、横断的に頑健なら実装候補になります。</li>
          <li><b>過信の抑制</b>：nEff が小さいと分かれば、「銘柄を増やせば増やすほど確からしい」という誤解を避けられます。</li>
          <li><b>時間帯の選別</b>：横断的に頑健なセッション（例: 月曜夜間）に建玉を寄せる設計の根拠になります。</li>
        </ul>

        <p className="font-medium text-gray-700 mt-3">7. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            <b>クラスタは日単位</b>です。週や月をまたぐ自己相関（同一銘柄の時系列相関）は完全には
            吸収しません。日クラスタBootのstableやFの棄却分布と合わせて読んでください。
          </li>
          <li>
            <b>ウォッチリスト依存</b>：同業種・高相関の銘柄ばかりだと nEff は特に小さくなります。
            分散した銘柄群のほうがプールの旨みは大きい。
          </li>
          <li>
            <b>F は F(4, 大) 近似</b>の臨界値で棄却を数えています（df1=4）。銘柄ごとの多重検定なので、
            棄却数は「偶然の期待」との比較で読んでください。
          </li>
          <li>
            <b>オーバーナイトは外れ値に敏感</b>。始値の異常プリントがある銘柄はσが歪むため、
            極端な t のセルはデータ品質も疑ってください（本分析は外れ値処理をしていません）。
          </li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
