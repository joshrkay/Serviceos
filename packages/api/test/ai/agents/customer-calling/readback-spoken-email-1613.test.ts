/**
 * #1613 — the `update_customer` readback spells a new email address out so
 * the caller can hear whether it was understood (Layer 2 run 37323734649
 * read "ops@acme.com" back as the one word "oppeaceatacme.com", and the
 * caller said yes to it). A spoken form ("ops at acme dot com") is first
 * normalised to the address, then spelled; Spanish spells with "arroba" and
 * "punto".
 *
 * Seam: `renderTtsText`, the renderer every surface speaks the readback
 * through (in-app, Gather <Say>, media streams, speechTurn's transcript line).
 */
import { describe, it, expect } from 'vitest';

import { renderTtsText } from '../../../../src/ai/agents/customer-calling/tts-copy';

const readback = (entities: Record<string, unknown>, lang: 'en' | 'es' = 'en') =>
  renderTtsText('intent_confirm', { template: 'confirm_intent', intent: 'update_customer', entities }, lang);

describe('#1613 — the update_customer readback spells the new email', () => {
  it('spells an address the recogniser wrote as an address', () => {
    expect(readback({ customerName: 'Acme', updatedEmail: 'ops@acme.com' })).toBe(
      "Just to confirm — you'd like to update Acme's email to o-p-s at acme dot com. Is that right?",
    );
  });

  it('normalises a spoken address before spelling it', () => {
    expect(readback({ updatedEmail: 'ops at acme dot com' })).toBe(
      "Just to confirm — you'd like to update the customer email to o-p-s at acme dot com. Is that right?",
    );
  });

  it('spells in Spanish with arroba and punto', () => {
    expect(readback({ customerName: 'Acme', updatedEmail: 'ops@acme.com' }, 'es')).toBe(
      'Para confirmar: usted desea actualizar el correo electrónico de Acme a o-p-s arroba acme punto com. ¿Es correcto?',
    );
  });

  it('reads a value that is not an address back exactly as heard, so the caller can say no', () => {
    expect(readback({ updatedEmail: 'oppeaceatacme.com' })).toBe(
      "Just to confirm — you'd like to update the customer email to oppeaceatacme.com. Is that right?",
    );
  });
});
