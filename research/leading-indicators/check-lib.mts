import { readFileSync } from "node:fs";
import { LEAD_CANDIDATES, GAP_MODEL_TICKERS, buildJpTargets, alignFeature, scanLeads, fitGapModel, bigMoves } from "../../app/lib/cross-asset-lead";
const D = "research/leading-indicators/data/";
const load = (t: string) => readFileSync(D + t.replace(/[\^=]/g, "_") + ".csv", "utf8").trim().split("\n").slice(1).map(l => { const [time, open, high, low, close, volume] = l.split(","); return { time, open: +open, high: +high, low: +low, close: +close, volume: +volume }; });
const jp = load(process.argv[2] ?? "8306.T");
const T = buildJpTargets(jp);
const feats = LEAD_CANDIDATES.map(c => ({ ticker: c.ticker, ...alignFeature(T.times, load(c.ticker), c.kind) }));
let t0 = Date.now();
const R = scanLeads({ targets: T, features: feats, nNull: 300 });
console.log("scan ms", Date.now() - t0, "days", R.nDays, R.firstTime, R.lastTime, "nTests", R.nTests, "sig", R.nFamilySig, "q95", R.nullQ95);
for (const h of ["gap", "id", "oo", "f5"]) {
  const top = R.cells.filter(c => c.horizon === h).sort((a, b) => Math.abs(b.t) - Math.abs(a.t)).slice(0, 5);
  console.log(h, top.map(c => `${c.ticker}:${c.feat} t=${c.t.toFixed(2)} tc=${c.tCtrl.toFixed(2)} r2o=${c.oosR2.toFixed(3)} yrs=${c.yearsPos}/${c.years} p=${c.pFamily.toFixed(3)}`).join(" | "));
}
const g = fitGapModel(T, GAP_MODEL_TICKERS.map(t => { const f = feats.find(x => x.ticker === t)!; return { ticker: t, d1: f.d1, nextD1: f.nextD1 }; }));
console.log("gap model", JSON.stringify(g, null, 0));
const gc = feats.find(f => f.ticker === "GC=F")!;
console.log(bigMoves(T, gc.d1).map(r => `${r.side}${r.horizon} ${ (r.mean*1e4).toFixed(0)}±${(r.ci*1e4).toFixed(0)} n${r.n}`).join(", "));
