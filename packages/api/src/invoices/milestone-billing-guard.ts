/**
 * #1203 — a milestone plan bills ONE recorded estimate, and that estimate is
 * never billed twice.
 *
 * `invoice_schedules.estimate_id` names the estimate a plan bills. Plan
 * approval records it (CreateInvoiceScheduleExecutionHandler), and every check
 * here compares against THAT estimate only. Another estimate on the same job,
 * such as a change order or a diagnostic estimate, never blocks a plan.
 *
 * Both orders are guarded:
 *   - Whole invoice first, then a plan (`wholeInvoiceBillingEstimate`): plan
 *     approval refuses. Completion minting holds the milestones as an owner
 *     draft instead of dropping them, because completion runs once.
 *   - Plan first, then a whole invoice (`milestonePlanBillingEstimate`):
 *     convert-to-invoice and draft_invoice refuse. Auto-invoice-on-completion
 *     yields only to milestones completion is about to mint
 *     (`completionWillMintPlan`).
 *
 * Nothing here computes an amount. It only reads the plan's existing split
 * (`splitMilestones`) to tell which milestones are still unminted.
 */
import type { Invoice } from './invoice';
import { InvoiceSchedule, MilestoneAllocation, splitMilestones } from './invoice-schedule';

/** "$1,000.00" from integer cents (display only; no arithmetic on the result). */
export function formatCentsUsd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Whether an invoice still bills its estimate. A canceled invoice never does.
 * A void invoice does only while it holds a payment, because money was taken
 * against the estimate.
 */
export function invoiceStillBills(inv: Pick<Invoice, 'status' | 'amountPaidCents'>): boolean {
  if (inv.status === 'canceled') return false;
  if (inv.status === 'void') return inv.amountPaidCents > 0;
  return true;
}

/**
 * A still-billing invoice for `estimateId` that is not one of `planId`'s own
 * milestones. Membership comes from `schedule_id`: the plan's first milestone
 * carries the estimate id, and it must never block the plan's later milestones.
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
      `This estimate was invoiced as ${inv.invoiceNumber}, which is void but still holds ` +
      `${formatCentsUsd(inv.amountPaidCents)} of payments. Refund or move that payment first, then set up the ` +
      'milestone plan. No invoice schedule was created.'
    );
  }
  return (
    `This estimate is already invoiced as ${inv.invoiceNumber} (${formatCentsUsd(inv.totals.totalCents)}), ` +
    'so a milestone plan would bill it twice. No invoice schedule was created.'
  );
}

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
 * and the plan still has `on_completion` milestones to mint. This is the only
 * condition under which auto-invoice-on-completion yields to a plan.
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

/**
 * The milestone plan that bills `estimateId`, when it has billed some of it
 * or will still bill it. A whole-estimate invoice next to it would bill the
 * estimate twice. Returns null when no plan records the estimate, or the plan
 * has nothing live and nothing that will still mint. For example, milestone
 * billing is off, or the job is already past completion, and no milestone
 * invoice still bills. The whole invoice is then the only thing that bills
 * the estimate.
 */
export function milestonePlanBillingEstimate(input: {
  estimateId: string;
  schedules: ReadonlyArray<InvoiceSchedule>;
  invoices: ReadonlyArray<Invoice>;
  milestoneBillingEnabled: boolean;
  /** False once the job is completed/invoiced/closed: completion minting never runs again. */
  completionStillAhead: boolean;
}): MilestonePlanBilling | null {
  const plan = input.schedules.find((s) => s.estimateId === input.estimateId);
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

/** Why a whole-estimate invoice (convert or draft_invoice) was refused. */
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
      `Completing the job would have invoiced ${what} from the milestone plan, but ${inv.invoiceNumber} is void ` +
      `and still holds ${formatCentsUsd(inv.amountPaidCents)} of payments against that estimate. No milestone ` +
      'invoice was created. Refund or move that payment, then approve this to invoice the milestones.'
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
 * which bills its own estimate, but the owner should see them.
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
    `${list}. The milestone plan bills its estimate only, so check ${unlinked.length === 1 ? 'it is' : 'they are'} ` +
    'not for the same work.'
  );
}
