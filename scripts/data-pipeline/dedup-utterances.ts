#!/usr/bin/env npx tsx
/**
 * dedup-utterances.ts — duplicate report / gate for utterances.jsonl.
 *
 *   --check  exit non-zero if ANY exact-normalized or near-duplicate
 *            (cosine > 0.95) pair exists. (default behavior)
 *   --list   print the offending pairs.
 *
 * Uses the offline local-embed vectorizer (no network). The near-dup threshold
 * matches the goal's "cosine sim > 0.95" rule.
 */
import { join } from 'node:path';
import { NearDupIndex, vectorize, cosine } from './local-embed';
import { CORPUS_DIR, normalizeText, readJsonl } from './lib';

const UTTERANCES_PATH = join(CORPUS_DIR, 'utterances.jsonl');

interface UtteranceRow {
  id: string;
  text: string;
}

function main(): void {
  const list = process.argv.includes('--list');
  const rows = readJsonl<UtteranceRow>(UTTERANCES_PATH);

  const seen = new Map<string, number>();
  const exact: [number, number][] = [];
  rows.forEach((r, i) => {
    const n = normalizeText(r.text);
    if (seen.has(n)) exact.push([seen.get(n)!, i]);
    else seen.set(n, i);
  });

  const idx = new NearDupIndex(0.95);
  const near: [number, number][] = [];
  const kept: { i: number; vec: ReturnType<typeof vectorize> }[] = [];
  rows.forEach((r, i) => {
    if (idx.isNearDup(r.text)) {
      // find the offending neighbor for the report
      const v = vectorize(r.text);
      let best = -1, bestSim = 0;
      for (const k of kept) { const s = cosine(v, k.vec); if (s > bestSim) { bestSim = s; best = k.i; } }
      near.push([best, i]);
    } else {
      idx.add(r.text);
      kept.push({ i, vec: vectorize(r.text) });
    }
  });

  console.log('\n🔁 Dedup report');
  console.log(`   rows:              ${rows.length}`);
  console.log(`   exact duplicates:  ${exact.length}`);
  console.log(`   near duplicates:   ${near.length} (cosine > 0.95)`);

  if (list) {
    for (const [a, b] of exact.slice(0, 30)) console.log(`   EXACT  ${a} == ${b}: "${rows[b].text}"`);
    for (const [a, b] of near.slice(0, 30)) console.log(`   NEAR   ${a} ~ ${b}: "${rows[a]?.text}" ≈ "${rows[b].text}"`);
  }

  if (exact.length + near.length > 0) {
    console.error(`\n❌ FAIL: ${exact.length} exact + ${near.length} near duplicate(s).`);
    process.exit(1);
  }
  console.log('\n✅ PASS: no duplicates.\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
