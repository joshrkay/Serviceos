import { Client, QueryResult } from 'pg';
import { RowEvidence, writeJsonArtifact, writeTextArtifact } from './evidence';

export interface DbQueryOptions {
  label: string;
  sql: string;
  params?: unknown[];
  tenantId?: string; // if set, `SET LOCAL app.current_tenant_id` inside a transaction (RLS on)
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

  async query(opts: DbQueryOptions): Promise<CapturedQuery> {
    const c = await this.ensure();
    const started = Date.now();
    let result: QueryResult;
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
