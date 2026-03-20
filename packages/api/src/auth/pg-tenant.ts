import type { Pool } from 'pg';
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
