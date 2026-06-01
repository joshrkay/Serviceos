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
import { withRequestSavepoint } from '../middleware/tenant-context';
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

  const created: Invoice[] = [];
  for (const schedule of schedules) {
    const allocations = splitMilestones(schedule.totalAmountCents, schedule.milestones);
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
              estimateId: schedule.estimateId,
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
        // minted and move on — the other run owns the invoice. Any other error
        // is a real failure and must propagate.
        if (err && typeof err === 'object' && (err as { code?: string }).code === '23505') {
          minted.add(key);
          continue;
        }
        throw err;
      }
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
