import { describe, it, expect } from 'vitest';
import {
  CHOICE_KEYS,
  ChoiceEntrySchema,
  TradeChoiceRegistrySchema,
  type ChoiceKey,
} from '../../../src/onboarding/choices/schema';
import {
  CHOICE_REGISTRY,
  REGISTRY_TRADES,
  getChoiceRegistry,
  getChoiceEntry,
} from '../../../src/onboarding/choices/registry';

const REQUIRED: readonly ChoiceKey[] = CHOICE_KEYS;

describe('choice registry', () => {
  it('declares exactly the seven core choice keys in a fixed order', () => {
    expect(CHOICE_KEYS).toEqual([
      'greeting',
      'trip_fee_and_rate',
      'booking_posture',
      'payment_collection_mode',
      'booking_hours',
      'emergency_target',
      'after_hours_mode',
    ]);
  });

  it.each(REGISTRY_TRADES)('%s covers every core key exactly once and validates', (trade) => {
    const entries = getChoiceRegistry(trade);
    const keys = entries.map((e) => e.settingKey);
    for (const k of REQUIRED) {
      expect(keys.filter((x) => x === k)).toHaveLength(1);
    }
    expect(() => TradeChoiceRegistrySchema.parse(entries)).not.toThrow();
  });

  it.each(REGISTRY_TRADES)('%s: every entry has two options, a and b, and marks the common one', (trade) => {
    for (const entry of getChoiceRegistry(trade)) {
      expect(entry.options.map((o) => o.key)).toEqual(['a', 'b']);
      expect(['a', 'b']).toContain(entry.mostShops);
      for (const o of entry.options) {
        expect(o.label.length).toBeGreaterThan(0);
        expect(o.rivetLine.length).toBeGreaterThan(0);
      }
    }
  });

  it.each(REGISTRY_TRADES)('%s: the price choice is tier-driven, not hard-coded cents', (trade) => {
    const price = getChoiceEntry(trade, 'trip_fee_and_rate');
    expect(price.options[0].priceTier).toBe('standard');
    expect(price.options[1].priceTier).toBe('premium');
    // Tier-driven options carry no literal cents in `writes`; assembly fills them.
    for (const o of price.options) {
      expect(Object.values(o.writes).some((v) => typeof v === 'number')).toBe(false);
    }
  });

  it.each(REGISTRY_TRADES)('%s: every non-price option writes a typed value', (trade) => {
    for (const entry of getChoiceRegistry(trade)) {
      if (entry.settingKey === 'trip_fee_and_rate') continue;
      for (const o of entry.options) {
        expect(Object.keys(o.writes).length).toBeGreaterThan(0);
      }
    }
  });

  it('booking_posture option a books on the call and option b holds for the owner', () => {
    const e = getChoiceEntry('plumbing', 'booking_posture');
    expect(e.options[0].writes).toMatchObject({ autonomousBookingEnabled: true });
    expect(e.options[1].writes).toMatchObject({ autonomousBookingEnabled: false });
  });

  it('after_hours_mode writes only values the settings schema knows', () => {
    const e = getChoiceEntry('hvac', 'after_hours_mode');
    for (const o of e.options) {
      expect(['ai_answering', 'voicemail']).toContain(o.writes.afterHoursVoiceMode);
    }
  });

  it('templates reference only known tokens', () => {
    const allowed = new Set(['businessName', 'tripFee', 'hourlyRate', 'city', 'ownerFirstName']);
    for (const trade of REGISTRY_TRADES) {
      for (const entry of getChoiceRegistry(trade)) {
        const texts = [entry.question, entry.supportLine ?? '', ...entry.options.flatMap((o) => [o.label, o.rivetLine, o.detail ?? ''])];
        for (const t of texts) {
          for (const m of t.matchAll(/\{(\w+)\}/g)) {
            expect(allowed.has(m[1]), `unknown token {${m[1]}} in "${t}"`).toBe(true);
          }
        }
      }
    }
  });

  // S3-5 — Rivet speaks and listens: the shell plays an option's line when its card is tapped, and
  // a spoken "first" or "second" picks it. The two lines #1693 reduced to tap-only are back.
  it.each(REGISTRY_TRADES)('%s: the greeting tells the owner to tap one to hear it, or say first or second', (trade) => {
    expect(getChoiceEntry(trade, 'greeting').supportLine).toBe('Tap one to hear it. Say "first" or "second" to pick.');
  });

  it.each(REGISTRY_TRADES)('%s: the emergency line sets the scene with what a caller says', (trade) => {
    expect(getChoiceEntry(trade, 'emergency_target').supportLine).toMatch(
      /^Say a caller tells me ".+"\. Safety first, then a person\. That part I always do\. This part is yours\.$/,
    );
  });

  it('rejects a registry missing a core key', () => {
    const entries = getChoiceRegistry('plumbing').filter((e) => e.settingKey !== 'greeting');
    expect(() => TradeChoiceRegistrySchema.parse(entries)).toThrow(/greeting/);
  });

  it('rejects an entry whose options are not exactly a then b', () => {
    const e = getChoiceEntry('plumbing', 'greeting');
    const swapped = { ...e, options: [e.options[1], e.options[0]] };
    expect(() => ChoiceEntrySchema.parse(swapped)).toThrow();
  });

  it('getChoiceRegistry falls back to the generic trade for unknown pack ids', () => {
    expect(getChoiceRegistry('roofing')).toEqual(CHOICE_REGISTRY.generic);
    expect(getChoiceRegistry('other')).toEqual(CHOICE_REGISTRY.generic);
  });

  it('exposes the optional established-shop key separately from the core seven', () => {
    const e = getChoiceEntry('plumbing', 'existing_number');
    expect(e.settingKey).toBe('existing_number');
    expect(REQUIRED).not.toContain('existing_number');
  });
});
