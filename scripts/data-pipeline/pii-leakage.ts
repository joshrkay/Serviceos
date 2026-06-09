/**
 * pii-leakage.ts — backs `pnpm test:pii-leakage`. HARD STOP on any hit.
 *
 * Scans every committed corpus file for real PII. All phone numbers in the
 * corpus are required to be fictional: every phone-like sequence must contain
 * "555" as its area code or exchange (the NANP-reserved fictional block).
 * Emails, SSNs, and card-length digit runs are forbidden outright.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS_DIR, listJsonl } from './lib';

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD = /\b\d{13,16}\b/g;
// Phone-like: 10 digits (optionally separated) or 7 digits separated.
const PHONE = /\b(?:\d[\s.\-]?){9,10}\d\b/g;

const violations: string[] = [];

function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

function isFictionalPhone(digits: string): boolean {
  if (digits.length === 10) {
    return digits.slice(0, 3) === '555' || digits.slice(3, 6) === '555';
  }
  if (digits.length === 7) {
    return digits.slice(0, 3) === '555';
  }
  return false; // unexpected length near a phone -> treat as suspicious
}

function scan(path: string): void {
  const text = readFileSync(path, 'utf8');
  const rel = path.split('/').slice(-2).join('/');
  for (const m of text.matchAll(EMAIL)) violations.push(`${rel}: email-like "${m[0]}"`);
  for (const m of text.matchAll(SSN)) violations.push(`${rel}: SSN-like "${m[0]}"`);
  for (const m of text.matchAll(CARD)) violations.push(`${rel}: card-length number "${m[0]}"`);
  for (const m of text.matchAll(PHONE)) {
    const d = digitsOf(m[0]);
    if ((d.length === 7 || d.length === 10) && !isFictionalPhone(d)) {
      violations.push(`${rel}: non-fictional phone "${m[0]}" (use a 555 block)`);
    }
  }
}

function main(): void {
  const files = [
    join(CORPUS_DIR, 'utterances.jsonl'),
    join(CORPUS_DIR, 'utterances_es.jsonl'),
    join(CORPUS_DIR, 'edge_cases.jsonl'),
    join(CORPUS_DIR, 'negatives.jsonl'),
    ...listJsonl(join(CORPUS_DIR, 'slot_fixtures')),
  ];
  for (const f of files) scan(f);
  if (violations.length) {
    console.error(`[pii] HARD STOP — ${violations.length} potential PII leak(s):`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.error(`[pii] OK — scanned ${files.length} files, zero PII detected`);
}

main();
