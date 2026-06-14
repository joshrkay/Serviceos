/**
 * dedup.ts — backs `pnpm test:dedup`.
 * FAILS on exact (normalized) duplicates within a corpus file; WARNS on
 * near-duplicates (token-Jaccard >= 0.92) so reviewers can prune them.
 */
import { join } from 'node:path';
import { CORPUS_DIR, readJsonl, listJsonl, normalizeText } from './lib';

interface TextRow {
  id: string;
  text: string;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function checkFile(path: string): { exact: number; near: number } {
  const rows = readJsonl<TextRow>(path);
  const seen = new Map<string, string>();
  let exact = 0;
  let near = 0;
  const tokenSets: Array<{ id: string; set: Set<string> }> = [];
  for (const r of rows) {
    const norm = normalizeText(r.text);
    if (seen.has(norm)) {
      exact++;
      console.error(`[dedup] EXACT dup in ${short(path)}: ${r.id} == ${seen.get(norm)}`);
    } else {
      seen.set(norm, r.id);
    }
    tokenSets.push({ id: r.id, set: new Set(norm.split(' ')) });
  }
  // Near-dup scan is O(n^2); cap per file to keep CI fast.
  const cap = Math.min(tokenSets.length, 1500);
  for (let i = 0; i < cap; i++) {
    for (let j = i + 1; j < cap; j++) {
      if (Math.abs(tokenSets[i].set.size - tokenSets[j].set.size) > 3) continue;
      if (jaccard(tokenSets[i].set, tokenSets[j].set) >= 0.92) near++;
    }
  }
  return { exact, near };
}

function short(p: string): string {
  return p.split('/').slice(-2).join('/');
}

function main(): void {
  const files = [
    join(CORPUS_DIR, 'utterances.jsonl'),
    join(CORPUS_DIR, 'utterances_es.jsonl'),
    join(CORPUS_DIR, 'edge_cases.jsonl'),
    join(CORPUS_DIR, 'negatives.jsonl'),
    ...listJsonl(join(CORPUS_DIR, 'slot_fixtures')),
  ];
  let totalExact = 0;
  let totalNear = 0;
  for (const f of files) {
    const { exact, near } = checkFile(f);
    totalExact += exact;
    totalNear += near;
    console.error(`[dedup] ${short(f)}: exact=${exact} near=${near}`);
  }
  if (totalNear > 0) console.error(`[dedup] WARN: ${totalNear} near-duplicate pair(s) flagged for review`);
  if (totalExact > 0) {
    console.error(`[dedup] FAILED: ${totalExact} exact duplicate(s)`);
    process.exit(1);
  }
  console.error('[dedup] OK — no exact duplicates');
}

main();
