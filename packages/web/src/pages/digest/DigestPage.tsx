/**
 * RV-062 (F-9) — End-of-Day Digest web view.
 *
 * The SMS deep link (`/digest/<date>`) lands here. This page is opened
 * from a phone, so it's mobile-first: single-column section cards, ≥44px
 * (min-h-11) tap targets, no horizontal overflow at 320px.
 *
 * It renders the stored digest snapshot only — it never recomputes. The
 * shape mirrors the API's `DailyDigestPayload` (packages/api digest-service);
 * we render strictly from the fields the worker stored.
 *
 * F-4 safety rule: low-confidence pending approvals (`reviewInApp: true`)
 * get a "Review in app" link to the proposal inbox — never a one-tap-style
 * approve affordance on this surface.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiClient } from '../../lib/apiClient';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatCurrency } from '../../utils/currency';
import { formatTimeInTenantTz, formatDateTimeInTenantTz, todayInTz } from '../../utils/formatInTenantTz';
import { Spinner } from '../../components/ui';
import { ErrorState } from '../../components/ErrorState';

// ─── Payload shape (mirrors packages/api DailyDigestPayload) ───────────────

interface DigestPendingApproval {
  proposalId: string;
  proposalType: string;
  summary: string;
  customerName?: string;
  amountCents?: number;
  overallConfidence?: string;
  reviewInApp?: true;
}

interface DigestUnbilledJob {
  jobId: string;
  customerId: string;
  customerName?: string;
  amountCents: number;
}

interface DigestQuotesSent {
  count: number;
  pipelineValueCents: number;
}

type DigestUnsureOutcome =
  | 'pending'
  | 'approved'
  | 'executed'
  | 'rejected'
  | 'expired'
  | 'undone'
  | 'failed';

interface DigestUnsureItem {
  proposalId: string;
  proposalType: string;
  summary: string;
  confidence: string;
  factors?: string[];
  outcome: DigestUnsureOutcome;
}

interface DigestLearnedItem {
  lessonId: string;
  lessonType: string;
  summary: string;
}

// WS6 — supervisor-review reflection. Counts only (no "fixed" nuance — see
// packages/api digest-service.ts DigestSupervisorChecks doc comment).
interface DigestSupervisorChecks {
  checked: number;
  flagged: number;
}

interface DigestPayload {
  date: string;
  timezone: string;
  revenueCents: number;
  grossRevenueCents: number;
  refundsCents: number;
  paymentsCount: number;
  jobsCompletedCount: number;
  tomorrow: { appointmentCount: number; firstStartIso: string | null };
  pendingApprovals: { totalCount: number; top: DigestPendingApproval[] };
  overdueInvoicesCount: number;
  unbilledJobs: DigestUnbilledJob[];
  // N-005 — optional reflection sections (absent on pre-N005 stored digests).
  quotesSent?: DigestQuotesSent;
  unsureAbout?: DigestUnsureItem[];
  learnedToday?: DigestLearnedItem[];
  // WS6 — "Checked: N proposals, M flagged" (absent when nothing ran today).
  supervisorChecks?: DigestSupervisorChecks;
}

interface DigestResponse {
  date: string;
  payload: DigestPayload;
  narrative: string | null;
  generatedAt: string;
}

// ─── Date helpers (UTC arithmetic — DST-safe, no float drift) ──────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar day before/after `date` (YYYY-MM-DD), via UTC arithmetic. */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "Wednesday, June 10" for the section header. */
function formatHeaderDate(date: string, timezone: string): string {
  // Anchor at local noon UTC so the calendar day can't slip across the
  // date line when formatted back in the tenant tz.
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(at);
}

function approvalLabel(type: string): string {
  return type.replace(/_/g, ' ');
}

/** Tailwind classes for the "what I wasn't sure about" outcome pill. */
function outcomePillClass(outcome: DigestUnsureOutcome): string {
  switch (outcome) {
    case 'approved':
    case 'executed':
      return 'border-green-200 bg-green-50 text-green-700';
    case 'rejected':
    case 'failed':
      return 'border-red-200 bg-red-50 text-red-700';
    case 'expired':
    case 'undone':
      return 'border-slate-200 bg-slate-100 text-slate-600';
    case 'pending':
    default:
      return 'border-amber-200 bg-amber-50 text-amber-700';
  }
}

// ─── Section card ──────────────────────────────────────────────────────────

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function DigestPage() {
  const apiFetch = useApiClient();
  const timezone = useTenantTimezone();
  const params = useParams<{ date?: string }>();
  // `/digest` (no param) and `/digest/latest` both resolve to the most
  // recent digest; the SMS link uses an explicit date.
  const routeDate = params.date ?? 'latest';

  const [digest, setDigest] = useState<DigestResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setNotFound(false);
    setError(null);
    apiFetch(`/api/digests/${encodeURIComponent(routeDate)}`)
      .then(async (res) => {
        if (res.status === 404) {
          if (!cancelled) {
            setDigest(null);
            setNotFound(true);
          }
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!cancelled) setDigest(body.data as DigestResponse);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [routeDate, apiFetch, reloadKey]);

  // Date for the nav arrows: the resolved digest's own date (so `latest`
  // navigates relative to whatever day it landed on), falling back to the
  // route param when it's an explicit date.
  const resolvedDate = digest?.date ?? (DATE_RE.test(routeDate) ? routeDate : null);
  const today = todayInTz(timezone);
  const canGoNext = resolvedDate !== null && resolvedDate < today;
  const prevDate = resolvedDate ? shiftDate(resolvedDate, -1) : null;
  const nextDate = resolvedDate ? shiftDate(resolvedDate, 1) : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-4 py-6">
        {/* Header + date nav */}
        <div className="flex items-center justify-between gap-2">
          <h1 className="min-w-0 break-words text-xl font-semibold text-slate-900">
            {resolvedDate ? formatHeaderDate(resolvedDate, timezone) : 'Daily digest'}
          </h1>
        </div>

        {resolvedDate && (
          <nav className="mt-3 flex items-center justify-between gap-2" aria-label="Digest date navigation">
            <Link
              to={`/digest/${prevDate}`}
              className="inline-flex min-h-11 items-center rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50"
            >
              ← Previous day
            </Link>
            {canGoNext ? (
              <Link
                to={`/digest/${nextDate}`}
                className="inline-flex min-h-11 items-center rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50"
              >
                Next day →
              </Link>
            ) : (
              <span
                aria-disabled="true"
                className="inline-flex min-h-11 cursor-not-allowed items-center rounded-lg border border-slate-100 bg-slate-50 px-3 text-sm text-slate-300"
              >
                Next day →
              </span>
            )}
          </nav>
        )}

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Spinner size="md" className="text-slate-900" label="Loading digest" />
          </div>
        )}

        {!isLoading && error && (
          <ErrorState
            message="Couldn't load this digest."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        )}

        {!isLoading && !error && notFound && (
          <div className="py-16 text-center">
            <p className="text-base font-medium text-slate-900">No digest for this day</p>
            <p className="mt-1 text-sm text-slate-500">
              Nothing was recorded for {resolvedDate ?? 'this date'}.
            </p>
          </div>
        )}

        {!isLoading && !error && digest && (
          <DigestBody digest={digest} timezone={timezone} />
        )}
      </div>
    </div>
  );
}

function DigestBody({
  digest,
  timezone,
}: {
  digest: DigestResponse;
  timezone: string;
}) {
  const p = digest.payload;

  return (
    <div className="mt-5 space-y-4">
      {/* Narrative */}
      {digest.narrative && (
        <p className="text-base leading-relaxed text-slate-700">{digest.narrative}</p>
      )}

      {/* Headline money row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
          <p className="text-xs uppercase tracking-wide text-slate-500">Revenue today</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">
            {formatCurrency(p.revenueCents)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
          <p className="text-xs uppercase tracking-wide text-slate-500">Payments received</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">
            {p.paymentsCount}
          </p>
        </div>
      </div>

      {/* Quotes sent today (N-005). Omitted when absent/zero. */}
      {p.quotesSent && p.quotesSent.count > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
            <p className="text-xs uppercase tracking-wide text-slate-500">Quotes sent</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">
              {p.quotesSent.count}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
            <p className="text-xs uppercase tracking-wide text-slate-500">Pipeline value</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">
              {formatCurrency(p.quotesSent.pipelineValueCents)}
            </p>
          </div>
        </div>
      )}

      {/* Jobs completed + tomorrow */}
      <div className="grid grid-cols-2 gap-3">
        <SectionCard title="Jobs completed">
          <p className="text-lg font-semibold tabular-nums text-slate-900">{p.jobsCompletedCount}</p>
        </SectionCard>
        <SectionCard title="Tomorrow">
          <p className="text-lg font-semibold tabular-nums text-slate-900">
            {p.tomorrow.appointmentCount}{' '}
            <span className="text-sm font-normal text-slate-500">
              {p.tomorrow.appointmentCount === 1 ? 'visit' : 'visits'}
            </span>
          </p>
          {p.tomorrow.firstStartIso && (
            <p className="mt-0.5 text-sm text-slate-500">
              First at {formatTimeInTenantTz(p.tomorrow.firstStartIso, timezone)}
            </p>
          )}
        </SectionCard>
      </div>

      {/* Pending approvals */}
      <SectionCard title={`Pending approvals (${p.pendingApprovals.totalCount})`}>
        {p.pendingApprovals.top.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing waiting on you.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {p.pendingApprovals.top.map((a) => (
              <li
                key={a.proposalId}
                className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2"
              >
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium capitalize text-slate-800">
                    {approvalLabel(a.proposalType)}
                    {a.customerName ? (
                      <span className="font-normal text-slate-500"> · {a.customerName}</span>
                    ) : null}
                  </p>
                  {a.amountCents !== undefined && (
                    <p className="text-sm tabular-nums text-slate-500">
                      {formatCurrency(a.amountCents)}
                    </p>
                  )}
                </div>
                {/* F-4: low-confidence proposals route to in-app review —
                    never a one-tap-style approve affordance here. */}
                {a.reviewInApp && (
                  <Link
                    to="/inbox"
                    className="inline-flex min-h-11 items-center rounded-lg border border-blue-200 bg-blue-50 px-3 text-sm font-medium text-blue-700 hover:bg-blue-100"
                  >
                    Review in app
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
        {p.pendingApprovals.totalCount > p.pendingApprovals.top.length && (
          <Link
            to="/inbox"
            className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-blue-700 hover:text-blue-800"
          >
            View all {p.pendingApprovals.totalCount} in the inbox →
          </Link>
        )}
      </SectionCard>

      {/* What I wasn't sure about today (N-005). Only when non-empty. */}
      {p.unsureAbout && p.unsureAbout.length > 0 && (
        <SectionCard title="What I wasn't sure about today">
          <ul className="divide-y divide-slate-100">
            {p.unsureAbout.map((u) => (
              <li key={u.proposalId} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium capitalize text-slate-800">
                    {approvalLabel(u.proposalType)}
                  </p>
                  <p className="break-words text-sm text-slate-500">{u.summary}</p>
                  {u.factors && u.factors.length > 0 && (
                    <p className="mt-0.5 break-words text-xs text-slate-400">{u.factors.join(' · ')}</p>
                  )}
                </div>
                <span
                  className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${outcomePillClass(u.outcome)}`}
                >
                  {u.outcome}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* What I learned today (N-005). Only when non-empty. */}
      {p.learnedToday && p.learnedToday.length > 0 && (
        <SectionCard title="What I learned today">
          <ul className="divide-y divide-slate-100">
            {p.learnedToday.map((l) => (
              <li key={l.lessonId} className="flex min-h-11 flex-col justify-center gap-1 py-2">
                <span className="inline-flex w-fit items-center rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium capitalize text-blue-700">
                  {approvalLabel(l.lessonType)}
                </span>
                <p className="break-words text-sm text-slate-700">{l.summary}</p>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* WS6 — supervisor-review reflection. Only when reviews ran today. */}
      {p.supervisorChecks && p.supervisorChecks.checked > 0 && (
        <SectionCard title="Supervisor checks">
          <p className="text-lg font-semibold tabular-nums text-slate-900">
            {p.supervisorChecks.checked}{' '}
            <span className="text-sm font-normal text-slate-500">
              {p.supervisorChecks.checked === 1 ? 'proposal checked' : 'proposals checked'}
            </span>
          </p>
          <p className="mt-0.5 text-sm text-slate-500">
            {p.supervisorChecks.flagged > 0
              ? `${p.supervisorChecks.flagged} flagged`
              : 'None flagged'}
          </p>
        </SectionCard>
      )}

      {/* Overdue invoices */}
      <SectionCard title="Overdue invoices">
        <p className="text-lg font-semibold tabular-nums text-slate-900">
          {p.overdueInvoicesCount}
        </p>
      </SectionCard>

      {/* Completed, not yet invoiced */}
      <SectionCard title={`Completed, not yet invoiced (${p.unbilledJobs.length})`}>
        {p.unbilledJobs.length === 0 ? (
          <p className="text-sm text-slate-500">Everything completed has been billed.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {p.unbilledJobs.map((j) => (
              <li
                key={j.jobId}
                className="flex min-h-11 items-center justify-between gap-2 py-2"
              >
                <span className="min-w-0 break-words text-sm text-slate-700">
                  {j.customerName ?? 'Customer'}
                </span>
                <span className="shrink-0 text-sm font-medium tabular-nums text-slate-900">
                  {formatCurrency(j.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <p className="pt-2 text-xs text-slate-400">
        Generated {formatDateTimeInTenantTz(digest.generatedAt, timezone)}
      </p>
    </div>
  );
}
