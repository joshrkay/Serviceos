/**
 * #1203 — a milestone plan bills ONE estimate, and that estimate is never
 * billed twice.
 *
 * Which estimate a plan bills (`planBilledEstimateId`): the one recorded on
 * `invoice_schedules.estimate_id` at approval, or, for a plan that recorded
 * none (a plan approved on a job with no accepted estimate, or created before
 * #1203), the job's single accepted estimate, resolved at CHECK time so an
 * estimate accepted later is covered. With no accepted estimate there is
 * nothing to protect and the plan behaves as on main. Another estimate on the
 * same job (a change order, a diagnostic estimate) never counts.
 *
 * Both orders are guarded:
 *   - Whole invoice first, then a plan (`wholeInvoiceBillingEstimate`): plan
 *     approval refuses; completion minting holds the milestones as an owner
 *     draft instead of dropping them, because completion runs once.
 *   - Plan first, then a whole invoice (`wholeInvoiceBlockedByPlan`):
 *     convert-to-invoice, POST /api/invoices with an estimate and draft_invoice
 *     refuse; auto-invoice-on-completion yields only to milestones completion
 *     is about to mint (`completionWillMintPlan`).
 *
 * Nothing here computes an amount; it only reads the plan's existing split
 * (`splitMilestones`) to tell which milestones are still unminted.
 */
import type { Invoice, InvoiceRepository } from './invoice';
import { InvoiceSchedule, InvoiceScheduleRepository, MilestoneAllocation, splitMilestones } from './invoice-schedule';
import type { Estimate, EstimateRepository } from '../estimates/estimate';
import type { SettingsRepository } from '../settings/settings';
import type { JobStatus } from '../jobs/job';
import { isPostCompletionStatus } from '../jobs/job-lifecycle';

/** "$1,000.00" from integer cents (display only; no arithmetic on the result). */
export function formatCentsUsd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Whether an invoice still bills its estimate. A canceled invoice never does;
 * a void one does only while it holds a payment (money was taken against the
 * estimate).
 */
export function invoiceStillBills(inv: Pick<Invoice, 'status' | 'amountPaidCents'>): boolean {
  if (inv.status === 'canceled') return false;
  if (inv.status === 'void') return inv.amountPaidCents > 0;
  return true;
}

/** Ids of the job's accepted estimates (Postgres keeps at most one per job). */
export function acceptedEstimateIds(estimates: ReadonlyArray<Pick<Estimate, 'id' | 'status'>>): string[] {
  return estimates.filter((e) => e.status === 'accepted').map((e) => e.id);
}

/**
 * The estimate a plan bills: the recorded one, else the job's single accepted
 * estimate (resolved now), else none.
 */
export function planBilledEstimateId(
  plan: Pick<InvoiceSchedule, 'estimateId'>,
  jobAcceptedEstimateIds: ReadonlyArray<string>,
): string | undefined {
  if (plan.estimateId) return plan.estimateId;
  return jobAcceptedEstimateIds.length === 1 ? jobAcceptedEstimateIds[0] : undefined;
}

/**
 * A still-billing invoice for `estimateId` that is not one of `planId`'s own
 * milestones. Membership comes from `schedule_id`: the plan's first milestone
 * carries the estimate id and must never block the plan's later milestones.
 */
export function wholeInvoiceBillingEstimate(
  estimateId: string,
  invoices: ReadonlyArray<Invoice>,
  planId?: string,
): Invoice | undefined {
  return invoices.find(
    (inv) =>
      inv.estimateId === estimateId &&
      (inv.scheduleId === undefined || inv.scheduleId !== planId) &&
      invoiceStillBills(inv),
  );
}

/** Why plan approval refused: the estimate is already billed by `inv`. */
export function planRefusedByWholeInvoiceReason(inv: Invoice): string {
  if (inv.status === 'void') {
    return (
      `This estimate already has a paid voided invoice (${inv.invoiceNumber}, ` +
      `${formatCentsUsd(inv.amountPaidCents)} paid). Invoice the remaining balance by hand. ` +
      'No invoice schedule was created.'
    );
  }
  return (
    `This estimate is already invoiced as ${inv.invoiceNumber} (${formatCentsUsd(inv.totals.totalCents)}), ` +
    'so a milestone plan would bill it twice. No invoice schedule was created.'
  );
}

/** Plan approval refusal: milestone billing is off, so on_completion milestones would never bill. */
export const PLAN_REFUSED_BILLING_OFF_REASON =
  "Milestone billing is off, so this plan's completion milestones would never be billed. " +
  'Turn milestone billing on in Settings, or invoice by hand. No invoice schedule was created.';

/** Plan approval refusal: the job is past completion, so on_completion milestones can never bill. */
export const PLAN_REFUSED_JOB_COMPLETED_REASON =
  "This job is already completed, so this plan's completion milestones can't be billed. " +
  'Invoice the balance by hand. No invoice schedule was created.';

/** The plan's positive `on_completion` milestones that have no invoice yet. */
export function unmintedCompletionMilestones(
  plan: InvoiceSchedule,
  invoices: ReadonlyArray<Invoice>,
): MilestoneAllocation[] {
  const minted = new Set(
    invoices
      .filter((inv) => inv.scheduleId === plan.id && inv.milestoneIndex !== undefined)
      .map((inv) => inv.milestoneIndex),
  );
  return splitMilestones(plan.totalAmountCents, plan.milestones).filter(
    (a) => a.trigger === 'on_completion' && a.amountCents > 0 && !minted.has(a.index),
  );
}

/**
 * The job's completion effects will bill this plan: milestone billing is on
 * and the plan still has `on_completion` milestones to mint. The only
 * condition under which auto-invoice-on-completion yields to a plan (C4).
 */
export function completionWillMintPlan(
  plan: InvoiceSchedule,
  invoices: ReadonlyArray<Invoice>,
  milestoneBillingEnabled: boolean,
): boolean {
  return milestoneBillingEnabled && unmintedCompletionMilestones(plan, invoices).length > 0;
}

export interface MilestonePlanBilling {
  plan: InvoiceSchedule;
  /** The plan's milestone invoices that still bill. */
  mintedInvoices: Invoice[];
  /** Σ of the plan's on_completion milestones not minted yet. */
  unmintedCompletionCents: number;
  /** Completion will still mint those milestones. */
  completionWillMint: boolean;
}

export interface WholeInvoiceCheck {
  estimateId: string;
  schedules: ReadonlyArray<InvoiceSchedule>;
  invoices: ReadonlyArray<Invoice>;
  /** The job's accepted estimate ids, for plans that recorded no estimate. */
  jobAcceptedEstimateIds: ReadonlyArray<string>;
  milestoneBillingEnabled: boolean;
  /** False once the job is completed/invoiced/closed: completion minting never runs again. */
  completionStillAhead: boolean;
}

/**
 * The milestone plan that bills `estimateId`, when it has billed some of it
 * or will still bill it — a whole-estimate invoice next to it would bill the
 * estimate twice. Null when no plan bills the estimate, or the plan has
 * nothing live and nothing it will still mint (e.g. milestone billing is off,
 * or the job is past completion, and no milestone invoice still bills): the
 * whole invoice is then the only thing billing the estimate.
 */
export function milestonePlanBillingEstimate(input: WholeInvoiceCheck): MilestonePlanBilling | null {
  const plan = input.schedules.find(
    (s) => planBilledEstimateId(s, input.jobAcceptedEstimateIds) === input.estimateId,
  );
  if (!plan) return null;
  const mintedInvoices = input.invoices.filter(
    (inv) => inv.scheduleId === plan.id && invoiceStillBills(inv),
  );
  const unminted = unmintedCompletionMilestones(plan, input.invoices);
  const completionWillMint =
    input.milestoneBillingEnabled && input.completionStillAhead && unminted.length > 0;
  if (mintedInvoices.length === 0 && !completionWillMint) return null;
  return {
    plan,
    mintedInvoices,
    unmintedCompletionCents: unminted.reduce((sum, a) => sum + a.amountCents, 0),
    completionWillMint,
  };
}

/** Why a whole-estimate invoice (convert, POST /api/invoices, draft_invoice) was refused. */
export function wholeInvoiceRefusedByPlanReason(billing: MilestonePlanBilling): string {
  const minted = billing.mintedInvoices
    .map((inv) => `${inv.invoiceNumber} (${formatCentsUsd(inv.totals.totalCents)})`)
    .join(', ');
  let reason =
    'This estimate is billed by a milestone plan' +
    (minted ? `: ${minted} so far` : '') +
    '. A whole-estimate invoice would bill it twice, so none was created.';
  if (billing.unmintedCompletionCents > 0) {
    reason += billing.completionWillMint
      ? ` The plan invoices the remaining ${formatCentsUsd(billing.unmintedCompletionCents)} when the job is completed.`
      : ` The plan's remaining ${formatCentsUsd(billing.unmintedCompletionCents)} is not invoiced automatically ` +
        '(the job is already complete, or milestone billing is off). Invoice it by hand if it is still owed.';
  }
  return reason;
}

/**
 * Why a whole-estimate invoice was refused when the estimate's single link
 * (`uq_invoices_estimate`) is held by one of the plan's milestone invoices
 * that no longer bills (canceled, or void with no payment). A new invoice
 * linked to the estimate can never be written, and returning that milestone
 * as "the invoice" would bill nothing.
 */
export function estimateLinkHeldByMilestoneReason(holder: Invoice): string {
  return (
    `This estimate is linked to ${holder.invoiceNumber}, a ${holder.status} invoice from its milestone plan, ` +
    'so no new invoice can be linked to it and none was created. Invoice the remaining balance by hand ' +
    '(without choosing the estimate).'
  );
}

/**
 * The reason a whole-estimate invoice for `estimateId` must not be created, or
 * undefined when it may be.
 */
export function wholeInvoiceRefusalReason(input: WholeInvoiceCheck): string | undefined {
  const billing = milestonePlanBillingEstimate(input);
  if (billing) return wholeInvoiceRefusedByPlanReason(billing);
  const heldByMilestone = input.invoices.find(
    (inv) => inv.estimateId === input.estimateId && inv.scheduleId !== undefined,
  );
  if (heldByMilestone) return estimateLinkHeldByMilestoneReason(heldByMilestone);
  return undefined;
}

export interface WholeInvoiceGuardDeps {
  scheduleRepo: InvoiceScheduleRepository;
  invoiceRepo: InvoiceRepository;
  settingsRepo: SettingsRepository;
  /** Resolves plans that recorded no estimate; absent → only recorded estimates are checked. */
  estimateRepo?: EstimateRepository;
}

/**
 * Loads what `wholeInvoiceRefusalReason` needs for a job and returns the
 * refusal reason, or undefined. The one check behind convert-to-invoice,
 * POST /api/invoices with an estimate, and the draft_invoice handler.
 */
export async function wholeInvoiceBlockedByPlan(
  deps: WholeInvoiceGuardDeps,
  input: {
    tenantId: string;
    jobId: string;
    /** Undefined when the job could not be read: completion is assumed still ahead. */
    jobStatus?: JobStatus;
    estimateId: string;
    invoices?: ReadonlyArray<Invoice>;
  },
): Promise<string | undefined> {
  const schedules = await deps.scheduleRepo.findByJob(input.tenantId, input.jobId);
  if (schedules.length === 0) return undefined;
  const invoices = input.invoices ?? (await deps.invoiceRepo.findByJob(input.tenantId, input.jobId));
  const jobAcceptedEstimateIds =
    deps.estimateRepo && schedules.some((s) => !s.estimateId)
      ? acceptedEstimateIds(await deps.estimateRepo.findByJob(input.tenantId, input.jobId))
      : [];
  const settings = await deps.settingsRepo.findByTenant(input.tenantId);
  return wholeInvoiceRefusalReason({
    estimateId: input.estimateId,
    schedules,
    invoices,
    jobAcceptedEstimateIds,
    milestoneBillingEnabled: Boolean(settings?.milestoneBillingEnabled),
    completionStillAhead: input.jobStatus === undefined || !isPostCompletionStatus(input.jobStatus),
  });
}

/** Summary of the owner draft raised when completion holds a plan's milestones. */
export function heldMilestonesSummary(
  allocations: ReadonlyArray<MilestoneAllocation>,
  inv: Invoice,
): string {
  return (
    `Milestone invoice held: estimate already billed by ${inv.invoiceNumber} ` +
    `(${allocations.map((a) => a.label).join(', ')})`
  );
}

/**
 * Explanation on the owner draft raised when completion holds a plan's
 * milestones because `inv` already bills the plan's estimate.
 */
export function heldMilestonesReason(
  allocations: ReadonlyArray<MilestoneAllocation>,
  inv: Invoice,
): string {
  const what = allocations.map((a) => `${a.label} (${formatCentsUsd(a.amountCents)})`).join(', ');
  if (inv.status === 'void') {
    return (
      `Completing the job would have invoiced ${what} from the milestone plan, but this estimate already has ` +
      `a paid voided invoice (${inv.invoiceNumber}, ${formatCentsUsd(inv.amountPaidCents)} paid). No milestone ` +
      'invoice was created. Approve this to invoice the milestones anyway, or reject it and invoice the ' +
      'remaining balance by hand.'
    );
  }
  return (
    `Completing the job would have invoiced ${what} from the milestone plan, but ${inv.invoiceNumber} ` +
    `(${formatCentsUsd(inv.totals.totalCents)}) already bills that estimate. No milestone invoice was created. ` +
    `Reject this if ${inv.invoiceNumber} covers the work; approve it to invoice the milestones anyway.`
  );
}

/**
 * Owner-facing note for plan approval: live invoices on the job that carry no
 * estimate id (e.g. a hand-made diagnostic fee). They do not block the plan,
 * but the owner should see them.
 */
export function invoicesWithoutEstimateWarning(
  invoices: ReadonlyArray<Invoice>,
  planId: string,
): string | undefined {
  const unlinked = invoices.filter(
    (inv) => !inv.estimateId && inv.scheduleId !== planId && invoiceStillBills(inv),
  );
  if (unlinked.length === 0) return undefined;
  const list = unlinked
    .map((inv) => `${inv.invoiceNumber} (${formatCentsUsd(inv.totals.totalCents)})`)
    .join(', ');
  return (
    `Heads-up: this job also has ${unlinked.length === 1 ? 'an invoice' : 'invoices'} not tied to an estimate: ` +
    `${list}. The milestone plan does not include ${unlinked.length === 1 ? 'it' : 'them'}, so check ` +
    `${unlinked.length === 1 ? 'it is' : 'they are'} not for the same work.`
  );
}
