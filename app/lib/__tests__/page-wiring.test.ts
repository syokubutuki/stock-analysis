// `app/page.tsx` の配線が規約から漂流していないかを、ソースを実際に読んで検査する。
//
// なぜソースを読むのか
// --------------------
// ここで守りたい2つの規約は、どちらも**型では表現できず、壊れても画面が壊れない**。
//
//  ① パネルID → 所属セクション（panel-sections.ts）
//     対応が外れると、共有URL `?panel=…` は 60フレーム DOM を探して無言で諦める。
//     例外も警告も出ないので、壊れたことに誰も気づかない。
//
//  ② SERIES_AWARE_SECTIONS（系列セレクタの有効/無効）
//     宣言と実態がずれても、セレクタが効かない／出ないだけで例外は起きない。
//
//  ③ 終値だけの系列（投信）で解釈できるかの分類（panel-data-requirements.ts）
//     分類を忘れたパネルは**通常表示に落ちる**ので、投信で無意味な数字が出る。
//     出るのは数字であって例外ではないため、見ている人にも壊れて見えない（FU22）。
//
// どれも「新しい分析を足したときに、台帳側の更新を忘れる」形で壊れる。
// M3（レジストリ化）が入るまでは人間の注意力だけが担保だったところを、ここで自動化する。
//
// 失敗したときは、テストを緩めるのではなく **表と page.tsx のどちらが正しいかを判断**すること。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sectionForPanel } from "../panel-sections";
import {
  PANEL_IDS_GOLDEN,
  STANDALONE_PANEL_IDS_GOLDEN,
} from "./fixtures/panel-ids.golden";
import {
  CLOSE_ONLY_CAUTION_PANEL_IDS,
  CLOSE_ONLY_SAFE_PANEL_IDS,
  CLOSE_ONLY_UNAVAILABLE_PANEL_IDS,
  classifyPanelForCloseOnly,
} from "../panel-data-requirements";

const PAGE_PATH = fileURLToPath(new URL("../../page.tsx", import.meta.url));
const SOURCE = readFileSync(PAGE_PATH, "utf8");
const LINES = SOURCE.split(/\r?\n/);

interface PanelRef {
  section: string;
  id: string;
  line: number;
}

/**
 * セクションブロック（`{activeSection === "x" && (` 〜 次の同種の行）を辿りながら、
 * `AccordionSection` の項目 `{ id: "…", title: …, node: … }` を拾う。
 * 最初のセクションブロックより前に現れるIDは、節に属さないので対象外。
 */
function scanPage(): { panels: PanelRef[]; seriesModeSections: Set<string> } {
  const panels: PanelRef[] = [];
  const seriesModeSections = new Set<string>();
  let section: string | null = null;

  LINES.forEach((line, i) => {
    const sec = line.match(/activeSection === "([a-z]+)"/);
    if (sec) section = sec[1];
    if (!section) return;
    if (line.includes("seriesMode")) seriesModeSections.add(section);
    const id = line.match(/[{ ]id: "([^"]+)"/);
    if (id) panels.push({ section, id: id[1], line: i + 1 });
  });

  return { panels, seriesModeSections };
}

function declaredSeriesAwareSections(): Set<string> {
  const block = SOURCE.match(/const SERIES_AWARE_SECTIONS = new Set<SectionKey>\(\[([\s\S]*?)\]\)/);
  assert.ok(block, "SERIES_AWARE_SECTIONS の宣言が見つからない（page.tsx の書き方が変わった）");
  return new Set(Array.from(block[1].matchAll(/"([a-z]+)"/g), (m) => m[1]));
}

const { panels, seriesModeSections } = scanPage();

describe("パネルID → セクションの解決（共有URL `?panel=` が正しい節を開くこと）", () => {
  test("page.tsx から十分な数のパネルIDを拾えている（パーサ自身の健全性）", () => {
    // 2026-08-15 時点で 241件。パーサが壊れて0件になったまま
    // 「全部通った」と報告する事故を防ぐための下限。
    assert.ok(panels.length > 200, `拾えたIDが ${panels.length} 件しかない`);
  });

  test("すべてのパネルIDが、実際に置かれている節へ解決する", () => {
    const wrong = panels
      .filter((p) => sectionForPanel(p.id) !== p.section)
      .map((p) => `page.tsx:${p.line} ${p.id} → ${sectionForPanel(p.id) ?? "null"}（実際は ${p.section}）`);
    assert.deepEqual(
      wrong,
      [],
      `panel-sections.ts の表に無い、または対応が誤っているIDがある:\n${wrong.join("\n")}`
    );
  });

  test("節に属さない `data-quality` は基本節へ解決する", () => {
    // 破損点検パネルは全節共通ヘッダから基本節へ移した（FU18）。
    // 共有URLに残っている `?panel=data-quality` を拾えること。
    assert.equal(sectionForPanel("data-quality"), "basic");
  });

  test("`/portfolio` のパネルと未知のIDは null（現在の節のまま探す挙動に落ちる）", () => {
    assert.equal(sectionForPanel("pf-corr-drag"), null);
    assert.equal(sectionForPanel("no-such-panel"), null);
    assert.equal(sectionForPanel(""), null);
  });
});

describe("終値だけの系列での分類（FU17/FU22: 投信で無意味な結果を出さない）", () => {
  const LEDGERS = [
    ["UNAVAILABLE", CLOSE_ONLY_UNAVAILABLE_PANEL_IDS],
    ["CAUTION", CLOSE_ONLY_CAUTION_PANEL_IDS],
    ["SAFE", CLOSE_ONLY_SAFE_PANEL_IDS],
  ] as const;

  test("page.tsx の全パネルが3分類のいずれかに属する（分類漏れを落とす）", () => {
    // ここが本題。新しいパネルを足すと、分類するまでこのテストが落ちる。
    // 落ちたら panel-data-requirements.ts の3つのうち妥当なものへIDを足すこと。
    // 出来高・OHLC内訳・日中/夜間そのものが対象なら UNAVAILABLE、
    // 一部のサブ分析だけがそうなら CAUTION、終値だけで成立するなら SAFE。
    const unclassified = panels
      .filter((p) => classifyPanelForCloseOnly(p.id) === null)
      .map((p) => `page.tsx:${p.line} ${p.id}（${p.section} 節）`);
    assert.deepEqual(unclassified, [], `未分類のパネルがある:\n${unclassified.join("\n")}`);
  });

  test("3分類に重複が無い（1つのIDが2つの扱いを持たない）", () => {
    const overlaps: string[] = [];
    for (let i = 0; i < LEDGERS.length; i += 1) {
      for (let j = i + 1; j < LEDGERS.length; j += 1) {
        for (const id of LEDGERS[i][1]) {
          if (LEDGERS[j][1].has(id)) overlaps.push(`${id}: ${LEDGERS[i][0]} と ${LEDGERS[j][0]}`);
        }
      }
    }
    assert.deepEqual(overlaps, [], `分類が重複している:\n${overlaps.join("\n")}`);
  });

  test("台帳のIDがすべて page.tsx に実在する（改名・削除で腐るのを検知）", () => {
    // 分類漏れとは逆向きの腐り方。IDを改名すると台帳側だけが古い名前を持ち続け、
    // そのパネルは投信で無防備になる（改名先が未分類なら上のテストが拾う）。
    const live = new Set(panels.map((p) => p.id));
    const dead = LEDGERS.flatMap(([name, ids]) =>
      [...ids].filter((id) => !live.has(id)).map((id) => `${name}: ${id}`),
    );
    assert.deepEqual(dead, [], `page.tsx に無いIDが台帳に残っている:\n${dead.join("\n")}`);
  });

  test("UNAVAILABLE と CAUTION が空になっていない（台帳ごと消える退行を止める）", () => {
    // 空の Set を渡しても画面は普通に動いてしまう。FU17 の対処が丸ごと消えても
    // 気づけないので、件数の下限だけ置く。
    assert.ok(CLOSE_ONLY_UNAVAILABLE_PANEL_IDS.size > 50);
    assert.ok(CLOSE_ONLY_CAUTION_PANEL_IDS.size > 10);
  });
});

describe("系列セレクタの対応（U3: 使えないコントロールを出さない）", () => {
  test("SERIES_AWARE_SECTIONS が、実際に seriesMode を渡す節の集合と一致する", () => {
    const declared = declaredSeriesAwareSections();
    const actual = seriesModeSections;
    const missing = [...actual].filter((s) => !declared.has(s)).sort();
    const extra = [...declared].filter((s) => !actual.has(s)).sort();
    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      "missing = seriesMode を使うのに宣言が無い節（セレクタが出ず操作できない）/ " +
        "extra = 宣言はあるが誰も seriesMode を使わない節（セレクタが出るのに何も起きない）"
    );
  });
});

describe("パネルIDの互換契約（共有URL `?panel=` と localStorage `sa:open:<id>`）", () => {
  // M3（レジストリ化）はIDの**所在**を動かす作業である。移設で1つでもIDが変わると、
  // 共有されたURLと保存済みの開閉状態が静かに壊れる。壊れても例外は出ないので、
  // 移設の前後で同じ配列と突き合わせる以外に検知手段が無い。
  test("並び順込みで golden と完全一致する", () => {
    assert.deepEqual(panels.map((p) => p.id), [...PANEL_IDS_GOLDEN]);
  });

  test("AccordionSection 外のパネルも所属節へ解決する", () => {
    for (const id of STANDALONE_PANEL_IDS_GOLDEN) {
      assert.ok(sectionForPanel(id), `${id} の所属節が解決できない`);
    }
  });
});

describe("結果バッジのパネルID（FU33: 移設でバッジが無言で消えるのを止める）", () => {
  // `useAnalysisResultSummary("tech-adx", …)` は page.tsx が持つIDを
  // **コンポーネント側が文字列で複製**している。page.tsx 側でIDを変えると
  // Provider が受け取るキーだけがずれ、**バッジが何も言わずに出なくなる**。
  // 例外もログも出ないので、突き合わせる以外に検知手段が無い。
  const componentDir = fileURLToPath(new URL("../../components/analysis/", import.meta.url));
  const badgeIds = readdirSync(componentDir)
    .filter((f) => f.endsWith(".tsx"))
    .flatMap((f) => {
      const src = readFileSync(join(componentDir, f), "utf8");
      return [...src.matchAll(/useAnalysisResultSummary\(\s*"([^"]+)"/g)].map((m) => ({
        file: f,
        id: m[1],
      }));
    });

  test("スキャナ自身が生きている（0件のまま「全部通った」と報告しない）", () => {
    // 2026-08-28 時点で7件（S15 がテクニカル節に入れたぶん）。
    assert.ok(badgeIds.length >= 7, `拾えたバッジIDが ${badgeIds.length} 件しかない`);
  });

  test("バッジのIDがすべて実在するパネルを指している", () => {
    const live = new Set(panels.map((p) => p.id));
    const dead = badgeIds.filter((b) => !live.has(b.id)).map((b) => `${b.file}: "${b.id}"`);
    assert.deepEqual(dead, [], `実在しないIDでバッジを報告している:\n${dead.join("\n")}`);
  });

  test("バッジのIDが終値だけの系列の分類に載っている", () => {
    // UNAVAILABLE のパネルは本体がマウントされないのでバッジも構造的に出ない（§0.6③）。
    // どのIDがその状態かを台帳側から引けることを、ここで保証しておく。
    const missing = badgeIds
      .filter((b) => classifyPanelForCloseOnly(b.id) === null)
      .map((b) => `${b.file}: "${b.id}"`);
    assert.deepEqual(missing, [], `台帳に無いIDでバッジを報告している:\n${missing.join("\n")}`);
  });
});
