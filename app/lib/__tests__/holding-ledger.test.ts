// holding-ledger.ts / kelly-uncertainty.ts の回帰テスト。
//
// `seriesStats()` は sim-kelly と sim-holding-ledger の**2パネルが共有する**素材で、
// 片方の都合で触ると他方が黙って動く。AGENTS.md の「複数パネルから参照される共通関数を
// 新設・変更したときは追加してください」に該当する。
//
// 加えて、2026-09-02 に直した欠陥の再発を止める:
//
//   ・`randomBlocks` が返す在場フラグを `blockDays` 無しで `walkStrategy` へ渡すと、
//     隣り合うブロックが1つの建玉に融合して往復回数が激減する。台帳が課金する
//     252θ/H とプラセボが実際に払う回数が 3倍以上ずれ、「同じ回転率の対照群」でなくなる。
//     → `placebo と台帳の往復回数が一致する` で縛る（修正前は 5.4 対 17.6 で落ちる）
//
//   ・θ=100% ではどの試行も同じ日を保有するので分布が1点に潰れる。呼び出し側が
//     ヒストグラムを描くかどうかを判断できるよう `distinct` を出す。
//     → `θ=100% では distinct が 1 になる` で縛る
//
// 方式は黄金値。数式の証明ではなく、意図しない変化の検知が目的なので、
// 計算を意図的に変えたらここが落ちるのが正常。

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  alwaysIn,
  decomposeLedger,
  placeboDistribution,
  randomBlocks,
  seriesStats,
  simpleReturns,
  walkStrategy,
  TAX_RATE,
  type LedgerParams,
  type WalkParams,
} from "../holding-ledger";
import { frequencyLadder, wallAndError } from "../kelly-uncertainty";
import fx from "./fixtures/price-fixtures.json";
import { assertGolden, assertGoldenArray, golden } from "./helpers/golden";
import type { PricePoint } from "../types";

const STOCK = fx.stock as PricePoint[];
const TRADING_DAYS = 252;

/** 台帳の既定に近い設定（H=10日・在場70%・現物・往復30bp・課税あり）。 */
const BASE: Omit<LedgerParams, "horizonYears"> = {
  holdDays: 10,
  inMarket: 0.7,
  leverage: 1,
  costRT: 0.003,
  taxEnabled: true,
  taxRate: TAX_RATE,
  marginRate: 0.028,
};

const WALK: WalkParams = {
  leverage: 1,
  costRT: 0.003,
  taxEnabled: true,
  taxRate: TAX_RATE,
  marginRate: 0.028,
};

describe("seriesStats: 2パネルが共有する素材", () => {
  const s = seriesStats(STOCK)!;

  test("μ・σ・壁・g が黄金値どおり", () => {
    assert.equal(s.n, 249);
    assertGoldenArray(
      [s.muArith, s.sigma, s.hurdle, s.gRealized, s.seMu],
      [0.09019872576, 0.2675169108, 0.03578264879, 0.0545369684, 0.2691236335],
      "muArith は算術（expm1 の標本平均）。対数平均に戻すと σ²/2 を二重に引く",
    );
  });

  test("恒等式 g = μ_arith − σ²/2 の残差が小さい", () => {
    // 実測で 285A.T（1.6年・σ=103%）が −1.03pp まで出るので、閾値は 2pp に置く。
    // 1pp に絞ると高ボラ・短標本の銘柄で落ちるが、それは実装の欠陥ではない。
    assert.ok(
      Math.abs(s.identityGap) < 0.02,
      `identityGap=${s.identityGap} が 2pp を超えた（μ か σ の定義が動いた疑い）`,
    );
    assertGolden(s.identityGap, 0.0001208914254);
  });

  test("夜間 + 日中 = 日次対数リターン（近似ではなく恒等式）", () => {
    assertGoldenArray([s.overnight, s.intraday], [-0.07524832407, 0.1297852925]);
    // 端数の扱いが違うので厳密一致は求めず、桁で縛る
    assert.ok(Math.abs(s.overnight + s.intraday - s.gRealized) < 0.005);
  });

  test("SE(μ̂)/SE(σ̂) は √504 の定数（銘柄にも期間にも依存しない）", () => {
    const w = wallAndError(s);
    assertGolden(w.precisionRatio, golden(Math.sqrt(2 * TRADING_DAYS)));
    // 期間を半分にしても比は変わらない。ここが動いたら SE の式が変わっている。
    const half = seriesStats(STOCK.slice(0, 150))!;
    assertGolden(wallAndError(half).precisionRatio, golden(Math.sqrt(2 * TRADING_DAYS)));
  });

  test("入力が短すぎれば null（呼び出し側が描画をやめられる）", () => {
    assert.equal(seriesStats(STOCK.slice(0, 40)), null);
  });
});

describe("decomposeLedger: 決定論の加法分解", () => {
  const s = seriesStats(STOCK)!;
  const led = decomposeLedger(s, { ...BASE, horizonYears: s.years });

  test("各段が黄金値どおり", () => {
    assertGoldenArray(
      [led.expected, led.drag, led.inMarketDelta, led.roundTrips, led.costDelta, led.taxDelta, led.gNet],
      [0.09019872576, 0.03578264879, -0.01632482309, 17.64, -0.05299953912, 0.003029638129, -0.01187864711],
    );
  });

  test("turnoverLoss に取りこぼしを混ぜない（θ の機会損失は別勘定）", () => {
    // 混ぜると「回転のほうがドラッグより効いている」という判定を、実際には
    // UI の θ スライダーが決めてしまう。3値は独立に取れること。
    assertGoldenArray(
      [led.dragLoss, led.turnoverLoss, led.idleLoss],
      [0.03578264879, 0.04996990099, 0.01632482309],
    );
    assertGolden(led.turnoverLoss, golden(-(led.costDelta + led.carryDelta + led.taxDelta)));
    assertGolden(led.idleLoss, golden(-led.inMarketDelta));
  });

  test("コストも税も 0 なら、削るのはドラッグと取りこぼしだけ", () => {
    const free = decomposeLedger(s, {
      ...BASE,
      costRT: 0,
      taxEnabled: false,
      horizonYears: s.years,
    });
    assert.equal(golden(free.turnoverLoss), 0, "実費が 0 にならないなら θ の項が混ざっている");
    assert.ok(free.idleLoss > 0, "取りこぼしはコスト 0 でも残る");
  });

  test("在場100%なら取りこぼしは消える", () => {
    const full = decomposeLedger(s, { ...BASE, inMarket: 1, horizonYears: s.years });
    assert.equal(golden(full.idleLoss), 0);
  });
});

describe("walkStrategy: 実データを歩く経路", () => {
  const s = seriesStats(STOCK)!;
  const rets = simpleReturns(STOCK);

  test("持ち切りは往復1回で、決定論の分解とほぼ一致する", () => {
    const bh = walkStrategy(rets, alwaysIn(rets.length), WALK);
    assert.equal(bh.roundTrips, 1, "blockDays を渡さない限り連続した在場は1つの建玉");
    const led = decomposeLedger(s, { ...BASE, horizonYears: s.years });
    assert.ok(
      Math.abs(bh.g - led.gBuyHoldNet) < 0.01,
      `2経路が 1pp 以上ずれた: walk=${bh.g} ledger=${led.gBuyHoldNet}`,
    );
  });

  test("blockDays を渡すとブロック境界ごとに畳んで建て直す", () => {
    const n = 100;
    const flat = walkStrategy(rets.slice(0, n), alwaysIn(n), WALK);
    const blocked = walkStrategy(rets.slice(0, n), alwaysIn(n), { ...WALK, blockDays: 10 });
    assert.equal(flat.roundTrips, 1);
    assert.equal(blocked.roundTrips, 10, "100日を10日ブロックに割れば10往復");
    assert.ok(blocked.costPaid > flat.costPaid, "往復が増えればコストも増える");
  });

  test("blockDays=0 / 未指定は従来どおり", () => {
    const a = walkStrategy(rets, alwaysIn(rets.length), WALK);
    const b = walkStrategy(rets, alwaysIn(rets.length), { ...WALK, blockDays: 0 });
    assertGolden(b.g, golden(a.g));
    assert.equal(b.roundTrips, a.roundTrips);
  });
});

describe("placeboDistribution: 台帳と同じ回転率の対照群", () => {
  const s = seriesStats(STOCK)!;
  const rets = simpleReturns(STOCK);
  const years = rets.length / TRADING_DAYS;
  const led = decomposeLedger(s, { ...BASE, horizonYears: s.years });

  test("★ プラセボの往復回数が台帳の 252θ/H と一致する", () => {
    // これが本体。blockDays を渡し忘れると隣接ブロックが融合し、実測で
    // 5.4 対 17.6（3.3倍）まで開く。そのとき台帳の予測は分布の左に系統的にずれ、
    // 「近似が保守側に出ている」という誤った診断につながる。
    const pl = placeboDistribution(rets, { ...BASE, iters: 200, seed: 12345 });
    const actual = pl.meanRoundTrips / years;
    assert.ok(
      Math.abs(actual - led.roundTrips) / led.roundTrips < 0.15,
      `往復回数がずれた: placebo=${actual.toFixed(2)}/年 ledger=${led.roundTrips.toFixed(2)}/年`,
    );
  });

  test("★ θ=100% では無作為化の余地がなく distinct が 1 になる", () => {
    // 呼び出し側はこれを見てヒストグラムを描かず理由を出す。1本だけの棒を
    // 「ランダムに在場した400通り」として描くと、台帳の予測がその外に落ちて
    // 「前提が妥当でない」と読めてしまう。
    const pl = placeboDistribution(rets, { ...BASE, inMarket: 1, iters: 50, seed: 1 });
    assert.equal(pl.distinct, 1);
    assert.equal(golden(pl.q05), golden(pl.q95));
  });

  test("θ<100% なら試行ごとに散らばる", () => {
    const pl = placeboDistribution(rets, { ...BASE, iters: 200, seed: 12345 });
    assert.ok(pl.distinct > 50, `distinct=${pl.distinct}: 乱数が効いていない`);
    assert.ok(pl.q05 < pl.q50 && pl.q50 < pl.q95);
  });

  test("同じ seed なら再現する", () => {
    const a = placeboDistribution(rets, { ...BASE, iters: 50, seed: 7 });
    const b = placeboDistribution(rets, { ...BASE, iters: 50, seed: 7 });
    assertGolden(b.q50, golden(a.q50));
  });
});

describe("randomBlocks", () => {
  test("在場割合がおおむね θ になる", () => {
    let seed = 1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const flags = randomBlocks(1000, 10, 0.7, rand);
    const share = flags.filter(Boolean).length / flags.length;
    assert.ok(Math.abs(share - 0.7) < 0.03, `在場割合 ${share}`);
  });

  test("θ=1 なら全期間が在場（＝無作為化の余地なし）", () => {
    const flags = randomBlocks(200, 10, 1, () => 0.5);
    assert.ok(flags.every(Boolean));
  });
});

describe("frequencyLadder: μ と σ の精度の非対称性", () => {
  test("μ（対数・年率）は集計水準を変えても大きく動かない", () => {
    const rows = frequencyLadder(STOCK);
    assert.equal(rows.length, 2, "250本のフィクスチャでは 日次 と 5日集計 のみ（MIN_BLOCKS=20）");
    assertGoldenArray(
      rows.map((r) => r.muLogAnn),
      [0.0545369684, 0.01803824738],
    );
  });

  test("分散比の列があり、日次行は 1", () => {
    // SE(μ̂) が行をまたいで動いたとき、原因が「μ の情報が増えた」ではなく
    // 「σ を集計水準ごとに測り直している」ことを読み手に示すための列。
    const rows = frequencyLadder(STOCK);
    assertGoldenArray(
      rows.map((r) => r.varianceRatio),
      [1, 1.136840157],
    );
    // SE(μ̂) は分散比を継承する: SE_k/SE_1 ≈ σ_k/σ_1（覆う年数の端数ぶんだけずれる）
    const ratioSe = rows[1].seMuAnn / rows[0].seMuAnn;
    const ratioSigma = rows[1].sigmaAnn / rows[0].sigmaAnn;
    assert.ok(Math.abs(ratioSe - ratioSigma) < 0.05);
  });

  test("SE(σ̂) は集計するほど粗くなる（本数が減るぶん）", () => {
    const rows = frequencyLadder(STOCK);
    assert.ok(rows[1].seSigmaAnn > rows[0].seSigmaAnn);
  });
});
