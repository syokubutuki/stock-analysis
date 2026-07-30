# プロジェクト規約

## 分析コンポーネントの実装ルール

新しい分析機能を追加する際は、必ず `<AnalysisGuide>` コンポーネントで折りたたみ可能な詳細解説を含めること。

### AnalysisGuide に含めるべき内容

1. **手法の概要**: 何を計算・可視化しているか、なぜこの分析が必要かを平易な言葉で説明
2. **数式**: 使用する数式を省略せず記載（変数の定義、導出の流れも含む）
3. **用語の定義**: 専門用語は初出時に必ず日本語で意味を説明する
4. **直感的な例え**: 数学的な概念を日常的な比喩で説明（例: 「Hurst指数はコイン投げの偏りのようなもの」）
5. **結果の読み方**: チャートや数値の具体的な解釈方法（「この値が○○以上なら△△を意味する」）
6. **投資判断への活用**: 実務でどう使うか、どのような売買判断に役立つかを具体的に記載
7. **注意点・限界**: その分析手法の前提条件、適用限界、誤用しやすいポイント

### 記載例のパターン

```tsx
<AnalysisGuide title="○○分析の詳細理論">
  <p className="font-medium text-gray-700">1. ○○とは</p>
  <p>平易な説明...</p>

  <p className="font-medium text-gray-700 mt-3">2. 数式</p>
  <p>{"数式をここに記載"}</p>

  <p className="font-medium text-gray-700 mt-3">3. 結果の解釈</p>
  <ul className="list-disc pl-4 space-y-1">
    <li>具体的な解釈...</li>
  </ul>

  <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
  <ul className="list-disc pl-4 space-y-1">
    <li>活用方法...</li>
  </ul>

  <p className="font-medium text-gray-700 mt-3">5. 注意点</p>
  <ul className="list-disc pl-4 space-y-1">
    <li>限界や注意...</li>
  </ul>
</AnalysisGuide>
```

## 価格データの取得（重要・データ品質）

**価格は必ず `/api/stock` 経由で取得する。Yahoo Finance を直接叩くコードを書かない。**

配信元のデータには稀にスケール破損が混じる。実例として `1306.T`（TOPIX ETF）は
2026-03-30〜03-31 の2営業日だけ価格が 1/10 になっており（生値・調整後の両方、分割の告知なし）、
これを放置すると日次σが 1.3% → 12.1%、この系列をベンチマークにした市場βが **1.10 → 0.05**
に潰れる。**1点の異常値が回帰・分散・シャープ比・最適化のすべてを無意味にする**。

そのため `app/api/stock/route.ts` が `app/lib/price-sanity.ts` の `repairPriceGlitches()` を
通してから返す。ここが**唯一の修復地点**。呼び出し箇所は20以上あるので、個別のコンポーネントで
対処すると必ず漏れる。

- 新しい分析でベンチマーク/指数が必要なら `useBenchmarkPrices(ticker)`（`app/hooks/`）を使う。
  自前で `fetch` するなら必ず `/api/stock?ticker=…&range=10y` を叩く。
- 別の外部データ源を追加するときは、**その route handler でも `repairPriceGlitches()` を通す**。
- サニタイザの閾値・判定を変えたら `SANITIZER_VERSION` を上げる。IndexedDB キャッシュ
  （`app/lib/price-cache.ts`）が版を突き合わせ、旧版で保存した破損データを TTL 内でも捨てる。
- データに手を入れたことは画面に開示する（`DataQualityNotice`／`StockData.dataQuality`）。
  黙って書き換えると、利用者は自分が見ている数値の出自を知れない。
- 判定は**保守側に倒す**（往復＋切りのいい倍率＋σ相対の材料性がすべて必要）。正しいデータを
  黙って書き換える方が、破損を見逃すより有害。条件を満たさない極端な変動は修復せず
  `suspects` として警告に出す。`^TNX` の 2020-03-09（COVID の金利急落）を倍率 2/3 として
  誤検出した事故があり、1 に近い倍率は候補から外してある。

## 技術スタック

- Next.js 16 App Router / TypeScript / Tailwind CSS v4
- チャート: `lightweight-charts` v5.2.0（時系列）、Canvas2D（カスタム描画）
- 全コンポーネントは `next/dynamic` で SSR無効の動的インポート
- `PricePoint = { time: string, open, high, low, close, volume: number }`
- `SeriesMode` でデータ変換（close/logReturn等）
- `AnalysisGuide` は折りたたみ式パネル（`app/components/analysis/AnalysisGuide.tsx`）

## チャート描画方式の選択（重要）

時系列を「横軸＝時間/日付」で見せるチャートは、**原則 `lightweight-charts` を標準**とする。静的Canvas2Dは画像のように埋め込まれてしまい、ブラウザ拡大ではページ全体が拡大するだけで期間の細部を見られないため、**時間軸方向のズーム/パンが価値を持つチャートにCanvas2Dを使わない**。

- **lightweight-charts を使う**: 横軸が時間・日付の系列（価格ライン、リターン、マーカー、ヒートライン等）。ホイールでズーム・ドラッグでパンが標準で効く。期間の細部を拡大確認できることが必須。
  - 基本形は `createChart` + `addSeries(LineSeries, …)` + `createSeriesMarkers(series, markers)`。実装の手本は `ConditionMarkerChart.tsx` / `IntradayWindowChart.tsx`。
  - 初期化は「コンテナがDOMに出現してから」生成する（条件レンダリングするコンテナは `useEffect` の依存に出現フラグを入れる）。`window.resize` で `applyOptions({ width })`、アンマウントで `chart.remove()`。
  - 複数ペインは `timeScale().subscribeVisibleLogicalRangeChange` で時間軸を相互同期。
  - 日付の `Time` は `"YYYY-MM-DD"` 文字列。マーカーは系列に存在する時刻にのみ置ける。色はマーカー単位で指定可、`shape`/`position`（inBar/aboveBar/belowBar）で表現。
- **Canvas2D を使ってよい**: 横軸が時間でない静的図（分布ヒストグラム、散布図、QQ、相関行列、位相空間、ネットワーク、発散バー等）。ズーム不要で一枚絵が適切なもの。
- v5 API 注意: `series.setMarkers()` は廃止 → `createSeriesMarkers(series, markers)`。`lineWidth` は整数のみ。`HistogramSeries` はマーカー非対応。

## Canvas描画のパターン

```typescript
function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}
```
