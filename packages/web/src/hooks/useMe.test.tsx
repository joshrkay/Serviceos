import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMe } from './useMe';

// Mock the underlying api functions so we can drive responses without
// hitting the network. The hook composes them via the useApiClient
// fetch shape; the global Clerk mock in test-setup.ts handles auth.
vi.mock('../api/me', async () => {
  const actual = await vi.importActual<typeof import('../api/me')>('../api/me');
  return {
    ...actual,
    fetchMe: vi.fn(),
    postModeSwitch: vi.fn(),
  };
});

import { fetchMe, postModeSwitch, type MeResponse } from '../api/me';

const sampleMe: MeResponse = {
  user_id: 'u-1',
  tenant_id: 't-1',
  role: 'owner',
  can_field_serve: true,
  current_mode: 'supervisor',
  mode_changed_at: null,
  permissions: ['settings:view', 'settings:update'],
  backup_supervisor_user_id: null,
  unsupervised_proposal_routing: 'queue_and_sms',
};

describe('P12-002 — useMe', () => {
  beforeEach(() => {
    vi.mocked(fetchMe).mockReset();
    vi.mocked(postModeSwitch).mockReset();
  });

  it('fetches /api/me on mount and exposes the response', async () => {
    vi.mocked(fetchMe).mockResolvedValue(sampleMe);
    const { result } = renderHook(() => useMe());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.me).toBeNull();

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.me).toEqual(sampleMe);
    expect(result.current.error).toBeNull();
    expect(fetchMe).toHaveBeenCalledTimes(1);
  });

  it('switchMode posts the new mode and refetches', async () => {
    vi.mocked(fetchMe)
      .mockResolvedValueOnce(sampleMe)
      .mockResolvedValueOnce({ ...sampleMe, current_mode: 'tech' });
    vi.mocked(postModeSwitch).mockResolvedValue();

    const { result } = renderHook(() => useMe());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.switchMode('tech');
    });

    expect(postModeSwitch).toHaveBeenCalledWith(expect.any(Function), 'tech');
    expect(fetchMe).toHaveBeenCalledTimes(2);
    expect(result.current.me?.current_mode).toBe('tech');
  });

  it('surfaces fetch errors via the error state', async () => {
    vi.mocked(fetchMe).mockRejectedValue(new Error('500 boom'));

    const { result } = renderHook(() => useMe());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.me).toBeNull();
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toContain('500 boom');
  });

  it('throws from switchMode if the server rejects (caller surfaces toast)', async () => {
    vi.mocked(fetchMe).mockResolvedValue(sampleMe);
    vi.mocked(postModeSwitch).mockRejectedValue(
      new Error('postModeSwitch (tech): 403 Forbidden — can_field_serve required'),
    );

    const { result } = renderHook(() => useMe());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(
      act(async () => {
        await result.current.switchMode('tech');
      }),
    ).rejects.toThrow(/403/);
  });
});
