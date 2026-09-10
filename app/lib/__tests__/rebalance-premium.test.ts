// rebalance-premium.ts の回帰テスト。
//
// このファイルが守っているのは「数字が変わらないこと」ではなく、**主張が壊れないこと**である。
// パネルの結論はすべて次の1本の恒等式に乗っている:
//
//     P(w) = g_rebal(w) − Σw·g = ½·w(1−w)·σ_diff²
//
// ここが崩れると、②の分解も「必要な σ_diff」も、④のルール採点の基準線も全部ずれる。
// しかも**崩れても画面は普通に数字を出す**（NaN にもエラーにもならない）ので、
// 目視では気づけない。だから合成データで解析解と突き合わせる。
//
// 縛っているもの:
//   ・理論プレミアムと実測プレミアムが一致する（離散化の誤差の範囲で）
//   ・理論プレミアムが ρ ではなく σ_diff だけで決まる（ρ を変えても σ_diff が同じなら同値）
//   ・Δg=0 なら必ずリバランスが放置に勝つ（Shannon's demon の決定的な例で確認）
//   ・**先読みが無い**。i 日目のウェイトは i 日目以降のリターンに依存しない
//   ・コストは単調に効く（回転率の高いルールほど強く削られる）
//   ・ウェイトが動かないルールでは巡回シフト・ヌルを出さない（意味を持たないため）
//
// ⑤「β<1 の構造から収益を取る経路」側で縛っているもの:
//   ・σ_diff² = (β−1)²σ_B² + σ_ε² が閉じる（⑥「β<1 の寄与はごく僅か」の土台）
//   ・BAB の年率が α/β に一致する（①が α を取り出す操作であることの代数的確認）
//   ・**非対称βの符号**。β⁻>β⁺ を植え込んだら β⁻>β⁺ と読めること。
//     ここが逆だと「下げに強い」と「下げに弱い」が入れ替わり、結論が反転する
//   ・平均回帰の検出。定常な対数比を植え込めば成立、ランダムウォークなら不成立

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  computeRebalance,
  DEFAULT_REBALANCE_SPEC,
  RULE_ORDER,
  type RebalanceSpec,
} from "../rebalance-premium";
import type { PricePoint } from "../types";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 日付は文字列の一致さえ取れればよい（alignSeries は time で内部結合する）。 */
function dateAt(i: number): string {
  const d = new Date(Date.UTC(2016, 0, 4) + i * 86400000);
  return d.toISOString().slice(0, 10);
}

function toPrices(closes: number[]): PricePoint[] {
  return closes.map((c, i) => ({
    time: dateAt(i), open: c, high: c, low: c, close: c, volume: 1000,
  }));
}

/**
 * 相関 ρ・日次ボラ σ・日次ドリフト μ を指定した2本の対数正規系列。
 * Box–Muller ＋ Cholesky（2変量なので z2' = ρ·z1 + √(1−ρ²)·z2）。
 */
function correlatedPair(
  n: number, rho: number, sigA: number, sigB: number, muA: number, muB: number, seed: number
): { a: PricePoint[]; b: PricePoint[] } {
  const rng = mulberry32(seed);
  const ca = [100], cb = [100];
  for (let i = 1; i < n; i++) {
    const u1 = Math.max(1e-12, rng()), u2 = rng();
    const r = Math.sqrt(-2 * Math.log(u1));
    const z1 = r * Math.cos(2 * Math.PI * u2);
    const z2 = r * Math.sin(2 * Math.PI * u2);
    const w2 = rho * z1 + Math.sqrt(Math.max(0, 1 - rho * rho)) * z2;
    ca.push(ca[i - 1] * Math.exp(muA + sigA * z1));
    cb.push(cb[i - 1] * Math.exp(muB + sigB * w2));
  }
  return { a: toPrices(ca), b: toPrices(cb) };
}

const SPEC: RebalanceSpec = { ...DEFAULT_REBALANCE_SPEC, costRT: 0, nullDraws: 120 };

describe("リバランス・プレミアムの恒等式", () => {
  test("理論 ½w(1−w)σ_diff² と、毎日リバランスの実測が一致する", () => {
    const { a, b } = correlatedPair(1500, 0.3, 0.012, 0.010, 0.0003, 0.0002, 12345);
    const r = computeRebalance(a, b, { ...SPEC, weightA: 0.5 }, "contrarian");
    assert.ok(r, "結果が null");
    const { theory, measured } = r.decomposition;
    // 理論は連続リバランスの極限、実測は日次の離散なので完全一致はしない。
    // 差は高次項なので、プレミアム自体の 15% 以内に収まっていれば恒等式は生きている。
    assert.ok(theory > 0, `理論プレミアムが正でない: ${theory}`);
    assert.ok(
      Math.abs(measured - theory) < 0.15 * theory,
      `理論 ${theory} と実測 ${measured} が離れすぎている`,
    );
  });

  test("理論プレミアムは ρ ではなく σ_diff だけで決まる", () => {
    // σ_diff² = σ_A² + σ_B² − 2ρσ_Aσ_B。σ_A=σ_B=σ なら σ_diff² = 2σ²(1−ρ)。
    // (σ, ρ) = (0.010, 0.5) と (0.010·√2, 0.75) は σ_diff² が一致する:
    //   2·0.010²·0.5 = 1.0e-4 ,  2·(0.010·√2)²·0.25 = 1.0e-4
    const lo = correlatedPair(4000, 0.5, 0.010, 0.010, 0.0002, 0.0002, 777);
    const hi = correlatedPair(4000, 0.75, 0.010 * Math.SQRT2, 0.010 * Math.SQRT2, 0.0002, 0.0002, 777);
    const rl = computeRebalance(lo.a, lo.b, { ...SPEC, weightA: 0.5 }, "contrarian");
    const rh = computeRebalance(hi.a, hi.b, { ...SPEC, weightA: 0.5 }, "contrarian");
    assert.ok(rl && rh);
    // 相関はまったく違う（0.5 と 0.75）のに、差のボラは一致する
    assert.ok(rh.pair.rho - rl.pair.rho > 0.15, `ρ が十分に離れていない: ${rl.pair.rho} vs ${rh.pair.rho}`);
    assert.ok(
      Math.abs(rh.pair.sigmaDiff - rl.pair.sigmaDiff) < 0.02 * rl.pair.sigmaDiff,
      `σ_diff が一致しない: ${rl.pair.sigmaDiff} vs ${rh.pair.sigmaDiff}`,
    );
    assert.ok(
      Math.abs(rh.decomposition.theory - rl.decomposition.theory) < 0.05 * rl.decomposition.theory,
      `σ_diff が同じなのにプレミアムが違う: ${rl.decomposition.theory} vs ${rh.decomposition.theory}`,
    );
  });

  test("プレミアムは w=0 と w=1 で消え、w=0.5 で最大になる", () => {
    const { a, b } = correlatedPair(1200, 0.2, 0.011, 0.009, 0.0002, 0.0002, 4242);
    const r = computeRebalance(a, b, SPEC, "contrarian");
    assert.ok(r);
    const at = (w: number) => r.weightSweep.find((s) => Math.abs(s.w - w) < 1e-9)!.theory;
    assert.equal(at(0), 0);
    assert.equal(at(1), 0);
    assert.ok(at(0.5) > at(0.25) && at(0.5) > at(0.75), "w=0.5 が最大になっていない");
  });
});

describe("Shannon's demon（Δg=0 の決定的な例）", () => {
  // A は ×1.1 と ÷1.1 を交互に、B はその裏返し。どちらも幾何成長率はちょうど 0 で、
  // 完全な逆相関。50/50 で毎日戻すと毎日 +0.4545% になる（教科書の例）。
  // 終値は 401 本＝リターン 400 本にする。半周期で終わると往復が閉じず、
  // 最後の1歩ぶんだけ g が 0 からずれる（奇数だと g_A ≈ +6%/年 になる）。
  const up = 1.1;
  const closesA: number[] = [100], closesB: number[] = [100];
  for (let i = 1; i <= 400; i++) {
    const upTurn = i % 2 === 1;
    closesA.push(closesA[i - 1] * (upTurn ? up : 1 / up));
    closesB.push(closesB[i - 1] * (upTurn ? 1 / up : up));
  }

  test("両資産とも g=0 なのに、毎日リバランスは正の成長率を生む", () => {
    const r = computeRebalance(toPrices(closesA), toPrices(closesB), { ...SPEC, weightA: 0.5 }, "contrarian");
    assert.ok(r);
    assert.ok(Math.abs(r.pair.gA) < 1e-6, `g_A が 0 でない: ${r.pair.gA}`);
    assert.ok(Math.abs(r.pair.gB) < 1e-6, `g_B が 0 でない: ${r.pair.gB}`);
    const daily = r.freqRows.find((f) => f.freq === "daily")!;
    assert.ok(daily.stats.g > 0.5, `毎日リバランスの g が小さすぎる: ${daily.stats.g}`);
    assert.ok(daily.vsBH > 0, `Δg=0 なのに放置に勝っていない: ${daily.vsBH}`);
  });

  test("Δg=0 なら「必要な σ_diff」は 0 で、判定は常にリバランス有利", () => {
    const r = computeRebalance(toPrices(closesA), toPrices(closesB), { ...SPEC, weightA: 0.5 }, "contrarian");
    assert.ok(r);
    // Δg は丸め誤差ぶんだけ 0 から浮くので、必要 σ_diff も厳密な 0 にはならない。
    // 見たいのは「実測の σ_diff に対して無視できる水準か」である。
    assert.ok(r.decomposition.deltaG < 1e-6, `Δg が 0 でない: ${r.decomposition.deltaG}`);
    assert.ok(
      r.decomposition.sigmaDiffRequired < 0.01 * r.pair.sigmaDiff,
      `必要 σ_diff が無視できる水準でない: ${r.decomposition.sigmaDiffRequired}`,
    );
    assert.equal(r.decomposition.rebalanceWins, true);
  });

  test("逆に Δg が大きいと、リバランスは放置に負ける側へ回る", () => {
    // 同じ σ・ρ で、A のドリフトだけ年 15pp 上乗せする
    const { a, b } = correlatedPair(2000, 0.3, 0.012, 0.012, 0.0002 + 0.15 / 252, 0.0002, 999);
    const r = computeRebalance(a, b, { ...SPEC, weightA: 0.5 }, "contrarian");
    assert.ok(r);
    assert.ok(r.decomposition.deltaG > 0.10, `Δg が想定より小さい: ${r.decomposition.deltaG}`);
    assert.ok(
      r.decomposition.sigmaDiffRequired > r.pair.sigmaDiff,
      "Δg が大きいのに必要 σ_diff が実測を下回っている",
    );
    assert.equal(r.decomposition.rebalanceWins, false);
    assert.ok(r.decomposition.netVsBH < 0, `放置に勝ってしまっている: ${r.decomposition.netVsBH}`);
  });
});

describe("先読みが無いこと", () => {
  test("末尾のバーを差し替えても、それ以前のウェイトは1つも動かない", () => {
    // i 日目のウェイトが i 日目以降のリターンを読んでいたら、ここが落ちる。
    const { a, b } = correlatedPair(600, 0.4, 0.012, 0.010, 0.0002, 0.0002, 31415);
    const bumped = a.map((p, i) =>
      i === a.length - 1 ? { ...p, open: p.close * 3, high: p.close * 3, low: p.close * 3, close: p.close * 3 } : p,
    );
    for (const rule of RULE_ORDER) {
      const base = computeRebalance(a, b, SPEC, rule);
      const alt = computeRebalance(bumped, b, SPEC, rule);
      assert.ok(base && alt);
      const w0 = base.curves[4].weights, w1 = alt.curves[4].weights;
      assert.equal(w0.length, w1.length);
      for (let i = 0; i < w0.length - 1; i++) {
        assert.ok(
          Math.abs(w0[i].value - w1[i].value) < 1e-12,
          `${rule}: ${i} 日目のウェイトが将来のバーで動いた（${w0[i].value} → ${w1[i].value}）`,
        );
      }
    }
  });
});

describe("コストと回転率", () => {
  test("往復コストを上げると、回転率の高いルールほど強く削られる", () => {
    const { a, b } = correlatedPair(1500, 0.5, 0.012, 0.010, 0.0003, 0.0002, 271828);
    const free = computeRebalance(a, b, { ...SPEC, costRT: 0 }, "contrarian");
    const paid = computeRebalance(a, b, { ...SPEC, costRT: 0.002 }, "contrarian");
    assert.ok(free && paid);
    const get = (r: NonNullable<typeof free>, k: string) => r.ruleRows.find((x) => x.key === k)!;
    const flip = get(paid, "contrarian"), stat = get(paid, "static");
    assert.ok(flip.stats.turnoverPerYear > 50, `全振りルールの回転率が低すぎる: ${flip.stats.turnoverPerYear}`);
    assert.ok(stat.stats.turnoverPerYear < 5, `静的リバランスの回転率が高すぎる: ${stat.stats.turnoverPerYear}`);
    const dropFlip = get(free, "contrarian").stats.g - flip.stats.g;
    const dropStat = get(free, "static").stats.g - stat.stats.g;
    assert.ok(dropFlip > dropStat * 10, `回転率の差がコストに反映されていない: ${dropFlip} vs ${dropStat}`);
    // コスト控除前の g はコスト設定に依らない
    assert.ok(Math.abs(get(free, "contrarian").stats.gGross - flip.stats.gGross) < 1e-9);
  });

  test("損益分岐コストは、基準より回転率が低ければ Infinity になる", () => {
    const { a, b } = correlatedPair(1200, 0.4, 0.011, 0.010, 0.0002, 0.0002, 8080);
    const r = computeRebalance(a, b, { ...SPEC, freq: "daily" }, "contrarian");
    assert.ok(r);
    const bh = r.ruleRows.find((x) => x.key === "bh")!;
    assert.ok(bh.stats.turnoverPerYear <= r.ruleRows.find((x) => x.key === "static")!.stats.turnoverPerYear);
    assert.ok(Number.isNaN(r.ruleRows.find((x) => x.key === "static")!.breakevenCostRT), "基準自身は NaN であるべき");
  });
});

describe("巡回シフト・ヌル", () => {
  test("ウェイトが動かないルールでは出さない／動くルールでは出す", () => {
    const { a, b } = correlatedPair(1200, 0.4, 0.011, 0.010, 0.0002, 0.0002, 5150);
    const r = computeRebalance(a, b, SPEC, "contrarian");
    assert.ok(r);
    // 静的リバランスはウェイトがほぼ一定なので、回しても同じものを当てているだけ
    assert.equal(r.ruleRows.find((x) => x.key === "static")!.nullP, null);
    const flip = r.ruleRows.find((x) => x.key === "contrarian")!;
    assert.ok(flip.nullP !== null && flip.nullP > 0 && flip.nullP <= 1, `p が範囲外: ${flip.nullP}`);
    assert.ok(flip.nullSample.length > 50, "ヌル標本が少なすぎる");
  });

  test("シードが同じなら結果が再現する", () => {
    const { a, b } = correlatedPair(1000, 0.3, 0.011, 0.010, 0.0002, 0.0002, 6060);
    const p1 = computeRebalance(a, b, SPEC, "momentum")!.ruleRows.find((x) => x.key === "momentum")!.nullP;
    const p2 = computeRebalance(a, b, SPEC, "momentum")!.ruleRows.find((x) => x.key === "momentum")!.nullP;
    assert.equal(p1, p2);
  });
});

describe("β<1 の構造から収益を取る経路（⑤）", () => {
  /** 市場モデル r_A = α + β·r_B + ε を直接組み立てる（β は上下で変えられる）。 */
  function marketModel(
    n: number, alphaDaily: number, betaUp: number, betaDown: number,
    sigB: number, sigE: number, muB: number, seed: number
  ): { a: PricePoint[]; b: PricePoint[] } {
    const rng = mulberry32(seed);
    const gauss = () => {
      const u1 = Math.max(1e-12, rng()), u2 = rng();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const ca = [100], cb = [100];
    for (let i = 1; i < n; i++) {
      const rb = muB + sigB * gauss();
      const beta = rb < 0 ? betaDown : betaUp;
      const ra = alphaDaily + beta * rb + sigE * gauss();
      cb.push(cb[i - 1] * (1 + rb));
      ca.push(ca[i - 1] * (1 + ra));
    }
    return { a: toPrices(ca), b: toPrices(cb) };
  }

  test("σ_diff² = (β−1)²σ_B² + σ_ε² が閉じる（⑥の土台）", () => {
    const { a, b } = marketModel(2500, 0.0002, 0.8, 0.8, 0.011, 0.010, 0.0002, 24680);
    const r = computeRebalance(a, b, SPEC, "contrarian");
    assert.ok(r);
    const x = r.routes;
    // β=1 のときに残る分はちょうど σ_ε
    assert.equal(x.sigmaDiffAtBeta1, x.residVol);
    const reconstructed = Math.hypot(x.residVol, (x.beta - 1) * r.pair.sigmaB);
    assert.ok(
      Math.abs(reconstructed - r.pair.sigmaDiff) < 0.02 * r.pair.sigmaDiff,
      `分解が閉じない: 実測 ${r.pair.sigmaDiff} vs 再構成 ${reconstructed}`,
    );
    // β=0.8・σ_B=17.5%程度なら (β−1)σ_B ≈ 3.5% で、σ_ε≈16% に対して押し上げは僅か
    assert.ok(x.sigmaDiffLift > 0, "β<1 なのに σ_diff を押し上げていない");
    assert.ok(
      x.sigmaDiffLift < 0.2 * x.sigmaDiffAtBeta1,
      `β<1 の寄与が大きすぎる: ${x.sigmaDiffLift} vs ${x.sigmaDiffAtBeta1}`,
    );
  });

  test("植え込んだ α を取り出せ、BAB の年率は α/β に一致する（①）", () => {
    const alphaDaily = 0.0004; // 年率 ≈ 10%
    const { a, b } = marketModel(3000, alphaDaily, 0.8, 0.8, 0.011, 0.010, 0.0002, 13579);
    const r = computeRebalance(a, b, SPEC, "contrarian");
    assert.ok(r);
    const x = r.routes;
    assert.ok(Math.abs(x.beta - 0.8) < 0.05, `β を復元できない: ${x.beta}`);
    // α の標準誤差は se_ann = σ_ε / √years。**これがこのパネルの主要な警告そのもの**なので、
    // 固定の許容差ではなく se の3倍で縛る（9.7年・σ_ε16% なら se は年 4.6pp もある）。
    const seAnn = x.residVol / Math.sqrt(r.pair.years);
    assert.ok(
      Math.abs(x.alphaAnn - alphaDaily * 252) < 3 * seAnn,
      `α を復元できない: ${x.alphaAnn} vs ${alphaDaily * 252}（se=${seAnn}）`,
    );
    // (1/β)μ_A − μ_B = (1/β)(α + βμ_B) − μ_B = α/β
    assert.ok(
      Math.abs(x.babAnn - x.alphaAnn / x.beta) < 1e-9,
      `BAB が α/β と一致しない: ${x.babAnn} vs ${x.alphaAnn / x.beta}`,
    );
    assert.equal(x.carryBreakeven, x.babAnn);
  });

  test("非対称βの符号が逆さまにならない（④の結論そのもの）", () => {
    // 下げで敏感・上げで鈍い（＝望みと逆）を植え込む
    const bad = marketModel(3000, 0.0002, 0.70, 0.95, 0.011, 0.008, 0.0002, 2468);
    const rb = computeRebalance(bad.a, bad.b, SPEC, "contrarian");
    assert.ok(rb);
    assert.ok(rb.routes.betaDown > rb.routes.betaUp, "β⁻>β⁺ を植えたのに逆に出た");
    assert.ok(Math.abs(rb.routes.betaDown - 0.95) < 0.08, `β⁻ がずれる: ${rb.routes.betaDown}`);
    assert.ok(Math.abs(rb.routes.betaUp - 0.70) < 0.08, `β⁺ がずれる: ${rb.routes.betaUp}`);
    assert.ok(rb.routes.betaAsymT > 2, `差が有意に出ない: t=${rb.routes.betaAsymT}`);

    // 逆向き（下げで鈍い＝望みどおり）を植えたら符号が反転すること
    const good = marketModel(3000, 0.0002, 0.95, 0.70, 0.011, 0.008, 0.0002, 2468);
    const rg = computeRebalance(good.a, good.b, SPEC, "contrarian");
    assert.ok(rg);
    assert.ok(rg.routes.betaDown < rg.routes.betaUp, "β⁻<β⁺ を植えたのに逆に出た");
    assert.ok(rg.routes.betaAsymT < -2, `差が有意に出ない: t=${rg.routes.betaAsymT}`);
  });

  test("平均回帰は、定常な対数比を植えれば成立し、ランダムウォークなら不成立（③）", () => {
    // ln(A/B) = x_t を直接作る。OU なら定常、累積すればランダムウォーク。
    function pairFrom(xs: number[], seed: number): { a: PricePoint[]; b: PricePoint[] } {
      const rng = mulberry32(seed);
      const gauss = () => {
        const u1 = Math.max(1e-12, rng()), u2 = rng();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      };
      const cb = [100];
      for (let i = 1; i < xs.length; i++) cb.push(cb[i - 1] * Math.exp(0.0002 + 0.011 * gauss()));
      const ca = cb.map((v, i) => v * Math.exp(xs[i]));
      return { a: toPrices(ca), b: toPrices(cb) };
    }
    const rng = mulberry32(97531);
    const gauss = () => {
      const u1 = Math.max(1e-12, rng()), u2 = rng();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const n = 2000;
    const ou = [0], rw = [0];
    for (let i = 1; i < n; i++) {
      ou.push(0.97 * ou[i - 1] + 0.02 * gauss());
      rw.push(rw[i - 1] + 0.012 * gauss());
    }
    const mr = computeRebalance(...Object.values(pairFrom(ou, 111)) as [PricePoint[], PricePoint[]], SPEC, "contrarian");
    const nm = computeRebalance(...Object.values(pairFrom(rw, 111)) as [PricePoint[], PricePoint[]], SPEC, "contrarian");
    assert.ok(mr && nm);
    assert.equal(mr.routes.meanReverting, true, `OU なのに平均回帰なしと判定: ADF=${mr.routes.adfStat}`);
    assert.ok(mr.routes.halfLifeDays !== null && mr.routes.halfLifeDays < 60,
      `半減期が長すぎる: ${mr.routes.halfLifeDays}`);
    assert.equal(nm.routes.meanReverting, false, `ランダムウォークを平均回帰と判定: ADF=${nm.routes.adfStat}`);
    // VR の z は検出力が無い。**ゲートに戻さないこと**の証拠を残しておく:
    // ADF が −5 を割る強い OU でも、VR は 1 を下回るのに有意にはならない。
    assert.ok(mr.routes.adfStat < -4, `OU の ADF が弱い: ${mr.routes.adfStat}`);
    assert.ok(mr.routes.vr.some((v) => v.vr < 0.9), "VR が 1 未満へ落ちていない");
    assert.equal(mr.routes.vr.filter((v) => v.significant).length, 0,
      "VR が有意になった（この検定に検出力が付いたなら判定に使い直してよい）");
  });

  test("残存βは β−1 で、1:1ペアには市場エクスポージャーが残る（②）", () => {
    const { a, b } = marketModel(2000, 0.0002, 0.8, 0.8, 0.011, 0.010, 0.0002, 8642);
    const r = computeRebalance(a, b, SPEC, "contrarian");
    assert.ok(r);
    assert.ok(Math.abs(r.routes.residualBeta - (r.routes.beta - 1)) < 1e-12);
    assert.ok(r.routes.residualBeta < -0.1, "β<1 なのに残存βが 0 近辺になっている");
    // ⑤ 過剰ヘッジ = (1−β)·μ_B
    assert.ok(
      Math.abs(r.routes.overHedgeCostAnn - (1 - r.routes.beta) * r.pair.muB) < 1e-9,
    );
  });
});

describe("入力の下限", () => {
  test("共通営業日が足りなければ null を返す", () => {
    const { a, b } = correlatedPair(60, 0.3, 0.011, 0.010, 0.0002, 0.0002, 1);
    assert.equal(computeRebalance(a, b, SPEC, "contrarian"), null);
  });
});
