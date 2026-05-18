import { describe, it, expect } from 'vitest';
import { HaversineFallbackProvider } from '../../../src/scheduling/travel-time/haversine-fallback';

describe('HaversineFallbackProvider', () => {
  const provider = new HaversineFallbackProvider();

  it('returns 0 seconds for identical coordinates', async () => {
    const p = { latitude: 37.7749, longitude: -122.4194 };
    const result = await provider.estimateDriveTime(p, p);
    expect(result.seconds).toBe(0);
    expect(result.source).toBe('haversine');
    expect(result.degraded).toBe(false);
  });

  it('estimates ~roughly known distance between SF and Oakland', async () => {
    const sf = { latitude: 37.7749, longitude: -122.4194 };
    const oak = { latitude: 37.8044, longitude: -122.2712 };
    // Great-circle ~13.4 km, at 13.4 m/s ≈ 1000s. Allow ±20% slack.
    const result = await provider.estimateDriveTime(sf, oak);
    expect(result.seconds).toBeGreaterThan(800);
    expect(result.seconds).toBeLessThan(1200);
    expect(result.source).toBe('haversine');
  });

  it('produces a finite seconds value for antipodal coordinates', async () => {
    const a = { latitude: 0, longitude: 0 };
    const b = { latitude: 0, longitude: 180 };
    const result = await provider.estimateDriveTime(a, b);
    expect(Number.isFinite(result.seconds)).toBe(true);
    expect(result.seconds).toBeGreaterThan(0);
  });

  it('throws when an input coordinate is non-finite', async () => {
    const ok = { latitude: 37.7, longitude: -122.4 };
    const bad = { latitude: Number.NaN, longitude: 0 };
    await expect(provider.estimateDriveTime(ok, bad)).rejects.toThrow();
  });
});
