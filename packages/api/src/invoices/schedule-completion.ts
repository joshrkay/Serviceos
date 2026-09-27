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
 *
 * #1215 — no later milestone is dropped silently either:
 *   - `manual` milestones (nothing ever mints them; a voice "30/30/40 split"
 *     makes the middle one manual) are raised to the owner at completion as a
 *     held draft, next to the minted on_completion ones;
 *   - when milestone billing was turned off after the plan started billing
 *     (a plan milestone invoice still bills), the kill switch still mints
 *     nothing, but the unminted milestones are raised as a held draft — auto-
 *     invoice stands aside for the job because of that live invoice, so this
 *     is the only thing that would ever bill the balance. A plan that has
 *     billed nothing is left alone with billing off (the whole invoice, e.g.
 *     auto-invoice's draft, is the bill — unchanged from #1214).
 * One held draft per plan (idempotency key), reason recorded as `holdReason`.
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
  MilestoneHoldReason,
  acceptedEstimateIds,
  heldBillingOffReason,
  heldBillingOffSummary,
  heldManualMilestonesReason,
  heldManualMilestonesSummary,
  heldMilestonesReason,
  heldMilestonesSummary,
  invoiceStillBills,
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
  const billingOn = Boolean(settings?.milestoneBillingEnabled);
  // Billing off mints nothing; the only thing left to do is raise held
  // drafts (#1215), which needs the proposal repo.
  if (!billingOn && !deps.proposalRepo) return [];

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

    // Everything approval did not mint up front and nobody has minted since.
    const due = allocations.filter(
      (a) => a.trigger !== 'on_accept' && a.amountCents > 0 && !minted.has(`${schedule.id}:${a.index}`),
    );
    if (due.length === 0) continue;

    // #1203 — an invoice outside the plan already bills the plan's estimate:
    // hold this plan's due milestones (manual ones too, #1215) for the owner
    // instead of billing twice.
    const billedEstimateId = planBilledEstimateId(schedule, jobAccepted);
    const blocking = billedEstimateId
      ? wholeInvoiceBillingEstimate(billedEstimateId, existing, schedule.id)
      : undefined;
    if (blocking) {
      await holdMilestonesForOwner(deps, job, schedule, due, {
        holdReason: 'estimate_already_billed',
        summary: heldMilestonesSummary(due, blocking),
        reason: heldMilestonesReason(due, blocking),
        blocking,
      });
      continue;
    }

    // #1215 — billing turned off after the plan started billing: mint nothing,
    // raise the rest to the owner.
    if (!billingOn) {
      const planIsBilling = existing.some((inv) => inv.scheduleId === schedule.id && invoiceStillBills(inv));
      if (planIsBilling) {
        await holdMilestonesForOwner(deps, job, schedule, due, {
          holdReason: 'milestone_billing_off',
          summary: heldBillingOffSummary(due),
          reason: heldBillingOffReason(due),
        });
      }
      continue;
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

    // #1215 — manual milestones are never minted automatically; completion
    // raises them to the owner so the plan's full amount reaches a bill.
    // (No proposal repo → nowhere to raise them; left as before.)
    const manual = due.filter((a) => a.trigger === 'manual');
    if (manual.length > 0 && deps.proposalRepo) {
      await holdMilestonesForOwner(deps, job, schedule, manual, {
        holdReason: 'manual_milestone',
        summary: heldManualMilestonesSummary(manual),
        reason: heldManualMilestonesReason(manual),
      });
    }
  }

  return created;
}

interface MilestoneHold {
  holdReason: MilestoneHoldReason;
  summary: string;
  reason: string;
  /** The invoice already billing the estimate (estimate_already_billed only). */
  blocking?: Invoice;
}

/**
 * #1203 / #1215 — completion runs once, so milestones it does not bill must
 * reach the owner as something they can act on. Raises one ready_for_review
 * `draft_invoice` proposal with a line per held milestone (the plan's own
 * split amounts, no estimate link) whose explanation says why they were not
 * billed. Approving it invoices exactly those milestones; rejecting it leaves
 * them unbilled.
 */
async function holdMilestonesForOwner(
  deps: ScheduleCompletionDeps,
  job: Job,
  schedule: InvoiceSchedule,
  held: MilestoneAllocation[],
  hold: MilestoneHold,
): Promise<void> {
  const { reason, blocking } = hold;
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
  const blockingContext = blocking
    ? {
        estimateId: blocking.estimateId,
        blockingInvoiceId: blocking.id,
        blockingInvoiceNumber: blocking.invoiceNumber,
      }
    : { estimateId: schedule.estimateId };
  const proposal = transitionProposal(
    createProposal({
      tenantId: job.tenantId,
      proposalType: 'draft_invoice',
      payload,
      summary: hold.summary,
      explanation: reason,
      sourceContext: {
        source: 'milestone_mint_held',
        holdReason: hold.holdReason,
        jobId: job.id,
        scheduleId: schedule.id,
        milestoneIndexes: held.map((a) => a.index),
        ...blockingContext,
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
          holdReason: hold.holdReason,
          milestoneIndexes: held.map((a) => a.index),
          amountCents: heldCents,
          ...(blocking
            ? { blockingInvoiceId: blocking.id, blockingInvoiceNumber: blocking.invoiceNumber }
            : {}),
        },
      }),
    );
  }
}
