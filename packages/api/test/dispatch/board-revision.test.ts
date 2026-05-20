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

  it('derives board date from appointment', () => {
    expect(boardDateFromAppointment(new Date('2026-05-20T15:00:00Z'))).toBe('2026-05-20');
  });
});
