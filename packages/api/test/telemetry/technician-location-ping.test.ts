import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTechnicianLocationPing,
  validateTechnicianLocationPingInput,
  InMemoryTechnicianLocationPingRepository,
} from '../../src/telemetry/technician-location-ping';

describe('P7-telemetry — technician location ping domain', () => {
  const now = new Date('2026-04-20T12:00:00.000Z');

  const validInput = {
    tenantId: '550e8400-e29b-41d4-a716-446655440000',
    technicianId: 'tech-1',
    appointmentId: '660e8400-e29b-41d4-a716-446655440001',
    lat: 37.7749,
    lng: -122.4194,
    accuracyMeters: 5,
    speedMps: 2,
    heading: 120,
    recordedAt: new Date('2026-04-20T11:55:00.000Z'),
    source: 'gps',
  };

  let repo: InMemoryTechnicianLocationPingRepository;

  beforeEach(() => {
    repo = new InMemoryTechnicianLocationPingRepository();
  });

  it('creates a ping with valid input', () => {
    const ping = createTechnicianLocationPing(validInput, { now });
    expect(ping.id).toBeDefined();
    expect(ping.tenantId).toBe(validInput.tenantId);
    expect(ping.technicianId).toBe(validInput.technicianId);
    expect(ping.lat).toBe(validInput.lat);
    expect(ping.lng).toBe(validInput.lng);
  });

  it('rejects invalid latitude/longitude ranges', () => {
    const errors = validateTechnicianLocationPingInput(
      { ...validInput, lat: 91, lng: -181 },
      { now }
    );

    expect(errors).toContain('lat must be a finite number between -90 and 90');
    expect(errors).toContain('lng must be a finite number between -180 and 180');
  });

  it('rejects stale timestamps', () => {
    const errors = validateTechnicianLocationPingInput(
      { ...validInput, recordedAt: new Date('2026-04-18T11:59:59.000Z') },
      { now, maxStaleMs: 24 * 60 * 60 * 1000 }
    );

    expect(errors.some((e) => e.includes('too old'))).toBe(true);
  });

  it('rejects excessive future drift timestamps', () => {
    const errors = validateTechnicianLocationPingInput(
      { ...validInput, recordedAt: new Date('2026-04-20T12:10:00.000Z') },
      { now, maxFutureDriftMs: 5 * 60 * 1000 }
    );

    expect(errors.some((e) => e.includes('too far in the future'))).toBe(true);
  });

  it('enforces tenant isolation in repository queries', async () => {
    const ping = createTechnicianLocationPing(validInput, { now });
    await repo.insertMany(validInput.tenantId, [ping]);

    const visible = await repo.listByTechnician(validInput.tenantId, validInput.technicianId);
    const hidden = await repo.listByTechnician('550e8400-e29b-41d4-a716-446655440099', validInput.technicianId);

    expect(visible).toHaveLength(1);
    expect(hidden).toHaveLength(0);
  });

  it('returns pings ordered by recordedAt descending', async () => {
    const older = createTechnicianLocationPing(
      { ...validInput, recordedAt: new Date('2026-04-20T11:00:00.000Z') },
      { now }
    );
    const newer = createTechnicianLocationPing(
      { ...validInput, recordedAt: new Date('2026-04-20T11:58:00.000Z') },
      { now }
    );

    await repo.insertMany(validInput.tenantId, [older, newer]);

    const rows = await repo.listByTechnician(validInput.tenantId, validInput.technicianId);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(newer.id);
    expect(rows[1].id).toBe(older.id);
  });
});
