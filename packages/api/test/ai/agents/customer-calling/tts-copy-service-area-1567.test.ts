import { describe, it, expect } from 'vitest';
import { renderTtsText } from '../../../../src/ai/agents/customer-calling/tts-copy';
import {
  OUT_OF_SERVICE_AREA_COPY,
  SERVICE_AREA_ZIP_QUESTION,
} from '../../../../src/ai/voice-turn/service-area-gate';

/** #1567 — the service-area lines keep a Spanish-language call in Spanish. */
describe('renderTtsText — service-area lines (#1567)', () => {
  it('speaks the out-of-area line in Spanish on a Spanish call', () => {
    expect(renderTtsText(OUT_OF_SERVICE_AREA_COPY, {}, 'es')).toBe(
      'Normalmente no damos servicio en esa zona, pero le pasaré sus datos al equipo.',
    );
  });

  it('asks for the ZIP code in Spanish on a Spanish call', () => {
    expect(renderTtsText(SERVICE_AREA_ZIP_QUESTION, {}, 'es')).toBe(
      'Claro — ¿cuál es el código postal de la dirección donde necesita el servicio?',
    );
  });

  it('leaves both lines in English on an English call', () => {
    expect(renderTtsText(OUT_OF_SERVICE_AREA_COPY, {}, 'en')).toBe(
      "We don't usually service that area, but I'll pass your details to the team.",
    );
  });
});
