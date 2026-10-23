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
