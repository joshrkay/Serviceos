/**
 * Postgres integration — the migration corpus must replay cleanly over a
 * POPULATED database (the next deploy).
 *
 * The runner has no applied-migrations ledger: every deploy's Railway
 * `preDeployCommand` (db/migrate.ts → applyMigrations) re-executes the WHOLE
 * corpus, in registry order, as one implicit transaction. So an early
 * migration that builds a constraint which a LATER migration drops or relaxes
 * re-builds the stricter object over live data on every deploy, BEFORE the
 * later migration gets to drop it again. The first row that is legal under the
 * final schema but illegal under the early copy fails that build, the whole
 * corpus rolls back, and every later deploy (hotfixes included) is blocked
 * until someone hand-edits the database.
 *
 * Everything else in the integration suite migrates an EMPTY database exactly
 * once (global-setup.ts), so it can never see this class. This file applies
 * the corpus to a dedicated fresh database (deploy N), writes rows that are
 * legal under the final schema (production traffic), applies the corpus again
 * (deploy N+1), and requires it to succeed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { applyMigrations } from '../../src/db/migrate';
import { PgCallMeBackRepository } from '../../src/voice/call-me-back/pg-call-me-back';
import { createTestTenant, ensureRlsRuntimeRole } from './shared';

/** One deploy: the exact entrypoint the Railway preDeployCommand runs. */
async function deploy(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await applyMigrations(client, { maxAttempts: 1 });
  } finally {
    await client.query('RESET ALL').catch(() => undefined);
    client.release();
  }
}

describe('Postgres integration — migration corpus replays over a populated database', () => {
  const dbName = `replay_${crypto.randomUUID().replace(/-/g, '')}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    const baseUri = process.env.TEST_DB_URL;
    if (!baseUri) throw new Error('TEST_DB_URL not set — run via the integration config');
    admin = new Pool({ connectionString: baseUri, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const uri = new URL(baseUri);
    uri.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: uri.toString(), max: 4 });

    // Deploy N against an empty database (what every other test already covers).
    await deploy(pool);
    await ensureRlsRuntimeRole(pool);
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('a call session that filed two different call-me-back reasons does not block the next deploy', async () => {
    // Production traffic between deploys, through the real repository: one
    // E1 call that both left a live booking AND could not reach the tenant
    // (migration 268's motivating case) files two tasks for ONE session.
    const tenant = await createTestTenant(pool);
    const repo = new PgCallMeBackRepository(pool);
    const sessionId = `sess-${crypto.randomUUID()}`;
    await repo.create({
      tenantId: tenant.tenantId,
      sessionId,
      callerPhone: '+15125550100',
      reason: 'life_safety_e1_booking_live',
    });
    await repo.create({
      tenantId: tenant.tenantId,
      sessionId,
      callerPhone: '+15125550100',
      reason: 'life_safety_e1',
    });

    // Deploy N+1.
    await expect(deploy(pool)).resolves.toBeUndefined();

    const pending = await repo.listPending(tenant.tenantId);
    expect(pending.filter((t) => t.sessionId === sessionId).map((t) => t.reason).sort()).toEqual([
      'life_safety_e1',
      'life_safety_e1_booking_live',
    ]);
  });

  it('call_me_back_tasks ends every deploy with exactly the (tenant, session, reason) unique key', async () => {
    // 154 is a no-op now; 268 alone must still produce the final key on a
    // fresh database and leave an already-migrated one untouched.
    await deploy(pool);
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT i.relname AS indexname, pg_get_indexdef(i.oid) AS indexdef
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
        WHERE x.indrelid = 'call_me_back_tasks'::regclass
          AND x.indisunique AND NOT x.indisprimary`,
    );
    expect(rows).toEqual([
      {
        indexname: 'idx_cmb_session_reason_unique',
        indexdef:
          'CREATE UNIQUE INDEX idx_cmb_session_reason_unique ON public.call_me_back_tasks ' +
          'USING btree (tenant_id, session_id, reason) WHERE (session_id IS NOT NULL)',
      },
    ]);
  });
});
