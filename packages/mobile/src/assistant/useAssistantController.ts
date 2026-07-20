/**
 * U13 — device wiring for the assistant screen: build the real `expo/fetch`
 * transport + expo-audio TTS player and hand them to useAssistantSession.
 *
 * Kept separate from useAssistantSession (pure logic, injected deps) so the
 * screen imports one hook while the session hook stays headless-testable. This
 * module is device-only (excluded from unit coverage); the screen test mocks it.
 */

import { useMemo } from 'react';
import { useAuth } from '@clerk/clerk-expo';
import { useApiClient } from '../lib/useApiClient';
import { API_BASE_URL } from '../lib/env';
import { createAssistantTransport } from './expoFetchTransport';
import { assistantAudioPlayer } from './nativeAssistantDeps';
import { useAssistantSession, type UseAssistantSession } from './useAssistantSession';

export function useAssistantController(): UseAssistantSession {
  const apiFetch = useApiClient();
  const { getToken } = useAuth();
  const transport = useMemo(
    () =>
      createAssistantTransport({
        apiFetch,
        // Reuse the exact `serviceos` JWT template so the API's RLS claims
        // populate identically to every other authed call; `forceRefresh`
        // bypasses Clerk's cache for the SSE 401 retry.
        getToken: (opts) =>
          getToken({ template: 'serviceos', skipCache: opts?.forceRefresh ?? false }),
        baseUrl: API_BASE_URL,
      }),
    [apiFetch, getToken],
  );
  return useAssistantSession({ transport, player: assistantAudioPlayer });
}
