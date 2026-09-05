// 課金境界（`app/lib/tiers.ts`）がパネルレジストリから漂流していないかを検査する（FU43）。
//
// なぜこのテストが要るのか
// ------------------------
// `tiers.ts` は Pro 限定の例外リスト `FREE_PANEL_IDS` に**パネルIDを文字列で複製**している。
// レジストリ側でIDを改名すると:
//
//   * その例外は誰も指さない死んだ文字列になる（IDが実在しなくなる）
//   * 改名後のパネルは接頭辞だけで判定され、**無言で有料側へ落ちる**
//
// どちらも例外は出ず、`PAYWALL_ENABLED = false` の現在は画面も1ピクセルも変わらない。
// FU33（`useAnalysisResultSummary` のID複製）とまったく同じ形で、M3 の吸収し残しである。
//
// 導出にしなかった理由
// --------------------
// レジストリ側に `free: true` を持たせれば導出にできるが、採らなかった。
//
//   * 課金境界は**意味の問題**である。§6.4 は「推奨に課金しない」「検証基盤は無料側に置く」
//     という法務・製品上の判断で、それを 252レコードへ散らすと
//     「いま何が無料で、なぜか」が1画面で読めなくなる。`tiers.ts` 冒頭の設計方針が
//     そのまま境界の定義になっている現状のほうが、この判断の書き場所として正しい
//   * 実際の境界はカテゴリ接頭辞（`FREE_CATEGORIES` / `FREE_SERIES_SEGMENTS`）が
//     大半を決めており、レコード側のフラグにすると同じ規則を252回書き写すことになる
//
// そこで**導出ではなくテストで縛る**。ずれを起こせなくはできないが、
// ずれた瞬間に落ちるようにする。
//
// 落ちたときは、まず **「無料だったものが有料側へ移っていないか」** を確かめること。
// 移っていれば §6.4 違反であり、直すのは黄金値ではなくレジストリ側のIDか `tiers.ts` である。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FREE_PANEL_IDS_GOLDEN } from "./fixtures/free-panel-ids.golden";
import { PANELS, STANDALONE_PANELS } from "../panel-registry";
import { FREE_PANEL_IDS, PAYWALL_ENABLED, canViewPanel, isPanelFree } from "../tiers";

/** `canViewPanel` が実際に問われるのはアコーディオンのパネルだけ（下の呼び出し元の検査を参照）。 */
const FREE = PANELS.filter((p) => isPanelFree(p.id));
const PAID = PANELS.filter((p) => !isPanelFree(p.id));

/** ID → 無料判定がどの経路で決まったか。内訳を固定して境界の動きを可視化する。 */
function freeRoute(id: string): "individual" | "series-segment" | "category" | "paid" {
  if (FREE_PANEL_IDS.has(id)) return "individual";
  if (!isPanelFree(id)) return "paid";
  return id.split("-")[0] === "sa" ? "series-segment" : "category";
}

describe("スキャナの生存確認（0件のまま「全部通った」と報告しない）", () => {
  test("レジストリと例外リストが空になっていない", () => {
    assert.ok(PANELS.length >= 200, `パネルが ${PANELS.length} 件しか読めていない`);
    assert.ok(
      FREE_PANEL_IDS.size >= 8,
      `FREE_PANEL_IDS が ${FREE_PANEL_IDS.size} 件しかない（2026-09-05 実測は8件）`,
    );
    assert.ok(FREE.length >= 50, `無料判定が ${FREE.length} 件しか出ていない`);
    assert.ok(PAID.length >= 50, `有料判定が ${PAID.length} 件しか出ていない`);
  });
});

describe("FREE_PANEL_IDS とレジストリの双方向突き合わせ", () => {
  test("8件の顔ぶれが変わっていない（検証基盤を無料側に置く §6.4）", () => {
    // ここに並ぶのは「自分の発見を疑うための道具」だけである。
    // 増減させるときは tiers.ts 冒頭の設計方針と照らして判断すること。
    assert.deepEqual([...FREE_PANEL_IDS].sort(), [
      "cal-null-anatomy",
      "cal-null-calib",
      "cal-weekly-analog-oos",
      "edge-decay",
      "edge-ledger",
      "edge-power",
      "edge-test-registry",
      "edge-walkforward",
    ]);
  });

  test("全IDがレジストリに実在する（改名で死んだ文字列になっていない）", () => {
    const live = new Set([...PANELS, ...STANDALONE_PANELS].map((p) => p.id));
    const dead = [...FREE_PANEL_IDS].filter((id) => !live.has(id));
    assert.deepEqual(
      dead,
      [],
      `FREE_PANEL_IDS に実在しないIDがある:\n${dead.join("\n")}\n\n` +
        "レジストリで改名した可能性が高い。改名後のIDは接頭辞だけで判定され、" +
        "無言で有料側へ落ちている（§6.4 が禁じている向き）。",
    );
  });

  test("8件とも実際に無料判定になる（例外が効いている）", () => {
    // カテゴリ接頭辞（edge / cal）はどちらも有料側なので、例外が外れれば全件有料に倒れる。
    const notFree = [...FREE_PANEL_IDS].filter((id) => !isPanelFree(id));
    assert.deepEqual(notFree, [], `例外に載っているのに有料判定:\n${notFree.join("\n")}`);
  });

  test("8件が edge / calendar 節に居る（節ごと無料化していない）", () => {
    const sections = [...FREE_PANEL_IDS]
      .map((id) => PANELS.find((p) => p.id === id)?.section)
      .filter((s): s is string => s !== undefined);
    assert.equal(sections.length, FREE_PANEL_IDS.size);
    assert.deepEqual([...new Set(sections)].sort(), ["calendar", "edge"]);
    // 節ぜんたいは有料のままであること（無料化したのは個別の8件だけ）。
    assert.ok(PANELS.some((p) => p.section === "edge" && !isPanelFree(p.id)));
    assert.ok(PANELS.some((p) => p.section === "calendar" && !isPanelFree(p.id)));
  });
});

describe("isPanelFree() の判定結果そのもの（黄金値）", () => {
  test("無料/有料の内訳が動いていない", () => {
    // 2026-09-05 実測。**動かすのは判断を伴う変更のときだけ**で、そのときは
    // 「無料だったものを有料へ移していない」ことを確かめてから録り直すこと（§6.4）。
    assert.deepEqual(
      { free: FREE.length, paid: PAID.length, total: PANELS.length },
      { free: 86, paid: 166, total: 252 },
    );
  });

  test("無料判定になるパネルの集合が黄金値と一致する（入れ替わりも検知する）", () => {
    // 件数だけでは「1件が無料→有料・別の1件が有料→無料」の入れ替わりを見逃す。
    assert.deepEqual(FREE.map((p) => p.id), [...FREE_PANEL_IDS_GOLDEN]);
  });

  test("判定経路ごとの内訳が動いていない（FREE_SERIES_SEGMENTS 側の変更も拾う）", () => {
    // `FREE_PANEL_IDS` を触らなくても、`FREE_CATEGORIES` / `FREE_SERIES_SEGMENTS` を
    // 1語足すだけで境界は動く。経路別に数えておくと、どちらが動いたかがすぐ分かる。
    const counts = { individual: 0, "series-segment": 0, category: 0, paid: 0 };
    for (const panel of PANELS) counts[freeRoute(panel.id)] += 1;
    assert.deepEqual(counts, {
      individual: 8,
      "series-segment": 8,
      category: 70,
      paid: 166,
    });
  });

  test("節ごとの無料件数が動いていない", () => {
    const bySection: Record<string, number> = {};
    for (const panel of FREE) {
      bySection[panel.section] = (bySection[panel.section] ?? 0) + 1;
    }
    assert.deepEqual(bySection, {
      basic: 21,
      technical: 7,
      ohlc: 17,
      risk: 13,
      transform: 4,
      distribution: 16,
      edge: 5,
      calendar: 3,
    });
  });

  test("`sa-` の2段構えが両方効いている", () => {
    // `sa-technical`（2セグメント）と `sa-ohlc-gap`（3セグメント）の両方を扱う分岐。
    assert.equal(isPanelFree("sa-technical"), true);
    assert.equal(isPanelFree("sa-ohlc-gap"), true);
    assert.equal(isPanelFree("sa-frequency-ssa"), false);
    assert.equal(isPanelFree("sa"), false, "`sa` 単体を無料にしてはいけない");
    assert.equal(isPanelFree(""), false);
    assert.equal(isPanelFree("no-such-panel"), false);
  });
});

describe("課金境界が問われる範囲（黄金値の適用対象）", () => {
  const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));

  function sourcesUsing(needle: string): string[] {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "__tests__") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry) && readFileSync(full, "utf8").includes(needle)) {
          hits.push(full.slice(APP_DIR.length).replace(/\\/g, "/"));
        }
      }
    };
    walk(APP_DIR);
    return hits.sort();
  }

  test("`canViewPanel` の呼び出し元が AccordionSection だけである", () => {
    // 上の黄金値は `PANELS`（アコーディオンの252件）に対する内訳である。
    // 別の場所から問い始めると、対象範囲が黙って広がる。
    const callers = sourcesUsing("canViewPanel(").filter((f) => f !== "lib/tiers.ts");
    assert.ok(callers.length >= 1, "呼び出し元を1件も拾えていない（走査が壊れている）");
    assert.deepEqual(callers, ["components/analysis/AccordionSection.tsx"]);
  });

  test("STANDALONE_PANELS は課金境界の外にある", () => {
    // `data-quality` は page.tsx が直接描くのでアコーディオンを通らず、
    // `canViewPanel` に問われることが無い（＝上の内訳の対象外）。
    // 価格修復の開示は CLAUDE.md の要求なので、壁の内側に入る経路を作らないこと。
    for (const panel of STANDALONE_PANELS) {
      assert.equal(
        PANELS.some((p) => p.id === panel.id),
        false,
        `${panel.id} がアコーディオン側にも登録された。課金境界の対象範囲が変わる`,
      );
    }
  });
});

describe("canViewPanel(): 総スイッチと権限の合成", () => {
  test("PAYWALL_ENABLED は false のまま（Stripe と認証が入るまで）", () => {
    assert.equal(PAYWALL_ENABLED, false);
  });

  test("スイッチが false の間は free でも全パネルが見られる", () => {
    const blocked = PANELS.filter((p) => !canViewPanel(p.id, "free")).map((p) => p.id);
    assert.deepEqual(blocked, [], `課金前なのに閉じているパネルがある:\n${blocked.join("\n")}`);
  });

  test("pro は無料判定に依らず全パネルを見られる", () => {
    const blocked = PANELS.filter((p) => !canViewPanel(p.id, "pro")).map((p) => p.id);
    assert.deepEqual(blocked, []);
  });
});
