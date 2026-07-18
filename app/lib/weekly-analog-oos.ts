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

import { PricePoint } from "./types";
import { UsReturn, BinScheme } from "./us-spillover-core";
import {
  computeWeeklyAnalog, AnalogMode, DistMetric, WindowAlign, WeightMode,
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

export interface OosPredPoint { date: string; yhat: number; yact: number; }

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
    pts.push({ date: prices[t].time, yhat, yact });
  }
  return pts;
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

  return { points, ic, icLo, icHi, n, nEff, hit, baseHit, quintiles, monotone, H };
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
  const seIc = 1 / Math.sqrt(Math.max(2, nObs - 1)); // IC の標準誤差近似
  // 試行数補正: nTrials 個の標準正規の期待最大 × SE
  const EULER = 0.5772156649;
  const expMaxZ = (1 - EULER) * invNormalCdf(1 - 1 / nTrials) + EULER * invNormalCdf(1 - 1 / (nTrials * Math.E));
  const deflatedThreshold = expMaxZ * seIc;
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
