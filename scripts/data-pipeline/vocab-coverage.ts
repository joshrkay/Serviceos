#!/usr/bin/env npx tsx
/**
 * vocab-coverage.ts — the goal's coverage gate:
 *   "≥ 95% of domain nouns mentioned in transcripts appear in vocab files".
 *
 * Method (honest & non-circular):
 *   - DOMAIN_GAZETTEER is an INDEPENDENT list of trade domain nouns (it is NOT
 *     derived from the vocab files). It defines "what counts as a domain noun".
 *   - We scan every transcript in data/fixtures/transcripts/ for gazetteer nouns
 *     that actually appear → the set of domain nouns MENTIONED in transcripts.
 *   - A mentioned noun is COVERED if the vocab knows it: exact match, or it
 *     appears as a whole word inside some vocab surface form, or vice-versa.
 *   - coverage = covered / mentioned must be ≥ 0.95. Gaps are reported so vocab
 *     can be extended.
 *
 * Run: npx tsx scripts/data-pipeline/vocab-coverage.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVocab, uniqueSurfaceForms, normalize } from './validate-vocab';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRANSCRIPT_DIR = resolve(__dirname, '../../data/fixtures/transcripts');
const MIN_COVERAGE = 0.95;

// Independent domain-noun gazetteer (NOT sourced from data/vocab/*).
const DOMAIN_GAZETTEER = [
  // HVAC
  'ac unit', 'air conditioner', 'furnace', 'heat pump', 'air handler', 'condenser',
  'evaporator coil', 'compressor', 'blower motor', 'capacitor', 'contactor', 'thermostat',
  'mini split', 'package unit', 'refrigerant', 'freon', 'ductwork', 'duct', 'vent', 'air filter',
  'drain pan', 'condensate drain line', 'heat exchanger', 'igniter', 'flame sensor', 'pilot light',
  // Plumbing
  'water heater', 'tankless water heater', 'toilet', 'faucet', 'garbage disposal', 'sump pump',
  'sewer main', 'main sewer line', 'shutoff valve', 'shower valve', 'p-trap', 'wax ring',
  'fill valve', 'flapper', 'supply line', 'pressure regulator', 'expansion tank', 'water main',
  // Electrical
  'electrical panel', 'breaker', 'circuit breaker', 'gfci outlet', 'gfci', 'outlet', 'light fixture',
  'ceiling fan', 'sub-panel', 'fuse', 'wiring', 'surge protector', 'transfer switch', 'generator',
  // generic
  'unit', 'system', 'valve', 'pipe', 'panel', 'filter', 'leak',
];

function wordContains(haystack: string, needle: string): boolean {
  if (haystack === needle) return true;
  const re = new RegExp(`(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`);
  return re.test(haystack);
}

function main(): void {
  const { files, errors } = loadVocab();
  if (errors.length) { console.error('❌ vocab schema errors; fix with validate-vocab.ts first'); process.exit(1); }
  const surfaces = [...uniqueSurfaceForms(files)];
  const surfaceSet = new Set(surfaces);

  const covered = (noun: string): boolean => {
    if (surfaceSet.has(noun)) return true;
    for (const v of surfaces) {
      if (wordContains(v, noun) || wordContains(noun, v)) return true;
    }
    return false;
  };

  // Gather transcript text
  const texts: string[] = [];
  for (const f of readdirSync(TRANSCRIPT_DIR).filter((x) => x.endsWith('.json'))) {
    const t = JSON.parse(readFileSync(join(TRANSCRIPT_DIR, f), 'utf8')) as { transcript?: string; expected_entities?: Record<string, string> };
    const ent = t.expected_entities ? Object.values(t.expected_entities).join(' ') : '';
    texts.push(normalize(`${t.transcript ?? ''} ${ent}`));
  }
  const blob = texts.join('  ');

  const mentioned = DOMAIN_GAZETTEER.map(normalize).filter((g) => wordContains(blob, g));
  const uncovered = mentioned.filter((m) => !covered(m));
  const coverage = mentioned.length ? (mentioned.length - uncovered.length) / mentioned.length : 1;

  console.log('\n📐 Vocabulary ↔ transcript coverage');
  console.log(`   transcripts scanned:     ${texts.length}`);
  console.log(`   gazetteer nouns:         ${DOMAIN_GAZETTEER.length}`);
  console.log(`   domain nouns mentioned:  ${mentioned.length}`);
  console.log(`   covered by vocab:        ${mentioned.length - uncovered.length}`);
  console.log(`   coverage:                ${(coverage * 100).toFixed(1)}% (min ${(MIN_COVERAGE * 100).toFixed(0)}%)`);
  if (uncovered.length) console.log(`   uncovered nouns:         ${uncovered.join(', ')}`);

  if (coverage < MIN_COVERAGE) {
    console.error(`\n❌ FAIL: coverage ${(coverage * 100).toFixed(1)}% < ${(MIN_COVERAGE * 100).toFixed(0)}%. Add the uncovered nouns to data/vocab/*.`);
    process.exit(1);
  }
  console.log('\n✅ PASS: vocab covers the domain nouns in transcripts.\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
