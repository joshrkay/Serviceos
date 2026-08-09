/**
 * Task 10 (2026-08-07 tradesperson plan) — `lookupTimesheets` skill tests.
 *
 * Owner asks logged hours per crew member for the current tenant-local
 * week (Monday-Sunday; no other period is advertised — see the skill's
 * module doc comment). Reuses `TimeEntryService.weeklyHoursByUser`
 * (time-tracking/time-entry-service.ts) — the SAME aggregation
 * `/api/time-entries?weekOf=` uses — rather than re-implementing rollup
 * math. Covers: found/none/error, record() on all three, named-technician
 * scoping (incl. an honest zero when they logged nothing), and the
 * unresolved-name refusal is exercised at the router level (see
 * test/workers/voice-action-router.test.ts) — this file only covers the
 * skill's own resolved-technicianId contract.
 */
import { describe, it, expect, vi } from 'vitest';
import { lookupTimesheets } from '../../../src/ai/skills/lookup-timesheets';
import { InMemoryTimeEntryRepository } from '../../../src/time-tracking/time-entry';
import type { TimeEntry } from '../../../src/time-tracking/time-entry';
import { InMemoryUserRepository } from '../../../src/users/user';
import type { LookupEventService } from '../../../src/lookup-events/lookup-event-service';

const TENANT = 'tenant-1';
const TZ = 'America/New_York';
// Thursday 2026-06-11 ~07:00 New York (11:00 UTC). Tenant-local week is
// Mon 2026-06-08 .. Mon 2026-06-15 (exclusive).
const NOW = new Date('2026-06-11T11:00:00.000Z');

function eventsSpy(): LookupEventService {
  return { record: vi.fn(async () => ({}) as never) } as unknown as LookupEventService;
}

function makeEntry(over: Partial<TimeEntry> & { userId: string }): TimeEntry {
  const clockedInAt = over.clockedInAt ?? new Date('2026-06-09T14:00:00.000Z'); // Tue 10am NY
  const durationMinutes = over.durationMinutes ?? 480;
  return {
    id: `te-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: TENANT,
    entryType: 'job',
    clockedInAt,
    clockedOutAt: new Date(clockedInAt.getTime() + durationMinutes * 60_000),
    durationMinutes,
    createdAt: clockedInAt,
    updatedAt: clockedInAt,
    ...over,
  };
}

interface FixtureOpts {
  entries?: TimeEntry[];
  technicians?: Array<{ id: string; firstName: string; lastName: string }>;
}

async function fixtures(opts: FixtureOpts = {}) {
  const timeEntryRepo = new InMemoryTimeEntryRepository();
  const userRepo = new InMemoryUserRepository();
  for (const e of opts.entries ?? []) await timeEntryRepo.create(e);
  for (const t of opts.technicians ?? []) {
    await userRepo.create({
      id: t.id,
      tenantId: TENANT,
      email: `${t.id}@example.com`,
      role: 'technician',
      firstName: t.firstName,
      lastName: t.lastName,
      canFieldServe: true,
    });
  }
  return { timeEntryRepo, userRepo };
}

describe('lookupTimesheets skill', () => {
  // I6 — record('found', ...) coverage (only 'none'/'error' were previously exercised).
  it('records the lookup event on the found branch', async () => {
    const deps = await fixtures({
      entries: [makeEntry({ userId: 'tech-mike', durationMinutes: 480 })],
      technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }],
    });
    const lookupEvents = eventsSpy();

    await lookupTimesheets({ tenantId: TENANT, timezone: TZ, now: NOW }, { ...deps, lookupEvents });

    expect(lookupEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, intent: 'lookup_timesheets', resultStatus: 'found', resultCount: 1 }),
    );
  });

  it('reports hours logged per crew member this week when no technician is named', async () => {
    const deps = await fixtures({
      entries: [
        makeEntry({ userId: 'tech-mike', durationMinutes: 480 }), // 8h
        makeEntry({ userId: 'tech-carlos', durationMinutes: 240 }), // 4h
      ],
      technicians: [
        { id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' },
        { id: 'tech-carlos', firstName: 'Carlos', lastName: 'Ruiz' },
      ],
    });

    const res = await lookupTimesheets({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.entries).toEqual(
      expect.arrayContaining([
        { userId: 'tech-mike', name: 'Mike Diaz', totalHours: 8 },
        { userId: 'tech-carlos', name: 'Carlos Ruiz', totalHours: 4 },
      ]),
    );
    expect(res.summary).toContain('Mike Diaz');
    expect(res.summary).toContain('8 hours');
    expect(res.summary).toContain('Carlos Ruiz');
    expect(res.summary).toContain('4 hours');
  });

  it('excludes entries outside the current tenant-local week', async () => {
    const deps = await fixtures({
      entries: [
        makeEntry({ userId: 'tech-mike', durationMinutes: 480 }), // this week
        makeEntry({
          userId: 'tech-mike',
          clockedInAt: new Date('2026-06-01T14:00:00.000Z'), // last week
          durationMinutes: 600,
        }),
      ],
      technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }],
    });

    const res = await lookupTimesheets({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.entries).toEqual([{ userId: 'tech-mike', name: 'Mike Diaz', totalHours: 8 }]);
  });

  it('scopes to ONE technician when technicianId is resolved — never the whole crew', async () => {
    const deps = await fixtures({
      entries: [
        makeEntry({ userId: 'tech-mike', durationMinutes: 480 }),
        makeEntry({ userId: 'tech-carlos', durationMinutes: 240 }),
      ],
      technicians: [
        { id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' },
        { id: 'tech-carlos', firstName: 'Carlos', lastName: 'Ruiz' },
      ],
    });

    const res = await lookupTimesheets(
      { tenantId: TENANT, timezone: TZ, now: NOW, technicianId: 'tech-carlos' },
      deps,
    );

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.entries).toEqual([{ userId: 'tech-carlos', name: 'Carlos Ruiz', totalHours: 4 }]);
    expect(res.summary).toContain('Carlos Ruiz');
    expect(res.summary).not.toContain('Mike Diaz');
  });

  it('a named technician with zero hours this week reports an honest zero, not "none"', async () => {
    const deps = await fixtures({
      entries: [makeEntry({ userId: 'tech-mike', durationMinutes: 480 })],
      technicians: [
        { id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' },
        { id: 'tech-carlos', firstName: 'Carlos', lastName: 'Ruiz' },
      ],
    });

    const res = await lookupTimesheets(
      { tenantId: TENANT, timezone: TZ, now: NOW, technicianId: 'tech-carlos' },
      deps,
    );

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.entries).toEqual([{ userId: 'tech-carlos', name: 'Carlos Ruiz', totalHours: 0 }]);
    // Quality-review I6 — pin the EXACT string this module's own doc
    // comment argues for ("hasn't logged", never "0 hours") rather than a
    // loose regex that would also accept the phrasing the doc rejects.
    expect(res.summary).toBe("Carlos Ruiz hasn't logged any hours this week.");
  });

  it('reports status "none" and records the event when nobody logged any hours this week', async () => {
    const deps = await fixtures({ technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }] });
    const lookupEvents = eventsSpy();

    const res = await lookupTimesheets({ tenantId: TENANT, timezone: TZ, now: NOW }, { ...deps, lookupEvents });

    expect(res.status).toBe('none');
    expect(lookupEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, intent: 'lookup_timesheets', resultStatus: 'none', resultCount: 0 }),
    );
  });

  it('is tenant-scoped', async () => {
    const deps = await fixtures();
    await deps.timeEntryRepo.create(
      makeEntry({ userId: 'tech-foreign', tenantId: 'tenant-other', durationMinutes: 480 }),
    );

    const res = await lookupTimesheets({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('none');
  });

  it('truncates the spoken list with an EXACT "and N more crew members" tail (pinned count)', async () => {
    const technicians = Array.from({ length: 8 }, (_, i) => ({
      id: `tech-${i}`,
      firstName: `Tech${i}`,
      lastName: 'Person',
    }));
    const entries = technicians.map((t, i) => makeEntry({ userId: t.id, durationMinutes: 60 * (i + 1) }));
    const deps = await fixtures({ entries, technicians });

    const res = await lookupTimesheets({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.entries).toHaveLength(8);
    // MAX_SPOKEN_ENTRIES is 6 — exactly 2 must be left over.
    expect(res.summary).toContain('and 2 more crew members');
  });

  // Quality-review I3 — an uncapped list reads with a natural "and", not
  // bare commas/semicolons ("Mike Diaz: 8 hours and Carlos Ruiz: 4 hours").
  it('an uncapped whole-crew list joins with "and", not a bare separator', async () => {
    const deps = await fixtures({
      entries: [
        makeEntry({ userId: 'tech-mike', durationMinutes: 480 }),
        makeEntry({ userId: 'tech-carlos', durationMinutes: 240 }),
      ],
      technicians: [
        { id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' },
        { id: 'tech-carlos', firstName: 'Carlos', lastName: 'Ruiz' },
      ],
    });

    const res = await lookupTimesheets({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.summary).toContain('Mike Diaz: 8 hours and Carlos Ruiz: 4 hours');
  });

  describe('error path', () => {
    it('reports status "error" with an honest error message, never throwing', async () => {
      const deps = await fixtures({ technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }] });
      deps.timeEntryRepo.findByTenant = async () => {
        throw new Error('connection reset');
      };

      const res = await lookupTimesheets({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

      expect(res.status).toBe('error');
      if (res.status !== 'error') throw new Error('unreachable');
      expect(res.data.error).toBe('connection reset');
      expect(res.summary).toMatch(/trouble/i);
    });

    it('records the lookup event on the error branch', async () => {
      const deps = await fixtures({ technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }] });
      deps.timeEntryRepo.findByTenant = async () => {
        throw new Error('db down');
      };
      const lookupEvents = eventsSpy();

      await lookupTimesheets({ tenantId: TENANT, timezone: TZ, now: NOW }, { ...deps, lookupEvents });

      expect(lookupEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, intent: 'lookup_timesheets', resultStatus: 'error', resultCount: 0 }),
      );
    });

    it('a lookupEvents.record failure never breaks the caller-facing result', async () => {
      const deps = await fixtures({
        entries: [makeEntry({ userId: 'tech-mike', durationMinutes: 480 })],
        technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }],
      });
      const failingEvents = {
        record: vi.fn(async () => {
          throw new Error('audit write failed');
        }),
      } as unknown as LookupEventService;

      const res = await lookupTimesheets(
        { tenantId: TENANT, timezone: TZ, now: NOW },
        { ...deps, lookupEvents: failingEvents },
      );

      expect(res.status).toBe('found');
    });
  });
});
