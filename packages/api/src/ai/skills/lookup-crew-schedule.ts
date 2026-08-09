/**
 * Task 10 (2026-08-07 tradesperson plan) — `lookup_crew_schedule` voice skill.
 *
 * Owner/dispatcher asks who is free / where a named crew member is, on a
 * given day or window ("Who's free Thursday afternoon?", "What's Mike's
 * day look like?", "Where's Carlos right now?"). Owner-extended
 * (`OWNER_EXTENDED_LOOKUP_INTENT_TYPES`) + permission-gated
 * (`reports:view`, `LOOKUP_REQUIRED_PERMISSION`) — mirrors
 * `lookup_day_overview`'s gating posture exactly (intent-classifier.ts,
 * workers/voice-lookup-answer.ts).
 *
 * Tenant-scoped, read-only. A named technician who did not resolve to a
 * verified `technicianId` is refused by the CALLER
 * (workers/voice-lookup-answer.ts's `lookup_crew_schedule` case) BEFORE
 * this skill ever runs — this skill only ever receives a technicianId that
 * has ALREADY been verified, never a raw reference. That refusal matters
 * MORE here than lookup_materials's job-reference precedent (spec-review
 * MAJOR A): silently falling back to "everyone" on an unresolved *person*
 * would leak the WHOLE crew's schedule to a request that named one
 * individual — a materially worse disclosure than an unscoped shopping
 * list.
 *
 * ── Day/window resolution ───────────────────────────────────────────────
 *
 * Reuses the SAME `resolveDateTime` (U4, ai/scheduling/resolve-datetime.ts)
 * the booking path uses, given the caller's raw spoken
 * `dateTimeDescription` + tenant timezone. Only the DAY the phrase
 * resolves to is used — the whole calendar day is reported even when a
 * daypart was named ("Thursday afternoon" shows Thursday's whole
 * schedule, not just noon-5pm; narrowing to the daypart itself is a
 * genuine future refinement, not done here). A phrase that doesn't parse
 * (or no phrase at all — "What's Mike's day look like?" names no day)
 * defaults to TODAY, and the spoken summary always names the day being
 * reported ("today" vs. the resolved weekday) so a defaulted day can never
 * be mistaken for the one actually asked about.
 *
 * ── Technician roster + assignment (bounded fetch) ──────────────────────
 *
 * Mirrors `lookup-day-overview.ts`'s established pattern: a job's
 * `assignedTechnicianId` (not a second `AssignmentRepository` fetch) is
 * the technician-per-appointment join. `AssignmentRepository.findByTechnician`
 * has no date bound — using it here would be an UNBOUNDED per-technician
 * fetch across the tenant's entire assignment history just to answer "are
 * you free today" (the exact bounded-fetch failure class `lookup-
 * materials.ts`'s I4 fix addressed). Appointments are bounded to the
 * resolved day (`AppointmentRepository.findByDateRange`); jobs are bounded
 * either to that ONE technician's own jobs (`JobRepository.findByTenant`
 * with `technicianId`, when one is named) or to a generous but bounded
 * tenant-wide page (`limit: 200`, the same cap `lookup-day-overview.ts`
 * uses) when reporting on the whole crew.
 */
import type { Appointment, AppointmentRepository } from '../../appointments/appointment';
import type { Job, JobRepository } from '../../jobs/job';
import type { User, UserRepository } from '../../users/user';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';
import { resolveDateTime } from '../scheduling/resolve-datetime';
import { resolveDayWindow } from '../../reports/money-dashboard';
import { localDateString } from '../../digest/digest-service';
import { plural } from './spoken-format';

export interface LookupCrewScheduleInput {
  tenantId: string;
  sessionId?: string;
  /** Verified technicianId, when a crew member was named and resolved. */
  technicianId?: string;
  /** Raw spoken day/window phrase ("Thursday afternoon"), when stated. */
  dateTimeDescription?: string;
  timezone?: string;
  now?: Date;
}

export interface LookupCrewScheduleDeps {
  appointmentRepo: AppointmentRepository;
  jobRepo: JobRepository;
  userRepo: Pick<UserRepository, 'findByTenant'>;
  lookupEvents?: LookupEventService;
}

export interface CrewScheduleBooking {
  technicianId: string;
  technicianName: string;
  jobSummary?: string;
  scheduledStart: Date;
  scheduledEnd: Date;
}

export type LookupCrewScheduleResult =
  | {
      status: 'found' | 'none';
      summary: string;
      data: {
        /** "today" or a rendered weekday/date label — always names the day actually reported. */
        dayLabel: string;
        freeTechnicians: string[];
        bookings: CrewScheduleBooking[];
      };
    }
  | { status: 'error'; summary: string; data: { error: string } };

const DEFAULT_TIMEZONE = 'America/New_York';
/** Spoken caps — a 20-person crew must not become a name-reading marathon. */
const MAX_SPOKEN_FREE = 8;
const MAX_SPOKEN_BOOKINGS = 5;

function technicianDisplayName(u: Pick<User, 'firstName' | 'lastName' | 'email'>): string {
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
}

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

function dayLabelFor(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  }).format(d);
}

/**
 * Resolve the calendar day being asked about. See module doc comment for
 * the full rationale — only the DAY component of a resolved phrase is
 * used, and an unparseable/absent phrase honestly defaults to today.
 */
function resolveDayBoundary(
  desc: string | undefined,
  now: Date,
  timezone: string,
): { start: Date; end: Date; label: string } {
  const todayKey = localDateString(now, timezone);
  if (desc) {
    const resolved = resolveDateTime(desc, { timezone, now });
    if (resolved.ok) {
      const anchor = new Date(resolved.startUtc);
      const dateKey = localDateString(anchor, timezone);
      const window = resolveDayWindow(dateKey, timezone);
      const label = dateKey === todayKey ? 'today' : dayLabelFor(anchor, timezone);
      return { ...window, label };
    }
  }
  return { ...resolveDayWindow(todayKey, timezone), label: 'today' };
}

export async function lookupCrewSchedule(
  input: LookupCrewScheduleInput,
  deps: LookupCrewScheduleDeps,
): Promise<LookupCrewScheduleResult> {
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
        intent: 'lookup_crew_schedule',
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
    const day = resolveDayBoundary(input.dateTimeDescription, now, timezone);

    const [technicians, appointments, jobs] = await Promise.all([
      deps.userRepo.findByTenant(input.tenantId, { role: 'technician' }),
      deps.appointmentRepo.findByDateRange(input.tenantId, day.start, day.end),
      input.technicianId
        ? deps.jobRepo.findByTenant(input.tenantId, { technicianId: input.technicianId, limit: 200 })
        : deps.jobRepo.findByTenant(input.tenantId, { limit: 200 }),
    ]);

    if (technicians.length === 0) {
      const summary = "You don't have any crew members on the roster yet.";
      await record('none', 0, summary);
      return { status: 'none', summary, data: { dayLabel: day.label, freeTechnicians: [], bookings: [] } };
    }

    const jobById = new Map<string, Job>(jobs.map((j) => [j.id, j] as const));
    const techById = new Map<string, User>(technicians.map((t) => [t.id, t] as const));

    const liveAppointments = appointments.filter(
      (a: Appointment) => a.status !== 'canceled' && a.status !== 'no_show',
    );

    const bookings: CrewScheduleBooking[] = [];
    const busyTechnicianIds = new Set<string>();
    for (const appt of liveAppointments) {
      const job = jobById.get(appt.jobId);
      const techId = job?.assignedTechnicianId;
      if (!techId) continue;
      if (input.technicianId && techId !== input.technicianId) continue;
      const tech = techById.get(techId);
      if (!tech) continue; // not on the technician roster (role changed / removed) — not a crew booking
      busyTechnicianIds.add(techId);
      bookings.push({
        technicianId: techId,
        technicianName: technicianDisplayName(tech),
        ...(job.summary ? { jobSummary: job.summary } : {}),
        scheduledStart: appt.scheduledStart,
        scheduledEnd: appt.scheduledEnd,
      });
    }
    bookings.sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());

    // Named technician — scope the WHOLE answer to that one person, never
    // "everyone" (see module doc comment).
    if (input.technicianId) {
      const tech = techById.get(input.technicianId);
      const name = tech ? technicianDisplayName(tech) : 'that technician';
      if (bookings.length === 0) {
        const summary = `${name} has nothing on the books ${day.label} — free all day.`;
        await record('found', 0, summary);
        return {
          status: 'found',
          summary,
          data: { dayLabel: day.label, freeTechnicians: [name], bookings: [] },
        };
      }
      const spoken = bookings.slice(0, MAX_SPOKEN_BOOKINGS).map((b) => {
        const time = formatTime(b.scheduledStart, timezone);
        return `${time}${b.jobSummary ? ` — ${b.jobSummary}` : ''}`;
      });
      const rest = bookings.length - spoken.length;
      const summary =
        `${name} has ${bookings.length} ${plural(bookings.length, 'booking')} ${day.label}: ` +
        `${spoken.join('; ')}${rest > 0 ? `; and ${rest} more` : ''}.`;
      await record('found', bookings.length, summary);
      return { status: 'found', summary, data: { dayLabel: day.label, freeTechnicians: [], bookings } };
    }

    // No technician named — "who's free" for the WHOLE crew.
    const freeTechnicians = technicians
      .filter((t) => !busyTechnicianIds.has(t.id))
      .map((t) => technicianDisplayName(t));

    const summaryParts: string[] = [];
    if (freeTechnicians.length > 0) {
      const spoken = freeTechnicians.slice(0, MAX_SPOKEN_FREE);
      const rest = freeTechnicians.length - spoken.length;
      summaryParts.push(`Free ${day.label}: ${spoken.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`);
    } else {
      summaryParts.push(`Nobody's free ${day.label} — the whole crew is booked`);
    }
    if (bookings.length > 0) {
      const spoken = bookings.slice(0, MAX_SPOKEN_BOOKINGS).map((b) => {
        const time = formatTime(b.scheduledStart, timezone);
        return `${b.technicianName} at ${time}${b.jobSummary ? ` — ${b.jobSummary}` : ''}`;
      });
      const rest = bookings.length - spoken.length;
      summaryParts.push(`Booked: ${spoken.join('; ')}${rest > 0 ? `; and ${rest} more` : ''}`);
    }
    const summary = `${summaryParts.join('. ')}.`;
    await record('found', technicians.length, summary);
    return { status: 'found', summary, data: { dayLabel: day.label, freeTechnicians, bookings } };
  } catch (err) {
    const summary = "I'm having trouble pulling up the crew schedule right now.";
    await record('error', 0, summary);
    return {
      status: 'error',
      summary,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
