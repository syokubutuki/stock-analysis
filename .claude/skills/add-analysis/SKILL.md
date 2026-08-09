---
name: add-analysis
description: 新しい分析（チャート／パネル）をこのアプリに追加する手順。lib の計算・コンポーネント・AnalysisGuide・page.tsx への配線までの規約。
---

# 分析の追加手順

計算（`app/lib/`）と描画（`app/components/analysis/`）を分け、`app/page.tsx` に配線する。
既存117件が手本。**新規に発明せず、目的の近いものを1つ選んで写す。**

## 1. 計算を `app/lib/<name>.ts` に置く

- 純粋関数。React・DOM・fetch を持ち込まない（Worker から呼べる形＝テスト可能な形）。
- 入力は `PricePoint[]`（`{ time, open, high, low, close, volume }`）。
- 重い探索（グリッドサーチ、ブートストラップ、順列検定）は Web Worker に逃がす。
  手本は `app/lib/sarima.worker.ts`（`new Worker(new URL("../../lib/x.worker.ts", import.meta.url))`）。
- 乱数は必ずシード付き（`mulberry32`）。再実行で数字が変わると検証できない。

## 2. コンポーネントを `app/components/analysis/<Name>Chart.tsx` に置く

`"use client"`。props は原則 `{ prices: PricePoint[] }`、ベンチマークが要るなら `ticker` も。

**描画方式の選択（CLAUDE.md の規約）**
- 横軸が時間・日付 → `lightweight-charts`。手本 `ConditionMarkerChart.tsx`
- 横軸が時間でない静的図（分布・散布・QQ・相関行列・ネットワーク）→ Canvas2D。
  `initCanvas` は共有ヘルパではなく各ファイルにコピーがある（96件）。隣から持ってくる

**価格データ（CLAUDE.md の規約）**
- 追加の系列が要るなら必ず `/api/stock?ticker=…&range=10y`。Yahoo を直接叩かない
- ベンチマークは `useBenchmarkPrices(ticker)`。手本 `AttenuationBetaChart.tsx`

**lightweight-charts v5 の落とし穴**
- `chart.addSeries(LineSeries, {...})`。`addLineSeries()` は無い
- マーカーは `createSeriesMarkers(series, markers)`。`series.setMarkers()` は無い
- `lineWidth` は整数のみ（1/2/3/4）。`HistogramSeries` はマーカー非対応
- 複数ペインの同期は `subscribeVisibleLogicalRangeChange` で相互に。手本 `ConditionMarkerChart.tsx:201-205`

**標本が薄いときの表示**
- `StatBadge` は n<30 で「参考(n小)」に落ちる。この判定を自前で書き直さない
- 有意でないなら「有意でない」と出す。null result は失敗ではなく結果

## 3. `<AnalysisGuide>` を必ず付ける

`<AnalysisGuide title="…の詳細理論">` で末尾に折りたたむ。中身は7項目を**この順で**、
見出しは `<p className="font-medium text-gray-700">N. 見出し</p>`。手本 `WeekendPremiumChart.tsx:289-401`。

1. **手法の概要** — 何を測っているか。何が分かれば何が言えるのか
2. **数式** — 変数定義と導出込み。**省略しない**。なぜその式になるかまで書く
3. **専門用語の日本語定義** — `<ul>` で用語ごとに。英語のまま置かない
4. **直感的な例え** — 数式を日常の比喩に落とす
5. **結果の読み方** — 「この値が○○以上なら△△」の形。閾値を具体的な数字で
6. **投資判断への活用** — 建玉をどう変えるのかまで踏み込む
7. **注意点・限界** — 何を仮定していて、いつ壊れるか

## 4. `app/page.tsx` に配線する（4か所）

```tsx
// (a) 動的 import。SSR無効・プレースホルダ必須（~240行目付近の並びに追加）
const FooChart = dynamic(
  () => import("./components/analysis/FooChart"),
  { ssr: false, loading: () => <ChartPlaceholder height={350} /> }
);

// (b) 該当セクションの groups[].items[] に1行
{ id: "cal-foo", title: "…（丸括弧で手法を補足）", node: <FooChart prices={filteredPrices} /> },
```

- **`filteredPrices` か `allPrices` か** — `filteredPrices` は PeriodSelector で切った期間、
  `allPrices` は10年フル。期間を変えて見せたい分析は前者、標本数が要る検定系は後者
  （`useAnalysisData.ts:53-63`）
- **`id`** は `<セクション略号>-<名前>`（`cal-` / `pf-` / `sim-` …）。
  この id が `CollapsibleAnalysis` の localStorage キー `sa:open:<id>` と
  DOM の `#panel-<id>` になる。**後から変えると利用者の開閉状態が失われる**
- (c) 新セクションを足すなら `SECTIONS`（1071行目）
- (d) `seriesMode` を実際に消費するなら `SERIES_AWARE_SECTIONS`（1101行目）にキーを追加

## 5. 確認

型チェックは検証ではない。`verify` skill でブラウザに描画させて目で見る。
