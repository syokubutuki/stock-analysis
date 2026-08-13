# サイト品質改善 ラウンド2 実行手順（Codex 引き継ぎ用）

作成日: 2026-08-11
親文書: `docs/site-improvement-execution-plan.md`（**優先順位・制約・受け入れ条件はそちらが正**）

本書は「次に何を、どの順で、どのフォルダで、どんなプロンプトで投げるか」だけを扱う運用文書。
改善項目の根拠と設計意図は親文書を参照すること。

---

## 0. ラウンド1の結果（2026-08-11 完了・main へマージ済み）

| セッション | 項目 | 結果 |
|---|---|---|
| S1 | B1 待機リスト / B2 Pro訴求 | 完了。`/api/waitlist` + Postgres。JS無効でも動く progressive enhancement |
| S2 | Q1 数値書式 / U3 セレクタ / U4 品質パネル位置 / A1(部分) | 完了。`app/lib/format.ts` 新設。**ただし U4 は基本節の1画面しか直っておらず、2026-08-14 に `233da2f` で全節ぶんを是正**（親文書 §11 FU17） |
| S3 | Q2 フォント / Q3 トークン / R3a OG / R4 sitemap | 完了。システムフォント採用（転送量増ゼロ） |
| S4 | M1 CI / P3 負荷調査 | 完了。GitHub Actions 稼働。P3 は下記の重要な結論を出した |

マージ後の main（`d8fb975`）で `npm run lint`（0エラー / 272警告）と `npm run build` の通過を確認済み。

### P3 の結論（ラウンド2の設計を左右する）

- **F35 の「30秒応答不能」は再現しなかった。**（拡張なし headless Edge、7203.T 10年、3回試行）
  当初の観測はブラウザ自動化環境の影響だった可能性が高い
- ただし **229–269ms の Long Task を 3/3 回再現**
- 主因は **`scanWeekdayEdges` のメインスレッド実行**（単体 132–147ms、ブートストラップ込み）。
  `analyzeAtoms` は 1–3ms、Canvas 描画は数ms級で無関係
- 6か月（126点）では Long Task なし（78–82ms）。**データ量に比例する**

**したがって**: U1 は全パネルの重い事前計算を採らない。U2 は全件一括マウントを避ける。
`scanWeekdayEdges` の Worker 化が第一候補（既存 Worker 15本のパターンが使える）。

---

## 1. ラウンド2で投げるもの

依存関係の都合で **2波に分ける**。

### 第1波 — 今すぐ4本並列（相互に衝突なし）

| # | セッション | 項目 | 専有ファイル |
|---|---|---|---|
| S5 | 価格ペイロード | **P1** 価格丸め + `SANITIZER_VERSION` | `app/lib/stock-data.server.ts`, `app/lib/price-sanity.ts` |
| S6 | 投信修復 | **R0**（`NEXT_SESSION.md` §4） | `app/lib/stock-source.server.ts`, `app/lib/fixtures/` |
| S7 | コントラスト | **A1** 残り（`page.tsx` 系を除く） | `app/components/` 配下（下記の除外リスト以外） |
| S8 | ナビ | **U5** セクション名 + **A2** title解消 | `app/page.tsx` |

### 第2波 — 第1波マージ後

| # | セッション | 項目 | 前提 |
|---|---|---|---|
| S9 | **R2** ガイド移植 | まず1本で見積り。`app/sitemap.ts` を触るので S10 と順次 |
| S10 | **R1** `/t/[ticker]` | `NEXT_SESSION.md` §5。`sitemap.ts` で S9 と衝突 |
| S11 | **M2** 回帰テスト | M1 完了済みなので着手可 |
| S12 | **U1** 結果バッジ | P3 の結論を前提に設計から |

### 意図的に後回しにするもの

- **P2 段階取得** — P1 の実測を見てから。効果が出れば不要（親文書 V3）
- **A3 Canvas 代替テキスト / A4 色符号化** — 独立だが優先度が下
- **R3b 銘柄別OG** — R1 必須
- **M3 レジストリ化** — 全部の後

---

## 2. worktree の準備

**未コミットがあると worktree から参照文書が見えない**（ラウンド1で実際に起きた）。
下のスクリプトは、その状態なら worktree を作らずに中断する。

```bash
cd C:/Users/hikar/next/stock-analysis

if [ -n "$(git status --porcelain)" ]; then
  echo "中断: 未コミットの変更があります。worktree から見えないので先にコミットしてください。"
  git status --short
else
  for pair in "sa-s5:feat/price-round" "sa-s6:feat/fund-fix" \
              "sa-s7:feat/contrast"    "sa-s8:feat/nav-labels"; do
    dir="../${pair%%:*}"; br="${pair##*:}"
    git worktree add "$dir" -b "$br" && (cd "$dir" && npm install)
  done
  echo "完了。参照文書の存在を確認します:"
  for d in sa-s5 sa-s6 sa-s7 sa-s8; do
    n=0
    for f in AGENTS.md CLAUDE.md NEXT_SESSION.md \
             docs/site-improvement-execution-plan.md docs/site-improvement-round2.md; do
      [ -f "../$d/$f" ] && n=$((n+1))
    done
    echo "  ../$d : 5文書中 $n 個"
  done
fi
```

**5/5 にならなければ投入しないこと。**

作成後に main が進んだ場合は、各 worktree で `git merge main --no-edit` して追従させる
（Codex セッションが動いていない間に行うこと）。

### ラウンド1で踏んだ失敗（繰り返さないこと）

1. **計画書を git にコミットせずに worktree を作った** → worktree から計画書が見えず、
   Codex が「指定ファイルが存在しない」で止まった。
   **worktree を作る前に、参照させたい文書を必ずコミットしておくこと。**
2. **worktree の削除が Windows で失敗する** → Codex のターミナルが該当フォルダを
   cwd にしたままだと `Permission denied` になる。
   **セッションを閉じてから `git worktree remove` すること。**
3. **同じ文書を複数ブランチが独自にコミットすると add/add 衝突になる**。
   進捗表の更新は競合しやすい。**本ラウンドでは進捗表を Codex に更新させない**
   （下記プロンプトからは外してある）。マージ後に人間側でまとめて更新する。

---

## 3. 各セッションのプロンプト

### 共通ひな形（各プロンプトの冒頭に含める）

```
このリポジトリ（Next.js 16 App Router の株価分析サイト）の改善作業を担当してほしい。

## 最初に読む（順番厳守）
1. AGENTS.md
2. CLAUDE.md
3. docs/site-improvement-execution-plan.md の §0 / §1.3 / §2 / §6 / §7 / §9

§6（共通制約）と §9（やってはいけないこと）は必ず守ること。

**これらのファイルが見つからない場合は、作業を始めずに即座に報告すること。**
親リポジトリを探しに行ったり、記憶や推測で補ったりしないこと。
worktree の作成手順に不備がある状態なので、環境側を直す必要がある。

## 並列作業中である
他のセッションが別ファイルを同時に編集している。
下の「専有ファイル」以外は読んでよいが、絶対に編集しないこと。
編集が必要だと判断したら、勝手にやらずに止めて報告すること。

## 進捗表について
docs/site-improvement-execution-plan.md の §11 進捗表は**更新しないこと**。
複数セッションが同じ表を書き換えると衝突するため、マージ後に人間側でまとめて更新する。

## 進め方
- 実装方法は任せる。計画書は制約と受け入れ条件だけを定めている
- 計画書の記述と実際のコードが食い違ったら、コードを正として報告する
- 迷う判断は勝手に決めず、選択肢と推奨を挙げて確認すること
- 完了したら npm run lint → npm run build → ブラウザ確認
- コミットは日本語・1コミット1目的（AGENTS.md 準拠）
- git add -A は使わない。パスを明示して add すること
- 最後に、変更の要約・未検証項目・判断が割れた箇所を報告すること
```

---

### S5 — 価格ペイロード削減（P1）

```
作業ディレクトリ: C:/Users/hikar/next/sa-s5
ブランチ: feat/price-round

［共通ひな形をここに貼る］

## 担当
docs/site-improvement-execution-plan.md の P1（価格ペイロードの削減）。
§3 の P1 の節を熟読すること。制約が多い。

## 専有ファイル
- app/lib/stock-data.server.ts
- app/lib/price-sanity.ts

## 背景（実測値）
- /api/stock?ticker=7203.T&range=10y の応答は 343,549 バイト / 2,463点
- 価格が 16桁の浮動小数で配信されている（例: close: 866.4223022460938）
- 有効数字を落とさない丸めだけで概算3〜4割の削減が見込める（未実測）

## 絶対に守る制約
1. CLAUDE.md 最優先規約: 価格は /api/stock 経由、修復は repairPriceGlitches() が唯一の地点。
   **丸めは修復の後段で行うこと。** 修復判定を丸めた値で行ってはならない
2. **SANITIZER_VERSION を必ず上げること。**
   app/lib/price-cache.ts:39 が IndexedDB キャッシュを sanitizerVersion で無効化している。
   配信値の表現を変えると、旧キャッシュ（丸め前）と新データ（丸め後）が混在し、
   同じ銘柄で数値が食い違う。これは CLAUDE.md と AGENTS.md の両方に明記された規約
3. **固定小数桁は避けること。** 低位株・低位投信で有効桁を失う。有効数字ベースにする
4. app/lib/price-sanity.ts 冒頭の設計思想と過去の誤検出事故を、触る前に必ず読むこと

## 受け入れ条件
1. /api/stock の応答バイト数が 343,549 から有意に減少（削減率を報告に記載）
2. SANITIZER_VERSION が更新されている
3. 7203.T で、丸め前後の年率σ・最大DD・βが実用上同一（差分を報告に記載）
4. 低位価格の銘柄で有効桁が失われていない
5. 1306.T（過去に価格破損があった銘柄）で dataQuality の検出結果が変わっていない
6. npm run lint と npm run build が通る

## 検証
- 7203.T / 8306.T / 1306.T / 米国株1銘柄
- 投信は F36 のため価格取得が壊れている。検証できない。試さないこと
- 削減率は実測すること（親文書 §8 の V2 が未実測のまま）
```

---

### S6 — 投信価格アダプター修復（R0）

```
作業ディレクトリ: C:/Users/hikar/next/sa-s6
ブランチ: feat/fund-fix

［共通ひな形をここに貼る］

## 担当
docs/site-improvement-execution-plan.md の R0。
**実装仕様は NEXT_SESSION.md §4 を正とする。** そちらを必ず読むこと。

## 専有ファイル
- app/lib/stock-source.server.ts
- app/lib/fixtures/

## 性質
これは改善ではなく**不具合修正**。現在ユーザー向けに機能が死んでいる。
app/lib/stock-source.server.ts:77 が旧方式（履歴ページHTMLから jwtToken を抽出し
x-jwt-token ヘッダーで旧BFFへ）のままだが、Yahoo の投信履歴ページが Next.js/RSC 形式に
変わり、期待する jwtToken と mainFundPriceBoard が HTML に存在しない。

## 重要
- 「Yahoo全体でJWTが廃止された」と断定しないこと。
  旧HTML→JWT→BFF の手順が成立しなくなったというだけである
- 安定した履歴APIが確認できなければ、RSC埋め込みデータの直接パースは
  **壊れやすい暫定実装として隔離し、fixture を用意する**
- 安定して取得できないなら priceSupported: false の維持でよい。
  **「直せない」という結論も成果として認める。その場合は理由と調査済みの範囲を記録すること**
- **時間を区切ること。** 調査が発散したら、判明した事実だけ記録して止める
- 価格は必ず /api/stock 経由。repairPriceGlitches / SANITIZER_VERSION /
  dataQuality / DataQualityNotice の規則を維持

## 注意
別セッション（S5）が app/lib/stock-data.server.ts と app/lib/price-sanity.ts で
SANITIZER_VERSION を変更している。**それらのファイルには触らないこと。**
型の共有変更が必要になったら止めて報告すること。

## 受け入れ条件
NEXT_SESSION.md §4「実装判断」に従う。加えて:
1. 投信1銘柄で価格が取得でき既存パネルが描画される、**または**
   取得できないことが確認され priceSupported: false 維持の理由が記録されている
2. 暫定実装になる場合、fixture が app/lib/fixtures/ に置かれている
   （既存の yahoo-fund-history.json の隣）
3. npm run lint と npm run build が通る
```

---

### S7 — コントラスト是正（A1 残り）

```
作業ディレクトリ: C:/Users/hikar/next/sa-s7
ブランチ: feat/contrast

［共通ひな形をここに貼る］

## 担当
docs/site-improvement-execution-plan.md の A1 の**残り**。
§1.3 の「訂正3」を必ず読むこと。ここに罠が書いてある。

## 専有ファイル
- app/components/ 配下（ただし下記の除外あり）

## 除外（既に別セッションが実施済み。触らないこと）
- app/page.tsx
- app/components/analysis/SeriesModeSelector.tsx
- app/layout.tsx / app/globals.css / app/sitemap.ts

## 背景（実測値）
- text-gray-400 (#9ca3af) は白背景でコントラスト比 約2.85:1。WCAG AA（4.5:1）未達
- リポジトリ全体で 896箇所（うち page.tsx の4箇所と SeriesModeSelector の2箇所は対応済み）
- text-gray-500 にすれば白背景で約4.8:1、bg-gray-50 上でも約4.6:1 で AA を満たす

## 絶対に守る制約
1. **無条件の一括置換は禁止。** 896箇所には暗色背景（bg-slate-900 等）上の使用が
   含まれ、そこでは現状が正しい。**背景色で絞り込むこと**
2. 非テキスト（境界線・アイコン・プレースホルダ）には AA 4.5:1 は適用されない。区別すること
3. Canvas 内にハードコードされた #9ca3af / #94a3b8 が別途 386箇所ある。
   **これは本項目の対象外**（クラス置換では届かない。別項目として残す）
4. app/globals.css に S3 が定義したトークンがある
   （--color-fg-body: #364153 / --color-fg-muted: #4a5565）。
   これを参照する形にできるなら望ましいが、素の Tailwind クラスでも可。
   **globals.css 自体は編集しないこと**

## 受け入れ条件
1. 白／gray-50 背景上の本文テキストがすべて 4.5:1 以上
2. 暗色背景上のテキストが退行していない（目視確認した画面を報告に列挙）
3. 置換対象の絞り込み条件を報告に明記
4. 変更件数と、意図的に除外した件数・理由を報告
5. npm run lint と npm run build が通る

## 検証
7203.T で全24セクションをざっと開き、暗色カードを持つ画面を重点的に確認すること。
```

---

### S8 — セクション名と title 解消（U5 + A2）

```
作業ディレクトリ: C:/Users/hikar/next/sa-s8
ブランチ: feat/nav-labels

［共通ひな形をここに貼る］

## 担当
docs/site-improvement-execution-plan.md の U5（セクション名を目的語ベースに）と
A2（title 依存の解消）。この2つは同じ場所を触るので同時に行う。

## 専有ファイル
- app/page.tsx

## 背景
- 24個のセクションタブが「量子力学的」「非線形動力学」「情報理論」など**手法名**で、
  利用者の質問（今買っていいか / どれくらい下がりうるか / この傾向は本物か）と乖離している
- タブの説明（app/page.tsx:1410 付近）が **title 属性にしか無い**。
  title はタッチデバイスで表示されず、キーボードでも多くのブラウザで出ない。
  **モバイル利用者は24タブが何なのか永久に知らない**
- リポジトリ全体で title= は397箇所あるが、**本項目の対象はセクションタブのみ**

## 絶対に守る制約（互換性・§6.5）
1. **SECTIONS の key（= URL の sec= の値）を変更しないこと。**
   B-1 で共有されたURL（?sec=quantum 等）が壊れる
2. **パネルID を変更しないこと。** ?panel=... と localStorage の sa:open:<id> が壊れる
3. **手法名を消さないこと。** 副題として残す（growth-strategy.md C-3 の方針）。専門性は資産
4. localStorage の sa:section に保存された既存の値が引き続き復元できること

## 参考（growth-strategy.md C-3 の案。そのまま採用しなくてよい）
  リスク・テイルリスク → 「どれだけ下がりうるか」
  カレンダー          → 「いつ買って、いつ降りるか」
  エッジ              → 「その優位性は本物か」
  分布・非線形・量子  → 「値動きの癖を見る」（上級）

## 受け入れ条件
1. 既存の共有URL（?sec=quantum 等）が引き続き同じ節を開く
2. タブの説明がホバー以外の手段でも読める
3. 手法名が失われていない
4. モバイル幅（375px）で説明が読めることを確認
5. 24タブが縦に伸びすぎてファーストビューを潰さないこと
6. npm run lint と npm run build が通る

## 注意
app/page.tsx は 2,188行ある。全体を書き換えず、該当箇所だけを最小限に変更すること。
```

---

## 4. マージと片付けの手順

```bash
# 1. 各 Codex セッションを閉じる（開いたままだと worktree 削除が失敗する）

# 2. マージ（衝突が少ない順）
cd C:/Users/hikar/next/stock-analysis
git merge feat/price-round --no-edit
git merge feat/fund-fix    --no-edit
git merge feat/contrast    --no-edit
git merge feat/nav-labels  --no-edit

# 3. 統合検証
npm run lint && npm run build

# 4. 片付け
git worktree remove ../sa-s5 && git worktree remove ../sa-s6
git worktree remove ../sa-s7 && git worktree remove ../sa-s8
git worktree prune
git branch -d feat/price-round feat/fund-fix feat/contrast feat/nav-labels

# 5. 進捗表（§11）を人間側でまとめて更新
```

---

## 5. フォローアップ（ラウンド1から持ち越し）

親文書 §11 のフォローアップ表を正とする。要約:

| # | 内容 | 状態 |
|---|---|---|
| FU1 | **待機リストの実DB検証**。ローカルに `.env` が無くDBはVercel上のみ。デプロイ後に `/pricing` から登録 → `GET /api/waitlist?token=…` | **デプロイ直後に必須** |
| FU2 | 待機リスト API のレート制限。Vercel WAF / BotID で足りる可能性 | 中 |
| FU3 | `npm run lint` の既存272警告の解消。CI は警告で落とさない設定なので急がない | 低 |
| FU4 | J8（台帳を Pro 訴求に）を活かす新機能の設計 | 低・未設計 |
| FU5 | **OG画像が 1,026 KB と過大**。1200×630 は正しいが RGBA 無圧縮。JPEG 品質85 で 100–150KB 程度に落ちる見込み。git に永久に残るので早めが良い | 中 |
| FU6 | `app/lib/format.ts` の `formatCurrency` / `formatPercent` / `formatShares` が未使用。`formatCurrency` は非JPYを一律 `$` にしており、EUR/GBP で誤る。使う前に直すか削除する | 低 |
| FU7 | サマリーカードの桁が「2,914.5」と「3,452.59」のように依然ばらつく可能性。ルールは統一されたが見た目は不揃い。実機で確認し、許容するか固定桁にするか判断する | 低・要目視 |
| FU8 | `/pricing` が静的prerenderから動的（ƒ）に変わった。待機リストの `?waitlist=` を読むため。意図通りなら問題ないが認識しておく | 情報 |

---

## 変更履歴

| 日付 | 内容 |
|---|---|
| 2026-08-11 | 初版。ラウンド1（S1〜S4）のマージ完了を受けて作成 |
