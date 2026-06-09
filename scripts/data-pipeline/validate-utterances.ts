#!/usr/bin/env npx tsx
/**
 * validate-utterances.ts — gate for data/corpus/utterances.jsonl.
 *
 * Enforces every corpus invariant from the goal:
 *   - schema valid on every row (zod)
 *   - intent ∈ behaviors.yaml
 *   - total count >= 3000
 *   - every behavior has >= 50 examples
 *   - reviewed_by_human share >= 20% of the corpus
 *   - no exact (normalized) duplicates
 *
 * Near-duplicate (cosine > 0.95) checking lives in dedup-utterances.ts and is
 * also invoked here unless --skip-neardup is passed.
 *
 * Run: npx tsx scripts/data-pipeline/validate-utterances.ts
 */
import { z } from 'zod';
import { NearDupIndex } from './local-embed';
import {
  UTTERANCES_PATH, behaviorIds, normalizeUtterance, readJsonl,
} from './corpus-lib';

const MIN_TOTAL = 3000;
const MIN_PER_BEHAVIOR = 50;
const MIN_REVIEWED_SHARE = 0.20;

const RowSchema = z.object({
  utterance: z.string().min(2),
  intent: z.string().min(1),
  slots: z.record(z.string(), z.string()),
  source: z.enum(['curated', 'template_augmented', 'llm_paraphrase']),
  confidence: z.number().min(0).max(1),
  reviewed_by_human: z.boolean(),
});

function main(): void {
  const skipNearDup = process.argv.includes('--skip-neardup');
  const ids = behaviorIds();
  const errors: string[] = [];

  // Read raw lines so we can report bad rows precisely.
  const rows = readJsonl(UTTERANCES_PATH);
  if (rows.length === 0) {
    console.error('❌ utterances.jsonl is empty or missing. Run generate-utterances.ts first.');
    process.exit(1);
  }

  const perBehavior: Record<string, number> = {};
  let reviewed = 0;
  const seenNorm = new Map<string, number>();
  let exactDupes = 0;

  rows.forEach((row, i) => {
    const parsed = RowSchema.safeParse(row);
    if (!parsed.success) {
      errors.push(`row ${i}: schema — ${parsed.error.issues.map((x) => x.path.join('.') + ' ' + x.message).join('; ')}`);
      return;
    }
    if (!ids.has(row.intent)) errors.push(`row ${i}: unknown intent "${row.intent}"`);
    perBehavior[row.intent] = (perBehavior[row.intent] ?? 0) + 1;
    if (row.reviewed_by_human) reviewed++;
    const norm = normalizeUtterance(row.utterance);
    if (seenNorm.has(norm)) { exactDupes++; if (exactDupes <= 10) errors.push(`row ${i}: exact/normalized duplicate of row ${seenNorm.get(norm)} ("${row.utterance}")`); }
    else seenNorm.set(norm, i);
  });

  // Count gate
  if (rows.length < MIN_TOTAL) errors.push(`total ${rows.length} < required ${MIN_TOTAL}`);

  // Per-behavior gate
  for (const id of ids) {
    const n = perBehavior[id] ?? 0;
    if (n < MIN_PER_BEHAVIOR) errors.push(`behavior "${id}" has ${n} examples (< ${MIN_PER_BEHAVIOR})`);
  }

  // Reviewed share gate
  const reviewedShare = reviewed / rows.length;
  if (reviewedShare < MIN_REVIEWED_SHARE) {
    errors.push(`reviewed share ${(reviewedShare * 100).toFixed(1)}% < required ${(MIN_REVIEWED_SHARE * 100).toFixed(0)}%`);
  }

  // Near-dup gate
  let nearDupes = 0;
  if (!skipNearDup) {
    const idx = new NearDupIndex(0.95);
    rows.forEach((row, i) => {
      if (idx.isNearDup(row.utterance)) { nearDupes++; if (nearDupes <= 10) errors.push(`row ${i}: near-duplicate (cosine > 0.95) — "${row.utterance}"`); }
      else idx.add(row.utterance);
    });
  }

  console.log('\n🧪 Utterance corpus validation');
  console.log(`   total rows:          ${rows.length} (min ${MIN_TOTAL})`);
  console.log(`   intents covered:     ${Object.keys(perBehavior).length} / ${ids.size}`);
  console.log(`   min examples/intent: ${Math.min(...[...ids].map((id) => perBehavior[id] ?? 0))} (min ${MIN_PER_BEHAVIOR})`);
  console.log(`   reviewed share:      ${(reviewedShare * 100).toFixed(1)}% (min ${(MIN_REVIEWED_SHARE * 100).toFixed(0)}%)`);
  console.log(`   exact duplicates:    ${exactDupes}`);
  console.log(`   near duplicates:     ${skipNearDup ? 'skipped' : nearDupes}`);

  if (errors.length) {
    console.error(`\n❌ FAIL (${errors.length} issue(s)):`);
    for (const e of errors.slice(0, 40)) console.error(`   - ${e}`);
    process.exit(1);
  }
  console.log('\n✅ PASS: all utterance-corpus invariants hold.\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
