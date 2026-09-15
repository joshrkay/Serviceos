/**
 * P21 — Mint `on_completion` schedule milestones when a job is completed.
 *
 * Closes the loop on milestone billing: `create_invoice_schedule` (P21-002)
 * writes the schedule and drafts the `on_accept` milestone (e.g. the deposit);
 * this drafts each `on_completion` milestone (e.g. the balance) once the job is
 * marked complete, so a 50% deposit / 50% balance plan auto-bills the balance.
 *
 * Like the schedule-approval path, milestones are drafted directly as invoices
 * (the owner already approved the plan); sending each remains a separate step.
 * Idempotent — a milestone already minted (an invoice with this schedule_id +
 * milestone_index) is skipped, so re-entry never double-bills. `manual`
 * milestones are left for an explicit action; zero-amount milestones are
 * skipped rather than minting a $0 invoice.
 *
 * #1203 — when an invoice outside the plan already bills the plan's estimate
 * (e.g. it was converted while milestone billing was off, or a void invoice
 * still holds a payment), minting would bill the estimate twice. The
 * milestones are then HELD, not dropped: completion runs once, so the owner
 * gets a ready_for_review `draft_invoice` proposal listing exactly what was not
 * billed and why, to approve or reject. A plan that recorded no estimate bills
 * the job's single accepted estimate (resolved now); with no accepted estimate
 * it mints exactly as before.
 */
import { v4 as uuidv4 } from 'uuid';
import { Invoice, InvoiceRepository, createInvoiceWithNextNumber } from './invoice';
import {
  InvoiceSchedule,
  InvoiceScheduleRepository,
  MilestoneAllocation,
  isDuplicateMilestoneError,
  milestoneEstimateLink,
  splitMilestones,
} from './invoice-schedule';
import {
  acceptedEstimateIds,
  heldMilestonesReason,
  heldMilestonesSummary,
  planBilledEstimateId,
  wholeInvoiceBillingEstimate,
} from './milestone-billing-guard';
import { EstimateRepository } from '../estimates/estimate';
import { SettingsRepository } from '../settings/settings';
import { withRequestSavepoint } from '../middleware/tenant-context';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { buildLineItem } from '../shared/billing-engine';
import { Job } from '../jobs/job';
import { ProposalRepository, createProposal } from '../proposals/proposal';
import { transitionProposal } from '../proposals/lifecycle';
import { validateProposalPayload } from '../proposals/contracts';
import { ConflictError } from '../shared/errors';

const COMPLETION_ACTOR = 'system:schedule_completion';

export interface ScheduleCompletionDeps {
  scheduleRepo: InvoiceScheduleRepository;
  invoiceRepo: InvoiceRepository;
  settingsRepo: SettingsRepository;
  auditRepo?: AuditRepository;
  /** #1203 — raises the owner draft for milestones held at completion. */
  proposalRepo?: ProposalRepository;
  /** #1203 — resolves plans that recorded no estimate to the job's single accepted estimate. */
  estimateRepo?: EstimateRepository;
}

/** Idempotency key of the owner draft for a plan's held completion milestones. */
export function heldMilestonesIdempotencyKey(scheduleId: string): string {
  return `milestone_mint_held:${scheduleId}`;
}

/**
 * Drafts an invoice for each not-yet-minted `on_completion` milestone of every
 * schedule attached to the job. Returns the invoices created (possibly empty).
 */
export async function mintCompletionMilestones(
  deps: ScheduleCompletionDeps,
  job: Job,
): Promise<Invoice[]> {
  // Opt-in / kill switch. Milestone minting writes real invoices directly
  // (the plan was owner-approved at create_invoice_schedule time), so it is
  // gated by an explicit per-tenant toggle — default false — exactly like
  // auto_invoice_on_completion and batch_invoice_enabled. Lets an owner halt
  // all milestone billing fleet-wide without deleting schedules.
  const settings = await deps.settingsRepo.findByTenant(job.tenantId);
  if (!settings?.milestoneBillingEnabled) return [];

  const schedules = await deps.scheduleRepo.findByJob(job.tenantId, job.id);
  if (schedules.length === 0) return [];

  // Which (schedule, milestone) pairs are already invoiced — covers the
  // on_accept milestone minted at approval and any prior completion run.
  const existing = await deps.invoiceRepo.findByJob(job.tenantId, job.id);
  const minted = new Set(
    existing
      .filter((inv) => inv.scheduleId !== undefined && inv.milestoneIndex !== undefined)
      .map((inv) => `${inv.scheduleId}:${inv.milestoneIndex}`),
  );

  // #1203 — plans that recorded no estimate bill the job's single accepted estimate.
  const jobAccepted =
    deps.estimateRepo && schedules.some((s) => !s.estimateId)
      ? acceptedEstimateIds(await deps.estimateRepo.findByJob(job.tenantId, job.id))
      : [];

  const created: Invoice[] = [];
  for (const schedule of schedules) {
    const allocations = splitMilestones(schedule.totalAmountCents, schedule.milestones);

    // #1203 — an invoice outside the plan already bills the plan's estimate:
    // hold this plan's due milestones for the owner instead of billing twice.
    const billedEstimateId = planBilledEstimateId(schedule, jobAccepted);
    if (billedEstimateId) {
      const blocking = wholeInvoiceBillingEstimate(billedEstimateId, existing, schedule.id);
      const due = allocations.filter(
        (a) => a.trigger === 'on_completion' && a.amountCents > 0 && !minted.has(`${schedule.id}:${a.index}`),
      );
      if (blocking && due.length > 0) {
        await holdMilestonesForOwner(deps, job, schedule, due, blocking);
        continue;
      }
    }

    // Only one invoice per estimate may carry estimate_id (uq_invoices_estimate).
    // The deposit minted at approval normally holds it; if nothing does yet, the
    // first milestone minted here takes it and the rest go without.
    let estimateId = milestoneEstimateLink(schedule.estimateId, existing);
    for (const alloc of allocations) {
      if (alloc.trigger !== 'on_completion') continue;
      if (alloc.amountCents <= 0) continue;
      const key = `${schedule.id}:${alloc.index}`;
      if (minted.has(key)) continue;

      let invoice: Invoice;
      try {
        // SAVEPOINT-wrap the INSERT: this runs inside the request transaction on
        // the job-completion path (POST /api/jobs/:id/transition), so a 23505
        // would abort the WHOLE request transaction — rolling back the job-status
        // transition itself at COMMIT — even though we mean to catch it and skip.
        // The savepoint confines the rollback to this insert. (No-op off the
        // request path, e.g. background workers, where each write self-transacts.)
        invoice = await withRequestSavepoint(() =>
          createInvoiceWithNextNumber(
            {
              tenantId: job.tenantId,
              jobId: job.id,
              estimateId,
              lineItems: [buildLineItem(uuidv4(), alloc.label, 1, alloc.amountCents, 0, true)],
              createdBy: COMPLETION_ACTOR,
              scheduleId: schedule.id,
              milestoneIndex: alloc.index,
            },
            deps.invoiceRepo,
            deps.settingsRepo,
          ),
        );
      } catch (err) {
        // A concurrent / retried completion already minted this exact
        // milestone: the partial unique index uniq_invoices_schedule_milestone
        // (schedule_id, milestone_index) rejects the duplicate INSERT with
        // 23505 before any invoice number is allocated. Treat it as already
        // minted and move on — the other run owns the invoice (and the
        // estimate link, if any). Any other error — including a 23505 from a
        // different index — is a real failure and must propagate.
        if (isDuplicateMilestoneError(err)) {
          minted.add(key);
          estimateId = undefined;
          continue;
        }
        throw err;
      }
      created.push(invoice);
      minted.add(key);
      estimateId = undefined;

      if (deps.auditRepo) {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId: job.tenantId,
            actorId: COMPLETION_ACTOR,
            actorRole: 'system',
            eventType: 'invoice.milestone_minted',
            entityType: 'invoice',
            entityId: invoice.id,
            metadata: { scheduleId: schedule.id, milestoneIndex: alloc.index, amountCents: alloc.amountCents },
          }),
        );
      }
    }
  }

  return created;
}

/**
 * #1203 — completion runs once, so milestones it cannot bill must reach the
 * owner as something they can act on. Raises one ready_for_review
 * `draft_invoice` proposal with a line per held milestone (the plan's own
 * split amounts, no estimate link) whose explanation names the invoice that
 * already bills the estimate. Approving it invoices exactly those milestones;
 * rejecting it leaves the existing invoice as the bill.
 */
async function holdMilestonesForOwner(
  deps: ScheduleCompletionDeps,
  job: Job,
  schedule: InvoiceSchedule,
  held: MilestoneAllocation[],
  blocking: Invoice,
): Promise<void> {
  const reason = heldMilestonesReason(held, blocking);
  if (!deps.proposalRepo) {
    // No way to raise the owner draft: fail loudly (the completion-effects
    // caller logs it) rather than billing the estimate twice.
    throw new ConflictError(reason);
  }

  const payload: Record<string, unknown> = {
    customerId: job.customerId,
    jobId: job.id,
    lineItems: held.map((a, i) => ({
      ...buildLineItem(uuidv4(), a.label, 1, a.amountCents, i, true),
      unitPrice: a.amountCents,
    })),
  };
  const validation = validateProposalPayload('draft_invoice', payload);
  if (!validation.valid) {
    throw new Error(`Held milestone draft failed validation: ${validation.errors?.join(', ')}`);
  }

  const heldCents = held.reduce((sum, a) => sum + a.amountCents, 0);
  const proposal = transitionProposal(
    createProposal({
      tenantId: job.tenantId,
      proposalType: 'draft_invoice',
      payload,
      summary: heldMilestonesSummary(held, blocking),
      explanation: reason,
      sourceContext: {
        source: 'milestone_mint_held',
        jobId: job.id,
        scheduleId: schedule.id,
        estimateId: blocking.estimateId,
        milestoneIndexes: held.map((a) => a.index),
        blockingInvoiceId: blocking.id,
        blockingInvoiceNumber: blocking.invoiceNumber,
      },
      targetEntityType: 'job',
      targetEntityId: job.id,
      idempotencyKey: heldMilestonesIdempotencyKey(schedule.id),
      createdBy: COMPLETION_ACTOR,
    }),
    'ready_for_review',
    COMPLETION_ACTOR,
  );

  let persisted;
  try {
    persisted = await deps.proposalRepo.create(proposal);
  } catch (err) {
    // Already raised by an earlier run for this plan.
    if (err instanceof ConflictError) return;
    throw err;
  }

  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: job.tenantId,
        actorId: COMPLETION_ACTOR,
        actorRole: 'system',
        eventType: 'invoice.milestone_mint_held',
        entityType: 'job',
        entityId: job.id,
        metadata: {
          scheduleId: schedule.id,
          proposalId: persisted.id,
          milestoneIndexes: held.map((a) => a.index),
          amountCents: heldCents,
          blockingInvoiceId: blocking.id,
          blockingInvoiceNumber: blocking.invoiceNumber,
        },
      }),
    );
  }
}
