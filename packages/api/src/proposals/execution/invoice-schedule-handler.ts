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
import {
  buildLineItem,
  calculateDocumentTotals,
  resolveSelectedLineItems,
} from '../../shared/billing-engine';

/**
 * P21-002 — Deterministic execution for create_invoice_schedule proposals.
 *
 * Writes the `invoice_schedules` row, then drafts the FIRST milestone invoice
 * (linked back via schedule_id + milestone_index) through the existing
 * invoice-create path. Later milestones are minted by the completion hook
 * (P20-001) and an on_accept check — not here.
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
          const billed = resolveSelectedLineItems(estimate.lineItems, estimate.acceptedSelection);
          totalCents = calculateDocumentTotals(billed, 0, 0).totalCents;
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

      const schedule = buildInvoiceSchedule({
        tenantId: context.tenantId,
        jobId: payload.jobId,
        estimateId,
        totalAmountCents: totalCents,
        milestones,
        createdBy: context.executedBy,
      });
      await this.scheduleRepo.create(schedule);

      // Draft the first milestone invoice, linked to the schedule.
      const first = allocations[0];
      await createInvoiceWithNextNumber(
        {
          tenantId: context.tenantId,
          jobId: payload.jobId,
          estimateId,
          lineItems: [buildLineItem(uuidv4(), first.label, 1, first.amountCents, 0, true)],
          createdBy: context.executedBy,
          scheduleId: schedule.id,
          milestoneIndex: first.index,
        },
        this.invoiceRepo,
        this.settingsRepo,
      );

      return { success: true, resultEntityId: schedule.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
