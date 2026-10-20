import { fetchStockSource } from "../../app/lib/stock-source.server";
import { repairPriceGlitches } from "../../app/lib/price-sanity";
import { writeFileSync } from "node:fs";
const out = process.argv[2];
const tickers = process.argv.slice(3);
for (const t of tickers) {
  try {
    const d = await fetchStockSource(t, "10y");
    const f = repairPriceGlitches(d.prices, { ticker: t });
    const rows = ["time,open,high,low,close,volume", ...f.prices.map(p => `${p.time},${p.open},${p.high},${p.low},${p.close},${p.volume}`)];
    writeFileSync(`${out}/${t.replace(/[\^=]/g, "_")}.csv`, rows.join("\n"));
    console.log(t, f.prices.length, f.prices[0]?.time, f.prices.at(-1)?.time, "repaired", f.report.repaired.length, "suspects", f.report.suspects.length);
  } catch (e) { console.log(t, "FAIL", String(e).slice(0,150)); }
}
