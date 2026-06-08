/**
 * Feature 6 — Time-entry-based invoice recalculation (launch-readiness pass).
 *
 * Pure helper that, given estimate line items and a job's logged time entries,
 * replaces the labor line's quantity with the ACTUAL hours worked and
 * recomputes that line's total via the shared billing engine. Materials,
 * equipment, and other lines pass through untouched; document totals are
 * recomputed by the caller (or via calculateDocumentTotals).
 *
 * Safe by construction:
 *  - No tracked time  -> bill the estimate as-is (never zero out labor).
 *  - No labor line     -> unchanged (don't invent a labor rate).
 *  - Multiple labor lines -> unchanged (ambiguous split; documented, can extend).
 * The billed rate is always the estimate labor line's agreed unitPriceCents,
 * never an internal cost rate.
 */
import { LineItem, calculateLineItemTotal } from '../shared/billing-engine';
import { TimeEntry, EntryType } from '../time-tracking/time-entry';

export interface LaborRecalcOptions {
  /** Count `drive` time as billable labor in addition to `job` time. Default false. */
  includeDriveTime?: boolean;
}

export interface LaborRecalcResult {
  lineItems: LineItem[];
  /** Actual hours billed (2dp). 0 when no adjustment was made. */
  laborHoursBilled: number;
  /** True when the labor line was recalculated from tracked time. */
  adjusted: boolean;
}

function billableMinutes(timeEntries: TimeEntry[], includeDriveTime: boolean): number {
  const billableTypes: ReadonlySet<EntryType> = includeDriveTime
    ? new Set<EntryType>(['job', 'drive'])
    : new Set<EntryType>(['job']);
  return timeEntries
    .filter((e) => billableTypes.has(e.entryType) && typeof e.durationMinutes === 'number')
    .reduce((sum, e) => sum + (e.durationMinutes as number), 0);
}

export function recalculateLaborFromTimeEntries(
  lineItems: LineItem[],
  timeEntries: TimeEntry[],
  opts: LaborRecalcOptions = {},
): LaborRecalcResult {
  const minutes = billableMinutes(timeEntries, opts.includeDriveTime ?? false);
  if (minutes <= 0) {
    return { lineItems, laborHoursBilled: 0, adjusted: false };
  }

  const laborItems = lineItems.filter((li) => li.category === 'labor');
  // Only the unambiguous single-labor-line case is auto-adjusted. Zero labor
  // lines means there's nothing to attach hours to; multiple labor lines would
  // require an opinionated split, so we leave the accepted estimate as-is.
  if (laborItems.length !== 1) {
    return { lineItems, laborHoursBilled: 0, adjusted: false };
  }

  const labor = laborItems[0];
  const hours = Math.round((minutes / 60) * 100) / 100; // 2dp hours

  const recalculated = lineItems.map((li) =>
    li.id === labor.id
      ? { ...li, quantity: hours, totalCents: calculateLineItemTotal(hours, li.unitPriceCents) }
      : li,
  );

  return { lineItems: recalculated, laborHoursBilled: hours, adjusted: true };
}
