// derisk-cross.ts（ストレス退避規則の横断版）の回帰テスト。docs/derisk-rule-design.md §6 P3。
// 計算は computeDerisk に委ねるので、ここで縛るのは横断固有の部分だけ:
//   共通2灯の取り出し・並び順・集計・行数不足と終値のみ系列の扱い・判断日の多数派。

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildDeriskCross, compareCrossRows, isCloseOnlySeries, MIN_ROWS, type DeriskCrossRow } from "../derisk-cross";
import type { PricePoint } from "../types";
import { makeNormal, mulberry32 } from "./helpers/rng";

/** 平日だけの日付列（東証の休場日表は無視。nextTradingDay はこのテストの対象外） */
function weekdays(n: number, start = "2023-01-02"): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function series(times: string[], seed: number, opts: { crashFrom?: number; crashLen?: number; vol?: number } = {}): PricePoint[] {
  const normal = makeNormal(mulberry32(seed));
  const vol = opts.vol ?? 0.012;
  let c = 1000;
  return times.map((time, i) => {
    let r = 0.0002 + vol * normal();
    if (opts.crashFrom !== undefined && i >= opts.crashFrom && i < opts.crashFrom + (opts.crashLen ?? 15)) r = -0.02 + 0.01 * normal();
    const open = c;
    c = c * Math.exp(r);
    return { time, open, high: Math.max(open, c), low: Math.min(open, c), close: c, volume: 1000 };
  });
}

function closeOnlyOf(p: PricePoint[]): PricePoint[] {
  return p.map((x) => ({ ...x, open: x.close, high: x.close, low: x.close, volume: 0 }));
}

describe("isCloseOnlySeries", () => {
  test("4本値同値・出来高0 の系列だけ true", () => {
    const t = weekdays(5);
    assert.equal(isCloseOnlySeries(series(t, 1)), false);
    assert.equal(isCloseOnlySeries(closeOnlyOf(series(t, 1))), true);
    assert.equal(isCloseOnlySeries([]), false);
  });
});

describe("compareCrossRows", () => {
  const row = (ticker: string, kind: "held" | "target", holding: boolean | null, stress = 0): DeriskCrossRow => ({
    ticker, name: ticker, kind, isNext: true, historyStart: null, closeOnly: false, skipped: holding === null ? "x" : null,
    state: holding === null ? null : { time: "2024-01-05", stress, holding, calm: 0, lights: [], usAsOf: "", vixAsOf: "", kreAsOf: "", usStale: false },
  });
  test("現金 → 点灯数の多い順 → 保有が先 → ティッカー。計算できない行は末尾", () => {
    const rows = [row("D", "target", true, 1), row("A", "target", true, 0), row("C", "held", true, 1), row("B", "held", false, 3), row("Z", "held", null), row("E", "target", false, 2)];
    rows.sort(compareCrossRows);
    assert.deepEqual(rows.map((r) => r.ticker), ["B", "E", "C", "D", "A", "Z"]);
  });
});

describe("buildDeriskCross（合成）", () => {
  const t = weekdays(400);
  const vix = series(t, 11, { vol: 0.05 });
  const kre = series(t, 12);
  // X は 300 日目から暴落（固有2灯が点く）、Y は平穏、Z は投信（終値のみ）、S は行数不足
  const X = series(t, 21, { crashFrom: 380, crashLen: 15 });
  const Y = series(t, 22);
  const Z = closeOnlyOf(series(t, 23));
  const S = series(t.slice(0, MIN_ROWS - 1), 24);
  const res = buildDeriskCross([
    { ticker: "Y.T", name: "Y", kind: "target", prices: Y },
    { ticker: "X.T", name: "X", kind: "held", prices: X },
    { ticker: "Z", name: "Z", kind: "held", prices: Z },
    { ticker: "S.T", name: "S", kind: "target", prices: S },
  ], vix, kre);

  test("行数不足は skipped、投信は closeOnly でも状態が出る、共通2灯は全行で同じ値", () => {
    const by = Object.fromEntries(res.rows.map((r) => [r.ticker, r]));
    assert.ok(by["S.T"].skipped && by["S.T"].state === null);
    assert.equal(by["Z"].closeOnly, true);
    assert.ok(by["Z"].state);
    assert.ok(res.common);
    for (const r of res.rows) {
      if (!r.state) continue;
      const v = r.state.lights.find((l) => l.key === "vixRatio")!;
      const k = r.state.lights.find((l) => l.key === "kreDd60")!;
      assert.equal(v.value, res.common!.vix.value);
      assert.equal(k.value, res.common!.kre.value);
    }
  });

  test("判断日: 最終日 2024-07-12 の翌月曜は海の日。東証暦に従う .T は 7/16、従わない Z は 7/15 になり、多数派が nextTime", () => {
    const by = Object.fromEntries(res.rows.map((r) => [r.ticker, r]));
    assert.equal(by["X.T"].state!.time, "2024-07-16");
    assert.equal(by["Y.T"].state!.time, "2024-07-16");
    assert.equal(by["Z"].state!.time, "2024-07-15");
    assert.equal(res.nextTimeDiffers, true);
    assert.equal(res.nextTime, "2024-07-16");
  });

  test("判断日: 全銘柄が東証暦なら nextTimeDiffers=false", () => {
    const r2 = buildDeriskCross([
      { ticker: "X.T", name: "X", kind: "held", prices: X },
      { ticker: "Y.T", name: "Y", kind: "target", prices: Y },
    ], vix, kre);
    assert.equal(r2.nextTimeDiffers, false);
    assert.equal(r2.nextTime, "2024-07-16");
  });

  test("集計: total/computed/held と現金・警戒の数が行と整合する", () => {
    const s = res.summary;
    assert.equal(s.total, 4);
    assert.equal(s.computed, 3);
    assert.equal(s.held, 2);
    const cash = res.rows.filter((r) => r.state && !r.state.holding);
    const warn = res.rows.filter((r) => r.state && r.state.holding && r.state.stress > 0);
    assert.equal(s.cash, cash.length);
    assert.equal(s.warn, warn.length);
    assert.equal(s.heldCash, cash.filter((r) => r.kind === "held").length);
    assert.equal(s.heldWarn, warn.filter((r) => r.kind === "held").length);
  });

  test("暴落した X は、X 固有の dd60 灯が点き、平穏な Y より上に並ぶ", () => {
    const x = res.rows.find((r) => r.ticker === "X.T")!;
    const y = res.rows.find((r) => r.ticker === "Y.T")!;
    const ddX = x.state!.lights.find((l) => l.key === "dd60")!;
    assert.equal(ddX.lit, true, `dd60 ${ddX.value}`);
    assert.ok(x.state!.stress >= y.state!.stress);
    assert.ok(res.rows.indexOf(x) < res.rows.indexOf(y));
  });

  test("空の入力でも落ちない", () => {
    const e = buildDeriskCross([], vix, kre);
    assert.equal(e.rows.length, 0);
    assert.equal(e.common, null);
    assert.equal(e.nextTime, null);
    assert.equal(e.summary.total, 0);
  });
});
