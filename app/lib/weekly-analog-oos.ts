// 今週の軌跡アナログの「予測力」を測るウォークフォワード OOS 検証(改善 A3)。
//
// アナログ予測が「過去の記述」ではなく本当に先読みに使えるかを、各週末で厳密に
// out-of-sample に検証する:
//   各検証週末 t について、t 以前のデータだけでアナログを構築し(候補窓のフォワードも
//   t を超えないので未来リークなし)、予測 ŷ_t = 選抜のフォワード中央値を得る。実測
//   y_t = 実際の H 日先リターン。両者の関係を IC(情報係数)・方向的中率・分位単調性で測る。
//
// 多重比較の罠(設定を総当たりして IC 最良を選ぶと過学習)に対しては、試行数=設定
// カタログ数で IC 閾値を膨らませる(Deflated Sharpe と同発想の縮小)を用いる。
//
// 予測器は computeWeeklyAnalog(lean=true) を prices.slice(0, t+1) に適用して共有する。
//
// ── 改善A: 経路レベルの採点 ──
// 上の IC / 方向的中率は「H日後の終値」1点だけの採点である。しかしアナログ予測が
// 出力しているのは経路(中央値パス・25–75%帯・高安到達 MFE/MAE)であり、
// 「途中で−4%まで沈んでから+1%で終わった週」と「一直線に+1%の週」を終点採点は
// 区別できない。ストップ幅・利確目標・建玉の持ち堪えは終点でなく経路で決まるので、
// 経路そのものを次の3軸で採点する(computeOosPathScore):
//   ① 帯の較正: 実測終値が予測 P25–P75 に入った割合(名目50%)。帯幅も併記——
//      帯を広げれば被覆率は簡単に上がるので、幅とセットでしか意味を持たない。
//   ② 高安の当否: 予測 MFE/MAE と実測の Spearman、到達率(較正されていれば≒50%)、
//      バイアス(実測−予測の中央値)。利確/損切り水準として使えるかを直接測る。
//   ③ 形の一致: 日次増分の相関と、z化パス間の DTW 距離。いずれも
//      「予測を別の週の実測に付け替える」巡回シフト・ヌルと比較する。中央値パスは
//      平滑化された対象なので生の相関値は小さくなりがちで、絶対値でなくヌルとの差で判断する。

import { PricePoint } from "./types";
import { UsReturn, BinScheme } from "./us-spillover-core";
import {
  computeWeeklyAnalog, AnalogMode, DistMetric, WindowAlign, WeightMode,
  buildForward, zShape, dtw,
} from "./weekly-analog";
import { quantileSorted, median as medianOf } from "./stats-significance";

// ───────────────────────── 数値ユーティリティ ─────────────────────────

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// 順位づけ(同順位は平均順位)。Spearman 相関に使う。
function ranks(arr: number[]): number[] {
  const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array<number>(arr.length);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1].v === idx[k].v) j++;
    const avg = (k + j) / 2 + 1; // 1-based 平均順位
    for (let m = k; m <= j; m++) r[idx[m].i] = avg;
    k = j + 1;
  }
  return r;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  const d = Math.sqrt(va * vb);
  return d > 0 ? cov / d : 0;
}

export function spearman(a: number[], b: number[]): number {
  return pearson(ranks(a), ranks(b));
}

// 標準正規分位点(Acklam 近似)。試行数補正に使う。
function invNormalCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425, ph = 1 - pl;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= ph) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function weekKey(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateStr;
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return d.toISOString().slice(0, 10);
}

// ───────────────────────── 型 ─────────────────────────

export interface OosSetting {
  mode: AnalogMode;
  metric: DistMetric;
  align: WindowAlign;
  L: number;
  K: number;
  weight: WeightMode;
  volNorm: boolean;
}

export interface OosPredPoint {
  date: string;
  yhat: number; yact: number;
  // 改善A: 経路採点用。長さ H+1（[0]=0 を含む）。設定によっては欠けうるので optional。
  pathHat?: number[];  // 予測: 選抜のフォワード終値中央値パス
  p25?: number[]; p75?: number[]; // 予測: 25–75% 帯
  hiHat?: number; loHat?: number; // 予測: H日以内の高値到達中央(MFE)/安値到達中央(MAE)
  pathAct?: number[];  // 実測: 実際に辿った終値累積パス
  hiAct?: number; loAct?: number; // 実測: H日以内の高値到達/安値到達
}

// 改善A: 経路そのものの採点。終点1点でなく「その後どういう経路を辿ったか」を照合する。
export interface OosPathScore {
  n: number;          // 経路を採点できた週数
  H: number;
  // ① 帯の較正
  coverage: number;   // 実測終値が予測 P25–P75 に入った (週×日) の割合
  coverageLo: number; coverageHi: number; // 週ブロック・ブートストラップ95%CI
  coverageNominal: number; // 名目 0.5
  bandWidth: number;  // 平均バンド幅(リターン単位)。被覆率の「安さ」を判定する分母
  coverageByDay: number[]; // 先行き m 日目ごとの被覆率(長さ H+1, [0]は未使用で NaN)
  bandWidthByDay: number[]; // 同じく m 日目の平均バンド幅
  // ② 高安(MFE/MAE)の当否
  mfeIC: number; maeIC: number;       // 予測と実測の Spearman
  mfeTouch: number; maeTouch: number; // 実測が予測水準に到達した割合(較正なら≒0.5)
  mfeBias: number; maeBias: number;   // 実測−予測 の中央値(MFE正=予測が控えめ)
  // ③ 形の一致(ヌル比較)
  shapeCorr: number;     // 日次増分 Pearson の Fisher-z 平均
  shapeCorrNull: number; // 巡回シフト・ヌルの平均
  shapeCorrP: number;
  dtwDist: number;       // z化パス間 DTW 距離の平均(小さいほど形が近い)
  dtwNull: number;
  dtwP: number;
  shapeOk: boolean;      // H>=3 で形の指標が計算できたか
}

export interface OosQuintile { yhatMean: number; yactMean: number; n: number; }

export interface OosResult {
  points: OosPredPoint[];
  ic: number;        // Spearman(ŷ, y)
  icLo: number; icHi: number; // ブロック・ブートストラップ95%CI
  n: number;         // 予測できた週数
  nEff: number;      // フォワード重複を畳んだ実効週数 ≈ n/ceil(H/5)
  hit: number;       // 方向的中率 P(sign(ŷ)=sign(y))
  baseHit: number;   // 無条件の多数派方向を当て続けた場合の的中率
  quintiles: OosQuintile[]; // ŷ 五分位ごとの実測平均
  monotone: number;  // 分位index と実測平均の Spearman(単調性, 1に近いほど良)
  H: number;
  path: OosPathScore | null; // 改善A: 経路レベルの採点(経路が揃わなければ null)
}

export interface OosCatalogRow { setting: OosSetting; label: string; ic: number; n: number; }

export interface OosCatalog {
  rows: OosCatalogRow[]; // IC 降順
  nTrials: number;
  bestIc: number;
  deflatedThreshold: number; // 試行数補正後の IC 有意閾値(片側5%相当)
  bestPasses: boolean;       // 最良設定が補正閾値を超えるか
  pbo: number;               // 過学習確率(IS最良がOOS中央値を下回る割合の簡易推定)
}

// ───────────────────────── 予測系列の生成 ─────────────────────────

// 検証区間の各週末で ŷ_t / y_t を生成する。maxWeeks で直近側に上限。
function predictSeries(
  prices: PricePoint[], us: UsReturn[], s: OosSetting,
  scheme: BinScheme, H: number, maxWeeks: number
): OosPredPoint[] {
  const n = prices.length;
  // 週末インデックス(その週の最終立会日)
  const weekEnds: number[] = [];
  for (let i = 0; i < n - 1; i++) if (weekKey(prices[i].time) !== weekKey(prices[i + 1].time)) weekEnds.push(i);
  // 実測が取れる(t+H<=n-1)週末に限定し、直近 maxWeeks 個
  const usable = weekEnds.filter((t) => t + H <= n - 1);
  const pick = usable.slice(-maxWeeks);
  const pts: OosPredPoint[] = [];
  for (const t of pick) {
    const sub = prices.slice(0, t + 1);
    const res = computeWeeklyAnalog({
      prices: sub, us, L: s.L, H, K: s.K, mode: s.mode, usMode: "ret", scheme,
      metric: s.metric, align: s.align, weight: s.weight, volNorm: s.volNorm,
      selBinOverride: null, lean: true,
    });
    if (!res || !isFinite(res.medianFinal)) continue;
    const yhat = res.medianFinal;
    const baseC = prices[t].close, futC = prices[t + H].close;
    if (!(baseC > 0) || !(futC > 0)) continue;
    const yact = futC / baseC - 1;
    // 改善A: 実測経路。候補窓と同じ規約(buildForward)で作るので予測と直接比較できる。
    const act = buildForward(prices, t, H);
    pts.push({
      date: prices[t].time, yhat, yact,
      pathHat: res.fwdMedian, p25: res.fwdP25, p75: res.fwdP75,
      hiHat: res.medianMfe, loHat: res.medianMae,
      pathAct: act ? act.forward : undefined,
      hiAct: act ? act.fwdHigh[H] : undefined,
      loAct: act ? act.fwdLow[H] : undefined,
    });
  }
  return pts;
}

// ───────────────────────── 改善A: 経路レベルの採点 ─────────────────────────

// パスを日次増分に直す(長さ H)。水準でなく「日々どちらへ動いたか」の形を比べる。
function increments(path: number[]): number[] {
  const out: number[] = [];
  for (let m = 1; m < path.length; m++) out.push(path[m] - path[m - 1]);
  return out;
}

// Fisher z 変換の平均(相関の平均は単純平均だと歪むため)。
function meanFisher(rs: number[]): number {
  const zs = rs.filter((r) => isFinite(r)).map((r) => Math.atanh(Math.max(-0.999, Math.min(0.999, r))));
  if (zs.length === 0) return NaN;
  return Math.tanh(zs.reduce((s, v) => s + v, 0) / zs.length);
}

// 巡回シフト・ヌルの片側 p 値。予測パスを s 週ぶんずらして別の週の実測に付け替え、
// 各系列の内部構造(自己相関・フォワード重複)は保ったまま「予測と実測の対応」だけを壊す。
// greater=true なら「観測が大きいほど良い」指標(相関)、false なら小さいほど良い指標(DTW距離)。
function shiftPValue(
  n: number, B: number, seed: number, stat: (shift: number) => number, greater: boolean
): { obs: number; nullMean: number; p: number } {
  const obs = stat(0);
  if (!isFinite(obs) || n < 5) return { obs, nullMean: NaN, p: 1 };
  const rng = mulberry32(seed);
  const vals: number[] = [];
  for (let b = 0; b < B; b++) {
    const s = 1 + Math.floor(rng() * (n - 1));
    const v = stat(s);
    if (isFinite(v)) vals.push(v);
  }
  if (vals.length < 10) return { obs, nullMean: NaN, p: 1 };
  const nullMean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const ge = vals.filter((v) => (greater ? v >= obs - 1e-15 : v <= obs + 1e-15)).length;
  return { obs, nullMean, p: (ge + 1) / (vals.length + 1) };
}

export function computeOosPathScore(points: OosPredPoint[], H: number, seed = 0x9a7401): OosPathScore | null {
  // 経路が揃っている週だけを採点対象にする
  const ps = points.filter((p) =>
    p.pathHat && p.p25 && p.p75 && p.pathAct &&
    p.pathHat.length === H + 1 && p.pathAct.length === H + 1 &&
    p.p25.length === H + 1 && p.p75.length === H + 1
  );
  const n = ps.length;
  if (n < 8 || H < 1) return null;

  // ── ① 帯の較正: 実測終値が予測 P25–P75 に入ったか(m=1..H, m=0 は定義上必ず0で自明) ──
  const weekCov: number[] = [];
  let widthSum = 0, widthCnt = 0;
  const dayHit = new Array<number>(H + 1).fill(0);
  const dayTot = new Array<number>(H + 1).fill(0);
  const dayWidth = new Array<number>(H + 1).fill(0);
  for (const p of ps) {
    let hit = 0, tot = 0;
    for (let m = 1; m <= H; m++) {
      const lo = p.p25![m], hi = p.p75![m], a = p.pathAct![m];
      if (!isFinite(lo) || !isFinite(hi) || !isFinite(a)) continue;
      const inside = a >= Math.min(lo, hi) && a <= Math.max(lo, hi);
      if (inside) { hit++; dayHit[m]++; }
      tot++; dayTot[m]++;
      const w = Math.abs(hi - lo);
      widthSum += w; widthCnt++; dayWidth[m] += w;
    }
    if (tot > 0) weekCov.push(hit / tot);
  }
  const coverage = weekCov.length ? weekCov.reduce((s, v) => s + v, 0) / weekCov.length : NaN;
  const bandWidth = widthCnt ? widthSum / widthCnt : NaN;
  const coverageByDay = dayTot.map((t, m) => (m === 0 || t === 0 ? NaN : dayHit[m] / t));
  const bandWidthByDay = dayTot.map((t, m) => (m === 0 || t === 0 ? NaN : dayWidth[m] / t));

  // 週ブロック・ブートストラップ(ブロック長 ≈ フォワードが重複する週数)
  let coverageLo = coverage, coverageHi = coverage;
  if (weekCov.length >= 10) {
    const bl = Math.max(1, Math.ceil(Math.max(1, H) / 5));
    const nb = Math.ceil(weekCov.length / bl);
    const rng = mulberry32(seed ^ 0x11);
    const samp: number[] = [];
    for (let b = 0; b < 600; b++) {
      const acc: number[] = [];
      for (let k = 0; k < nb && acc.length < weekCov.length; k++) {
        const start = Math.floor(rng() * weekCov.length);
        for (let j = 0; j < bl && acc.length < weekCov.length; j++) acc.push(weekCov[(start + j) % weekCov.length]);
      }
      samp.push(acc.reduce((s, v) => s + v, 0) / acc.length);
    }
    samp.sort((a, b) => a - b);
    coverageLo = quantileSorted(samp, 0.025); coverageHi = quantileSorted(samp, 0.975);
  }

  // ── ② 高安(MFE/MAE)の当否 ──
  const hiPairs = ps.filter((p) => isFinite(p.hiHat!) && isFinite(p.hiAct!));
  const loPairs = ps.filter((p) => isFinite(p.loHat!) && isFinite(p.loAct!));
  const mfeIC = hiPairs.length >= 5 ? spearman(hiPairs.map((p) => p.hiHat!), hiPairs.map((p) => p.hiAct!)) : NaN;
  const maeIC = loPairs.length >= 5 ? spearman(loPairs.map((p) => p.loHat!), loPairs.map((p) => p.loAct!)) : NaN;
  // 到達率: 実測が予測水準に届いたか。中央値予測が較正されていれば ≒0.5。
  const mfeTouch = hiPairs.length ? hiPairs.filter((p) => p.hiAct! >= p.hiHat!).length / hiPairs.length : NaN;
  const maeTouch = loPairs.length ? loPairs.filter((p) => p.loAct! <= p.loHat!).length / loPairs.length : NaN;
  const mfeBias = hiPairs.length ? medianOf(hiPairs.map((p) => p.hiAct! - p.hiHat!)) : NaN;
  const maeBias = loPairs.length ? medianOf(loPairs.map((p) => p.loAct! - p.loHat!)) : NaN;

  // ── ③ 形の一致(巡回シフト・ヌルと比較) ──
  const shapeOk = H >= 3;
  let shapeCorr = NaN, shapeCorrNull = NaN, shapeCorrP = 1;
  let dtwDist = NaN, dtwNull = NaN, dtwP = 1;
  if (shapeOk) {
    const incHat = ps.map((p) => increments(p.pathHat!));
    const incAct = ps.map((p) => increments(p.pathAct!));
    const zHat = ps.map((p) => zShape(p.pathHat!));
    const zAct = ps.map((p) => zShape(p.pathAct!));

    const corrStat = (shift: number): number => {
      const rs: number[] = [];
      for (let i = 0; i < n; i++) rs.push(pearson(incHat[(i + shift) % n], incAct[i]));
      return meanFisher(rs);
    };
    const dtwStat = (shift: number): number => {
      let s = 0, c = 0;
      for (let i = 0; i < n; i++) {
        const d = dtw(zHat[(i + shift) % n], zAct[i], H + 1);
        if (isFinite(d)) { s += d; c++; }
      }
      return c ? s / c : NaN;
    };
    const rc = shiftPValue(n, 400, seed ^ 0x22, corrStat, true);   // 相関は大きいほど良い
    shapeCorr = rc.obs; shapeCorrNull = rc.nullMean; shapeCorrP = rc.p;
    const rd = shiftPValue(n, 200, seed ^ 0x33, dtwStat, false);   // DTW 距離は小さいほど良い
    dtwDist = rd.obs; dtwNull = rd.nullMean; dtwP = rd.p;
  }

  return {
    n, H,
    coverage, coverageLo, coverageHi, coverageNominal: 0.5, bandWidth,
    coverageByDay, bandWidthByDay,
    mfeIC, maeIC, mfeTouch, maeTouch, mfeBias, maeBias,
    shapeCorr, shapeCorrNull, shapeCorrP, dtwDist, dtwNull, dtwP, shapeOk,
  };
}

function metricsFromPoints(points: OosPredPoint[], H: number): OosResult {
  const yhat = points.map((p) => p.yhat), yact = points.map((p) => p.yact);
  const n = points.length;
  const ic = spearman(yhat, yact);

  // 方向的中率と無条件ベースライン
  let hitCnt = 0, up = 0;
  for (const p of points) { if (Math.sign(p.yhat) === Math.sign(p.yact) && p.yhat !== 0) hitCnt++; if (p.yact > 0) up++; }
  const hit = n ? hitCnt / n : 0;
  const baseRate = n ? up / n : 0.5;
  const baseHit = Math.max(baseRate, 1 - baseRate);

  // 五分位バケット
  const order = points.map((_, i) => i).sort((a, b) => yhat[a] - yhat[b]);
  const quintiles: OosQuintile[] = [];
  const bucketMeans: number[] = [];
  for (let q = 0; q < 5; q++) {
    const lo = Math.floor((q * n) / 5), hi = Math.floor(((q + 1) * n) / 5);
    const seg = order.slice(lo, hi);
    if (seg.length === 0) { quintiles.push({ yhatMean: NaN, yactMean: NaN, n: 0 }); bucketMeans.push(NaN); continue; }
    const yh = seg.reduce((s, i) => s + yhat[i], 0) / seg.length;
    const ya = seg.reduce((s, i) => s + yact[i], 0) / seg.length;
    quintiles.push({ yhatMean: yh, yactMean: ya, n: seg.length });
    bucketMeans.push(ya);
  }
  const validBuckets = bucketMeans.map((v, i) => ({ v, i })).filter((o) => isFinite(o.v));
  const monotone = validBuckets.length >= 3
    ? spearman(validBuckets.map((o) => o.i), validBuckets.map((o) => o.v)) : 0;

  // ブロック・ブートストラップで IC の95%CI(週の系列相関に頑健)
  const nEff = Math.max(1, Math.round(n / Math.ceil(Math.max(1, H) / 5)));
  let icLo = ic, icHi = ic;
  if (n >= 10) {
    const rng = mulberry32(0x1c9a10);
    const bl = Math.max(1, Math.ceil(Math.max(1, H) / 5)); // ブロック長 ≈ フォワード重複週数
    const nBlocks = Math.ceil(n / bl);
    const samp: number[] = [];
    for (let b = 0; b < 600; b++) {
      const rh: number[] = [], ra: number[] = [];
      for (let k = 0; k < nBlocks && rh.length < n; k++) {
        const start = Math.floor(rng() * n);
        for (let j = 0; j < bl && rh.length < n; j++) { const idx = (start + j) % n; rh.push(yhat[idx]); ra.push(yact[idx]); }
      }
      samp.push(spearman(rh, ra));
    }
    samp.sort((a, b) => a - b);
    icLo = quantileSorted(samp, 0.025); icHi = quantileSorted(samp, 0.975);
  }

  const path = computeOosPathScore(points, H);

  return { points, ic, icLo, icHi, n, nEff, hit, baseHit, quintiles, monotone, H, path };
}

// 単一設定の OOS 検証。
export interface RunOosParams {
  prices: PricePoint[];
  us: UsReturn[];
  usTicker: string;
  setting: OosSetting;
  scheme: BinScheme;
  H: number;
  maxWeeks?: number;
}

export function runWeeklyAnalogOos(p: RunOosParams): OosResult | null {
  const points = predictSeries(p.prices, p.us, p.setting, p.scheme, p.H, p.maxWeeks ?? 130);
  if (points.length < 8) return null;
  return metricsFromPoints(points, p.H);
}

// ───────────────────────── 設定カタログ・スキャン(多重比較補正) ─────────────────────────

function settingLabel(s: OosSetting): string {
  const modeL = s.mode === "similar" ? "似た形" : s.mode === "usbin" ? "米国ビン" : "アンサンブル";
  return `${modeL}/${s.metric === "dtw" ? "DTW" : "ユークリッド"}/${s.align === "week" ? "週境界" : `直近${s.L}`}${s.weight === "kernel" ? "/カーネル" : ""}${s.volNorm ? "/σ" : ""}`;
}

// カタログ(バランス重視で12通り前後)。総当たりで IC を並べ、試行数で有意閾値を膨らませる。
export function defaultCatalog(baseK: number): OosSetting[] {
  const out: OosSetting[] = [];
  const modes: AnalogMode[] = ["similar", "usbin", "ensemble"];
  const metrics: DistMetric[] = ["euclid", "dtw"];
  const aligns: WindowAlign[] = ["trailing", "week"];
  for (const mode of modes) for (const metric of metrics) for (const align of aligns) {
    out.push({ mode, metric, align, L: 5, K: baseK, weight: "uniform", volNorm: false });
  }
  return out;
}

export interface RunCatalogParams {
  prices: PricePoint[];
  us: UsReturn[];
  usTicker: string;
  scheme: BinScheme;
  H: number;
  K: number;
  maxWeeks?: number;
}

// 試行数補正後の IC 有意閾値。nTrials 個の標準正規の期待最大値 × IC の標準誤差。
// 「設定を総当たりして最良を選ぶ」でも「N銘柄を並べて最良を選ぶ」でも、多重比較の構造は同じなので
// 設定カタログ(runWeeklyAnalogOosCatalog)と横断表(ウォッチリストN銘柄)で共有する。
export function deflatedIcThreshold(nTrials: number, nObs: number): number {
  if (nTrials < 2) return 0;
  const seIc = 1 / Math.sqrt(Math.max(2, nObs - 1));
  const EULER = 0.5772156649;
  const expMaxZ = (1 - EULER) * invNormalCdf(1 - 1 / nTrials) + EULER * invNormalCdf(1 - 1 / (nTrials * Math.E));
  return expMaxZ * seIc;
}

export function runWeeklyAnalogOosCatalog(p: RunCatalogParams): OosCatalog | null {
  const catalog = defaultCatalog(p.K);
  const maxWeeks = p.maxWeeks ?? 130;
  const rows: OosCatalogRow[] = [];
  const halfIc: { ic1: number; ic2: number }[] = [];
  for (const s of catalog) {
    const points = predictSeries(p.prices, p.us, s, p.scheme, p.H, maxWeeks);
    if (points.length < 8) continue;
    const ic = spearman(points.map((q) => q.yhat), points.map((q) => q.yact));
    rows.push({ setting: s, label: settingLabel(s), ic, n: points.length });
    // PBO 用: 前半/後半の IC
    const mid = Math.floor(points.length / 2);
    const p1 = points.slice(0, mid), p2 = points.slice(mid);
    halfIc.push({
      ic1: p1.length >= 5 ? spearman(p1.map((q) => q.yhat), p1.map((q) => q.yact)) : 0,
      ic2: p2.length >= 5 ? spearman(p2.map((q) => q.yhat), p2.map((q) => q.yact)) : 0,
    });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => b.ic - a.ic);

  const nTrials = rows.length;
  const bestIc = rows[0].ic;
  const nObs = Math.max(8, Math.round((rows[0].n) / Math.ceil(Math.max(1, p.H) / 5)));
  const deflatedThreshold = deflatedIcThreshold(nTrials, nObs);
  const bestPasses = bestIc > deflatedThreshold;

  // PBO(簡易): 前半で最良の設定が後半で中央値を下回る割合を、前半トップ→後半順位から推定。
  let pbo = 0;
  if (halfIc.length >= 4) {
    const byIc1 = halfIc.map((h, i) => ({ ...h, i })).sort((a, b) => b.ic1 - a.ic1);
    const bestByH1 = byIc1[0];
    const ic2Sorted = [...halfIc].map((h) => h.ic2).sort((a, b) => a - b);
    const med2 = medianOf(ic2Sorted);
    pbo = bestByH1.ic2 < med2 ? 1 : 0;
    // 上位3件の平均で滑らかに
    const top = byIc1.slice(0, Math.min(3, byIc1.length));
    pbo = top.filter((t) => t.ic2 < med2).length / top.length;
  }

  return { rows, nTrials, bestIc, deflatedThreshold, bestPasses, pbo };
}
