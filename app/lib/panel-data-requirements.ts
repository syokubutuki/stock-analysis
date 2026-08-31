// 「終値だけが配信される系列」（投信の基準価額など）で、各パネルの結果が
// 解釈できるかどうかの分類。M3（レジストリ化）の最小断片で、`panel-sections.ts` の隣人。
//
// なぜ要るか
// ----------
// 投信は **全バーで open==high==low==close かつ volume==0** である（元データの性質で
// あってバグではない）。この系列を出来高系・日中系のパネルに通すと、例外も警告も出ず、
// 計算も通り、**意味のない数字が意味ありげに表示される**。
//
// 判定は銘柄種別ではなくデータの性質で行う（`page.tsx` の `hasCloseOnlyMarketData`）。
// 銘柄種別で切ると、同じ性質を持つ別の配信元が増えたときに取りこぼす。
//
// なぜ3つ目の SAFE があるか
// -------------------------
// 元の実装は UNAVAILABLE / CAUTION の2つだけを持ち、**載っていないIDは黙って通常表示**
// だった（fail-open）。新しいパネルを足して分類を忘れても壊れないので気づけない。
// SAFE を置いて「page.tsx の全IDがちょうど1つに属する」ことを
// `__tests__/page-wiring.test.ts` が検査することで、**分類の忘れをテストで落とす**。
//
// **SAFE は「終値だけで成立することを検証した」という意味ではない。**
// 2026-08-17 時点で UNAVAILABLE/CAUTION のどちらにも入っていなかったものを、
// 挙動を変えずにそのまま写しただけである。価値は既存分類の正しさではなく、
// **これ以降に足したパネルが黙って SAFE に紛れ込めない**点にある。
//
// 移設時に見つかった誤分類（2026-08-26 に UNAVAILABLE へ修正）
// ---------------------------------------------------------
// 高値・安値を必要とするため、終値だけの系列では別の量に縮退する:
//   - `tech-adx`     ADX は True Range 由来。H=L=C だと方向性指数が縮退する
//   - `tech-breakout` ドンチャン・前日高安。高安が終値と同じでは意味が変わる
//   - `vol-atr`      ATR / ケルトナー。TR がギャップ項を失い |ΔC| になる
//   - `tech-stoch`   最高値/最安値が終値になるので、実質 close ベースの %K になる
// 投信 0331418A で tech-adx が ADX 13.64 ともっともらしい誤解釈を表示したため、
// 注意書きを添えて結果を残す CAUTION ではなく、4件とも結果を隠す UNAVAILABLE とする。
//
// `discretionary` 節は分類漏れではない。複数の入力・検証工程とシナリオ保存を一体で扱う
// 常時表示ワークスペースで、単一の折りたたみ分析ではないためパネルIDを付けない。
// S19 のレジストリ化では、擬似パネルIDを作らず「AccordionSection 外の節エントリ」を
// 表せる種別として登録すること。共有URLと結果バッジの対象外である点も明示的に保つ。

/** 出来高・OHLC内訳・日中/夜間そのものが対象で、終値だけでは結果が意味を持たないパネル。 */
export const CLOSE_ONLY_UNAVAILABLE_PANEL_IDS = new Set([
  "basic-volume",
  "basic-rvol",
  "basic-vol-indicators",
  "basic-signed-volume",
  "basic-volume-profile",
  "basic-volume-profile-ext",
  "basic-volume-return",
  "basic-volume-lead",
  "basic-gap",
  "tech-obvvwap",
  "tech-vw",
  "sa-ohlc",
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
  "risk-forecast-range",
  "risk-spread",
  "transform-overnight",
  "transform-exec-scan",
  "transform-weekday-decomp",
  "dist-crosscorr",
  "vol-range-cone",
  "vol-range-contract",
  "sa-frequency-coherence",
  "cond-segment-edge",
  "edge-capacity",
  "cal-weekday-barrier",
  "cal-candle-season",
  "cal-monday-gap",
  "cal-weekend-premium",
  "cal-weekday-intra-path",
  "cal-tom-path",
  "cal-weekday-us-path",
  "cal-today-vs-expected",
  "cal-intraday-analog",
  "cal-us-jp-linked",
  "cal-regime-us-path",
  "cal-weekday-intra-edge",
  "cal-sector-basket",
  "cal-highlow-timing",
  "cal-exec-timing",
  "cal-edge-discount",
  "cal-sliced-exec",
  "cal-intra-window",
  "cal-intra-profile",
  "cal-vwap-dev",
  "cal-intra-regime",
  "cal-intra-excursion",
  "cal-realized-vol",
  "cal-gap-intra",
  "cal-signal-intra",
  "cal-signal-exec",
  "cal-us-driver",
  "cal-us-beta",
  "cal-us-path",
  "cal-us-absorption",
  "cal-us-leadlag",
  "cal-us-vol",
  "cal-us-timing",
  "cal-us-holding",
  "cal-us-digestion",
  "cal-us-eventtime",
  "tech-adx",
  "tech-breakout",
  "vol-atr",
  "tech-stoch",
]);

/**
 * 終値ベースの結果は有効だが、同じパネル内に出来高・日中/夜間など解釈不能な
 * サブ分析を含むパネル。分析本体は残し、冒頭で参照範囲を明示する。
 */
export const CLOSE_ONLY_CAUTION_PANEL_IDS = new Set([
  "dist-lag",
  "dist-inforatio",
  "ent-conditional",
  "ent-multiscale",
  "ent-rolling-te",
  "ent-symbolic",
  "frac-ext",
  "sa-causal",
  "causal-ccm",
  "tail-main",
  "cal-null-anatomy",
  "cal-weekday-us-interaction",
  "cal-weekday-edge",
  "cal-weekday-sim",
  "cal-timing-value",
  "cal-weekday-vs-bh",
  "cal-optimal-exit",
  "cal-nisa-vs-taxable",
  "cal-weekclock",
  "cal-session-gap",
  "cal-weekly-analog",
  "cal-weekday-cond",
  "sim-holding-ledger",
  "sim-regime-cluster",
  "quantum-markettime",
]);

/**
 * 終値だけで結果が成立するパネル。**上2つに入っていないもの全部**であり、
 * 個別に検証した集合ではない（冒頭の注記を読むこと）。
 * ここに直接足すのではなく、新しいパネルは3つのうち妥当なものへ分類する。
 */
export const CLOSE_ONLY_SAFE_PANEL_IDS = new Set([
  // basic
  "basic-structure-score",
  "basic-consolidated-score",
  "basic-rolling-anim",
  "basic-benchmark",
  "basic-relstrength",
  "basic-relstrength-ext",
  "basic-dcc",
  "basic-diff",
  "basic-holding",
  "basic-mtf",
  "basic-behavioral",
  "basic-bias-coach",
  // technical
  "sa-technical",
  "tech-extra",
  // ohlc
  "ohlc-crash-surge",
  // risk
  "sa-risk",
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
  // derivatives
  "deriv-bs-lab",
  "deriv-delta-hedge",
  "deriv-rv-vrp",
  "deriv-futures-carry",
  // transform
  "sa-transform",
  // distribution
  "sa-distribution",
  "dist-shape",
  "dist-rolling-moments",
  "dist-violin",
  "dist-surface",
  "dist-stylized",
  "dist-acf",
  "dist-acf-ext",
  "dist-independence",
  "dist-pred-accuracy",
  "dist-unitroot",
  "dist-vr",
  "dist-rolling-vr",
  // volatility
  "sa-volatility",
  "vol-garch",
  "vol-agarch",
  "vol-heston",
  "vol-har",
  "vol-term",
  "vol-cone",
  "vol-leverage",
  // frequency
  "freq-power",
  "freq-wavelet",
  "freq-lombscargle",
  "sa-frequency-ssa",
  "freq-emd",
  "freq-analytic",
  "freq-complex",
  "freq-zplane",
  "freq-phaseclock",
  "freq-hhs",
  // nonlinear
  "sa-nonlinear",
  "nl-embedding",
  "nl-attractor",
  "nl-weekly-phase",
  "nl-periodic-phase",
  "nl-phase-sync",
  "nl-rqa",
  "nl-local-lyap",
  "nl-lyap-spectrum",
  "nl-simplex",
  "nl-recurrence",
  "nl-km",
  "nl-potential",
  "sa-nonlinear-tda",
  "nl-rolling-tda",
  // entropy
  "sa-entropy",
  "ent-extended",
  "ent-heatmap",
  "ent-complexity",
  "ent-storage",
  "ent-regime",
  // fractal
  "sa-fractal",
  "frac-rolling-hurst",
  // network
  "sa-network",
  "net-hvg",
  "net-ordinal",
  "net-recurrence",
  // regime
  "sa-regime",
  "regime-main",
  "regime-technical",
  "regime-distribution",
  "regime-transition",
  "sa-regime-break",
  "regime-bocpd",
  // causal
  "causal-event",
  // tailrisk
  "tail-copula",
  "tail-hill",
  // conditional
  "cond-forward",
  "cond-custom-bucket",
  "cond-return-bin",
  "cond-marker",
  "cond-trend-momentum",
  "cond-reversal",
  "cond-2factor",
  "cond-state-pred",
  "cond-persistence",
  // edge
  "edge-interaction",
  "edge-regime-map",
  "edge-walkforward",
  "edge-signal-stack",
  "edge-power",
  "edge-book",
  "edge-decay",
  "edge-ledger",
  "edge-test-registry",
  // asof
  "asof-snapshot",
  "asof-analog",
  "asof-scorecard",
  // calendar
  "cal-null-calib",
  "cal-spiral",
  "cal-event-effect",
  "cal-event-calendar",
  "cal-today-bin",
  "cal-weekly-analog-oos",
  "cal-week-embed",
  "cal-us-bin-event",
  // simulation
  "sim-custom-return",
  "sim-analog",
  "sim-multivar-simplex",
  "sim-forecast",
  "sim-backtest",
  "sim-vol-target",
  "sa-sim-meanrev",
  "sa-sim-arima",
  "sim-stop-compare",
  "sim-rmultiple",
  "sim-block-boot",
  "sim-kelly",
  "sim-jump",
  "sim-optstop",
  "sim-vg",
  "sim-fbm",
  // quantum
  "quantum-propagator",
  "quantum-pathintegral",
  "quantum-dmd",
  "quantum-decoherence",
  "quantum-density",
]);

/**
 * パネルIDを3分類のいずれかに解決する。`page.tsx` に無いIDは `null`。
 *
 * 画面はこの関数ではなく `AnalysisAvailabilityProvider` に Set をそのまま渡している。
 * これはテストと、将来 M3 のレジストリへ吸収するときの入口。
 */
export function classifyPanelForCloseOnly(
  panelId: string,
): "unavailable" | "caution" | "safe" | null {
  if (CLOSE_ONLY_UNAVAILABLE_PANEL_IDS.has(panelId)) return "unavailable";
  if (CLOSE_ONLY_CAUTION_PANEL_IDS.has(panelId)) return "caution";
  if (CLOSE_ONLY_SAFE_PANEL_IDS.has(panelId)) return "safe";
  return null;
}
