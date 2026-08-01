// U10 (E5b) — client types + pure display helpers for the service-agreements
// (recurring/membership) read screens. Mirrors the server domain shapes
// (packages/api/src/agreements/agreement.ts + agreement-run.ts) as they arrive
// over the wire from GET /api/agreements and GET /api/agreements/:id — Date
// fields serialize to ISO strings through JSON, so they are typed `string`
// here. Money is always integer cents (never float); render via
// formatMoneyCents. No RN imports so it unit-tests without a renderer.

/** ServiceAgreement as served by the list/detail endpoints. */
export interface Agreement {
  id: string;
  customerId: string;
  locationId?: string;
  name: string;
  description?: string;
  /** Raw RRULE string (the cadence). Humanize with {@link humanizeRecurrence}. */
  recurrenceRule: string;
  /** Recurring price in INTEGER CENTS. */
  priceCents: number;
  autoGenerateInvoice: boolean;
  autoGenerateJob: boolean;
  /** Next scheduled run / next-invoice date (UTC instant → ISO string). */
  nextRunAt?: string;
  /** Last successful run (UTC instant → ISO string); absent until the first run. */
  lastRunAt?: string;
  status: string;
  /** Calendar dates (YYYY-MM-DD). */
  startsOn: string;
  endsOn?: string;
  autoRenew?: boolean;
  renewalTermMonths?: number;
  memberDiscountBps?: number;
  priorityBooking?: boolean;
  autoCollectDues?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** One audit row per recurrence cycle (last 25 embedded on the detail read). */
export interface AgreementRun {
  id: string;
  agreementId: string;
  /** Calendar date (YYYY-MM-DD) the run was scheduled for. */
  scheduledFor: string;
  generatedJobId?: string;
  generatedInvoiceId?: string;
  status: string;
  errorMessage?: string;
  createdAt?: string;
}

/** GET /api/agreements/:id → the agreement plus its last 25 runs. */
export interface AgreementDetail extends Agreement {
  recentRuns?: AgreementRun[];
}

const FREQ_LABEL: Record<string, string> = {
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  YEARLY: 'Yearly',
  ANNUALLY: 'Yearly',
};

// Plural noun for the "Every N <unit>" form when INTERVAL > 1.
const FREQ_UNIT: Record<string, string> = {
  DAILY: 'days',
  WEEKLY: 'weeks',
  MONTHLY: 'months',
  QUARTERLY: 'quarters',
  YEARLY: 'years',
  ANNUALLY: 'years',
};

/**
 * Humanize a raw RRULE cadence for display, e.g. "FREQ=MONTHLY" → "Monthly",
 * "FREQ=WEEKLY;INTERVAL=2" → "Every 2 weeks". Covers the common FREQ/INTERVAL
 * cases the agreements domain emits (DAILY/WEEKLY/MONTHLY/QUARTERLY/YEARLY).
 *
 * SAFE FALLBACK: anything unusual — a missing/unknown FREQ, a malformed
 * segment, or a non-positive-integer INTERVAL — returns the raw rule trimmed,
 * so the owner always sees *something* truthful rather than a wrong label. We
 * deliberately do NOT reimplement the full server parser (BYMONTHDAY, leap-day
 * clamping, etc. — packages/api/src/agreements/recurrence.ts); those details
 * don't change the cadence label and server code must not be imported into
 * mobile.
 */
export function humanizeRecurrence(rule: string | null | undefined): string {
  if (typeof rule !== 'string') return '';
  const raw = rule.trim();
  if (raw.length === 0) return '';

  const map: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const seg = part.trim();
    if (seg.length === 0) continue;
    const eq = seg.indexOf('=');
    if (eq === -1) return raw; // malformed segment → raw fallback
    map[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  }

  const freq = map.FREQ?.toUpperCase();
  if (!freq || !(freq in FREQ_LABEL)) return raw; // unknown/absent FREQ → raw

  let interval = 1;
  if (map.INTERVAL !== undefined) {
    const n = Number(map.INTERVAL);
    if (!Number.isInteger(n) || n < 1) return raw; // bad INTERVAL → raw
    interval = n;
  }

  return interval === 1 ? FREQ_LABEL[freq] : `Every ${interval} ${FREQ_UNIT[freq]}`;
}

/** Display name for a customer joined from GET /api/customers/:id. */
export function agreementCustomerName(
  customer?: {
    displayName?: string;
    firstName?: string;
    lastName?: string;
  } | null,
): string | undefined {
  if (!customer) return undefined;
  return (
    customer.displayName ||
    [customer.firstName, customer.lastName].filter(Boolean).join(' ') ||
    undefined
  );
}
