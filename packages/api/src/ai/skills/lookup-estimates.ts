/**
 * VQ-006 — `lookup_estimates` voice skill.
 *
 * Read-only — bypasses the proposals pipeline. Mirrors lookup-invoices:
 * we fan out from `jobRepo.findByCustomer` to `estimateRepo.findByJob`
 * because estimates are linked to jobs, not directly to customers, in
 * this codebase. Returns count, total dollar amount, and a per-estimate
 * list (id, status, total, sentAt/createdAt) for TTS readback.
 */
import type { JobRepository } from '../../jobs/job';
import type {
  Estimate,
  EstimateRepository,
  EstimateStatus,
} from '../../estimates/estimate';
import type {
  LookupEventService,
  RecordLookupEventInput,
} from '../../lookup-events/lookup-event-service';

export interface LookupEstimatesInput {
  tenantId: string;
  customerId: string;
  /** Max estimates returned (most recent first). Default 5. */
  limit?: number;
  timezone?: string;
  sessionId?: string;
}

export interface LookupEstimatesItem {
  estimateId: string;
  estimateNumber: string;
  status: EstimateStatus;
  totalCents: number;
  /** Most recent send timestamp; missing for estimates that have never been sent. */
  sentAt?: Date;
  createdAt: Date;
}

export type LookupEstimatesResult =
  | {
      status: 'found';
      summary: string;
      data: {
        count: number;
        totalCents: number;
        estimates: LookupEstimatesItem[];
      };
    }
  | {
      status: 'none';
      summary: string;
      data: { count: 0; totalCents: 0; estimates: [] };
    }
  | { status: 'error'; summary: string; data: { error: string } };

export interface LookupEstimatesDeps {
  jobRepo: JobRepository;
  estimateRepo: EstimateRepository;
  lookupEvents?: LookupEventService;
}

function formatCents(cents: number): string {
  const dollars = (cents / 100).toFixed(2);
  return `$${dollars}`;
}

function humanizeStatus(s: EstimateStatus): string {
  switch (s) {
    case 'draft':            return 'in draft';
    case 'ready_for_review': return 'in review';
    case 'sent':             return 'sent';
    case 'accepted':         return 'accepted';
    case 'rejected':         return 'declined';
    case 'expired':          return 'expired';
    default:                 return s;
  }
}

function toItem(e: Estimate): LookupEstimatesItem {
  const item: LookupEstimatesItem = {
    estimateId: e.id,
    estimateNumber: e.estimateNumber,
    status: e.status,
    totalCents: e.totals.totalCents,
    createdAt: e.createdAt,
  };
  if (e.sentAt) item.sentAt = e.sentAt;
  return item;
}

export async function lookupEstimates(
  input: LookupEstimatesInput,
  deps: LookupEstimatesDeps,
): Promise<LookupEstimatesResult> {
  const start = Date.now();
  const limit = input.limit ?? 5;

  const recordEvent = async (
    payload: Omit<
      RecordLookupEventInput,
      'tenantId' | 'sessionId' | 'customerId' | 'intent' | 'latencyMs'
    >,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        customerId: input.customerId,
        intent: 'lookup_estimates',
        sessionId: input.sessionId,
        latencyMs: Date.now() - start,
        ...payload,
      });
    } catch {
      /* swallow — audit-write failures must never crash the call */
    }
  };

  if (!deps.jobRepo.findByCustomer) {
    const message = "I'm having trouble pulling up your estimates right now.";
    await recordEvent({ resultStatus: 'error', resultCount: 0, summary: message });
    return {
      status: 'error',
      summary: message,
      data: { error: 'JobRepository.findByCustomer is required' },
    };
  }

  let jobs;
  try {
    jobs = await deps.jobRepo.findByCustomer(input.tenantId, input.customerId, {
      includeArchived: true,
    });
  } catch (err) {
    const message = "I'm having trouble pulling up your estimates right now.";
    await recordEvent({ resultStatus: 'error', resultCount: 0, summary: message });
    return {
      status: 'error',
      summary: message,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  // Use Promise.allSettled so a single repo failure doesn't drop every
  // sibling estimate (the doc flagged the Promise.all pattern in
  // lookup-account-summary as a known issue; we adopt allSettled here
  // for any internal parallelism in this new skill).
  const settled = await Promise.allSettled(
    jobs.map((j) => deps.estimateRepo.findByJob(input.tenantId, j.id)),
  );
  const estimates: Estimate[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') estimates.push(...r.value);
  }

  estimates.sort((a, b) => {
    const aT = (a.sentAt ?? a.createdAt).getTime();
    const bT = (b.sentAt ?? b.createdAt).getTime();
    return bT - aT;
  });
  const sliced = estimates.slice(0, limit);
  const items = sliced.map(toItem);

  if (items.length === 0) {
    const message =
      "I'm not seeing any estimates on your account. Would you like one prepared?";
    await recordEvent({ resultStatus: 'none', resultCount: 0, summary: message });
    return {
      status: 'none',
      summary: message,
      data: { count: 0, totalCents: 0, estimates: [] },
    };
  }

  const totalCents = items.reduce((sum, i) => sum + i.totalCents, 0);
  const head = items[0];
  let summary: string;
  if (items.length === 1) {
    summary =
      `You have one estimate — ${head.estimateNumber} for ${formatCents(head.totalCents)}, ${humanizeStatus(head.status)}.`;
  } else {
    summary =
      `You have ${items.length} estimates totaling ${formatCents(totalCents)}. ` +
      `The most recent is ${head.estimateNumber} for ${formatCents(head.totalCents)}, ${humanizeStatus(head.status)}.`;
  }

  await recordEvent({
    resultStatus: 'found',
    resultCount: items.length,
    summary,
  });

  return {
    status: 'found',
    summary,
    data: { count: items.length, totalCents, estimates: items },
  };
}
