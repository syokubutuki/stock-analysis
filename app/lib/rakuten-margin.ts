// =============================================================
// 楽天証券・信用取引コスト（単一ソース・オブ・トゥルース）
// -------------------------------------------------------------
// 本ファイルは信用取引の金利・貸株料・諸経費を「楽天証券の実際のコスト」で一元管理する。
// 各シミュレータ（nisa-vs-taxable / vol-targeting 等）はここから定数を取り込むこと。
//
// 出典（2026年時点・公式）:
//   信用取引 手数料／金利／貸株料
//   https://www.rakuten-sec.co.jp/web/domestic/margin/commission.html
//   信用取引の基本ルール（事務管理費・名義書換料）
//   https://www.rakuten-sec.co.jp/web/domestic/margin/rule/ground_rules.html
//
// レートは制度改定で変わりうる。改定時は本ファイルのみ更新すれば全分析に反映される。
// =============================================================

// 信用区分。売買手数料は楽天「ゼロコース」で全区分0円が前提。
export type MarginKind =
  | "system"           // 制度信用（返済期限6か月・逆日歩あり）
  | "generalUnlimited" // 一般信用「無期限」（返済期限なし・逆日歩なし）
  | "generalShort"     // 一般信用「短期」（主に空売り、貸株料が高い）
  | "ichinichi";       // いちにち信用（デイトレ専用・金利/貸株料0%）

// 金利プラン。優遇（大口優遇/デビュー応援等の条件を満たした場合の低金利）。
export type RatePlan = "standard" | "preferential";

export interface MarginRate {
  longRate: number;  // 買方金利（年率, 小数）
  shortRate: number; // 貸株料（年率, 小数）
  label: string;     // 表示名
  preferential?: boolean; // 優遇金利か
}

// 買方金利・貸株料（年率）。制度信用（通常）を既定とする。
// 「一般信用（短期）」は買方金利の公表値がないため、無期限と同じ買方金利＋短期の貸株料3.90%とする。
export const RAKUTEN_MARGIN_RATES: Record<MarginKind, Record<RatePlan, MarginRate | undefined>> = {
  system: {
    standard:     { longRate: 0.0280, shortRate: 0.0110, label: "制度信用（通常）" },
    preferential: { longRate: 0.0228, shortRate: 0.0110, label: "制度信用（優遇）", preferential: true },
  },
  generalUnlimited: {
    standard:     { longRate: 0.0280, shortRate: 0.0110, label: "一般信用「無期限」（通常）" },
    preferential: { longRate: 0.0210, shortRate: 0.0110, label: "一般信用「無期限」（優遇）", preferential: true },
  },
  generalShort: {
    standard:     { longRate: 0.0280, shortRate: 0.0390, label: "一般信用「短期」" },
    preferential: undefined,
  },
  ichinichi: {
    standard:     { longRate: 0.0000, shortRate: 0.0000, label: "いちにち信用（デイトレ）" },
    preferential: undefined,
  },
};

// 表示順（UIのセレクタ用）
export const MARGIN_KIND_ORDER: MarginKind[] = ["system", "generalUnlimited", "generalShort", "ichinichi"];

export const MARGIN_KIND_LABEL: Record<MarginKind, string> = {
  system: "制度信用",
  generalUnlimited: "一般信用「無期限」",
  generalShort: "一般信用「短期」",
  ichinichi: "いちにち信用",
};

// 指定区分・プランのレートを解決（優遇が無い区分は通常にフォールバック）。
export function resolveMarginRate(kind: MarginKind, plan: RatePlan = "standard"): MarginRate {
  const byPlan = RAKUTEN_MARGIN_RATES[kind];
  return byPlan[plan] ?? byPlan.standard!;
}

// ---- 既定値（＝制度信用・通常） ----
export const DEFAULT_MARGIN_KIND: MarginKind = "system";
export const DEFAULT_MARGIN_RATE_LONG = RAKUTEN_MARGIN_RATES.system.standard!.longRate;  // 2.80%
export const DEFAULT_SHORT_FEE_RATE = RAKUTEN_MARGIN_RATES.system.standard!.shortRate;   // 1.10%

// ---- 委託保証金・レバレッジ ----
export const INITIAL_MARGIN_RATE = 0.30;   // 委託保証金率（新規建て時に必要な保証金の割合）
export const DEFAULT_MAINTENANCE = 0.20;   // 最低委託保証金維持率（これを割ると追証）
export const MAX_LEVERAGE = 3.3;           // ≒ 1/0.30。委託保証金率の逆数＝現実的なレバ上限

// ---- 諸経費（金利・貸株料以外） ----
// 事務管理費: 建約定日から1か月経過するごとに1株あたり11銭（税込）。売買単位1株の銘柄は1株110円。
export const ADMIN_FEE_PER_SHARE_MONTHLY = 0.11; // 円/株/月（税込）
// 名義書換料: 権利確定日を越えて買建の場合、建玉ごと1売買単位あたり55円（税込）。ETF/ETNは5.5円。
export const TRANSFER_FEE_PER_LOT = 55;          // 円/売買単位（税込）
export const DEFAULT_LOT_SIZE = 100;             // 標準的な売買単位（株）
export const DEFAULT_RECORD_DATES_PER_YEAR = 2;  // 権利確定日/年（中間＋期末の想定）
// 平均的な1か月の暦日数（事務管理費の「1か月経過ごと」判定に使用）
export const DAYS_PER_MONTH = 365.25 / 12;       // ≒ 30.44

// ---- 諸経費を「建玉notionalに対する割合」へ換算するヘルパー ----
// 事務管理費（1か月あたりのnotional比）。refPrice=株価（円）。
// 例）株価3,000円 → 0.11/3000 ≒ 0.0037%/月 ≒ 0.044%/年。低位株ほど相対負担が重い。
export function adminFeeMonthlyRate(refPrice: number): number {
  return refPrice > 0 ? ADMIN_FEE_PER_SHARE_MONTHLY / refPrice : 0;
}

// 名義書換料（買建notionalに対する年率・期待値）。権利確定日を跨ぐ回数の期待値で年率換算。
// = 55円 × 権利確定日回数/年 ÷（株価 × 売買単位）。買建てのみ。
export function transferFeeAnnualRate(
  refPrice: number,
  lotSize: number = DEFAULT_LOT_SIZE,
  recordDatesPerYear: number = DEFAULT_RECORD_DATES_PER_YEAR,
): number {
  const notionalPerLot = refPrice * lotSize;
  return notionalPerLot > 0 ? (TRANSFER_FEE_PER_LOT * recordDatesPerYear) / notionalPerLot : 0;
}
