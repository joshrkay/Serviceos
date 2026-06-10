import { Client, QueryResult } from 'pg';
import { RowEvidence, writeJsonArtifact, writeTextArtifact } from './evidence';

export interface DbQueryOptions {
  label: string;
  sql: string;
  params?: unknown[];
  tenantId?: string; // if set, `SET LOCAL app.current_tenant_id` inside a transaction (RLS on)
  /**
   * QA-2026-06-04 (ISO-01): mark queries that deliberately run WITHOUT the
   * tenant GUC to prove RLS suppresses rows. Two environment realities are
   * handled here instead of failing the row spuriously:
   *  - On a properly-scoped role, the one-arg `current_setting()` inside the
   *    RLS policy ERRORS when the GUC is unset ("unrecognized configuration
   *    parameter"). That is RLS failing CLOSED → captured as rowCount 0 with
   *    `rlsFailedClosed: true`.
   *  - On a superuser / BYPASSRLS connection (e.g. Railway's default
   *    `postgres` user) the probe is meaningless — rows are always visible.
   *    Captured with `bypassRls: true` so the spec can degrade to partial
   *    instead of reporting a fake tenant-isolation hole.
   */
  noGucProbe?: boolean;
}

export interface CapturedQuery {
  sql: string;
  params: unknown[];
  tenantGuc?: string;
  rowCount: number;
  rows: unknown[];
  timestamp: string;
  durationMs: number;
  artifactPath: string;
  /** Connection role has rolsuper/rolbypassrls — no-GUC RLS probes are not meaningful. */
  bypassRls?: boolean;
  /** Query errored on the missing GUC (policy fails closed) — treated as 0 visible rows. */
  rlsFailedClosed?: boolean;
}

export class DbVerifier {
  private client: Client | null = null;
  constructor(
    private readonly connectionString: string,
    private readonly evidence: RowEvidence
  ) {}

  private async ensure(): Promise<Client> {
    if (this.client) return this.client;
    const c = new Client({ connectionString: this.connectionString });
    await c.connect();
    this.client = c;
    return c;
  }

  private bypassRlsCache: boolean | null = null;

  private async connectionBypassesRls(c: Client): Promise<boolean> {
    if (this.bypassRlsCache !== null) return this.bypassRlsCache;
    try {
      const r = await c.query(
        'SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user'
      );
      this.bypassRlsCache = Boolean((r.rows[0] as { bypass?: boolean })?.bypass);
    } catch {
      this.bypassRlsCache = false;
    }
    return this.bypassRlsCache;
  }

  async query(opts: DbQueryOptions): Promise<CapturedQuery> {
    const c = await this.ensure();
    const started = Date.now();
    let result: QueryResult;
    let bypassRls: boolean | undefined;
    let rlsFailedClosed: boolean | undefined;
    if (opts.tenantId) {
      await c.query('BEGIN');
      try {
        await c.query(`SET LOCAL app.current_tenant_id = '${opts.tenantId.replace(/'/g, "''")}'`);
        result = await c.query(opts.sql, opts.params ?? []);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => void 0);
        throw err;
      }
    } else if (opts.noGucProbe) {
      bypassRls = (await this.connectionBypassesRls(c)) || undefined;
      try {
        result = await c.query(opts.sql, opts.params ?? []);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Two fails-closed shapes from current_setting('app.current_tenant_id')
        // inside the RLS policy:
        //  - GUC never defined in this session → "unrecognized configuration
        //    parameter".
        //  - GUC previously SET LOCAL on this connection then reverted → PG
        //    leaves it defined as '' → the policy's ''::uuid cast errors.
        if (
          /unrecognized configuration parameter.*app\.current_tenant_id/i.test(msg) ||
          /invalid input syntax for type uuid: ""/i.test(msg)
        ) {
          // Policy errored on the unset/empty GUC — RLS failed closed; no rows visible.
          rlsFailedClosed = true;
          result = { rows: [], rowCount: 0 } as unknown as QueryResult;
        } else {
          throw err;
        }
      }
    } else {
      result = await c.query(opts.sql, opts.params ?? []);
    }

    const capture: CapturedQuery = {
      sql: opts.sql,
      params: opts.params ?? [],
      tenantGuc: opts.tenantId,
      rowCount: result.rowCount ?? 0,
      rows: result.rows,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - started,
      artifactPath: '',
      ...(bypassRls ? { bypassRls } : {}),
      ...(rlsFailedClosed ? { rlsFailedClosed } : {}),
    };
    capture.artifactPath = writeJsonArtifact(this.evidence.dbDir(), opts.label, capture);
    writeTextArtifact(this.evidence.dbDir(), `${opts.label}.sql`, renderSql(opts));
    this.evidence.addArtifact({
      kind: 'db',
      path: capture.artifactPath,
      label: `DB ${opts.label} → ${capture.rowCount} row(s)`,
    });
    return capture;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.end().catch(() => void 0);
      this.client = null;
    }
  }
}

function renderSql(opts: DbQueryOptions): string {
  const header = opts.tenantId
    ? `-- tenant GUC: app.current_tenant_id = '${opts.tenantId}'\n`
    : '-- no tenant GUC (RLS expected to suppress rows)\n';
  const params = (opts.params ?? []).map((p, i) => `-- $${i + 1} = ${JSON.stringify(p)}`).join('\n');
  return [header, params, opts.sql].filter(Boolean).join('\n');
}
