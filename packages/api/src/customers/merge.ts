/**
 * Story 4.6 — Customer merge.
 *
 * Consolidates two customer records onto a single explicitly-chosen
 * survivor: every child row (jobs — and the invoices/estimates/
 * appointments that hang off them — service locations, agreements,
 * credits, payment methods, contacts, tags, custom-field values, voice
 * and portal sessions, conversations and notes) is re-parented from the
 * losing record to the survivor, then the loser is archived
 * (non-destructive — the audit event records the full mapping so a merge
 * can be reversed by hand). The reassignment + archive run inside one
 * tenant-scoped transaction so a merge is all-or-nothing.
 *
 * Money never moves between customers as cents — only the foreign keys
 * pointing at the records are repointed. AI never triggers this: it's a
 * deterministic action a human invokes from the duplicate card / detail
 * page. The mutation emits a `customer.merged` audit event.
 *
 * Out of scope (intentionally left on the archived loser): append-only
 * telemetry — lookup_events, vulnerability_signals, triage_events,
 * consent_events — which are historical signals keyed to the call that
 * produced them, not customer-facing history.
 */
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { NotFoundError, ValidationError } from '../shared/errors';
import { CustomerRepository } from './customer';

export interface CustomerMergeRepository {
  /**
   * Atomically re-parent every child row from `losingId` to
   * `survivingId` and archive the losing customer, all within one
   * tenant-scoped transaction. `tenantId` is the first predicate of every
   * statement (defense-in-depth alongside RLS). Returns the rows-moved
   * count per table for the audit trail.
   */
  reassignAndArchive(
    tenantId: string,
    survivingId: string,
    losingId: string,
  ): Promise<Record<string, number>>;
}

export interface MergeCustomersInput {
  /** The record that survives — chosen explicitly by the operator. */
  survivingId: string;
  /** The duplicate record whose history is folded in, then archived. */
  losingId: string;
  actorId: string;
  actorRole?: string;
}

export interface CustomerMergeResult {
  survivingId: string;
  losingId: string;
  /** Rows re-parented per table — surfaced on the merge audit event. */
  movedCounts: Record<string, number>;
}

/**
 * Validate the pair, perform the atomic re-parent + archive, and record
 * the merge in the audit log. Throws `ValidationError` / `NotFoundError`
 * for bad input so the route maps them to 400 / 404.
 */
export async function mergeCustomers(
  tenantId: string,
  input: MergeCustomersInput,
  deps: {
    customerRepo: CustomerRepository;
    mergeRepo: CustomerMergeRepository;
    auditRepo?: AuditRepository;
  },
): Promise<CustomerMergeResult> {
  if (!input.survivingId || !input.losingId) {
    throw new ValidationError('survivingId and losingId are required');
  }
  if (input.survivingId === input.losingId) {
    throw new ValidationError('Cannot merge a customer into itself');
  }

  const surviving = await deps.customerRepo.findById(tenantId, input.survivingId);
  if (!surviving) throw new NotFoundError('Surviving customer', input.survivingId);
  if (surviving.isArchived) {
    throw new ValidationError('Cannot merge into an archived customer');
  }

  const losing = await deps.customerRepo.findById(tenantId, input.losingId);
  if (!losing) throw new NotFoundError('Losing customer', input.losingId);
  if (losing.isArchived) {
    throw new ValidationError('Losing customer is already archived');
  }

  const movedCounts = await deps.mergeRepo.reassignAndArchive(
    tenantId,
    input.survivingId,
    input.losingId,
  );

  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: input.actorId,
        actorRole: input.actorRole ?? 'unknown',
        eventType: 'customer.merged',
        entityType: 'customer',
        entityId: input.survivingId,
        metadata: {
          losingId: input.losingId,
          losingDisplayName: losing.displayName,
          movedCounts,
        },
      }),
    );
  }

  return { survivingId: input.survivingId, losingId: input.losingId, movedCounts };
}

/**
 * In-memory merge repository for unit tests and the no-database dev path.
 * The in-memory stores have no child tables to re-parent, so this only
 * archives the loser (the customer-facing effect: the duplicate drops out
 * of the active list). Cross-table re-parenting is the Pg repo's job and is
 * proven by the merge integration test.
 */
export class InMemoryCustomerMergeRepository implements CustomerMergeRepository {
  constructor(private readonly customerRepo: CustomerRepository) {}

  async reassignAndArchive(
    tenantId: string,
    _survivingId: string,
    losingId: string,
  ): Promise<Record<string, number>> {
    await this.customerRepo.update(tenantId, losingId, {
      isArchived: true,
      archivedAt: new Date(),
      updatedAt: new Date(),
    });
    return {};
  }
}
