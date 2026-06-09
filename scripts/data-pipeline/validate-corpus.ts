/**
 * validate-corpus.ts — schema + structural validation for every corpus file.
 * Backs `pnpm test:corpus-schema`. Exits non-zero on the first violation.
 *
 * Validates: row schemas, enum membership, intent<->behaviors.yaml alignment,
 * and the launch floors (edge >=150 / cat >=10, negatives >=50 / cat >=10,
 * Spanish >=1200 & >=30/intent & code-switch >=50, reviewed >=20%).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS_DIR, SEEDS_DIR, readJsonl, listJsonl } from './lib';

const HANDLINGS = new Set(['route_to_human', 'clarify', 'ignore', 'emergency_dispatch']);
const ROUTINGS = new Set(['ignore', 'route_to_human', 'route_to_careers']);
const LANGS = new Set(['en', 'es']);
const SLOT_TYPES = new Set(['address', 'time', 'phone', 'service']);

const errors: string[] = [];
const fail = (msg: string): void => {
  errors.push(msg);
};

function behaviorIds(): Set<string> {
  const yaml = readFileSync(join(CORPUS_DIR, 'behaviors.yaml'), 'utf8');
  const ids = new Set<string>();
  for (const m of yaml.matchAll(/^\s*-\s+id:\s*([a-z_]+)\s*$/gm)) ids.add(m[1]);
  return ids;
}

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function validateUtterances(file: string, lang: 'en' | 'es', ids: Set<string>): void {
  const rows = readJsonl<Record<string, unknown>>(join(CORPUS_DIR, file));
  const perIntent = new Map<string, number>();
  let reviewed = 0;
  let codeSwitch = 0;
  for (const r of rows) {
    if (!isStr(r.id) || !isStr(r.text) || !isStr(r.intent)) fail(`${file}: missing id/text/intent (${r.id})`);
    if (!ids.has(r.intent as string)) fail(`${file}: unknown intent "${r.intent}" (${r.id})`);
    if (r.lang !== lang) fail(`${file}: lang must be ${lang} (${r.id})`);
    if (typeof r.code_switch !== 'boolean') fail(`${file}: code_switch must be boolean (${r.id})`);
    if (typeof r.reviewed_by_human !== 'boolean') fail(`${file}: reviewed_by_human must be boolean (${r.id})`);
    perIntent.set(r.intent as string, (perIntent.get(r.intent as string) ?? 0) + 1);
    if (r.reviewed_by_human) reviewed++;
    if (r.code_switch) codeSwitch++;
  }
  const reviewedPct = (100 * reviewed) / rows.length;
  if (reviewedPct < 20) fail(`${file}: reviewed_by_human ${reviewedPct.toFixed(1)}% < 20%`);
  console.error(`[schema] ${file}: ${rows.length} rows, ${perIntent.size} intents, reviewed ${reviewedPct.toFixed(1)}%`);
  if (lang === 'es') {
    if (rows.length < 1200) fail(`${file}: ${rows.length} ES utterances < 1200`);
    if (codeSwitch < 50) fail(`${file}: code-switch ${codeSwitch} < 50`);
    for (const [intent, n] of perIntent) if (n < 30) fail(`${file}: intent "${intent}" has ${n} ES utterances < 30`);
  }
}

function validateEdges(ids: Set<string>): void {
  const rows = readJsonl<Record<string, unknown>>(join(CORPUS_DIR, 'edge_cases.jsonl'));
  const cats = new Map<string, number>();
  for (const r of rows) {
    if (!isStr(r.id) || !isStr(r.text) || !isStr(r.category)) fail(`edge_cases: missing fields (${r.id})`);
    if (!HANDLINGS.has(r.expected_handling as string)) fail(`edge_cases: bad expected_handling (${r.id})`);
    if (!LANGS.has(r.lang as string)) fail(`edge_cases: bad lang (${r.id})`);
    // An edge-case intent may be a behavior id OR a routing action (the
    // underlying intent is sometimes unrecoverable, e.g. "clarify").
    if (r.intent !== undefined && !ids.has(r.intent as string) && !HANDLINGS.has(r.intent as string)) {
      fail(`edge_cases: unknown intent "${r.intent}" (${r.id})`);
    }
    cats.set(r.category as string, (cats.get(r.category as string) ?? 0) + 1);
  }
  if (rows.length < 150) fail(`edge_cases: ${rows.length} < 150`);
  for (const [c, n] of cats) if (n < 10) fail(`edge_cases: category "${c}" has ${n} < 10`);
  console.error(`[schema] edge_cases.jsonl: ${rows.length} rows, ${cats.size} categories`);
}

function validateNegatives(): void {
  const rows = readJsonl<Record<string, unknown>>(join(CORPUS_DIR, 'negatives.jsonl'));
  const cats = new Map<string, number>();
  for (const r of rows) {
    if (!isStr(r.id) || !isStr(r.text) || !isStr(r.category)) fail(`negatives: missing fields (${r.id})`);
    if (r.not_intent !== true) fail(`negatives: not_intent must be true (${r.id})`);
    if (!ROUTINGS.has(r.expected_routing as string)) fail(`negatives: bad expected_routing (${r.id})`);
    cats.set(r.category as string, (cats.get(r.category as string) ?? 0) + 1);
  }
  if (rows.length < 50) fail(`negatives: ${rows.length} < 50`);
  for (const [c, n] of cats) if (n < 10) fail(`negatives: category "${c}" has ${n} < 10`);
  console.error(`[schema] negatives.jsonl: ${rows.length} rows, ${cats.size} categories`);
}

function validateSlots(): void {
  for (const path of listJsonl(join(CORPUS_DIR, 'slot_fixtures'))) {
    const rows = readJsonl<Record<string, unknown>>(path);
    for (const r of rows) {
      if (!isStr(r.id) || !isStr(r.text)) fail(`${path}: missing id/text (${r.id})`);
      if (!SLOT_TYPES.has(r.slot_type as string)) fail(`${path}: bad slot_type (${r.id})`);
      const exp = r.expected as Record<string, unknown> | undefined;
      if (!exp || !isStr(exp.kind) || typeof exp.value !== 'string') fail(`${path}: bad expected (${r.id})`);
    }
    if (rows.length < 25) fail(`${path}: ${rows.length} < 25`);
    console.error(`[schema] ${path.split('/').slice(-2).join('/')}: ${rows.length} rows`);
  }
}

function ensureSeedsCoverBehaviors(ids: Set<string>): void {
  const en = JSON.parse(readFileSync(join(SEEDS_DIR, 'templates.en.json'), 'utf8')).templates;
  const es = JSON.parse(readFileSync(join(SEEDS_DIR, 'templates.es.json'), 'utf8')).templates;
  for (const id of ids) {
    if (!(id in en)) fail(`templates.en.json missing intent "${id}"`);
    if (!(id in es)) fail(`templates.es.json missing intent "${id}"`);
  }
}

function main(): void {
  const ids = behaviorIds();
  if (ids.size < 30) fail(`behaviors.yaml: only ${ids.size} behaviors parsed`);
  console.error(`[schema] behaviors.yaml: ${ids.size} behaviors`);
  ensureSeedsCoverBehaviors(ids);
  validateUtterances('utterances.jsonl', 'en', ids);
  validateUtterances('utterances_es.jsonl', 'es', ids);
  validateEdges(ids);
  validateNegatives();
  validateSlots();

  if (errors.length) {
    console.error(`\n[schema] FAILED with ${errors.length} error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.error('\n[schema] OK — all corpus files validate');
}

main();
