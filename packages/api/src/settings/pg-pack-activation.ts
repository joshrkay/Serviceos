import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  TenantPackActivation,
  PackActivationRepository,
  ActivationStatus,
} from './pack-activation';

function rowToActivation(row: Record<string, unknown>): TenantPackActivation {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    packId: row.pack_id as string,
    status: row.status as ActivationStatus,
    activatedAt: new Date(row.activated_at as string),
    deactivatedAt: row.deactivated_at
      ? new Date(row.deactivated_at as string)
      : undefined,
  };
}

export class PgPackActivationRepository
  extends PgBaseRepository
  implements PackActivationRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(activation: TenantPackActivation): Promise<TenantPackActivation> {
    return this.withTenant(activation.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO pack_activations (id, tenant_id, pack_id, status, activated_at, deactivated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          activation.id,
          activation.tenantId,
          activation.packId,
          activation.status,
          activation.activatedAt,
          activation.deactivatedAt ?? null,
        ]
      );
      return rowToActivation(result.rows[0]);
    });
  }

  async findByTenant(tenantId: string): Promise<TenantPackActivation[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM pack_activations WHERE tenant_id = $1 ORDER BY activated_at DESC`,
        [tenantId]
      );
      return result.rows.map(rowToActivation);
    });
  }

  async findByTenantAndPack(
    tenantId: string,
    packId: string
  ): Promise<TenantPackActivation | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM pack_activations WHERE tenant_id = $1 AND pack_id = $2`,
        [tenantId, packId]
      );
      return result.rows.length > 0 ? rowToActivation(result.rows[0]) : null;
    });
  }

  async update(
    id: string,
    updates: Partial<TenantPackActivation>
  ): Promise<TenantPackActivation | null> {
    return this.withClient(async (client) => {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (updates.status !== undefined) {
        setClauses.push(`status = $${paramIndex++}`);
        values.push(updates.status);
      }
      if (updates.activatedAt !== undefined) {
        setClauses.push(`activated_at = $${paramIndex++}`);
        values.push(updates.activatedAt);
      }
      if (updates.deactivatedAt !== undefined) {
        setClauses.push(`deactivated_at = $${paramIndex++}`);
        values.push(updates.deactivatedAt);
      } else if ('deactivatedAt' in updates && updates.deactivatedAt === undefined) {
        setClauses.push(`deactivated_at = $${paramIndex++}`);
        values.push(null);
      }

      if (setClauses.length === 0) {
        const existing = await client.query(
          `SELECT * FROM pack_activations WHERE id = $1`,
          [id]
        );
        return existing.rows.length > 0 ? rowToActivation(existing.rows[0]) : null;
      }

      values.push(id);

      const result = await client.query(
        `UPDATE pack_activations SET ${setClauses.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING *`,
        values
      );
      return result.rows.length > 0 ? rowToActivation(result.rows[0]) : null;
    });
  }
}
