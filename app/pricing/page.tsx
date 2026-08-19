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
  "分析条件と結果を保存し、複数銘柄を同じ基準で継続比較できる",
  "全244パネル（ボラティリティ、周波数領域、非線形動力学、情報理論、フラクタル、ネットワーク、条件付き分析、エッジ探索、レジーム、因果、テイルリスク、カレンダー、シミュレーション、裁量、デリバティブ）",
  "期間は最長10年",
  "ポートフォリオ横断分析（相関ドラッグ、効率的フロンティア、リスク寄与度）",
  "ウォッチリスト無制限・設定の保存",
  "CSV / 画像エクスポート",
];

type PricingPageProps = {
  searchParams: Promise<{ waitlist?: string | string[] }>;
};

const WAITLIST_MESSAGES: Record<string, { text: string; success: boolean }> = {
  registered: {
    text: "登録を受け付けました。すでに登録済みの場合も、追加の操作は不要です。",
    success: true,
  },
  db_unconfigured: {
    text: "現在この環境では登録先が設定されていません。提供環境の準備後に、もう一度お試しください。",
    success: false,
  },
  invalid_request: { text: "送信内容を確認して、もう一度お試しください。", success: false },
  invalid_email: { text: "メールアドレスの形式を確認してください。", success: false },
  email_too_long: { text: "メールアドレスが長すぎます。", success: false },
  consent_required: { text: "利用目的を確認し、同意してください。", success: false },
  error: {
    text: "登録に失敗しました。時間をおいて再度お試しください。",
    success: false,
  },
};

export default async function PricingPage({ searchParams }: PricingPageProps) {
  const waitlistParam = (await searchParams).waitlist;
  const waitlistStatus = Array.isArray(waitlistParam) ? waitlistParam[0] : waitlistParam;
  const waitlistMessage = waitlistStatus ? WAITLIST_MESSAGES[waitlistStatus] : undefined;

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
                <span className="text-green-700">✓</span>
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
          <form id="waitlist" action="/api/waitlist" method="post" className="mt-5 border-t border-gray-200 pt-5">
            <h3 className="text-sm font-semibold text-gray-800">Pro の案内を受け取る</h3>
            <p id="waitlist-purpose" className="mt-1 text-xs leading-relaxed text-gray-600">
              登録したメールアドレスは、Pro の提供開始、予定機能、料金に関する案内の送信にのみ使用します。
            </p>
            <label htmlFor="waitlist-email" className="mt-3 block text-xs font-medium text-gray-700">
              メールアドレス
            </label>
            <input
              id="waitlist-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              aria-describedby="waitlist-purpose waitlist-status"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
              placeholder="you@example.com"
            />
            <label className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-gray-600">
              <input
                type="checkbox"
                name="consent"
                value="yes"
                required
                className="mt-0.5 size-4 shrink-0"
              />
              <span>上記の利用目的を確認し、メールアドレスの保存と案内の受信に同意します。</span>
            </label>
            <button
              type="submit"
              className="mt-4 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
            >
              待機リストに登録
            </button>
            <p
              id="waitlist-status"
              role="status"
              className={`mt-3 text-xs leading-relaxed ${
                waitlistMessage
                  ? waitlistMessage.success
                    ? "text-green-700"
                    : "text-amber-700"
                  : "text-gray-500"
              }`}
            >
              {waitlistMessage?.text ?? "登録は無料です。決済情報の入力はありません。"}
            </p>
          </form>
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
