/**
 * Ask Postgres which role and tenant id a statement really runs under.
 *
 * A `WHERE tenant_id = $1` query returns the same rows whether it runs as the
 * privileged connection principal (RLS bypassed) or as `rls_app_runtime` (RLS
 * enforced), so a result-only test cannot tell a context-applied query from a
 * GUC-only one. The role Postgres reports can.
 *
 * `probeStatementRoles` wraps a real Pool. Every client it hands out, through
 * `connect()` or a one-shot `query()`, first runs
 * `SELECT current_user, current_setting('app.current_tenant_id', true)` on the
 * SAME connection, inside the same transaction, right before each statement
 * whose SQL matches `target`, and records the answer. Nothing is mocked: the
 * statements under test still run against real Postgres, and the extra SELECT
 * changes no state.
 */
import type { Pool, PoolClient, QueryResult } from 'pg';

export interface StatementRole {
  sql: string;
  role: string;
  /** `app.current_tenant_id` as the statement saw it; '' or null when unset. */
  tenantGuc: string | null;
}

export interface StatementRoleProbe {
  /** Pass this to the code under test in place of the real pool. */
  pool: Pool;
  /** One entry per matching statement, in execution order. */
  seen: StatementRole[];
}

type QueryFn = (text: unknown, values?: unknown) => Promise<QueryResult>;

export function probeStatementRoles(real: Pool, target: RegExp): StatementRoleProbe {
  const seen: StatementRole[] = [];

  const instrument = (client: PoolClient): PoolClient => {
    const realQuery = client.query as unknown as QueryFn;
    const probed: QueryFn = async (text, values) => {
      const sql = typeof text === 'string' ? text : (text as { text?: string })?.text ?? '';
      if (target.test(sql)) {
        const who = await realQuery.call(
          client,
          "SELECT current_user AS role, current_setting('app.current_tenant_id', true) AS guc",
        );
        const row = who.rows[0] as { role: string; guc: string | null };
        seen.push({ sql, role: row.role, tenantGuc: row.guc });
      }
      return realQuery.call(client, text, values);
    };
    (client as unknown as { query: QueryFn }).query = probed;
    // pg-pool assigns `release` afresh on every checkout, so wrapping it here
    // only affects this checkout; dropping the own `query` puts the prototype
    // method back before the client returns to the pool.
    const realRelease = client.release;
    client.release = (err?: Error | boolean) => {
      delete (client as unknown as { query?: QueryFn }).query;
      return realRelease(err);
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

  return { pool, seen };
}
