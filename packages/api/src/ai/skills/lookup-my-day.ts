/**
 * Task 10 (2026-08-07 tradesperson plan) — `lookup_my_day` voice skill.
 *
 * The SPEAKER asks about their OWN schedule today ("What's my next job?",
 * "What's on my schedule today?", "Where am I going after this one?").
 * Available to ANY technician — deliberately absent from BOTH
 * `OWNER_EXTENDED_LOOKUP_INTENT_TYPES` and `LOOKUP_REQUIRED_PERMISSION`
 * (intent-classifier.ts / workers/voice-lookup-answer.ts).
 *
 * ── Self-scoping IS the access control (the single most important
 *    property of this intent) ─────────────────────────────────────────
 *
 * Because this intent carries no permission gate, `technicianId` on
 * `LookupMyDayInput` is REQUIRED, not optional — there is no code path in
 * this module that can answer without one. The CALLER
 * (workers/voice-lookup-answer.ts's `lookup_my_day` case) resolves the
 * asking actor via `users/user.ts`'s `resolveCanonicalUser` BEFORE this
 * skill ever runs, and returns `{ kind: 'failed', error: 'could not match
 * you to a technician' }` immediately when that resolution fails — this
 * skill is never invoked with an unresolved or absent identity, and never
 * falls back to a tenant-wide or whole-crew day. Mirrors
 * `lookup_job_profit`'s "the job is resolved upstream" contract, applied
 * to the speaker's own identity instead of a spoken job reference.
 *
 * ── Data shape mirrors lookup-day-overview.ts, self-scoped ──────────────
 *
 * Reuses the exact same bounded-fetch pattern `lookup-day-overview.ts`
 * established: today's appointments via
 * `AppointmentRepository.findByDateRange` (bounded to the day, tenant-
 * wide), technician assignment via `job.assignedTechnicianId` (never a
 * second, unbounded `AssignmentRepository.findByTechnician` fetch — see
 * `lookup-crew-schedule.ts`'s identical rationale).
 *
 * Jobs are resolved by id from TODAY's appointments alone
 * (`JobRepository.findByIds`, quality-review C2) — NOT a
 * `findByTenant({ technicianId, limit })` page. That page is ordered by
 * `createdAt DESC`, so once a technician has done more jobs than the page
 * limit over their tenure, a job created long ago that still has a live
 * appointment today silently falls off the page and the appointment is
 * filtered out of "my day" entirely — a technician who has worked at a
 * shop for over a year (a normal tenure, not an edge case) would
 * routinely be told their real day was clear. `findByIds` is bounded to
 * exactly the day's distinct job ids and correct at any job-count
 * history.
 *
 * No urgent-jobs section, no pending-approvals count, no overnight
 * digest — those are owner-facing concepts `lookup_day_overview` speaks;
 * this intent is deliberately just "your appointments today."
 *
 * ── Only what's STILL ahead today (quality-review I5) ────────────────────
 *
 * Filtered to appointments that are not yet finished
 * (`status !== 'completed'` AND `scheduledEnd >= now`) — a DELIBERATE
 * divergence from `lookup-day-overview.ts`, which speaks the WHOLE day
 * unfiltered by time (including appointments already past). The taxonomy
 * (intent-classifier.ts) advertises "What's my next job?" and "Where am I
 * going after this one?" for this intent — phrasings that promise
 * FORWARD-looking information; a technician asking at 3pm must not hear
 * their 8am job read back first (or at all). `lookup_crew_schedule` makes
 * the OPPOSITE choice for the SAME "completed" status on purpose — from a
 * dispatcher's planning perspective a completed job still occupied that
 * technician's day, which is exactly what "who was busy" needs to answer
 * correctly. Two different questions, two different correct filters.
 */
import type { Appointment, AppointmentRepository } from '../../appointments/appointment';
import type { JobRepository } from '../../jobs/job';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';
import { resolveDayWindow } from '../../reports/money-dashboard';
import { localDateString } from '../../digest/digest-service';
import { plural, formatTime } from './spoken-format';

export interface LookupMyDayInput {
  tenantId: string;
  sessionId?: string;
  /**
   * The SPEAKER's own canonical technician id, already resolved by the
   * caller (`users/user.ts`'s `resolveCanonicalUser`). REQUIRED — see
   * module doc comment: this is not an optional narrowing filter, it is
   * the entire access-control story for this intent.
   */
  technicianId: string;
  timezone?: string;
  now?: Date;
}

export interface LookupMyDayDeps {
  appointmentRepo: AppointmentRepository;
  jobRepo: Pick<JobRepository, 'findByIds'>;
  lookupEvents?: LookupEventService;
}

export interface MyDayAppointment {
  appointmentId: string;
  jobId: string;
  jobSummary?: string;
  scheduledStart: Date;
  scheduledEnd: Date;
}

export type LookupMyDayResult =
  | {
      status: 'found' | 'none';
      summary: string;
      data: { appointments: MyDayAppointment[] };
    }
  | { status: 'error'; summary: string; data: { error: string } };

const DEFAULT_TIMEZONE = 'America/New_York';
/** Spoken cap — a busy day must not become a monologue. */
const MAX_SPOKEN_APPOINTMENTS = 5;

export async function lookupMyDay(
  input: LookupMyDayInput,
  deps: LookupMyDayDeps,
): Promise<LookupMyDayResult> {
  const start = Date.now();
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const now = input.now ?? new Date();

  const record = async (
    resultStatus: 'found' | 'none' | 'error',
    resultCount: number,
    summary: string,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        intent: 'lookup_my_day',
        resultStatus,
        resultCount,
        summary,
        latencyMs: Date.now() - start,
      });
    } catch {
      /* swallow — an audit-write failure never breaks the spoken turn */
    }
  };

  try {
    const today = resolveDayWindow(localDateString(now, timezone), timezone);

    // Bounded to TODAY, tenant-wide (mirrors lookup-day-overview.ts).
    const rawAppointments = await deps.appointmentRepo.findByDateRange(
      input.tenantId,
      today.start,
      today.end,
    );

    // Jobs resolved by id from TODAY's appointments only (C2) — never a
    // findByTenant({ technicianId, limit }) page, which is ordered by
    // createdAt DESC and silently drops an old job with a live
    // appointment today once a technician has more jobs than the page
    // limit in their history. See module doc comment.
    const jobIds = Array.from(new Set(rawAppointments.map((a) => a.jobId)));
    const jobs = jobIds.length > 0 ? await deps.jobRepo.findByIds(input.tenantId, jobIds) : [];
    const jobById = new Map(jobs.map((j) => [j.id, j] as const));

    const appointments: MyDayAppointment[] = rawAppointments
      .filter((a: Appointment) => {
        if (a.status === 'canceled' || a.status === 'no_show' || a.status === 'completed') {
          return false;
        }
        // I5 — only what's still ahead: "what's my next job" must never
        // read back a visit that's already over. See module doc comment.
        if (a.scheduledEnd < now) return false;
        const job = jobById.get(a.jobId);
        // Strictly scoped to THIS technician's own assignment — never a
        // coworker's appointment on a job this fetch happened to load.
        return job?.assignedTechnicianId === input.technicianId;
      })
      .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime())
      .map((a) => {
        const job = jobById.get(a.jobId);
        return {
          appointmentId: a.id,
          jobId: a.jobId,
          ...(job?.summary ? { jobSummary: job.summary } : {}),
          scheduledStart: a.scheduledStart,
          scheduledEnd: a.scheduledEnd,
        };
      });

    if (appointments.length === 0) {
      // Task 10 residual (two re-reviews) — "clear" reads as "you had
      // nothing on today", which is false at 5pm after a full day of
      // already-worked (now-filtered-out, per I5 above) appointments.
      // "Nothing left today" is honest either way: no day happened at
      // all, or a full day already happened and finished. Quality-review
      // minor — "You have nothing left today." reads better spoken than
      // the bare fragment.
      const summary = 'You have nothing left today.';
      await record('none', 0, summary);
      return { status: 'none', summary, data: { appointments: [] } };
    }

    const spoken = appointments.slice(0, MAX_SPOKEN_APPOINTMENTS).map((a) => {
      const time = formatTime(a.scheduledStart, timezone);
      return `${time}${a.jobSummary ? ` — ${a.jobSummary}` : ''}`;
    });
    const rest = appointments.length - spoken.length;
    const summary =
      `You have ${appointments.length} ${plural(appointments.length, 'appointment')} left today: ` +
      `${spoken.join('; ')}${rest > 0 ? `; and ${rest} more` : ''}.`;

    await record('found', appointments.length, summary);
    return { status: 'found', summary, data: { appointments } };
  } catch (err) {
    const summary = "I'm having trouble pulling up your day right now.";
    await record('error', 0, summary);
    return {
      status: 'error',
      summary,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
