# 横断分析のデータ整備: 正史ソース選定 & 広域Yahooプリセット（次セッション引き継ぎ）

作成日: 2026-07-23

クロスセクション・ロングショート（`/portfolio` の `pf-cross-sectional-edge`）を「小エッジの棲息域」として
本気で検証するために残っている2つの整備テーマを、次セッションがそのまま着手できる形でまとめる。

- **案A: 正史ソースの選定** — 生存者バイアスを根治する point-in-time データ源を選び、既存の「器」に繋ぐ。
- **案B: より広いYahooプリセット** — ブレッドス（銘柄数）を増やしてICの検出力を上げる。

**この2つは直交する**: 案Bは breadth（検出力）を上げるが survivorship は直さない。案Aは survivorship を直すが breadth は別問題。

---

## 0. 現状（2026-07-23 時点で実装済み）

| 要素 | ファイル | 役割 |
|---|---|---|
| 横断エンジン | `app/lib/cross-sectional-edge.ts` | 毎リバランス日に横断ランク→上位ロング/下位ショートのダラー中立ブック。IC・実効ブレッドス・理論IR(相関ディスカウント済)・楽天実コスト・β・スプレッド壁。`XParams.membership?: Record<string,{from?,to?}>` を受ける。 |
| UI | `app/components/analysis/CrossSectionalEdgeChart.tsx` | ユニバース切替（ウォッチ/プリセット/貼付）、キャッシュ更新/削除UI。 |
| プリセット | `app/lib/universes.ts` | `UNIVERSES: UniverseDef[]`（大型30 / 主要60 / 中型・新興）。`getUniverse(id)`。 |
| 一括取得 | `app/lib/universe-fetch.ts` | `fetchUniverse(tickers, opts)`。3層キャッシュ(メモリ→IndexedDB→Yahoo)。`parseTickerList`。 |
| 価格キャッシュ | `app/lib/price-cache.ts` | IndexedDB永続(8h TTL)。`getCached/putCached/cacheStats/clearCache`。再読込でYahoo再取得ゼロ。 |
| **取り込みの「器」** | `app/lib/constituents.ts` | **実装済・未配線（休眠）**。正史ソースを繋ぐ受け皿。 |

**確定している方針**: データは原則 Yahoo Finance 一本。ユーザーによる個別CSV入力はしない。生存者バイアスは
「隠さず受容」（`survivorWarn` で常時可視化）。データ準備の簡単さを優先。
→ 案A を本格的に進めると「Yahoo一本」から一歩出る（APIキー or 私が用意する同梱データ）ので、採否は要判断。

---

## 1. 「器」の現在のインターフェース（案A・Bとも、最終的にここへ繋ぐ）

`app/lib/constituents.ts`（既存）:

```ts
type MembershipReason = "active" | "index-drop" | "merger" | "delist-zero";

interface MembershipInterval {
  ticker: string; name?: string;
  from: string;            // "YYYY-MM-DD" 組入(発効日)
  to?: string;             // "YYYY-MM-DD" 除外/廃止(発効日)。未指定=現在も在籍
  reason?: MembershipReason;
  terminalPrice?: number;  // merger/delist-zero の終端価格(絶対値・任意)
}

interface ClosePoint { time: string; close: number; }  // 外部(廃止銘柄)価格

// 中核: Yahoo現存分 + 外部廃止銘柄価格をマージし、delist-zero/merger は終端に合成バーを
// 価格系列へ追加（倒産≒0 / 交換価値）。→ エンジンの pricesByTicker + membership にそのまま渡せる。
function applyConstituents(input: {
  pricesByTicker: Record<string, PricePoint[]>;   // Yahoo取得分
  intervals: MembershipInterval[];
  delistedPrices?: Record<string, ClosePoint[]>;  // Yahooに無い廃止銘柄
  delistZeroFraction?: number;                    // 既定0.01（倒産で99%毀損）
}): {
  pricesByTicker; names; membership;              // ← computeCrossSectional にそのまま
  diagnostics; intervals;
};

function parseMembershipCsv(raw): { intervals; errors };      // ticker,from,to,reason,name
function intervalsFromCurrentList(list, from): MembershipInterval[];  // 現構成→active区間
function membersOn(intervals, date): Set<string>;            // as-of メンバー
```

**設計の勝ち筋**: 倒産の終端急落を「価格側の合成バー」に畳んだので、**エンジン(`cross-sectional-edge.ts`)を改修せずに**
倒産損失を損益へ反映できる。どのソースでも `MembershipInterval[]`（+必要なら `delistedPrices`）さえ用意すれば繋がる。

### 未対応の1点（エンジン増分・要実装）
`applyConstituents` は多区間（除外→再追加）を covering `[min from, max to]` に畳み、`diagnostics.multiIntervalTickers`
で警告する。**厳密な再入場ゲート**（ギャップ期間はユニバース外にする）には `cross-sectional-edge.ts` の在籍判定を
`Record<ticker,{from,to}>` から `Record<ticker, {from,to}[]>` へ拡張する小改修が要る（現状の `sp.from/sp.to` 単一区間判定
`line 344付近` を区間リスト対応に）。再入場が稀なら後回し可。

---

## 2. 案A: 正史ソースの選定（生存者バイアス根治）

### 2.1 何が必要か（recap）
1. **時変メンバーシップ**（区間リスト・発効日）: いつユニバース/指数に入り・抜けたか。
2. **「かつて構成銘柄だった全銘柄」の価格**（生存者＋非生存者）: 廃止銘柄は倒産の最後の急落まで。
3. **除外理由の区別**: `delist-zero`(倒産→終端に負) / `merger`(交換価値) / `index-drop`(時価離脱・損益ショックなし)。

**律速は 2（廃止銘柄の価格）**。Yahoo は廃止 `.T` を落とすので、ここをどう埋めるかが分岐点。

### 2.2 候補ソース

| | メンバーシップ履歴 | 廃止銘柄価格 | コスト/認証 | 統合負荷 |
|---|---|---|---|---|
| **A-1 J-Quants（JPX公式API）** | ○(上場/廃止日・区分)。指数構成履歴は要確認 | **○(廃止銘柄含む調整済daily_quotes)** | 無料枠あり・要APIキー(email/pass→refresh/idToken) | 新route + 認証管理 |
| **A-2 Yahoo内廃止銘柄＋同梱スナップショット(lite)** | △(私が近似の入替日を用意) | △(Yahooが残す廃止銘柄のみ・スポット) | Yahooのみ・キー不要 | 私がコード/日付を用意して同梱 |
| A-3 JPX/日経の入替告知(CSV/PDF)手動 | △(イベント単位・手作業) | ✕(価格は別) | 無料だが手作業 | パーサ+価格別途 |
| A-4 有料ベンダー(Bloomberg等) | ○ | ○ | 高コスト | – |

### 2.3 A-1 J-Quants の具体（本命・要doc確認）
- 提供元: JPX Market Innovation。`https://jpx-jquants.com` / API `https://api.jquants.com/v1`。
- 認証フロー: メール/パスワード → `POST /token/auth_user`(refreshToken) → `POST /token/auth_refresh`(idToken, 24h)。
  idToken を各APIの `Authorization: Bearer` に付与。**サーバ側でのみ扱う**（クライアントに鍵を出さない）。
- 主なendpoint: `/listed/info`(銘柄・区分・**上場/廃止情報**)、`/prices/daily_quotes`(調整済日足・**廃止銘柄も歴史的に取得可**)、
  `/markets/trading_calendar`、指数系。**TOPIX/日経の構成履歴が直接取れるか（プラン依存）は現行docsで要確認**。
  取れない場合は `/listed/info` の上場区分＋廃止日から「東証プライム全銘柄の時変ユニバース」を自前構築するのが現実的。
- 無料プランはデータ遅延・履歴期間の制限あり（例: 直近数週間遅延・履歴2年程度、有料で拡張）。**現行の利用規約と枠を必ず確認**。
- 統合の形:
  ```
  app/api/jquants/route.ts        // サーバ: 認証(idToken)キャッシュ + プロキシ。鍵は環境変数。
  app/lib/jquants-source.ts       // fetchMembership(): MembershipInterval[]
                                  // fetchDelistedPrices(tickers): Record<ticker, ClosePoint[]>
  → applyConstituents({ pricesByTicker: <Yahoo現存>, intervals, delistedPrices })
  → computeCrossSectional(applied.pricesByTicker, applied.names, { ..., membership: applied.membership })
  ```
  価格を全部J-Quantsに寄せてもよい（Yahoo不要化）が、まずは「現存=Yahoo / 廃止=J-Quants / 区間=J-Quants」の
  ハイブリッドが最小改修。環境変数: `JQUANTS_EMAIL` / `JQUANTS_PASSWORD`（`.env.local`、Vercelなら env に登録）。

### 2.4 A-2 Yahoo-only 同梱スナップショット(lite)（低摩擦・方針維持）
- **「Yahoo一本・ユーザーCSVなし」を保ったまま器を部分的に活かす**最小案。私（実装者）が次を用意して同梱:
  - ある指数（例: 日経225）の **近似的な入替日付** と、上場廃止/合併銘柄のコード＋`reason`＋`to` を
    `app/lib/constituents-snapshot.ts` に静的定義（`MembershipInterval[]`）。
  - 価格は Yahoo から取得（**Yahoo がまだ保持している廃止銘柄コードはそのまま拾える**）。倒産で価格が取れない銘柄は
    `applyConstituents` の合成終端バー（`delistZeroFraction`）で近似。
- 限界: (1) Yahoo の廃止銘柄カバレッジはスポットで欠落多い、(2) 入替日付が近似、(3) 私の手キュレーションが要る（ユーザー作業ではない）。
  → 「完全な正史」ではないが、**現構成のみ（生存者100%）よりは前進**。`diagnostics.coverage` と `survivorWarn` で正直に度合いを表示。

### 2.5 正しさの罠（どのソースでも）
- **発効日 vs 発表日**: 指数入替は「発表→数週間後に発効」。`from/to` は**発効日**（発表日だと未来情報リーク）。
- **倒産ゼロ vs 合併**: 一律「廃止＝0」は合併で過小評価。`reason`＝`merger` は交換価値、`delist-zero` のみ≒0。
- **証券コード再利用**: 4桁コードは廃止後に別会社へ再割当されうる。長期では `(code, 期間, 名称)` で同定（`name` を保持）。
- **分割・併合**: Yahoo は分割調整済み。J-Quants も調整済 close を使う。

### 2.6 推奨と段階
1. **まず A-2（Yahoo-only lite）** で器を部分稼働させ、`survivorWarn`/`coverage` が改善する様子と、倒産銘柄を含めた
   ときのIC・実コスト後リターンの変化を体感する（方針「Yahoo一本」を崩さない）。
2. 本気で正史が要るなら **A-1 J-Quants**（無料枠→必要なら有料）。APIキー＋サーバrouteの許容が前提。
3. どちらでも **多区間ゲートのエンジン増分**（1章末）を実装すると再入場が正確になる。

---

## 3. 案B: より広いYahooプリセット（ブレッドス増強）

### 3.1 目的
`edge-power.ts` が示す通り、IC の t 値 ≈ IC × √(実効ブレッドス)。**銘柄数を増やすほど小エッジが有意化**する
（実証: 4銘柄 IC t=0.29 → 大型30 IC t=2.15）。survivorship は直らないが、検出力は直線的に上がる。

### 3.2 追加プリセット候補（`app/lib/universes.ts` の `UNIVERSES` に足すだけ）
- **主要100 / 主要150**: 既存 CORE30+EXTRA30 を延長。TOPIX100〜Large70 級の高流動大型。
- **セクター別バスケット**（自動車 / 銀行 / 電機・精密 / 情報通信 / 商社 / 医薬 / 小売…）:
  同業種内で横断すると**セクター要因が相殺**され、より純粋な銘柄選択αになる（β中立が締まる）。1バスケット10〜20本。
- **日経225 現構成 / JPX日経400 現構成**: 大breadth。ただし現構成＝生存者バイアス（案Aと併用推奨）。
- **東証グロース中心の新興バスケット**: 裁定が緩くICが出やすい反面スプレッド壁（`medSpreadBps`/`spreadSurvives` が効く）。

`UniverseDef` 形（既存）:
```ts
interface UniverseDef { id: string; label: string; note: string; tickers: { ticker: string; name: string }[]; }
```

### 3.3 実装手順
1. `universes.ts` に配列を追加し `UNIVERSES` に push（UIの切替ボタンは自動で増える）。
2. **銘柄コードの正しさ**: 実在しない/データ不足コードは取得時に `≥260営業日` フィルタで自動除外されるので、
   多少の間違いは致命的でない（が、過半が無効だと恥ずかしいので主要どころで固める）。
3. **取得負荷**: IndexedDB キャッシュ（`7719ee0`）済みなので**初回だけ**Yahoo取得（100本なら同時実行4で〜50-100秒）、
   以後の再読込は0。100本超でもUI進捗＋キャッシュで許容。必要なら `CONCURRENCY` を下げて更に丁寧に。

### 3.4 留意点
- **survivorship は直らない**: どれも現構成。案A（器＋正史）と組み合わせて初めて正史横断になる。
- **セクターバスケットの利点**: 案Aが無くても「同業種内・現存のみ」なら生存者バイアスの影響が相対的に小さく（同業種の生存確率が近い）、
  かつ市場・セクター要因を落とせる → 実装が軽く効果が見えやすい。**案Bの中ではセクター別を最優先推奨**。

---

## 4. 次セッションの着手チェックリスト

- [ ] （案B・軽） `universes.ts` にセクター別バスケット2〜3種を追加 → breadth と純度を上げる。UIは自動反映。
- [ ] （案B・中） 主要100/150 プリセット追加。first-fetch はキャッシュ後は0なので現実的。
- [ ] （案A・低摩擦） `constituents-snapshot.ts`（日経225の近似入替＋廃止銘柄 `MembershipInterval[]`）を用意し、
      `applyConstituents` を `CrossSectionalEdgeChart` の「正史モード」トグルとして配線（Yahoo価格＋合成終端）。
- [ ] （案A・本命） J-Quants を選ぶなら `app/api/jquants/route.ts`＋`jquants-source.ts`。環境変数と無料枠/遅延を要確認。
- [ ] （エンジン増分） 多区間(再入場)の在籍ゲート: `cross-sectional-edge.ts` の membership を区間リスト化。
- [ ] いずれも `survivorWarn`/`coverage`/`diagnostics` を UI に出し、「どれだけ正史に近いか」を正直に表示。

## 5. 関連ファイル（実体）
- エンジン: `app/lib/cross-sectional-edge.ts`（`XParams.membership`, `computeCrossSectional`）
- 器: `app/lib/constituents.ts`（`applyConstituents`, `MembershipInterval`, `membersOn`, `parseMembershipCsv`）
- プリセット: `app/lib/universes.ts`（`UNIVERSES`, `UniverseDef`, `getUniverse`）
- 取得: `app/lib/universe-fetch.ts`（`fetchUniverse`, `FetchUniverseOptions`）
- キャッシュ: `app/lib/price-cache.ts`（`getCached/putCached/cacheStats/clearCache`, `DEFAULT_TTL_MS`）
- UI: `app/components/analysis/CrossSectionalEdgeChart.tsx`
- 検出力の理論的裏づけ: `app/lib/edge-power.ts`（IR≈IC·√breadth、相関天井）

## 6. 一言で
- **breadth を増やしたい → 案B（まずセクター別バスケット、次に主要100）。survivorshipは直らないと明示。**
- **survivorship を直したい → 案A。低摩擦は A-2(Yahoo-only lite 同梱スナップショット)、正攻法は A-1(J-Quants)。**
- どちらも既存の「器」`applyConstituents` に `MembershipInterval[]`(+`delistedPrices`) を渡すだけで繋がる。
