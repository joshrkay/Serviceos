import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '../lib/apiClient';
import type {
  OnboardingConversationTranscriptTurn,
  OnboardingConversationTurnResponse,
} from '../types/onboarding';

/**
 * B1.19 AC-1/AC-2 — drives POST /api/onboarding/conversation/turn and keeps
 * the conversation resumable across a page refresh.
 *
 * The session id is client-managed (the route creates one when omitted and
 * hands it back), so this hook persists it in localStorage keyed by tenant
 * and restores it on mount. The turn response itself only ever carries the
 * SINGLE latest assistant message — no history array — so the running
 * transcript shown in the UI is built and persisted client-side, keyed by
 * session id, and reconciled against the server's replayed "last assistant
 * message" on resume (skipped when it already matches the tail of the local
 * history, so a refresh doesn't duplicate the last bubble).
 *
 * Storage is best-effort: any read/write failure (private browsing, quota)
 * degrades to an in-memory-only session rather than throwing.
 */

const SESSION_KEY = (tenantId: string) => `serviceos.onboarding_conversation.session.${tenantId}`;
const HISTORY_KEY = (tenantId: string) => `serviceos.onboarding_conversation.history.${tenantId}`;

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readSessionId(tenantId: string): string | null {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    return storage.getItem(SESSION_KEY(tenantId));
  } catch {
    return null;
  }
}

function readHistory(tenantId: string): OnboardingConversationTranscriptTurn[] {
  const storage = safeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(HISTORY_KEY(tenantId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is OnboardingConversationTranscriptTurn =>
        !!t && typeof t === 'object' && (t as { role?: unknown }).role !== undefined,
    );
  } catch {
    return [];
  }
}

function writeSession(tenantId: string, sessionId: string): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(SESSION_KEY(tenantId), sessionId);
  } catch {
    // Best-effort — a lost session id just means the next mount starts fresh.
  }
}

function writeHistory(tenantId: string, history: OnboardingConversationTranscriptTurn[]): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(HISTORY_KEY(tenantId), JSON.stringify(history));
  } catch {
    // Best-effort — same as above.
  }
}

function clearSession(tenantId: string): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.removeItem(SESSION_KEY(tenantId));
    storage.removeItem(HISTORY_KEY(tenantId));
  } catch {
    // Best-effort.
  }
}

export interface UseOnboardingConversationResult {
  /** Full running transcript, oldest first. */
  history: OnboardingConversationTranscriptTurn[];
  /** Current FSM state name, or null before the first turn resolves. */
  state: string | null;
  completed: boolean;
  turnCount: number;
  proposalIds: string[];
  /** True only while the session is bootstrapping (mount / resume). */
  loading: boolean;
  /** True while a user-submitted turn is in flight. */
  sending: boolean;
  error: string | null;
  sendMessage: (text: string) => Promise<void>;
}

export function useOnboardingConversation(tenantId: string): UseOnboardingConversationResult {
  const apiFetch = useApiClient();

  const [history, setHistory] = useState<OnboardingConversationTranscriptTurn[]>(() =>
    readHistory(tenantId),
  );
  const [state, setState] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [turnCount, setTurnCount] = useState(0);
  const [proposalIds, setProposalIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionIdRef = useRef<string | null>(readSessionId(tenantId));
  // The tenant this hook is currently bound to, readable from inside
  // already-scheduled async work (a captured `tenantId` would be stale).
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;
  // Sequential lock so overlapping submissions (e.g. mic auto-submit firing
  // while a prior turn is still in flight) apply in order instead of racing
  // on sessionIdRef / history.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const appendTurn = useCallback(
    (turn: OnboardingConversationTranscriptTurn) => {
      setHistory((prev) => {
        const next = [...prev, turn];
        writeHistory(tenantId, next);
        return next;
      });
    },
    [tenantId],
  );

  const applyResponse = useCallback(
    (body: OnboardingConversationTurnResponse, opts: { skipIfDuplicateAssistant?: boolean } = {}) => {
      sessionIdRef.current = body.sessionId;
      writeSession(tenantId, body.sessionId);
      setState(body.state);
      setCompleted(body.completed);
      setTurnCount(body.turnCount);
      setProposalIds(body.proposalIds);
      if (body.assistantMessage) {
        setHistory((prev) => {
          const last = prev[prev.length - 1];
          if (
            opts.skipIfDuplicateAssistant &&
            last?.role === 'assistant' &&
            last.text === body.assistantMessage
          ) {
            return prev;
          }
          const next: OnboardingConversationTranscriptTurn[] = [
            ...prev,
            { role: 'assistant', text: body.assistantMessage, at: new Date().toISOString() },
          ];
          writeHistory(tenantId, next);
          return next;
        });
      }
    },
    [tenantId],
  );

  // Bootstrap: resume the persisted session, or start a new one.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    // Re-seed from THIS tenant's storage keys before bootstrapping. The ref
    // and the history state are initialized once at mount, so on a tenant
    // switch while this route stays mounted they still hold the previous
    // tenant's values: we would submit the old session under the new tenant,
    // take the expected 404, and the recovery below would then clear the NEW
    // tenant's perfectly valid stored session — while the old tenant's
    // transcript rendered during the transition.
    sessionIdRef.current = readSessionId(tenantId);
    setHistory(readHistory(tenantId));

    (async () => {
      try {
        const existingSessionId = sessionIdRef.current;
        const res = await apiFetch('/api/onboarding/conversation/turn', {
          method: 'POST',
          body: JSON.stringify(existingSessionId ? { sessionId: existingSessionId } : {}),
        });

        if (res.status === 404) {
          // Stale/cross-tenant session id — the route reports "not found"
          // rather than leak existence across tenants. Drop local state and
          // start a brand-new session instead of getting stuck.
          clearSession(tenantId);
          sessionIdRef.current = null;
          setHistory([]);
          const retry = await apiFetch('/api/onboarding/conversation/turn', {
            method: 'POST',
            body: JSON.stringify({}),
          });
          if (!retry.ok) throw new Error(`HTTP ${retry.status}`);
          const body = (await retry.json()) as OnboardingConversationTurnResponse;
          if (!cancelled) applyResponse(body);
          return;
        }

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as OnboardingConversationTurnResponse;
        if (!cancelled) {
          // On resume the server replays the last assistant message without
          // advancing state; local history already has it from the prior
          // session (persisted per turn), so skip the duplicate append.
          applyResponse(body, { skipIfDuplicateAssistant: !!existingSessionId });
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not reach the assistant.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally re-runs only when the tenant changes — the session id
    // lives in a ref, not state, so it doesn't retrigger the bootstrap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const sendMessage = useCallback(
    (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed) return Promise.resolve();

      // Tenant generation captured at submit time. The bootstrap effect has a
      // `cancelled` flag, but a turn already in flight had none: switching
      // tenants mid-request let the old response apply to the NEW tenant —
      // overwriting its visible history and resetting the shared sessionIdRef
      // to the previous tenant's session, so the next turn 404'd and the
      // recovery cleared the new tenant's stored session.
      const submittedForTenant = tenantId;

      const run = async () => {
        if (submittedForTenant !== tenantIdRef.current) return;
        appendTurn({ role: 'user', text: trimmed, at: new Date().toISOString() });
        setSending(true);
        setError(null);
        try {
          const res = await apiFetch('/api/onboarding/conversation/turn', {
            method: 'POST',
            body: JSON.stringify({
              sessionId: sessionIdRef.current ?? undefined,
              userMessage: trimmed,
            }),
          });
          // The tenant may have changed while this was in flight; anything
          // below would write the wrong tenant's state.
          if (submittedForTenant !== tenantIdRef.current) return;
          if (res.status === 404) {
            // The persisted session vanished server-side mid-conversation
            // (rare — e.g. it was manually purged). Surface it plainly
            // rather than silently starting over and losing the user's
            // in-flight answer.
            clearSession(submittedForTenant);
            sessionIdRef.current = null;
            setError('This conversation session has expired. Refresh to start a new one.');
            return;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as OnboardingConversationTurnResponse;
          applyResponse(body);
        } catch (err) {
          if (submittedForTenant !== tenantIdRef.current) return;
          setError(err instanceof Error ? err.message : 'Could not reach the assistant.');
        } finally {
          if (submittedForTenant === tenantIdRef.current) setSending(false);
        }
      };

      const next = queueRef.current.then(run, run);
      queueRef.current = next;
      return next;
    },
    [apiFetch, appendTurn, applyResponse, tenantId],
  );

  return { history, state, completed, turnCount, proposalIds, loading, sending, error, sendMessage };
}
