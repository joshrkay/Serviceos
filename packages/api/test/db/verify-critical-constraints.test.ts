import { describe, it, expect, afterEach } from 'vitest';
import { verifyCriticalConstraints } from '../../src/db/migrate';
import type { PoolClient } from 'pg';

/**
 * Foundation gate F3 (Codex round 5) — a migration run that ends without the
 * no_double_booking constraint must FAIL the deploy, not warn and exit 0:
 * without the constraint the product runs in exactly the mode the spec
 * forbids. ALLOW_MISSING_CRITICAL_CONSTRAINTS=true is the deliberate
 * operator override.
 *
 * Decoy rejection (same-named constraint on another table, another schema,
 * or of another type) is enforced SQL-side: the catalog query requires
 * `conrelid = to_regclass(relname)::oid` — the relation the application
 * actually sees via search_path — plus `contype`. The query-shape test
 * below pins that; the live-DB behavior is pinned in
 * test/integration/foundation-gates.test.ts.
 */
function clientReturning(rows: unknown[]): PoolClient & { queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  return {
    queries,
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows };
    },
  } as never;
}

describe('verifyCriticalConstraints', () => {
  afterEach(() => {
    delete process.env.ALLOW_MISSING_CRITICAL_CONSTRAINTS;
  });

  it('passes silently when every critical constraint is present', async () => {
    await expect(
      verifyCriticalConstraints(clientReturning([{ '?column?': 1 }])),
    ).resolves.toBeUndefined();
  });

  it('throws when no_double_booking is absent', async () => {
    await expect(verifyCriticalConstraints(clientReturning([]))).rejects.toThrow(
      /no_double_booking/,
    );
  });

  it('pins the decoy-proof query shape: application-visible relation + constraint type', async () => {
    // Neither constraint nor relation names are database-global. The check
    // must anchor on the relation OID the app resolves via search_path
    // (to_regclass) and on contype — otherwise a same-named decoy in
    // another schema/table (or a non-exclusion constraint) satisfies the
    // deploy gate while appointment_assignments stays unprotected.
    const client = clientReturning([{ '?column?': 1 }]);
    await verifyCriticalConstraints(client);
    expect(client.queries).toHaveLength(1);
    const { sql, params } = client.queries[0];
    expect(sql).toMatch(/to_regclass\(\$3\)::oid/);
    expect(sql).toMatch(/con\.contype = \$2/);
    expect(params).toEqual(['no_double_booking', 'x', 'appointment_assignments']);
  });

  it('does not throw under the explicit operator override', async () => {
    process.env.ALLOW_MISSING_CRITICAL_CONSTRAINTS = 'true';
    await expect(verifyCriticalConstraints(clientReturning([]))).resolves.toBeUndefined();
  });
});
