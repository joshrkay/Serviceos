/**
 * #1600 — the new caller-facing copy renders in both languages.
 *
 * Seam: `renderTtsText` / `rebookOfferLine` (tts-copy.ts), the one render
 * every phone transport and the Layer 1 driver speak through. Expected
 * strings are the owner's decided sentences and their catalogued Spanish.
 */
import { describe, it, expect } from 'vitest';
import {
  CROSS_CUSTOMER_REFUSAL_COPY,
  REBOOK_DECLINED_COPY,
  REPEATED_REQUEST_HANDOFF_COPY,
  rebookOfferLine,
  renderTtsText,
} from '../../../../src/ai/agents/customer-calling/tts-copy';

const CANCELLED_AT = '2026-05-01T11:59:30.000Z'; // Friday May 1, 04:59 Pacific

describe('#1600 (3) — the rebook offer', () => {
  it('names the cancellation date tenant-local in English', () => {
    expect(rebookOfferLine(CANCELLED_AT, 'America/Los_Angeles', 'en')).toBe(
      'That appointment was cancelled on Friday, May 1 — would you like to book a new one?',
    );
  });

  it('renders the same offer in Spanish for a Spanish session', () => {
    expect(rebookOfferLine(CANCELLED_AT, 'America/Los_Angeles', 'es')).toBe(
      'Esa cita se canceló el viernes, 1 de mayo — ¿le gustaría reservar una nueva?',
    );
  });

  it('still makes the offer without a usable date or zone', () => {
    expect(rebookOfferLine(undefined, 'America/Los_Angeles', 'en')).toBe(
      'That appointment was cancelled — would you like to book a new one?',
    );
    expect(rebookOfferLine('not a date', 'America/Los_Angeles', 'es')).toBe(
      'Esa cita se canceló — ¿le gustaría reservar una nueva?',
    );
    // An unusable zone falls back to the system zone rather than dropping the sentence.
    expect(rebookOfferLine(CANCELLED_AT, 'Not/AZone', 'en')).toMatch(
      /^That appointment was cancelled on [A-Z][a-z]+day, May 1 — would you like to book a new one\?$/,
    );
  });

  it('is the `rebook_offer` template the processor speaks through renderTtsText', () => {
    const payload = { template: 'rebook_offer', cancelledOn: CANCELLED_AT, timezone: 'America/Los_Angeles' };
    expect(renderTtsText('rebook_offer', payload, 'es')).toBe(
      'Esa cita se canceló el viernes, 1 de mayo — ¿le gustaría reservar una nueva?',
    );
  });
});

describe('#1600 — the fixed sentences are catalogued in Spanish', () => {
  it.each([
    [CROSS_CUSTOMER_REFUSAL_COPY, 'Solo puedo ayudarle con la cuenta de esta línea.'],
    [
      REPEATED_REQUEST_HANDOFF_COPY,
      'Quiero asegurarme de que esto se atienda bien — déjeme comunicarle con una persona que pueda ayudarle.',
    ],
    [REBOOK_DECLINED_COPY, 'No hay problema. ¿Hay algo más en lo que pueda ayudarle?'],
  ])('%s → es', (en, es) => {
    expect(renderTtsText(en, {}, 'es')).toBe(es);
    expect(renderTtsText(en, {}, 'en')).toBe(en);
  });
});
