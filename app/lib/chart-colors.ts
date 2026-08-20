/**
 * チャート描画の共通配色。
 *
 * ## なぜこのファイルがあるか
 * Canvas2D は色を文字列で直接渡すため、Tailwind のクラス置換（A1）が届かない。
 * その結果 `#9ca3af` / `#94a3b8`（白系背景で **2.5:1**）が 170ファイル・387箇所に
 * 散らばり、軸ラベルが WCAG AA（本文 4.5:1）にも 1.4.11（非テキスト 3:1）にも
 * 届いていなかった（FU12）。
 *
 * **Canvas に色を直書きしないこと。** 追加・変更はこのファイルだけで行う。
 *
 * ## globals.css の `@theme inline`（Q3 のデザイントークン）との対応
 * Canvas は CSS 変数を読めないので同じ値をここに複製している。**片方だけ変えないこと。**
 *
 * | ここ | globals.css | 用途 |
 * |---|---|---|
 * | `ink`  | `--color-fg-muted` `#4a5565`     | Canvas 内のテキスト |
 * | `grid` | `--color-border-default` `#e5e7eb` | 純粋な装飾グリッド |
 * | `surface` | `--color-surface-canvas` に相当 | Canvas 背景 |
 *
 * ## コントラスト（Canvas 背景は全て `#fafafa` か `#ffffff`）
 * | 定数 | 値 | vs #fafafa | 適用基準 |
 * |---|---|---|---|
 * | `ink`       | `#4a5565` | 7.40:1 | 本文 4.5:1 → 満たす |
 * | `axis`      | `#6b7280` | 4.73:1 | 非テキスト 3:1 → 満たす |
 * | `reference` | `#6b7280` | 4.73:1 | 意味を持つ線は 3:1 → 満たす |
 * | `neutral`   | `#6b7280` | 4.73:1 | 意味を持つ系列は 3:1 → 満たす |
 * | `grid`      | `#e5e7eb` | 1.14:1 | **純粋な装飾のみ**（1.4.11 の適用外）。
 *   ここに意味（ゼロ線・臨界値など）を載せるなら `reference` を使うこと |
 */
export const CHART_COLORS = {
  /** Canvas 内のテキスト（軸ラベル・目盛り・注釈・軸タイトル）。本文扱いで 4.5:1 が要る */
  ink: "#4a5565",
  /** 軸線・実線の補助線 */
  axis: "#6b7280",
  /** 意味を持つ破線（ゼロ線・臨界値・平均・目標水準） */
  reference: "#6b7280",
  /** 中立を表す系列・凡例（B&H・待機・中立ビン・無条件平均） */
  neutral: "#6b7280",
  /** 純粋な装飾グリッド。意味を持たせないこと */
  grid: "#e5e7eb",
  /** Canvas 背景 */
  surface: "#fafafa",
} as const;

/**
 * 方向（上昇・下落）の配色。
 *
 * ## 配色方針の判断（A4 / 親文書 §8 V8）— 2026-08-18 決定
 * **米国式（緑=上昇 / 赤=下落）を維持する。** 日本式（赤=上昇 / 青=下落）へは倒さない。
 *
 * 理由:
 * 1. **赤が二重の意味になる。** 本アプリの赤 `#dc2626` は 204箇所で「有意・警告・悪い」を
 *    担っており（p値・破損検出・過剰ドローダウン等）、青 `#2563eb` は 155箇所で
 *    単なる系列色である。赤を「上昇＝好ましい」に割り当てると、同一画面で
 *    「赤い＝良い」と「赤い＝警告」が同時に成立して読めなくなる。
 * 2. **本アプリの文脈はクオンツ寄りである。** `docs/investment-axioms.md` を土台にした
 *    統計・検定中心の構成で、`lightweight-charts` の既定も teal/red である。
 * 3. **どちらの配色でも色覚の問題は解決しない。** 赤緑・赤青いずれも識別困難な型があり、
 *    実際に解決するのは第2の手がかりのほうである。したがって配色論争より
 *    `DIRECTION_GLYPH` と符号の徹底に投資する。
 *
 * 切替設定は採らなかった。up/down を意味する箇所と、別の意味で赤・青を使っている箇所の
 * 選別が機械的にできず（上記1）、切替の実装コストは日本式への全面変更と同じだからである。
 */
export const DIRECTION_COLORS = {
  up: "#16a34a",
  down: "#dc2626",
  flat: CHART_COLORS.neutral,
} as const;

/**
 * **テキストに使う方向色。** 上の `DIRECTION_COLORS` は白背景で
 * up = 3.30:1 しかなく、図形（非テキスト 3:1）では足りるが**本文では AA 未達**である。
 * 文字に色を付けるときは必ずこちらを使うこと。
 *
 * | | 値 | vs #ffffff |
 * |---|---|---|
 * | up   | `#15803d` (green-700) | 5.02:1 |
 * | down | `#b91c1c` (red-700)   | 6.47:1 |
 */
export const DIRECTION_TEXT_COLORS = {
  up: "#15803d",
  down: "#b91c1c",
  flat: CHART_COLORS.ink,
} as const;

/** Tailwind クラス版（`DIRECTION_TEXT_COLORS` と同じ値） */
export const DIRECTION_TEXT_CLASS = {
  up: "text-green-700",
  down: "text-red-700",
  flat: "text-fg-muted",
} as const;

/** 色に依存せず方向が読める記号（A4 の第2の手がかり）。読み上げにも乗る */
export const DIRECTION_GLYPH = {
  up: "▲",
  down: "▼",
  flat: "→",
} as const;

/** スクリーンリーダー・凡例用の日本語ラベル */
export const DIRECTION_LABEL = {
  up: "上昇",
  down: "下落",
  flat: "変化なし",
} as const;

export type Direction = keyof typeof DIRECTION_COLORS;

/** 数値の符号から方向を決める。`eps` 未満は `flat` 扱い */
export function directionOf(value: number, eps = 0): Direction {
  if (!Number.isFinite(value)) return "flat";
  if (value > eps) return "up";
  if (value < -eps) return "down";
  return "flat";
}

/**
 * 符号を必ず明示した文字列。正の値に `+` を付けるのが第2の手がかりの最小形。
 * マイナスは U+2212（真のマイナス記号）を使い、ハイフンとの見間違いを防ぐ。
 */
export function withSign(value: number, digits = 2, suffix = ""): string {
  if (!Number.isFinite(value)) return "—";
  const body = Math.abs(value).toFixed(digits);
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return `${sign}${body}${suffix}`;
}

/** `withSign` の百分率版（引数は比率ではなく既に%の値） */
export function withSignPercent(value: number, digits = 2): string {
  return withSign(value, digits, "%");
}

/**
 * ローソク足の共通オプション（A4 の第2の手がかり）。
 *
 * **上昇＝中空（白抜き）／下落＝塗りつぶし。** 色を落としても本数の向きが読める。
 * 出来高チャートの伝統的な表記で、色覚特性に依存しない。
 * `lightweight-charts` の既定は上下とも塗りつぶしのため、そのままだと色だけが手がかりになる。
 *
 * 背景は各チャートとも `layout.background = #ffffff` である。中空表現はこれに依存するので、
 * 背景を変えるときは `upColor` も合わせること。
 */
export const CANDLESTICK_OPTIONS = {
  /** 上昇は中空（背景色で塗る）。輪郭とヒゲだけが残る */
  upColor: "#ffffff",
  borderUpColor: "#0f766e",
  wickUpColor: "#0f766e",
  /** 下落は塗りつぶし */
  downColor: "#ef5350",
  borderDownColor: "#c2312d",
  wickDownColor: "#c2312d",
  borderVisible: true,
} as const;

/** ローソク足の凡例に添える説明。表記規則を画面に出さないと第2の手がかりは伝わらない */
export const CANDLESTICK_LEGEND = "中空（白抜き）＝陽線・上昇／塗りつぶし＝陰線・下落";
