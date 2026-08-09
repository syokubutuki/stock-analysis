// =============================================================
// 株価指数先物のコスト・建玉単位（単一ソース・オブ・トゥルース）
// -------------------------------------------------------------
// `rakuten-margin.ts` の兄弟。信用取引のコストが「買方金利・貸株料・諸経費」で決まるのに対し、
// 先物のコストは「限月ロールの滑り・売買手数料・SPAN証拠金・建玉の刻み」で決まる。
// 設計は docs/sector-market-hedge.md §4.1。
//
// 先物が信用売りと決定的に違うのは**キャリーが存在しないこと**。無裁定価格
//   F_t = S_t·e^{(r−q)(T−t)}
// を微分すると、売り建ての損益は
//   −dF/F = −dS/S + (r−q)dt = −(TR_M − q) + (r−q) = −TR_M + r = −R_M
// となり、**市場の超過リターンをちょうど符号反転したもの**になる（docs §2.4(a)）。
// 配当は先物価格に織り込み済みなので配当落調整金の支払いは発生せず、証拠金に金利が
// 付かないぶんは先物価格のディスカウントとして先に受け取っている。
// ゆえに先物のコストは **ロール滑り＋手数料＋税ドラッグ**だけになる。
//
// 出典:
//   JPX 株価指数先物取引の取引要綱（取引単位・限月）
//   https://www.jpx.co.jp/derivatives/products/domestic/index-futures/index.html
//   楽天証券 先物・オプション取引の手数料
//   https://www.rakuten-sec.co.jp/web/domestic/futureoption/commission.html
//   JPX 証拠金（SPAN/VaR。所要額は日々変動する）
//   https://www.jpx.co.jp/markets/derivatives/margin/
//
// **手数料・SPAN証拠金・無リスク金利・配当利回り・指数水準は変動する。**
// 公式値を実装時に確認できなかった項目には `// 要確認` を残してある。UI では必ず
// パラメータとして開き、既定値を鵜呑みにさせないこと。
// =============================================================

export type FuturesProduct = "topixMini" | "topixLarge" | "nikkeiMini" | "nikkeiMicro";

export interface FuturesSpec {
  label: string;
  /** 1枚 = 指数 × multiplier 円。ミニTOPIX = 1,000 / TOPIX（ラージ）= 10,000。 */
  multiplier: number;
  /** 片道手数料（円/枚・税込）。 */
  commissionPerLot: number;
  /** SPAN証拠金の目安（円/枚）。 */
  spanMarginPerLot: number;
  /** 限月ロール回数（主力の四半期限月で建てる想定なら 4）。 */
  rollsPerYear: number;
  underlying: "TOPIX" | "N225";
}

export const FUTURES_SPECS: Record<FuturesProduct, FuturesSpec> = {
  topixMini: {
    label: "ミニTOPIX先物",
    multiplier: 1_000,
    commissionPerLot: 42, // 要確認（楽天証券の先物手数料。年率換算で ≒0.01%/年 になる水準）
    spanMarginPerLot: 150_000, // 要確認・変動（SPAN証拠金は日々改定される）
    rollsPerYear: 4,
    underlying: "TOPIX",
  },
  topixLarge: {
    label: "TOPIX先物（ラージ）",
    multiplier: 10_000,
    commissionPerLot: 275, // 要確認
    spanMarginPerLot: 1_500_000, // 要確認・変動
    rollsPerYear: 4,
    underlying: "TOPIX",
  },
  nikkeiMini: {
    label: "日経225mini",
    multiplier: 100,
    commissionPerLot: 42, // 要確認
    spanMarginPerLot: 130_000, // 要確認・変動
    rollsPerYear: 4,
    underlying: "N225",
  },
  nikkeiMicro: {
    label: "日経225マイクロ",
    multiplier: 10,
    commissionPerLot: 11, // 要確認
    spanMarginPerLot: 13_000, // 要確認・変動
    rollsPerYear: 4,
    underlying: "N225",
  },
};

/** 表示順（UI のセレクタ用）。 */
export const FUTURES_PRODUCT_ORDER: FuturesProduct[] = [
  "topixMini",
  "topixLarge",
  "nikkeiMini",
  "nikkeiMicro",
];

export const DEFAULT_FUTURES_PRODUCT: FuturesProduct = "topixMini";

/** 代用有価証券の掛目（現物株を証拠金に充当するときの評価率）。 */
export const SUBSTITUTE_HAIRCUT = 0.8;

/**
 * 限月ロールの滑り（年率）。限月間スプレッドが理論ベーシスから乖離するぶんで、
 * **理論値ではなく実測すべき量**。ここは既定パラメータに留め、UI で開く。
 */
export const DEFAULT_ROLL_SLIPPAGE = 0.001; // 0.10%/年 // 要確認（実測が要る）

/** 無リスク金利 r（年率）。 */
export const DEFAULT_RISK_FREE = 0.0075; // 要確認（短期金利の水準は随時更新すること）

/** TOPIX の配当利回り q（年率）。 */
export const DEFAULT_INDEX_DIV_YIELD = 0.022; // 要確認

/**
 * 指数水準（先物の建玉の刻みを円で出すために要る）。
 * 市場ETF（1306.T）の終値から換算するか、UI で直接入力させる。
 */
export const DEFAULT_INDEX_LEVEL = 2900; // 要確認（直近の指数水準に更新すること）

/**
 * 先物取引に係る雑所得等の税率（申告分離課税・復興特別所得税こみ）。
 * 株式等の譲渡所得と**同率だが通算できない**点が実務上の分かれ目（docs §2.5）。
 */
export const FUTURES_TAX_RATE = 0.20315;

/** 1枚あたりの想定元本（円）。 */
export function notionalPerLot(indexLevel: number, product: FuturesProduct): number {
  return Math.max(0, indexLevel) * FUTURES_SPECS[product].multiplier;
}

/**
 * 目標 notional（円・売り建ては正、買い建ては負で渡してよい）に最も近い枚数。
 * 刻みが粗いので四捨五入する。0 枚に丸まることは普通に起きる（＝その h は作れない）。
 */
export function lotsFor(notional: number, indexLevel: number, product: FuturesProduct): number {
  const per = notionalPerLot(indexLevel, product);
  return per > 0 ? Math.round(notional / per) : 0;
}

/**
 * 元本 V で実際に作れるヘッジ倍率 h の格子。**負（＝市場の買い建て）を必ず含める**。
 * docs §7.4 のとおり、既定の結論は h\*<0 になる公算が高く、負を切ると結論を隠すことになる。
 */
export function achievableHedgeGrid(
  V: number,
  indexLevel: number,
  product: FuturesProduct,
  hMax: number
): number[] {
  const per = notionalPerLot(indexLevel, product);
  if (!(per > 0) || !(V > 0) || !(hMax > 0)) return [0];
  const step = per / V;
  const n = Math.floor(hMax / step + 1e-9);
  const out: number[] = [];
  for (let k = -n; k <= n; k++) out.push(k * step);
  return out;
}

/** 実現可能な格子への最近傍スナップ（連続の h\* を「実際に建てられる h」に落とす）。 */
export function snapToLotGrid(
  h: number,
  V: number,
  indexLevel: number,
  product: FuturesProduct
): number {
  const per = notionalPerLot(indexLevel, product);
  if (!(per > 0) || !(V > 0)) return h;
  const step = per / V;
  return Math.round(h / step) * step;
}

/**
 * 売買手数料の年率換算（建玉 notional 比）。
 * 1年の維持で「限月ロール回数 × 往復2枚分」の手数料がかかるとみなす。
 *   rate = 2 × rollsPerYear × commissionPerLot / (指数 × multiplier)
 */
export function futuresCommissionAnnualRate(indexLevel: number, product: FuturesProduct): number {
  const spec = FUTURES_SPECS[product];
  const per = notionalPerLot(indexLevel, product);
  return per > 0 ? (2 * spec.rollsPerYear * spec.commissionPerLot) / per : 0;
}

/** SPAN証拠金の notional 比（建玉1円あたり何円の証拠金が要るか）。 */
export function spanMarginRate(indexLevel: number, product: FuturesProduct): number {
  const per = notionalPerLot(indexLevel, product);
  return per > 0 ? FUTURES_SPECS[product].spanMarginPerLot / per : 0;
}
