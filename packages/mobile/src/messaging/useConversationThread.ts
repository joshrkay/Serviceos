import { useCallback, useEffect, useRef, useState } from 'react';
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

/**
 * Loads a conversation's messages (GET /:id/messages → bare Message[]), with the
 * read-screen request-version de-dup + AbortError-as-non-error. Skipped when the
 * id is null (e.g. before a thread has been resolved).
 */
export function useConversationThread(conversationId: string | null): ThreadResult {
  const api = useApiClient();
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);

  const refetch = useCallback(async () => {
    if (!conversationId) {
      setIsLoading(false);
      return;
    }
    const myVersion = ++versionRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const res = await api(`/api/conversations/${conversationId}/messages`);
      if (myVersion !== versionRef.current) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ThreadMessage[];
      if (myVersion !== versionRef.current) return;
      setMessages(Array.isArray(body) ? body : []);
    } catch (err) {
      if (myVersion !== versionRef.current) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (myVersion === versionRef.current) setIsLoading(false);
    }
  }, [api, conversationId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { messages, isLoading, error, refetch };
}
