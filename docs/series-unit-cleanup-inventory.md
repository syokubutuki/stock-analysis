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

## 5. 実装後の再確認

### FU52 の確定分母の訂正

初回棚卸しの46行から、`TransformCharts` の累積リターン・最大DD・現在DDの3行を除外する。
それぞれ `Math.log(last / first)` と `(value - peak) / peak` であり、入力が `diff` でも
出力は無次元である。この3行は百分率表示を維持する。したがって確定対象は
**14コンポーネント・43表示行（可視22・代替13・Canvas/チャート8）**である。
同コンポーネントの対象は平均・標準偏差の2行となる。
S22の42行との差は、整形関数経由で拾った4行と、式の再追跡で除外した3行で説明できる。

`0331418A` の `sa-transform` では `logReturn` / `diff` の累積リターンが `NaN%` になる。
これは既存の内部変換が負の値の比の対数を取る別問題で、今回の抽出置換・単位修正では変更しない。

### FU56・互換性

- `needsTransform`: `rg -a -n needsTransform app` は0件。
- Nodeで `app/` を再度バイト走査: ソースのNULは0件。残るのは§1のバイナリ4件だけで、NUL数も不変。
- `CONSENSUS_KEY` は `"\u0001consensus"` に変更。通常の銘柄コードには現れない制御文字を先頭に置き、実データのキーとの非衝突性を維持した。変更は番兵の1行だけ。
- `WeekdayUsCrossChart.tsx` は1,460行。Windows環境に `grep` がないためNode・PowerShell・`rg`で通常のテキストとして走査できることを確認した（プロンプトの1,461行とは分岐点から異なる）。
- パネルIDは255件、集合SHA-256は§0と一致。レジストリ・価格修復・ページ配線の変更なし。

### ブラウザの確認範囲

`npm start` の本番ビルドをEdgeで開いた。通常幅1,400pxと狭幅390pxを使用。

| 観点 | 実施した確認 |
|---|---|
| 3銘柄×3モード | `7203.T`・`1306.T`・`0331418A` の `sa-transform` を close / logReturn / diff で開き、ロード完了と平均・σの単位を確認 |
| FU52全対象 | 株式と投信のdiffで14パネルを開き、可視値・代替説明の円表示を確認。株式の構造変化パネルは検出0件で値なし、投信では円の値を確認 |
| Canvas・狭幅 | 株式と投信の `dist-violin` をデスクトップ・390pxで撮影し目視。表・ヒストグラム注釈・バイオリン軸に円を確認。狭幅ではセル内折返しあり、パネル外への横はみ出しなし |
| 全セクション | 3銘柄それぞれ23タブを実際に押し、先頭パネルをDOMで確認。裁量トレードだけはworkspaceでパネルなし。全タブのスクリーンショット目視までは未実施 |
| 系列セレクタ | basic / technicalでは非表示、transform / distributionでは24px高。全節の対応関係はpage-wiringテストも通過。全節の高さの目視までは未実施 |
| 修復開示 | 1306.Tの修復バナー・基本節の自動展開・他節から修復リンクを押して基本節へ戻る操作を確認。2026-03-30〜31の配信値／修復値と年率σ 107.2%→18.2%を確認 |
| サマリー | 3銘柄で4カードの値を取得。投信のデスクトップ画像で桁・配置を目視。他2銘柄のカード配置の独立した画像目視は未実施 |
| 投信 | 10年の初回ロードが完了。夜間/日中・売買時刻・曜日別夜間/日中の3パネルは基準価額同一・出来高0の注意書きで停止。ローソク足系すべて・裁量workspace内部の確認は未実施 |
| エラー等 | FU52対象の全パネルで読み込みが終わり、対象走査のpage error／非404 console errorは0。API応答を保留／空配列／500へ置換し、取得中表示／分析未描画／エラー文表示を確認。全時系列チャートのズーム／パン・後始末の個別操作は未実施 |

時系列の代表として `freq-emd` のdiffでズーム・パン、1,400→390pxリサイズ、
閉じる→再表示を実施。狭幅パネルは358px、チャート再生成後もpage errorは0だった。

スクリーンショットは `%TEMP%/s24-{7203-T,0331418A}-diff-{desktop,narrow}.png` に保存。
再取得でEMDの値が動いたため、FU50の最終比較は同じ `/api/stock` 応答を固定して行う。

### FU50 の同一データ比較

分岐点 `972949c` と作業ブランチの本番ビルドをそれぞれ `npm start` で起動し、
同じ `/api/stock?ticker=7203.T&range=10y` 応答をブラウザへ渡した。
応答SHA-256: `3f072a5aefd8ff1a8aa0fd0f4f17e85e109928f31ac608a568c08a124438c59a`。
比較用worktreeはnode_modulesを共有したため、Turbopackの外部リンク制約により
分岐点のみ `npm run build -- --webpack` で生成した。作業ブランチは通常の `npm run build`。

| パネル | close: 分岐点 → 実装後 | logReturn: 分岐点 → 実装後 |
|---|---|---|
| `sa-transform` | 平均0.0500% / σ1.7113% → 同値 | 平均0.0500% / σ1.7113% → 同値 |
| `freq-analytic` | 平均振幅1.928% / σ1.462% → 同値 | 平均振幅1.928% / σ1.462% → 同値 |
| `freq-emd` | IMF1〜5振幅1.627 / 0.644 / 0.487 / 0.324 / 0.259% → 同値 | 同じ5値 → 同値 |

6画面ともパネル全文が一致した。§2の着手前観測との数値差は配信データ更新によるもので、
固定応答の前後比較では差が0である。

### 自動検証とlintの行単位差分

- `npm test`: **221/221、62 suites、失敗0**。既存219件の黄金値は変更せず、共通の表示関数についてdiffの倍率1・円と他5モードの倍率100・%の2件を追加。
- `npm run build`: 成功、TypeScript検査完了、静的ページ148件。
- `npm run lint`: **0エラー / 268警告**。着手前270件との差は以下の4行のみ。

| 変更 | ファイル・行（着手前→実装後） | 理由 |
|---|---|---|
| 削除 | `ComplexPlaneChart:45` | `needsTransform` / `values` の依存不足。複製memoを共通抽出memoへ置換して解消 |
| 削除 | `ZPlanePoleChart:27` | 同じ複製memoを除去したため依存不足警告が消滅 |
| 置換前 | `TransformCharts:201` | `closes` / `needsTransform` / `times` の依存不足 |
| 置換後 | `TransformCharts:203` | 同じeffectで `closes` / `lr` / `lrTimes` / `times` を参照するため、既存警告の変数名が置換された |

警告をファイル・メッセージ・ルールで一対一対応させ、残り267件の内容は同一と確認した。
このうち行位置だけが動いたものを全件列挙する（左が着手前、右が実装後）。

| ファイル | 行位置の移動 |
|---|---|
| BOCPDChart | 35→31 |
| CausalChart | 36→34, 37→35, 38→36, 39→37 |
| ConditionalViolinChart | 190→193, 191→194, 192→195 |
| DistributionShapeChart | 45→49, 46→50, 47→51, 48→52, 49→53, 50→54, 51→55, 53→57, 115→119, 124→128, 247→251, 257→261, 267→271 |
| DistributionSurfaceChart | 46→50 |
| FractalExtChart | 34→32, 35→33, 36→34 |
| GarchChart | 33→37, 34→38, 35→39, 88→92, 203→207 |
| HVGChart | 32→28, 67→63 |
| HilbertHuangChart | 46→42, 47→43, 50→46, 123→119 |
| KramersMoyalChart | 24→27 |
| LagDependenceChart | 51→55, 53→57, 54→58, 55→59, 56→60, 200→204 |
| MultiscaleEntropyChart | 36→30, 37→31, 42→36, 43→37 |
| OrdinalNetwork | 32→29 |
| RegimeChart | 39→43, 40→44, 41→45, 81→85, 187→191, 251→255 |
| ReturnDistribution | 20→24, 21→25, 22→26 |
| RollingMomentsChart | 89→95, 103→109 |
| StructuralBreakChart | 29→33 |
| TailRiskChart | 24→28, 27→31, 28→32, 29→33 |
| VisibilityGraphChart | 34→30 |
| VolatilityChart | 40→45, 46→51, 107→113 |

すべて共通抽出への置換・表示関数のimport追加・表示行変更に伴う移動である。
ルール別では `exhaustive-deps` 162→160、`no-unused-vars` 71→71、`no-unused-expressions` 37→37。
ログは `%TEMP%/stock-analysis-s24-{baseline,final}/lint.txt` に保存した。
