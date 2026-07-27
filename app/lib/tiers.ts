/**
 * 無料 / 有料（Pro）の境界を定義する唯一の場所。
 *
 * 設計方針（重要 — 変更する前に読むこと）
 * =========================================
 * **計算と可視化に課金する。推奨には課金しない。**
 *
 * 有料の壁の内側に「今これを買え」と読める出力を置くと、報酬を得て特定の
 * 有価証券について助言する構図に近づき、金融商品取引法上の投資助言業
 * （無登録営業）の問題に触れる。したがって課金対象は
 *   - 手法の広さ（高度な統計手法へのアクセス）
 *   - 期間の長さ
 *   - ポートフォリオ横断
 *   - 保存・エクスポート
 * に限る。個別銘柄の売買推奨は有料機能にしない。
 *
 * **検証基盤は無料側に置く。**
 * ヌル較正・ウォークフォワード・検出力・エッジ減衰・多重検定台帳は、
 * 「見つけたエッジが偶然ではないか」を潰すための道具である。
 * これを有料にすると、無料ユーザーにエッジ探索だけを見せて
 * 反証の手段を売ることになる。毒を配って解毒剤を売る構造は、
 * 「正確性が最優先」という本プロジェクトの原則と衝突する。
 * カテゴリ上は有料側（edge / calendar）にあるが、個別に無料へ引き上げる。
 */

/** 課金の総スイッチ。Stripe と認証が入るまで false のままにする。
 *  false の間、全ユーザーが全パネルを見られる（現状維持）。 */
export const PAYWALL_ENABLED = false;

export type Tier = "free" | "pro";

/** 無料で開放するカテゴリ接頭辞。 */
const FREE_CATEGORIES = new Set([
  "basic", // 基本分析
  "tech", // テクニカル
  "ohlc", // OHLC分析
  "dist", // 分布・相関
  "risk", // リスク指標
  "transform", // スケール変換
]);

/** Series Explorer（sa-*）用。2番目のセグメントが実カテゴリを表す。
 *  例: sa-ohlc-gap → ohlc（無料） / sa-frequency-ssa → frequency（有料） */
const FREE_SERIES_SEGMENTS = new Set([
  "technical",
  "ohlc",
  "risk",
  "transform",
  "distribution",
]);

/**
 * カテゴリは有料だが、個別に無料へ引き上げるパネル。
 * ここに並ぶのは「自分の発見を疑うための道具」であって、
 * 発見そのものを増やす道具ではない。上のコメントの理由により無料。
 */
const FREE_PANEL_IDS = new Set([
  "edge-walkforward", // ウォークフォワード頑健性（DSR + PBO）
  "edge-power", // 検出力の壁（今の標本で証明できるか）
  "edge-decay", // エッジ減衰・死亡検知（SPRT + CUSUM）
  "edge-ledger", // 前向き検証台帳（凍結→未来のデータだけで採点）
  "edge-test-registry", // グローバル多重検定台帳（偽発見の床）
  "cal-null-calib", // ヌル較正：偽発見の床（採用前の門番）
  "cal-null-anatomy", // 曜日構造の解剖（maxT / F分解 / 頑健性）
  "cal-weekly-analog-oos", // アナログ予測力のOOS検証（多重比較補正）
]);

/** パネルIDが無料枠かどうか。ID体系は `<category>-<name>` と `sa-<category>-<name>`。 */
export function isPanelFree(id: string): boolean {
  if (FREE_PANEL_IDS.has(id)) return true;

  const seg = id.split("-");
  if (seg[0] === "sa") {
    // sa- 単体（sa-technical 等）と sa-<cat>-<name> の両方を扱う
    return seg.length > 1 && FREE_SERIES_SEGMENTS.has(seg[1]);
  }
  return FREE_CATEGORIES.has(seg[0]);
}

/** 現在の権限でこのパネルを開けるか。 */
export function canViewPanel(id: string, tier: Tier): boolean {
  if (!PAYWALL_ENABLED) return true;
  return tier === "pro" || isPanelFree(id);
}

/** 無料枠の期間上限。Pro は全期間。 */
export const FREE_MAX_RANGE = "1y";

/** 無料枠のウォッチリスト登録上限。 */
export const FREE_WATCHLIST_LIMIT = 3;
