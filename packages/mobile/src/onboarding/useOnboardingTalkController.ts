/**
 * Device wiring for the spoken setup screen: the real API, the assistant's
 * transcription call, the server TTS voice and the batch approve, handed to
 * useOnboardingTalk (pure logic, injected deps). Device-only, like
 * useAssistantController; the screen test mocks it.
 */
import { useMemo } from 'react';
import { useAuth } from '@clerk/expo';
import { fetchOnboardingStatus } from '../api/onboarding';
import { createAssistantTransport } from '../assistant/expoFetchTransport';
import { assistantAudioPlayer } from '../assistant/nativeAssistantDeps';
import { isIdentityStepDone } from '../hooks/useOnboardingStatus';
import { API_BASE_URL } from '../lib/env';
import { useApiClient } from '../lib/useApiClient';
import { useApproveBatch } from '../proposals/useApproveBatch';
import { fetchAnswerSpeech, loadSpeakAnswers } from '../voice/speakAnswers';
import { deviceTimezoneOrUndefined, postOnboardingTurn, stillAwaitingApproval } from './talkThrough';
import { useOnboardingTalk, type OnboardingTalkDeps, type UseOnboardingTalk } from './useOnboardingTalk';

export function useOnboardingTalkController(): UseOnboardingTalk {
  const apiFetch = useApiClient();
  const { getToken } = useAuth();
  const approve = useApproveBatch();
  const deps = useMemo<OnboardingTalkDeps>(() => {
    const transport = createAssistantTransport({
      apiFetch,
      getToken: (opts) => getToken({ template: 'serviceos', skipCache: opts?.forceRefresh ?? false }),
      baseUrl: API_BASE_URL,
    });
    return {
      sendTurn: (req) => postOnboardingTurn(apiFetch, req),
      transcribe: (uri) => transport.transcribe(uri),
      // The device's "speak answers" preference applies here too; the text always stays on screen.
      speak: async (text, isCurrent) => {
        if (!(await loadSpeakAnswers())) return;
        const audio = await fetchAnswerSpeech(apiFetch, text);
        if (!audio || !isCurrent()) return;
        try {
          await assistantAudioPlayer.play(audio, isCurrent);
        } catch {
          // Playback is additive: the reply is on screen either way.
        }
      },
      approve,
      stillAwaiting: (ids) => stillAwaitingApproval(apiFetch, ids),
      identityDone: async () => {
        try {
          return isIdentityStepDone(await fetchOnboardingStatus(apiFetch));
        } catch {
          return null;
        }
      },
      timezone: deviceTimezoneOrUndefined(),
    };
  }, [apiFetch, getToken, approve]);
  return useOnboardingTalk(deps);
}
