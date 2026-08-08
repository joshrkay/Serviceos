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
  requireActorId,
} from './material-item';

// Mirrors the per-file isUuid idiom used elsewhere for execution-side id
// checks (e.g. src/ai/tasks/estimate-edit-task.ts): tenantId/id/jobId here
// can all be LLM-invented or unresolved references on the voice path
// (Task 9), and applyTenantContext (src/db/rls-runtime-role.ts) throws a
// raw "Invalid tenant ID format" error on anything non-UUID-shaped before a
// query even runs — a malformed jobId would separately hit Postgres's own
// "invalid input syntax for type uuid" on the job_id column comparison.
// Guarding here turns both into the same graceful null/[] a
// genuinely-missing-but-well-formed id already produces, so a garbled
// reference reads as "not found" instead of a 500.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

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
      // created_at/updated_at come from the DB clock (NOW()), not
      // item.createdAt/item.updatedAt from buildMaterialItem — mirrors
      // pg-call-me-back.ts. Passing the app-server JS Date here would mix
      // clock sources with markPurchased's NOW() below: under app<->DB skew
      // (or across Railway instances with their own skew from each other)
      // you'd get updated_at < created_at on the same row, and ORDER BY
      // created_at (listPending) would sort by app-server wall clock instead
      // of true insertion sequence. RETURNING * + mapRow means the object
      // this method returns still reflects the real, single-source DB time.
      const { rows } = await client.query<MaterialItemRow>(
        `INSERT INTO material_items
           (id, tenant_id, job_id, description, quantity, vendor, status,
            needed_by, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
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
        ],
      );
      return mapRow(rows[0]);
    });
  }

  async listPending(
    tenantId: string,
    options?: MaterialItemListOptions,
  ): Promise<MaterialItem[]> {
    if (!isUuid(tenantId)) return [];
    // Same failure class as tenantId above, same fix: jobId can be an
    // unresolved spoken job reference on the voice path (Task 9's
    // lookup_materials). A malformed jobId must return [] — NOT the
    // tenant's whole pending list (silently dropping the filter would be
    // worse: the caller asked for one job's items and would get everyone's)
    // and NOT a raw Postgres "invalid input syntax for type uuid" from
    // comparing a non-UUID string against the job_id column below.
    if (options?.jobId && !isUuid(options.jobId)) return [];
    return this.withTenant(tenantId, async (client) => {
      // status = 'pending' stays a SQL LITERAL (not a bind param) so the
      // planner can prove the predicate implies idx_material_items_pending
      // (migration 272) — parameterizing it later would make that index
      // unusable for this query.
      const conditions: string[] = ['tenant_id = $1', "status = 'pending'"];
      const params: unknown[] = [tenantId];
      if (options?.jobId) {
        params.push(options.jobId);
        conditions.push(`job_id = $${params.length}`);
      }
      // `, id ASC` tiebreak: even with created_at now DB-generated (NOW(),
      // microsecond precision, since the create() fix above), two rows can
      // still tie — and previously, when created_at was a JS Date bound as a
      // param with millisecond resolution, ties on rapid successive creates
      // were common (measured: 2 of 3 in one run). Without a tiebreak, a
      // plain `ORDER BY created_at ASC` is nondeterministic between two
      // identical calls whenever rows tie. The id tiebreak buys
      // DETERMINISM, not true insertion-order fidelity — id is a random v4
      // UUID, so a tie is broken consistently but not necessarily
      // oldest-first.
      const { rows } = await client.query<MaterialItemRow>(
        `SELECT * FROM material_items WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC, id ASC`,
        params,
      );
      return rows.map(mapRow);
    });
  }

  async markPurchased(tenantId: string, id: string, actorId: string): Promise<MaterialItem | null> {
    requireActorId(actorId);
    if (!isUuid(tenantId) || !isUuid(id)) return null;
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
