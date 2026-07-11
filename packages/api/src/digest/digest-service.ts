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
import type { ProposalRepository, Proposal, ProposalStatus } from '../proposals/proposal';
import { missingFieldsFor } from '../proposals/proposal';
import type { CustomerRepository } from '../customers/customer';
import type { SettingsRepository } from '../settings/settings';
import type { CorrectionLessonRepository } from '../learning/corrections/correction-lesson';
import { prioritizeProposals } from '../proposals/prioritization';
import { AUTO_APPROVE_BLOCKING_CONFIDENCE_LEVELS } from '../proposals/auto-approve';
import { findJobsRequiringInvoicing } from '../invoices/invoicing-queue';
import {
  resolveDayWindow,
  computeWindowRevenue,
  inWindow,
  isInvoiceOwing,
  isInvoiceOverdue,
} from '../reports/money-dashboard';
import type { FeedbackResponseRepository } from '../feedback/feedback-response';
import { totalResponses, averageRating, lowRatingCount } from '../feedback/feedback-response';

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
  /**
   * Forwarded from `payload._meta.overallConfidence` when present.
   * Used by the worker to suppress one-tap links for low/very_low proposals
   * (they must be reviewed in-app); absent when _meta is not present.
   */
  overallConfidence?: string;
  /**
   * True when the proposal's confidence is too low for a one-tap link.
   * The web digest view uses this to route the operator to the in-app
   * review flow instead of offering a one-tap approve button.
   * Absent (falsy) when one-tap is allowed.
   */
  reviewInApp?: true;
  /**
   * True when the proposal has unresolved `missingFields` (e.g. an ambiguous
   * catalog line on a draft estimate). `approveProposal` rejects such
   * proposals, so the worker must suppress one-tap / "APPROVE ALL" links for
   * them — they surface in the digest deep link for in-app review only.
   * Absent (falsy) when there are no missing fields.
   */
  hasMissingFields?: true;
}

export interface DigestUnbilledJob {
  jobId: string;
  customerId: string;
  customerName?: string;
  amountCents: number;
}

/** N-005 — quotes sent today (count + pipeline value). */
export interface DigestQuotesSent {
  count: number;
  /** Sum of estimate totals.totalCents for estimates sent in today's window. */
  pipelineValueCents: number;
}

/** Outcome of a confidence-marked proposal, derived from its status at generation time. */
export type DigestUnsureOutcome =
  | 'pending'
  | 'approved'
  | 'executed'
  | 'rejected'
  | 'expired'
  | 'undone'
  | 'failed';

/**
 * N-005 "what I wasn't sure about today" — one proposal created today whose
 * `_meta.overallConfidence` fired a blocking marker (low / very_low), plus
 * what the owner did with it (derived from the proposal's current status).
 */
export interface DigestUnsureItem {
  proposalId: string;
  proposalType: string;
  summary: string;
  /** The marker level that fired: 'low' | 'very_low'. */
  confidence: string;
  /** Optional confidenceFactors from the proposal (surfaced on the web view). */
  factors?: string[];
  /**
   * Outcome derived from the proposal's status AT GENERATION TIME — the stored
   * snapshot is the source of truth for what was sent; regenerating after the
   * owner acts on a proposal yields a newer outcome (documented + pinned by the
   * regeneration test).
   */
  outcome: DigestUnsureOutcome;
}

/** N-005 "what I learned today" — one correction-loop lesson applied today. */
export interface DigestLearnedItem {
  lessonId: string;
  /** labor_rate_changed | part_price_changed | banned_phrase | scope_reclassified */
  lessonType: string;
  /** Human-readable line straight from correction_lessons.summary. */
  summary: string;
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
  /**
   * Today's review-request feedback outcome (PRD §6.11 step 5). Absent on
   * pre-E5 stored digests — renderers must treat absence as "no feedback".
   */
  feedback?: {
    responses: number;
    averageRating: number | null;
    lowRatingCount: number;
  };
  /** N-005 — quotes sent today. Absent on pre-N005 stored digests. */
  quotesSent?: DigestQuotesSent;
  /** N-005 "what I wasn't sure about today". OMITTED when zero (PRD line 733). */
  unsureAbout?: DigestUnsureItem[];
  /** N-005 "what I learned today". OMITTED when zero (graceful degradation). */
  learnedToday?: DigestLearnedItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Max pending approvals embedded in the digest payload (SMS shows ≤ this). */
export const DIGEST_TOP_APPROVALS = 3;
/** Cap on unbilled jobs listed in the payload — the web view shows the rest. */
export const DIGEST_MAX_UNBILLED_JOBS = 10;
/** N-005 — cap on "what I wasn't sure about" items embedded in the payload. */
export const DIGEST_MAX_UNSURE = 10;
/** N-005 — cap on "what I learned today" lessons embedded in the payload. */
export const DIGEST_MAX_LEARNED = 10;

/**
 * Map a proposal's status to the digest "unsureAbout" outcome. Derived from the
 * status AT GENERATION TIME (see DigestUnsureItem.outcome). Exhaustive switch so
 * a new ProposalStatus forces a decision here.
 */
export function proposalOutcome(status: ProposalStatus): DigestUnsureOutcome {
  switch (status) {
    case 'draft':
    case 'ready_for_review':
      return 'pending';
    case 'approved':
    case 'executing':
      return 'approved';
    case 'executed':
      return 'executed';
    case 'rejected':
      return 'rejected';
    case 'expired':
      return 'expired';
    case 'undone':
      return 'undone';
    case 'execution_failed':
      return 'failed';
  }
}

const AMOUNT_KEYS = ['amountCents', 'totalCents', 'priceCents'] as const;

/**
 * True when `level` is a blocking confidence level (low / very_low).
 * Single source of truth — used both here (summarizeProposalForDigest) and
 * by the worker (buildApprovalLinks). Exported so both sites share one
 * definition with no duplicate set construction.
 */
export function isBlockingConfidence(level: string | undefined): boolean {
  return level !== undefined && (AUTO_APPROVE_BLOCKING_CONFIDENCE_LEVELS as readonly string[]).includes(level);
}

function extractOverallConfidence(payload: Record<string, unknown>): string | undefined {
  const meta = payload._meta;
  if (meta === null || typeof meta !== 'object') return undefined;
  const overall = (meta as Record<string, unknown>).overallConfidence;
  return typeof overall === 'string' ? overall : undefined;
}

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
  const overallConfidence = extractOverallConfidence(proposal.payload ?? {});
  const hasMissingFields = missingFieldsFor(proposal).length > 0;
  return {
    proposalId: proposal.id,
    proposalType: proposal.proposalType,
    summary: proposal.summary,
    ...(customerName !== undefined ? { customerName } : {}),
    ...(amountCents !== undefined ? { amountCents } : {}),
    ...(overallConfidence !== undefined ? { overallConfidence } : {}),
    ...(isBlockingConfidence(overallConfidence) ? { reviewInApp: true as const } : {}),
    ...(hasMissingFields ? { hasMissingFields: true as const } : {}),
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
// SMS rendering — 320-char soft split into (k/n)-prefixed segments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-segment HARD ceiling: a single segment must never exceed one
 * concatenated-SMS unit. `DIGEST_SMS_SOFT_LIMIT` (320, PRD §12) is the soft
 * split threshold; a chunk that alone exceeds the soft limit (a long one-tap
 * URL) still gets its own segment, bounded by this hard cap.
 */
export const DIGEST_SMS_MAX_CHARS = 480;
/** N-005 / PRD §12 — soft split threshold; the digest splits past this. */
export const DIGEST_SMS_SOFT_LIMIT = 320;

export interface DigestSmsApprovalLink {
  approval: DigestPendingApproval;
  /** One-tap approve URL (signed token minted by the worker). */
  url: string;
}

/** RV-065 — "invoice it" one-tap link for a completed-unbilled job. */
export interface DigestSmsInvoiceLink {
  job: DigestUnbilledJob;
  /** One-tap mint-draft-invoice URL (signed token minted by the worker). */
  url: string;
}

export interface RenderDigestSmsInput {
  payload: DailyDigestPayload;
  /** Web deep link to the full digest (`<base>/digest/<date>`). */
  deepLinkUrl: string;
  /** One-tap links for the top approvals, in priority order. */
  approvalLinks: DigestSmsApprovalLink[];
  /** RV-065 — one-tap "invoice it" links for unbilled jobs. */
  invoiceLinks?: DigestSmsInvoiceLink[];
  /** Soft split threshold; defaults to DIGEST_SMS_SOFT_LIMIT (320). */
  softLimit?: number;
  /** Per-segment hard ceiling; defaults to DIGEST_SMS_MAX_CHARS (480). */
  maxChars?: number;
}

function approvalLabel(a: DigestPendingApproval): string {
  const bits: string[] = [a.proposalType.replace(/_/g, ' ')];
  if (a.amountCents !== undefined) bits.push(formatUsd(a.amountCents));
  if (a.customerName) bits.push(a.customerName);
  return bits.join(' ');
}

/**
 * Compact "what I wasn't sure about" SMS line. Full detail lives on the web
 * view; the SMS shows the count + an outcome breakdown, e.g.
 * "Unsure: 3 flagged (2 approved, 1 rejected)." Absent → empty string.
 */
function unsureSmsLine(items: DigestUnsureItem[] | undefined): string {
  if (!items || items.length === 0) return '';
  const counts = new Map<DigestUnsureOutcome, number>();
  for (const it of items) counts.set(it.outcome, (counts.get(it.outcome) ?? 0) + 1);
  // Stable outcome ordering so the line is deterministic.
  const ORDER: DigestUnsureOutcome[] = ['approved', 'executed', 'rejected', 'expired', 'undone', 'failed', 'pending'];
  const parts = ORDER.filter((o) => counts.has(o)).map((o) => `${counts.get(o)} ${o}`);
  const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return ` Unsure: ${items.length} flagged${breakdown}.`;
}

/**
 * Compact "what I learned today" SMS line, e.g. "Learned: labor rate now $145;
 * 2 more." Absent → empty string.
 */
function learnedSmsLine(items: DigestLearnedItem[] | undefined): string {
  if (!items || items.length === 0) return '';
  const more = items.length > 1 ? `; ${items.length - 1} more` : '';
  return ` Learned: ${items[0].summary}${more}.`;
}

/**
 * Build the ordered ATOMIC content chunks for the digest SMS. A chunk is never
 * split across segments; the packer places each chunk whole. The deep link
 * (tail) is the LAST chunk so it always lands in the final segment. No
 * punctuation ever directly follows a one-tap URL (a trailing '.' would be
 * swallowed into the link and corrupt the token).
 */
function buildDigestSmsChunks(input: RenderDigestSmsInput): string[] {
  const { payload, deepLinkUrl, approvalLinks } = input;

  const first = payload.tomorrow.firstStartIso
    ? `, first ${formatLocalTime(payload.tomorrow.firstStartIso, payload.timezone)}`
    : '';
  const head =
    `[Rivet] Day: ${formatUsd(payload.revenueCents)} in, ` +
    `${payload.jobsCompletedCount} jobs done. ` +
    `Tomorrow: ${payload.tomorrow.appointmentCount} visits${first}.`;

  const chunks: string[] = [head];

  // N-005 — quotes sent today (segment-1 counts line). Omitted when zero.
  if (payload.quotesSent && payload.quotesSent.count > 0) {
    chunks.push(
      ` Quotes: ${payload.quotesSent.count} sent, ${formatUsd(payload.quotesSent.pipelineValueCents)} pipeline.`,
    );
  }

  const total = payload.pendingApprovals.totalCount;
  const entries = approvalLinks.map((l, i) => ` [${i + 1}] ${approvalLabel(l.approval)} ${l.url}`);
  const invoiceEntries = (input.invoiceLinks ?? []).map(
    (l) => ` Bill${l.job.customerName ? ` ${l.job.customerName}` : ''} ${formatUsd(l.job.amountCents)} ${l.url}`,
  );
  const rendered = entries.length;
  if (total > 0) {
    // Header + each entry are separate chunks so a long URL entry can spill
    // into the next segment instead of being dropped.
    const moreMarker = total > rendered ? ` +${total - rendered} more` : '';
    chunks.push(` Approvals: ${total} waiting —${moreMarker}`);
    for (const e of entries) chunks.push(e);
  }
  for (const ie of invoiceEntries) chunks.push(ie);
  // Expiry note once, after the link blocks, when any one-tap link is present.
  if (entries.length > 0 || invoiceEntries.length > 0) chunks.push(' (links expire in 30 min)');

  const flagBits: string[] = [];
  if (payload.overdueInvoicesCount > 0) flagBits.push(`${payload.overdueInvoicesCount} overdue`);
  if (payload.unbilledJobs.length > 0) flagBits.push(`${payload.unbilledJobs.length} unbilled`);
  if (flagBits.length > 0) chunks.push(` Flags: ${flagBits.join(', ')}.`);

  // Review-request outcome (PRD §6.11 step 5). GSM-safe (no ★). Omitted on
  // quiet days / pre-E5 payloads.
  const fb = payload.feedback;
  if (fb && fb.responses > 0) {
    chunks.push(
      ` Feedback: ${fb.responses} today` +
        (fb.averageRating !== null ? `, avg ${fb.averageRating}/5` : '') +
        (fb.lowRatingCount > 0 ? `, ${fb.lowRatingCount} low (<=3)` : '') +
        '.',
    );
  }

  const unsure = unsureSmsLine(payload.unsureAbout);
  if (unsure) chunks.push(unsure);
  const learned = learnedSmsLine(payload.learnedToday);
  if (learned) chunks.push(learned);

  chunks.push(` Full day: ${deepLinkUrl}`);
  return chunks;
}

/**
 * Deterministic multi-segment SMS render (PRD §12). Content is assembled into
 * atomic chunks, then greedily packed into segments each ≤ the soft limit
 * (320); a chunk that alone exceeds the soft limit still gets its own segment,
 * bounded by the hard ceiling (480). Every segment is prefixed with `(k/n)`
 * when there is more than one. The deep link is the final chunk, so it only
 * appears in the last segment. One-tap links are never collapsed — they spill
 * into the next segment. Pure + regenerable given identical inputs.
 */
export function renderDigestSmsSegments(input: RenderDigestSmsInput): string[] {
  const softLimit = input.softLimit ?? DIGEST_SMS_SOFT_LIMIT;
  const hardMax = input.maxChars ?? DIGEST_SMS_MAX_CHARS;
  const chunks = buildDigestSmsChunks(input);

  // Reserve room for the "(k/n) " prefix (supports n up to 999).
  const PREFIX_RESERVE = 10;
  const budget = Math.max(1, softLimit - PREFIX_RESERVE);

  const bodies: string[] = [];
  let current = '';
  for (const chunk of chunks) {
    if (current === '') {
      current = chunk;
    } else if ((current + chunk).length <= budget) {
      current += chunk;
    } else {
      bodies.push(current);
      current = chunk;
    }
  }
  if (current !== '') bodies.push(current);

  const n = bodies.length;
  const segments: string[] = [];
  for (let i = 0; i < n; i++) {
    const prefix = n > 1 ? `(${i + 1}/${n}) ` : '';
    const bodyText = n > 1 ? bodies[i].trimStart() : bodies[i];
    // Cap the BODY (URL-aware), then re-attach the prefix, so the `(k/n)`
    // marker is never eaten by truncation and the hard ceiling still holds.
    const capped = capSegmentPreservingUrl(bodyText, hardMax - prefix.length);
    // A null cap means even the bare one-tap URL can't fit under the ceiling —
    // omit the entry rather than emit a chunk with a truncated signed token.
    if (capped === null) continue;
    segments.push(prefix + capped);
  }
  return segments;
}

/**
 * Truncate an over-long SMS segment body WITHOUT slicing through a trailing
 * one-tap URL. Approval/invoice chunks place the signed one-tap URL last, so a
 * blind tail slice would corrupt the token and produce an unusable
 * approval/invoice link. When the body exceeds `max` we instead shorten the
 * leading (non-URL) label and keep the full URL intact. If even the URL alone
 * cannot fit under `max`, return `null` so the caller drops the entry rather
 * than sending a truncated token. Bodies with no URL fall back to a plain tail
 * slice (safe — no token to corrupt).
 */
function capSegmentPreservingUrl(text: string, max: number): string | null {
  if (text.length <= max) return text;
  const matches = [...text.matchAll(/https?:\/\/\S+/g)];
  if (matches.length === 0) {
    // No URL to protect — a plain-text tail slice can't corrupt a token.
    return text.slice(0, max);
  }
  const last = matches[matches.length - 1];
  const urlStart = last.index ?? text.indexOf(last[0]);
  const urlTail = text.slice(urlStart); // full URL + any trailing chars
  // Reserve one char for the space separating the (shortened) label from the
  // URL. If the URL itself can't fit, never truncate it — signal a drop.
  if (urlTail.length + 1 > max) return null;
  const label = text.slice(0, urlStart).trimEnd();
  const room = max - urlTail.length - 1; // chars left for the label
  const shortLabel = room > 0 ? label.slice(0, room).trimEnd() : '';
  return shortLabel.length > 0 ? `${shortLabel} ${urlTail}` : urlTail;
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
  feedbackResponseRepo: FeedbackResponseRepository;
  /**
   * N-005 — correction-loop lessons applied today ("what I learned today").
   * Already constructed in app.ts; the in-memory stub simply yields no data
   * (section self-omits).
   */
  correctionLessonRepo: CorrectionLessonRepository;
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

  const [payments, completedJobs, tomorrowAppointments, openInvoices, partiallyPaidInvoices, readyProposals, draftProposals, unbilledCandidates, ratingCounts, sentEstimates, confidenceMarked, appliedLessons] =
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
      deps.proposalRepo.findByStatus(tenantId, 'draft'),
      findJobsRequiringInvoicing(tenantId, deps),
      deps.feedbackResponseRepo.countByRatingInRange(tenantId, today.start, today.end),
      // N-005 — estimates sent inside today's tenant-tz window (quotes sent).
      deps.estimateRepo.findByTenant(tenantId, { sentFrom: today.start, sentTo: today.end }),
      // N-005 — proposals created today whose confidence marker fired
      // (low/very_low). Optional repo method — absent on partial doubles.
      deps.proposalRepo.findConfidenceMarkedForDay
        ? deps.proposalRepo.findConfidenceMarkedForDay(tenantId, today.start, today.end, DIGEST_MAX_UNSURE)
        : Promise.resolve([] as Proposal[]),
      // N-005 — correction-loop lessons applied today ("what I learned today").
      deps.correctionLessonRepo.findAppliedForDay(tenantId, date),
    ]);

  // Combine both actionable statuses — mirrors the inbox's dual-fetch so the
  // digest and the inbox always agree on what needs attention.
  const pendingProposals = [...readyProposals, ...draftProposals];

  // Money in today — the dashboard's own window-revenue function over the
  // dashboard's own tenant-tz day boundaries.
  const revenue = computeWindowRevenue(payments, today.start, today.end);
  const paymentsCount = payments.filter(
    (p) => p.status === 'completed' && inWindow(p.receivedAt, today.start, today.end),
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

  // Today's review-request feedback outcome (PRD §6.11 step 5: digest line).
  const feedback = {
    responses: totalResponses(ratingCounts),
    averageRating: averageRating(ratingCounts),
    lowRatingCount: lowRatingCount(ratingCounts),
  };

  // N-005 — quotes sent today. Integer cents throughout (totalCents), no float.
  // Not filtered by status: an estimate sent today then accepted/rejected the
  // same day still counts as a quote sent (its sentAt persists).
  const quotesSent: DigestQuotesSent | undefined =
    sentEstimates.length > 0
      ? {
          count: sentEstimates.length,
          pipelineValueCents: sentEstimates.reduce((s, e) => s + e.totals.totalCents, 0),
        }
      : undefined;

  // N-005 — "what I wasn't sure about today": today's confidence-marked
  // proposals + the owner outcome (from status at generation time). Omitted
  // (undefined) when empty per the "omit if zero" criterion.
  const unsureAbout: DigestUnsureItem[] | undefined =
    confidenceMarked.length > 0
      ? confidenceMarked.slice(0, DIGEST_MAX_UNSURE).map((p) => {
          const confidence = extractOverallConfidence(p.payload ?? {}) ?? 'low';
          const factors =
            p.confidenceFactors && p.confidenceFactors.length > 0 ? p.confidenceFactors : undefined;
          return {
            proposalId: p.id,
            proposalType: p.proposalType,
            summary: p.summary,
            confidence,
            ...(factors !== undefined ? { factors } : {}),
            outcome: proposalOutcome(p.status),
          };
        })
      : undefined;

  // N-005 — "what I learned today": correction-loop lessons applied today.
  // findAppliedForDay already excludes reverted lessons; omitted when empty.
  const learnedToday: DigestLearnedItem[] | undefined =
    appliedLessons.length > 0
      ? appliedLessons.slice(0, DIGEST_MAX_LEARNED).map((l) => ({
          lessonId: l.id,
          lessonType: l.lessonType,
          summary: l.summary,
        }))
      : undefined;

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
    feedback,
    ...(quotesSent !== undefined ? { quotesSent } : {}),
    ...(unsureAbout !== undefined ? { unsureAbout } : {}),
    ...(learnedToday !== undefined ? { learnedToday } : {}),
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
  /** N-005 — count of SMS send passes attempted (retry cap = 3, migration 239). */
  sendAttempts: number;
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
   * Most recent digest for the tenant by digest_date (RV-062 web view's
   * `latest` deep link). Returns null when the tenant has no digest yet.
   */
  findLatest(tenantId: string): Promise<DailyDigestRecord | null>;
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
  /**
   * N-005 — atomically bump `send_attempts` and return the NEW count. The
   * worker calls this once per real send pass and dead-letters (stops
   * retrying) once the returned count exceeds the 3-attempt cap. Returns null
   * when no row exists for (tenant, date).
   */
  incrementSendAttempts(tenantId: string, digestDate: string): Promise<number | null>;
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
      sendAttempts: existing?.sendAttempts ?? 0,
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

  async findLatest(tenantId: string): Promise<DailyDigestRecord | null> {
    let latest: DailyDigestRecord | null = null;
    for (const row of this.rows.values()) {
      if (row.tenantId !== tenantId) continue;
      if (latest === null || row.digestDate > latest.digestDate) latest = row;
    }
    return latest ? { ...latest } : null;
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

  async incrementSendAttempts(tenantId: string, digestDate: string): Promise<number | null> {
    const key = this.key(tenantId, digestDate);
    const row = this.rows.get(key);
    if (!row) return null;
    const updated = { ...row, sendAttempts: row.sendAttempts + 1 };
    this.rows.set(key, updated);
    return updated.sendAttempts;
  }
}
