// パネル登録のレジストリが規約から漂流していないかを検査する。
//
// なぜこのテストが要るのか
// ------------------------
// ここで守る規約は、どれも**壊れても画面が壊れない**。例外もログも出ないので、
// 突き合わせる以外に検知手段が無い。
//
//  ① パネルID（共有URL `?panel=` と localStorage `sa:open:<id>` の鍵）
//     1つ変えるだけで、その利用者にとっては「前に見ていた分析が開かない」形で壊れる。
//
//  ② パネルID → 所属セクション
//     解決できないと共有URLは 60フレーム DOM を探して**無言で諦める**（FU25）。
//
//  ③ 終値だけの系列（投信）での分類
//     分類を忘れたパネルは通常表示に落ち、投信で無意味な数字が出る（FU17/FU22）。
//
//  ④ 系列セレクタ（seriesMode を消費する節）
//     宣言と実態がずれても、セレクタが効かない／出ないだけで例外は起きない。
//
//  ⑤ 結果バッジのパネルID（FU33）
//     コンポーネント側が文字列で複製しているので、ずれるとバッジが無言で消える。
//
// **M3（レジストリ化）で ②③④ は導出になった**ので「台帳の更新を忘れる」形では
// もう壊れない。それでも検査を残すのは、導出の元になる各レコードの `section` /
// `closeOnly` / `input` を書き間違える余地が残るからである。
//
// 失敗したときは、テストを緩めるのではなく
// **レジストリと golden のどちらが正しいかを判断**すること。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PANEL_IDS_GOLDEN,
  STANDALONE_PANEL_IDS_GOLDEN,
} from "./fixtures/panel-ids.golden";
import {
  CLOSE_ONLY_CAUTION_PANEL_IDS,
  CLOSE_ONLY_SAFE_PANEL_IDS,
  CLOSE_ONLY_UNAVAILABLE_PANEL_IDS,
  PANELS,
  SECTIONS,
  SERIES_AWARE_SECTIONS,
  STANDALONE_PANELS,
  classifyPanelForCloseOnly,
  consumesSeriesMode,
  sectionForPanel,
} from "../panel-registry";

const PAGE_SOURCE = readFileSync(
  fileURLToPath(new URL("../../page.tsx", import.meta.url)),
  "utf8",
);

const COMPONENT_DIR = fileURLToPath(new URL("../../components/analysis/", import.meta.url));

function analysisSources(): { file: string; src: string }[] {
  return readdirSync(COMPONENT_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => ({ file: f, src: readFileSync(join(COMPONENT_DIR, f), "utf8") }));
}

describe("パネルIDの互換契約（共有URL `?panel=` と localStorage `sa:open:<id>`）", () => {
  test("レジストリの並び順込みで golden と完全一致する", () => {
    // M3 はIDの**所在**を動かす作業だった。移設で1つでもIDが変わっていればここが落ちる。
    // 落ちたときに golden を書き換えないこと（理由は fixtures の冒頭）。
    assert.deepEqual(PANELS.map((p) => p.id), [...PANEL_IDS_GOLDEN]);
  });

  test("AccordionSection 外のパネルも golden と一致する", () => {
    assert.deepEqual(STANDALONE_PANELS.map((p) => p.id), [...STANDALONE_PANEL_IDS_GOLDEN]);
  });

  test("IDが重複していない", () => {
    const seen = new Set<string>();
    const dup = PANELS.map((p) => p.id).filter((id) => {
      if (seen.has(id)) return true;
      seen.add(id);
      return false;
    });
    assert.deepEqual(dup, []);
  });

  test("パネルの定義が page.tsx から消えている（レジストリへ一本化されたこと）", () => {
    // 移設前の page.tsx は `{ id: "…", title: "…", node: <X … /> }` を 251件持っていた。
    // 1件でも残っていれば二重管理が復活している。
    const leftovers = [...PAGE_SOURCE.matchAll(/\{ id: "([^"]+)", title: "/g)].map((m) => m[1]);
    assert.deepEqual(leftovers, [], `page.tsx にパネル定義が残っている:\n${leftovers.join("\n")}`);
  });
});

describe("パネルID → セクションの解決（共有URL `?panel=` が正しい節を開くこと）", () => {
  test("レジストリの全パネルが自分の節へ解決する", () => {
    const wrong = PANELS
      .filter((p) => sectionForPanel(p.id) !== p.section)
      .map((p) => `${p.id} → ${sectionForPanel(p.id) ?? "null"}（実際は ${p.section}）`);
    assert.deepEqual(wrong, [], wrong.join("\n"));
  });

  test("`data-quality` は基本節へ解決する", () => {
    // 破損点検パネルは全節共通ヘッダから基本節へ移した（FU18）。
    // 共有URLに残っている `?panel=data-quality` を拾えること。
    assert.equal(sectionForPanel("data-quality"), "basic");
  });

  test("`/portfolio` のパネルと未知のIDは null（現在の節のまま探す挙動に落ちる）", () => {
    assert.equal(sectionForPanel("pf-corr-drag"), null);
    assert.equal(sectionForPanel("no-such-panel"), null);
    assert.equal(sectionForPanel(""), null);
  });

  test("IDの接頭辞が所属節の命名規約に沿っている", () => {
    // 解決そのものはレジストリの `section` が持つので、この検査は**人間のため**に残す。
    // `cal-` なのに regime 節にある、のようなIDは共有URLを壊さないが必ず混乱を招く。
    // 新しいパネルのIDが規約から外れたらここで落ちる（`add-analysis` skill の §4）。
    const HEAD_TO_SECTION: Record<string, string> = {
      asof: "asof", basic: "basic", cal: "calendar", causal: "causal", cond: "conditional",
      deriv: "derivatives", dist: "distribution", distribution: "distribution", edge: "edge",
      ent: "entropy", entropy: "entropy", frac: "fractal", fractal: "fractal", freq: "frequency",
      frequency: "frequency", net: "network", network: "network", nl: "nonlinear",
      nonlinear: "nonlinear", ohlc: "ohlc", quantum: "quantum", regime: "regime", risk: "risk",
      sim: "simulation", tail: "tailrisk", tech: "technical", technical: "technical",
      transform: "transform", vol: "volatility", volatility: "volatility",
    };
    const off = PANELS
      .filter((p) => {
        // 旧アンカー形式 `sa-<節>-…` は先頭の `sa-` を落としてから見る。
        const body = p.id.startsWith("sa-") ? p.id.slice(3) : p.id;
        return HEAD_TO_SECTION[body.split("-")[0]] !== p.section;
      })
      .map((p) => `${p.id}（${p.section} 節）`);
    assert.deepEqual(off, [], `命名規約から外れたIDがある:\n${off.join("\n")}`);
  });
});

describe("終値だけの系列での分類（FU17/FU22: 投信で無意味な結果を出さない）", () => {
  test("全パネルがちょうど1つの分類に属する", () => {
    // 型が `closeOnly` を必須にしているので分類漏れは構造的に起こらないが、
    // 導出（`CLOSE_ONLY_*_PANEL_IDS`）が3つ合わせて全件を覆っていることは確かめる。
    const sum =
      CLOSE_ONLY_UNAVAILABLE_PANEL_IDS.size +
      CLOSE_ONLY_CAUTION_PANEL_IDS.size +
      CLOSE_ONLY_SAFE_PANEL_IDS.size;
    assert.equal(sum, PANELS.length);
    assert.deepEqual(PANELS.filter((p) => classifyPanelForCloseOnly(p.id) === null), []);
  });

  test("分類の内訳が意図せず動いていない", () => {
    // 2026-08-31 時点の実測値。**動かすのは判断を伴う変更のときだけ**で、
    // そのときは理由を残すこと。S17 は tech-adx / tech-breakout / tech-stoch / vol-atr の
    // 4件を SAFE → UNAVAILABLE へ倒した（78/24/149=251）。その後 6330e4d が
    // sim-holding-ledger を CAUTION で足して 78/25/149=252 になった。
    assert.deepEqual(
      {
        unavailable: CLOSE_ONLY_UNAVAILABLE_PANEL_IDS.size,
        caution: CLOSE_ONLY_CAUTION_PANEL_IDS.size,
        safe: CLOSE_ONLY_SAFE_PANEL_IDS.size,
      },
      { unavailable: 78, caution: 25, safe: 149 },
    );
  });

  test("高安を要する4件が UNAVAILABLE のまま（S17 の判断を戻さない）", () => {
    // 投信 0331418A で tech-adx が ADX 13.64 ともっともらしい誤解釈を出した事故。
    for (const id of ["tech-adx", "tech-breakout", "tech-stoch", "vol-atr"]) {
      assert.equal(classifyPanelForCloseOnly(id), "unavailable", id);
    }
  });
});

describe("系列セレクタの対応（U3: 使えないコントロールを出さない）", () => {
  test("seriesMode を消費するパネルを持つ節の集合が変わっていない", () => {
    // 移設前は手で宣言していた（宣言と実態がずれうる）が、いまは各パネルの
    // `input` からの導出である。ここが落ちるのは、どれかのパネルの `input` を
    // 変えて節ぜんたいのセレクタの有無が変わったときだけ。
    assert.deepEqual(
      [...SERIES_AWARE_SECTIONS].sort(),
      [
        "causal", "distribution", "entropy", "fractal", "frequency", "network",
        "nonlinear", "quantum", "regime", "simulation", "tailrisk", "transform",
        "volatility",
      ],
    );
  });

  test("節の中で実際に反応するのは一部である（FU24 の実測を固定する）", () => {
    // セレクタは節単位だが、反応するかはパネル単位である。この差は退行ではなく
    // 未解決の課題（FU24）なので、数を固定して「いつの間にか変わった」を防ぐ。
    const ratio = (key: string) => {
      const inSection = PANELS.filter((p) => p.section === key);
      return `${inSection.filter((p) => consumesSeriesMode(p.input)).length}/${inSection.length}`;
    };
    assert.deepEqual(
      {
        distribution: ratio("distribution"),
        simulation: ratio("simulation"),
        quantum: ratio("quantum"),
      },
      { distribution: "12/16", simulation: "2/18", quantum: "1/6" },
    );
  });
});

describe("AccordionSection 外の節エントリ（FU27: 裁量節はパネルIDを持たない）", () => {
  test("discretionary は workspace 種別で、パネルを1件も持たない", () => {
    const discretionary = SECTIONS.find((s) => s.key === "discretionary");
    assert.ok(discretionary, "discretionary 節が消えている");
    assert.equal(discretionary.render, "workspace");
    assert.deepEqual(discretionary.groups, []);
    assert.ok(discretionary.Workspace, "workspace のコンポーネントが登録されていない");
  });

  test("裁量節に解決するパネルIDが1つも無い（擬似IDを作らない）", () => {
    // 複数の入力・検証工程とシナリオ保存を一体で扱う常時表示ワークスペースであり、
    // 単一の折りたたみ分析ではない。共有URL `?panel=` と結果バッジの対象外である。
    assert.deepEqual(PANELS.filter((p) => p.section === "discretionary"), []);
    assert.deepEqual(STANDALONE_PANELS.filter((p) => p.section === "discretionary"), []);
  });

  test("workspace 以外の全節がパネルを持つ（節ごと空になる退行を止める）", () => {
    const empty = SECTIONS
      .filter((s) => s.render === "panels" && s.groups.every((g) => g.panels.length === 0))
      .map((s) => s.key);
    assert.deepEqual(empty, []);
  });
});

describe("結果バッジのパネルID（FU33: 移設でバッジが無言で消えるのを止める）", () => {
  // `useAnalysisResultSummary("tech-adx", …)` は、レジストリが持つべきIDを
  // **コンポーネント側が文字列で複製**している。レジストリ側でIDを変えると
  // Provider が受け取るキーだけがずれ、**バッジが何も言わずに出なくなる**。
  const badgeIds = analysisSources().flatMap(({ file, src }) =>
    [...src.matchAll(/useAnalysisResultSummary\(\s*"([^"]+)"/g)].map((m) => ({ file, id: m[1] })),
  );

  test("スキャナ自身が生きている（0件のまま「全部通った」と報告しない）", () => {
    // 2026-08-28 時点で7件（S15 がテクニカル節に入れたぶん）。
    assert.ok(badgeIds.length >= 7, `拾えたバッジIDが ${badgeIds.length} 件しかない`);
  });

  test("バッジのIDがすべて実在するパネルを指している", () => {
    const live = new Set(PANELS.map((p) => p.id));
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

  test("バッジに「量」を載せていない（FU34: 判断だけを出す）", () => {
    // 型（PanelResultSummary）が finding に up/down を必須にしたので
    // `{ status: "finding", direction: "flat" }` はもう書けない。ここでは
    // 「N件」のような量をラベルに載せる書き方が復活していないかを見る。
    const quantityish = analysisSources()
      .filter(({ src }) =>
        [...src.matchAll(/useAnalysisResultSummary\([\s\S]{0,800}?\n {2}\);/g)].some((m) =>
          /label: `[^`]*\$\{[^`]*\}[^`]*件`/.test(m[0]),
        ),
      )
      .map(({ file }) => file);
    assert.deepEqual(quantityish, [], `バッジに件数を載せている:\n${quantityish.join("\n")}`);
  });
});
