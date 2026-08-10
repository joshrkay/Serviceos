/**
 * Tradesperson wave 1, Task 8 — Postgres-backed material items repository.
 * Tenant-scoped via RLS (`material_items`, migration 272).
 *
 * Follow-up (2026-08-09) — the `needed_by` bounds (below) deliberately do
 * NOT get their own index/migration. The CONCLUSION stands; the reasoning
 * below was corrected on 2026-08-09 (review follow-up N8) because the
 * original version of this comment claimed the LIMIT still bounds the work,
 * and it does not — and corrected again on 2026-08-10 (F2), which took the
 * last index-supplied query away.
 *
 * The REAL tradeoff:
 *
 *   - EVERY query — `ORDER BY needed_by ASC NULLS LAST, created_at ASC,
 *     id ASC` (one ordering for every shape since F2; see `listPending`).
 *     `idx_material_items_pending (tenant_id, created_at) WHERE status =
 *     'pending'` (migration 272) cannot supply that order — `needed_by` is
 *     not in it. The planner uses the index to FIND the tenant's pending
 *     rows, then MATERIALIZES every row matching the predicates and top-N
 *     sorts them. The LIMIT caps what is RETURNED, not what is read and
 *     sorted: cost is O(matching pending rows), not O(6). K3's two-query
 *     shape (bracketed answer + bounded overdue probe) doubles that on a
 *     date-scoped ask, though each query is the same order of magnitude.
 *
 *   - Before F2 the DEFAULT (undated) query was the one exception: it
 *     ordered `created_at ASC`, which that index DID supply, so the planner
 *     walked it and stopped after 6 rows — O(limit). F2 gave that up
 *     knowingly. What it bought is correctness: `created_at ASC` under a
 *     6-row fetch and a 5-item spoken cap let five ancient rows hide an item
 *     due tomorrow, permanently, because a shopping list is append-mostly.
 *     An O(limit) query that answers the wrong question is not a saving.
 *
 * That is still the right trade today: a shopping list is a small,
 * append-mostly, per-tenant operational list (`markPurchased` continuously
 * removes rows from the partial index's own predicate), so "every matching
 * pending row" is tens of rows for a real tenant, and a top-N sort over tens
 * of rows is free. Adding `needed_by` to the index would pay
 * write-amplification on every insert/update for a saving with no observed
 * workload behind it.
 *
 * CONCRETE REVISIT TRIGGER (not "if it feels slow"): if any tenant's
 * concurrently-pending set is observed above ~2,000 rows, add
 * `(tenant_id, needed_by) WHERE status = 'pending'` so the date-scoped
 * ORDER BY becomes index-supplied and the LIMIT bounds the work again.
 * Since F2 that trigger covers the DEFAULT ask too, and the index should be
 * `(tenant_id, needed_by, created_at) WHERE status = 'pending'` to supply
 * the whole sort — a btree ASC index already stores NULLs last, matching
 * `NULLS LAST`.
 */
import { Pool } from 'pg';
import { isValidTenantId } from '../db/schema';
import { PgBaseRepository } from '../db/pg-base';
import {
  buildMaterialItem,
  CreateMaterialItemInput,
  dateBoundsAreValid,
  MaterialItem,
  MaterialItemListOptions,
  MaterialItemRepository,
  MaterialItemStatus,
  requireActorId,
} from './material-item';

// Mirrors the per-file isUuid idiom used elsewhere for execution-side id
// checks (e.g. src/ai/tasks/estimate-edit-task.ts): id/jobId here can be
// LLM-invented or unresolved references on the voice path (Task 9), and a
// malformed jobId would hit Postgres's own "invalid input syntax for type
// uuid" on the job_id column comparison. Guarding here turns that into the
// same graceful null/[] a genuinely-missing-but-well-formed id already
// produces, so a garbled reference reads as "not found" instead of a 500.
// tenantId is guarded separately via isValidTenantId (src/db/schema.ts) —
// that's the single source of truth for the same check applyTenantContext
// (src/db/rls-runtime-role.ts) throws against, so this guard can't drift
// from the throw it protects against.
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
    if (!isValidTenantId(tenantId)) return [];
    // Same failure class as tenantId above, same fix: jobId can be an
    // unresolved spoken job reference on the voice path (Task 9's
    // lookup_materials). A malformed jobId must return [] — NOT the
    // tenant's whole pending list (silently dropping the filter would be
    // worse: the caller asked for one job's items and would get everyone's)
    // and NOT a raw Postgres "invalid input syntax for type uuid" from
    // comparing a non-UUID string against the job_id column below.
    if (options?.jobId && !isUuid(options.jobId)) return [];
    // Same posture, one field over (review follow-up J2): a `neededByFrom`/
    // `neededByBefore` that is not a usable Date returns [] rather than
    // dropping the predicate and answering a date-scoped question with the
    // tenant's WHOLE pending list. The old `instanceof Date` gate did
    // exactly that for an ISO string crossing a queue/JSON boundary, and
    // passed an `Invalid Date` straight through to SQL as NULL. The guard is
    // shared with the InMemory backend so one input can't take two branches.
    if (!dateBoundsAreValid(options)) return [];
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
      // Follow-up to Task 9 — date-scope the shopping list. A plain `<`
      // comparison excludes a NULL needed_by for free (three-valued logic:
      // `NULL < $N` is NULL, never TRUE, so WHERE drops the row) — this is
      // the decided, tested behavior (see MaterialItemListOptions.
      // neededByBefore's doc comment), not an accident of SQL semantics we
      // merely tolerate. No extra `needed_by IS NOT NULL` clause needed.
      if (options?.neededByBefore !== undefined) {
        params.push(options.neededByBefore);
        conditions.push(`needed_by < $${params.length}`);
      }
      // Review follow-up K3 — the INCLUSIVE lower bound that brackets the
      // window, so "what do I need for tomorrow" can be answered with the
      // items due ON tomorrow instead of a lower-unbounded set whose oldest
      // overdue rows eat the caller's whole spoken cap.
      if (options?.neededByFrom !== undefined) {
        params.push(options.neededByFrom);
        conditions.push(`needed_by >= $${params.length}`);
      }
      // `created_at ASC` before `id ASC` (review follow-up J1, 2026-08-09):
      // `add-material-handler.ts` writes every voice-captured needed_by as
      // `new Date(`${neededBy}T00:00:00Z`)`, so two items due the same day
      // tie EXACTLY on needed_by — the NORMAL case. Without created_at in
      // the sort, those rows fell straight through to `id ASC` (a random v4
      // UUID) while the InMemory backend's stable sort gave insertion order,
      // so under lookup_materials's 5-item spoken cap the two backends
      // answered the same question with DIFFERENT SUBSETS. created_at is the
      // key both backends share; see MaterialItemRepository.listPending's
      // doc comment for the one residual (mock-only) divergence.
      //
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
      // Quality-review I4 — LIMIT applied in SQL, not sliced app-side after
      // an unbounded SELECT: a shopping list is append-mostly (only
      // markPurchased prunes it), so without this a tenant's pending set
      // grows without bound while `lookup_materials` only ever speaks a
      // handful of rows. A non-positive/non-integer limit is ignored
      // (treated as "no cap") rather than producing an invalid `LIMIT`
      // clause or silently returning zero rows.
      const hasLimit =
        typeof options?.limit === 'number' && Number.isInteger(options.limit) && options.limit > 0;
      const limitClause = hasLimit ? ` LIMIT $${params.length + 1}` : '';
      if (hasLimit) params.push(options!.limit);
      // F2 — ONE ordering for every shape. This used to branch: date-scoped
      // asks ordered by urgency, the default ordered `created_at ASC`. That
      // default was the last home of the silent-omission defect the whole
      // date path exists to fix — `lookup_materials` fetches 6 rows and
      // speaks 5, so five ancient rows owned the entire answer to "what do I
      // need?" and an item due tomorrow was never mentioned; and because a
      // shopping list is append-mostly (only `markPurchased` prunes it),
      // those same five rows owned it forever rather than self-correcting.
      //
      // `NULLS LAST` is a no-op on the date-scoped shape (a `needed_by`
      // predicate already excludes NULL rows) and is the whole safety of the
      // default shape: an undated item has no deadline, so it sorts after
      // every dated one rather than being treated as infinitely urgent. It
      // is spelled out rather than left to Postgres's ASC default so the
      // intent survives anyone later flipping a direction.
      //
      // Collapsing the branch also removes the possibility of the two shapes
      // drifting apart on tie-breaks, which is exactly what J1 had to fix.
      const orderByClause = 'ORDER BY needed_by ASC NULLS LAST, created_at ASC, id ASC';
      const { rows } = await client.query<MaterialItemRow>(
        `SELECT * FROM material_items WHERE ${conditions.join(' AND ')} ${orderByClause}${limitClause}`,
        params,
      );
      return rows.map(mapRow);
    });
  }

  async markPurchased(tenantId: string, id: string, actorId: string): Promise<MaterialItem | null> {
    requireActorId(actorId);
    if (!isValidTenantId(tenantId) || !isUuid(id)) return null;
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
