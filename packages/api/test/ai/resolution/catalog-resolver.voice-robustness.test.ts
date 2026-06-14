/**
 * P3 — AI voice-prompting robustness for the catalog money path.
 *
 * Whisper transcripts from a noisy truck are messy: compounds get joined
 * or split ("waterheater" / "tune up"), acronyms get spaced ("a c"),
 * conversational fillers leak in ("um", "please"), letters drop
 * ("condeser"), and accents/diacritics appear. This suite is a regression
 * corpus that pins how `resolveLineItemToCatalog` handles each, with one
 * hard invariant on the money path:
 *
 *   A noisy transcript NEVER silently sets the WRONG price. It either
 *   resolves to the right catalog item (exact/high) or degrades to
 *   `ambiguous` with the right item as a candidate (one-tap confirm) —
 *   it never returns a confident match for the wrong item.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveLineItemToCatalog,
  CatalogLineResolution,
} from '../../../src/ai/resolution/catalog-resolver';
import { CatalogItem, createCatalogItem } from '../../../src/catalog/catalog-item';

const TENANT = 'tenant-voice';

function item(name: string, cents: number, category: CatalogItem['category'] = 'Labor'): CatalogItem {
  return createCatalogItem({ tenantId: TENANT, name, category, unit: 'each', unitPriceCents: cents });
}

const CATALOG: CatalogItem[] = [
  item('AC Repair', 15_000),
  item('Water Heater Install', 185_000),
  item('HVAC Tune-Up', 9_900),
  item('Condenser Coil', 62_000, 'Parts'),
  item('Thermostat', 18_000, 'Parts'),
  item('Drain Cleaning', 14_000),
];

function topName(r: CatalogLineResolution): string | undefined {
  return r.match?.name ?? r.candidates?.[0]?.item.name;
}

describe('catalog resolver — voice transcription robustness', () => {
  describe('resolves cleanly (exact/high) despite Whisper noise', () => {
    const resolved: Array<[string, string]> = [
      ['ac repair', 'AC Repair'],
      ['water heater install', 'Water Heater Install'],
      // Joined compounds — the squash fix.
      ['waterheater install', 'Water Heater Install'],
      ['hvac tuneup', 'HVAC Tune-Up'],
      ['thermo stat', 'Thermostat'],
      // Conversational fillers — the stopword fix.
      ['um water heater install', 'Water Heater Install'],
      ['water heater install please', 'Water Heater Install'],
      ['uh hvac tune up', 'HVAC Tune-Up'],
      // Articles already handled.
      ['the condenser coil', 'Condenser Coil'],
      // Single dropped letter in a multi-token phrase — the other token
      // anchors it to high.
      ['condeser coil', 'Condenser Coil'],
      // Word-order inversion.
      ['coil condenser', 'Condenser Coil'],
    ];

    it.each(resolved)('"%s" -> %s', (transcript, expected) => {
      const r = resolveLineItemToCatalog(transcript, CATALOG);
      expect(r.tier === 'exact' || r.tier === 'high').toBe(true);
      expect(r.match?.name).toBe(expected);
    });
  });

  describe('degrades safely (ambiguous, right top candidate) — never a silent wrong price', () => {
    const degrades: Array<[string, string]> = [
      // Spaced single-letter acronym: "a"/"c" are dropped, so we can't be
      // certain — surface for one-tap confirm rather than auto-price.
      ['a c repair', 'AC Repair'],
      ['h vac tune up', 'HVAC Tune-Up'],
      // Quantity word leaks into the description (qty belongs on the line
      // item field) — dilutes confidence, so confirm.
      ['two water heater installs', 'Water Heater Install'],
      // Single-token typo: one fuzzy hit caps the score below auto-price,
      // so a lone misheard word confirms rather than auto-prices.
      ['thermostatt', 'Thermostat'],
    ];

    it.each(degrades)('"%s" -> ambiguous, top candidate %s', (transcript, expectedTop) => {
      const r = resolveLineItemToCatalog(transcript, CATALOG);
      expect(r.tier).toBe('ambiguous');
      expect(topName(r)).toBe(expectedTop);
    });
  });

  describe('the money-path invariant: noise never confidently prices the WRONG item', () => {
    // Each noisy transcript and the ONLY item a confident match may price.
    // The resolver may return none/ambiguous, but if it returns exact/high
    // it must be THIS item — never a confident leap to a different one.
    const intended: Array<[string, string]> = [
      ['waterheater install', 'Water Heater Install'],
      ['hvac tuneup', 'HVAC Tune-Up'],
      ['um water heater install', 'Water Heater Install'],
      ['condeser coil', 'Condenser Coil'],
      ['thermo stat', 'Thermostat'],
      ['a c repair', 'AC Repair'],
      ['two water heater installs', 'Water Heater Install'],
      ['the drain cleaning', 'Drain Cleaning'],
    ];

    it.each(intended)('"%s" confidently prices only %s (or defers)', (transcript, intendedName) => {
      const r = resolveLineItemToCatalog(transcript, CATALOG);
      if (r.tier === 'exact' || r.tier === 'high') {
        expect(r.match?.name).toBe(intendedName);
      }
      // none/ambiguous are always acceptable — they defer to a human.
    });
  });

  describe('pure garbage and degenerate input still resolve to nothing', () => {
    it.each(['', '   ', 'x', 'asdf qwer', '🚚🚚', 'um please thanks'])(
      '"%s" -> none',
      (transcript) => {
        expect(resolveLineItemToCatalog(transcript, CATALOG).tier).toBe('none');
      },
    );
  });
});
