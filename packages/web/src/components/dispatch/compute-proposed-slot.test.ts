import { describe, it, expect } from 'vitest';
import { computeProposedSlot } from './compute-proposed-slot';

const H = 60 * 60 * 1000;
function iso(ms: number) {
  return new Date(ms).toISOString();
}

describe('computeProposedSlot', () => {
  it('places in empty lane at day start', () => {
    const dragged = { scheduledStart: iso(2 * H), scheduledEnd: iso(3 * H) };
    const r = computeProposedSlot({
      appointments: [],
      insertIndex: 0,
      dragged,
      dayStartIso: iso(0),
    });
    expect(r.placement).toBe('gap');
    expect(r.proposedScheduledStart).toBe(iso(0));
    expect(r.proposedScheduledEnd).toBe(iso(H));
  });

  it('inserts between A and B when gap fits duration', () => {
    const appointments = [
      { id: 'a', scheduledStart: iso(0), scheduledEnd: iso(2 * H) },
      { id: 'b', scheduledStart: iso(5 * H), scheduledEnd: iso(6 * H) },
    ];
    const dragged = { scheduledStart: iso(10 * H), scheduledEnd: iso(11 * H) };
    const r = computeProposedSlot({ appointments, insertIndex: 1, dragged, dayStartIso: iso(0) });
    expect(r.placement).toBe('gap');
    expect(r.proposedScheduledStart).toBe(iso(2 * H));
    expect(r.proposedScheduledEnd).toBe(iso(3 * H));
  });

  it('returns overflow when gap too small', () => {
    const appointments = [
      { id: 'a', scheduledStart: iso(0), scheduledEnd: iso(2 * H) },
      { id: 'b', scheduledStart: iso(2 * H + 15 * 60 * 1000), scheduledEnd: iso(5 * H) },
    ];
    const dragged = { scheduledStart: iso(0), scheduledEnd: iso(2 * H) };
    const r = computeProposedSlot({ appointments, insertIndex: 1, dragged, dayStartIso: iso(0) });
    expect(r.placement).toBe('overflow');
  });

  it('inserts after last appointment', () => {
    const appointments = [
      { id: 'a', scheduledStart: iso(0), scheduledEnd: iso(2 * H) },
    ];
    const dragged = { scheduledStart: iso(5 * H), scheduledEnd: iso(6 * H) };
    const r = computeProposedSlot({ appointments, insertIndex: 1, dragged, dayStartIso: iso(0) });
    expect(r.proposedScheduledStart).toBe(iso(2 * H));
    expect(r.proposedScheduledEnd).toBe(iso(3 * H));
  });
});
