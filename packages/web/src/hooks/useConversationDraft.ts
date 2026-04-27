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
    if (!conversationId) {
      // No conversation in view — clear so a previously-hydrated draft
      // doesn't leak into an unrelated screen.
      setDraftState('');
      return;
    }
    const storage = safeLocalStorage();
    if (!storage) {
      // Storage unavailable — fall back to an empty draft.
      setDraftState('');
      return;
    }
    try {
      const saved = storage.getItem(DRAFT_KEY(conversationId));
      // Always reset state on conversationId change: restore a saved value
      // when one exists, otherwise clear so the previous conversation's
      // in-memory draft doesn't persist into the new thread.
      setDraftState(saved ?? '');
    } catch {
      setDraftState('');
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

    // Throttle localStorage writes to one per animation frame. A naive
    // scroll handler fires 60+ times per second on trackpads and causes
    // measurable main-thread jank on mobile. requestAnimationFrame
    // coalesces the bursts without needing a debounce timer.
    const hasRaf = typeof requestAnimationFrame === 'function';
    let pendingFrame: number | null = null;

    const writeNow = () => {
      try {
        storage.setItem(SCROLL_KEY(conversationId), String(el.scrollTop));
      } catch {
        // Ignore storage write failures.
      }
    };

    const handler = () => {
      if (!hasRaf) {
        writeNow();
        return;
      }
      if (pendingFrame !== null) return;
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null;
        writeNow();
      });
    };

    el.addEventListener('scroll', handler, { passive: true });
    return () => {
      el.removeEventListener('scroll', handler);
      if (pendingFrame !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(pendingFrame);
      }
    };
  }, [conversationId, containerRef]);
}
