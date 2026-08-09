/**
 * Task 10 (2026-08-07 tradesperson plan) — `lookup_timesheets` voice skill.
 *
 * Owner asks logged hours per crew member for the CURRENT tenant-local
 * calendar week (Monday .. next Monday exclusive). Owner-extended
 * (`OWNER_EXTENDED_LOOKUP_INTENT_TYPES`) + permission-gated
 * (`reports:view`, `LOOKUP_REQUIRED_PERMISSION`) — mirrors
 * `lookup_day_overview`'s gating posture exactly.
 *
 * Tenant-scoped, read-only. A named technician who did not resolve to a
 * verified `technicianId` is refused by the CALLER
 * (workers/voice-lookup-answer.ts's `lookup_timesheets` case) BEFORE this
 * skill ever runs — same posture, and same rationale, as
 * `lookup_crew_schedule`'s identical guard (an unresolved *person* must
 * never silently widen to everyone's hours).
 *
 * ── "This week" is not a filter you can widen — a scope decision ────────
 *
 * Only the CURRENT tenant-local week is supported; the taxonomy
 * (intent-classifier.ts) only advertises "this week" phrasing ("How many
 * hours did Carlos log this week?", "Give me everyone's hours for the
 * week") for exactly that reason — mirrors `lookup_materials`'s "for
 * tomorrow is not a filter" precedent (that skill's module doc comment).
 * A genuine "last week" / arbitrary-period query is a real but separate
 * extension, not done here.
 *
 * ── Reuses the existing weekly rollup, never re-implements it ───────────
 *
 * `TimeEntryService.weeklyHoursByUser` (time-tracking/time-entry-
 * service.ts) is the SAME aggregation `GET /api/time-entries?weekOf=`
 * already uses (routes/time-entries.ts) — this skill only computes the
 * tenant-local Monday `weekStart` (DST-safe, via `tzMidnight`/
 * `addCalendarDays`, shared/timezone.ts) and resolves technician display
 * names, exactly like `lookup-day-overview.ts` does for appointments.
 *
 * A named technician with a real logged week of ZERO hours is reported
 * honestly as "0 hours" (mirrors `routes/time-entries.ts`'s own synthetic
 * zero-row fallback for a `weekOf` query with no matching entries) rather
 * than the generic "none" — a real crew member's real week, even an empty
 * one, is a `found` answer; "none" is reserved for "the whole crew logged
 * nothing this week" (nobody asked about, nothing to report).
 *
 * ── Bounded fetch ─────────────────────────────────────────────────────
 *
 * `weeklyHoursByUser` fetches only entries within the resolved week
 * window — inherently bounded by one tenant's one week of real clock
 * activity (never a tenant-wide history scan), the same bound
 * `lookup-day-overview.ts` accepts for a day's appointments.
 */
import { TimeEntryService, type WeeklyHours } from '../../time-tracking/time-entry-service';
import type { TimeEntryRepository } from '../../time-tracking/time-entry';
import type { User, UserRepository } from '../../users/user';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';
import { tzMidnight, addCalendarDays, localDateKey } from '../../shared/timezone';
import { plural } from './spoken-format';

export interface LookupTimesheetsInput {
  tenantId: string;
  sessionId?: string;
  /** Verified technicianId, when a crew member was named and resolved. */
  technicianId?: string;
  timezone?: string;
  now?: Date;
}

export interface LookupTimesheetsDeps {
  timeEntryRepo: TimeEntryRepository;
  userRepo: Pick<UserRepository, 'findByTenant'>;
  lookupEvents?: LookupEventService;
}

export interface TimesheetEntry {
  userId: string;
  name: string;
  totalHours: number;
}

export type LookupTimesheetsResult =
  | {
      status: 'found' | 'none';
      summary: string;
      data: { weekStart: string; entries: TimesheetEntry[] };
    }
  | { status: 'error'; summary: string; data: { error: string } };

const DEFAULT_TIMEZONE = 'America/New_York';
/** Spoken cap — a large crew must not become a name-reading marathon. */
const MAX_SPOKEN_ENTRIES = 6;

function technicianDisplayName(u: Pick<User, 'firstName' | 'lastName' | 'email'>): string {
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
}

/**
 * The Monday-midnight (tenant-local) instant of the calendar week
 * containing `now`. DST-safe — mirrors `addCalendarDays`'s own contract
 * (shared/timezone.ts).
 */
function resolveWeekStart(now: Date, timezone: string): Date {
  const todayKey = localDateKey(now, timezone);
  const todayMidnight = tzMidnight(todayKey, timezone);
  const [y, m, d] = todayKey.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7; // Mon=0 .. Sun=6
  return daysSinceMonday === 0 ? todayMidnight : addCalendarDays(todayMidnight, -daysSinceMonday, timezone);
}

/** "8 hours", "1 hour", "4.5 hours" — mirrors lookup-job-profit.ts's formatHours. */
function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${rounded === 1 ? 'hour' : 'hours'}`;
}

export async function lookupTimesheets(
  input: LookupTimesheetsInput,
  deps: LookupTimesheetsDeps,
): Promise<LookupTimesheetsResult> {
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
        intent: 'lookup_timesheets',
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
    const weekStart = resolveWeekStart(now, timezone);
    const service = new TimeEntryService(deps.timeEntryRepo);
    const rollups: WeeklyHours[] = await service.weeklyHoursByUser(input.tenantId, weekStart, timezone);
    const weekStartLabel = rollups[0]?.weekStart ?? localDateKey(weekStart, timezone);

    const named = input.technicianId;
    const matching = named ? rollups.filter((r) => r.userId === named) : rollups;

    if (!named && matching.length === 0) {
      const summary = 'Nobody logged any hours this week.';
      await record('none', 0, summary);
      return { status: 'none', summary, data: { weekStart: weekStartLabel, entries: [] } };
    }

    // Technician display names — decorative; a repo hiccup never fails the
    // answer (mirrors lookup-day-overview.ts's userNameById try/catch).
    let nameById = new Map<string, string>();
    try {
      const users = await deps.userRepo.findByTenant(input.tenantId);
      nameById = new Map(users.map((u) => [u.id, technicianDisplayName(u)] as const));
    } catch {
      /* names are decorative — never fail the timesheet over them */
    }

    // A named technician with zero hours this week is a real, honest
    // answer (routes/time-entries.ts's own synthetic zero-row precedent),
    // not "none" — never fabricated, never silently dropped.
    const rows: WeeklyHours[] =
      named && matching.length === 0 ? [{ userId: named, weekStart: weekStartLabel, byDay: [], totalHours: 0 }] : matching;

    const entries: TimesheetEntry[] = rows
      .map((r) => ({
        userId: r.userId,
        name: nameById.get(r.userId) ?? 'a crew member',
        totalHours: r.totalHours,
      }))
      .sort((a, b) => b.totalHours - a.totalHours);

    let summary: string;
    if (named) {
      const entry = entries[0];
      summary =
        entry.totalHours > 0
          ? `${entry.name} logged ${formatHours(entry.totalHours)} this week.`
          : `${entry.name} hasn't logged any hours this week.`;
    } else {
      const spoken = entries.slice(0, MAX_SPOKEN_ENTRIES).map((e) => `${e.name}: ${formatHours(e.totalHours)}`);
      const rest = entries.length - spoken.length;
      summary =
        `Hours logged this week — ${spoken.join('; ')}` + (rest > 0 ? `; and ${rest} more ${plural(rest, 'crew member')}` : '') + '.';
    }

    await record('found', entries.length, summary);
    return { status: 'found', summary, data: { weekStart: weekStartLabel, entries } };
  } catch (err) {
    const summary = "I'm having trouble pulling up timesheets right now.";
    await record('error', 0, summary);
    return {
      status: 'error',
      summary,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
