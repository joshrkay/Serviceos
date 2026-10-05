/**
 * #1613 — text sent to a speech engine spells email addresses out, the way
 * it already spells dollar amounts (#1331): Layer 2 run 37323734649 heard
 * "ops@acme.com" read back as one word ("oppeaceatacme.com") and the caller
 * confirmed it. Spelled ("o-p-s at acme dot com"; Spanish "arroba"/"punto")
 * a misheard letter is audible, and every engine says the same words. Text
 * surfaces (in-app chat, transcript, cards) keep the address.
 *
 * Seam: `speakableText`, applied by every TTS provider before synthesis.
 */
import { describe, it, expect } from 'vitest';

import { speakableText } from '../../../src/ai/tts/speakable-text';

describe('#1613 — speakableText spells email addresses', () => {
  it('spells the address inside a readback, leaving the rest of the line alone', () => {
    expect(speakableText("Just to confirm — you'd like to update Acme's email to ops@acme.com. Is that right?")).toBe(
      "Just to confirm — you'd like to update Acme's email to o-p-s at acme dot com. Is that right?",
    );
  });

  it('spells in Spanish with arroba and punto', () => {
    expect(
      speakableText('Para confirmar: usted desea actualizar el correo electrónico de Acme a ops@acme.com. ¿Es correcto?', 'es'),
    ).toBe('Para confirmar: usted desea actualizar el correo electrónico de Acme a o-p-s arroba acme punto com. ¿Es correcto?');
  });

  it('still spells dollars out in English on the same line', () => {
    expect(speakableText('Your balance is $972.00; the invoice went to jane.smith@example.com.')).toBe(
      'Your balance is 972 dollars; the invoice went to j-a-n-e dot s-m-i-t-h at example dot com.',
    );
  });
});
