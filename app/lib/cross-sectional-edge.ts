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
  costBps: number; // 片道コスト(bp)。回転に比例して控除
  grossLeverage: number; // 総エクスポージャ(ロング+ショートの絶対値合計)
  membership?: Record<string, { from?: string; to?: string }>; // point-in-time 在籍窓の上書き
}

export const DEFAULT_X_PARAMS: XParams = {
  signal: "reversal1",
  rebalanceDays: 1,
  quantile: 0.3,
  costBps: 0,
  grossLeverage: 1,
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
  breadthPerYear: number; // 年あたり独立ベット数 ≈ avgBreadth × リバランス/年
  irTheoretical: number; // IC·√(breadthPerYear)(年率の理論IR)
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

export function computeCrossSectional(
  pricesByTicker: Record<string, PricePoint[]>,
  names: Record<string, string>,
  params: XParams,
): XResult {
  const empty = (reason: string): XResult => ({
    ok: false, reason, from: "", to: "", years: 0, nPeriods: 0, avgBreadth: 0, universeSize: 0,
    icMean: 0, icStd: 0, icIR: 0, icT: 0, hitRate: 0, breadthPerYear: 0, irTheoretical: 0,
    sharpeRealizedGross: 0, sharpeRealizedNet: 0, annGross: 0, annNet: 0, maxDD: 0,
    turnoverPerYear: 0, costBreakevenBps: 0, medSpreadBps: 0, spreadSurvives: false,
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

  // ブック成績(グロス/ネット)
  const cost = params.costBps / 1e4;
  const netRets = periodRets.map((r, i) => r - cost * 2 * periodTurnovers[i]); // 片道×2=往復近似
  const perPeriodSharpe = (rs: number[]) => { const sd = std(rs); return sd > 0 ? mean(rs) / sd : 0; };
  const sharpeRealizedGross = perPeriodSharpe(periodRets) * Math.sqrt(periodsPerYear);
  const sharpeRealizedNet = perPeriodSharpe(netRets) * Math.sqrt(periodsPerYear);
  const annGross = mean(periodRets) * periodsPerYear;
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
    sharpeRealizedGross, sharpeRealizedNet, annGross, annNet, maxDD,
    turnoverPerYear, costBreakevenBps,
    medSpreadBps, spreadSurvives: isFinite(costBreakevenBps) && costBreakevenBps > medSpreadBps,
    marketBeta, equity, spans,
    nExtendToEnd, survivorWarn: nExtendToEnd === series.length && series.length >= 4,
    params,
  };
}
