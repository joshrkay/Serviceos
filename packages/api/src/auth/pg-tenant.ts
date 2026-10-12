import type { Pool } from 'pg';
import type { SignupAttribution } from '@ai-service-os/shared';
import type { Tenant, TenantRepository } from './clerk';

export class PgTenantRepository implements TenantRepository {
  constructor(private pool: Pool) {}

  async findByOwner(ownerId: string): Promise<Tenant | null> {
    const { rows } = await this.pool.query(
      'SELECT id, owner_id, owner_email, name, created_at FROM tenants WHERE owner_id = $1',
      [ownerId]
    );
    return rows.length > 0 ? this.toTenant(rows[0]) : null;
  }

  async findById(id: string): Promise<Tenant | null> {
    const { rows } = await this.pool.query(
      'SELECT id, owner_id, owner_email, name, created_at FROM tenants WHERE id = $1',
      [id]
    );
    return rows.length > 0 ? this.toTenant(rows[0]) : null;
  }

  async create(data: { ownerId: string; ownerEmail: string; name: string }): Promise<Tenant> {
    const { rows } = await this.pool.query(
      `INSERT INTO tenants (owner_id, owner_email, name)
       VALUES ($1, $2, $3)
       RETURNING id, owner_id, owner_email, name, created_at`,
      [data.ownerId, data.ownerEmail, data.name]
    );
    return this.toTenant(rows[0]);
  }

  async setSignupAttribution(tenantId: string, attribution: SignupAttribution): Promise<boolean> {
    // Write-once: the IS NULL guard keeps the first recorded touch even if
    // this runs again (webhook redelivery, manual replay).
    const { rowCount } = await this.pool.query(
      `UPDATE tenants SET
         signup_utm_source = $2,
         signup_utm_medium = $3,
         signup_utm_campaign = $4,
         signup_utm_content = $5,
         signup_utm_term = $6,
         signup_referrer = $7,
         signup_landing_path = $8,
         signup_first_touch_at = $9::date
       WHERE id = $1
         AND signup_utm_source IS NULL AND signup_utm_medium IS NULL
         AND signup_utm_campaign IS NULL AND signup_utm_content IS NULL
         AND signup_utm_term IS NULL AND signup_referrer IS NULL
         AND signup_landing_path IS NULL AND signup_first_touch_at IS NULL`,
      [
        tenantId,
        attribution.utmSource ?? null,
        attribution.utmMedium ?? null,
        attribution.utmCampaign ?? null,
        attribution.utmContent ?? null,
        attribution.utmTerm ?? null,
        attribution.ref ?? null,
        attribution.landing ?? null,
        attribution.firstTouchAt ?? null,
      ]
    );
    return (rowCount ?? 0) > 0;
  }

  private toTenant(row: Record<string, unknown>): Tenant {
    return {
      id: row.id as string,
      ownerId: row.owner_id as string,
      ownerEmail: row.owner_email as string,
      name: row.name as string,
      createdAt: row.created_at as Date,
    };
  }
}
