# サイト品質改善 ラウンド3 実行手順（Codex 引き継ぎ用）

作成日: 2026-08-11
親文書: `docs/site-improvement-execution-plan.md`（**優先順位・制約・受け入れ条件はそちらが正**）
前ラウンド: `docs/site-improvement-round2.md`

本書は「次に何を、どの順で、どのフォルダで、どんなプロンプトで投げるか」だけを扱う運用文書。

---

## 0. ラウンド2の結果（2026-08-11 完了・main `ea49e58` へマージ済み）

| セッション | 項目 | 結果 |
|---|---|---|
| S5 | P1 価格ペイロード削減 | 完了。`toPrecision(8)` を修復の**後段**に。`SANITIZER_VERSION` 2→3。**実測 23.0%削減** |
| S6 | R0 投信アダプター修復 | 完了。旧JWT経路を残し、失敗時のみ RSC 退避。fixture 同梱。**実取得は未検証** |
| S7 | A1 コントラスト | 完了。190ファイル・868箇所を `text-fg-muted` へ。白背景 **7.56:1**（AAA超） |
| S8 | U5 セクション名 / A2 title解消 | 完了。`key` 23個は全て不変。手法名は副題として保持 |

マージ後の main で `npm run lint`（0エラー / 272警告）と `npm run build` 通過を確認済み。
ビルド後CSSに `.text-fg-muted{color:#4a5565}` が生成されていることも確認済み。

### ラウンド2で判明した重要な数値

**P1 の削減率は 23.0%**（343,262 → 264,278 B）。当初見積り「3〜4割」には届かなかった。
有効8桁が保守的なため。桁数別の実測は以下（FU10 の判断材料）。

| 有効桁 | サイズ | 削減率 | 887.1215820312 の丸め結果 | 相対誤差 |
|---|---|---|---|---|
| 8（現行） | 264,278 B | 23.0% | 887.12158 | 2.3e-9 |
| 7 | 254,798 B | 25.8% | 887.1216 | 2.0e-8 |
| 6 | 245,315 B | 28.5% | 887.122 | 4.7e-7 |
| 5 | 235,832 B | 31.3% | 887.12 | 1.8e-6 |
| 4 | 217,666 B | 36.6% | 887.1 | 2.4e-5 |

日次σは概ね 2e-2。6桁でも相対誤差は4桁下で、統計量への影響は無視できる。
**ただし価格データの保守性は本プロジェクトの最優先規約なので、桁を減らすかはオーナー判断。**

---

## 1. ラウンド3で投げるもの

ラウンド1・2は「小さく独立した項目」だったが、ここからは**設計判断を伴う大物**に入る。
性質が変わるので、**まず設計セッションを1本走らせてから実装に入る**ものがある。

### 第1波 — 今すぐ3本並列

| # | セッション | 項目 | 専有ファイル | 性質 |
|---|---|---|---|---|
| S9 | 回帰テスト基盤 | **M2** | `package.json`, `app/lib/__tests__/` 等（新規）, `AGENTS.md` | 実装 |
| S10 | ガイド移植 | **R2**（まず1本で見積り） | `app/lib/analysis-guides.ts`, 対象パネル1本, `app/guide/` | **計測が先** |
| S11 | デプロイ後検証 | **FU9** 投信実取得 + **FU10** 桁数判断 | 調査のみ（結論次第で `stock-source.server.ts` / `instruments.ts`） | 検証 |

### 第2波 — 第1波の結果を見てから

| # | 項目 | 前提 |
|---|---|---|
| S12 | **R1** `/t/[ticker]` SSR（`NEXT_SESSION.md` §5） | S10 と `sitemap.ts` で衝突するため順次 |
| S13 | **U1** パネル結果バッジ | P3 の結論を前提に**設計から**。1セクションで試作 |
| S14 | **R3b** 銘柄別OG | R1 必須 |

### 後回し（優先度順）

`FU11`/`FU12`（コントラストの残り・Canvas 386箇所）→ `A3` Canvas代替テキスト →
`A4` 色以外の符号化 → `P2` 段階取得（FU10 と併せて判断）→ `M3` レジストリ化（最後）

---

## 2. worktree の準備

**未コミットがあると worktree から参照文書が見えない**（ラウンド1で実際に起きた）。
下のスクリプトはその状態なら worktree を作らずに中断する。

> ### ⚠ シェルを間違えないこと
>
> **この環境の既定ターミナルは PowerShell である。下の bash スクリプトを
> PowerShell に貼ると `$dir` / `$br` が展開されず、`$dir` という名前のフォルダと
> `$br` というブランチがリポジトリ内部に作られる**（2026-08-11 に実際に発生）。
>
> - **PowerShell を使うなら → 後述の「PowerShell 版」を使う**
> - bash 版は Git Bash / WSL でのみ使う
>
> どちらで実行したか分からなくなったら `git worktree list` と `git branch` を確認し、
> `$dir` や `$br` があれば下記で除去する:
> ```
> git worktree remove '$dir' --force; git worktree prune; git branch -D '$br'
> ```

### bash 版（Git Bash / WSL）

```bash
cd C:/Users/hikar/next/stock-analysis

if [ -n "$(git status --porcelain)" ]; then
  echo "中断: 未コミットの変更があります。worktree から見えないので先にコミットしてください。"
  git status --short
else
  for pair in "sa-s9:feat/regression-tests" "sa-s10:feat/guide-migration" \
              "sa-s11:feat/post-deploy-verify"; do
    dir="../${pair%%:*}"; br="${pair##*:}"
    git worktree add "$dir" -b "$br" && (cd "$dir" && npm install)
  done
  echo "完了。参照文書の存在を確認します:"
  for d in sa-s9 sa-s10 sa-s11; do
    n=0
    for f in AGENTS.md CLAUDE.md NEXT_SESSION.md \
             docs/site-improvement-execution-plan.md docs/site-improvement-round3.md; do
      [ -f "../$d/$f" ] && n=$((n+1))
    done
    echo "  ../$d : 5文書中 $n 個"
  done
fi
```

### PowerShell 版（この環境の既定シェル）

```powershell
Set-Location C:\Users\hikar\next\stock-analysis

if (git status --porcelain) {
  Write-Host "中断: 未コミットの変更があります。worktree から見えないので先にコミットしてください。"
  git status --short
} else {
  $pairs = @(
    @{ Dir = '..\sa-s9';  Branch = 'feat/regression-tests' },
    @{ Dir = '..\sa-s10'; Branch = 'feat/guide-migration' },
    @{ Dir = '..\sa-s11'; Branch = 'feat/post-deploy-verify' }
  )
  foreach ($p in $pairs) {
    git worktree add $p.Dir -b $p.Branch
    if ($?) { Push-Location $p.Dir; npm install; Pop-Location }
  }

  Write-Host "`n完了。参照文書の存在を確認します:"
  $docs = @(
    'AGENTS.md', 'CLAUDE.md', 'NEXT_SESSION.md',
    'docs/site-improvement-execution-plan.md', 'docs/site-improvement-round3.md'
  )
  foreach ($p in $pairs) {
    $n = ($docs | Where-Object { Test-Path (Join-Path $p.Dir $_) }).Count
    "  {0} : 5文書中 {1} 個" -f $p.Dir, $n
  }
}
```

**3本とも 5/5 にならなければ投入しないこと。**

---

## 3. 各セッションのプロンプト

### 共通ひな形（各プロンプトの冒頭に含める）

```
このリポジトリ（Next.js 16 App Router の株価分析サイト）の改善作業を担当してほしい。

## 最初に読む（順番厳守）
1. AGENTS.md
2. CLAUDE.md
3. docs/site-improvement-execution-plan.md の §0 / §1.3 / §2 / §6 / §7 / §9
4. docs/site-improvement-round3.md の §0（前ラウンドの結果）

§6（共通制約）と §9（やってはいけないこと）は必ず守ること。

**これらのファイルが見つからない場合は、作業を始めずに即座に報告すること。**
親リポジトリを探しに行ったり、記憶や推測で補ったりしないこと。

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

### S9 — 数値計算の回帰テスト基盤（M2）

```
作業ディレクトリ: C:/Users/hikar/next/sa-s9
ブランチ: feat/regression-tests

［共通ひな形をここに貼る］

## 担当
docs/site-improvement-execution-plan.md の M2（数値計算の回帰テスト基盤）。
§3 の M2 の節を熟読すること。

## 専有ファイル
- package.json（scripts と devDependencies の追加）
- テストファイルとフィクスチャ（配置は任せる。既存の app/lib/fixtures/ の隣が自然）
- AGENTS.md（「Testing Guidelines」の節のみ）
- .github/workflows/ci.yml（テスト実行ステップの追加のみ）

## なぜやるか
app/lib は 281ファイル・約7万行の数値計算コードだが、**自動テストが0件**である。
CLAUDE.md 冒頭に「1点のスケール破損で市場βが 1.10 → 0.05 に潰れる」と自ら記録
しているのに、その事故を検出する自動テストが存在しない。
壊れたことに気づく手段が目視しかない状態を解消するのが目的。

## スコープ（重要）
**全関数を網羅しない。** 壊れたときの影響が大きいものから。優先順位:

1. app/lib/price-sanity.ts の repairPriceGlitches()
   → CLAUDE.md が名指しする最重要地点。**過去の事故ケース（1306.T のスケール破損、
     β 1.10→0.05）を回帰テストとして固定すること。** これが本項目の中核
2. app/lib/stock-data.server.ts の価格丸め（2026-08-11 に追加された toPrecision(8)）
   → 丸めが統計量を壊していないことの固定
3. app/lib/strategy-vs-benchmark.ts → 8箇所から使われる共通コスト規約
4. その他、複数パネルから参照されている中核関数

**最低5関数**を覆えば受け入れ条件を満たす。欲張らないこと。

## 方式
- **黄金値（golden value）方式を推奨。** 固定フィクスチャに対する出力を記録し、
  変化したら検知する。数式の正しさの証明ではなく、**意図しない変化の検知**が目的
- 乱数を使う関数（ブートストラップ・順列検定）はシード固定が必要。
  既存コードに mulberry32 のシード付きRNGを使っている箇所がある（流用可）
- テストランナーの選定は任せる。**ただし npm run build を壊さないこと**
- 既存の app/lib/fixtures/yahoo-fund-history.json と
  yahoo-fund-history-rsc.json がフィクスチャの前例

## 受け入れ条件
1. npm test（名称は任意）で実行できる
2. price-sanity.ts の過去事故ケースが回帰テストとして固定されている
3. 最低5つの中核関数が黄金値テストで覆われている
4. .github/workflows/ci.yml でテストが自動実行される
5. AGENTS.md の「Testing Guidelines」が更新されている
   （現在「専用のテストディレクトリと自動テストランナーは現状ありません」と書かれている）
6. npm run lint と npm run build が通る

## 注意
CI は既に稼働している（Node 24 / npm ci / lint / build）。
lint には既存272警告があるが 0エラーなので通る。**この状態を壊さないこと。**
```

---

### S10 — 分析ガイドの移植（R2・まず1本で見積り）

```
作業ディレクトリ: C:/Users/hikar/next/sa-s10
ブランチ: feat/guide-migration

［共通ひな形をここに貼る］

## 担当
docs/site-improvement-execution-plan.md の R2（分析解説ページの拡充）。
**§1.3 の「訂正2」を必ず読むこと。ここに最大の誤解が書いてある。**

## このセッションの目的は「20本移植」ではない
**まず1本だけ移植して、所要時間と手順を確定させること。**
親文書 §8 の V4 が「1本あたりの移植コストが未計測」のまま残っている。
1本終えた時点で報告し、20本の見積りを更新する。**そこで一旦止まってよい。**

## 専有ファイル
- app/lib/analysis-guides.ts
- 移植対象パネルのコンポーネント1本
- app/guide/ 配下
- app/sitemap.ts

## 背景（重要な前提）
- AnalysisGuide を持つコンポーネントは **289本**、公開ガイドページは **8本**
- **自動生成はできない。** AnalysisGuide の props は { title, children: ReactNode } のみで、
  中身は各コンポーネントに直接書かれた**自由形式のJSX散文**
- 一方 analysis-guides.ts は AnalysisGuideEntry という**完全な構造化スキーマ**を持つ
  （method / formulas / terms / example / reading / investmentUse / limitations …）
- 既存8本は、このスキーマに**手で書き起こされたもの**

## 絶対に守る制約
1. **二重管理を作らないこと。** asset-utilization.md §5 の禁止事項:
   「ガイド本文を手でコピーしてページ化する → 二重管理になり必ず片方が腐る。
   **データに分離してから1ソースで両方描く**」
   → 移植したガイドは、/guide/[slug] とパネル内 AnalysisGuide の**両方が
   同じ AnalysisGuideEntry を描画する**形にすること
2. **AI で薄く増やさないこと。** 同 §5:「thin content 判定でドメイン全体が沈む」。
   現在の価値は「7点セットが全部埋まっている密度」にある。
   移植で情報量を減らさないこと
3. CLAUDE.md の「新しい分析には AnalysisGuide を必ず付ける」規約は維持

## 移植対象の選び方
利用頻度の高いパネルが望ましい。panel_open イベントの実績が Vercel Analytics で
見られるなら参考にしてよい（親文書 §8 の V11 は未確認のまま）。
見られなければ、既存8本のガイドが扱っていない主要分析から1本選び、理由を報告すること。

## 受け入れ条件（1本目）
1. 対象パネルの AnalysisGuide が AnalysisGuideEntry から描画されている（本文の二重管理なし）
2. /guide/[slug] が同じデータから生成されている
3. ガイド ⇄ パネルの相互リンクがある
4. sitemap.ts に反映されている
5. 移植前後で情報量が減っていない（7点セットが揃っている）
6. **所要時間の実測と、20本に展開した場合の見積りを報告すること**
7. npm run lint と npm run build が通る

## 注意
app/sitemap.ts は R1（/t/[ticker]）でも編集される。
本セッションが先に入るので、R1 側が後で追従する。
```

---

### S11 — デプロイ後の検証（FU9・FU10）

```
作業ディレクトリ: C:/Users/hikar/next/sa-s11
ブランチ: feat/post-deploy-verify

［共通ひな形をここに貼る］

## 担当
docs/site-improvement-execution-plan.md §11 のフォローアップ FU9 と FU10。
**主たる成果はコードではなく検証結果である。**

## 専有ファイル
- app/lib/stock-source.server.ts（FU9 の結論が「取れる」場合のみ）
- app/lib/instruments.ts（同上。priceSupported の変更のみ）
- app/lib/stock-data.server.ts（FU10 の結論が「桁を減らす」場合のみ）
- docs/site-improvement-round3.md（検証結果の追記）

**いずれも「結論が出てから」触ること。まず検証を先に行う。**

---

## FU9: 投信の実取得検証

### 背景
2026-08-11 に R0 で、投信履歴の取得に RSC 埋め込みデータへの退避経路を追加した
（app/lib/stock-source.server.ts、コミット f8570cb）。
旧JWT経路を残し、それが失敗したときだけ RSC を試す構造になっている。
**しかし本番で実際に価格が取得できるかは未検証。**

### やること
1. 本番（https://kabugenron.com）で投信コードを指定して /api/stock を叩き、
   価格が返るか確認する。投信コードは app/lib/instruments.ts のカタログにある
2. 取得できた場合:
   - 複数銘柄・複数期間で安定するか確認
   - app/lib/instruments.ts の priceSupported を true に戻すべきか判断する
   - **安定性に確信が持てなければ false のままでよい**。壊れやすい暫定実装である旨は
     コード内コメントに明記されている
3. 取得できなかった場合:
   - エラーの内容と、どの経路（JWT / RSC）で失敗したかを特定する
   - **「取れない」も正しい結論である。** その場合 priceSupported: false を維持し、
     判明した事実を記録する

### 制約
- 価格は必ず /api/stock 経由（CLAUDE.md 最優先規約）
- repairPriceGlitches / SANITIZER_VERSION / dataQuality / DataQualityNotice の規則を維持
- Yahoo に大量アクセスしないこと。数銘柄で足りる

---

## FU10: 価格の有効桁の再検討

### 背景
P1 で toPrecision(8) を導入し、実測 23.0% 削減（343,262 → 264,278 B）。
当初見積り「3〜4割」には届かなかった。桁数別の実測は
docs/site-improvement-round3.md §0 の表にある。

### やること
1. 表の数値を本番で再確認する（P1 適用後の現在値を実測）
2. 桁を減らした場合に統計量が実質的に変わらないことを確認する。
   最低限: 7203.T の年率σ・最大DD・β・シャープ比を 8桁 / 6桁で比較
3. 変更するかどうかを**推奨とともに報告する**

### 判断の前提
- 日次σは概ね 2e-2。6桁の相対誤差 4.7e-7 は4桁下で、統計量への影響は無視できる
- **ただし価格データの保守性は本プロジェクトの最優先規約である**（CLAUDE.md 冒頭）。
  「影響が無視できる」と「変更してよい」は別問題
- **勝手に変更しないこと。** 数値を出して推奨を述べ、判断を仰ぐこと
- 変更する場合は SANITIZER_VERSION を必ず上げる（3 → 4）

## 受け入れ条件
1. FU9 の結論（取得可否・priceSupported の扱い）が根拠とともに記録されている
2. FU10 の統計量比較が実データで示されている
3. コードを変更した場合、SANITIZER_VERSION の扱いが正しい
4. npm run lint と npm run build が通る
5. 検証結果が docs/site-improvement-round3.md に追記されている
```

---

## 4. マージと片付けの手順

bash / PowerShell のどちらでもそのまま動く（変数展開を使っていないため）。

```bash
# 1. 各 Codex セッションを閉じる（開いたままだと worktree 削除が失敗する）

cd C:/Users/hikar/next/stock-analysis
git merge feat/regression-tests   --no-edit
git merge feat/guide-migration    --no-edit
git merge feat/post-deploy-verify --no-edit

npm run lint && npm run build

git worktree remove ../sa-s9 && git worktree remove ../sa-s10 && git worktree remove ../sa-s11
git worktree prune
git branch -d feat/regression-tests feat/guide-migration feat/post-deploy-verify

# 進捗表（§11）を人間側でまとめて更新
```

---

## 5. フォローアップ一覧（親文書 §11 が正）

| # | 内容 | 状態 |
|---|---|---|
| FU1 | 待機リストの実DB検証 | **一部完了**。書き込み経路は確認済み。行数確認は要オーナートークン |
| FU2 | 待機リスト API のレート制限 | 未 |
| FU3 | lint の既存272警告 | 未（CIは警告で落ちないので急がない） |
| FU4 | J8（台帳を Pro 訴求に）の新機能設計 | 未設計 |
| FU5 | OG画像の圧縮 | **完了**（1,026→135KB） |
| FU6 | `format.ts` の未使用関数・非JPYの `$` 決め打ち | 未 |
| FU7 | サマリーカードの桁の見た目 | 未（要目視） |
| FU8 | `/pricing` が動的化 | 情報のみ |
| FU9 | **投信の実取得検証** | **S11 で対応** |
| FU10 | **価格の有効桁の再検討** | **S11 で対応** |
| FU11 | A1 の残46箇所（装飾アイコン＋`app/axioms/page.tsx`） | 未 |
| FU12 | Canvas 内ハードコード灰色 **386箇所** | 未 |

---

## 変更履歴

| 日付 | 内容 |
|---|---|
| 2026-08-11 | 初版。ラウンド2（S5〜S8）のマージ完了を受けて作成 |
