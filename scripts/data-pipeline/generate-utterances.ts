#!/usr/bin/env npx tsx
/**
 * generate-utterances.ts — build data/corpus/utterances.jsonl.
 *
 * Pipeline:
 *   1. Emit the HAND-AUTHORED curated seed (source="curated",
 *      reviewed_by_human=true, confidence=1.0).
 *   2. Deterministically augment each intent up to PER_INTENT_TARGET using
 *      opener/closer variation, domain-synonym swaps, and slot-value swaps
 *      (source="template_augmented", reviewed_by_human=false).
 *   3. Dedup throughout: exact-normalized AND near-duplicate (offline cosine
 *      > 0.95 via local-embed). Nothing that collides is emitted.
 *
 * Honesty: augmented rows are clearly labeled and NOT marked human-reviewed.
 * The credential-gated LLM path (claude-sonnet-4-5 paraphrase) is described in
 * the comment block at the bottom and intentionally NOT invoked offline.
 *
 * Run: npx tsx scripts/data-pipeline/generate-utterances.ts
 */
import { writeFileSync } from 'node:fs';
import { CURATED, type Seed, type Slots } from './curated-seed';
import { CURATED_SUPPLEMENT } from './curated-seed-supplement';
import { CURATED_SUPPLEMENT2 } from './curated-seed-supplement2';
import { NearDupIndex } from './local-embed';
import {
  UTTERANCES_PATH, behaviorIds, normalizeUtterance, toJsonl, type UtteranceRow,
} from './corpus-lib';

const PER_INTENT_TARGET = 74; // 74 * 41 = 3034 total (>= 3000); keeps curated >= 20%

const OPENERS = ['', 'Hi, ', 'Hey, ', 'Hello, ', 'Yeah, ', 'Um, ', 'So, ', 'Okay, ', 'Listen, ', 'Real quick, ', 'Good morning, ', 'Hi there, '];
const CLOSERS = ['', ' please', ' thanks', ', thank you', ' when you can', ' if possible', ' today if you can', ' whenever works', ' I appreciate it', ' if that works'];

// Domain-synonym groups. A base utterance gets variants by swapping a matched
// member for the others. Conservative list to keep phrasings natural.
const SYN_GROUPS: string[][] = [
  ['AC', 'air conditioner', 'a/c', 'cooling'],
  ['tech', 'technician', 'guy', 'someone'],
  ['appointment', 'service call', 'visit'],
  ['fix', 'repair', 'look at'],
  ['invoice', 'bill'],
  ['estimate', 'quote', 'price'],
  ['water heater', 'hot water heater', 'hot water tank'],
  ['furnace', 'heater', 'heating system'],
  ['schedule', 'book', 'set up'],
  ['plumber', 'plumbing tech'],
  ['toilet', 'commode'],
  ['call back', 'follow up'],
];

// Slot value pools (used only to swap a value that appears verbatim in text).
const POOLS: Record<string, string[]> = {
  name: ['John Carter', 'Maria Lopez', 'Sandra Diaz', 'Tom Bradley', 'Helen Park', 'Robert Klein', 'Jennifer Wu', 'Gary Olsen', 'Angela Reed', 'Mrs. Patterson'],
  address: ['412 Elm Street', '88 Maple Ave', '1500 Sunset Blvd', '22 Oak Court', '9 Lakeview Drive', '5 River Road', '200 Market Street', '314 Birch Lane', '18 Cedar Court', '7 River Road'],
  time_window: ['tomorrow morning', 'this afternoon', 'next Monday', 'Saturday morning', 'Thursday 2-4 PM', 'next Tuesday', 'Wednesday afternoon', 'first thing tomorrow', 'today', 'this weekend'],
};

function normSeed(s: Seed): { text: string; slots: Slots } {
  return Array.isArray(s) ? { text: s[0], slots: s[1] } : { text: s, slots: {} };
}

function applyOpenerCloser(text: string, opener: string, closer: string): string {
  let body = text;
  if (opener) {
    // Lowercase the first character unless it's the standalone pronoun "I".
    if (!body.startsWith('I ') && !body.startsWith('I\'')) {
      body = body.charAt(0).toLowerCase() + body.slice(1);
    }
  }
  let out = opener + body;
  if (closer) {
    const m = out.match(/^(.*?)([.!?]+)$/);
    if (m) out = m[1] + closer + m[2];
    else out = out + closer;
  }
  return out;
}

function synonymVariants(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const group of SYN_GROUPS) {
    for (const member of group) {
      const re = new RegExp(`\\b${member.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\b`, 'i');
      if (re.test(lower)) {
        for (const alt of group) {
          if (alt === member) continue;
          out.push(text.replace(re, alt));
        }
        break; // one group per base keeps variants readable
      }
    }
    if (out.length) break;
  }
  return out;
}

function slotVariants(text: string, slots: Slots): { text: string; slots: Slots }[] {
  const out: { text: string; slots: Slots }[] = [];
  for (const key of ['name', 'address', 'time_window']) {
    const val = slots[key];
    if (!val || !text.includes(val)) continue;
    for (const alt of POOLS[key]) {
      if (alt === val) continue;
      out.push({ text: text.replace(val, alt), slots: { ...slots, [key]: alt } });
    }
  }
  return out;
}

function main(): void {
  const ids = behaviorIds();
  const merged: Record<string, Seed[]> = {};
  for (const src of [CURATED, CURATED_SUPPLEMENT, CURATED_SUPPLEMENT2]) {
    for (const [intent, list] of Object.entries(src)) {
      (merged[intent] ??= []).push(...list);
    }
  }
  for (const intent of Object.keys(merged)) {
    if (!ids.has(intent)) throw new Error(`Curated seed has unknown intent "${intent}" (not in behaviors.yaml)`);
  }
  for (const intent of ids) {
    if (!merged[intent]?.length) throw new Error(`No curated seed for intent "${intent}"`);
  }

  const rows: UtteranceRow[] = [];
  const seenNorm = new Set<string>();
  const nearDup = new NearDupIndex(0.95);

  const tryAdd = (utterance: string, intent: string, slots: Slots, source: UtteranceRow['source'], confidence: number, reviewed: boolean): boolean => {
    const text = utterance.trim();
    if (text.length < 2) return false;
    const norm = normalizeUtterance(text);
    if (seenNorm.has(norm)) return false;
    if (nearDup.isNearDup(text)) return false;
    seenNorm.add(norm);
    nearDup.add(text);
    rows.push({ utterance: text, intent, slots, source, confidence, reviewed_by_human: reviewed });
    return true;
  };

  // ── 1. curated ──
  const curatedCountByIntent: Record<string, number> = {};
  for (const intent of ids) {
    curatedCountByIntent[intent] = 0;
    for (const seed of merged[intent]) {
      const { text, slots } = normSeed(seed);
      if (tryAdd(text, intent, slots, 'curated', 1.0, true)) curatedCountByIntent[intent]++;
    }
  }

  // ── 2. augment ──
  for (const intent of ids) {
    let count = curatedCountByIntent[intent];
    const bases = merged[intent].map(normSeed);
    // Build a deterministic candidate stream per base, round-robin across bases.
    const baseVariants = bases.map(({ text, slots }) => {
      const variants: { text: string; slots: Slots }[] = [{ text, slots }];
      for (const sv of synonymVariants(text)) variants.push({ text: sv, slots });
      for (const sv of slotVariants(text, slots)) variants.push(sv);
      return variants;
    });

    // Iterate: for each (variant, opener, closer) combo across all bases.
    outer: for (let o = 0; o < OPENERS.length; o++) {
      for (let c = 0; c < CLOSERS.length; c++) {
        if (o === 0 && c === 0) continue; // identity == curated base, already added
        for (const variants of baseVariants) {
          for (const v of variants) {
            if (count >= PER_INTENT_TARGET) break outer;
            const text = applyOpenerCloser(v.text, OPENERS[o], CLOSERS[c]);
            if (tryAdd(text, intent, v.slots, 'template_augmented', 0.8, false)) count++;
          }
        }
      }
    }
    if (count < 50) {
      console.warn(`⚠️  intent "${intent}" only reached ${count} (< 50). Add more curated bases.`);
    }
  }

  writeFileSync(UTTERANCES_PATH, toJsonl(rows), 'utf8');

  const reviewed = rows.filter((r) => r.reviewed_by_human).length;
  const perIntent: Record<string, number> = {};
  for (const r of rows) perIntent[r.intent] = (perIntent[r.intent] ?? 0) + 1;
  const minIntent = Math.min(...Object.values(perIntent));

  console.log(`\n📝 Generated ${rows.length} utterances → ${UTTERANCES_PATH}`);
  console.log(`   curated (reviewed): ${reviewed} (${((reviewed / rows.length) * 100).toFixed(1)}%)`);
  console.log(`   template_augmented: ${rows.length - reviewed}`);
  console.log(`   min examples/intent: ${minIntent}`);
  console.log(`   intents: ${Object.keys(perIntent).length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

/*
 * CREDENTIAL-GATED LLM PATH (not run offline):
 *   When ANTHROPIC_API_KEY is present, a higher-variety augmentation step can
 *   call claude-sonnet-4-5 with the prompt:
 *     "Rewrite this trades-customer utterance as 5 distinct phrasings a real
 *      homeowner would actually say on the phone — not an AI summary. Keep the
 *      same intent and any names/addresses/times. Vary register (terse,
 *      rambling, regional)."
 *   Each output would be added with source="llm_paraphrase", reviewed_by_human
 *   defaulting to false; a human review queue (>=20% sampled) would flip the
 *   flag before rows enter the eval split. This path requires network + key and
 *   is therefore documented, not executed, in this sandbox.
 */
