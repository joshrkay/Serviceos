import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * P3-011 — Draft-message + scroll-position persistence.
 *
 * Keeps an in-progress message and the last scroll offset in localStorage,
 * keyed by conversation id. Survives accidental navigations and tab reloads
 * so dispatchers / technicians don't lose a half-typed intake when the
 * transcription retry endpoint (POST /api/voice/recordings/:id/retry)
 * bounces them off the page.
 */

const DRAFT_KEY = (conversationId: string) => `serviceos.draft.${conversationId}`;
const SCROLL_KEY = (conversationId: string) => `serviceos.scroll.${conversationId}`;

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function useConversationDraft(conversationId: string | undefined): {
  draft: string;
  setDraft: (value: string) => void;
  clearDraft: () => void;
} {
  const [draft, setDraftState] = useState('');
  const hydrated = useRef(false);

  useEffect(() => {
    const storage = safeLocalStorage();
    if (!storage || !conversationId) return;
    try {
      const saved = storage.getItem(DRAFT_KEY(conversationId));
      if (saved !== null) setDraftState(saved);
    } catch {
      // Ignore storage read failures — the draft just starts empty.
    }
    hydrated.current = true;
  }, [conversationId]);

  const setDraft = useCallback(
    (value: string) => {
      setDraftState(value);
      const storage = safeLocalStorage();
      if (!storage || !conversationId) return;
      try {
        if (value.length === 0) {
          storage.removeItem(DRAFT_KEY(conversationId));
        } else {
          storage.setItem(DRAFT_KEY(conversationId), value);
        }
      } catch {
        // Ignore storage write failures — best-effort persistence.
      }
    },
    [conversationId]
  );

  const clearDraft = useCallback(() => {
    setDraftState('');
    const storage = safeLocalStorage();
    if (!storage || !conversationId) return;
    try {
      storage.removeItem(DRAFT_KEY(conversationId));
    } catch {
      // Ignore storage clear failures.
    }
  }, [conversationId]);

  return { draft, setDraft, clearDraft };
}

export function useScrollRecovery(
  conversationId: string | undefined,
  containerRef: React.RefObject<HTMLElement>
): void {
  useEffect(() => {
    if (!conversationId) return;
    const storage = safeLocalStorage();
    if (!storage) return;

    const el = containerRef.current;
    if (!el) return;

    try {
      const raw = storage.getItem(SCROLL_KEY(conversationId));
      if (raw !== null) {
        const y = Number(raw);
        if (Number.isFinite(y)) el.scrollTop = y;
      }
    } catch {
      // Ignore storage read failures.
    }

    const handler = () => {
      try {
        storage.setItem(SCROLL_KEY(conversationId), String(el.scrollTop));
      } catch {
        // Ignore storage write failures.
      }
    };
    el.addEventListener('scroll', handler, { passive: true });
    return () => el.removeEventListener('scroll', handler);
  }, [conversationId, containerRef]);
}
