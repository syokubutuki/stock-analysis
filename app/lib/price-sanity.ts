import type { PricePoint } from "./types";

/**
 * 価格データのスケール破損の検出と修復（データ取得の関門で全消費者に適用する）。
 *
 * ## なぜ API 層に置くか
 *
 * 上流（Yahoo Finance）の配信データには、ごく稀に「数日だけ価格が 1/10 になる」類の
 * スケール破損が混じる。実例として `1306.T`（TOPIX ETF）は 2026-03-30〜03-31 の2営業日だけ
 * 生値・調整後終値の**両方**が 1/10 になっており（分割イベントの告知は無い）、同時に
 * 出来高が約10倍になっている。＝上流が 10:1 分割の調整を2行にだけ誤って当てている。
 *
 *   2026-03-27  382.70
 *   2026-03-30   37.64  ← −232%
 *   2026-03-31   37.14
 *   2026-04-01  389.20  ← +235%
 *
 * この2点だけで日次σが 1.3% → 12.1%（年率21% → 193%）に膨れる。回帰の分母 Var(M) が
 * 100倍になるため、この系列をベンチマークに使った市場βは 0.98 → 0.03 に潰れる。
 * **1点の異常値が回帰・分散・シャープ比・最適化のすべてを無意味にする**。
 *
 * 被害は特定の分析に限らない。`/api/stock` の呼び出し箇所は 20 以上あり、ベンチマーク
 * （CAPM/SML・条件付きβ・減衰β・相対強弱・DCC・イベントスタディ…）だけでなく、
 * 分析対象そのものにも同じ破損が起こりうる。したがって個々のコンポーネントで対処すると
 * 必ず漏れる。**取得の関門（route handler）を唯一の修復地点とする**のが唯一保守可能な形。
 *
 * ## 誤検出を避ける設計
 *
 * 修復は「本物の相場変動では起こりえない」条件を**すべて**満たす場合に限る。
 *
 *   1. 大きさ:  |log r| > 0.3（±35%）
 *   2. 往復:    5営業日以内に元の価格水準へ戻り、戻りの日も |log r| > 0.3
 *   3. 倍率:    含意される倍率が 1/10・1/100・1/2 等の「切りのいい」スケール比に
 *               対数で 5% 以内で一致する
 *
 * 3 を必須にしている点が重要。VIX のような系列は +80% 急騰→数日で急落という往復を
 * 実際に起こしうるが、その倍率は 0.45 のような端数になり切りのいい比には一致しない。
 * 逆にスケール破損は定義上つねに 10 進・分割比である。**正しいデータを黙って書き換える
 * 方が、破損を見逃すより有害**なので、判定は保守側に倒す。
 *
 * 条件を満たさない極端なジャンプは修復せず `suspects` として報告し、UI で警告する。
 * （本物の暴落・未調整の分割など、機械的に判断してはいけないものが混ざるため。）
 *
 * ## 適用範囲外（検討済み）
 *
 * 日中足（`/api/intraday`）には適用していない。ここで扱う破損は分割調整の当て間違いで、
 * 調整後終値を持つ日足に固有の現象である。日中足は生値のみ・取得範囲も数十日と短く、
 * 想定される異常は異常ティックという別クラスなので、同じ判定則は流用できない。
 * 必要になったら日中足用の判定を別に設計する。
 *
 * ## 修復方法
 *
 * リターンを 0 に潰すのではなく**価格水準そのものを倍率で戻す**。破損区間の内部は
 * 一定倍率が掛かっているだけなので日々のリターン自体は正しく、水準を復元すれば
 * 区間内のリターンも保たれる。水準で直すことで OHLC・ドローダウン・バリア（TP/SL）・
 * ローソク足描画まで一貫して正しくなる。出来高は価格と逆向きに誤スケールされている
 * ため倍率を掛けて戻す（1306.T では 251.8M × 0.1 ≒ 25M で平常水準と整合する）。
 */

/**
 * サニタイザの版。**判定ロジックや閾値を変えたら必ず上げる**。
 *
 * 価格は IndexedDB に8時間キャッシュされる（app/lib/price-cache.ts）。修復を入れても
 * 古い版で保存された破損データがキャッシュに残っていると、利用者の画面は直らない。
 * キャッシュ側でこの版を突き合わせ、版が違うエントリは TTL 内でも無効として捨てる。
 */
export const SANITIZER_VERSION = 2;

/** データ破損とみなす1日あたり対数リターンの下限（|log r| > これ）。±35%。 */
const JUMP_THRESHOLD = 0.3;
/** 破損した価格水準が元に戻るまでに許す営業日数。 */
const MAX_SPAN = 5;
/** 往復後に残る水準のずれの許容（入口ジャンプの大きさに対する比）。 */
const ROUNDTRIP_RESIDUAL = 0.25;
/** 倍率を「切りのいい比」に丸める際の対数距離の許容。 */
const FACTOR_SNAP_TOLERANCE = 0.05;
/**
 * 未修復ジャンプを「疑い」として報告する閾値（ロバストσの倍数）。
 *
 * ±35% という絶対閾値だけだと ^VIX のような高ボラ系列で疑いが量産される（10年で22件）。
 * VIX の日次σは約8%なので ±35% は 4σ 程度＝日常の範囲。一方 1306.T のσは1.3%なので
 * 同じ ±35% は 26σ で明らかに異常。**同じ絶対値でも系列によって異常さが違う**ため、
 * 疑いの報告はσ相対でも門を設ける。修復側にはこの門を掛けない（往復＋切りのいい倍率で
 * 既に決定的であり、σが大きい系列で破損を見逃す方が有害）。
 */
const SUSPECT_SIGMA_MULTIPLE = 8;

/**
 * 倍率が 1 から離れていることの要求（|log k| ≥ log 2、つまり 2倍以上か 1/2 以下）。
 *
 * 当初は 3/2・2/3・4/3 のような 1 に近い分割比も候補に入れていたが、実データの掃引で
 * `^TNX`（米10年金利）の 2020-03-09（COVID ショックで 0.75% → 0.5% へ急落し数日で戻した）が
 * 倍率 2/3 として誤検出された。σ の改善は 1.1倍しかなく＝**壊れていないものを直していた**。
 * 1 に近い比は本物の相場変動が偶然一致してしまう。スケール破損は定義上 10進の桁ずれか
 * 大きな分割比なので、1 の近傍は候補から外す。
 */
const MIN_LOG_FACTOR = Math.log(2) - 1e-9;

/**
 * 倍率の材料性の門（|log k| > これ × ロバストσ）。
 * 倍率が系列の日常変動に埋もれる程度なら、それは破損ではなく相場変動。
 */
const FACTOR_SIGMA_MULTIPLE = 10;

/**
 * スケール破損として妥当な倍率の候補。10進の桁ずれと、1 から十分離れた分割比のみ。
 * これ以外の倍率（＝端数、および 1 の近傍）は相場変動と区別できないので修復しない。
 */
const PLAUSIBLE_FACTORS: number[] = (() => {
  const out = new Set<number>();
  for (const p of [2, 3, 4, 5, 6, 8, 10, 20, 25, 50, 100, 1000]) {
    out.add(p);
    out.add(1 / p);
  }
  return [...out].filter((k) => Math.abs(Math.log(k)) >= MIN_LOG_FACTOR);
})();

/** 修復した1日の修復前/修復後の実値。画面で「何をどう直したか」を示すために持つ。 */
export interface GlitchPoint {
  time: string;
  /** 配信元の値（修復前の終値）。 */
  closeBefore: number;
  /** 修復後の終値。 */
  closeAfter: number;
  /** 配信元の出来高。 */
  volumeBefore: number;
  /** 修復後の出来高。 */
  volumeAfter: number;
}

/** 修復した破損区間。 */
export interface PriceGlitch {
  /** 破損区間の最初の営業日（YYYY-MM-DD）。 */
  from: string;
  /** 破損区間の最後の営業日（YYYY-MM-DD）。 */
  to: string;
  /** 破損区間の営業日数。 */
  days: number;
  /** 破損中の価格に掛かっていた倍率（1306.T なら 0.1）。修復は price / factor。 */
  factor: number;
  /** 修復した各日の実値。表・チャートで修復前後を並べて見せるために持つ。 */
  points: GlitchPoint[];
  /** 破損区間の直前の営業日の終値（＝正常な水準の基準）。 */
  anchorBefore: string;
  /** 水準が戻った営業日（＝破損区間の直後）。 */
  anchorAfter: string;
}

/** 修復条件を満たさなかった極端なジャンプ（本物の暴落・未調整の分割の可能性）。 */
export interface PriceJumpSuspect {
  /** ジャンプが観測された営業日。 */
  time: string;
  /** その日の対数リターン。 */
  logReturn: number;
}

export interface PriceSanityReport {
  /** 修復した破損区間。空なら何も書き換えていない。 */
  repaired: PriceGlitch[];
  /** 修復しなかった極端なジャンプ（要人間判断）。 */
  suspects: PriceJumpSuspect[];
  /**
   * 修復前/修復後の年率ボラティリティ（修復があったときだけ意味を持つ）。
   * 「放置するとどれだけ壊れていたか」を数値で示す。この比が 1 に近い修復は
   * そもそも壊れていなかった疑いがある（^TNX の教訓）。
   */
  sigmaBefore?: number;
  sigmaAfter?: number;
}

/**
 * MAD ベースのロバストσ。破損点そのものにσを膨らまされないよう中央絶対偏差を使う
 * （破損があると標準偏差は 1.3% → 12% に跳ね、自分自身を「正常」と判定してしまう）。
 */
function robustSigma(r: number[]): number {
  if (r.length < 10) return 0;
  const sorted = [...r].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const dev = r.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  return dev[Math.floor(dev.length / 2)] / 0.6745;
}

/** 倍率を「切りのいい比」に丸める。一致しなければ null（＝修復しない）。 */
function snapFactor(logFactor: number): number | null {
  let best: number | null = null;
  let bestDist = FACTOR_SNAP_TOLERANCE;
  for (const cand of PLAUSIBLE_FACTORS) {
    const d = Math.abs(logFactor - Math.log(cand));
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  return best;
}

/**
 * 価格系列のスケール破損を修復する。入力は破壊せず新しい配列を返す。
 *
 * 検出は終値の対数リターンで行い、修復は OHLC を倍率で割り・出来高に倍率を掛ける。
 * 修復が無ければ入力配列をそのまま返す（参照が変わらないので再レンダリングを誘発しない）。
 */
export function repairPriceGlitches(prices: PricePoint[]): {
  prices: PricePoint[];
  report: PriceSanityReport;
} {
  const repaired: PriceGlitch[] = [];
  const suspects: PriceJumpSuspect[] = [];
  const n = prices.length;
  if (n < 3) return { prices, report: { repaired, suspects } };

  // 各営業日に適用する倍率。1 なら無修復。
  const factors = new Array<number>(n).fill(1);
  const close = prices.map((p) => p.close);

  const logRet = (i: number) =>
    close[i] > 0 && close[i - 1] > 0 ? Math.log(close[i] / close[i - 1]) : 0;

  // 疑い報告の門はσ相対でも設ける（高ボラ系列で警告が量産されるのを防ぐ）。
  const allRets: number[] = [];
  for (let i = 1; i < n; i++) allRets.push(logRet(i));
  const sigma = robustSigma(allRets);
  const suspectFloor = Math.max(JUMP_THRESHOLD, SUSPECT_SIGMA_MULTIPLE * sigma);
  const noteSuspect = (i: number, r: number) => {
    if (Math.abs(r) > suspectFloor) suspects.push({ time: prices[i].time, logReturn: r });
  };

  for (let t = 1; t < n; t++) {
    const rIn = logRet(t);
    if (Math.abs(rIn) <= JUMP_THRESHOLD) continue;

    // 条件2: t..s-1 が破損区間で、s で水準が戻る s を探す。
    let bestS = -1;
    let bestResidual = Infinity;
    for (let s = t + 1; s < Math.min(n, t + 1 + MAX_SPAN); s++) {
      if (Math.abs(logRet(s)) <= JUMP_THRESHOLD) continue;
      // 破損前(t-1)から復帰後(s)への累積。破損が往復なら ≒ 数日分の真のリターン。
      const residual = Math.abs(Math.log(close[s] / close[t - 1]));
      if (residual < bestResidual) {
        bestResidual = residual;
        bestS = s;
      }
    }

    if (bestS < 0 || bestResidual >= ROUNDTRIP_RESIDUAL * Math.abs(rIn)) {
      noteSuspect(t, rIn);
      continue;
    }

    // 条件3: 倍率を両端から推定して平均し、切りのいい比に丸める。
    //   入口: log(c[t]/c[t-1])   = log k + (t の真のリターン)
    //   出口: log(c[s-1]/c[s])   = log k − (s の真のリターン)
    // 平均すると真のリターンの寄与が相殺され、log k の推定精度が上がる。
    const logIn = rIn;
    const logOut = Math.log(close[bestS - 1] / close[bestS]);
    const factor = snapFactor((logIn + logOut) / 2);

    // 材料性: 倍率が系列の日常変動に埋もれる程度なら破損ではない（^TNX の教訓）。
    if (factor === null || Math.abs(Math.log(factor)) <= FACTOR_SIGMA_MULTIPLE * sigma) {
      noteSuspect(t, rIn);
      continue;
    }

    for (let i = t; i < bestS; i++) factors[i] = factor;
    const points: GlitchPoint[] = [];
    for (let i = t; i < bestS; i++) {
      points.push({
        time: prices[i].time,
        closeBefore: prices[i].close,
        closeAfter: prices[i].close / factor,
        volumeBefore: prices[i].volume,
        volumeAfter: Math.round(prices[i].volume * factor),
      });
    }
    repaired.push({
      from: prices[t].time,
      to: prices[bestS - 1].time,
      days: bestS - t,
      factor,
      points,
      anchorBefore: prices[t - 1].time,
      anchorAfter: prices[bestS].time,
    });
    // 復帰日 s は正常値なので、その次の日から探索を続ける。
    t = bestS;
  }

  if (repaired.length === 0) return { prices, report: { repaired, suspects } };

  const out = prices.map((p, i) => {
    const k = factors[i];
    if (k === 1) return p;
    return {
      time: p.time,
      open: p.open / k,
      high: p.high / k,
      low: p.low / k,
      close: p.close / k,
      // 出来高は価格と逆向きに誤スケールされているので倍率を掛けて戻す。
      volume: Math.round(p.volume * k),
    };
  });
  return {
    prices: out,
    report: {
      repaired,
      suspects,
      sigmaBefore: annualizedSigma(close),
      sigmaAfter: annualizedSigma(out.map((p) => p.close)),
    },
  };
}

/** 年率ボラティリティ（対数リターンの標準偏差 × √252）。修復の効き目を示すために使う。 */
function annualizedSigma(close: number[]): number {
  const r: number[] = [];
  for (let i = 1; i < close.length; i++) {
    if (close[i] > 0 && close[i - 1] > 0) r.push(Math.log(close[i] / close[i - 1]));
  }
  if (r.length < 2) return 0;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}

/** 警告バナー等に出す1行の説明。修復も疑いも無ければ null。 */
export function describeSanityReport(report: PriceSanityReport | undefined): string | null {
  if (!report) return null;
  const parts: string[] = [];
  for (const g of report.repaired) {
    const span = g.days === 1 ? g.from : `${g.from}〜${g.to}`;
    parts.push(
      `${span} の価格が ${formatFactor(g.factor)} に破損していたため水準を復元しました（配信元の調整漏れ。放置すると σ・β が壊れます）`
    );
  }
  if (report.suspects.length > 0) {
    const list = report.suspects
      .slice(0, 3)
      .map((s) => `${s.time}（${(Math.expm1(s.logReturn) * 100).toFixed(0)}%）`)
      .join("・");
    const more = report.suspects.length > 3 ? ` 他${report.suspects.length - 3}件` : "";
    parts.push(
      `±35% を超える日次変動を検出しましたが、スケール破損と断定できないため未修正です: ${list}${more}。本物の急変動か未調整の分割かは目視で確認してください`
    );
  }
  return parts.length > 0 ? parts.join("／") : null;
}

function formatFactor(factor: number): string {
  if (factor < 1) {
    const inv = Math.round(1 / factor);
    return `1/${inv}`;
  }
  return `${Math.round(factor)}倍`;
}
