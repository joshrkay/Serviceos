import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  upsertDispatchPresence,
  listDispatchPresence,
  clearDispatchPresence,
  getEditingOnAppointment,
} from '../../src/dispatch/presence-store';

describe('presence-store', () => {
  afterEach(() => {
    clearDispatchPresence('t1', '2026-05-20', 'u1');
    clearDispatchPresence('t1', '2026-05-20', 'u2');
  });

  it('lists active presence and expires stale entries', () => {
    vi.useFakeTimers();
    upsertDispatchPresence({
      tenantId: 't1',
      date: '2026-05-20',
      userId: 'u1',
      displayName: 'Alex',
      appointmentId: 'appt-1',
      mode: 'dragging',
      ttlMs: 1000,
    });
    expect(listDispatchPresence('t1', '2026-05-20')).toHaveLength(1);
    vi.advanceTimersByTime(1500);
    expect(listDispatchPresence('t1', '2026-05-20')).toHaveLength(0);
    vi.useRealTimers();
  });

  it('returns editing user on appointment', () => {
    upsertDispatchPresence({
      tenantId: 't1',
      date: '2026-05-20',
      userId: 'u2',
      displayName: 'Sam',
      appointmentId: 'appt-9',
      mode: 'dragging',
    });
    const editing = getEditingOnAppointment('t1', '2026-05-20', 'appt-9', 'u1');
    expect(editing?.displayName).toBe('Sam');
    expect(getEditingOnAppointment('t1', '2026-05-20', 'appt-9', 'u2')).toBeNull();
  });
});
