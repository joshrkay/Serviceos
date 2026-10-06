/**
 * The ONE schedule lookup — `lookup_my_day`, and (#1498) every other
 * "what's on the schedule?" question the operator surfaces answer:
 * `lookup_appointments` asked with no customer, and `lookup_day_overview`'s
 * appointment sentence. Chat and in-app voice both reach it through
 * `workers/voice-lookup-answer.ts#executeLookupAnswer`, so the two surfaces
 * can no longer give two different answers to the same question (the QA
 * sweep heard "7 appointments today" and "You have nothing left today" for
 * the same tenant, same minute).
 *
 * ── Scope: whose schedule ────────────────────────────────────────────────
 *
 * The CALLER decides, and says so explicitly — there is no default:
 *   - `technicianId` — a technician's own assignments (via
 *     `job.assignedTechnicianId`). For a technician this self-scoping IS the
 *     access control: `lookup_my_day` carries no permission gate, so the
 *     caller resolves the speaker (`resolveCanonicalUser`) BEFORE this runs
 *     and fails the turn when it can't — never falling back to a wider day.
 *   - `wholeTenant: true` — the business's schedule. Only for an actor whose
 *     DB-authoritative role holds `dispatch:view` (owner, dispatcher): an
 *     owner asking "what's on my schedule today?" means the business's day,
 *     and scoping them to their own (usually empty) assignment list is what
 *     produced "nothing left today" against a seven-visit day.
 *
 * ── Which day ────────────────────────────────────────────────────────────
 *
 * `day` is a tenant-local `YYYY-MM-DD` the caller resolved from the words
 * ("tomorrow", "Friday"); absent means TODAY in the tenant's zone. The answer
 * always names the day it reports ("today", "tomorrow", "on Friday,
 * October 2"), so a misheard day is audible rather than silent.
 *
 * ── What "left today" means (precisely) ──────────────────────────────────
 *
 * A day's appointments are every visit that day that was not canceled or a
 * no-show. Of those, the ones LEFT are the ones not marked completed whose
 * scheduled end has not passed yet. For today the answer gives both numbers
 * when they differ ("You have 4 appointments today, 1 still ahead: …"), and
 * "Nothing left today" is said ONLY when the day had visits and none remain
 * — it is never used for an empty day, which is "nothing on the schedule
 * today". Another day has nothing "left": every visit on it is listed.
 *
 * Jobs are resolved by id from the day's appointments alone
 * (`JobRepository.findByIds`, quality-review C2) — never a
 * `findByTenant({ limit })` page, which drops an old job with a live
 * appointment once the tenant has more jobs than the page holds.
 */
import type { Appointment, AppointmentRepository } from '../../appointments/appointment';
import type { JobRepository } from '../../jobs/job';
import type { UserRepository } from '../../users/user';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';
import { resolveDayWindow } from '../../reports/money-dashboard';
import { localDateString, nextDateString } from '../../digest/digest-service';
import { plural, formatTime, technicianDisplayName } from './spoken-format';

/**
 * WHOSE schedule a self-scoped lookup reads — decided by the caller, never
 * guessed here. Shared by `lookup_my_day`, `lookup_next_job` (#1604) and the
 * dispatch's `resolveScheduleScope`, so the two readings cannot drift.
 */
export type ScheduleScope =
  | {
      /**
       * The SPEAKER's own canonical technician id, already resolved by the
       * caller — see the module doc: for a technician this is the whole
       * access-control story.
       */
      technicianId: string;
      wholeTenant?: never;
    }
  | { wholeTenant: true; technicianId?: never };

export type LookupMyDayInput = {
  tenantId: string;
  sessionId?: string;
  timezone?: string;
  now?: Date;
  /** Tenant-local `YYYY-MM-DD`; absent → today. */
  day?: string;
} & ScheduleScope;

export interface LookupMyDayDeps {
  appointmentRepo: AppointmentRepository;
  jobRepo: Pick<JobRepository, 'findByIds'>;
  /** Optional — crew names on a whole-tenant schedule. Decorative. */
  userRepo?: Pick<UserRepository, 'findByTenant'>;
  lookupEvents?: LookupEventService;
}

export interface MyDayAppointment {
  appointmentId: string;
  jobId: string;
  jobSummary?: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  technicianName?: string;
}

export type LookupMyDayResult =
  | {
      status: 'found' | 'none';
      summary: string;
      data: {
        /** The tenant-local day reported, `YYYY-MM-DD`. */
        day: string;
        /** Every visit that day (not canceled / no-show), in start order. */
        dayAppointments: MyDayAppointment[];
        /** The visits still LEFT (today) — or all of them (another day). */
        appointments: MyDayAppointment[];
      };
    }
  | { status: 'error'; summary: string; data: { error: string } };

const DEFAULT_TIMEZONE = 'America/New_York';
/** Spoken cap — a busy day must not become a monologue. */
const MAX_SPOKEN_APPOINTMENTS = 5;

/** "today" / "tomorrow" / "on Friday, October 2" — the day, as spoken. */
function dayLabel(day: string, today: string, timezone: string): string {
  if (day === today) return 'today';
  if (day === nextDateString(today)) return 'tomorrow';
  const noon = new Date(resolveDayWindow(day, timezone).start.getTime() + 12 * 3_600_000);
  return `on ${new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  }).format(noon)}`;
}

function spokenList(appointments: MyDayAppointment[], timezone: string): string {
  const spoken = appointments.slice(0, MAX_SPOKEN_APPOINTMENTS).map((a) => {
    const what = a.jobSummary ? ` — ${a.jobSummary}` : '';
    const who = a.technicianName ? ` with ${a.technicianName}` : '';
    return `${formatTime(a.scheduledStart, timezone)}${what}${who}`;
  });
  const rest = appointments.length - spoken.length;
  return `${spoken.join('; ')}${rest > 0 ? `; and ${rest} more` : ''}`;
}

function summarize(
  label: string,
  isToday: boolean,
  dayAppointments: MyDayAppointment[],
  left: MyDayAppointment[],
  timezone: string,
): string {
  const total = dayAppointments.length;
  const noun = plural(total, 'appointment');
  if (total === 0) {
    return isToday ? 'You have nothing on the schedule today.' : `Nothing is scheduled ${label}.`;
  }
  if (!isToday || left.length === total) {
    return `You have ${total} ${noun} ${label}: ${spokenList(dayAppointments, timezone)}.`;
  }
  if (left.length === 0) {
    return `Nothing left today — ${total === 1 ? "today's one appointment is" : `all ${total} of today's appointments are`} behind you.`;
  }
  return `You have ${total} ${noun} today, ${left.length} still ahead: ${spokenList(left, timezone)}.`;
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
    // No scope, no answer: this module never guesses whose day to read.
    if (!input.wholeTenant && !input.technicianId) {
      throw new Error('schedule lookup needs a technician or the whole tenant');
    }
    const today = localDateString(now, timezone);
    const day = input.day ?? today;
    const isToday = day === today;
    const window = resolveDayWindow(day, timezone);

    const rawAppointments = await deps.appointmentRepo.findByDateRange(
      input.tenantId,
      window.start,
      window.end,
    );
    const live = rawAppointments.filter(
      (a: Appointment) => a.status !== 'canceled' && a.status !== 'no_show',
    );
    const jobIds = Array.from(new Set(live.map((a) => a.jobId)));
    const jobs = jobIds.length > 0 ? await deps.jobRepo.findByIds(input.tenantId, jobIds) : [];
    const jobById = new Map(jobs.map((j) => [j.id, j] as const));

    let nameById = new Map<string, string>();
    if (input.wholeTenant && deps.userRepo) {
      try {
        const users = await deps.userRepo.findByTenant(input.tenantId);
        nameById = new Map(users.map((u) => [u.id, technicianDisplayName(u)]));
      } catch {
        // Names are decorative — never fail the schedule over them.
      }
    }

    const dayAppointments: MyDayAppointment[] = live
      // Strictly the technician's own assignments when scoped to one —
      // never a coworker's visit on a job this fetch happened to load.
      .filter((a) => input.wholeTenant || jobById.get(a.jobId)?.assignedTechnicianId === input.technicianId)
      .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime())
      .map((a) => {
        const job = jobById.get(a.jobId);
        const technicianName = job?.assignedTechnicianId ? nameById.get(job.assignedTechnicianId) : undefined;
        return {
          appointmentId: a.id,
          jobId: a.jobId,
          ...(job?.summary ? { jobSummary: job.summary } : {}),
          scheduledStart: a.scheduledStart,
          scheduledEnd: a.scheduledEnd,
          ...(technicianName ? { technicianName } : {}),
        };
      });
    const statusById = new Map(live.map((a) => [a.id, a.status] as const));
    const left = isToday
      ? dayAppointments.filter(
          (a) => statusById.get(a.appointmentId) !== 'completed' && a.scheduledEnd >= now,
        )
      : dayAppointments;

    const summary = summarize(dayLabel(day, today, timezone), isToday, dayAppointments, left, timezone);
    const status = left.length > 0 ? 'found' : 'none';
    await record(status, left.length, summary);
    return { status, summary, data: { day, dayAppointments, appointments: left } };
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
