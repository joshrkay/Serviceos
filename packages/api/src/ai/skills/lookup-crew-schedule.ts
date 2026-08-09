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
 * ── Day/window resolution (quality-review C1) ───────────────────────────
 *
 * Resolves the caller's raw spoken `dateTimeDescription` via
 * `resolveSpokenDay` (ai/scheduling/resolve-datetime.ts) — the LOOKUP-side
 * sibling of the booking resolver `resolveDateTime`. The two have
 * DIFFERENT contracts on purpose: booking a bare "Thursday" is
 * meaningless (there's no time to reserve), so `resolveDateTime` correctly
 * REFUSES it; a day/window LOOKUP has nothing to book, it only needs to
 * know WHICH DAY, so `resolveSpokenDay` accepts exactly the bare-day
 * phrasings `resolveDateTime` refuses ("Thursday", "tomorrow", "Monday",
 * "this Friday", "next week") — which is exactly what the classifier
 * prompt instructs callers to say. An earlier version of this skill called
 * `resolveDateTime` here, which silently answered about TODAY for every
 * one of those phrasings. Only the DAY the phrase resolves to is used —
 * the whole calendar day is reported even when a daypart was named
 * ("Thursday afternoon" shows Thursday's whole schedule, not just
 * noon-5pm; narrowing to the daypart itself is a genuine future
 * refinement, not done here). A phrase that doesn't parse (or no phrase at
 * all — "What's Mike's day look like?" names no day) defaults to TODAY,
 * and the spoken summary always names the day being reported ("today" vs.
 * the resolved weekday) so a defaulted day can never be mistaken for the
 * one actually asked about.
 *
 * ── Roster + assignment (quality-review C2, MEDIUM) ─────────────────────
 *
 * The roster is EVERY user in the tenant, not just `role: 'technician'` —
 * the entity resolver's `technician` EntityKind matches
 * `role IN ('technician','dispatcher','owner')` ("anyone assignable to an
 * appointment", pg-entity-resolver.ts), and every user role in this system
 * IS one of those three, so an unfiltered `findByTenant` is exactly that
 * set. Filtering to `role: 'technician'` alone meant a working owner or
 * dispatcher — a normal case in trades, not an edge one — resolved fine by
 * name but then vanished from `techById`, so their real bookings were
 * silently dropped and they were reported "free all day" under the
 * fallback name 'that technician'.
 *
 * Appointments are bounded to the resolved day
 * (`AppointmentRepository.findByDateRange`, tenant-wide); jobs are
 * resolved by id from THAT DAY'S appointments alone
 * (`JobRepository.findByIds`) rather than a `findByTenant({ limit })`
 * page. A page ordered by `createdAt DESC` returns the most RECENTLY
 * CREATED jobs, not the jobs relevant to this day — a job created months
 * ago (a recurring maintenance visit, a reschedule) routinely still has a
 * live appointment today, and once a tenant has done more jobs than the
 * page limit, that appointment's job silently misses the page. The
 * mechanism made this WORSE than a missing string: `jobById.get(...)`
 * returning undefined meant the technician was never added to
 * `busyTechnicianIds` at all, so a technician with a real appointment
 * today was reported free. `findByIds` is strictly MORE bounded than any
 * tenant-wide page (exactly the day's distinct job ids) and correct at any
 * tenant size or job age. `AssignmentRepository.findByTechnician` remains
 * the wrong tool for either problem — it has no date bound at all, an
 * unbounded per-technician scan across the tenant's entire assignment
 * history just to answer "are you free today" (the exact bounded-fetch
 * failure class `lookup-materials.ts`'s I4 fix addressed).
 */
import type { Appointment, AppointmentRepository } from '../../appointments/appointment';
import type { Job, JobRepository } from '../../jobs/job';
import type { User, UserRepository } from '../../users/user';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';
import { resolveSpokenDay } from '../scheduling/resolve-datetime';
import { resolveDayWindow } from '../../reports/money-dashboard';
import { localDateString } from '../../digest/digest-service';
import { plural, formatTime, technicianDisplayName, spokenList } from './spoken-format';

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
  jobRepo: Pick<JobRepository, 'findByIds'>;
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

function dayLabelForDateKey(dateKey: string): string {
  // UTC-anchored render of a bare calendar-date string — mirrors
  // lookup-materials.ts's formatNeededByLabel: never re-project a
  // resolved YYYY-MM-DD through a timezone a second time (that's exactly
  // how a midnight-UTC date rolls back a day in a western tenant zone).
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${dateKey}T00:00:00Z`));
}

/**
 * Resolve the calendar day being asked about via `resolveSpokenDay` (see
 * module doc comment, C1). An unparseable/absent phrase honestly defaults
 * to today.
 */
function resolveDayBoundary(
  desc: string | undefined,
  now: Date,
  timezone: string,
): { start: Date; end: Date; label: string } {
  const todayKey = localDateString(now, timezone);
  const resolvedKey = (desc ? resolveSpokenDay(desc, { timezone, now }) : null) ?? todayKey;
  const label = resolvedKey === todayKey ? 'today' : dayLabelForDateKey(resolvedKey);
  return { ...resolveDayWindow(resolvedKey, timezone), label };
}

/** A visible list, with a truncation count appended as just another list item ("and N more"). */
function spokenListWithTail(items: string[], totalCount: number): string {
  const rest = totalCount - items.length;
  return spokenList(rest > 0 ? [...items, `${rest} more`] : items);
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

    // Roster + today's appointments run in parallel — the appointment
    // read doesn't depend on the roster at all.
    const [roster, appointments] = await Promise.all([
      // Every tenant user, NOT filtered to role: 'technician' — see
      // module doc comment (MEDIUM). USER_ROLES has exactly three values
      // (owner/dispatcher/technician), so this IS "anyone assignable to
      // an appointment", the same set the entity resolver matches.
      deps.userRepo.findByTenant(input.tenantId),
      deps.appointmentRepo.findByDateRange(input.tenantId, day.start, day.end),
    ]);

    if (roster.length === 0) {
      const summary = "You don't have any crew members on the roster yet.";
      await record('none', 0, summary);
      return { status: 'none', summary, data: { dayLabel: day.label, freeTechnicians: [], bookings: [] } };
    }

    // Jobs resolved by id from TODAY's appointments only (C2) — never a
    // recency-ordered tenant-wide page.
    const jobIds = Array.from(new Set(appointments.map((a) => a.jobId)));
    const jobs = jobIds.length > 0 ? await deps.jobRepo.findByIds(input.tenantId, jobIds) : [];
    const jobById = new Map<string, Job>(jobs.map((j) => [j.id, j] as const));
    const techById = new Map<string, User>(roster.map((t) => [t.id, t] as const));

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
      if (!tech) continue; // not on the tenant roster (deleted/foreign) — not a crew booking
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
      const summary =
        `${name} has ${bookings.length} ${plural(bookings.length, 'booking')} ${day.label}: ` +
        `${spokenListWithTail(spoken, bookings.length)}.`;
      await record('found', bookings.length, summary);
      return { status: 'found', summary, data: { dayLabel: day.label, freeTechnicians: [], bookings } };
    }

    // No technician named — "who's free" for the WHOLE crew. This answers
    // a DIFFERENT question than the roster/techById above: "who can I
    // send?" — so it is additionally filtered to `canFieldServe`. An idle
    // office-only owner or dispatcher is correctly a "booking" NEVER (they
    // have no appointments to be busy with) but must not be reported
    // "free" either — they are not sendable to a job. Keep the full roster
    // for name resolution/techById; only the free list narrows further.
    const freeTechnicians = roster
      .filter((t) => t.canFieldServe && !busyTechnicianIds.has(t.id))
      .map((t) => technicianDisplayName(t));

    const summaryParts: string[] = [];
    if (freeTechnicians.length > 0) {
      const spoken = freeTechnicians.slice(0, MAX_SPOKEN_FREE);
      summaryParts.push(`Free ${day.label}: ${spokenListWithTail(spoken, freeTechnicians.length)}`);
    } else {
      summaryParts.push(`Nobody's free ${day.label} — the whole crew is booked`);
    }
    if (bookings.length > 0) {
      const spoken = bookings.slice(0, MAX_SPOKEN_BOOKINGS).map((b) => {
        const time = formatTime(b.scheduledStart, timezone);
        return `${b.technicianName} at ${time}${b.jobSummary ? ` — ${b.jobSummary}` : ''}`;
      });
      summaryParts.push(`Booked: ${spokenListWithTail(spoken, bookings.length)}`);
    }
    const summary = `${summaryParts.join('. ')}.`;
    // resultCount is the number of booking ROWS this lookup actually
    // surfaced — matches the lookup-skill family convention (e.g.
    // lookup-materials.ts) of counting rows fetched, not the roster size
    // (which contradicts "resultCount = rows fetched" and is a poor
    // signal of what the lookup actually found).
    await record('found', bookings.length, summary);
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
