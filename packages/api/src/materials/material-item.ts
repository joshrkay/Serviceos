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
   * OVERDUE INTERACTION (review follow-up K3, 2026-08-09) — READ THIS
   * BEFORE USING THIS OPTION ALONE. `neededByBefore` is an OPEN-ENDED
   * lower-unbounded window: it includes every overdue item, however old.
   * Combined with `needed_by ASC` ordering and a `limit`, the OLDEST
   * overdue rows sort FIRST and can consume the entire cap, so a
   * date-scoped read can return zero of the items actually due on the day
   * the caller asked about — the same silent-omission class this option
   * was introduced to fix, pointed the other way. A caller that means "due
   * ON day X" must bracket the window with `neededByFrom` (below) and
   * account for the pre-window backlog separately; `ai/skills/lookup-
   * materials.ts` does exactly that (one bracketed query for the answer,
   * one bounded probe for the "plus N needed sooner" disclosure).
   *
   * A malformed value (anything that is not a valid `Date`) yields `[]`
   * from BOTH backends — see `isUsableDateBound` below.
   *
   * Ordering interaction: NONE, as of F2 (2026-08-10). `listPending` orders
   * by `needed_by` first for EVERY call, bound or no bound, so setting this
   * option no longer switches the sort — see the interface doc comment below.
   */
  neededByBefore?: Date;
  /**
   * Review follow-up K3 (2026-08-09) — INCLUSIVE lower bound
   * (`needed_by >= neededByFrom`). The companion that turns
   * `neededByBefore`'s open-ended window into a bracketed one, so a caller
   * can ask "what is due ON this day" rather than only "what is due by
   * this day (including everything ever overdue)".
   *
   * Same NULL semantics and same malformed-value posture as
   * `neededByBefore`, and — since F2 — the same non-effect on ordering:
   * `listPending` sorts by `needed_by` whether a bound is given or not.
   */
  neededByFrom?: Date;
  /**
   * Cap the number of rows returned, applied at the repo/SQL boundary —
   * NOT sliced app-side after an unbounded fetch (quality-review I4, Task
   * 9: `lookup_materials` used to load every pending row for the tenant
   * just to speak 5 of them — a shopping list is append-mostly, only
   * `markPurchased` prunes it, so that only gets worse over a tenant's
   * lifetime). Rows come back in `listPending`'s ONE ordering (soonest-
   * `needed_by` first, undated last — see the interface doc comment), so
   * `limit: N` yields the N MOST URGENT rows, not an arbitrary N.
   *
   * That pairing is the whole point of F2: this option and the ordering are
   * a single decision. Whatever the ordering puts last is what a capped
   * caller never sees, so the ordering has to put the least-consequential
   * rows there.
   */
  limit?: number;
}

/**
 * Shared malformed-bound guard for `neededByFrom`/`neededByBefore` (review
 * follow-up J2, 2026-08-09). Used by BOTH backends so one input can never
 * take two different branches.
 *
 * Before this existed, `pg-material-item.ts` gated on `instanceof Date` and
 * `material-item.ts` gated on truthiness. An ISO STRING that crossed a
 * queue/JSON boundary therefore made Pg emit no date predicate at all —
 * answering a date-scoped question with the tenant's WHOLE pending list —
 * while InMemory threw a raw `TypeError` from `.getTime()`. Same input,
 * opposite outcomes, and the production backend took the dangerous branch,
 * contradicting the posture stated twenty lines above it in the same
 * function ("a malformed jobId must return [] — silently dropping the
 * filter would be worse").
 *
 * `new Date('nonsense')` is also rejected: it IS `instanceof Date`, but its
 * time is NaN, and every comparison against NaN is false — which in SQL
 * three-valued logic and in JS alike quietly returns the wrong row set
 * rather than failing.
 *
 * Callers treat `false` as "return []", matching the `jobId` precedent: a
 * malformed filter narrows to nothing, never widens.
 */
export function isUsableDateBound(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * `true` when the caller supplied a `needed_by` bound at all (valid or not).
 * Distinguishing "no bound" from "malformed bound" is what lets both
 * backends return `[]` for the latter instead of silently answering the
 * unfiltered question.
 */
export function hasDateBound(options?: MaterialItemListOptions): boolean {
  return options?.neededByBefore !== undefined || options?.neededByFrom !== undefined;
}

/** `true` when every supplied `needed_by` bound is a usable Date. */
export function dateBoundsAreValid(options?: MaterialItemListOptions): boolean {
  if (options?.neededByBefore !== undefined && !isUsableDateBound(options.neededByBefore)) return false;
  if (options?.neededByFrom !== undefined && !isUsableDateBound(options.neededByFrom)) return false;
  return true;
}

export interface MaterialItemRepository {
  create(input: CreateMaterialItemInput): Promise<MaterialItem>;
  /**
   * Pending items for a tenant, optionally scoped to a job and/or a
   * needed-by window (`options.neededByFrom` / `options.neededByBefore`).
   *
   * ORDERING — ONE ordering, for every call, bound or no bound (F2,
   * 2026-08-10):
   *
   *   Pg:       `needed_by ASC NULLS LAST, created_at ASC, id ASC`
   *   InMemory: the same, then insertion order (Array.prototype.sort is
   *             stable) where Pg would use `id`
   *
   * There used to be TWO: date-scoped calls ordered by `needed_by`, and the
   * default ordered `created_at ASC`. #819 fixed the date-scoped ask; the
   * default kept the original defect. `lookup_materials` fetches 6 rows and
   * speaks 5, so under `created_at ASC` the five oldest-CREATED rows owned
   * the whole answer to "what do I need?" and an item due tomorrow was never
   * mentioned — and since a shopping list is append-mostly (only
   * `markPurchased` prunes it), those same five rows owned it permanently
   * rather than self-correcting. An ordering paired with a cap decides what
   * the caller never hears, so it has to demote the least consequential rows.
   *
   * NULLS LAST is what keeps that honest. An item with no `needed_by` has no
   * deadline; it is not infinitely urgent, so it sorts AFTER every dated item
   * rather than ahead of them. (It is also unreachable on a date-scoped call:
   * a `needed_by` predicate already excludes NULL rows, which is why
   * collapsing the two orderings into one changed nothing for that shape.)
   *
   * TIE-BREAKING (corrected 2026-08-09, review follow-up J1 — the previous
   * version of this comment claimed InMemory "never ties by construction",
   * which was FALSE and shipped a real mock/prod divergence):
   *
   * `needed_by` ties are the NORMAL case, not an edge case:
   * `add-material-handler.ts` writes every voice-captured date as
   * ``new Date(`${neededBy}T00:00:00Z`)``, so two items due the same day are
   * EXACTLY equal on that key. Before `created_at` was added to the Pg sort,
   * such rows fell through to `id ASC` — a random v4 UUID — while InMemory's
   * stable sort gave insertion order, so with `lookup_materials`'s 5-item
   * spoken cap the two backends spoke DIFFERENT SUBSETS of the same data.
   * (Every pre-existing test constructed distinct `neededBy` values, so none
   * of them could see it.)
   *
   * `created_at` makes them agree in practice: in Pg it is the DB clock
   * (`NOW()`, microsecond precision, one transaction per `create()`), so it
   * effectively never ties; in InMemory it is a JS `Date` at millisecond
   * precision, which CAN tie on rapid successive creates — and among those
   * ties InMemory yields insertion order where Pg would yield `id` order.
   * That residual divergence is reachable only in a mock that creates two
   * rows inside one millisecond that tie on the leading key — an identical
   * `needed_by`, or (since F2 folded them into the same sort) both undated;
   * it is
   * deliberately left rather than adding an `id` tie-break to InMemory,
   * because insertion order is the more useful (and more truthful) answer
   * for a fake, and an `id` tie-break there would make every "N oldest"
   * assertion in the suite nondeterministic.
   *
   * A malformed `needed_by` bound returns `[]` from both backends — see
   * `isUsableDateBound`.
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
    // A malformed date bound narrows to nothing, exactly like a malformed
    // jobId — never a silently widened list (J2, isUsableDateBound).
    if (!dateBoundsAreValid(options)) return [];
    const dateScoped = hasDateBound(options);
    const before = options?.neededByBefore;
    const from = options?.neededByFrom;
    const filtered = Array.from(this.items.values())
      .filter((i) => i.tenantId === tenantId)
      .filter((i) => i.status === 'pending')
      .filter((i) => !options?.jobId || i.jobId === options.jobId)
      // NULL/undefined neededBy never matches a date-scoped query — see
      // MaterialItemListOptions.neededByBefore's doc comment for why (an
      // undated item has no known deadline). Mirrors the Pg backend's bare
      // `needed_by < $1` / `needed_by >= $1`, which exclude NULL for the same
      // reason without needing this explicit check.
      .filter((i) => !dateScoped || i.neededBy !== undefined)
      .filter((i) => !before || i.neededBy!.getTime() < before.getTime())
      .filter((i) => !from || i.neededBy!.getTime() >= from.getTime());
    // F2 — ONE ordering for every shape, mirroring Pg's
    // `needed_by ASC NULLS LAST, created_at ASC, id ASC`. `sort` is stable,
    // so a created_at tie keeps insertion order here (the one deliberate
    // residual divergence — see MaterialItemRepository.listPending's doc
    // comment). `undefined` neededBy sorts LAST, never first: an item with no
    // deadline is not infinitely urgent.
    const sorted = filtered.sort((a, b) => {
      const an = a.neededBy?.getTime();
      const bn = b.neededBy?.getTime();
      if (an !== bn) {
        if (an === undefined) return 1;
        if (bn === undefined) return -1;
        return an - bn;
      }
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
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
