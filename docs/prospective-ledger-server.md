# 前向き検証台帳のサーバー移行（2026-07-30 実装）

`docs/asset-utilization.md` の優先順位1。エッジ台帳（`prospective-ledger.ts`）と
アナログ予測台帳（`analog-ledger.ts`）の保存先を localStorage から Postgres へ移した。

## なぜやったか

前向き検証（＝仮説を日付ごと凍結し、その時点で存在しなかったデータだけで採点する）の資産は
**時間しか材料にできない**。localStorage 保存では

- 端末を変えれば消える／ブラウザのデータを消せば消える
- 運営側に「いつ何が凍結され、その後どうなったか」の時系列が一切残らない

ため、1年後に「1年前に凍結した予測がどうなったか」という資産が**原理的に生まれない**。
着手を1日遅らせるごとに将来の資産が1日分減る、という性質は他の施策にない。

## 何が変わったか（整合性の面）

サーバー移行は保存場所の変更にとどまらず、検証の担保を2つ**強く**した。

| | 移行前（localStorage） | 移行後（Postgres） |
|---|---|---|
| 凍結日 | クライアントの `new Date()` | **サーバー日付（JST）で上書き**。端末の時計を戻して遡って凍結できない |
| 同一予測の二重記録 | JS 側の重複チェックのみ（改竄可能） | **UNIQUE 制約**（エッジ: owner×ticker×edge_id、アナログ: owner×entry_key） |
| 端末を移る | エクスポート/インポート必須 | 匿名キー（cookie）で引き継ぎ |

例外は旧 localStorage 記録の取り込みで、このときだけ元の凍結日を保ち
`origin='local-import'` として区別する（今日の日付に書き換えると境界が動いて記録の意味が変わるため）。

## 所有者の識別（認証なし）

このアプリに認証は無い。サーバーが発行する UUID を httpOnly cookie
（`ledger_owner`、400日）に持たせて所有者とする。

- ログイン不要のまま、記録は端末に依存せずサーバーに残る
- 別端末で続けるには「端末の引き継ぎ」で復元キー（UUID）を貼り付ける
- `/api/ledger/owner` の POST は**そのキーに記録があるかを答えない**。
  答えると総当たりで他人の記録の有無を探れてしまうため
- キーを知る人は誰でも読み書きできる。UI にその旨を明記している

## 削除

物理削除（`DELETE`）。localStorage 版と同じ挙動で、外れた記録を消せば数字は良くなる。
台帳が自分自身への誠実さにしか担保されない点は変わらないので、
`AnalysisGuide` の注意点にその記載を残してある。

## フォールバック

`POSTGRES_URL` が無い環境（ローカル開発）や API 障害・オフラインでは、
API が 503（`code:"db_unconfigured"` / `"db_error"`）を返し、クライアントは
localStorage に退避して**そのまま凍結・採点できる**。
このとき画面上部の `LedgerSyncBar` が「保存先: このブラウザのみ」と理由を出す。
サーバーが復帰した最初の読み込みで、手元に残っていた記録は一度だけ送られる
（移行フラグ `*-ledger:migrated:v1`、`ON CONFLICT DO NOTHING` で二重登録は起きない）。

**保存先を隠さないことは機能の一部**である。前向き検証は年単位で記録が積み上がって初めて
意味を持つので、「消える保存先」に気づけないまま半年ぶんの記録を失う事態は、
この分析そのものを無価値にする。

## ファイル

| 層 | ファイル |
|---|---|
| DB | `app/lib/ledger-db.ts`（テーブル定義＋CRUD、初回アクセスで自動作成） |
| 所有者 | `app/lib/ledger-owner.ts`（cookie 解決・発行、DB 設定有無の判定） |
| API | `app/api/ledger/{owner,prospective,analog}/route.ts` |
| クライアント窓口 | `app/lib/ledger-store.ts`（サーバー優先・localStorage 退避・一度きりの移行） |
| 純粋ロジック | `prospective-ledger.ts`（`buildFrozenEntry`／採点）、`analog-ledger.ts`（`buildAnalogEntries`／採点） |
| UI | `LedgerSyncBar.tsx`（保存先の開示・復元キー）、`ProspectiveLedgerChart.tsx`、`AnalogLedgerPanel.tsx` |

テーブル（`prospective_ledger` / `analog_ledger`）は `feedback` と同じく初回アクセス時に
`CREATE TABLE IF NOT EXISTS` で作られるので、デプロイ時のマイグレーション作業は不要。

## 残件

- **`/track-record` の公開はまだやらない。** 1ヶ月分の記録では統計的に何も言えず、
  それを「実績」と称するのは本サイトが最も批判している行為そのものになる
  （`asset-utilization.md` 5章）。最低1年、記録が溜まってから。
- 運営者自身が毎週凍結する仕組み（週次 cron）は未実装。公開トラックレコードの前提になる。
