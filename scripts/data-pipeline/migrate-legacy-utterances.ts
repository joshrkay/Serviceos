/**
 * migrate-legacy-utterances.ts — one-off, idempotent migration of legacy-schema
 * rows in data/corpus/utterances.jsonl onto the canonical schema.
 *
 * Two row shapes exist in the committed file today:
 *   - canonical:  {id, text, intent, lang, code_switch, source, reviewed_by_human}
 *   - legacy:     {utterance, intent, slots, source, confidence, reviewed_by_human}
 *
 * Canonical schema (what every row looks like after this script runs):
 *   {id, text, intent, lang, code_switch, source, reviewed_by_human, slots?, confidence?}
 *
 * Legacy rows get a stable id: `legacy-<sha1(utterance).slice(0,10)>` — the
 * same utterance always produces the same id, so re-running this script
 * against an already-migrated file is a no-op (every row is already
 * canonical-shaped and passes through unchanged). Matches the "deterministic
 * forever" convention used by mulberry32/fnv1a in lib.ts.
 *
 * Run: npx tsx scripts/data-pipeline/migrate-legacy-utterances.ts
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CORPUS_DIR, readJsonl, writeJsonl } from './lib';

const FILE = join(CORPUS_DIR, 'utterances.jsonl');

interface CanonicalRow {
  id: string;
  text: string;
  intent: string;
  lang: string;
  code_switch: boolean;
  source: unknown;
  reviewed_by_human: unknown;
  slots?: unknown;
  confidence?: unknown;
}

/** Deterministic forever: same utterance text -> same legacy id, always. */
function legacyId(utterance: string): string {
  return `legacy-${createHash('sha1').update(utterance).digest('hex').slice(0, 10)}`;
}

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function migrateRow(r: Record<string, unknown>, i: number): CanonicalRow {
  if ('id' in r) {
    // Already id-bearing — this must already be fully canonical-shaped.
    // Fail loudly naming the offending row rather than silently emitting
    // or dropping an invalid row (this shape shouldn't exist today, but if
    // it ever does, a clear error beats corrupting the corpus).
    if (!isStr(r.id) || !isStr(r.text) || !isStr(r.lang) || typeof r.code_switch !== 'boolean') {
      console.error(
        `[migrate] row ${i} has an "id" (${JSON.stringify(r.id)}) but is missing/invalid ` +
          `text/lang/code_switch — refusing to guess. Row: ${JSON.stringify(r)}`,
      );
      process.exit(1);
    }
    return r as unknown as CanonicalRow;
  }

  if (!isStr(r.utterance)) {
    console.error(
      `[migrate] row ${i} has neither "id" nor "utterance" — cannot classify its shape. Row: ${JSON.stringify(r)}`,
    );
    process.exit(1);
  }

  const utterance = r.utterance as string;
  const out: CanonicalRow = {
    id: legacyId(utterance),
    text: utterance,
    intent: r.intent as string,
    lang: 'en',
    code_switch: false,
    source: r.source,
    reviewed_by_human: r.reviewed_by_human,
  };
  if (r.slots !== undefined) out.slots = r.slots;
  if (r.confidence !== undefined) out.confidence = r.confidence;
  return out;
}

function main(): void {
  const rows = readJsonl<Record<string, unknown>>(FILE);
  const migrated = rows.map((r, i) => migrateRow(r, i));

  // Sanity: flag (don't mask) any id collision post-migration. A genuine
  // collision means two rows had byte-identical utterance text — that's an
  // exact duplicate corpus:dedup / test:dedup should report, not something
  // this script should silently merge away.
  const seen = new Set<string>();
  let dupes = 0;
  for (const r of migrated) {
    if (seen.has(r.id)) dupes++;
    seen.add(r.id);
  }
  if (dupes > 0) {
    console.error(`[migrate] WARN: ${dupes} duplicate id(s) after migration — expect corpus:dedup to flag these`);
  }

  writeJsonl(FILE, migrated);
  console.error(`[migrate] wrote ${migrated.length} rows (${rows.length} in, canonical schema out) to ${FILE}`);
}

main();
