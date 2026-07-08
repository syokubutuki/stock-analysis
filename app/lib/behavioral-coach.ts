// 投資家バイアス・コーチ
// 「市場側の統計」ではなく「投資家側の癖・習性」を扱う知見レイヤー。
//   ① 主要バイアスのナレッジカタログ（症状→原因→対策）
//   ② 現在の分析結果に連動した「あなたへの警告」（文脈連動シグナル）
//   ③ 売買前の行動チェックリスト（事前コミットメント）
//
// ①③は静的知見、②は既存の BehavioralResult + 価格系列から算出（追加計算は軽量）。

import { PricePoint } from "./types";
import { BehavioralResult } from "./behavioral";

export type Severity = "high" | "medium" | "info";

// --- ① ナレッジカタログ ---
export interface BiasCard {
  id: string;
  name: string;   // 日本語名
  en: string;     // 英語名
  category: "信念・判断" | "選好・行動" | "社会的";
  symptom: string;        // あるある症状
  cause: string;          // なぜ起きるか
  countermeasure: string; // 対策ルール
}

// --- ② 文脈連動シグナル ---
export interface ContextSignal {
  biasId: string;
  title: string;
  severity: Severity;
  situation: string; // いまの局面
  trap: string;      // 陥りやすい罠
  action: string;    // 具体的な対策
}

export interface CoachMetrics {
  ratio52w: number;   // 52週高値比率
  drawdown: number;   // 直近ピークからの下落率（0〜1）
  ret20: number;      // 直近20営業日リターン
  ret60: number;      // 直近60営業日リターン
  momentumStrong: boolean;
  reversal: boolean;
  enoughData: boolean;
}

export interface CoachResult {
  metrics: CoachMetrics;
  signals: ContextSignal[];
}

// --- ③ チェックリスト ---
export interface ChecklistItem {
  id: string;
  text: string;
  biasId: string;
}

// ===================================================================
// ① 主要バイアスのカタログ（広くカバー）
// ===================================================================
export const BIAS_CARDS: BiasCard[] = [
  {
    id: "disposition",
    name: "ディスポジション効果",
    en: "Disposition Effect",
    category: "選好・行動",
    symptom: "含み益はすぐ利確し、含み損は『いつか戻る』と持ち続けて塩漬けにする。",
    cause: "損失回避（損の痛みは同額の利益の約2.25倍）と、参照点＝買値。損失側ではリスク志向になり損切りを先送りする。",
    countermeasure: "エントリー時に損切り・利確ラインを事前に確定し、価格が来たら感情を挟まず機械的に執行する。",
  },
  {
    id: "anchoring",
    name: "アンカリング",
    en: "Anchoring",
    category: "信念・判断",
    symptom: "買値や52週高値など『最初に見た数値』に判断が引きずられる。『買値まで戻ったら売る』。",
    cause: "人は不確実な量を見積もる際、最初に提示された数値を起点に微調整するだけで、十分に離れられない。",
    countermeasure: "『今この株を持っていなかったら、この価格で買うか？』と問い直し、買値ではなく現在価値で判断する。",
  },
  {
    id: "loss-aversion",
    name: "損失回避",
    en: "Loss Aversion",
    category: "選好・行動",
    symptom: "少しの含み益で怖くなって利確、損失は認めたくなくて放置。トータルで損小利小になる。",
    cause: "プロスペクト理論の価値関数。損失の心理的インパクトは利益の約2.25倍で、損失側の傾きが急。",
    countermeasure: "1トレードではなくポートフォリオ全体・年単位の損益で評価し、個別の損失に過剰反応しない。",
  },
  {
    id: "overconfidence",
    name: "自信過剰",
    en: "Overconfidence",
    category: "信念・判断",
    symptom: "『自分の予測は当たる』と感じ、根拠が薄いまま大きく張る。的中は実力、外れは運のせいにする。",
    cause: "自己奉仕バイアスと後知恵バイアス。成功体験ほど記憶に残り、予測精度を過大評価する。",
    countermeasure: "売買前に『外れたシナリオ』も書き出し、ポジションサイズは自信ではなくリスク許容度で決める。",
  },
  {
    id: "overtrading",
    name: "過剰取引",
    en: "Overtrading",
    category: "選好・行動",
    symptom: "退屈・焦り・取り返したい気持ちから売買回数が増え、手数料と税で成績が削られる。",
    cause: "自信過剰＋行動バイアス（『何かしていないと落ち着かない』）。Barber-Odeanは頻繁売買がリターンを毀損すると実証。",
    countermeasure: "売買ルールを事前に決め、条件を満たさない日は何もしない。取引ログで回転率とコストを可視化する。",
  },
  {
    id: "herding",
    name: "ハーディング（群集心理）",
    en: "Herding",
    category: "社会的",
    symptom: "SNSや話題性で『みんなが買っているから』と飛び乗り、高値掴み・狼狽売りをする。",
    cause: "情報カスケード（他人の行動を情報とみなす）と社会的証明。特に不確実性が高い局面で強まる。",
    countermeasure: "『自分の分析に基づくか、他人に追随しているだけか』を自問。逆張りの根拠を持てないなら見送る。",
  },
  {
    id: "mental-accounting",
    name: "メンタルアカウンティング",
    en: "Mental Accounting",
    category: "選好・行動",
    symptom: "『これは配当だから使ってよい』『これは儲けた金だから博打してよい（ハウスマネー効果）』と資金を色分け。",
    cause: "お金を出所や用途ごとに心の別勘定で管理し、本来は代替可能な資金を非合理に扱う。",
    countermeasure: "全資産を一つの口座として見る。利益で得た資金も自己資金と同じ規律で運用する。",
  },
  {
    id: "confirmation",
    name: "確証バイアス",
    en: "Confirmation Bias",
    category: "信念・判断",
    symptom: "自分の保有ポジションを支持する情報ばかり集め、反対材料を無視・軽視する。",
    cause: "認知的不協和の回避。自分が正しいと感じたいため、反証を探すコストを避ける。",
    countermeasure: "『自分と反対の立場の人が最も強く主張する根拠』を意図的に調べ、反証リストを作る。",
  },
  {
    id: "representativeness",
    name: "代表性ヒューリスティック",
    en: "Representativeness",
    category: "信念・判断",
    symptom: "『良い会社＝良い株』『最近上がった＝これからも上がる』と、少ない情報でパターン化する。",
    cause: "典型例への当てはめで確率判断を代用し、基準率（ベースレート）を軽視する。",
    countermeasure: "『人気・成長期待はすでに株価に織り込まれていないか（割高か）』をバリュエーションで確認する。",
  },
  {
    id: "sunk-cost",
    name: "サンクコスト効果",
    en: "Sunk Cost Fallacy",
    category: "選好・行動",
    symptom: "『ここまで下がったのに売れない』『買い増しで平均取得単価を下げれば…』とナンピンを重ねる。",
    cause: "既に払ったコストを取り戻したい心理。過去の損失を将来判断に持ち込んでしまう。",
    countermeasure: "投資判断は常に『今この資金を新規に配分するか』で考える。過去の取得価格は無視する。",
  },
  {
    id: "recency",
    name: "リセンシーバイアス",
    en: "Recency Bias",
    category: "信念・判断",
    symptom: "直近の値動きを将来に過度に投影する。急騰後は強気、急落後は総悲観になる。",
    cause: "最近の記憶ほど想起しやすく（利用可能性ヒューリスティック）、判断に過大な重みを与える。",
    countermeasure: "長期のヒストリカルな分布・平均回帰を確認し、直近数日の値動きに引っ張られない。",
  },
  {
    id: "status-quo",
    name: "現状維持・保有効果",
    en: "Status Quo / Endowment",
    category: "選好・行動",
    symptom: "一度持った銘柄を過大評価し、乗り換え・利確・損切りといった変更を先送りする。",
    cause: "変更に伴う後悔を恐れる（後悔回避）。保有しているだけで価値を高く感じる。",
    countermeasure: "定期リバランス日を決め、その日は『ゼロから組むなら同じ配分にするか』を全銘柄で問い直す。",
  },
];

// ===================================================================
// ② 現在局面に連動したシグナル生成
// ===================================================================
export function generateCoach(prices: PricePoint[], result: BehavioralResult): CoachResult {
  const n = prices.length;
  const closes = prices.map((p) => p.close);
  const enoughData = n >= 60;

  const ratio52w = result.anchoring.ratio;

  // 直近ピーク（52週窓）からのドローダウン
  const window = closes.slice(Math.max(0, n - 252));
  const peak = window.length ? Math.max(...window) : closes[n - 1] || 0;
  const cur = closes[n - 1] || 0;
  const drawdown = peak > 0 ? Math.max(0, (peak - cur) / peak) : 0;

  const ret = (lb: number) =>
    n > lb && closes[n - 1 - lb] > 0 ? closes[n - 1] / closes[n - 1 - lb] - 1 : 0;
  const ret20 = ret(20);
  const ret60 = ret(60);

  const momentumStrong = result.momentum.periods.some(
    (p) => Math.abs(p.tStat) > 2 && p.avgReturn > 0
  );
  const reversal = result.momentum.reversalDetected;

  const metrics: CoachMetrics = {
    ratio52w,
    drawdown,
    ret20,
    ret60,
    momentumStrong,
    reversal,
    enoughData,
  };

  const signals: ContextSignal[] = [];

  if (enoughData) {
    // 高値近辺: アンカリング＋早すぎる利確
    if (ratio52w >= 0.9) {
      signals.push({
        biasId: "anchoring",
        title: "高値圏 — アンカリング／早すぎる利確に注意",
        severity: "medium",
        situation: `52週高値比率が${(ratio52w * 100).toFixed(0)}%。過去1年のほぼ高値圏にいます。`,
        trap: "『高値だから一旦売っておこう』と機械的に利確したり、逆に高値がアンカーになり少しの押しで狼狽しやすい局面です。",
        action: "トレンドが継続しているかを事前ルール（移動平均・モメンタム）で判定し、買値や高値ではなく『トレンド転換の有無』で保有継続を判断する。",
      });
    }

    // 深いドローダウン＋安値圏: ディスポジション/サンクコスト/確証
    if (ratio52w <= 0.75 || drawdown >= 0.2) {
      signals.push({
        biasId: "disposition",
        title: "安値圏／含み損 — 塩漬け・ナンピン衝動に注意",
        severity: "high",
        situation: `直近ピークから${(drawdown * 100).toFixed(0)}%下落（52週高値比率${(ratio52w * 100).toFixed(0)}%）。`,
        trap: "『ここまで下げたのだから戻るはず』と損切りを先送り（ディスポジション効果）、平均取得単価を下げようと安易にナンピン（サンクコスト効果）しがちです。",
        action: "『今この資金を新規にこの銘柄へ入れるか？』で判断する。事前の損切りラインに達していれば、買値を無視して執行する。反対材料も一度洗い出す（確証バイアス対策）。",
      });
    }

    // 直近の急落: 過剰反応/リセンシー/群集
    if (ret20 <= -0.08) {
      signals.push({
        biasId: "recency",
        title: "直近の急落 — 狼狽売り・過剰反応に注意",
        severity: "high",
        situation: `直近20営業日で${(ret20 * 100).toFixed(1)}%下落。`,
        trap: "直近の下げを将来へ過度に投影し（リセンシーバイアス）、周囲の悲観に同調して底で投げやすい局面です。短期は過剰反応が反転（リバーサル）することもあります。",
        action: "長期の分布・平均回帰を確認し、事前に決めたルール以外での成行売りを避ける。ポジションサイズが過大でないかだけ点検する。",
      });
    }

    // 直近の急騰: 自信過剰/ハウスマネー/群集
    if (ret20 >= 0.1) {
      signals.push({
        biasId: "overconfidence",
        title: "直近の急騰 — 自信過剰・高値掴みに注意",
        severity: "medium",
        situation: `直近20営業日で+${(ret20 * 100).toFixed(1)}%上昇。`,
        trap: "『自分の読みが当たった』と自信過剰になり、含み益を『あぶく銭』とみなして（ハウスマネー効果）過大なリスクを取りやすい局面です。話題性での飛び乗り（ハーディング）にも注意。",
        action: "利益で膨らんだ資金も自己資金と同じ規律で扱う。追加投資は自信ではなくリスク許容度で上限を決める。",
      });
    }

    // モメンタム・リバーサルの構造
    if (reversal) {
      signals.push({
        biasId: "representativeness",
        title: "短期リバーサル＋長期モメンタムの構造",
        severity: "info",
        situation: "この銘柄では短期は逆張り、長期は順張りが効きやすい傾向が出ています。",
        trap: "直近の値動きだけを『代表例』として順張り・逆張りを混同すると、短期の綾を長期トレンドと誤認しがちです。",
        action: "『いま自分が取ろうとしているのは短期の綾か、長期トレンドか』を明確にし、時間軸に応じて順張り／逆張りを使い分ける。",
      });
    } else if (momentumStrong) {
      signals.push({
        biasId: "confirmation",
        title: "有意なモメンタムあり — 過信と裏抜けに注意",
        severity: "info",
        situation: "統計的に有意なモメンタムが検出されています。",
        trap: "順張りが効く局面ほど自分の見立てを支持する情報だけを集め（確証バイアス）、モメンタムクラッシュ（急反転）の兆候を見落としがちです。",
        action: "トレンドフォロー中も損切りラインを引き上げ、反対材料のチェックを習慣化する。",
      });
    }

    // 常時の一般リマインダー
    signals.push({
      biasId: "overtrading",
      title: "共通リマインダー — 過剰取引・メンタルアカウンティング",
      severity: "info",
      situation: "局面を問わず効いてくる、地味だが影響の大きい癖です。",
      trap: "『何かしていないと落ち着かない』で売買回数が増え、手数料・税がリターンを削ります。資金を『儲けた金／元本』と色分けすると規律が緩みます。",
      action: "売買ルールを満たさない日は何もしない。全資産を一つの口座として同じ規律で運用する。",
    });
  }

  return { metrics, signals };
}

// ===================================================================
// ②' 実データで裏づけるバイアス・エビデンス
//   既存計算（モメンタム/リバーサル・アンカリング）と、その場で計算する
//   ディスポジション・損失回避を、この銘柄の実数値で定量化する。
// ===================================================================
export type Tone = "pos" | "neg" | "neutral";

export interface EvidenceMetric {
  label: string;
  value: string;
  tone?: Tone;
}

export interface BiasEvidence {
  biasId: string;
  name: string;
  metrics: EvidenceMetric[];
  verdict: string;       // この銘柄で効いているかの判定
  verdictTone: Tone;
  implication: string;   // 行動への含意（早すぎる利確・狼狽売り等）
}

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const signedPct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

export function generateEvidence(prices: PricePoint[], result: BehavioralResult): BiasEvidence[] {
  const n = prices.length;
  const closes = prices.map((p) => p.close);
  const out: BiasEvidence[] = [];
  if (n < 60) return out;

  // --- 1. アンカリング（52週高値比率の条件付き翌月リターン） ---
  const anch = result.anchoring;
  const diff = anch.avgReturnNearHigh - anch.avgReturnFarHigh;
  {
    const nearStrong = diff > 0.005;
    const farStrong = diff < -0.005;
    out.push({
      biasId: "anchoring",
      name: "アンカリング（52週高値）",
      metrics: [
        { label: "現在の高値比率", value: pct(anch.ratio) },
        { label: "高値近辺(>90%)の翌月", value: signedPct(anch.avgReturnNearHigh), tone: anch.avgReturnNearHigh >= 0 ? "pos" : "neg" },
        { label: "低水準(≤70%)の翌月", value: signedPct(anch.avgReturnFarHigh), tone: anch.avgReturnFarHigh >= 0 ? "pos" : "neg" },
        { label: "差（近辺−低水準）", value: signedPct(diff), tone: diff >= 0 ? "pos" : "neg" },
      ],
      verdict: nearStrong
        ? "高値圏の方が翌月強い → 過小反応（アンカリング効果あり）の型。George-Hwangの52週高値モメンタムに整合。"
        : farStrong
        ? "低水準の方が翌月強い → 平均回帰型。高値がアンカーになっても順張りの根拠は弱い。"
        : "高値圏・低水準で翌月の差は小さい → アンカリングによる明確なエッジは見られない。",
      verdictTone: nearStrong ? "pos" : farStrong ? "neg" : "neutral",
      implication: nearStrong
        ? "『高値だから』と機械的に売ると継続上昇を逃しやすい。トレンド転換の有無で保有継続を判断する。"
        : farStrong
        ? "高値をアンカーにした戻り売り・押し目買いは根拠が薄い。平均回帰の水準感で判断する。"
        : "52週高値だけを売買根拠にしない。他指標と併用する。",
    });
  }

  // --- 2. モメンタム/リバーサル（短期WML vs 長期WML と t値） ---
  const periods = result.momentum.periods;
  const short = periods.find((p) => p.days === 20) ?? periods.find((p) => p.days <= 20);
  const long = periods.find((p) => p.days === 120) ?? periods.find((p) => p.days >= 120);
  if (short || long) {
    const shortRev = !!short && short.avgReturn < 0 && Math.abs(short.tStat) > 1.5;
    const shortMom = !!short && short.avgReturn > 0 && Math.abs(short.tStat) > 1.5;
    const longMom = !!long && long.avgReturn > 0 && Math.abs(long.tStat) > 1.5;
    const longRev = !!long && long.avgReturn < 0 && Math.abs(long.tStat) > 1.5;

    const metrics: EvidenceMetric[] = [];
    if (short)
      metrics.push(
        { label: `短期WML(${short.days}日)`, value: signedPct(short.avgReturn), tone: short.avgReturn >= 0 ? "pos" : "neg" },
        { label: "短期 t値", value: short.tStat.toFixed(2), tone: Math.abs(short.tStat) > 2 ? (short.avgReturn >= 0 ? "pos" : "neg") : "neutral" }
      );
    if (long)
      metrics.push(
        { label: `長期WML(${long.days}日)`, value: signedPct(long.avgReturn), tone: long.avgReturn >= 0 ? "pos" : "neg" },
        { label: "長期 t値", value: long.tStat.toFixed(2), tone: Math.abs(long.tStat) > 2 ? (long.avgReturn >= 0 ? "pos" : "neg") : "neutral" }
      );

    let verdict: string;
    let tone: Tone;
    if (shortRev && longMom) {
      verdict = "短期は逆張り（リバーサル）、長期は順張り（モメンタム）が有効という典型構造。";
      tone = "pos";
    } else if (longMom) {
      verdict = "長期モメンタムが有意 → 勝者は継続しやすい。順張りが効く局面。";
      tone = "pos";
    } else if (shortRev) {
      verdict = "短期リバーサルが有意 → 直近の下げは反発しやすい。逆張りが効く。";
      tone = "pos";
    } else if (shortMom || longRev) {
      verdict = "一部でモメンタム/リバーサルの兆候はあるが、方向は混在。";
      tone = "neutral";
    } else {
      verdict = "統計的に有意なモメンタム/リバーサルは検出されず、効率的市場に近い。";
      tone = "neutral";
    }

    out.push({
      biasId: "disposition", // 早すぎる利確＝ディスポジションのコスト計算に直結
      name: "モメンタム/リバーサル",
      metrics,
      verdict,
      verdictTone: tone,
      implication:
        (longMom ? "長期の勝者を早く利確（ディスポジション効果）すると継続上昇を逃す。" : "") +
        (shortRev ? "直近の急落での狼狽売り（損失回避）は不利になりやすく、直近急騰への飛び乗りも過剰反応で不利。" : "") +
        (!longMom && !shortRev ? "順張り・逆張りいずれも統計的優位が弱いので、期待に頼らずリスク管理を優先する。" : ""),
    });
  }

  // --- 3. ディスポジション効果のコスト（勝者/敗者の翌20日リターン） ---
  {
    const hold = 20;
    const lb = 120;
    const fw: number[] = [];
    const fl: number[] = [];
    for (let i = lb; i < n - hold; i++) {
      if (closes[i - lb] <= 0 || closes[i] <= 0) continue;
      const past = closes[i] / closes[i - lb] - 1;
      const fut = closes[i + hold] / closes[i] - 1;
      if (past > 0) fw.push(fut);
      else fl.push(fut);
    }
    if (fw.length >= 10 && fl.length >= 10) {
      const avgFw = mean(fw);
      const avgFl = mean(fl);
      const earlySellCost = avgFw > 0 ? avgFw : 0; // 勝者を今売ると放棄する平均リターン
      const holdLoserCost = avgFl < 0 ? avgFl : 0; // 敗者を持ち続けて被る平均リターン
      const biting = earlySellCost > 0.005 || holdLoserCost < -0.005;
      out.push({
        biasId: "disposition",
        name: "ディスポジション効果のコスト",
        metrics: [
          { label: "勝者の翌20日平均", value: signedPct(avgFw), tone: avgFw >= 0 ? "pos" : "neg" },
          { label: "敗者の翌20日平均", value: signedPct(avgFl), tone: avgFl >= 0 ? "pos" : "neg" },
          { label: "勝者早売りで放棄", value: signedPct(-earlySellCost), tone: earlySellCost > 0 ? "neg" : "neutral" },
          { label: "敗者保有で被る", value: signedPct(holdLoserCost), tone: holdLoserCost < 0 ? "neg" : "neutral" },
        ],
        verdict: biting
          ? "この銘柄では『勝者を早売り・敗者を塩漬け』が実際にコストになっている。"
          : "この銘柄では勝者/敗者の翌月挙動に大きな偏りはなく、ディスポジションのコストは限定的。",
        verdictTone: biting ? "neg" : "neutral",
        implication: biting
          ? `勝者を早く手放すと平均${pct(earlySellCost)}を逃し、敗者を持ち続けると平均${pct(Math.abs(holdLoserCost))}を被る。事前の損切り/利確ルールで機械的に対処する。`
          : "含み益・含み損に関わらず、事前ルールに沿って淡々と管理すればよい。",
      });
    }
  }

  // --- 4. 損失回避（下方/上方の非対称性） ---
  {
    const rets: number[] = [];
    for (let i = 1; i < n; i++) {
      if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
    }
    const ups = rets.filter((r) => r > 0);
    const downs = rets.filter((r) => r < 0);
    if (ups.length >= 10 && downs.length >= 10) {
      const avgUp = mean(ups);
      const avgDown = Math.abs(mean(downs));
      const upVol = std(ups);
      const downVol = std(downs);
      const volRatio = upVol > 0 ? downVol / upVol : 0;
      const worst = Math.min(...rets);
      const lambda = 2.25; // プロスペクト理論の代表的損失回避係数
      const painRatio = avgUp > 0 ? (lambda * avgDown) / avgUp : 0;
      const asym = volRatio > 1.1;
      out.push({
        biasId: "loss-aversion",
        name: "損失回避（下方の非対称性）",
        metrics: [
          { label: "平均上昇日", value: signedPct(avgUp, 2), tone: "pos" },
          { label: "平均下落日", value: signedPct(-avgDown, 2), tone: "neg" },
          { label: "下方/上方ボラ比", value: volRatio.toFixed(2), tone: asym ? "neg" : "neutral" },
          { label: "最悪の1日", value: signedPct(worst, 1), tone: "neg" },
        ],
        verdict: asym
          ? "下落日のブレが上昇日より大きい → 下方リスクが非対称に大きく、損失回避が強く刺激されやすい。"
          : "上昇日と下落日のブレはほぼ対称 → 分布起因で損失回避が特別強まる要素は小さい。",
        verdictTone: asym ? "neg" : "neutral",
        implication: `損失回避係数λ≈${lambda}を掛けると、平均的な下落日の“痛み”は上昇日の“喜び”の約${painRatio.toFixed(1)}倍に感じられる。この主観的な痛みで狼狽売り・過度なポジション縮小をしないよう、事前のリスク許容度で行動を固定する。`,
      });
    }
  }

  return out;
}

// ===================================================================
// ③ 売買前チェックリスト（事前コミットメント）
// ===================================================================
export const CHECKLIST: ChecklistItem[] = [
  { id: "c1", text: "この判断は買値や過去高値を基準にしていないか？（今ゼロから買うか？で考えたか）", biasId: "anchoring" },
  { id: "c2", text: "損切りライン・利確ラインを数値で事前に決めたか？", biasId: "disposition" },
  { id: "c3", text: "外れたシナリオと、その時の対応を書き出したか？", biasId: "overconfidence" },
  { id: "c4", text: "ポジションサイズは自信ではなくリスク許容度から決めたか？", biasId: "overconfidence" },
  { id: "c5", text: "反対材料（弱気の根拠）を最低3つ調べたか？", biasId: "confirmation" },
  { id: "c6", text: "『みんなが買っているから』が主な理由になっていないか？", biasId: "herding" },
  { id: "c7", text: "ナンピンは事前計画に沿ったものか？（含み損を取り返すためではないか）", biasId: "sunk-cost" },
  { id: "c8", text: "直近数日の値動きに引っ張られていないか？（長期分布を確認したか）", biasId: "recency" },
  { id: "c9", text: "利益で得た資金も元本と同じ規律で扱っているか？", biasId: "mental-accounting" },
  { id: "c10", text: "この売買はルールに基づくか？（退屈・焦りでの取引ではないか）", biasId: "overtrading" },
];
