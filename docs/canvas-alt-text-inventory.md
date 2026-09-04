# Canvas 代替テキスト（A3）棚卸し表

作成日: 2026-09-04（S20 第1コミット）
親文書: `docs/site-improvement-execution-plan.md` §3 A3 / `docs/site-improvement-round5.md` §0.7① · FU38 · FU44

**本書は棚卸しだけである。実装は含まない。**
S18 は棚卸しを作らずに10件だけ実装したため、「A3 の残件を全件分類した」という
受け入れ条件そのものが検算不能になった（round5 §0.7①）。同じことを繰り返さないために、
実装より先に母数と分類をここに固定する。

---

## 1. 母数 — 数え方の説明から始める

FU44 が指摘したとおり、この母数は測るたびに動いており、**数え方によって値が変わる**。
2026-09-04 に本ブランチ（`082f3b4`）で測り直した値と、その差分が何なのかを先に示す。

### 1.1 実測値

| 数えたもの | 件数 | コマンド |
|---|---|---|
| `getContext("2d")` を持つ `.tsx` ファイル | **152** | `grep -rl 'getContext("2d")' app --include=*.tsx \| wc -l` |
| `getContext("2d")` の出現数 | **175** | `grep -ro 'getContext("2d")' app --include=*.tsx \| wc -l` |
| `<canvas` を持つ `.tsx` ファイル | **176** | `grep -rl '<canvas' app --include=*.tsx \| wc -l` |
| **`<canvas` の出現数** | **306** | `grep -ro '<canvas' app --include=*.tsx \| wc -l` |
| `<AccessibleCanvas` の出現数（= S18 で対応済みの図） | **15** | `grep -rho '<AccessibleCanvas' app --include=*.tsx \| wc -l` |
| `AccessibleCanvas` を import するファイル | **10**（+ ラッパ自身で grep 上は11） | `grep -rl 'AccessibleCanvas' app --include=*.tsx` |
| `createChart(` の出現数（lightweight-charts 側） | **142** | `grep -ro 'createChart(' app --include=*.tsx \| wc -l` |

プロンプトが渡した 152 / 175 / 176 / 10 / 142 は**すべて再現した**。

### 1.2 「ファイル数」と「出現数」がずれる理由

ファイル集合の差は 176 − 152 = 24 ではない。**両方向にずれている。**

| 集合 | 件数 | 中身 |
|---|---|---|
| `<canvas` と `getContext` の両方を持つ | **141** | 自分でタグを置き、自分で描く（多数派） |
| `<canvas` **だけ**を持つ | **35** | 34件は `intradayShared.tsx` の `initCanvas()` に描画を委譲している（`getContext` は呼ばない）。残り1件は `AccessibleCanvas.tsx`（ラッパのタグ本体） |
| `getContext` **だけ**を持つ | **11** | 10件は `AccessibleCanvas` 利用（`<canvas` タグはラッパ側にあるので自ファイルには無い）。残り1件は `initCanvas()` を**定義する** `intradayShared.tsx` |

141 + 11 = 152（`getContext` 側）、141 + 35 = 176（`<canvas` 側）。

> **つまり「`<canvas` を持つファイル 176」を A3 の母数にすると 2重に誤る。**
> ラッパ経由で対応済みの10件が母数から落ち、共通ヘルパ1件が二重に数えられる。

### 1.3 本書が採る母数は「ファイル」ではなく「canvas 要素」である

**1ファイルに最大11個の canvas がある**（`WeekdayBarrierChart.tsx` / `SpiralHeatmap.tsx`）。
代替テキストは canvas 1個につき1つ要るので、ファイル数では受け入れ条件を検算できない。

| | 件数 |
|---|---|
| 素の `<canvas`（= 代替テキストが無い図） | **306** |
| うち `AccessibleCanvas.tsx` 自身のタグ（15回レンダされる実体） | 1 |
| **対応対象の素の canvas** | **305** |
| S18 が対応済みの図（`<AccessibleCanvas` 呼び出し） | **15**（10ファイル） |
| 画面に出る canvas 描画箇所の総数 | **320** |

**この 305 / 15 / 320 という数字は、S18 のときにも第3波・第4波のレビューでも一度も出ていない。**
150・173・174・151 はすべて**ファイル数**であって、代替テキストの母数ではなかった。

### 1.4 canvas の分布（ファイル数ではなく個数で見る）

| 1ファイルあたりの canvas 数 | ファイル数 |
|---|---|
| 0（`AccessibleCanvas` 利用 10 + ヘルパ 1） | 11 |
| 1 | 109 |
| 2 | 40 |
| 3 | 14 |
| 4 | 5 |
| 5 | 4 |
| 6 | 1 |
| 7 | 1 |
| 11 | 2 |

---

## 2. 「図が唯一の情報源か」の判定基準

**先に基準を書く。** 表や数値が併記済みなら優先度は低い（プロンプトの指定）。

| 判定 | 条件 | 根拠 |
|---|---|---|
| **○ 併記なし** | そのコンポーネントに `<table` が1つも無い。図に描かれた値は **DOM のどこにもテキストとして存在しない** | スクリーンリーダー利用者はその分析から**何も**受け取れない。A3 の目的（「内容が一切伝わらない状態を改善する」）の中心 |
| **△ 一部併記** | `<table` がある。表が担う数値はテキストで読めるが、**図の主眼（形・位置・分布・関係）は表に無い** | 「一切伝わらない」ではないので優先度は下がる。ただし主図は形の情報を担うので対象に残す |
| **—** | ラッパ自身・描画ヘルパ・未配線 | canvas 要素として画面に出ないか、そもそも描かれない |

`<table` の有無を機械判定に使うのは、**「数値がテキストとして読めるか」の最も外れにくい代理指標**だからである。
`StatCell` 等の div ベースの数値表示も併記に当たるが、これは表の有無と強く相関し、
かつ「図の形」を代替しない点は同じなので、判定を分けていない。

### 2.1 今回の扱い（範囲の決定）

オーナー確認のうえ **方針 A** を採る:

- **○ 併記なし（`<table` 無し）のファイルは canvas を全数対応する**
- **△ 一部併記（`<table` 有り）のファイルは主図1個を対応する**。副次図は今回見送り、
  件数と理由を本表に残す

| 区分 | ファイル | 素の canvas | 今回入れる代替テキスト |
|---|---|---|---|
| S18 で対応済み | 10 | 0（`<AccessibleCanvas` 15個） | —（既存） |
| ○ 併記なし（`<table` 無し） | 95 | 135 | **135**（全数） |
| △ 一部併記（`<table` 有り） | 79 | 169 | **79**（主図のみ） |
| 対応不要 | 3 | 2 | 0 |
| **合計** | **187** | **306** | **214** |

**残件は 90 個**（△ の副次図 169 − 79）。理由は「同じパネル内の表に数値が併記されており、
**読み上げが一切届かない状態ではない**ため」。**残件0ではない。件数と理由を上に書いた。**

残件の内訳（ファイル別）は本表の「今回の扱い」列に1件ずつ書いてある。

### 2.2 実績（2026-09-04 の作業後に測り直した値）

| | 着手前 | 着手後 |
|---|---|---|
| `<AccessibleCanvas` の出現数（= 代替テキストのある図） | 15 | **260** |
| 素の `<canvas` の出現数 | 306 | **61** |
| うちラッパ自身と未配線（対応不要） | 2 | 2 |
| **代替テキストの無い図** | **304** | **59** |
| `createChart(` | 142 | **142**（不変） |
| `getContext("2d")` の出現数 / ファイル数 | 175 / 152 | **175 / 152**（不変） |

**入れた代替テキストは 245 図。** 対象184ファイルのうち **164ファイルは全図が済み**、
残る20ファイルは主図だけを入れて副次図 **59図** を見送った（すべて表併記あり）。

予定（214図）より多いのは、**view で排他表示される canvas を全枚対応に切り替えた**ため。
`MondayGapChart`(5) や `WeeklyAnalogOosChart`(4) のように、タブで1枚ずつ出る図は
表示中はどれも「唯一の情報源」になるので、主図1枚では足りないと判断した。

見送り59図の内訳（多い順）: `SpiralHeatmap` 10 / `WeekdayBarrierChart` 10 /
`WeeklyPhaseAttractorChart` 6 / `SectorFactorStabilityPanel` 5 / `ArimaChart` 4 /
`CrashSurgeStreakChart` 4 / `WeeklyAllocationChart` 3 / 以下 2図以下が13ファイル。

---

## 3. 棚卸し表（全 187 ファイル）

節の順は `panel-registry.tsx` の `SECTIONS` に合わせず、節キーの辞書順で並べている
（レビュー時に grep しやすいため）。`（節外）` は `/portfolio`・`/strategy` のみで使われるもの。

| コンポーネント | パネルID | 節 | 図が唯一の情報源か | S18 で対応済みか | 今回の扱い |
|---|---|---|---|---|---|
| `AsOfScorecardChart.tsx` | asof-scorecard | as-of | △ 一部併記（図 3） | — | **対応した**（全 3図） |
| `AccessibleCanvas.tsx` | basic-rolling-anim, ohlc-intra-path ほか計10 | 基本/OHLC/分布/周波数/非線形/エントロピー/条件付き | —（図 1） | — | 対応不要（S18 のラッパ自身。`description` を受けて `role="img"` を付ける側） |
| `GapAnalysisChart.tsx` | basic-gap | 基本 | △ 一部併記（図 3） | — | **対応した**（主図 1図）／残 2図は表併記のため見送り |
| `HoldingPeriodChart.tsx` | basic-holding | 基本 | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `RelativeStrengthExtChart.tsx` | basic-relstrength-ext | 基本 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `RollingAnimationChart.tsx` | basic-rolling-anim | 基本 | ○ 併記なし（図 1） | 済（10件の1つ） | **対応した**（全 1図） |
| `VolumeLeadChart.tsx` | basic-volume-lead | 基本 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `VolumeProfileChart.tsx` | basic-volume-profile | 基本 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `VolumeProfileExtChart.tsx` | basic-volume-profile-ext | 基本 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `VolumeReturnChart.tsx` | basic-volume-return | 基本 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `CandleSeasonalityChart.tsx` | cal-candle-season | カレンダー | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `EdgeDiscountChart.tsx` | cal-edge-discount | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `EventCalendarChart.tsx` | cal-event-calendar | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `ExecutionTimingChart.tsx` | cal-exec-timing | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `GapIntradayChart.tsx` | cal-gap-intra | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `HighLowTimingChart.tsx` | cal-highlow-timing | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `IntradayAnalogPathChart.tsx` | cal-intraday-analog | カレンダー | △ 一部併記（図 2） | — | **対応した**（全 2図） |
| `IntradayExcursionChart.tsx` | cal-intra-excursion | カレンダー | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `intradayPathShared.tsx` | cal-weekday-intra-path, cal-tom-path ほか計6 | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `IntradayProfileChart.tsx` | cal-intra-profile | カレンダー | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `IntradayRegimeChart.tsx` | cal-intra-regime | カレンダー | △ 一部併記（図 3） | — | **対応した**（全 3図） |
| `intradayShared.tsx` | cal-weekday-barrier, cal-weekclock ほか計35 | カレンダー | —（図 0） | — | 対応不要（`initCanvas()` を提供する描画ヘルパ。JSX の canvas を持たない） |
| `IntradayWindowChart.tsx` | cal-intra-window | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `MondayGapChart.tsx` | cal-monday-gap | カレンダー | △ 一部併記（図 5） | — | **対応した**（全 5図） |
| `NisaVsTaxableChart.tsx` | cal-nisa-vs-taxable | カレンダー | △ 一部併記（図 3） | — | **対応した**（全 3図） |
| `NullAnatomyChart.tsx` | cal-null-anatomy | カレンダー | △ 一部併記（図 2） | — | **対応した**（主図 1図）／残 1図は表併記のため見送り |
| `NullCalibrationChart.tsx` | cal-null-calib | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `OptimalExitChart.tsx` | cal-optimal-exit | カレンダー | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `RealizedVolChart.tsx` | cal-realized-vol | カレンダー | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `RegimeUsPathChart.tsx` | cal-regime-us-path | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `SectorBasketWeekdayChart.tsx` | cal-sector-basket | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `SessionGapChart.tsx` | cal-session-gap | カレンダー | △ 一部併記（図 2） | — | **対応した**（全 2図） |
| `SignalExecutionChart.tsx` | cal-signal-exec | カレンダー | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `SignalIntradayChart.tsx` | cal-signal-intra | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `SlicedExecutionChart.tsx` | cal-sliced-exec | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `SpiralHeatmap.tsx` | cal-spiral | カレンダー | △ 一部併記（図 11） | — | **対応した**（主図 1図）／残 10図は表併記のため見送り |
| `TodayBinChart.tsx` | cal-today-bin | カレンダー | △ 一部併記（図 3） | — | **対応した**（全 3図） |
| `TodayVsExpectedPathChart.tsx` | cal-today-vs-expected | カレンダー | △ 一部併記（図 4） | — | **対応した**（全 4図） |
| `TurnOfMonthPathChart.tsx` | cal-tom-path | カレンダー | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `UsAbsorptionChart.tsx` | cal-us-absorption | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `UsBetaChart.tsx` | cal-us-beta | カレンダー | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `UsBinEventStudyChart.tsx` | cal-us-bin-event | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `UsDigestionBoundaryChart.tsx` | cal-us-digestion | カレンダー | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `UsEventTimeChart.tsx` | cal-us-eventtime | カレンダー | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `UsHoldingPeriodChart.tsx` | cal-us-holding | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `UsJpLinkedPathChart.tsx` | cal-us-jp-linked | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `UsLeadLagChart.tsx` | cal-us-leadlag | カレンダー | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `UsPathChart.tsx` | cal-us-path | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `UsTimingEdgeChart.tsx` | cal-us-timing | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `UsVolSpilloverChart.tsx` | cal-us-vol | カレンダー | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `VwapDeviationChart.tsx` | cal-vwap-dev | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `WeekClockChart.tsx` | cal-weekclock | カレンダー | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `WeekdayBarrierChart.tsx` | cal-weekday-barrier | カレンダー | △ 一部併記（図 11） | — | **対応した**（主図 1図）／残 10図は表併記のため見送り |
| `WeekdayConditionalChart.tsx` | cal-weekday-cond | カレンダー | △ 一部併記（図 3） | — | **対応した**（全 3図） |
| `WeekdayEdgeScanChart.tsx` | cal-weekday-edge | カレンダー | △ 一部併記（図 4） | — | **対応した**（全 4図） |
| `WeekdayIntradayEdgeChart.tsx` | cal-weekday-intra-edge | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `WeekdayIntradayPathChart.tsx` | cal-weekday-intra-path | カレンダー | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `WeekdayTradeSimulator.tsx` | cal-weekday-sim | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `WeekdayUsInteractionChart.tsx` | cal-weekday-us-interaction | カレンダー | △ 一部併記（図 2） | — | **対応した**（主図 1図）／残 1図は表併記のため見送り |
| `WeekEmbeddingChart.tsx` | cal-week-embed | カレンダー | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `WeekendPremiumChart.tsx` | cal-weekend-premium | カレンダー | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `WeeklyAnalogChart.tsx` | cal-weekly-analog | カレンダー | △ 一部併記（図 2） | — | **対応した**（全 2図） |
| `WeeklyAnalogOosChart.tsx` | cal-weekly-analog-oos | カレンダー | △ 一部併記（図 4） | — | **対応した**（全 4図） |
| `CausalChart.tsx` | sa-causal | 因果 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `CCMChart.tsx` | causal-ccm | 因果 | △ 一部併記（図 3） | — | **対応した**（全 3図） |
| `EventStudyChart.tsx` | causal-event | 因果 | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `ConditionalSegmentEdgeChart.tsx` | cond-segment-edge | 条件付き | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `PersistenceChart.tsx` | cond-persistence | 条件付き | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `TwoFactorHeatmapChart.tsx` | cond-2factor | 条件付き | ○ 併記なし（図 1） | 済（10件の1つ） | **対応した**（全 1図） |
| `BlackScholesLabChart.tsx` | deriv-bs-lab | デリバティブ | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `DeltaHedgeSimChart.tsx` | deriv-delta-hedge | デリバティブ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `FuturesCarryChart.tsx` | deriv-futures-carry | デリバティブ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `RealizedVolVrpChart.tsx` | deriv-rv-vrp | デリバティブ | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `ACFChart.tsx` | dist-acf | 分布 | ○ 併記なし（図 3） | — | **対応した**（全 3図） |
| `ACFExtendedChart.tsx` | dist-acf-ext | 分布 | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `ConditionalViolinChart.tsx` | dist-violin | 分布 | △ 一部併記（図 3） | — | **対応した**（全 3図） |
| `CrossCorrelogramChart.tsx` | dist-crosscorr | 分布 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `DistributionShapeChart.tsx` | dist-shape | 分布 | ○ 併記なし（図 5） | — | **対応した**（全 5図） |
| `DistributionSurfaceChart.tsx` | dist-surface | 分布 | ○ 併記なし（図 1） | 済（10件の1つ） | **対応した**（全 1図） |
| `InfoRatioDashboard.tsx` | dist-inforatio | 分布 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `LagDependenceChart.tsx` | dist-lag | 分布 | ○ 併記なし（図 4） | — | **対応した**（全 4図） |
| `ReturnDistribution.tsx` | sa-distribution | 分布 | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `RollingMomentsChart.tsx` | dist-rolling-moments | 分布 | ○ 併記なし（図 3） | 済（10件の1つ） | **対応した**（全 3図） |
| `StylizedFactsChart.tsx` | dist-stylized | 分布 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `VarianceRatioChart.tsx` | dist-vr | 分布 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `EdgeBookChart.tsx` | edge-book | エッジ | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `EdgeCapacityChart.tsx` | edge-capacity | エッジ | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `InteractionScanChart.tsx` | edge-interaction | エッジ | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `SignalStackingChart.tsx` | edge-signal-stack | エッジ | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `ComplexityEntropyChart.tsx` | ent-complexity | エントロピー | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `ConditionalEntropyChart.tsx` | ent-conditional | エントロピー | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `EntropyHeatmapChart.tsx` | ent-heatmap | エントロピー | ○ 併記なし（図 3） | 済（10件の1つ） | **対応した**（全 3図） |
| `MultiscaleEntropyChart.tsx` | ent-multiscale | エントロピー | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `SymbolicInfoFlowChart.tsx` | ent-symbolic | エントロピー | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `DFAChart.tsx` | sa-fractal | フラクタル | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `FractalExtChart.tsx` | frac-ext | フラクタル | ○ 併記なし（図 3） | — | **対応した**（全 3図） |
| `RollingHurstChart.tsx` | frac-rolling-hurst | フラクタル | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `AnalyticSignalChart.tsx` | freq-analytic | 周波数 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `ComplexPlaneChart.tsx` | freq-complex | 周波数 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `HilbertHuangChart.tsx` | freq-hhs | 周波数 | ○ 併記なし（図 2） | 済（10件の1つ） | **対応した**（全 2図） |
| `PhaseClockChart.tsx` | freq-phaseclock | 周波数 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `SSAChart.tsx` | sa-frequency-ssa | 周波数 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `WaveletChart.tsx` | freq-wavelet | 周波数 | ○ 併記なし（図 1） | 済（10件の1つ） | **対応した**（全 1図） |
| `WaveletCoherenceChart.tsx` | sa-frequency-coherence | 周波数 | ○ 併記なし（図 1） | 済（10件の1つ） | **対応した**（全 1図） |
| `ZPlanePoleChart.tsx` | freq-zplane | 周波数 | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `HVGChart.tsx` | net-hvg | ネットワーク | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `OrdinalNetwork.tsx` | net-ordinal | ネットワーク | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `VisibilityGraphChart.tsx` | sa-network | ネットワーク | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `AttractorExplorer.tsx` | nl-attractor | 非線形 | ○ 併記なし（図 1） | 済（10件の1つ） | **対応した**（全 1図） |
| `EmbeddingOptimizer.tsx` | nl-embedding | 非線形 | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `KramersMoyalChart.tsx` | nl-km | 非線形 | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `LyapunovSpectrumChart.tsx` | nl-lyap-spectrum | 非線形 | △ 一部併記（図 2） | — | **対応した**（主図 1図）／残 1図は表併記のため見送り |
| `PeriodicPhaseAttractorChart.tsx` | nl-periodic-phase | 非線形 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `PotentialLandscapeChart.tsx` | nl-potential | 非線形 | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `RecurrencePlot.tsx` | nl-recurrence | 非線形 | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `SimplexPredictionChart.tsx` | nl-simplex | 非線形 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `TDAChart.tsx` | sa-nonlinear-tda | 非線形 | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `WeeklyPhaseAttractorChart.tsx` | nl-weekly-phase | 非線形 | △ 一部併記（図 7） | — | **対応した**（主図 1図）／残 6図は表併記のため見送り |
| `WeeklyPhaseSyncChart.tsx` | nl-phase-sync | 非線形 | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `ConditionalForwardChart.tsx` | ohlc-candle-run, cond-forward ほか計5 | OHLC/条件付き/カレンダー | △ 一部併記（図 3） | — | **対応した**（主図 1図）／残 2図は表併記のため見送り |
| `CrashSurgeStreakChart.tsx` | ohlc-crash-surge | OHLC | △ 一部併記（図 5） | — | **対応した**（主図 1図）／残 4図は表併記のため見送り |
| `GapScatterChart.tsx` | sa-ohlc-gap | OHLC | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `IntradayPathChart.tsx` | ohlc-intra-path | OHLC | ○ 併記なし（図 1） | 済（10件の1つ） | **対応した**（全 1図） |
| `MFEMAEChart.tsx` | ohlc-mfemae | OHLC | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `OHLCVolatilityChart.tsx` | ohlc-ohlc-vol | OHLC | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `TpSlOptimizerChart.tsx` | ohlc-tpsl | OHLC | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `TrueRangeDecompChart.tsx` | ohlc-true-range | OHLC | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `DensityMatrixChart.tsx` | quantum-density | 量子 | △ 一部併記（図 2） | — | **対応した**（主図 1図）／残 1図は表併記のため見送り |
| `MarketTimeChart.tsx` | quantum-markettime | 量子 | ○ 併記なし（図 3） | — | **対応した**（全 3図） |
| `PathIntegralChart.tsx` | quantum-pathintegral | 量子 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `PropagatorChart.tsx` | quantum-propagator | 量子 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `BOCPDChart.tsx` | regime-bocpd | レジーム | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `RegimeChart.tsx` | regime-main | レジーム | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `RegimeDistributionChart.tsx` | regime-distribution | レジーム | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `RegimeTechnicalChart.tsx` | regime-technical | レジーム | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `RegimeTransitionChart.tsx` | regime-transition | レジーム | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `CornishFisherChart.tsx` | risk-cornish | リスク | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `DrawdownDistChart.tsx` | risk-dd-dist | リスク | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `ForecastRangeChart.tsx` | risk-forecast-range | リスク | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `GarchVarChart.tsx` | risk-garch-var | リスク | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `VolSmileChart.tsx` | risk-volsmile | リスク | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `ArimaChart.tsx` | sa-sim-arima | シミュ | △ 一部併記（図 5） | — | **対応した**（主図 1図）／残 4図は表併記のため見送り |
| `BlockBootstrapChart.tsx` | sim-block-boot | シミュ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `CustomReturnChart.tsx` | sim-custom-return | シミュ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `FBMChart.tsx` | sim-fbm | シミュ | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `HistoricalAnalogChart.tsx` | sim-analog | シミュ | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `HoldingLedgerChart.tsx` | sim-holding-ledger | シミュ | △ 一部併記（図 2） | — | **対応した**（主図 1図）／残 1図は表併記のため見送り |
| `JumpDiffusionChart.tsx` | sim-jump | シミュ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `KellyChart.tsx` | sim-kelly | シミュ | △ 一部併記（図 2） | — | **対応した**（主図 1図）／残 1図は表併記のため見送り |
| `MeanReversionChart.tsx` | sa-sim-meanrev | シミュ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `MultivarSimplexChart.tsx` | sim-multivar-simplex | シミュ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `OptimalStoppingChart.tsx` | sim-optstop | シミュ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `PriceForecastChart.tsx` | sim-forecast | シミュ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `RegimeClusteringChart.tsx` | sim-regime-cluster | シミュ | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `RMultipleChart.tsx` | sim-rmultiple | シミュ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `SimpleBacktestChart.tsx` | sim-backtest | シミュ | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `VarianceGammaChart.tsx` | sim-vg | シミュ | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `VolTargetingChart.tsx` | sim-vol-target | シミュ | △ 一部併記（図 2） | — | **対応した**（主図 1図）／残 1図は表併記のため見送り |
| `CopulaChart.tsx` | tail-copula | テールリスク | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `HillEstimatorChart.tsx` | tail-hill | テールリスク | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `TailRiskChart.tsx` | tail-main | テールリスク | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `WeekdayDecompChart.tsx` | transform-weekday-decomp | 変換 | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `GarchChart.tsx` | vol-garch | ボラ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `HestonChart.tsx` | vol-heston | ボラ | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `RangeContractionChart.tsx` | vol-range-contract | ボラ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `RangeVolConeChart.tsx` | vol-range-cone | ボラ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `VolConeChart.tsx` | vol-cone | ボラ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `VolLeverageChart.tsx` | vol-leverage | ボラ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `VolTermStructureChart.tsx` | vol-term | ボラ | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `CapmSmlChart.tsx` | — | （節外） | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `CorrelationDragChart.tsx` | — | （節外） | △ 一部併記（図 3） | — | **対応した**（主図 1図）／残 2図は表併記のため見送り |
| `DriftIdentifiabilityChart.tsx` | — | （節外） | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `EfficientFrontierChart.tsx` | — | （節外） | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `EntryVsBenchmarkChart.tsx` | — | （節外） | △ 一部併記（図 2） | — | **対応した**（全 2図） |
| `ExceedanceCorrelationChart.tsx` | — | （節外） | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `ExitCrossChart.tsx` | — | （節外） | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `GrowthIntuitionPanel.tsx` | — | （節外） | △ 一部併記（図 3） | — | **対応した**（主図 1図）／残 2図は表併記のため見送り |
| `MuSigmaPersistenceChart.tsx` | — | （節外） | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `ParticipationCrossChart.tsx` | — | （節外） | △ 一部併記（図 1） | — | **対応した**（全 1図） |
| `ParticipationPremiumChart.tsx` | — | （節外） | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `ResampledFrontierChart.tsx` | — | （節外） | ○ 併記なし（図 1） | — | **対応した**（全 1図） |
| `SectorFactorSelectChart.tsx` | — | （節外） | △ 一部併記（図 2） | — | **対応した**（主図 1図）／残 1図は表併記のため見送り |
| `SectorFactorStabilityPanel.tsx` | — | （節外） | △ 一部併記（図 6） | — | **対応した**（主図 1図）／残 5図は表併記のため見送り |
| `SimexChart.tsx` | — | （節外） | —（図 1） | — | 対応不要（**どこからも import されていない未配線コンポーネント**。§5① に記録） |
| `StrategyCharts.tsx` | — | （節外） | ○ 併記なし（図 2） | — | **対応した**（全 2図） |
| `WeeklyAllocationChart.tsx` | — | （節外） | △ 一部併記（図 4） | — | **対応した**（主図 1図）／残 3図は表併記のため見送り |
| `YourPortfolioDragPanel.tsx` | — | （節外） | △ 一部併記（図 2） | — | **対応した**（主図 1図）／残 1図は表併記のため見送り |
---

## 4. 代替テキストの書き方（S18 の10件を手本にする）

**新しい仕組みを作らない。** `app/components/analysis/AccessibleCanvas.tsx` をそのまま使う。

- `description` は必須 prop。`role="img"` + `aria-label` を canvas 自身に付ける
- **説明文は `useMemo` で計算結果から生成する。** 固定文言を貼らない
- 入れるのは「この図が今この銘柄で何を示しているか」であって手法の説明ではない
  （手法は `AnalysisGuide` にある）。**全件に長文を書かせない**
- S15 のバッジ（`useAnalysisResultSummary`）と同じ内容を二重に読ませない（round5 §0.6③）
- データ不足でグラフが描けないときは、その旨を返す（S18 の10件が既にそうしている）

実例（`WaveletChart.tsx`・本番ビルドの実測）:

> ウェーブレットスカログラム。直近2026-08-28では252.0日周期のパワーが最大で、全期間最大の57%です。

---

## 5. 棚卸しで見つかったこと（実装の前に記録する）

**① `SimexChart.tsx`（266行）はどこからも import されていない。**
`grep -rn 'SimexChart' app` の結果が定義ファイル自身だけである。
`panel-registry.tsx` にも `/portfolio`・`/strategy` にも無い。
過去に「ノイズ補正」節として作られた分析の残骸と思われる。
**今回は削除も対応もしない**（専有ファイルの線の内側だが、削除は担当項目の外）。

**② `/portfolio`・`/strategy` にしか出ないコンポーネントが 18 ある。**
`CapmSmlChart` / `CorrelationDragChart` / `DriftIdentifiabilityChart` / `EfficientFrontierChart` /
`EntryVsBenchmarkChart` / `ExceedanceCorrelationChart` / `ExitCrossChart` / `GrowthIntuitionPanel` /
`MuSigmaPersistenceChart` / `ParticipationCrossChart` / `ParticipationPremiumChart` /
`ResampledFrontierChart` / `SectorFactorSelectChart` / `SectorFactorStabilityPanel` /
`SimexChart` / `StrategyCharts` / `WeeklyAllocationChart` / `YourPortfolioDragPanel`。
**パネルIDを持たないので `page-wiring.test.ts` の網の外にある**（FU27 と同じ形）。
A3 の対象からは外さない（`app/components/analysis/` にある分析コンポーネントである）。

**③ `intradayShared.tsx` の `initCanvas()` が 34 ファイルの描画を代行している。**
このため「`getContext` を持つファイル」を母数にすると 34 ファイルが抜ける。
`intradayPathShared.tsx` は自身が canvas を持ち、6パネルから共有されている
（1つの代替テキストが6パネルに効く）。

**④ 1ファイル 11 canvas が 2 件ある。**
`WeekdayBarrierChart.tsx`（cal-weekday-barrier）と `SpiralHeatmap.tsx`（cal-spiral）。
どちらも `<table` を持つので、方針 A では主図1個が対象、残り10個ずつが見送りになる。
**この 2 ファイルだけで見送り 90 個のうち 20 個を占める。**

---

## 6. 更新履歴

| 日付 | 内容 |
|---|---|
| 2026-09-04 | 初版（S20 第1コミット）。母数の数え方・判定基準・全187ファイルの分類。実装は含まない |
| 2026-09-04 | 実装後に §2.2 実績と表の「今回の扱い」列を実測で置き換えた。245図を追加し、残 59図。**FU36 の副産物**として、`DirectionGlyph` の呼び出し 184 + `DirectionValue` 36 = 220箇所を1件ずつ見直し、色の三項演算子 94箇所とローカル色ヘルパ11個を `directionClass` に寄せた（色と記号が同じ `directionOf` を通る） |
