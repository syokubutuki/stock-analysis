// price-sanity.ts の回帰テスト（本テスト基盤の中核）。
//
// CLAUDE.md 冒頭は「1点のスケール破損で市場βが 1.10 → 0.05 に潰れる」と記録しているが、
// その事故を検出する自動テストは存在しなかった。ここで事故ケースを黄金値として固定する。
//
// フィクスチャは `app/lib/__tests__/tools/generate-fixtures.ts` が生成した合成系列で、
// 1306.T（2026-03-30〜03-31）の破損の構造 —— OHLC が 1/10・出来高が 10 倍・2営業日で復帰 ——
// をそのまま持たせてある。対象銘柄の真のβは 1.10。
//
// 対照群（tnx / vix）は「往復する大きなジャンプだが修復してはいけない」系列。
// price-sanity.ts の設計思想（MIN_LOG_FACTOR / SUSPECT_SIGMA_MULTIPLE）を踏む。

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { repairPriceGlitches, describeSanityReport } from "../price-sanity";
import fx from "./fixtures/price-fixtures.json";
import { assertGolden, golden, logReturnsOf, olsBeta } from "./helpers/golden";

const stockReturns = logReturnsOf(fx.stock);

describe("repairPriceGlitches: 1306.T 型スケール破損の回帰（CLAUDE.md 冒頭の事故）", () => {
  test("破損区間を1件だけ特定し、倍率・両端の錨を正しく報告する", () => {
    const { report } = repairPriceGlitches(fx.benchmarkRaw);

    assert.equal(report.repaired.length, 1, "破損区間はちょうど1件");
    const glitch = report.repaired[0];
    assert.deepEqual(
      {
        from: glitch.from,
        to: glitch.to,
        days: glitch.days,
        factor: glitch.factor,
        anchorBefore: glitch.anchorBefore,
        anchorAfter: glitch.anchorAfter,
      },
      {
        from: "2025-09-17",
        to: "2025-09-18",
        days: 2,
        factor: 0.1,
        anchorBefore: "2025-09-16",
        anchorAfter: "2025-09-19",
      },
    );
    assert.equal(report.suspects.length, 0, "修復できたものは疑いに残さない");
  });

  test("修復前後の実値（画面の開示に使う値）を固定する", () => {
    const { report } = repairPriceGlitches(fx.benchmarkRaw);
    const points = report.repaired[0].points.map((p) => ({
      time: p.time,
      closeBefore: golden(p.closeBefore),
      closeAfter: golden(p.closeAfter),
      volumeBefore: p.volumeBefore,
      volumeAfter: p.volumeAfter,
    }));

    assert.deepEqual(points, [
      {
        time: "2025-09-17",
        closeBefore: 27.38722814,
        closeAfter: 273.8722814,
        volumeBefore: 239037170,
        volumeAfter: 23903717,
      },
      {
        time: "2025-09-18",
        closeBefore: 27.65685018,
        closeAfter: 276.5685018,
        volumeBefore: 182487060,
        volumeAfter: 18248706,
      },
    ]);
  });

  test("年率σの膨張が解消する（放置するとどれだけ壊れていたかの数値）", () => {
    const { report } = repairPriceGlitches(fx.benchmarkRaw);
    assert.ok(report.sigmaBefore !== undefined && report.sigmaAfter !== undefined);
    assertGolden(report.sigmaBefore, 3.325433439, "修復前の年率σ（332%）");
    assertGolden(report.sigmaAfter, 0.2314322185, "修復後の年率σ（23%）");
    assert.ok(
      report.sigmaBefore / report.sigmaAfter > 10,
      "σ改善が小さい修復は誤検出の疑い（^TNX の教訓）。ここでは 14 倍",
    );
  });

  test("市場βの崩壊が復元される —— これが本テストの存在理由", () => {
    const { prices } = repairPriceGlitches(fx.benchmarkRaw);

    const betaRaw = olsBeta(stockReturns, logReturnsOf(fx.benchmarkRaw));
    const betaRepaired = olsBeta(stockReturns, logReturnsOf(prices));

    assertGolden(betaRaw, 0.01720300584, "破損したまま回帰するとβが潰れる");
    assertGolden(betaRepaired, 1.099837669, "修復後は真のβ 1.10 に戻る");

    assert.ok(betaRaw < 0.1, "破損時のβは 0.1 未満に潰れている");
    assert.ok(
      Math.abs(betaRepaired - fx.trueBeta) < 0.01,
      `修復後のβは真値 ${fx.trueBeta} と一致すること`,
    );
  });

  test("修復後の系列は破損前の正しい系列と完全に一致する（OHLC・出来高とも）", () => {
    const { prices } = repairPriceGlitches(fx.benchmarkRaw);
    assert.equal(prices.length, fx.benchmarkClean.length);

    let maxRelative = 0;
    for (let i = 0; i < prices.length; i++) {
      for (const key of ["open", "high", "low", "close"] as const) {
        const got = prices[i][key];
        const want = fx.benchmarkClean[i][key];
        maxRelative = Math.max(maxRelative, Math.abs(got / want - 1));
      }
    }
    assert.equal(maxRelative, 0, "水準を倍率で戻すので OHLC はビット一致する");

    // 出来高は価格と逆向きに誤スケールされているので、価格と同じ倍率を「掛けて」戻す。
    // 向きを間違えると 2.4 億株のまま残り、出来高系の分析（流動性・容量推定）が壊れる。
    assert.deepEqual(
      prices.map((p) => p.volume),
      fx.benchmarkClean.map((p) => p.volume),
    );
    assert.equal(prices[121].volume, 23903717, "破損日の出来高が平常水準に戻っている");
  });

  test("入力配列を破壊しない", () => {
    const before = JSON.stringify(fx.benchmarkRaw);
    repairPriceGlitches(fx.benchmarkRaw);
    assert.equal(JSON.stringify(fx.benchmarkRaw), before);
  });

  test("開示文（DataQualityNotice に出る文言）を固定する", () => {
    const { report } = repairPriceGlitches(fx.benchmarkRaw);
    assert.equal(
      describeSanityReport(report),
      "2025-09-17〜2025-09-18 の価格が 1/10 に破損していたため水準を復元しました" +
        "（配信元の調整漏れ。放置すると σ・β が壊れます）",
    );
  });
});

describe("repairPriceGlitches: 正しいデータを書き換えない（誤検出の対照群）", () => {
  test("^TNX 型（倍率 2/3 の往復）は修復せず、疑いとして報告する", () => {
    const { prices, report } = repairPriceGlitches(fx.tnx);

    // 1 の近傍の分割比は PLAUSIBLE_FACTORS の候補集合に無く、さらに MIN_LOG_FACTOR で
    // 二重に落とされる。片方だけ緩めても素通りしないが、両方緩めるとここが落ちる。
    assert.equal(report.repaired.length, 0, "1 の近傍の倍率は修復候補にしない");
    assert.equal(prices, fx.tnx, "無修復なら入力配列をそのまま返す（再レンダリングを誘発しない）");
    assert.deepEqual(
      report.suspects.map((s) => ({ time: s.time, logReturn: golden(s.logReturn) })),
      [
        { time: "2020-03-09", logReturn: -0.4054651081 },
        { time: "2020-03-12", logReturn: 0.4054651081 },
      ],
    );
    assert.equal(
      describeSanityReport(report),
      "±35% を超える日次変動を検出しましたが、スケール破損と断定できないため未修正です: " +
        "2020-03-09（-33%）・2020-03-12（50%）。" +
        "本物の急変動か未調整の分割かは目視で確認してください",
    );
  });

  test("^VIX 型（高ボラ系列の +80% 往復）は修復も疑い報告もしない", () => {
    const { prices, report } = repairPriceGlitches(fx.vix);

    assert.equal(report.repaired.length, 0, "端数倍率は切りのいい比に一致しない");
    assert.equal(
      report.suspects.length,
      0,
      "日次σ 8% の系列で ±35% は日常の範囲（SUSPECT_SIGMA_MULTIPLE の門）",
    );
    assert.equal(prices, fx.vix);
    assert.equal(describeSanityReport(report), null);
  });
});

describe("repairPriceGlitches: 縮退入力", () => {
  test("3点未満はそのまま返す", () => {
    const two = fx.stock.slice(0, 2);
    const { prices, report } = repairPriceGlitches(two);
    assert.equal(prices, two);
    assert.deepEqual(report, { repaired: [], suspects: [] });
  });

  test("破損の無い系列は何も報告せず、σ も付けない", () => {
    const { prices, report } = repairPriceGlitches(fx.benchmarkClean);
    assert.equal(prices, fx.benchmarkClean);
    assert.equal(report.repaired.length, 0);
    assert.equal(report.suspects.length, 0);
    assert.equal(report.sigmaBefore, undefined);
  });
});

describe("describeSanityReport", () => {
  test("報告が無ければ null", () => {
    assert.equal(describeSanityReport(undefined), null);
    assert.equal(describeSanityReport({ repaired: [], suspects: [] }), null);
  });

  test("疑いが4件以上なら先頭3件＋残件数で要約する", () => {
    const report = {
      repaired: [],
      suspects: [0.4, 0.5, 0.6, 0.7, 0.8].map((logReturn, i) => ({
        time: `2020-03-0${i + 1}`,
        logReturn,
      })),
    };
    const text = describeSanityReport(report);
    assert.ok(text !== null);
    assert.ok(text.includes("2020-03-01（49%）"), "対数リターンは単利%に直して出す");
    assert.ok(text.includes("他2件"));
    assert.ok(!text.includes("2020-03-04"));
  });
});
