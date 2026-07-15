import { v4 as uuidv4 } from 'uuid';

export interface TechnicianLocationPing {
  id: string;
  tenantId: string;
  technicianId: string;
  clientPingId: string;
  appointmentId?: string;
  lat: number;
  lng: number;
  accuracyMeters?: number;
  speedMps?: number;
  heading?: number;
  recordedAt: Date;
  source: string;
}

export interface CreateTechnicianLocationPingInput {
  tenantId: string;
  technicianId: string;
  clientPingId: string;
  appointmentId?: string;
  lat: number;
  lng: number;
  accuracyMeters?: number;
  speedMps?: number;
  heading?: number;
  recordedAt: Date;
  source: string;
}

export interface TechnicianLocationPingRepository {
  insertMany(tenantId: string, pings: TechnicianLocationPing[]): Promise<TechnicianLocationPing[]>;
  listByTechnician(tenantId: string, technicianId: string, limit?: number): Promise<TechnicianLocationPing[]>;
  listByAppointment(tenantId: string, appointmentId: string, limit?: number): Promise<TechnicianLocationPing[]>;
}

export interface PingValidationOptions {
  now?: Date;
  maxStaleMs?: number;
  maxFutureDriftMs?: number;
}

export const DEFAULT_MAX_STALE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_FUTURE_DRIFT_MS = 5 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateLocationValues(
  input: Pick<
    CreateTechnicianLocationPingInput,
    'lat' | 'lng' | 'accuracyMeters' | 'speedMps' | 'heading'
  >,
): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90) {
    errors.push('lat must be a finite number between -90 and 90');
  }
  if (!Number.isFinite(input.lng) || input.lng < -180 || input.lng > 180) {
    errors.push('lng must be a finite number between -180 and 180');
  }
  if (input.accuracyMeters != null && (!Number.isFinite(input.accuracyMeters) || input.accuracyMeters < 0)) {
    errors.push('accuracyMeters must be a non-negative finite number when provided');
  }
  if (input.speedMps != null && (!Number.isFinite(input.speedMps) || input.speedMps < 0)) {
    errors.push('speedMps must be a non-negative finite number when provided');
  }
  if (input.heading != null && (!Number.isFinite(input.heading) || input.heading < 0 || input.heading >= 360)) {
    errors.push('heading must be a finite number in [0, 360) when provided');
  }
  return errors;
}

function validateRecordedAt(
  recordedAt: Date,
  now: Date,
  maxStaleMs: number,
  maxFutureDriftMs: number,
): string[] {
  if (!(recordedAt instanceof Date) || Number.isNaN(recordedAt.getTime())) {
    return ['recordedAt must be a valid Date'];
  }
  const errors: string[] = [];
  const ageMs = now.getTime() - recordedAt.getTime();
  if (ageMs > maxStaleMs) {
    errors.push(`recordedAt is too old (older than ${maxStaleMs}ms)`);
  }
  if (ageMs < -maxFutureDriftMs) {
    errors.push(`recordedAt is too far in the future (more than ${maxFutureDriftMs}ms)`);
  }
  return errors;
}

export function validateTechnicianLocationPingInput(
  input: CreateTechnicianLocationPingInput,
  options: PingValidationOptions = {}
): string[] {
  const errors: string[] = [];
  const now = options.now ?? new Date();
  const maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  const maxFutureDriftMs = options.maxFutureDriftMs ?? DEFAULT_MAX_FUTURE_DRIFT_MS;

  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.technicianId) errors.push('technicianId is required');
  if (!UUID_PATTERN.test(input.clientPingId)) errors.push('clientPingId must be a valid UUID');
  if (!input.source) errors.push('source is required');
  errors.push(...validateLocationValues(input));
  errors.push(...validateRecordedAt(input.recordedAt, now, maxStaleMs, maxFutureDriftMs));

  return errors;
}

export function createTechnicianLocationPing(
  input: CreateTechnicianLocationPingInput,
  options: PingValidationOptions = {}
): TechnicianLocationPing {
  const errors = validateTechnicianLocationPingInput(input, options);
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.join(', ')}`);
  }

  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    technicianId: input.technicianId,
    clientPingId: input.clientPingId,
    appointmentId: input.appointmentId,
    lat: input.lat,
    lng: input.lng,
    accuracyMeters: input.accuracyMeters,
    speedMps: input.speedMps,
    heading: input.heading,
    recordedAt: input.recordedAt,
    source: input.source,
  };
}

export class InMemoryTechnicianLocationPingRepository implements TechnicianLocationPingRepository {
  private readonly rows: TechnicianLocationPing[] = [];
  private readonly clientPingKeys = new Set<string>();

  async insertMany(tenantId: string, pings: TechnicianLocationPing[]): Promise<TechnicianLocationPing[]> {
    const accepted: TechnicianLocationPing[] = [];
    for (const ping of pings) {
      const key = `${tenantId}:${ping.clientPingId}`;
      if (this.clientPingKeys.has(key)) continue;
      const stored = { ...ping, tenantId };
      this.clientPingKeys.add(key);
      this.rows.push(stored);
      accepted.push({ ...stored });
    }
    return accepted;
  }

  async listByTechnician(tenantId: string, technicianId: string, limit: number = 100): Promise<TechnicianLocationPing[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && r.technicianId === technicianId)
      .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listByAppointment(tenantId: string, appointmentId: string, limit: number = 100): Promise<TechnicianLocationPing[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && r.appointmentId === appointmentId)
      .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}
