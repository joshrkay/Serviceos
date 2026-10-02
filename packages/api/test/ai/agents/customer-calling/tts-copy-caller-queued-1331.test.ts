import { describe, it, expect } from 'vitest';
import {
  CALLER_REQUEST_QUEUED_COPY,
  renderTtsText,
} from '../../../../src/ai/agents/customer-calling/tts-copy';

/**
 * #1331 — the S1 "passed to the team" close replaced the FSM's default
 * "taken care of" line, which had a Spanish rendering. A Spanish-language
 * caller must not flip back to English for the new close.
 */
describe('renderTtsText — S1 queued-request close (#1331)', () => {
  it('speaks the queued-request close in Spanish on a Spanish call', () => {
    const text = renderTtsText(CALLER_REQUEST_QUEUED_COPY, {}, 'es');
    expect(text).toBe(
      'Ya le pasé su solicitud a nuestro equipo, y alguien se la confirmará en breve. ¿Hay algo más en lo que pueda ayudarle?',
    );
  });
});
