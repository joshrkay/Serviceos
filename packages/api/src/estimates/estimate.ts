import { v4 as uuidv4 } from 'uuid';
import { LineItem, DocumentTotals, calculateDocumentTotals } from '../shared/billing-engine';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ValidationError, ConflictError } from '../shared/errors';
import { RefreshJobMoneyStateDeps, refreshJobMoneyStateSafe } from '../jobs/job-money-state';
import { DocumentRevisionRepository, createRevision } from '../ai/document-revision';
import { EditDeltaRepository, createEditDelta } from './edit-delta';
import { Logger } from '../logging/logger';

export type EstimateStatus = 'draft' | 'ready_for_review' | 'sent' | 'accepted' | 'rejected' | 'expired';

export interface Estimate {
  id: string;
  tenantId: string;
  jobId: string;
  estimateNumber: string;
  status: EstimateStatus;
  lineItems: LineItem[];
  totals: DocumentTotals;
  validUntil?: Date;
  customerMessage?: string;
  internalNotes?: string;
  /** Random URL-safe token for unauthenticated customer view links. Set on first send. */
  viewToken?: string;
  /** Timestamp the view_token becomes invalid (typically sent_at + 90 days). */
  viewTokenExpiresAt?: Date;
  /** Timestamp of the FIRST send (set-once); re-sends/reminders don't move it. */
  sentAt?: Date;
  /** ID of the most recent message_dispatches row. */
  lastDispatchId?: string;
  /** First time the customer opened the public link. */
  firstViewedAt?: Date;
  /** Total number of times the public link has been opened. */
  viewCount?: number;
  /** Customer-side acceptance — captured at the public approval route. */
  acceptedAt?: Date;
  acceptedByName?: string;
  acceptedByIp?: string;
  acceptedUserAgent?: string;
  /** Base64-encoded data URL of the signature canvas, if collected. */
  acceptedSignatureData?: string;
  /** Customer-side decline. */
  rejectedAt?: Date;
  rejectedReason?: string;
  /**
   * Optimistic-lock + customer re-sync counter. Starts at 1 on create
   * and increments on every persisted content change (edit or revise).
   * The authenticated edit path and the public approve path both compare
   * an expected version to reject stale writes; the customer approval
   * page reads it to detect that an estimate changed after page load.
   */
  version: number;
  /** Most recent revise of an already-sent estimate. */
  lastRevisedAt?: Date;
  /** How many follow-up reminders the estimate-reminder worker has sent. */
  reminderCount?: number;
  /** Timestamp of the most recent reminder nudge. */
  lastReminderAt?: Date;
  /**
   * Good-better-best: the estimate_line_item ids the customer chose at
   * accept time. Locked on approval so a later revise can't change what
   * was agreed to; the converted invoice bills exactly these items plus
   * the always-included ones. Undefined when the estimate has no
   * selectable items.
   */
  acceptedSelection?: string[];
  /** Soft-delete marker. Non-null hides the estimate from all reads. */
  deletedAt?: Date;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEstimateInput {
  tenantId: string;
  jobId: string;
  estimateNumber: string;
  lineItems: LineItem[];
  discountCents?: number;
  taxRateBps?: number;
  validUntil?: Date;
  customerMessage?: string;
  internalNotes?: string;
  createdBy: string;
}

export interface UpdateEstimateInput {
  lineItems?: LineItem[];
  discountCents?: number;
  taxRateBps?: number;
  validUntil?: Date;
  customerMessage?: string;
  internalNotes?: string;
  /**
   * Optimistic-lock guard. When provided and it doesn't match the
   * estimate's current `version`, the edit is rejected with a
   * ConflictError so a concurrent edit can't be silently clobbered.
   */
  expectedVersion?: number;
}

/**
 * Repositories + actor context needed to snapshot a revision, record an
 * edit delta, and emit an audit event when an estimate is mutated. All
 * optional so callers (and older test harnesses) that don't wire the
 * revision subsystem still work — the mutation just skips history.
 */
export interface EstimateMutationDeps {
  auditRepo?: AuditRepository;
  docRevisionRepo?: DocumentRevisionRepository;
  editDeltaRepo?: EditDeltaRepository;
  actorId?: string;
  actorRole?: string;
  /** When set, history/audit recording failures are logged (best-effort). */
  logger?: Logger;
  /**
   * Deposit already collected on the linked job, in cents. When > 0 the
   * estimate is financially committed and edit/revise is refused. Callers
   * that can resolve the job pass this; when omitted the deposit lock is
   * skipped (status lock still applies).
   */
  depositPaidCents?: number;
}

export interface EstimateListOptions {
  status?: EstimateStatus;
  jobId?: string;
  /** ILIKE search on estimate_number / customer_message. */
  search?: string;
  /** Pagination cap. Default 50, hard-capped server-side at 200. */
  limit?: number;
  /** Pagination offset. Default 0. */
  offset?: number;
  /** Sort direction applied to the canonical sort column (created_at). */
  sort?: 'asc' | 'desc';
  /** Only estimates whose `sentAt` is strictly before this. Used by the
   *  estimate-reminder worker to find aging sent estimates. */
  sentBefore?: Date;
}

export interface EstimateListResult {
  data: Estimate[];
  total: number;
}

export const DEFAULT_ESTIMATE_LIMIT = 50;
export const MAX_ESTIMATE_LIMIT = 200;

export interface EstimateRepository {
  create(estimate: Estimate): Promise<Estimate>;
  findById(tenantId: string, id: string): Promise<Estimate | null>;
  findByJob(tenantId: string, jobId: string): Promise<Estimate[]>;
  /**
   * Batched findByJob — all estimates for many jobs in ONE query instead of N.
   * Used by the invoicing queue / batch sweep to avoid an N+1 over completed
   * jobs. Excludes soft-deleted rows; callers group by jobId.
   */
  findByJobs(tenantId: string, jobIds: string[]): Promise<Estimate[]>;
  findByTenant(tenantId: string, options?: EstimateListOptions): Promise<Estimate[]>;
  /** P1-018: paginated `{ data, total }` form for list UIs. */
  listWithMeta?(tenantId: string, options?: EstimateListOptions): Promise<EstimateListResult>;
  update(tenantId: string, id: string, updates: Partial<Estimate>): Promise<Estimate | null>;
  /**
   * Public lookup by view-token. Used by unauthenticated customer-facing
   * routes (`/public/estimates/:token`). Bypasses tenant scoping at the
   * call site — the token IS the auth — but should still apply RLS in
   * the Pg implementation by switching tenant context after a token-only
   * lookup. Returns null if no estimate with this token exists.
   */
  findByViewToken?(token: string): Promise<Estimate | null>;
}

export const ESTIMATE_STATUS_TRANSITIONS: Record<EstimateStatus, EstimateStatus[]> = {
  draft: ['ready_for_review', 'sent'],
  ready_for_review: ['sent', 'draft'],
  sent: ['accepted', 'rejected', 'expired'],
  accepted: [],
  rejected: ['draft'],
  expired: ['draft'],
};

export function validateEstimateInput(input: CreateEstimateInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.jobId) errors.push('jobId is required');
  if (!input.estimateNumber) errors.push('estimateNumber is required');
  if (!input.createdBy) errors.push('createdBy is required');
  if (!input.lineItems || input.lineItems.length === 0) {
    errors.push('At least one line item is required');
  }
  return errors;
}

export function isValidEstimateTransition(from: EstimateStatus, to: EstimateStatus): boolean {
  return ESTIMATE_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export async function createEstimate(
  input: CreateEstimateInput,
  repository: EstimateRepository,
  auditRepo?: AuditRepository
): Promise<Estimate> {
  const errors = validateEstimateInput(input);
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  const totals = calculateDocumentTotals(
    input.lineItems,
    input.discountCents ?? 0,
    input.taxRateBps ?? 0
  );

  const estimate: Estimate = {
    id: uuidv4(),
    tenantId: input.tenantId,
    jobId: input.jobId,
    estimateNumber: input.estimateNumber,
    status: 'draft',
    lineItems: input.lineItems,
    totals,
    validUntil: input.validUntil,
    customerMessage: input.customerMessage,
    internalNotes: input.internalNotes,
    version: 1,
    createdBy: input.createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const created = await repository.create(estimate);

  if (auditRepo) {
    const event = createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.createdBy,
      actorRole: 'unknown',
      eventType: 'estimate.created',
      entityType: 'estimate',
      entityId: created.id,
    });
    await auditRepo.create(event);
  }

  return created;
}

export async function listEstimates(
  tenantId: string,
  repository: EstimateRepository,
  options?: EstimateListOptions
): Promise<Estimate[]> {
  return repository.findByTenant(tenantId, options);
}

/**
 * P1-018: paginated estimate list. Falls back to in-memory pagination over
 * `findByTenant` when the repo doesn't yet implement `listWithMeta`.
 */
export async function listEstimatesWithMeta(
  tenantId: string,
  repository: EstimateRepository,
  options?: EstimateListOptions
): Promise<EstimateListResult> {
  if (repository.listWithMeta) {
    return repository.listWithMeta(tenantId, options);
  }
  const all = await repository.findByTenant(tenantId, { ...options, limit: undefined, offset: undefined });
  const limit = Math.min(options?.limit ?? DEFAULT_ESTIMATE_LIMIT, MAX_ESTIMATE_LIMIT);
  const offset = options?.offset ?? 0;
  return { data: all.slice(offset, offset + limit), total: all.length };
}

export async function getEstimate(
  tenantId: string,
  id: string,
  repository: EstimateRepository
): Promise<Estimate | null> {
  return repository.findById(tenantId, id);
}

/**
 * Single source of truth for "can this estimate's contents change right
 * now". Used by the authenticated edit path, the voice edit path
 * (estimate-editor.ts), and the revise path so the lock rules can't
 * drift between them.
 *
 * Locks (throw ConflictError):
 *   - `accepted`: the customer has accepted/signed — immutable.
 *   - linked job has a paid deposit — financial commitment made.
 *   - `sent` without `allowSent`: must go through reviseEstimate so the
 *     prior version is snapshotted and the customer is re-notified.
 *   - `rejected` / `expired`: reopen to draft first (status transition).
 */
export function assertEstimateEditable(
  estimate: Estimate,
  opts: { allowSent?: boolean; depositPaidCents?: number } = {},
): void {
  if (estimate.status === 'accepted') {
    throw new ConflictError(
      'Estimate is locked: the customer has already accepted/signed it. Clone it to a new estimate to make changes.',
    );
  }
  if ((opts.depositPaidCents ?? 0) > 0) {
    throw new ConflictError(
      'Estimate is locked: a deposit has already been paid. Clone it to a new estimate to make changes.',
    );
  }
  if (estimate.status === 'rejected' || estimate.status === 'expired') {
    throw new ValidationError(
      `Cannot edit estimate in '${estimate.status}' status. Reopen it to draft first.`,
    );
  }
  if (estimate.status === 'sent' && !opts.allowSent) {
    throw new ConflictError(
      "Cannot edit a sent estimate directly. Use the revise flow so the customer is re-notified of the change.",
    );
  }
}

function assertVersionMatch(existing: Estimate, expectedVersion?: number): void {
  if (expectedVersion !== undefined && expectedVersion !== existing.version) {
    throw new ConflictError(
      `Estimate has changed (expected version ${expectedVersion}, current ${existing.version}). Reload and retry.`,
    );
  }
}

function snapshotOf(estimate: Estimate): Record<string, unknown> {
  return {
    lineItems: estimate.lineItems,
    discountCents: estimate.totals.discountCents,
    taxRateBps: estimate.totals.taxRateBps,
    customerMessage: estimate.customerMessage,
    validUntil: estimate.validUntil?.toISOString(),
    status: estimate.status,
    version: estimate.version,
  };
}

/**
 * Record a revision snapshot, an edit delta, and an audit event for an
 * estimate mutation. Best-effort: history/audit failures never roll back
 * a write the customer/operator already saw succeed. No-ops when the
 * revision repos aren't wired.
 */
async function recordEstimateHistory(
  before: Estimate,
  after: Estimate,
  eventType: 'estimate.updated' | 'estimate.revised',
  deps?: EstimateMutationDeps,
): Promise<void> {
  if (!deps) return;
  const actorId = deps.actorId ?? 'system';
  const actorRole = deps.actorRole ?? 'unknown';
  try {
    if (deps.docRevisionRepo && deps.editDeltaRepo) {
      const fromRev = await createRevision(
        {
          tenantId: before.tenantId,
          documentType: 'estimate',
          documentId: before.id,
          snapshot: snapshotOf(before),
          source: 'manual',
          actorId,
          actorRole,
        },
        deps.docRevisionRepo,
      );
      const toRev = await createRevision(
        {
          tenantId: after.tenantId,
          documentType: 'estimate',
          documentId: after.id,
          snapshot: snapshotOf(after),
          source: 'manual',
          actorId,
          actorRole,
        },
        deps.docRevisionRepo,
      );
      await createEditDelta(
        after.tenantId,
        after.id,
        fromRev.id,
        toRev.id,
        {
          lineItems: before.lineItems,
          discountCents: before.totals.discountCents,
          taxRateBps: before.totals.taxRateBps,
          customerMessage: before.customerMessage,
        },
        {
          lineItems: after.lineItems,
          discountCents: after.totals.discountCents,
          taxRateBps: after.totals.taxRateBps,
          customerMessage: after.customerMessage,
        },
        deps.editDeltaRepo,
      );
    }
    if (deps.auditRepo) {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: after.tenantId,
          actorId,
          actorRole,
          eventType,
          entityType: 'estimate',
          entityId: after.id,
          metadata: {
            estimateNumber: after.estimateNumber,
            fromVersion: before.version,
            toVersion: after.version,
            totalCents: after.totals.totalCents,
          },
        }),
      );
    }
  } catch (err) {
    // History/audit is best-effort and must not fail the mutation — but a
    // silent drop hides a missing audit trail on a financial change, so log it.
    deps.logger?.warn('estimate history/audit recording failed', {
      estimateId: after.id,
      eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function updateEstimate(
  tenantId: string,
  id: string,
  input: UpdateEstimateInput,
  repository: EstimateRepository,
  deps?: EstimateMutationDeps,
): Promise<Estimate | null> {
  const existing = await repository.findById(tenantId, id);
  if (!existing) return null;

  assertEstimateEditable(existing, { depositPaidCents: deps?.depositPaidCents });
  assertVersionMatch(existing, input.expectedVersion);

  const lineItems = input.lineItems ?? existing.lineItems;
  const discountCents = input.discountCents ?? existing.totals.discountCents;
  const taxRateBps = input.taxRateBps ?? existing.totals.taxRateBps;
  const totals = calculateDocumentTotals(lineItems, discountCents, taxRateBps);

  const updated = await repository.update(tenantId, id, {
    lineItems,
    totals,
    validUntil: input.validUntil ?? existing.validUntil,
    customerMessage: input.customerMessage ?? existing.customerMessage,
    internalNotes: input.internalNotes ?? existing.internalNotes,
    version: existing.version + 1,
    updatedAt: new Date(),
  });

  if (updated) {
    await recordEstimateHistory(existing, updated, 'estimate.updated', deps);
  }
  return updated;
}

/**
 * Revise an estimate that has already been SENT. Unlike updateEstimate
 * (which only touches draft/ready_for_review), this snapshots the prior
 * version, applies the edit, bumps `version`, and stamps `lastRevisedAt`
 * while keeping the estimate in `sent` (the view token/link is
 * preserved). The caller is expected to re-send so the customer is
 * notified; the public approve path compares `version` so the customer
 * can't accept the stale revision.
 */
export async function reviseEstimate(
  tenantId: string,
  id: string,
  input: UpdateEstimateInput,
  repository: EstimateRepository,
  deps?: EstimateMutationDeps,
): Promise<Estimate | null> {
  const existing = await repository.findById(tenantId, id);
  if (!existing) return null;

  if (existing.status !== 'sent') {
    throw new ValidationError(
      `Only a sent estimate can be revised (current status: '${existing.status}'). Edit drafts with the standard update.`,
    );
  }
  assertEstimateEditable(existing, { allowSent: true, depositPaidCents: deps?.depositPaidCents });
  assertVersionMatch(existing, input.expectedVersion);

  const lineItems = input.lineItems ?? existing.lineItems;
  const discountCents = input.discountCents ?? existing.totals.discountCents;
  const taxRateBps = input.taxRateBps ?? existing.totals.taxRateBps;
  const totals = calculateDocumentTotals(lineItems, discountCents, taxRateBps);
  const now = new Date();

  const updated = await repository.update(tenantId, id, {
    lineItems,
    totals,
    validUntil: input.validUntil ?? existing.validUntil,
    customerMessage: input.customerMessage ?? existing.customerMessage,
    internalNotes: input.internalNotes ?? existing.internalNotes,
    version: existing.version + 1,
    lastRevisedAt: now,
    // Reset the reminder budget so the estimate-reminder worker re-notifies
    // the customer about the revised pricing even if it already reminded
    // (or the customer already viewed) the prior version.
    reminderCount: 0,
    updatedAt: now,
  });

  if (updated) {
    await recordEstimateHistory(existing, updated, 'estimate.revised', deps);
  }
  return updated;
}

export async function transitionEstimateStatus(
  tenantId: string,
  id: string,
  newStatus: EstimateStatus,
  repository: EstimateRepository,
  moneyStateDeps?: RefreshJobMoneyStateDeps,
): Promise<Estimate | null> {
  const estimate = await repository.findById(tenantId, id);
  if (!estimate) return null;

  if (!isValidEstimateTransition(estimate.status, newStatus)) {
    throw new ValidationError(`Invalid transition from ${estimate.status} to ${newStatus}`);
  }

  const updated = await repository.update(tenantId, id, { status: newStatus, updatedAt: new Date() });

  // §6 Time-to-Cash. Best-effort job money-state rollup.
  if (updated && moneyStateDeps) {
    await refreshJobMoneyStateSafe(tenantId, updated.jobId, 'system', moneyStateDeps);
  }

  return updated;
}

/**
 * Soft-delete an estimate. An `accepted` estimate is financially
 * committed (the customer signed; an invoice may have been converted)
 * and is never deletable — callers should clone it instead. Sets
 * `deleted_at`, which removes the estimate from every read path, emits
 * an `estimate.deleted` audit event, and rolls up the linked job's
 * money state. Returns null when the estimate doesn't exist.
 */
export async function softDeleteEstimate(
  tenantId: string,
  id: string,
  repository: EstimateRepository,
  deps?: EstimateMutationDeps,
  moneyStateDeps?: RefreshJobMoneyStateDeps,
): Promise<Estimate | null> {
  const existing = await repository.findById(tenantId, id);
  if (!existing) return null;

  if (existing.status === 'accepted') {
    throw new ConflictError(
      'Cannot delete an accepted estimate. Clone it if you need a fresh draft.',
    );
  }

  const now = new Date();
  const updated = await repository.update(tenantId, id, { deletedAt: now, updatedAt: now });
  if (!updated) return null;

  if (deps?.auditRepo) {
    try {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: deps.actorId ?? 'system',
          actorRole: deps.actorRole ?? 'unknown',
          eventType: 'estimate.deleted',
          entityType: 'estimate',
          entityId: id,
          metadata: { estimateNumber: existing.estimateNumber, status: existing.status },
        }),
      );
    } catch (err) {
      deps.logger?.warn('estimate delete audit recording failed', {
        estimateId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (moneyStateDeps) {
    await refreshJobMoneyStateSafe(tenantId, existing.jobId, deps?.actorId ?? 'system', moneyStateDeps);
  }

  return updated;
}

/**
 * Clone an estimate into a fresh DRAFT on the same job. Copies the line
 * items (including good-better-best grouping), discount, tax rate, and
 * customer message; resets all lifecycle state (status, version, token,
 * sent/accepted/rejected/reminder fields). The new estimate gets its own
 * estimate number. This is the path the edit/delete locks point users to
 * ("clone it to a new estimate to make changes").
 */
export async function cloneEstimate(
  tenantId: string,
  id: string,
  newEstimateNumber: string,
  actorId: string,
  repository: EstimateRepository,
  auditRepo?: AuditRepository,
): Promise<Estimate | null> {
  const existing = await repository.findById(tenantId, id);
  if (!existing) return null;

  const now = new Date();
  const clone: Estimate = {
    id: uuidv4(),
    tenantId,
    jobId: existing.jobId,
    estimateNumber: newEstimateNumber,
    status: 'draft',
    lineItems: existing.lineItems.map((li) => ({ ...li, id: uuidv4() })),
    totals: calculateDocumentTotals(
      existing.lineItems,
      existing.totals.discountCents,
      existing.totals.taxRateBps,
    ),
    validUntil: existing.validUntil,
    customerMessage: existing.customerMessage,
    internalNotes: existing.internalNotes,
    version: 1,
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  };

  const created = await repository.create(clone);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: 'unknown',
        eventType: 'estimate.cloned',
        entityType: 'estimate',
        entityId: created.id,
        metadata: {
          estimateNumber: created.estimateNumber,
          clonedFromId: existing.id,
          clonedFromNumber: existing.estimateNumber,
        },
      }),
    );
  }

  return created;
}

export class InMemoryEstimateRepository implements EstimateRepository {
  private estimates: Map<string, Estimate> = new Map();

  async create(estimate: Estimate): Promise<Estimate> {
    this.estimates.set(estimate.id, { ...estimate, lineItems: [...estimate.lineItems] });
    return { ...estimate, lineItems: [...estimate.lineItems] };
  }

  async findById(tenantId: string, id: string): Promise<Estimate | null> {
    const e = this.estimates.get(id);
    if (!e || e.tenantId !== tenantId || e.deletedAt) return null;
    return { ...e, lineItems: [...e.lineItems] };
  }

  async findByJob(tenantId: string, jobId: string): Promise<Estimate[]> {
    return Array.from(this.estimates.values())
      .filter((e) => e.tenantId === tenantId && e.jobId === jobId && !e.deletedAt)
      .map((e) => ({ ...e, lineItems: [...e.lineItems] }));
  }

  async findByJobs(tenantId: string, jobIds: string[]): Promise<Estimate[]> {
    const wanted = new Set(jobIds);
    return Array.from(this.estimates.values())
      .filter((e) => e.tenantId === tenantId && wanted.has(e.jobId) && !e.deletedAt)
      .map((e) => ({ ...e, lineItems: [...e.lineItems] }));
  }

  async findByTenant(tenantId: string, options?: EstimateListOptions): Promise<Estimate[]> {
    let results = Array.from(this.estimates.values()).filter((e) => e.tenantId === tenantId && !e.deletedAt);
    if (options?.status) results = results.filter((e) => e.status === options.status);
    if (options?.jobId) results = results.filter((e) => e.jobId === options.jobId);
    if (options?.sentBefore) {
      const cutoff = options.sentBefore.getTime();
      results = results.filter((e) => e.sentAt !== undefined && e.sentAt.getTime() < cutoff);
    }
    if (options?.search) {
      const q = options.search.toLowerCase();
      results = results.filter(
        (e) =>
          e.estimateNumber.toLowerCase().includes(q) ||
          (e.customerMessage && e.customerMessage.toLowerCase().includes(q))
      );
    }
    // Default sort: createdAt DESC. P1-018 lets callers flip to ASC.
    const sortDir = options?.sort === 'asc' ? 1 : -1;
    results.sort((a, b) => sortDir * (a.createdAt.getTime() - b.createdAt.getTime()));
    if (options?.offset !== undefined || options?.limit !== undefined) {
      const offset = options?.offset ?? 0;
      const limit = options?.limit !== undefined
        ? Math.min(options.limit, MAX_ESTIMATE_LIMIT)
        : results.length;
      results = results.slice(offset, offset + limit);
    }
    return results.map((e) => ({ ...e, lineItems: [...e.lineItems] }));
  }

  async listWithMeta(tenantId: string, options?: EstimateListOptions): Promise<EstimateListResult> {
    const totalRows = await this.findByTenant(tenantId, {
      ...options,
      limit: undefined,
      offset: undefined,
    });
    const data = await this.findByTenant(tenantId, options);
    return { data, total: totalRows.length };
  }

  async update(tenantId: string, id: string, updates: Partial<Estimate>): Promise<Estimate | null> {
    const e = this.estimates.get(id);
    if (!e || e.tenantId !== tenantId) return null;
    const updated = { ...e, ...updates };
    this.estimates.set(id, updated);
    return { ...updated, lineItems: [...updated.lineItems] };
  }

  async findByViewToken(token: string): Promise<Estimate | null> {
    for (const e of this.estimates.values()) {
      if (e.viewToken === token && !e.deletedAt) {
        return { ...e, lineItems: [...e.lineItems] };
      }
    }
    return null;
  }
}
