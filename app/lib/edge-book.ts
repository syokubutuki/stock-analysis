// 合成ブック: 弱いエッジN本を束ねたときの Sharpe・テール・総容量。
// -------------------------------------------------------------
// 単体のエッジ容量(edge-capacity.ts)は「1エッジを1銘柄で回す」前提。しかし実務では
// 同一銘柄で複数エッジを同時に回す。このとき2つの効果が出る:
//   (A) 分散効果: エッジ間相関が低ければ合成ブックの Sharpe は個々より上がる。
//       ただし危機時に相関が1へ跳ねると分散効果は消える(テール相関)。
//   (B) 流動性の食い合い: M本のエッジが同じ寄り/引けオークション(V_auc)を食い合うため、
//       総容量は個別容量の単純和にならない。同時に売買するほど互いのインパクトを増やす。
//
// (A) リスク側: 各エッジを共通カレンダー上の日次P&Lストリーム(非稼働日=0)に直し、
//     相関・合成ボラ・合成Sharpe・テール相関(悪い日だけの相関)を実現値で測る。
// (B) 容量側: 等配分で各エッジが見る実効フロー = K(1+φ(M−1))/M(φ=競合度∈[0,1])。
//     ブック損益分岐 K_be,book = (ā/b)²·M/(1+φ(M−1))。
//       φ=0(完全にずらして執行) → M倍(容量が加算)
//       φ=1(完全同時) → 単一と同じ(本数を増やしても総容量は増えない=食い合い)
//     ā = 頻度加重した(収縮後)エッジ、b = 2Yσ/√V_auc(edge-capacityと同じ)。
import { PricePoint } from "./types";
import { EdgeSeries, directedReturns } from "./edge-trades";
import { computeCapacity, CapacityParams, DEFAULT_CAPACITY_PARAMS } from "./edge-capacity";
import { Side } from "./weekday-trade";
import { mean, std } from "./stats-significance";

export interface EdgeBookParams {
  costBps: number;
  contention: number; // φ: オークション競合度。−1で「日付重なりから自動推定」
  capacity: CapacityParams;
}

export const DEFAULT_BOOK_PARAMS: EdgeBookParams = {
  costBps: 0,
  contention: -1, // 自動
  capacity: DEFAULT_CAPACITY_PARAMS,
};

export interface BookLeg {
  id: string;
  label: string;
  direction: Side;
  annReturn: number; // 単体の年率(方向調整後・日次ストリーム基準)
  sharpe: number; // 単体の年率シャープ
  weight: number; // 合成での配分(逆ボラ・正規化)
  kBreakEven: number; // 単体の損益分岐容量(収縮後μ)
}

export interface EdgeBookResult {
  ok: boolean;
  reason?: string;
  legs: BookLeg[];
  corr: number[][]; // 日次ストリームのピアソン相関行列(leg順)
  avgCorr: number; // 平均ペア相関(全体)
  tailCorr: number; // 悪い日(下位decile)だけの平均ペア相関
  // 合成ブック(逆ボラ加重)
  bookSharpe: number;
  bookAnn: number;
  bookMaxDD: number;
  bookCVaR5: number; // 日次の下位5% 平均(テール損失)
  diversification: number; // 分散比 = Σw·σ_i / σ_book (>1で分散効果)
  sumSharpeIfIndep: number; // 無相関なら得られたはずの合成Sharpe(√Σsr²)の目安
  // 容量の食い合い
  contentionUsed: number; // 実際に使ったφ
  contentionAuto: number; // 日付重なりから推定したφ
  kNaiveSum: number; // 個別 K_be の単純和(誤った期待)
  kBookContended: number; // 食い合いを入れた総容量
  contentionFactor: number; // M/(1+φ(M−1)) ∈ [1, M]
  nDays: number;
  params: EdgeBookParams;
}

// 共通カレンダー上の日次P&Lストリーム(方向調整・稼働日以外0)。exit日にretを置く。
function dailyStream(edge: EdgeSeries, direction: Side, dateIndex: Map<string, number>, nDays: number): number[] {
  const sign = direction === "short" ? -1 : 1;
  const out = new Array(nDays).fill(0);
  for (const t of edge.trades) {
    const di = dateIndex.get(t.date);
    if (di !== undefined) out[di] += sign * t.ret; // 同日複数は加算(通常1)
  }
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const ma = mean(a), mb = mean(b);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  const d = Math.sqrt(va * vb);
  return d > 0 ? cov / d : 0;
}

// 2エッジの取引日集合のJaccard(=同じ日に執行しがちか)。φの自動推定に使う。
function dateJaccard(a: EdgeSeries, b: EdgeSeries): number {
  const sa = new Set(a.trades.map((t) => t.date));
  const sb = new Set(b.trades.map((t) => t.date));
  let inter = 0;
  for (const d of sa) if (sb.has(d)) inter++;
  const uni = sa.size + sb.size - inter;
  return uni > 0 ? inter / uni : 0;
}

export function computeEdgeBook(
  prices: PricePoint[],
  catalog: EdgeSeries[],
  selectedIds: string[],
  params: EdgeBookParams,
): EdgeBookResult {
  const empty = (reason: string): EdgeBookResult => ({
    ok: false, reason, legs: [], corr: [], avgCorr: 0, tailCorr: 0,
    bookSharpe: 0, bookAnn: 0, bookMaxDD: 0, bookCVaR5: 0, diversification: 1, sumSharpeIfIndep: 0,
    contentionUsed: 0, contentionAuto: 0, kNaiveSum: 0, kBookContended: 0, contentionFactor: 1,
    nDays: 0, params,
  });

  const chosen = catalog.filter((e) => selectedIds.includes(e.id));
  if (chosen.length < 2) return empty("エッジを2本以上選んでください(合成の分散・食い合いを見るため)。");

  // 共通カレンダー(価格の営業日)
  const dates = prices.filter((p) => p.close > 0).map((p) => p.time.slice(0, 10));
  const dateIndex = new Map<string, number>();
  dates.forEach((d, i) => dateIndex.set(d, i));
  const nDays = dates.length;
  if (nDays < 250) return empty("日数が不足しています(250営業日以上)。");

  // 方向(単体平均の符号)・日次ストリーム
  const dirs: Side[] = chosen.map((e) => (mean(e.trades.map((t) => t.ret)) >= 0 ? "long" : "short"));
  const streams = chosen.map((e, k) => dailyStream(e, dirs[k], dateIndex, nDays));

  const TR = 252;
  const perDaySharpe = (s: number[]) => { const sd = std(s); return sd > 0 ? mean(s) / sd : 0; };
  const annOf = (s: number[]) => mean(s) * TR;

  // 相関行列
  const M = chosen.length;
  const corr: number[][] = Array.from({ length: M }, () => new Array(M).fill(1));
  let corrSum = 0, corrCnt = 0;
  for (let i = 0; i < M; i++) for (let j = i + 1; j < M; j++) {
    const c = pearson(streams[i], streams[j]);
    corr[i][j] = c; corr[j][i] = c;
    corrSum += c; corrCnt++;
  }
  const avgCorr = corrCnt > 0 ? corrSum / corrCnt : 0;

  // テール相関: ブック(等加重)の悪い日 下位decile に限定した平均ペア相関
  const ew = new Array(nDays).fill(0).map((_, t) => { let s = 0; for (let k = 0; k < M; k++) s += streams[k][t]; return s / M; });
  const order = ew.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const tailN = Math.max(20, Math.floor(nDays * 0.1));
  const tailIdx = order.slice(0, tailN).map((o) => o.i);
  let tCorrSum = 0, tCorrCnt = 0;
  for (let i = 0; i < M; i++) for (let j = i + 1; j < M; j++) {
    const a = tailIdx.map((t) => streams[i][t]);
    const b = tailIdx.map((t) => streams[j][t]);
    tCorrSum += pearson(a, b); tCorrCnt++;
  }
  const tailCorr = tCorrCnt > 0 ? tCorrSum / tCorrCnt : 0;

  // 逆ボラ加重の合成ブック
  const vols = streams.map((s) => std(s) || 1e-12);
  const invVol = vols.map((v) => 1 / v);
  const wsum = invVol.reduce((a, b) => a + b, 0);
  const weights = invVol.map((v) => v / wsum);
  const book = new Array(nDays).fill(0);
  for (let t = 0; t < nDays; t++) { let s = 0; for (let k = 0; k < M; k++) s += weights[k] * streams[k][t]; book[t] = s; }

  const bookSharpe = perDaySharpe(book) * Math.sqrt(TR);
  const bookAnn = annOf(book);
  // maxDD / CVaR
  let cum = 1, peak = -Infinity, bookMaxDD = 0;
  for (let t = 0; t < nDays; t++) { cum *= 1 + book[t]; peak = Math.max(peak, cum); const dd = (cum - peak) / peak; if (dd < bookMaxDD) bookMaxDD = dd; }
  const sortedBook = [...book].sort((a, b) => a - b);
  const cvarN = Math.max(1, Math.floor(nDays * 0.05));
  const bookCVaR5 = mean(sortedBook.slice(0, cvarN));

  // 分散比: Σw_i σ_i / σ_book
  const weightedVol = weights.reduce((a, w, k) => a + w * vols[k], 0);
  const diversification = std(book) > 0 ? weightedVol / std(book) : 1;
  // 無相関なら得られたはずの合成Sharpe(逆ボラ等リスクなら √M × 平均単体SR の目安)
  const singleSharpes = streams.map((s) => perDaySharpe(s) * Math.sqrt(TR));
  const sumSharpeIfIndep = Math.sqrt(singleSharpes.reduce((a, sr) => a + sr * sr, 0));

  // ---- 容量の食い合い ----
  // 各エッジの単体 K_be(収縮後μ・カタログ本数で補正)
  const capParams = { ...params.capacity, nTrials: catalog.length };
  const kIndiv: number[] = [];
  const aList: number[] = []; // a_i = μ_i,defl − s
  const fList: number[] = [];
  let b = 0;
  // 容量の食い合いは「流動性の共有」という別軸の効果なので、ここでは各脚のグロス
  // エッジ a=μ−spread(選択バイアス補正前)を使って食い合いを可視化する。各脚の誠実な
  // (収縮後)容量は容量推定パネルを参照。ここで補正まで重ねると多くが0になり食い合いの
  // 教訓が見えなくなるため、意図的に補正前で描く。
  for (const e of chosen) {
    const cap = computeCapacity(prices, e, capParams);
    if (cap) {
      kIndiv.push(Math.max(0, cap.kBreakEven));
      aList.push(cap.a);
      fList.push(e.tradesPerYear);
      b = cap.b; // 同一銘柄なので全エッジ共通
    } else {
      kIndiv.push(0); aList.push(0); fList.push(e.tradesPerYear);
    }
  }
  const kNaiveSum = kIndiv.reduce((a, v) => a + v, 0);

  // φ自動推定: 選択エッジの平均ペア日付Jaccard
  let jSum = 0, jCnt = 0;
  for (let i = 0; i < M; i++) for (let j = i + 1; j < M; j++) { jSum += dateJaccard(chosen[i], chosen[j]); jCnt++; }
  const contentionAuto = jCnt > 0 ? jSum / jCnt : 0;
  const phi = params.contention < 0 ? contentionAuto : Math.max(0, Math.min(1, params.contention));

  // ā = 頻度加重の(収縮後)エッジ、K_be,book = (ā/b)²·M/(1+φ(M−1))
  const fSum = fList.reduce((a, v) => a + v, 0);
  const aBar = fSum > 0 ? fList.reduce((acc, f, k) => acc + f * aList[k], 0) / fSum : 0;
  const contentionFactor = M / (1 + phi * (M - 1));
  const kBookContended = aBar > 0 && b > 0 ? Math.pow(aBar / b, 2) * contentionFactor : 0;

  const legs: BookLeg[] = chosen.map((e, k) => ({
    id: e.id, label: e.label, direction: dirs[k],
    annReturn: annOf(streams[k]), sharpe: singleSharpes[k], weight: weights[k], kBreakEven: kIndiv[k],
  }));

  return {
    ok: true, legs, corr, avgCorr, tailCorr,
    bookSharpe, bookAnn, bookMaxDD, bookCVaR5, diversification, sumSharpeIfIndep,
    contentionUsed: phi, contentionAuto, kNaiveSum, kBookContended, contentionFactor,
    nDays, params,
  };
}
