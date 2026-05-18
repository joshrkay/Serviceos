import { LatLng, TravelTimeEstimate, TravelTimeProvider } from './provider';

const EARTH_RADIUS_METERS = 6_371_000;
const DRIVE_SPEED_METERS_PER_SECOND = 13.4; // ~30 mph

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function greatCircleMeters(a: LatLng, b: LatLng): number {
  if (!Number.isFinite(a.latitude) || !Number.isFinite(a.longitude)
   || !Number.isFinite(b.latitude) || !Number.isFinite(b.longitude)) {
    throw new Error('haversine: coordinates must be finite numbers');
  }
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class HaversineFallbackProvider implements TravelTimeProvider {
  async estimateDriveTime(origin: LatLng, destination: LatLng): Promise<TravelTimeEstimate> {
    const meters = greatCircleMeters(origin, destination);
    return {
      seconds: Math.round(meters / DRIVE_SPEED_METERS_PER_SECOND),
      source: 'haversine',
      degraded: false,
    };
  }
}
