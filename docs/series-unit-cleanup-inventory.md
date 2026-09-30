# 系列単位の後始末・棚卸し（S24 / FU56・FU50・FU52）

作成日: 2026-09-30  
分岐点: `972949c1baafdd7310fdbc4eff16e1bce5d16e65`  
親文書: `docs/site-improvement-execution-plan.md`  
直前の波: `docs/site-improvement-round5.md` §0.12

**この文書は実装を1行も含まない。** FU56 / FU50 / FU52 の分母と走査方法を、
実装前に固定するための棚卸しである。

## 0. 着手前の基準値と数え方

| 項目 | 着手前 |
|---|---|
| `npm test` | **219/219**（プロンプトの206件から、分岐点直前の `972949c` などで13件増えている） |
| `npm run lint` | **0エラー / 270警告**（`exhaustive-deps` 162・`no-unused-vars` 71・`no-unused-expressions` 37） |
| `npm run build` | 成功（Next.js 16.2.6、静的ページ148件） |
| `input: "filtered+series"` | **68パネル** |
| パネルID | **255件**、重複0、`data-quality` を含む |
| ID集合の SHA-256 | `a14f526465d4f681a6184cd9c6301f4c8ed908991d11e93c350bfba625741b2b`（ソートして LF 結合） |

ソース走査は NUL を含むファイルを落とさないよう、Node で全ファイルをバイト列または
UTF-8文字列として読んだ。FU52 は「`%` の直書き」だけでなく、ローカル整形関数経由、
`AccessibleCanvas` の `description`、Canvas の `fillText`、`lightweight-charts` に渡す値も
呼び出し先まで追った。1行に複数の値があっても1表示行と数える。

## 1. FU56 — NUL バイトの全一覧

`app/` 全体をバイト走査した結果は **5ファイル**だった。

| ファイル | NUL数 | 分類 | 扱い |
|---|---:|---|---|
| `app/components/analysis/WeekdayUsCrossChart.tsx` | 1 | UTF-8ソース | **FU56対象**。番兵1行だけを非NULへ置換する |
| `app/favicon.ico` | 14,051 | バイナリ画像 | 対象外。置換すると画像を破損する |
| `app/opengraph-image.jpg` | 1,653 | バイナリ画像 | 対象外。置換すると画像を破損する |
| `app/t/[ticker]/_fonts/NotoSansJP-400.subset.ttf` | 3,984 | バイナリフォント | 対象外。置換するとフォントを破損する |
| `app/t/[ticker]/_fonts/NotoSansJP-700.subset.ttf` | 3,970 | バイナリフォント | 対象外。置換するとフォントを破損する |

したがって、プロンプトの「`app/` に NUL バイトを含むファイルが0件」は実コードと両立しない。
受け入れ判定は **ソース／テキストでは0件、既存バイナリ4件は不変**とする。

## 2. FU50 — `needsTransform` を持つ14コンポーネント

比較対象は `extractRatioSeries()` の契約、すなわち (1) `close` / `open` だけを変換、
(2) `logReturns(values)`、(3) 時刻を使う場合は `times.slice(1)` である。

| # | コンポーネント | close/openだけ | `logReturns` | 時刻対応 | 判定・補足 |
|---:|---|---|---|---|---|
| 1 | `AnalyticSignalChart` | 一致 | 一致 | 一致 | 厳密一致 |
| 2 | `BOCPDChart` | 一致 | 一致 | 一致 | 厳密一致 |
| 3 | `CausalChart` | 一致 | 一致 | 未使用 | 値の契約は一致 |
| 4 | `ComplexPlaneChart` | 一致 | 一致 | 未使用 | `useMemo` 内だが値の契約は一致 |
| 5 | `EMDChart` | 一致 | 一致 | 一致 | 厳密一致 |
| 6 | `FractalExtChart` | 一致 | 一致 | 未使用 | 値の契約は一致 |
| 7 | `HilbertHuangChart` | 一致 | 一致 | 一致 | 厳密一致 |
| 8 | `HVGChart` | 一致 | 一致 | 一致 | 厳密一致 |
| 9 | `KramersMoyalChart` | 一致 | 一致 | 未使用 | 対になる水準を `values.slice(0, -1)` で別途整列する |
| 10 | `MultiscaleEntropyChart` | 一致 | 一致 | 一致 | 厳密一致 |
| 11 | `OrdinalNetwork` | 一致 | 一致 | 未使用 | 値の契約は一致 |
| 12 | `TransformCharts` | 一致 | 一致 | 一致 | effect内と統計欄の2複製とも一致 |
| 13 | `VisibilityGraphChart` | 一致 | 一致 | 一致 | 厳密一致 |
| 14 | `ZPlanePoleChart` | 一致 | 一致 | 未使用 | `useMemo` 内だが値の契約は一致 |

**結論:** 14/14件で値の変換は一致し、時刻を消費する8/8件も一致した。
既にずれていた複製は **0件**。`KramersMoyalChart` の `priceLevels` はリターンと対になる
説明変数の整列であり、`extractRatioSeries()` の戻り値とは別の意味を持つため維持する。

着手前の実機値（`npm start`、幅1400px、`7203.T`、10年）は次のとおり。
系列由来の可視テキストを持つ対象は **3/14件**だった。

| パネル | `mode=close` | `mode=logReturn` | FU50で一致を守る値 |
|---|---|---|---|
| `sa-transform` | 平均 0.0494% / σ 1.7111% | 平均 0.0494% / σ 1.7111% | 平均・σ |
| `freq-analytic` | 平均振幅 1.928% / σ 1.462% | 同左 | 2値 |
| `freq-emd` | IMF1〜5振幅 1.626 / 0.643 / 0.488 / 0.320 / 0.279% | 同左 | 5値 |

`sa-transform` の累積リターンとドローダウンは選択中の内部変換へ `extractSeries()` の出力を
もう一度入力する既存挙動で、close と logReturn では一致しない。FU50の3行置換の対象値ではない。

## 3. FU52 — `diff` の円値を `%` で描く分母

方針は推奨どおり **(a)** を採る。`diff` は1日あたりの価格差であり、比率へ変えると
`logReturn` との意味の区別を失うためである。`SERIES_MODE_UNITS` の `difference` を根拠に、
`diff` だけは倍率1・単位 `円`、それ以外の `extractRatioSeries` 出力は倍率100・単位 `%` とする。

68パネルを3経路で追った結果、実害は **14コンポーネント・46表示行**だった。

| コンポーネント（パネルID） | 可視 | 代替 | Canvas/チャート | 計 | 着手前の主な行 |
|---|---:|---:|---:|---:|---|
| `AnalyticSignalChart` (`freq-analytic`) | 2 | 0 | 0 | 2 | 246–247 |
| `EMDChart` (`freq-emd`) | 1 | 0 | 0 | 1 | 166 |
| `TransformCharts` (`sa-transform`) | 5 | 0 | 0 | 5 | 306, 310, 330, 336, 342 |
| `ReturnDistribution` (`sa-distribution`) | 2 | 1 | 0 | 3 | 28, 179, 183 |
| `DistributionShapeChart` (`dist-shape`) | 2 | 4 | 0 | 6 | 63, 69, 74, 86, 445, 449 |
| `RollingMomentsChart` (`dist-rolling-moments`) | 0 | 1 | 1 | 2 | 138–139, 164 |
| `ConditionalViolinChart` (`dist-violin`) | 2 | 2 | 2 | 6 | 111, 169, 179, 200, 243–244 |
| `DistributionSurfaceChart` (`dist-surface`) | 0 | 1 | 1 | 2 | 58, 113 |
| `GarchChart` (`vol-garch`) | 2 | 1 | 0 | 3 | 94, 242–243 |
| `LagDependenceChart` (`dist-lag`) | 0 | 1 | 1 | 2 | 66, 116 |
| `RegimeChart` (`regime-main`) | 2 | 0 | 0 | 2 | 263–264 |
| `StructuralBreakChart` (`sa-regime-break`) | 1 | 0 | 0 | 1 | 118 |
| `TailRiskChart` (`tail-main`) | 3 | 2 | 1 | 6 | 97–98, 146, 170, 175, 193 |
| `VolatilityChart` (`sa-volatility`) | 3 | 0 | 2 | 5 | 77, 91, 128, 140, 144 |
| **合計** | **25** | **13** | **8** | **46** | |

S22 の D3=42行より4行多い。追加で拾ったのは `%` をローカル `pctFmt()` 経由で出す
`DistributionShapeChart` の可視2行と、同じく `ConditionalViolinChart` の可視2行である。
また、Canvas/チャートは DOM テキスト走査だけでは見えないため別経路で数えた。

## 4. それ以外

| 発見 | 判断 |
|---|---|
| バイナリアセット4件にも NUL がある | FU56対象外。バイト列は不変にする |
| `PhaseClockChart` と `WeeklyPhaseAttractorChart` の `%` | `seriesMode` の系列を統計へ使わず `prices` から比率を計算するため正しい |
| 確率・比率・寄与率・CSS幅・固定しきい値の `%` | `diff` の単位に依存しないため維持する |
| `KramersMoyalChart` の `priceLevels` | 対になる水準を整列する固有入力。共通抽出へ置換しない |
| `sa-transform` の累積/DDが close と logReturn で異なる | FU50の抽出置換外の既存挙動。今回変更しない |
| 本番ブラウザの404 console error | 6回。対象パネルの計算・描画は完了し、page errorは0。最終確認でも再照合する |

