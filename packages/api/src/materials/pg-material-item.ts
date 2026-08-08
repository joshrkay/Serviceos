/**
 * Tradesperson wave 1, Task 8 — Postgres-backed material items repository.
 * Tenant-scoped via RLS (`material_items`, migration 272).
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  buildMaterialItem,
  CreateMaterialItemInput,
  MaterialItem,
  MaterialItemListOptions,
  MaterialItemRepository,
  MaterialItemStatus,
} from './material-item';

interface MaterialItemRow {
  id: string;
  tenant_id: string;
  job_id: string | null;
  description: string;
  quantity: number;
  vendor: string | null;
  status: string;
  needed_by: Date | null;
  created_by: string;
  purchased_by: string | null;
  purchased_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: MaterialItemRow): MaterialItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.job_id != null ? { jobId: row.job_id } : {}),
    description: row.description,
    quantity: Number(row.quantity),
    ...(row.vendor != null ? { vendor: row.vendor } : {}),
    status: row.status as MaterialItemStatus,
    ...(row.needed_by != null ? { neededBy: new Date(row.needed_by) } : {}),
    createdBy: row.created_by,
    ...(row.purchased_by != null ? { purchasedBy: row.purchased_by } : {}),
    ...(row.purchased_at != null ? { purchasedAt: new Date(row.purchased_at) } : {}),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class PgMaterialItemRepository extends PgBaseRepository implements MaterialItemRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(input: CreateMaterialItemInput): Promise<MaterialItem> {
    const item = buildMaterialItem(input);
    return this.withTenant(item.tenantId, async (client) => {
      const { rows } = await client.query<MaterialItemRow>(
        `INSERT INTO material_items
           (id, tenant_id, job_id, description, quantity, vendor, status,
            needed_by, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          item.id,
          item.tenantId,
          item.jobId ?? null,
          item.description,
          item.quantity,
          item.vendor ?? null,
          item.status,
          item.neededBy ?? null,
          item.createdBy,
          item.createdAt,
          item.updatedAt,
        ],
      );
      return mapRow(rows[0]);
    });
  }

  async listPending(
    tenantId: string,
    options?: MaterialItemListOptions,
  ): Promise<MaterialItem[]> {
    return this.withTenant(tenantId, async (client) => {
      const conditions: string[] = ['tenant_id = $1', "status = 'pending'"];
      const params: unknown[] = [tenantId];
      if (options?.jobId) {
        params.push(options.jobId);
        conditions.push(`job_id = $${params.length}`);
      }
      const { rows } = await client.query<MaterialItemRow>(
        `SELECT * FROM material_items WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`,
        params,
      );
      return rows.map(mapRow);
    });
  }

  async markPurchased(tenantId: string, id: string, actorId: string): Promise<MaterialItem | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<MaterialItemRow>(
        `UPDATE material_items
            SET status = 'purchased', purchased_by = $3, purchased_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
          RETURNING *`,
        [tenantId, id, actorId],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }
}
