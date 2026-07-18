// 今週の値動きの軌跡を、過去の類似局面(似た形)または前夜米国ビンで絞った過去局面と
// 突き合わせるアナログ分析(日足)。
//
// 中核の考え方: すべての窓を「窓末(=今日, t=0)を 0% とする累積リターン」に再基準化する。
// こうすると t=0 で全系列が 0 に収束し、
//   - 左側(t<0, リードイン): どんな経路で今日に至ったか  → 今週と過去の「形」を比較
//   - 右側(t>0, フォワード):  その後どう動いたか          → 中央値パス＋分位帯で先読み
// が 1 枚の連続した図で読める。今週(クエリ)はフォワードが未確定なのでリードインのみ描く。
//
// 選択モード:
//   similar:   今週のリードイン形状に最も近い過去 K 窓(z化ユークリッド/DTW距離)
//   usbin:     窓の起点(週初め)の前夜米国が指定ビンだった過去窓すべて
//   ensemble:  usbin ∩ similar。指定ビンに絞ったうえで形の近い順に K 窓(B4)
//
// 統計的妥当性(改善 A1/A2):
//   - 無条件ベースライン(全候補窓のフォワード分布)との差＋ブロック順列検定 p 値
//   - 重複窓を畳んだ実効標本数 n_eff とクラスタ・ブートストラップ CI
// 手法の質(改善 B1/B2/B3/B6):
//   - カーネル重み付け(Nadaraya-Watson)＋novelty(前例の薄さ)による棄却
//   - ボラ正規化(σ単位で集計し今週のσで復元)
//   - DTW バンド可変＋経路長正規化
//   - 距離に日中レンジ(HL)形状チャネルを加える
//
// 米国ビンは JP 日足の各日に「その寄り前で最後に確定した米国立会日(暦日が厳密に小さい最新)」の
// リターンを対応付けて層別する(us-spillover-core と同じ時差ロジックの日足版)。

import { PricePoint } from "./types";
import {
  UsReturn, BinScheme, BinMeta, binMeta, binEdges, binOfValue,
} from "./us-spillover-core";
import { quantileSorted, median as medianOf } from "./stats-significance";

export type AnalogMode = "similar" | "usbin" | "ensemble";
export type UsMode = "ret" | "intra";
// 形状距離: euclid=等速比較(時間のズレに弱い) / dtw=動的時間伸縮(ズレを吸収)
export type DistMetric = "euclid" | "dtw";
// 窓の取り方: trailing=直近L営業日 / week=今週(週境界にアライン。月曜起点で今日まで)
export type WindowAlign = "trailing" | "week";
// 近傍の重み: uniform=等重み / kernel=距離ガウスカーネル(Nadaraya-Watson)
export type WeightMode = "uniform" | "kernel";

export interface AnalogWindow {
  endIndex: number;
  source: string; // 由来ティッカー("" = 主銘柄)。B5 横断プール時に使用
  startTime: string;
  endTime: string;
  lead: number[]; // 長さ L。窓末=今日=0% とする終値の累積リターン(lead[L-1]=0)
  leadHigh: number[]; // 各日の高値(窓末終値比)。日中レンジの上端
  leadLow: number[]; // 各日の安値(窓末終値比)。日中レンジの下端
  forward: number[]; // 長さ H+1。終値の累積リターン forward[0]=0
  fwdHigh: number[]; // 各時点までの高値到達(running max, MFE)。利確余地
  fwdLow: number[]; // 各時点までの安値到達(running min, MAE)。含み損の深さ
  forwardReturn: number; // H日後の終値累積リターン
  mfe: number; // H日以内の最大高値到達
  mae: number; // H日以内の最大安値到達(通常負)
  usBin: number | null; // 窓起点(週初め)の前夜米国ビン
  vol: number; // リードイン期間の実現ボラ(日次対数リターンの標準偏差)。B2
  distance: number; // 今週リードイン形状への距離(z化, HLチャネル込み)
  weight: number; // 集計重み(kernel時はガウス重み, uniform時は1)
}

export interface WeeklyAnalogResult {
  mode: AnalogMode;
  L: number; // 実際に使ったリードイン日数(align="week" では今週の経過日数)
  H: number;
  align: WindowAlign;
  metric: DistMetric;
  query: AnalogWindow; // 今週(フォワードは未確定なので forward は空)
  queryUsBin: number | null;
  selBin: number; // usbin/ensemble モードで表示中のビン
  binMetaObj: BinMeta;
  binCounts: number[]; // 各ビンに属する過去窓数
  selected: AnalogWindow[];
  leadMedian: number[]; leadP25: number[]; leadP75: number[];
  fwdMedian: number[]; fwdP25: number[]; fwdP75: number[];
  fwdHighMedian: number[]; fwdLowMedian: number[]; // 高値/安値到達の中央値パス(MFE/MAE)
  upCount: number; downCount: number;
  medianFinal: number; meanFinal: number;
  medianMfe: number; medianMae: number; // H日以内の高値/安値到達の中央値
  totalCandidates: number;
  volNorm: boolean;
  volQuery: number; // 今週の実現ボラ(volNorm時に σ単位→%へ戻す係数)

  // ── A1: 無条件ベースラインとの差＋有意性 ──
  baselineMedian: number; // 全候補窓のH日終値中央値
  baselineWin: number; // 全候補窓の勝率
  baselineN: number;
  baselineFwdMedian: number[]; // ベースライン中央値パス(灰線オーバーレイ用)
  diffMedian: number; // medianFinal − baselineMedian
  diffP: number; // ブロック順列検定 p 値(中央値差)
  winDiff: number; // 勝率 − ベースライン勝率
  winP: number; // 勝率差の p 値

  // ── A2: 実効標本数＋クラスタ・ブートストラップ ──
  nEff: number; // 重複窓を畳んだ実効標本数
  ciLo: number; ciHi: number; // 中央値の95%CI(クラスタ・ブートストラップ)
  ciStable: number; // 符号がぶれない割合(方向の安定度)

  // ── B1: novelty(前例の薄さ)/棄却 ──
  novelty: number; // 今週の最近傍距離の分位(0..1)。高いほど前例が薄い
  rejected: boolean; // novelty が閾値超で「前例なし」警告
  nnDistance: number; // 最近傍距離(参考)

  pooled: boolean; // B5 横断プールを使ったか
}

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

// 重み付き分位。値と重みの組を値でソートし、累積重みが q·総重みを跨ぐ点を線形補間で返す。
function weightedQuantile(vals: number[], weights: number[], q: number): number {
  const n = vals.length;
  if (n === 0) return 0;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => vals[a] - vals[b]);
  const total = idx.reduce((s, i) => s + weights[i], 0);
  if (total <= 0) return quantileSorted(idx.map((i) => vals[i]), q);
  const target = q * total;
  let cum = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    const prev = cum;
    cum += weights[i];
    if (cum >= target) {
      if (k === 0) return vals[i];
      const jPrev = idx[k - 1];
      const span = weights[i] || 1;
      const frac = Math.max(0, Math.min(1, (target - prev) / span));
      return vals[jPrev] + (vals[i] - vals[jPrev]) * frac;
    }
  }
  return vals[idx[n - 1]];
}

// ───────────────────────── 米国ビンを JP 日足インデックスへ対応付け ─────────────────────────

interface UsBinAlign {
  bins: (number | null)[]; // prices と同じ長さ。各 JP 日の「前夜米国」ビン
  meta: BinMeta;
}

function alignUsBins(
  prices: PricePoint[], us: UsReturn[], usMode: UsMode, scheme: BinScheme
): UsBinAlign {
  const usSorted = [...us].sort((a, b) => a.date.localeCompare(b.date));
  const raw: (number | null)[] = [];
  let j = 0;
  for (const p of prices) {
    while (j < usSorted.length && usSorted[j].date < p.time) j++;
    const idx = j - 1; // 「p.time より暦日が厳密に小さい最新」の米国立会日
    if (idx < 0) { raw.push(null); continue; }
    const v = usMode === "intra" ? usSorted[idx].intra : usSorted[idx].ret;
    raw.push(isFinite(v) ? v : null);
  }
  const present = raw.filter((v): v is number => v !== null);
  const meta = binMeta(scheme);
  const edges = present.length >= 6 ? binEdges(present, scheme) : [];
  const bins = raw.map((v) => (v === null || edges.length === 0 ? null : binOfValue(v, scheme, edges)));
  return { bins, meta };
}

// ───────────────────────── 窓の正規化・距離 ─────────────────────────

// 窓末(end)を 0% とする終値累積リターン列(長さ L)＋各日の高値/安値(窓末終値比)。close 不正なら null。
function buildLead(prices: PricePoint[], end: number, L: number):
  { lead: number[]; leadHigh: number[]; leadLow: number[]; range: number[]; vol: number } | null {
  const start = end - L + 1;
  if (start < 0) return null;
  const baseC = prices[end].close;
  if (!(baseC > 0)) return null;
  const lead: number[] = [], leadHigh: number[] = [], leadLow: number[] = [], range: number[] = [];
  const logRet: number[] = [];
  let prevC = 0;
  for (let i = start; i <= end; i++) {
    const c = prices[i].close, h = prices[i].high, lo = prices[i].low;
    if (!(c > 0)) return null;
    lead.push(c / baseC - 1);
    const hh = h > 0 ? h : c, ll = lo > 0 ? lo : c;
    leadHigh.push(hh / baseC - 1);
    leadLow.push(ll / baseC - 1);
    range.push((hh - ll) / c); // 日中レンジ幅(終値比)。B6 の第2チャネル素材
    if (prevC > 0) logRet.push(Math.log(c / prevC));
    prevC = c;
  }
  // 実現ボラ(日次対数リターンの標準偏差)。1点しか無ければ 0。
  let vol = 0;
  if (logRet.length >= 2) {
    const m = logRet.reduce((s, v) => s + v, 0) / logRet.length;
    vol = Math.sqrt(logRet.reduce((s, v) => s + (v - m) ** 2, 0) / (logRet.length - 1));
  }
  return { lead, leadHigh, leadLow, range, vol };
}

// z化(形状のみ比較。水準・スケール差を吸収)。
function zShape(lead: number[]): number[] {
  const m = lead.reduce((s, v) => s + v, 0) / lead.length;
  const sd = Math.sqrt(lead.reduce((s, v) => s + (v - m) ** 2, 0) / lead.length) || 1;
  return lead.map((v) => (v - m) / sd);
}

function euclid(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

// DTW(動的時間伸縮)距離。等速比較のユークリッドと違い、時間軸の伸び縮み(山が1日早い/遅い等)を
// 吸収して「形」を突き合わせる。Sakoe-Chiba バンドで warping 幅を制限し、退化と計算量を抑える。
//   D[i][j] = (a_i - b_j)^2 + min(D[i-1][j], D[i][j-1], D[i-1][j-1])
// 経路長で正規化した平方根 √(D(n,m)/Λ(n,m)) を返す(経路長の異なる候補間でも可換に近づける, B3)。
function dtw(a: number[], b: number[], band: number): number {
  const n = a.length, m = b.length;
  const w = Math.max(band, Math.abs(n - m));
  let prevD = new Array<number>(m + 1).fill(Infinity);
  let curD = new Array<number>(m + 1).fill(Infinity);
  let prevL = new Array<number>(m + 1).fill(0); // 経路長(ステップ数)
  let curL = new Array<number>(m + 1).fill(0);
  prevD[0] = 0;
  for (let i = 1; i <= n; i++) {
    curD.fill(Infinity); curL.fill(0);
    const jS = Math.max(1, i - w), jE = Math.min(m, i + w);
    for (let j = jS; j <= jE; j++) {
      const cost = (a[i - 1] - b[j - 1]) ** 2;
      // 3方向の最小を選び、そこからの経路長を +1
      const dDiag = prevD[j - 1], dUp = prevD[j], dLeft = curD[j - 1];
      let best = dDiag, bestL = prevL[j - 1];
      if (dUp < best) { best = dUp; bestL = prevL[j]; }
      if (dLeft < best) { best = dLeft; bestL = curL[j - 1]; }
      curD[j] = cost + best;
      curL[j] = bestL + 1;
    }
    let t = prevD; prevD = curD; curD = t;
    t = prevL; prevL = curL; curL = t;
  }
  const d = prevD[m], len = prevL[m] || 1;
  return isFinite(d) ? Math.sqrt(d / len) : Infinity;
}

// 形状距離(z化済みの終値波形＋任意でレンジ波形)。
//   d = √(d_close² + hlWeight·d_range²)   (B6: HL チャネル。hlWeight=0 なら終値のみ)
// DTW のバンドは窓長×bandFrac(最低1)。
function shapeDist(
  aClose: number[], bClose: number[], aRange: number[] | null, bRange: number[] | null,
  metric: DistMetric, bandFrac: number, hlWeight: number
): number {
  const band = Math.max(1, Math.round(aClose.length * bandFrac));
  const dc = metric === "dtw" ? dtw(aClose, bClose, band) : euclid(aClose, bClose);
  if (hlWeight <= 0 || !aRange || !bRange) return dc;
  const dr = metric === "dtw" ? dtw(aRange, bRange, band) : euclid(aRange, bRange);
  return Math.sqrt(dc * dc + hlWeight * dr * dr);
}

// ───────────────────────── 週境界(月曜起点)のグルーピング ─────────────────────────

// その日が属する週の月曜日(YYYY-MM-DD)。曜日は UTC 基準で扱い、TZ による揺れを避ける。
function weekKey(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateStr;
  const dow = d.getUTCDay(); // 0=日..6=土
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow)); // その週の月曜へ
  return d.toISOString().slice(0, 10);
}

// 立会日インデックスを週(月曜起点)ごとにまとめる。各配列は昇順・連続インデックス。
function groupWeeks(prices: PricePoint[]): Map<string, number[]> {
  const g = new Map<string, number[]>();
  for (let i = 0; i < prices.length; i++) {
    const k = weekKey(prices[i].time);
    const a = g.get(k);
    if (a) a.push(i); else g.set(k, [i]);
  }
  return g;
}

// 窓末(end)を 0% とするフォワード終値パス＋高値/安値の到達(running max/min = MFE/MAE)。
function buildForward(prices: PricePoint[], end: number, H: number):
  { forward: number[]; fwdHigh: number[]; fwdLow: number[] } | null {
  const baseC = prices[end].close;
  if (!(baseC > 0)) return null;
  const forward: number[] = [], fwdHigh: number[] = [], fwdLow: number[] = [];
  let runH = -Infinity, runL = Infinity;
  for (let m = 0; m <= H; m++) {
    const p = prices[end + m];
    if (!p || !(p.close > 0)) return null;
    forward.push(p.close / baseC - 1);
    const h = (p.high > 0 ? p.high : p.close) / baseC - 1;
    const lo = (p.low > 0 ? p.low : p.close) / baseC - 1;
    runH = Math.max(runH, h); runL = Math.min(runL, lo);
    fwdHigh.push(runH); fwdLow.push(runL);
  }
  return { forward, fwdHigh, fwdLow };
}

// 重み付きの中央値/分位パス集計。
function aggPaths(paths: number[][], weights: number[], len: number):
  { med: number[]; p25: number[]; p75: number[] } {
  const med: number[] = [], p25: number[] = [], p75: number[] = [];
  for (let i = 0; i < len; i++) {
    const vals: number[] = [], ws: number[] = [];
    for (let k = 0; k < paths.length; k++) {
      const v = paths[k][i];
      if (isFinite(v)) { vals.push(v); ws.push(weights[k]); }
    }
    med.push(weightedQuantile(vals, ws, 0.5));
    p25.push(weightedQuantile(vals, ws, 0.25));
    p75.push(weightedQuantile(vals, ws, 0.75));
  }
  return { med, p25, p75 };
}

// ───────────────────────── クラスタリング(重複窓を畳む, A2/A4/B5) ─────────────────────────

// 窓集合を「フォワードが重なる/同一週の別銘柄」を1クラスタにまとめ、各窓のクラスタIDを返す。
//   単一銘柄: 窓末インデックスの差が H 未満なら同一クラスタ(フォワード重複)
//   横断プール: それに加え、同じ週(weekKey)の別銘柄も同一クラスタ(横断相関)
function clusterWindows(wins: AnalogWindow[], H: number, pooled: boolean): number[] {
  const n = wins.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  // 同一銘柄内: 窓末が近い(< H)ものを連結
  const bySource = new Map<string, number[]>();
  wins.forEach((w, i) => { const a = bySource.get(w.source); if (a) a.push(i); else bySource.set(w.source, [i]); });
  for (const arr of bySource.values()) {
    arr.sort((a, b) => wins[a].endIndex - wins[b].endIndex);
    for (let k = 1; k < arr.length; k++) {
      if (wins[arr[k]].endIndex - wins[arr[k - 1]].endIndex < Math.max(1, H)) union(arr[k], arr[k - 1]);
    }
  }
  // 横断プール: 同一週(endTime の weekKey)の別銘柄を連結
  if (pooled) {
    const byWeek = new Map<string, number[]>();
    wins.forEach((w, i) => { const k = weekKey(w.endTime); const a = byWeek.get(k); if (a) a.push(i); else byWeek.set(k, [i]); });
    for (const arr of byWeek.values()) for (let k = 1; k < arr.length; k++) union(arr[k], arr[0]);
  }
  // 連番IDに正規化
  const idMap = new Map<number, number>();
  return wins.map((_, i) => {
    const r = find(i);
    let id = idMap.get(r);
    if (id === undefined) { id = idMap.size; idMap.set(r, id); }
    return id;
  });
}

// クラスタ単位のブートストラップで、選抜フォワードの中央値の95%CIと符号安定度を推定。
function clusterBootstrapCI(
  finals: number[], clusterId: number[], seed: number
): { lo: number; hi: number; stable: number } {
  const groups = new Map<number, number[]>();
  clusterId.forEach((c, i) => { const a = groups.get(c); if (a) a.push(finals[i]); else groups.set(c, [finals[i]]); });
  const clusters = Array.from(groups.values());
  const nc = clusters.length;
  if (nc < 2) { const m = medianOf(finals); return { lo: m, hi: m, stable: 1 }; }
  const rng = mulberry32(seed);
  const point = medianOf(finals);
  const sign = point >= 0 ? 1 : -1;
  const samples: number[] = [];
  let same = 0;
  const B = 800;
  for (let b = 0; b < B; b++) {
    const pool: number[] = [];
    for (let k = 0; k < nc; k++) pool.push(...clusters[Math.floor(rng() * nc)]);
    const m = medianOf(pool);
    samples.push(m);
    if ((m >= 0 ? 1 : -1) === sign) same++;
  }
  samples.sort((a, b) => a - b);
  return { lo: quantileSorted(samples, 0.025), hi: quantileSorted(samples, 0.975), stable: same / B };
}

// ブロック順列検定(A1): 全候補のフォワードから、選抜と同じクラスタ数を無作為抽出した
// 「ヌル差」の分布を作り、実測差 |Δ| の外れ度合いを p 値にする。クラスタ単位で抽出して
// 重複窓の相関を保存する。中央値差と勝率差を同じ抽出で同時評価。
function blockPermTest(
  candFinals: number[], candCluster: number[], baseMedian: number, baseWin: number,
  obsMedianDiff: number, obsWinDiff: number, nSelClusters: number, seed: number
): { pMedian: number; pWin: number } {
  const groups = new Map<number, number[]>();
  candCluster.forEach((c, i) => { const a = groups.get(c); if (a) a.push(candFinals[i]); else groups.set(c, [candFinals[i]]); });
  const clusters = Array.from(groups.values());
  const nc = clusters.length;
  if (nc < 4 || nSelClusters < 1) return { pMedian: 1, pWin: 1 };
  const k = Math.min(nSelClusters, nc);
  const rng = mulberry32(seed);
  const B = 2000;
  const absM = Math.abs(obsMedianDiff), absW = Math.abs(obsWinDiff);
  let geM = 0, geW = 0;
  const order = Array.from({ length: nc }, (_, i) => i);
  for (let b = 0; b < B; b++) {
    // k 個のクラスタを重複なしで無作為抽出(部分 Fisher-Yates)
    const pool: number[] = [];
    for (let j = 0; j < k; j++) {
      const r = j + Math.floor(rng() * (nc - j));
      const t = order[j]; order[j] = order[r]; order[r] = t;
      pool.push(...clusters[order[j]]);
    }
    const m = medianOf(pool);
    const win = pool.filter((v) => v > 0).length / (pool.length || 1);
    if (Math.abs(m - baseMedian) >= absM - 1e-15) geM++;
    if (Math.abs(win - baseWin) >= absW - 1e-15) geW++;
  }
  return { pMedian: (geM + 1) / (B + 1), pWin: (geW + 1) / (B + 1) };
}

// ───────────────────────── 候補窓の生成 ─────────────────────────

interface BuiltCands {
  cands: AnalogWindow[];
  binCounts: number[];
}

// 指定銘柄(prices)から候補窓を生成する。qClose/qRange = 今週(クエリ)の z化終値/レンジ(距離計算用)。
function buildCandidates(
  prices: PricePoint[], usBinByIdx: (number | null)[], source: string,
  L: number, H: number, jLoAbs: number, jHiAbs: number,
  weekEnds: number[] | null,
  qClose: number[], qRange: number[] | null,
  metric: DistMetric, bandFrac: number, hlWeight: number,
  binCount: number
): BuiltCands {
  const ends: number[] = [];
  if (weekEnds) {
    for (const j of weekEnds) if (j >= L - 1 && j >= jLoAbs && j <= jHiAbs) ends.push(j);
  } else {
    for (let j = Math.max(L - 1, jLoAbs); j <= jHiAbs; j++) ends.push(j);
  }
  const cands: AnalogWindow[] = [];
  const binCounts = new Array(binCount).fill(0);
  for (const j of ends) {
    const ld = buildLead(prices, j, L);
    if (!ld) continue;
    const fw = buildForward(prices, j, H);
    if (!fw) continue;
    const wStart = j - L + 1;
    const usBin = usBinByIdx[wStart];
    if (usBin !== null && usBin >= 0 && usBin < binCount) binCounts[usBin]++;
    const cZ = zShape(ld.lead);
    const rZ = hlWeight > 0 ? zShape(ld.range) : null;
    cands.push({
      endIndex: j, source, startTime: prices[wStart].time, endTime: prices[j].time,
      lead: ld.lead, leadHigh: ld.leadHigh, leadLow: ld.leadLow,
      forward: fw.forward, fwdHigh: fw.fwdHigh, fwdLow: fw.fwdLow,
      forwardReturn: fw.forward[H], mfe: fw.fwdHigh[H], mae: fw.fwdLow[H], usBin,
      vol: ld.vol,
      distance: shapeDist(qClose, cZ, qRange, rZ, metric, bandFrac, hlWeight),
      weight: 1,
    });
  }
  return { cands, binCounts };
}

// ───────────────────────── 本体 ─────────────────────────

export interface PoolSeries { ticker: string; prices: PricePoint[]; }

export interface WeeklyAnalogParams {
  prices: PricePoint[];
  us: UsReturn[];
  L: number; // リードイン日数(align="week" では今週の経過日数で上書きされる)
  H: number; // フォワード日数
  K: number; // similar/ensemble モードの近傍数
  mode: AnalogMode;
  usMode: UsMode;
  scheme: BinScheme;
  selBinOverride?: number | null; // usbin/ensemble モードで見るビン(null=今週の起点ビン)
  metric?: DistMetric; // 形状距離(既定 euclid)
  align?: WindowAlign; // 窓の取り方(既定 trailing)
  weight?: WeightMode; // 近傍の重み(既定 uniform)。B1
  volNorm?: boolean; // ボラ正規化(σ単位で集計し今週σで復元)。B2
  dtwBandFrac?: number; // DTW バンド割合(既定 0.25)。B3
  hlWeight?: number; // HL レンジ距離の重み γ(既定 0)。B6
  poolSeries?: PoolSeries[]; // 横断プールに含める他銘柄。B5
  lean?: boolean; // true で novelty/順列検定/ブートストラップを省く(OOS の反復用)
  skipNovelty?: boolean; // novelty(最も重い O(参照×候補))のみ省く(横断バッチ用)
}

export function computeWeeklyAnalog(params: WeeklyAnalogParams): WeeklyAnalogResult | null {
  const { prices, us, H, K, mode, usMode, scheme } = params;
  const metric = params.metric ?? "euclid";
  const align = params.align ?? "trailing";
  const weight = params.weight ?? "uniform";
  const volNorm = !!params.volNorm || (params.poolSeries != null && params.poolSeries.length > 0);
  const bandFrac = params.dtwBandFrac ?? 0.25;
  const hlWeight = params.hlWeight ?? 0;
  const pool = params.poolSeries ?? [];
  const pooled = pool.length > 0;
  const n = prices.length;
  if (n < params.L + H + 20) return null;

  const { bins: usBinByIdx, meta } = alignUsBins(prices, us, usMode, scheme);

  // 窓長 L と候補窓末の集合を、窓の取り方に応じて決める。
  const weeks = align === "week" ? groupWeeks(prices) : null;
  let L = params.L;
  let weekEnds: number[] | null = null;
  if (weeks) {
    const curKey = weekKey(prices[n - 1].time);
    const cur = weeks.get(curKey);
    if (!cur || cur.length < 1) return null;
    L = cur.length; // 今週の経過立会日数(月〜今日)
    weekEnds = [];
    for (const [k, idxs] of weeks) {
      if (k === curKey) continue;
      if (idxs.length < L) continue;
      weekEnds.push(idxs[L - 1]); // その週の先頭L日目 = 今週と同じ曜日位置
    }
  }
  if (n < L + H + 20) return null;

  // 今週(クエリ): 窓末 = 最新。フォワードは未確定なので lead のみ(HL含む)。
  const qEnd = n - 1;
  const qLead = buildLead(prices, qEnd, L);
  if (!qLead) return null;
  const qStart = qEnd - L + 1;
  const qClose = zShape(qLead.lead);
  const qRange = hlWeight > 0 ? zShape(qLead.range) : null;
  const volQuery = qLead.vol;
  const queryUsBin = usBinByIdx[qStart];
  const query: AnalogWindow = {
    endIndex: qEnd, source: "", startTime: prices[qStart].time, endTime: prices[qEnd].time,
    lead: qLead.lead, leadHigh: qLead.leadHigh, leadLow: qLead.leadLow,
    forward: [], fwdHigh: [], fwdLow: [], forwardReturn: NaN, mfe: NaN, mae: NaN,
    usBin: queryUsBin, vol: volQuery, distance: 0, weight: 1,
  };

  // 主銘柄の候補窓(フォワード余地あり かつ 今週リードインと重ならない)
  const jMax = Math.min(n - 1 - H, qStart - 1);
  const main = buildCandidates(
    prices, usBinByIdx, "", L, H, L - 1, jMax, weekEnds,
    qClose, qRange, metric, bandFrac, hlWeight, meta.count
  );
  let cands = main.cands;
  const binCounts = main.binCounts;

  // B5: 横断プール(他銘柄の過去週も候補に含める)。usbin/ensemble のビンは同一市場なので流用可。
  if (pooled) {
    for (const ps of pool) {
      const pp = ps.prices;
      if (!pp || pp.length < L + H + 20) continue;
      const { bins: pBins } = alignUsBins(pp, us, usMode, scheme);
      const pWeeks = align === "week" ? groupWeeks(pp) : null;
      let pWeekEnds: number[] | null = null;
      if (pWeeks) {
        pWeekEnds = [];
        for (const idxs of pWeeks.values()) if (idxs.length >= L) pWeekEnds.push(idxs[L - 1]);
      }
      const pJMax = pp.length - 1 - H;
      const built = buildCandidates(
        pp, pBins, ps.ticker, L, H, L - 1, pJMax, pWeekEnds,
        qClose, qRange, metric, bandFrac, hlWeight, meta.count
      );
      cands = cands.concat(built.cands);
      for (let b = 0; b < binCounts.length; b++) binCounts[b] += built.binCounts[b];
    }
  }

  if (cands.length < (weekEnds ? 3 : 5)) return null;

  // 表示ビン(usbin/ensemble モード): 明示指定 > 今週の起点ビン > 標本最多ビン
  let selBin = params.selBinOverride ?? queryUsBin ?? binCounts.indexOf(Math.max(...binCounts));
  if (selBin < 0 || selBin >= meta.count) selBin = 0;

  // 選抜
  let selected: AnalogWindow[];
  if (mode === "usbin") {
    selected = cands.filter((c) => c.usBin === selBin).sort((a, b) => a.distance - b.distance);
  } else if (mode === "ensemble") {
    selected = cands.filter((c) => c.usBin === selBin)
      .sort((a, b) => a.distance - b.distance).slice(0, Math.min(K, cands.length));
  } else {
    selected = [...cands].sort((a, b) => a.distance - b.distance).slice(0, Math.min(K, cands.length));
  }
  if (selected.length < 2) return null;

  const lean = !!params.lean;

  // ── B1: novelty(前例の薄さ)。最近傍距離を「候補集合の最近傍距離分布」の中で位置づける ──
  const nnDistance = Math.min(...cands.map((c) => c.distance));
  const novelty = (lean || params.skipNovelty) ? 0.5 : computeNovelty(cands, nnDistance, metric, bandFrac, hlWeight, hlWeight > 0);
  const rejected = novelty >= 0.9;

  // ── B1: カーネル重み(Nadaraya-Watson)。h = 選抜距離の中央値 ──
  if (weight === "kernel") {
    const ds = selected.map((s) => s.distance).filter((d) => isFinite(d) && d > 0).sort((a, b) => a - b);
    const h = ds.length ? Math.max(1e-6, quantileSorted(ds, 0.5)) : 1;
    for (const s of selected) s.weight = Math.exp(-(s.distance * s.distance) / (2 * h * h));
  } else {
    for (const s of selected) s.weight = 1;
  }

  // ── B2: ボラ正規化。フォワードを σ単位に直して集計し、表示時に今週σを掛け戻す ──
  const toAgg = (w: AnalogWindow, arr: number[]): number[] => {
    if (!volNorm) return arr;
    const sv = w.vol > 1e-6 ? w.vol : volQuery > 1e-6 ? volQuery : 1;
    const scaleBack = volQuery > 1e-6 ? volQuery : sv;
    return arr.map((v) => (v / sv) * scaleBack);
  };
  const wArr = selected.map((s) => s.weight);
  const lead = aggPaths(selected.map((s) => s.lead), wArr, L);
  const fwd = aggPaths(selected.map((s) => toAgg(s, s.forward)), wArr, H + 1);
  const fwdHigh = aggPaths(selected.map((s) => toAgg(s, s.fwdHigh)), wArr, H + 1);
  const fwdLow = aggPaths(selected.map((s) => toAgg(s, s.fwdLow)), wArr, H + 1);
  const finals = selected.map((s) => toAgg(s, s.forward)[H]).filter((v) => isFinite(v));
  const finalsRaw = selected.map((s) => s.forwardReturn).filter((v) => isFinite(v));
  const upW = selected.reduce((s, w) => s + (w.forwardReturn > 0 ? w.weight : 0), 0);
  const totW = selected.reduce((s, w) => s + w.weight, 0) || 1;
  const winRate = upW / totW;
  const upCount = finalsRaw.filter((v) => v > 0).length;
  const meanFinal = finals.reduce((s, v) => s + v, 0) / (finals.length || 1);

  // ── A1: 無条件ベースライン(全候補窓) ──
  const baseFinals = cands.map((c) => (volNorm ? toAgg(c, c.forward)[H] : c.forwardReturn)).filter((v) => isFinite(v));
  const baselineMedian = medianOf(baseFinals);
  const baselineWin = cands.filter((c) => c.forwardReturn > 0).length / (cands.length || 1);
  const baseFwd = aggPaths(cands.map((c) => toAgg(c, c.forward)), cands.map(() => 1), H + 1);
  const diffMedian = fwd.med[H] - baselineMedian;
  const winDiff = winRate - baselineWin;

  // ── A2: 実効標本数＋クラスタ・ブートストラップ ──
  const selCluster = clusterWindows(selected, H, pooled);
  const nEff = new Set(selCluster).size;
  const ci = lean ? { lo: fwd.med[H], hi: fwd.med[H], stable: 1 } : clusterBootstrapCI(finals, selCluster, 0x51ed01);

  // A1 の p 値はクラスタ単位で(A2 のブロックを使い)算出
  const perm = lean
    ? { pMedian: 1, pWin: 1 }
    : blockPermTest(baseFinals, clusterWindows(cands, H, pooled), baselineMedian, baselineWin, diffMedian, winDiff, nEff, 0x0a11a5);

  return {
    mode, L, H, align, metric, query, queryUsBin, selBin, binMetaObj: meta, binCounts,
    selected,
    leadMedian: lead.med, leadP25: lead.p25, leadP75: lead.p75,
    fwdMedian: fwd.med, fwdP25: fwd.p25, fwdP75: fwd.p75,
    fwdHighMedian: fwdHigh.med, fwdLowMedian: fwdLow.med,
    upCount, downCount: finalsRaw.length - upCount,
    medianFinal: fwd.med[H], meanFinal,
    medianMfe: fwdHigh.med[H], medianMae: fwdLow.med[H],
    totalCandidates: cands.length,
    volNorm, volQuery,
    baselineMedian, baselineWin, baselineN: cands.length, baselineFwdMedian: baseFwd.med,
    diffMedian, diffP: perm.pMedian, winDiff, winP: perm.pWin,
    nEff, ciLo: ci.lo, ciHi: ci.hi, ciStable: ci.stable,
    novelty, rejected, nnDistance,
    pooled,
  };
}

// novelty: 候補の一部を参照クエリとし、その最近傍距離の分布の中で今週の最近傍距離が
// どの分位にあるかを返す(0..1, 1に近いほど前例が薄い)。O(参照×候補)。参照は最大160点に間引き。
function computeNovelty(
  cands: AnalogWindow[], queryNn: number,
  metric: DistMetric, bandFrac: number, hlWeight: number, useRange: boolean
): number {
  const n = cands.length;
  if (n < 8) return 0.5;
  const step = Math.max(1, Math.floor(n / 160));
  const refZ: number[][] = cands.map((c) => zShape(c.lead));
  const refR: (number[] | null)[] = useRange ? cands.map((c) => zShape(c.leadHigh.map((h, i) => h - c.leadLow[i]))) : cands.map(() => null);
  const nnDists: number[] = [];
  for (let i = 0; i < n; i += step) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const d = shapeDist(refZ[i], refZ[j], refR[i], refR[j], metric, bandFrac, hlWeight);
      if (d < best) best = d;
    }
    if (isFinite(best)) nnDists.push(best);
  }
  if (nnDists.length < 4) return 0.5;
  nnDists.sort((a, b) => a - b);
  // queryNn の分位: queryNn 以下の割合
  let below = 0;
  for (const d of nnDists) if (d <= queryNn) below++;
  return below / nnDists.length;
}
