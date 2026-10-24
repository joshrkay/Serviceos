/**
 * A fake pg Pool for unit tests of code that runs its SQL through the tenant
 * context helpers (withTenantClient / withTenantConnection /
 * withTenantSession): it hands out clients, records every statement with the
 * checkout it ran on, and answers each one from `respond` (transaction
 * control, the tenant GUC and the role switch get an empty result unless
 * `respond` says otherwise). A one-shot `pool.query` counts as a checkout of
 * its own, as it does in pg.
 */
import type { Pool, QueryResult } from 'pg';

export interface FakeStatement {
  /** 0-based checkout the statement ran on. */
  checkout: number;
  sql: string;
  values?: unknown[];
}

export type FakeResponder = (
  sql: string,
  values: unknown[] | undefined,
) => { rows?: unknown[]; rowCount?: number } | undefined | Promise<{ rows?: unknown[]; rowCount?: number } | undefined>;

export interface FakeTenantPool {
  pool: Pool;
  statements: FakeStatement[];
  /** Number of clients handed out (connect() plus one per pool.query). */
  checkouts(): number;
  /** Clients handed out and not yet released. */
  open(): number;
  /** Statements that are not transaction control, the tenant GUC or the role switch. */
  work(): FakeStatement[];
}

const CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|RESET\b|SET LOCAL ROLE|SET ROLE|SELECT set_config\('app\.current_tenant_id')/i;

export function fakeTenantPool(respond: FakeResponder = () => undefined): FakeTenantPool {
  const statements: FakeStatement[] = [];
  let handedOut = 0;
  let released = 0;

  const run = async (checkout: number, text: unknown, values?: unknown[]): Promise<QueryResult> => {
    const sql = typeof text === 'string' ? text : String((text as { text?: string })?.text ?? '');
    statements.push({ checkout, sql, ...(values ? { values } : {}) });
    const res = (await respond(sql, values)) ?? {};
    const rows = res.rows ?? [];
    return { rows, rowCount: res.rowCount ?? rows.length } as unknown as QueryResult;
  };

  const connect = async () => {
    const checkout = handedOut++;
    return {
      query: (text: unknown, values?: unknown[]) => run(checkout, text, values),
      release: () => {
        released++;
      },
    };
  };

  const pool = {
    connect,
    query: async (text: unknown, values?: unknown[]) => {
      const checkout = handedOut++;
      try {
        return await run(checkout, text, values);
      } finally {
        released++;
      }
    },
  } as unknown as Pool;

  return {
    pool,
    statements,
    checkouts: () => handedOut,
    open: () => handedOut - released,
    work: () => statements.filter((s) => !CONTROL.test(s.sql)),
  };
}
