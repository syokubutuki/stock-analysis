// TrueType の `cmap` から「このフォントが実際に描ける文字」を読み出す。
//
// なぜ要るか
// ----------
// OG画像の `OG_FONT_CHARSET` は「同梱サブセットが収録している文字」の**申告**であって、
// フォントそのものではない。銘柄を足したときに文字列だけ書き足してフォントを焼き直さ
// ないと、`coveredByOgFont()` は true を返し、**豆腐がそのまま画像に焼かれる**。
// 申告とフォント実体を突き合わせられるのは cmap を読む以外に無い。
//
// 実装のヘルパーは流用できない（実装側に cmap を読むコードは存在しない）ので、
// ここは仕様（OpenType `cmap` format 4 / 12）からの独立実装である。

/** サブセットTTFが glyph を持つコードポイントの集合。format 4 と 12 のみ扱う。 */
export function cmapCodePoints(font: Buffer): Set<number> {
  const numTables = font.readUInt16BE(4);
  let cmapOffset = -1;
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    if (font.toString("latin1", record, record + 4) === "cmap") {
      cmapOffset = font.readUInt32BE(record + 8);
    }
  }
  if (cmapOffset < 0) throw new Error("cmap テーブルが無い（TrueType として壊れている）");

  const subtableCount = font.readUInt16BE(cmapOffset + 2);
  const subtables = new Set<number>();
  for (let i = 0; i < subtableCount; i += 1) {
    subtables.add(cmapOffset + font.readUInt32BE(cmapOffset + 4 + i * 8 + 4));
  }

  const out = new Set<number>();
  for (const offset of subtables) {
    const format = font.readUInt16BE(offset);
    if (format === 4) readFormat4(font, offset, out);
    else if (format === 12) readFormat12(font, offset, out);
  }
  if (out.size === 0) throw new Error("cmap から1文字も読めなかった（パーサが壊れている）");
  return out;
}

/** format 4: BMP をセグメント（startCode..endCode）で写す。glyph 0 は「無い」扱い。 */
function readFormat4(font: Buffer, offset: number, out: Set<number>): void {
  const segCountX2 = font.readUInt16BE(offset + 6);
  const endOffset = offset + 14;
  const startOffset = endOffset + segCountX2 + 2; // +2 は reservedPad
  const deltaOffset = startOffset + segCountX2;
  const rangeOffset = deltaOffset + segCountX2;

  for (let seg = 0; seg < segCountX2 / 2; seg += 1) {
    const end = font.readUInt16BE(endOffset + seg * 2);
    const start = font.readUInt16BE(startOffset + seg * 2);
    const delta = font.readInt16BE(deltaOffset + seg * 2);
    const range = font.readUInt16BE(rangeOffset + seg * 2);
    if (start === 0xffff) continue; // 終端番兵
    for (let code = start; code <= end; code += 1) {
      let glyph: number;
      if (range === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        const index = rangeOffset + seg * 2 + range + (code - start) * 2;
        if (index + 1 >= font.length) continue;
        const raw = font.readUInt16BE(index);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) out.add(code);
    }
  }
}

/** format 12: BMP 外も含む連続グループ。 */
function readFormat12(font: Buffer, offset: number, out: Set<number>): void {
  const groups = font.readUInt32BE(offset + 12);
  for (let i = 0; i < groups; i += 1) {
    const group = offset + 16 + i * 12;
    const start = font.readUInt32BE(group);
    const end = font.readUInt32BE(group + 4);
    for (let code = start; code <= end; code += 1) out.add(code);
  }
}
