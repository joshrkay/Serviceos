/**
 * U13 — the real assistant transport: `expo/fetch` streaming for the SSE event
 * channel, and the shared auth-aware `apiFetch` for the POST/DELETE turns.
 *
 * The Clerk bearer token rides in the `Authorization` header on the SSE
 * connection (Expo SDK 52 ships `expo/fetch`, a WinterCG fetch with a streaming
 * response body — so no server change and no `?token=` query fallback, which
 * the server removed on purpose). SSE *parsing* stays in the pure sseParser
 * module, so a future swap to react-native-sse (plan-B) touches only this file.
 *
 * Degrade path: the synchronous `POST /:id/input` returns the full turn, so a
 * dropped stream loses only async pushes — the hook keeps working over sync
 * round-trips. This module contains the device-only streaming/multipart wiring
 * and is intentionally excluded from unit coverage (spike-verified on device);
 * its behavior is proven at the hook level through the injected fake transport.
 */

import { fetch as expoFetch } from 'expo/fetch';
import type { ApiFetch, TokenGetter } from '../lib/apiFetch';
import { createSseParser, type VoiceSessionMessage } from './sseParser';
import {
  AssistantAuthError,
  AssistantForbiddenError,
  type AssistantTransport,
  type EventStreamResult,
  type StartResult,
  type TranscribeResult,
  type TurnResult,
} from './useAssistantSession';

export interface AssistantTransportDeps {
  /** Auth-aware fetch (baseUrl + Clerk token + 401 refresh-retry) for POST/DELETE. */
  apiFetch: ApiFetch;
  /** Fresh Clerk token for the SSE connection; `forceRefresh` bypasses the cache. */
  getToken: TokenGetter;
  /** Absolute API base, e.g. https://api.example.com (no trailing slash). */
  baseUrl: string;
}

/** Rethrow apiFetch's terminal-401 (`UnauthorizedError`) as our typed auth error. */
function rethrowAuth(e: unknown): never {
  if ((e as Error)?.name === 'UnauthorizedError') throw new AssistantAuthError();
  throw e;
}

export function createAssistantTransport(deps: AssistantTransportDeps): AssistantTransport {
  const { apiFetch, getToken, baseUrl } = deps;

  const start: AssistantTransport['start'] = async (input) => {
    let res: Response;
    try {
      res = await apiFetch('/api/voice/sessions', {
        method: 'POST',
        body: JSON.stringify(input.conversationId ? { conversationId: input.conversationId } : {}),
      });
    } catch (e) {
      return rethrowAuth(e);
    }
    if (res.status === 403) throw new AssistantForbiddenError();
    if (!res.ok) throw new Error(`Assistant start failed: ${res.status}`);
    const body = (await res.json()) as StartResult;
    return {
      sessionId: body.sessionId,
      state: body.state,
      greetingText: body.greetingText,
      greetingAudio: body.greetingAudio,
    };
  };

  const sendInput: AssistantTransport['sendInput'] = async (sessionId, text) => {
    let res: Response;
    try {
      res = await apiFetch(`/api/voice/sessions/${sessionId}/input`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
    } catch (e) {
      return rethrowAuth(e);
    }
    if (res.status === 403) throw new AssistantForbiddenError();
    // 410 (ended, still present) and 404 (reaped/removed) both mean "start anew".
    if (res.status === 410 || res.status === 404) return { status: res.status };
    if (!res.ok) throw new Error(`Assistant input failed: ${res.status}`);
    const body = (await res.json()) as Omit<TurnResult, 'status'>;
    return { status: 200, ...body };
  };

  const transcribe: AssistantTransport['transcribe'] = async (fileUri: string) => {
    const form = new FormData();
    // RN FormData accepts a file descriptor object for multipart upload. The
    // recorder emits m4a (expo-audio HIGH_QUALITY); the server whitelists mp4.
    form.append('audio', {
      uri: fileUri,
      name: 'assistant-turn.m4a',
      type: 'audio/mp4',
    } as unknown as Blob);
    let res: Response;
    try {
      res = await apiFetch('/api/voice/transcribe', { method: 'POST', body: form as unknown as BodyInit });
    } catch (e) {
      return rethrowAuth(e);
    }
    if (res.status === 403) throw new AssistantForbiddenError();
    if (res.status === 501) return { notConfigured: true } as TranscribeResult;
    if (!res.ok) throw new Error(`Assistant transcribe failed: ${res.status}`);
    const body = (await res.json()) as { transcript?: string };
    return { transcript: (body.transcript ?? '').trim() };
  };

  const end: AssistantTransport['end'] = async (sessionId) => {
    try {
      await apiFetch(`/api/voice/sessions/${sessionId}`, { method: 'DELETE' });
    } catch {
      // best-effort teardown — the server reaps the session regardless
    }
  };

  const openEvents = async (
    sessionId: string,
    handlers: { onMessage: (m: VoiceSessionMessage) => void },
    signal: AbortSignal,
    opts?: { forceRefresh?: boolean },
  ): Promise<EventStreamResult> => {
    let token: string | null = null;
    try {
      token = await getToken({ forceRefresh: opts?.forceRefresh });
    } catch {
      token = null;
    }
    if (!token) return { status: 401 };

    let res: Awaited<ReturnType<typeof expoFetch>>;
    try {
      res = await expoFetch(`${baseUrl}/api/voice/sessions/${sessionId}/events`, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
        signal,
      });
    } catch {
      return { status: 0 }; // never connected (network error establishing)
    }
    if (res.status !== 200 || !res.body) return { status: res.status };

    const parser = createSseParser();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
          handlers.onMessage(msg);
        }
      }
    } catch {
      // A deliberate abort surfaces here too; the hook checks signal.aborted and
      // ignores the result, so reporting `dropped` is safe for the real-drop case.
      return { status: 200, dropped: true };
    }
    return { status: 200 };
  };

  return { start, sendInput, transcribe, end, openEvents };
}
