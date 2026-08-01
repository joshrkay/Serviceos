import { describe, it, expect } from 'vitest';
import {
  laneRenderOrder,
  resolveInsert,
  isSameLaneNoOp,
  LaneAppt,
} from './dispatch-lane-order';

const appt = (id: string, start: string, end: string, status = 'scheduled'): LaneAppt => ({
  id,
  scheduledStart: start,
  scheduledEnd: end,
  status,
});

// A lane deliberately supplied out of order, with one card in a different status.
const A = appt('A', '2026-03-14T09:00:00Z', '2026-03-14T10:00:00Z');
const B = appt('B', '2026-03-14T11:00:00Z', '2026-03-14T12:00:00Z', 'confirmed');
const C = appt('C', '2026-03-14T13:00:00Z', '2026-03-14T14:00:00Z');

describe('laneRenderOrder', () => {
  it('sorts by start time', () => {
    expect(laneRenderOrder([C, A, B]).map((a) => a.id)).toEqual(['A', 'B', 'C']);
  });

  it('applies a status filter before sorting, matching what the lane renders', () => {
    expect(laneRenderOrder([C, A, B], 'scheduled').map((a) => a.id)).toEqual(['A', 'C']);
  });

  it('does not mutate the input array', () => {
    const input = [C, A, B];
    laneRenderOrder(input);
    expect(input.map((a) => a.id)).toEqual(['C', 'A', 'B']);
  });
});

describe('resolveInsert', () => {
  const order = [A, B, C]; // rendered order

  it('decrements the insert index when the dragged card precedes the gap (same-lane off-by-one fix)', () => {
    // Drag A (index 0) into the gap between B and C (rawInsertIndex 2).
    const { withoutDragged, insertIndex } = resolveInsert(order, 'A', 2);
    expect(withoutDragged.map((a) => a.id)).toEqual(['B', 'C']);
    // Without the decrement this would be 2 (>= length) and pack after C.
    expect(insertIndex).toBe(1);
  });

  it('leaves the insert index unchanged when the dragged card is after the gap', () => {
    // Drag C (index 2) into the gap before B (rawInsertIndex 1).
    const { withoutDragged, insertIndex } = resolveInsert(order, 'C', 1);
    expect(withoutDragged.map((a) => a.id)).toEqual(['A', 'B']);
    expect(insertIndex).toBe(1);
  });

  it('passes the index through for a cross-lane drag (dragged id not present)', () => {
    const { withoutDragged, insertIndex } = resolveInsert(order, 'X', 2);
    expect(withoutDragged.map((a) => a.id)).toEqual(['A', 'B', 'C']);
    expect(insertIndex).toBe(2);
  });

  it('indexes the rendered (filtered) order, not the raw lane', () => {
    // With a status filter, only A and C render. Dragging A into the trailing
    // gap (rawInsertIndex 2) should resolve against the filtered list.
    const filtered = laneRenderOrder([A, B, C], 'scheduled'); // [A, C]
    const { withoutDragged, insertIndex } = resolveInsert(filtered, 'A', 2);
    expect(withoutDragged.map((a) => a.id)).toEqual(['C']);
    expect(insertIndex).toBe(1);
  });
});

describe('isSameLaneNoOp', () => {
  const order = [A, B, C];

  it('is a no-op dropping onto its own leading gap', () => {
    expect(isSameLaneNoOp(order, 'B', 1)).toBe(true);
  });

  it('is a no-op dropping onto the gap immediately after itself', () => {
    // The original bug: this returned false and produced a phantom proposal.
    expect(isSameLaneNoOp(order, 'B', 2)).toBe(true);
  });

  it('is a real move dropping two gaps away', () => {
    expect(isSameLaneNoOp(order, 'A', 2)).toBe(false);
  });

  it('returns false when the dragged card is not in the lane (cross-lane)', () => {
    expect(isSameLaneNoOp(order, 'X', 1)).toBe(false);
  });
});
