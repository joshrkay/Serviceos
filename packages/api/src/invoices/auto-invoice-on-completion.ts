/**
 * P20-001 — Auto-draft an invoice when a job is marked complete.
 *
 * Closes the time-to-cash gap so the owner never hand-writes an invoice. On
 * the `completed` transition, if the tenant opted in and the job is billable
 * but not yet invoiced, we build line items from the accepted estimate and
 * raise a `draft_invoice` PROPOSAL — never an invoice directly. The owner
 * approves it (one SMS tap), which runs the existing draft_invoice execution
 * path; sending stays a separate, money-class step. No new proposal type.
 *
 * This is best-effort and idempotent: it no-ops when the toggle is off, when
 * the job isn't in a billable money-state, or when the job already has a live
 * invoice. Callers should not let a failure here block job completion.
 */
import { Proposal, ProposalRepository, createProposal } from '../proposals/proposal';
import { validateProposalPayload } from '../proposals/contracts';
import { Job, JobMoneyState } from '../jobs/job';
import { InvoiceRepository } from './invoice';
import { EstimateRepository } from '../estimates/estimate';
import { SettingsRepository } from '../settings/settings';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { resolveSelectedLineItems } from '../shared/billing-engine';
import { TimeEntryRepository } from '../time-tracking/time-entry';
import { recalculateLaborFromTimeEntries } from './labor-from-time-entries';
import type { InvoiceScheduleRepository } from './invoice-schedule';

const AUTO_INVOICE_ACTOR = 'system:auto_invoice';

/** One auto-drafted invoice proposal per job, ever (DB-unique per tenant). */
export function autoInvoiceIdempotencyKey(jobId: string): string {
  return `auto_invoice:${jobId}`;
}

/** Proposal states in which an auto-drafted invoice can still become an invoice. */
const WAITING_STATUSES: ReadonlyArray<Proposal['status']> = ['draft', 'ready_for_review', 'approved', 'executing'];

/**
 * #1203: the job's auto-drafted invoice proposal while it can still become an
 * invoice, else null. Once it executes, the invoice itself carries the
 * estimate; once rejected/expired/undone it will never bill. Milestone
 * minting refuses while one is waiting, so the owner approving it later
 * cannot bill the whole estimate on top of the milestones.
 */
export async function findWaitingAutoInvoiceProposal(
  proposalRepo: ProposalRepository,
  tenantId: string,
  jobId: string,
): Promise<Proposal | null> {
  if (!proposalRepo.findByIdempotencyKey) return null;
  const proposal = await proposalRepo.findByIdempotencyKey(tenantId, autoInvoiceIdempotencyKey(jobId));
  return proposal && WAITING_STATUSES.includes(proposal.status) ? proposal : null;
}

/** Only auto-invoice jobs that have something to bill and aren't paid yet. */
const ELIGIBLE_MONEY_STATES: JobMoneyState[] = ['estimate_accepted', 'no_estimate'];

/** An invoice in any of these states means the job is already invoiced. */
function isLiveInvoice(status: string): boolean {
  return status !== 'void' && status !== 'canceled';
}

export interface AutoInvoiceOnCompletionDeps {
  estimateRepo: EstimateRepository;
  invoiceRepo: InvoiceRepository;
  proposalRepo: ProposalRepository;
  settingsRepo: SettingsRepository;
  auditRepo?: AuditRepository;
  /**
   * Feature (launch) — when present AND the tenant opted into
   * `billLaborFromTimeEntries`, the labor line is recomputed from actual logged
   * time before the draft is raised.
   */
  timeEntryRepo?: TimeEntryRepository;
  /**
   * #1203 — when present, a job with an invoice schedule is left to its
   * milestone plan: no whole-estimate draft is raised on top of it.
   */
  scheduleRepo?: InvoiceScheduleRepository;
}

/**
 * Returns the created `draft_invoice` proposal, or `null` when no draft was
 * raised (toggle off, ineligible money-state, already invoiced, or nothing to
 * bill).
 */
export async function maybeAutoInvoiceOnCompletion(
  deps: AutoInvoiceOnCompletionDeps,
  job: Job,
): Promise<Proposal | null> {
  // 1. Opt-in gate.
  const settings = await deps.settingsRepo.findByTenant(job.tenantId);
  if (!settings?.autoInvoiceOnCompletion) return null;

  // 2. Only bill jobs that have an accepted estimate or no estimate at all.
  const moneyState = job.moneyState ?? 'no_estimate';
  if (!ELIGIBLE_MONEY_STATES.includes(moneyState)) return null;

  // 3. Idempotency: never raise a second draft when the job is already
  //    invoiced (a draft/open/paid invoice exists from a prior run).
  const existingInvoices = await deps.invoiceRepo.findByJob(job.tenantId, job.id);
  if (existingInvoices.some((inv) => isLiveInvoice(inv.status))) return null;

  // 3b. #1203: a job with a milestone plan is billed by that plan. Drafting the
  //     whole accepted estimate as well would bill the job twice (the
  //     completion hook mints the plan's on_completion milestones right after
  //     this). Holds even while milestone billing is switched off: the kill
  //     switch halts billing, it does not turn a plan into a whole invoice.
  if (deps.scheduleRepo && (await deps.scheduleRepo.findByJob(job.tenantId, job.id)).length > 0) {
    return null;
  }

  // 4. Build line items from the accepted estimate's billed selection
  //    (tiers + add-ons the customer actually chose). No estimate / no
  //    billable lines → nothing to invoice; bail rather than draft an empty one.
  const estimates = await deps.estimateRepo.findByJob(job.tenantId, job.id);
  const accepted = estimates.find((e) => e.status === 'accepted');
  let billed = accepted
    ? resolveSelectedLineItems(accepted.lineItems, accepted.acceptedSelection)
    : [];
  if (billed.length === 0) return null;

  // 4b. Feature (launch) — recompute the labor line from ACTUAL logged time
  //     when the tenant opted in and any time was tracked for the job. With no
  //     tracked time (or no single labor line) the accepted estimate is billed
  //     as-is, so this never zeroes out or invents labor.
  let laborHoursBilled: number | undefined;
  if (settings.billLaborFromTimeEntries && deps.timeEntryRepo) {
    const timeEntries = await deps.timeEntryRepo.findByJob(job.tenantId, job.id);
    const recalc = recalculateLaborFromTimeEntries(billed, timeEntries);
    if (recalc.adjusted) {
      billed = recalc.lineItems;
      laborHoursBilled = recalc.laborHoursBilled;
    }
  }

  // The execution handler consumes billing-engine LineItems (unitPriceCents);
  // add a `unitPrice` alias so the payload also satisfies the draft_invoice
  // Zod contract's lineItem shape (validated below).
  const lineItems = billed.map((li) => ({ ...li, unitPrice: li.unitPriceCents }));

  const payload: Record<string, unknown> = {
    customerId: job.customerId,
    jobId: job.id,
    ...(accepted ? { estimateId: accepted.id } : {}),
    lineItems,
    // Carry the accepted estimate's discount + tax forward so approving the
    // draft bills the amount the customer accepted (the draft_invoice handler
    // recomputes totals from these, mirroring convertEstimateToInvoice).
    ...(accepted ? { discountCents: accepted.totals.discountCents, taxRateBps: accepted.totals.taxRateBps } : {}),
  };

  // Be a good citizen: run the AI-safety payload gate before createProposal.
  const validation = validateProposalPayload('draft_invoice', payload);
  if (!validation.valid) {
    throw new Error(
      `Auto-invoice payload failed validation: ${validation.errors?.join(', ')}`,
    );
  }

  // 5. Raise the draft as a proposal — never auto-approved. The owner taps
  //    approve to create + (separately) send the invoice.
  const proposal = createProposal({
    tenantId: job.tenantId,
    proposalType: 'draft_invoice',
    payload,
    summary: 'Draft invoice for completed job',
    explanation:
      'Auto-drafted when the job was marked complete. Approve to create the invoice; sending is a separate step.',
    sourceContext: { source: 'auto_invoice_on_completion', jobId: job.id },
    targetEntityType: 'job',
    targetEntityId: job.id,
    idempotencyKey: autoInvoiceIdempotencyKey(job.id),
    createdBy: AUTO_INVOICE_ACTOR,
  });
  const persisted = await deps.proposalRepo.create(proposal);

  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: job.tenantId,
        actorId: AUTO_INVOICE_ACTOR,
        actorRole: 'system',
        eventType: 'invoice.auto_drafted',
        entityType: 'proposal',
        entityId: persisted.id,
        metadata: {
          jobId: job.id,
          estimateId: accepted?.id,
          lineItemCount: lineItems.length,
          ...(laborHoursBilled !== undefined ? { laborHoursBilled } : {}),
        },
      }),
    );
  }

  return persisted;
}
