import { ImageResponse } from "next/og";
import type { ReactNode } from "react";
import { formatSummaryPrice } from "../../lib/format";
import { SITE_HOST, SITE_ORIGIN } from "../../lib/site-url";
import { getStockData } from "../../lib/stock-data.server";
import {
  buildTickerPageSummary,
  getTickerPageInstrument,
  type TickerPageSummary,
} from "../../lib/ticker-pages";
import type { Instrument } from "../../lib/instruments";
import { NOTO_SANS_JP_400_BASE64, NOTO_SANS_JP_700_BASE64 } from "./_fonts/subset-base64";

export const alt = "株価構造分析 — 銘柄の直近1年の実測サマリー";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// page.tsx と同じ理由でリクエスト時生成になる。上流取得が no-store なので ISR も静的化も
// できない（FU21 の判断を参照）。代わりに CDN 側のキャッシュを明示する:
//   s-maxage               = 価格キャッシュの fresh 期間（8時間）と一致させる
//   stale-while-revalidate = 同じく保持期間（7日）。再生成中も古い画像を返す
// これで1銘柄あたりの画像生成は最大でも8時間に1回になり、クローラは再生成を待たされない。
const IMAGE_CACHE_CONTROL =
  "public, max-age=0, s-maxage=28800, stale-while-revalidate=604800";
// 数値の入らなかった画像まで8時間貼り付けない。一過性の上流障害から早く復帰させる。
const FALLBACK_CACHE_CONTROL =
  "public, max-age=0, s-maxage=300, stale-while-revalidate=3600";

/**
 * 同梱サブセットが収録している文字。`_fonts/README.md` の焼き直し手順と対になる唯一の定義。
 * **ここに無い文字を描くと豆腐になる**ので、描画前に必ず covered() を通すこと。
 */
const OG_FONT_CHARSET =
  " %&()+,-./0123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" +
  "·−　、。" +
  "いかくこごさすずそただでなのはばほみらりれをァアィイウエオカガキクグケコサザジス" +
  "セソタダチヂッテデトドナニノハバパヒフブプペボマミムモャヤユヨラリルレロン・ー" +
  "一三上中丸事井京任伊住作価信値備共分券動化友味和品商国在地堂場塚塩士外大天学実富" +
  "小属山崎川工市年忠成所技投指数日旭時最月期本村東松析柄株格業構機武気水海測準点物" +
  "率王現生産田直研確積立第米紅素義自船花菱薬藤製西託証話認豊資越車近通造郵重野金鉄" +
  "鉱銘間隠電（）";

const FONT_GLYPHS = new Set(OG_FONT_CHARSET);

function covered(...texts: string[]): boolean {
  return texts.every((text) => [...text].every((char) => FONT_GLYPHS.has(char)));
}

// フォントは base64 で同梱している（理由は _fonts/subset-base64.ts の冒頭）。
// モジュール評価はインスタンスにつき1回なので、リクエストごとのデコードは起きない。
const fontData = (() => {
  const decoded = [
    Buffer.from(NOTO_SANS_JP_400_BASE64, "base64"),
    Buffer.from(NOTO_SANS_JP_700_BASE64, "base64"),
  ] as const;
  // Buffer.from は不正な base64 でも例外を投げず短い Buffer を返す。壊れた資産を
  // satori へ渡すと不透明な例外になるので、TrueType のマジック（0x00010000）で弾く。
  const looksLikeTrueType = decoded.every(
    (font) => font.length > 1024 && font.readUInt32BE(0) === 0x00010000,
  );
  if (!looksLikeTrueType) {
    console.error("[ticker-og] 同梱フォントが TrueType として読めない。汎用画像へ退避する");
    return null;
  }
  return decoded;
})();

const COLORS = {
  text: "#f8fafc",
  muted: "#a9c6e4",
  accent: "#38bdf8",
  cardBg: "rgba(255,255,255,0.06)",
  cardBorder: "rgba(148,197,236,0.24)",
  // 符号の色はサイト内の既定（正=緑 / 負=赤。text-green-600 / text-red-600 が134箇所）に
  // 合わせる。ただし本文の 600 番台は濃紺の上でコントラストが足りないので、暗色背景用に
  // 既に前例のある 400 番台を使う（#34d399 で 7.9:1・#f87171 で 5.3:1）。
  positive: "#34d399",
  negative: "#f87171",
};

/** 符号を持つ数値の色。持たない数値（現在値・ボラティリティ）は既定の白のまま。 */
function signColor(value: number): string {
  return value >= 0 ? COLORS.positive : COLORS.negative;
}

type Props = { params: Promise<{ ticker: string }> };

export default async function TickerOpengraphImage({ params }: Props) {
  const fonts = fontData;
  if (!fonts) {
    // フォントが無ければ satori は何も描けない。これはデータではなく配置の問題なので、
    // 500 を返さずサイト共通の静的OG画像へ逃がす。
    return Response.redirect(new URL("/opengraph-image.jpg", SITE_ORIGIN), 302);
  }
  const [regular, bold] = fonts;
  const fontConfig = [
    { name: "Noto Sans JP", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "Noto Sans JP", data: bold, weight: 700 as const, style: "normal" as const },
  ];

  const { ticker: requestedTicker } = await params;
  const instrument = getTickerPageInstrument(requestedTicker);

  // 銘柄名がサブセットの外なら、豆腐を出すより銘柄名を諦める。
  const renderable =
    instrument !== undefined &&
    covered(instrument.name, instrument.ticker, instrument.market, instrument.currency);
  if (!renderable) {
    if (instrument) {
      console.warn(`[ticker-og] ${instrument.ticker}: 銘柄名がフォントサブセット外。汎用画像へ退避`);
    }
    return new ImageResponse(<GenericCard />, {
      ...size,
      fonts: fontConfig,
      headers: { "cache-control": FALLBACK_CACHE_CONTROL },
    });
  }

  try {
    // page.tsx と同じ 10y で取る。1y にすると range がキャッシュキーに入る都合で
    // （stock-data.server.ts の cacheKey()）、アプリ本体も銘柄ページも温めない
    // 専用エントリになり、画像生成のたびに MISS を踏む。掲載する直近1年は
    // buildTickerPageSummary() が切り出すので、数値は 1y で取るのと同じである。
    const data = await getStockData(instrument.yahooSymbol, "10y");
    const summary = buildTickerPageSummary(data.prices);
    if (
      summary &&
      covered(data.currency, formatSummaryPrice(summary.currentPrice, data.currency))
    ) {
      return new ImageResponse(
        <InstrumentCard instrument={instrument} summary={summary} unit={data.currency} />,
        { ...size, fonts: fontConfig, headers: { "cache-control": IMAGE_CACHE_CONTROL } },
      );
    }
  } catch (error) {
    console.error(`[ticker-og] failed to load ${instrument.yahooSymbol}`, error);
  }

  // 価格を取れなかった銘柄。ページ側が noindex を返す状態と足並みを揃え、数値は一切載せない。
  return new ImageResponse(<InstrumentCard instrument={instrument} />, {
    ...size,
    fonts: fontConfig,
    headers: { "cache-control": FALLBACK_CACHE_CONTROL },
  });
}

/** 銘柄名の長さに応じて字を詰める。CJK は全角、ASCII は約0.55倍の幅として見積もる。 */
function nameFontSize(name: string): number {
  const width = [...name].reduce(
    (sum, char) => sum + (char.codePointAt(0)! < 0x2e80 ? 0.55 : 1),
    0,
  );
  if (width <= 6) return 88;
  if (width <= 9) return 74;
  if (width <= 12) return 62;
  if (width <= 16) return 50;
  return 40;
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "54px 64px",
        backgroundColor: "#071324",
        backgroundImage: "linear-gradient(135deg, #061222 0%, #0e2c52 52%, #08192e 100%)",
        color: COLORS.text,
        fontFamily: "Noto Sans JP",
      }}
    >
      {children}
    </div>
  );
}

function Header({ left }: { left: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: 12,
            marginRight: 14,
            backgroundColor: COLORS.accent,
          }}
        />
        <div style={{ fontSize: 26, color: COLORS.muted }}>{left}</div>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: "#dce9f7" }}>株価構造分析</div>
    </div>
  );
}

function Footer({ right }: { right: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
      <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: 6, color: COLORS.accent }}>
        {SITE_HOST}
      </div>
      <div style={{ fontSize: 22, color: COLORS.muted }}>{right}</div>
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flexGrow: 1,
        flexBasis: 0,
        padding: "20px 22px",
        borderRadius: 18,
        backgroundColor: COLORS.cardBg,
        border: `1px solid ${COLORS.cardBorder}`,
      }}
    >
      <div style={{ fontSize: 20, color: COLORS.muted }}>{label}</div>
      <div style={{ fontSize: 38, fontWeight: 700, marginTop: 10, color: color ?? COLORS.text }}>
        {value}
      </div>
    </div>
  );
}

function InstrumentCard({
  instrument,
  summary,
  unit,
}: {
  instrument: Instrument;
  summary?: TickerPageSummary;
  unit?: string;
}) {
  const currency = unit ?? instrument.currency;
  return (
    <Frame>
      <Header left={`${instrument.market} · ${currency}`} />

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{ fontSize: nameFontSize(instrument.name), fontWeight: 700, lineHeight: 1.18 }}
        >
          {instrument.name}
        </div>
        <div style={{ fontSize: 26, color: COLORS.muted, marginTop: 14 }}>
          {`銘柄コード ${instrument.ticker}`}
        </div>
      </div>

      {summary ? (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
          <Metric
            label={`現在値 ${currency}`}
            value={formatSummaryPrice(summary.currentPrice, currency)}
          />
          <Metric
            label="期間リターン"
            value={signedPercent(summary.periodReturn)}
            color={signColor(summary.periodReturn)}
          />
          <Metric label="年率ボラティリティ" value={plainPercent(summary.annualizedVolatility)} />
          <Metric
            label="最大ドローダウン"
            value={signedPercent(summary.maxDrawdown)}
            color={signColor(summary.maxDrawdown)}
          />
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            padding: "24px 26px",
            borderRadius: 18,
            backgroundColor: COLORS.cardBg,
            border: `1px solid ${COLORS.cardBorder}`,
            fontSize: 28,
            color: COLORS.muted,
          }}
        >
          実測値を準備中です
        </div>
      )}

      <Footer
        right={summary ? `直近1年 · ${formatAsOf(summary.asOf)}時点` : "直近1年の実測サマリー"}
      />
    </Frame>
  );
}

/** 銘柄を特定できないときの汎用カード。数値も銘柄名も載せない。 */
function GenericCard() {
  return (
    <Frame>
      <Header left="実測データの分析" />
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 88, fontWeight: 700, lineHeight: 1.18 }}>株価構造分析</div>
        <div style={{ fontSize: 30, color: COLORS.muted, marginTop: 18 }}>
          市場の隠れた構造を、データから。
        </div>
      </div>
      <Footer right="実測サマリーは銘柄ページでご確認ください" />
    </Frame>
  );
}

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function plainPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatAsOf(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}
