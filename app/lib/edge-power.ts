// 検出力の壁: 「このエッジは今の標本で証明できるか。できないなら何が要るか」を解く。
// -------------------------------------------------------------
// 本当に小さいエッジ(1取引あたり数bp)は、単一銘柄・10年では原理的に有意化できない。
// t = SR·√T なので、年率シャープ0.2のエッジを t=3 にするには T≈225年ぶんの標本が要る。
// この分析は各エッジについて次を出す:
//   (a) 検出可能性: 観測効果の t、最小検出可能効果 MDE、t* に必要な標本数 n_req・年数。
//   (b) 目標エッジ μ_target(スライダ)を検出するのに必要な標本数と、それを横断プールで
//       稼ぐ場合の必要ブレッドス(銘柄数)。
//   (c) ブレッドスの天井: 同じ日は銘柄がまとめて動く(横断相関 ρ)ので、銘柄を増やしても
//       実効標本 n_eff は n/ρ で飽和する。ゆえに「ρが高いと、どれだけ銘柄を足しても
//       証明できない小エッジ」が存在する ── これが検出力の壁の正体。
//
// 数式(1標本・分散既知の正規近似):
//   1取引効果量 e = μ/σ、観測 t = e·√n。
//   MDE(有意水準α両側・検出力1−β) = (z_{1−α/2}+z_{1−β})·σ/√n。
//   目標効果 e_t を (α,β) で検出する必要標本 n_req = ((z_{1−α/2}+z_{1−β})/e_t)²。
//   目標効果を t* で「見える」ようにするなら n_req = (t*/e_t)²(検出力50%基準)。
//   ブレッドス B 本を同期間プールした実効標本 n_eff(B) = n·B/(1+(B−1)ρ) → B→∞ で n/ρ に飽和。
//   n_eff(B) = n_req を解くと B = R(1−ρ)/(1−Rρ)(R=n_req/n)、Rρ≥1 なら有限のBでは到達不能。
import { PricePoint } from "./types";
import { EdgeSeries, directedReturns } from "./edge-trades";
import { mean, std } from "./stats-significance";
import { Side } from "./weekday-trade";

export interface PowerParams {
  alpha: number; // 有意水準(両側)
  power: number; // 目標検出力 1−β
  tStar: number; // 「証明済み」とみなす t の閾値(単一発見なら2、多重探索の中なら3〜)
  targetMuBp: number; // 検出したい仮想の真エッジ(1取引あたり, bp)
  rhoCross: number; // 横断プール時の平均相関(ブレッドスの目減りを決める)
  maxBreadth: number; // これを超える必要銘柄数は「非現実的」とみなす上限
}

export const DEFAULT_POWER_PARAMS: PowerParams = {
  alpha: 0.05,
  power: 0.8,
  tStar: 3,
  targetMuBp: 5,
  rhoCross: 0.3,
  maxBreadth: 500,
};

export type Verdict = "provable-now" | "needs-time" | "needs-breadth" | "unprovable-alone";

export const VERDICT_LABEL: Record<Verdict, string> = {
  "provable-now": "現時点で証明可",
  "needs-time": "時間で到達可",
  "needs-breadth": "ブレッドスで到達可",
  "unprovable-alone": "この銘柄単独では証明不能",
};

export interface PowerRow {
  id: string;
  label: string;
  holdLabel: string;
  direction: Side;
  n: number;
  tradesPerYear: number;
  years: number;
  muBp: number; // 方向調整後の1取引平均(bp)
  sdBp: number; // 1取引標準偏差(bp)
  eff: number; // 効果量 e = μ/σ (1取引あたり)
  t: number; // 観測 |t| = e·√n
  srAnnual: number; // 年率シャープ = e·√(tradesPerYear)
  mdeBp: number; // 最小検出可能効果(bp, 現在のnで)
  // t* に到達させる(観測効果を保ったまま)ための必要量
  nReqTStar: number;
  yearsReqTStar: number;
  breadthReqTStar: number; // 横断プールでt*に必要な銘柄数(∞なら天井超え=不能)
  // 目標エッジ μ_target を (α,power) で検出する必要量
  powerAtTarget: number; // 現在のnで μ_target を検出できる確率
  nReqTarget: number;
  yearsReqTarget: number;
  breadthReqTarget: number;
  verdict: Verdict;
}

export interface FrontierPoint {
  muBp: number; // 目標エッジ(bp)
  nReq: number; // (α,power)で検出する必要標本
  yearsReq: number; // この銘柄の頻度で必要年数
  breadthReq: number; // 横断プールで必要な銘柄数(Infinityは天井超え)
  reachable: boolean; // maxBreadth 以内で到達可能か
}

export interface PowerResult {
  ok: boolean;
  reason?: string;
  rows: PowerRow[]; // 年率シャープ降順
  frontier: FrontierPoint[]; // 代表エッジ(頻度)に対する μ→必要ブレッドス曲線
  refEdgeLabel: string; // frontier の基準にしたエッジ
  nCeiling: number; // ブレッドス天井 n/ρ(基準エッジ, 実効標本の上限)
  params: PowerParams;
}

// ---------------------------------------------------------------
// 正規分位点(Acklam) と 標準正規CDF
// ---------------------------------------------------------------
function invNormalCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  let q: number, r: number;
  if (p < plow) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= phigh) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normalCdf(x: number): number { return 0.5 * (1 + erf(x / Math.SQRT2)); }

// 横断プールで必要ブレッドス。n_eff(B)=n·B/(1+(B−1)ρ) が n_req に届くBを解く。
// R=n_req/n。Rρ≥1 なら天井(n/ρ)を超えるので有限のBでは不能 → Infinity。
export function breadthFor(nReq: number, n: number, rho: number): number {
  if (n <= 0) return Infinity;
  if (nReq <= n) return 1;
  const R = nReq / n;
  const r = Math.max(0, Math.min(0.999, rho));
  if (r <= 1e-9) return R; // 無相関なら素直にR倍の銘柄
  if (R * r >= 1) return Infinity; // 天井 n/ρ を超える
  const B = (R * (1 - r)) / (1 - R * r);
  return Math.max(1, B);
}

// ---------------------------------------------------------------
// メイン
// ---------------------------------------------------------------
export function computeEdgePower(
  prices: PricePoint[],
  catalog: EdgeSeries[],
  params: PowerParams = DEFAULT_POWER_PARAMS,
): PowerResult {
  if (catalog.length === 0) {
    return { ok: false, reason: "エッジ・カタログが空です。", rows: [], frontier: [], refEdgeLabel: "", nCeiling: 0, params };
  }
  const yrsSpan = (() => {
    if (prices.length < 2) return 1;
    const t0 = new Date(prices[0].time).getTime();
    const t1 = new Date(prices[prices.length - 1].time).getTime();
    return Math.max((t1 - t0) / (365.25 * 24 * 3600 * 1000), 1e-6);
  })();

  const zA = invNormalCdf(1 - params.alpha / 2);
  const zB = invNormalCdf(params.power);
  const zSum = zA + zB;

  const rows: PowerRow[] = [];
  for (const edge of catalog) {
    const raw = mean(edge.trades.map((t) => t.ret));
    const direction: Side = raw >= 0 ? "long" : "short";
    const rets = directedReturns(edge, direction);
    const n = rets.length;
    if (n < 20) continue;
    const mu = mean(rets);
    const sd = std(rets);
    if (!(sd > 0)) continue;
    const eff = mu / sd; // 1取引効果量(>0: 方向調整後)
    const t = eff * Math.sqrt(n);
    const srAnnual = eff * Math.sqrt(edge.tradesPerYear);
    const mdeBp = (zSum * sd) / Math.sqrt(n) * 1e4;

    // t* に到達させる(観測効果 eff を保つ)ための n。t*=eff·√n_req。
    const nReqTStar = eff > 0 ? Math.pow(params.tStar / eff, 2) : Infinity;
    const yearsReqTStar = nReqTStar / Math.max(1e-9, edge.tradesPerYear);
    const breadthReqTStar = breadthFor(nReqTStar, n, params.rhoCross);

    // 目標エッジ μ_target を検出する。効果量 e_t = μ_target/σ。
    const muT = params.targetMuBp / 1e4;
    const eT = muT / sd;
    const ncp = eT * Math.sqrt(n); // 非心度
    const powerAtTarget = normalCdf(ncp - zA) + normalCdf(-ncp - zA);
    const nReqTarget = eT > 0 ? Math.pow(zSum / eT, 2) : Infinity;
    const yearsReqTarget = nReqTarget / Math.max(1e-9, edge.tradesPerYear);
    const breadthReqTarget = breadthFor(nReqTarget, n, params.rhoCross);

    let verdict: Verdict;
    if (t >= params.tStar) verdict = "provable-now";
    else if (!isFinite(breadthReqTStar)) verdict = "unprovable-alone";
    else if (yearsReqTStar <= yrsSpan * 2.5) verdict = "needs-time";
    else if (breadthReqTStar <= params.maxBreadth) verdict = "needs-breadth";
    else verdict = "unprovable-alone";

    rows.push({
      id: edge.id, label: edge.label, holdLabel: edge.holdLabel, direction,
      n, tradesPerYear: edge.tradesPerYear, years: yrsSpan,
      muBp: mu * 1e4, sdBp: sd * 1e4, eff, t, srAnnual, mdeBp,
      nReqTStar, yearsReqTStar, breadthReqTStar,
      powerAtTarget, nReqTarget, yearsReqTarget, breadthReqTarget,
      verdict,
    });
  }

  rows.sort((a, b) => b.srAnnual - a.srAnnual);

  // 検出フロンティア: 中頻度の代表エッジを基準に μ→必要ブレッドス。
  // 代表 = 日次頻度(tradesPerYear最大)のエッジ。σ もそのエッジのもの。
  const ref = [...rows].sort((a, b) => b.tradesPerYear - a.tradesPerYear)[0] ?? rows[0];
  const frontier: FrontierPoint[] = [];
  let nCeiling = 0;
  if (ref) {
    const sd = ref.sdBp / 1e4;
    const nRef = ref.n;
    nCeiling = nRef / Math.max(1e-9, Math.min(0.999, params.rhoCross));
    for (const muBp of [1, 2, 3, 5, 8, 12, 20, 30, 50]) {
      const eT = (muBp / 1e4) / sd;
      const nReq = eT > 0 ? Math.pow(zSum / eT, 2) : Infinity;
      const breadthReq = breadthFor(nReq, nRef, params.rhoCross);
      frontier.push({
        muBp, nReq,
        yearsReq: nReq / Math.max(1e-9, ref.tradesPerYear),
        breadthReq,
        reachable: isFinite(breadthReq) && breadthReq <= params.maxBreadth,
      });
    }
  }

  return {
    ok: rows.length > 0,
    reason: rows.length === 0 ? "有効なエッジがありません(各30取引以上必要)。" : undefined,
    rows, frontier, refEdgeLabel: ref?.label ?? "", nCeiling, params,
  };
}
