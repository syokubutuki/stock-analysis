// docs/site-improvement-round5.md の §3 から、そのまま貼れるプロンプトを組み立てる。
// 「共通ひな形＋各セッション」を手で合成すると、ひな形を直したのに片方へ反映されず
// 古いまま投げられる（第1波で分岐点が古くなったのと同じ失敗の形）。
//
//   node docs/tools/build-session-prompts.mjs          … 未完了のセッション全部
//   node docs/tools/build-session-prompts.mjs S17 S18  … 指定したものだけ
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";

const SRC = "docs/site-improvement-round5.md";
const OUT_DIR = "docs/prompts";
const PLACEHOLDER = "［共通ひな形をここに貼る］";

const doc = readFileSync(SRC, "utf8");

/** 見出しの直後にある最初のコードフェンスの中身を返す */
function blockAfter(heading) {
  const i = doc.indexOf(heading);
  if (i < 0) throw new Error(`見出しが見つからない: ${heading}`);
  const start = doc.indexOf("\n```\n", i);
  if (start < 0) throw new Error(`コードフェンスが見つからない: ${heading}`);
  const from = start + 5;
  const end = doc.indexOf("\n```", from);
  if (end < 0) throw new Error(`コードフェンスが閉じていない: ${heading}`);
  return doc.slice(from, end);
}

// 「### S17 — …」の形の見出しだけを拾う。完了済みは「### ~~S15~~ — …」なので外れる。
const headings = [...doc.matchAll(/^### (S\d+) — .*$/gm)].map((m) => ({
  id: m[1],
  heading: m[0],
}));

const want = process.argv.slice(2).map((a) => a.toUpperCase());
const targets = want.length ? headings.filter((h) => want.includes(h.id)) : headings;
if (!targets.length) throw new Error(`該当なし: ${want.join(", ") || "(未完了の見出しが無い)"}`);

const common = blockAfter("### 共通ひな形").trim();
mkdirSync(OUT_DIR, { recursive: true });

for (const { id, heading } of targets) {
  const body = blockAfter(heading);
  if (!body.includes(PLACEHOLDER)) {
    console.warn(`  skip ${id}: ひな形の差し込み位置がない`);
    continue;
  }
  const out = `${OUT_DIR}/${id.toLowerCase()}.md`;
  writeFileSync(out, body.replace(PLACEHOLDER, common).trim() + "\n", "utf8");
  console.log(`  ${out}`);
}

const first = targets[0].id.toLowerCase();
console.log(`
貼るとき:   Get-Content ${OUT_DIR}/${first}.md -Raw | Set-Clipboard`);
console.log(`いまある:   ${readdirSync(OUT_DIR).join(" / ")}`);
