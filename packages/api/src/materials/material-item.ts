/**
 * Tradesperson wave 1, Task 8 — voice-captured materials/shopping list.
 *
 * A material item is a first-class operational row (like
 * `call_me_back_tasks`), NOT a proposal: capturing "grab 3 boxes of PEX"
 * is a task list entry, not an AI mutation requiring approval. Backed by
 * `material_items` (migration 272), tenant-scoped via RLS. Purchasing/PO
 * automation is a non-goal — `markPurchased` just records who bought it
 * and when.
 *
 * Wired at the composition root (`app.ts` constructs ONE `materialItemRepo`
 * instance, Pg-backed in production or InMemory otherwise) and threaded to
 * its two real callers: Task 9's `AddMaterialExecutionHandler`
 * (`proposals/execution/add-material-handler.ts`) writes through it on an
 * approved `add_material` proposal, and `ai/skills/lookup-materials.ts`
 * reads from the SAME instance to answer the `lookup_materials` voice
 * intent — mirroring how `expenseRepo` / `agreementRepo` are threaded into
 * the execution-handler deps bag.
 */
import { v4 as uuidv4 } from 'uuid';
import { ValidationError } from '../shared/errors';

// 'cancelled' is unreachable today — no method in this module sets it.
// Kept for forward-compat (a future task may add markCancelled); removing
// it from the TS union or the DB CHECK later would each cost their own
// change.
export type MaterialItemStatus = 'pending' | 'purchased' | 'cancelled';

export interface MaterialItem {
  id: string;
  tenantId: string;
  /** Optional link to the job this material is needed for. */
  jobId?: string;
  description: string;
  /** Always a positive integer; defaults to 1 (mirrors the DB column default). */
  quantity: number;
  /** Free-text vendor / supply-house name. */
  vendor?: string;
  status: MaterialItemStatus;
  /** When the material is needed by, if the caller gave a date. */
  neededBy?: Date;
  createdBy: string;
  /** Set once markPurchased succeeds. */
  purchasedBy?: string;
  purchasedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMaterialItemInput {
  tenantId: string;
  jobId?: string;
  description: string;
  /** Defaults to 1. */
  quantity?: number;
  vendor?: string;
  neededBy?: Date;
  createdBy: string;
}

export interface MaterialItemListOptions {
  jobId?: string;
  /**
   * Follow-up to Task 9 (2026-08-09) — date-scope the shopping list to
   * items needed before this instant (`needed_by < neededByBefore`,
   * exclusive). Added because `lookup_materials`'s bounded fetch (I4,
   * `limit`, below) only ever looks at the OLDEST-created rows: a tenant
   * with more pending items than the fetch cap could have a genuinely
   * time-sensitive item never spoken at all, self-correcting only once it
   * ages into the oldest-N window. Per-item `neededBy` in the spoken
   * summary was the interim mitigation; this is the real fix.
   *
   * NULL/undefined `neededBy` semantics (decided, pinned by both backends'
   * tests): an item with NO `neededBy` does NOT match this filter. An
   * undated item has no known deadline, so it cannot honestly be said to
   * be "needed by" any particular date — silently including it in a
   * date-scoped answer would be a worse surprise than omitting it. This
   * is also what a bare SQL `needed_by < $1` does for free (three-valued
   * logic excludes NULL from ANY comparison), so the Pg backend needs no
   * special-case and the InMemory backend mirrors it explicitly to keep
   * both backends provably in agreement.
   *
   * Ordering interaction: when this option is set, `listPending` orders
   * by `needed_by ASC` (soonest-due first) instead of the default
   * oldest-created-first — see the interface doc comment below for why.
   */
  neededByBefore?: Date;
  /**
   * Cap the number of rows returned, applied at the repo/SQL boundary —
   * NOT sliced app-side after an unbounded fetch (quality-review I4, Task
   * 9: `lookup_materials` used to load every pending row for the tenant
   * just to speak 5 of them — a shopping list is append-mostly, only
   * `markPurchased` prunes it, so that only gets worse over a tenant's
   * lifetime). Rows are returned in the SAME order `listPending` uses for
   * this call (oldest-created-first by default, or soonest-`needed_by`-
   * first when `neededByBefore` is given — see that option's doc
   * comment), so `limit: N` yields the N rows that ordering puts first,
   * not an arbitrary N.
   */
  limit?: number;
}

export interface MaterialItemRepository {
  create(input: CreateMaterialItemInput): Promise<MaterialItem>;
  /**
   * Pending items for a tenant, optionally scoped to a job and/or a
   * needed-by date (`options.neededByBefore`).
   *
   * Ordering: oldest-created first by DEFAULT. When `neededByBefore` is
   * given, ordering switches to soonest-`needed_by`-first instead — a
   * date-scoped ask ("what do I need for tomorrow?") cares about urgency,
   * not which row happened to be created first, and the fetch is capped
   * (`options.limit`) so which rows make the cut matters. Ties break
   * deterministically but ARBITRARILY in the Pg backend (a trailing `id
   * ASC` — see pg-material-item.ts) since two rows can share the same
   * created_at/needed_by; InMemory gives true insertion order among ties
   * since it never ties by construction.
   */
  listPending(tenantId: string, options?: MaterialItemListOptions): Promise<MaterialItem[]>;
  /** Transition pending -> purchased. Null if not found, wrong tenant, or not pending. */
  markPurchased(tenantId: string, id: string, actorId: string): Promise<MaterialItem | null>;
}

// A spoken/transcribed quantity ("two billion nails") can overflow Postgres
// INTEGER (int4, max 2147483647) and turn into a raw 22003 DB error instead
// of a clean ValidationError. This cap is application-domain, not a DB
// CHECK — comfortably above any real shopping-list quantity but well inside
// int4, so create() always fails fast in shared code before either backend
// touches the database.
//
// Exported (quality-review I6) — `contracts/add-material.ts` imports this
// constant rather than duplicating the literal `1_000_000`. Two independent
// literals agreeing today is not a guarantee they stay in lockstep; a
// comment saying "keep these in sync" can't fail a build, and this exact
// divergence class (a draft-time contract looser than the repo-layer
// validator it feeds) is what Task 6's change-order contract review
// caught, and what Task 9's own contract doc comment warned about before
// this fix made the warning structural.
export const MAX_QUANTITY = 1_000_000;

// Not exported: only buildMaterialItem calls this, and every branch is
// already exercised indirectly through repo.create() in
// test/materials/material-item.test.ts. Re-export it (and give it its own
// direct test suite, mirroring test/expenses/expense.test.ts) if a second
// caller needs it standalone.
function validateCreateMaterialItemInput(input: CreateMaterialItemInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.createdBy) errors.push('createdBy is required');
  if (!input.description || input.description.trim().length === 0) {
    errors.push('description is required');
  }
  if (input.quantity !== undefined) {
    if (
      typeof input.quantity !== 'number' ||
      !Number.isFinite(input.quantity) ||
      input.quantity <= 0
    ) {
      errors.push('quantity must be a positive number');
    } else if (!Number.isInteger(input.quantity)) {
      errors.push('quantity must be an integer');
    } else if (input.quantity > MAX_QUANTITY) {
      errors.push(`quantity must not exceed ${MAX_QUANTITY}`);
    }
  }
  return errors;
}

/** Shared row builder so the in-memory + pg repos stay in shape-sync. */
export function buildMaterialItem(input: CreateMaterialItemInput): MaterialItem {
  const errors = validateCreateMaterialItemInput(input);
  if (errors.length > 0) {
    throw new ValidationError(`Validation failed: ${errors.join(', ')}`);
  }
  const now = new Date();
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    description: input.description.trim(),
    quantity: input.quantity ?? 1,
    ...(input.vendor !== undefined ? { vendor: input.vendor } : {}),
    status: 'pending',
    ...(input.neededBy !== undefined ? { neededBy: input.neededBy } : {}),
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Guards the actor performing a `markPurchased` transition. Shared so both
 * backends reject the same way `create()` rejects a missing `createdBy` —
 * without this, an empty actorId silently wrote `purchased_by = ''` in both
 * the in-memory and Pg repos.
 */
export function requireActorId(actorId: string): void {
  if (!actorId || actorId.trim().length === 0) {
    throw new ValidationError('actorId is required');
  }
}

export class InMemoryMaterialItemRepository implements MaterialItemRepository {
  private readonly items = new Map<string, MaterialItem>();

  async create(input: CreateMaterialItemInput): Promise<MaterialItem> {
    const item = buildMaterialItem(input);
    this.items.set(item.id, item);
    return { ...item };
  }

  async listPending(
    tenantId: string,
    options?: MaterialItemListOptions,
  ): Promise<MaterialItem[]> {
    const neededByBefore = options?.neededByBefore;
    const filtered = Array.from(this.items.values())
      .filter((i) => i.tenantId === tenantId)
      .filter((i) => i.status === 'pending')
      .filter((i) => !options?.jobId || i.jobId === options.jobId)
      // NULL/undefined neededBy never matches a date-scoped query — see
      // MaterialItemListOptions.neededByBefore's doc comment for why (an
      // undated item has no known deadline). Mirrors the Pg backend's bare
      // `needed_by < $1`, which excludes NULL for the same reason without
      // needing this explicit check.
      .filter((i) => !neededByBefore || (i.neededBy !== undefined && i.neededBy.getTime() < neededByBefore.getTime()));
    const sorted = neededByBefore
      ? filtered.sort((a, b) => a.neededBy!.getTime() - b.neededBy!.getTime())
      : filtered.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const result = sorted.map((i) => ({ ...i }));
    return typeof options?.limit === 'number' ? result.slice(0, options.limit) : result;
  }

  async markPurchased(tenantId: string, id: string, actorId: string): Promise<MaterialItem | null> {
    requireActorId(actorId);
    const item = this.items.get(id);
    if (!item || item.tenantId !== tenantId) return null;
    if (item.status !== 'pending') return null;
    const updated: MaterialItem = {
      ...item,
      status: 'purchased',
      purchasedBy: actorId,
      purchasedAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(id, updated);
    return { ...updated };
  }
}
