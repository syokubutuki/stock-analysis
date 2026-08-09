# プロジェクト規約

## 価格データ（最優先）

**価格は必ず `/api/stock` 経由で取得する。Yahoo Finance を直接叩かない。**
配信元に稀にスケール破損（1/10 等）が混じり、1点で市場βが 1.10 → 0.05 に潰れる。
修復は `app/api/stock/route.ts` が通す `repairPriceGlitches()` が唯一の地点。
呼び出し箇所は20以上あり、個別コンポーネントで対処すると必ず漏れる。

- ベンチマークは `useBenchmarkPrices(ticker)`。自前 fetch なら `/api/stock?ticker=…&range=10y`。
- 別の外部データ源を追加するときは、その route handler でも `repairPriceGlitches()` を通す。
- 閾値・判定を変えたら `SANITIZER_VERSION` を上げる（IndexedDBキャッシュが旧版を捨てる）。
- 手を入れたことは画面に開示する（`DataQualityNotice`／`StockData.dataQuality`）。
- 判定の設計思想・過去の誤検出事故は `app/lib/price-sanity.ts` 冒頭に記載。触る前に読むこと。

## チャートの描画方式

横軸が時間・日付の系列は **`lightweight-charts` を標準**とする。静的Canvas2Dは画像同然で、
時間軸のズーム/パンができず期間の細部を見られない。手本は `ConditionMarkerChart.tsx`。

Canvas2D を使ってよいのは横軸が時間でない静的図のみ（分布、散布、QQ、相関行列、位相空間、
ネットワーク等）。

## 分析コンポーネント

新しい分析には必ず `<AnalysisGuide>` で折りたたみ可能な詳細解説を付ける。含める内容は
①手法の概要 ②数式（変数定義・導出込み、省略しない） ③専門用語の日本語定義 ④直感的な例え
⑤結果の読み方（「この値が○○以上なら△△」） ⑥投資判断への活用 ⑦注意点・限界。
書き方は `app/components/analysis/` の既存117件を手本にする。
