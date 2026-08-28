---
name: add-analysis
description: 新しい分析（チャート／パネル）をこのアプリに追加する手順。lib の計算・コンポーネント・AnalysisGuide・パネルレジストリへの登録までの規約。
---

# 分析の追加手順

計算（`app/lib/`）と描画（`app/components/analysis/`）を分け、`app/lib/panel-registry.tsx` に登録する。
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

## 4. `app/lib/panel-registry.tsx` に1行足す（配線はここだけ）

該当セクションの `groups[].panels[]` に `definePanel({...})` を1つ足す。
**動的 import・所属節・入力の形・終値だけの系列での扱いが、この1レコードに揃っている。**

```tsx
definePanel({
  id: "cal-foo",
  title: "…（丸括弧で手法を補足）",
  input: "filtered",
  closeOnly: "safe",
  height: 350,
  load: () => import("../components/analysis/FooChart"),
}),
```

- **`id`** は `<セクション略号>-<名前>`（`cal-` / `sim-` / `dist-` …）。
  この id が `CollapsibleAnalysis` の localStorage キー `sa:open:<id>` と
  DOM の `#panel-<id>` と共有URL `?panel=<id>` になる。
  **後から変えると利用者の開閉状態と共有URLが壊れる。**
  接頭辞が所属節と食い違うと `npm test` が落ちる
- **`input`** — どの系列と付随情報を受け取るか。実在するのは9通りだけ。
  `filtered` は PeriodSelector で切った期間、`all` は10年フル。期間を変えて見せたい
  分析は前者、標本数が要る検定系は後者（`useAnalysisData.ts:53-63`）。
  `filtered+series` を選ぶと**その節の系列セレクタが自動的に有効になる**
  （`SERIES_AWARE_SECTIONS` は導出。手で足す表はもう無い）。
  **宣言と実際の props が食い違うと型エラーになる**ので、当てずっぽうで書けない
- **`closeOnly`** — 投信は全バーで `open==high==low==close` かつ `volume==0` である。
  出来高・OHLC内訳・日中/夜間そのものが対象なら `"unavailable"`（本体をマウントせず
  理由を出す）、パネル内の一部のサブ分析だけがそうなら `"caution"`（注意書きを冒頭に
  出す）、終値だけで成立するなら `"safe"`。**型が必須にしているので分類漏れは起こらない**
- **`height`** — 読み込み中プレースホルダの高さ。実際のチャートに近い値にする
  （ずれるとレイアウトシフトになる）
- 新セクションを足すなら `SECTIONS` に1レコード。
  折りたたみパネル群でなく常時表示のワークスペースなら `render: "workspace"`

### `npm test` が落ちたときに直す場所

| 落ちたテスト | 直すもの |
|---|---|
| 並び順込みで golden と完全一致する | パネルを増減したなら `fixtures/panel-ids.golden.ts` を同じ位置で更新。**IDを変えてしまった場合はレジストリのほうを戻す** |
| 分類の内訳が意図せず動いていない | `closeOnly` を意図して動かしたなら件数を更新し、理由をコミットに残す |
| IDの接頭辞が所属節の命名規約に沿っている | ID の接頭辞を所属節に合わせる |
| 節の中で実際に反応するのは一部である | `input` を意図して変えたなら比率を更新する |

### バッジ（見出しに出る所見）を付けるなら

`useAnalysisResultSummary("<id>", …)` をコンポーネント本体から呼ぶ。既に計算した値を
渡すだけで、**新しい計算を足さないこと**（閉じたままのパネルを事前計算しない規約）。

**バッジは「判断」だけを出す。「量」は出さない。**
`{ status: "finding", direction: "up" | "down", label: "売られすぎ" }` の形しか書けず、
標本数や件数のような方向を持たない量は型が受け付けない（`{ status: "none" }` になる）。
量はパネルを開いた中の表で示すこと。IDは `page-wiring.test.ts` が突き合わせる。

## 5. 確認

型チェックは検証ではない。`verify` skill でブラウザに描画させて目で見る。
