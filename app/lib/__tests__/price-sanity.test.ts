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

import {
  repairPriceGlitches,
  describeSanityReport,
  hasSanityWarnings,
} from "../price-sanity";
import type { PricePoint } from "../types";
import fx from "./fixtures/price-fixtures.json";
import hx from "./fixtures/holiday-fixtures.json";
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

// ─── 休場日の幻の行（docs/phantom-holiday-rows.md） ─────────────────────────
//
// 配信元は 2017-07-17〜2018-12-31 の東証休場日 22日に、出来高0・四本値＝前日終値の行を入れていた。
// フィクスチャ（holiday-fixtures.json）はその日付を実測どおり直書きしてあり、tse-calendar.ts に
// 依存しない。対照群として、同じ形をした「売買不成立の立会日」（エーザイ 2019-03-25 型）を持つ。

/** 曜日（0=日〜6=土）。 */
const dowOf = (time: string) => new Date(`${time}T00:00:00Z`).getUTCDay();

/** 前の行からの終値リターンがちょうど0の月曜の数（休場の月曜が混ざると増える）。 */
function zeroReturnMondays(prices: PricePoint[]): number {
  let n = 0;
  for (let i = 1; i < prices.length; i++) {
    if (dowOf(prices[i].time) === 1 && prices[i].close === prices[i - 1].close) n++;
  }
  return n;
}

describe("repairPriceGlitches: 東証休場日の幻の行（2017-07〜2018-12 の事故）", () => {
  test("休場日の22行だけを除去し、本当の立会日の系列と完全に一致させる", () => {
    const { prices, report } = repairPriceGlitches(hx.stockRaw, { ticker: "8306.T" });

    assert.equal(hx.stockRaw.length - hx.stockClean.length, 22, "フィクスチャの前提");
    assert.deepEqual(prices, hx.stockClean, "立会日の値には一切触れない（行を除くだけ）");
    assert.deepEqual(
      report.removedClosedDays?.map((r) => r.time),
      hx.phantomDates,
    );
    assert.equal(report.repaired.length, 0);
    assert.equal(report.suspects.length, 0);
  });

  test("除去した行の理由と配信値を固定する（パネルの表に出す値）", () => {
    const { report } = repairPriceGlitches(hx.stockRaw, { ticker: "8306.T" });
    const byTime = new Map(report.removedClosedDays!.map((r) => [r.time, r]));

    assert.deepEqual(
      ["2017-07-17", "2018-01-02", "2018-02-12", "2018-12-24", "2018-12-31"].map(
        (t) => byTime.get(t)?.reason,
      ),
      ["海の日", "年末年始休業", "振替休日", "振替休日", "年末年始休業"],
    );
    // 配信値は直前の立会日の終値の据え置き（年末年始の3連続も同じ立会日に遡る）。
    const lastSessionClose = hx.stockClean.find((p) => p.time === "2017-12-29")!.close;
    for (const t of ["2018-01-01", "2018-01-02", "2018-01-03"]) {
      assert.equal(byTime.get(t)?.close, lastSessionClose);
    }
  });

  test("曜日統計の歪みが消える: 休場の月曜（22日中13日）がリターン0の月曜として混ざらなくなる", () => {
    const { prices } = repairPriceGlitches(hx.stockRaw, { ticker: "8306.T" });
    const phantomMondays = hx.phantomDates.filter((t) => dowOf(t) === 1).length;

    assert.equal(phantomMondays, 13);
    assert.equal(zeroReturnMondays(hx.stockRaw), 13, "除去前: 休場の月曜がすべてリターン0で数えられる");
    assert.equal(zeroReturnMondays(prices), 0, "除去後: リターン0の月曜は無い");
  });

  test("対照群: 売買不成立の立会日（出来高0・前日終値据え置き）は消さずに知らせる", () => {
    const { prices, report } = repairPriceGlitches(hx.stockRaw, { ticker: "8306.T" });
    const i = prices.findIndex((p) => p.time === hx.noTradeDate);

    assert.ok(i > 0, "休場日ではないので行は残る");
    assert.equal(prices[i].volume, 0);
    assert.equal(prices[i].close, prices[i - 1].close);
    // 消すと翌日の −22% の窓が前日に繰り上がり、約定できなかった日に約定したことになる。
    assertGolden(
      Math.log(prices[i + 1].open / prices[i].close),
      -0.22,
      "翌日の寄り付きの窓は売買不成立日の終値からの −22% のまま",
    );
    assert.deepEqual(report.sessionSuspects, [{ time: hx.noTradeDate, kind: "zeroVolume" }]);
    assert.equal(hasSanityWarnings(report), false, "除去と売買不成立の告知だけなら警告ではない");
  });

  test("開示文（DataQualityNotice に出る文言）を固定する", () => {
    const { report } = repairPriceGlitches(hx.stockRaw, { ticker: "8306.T" });
    assert.equal(
      describeSanityReport(report),
      "配信元が東証の休場日（2017-07-17〜2018-12-31 の祝日・年末年始など）に入れていた" +
        "出来高0・前日終値据え置きの行を 22行除去しました（残すと営業日数・曜日別の統計・" +
        "売買シミュレーションに休場日が立会日として混ざります）／" +
        "立会日なのに出来高0・前日終値据え置きの日が 1日あります（2018-06-13）。" +
        "気配のまま売買が成立しなかった日・売買停止の可能性があるため、値は書き換えていません",
    );
  });

  test("指数（^N225 型）: 前日の行を丸写しした休場日の行も除き、出来高0の告知はしない", () => {
    const { prices, report } = repairPriceGlitches(hx.indexRaw, { ticker: "^N225" });

    assert.deepEqual(prices, hx.indexClean);
    assert.deepEqual(report.removedClosedDays?.map((r) => r.time), [hx.indexPhantomDate]);
    assert.equal(report.removedClosedDays?.[0].reason, "海の日");
    assert.equal(report.sessionSuspects, undefined);
    assert.equal(
      describeSanityReport(report),
      "配信元が東証の休場日（2018-07-16 海の日）に入れていた出来高0・前日終値据え置きの行を 1行除去しました" +
        "（残すと営業日数・曜日別の統計・売買シミュレーションに休場日が立会日として混ざります）",
    );
  });

  test("対照群: 東証の暦に従わない系列（米国・投信・為替・ティッカー不明）には一切当てない", () => {
    for (const ticker of ["^GSPC", "AAPL", "0331418A", "USDJPY=X", undefined]) {
      const { prices, report } = repairPriceGlitches(hx.stockRaw, { ticker });
      assert.equal(prices, hx.stockRaw, `${ticker}: 入力配列をそのまま返す`);
      assert.equal(report.removedClosedDays, undefined, `${ticker}: 除去しない`);
      assert.equal(report.sessionSuspects, undefined, `${ticker}: 出来高0の告知もしない`);
    }
    // 既存の呼び出し（オプション無し）も従来どおりスケール破損の修復だけを行う。
    assert.equal(repairPriceGlitches(hx.stockRaw).prices, hx.stockRaw);
  });

  test("対照群: 休場日なのに出来高か値動きのある行は消さず、要目視として報告する", () => {
    const withVolume = hx.stockRaw.map((p) => (p.time === "2018-03-21" ? { ...p, volume: 1200 } : p));
    // 単独の休場日を使う。連休（5/3・5/4 など）の初日を書き換えると、翌日の据え置き行も
    // 「直前の行と同じ終値」でなくなるので一緒に残る（それも保守側として正しい挙動）。
    const withMove = hx.stockRaw.map((p) => (p.time === "2018-11-23" ? { ...p, close: p.close * 1.01 } : p));

    for (const [raw, time, reason] of [
      [withVolume, "2018-03-21", "春分の日"],
      [withMove, "2018-11-23", "勤労感謝の日"],
    ] as const) {
      const { prices, report } = repairPriceGlitches(raw, { ticker: "8306.T" });
      assert.ok(prices.some((p) => p.time === time), `${time}: 中身のある行は消さない`);
      assert.equal(report.removedClosedDays?.length, 21);
      assert.deepEqual(
        report.sessionSuspects?.filter((s) => s.kind === "closedDay"),
        [{ time, kind: "closedDay", reason }],
      );
      assert.equal(hasSanityWarnings(report), true, "日付ずれ等の疑いは警告として扱う");
    }
  });

  test("スケール破損と同居しても両方を直す（除去が先・修復が後）", () => {
    const sessions = hx.stockRaw.map((p, i) => ({ p, i })).filter(({ p }) => p.volume > 0);
    const [a, b] = [sessions[200].i, sessions[201].i];
    const raw = hx.stockRaw.map((p, i) =>
      i === a || i === b
        ? { ...p, open: p.open / 10, high: p.high / 10, low: p.low / 10, close: p.close / 10, volume: p.volume * 10 }
        : p,
    );
    const { prices, report } = repairPriceGlitches(raw, { ticker: "8306.T" });

    assert.equal(report.removedClosedDays?.length, 22);
    assert.equal(report.repaired.length, 1);
    assert.equal(report.repaired[0].factor, 0.1);
    assert.equal(prices.length, hx.stockClean.length);
    let maxRelative = 0;
    for (let i = 0; i < prices.length; i++) {
      maxRelative = Math.max(maxRelative, Math.abs(prices[i].close / hx.stockClean[i].close - 1));
    }
    assert.ok(maxRelative < 1e-12, "除去と修復の後は真の系列に戻る");
  });

  test("入力配列を破壊しない", () => {
    const before = JSON.stringify(hx.stockRaw);
    repairPriceGlitches(hx.stockRaw, { ticker: "8306.T" });
    assert.equal(JSON.stringify(hx.stockRaw), before);
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
