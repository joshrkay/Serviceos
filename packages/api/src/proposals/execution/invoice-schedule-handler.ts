import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { createInvoiceWithNextNumber, InvoiceRepository } from '../../invoices/invoice';
import { SettingsRepository } from '../../settings/settings';
import { EstimateRepository } from '../../estimates/estimate';
import {
  InvoiceMilestone,
  InvoiceScheduleRepository,
  buildInvoiceSchedule,
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
  ) {}

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

    const estimateId = typeof payload.estimateId === 'string' ? payload.estimateId : undefined;

    try {
      // Resolve the schedule total: explicit payload value, else derive from
      // the accepted estimate's billed line items.
      let totalCents =
        typeof payload.totalAmountCents === 'number' ? payload.totalAmountCents : undefined;
      if (totalCents === undefined && estimateId && this.estimateRepo) {
        const estimate = await this.estimateRepo.findById(context.tenantId, estimateId);
        if (estimate) {
          // Use the accepted estimate's persisted totals (tax + discount + the
          // accepted good/better/best selection already applied) so milestones
          // are allocated from the amount the customer actually accepted.
          totalCents = estimate.totals.totalCents;
        }
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
        if (
          schedule.totalAmountCents !== totalCents ||
          schedule.estimateId !== estimateId ||
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
        const jobInvoices = await this.invoiceRepo.findByJob(
          context.tenantId,
          payload.jobId,
        );
        const drafted = new Set(
          jobInvoices
            .filter((inv) => inv.scheduleId === schedule.id && inv.milestoneIndex !== undefined)
            .map((inv) => inv.milestoneIndex),
        );
        for (const onAccept of onAcceptAllocations) {
          if (onAccept.amountCents <= 0) continue; // never draft a $0 invoice
          if (drafted.has(onAccept.index)) continue;
          try {
            await createInvoiceWithNextNumber(
              {
                tenantId: context.tenantId,
                jobId: payload.jobId,
                estimateId,
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
            // concurrent/retried mint of this milestone — already drafted.
            if (err && typeof err === 'object' && (err as { code?: string }).code === '23505') {
              drafted.add(onAccept.index);
              continue;
            }
            throw err;
          }
          drafted.add(onAccept.index);
        }
      }

      return { success: true, resultEntityId: schedule.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
