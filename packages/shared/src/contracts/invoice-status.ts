import { InvoiceStatus } from '../enums.js';

/**
 * Statuses with a balance still owed — the only ones that can read "overdue".
 * A paid, draft, void, or canceled invoice is never overdue, whatever its due
 * date.
 */
const OVERDUE_ELIGIBLE: ReadonlySet<string> = new Set<string>([
  InvoiceStatus.OPEN,
  InvoiceStatus.PARTIALLY_PAID,
]);

/**
 * Derive whether an invoice is overdue.
 *
 * "Overdue" is NOT a persisted status — the canonical `InvoiceStatus` has no
 * such value. It's derived at presentation time: an `open` or `partially_paid`
 * invoice whose due date has passed. Shared so web (`utils/statusNormalize`)
 * and mobile (`lib/entityStatus`) apply the EXACT same rule and can't drift —
 * a UI showing "overdue" on one platform but not the other would mislead the
 * owner about which invoices to chase.
 *
 * `now` is injectable for deterministic tests. Unparseable/missing `dueDate`
 * is treated as not-overdue (we never invent an overdue from bad data).
 */
export function isInvoiceOverdue(
  status: string | undefined,
  dueDate?: string,
  now: number = Date.now(),
): boolean {
  if (!status || !OVERDUE_ELIGIBLE.has(status) || !dueDate) return false;
  const due = new Date(dueDate).getTime();
  return !Number.isNaN(due) && due < now;
}
