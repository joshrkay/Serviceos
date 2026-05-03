/**
 * P11-001 — `lookup_jobs` voice skill.
 *
 * Read-only, bypasses the proposals pipeline. Returns the customer's
 * most-recent jobs with status + a one-line summary the FSM can read
 * back to the caller.
 */
import type { Job, JobRepository } from '../../jobs/job';
import type {
  LookupEventService,
  RecordLookupEventInput,
} from '../../lookup-events/lookup-event-service';

export interface LookupJobsInput {
  tenantId: string;
  customerId: string;
  /** Max jobs returned. Default 3. */
  recentLimit?: number;
  timezone?: string;
  sessionId?: string;
}

export interface LookupJobsItem {
  jobId: string;
  jobNumber: string;
  status: Job['status'];
  summary: string;
  createdAt: Date;
}

export type LookupJobsResult =
  | {
      status: 'found';
      summary: string;
      data: { jobs: LookupJobsItem[] };
    }
  | { status: 'none'; summary: string; data: { jobs: [] } }
  | { status: 'error'; summary: string; data: { error: string } };

export interface LookupJobsDeps {
  jobRepo: JobRepository;
  lookupEvents?: LookupEventService;
}

function humanizeStatus(s: Job['status']): string {
  switch (s) {
    case 'new':         return 'just opened';
    case 'scheduled':   return 'scheduled';
    case 'in_progress': return 'in progress';
    case 'completed':   return 'completed';
    case 'canceled':    return 'canceled';
    default:            return s;
  }
}

export async function lookupJobs(
  input: LookupJobsInput,
  deps: LookupJobsDeps,
): Promise<LookupJobsResult> {
  const start = Date.now();
  const recentLimit = input.recentLimit ?? 3;

  const recordEvent = async (
    payload: Omit<RecordLookupEventInput, 'tenantId' | 'sessionId' | 'customerId' | 'intent' | 'latencyMs'>,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        customerId: input.customerId,
        intent: 'lookup_jobs',
        sessionId: input.sessionId,
        latencyMs: Date.now() - start,
        ...payload,
      });
    } catch {
      /* swallow */
    }
  };

  if (!deps.jobRepo.findByCustomer) {
    const message = "I'm having trouble pulling up your jobs right now.";
    await recordEvent({ resultStatus: 'error', resultCount: 0, summary: message });
    return {
      status: 'error',
      summary: message,
      data: { error: 'JobRepository.findByCustomer is required' },
    };
  }

  let jobs: Job[];
  try {
    jobs = await deps.jobRepo.findByCustomer(input.tenantId, input.customerId, {
      includeArchived: true,
      limit: recentLimit,
    });
  } catch (err) {
    const message = "I'm having trouble pulling up your jobs right now.";
    await recordEvent({ resultStatus: 'error', resultCount: 0, summary: message });
    return {
      status: 'error',
      summary: message,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  if (jobs.length === 0) {
    const message = "I'm not seeing any jobs on your account.";
    await recordEvent({ resultStatus: 'none', resultCount: 0, summary: message });
    return { status: 'none', summary: message, data: { jobs: [] } };
  }

  const items: LookupJobsItem[] = jobs.map((j) => ({
    jobId: j.id,
    jobNumber: j.jobNumber,
    status: j.status,
    summary: j.summary,
    createdAt: j.createdAt,
  }));

  const head = items[0];
  const summary =
    items.length === 1
      ? `Your most recent job is ${head.jobNumber} — ${head.summary}, currently ${humanizeStatus(head.status)}.`
      : `You have ${items.length} recent jobs. The latest is ${head.jobNumber} — ${head.summary}, ${humanizeStatus(head.status)}.`;

  await recordEvent({
    resultStatus: 'found',
    resultCount: items.length,
    summary,
  });

  return { status: 'found', summary, data: { jobs: items } };
}
