/**
 * #1603 — screen-side wiring for spoken memo answers.
 *
 * Owns the per-device toggle (loaded once, persisted on change) and speaks
 * each NEW `answered` outcome exactly once through the Assistant's existing
 * expo-audio player. `enabled` is null until the stored preference has been
 * read, so an answer that lands first is spoken as soon as the preference
 * resolves to on — and never when it resolves to off.
 *
 * Cancellation matters on a field connection: the TTS fetch can take seconds.
 * If, meanwhile, the toggle goes off, the card is dismissed ("Speak again" →
 * the outcome resets, and the mic may already be open — play() flips the iOS
 * session out of record mode and would cut that recording), or the screen is
 * left, the late clip must NOT play. The speak effect's cleanup is the
 * cancellation point for all three.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { assistantAudioPlayer } from '../assistant/nativeAssistantDeps';
import { useApiClient } from '../lib/useApiClient';
import {
  answerSpeechText,
  fetchAnswerSpeech,
  loadSpeakAnswers,
  saveSpeakAnswers,
} from './speakAnswers';
import type { VoiceRoutedOutcome } from './uploadAndTranscribe';

export interface UseSpeakAnswers {
  /** null while the stored preference loads; then the live value. */
  enabled: boolean | null;
  setEnabled: (on: boolean) => void;
}

export function useSpeakAnswers(outcome: VoiceRoutedOutcome | null): UseSpeakAnswers {
  const api = useApiClient();
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  // The answer object last handed to the player — one clip per answer, even
  // across re-renders or a toggle flip while the card is still showing.
  const spokenRef = useRef<unknown>(null);
  // A choice the user made before the stored preference finished loading wins.
  const userSetRef = useRef(false);

  useEffect(() => {
    let live = true;
    void loadSpeakAnswers().then((on) => {
      if (live && !userSetRef.current) setEnabledState(on);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (enabled !== true || !outcome || outcome.kind !== 'answered') return;
    if (spokenRef.current === outcome.answer) return;
    spokenRef.current = outcome.answer;
    let cancelled = false;
    void (async () => {
      try {
        const audio = await fetchAnswerSpeech(api, answerSpeechText(outcome.answer));
        if (cancelled || !audio) return;
        await assistantAudioPlayer.play(audio);
      } catch {
        // Best-effort speech (cache write, audio-mode or player failure): the
        // answer is on screen; a device playback error is not the user's.
      }
    })();
    // Toggle off, outcome reset ("Speak again"), or unmount → the in-flight
    // clip is dropped instead of played.
    return () => {
      cancelled = true;
    };
  }, [api, enabled, outcome]);

  const setEnabled = useCallback((on: boolean) => {
    userSetRef.current = true;
    setEnabledState(on);
    void saveSpeakAnswers(on);
  }, []);

  return { enabled, setEnabled };
}
