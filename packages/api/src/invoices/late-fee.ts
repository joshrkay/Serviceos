/**
 * P20-004 — Late-fee accrual (pure calculation).
 *
 * Given a tenant's dunning policy and an invoice's outstanding state, compute
 * the late-fee amount (integer cents) to accrue for the current period. This
 * is a pure function with no I/O: the overdue sweep (P20-003) calls it, then
 * appends the result as an invoice line item via the billing engine and
 * records an `invoice_dunning_events(kind='late_fee')` row for idempotency.
 *
 * Money discipline: all amounts are integer cents; percent fees are stored in
 * basis points (bps) of the outstanding balance — `cents * bps / 10000`,
 * rounded to the nearest cent, matching billing-engine tax math.
 */
import { DunningConfig } from './dunning-config';

export interface LateFeeInput {
  /** Current outstanding balance on the invoice, in cents. */
  amountDueCents: number;
  /** Invoice due date. */
  dueDate: Date;
  /** Evaluation time. */
  now: Date;
  /**
   * Sum of late fees already accrued on this invoice, in cents. Used to honor
   * the optional cap (`lateFeeMaxCents`). Defaults to 0.
   */
  alreadyAccruedCents?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days `now` is past `dueDate` (0 when not yet due). */
export function daysPastDue(dueDate: Date, now: Date): number {
  const diff = now.getTime() - dueDate.getTime();
  if (diff <= 0) return 0;
  return Math.floor(diff / MS_PER_DAY);
}

/**
 * Compute the late fee to accrue now, in integer cents. Returns 0 when:
 * - the policy is `none`, disabled, or has a non-positive value;
 * - nothing is outstanding;
 * - the grace period has not elapsed;
 * - the cap (`lateFeeMaxCents`) is already reached.
 */
export function computeLateFeeCents(config: DunningConfig, input: LateFeeInput): number {
  const { amountDueCents, dueDate, now } = input;
  const alreadyAccruedCents = input.alreadyAccruedCents ?? 0;

  if (!config.enabled) return 0;
  if (config.lateFeeType === 'none') return 0;
  if (config.lateFeeValueCents <= 0) return 0;
  if (amountDueCents <= 0) return 0;

  // Grace: fee applies only strictly after the grace window elapses.
  if (daysPastDue(dueDate, now) <= config.lateFeeGraceDays) return 0;

  let fee: number;
  if (config.lateFeeType === 'flat') {
    fee = Math.round(config.lateFeeValueCents);
  } else {
    // percent: value is basis points of the outstanding balance.
    fee = Math.round((amountDueCents * config.lateFeeValueCents) / 10000);
  }

  if (config.lateFeeMaxCents !== undefined) {
    const remaining = Math.max(0, config.lateFeeMaxCents - alreadyAccruedCents);
    fee = Math.min(fee, remaining);
  }

  return Math.max(0, fee);
}
