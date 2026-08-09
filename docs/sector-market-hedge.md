# ★1 設計書 ─ 市場ヘッジ: 「1.27倍レバレッジの日本株」から金利の賭けを切り出す

対象: `docs/sector-factor-selection.md` §11.2 の **★1（仮 P3H）**。系C29 の続きであり、新しい系C30 になる。
新規: `app/lib/sector-market-hedge.ts` / `sector-market-hedge.worker.ts` / `app/lib/rakuten-futures.ts` /
`app/components/analysis/SectorMarketHedgePanel.tsx`（`SectorFactorSelectChart.tsx` に差し込む）。

**前提の確認（2026-08-07・ユーザー回答済み）**

| 確認事項 | 回答 | 設計への影響 |
|---|---|---|
| 空売り・先物・信用を使うか | **使う** | ヘッジ層を「純度の高い銘柄に寄せる」で代替する退避経路は不要 |
| 決定変数の範囲 | **(L, h) 同時最適化** | 信用買いによる建玉倍率 L も変数。h だけの掃引は L=1 の断面として内包 |
| ヘッジ手段 | **先物・ETF信用売りを並置比較** | キャリーと税区分と建玉単位の3点で手段が分岐する。比較そのものが成果物 |
| 円建て | **元本入力あり・先物の刻みも制約に入れる** | h は連続でなく離散。追証確率は円建てのモンテカルロで出す |

---

## §0 コールドスタート用の前提（この節だけで着手できる状態にする）

**新しいセッションはここから読む。**

### 0.1 いまどこまで出来ているか

| フェーズ | 状態 | 実体 |
|---|---|---|
| **P0 前提診断** | ✅ 完了 (2026-07-30) | 「銀行セクターは金利で動いているか」R²=5.7% / t=4.96 → 前提は成立 |
| **P1 感応度ランキング** | ✅ 完了 (2026-07-31) | b̂±SE・S=b/σ_ε・JS収縮・順位95%CI・w∝b/σ_ε²・市場β並置・純度 |
| **P2 持続性** | ✅ 完了 (2026-07-31) | π(1年)=0.97 [0.81, 1.03]・上位5本の1年後生存 84%（ヌル36%） |
| **★1 市場ヘッジ** | ⬜ **本書** | 律速が「加重市場β 1.27」に移ったので P3 より先に置く |
| ★2 P3 WF検証 / ★3 P4 集中曲線 / ★4 P6 IRRBB / ★5 P5 残差ローテ | ⬜ 未着手 | `sector-factor-selection.md` §8 |

### 0.2 着手前に片付けること（未コミットの残骸）

`docs/sector-factor-p2-session-record.md` §4 のとおり、**P1/P2 のコードレビュー是正が未コミット**で作業ツリーに残っている
（7ファイル・+245/−146）。★1 の実装を上に積む前に、これを先にコミットして基準線を作ること。
無関係な未コミット分（銘柄検索まわり）が同居しているので、**`git add -A` は使わず pathspec で対象を明示する**。

### 0.3 ファイルの地図

```
app/lib/sector-factor-select.ts          P0+P1 の計算層。★1 は buildPanel / olsNW / orthogonalize を再利用
app/lib/sector-factor-stability.ts       P2 の計算層。★1 は L2-D（非対称 b）の結果を借りる
app/lib/rakuten-margin.ts                信用取引コストの単一ソース（買方金利・貸株料・維持率・諸経費）
app/lib/rakuten-futures.ts               ← 新規。先物コストの単一ソース（rakuten-margin.ts の兄弟）
app/lib/sector-market-hedge.ts           ← 新規。本書の計算層
app/lib/sector-market-hedge.worker.ts    ← 新規。追証モンテカルロのみ
app/components/analysis/SectorMarketHedgePanel.tsx  ← 新規。SectorFactorSelectChart に差し込む
app/lib/nisa-vs-taxable.ts               円建て清算価値ウォーカー・追証・破産確率の手本
app/lib/growth-drag.ts                   g = μ − σ²/2 の分解と成長曲線
app/hooks/useBenchmarkPrices.ts          因子系列の取得（必ずこれを使う）
/portfolio の分析ID: pf-sector-select（★1 も同じ画面の中）
```

### 0.4 再利用できる既存 export

```ts
// sector-factor-select.ts
buildPanel(pricesByTicker, market, etf, window): ReturnPanel | null   // ret[i][t] / market[t] / dates[]
olsNW(y, X, lag = 5): OlsFit | null
orthogonalize(y, x): number[]
mulberry32(seed): () => number
computeSectorSelect(...): SectorSelectResult   // assets[].weight が ★1 のバスケット定義

// rakuten-margin.ts
resolveMarginRate(kind, plan): { longRate; shortRate; label }
INITIAL_MARGIN_RATE = 0.30 / DEFAULT_MAINTENANCE = 0.20 / MAX_LEVERAGE = 3.3
adminFeeMonthlyRate(refPrice) / transferFeeAnnualRate(refPrice, lot, recordDates)

// growth-drag.ts
geometricGrowth(mu, sigma) / doublingYears(g) / TRADING_DAYS = 252

// stats-significance.ts
mean / std / median / quantileSorted / tTest / blockBootstrapCI
```

> **`buildPanel` を書き直さないこと。** 履歴カバレッジ（95%）と価格破損の網が入っている。

### 0.5 価格系列の性質（★1 ではこれが決定的）

`app/lib/stock-source.server.ts:133` のとおり、`/api/stock` が返すのは **adjClose ベース＝配当再投資込みのトータルリターン**。
`open/high/low` も `adjClose/rawClose` の倍率で調整されている。★1 ではこれが3か所に効く。

1. 銀行バスケットのリターンは**配当込み**。銀行の配当利回りは3〜4%あるので、価格リターンで議論すると答えが変わる。
2. TOPIX ETF を売るとき、adjClose の系列で `−h·TR_M` と書くと、**配当落調整金を100%支払った**ことに相当する。
   制度信用の実際の支払いは配当金の 84.685%（源泉税相当を控除）なので、**差の 15.315%·q を戻す**必要がある。
3. 先物は配当を価格に織り込んでいるので、`−TR_M + r` になる（§2.4 で導出）。**adjClose の系列をそのまま使ってはいけない。**

### 0.6 動作確認の手順（P0〜P2 で使ったもの）

```bash
npx next dev -p 3111                       # API 経由で価格を取るため
npx tsx <scratchpad>/hedge-smoke.ts        # import は絶対パスで書くと通る
npx tsc --noEmit
npx eslint app/lib/sector-market-hedge.ts app/components/analysis/SectorMarketHedgePanel.tsx
```

`app/portfolio/page.tsx` には既存の lint エラーが2件あるが ★1 とは無関係（触らない）。

### 0.7 P1/P2 が残した数値（★1 の出発点）

```
採用5本の加重市場β  c = 1.27      （10年窓では 1.06）
採用5本の加重セクターβ b = 0.97
純度（分散ベース）    34%          全16銘柄で 19〜43%
π(1年) = 0.97        順位は恒久的だが b の水準は窓依存（2021-09 前後で別レジーム）
暴落増幅3本          みずほ・りそな・千葉銀は市場下落日に b が有意に増える（L2-D）
```

---

## 0. なぜこの層が要るのか ─ P2 が残した問い

P1 の最大の発見は順位ではなく**保有しているものの正体**だった。

```
採用5本 ＝ 加重セクターβ 0.97 ＋ 加重市場β 1.27
        ＝ 「TOPIX を 1.27 倍持ち、そこに銀行ファクターが 0.97 乗っているもの」
```

P2 は「選別の順位は来年も同じ」を肯定したので、律速は選別ではなくこの**露出の構成**に移った。
金利観 m に賭けたいのに、分散の 3 分の 2 は賭けていない市場から来ている。

しかし ★1 を「純度を上げる層」として設計するのは**誤り**である。純度は比であって、
分子（セクター露出）を保ったまま分母（市場露出）だけ削れるかどうかは別の問題だからだ。
`L=1` に固定して h を上げると、**純度は上がるが総露出も落ちる**。純度 100% で建玉ゼロなら意味がない。

> **ヘッジの本当の価値は「純度」ではなく、2つの賭けを独立にサイジングできるようになること。**

現物のみだと、銀行を1単位持つたびに市場が 1.27・セクターが 0.97 と、**比 0.76 に溶接された抱き合わせ**でしか
建玉を取れない。空売り/先物が使えると、この溶接が外れる。市場露出 x_M とセクター露出 x_F を独立に置ける。
これは C7（ベータ・ヘッジ）というより **C24（参加の価値）と C29（セクター選別）を別々の水準に置ける**という話で、
だからこそ系を新設する価値がある（§11 の系C30）。

そして溶接が外れた瞬間、最適な x_M は **σ を下げたいという願望ではなく π_M（株式リスクプレミアム）の見立てだけで**
決まる（§2.3）。π_M は C26 により測れない。**つまり ★1 は「測れない量が答えを決める」ことを可視化する層**であり、
出力は数値ではなく**「あなたが π_M をいくつだと思うなら h はいくつ」という写像**になる。

---

## 1. 問題設定 ─ 露出ベクトルへの写像

### 1.1 決定変数と露出

| 記号 | 意味 | 単位 |
|---|---|---|
| `V` | 元本（自己資金） | 円 |
| `L` | 銀行バスケットの建玉倍率 = バスケット notional / V | 倍（L>1 は信用買い） |
| `h` | ヘッジ notional / V。**h>0 が市場の売り、h<0 は市場の買い増し** | 倍 |
| `x_M = L·c − h` | 市場ファクターへの正味露出 | 倍 |
| `x_F = L·b` | セクター（銀行）ファクターへの正味露出 | 倍 |
| `x_ε = L` | バスケット固有リスクへの露出 | 倍 |

**h<0 を必ず実装すること。** §2.3 の結論は「多くの π_M の値で h\* は負」であり、
負を描けない UI は自分の結論を隠すことになる。h<0 の実体は先物買い、または 1306.T の現物買い（信用不要）。

### 1.2 超過リターンの分解

無リスク金利 r の上での超過で書く（`R_M = TR_M − r`、`E[R_M] = π_M`、`sd = σ_M`）。

```
バスケット超過   R_B = c·R_M + b·F + ε_p          E[F] = m, sd(F) = σ_F, sd(ε_p) = σ_ε,p
自己資金の超過   R_p = L·R_B − h·(R_M + κ_h) − (L−1)⁺·ι
                     ι   = 買方金利 − r（信用買いのスプレッド）
                     κ_h = ヘッジ手段のキャリー（§2.4。先物と信用売りで一桁違う）
```

```
μ_p = L·(c·π_M + b·m) − h·(π_M + κ_h) − (L−1)⁺·ι
σ_p² = x_M²·σ_M² + x_F²·σ_F² + x_ε²·σ_ε,p²
g    = μ_p − σ_p²/2                        ← μ は必ず算術平均（対数μに −σ²/2 を重ねない）
```

α は C26 により 0 と置く（C16 の誤差割引の極限）。**m と π_M はどちらも測れない量なので、
両方を明示的なスライダーにする。** これが本層の設計上の中心的な誠実さである。

---

## 2. 理論 ─ 6つの導出

### 2.1 分離定理 ─ ヘッジは市場の賭けを銀行の賭けから切り離す

g を h で偏微分する。

```
∂g/∂h = −(π_M + κ_h) + (L·c − h)·σ_M² = 0

⟹  x_M* = (π_M + κ_h) / σ_M²                              …【H-1】
⟹  h*   = L·c − (π_M + κ_h)/σ_M²
```

**【H-1】は Merton/Kelly の市場最適露出そのもの**で、L にも b にも m にも依存しない。
次に L で偏微分し、【H-1】を代入する。

```
∂g/∂L = c·π_M + b·m − ι·1{L>1} − [ x_M·c·σ_M² + L·b²σ_F² + L·σ_ε,p² ] = 0
        x_M·c·σ_M² = c·(π_M + κ_h) を代入すると c·π_M が消える

⟹  L* = ( b·m − c·κ_h − ι·1{L>1} ) / ( b²σ_F² + σ_ε,p² )   …【H-2】
```

> **L\* に π_M が現れない。** これが分離定理である。ヘッジ手段を持つと、
> 「銀行をどれだけ建てるか」は**金利観 m だけ**で決まり、「市場にどれだけ居るか」は**π_M だけ**で決まる。
> 現物のみだと両者は比 b/c = 0.76 に縛られていた。**この分離こそがヘッジの価値**であり、
> σ が下がることは結果であって目的ではない。

【H-2】から、そもそも銀行を建てる価値があるための条件が出る。

```
b·m > c·κ_h + ι           ⟺        m > (c·κ_h + ι)/b            …【H-3】
```

L≤1（信用買いなし・ι=0）・c=1.27・b=0.97 のとき:

| 手段 | κ_h（§2.4 の概算） | 必要な金利観 m |
|---|---|---|
| 先物ミニ売り | ≈ 0.2%/年 | **m > 0.26%/年** |
| ETF 信用売り | ≈ 1.85%/年 | **m > 2.42%/年** |

**手段の選択が「金利観がどれだけ強ければ銀行に建てる意味があるか」の閾値を約10倍動かす。**
これは §4 の Q 表で最初に出す1行になる。

### 2.2 ヘッジしない解（h=0 に固定した場合の最適 L）

比較対象として、現物のみ（h=0）の最適 L も出す。

```
∂g/∂L |_{h=0} = c·π_M + b·m − ι − L·(c²σ_M² + b²σ_F² + σ_ε,p²) = 0
⟹  L*_{noHedge} = (c·π_M + b·m − ι) / (c²σ_M² + b²σ_F² + σ_ε,p²)
```

`g(L*, h*) − g(L*_noHedge, 0)` が**ヘッジ手段を持つことの価値**そのもの。これを年率 pp で1つの数字にする。

### 2.3 損益分岐の π_M ─ 「ヘッジすべきか」は見立て1つで決まる

【H-1】から、**h>0（＝売る）が最適になる条件**は `L·c > (π_M+κ_h)/σ_M²`。L=1 のとき:

```
π_M < c·σ_M² − κ_h                                          …【H-4】ヘッジ開始の閾値
```

さらに **完全ヘッジ h=c が h=0 より g を上げる条件**は、

```
Δg = g(h=c) − g(h=0) = c²σ_M²/2 − c·(π_M + κ_h) > 0
⟹  π_M < c·σ_M²/2 − κ_h                                     …【H-5】完全ヘッジの閾値
```

設計時の概算（c=1.27・σ_M=16%/年 ⟹ σ_M²=0.0256。**実装時に実測へ差し替える**）:

| 条件 | 先物（κ=0.2%） | ETF信用売り（κ=1.85%） |
|---|---|---|
| **【H-4】少しでも売るべき** | π_M < **3.05%** | π_M < 1.40% |
| **【H-5】完全ヘッジが得** | π_M < **1.43%** | π_M < **−0.22%**（＝どんな場合も損） |

> **ETF 信用売りによる完全ヘッジは、株式リスクプレミアムがゼロだとしても g を下げる。**
> 貸株料と逆日歩と金利の取りっぱぐれの合計が、分散ドラッグの改善分（≈2.1pp）を食い切るため。

そして日本株の π_M を 5%/年と見るなら **h\* = 1.27 − (0.05+0.002)/0.0256 = 1.27 − 2.03 = −0.76**。
つまり**「ヘッジするな、むしろ市場を 0.76 倍買い増せ」**が既定の答えになる公算が高い。
**これが赤字の結論ではないことを画面で明示する**（§9）。P2 と同じく、
「動かさなくてよいと確認したこと」がこの層の価値になる可能性は高い。

### 2.4 手段別キャリー κ_h の導出（ここが本層の実務的な核心）

#### (a) 先物（TOPIX先物・ミニTOPIX先物）

無裁定価格 `F_t = S_t·e^{(r−q)(T−t)}` を微分する。

```
dF/F = dS/S − (r−q)dt
売り建ての損益 = −dF/F = −dS/S + (r−q)dt
dS/S = TR_M − q·dt    （価格リターン ＝ トータルリターン − 配当利回り）

⟹  売り建て = −TR_M + q·dt + r·dt − q·dt = −TR_M + r·dt = −R_M
```

> **先物売りは「市場の超過リターンをちょうど符号反転したもの」**になる。
> 配当は先物価格に織り込まれているので支払いは発生せず、証拠金に金利は付かないが、
> その分が先物価格のディスカウントとして先に受け取られている。
> ゆえに **κ_futures ＝ ロール滑り＋手数料＋税ドラッグ**だけ。

```
κ_futures = ロールコスト(年率) + 手数料(年率換算) + 税ドラッグ(§2.5)
          ≈ 0.10% + 0.02% + （税モデル依存）
```

ロールコストは理論値ではなく**実測すべき量**（限月間スプレッドが理論ベーシスから乖離する）。
本層では既定 0.10%/年のパラメータとし、「この値が X% を超えると先物の優位が消える」という
感応度を1行で出す。

#### (b) ETF 信用売り（1306.T を制度信用で売る）

```
売り建て = −TR_M + (1−d)·q − f_short − f_gyaku − f_admin − r
             (1−d)·q : 配当落調整金の税相当の戻り（制度信用 d=0.84685 ⟹ 0.15315·q）
             f_short : 貸株料（制度 1.10%/年・一般短期 3.90%/年）
             f_gyaku : 逆日歩（変動。既定 0.30%/年・ストレス 2.00%/年）
             f_admin : 事務管理費（1株あたり月11銭 → 株価で年率換算）
             −r      : 売却代金に金利が付かないぶんの機会損失

⟹  κ_margin = r + f_short + f_gyaku + f_admin − 0.15315·q
```

r=0.75%・f_short=1.10%・f_gyaku=0.30%・f_admin≈0.04%・q=2.2% のとき **κ_margin ≈ 1.85%/年**。
**先物との差は約 1.65%/年**で、これは §2.1【H-3】の閾値を 0.26% → 2.42% へ動かす。

> **注意**: 一般信用（短期）は逆日歩が出ない代わりに貸株料 3.90%。
> 「逆日歩が怖いから一般信用」は κ を 1.85% → 4.4% にする選択であり、
> §2.3【H-5】の閾値を大きく負にする。手段セレクタで必ず並べる。

#### (c) 3手段の比較表（画面に出すもの）

| | 先物ミニ | ETF信用売り（制度） | ETF信用売り（一般短期） |
|---|---|---|---|
| キャリー κ | **≈0.2%** | ≈1.85% | ≈4.4% |
| 建玉の刻み | **指数×1,000円 ≒ 290万円/枚** | 1単元 ≒ 3万円 | 同左 |
| 元本1,000万で作れる h | 0.29 刻み | **0.003 刻み** | 同左 |
| 逆日歩リスク | なし | **あり**（青天井） | なし |
| 期限 | 限月ロール（年4回） | 6か月 | 無期限/短期 |
| 証拠金 | SPAN（代用有価証券可） | 委託保証金30%（代用可） | 同左 |
| **税区分** | **先物取引に係る雑所得等**（株式と通算不可） | 上場株式等の譲渡所得等（**現物と通算可**） | 同左 |

**キャリーでは先物が圧勝、刻みと税では信用売りが勝つ。** 元本が小さいほど刻みの制約が効くので、
「元本いくらから先物が有利か」を交点として出す（§5 の出力の1つ）。

### 2.5 税ドラッグ ─ ヘッジは繰延べを壊す

これは設計書 §11.2 に書かれていなかったが、**キャリーと同オーダーの費用**なので一次項として扱う。

現物を持ち続けるかぎり含み損益は課税されない。ところが**ヘッジは必ず定期的に実現する**
（先物は限月ロール／SQ、信用は6か月の期限）。したがって、

> **ヘッジが効いた年（市場が下がった年）ほど、ヘッジ益に課税され、
> 相殺すべき現物の含み損は課税されないまま残る。**

年次のヘッジ損益を `X ~ N(−h·π_M, (h·σ_M)²)` と近似し、2つの税モデルを並べる
（`nisa-vs-taxable.ts` の Model A / B と同じ流儀）。

```
Model A（完全通算）: 現物も同時に実現して通算できる理想。税ドラッグ = τ·μ_p（水準のみ）
Model B（実現ベース）: ヘッジ益のみ課税・損は3年繰越
    年間の税ドラッグ ≈ τ·E[X⁺] − τ·(繰越で回収される期待額)
    無回収の上限     ≈ τ·h·σ_M·φ(0) ≈ 0.20315 · h·σ_M · 0.399
```

h=1.27・σ_M=16% ⟹ 上限 **≈1.65%/年**。繰越と将来の相殺で半分回収できるとして **≈0.8%/年**。
**キャリーが 0.2% の先物でも、税を入れると実効 1.0%/年**になる。
さらに先物は株式と通算できないので、**現物を実現しても救えない**。信用売りは通算できる。

> ここは推定に幅があるので、**τ とモデル A/B と繰越回収率をパラメータにし、
> 「税を入れる/入れない」のトグルで κ がどう動くかを見せる**にとどめる。断定しない。

**NISA との相互作用**: NISA 口座の現物は損益通算の対象外なので、
NISA で銀行株を持ちながら課税口座でヘッジすると、Model B の非対称が最悪化する。
既存 `nisa-vs-taxable.ts` と同じ画面言語で1行の注意として出す。

### 2.6 「効かないヘッジ」の検定 ─ c の時変性と非対称性

ここまでは c を定数として扱った。P2 は **b の順位は恒久的だが水準は窓依存**、
かつ**3本（みずほ・りそな・千葉銀）は市場下落日に b が増える**ことを実測している。
c についても同じ検定を通さないと、「暴落時だけヘッジが足りない」を見逃す。

```
(i)  ローリング c    : 250日窓の c_t を出し、その散らばりを SE と比べる（P2 のトラストスコアと同型）
(ii) 先読みなしヘッジ: h_t = c_{t−1}（過去窓のみで推定）でヘッジした系列を作り、
                       実現ヘッジ後 β を回帰で測る。ゼロから有意に離れていたらヘッジは未完成
(iii) 上下非対称    : 市場上昇日 c⁺ と下落日 c⁻ を分けて推定。c⁻ > c⁺ なら
                       「下げ相場でヘッジが足りない」。P2 の computeAsymmetry と同じ検定形式
(iv) ヘッジ後の b 保存: ヘッジ後系列を F に回帰し、b が保存されているか。
                       ずれるなら c の推定誤差が F 側に漏れている（直交化の順序の破れ）
```

**(iii) は本層で最も価値がある検定**になりうる。σ を下げるためにヘッジしたのに、
下げ相場でだけ効かないなら、その σ 削減は平時にしか存在しない。

### 2.7 制約 ─ 証拠金・維持率・追証・刻み

g = μ − σ²/2 は連続時間の近似であり、**吸収壁（公理5・C22）を持たない**。
追証と強制決済はここに入らないので、モンテカルロで別に測る。

```
委託保証金維持率 = ( 現金 + 代用有価証券評価額×掛目0.80 + 建玉評価損益 ) / 建玉合計notional
                   < 0.20 で追証（DEFAULT_MAINTENANCE）

先物 SPAN       = 枚数 × SPAN証拠金（変動。パラメータ。代用有価証券可）
                   毎日の値洗いで現金決済される点が信用と異なる（キャッシュ管理が要る）
```

**ヘッジ特有の罠**: ヘッジは σ_p を下げるが、**代用有価証券は銀行株そのもの**なので、
市場が下がると分母（建玉 notional）は減らないのに分子（代用評価額）が減る。
`x_M ≈ 0` にしても**維持率のボラティリティはゼロにならない**。これを経路で見せる。

**刻み**: 先物は `枚数 = round(h·V / (指数レベル×1,000))`。元本 1,000万・指数 2,900 なら 1枚=290万で
Δh = 0.29。**h\* が 0.15 だったら「作れない」**。実現可能な h の格子を薄い縦線で描く。

---

## 3. 何がわかるか ─ 出力と問いの対応

| # | 投資家の問い | 出力 | 答えの型 |
|---|---|---|---|
| H0 | **そもそもヘッジすべきか** | 【H-4】【H-5】の損益分岐 π_M と、自分の π_M の位置 | 「π_M が X% 未満だと思うならヘッジ。あなたの入力は Y%」 |
| H1 | 最適な (L, h) はいくつか | 【H-1】【H-2】の閉形式 ＋ g(L,h) 等高線 | 具体的な倍率2つと、その g |
| H2 | ヘッジ手段を持つことの価値は | g(L\*,h\*) − g(L\*_noHedge, 0) | 年率 pp の1つの数字 |
| H3 | 先物と信用売りのどちらか | キャリー内訳の比較・刻み・税区分・元本の交点 | 手段の名前と「元本 X 万円以上なら先物」 |
| H4 | 何%のコストがかかるか | κ の内訳ウォーターフォール（金利/貸株料/逆日歩/配当/税） | 年率の内訳 |
| H5 | ヘッジは本当に効くか | 先読みなしヘッジ後の実現β・上下非対称 c⁻/c⁺ | 効かないなら赤。**これが最重要の検定** |
| H6 | 追証で飛ばないか | 円建てMCの追証確率・破産確率・維持率の経路 | 確率と、最悪経路の絵 |
| H7 | 純度はどこまで上がるか | 純度(h) 曲線 | 参考値。**目的関数ではないことを明記** |
| H8 | 過去に効いていたか | 先読みなしヘッジ後の資産曲線 vs 無ヘッジ | 時系列（lightweight-charts） |

---

## 4. 実装仕様

### 4.1 新規: `app/lib/rakuten-futures.ts`（先物コストの単一ソース）

`rakuten-margin.ts` と同じ流儀。**値は実装時に公式ページで確認して埋め、出典 URL をヘッダに書く。
確認できない項目は `// 要確認` を残したまま既定値を置き、UI でパラメータとして開く。**

```ts
export type FuturesProduct = "topixMini" | "topixLarge" | "nikkeiMini" | "nikkeiMicro";

export interface FuturesSpec {
  label: string;
  multiplier: number;      // 1枚 = 指数 × multiplier 円（ミニTOPIX = 1,000 / TOPIX = 10,000）
  commissionPerLot: number;// 片道手数料（円/枚・税込）  // 要確認
  spanMarginPerLot: number;// SPAN証拠金の目安（円/枚）  // 要確認・変動
  rollsPerYear: number;    // 限月ロール回数（四半期限月なら 4）
  underlying: "TOPIX" | "N225";
}

export const FUTURES_SPECS: Record<FuturesProduct, FuturesSpec>;
export const SUBSTITUTE_HAIRCUT = 0.80;       // 代用有価証券の掛目
export const DEFAULT_ROLL_SLIPPAGE = 0.0010;  // ロール滑りの年率（既定 0.10%）
export const DEFAULT_RISK_FREE = 0.0075;      // 無リスク金利（要更新・UI スライダー）
export const DEFAULT_INDEX_DIV_YIELD = 0.022; // TOPIX 配当利回り（要更新・UI スライダー）

export function lotsFor(notional: number, indexLevel: number, p: FuturesProduct): number;
export function achievableHedgeGrid(V: number, indexLevel: number, p: FuturesProduct, hMax: number): number[];
```

### 4.2 `app/lib/sector-market-hedge.ts`（計算層）

```ts
// ── 入力 ───────────────────────────────────────────────────────────────
export type HedgeInstrument = "futures" | "marginShort";

export interface HedgeParams {
  // 見立て（測れない量。必ずスライダーで開く）
  piM: number;            // 株式リスクプレミアム 年率（既定 0.05）
  m: number;              // セクター因子のドリフト 年率（既定 0.03）
  // 市場環境
  riskFree: number;       // r（既定 DEFAULT_RISK_FREE）
  indexDivYield: number;  // q（既定 DEFAULT_INDEX_DIV_YIELD）
  indexLevel: number;     // 先物の刻み計算用。1306.T の最新値から換算 or 直接入力
  // 手段
  instrument: HedgeInstrument;
  futuresProduct: FuturesProduct;
  marginKind: MarginKind; ratePlan: RatePlan;   // rakuten-margin.ts
  gyakuHibu: number;      // 逆日歩の年率（既定 0.003 / ストレス 0.02）
  dividendAdjRatio: number; // 配当落調整金の支払い率（制度 0.84685・一般 1.0）  // 要確認
  rollSlippage: number;
  // 税
  taxOn: boolean; taxModel: "netted" | "realized"; taxRate: number; carryRecovery: number;
  // 建玉
  capital: number;        // 元本 V（円・既定 10_000_000）
  useDiscreteGrid: boolean;
  maxLeverage: number;    // 既定 MAX_LEVERAGE = 3.3
  // 推定
  window: number;         // P1 と同じ既定 750
  rollWindow: number;     // §2.6 のローリング c（既定 250）
  seed: number; nPaths: number; blockLen: number;
}

// ── 推定された市場環境（実測。仮定ではない）─────────────────────────────
export interface HedgeEnv {
  c: number; cSe: number;          // 加重市場β（P1 のウェイトで合成）
  b: number; bSe: number;          // 加重セクターβ
  sigmaM: number; sigmaF: number; sigmaEps: number;  // 年率
  purity0: number;                 // h=0 の純度（分散ベース）
  basketRet: number[];             // バスケットの日次超過リターン（先読みなし検証で使う）
  marketRet: number[]; dates: string[];
}

// ── キャリー ────────────────────────────────────────────────────────────
export interface CarryBreakdown {
  financing: number;       // 先物: 0 / 信用売り: +r（機会損失）
  borrowFee: number;       // 貸株料
  gyakuHibu: number;
  dividendCredit: number;  // 負の値（戻り）
  adminFee: number;
  slippage: number;        // ロール滑り＋手数料
  taxDrag: number;
  total: number;           // κ_h
}
export function hedgeCarry(env: HedgeEnv, p: HedgeParams, h: number): CarryBreakdown;

// ── 最適点（閉形式）──────────────────────────────────────────────────────
export interface OptimumPoint {
  L: number; h: number; xM: number; xF: number;
  mu: number; sigma: number; g: number; purity: number;
  feasible: boolean; binding: "none" | "leverage" | "margin" | "grid";
}
export function optimalPoint(env: HedgeEnv, p: HedgeParams): OptimumPoint;      // 【H-1】【H-2】
export function optimalNoHedge(env: HedgeEnv, p: HedgeParams): OptimumPoint;    // §2.2
export function breakEvenPiM(env: HedgeEnv, p: HedgeParams):
  { anyHedge: number; fullHedge: number; mThreshold: number };                  // 【H-3】【H-4】【H-5】

// ── 面と断面 ────────────────────────────────────────────────────────────
export interface GridPoint { L: number; h: number; g: number; sigma: number; purity: number; feasible: boolean }
export function gSurface(env: HedgeEnv, p: HedgeParams, Ls: number[], hs: number[]): GridPoint[][];
export function hSweep(env: HedgeEnv, p: HedgeParams, L: number, hs: number[]): GridPoint[];
export function piMSweep(env: HedgeEnv, p: HedgeParams, piMs: number[]): { piM: number; hStar: number; LStar: number }[];

// ── 効くかどうかの検定（§2.6）───────────────────────────────────────────
export interface HedgeEfficacy {
  rollC: { date: string; c: number; se: number }[];
  trust: number;                    // 1 − sd_t(c)/mean_t(SE)。負なら c は時変
  oosBeta: number; oosBetaSe: number; oosBetaT: number;   // 先読みなしヘッジ後の実現β
  cUp: number; cDown: number; asymT: number; asymP: number;
  bPreserved: number; bPreservedSe: number;
  hedgedEquity: { time: string; value: number }[];        // 先読みなしヘッジ後の資産曲線
  rawEquity: { time: string; value: number }[];
  hedgedMaxDD: number; rawMaxDD: number;
}
export function computeEfficacy(env: HedgeEnv, p: HedgeParams): HedgeEfficacy;

// ── 円建てモンテカルロ（Worker へ）────────────────────────────────────────
export interface MarginSim {
  pMarginCall: number; pRuin: number;
  maintenanceP05: number;            // 維持率の5%分位
  medianTerminal: number; p05Terminal: number;
  worstPath: { day: number; ratio: number }[];
}
export function simulateMargin(env: HedgeEnv, p: HedgeParams, L: number, h: number): MarginSim;

// ── 本体 ────────────────────────────────────────────────────────────────
export interface MarketHedgeResult {
  env: HedgeEnv; params: HedgeParams;
  carryFutures: CarryBreakdown; carryMargin: CarryBreakdown;
  opt: OptimumPoint; optNoHedge: OptimumPoint; hedgeValue: number;   // g 差（年率）
  breakEven: ReturnType<typeof breakEvenPiM>;
  surface: GridPoint[][]; sweep: GridPoint[]; piMCurve: ...;
  efficacy: HedgeEfficacy;
  achievableH: number[];             // 先物の刻み
  crossoverCapital: number;          // 先物が信用売りに勝つ元本の下限
  verdict: { level: "hedge" | "neutral" | "noHedge"; label: string; sentence: string };
  warnings: string[];
}
export function computeMarketHedge(
  pricesByTicker: Record<string, PricePoint[]>,
  factors: FactorPrices,
  weights: { ticker: string; weight: number }[],   // P1 の採用ウェイト
  params: Partial<HedgeParams>,
): MarketHedgeResult | null;
```

### 4.3 アルゴリズム（逐次）

```
1. buildPanel(pricesByTicker, factors.market, factors.sector, window)    ← 書き直さない
2. バスケット日次リターン = Σ_i w_i · panel.ret[i]                        ← P1 の weight をそのまま使う
3. F = orthogonalize(sector or leaveOneOut, panel.market)                ← P1 と同じ因子定義
4. olsNW(basket, [market, F]) → c, b, σ_ε,p / std で σ_M, σ_F（年率化 ×√252）
5. hedgeCarry を先物・信用売りの両方について計算（h 非依存の年率）
6. optimalPoint / optimalNoHedge / breakEvenPiM（閉形式・即時）
7. gSurface: L ∈ [0, maxLeverage] 41点 × h ∈ [−1.5, 1.5] 61点 = 2,501点（閉形式・1ms 未満）
8. computeEfficacy: ローリング c（250日窓・21日ステップ）＋ 先読みなしヘッジ系列
9. simulateMargin: Worker。ブロック・ブートストラップ（blockLen=21）で
   バスケットと市場の**同時**リサンプル（相関を壊さない）→ 円建て維持率の経路
```

**手順9で必ず守ること**: バスケットと市場は**同じ日付インデックスで一緒に**リサンプルする。
別々にブートすると相関が壊れ、ヘッジが効きすぎる方向に偏る（C29 の残差相関で踏んだのと同型の罠）。

### 4.4 計算量と Worker

| 処理 | 規模 | 場所 |
|---|---|---|
| 閉形式の最適点・面・掃引 | 2,500点 × 数十 flops | メイン（即時） |
| ローリング c | 750/21 ≈ 36 窓 × OLS | メイン（<50ms） |
| 先読みなしヘッジ系列 | 2,400日 × OLS(250) | メイン（<200ms） |
| **円建てMC** | h 31点 × 2,000経路 × 750日 ≈ 4.6億ステップ | **Worker 必須** |

MC は**全格子ではやらない**。(a) 推奨点、(b) 現在の L における h 断面（31点）、(c) 無ヘッジの基準点、
の3系統に限る。それでも重ければ経路数を 1,000 に落とし、進捗を出す。
Worker の手本は `sector-factor-stability.worker.ts`（`computeBreaks` を呼ぶだけの薄い層）。

### 4.5 描画仕様（CLAUDE.md の規約に従う）

| 図 | 方式 | 理由 |
|---|---|---|
| ヘッジ後/無ヘッジの資産曲線・維持率の経路 | **lightweight-charts** | 横軸が時間 |
| ローリング c の帯 | **lightweight-charts** | 横軸が時間 |
| g(L,h) 等高線ヒートマップ | Canvas2D | 横軸が時間でない |
| h 掃引の g/σ/純度の3本線 | Canvas2D | 同上 |
| π_M → h\* の写像曲線 | Canvas2D | 同上 |
| κ の内訳ウォーターフォール | Canvas2D | 同上 |
| 実現可能な h の格子（先物の刻み） | Canvas2D の縦線オーバーレイ | 同上 |

等高線には**現在地ドット**（L=1, h=0 ＝いまの銀行バスケット）と**推奨点**を必ず両方置く。
`GrowthIntuitionPanel` / `CorrelationDragChart` の「崖の上のドット」と同じ言語にする。

### 4.6 UI 操作（すべて localStorage 永続化・分析ID `pf-sector-select` の名前空間）

```
[見立て]   π_M スライダー 0〜8%（既定 5%）   m スライダー 0〜8%（既定 3%）
[市場]     r 0〜3%（既定 0.75%）             q 0〜4%（既定 2.2%）
[手段]     先物ミニ / 先物ラージ / ETF信用売り（制度・一般無期限・一般短期）
[コスト]   逆日歩 通常/ストレス   ロール滑り   税 ON/OFF・Model A/B
[建玉]     元本（円・既定1,000万）  刻み制約 ON/OFF   最大レバ（既定3.3）
[表示]     等高線 g / σ / 純度 の切替
```

**既定値で開いた瞬間に §2.3 の結論（h\*<0）が見える**ようにする。スライダーを動かさないと
結論が出ない設計にはしない。

### 4.7 統合先と挿入位置

`SectorFactorSelectChart.tsx` の中、**P2 パネル（`SectorFactorStabilityPanel`）の直後**。
理由: P2 が「選別の順位は使ってよい」と結論した直後に「ではその束の市場露出をどうするか」が来るのが
読みの順序として自然。P2 と同じく、

```tsx
// ── ★1: 市場ヘッジの層（docs/sector-market-hedge.md §4.7）──
const [hedgeControls, setHedgeControls] = useState<HedgeControls>(DEFAULT_HEDGE_CONTROLS);
const hedge = useMarketHedge(activePrices, factorPrices, result?.assets, hedgeControls, activeCount >= 3);
…
<HedgeVerdictBadge state={hedge} />        // 順位表の直前（P2 バッジの隣）
<SectorMarketHedgePanel state={hedge} />   // P2 パネルの直後
```

`useMarketHedge` は P2 の `useSectorStability` と同じ形（`setTimeout(0)` でメイン描画の後ろへ退避、
MC のみ Worker）。`/portfolio` の `pf-sector-select` の `subtitle` に【★1 市場ヘッジ】の節を追記する。

---

## 5. トレードにどう生かすか ─ 出力される3つの文

画面の最上段に、**必ず1文で**出す。

```
① 「π_M を 5.0% と見るなら、最適は L=0.6 / h=−0.2（＝ヘッジせず市場を少し買い増す）。
    いまの L=1, h=0 との g 差は +0.4pp/年。ヘッジ手段を持つことの価値は +0.1pp/年。」

② 「完全ヘッジ（h=1.27）が得になるのは π_M < 1.4%（先物）/ 0%未満（ETF信用売り）のとき。
    あなたの入力 5.0% はどちらの閾値も超えているので、ヘッジは g を 4.9pp/年 削る。」

③ 「ただし市場下落日の c⁻ = 1.52 は c⁺ = 1.13 より有意に大きい（t=2.8）。
    ヘッジしない場合、暴落時の実効市場βは 1.27 でなく 1.52 として建玉を決めること。」
```

③ が本層で最も実務的な出力になる可能性が高い。**ヘッジしないという結論でも、
「暴落時に自分が実際に何倍の市場を持っているか」は変わらず知る必要がある**からだ。

---

## 6. AnalysisGuide に書くこと（CLAUDE.md の7項目）

1. **手法の概要**: 銀行バスケットは市場βとセクターβが固定比で溶接された1本の賭け。
   ヘッジ手段はこの溶接を外し、2つの賭けを独立にサイジングできるようにする。
2. **数式**: §1.2 の分解、【H-1】〜【H-5】をすべて導出込みで（Sherman–Morrison は不要、
   偏微分2本で閉じる）。§2.4 の先物キャリー `−dF/F = −R_M` は必ず途中式を残す。
3. **専門用語**: ヘッジ比・ベーシス・限月ロール・逆日歩・配当落調整金・代用有価証券・掛目・
   委託保証金維持率・SPAN・申告分離課税・分離定理・株式リスクプレミアム。
4. **直感的な例え**: 「銀行株は『TOPIX 1.27 個 ＋ 銀行ファクター 0.97 個』が
   はがせないセット割で売られている状態。先物はこのセットをばらすハサミ。
   ただしハサミの使用料が年1〜2%かかる。」
5. **読み方**: 「π_M スライダーを自分の見立てに合わせる。そこで h\* が負なら、
   あなたの見立ての下ではヘッジではなく買い増しが正しい。」
6. **投資判断への活用**: ①手段の選択（元本が小さいうちは信用売りしか刻めない）
   ②暴落時の実効β ③追証確率から逆算する L の上限。
7. **注意点・限界**: π_M も m も**測れない**（C26）。本層は測れない量から結論への写像を描くだけで、
   写像の入力は投資家が外から持ち込む。κ とロール滑りは実測値でなく既定値。
   税の扱いは概算であり税務アドバイスではない。

---

## 7. 落とし穴チェックリスト（実装時に必ず潰す）

1. **adjClose を先物に流用しない**。先物売りは `−R_M`（超過）であって `−TR_M` ではない（§0.5・§2.4）。
2. **配当落調整金の 15.315% を忘れない**。忘れると信用売りのキャリーを 0.34%/年 過大評価する。
3. **ブートは市場とバスケットを同時にリサンプル**する。別々だと相関が壊れヘッジが効きすぎる。
4. **h<0 を描けるようにする**。既定の結論が h\*<0 になる公算が高い。負を切ると自分の結論を隠す。
5. **純度を目的関数にしない**。純度は h を上げれば必ず上がる（分母が減るだけ）。目的は g。
6. **c を全期間推定で先読みしない**。§2.6 (ii) の検証は必ずその時点までの窓のみ。
7. **代用有価証券の値洗い**を忘れない。市場が下がると担保も下がる。維持率の分子は動く。
8. **先物の刻み**を「連続の h に丸める」だけで済ませない。元本が小さいと h\* が作れないことがある。
9. **σ_M の窓依存**。P2 が b の水準は 2021-09 前後で別レジームと示した。c と σ_M も同じ疑いがあるので
   期間分割を既定表示にする（P2 の supWald 結果を再利用できるならする）。
10. **税は断定しない**。パラメータとトグルで示し、「税務上の助言ではない」を明記。
11. **多重検定**: 手段×税モデル×逆日歩の組合せ数 M を数え、§2.6 の検定は BH-FDR で補正。
    `test-ledger.ts` に記録する。
12. **1306.T の価格破損**（P0 で踏んだ）。因子は `useBenchmarkPrices` で取り、
    `DataQualityNotice` を出す。ヘッジ対象の系列でもあるので開示は必須。

---

## 8. 受け入れ基準

1. `computeMarketHedge` が sec-bank・窓750日で **500ms 以内**（MC を除く）に返る。MC は Worker で 3s 以内。
2. **h=0 の断面が P1 の実測と一致**する（c=1.27・b=0.97・純度34%）。ずれたらウェイト合成が間違っている。
3. **【H-1】の数値解と閉形式が一致**する（格子探索の argmax と `optimalPoint` の差が h で 0.05 以内）。
4. **π_M = c·σ_M²/2 − κ で g(h=c) = g(h=0) が成立**する（【H-5】の検算をテストに入れる）。
5. 先物と信用売りのキャリー差が **1.3〜2.0%/年**の範囲に入る（外れたらパラメータの単位ミス）。
6. 元本 1,000万・ミニTOPIX で **achievableH の刻みが 0.28〜0.30** になる。
7. 先読みなしヘッジ後の実現βが、**|t| < 2 ならヘッジ成立・それ以上なら赤**として正しく判定される。
8. 逆日歩をストレス（2.0%）にすると、信用売りの【H-5】閾値が負のまま**さらに下がる**。
9. `npx tsc --noEmit` と対象ファイルの eslint がクリーン。

---

## 9. 想定される結論と、そのときの行動

**この層は「ヘッジするな」で終わる公算が高い。それは失敗ではない。**

| 判定 | 条件 | 画面 | 行動 |
|---|---|---|---|
| **noHedge**（既定と予想） | π_M > c·σ_M²/2 − κ、かつ h\* ≤ 0 | 「あなたの π_M ではヘッジは g を削る。市場露出 1.27 は最適 x_M\*=2.03 より**むしろ低い**」 | ヘッジ層は封印。ただし §2.6(iii) の暴落時 c⁻ は建玉判断に持ち帰る |
| **neutral** | h\* が 0 付近、または先物の刻みで作れない | 「理論上は h=0.15 だが、元本 1,000万では最小 0.29。作れない」 | 元本が増えるまで保留。交点の元本額を表示 |
| **hedge** | π_M < 【H-4】、かつ実現βが有意にゼロ、かつ追証確率が許容内 | 推奨 (L\*, h\*) と手段・枚数・円建てコスト | 実行手順を1枚に出す |
| **broken** | §2.6 の実現β \|t\|>2、または c⁻ ≫ c⁺ | 「ヘッジは平時にしか効いていない」 | ヘッジ量を c⁻ 基準へ引き上げるか、封印 |

> **noHedge のとき、この層の成果は「σ を下げなくてよいと確認したこと」＋「暴落時の実効βを知ったこと」**。
> P2 が「ウェイトを動かさなくてよいと確認したこと」に価値を見出したのと同じ構造で、
> **`DriftIdentifiabilityChart` の誠実な既定結果の見せ方を手本にする。**

---

## 10. 実装順序（価値 ÷ コストで並べた）

| 手順 | 内容 | 依存 | 工数 | なぜこの順か |
|---|---|---|---|---|
| **H-1** | `rakuten-futures.ts` ＋ `hedgeCarry`（両手段のキャリー内訳） | なし | 小 | **これ単体で §2.1【H-3】の閾値が出る**。以降の全層の入力 |
| **H-2** | `HedgeEnv` の推定（c/b/σ を P1 ウェイトで合成）＋ 閉形式の最適点・損益分岐 | H-1 | 小 | **ここで結論が出る**。h\*<0 なら以降は補強材料でしかない |
| **H-3** | g(L,h) 面・h 掃引・π_M 写像の3図 | H-2 | 中 | 「見立て → 結論」の写像を目で見せる本体 |
| **H-4** | §2.6 の効くかどうか検定（ローリング c・先読みなしβ・上下非対称） | H-2 | 中 | **h\* の符号と無関係に価値がある**（暴落時の実効β）。H-3 より先でもよい |
| **H-5** | 円建てMC（追証・破産・刻み）＋ Worker | H-2 | 大 | 吸収壁は閉形式に入らない。最後 |
| **H-6** | 税ドラッグの Model A/B | H-1 | 小 | トグルで後付けできる。断定しないので最後でよい |

> **H-2 が終わった時点で一度立ち止まること。** h\* が明確に負なら、H-5（MC）の価値は大きく下がる
> （建てない建玉の追証確率を精密に測っても仕方がない）。一方 **H-4 は h\* の符号と無関係に必要**なので、
> h\*<0 でも必ず実装する。

### 完了時に更新するもの

- `docs/sector-factor-selection.md` に **§8e「★1 実装記録」**を追記（§8b/§8c/§8d と同じ形式）
- 本書に **§12 実装記録**（設計からの変更点をすべて実測理由つきで）
- `app/lib/axioms/corollaries.ts` に **系C30** を追加（§11）
- `/portfolio` の `pf-sector-select` の `subtitle` に ★1 の要素を追記
- memory `sector-factor-selection.md` に h\* の実測と結論を追記（新規 memory は作らず既存に足す）

---

## 11. 原論への追記案 ─ 系C30

`docs/investment-axioms.md` 第5部の表に、C29 の直後に置く。**C30 は空き番**（現在 C29 まで、C27 は予約済み）。

| 系 | 既存理論 | 立脚する公準/命題 | 測る P の性質 → 変える q の選択 | 実装 |
|---|---|---|---|---|
| C30 | ファクター露出の分離（ヘッジによる建玉ベクトルの完備化） | 公準4＋公理5／C7・C22・C24・C29 | 資産の因子感応度 (c, b) が固定比で溶接されていること → **市場露出 x_M とセクター露出 x_F を独立に置く (L, h)** | SectorMarketHedgePanel |

補足文:

> **C30 は C7（最小分散ヘッジ）を目的から手段へ引き下げる。** C7 は「分散を最小にする h は −β」と述べるが、
> 分散最小化は目的ではない（公理5 の吸収壁が無い限り、目的は成長率 g = μ − σ²/2）。
> 個別資産は因子感応度ベクトル (c_i, b_i) を持ち、現物のみの建玉ではその**比 b/c が固定**される。
> ヘッジ手段（空売り・先物）を加えると建玉空間が張り直され、(L, h) の2自由度で
> `x_M = Lc − h`・`x_F = Lb` を独立に選べるようになる。このとき g の一階条件は分離し、
> **x_M\* = (π_M + κ)/σ_M²（C24 の参加の水準そのもの）、L\* = (bm − cκ − ι)/(b²σ_F² + σ_ε²)** となって
> **L\* から π_M が消える**。ゆえにヘッジの価値は「リスクを消すこと」ではなく
> 「2つの賭けを別々の水準に置けること」にある。ただし手段にはキャリー κ が伴い、
> κ は完全ヘッジの損益分岐 π_M < cσ_M²/2 − κ を直接押し下げる。
> 日本株の実測（銀行5本: c=1.27, σ_M≈16%）では閾値は 1.4%/年 前後にすぎず、
> **株式リスクプレミアムを通常の水準と見るかぎり最適 h は負**（＝市場を減らすのではなく増やす）になる。
> C30 の実務的帰結は「ヘッジは σ を下げる道具ではなく、露出を分解する道具であり、
> π_M の見立てが低いときにだけ買う価値のある道具」である。

---

## 12. 実装記録（H-1 / H-2 / H-4 ─ 2026-08-08）

**状態: 計算層は H-1・H-2・H-4 が完了。描画層（`SectorMarketHedgePanel.tsx`）は未着手。**
新規 `app/lib/rakuten-futures.ts` / `app/lib/sector-market-hedge.ts` の2ファイルのみ。
既存ファイルは1つも変更していない。

### 12.1 実測値（sec-bank / 窓750日 / 2023-07-12〜2026-08-07 / 因子 1306.T・1615.T・^TNX）

```
c = 1.286 ± 0.033      b = 0.963 ± 0.048      純度(h=0) = 34.0%
σ_M = 21.1%   σ_F = 20.2%   σ_ε,p = 8.9%      n = 750
buildHedgeEnv + 閉形式一式 14ms / computeEfficacy 89ms
```

**σ_M が設計時の想定 16% ではなく 21.1% だった。** σ_M² は【H-4】【H-5】に線形に効くので、
損益分岐はすべて設計書 §2.3 の表より高い側にずれた（＝ヘッジ寄りになった）。

| | 先物ミニTOPIX | ETF信用売り（制度） |
|---|---|---|
| κ | **0.112%** | **2.124%** |
| 【H-3】必要な金利観 m > | 0.15% | 2.84% |
| 【H-4】少しでも売るべき π_M < | **5.61%**（設計 3.05%） | 3.60% |
| 【H-5】完全ヘッジが得 π_M < | **2.75%**（設計 1.43%） | 0.74% |
| π_M=5% での h\* | **−0.247** | **0.000**（不動帯） |
| L\* | 0.662 | 0.780 |
| ヘッジ手段を持つ価値 | **+0.052pp/年** | **0.000pp/年** |

κ の内訳（年率）:

```
先物ミニ    ロール滑り0.100% + 手数料0.012%                                    = 0.112%
ETF信用売り r 0.750% + 貸株料 1.100% + 逆日歩 0.300% + 事務管理 0.311%
            − 配当落調整金の戻り 0.337%                                        = 2.124%
一般短期    r 0.750% + 貸株料 3.900% + 事務管理 0.311% − 戻り 0.337%           = 4.624%
逆日歩ストレス(2.0%)                                                            = 3.824%
ETF信用買い(h<0)  買方金利−r 2.050% + 配当取りっぱぐれ 0.337% + 事務管理 0.311% = 2.697%
```

**判定 = noHedge。** π_M=5% は【H-5】2.75% を大きく上回り h\*≤0。ただし π_M<3.9% と見るなら
h\* は正に転じるので、設計書が予想した「どんな π_M でもほぼ無理」よりヘッジ寄りの結論。

### 12.2 H-4 の実測（§2.6 の4検定）

```
(i)   ローリング c（250日窓・21日ステップ・25窓）
        c の範囲 0.969〜1.408   sd 0.089   平均SE 0.045   trust = −0.979  → c は時変
(ii)  先読みなしヘッジ後の実現β（OOS 500日 2024-07-19〜2026-08-07）
        建てた h_t = ĉ_{t−1}: 平均 1.333 / sd 0.069
        実現β = 0.0446 ± 0.1008   t = 0.44   p = 0.66   → |t|<2 でヘッジ成立
(iii) 上下非対称   c⁺ = 1.286   c⁻ = 1.223   δ = −0.063   t = −0.98   p = 0.328
(iv)  b 保存      無ヘッジ b(OOS) 0.941 ± 0.065 → ヘッジ後 0.968 ± 0.071   差の t = 1.27
資産曲線(OOS)  無ヘッジ 終値2.173 σ37.9% MaxDD −32.0%
               ヘッジ後 終値1.234 σ22.0% MaxDD −21.0%   （σ −42% だがリターンはもっと削れる）
```

> **【最重要】設計書 §5 の出力文③は書き換えが必要。**
> 設計書は「c⁻=1.52 > c⁺=1.13 なので暴落時の実効βは 1.27 でなく 1.52」という文を想定しているが、
> **実測は c⁻ = 1.223 < c⁺ = 1.286 で符号が逆・非有意（t=−0.98）**。
> P2 が個別銘柄の *b* で見つけた暴落増幅（みずほ・りそな・千葉銀）は、
> **バスケットの市場β c には伝播していない**。「暴落時にβが膨らむ証拠は無い」が誠実な既定文。

> **trust が負なのに実現βは成立、という組み合わせの見せ方が H-3 の設計課題。**
> 「c は動くが、その動きは方向を持たないので平均的には相殺される」。
> ローリング c の帯と実現βの t を**並べて**出さないと、片方だけ見た読者が誤読する。

### 12.3 設計書からの変更点（すべて実測が理由）

1. **κ を sign(h) で切り替えた（最重要）。** 【H-1】を `x_M*=(π_M+κ)/σ_M²` のまま h<0 に使うと
   「ヘッジ手段が高いほど市場を買い増すべき」という逆向きの結論が出る（実測: 信用売り κ=2.12% の方が
   先物 κ=0.11% より x_M\* が大きくなる）。h<0 の実体は市場の**買い**なのでコスト内訳も別物。
   ゆえに `∂g/∂h = −π_M − sign(h)·κ + (Lc−h)σ_M²` とし、h>0 / h<0 / 不動帯の3領域に分けた。
   【H-2】も領域ごとに `L* = (bm ∓ cκ − ι)/D`。**既定の結論 h\*<0 はまさにこの領域で出るので、
   ここを直さないと結論そのものが歪む。** 格子総当たりとの一致（|Δh|=0.0028）はこの定式化で取れている。
2. **事務管理費が設計書の8倍。** 1306.T の実勢は **425円**（設計は3,000円想定）なので
   `0.11/425×12 = 0.311%/年`。κ_margin の 15% を占める。受け入れ基準5（κ差 1.3〜2.0%）が
   **2.012% と 0.012pp はみ出した唯一の原因**で、単位ミスではない（3,000円想定に戻すと 1.745% で枠内）。
3. **逆日歩は制度信用にだけ課す**（一般信用は逆日歩なしで貸株料が高い）。
4. **税ドラッグは φ(0) 近似でなく E[X⁺] で厳密評価。** 設計書の `τ·h·σ_M·φ(0)` はドリフトを落とすため
   売り建てで約3割過大（π_M=5%,σ_M=21% で 1.30% vs 実際 0.92%/単位h）。既定 `taxOn=false`。
5. **trust から横断平均を抜かない。** P2 の `computeDecision` は「銀行全体で b の水準が揃って動いても
   順位＝選別は損なわれない」ので共通成分の除去が正しかった。★1 には横断が無く、
   **ヘッジ量は c の水準そのもの**なので、共通の水準変化こそが効かないヘッジの原因になる。
6. **ローリング c は窓内で F を直交化し直す**（`HedgeEnv.sectorRetRaw` を追加）。全標本の
   `env.factorRet` を使うと直交化の係数を通じて未来が漏れる。なお窓内で直交化すれば F ⊥ M なので
   3変数回帰の M 係数は単回帰の市場βと厳密に一致する（3変数で回すのは SE を P1 の定義に揃えるため）。
7. **(iii) は M の符号で割る。** P2 の `computeAsymmetry` の `mSign` は交互作用が `F·D` なので
   「市場下落日の *b*」を測っている。★1 が要るのは「市場下落日の *c*」＝交互作用 `M·D`。
   検定形式（水準ダミー同時投入・NW・両側 student p・df=n−5）は P2 と同一。
8. **`oosAvailable` と判定 `unknown` を追加。** `hedgeHolds = |t|<2` だけだと、標本が足りず検定力が
   ゼロのときに**偽の緑**が出る（退化した因子で n=0・t=0.00 の緑を実際に踏んだ）。OOS 120日未満は
   `unknown`（「ゼロと整合したのではなく何も言えていない」）に落とす。
9. **静的な証拠金充足チェック**（`OptimumPoint.feasible` / `binding="margin"`）。代用有価証券の掛目0.80と
   委託保証金率30%／SPAN率で「そもそも建てられるか」だけを見る。追証の経路は H-5 のまま。
10. **資産曲線は算術（単利）で積む。** 対数リターンの線形結合 `logB − ĉ·logM` は建玉の実損益ではない。
    `expm1` で単利に直してから合成し、日次キャリー `|h_t|·κ/252` を控除する（β 回帰は対数のまま）。
11. **型のフィールド追加**: `HedgeEnv` に `factorRet` / `sectorRetRaw` / `nObs` / `dateFrom` / `dateTo` /
    `usedWeights` / `etfRefPrice` / `factorSource` / `warnings`。
    `HedgeEfficacy` に `oosBetaP` / `oosN` / `oosFrom` / `oosTo` / `oosAvailable` / `meanHedgeRatio` /
    `sdHedgeRatio` / `bRawOos` / `bRawOosSe` / `bDriftT` / `bDriftP` / `qValues`（3検定の BH-FDR）/
    `hedgedVol` / `rawVol` / `hedgeHolds` / `asymBroken` / `warnings`。

### 12.4 受け入れ基準（§8）の結果

| # | 結果 |
|---|---|
| 1 | ✅ 14ms（500ms以内。MC を除く） |
| 2 | ✅ ウェイト加重平均とバスケット回帰の差 6.7e-16。c=1.29 / b=0.96 / 純度34.0%（P1 記録と一致。差は窓が1週間ずれたぶん） |
| 3 | ✅ 格子argmax との差 \|Δh\|=0.0028（格子刻み 0.01 と同オーダー） |
| 4 | ✅ g(h=c)−g(h=0) = 3.5e-18 |
| 5 | ⚠️ κ差 2.012%（基準 1.3〜2.0% を 0.012pp 超過）。原因は §12.3-2 の事務管理費。単位ミスではない |
| 6 | ✅ Δh = 0.290（**ただし指数水準 2,900 という未確認の既定値の上での合格**。実際の TOPIX が 3,300 なら 0.33 で枠外） |
| 7 | ✅ 合成バスケットで両方向を確認: c 定数→成立 / c が 0.5→2.5 に上昇→赤(t=3.79) / c⁺1.0・c⁻2.0→(ii)は通り(iii)で赤 / OOS 60日→unknown |
| 8 | ✅ 逆日歩ストレスで【H-5】0.74% → −0.96%、一般短期 → −1.76% |
| 9 | ✅ tsc・eslint クリーン |

### 12.5 未確定の前提（`// 要確認` を残した定数）

| 定数 | 既定値 | 未確定の理由 |
|---|---|---|
| `FUTURES_SPECS[*].commissionPerLot` | ミニTOPIX 42円 / ラージ 275円 / 日経mini 42円 / マイクロ 11円 | 楽天証券の先物手数料の公式値を確認できていない。§2.4 の「≈0.02%/年」に合う水準（実測換算 0.012%/年） |
| `FUTURES_SPECS[*].spanMarginPerLot` | 15万 / 150万 / 13万 / 1.3万円 | SPAN は日々改定。`feasible` 判定にしか効かない |
| `DEFAULT_ROLL_SLIPPAGE` | 0.10%/年 | 設計書自身が「実測すべき量」と書いている。**κ_futures の 89% を占める＝先物側の結論はこの1定数に支配されている** |
| `DEFAULT_INDEX_LEVEL` | 2,900 | `^TPX` は `/api/stock` で取れない（"No price data"）。1306.T/1475.T は adjClose なので指数水準に換算できない。**UI で入力させること** |
| `DEFAULT_RISK_FREE` / `DEFAULT_INDEX_DIV_YIELD` | 0.75% / 2.2% | r は κ_margin の 35% を占める |
| `DEFAULT_DIVIDEND_ADJ_RATIO` | 0.84685 | 制度信用の 15.315% 控除。一般信用が 1.0 かは未確認 |
| `DEFAULT_GYAKU_HIBU` / `STRESS_GYAKU_HIBU` | 0.30% / 2.0% | 変動（青天井） |
| ETF の事務管理費 | 11銭/株/月（現物株と同率と仮定） | 名義書換料は ETF だけ 5.5円と別扱いなので、事務管理費も別規定の可能性。**1306.T が低位なので κ_margin の 15% を占める＝優先度が高い** |

### 12.6 残件

| 手順 | 状態 | メモ |
|---|---|---|
| H-1 キャリー | ✅ | `rakuten-futures.ts` + `hedgeCarry` / `carryComparison` |
| H-2 閉形式 | ✅ | `buildHedgeEnv` / `optimalPoint` / `optimalNoHedge` / `breakEvenPiM` / `evaluatePoint` / `bestHGivenL` / `bestLGivenH` / `hedgeGridStep` |
| H-4 効くかの検定 | ✅ | `computeEfficacy` / `efficacyVerdict` |
| **H-3 面と掃引** | ⬜ | `gSurface` / `hSweep` / `piMSweep`。**`evaluatePoint`・`bestHGivenL`・`bestLGivenH` は export 済みなのでそのまま使える** |
| **H-5 円建てMC** | ⬜ | **優先度は低い**。判定が noHedge かつ L\*<1（信用買いすら不要）で、追証を測る対象がない |
| **H-6 税 Model A/B** | ⬜ | 計算は `taxDragRate` に入っている。残りは UI トグルだけ |
| **描画層** | ⬜ | `SectorMarketHedgePanel.tsx`。§4.5〜§4.7 と下の §12.7 |
| 完了時の更新 | ⬜ | §10 末尾のリスト（`sector-factor-selection.md` §8e / `corollaries.ts` の系C30 / subtitle / memory） |

### 12.7 描画層を作るときの必須事項（CLAUDE.md の規約）

**図の方式は CLAUDE.md に従う。**

| 図 | 方式 |
|---|---|
| ヘッジ後/無ヘッジの資産曲線・**ローリング c の帯**・維持率の経路 | **lightweight-charts**（横軸が時間） |
| g(L,h) 等高線ヒートマップ・h 掃引の3本線・π_M → h\* 写像・κ ウォーターフォール・実現可能な h の格子 | **Canvas2D**（横軸が時間でない） |

- **等高線には現在地ドット（L=1, h=0 ＝いまの銀行バスケット）と推奨点を必ず両方置く。**
  `GrowthIntuitionPanel` / `CorrelationDragChart` の「崖の上のドット」と同じ言語にする。
- **`<AnalysisGuide>` は §6 の7項目をすべて埋める**（概要／数式は導出込みで省略しない／専門用語の日本語定義／
  直感的な例え／読み方／投資判断への活用／注意点・限界）。
  §2.4(a) の `−dF/F = −R_M` は途中式を必ず残すこと。書き方は `app/components/analysis/` の既存117件を手本に。
- **π_M スライダーの既定値で開いた瞬間に結論（h\*<0）が見える**こと。スライダーを動かさないと
  結論が出ない設計にしない。
- **h<0 を必ず描けること。** 負を切ると自分の結論を隠すことになる。
- **不動帯を平坦部として描くこと。** κ が sign(h) で切り替わるので π_M → h\* の写像は
  h=0 に平坦部を持つ。ETF信用売りの既定パラメータではこの平坦部が広く、π_M=5% でちょうど h\*=0 になる。
  単調な直線として描くと嘘になる。
- **純度は目的関数ではない**ことを明記（h を上げれば分母が減って必ず上がる）。目的は g。
- 価格は必ず `/api/stock` 経由。因子は `useBenchmarkPrices` で取り `DataQualityNotice` を出す。

---

## 付録: 参照

- 前段: `docs/sector-factor-selection.md`（§8c P1記録・§11.2 ★1 の動機）/ `docs/sector-factor-stability.md`（§12 P2記録）
- 原論: `docs/investment-axioms.md` C7（ベータ/ヘッジ）/ C11（DD制御）/ C21（時間集中）/ C22（レバレッジと追証）/ C24（参加）/ C29（セクター選別）
- コスト規約: `app/lib/rakuten-margin.ts`（信用の単一ソース。**先物版を兄弟として新設する**）
- 再利用する計算: `sector-factor-select.ts`（buildPanel/olsNW/orthogonalize）/ `growth-drag.ts`（g の分解）/
  `nisa-vs-taxable.ts`（円建て清算価値ウォーカー・追証・破産確率・レバ掃引）/ `vol-targeting.ts`（可変レバの枠組み）
- Worker の手本: `sector-factor-stability.worker.ts`
- 描画の手本: `ConditionMarkerChart.tsx`（lightweight-charts）/ `GrowthIntuitionPanel.tsx`（崖の上のドット）/
  `DriftIdentifiabilityChart.tsx`（誠実な既定結果の見せ方）
