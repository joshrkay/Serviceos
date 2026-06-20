import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useApiClient } from '../lib/useApiClient';

export interface InboxThread {
  conversation: {
    id: string;
    entityType?: string;
    entityId?: string;
    title?: string;
    status: string;
  };
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageDirection: 'inbound' | 'outbound';
  needsReply: boolean;
  messageCount: number;
  customerName?: string;
}

export interface ConversationsResult {
  threads: InboxThread[];
  /** Threads whose newest message is inbound — the owner owes a reply. */
  needsReplyCount: number;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

const DEFAULT_POLL_MS = 30_000;

/**
 * Polls GET /api/conversations for the comms inbox (customer + unmatched SMS
 * threads, newest first). Like usePendingProposals: pauses when backgrounded
 * (AppState) and one-shot-refreshes on foreground; a monotonic request version
 * drops superseded responses and an AbortError (sign-out) is not an error.
 */
export function useConversations(
  options: { enabled?: boolean; pollIntervalMs?: number } = {},
): ConversationsResult {
  const { enabled = true, pollIntervalMs = DEFAULT_POLL_MS } = options;
  const api = useApiClient();
  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  const refetch = useCallback(async () => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    const myVersion = ++versionRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiRef.current('/api/conversations');
      if (myVersion !== versionRef.current) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { threads?: InboxThread[] };
      if (myVersion !== versionRef.current) return;
      setThreads(Array.isArray(body.threads) ? body.threads : []);
    } catch (err) {
      if (myVersion !== versionRef.current) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (myVersion === versionRef.current) setIsLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, refetch, pollIntervalMs]);

  return {
    threads,
    needsReplyCount: threads.filter((t) => t.needsReply).length,
    isLoading,
    error,
    refetch,
  };
}
