# Repository Guidelines

## Project Structure & Module Organization

本リポジトリは Next.js 16 App Router アプリです。画面と Route Handler は `app/`、分析 UI は `app/components/analysis/`、計算ロジックは `app/lib/`、取得・状態管理は `app/hooks/`、外部サービスとの境界は `app/api/` に置きます。Web Worker は `*.worker.ts`、設計・統計仕様は `docs/` に配置します。専用のテストディレクトリと自動テストランナーは現状ありません。

## Build, Test, and Development Commands

- `npm run dev`: ローカル開発サーバーを起動します。
- `npm run lint`: Next.js 設定の ESLint を実行します。
- `npm run build`: 型検査を含む本番ビルドを作成します。PR 前に必ず実行してください。
- `npm run start`: 作成済みの本番ビルドを起動します。

## Coding Style & Naming Conventions

TypeScript、React 関数コンポーネント、2 スペースインデントを使用します。コンポーネントは PascalCase（`RollingHurstChart.tsx`）、関数・Hook は camelCase（`useBenchmarkPrices`）、ライブラリは kebab-case とします。分析コンポーネントは `next/dynamic` の `ssr: false` で読み込みます。数式や計算は `app/lib/` に置き、UI 内で重複実装しないでください。

## Analysis & Data Rules

新しい分析には折りたたみ式 `AnalysisGuide` を必ず付け、手法、完全な数式と変数、日本語の用語定義、直感的な例、結果の読み方、投資への活用、限界を説明します。

日足価格は必ず `/api/stock` 経由で取得し、コンポーネントから Yahoo Finance を直接呼びません。価格修復は `app/lib/price-sanity.ts` の `repairPriceGlitches()` だけで行います。判定変更時は `SANITIZER_VERSION` を上げ、`StockData.dataQuality` を保持し、`DataQualityNotice` で修復を開示してください。ベンチマークには `useBenchmarkPrices()` を使います。

時間・日付軸はズーム／パン可能な `lightweight-charts` を使います。Canvas2D はヒストグラム、散布図、QQ、行列、ネットワークなど非時系列の静的図に限定します。v5 のマーカーは `createSeriesMarkers` を使用し、廃止済みの `series.setMarkers()` は使いません。

## Testing Guidelines

最低限 `npm run lint` と `npm run build` を通します。チャートや操作を変更した場合は、デスクトップと狭い画面で対象フローをブラウザ確認し、読み込み中・空・エラー状態、リサイズ、後始末、ズーム／パン、データ品質表示も確認してください。

## Commit & Pull Request Guidelines

コミットは既存履歴に合わせ、成果と理由を具体的な日本語で記述します（例: `価格修復を取得層に一元化: βの破損を防止`）。1 コミットは1目的に絞ります。PR には目的、対象分析、検証コマンド、データ品質への影響を記載し、表示変更には比較スクリーンショット、関連 Issue や設計文書へのリンクを添えてください。

## Security & Configuration

秘密情報やローカル環境ファイルをコミットしません。PostgreSQL 認証情報と管理トークンは環境変数で管理します。永続化変更では匿名台帳の所有者識別とフォールバックを維持してください。背景の詳細は `CLAUDE.md` と `docs/` を参照します。
