/**
 * #1603 — hands-free step 1: speak a memo answer back.
 *
 * The memo path (voice tab) receives a lookup answer as TEXT (the shared
 * voice-answer contract). To speak it, the device asks the server's unified
 * TTS — `POST /api/voice/tts`, the same provider the in-app Assistant's
 * replies are synthesized with — for one clip and plays it. The text always
 * stays on screen; speech is additive and best-effort: a 501 (no TTS
 * configured), a 502 (provider failure) or a network error simply leaves the
 * answer silent.
 *
 * The per-device "speak answers" toggle defaults ON and is persisted locally
 * (expo-secure-store, the app's existing small-value store — see
 * calls/callbackStorage.ts). It is a device preference, not a tenant setting.
 */
import * as SecureStore from 'expo-secure-store';
import type { VoiceLookupAnswer } from '@ai-service-os/shared';
import type { ApiFetch } from '../lib/apiFetch';

export const SPEAK_ANSWERS_KEY = 'voice.speakAnswers';

/** Default ON: an unset key means "speak". Only an explicit 'off' silences. */
export async function loadSpeakAnswers(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(SPEAK_ANSWERS_KEY)) !== 'off';
  } catch {
    return true;
  }
}

export async function saveSpeakAnswers(on: boolean): Promise<void> {
  try {
    await SecureStore.setItemAsync(SPEAK_ANSWERS_KEY, on ? 'on' : 'off');
  } catch {
    // keychain unavailable — the in-memory value still applies this session
  }
}

/**
 * What gets spoken: the answer's summary sentence. The structured rows are
 * visual detail (dates, amounts) that read badly aloud and stay on the card.
 */
export function answerSpeechText(answer: VoiceLookupAnswer): string {
  return answer.summary;
}

/**
 * Ask the server for the clip. Resolves the base64 audio, or null whenever
 * there is nothing to play (not configured, failed, offline) — never throws.
 */
export async function fetchAnswerSpeech(api: ApiFetch, text: string): Promise<string | null> {
  try {
    const res = await api('/api/voice/tts', { method: 'POST', body: JSON.stringify({ text }) });
    if (!res.ok) return null;
    const body = (await res.json()) as { audio?: unknown };
    return typeof body.audio === 'string' && body.audio.length > 0 ? body.audio : null;
  } catch {
    return null;
  }
}
