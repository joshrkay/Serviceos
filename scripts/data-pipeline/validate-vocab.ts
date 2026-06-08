#!/usr/bin/env npx tsx
/**
 * validate-vocab.ts — schema + count gate for data/vocab/*.yaml.
 *
 * Checks:
 *   1. Every vocab file parses and conforms to data/vocab/schema.json
 *      (validated structurally here; no ajv dependency required).
 *   2. Total UNIQUE surface forms (canonical term + every synonym, normalized
 *      and deduped across all files) is >= MIN_UNIQUE_TERMS.
 *   3. No duplicate canonical terms within a single file.
 *
 * Exit code 0 = pass, 1 = fail. Run: npx tsx scripts/data-pipeline/validate-vocab.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const VOCAB_DIR = resolve(__dirname, '../../data/vocab');

const MIN_UNIQUE_TERMS = 1500;

const VALID_CATEGORIES = new Set([
  'component', 'system', 'symptom', 'service', 'brand',
  'material', 'consumable', 'condition', 'spec', 'dialect',
]);
const VALID_REGIONS = new Set(['Phoenix', 'Texas', 'Northeast', 'Florida', 'Pacific NW']);
const VALID_DOMAINS = new Set(['hvac', 'plumbing', 'electrical', 'regional']);

export interface VocabTerm {
  term: string;
  synonyms: string[];
  category: string;
  regions: string[];
}
export interface VocabFile {
  domain: string;
  terms: VocabTerm[];
}

/** Normalize a surface form for uniqueness counting. */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Load and structurally validate every vocab file. Throws on schema violation. */
export function loadVocab(): { files: Record<string, VocabFile>; errors: string[] } {
  const errors: string[] = [];
  const files: Record<string, VocabFile> = {};
  const yamlNames = readdirSync(VOCAB_DIR).filter((f) => f.endsWith('.yaml'));

  for (const name of yamlNames) {
    const raw = parse(readFileSync(join(VOCAB_DIR, name), 'utf8')) as VocabFile;
    if (!raw || typeof raw !== 'object') {
      errors.push(`${name}: not an object`);
      continue;
    }
    if (!VALID_DOMAINS.has(raw.domain)) errors.push(`${name}: invalid domain "${raw.domain}"`);
    if (!Array.isArray(raw.terms)) {
      errors.push(`${name}: "terms" is not an array`);
      continue;
    }
    const seenTerms = new Set<string>();
    raw.terms.forEach((t, i) => {
      const where = `${name}[${i}]`;
      if (!t || typeof t.term !== 'string' || t.term.length === 0) {
        errors.push(`${where}: missing/empty "term"`);
        return;
      }
      const key = normalize(t.term);
      if (seenTerms.has(key)) errors.push(`${where}: duplicate term "${t.term}" within file`);
      seenTerms.add(key);
      if (!Array.isArray(t.synonyms)) errors.push(`${where} (${t.term}): "synonyms" must be an array`);
      else t.synonyms.forEach((s) => { if (typeof s !== 'string' || !s) errors.push(`${where} (${t.term}): empty synonym`); });
      if (!VALID_CATEGORIES.has(t.category)) errors.push(`${where} (${t.term}): invalid category "${t.category}"`);
      if (!Array.isArray(t.regions)) errors.push(`${where} (${t.term}): "regions" must be an array`);
      else t.regions.forEach((r) => { if (!VALID_REGIONS.has(r)) errors.push(`${where} (${t.term}): invalid region "${r}"`); });
    });
    files[raw.domain ?? name] = raw;
  }
  return { files, errors };
}

/** Every unique normalized surface form across all files (terms + synonyms). */
export function uniqueSurfaceForms(files: Record<string, VocabFile>): Set<string> {
  const set = new Set<string>();
  for (const f of Object.values(files)) {
    for (const t of f.terms) {
      set.add(normalize(t.term));
      for (const s of t.synonyms) set.add(normalize(s));
    }
  }
  set.delete('');
  return set;
}

function main(): void {
  const { files, errors } = loadVocab();
  if (errors.length) {
    console.error(`\n❌ Vocab schema validation failed (${errors.length} error(s)):`);
    for (const e of errors.slice(0, 50)) console.error(`   - ${e}`);
    process.exit(1);
  }

  const perFile: Record<string, number> = {};
  const categoryCounts: Record<string, number> = {};
  for (const [domain, f] of Object.entries(files)) {
    perFile[domain] = f.terms.length;
    for (const t of f.terms) categoryCounts[t.category] = (categoryCounts[t.category] ?? 0) + 1;
  }
  const unique = uniqueSurfaceForms(files);

  console.log('\n📚 Vocabulary validation');
  console.log('   Files (canonical terms):');
  for (const [d, n] of Object.entries(perFile)) console.log(`     - ${d}: ${n} terms`);
  console.log('   Category breakdown:');
  for (const [c, n] of Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`     - ${c}: ${n}`);
  }
  console.log(`   Unique surface forms (terms + synonyms): ${unique.size}`);
  console.log(`   Required minimum: ${MIN_UNIQUE_TERMS}`);

  if (unique.size < MIN_UNIQUE_TERMS) {
    console.error(`\n❌ FAIL: only ${unique.size} unique terms (< ${MIN_UNIQUE_TERMS}).`);
    process.exit(1);
  }
  console.log(`\n✅ PASS: ${unique.size} unique terms (>= ${MIN_UNIQUE_TERMS}).\n`);
}

// Run only when invoked directly (not when imported by other scripts).
if (import.meta.url === `file://${process.argv[1]}`) main();
