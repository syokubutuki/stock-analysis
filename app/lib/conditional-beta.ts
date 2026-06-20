// 7.5 条件付きベータ・下方ベータ。
// 上昇相場/下落相場で分けたβ、下方β（ベンチが下げる時の感応度）を測る。
// 下方βが大きい＝地合い悪化時に大きく下げる脆さ。

import { PricePoint } from "./types";
import { alignSeries } from "./benchmark";

export interface CondBetaResult {
  betaAll: number;
  betaUp: number; // ベンチ上昇日のβ
  betaDown: number; // ベンチ下落日のβ
  downsideBeta: number; // ベンチが平均以下の日のβ
  corr: number;
  nUp: number;
  nDown: number;
}

function rets(p: PricePoint[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < p.length; i++) r.push(p[i - 1].close > 0 ? p[i].close / p[i - 1].close - 1 : 0);
  return r;
}
function beta(rs: number[], rb: number[]): number {
  const n = rs.length;
  if (n < 2) return 0;
  const ms = rs.reduce((s, v) => s + v, 0) / n;
  const mb = rb.reduce((s, v) => s + v, 0) / n;
  let cov = 0, varb = 0;
  for (let i = 0; i < n; i++) { cov += (rs[i] - ms) * (rb[i] - mb); varb += (rb[i] - mb) ** 2; }
  return varb > 0 ? cov / varb : 0;
}

export function conditionalBeta(stock: PricePoint[], bench: PricePoint[]): CondBetaResult | null {
  const { stock: s, bench: b } = alignSeries(stock, bench);
  if (s.length < 30) return null;
  const rs = rets(s), rb = rets(b);
  const mb = rb.reduce((sum, v) => sum + v, 0) / rb.length;

  const upS: number[] = [], upB: number[] = [], dnS: number[] = [], dnB: number[] = [], dsS: number[] = [], dsB: number[] = [];
  for (let i = 0; i < rs.length; i++) {
    if (rb[i] > 0) { upS.push(rs[i]); upB.push(rb[i]); }
    else if (rb[i] < 0) { dnS.push(rs[i]); dnB.push(rb[i]); }
    if (rb[i] < mb) { dsS.push(rs[i]); dsB.push(rb[i]); }
  }

  // 相関
  const ms = rs.reduce((sum, v) => sum + v, 0) / rs.length;
  let cov = 0, vs = 0, vb = 0;
  for (let i = 0; i < rs.length; i++) { cov += (rs[i] - ms) * (rb[i] - mb); vs += (rs[i] - ms) ** 2; vb += (rb[i] - mb) ** 2; }
  const corr = vs > 0 && vb > 0 ? cov / Math.sqrt(vs * vb) : 0;

  return {
    betaAll: beta(rs, rb),
    betaUp: beta(upS, upB),
    betaDown: beta(dnS, dnB),
    downsideBeta: beta(dsS, dsB),
    corr,
    nUp: upS.length,
    nDown: dnS.length,
  };
}
