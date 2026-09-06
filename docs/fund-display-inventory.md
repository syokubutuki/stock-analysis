# 投信 `0331418A` の表示棚卸し（S22 / 第7波・FU32 / FU47 / FU15）

作成日: 2026-09-06
親文書: `docs/site-improvement-execution-plan.md`（制約・受け入れ条件はそちらが正）
直前の波: `docs/site-improvement-round5.md` §0.10

**この文書は実装を1行も含まない。** §0.7① / §0.9② の教訓により、
「N件直した」の N を出す前に、その N の分母と数え方を先に固定するために作った。

---

## 0. 測り方（先に書く。あとから条件を都合よく読み替えないため）

| | 内容 |
|---|---|
| 銘柄 | `0331418A`（eMAXIS Slim全世界株式（オール･カントリー））・**1913点**・2018-10-31〜2026-09-04 |
| ビルド | `npm run build` → `npx next start -p 3122`（**本番ビルド**。dev ではない） |
| 期間 | `period=10y` |
| 系列モード | `mode=close`（**URLに mode を書かずに開くと `close` が入る＝これが既定である**） |
| 開き方 | 全253パネルの `sa:open:<id>` に `1` を書いてから節ごとにリロード |
| 走査 | 各 `section[id^="panel-"]` の ①`innerText`（可視テキスト）と ②配下の全 `[aria-label]`（A3の代替テキスト）の両方 |

### 走査の網が落とすもの（自分で引いた）

§0.9③「素の grep では数えられない対象が増えてきた」に従い、**この網が届かない範囲を先に書く**。

| 落とすもの | なぜ | どう埋めたか |
|---|---|---|
| `ctx.fillText()` で **canvas に直接描いた数値** | DOM にも aria にも出ない | ソース側の走査（§2.2）で拾い、疑わしいものは画面で個別に確認した |
| `mode=close` 以外の系列モード | 既定は `close` なので既定画面の実測を優先した | `diff` / `logReturn` は今回の対象外。§5 に残件として記す |
| **1000% 未満に見える異常値** | 閾値「絶対値 1000% 以上」で拾っているため | 基準価額が 10,000〜37,945 円なので、水準が 100 倍されて `%` になると必ず 10^6 台になる。この銘柄では閾値による取りこぼしは起きない。**ただし他の銘柄では起きうる** |
| 折りたたみタブの内側にある表 | 既定タブしか描かれない | 該当する `nl-weekly-phase` はソース側で確認した（§2.3・影響なし） |
| `discretionary` 節 | `render: "workspace"` でクリック操作が要る | 既定表示の範囲だけ見た（canvas 10・aria 2・異常値0） |

### 「すべて開く」は使えなかった（次の波への申し送り）

当初は「すべて開く」ボタンを押して走査したが、**押した直後の読み取りは
`読み込み中...`（`next/dynamic` のチャンク待ち）を掴んでしまい、
「異常なし」という誤った結果を返す。** タブ切り替えだけで節を移ると
チャンクが読み込まれないまま止まる節もあった（risk / derivatives で再現）。

最終的に **`sa:open:<id>` を直接 1 にして節ごとにフルリロードする**方法に切り替え、
毎回 `読み込み中` の残数が 0 であることを確認してから走査した。
**この文書の数値はすべて後者の方法によるものである。**

---

## 1. 節ごとの実測（23節・全パネル）

`読み込み中` の残数が全節 0 であることを確認済み（＝チャンク待ちを異常なしと誤読していない）。

| 節 | パネル | 描画された | 非対応（FU17） | **おかしな表示** |
|---|---|---|---|---|
| basic 基本分析 | 22 | 14 | 9 | 0 ※ヒーローチャートは §3 |
| technical テクニカル | 7 | 1 | 5 | 0 |
| ohlc OHLC分析 | 17 | 2 | 16 | 0 |
| risk リスク指標 | 13 | 10 | 2 | 0 |
| derivatives デリバティブ | 4 | 4 | 0 | 0 |
| transform スケール変換 | 4 | 2 | 3 | 0 |
| **distribution 分布・相関** | 16 | 13 | 1 | **6** |
| **volatility ボラティリティ** | 11 | 7 | 3 | **3** |
| frequency 周波数領域 | 11 | 10 | 1 | 0 |
| nonlinear 非線形動力学 | 15 | 15 | 0 | 0 |
| entropy 情報理論 | 10 | 9 | 0 | 0 |
| fractal フラクタル | 3 | 3 | 0 | 0 |
| network ネットワーク | 4 | 4 | 0 | 0 |
| conditional 条件付き分析 | 10 | 10 | 1 | 0 |
| edge エッジ探索 | 10 | 9 | 1 | 0 |
| asof as-of検証 | 3 | 3 | 0 | 0 |
| **regime レジーム分析** | 7 | 6 | 0 | **2** |
| causal 因果・情報 | 3 | 3 | 0 | 0 |
| **tailrisk テイルリスク** | 3 | 3 | 0 | **1** |
| calendar カレンダー | 56 | 32 | 36 | 0 |
| **simulation シミュレーション** | 18 | 18 | 0 | **1** |
| discretionary 裁量トレード | — | workspace | — | 0 |
| quantum 量子力学的 | 6 | 5 | 0 | 0 |

**おかしな表示が出たパネル: 13件**（FU47 が 11・それ以外が 2）。
これに **パネルIDを持たないヒーローチャート（FU32）** を足して **14件**が今回の母数である。

---

## 2. FU47 — 水準がリターン用の百分率書式に流れる

### 2.1 画面に出ている文字列（11件）

全件 `mode=close`（既定）。基準価額 10,000〜37,945 円が 100 倍されて `%` を付けられている。

| # | 節 | パネルID | コンポーネント | 出ている場所 | 出ている文字列 |
|---|---|---|---|---|---|
| 1 | distribution | `sa-distribution` | `ReturnDistribution` | 可視＋代替 | 平均 **1931819.3936%**・標準偏差 **801073.0393%** |
| 2 | distribution | `dist-shape` | `DistributionShapeChart` | 可視＋代替 | 条件付き期待値 **3303528.086%**・最大 **3901900.00%** / 位置は **1735600.00%** 付近 / ピークは **1625178.50%** 付近 / 標準偏差は **801073.039%** |
| 3 | distribution | `dist-rolling-moments` | `RollingMomentsChart` | **代替のみ** | 「60日ローリング標準偏差。直近2026-09-04は **47024.15%** です。」 |
| 4 | distribution | `dist-violin` | `ConditionalViolinChart` | 可視＋代替 | 中央値が最も高いのは… **1035769.2105%** / 平均 **3304683.282%** |
| 5 | distribution | `dist-surface` | `DistributionSurfaceChart` | **代替のみ** | 「リターン **3863253.75%** 付近で密度が最大です。」 |
| 6 | distribution | `dist-lag` | `LagDependenceChart` | **代替のみ**（canvas 内にも同値） | 「値域 **810200.00%**〜**3901900.00%**」「最も濃いセルは約(**1711945.83%**, **1711945.83%**)」 |
| 7 | volatility | `sa-volatility` | `VolatilityChart` | 可視 | 現在ボラ **60918018.3%** / 低位 **23655548.3%** / 高位 **34037938.4%** |
| 8 | volatility | `vol-garch` | `GarchChart` | 可視＋代替 | 「下落後の平均ボラ 0.00% に対し上昇後は **1932306.75%**」 |
| 9 | regime | `regime-main` | `RegimeChart` | 可視 | μ **1079221.554%** / σ **90103.783%**（状態ごと） |
| 10 | regime | `sa-regime-break` | `StructuralBreakChart` | 可視 | 平均の変化 **56346.667%** / **-248263.333%** |
| 11 | tailrisk | `tail-main` | `TailRiskChart` | 可視＋代替 | VaR95 **-1006672.04%** / VaR99 **-955963.82%** / 平均 **1931819.3936%** |

**代替テキストにしか出ていないものが3件（#3 / #5 / #6）ある。**
§0.9② のとおり画面を目で見るだけでは見つからない。可視テキストの走査だけで数えると
分母が 11 → 8 に縮む。

### 2.2 分母 — `%` を付けている箇所は何件か

「`%` を付けている箇所」を **ソース行**で数える（1行に複数の値がある箇所は1件と数える）。

| 数え方 | 件数 | 定義 |
|---|---|---|
| D1: `seriesMode` を受け取るパネル | **68** | `panel-registry.tsx` の `input: "filtered+series"` |
| D1': うち `extractSeries()` を直接呼ぶファイル | 63 | 残り5件（`CCMChart` / `CopulaChart` / `PeriodicPhaseAttractorChart` / `WaveletCoherenceChart` / `WeeklyPhaseAttractorChart`）は lib 側で系列を作る。**D1' ⊂ D1** |
| D2: D1 の中で `%` を出力しているソース行 | **102** | 数値の直後に `%` が続く行。33ファイル |
| D3: D2 のうち **値が系列と同じ単位**の行（＝水準が流れうる） | **42** | 平均・標準偏差・分位・振幅・VaR・ドリフト等 |
| D3': D2 のうち比率・確率・寄与率・CSS幅・固定文言（＝モードに依らず正しい） | 60 | 再帰率・決定性・FNN率・頻度・勝率・寄与率・`width` 指定など |
| **D4: D3 のうち実際に壊れている行** | **28** | 下表 |
| D5: D3 のうち**すでに正しい**行 | 14 | 下表 |

### 2.3 なぜ 42 のうち 14 は壊れていないのか — 既存の作法が2種類ある

**このリポジトリには既に「水準なら対数リターンへ直す」作法が実装されている。**
`series-mode.ts` が単位を持っていないので、**各コンポーネントに手で複製されている。**

```ts
const needsTransform = seriesMode === "close" || seriesMode === "open";
const lr = needsTransform ? logReturns(values) : values;
const lrTimes = needsTransform ? times.slice(1) : times;
```

この3行を持つコンポーネントは **14件**（`AnalyticSignalChart` / `BOCPDChart` / `CausalChart` /
`ComplexPlaneChart` / `EMDChart` / `FractalExtChart` / `HVGChart` / `HilbertHuangChart` /
`KramersMoyalChart` / `MultiscaleEntropyChart` / `OrdinalNetwork` / `TransformCharts` /
`VisibilityGraphChart` / `ZPlanePoleChart`）。**14件とも D1（68件）の内側にある。**

もう1つの正しい作法は **`seriesMode` の系列を統計に使わず `prices` を直接渡す**もので、
`PhaseClockChart`（`conditionalForwardReturns(prices, …)`）と
`WeeklyPhaseAttractorChart`（`computeWeeklyPhaseKM(prices, …)`）がこれに当たる。

| コンポーネント | D3 の行数 | 状態 |
|---|---|---|
| `TransformCharts` | 5 | ✅ `needsTransform` あり |
| `PhaseClockChart` | 3 | ✅ `prices` を直接使う |
| `WeeklyPhaseAttractorChart` | 3 | ✅ `prices` を直接使う |
| `AnalyticSignalChart` | 2 | ✅ `needsTransform` あり |
| `EMDChart` | 1 | ✅ `needsTransform` あり |
| **小計（正しい）** | **14** | |
| `TailRiskChart` | 6 | ❌ |
| `DistributionShapeChart` | 4 | ❌ |
| `GarchChart` | 3 | ❌ |
| `ReturnDistribution` | 3 | ❌ |
| `VolatilityChart` | 3 | ❌ |
| `ConditionalViolinChart` | 2 | ❌ |
| `LagDependenceChart` | 2 | ❌ |
| `RegimeChart` | 2 | ❌ |
| `DistributionSurfaceChart` | 1 | ❌ |
| `RollingMomentsChart` | 1 | ❌ |
| `StructuralBreakChart` | 1 | ❌ |
| **小計（壊れている）** | **28** | **11コンポーネント** |

**ソース側の 11 コンポーネントと、画面側の 11 パネルは完全に一致する。**
2つの独立な数え方が同じ集合に着地したので、この分母は検算されている。

### 2.4 根（FU47 の記述どおり）

`app/lib/series-mode.ts` は `SeriesMode` と `SERIES_MODE_LABELS` しか持たず、
**「この系列は比率か水準か差分か」を誰も持っていない。**
上の `needsTransform` 3行は、その欠けている情報を各コンポーネントが手で書き足したものである。
14件は書き足し、54件は書き足していない（うち28行・11件が実害を出している）。

---

## 3. FU32 — ローソク足の凡例が、ローソク足として成立しない銘柄にも出る

`CANDLESTICK_LEGEND`（`app/lib/chart-colors.ts:160`）
＝「中空（白抜き）＝陽線・上昇／塗りつぶし＝陰線・下落」を描く箇所は **7ファイル**。

| # | ファイル | パネルID | `0331418A` での状態 |
|---|---|---|---|
| 1 | **`UnifiedChart.tsx:796`** | **無し**（基本節の常時表示ヒーローチャート） | **凡例が出ている**（実測・§3.1） |
| 2 | `ADXChart.tsx:211` | `tech-adx` | 本体ごと非表示（`closeOnly: "unavailable"`・実測で確認） |
| 3 | `StochasticsChart.tsx:253` | `tech-stoch` | 同上 |
| 4 | `OBVVWAPChart.tsx:222` | `tech-obvvwap` | 同上 |
| 5 | `ATRChart.tsx:189` | `vol-atr` | 同上 |
| 6 | `RangeContractionChart.tsx:161` | `vol-range-contract` | 同上 |
| 7 | `TrendJudgment.tsx:160` | — | **未配線**（どこからも import されていない → FU49。画面に出ない） |

→ **実際に画面へ出ているのは 1件だけ**である。分母7・対象1。

### 3.1 実測

`http://localhost:3122/?ticker=0331418A&sec=basic&period=10y` の Series Explorer 直下に

> 中空（白抜き）＝陽線・上昇／塗りつぶし＝陰線・下落

が描かれている。この銘柄は全1913本で `open = high = low = close` なので、
**中空も塗りつぶしもヒゲも存在しない。** ローソク足系列は高さ0の点列として描かれ、
見た目は破線状の価格推移になる。凡例だけが意味を持たないまま残る。

直前に「この銘柄は基準価額だけが配信され、始値・高値・安値は終値と同一、出来高は0です。
Series Explorerの価格推移は利用できますが、ローソク足の形や出来高は解釈できません。」という
注意書き（`app/page.tsx:583`）が出ているので、**同じ画面で注意書きと凡例が矛盾している。**

### 3.2 仕組みの外にある理由

- `UnifiedChart` は `app/page.tsx:591` で**パネルIDを持たずに常時描画**される
- したがって `closeOnly: "unavailable"` の分類（`AnalysisAvailabilityProvider` の
  `unavailableItemIds`）が届かない。S17 が FU26 で採った手はここでは使えない
- 判定そのもの（`hasCloseOnlyMarketData`）は **`app/page.tsx:301` にインラインで存在する**が、
  `UnifiedChart` には渡っていない（props は `prices` / `period` / `onNavigate` の3つだけ）

---

## 4. FU15 — 投信10年の初回（実測）

**8.0秒という記録は古い。現在は約 5.3〜6.1 秒である。** 内訳まで測った。

### 4.1 `/api/stock` の応答（本番ビルド・`range=10y`）

| 銘柄 | 種別 | 初回（キャッシュ MISS） | 2回目以降（HIT） |
|---|---|---|---|
| `0331418A` | 投信 | **5.81 秒** | 0.018 秒 |
| `03311187` | 投信 | 5.32 秒 | — |
| `9C31108A` | 投信 | 6.10 秒 | — |
| `7203.T` | 株式 | 0.99 秒 | — |
| `1306.T` | 株式 | 0.57 秒 | — |

### 4.2 どこで時間を使っているか（上流を直接叩いて計測）

`app/lib/stock-source.server.ts` の `fetchFundData()` は
①履歴ページのHTMLを取ってJWTとCookieを得る → ②BFF をページ送りで全件取る、の2段である。

| 区間 | 実測 | 備考 |
|---|---|---|
| ① 履歴ページHTML | 0.57〜1.21 秒 | 177 KB。JWT は取れている（**RSC 退避は起きていない**） |
| ② BFF 1ページ目 | 0.17〜0.34 秒 | |
| ② BFF 2〜96ページ目（`concurrency = 4`） | **3.7〜4.8 秒** | 24往復 |
| 上流 合計 | 5.2〜5.9 秒 | |
| 変換・`repairPriceGlitches()`・配信 | 約 0.3 秒 | route 全体 5.81 − 上流 5.45 |

**支配項は②の往復回数である。** BFF の1ページは **20件固定**で、
`0331418A` の10年は 1913件 = **96ページ**。`concurrency = 4` なので **24往復**する。

### 4.3 ページサイズは増やせない（実測で確認）

`size` / `pageSize` / `limit` / `perPage` の4通りを送ったが、
**全て無視され `paging.size` は 20 のまま**だった（`totalPage` も 96 のまま）。
1リクエストで全件取る手は存在しない。

### 4.4 唯一効く操作は同時取得数（実測）

| `concurrency` | 2〜96ページの所要（複数回計測） |
|---|---|
| 4（現状） | 4505 / 4813 / 3706 ms |
| 8 | 4249 ms（1ページあたりの応答が p50 159→291ms へ悪化して相殺） |
| 12 | 2215 / 2657 / 1724 ms |

12 にすると上流が **約2倍**速くなる（合計 5.5秒 → 約 3.3秒）。
ただし配信元への瞬間的な要求数が3倍になる。**RSC 退避経路のコメントは
「配信元への負荷を限定する」ために同時取得数を 2 に抑えると明記しており、
これは値の変更ではなく方針の変更である。判断を仰ぐ。**

---

## 5. FU32 / FU47 のどちらでもないもの（今回はやらないが、見つけた事実として残す）

| # | 節 | パネルID | 事実 | 性質 |
|---|---|---|---|---|
| E1 | simulation | `sim-optstop` | 代替テキストが **「最適停止の期待リターンは751.80%、秘書問題の1/e戦略は1395.33%、実測は5328.84%」**。同じ画面の可視テキストは **7.52% / 13.95% / 53.29%** で、**ちょうど100倍ずれている。** `optimal-stopping.ts:106-123` が既に百分率にしているのに、`OptimalStoppingChart.tsx:24` がもう一度 100 倍している | **FU45 と同型。A3（S20）が入れた単位取り違え。** `mode` にも銘柄にも依らないので**株式でも同じ**。可視側は正しいので目では気づけない |
| E2 | volatility | `vol-cone` | 代替テキストが **「パーセンタイルが最も高いのは5日窓の10000%（現在122.0%・中央値12.6%）」**。`cornish-fisher.ts:181` の `currentPercentile` は既に 0〜100 なのに、`VolConeChart.tsx:32` が 100 倍している | 同上。**可視側には出ていない数値**なので表による代替も効かない |
| E3 | simulation | `sim-kelly` | 破産線 **1105% / 1494%**。`f* = μ/σ² = 553%` の2倍で算術的に整合しており、この投信の μ/σ² が大きいだけ | **欠陥ではない**（閾値の網に掛かっただけ） |
| E4 | basic | — | Series Explorer の既定系列に **「出来高」** が入っており、投信では全点0のヒストグラムと凡例だけが残る | FU32 と同じ「意味を持たない表示」だが、対象は凡例ではなく系列。**FU32 の判断次第では同時に扱える** |
| E5 | — | — | `app/components/analysis/TrendJudgment.tsx` が**どこからも import されていない**（`app/lib/trend-analysis.ts` の同名 interface が grep に混ざるだけ） | **FU49 の裏取り。S19 の退行ではない** |

**E1 と E2 は A3 の代替テキストに入り込んだ単位取り違えで、FU45 で2件直したのと同じ型である。**
FU45 が「読み上げを聞くまで分からない」と書いたとおり、`npm test` / `lint` / `build` は全て通る。
**今回の担当（FU32 / FU47 / FU15）には含まれないので、次のFU候補として残す。**

---

## 6. この棚卸しで確定したこと

1. FU47 の分母は **`%` 出力行 102 のうち、系列と同じ単位の 42 行**。うち **28 行・11 コンポーネント**が壊れている
2. 残り 14 行は **既に正しく、その正しさは `needsTransform` という手書きの3行に依存している**
3. FU32 の分母は **`CANDLESTICK_LEGEND` を描く 7 ファイル**。うち画面に出るのは **`UnifiedChart` の1件だけ**
4. FU15 の現在値は **5.3〜6.1 秒**（8.0秒ではない）。支配項は **BFF の 96 ページ・24往復**で、
   ページサイズは変更できず、効く操作は同時取得数だけである
5. 上の3件に入らない事実が **5件**あり、うち2件（E1 / E2）は**株式でも起きる代替テキストの単位取り違え**である
