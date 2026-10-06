/**
 * #846 / UB-C1 — mid-call language switch: the POLICY every transport
 * applies, and the handler the Gather adapter and `speechTurn` share.
 *
 * #1601 step 2 — the one copy. `handleLanguageSwitchGather`
 * (telephony/twilio-adapter.ts) and `handleLanguageSwitchTurn`
 * (create-voice-turn-processor.ts) were the same ~50 lines; media-streams'
 * `switchLanguage` owns a live Deepgram socket (lock, generation bump,
 * reopen, rollback) and keeps that, but takes its already-active /
 * opt-in / flap-cap decision from {@link decideLanguageSwitch} so the three
 * can never disagree on WHEN a switch is allowed.
 *
 * Policy: the requested language is the utterance's when the heuristic can
 * extract it, else the other half of the en/es pair (the classifier already
 * said this turn IS a switch request). Asking for the language already
 * active just acknowledges — no counter spend, no event. The tenant
 * `supported_languages` opt-in gates the target (`detectLanguageSwitchIntent`
 * is an ungated heuristic). {@link MAX_LANGUAGE_SWITCHES_PER_CALL} bounds
 * reopen-style flapping. A real switch flips `session.language`, counts it,
 * re-resolves the per-language TTS voice (settings.ttsVoiceEn/Es — the voice
 * was resolved once at session start for the then-current language, and
 * carrying it over would read Spanish in the English voice; a resolver
 * failure clears the override so the language-derived default applies),
 * emits `language_switched`, and acknowledges in the language switched TO —
 * the caller just told us that is the one they understand.
 */
import type { SideEffect } from '../../agents/customer-calling/types';
import type { VoiceSession } from '../../agents/customer-calling/voice-session-store';
import type { SettingsRepository } from '../../../settings/settings';
import {
  LANGUAGE_SWITCH_ACK,
  LANGUAGE_UNSUPPORTED_LINE,
  LANGUAGE_SWITCH_CAP_LINE,
  type SessionLanguage,
} from '../../agents/customer-calling/tts-copy';
import {
  detectLanguageSwitchIntent,
  isLanguageSupported,
  MAX_LANGUAGE_SWITCHES_PER_CALL,
} from '../../orchestration/language-detector';
import { languageSwitchedEvent } from '../../voice-quality/events';
import { createLogger } from '../../../logging/logger';

const logger = createLogger({
  service: 'ai.voice-turn.language-switch',
  environment: process.env.NODE_ENV || 'development',
});

export type LanguageSwitchDecision =
  | { kind: 'already_active'; current: SessionLanguage }
  | { kind: 'unsupported'; current: SessionLanguage; target: SessionLanguage }
  | { kind: 'flap_capped'; current: SessionLanguage; target: SessionLanguage; switchCount: number }
  | { kind: 'switch'; from: SessionLanguage; to: SessionLanguage; switchCount: number };

/** The transport-independent rule. `switchCount` is the count BEFORE this request. */
export function decideLanguageSwitch(input: {
  current: SessionLanguage;
  target: SessionLanguage;
  supportedLanguages: readonly SessionLanguage[] | null | undefined;
  switchCount: number;
}): LanguageSwitchDecision {
  const { current, target, switchCount } = input;
  if (target === current) return { kind: 'already_active', current };
  if (!isLanguageSupported(target, input.supportedLanguages ? [...input.supportedLanguages] : null)) {
    return { kind: 'unsupported', current, target };
  }
  if (switchCount >= MAX_LANGUAGE_SWITCHES_PER_CALL) {
    return { kind: 'flap_capped', current, target, switchCount };
  }
  return { kind: 'switch', from: current, to: target, switchCount: switchCount + 1 };
}

/** The utterance's requested language when extractable, else the other half of the pair. */
export function requestedLanguageSwitchTarget(speechResult: string, current: SessionLanguage): SessionLanguage {
  return detectLanguageSwitchIntent(speechResult) ?? (current === 'es' ? 'en' : 'es');
}

/** settings.ttsVoiceEn/Es for `language`; undefined without a repo, a voice, or on a failed read. */
export async function resolveTtsVoiceForLanguage(
  settingsRepo: Pick<SettingsRepository, 'findByTenant'> | undefined,
  tenantId: string,
  language: SessionLanguage,
): Promise<string | undefined> {
  if (!settingsRepo) return undefined;
  try {
    const settings = await settingsRepo.findByTenant(tenantId);
    return (language === 'es' ? settings?.ttsVoiceEs : settings?.ttsVoiceEn) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Gather / speechTurn handler: an ADAPTER-SHAPE act, out-of-FSM (the pure
 * FSM cannot mutate `session.language`; the transport's next listen turn
 * follows the flipped session fields). Never throws; always returns the side
 * effects to speak.
 */
export async function switchSessionLanguage(
  session: VoiceSession,
  opts: {
    tenantId: string;
    speechResult: string;
    settingsRepo?: Pick<SettingsRepository, 'findByTenant'>;
    /** Which turn loop is speaking — for the refusal log line only. */
    surface: 'gather' | 'speechTurn';
  },
): Promise<SideEffect[]> {
  const current: SessionLanguage = session.language === 'es' ? 'es' : 'en';
  const decision = decideLanguageSwitch({
    current,
    target: requestedLanguageSwitchTarget(opts.speechResult, current),
    supportedLanguages: session.supportedLanguages ?? null,
    switchCount: session.languageSwitchCount ?? 0,
  });
  switch (decision.kind) {
    case 'already_active':
      return [{ type: 'tts_play', payload: { text: LANGUAGE_SWITCH_ACK[current] } }];
    case 'unsupported':
      return [{ type: 'tts_play', payload: { text: LANGUAGE_UNSUPPORTED_LINE[current] } }];
    case 'flap_capped':
      logger.info('language switch refused — flap guard', {
        surface: opts.surface,
        sessionId: session.id,
        target: decision.target,
        switchCount: decision.switchCount,
      });
      return [{ type: 'tts_play', payload: { text: LANGUAGE_SWITCH_CAP_LINE[current] } }];
    case 'switch': {
      session.language = decision.to;
      session.languageSwitchCount = decision.switchCount;
      // The flip lands BEFORE the settings read and the voice after it — the
      // order both copies had. A turn runs under the per-session lock, so no
      // other turn observes the session between the two.
      // eslint-disable-next-line require-atomic-updates
      session.ttsVoice = await resolveTtsVoiceForLanguage(opts.settingsRepo, opts.tenantId, decision.to);
      session.events.emit(
        'voice-event',
        languageSwitchedEvent({
          from: decision.from,
          to: decision.to,
          trigger: 'classified_intent',
          switchCount: decision.switchCount,
        }),
      );
      return [{ type: 'tts_play', payload: { text: LANGUAGE_SWITCH_ACK[decision.to] } }];
    }
  }
}
