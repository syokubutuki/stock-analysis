// derisk-robust.ts（ストレス退避規則の頑健性）の回帰テスト。docs/derisk-rule-design.md §2.7 / §4。
//
// 2層で縛る:
//   1. 合成: 配置の制約（重ならない・隣接しない・長さと本数を保つ）、幾何分布の台と平均、
//      定常ブートの添字の形（ブロック内は連続・循環）、numpy と同じ線形補間の分位、
//      植え込んだ暴落を避ける建玉では「偶然が上回る割合」が小さく出ること。
//   2. 黄金値: 黄金値フィクスチャ（8306.T 2018〜）の評価行に固定シードで通した要約値。
//      乱数列も黄金値の一部なので、乱数の実装や消費順を変えたらここが落ちるのが正常。

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  computeRobustness,
  episodeLengths,
  geometric,
  mulberry32,
  percentile,
  randomPlacement,
  stationaryBootstrapIndex,
} from "../derisk-robust";
import { computeDerisk } from "../derisk-rule";
import type { PricePoint } from "../types";
import { golden } from "./helpers/golden";
import { makeNormal } from "./helpers/rng";
import fx from "./fixtures/derisk-golden.json";

describe("episodeLengths", () => {
  test("現金（0）の連続区間の長さを順に返す。末尾の継続中も数える", () => {
    assert.deepEqual(episodeLengths([1, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0]), [3, 1, 2]);
    assert.deepEqual(episodeLengths([1, 1, 1]), []);
    assert.deepEqual(episodeLengths([0, 0]), [2]);
  });
});

describe("randomPlacement", () => {
  test("長さと本数を保ち、区間同士が重ならず隣接もしない", () => {
    const rand = mulberry32(7);
    const lens = [5, 3, 8, 1, 2];
    for (let rep = 0; rep < 50; rep++) {
      const { w, ok } = randomPlacement(200, lens, rand);
      assert.ok(ok);
      const got = episodeLengths(w);
      assert.deepEqual(got.slice().sort((a, b) => a - b), lens.slice().sort((a, b) => a - b));
      // 隣接禁止: 区間の本数が lens の本数と同じなら、どの2区間も少なくとも1日離れている
      assert.equal(got.length, lens.length);
    }
  });

  test("置けない（長さの合計が系列長を超える）と ok=false", () => {
    const { ok } = randomPlacement(10, [6, 6], mulberry32(1));
    assert.equal(ok, false);
  });

  test("同じシードなら同じ配置", () => {
    const a = randomPlacement(100, [4, 7], mulberry32(3)).w;
    const b = randomPlacement(100, [4, 7], mulberry32(3)).w;
    assert.deepEqual(Array.from(a), Array.from(b));
  });
});

describe("geometric / stationaryBootstrapIndex", () => {
  test("幾何分布は 1 以上で、平均が 1/p に近い", () => {
    const rand = mulberry32(11);
    let sum = 0, min = Infinity;
    const N = 20000;
    for (let i = 0; i < N; i++) { const k = geometric(rand, 1 / 20); sum += k; if (k < min) min = k; }
    assert.ok(min >= 1);
    assert.ok(Math.abs(sum / N - 20) < 0.5, `mean ${sum / N}`);
  });

  test("添字は長さ N・範囲 [0,N)・ブロック内は循環的に連続", () => {
    const rand = mulberry32(5);
    const N = 300;
    const ix = stationaryBootstrapIndex(N, 20, rand);
    assert.equal(ix.length, N);
    let breaks = 0;
    for (let i = 0; i < N; i++) {
      assert.ok(ix[i] >= 0 && ix[i] < N);
      if (i > 0 && ix[i] !== (ix[i - 1] + 1) % N) breaks++;
    }
    // 平均ブロック長 20 なら切れ目はおよそ N/20 本（厳密には乱数次第。桁が合えばよい）
    assert.ok(breaks > 5 && breaks < 60, `breaks ${breaks}`);
  });
});

describe("percentile", () => {
  test("numpy.percentile の既定（線形補間）と一致する", () => {
    const xs = [1, 2, 3, 4];
    assert.equal(golden(percentile(xs, 5)), golden(1.15));
    assert.equal(percentile(xs, 50), 2.5);
    assert.equal(golden(percentile(xs, 95)), golden(3.85));
    assert.equal(percentile([7], 50), 7);
    assert.ok(Number.isNaN(percentile([], 50)));
  });
});

describe("computeRobustness（合成）", () => {
  test("植え込んだ暴落を避ける建玉では、偶然が上回る割合が小さく、ブート差の最大DDは正に寄る", () => {
    const n = 1200;
    const normal = makeNormal(mulberry32(42));
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = 0.0003 + 0.012 * normal();
    // 500〜560 日目に −45% の暴落（日次 −1.0%）
    for (let i = 500; i < 560; i++) y[i] = -0.01 + 0.01 * normal();
    const w = new Float64Array(n).fill(1);
    w.fill(0, 498, 565);
    // それ以外に短い現金期間も2本（本数・長さの制約を検査に乗せる）
    w.fill(0, 100, 105); w.fill(0, 900, 910);

    const r = computeRobustness({ y, w, costOneWay: 0.0005, nNull: 300, nBoot: 300, seed: 1 });
    assert.ok(r);
    assert.equal(r!.nEval, n);
    assert.deepEqual(r!.episodeLengths, [5, 67, 10]);
    assert.equal(r!.nullPlacementFailed, 0);
    const byKey = Object.fromEntries(r!.null.map((s) => [s.key, s]));
    assert.ok(byKey.maxDrawdown.pGe < 0.05, `P(偶然の方が浅い) = ${byKey.maxDrawdown.pGe}`);
    assert.ok(byKey.cagr.pGe < 0.05, `P(偶然 ≥ 実際 | 年率) = ${byKey.cagr.pGe}`);
    assert.ok(byKey.maxDrawdown.p5 <= byKey.maxDrawdown.p50 && byKey.maxDrawdown.p50 <= byKey.maxDrawdown.p95);
    const boot = Object.fromEntries(r!.boot.map((s) => [s.key, s]));
    assert.ok(boot.maxDrawdown.median > 0 && boot.maxDrawdown.pPositive > 0.75, `MDD差 ${boot.maxDrawdown.median} P ${boot.maxDrawdown.pPositive}`);
    assert.ok(boot.cagr.lo5 <= boot.cagr.median && boot.cagr.median <= boot.cagr.hi95);
  });

  test("現金期間が無ければ偶然＝実際で P(偶然 ≥ 実際)=1、評価行が足りなければ null", () => {
    const n = 200;
    const normal = makeNormal(mulberry32(9));
    const y = Float64Array.from({ length: n }, () => 0.01 * normal());
    const w = new Float64Array(n).fill(1);
    const r = computeRobustness({ y, w, costOneWay: 0.0005, nNull: 20, nBoot: 20 });
    assert.ok(r);
    for (const s of r!.null) assert.equal(s.pGe, 1);
    assert.equal(computeRobustness({ y: y.subarray(0, 50), w: w.subarray(0, 50), costOneWay: 0 }), null);
  });
});

describe("黄金値: 8306.T 2018〜 の評価行に固定シード（nNull=200, nBoot=200）", () => {
  const toPP = (p: { time: string; open?: number; close: number }): PricePoint => ({
    time: p.time, open: p.open ?? p.close, high: Math.max(p.open ?? p.close, p.close), low: Math.min(p.open ?? p.close, p.close), close: p.close, volume: 0,
  });
  const res = computeDerisk({
    target: fx.target.map(toPP), vix: fx.vix.map(toPP), kre: fx.kre.map(toPP),
    ticker: fx.meta.ticker, params: fx.params, costOneWay: fx.costOneWay,
  });
  const ev = res.rows.filter((r) => r.yOo !== null);
  const r = computeRobustness({ y: ev.map((r) => r.yOo as number), w: ev.map((r) => r.w), costOneWay: fx.costOneWay, nNull: 200, nBoot: 200, seed: 20261023 })!;

  test("形: 評価行数・エピソード本数・実際の指標が derisk-rule の結果と一致する", () => {
    assert.equal(r.nEval, ev.length);
    // フィクスチャの最終行は保有なので、評価行（最終行を除く）のエピソード本数は全行のそれと同じ
    assert.equal(res.rows[res.rows.length - 1].w, 1);
    assert.equal(r.episodeLengths.length, res.episodes.length);
    assert.equal(golden(r.actual.rule.cagr), golden(res.metrics!.rule.cagr));
    assert.equal(golden(r.actual.rule.maxDrawdown), golden(res.metrics!.rule.maxDrawdown));
    assert.equal(golden(r.actual.buyHold.sharpe), golden(res.metrics!.buyHold.sharpe));
  });

  test("形: 分位は単調、確率は [0,1]。2018〜だけでは偶然と区別できない（研究 §5.1 の 2018〜 と同じ向き）", () => {
    for (const s of r.null) {
      assert.ok(s.p5 <= s.p50 && s.p50 <= s.p95);
      assert.ok(s.pGe >= 0 && s.pGe <= 1);
    }
    for (const s of r.boot) {
      assert.ok(s.lo5 <= s.median && s.median <= s.hi95);
      assert.ok(s.pPositive >= 0 && s.pPositive <= 1);
    }
    // 強い上昇相場だけの標本では、年率は偶然の配置の方が高い回が過半（規則は年率を上げない）。
    // 全期間（2006-09〜・3メガ平均）で研究の向きが出ることは check-lib.mts で照合する。
    const cagr = r.null.find((s) => s.key === "cagr")!;
    assert.ok(cagr.pGe > 0.5, `${cagr.pGe}`);
  });

  test("黄金値（乱数列込み）", () => {
    const g = (x: number) => golden(x, 8);
    const got = {
      null: r.null.map((s) => [s.key, g(s.p5), g(s.p50), g(s.p95), g(s.pGe)]),
      boot: r.boot.map((s) => [s.key, g(s.median), g(s.lo5), g(s.hi95), g(s.pPositive)]),
      failed: r.nullPlacementFailed,
    };
    // 2026-10-23 実測（seed 20261023・nNull=200・nBoot=200）。意図して計算か乱数の消費順を変えたら更新する。
    assert.deepEqual(got, {
      null: [
        ["cagr", 0.11052876, 0.18686984, 0.26330976, 0.61],
        ["maxDrawdown", -0.53230128, -0.41852737, -0.32753, 0.1],
        ["sharpe", 0.37280838, 0.60914106, 0.89320627, 0.335],
      ],
      boot: [
        ["cagr", -0.08781462, -0.21497791, 0.038786213, 0.125],
        ["maxDrawdown", 0.040888507, -0.1311777, 0.24374049, 0.68],
        ["sharpe", -0.055330171, -0.39230841, 0.36650058, 0.385],
      ],
      failed: 0,
    });
  });
});
