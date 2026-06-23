import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const apiFetchMock = vi.fn();
vi.mock('../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { useOnboardingVoice } from './useOnboardingVoice';

function jsonOk(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe('useOnboardingVoice', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('omits sessionId on the first turn and retains the server-issued id for the next', async () => {
    apiFetchMock
      .mockResolvedValueOnce(
        jsonOk({ sessionId: 's-1', assistantMessage: 'Hi! Tell me about your business.', state: 'collect', completed: false }),
      )
      .mockResolvedValueOnce(
        jsonOk({ sessionId: 's-1', assistantMessage: 'Got it — HVAC.', state: 'collect', completed: false }),
      );

    const { result } = renderHook(() => useOnboardingVoice());

    await act(async () => {
      await result.current.sendTurn('My business is Acme');
    });
    expect(result.current.sessionId).toBe('s-1');
    expect(result.current.lastAssistantMessage).toContain('Tell me about your business');
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/onboarding/conversation/turn');
    expect(bodyOf(apiFetchMock.mock.calls[0]).sessionId).toBeUndefined();
    expect(bodyOf(apiFetchMock.mock.calls[0]).userMessage).toBe('My business is Acme');

    await act(async () => {
      await result.current.sendTurn('We do HVAC');
    });
    expect(bodyOf(apiFetchMock.mock.calls[1]).sessionId).toBe('s-1'); // retained
  });

  it('stops dispatching once the FSM reports completed (terminal)', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonOk({ sessionId: 's-1', assistantMessage: 'All set!', state: 'completed', completed: true }),
    );
    const { result } = renderHook(() => useOnboardingVoice());

    await act(async () => {
      await result.current.sendTurn('last answer');
    });
    expect(result.current.completed).toBe(true);

    let ret: unknown;
    await act(async () => {
      ret = await result.current.sendTurn('another');
    });
    expect(ret).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledTimes(1); // no second network call
  });

  it('surfaces an error and returns null on a non-ok response', async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response);
    const { result } = renderHook(() => useOnboardingVoice());

    let ret: unknown;
    await act(async () => {
      ret = await result.current.sendTurn('hi');
    });
    expect(ret).toBeNull();
    expect(result.current.error).toBeTruthy();
  });

  it('ignores an empty utterance without a network call', async () => {
    const { result } = renderHook(() => useOnboardingVoice());
    await act(async () => {
      await result.current.sendTurn('   ');
    });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
