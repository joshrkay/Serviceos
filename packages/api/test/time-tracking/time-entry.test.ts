import { describe, it, expect, beforeEach } from 'vitest';
import {
  ActiveEntryConflictError,
  InMemoryTimeEntryRepository,
  NegativeDurationError,
  TimeEntry,
  computeDurationMinutes,
} from '../../src/time-tracking/time-entry';

describe('P12-002 — time-entry InMemory repository', () => {
  let repo: InMemoryTimeEntryRepository;

  beforeEach(() => {
    repo = new InMemoryTimeEntryRepository();
  });

  function makeEntry(over: Partial<TimeEntry> = {}): TimeEntry {
    return {
      id: over.id ?? 'entry-1',
      tenantId: over.tenantId ?? 'tenant-1',
      userId: over.userId ?? 'user-1',
      jobId: over.jobId,
      entryType: over.entryType ?? 'job',
      clockedInAt: over.clockedInAt ?? new Date('2026-05-01T15:00:00Z'),
      clockedOutAt: over.clockedOutAt,
      durationMinutes: over.durationMinutes,
      notes: over.notes,
      createdAt: over.createdAt ?? new Date('2026-05-01T15:00:00Z'),
      updatedAt: over.updatedAt ?? new Date('2026-05-01T15:00:00Z'),
    };
  }

  it('time-entry create + findById round-trips a row', async () => {
    const entry = await repo.create(makeEntry());
    const found = await repo.findById('tenant-1', entry.id);
    expect(found).toMatchObject({ id: 'entry-1', userId: 'user-1' });
  });

  it('time-entry findById is tenant-scoped', async () => {
    await repo.create(makeEntry());
    const found = await repo.findById('tenant-2', 'entry-1');
    expect(found).toBeNull();
  });

  it('time-entry findActiveByUser returns only the open entry', async () => {
    await repo.create(
      makeEntry({
        id: 'closed',
        clockedOutAt: new Date('2026-05-01T16:00:00Z'),
        durationMinutes: 60,
      })
    );
    await repo.create(makeEntry({ id: 'open' }));
    const active = await repo.findActiveByUser('tenant-1', 'user-1');
    expect(active?.id).toBe('open');
  });

  it('time-entry create rejects a second open entry for the same user', async () => {
    await repo.create(makeEntry({ id: 'first' }));
    await expect(
      repo.create(
        makeEntry({ id: 'second', clockedInAt: new Date('2026-05-01T16:00:00Z') })
      )
    ).rejects.toBeInstanceOf(ActiveEntryConflictError);
  });

  it('time-entry create allows a second open entry for a DIFFERENT user', async () => {
    await repo.create(makeEntry({ id: 'a', userId: 'user-1' }));
    await repo.create(makeEntry({ id: 'b', userId: 'user-2' }));
    const all = repo.getAll();
    expect(all.length).toBe(2);
  });

  it('time-entry close populates clockedOutAt + duration', async () => {
    await repo.create(makeEntry());
    const closed = await repo.close('tenant-1', 'entry-1', {
      clockedOutAt: new Date('2026-05-01T16:30:00Z'),
      durationMinutes: 90,
    });
    expect(closed?.clockedOutAt).toBeInstanceOf(Date);
    expect(closed?.durationMinutes).toBe(90);
  });

  it('time-entry close is idempotent when already closed', async () => {
    await repo.create(
      makeEntry({
        clockedOutAt: new Date('2026-05-01T16:00:00Z'),
        durationMinutes: 60,
      })
    );
    const reclose = await repo.close('tenant-1', 'entry-1', {
      clockedOutAt: new Date('2026-05-01T17:00:00Z'),
      durationMinutes: 120,
    });
    // Original close timestamp + duration are preserved.
    expect(reclose?.durationMinutes).toBe(60);
  });

  it('time-entry close returns null for unknown id within tenant', async () => {
    const result = await repo.close('tenant-1', 'missing', {
      clockedOutAt: new Date(),
      durationMinutes: 0,
    });
    expect(result).toBeNull();
  });

  it('time-entry findByTenant scopes by tenant + filters by user', async () => {
    await repo.create(makeEntry({ id: 'a', tenantId: 'tenant-1', userId: 'u1' }));
    await repo.create(makeEntry({ id: 'b', tenantId: 'tenant-1', userId: 'u2' }));
    await repo.create(makeEntry({ id: 'c', tenantId: 'tenant-2', userId: 'u1' }));
    const tenant1 = await repo.findByTenant('tenant-1');
    expect(tenant1.map((r) => r.id).sort()).toEqual(['a', 'b']);
    const tenant1u1 = await repo.findByTenant('tenant-1', { userId: 'u1' });
    expect(tenant1u1.map((r) => r.id)).toEqual(['a']);
  });

  it('time-entry findByTenant filters activeOnly', async () => {
    await repo.create(
      makeEntry({
        id: 'closed',
        clockedOutAt: new Date('2026-05-01T16:00:00Z'),
        durationMinutes: 60,
      })
    );
    await repo.create(makeEntry({ id: 'open' }));
    const active = await repo.findByTenant('tenant-1', { activeOnly: true });
    expect(active.map((r) => r.id)).toEqual(['open']);
  });

  it('time-entry findByTenant filters by week window', async () => {
    // Both entries CLOSED so the partial UNIQUE (one-active-per-user)
    // doesn't fire — the window filter is what we're exercising here.
    await repo.create(
      makeEntry({
        id: 'before',
        clockedInAt: new Date('2026-04-20T15:00:00Z'),
        clockedOutAt: new Date('2026-04-20T16:00:00Z'),
        durationMinutes: 60,
      })
    );
    await repo.create(
      makeEntry({
        id: 'in',
        userId: 'user-1',
        clockedInAt: new Date('2026-05-01T15:00:00Z'),
        clockedOutAt: new Date('2026-05-01T16:00:00Z'),
        durationMinutes: 60,
      })
    );
    const inWeek = await repo.findByTenant('tenant-1', {
      weekStart: new Date('2026-04-27T00:00:00Z'),
      weekEnd: new Date('2026-05-04T00:00:00Z'),
    });
    expect(inWeek.map((r) => r.id)).toEqual(['in']);
  });

  it('time-tracking computeDurationMinutes — happy path', () => {
    const mins = computeDurationMinutes(
      new Date('2026-05-01T15:00:00Z'),
      new Date('2026-05-01T16:30:00Z')
    );
    expect(mins).toBe(90);
  });

  it('time-tracking computeDurationMinutes — boundary equal in/out → 0', () => {
    const mins = computeDurationMinutes(
      new Date('2026-05-01T15:00:00Z'),
      new Date('2026-05-01T15:00:00Z')
    );
    expect(mins).toBe(0);
  });

  it('time-tracking computeDurationMinutes — rejects negative', () => {
    expect(() =>
      computeDurationMinutes(
        new Date('2026-05-01T16:00:00Z'),
        new Date('2026-05-01T15:00:00Z')
      )
    ).toThrow(NegativeDurationError);
  });
});
