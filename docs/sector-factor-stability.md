# P2 設計書 ─ 「この順位は来年も同じか」を測り、建玉に翻訳する

対象: `docs/sector-factor-selection.md`（系C29）の P2。
新規: `app/lib/sector-factor-stability.ts` / `sector-factor-stability.worker.ts` /
`SectorFactorSelectChart.tsx` に L2 層を追加。

---

## §0 コールドスタート用の前提（この節だけで着手できる状態にする）

**新しいセッションはここから読む。** 以降の節は設計の中身なので、まず現状を掴むこと。

### 0.1 いまどこまで出来ているか

| フェーズ | 状態 | 実体 |
|---|---|---|
| **P0 前提診断** | ✅ 完了 (2026-07-30) | 「銀行セクターは金利で動いているか」R²=5.7% / t=4.96 → 前提は成立 |
| **P1 感応度ランキング** | ✅ 完了 (2026-07-31) | b̂±SE・S=b/σ_ε・JS収縮・順位95%CI・w∝b/σ_ε²・市場β並置・純度 |
| **P2 持続性** | ✅ 完了 (2026-07-31) | **π(1年)=0.97 [0.81, 1.03] / 上位5本の1年後生存 84%（ヌル36%）**。実装記録は §12 |
| P3 WF検証 / P4 集中曲線 / P5 残差ローテ / P6 IRRBB | ⬜ 未着手 | `sector-factor-selection.md` §8 |

### 0.2 ファイルの地図

```
app/lib/sector-factor-select.ts            P0+P1 の計算層（P2 はここの部品を再利用する）
app/components/analysis/SectorFactorSelectChart.tsx
                                           P0+P1 の描画（P2 の L2 層はここに追記する）
app/lib/universes.ts                       sec-bank（銀行16行の純ユニバース）
app/lib/axioms/corollaries.ts              系C29（導出鎖7段）
app/hooks/useBenchmarkPrices.ts            因子系列の取得（必ずこれを使う）
app/lib/price-sanity.ts                    価格破損の修復（取得層。触らない）
docs/sector-factor-selection.md            全体設計 + §8b(P0記録) + §8c(P1記録) + §8d(P2記録)
docs/sector-factor-stability.md            ← 本書（P2 設計 + §12 実装記録）
docs/sector-factor-p2-session-record.md    P2 セッション記録（実装済/未実装/発展の一覧・引き継ぎ）
/portfolio の分析ID: pf-sector-select
```

### 0.3 P2 が再利用できる既存 export（`sector-factor-select.ts`）

**これは実測で確認した実際の export 一覧。**新規に書き直さないこと。

```ts
// 型
export type FactorSource = "etf" | "basket";
export interface FactorPrices { market; sector; rate; marketTicker; sectorTicker; rateTicker }
export interface ReturnPanel { tickers; dates; ret; market; basket; etf; survivorsToEnd; droppedForHistory; glitchesFixed }
export interface OlsFit { beta; se; t; resid; r2; sigmaResid; n }
export interface AssetFactorFit { /* P1 の1銘柄ぶんの推定結果 */ }
export interface SectorSelectResult { params; premise; assets; bMean; shrinkFactor; spreadT; … }

// 計算
export function buildPanel(pricesByTicker, market, etf, window): ReturnPanel | null
export function olsNW(y, X, lag = 5): OlsFit | null      // lag=0 で HAC を省略（ブート用）
export function orthogonalize(y, x): number[]            // 市場成分を抜く
export function leaveOneOut(panel, i): number[]          // 自己混入の除去
export function mulberry32(seed): () => number           // 種つき乱数
export function computeSectorSelect(prices, factors, params): SectorSelectResult | null
export const DEFAULT_SELECT_PARAMS: SectorSelectParams
```

検定の共通部品は `app/lib/stats-significance.ts` にある:
`mean` / `std` / `median` / `quantileSorted` / `tTest` / `benjaminiHochberg` / `blockBootstrapCI`。

> **`buildPanel` を自前で書き直さないこと。** 履歴カバレッジ・フィルタ（95%）と
> 価格破損の網が入っており、これを通さないと 5831.T/5830.T（2022年上場）で窓が壊れる。

### 0.4 因子系列の取得（規約・必ず守る）

CLAUDE.md「価格データの取得」に従い、**自前で `fetch` しない**。

```ts
const market = useBenchmarkPrices("1306.T");  // TOPIX ETF
const sector = useBenchmarkPrices("1615.T");  // 東証銀行業ETF
const rate   = useBenchmarkPrices("^TNX");    // 米10年利回り（円金利の代理）
// dataQuality を <DataQualityNotice report={…} /> で必ず開示する（3本ぶん）
```

### 0.5 動作確認の手順（このリポジトリで実際に使った方法）

ブラウザを開かずに実データで数値を確かめられる。**実装中はこれを回す。**

```bash
# 1) dev サーバを立てる（API 経由で価格を取るため）
npx next dev -p 3111

# 2) スクラッチにスモークテストを書いて tsx で実行
#    import は絶対パス "C:/Users/hikar/next/stock-analysis/app/lib/…" で書くと通る
npx tsx <scratchpad>/p2-smoke.ts
```

雛形は P1 で使ったもの（ユニバース取得 → 因子3本取得 → compute → 表を console 出力）。
`docs/sector-factor-selection.md` §8c.2 の表がその出力形式。

**最後に必ず**: `npx tsc --noEmit` と
`npx eslint app/lib/sector-factor-stability.ts app/components/analysis/SectorFactorSelectChart.tsx`。
`app/portfolio/page.tsx` には既存の lint エラーが2件あるが、それは P2 とは無関係（触らない）。

### 0.6 先に知っておくべき落とし穴（P0/P1 で実際に踏んだもの）

1. **パネル内平均の残差から相関を測ってはいけない**。横断中心化すると真の値に関係なく
   平均ペア相関が恒等的に `−1/(N−1)` になる。外生因子（ETF）を使うこと。（§8b.1）
2. **1点の価格破損が全回帰を壊す**。取得層で修復済みだが、`buildPanel` を迂回すると再発する。（§8b.2）
3. **最大−最小から必要年数を逆算しない**。選抜バイアスが最大に乗るので μ が測れるように見える。
   正しくはヌル比較 `E[max−min] ≈ SE·2√(2 ln N)`。（§8c.1）
4. **系番号は C29**。C27 は「時点構成メンバー」用に予約済み。
5. **地銀の新コード**: 静岡FG=5831.T / 京都FG=5844.T / いよぎんHD=5830.T（旧 83xx では取れない）。

### 0.7 P1 が残した数値（P2 の出発点）

```
収縮率 4.6%（750日）/ 3.1%（2400日）      ← b̂ の統計誤差はもう論点ではない
b の上下差 t = 8.2 / 13.4
μ̂ スプレッド 観測58pp vs ヌル96pp（比0.60） ← 過去リターンの順位はノイズと区別できない
全16銘柄の純度 19〜43%、採用5本の加重市場β = 1.27
S 上位: 三菱UFJ(8.05) / みずほ(7.05) / 三井住友(6.94) / りそな(5.71) / 千葉銀(4.97)
b̄ ≈ 0.78（横断平均。§6.1 の二段収縮の中心）
```

---

## 0. なぜこの層が要るのか ─ P1 が残した唯一の問い

P1 で判明したのは、**b̂ の統計誤差はもう論点ではない**ということだった。

```
b の上下差の t = 8.2（750日）/ 13.4（2400日）
James-Stein 収縮率 = 4.6% / 3.1%   ← 見かけの銘柄間差のうちノイズと整合するのは5%未満
```

つまり「今の b を測れるか」は解決済み。にもかかわらず、この順位表を使って発注してよいかは
**まだ何も分かっていない**。理由は、P1 が測ったのが

> 「2023-07 から 2026-07 までの平均的な b」

であって、**明日から先の b ではない**から。両者が同じである保証はどこにもない。
b が動く原因は統計の問題ではなく**実在の経済的変化**である。

- 有価証券デュレーションの短縮／貸出構成の入れ替え（バランスシートは毎期変わる）
- 金融政策レジームの転換（マイナス金利期と解除後で b の水準どころか符号も変わりうる）
- 資本政策・再編（統合、政策保有株の売却、資本増強）

**P2 の存在理由**: 誤差が小さいことは「使える」を意味しない。使えるかどうかは
**持続性**が決める。ここを飛ばして P3（WF検証）に行くと、「なぜ勝てなかったのか」が
「エッジが無い」のか「エッジはあるが b が動いた」のか切り分けられなくなる。

---

## 1. 何を明らかにするのか ─ 4つの問いと、それぞれが変える判断

| 層 | 問い | 出力 | これが変える判断 |
|---|---|---|---|
| **L2-A 持続性** | 今日の b のうち、1年後まで残るのは何割か | 持続率 π(h)・半減期 τ | **チルトの強さ**（等加重からどれだけ離れてよいか） |
| **L2-B 順位安定性** | 今日の上位5本は1年後も上位5本か | rankIC・上位k生存率・遷移行列 | **回転率と銘柄入替の頻度** |
| **L2-C 構造変化** | b は連続的に動いたのか、ある日を境に飛んだのか | 供給内 Wald 検定（データ駆動の分割点）＋政策日オーバーレイ | **推定に使う窓の長さ**（10年窓は長すぎるかもしれない） |
| **L2-D 非対称性** | その b は「金利が上がる日」に出るのか「市場が落ちる日」に出るのか | b⁺/b⁻・市場下落日の b | **その建玉が暴落時に何になるか**（純度19〜43%を踏まえ最重要） |

**この4つは独立ではなく、A→B→C→D の順に「同じ現象を別の解像度で見る」**。
A が本体（連続量としての持続性）、B は A を順位に射影したもの（実務で扱いやすい）、
C は A の前提（定常性）が壊れていないかの検査、D は A を状態別に割ったもの。

---

## 2. L2-A 持続性 ─ この層の本体

### 2.1 分解

観測された b̂ を3つに割る。

```
b̂_{i,t} = β_i + η_{i,t} + e_{i,t}

  β_i     : 恒久成分（銘柄の構造。来期も残る）      ← 選別に使えるのはここだけ
  η_{i,t} : 一時成分（実在するが来期には消える変動）  ← 実在するが使えない
  e_{i,t} : 推定誤差（標本のノイズ）                ← SE(b̂) で既知・P1 で 5% 未満と判明
```

P1 の James-Stein は `e` だけを潰した。**`η` は手つかずのまま残っている。**
「収縮率 4.6%」は「b̂ の散らばりの95%は実在する」と言っただけで、
**そのうち来期も残るのが何割かは何も言っていない。** ここが P1 と P2 の境界。

### 2.2 推定量 ─ 窓をずらした横断共分散

非重複な2つの窓で測った b̂ の、**横断（銘柄方向）の共分散**を取る。

```
Cov_i( b̂_{i,t} , b̂_{i,t+h} ) = Var(β) + Cov(η_t , η_{t+h})
```

推定誤差 `e` は窓が重ならなければ独立なので、**共分散からは自動的に消える**。
これが本手法の要で、`e` を別途モデル化しなくてよい。h を十分大きく取って
`Cov(η_t, η_{t+h}) → 0` なら、共分散はそのまま `Var(β)` の推定になる。

持続率は「今日の散らばりのうち h 日後まで残る割合」として定義する。
分母は**推定誤差を除いた真の散らばり**でなければならない（除かないと減衰バイアスで過小評価）。

```
π(h) = Cov_i( b̂_{i,t}, b̂_{i,t+h} ) / [ Var_i(b̂) − mean_i(SE_i²) ]
```

- `π = 1` … b は完全に恒久的。P1 の順位をそのまま使ってよい
- `π = 0.5` … 半分は消える。**チルトを半分に薄めるべき**
- `π = 0` … 今日の b の散らばりは来期と無関係。**等加重にせよ**
- `π < 0` … 平均回帰。順位を反転させる余地すらある（が、まず疑うべきはデータ）

### 2.3 半減期

`π(h)` を h について並べ、指数減衰でフィットする。

```
π(h) = exp( −h / τ )    →   半減期 h_{1/2} = τ · ln 2
```

τ は**リバランス間隔を決める唯一の物理量**。τ よりずっと短い間隔で回すのはコストの浪費、
τ よりずっと長く放置するのは陳腐化した露出を持ち続けること（§5.2 で最適間隔に落とす）。

### 2.4 【重要】検出力の壁を先に見積もる

N=16 の横断相関なので、**1組の窓ペアから得られる π の標準誤差は約 `1/√(N−3) ≈ 0.28`**。
つまり単発の推定では `π = 0.3` と `π = 0.8` を区別できない。これは実装前に分かる制約。

対策を最初から設計に入れる。

1. **窓ペアを多数使う**。10年・窓250日・ステップ21日なら約100窓、h=250日のペアは約80組取れる。
   ただし窓が重なるので独立ではない。**独立な情報量は非重複ペア数 ≒ 10年/(2×1年) = 5組**に近い。
2. **時間方向のブロック・ブートストラップで CI を出す**（重なりを正直に反映させる）。
   点推定だけを見て「π=0.6 だから半分残る」と読むのは禁止。
3. **h を複数取って減衰曲線として見る**。単点より曲線の形のほうが情報が多い。
4. **ヌルを併記する**。「真の π が 0 のとき、この標本で π̂ がどこまで散るか」を
   銘柄ラベルの横断シャッフルで実測し、点推定と重ねる（`null-calibration.ts` と同じ流儀）。

> **π の CI が [0, 0.9] のように広く出ることは十分あり得る。**
> そのときの誠実な結論は「持続性は測れていない」であり、
> **測れていないなら等加重に寄せる**（C16 の誤差割引）。これを既定の出力とする。

---

## 3. L2-B 順位安定性 ─ 実務が扱う形に射影する

π は連続量で正しいが、実務の判断は「入れ替えるか否か」という離散量で行われる。
そこで同じ現象を順位で見る。

### 3.1 3つの指標

```
rankIC(h)      = Spearman( rank(b̂_t) , rank(b̂_{t+h}) )        … 順位の相関
topK生存率(h)  = |top_k(t) ∩ top_k(t+h)| / k                   … 顔ぶれの残存
遷移行列       = 分位(t) × 分位(t+h) の頻度                     … どこからどこへ動くか
```

**topK 生存率が最も実務的**。「今日の上位5本のうち、1年後も上位5本に残るのは何本か」は
そのまま**年間の銘柄入替本数**であり、回転コストの見積りに直結する。

### 3.2 S の順位で測る（b の順位ではない）

選別に使うのは `S = b/σ_ε` なので、**安定性も S の順位で測らなければ意味がない**。
b と σ_ε は別々に動くので、b の順位が安定でも S の順位は不安定でありうる（逆も然り）。
両方出して、乖離があれば「不安定さの出所は σ_ε 側」と特定できる。

### 3.3 ヌル

順位の完全ランダム入替の下で topK 生存率の期待値は `k/N`（N=16, k=5 なら 1.56本 = 31%）。
**生存率 31% は「安定」ではなくゼロ点**である。画面にこの基準線を必ず引く。

---

## 4. L2-C 構造変化 ─ 「長い窓ほど良い」を疑う

### 4.1 なぜ疑うのか（P0/P1 の実測から）

同じユニバースで窓を変えると、結果が体系的に動いている。

| | 750日（2023-07〜） | 2400日（2016-10〜） |
|---|---|---|
| 平均純度 | 34%（メガUFJ） | 39% |
| 採用5本の加重市場β | **1.27** | 1.06 |
| セクター分散シェア | 22.2% | 20.7% |

これは「長い窓のほうが推定が安定」では説明できない差で、**b の構造そのものが動いた**
可能性を示唆する。もし 2024年3月のマイナス金利解除で b がステップしたなら、
**10年窓は「別のレジームのデータを混ぜて平均した値」＝バイアスした推定**になる。

> **長い窓は分散を減らすがバイアスを増やす。** 構造変化があるなら、
> 短い窓のほうが「正しい b」に近い。この層はそのトレードオフを数値で出す。

### 4.2 検定 ─ データ駆動を主・政策日を従に

**主**: 各銘柄について、分割点 s を全期間にわたって動かし、b の前後差の Wald 統計量の
最大値（supremum Wald）を取る。分割点を探索したぶんの選抜バイアスは、
**時系列ブロック・ブートストラップで分布を作って補正**する（臨界値を自前で作る）。

```
W(s) = (b̂_before(s) − b̂_after(s))² / [ SE_before(s)² + SE_after(s)² ]
supW = max_{s ∈ [0.15T, 0.85T]} W(s)         ← 両端15%はトリム（標本不足で暴れるため）
```

複数銘柄を横断するので **BH-FDR** で補正する。

**従**: 検出された分割点の近傍に、日銀の政策変更日をラベルとして重ねる（検定には使わない）。
候補日は静的表として持ち、**ユーザーが編集できる形**にする。

```ts
export const BOJ_POLICY_EVENTS: { date: string; label: string }[] = [
  { date: "2016-01-29", label: "マイナス金利導入決定" },
  { date: "2016-09-21", label: "イールドカーブ・コントロール導入" },
  { date: "2022-12-20", label: "YCC 変動幅拡大(±0.25→±0.5%)" },
  { date: "2023-07-28", label: "YCC 運用柔軟化" },
  { date: "2024-03-19", label: "マイナス金利解除・YCC 撤廃" },
  { date: "2024-07-31", label: "追加利上げ" },
  // ★日付はユーザーが検証・追記すること。検定には使わず、ラベル表示のみに使う。
];
```

> 政策日を検定に使わないのは、**後知恵で日付を選ぶと必ず有意になる**から。
> データに分割点を探させ、政策日は「見つかった点が経済的に説明できるか」の事後確認に使う。

### 4.3 出力される判断

- 分割点が検出された → **推定窓を分割点以降に切り替える**ことを提案（本数は減るが正しい）
- 検出されない → 長い窓を使ってよい（分散が減るぶん有利）
- 検出されたが分割点以降が短すぎる（< 250日）→ **b の推定自体を見送る**＝等加重

---

## 5. L2-D 非対称性 ─ 純度19〜43%を踏まえた最重要層

### 5.1 なぜ P1 の結果でこの層の重要度が上がったのか

P1 で全16銘柄の純度が 19〜43%、採用5本の加重市場βが 1.27 と分かった。
つまり**保有しているものの6〜8割は市場そのもの**。この状態で問うべきは

> あなたが測った b は、**金利が上がる日**に出ているのか、**市場が落ちる日**に出ているのか。

後者なら、それは金利プレイではなく**暴落増幅器**である。平均の b は同じでも、
建玉としての意味が正反対になる。

### 5.2 3つの分割

```
① セクター因子の符号別   b⁺ = b | F>0 ,  b⁻ = b | F<0
② 市場の符号別           b^{M+} = b | M>0 ,  b^{M−} = b | M<0
③ 金利の符号別           b^{r+} = b | Δy>0 ,  b^{r−} = b | Δy<0     ← 賭けの本丸
```

推定は交互作用ダミーの1本の回帰で行う（部分標本に切らない。切ると各群の SE が膨らみ、
かつ条件付けバイアスが入る）。

```
r_i = α + c·M + b·F + δ·(F · 1{F<0}) + ε        →   b⁻ = b + δ,  b⁺ = b
```

`δ` の t 値で非対称性を検定し、銘柄横断で BH-FDR。

### 5.3 読み方と建玉への翻訳

| パターン | 意味 | 建玉の判断 |
|---|---|---|
| `b⁻ > b⁺` かつ有意 | 下げ局面で連動が強まる | セクターのプットを売っているのと同じ。**採用から外すか建玉を縮める** |
| `b^{M−} > b^{M+}` | 市場暴落時にセクター露出が増える | 分散のつもりが暴落時に集中する。C11（DD管理）と衝突 |
| `b^{r+} > b^{r−}` | 金利上昇で強く反応・低下では鈍い | **理想形**。金利観に賭けるならこれ |
| `b^{r+} ≈ b^{r−}` | 対称 | 普通。問題なし |

**これは P1 の S ランキングを直接書き換える。** 同じ S でも `b⁻ > b⁺` の銘柄は
実効的な期待値が低い（上げでは付いてこず下げでは付いてくる）ので、
**S に非対称性ペナルティを掛けた S' で並べ替える案**を出す（既定はオフ、トグルで比較）。

```
S' = (b⁺ − λ·max(0, b⁻ − b⁺)) / σ_ε        λ は既定 1（ユーザー可変）
```

---

## 6. トレードにどう生かすか ─ 3つの具体的な出力

ここが本層の存在意義。**統計量を建玉の数字に変換する。**

### 6.1 チルトの強さ（最重要）

P1 は `w ∝ b/σ_ε²` を出したが、その `b` は**今の b** であって**来期の b** ではない。
来期の b の最良予測は、持続率で平均に縮めた値になる。

```
b_forecast,i = b̄ + π(h) · ( b_JS,i − b̄ )          ← 二段収縮
                          ~~~~~~~~
                          P1 の James-Stein（推定誤差 e を除去）の出力

w_i ∝ b_forecast,i / σ_ε,i²
```

**二段になっている理由**: James-Stein は「測り間違い」を直す。π は「本当に変わってしまう」
ぶんを織り込む。両者は別の量で、片方だけでは足りない。

具体的な効き方（P1 実測 b̄≈0.78・三菱UFJ b=0.92 の場合）:

```
π = 1.0 →  b_forecast = 0.92   （P1 のまま）
π = 0.5 →  b_forecast = 0.85   （チルトが半分に）
π = 0.0 →  b_forecast = 0.78   （＝全銘柄同じ → w は 1/σ_ε² のみ＝実質リスクパリティ）
```

> **π = 0 のとき自動的に「等加重に近い形」へ退避する**のがこの式の良いところで、
> 「持続性が無いなら選別するな」という結論が、別ルールでなく同じ式から出る。

### 6.2 リバランス間隔

半減期 τ とコスト c（片道 bps）から最適間隔を出す。b の陳腐化による露出のズレは
時間とともに `1 − exp(−Δt/τ)` で増え、回転コストは `2c/Δt`（年率）で減る。

```
最適間隔 Δt* ≈ argmin_Δt [ κ · σ_F² · Var(β) · (1 − e^{−Δt/τ}) + 2c/Δt ]
```

厳密解より**画面に曲線を描いて最小点を示す**ほうが実務的。出力は
「**半減期 τ = ○日 なので、リバランスは○ヶ月ごとが最適。それより速く回してもコスト負け**」
という1文にする。

### 6.3 銘柄ごとの信頼度（トラストスコア）

持続性は横断の平均だが、**銘柄ごとに安定度は違う**はず。
バランスシートが安定した大手と、統合直後の地銀では b の動き方が違う。

```
安定度_i = 1 − sd_t(b̂_{i,t}) / mean_t(SE_{i,t})      ← 時系列変動が推定誤差で説明できるか
```

`sd_t(b̂) ≈ mean(SE)` なら「b は動いていない（見かけの変動は全部ノイズ）」＝安定。
`sd_t(b̂) >> mean(SE)` なら本当に動いている＝不安定。

**建玉への翻訳**: 不安定な銘柄は b_forecast をさらに強く平均へ縮める（銘柄別 π）。
標本が足りず銘柄別 π が推定できないなら横断 π を使い、その旨を明示する。

---

## 7. 実装仕様

### 7.1 計算層 `app/lib/sector-factor-stability.ts`

`sector-factor-select.ts` の `buildPanel` / `olsNW` / `orthogonalize` / `leaveOneOut` / `mulberry32`
を再利用する（§0.3 の一覧が実際の export）。パネル構築を二重に持たないこと。

```ts
import { PricePoint } from "./types";
import { buildPanel, olsNW, leaveOneOut, type FactorPrices, type FactorSource } from "./sector-factor-select";

export interface StabilityParams {
  factorSource: FactorSource;
  window: number;        // 全体の標本長（既定 2400）
  rollWindow: number;    // ローリング推定窓（既定 250）
  rollStep: number;      // 刻み（既定 21）
  horizons: number[];    // π を測る h（既定 [63, 125, 250, 500]）
  topK: number;          // topK 生存率の k（既定 5）
  nBoot: number;         // ブロック・ブート反復（既定 300）
  blockLen: number;      // 時間ブロック長（既定 250 ＝ 窓長と同じ）
  nPerm: number;         // ヌル（横断シャッフル）反復（既定 500）
  trim: number;          // supWald の両端トリム（既定 0.15）
  costBps: number;       // 片道コスト（既定 10）
  seed: number;
}

/** ローリング推定の1時点。 */
export interface RollPoint {
  date: string;            // 窓の終端日
  b: Record<string, number>;
  bSe: Record<string, number>;
  sigmaEps: Record<string, number>;
  score: Record<string, number>;   // S = b/σ_ε
}

/** L2-A 持続性 */
export interface PersistenceResult {
  /** h ごとの持続率（減衰補正済み）とブートCI・ヌル分位。 */
  curve: { h: number; pi: number; lo: number; hi: number; nullHi: number; nPairs: number; nEffPairs: number }[];
  /** exp(−h/τ) フィットの τ（営業日）と半減期。フィット不能なら null。 */
  tau: number | null;
  halfLife: number | null;
  /** 意思決定に使う π（既定 h=250 の点推定。CI が広いときは下限側を使う）。 */
  piForDecision: number;
  /** π の CI がヌルと重なる＝持続性を測れていない。 */
  indistinguishableFromNull: boolean;
}

/** L2-B 順位安定性 */
export interface RankStabilityResult {
  byHorizon: {
    h: number;
    rankIcB: number;      // b の順位相関
    rankIcS: number;      // S の順位相関（判断に使うのはこちら）
    icLo: number; icHi: number;
    topKSurvival: number; // 0..1
    survivalNull: number; // k/N
    nPairs: number;
  }[];
  /** 分位遷移行列（h=250）。行=今期分位, 列=来期分位, 値=確率。 */
  transition: number[][];
  quantiles: number;
}

/** L2-C 構造変化 */
export interface BreakResult {
  byTicker: {
    ticker: string;
    supW: number;
    bootP: number;      // ブロック・ブートで作った臨界分布に対する p
    q: number;          // BH-FDR 後
    breakDate: string | null;
    bBefore: number; bAfter: number;
  }[];
  /** 銘柄横断で最も多く選ばれた分割点（票数つき）。 */
  consensusBreaks: { date: string; votes: number; nearestEvent: string | null }[];
  /** 分割点以降だけで推定し直すべきか（票が集中し、以降の標本が足りる）。 */
  recommendWindowFrom: string | null;
}

/** L2-D 非対称性 */
export interface AsymmetryResult {
  byTicker: {
    ticker: string;
    bPlus: number; bMinus: number; deltaT: number; deltaP: number; deltaQ: number;
    bMktUp: number; bMktDown: number; mktDeltaT: number;
    bRateUp: number; bRateDown: number; rateDeltaT: number;
    /** 非対称ペナルティ後のスコア S'。 */
    scoreAdj: number;
    verdict: "理想形" | "対称" | "下げで強まる（要注意）" | "暴落増幅";
  }[];
  lambda: number;
}

export interface StabilityResult {
  params: StabilityParams;
  rolls: RollPoint[];
  tickers: string[];
  persistence: PersistenceResult;
  rankStability: RankStabilityResult;
  breaks: BreakResult;
  asymmetry: AsymmetryResult;
  /** §6 の建玉出力。 */
  decision: {
    /** 二段収縮後の予測 b と推奨ウェイト。 */
    bForecast: Record<string, number>;
    weight: Record<string, number>;
    /** P1（π=1）のウェイトからどれだけ等加重へ寄ったか（総変動 L1 距離）。 */
    tiltReduction: number;
    /** 最適リバランス間隔（営業日）とコスト曲線。 */
    rebalanceDays: number | null;
    costCurve: { days: number; staleness: number; cost: number; total: number }[];
    /** 銘柄別の安定度。 */
    trust: Record<string, number>;
  };
  warnings: string[];
}

export function computeSectorStability(
  pricesByTicker: Record<string, PricePoint[]>,
  factors: FactorPrices,
  params?: Partial<StabilityParams>
): StabilityResult | null;
```

### 7.2 アルゴリズム（逐次）

1. **パネル構築**: `buildPanel(prices, market, sectorEtf, window)`。P1 と同一の履歴フィルタ・
   価格破損の網を通る。
2. **ローリング推定**: `t = rollWindow .. T`、`rollStep` 刻みで各銘柄を
   `r_i ~ [1, M, F_i]` に回帰（NW lag=5）。`b`・`SE`・`σ_ε`・`S` を保存。
   **`F_i` は basket モードなら leave-one-out を毎窓で作り直す**（窓ごとに構成が変わるため）。
3. **持続性**: 各 h について、`(t, t+h)` の全ペアで横断 Cov を取り、
   分母 `Var(b̂_t) − mean(SE_t²)` で割る。ペアを平均して `π(h)`。
   **重なりを考慮した有効ペア数** `nEffPairs ≈ nPairs / (h/rollStep)` も出す。
4. **π の CI**: 時間方向のブロック・ブートストラップ（ブロック長＝`rollWindow`）で
   ローリング系列ごと再標本化し、π を再計算。300回。
5. **ヌル**: 各窓で銘柄ラベルを横断シャッフルしてから π を計算（500回）。
   これで「真の持続性ゼロ」の分布が出る。`nullHi` = その95%点。
6. **順位安定性**: 同じペア集合で Spearman と topK 生存率。遷移行列は h=250 の分位×分位。
7. **構造変化**: 銘柄ごとに supWald。臨界分布は
   **b が一定というヌルの下でのブロック・ブート**（リターンをブロック再標本化して同じ探索をやる）。
   BH-FDR。分割点の票を集計して `consensusBreaks`。
8. **非対称性**: 交互作用ダミー回帰3本（F符号 / M符号 / Δy符号）。NW SE、BH-FDR。
9. **建玉への翻訳**: §6.1 の二段収縮 → ウェイト。§6.2 のコスト曲線 → 最適間隔。
   §6.3 の安定度。

### 7.3 計算量と Worker

```
ローリング: (2400−250)/21 ≈ 102 窓 × 16 銘柄 = 1,632 回帰（250×3）
ブート:     300 × 1,632 = 490k 回帰   ← 支配的
ヌル:       500 × 102 窓の横断シャッフル（回帰は不要・既存の b を並べ替えるだけ）＝安い
supWald:    16 銘柄 × 約 1,700 分割点 × 2 回帰 = 54k 回帰、さらにブート 300 倍 = 16M ← 最大
```

**supWald のブートが支配的なので Worker 必須。**
`sarima.worker.ts` / `weekday-us-interaction.worker.ts` と同じ
`new Worker(new URL("../../lib/sector-factor-stability.worker.ts", import.meta.url))` 方式。

軽量化:
- ブート内の回帰は **NW を使わない**（点推定だけ要る）。`olsNW(y, X, 0)` で十分。
- supWald の分割点探索は `rollStep` 刻み（毎日でなく21日ごと）に間引く → 1,700 → 80 点。
- L2-A/B は即時にメインスレッドで出し、L2-C/D は「検証中…」から差し替える。

### 7.4 描画仕様（CLAUDE.md の規約に従う）

| 層 | 図 | 方式 | 内容 |
|---|---|---|---|
| L2-A | **持続率の減衰曲線** | Canvas2D | 横軸 h（日）、π(h) の点＋CI帯＋ヌル95%点の破線。半減期を縦線とラベル |
| L2-A | 判定バッジ | HTML | 「π(1年) = 0.62 [0.31, 0.88]」を大きく。ヌルと重なるなら赤で「測れていない」 |
| L2-B | **ローリング b(t)** | **lightweight-charts** | 銘柄ごとのライン。**横軸が時間なので必須**。政策日にマーカー |
| L2-B | topK 生存率 | Canvas2D | 横軸 h、生存率の折れ線＋ヌル線 `k/N` |
| L2-B | 遷移行列 | Canvas2D | 分位×分位ヒートマップ。対角が濃ければ安定 |
| L2-C | supWald の経路 | Canvas2D | 横軸=分割点、W(s) の曲線＋ブート臨界値の水平線。最大点に日付ラベル |
| L2-C | 分割点の票 | HTML | 銘柄×検出日の一覧＋最寄りの政策イベント名 |
| L2-D | b⁺ / b⁻ 対バー | Canvas2D | 銘柄ごとに2本並べ、有意差のみ濃色。「暴落増幅」は赤 |
| **決定** | **P1 → P2 のウェイト変化** | Canvas2D | 銘柄ごとに P1 ウェイトと二段収縮後を並べたバー。等加重線を重ねる |
| **決定** | リバランス・コスト曲線 | Canvas2D | 横軸=間隔、陳腐化損・コスト・合計の3本。最小点にマーカー |

**Now マーカー**: ローリング b(t) の最新値に水平線と数値ピル。
保有銘柄（ウォッチリスト）は太線・色付きで強調（P1 と同じ規約）。

### 7.5 UI 操作

- ローリング窓長（125 / 250 / 500 日）／刻み（5 / 21 日）
- h の集合（プリセット: 四半期 / 半年 / 1年 / 2年）
- 二段収縮 ON/OFF（**OFF にすると P1 のウェイトに戻る＝差分を体感させるのが目的**）
- 非対称ペナルティ λ（0 / 0.5 / 1 / 2）
- コスト bps（5 / 10 / 20）
- 「分割点以降だけで再推定する」ボタン（L2-C が推奨を出したときのみ活性）

### 7.6 統合先と挿入位置

`SectorFactorSelectChart.tsx` に L2 セクションとして追加する（別コンポーネントにしない）。

理由: P1 の順位表と P2 の持続性は**同じ画面で見なければ意味がない**。
「この順位表は使えるのか」という問いに答える層なので、離すと必ず読まれない。
折りたたみ（`CollapsibleAnalysis` ではなく内部の開閉トグル）で長さを抑える。

**挿入位置（現在のコンポーネントの構造）**:

```
① 操作行（ユニバース / 因子ソース / 窓 / JS収縮 / topK）
② DataQualityNotice ×3
③ P0-① 前提バナー
④ P1-① μ vs b の対比カード2枚
⑤ P1-② ランキング表                     ← L2-A の判定バッジをこの直前に置く
⑥ P1-③ 市場β × セクターβ 散布
⑦ P1-④ b̂ 誤差バー
⑧ 採用集合の要約 Stat×4
      ★ここに L2 を丸ごと挿入（A 減衰曲線 → B ローリングb/生存率 → C 分割点 → D 非対称）
      ★「P1→P2 のウェイト変化」バーは ⑧ の直後（順位表と対で読ませる）
⑨ P0-② 分散の内訳と相関
⑩ 標本と警告 / 次の層への導線（← P2 完了時に P3 へ書き換える）
⑪ AnalysisGuide / AxiomPlacement corollaryId="C29"
```

**L2-A の判定バッジだけは ⑤ の直前に置く。** 「この順位表は使えるのか」を、
順位表を読む前に見せるため。バッジが赤（＝持続性を測れていない）なら、
**⑤ の推奨ウェイト列を灰色化して「参考値」と明示する**（`DriftIdentifiabilityChart` と同じ流儀）。

### 7.7 Worker のプロトコル

`sarima.worker.ts` / `weekday-us-interaction.worker.ts` と同じ形。
**Worker には価格を渡さず、構築済みのパネル（数値配列）を渡す**（構造化複製のコストを抑える）。

```ts
// app/lib/sector-factor-stability.worker.ts
export interface StabilityWorkerRequest {
  kind: "breaks";                 // 重いのは L2-C のみ。A/B/D はメインスレッドで足りる
  ret: number[][];                // panel.ret
  market: number[];
  factor: number[];               // 直交化済みセクター因子（basket は銘柄別なので別途 factors[][]）
  factors?: number[][];           // basket モード時の銘柄別 leave-one-out 因子
  tickers: string[];
  dates: string[];
  params: { trim: number; step: number; nBoot: number; blockLen: number; seed: number };
}
export interface StabilityWorkerResponse {
  kind: "breaks";
  progress?: { done: number; total: number };   // 途中経過（描画は据え置き）
  result?: BreakResult;
  error?: string;
}
```

コンポーネント側:

```ts
const w = new Worker(new URL("../../lib/sector-factor-stability.worker.ts", import.meta.url));
// Turbopack がこの形を解決する。相対パスを変数に入れると解決できないので直書きすること。
```

**L2-C が届くまでは「構造変化を検証中…」のプレースホルダを出し、A/B/D は先に描く。**

---

## 8. AnalysisGuide に書くこと

CLAUDE.md の7項目＋原論ブロック。P2 固有で外せない説明:

1. **「誤差が小さい」と「使える」は別**（P1 との境界）。b̂ の SE が小さいことは
   「今を正しく測れた」だけで、「来期も同じ」は別の主張。
2. **3分解 β / η / e の直感**: 「その人の実力（β）」「その日の調子（η）」「測定のブレ（e）」。
   James-Stein が直すのは測定のブレだけ。調子の波は測り直しても消えない。
3. **π がそのまま建玉の強さになる**という一点（§6.1）。統計量を眺めて終わりにしない。
4. **検出力の壁**（§2.4）。N=16 では π の CI は広い。**広いという結果自体が結論**であり、
   その場合は等加重に寄せる。
5. **長い窓が常に良いわけではない**（§4.1）。構造変化があるならバイアスが増える。
6. **非対称性は「何を持っているか」を変える**（§5.3）。平均の b が同じでも、
   下げでだけ効く b は建玉としては別物。

原論ブロックは C29 を継承しつつ、**C16（誤差割引）と C17（レジーム切替）への接続**を明記する。

```tsx
<p className="font-medium text-gray-700 mt-3">公理的位置づけ（株式原論）</p>
<ul className="list-disc pl-4 space-y-1">
  <li><b>立脚する公準/命題</b>: 公準3（非先読み）＋命題4（情報の価値）＋公理5／C29 の後段・C16・C17</li>
  <li><b>測る P の性質</b>: ファクター感応度 b の<b>時間的持続性</b> π(h) と構造変化点</li>
  <li><b>変える q の選択</b>: チルトの強さ（w の平均への収縮量）・リバランス間隔・推定窓</li>
  <li><b>摩擦の扱い</b>: 半減期 τ とコスト c の交換で最適間隔が決まる。τ が短いほど選別は割に合わない</li>
</ul>
```

---

## 9. 受け入れ基準

| # | 基準 |
|---|---|
| 1 | π(h) の減衰曲線が CI・ヌル付きで描かれ、**半減期が日数で1つの数字として出る** |
| 2 | 二段収縮の ON/OFF で推奨ウェイトが実際に動き、その差分がバーで見える |
| 3 | 「π がヌルと区別できない」ケースで、**赤バッジ＋等加重推奨**が正しく出る（合成データで確認）→ **達成（2026-08-07・§12.8）** |
| 4 | ローリング b(t) が lightweight-charts で描かれ、時間軸ズームが効く |
| 5 | supWald がブロック・ブートの臨界値付きで出て、BH-FDR 後の有意銘柄が特定される |
| 6 | b⁺/b⁻ の非対称性が銘柄ごとに検定され、「暴落増幅」判定が出る |
| 7 | 最適リバランス間隔が「○ヶ月ごと」の1文として出る |
| 8 | 重い層（supWald ブート）が Worker に載り、L2-A/B は即座に描画される |

---

## 10. 想定される結論と、そのときの行動

**この節が本設計書の目的**。どの結果が出ても行動が決まっている状態にしてから実装する。

| π(1年) の CI | 構造変化 | 結論 | 行動 |
|---|---|---|---|
| 下限 > 0.5 | なし | b は持続する | P1 のウェイトをほぼそのまま使う。P3 の WF 検証へ進む |
| 下限 > 0.5 | あり | 持続するがレジーム依存 | **分割点以降の窓で再推定**してから P3 へ |
| CI が 0 を跨ぐ | — | **持続性は測れていない** | **等加重（または銀行ETF 1615.T）に寄せる。選別は保留** |
| 上限 < 0.2 | — | b は毎年変わる | 選別を放棄。C24（床への参加）に戻る |

> **3行目・4行目が既定の結論**である可能性を、実装前に受け入れておく。
> P1 で「b は測れる」ことが分かったのは事実だが、**測れることと儲かることは別**であり、
> その橋を架けるのが P2 と P3 である。橋が架からないなら、
> 正しい答えは「銀行セクターに等加重で集中する」になる ── それでも
> §3.5 の分散利得（σ −10.8% / g* +3.2pp）は手に入る。**選別が失敗しても集中の設計は残る。**

---

## 11. 実装順序 ─ P2 の中の着手順と、その先

### 11.1 P2 の中の順序（価値 ÷ コスト で並べた）

| 手順 | 内容 | 依存 | 工数感 | なぜこの順か |
|---|---|---|---|---|
| **P2-1** | ローリング推定 `RollPoint[]` ＋ **L2-A 持続性** ＋ §6.1 二段収縮 | なし | 中 | **これ単体で問いに答え、ウェイトが実際に動く。** π が 0 なら以降の層は不要になるので最初に置く |
| **P2-2** | **L2-D 非対称性** | なし（ローリング不要） | 小 | ローリングが要らず安い。P1 で純度19〜43%と判明したため価値が跳ね上がった層 |
| **P2-3** | **L2-B 順位安定性** | P2-1 のローリング | 小 | ローリングさえあればほぼ集計だけ。topK 生存率は回転コストに直結 |
| **P2-4** | **L2-C 構造変化** ＋ Worker | P2-1 | 大 | supWald のブートが全体の計算量を支配する。最後に回す |

> **P2-1 が終わった時点で一度立ち止まること。** π の CI が 0 を跨いだら、
> §10 の表に従い「等加重に寄せる」が結論になり、**P2-3/P2-4 の価値は大きく下がる**
> （順位の安定性を細かく測っても、順位を使わないなら意味がない）。
> ただし **P2-2（非対称性）は π と無関係に価値がある**（等加重で持つ場合でも、
> その束が暴落時に何になるかは知る必要がある）ので、π が死んでも実装する。

### 11.2 P2 の後に何を作るべきか（P1 の結果で優先順位が変わった）

`sector-factor-selection.md` §8 の当初フェーズ（P3 WF検証 → P4 集中曲線 → …）に対し、
**P1 の実測を踏まえて順序を組み替えるべき**。

| 優先 | 内容 | なぜ | 当初 |
|---|---|---|---|
| **★1** | **市場ヘッジ後の純度と成長率**（新設・仮 P3H） | P1 で採用5本の加重市場β = **1.27** と判明。実態は「1.27倍レバレッジの日本株＋金利ファクター3割」。**この論点は選別が成功しても失敗しても残る**（等加重で持つ場合も同じ市場βを負う）ので、どの分岐でも価値がある | P4 の一部 |
| ★2 | **P3 WF検証**（床＝等加重に勝てるか） | 選別の可否を決める門番。ただし P2-1 で π が死ねば結論は先に出ている | P3 |
| ★3 | **P4 集中曲線＋ウェイト表**（k を振る） | §3.5 の分散利得（σ −10.8% / g\* +3.2pp）を k の関数として出す。**選別が失敗しても残る成果**なので、P3 が赤でも実装する価値がある | P4 |
| ★4 | P6 IRRBB（ΔNII/ΔEVE の手入力表） | b̂ のファンダ版との突き合わせ。**ユーザーの決算資料入力が要る**ので着手はブロックされている | P6 |
| ★5 | P5 残差 z ローテーション | 有意でなければ層ごと畳む前提。優先度は最も低い | P5 |

#### ★1「市場ヘッジ」を新設する理由（もう少し具体的に）

P1 の最大の発見は順位ではなく、**保有しているものの正体**だった。

```
採用5本 = 加重セクターβ 0.97 ＋ 加重市場β 1.27
        ＝ 「TOPIX を 1.27 倍持ち、そこに銀行ファクターが 0.97 乗っている」
```

金利観に賭けたいのに市場リスクを 1.27 倍負っているなら、成長率 `g = μ − σ²/2` の
`σ²` の大半は**賭けていないものから来ている**。ここを削れれば、露出を減らさずに g が上がる。

測るべきこと:

```
ヘッジ比 h を 0..1.3 で振り、ポートフォリオ P(h) = 銀行バスケット − h × TOPIX として
  ・純度(h)        = セクター寄与 /（市場寄与＋セクター寄与）
  ・σ_p(h)         = 実現ボラ
  ・g(h)           = μ̂(h) − σ_p(h)²/2      ※ μ̂ は測れないので m の符号だけ仮定して感応度分析
  ・コスト(h)      = 信用の逆日歩・貸株料・先物ロール（C22 の枠組み）
  ・追証/破産確率  = ヘッジは σ を下げるが、証拠金を食う
```

**判断の出力**: 「ヘッジ比 h* = 0.8 で純度が 34% → 71% に上がり、σ が X% 下がる。
ただしコストが年 Y% かかるので、金利観 m が Z% 以上ないと割に合わない」という1文。

既存資産で大半が組める: `conditional-beta.ts`（β推定）、`vol-targeting.ts`（可変レバの枠組み）、
`nisa-vs-taxable.ts`（信用コスト・追証・破産確率）、`growth-drag.ts`（g の分解）。
**新規計算はヘッジ比の掃引だけ**なので、工数は見た目より小さい。

> ただし**ヘッジは C7（ベータ/ヘッジ）の領域で、信用取引が前提**になる。
> ユーザーが空売り・先物を使わない方針なら、この層は「純度の高い銘柄に寄せる」
> （最大でもりそな 43%）で代替するしかなく、**効果は限定的**である旨を明示する。
> 実装前にこの1点だけ確認すること。
>
> **確認済み（2026-08-07）: 使う方針。** よって代替経路は不要。★1 の設計は
> `docs/sector-market-hedge.md` に分離した（系C30）。上記の「測るべきこと」は
> **h 単独の掃引ではなく (L, h) の同時最適化**に置き換わっている。理由は、L=1 に固定して h を上げると
> 純度は上がるが総露出も落ちるため、純度は目的関数にならないから。
> 一階条件が分離して `L*` から π_M が消えることが、ヘッジ手段を持つことの本質的な価値になる。

### 11.3 P2 完了時に更新するもの

- `docs/sector-factor-selection.md` に **§8d「P2 実装記録」** を追記
  （§8b/§8c と同じ形式: 仕様変更・実測結果・読み・次への申し送り）
- `SectorFactorSelectChart.tsx` 末尾の「次の層（P2/P3）」の導線を P3 向けに書き換え
- `app/lib/axioms/corollaries.ts` の C29 `derivation` に
  **「b の律速は統計誤差でなく時変性」を実測値つきで追記**（現在は主張のみ）
- `/portfolio` の `pf-sector-select` の `subtitle` に P2 の要素を追記
- memory `sector-factor-selection.md` に π の実測値と結論を追記

---

## 付録: 参照

- 前段: `docs/sector-factor-selection.md`（§3.2 識別可能性・§8b P0記録・§8c P1記録）
- 原論: `docs/investment-axioms.md` C16（誤差割引）/ C17（レジーム切替）/ C20（N_eff）/ C29
- 再利用: `sector-factor-select.ts`（buildPanel / olsNW / orthogonalize / leaveOneOut）
- 検定の流儀: `null-calibration.ts`（ヌル較正）/ `stats-significance.ts`（BH-FDR・ブロックブート）
- Worker の手本: `weekday-us-interaction.worker.ts`
- 描画の手本: `ConditionMarkerChart.tsx`（lightweight-charts）/ `DriftIdentifiabilityChart.tsx`（誠実な既定結果）

---

## 12. 実装記録（2026-07-31）

### 12.1 出来たもの

| 実体 | 内容 |
|---|---|
| `app/lib/sector-factor-stability.ts` | 計算層。ローリング推定 / L2-A 持続率 / L2-B 順位安定性 / L2-C supWald / L2-D 非対称性 / §6 建玉翻訳 |
| `app/lib/sector-factor-stability.worker.ts` | L2-C のみ Worker（`computeBreaks` を呼ぶだけ） |
| `app/components/analysis/SectorFactorStabilityPanel.tsx` | 描画層。`useSectorStability` / `StabilityVerdictBadge` / 本体パネル |
| `SectorFactorSelectChart.tsx` | バッジを順位表の直前に、パネルを採用集合サマリの直後に差し込み |

計測: `computeSectorStability` 1.4s（メインスレッド・`setTimeout(0)` で P1 描画の後ろへ退避）、
`computeBreaks` 0.9s（Worker）。

### 12.2 設計からの変更点（すべて実測が理由）

1. **重複窓の補正を追加した**（設計書に無い）。h < ローリング窓だと2つの窓が標本を共有し、
   推定誤差の共分散 `Cov(e_t,e_{t+h}) ≈ φ·SE²`（φ=(L−h)/L）が分子に混じって π が機械的に 1 へ寄る。
   分子から `φ·mean_i(SE_t·SE_{t+h})` を引く。**補正は観測側だけに掛け、ヌルには掛けない**
   （ラベルをシャッフルすると重複由来の共分散も一緒に消えるため、ヌルは補正なしで 0 中心が正しい）。
2. **supWald のブロック長を 250日 → 63日 に変えた**。設計書は「窓長と同じ 250日」を挙げていたが、
   2400日が 10 ブロックにしかならず再標本化しても片方のレジームが偏って残る。実測で crit95 が
   supW の約3倍まで膨らみ **14銘柄すべて検出できなかった**。四半期に落として 8 銘柄が q<0.1。
3. **`common`（等加重バスケットの同じ検定）を BreakResult に追加した**（設計書に無い）。
   これが無いと解釈を誤る。§12.3 の通り、検出された分割点はほぼ全部が共通成分だった。
4. **トラストスコアを横断中心化してから測る**。設計書の `1 − sd_t(b̂)/mean_t(SE)` を素直に実装したら
   **全14銘柄が負**になり、π=0.97 と矛盾した。原因は全銘柄の b が揃って上がっていること（0.6→0.85）。
   共通の水準変化は順位を一切動かさないので選別には無害。`sd_t(b̂_i − b̄_t)` に直したら
   +0.50〜−1.30 に散り、意味のある指標になった。
5. **ローリングでは市場への直交化を省いた**。Frisch-Waugh により `r ~ [1,M,F]` と `r ~ [1,M,F−aM]` は
   F の係数と残差が一致するので、b と σ_ε しか使わないローリングでは不要。
   L2-D の符号分割は `1{F<0}` の中身が変わるため必ず直交化する。
6. **`RollPoint` を `Record<string,number>` でなく銘柄インデックス配列にした**。描画でそのまま使え、
   Worker への構造化複製も軽い。
7. **交互作用回帰に水準ダミー D を足した**（設計書の式は `α + cM + bF + δ(F·D)`）。
   D と F·D は相関するので、D を落とすと δ に水準差が混入しうる。df は 2400 中の1本。
8. **リバランス間隔の陳腐化項を「実測した回転率」ベースにした**。設計書の
   `κ·σ_F²·Var(β)` は単位が閉じないので、露出保持率の平均 `(τ/Δt)(1−e^{−Δt/τ})` と
   ペア間の実測 L1 回転率に置き換えた。**残る仮定は m（セクターの年率期待リターン）だけ**で、
   これは `ASSUMED_SHARPE` と同じ扱い（画面に「仮定」と明示）。

### 12.3 実測（sec-bank / 窓2400日 / 2016-11-01〜2026-07-31 / 14銘柄・ETF因子）

```
π(h)     63日 1.02 [1.00,1.04]  φ=0.75      ヌル95% 0.06
        125日 1.01 [0.96,1.04]  φ=0.50      ヌル95% 0.07
        250日 0.97 [0.81,1.03]  非重複      ヌル95% 0.06   ← 判断に使う点
        500日 0.82 [0.62,0.89]  非重複      ヌル95% 0.07
τ = 3131日 / 半減期 2170日（標本長 2400日にほぼ等しい＝「観測範囲で減衰が見えない」）
実効ペア数 3.8（名目91組）

rankIC(S)  63日 0.95 / 125日 0.91 / 250日 0.84 / 500日 0.80
上位5本生存 92% / 89% / 84% / 81%      ヌル k/N = 36%
遷移行列(4分位)  対角 0.64 / 0.37 / 0.57 / 0.81   ← 両端は固い・中間2分位は入れ替わる

二段収縮  採用 π=0.81（CI下限）→ ウェイト総変動 わずか 1.1%
          JS収縮率 10.3% / b̄=0.754
最適リバランス 357営業日（約17ヶ月）。ただし曲線は 84〜462日でほぼ平ら
          粗利 0.68%/年（m=5% の仮定）・コスト 10bp

supWald   q<0.1 が 8/14 銘柄。分割点は 2020-02〜2021-12 に集中し、全員 b前 < b後
          共通成分（等加重）: supW=106 / p=0.017 / 2021-09-02 で b 0.57 → 0.79
          **2024-03 のマイナス金利解除は検出されない**

非対称性  「暴落増幅」3本: みずほ・りそな・千葉銀（市場下落日に b が有意に増える）
          MUFG・SMFG は b⁻ < b⁺ が有意（t=−2.8/−3.1, q=0.03）＝下げで鈍い＝良好
          金利の符号別は全銘柄で |t|<2（^TNX 代理では割れない）
```

### 12.4 読み（この層で分かったこと）

**当初の見立ては外れた。** P1 の申し送りは「b の律速は統計誤差でなく時変性」だったが、
実測は逆で **銘柄間の順位はほぼ恒久的**（π(1年)=0.97・生存率84%）。動いたのは順位ではなく
**b の水準**で、それは全銘柄に共通していた（共通成分に p=0.017 の分割点）。

この2つは矛盾しない。**全員の身長が伸びても背の順は変わらない。** 帰結は非対称で、

- **選別（相対の話）は無傷** → P1 の順位表をチルトの根拠に使ってよい。
  §10 の表の1行目（下限>0.5・構造変化あり）に該当する。
- **建玉サイズ（b の絶対値）は窓に依存する** → 露出を b で正規化しているなら推定窓を
  2021-09 以降に切り替える必要がある。10年窓の b は「別レジームの平均」になっている。

ただし持続性が高い出所には留保がある。横断の散らばりの大半は
**構造的に別物の銘柄**（セブン銀行 b=0.23・あおぞら 0.39 vs メガバンク 0.9）が作っており、
遷移行列の中間2分位（対角 0.37 / 0.57）は実際に入れ替わっている。
**「上位5本を選ぶ」ぶんには 84% 生存で十分安定だが、メガバンク3行の中の順位は動く。**

二段収縮の効果はほぼ無かった（総変動 1.1%）。π が高いので当然で、
**この層の価値は「ウェイトを動かしたこと」ではなく「動かさなくてよいと分かったこと」**にある。

### 12.5 次への申し送り

1. **P3 の前に「市場ヘッジ後の純度と成長率」**（`sector-factor-selection.md` §11.2 ★1）。
   P2 が選別の持続性を肯定したことで、次の律速は「採用集合の加重市場β=1.27」に移った。
   持っているものの6〜8割は市場であり、この論点は選別の成否と無関係に残る。
   **着手前にユーザーへ確認すべき1点**: 空売り・先物・信用を使う方針か（使わないなら
   この層は「純度の高い銘柄に寄せる」で代替するしかなく効果は限定的）。
2. **P3 の WF 検証では b の水準変化を織り込む**。σ_ε 正規化を挟まずに b をそのまま使うと、
   2021 年前後で露出が別物になる。
3. **「暴落増幅」3本の扱い**は C11（DD管理）側の判断に投げる。S' の λ は既定 1 だが、
   この3本は F の符号ではなく M の符号で効いているので S'（F符号ベース）では捕まらない。
   **M符号のペナルティを S' に入れるかは未決**。
4. **金利の符号別が割れない**のは ^TNX が代理変数であることの限界。円金利が取れれば再検証する。

### 12.6 コードレビューで直した点（同日）

1. **basket モードの共通成分検定が自己回帰だった**（重大）。`panelExport.factor` は basket モードだと
   `leaveOneOut(panel, 0)` なので、被説明変数の等加重バスケット `eq = ((N−1)·F^(−0) + r_0)/N` と
   相関 0.99 超。b̂ が (N−1)/N に張り付き残差ほぼ 0 の degenerate な回帰から
   「b の水準が揃って動いた」を出していた。`commonFactor`（**必ずパネル外＝セクターETF**）を
   別フィールドで持たせ、無ければ共通成分の検定を**行わない**（警告を出す）ようにした。
   修正後は etf モードと同じ b 0.57→0.79 になる。
2. **L2-D の S 列が P1 と別定義だった**。σ_ε を符号分割回帰（5変数）の残差から取っていたため、
   交互作用を足したぶん必ず小さくなる。素の3変数回帰の残差に直した。
   ただし **P2 は独自の窓で走るので P1 の表とは数値が一致しない**旨を画面に明記した
   （「λ=0 で P1 の並びに戻る」は誤りなので「左の S 列と一致する」に訂正）。
3. **計算をまるごと Worker へ移した**。`setTimeout(…, 0)` は実行を遅らせるだけで逃がさない。
   刻み5日・窓500日を選ぶと数秒フリーズし、同じタスク内なので「計算中」の表示すら描画されなかった。
   main（L2-A/B/D＋建玉翻訳）→ breaks（L2-C）の2段階で返す。
   設計書 §7.7 の「Worker に価格を渡さない」は**計算が全部 Worker に来た時点で不要**
   （buildPanel は1回しか走らないので二重フィルタの懸念が消える）。
4. **supWald の W(s) 経路を lightweight-charts に変えた**。横軸が分割点の日付なので
   CLAUDE.md の規約に反していた。山がどの時期に立っているかを拡大できることがこの図の価値。
5. **「二段収縮 ON/OFF」トグルを外した**（設計書 §7.5 にあるが空振りの操作だった）。
   ウェイト図が π を掛けない値と掛けた値を常に並べて描いているので、トグルは何も変えない。

### 12.7 副産物: basket モードのほうが分割点の解釈が素直

leave-one-out 因子で走らせると、検出された分割点が政策日に寄る。

```
2024-03-01（マイナス金利解除・YCC撤廃 まで18日）2票   ← etf モードでは検出されない
2022-12-19（YCC 変動幅拡大 まで1日）
2023-07-25（YCC 運用柔軟化 まで3日）
```

ETF 因子は各銘柄自身を時価加重で含むため、銘柄固有の構造変化が因子側にも同時に現れて
差が相殺される。**銘柄ごとの構造変化を見たいときは basket（L-O-O）に切り替えること。**
π（横断の持続性）は etf/basket でほぼ変わらない。

### 12.8 合成データによる赤経路の検証（2026-08-07）

受け入れ基準 #3 の唯一の未達項目だった。実データが π=0.97 だったため、
**「持続性が測れないなら等加重に退避する」という本層の安全装置が一度も実行されていなかった**
（`docs/sector-factor-p2-session-record.md` §2.3 の宿題）。安全装置は、それが必要な状況を
作って踏んでみるまで、実装されているとは言えない。

#### 作ったデータ

```
r_{i,t} = a_i·M_t + b_{i,t}·F_t + ε_{i,t},    F_t = 0.9·M_t + f_t
b_{i,t} = β_i + η_{i,t}     η は減衰時定数 τ_η の OU 過程
```

推定側の回帰は `r ~ [1, M, F]` なので、b は F の係数としてそのまま識別される。
14銘柄・2600営業日・σ_ε=0.012・b̄=0.8（実データに合わせた）。

| ケース | 恒久成分 β_i の sd | 時変成分 η | 真の π(250日) |
|---|---|---|---|
| `null` | **0** | OU（τ_η=40日・sd 0.5） | **0.07** |
| `persistent` | 0.28 | なし | 1.00 |
| `mixed` | 0.25 | OU（同上） | 0.27 |

**π=0 の作り方の要点**は、分母を潰さずに分子だけを 0 にすること。恒久成分をゼロにしたうえで
η の減衰時定数（40日）をローリング窓（250日）より十分短く取ると、窓平均された b̂ の横断ばらつきは
`0.5·√(2·40/250) = 0.28` と実データ並みに残る一方、非重複の2窓（h=250）は独立になる。
**b を日次で振ってはいけない**（横断分散が推定誤差だけになり π が 0/0 の不定形になって検証にならない）。

#### 結果（種 20260807・既定パラメータ・因子 etf）

```
ケース null（真の π=0）
   h   真のπ   観測π      95%CI      ヌル95%  重複φ
   63    0.84    0.85  [ 0.82, 0.88]    0.06   0.75
  125    0.60    0.60  [ 0.52, 0.68]    0.06   0.50
  250    0.07    0.12  [ 0.00, 0.31]    0.06   0.00   ← 判断に使う点
  500   -0.12   -0.06  [-0.09, 0.01]    0.06   0.00
  → indistinguishableFromNull=true / piForDecision=0.00 / 半減期 93日
  → バッジ赤「この順位は使えない（持続性を測れていない）」／推奨w列 灰色化
  → b_forecast の散らばり 0.0e+0（全銘柄 b̄ に一致）
  → 推奨 w と 1/σ_ε²（採用内で正規化）の最大乖離 2.8e-17 ＝ 実質リスクパリティへ退避

ケース persistent（真の π=1）  π=1.02 [1.00,1.04] → 緑・piForDecision=1.00・灰色化なし
ケース mixed（真の π=0.27）    π=0.33 [0.25,0.55] → 黄・piForDecision=0.25
```

赤・黄・緑の3分岐がすべて踏まれ、15項目の assert が通った。バッジは式を写したのではなく
**`StabilityVerdictBadge` を `react-dom/server` で実際に描画**して `border-red-300` と文言を確認している。

#### この検証で分かった3つのこと

1. **判定を CI 下限で切っている設計が、まさにここで効いた。** null ケースの π の点推定は 0.12 で、
   ヌル95%点 0.06 を**超えている**。点推定で判定していたら赤は出ず、真の π=0 のデータに対して
   チルトを許してしまっていた。実際に赤を出したのは CI 下限（0.00）で切る規則のほう。
2. **重複窓の補正（§12.2-1）が真値に対して正しいことを初めて確認した。** 真の π と観測 π が
   h=63 で 0.84 vs 0.85、h=125 で 0.60 vs 0.60 と一致する。これまで補正の妥当性は
   実データでしか見ておらず、**真値と比べたことがなかった**。
3. **安全装置は連続量で効いており、バッジの色は要約にすぎない。** 種を20本振ると、
   真の π=0 で赤になるのは **14/20**。残り6本は黄に落ちるが、その piForDecision は 0.07〜0.23 で
   チルトはほぼ畳まれている。**危険なのは緑が出ることだが、それは 0/20**。
   逆に真の π=1 で誤って退避したのは 0/10（10本すべて緑・piForDecision 0.94〜1.00）。

```
真の π = 0（20種）: 赤 14 / 黄 6 / 緑 0     黄の piForDecision = 0.07〜0.23
真の π = 1（10種）: 赤  0 / 黄 0 / 緑 10    piForDecision = 0.94〜1.00
```

#### 残った論点（未決）

- **黄のとき推奨w列は灰色化されない。** 上の6本のように真の π=0 でも黄に落ちることがあり、
  そのとき π=0.07〜0.23 の弱いチルトを太字で見せることになる。灰色化の条件を
  `indistinguishableFromNull` から `piLo ≤ 0.5`（＝緑以外）へ広げるかは未決。
  実害は小さい（チルト自体は畳まれている）が、太字は「使ってよい」の合図として読まれる。
- **ブラウザでの目視はしていない。** 灰色化は `tiltUnusable` 1つのブール値が
  `SectorFactorSelectChart.tsx:677-685` の三項演算子2つを切り替えるだけなので、
  ブール値とバッジの markup までで止めた。合成データを実画面に流すには
  `/api/stock` に合成銘柄を通す口を開ける必要があり、そこまではしていない。

再現スクリプトは付録B。


---

## 付録B. 赤経路の検証スクリプト（§12.8 の全文）

外部データ不要（合成データ）。**本書だけで安全装置の検証を再現できるようにするため全文を残す。**

リポジトリ直下に `.scratch/` を作り、下の3ファイルを置いて実行する
（`react-dom` の解決に `node_modules` が要るのでスクラッチパッドからは動かない。
`lightweight-charts` はブラウザ専用ビルドなので node では読めず、stub に差し替える）。

```bash
npx tsx --tsconfig .scratch/tsconfig.json .scratch/pi-null-verify.tsx           # 3ケースの assert（15項目）
npx tsx --tsconfig .scratch/tsconfig.json .scratch/pi-null-verify.tsx --seeds   # 種を振って発火率を測る
```

確認が済んだら `.scratch/` ごと消すこと（リポジトリに入れない）。

### `.scratch/tsconfig.json`

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "baseUrl": "..",
    "paths": {
      "@/*": ["./*"],
      "lightweight-charts": [".scratch/lw-stub.ts"]
    }
  }
}
```

### `.scratch/lw-stub.ts`

```ts
// lightweight-charts のブラウザ専用ビルドを node で読ませないためのスタブ。
// バッジは描画に一切関与しないので、型だけ通ればよい。
export const createChart = () => {
  throw new Error("stub");
};
export const LineSeries = {};
export const createSeriesMarkers = () => undefined;
export const LineStyle = { Dashed: 1, Solid: 0, LargeDashed: 2 };
export type SeriesMarker<T> = { time: T };
export type Time = string;
```

### `.scratch/pi-null-verify.tsx`

```tsx
// 系C29 P2 の「赤経路」検証 ─ 合成データで真の π = 0 を作る。
//
// docs/sector-factor-p2-session-record.md §2.3 の宿題:
//   実データ（銀行14本）は π(1年)=0.97 だったため、受け入れ基準 #3
//   「持続性が測れないなら等加重に退避する」の赤経路が一度も踏まれていない。
//
// b の生成過程を自分で決めて3ケース回し、判定の3分岐すべてを踏む。
//   null       : 恒久成分 β_i を持たず、b は減衰時定数 40日 の OU だけ → 真の π(250日) = 0
//   persistent : b_i は時間に対して定数                                → 真の π = 1
//   mixed      : 恒久成分と OU の両方                                  → 真の π ≈ 0.3
//
//   r_{i,t} = a_i·M_t + b_{i,t}·F_t + ε_{i,t},   F_t = 0.9·M_t + f_t
//   推定側の回帰は r ~ [1, M, F] なので、b は F の係数としてそのまま識別される。
//
// 実行（リポジトリ直下に .scratch/ を作って置く。react-dom の解決に node_modules が要るため
// スクラッチパッドからは動かない。lightweight-charts はブラウザ専用ビルドなので stub する）:
//   npx tsx --tsconfig .scratch/tsconfig.json .scratch/pi-null-verify.tsx
//   npx tsx --tsconfig .scratch/tsconfig.json .scratch/pi-null-verify.tsx --seeds   ← 種を振って発火率を測る

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  computeSectorStability,
  DEFAULT_STABILITY_PARAMS,
} from "../app/lib/sector-factor-stability";
import { mulberry32, type FactorPrices } from "../app/lib/sector-factor-select";
import type { PricePoint } from "../app/lib/types";
import { StabilityVerdictBadge } from "../app/components/analysis/SectorFactorStabilityPanel";

// ── 生成パラメータ ──────────────────────────────────────────────
const N_ASSETS = 14; // 実データ（銀行）と同じ本数
const T_DAYS = 2600; // window=2400 より長く取る
const SD_MKT = 0.011; // 市場の日次 sd
const SD_SECTOR_SPEC = 0.008; // セクター固有ぶん
const SD_EPS = 0.012; // 残差 σ_ε
const B_BAR = 0.8; // b の横断平均（実データの b̄ ≈ 0.78 に合わせる）
const OU_TAU = 40; // η の減衰時定数（営業日）
const OU_SD = 0.5; // η の定常 sd → 250日窓平均の sd ≈ 0.5·√(2·40/250) = 0.28
const PERM_SD = { null: 0, persistent: 0.28, mixed: 0.25 } as const;
const USE_OU = { null: true, persistent: false, mixed: true } as const;

type Case = keyof typeof PERM_SD;

function businessDays(n: number): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(2015, 0, 5));
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** ret[t] は dates[t+1] のリターン（buildPanel が log(c1/c0) を取るので長さ dates.length−1）。 */
function toPrices(dates: string[], ret: number[], p0 = 1000): PricePoint[] {
  const out: PricePoint[] = [];
  let p = p0;
  for (let t = 0; t < dates.length; t++) {
    if (t > 0) p *= Math.exp(ret[t - 1]);
    out.push({ time: dates[t], open: p, high: p, low: p, close: p, volume: 0 });
  }
  return out;
}

/** 標準正規（Box-Muller）。乱数は本体と同じ mulberry32 を使い、種で再現する。 */
function makeNormal(seed: number) {
  const rand = mulberry32(seed);
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rand() * 2 - 1;
      v = rand() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * f;
    return u * f;
  };
}

function generate(kind: Case, seed: number) {
  const z = makeNormal(seed);
  const dates = businessDays(T_DAYS);
  const T = dates.length - 1;

  const M: number[] = [];
  const F: number[] = [];
  for (let t = 0; t < T; t++) {
    const m = SD_MKT * z();
    M.push(m);
    F.push(0.9 * m + SD_SECTOR_SPEC * z());
  }

  const rho = Math.exp(-1 / OU_TAU);
  const permSd = PERM_SD[kind];
  const useOu = USE_OU[kind];

  const pricesByTicker: Record<string, PricePoint[]> = {};
  const names: Record<string, string> = {};
  const trueB: number[][] = []; // [asset][t]

  for (let i = 0; i < N_ASSETS; i++) {
    const a = 0.8 + 0.15 * z(); // 市場ローディング
    const beta = B_BAR + permSd * z(); // 恒久成分
    let eta = useOu ? OU_SD * z() : 0; // 定常分布から開始
    const ret: number[] = [];
    const bPath: number[] = [];
    for (let t = 0; t < T; t++) {
      if (useOu) eta = rho * eta + Math.sqrt(1 - rho * rho) * OU_SD * z();
      const b = beta + eta;
      bPath.push(b);
      ret.push(a * M[t] + b * F[t] + SD_EPS * z());
    }
    const tk = `S${String(i + 1).padStart(2, "0")}.X`;
    pricesByTicker[tk] = toPrices(dates, ret);
    names[tk] = `合成${i + 1}`;
    trueB.push(bPath);
  }

  const factors: FactorPrices = {
    market: toPrices(dates, M),
    sector: toPrices(dates, F),
    rate: null, // 金利プロキシは本検証の対象外（L2-D の金利診断はスキップされる）
    marketTicker: "SYN-MKT",
    sectorTicker: "SYN-SECTOR",
    rateTicker: "",
  };

  return { pricesByTicker, factors, names, trueB };
}

/** 真の π: 生成過程の b を窓平均し、h 日離れた横断共分散/横断分散を直接測る（推定誤差なし）。 */
function truePi(trueB: number[][], rollWindow: number, h: number): number {
  const T = trueB[0].length;
  const winMean = (t0: number) =>
    trueB.map((p) => p.slice(t0, t0 + rollWindow).reduce((s, v) => s + v, 0) / rollWindow);
  let num = 0;
  let den = 0;
  let n = 0;
  for (let t0 = 0; t0 + rollWindow + h < T; t0 += 21) {
    const b1 = winMean(t0);
    const b2 = winMean(t0 + h);
    const m1 = b1.reduce((s, v) => s + v, 0) / b1.length;
    const m2 = b2.reduce((s, v) => s + v, 0) / b2.length;
    let c = 0;
    let v1 = 0;
    for (let i = 0; i < b1.length; i++) {
      c += (b1[i] - m1) * (b2[i] - m2);
      v1 += (b1[i] - m1) * (b1[i] - m1);
    }
    num += c / (b1.length - 1);
    den += v1 / (b1.length - 1);
    n++;
  }
  return n > 0 && den > 0 ? num / den : NaN;
}

const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : "—");
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const stripTags = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const ok: string[] = [];
const ng: string[] = [];
function check(cond: boolean, label: string) {
  (cond ? ok : ng).push(label);
  console.log(`   ${cond ? "OK  " : "NG !!"} ${label}`);
}

// ════════════════════════════════════════════════════════════════════════════
// --seeds: 種を振って「安全装置の発火率」と「誤退避率」を数える
// ════════════════════════════════════════════════════════════════════════════
if (process.argv.includes("--seeds")) {
  const sweep = (label: string, kind: Case, seeds: number[]) => {
    console.log(`\n■ ${label}`);
    console.log("  seed        π    CI下限   ヌル95%   判定   piForDecision");
    let red = 0;
    let green = 0;
    for (const s of seeds) {
      const g = generate(kind, s);
      const res = computeSectorStability(g.pricesByTicker, g.factors, {}, {});
      if (!res) {
        console.log(`  ${String(s).padStart(6)}  計算不能`);
        continue;
      }
      const p = res.persistence;
      const c = p.curve.find((x) => x.h === p.decisionH)!;
      const verdict = p.indistinguishableFromNull ? "赤" : p.piLo > 0.5 ? "緑" : "黄";
      if (verdict === "赤") red++;
      if (verdict === "緑") green++;
      console.log(
        `  ${String(s).padStart(6)}  ${f2(p.piPoint).padStart(5)}  ${f2(p.piLo).padStart(6)}  ` +
          `${f2(c.nullHi).padStart(7)}     ${verdict}    ${p.piForDecision.toFixed(2)}`
      );
    }
    console.log(`  → 赤 ${red}/${seeds.length} / 緑 ${green}/${seeds.length}`);
    return { red, green };
  };

  const a = sweep(
    "真の π = 0（赤が出てほしい）",
    "null",
    Array.from({ length: 20 }, (_, i) => 1000 + i * 7)
  );
  const b = sweep(
    "真の π = 1（赤が出てはいけない）",
    "persistent",
    Array.from({ length: 10 }, (_, i) => 500 + i * 13)
  );
  console.log(`\n${"═".repeat(80)}`);
  console.log(`安全装置の発火率  : ${a.red}/20   誤って緑を出した率: ${a.green}/20`);
  console.log(`誤退避率          : ${b.red}/10   正しく緑           : ${b.green}/10`);
  process.exit(0);
}

for (const kind of ["null", "persistent", "mixed"] as Case[]) {
  const g = generate(kind, 20260807);
  const res = computeSectorStability(g.pricesByTicker, g.factors, {}, g.names);
  console.log(`\n${"═".repeat(80)}`);
  console.log(
    `■ ケース "${kind}"  恒久成分 sd=${PERM_SD[kind]} / OU=${USE_OU[kind] ? `sd ${OU_SD}・τ ${OU_TAU}日` : "なし"}`
  );
  console.log("═".repeat(80));
  if (!res) {
    check(false, `${kind}: computeSectorStability が null を返した`);
    continue;
  }
  const p = res.persistence;
  const P = DEFAULT_STABILITY_PARAMS;

  console.log(
    `標本 ${res.nObs}日 (${res.dateFrom}〜${res.dateTo}) / ${res.tickers.length}銘柄 / 因子 ${res.usedFactorSource} / ローリング ${res.rolls.length}点`
  );
  console.log("\n   h   真のπ   観測π    95%CI          ヌル95%  nPairs  重複φ");
  for (const c of p.curve) {
    console.log(
      `  ${String(c.h).padStart(3)}  ${f2(truePi(g.trueB, P.rollWindow, c.h)).padStart(6)}  ${f2(c.pi).padStart(6)}  ` +
        `[${f2(c.lo).padStart(5)}, ${f2(c.hi).padStart(5)}]  ${f2(c.nullHi).padStart(7)}  ` +
        `${String(c.nPairs).padStart(6)}  ${f2(c.overlap)}`
    );
  }
  console.log(
    `\n  判断点 h=${p.decisionH}日: indistinguishableFromNull=${p.indistinguishableFromNull} / ` +
      `piForDecision=${p.piForDecision.toFixed(2)} / 半減期 ${p.halfLife !== null ? Math.round(p.halfLife) + "日" : "—"}`
  );

  // ── バッジを実物のコンポーネントで描画する ─────────────────────
  const html = renderToStaticMarkup(
    <StabilityVerdictBadge
      state={{ result: res, breaks: null, breakProgress: null, computing: false, breakError: null }}
    />
  );
  const color = html.includes("border-red-300")
    ? "赤"
    : html.includes("border-green-300")
      ? "緑"
      : html.includes("border-amber-300")
        ? "黄"
        : "?";
  console.log(`\n  [バッジ ${color}] ${stripTags(html).slice(0, 150)}…`);
  // 推奨w列の灰色化（SectorFactorSelectChart.tsx:447 の tiltUnusable と同一式）
  const tiltUnusable = res.persistence.indistinguishableFromNull;
  console.log(`  [推奨w列] tiltUnusable=${tiltUnusable} → ${tiltUnusable ? "text-gray-400（灰色・参考値）" : "太字"}`);

  // ── 建玉への翻訳（π=0 なら w ∝ 1/σ_ε² に退避するはず）──────────
  const d = res.decision;
  const last = res.rolls[res.rolls.length - 1];
  const invVar = last.sigmaEps.map((s) => (s > 0 ? 1 / (s * s) : 0));
  const held = d.weight.map((w, i) => (w > 0 ? i : -1)).filter((i) => i >= 0);
  const ivSum = held.reduce((s, j) => s + invVar[j], 0);
  const maxDev = Math.max(...held.map((i) => Math.abs(d.weight[i] - invVar[i] / ivSum)));
  const bSpreadHeld =
    Math.max(...held.map((i) => d.bForecast[i])) - Math.min(...held.map((i) => d.bForecast[i]));
  console.log(
    `  [建玉] 採用${held.length}本 / チルト移動量 ${pct(d.tiltReduction, 1)} / ` +
      `b_fcst の散らばり ${bSpreadHeld.toExponential(1)} / w と 1/σ_ε² の最大乖離 ${maxDev.toExponential(1)}`
  );

  console.log("");
  if (kind === "null") {
    check(p.indistinguishableFromNull === true, "赤経路: indistinguishableFromNull が立つ");
    check(p.piForDecision === 0, "piForDecision が 0 に潰れる");
    check(color === "赤", "バッジが赤で描画される（実コンポーネント）");
    check(html.includes("この順位は使えない"), "バッジの文言が「この順位は使えない（持続性を測れていない）」");
    check(html.includes("等加重"), "バッジが等加重への退避を指示する");
    check(tiltUnusable === true, "推奨w列が灰色化される（tiltUnusable）");
    check(bSpreadHeld < 1e-12, "b_forecast が全銘柄で b̄ に一致（チルトが畳まれた）");
    check(maxDev < 1e-9, "推奨ウェイトが w ∝ 1/σ_ε²（実質リスクパリティ）へ退避");
    check(
      res.warnings.some((w) => w.includes("持続性はこの標本では測れていない")),
      "警告文が出る"
    );
  } else if (kind === "persistent") {
    check(p.indistinguishableFromNull === false, "対照: 真の π=1 では赤にならない");
    check(color === "緑", "対照: バッジが緑");
    check(p.piForDecision > 0.5, "対照: piForDecision がチルトを通す");
    check(tiltUnusable === false, "対照: 推奨w列は灰色化されない");
  } else {
    check(color === "黄", "中間: バッジが黄（持続はするが CI が広い）");
    check(p.piForDecision > 0 && p.piForDecision < 0.5, "中間: piForDecision が部分的に効く");
  }
}

console.log(`\n${"═".repeat(80)}`);
console.log(`OK ${ok.length} 件 / NG ${ng.length} 件`);
if (ng.length) {
  for (const s of ng) console.log(`  NG: ${s}`);
  process.exitCode = 1;
}
```
