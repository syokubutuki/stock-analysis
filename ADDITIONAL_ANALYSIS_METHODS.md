# 追加可能な解析手法一覧

stock-analysisに既に実装されている30+の手法を踏まえ、新たに追加可能な解析手法をカテゴリ別に整理する。

---

## 既存手法の要約

| カテゴリ | 実装済み |
|---------|---------|
| 基本 | SMA(5/25/75), 差分系列, 出来高分析 |
| 変換 | 対数リターン, ランク変換, ボラ正規化 |
| 分布 | ヒストグラム, Q-Q, 歪度/尖度, Jarque-Bera |
| 相関 | ACF, PACF (Levinson-Durbin) |
| ボラティリティ | EWMA(λ=0.94), 実現ボラ, レジーム分割, ARCHクラスタリング |
| 周波数 | FFT(Cooley-Tukey), CWT(Morlet), スペクトル傾斜 |
| 分解 | EMD(IMF抽出), Hilbert変換(瞬時振幅/位相) |
| 非線形 | Takens埋め込み, リカレンスプロット, Lyapunov指数 |
| エントロピー | Shannon, Permutation, Sample, マルチスケール, Fisher情報量 |
| フラクタル | DFA, MF-DFA, Hurst指数, 特異スペクトル |
| ネットワーク | Visibility Graph, Ordinal Network |
| カレンダー | 曜日/月効果 |

---

## 1. 複素解析信号・量子力学的アプローチ（新カテゴリ）

既存のHilbert変換を拡張し、株価を複素空間で統一的に扱う。

### 1.1 解析信号の位相空間表現

**概要**: 対数リターンにHilbert変換を適用して解析信号 z(t) = r(t) + i·H[r(t)] を構成し、瞬時振幅・位相・周波数を時系列として可視化する。

**既存との違い**: EMDChart内でHilbertは使われているが、IMF分解後の各モードに対してのみ。ここでは生のリターン系列全体の瞬時状態を直接追跡する。

**実装イメージ**:
```typescript
function analyticSignal(returns: number[]): { amplitude: number[]; phase: number[]; instFreq: number[] } {
  const z = hilbertTransform(returns); // 既存のwavelet.tsから流用可能
  const amplitude = z.map(([re, im]) => Math.sqrt(re*re + im*im));
  const phase = z.map(([re, im]) => Math.atan2(im, re));
  const unwrapped = unwrapPhase(phase);
  const instFreq = unwrapped.slice(1).map((p, i) => (p - unwrapped[i]) / (2 * Math.PI));
  return { amplitude, phase: unwrapped, instFreq };
}
```

**可視化**: 瞬時振幅のエンベロープ + 瞬時周波数の時系列 + 位相の極座標プロット

---

### 1.2 エルミート内積による銘柄間結合解析

**概要**: 複数銘柄の解析信号から複素内積行列（エルミート行列）を構成し、固有値分解で市場の主要モードを抽出する。

**既存との違い**: 実数PCAは未実装。複素PCAとして位相情報込みの主成分を得られる。

**実装イメージ**:
```typescript
function hermitianCorrelation(signals: Complex[][]): {
  matrix: Complex[][]; eigenvalues: number[]; eigenvectors: Complex[][];
} {
  // H_ij = Σ_t z_i*(t) · z_j(t) / T — エルミート行列
  // 固有値は実数（エネルギー準位に相当）
  // arg(H_ij) → 銘柄i,j間の位相差（リード・ラグ）
}
```

**可視化**: 相互作用行列のヒートマップ（振幅=色の濃さ、位相差=色相）+ 固有値スペクトル

---

### 1.3 Phase Locking Value (PLV) — 位相同期指標

**概要**: 振幅を正規化した解析信号同士の位相一致度を測定。PLV=1で完全同期、0でランダム。

**用途**: 「今この瞬間に連動している銘柄ペア」をリアルタイム検出

**実装イメージ**:
```typescript
function phaseLockingValue(phase1: number[], phase2: number[], window: number): number[] {
  // PLV = |1/W Σ exp(i·(φ1(t) - φ2(t)))| をローリング計算
}
```

---

### 1.4 Hilbert-Huang スペクトル (HHS)

**概要**: 既存のEMD + Hilbert変換を組み合わせて、時間-周波数-エネルギーの3次元分布を構成する。

**既存との違い**: EMDChartはIMFを個別に表示するだけ。HHSは全IMFの瞬時周波数×振幅を重ねて1枚の時間-周波数マップにする。CWTスカログラムとの比較が可能。

**実装イメージ**:
```typescript
function hilbertHuangSpectrum(imfs: number[][], times: number[]): {
  timeAxis: number[]; freqAxis: number[]; energy: number[][];
} {
  // 各IMFのHilbert変換 → 瞬時周波数 + 振幅²
  // 時間-周波数グリッドにエネルギーを配分
}
```

**可視化**: CWTスカログラムと同様のヒートマップだが、周波数解像度が適応的

---

## 2. ボラティリティ・リスク拡張

### 2.1 GARCH(1,1) モデル

**概要**: σ²(t) = ω + α·r²(t-1) + β·σ²(t-1) のパラメータ推定と条件付きボラティリティ予測。

**既存との違い**: EWMAは固定λ=0.94。GARCHはα, βをデータから最尤推定し、ボラティリティの持続性(α+β)を定量化する。

**実装イメージ**:
```typescript
function garchFit(returns: number[]): {
  omega: number; alpha: number; beta: number;
  persistence: number; // α + β
  conditionalVol: number[]; // σ(t)の時系列
  halfLife: number; // ボラティリティショックの半減期
} {
  // 対数尤度 L = Σ [-0.5 * (log(σ²_t) + r²_t/σ²_t)] を最大化
  // Nelder-Mead等の最適化（外部ライブラリ不要で実装可能）
}
```

**追加ポイント**: α+β が1に近いほどボラティリティショックが長期持続 (IGARCH)

---

### 2.2 非対称ボラティリティ (Leverage Effect)

**概要**: 下落時にボラティリティが上昇しやすい非対称性（レバレッジ効果）の検出。

**実装イメージ**:
```typescript
function leverageEffect(returns: number[], absReturns: number[]): {
  asymmetryCoeff: number; // 負リターン時のvol上昇率 / 正リターン時
  newsImpactCurve: { return: number; vol: number }[]; // r → σ の応答曲線
}
```

---

### 2.3 ジャンプ検出 (Barndorff-Nielsen-Shephard)

**概要**: 実現ボラティリティと二乗変動の差からジャンプ成分を分離。異常な急変を統計的に検出する。

**実装イメージ**:
```typescript
function detectJumps(returns: number[]): {
  jumpDays: number[]; // ジャンプ検出日のインデックス
  jumpSizes: number[];
  bipower: number[]; // Bipower Variation（連続成分のみ）
  jumpRatio: number; // 全分散に占めるジャンプの割合
}
```

---

### 2.4 Realized Variance 分解

**概要**: 実現分散を連続成分(拡散)とジャンプ成分に分解し、ボラティリティの構造を明らかにする。

---

## 3. レジーム・状態遷移

### 3.1 隠れマルコフモデル (HMM)

**概要**: 2~3状態のHMMをリターン系列にフィッティングし、「強気/弱気/横ばい」レジームの確率的推移を推定。

**既存との違い**: volatility.tsのレジーム分割は33%/67%パーセンタイルによる静的分割。HMMは確率的遷移と状態の同時推定を行う。

**実装イメージ**:
```typescript
function fitHMM(returns: number[], nStates: number): {
  states: number[]; // 各時点の最尤状態 (Viterbi)
  stateProbabilities: number[][]; // 各時点の各状態の確率
  transitionMatrix: number[][]; // 状態遷移行列
  stateMeans: number[]; // 各状態のリターン平均
  stateVols: number[]; // 各状態のボラティリティ
  expectedDuration: number[]; // 各状態の期待持続日数
} {
  // Baum-Welch (EM) アルゴリズムで推定
  // Forward-Backward で状態確率、Viterbi で最尤パス
}
```

**可視化**: 株価チャートに状態確率のオーバーレイ + 遷移行列の有向グラフ

---

### 3.2 Change Point Detection (変化点検出)

**概要**: 平均やボラティリティの構造的変化が発生した時点を統計的に検出。

**実装イメージ**:
```typescript
function detectChangePoints(values: number[], method: 'cusum' | 'binseg'): {
  changePoints: number[]; // 変化点のインデックス
  segments: { start: number; end: number; mean: number; vol: number }[];
  penalty: number; // BIC/AICによるモデル選択
}
```

**アルゴリズム**: CUSUM (累積和) または Binary Segmentation

---

## 4. 因果・情報伝達

### 4.1 Transfer Entropy (移転エントロピー)

**概要**: 系列X → 系列Yへの情報の方向性のある流れを測定。Granger因果の非線形一般化。

**用途**: 出来高 → 価格の因果関係、銘柄間のリード・ラグ

**実装イメージ**:
```typescript
function transferEntropy(source: number[], target: number[], lag: number, bins: number): {
  te_xy: number; // X → Y への移転エントロピー
  te_yx: number; // Y → X
  netFlow: number; // te_xy - te_yx（正ならXがYを駆動）
  significance: number; // サロゲートテストによるp値
}
```

---

### 4.2 Granger Causality (グレンジャー因果性)

**概要**: 線形VAR(p)モデルに基づく因果検定。出来高→価格、日経→個別銘柄等。

**実装イメージ**:
```typescript
function grangerTest(x: number[], y: number[], maxLag: number): {
  fStatistic: number;
  pValue: number;
  optimalLag: number; // BICで選択
  direction: 'x→y' | 'y→x' | 'bidirectional' | 'none';
}
```

---

### 4.3 Mutual Information (相互情報量)

**概要**: 2変数間の非線形依存性を測定。ピアソン相関の一般化。

**既存との違い**: ACFは線形相関のみ。MIは非線形依存も捕捉。

**実装イメージ**:
```typescript
function mutualInformation(x: number[], y: number[], bins: number): number {
  // MI = Σ p(x,y) · log(p(x,y) / (p(x)·p(y)))
  // ヒストグラムベースの推定
}

function timeLaggedMI(values: number[], maxLag: number): number[] {
  // 自己相互情報量 — 非線形ACFに相当
  // 最初の極小値がTakens埋め込みの最適τ
}
```

---

## 5. フラクタル・スケーリング拡張

### 5.1 R/S解析 (Rescaled Range)

**概要**: Hurstの古典的手法。DFAの代替として、別角度からHurst指数を推定。

**既存との違い**: DFAは多項式トレンド除去。R/S解析は範囲/標準偏差比でスケーリングを見る。2手法の一致がHurst指数推定の信頼性を高める。

**実装イメージ**:
```typescript
function rsAnalysis(values: number[]): {
  hurst: number;
  scales: number[];
  rsValues: number[];
  confidence: [number, number]; // 95%信頼区間
}
```

---

### 5.2 Detrended Cross-Correlation (DCCA)

**概要**: DFAの2変数版。2つの時系列間のスケール依存的な相関を測定。

**用途**: 価格-出来高の長期相関構造、セクター間の連動性

**実装イメージ**:
```typescript
function dcca(x: number[], y: number[]): {
  scales: number[];
  rho: number[]; // スケールごとのDCCA相関係数 ρ(s)
  crossHurst: number; // クロスHurst指数
}
```

---

### 5.3 相関次元 (Grassberger-Procaccia)

**概要**: 位相空間再構成後のアトラクタの次元を推定。低次元なら決定論的構造あり。

**既存との違い**: Lyapunov指数はカオスの「強さ」、相関次元はアトラクタの「複雑さ」を測定。

**実装イメージ**:
```typescript
function correlationDimension(embedded: number[][], rRange: number[]): {
  dimension: number; // D2
  logR: number[];
  logC: number[]; // log C(r) vs log r の傾き
}
```

---

## 6. 時間-周波数・信号処理拡張

### 6.1 短時間フーリエ変換 (STFT) スペクトログラム

**概要**: 固定窓幅のFFTをスライドさせて時間-周波数表現を得る。CWT(連続ウェーブレット)との直接比較に使える。

**既存との違い**: CWTはスケール可変だが計算コスト大。STFTは窓幅固定で高速かつ解釈しやすい。

**実装イメージ**:
```typescript
function stft(values: number[], windowSize: number, hopSize: number): {
  timeAxis: number[]; freqAxis: number[]; magnitude: number[][];
}
```

---

### 6.2 Wavelet Coherence (ウェーブレットコヒーレンス)

**概要**: 2つの時系列のCWT間の時間-周波数コヒーレンスと位相差を計算。

**用途**: 価格と出来高がどの時間スケールで同期しているか

**実装イメージ**:
```typescript
function waveletCoherence(x: number[], y: number[], times: number[]): {
  coherence: number[][]; // 0-1のコヒーレンスマップ
  phaseDiff: number[][]; // 位相差マップ（矢印方向で表現）
  timeAxis: number[];
  periodAxis: number[];
}
```

**可視化**: コヒーレンスヒートマップ上に位相差の矢印をオーバーレイ

---

### 6.3 スペクトルエントロピー

**概要**: パワースペクトルを確率分布とみなしたShannonエントロピー。周波数成分の分散度を測定。

**既存との違い**: 既存のエントロピーは時間領域。スペクトルエントロピーは周波数領域での複雑性指標。

**実装イメージ**:
```typescript
function spectralEntropy(spectrum: { power: number }[]): number {
  const total = spectrum.reduce((s, v) => s + v.power, 0);
  const probs = spectrum.map(v => v.power / total);
  return -probs.reduce((s, p) => s + (p > 0 ? p * Math.log2(p) : 0), 0) / Math.log2(probs.length);
  // 正規化: 0 = 単一周波数, 1 = 白色雑音
}
```

---

## 7. 統計モデル・予測

### 7.1 状態空間モデル (カルマンフィルタ)

**概要**: 隠れ状態の時間発展＋観測方程式。トレンドと周期成分をオンラインで分離推定。

**関係性**: 量子力学的アプローチとの対応が深い。
- 状態空間: x(t+1) = F·x(t) + w(t) ← 隠れ状態の発展
- 量子的: |ψ(t)⟩の時間発展 ← ハミルトニアンで支配
- 両方とも「隠れた状態が実数観測として射影される」構造

**実装イメージ**:
```typescript
function kalmanFilter(observations: number[]): {
  filteredState: number[]; // 推定トレンド
  predictedState: number[]; // 1ステップ先予測
  filterGain: number[]; // カルマンゲインの推移
  innovationVariance: number[]; // 予測誤差分散
  logLikelihood: number;
}
```

**可視化**: 株価 + フィルタ推定値 + 予測区間 + カルマンゲインの推移

---

### 7.2 Kramers-Moyal 係数 (ドリフト・拡散推定)

**概要**: リターンの条件付きモーメントから、確率微分方程式 dp = μ(p)dt + σ(p)dW の局所ドリフトμと拡散σを非パラメトリックに推定。

**用途**: 株価がどのレベルで引力/反発を受けるか可視化

**実装イメージ**:
```typescript
function kramersMoyal(returns: number[], prices: number[], bins: number): {
  priceLevels: number[];
  drift: number[]; // μ(p): 各価格帯での期待方向
  diffusion: number[]; // σ(p): 各価格帯でのボラティリティ
  potential: number[]; // V(p) = -∫μ(p)dp: ポテンシャル関数（安定点を可視化）
}
```

**可視化**: 株価レベル vs ドリフト/拡散 + ポテンシャル関数のグラフ

---

## 8. ネットワーク・トポロジー拡張

### 8.1 Horizontal Visibility Graph (HVG)

**概要**: 既存のNatural Visibility Graphの簡略版。2点間の水平可視性で接続。

**既存との違い**: NVGよりも計算が高速で、ランダム性の理論的ベースラインが既知（λ = ln(3/2) ≈ 0.405）。NVGとの比較で非線形構造の強さを測定。

---

### 8.2 Recurrence Network

**概要**: 既存のリカレンスプロットの隣接行列をグラフとして解析し、ネットワーク指標を算出。

**既存との違い**: RecurrencePlotは視覚的パターン＋基本統計量(RR, DET, LAM)のみ。グラフとして扱えば中心性指標、コミュニティ検出が可能。

**実装イメージ**:
```typescript
function recurrenceNetwork(recurrenceMatrix: boolean[][]): {
  degreeDistribution: number[];
  clusteringCoeff: number;
  transitivity: number;
  betweennessCentrality: number[];
  communities: number[]; // コミュニティID
}
```

---

## 9. 高次統計・テイルリスク

### 9.1 Copula依存構造

**概要**: 周辺分布と依存構造を分離し、テイル(極端値)における依存性を測定。

**用途**: 「通常時は無相関だが暴落時に同時に下落する銘柄ペア」の検出

**実装イメージ**:
```typescript
function tailDependence(x: number[], y: number[], quantile: number): {
  lowerTail: number; // 左テイル依存係数 (暴落連動性)
  upperTail: number; // 右テイル依存係数 (急騰連動性)
  kendallTau: number; // ランク相関
}
```

---

### 9.2 Extreme Value Theory (極値統計)

**概要**: リターンの極端な裾をGPD (Generalized Pareto Distribution) でモデル化し、VaR/Expected Shortfallを精密推定。

**実装イメージ**:
```typescript
function extremeValueAnalysis(returns: number[], threshold: number): {
  shape: number; // ξ: 裾の形状パラメータ
  scale: number; // β
  var95: number; // 95% Value at Risk
  var99: number;
  expectedShortfall: number; // CVaR
  returnLevel: { period: number; level: number }[]; // n日再現期間リターン
}
```

**可視化**: 裾の確率プロット + VaR/ES水準の表示

---

### 9.3 Higher-Order Cumulants (高次キュムラント)

**概要**: 3次(歪度)・4次(尖度)を超えた5次・6次キュムラントを計算。ガウスからの逸脱をより精密に定量。

---

## 10. 情報幾何・位相的手法

### 10.1 Topological Data Analysis (TDA) — パーシステントホモロジー

**概要**: 時系列のTakens埋め込みから点群のトポロジーを抽出。パーシステンスダイアグラムで「消えにくい構造」を検出。

**実装イメージ**:
```typescript
function persistentHomology(embedded: number[][]): {
  diagram: { birth: number; death: number; dimension: number }[];
  persistence: number[]; // death - birth（長いほど頑健な構造）
  bettiNumbers: number[]; // 各次元の位相的特徴数
}
```

**可視化**: パーシステンスダイアグラム (birth vs death の散布図)

---

### 10.2 Information Geometry — Fisher-Rao距離

**概要**: リターン分布をリーマン多様体上の点とみなし、分布間の測地距離でレジーム変化を検出。

**既存との違い**: Fisher情報量は既に実装済み。Fisher-Rao距離はその時間方向の積分で、「分布がどれだけ変化したか」のグローバルな指標。

---

## 実装優先度の提案

### 高優先度（インパクト大 & 実装容易）

| 手法 | 理由 |
|------|------|
| 1.1 解析信号の位相空間表現 | 既存Hilbert変換を直接活用。瞬時周波数の可視化が強力 |
| 1.4 Hilbert-Huangスペクトル | 既存EMD+Hilbertの統合。CWTとの比較UI |
| 3.2 Change Point Detection | CUSUM実装が容易。トレンド転換の客観的検出 |
| 6.3 スペクトルエントロピー | 既存FFTの出力に数行追加するだけ |
| 4.3 相互情報量 (MI) | 既存のヒストグラム関数を流用可能 |

### 中優先度（やや複雑だが価値大）

| 手法 | 理由 |
|------|------|
| 2.1 GARCH(1,1) | EWMAの自然な拡張。最適化ループが必要 |
| 3.1 HMM | Baum-Welchの実装がやや複雑。レジーム分析の定番 |
| 7.1 カルマンフィルタ | 状態空間モデルの基本。量子的視点との橋渡し |
| 7.2 Kramers-Moyal | ポテンシャル関数の可視化が直感的で新しい |
| 4.1 Transfer Entropy | 方向性のある因果推定。出来高→価格の検証 |

### 低優先度（高度だが実装複雑）

| 手法 | 理由 |
|------|------|
| 1.2 エルミート内積 | 複数銘柄入力のUI変更が必要 |
| 9.1 Copula | 同上（複数銘柄） |
| 10.1 TDA | アルゴリズムが重い。理論的に面白いが実用はニッチ |
| 9.2 EVT | GPDフィッティングの数値安定性 |

---

## カテゴリ統合案（UIタブ構成）

既存の10タブに追加する場合：

```
既存タブへの追加:
  "周波数領域" ← STFT, HHS, スペクトルエントロピー
  "非線形動力学" ← 相関次元, Kramers-Moyal
  "ボラティリティ" ← GARCH, レバレッジ効果, ジャンプ検出
  "情報理論" ← 相互情報量, Transfer Entropy
  "ネットワーク" ← HVG, Recurrence Network
  "フラクタル" ← R/S解析, DCCA

新規タブ:
  "レジーム分析" ← HMM, Change Point, カルマンフィルタ
  "複素解析" ← 解析信号, 位相空間, PLV（将来的に複数銘柄対応時）
  "テイルリスク" ← EVT, Copula, VaR/ES
```
