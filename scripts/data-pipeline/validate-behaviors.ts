#!/usr/bin/env npx tsx
/**
 * validate-behaviors.ts — keep data/behaviors.yaml in sync with the production
 * intent model. Extracts SUPPORTED_INTENTS from
 * packages/api/src/ai/orchestration/intent-classifier.ts and asserts the
 * behaviors file covers exactly that set (no missing, no extra).
 *
 * Run: npx tsx scripts/data-pipeline/validate-behaviors.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const CLASSIFIER = resolve(ROOT, 'packages/api/src/ai/orchestration/intent-classifier.ts');
const BEHAVIORS = resolve(ROOT, 'data/behaviors.yaml');

const VALID_CATEGORIES = new Set(['proposal-driving', 'lookup', 'conversational', 'signal']);

/** Parse the SUPPORTED_INTENTS array from the classifier source. */
export function extractSupportedIntents(src: string): string[] {
  const m = src.match(/const SUPPORTED_INTENTS[^=]*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!m) throw new Error('Could not locate SUPPORTED_INTENTS in intent-classifier.ts');
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

interface Behavior { id: string; category: string; description?: string; critical_slots?: string[]; min_examples?: number; }

function main(): void {
  const intents = new Set(extractSupportedIntents(readFileSync(CLASSIFIER, 'utf8')));
  const doc = parse(readFileSync(BEHAVIORS, 'utf8')) as { behaviors: Behavior[] };
  const behaviorIds = doc.behaviors.map((b) => b.id);
  const behaviorSet = new Set(behaviorIds);

  const errors: string[] = [];

  // Duplicate ids
  if (behaviorIds.length !== behaviorSet.size) errors.push('Duplicate behavior id(s) in behaviors.yaml');

  // Missing (in code, not in behaviors)
  for (const i of intents) if (!behaviorSet.has(i)) errors.push(`Missing behavior for intent "${i}"`);
  // Extra (in behaviors, not in code)
  for (const b of behaviorSet) if (!intents.has(b)) errors.push(`Behavior "${b}" is not a SUPPORTED_INTENT`);

  // Per-behavior field checks
  for (const b of doc.behaviors) {
    if (!VALID_CATEGORIES.has(b.category)) errors.push(`Behavior "${b.id}": invalid category "${b.category}"`);
    if (!b.description) errors.push(`Behavior "${b.id}": missing description`);
    if (!Array.isArray(b.critical_slots)) errors.push(`Behavior "${b.id}": critical_slots must be an array`);
    if (typeof b.min_examples !== 'number' || b.min_examples < 1) errors.push(`Behavior "${b.id}": min_examples must be a positive number`);
  }

  console.log(`\n🧭 Behavior taxonomy validation`);
  console.log(`   SUPPORTED_INTENTS (code): ${intents.size}`);
  console.log(`   behaviors.yaml entries:   ${behaviorIds.length}`);
  const byCat: Record<string, number> = {};
  for (const b of doc.behaviors) byCat[b.category] = (byCat[b.category] ?? 0) + 1;
  for (const [c, n] of Object.entries(byCat)) console.log(`     - ${c}: ${n}`);

  if (errors.length) {
    console.error(`\n❌ FAIL (${errors.length}):`);
    for (const e of errors) console.error(`   - ${e}`);
    process.exit(1);
  }
  console.log(`\n✅ PASS: behaviors.yaml matches the production intent set exactly.\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
