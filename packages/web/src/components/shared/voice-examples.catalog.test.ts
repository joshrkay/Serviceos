/**
 * U7 — voice examples ↔ voice-action catalog pin.
 *
 * Every example the VoiceBar rotates must exercise a SPEAKABLE intent. The
 * source of truth is the machine-readable block in
 * docs/reference/voice-action-catalog.md — the same block the API pins to the
 * code via packages/api/test/ai/voice-action-catalog.contract.test.ts. Chained
 * together: code ↔ catalog (api contract test) and catalog ↔ examples (this
 * test), so a renamed/removed intent can never leave a dead example in the UI.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { VOICE_EXAMPLES, pickExamples } from './voice-examples';

const here = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(here, '../../../../../docs/reference/voice-action-catalog.md');

interface Catalog {
  speakable: Array<{ intent: string; proposalType: string; actionClass: string }>;
  handlerNoOnramp: string[];
  gated: string[];
}

/** Same extraction the API contract test uses (marker block → JSON). */
function loadCatalog(): Catalog {
  const md = readFileSync(CATALOG_PATH, 'utf8');
  const begin = md.indexOf('<!-- BEGIN machine-readable: voice-action-catalog -->');
  const end = md.indexOf('<!-- END machine-readable: voice-action-catalog -->');
  if (begin < 0 || end < 0) {
    throw new Error('voice-action-catalog machine-readable markers not found');
  }
  const between = md.slice(begin, end);
  const jsonStart = between.indexOf('{');
  const jsonEnd = between.lastIndexOf('}');
  return JSON.parse(between.slice(jsonStart, jsonEnd + 1)) as Catalog;
}

describe('U7: VoiceBar examples ↔ voice-action catalog', () => {
  const speakable = new Set(loadCatalog().speakable.map((r) => r.intent));

  it('every example intent is a speakable catalog intent', () => {
    const dead = VOICE_EXAMPLES.filter((e) => !speakable.has(e.intent));
    expect(
      dead,
      `Examples referencing non-speakable intents: ${dead.map((e) => e.intent).join(', ')}`,
    ).toEqual([]);
  });

  it('covers the three taxonomy-1.2.0 intents', () => {
    const intents = new Set(VOICE_EXAMPLES.map((e) => e.intent));
    expect(intents.has('create_invoice_schedule')).toBe(true);
    expect(intents.has('respond_to_review')).toBe(true);
    expect(intents.has('create_standing_instruction')).toBe(true);
  });

  it('has 12-15 distinct, non-empty examples', () => {
    expect(VOICE_EXAMPLES.length).toBeGreaterThanOrEqual(12);
    expect(VOICE_EXAMPLES.length).toBeLessThanOrEqual(15);
    expect(new Set(VOICE_EXAMPLES.map((e) => e.example)).size).toBe(VOICE_EXAMPLES.length);
    for (const e of VOICE_EXAMPLES) expect(e.example.trim().length).toBeGreaterThan(0);
  });

  it('pickExamples returns distinct entries, bounded by pool size', () => {
    // Deterministic rand → deterministic selection.
    const picked = pickExamples(4, () => 0.42);
    expect(picked).toHaveLength(4);
    expect(new Set(picked.map((e) => e.example)).size).toBe(4);
    expect(pickExamples(999, () => 0.42)).toHaveLength(VOICE_EXAMPLES.length);
    expect(pickExamples(0, () => 0.42)).toHaveLength(1);
  });
});
