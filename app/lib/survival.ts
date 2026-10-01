// 右打ち切りのある待ち時間（営業日単位）の Kaplan–Meier 推定。
//
// 「期間内に起きなかった事例」を捨てたり上限日に起きたことにしたりすると、待ち時間は
// 短い側へ偏る。KM は「その日まで未発生とだけ分かっている」事例をリスク集合に残し、
// 各日の未発生割合を掛け合わせることで、この偏りを避ける。
//
// 利用箇所: rise-to-decline.ts（上昇後の初回下落）と nday-move-paths.ts
// （条件成立後の初回下落・最高値からの反落）。両者で数値の規約を揃えるため共通化した。
//
// 規約（rise-to-decline.ts の初版から引き継いだもの。変えると両パネルの数値が動く）:
// - 発生は1日目以降（time ≥ 1）。time = 0 は「翌日を観測できていない打ち切り」だけに使い、
//   1日目のリスク集合に入れない（件数には残す）。
// - 同じ日の発生と打ち切りは、どちらもその日のリスク集合 n[k] に含め、日末に取り除く。
// - リスク集合が尽きた先は外挿しない（null）。ただし S = 0 に達していれば F = 1 を保つ。

export interface SurvivalObservation {
  /** 観測日数 Y = min(T, A)。整数、0 以上。 */
  time: number;
  /** 発生を観測したか δ = 1{T ≤ A}。false は右打ち切り。 */
  event: boolean;
}

export interface SurvivalDay {
  day: number;
  /** その日の追跡対象 n[k] = Σ1{Y ≥ k} */
  atRisk: number;
  /** その日の発生 d[k] = Σ1{Y = k, δ = 1} */
  events: number;
  /** その日の打ち切り */
  censored: number;
  /** 累積発生確率 F[k] = 1 − S[k]。推定できない日は null */
  cumulativeProbability: number | null;
}

/**
 * 1〜horizon 日の累積発生確率を返す。time は 0〜horizon の整数であること
 * （範囲外は horizon の外なので集計から除く）。発生の time = 0 は定義上ありえないため無視する。
 */
export function kaplanMeierDaily(observations: SurvivalObservation[], horizon: number): SurvivalDay[] {
  const events = Array<number>(horizon + 1).fill(0);
  const censored = Array<number>(horizon + 1).fill(0);
  let total = 0;
  for (const o of observations) {
    if (!Number.isInteger(o.time) || o.time < 0 || o.time > horizon) continue;
    if (o.event && o.time === 0) continue;
    total++;
    if (o.event) events[o.time]++;
    else censored[o.time]++;
  }
  const days: SurvivalDay[] = [];
  let atRisk = total - censored[0];
  let survival = 1;
  for (let day = 1; day <= horizon; day++) {
    if (atRisk > 0) survival *= 1 - events[day] / atRisk;
    // リスク集合が尽きた後の未観測の裾は外挿しない。全件発生済みなら100%を保持。
    const cumulativeProbability = atRisk > 0 || survival === 0 ? 1 - survival : null;
    days.push({ day, atRisk, events: events[day], censored: censored[day], cumulativeProbability });
    atRisk -= events[day] + censored[day];
  }
  return days;
}

/** 累積発生確率が初めて q に達する日。到達しなければ null（平均日数などで代用しない）。 */
export function survivalQuantile(days: { day: number; cumulativeProbability: number | null }[], q: number): number | null {
  return days.find((d) => d.cumulativeProbability !== null && d.cumulativeProbability >= q - 1e-12)?.day ?? null;
}
