import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { TechnicianLocationPing, TechnicianLocationPingRepository } from './technician-location-ping';

function mapRow(row: Record<string, unknown>): TechnicianLocationPing {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    technicianId: row.technician_id as string,
    clientPingId: row.client_ping_id as string,
    appointmentId: (row.appointment_id as string) ?? undefined,
    lat: Number(row.lat),
    lng: Number(row.lng),
    accuracyMeters: row.accuracy_meters != null ? Number(row.accuracy_meters) : undefined,
    speedMps: row.speed_mps != null ? Number(row.speed_mps) : undefined,
    heading: row.heading != null ? Number(row.heading) : undefined,
    recordedAt: new Date(row.recorded_at as string),
    source: row.source as string,
  };
}

export class PgTechnicianLocationPingRepository extends PgBaseRepository implements TechnicianLocationPingRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async insertMany(tenantId: string, pings: TechnicianLocationPing[]): Promise<TechnicianLocationPing[]> {
    if (pings.length === 0) return [];

    return this.withTenant(tenantId, async (client) => {
      const values: unknown[] = [];
      const placeholders: string[] = [];

      for (const [i, ping] of pings.entries()) {
        const base = i * 12;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`
        );
        values.push(
          ping.id,
          tenantId,
          ping.technicianId,
          ping.clientPingId,
          ping.appointmentId ?? null,
          ping.lat,
          ping.lng,
          ping.accuracyMeters ?? null,
          ping.speedMps ?? null,
          ping.heading ?? null,
          ping.recordedAt,
          ping.source,
        );
      }

      const result = await client.query(
        `INSERT INTO technician_location_pings (
          id, tenant_id, technician_id, client_ping_id, appointment_id, lat, lng,
          accuracy_meters, speed_mps, heading, recorded_at, source
        ) VALUES ${placeholders.join(', ')}
        ON CONFLICT (tenant_id, client_ping_id) DO NOTHING
        RETURNING *`,
        values
      );

      return result.rows.map(mapRow);
    });
  }

  async listByTechnician(tenantId: string, technicianId: string, limit: number = 100): Promise<TechnicianLocationPing[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM technician_location_pings
         WHERE tenant_id = $1 AND technician_id = $2
         ORDER BY recorded_at DESC
         LIMIT $3`,
        [tenantId, technicianId, limit]
      );

      return result.rows.map(mapRow);
    });
  }

  async listByAppointment(tenantId: string, appointmentId: string, limit: number = 100): Promise<TechnicianLocationPing[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM technician_location_pings
         WHERE tenant_id = $1 AND appointment_id = $2
         ORDER BY recorded_at DESC
         LIMIT $3`,
        [tenantId, appointmentId, limit]
      );

      return result.rows.map(mapRow);
    });
  }
}
