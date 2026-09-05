# 次セッション実装引き継ぎ

更新日: 2026-08-01（進捗注記を 2026-08-05 に追記・冒頭の申し送りを 2026-09-05 に更新）

> ## ⚠ 2026-09-05 更新 — **本書の残件は全部片付いた。運用の正は別文書である**
>
> 下の「進捗（2026-08-05 時点）」で未着手だった §4 / §5 は、いずれも完了している。
>
> | 手順 | 現在の状態 |
> |---|---|
> | §4 投信価格アダプターの修復 | **完了**（R0）。`stock-source.server.ts`。**退避 catch の絞り込み（FU23）も 2026-08-28 に完了** |
> | §5 `/t/[ticker]` と SSR サマリー | **完了**（R1・2026-08-15）。98銘柄で公開。取得は 10y・OG画像あり |
>
> **いま進行中の作業は `docs/site-improvement-round5.md` が正。**
> 次に投げるのは **S22（FU32 / FU47 / FU15 = 投信 `0331418A` の表示を実機で通しで直す）。単独で投げること。**
> S14 / S16 / S15 / S17 / S18 / S19 / S20 / **S21** はマージ済み。本書は設計の記録として残しているだけで、
> **「次に何をやるか」をここから読まないこと。**
>
> **親計画 §11 の項目は全件が 完了 か 見送り になった**（2026-09-05）。
> 以後は「計画書の項目を消化する」形ではなく、**FU バックログを性質ごとに束ねる**形である。
>
> **S19（M3 レジストリ化）が入ったので、パネルの追加手順が変わった。**
> 配線は `app/lib/panel-registry.tsx` の1レコードだけである（旧5か所ではない）。
> `app/lib/panel-sections.ts` と `app/lib/panel-data-requirements.ts` は**削除済み**。
> 手順は `.claude/skills/add-analysis/SKILL.md` §4 が正 → `docs/site-improvement-round5.md` §0.8。
>
> **S21（2026-09-05）で、手で維持している台帳3件がテストで縛られた。**
> `tiers.ts` の `FREE_PANEL_IDS`（課金境界）・`ticker-pages.ts` の `PRICE_UNAVAILABLE_TICKERS`・
> OG画像のフォントサブセットは、いずれもずれると `npm test` が落ちる。
> **落ちたらテストを緩めず、実装とテストのどちらが正しいかを報告すること。**
>
> 投げ方は `docs/site-improvement-round5.md` §3。プロンプトは生成物なので
> `node docs/tools/build-session-prompts.mjs S22` で作る（`docs/prompts/` を直接編集しない）。

> ## 進捗（2026-08-05 時点・コード確認済み）
>
> **下の「実装順」§1〜§3 は完了している。残件は §4 と §5 だけ。**
>
> | 手順 | 状態 | 根拠 |
> |---|---|---|
> | §1 統合銘柄モデルと検索正規化 | **完了** | `app/lib/instruments.ts` / `instrument-search.ts` / `instrument-resolver.ts` |
> | §2 `/api/search` をローカル優先の集約検索へ | **完了** | `app/api/search/route.ts` に `source: catalog\|yahoo`・`degraded`・Runtime Cache |
> | §3 検索UIを一般利用者向けに | **完了** | `TickerSearchInput.tsx` に種類バッジ・`priceSupported`・combobox |
> | §4 投信価格アダプターの修復 | **未着手** | `app/lib/stock-source.server.ts:77` が旧 `x-jwt-token` 方式のまま |
> | §5 `/t/[ticker]` と SSR サマリー | **未着手** | `app/t/` が存在しない |
>
> この2件は `docs/site-improvement-execution-plan.md` で **R0**（§4）・**R1**（§5）として
> 優先順位・依存関係に組み込まれている。着手前にそちらも読むこと。
> **実装仕様は本書（NEXT_SESSION.md）が正**、優先順位と全体の位置づけは実行計画書が正。

## 目的

次の開発は、`/t/[ticker]` のSSRページを量産する前に、一般利用者が会社名・商品名・通称・指数名から目的の銘柄を見つけられる「統合銘柄検索・銘柄解決基盤」を実装する。

検索、`/api/stock`、将来の `/t/[ticker]` が同じ正規化規則と銘柄情報を使う状態を作り、その後に主要100銘柄のSSRサマリーを公開する。

## 現在地

- `/api/stock` のVercel Runtime Cache実装は完了済み。
  - コミット: `29d67ca 価格取得をサーバー共有キャッシュ化: Yahoo負荷と障害リスクを低減`
  - 実装: `app/lib/stock-data.server.ts`
  - fresh 8時間、保持7日、stale fallback、同一インスタンス内のリクエスト集約を実装済み。
  - 価格修復は取得後に `repairPriceGlitches()` で一元適用し、`dataQuality` を保持している。
- 現在の検索UIは会社名入力を想定しているが、検索APIがYahoo Searchへ直接依存している。
  - API: `app/api/search/route.ts`
  - UI: `app/components/TickerSearchInput.tsx`
  - 日本語の `トヨタ`、`ソフトバンク`、`オルカン` などでYahoo側が400または候補なしになる場合がある。
  - APIは上流エラーを空配列にしているため、利用者には「コード検索しかできない」ように見える。
- 投信価格取得は現在故障している。
  - 実装: `app/lib/stock-source.server.ts` の `fetchFundData()`
  - 旧方式はYahoo投信履歴ページHTMLから `"jwtToken"` を抽出し、それを `jwt-token` ヘッダーとして旧BFFへ渡す。
  - 現在の投信履歴ページはNext.js/RSC形式に変わり、既存コードが期待する `jwtToken` と `mainFundPriceBoard` がHTMLにない。
  - これは「Yahoo全体でJWTが廃止された」と断定するものではなく、少なくとも旧HTML→JWT→BFFという取得手順が成立しなくなったという意味。
- 主要100銘柄の既存定義は `app/lib/universes.ts` にある。新しい銘柄マスターはこの定義を再利用し、同じリストを重複管理しないこと。

## 実装順

### 1. 統合銘柄モデルと検索正規化

最初に、UIや外部APIに依存しない純粋なライブラリを作る。

想定ファイル:

- `app/lib/instruments.ts`: 銘柄型、主要銘柄データ、別名
- `app/lib/instrument-search.ts`: 入力正規化、スコアリング、ローカル検索、重複排除
- 必要なら `app/lib/instrument-resolver.ts`: URL・検索入力・Yahoo symbol間の変換

最低限のモデル:

```ts
export type InstrumentType =
  | "jp-stock"
  | "us-stock"
  | "etf"
  | "fund"
  | "index";

export interface Instrument {
  ticker: string;          // アプリで使うcanonical ticker。例: 7203, AAPL, ^N225
  yahooSymbol: string;     // 価格取得用。例: 7203.T, AAPL, ^N225
  name: string;            // 日本語優先の表示名
  nameEn?: string;
  aliases: string[];       // トヨタ、TOYOTA、SBG、オルカン等
  type: InstrumentType;
  market: string;
  currency: string;
  priceSupported: boolean;
}
```

正規化要件:

- Unicode NFKC
- 前後・連続空白の整理
- 英字の大文字小文字を同一視
- ひらがな・カタカナを同一視
- 記号や空白の有無を吸収できる検索用キー
- 4桁の東証コード、7〜8桁の投信コード、Yahoo symbolを壊さない
- canonical tickerとYahoo symbolの変換規則を一か所に集約する

検索順位の目安:

1. コード完全一致
2. 正式名称・別名の完全一致
3. 名称・別名の前方一致
4. 名称・別名の部分一致
5. Yahoo fallbackの候補

同点ではローカル銘柄、`priceSupported: true`、主要銘柄を優先する。`ソフトバンク`のような曖昧入力は `9984` と `9434` の両方を表示し、勝手に一方へ決定しない。

初期カタログ:

- `app/lib/universes.ts` の主要100日本株
- `^N225`、`^TPX`、`^GSPC` など既存画面で使う主要指数
- AAPL、MSFT、NVDAなど利用頻度の高い米国株
- 主要ETF
- 投信は検索対象に含められるが、価格取得を確認できるまで `priceSupported: false`
- 最低限の通称: トヨタ、ソニー、SBG、ソフトバンク、日経平均、日経225、TOPIX、S&P500、SP500、オルカン、ゴールド、金

重要: `universes.ts` の銘柄名が文字化けして見える場合は、PowerShellの表示エンコーディングだけで判断せず、ファイルをUTF-8として確認すること。

### 2. `/api/search` をローカル優先の集約検索へ変更

`app/api/search/route.ts` を次の流れへ変更する。

```text
入力検証
  -> ローカル銘柄検索
  -> 必要な場合のみYahoo Search fallback
  -> 形式を統一
  -> 重複排除と順位付け
  -> 結果返却
```

APIレスポンス例:

```ts
interface InstrumentSuggestion {
  ticker: string;
  symbol: string;
  name: string;
  type: InstrumentType;
  market: string;
  currency?: string;
  priceSupported: boolean;
  source: "catalog" | "yahoo";
}
```

要件:

- ローカルで十分な候補が得られた場合はYahooへアクセスしない。
- Yahoo fallbackはVercel Runtime Cacheで短TTLキャッシュする。目安は成功1時間、候補なし・上流失敗5〜15分。
- Runtime Cacheが利用不能でも検索そのものは継続する。
- 上流障害を単純な空配列に潰さず、レスポンスに `degraded: true` を含める。ただしローカル候補があればHTTP 200で返す。
- 入力長と最大結果数を制限する。
- Yahoo由来の `.T` は画面入力用tickerと価格取得用symbolを混同しない。

### 3. 検索UIを一般利用者向けにする

`app/components/TickerSearchInput.tsx` を新レスポンスへ対応させる。

要件:

- 候補に「正式名称、コード、種類、市場」を表示する。
- 日本株、米国株、ETF、投信、指数をバッジ等で区別する。
- キーボード操作、AbortController、デバウンスを維持する。
- `priceSupported: false` は選択後に価格APIを呼ばず、「価格取得は現在調整中」と明示する。
- 候補なし、検索中、上流縮退、エラーを区別する。
- フォーカス時に人気例または検索例を表示する場合も、狭い画面で邪魔にならないようにする。
- 曖昧な名称は複数候補から選べるようにする。
- コードの直接入力・Enter送信は維持する。

### 4. 投信価格アダプターを修復

検索基盤と分離して実施する。投信を有効化する前に、実ブラウザのNetworkでYahoo投信履歴ページが利用している現在の通信を確認する。

調査対象:

- `FundsHistoryClient` がクライアント側で呼ぶ履歴エンドポイント
- RSC内の `initialData.response.historyTable` と追加ページ取得方法
- 認証・Cookie・Referer・CSRF等の必要条件
- 利用規約、安定性、レート制限

実装判断:

- 安定した履歴APIが確認できれば `fetchFundData()` を新方式へ交換する。
- RSC埋め込みデータの直接パースしか方法がない場合は、壊れやすい暫定実装として隔離し、fixtureを用意する。
- 安定して取得できない場合は別のデータ提供元を検討し、それまでは `priceSupported: false` を維持する。
- 価格データは必ず `/api/stock` 経由とし、`repairPriceGlitches()`、`SANITIZER_VERSION`、`dataQuality`、`DataQualityNotice` の規則を維持する。

### 5. `/t/[ticker]` とSSRサマリーを主要100銘柄で公開

検索・resolver・投信の扱いが安定した後に開始する。

想定ファイル:

- `app/t/[ticker]/page.tsx`
- 必要なら `app/t/[ticker]/loading.tsx`、`not-found.tsx`
- `app/sitemap.ts` の拡張

要件:

- Server Componentから `getStockData()` を直接使い、ブラウザ経由で `/api/stock` を自己呼び出ししない。
- 初期公開は `universes.ts` の主要100銘柄。
- URLはcanonical tickerへ統一し、不正・未知tickerは404またはcanonical URLへredirectする。
- SSR HTMLに最低限、銘柄名、コード、基準日、現在値、期間リターン、ボラティリティ、最大ドローダウンを含める。
- 詳細な分析UIは既存ルールどおり必要に応じて `next/dynamic` の `ssr: false` を使う。
- `generateMetadata()` も同じ銘柄マスターを使用する。
- sitemapは実際に表示・価格取得できる銘柄だけを含める。
- SSRの大量生成でYahooへ直接100回アクセスしないこと。共有価格キャッシュを利用し、必要なら少数でビルド挙動を確認してから対象を増やす。

## 受け入れ確認

検索基盤:

- `7203`、`7203.T`、`トヨタ`、`トヨタ自動車`、`TOYOTA` からトヨタへ到達できる。
- `ソフトバンク` で `9984` と `9434` が区別して表示される。
- `日経平均`、`日経225`、`S&P500` から対応指数へ到達できる。
- Yahoo Searchが失敗しても主要100銘柄の名称検索が動く。
- 投信の取得未対応状態が、空結果や502ではなく利用者に説明される。
- 同じ入力の連打でYahooへの外部アクセスが増え続けない。

SSR:

- `/t/7203` の初期HTMLに銘柄名とサマリー数値が含まれる。
- 不正tickerと未対応tickerの挙動が明確。
- metadata、canonical、sitemapが一致する。
- データ取得失敗時にページ全体が無説明で500にならない。

共通:

- `npm run lint`
- `npm run build`
- 検索UIと `/t/7203` をデスクトップ・狭い画面でブラウザ確認
- 読み込み中、候補なし、上流障害、未対応投信、リサイズ、キーボード操作を確認

## コミットの分け方

1. `銘柄解決を共通化: 日本語名とコードを同じ銘柄へ統合`
2. `検索候補をローカル優先化: Yahoo障害時も主要銘柄を検索可能に`
3. `銘柄検索UIを一般化: 種類と市場と未対応状態を明示`
4. `投信価格取得を現行仕様へ更新: 旧JWT依存を解消`
5. `主要100銘柄のSSRページを公開: 検索流入と共有導線を追加`

各コミット前に少なくとも関連lintを確認し、最終コミット前に `npm run lint` と `npm run build` を通す。

## スコープ外

- 「初心者向け」「安全」「今後上がりそう」など投資意図からの銘柄推薦
- 高配当・業種・財務条件による本格スクリーナー
- AIによる投資助言
- 検証できていない投信ページのSEO公開

これらは銘柄同定検索とはデータ要件と説明責任が異なるため、検索・SSR基盤の後に独立機能として設計する。

## 次セッション開始時の指示

次のセッションではこの文書と `AGENTS.md` を読み、まず「1. 統合銘柄モデルと検索正規化」から実装する。計画の再提案だけで止めず、既存の未コミット変更を確認してから実装・lint・build・ブラウザ確認まで進める。Vercel CLIの有無を質問して開始を止めないこと。Vercel操作が必要になった場合だけ、コマンドで利用可否を確認する。
