/**
 * Probes for a raw tenant-filtered statement moved under the RLS runtime role
 * (raw-pg audit 2026-10-23 §4 P1).
 *
 * A `WHERE tenant_id = $1` statement returns the same rows as the privileged
 * connection principal and as `rls_app_runtime`, so a result-only test cannot
 * tell whether the database backstop is there. `widenTenantPredicates` takes
 * the WHERE clause's tenant pin away: every `tenant_id = $n` in a matching
 * statement becomes `tenant_id = ANY(<the test's tenants>)` (with `$n` still
 * referenced, so the parameter list is unchanged). Under the tenant role the
 * policy still hides the other tenant, so the code under test answers as
 * before; run as the principal (`asPrincipal`, the pre-migration shape) the
 * same rewritten statement reaches the other tenant, which is the control
 * that the widening test can fail at all.
 *
 * The widened set is the test's own tenants, not every tenant: removing the
 * predicate outright would let the principal control's UPDATEs reach every
 * tenant in the shared integration database.
 *
 * Compose with `probeStatementRoles`: pass its `pool` as `real` here and the
 * role probe sees the rewritten statement, after the control's RESET ROLE.
 *
 * Also here: `runtimeRoleGrantsMissingAfter219` (the production grants) and
 * `countPoolTraffic` (checkouts and statements, for the per-call cost pins).
 */
import type { Pool, PoolClient, QueryResult } from 'pg';
import { MIGRATIONS } from '../../src/db/schema';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_PIN = /\b((?:\w+\.)?tenant_id)\s*=\s*\$(\d+)/g;

export interface WidenTenantPredicatesOptions {
  /** Statements whose SQL matches are rewritten; every other statement runs as written. */
  target: RegExp;
  /** The tenants the widened predicate admits (the caller's and the other one). */
  tenants: readonly string[];
  /** Control: RESET ROLE before each rewritten statement, as the raw pool read ran. */
  asPrincipal?: boolean;
}

export interface WidenedPool {
  /** Pass this to the code under test in place of the real pool. */
  pool: Pool;
  /** Each rewritten statement, in execution order. Empty means nothing was widened. */
  rewritten: string[];
}

type QueryFn = (text: unknown, values?: unknown) => Promise<QueryResult>;

export function widenTenantPredicates(real: Pool, opts: WidenTenantPredicatesOptions): WidenedPool {
  for (const id of opts.tenants) {
    if (!UUID.test(id)) throw new Error(`widenTenantPredicates: not a uuid: ${id}`);
  }
  const anyOf = `ANY('{${opts.tenants.join(',')}}'::uuid[])`;
  const rewritten: string[] = [];

  const instrument = (client: PoolClient): PoolClient => {
    const inner = client.query as unknown as QueryFn;
    const widened: QueryFn = async (text, values) => {
      const sql = typeof text === 'string' ? text : null;
      const next =
        sql !== null && opts.target.test(sql)
          ? sql.replace(TENANT_PIN, (_m, col: string, n: string) => `(${col} = ${anyOf} AND $${n}::uuid IS NOT NULL)`)
          : sql;
      if (next === sql) return inner.call(client, text, values);
      rewritten.push(next!);
      if (opts.asPrincipal) await inner.call(client, 'RESET ROLE');
      return inner.call(client, next!, values);
    };
    (client as unknown as { query: QueryFn }).query = widened;
    const innerRelease = client.release;
    client.release = (err?: Error | boolean) => {
      delete (client as unknown as { query?: QueryFn }).query;
      return innerRelease(err);
    };
    return client;
  };

  const connect = async (): Promise<PoolClient> => instrument(await real.connect());
  const query = async (text: unknown, values?: unknown): Promise<QueryResult> => {
    const client = await connect();
    try {
      return await (client.query as unknown as QueryFn)(text, values);
    } finally {
      client.release();
    }
  };

  const pool = new Proxy(real, {
    get(target_, prop) {
      if (prop === 'connect') return connect;
      if (prop === 'query') return query;
      const value = Reflect.get(target_, prop, target_);
      return typeof value === 'function' ? value.bind(target_) : value;
    },
  });
  return { pool, rewritten };
}

export type TablePrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * The (table, privilege) pairs `rls_app_runtime` would NOT hold in production.
 *
 * The suite's setup re-grants the role on every table (ensureRlsRuntimeRole),
 * so a statement that works here can still fail in production on a table
 * migration 219 revokes (a tenant_id table without RLS). Replays the real 219
 * inside a transaction, reads the grants, and rolls back — the shared
 * database's grants are untouched (docs/solutions/test-failures/
 * shared-db-integration-test-grant-pollution.md).
 */
export async function runtimeRoleGrantsMissingAfter219(
  pool: Pool,
  needs: ReadonlyArray<readonly [table: string, privilege: TablePrivilege]>,
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(MIGRATIONS['219_rls_app_runtime_revoke_exempt']);
    const missing: string[] = [];
    for (const [table, privilege] of needs) {
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT has_table_privilege('rls_app_runtime', $1, $2) AS ok`,
        [table, privilege],
      );
      if (!rows[0]?.ok) missing.push(`${table}:${privilege}`);
    }
    return missing;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

export interface PoolTraffic {
  /** Pass this to the code under test in place of the real pool. */
  pool: Pool;
  /** Clients handed out: connect() calls plus one per one-shot pool.query. */
  checkouts(): number;
  /** Every statement, in execution order. */
  statements(): string[];
  /** The most clients this pool had out at once (2+ = a checkout nested inside another). */
  maxOpen(): number;
}

/**
 * Count what the code under test costs the pool — checkouts and statements
 * (each one a round trip) — for the "no added round trips on the live call
 * path" measurements.
 */
export function countPoolTraffic(real: Pool): PoolTraffic {
  let checkouts = 0;
  let open = 0;
  let maxOpen = 0;
  const statements: string[] = [];
  const opened = () => {
    checkouts += 1;
    open += 1;
    maxOpen = Math.max(maxOpen, open);
  };

  const connect = async (): Promise<PoolClient> => {
    const client = await real.connect();
    opened();
    const inner = client.query as unknown as QueryFn;
    (client as unknown as { query: QueryFn }).query = (text, values) => {
      statements.push(typeof text === 'string' ? text : String((text as { text?: string })?.text ?? ''));
      return inner.call(client, text, values);
    };
    const innerRelease = client.release;
    client.release = (err?: Error | boolean) => {
      open -= 1;
      delete (client as unknown as { query?: QueryFn }).query;
      return innerRelease(err);
    };
    return client;
  };
  const query = async (text: unknown, values?: unknown): Promise<QueryResult> => {
    const client = await connect();
    try {
      return await (client.query as unknown as QueryFn)(text, values);
    } finally {
      client.release();
    }
  };

  const pool = new Proxy(real, {
    get(target_, prop) {
      if (prop === 'connect') return connect;
      if (prop === 'query') return query;
      const value = Reflect.get(target_, prop, target_);
      return typeof value === 'function' ? value.bind(target_) : value;
    },
  });
  return { pool, checkouts: () => checkouts, statements: () => [...statements], maxOpen: () => maxOpen };
}
