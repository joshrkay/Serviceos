import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  ActiveEntryConflictError,
  EntryType,
  TimeEntry,
  TimeEntryRepository,
  computeDurationMinutes,
} from './time-entry';

/**
 * P12-002 — Time-tracking service.
 *
 * `clockIn` always closes a prior open entry for the same user before
 * opening a new one (transactional via close-then-create at the repo
 * boundary; the partial UNIQUE index is the safety net). `clockOut` is
 * idempotent — calling twice returns the closed entry.
 *
 * Weekly rollup math (`weeklyHoursByUser`): we sum durations against a
 * UTC window (weekStart .. weekStart+7d) so DST transitions are honest.
 * Per-day buckets are assigned to the date the entry CLOCKED IN — a
 * cross-day shift counts entirely on the start day. This is the
 * documented decision (see secondary-path #15) so payroll is reproducible.
 */

export interface ClockInOpts {
  jobId?: string;
  entryType: EntryType;
  notes?: string;
  /** Override the clock-in timestamp (rare — defaults to `new Date()`). */
  clockedInAt?: Date;
  actorRole?: string;
}

export interface ClockOutOpts {
  notes?: string;
  /** Override the clock-out timestamp (rare — defaults to `new Date()`). */
  clockedOutAt?: Date;
  actorRole?: string;
}

export interface DailyBucket {
  /** ISO date string YYYY-MM-DD in the tenant's tz. */
  date: string;
  hours: number;
}

export interface WeeklyHours {
  userId: string;
  /** ISO date string YYYY-MM-DD — Monday in tenant tz. */
  weekStart: string;
  byDay: DailyBucket[];
  totalHours: number;
}

/**
 * Format a Date as YYYY-MM-DD in the supplied IANA tz. Uses Intl
 * because Node ships full ICU; falls back to UTC if `tz` is invalid
 * (rather than crashing the rollup).
 */
function formatDateInTz(d: Date, tz: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // en-CA renders YYYY-MM-DD with leading zeros, no separators issue.
    return fmt.format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export class TimeEntryService {
  constructor(
    private readonly repo: TimeEntryRepository,
    private readonly auditRepo?: AuditRepository
  ) {}

  async findActiveEntry(tenantId: string, userId: string): Promise<TimeEntry | null> {
    return this.repo.findActiveByUser(tenantId, userId);
  }

  /**
   * Open a new time entry. If the user already has an open entry, it is
   * auto-closed first (using the prior entry's clockedInAt + new clockedInAt
   * to compute duration). This keeps the partial UNIQUE index happy AND
   * means a tech who taps "Clock In" twice never ends up with overlapping
   * timesheets.
   */
  async clockIn(
    tenantId: string,
    userId: string,
    opts: ClockInOpts
  ): Promise<TimeEntry> {
    const clockedInAt = opts.clockedInAt ?? new Date();

    // Pre-emptive close. Catching the conflict at create-time would also
    // work, but we'd lose the actual close timestamp — using the new
    // clock-in moment as the previous entry's close gives an honest
    // continuous timeline.
    const active = await this.repo.findActiveByUser(tenantId, userId);
    if (active) {
      await this.closeEntry(tenantId, active, clockedInAt, undefined, 'auto-closed');
    }

    const now = new Date();
    const entry: TimeEntry = {
      id: uuidv4(),
      tenantId,
      userId,
      jobId: opts.jobId,
      entryType: opts.entryType,
      clockedInAt,
      notes: opts.notes,
      createdAt: now,
      updatedAt: now,
    };

    let created: TimeEntry;
    try {
      created = await this.repo.create(entry);
    } catch (err) {
      // Race: another request snuck in between findActiveByUser and create.
      // Try once more after re-closing whatever's open.
      if (err instanceof ActiveEntryConflictError) {
        const stillActive = await this.repo.findActiveByUser(tenantId, userId);
        if (stillActive) {
          await this.closeEntry(tenantId, stillActive, clockedInAt, undefined, 'auto-closed-retry');
        }
        created = await this.repo.create(entry);
      } else {
        throw err;
      }
    }

    if (this.auditRepo) {
      await this.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: userId,
          actorRole: opts.actorRole ?? 'unknown',
          eventType: 'time_entry.clocked_in',
          entityType: 'time_entry',
          entityId: created.id,
          metadata: {
            jobId: created.jobId,
            entryType: created.entryType,
          },
        })
      );
    }

    return created;
  }

  /**
   * Close the active entry for this user. Returns null when there is no
   * active entry. Idempotent on a re-close of the SAME entry id (route
   * layer can pass id explicitly via findById path; the lookup here is
   * by user since the standard mobile UX is "close my current shift").
   */
  async clockOut(
    tenantId: string,
    userId: string,
    opts: ClockOutOpts = {}
  ): Promise<TimeEntry | null> {
    const active = await this.repo.findActiveByUser(tenantId, userId);
    if (!active) return null;
    const clockedOutAt = opts.clockedOutAt ?? new Date();
    const closed = await this.closeEntry(
      tenantId,
      active,
      clockedOutAt,
      opts.notes,
      'manual'
    );

    if (closed && this.auditRepo) {
      await this.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: userId,
          actorRole: opts.actorRole ?? 'unknown',
          eventType: 'time_entry.clocked_out',
          entityType: 'time_entry',
          entityId: closed.id,
          metadata: {
            jobId: closed.jobId,
            durationMinutes: closed.durationMinutes,
            longShift: (closed.durationMinutes ?? 0) > 24 * 60,
          },
        })
      );
    }

    return closed;
  }

  private async closeEntry(
    tenantId: string,
    entry: TimeEntry,
    clockedOutAt: Date,
    notes: string | undefined,
    _reason: string
  ): Promise<TimeEntry | null> {
    // computeDurationMinutes throws NegativeDurationError on inverted ranges.
    // The route catches it and emits a 422.
    const durationMinutes = computeDurationMinutes(entry.clockedInAt, clockedOutAt);
    return this.repo.close(tenantId, entry.id, {
      clockedOutAt,
      durationMinutes,
      notes,
    });
  }

  /**
   * Sum hours per (userId, day-in-tenant-tz) for the week starting at
   * `weekStart`. `weekStart` is interpreted as the start of the Monday
   * in `tz`; we always ask the repo for entries whose clocked_in_at
   * falls in [weekStart, weekStart+7d). Open entries (clocked_out_at
   * IS NULL) are skipped — they have no duration yet.
   */
  async weeklyHoursByUser(
    tenantId: string,
    weekStart: Date,
    tz: string
  ): Promise<WeeklyHours[]> {
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const entries = await this.repo.findByTenant(tenantId, {
      weekStart,
      weekEnd,
    });

    // Pre-bucket by user.
    const byUser: Map<string, TimeEntry[]> = new Map();
    for (const e of entries) {
      if (!byUser.has(e.userId)) byUser.set(e.userId, []);
      byUser.get(e.userId)!.push(e);
    }

    const weekStartIso = formatDateInTz(weekStart, tz);
    const result: WeeklyHours[] = [];
    for (const [userId, userEntries] of byUser.entries()) {
      const dayMap: Map<string, number> = new Map(); // date → minutes
      let totalMinutes = 0;
      for (const e of userEntries) {
        if (e.durationMinutes === undefined || e.durationMinutes === null) continue;
        const date = formatDateInTz(e.clockedInAt, tz);
        dayMap.set(date, (dayMap.get(date) ?? 0) + e.durationMinutes);
        totalMinutes += e.durationMinutes;
      }
      const byDay: DailyBucket[] = Array.from(dayMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, minutes]) => ({
          date,
          // 2 decimal places — payroll precision is the minute, but
          // hours are friendlier to render. Round half-up.
          hours: Math.round((minutes / 60) * 100) / 100,
        }));
      result.push({
        userId,
        weekStart: weekStartIso,
        byDay,
        totalHours: Math.round((totalMinutes / 60) * 100) / 100,
      });
    }

    // Empty week: still return an empty structure for the requester so
    // the UI doesn't have to special-case "no entries".
    return result;
  }
}
