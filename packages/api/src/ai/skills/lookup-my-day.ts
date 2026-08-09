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
 * asking actor to a canonical technician via
 * `dispatch/en-route-voice.ts`'s `resolveCanonicalTechnician` BEFORE this
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
 * `lookup-crew-schedule.ts`'s identical rationale). Jobs are fetched
 * SERVER-SIDE FILTERED to this one technician
 * (`JobRepository.findByTenant({ technicianId })`) rather than the
 * whole-tenant page `lookup-day-overview.ts` pulls for the owner's
 * cross-crew overview — a technician's own day needs only their own jobs,
 * so this is both more bounded and impossible to accidentally leak a
 * coworker's job summary into the join.
 *
 * No urgent-jobs section, no pending-approvals count, no overnight
 * digest — those are owner-facing concepts `lookup_day_overview` speaks;
 * this intent is deliberately just "your appointments today."
 */
import type { Appointment, AppointmentRepository } from '../../appointments/appointment';
import type { JobRepository } from '../../jobs/job';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';
import { resolveDayWindow } from '../../reports/money-dashboard';
import { localDateString } from '../../digest/digest-service';
import { plural } from './spoken-format';

export interface LookupMyDayInput {
  tenantId: string;
  sessionId?: string;
  /**
   * The SPEAKER's own canonical technician id, already resolved by the
   * caller (dispatch/en-route-voice.ts's `resolveCanonicalTechnician`).
   * REQUIRED — see module doc comment: this is not an optional narrowing
   * filter, it is the entire access-control story for this intent.
   */
  technicianId: string;
  timezone?: string;
  now?: Date;
}

export interface LookupMyDayDeps {
  appointmentRepo: AppointmentRepository;
  jobRepo: JobRepository;
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

function formatTime(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: 'numeric',
    hour12: true,
    timeZone: timezone,
  })
    .format(d)
    .replace(':00', '');
}

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

    const [rawAppointments, myJobs] = await Promise.all([
      deps.appointmentRepo.findByDateRange(input.tenantId, today.start, today.end),
      // Server-side filtered to THIS technician's own jobs — never the
      // whole-tenant page (see module doc comment).
      deps.jobRepo.findByTenant(input.tenantId, { technicianId: input.technicianId, limit: 200 }),
    ]);

    const myJobIds = new Set(myJobs.map((j) => j.id));
    const jobById = new Map(myJobs.map((j) => [j.id, j] as const));

    const appointments: MyDayAppointment[] = rawAppointments
      .filter(
        (a: Appointment) =>
          a.status !== 'canceled' && a.status !== 'no_show' && myJobIds.has(a.jobId),
      )
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
      const summary = 'Your day is clear — nothing on your schedule today.';
      await record('none', 0, summary);
      return { status: 'none', summary, data: { appointments: [] } };
    }

    const spoken = appointments.slice(0, MAX_SPOKEN_APPOINTMENTS).map((a) => {
      const time = formatTime(a.scheduledStart, timezone);
      return `${time}${a.jobSummary ? ` — ${a.jobSummary}` : ''}`;
    });
    const rest = appointments.length - spoken.length;
    const summary =
      `You have ${appointments.length} ${plural(appointments.length, 'appointment')} today: ` +
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
