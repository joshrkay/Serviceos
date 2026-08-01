/**
 * Client-side fuzzy name similarity for live duplicate detection in the
 * Add-Customer flow (Story 4.4).
 *
 * Mirrors the API's `nameSimilarity` (packages/api/src/customers/dedup.ts),
 * which itself mirrors PostgreSQL `pg_trgm.similarity()`: lowercase, split
 * into alphanumeric words, pad each word with two leading and one trailing
 * space, emit consecutive 3-character windows, then take the Jaccard overlap
 * of the trigram sets. The server stays authoritative (it runs the real
 * pg_trgm `%` query on save); this is the pre-creation advisory so the
 * operator sees a "possible duplicate" before they create one.
 *
 * Names at/above {@link FUZZY_NAME_THRESHOLD} are treated as possible
 * duplicates — the same 0.4 floor the API uses.
 */
export const FUZZY_NAME_THRESHOLD = 0.4;

export function nameTrigrams(value: string): Set<string> {
  const set = new Set<string>();
  const words = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const word of words) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      set.add(padded.slice(i, i + 3));
    }
  }
  return set;
}

export function nameSimilarity(a: string, b: string): number {
  const ta = nameTrigrams(a);
  const tb = nameTrigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}
