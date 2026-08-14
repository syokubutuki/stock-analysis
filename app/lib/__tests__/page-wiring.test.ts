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
// どちらも「新しい分析を足したときに、台帳側の更新を忘れる」形で壊れる。
// FU22（投信の非対応パネル台帳が page.tsx にハードコード）と同じ fail-open の構造で、
// M3（レジストリ化）が入るまでは人間の注意力だけが担保になっている。ここを自動化する。
//
// 失敗したときは、テストを緩めるのではなく **表と page.tsx のどちらが正しいかを判断**すること。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sectionForPanel } from "../panel-sections";

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
