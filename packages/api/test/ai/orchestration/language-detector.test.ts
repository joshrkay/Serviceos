/**
 * P11-002 — language detector tests. Pins the resolution order
 * (customer override > STT hint > transcript heuristic > tenant
 * default > 'en') and the language-switch intent detector used by
 * the FSM adapter for mid-call language flips.
 *
 * Test names include "language" / "multilingual" so the gate's
 * `-t` filter matches.
 */
import { describe, it, expect } from 'vitest';
import {
  detectLanguage,
  detectLanguageFromTranscript,
  detectLanguageSwitchIntent,
} from '../../../src/ai/orchestration/language-detector';

describe('P11-002 multilingual language detector', () => {
  it('language: customer preferredLanguage overrides every other signal', () => {
    expect(
      detectLanguage({
        customerPreferredLanguage: 'es',
        transcriptLanguageHint: 'en',
        tenantDefaultLanguage: 'en',
        transcript: 'hello there',
      }),
    ).toBe('es');
  });

  it('language: STT hint wins when no customer override', () => {
    expect(
      detectLanguage({
        transcriptLanguageHint: 'es',
        tenantDefaultLanguage: 'en',
      }),
    ).toBe('es');
  });

  it('language: transcript heuristic detects Spanish marker', () => {
    expect(
      detectLanguage({
        transcript: 'Hola, necesito agendar una cita',
        tenantDefaultLanguage: 'en',
      }),
    ).toBe('es');
  });

  it('language: tenant default applies when transcript is plain English', () => {
    expect(
      detectLanguage({
        transcript: 'I need to book an appointment',
        tenantDefaultLanguage: 'es',
      }),
    ).toBe('es');
  });

  it('language: falls back to en when nothing else resolves', () => {
    expect(detectLanguage({})).toBe('en');
  });

  it('multilingual switch intent: english cues flip session to en', () => {
    expect(detectLanguageSwitchIntent('english please')).toBe('en');
    expect(detectLanguageSwitchIntent('Can we speak english')).toBe('en');
  });

  it('multilingual switch intent: spanish cues flip session to es', () => {
    expect(detectLanguageSwitchIntent('hablo español')).toBe('es');
    expect(detectLanguageSwitchIntent('hablo espanol')).toBe('es');
  });

  it('multilingual switch intent: returns null for non-switch utterances', () => {
    expect(detectLanguageSwitchIntent('I want to schedule a job')).toBeNull();
  });

  it('language: detectLanguageFromTranscript returns null on empty marker overlap', () => {
    expect(detectLanguageFromTranscript('schedule appointment')).toBeNull();
    expect(detectLanguageFromTranscript('hola mundo')).toBe('es');
  });
});
