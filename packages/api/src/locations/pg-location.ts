import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { LocationRepository, ServiceLocation } from './location';

function mapRow(row: Record<string, unknown>): ServiceLocation {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    customerId: row.customer_id as string,
    label: (row.label as string) ?? undefined,
    street1: row.street1 as string,
    street2: (row.street2 as string) ?? undefined,
    city: row.city as string,
    state: row.state as string,
    postalCode: row.postal_code as string,
    country: row.country as string,
    latitude: row.latitude != null ? Number(row.latitude) : undefined,
    longitude: row.longitude != null ? Number(row.longitude) : undefined,
    accessNotes: (row.access_notes as string) ?? undefined,
    isPrimary: row.is_primary as boolean,
    isArchived: row.is_archived as boolean,
    archivedAt: row.archived_at ? new Date(row.archived_at as string) : undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgLocationRepository extends PgBaseRepository implements LocationRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(location: ServiceLocation): Promise<ServiceLocation> {
    return this.withTenant(location.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO service_locations (
          id, tenant_id, customer_id, label, street1, street2, city, state,
          postal_code, country, latitude, longitude, access_notes,
          is_primary, is_archived, archived_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING *`,
        [
          location.id,
          location.tenantId,
          location.customerId,
          location.label ?? null,
          location.street1,
          location.street2 ?? null,
          location.city,
          location.state,
          location.postalCode,
          location.country,
          location.latitude ?? null,
          location.longitude ?? null,
          location.accessNotes ?? null,
          location.isPrimary,
          location.isArchived,
          location.archivedAt ?? null,
          location.createdAt,
          location.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<ServiceLocation | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM service_locations WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async findByCustomer(tenantId: string, customerId: string): Promise<ServiceLocation[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM service_locations WHERE tenant_id = $1 AND customer_id = $2 ORDER BY is_primary DESC, created_at ASC',
        [tenantId, customerId]
      );
      return result.rows.map(mapRow);
    });
  }

  async findByTenant(tenantId: string): Promise<ServiceLocation[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM service_locations WHERE tenant_id = $1 ORDER BY created_at DESC',
        [tenantId]
      );
      return result.rows.map(mapRow);
    });
  }

  async update(tenantId: string, id: string, updates: Partial<ServiceLocation>): Promise<ServiceLocation | null> {
    return this.withTenant(tenantId, async (client) => {
      const fieldMap: Record<string, string> = {
        customerId: 'customer_id',
        label: 'label',
        street1: 'street1',
        street2: 'street2',
        city: 'city',
        state: 'state',
        postalCode: 'postal_code',
        country: 'country',
        latitude: 'latitude',
        longitude: 'longitude',
        accessNotes: 'access_notes',
        isPrimary: 'is_primary',
        isArchived: 'is_archived',
        archivedAt: 'archived_at',
        updatedAt: 'updated_at',
      };

      const setClauses: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(updates)) {
        const column = fieldMap[key];
        if (column) {
          setClauses.push(`${column} = $${paramIndex}`);
          params.push(value ?? null);
          paramIndex++;
        }
      }

      if (setClauses.length === 0) return this.findById(tenantId, id);

      params.push(tenantId, id);
      const result = await client.query(
        `UPDATE service_locations SET ${setClauses.join(', ')}
         WHERE tenant_id = $${paramIndex} AND id = $${paramIndex + 1}
         RETURNING *`,
        params
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }
}
