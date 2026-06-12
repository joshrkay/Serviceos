import { describe, it, expect } from 'vitest';
import { optimizeRouteOrder } from '../../../src/ai/skills/optimize-route';

describe('route optimization', () => {
  it('orders stops by ascending travel time', () => {
    const result = optimizeRouteOrder({
      appointmentIds: ['a', 'b', 'c'],
      travelMinutes: [30, 10, 20],
    });
    expect(result.orderedIds).toEqual(['b', 'c', 'a']);
    expect(result.totalTravelMinutes).toBe(60);
  });
});
