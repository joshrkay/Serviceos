import { describe, it, expect, vi } from 'vitest';
import {
  WeatherClient,
  type WeatherTransport,
} from '../../../src/integrations/weather/weather-client';
import { roundCoord } from '../../../src/integrations/weather/pg-weather-cache';

describe('P8-016 weather-client (injected transport, no network)', () => {
  it('returns temps on a healthy transport', async () => {
    const transport: WeatherTransport = vi.fn(async () => ({ maxTempF: 104, minTempF: 80 }));
    const client = new WeatherClient(transport);
    const result = await client.fetchRecentTemps(30.3, -97.7);
    expect(result).toEqual({ ok: true, temps: { maxTempF: 104, minTempF: 80 } });
  });

  it('degrades (does not throw) on a transport rejection', async () => {
    const client = new WeatherClient(async () => {
      throw new Error('503 Service Unavailable');
    });
    const result = await client.fetchRecentTemps(30.3, -97.7);
    expect(result.ok).toBe(false);
  });

  it('degrades on a malformed provider payload', async () => {
    const client = new WeatherClient(async () => ({ maxTempF: NaN, minTempF: 10 }));
    const result = await client.fetchRecentTemps(30.3, -97.7);
    expect(result.ok).toBe(false);
  });

  it('roundCoord buckets coordinates to 0.5 degrees', () => {
    expect(roundCoord(30.34)).toBe(30.5);
    expect(roundCoord(-97.71)).toBe(-97.5);
    expect(roundCoord(30.1)).toBe(30.0);
  });
});
