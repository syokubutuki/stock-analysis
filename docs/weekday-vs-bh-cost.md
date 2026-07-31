# 月→金戦略 vs B&H 検定への取引コスト導入 ─ 実装仕様書

対象: `app/lib/weekday-vs-bh.ts` / `app/components/analysis/WeekdayVsBuyHoldChart.tsx`
（`page.tsx` の `cal-weekday-vs-bh`、calendar 節）

状態: **実装済**（2026-07-31）。§9 の受け入れ条件は全項目を実データで確認済み（§11 に実測結果）。

関連: `docs/trading-usability-improvements.md` §5（本件はその最後の1件）／
`app/lib/strategy-vs-benchmark.ts`（他8箇所で採用済みの共通コスト規約）／
`memory/weekday-vs-buyhold-test.md`・`memory/strategy-vs-benchmark.md`

---

## 0. 一言でいうと

```
この検定に取引コストを入れると、コストが結論を支配する。
シグナル自体の t が 0.78 なのに、往復0.3%のコストは t を 5.06 動かすからである。

したがって「コストON/OFFのトグル」は設計として弱い。スプレッド推定値そのものが
誤差の大きい推定量なので、単一の ON/OFF は偽の精度を与える。

採用するのは Break-even Cost（損益分岐コスト）の常時表示:
  c*      = mean(e_w)                  … 期待値がゼロになる往復コスト
  c*(95%) = mean(e_w) − 1.645·σ/√n     … 片側5%で有意でなくなる往復コスト
「この戦略のエッジは往復◯bpまで吸収できる」を出し、利用者が自分の手数料と突き合わせる。
```

---

## 1. 背景と設計思想

### 1.1 なぜコストを入れる必要があるのか

現状 `WeekdayVsBuyHoldChart.tsx:379` のガイドに次の注記があるだけである。

> 取引コスト未考慮: 毎週2回の売買コスト・スリッページを引くと優位は縮みます。週次超過が数bpなら実務では消えがち。

この記述は**定性的には完全に正しい**が、定量化されていないので判断に使えない。
`trading-usability-improvements.md` §5 の主張は「注記ではなく実数で効かせる」であり、
他の8コンポーネントは既にその形に移行済み（`memory/strategy-vs-benchmark.md`）。本件だけが残っている。

### 1.2 なぜ他の8箇所と同じ「共通部品を貼る」で済まないのか

`StrategyVsBenchmark` は「戦略の日次リターン列 or 建玉ベクトル」を受け取り、
超過リターンとコストを表示する**汎用部品**である。しかし本コンポーネントは:

- 独自の**非重複分解**（後述 §2.2）を持ち、それが分析の存在理由そのもの
- その上で **4つの独立した統計検定**（t／Wilcoxon+符号／JKM Sharpe差／年率差Boot）を走らせている

汎用バーを横に貼っても、**4検定の結論はコスト前のまま**になる。同じパネルの中で
「バーはコスト後で負け」「検定はコスト前で引き分け」という矛盾が出る。
コストは**検定の内部に入れなければ意味がない**。これが本件を別仕様にする理由である。

### 1.3 設計思想（3点）

1. **単一の課金源から両データ経路に伝播させる**（§2.3 の整合性問題を構造的に潰す）
2. **コストを「トグル」ではなく「Break-even」で提示する**。コスト推定の誤差から独立した
   判断材料を出す（§6）
3. **回転率の非対称性を必ず併記する**。戦略は年52往復、B&H は10年で1往復（年0.1往復）＝
   **520倍**。この差が超過リターンの主要な決定要因である

---

## 2. 現在の実装構造の整理

> 行番号は 2026-07-31 時点。実装前に `grep` で現在地を確認すること。

### 2.1 全体のデータフロー

```
prices: PricePoint[]
  │
  ├─ buildSegments(prices)                          … :74-87
  │    区間(segment)分解。営業日 i に対し
  │      ordinal 2i   = intraday_i  : log(close_i / open_i)     isClose=true
  │      ordinal 2i+1 = overnight_i : log(open_{i+1} / close_i) isClose=false
  │    → segs: Seg[] （nSeg ≈ 2×営業日数）
  │
  ├─ runStrategyTrades(prices, {entryDow:1, exitDow:5, side:"long", …})   … :186
  │    既存シミュレータ（weekday-trade.ts）と同一のトレード定義。数値一致のため再利用。
  │    → trades[]: { entryIdx, exitIdx }
  │
  ├─ pos[s] ∈ {0,1}                                  … :192-197
  │    各トレードの保有 ordinal 範囲 [E, X-1] を 1 にする。
  │      E = 2·entryIdx + (entryTiming==="open" ? 0 : 1)
  │      X = 2·exitIdx  + (exitTiming ==="open" ? 0 : 1)
  │
  ├─【経路B: 日次】富ループ                          … :206-217
  │    Ws（戦略）は pos[s]===1 の区間だけ複利、Wb（B&H）は全区間で複利。
  │    segs[s].isClose の時点で dailyStrat / dailyBH / equity に push。
  │    → dailyStrat[], dailyBH[], equity[]
  │
  └─【経路A: 週次】トレードループ                    … :230-251
       各サイクル w の範囲 [E_w, nextE−1] について
         sAll  = Σ 全区間 logret,  sHeld = Σ 保有区間,  sSkip = Σ 捨てた区間
         excessLog[w]    = sHeld − sAll   (= −sSkip)
         excessSimple[w] = exp(sHeld) − exp(sAll)
       → excessLog[], excessSimple[], skipLog[], weekendGaps[]
```

### 2.2 核心の恒等式（この分析の存在理由）

戦略と B&H は保有区間が大きく重複する（戦略は B&H の部分集合）ため、日次リターンの
単純な2標本検定は自己相関・重複で p 値が過小になり誤りになる。対数で書くと厳密に:

```
log(B&H資産) − log(戦略資産) = Σ_(戦略が捨てた区間) log(1+r)
```

つまり**戦略が勝つ ⟺ 捨てた区間（主に週末ギャップ 金終値→月始値）の平均が負**。
週次超過 `e_w = 戦略_w − B&H_w = −(捨てた区間)` を主標本として検定する。
これが「非重複部分だけを見る」という設計であり、コストを入れるときも壊してはならない。

### 2.3 4検定と、それぞれが使うデータ経路（最重要）

| # | 検定 | 実装 | 使う系列 | 経路 |
|---|---|---|---|---|
| ① | 週末ギャップ 片側t + 移動ブロックBoot | `oneSidedTP` / `blockBootMean` :255-268 | `excessLog`（t）／`excessSimple`（Boot） | **A 週次** |
| ③ | Wilcoxon符号順位 + 符号検定 | `robustPairedTest` :320-351 | `excessSimple` | **A 週次** |
| ② | JKM Sharpe差 + ペアBlockBoot | `sharpeDiffTest` :356-393 | `dailyStrat`, `dailyBH` | **B 日次** |
| ④ | 年率差 ペアBlockBoot CI | `annualDiffTest` :396-403 | `dailyStrat`, `dailyBH` | **B 日次** |

> **経路 A と B は同じ `segs[]`/`pos[]` から作られるが、コードとしては独立した2つのループである。**
> 片方だけにコストを入れると、①③と②④が矛盾した結論を出す。これが本件最大の落とし穴。

### 2.4 コンポーネント側

- `WeekdayVsBuyHoldChart.tsx:47-52`: `entryTiming`（既定 `"open"`）/ `exitTiming`（既定 `"close"`）の
  2つの state から `computeVsBH(prices, { entryTiming, exitTiming })` を `useMemo` で呼ぶだけ
- 結果 `VsBHResult` を表・エクイティチャート・4検定カードに流している
- `prices` は `filteredPrices`（期間セレクタ適用後）

---

## 3. 検討した実装案

### 案1: 帰無仮説を動かす（データは触らない）

「H0: μ_excess = 0」ではなく「H0: μ_excess = c」を検定する。

**メリット**
- データを一切加工しないので、既存の分解の純粋さが保たれる
- 「バーはゼロではなくコストである」という説明が直感的
- 実装が最小

**デメリット（致命的）**
- **t検定でしか成立しない。** Wilcoxon符号順位検定は「d が 0 対称か」を検定するので、
  c 対称を検定するには `|e − c|` で順位を組み直す必要がある。つまりデータ変換が必須で、
  「しきい値を動かす」という形では表現できない
- 符号検定も同様（`sign(e − c)` を数え直す必要がある）
- JKM は `θ = (1/T)[2(1−ρ) + ½(SRa²+SRb²−2·SRa·SRb·ρ²)]` が `SRa = ma/sa` を含むため、
  **分母も動く**。統計量の平行移動では表現できない（実測で √θ が 0.20% 変化、§4.3）
- Bootstrap は再標本化する系列そのものを変えないと反映されない

**判定: 不採用（ただし §6 の説明文言としては採用）**

### 案2: 週次系列（経路A）にだけ定数 c を引く

`excessLog` / `excessSimple` から c を引く。

**メリット**
- 実装が 2 行で済む
- ①③（この分析の主役である非重複検定）には正しく効く

**デメリット（致命的）**
- ②JKM と ④年率差は `dailyStrat`/`dailyBH` を見ているので**一切変化しない**
- 結果として「①週末ギャップ検定はコスト後に負け」「②Sharpe差は変わらず引き分け」と、
  **同一パネル内で矛盾**する。利用者はどちらを信じるべきか判断できない
- エクイティチャート（`equity[]`、経路B由来）もコスト前のまま乖離する

**判定: 不採用**

### 案3: 区間ループの `pos[]` 遷移で課金し、両経路に伝播

`pos[s]` が変化する瞬間（＝約定）に片道コストを課金し、同じ `c` を経路A側の
`excessLog`/`excessSimple` からも差し引く。単一の `costRT` を唯一の源とする。

**メリット**
- 経路A・Bが**構造的に整合**する（§7 の不変量でテスト可能）
- 約定は実際に起きた日（月曜・金曜）に課金されるので**最も忠実**
- 4検定すべてがネット系列で再計算されるため、JKM の θ も正しく更新される
- エクイティチャートもコスト後になり、表示と検定が一致する

**デメリット**
- 実装箇所が複数（富ループ・週次ループ・型・UI）に及ぶ
- 約定日に課金するため `σ(dailyStrat)` がわずかに増える。純粋な平均シフトではなくなる
  → **これは仕様であってバグではない**（§5.4 に明記）

**判定: 採用**

---

## 4. 数値的な裏付け（なぜこの設計が必要か）

> 以下は**合成データ**（520週＝10年、週次超過 σ=1.35%、裾を厚くした週末ギャップ）での実測。
> 7203.T の事実ではなく、**機序と桁**を示すためのもの。再現スクリプトは §8 の作業0を参照。

### 4.1 コストが結論を支配する

```
c(往復)  平均超過      t   p(片側)  Wilcoxon z   符号 z   正の週%
0.00%   +0.0462%    0.78  0.218       0.84       0.88     51.9%
0.05%   −0.0038%   −0.06  0.525       0.02       0.18     50.4%
0.30%   −0.2538%   −4.28  1.000      −4.06      −3.42     42.5%
```

シグナル自体の t は 0.78。ところが c=0.3% はそれを **−5.06 動かす**。
**損益分岐は往復5bp付近**であり、現実的なコストはどれもこれを超える。

### 4.2 3つの検定は同じようには動かない

```
c: 0 → 0.3% での変化
  t 統計量   : 0.779 → −4.280   Δ = −5.059
  理論 Δt = −c√n/σ            = −5.059  ← 完全一致（定数シフトなので解析的に決まる）
  Wilcoxon z : 0.843 → −4.056   Δ = −4.899
  符号 z     : 0.877 → −3.421   Δ = −4.298
  0<e<c の帯にいる週: 49週 (9.4%)
```

- **t は解析的**: `Δt = −c√n/σ`。感度は `c/σ` と `n` だけで決まる
- **符号検定が最も鈍い**（−4.30）。`0 < e < c` の帯の厚みしか動かないため。
  順位検定は大きさを捨てるぶんコストに対して「柔らかい」
- したがって**4検定の結論がコストによって割れうる**。割れたときの読み方をガイドに書く必要がある

### 4.3 JKM は平行移動ではない

```
コスト前: SRa=0.0222 SRb=0.0250 √θ=7.456e-3  z=−0.373
コスト後: SRa=−0.0122 SRb=0.0250 √θ=7.471e-3  z=−4.975
√θ の変化: +0.2035%
```

θ が `SRa` を含むため分母も動く。**統計量をシフトさせる実装は誤り**で、ネット系列から
再計算しなければならない（案1を不採用にした主因）。

### 4.4 銘柄によって効き方が変わる

```
σ_week   c/σ    Δt (c=0.3%, n=520)
 0.8%    0.38    −8.55
 1.3%    0.23    −5.26
 2.0%    0.15    −3.42
 3.0%    0.10    −2.28
```

**低ボラ銘柄ほどコストが致命的**（同じコストが相対的に大きい）。単一の閾値ではなく
`c/σ` で考える必要があり、これも Break-even 表示が優れている理由になる。

### 4.5 回転率の非対称性

```
戦略: 週1往復 = 52往復/年
B&H : 10年で1往復 = 0.1往復/年
比 : 520倍
```

同じエッジでも戦略は 520 倍の通行料を払う。年52往復 × 往復0.3% ≒ **年15.6%** のドラッグ。

---

## 5. 採用する実装方針（案3の詳細）

### 5.1 API 変更

```ts
// weekday-vs-bh.ts
export interface VsBHSpec {
  entryTiming: Timing;
  exitTiming: Timing;
  costRT?: number;   // 往復コスト（比率）。既定 0 = コスト控除なし
}
```

`computeVsBH(prices, spec, seed)` のシグネチャは変えず、`spec.costRT` を読む。
既定 0 なので**既存の呼び出しは無変更で従来どおりの値を返す**（後方互換）。

### 5.2 課金規約（`strategy-vs-benchmark.ts` と統一）

```
c        = 往復スプレッド + 2 × 片道手数料      … roundTripCost() を再利用
片道     = c / 2
対数空間 = ln(1 − c) を1往復ごとに加算（比例コストなので厳密。近似ではない）
B&H      = 期間全体で1往復ぶんだけ負担
```

`representativeSpread(prices)`（`spread-estimator.ts`、Corwin-Schultz 中央値）を
既定のスプレッド推定に使う。これも他8箇所と同じ。

### 5.3 経路B（日次富ループ :206-217）の変更

```ts
const halfLegLog = Math.log(1 - costRT) / 2;     // 1レグ。2レグで厳密に ln(1−c) になる

let prevP = 0;
for (let s = 0; s < nSeg; s++) {
  const r = Math.exp(segs[s].logret) - 1;
  Wb *= 1 + r;
  if (pos[s] !== prevP) Ws *= Math.exp(halfLegLog);  // 建玉変化＝片道1レグ
  prevP = pos[s];
  if (pos[s] === 1) { Ws *= 1 + r; held++; }
  …
}
if (prevP !== 0) Ws *= Math.exp(halfLegLog);     // 最後に畳む
// B&H は期間の最初と最後で1レグずつ（合計1往復）
```

> **1レグを `1 − c/2` にしてはいけない。** 2レグ掛けると `(1−c/2)² = 1−c+c²/4` となり、
> §5.4 の対数控除 `ln(1−c)` と O(c²) ずれる。これは §7.1 が警告している不整合そのもので、
> 経路A/Bの不変量（§7.2）が厳密に成立しなくなる。必ず `exp(ln(1−c)/2)` を使うこと。

### 5.4 経路A（週次ループ :230-251）の変更

```ts
const legLog   = Math.log(1 - costRT);            // 戦略: 週1往復
const bhShare  = Math.log(1 - costRT) / nWeeks;   // B&H: 全期間1往復を週に均等配分

excessLog.push(sHeld - sAll + legLog - bhShare);
excessSimple.push(Math.exp(sHeld + legLog) - Math.exp(sAll + bhShare));
```

B&H のコストを週に均等配分するのは、週次系列を均質に保つため（Wilcoxon・符号検定は
標本の均質性を仮定する）。金額としては 0.3%/520週 ≒ 0.0006%/週 で無視できる大きさだが、
§7 の不変量を厳密に成立させるために入れる。

### 5.5 Break-even の算出（新規・常時計算）

```ts
export interface BreakevenInfo {
  perRoundTripMean: number;   // c* = mean(e_w)：期待値がゼロになる往復コスト
  perRoundTripSig95: number;  // c*(95%) = mean − 1.645·σ/√n：有意でなくなる往復コスト
  tripsPerYearStrat: number;  // ≈ 52
  tripsPerYearBH: number;     // ≈ 1/years
  spreadRT: number;           // representativeSpread の値（参考表示）
  annualDragAtSpread: number; // spreadRT で年間いくら削られるか
}
```

`VsBHResult` に `breakeven: BreakevenInfo` を追加。**`costRT` の値に依らず常に計算する**
（コスト前の `e_w` から算出するため）。`perRoundTripSig95 < 0` なら
「コストゼロでも有意でない」を意味し、その旨を表示する。

---

## 6. UI 設計方針

### 6.1 Break-even を常時表示する理由

1. **コスト推定自体が誤差の大きい推定量**。Corwin-Schultz は日足高安からの逆算で、
   出来高が薄い銘柄では負値も出る（0クリップ）。単一の ON/OFF は偽の精度を与える
2. **利用者は自分の手数料を知っている**。「往復◯bpまで耐えられる」を出せば、
   利用者側の既知の数字と突き合わせるだけで判断が完結する
3. **コスト・モデルから独立**。時変コスト（§7）に将来差し替えても Break-even の意味は変わらない

表示例（コスト前でも常に出す）:

```
このエッジが吸収できる往復コスト
  期待値がゼロになる       : 5 bp   （年率換算 2.4%）
  95%で有意でなくなる      : −5 bp  → コストゼロでも有意でない
  推定往復スプレッド        : 30 bp  ← エッジの6倍
  回転率  戦略 52往復/年  vs  B&H 0.1往復/年（520倍）
```

### 6.2 コスト控除トグル（副次）

Break-even を主役にしたうえで、補助的に他8コンポーネントと同じ操作系を置く。

- チェックボックス「取引コストを控除」（**既定 OFF**）
- 片道手数料 bps の数値入力
- ON にすると4検定すべてが再計算される（`costRT` が `useMemo` の依存に入る）

### 6.3 検定が割れたときの表示

§4.2 のとおり t・Wilcoxon・符号は感度が違うため、コスト後に結論が割れうる。
ガイドに次を明記する。

- 符号検定だけ生き残った場合 → 「勝つ週の数は多いが、1回の負けが大きい」ことを意味する。
  順位検定は大きさを捨てるので、期待値の判断には t と年率差を優先する
- t だけ負けた場合 → 外れ値1週に引きずられている可能性。Boot CI と中央値を確認する

### 6.4 既存注記の置き換え

`WeekdayVsBuyHoldChart.tsx:379` の「取引コスト未考慮」を、Break-even パネルへの導線と
「回転率520倍の非対称性」の説明に差し替える。`grep -rn "コスト未考慮" app/components/analysis`
の結果が空になることが完了条件のひとつ（§9）。

---

## 7. 実装時の注意点

### 7.1 対数と単利の混在（最重要の実装バグ源）

`excessLog` は t検定に、`excessSimple` は Boot と Wilcoxon/符号検定に使われる（§2.3）。
**コストを対数側に `ln(1−c)`、単利側に `−c` として入れると O(c²) の不整合が生じ、
同じコストのはずの①と③がわずかに違う結論を出す。**
必ず §5.4 のように、`excessSimple` は対数で引いてから `exp` すること。

### 7.2 経路A/Bの整合性は不変量でテストする

```
Δ(Σ_w excessLog_net)  ==  Δ(ln Ws_final − ln Wb_final)
```

すなわち **「コストON/OFFで両辺が同じだけ動く」**ことを確認する。
（両辺の絶対値そのものは、最初のトレード開始前の区間ぶんだけズレるので比較しない。
差分で見ることでその端点効果を消せる。）

### 7.3 約定日課金による σ の増加は仕様

§5.3 は月曜・金曜に課金するので `dailyStrat` にのこぎり状の成分が入り、
`σ(dailyStrat)` がわずかに増える。したがって Sharpe の低下は
「平均だけシフトさせた場合」より**わずかに大きくなる**。
§4.4 の解析式 `Δt = −c√n/σ` は経路A（週次）には厳密に当てはまるが、
経路Bの Sharpe には当てはまらない。**これは忠実さの代償であり、バグではない**。
コード上にコメントを残すこと。

### 7.4 `entryTiming`/`exitTiming` との相互作用

`pos[]` の範囲は `entryTiming`/`exitTiming` に依存する（`:194-195`）。
`exitTiming === "open"` の場合、週末ギャップは戦略の保有区間に**含まれる**ため
`weekendGaps` は空になる（`:248` の条件）。この設定では「週末を避ける」という
物語自体が成立しないので、Break-even の解釈文も設定に応じて出し分ける。

### 7.5 `runStrategyTrades` との数値一致を壊さない

`:186` は「既存シミュレータと数値を一致させる」ために `weekday-trade.ts` を再利用している。
`weekday-trade.ts` の `equityFromPositions` は**独自の `costBps` を既に持つ**。
本実装のコストと二重に掛けないこと。`runStrategyTrades` はトレード日程の決定にのみ使い、
損益計算は本モジュール側で行う現在の構造を維持する。

### 7.6 B&H のコストをゼロにしない

`strategy-vs-benchmark.ts` と規約を揃え、B&H にも1往復ぶんを課す。
ゼロにすると他8コンポーネントと数値の意味が食い違う。

### 7.7 Bootstrap のシードと再現性

`blockBootMean` / `pairedBlockBoot` は `mulberry32(seed)` で再現性を持つ。
コストを変えても**同じシードを使う**こと。シードが変わると「コストの効果」と
「再標本化の揺らぎ」が混ざり、比較できなくなる。

---

## 8. 実装チェックリスト

- [x] **作業0**: §4 の再現スクリプト（付録B）と実データ計測を scratchpad で実行。§4 の表は完全一致、
      実データの σ・n は §11.1 参照
- [x] `VsBHSpec` に `costRT?: number` を追加（既定 0・後方互換）
- [x] `roundTripCost` / `representativeSpread` を import（他8箇所と同一規約）
- [x] 経路B: 富ループに `pos[]` 遷移課金を実装（§5.3）＋ B&H の1往復
- [x] 経路A: `excessLog` / `excessSimple` に `ln(1−c)` と B&H 配分を実装（§5.4）
- [x] `BreakevenInfo` 型と算出を実装し `VsBHResult.breakeven` に追加（§5.5）
- [x] **不変量テスト**（§7.2）を scratchpad の tsx スクリプトで確認 → 差 1e-14
- [x] `WeekdayVsBuyHoldChart.tsx`: Break-even パネルを常時表示（§6.1）
- [x] 同: コスト控除トグル＋手数料 bps 入力（既定OFF、§6.2）
- [x] 同: `costRT` を `useMemo` の依存配列に追加
- [x] 同: `AnalysisGuide` を更新（§5 にコストと Break-even、§7 に「検定が割れたとき」を新設）
- [x] 同: 「取引コスト未考慮」注記を置き換え（§6.4）
- [x] `npx tsc --noEmit` / `npx next build` / `npx eslint <変更ファイル>` すべて通す
- [x] `memory/strategy-vs-benchmark.md` の「未処理は WeekdayVsBuyHoldChart 1件」を更新
- [x] `memory/weekday-vs-buyhold-test.md` にコスト対応を追記

---

## 9. 受け入れ条件

完成時、以下がすべて確認できること。

### 9.1 後方互換

1. `costRT` 未指定（または 0）で `computeVsBH` を呼ぶと、**実装前と完全に同じ値**を返す
   （`t` / `pOneSided` / `wilcoxonZ` / `jkmZ` / `annual.delta` を実装前後で突き合わせる）

### 9.2 整合性

2. **§7.2 の不変量**: コストON/OFFで
   `Δ(Σ excessLog_net)` と `Δ(ln Ws_final − ln Wb_final)` が一致する（1e-9 以内）
3. コストONで **4検定すべてが動く**（①②③④のどれかが不変なら経路の配線漏れ）
4. コストONで **エクイティチャートの戦略線も下がる**（表示と検定が一致している証拠）

### 9.3 数値の正しさ

5. `costRT` を大きくすると、①の t が単調減少する
6. **`t` が `ln(1−c)` に対して線形**であること（＝コストが定数シフトである証拠）。
   複数の `c` で傾き `Δt / Δln(1−c)` を測り、ばらつきが 1% 未満なら合格。
   傾きから `σ_log = (1−1/n)·√n / 傾き` を復元でき、これが §4.2 の解析式 `Δt = −c√n/σ` に対応する。

   > **`Δt = −c√n/σ` を直接検算しようとしてはいけない。** `weekend.t` は `excessLog` から、
   > `weekend.excessMeanWeekly` は `excessSimple` から計算されており（`:255` と `:259`）、
   > この2つを混ぜて σ を逆算すると 20%以上ずれる。σ は外部から観測できないので、
   > **線形性そのものを検定する**のが正しい。（この罠で実際に受け入れテストが1度落ちた）
7. JKM の `z` が、統計量の平行移動では**説明できない**動きをする
   （√θ も変化していることを確認。§4.3）
8. `breakeven.perRoundTripMean` を `costRT` に代入すると、①の平均超過がほぼ 0 になる
   （Break-even の定義の自己整合）

### 9.4 表示

9. コスト前（既定状態）でも Break-even パネルが表示される
10. `perRoundTripSig95 < 0` のとき「コストゼロでも有意でない」と明示される
11. 回転率が「戦略 52往復/年 vs B&H 0.1往復/年」の形で併記される
12. `grep -rn "コスト未考慮\|コスト未控除" app/components/analysis` が**空**になる
    （`trading-usability-improvements.md` §5 の完了）

---

## 10. 将来的な拡張

### 10.1 時変コスト（優先度：高）

現行案は **定数 c**（分散不変・純粋な位置シフト）。実際には
`estimateSpread(prices, window)`（`spread-estimator.ts`）でローリングのスプレッド系列が取れる。

これを入れると:

- コストが**確率変数**になり、`σ(e_net)` が増える（定数モデルでは表現できない）
- **`Cov(gap, cost) > 0`**: 危機週は週末ギャップも大きくスプレッドも広い。
  つまり**戦略は「週末回避の価値が最大の週」に最も高い通行料を払う**。
  この相関こそが実務的な核心で、定数モデルは構造的にこれを見落とす
- ブロックブートストラップは `(gap, cost)` を**同時に**再標本化しないと相関が壊れる
  （`pairedBlockBoot` と同じ「同一ブロック添字」方式を3系列に拡張する）

### 10.2 レグ非対称コスト（優先度：中）

戦略は**月曜寄りで建て、金曜引けで畳む**。月曜寄りは週で最もスプレッドが広い瞬間
（週末情報を織り込む寄り付き板）であり、対称な `c/2` は**入りのコストを構造的に過小評価**する。

```
入り（月曜寄り）: k · c/2   （k > 1、既定 1.5 程度）
出（金曜引け）  : c/2
```

この戦略の主張が週末・寄り付きの挙動そのものである以上、コストと信号が同じ場所に
住んでいる点は無視しにくい。`SessionGapChart` のガイドと同じ論点。

### 10.3 曜日別コスト（優先度：低）

`estimateSpread` を曜日で層別すれば曜日別スプレッドが出る。ただし
標本が 1/5 になるうえ、CS 推定自体のノイズが大きいので、**推定誤差がコスト差より
大きくなる可能性が高い**。実装するなら曜日別スプレッドの信頼区間を先に測り、
区間が重なるなら「曜日差は測れない」という null result として出すこと
（`memory/drift-identifiability.md` の作法）。

### 10.4 税の導入（優先度：低）

回転率に比例して効くため、課税口座では戦略側がさらに不利になる。
`nisa-vs-taxable.ts` に実現益課税のエンジンがあるので再利用可能。
ただし本コンポーネントは「統計的優位性の検定」であり、税は口座属性の話なので
別レイヤーに置くほうが筋が良い。

---

## 11. 実装結果（2026-07-31）

### 11.1 実データでの実測（10y, entry=open / exit=close）

| 銘柄 | n週 | 週次超過 平均 | σ(excessLog) | t | **c\*** | c\*(95%) | 推定スプレッド |
|---|---|---|---|---|---|---|---|
| 7203.T | 446 | −0.195% | 1.93% | −1.85 | **−19.5bp** | −34.6bp | 27.3bp |
| 6758.T | 446 | −0.134% | 2.22% | −1.01 | **−13.4bp** | −30.7bp | 32.0bp |
| 1306.T | 445 | −0.179% | 1.45% | −2.39 | **−17.9bp** | −29.1bp | 14.7bp |

- σ は §4 の合成前提（1.35%）と**同じ桁**。n は 520 ではなく 445〜446（祝日で月曜が飛ぶ週がある）
- 回転率は戦略 45.6 往復/年 vs B&H 0.10 往復/年 ＝ **446倍**（§1.3 の「520倍」は営業日ベースの概算）
- **3銘柄とも c\* が負**。つまりコストをゼロにしても B&H に届かない。§6.1 の表示例は c\*>0 を
  前提にしていたので、UI に「吸収余地なし」の分岐を追加した（§11.3）

### 11.2 §9 受け入れ条件の確認結果

| # | 条件 | 結果 |
|---|---|---|
| 1 | 後方互換（costRT=0 で実装前と同値） | ✅ `t`/`p`/`wilcoxonZ`/`jkmZ`/`annual.delta` すべて一致 |
| 2 | §7.2 の不変量 | ✅ 差 **1e-14**（1e-9 以内） |
| 3 | コストONで4検定すべて動く | ✅ 7203.T c=0.3%: t −1.85→−5.13 / JKM −1.72→−5.23 / Wilcoxon −3.25→−7.97 / 年率差 −8.47%→−21.97% |
| 4 | エクイティ戦略線も下がる | ✅ +72.0% → −55.0% |
| 5 | t の単調減少 | ✅ 0/5/10/20/30/50bp で単調 |
| 6 | Δt ≈ −c√n/σ | ✅ 含意σが c に依らず一定（相対差 <1e-6）。近似形との差 0.07% |
| 7 | JKM が平行移動でない | ✅ Δz 実測 −3.509 vs 平行移動仮定 −3.596 |
| 8 | c\* 代入で平均超過≈0 | ⏭ 3銘柄とも c\*<0 のため該当なし（負のコストは意味を持たない） |
| 9-11 | Break-even 常時表示・c\*(95%)<0 の明示・回転率併記 | ✅ |
| 12 | `grep "コスト未考慮\|コスト未控除" app/components/analysis` が空 | ✅ |

`exitTiming="open"`（週末ギャップを保有に含む設定, §7.4）でも 1〜7 は同様に成立。

### 11.3 仕様書からの意図的な変更点

1. **1レグの控除を `c/2` の単利ではなく `ln(1−c)/2` にした**。§5.3 の擬似コードどおり
   `Ws *= 1 − costRT/2` を2回かけると `ln(1−c+c²/4)` になり、経路A の `ln(1−c)` と
   **c²/4 だけずれる**。c=0.3%・446週で 1e-3 のズレとなり §9.2-2 の 1e-9 を満たせない。
   `ln(1−c)/2` なら2レグで厳密に `ln(1−c)` になり、不変量が 1e-14 で成立する。
2. **週次側のレグ数を定数 1往復/週と決め打ちせず、経路B と同じ `legs[]` 配列から拾う**。
   最終週が期間末で切れている場合（`exitTiming="close"` かつ最終営業日が金曜）に
   手仕舞いレグが `legs[nSeg]` に立つので、決め打ちだと不変量が壊れる。
3. **`c* ≤ 0` の分岐を UI に追加**。§6.1 の表示例は c\*>0 前提だったが、実データでは
   3銘柄とも負だった。この場合「吸収できる往復コストは存在せず、手数料の多寡は結論を変えない」
   と明示する（コスト控除トグルを操作しても結論が変わらないことの説明になる）。

### 11.4 検証時に踏んだ罠（再実装時の注意）

`t` は `excessLog` から作られるが、画面表示の「週次超過（平均）」は `excessSimple` である。
検証スクリプトで `σ = mean(excessSimple)·√n / t` と復元して §9.3-6 を検定したところ、
15〜26% ずれて FAIL した。**実装のバグではなく検証側の誤り**。コストは週あたり一定シフトなので
σ_log は不変 ⇒ 複数の c について `σ = (週あたりシフト)·√n / Δt` が**同一値になること**を見るのが正しい
（実測: 相対差 <1e-6 で一定）。

---

## 付録A. 参照ファイル

| ファイル | 役割 |
|---|---|
| `app/lib/weekday-vs-bh.ts` | 本体。4検定と2データ経路 |
| `app/components/analysis/WeekdayVsBuyHoldChart.tsx` | UI。`cal-weekday-vs-bh` |
| `app/lib/strategy-vs-benchmark.ts` | 共通コスト規約（`roundTripCost`）。**規約はここに合わせる** |
| `app/lib/spread-estimator.ts` | `representativeSpread`（CS中央値）／`estimateSpread`（ローリング） |
| `app/lib/weekday-trade.ts` | `runStrategyTrades`。**独自の `costBps` があるので二重課金に注意** |
| `app/lib/stats-significance.ts` | `mean`/`std`/`median`/`tTest`/`quantileSorted` |
| `docs/trading-usability-improvements.md` | §5 が本件の出典 |

## 付録B. §4 の数値を再現するスクリプト

外部データ不要（合成データ）。scratchpad に `cost-sensitivity.ts` として置き
`npx tsx <path>` で実行すると §4 の表がそのまま出る。**本書だけで設計判断の根拠を
検証できるようにするため全文を残す。**

```ts
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};
function normalCdf(x: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 週次超過 = −(週末ギャップ)。4%の週に急変を混ぜて裾を厚くする
function makeWeeklyExcess(nWeeks: number, muGap: number, sdGap: number, seed = 3) {
  const rnd = mulberry32(seed);
  const out: number[] = [];
  for (let w = 0; w < nWeeks; w++) {
    const z = Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const jump = rnd() < 0.04 ? (rnd() < 0.5 ? -1 : 1) * 3 * sdGap * rnd() : 0;
    out.push(-(muGap + sdGap * z + jump));
  }
  return out;
}
function oneSidedT(d: number[]) {
  const n = d.length, m = mean(d), s = std(d);
  const t = s > 0 ? (m * Math.sqrt(n)) / s : 0;
  return { t, p: 1 - normalCdf(t), mean: m, sd: s };
}
function wilcoxonSign(d: number[]) {
  const nz = d.filter((v) => v !== 0);
  const n = nz.length;
  const abs = nz.map((v) => ({ a: Math.abs(v), sign: v > 0 ? 1 : -1 })).sort((x, y) => x.a - y.a);
  const ranks = new Array(n).fill(0);
  let k = 0;
  while (k < n) {
    let j = k;
    while (j + 1 < n && abs[j + 1].a === abs[k].a) j++;
    const avg = (k + 1 + j + 1) / 2;
    for (let t = k; t <= j; t++) ranks[t] = avg;
    k = j + 1;
  }
  let Wp = 0;
  for (let t = 0; t < n; t++) if (abs[t].sign > 0) Wp += ranks[t];
  const muW = (n * (n + 1)) / 4, varW = (n * (n + 1) * (2 * n + 1)) / 24;
  const zW = (Wp - muW) / Math.sqrt(varW);
  const kPos = nz.filter((v) => v > 0).length;
  const zS = (kPos - n / 2) / Math.sqrt(n / 4);
  return { zW, pW: 1 - normalCdf(zW), zS, pS: 1 - normalCdf(zS), posFrac: kPos / n };
}

const YEARS = 10, NW = Math.round(YEARS * 52);
const excess = makeWeeklyExcess(NW, 0.0006, 0.013);
console.log(`${NW}週  平均${(mean(excess) * 100).toFixed(4)}%  σ${(std(excess) * 100).toFixed(3)}%`);
for (const c of [0, 0.0005, 0.001, 0.002, 0.003, 0.005]) {
  const net = excess.map((e) => e - c);
  const t = oneSidedT(net), w = wilcoxonSign(net);
  console.log(
    `c=${(c * 100).toFixed(2)}%  平均${(t.mean * 100).toFixed(4)}%  t=${t.t.toFixed(2)} p=${t.p.toFixed(3)}` +
    `  W z=${w.zW.toFixed(2)}  符号 z=${w.zS.toFixed(2)} 正${(w.posFrac * 100).toFixed(1)}%`
  );
}
// 解析式の検証: Δt = −c√n/σ
const t0 = oneSidedT(excess), t1 = oneSidedT(excess.map((e) => e - 0.003));
console.log(`Δt 実測 ${(t1.t - t0.t).toFixed(3)}  理論 ${(-0.003 * Math.sqrt(NW) / t0.sd).toFixed(3)}`);
// JKM の θ が μ に依存する件
const theta = (sra: number, srb: number, rho: number, T: number) =>
  (1 / T) * (2 * (1 - rho) + 0.5 * (sra * sra + srb * srb - 2 * sra * srb * rho * rho));
const T = YEARS * 252, rho = 0.93, sdD = 0.018, cDaily = (0.003 * 52) / 252;
const sraG = 0.0004 / sdD, srbG = 0.00045 / sdD, sraN = (0.0004 - cDaily) / sdD;
console.log(`JKM z: ${((sraG - srbG) / Math.sqrt(theta(sraG, srbG, rho, T))).toFixed(3)}` +
  ` → ${((sraN - srbG) / Math.sqrt(theta(sraN, srbG, rho, T))).toFixed(3)}` +
  `  √θ変化 ${((Math.sqrt(theta(sraN, srbG, rho, T)) / Math.sqrt(theta(sraG, srbG, rho, T)) - 1) * 100).toFixed(4)}%`);
```

期待される出力（抜粋）:

```
520週  平均0.0462%  σ1.352%
c=0.00%  平均0.0462%  t=0.78 p=0.218  W z=0.84  符号 z=0.88 正51.9%
c=0.30%  平均-0.2538%  t=-4.28 p=1.000  W z=-4.06  符号 z=-3.42 正42.5%
Δt 実測 -5.059  理論 -5.059
JKM z: -0.373 → -4.975  √θ変化 0.2035%
```

---

## 付録C. 記号

| 記号 | 意味 |
|---|---|
| `e_w` | 週次超過リターン（戦略_w − B&H_w = −捨てた区間） |
| `c` / `costRT` | 往復コスト（比率）＝ 往復スプレッド + 2×片道手数料 |
| `c*` | Break-even。期待値がゼロになる往復コスト = `mean(e_w)` |
| `σ` | 週次超過の標準偏差 |
| `n` | 週数（`nWeeks`） |
| `SRa`, `SRb` | 日次 Sharpe（戦略・B&H）。JKM の θ に入る |
| `ρ` | 戦略と B&H の日次リターン相関 |
