import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../lib/apiClient', () => ({ useApiClient: () => apiFetchMock }));

import { useOnboardingConversation } from './useOnboardingConversation';

const TENANT = 'tenant-conv-1';

// The zone the browser reports in this environment. The hook must SEND it —
// the server gates onboarding when no usable zone arrives, and must never
// default one (a wrong zone silently misbooks; migration 263).
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('useOnboardingConversation — B1.19 AC-1/AC-2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('starts a new session on first mount and stores the opening prompt', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-1',
        assistantMessage: "Hi! Tell me about your business.",
        state: 'profile_capture',
        turnCount: 0,
        completed: false,
        proposalIds: [],
      }),
    );

    const { result } = renderHook(() => useOnboardingConversation(TENANT));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/onboarding/conversation/turn',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ clientTimezone: BROWSER_TZ }),
      }),
    );
    expect(result.current.history).toEqual([
      { role: 'assistant', text: "Hi! Tell me about your business.", at: expect.any(String) },
    ]);
    expect(result.current.state).toBe('profile_capture');
    expect(window.localStorage.getItem('serviceos.onboarding_conversation.session.' + TENANT)).toBe(
      'sess-1',
    );
  });

  it('sends a user turn and appends both the user and assistant messages', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-2',
        assistantMessage: 'Opening prompt',
        state: 'profile_capture',
        turnCount: 0,
        completed: false,
        proposalIds: [],
      }),
    );
    const { result } = renderHook(() => useOnboardingConversation(TENANT));
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-2',
        assistantMessage: 'What kind of work do you do?',
        state: 'category_capture',
        turnCount: 1,
        completed: false,
        proposalIds: [],
      }),
    );

    await act(async () => {
      await result.current.sendMessage('Acme HVAC in Austin');
    });

    expect(result.current.history.map((t) => t.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(result.current.history[1]).toMatchObject({ role: 'user', text: 'Acme HVAC in Austin' });
    expect(result.current.state).toBe('category_capture');

    const turnCall = apiFetchMock.mock.calls[1];
    expect(JSON.parse((turnCall[1] as RequestInit).body as string)).toEqual({
      sessionId: 'sess-2',
      userMessage: 'Acme HVAC in Austin',
      clientTimezone: BROWSER_TZ,
    });
  });

  it('resumes a persisted session on remount without duplicating the replayed assistant message', async () => {
    window.localStorage.setItem('serviceos.onboarding_conversation.session.' + TENANT, 'sess-3');
    window.localStorage.setItem(
      'serviceos.onboarding_conversation.history.' + TENANT,
      JSON.stringify([
        { role: 'assistant', text: 'Opening prompt', at: '2026-01-01T00:00:00.000Z' },
        { role: 'user', text: 'Acme HVAC', at: '2026-01-01T00:00:01.000Z' },
        { role: 'assistant', text: 'What services do you offer?', at: '2026-01-01T00:00:02.000Z' },
      ]),
    );

    // Resume call replays the last assistant message (server behavior on a
    // sessionId-only, no-userMessage turn) without advancing state.
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-3',
        assistantMessage: 'What services do you offer?',
        state: 'category_capture',
        turnCount: 2,
        completed: false,
        proposalIds: [],
      }),
    );

    const { result } = renderHook(() => useOnboardingConversation(TENANT));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/onboarding/conversation/turn',
      expect.objectContaining({
        body: JSON.stringify({ sessionId: 'sess-3', clientTimezone: BROWSER_TZ }),
      }),
    );
    // Still exactly 3 turns — the replayed message matched the tail of the
    // locally-persisted history, so it was not appended again.
    expect(result.current.history).toHaveLength(3);
    expect(result.current.state).toBe('category_capture');
    expect(result.current.turnCount).toBe(2);
  });

  it('starts a fresh session when the persisted one 404s (cross-tenant / expired)', async () => {
    window.localStorage.setItem('serviceos.onboarding_conversation.session.' + TENANT, 'stale-session');
    window.localStorage.setItem(
      'serviceos.onboarding_conversation.history.' + TENANT,
      JSON.stringify([{ role: 'assistant', text: 'stale', at: '2026-01-01T00:00:00.000Z' }]),
    );

    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(404, { error: 'ONBOARDING_SESSION_NOT_FOUND' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          sessionId: 'sess-fresh',
          assistantMessage: 'Fresh opening prompt',
          state: 'profile_capture',
          turnCount: 0,
          completed: false,
          proposalIds: [],
        }),
      );

    const { result } = renderHook(() => useOnboardingConversation(TENANT));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.history).toEqual([
      { role: 'assistant', text: 'Fresh opening prompt', at: expect.any(String) },
    ]);
    expect(window.localStorage.getItem('serviceos.onboarding_conversation.session.' + TENANT)).toBe(
      'sess-fresh',
    );
  });

  it('surfaces completed + proposalIds once the FSM reaches a terminal state', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-4',
        assistantMessage: 'Opening prompt',
        state: 'schedule_capture',
        turnCount: 5,
        completed: false,
        proposalIds: [],
      }),
    );
    const { result } = renderHook(() => useOnboardingConversation(TENANT));
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-4',
        assistantMessage: "Done. Your setup proposals are in the inbox.",
        state: 'completed',
        turnCount: 6,
        completed: true,
        proposalIds: ['prop-1', 'prop-2'],
      }),
    );

    await act(async () => {
      await result.current.sendMessage('looks good');
    });

    expect(result.current.completed).toBe(true);
    expect(result.current.proposalIds).toEqual(['prop-1', 'prop-2']);
  });

  // Regression: the session ref and history state initialize once at mount, so
  // a tenant switch while this hook stays mounted used to bootstrap with the
  // PREVIOUS tenant's session id. That took the expected 404, and the recovery
  // path then cleared the NEW tenant's perfectly valid stored session.
  it('re-seeds from the new tenant’s storage when tenantId changes', async () => {
    const OTHER = 'tenant-conv-2';
    window.localStorage.setItem(
      `serviceos.onboarding_conversation.session.${OTHER}`,
      'sess-other',
    );
    window.localStorage.setItem(
      `serviceos.onboarding_conversation.history.${OTHER}`,
      JSON.stringify([{ role: 'assistant', text: 'welcome back' }]),
    );

    apiFetchMock.mockResolvedValue(
      jsonResponse(200, {
        sessionId: 'sess-1',
        assistantMessage: 'Hi!',
        state: 'profile_capture',
        turnCount: 0,
        completed: false,
        proposalIds: [],
      }),
    );

    const { result, rerender } = renderHook(
      ({ tenant }) => useOnboardingConversation(tenant),
      { initialProps: { tenant: TENANT } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiFetchMock.mockClear();
    rerender({ tenant: OTHER });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Bootstrapped with the NEW tenant's stored session, not the old one…
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/onboarding/conversation/turn',
      expect.objectContaining({
        body: JSON.stringify({ sessionId: 'sess-other', clientTimezone: BROWSER_TZ }),
      }),
    );
    // …and that tenant's stored session survived.
    expect(
      window.localStorage.getItem(`serviceos.onboarding_conversation.session.${OTHER}`),
    ).not.toBeNull();
  });

  // Regression: the composer is disabled by `sending`, never by `loading`, so
  // a turn could be submitted while the bootstrap round-trip was still in
  // flight. `sessionIdRef.current` was still null at that point, so the route
  // created a SECOND independent session; whichever response landed last won
  // sessionIdRef, losing the first answer or splicing two sessions' turns into
  // one transcript. `queueRef` serialized submitted turns against each other
  // but not against the bootstrap.
  it('queues a turn submitted during bootstrap behind it — exactly one session, turn not lost', async () => {
    let resolveBootstrap!: (value: unknown) => void;
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBootstrap = resolve;
        }),
    );
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-boot',
        assistantMessage: 'Got it — what services do you offer?',
        state: 'category_capture',
        turnCount: 1,
        completed: false,
        proposalIds: [],
      }),
    );

    const { result } = renderHook(() => useOnboardingConversation(TENANT));
    expect(result.current.loading).toBe(true);

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage('Acme HVAC in Austin');
    });

    // Flush microtasks WITHOUT resolving the bootstrap. Nothing may have gone
    // out yet — the turn has to wait for the session the bootstrap creates.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveBootstrap(
        jsonResponse(200, {
          sessionId: 'sess-boot',
          assistantMessage: 'Hi! Tell me about your business.',
          state: 'profile_capture',
          turnCount: 0,
          completed: false,
          proposalIds: [],
        }),
      );
      await sendPromise;
    });

    // Exactly two requests: the bootstrap, then the queued turn — no second
    // session was created.
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((apiFetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      sessionId: 'sess-boot',
      userMessage: 'Acme HVAC in Austin',
      clientTimezone: BROWSER_TZ,
    });
    // The owner's answer survived, in order, and its reply landed.
    expect(result.current.history.map((t) => t.text)).toEqual([
      'Hi! Tell me about your business.',
      'Acme HVAC in Austin',
      'Got it — what services do you offer?',
    ]);
    expect(window.localStorage.getItem('serviceos.onboarding_conversation.session.' + TENANT)).toBe(
      'sess-boot',
    );
    expect(result.current.state).toBe('category_capture');
  });

  // Regression: the generation guard in sendMessage's `finally` used to also
  // gate setSending(false), so a response arriving after a tenant switch left
  // `sending` stuck true and the composer disabled for the rest of the session.
  it('clears sending after a tenant switch mid-send, while still discarding the stale response', async () => {
    const OTHER = 'tenant-conv-3';

    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-a',
        assistantMessage: 'Opening prompt A',
        state: 'profile_capture',
        turnCount: 0,
        completed: false,
        proposalIds: [],
      }),
    );

    const { result, rerender } = renderHook(
      ({ tenant }) => useOnboardingConversation(tenant),
      { initialProps: { tenant: TENANT } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    let resolveSend!: (value: unknown) => void;
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage('hello from tenant A');
    });
    await waitFor(() => expect(result.current.sending).toBe(true));

    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-b',
        assistantMessage: 'Opening prompt B',
        state: 'profile_capture',
        turnCount: 0,
        completed: false,
        proposalIds: [],
      }),
    );

    rerender({ tenant: OTHER });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The tenant-A response finally arrives after the switch.
    await act(async () => {
      resolveSend(
        jsonResponse(200, {
          sessionId: 'sess-a-stale',
          assistantMessage: 'stale reply for tenant A',
          state: 'category_capture',
          turnCount: 1,
          completed: false,
          proposalIds: [],
        }),
      );
      await sendPromise;
    });

    // The composer is re-enabled…
    expect(result.current.sending).toBe(false);
    // …but the stale tenant-A response never got applied to tenant B's state.
    expect(result.current.history).toEqual([
      { role: 'assistant', text: 'Opening prompt B', at: expect.any(String) },
    ]);
  });

  // P2 fix: completed/state/turnCount/proposalIds are only ever (re)assigned
  // from a successful response, so if tenant A reached the terminal state and
  // tenant B's bootstrap then fails, B must not render A's completion panel.
  it('clears completed/state/turnCount/proposalIds on tenant switch, even when the new tenant bootstrap fails', async () => {
    const OTHER = 'tenant-conv-4';

    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-a',
        assistantMessage: 'Opening prompt A',
        state: 'schedule_capture',
        turnCount: 5,
        completed: false,
        proposalIds: [],
      }),
    );

    const { result, rerender } = renderHook(
      ({ tenant }) => useOnboardingConversation(tenant),
      { initialProps: { tenant: TENANT } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-a',
        assistantMessage: 'Done. Your setup proposals are in the inbox.',
        state: 'completed',
        turnCount: 6,
        completed: true,
        proposalIds: ['prop-1', 'prop-2'],
      }),
    );
    await act(async () => {
      await result.current.sendMessage('looks good');
    });

    expect(result.current.completed).toBe(true);
    expect(result.current.state).toBe('completed');
    expect(result.current.turnCount).toBe(6);
    expect(result.current.proposalIds).toEqual(['prop-1', 'prop-2']);

    // Tenant B's bootstrap fails outright.
    apiFetchMock.mockRejectedValueOnce(new Error('network down'));

    rerender({ tenant: OTHER });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Tenant B is not stuck showing tenant A's terminal UI…
    expect(result.current.completed).toBe(false);
    expect(result.current.state).toBeNull();
    expect(result.current.turnCount).toBe(0);
    expect(result.current.proposalIds).toEqual([]);
    // …and the error surfaced instead of silently keeping A's state.
    expect(result.current.error).not.toBeNull();
  });

  // Control: a successful switch still loads tenant B's own session/state
  // cleanly (not just "not A's state" — actually B's).
  it('on a successful tenant switch, loads the new tenant’s own session and state', async () => {
    const OTHER = 'tenant-conv-5';

    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-a',
        assistantMessage: 'Done. Your setup proposals are in the inbox.',
        state: 'completed',
        turnCount: 6,
        completed: true,
        proposalIds: ['prop-1', 'prop-2'],
      }),
    );

    const { result, rerender } = renderHook(
      ({ tenant }) => useOnboardingConversation(tenant),
      { initialProps: { tenant: TENANT } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.completed).toBe(true);

    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-other',
        assistantMessage: 'Hi! Tell me about your business.',
        state: 'profile_capture',
        turnCount: 0,
        completed: false,
        proposalIds: [],
      }),
    );

    rerender({ tenant: OTHER });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.completed).toBe(false);
    expect(result.current.state).toBe('profile_capture');
    expect(result.current.turnCount).toBe(0);
    expect(result.current.proposalIds).toEqual([]);
    expect(result.current.history).toEqual([
      { role: 'assistant', text: 'Hi! Tell me about your business.', at: expect.any(String) },
    ]);
    expect(
      window.localStorage.getItem(`serviceos.onboarding_conversation.session.${OTHER}`),
    ).toBe('sess-other');
  });
});
