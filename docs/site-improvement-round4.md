# サイト品質改善 ラウンド4 実行手順（Codex 引き継ぎ用）

作成日: 2026-08-12
親文書: `docs/site-improvement-execution-plan.md`（**優先順位・制約・受け入れ条件はそちらが正**）
前ラウンド: `docs/site-improvement-round3.md`（**§3.5 に S11 の検証結果。必読**）

本書は「次に何を、どの順で、どのフォルダで、どんなプロンプトで投げるか」だけを扱う運用文書。

---

## 0. ラウンド3の結果（2026-08-12 完了・main へマージ済み）

| セッション | 項目 | 結果 |
|---|---|---|
| S9 | M2 回帰テスト基盤 | 完了。**63テスト / 20スイート / 全通過**。新規依存ゼロ |
| S10 | R2 ガイド移植 | 完了。**20本移植し計28本**。`GuideEntryPanel` で1ソース化 |
| S11 | FU9 投信検証 / FU10 桁数判断 | 完了。**検証の結果、前提が2つ覆った**（下記） |

統合後の main で `npm test`（63/63）・`npm run lint`（0エラー / 272警告）・`npm run build` の通過を確認済み。

### ラウンド3で覆った前提 — 次のラウンドの判断が変わる

**① P1 の実効果は 23.0% ではなく 42.0% だった**

本番は `content-encoding: br` を返す。生JSONではなく**圧縮後**で測るのが正しい。

| | 生JSON | brotli |
|---|---|---|
| P1 前 | 343,186 B | **81,892 B** |
| P1 後（8桁） | 263,244 B | **47,514 B（−42.0%）** |
| 6桁にした場合 | 244,243 B | 38,711 B（追加 −18.5%＝8.8 KB） |

**含意**: 実転送は10年系列で **47.5 KB**。263 KB ではない。
→ **P2（段階取得）の見送りを支持する材料**。節約できるのは 47.5 KB の一部にすぎない。

**② 投信は壊れていなかった**

F36 が記録した「JWT経路の故障」は現時点で**再現しない**（配信側が復旧したと見られる）。
4銘柄×4期間で正常取得を確認済み。R0 の RSC 退避は保険として残っている。

さらに、計画書が前提にしていた「`priceSupported: false` を維持」は**誤り**だった。
実コードには `false` が1件も存在せず、全件 `true` 固定である。

**③ FU10 は「8桁で確定」（2026-08-14 オーナー判断）**

**この項目は決着した。以後 Codex は再検討しないこと。**
理由は削減幅（8.8 KB）に対し、`SANITIZER_VERSION` 更新が
**client IndexedDB とサーバー Runtime Cache を同時破棄**し、削減分が再取得で相殺されるため。
判断を覆す唯一の条件は、転送量が問題であるという実測証拠が出たとき（中間案は7桁）。

---

## 1. ラウンド4で投げるもの

### 第1波 — 今すぐ2本並列

| # | セッション | 項目 | 専有ファイル | 規模 |
|---|---|---|---|---|
| S12 | 銘柄別SSRルート | **R1** `/t/[ticker]`（`NEXT_SESSION.md` §5） | `app/t/`（新規）, `app/sitemap.ts`, 必要なら `app/lib/` の読み取り専用ヘルパ | **大** |
| S13 | 投信の表示整合 | **FU14** RSC退避条件 + **FU17** 投信での無意味な分析 + **FU16** 死んだ分岐 | `app/lib/stock-source.server.ts`, `app/components/TickerSearchInput.tsx`, 対象分析コンポーネント | 中 |

**S12 と S13 は `stock-source.server.ts` で衝突しない**（S12 は読み取りのみ）。
ただし S12 が `getStockData()` の呼び出し方を変える必要が出たら、止めて報告させること。

### 第2波 — 第1波マージ後

| # | 項目 | 前提 |
|---|---|---|
| S14 | **R3b** 銘柄別OG画像 | R1 必須。**日本語フォント同梱が必要**（`next/og` は CJK を内蔵しない） |
| S15 | **U1** パネル結果バッジ | P3 の結論（`scanWeekdayEdges` が 229–269ms のLong Task）を前提に**設計から** |

### 第3波 — アクセシビリティのまとめ取り

| # | 項目 |
|---|---|
| S16 | **FU11**（A1 の残46箇所＋`app/axioms/page.tsx`）+ **FU12**（Canvas 386箇所）+ **A4**（色以外の符号化） |

Canvas 内の色は `A3`（代替テキスト）とも領域が重なる。**まとめて1セッションにする方が効率が良い。**

### 明示的に見送るもの

- **P2 段階取得** — 実転送が 47.5 KB と判明したため。§0 の①を根拠に**見送りを推奨**
- **M3 レジストリ化** — 引き続き最後

---

## 2. worktree の準備

> ### ⚠ シェルを間違えないこと
> **この環境の既定ターミナルは PowerShell である。** bash 版を PowerShell に貼ると
> `$dir` / `$br` が展開されず、リポジトリ内部に不正な worktree が作られる（2026-08-11 に発生）。
> 誤作成したら: `git worktree remove '$dir' --force; git worktree prune; git branch -D '$br'`

### PowerShell 版（この環境の既定シェル）

```powershell
Set-Location C:\Users\hikar\next\stock-analysis

if (git status --porcelain) {
  Write-Host "中断: 未コミットの変更があります。worktree から見えないので先にコミットしてください。"
  git status --short
} else {
  $pairs = @(
    @{ Dir = '..\sa-s12'; Branch = 'feat/ticker-route' },
    @{ Dir = '..\sa-s13'; Branch = 'feat/fund-display' }
  )
  foreach ($p in $pairs) {
    git worktree add $p.Dir -b $p.Branch
    if ($?) { Push-Location $p.Dir; npm install; Pop-Location }
  }

  Write-Host "`n完了。参照文書の存在を確認します:"
  $docs = @(
    'AGENTS.md', 'CLAUDE.md', 'NEXT_SESSION.md',
    'docs/site-improvement-execution-plan.md',
    'docs/site-improvement-round3.md', 'docs/site-improvement-round4.md'
  )
  foreach ($p in $pairs) {
    $n = ($docs | Where-Object { Test-Path (Join-Path $p.Dir $_) }).Count
    "  {0} : 6文書中 {1} 個" -f $p.Dir, $n
  }
}
```

### bash 版（Git Bash / WSL のみ）

```bash
cd C:/Users/hikar/next/stock-analysis
if [ -n "$(git status --porcelain)" ]; then
  echo "中断: 未コミットの変更があります。"; git status --short
else
  for pair in "sa-s12:feat/ticker-route" "sa-s13:feat/fund-display"; do
    dir="../${pair%%:*}"; br="${pair##*:}"
    git worktree add "$dir" -b "$br" && (cd "$dir" && npm install)
  done
fi
```

**6/6 にならなければ投入しないこと。**

---

## 3. 各セッションのプロンプト

### 共通ひな形（各プロンプトの冒頭に含める）

```
このリポジトリ（Next.js 16 App Router の株価分析サイト）の改善作業を担当してほしい。

## 最初に読む（順番厳守）
1. AGENTS.md
2. CLAUDE.md
3. docs/site-improvement-execution-plan.md の §0 / §1.3 / §2 / §6 / §7 / §9
4. docs/site-improvement-round4.md の §0（前ラウンドで覆った前提。**必読**）
5. docs/site-improvement-round3.md の §3.5（投信と価格桁の検証結果）

§6（共通制約）と §9（やってはいけないこと）は必ず守ること。

**これらのファイルが見つからない場合は、作業を始めずに即座に報告すること。**
親リポジトリを探しに行ったり、記憶や推測で補ったりしないこと。

## テストがある（2026-08-12 から）
npm test で 63件の回帰テストが走る。**壊さないこと。**
価格・統計まわりを触ったら必ず実行すること。
テストが落ちたら、テストを直す前に「実装とテストのどちらが正しいか」を報告すること。

## 並列作業中である
他のセッションが別ファイルを同時に編集している。
下の「専有ファイル」以外は読んでよいが、絶対に編集しないこと。
編集が必要だと判断したら、勝手にやらずに止めて報告すること。

## 進捗表について
docs/site-improvement-execution-plan.md の §11 進捗表は**更新しないこと**。
マージ後に人間側でまとめて更新する。

## 進め方
- 実装方法は任せる。計画書は制約と受け入れ条件だけを定めている
- 計画書の記述と実際のコードが食い違ったら、コードを正として報告する
  （ラウンド3で実際に2件見つかった。計画書は完全ではない）
- 迷う判断は勝手に決めず、選択肢と推奨を挙げて確認すること
- 完了したら npm test → npm run lint → npm run build → ブラウザ確認
- コミットは日本語・1コミット1目的（AGENTS.md 準拠）
- git add -A は使わない。パスを明示して add すること
- 最後に、変更の要約・未検証項目・判断が割れた箇所を報告すること
```

---

### S12 — 銘柄別 SSR ルート `/t/[ticker]`（R1）

```
作業ディレクトリ: C:/Users/hikar/next/sa-s12
ブランチ: feat/ticker-route

［共通ひな形をここに貼る］

## 担当
docs/site-improvement-execution-plan.md の R1。
**実装仕様は NEXT_SESSION.md §5 を正とする。** そちらを必ず読むこと。

## 専有ファイル
- app/t/（新規）
- app/sitemap.ts
- 必要なら app/lib/ に読み取り専用のヘルパを新設（既存ファイルの変更は要相談）

**app/page.tsx は触らないこと。** 既存のクライアント画面は壊さない。

## なぜやるか
本番HTMLに分析コンテンツが1文字も入っていない（トップの可読テキストは免責文のみ）。
クロール可能なURLは現在 sitemap に 11件（ガイド28本の反映後はもっと増える）。
244パネル分の情報のうち検索エンジンが見られるのは実質ゼロである。

## 前提は既に整っている（ここが重要）
- **銘柄解決基盤は完成済み**。`app/lib/instruments.ts` / `instrument-search.ts` /
  `instrument-resolver.ts` に canonical ticker ⇄ Yahoo symbol の変換がある
- **共有価格キャッシュも完成済み**。`app/lib/stock-data.server.ts` が
  Vercel Runtime Cache（fresh 8時間・保持7日）を持つ。
  **100銘柄を生成しても Yahoo を100回叩かずに済む**
- したがって NEXT_SESSION.md §1〜§3 は完了済み。**いきなり §5 から着手できる**

## 絶対に守る制約
1. **thin content を作らないこと。** growth-strategy.md A-1 の警告:
   「数千URL作るなら、各URLに固有の数字が本文として載っていることが必須条件」。
   **サーバー側で実測サマリーをHTMLに出すこと**（NEXT_SESSION.md §5 に項目の列挙がある:
   銘柄名・コード・基準日・現在値・期間リターン・ボラティリティ・最大DD）
2. **法務上の制約。** 特定銘柄の数値をサーバーレンダリングで提示するページになる。
   app/components/Disclaimer.tsx の免責を各銘柄ページでも確実に出すこと。
   app/lib/tiers.ts 冒頭の設計方針と整合させ、
   **「買い」「売り」と読める文言を生成しないこと**
3. Server Component から getStockData() を直接使い、
   **ブラウザ経由で /api/stock を自己呼び出ししないこと**（NEXT_SESSION.md §5）
4. 価格は必ず /api/stock 相当の経路（CLAUDE.md 最優先規約）。
   repairPriceGlitches / SANITIZER_VERSION / dataQuality の規則を維持
5. **既存の共有URL（/?ticker=...）と重複コンテンツを作らないこと。**
   canonical または正規化の方針を明示すること

## 投信の扱い（ラウンド3で判明した注意）
投信は取得できる（FU9 で確認済み）が、以下の性質がある:
- **OHLC が全て基準価額と等しく volume=0**。ローソク足は横線になる
- **10年レンジは初回 8.0秒**（ページングで約95往復。キャッシュ MISS 時）
→ **初期の生成対象は株式・指数に絞ることを推奨。** 投信を含めるなら
  ビルド時間とタイムアウトを実測してから決めること。

## 段階的に進めること
NEXT_SESSION.md §5 は「初期公開は主要100銘柄」としているが、同節に
「少数でビルド挙動を確認してから対象を増やす」ともある。
**まず5〜10銘柄で動かし、ビルド時間を実測してから100銘柄へ広げること。**

## 受け入れ条件
NEXT_SESSION.md「受け入れ確認 / SSR」に従う。加えて:
1. JS無効でも銘柄名と複数の実測数値を含むHTMLが返る
2. generateMetadata で銘柄別の title / description / canonical が出る
3. 免責が銘柄ページにも表示される
4. sitemap に「実際に表示・価格取得できる銘柄だけ」が入る
5. ビルド時間の実測値を報告する（5〜10銘柄時と、最終的な件数での両方）
6. npm test / npm run lint / npm run build が通る
```

---

### S13 — 投信まわりの表示整合（FU14 / FU16 / FU17）

```
作業ディレクトリ: C:/Users/hikar/next/sa-s13
ブランチ: feat/fund-display

［共通ひな形をここに貼る］

## 担当
docs/site-improvement-execution-plan.md §11 のフォローアップ FU14・FU16・FU17。
**まず docs/site-improvement-round3.md §3.5 を読むこと。** 3件ともそこが出典。

## 専有ファイル
- app/lib/stock-source.server.ts（FU14）
- app/components/TickerSearchInput.tsx（FU16）
- FU17 の対象となる分析コンポーネント（下記で特定してから）

**app/lib/stock-data.server.ts と price-sanity.ts は触らないこと**（回帰テストの対象）。

---

## FU14: JWT経路が「途中で」失敗したとき RSC へ退避しない（**本セッションの最優先**）

### 事実
R0 で追加した RSC 退避の分岐は `stock-source.server.ts` の
「HTMLに `jwtToken` が無いとき」（`if (!pageData)`）**だけ**である。
`jwtToken` は取れたが BFF が 403 / 期限切れ / 異常レスポンスを返す形の故障では、
退避せずそのまま失敗する。

### これは机上の懸念ではない — 本番で発生した
**2026-08-14 に `GET /api/stock?ticker=03311187&range=1mo` が 500 を返した。**
直後の再試行では同銘柄・全4投信（`03311187` / `0331418A` / `2931113C` / `9C311125`）とも
200 で、一過性の障害だった。原因は未特定。

**重要なのは「退避が効かないと、一過性の上流障害がそのままユーザーの 500 になる」ことが
実証された点である。** 投信は取得経路が長い（ページングで最大95往復）ぶん、
一過性障害を踏む確率が株式より高い。

F36（2026-08-01 に記録された故障）は現在再現しないが、
**再発の形によっては R0 の保険が効かない。**

### やること
BFF 呼び出しが失敗した場合にも RSC 経路へ退避できるようにする。
**一過性障害（5xx・タイムアウト）でユーザーに 500 を返さないことがゴール。**

### 制約
- **JWT経路を優先する現在の順序は変えないこと。** RSC はあくまで保険
- 退避を無制限に繰り返さないこと（1回で打ち切る等）
- 退避したことがログで分かるようにすること（`console.warn` は既存の logSanity と同様の作法）
- 価格は必ず repairPriceGlitches / dataQuality の規則を通ること
- 既存の fixture（yahoo-fund-history.json / yahoo-fund-history-rsc.json）を活用してよい
- **RSC 側も同時に落ちている場合は素直に失敗させること。** 無限リトライで
  Yahoo に負荷をかけない。既存の `s-maxage=3600` の stale fallback がどこまで
  効くかも確認し、報告に含めること

---

## FU16: 死んだ分岐の扱い

### 事実
`TickerSearchInput.tsx` の「価格取得は調整中」表示（`priceSupported: false` の分岐）は
**どの銘柄でも発火しない**。`instruments.ts` も `api/search/route.ts` も
`priceSupported: true` を固定で返しているため。

### やること
残すか削除するかを決めて実行する。**どちらでもよいが理由を残すこと。**
- 残す場合: 将来の非対応銘柄に備える意図をコメントに明記する
- 削除する場合: 関連する型・表示・分岐をまとめて消す

---

## FU17: 投信で無意味になる分析

### 事実
投信は **OHLC が全て基準価額と等しく、volume=0** である（元データの性質。バグではない）。
そのため以下が意味を持たない:
- ローソク足（横線になる）
- 出来高系のすべて（VPT / OBV / MFI / 出来高プロファイル / RVOL など）
- 日中系（日中レンジ・ギャップ・髭・Close Position など）

現状は無意味な結果をそのまま表示している。

### やること
**まず影響範囲を調べて報告すること。** 全部直そうとしないこと。

1. `app/page.tsx` の各節から、投信で無意味になるパネルを列挙する
2. 対処方針を選ぶ（**実装前に報告して確認を取ること**）:
   - (a) 該当パネルに注意書きを出す（最小・非破壊）
   - (b) 投信では該当パネルを非表示にする（`page.tsx` の変更が要る＝要相談）
   - (c) データ側で判定できる共通ヘルパを作り、各パネルが参照する
3. **推奨は (a) または (c)。** (b) は `app/page.tsx` を触るため、
   別セッションと衝突する可能性がある。採るなら事前に相談すること

### 判定方法のヒント
`StockData` に投信かどうかの情報があるか、`isFundCode()` が使えるか、
あるいは「全バーで open==high==low==close かつ volume==0」で判定できるかを調べること。
**銘柄種別で分岐するより、データの性質で判定するほうが頑健**な可能性がある。

---

## 受け入れ条件
1. FU14: BFF 失敗時にも RSC へ退避する。退避の有無がログで分かる
2. FU16: 残す/削除の判断が実行され、理由が記録されている
3. FU17: 影響範囲の一覧と方針が報告されている（実装は方針確認後でよい）
4. npm test（63件）が通る
5. npm run lint / npm run build が通る

## 検証用の銘柄
- 投信: `0331418A`（eMAXIS Slim オルカン）/ `03311187`（S&P500・名前に & を含む）
- 株式: `7203.T`（対照群。投信向けの変更が株式を壊していないこと）
```

---

## 4. マージと片付けの手順

```bash
# 1. 各 Codex セッションを閉じる（開いたままだと worktree 削除が失敗する）

cd C:/Users/hikar/next/stock-analysis
git merge feat/ticker-route  --no-edit
git merge feat/fund-display  --no-edit

npm test && npm run lint && npm run build

git worktree remove ../sa-s12 && git worktree remove ../sa-s13
git worktree prune
git branch -d feat/ticker-route feat/fund-display

# 進捗表（§11）を人間側でまとめて更新
```

---

## 5. 未処理のフォローアップ（親文書 §11 が正）

| # | 内容 | 状態 |
|---|---|---|
| FU1 | 待機リストの行数確認（要オーナートークン） | 一部完了 |
| FU2 | 待機リスト API のレート制限 | 未 |
| FU3 | lint の既存272警告 | 未（CIは警告で落ちない） |
| FU4 | J8 を活かす新機能の設計 | 未設計 |
| FU6 | `format.ts` の未使用関数・非JPYの `$` 決め打ち | 未 |
| FU7 | サマリーカードの桁の見た目 | 未（要目視） |
| FU10 | 価格の有効桁 | **推奨は据え置き。オーナーの最終確認待ち** |
| FU11 | A1 の残46箇所＋`app/axioms/page.tsx` | **S16 で対応予定** |
| FU12 | Canvas 内ハードコード灰色 386箇所 | **S16 で対応予定** |
| FU14 | RSC 退避条件 | **S13 で対応** |
| FU15 | 投信10年が初回8.0秒 | 未（S12 の設計に影響） |
| FU16 | 死んだ分岐 | **S13 で対応** |
| FU17 | 投信で無意味な分析 | **S13 で対応** |

---

## 変更履歴

| 日付 | 内容 |
|---|---|
| 2026-08-12 | 初版。ラウンド3（S9〜S11）のマージ完了を受けて作成 |
