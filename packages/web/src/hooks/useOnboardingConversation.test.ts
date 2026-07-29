import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../lib/apiClient', () => ({ useApiClient: () => apiFetchMock }));

import { useOnboardingConversation } from './useOnboardingConversation';

const TENANT = 'tenant-conv-1';

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
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
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
      expect.objectContaining({ body: JSON.stringify({ sessionId: 'sess-3' }) }),
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
      expect.objectContaining({ body: JSON.stringify({ sessionId: 'sess-other' }) }),
    );
    // …and that tenant's stored session survived.
    expect(
      window.localStorage.getItem(`serviceos.onboarding_conversation.session.${OTHER}`),
    ).not.toBeNull();
  });
});
