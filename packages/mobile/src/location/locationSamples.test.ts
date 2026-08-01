import { describe, expect, it } from 'vitest';
import { LocationPingBuffer, toLocationPing, type ForegroundLocationSample } from './locationSamples';

const SAMPLE: ForegroundLocationSample = {
  latitude: 37.775,
  longitude: -122.419,
  accuracy: 7,
  speed: null,
  heading: 91,
  timestamp: Date.parse('2026-07-15T16:00:00.000Z'),
};

describe('foreground location samples', () => {
  it('creates an API ping with the supplied stable UUID and no nullable native fields', () => {
    expect(
      toLocationPing(SAMPLE, '04b0afcd-bd09-4e9d-a671-b44d57dd617b', 'appointment-1'),
    ).toEqual({
      clientPingId: '04b0afcd-bd09-4e9d-a671-b44d57dd617b',
      appointmentId: 'appointment-1',
      lat: 37.775,
      lng: -122.419,
      accuracyMeters: 7,
      heading: 91,
      recordedAt: '2026-07-15T16:00:00.000Z',
      source: 'mobile_foreground',
    });
  });

  it('keeps the same clientPingId pending until that sample is acknowledged', () => {
    const buffer = new LocationPingBuffer();
    const ping = buffer.enqueue(
      SAMPLE,
      '04b0afcd-bd09-4e9d-a671-b44d57dd617b',
      'appointment-1',
    );

    expect(buffer.pending()[0]).toBe(ping);
    expect(buffer.pending()[0]?.clientPingId).toBe(
      '04b0afcd-bd09-4e9d-a671-b44d57dd617b',
    );

    buffer.acknowledge([ping.clientPingId]);
    expect(buffer.pending()).toEqual([]);
  });

  it('does not discard a newer sample when acknowledging an older batch', () => {
    const buffer = new LocationPingBuffer();
    const first = buffer.enqueue(SAMPLE, '04b0afcd-bd09-4e9d-a671-b44d57dd617b');
    const second = buffer.enqueue(
      { ...SAMPLE, timestamp: SAMPLE.timestamp + 30_000 },
      'c43a76b0-fb83-4c1b-86cb-16d1c80552a2',
    );

    buffer.acknowledge([first.clientPingId]);
    expect(buffer.pending()).toEqual([second]);
  });
});
