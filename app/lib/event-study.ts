import { PricePoint } from "./types";
import { alignSeries } from "./benchmark";

// トリガー条件: 上昇(>= +X%) / 下落(<= -X%) / 絶対値(|r| >= X%)
export type TriggerCond = "up" | "down" | "abs";

export interface EventPath {
  startTime: string;        // トリガー発生日(始点 t0)
  triggerReturn: number;    // トリガー当日の対数リターン
  path: number[];           // 長さ horizon+1。始点からの累積対数リターン (path[0]=0)
}

export interface HorizonStat {
  k: number;        // 経過日数
  mean: number;     // 平均累積リターン
  median: number;
  std: number;
  winRate: number;  // path[k] > 0 の割合
  n: number;
}

export interface EventStudyResult {
  events: EventPath[];          // 各トリガー後のパス（スパゲッティ描画用）
  horizon: number;
  meanPath: number[];           // 条件付き平均パス
  medianPath: number[];
  p25Path: number[];
  p75Path: number[];
  baselineMean: number[];       // 無条件（全日起点）平均パス＝比較基準
  perK: HorizonStat[];          // k=0..horizon の統計
  nTrigger: number;             // トリガー数
  nUsable: number;              // 完全な horizon を確保できたトリガー数（=events.length）
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * イベントスタディ: トリガー系列が条件を満たした日(t0)を起点として、
 * ターゲット系列の「その後 horizon 日間の累積対数リターン」を始点(0%)で揃えて集計する。
 *
 * @param target     値動きを観察したい銘柄(分析対象)
 * @param trigger    条件判定に使う系列(例: 日経平均)。target と同一にすれば自己条件
 * @param cond       条件タイプ
 * @param thresholdPct  しきい値(%単位。例 2 は 2%)
 * @param horizon    観察する営業日数
 */
export function computeEventStudy(
  target: PricePoint[],
  trigger: PricePoint[],
  cond: TriggerCond,
  thresholdPct: number,
  horizon: number,
): EventStudyResult {
  // 日付で内部結合（両系列が揃う日のみ）
  const { stock: tgt, bench: trg } = alignSeries(target, trigger);
  const n = tgt.length;
  const thr = thresholdPct / 100;
  const empty: EventStudyResult = {
    events: [], horizon, meanPath: [], medianPath: [], p25Path: [], p75Path: [],
    baselineMean: [], perK: [], nTrigger: 0, nUsable: 0,
  };
  if (n < horizon + 2) return empty;

  const meets = (r: number): boolean =>
    cond === "up" ? r >= thr : cond === "down" ? r <= -thr : Math.abs(r) >= thr;

  // ターゲットの始点揃え累積対数リターンパスを構築
  const buildPath = (i: number): number[] => {
    const base = tgt[i].close;
    const p: number[] = [];
    for (let k = 0; k <= horizon; k++) p.push(Math.log(tgt[i + k].close / base));
    return p;
  };

  const events: EventPath[] = [];
  let nTrigger = 0;
  for (let i = 1; i < n; i++) {
    const prevC = trg[i - 1].close, c = trg[i].close;
    if (prevC <= 0 || c <= 0) continue;
    const r = Math.log(c / prevC);
    if (!meets(r)) continue;
    nTrigger++;
    if (i + horizon <= n - 1) {
      events.push({ startTime: tgt[i].time, triggerReturn: r, path: buildPath(i) });
    }
  }

  // 無条件(全起点)平均パス＝比較基準
  const baselineMean: number[] = new Array(horizon + 1).fill(0);
  let baseCount = 0;
  for (let i = 1; i + horizon <= n - 1; i++) {
    const base = tgt[i].close;
    for (let k = 0; k <= horizon; k++) baselineMean[k] += Math.log(tgt[i + k].close / base);
    baseCount++;
  }
  if (baseCount > 0) for (let k = 0; k <= horizon; k++) baselineMean[k] /= baseCount;

  if (events.length === 0) {
    return { ...empty, baselineMean, nTrigger };
  }

  // k ごとの統計
  const meanPath: number[] = [];
  const medianPath: number[] = [];
  const p25Path: number[] = [];
  const p75Path: number[] = [];
  const perK: HorizonStat[] = [];
  for (let k = 0; k <= horizon; k++) {
    const vals = events.map(e => e.path[k]);
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, v) => a + (v - m) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance);
    const sorted = [...vals].sort((a, b) => a - b);
    const med = quantile(sorted, 0.5);
    const win = vals.filter(v => v > 0).length / vals.length;
    meanPath.push(m);
    medianPath.push(med);
    p25Path.push(quantile(sorted, 0.25));
    p75Path.push(quantile(sorted, 0.75));
    perK.push({ k, mean: m, median: med, std, winRate: win, n: vals.length });
  }

  return {
    events, horizon, meanPath, medianPath, p25Path, p75Path,
    baselineMean, perK, nTrigger, nUsable: events.length,
  };
}
