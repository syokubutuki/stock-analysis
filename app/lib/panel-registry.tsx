"use client";

// パネル登録のレジストリ（M3）。**1パネル1レコード**をここだけに置く。
//
// 何を吸収したか
// --------------
// 移設前は、1つのパネルを足すのに5か所を触る必要があり、そのうち3か所は
// 「忘れても画面が壊れない」種類の台帳だった。
//
//   1. `app/page.tsx` の `dynamic()` 宣言（254件）
//   2. `app/page.tsx` の該当セクションの `groups[].items[]`（251件）
//   3. `app/lib/panel-sections.ts`          … ID接頭辞 → 節の対応表
//   4. `app/lib/panel-data-requirements.ts` … 終値だけの系列での3分類
//   5. `app/page.tsx` の `SERIES_AWARE_SECTIONS` … 系列セレクタの有効/無効
//
// 3〜5 は 1・2 から**導けるもの**を人間が二重に書いていた。このファイルは
// 1レコードに `section` / `closeOnly` / `input` を持たせ、3〜5 を導出に変える。
// 導出になった時点で「台帳の更新を忘れる」という壊れ方そのものが消える。
//
// 触るときの制約
// --------------
// * **パネルIDは変えない。** 共有URL `?panel=<id>` と localStorage `sa:open:<id>`
//   の鍵である。変えるとその利用者にとっては「前に見ていた分析が開かない」形で
//   静かに壊れる。`__tests__/fixtures/panel-ids.golden.ts` が並び順ごと固定している
// * **`closeOnly: "safe"` は「終値だけで成立することを検証した」という意味ではない。**
//   2026-08-17 の移設時点で UNAVAILABLE/CAUTION のどちらにも入っていなかったものを、
//   挙動を変えずに写しただけである。価値は既存分類の正しさではなく、
//   **これ以降に足したパネルが黙って safe に紛れ込めない**点にある（型が必須にしている）
// * `ssr: false` の動的読み込みは AGENTS.md の規約。`dynamic()` の中の `import()` は
//   文字列リテラルのまま置くこと（バンドラのチャンク分割がこの解析に乗っている）
//
// 終値だけの系列（投信の基準価額）の3分類について
// -----------------------------------------------
// 投信は **全バーで open==high==low==close かつ volume==0** である（元データの性質で
// あってバグではない）。この系列を出来高系・日中系のパネルに通すと、例外も警告も出ず、
// 計算も通り、**意味のない数字が意味ありげに表示される**。
// 判定は銘柄種別ではなくデータの性質で行う（`page.tsx` の `hasCloseOnlyMarketData`）。
// 銘柄種別で切ると、同じ性質を持つ別の配信元が増えたときに取りこぼす。
//
//   `unavailable` … 出来高・OHLC内訳・日中/夜間そのものが対象。本体をマウントせず理由を出す
//   `caution`     … パネル内の一部のサブ分析だけがそうなる。冒頭に注意書きを出す
//   `safe`        … 終値だけで結果が成立する（上記のとおり「検証済み」ではない）
//
// 2026-08-26 に UNAVAILABLE へ倒した4件（高値・安値を要するため別の量に縮退する）:
//   `tech-adx`（True Range 由来）/ `tech-breakout`（ドンチャン・前日高安）/
//   `vol-atr`（TR がギャップ項を失い |ΔC| になる）/ `tech-stoch`（実質 close ベースの %K）
// 投信 0331418A で tech-adx が ADX 13.64 ともっともらしい誤解釈を出したため、
// 注意書きを添えて結果を残す caution ではなく、4件とも結果を隠す unavailable とした。

import dynamic from "next/dynamic";
import type { ComponentType } from "react";

import ChartPlaceholder from "../components/analysis/ChartPlaceholder";
import type { PeriodKey } from "../hooks/useAnalysisData";
import type { SeriesMode } from "./series-mode";
import type { PricePoint } from "./types";

export type SectionKey =
  | "basic"
  | "technical"
  | "ohlc"
  | "risk"
  | "derivatives"
  | "transform"
  | "distribution"
  | "volatility"
  | "frequency"
  | "nonlinear"
  | "entropy"
  | "fractal"
  | "network"
  | "conditional"
  | "edge"
  | "asof"
  | "calendar"
  | "regime"
  | "causal"
  | "tailrisk"
  | "simulation"
  | "discretionary"
  | "quantum";

/** 終値だけが配信される系列（投信の基準価額）での扱い。冒頭の注記を読むこと。 */
export type CloseOnlyRequirement = "unavailable" | "caution" | "safe";

/**
 * パネルが受け取る入力の形。実在するのはこの9通りだけで、新しい形を増やすときは
 * `PANEL_INPUT_PROPS` と `panelProps()` の両方に足すこと（型が落とす）。
 *
 * `filtered` は PeriodSelector で切った期間、`all` は10年フル。期間を変えて
 * 見せたい分析は前者、標本数が要る検定系は後者（`useAnalysisData.ts`）。
 */
export type PanelInput =
  | "filtered"
  | "filtered+series"
  | "filtered+period"
  | "filtered+ticker"
  | "all"
  | "all+period"
  | "all+ticker"
  | "ticker"
  | "none";

/** `input` ごとに、そのパネルのコンポーネントが受け取る props の形。 */
interface PanelInputPropsMap {
  "filtered": { prices: PricePoint[] };
  "filtered+series": { prices: PricePoint[]; seriesMode: SeriesMode };
  "filtered+period": { prices: PricePoint[]; period: PeriodKey };
  "filtered+ticker": { prices: PricePoint[]; ticker: string };
  "all": { prices: PricePoint[] };
  "all+period": { prices: PricePoint[]; period: PeriodKey };
  "all+ticker": { prices: PricePoint[]; ticker: string };
  "ticker": { ticker: string };
  "none": Record<string, never>;
}

/** 9通りを1つに均した、描画時に spread する props。 */
export interface PanelSpreadProps {
  prices?: PricePoint[];
  period?: PeriodKey;
  seriesMode?: SeriesMode;
  ticker?: string;
}

/** page.tsx が持っていて、パネルへ渡しうる値の全体。 */
export interface PanelRenderContext {
  filteredPrices: PricePoint[];
  allPrices: PricePoint[];
  period: PeriodKey;
  seriesMode: SeriesMode;
  ticker: string;
  currency: string;
}

/** `input` の宣言どおりの props を組み立てる。page.tsx 側に分岐を持たせない。 */
export function panelProps(input: PanelInput, ctx: PanelRenderContext): PanelSpreadProps {
  switch (input) {
    case "filtered":
      return { prices: ctx.filteredPrices };
    case "filtered+series":
      return { prices: ctx.filteredPrices, seriesMode: ctx.seriesMode };
    case "filtered+period":
      return { prices: ctx.filteredPrices, period: ctx.period };
    case "filtered+ticker":
      return { prices: ctx.filteredPrices, ticker: ctx.ticker };
    case "all":
      return { prices: ctx.allPrices };
    case "all+period":
      return { prices: ctx.allPrices, period: ctx.period };
    case "all+ticker":
      return { prices: ctx.allPrices, ticker: ctx.ticker };
    case "ticker":
      return { ticker: ctx.ticker };
    case "none":
      return {};
  }
}

/** `input` が `seriesMode` を実際に消費するか（系列セレクタの有効判定の実体）。 */
export function consumesSeriesMode(input: PanelInput): boolean {
  return input === "filtered+series";
}

export interface PanelEntry {
  /** 不変。共有URL `?panel=` と localStorage `sa:open:<id>` の鍵 */
  id: string;
  title: string;
  input: PanelInput;
  closeOnly: CloseOnlyRequirement;
  Component: ComponentType<PanelSpreadProps>;
}

interface PanelSpec<K extends PanelInput> {
  id: string;
  title: string;
  input: K;
  closeOnly: CloseOnlyRequirement;
  /** 読み込み中プレースホルダの高さ。レイアウトシフトを防ぐためのもの */
  height: number;
  load: () => Promise<{ default: ComponentType<PanelInputPropsMap[K]> }>;
}

/**
 * 1パネルを登録する。`input` の宣言と実際のコンポーネントの props が食い違えば
 * ここで型エラーになる（`load` の戻り値の型が `input` に紐づいている）。
 */
function definePanel<K extends PanelInput>(spec: PanelSpec<K>): PanelEntry {
  return {
    id: spec.id,
    title: spec.title,
    input: spec.input,
    closeOnly: spec.closeOnly,
    Component: dynamic(spec.load, {
      ssr: false,
      loading: () => <ChartPlaceholder height={spec.height} />,
    }) as ComponentType<PanelSpreadProps>,
  };
}

export interface PanelGroup {
  /** グループ見出し。無いグループは見出しを描かない */
  group?: string;
  panels: PanelEntry[];
}

/** `AccordionSection` の外に置かれるワークスペース（FU27）が受け取る props。 */
export interface WorkspaceProps {
  prices: PricePoint[];
  ticker: string;
  currency: string;
}

export function workspaceProps(ctx: PanelRenderContext): WorkspaceProps {
  return { prices: ctx.allPrices, ticker: ctx.ticker, currency: ctx.currency };
}

export interface SectionDef {
  key: SectionKey;
  /** タブに出す目的語ベースの名前（U5）。`key` と違い変更可 */
  label: string;
  /** 副題に出す手法名（U5 で label と分離した） */
  method: string;
  description: string;
  /**
   * `panels`    … `AccordionSection` で折りたたみパネル群を描く
   * `workspace` … `AccordionSection` の外に常時表示のワークスペースを1つ描く。
   *                **パネルIDを持たず、共有URL `?panel=` と結果バッジの対象外**（FU27）。
   *                複数の入力・検証工程とシナリオ保存を一体で扱うため、単一の
   *                折りたたみ分析ではない。擬似パネルIDを作らないこと
   */
  render: "panels" | "workspace";
  groups: PanelGroup[];
  Workspace?: ComponentType<WorkspaceProps>;
}

const DiscretionaryLab = dynamic(
  () => import("../components/analysis/DiscretionaryLab"),
  { ssr: false, loading: () => <ChartPlaceholder height={400} /> },
);

export const SECTIONS: SectionDef[] = [
  {
    key: "basic",
    label: "値動きの全体像を見る",
    method: "基本分析",
    description: "ローソク足・一目均衡表・支持/抵抗線・フィボナッチ・ベンチマーク比較",
    render: "panels",
    groups: [
      {
        group: "スコア・サマリー",
        panels: [
          definePanel({ id: "basic-structure-score", title: "構造スコアカード", input: "filtered", closeOnly: "safe", height: 200, load: () => import("../components/analysis/StructureScorecardChart") }),
          definePanel({ id: "basic-consolidated-score", title: "総合スコアカード（多分析の所見を1枚に集約）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/ConsolidatedScorecardChart") }),
          definePanel({ id: "basic-rolling-anim", title: "ローリング・アニメーション（リスク/リターンの遷移）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/RollingAnimationChart") }),
        ],
      },
      {
        group: "ベンチマーク・相対力",
        panels: [
          definePanel({ id: "basic-benchmark", title: "ベンチマーク比較", input: "all+period", closeOnly: "safe", height: 400, load: () => import("../components/analysis/BenchmarkChart") }),
          definePanel({ id: "basic-relstrength", title: "相対力（対ベンチマーク）と RSモメンタム", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/RelativeStrengthChart") }),
          definePanel({ id: "basic-relstrength-ext", title: "相対力の拡張（キャプチャ比・共和分・リードラグ）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/RelativeStrengthExtChart") }),
          definePanel({ id: "basic-dcc", title: "時変相関 DCC（対ベンチマーク）", input: "filtered+ticker", closeOnly: "safe", height: 400, load: () => import("../components/analysis/BenchmarkDCCChart") }),
        ],
      },
      {
        group: "出来高",
        panels: [
          definePanel({ id: "basic-volume", title: "出来高分析", input: "all+period", closeOnly: "unavailable", height: 200, load: () => import("../components/analysis/VolumeAnalysis") }),
          definePanel({ id: "basic-rvol", title: "相対出来高 RVOL（出来高の枯渇/急増）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/RelativeVolumeChart") }),
          definePanel({ id: "basic-vol-indicators", title: "出来高系指標の拡張（VPT/A-D/MFI/Force/EOM）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/VolumeIndicatorsChart") }),
          definePanel({ id: "basic-signed-volume", title: "出来高×リターンの符号付き分析（買い需要/売り需要の質）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/SignedVolumeChart") }),
          definePanel({ id: "basic-volume-profile", title: "出来高プロファイル (Volume at Price)", input: "filtered", closeOnly: "unavailable", height: 500, load: () => import("../components/analysis/VolumeProfileChart") }),
          definePanel({ id: "basic-volume-profile-ext", title: "期間ボリュームプロファイル拡張（POC・バリューエリア・HVN/LVN）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/VolumeProfileExtChart") }),
          definePanel({ id: "basic-volume-return", title: "出来高-リターン同時分析", input: "filtered", closeOnly: "unavailable", height: 320, load: () => import("../components/analysis/VolumeReturnChart") }),
          definePanel({ id: "basic-volume-lead", title: "出来高先行性分析", input: "filtered", closeOnly: "unavailable", height: 280, load: () => import("../components/analysis/VolumeLeadChart") }),
        ],
      },
      {
        group: "価格系列・その他",
        panels: [
          definePanel({ id: "basic-diff", title: "差分系列", input: "all+period", closeOnly: "safe", height: 250, load: () => import("../components/analysis/DiffSeriesChart") }),
          definePanel({ id: "basic-gap", title: "ギャップ・日中/夜間リターン分解", input: "all+period", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/GapAnalysisChart") }),
          definePanel({ id: "basic-holding", title: "最適保有期間分析", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/HoldingPeriodChart") }),
          definePanel({ id: "basic-mtf", title: "マルチタイムフレーム分析", input: "filtered", closeOnly: "safe", height: 200, load: () => import("../components/analysis/MultiTimeframeChart") }),
          definePanel({ id: "basic-behavioral", title: "行動ファイナンス指標", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/BehavioralChart") }),
          definePanel({ id: "basic-bias-coach", title: "投資家バイアス・コーチ（癖と対策）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/InvestorBiasCoach") }),
        ],
      },
    ],
  },
  {
    key: "technical",
    label: "売買タイミングを探す",
    method: "テクニカル",
    description: "RSI・MACD・BB・ADX・ストキャスティクス・OBV/VWAP",
    render: "panels",
    groups: [
      {
        panels: [
          definePanel({ id: "sa-technical", title: "テクニカル指標（RSI/MACD/BB ほか）", input: "all+period", closeOnly: "safe", height: 350, load: () => import("../components/analysis/TechnicalIndicators") }),
          definePanel({ id: "tech-adx", title: "ADX（Average Directional Index）", input: "all+period", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/ADXChart") }),
          definePanel({ id: "tech-stoch", title: "ストキャスティクス", input: "all+period", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/StochasticsChart") }),
          definePanel({ id: "tech-obvvwap", title: "OBV・VWAP", input: "all+period", closeOnly: "unavailable", height: 430, load: () => import("../components/analysis/OBVVWAPChart") }),
          definePanel({ id: "tech-vw", title: "出来高加重テクニカル指標", input: "filtered", closeOnly: "unavailable", height: 500, load: () => import("../components/analysis/VolumeWeightedTechChart") }),
          definePanel({ id: "tech-extra", title: "追加テクニカル指標", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/ExtraTechnicalChart") }),
          definePanel({ id: "tech-breakout", title: "ブレイクアウト統計（ドンチャン・前日高安）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/BreakoutStatsChart") }),
        ],
      },
    ],
  },
  {
    key: "ohlc",
    label: "値動きの内訳を見る",
    method: "OHLC分析",
    description: "ローソク足構造・MFE/MAE・レンジ・ギャップ散布図・レンジベースVol",
    render: "panels",
    groups: [
      {
        group: "ローソク足の構造・パターン",
        panels: [
          definePanel({ id: "sa-ohlc", title: "ローソク足構造分析", input: "all+period", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/CandleStructureChart") }),
          definePanel({ id: "ohlc-crash-surge", title: "連続暴落・暴騰ラン分析", input: "filtered", closeOnly: "safe", height: 500, load: () => import("../components/analysis/CrashSurgeStreakChart") }),
          definePanel({ id: "ohlc-pattern", title: "ローソク足パターン認識", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/CandlestickPatternChart") }),
          definePanel({ id: "ohlc-pattern-edge", title: "ローソク足パターンの統計的エッジ", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/CandlePatternEdgeChart") }),
          definePanel({ id: "ohlc-candle-run", title: "連続ローソク（陽連/陰連）の先行きリターン", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/CandleRunChart") }),
          definePanel({ id: "ohlc-wick", title: "髭非対称・圧力指標の時系列（買い圧/売り圧）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/WickPressureChart") }),
        ],
      },
      {
        group: "日中パス・引け・含み損益",
        panels: [
          definePanel({ id: "ohlc-intra-path", title: "日中パス推定", input: "filtered", closeOnly: "unavailable", height: 300, load: () => import("../components/analysis/IntradayPathChart") }),
          definePanel({ id: "ohlc-close-position", title: "Close Position分析（引け方分析）", input: "filtered", closeOnly: "unavailable", height: 280, load: () => import("../components/analysis/ClosePositionChart") }),
          definePanel({ id: "ohlc-true-range", title: "True Range分解", input: "filtered", closeOnly: "unavailable", height: 300, load: () => import("../components/analysis/TrueRangeDecompChart") }),
          definePanel({ id: "ohlc-mfemae", title: "MFE/MAE 分析（含み益・含み損の到達分布）", input: "all+period", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/MFEMAEChart") }),
          definePanel({ id: "ohlc-tpsl", title: "最適 TP/SL（保有期間別 MFE/MAE）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/TpSlOptimizerChart") }),
        ],
      },
      {
        group: "ギャップ・レンジ・ボラティリティ",
        panels: [
          definePanel({ id: "sa-ohlc-gap", title: "ギャップ散布図（夜間→日中の関係）", input: "all+period", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/GapScatterChart") }),
          definePanel({ id: "ohlc-gap-class", title: "窓の分類と窓埋め統計（gap-and-go vs fade）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/GapClassificationChart") }),
          definePanel({ id: "sa-ohlc-range", title: "日中レンジ分析", input: "all+period", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/IntradayRangeChart") }),
          definePanel({ id: "ohlc-range-vol", title: "レンジベース・ボラティリティ推定", input: "all+period", closeOnly: "unavailable", height: 300, load: () => import("../components/analysis/RangeVolatilityChart") }),
          definePanel({ id: "ohlc-ohlc-vol", title: "OHLCボラティリティ推定量の比較（Yang-Zhang ほか）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/OHLCVolatilityChart") }),
          definePanel({ id: "sa-ohlc-micro", title: "マイクロストラクチャー指標（スプレッド/インパクト）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/MicrostructureChart") }),
        ],
      },
    ],
  },
  {
    key: "risk",
    label: "損失とリスクを測る",
    method: "リスク指標",
    description: "ドローダウン・VaR/CVaR・シャープ/ソルティノ比率・ボラティリティスマイル",
    render: "panels",
    groups: [
      {
        group: "指標・ドローダウン",
        panels: [
          definePanel({ id: "sa-risk", title: "リスク指標", input: "all+period", closeOnly: "safe", height: 400, load: () => import("../components/analysis/RiskMetricsPanel") }),
          definePanel({ id: "risk-forecast-range", title: "短期予測レンジ（1〜3日）", input: "filtered", closeOnly: "unavailable", height: 350, load: () => import("../components/analysis/ForecastRangeChart") }),
          definePanel({ id: "risk-drawdown", title: "ドローダウン分析", input: "all+period", closeOnly: "safe", height: 400, load: () => import("../components/analysis/DrawdownChart") }),
          definePanel({ id: "risk-dd-dist", title: "ドローダウン期間・回復時間の分布", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/DrawdownDistChart") }),
        ],
      },
      {
        group: "VaR・テイル・裾",
        panels: [
          definePanel({ id: "risk-garch-var", title: "GARCH VaR予測", input: "filtered", closeOnly: "safe", height: 350, load: () => import("../components/analysis/GarchVarChart") }),
          definePanel({ id: "risk-cornish", title: "Cornish-Fisher VaR / オメガレシオ", input: "filtered", closeOnly: "safe", height: 350, load: () => import("../components/analysis/CornishFisherChart") }),
          definePanel({ id: "risk-rolling-var", title: "ローリング VaR / CVaR（historical / EVT / Cornish-Fisher）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/RollingVaRChart") }),
          definePanel({ id: "risk-volsmile", title: "ボラティリティスマイル", input: "filtered", closeOnly: "safe", height: 350, load: () => import("../components/analysis/VolSmileChart") }),
        ],
      },
      {
        group: "調整指標・下方リスク・その他",
        panels: [
          definePanel({ id: "risk-finance-theory", title: "Kelly基準 / Black-Scholes / Variance Swap", input: "filtered", closeOnly: "safe", height: 450, load: () => import("../components/analysis/FinanceTheoryChart") }),
          definePanel({ id: "risk-ratios", title: "リスク調整指標の拡充", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/RiskRatiosChart") }),
          definePanel({ id: "risk-downside", title: "下方リスク分解（半偏差・損失寄与・連敗分布）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/DownsideDecompChart") }),
          definePanel({ id: "risk-cond-beta", title: "条件付きベータ・下方ベータ（地合い別の感応度）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/ConditionalBetaChart") }),
          definePanel({ id: "risk-spread", title: "高安スプレッド推定（取引コスト・流動性の代理）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/SpreadEstimatorChart") }),
        ],
      },
    ],
  },
  {
    key: "derivatives",
    label: "派生商品の条件を試す",
    method: "デリバティブ",
    description: "Black-Scholesラボ(ペイオフ/Greeks)・実現Vol/VRP・先物カーブ/ロールイールド・デルタヘッジ",
    render: "panels",
    groups: [
      {
        group: "オプション（Black-Scholes）",
        panels: [
          definePanel({ id: "deriv-bs-lab", title: "Black-Scholes ラボ（ペイオフ・Greeks・パリティ）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/BlackScholesLabChart") }),
          definePanel({ id: "deriv-delta-hedge", title: "デルタヘッジ・シミュレータ（ガンマ・スキャルピング）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/DeltaHedgeSimChart") }),
        ],
      },
      {
        group: "ボラティリティ商品",
        panels: [
          definePanel({ id: "deriv-rv-vrp", title: "実現ボラティリティ・分散リスクプレミアム(VRP)", input: "filtered", closeOnly: "safe", height: 350, load: () => import("../components/analysis/RealizedVolVrpChart") }),
        ],
      },
      {
        group: "先物・フォワード",
        panels: [
          definePanel({ id: "deriv-futures-carry", title: "先物カーブ・コスト/キャリー・ロールイールド・ヘッジ比率", input: "filtered", closeOnly: "safe", height: 350, load: () => import("../components/analysis/FuturesCarryChart") }),
        ],
      },
    ],
  },
  {
    key: "transform",
    label: "比べやすい形に整える",
    method: "スケール変換",
    description: "対数リターン・順位変換・ボラ正規化・累積リターン・差分・Box-Cox・ドローダウン・Zスコア",
    render: "panels",
    groups: [
      {
        panels: [
          definePanel({ id: "sa-transform", title: "スケール・変換（対数/順位/ボラ正規化 ほか）", input: "filtered+series", closeOnly: "safe", height: 220, load: () => import("../components/analysis/TransformCharts") }),
          definePanel({ id: "transform-overnight", title: "オーバーナイト vs 日中エクイティ（リターンの時間帯分解）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/OvernightIntradayChart") }),
          definePanel({ id: "transform-exec-scan", title: "売買時刻スキャン（始値/終値・保有日数の最適エッジ探索）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/ExecutionTimingScanChart") }),
          definePanel({ id: "transform-weekday-decomp", title: "曜日別 夜間/日中エクイティ分解", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/WeekdayDecompChart") }),
        ],
      },
    ],
  },
  {
    key: "distribution",
    label: "値動きの癖を確かめる",
    method: "分布・相関",
    description: "リターン分布・QQプロット・ACF/PACF・分散比検定",
    render: "panels",
    groups: [
      {
        group: "分布形状",
        panels: [
          definePanel({ id: "sa-distribution", title: "リターン分布", input: "filtered+series", closeOnly: "safe", height: 300, load: () => import("../components/analysis/ReturnDistribution") }),
          definePanel({ id: "dist-shape", title: "分布形状の詳細分析", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/DistributionShapeChart") }),
          definePanel({ id: "dist-rolling-moments", title: "ローリング高次モーメント", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/RollingMomentsChart") }),
          definePanel({ id: "dist-violin", title: "条件付き分布・バイオリンプロット", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/ConditionalViolinChart") }),
          definePanel({ id: "dist-surface", title: "分布のダイナミクス（ローリング密度サーフェス）", input: "filtered+series", closeOnly: "safe", height: 350, load: () => import("../components/analysis/DistributionSurfaceChart") }),
          definePanel({ id: "dist-stylized", title: "Stylized Facts（定型化された事実）", input: "filtered+series", closeOnly: "safe", height: 350, load: () => import("../components/analysis/StylizedFactsChart") }),
        ],
      },
      {
        group: "自己相関・依存性・独立性",
        panels: [
          definePanel({ id: "dist-acf", title: "自己相関分析", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/ACFChart") }),
          definePanel({ id: "dist-acf-ext", title: "自己相関分析（拡張）", input: "filtered+series", closeOnly: "safe", height: 300, load: () => import("../components/analysis/ACFExtendedChart") }),
          definePanel({ id: "dist-lag", title: "ラグ構造・非線形依存性分析", input: "filtered+series", closeOnly: "caution", height: 500, load: () => import("../components/analysis/LagDependenceChart") }),
          definePanel({ id: "dist-crosscorr", title: "クロスコレログラム（夜間↔日中）", input: "filtered", closeOnly: "unavailable", height: 300, load: () => import("../components/analysis/CrossCorrelogramChart") }),
          definePanel({ id: "dist-independence", title: "独立性・ランダム性検定", input: "filtered+series", closeOnly: "safe", height: 200, load: () => import("../components/analysis/IndependenceTestsChart") }),
        ],
      },
      {
        group: "予測可能性・単位根・分散比",
        panels: [
          definePanel({ id: "dist-pred-accuracy", title: "ローリング予測精度", input: "filtered", closeOnly: "safe", height: 300, load: () => import("../components/analysis/PredictionAccuracyChart") }),
          definePanel({ id: "dist-inforatio", title: "情報比率ダッシュボード", input: "filtered", closeOnly: "caution", height: 300, load: () => import("../components/analysis/InfoRatioDashboard") }),
          definePanel({ id: "dist-unitroot", title: "単位根検定", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/UnitRootChart") }),
          definePanel({ id: "dist-vr", title: "分散比検定", input: "filtered+series", closeOnly: "safe", height: 300, load: () => import("../components/analysis/VarianceRatioChart") }),
          definePanel({ id: "dist-rolling-vr", title: "分散比のローリングと有意性（トレンド/回帰の切替監視）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/RollingVarianceRatioChart") }),
        ],
      },
    ],
  },
  {
    key: "volatility",
    label: "変動の大きさを読む",
    method: "ボラティリティ",
    description: "EWMA・GARCH・ATR・ケルトナーチャネル",
    render: "panels",
    groups: [
      {
        group: "推定・モデル",
        panels: [
          definePanel({ id: "sa-volatility", title: "ボラティリティ分析", input: "filtered+series", closeOnly: "safe", height: 300, load: () => import("../components/analysis/VolatilityChart") }),
          definePanel({ id: "vol-garch", title: "GARCH / レバレッジ効果 / ジャンプ検出", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/GarchChart") }),
          definePanel({ id: "vol-agarch", title: "非対称GARCHモデル", input: "filtered+series", closeOnly: "safe", height: 350, load: () => import("../components/analysis/AsymmetricGarchChart") }),
          definePanel({ id: "vol-heston", title: "Hestonモデル", input: "filtered", closeOnly: "safe", height: 450, load: () => import("../components/analysis/HestonChart") }),
          definePanel({ id: "vol-har", title: "HARモデル（日/週/月の実現ボラでボラ予測）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/HARChart") }),
        ],
      },
      {
        group: "期間構造・コーン・レンジ",
        panels: [
          definePanel({ id: "vol-atr", title: "ATR / ケルトナーチャネル", input: "filtered", closeOnly: "unavailable", height: 430, load: () => import("../components/analysis/ATRChart") }),
          definePanel({ id: "vol-term", title: "ボラティリティ期間構造", input: "filtered", closeOnly: "safe", height: 520, load: () => import("../components/analysis/VolTermStructureChart") }),
          definePanel({ id: "vol-cone", title: "ボラティリティ・コーン", input: "filtered", closeOnly: "safe", height: 350, load: () => import("../components/analysis/VolConeChart") }),
          definePanel({ id: "vol-range-cone", title: "レンジ由来ボラコーン（Yang-Zhang）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/RangeVolConeChart") }),
          definePanel({ id: "vol-range-contract", title: "レンジ収縮 → ブレイク（NR7・inside・スクイーズ）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/RangeContractionChart") }),
          definePanel({ id: "vol-leverage", title: "ボラのレバレッジ効果（下落→翌日ボラ拡大の非対称性）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/VolLeverageChart") }),
        ],
      },
    ],
  },
  {
    key: "frequency",
    label: "繰り返す周期を探す",
    method: "周波数領域",
    description: "FFT・ウェーブレット・コヒーレンス・EMD・解析信号・HHS・STFT・SSA・Lomb-Scargle",
    render: "panels",
    groups: [
      {
        group: "スペクトル・ウェーブレット",
        panels: [
          definePanel({ id: "freq-power", title: "パワースペクトル（FFT）", input: "filtered+series", closeOnly: "safe", height: 220, load: () => import("../components/analysis/PowerSpectrum") }),
          definePanel({ id: "freq-wavelet", title: "ウェーブレットスカログラム（Morlet CWT）", input: "filtered+series", closeOnly: "safe", height: 250, load: () => import("../components/analysis/WaveletChart") }),
          definePanel({ id: "sa-frequency-coherence", title: "ウェーブレットコヒーレンス", input: "filtered+series", closeOnly: "unavailable", height: 280, load: () => import("../components/analysis/WaveletCoherenceChart") }),
          definePanel({ id: "freq-lombscargle", title: "Lomb-Scargleペリオドグラム", input: "filtered+series", closeOnly: "safe", height: 300, load: () => import("../components/analysis/LombScargleChart") }),
          definePanel({ id: "sa-frequency-ssa", title: "特異スペクトル分析（SSA）", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/SSAChart") }),
        ],
      },
      {
        group: "EMD・解析信号・位相",
        panels: [
          definePanel({ id: "freq-emd", title: "EMD / Hilbert-Huang変換", input: "filtered+series", closeOnly: "safe", height: 300, load: () => import("../components/analysis/EMDChart") }),
          definePanel({ id: "freq-analytic", title: "解析信号と瞬時周波数", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/AnalyticSignalChart") }),
          definePanel({ id: "freq-complex", title: "複素平面表現", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/ComplexPlaneChart") }),
          definePanel({ id: "freq-zplane", title: "z平面ポールマップ（AR極）", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/ZPlanePoleChart") }),
          definePanel({ id: "freq-phaseclock", title: "位相時計（Cycle Phase Clock）", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/PhaseClockChart") }),
          definePanel({ id: "freq-hhs", title: "Hilbert-Huang Spectrum / STFT / スペクトルエントロピー", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/HilbertHuangChart") }),
        ],
      },
    ],
  },
  {
    key: "nonlinear",
    label: "複雑な変化を捉える",
    method: "非線形動力学",
    description: "アトラクタ・RQA・Lyapunov・位相空間予測・KM係数・TDA・投資シグナル",
    render: "panels",
    groups: [
      {
        group: "アトラクタ・埋め込み・位相",
        panels: [
          definePanel({ id: "sa-nonlinear", title: "アトラクタ指標の統合ビュー（条件の該当状況）", input: "filtered+series", closeOnly: "safe", height: 500, load: () => import("../components/analysis/AttractorSignalDashboard") }),
          definePanel({ id: "nl-embedding", title: "埋め込みパラメータ最適化", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/EmbeddingOptimizer") }),
          definePanel({ id: "nl-attractor", title: "アトラクタ探索（Takens埋め込み）", input: "filtered+series", closeOnly: "safe", height: 500, load: () => import("../components/analysis/AttractorExplorer") }),
          definePanel({ id: "nl-weekly-phase", title: "週内位相アトラクタ（動力学的週内アノマリー）", input: "filtered+series", closeOnly: "safe", height: 500, load: () => import("../components/analysis/WeeklyPhaseAttractorChart") }),
          definePanel({ id: "nl-periodic-phase", title: "一般周期 位相アトラクタ（月内・四半期内）", input: "filtered+series", closeOnly: "safe", height: 500, load: () => import("../components/analysis/PeriodicPhaseAttractorChart") }),
          definePanel({ id: "nl-phase-sync", title: "週次位相同期（マルチ銘柄 Kuramoto）", input: "none", closeOnly: "safe", height: 400, load: () => import("../components/analysis/WeeklyPhaseSyncChart") }),
        ],
      },
      {
        group: "RQA・Lyapunov・予測",
        panels: [
          definePanel({ id: "nl-rqa", title: "ローリングRQA", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/RollingRQAChart") }),
          definePanel({ id: "nl-local-lyap", title: "局所Lyapunov指数・位相空間密度", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/LocalLyapunovChart") }),
          definePanel({ id: "nl-lyap-spectrum", title: "リアプノフスペクトル・KY次元・ベクトル分解", input: "filtered+series", closeOnly: "safe", height: 600, load: () => import("../components/analysis/LyapunovSpectrumChart") }),
          definePanel({ id: "nl-simplex", title: "位相空間予測（Simplex / S-map）", input: "filtered+series", closeOnly: "safe", height: 500, load: () => import("../components/analysis/SimplexPredictionChart") }),
          definePanel({ id: "nl-recurrence", title: "Recurrence Plot & Lyapunov指数", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/RecurrencePlot") }),
        ],
      },
      {
        group: "ポテンシャル・TDA",
        panels: [
          definePanel({ id: "nl-km", title: "Kramers-Moyal係数 / ポテンシャル関数", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/KramersMoyalChart") }),
          definePanel({ id: "nl-potential", title: "ポテンシャル地形（Potential / Drift Landscape）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/PotentialLandscapeChart") }),
          definePanel({ id: "sa-nonlinear-tda", title: "位相的データ解析（TDA）/ Fisher-Rao距離", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/TDAChart") }),
          definePanel({ id: "nl-rolling-tda", title: "ローリングTDA", input: "filtered+series", closeOnly: "safe", height: 350, load: () => import("../components/analysis/RollingTDAChart") }),
        ],
      },
    ],
  },
  {
    key: "entropy",
    label: "予測しやすさを測る",
    method: "情報理論",
    description: "エントロピー拡張・複雑度・情報フロー・レジーム検出・予測可能性",
    render: "panels",
    groups: [
      {
        group: "エントロピー指標",
        panels: [
          definePanel({ id: "sa-entropy", title: "情報理論 / エントロピー", input: "filtered+series", closeOnly: "safe", height: 250, load: () => import("../components/analysis/EntropyDisplay") }),
          definePanel({ id: "ent-extended", title: "拡張エントロピー指標", input: "filtered+series", closeOnly: "safe", height: 300, load: () => import("../components/analysis/EntropyExtendedChart") }),
          definePanel({ id: "ent-conditional", title: "条件付きエントロピー / エントロピー率", input: "filtered+series", closeOnly: "caution", height: 300, load: () => import("../components/analysis/ConditionalEntropyChart") }),
          definePanel({ id: "ent-multiscale", title: "マルチスケール解析", input: "filtered+series", closeOnly: "caution", height: 250, load: () => import("../components/analysis/MultiscaleEntropyChart") }),
          definePanel({ id: "ent-heatmap", title: "エントロピーヒートマップ / パターン分布", input: "filtered+series", closeOnly: "safe", height: 500, load: () => import("../components/analysis/EntropyHeatmapChart") }),
          definePanel({ id: "ent-complexity", title: "複雑度-エントロピー平面", input: "filtered+series", closeOnly: "safe", height: 350, load: () => import("../components/analysis/ComplexityEntropyChart") }),
        ],
      },
      {
        group: "情報フロー・レジーム",
        panels: [
          definePanel({ id: "ent-storage", title: "情報蓄積 / 予測可能性", input: "filtered+series", closeOnly: "safe", height: 300, load: () => import("../components/analysis/InformationStorageChart") }),
          definePanel({ id: "ent-rolling-te", title: "ローリング移転エントロピー / 相互情報量", input: "filtered+series", closeOnly: "caution", height: 400, load: () => import("../components/analysis/RollingTransferEntropyChart") }),
          definePanel({ id: "ent-symbolic", title: "シンボル情報フロー / 情報分解", input: "filtered+series", closeOnly: "caution", height: 400, load: () => import("../components/analysis/SymbolicInfoFlowChart") }),
          definePanel({ id: "ent-regime", title: "エントロピーレジーム検出", input: "filtered+series", closeOnly: "safe", height: 350, load: () => import("../components/analysis/EntropyRegimeChart") }),
        ],
      },
    ],
  },
  {
    key: "fractal",
    label: "傾向の持続性を見る",
    method: "フラクタル",
    description: "DFA・Hurst指数・ローリングHurst+サロゲート帯・MF-DFA・R/S・DCCA・相関次元",
    render: "panels",
    groups: [
      {
        panels: [
          definePanel({ id: "sa-fractal", title: "フラクタル / スケーリング（DFA・Hurst）", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/DFAChart") }),
          definePanel({ id: "frac-rolling-hurst", title: "ローリングHurst指数 + サロゲート帯", input: "filtered+series", closeOnly: "safe", height: 240, load: () => import("../components/analysis/RollingHurstChart") }),
          definePanel({ id: "frac-ext", title: "フラクタル拡張解析（MF-DFA・R/S・DCCA ほか）", input: "filtered+series", closeOnly: "caution", height: 300, load: () => import("../components/analysis/FractalExtChart") }),
        ],
      },
    ],
  },
  {
    key: "network",
    label: "値動きのつながりを見る",
    method: "ネットワーク",
    description: "NVG・HVG・Ordinal・Recurrence Network",
    render: "panels",
    groups: [
      {
        panels: [
          definePanel({ id: "sa-network", title: "Visibility Graph（NVG）", input: "filtered+series", closeOnly: "safe", height: 300, load: () => import("../components/analysis/VisibilityGraphChart") }),
          definePanel({ id: "net-hvg", title: "Horizontal Visibility Graph（HVG）", input: "filtered+series", closeOnly: "safe", height: 250, load: () => import("../components/analysis/HVGChart") }),
          definePanel({ id: "net-ordinal", title: "Ordinal Pattern Transition Network", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/OrdinalNetwork") }),
          definePanel({ id: "net-recurrence", title: "Recurrence Network", input: "filtered+series", closeOnly: "safe", height: 300, load: () => import("../components/analysis/RecurrenceNetworkChart") }),
        ],
      },
    ],
  },
  {
    key: "conditional",
    label: "今の条件から先を読む",
    method: "条件付き分析",
    description: "状態→先行きリターン表（RSI/ボラ/トレンド別の条件付き期待値・有意性・年次持続性）",
    render: "panels",
    groups: [
      {
        group: "状態 → 先行きリターン",
        panels: [
          definePanel({ id: "cond-forward", title: "状態→先行きリターン表（RSI/ボラ/トレンド別）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/ConditionalForwardChart") }),
          definePanel({ id: "cond-segment-edge", title: "条件付きエッジ：日中 vs 夜間（状態別にどちらの執行が有利か）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/ConditionalSegmentEdgeChart") }),
          definePanel({ id: "cond-custom-bucket", title: "カスタム条件ビルダー（任意の指標・閾値・分位）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/CustomBucketChart") }),
          definePanel({ id: "cond-return-bin", title: "状態 × 先行きリターンビン 分布ヒートマップ", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/ReturnBinHeatmapChart") }),
          definePanel({ id: "cond-marker", title: "条件発生マーカー & 区間クロスフィルタ", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/ConditionMarkerChart") }),
        ],
      },
      {
        group: "順張り/逆張り・複合・持続性",
        panels: [
          definePanel({ id: "cond-trend-momentum", title: "トレンド・モメンタムの先行きリターン（順張りアノマリー検証）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/TrendMomentumChart") }),
          definePanel({ id: "cond-reversal", title: "短期リバーサル・エッジ（押し目買い/戻り売りの定量化）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/ShortTermReversalChart") }),
          definePanel({ id: "cond-2factor", title: "2変数コンディショニング・ヒートマップ（複合エッジ）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/TwoFactorHeatmapChart") }),
          definePanel({ id: "cond-state-pred", title: "状態別の予測可能性（方向的中率・情報係数IC）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/StatePredictabilityChart") }),
          definePanel({ id: "cond-persistence", title: "持続性・サンプル外検証（前半/後半の再現性）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/PersistenceChart") }),
        ],
      },
    ],
  },
  {
    key: "edge",
    label: "その優位性は本物か",
    method: "エッジ探索",
    description: "条件ペア交互作用スキャン・レジーム別エッジマップ・ウォークフォワード頑健性・シグナル合成・エッジ容量推定・減衰検知(SPRT/CUSUM)・前向き検証台帳・多重検定台帳",
    render: "panels",
    groups: [
      {
        group: "探索（エッジを見つける）",
        panels: [
          definePanel({ id: "edge-interaction", title: "条件ペア交互作用スキャナ", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/InteractionScanChart") }),
          definePanel({ id: "edge-regime-map", title: "レジーム別エッジマップ", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/RegimeEdgeMapChart") }),
          definePanel({ id: "edge-walkforward", title: "ウォークフォワード頑健性（DSR + PBO）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/WalkForwardChart") }),
          definePanel({ id: "edge-signal-stack", title: "シグナル合成", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/SignalStackingChart") }),
        ],
      },
      {
        group: "規律（信じてよいか・いくらまでか・まだ生きているか）",
        panels: [
          definePanel({ id: "edge-power", title: "検出力の壁（今の標本で証明できるか・必要なブレッドス）", input: "all", closeOnly: "safe", height: 350, load: () => import("../components/analysis/EdgePowerChart") }),
          definePanel({ id: "edge-capacity", title: "エッジ容量推定（このエッジは何円まで運用できるか）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/EdgeCapacityChart") }),
          definePanel({ id: "edge-book", title: "合成ブック（弱いエッジN本を束ねる・テール相関・容量の食い合い）", input: "all", closeOnly: "safe", height: 400, load: () => import("../components/analysis/EdgeBookChart") }),
          definePanel({ id: "edge-decay", title: "エッジ減衰・死亡検知（SPRT + CUSUM 逐次監視）", input: "all", closeOnly: "safe", height: 400, load: () => import("../components/analysis/EdgeDecayChart") }),
          definePanel({ id: "edge-ledger", title: "前向き検証台帳（凍結→未来のデータだけで採点）", input: "all+ticker", closeOnly: "safe", height: 400, load: () => import("../components/analysis/ProspectiveLedgerChart") }),
          definePanel({ id: "edge-test-registry", title: "グローバル多重検定台帳（アプリ全体の偽発見の床）", input: "none", closeOnly: "safe", height: 400, load: () => import("../components/analysis/TestRegistryChart") }),
        ],
      },
    ],
  },
  {
    key: "asof",
    label: "過去の判断を採点する",
    method: "as-of検証",
    description: "過去の時点に戻り、その時点で分かる情報だけで出した判断がその後に適切だったかを採点（スナップショット再現・型別スコアカード・アナログ経路リプレイ）",
    render: "panels",
    groups: [
      {
        group: "その時点の判断を再現する",
        panels: [
          definePanel({ id: "asof-snapshot", title: "as-of スナップショット（あの日の画面を再現して、その後と突き合わせる）", input: "all+ticker", closeOnly: "safe", height: 520, load: () => import("../components/analysis/AsOfSnapshotChart") }),
          definePanel({ id: "asof-analog", title: "as-of アナログ経路リプレイ（過去の各週末の予測を畳まずに並べる）", input: "all+ticker", closeOnly: "safe", height: 500, load: () => import("../components/analysis/AsOfAnalogReplayChart") }),
        ],
      },
      {
        group: "多数の時点でまとめて採点する",
        panels: [
          definePanel({ id: "asof-scorecard", title: "as-of スコアカード（方向PT検定／確率Brier・較正／区間被覆／ボラMZ回帰／IC）", input: "all+ticker", closeOnly: "safe", height: 600, load: () => import("../components/analysis/AsOfScorecardChart") }),
        ],
      },
    ],
  },
  {
    key: "regime",
    label: "今の相場環境を見極める",
    method: "レジーム分析",
    description: "市場状態ダッシュボード・3状態カルマン・スムーザー・HMM・変化点検出・ベイズ変化点検出",
    render: "panels",
    groups: [
      {
        panels: [
          definePanel({ id: "sa-regime", title: "市場状態ダッシュボード", input: "filtered+series", closeOnly: "safe", height: 500, load: () => import("../components/analysis/MarketStateDashboard") }),
          definePanel({ id: "regime-main", title: "レジーム分析（3状態カルマン・スムーザー・HMM）", input: "filtered+series", closeOnly: "safe", height: 500, load: () => import("../components/analysis/RegimeChart") }),
          definePanel({ id: "regime-technical", title: "レジーム別テクニカル指標有効性", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/RegimeTechnicalChart") }),
          definePanel({ id: "regime-distribution", title: "レジーム別分布特性", input: "filtered", closeOnly: "safe", height: 320, load: () => import("../components/analysis/RegimeDistributionChart") }),
          definePanel({ id: "regime-transition", title: "レジーム遷移分析", input: "filtered", closeOnly: "safe", height: 440, load: () => import("../components/analysis/RegimeTransitionChart") }),
          definePanel({ id: "sa-regime-break", title: "構造変化検定", input: "filtered+series", closeOnly: "safe", height: 350, load: () => import("../components/analysis/StructuralBreakChart") }),
          definePanel({ id: "regime-bocpd", title: "ベイズ変化点検出（BOCPD）", input: "filtered+series", closeOnly: "safe", height: 500, load: () => import("../components/analysis/BOCPDChart") }),
        ],
      },
    ],
  },
  {
    key: "causal",
    label: "何が値動きに先行するか",
    method: "因果・情報",
    description: "イベントスタディ・Transfer Entropy・Granger因果・相互情報量・CCM非線形因果",
    render: "panels",
    groups: [
      {
        panels: [
          definePanel({ id: "causal-event", title: "条件付きイベントスタディ（始点重ね描き）", input: "all", closeOnly: "safe", height: 400, load: () => import("../components/analysis/EventStudyChart") }),
          definePanel({ id: "sa-causal", title: "因果・情報伝達解析（Transfer Entropy・Granger）", input: "filtered+series", closeOnly: "caution", height: 300, load: () => import("../components/analysis/CausalChart") }),
          definePanel({ id: "causal-ccm", title: "CCM非線形因果分析", input: "filtered+series", closeOnly: "caution", height: 400, load: () => import("../components/analysis/CCMChart") }),
        ],
      },
    ],
  },
  {
    key: "tailrisk",
    label: "どれだけ下がりうるか",
    method: "テイルリスク",
    description: "極値統計・高次キュムラント・テイル依存性・Copula分析",
    render: "panels",
    groups: [
      {
        panels: [
          definePanel({ id: "tail-main", title: "テイルリスク解析（極値統計・高次キュムラント）", input: "filtered+series", closeOnly: "caution", height: 400, load: () => import("../components/analysis/TailRiskChart") }),
          definePanel({ id: "tail-copula", title: "コピュラ分析", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/CopulaChart") }),
          definePanel({ id: "tail-hill", title: "Hillテール指数推定", input: "filtered", closeOnly: "safe", height: 350, load: () => import("../components/analysis/HillEstimatorChart") }),
        ],
      },
    ],
  },
  {
    key: "calendar",
    label: "いつ買って、いつ降りるか",
    method: "カレンダー",
    description: "曜日/月別アノマリー・ヒートマップ・ローソク足の季節性・高値/安値の時間帯分布(日中足)",
    render: "panels",
    groups: [
      {
        group: "曜日・カレンダー（日足）",
        panels: [
          definePanel({ id: "cal-weekday-edge", title: "曜日タイミング好機スキャン", input: "filtered", closeOnly: "caution", height: 350, load: () => import("../components/analysis/WeekdayEdgeScanChart") }),
          definePanel({ id: "cal-weekday-sim", title: "曜日トレード・シミュレータ", input: "filtered", closeOnly: "caution", height: 350, load: () => import("../components/analysis/WeekdayTradeSimulator") }),
          definePanel({ id: "cal-null-calib", title: "ヌル較正：曜日最適化の「偽発見の床」（採用前の門番）", input: "filtered", closeOnly: "safe", height: 350, load: () => import("../components/analysis/NullCalibrationChart") }),
          definePanel({ id: "cal-null-anatomy", title: "曜日構造の解剖：どこに・どんな構造か（maxT／F分解／頑健性／層別／分散・週末ギャップ込み）", input: "filtered", closeOnly: "caution", height: 350, load: () => import("../components/analysis/NullAnatomyChart") }),
          definePanel({ id: "cal-weekday-us-interaction", title: "曜日 × 前夜米国：交互作用の解剖（曜日別スピルオーバーβ・上下非対称・セルmaxT）", input: "filtered", closeOnly: "caution", height: 350, load: () => import("../components/analysis/WeekdayUsInteractionChart") }),
          definePanel({ id: "cal-timing-value", title: "タイミング判断の価値検定（SPA：カレンダー戦略一族 vs B&H・スヌーピング補正）", input: "all", closeOnly: "caution", height: 350, load: () => import("../components/analysis/TimingValueChart") }),
          definePanel({ id: "cal-weekday-vs-bh", title: "月→金戦略 vs バイ&ホールド 統計的優位性検定", input: "filtered", closeOnly: "caution", height: 350, load: () => import("../components/analysis/WeekdayVsBuyHoldChart") }),
          definePanel({ id: "cal-weekend-premium", title: "週末プレミアム μ_w：週末保有の有無によるリターン差（区間分解）", input: "filtered", closeOnly: "unavailable", height: 350, load: () => import("../components/analysis/WeekendPremiumChart") }),
          definePanel({ id: "cal-optimal-exit", title: "状態依存の最適手仕舞い（月曜Open建玉→いつ降りるか・後退帰納法）", input: "filtered", closeOnly: "caution", height: 350, load: () => import("../components/analysis/OptimalExitChart") }),
          definePanel({ id: "cal-weekday-barrier", title: "曜日別 TP/SL：バリアで何が測れて何が測れないか（系C28・σ正規化／逸脱／ヌル較正）", input: "all+ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/WeekdayBarrierChart") }),
          definePanel({ id: "cal-nisa-vs-taxable", title: "NISA(非課税・持ち切り) vs 現物(課税・曜日戦略) 税引後・レバレッジ比較", input: "all", closeOnly: "caution", height: 350, load: () => import("../components/analysis/NisaVsTaxableChart") }),
          definePanel({ id: "cal-spiral", title: "カレンダー螺旋ヒートマップ", input: "filtered+period", closeOnly: "safe", height: 350, load: () => import("../components/analysis/SpiralHeatmap") }),
          definePanel({ id: "cal-candle-season", title: "ローソク足の季節性（足の中身×カレンダー）", input: "filtered", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/CandleSeasonalityChart") }),
          definePanel({ id: "cal-weekclock", title: "週内クロック（月曜始値基準の累積OHLC）", input: "filtered+ticker", closeOnly: "caution", height: 400, load: () => import("../components/analysis/WeekClockChart") }),
          definePanel({ id: "cal-event-effect", title: "カレンダー・イベント効果（月末/SQ/連休/季節の先行きリターン）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/CalendarEffectChart") }),
          definePanel({ id: "cal-event-calendar", title: "イベントカレンダー条件付け（FOMC/CPI/雇用統計/日銀/SQ の先行きリターン）", input: "filtered", closeOnly: "safe", height: 350, load: () => import("../components/analysis/EventCalendarChart") }),
          definePanel({ id: "cal-session-gap", title: "休場コンテキスト別 曜日値動き（連休・祝日の歪み検出）", input: "filtered", closeOnly: "caution", height: 400, load: () => import("../components/analysis/SessionGapChart") }),
          definePanel({ id: "cal-today-bin", title: "今日の値動きが該当するリターンビン：同条件の過去分布（曜日非依存）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/TodayBinChart") }),
          definePanel({ id: "cal-weekly-analog", title: "今週の軌跡アナログ比較（似た形／前夜米国ビンで絞って先読み）", input: "all+ticker", closeOnly: "caution", height: 400, load: () => import("../components/analysis/WeeklyAnalogChart") }),
          definePanel({ id: "cal-weekly-analog-oos", title: "今週の軌跡アナログ 予測力OOS検証（IC・方向的中率・多重比較補正）", input: "all", closeOnly: "safe", height: 400, load: () => import("../components/analysis/WeeklyAnalogOosChart") }),
          definePanel({ id: "cal-week-embed", title: "週内Embedding（週の関数PCA・固有週アトラス／形→翌週リターンの予測力を大域検定）", input: "all", closeOnly: "safe", height: 400, load: () => import("../components/analysis/WeekEmbeddingChart") }),
          definePanel({ id: "cal-weekday-cond", title: "曜日 × 値動きビン 条件付き分析（インタラクティブ）", input: "filtered", closeOnly: "caution", height: 400, load: () => import("../components/analysis/WeekdayConditionalChart") }),
          definePanel({ id: "cal-monday-gap", title: "月曜ギャップ解剖（週初めの「下げて始まる」を層別）", input: "all", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/MondayGapChart") }),
          definePanel({ id: "cal-us-bin-event", title: "曜日 × 前夜米国ビン のイベントスタディ（−5日〜+5日の日足経路・効果は持続するか巻き戻るか）", input: "all", closeOnly: "safe", height: 400, load: () => import("../components/analysis/UsBinEventStudyChart") }),
        ],
      },
      {
        group: "曜日×日内 累積パス・エッジ（日中足）",
        panels: [
          definePanel({ id: "cal-weekday-intra-path", title: "曜日 × 当日日内 平均累積パス", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/WeekdayIntradayPathChart") }),
          definePanel({ id: "cal-tom-path", title: "月内位置（月初/中旬/月末）× 当日日内 平均累積パス", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/TurnOfMonthPathChart") }),
          definePanel({ id: "cal-weekday-us-path", title: "曜日 × 前夜米国ビン 交互作用：日内平均累積パス", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/WeekdayUsPathChart") }),
          definePanel({ id: "cal-today-vs-expected", title: "当日の実測 vs 条件付き期待パス（台本どおりか／乖離は続くか）", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/TodayVsExpectedPathChart") }),
          definePanel({ id: "cal-intraday-analog", title: "寄り前情報アナログ（似た経路をたどった過去日の日内パスを重ねる／OOS検証つき）", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/IntradayAnalogPathChart") }),
          definePanel({ id: "cal-us-jp-linked", title: "前夜米国の日中経路 → 当日日本の連続パス（終値1点でなく“形”で条件付け）", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/UsJpLinkedPathChart") }),
          definePanel({ id: "cal-regime-us-path", title: "相場基調 × 前夜米国 交互作用：日内平均累積パス", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/RegimeUsPathChart") }),
          definePanel({ id: "cal-weekday-intra-edge", title: "曜日 × 日内タイミング エッジスキャン", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/WeekdayIntradayEdgeChart") }),
          definePanel({ id: "cal-sector-basket", title: "業種バスケット 曜日×日内（標本プール）", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/SectorBasketWeekdayChart") }),
        ],
      },
      {
        group: "日中プロファイル・約定タイミング（日中足）",
        panels: [
          definePanel({ id: "cal-highlow-timing", title: "高値・安値の時間帯分析", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/HighLowTimingChart") }),
          definePanel({ id: "cal-exec-timing", title: "寄り/引け 近傍 約定タイミング最適化", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/ExecutionTimingChart") }),
          definePanel({ id: "cal-edge-discount", title: "エッジ割引（公式マーク vs 約定可能価格）", input: "all+ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/EdgeDiscountChart") }),
          definePanel({ id: "cal-sliced-exec", title: "TWAP/VWAP 分割約定の効果", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/SlicedExecutionChart") }),
          definePanel({ id: "cal-intra-window", title: "任意時刻ウィンドウ × 曜日 クロス集計", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/IntradayWindowChart") }),
          definePanel({ id: "cal-intra-profile", title: "時間帯プロファイル（いつ動くか）", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/IntradayProfileChart") }),
          definePanel({ id: "cal-vwap-dev", title: "VWAP乖離分析（回帰か継続か）", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/VwapDeviationChart") }),
          definePanel({ id: "cal-intra-regime", title: "当日内の状態（どういう日か）", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/IntradayRegimeChart") }),
          definePanel({ id: "cal-intra-excursion", title: "当日内 MFE/MAE と TP/SL最適化", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/IntradayExcursionChart") }),
          definePanel({ id: "cal-realized-vol", title: "マイクロ構造の代理（実現ボラ・夜間/日中・出来高クロック）", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/RealizedVolChart") }),
          definePanel({ id: "cal-gap-intra", title: "ギャップ後の日中挙動（窓埋め vs gap-and-go）", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/GapIntradayChart") }),
          definePanel({ id: "cal-signal-intra", title: "日足シグナル翌日の日中エントリー最適化", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/SignalIntradayChart") }),
          definePanel({ id: "cal-signal-exec", title: "日足シグナル × 最適約定時刻", input: "all+ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/SignalExecutionChart") }),
        ],
      },
      {
        group: "前夜米国 → 当日日中 スピルオーバー",
        panels: [
          definePanel({ id: "cal-us-driver", title: "支配ドライバ指数の特定 と 乖離日分析", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/UsDriverChart") }),
          definePanel({ id: "cal-us-beta", title: "前夜米国 → 当日スピルオーバーβ（ギャップ織り込み分解）", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/UsBetaChart") }),
          definePanel({ id: "cal-us-path", title: "前夜米国ビン × 当日日内 平均累積パス", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/UsPathChart") }),
          definePanel({ id: "cal-us-absorption", title: "前夜米国の織り込み速度と日中の反転確率", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/UsAbsorptionChart") }),
          definePanel({ id: "cal-us-leadlag", title: "前夜米国 → 日中相関の減衰（米国の記憶は何時まで効くか）", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/UsLeadLagChart") }),
          definePanel({ id: "cal-us-vol", title: "ボラティリティ・スピルオーバー（米国の荒れ → 当日の荒れ）", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/UsVolSpilloverChart") }),
          definePanel({ id: "cal-us-timing", title: "米国方向別 最適エントリー/エグジット時刻スキャン", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/UsTimingEdgeChart") }),
        ],
      },
      {
        group: "消化時間エッジ（保有期間・消化境界・イベント時間）",
        panels: [
          definePanel({ id: "cal-us-holding", title: "米国方向別 保有期間の最適化（IR×Δ / MFE・MAE）", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/UsHoldingPeriodChart") }),
          definePanel({ id: "cal-us-digestion", title: "消化完了点(τ)とレジーム反転・反転ハザード", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/UsDigestionBoundaryChart") }),
          definePanel({ id: "cal-us-eventtime", title: "消化イベント時間分析（進捗率軸のエッジ / 消化速度層別）", input: "ticker", closeOnly: "unavailable", height: 400, load: () => import("../components/analysis/UsEventTimeChart") }),
        ],
      },
    ],
  },
  {
    key: "simulation",
    label: "将来シナリオを試す",
    method: "シミュレーション",
    description: "カスタム売買・GBDT予測・株価予測(モンテカルロ)・バックテスト・分数BM・VG過程・最適停止",
    render: "panels",
    groups: [
      {
        group: "売買シミュレーション・予測",
        panels: [
          definePanel({ id: "sim-holding-ledger", title: "持ち方の対数台帳（持ち切り vs 回転）", input: "all", closeOnly: "caution", height: 400, load: () => import("../components/analysis/HoldingLedgerChart") }),
          definePanel({ id: "sim-custom-return", title: "カスタム売買タイミング累積リターン", input: "all+ticker", closeOnly: "safe", height: 300, load: () => import("../components/analysis/CustomReturnChart") }),
          definePanel({ id: "sim-analog", title: "ヒストリカル・アナログ（類似局面検索）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/HistoricalAnalogChart") }),
          definePanel({ id: "sim-regime-cluster", title: "特徴量クラスタリングによるレジーム分類（k-means）", input: "filtered", closeOnly: "caution", height: 400, load: () => import("../components/analysis/RegimeClusteringChart") }),
          definePanel({ id: "sim-multivar-simplex", title: "多変量埋め込みでの近傍予測（multivariate simplex）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/MultivarSimplexChart") }),
          definePanel({ id: "sim-forecast", title: "株価予測シミュレーター（モンテカルロ）", input: "filtered", closeOnly: "safe", height: 450, load: () => import("../components/analysis/PriceForecastChart") }),
          definePanel({ id: "sim-backtest", title: "シンプルバックテスト", input: "filtered", closeOnly: "safe", height: 350, load: () => import("../components/analysis/SimpleBacktestChart") }),
          definePanel({ id: "sim-vol-target", title: "ボラティリティ・ターゲティング（信用レバ可変） vs バイ&ホールド 統計検定", input: "all", closeOnly: "safe", height: 400, load: () => import("../components/analysis/VolTargetingChart") }),
        ],
      },
      {
        group: "時系列モデル",
        panels: [
          definePanel({ id: "sa-sim-meanrev", title: "平均回帰（Ornstein-Uhlenbeck）", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/MeanReversionChart") }),
          definePanel({ id: "sa-sim-arima", title: "SARIMA モデル（予測・診断）", input: "filtered+series", closeOnly: "safe", height: 400, load: () => import("../components/analysis/ArimaChart") }),
        ],
      },
      {
        group: "資金管理・頑健性",
        panels: [
          definePanel({ id: "sim-kelly", title: "ケリー基準の最適建玉 f*：複利の壁 σ²/2 と μ の誤差棒", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/KellyChart") }),
          definePanel({ id: "sim-stop-compare", title: "ストップ方式の比較（固定%/ATR/シャンデリア/トレーリング）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/StopComparisonChart") }),
          definePanel({ id: "sim-rmultiple", title: "トレード期待値・R倍数分布", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/RMultipleChart") }),
          definePanel({ id: "sim-block-boot", title: "ブロック・ブートストラップでの頑健性", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/BlockBootstrapChart") }),
        ],
      },
      {
        group: "確率過程モデル",
        panels: [
          definePanel({ id: "sim-jump", title: "Merton ジャンプ拡散モデル", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/JumpDiffusionChart") }),
          definePanel({ id: "sim-optstop", title: "最適停止問題：閾値の理論解", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/OptimalStoppingChart") }),
          definePanel({ id: "sim-vg", title: "Variance Gamma 過程", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/VarianceGammaChart") }),
          definePanel({ id: "sim-fbm", title: "分数ブラウン運動（fBM）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/FBMChart") }),
        ],
      },
    ],
  },
  {
    key: "discretionary",
    label: "自分の売買を検証する",
    method: "裁量トレード",
    description: "クリックで任意タイミング売買・Buy&Hold比較・裁量基準の逆算・期間適用バックテスト(シナリオ保存可)",
    // クリックで任意タイミング売買・シナリオ保存を一体で扱う常時表示
    // ワークスペース。単一の折りたたみ分析ではないのでパネルIDを持たない（FU27）。
    render: "workspace",
    groups: [],
    Workspace: DiscretionaryLab,
  },
  {
    key: "quantum",
    label: "値動きの癖を見る（上級）",
    method: "量子力学的",
    description: "プロパゲータ・経路積分・DMD・デコヒーレンス・市場時間・密度行列",
    render: "panels",
    groups: [
      {
        panels: [
          definePanel({ id: "quantum-propagator", title: "価格伝播関数（プロパゲータ）", input: "filtered", closeOnly: "safe", height: 400, load: () => import("../components/analysis/PropagatorChart") }),
          definePanel({ id: "quantum-pathintegral", title: "経路積分シミュレーション", input: "filtered", closeOnly: "safe", height: 420, load: () => import("../components/analysis/PathIntegralChart") }),
          definePanel({ id: "quantum-dmd", title: "動的モード分解（DMD）", input: "filtered+series", closeOnly: "safe", height: 350, load: () => import("../components/analysis/DMDChart") }),
          definePanel({ id: "quantum-decoherence", title: "デコヒーレンス分析", input: "filtered", closeOnly: "safe", height: 500, load: () => import("../components/analysis/DecoherenceChart") }),
          definePanel({ id: "quantum-markettime", title: "市場時間の再定義", input: "filtered", closeOnly: "caution", height: 400, load: () => import("../components/analysis/MarketTimeChart") }),
          definePanel({ id: "quantum-density", title: "密度行列分析", input: "filtered", closeOnly: "safe", height: 500, load: () => import("../components/analysis/DensityMatrixChart") }),
        ],
      },
    ],
  },
];

/**
 * `AccordionSection` の外に置かれるが、共有URL `?panel=` と localStorage の対象である
 * パネル。描画は `page.tsx` が行う——配置（サマリーの前か後か）と既定の開閉が、
 * その銘柄で破損が見つかったかどうかで決まるため、アコーディオンの項目にできない。
 * ここに登録しておかないと `sectionForPanel("data-quality")` が引けず、
 * 共有URL `?panel=data-quality` が**無言で何も開かない**（FU25 と同じ壊れ方）。
 */
export interface StandalonePanelDef {
  id: string;
  section: SectionKey;
  title: string;
  subtitle: string;
}

export const STANDALONE_PANELS: StandalonePanelDef[] = [
  {
    id: "data-quality",
    section: "basic",
    title: "価格データの破損点検",
    subtitle:
      "配信元のスケール破損を検出・修復した記録。修復した日の配信値と修復値・年率σの膨張・修復前後を重ねたチャート・ベンチマーク指数の点検",
  },
];

// ---------------------------------------------------------------------------
// 以下はすべて上の SECTIONS からの**導出**である。手で書いた台帳を置かないこと。
// 導出になっている限り「台帳の更新を忘れる」という壊れ方は起こりえない。
// ---------------------------------------------------------------------------

export interface RegisteredPanel extends PanelEntry {
  section: SectionKey;
  group?: string;
}

/** 全パネルを SECTIONS の並び順のまま平らにしたもの。 */
export const PANELS: RegisteredPanel[] = SECTIONS.flatMap((s) =>
  s.groups.flatMap((g) => g.panels.map((p) => ({ ...p, section: s.key, group: g.group }))),
);

export const PANEL_IDS: string[] = PANELS.map((p) => p.id);

const SECTION_OF_PANEL = new Map<string, SectionKey>([
  ...PANELS.map((p) => [p.id, p.section] as const),
  ...STANDALONE_PANELS.map((p) => [p.id, p.section] as const),
]);

/**
 * パネルIDから所属セクションキーを返す。登録が無ければ `null`。
 *
 * 共有URLは `?sec=` と `?panel=` を独立に持つ。パネルIDから節を引けないと、
 * 両者が食い違うURLで `page.tsx` は 60フレーム DOM を探して**無言で諦める**
 * （そのパネルはその節に存在しないので何フレーム待っても現れない）。
 * 節をまたぐ `openAnalysisPanel()` も同じ理由で黙って何も起きない。
 *
 * `/portfolio` のパネル（`pf-*`）は別ページなので対象外＝`null` を返す。
 * 呼び出し側は `null` を「節を特定できないので現在の節のまま探す」として扱うこと。
 */
export function sectionForPanel(panelId: string): SectionKey | null {
  if (!panelId) return null;
  return SECTION_OF_PANEL.get(panelId) ?? null;
}

/**
 * 入力系列（`seriesMode`）を実際に消費するパネルを1つ以上持つセクション。
 * これ以外の節ではチャートが OHLC ベースで系列変換が効かないため、
 * `SeriesModeSelector` を無効にする（U3: 使えないコントロールを出さない）。
 *
 * 移設前は手で宣言していて実態とずれうる台帳だったが、いまは各パネルの `input`
 * からの導出である。**節の中の何件が実際に反応するかはパネルごとに異なる**
 * （例: distribution は 16件中12件、simulation は 17件中2件）→ FU24。
 */
export const SERIES_AWARE_SECTIONS: ReadonlySet<SectionKey> = new Set(
  PANELS.filter((p) => consumesSeriesMode(p.input)).map((p) => p.section),
);

/** 節の中で `seriesMode` に反応するパネルの件数 ÷ 総数（FU24 の実測用）。 */
export function seriesAwarePanelCount(section: SectionKey): { aware: number; total: number } {
  const inSection = PANELS.filter((p) => p.section === section);
  return { aware: inSection.filter((p) => consumesSeriesMode(p.input)).length, total: inSection.length };
}

function idsWithCloseOnly(kind: CloseOnlyRequirement): ReadonlySet<string> {
  return new Set(PANELS.filter((p) => p.closeOnly === kind).map((p) => p.id));
}

/** 出来高・OHLC内訳・日中/夜間そのものが対象で、終値だけでは結果が意味を持たないパネル。 */
export const CLOSE_ONLY_UNAVAILABLE_PANEL_IDS = idsWithCloseOnly("unavailable");
/** 終値ベースの結果は有効だが、同じパネル内に解釈不能なサブ分析を含むパネル。 */
export const CLOSE_ONLY_CAUTION_PANEL_IDS = idsWithCloseOnly("caution");
/** 終値だけで結果が成立するパネル。**個別に検証した集合ではない**（冒頭の注記）。 */
export const CLOSE_ONLY_SAFE_PANEL_IDS = idsWithCloseOnly("safe");

/** パネルIDを3分類のいずれかに解決する。登録の無いIDは `null`。 */
export function classifyPanelForCloseOnly(panelId: string): CloseOnlyRequirement | null {
  return PANELS.find((p) => p.id === panelId)?.closeOnly ?? null;
}

export function sectionByKey(key: SectionKey): SectionDef | undefined {
  return SECTIONS.find((s) => s.key === key);
}
