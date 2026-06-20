import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useApiClient } from '../lib/useApiClient';

export interface ThreadMessage {
  id: string;
  conversationId: string;
  messageType: string;
  content?: string;
  senderId: string;
  senderRole: string;
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ThreadResult {
  messages: ThreadMessage[];
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

const DEFAULT_POLL_MS = 15_000;

/**
 * Loads a conversation's messages (GET /:id/messages → bare Message[]) and polls
 * while foregrounded so an inbound customer reply appears without the owner
 * leaving the screen. Mirrors useConversations: AppState pause/resume, a
 * request-version guard that drops superseded responses, AbortError-as-non-error,
 * and a first-load-only loading flag so polls don't flash a spinner. Skipped when
 * the id is null.
 */
export function useConversationThread(
  conversationId: string | null,
  options: { pollIntervalMs?: number } = {},
): ThreadResult {
  const { pollIntervalMs = DEFAULT_POLL_MS } = options;
  const api = useApiClient();
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);
  const hasLoadedRef = useRef(false);
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  // Reset the first-load flag when the thread changes so the new thread shows
  // its initial spinner.
  useEffect(() => {
    hasLoadedRef.current = false;
  }, [conversationId]);

  const refetch = useCallback(async () => {
    if (!conversationId) {
      setIsLoading(false);
      return;
    }
    const myVersion = ++versionRef.current;
    if (!hasLoadedRef.current) setIsLoading(true);
    setError(null);
    try {
      const res = await apiRef.current(`/api/conversations/${conversationId}/messages`);
      if (myVersion !== versionRef.current) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ThreadMessage[];
      if (myVersion !== versionRef.current) return;
      setMessages(Array.isArray(body) ? body : []);
      hasLoadedRef.current = true;
    } catch (err) {
      if (myVersion !== versionRef.current) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (myVersion === versionRef.current) setIsLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (intervalId === null) intervalId = setInterval(() => void refetch(), pollIntervalMs);
    };
    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
    void refetch();
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refetch();
        start();
      } else {
        stop();
      }
    });
    return () => {
      stop();
      sub.remove();
    };
  }, [conversationId, refetch, pollIntervalMs]);

  return { messages, isLoading, error, refetch };
}
