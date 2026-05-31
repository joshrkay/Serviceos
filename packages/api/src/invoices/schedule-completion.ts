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
 */
import { v4 as uuidv4 } from 'uuid';
import { Invoice, InvoiceRepository, createInvoiceWithNextNumber } from './invoice';
import { InvoiceScheduleRepository, splitMilestones } from './invoice-schedule';
import { SettingsRepository } from '../settings/settings';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { buildLineItem } from '../shared/billing-engine';
import { Job } from '../jobs/job';

const COMPLETION_ACTOR = 'system:schedule_completion';

export interface ScheduleCompletionDeps {
  scheduleRepo: InvoiceScheduleRepository;
  invoiceRepo: InvoiceRepository;
  settingsRepo: SettingsRepository;
  auditRepo?: AuditRepository;
}

/**
 * Drafts an invoice for each not-yet-minted `on_completion` milestone of every
 * schedule attached to the job. Returns the invoices created (possibly empty).
 */
export async function mintCompletionMilestones(
  deps: ScheduleCompletionDeps,
  job: Job,
): Promise<Invoice[]> {
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

  const created: Invoice[] = [];
  for (const schedule of schedules) {
    const allocations = splitMilestones(schedule.totalAmountCents, schedule.milestones);
    for (const alloc of allocations) {
      if (alloc.trigger !== 'on_completion') continue;
      if (alloc.amountCents <= 0) continue;
      const key = `${schedule.id}:${alloc.index}`;
      if (minted.has(key)) continue;

      const invoice = await createInvoiceWithNextNumber(
        {
          tenantId: job.tenantId,
          jobId: job.id,
          estimateId: schedule.estimateId,
          lineItems: [buildLineItem(uuidv4(), alloc.label, 1, alloc.amountCents, 0, true)],
          createdBy: COMPLETION_ACTOR,
          scheduleId: schedule.id,
          milestoneIndex: alloc.index,
        },
        deps.invoiceRepo,
        deps.settingsRepo,
      );
      created.push(invoice);
      minted.add(key);

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
