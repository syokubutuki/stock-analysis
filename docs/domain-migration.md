# kabugenron.com ドメイン移行

作成日: 2026-07-31

## 目的と正規URL

- 正規URL: `https://kabugenron.com`
- `www.kabugenron.com`: 正規URLへ恒久リダイレクト
- 移行元: `https://stock-analysis-self.vercel.app`
- Vercelプロジェクト: `stock-analysis`

URL構造とコンテンツは変えず、ホスト名だけを移す。サイト移行と同時に画面改修や
ルート変更を行わない。

## Phase 1: 匿名データの引き継ぎ

- [x] `/domain-migration` を追加
- [x] `ledger_owner` を既存の `/api/ledger/owner` で新ホストへ再設定
- [x] 未同期台帳、ウォッチリスト、表示設定を許可リスト方式でコピー
- [x] 復元キーをURLへ載せず、送受信元を固定した `postMessage` を使用
- [x] 旧・新ホストに移行通知と引き継ぎ導線を表示
- [x] 本番の旧・新ホスト間で引き継ぎを確認

旧ホストのCookieとlocalStorageは新ホストから読めない。したがって旧ホストを即時301に
せず、引き継ぎ導線を先に公開する。移行完了後も旧データは削除しない。

## Phase 2: SEOとURLの一元化

- [x] `app/lib/site-url.ts` に公開URLを集約
- [x] `metadataBase`、Open Graph URL、sitemap、robots sitemapを新URLへ変更
- [x] 公開ルートへ自己参照canonicalを追加
- [x] `noindex` の `/feedback` をsitemapから除外
- [x] 旧ホストに `X-Robots-Tag: noindex, follow` を付与
- [x] 旧ホストから同一パスの新ホストへ恒久リダイレクト

旧ホストは同じパスとクエリを維持して301転送する。CookieとlocalStorageを引き継ぐため、
`/domain-migration` とその配下だけは旧ホストで公開し続ける。

## Phase 3: DNSとVercel

- [x] Vercel Project Settingsへ `kabugenron.com` と `www.kabugenron.com` を追加
- [x] Vercelが提示するA/CNAME/TXTをCloudflareへ設定（ProxyはDNS only）
- [x] 両ホストのTLSと `Valid Configuration` を確認
- [x] `www` からapexへの301リダイレクトを設定

Cloudflareのネームサーバーは維持する。一般値を決め打ちせず、Vercel Dashboardまたは
`vercel domains inspect` が示す値を使う。

2026-07-31 時点でVercelが要求しているレコード:

```text
A  @    76.76.21.21  DNS only
A  www  76.76.21.21  DNS only
```

## Phase 4: 検証とカットオーバー

- [x] `npm run lint`
- [x] `npm run build`
- [x] preview deploymentでcanonical・sitemap・robotsを確認
- [x] デスクトップと狭い画面で移行画面を確認
- [x] 株価取得、検索、台帳保存・復元、データ品質表示を確認
- [x] previewでcanonical、sitemap、robotsを確認
- [x] 本番デプロイ後にエラーログを確認

2026-08-01 に全体の `npm run lint` がエラー0件で成功した。警告は段階的に解消する既存課題として残す。

期待するHTTP結果:

```text
https://kabugenron.com/portfolio                         200
https://www.kabugenron.com/portfolio                     301 -> https://kabugenron.com/portfolio
https://stock-analysis-self.vercel.app/portfolio         301 -> https://kabugenron.com/portfolio
https://stock-analysis-self.vercel.app/domain-migration  200（告知期間中のみ）
```

## Phase 5: Search Console

- [x] 旧ホストを301へ変更し、同一パスとクエリが維持されることを本番で確認
- [x] `kabugenron.com` のDomainプロパティをDNS TXTで確認
- [x] 旧URLのURLプレフィックスプロパティを同じGoogleアカウントで所有者確認
- [x] 新しい `/sitemap.xml` を送信
- [x] 旧プロパティからアドレス変更を申請
- [x] 主要URLをURL検査
- [ ] 旧・新のインデックス、検索流入、404を180日以上監視

2026-08-01 に apex 200、www / 旧ホスト 301、旧ホストの `/domain-migration` 200、canonical・robots・sitemap、Vercel のエラー / 500 ログなしを本番で確認した。

### 2026-08-01 実施結果

- Domainプロパティ `kabugenron.com` は確認済み所有者で、確認方法は「ドメイン名プロバイダ」。既存のDNS TXT確認が有効だったため、CloudflareのDNSレコードは追加・変更していない。
- 旧URLプレフィックスプロパティ `https://stock-analysis-self.vercel.app/` は、既存のHTMLタグにより同じGoogleアカウントで自動確認された。
- `https://kabugenron.com/sitemap.xml` は2026-07-31送信・最終読み込み済みで、ステータス「成功しました」、検出ページ数4件を確認した。重複送信はしていない。
- 旧プロパティから `kabugenron.com` へのアドレス変更を申請した。Search Console上の開始日は2026-08-01で、状態は「このサイトは現在移行中です」。
- URL検査結果:
  - `https://kabugenron.com/`: 「URL は Google に登録されています」「ページはインデックスに登録済みです」。
  - `https://kabugenron.com/axioms`: 「検出 - インデックス未登録」。サイトマップは認識済み、前回のクロールは該当なし。
  - `https://kabugenron.com/portfolio`: 「検出 - インデックス未登録」。サイトマップは認識済み、前回のクロールは該当なし。
  - `https://kabugenron.com/strategy`: 「検出 - インデックス未登録」。サイトマップは認識済み、前回のクロールは該当なし。

未登録の3 URLは、サイトマップ経由のクロールとインデックス推移を監視する。今回のURL検査ではインデックス登録リクエストを送信していない。

設定順序:

1. Search ConsoleでDomainプロパティ `kabugenron.com` を追加する。
2. Search Consoleが発行したTXT値をCloudflare DNSのapex（名前は `@`）へ追加し、所有権を確認する。確認後もTXTは削除しない。
3. 同じGoogleアカウントで旧URLプレフィックスプロパティ `https://stock-analysis-self.vercel.app/` の所有権を確認する。
4. 新プロパティの「サイトマップ」から `sitemap.xml` を送信し、ステータスが「成功」になることを確認する。
5. 旧プロパティの「設定」から「アドレス変更」を開き、移行先として `kabugenron.com` を選ぶ。
6. 新プロパティのURL検査で `/`、`/axioms`、`/portfolio`、`/strategy` を検査し、必要ならインデックス登録をリクエストする。

Googleのアドレス変更ツールは301リダイレクトを前提に事前チェックする。旧プロパティが未確認で、
Google Analyticsによる確認も使えない場合は、
Search Consoleが発行するHTML確認ファイルを旧ホストでリダイレクト対象外にして所有権を確認する。

恒久リダイレクトは最低1年、可能なら無期限で維持する。

## ロールバック

1. 旧ホストの恒久リダイレクトを解除する。
2. 直前の正常なVercel deploymentをpromoteする。
3. Search Consoleのアドレス変更後180日以内なら申請をキャンセルする。
4. DNSは削除せず、新ホストを復旧確認用に維持する。
