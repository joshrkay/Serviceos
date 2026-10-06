/**
 * #1601 step 2 — the mid-call language-switch POLICY (#846 / UB-C1) has ONE
 * home, and the Gather + speechTurn handler (one copy each before) is one
 * function.
 *
 * Policy, identical on every transport: the requested language is the
 * utterance's when the heuristic can extract it, else the other half of the
 * en/es pair (the classifier already said this turn IS a switch request);
 * asking for the language already active just acknowledges (no counter
 * spend, no event); the tenant `supported_languages` opt-in gates the
 * target; MAX_LANGUAGE_SWITCHES_PER_CALL bounds flapping. A real switch
 * flips `session.language`, bumps the per-call count, re-resolves the TTS
 * voice for the NEW language from settings (a failed read clears the
 * override), emits `language_switched`, and acknowledges in the language
 * switched TO.
 */
import { describe, it, expect } from 'vitest';
import {
  decideLanguageSwitch,
  requestedLanguageSwitchTarget,
  switchSessionLanguage,
} from '../../../../src/ai/voice-turn/shared/language-switch';
import { MAX_LANGUAGE_SWITCHES_PER_CALL } from '../../../../src/ai/orchestration/language-detector';
import {
  LANGUAGE_SWITCH_ACK,
  LANGUAGE_UNSUPPORTED_LINE,
  LANGUAGE_SWITCH_CAP_LINE,
} from '../../../../src/ai/agents/customer-calling/tts-copy';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import type { SettingsRepository } from '../../../../src/settings/settings';
import type { SideEffect } from '../../../../src/ai/agents/customer-calling/types';

const TENANT = 't-1601-lang';
const store = new VoiceSessionStore({ startInterval: false });

function session(opts: { language?: 'en' | 'es'; supported?: ('en' | 'es')[]; switches?: number } = {}) {
  const s = store.create(TENANT, 'telephony', { callSid: `CA-${Math.random().toString(36).slice(2, 8)}` });
  if (opts.language) s.language = opts.language;
  if (opts.supported) s.supportedLanguages = opts.supported;
  if (opts.switches !== undefined) s.languageSwitchCount = opts.switches;
  const events: Array<{ type?: string }> = [];
  s.events.on('voice-event', (e: { type?: string }) => events.push(e));
  return { s, events };
}
const tts = (fx: SideEffect[]) =>
  fx.filter((f) => f.type === 'tts_play').map((f) => String((f.payload as { text?: string }).text));
const settings = (rows: Record<string, unknown>) =>
  ({ findByTenant: async () => rows }) as unknown as SettingsRepository;

describe('decideLanguageSwitch (shared policy)', () => {
  it('the language already active is acknowledged, not switched', () => {
    expect(decideLanguageSwitch({ current: 'en', target: 'en', supportedLanguages: ['en', 'es'], switchCount: 0 }))
      .toEqual({ kind: 'already_active', current: 'en' });
  });
  it('a language the tenant has not opted into is refused', () => {
    expect(decideLanguageSwitch({ current: 'en', target: 'es', supportedLanguages: ['en'], switchCount: 0 }))
      .toEqual({ kind: 'unsupported', current: 'en', target: 'es' });
  });
  it('the per-call flap cap refuses the switch', () => {
    expect(
      decideLanguageSwitch({ current: 'en', target: 'es', supportedLanguages: ['en', 'es'], switchCount: MAX_LANGUAGE_SWITCHES_PER_CALL }),
    ).toEqual({ kind: 'flap_capped', current: 'en', target: 'es', switchCount: MAX_LANGUAGE_SWITCHES_PER_CALL });
  });
  it('otherwise switches and counts it', () => {
    expect(decideLanguageSwitch({ current: 'en', target: 'es', supportedLanguages: ['en', 'es'], switchCount: 1 }))
      .toEqual({ kind: 'switch', from: 'en', to: 'es', switchCount: 2 });
  });
});

describe('requestedLanguageSwitchTarget', () => {
  it('reads the requested language from the utterance, else the other half of the pair', () => {
    expect(requestedLanguageSwitchTarget('¿Podemos hablar en español?', 'en')).toBe('es');
    expect(requestedLanguageSwitchTarget('can we switch to english please', 'es')).toBe('en');
    expect(requestedLanguageSwitchTarget('the other one, please', 'en')).toBe('es');
    expect(requestedLanguageSwitchTarget('the other one, please', 'es')).toBe('en');
  });
});

describe('switchSessionLanguage (the Gather + speechTurn handler)', () => {
  it('flips the session to Spanish, re-resolves the Spanish voice, emits language_switched and acks in Spanish', async () => {
    const { s, events } = session({ supported: ['en', 'es'] });
    const fx = await switchSessionLanguage(s, {
      tenantId: TENANT,
      speechResult: 'en español por favor',
      settingsRepo: settings({ ttsVoiceEn: 'Polly.Joanna', ttsVoiceEs: 'Polly.Lupe' }),
      surface: 'gather',
    });
    expect(tts(fx)).toEqual([LANGUAGE_SWITCH_ACK.es]);
    expect(s.language).toBe('es');
    expect(s.languageSwitchCount).toBe(1);
    expect(s.ttsVoice).toBe('Polly.Lupe');
    expect(events.map((e) => e.type)).toContain('language_switched');
  });

  it('a failed settings read clears the voice override (the language-derived default applies)', async () => {
    const { s } = session({ supported: ['en', 'es'] });
    s.ttsVoice = 'Polly.Joanna';
    await switchSessionLanguage(s, {
      tenantId: TENANT,
      speechResult: 'en español',
      settingsRepo: { findByTenant: async () => { throw new Error('pg down'); } } as unknown as SettingsRepository,
      surface: 'speechTurn',
    });
    expect(s.language).toBe('es');
    expect(s.ttsVoice).toBeUndefined();
  });

  it('the tenant has not opted in: speaks the unsupported line in the current language and stays put', async () => {
    const { s, events } = session({ supported: ['en'] });
    const fx = await switchSessionLanguage(s, { tenantId: TENANT, speechResult: 'en español', surface: 'gather' });
    expect(tts(fx)).toEqual([LANGUAGE_UNSUPPORTED_LINE.en]);
    expect(s.language ?? 'en').toBe('en');
    expect(s.languageSwitchCount ?? 0).toBe(0);
    expect(events).toEqual([]);
  });

  it('at the flap cap: speaks the cap line and stays put', async () => {
    const { s, events } = session({ supported: ['en', 'es'], switches: MAX_LANGUAGE_SWITCHES_PER_CALL });
    const fx = await switchSessionLanguage(s, { tenantId: TENANT, speechResult: 'en español', surface: 'gather' });
    expect(tts(fx)).toEqual([LANGUAGE_SWITCH_CAP_LINE.en]);
    expect(s.language ?? 'en').toBe('en');
    expect(events).toEqual([]);
  });

  it('already speaking the requested language: acks in it, no counter spend, no event', async () => {
    const { s, events } = session({ language: 'es', supported: ['en', 'es'] });
    const fx = await switchSessionLanguage(s, { tenantId: TENANT, speechResult: 'en español', surface: 'gather' });
    expect(tts(fx)).toEqual([LANGUAGE_SWITCH_ACK.es]);
    expect(s.languageSwitchCount ?? 0).toBe(0);
    expect(events).toEqual([]);
  });
});
