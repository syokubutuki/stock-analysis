import type { Instrument } from "./instruments";
import { INSTRUMENTS } from "./instruments";

export type InstrumentMatchKind = "code" | "exact" | "prefix" | "partial";
export interface InstrumentSearchResult {
  instrument: Instrument;
  match: InstrumentMatchKind;
  score: number;
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase().replace(
    /[ぁ-ゖ]/g,
    (character) => String.fromCharCode(character.charCodeAt(0) + 0x60),
  );
}

export function compactSearchKey(value: string): string {
  return normalizeSearchText(value).replace(/[\s\p{P}\p{S}]+/gu, "");
}

function matchInstrument(
  instrument: Instrument,
  query: string,
): Omit<InstrumentSearchResult, "instrument"> | null {
  const normalizedQuery = normalizeSearchText(query);
  const compactQuery = compactSearchKey(query);
  if (!compactQuery) return null;
  const codes = [instrument.ticker, instrument.yahooSymbol].map(normalizeSearchText);
  if (codes.includes(normalizedQuery)) return { match: "code", score: 400 };
  const names = [instrument.name, instrument.nameEn, ...instrument.aliases]
    .filter((value): value is string => Boolean(value))
    .map(compactSearchKey);
  if (names.includes(compactQuery)) return { match: "exact", score: 300 };
  if (names.some((name) => name.startsWith(compactQuery))) return { match: "prefix", score: 200 };
  if (names.some((name) => name.includes(compactQuery))) return { match: "partial", score: 100 };
  return null;
}

export function searchLocalInstruments(query: string, limit = 10): InstrumentSearchResult[] {
  return INSTRUMENTS.flatMap((instrument) => {
    const result = matchInstrument(instrument, query);
    return result ? [{ instrument, ...result }] : [];
  }).sort((a, b) =>
    b.score - a.score ||
    Number(b.instrument.priceSupported) - Number(a.instrument.priceSupported) ||
    Number(b.instrument.major) - Number(a.instrument.major) ||
    a.instrument.name.localeCompare(b.instrument.name, "ja"),
  ).slice(0, Math.max(0, limit));
}

export function hasSufficientLocalResults(results: readonly InstrumentSearchResult[]): boolean {
  return results.some((result) => result.match === "code" || result.match === "exact") || results.length >= 5;
}
