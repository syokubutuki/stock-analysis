// 無料枠として公開しているパネルIDの**黄金値**（FU43）。
//
// なぜ件数ではなく全件を並べるのか
// --------------------------------
// `app/lib/tiers.ts` の課金境界は、カテゴリ接頭辞（`FREE_CATEGORIES` /
// `FREE_SERIES_SEGMENTS`）と個別の引き上げ（`FREE_PANEL_IDS`）の合成である。
// つまり **1つのパネルIDを改名するだけで、そのパネルの無料/有料が入れ替わりうる。**
// 入れ替わっても例外は出ず、`PAYWALL_ENABLED = false` の現在は画面も変わらない。
//
// 件数だけを固定すると「1件が無料→有料、別の1件が有料→無料」の入れ替わりを
// 見逃す。§6.4 が禁じているのは**すでに無料のものを有料側へ移すこと**なので、
// 見るべきは総数ではなく集合である。ゆえに全件を並べる。
//
// 2026-09-05 実測: 全252パネル中 86件が無料（`isPanelFree()` が true）。
// 並び順は `PANELS`（= レジストリの節・グループ順）のままである。
//
// **落ちたときにこの配列を書き換えないこと。**
// まず「無料だったものが有料側へ移っていないか」を確かめる。移っていれば §6.4 違反で、
// 直すのはこちらではなくレジストリ側のIDか `tiers.ts` である。
// 意図してパネルを増減・改名したときだけ、同じ位置で更新する。
export const FREE_PANEL_IDS_GOLDEN: readonly string[] = [
  "basic-structure-score",
  "basic-consolidated-score",
  "basic-rolling-anim",
  "basic-benchmark",
  "basic-relstrength",
  "basic-relstrength-ext",
  "basic-dcc",
  "basic-volume",
  "basic-rvol",
  "basic-vol-indicators",
  "basic-signed-volume",
  "basic-volume-profile",
  "basic-volume-profile-ext",
  "basic-volume-return",
  "basic-volume-lead",
  "basic-diff",
  "basic-gap",
  "basic-holding",
  "basic-mtf",
  "basic-behavioral",
  "basic-bias-coach",
  "sa-technical",
  "tech-adx",
  "tech-stoch",
  "tech-obvvwap",
  "tech-vw",
  "tech-extra",
  "tech-breakout",
  "sa-ohlc",
  "ohlc-crash-surge",
  "ohlc-pattern",
  "ohlc-pattern-edge",
  "ohlc-candle-run",
  "ohlc-wick",
  "ohlc-intra-path",
  "ohlc-close-position",
  "ohlc-true-range",
  "ohlc-mfemae",
  "ohlc-tpsl",
  "sa-ohlc-gap",
  "ohlc-gap-class",
  "sa-ohlc-range",
  "ohlc-range-vol",
  "ohlc-ohlc-vol",
  "sa-ohlc-micro",
  "sa-risk",
  "risk-forecast-range",
  "risk-drawdown",
  "risk-dd-dist",
  "risk-garch-var",
  "risk-cornish",
  "risk-rolling-var",
  "risk-volsmile",
  "risk-finance-theory",
  "risk-ratios",
  "risk-downside",
  "risk-cond-beta",
  "risk-spread",
  "sa-transform",
  "transform-overnight",
  "transform-exec-scan",
  "transform-weekday-decomp",
  "sa-distribution",
  "dist-shape",
  "dist-rolling-moments",
  "dist-violin",
  "dist-surface",
  "dist-stylized",
  "dist-acf",
  "dist-acf-ext",
  "dist-lag",
  "dist-crosscorr",
  "dist-independence",
  "dist-pred-accuracy",
  "dist-inforatio",
  "dist-unitroot",
  "dist-vr",
  "dist-rolling-vr",
  "edge-walkforward",
  "edge-power",
  "edge-decay",
  "edge-ledger",
  "edge-test-registry",
  "cal-null-calib",
  "cal-null-anatomy",
  "cal-weekly-analog-oos",
];
