import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  upsertDispatchPresence,
  listDispatchPresence,
  clearDispatchPresence,
  findEditingOnAppointment,
  resetDispatchPresenceStoreForTests,
  type PresenceEntry,
} from '../../src/dispatch/presence-store';

describe('presence-store', () => {
  beforeEach(() => {
    resetDispatchPresenceStoreForTests();
  });
  afterEach(() => {
    resetDispatchPresenceStoreForTests();
  });

  it('lists active presence and expires stale entries', async () => {
    vi.useFakeTimers();
    await upsertDispatchPresence({
      tenantId: 't1',
      date: '2026-05-20',
      userId: 'u1',
      displayName: 'Alex',
      appointmentId: 'appt-1',
      mode: 'dragging',
      ttlMs: 1000,
    });
    expect(await listDispatchPresence('t1', '2026-05-20')).toHaveLength(1);
    vi.advanceTimersByTime(1500);
    expect(await listDispatchPresence('t1', '2026-05-20')).toHaveLength(0);
    vi.useRealTimers();
  });

  it('finds the editing user on an appointment from a presence list', async () => {
    await upsertDispatchPresence({
      tenantId: 't1',
      date: '2026-05-20',
      userId: 'u2',
      displayName: 'Sam',
      appointmentId: 'appt-9',
      mode: 'dragging',
    });
    const entries = await listDispatchPresence('t1', '2026-05-20');
    const editing = findEditingOnAppointment(entries, 'appt-9', 'u1');
    expect(editing?.displayName).toBe('Sam');
    expect(findEditingOnAppointment(entries, 'appt-9', 'u2')).toBeNull();
  });

  it('ignores viewing-mode entries in the editing lookup', () => {
    const entries: PresenceEntry[] = [
      {
        tenantId: 't1',
        date: '2026-05-20',
        userId: 'u3',
        displayName: 'Vee',
        appointmentId: 'appt-9',
        mode: 'viewing',
        expiresAt: Date.now() + 10_000,
      },
    ];
    expect(findEditingOnAppointment(entries, 'appt-9')).toBeNull();
  });

  it('upsert reports change only when the visible state changed (not TTL refresh)', async () => {
    const base = {
      tenantId: 't1',
      date: '2026-05-20',
      userId: 'u1',
      displayName: 'Alex',
      appointmentId: null,
      mode: 'viewing' as const,
    };
    expect(await upsertDispatchPresence(base)).toBe(true); // new entry
    expect(await upsertDispatchPresence(base)).toBe(false); // heartbeat refresh
    expect(
      await upsertDispatchPresence({ ...base, mode: 'dragging', appointmentId: 'appt-1' }),
    ).toBe(true); // mode + appointment changed
    expect(await upsertDispatchPresence({ ...base, mode: 'dragging', appointmentId: 'appt-1' })).toBe(
      false,
    );
  });

  it('upsert after expiry counts as a change again', async () => {
    vi.useFakeTimers();
    const base = {
      tenantId: 't1',
      date: '2026-05-20',
      userId: 'u1',
      displayName: 'Alex',
      appointmentId: null,
      mode: 'viewing' as const,
      ttlMs: 1000,
    };
    expect(await upsertDispatchPresence(base)).toBe(true);
    vi.advanceTimersByTime(1500);
    // Entry lapsed — other viewers saw it disappear, so re-appearing is a change.
    expect(await upsertDispatchPresence(base)).toBe(true);
    vi.useRealTimers();
  });

  it('clear reports whether an entry existed', async () => {
    await upsertDispatchPresence({
      tenantId: 't1',
      date: '2026-05-20',
      userId: 'u1',
      displayName: 'Alex',
      appointmentId: null,
      mode: 'viewing',
    });
    expect(await clearDispatchPresence('t1', '2026-05-20', 'u1')).toBe(true);
    expect(await clearDispatchPresence('t1', '2026-05-20', 'u1')).toBe(false);
  });
});
