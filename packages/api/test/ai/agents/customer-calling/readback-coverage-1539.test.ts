/**
 * #1539 — coverage contract: NO write intent may fall back to the generic
 * "take care of that request" readback. Every `kind: 'proposal'` capability
 * (capabilities.ts — the one list every surface dispatches from) must read
 * back as itself, in English and in Spanish. A new capability that forgets
 * its readback fails here instead of shipping the vague line.
 *
 * Seam: `renderTtsText`, the renderer every surface speaks the readback
 * through (in-app, Gather <Say>, media streams).
 */
import { describe, it, expect } from 'vitest';

import { CAPABILITIES } from '../../../../src/capabilities/capabilities';
import { renderTtsText } from '../../../../src/ai/agents/customer-calling/tts-copy';

const WRITE_INTENTS = Object.entries(CAPABILITIES)
  .filter(([, capability]) => capability.kind === 'proposal')
  .map(([intent]) => intent);

const readback = (intent: string, lang: 'en' | 'es') =>
  renderTtsText('intent_confirm', { template: 'confirm_intent', intent, entities: {} }, lang);

describe('#1539 — every write intent has its own readback', () => {
  it('covers the whole write catalog', () => {
    expect(WRITE_INTENTS.length).toBeGreaterThan(40);
  });

  it.each(WRITE_INTENTS)('%s (en) is not the generic readback', (intent) => {
    expect(readback(intent, 'en')).not.toContain('take care of that request');
  });

  it.each(WRITE_INTENTS)('%s (es) is not the generic readback', (intent) => {
    expect(readback(intent, 'es')).not.toContain('atender su solicitud');
  });
});
