/**
 * merge-corpus.ts — combines freshly-generated EN utterances with the frozen
 * `legacy-*`-id rows already committed in data/corpus/utterances.jsonl.
 *
 * Fixes the generator/build collision: generate-utterances.ts writes its
 * regenerable `utt_en_*` rows to a staging file
 * (data/corpus/utterances.generated.jsonl, gitignored) instead of
 * utterances.jsonl directly, because `writeJsonl` truncates its target on
 * every run — writing straight to utterances.jsonl would silently destroy
 * the T6-F01-migrated legacy rows on the next `corpus:build`. This script
 * reads that staging file plus the current committed utterances.jsonl,
 * keeps only the latter's `legacy-*` rows (the frozen, non-regenerable
 * portion), and writes (generated ∪ legacy) back to utterances.jsonl — the
 * file every validator/dedup/eval script actually reads.
 *
 * Idempotent: re-running without regenerating reads the already-merged
 * file's `legacy-*` rows back out and produces the same output (it only
 * ever reads legacy rows out of the CURRENT committed file, never out of
 * its own prior output beyond that).
 *
 * Run: pnpm corpus:merge   (after pnpm corpus:generate; corpus:build runs both)
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS_DIR, readJsonl, writeJsonl } from './lib';

const GENERATED_FILE = join(CORPUS_DIR, 'utterances.generated.jsonl');
const FINAL_FILE = join(CORPUS_DIR, 'utterances.jsonl');

function main(): void {
  if (!existsSync(GENERATED_FILE)) {
    console.error(
      `[merge] ${GENERATED_FILE} does not exist — run "pnpm corpus:generate" first. ` +
        'Refusing to treat a missing staging file as "zero generated rows" (that would silently ' +
        'wipe utterances.jsonl down to only the frozen legacy rows).',
    );
    process.exit(1);
  }

  const generated = readJsonl<Record<string, unknown>>(GENERATED_FILE);
  const current = existsSync(FINAL_FILE) ? readJsonl<Record<string, unknown>>(FINAL_FILE) : [];
  const legacy = current.filter((r) => typeof r.id === 'string' && (r.id as string).startsWith('legacy-'));

  const merged = [...generated, ...legacy];
  writeJsonl(FINAL_FILE, merged);
  console.error(
    `[merge] wrote ${merged.length} rows to ${FINAL_FILE} ` +
      `(${generated.length} generated + ${legacy.length} frozen legacy)`,
  );
}

main();
