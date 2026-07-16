// 「当日の実測パス」 vs 「寄り前に確定している条件で作った期待パス」の突き合わせ。
//
// 曜日と前夜米国リターンは寄り付き前に確定しているため、その条件で束ねた過去の日内累積パスは
// 「今日の台本」として先読みバイアスなしに引ける。本モジュールはその台本と実際の値動きを比べ、
// 3層で評価する。
//   ① 較正した重ね      : 条件セルの分位ファン(10/25/50/75/90)に実測を重ね、各時刻の z とパーセンタイル
//   ② 乖離 → 残余の回帰 : 時刻tでの乖離 z(t) から t→引けの残余リターンを説明できるか(継続かフェードか)
//   ③ 追随度の分布      : そもそも条件付き平均パスが個別日をどれだけ説明するか
//
// 統計上の要点:
//   - 対象日は期待パスの標本から必ず除外する(自分を含む平均に自分を比べない)。
//   - ②③の過去日の z は leave-one-out(自分を抜いた平均・SDで標準化)で作り、
//     標本外である今日の z と同じ土俵に揃える。
//   - priorOnly=true なら対象日より前の日だけで推定する(過去日を対象にしたときの先読み排除)。

import { DayData, BinGrid, localMinute, binIndexOfMinute } from "./intraday-core";
import {
  AlignedDay, UsReturn, dayCumPath, assignBins, binEdges, binMeta, binOfValue,
  BinScheme, BinMeta, ols, studentTwoSidedP, bootBetaCI, pearson,
} from "./us-spillover-core";
import { UsBinMode } from "./us-spillover-path";
import { mean, std, quantileSorted, benjaminiHochberg } from "./stats-significance";

// ───────────────────────── 条件の指定 ─────────────────────────

// 期待パスを作るときにどの条件で過去日を束ねるか。標本が薄いときは緩める。
export type CondMode = "both" | "us" | "weekday" | "none";

export const COND_MODES: { value: CondMode; label: string; note: string }[] = [
  { value: "both", label: "曜日×米国", note: "対象日と同じ曜日かつ同じ前夜米国ビンの日だけ（最も条件が濃いが標本は最も薄い）" },
  { value: "us", label: "米国のみ", note: "前夜米国ビンだけ一致（曜日は問わない）" },
  { value: "weekday", label: "曜日のみ", note: "曜日だけ一致（前夜米国は問わない）" },
  { value: "none", label: "無条件", note: "全立会日。条件付けの効果を測る基準線" },
];

export const WD_LABELS: Record<number, string> = {
  0: "日曜", 1: "月曜", 2: "火曜", 3: "水曜", 4: "木曜", 5: "金曜", 6: "土曜",
};

// ───────────────────────── 前夜米国のビン化 ─────────────────────────

export interface BinInfo {
  bin: number;
  label: string;
  color: string;
  n: number;
  rangeLo: number | null; // このビンの前夜米国リターン下限(nullは-∞側)
  rangeHi: number | null;
}

export interface UsBinning {
  rows: AlignedDay[]; // 前夜米国が有効な整合日(日付昇順)
  binIdx: number[]; // rows と同順のビン番号
  meta: BinMeta;
  binInfos: BinInfo[];
  latestUs: { usDate: string; value: number; bin: number; unpaired: boolean }; // 現時点で確定している最新の米国セッション
}

// 整合日を前夜米国リターンでビン化し、各ビンのメタと「最新のNYがどのビンか」を返す。
// 未ペアの最新米国終値(=寄り前の“ゆうべのNY”)も latestUs の判定に採用する。
export function buildUsBinning(
  aligned: AlignedDay[], us: UsReturn[], usMode: UsBinMode, scheme: BinScheme
): UsBinning | null {
  const usVal = (a: AlignedDay) => (usMode === "intra" ? a.us.intra : a.us.ret);
  const rows = aligned.filter((a) => isFinite(usVal(a)) && usVal(a) !== 0);
  if (rows.length < 8) return null;

  const vals = rows.map(usVal);
  const binIdx = assignBins(vals, scheme);
  const edges = binEdges(vals, scheme);
  const meta = binMeta(scheme);
  const binInfos: BinInfo[] = meta.labels.map((label, b) => ({
    bin: b, label, color: meta.colors[b],
    n: binIdx.filter((x) => x === b).length,
    rangeLo: b === 0 ? null : edges[b - 1],
    rangeHi: b === meta.count - 1 ? null : edges[b],
  }));

  const usValOf = (u: UsReturn) => (usMode === "intra" ? u.intra : u.ret);
  const last = rows[rows.length - 1];
  let tDate = last.us.date, tv = usVal(last);
  for (let i = us.length - 1; i >= 0; i--) {
    const v = usValOf(us[i]);
    if (isFinite(v) && v !== 0) { tDate = us[i].date; tv = v; break; } // us は日付昇順 → 末尾が最新
  }
  const latestUs = {
    usDate: tDate, value: tv, bin: binOfValue(tv, scheme, edges),
    unpaired: tDate > last.us.date, // 最後にペア成立した米国日より新しい = まだ寄っていない
  };

  return { rows, binIdx, meta, binInfos, latestUs };
}

// ───────────────────────── 結果の型 ─────────────────────────

// 条件セルの各時刻における実測分布(=期待パスの帯)。
export interface FanBin {
  mean: number;
  med: number;
  sd: number;
  q10: number;
  q25: number;
  q75: number;
  q90: number;
}

// 対象日の各時刻の実測と、その較正済みの位置。
export interface TodayBin {
  actual: number; // 寄り基準の累積対数リターン
  z: number; // (実測 − 条件付き平均) / 条件付きSD
  pctile: number; // 条件セル分布内での順位 0..1
  valid: boolean; // その時刻まで実測が到達しているか(場中なら後半は false)
}

// 時刻gでの乖離 z(g) → 残余リターン(g→引け) の回帰。
export interface BetaBin {
  n: number;
  ok: boolean; // 回帰が成立したか(標本不足なら false)
  beta: number; // 残余 = alpha + beta·z
  alpha: number;
  r2: number;
  p: number; // β=0 の両側p値
  pAdj: number; // 時間ビン横断のFDR補正後p値
  bootLo: number; // βの95%ブートCI
  bootHi: number;
  stable: number; // 再標本で符号が一致した割合
  predicted: number | null; // 対象日の z を入れた残余の予測値
  predLo: number | null; // 95%予測区間
  predHi: number | null;
}

// 個別日が条件付き平均パスをどれだけなぞったか(leave-one-out)。
export interface TrackRow {
  date: string;
  corr: number; // その日のパスと LOO平均パスの相関(形の一致)
  slope: number; // パス = a + b·LOO平均パス の b(1超=台本より大きく動いた)
  endSign: boolean; // 終端の符号が LOO平均と一致したか
}

export interface TodayVsExpectedResult {
  timeLabels: string[];
  targetDate: string;
  targetWeekday: number;
  targetBin: number;
  n: number; // 条件セルの標本日数(対象日を除く)
  lastIdx: number; // 実測が到達している最終時間ビン(-1=なし)
  inSession: boolean; // 場中(引けまで到達していない)か
  maxAbs: number; // 縦軸スケール
  fan: FanBin[];
  today: TodayBin[];
  betas: BetaBin[];
  zMat: number[][]; // 過去日 × 時間ビン の LOO標準化乖離(散布図用)
  resMat: number[][]; // 過去日 × 時間ビン の残余リターン(g→引け)
  sampleDates: string[]; // zMat/resMat と同順
  track: TrackRow[];
  trackToday: number | null; // 対象日の途中経過と条件付き平均パスの相関
  endMean: number; // 条件セルの寄り→引け平均
  endMed: number;
}

// ───────────────────────── 補助 ─────────────────────────

// 実測バーが存在する最終の時間ビン。dayBinCloses は空ビンを直前値で前方補完するため、
// 場中の当日をそのまま描くと「後場はずっと横ばい」の偽の平坦線になる。ここで打ち切り点を得る。
export function lastBarBin(day: DayData, grid: BinGrid, gmtoffset: number): number {
  let last = -1;
  for (const b of day.bars) {
    const bi = binIndexOfMinute(localMinute(b.ts, gmtoffset), grid);
    if (bi > last) last = bi;
  }
  return last;
}

// studentTwoSidedP(t, df) = alpha を満たす臨界値 t を二分法で求める(両側)。
// 予測区間に使う。標本が薄い(n=10 → t≈2.26)ため正規近似1.96では区間が狭すぎる。
function tCrit(df: number, alpha = 0.05): number {
  if (df <= 0) return NaN;
  let lo = 0, hi = 200;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (studentTwoSidedP(mid, df) > alpha) lo = mid; // p は t の減少関数
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ───────────────────────── 本体 ─────────────────────────

export function computeTodayVsExpected(
  binning: UsBinning,
  grid: BinGrid | null,
  gmtoffset: number,
  opts: { condMode: CondMode; targetDate: string | null; priorOnly: boolean }
): TodayVsExpectedResult | null {
  if (!grid) return null;
  const G = grid.bins.length;
  if (G < 2) return null;
  const { rows, binIdx } = binning;
  if (rows.length < 6) return null;

  // 対象日: 指定が無ければ最新の立会日。
  const tIdx = opts.targetDate
    ? rows.findIndex((a) => a.jp.date === opts.targetDate)
    : rows.length - 1;
  if (tIdx < 0) return null;
  const target = rows[tIdx];
  const targetBin = binIdx[tIdx];
  const targetWd = target.jp.weekday;

  // 条件セル。対象日自身は常に除外。priorOnly なら対象日より後の日も使わない。
  const sample: AlignedDay[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (i === tIdx) continue;
    if (opts.priorOnly && i > tIdx) continue;
    const okUs = opts.condMode === "both" || opts.condMode === "us" ? binIdx[i] === targetBin : true;
    const okWd = opts.condMode === "both" || opts.condMode === "weekday" ? rows[i].jp.weekday === targetWd : true;
    if (okUs && okWd) sample.push(rows[i]);
  }
  const n = sample.length;
  if (n < 3) return null;

  const paths = sample.map((a) => dayCumPath(a.jp, grid, gmtoffset)); // n × G
  const targetPath = dayCumPath(target.jp, grid, gmtoffset);
  const lastIdx = lastBarBin(target.jp, grid, gmtoffset);

  // ① 分位ファン
  const fan: FanBin[] = [];
  let maxAbs = 1e-6;
  const colSum = new Array(G).fill(0);
  const colSumSq = new Array(G).fill(0);
  for (let g = 0; g < G; g++) {
    const col = paths.map((p) => p[g]);
    for (const v of col) { colSum[g] += v; colSumSq[g] += v * v; }
    const s = [...col].sort((a, b) => a - b);
    const f: FanBin = {
      mean: mean(col), med: quantileSorted(s, 0.5), sd: std(col),
      q10: quantileSorted(s, 0.1), q25: quantileSorted(s, 0.25),
      q75: quantileSorted(s, 0.75), q90: quantileSorted(s, 0.9),
    };
    fan.push(f);
    maxAbs = Math.max(maxAbs, Math.abs(f.q10), Math.abs(f.q90));
  }
  // 実測が帯の外に出ても切れないよう、到達済み区間はスケールに含める。
  for (let g = 0; g <= lastIdx && g < G; g++) maxAbs = Math.max(maxAbs, Math.abs(targetPath[g]));

  // 対象日の各時刻の較正済み位置。今日は標本外なので全標本の平均・SDで標準化してよい。
  const today: TodayBin[] = [];
  for (let g = 0; g < G; g++) {
    const actual = targetPath[g];
    const below = paths.reduce((acc, p) => acc + (p[g] <= actual ? 1 : 0), 0);
    today.push({
      actual,
      z: fan[g].sd > 0 ? (actual - fan[g].mean) / fan[g].sd : 0,
      pctile: below / n,
      valid: g <= lastIdx,
    });
  }

  // ② 過去日の乖離を leave-one-out で標準化 → 残余リターンへ回帰
  const zMat: number[][] = paths.map(() => new Array(G).fill(0));
  const resMat: number[][] = paths.map(() => new Array(G).fill(0));
  for (let d = 0; d < n; d++) {
    for (let g = 0; g < G; g++) {
      const x = paths[d][g];
      const mLoo = (colSum[g] - x) / (n - 1);
      // Σ_{-d}(x−m)² = Σ_{-d}x² − (n−1)·m² を n−2 で割る(自分を抜いた不偏分散)
      const varLoo = n > 2 ? Math.max(0, (colSumSq[g] - x * x - (n - 1) * mLoo * mLoo) / (n - 2)) : 0;
      const sdLoo = Math.sqrt(varLoo);
      zMat[d][g] = sdLoo > 0 ? (x - mLoo) / sdLoo : 0;
      resMat[d][g] = paths[d][G - 1] - x; // g→引けの残余
    }
  }

  const betas: BetaBin[] = [];
  const pIdx: number[] = []; // FDR補正の対象になった betas のインデックス
  const pRaw: number[] = [];
  for (let g = 0; g < G; g++) {
    const x = zMat.map((r) => r[g]);
    const y = resMat.map((r) => r[g]);
    // 最終ビンは残余が定義上ゼロなので回帰しない。
    const r = g < G - 1 ? ols(x, y) : null;
    if (!r) {
      betas.push({
        n, ok: false, beta: NaN, alpha: NaN, r2: NaN, p: 1, pAdj: 1,
        bootLo: NaN, bootHi: NaN, stable: 0.5, predicted: null, predLo: null, predHi: null,
      });
      continue;
    }
    const boot = bootBetaCI(x, y);

    // 対象日の z を入れた残余の予測(平均への回帰ではなく個別日の予測なので予測区間を使う)
    let predicted: number | null = null, predLo: number | null = null, predHi: number | null = null;
    if (today[g].valid) {
      const x0 = today[g].z;
      let sxx = 0, sse = 0;
      for (let i = 0; i < n; i++) {
        sxx += (x[i] - r.meanX) ** 2;
        sse += (y[i] - (r.alpha + r.beta * x[i])) ** 2;
      }
      const dof = n - 2;
      if (dof > 0 && sxx > 0) {
        const sigma = Math.sqrt(sse / dof);
        const sePred = sigma * Math.sqrt(1 + 1 / n + (x0 - r.meanX) ** 2 / sxx);
        const tc = tCrit(dof);
        predicted = r.alpha + r.beta * x0;
        predLo = predicted - tc * sePred;
        predHi = predicted + tc * sePred;
      }
    }

    pIdx.push(betas.length);
    pRaw.push(r.pBeta);
    betas.push({
      n, ok: true, beta: r.beta, alpha: r.alpha, r2: r.r2, p: r.pBeta, pAdj: 1,
      bootLo: boot.lo, bootHi: boot.hi, stable: boot.stable, predicted, predLo, predHi,
    });
  }
  // 時間ビンを総当たりで検定しているので、FDRで補正してから読む。
  const adj = benjaminiHochberg(pRaw);
  pIdx.forEach((bi, k) => { betas[bi].pAdj = adj[k]; });

  // ③ 追随度: 各日のパス vs 自分を抜いた平均パス
  const track: TrackRow[] = [];
  if (G >= 3 && n >= 3) {
    for (let d = 0; d < n; d++) {
      const looMean = new Array(G);
      for (let g = 0; g < G; g++) looMean[g] = (colSum[g] - paths[d][g]) / (n - 1);
      const rg = ols(looMean, paths[d]);
      track.push({
        date: sample[d].jp.date,
        corr: pearson(paths[d], looMean),
        slope: rg ? rg.beta : NaN,
        endSign: (paths[d][G - 1] >= 0) === (looMean[G - 1] >= 0),
      });
    }
  }
  // 対象日の途中経過が台本をなぞれているか(到達済みの区間だけで相関)。
  const trackToday = lastIdx >= 2
    ? pearson(targetPath.slice(0, lastIdx + 1), fan.slice(0, lastIdx + 1).map((f) => f.mean))
    : null;

  return {
    timeLabels: grid.bins.map((b) => b.label),
    targetDate: target.jp.date,
    targetWeekday: targetWd,
    targetBin,
    n,
    lastIdx,
    inSession: lastIdx >= 0 && lastIdx < G - 1,
    maxAbs,
    fan,
    today,
    betas,
    zMat,
    resMat,
    sampleDates: sample.map((a) => a.jp.date),
    track,
    trackToday,
    endMean: fan[G - 1].mean,
    endMed: fan[G - 1].med,
  };
}
