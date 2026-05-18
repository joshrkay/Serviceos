export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface TravelTimeEstimate {
  seconds: number;
  source: 'google' | 'haversine';
  degraded: boolean;
}

export interface TravelTimeProvider {
  estimateDriveTime(
    origin: LatLng,
    destination: LatLng,
    departAt?: Date,
  ): Promise<TravelTimeEstimate>;
}
