import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryTimeEntryRepository } from '../../src/time-tracking/time-entry';
import { TimeEntryService } from '../../src/time-tracking/time-entry-service';

describe('P12-002 — TimeEntryService (clock-in/out + weekly rollup)', () => {
  let repo: InMemoryTimeEntryRepository;
  let auditRepo: InMemoryAuditRepository;
  let service: TimeEntryService;

  beforeEach(() => {
    repo = new InMemoryTimeEntryRepository();
    auditRepo = new InMemoryAuditRepository();
    service = new TimeEntryService(repo, auditRepo);
  });

  it('time-entry clockIn — happy path creates an open entry', async () => {
    const e = await service.clockIn('tenant-1', 'user-1', {
      jobId: '11111111-1111-1111-1111-111111111111',
      entryType: 'job',
      clockedInAt: new Date('2026-05-04T15:00:00Z'),
    });
    expect(e.clockedOutAt).toBeUndefined();
    expect(e.entryType).toBe('job');
    const active = await service.findActiveEntry('tenant-1', 'user-1');
    expect(active?.id).toBe(e.id);
  });

  it('time-entry clockIn — auto-closes prior open entry', async () => {
    await service.clockIn('tenant-1', 'user-1', {
      entryType: 'drive',
      clockedInAt: new Date('2026-05-04T14:00:00Z'),
    });
    const second = await service.clockIn('tenant-1', 'user-1', {
      entryType: 'job',
      clockedInAt: new Date('2026-05-04T15:00:00Z'),
    });
    const all = repo.getAll();
    const closed = all.find((r) => r.id !== second.id);
    expect(closed?.clockedOutAt).toBeInstanceOf(Date);
    expect(closed?.durationMinutes).toBe(60);
    expect(second.clockedOutAt).toBeUndefined();
  });

  it('time-entry clockOut — closes active entry + computes duration', async () => {
    await service.clockIn('tenant-1', 'user-1', {
      entryType: 'job',
      clockedInAt: new Date('2026-05-04T15:00:00Z'),
    });
    const closed = await service.clockOut('tenant-1', 'user-1', {
      clockedOutAt: new Date('2026-05-04T17:30:00Z'),
    });
    expect(closed?.durationMinutes).toBe(150);
  });

  it('time-entry clockOut — returns null when nothing active', async () => {
    const result = await service.clockOut('tenant-1', 'user-1');
    expect(result).toBeNull();
  });

  it('time-entry clockOut — idempotent on second call', async () => {
    await service.clockIn('tenant-1', 'user-1', {
      entryType: 'job',
      clockedInAt: new Date('2026-05-04T15:00:00Z'),
    });
    const first = await service.clockOut('tenant-1', 'user-1', {
      clockedOutAt: new Date('2026-05-04T16:00:00Z'),
    });
    const second = await service.clockOut('tenant-1', 'user-1');
    // After first close there is no active entry → second call returns null.
    expect(first?.durationMinutes).toBe(60);
    expect(second).toBeNull();
  });

  it('time-entry — long shift (>24h) still closes honestly', async () => {
    await service.clockIn('tenant-1', 'user-1', {
      entryType: 'admin',
      clockedInAt: new Date('2026-05-01T10:00:00Z'),
    });
    const closed = await service.clockOut('tenant-1', 'user-1', {
      clockedOutAt: new Date('2026-05-02T15:00:00Z'),
    });
    // 29 hours
    expect(closed?.durationMinutes).toBe(29 * 60);
    const audits = auditRepo.getAll();
    const out = audits.find((a) => a.eventType === 'time_entry.clocked_out');
    expect(out?.metadata?.longShift).toBe(true);
  });

  it('time-entry clockOut — rejects negative duration (out before in)', async () => {
    await service.clockIn('tenant-1', 'user-1', {
      entryType: 'job',
      clockedInAt: new Date('2026-05-04T15:00:00Z'),
    });
    await expect(
      service.clockOut('tenant-1', 'user-1', {
        clockedOutAt: new Date('2026-05-04T14:00:00Z'),
      })
    ).rejects.toThrow(/clockedOutAt/);
  });

  it('time-tracking — tenant isolation: clockIn in A, query from B sees nothing', async () => {
    await service.clockIn('tenant-A', 'user-1', {
      entryType: 'job',
      clockedInAt: new Date('2026-05-04T15:00:00Z'),
    });
    const fromB = await service.findActiveEntry('tenant-B', 'user-1');
    expect(fromB).toBeNull();
  });

  it('time-tracking — audit row written on clockIn AND clockOut', async () => {
    await service.clockIn('tenant-1', 'user-1', {
      entryType: 'job',
      clockedInAt: new Date('2026-05-04T15:00:00Z'),
      actorRole: 'technician',
    });
    await service.clockOut('tenant-1', 'user-1', {
      clockedOutAt: new Date('2026-05-04T16:30:00Z'),
      actorRole: 'technician',
    });
    const events = auditRepo.getAll();
    expect(events.find((e) => e.eventType === 'time_entry.clocked_in')).toBeTruthy();
    const out = events.find((e) => e.eventType === 'time_entry.clocked_out');
    expect(out?.metadata?.durationMinutes).toBe(90);
  });

  it('time-tracking weeklyHoursByUser — sums per day, totals correct', async () => {
    // Mon 2026-05-04 in UTC.
    const weekStart = new Date('2026-05-04T00:00:00Z');
    // Mon 2h
    await service.clockIn('tenant-1', 'user-1', {
      entryType: 'job',
      clockedInAt: new Date('2026-05-04T15:00:00Z'),
    });
    await service.clockOut('tenant-1', 'user-1', {
      clockedOutAt: new Date('2026-05-04T17:00:00Z'),
    });
    // Wed 1.5h
    await service.clockIn('tenant-1', 'user-1', {
      entryType: 'drive',
      clockedInAt: new Date('2026-05-06T14:00:00Z'),
    });
    await service.clockOut('tenant-1', 'user-1', {
      clockedOutAt: new Date('2026-05-06T15:30:00Z'),
    });

    const rollups = await service.weeklyHoursByUser('tenant-1', weekStart, 'UTC');
    expect(rollups).toHaveLength(1);
    expect(rollups[0].userId).toBe('user-1');
    expect(rollups[0].totalHours).toBe(3.5);
    const monday = rollups[0].byDay.find((d) => d.date === '2026-05-04');
    expect(monday?.hours).toBe(2);
    const wed = rollups[0].byDay.find((d) => d.date === '2026-05-06');
    expect(wed?.hours).toBe(1.5);
  });

  it('time-tracking weeklyHoursByUser — empty week returns []', async () => {
    const rollups = await service.weeklyHoursByUser(
      'tenant-1',
      new Date('2026-05-04T00:00:00Z'),
      'UTC'
    );
    expect(rollups).toEqual([]);
  });

  it('time-tracking weeklyHoursByUser — cross-day shift assigned to clock-in date', async () => {
    // Clocks in 23:00 Monday (UTC), clocks out 07:00 Tuesday → 8h.
    await service.clockIn('tenant-1', 'user-1', {
      entryType: 'job',
      clockedInAt: new Date('2026-05-04T23:00:00Z'),
    });
    await service.clockOut('tenant-1', 'user-1', {
      clockedOutAt: new Date('2026-05-05T07:00:00Z'),
    });
    const rollups = await service.weeklyHoursByUser(
      'tenant-1',
      new Date('2026-05-04T00:00:00Z'),
      'UTC'
    );
    expect(rollups[0].byDay).toEqual([{ date: '2026-05-04', hours: 8 }]);
    expect(rollups[0].totalHours).toBe(8);
  });

  it('time-tracking weeklyHoursByUser — open entries are excluded from rollup', async () => {
    await service.clockIn('tenant-1', 'user-1', {
      entryType: 'job',
      clockedInAt: new Date('2026-05-04T15:00:00Z'),
    });
    const rollups = await service.weeklyHoursByUser(
      'tenant-1',
      new Date('2026-05-04T00:00:00Z'),
      'UTC'
    );
    // Open entry shows up in the per-user list but contributes 0 hours.
    expect(rollups).toHaveLength(1);
    expect(rollups[0].byDay).toEqual([]);
    expect(rollups[0].totalHours).toBe(0);
  });

  it('time-tracking weeklyHoursByUser — DST week (LA spring-forward) totals are honest', async () => {
    // Spring forward in America/Los_Angeles 2026-03-08 02:00 → 03:00.
    // Sunday 23:00Z is 16:00 PT same day; Monday 06:00Z is 23:00 PT Sunday.
    // Clock-in 2026-03-08 13:00Z → 06:00 PT Sunday. Clock-out 21:00Z →
    // 14:00 PT Sunday. Across spring-forward boundary the wall-clock
    // difference is 7h; the actual elapsed is 8h (one hour skipped).
    // We assert ELAPSED hours, never wall-clock — the test guards against
    // someone "fixing" the rollup by computing wall-clock deltas.
    await service.clockIn('tenant-1', 'user-1', {
      entryType: 'job',
      clockedInAt: new Date('2026-03-08T13:00:00Z'),
    });
    await service.clockOut('tenant-1', 'user-1', {
      clockedOutAt: new Date('2026-03-08T21:00:00Z'),
    });
    const rollups = await service.weeklyHoursByUser(
      'tenant-1',
      new Date('2026-03-02T00:00:00Z'),
      'America/Los_Angeles'
    );
    expect(rollups[0].totalHours).toBe(8);
  });
});
