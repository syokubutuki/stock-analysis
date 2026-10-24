// TS 計算層（app/lib/derisk-rule.ts）を data_max の全期間に通し、研究文書の数字と突き合わせる。
// npm test の外（data_max は未追跡）。使い方: npx tsx research/bank-derisk/check-lib.mts
//
// 照合先（docs/bank-derisk-research.md §0 / §5 / r15_final.py）:
//   3メガバンク平均（2006-09〜、片道5bp）: 年率 10.4% / 最大DD −33.6% / Sharpe 0.48
//   recent（BD_DATA=data_max）: 8306.T 最終行 2026-10-14 stress=0/4 保有 vix比=0.99 volratio=1.19 dd60=−5.3% kre=−10.9%
import { readFileSync } from "node:fs";
import { computeDerisk, computeMetrics, type DeriskResult } from "../../app/lib/derisk-rule";
import type { PricePoint } from "../../app/lib/types";

const D = new URL("./data_max/", import.meta.url);
const load = (t: string): PricePoint[] =>
  readFileSync(new URL(t.replace(/[\^=]/g, "_") + ".csv", D), "utf8").trim().split("\n").slice(1).map((l) => {
    const [time, open, high, low, close, volume] = l.split(",");
    return { time, open: +open, high: +high, low: +low, close: +close, volume: +volume };
  });

const vix = load("^VIX"), kre = load("KRE");
const banks = ["8306.T", "8316.T", "8411.T"];
const results = new Map<string, DeriskResult>();
for (const t of banks) {
  const t0 = Date.now();
  const r = computeDerisk({ target: load(t), vix, kre, ticker: t, startTime: "2006-09-01" });
  results.set(t, r);
  const m = r.metrics!;
  console.log(`${t} rows ${r.rows.length} (${r.historyStart}〜${r.rows.at(-1)?.time}) ${Date.now() - t0}ms  rule CAGR ${(m.rule.cagr * 100).toFixed(1)}% MDD ${(m.rule.maxDrawdown * 100).toFixed(1)}% Sh ${m.rule.sharpe.toFixed(2)} | B&H ${(m.buyHold.cagr * 100).toFixed(1)}% / ${(m.buyHold.maxDrawdown * 100).toFixed(1)}% / ${m.buyHold.sharpe.toFixed(2)} | episodes ${r.episodes.length}`);
}

// バスケット: 日付の和集合の上で、銘柄ごとの純リターンを（欠損を飛ばして）平均する（pd.concat(axis=1).mean(axis=1)）。
const dates = new Set<string>();
for (const r of results.values()) for (const row of r.rows) if (row.net !== null) dates.add(row.time);
const sorted = [...dates].sort();
const byDate = new Map<string, { net: number[]; y: number[]; w: number[] }>();
for (const d of sorted) byDate.set(d, { net: [], y: [], w: [] });
for (const r of results.values()) for (const row of r.rows) if (row.net !== null) {
  const b = byDate.get(row.time)!; b.net.push(row.net); b.y.push(row.yOo as number); b.w.push(row.w);
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const net = sorted.map((d) => mean(byDate.get(d)!.net));
const y = sorted.map((d) => mean(byDate.get(d)!.y));
const w = sorted.map((d) => mean(byDate.get(d)!.w));
const mb = computeMetrics(net, w), bb = computeMetrics(y, w.map(() => 1));
console.log(`\n3メガ平均 2006-09〜 片道5bp: ルール CAGR ${(mb.cagr * 100).toFixed(1)}% MDD ${(mb.maxDrawdown * 100).toFixed(1)}% Sh ${mb.sharpe.toFixed(2)}  (研究: 10.4% / −33.6% / 0.48)`);
console.log(`                            B&H   CAGR ${(bb.cagr * 100).toFixed(1)}% MDD ${(bb.maxDrawdown * 100).toFixed(1)}% Sh ${bb.sharpe.toFixed(2)}  (研究: 5.8% / −83.0% / 0.17)`);

const eraLabels = ["2006-09〜2009", "2010〜2012", "2013〜2017", "2018〜"];
const eraRanges: [string, string | null][] = [["2006-09-01", "2009-12-31"], ["2010-01-01", "2012-12-31"], ["2013-01-01", "2017-12-31"], ["2018-01-01", null]];
console.log("\n時代別（3メガ平均）: ルール 年率/最大DD | B&H 年率/最大DD  （研究 §5.1: −4.4/−24.7 | −34.9/−78.8, 8.8/−32.1 | 6.5/−38.6, 11.6/−32.9 | 12.2/−50.0, 16.5/−33.6 | 22.6/−48.7）");
eraRanges.forEach(([a, b], i) => {
  const sel = sorted.map((d, k) => (d >= a && (b === null || d <= b) ? k : -1)).filter((k) => k >= 0);
  const mr = computeMetrics(sel.map((k) => net[k]), sel.map((k) => w[k])), mh = computeMetrics(sel.map((k) => y[k]), sel.map(() => 1));
  console.log(`  ${eraLabels[i].padEnd(14)} ${(mr.cagr * 100).toFixed(1)}% / ${(mr.maxDrawdown * 100).toFixed(1)}% | ${(mh.cagr * 100).toFixed(1)}% / ${(mh.maxDrawdown * 100).toFixed(1)}%`);
});

const r8306 = results.get("8306.T")!;
const L = r8306.latest!;
console.log(`\n8306.T 最終行 ${L.time} stress=${L.stress}/4 ${L.holding ? "保有" : "現金"} ` +
  L.lights.map((l) => `${l.key}=${l.key.startsWith("dd") || l.key === "kreDd60" ? (l.value * 100).toFixed(1) + "%" : l.value.toFixed(2)}`).join(" ") +
  `  usAsOf ${L.usAsOf} (研究 recent: 2026-10-14 0/4 保有 vix比 0.99 volratio 1.19 dd60 −5.3% kre −10.9%)`);
const N = r8306.next;
if (N) console.log(`8306.T 次の立会日 ${N.time}: stress=${N.stress}/4 ${N.holding ? "保有" : "現金"} usAsOf ${N.usAsOf}${N.usStale ? "（米国終値未着）" : ""}`);
console.log("\n8306.T 2026-03 のエピソード:", r8306.episodes.filter((e) => e.start >= "2026-02-01").map((e) => `${e.start}〜${e.end ?? "継続"} ${e.days}日 ${e.litAtEntry.join("+")} B&H ${e.bhReturn === null ? "-" : (e.bhReturn * 100).toFixed(1) + "%"}`));
console.log(`コスト感度（8306.T）: ` + r8306.costSensitivity.map((c) => `${c.costBp}bp → ${(c.rule.cagr * 100).toFixed(1)}% / ${(c.rule.maxDrawdown * 100).toFixed(1)}%`).join(", "));

// ───────── 頑健性（P2）: r14_robust.py (1)(3) と分位の向き・桁を照合 ─────────
// 研究（3メガ平均・2006-09〜・片道5bp）:
//   (1) ランダム配置ヌル 1000回: 最大DD 中央値 −71% [−81, −56] vs 実際 −34% / 年率 3.7% [0.3, 7.1] vs 10.4% / Sharpe 0.15 [0.01, 0.30] vs 0.48。3指標とも P(偶然 ≥ 実際) ≤ 0.001
//   (3) 定常ブロックブート 2000回: 最大DD差 +24.5pt [+4.2, +44.8] P=0.98 / Sharpe差 +0.31 [+0.01, +0.60] P=0.96 / 年率差 +4.4pt [−4.5, +13.4] P=0.80
// バスケットのヌルは研究と同じく銘柄ごとに配置してから平均する（ここで組む）。ブートは平均系列の上で computeRobustness をそのまま使う。
{
  const { episodeLengths, mulberry32, percentile, randomPlacement, stationaryBootstrapIndex } = await import("../../app/lib/derisk-robust");
  const { netReturns } = await import("../../app/lib/derisk-rule");
  const t0 = Date.now();
  const rand = mulberry32(20261023);
  const perAsset = banks.map((t) => {
    const rows = results.get(t)!.rows.filter((r) => r.net !== null);
    const pos = new Map(rows.map((r, i) => [r.time, i]));
    return { y: Float64Array.from(rows, (r) => r.yOo as number), lens: episodeLengths(rows.map((r) => r.w)), pos };
  });
  const NN = 1000;
  const dist = { cagr: new Float64Array(NN), maxDrawdown: new Float64Array(NN), sharpe: new Float64Array(NN) };
  for (let s = 0; s < NN; s++) {
    const nets = perAsset.map((a) => netReturns(randomPlacement(a.y.length, a.lens, rand).w, a.y, 0.0005));
    const nn = sorted.map((d) => { const xs: number[] = []; perAsset.forEach((a, i) => { const k = a.pos.get(d); if (k !== undefined) xs.push(nets[i][k]); }); return mean(xs); });
    const m = computeMetrics(nn, w);
    dist.cagr[s] = m.cagr; dist.maxDrawdown[s] = m.maxDrawdown; dist.sharpe[s] = m.sharpe;
  }
  console.log(`\n頑健性 (1) ランダム配置ヌル ${NN}回（3メガ平均・銘柄ごとに配置）  ${Date.now() - t0}ms`);
  for (const [k, act] of [["cagr", mb.cagr], ["maxDrawdown", mb.maxDrawdown], ["sharpe", mb.sharpe]] as const) {
    const d = Float64Array.from(dist[k]).sort();
    const f = (x: number) => (k === "sharpe" ? x.toFixed(2) : (x * 100).toFixed(1) + "%");
    let ge = 0; for (const v of d) if (v >= act) ge++;
    console.log(`  ${k.padEnd(12)} 偶然 ${f(percentile(d, 50))} [${f(percentile(d, 5))}, ${f(percentile(d, 95))}]  実際 ${f(act)}  P(偶然 ≥ 実際)=${(ge / NN).toFixed(3)}`);
  }
  const t1 = Date.now();
  // バスケットの平均建玉は 0/1 でなく、純リターンは銘柄ごとのコスト控除後の平均なので、
  // computeRobustness（w·y − c|Δw| を内部で作る）は使わず、差の分布をここで組む。
  const NB = 2000, n = y.length;
  const dd = { cagr: new Float64Array(NB), maxDrawdown: new Float64Array(NB), sharpe: new Float64Array(NB) };
  const nb = new Float64Array(n), yb = new Float64Array(n), ones = new Float64Array(n).fill(1);
  for (let b = 0; b < NB; b++) {
    const ix = stationaryBootstrapIndex(n, 20, rand);
    for (let i = 0; i < n; i++) { nb[i] = net[ix[i]]; yb[i] = y[ix[i]]; }
    const mr = computeMetrics(nb, ones), mh = computeMetrics(yb, ones);
    dd.cagr[b] = mr.cagr - mh.cagr; dd.maxDrawdown[b] = mr.maxDrawdown - mh.maxDrawdown; dd.sharpe[b] = mr.sharpe - mh.sharpe;
  }
  console.log(`頑健性 (3) 定常ブロックブート ${NB}回（平均20日・3メガ平均の純リターン vs 買い持ち）  ${Date.now() - t1}ms`);
  for (const k of ["maxDrawdown", "sharpe", "cagr"] as const) {
    const d = Float64Array.from(dd[k]).sort();
    const f = (x: number) => (k === "sharpe" ? (x >= 0 ? "+" : "") + x.toFixed(2) : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "pt");
    let pos = 0; for (const v of d) if (v > 0) pos++;
    console.log(`  ${k.padEnd(12)} 中央値 ${f(percentile(d, 50))}  90%CI [${f(percentile(d, 5))}, ${f(percentile(d, 95))}]  P(>0)=${(pos / NB).toFixed(2)}`);
  }
}
