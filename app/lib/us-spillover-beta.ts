// 方法2: スピルオーバーβ と「ギャップ織り込み分解」。
//
// 前夜米国リターン r_US に対し、JPの (ギャップ / 日中 / 当日) を単回帰し、
// 米国の値動きが「寄りギャップで既に消化されたか、日中に漏れ出すか」を分離する。
//   β_gap  = ∂gap/∂r_US    寄りギャップへの織り込み度
//   β_intra= ∂intra/∂r_US  日中への漏れ出し(符号が要点)
//   β_full = ∂full/∂r_US = β_gap + β_intra  当日トータルの感応度
//
// β_intra > 0 → 米国の方向が日中も続く(過小反応/順張り継続)
// β_intra < 0 → 寄りで行き過ぎ、日中に戻す(過剰反応/フェード = 逆張り妙味)

import { AlignedDay, ols, bootBetaCI, Regression } from "./us-spillover-core";

export interface BetaLine {
  reg: Regression;
  ci: { lo: number; hi: number; stable: number };
}

export type ReactionKind = "momentum" | "fade" | "neutral";

export interface BetaSample {
  us: number;
  gap: number;
  intra: number;
  full: number;
  date: string;
}

export interface BetaResult {
  n: number;
  gap: BetaLine;
  intra: BetaLine;
  full: BetaLine;
  absorption: number; // β_gap / β_full : 米国変動が寄りで消化される割合
  leak: number; // β_intra / β_full : 日中に漏れ出す割合
  reaction: ReactionKind; // β_intra の符号・有意性から
  samples: BetaSample[];
}

function line(x: number[], y: number[]): BetaLine | null {
  const reg = ols(x, y);
  if (!reg) return null;
  return { reg, ci: bootBetaCI(x, y) };
}

export function computeBeta(aligned: AlignedDay[]): BetaResult | null {
  const rows = aligned.filter(
    (a) => isFinite(a.us.ret) && isFinite(a.gap) && isFinite(a.intra) && isFinite(a.full)
  );
  if (rows.length < 8) return null;
  const x = rows.map((a) => a.us.ret);
  const gap = line(x, rows.map((a) => a.gap));
  const intra = line(x, rows.map((a) => a.intra));
  const full = line(x, rows.map((a) => a.full));
  if (!gap || !intra || !full) return null;

  const bFull = full.reg.beta;
  const absorption = Math.abs(bFull) > 1e-9 ? gap.reg.beta / bFull : NaN;
  const leak = Math.abs(bFull) > 1e-9 ? intra.reg.beta / bFull : NaN;

  let reaction: ReactionKind = "neutral";
  if (intra.reg.pBeta < 0.1) reaction = intra.reg.beta > 0 ? "momentum" : "fade";

  const samples: BetaSample[] = rows.map((a) => ({
    us: a.us.ret, gap: a.gap, intra: a.intra, full: a.full, date: a.jp.date,
  }));

  return { n: rows.length, gap, intra, full, absorption, leak, reaction, samples };
}
