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

/** Whole words that tell the owner they can hear, speak, play or listen to something. "hears" (what a caller does) is not one. */
const SPEECH_PROMISE = /\b(hear|say|speak|talk|listen|play|mic|microphone|voice|aloud|out loud)\b/i;
const promisesSpeech = (text: string): boolean => SPEECH_PROMISE.test(text);

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

  // The owner reads two options and taps one. Nothing in the shell plays a greeting, listens, or
  // answers to "first" or "second" (S3, the voice slice, wires that), so what Rivet asks and the
  // line under it must not promise it. When S3 lands it removes this guard deliberately, with the
  // capability it stands in for.
  describe('while the shell cannot speak or listen', () => {
    it.each(REGISTRY_TRADES)('%s: no question or support line promises to hear, say, play or listen to anything', (trade) => {
      for (const entry of getChoiceRegistry(trade)) {
        for (const text of [entry.question, entry.supportLine ?? '']) {
          expect(promisesSpeech(text), `${entry.settingKey}: "${text}"`).toBe(false);
        }
      }
    });

    it('the guard itself catches the promises it exists for, and lets plain copy through', () => {
      for (const promise of [
        'Tap one to hear it. Say "first" or "second" to pick.',
        'Say "second" to pick.',
        'Tap to listen.',
        'Tap the mic and answer.',
        'Use the microphone.',
        'Read it out loud.',
        'Tap play to hear the greeting.',
        'Talk to me in your own voice.',
      ]) {
        expect(promisesSpeech(promise), promise).toBe(true);
      }
      for (const plain of [
        'Pick the one that sounds right.',
        "This is the first number a caller hears. Here's where plumbing shops in Cleveland land.",
        'Emergencies skip this. Those always come straight to you.',
        'Do customers already call a business number?',
      ]) {
        expect(promisesSpeech(plain), plain).toBe(false);
      }
    });
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
