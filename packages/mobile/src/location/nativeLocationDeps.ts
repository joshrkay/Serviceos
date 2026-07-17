import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import type { ForegroundLocationSample } from './locationSamples';

export interface ForegroundLocationSubscription {
  remove: () => void;
}

export type ForegroundPermission = 'granted' | 'denied';

export function createClientPingId(): string {
  return Crypto.randomUUID();
}

export async function requestWhenInUsePermission(): Promise<ForegroundPermission> {
  const result = await Location.requestForegroundPermissionsAsync();
  return result.granted ? 'granted' : 'denied';
}

export async function watchForegroundPosition(
  onLocation: (sample: ForegroundLocationSample) => void,
): Promise<ForegroundLocationSubscription> {
  return Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.Balanced,
      distanceInterval: 50,
      timeInterval: 30_000,
    },
    (location) => {
      onLocation({
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        accuracy: location.coords.accuracy,
        speed: location.coords.speed,
        heading: location.coords.heading,
        timestamp: location.timestamp,
      });
    },
  );
}
