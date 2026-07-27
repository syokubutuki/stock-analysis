import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "プラン",
  // 決済が未実装のうちは検索に出さない。sitemap.ts にも載せていない。
  robots: { index: false, follow: false },
};

const FREE_FEATURES = [
  "基本分析・テクニカル・OHLC分析・分布・相関・リスク指標・スケール変換（86パネル）",
  "検証用パネル：ヌル較正、ウォークフォワード頑健性、検出力の壁、エッジ減衰検知、多重検定台帳",
  "期間は1年まで",
  "ウォッチリスト3銘柄",
  "東証・米国株・投資信託に対応",
];

const PRO_FEATURES = [
  "全244パネル（ボラティリティ、周波数領域、非線形動力学、情報理論、フラクタル、ネットワーク、条件付き分析、エッジ探索、レジーム、因果、テイルリスク、カレンダー、シミュレーション、裁量、デリバティブ）",
  "期間は最長10年",
  "ポートフォリオ横断分析（相関ドラッグ、効率的フロンティア、リスク寄与度）",
  "ウォッチリスト無制限・設定の保存",
  "CSV / 画像エクスポート",
];

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <Link href="/" className="text-sm text-blue-600 hover:underline">
        ← 分析に戻る
      </Link>

      <h1 className="mt-4 text-2xl font-bold text-gray-800">プラン</h1>

      <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">Pro は準備中です。</p>
        <p className="mt-1">
          現在はすべてのパネルを無料で利用できます。決済の受付は行っていません。
          料金は検討中の目安であり、確定したものではありません。
        </p>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {/* 無料 */}
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="font-bold text-gray-800">無料</h2>
          <p className="mt-1 text-2xl font-bold text-gray-900">
            0<span className="text-sm font-normal text-gray-500"> 円</span>
          </p>
          <p className="mt-1 text-xs text-gray-500">登録不要</p>
          <ul className="mt-4 space-y-2 text-xs text-gray-600">
            {FREE_FEATURES.map((f) => (
              <li key={f} className="flex gap-2">
                <span className="text-green-600">✓</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Pro */}
        <section className="rounded-xl border-2 border-blue-200 bg-white p-5">
          <h2 className="font-bold text-gray-800">Pro</h2>
          <p className="mt-1 text-2xl font-bold text-gray-900">
            1,480
            <span className="text-sm font-normal text-gray-500"> 円 / 月（予定）</span>
          </p>
          <p className="mt-1 text-xs text-gray-500">無料枠のすべてに加えて</p>
          <ul className="mt-4 space-y-2 text-xs text-gray-600">
            {PRO_FEATURES.map((f) => (
              <li key={f} className="flex gap-2">
                <span className="text-blue-600">＋</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
          <button
            disabled
            className="mt-5 w-full cursor-not-allowed rounded-lg bg-gray-200 px-4 py-2 text-sm font-medium text-gray-500"
          >
            準備中
          </button>
        </section>
      </div>

      {/* 何を売っていて、何を売っていないか */}
      <section className="mt-8 rounded-xl border border-gray-200 bg-gray-50 p-5">
        <h2 className="font-bold text-gray-800">課金の対象について</h2>
        <p className="mt-2 text-xs leading-relaxed text-gray-600">
          有料の対象は<b className="text-gray-700">計算手法の広さ、期間の長さ、ポートフォリオ横断、保存機能</b>
          です。売買の推奨は有料機能に含めません。本サイトは投資助言ではなく、
          統計量を計算して可視化するツールであり、特定の銘柄の売買を推奨しません。
        </p>
        <p className="mt-2 text-xs leading-relaxed text-gray-600">
          また、<b className="text-gray-700">検証用のパネルは無料枠に含めています</b>。
          ヌル較正・ウォークフォワード・検出力・エッジ減衰は「見つけた傾向が偶然ではないか」を
          確かめるための道具です。傾向を探す機能だけを配って、それを疑う手段を有料にするのは
          筋が通らないと考えているためです。
        </p>
      </section>
    </main>
  );
}
