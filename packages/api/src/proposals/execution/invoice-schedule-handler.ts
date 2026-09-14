import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalRepository, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { createInvoiceWithNextNumber, InvoiceRepository } from '../../invoices/invoice';
import { SettingsRepository } from '../../settings/settings';
import { Estimate, EstimateRepository } from '../../estimates/estimate';
import { JobRepository } from '../../jobs/job';
import { isPostCompletionStatus } from '../../jobs/job-lifecycle';
import {
  PLAN_REFUSED_BILLING_OFF_REASON,
  PLAN_REFUSED_JOB_COMPLETED_REASON,
  acceptedEstimateIds,
  invoicesWithoutEstimateWarning,
  planBilledEstimateId,
  planRefusedByWholeInvoiceReason,
  wholeInvoiceBillingEstimate,
} from '../../invoices/milestone-billing-guard';
import {
  InvoiceMilestone,
  InvoiceScheduleRepository,
  buildInvoiceSchedule,
  isDuplicateMilestoneError,
  milestoneEstimateLink,
  splitMilestones,
} from '../../invoices/invoice-schedule';
import { buildLineItem } from '../../shared/billing-engine';

/**
 * True when two milestone lists are field-for-field identical (order included).
 * Distinguishes a genuine retry of a create_invoice_schedule proposal (safe to
 * reuse the existing schedule) from a different/revised plan for a job that
 * already has a schedule (must be rejected, not grafted onto the old row).
 */
function milestonesMatch(a: InvoiceMilestone[], b: InvoiceMilestone[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (m, i) =>
      m.label === b[i].label &&
      m.type === b[i].type &&
      m.value === b[i].value &&
      m.trigger === b[i].trigger,
  );
}

/**
 * P21-002 — Deterministic execution for create_invoice_schedule proposals.
 *
 * Writes the `invoice_schedules` row, then drafts an invoice for EVERY
 * `on_accept` milestone (linked back via schedule_id + milestone_index) through
 * the existing invoice-create path. Milestones triggered on_completion are
 * minted later by the completion hook (P20-001); `manual` ones await an
 * explicit action — neither is drafted here.
 *
 * The schedule total comes from the payload's `totalAmountCents` when present,
 * otherwise it is derived from the referenced estimate's billed selection.
 *
 * #1203 — a plan bills ONE estimate, recorded on the schedule row. The payload
 * names it (contract shape) or, for voice plans (which never do), it is the
 * job's single accepted estimate. A job with no accepted estimate (time and
 * materials, a spoken total) records none and bills as on main. Several
 * accepted estimates, or a named estimate from another job, is refused rather
 * than guessed. Before anything is written, a NEW plan is also refused when
 * completion could never bill its on_completion milestones (milestone billing
 * off, or the job already past completion), and any plan is refused when a
 * live invoice outside it already bills its estimate. Live invoices on the job
 * that carry no estimate do not block; they are listed on the proposal's
 * explanation.
 *
 * Capture-class (never auto-approved): no money moves and nothing is sent —
 * the drafted milestone invoice still goes out via a separate send step.
 *
 * Degrades to a synthetic-id passthrough when its persistence deps are absent,
 * matching the other execution handlers' in-memory test behavior.
 */
export class CreateInvoiceScheduleExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_invoice_schedule';

  constructor(
    private readonly scheduleRepo?: InvoiceScheduleRepository,
    private readonly invoiceRepo?: InvoiceRepository,
    private readonly settingsRepo?: SettingsRepository,
    private readonly estimateRepo?: EstimateRepository,
    // #1203 — writes the "invoices not tied to an estimate" note onto the
    // approved proposal's explanation. Absent → the note is skipped.
    private readonly proposalRepo?: ProposalRepository,
    // #1203 — refuses a new plan whose on_completion milestones could never
    // bill because the job is already past completion. Absent → not checked.
    private readonly jobRepo?: JobRepository,
  ) {}

  // U8 — degrades to a synthetic-id passthrough (schedules nothing) without
  // the schedule/invoice/settings deps — see execute(). The boot guard
  // (wiring-assertions.ts) fails boot when a pool is configured but this is
  // false. estimateRepo is excluded: it only backs total derivation, and its
  // absence fails loudly at runtime when the total cannot be resolved.
  isFullyWired(): boolean {
    return (
      Boolean(this.scheduleRepo) && Boolean(this.invoiceRepo) && Boolean(this.settingsRepo)
    );
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    if (!payload.jobId || typeof payload.jobId !== 'string') {
      return { success: false, error: 'Payload must include a valid jobId' };
    }
    const milestones = payload.milestones as InvoiceMilestone[] | undefined;
    if (!Array.isArray(milestones) || milestones.length === 0) {
      return { success: false, error: 'Payload must include at least one milestone' };
    }

    // Idempotency — a second execution returns the id from the first run.
    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    if (!this.scheduleRepo || !this.invoiceRepo || !this.settingsRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    const payloadEstimateId =
      typeof payload.estimateId === 'string' ? payload.estimateId : undefined;

    try {
      // #1203 — the ONE estimate this plan bills, recorded on the schedule row
      // (undefined when the job has no accepted estimate).
      const resolved = await this.resolvePlanEstimate(context.tenantId, payload.jobId, payloadEstimateId);
      if ('error' in resolved) return { success: false, error: resolved.error };
      const estimateId = resolved.estimateId;

      // Resolve the schedule total: explicit payload value, else derive from
      // the payload's estimate. (Unchanged by #1203: a voice plan's resolved
      // estimate does not supply a total the payload did not ask for.)
      let totalCents =
        typeof payload.totalAmountCents === 'number' ? payload.totalAmountCents : undefined;
      if (totalCents === undefined && payloadEstimateId && resolved.estimate) {
        // Use the accepted estimate's persisted totals (tax + discount + the
        // accepted good/better/best selection already applied) so milestones
        // are allocated from the amount the customer actually accepted.
        totalCents = resolved.estimate.totals.totalCents;
      }
      if (totalCents === undefined) {
        return {
          success: false,
          error: 'Cannot determine schedule total: provide totalAmountCents or a resolvable estimateId',
        };
      }

      // Validates milestones (exactly one remainder, percents in range) and
      // guarantees the allocations sum to the total.
      const allocations = splitMilestones(totalCents, milestones);

      // Idempotency backstop. A prior execution may have written the schedule
      // row but then failed before/while drafting the deposit invoice,
      // returning {success:false} with no resultEntityId — which leaves the
      // proposal retryable. Reuse the existing schedule for this job instead of
      // minting a SECOND one: two schedules make the completion hook (which
      // dedups on schedule_id) bill the on_completion balance TWICE. The
      // uniq_invoice_schedules_job index is the hard DB backstop; this read
      // keeps the retry from even attempting the duplicate insert.
      const existingForJob = await this.scheduleRepo.findByJob(
        context.tenantId,
        payload.jobId,
      );
      let schedule = existingForJob[0];

      // #1203 — a NEW plan whose on_completion milestones completion could
      // never bill is refused, so nothing it plans to bill is dropped silently.
      // A retry of a half-written plan skips this: its schedule already existed
      // when the job completed, so completion handled it.
      const hasCompletionMilestones = allocations.some(
        (a) => a.trigger === 'on_completion' && a.amountCents > 0,
      );
      if (!schedule && hasCompletionMilestones) {
        if (this.jobRepo) {
          const job = await this.jobRepo.findById(context.tenantId, payload.jobId);
          if (!job) {
            return { success: false, error: 'That job was not found. No invoice schedule was created.' };
          }
          if (isPostCompletionStatus(job.status)) {
            return { success: false, error: PLAN_REFUSED_JOB_COMPLETED_REASON };
          }
        }
        const settings = await this.settingsRepo.findByTenant(context.tenantId);
        if (!settings?.milestoneBillingEnabled) {
          return { success: false, error: PLAN_REFUSED_BILLING_OFF_REASON };
        }
      }

      // #1203 — convert then plan: an invoice outside this plan already bills
      // the estimate (typically POST /estimates/:id/convert-to-invoice). Refuse
      // before the schedule row or any milestone invoice is written. Canceled
      // invoices and unpaid void ones do not count; a void one holding a
      // payment does (the reason says to invoice the remaining balance by hand).
      const jobInvoices = await this.invoiceRepo.findByJob(context.tenantId, payload.jobId);
      const billedOutside = estimateId
        ? wholeInvoiceBillingEstimate(estimateId, jobInvoices, schedule?.id)
        : undefined;
      if (billedOutside) {
        return { success: false, error: planRefusedByWholeInvoiceReason(billedOutside) };
      }

      if (schedule) {
        // A schedule already exists for this job. Only a genuine RETRY of THIS
        // proposal may reuse it — i.e. the existing row has the same total and
        // milestones this payload would produce. A DIFFERENT/revised schedule
        // proposal for a job that already has one must NOT be grafted onto the
        // existing schedule_id: the on_accept invoices below would be drafted
        // with this payload's amounts/indexes while the stored milestones stay
        // the old ones, desyncing them and making the completion hook bill the
        // wrong on_completion balance. Reject it instead — one schedule per job
        // is enforced by uniq_invoice_schedules_job, and a revised plan needs an
        // explicit replace flow, not a second create proposal. (Before the
        // idempotency backstop this case was already rejected by the unique
        // index's 23505 on insert; this keeps that guarantee while still letting
        // a true retry succeed.)
        // #1203 — a schedule that recorded no estimate (created before #1203,
        // or while the job had no accepted estimate) bills the job's single
        // accepted estimate, so a genuine retry of it still matches.
        if (
          schedule.totalAmountCents !== totalCents ||
          planBilledEstimateId(schedule, resolved.jobAcceptedEstimateIds) !== estimateId ||
          !milestonesMatch(schedule.milestones, milestones)
        ) {
          // estimateId included: a revised proposal for a DIFFERENT estimate with
          // the same total + milestones must not graft estimate-B invoices onto a
          // schedule still tied to estimate A (mixed provenance for the on_accept
          // drafts vs. the persisted schedule + later completion invoices).
          return { success: false, error: 'Job already has a different invoice schedule' };
        }
      } else {
        schedule = buildInvoiceSchedule({
          tenantId: context.tenantId,
          jobId: payload.jobId,
          estimateId,
          totalAmountCents: totalCents,
          milestones,
          createdBy: context.executedBy,
        });
        await this.scheduleRepo.create(schedule);
      }

      // Draft EVERY `on_accept` milestone now (e.g. a deposit plus any other
      // up-front charge like a permit fee). Milestones triggered
      // on_completion/manual are minted later by their own trigger — not up
      // front. Each draft is guarded by an existence check (so a retry with the
      // schedule already present never double-mints) and a 23505 catch (so a
      // concurrent execution racing the same milestone is treated as already
      // drafted rather than failing the whole proposal).
      const onAcceptAllocations = allocations.filter((a) => a.trigger === 'on_accept');
      if (onAcceptAllocations.length > 0) {
        const drafted = new Set(
          jobInvoices
            .filter((inv) => inv.scheduleId === schedule.id && inv.milestoneIndex !== undefined)
            .map((inv) => inv.milestoneIndex),
        );
        // uq_invoices_estimate allows ONE invoice per estimate: the first
        // milestone drafted carries the link, later ones (a permit fee, the
        // balance at completion) reach the estimate through the schedule row.
        let estimateLink = milestoneEstimateLink(estimateId, jobInvoices);
        for (const onAccept of onAcceptAllocations) {
          if (onAccept.amountCents <= 0) continue; // never draft a $0 invoice
          if (drafted.has(onAccept.index)) continue;
          try {
            await createInvoiceWithNextNumber(
              {
                tenantId: context.tenantId,
                jobId: payload.jobId,
                estimateId: estimateLink,
                lineItems: [buildLineItem(uuidv4(), onAccept.label, 1, onAccept.amountCents, 0, true)],
                createdBy: context.executedBy,
                scheduleId: schedule.id,
                milestoneIndex: onAccept.index,
              },
              this.invoiceRepo,
              this.settingsRepo,
            );
          } catch (err) {
            // Partial unique index (schedule_id, milestone_index) rejected a
            // concurrent/retried mint of this milestone — already drafted (the
            // other run owns the estimate link too). A 23505 from any other
            // index is a real failure and fails the execution loudly.
            if (isDuplicateMilestoneError(err)) {
              drafted.add(onAccept.index);
              estimateLink = undefined;
              continue;
            }
            throw err;
          }
          drafted.add(onAccept.index);
          estimateLink = undefined;
        }
      }

      // #1203 — invoices on the job that carry no estimate do not block the
      // plan; the owner sees them on the approved proposal's explanation.
      const warning = invoicesWithoutEstimateWarning(jobInvoices, schedule.id);
      if (warning && this.proposalRepo && !proposal.explanation?.includes(warning)) {
        await this.proposalRepo.update(context.tenantId, proposal.id, {
          explanation: proposal.explanation ? `${proposal.explanation}\n\n${warning}` : warning,
        });
      }

      return { success: true, resultEntityId: schedule.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * #1203 — the estimate a plan bills. A payload estimateId must name an
   * estimate on the plan's job. With none (every voice plan) the job's single
   * accepted estimate is used; with no accepted estimate the plan records none
   * (a time-and-materials plan, billed as on main); several is refused, never
   * guessed. Without an estimate repository (legacy wiring) the payload's
   * estimate id is taken as given, as on main.
   */
  private async resolvePlanEstimate(
    tenantId: string,
    jobId: string,
    payloadEstimateId: string | undefined,
  ): Promise<
    | { estimateId: string | undefined; estimate?: Estimate; jobAcceptedEstimateIds: string[] }
    | { error: string }
  > {
    if (!this.estimateRepo) {
      return { estimateId: payloadEstimateId, jobAcceptedEstimateIds: [] };
    }
    const jobEstimates = await this.estimateRepo.findByJob(tenantId, jobId);
    const jobAcceptedEstimateIds = acceptedEstimateIds(jobEstimates);
    if (payloadEstimateId) {
      const named = await this.estimateRepo.findById(tenantId, payloadEstimateId);
      if (!named) return { error: 'That estimate was not found. No invoice schedule was created.' };
      if (named.jobId !== jobId) {
        return { error: 'That estimate belongs to a different job. No invoice schedule was created.' };
      }
      return { estimateId: named.id, estimate: named, jobAcceptedEstimateIds };
    }
    const accepted = jobEstimates.filter((e) => e.status === 'accepted');
    if (accepted.length <= 1) {
      return { estimateId: accepted[0]?.id, estimate: accepted[0], jobAcceptedEstimateIds };
    }
    return {
      error:
        `This job has more than one accepted estimate (${accepted.map((e) => e.estimateNumber).join(', ')}); ` +
        'say which one the milestone plan should bill. No invoice schedule was created.',
    };
  }
}
