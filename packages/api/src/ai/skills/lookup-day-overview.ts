/**
 * RV-010 — `lookup_day_overview` voice skill ("what's my day look like?").
 *
 * Owner/operator-scoped, read-only — bypasses the proposals pipeline like
 * every other `lookup_*` skill (the adapter speaks the returned `summary`
 * and the FSM stays in intent_capture). Composes, in spoken order:
 *
 *   1. urgent / high-priority open jobs FIRST (the "heads up" line),
 *   2. the day's schedule,
 *   3. pending-approvals count (draft + ready_for_review, counted
 *      through the same `buildInboxPayload` the operator inbox uses so
 *      the spoken number always matches the screen),
 *   4. overnight events via `listSince` (RV-011) since yesterday 6pm
 *      tenant-local.
 *
 * Day boundaries reuse the digest's tz machinery (`resolveDayWindow` /
 * `localDateString` — reports/money-dashboard + digest-service), so
 * "today" here is exactly the digest's tenant-local calendar day.
 *
 * #1498 — the schedule sentence (2) is NOT computed here. It is
 * `ai/skills/lookup-my-day.ts#lookupMyDay` for the whole tenant — the ONE
 * schedule lookup — so "what does my day look like?" and "what's on my
 * schedule today?" can never report two different days again (the QA sweep
 * heard "7 appointments today" and "nothing left today" side by side). That
 * module defines which visits count and which are "left". Asked about
 * another day ("…tomorrow?"), the overview is just that day's schedule:
 * urgent jobs, approvals and overnight activity are about NOW, not Friday.
 */
import type { AppointmentRepository } from '../../appointments/appointment';
import type { Job, JobRepository } from '../../jobs/job';
import type { UserRepository } from '../../users/user';
import type { ProposalRepository } from '../../proposals/proposal';
import { buildInboxPayload, listSince } from '../../proposals/inbox';
import { resolveDayWindow } from '../../reports/money-dashboard';
import { localDateString } from '../../digest/digest-service';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';
import { plural } from './spoken-format';
import { lookupMyDay, type MyDayAppointment } from './lookup-my-day';

export interface LookupDayOverviewInput {
  tenantId: string;
  /** IANA timezone for "today" + spoken times. Defaults to America/New_York
   *  (the same default `resolveDayWindow` and the digest use). */
  timezone?: string;
  /** Injectable clock — pinned by tests. Defaults to now. */
  now?: Date;
  /** Voice session this lookup runs inside. Used for the audit row. */
  sessionId?: string;
  /** #1498 — tenant-local `YYYY-MM-DD` asked about; absent → today. */
  day?: string;
}

export interface LookupDayOverviewDeps {
  appointmentRepo: AppointmentRepository;
  jobRepo: JobRepository;
  proposalRepo: ProposalRepository;
  /** Optional — technician names on the spoken schedule. Decorative. */
  userRepo?: UserRepository;
  /** Optional — when wired the skill writes a `lookup_events` audit row. */
  lookupEvents?: LookupEventService;
}

export type DayOverviewAppointment = MyDayAppointment;

export interface DayOverviewUrgentJob {
  jobId: string;
  jobNumber: string;
  summary: string;
  priority: Job['priority'];
}

export type LookupDayOverviewResult =
  | {
      status: 'found' | 'none';
      summary: string;
      data: {
        appointments: DayOverviewAppointment[];
        urgentJobs: DayOverviewUrgentJob[];
        pendingApprovalsCount: number;
        overnight: { createdCount: number; executedCount: number; failedCount: number };
      };
    }
  | { status: 'error'; summary: string; data: { error: string } };

/** Tenant-local default mirrors resolveDayWindow's. */
const DEFAULT_TIMEZONE = 'America/New_York';
/** Spoken caps — a 40-appointment day must not become a 3-minute monologue. */
const MAX_SPOKEN_URGENT_JOBS = 3;
/** Inbox cap — only the summary counts are used here. */
const INBOX_COUNT_CAP = 100;
/** Overnight window starts at 6pm tenant-local the previous evening. */
const OVERNIGHT_LOOKBACK_FROM_MIDNIGHT_MS = 6 * 60 * 60 * 1000;

export async function lookupDayOverview(
  input: LookupDayOverviewInput,
  deps: LookupDayOverviewDeps,
): Promise<LookupDayOverviewResult> {
  const start = Date.now();
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const now = input.now ?? new Date();

  const recordEvent = async (
    resultStatus: 'found' | 'none' | 'error',
    resultCount: number,
    summary: string,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        intent: 'lookup_day_overview',
        sessionId: input.sessionId,
        latencyMs: Date.now() - start,
        resultStatus,
        resultCount,
        summary,
      });
    } catch {
      // best-effort: skill must never fail on audit write
    }
  };

  const failed = async (error: string): Promise<LookupDayOverviewResult> => {
    const message = "I'm having trouble pulling up your day right now.";
    await recordEvent('error', 0, message);
    return { status: 'error', summary: message, data: { error } };
  };

  try {
    const todayDate = localDateString(now, timezone);
    // The ONE schedule lookup, for the whole business (#1498).
    const schedule = await lookupMyDay(
      {
        tenantId: input.tenantId,
        wholeTenant: true,
        timezone,
        now,
        ...(input.day ? { day: input.day } : {}),
      },
      {
        appointmentRepo: deps.appointmentRepo,
        jobRepo: deps.jobRepo,
        ...(deps.userRepo ? { userRepo: deps.userRepo } : {}),
      },
    );
    if (schedule.status === 'error') return failed(schedule.data.error);
    const appointments = schedule.data.dayAppointments;
    const noOverview = {
      urgentJobs: [],
      pendingApprovalsCount: 0,
      overnight: { createdCount: 0, executedCount: 0, failedCount: 0 },
    };

    // Another day: only its schedule — urgency, approvals and overnight are NOW.
    if (schedule.data.day !== todayDate) {
      const status = appointments.length > 0 ? 'found' : 'none';
      await recordEvent(status, appointments.length, schedule.summary);
      return { status, summary: schedule.summary, data: { appointments, ...noOverview } };
    }

    const today = resolveDayWindow(todayDate, timezone);
    // Yesterday 6pm tenant-local = today's local midnight minus 6 hours.
    const overnightSince = new Date(
      today.start.getTime() - OVERNIGHT_LOOKBACK_FROM_MIDNIGHT_MS,
    );

    const [allJobs, draftProposals, readyProposals, overnight] = await Promise.all([
      // 200: covers a busy week of jobs on a typical SMB tenant without
      // loading the entire job history. Urgent/high-priority jobs are
      // filtered client-side below, so a priority-filtered DB query
      // (findByPriority) would be cleaner but the repo interface
      // doesn't expose one yet — this bounded scan is acceptable until
      // a priority index + filtered query is added.
      deps.jobRepo.findByTenant(input.tenantId, { limit: 200 }),
      deps.proposalRepo.findByStatus(input.tenantId, 'draft'),
      deps.proposalRepo.findByStatus(input.tenantId, 'ready_for_review'),
      listSince(deps.proposalRepo, input.tenantId, overnightSince),
    ]);

    const urgentJobs: DayOverviewUrgentJob[] = allJobs
      .filter(
        (j) =>
          (j.priority === 'urgent' || j.priority === 'high') &&
          j.status !== 'completed' &&
          j.status !== 'canceled',
      )
      // Urgent strictly ahead of high.
      .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'urgent' ? -1 : 1))
      .map((j) => ({
        jobId: j.id,
        jobNumber: j.jobNumber,
        summary: j.summary,
        priority: j.priority,
      }));

    // Counted through the same inbox composition the operator screen uses.
    const pendingApprovalsCount = buildInboxPayload(
      [...draftProposals, ...readyProposals],
      INBOX_COUNT_CAP,
    ).summary.totalCount;

    // ── Spoken summary: urgent first, then schedule, approvals, overnight ──
    const sentences: string[] = [];

    if (urgentJobs.length > 0) {
      const spoken = urgentJobs
        .slice(0, MAX_SPOKEN_URGENT_JOBS)
        .map((j) => j.summary)
        .join('; ');
      const rest = urgentJobs.length - Math.min(urgentJobs.length, MAX_SPOKEN_URGENT_JOBS);
      sentences.push(
        `Heads up — ${urgentJobs.length} ${plural(urgentJobs.length, 'high-priority job')} ` +
          `${plural(urgentJobs.length, 'needs', 'need')} attention: ${spoken}` +
          `${rest > 0 ? `, plus ${rest} more` : ''}.`,
      );
    }

    sentences.push(schedule.summary);

    if (pendingApprovalsCount > 0) {
      sentences.push(
        `${pendingApprovalsCount} ${plural(pendingApprovalsCount, 'approval is', 'approvals are')} waiting on you.`,
      );
    }

    const overnightBits: string[] = [];
    if (overnight.created.length > 0) {
      overnightBits.push(
        `${overnight.created.length} new ${plural(overnight.created.length, 'proposal')} came in`,
      );
    }
    if (overnight.executed.length > 0) {
      overnightBits.push(`${overnight.executed.length} executed`);
    }
    if (overnight.failed.length > 0) {
      overnightBits.push(`${overnight.failed.length} failed`);
    }
    if (overnightBits.length > 0) {
      sentences.push(`Overnight: ${overnightBits.join(', ')}.`);
    } else {
      sentences.push('Nothing came in overnight.');
    }

    const anyContent =
      appointments.length > 0 ||
      urgentJobs.length > 0 ||
      pendingApprovalsCount > 0 ||
      overnight.totalCount > 0;

    const summary = anyContent
      ? sentences.join(' ')
      : 'Your day is clear — no appointments today and nothing is waiting on you.';

    const status = anyContent ? 'found' : 'none';
    await recordEvent(status, appointments.length, summary);

    return {
      status,
      summary,
      data: {
        appointments,
        urgentJobs,
        pendingApprovalsCount,
        overnight: {
          createdCount: overnight.created.length,
          executedCount: overnight.executed.length,
          failedCount: overnight.failed.length,
        },
      },
    };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}
