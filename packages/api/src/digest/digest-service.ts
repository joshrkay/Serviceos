/**
 * RV-060 (F-9) — End-of-Day Digest: data composition + storage seam.
 *
 * The digest is the owner's "close the laptop" summary: money in, jobs
 * done, tomorrow's schedule, pending approvals, flags. Composition rules:
 *
 *   - Money math is NEVER re-implemented here. `computeWindowRevenue`,
 *     `resolveDayWindow`, `isInvoiceOverdue` are the SAME functions the
 *     money dashboard runs (reports/money-dashboard.ts), so the digest's
 *     numbers cannot disagree with the dashboard for the same day —
 *     asserted by test/digest/digest-dashboard-parity.test.ts.
 *   - All date bucketing is tenant-timezone (the dashboard's tz util).
 *   - Storage is idempotent on (tenant, digest_date): `upsert` overwrites
 *     the snapshot; `insertIfAbsent` is the worker's send-race guard (only
 *     the inserter sends the SMS).
 */
import { v4 as uuidv4 } from 'uuid';
import type { PaymentRepository } from '../invoices/payment';
import type { InvoiceRepository, Invoice } from '../invoices/invoice';
import type { EstimateRepository } from '../estimates/estimate';
import type { JobRepository } from '../jobs/job';
import type { AppointmentRepository } from '../appointments/appointment';
import type { ProposalRepository, Proposal } from '../proposals/proposal';
import type { CustomerRepository } from '../customers/customer';
import type { SettingsRepository } from '../settings/settings';
import { prioritizeProposals } from '../proposals/prioritization';
import { findJobsRequiringInvoicing } from '../invoices/invoicing-queue';
import {
  resolveDayWindow,
  computeWindowRevenue,
  isInvoiceOwing,
  isInvoiceOverdue,
} from '../reports/money-dashboard';

// ─────────────────────────────────────────────────────────────────────────────
// Payload shape (stored as the daily_digests.payload JSONB snapshot)
// ─────────────────────────────────────────────────────────────────────────────

export interface DigestPendingApproval {
  proposalId: string;
  proposalType: string;
  summary: string;
  /** Best-effort from the proposal payload — absent when not derivable. */
  customerName?: string;
  /** Best-effort from the proposal payload — absent when not derivable. */
  amountCents?: number;
}

export interface DigestUnbilledJob {
  jobId: string;
  customerId: string;
  customerName?: string;
  amountCents: number;
}

export interface DailyDigestPayload {
  /** Tenant-local calendar day this digest covers (YYYY-MM-DD). */
  date: string;
  timezone: string;
  /** NET money in today (gross − refunds) — same math as the dashboard. */
  revenueCents: number;
  grossRevenueCents: number;
  refundsCents: number;
  /** Completed payments received inside today's window. */
  paymentsCount: number;
  jobsCompletedCount: number;
  tomorrow: {
    appointmentCount: number;
    /** UTC ISO instant of the earliest non-canceled appointment, or null. */
    firstStartIso: string | null;
  };
  pendingApprovals: {
    totalCount: number;
    /** Top 3 by inbox priority order. */
    top: DigestPendingApproval[];
  };
  overdueInvoicesCount: number;
  /** Completed jobs with nothing invoiced yet (same query the batch-invoice sweep runs). */
  unbilledJobs: DigestUnbilledJob[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Max pending approvals embedded in the digest payload (SMS shows ≤ this). */
export const DIGEST_TOP_APPROVALS = 3;
/** Cap on unbilled jobs listed in the payload — the web view shows the rest. */
export const DIGEST_MAX_UNBILLED_JOBS = 10;

const AMOUNT_KEYS = ['amountCents', 'totalCents', 'priceCents'] as const;

function extractAmountCents(payload: Record<string, unknown>): number | undefined {
  const totals = payload.totals;
  if (totals && typeof totals === 'object') {
    const t = (totals as Record<string, unknown>).totalCents;
    if (typeof t === 'number') return t;
  }
  for (const key of AMOUNT_KEYS) {
    const v = payload[key];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

function extractCustomerName(proposal: Proposal): string | undefined {
  const fromRecord = (obj: Record<string, unknown> | undefined): string | undefined => {
    if (!obj) return undefined;
    const v = obj.customerName ?? obj.customer_name;
    return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
  };
  return fromRecord(proposal.payload) ?? fromRecord(proposal.sourceContext);
}

/**
 * Best-effort projection of a pending proposal into the digest line item
 * (type / customer / amount). Pure — tolerates any payload shape.
 */
export function summarizeProposalForDigest(proposal: Proposal): DigestPendingApproval {
  const amountCents = extractAmountCents(proposal.payload ?? {});
  const customerName = extractCustomerName(proposal);
  return {
    proposalId: proposal.id,
    proposalType: proposal.proposalType,
    summary: proposal.summary,
    ...(customerName !== undefined ? { customerName } : {}),
    ...(amountCents !== undefined ? { amountCents } : {}),
  };
}

/** YYYY-MM-DD for `instant` in `timezone` (en-CA emits ISO date order). */
export function localDateString(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** The calendar day after `date` (YYYY-MM-DD), via UTC arithmetic (DST-safe). */
export function nextDateString(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** $12 / $12.50 formatting for SMS — integer cents in, no float math. */
export function formatUsd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return rem === 0
    ? `${sign}$${dollars}`
    : `${sign}$${dollars}.${String(rem).padStart(2, '0')}`;
}

/**
 * Deterministic narrative used whenever the LLM path is unavailable or
 * fails — the digest must NEVER fail to send because the LLM was down.
 */
export function buildFallbackNarrative(payload: DailyDigestPayload): string {
  const parts: string[] = [];
  parts.push(
    `Today you brought in ${formatUsd(payload.revenueCents)} and completed ` +
      `${payload.jobsCompletedCount} ${payload.jobsCompletedCount === 1 ? 'job' : 'jobs'}.`,
  );
  if (payload.tomorrow.appointmentCount > 0) {
    const first = payload.tomorrow.firstStartIso
      ? ` starting at ${formatLocalTime(payload.tomorrow.firstStartIso, payload.timezone)}`
      : '';
    parts.push(
      `Tomorrow has ${payload.tomorrow.appointmentCount} ` +
        `${payload.tomorrow.appointmentCount === 1 ? 'visit' : 'visits'}${first}.`,
    );
  } else {
    parts.push('Tomorrow is clear.');
  }
  if (payload.pendingApprovals.totalCount > 0) {
    parts.push(
      `${payload.pendingApprovals.totalCount} ` +
        `${payload.pendingApprovals.totalCount === 1 ? 'approval is' : 'approvals are'} waiting on you.`,
    );
  }
  const flags: string[] = [];
  if (payload.overdueInvoicesCount > 0) {
    flags.push(`${payload.overdueInvoicesCount} overdue ${payload.overdueInvoicesCount === 1 ? 'invoice' : 'invoices'}`);
  }
  if (payload.unbilledJobs.length > 0) {
    flags.push(`${payload.unbilledJobs.length} completed ${payload.unbilledJobs.length === 1 ? 'job' : 'jobs'} not yet invoiced`);
  }
  if (flags.length > 0) parts.push(`Flags: ${flags.join(', ')}.`);
  if (
    payload.revenueCents === 0 &&
    payload.jobsCompletedCount === 0 &&
    payload.pendingApprovals.totalCount === 0 &&
    flags.length === 0
  ) {
    return `A quiet day — nothing came in and nothing is waiting on you. ${parts[1]}`;
  }
  return parts.join(' ');
}

function formatLocalTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

// ─────────────────────────────────────────────────────────────────────────────
// SMS rendering (≤ 480 chars, enforced in code)
// ─────────────────────────────────────────────────────────────────────────────

export const DIGEST_SMS_MAX_CHARS = 480;

export interface DigestSmsApprovalLink {
  approval: DigestPendingApproval;
  /** One-tap approve URL (signed token minted by the worker). */
  url: string;
}

export interface RenderDigestSmsInput {
  payload: DailyDigestPayload;
  /** Web deep link to the full digest (`<base>/digest/<date>`). */
  deepLinkUrl: string;
  /** One-tap links for the top approvals, in priority order. */
  approvalLinks: DigestSmsApprovalLink[];
  maxChars?: number;
}

function approvalLabel(a: DigestPendingApproval): string {
  const bits: string[] = [a.proposalType.replace(/_/g, ' ')];
  if (a.amountCents !== undefined) bits.push(formatUsd(a.amountCents));
  if (a.customerName) bits.push(a.customerName);
  return bits.join(' ');
}

/**
 * Deterministic SMS body. The character budget is enforced HERE — one-tap
 * URLs are long, so approval entries are included greedily in priority
 * order and the remainder collapses into "+N more"; the counts line and
 * the deep link always survive. Never exceeds `maxChars`.
 */
export function renderDigestSms(input: RenderDigestSmsInput): string {
  const { payload, deepLinkUrl, approvalLinks } = input;
  const maxChars = input.maxChars ?? DIGEST_SMS_MAX_CHARS;

  const first = payload.tomorrow.firstStartIso
    ? `, first ${formatLocalTime(payload.tomorrow.firstStartIso, payload.timezone)}`
    : '';
  const head =
    `[Rivet] Day: ${formatUsd(payload.revenueCents)} in, ` +
    `${payload.jobsCompletedCount} jobs done. ` +
    `Tomorrow: ${payload.tomorrow.appointmentCount} visits${first}.`;

  const flagBits: string[] = [];
  if (payload.overdueInvoicesCount > 0) flagBits.push(`${payload.overdueInvoicesCount} overdue`);
  if (payload.unbilledJobs.length > 0) flagBits.push(`${payload.unbilledJobs.length} unbilled`);
  const flags = flagBits.length > 0 ? ` Flags: ${flagBits.join(', ')}.` : '';

  const tail = ` Full day: ${deepLinkUrl}`;

  const total = payload.pendingApprovals.totalCount;
  if (total === 0) {
    return truncateHard(`${head}${flags}${tail}`, maxChars);
  }

  // Greedily include approval entries while the assembled message (with
  // the "+N more" marker for whatever doesn't fit) stays within budget.
  // No punctuation ever directly follows a one-tap URL — a trailing '.'
  // would be swallowed into the link by SMS clients and corrupt the token.
  const entries = approvalLinks.map(
    (l, i) => ` [${i + 1}] ${approvalLabel(l.approval)} ${l.url}`,
  );
  let included = entries.length;
  while (included >= 0) {
    const rest = total - included;
    const moreMarker = rest > 0 ? ` +${rest} more` : '';
    const body =
      `${head} Approvals: ${total} waiting —` +
      entries.slice(0, included).join('') +
      `${moreMarker}${flags}${tail}`;
    if (body.length <= maxChars) return body;
    included--;
  }
  // Even the zero-entry form is over budget (pathological URLs): hard-cut.
  return truncateHard(`${head} Approvals: ${total} waiting${flags}${tail}`, maxChars);
}

function truncateHard(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

// ─────────────────────────────────────────────────────────────────────────────
// computeDigestPayload — pure composition over tenant-scoped repositories
// ─────────────────────────────────────────────────────────────────────────────

export interface DigestComputeDeps {
  paymentRepo: PaymentRepository;
  invoiceRepo: InvoiceRepository;
  estimateRepo: EstimateRepository;
  jobRepo: JobRepository;
  appointmentRepo: AppointmentRepository;
  proposalRepo: ProposalRepository;
  customerRepo: CustomerRepository;
  settingsRepo: SettingsRepository;
  /** Injectable clock — overdue is "as of now". Defaults to `new Date()`. */
  now?: () => Date;
}

/**
 * Payments fetch lower bound: refunds bucket by `refundedAt`, but the repo
 * filters by `receivedAt`, so we reach back far enough to catch refunds
 * issued today on payments received up to ~2 months ago — the same span
 * the money dashboard fetches (priorStart → end).
 */
const PAYMENT_LOOKBACK_DAYS = 62;
const COMPLETED_JOBS_FETCH_LIMIT = 200;

export async function computeDigestPayload(
  tenantId: string,
  date: string,
  deps: DigestComputeDeps,
): Promise<DailyDigestPayload> {
  const now = deps.now ?? (() => new Date());
  const settings = await deps.settingsRepo.findByTenant(tenantId);
  const timezone = settings?.timezone ?? 'America/New_York';

  const today = resolveDayWindow(date, timezone);
  const tomorrow = resolveDayWindow(nextDateString(date), timezone);

  const paymentsFrom = new Date(today.start.getTime() - PAYMENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const [payments, completedJobs, tomorrowAppointments, openInvoices, partiallyPaidInvoices, pendingProposals, unbilledCandidates] =
    await Promise.all([
      deps.paymentRepo.findByTenant(tenantId, {
        status: 'completed',
        from: paymentsFrom,
        to: today.end,
      }),
      deps.jobRepo.findByTenant(tenantId, {
        status: 'completed',
        limit: COMPLETED_JOBS_FETCH_LIMIT,
        sort: 'desc',
      }),
      deps.appointmentRepo.findByDateRange(tenantId, tomorrow.start, tomorrow.end),
      deps.invoiceRepo.findByTenant(tenantId, { status: 'open' }),
      deps.invoiceRepo.findByTenant(tenantId, { status: 'partially_paid' }),
      deps.proposalRepo.findByStatus(tenantId, 'ready_for_review'),
      findJobsRequiringInvoicing(tenantId, deps),
    ]);

  // Money in today — the dashboard's own window-revenue function over the
  // dashboard's own tenant-tz day boundaries.
  const revenue = computeWindowRevenue(payments, today.start, today.end);
  const paymentsCount = payments.filter(
    (p) =>
      p.status === 'completed' &&
      p.receivedAt.getTime() >= today.start.getTime() &&
      p.receivedAt.getTime() < today.end.getTime(),
  ).length;

  // Jobs completed today. Jobs carry no completion timestamp; 'completed'
  // is terminal (no transitions out), so `updatedAt` of a completed job is
  // the completion-time approximation — documented, and good enough for a
  // daily count.
  const jobsCompletedCount = completedJobs.filter(
    (j) =>
      j.updatedAt.getTime() >= today.start.getTime() &&
      j.updatedAt.getTime() < today.end.getTime(),
  ).length;

  // Tomorrow's schedule: everything still on the calendar.
  const liveAppointments = tomorrowAppointments.filter((a) => a.status !== 'canceled');
  const firstStart =
    liveAppointments.length > 0
      ? liveAppointments.reduce((min, a) => (a.scheduledStart < min ? a.scheduledStart : min), liveAppointments[0].scheduledStart)
      : null;

  // Pending approvals — inbox priority order, top 3 + total.
  const prioritized = prioritizeProposals(pendingProposals);
  const top = prioritized
    .slice(0, DIGEST_TOP_APPROVALS)
    .map((p) => summarizeProposalForDigest(p.proposal));

  // Overdue invoices — the dashboard's predicate, counted.
  const owing: Invoice[] = [...openInvoices, ...partiallyPaidInvoices];
  const asOf = now();
  const overdueInvoicesCount = owing.filter((i) => isInvoiceOverdue(i, asOf) && isInvoiceOwing(i)).length;

  // Completed-unbilled jobs — same query the batch-invoice sweep runs.
  const unbilledJobs: DigestUnbilledJob[] = [];
  for (const candidate of unbilledCandidates.slice(0, DIGEST_MAX_UNBILLED_JOBS)) {
    let customerName: string | undefined;
    try {
      const customer = await deps.customerRepo.findById(tenantId, candidate.customerId);
      customerName = customer?.displayName;
    } catch {
      // Name resolution is decorative — never fail the digest over it.
    }
    unbilledJobs.push({
      jobId: candidate.jobId,
      customerId: candidate.customerId,
      ...(customerName !== undefined ? { customerName } : {}),
      amountCents: candidate.amountCents,
    });
  }

  return {
    date,
    timezone,
    revenueCents: revenue.revenueCents,
    grossRevenueCents: revenue.grossRevenueCents,
    refundsCents: revenue.refundsCents,
    paymentsCount,
    jobsCompletedCount,
    tomorrow: {
      appointmentCount: liveAppointments.length,
      firstStartIso: firstStart ? firstStart.toISOString() : null,
    },
    pendingApprovals: {
      totalCount: pendingProposals.length,
      top,
    },
    overdueInvoicesCount,
    unbilledJobs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage seam
// ─────────────────────────────────────────────────────────────────────────────

export interface DailyDigestRecord {
  id: string;
  tenantId: string;
  /** YYYY-MM-DD (tenant-local calendar day). */
  digestDate: string;
  payload: DailyDigestPayload;
  narrative?: string;
  smsDispatchId?: string;
  generatedAt: Date;
}

export interface DailyDigestRepository {
  /** Idempotent on (tenant, date): overwrites payload/narrative in place. */
  upsert(
    tenantId: string,
    digestDate: string,
    payload: DailyDigestPayload,
    narrative?: string,
  ): Promise<DailyDigestRecord>;
  /**
   * INSERT … ON CONFLICT DO NOTHING semantics. `inserted: false` means
   * another writer already owns this (tenant, date) — the worker's
   * double-send race guard (only the inserter proceeds to send).
   */
  insertIfAbsent(
    tenantId: string,
    digestDate: string,
    payload: DailyDigestPayload,
    narrative?: string,
  ): Promise<{ digest: DailyDigestRecord; inserted: boolean }>;
  findByTenantAndDate(tenantId: string, digestDate: string): Promise<DailyDigestRecord | null>;
  /**
   * Status-check claim: sets sms_dispatch_id ONLY when it is still NULL.
   * Returns null when another sender already recorded a dispatch — the
   * second layer of the double-send guard.
   */
  setSmsDispatchId(
    tenantId: string,
    digestDate: string,
    smsDispatchId: string,
  ): Promise<DailyDigestRecord | null>;
}

/** RV-060 service entry point: idempotent store of a computed digest. */
export async function upsertDigest(
  tenantId: string,
  date: string,
  payload: DailyDigestPayload,
  narrative: string | undefined,
  repo: DailyDigestRepository,
): Promise<DailyDigestRecord> {
  return repo.upsert(tenantId, date, payload, narrative);
}

export class InMemoryDailyDigestRepository implements DailyDigestRepository {
  private readonly rows = new Map<string, DailyDigestRecord>();

  private key(tenantId: string, digestDate: string): string {
    return `${tenantId}:${digestDate}`;
  }

  async upsert(
    tenantId: string,
    digestDate: string,
    payload: DailyDigestPayload,
    narrative?: string,
  ): Promise<DailyDigestRecord> {
    const key = this.key(tenantId, digestDate);
    const existing = this.rows.get(key);
    const row: DailyDigestRecord = {
      id: existing?.id ?? uuidv4(),
      tenantId,
      digestDate,
      payload,
      ...(narrative !== undefined ? { narrative } : {}),
      ...(existing?.smsDispatchId !== undefined ? { smsDispatchId: existing.smsDispatchId } : {}),
      generatedAt: new Date(),
    };
    this.rows.set(key, row);
    return { ...row };
  }

  async insertIfAbsent(
    tenantId: string,
    digestDate: string,
    payload: DailyDigestPayload,
    narrative?: string,
  ): Promise<{ digest: DailyDigestRecord; inserted: boolean }> {
    const key = this.key(tenantId, digestDate);
    const existing = this.rows.get(key);
    if (existing) return { digest: { ...existing }, inserted: false };
    const row = await this.upsert(tenantId, digestDate, payload, narrative);
    return { digest: row, inserted: true };
  }

  async findByTenantAndDate(tenantId: string, digestDate: string): Promise<DailyDigestRecord | null> {
    const row = this.rows.get(this.key(tenantId, digestDate));
    return row ? { ...row } : null;
  }

  async setSmsDispatchId(
    tenantId: string,
    digestDate: string,
    smsDispatchId: string,
  ): Promise<DailyDigestRecord | null> {
    const key = this.key(tenantId, digestDate);
    const row = this.rows.get(key);
    if (!row || row.smsDispatchId !== undefined) return null;
    const updated = { ...row, smsDispatchId };
    this.rows.set(key, updated);
    return { ...updated };
  }
}
