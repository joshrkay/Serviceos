import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import {
  Invoice,
  InvoiceRepository,
  isValidInvoiceTransition,
} from '../../invoices/invoice';
import {
  RefreshJobMoneyStateDeps,
  refreshJobMoneyStateSafe,
} from '../../jobs/job-money-state';
import { SettingsRepository } from '../../settings/settings';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { AppError } from '../../shared/errors';
import {
  addCalendarDays,
  isValidTimezone,
  tzMidnight,
} from '../../shared/timezone';
import { issueInvoicePayloadSchema } from '../contracts/issue-invoice';

const DEFAULT_PAYMENT_TERM_DAYS = 30;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Typed domain error: the target invoice is not in `draft` status, so it
 * cannot be issued. The execution handler catches this and returns a
 * failed ExecutionResult (the executor records `execution_failed`
 * cleanly); it is never thrown through to the caller.
 */
export class InvoiceNotDraftError extends AppError {
  readonly invoiceStatus: string;

  constructor(invoiceNumber: string, status: string) {
    super(
      'INVOICE_NOT_DRAFT',
      `Invoice ${invoiceNumber} cannot be issued — it is currently "${status}". Only draft invoices can be issued.`,
      409,
    );
    this.invoiceStatus = status;
  }
}

/**
 * Resolves an invoice by UUID (internal ID) or by human-readable invoice
 * number (e.g. "INV-0042" or bare "0042"). Voice commands typically
 * produce the latter; the assistant platform produces the former.
 */
async function resolveInvoice(
  tenantId: string,
  ref: string,
  repo: InvoiceRepository,
): Promise<Invoice | null> {
  if (UUID_RE.test(ref)) {
    return repo.findById(tenantId, ref);
  }
  const all = await repo.findByTenant(tenantId);
  return (
    all.find(
      (i) => i.invoiceNumber === ref || i.invoiceNumber === `INV-${ref}`,
    ) ?? null
  );
}

/** Today's calendar date (YYYY-MM-DD) as seen on the wall clock in `tz`. */
function todayInTz(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: isValidTimezone(tz) ? tz : 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Executes an approved `issue_invoice` proposal (P22-002).
 *
 * Transitions the invoice draft → open, stamps `issuedAt`, computes
 * `dueDate` from the tenant's default payment terms in the tenant
 * timezone (due at tenant-local midnight, `termDays` calendar days
 * out — DST-safe via addCalendarDays), refreshes the job money-state
 * rollup, and emits an `invoice.issued` audit event (failure-soft).
 *
 * Mirrors the SendInvoiceExecutionHandler structure: degrades to a
 * synthetic-id passthrough when no invoiceRepo is wired (in-memory unit
 * tests that don't exercise the mutation path).
 *
 * Guards:
 * - Non-draft invoices are rejected with the typed InvoiceNotDraftError
 *   (returned as a failed ExecutionResult, never thrown through).
 * - Idempotent: re-executing a proposal that already issued its invoice
 *   (invoice is open and this proposal recorded it as its result, or the
 *   proposal is already marked executed) is a no-op success.
 */
export class IssueInvoiceExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'issue_invoice';

  constructor(
    private readonly invoiceRepo?: InvoiceRepository,
    private readonly settingsRepo?: SettingsRepository,
    private readonly auditRepo?: AuditRepository,
    private readonly moneyStateDeps?: RefreshJobMoneyStateDeps,
  ) {}

  async execute(
    proposal: Proposal,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const parsed = issueInvoicePayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      return {
        success: false,
        error:
          'Could not determine which invoice to issue. Please specify the invoice number (e.g. "Issue invoice INV-0042").',
      };
    }
    const { invoiceId, paymentTermDays } = parsed.data;

    if (!this.invoiceRepo) {
      // Dev wiring without a repo. Returns synthetic id.
      return { success: true, resultEntityId: uuidv4() };
    }

    const invoice = await resolveInvoice(
      context.tenantId,
      invoiceId,
      this.invoiceRepo,
    );
    if (!invoice) {
      return { success: false, error: `Invoice ${invoiceId} not found.` };
    }

    if (invoice.status !== 'draft') {
      // Idempotency: re-executing a proposal that already issued this
      // invoice is a no-op success, not a failure.
      const alreadyIssuedByThisProposal =
        invoice.status === 'open' &&
        (proposal.status === 'executed' ||
          proposal.executedAt !== undefined ||
          proposal.resultEntityId === invoice.id);
      if (alreadyIssuedByThisProposal) {
        return { success: true, resultEntityId: invoice.id };
      }
      const err = new InvoiceNotDraftError(invoice.invoiceNumber, invoice.status);
      return { success: false, error: err.message };
    }

    if (!isValidInvoiceTransition(invoice.status, 'open')) {
      return {
        success: false,
        error: `Invalid invoice status transition from ${invoice.status} to open`,
      };
    }

    // Due date from tenant payment terms, computed in the tenant timezone.
    const settings = this.settingsRepo
      ? await this.settingsRepo.findByTenant(context.tenantId)
      : null;
    const termDays =
      paymentTermDays ??
      settings?.defaultPaymentTermDays ??
      DEFAULT_PAYMENT_TERM_DAYS;
    const tz = settings?.timezone ?? 'UTC';

    const issuedAt = new Date();
    const dueDate = addCalendarDays(
      tzMidnight(todayInTz(issuedAt, tz), tz),
      termDays,
      tz,
    );

    let updated: Invoice | null;
    try {
      updated = await this.invoiceRepo.update(context.tenantId, invoice.id, {
        status: 'open',
        issuedAt,
        dueDate,
        updatedAt: new Date(),
      });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to issue invoice',
      };
    }
    if (!updated) {
      return { success: false, error: `Invoice ${invoiceId} not found.` };
    }

    // §6 Time-to-Cash. Best-effort job money-state rollup.
    if (this.moneyStateDeps) {
      await refreshJobMoneyStateSafe(
        context.tenantId,
        updated.jobId,
        'system',
        this.moneyStateDeps,
      );
    }

    // Audit emission is failure-soft: a logging failure never unwinds a
    // successful issue.
    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'voice_agent',
            eventType: 'invoice.issued',
            entityType: 'invoice',
            entityId: updated.id,
            metadata: {
              proposalId: proposal.id,
              proposalType: 'issue_invoice',
              invoiceNumber: updated.invoiceNumber,
              paymentTermDays: termDays,
              issuedAt: issuedAt.toISOString(),
              dueDate: dueDate.toISOString(),
            },
          }),
        );
      } catch {
        // swallow — audit must never fail the execution
      }
    }

    return { success: true, resultEntityId: updated.id };
  }
}
