// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __emitAppState } from '../../test/stubs/react-native';
import type { ForegroundLocationSample } from './locationSamples';
import type { TechnicianLocationBatchInput } from '../api/technicianField';

const h = vi.hoisted(() => ({
  requestPermission: vi.fn(),
  watch: vi.fn(),
  remove: vi.fn(),
  nextId: vi.fn(),
  client: vi.fn(),
  onLocation: null as ((sample: ForegroundLocationSample) => void) | null,
}));

vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.client }));
vi.mock('./nativeLocationDeps', () => ({
  requestWhenInUsePermission: h.requestPermission,
  watchForegroundPosition: h.watch,
  createClientPingId: h.nextId,
}));

// eslint-disable-next-line import/first
import { useForegroundLocationTracker } from './useForegroundLocationTracker';

const SAMPLE: ForegroundLocationSample = {
  latitude: 37.775,
  longitude: -122.419,
  accuracy: 7,
  speed: null,
  heading: null,
  timestamp: Date.parse('2026-07-15T16:00:00.000Z'),
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  __emitAppState('active');
  h.onLocation = null;
  h.requestPermission.mockResolvedValue('granted');
  h.watch.mockImplementation(
    async (callback: (sample: ForegroundLocationSample) => void) => {
      h.onLocation = callback;
      return { remove: h.remove };
    },
  );
  h.nextId
    .mockReturnValueOnce('04b0afcd-bd09-4e9d-a671-b44d57dd617b')
    .mockReturnValueOnce('c43a76b0-fb83-4c1b-86cb-16d1c80552a2');
  h.client.mockResolvedValue(
    new Response(JSON.stringify({ count: 1, pings: [] }), { status: 201 }),
  );
});

afterEach(() => cleanup());

describe('useForegroundLocationTracker', () => {
  it('reports denied permission without blocking the mounted experience', async () => {
    h.requestPermission.mockResolvedValue('denied');
    const { result } = renderHook(() =>
      useForegroundLocationTracker({
        enabled: true,
        technicianId: '059f1a36-2d09-4698-954f-e640d61a9237',
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('denied'));
    expect(h.watch).not.toHaveBeenCalled();
  });

  it('retries a failed sample with its original clientPingId', async () => {
    h.client
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'temporary failure' }), {
          status: 503,
          statusText: 'Unavailable',
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ count: 2, pings: [] }), { status: 201 }),
      );
    const { result } = renderHook(() =>
      useForegroundLocationTracker({
        enabled: true,
        technicianId: '059f1a36-2d09-4698-954f-e640d61a9237',
        appointmentId: 'appointment-1',
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('tracking'));

    await act(async () => {
      h.onLocation?.(SAMPLE);
      await flush();
    });
    expect(result.current.status).toBe('error');

    await act(async () => {
      h.onLocation?.({ ...SAMPLE, timestamp: SAMPLE.timestamp + 30_000 });
      await flush();
    });

    expect(h.client).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(h.client.mock.calls[0]?.[1]?.body)) as TechnicianLocationBatchInput;
    const retry = JSON.parse(String(h.client.mock.calls[1]?.[1]?.body)) as TechnicianLocationBatchInput;
    expect(first.pings.map((ping) => ping.clientPingId)).toEqual([
      '04b0afcd-bd09-4e9d-a671-b44d57dd617b',
    ]);
    expect(retry.pings.map((ping) => ping.clientPingId)).toEqual([
      '04b0afcd-bd09-4e9d-a671-b44d57dd617b',
      'c43a76b0-fb83-4c1b-86cb-16d1c80552a2',
    ]);
    expect(result.current.status).toBe('tracking');
  });

  it('stops in the background and resumes only when foregrounded', async () => {
    const { result } = renderHook(() =>
      useForegroundLocationTracker({
        enabled: true,
        technicianId: '059f1a36-2d09-4698-954f-e640d61a9237',
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('tracking'));

    act(() => __emitAppState('inactive'));
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('paused');

    act(() => __emitAppState('active'));
    await waitFor(() => expect(h.watch).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe('tracking');
  });
});
