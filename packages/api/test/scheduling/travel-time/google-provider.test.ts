import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleDistanceMatrixProvider } from '../../../src/scheduling/travel-time/google-provider';
import { HaversineFallbackProvider } from '../../../src/scheduling/travel-time/haversine-fallback';

const origin = { latitude: 37.7749, longitude: -122.4194 };
const destination = { latitude: 37.8044, longitude: -122.2712 };

function googleOk(seconds: number) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      status: 'OK',
      rows: [{ elements: [{ status: 'OK', duration: { value: seconds } }] }],
    }),
  } as unknown as Response;
}

describe('GoogleDistanceMatrixProvider', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns google-sourced seconds on the happy path', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(googleOk(1234));
    const provider = new GoogleDistanceMatrixProvider({
      apiKey: 'k', fetch: fetchSpy, fallback: new HaversineFallbackProvider(),
    });
    const r = await provider.estimateDriveTime(origin, destination, new Date('2026-05-17T09:00:00Z'));
    expect(r.source).toBe('google');
    expect(r.seconds).toBe(1234);
    expect(r.degraded).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('serves a cache hit without calling fetch a second time (same departAt bucket)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(googleOk(900));
    const provider = new GoogleDistanceMatrixProvider({
      apiKey: 'k', fetch: fetchSpy, fallback: new HaversineFallbackProvider(),
    });
    const depart = new Date('2026-05-17T09:03:00Z'); // 15-min bucket = 09:00
    const departSameBucket = new Date('2026-05-17T09:14:00Z');
    await provider.estimateDriveTime(origin, destination, depart);
    await provider.estimateDriveTime(origin, destination, departSameBucket);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT serve a cache hit across departAt buckets (traffic-aware)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(googleOk(900));
    const provider = new GoogleDistanceMatrixProvider({
      apiKey: 'k', fetch: fetchSpy, fallback: new HaversineFallbackProvider(),
    });
    await provider.estimateDriveTime(origin, destination, new Date('2026-05-17T09:00:00Z'));
    await provider.estimateDriveTime(origin, destination, new Date('2026-05-17T17:00:00Z'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to haversine with degraded:true when Google throws', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network'));
    const provider = new GoogleDistanceMatrixProvider({
      apiKey: 'k', fetch: fetchSpy, fallback: new HaversineFallbackProvider(),
    });
    const r = await provider.estimateDriveTime(origin, destination);
    expect(r.source).toBe('haversine');
    expect(r.degraded).toBe(true);
    expect(Number.isFinite(r.seconds)).toBe(true);
  });

  it('falls back to haversine with degraded:true when Google returns non-OK row', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        status: 'OK', rows: [{ elements: [{ status: 'ZERO_RESULTS' }] }],
      }),
    } as unknown as Response);
    const provider = new GoogleDistanceMatrixProvider({
      apiKey: 'k', fetch: fetchSpy, fallback: new HaversineFallbackProvider(),
    });
    const r = await provider.estimateDriveTime(origin, destination);
    expect(r.source).toBe('haversine');
    expect(r.degraded).toBe(true);
  });

  it('never logs the API key on failure', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = new GoogleDistanceMatrixProvider({
      apiKey: 'SECRET-XYZ', fetch: fetchSpy, fallback: new HaversineFallbackProvider(),
    });
    await provider.estimateDriveTime(origin, destination);
    const allLogs = warn.mock.calls.flat().map(String).join('\n');
    expect(allLogs).not.toContain('SECRET-XYZ');
  });
});
