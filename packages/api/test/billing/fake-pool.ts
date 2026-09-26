import type { Pool } from 'pg';

type Row = Record<string, unknown>;
export type QueryHandler = (sql: string, params: unknown[]) => { rows?: Row[]; rowCount?: number } | undefined;

/**
 * Minimal in-memory stand-in for a pg Pool: `query` and the client from
 * `connect()` both route through `handler`. Transaction/tenant-scope
 * statements (BEGIN, set_config, COMMIT…) answer empty. Unit-level cover
 * only — the Postgres integration tests are the proof the SQL works.
 */
export function fakePool(handler: QueryHandler): Pool & { calls: string[] } {
  const calls: string[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET|RESET|SELECT set_config)/i.test(sql)) return { rows: [], rowCount: 0 };
    const res = handler(sql, params) ?? {};
    return { rows: res.rows ?? [], rowCount: res.rowCount ?? res.rows?.length ?? 0 };
  };
  return {
    calls,
    query,
    connect: async () => ({ query, release: () => undefined }),
  } as unknown as Pool & { calls: string[] };
}
