import { describe, it, expect } from 'vitest';
import {
  bumpDispatchBoardRevision,
  getDispatchBoardRevision,
  boardDateFromAppointment,
} from '../../src/dispatch/board-revision';

describe('board-revision', () => {
  it('returns stable revision until bumped', () => {
    const a = getDispatchBoardRevision('tenant-1', '2026-05-20');
    const b = getDispatchBoardRevision('tenant-1', '2026-05-20');
    expect(a).toBe(b);
  });

  it('changes revision on bump', () => {
    const before = getDispatchBoardRevision('tenant-2', '2026-05-21');
    const bumped = bumpDispatchBoardRevision('tenant-2', '2026-05-21');
    const after = getDispatchBoardRevision('tenant-2', '2026-05-21');
    expect(bumped).toBe(after);
    expect(after).not.toBe(before);
  });

  it('derives board date from appointment (UTC day when no tz given)', () => {
    expect(boardDateFromAppointment(new Date('2026-05-20T15:00:00Z'))).toBe('2026-05-20');
  });

  it('keys the board date by the TENANT-LOCAL day when a timezone is given', () => {
    // 2026-07-03 06:00Z is 11 PM Jul 2 in America/Los_Angeles. The UTC day
    // (Jul 3) would notify the wrong board; the tenant-local day is Jul 2.
    const lateNightPt = new Date('2026-07-03T06:00:00Z');
    expect(boardDateFromAppointment(lateNightPt)).toBe('2026-07-03'); // legacy/UTC
    expect(boardDateFromAppointment(lateNightPt, 'America/Los_Angeles')).toBe('2026-07-02');
    expect(boardDateFromAppointment(lateNightPt, 'UTC')).toBe('2026-07-03');
  });
});
