# L3 設計書 ─ デリスク規則（stress-hyst）のアプリ配線

作成日: 2026-10-23
親文書: `docs/wealth-roadmap-2026-10.html` §3 L3（改善計画の長期レーン）
根拠: `docs/bank-derisk-research.md`（結論・頑健性・限界）、`research/bank-derisk/`（Python 実装）
状態: **P0（計算層・テスト・Python 照合）は `15eeec3` でコミット済。P1（パネル）は `5cd6e35` でコミット済。P2（頑健性 Worker）・P3（横断版 `pf-derisk`）実装済（2026-10-23〜24・未コミット）。**

---

## §0 コールドスタート用の前提（この節だけで着手できる状態にする）

**新しいセッションはここから読む。**

### 0.1 何を作るか（1段落）

研究で唯一、長期OOS・ランダム配置ヌル・コスト感度・別銘柄の4関門を通った規則
「4つのストレス指標のうち2つ以上が点灯したら翌営業日の寄りから全額現金、全指標が5営業日連続で消灯したら復帰」を、
個別銘柄ページの `regime` 節に **1パネル `regime-derisk`** として配線する。
出力は①次の立会日の建玉（保有／現金）と4灯の現在値・閾値までの距離、②現金化区間を重ねた価格とエクイティ、
③ルール vs 買い持ちの成績（時代別・コスト感度）、④現金化エピソード表、⑤頑健性（ランダム配置ヌル・ブートCI、オンデマンド）。
計算層は純粋関数にし、後の S2（寄り前ブリーフ・cron）からサーバー側でも同じ関数を呼べる形にする。

### 0.2 いまどこまで出来ているか

| 層 | 状態 | 実体 |
|---|---|---|
| 規則の発見・検証 | ✅ 完了（2026-10-20） | `research/bank-derisk/r9_grid.py`（972設定）・`r13_variants.py`（最終規則 `stv()`/`hyst()`）・`r14_robust.py`（ヌル・別銘柄・ブート）・`r15_final.py`（コスト感度・局面別・現在の状態）・`r16_vshape.py`（V字対策7変種が全て不成立） |
| 長期データの取得 | ✅ 研究側のみ | `research/bank-derisk/fetch_max.mts`（2000年〜、`repairPriceGlitches({ticker})` 通過済み）。**アプリの `/api/stock` は 10y 上限**（L6 で拡張予定） |
| asof 整合の TS 実装 | ✅ 手本あり | `app/lib/cross-asset-lead.ts` `alignFeature()`・`app/lib/us-spillover-core.ts` `alignJpUs()`（「日付が厳密に小さい最新の行」） |
| 計算層 `app/lib/derisk-rule.ts` | ✅ P0 完了（2026-10-23） | `derisk-rule.ts`・`asof-align.ts`。純粋関数 |
| パネル `DeriskRuleChart.tsx` | ✅ P1 完了（2026-10-23） | `regime-derisk`（regime 節・`all+ticker`・caution）。A〜D・F・G を実装 |
| 頑健性 Worker（E） | ✅ P2 完了（2026-10-23） | `derisk-robust.ts`（純粋関数）・`derisk-rule.worker.ts`。ボタンで起動。結果は §7.4 |
| テスト・Python 照合 | ✅ P0/P2 完了 | `__tests__/derisk-rule.test.ts`（20件）・`derisk-robust.test.ts`（12件・乱数列込みの黄金値）・`fixtures/derisk-golden.json`（383KB）・`export_fixture.py`・`check-lib.mts`（頑健性の分位照合を含む）。結果は §7 |
| 横断版 `pf-derisk`（/portfolio） | ✅ P3 完了（2026-10-24） | `derisk-cross.ts`（純粋関数・テスト8件）・`DeriskCrossChart.tsx`。`app/portfolio/page.tsx` に `pf-risk` の直前で常設。結果は §7.5 |
| 通知・ブリーフ | ⬜ 範囲外（S2） | 本書は純粋関数の形だけ保証する |

### 0.3 着手前に片付けること

- `research/bank-derisk/data_max/` と `data/` は **未追跡**（`git status` で `??`）。テストの黄金値はここから生成するが、
  CSV 自体はコミットしない。§4.2 の生成スクリプトで **小さな JSON フィクスチャ**を作ってそれをコミットする。
- `git add -A` は使わない（ユーザーの並行作業が作業ツリーに現れる）。pathspec で明示する。
- Vercel デプロイ版で確認する（ローカルは DB パスが動かない。本パネルは DB を使わないが規約として）。

### 0.4 ファイルの地図

```
app/lib/derisk-rule.ts                     ← 新規。計算層（純粋関数。§2）
app/lib/derisk-robust.ts                   ← 新規。頑健性の計算層（ランダム配置ヌル・定常ブロックブート。純粋関数。§2.7）
app/lib/derisk-rule.worker.ts              ← 新規。derisk-robust を Worker で呼ぶだけ（§2.7）
app/lib/asof-align.ts                      ← 新規（小）。「日付が厳密に小さい最新の行」の共通関数（§2.2）
app/components/analysis/DeriskRuleChart.tsx ← 新規。パネル本体（§3）
app/lib/panel-registry.tsx                 ← 1レコード追加（§3.1）
app/lib/__tests__/derisk-rule.test.ts      ← 新規。合成系列＋黄金値（§4）
app/lib/__tests__/derisk-robust.test.ts    ← 新規。配置制約・分位・植込み暴落の向き＋固定シードの黄金値
app/lib/derisk-cross.ts                    ← 新規。横断版の計算層（共通2灯の取り出し・並び・集計。P3）
app/components/analysis/DeriskCrossChart.tsx ← 新規。/portfolio `pf-derisk`（P3）
app/lib/__tests__/derisk-cross.test.ts     ← 新規。横断固有の部分だけ（並び・集計・判断日の多数派・投信/行数不足）
app/portfolio/page.tsx                     ← `pf-derisk` を items に追加（レジストリ非経由。/portfolio は page 直書き）
app/lib/__tests__/fixtures/derisk-golden.json ← 新規。Python から生成（§4.2）
research/bank-derisk/export_fixture.py     ← 新規。黄金値の生成（§4.2）
research/bank-derisk/check-lib.mts         ← 新規。data_max 全期間での TS/Python 照合（§4.3、npm test 外）
app/lib/__tests__/fixtures/panel-ids.golden.ts ← 並び順込みで1行追加（§3.1）
```

### 0.5 再利用できる既存 export

```ts
// app/hooks/useBenchmarkPrices.ts
useBenchmarkPrices(ticker): { prices, name, loading, error, dataQuality }   // ^VIX と KRE を2回呼ぶ
fetchBenchmarkPrices(ticker): Promise<CacheEntry>                           // フック外（Worker 投入前の一括取得）

// app/lib/price-sanity.ts
describeSanityReport(report)   // ベンチマーク側の修復開示（CrossAssetLeadChart.tsx:141 と同じ使い方）

// app/components/analysis/StrategyVsBenchmark.tsx
<StrategyVsBenchmark mode="returns" strategyDaily buyHoldDaily spreadRT roundTrips … />   // コスト後の見出し行

// app/lib/spread-estimator.ts
representativeSpread(prices)   // 上の spreadRT

// app/components/analysis/AccordionSection.tsx
useAnalysisResultSummary(id, { status: "finding", direction, label })   // 見出しバッジ（判断だけ・量は出さない）

// app/components/analysis/EdgeDecayChart.tsx
3ペイン同期（subscribeVisibleLogicalRangeChange）・価格線は init 時に一度生成・更新時は removePriceLine

// app/lib/__tests__/helpers/{golden,rng}.ts
golden() / assertGolden() / mulberry32 / makeNormal
```

### 0.6 決めてあること（再検討しない）

| 論点 | 決定 | 根拠 |
|---|---|---|
| 規則のパラメータ | **固定**: VIX比 1.25 / ボラ比 1.8 / dd60 −12% / KRE dd60 −12% / k_in=2 / calm_n=5 / k_out=0 | r9 グリッド（calm 3/5/8/12 で同様）・r13・r16 |
| 段階縮小（graded） | 作らない | 11変種すべて全額退避に劣後（r13） |
| V字対策（dd20・速い復帰） | 作らない | 7変種すべて不成立（r16）。限界として画面に書く |
| 方向予測・ML・前夜米国の日次売買 | 作らない | 長期OOSでヌル（r10〜12、r4〜6） |
| 評価の約定 | 寄り（open[t]→open[t+1]）、片道5bp既定 | 研究と同じ。日中足は使わない |
| 単位 | 年率換算は **245営業日**（研究と一致させる） | 研究文書の数字（10.4% / −33.6% / 0.48）と突き合わせるため。ガイドに明記 |
| 対象 | 1銘柄＝1状態機械。バスケットは銘柄ごとの純リターンの平均 | r9/r13/r15 がその定義 |

---

## §1 目的と位置づけ

### 1.1 問い

「この銘柄を持っている人は、**明日の寄りで持ち続けるべきか、いったん現金にすべきか**」を、
前日までに確定した情報だけで、固定された規則で答える。方向は当てない。
荒れている状態（平均が期待を下回りボラが巨大な期間）を避けることだけを狙う。

### 1.2 公理的位置づけ（株式原論）

- **立脚する公準/命題**: 公理5（破産の吸収壁）・命題2（サイジングの独立性）・系C11（ドローダウン管理）・系C17（レジーム切替下の Φ）
- **測る P の性質**: 条件付き分散の拡大と、直近高値からの下落という「状態」。方向 E[dP] ではない
- **変える q の選択**: 建玉の大きさ |q| を {1, 0} の2値で切り替える（符号・対象・期間は変えない）
- **摩擦の扱い**: 回転は年3回程度。片道 5bp 既定、0/10/20bp の感度を常設

### 1.3 期待する効果と、期待してはいけない効果

| 期待する | 期待しない |
|---|---|
| 最大DD −83% → −34%（3メガ平均・2006-09〜） | 年率の上積み（90%CI [−4.5, +13.4]pt で 0 をまたぐ） |
| 4時代すべてで最大DD −25〜−34% | 強い上昇相場での勝ち（2018〜26 は 22.6% → 16.5%） |
| リーマン・2015-16・2018・コロナ・2025-04 型の守り | **V字（2024-08・2026-03）での守り。むしろ悪化** |
| 設計外銘柄でも最大DD 7中6改善 | 1321（2009年以降のみ）のような上昇相場だけの系列での改善 |

**これは保険である。** 画面の最上位にそう書く。

---

## §2 計算層 `app/lib/derisk-rule.ts`

純粋関数。React・DOM・fetch を持ち込まない。Worker とサーバー route の両方から呼べる。

### 2.1 入力

```ts
export interface DeriskInput {
  /** 対象銘柄の日足（調整後 OHLC、/api/stock の 10y または max）。time は "YYYY-MM-DD" */
  target: PricePoint[];
  /** ^VIX の日足（close だけ使う） */
  vix: PricePoint[];
  /** KRE の日足（close だけ使う） */
  kre: PricePoint[];
  params?: Partial<DeriskParams>;
  /** 片道コスト（比率）。既定 0.0005 */
  costOneWay?: number;
}

export interface DeriskParams {
  vixRatio: number;   // 1.25  VIX終値 ÷ 直近20日平均 > これで点灯
  volRatio: number;   // 1.8   5日実現ボラ ÷ 60日実現ボラ > これで点灯
  dd60: number;       // -0.12 直近60日高値からの下落 < これで点灯
  kreDd60: number;    // -0.12 KRE の直近60日高値からの下落 < これで点灯
  kIn: number;        // 2     点灯数 ≥ kIn で現金へ
  calmN: number;      // 5     点灯数 ≤ kOut が calmN 営業日連続で復帰
  kOut: number;       // 0
}
export const RESEARCH_PARAMS: DeriskParams = { vixRatio: 1.25, volRatio: 1.8, dd60: -0.12, kreDd60: -0.12, kIn: 2, calmN: 5, kOut: 0 };
```

### 2.2 時刻の規約と asof 整合（先読み防止）

研究 `common.py` の規約をそのまま写す。**行 t ＝ 日本の立会日 t、判断は t の朝7時（JST）。**

- 日本側の特徴量は **t−1 までの確定値**だけ（Python の `shift(1)`）。t の始値はまだ出ていない。
- 米国側（VIX・KRE）は **日付が t より厳密に小さい最新の行**（`asof_us`）。米国の t−1 の終値は JST t の朝5〜6時に確定。

共通関数を `app/lib/asof-align.ts` に切り出す（`cross-asset-lead.ts` の `alignFeature` と `us-spillover-core.ts` の
`alignJpUs` が同じ比較を別々に書いているので、本件ではこの新関数を使い、既存2箇所の置換は**しない**。スコープ外）:

```ts
/** 各 jpTimes[k] に対し、date < jpTimes[k] を満たす最新の usTimes の添字（無ければ -1）。日付は文字列比較。 */
export function asofIndex(jpTimes: string[], usTimes: string[]): Int32Array
```

**派生量は米国側の暦で先に計算してから asof で引く**（VIX/20日平均 や KRE dd60 を日本の暦で計算してはいけない。
営業日のずれで窓長が変わる）。

### 2.3 4指標の定義（Python との対応表）

| # | 指標 | Python（`common.py build()`） | TS での定義（行 t） | 注意 |
|---|---|---|---|---|
| 1 | `vixRatio_t` | `asof_us(v / v.rolling(20).mean(), idx)` | 米国行 j=asof(t) について `vix[j] / mean(vix[j−19..j])`。j−19 < 0 なら未定義 | `min_periods` 既定＝20 |
| 2 | `volRatio_t` | `vol5/vol60`、`vol_n = r.rolling(n).std().shift(1)`、`r = diff(log close)` | `std_ddof1(r[t−5..t−1]) / std_ddof1(r[t−60..t−1])`。r[i] = ln c[i] − ln c[i−1] | **標本標準偏差（ddof=1）**。窓が揃わなければ未定義 |
| 3 | `dd60_t` | `(c / c.rolling(60, min_periods=20).max() − 1).shift(1)` | `c[t−1] / max(c[t−60..t−1]) − 1`。有効本数 ≥ 20 で定義 | **min_periods=20**（米国側と違う） |
| 4 | `kreDd60_t` | `asof_us(d / d.rolling(60).max() − 1, idx)` | 米国行 j について `kre[j] / max(kre[j−59..j]) − 1`。j−59 < 0 なら未定義 | **min_periods=60**（日本側と違う） |

点灯数 `stress_t = [vixRatio_t > p.vixRatio] + [volRatio_t > p.volRatio] + [dd60_t < p.dd60] + [kreDd60_t < p.kreDd60]`（各 0/1）。

**有効行**: 4指標がすべて定義される行だけを状態機械に通す（Python の `dropna(subset=[…])`）。
未定義の行は**飛ばす**（0点灯として扱わない）。

### 2.4 状態機械（`hyst`）

```ts
// Python r13_variants.hyst() の逐語訳。w[i] は行 i の建玉（1=保有, 0=現金）。
let cur = 1, calm = 0;
for (i of validRows) {
  if (cur === 1) { if (stress[i] >= p.kIn) { cur = 0; calm = 0; } }
  else { calm = stress[i] <= p.kOut ? calm + 1 : 0; if (calm >= p.calmN) cur = 1; }
  w[i] = cur;
}
```

- **同じ日に判定した結果がその日の建玉になる**（退避した日の寄りから現金、復帰条件を満たした日の寄りから保有）。
- 初期状態は保有（cur=1）。**経路依存**なので、系列の開始日が違えば途中の状態が違いうる。
  10y 取得では 2016-10 開始、研究は 2006-09 開始。復帰条件が一度でも成立すれば以後は一致するため
  実用上は同じだが、画面に「履歴の開始日」を出す。L6（range=max）が入れば完全一致する。
- 現金中は `calm` のカウントだけ進め、1灯でも点けばリセット。

### 2.5 評価（バックテスト）

- 保有リターン `y_oo[t] = ln(open[t+1] / open[t])`（寄りで建て翌寄りまで）。最終行は未定義（評価からは外す。状態は出す）。
- 純リターン `net[t] = w[t]·y_oo[t] − c·|Δw[t]|`、`Δw[0] = w[0]`（初日に片道1回分を課す。Python `net_ret` の `fillna(w.abs())`）。
- 買い持ち `bh[t] = y_oo[t]`（**寄り→翌寄りの系列**。終値ベースではない）。
- 指標（研究 `r15_final.py` と同じ式）: `yrs = n/245`、年率 `exp(Σnet/yrs) − 1`、σ `std·√245`、Sharpe `mean/std·√245`、
  最大DD は `exp(cumsum)` の最高値比、市場滞在率 `mean(w)`、回転 `Σ|Δw|/yrs`（初日分を除く。r9 `stats` と同じ）。
- 時代別: 2006-09〜2009 / 2010〜2012 / 2013〜2017 / 2018〜（10y データでは最初の2つが空になる。**空は空と表示**）。
- コスト感度: 片道 0 / 5 / 10 / 20bp の4列。
- α（NW t）は出さない。研究で「方向は頑健だが t>2 は 2%」と分かっており、見出しに出すと誤読を誘う。

### 2.6 出力

```ts
export interface DeriskResult {
  params: DeriskParams;
  rows: DeriskRow[];                  // 有効行ごと: time, 4指標の値, stress, w, yOo?, net?
  historyStart: string;               // 有効行の先頭日（経路依存の開示）
  latest: DeriskLatest;               // 最終有効行（＝データ最終日の朝7時時点）の状態
  next: DeriskLatest | null;          // 次の立会日の朝7時時点の状態（§2.6.1）
  metrics: { rule: Metrics; buyHold: Metrics };
  byEra: { label: string; rule: Metrics | null; buyHold: Metrics | null }[];
  costSensitivity: { costBp: number; rule: Metrics }[];
  episodes: CashEpisode[];            // 現金化区間
}
export interface DeriskLatest {
  time: string;                       // 判断日（立会日）
  stress: number; holding: boolean; calm: number;
  lights: { key: LightKey; value: number; threshold: number; lit: boolean; margin: number }[];  // margin は正＝安全側（§3.2）
  usAsOf: string;                     // 使った米国行の日付（VIX と KRE のうち古い方。vixAsOf / kreAsOf も持つ）
  usStale: boolean;                   // 米国行が直前の日本立会日より古い（朝6〜7時に更新される）
}
export interface CashEpisode {
  start: string; end: string | null; days: number;
  litAtEntry: string[];               // 退避日に点いていた指標
  bhReturn: number | null;            // その区間の買い持ち累積（守れた／逃した）
}
```

#### 2.6.1 「次の立会日」の状態

画面を見るのは引け後〜翌朝が多い。データ最終日 D_last の次の立会日 D_next の判断に使う入力は、
日本側＝D_last までの終値（shift 不要で全系列を使う）、米国側＝日付 < D_next の最新行。
取得時刻によって米国の D_last 行が未着のことがあり、そのときは `usStale=true` で
「米国の終値は朝6〜7時に更新」と出す（`CrossAssetLeadChart` と同じ文言）。
D_next は `tse-calendar.ts` の `tseClosureReason(time)` が null を返す次の日付（2000〜2099 年を規則＋特例表で算出済み）。
`followsTseCalendar(ticker)` が false の系列（投信・米国）では暦日の翌平日で代用し、「東証暦でない」と注記する。

### 2.7 頑健性（Worker・オンデマンド）

`app/lib/derisk-rule.worker.ts`。「偶然との比較を計算」ボタンで起動（`BadgeTrackRecordPanel` の「実績を計算」と同じ UX）。

1. **ランダム配置ヌル**（r14 (1)）: 実際の現金エピソードの本数・長さを保ったまま位置をランダムに置き直す（重ならないよう逐次配置、失敗は再試行）。1000回。最大DD・年率・Sharpe の分布と `P(ランダム ≥ 実際)`。
2. **定常ブロックブートストラップ**（r14 (3)）: 平均ブロック長20日、2000回。差（ルール − 買い持ち）の中央値・90%CI・P(>0) を年率/最大DD/Sharpe で。

乱数は `mulberry32` でシード固定。Python と乱数列は一致しないので、数値一致は求めず**分位の向きと桁**だけ照合する（§4.3）。

---

## §3 パネル `DeriskRuleChart.tsx`

### 3.1 登録

```tsx
// panel-registry.tsx, regime 節, regime-bocpd の直後
definePanel({
  id: "regime-derisk",
  title: "ストレス退避規則（4指標ヒステリシス）：明日の寄りで持つか、現金にするか",
  input: "all+ticker",
  closeOnly: "caution",
  height: 760,
  load: () => import("../components/analysis/DeriskRuleChart"),
}),
```

- `input: "all+ticker"`: 状態機械とバックテストは期間セレクタに依存させない（10年フル）。`ticker` は見出し・バッジ・復元用。
- `closeOnly: "caution"`: 4灯は終値だけで成立するが、評価は寄り約定を仮定するので投信では成績表が意味を持たない。冒頭に注意書き。
- `fixtures/panel-ids.golden.ts` に同じ位置で1行追加。

### 3.2 画面構成（上から）

**A. 判定ヘッダー（常時表示・最重要）**

```
次の立会日 2026-10-24（金）の建玉: 保有     点灯 0 / 4     履歴の開始 2016-10-24
┌────────────────────────────┬────────┬────────┬────────┐
│ 指標                         │ 現在値  │ 閾値    │ 余裕    │
│ VIX ÷ 20日平均               │ 1.08   │ > 1.25 │ −14%   │
│ 5日ボラ ÷ 60日ボラ            │ 1.21   │ > 1.8  │ −33%   │
│ 60日高値からの下落            │ −9.8%  │ < −12% │ 2.2pt  │
│ KRE 60日高値からの下落        │ −10.1% │ < −12% │ 1.9pt  │
└────────────────────────────┴────────┴────────┴────────┘
米国データ: 2026-10-23 の終値（最新）／ 現金中なら「復帰カウント 2 / 5」
この規則は保険です。年率の上積みは有意ではなく、1日で終わる急落（2024-08・2026-03 型）には効きません。
```

- 余裕（margin）: **正＝安全側**で統一する。比率型は `1 − value/threshold`、下落型は `value − threshold`（比率差）。負なら点灯中。**閾値に近い（余裕 < 10% または < 2pt）行は黄色**。
- バッジ（`useAnalysisResultSummary`）: 現金なら `{ finding, down, "退避中（k/4）" }`、保有で 1灯以上なら `{ finding, down, "警戒（k/4）" }`、0灯は `{ none }`。
  量（点灯数）はラベル文言に含めてよいが、バッジの型は判断のみ。

**B. 3ペイン同期チャート（lightweight-charts、手本 `EdgeDecayChart`）**

1. 価格（対数）＋ ルールのエクイティ（右軸）＋ 買い持ちのエクイティ。現金化区間は `createSeriesMarkers` で退避日▼・復帰日▲、
   区間の帯は背景の `HistogramSeries`（値=1・薄い赤）で塗る（マーカーは Histogram 非対応なので帯と印は別シリーズ）。
2. 点灯数 0〜4 のステップ線（`LineSeries`、`lineType: LineType.WithSteps`）＋ `kIn` の価格線。
3. 4指標の余裕（margin）4本。0 の水平線が閾値。**0 を下回れば点灯**（正＝安全側）。ホバーで生の値を出す。

価格線は init 時に一度生成し、更新時は `removePriceLine`（マーカーの積み重なり防止は手本と同じ）。

**C. 成績表**

- 見出し行は `StrategyVsBenchmark`（`mode="returns"`、`strategyDaily = w·y_oo`、`buyHoldDaily = y_oo`、`roundTrips = Σ|Δw|/2`、`spreadRT = representativeSpread(target)`）。
  コストの ON/OFF と bps は部品が持つ。**本パネル独自の5bp列と部品のコストモデルが二重にならないよう**、部品の既定を「控除ON・片道5bp相当」に合わせる。
- 時代別4区分（年率／最大DD）と、コスト感度 0/5/10/20bp（年率／最大DD／Sharpe）。
- 「研究の数値（3メガ平均・2006-09〜）」を静的に併記し、画面の数値（1銘柄・10y）と**なぜ違うか**を1行で書く（期間・バスケット・開始日）。

**D. 現金化エピソード表**

開始／終了／日数／退避日に点いていた指標／区間中の買い持ち累積（守れた＝負、逃した＝正）／局面名（研究の WIN 表の日付に重なれば表示）。
2024-08 と 2026-03 の行には「V字型：逃した」を強調して、限界を実データで見せる。

**E. 頑健性（折りたたみ・オンデマンド）**

ボタン → Worker。結果: ランダム配置ヌルの分布表（5%/50%/95% と実際、P値）、ブート差の中央値・90%CI・P(>0)。
研究の 972 設定グリッドの要約（「全設定で最大DDが買い持ちより浅い」「t>2 は 2%」）を静的に添える。

**F. パラメータ（折りたたみ）**

既定は `RESEARCH_PARAMS` 固定。編集は可能だが、**編集中は判定ヘッダーに「研究の設定での判定」を並列表示**し、
「グリッドでは calm 3/5/8/12 で同様の効果。尖った点ではない」「V字対策の変種は7件すべて不成立」を注記する。
`localStorage` に `sa:derisk:params:v1` で保存。「研究値に戻す」ボタン。

**G. AnalysisGuide**（規約の7項目＋公理的位置づけ）

1. 概要: 方向でなく状態を避ける保険。何を測り、何が言えて、何が言えないか
2. 数式: 4指標の定義（§2.3 の式を変数定義つきで）、点灯数、状態機械、`y_oo`、`net`、各指標（245日換算を明記）
3. 用語: ヒステリシス／実現ボラ／ドローダウン／KRE／VIX／ランダム配置ヌル／ブロックブートストラップ／最大DD
4. 例え: 火災報知器と、鳴り止んでから5分待って戻る避難訓練。感度を上げると誤報で戻りを逃す
5. 読み方: 「2灯で退避、0灯が5日で復帰」「余裕が2pt以内は翌日点灯しうる」「最大DDが浅くなっても年率は上がらない」
6. 投資判断: |q| の 1/0 切替。符号・対象・期間は変えない。レバレッジ下では追証回避に効く（C22）。NISA 口座では売却枠の復活規則に注意
7. 限界: V字・上昇相場だけの系列・設計の大半を2018年以降で決めたこと・3メガの相関・配当再投資扱い・税と金利未考慮・寄り約定の仮定・経路依存（履歴開始日）

---

## §4 テストと Python 照合

### 4.1 合成系列テスト（`derisk-rule.test.ts`、独立実装の物差し）

状態機械と指標計算の**向き**を固定する。黄金値ではなく、意図した性質を直接確かめる:

- 2灯になった行の `w` がその行から 0、1灯では 1 のまま（`kIn`）
- 現金中に 0灯が4日続いて5日目に1灯 → カウントがリセットされ復帰しない。再度 0灯が5日続いた行で復帰
- `kOut=1` にすると 1灯でもカウントが進む
- 指標未定義の行は状態機械に入らない（飛ばした行の前後で `calm` が連続する）
- `dd60` は有効本数 20 で定義され、`kreDd60` は 60 本未満で未定義（min_periods の非対称）
- `volRatio` の標準偏差が ddof=1（手計算の値と一致）
- asof: 米国行の日付が日本の行と同日なら使わない（厳密に小さい）
- `net` の初日に片道1回分のコストが乗る。`Δw` の回転に初日は含まれない
- 最終行は `yOo` 未定義でも `latest` が出る

### 4.2 黄金値フィクスチャ（Python → JSON → TS）

`research/bank-derisk/export_fixture.py`:

- 入力: `data_max/8306.T.csv`（time, open, close）、`_VIX.csv`・`KRE.csv`（time, close）を **2018-01-01 以降**に切る（約 2,300 行×3。JSON で 250KB 程度）。
  切った後の系列を Python 側でも同じ切り口で `build()` 相当に通す（`common.py` を import せず、本書 §2.3 の式を**この スクリプト内で独立に**書く。
  `common.py` に依存すると `common.py` の変更でフィクスチャが黙って変わる）。
- 出力 `app/lib/__tests__/fixtures/derisk-golden.json`: 入力3系列 ＋ 期待値（各有効行の `time, stress, w`、`metrics.rule/buyHold`（5bp）、
  `costSensitivity`、`episodes`）。数値は `toPrecision(10)` 相当で丸める。
- TS テストは入力3系列を `computeDerisk` に通し、`assertGoldenArray` で `stress`・`w` の全行、`assertGolden` で指標を照合する。

### 4.3 全期間の照合（`npm test` 外）

`research/bank-derisk/check-lib.mts`（`research/leading-indicators/check-lib.mts` と同形）:
`data_max` の 8306/8316/8411 全期間（2006-09〜）を TS に通し、
研究文書の **3メガ平均 年率 10.4% / 最大DD −33.6% / Sharpe 0.48（5bp）** と、`r15_final.py recent` の最終行（`stress=0/4 保有`、各指標値）を再現することを確認する。
頑健性は分位の向き（P<0.01・CI が 0 をまたぐ）と桁だけ照合。結果は本書 §7 に記録する。

### 4.4 レジストリのテスト

`page-wiring.test.ts` が落ちるのは `panel-ids.golden.ts` の未更新（同じ位置に追加）と、`closeOnly` の件数（caution +1）。
**IDは `regime-` 接頭辞で、後から変えない。**

---

## §5 受け入れ条件

1. 黄金値テストが通る（8306.T 2018〜の全行で `stress`・`w` が Python と一致、指標は10桁一致）
2. `check-lib.mts` で研究文書の 3メガ平均 3指標を小数第1位まで再現し、`recent` の最終行の点灯状態が一致する
3. 画面の判定ヘッダーに「次の立会日」「点灯 k/4」「各指標の現在値・閾値・余裕」「米国データの日付と鮮度」「履歴の開始日」が出る
4. 現金化区間が価格チャートに帯と印で重なり、エピソード表の行をクリックすると該当区間へズームする
5. 2024-08 と 2026-03 のエピソードに「V字型」の印が付き、買い持ちより悪化した累積が表示される
6. 成績表に時代別4区分とコスト感度4列があり、10y データで空になる時代は空と表示される（0 や NaN を数字として出さない）
7. パラメータを変えると「研究の設定での判定」が並列表示され、戻すボタンで `RESEARCH_PARAMS` に戻る
8. 投信（終値のみ）で caution の注意書きが出て、成績表は「寄り約定を仮定できない」と表示する
9. ベンチマーク（^VIX・KRE）の価格修復があれば開示される（`describeSanityReport`）
10. `npm test`・`npm run lint`（警告は増やさない）・`npm run build` 通過。デプロイ版で 8306.T と 7203.T を目視（`verify` skill）

---

## §6 フェーズ

| フェーズ | 内容 | 規模 |
|---|---|---|
| **P0 計算層** | `derisk-rule.ts`・`asof-align.ts`・合成テスト・`export_fixture.py`・黄金値テスト・`check-lib.mts` 照合 | 1セッション |
| **P1 パネル** | `DeriskRuleChart.tsx`（A〜D・F・G）・レジストリ・golden ID・デプロイ目視 | 1セッション |
| **P2 頑健性** | Worker（E）・分位照合 | 0.5セッション |
| **P3 横断版** | `/portfolio` に `pf-derisk`: ウォッチリストの保有銘柄×4灯の表（次の立会日の建玉・余裕・現金中なら復帰カウント）。計算層は同じ。`fetchBenchmarkPrices` で ^VIX/KRE を1回だけ取る | 0.5セッション |
| 範囲外 | 通知・cron・メール（S2）、range=max（L6）、ヘッジ（L4）。計算層が純粋関数であればそのまま乗る | |

P0 と P1 は同じ worktree で続けてよい（専有ファイルが重ならない）。P3 は P1 完了後。

---

## §7 照合結果の記録

### 7.1 P0（2026-10-23）— `npx tsx research/bank-derisk/check-lib.mts`（data_max 全期間、startTime=2006-09-01、片道5bp）

| 項目 | 研究（Python） | TS | 一致 |
|---|---|---|---|
| 3メガ平均 年率（5bp） | 10.4% | 10.4% | ○ |
| 3メガ平均 最大DD | −33.6% | −33.6% | ○ |
| 3メガ平均 Sharpe | 0.48 | 0.48 | ○ |
| 3メガ平均 B&H 年率／最大DD／Sharpe | 5.8% / −83.0% / 0.17 | 5.8% / −83.0% / 0.17 | ○ |
| 時代別 4区分（ルール 年率/最大DD） | −4.4/−24.7, 8.8/−32.1, 11.6/−32.9, 16.5/−33.6 | 同値 | ○ |
| 時代別 4区分（B&H） | −34.9/−78.8, 6.5/−38.6, 12.2/−50.0, 22.6/−48.7 | 同値 | ○ |
| 8306.T `recent`（BD_DATA=data_max）最終行 2026-10-14 | 0/4 保有、vix比 0.99・volratio 1.19・dd60 −5.3%・kre −10.9% | 同値（usAsOf 2026-10-13） | ○ |
| 黄金値（8306.T 2018〜、2,079行） | `export_fixture.py` | stress・w 全行一致、指標は有効10桁で一致 | ○ |
| ランダム配置ヌル P(最大DD) | ≤ 0.001 | P2（Worker）で照合 | — |
| ブート 年率差 90%CI | [−4.5, +13.4]pt | P2（Worker）で照合 | — |

- 計算時間: 1銘柄 4,904 行で 53〜81ms（Worker 不要。頑健性だけ Worker）。
- 8306.T の 2026-03 エピソード: 2026-03-10〜04-07（20日・dd60＋kreDd60 で退避）、区間の買い持ちは +10.0% → **V字で逃した**（研究 §6 と整合）。
- `npm test` 303/303、`eslint` 0 件（新規3ファイル）、`tsc --noEmit` 新規ファイルにエラー無し。

### 7.2 実装で確定した仕様（設計からの差分）

- `DeriskState` に `vixAsOf` / `kreAsOf` を追加（`usAsOf` は古い方）。`usStale` は「直前の日本立会日より古い」で判定。
- `margin` は正＝安全側に統一（§3.2 を修正）。
- `DeriskInput.startTime` を追加（研究の `D[D.index >= "2006-09-01"]` 相当。暖機は全履歴、状態機械はこの日から）。
- `runHysteresis` が初期状態を受け取り、「次の立会日」は最終状態から1歩だけ進めて出す。
- 黄金値の `assertGolden` は期待値側も同じ桁に丸めて比較する（Python の丸めと TS の丸めを揃える）。

---

### 7.3 P1（2026-10-23）— ブラウザ確認（dev 3100・8306.T・`sa:open:regime-derisk=1`）

| 確認 | 結果 |
|---|---|
| 描画 | 3ペイン同期・現金化帯・▼退避/▲復帰マーカー・点灯数ステップ・余裕4本が描ける。コンソールエラー 0 |
| 判定ヘッダー | 「次の立会日 2026-10-26 の建玉: 保有 1/4」「データ最終日 2026-10-23: 0/4」「米国データ 2026-10-22（未着）」「履歴の開始 2017-01-25」が出る。60日DD −12.1% が点灯・VIX比 1.16 が「閾値に近い」 |
| 成績表 | 全期間 2017-01-25〜 13.2% / −38.3% / 0.52 vs B&H 21.3% / −54.3% / 0.60。2006-09〜2009 と 2010〜2012 は「—」（0 や NaN を出さない） |
| エピソード | 17件。2026-03-10〜04-07（20日・DD+KRE・B&H +10.0%）は `check-lib.mts` と一致し「V字型（2026年3月）」の印が付く。2024-08-05〜10-18 も V字型 |
| 行クリック | 区間へズームする |
| パラメータ | calmN を 3 にすると「研究の設定での判定」カードが並列表示され localStorage に保存。「研究値に戻す」で消える |
| 修復開示 | ^VIX の未修正の急変動（2018-02-05 等）が「参照系列の修復」として出る |
| テスト | `npm test` 303/303（panel-ids golden・caution 27・paid 172 を更新）、eslint 0、tsc エラー無し |

受け入れ条件 §5 の 3〜7・9・10 を満たす。8（投信）は未確認（終値のみ系列での文言は実装済、目視は P2 で）。

### 7.4 P2（2026-10-23）— 頑健性の分位照合（`check-lib.mts` 末尾・3メガ平均・2006-09〜・片道5bp・seed 20261023）

乱数列は numpy と一致しないので、分位の向きと桁だけを見る。

| 項目 | 研究（r14） | TS（derisk-robust） |
|---|---|---|
| ヌル 年率 中央値 [5%, 95%] vs 実際 | 3.7% [0.3, 7.1] vs 10.4%、P ≤ 0.001 | 3.6% [0.4, 7.1] vs 10.4%、P = 0.001 |
| ヌル 最大DD | −71% [−81, −56] vs −34%、P ≤ 0.001 | −71.4% [−80.8, −57.7] vs −33.6%、P = 0.000 |
| ヌル Sharpe | 0.15 [0.01, 0.30] vs 0.48、P ≤ 0.001 | 0.15 [0.02, 0.29] vs 0.48、P = 0.000 |
| ブート 最大DD差 | +24.5pt [+4.2, +44.8] P=0.98 | +24.4pt [+3.0, +46.3] P=0.97 |
| ブート Sharpe差 | +0.31 [+0.01, +0.60] P=0.96 | +0.31 [+0.02, +0.62] P=0.96 |
| ブート 年率差 | +4.4pt [−4.5, +13.4] P=0.80 | +4.5pt [−4.2, +13.2] P=0.81 |

計算時間: ヌル 1000回 約6秒（3銘柄 4,900行・Node）、ブート 2000回 約1.4秒。

**画面（8306.T・10y・dev 3100）で押した結果**: 評価行 2,379 日・現金化 17 本。ヌル 年率 P(偶然 ≥ 実際)=0.614、最大DD 0.057、Sharpe 0.433。
ブート 年率差 −8.3pt [−19.5, +2.4] P=0.11、最大DD差 +3.1pt [−16.5, +23.7] P=0.62、Sharpe差 −0.10 P=0.34。
見出しは「この期間では偶然と区別できない」。黄金値フィクスチャ（2018〜）でも同じ向き（年率 P=0.61）。
**研究の強さは 2008 年を避けたことに由来し、上昇相場だけの 10y 標本では規則は偶然と区別できない**。これは研究 §5.1 の「2018〜 は年率で劣後」と同じ現象で、
画面はそれを隠さず、研究の記録と「なぜ違うか」を並べて出す。長期取得（L6 range=max）が入れば画面でも研究の向きが出るはずで、それが L6 の動機になる。

実装で確定した仕様: 配置ヌルは評価行（最終行を除く）の上で行う。ブートは建玉を再標本化せず、純リターンと買い持ちリターンを同じ添字で引く。
`percentile` は numpy 既定の線形補間。幾何分布は台 1,2,… の逆関数法。パラメータを編集すると結果は無効化され、研究値に戻すと復元する（キーは銘柄・評価行数・最終日・コスト・パラメータ）。

受け入れ条件 §5 の 8（投信）: `0331418A`（eMAXIS Slim 全世界株式、接尾辞なし）で目視。判定ヘッダーに「この系列は終値だけ（始値＝終値）なので、4灯の状態は出せますが、寄り約定を仮定する成績表は意味を持ちません」が出て 4灯（0/4・保有）とエピソード表は出る。成績表は出ず、頑健性ボタンは無効化され「終値のみの系列では寄り約定を仮定できないため計算しません」が出る。これで §5 は 1〜10 すべて確認済（10 のデプロイ版目視は push 後）。

### 7.5 P3（2026-10-24）— 横断版 `pf-derisk`

実装で確定した仕様（§6 の1行からの具体化）:

- **成績（年率・最大DD）は出さない**。横断で並べると「成績の良い銘柄だけ従う」誘惑が生まれ、保険の意味が壊れる。成績・エピソード・頑健性は行の銘柄名リンク（`/?ticker=…&panel=regime-derisk`）で1銘柄版へ。
- 4灯のうち **市場共通の2灯（VIX 比・KRE dd60）は見出しに1回だけ**、行には固有の2灯（5日/60日ボラ比・60日高値比）と状態・点灯数・復帰カウント・判断日・履歴開始日。
- パラメータは `RESEARCH_PARAMS` 固定（横断では編集させない）。
- 並び: 現金 → 点灯数の多い順 → 保有が先 → ティッカー。計算不能（行数 < 120・4指標が揃わない）は末尾に理由つき。
- 集計: 「保有 N のうち現金 M・警戒 K」＋全銘柄の現金・警戒数。保有の登録が無ければその旨。「保有銘柄だけ表示」トグル。
- `/portfolio` のパネルはレジストリ非経由で `page.tsx` 直書き（既存 pf-* と同じ）。golden ID テストの対象外。
- **判断日が銘柄で異なりうる**: `nextTradingDay` が東証暦に従うのは `followsTseCalendar` が真の銘柄だけで、投信コード（`0331418A`）は偽 → 翌月曜が祝日なら `.T` と1日ずれる。多数派を `nextTime` にし、ずれがあれば注意書きを出す（テストで固定: 2024-07-12 の翌週、海の日）。投信を東証暦に乗せるかは `tse-calendar.ts` 側の判断で、本書の範囲外。
- ^VIX/KRE は `useBenchmarkSet` 経由（1銘柄版とモジュールキャッシュを共有するので、同じセッションでは再取得しない）。

テスト: `npm test` 323/323（derisk-cross 8件追加）、eslint 0、tsc エラー無し。

ブラウザ確認（2026-10-24・dev 3100・ウォッチリスト 8306.T 保有/8316.T 保有/7203.T 候補/0331418A 保有・`sa:open:pf-derisk=1`）:
- パネルは `pf-risk` 直前に表示され、見出し・副題・ガイド・「参照系列の取得に失敗: ^VIX・KRE」の空状態・各行の「取得失敗」まで描画される（落ちない）。
- **行の中身（共通2灯・集計・状態バッジ・投信の「終値のみ」札・判断日のずれ注意）は未確認**。Yahoo Finance が全ティッカーに 429（レート制限）を返し `/api/stock` が 404 になったため。dev サーバー側のモジュールキャッシュも空の状態だった。
- 行の中身の確認は、Vercel デプロイ版で行う（`useBenchmarkSet` と各行の計算は 1銘柄版 `regime-derisk` と同じ `computeDerisk`・同じ fetch 経路なので、データが来れば描画される想定。描画ロジックは合成データの 8 テストで固定済）。

## §8 設計上の判断と、その理由

- **なぜ `regime` 節か**: 答えが「今の相場環境で建玉を持つか」であり、節のラベル「今の相場環境を見極める」と一致する。
  `simulation` 節の `sim-vol-target` と役割が隣接するが、あちらはサイズの連続調整、こちらは退避の2値。ガイドで相互参照する（改善計画 E11）。
- **なぜパラメータを固定既定にするか**: 設計の大半を 2018 年以降で決めた規則であり、画面で再調整すると in-sample が増えるだけ。
  編集は許すが、研究設定での判定を常に並列表示することで「調整して都合のよい判定を出す」経路を塞ぐ。
- **なぜ α を出さないか**: 方向（最大DDが浅い）は頑健だが大きさ（年率）は非有意。α(t) を見出しに置くと「リターンの上積み」と読まれる。
- **なぜ 245 日換算か**: 研究文書の数字と突き合わせるため。アプリ他所は 252。ガイドに書き、将来統一するなら本パネルと研究の両方を変える。
- **なぜ日中足を使わないか**: 規則は前日確定値で動く。日中足を入れると V字に効くように見えるが、R16 で速い指標は全期間の防御力を落とした。
- **なぜ基礎の asof 関数を新設するか**: 既存2箇所は各々の構造体に結合していて再利用できない。置換は別タスク（壊れていないものを触らない）。
