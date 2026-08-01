// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  api: vi.fn(),
  push: vi.fn(),
  getCallbackNumber: vi.fn(),
}));

vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: h.push, back: vi.fn(), replace: vi.fn() }) }));
vi.mock('./callbackStorage', () => ({ getCallbackNumber: h.getCallbackNumber }));

// eslint-disable-next-line import/first
import { useStartCall } from './useStartCall';

beforeEach(() => {
  vi.clearAllMocks();
  h.getCallbackNumber.mockResolvedValue('+15559990000');
  h.api.mockResolvedValue({ ok: true, status: 201, json: async () => ({ callSid: 'CA1' }) });
});
afterEach(() => cleanup());

describe('useStartCall', () => {
  it('POSTs /api/calls with the customer id and the stored callback number', async () => {
    const { result } = renderHook(() => useStartCall());
    await act(async () => {
      await result.current.startCall('cust-1');
    });
    expect(h.api).toHaveBeenCalledWith('/api/calls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: 'cust-1', agentPhone: '+15559990000' }),
    });
    expect(result.current.error).toBeNull();
  });

  it('routes to Settings (and does not call) when no callback number is saved', async () => {
    h.getCallbackNumber.mockResolvedValue(null);
    const { result } = renderHook(() => useStartCall());
    await act(async () => {
      await result.current.startCall('cust-1');
    });
    expect(h.api).not.toHaveBeenCalled();
    expect(h.push).toHaveBeenCalledWith('/settings');
    expect(result.current.error).toMatch(/callback number in Settings/i);
  });

  it('maps a 403 (DNC) to friendly copy', async () => {
    h.api.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const { result } = renderHook(() => useStartCall());
    await act(async () => {
      await result.current.startCall('cust-1');
    });
    await waitFor(() => expect(result.current.error).toMatch(/opted out/i));
  });

  it('maps a 503 (not configured) to friendly copy', async () => {
    h.api.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const { result } = renderHook(() => useStartCall());
    await act(async () => {
      await result.current.startCall('cust-1');
    });
    await waitFor(() => expect(result.current.error).toMatch(/not set up/i));
  });
});
