// クロスセクション・ロングショート: 小エッジの棲息域。
// -------------------------------------------------------------
// 単一銘柄・時間軸のエッジは breadth≈1 でシャープが構造的に頭打ちになる(edge-power.ts)。
// 「本当に小さいエッジ」は、毎日ユニバース全体を横断ランクして上位ロング/下位ショートの
// 市場中立ブックにして初めて使える ── これが運用の基本法則 IR ≈ IC·√BR の実践版。
//
// 各リバランス日に、その時点で観測可能な情報だけでシグナルを作り、銘柄横断でランク付けし、
// 上位qをロング・下位qをショート(ダラー中立)。翌保有期間のブックリターンを積む。
// 出力: IC(情報係数)・実効ブレッドス・理論IR vs 実現シャープ・回転率・コスト分岐点・
//       市場中立性(対等加重ユニバースへのβ)。
//
// point-in-time(#5): 各銘柄の在籍期間(既定=データが存在する期間)を membership 窓として尊重。
// 廃止銘柄はデータ終了後に自動退場し、上場前は参加しない。全銘柄が現在まで生存している場合は
// 生存者バイアスの警告を出す(ユーザーが廃止銘柄を含めれば正しく効く土台)。
import { PricePoint } from "./types";
import { mean, std } from "./stats-significance";
import { representativeSpread } from "./spread-estimator";
import {
  MarginKind, resolveMarginRate, adminFeeMonthlyRate, transferFeeAnnualRate,
  DEFAULT_MARGIN_KIND,
} from "./rakuten-margin";

export type XSignalId = "reversal1" | "reversal5" | "momentum" | "lowvol";

export const XSIGNAL_LABEL: Record<XSignalId, string> = {
  reversal1: "短期リバーサル(前日)",
  reversal5: "短期リバーサル(5日)",
  momentum: "クロスセクション・モメンタム(12-1月)",
  lowvol: "低ボラティリティ",
};

export const XSIGNAL_DESC: Record<XSignalId, string> = {
  reversal1: "前日に相対的に負けた銘柄を買い、勝った銘柄を売る。最も頑健で容量制限の強い古典的小エッジ。",
  reversal5: "直近5営業日の相対負け組を買い勝ち組を売る。前日版より回転が遅くコストに強い。",
  momentum: "過去12ヶ月(直近1ヶ月除く)の相対勝ち組を買い負け組を売る。中期の持続性を取る。",
  lowvol: "直近20日の実現ボラが低い銘柄を買い高い銘柄を売る。低ボラ・アノマリー。",
};

export interface XParams {
  signal: XSignalId;
  rebalanceDays: number; // リバランス間隔(営業日)。1=毎日
  quantile: number; // 上位/下位それぞれ何割をロング/ショートするか(0.1..0.5)
  costBps: number; // 片道コスト(bp)。回転に比例して控除(flat モデル)
  grossLeverage: number; // 総エクスポージャ(ロング+ショートの絶対値合計)
  costModel?: "flat" | "rakuten"; // rakuten=楽天証券の実コスト(スプレッド+信用金利+貸株料+諸経費)
  marginKind?: MarginKind; // 信用区分(金利/貸株料の実レート)
  membership?: Record<string, { from?: string; to?: string }>; // point-in-time 在籍窓の上書き
}

export const DEFAULT_X_PARAMS: XParams = {
  signal: "reversal1",
  rebalanceDays: 1,
  quantile: 0.3,
  costBps: 0,
  grossLeverage: 1,
  costModel: "flat",
  marginKind: DEFAULT_MARGIN_KIND,
};

export interface TickerSpan {
  ticker: string;
  name: string;
  from: string;
  to: string;
  nBars: number;
  extendsToEnd: boolean; // データがサンプル終端まで届いているか(=生存者候補)
}

export interface XEquityPoint {
  time: string;
  gross: number; // コスト控除前 累積リターン
  net: number; // コスト控除後
}

export interface XResult {
  ok: boolean;
  reason?: string;
  from: string;
  to: string;
  years: number;
  nPeriods: number; // リバランス回数(=IC標本数)
  avgBreadth: number; // 平均採用銘柄数(ロング+ショート)
  universeSize: number;
  // 情報係数
  icMean: number; // 平均IC(順位相関)
  icStd: number;
  icIR: number; // IC情報比 = mean/std(1リバランスあたり)
  icT: number; // IC の t 値 = icIR·√nPeriods
  hitRate: number; // ICが正だったリバランスの割合
  // 基本法則 vs 実現
  breadthPerYear: number; // 年あたり独立ベット数 ≈ avgBreadth × リバランス/年(素朴)
  irTheoretical: number; // IC·√(breadthPerYear)(年率の理論IR・素朴)
  // Task1: 相関ディスカウント後の誠実なブレッドス
  rhoXs: number; // 横断残差相関の平均ペア(≥0にクランプ)=同日クラスタの目減り
  kEffPerRebalance: number; // 1リバランスの実効ベット数 = k/(1+(k−1)ρ_xs)
  temporalEff: number; // 時間方向の実効率 ess/nPeriods(シグナル持続=リバランス重複の目減り)
  essRebalances: number; // 実効独立リバランス数
  breadthPerYearEff: number; // 相関ディスカウント後の年あたり独立ベット数
  irTheoreticalDiscounted: number; // IC·√(breadthPerYearEff)(誠実な理論IR)
  icTEff: number; // 時間相関で目減りさせたICのt値
  sharpeRealizedGross: number; // 実現の年率シャープ(グロス)
  sharpeRealizedNet: number;
  // ブック成績
  annGross: number;
  annNet: number;
  maxDD: number; // net
  turnoverPerYear: number; // 年あたり片道回転(Σ|Δw|/2 の年率)
  costBreakevenBps: number; // 実現シャープが0になる片道コスト(bp)
  medSpreadBps: number; // ユニバースの代表スプレッド中央値(片道bp, Corwin-Schultz)
  spreadSurvives: boolean; // costBreakeven > medSpread(スプレッドを越えて生き残るか)
  // Task2: 楽天証券・実コスト会計
  realCost: boolean; // 実コストモデルを適用したか
  spreadDragAnnual: number; // スプレッド往復の年率ドラッグ(bid-askバウンス=微細構造)
  financeDragAnnual: number; // 信用金利(買方)+貸株料(売方)の年率ドラッグ
  otherDragAnnual: number; // 事務管理費+名義書換料の年率ドラッグ
  totalDragAnnual: number; // 実コスト合計の年率ドラッグ
  annNetReal: number; // 実コスト控除後の年率リターン
  sharpeRealizedNetReal: number; // 実コスト控除後の年率シャープ
  realCostSurvives: boolean; // 実コスト後も年率リターンが正か
  marginKind: MarginKind; // 使用した信用区分
  marketBeta: number; // LSリターンの対等加重ユニバースリターンへのβ(中立性チェック)
  equity: XEquityPoint[];
  spans: TickerSpan[]; // 各銘柄の在籍期間
  nExtendToEnd: number; // 終端まで生存している銘柄数
  survivorWarn: boolean; // 全銘柄が生存=生存者バイアス懸念
  params: XParams;
}

// ---------------------------------------------------------------
// 順位相関(Spearman)
// ---------------------------------------------------------------
function ranks(a: number[]): number[] {
  const idx = a.map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v);
  const r = new Array<number>(a.length);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1].v === idx[k].v) j++;
    const avg = (k + j) / 2 + 1;
    for (let m = k; m <= j; m++) r[idx[m].i] = avg;
    k = j + 1;
  }
  return r;
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
function spearman(a: number[], b: number[]): number {
  if (a.length < 3) return 0;
  return pearson(ranks(a), ranks(b));
}

// ---------------------------------------------------------------
// 銘柄シリーズ(日付→idx / closeの配列)
// ---------------------------------------------------------------
interface Series {
  ticker: string;
  name: string;
  dates: string[];
  close: number[];
  idxOf: Map<string, number>;
  logret: number[]; // logret[i] = ln(close[i]/close[i-1]), [0]=0
}

function buildSeries(ticker: string, name: string, prices: PricePoint[]): Series | null {
  const clean = prices.filter((p) => p.close > 0);
  if (clean.length < 260) return null;
  const dates = clean.map((p) => p.time.slice(0, 10));
  const close = clean.map((p) => p.close);
  const idxOf = new Map<string, number>();
  dates.forEach((d, i) => idxOf.set(d, i));
  const logret = new Array(close.length).fill(0);
  for (let i = 1; i < close.length; i++) logret[i] = Math.log(close[i] / close[i - 1]);
  return { ticker, name, dates, close, idxOf, logret };
}

// シグナル値(大きいほどロング寄り)。i は当該銘柄の自前idx(=t日終値時点)。
function signalValue(s: Series, i: number, sig: XSignalId): number | null {
  const c = s.close;
  switch (sig) {
    case "reversal1":
      return i >= 1 && c[i - 1] > 0 ? -(c[i] / c[i - 1] - 1) : null; // 前日リターンの符号反転(負け組を買う)
    case "reversal5":
      return i >= 5 && c[i - 5] > 0 ? -(c[i] / c[i - 5] - 1) : null;
    case "momentum":
      return i >= 252 && c[i - 252] > 0 ? c[i - 21] / c[i - 252] - 1 : null; // 12-1月
    case "lowvol": {
      if (i < 20) return null;
      let v = 0, m = 0;
      for (let k = i - 19; k <= i; k++) m += s.logret[k];
      m /= 20;
      for (let k = i - 19; k <= i; k++) v += (s.logret[k] - m) ** 2;
      return -Math.sqrt(v / 19); // 低ボラを買う
    }
  }
}

// ---------------------------------------------------------------
// Task1: 相関ディスカウントの部品
// ---------------------------------------------------------------
// 横断の独立性: 残差相関行列の参加比(participation ratio)で「実効独立ファクター数」を測る。
// -------------------------------------------------------------
// 各銘柄を市場(等加重指数)に時系列回帰し、市場ベータを除いた残差(個別+業種)の相関行列 C を作る。
// 実効独立数 N_eff = (Σλ)²/Σλ² = N²/Σ_ij C_ij²(固有値分解不要。trace=N, Frobenius=Σ C_ij²)。
//   独立: C_ij=0 → N_eff=N。全相関 ρ: N_eff=N/(1+(N−1)ρ²)。6業種ブロック → N_eff≒6。
// なぜ「平均ペア相関」ではないか: 同業種の正相関(少数ペア)が他業種の多数ペアに希釈され
// 平均は≈0になり業種クラスタが消える。C_ij²の総和なら符号に依らず全ての非独立性を拾う。
// 返り値 ι = N_eff/N ∈ (0,1]。1=完全独立、小さいほど「同じ地合いで一緒に動く」。
function computeIndependenceRatio(series: Series[], calendar: string[]): number {
  const T = calendar.length, N = series.length;
  if (N < 2 || T < 130) return 1;
  const calIdx = new Map<string, number>();
  calendar.forEach((d, i) => calIdx.set(d, i));
  const R: Float64Array[] = series.map((s) => {
    const arr = new Float64Array(T).fill(NaN);
    for (let i = 1; i < s.dates.length; i++) {
      const ci = calIdx.get(s.dates[i]);
      if (ci !== undefined) arr[ci] = s.logret[i];
    }
    return arr;
  });
  // 市場リターン(日次・等加重の横断平均)
  const mkt = new Float64Array(T).fill(NaN);
  for (let ci = 0; ci < T; ci++) {
    let sum = 0, cnt = 0;
    for (let k = 0; k < N; k++) { const v = R[k][ci]; if (!Number.isNaN(v)) { sum += v; cnt++; } }
    if (cnt >= 2) mkt[ci] = sum / cnt;
  }
  // 各銘柄を市場に時系列回帰し、残差系列 res_k = r_k − α − β_k·mkt を作る(βはばらつくので非退化)。
  const res: Float64Array[] = series.map((_, k) => {
    const A = R[k];
    let sm = 0, sr = 0, smm = 0, smr = 0, n = 0;
    for (let ci = 0; ci < T; ci++) {
      const x = A[ci], m = mkt[ci];
      if (Number.isNaN(x) || Number.isNaN(m)) continue;
      sm += m; sr += x; smm += m * m; smr += m * x; n++;
    }
    const out = new Float64Array(T).fill(NaN);
    if (n < 120) return out;
    const vm = smm / n - (sm / n) ** 2;
    const beta = vm > 0 ? (smr / n - (sm / n) * (sr / n)) / vm : 0;
    const alpha = sr / n - beta * (sm / n);
    for (let ci = 0; ci < T; ci++) {
      const x = A[ci], m = mkt[ci];
      if (!Number.isNaN(x) && !Number.isNaN(m)) out[ci] = x - alpha - beta * m;
    }
    return out;
  });
  // 残差相関行列の Frobenius ノルム² = Σ_ij C_ij²(対角=N, 非対角は共起120日以上のみ)。
  let frob = N; // 対角の 1 が N 個
  let valid = 0;
  for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    const A = res[a], B = res[b];
    for (let ci = 0; ci < T; ci++) {
      const x = A[ci], y = B[ci];
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; n++;
    }
    if (n < 120) continue;
    const cov = sab / n - (sa / n) * (sb / n);
    const va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
    const d = Math.sqrt(va * vb);
    if (d > 0) { const c = cov / d; frob += 2 * c * c; valid++; } // C_ij と C_ji の 2 つ
  }
  if (valid === 0) return 1;
  const nEff = (N * N) / frob;
  return Math.max(1 / N, Math.min(1, nEff / N));
}

// 時間方向の実効標本数(系列相関で目減り)。Bartlett 加重の積分自己相関。
function effectiveSample(x: number[]): number {
  const n = x.length;
  if (n < 8) return n;
  const m = mean(x);
  let v = 0; for (const e of x) v += (e - m) ** 2; v /= n;
  if (v <= 0) return n;
  const K = Math.min(20, Math.floor(n / 5));
  let f = 1;
  for (let k = 1; k <= K; k++) {
    let c = 0; for (let i = k; i < n; i++) c += (x[i] - m) * (x[i - k] - m);
    c /= n * v;
    f += 2 * (1 - k / (K + 1)) * c;
  }
  f = Math.max(1, f);
  return Math.max(1, Math.min(n, n / f));
}

export function computeCrossSectional(
  pricesByTicker: Record<string, PricePoint[]>,
  names: Record<string, string>,
  params: XParams,
): XResult {
  const empty = (reason: string): XResult => ({
    ok: false, reason, from: "", to: "", years: 0, nPeriods: 0, avgBreadth: 0, universeSize: 0,
    icMean: 0, icStd: 0, icIR: 0, icT: 0, hitRate: 0, breadthPerYear: 0, irTheoretical: 0,
    rhoXs: 0, kEffPerRebalance: 0, temporalEff: 1, essRebalances: 0, breadthPerYearEff: 0,
    irTheoreticalDiscounted: 0, icTEff: 0,
    sharpeRealizedGross: 0, sharpeRealizedNet: 0, annGross: 0, annNet: 0, maxDD: 0,
    turnoverPerYear: 0, costBreakevenBps: 0, medSpreadBps: 0, spreadSurvives: false,
    realCost: false, spreadDragAnnual: 0, financeDragAnnual: 0, otherDragAnnual: 0,
    totalDragAnnual: 0, annNetReal: 0, sharpeRealizedNetReal: 0, realCostSurvives: false,
    marginKind: params.marginKind ?? DEFAULT_MARGIN_KIND,
    marketBeta: 0, equity: [], spans: [],
    nExtendToEnd: 0, survivorWarn: false, params,
  });

  const series: Series[] = [];
  for (const [ticker, prices] of Object.entries(pricesByTicker)) {
    const s = buildSeries(ticker, names[ticker] ?? ticker, prices);
    if (s) series.push(s);
  }
  if (series.length < 4) return empty(`横断には有効銘柄が4本以上必要です(現在${series.length}本・各260営業日以上)。`);

  // 共通カレンダー(全銘柄の日付の和集合・昇順)
  const dateSet = new Set<string>();
  for (const s of series) for (const d of s.dates) dateSet.add(d);
  const calendar = [...dateSet].sort();
  const sampleEnd = calendar[calendar.length - 1];

  // 在籍窓(#5): 既定は各銘柄のデータ期間。membership で上書き可。
  const memb = params.membership ?? {};
  const spans: TickerSpan[] = series.map((s) => {
    const ov = memb[s.ticker] ?? {};
    const from = ov.from && ov.from > s.dates[0] ? ov.from : s.dates[0];
    const to = ov.to && ov.to < s.dates[s.dates.length - 1] ? ov.to : s.dates[s.dates.length - 1];
    const extendsToEnd = s.dates[s.dates.length - 1] >= sampleEnd;
    return { ticker: s.ticker, name: s.name, from, to, nBars: s.close.length, extendsToEnd };
  });
  const spanOf = new Map(spans.map((sp) => [sp.ticker, sp]));
  const nExtendToEnd = spans.filter((sp) => sp.extendsToEnd).length;

  // ユニバースの代表スプレッド中央値(片道bp)。小型株ほど大きく、エッジをコストで食う壁になる。
  // representativeSpread は往復コストの水準を返すので、片道は概ねその半分とみなす。
  const spreadsRT = series
    .map((s) => representativeSpread(pricesByTicker[s.ticker] ?? []))
    .filter((v) => v > 0 && isFinite(v))
    .sort((a, b) => a - b);
  const medSpreadBps = spreadsRT.length > 0 ? (spreadsRT[Math.floor(spreadsRT.length / 2)] / 2) * 1e4 : 0;

  const h = 1; // 保有はリバランス間隔で自然に決まる(各期の1営業日先リターンを合成)
  const reb = Math.max(1, Math.round(params.rebalanceDays));
  const q = Math.min(0.5, Math.max(0.05, params.quantile));

  // リバランス日(カレンダー上で reb おき)。ウォームアップ(モメンタムは252)後から。
  const warmup = params.signal === "momentum" ? 260 : params.signal === "lowvol" ? 25 : 8;
  const periodRets: number[] = []; // 各リバランス期のブック・グロスリターン
  const periodDates: string[] = [];
  const periodTurnovers: number[] = [];
  const periodICs: number[] = [];
  const universeRets: number[] = []; // 対等加重ユニバースの同期間リターン(β用)
  let prevWeights = new Map<string, number>();
  let breadthSum = 0;
  let breadthCount = 0;
  let universeSizeMax = 0;

  for (let ci = warmup; ci < calendar.length - reb; ci += reb) {
    const t = calendar[ci];
    const tNext = calendar[Math.min(ci + reb, calendar.length - 1)];

    // 採用候補: t日に在籍・シグナル計算可・次期リターン取得可
    const cands: { ticker: string; sig: number; fwd: number }[] = [];
    for (const s of series) {
      const sp = spanOf.get(s.ticker)!;
      if (t < sp.from || t > sp.to) continue; // 在籍窓外(point-in-time)
      const i = s.idxOf.get(t);
      if (i === undefined) continue; // その日その銘柄は非取引
      const sv = signalValue(s, i, params.signal);
      if (sv === null || !isFinite(sv)) continue;
      // 次期リターン: t の次に存在する営業日〜tNext近傍。tNextが在籍窓を超えるなら退場。
      const iNext = s.idxOf.get(tNext);
      let fwd: number | null = null;
      if (iNext !== undefined && iNext > i && tNext <= sp.to) {
        fwd = s.close[iNext] / s.close[i] - 1;
      } else if (i + h < s.close.length && s.dates[i + h] <= sp.to) {
        fwd = s.close[i + h] / s.close[i] - 1;
      }
      if (fwd === null || !isFinite(fwd)) continue;
      cands.push({ ticker: s.ticker, sig: sv, fwd });
    }
    const N = cands.length;
    if (N < 4) continue;
    universeSizeMax = Math.max(universeSizeMax, N);

    // IC: シグナルと次期リターンの順位相関
    periodICs.push(spearman(cands.map((c) => c.sig), cands.map((c) => c.fwd)));

    // ランク → 上位qロング / 下位qショート(等加重・ダラー中立)
    const sorted = [...cands].sort((a, b) => b.sig - a.sig); // シグナル降順(上=ロング)
    const kSide = Math.max(1, Math.floor(N * q));
    const longs = sorted.slice(0, kSide);
    const shorts = sorted.slice(N - kSide);
    const wLong = (params.grossLeverage / 2) / longs.length;
    const wShort = -(params.grossLeverage / 2) / shorts.length;
    const weights = new Map<string, number>();
    for (const c of longs) weights.set(c.ticker, wLong);
    for (const c of shorts) weights.set(c.ticker, (weights.get(c.ticker) ?? 0) + wShort);

    // ブック・グロスリターン = Σ w_i · fwd_i
    const fwdOf = new Map(cands.map((c) => [c.ticker, c.fwd]));
    let bookRet = 0;
    for (const [tk, w] of weights) bookRet += w * (fwdOf.get(tk) ?? 0);
    // 対等加重ユニバースの同期間リターン(市場中立性のベンチ)
    let uRet = 0;
    for (const c of cands) uRet += c.fwd;
    uRet /= N;

    // 回転(片道): Σ|w_new − w_old| / 2
    let turn = 0;
    const allKeys = new Set<string>([...weights.keys(), ...prevWeights.keys()]);
    for (const k of allKeys) turn += Math.abs((weights.get(k) ?? 0) - (prevWeights.get(k) ?? 0));
    turn /= 2;

    periodRets.push(bookRet);
    periodDates.push(tNext);
    periodTurnovers.push(turn);
    universeRets.push(uRet);
    prevWeights = weights;
    breadthSum += 2 * kSide;
    breadthCount++;
  }

  const nPeriods = periodRets.length;
  if (nPeriods < 20) return empty(`リバランス期が不足(${nPeriods})。銘柄数・期間を増やしてください。`);

  const from = periodDates[0];
  const to = periodDates[nPeriods - 1];
  const t0 = new Date(calendar[warmup]).getTime();
  const t1 = new Date(to).getTime();
  const years = Math.max((t1 - t0) / (365.25 * 24 * 3600 * 1000), 1e-6);
  const periodsPerYear = nPeriods / years;

  // IC 統計
  const icMean = mean(periodICs);
  const icStd = std(periodICs);
  const icIR = icStd > 0 ? icMean / icStd : 0;
  const icT = icIR * Math.sqrt(nPeriods);
  const hitRate = periodICs.filter((v) => v > 0).length / nPeriods;

  const avgBreadth = breadthCount > 0 ? breadthSum / breadthCount : 0;
  const breadthPerYear = avgBreadth * periodsPerYear;
  const irTheoretical = icMean * Math.sqrt(Math.max(0, breadthPerYear));

  // Task1: 相関ディスカウント。BR_eff = k_eff(横断) × ess独立リバランス/年(時間)。
  //  横断: 残差相関行列の参加比 ι=N_eff/N で、選抜 k 銘柄の実効独立ベット数 k_eff = k·ι。
  //  表示用 ρ_xs は k_eff = k/(1+(k−1)ρ) を満たす等価平均相関(直感用)。
  const indepRatio = computeIndependenceRatio(series, calendar);
  const kEffPerRebalance = Math.max(1, avgBreadth * indepRatio);
  const rhoXs = avgBreadth > 1 ? Math.max(0, (avgBreadth / kEffPerRebalance - 1) / (avgBreadth - 1)) : 0;
  const essRebalances = effectiveSample(periodRets);
  const temporalEff = nPeriods > 0 ? essRebalances / nPeriods : 1;
  const breadthPerYearEff = kEffPerRebalance * (essRebalances / years);
  const irTheoreticalDiscounted = icMean * Math.sqrt(Math.max(0, breadthPerYearEff));
  const icTEff = icIR * Math.sqrt(Math.max(1, essRebalances));

  const perPeriodSharpe = (rs: number[]) => { const sd = std(rs); return sd > 0 ? mean(rs) / sd : 0; };

  // ブック成績(グロス)
  const sharpeRealizedGross = perPeriodSharpe(periodRets) * Math.sqrt(periodsPerYear);
  const annGross = mean(periodRets) * periodsPerYear;

  // フラットコスト(従来): 片道costBps × 往復
  const cost = params.costBps / 1e4;
  const netRetsFlat = periodRets.map((r, i) => r - cost * 2 * periodTurnovers[i]);

  // Task2: 楽天証券・実コスト会計。
  //  スプレッド往復(bid-askバウンス=微細構造) + 信用金利(買方)/貸株料(売方) + 諸経費。
  const marginKind = params.marginKind ?? DEFAULT_MARGIN_KIND;
  const rate = resolveMarginRate(marginKind);
  const halfSpread = medSpreadBps / 1e4; // 片道(半スプレッド)率
  const G = params.grossLeverage;
  const financeRateAnnual = G * (0.5 * rate.longRate + 0.5 * rate.shortRate); // 買方金利+貸株料
  // 諸経費: 事務管理費(建玉notional・両側)+ 名義書換料(買建のみ)。代表株価=最新終値の中央値。
  const lastCloses = series.map((s) => s.close[s.close.length - 1]).filter((v) => v > 0).sort((a, b) => a - b);
  const medPrice = lastCloses.length ? lastCloses[Math.floor(lastCloses.length / 2)] : 0;
  const otherRateAnnual = medPrice > 0
    ? adminFeeMonthlyRate(medPrice) * 12 * G + transferFeeAnnualRate(medPrice) * (G / 2)
    : 0;
  const dtFrac = reb / 252; // 保有期間(年)
  const spreadCosts = periodTurnovers.map((tv) => 2 * tv * halfSpread); // Σ|Δw|=2·回転 が半スプレッドを跨ぐ
  const financeCostPer = financeRateAnnual * dtFrac; // 期あたり(定数)
  const otherCostPer = otherRateAnnual * dtFrac;
  const netRetsReal = periodRets.map((r, i) => r - spreadCosts[i] - financeCostPer - otherCostPer);

  const spreadDragAnnual = mean(spreadCosts) * periodsPerYear;
  const financeDragAnnual = financeCostPer * periodsPerYear;
  const otherDragAnnual = otherCostPer * periodsPerYear;
  const totalDragAnnual = spreadDragAnnual + financeDragAnnual + otherDragAnnual;
  const annNetReal = mean(netRetsReal) * periodsPerYear;
  const sharpeRealizedNetReal = perPeriodSharpe(netRetsReal) * Math.sqrt(periodsPerYear);

  // 表示の net はコストモデル選択に追従(グラフ・主要指標が誠実に一致するように)
  const useReal = params.costModel === "rakuten";
  const netRets = useReal ? netRetsReal : netRetsFlat;
  const sharpeRealizedNet = perPeriodSharpe(netRets) * Math.sqrt(periodsPerYear);
  const annNet = mean(netRets) * periodsPerYear;

  // コスト分岐点: mean(r) − c*·2·meanTurn = 0 → c* = mean(r)/(2·meanTurn)
  const meanTurn = mean(periodTurnovers);
  const costBreakevenBps = meanTurn > 0 ? (mean(periodRets) / (2 * meanTurn)) * 1e4 : Infinity;
  const turnoverPerYear = meanTurn * periodsPerYear;

  // 市場中立性: LSリターンを対等加重ユニバースリターンに回帰したβ
  const marketBeta = (() => {
    const mu = mean(universeRets), mb = mean(periodRets);
    let cov = 0, vv = 0;
    for (let i = 0; i < nPeriods; i++) { const du = universeRets[i] - mu; cov += du * (periodRets[i] - mb); vv += du * du; }
    return vv > 0 ? cov / vv : 0;
  })();

  // エクイティ(複利)
  const equity: XEquityPoint[] = [];
  let cg = 1, cn = 1;
  for (let i = 0; i < nPeriods; i++) {
    cg *= 1 + periodRets[i];
    cn *= 1 + netRets[i];
    equity.push({ time: periodDates[i], gross: cg - 1, net: cn - 1 });
  }
  let peak = -Infinity, maxDD = 0;
  for (const e of equity) { const w = 1 + e.net; peak = Math.max(peak, w); const dd = (w - peak) / peak; if (dd < maxDD) maxDD = dd; }

  return {
    ok: true, from, to, years, nPeriods, avgBreadth, universeSize: universeSizeMax,
    icMean, icStd, icIR, icT, hitRate, breadthPerYear, irTheoretical,
    rhoXs, kEffPerRebalance, temporalEff, essRebalances, breadthPerYearEff,
    irTheoreticalDiscounted, icTEff,
    sharpeRealizedGross, sharpeRealizedNet, annGross, annNet, maxDD,
    turnoverPerYear, costBreakevenBps,
    medSpreadBps, spreadSurvives: isFinite(costBreakevenBps) && costBreakevenBps > medSpreadBps,
    realCost: useReal, spreadDragAnnual, financeDragAnnual, otherDragAnnual, totalDragAnnual,
    annNetReal, sharpeRealizedNetReal, realCostSurvives: annNetReal > 0, marginKind,
    marketBeta, equity, spans,
    nExtendToEnd, survivorWarn: nExtendToEnd === series.length && series.length >= 4,
    params,
  };
}
