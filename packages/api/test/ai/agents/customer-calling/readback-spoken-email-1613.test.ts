/**
 * #1613 — the `update_customer` readback carries the new email as an ADDRESS
 * (a spoken form such as "ops at acme dot com" is normalised first), so the
 * in-app chat text, the transcript line and the operator card all read
 * "ops@acme.com". The spelling the caller hears ("o-p-s at acme dot com") is
 * applied where text becomes speech — `speakableText` in ai/tts — exactly as
 * dollar amounts are (#1331); see tts-speakable-email-1613.test.ts.
 *
 * Seam: `renderTtsText`, the renderer every surface renders the readback
 * through (in-app, Gather <Say>, media streams, speechTurn's transcript line).
 */
import { describe, it, expect } from 'vitest';

import { renderTtsText } from '../../../../src/ai/agents/customer-calling/tts-copy';

const readback = (entities: Record<string, unknown>, lang: 'en' | 'es' = 'en') =>
  renderTtsText('intent_confirm', { template: 'confirm_intent', intent: 'update_customer', entities }, lang);

describe('#1613 — the update_customer readback carries the new email as an address', () => {
  it('carries an address the recogniser wrote as an address', () => {
    expect(readback({ customerName: 'Acme', updatedEmail: 'Ops@Acme.com' })).toBe(
      "Just to confirm — you'd like to update Acme's email to ops@acme.com. Is that right?",
    );
  });

  it('normalises a spoken address to the address', () => {
    expect(readback({ updatedEmail: 'ops at acme dot com' })).toBe(
      "Just to confirm — you'd like to update the customer email to ops@acme.com. Is that right?",
    );
    expect(readback({ customerName: 'Acme', updatedEmail: 'ops arroba acme punto com' }, 'es')).toBe(
      'Para confirmar: usted desea actualizar el correo electrónico de Acme a ops@acme.com. ¿Es correcto?',
    );
  });

  it('reads a value that is not an address back exactly as heard, so the caller can say no', () => {
    expect(readback({ updatedEmail: 'oppeaceatacme.com' })).toBe(
      "Just to confirm — you'd like to update the customer email to oppeaceatacme.com. Is that right?",
    );
  });
});
