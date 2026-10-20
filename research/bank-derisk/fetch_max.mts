// range=max の長期日足を取得し、アプリと同じ変換(adjclose倍率)＋ repairPriceGlitches を通して CSV 化する。
import { repairPriceGlitches } from "../../app/lib/price-sanity";
import { writeFileSync } from "node:fs";
const out = process.argv[2];
for (const t of process.argv.slice(3)) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?period1=946684800&period2=1792000000&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) { console.log(t, "HTTP", res.status); continue; }
  const r = (await res.json()).chart?.result?.[0];
  const ts: number[] = r.timestamp || []; const q = r.indicators.quote[0]; const adj = r.indicators.adjclose?.[0]?.adjclose;
  const prices = [] as any[];
  ts.forEach((s, i) => {
    const rc = q.close[i]; const c = adj ? adj[i] : rc; if (c == null || rc == null) return;
    const a = adj && rc !== 0 ? c / rc : 1; const d = new Date(s * 1000);
    const time = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    prices.push({ time, open: (q.open[i] ?? rc) * a, high: (q.high[i] ?? rc) * a, low: (q.low[i] ?? rc) * a, close: c, volume: q.volume[i] || 0 });
  });
  const f = repairPriceGlitches(prices, { ticker: t });
  const rows = ["time,open,high,low,close,volume", ...f.prices.map((p: any) => `${p.time},${p.open},${p.high},${p.low},${p.close},${p.volume}`)];
  writeFileSync(`${out}/${t.replace(/[\^=]/g, "_")}.csv`, rows.join("\n"));
  console.log(t, f.prices.length, f.prices[0]?.time, f.prices.at(-1)?.time, "repaired", f.report.repaired.length, "suspects", f.report.suspects.length, "removedClosed", f.report.removedClosedDays?.length ?? 0);
}
