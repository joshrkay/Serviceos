import { describe, it, expect, afterEach } from 'vitest';
import { setDraining, isDraining } from '../../src/ws/drain-state';

describe('drain-state (P4 graceful shutdown flag)', () => {
  afterEach(() => setDraining(false));

  it('defaults to not draining', () => {
    expect(isDraining()).toBe(false);
  });

  it('reflects setDraining', () => {
    setDraining(true);
    expect(isDraining()).toBe(true);
    setDraining(false);
    expect(isDraining()).toBe(false);
  });
});
