import { TravelTimeProvider } from './provider';
import { HaversineFallbackProvider } from './haversine-fallback';
import { GoogleDistanceMatrixProvider } from './google-provider';

export function createTravelTimeProvider(env: NodeJS.ProcessEnv | Record<string, string | undefined>): TravelTimeProvider {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) return new HaversineFallbackProvider();
  return new GoogleDistanceMatrixProvider({ apiKey: key });
}
