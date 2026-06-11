import { describe, it, expect } from 'vitest';
import { createTravelTimeProvider } from '../../../src/scheduling/travel-time/factory';
import { GoogleDistanceMatrixProvider } from '../../../src/scheduling/travel-time/google-provider';
import { HaversineFallbackProvider } from '../../../src/scheduling/travel-time/haversine-fallback';

describe('createTravelTimeProvider', () => {
  it('returns haversine-only when GOOGLE_MAPS_API_KEY is unset', () => {
    const p = createTravelTimeProvider({});
    expect(p).toBeInstanceOf(HaversineFallbackProvider);
  });

  it('returns a Google provider when GOOGLE_MAPS_API_KEY is set', () => {
    const p = createTravelTimeProvider({ GOOGLE_MAPS_API_KEY: 'k' });
    expect(p).toBeInstanceOf(GoogleDistanceMatrixProvider);
  });
});
