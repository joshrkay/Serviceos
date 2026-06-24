import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOnboardingVoice } from './useOnboardingVoice';

vi.mock('../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../utils/api-fetch';

describe('useOnboardingVoice', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('omits sessionId on first turn and retains it on the second', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessionId: 'sess-1',
          assistantMessage: 'Welcome',
          completed: false,
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessionId: 'sess-1',
          assistantMessage: 'Got it',
          completed: false,
        }),
      } as Response);

    const { result } = renderHook(() => useOnboardingVoice());

    await act(async () => {
      await result.current.sendTurn('Acme HVAC');
    });

    expect(apiFetch).toHaveBeenNthCalledWith(
      1,
      '/api/onboarding/conversation/turn',
      expect.objectContaining({
        body: JSON.stringify({ userMessage: 'Acme HVAC' }),
      }),
    );

    await act(async () => {
      await result.current.sendTurn('Residential installs');
    });

    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      '/api/onboarding/conversation/turn',
      expect.objectContaining({
        body: JSON.stringify({ sessionId: 'sess-1', userMessage: 'Residential installs' }),
      }),
    );
  });
});
