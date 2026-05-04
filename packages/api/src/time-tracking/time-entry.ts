/**
 * P12-002 — Tech time tracking. Domain types + InMemory repository.
 *
 * The service layer (time-entry-service.ts) builds clockIn/clockOut/
 * weeklyHoursByUser on top of these primitives. Pg implementation lives
 * in pg-time-entry.ts.
 *
 * Decision: when a clock-in arrives while another entry is already open
 * for the same (tenant, user) we auto-close the prior entry and start a
 * new one. The Pg layer surfaces this via the partial UNIQUE index
 * `idx_time_entries_one_active_per_user` (Postgres error code 23505),
 * the InMemory layer catches it via an explicit findActive scan; the
 * service layer treats both the same way.
 */

export type EntryType = 'job' | 'drive' | 'break' | 'admin';

export interface TimeEntry {
  id: string;
  tenantId: string;
  userId: string;
  jobId?: string;
  entryType: EntryType;
  clockedInAt: Date;
  clockedOutAt?: Date;
  durationMinutes?: number;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTimeEntryInput {
  tenantId: string;
  userId: string;
  jobId?: string;
  entryType: EntryType;
  clockedInAt: Date;
  notes?: string;
}

export interface CloseTimeEntryInput {
  clockedOutAt: Date;
  notes?: string;
}

/**
 * Thrown by repositories when a clock-in collides with an already-open
 * entry for the same (tenant, user). The service layer catches this,
 * auto-closes the prior entry, and retries.
 */
export class ActiveEntryConflictError extends Error {
  constructor(public readonly userId: string) {
    super(`User ${userId} already has an active time entry`);
    this.name = 'ActiveEntryConflictError';
  }
}

/**
 * Thrown when computing duration for an entry whose clocked_out_at is
 * strictly before its clocked_in_at. The route translates this to a
 * 422.
 */
export class NegativeDurationError extends Error {
  constructor() {
    super('clockedOutAt must be greater than or equal to clockedInAt');
    this.name = 'NegativeDurationError';
  }
}

export interface TimeEntryListOptions {
  /** ISO date (YYYY-MM-DD) interpreted as the START of the week in `tz`. */
  weekStart?: Date;
  /** ISO date (YYYY-MM-DD) interpreted as the END (exclusive) of the window. */
  weekEnd?: Date;
  userId?: string;
  /** When set, returns only entries with `clocked_out_at IS NULL`. */
  activeOnly?: boolean;
  limit?: number;
}

export interface TimeEntryRepository {
  create(entry: TimeEntry): Promise<TimeEntry>;
  findById(tenantId: string, id: string): Promise<TimeEntry | null>;
  findActiveByUser(tenantId: string, userId: string): Promise<TimeEntry | null>;
  findByTenant(tenantId: string, options?: TimeEntryListOptions): Promise<TimeEntry[]>;
  /**
   * Closes an entry by id. Returns the updated row or null if no row
   * with that id exists in the tenant. Idempotent: a closed entry is
   * returned unchanged when called twice.
   */
  close(
    tenantId: string,
    id: string,
    update: { clockedOutAt: Date; durationMinutes: number; notes?: string }
  ): Promise<TimeEntry | null>;
}

export function computeDurationMinutes(clockedInAt: Date, clockedOutAt: Date): number {
  const ms = clockedOutAt.getTime() - clockedInAt.getTime();
  if (ms < 0) {
    throw new NegativeDurationError();
  }
  // Round to nearest minute. A 30-second sliver still rounds down
  // because we want predictable rollups, not generous ones.
  return Math.floor(ms / 60_000);
}

export class InMemoryTimeEntryRepository implements TimeEntryRepository {
  private rows: Map<string, TimeEntry> = new Map();

  async create(entry: TimeEntry): Promise<TimeEntry> {
    // Mirror the Pg partial UNIQUE constraint: one open entry per user.
    if (!entry.clockedOutAt) {
      const existing = await this.findActiveByUser(entry.tenantId, entry.userId);
      if (existing) {
        throw new ActiveEntryConflictError(entry.userId);
      }
    }
    this.rows.set(entry.id, { ...entry });
    return { ...entry };
  }

  async findById(tenantId: string, id: string): Promise<TimeEntry | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    return { ...r };
  }

  async findActiveByUser(tenantId: string, userId: string): Promise<TimeEntry | null> {
    for (const r of this.rows.values()) {
      if (r.tenantId === tenantId && r.userId === userId && !r.clockedOutAt) {
        return { ...r };
      }
    }
    return null;
  }

  async findByTenant(
    tenantId: string,
    options?: TimeEntryListOptions
  ): Promise<TimeEntry[]> {
    let results = Array.from(this.rows.values()).filter((r) => r.tenantId === tenantId);
    if (options?.userId) {
      results = results.filter((r) => r.userId === options.userId);
    }
    if (options?.activeOnly) {
      results = results.filter((r) => !r.clockedOutAt);
    }
    if (options?.weekStart) {
      const start = options.weekStart.getTime();
      results = results.filter((r) => r.clockedInAt.getTime() >= start);
    }
    if (options?.weekEnd) {
      const end = options.weekEnd.getTime();
      results = results.filter((r) => r.clockedInAt.getTime() < end);
    }
    results.sort((a, b) => b.clockedInAt.getTime() - a.clockedInAt.getTime());
    if (options?.limit !== undefined) {
      results = results.slice(0, options.limit);
    }
    return results.map((r) => ({ ...r }));
  }

  async close(
    tenantId: string,
    id: string,
    update: { clockedOutAt: Date; durationMinutes: number; notes?: string }
  ): Promise<TimeEntry | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    // Idempotent: if already closed, return as-is. The service layer
    // checks for this before computing a fresh duration so we never
    // overwrite a previously persisted close timestamp.
    if (r.clockedOutAt) return { ...r };
    const updated: TimeEntry = {
      ...r,
      clockedOutAt: update.clockedOutAt,
      durationMinutes: update.durationMinutes,
      notes: update.notes ?? r.notes,
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return { ...updated };
  }

  /** Test helper. */
  getAll(): TimeEntry[] {
    return Array.from(this.rows.values()).map((r) => ({ ...r }));
  }
}
