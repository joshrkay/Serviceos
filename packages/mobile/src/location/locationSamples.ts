import type { TechnicianLocationPing } from '../api/technicianField';

export interface ForegroundLocationSample {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  timestamp: number;
}

export function toLocationPing(
  sample: ForegroundLocationSample,
  clientPingId: string,
  appointmentId?: string,
): TechnicianLocationPing {
  return {
    clientPingId,
    ...(appointmentId ? { appointmentId } : {}),
    lat: sample.latitude,
    lng: sample.longitude,
    ...(sample.accuracy !== null ? { accuracyMeters: sample.accuracy } : {}),
    ...(sample.speed !== null ? { speedMps: sample.speed } : {}),
    ...(sample.heading !== null ? { heading: sample.heading } : {}),
    recordedAt: new Date(sample.timestamp).toISOString(),
    source: 'mobile_foreground',
  };
}

export class LocationPingBuffer {
  private pings: TechnicianLocationPing[] = [];

  enqueue(
    sample: ForegroundLocationSample,
    clientPingId: string,
    appointmentId?: string,
  ): TechnicianLocationPing {
    const ping = toLocationPing(sample, clientPingId, appointmentId);
    this.pings.push(ping);
    return ping;
  }

  pending(): TechnicianLocationPing[] {
    return [...this.pings];
  }

  acknowledge(clientPingIds: readonly string[]): void {
    const accepted = new Set(clientPingIds);
    this.pings = this.pings.filter((ping) => !accepted.has(ping.clientPingId));
  }
}
