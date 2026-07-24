import { describe, it, expect, afterEach } from 'vitest';
import { verifyCriticalConstraints } from '../../src/db/migrate';
import type { PoolClient } from 'pg';

/**
 * Foundation gate F3 (Codex round 5) — a migration run that ends without the
 * no_double_booking constraint must FAIL the deploy, not warn and exit 0:
 * without the constraint the product runs in exactly the mode the spec
 * forbids. ALLOW_MISSING_CRITICAL_CONSTRAINTS=true is the deliberate
 * operator override. (The live-DB presence check is pinned in
 * test/integration/foundation-gates.test.ts.)
 */
function clientReturning(
  rows: { conname: string; relname: string; contype: string }[],
): PoolClient {
  return { query: async () => ({ rows }) } as never;
}

const REAL_CONSTRAINT = {
  conname: 'no_double_booking',
  relname: 'appointment_assignments',
  contype: 'x',
};

describe('verifyCriticalConstraints', () => {
  afterEach(() => {
    delete process.env.ALLOW_MISSING_CRITICAL_CONSTRAINTS;
  });

  it('passes silently when every critical constraint is present', async () => {
    await expect(
      verifyCriticalConstraints(clientReturning([REAL_CONSTRAINT])),
    ).resolves.toBeUndefined();
  });

  it('throws when no_double_booking is absent', async () => {
    await expect(verifyCriticalConstraints(clientReturning([]))).rejects.toThrow(
      /no_double_booking/,
    );
  });

  it('rejects a same-named constraint on another table or of another type', async () => {
    // Constraint names are not database-global — a decoy elsewhere must not
    // satisfy the deploy gate.
    await expect(
      verifyCriticalConstraints(
        clientReturning([
          { conname: 'no_double_booking', relname: 'some_other_table', contype: 'x' },
          { conname: 'no_double_booking', relname: 'appointment_assignments', contype: 'c' },
        ]),
      ),
    ).rejects.toThrow(/no_double_booking/);
  });

  it('does not throw under the explicit operator override', async () => {
    process.env.ALLOW_MISSING_CRITICAL_CONSTRAINTS = 'true';
    await expect(verifyCriticalConstraints(clientReturning([]))).resolves.toBeUndefined();
  });
});
