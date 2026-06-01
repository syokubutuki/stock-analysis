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

## 技術スタック

- Next.js 16 App Router / TypeScript / Tailwind CSS v4
- チャート: `lightweight-charts` v5.2.0（時系列）、Canvas2D（カスタム描画）
- 全コンポーネントは `next/dynamic` で SSR無効の動的インポート
- `PricePoint = { time: string, open, high, low, close, volume: number }`
- `SeriesMode` でデータ変換（close/logReturn等）
- `AnalysisGuide` は折りたたみ式パネル（`app/components/analysis/AnalysisGuide.tsx`）

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
