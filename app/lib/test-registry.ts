// グローバル多重検定台帳: このアプリ全体で「何回検定したか」を数え上げる。
//
// 各分析は自分の内部ではBenjamini-Hochberg(FDR)補正を行うが、補正の母数はその分析の中だけ。
// アプリ全体では数十の分析×数十〜数百の検定が走っており、「どこかの分析で光った何か」を
// 拾い歩くと、家族(母数)はアプリ全体になる。この台帳はその全体母数Mを概算し、
//   ・全エッジがゼロでも期待される偽発見数 M·α (期待値は相関に依存しない)
//   ・少なくとも1つ「有意」が出る確率 1−(1−α)^M_eff
//   ・全体を守るための per-test 閾値 α/M (Bonferroni)
// を常設表示する。ヌル較正(null-calibration.ts)の「偽発見の床」のアプリ全体版。
//
// 検定数は既定パラメータでの概算(オーダーの目安)。分析を追加したらここにも行を足すこと。

export interface TestInventoryItem {
  section: string; // 画面上のセクション名
  analysisId: string; // AccordionSection の id
  label: string;
  count: number; // 既定パラメータでの概算検定数
  basis: string; // 数え方の根拠
  fdrLocal: boolean; // その分析内でFDR/順列などの局所補正があるか
}

export const TEST_INVENTORY: TestInventoryItem[] = [
  { section: "カレンダー", analysisId: "cal-weekday-edge", label: "曜日タイミング好機スキャン", count: 90, basis: "建玉スロット10×手仕舞いスロット10の有効組合せ", fdrLocal: true },
  { section: "カレンダー", analysisId: "cal-weekday-intraday-edge", label: "曜日×日内タイミング総当たり", count: 105, basis: "5曜日×日内窓(60分格子の順序対≈21)", fdrLocal: true },
  { section: "カレンダー", analysisId: "cal-weekday-us", label: "曜日×前夜米国 交互作用系", count: 45, basis: "5曜日×米国3ビン×約3指標", fdrLocal: true },
  { section: "カレンダー", analysisId: "cal-monday-gap", label: "月曜ギャップの解剖(層別)", count: 60, basis: "4目的変数×条件層×交互作用セル", fdrLocal: true },
  { section: "カレンダー", analysisId: "cal-session-gap", label: "休場コンテキスト別曜日分析", count: 40, basis: "4文脈×5曜日×2指標", fdrLocal: true },
  { section: "カレンダー", analysisId: "cal-event-calendar", label: "イベントカレンダー条件付け", count: 30, basis: "イベント種×前後窓", fdrLocal: true },
  { section: "カレンダー", analysisId: "cal-weekly-analog-oos", label: "週次アナログOOS検証", count: 50, basis: "手法×窓パラメータの検証格子", fdrLocal: true },
  { section: "カレンダー", analysisId: "cal-path-drift", label: "日内パス経時ドリフト(時代分割)", count: 80, basis: "層×日内ビンのWelch検定", fdrLocal: true },
  { section: "データ変換", analysisId: "transform-open-close", label: "売買時刻スキャン(寄/引×保有日数)", count: 25, basis: "6系統×保有日数グリッド", fdrLocal: true },
  { section: "エッジ探索", analysisId: "edge-interaction", label: "条件ペア交互作用スキャナ", count: 250, basis: "条件軸ペア×分位セル", fdrLocal: true },
  { section: "エッジ探索", analysisId: "edge-walkforward", label: "ウォークフォワード(IS選抜試行)", count: 20, basis: "シグナルカタログの選抜候補数(DSRで補正)", fdrLocal: true },
  { section: "ポートフォリオ", analysisId: "pf-weekday-cross-section", label: "クロスセクション曜日プール", count: 50, basis: "銘柄約10×5曜日", fdrLocal: true },
  { section: "ポートフォリオ", analysisId: "pf-weekday-us-cross", label: "曜日×前夜米国ビン横断", count: 150, basis: "銘柄約10×5曜日×3ビン", fdrLocal: true },
  { section: "カレンダー", analysisId: "cal-sector-basket", label: "業種バスケット曜日×日内", count: 100, basis: "業種×曜日×日内窓", fdrLocal: true },
];

export interface RegistrySummary {
  totalTests: number;
  nAnalyses: number;
  alpha: number;
  effDivisor: number; // 相関による実効独立数の割引(=M/effDivisorを独立とみなす)
  expectedFalse: number; // M·α(期待値は相関に依存しない)
  probAtLeastOne: number; // 1−(1−α)^(M/effDivisor)
  bonferroniAlpha: number; // 0.05全体制御のためのper-test閾値
  sidakAlpha: number;
}

export function registrySummary(alpha: number, effDivisor: number): RegistrySummary {
  const M = TEST_INVENTORY.reduce((s, x) => s + x.count, 0);
  const mEff = Math.max(1, M / effDivisor);
  return {
    totalTests: M,
    nAnalyses: TEST_INVENTORY.length,
    alpha,
    effDivisor,
    expectedFalse: M * alpha,
    probAtLeastOne: 1 - Math.pow(1 - alpha, mEff),
    bonferroniAlpha: 0.05 / M,
    sidakAlpha: 1 - Math.pow(0.95, 1 / M),
  };
}
