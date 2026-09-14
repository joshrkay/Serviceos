/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * Codex review on PR #1106, two findings against the round-2
 * insert-then-reconcile recovery in `activatePackWithSeed`. Both are real,
 * and both come from the same root: the settings-row write was a
 * read-then-write that could throw.
 *
 * P1 — on the HTTP path (`POST /api/onboarding/pack`), `lockClient` and every
 * repository share ONE request-scoped transaction
 * (`middleware/tenant-context.ts:259`, reused by
 * `PgBaseRepository.withTenantTransaction`). A 23505 there aborts that whole
 * transaction, so catching it does not make the connection usable again: the
 * recovery read fails with 25P02 and the route still 500s. The repo already
 * documents this hazard on `TransactionScope.savepoint`
 * (db/tenant-transaction.ts).
 *
 * P2 — read-then-merge-then-write is a lost update. The pack advisory lock is
 * keyed by (tenant, pack) but this row is keyed by tenant, so two activations
 * for DIFFERENT packs are not serialized against each other: both can read the
 * same mirror and both write back only their own pack, so one silently
 * vanishes from `_activeVerticalPacks` — the mirror the Templates page and
 * public intake read — while both `pack_activations` rows stay active.
 *
 * Both tests force the interleaving through REAL lock contention: a second
 * session holds an uncommitted write to the tenant's settings row, the code
 * under test blocks on it in Postgres, and only then does the blocker commit.
 * Nothing here depends on a sleep landing in the right place —
 * `waitUntilBlockedBy` polls until Postgres reports a waiter blocked by THIS
 * test's blocker pid (xhawk-ai review on #1121: an unscoped probe would accept
 * any blocked backend in the shared test database and could release the
 * blocker before the code under test even reached its write), and every
 * assertion is on the committed end state.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { resolveBootstrapAiModel } from '../../src/settings/settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgEstimateTemplateRepository } from '../../src/templates/pg-estimate-template';
import { activatePackWithSeed } from '../../src/onboarding/activate-pack-with-seed';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import { applyTenantContext } from '../../src/db/rls-runtime-role';

describe('Postgres integration — the tenant_settings write in activatePackWithSeed (Codex review, PR #1106)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });
  beforeEach(async () => {
    tenant = await createTestTenant(pool);
  });

  function buildDeps() {
    return {
      settingsRepo: new PgSettingsRepository(pool),
      packActivationRepo: new PgPackActivationRepository(pool),
      auditRepo: new PgAuditRepository(pool),
      packSeedDeps: {
        catalogRepo: new PgCatalogItemRepository(pool),
        templateRepo: new PgEstimateTemplateRepository(pool),
      },
    };
  }

  async function readMirror(tenantId: string): Promise<string[]> {
    const res = await pool.query(
      `SELECT terminology_preferences->'_activeVerticalPacks' AS packs
         FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    return (res.rows[0]?.packs as string[] | null) ?? [];
  }

  /**
   * Block until Postgres reports a backend waiting on a lock — i.e. the code
   * under test has reached its settings write and is queued behind the
   * blocker's uncommitted row. A condition wait, not a guessed delay: it
   * returns as soon as the state holds and throws instead of proceeding on a
   * state that never arrived.
   */
  async function waitUntilBlockedBy(blockerPid: number): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const res = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active'
            AND $1 = ANY(pg_blocking_pids(pid))`,
        [blockerPid],
      );
      if (res.rows[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('timed out waiting for the settings write to block on the other session');
  }

  /** The blocker's own backend pid, so the wait above can key on it. */
  async function backendPid(client: PoolClient): Promise<number> {
    const res = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return res.rows[0].pid;
  }

  it('P1 — inside the request-scoped transaction, another writer creating tenant_settings does not poison the caller', async () => {
    const deps = buildDeps();

    // The other writer: the sibling handler's REAL pre-lock call, held open
    // so the code under test collides with it rather than reading past it.
    const blocker: PoolClient = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, estimate_prefix, invoice_prefix, next_estimate_number, next_invoice_number, default_payment_term_days)
       VALUES (gen_random_uuid(), $1, 'Sibling Co', 'EST-', 'INV-', 1001, 1001, 30)`,
      [tenant.tenantId],
    );
    const blockerPid = await backendPid(blocker);

    // Stand up exactly what the HTTP route gives activatePackWithSeed: one
    // BEGIN'd, tenant-scoped client, published on the AsyncLocalStorage the
    // repositories read, and passed in as `lockClient`.
    const requestClient: PoolClient = await pool.connect();
    let result: Awaited<ReturnType<typeof activatePackWithSeed>> | undefined;
    let thrown: unknown;
    let blockerDone = false;
    try {
      await requestClient.query('BEGIN');
      await applyTenantContext(requestClient, tenant.tenantId, { transactional: true });

      const activation = tenantContextStore.run(
        { client: requestClient, tenantId: tenant.tenantId },
        async () => {
          try {
            result = await activatePackWithSeed(
              {
                tenantId: tenant.tenantId,
                packId: 'hvac',
                actorId: tenant.userId,
                lockClient: requestClient,
              },
              deps,
            );
          } catch (err) {
            thrown = err;
          }
        },
      );

      // Once it is queued behind the blocker's uncommitted row, let the
      // blocker win. The settings write then completes against a row that
      // appeared after this request started.
      await waitUntilBlockedBy(blockerPid);
      await blocker.query('COMMIT');
      blocker.release();
      blockerDone = true;

      await activation;

      // Before the fix this is a 25P02: "current transaction is aborted,
      // commands ignored until end of transaction block" — the 23505 killed
      // the shared request transaction and the recovery read cannot run.
      expect(thrown).toBeUndefined();
      expect(result).toEqual({ status: 'activated', seedResult: expect.anything() });

      await requestClient.query('COMMIT');
    } finally {
      await requestClient.query('ROLLBACK').catch(() => undefined);
      requestClient.release();
      if (!blockerDone) {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release(true);
      }
    }

    // The request's writes are visible and merged with the other writer's.
    expect(await readMirror(tenant.tenantId)).toEqual(['hvac']);
    const settings = await pool.query(
      `SELECT business_name FROM tenant_settings WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(settings.rows).toHaveLength(1);
    expect(settings.rows[0].business_name).toBe('Sibling Co');
    const packs = await pool.query(
      `SELECT pack_id FROM pack_activations WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(packs.rows).toEqual([{ pack_id: 'hvac' }]);
  });

  it('P2 — a concurrent activation of a DIFFERENT pack is merged into the mirror, not overwritten', async () => {
    const deps = buildDeps();

    // The row exists with no packs — what the sibling handler's
    // upsertIdentityFields leaves behind.
    await deps.settingsRepo.upsertIdentityFields(tenant.tenantId, {
      businessName: 'Two Packs Co',
      jobBufferMinutes: 30,
      bootstrapAiModel: resolveBootstrapAiModel(),
    });
    expect(await readMirror(tenant.tenantId)).toEqual([]);

    // The other activation (plumbing) has written the mirror but not yet
    // committed. Different pack ⇒ different advisory key, so nothing
    // serializes it against the hvac activation below.
    const blocker: PoolClient = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      `UPDATE tenant_settings
          SET terminology_preferences = jsonb_set(
                COALESCE(terminology_preferences, '{}'::jsonb),
                '{_activeVerticalPacks}',
                '["plumbing"]'::jsonb
              )
        WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    await blocker.query(
      `INSERT INTO pack_activations (id, tenant_id, pack_id, status)
       VALUES (gen_random_uuid(), $1, 'plumbing', 'active')`,
      [tenant.tenantId],
    );
    const blockerPid = await backendPid(blocker);

    const activation = activatePackWithSeed(
      { tenantId: tenant.tenantId, packId: 'hvac', actorId: tenant.userId, lockPool: pool },
      deps,
    );

    await waitUntilBlockedBy(blockerPid);
    await blocker.query('COMMIT');
    blocker.release();

    const result = await activation;
    expect(result.status).toBe('activated');

    // Both packs are active in the authoritative table…
    const packRows = await pool.query(
      `SELECT pack_id FROM pack_activations WHERE tenant_id = $1 AND status = 'active' ORDER BY pack_id`,
      [tenant.tenantId],
    );
    expect(packRows.rows).toEqual([{ pack_id: 'hvac' }, { pack_id: 'plumbing' }]);

    // …and the mirror must agree. Before the fix the hvac activation's stale
    // read overwrites the plumbing entry and this is ['hvac'].
    expect([...(await readMirror(tenant.tenantId))].sort()).toEqual(['hvac', 'plumbing']);

    // The unrelated identity field is untouched by the activation.
    const settings = await pool.query(
      `SELECT business_name FROM tenant_settings WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(settings.rows[0].business_name).toBe('Two Packs Co');
  });

  it('re-activating a pack already in the mirror does not duplicate it', async () => {
    const deps = buildDeps();

    for (let i = 0; i < 2; i++) {
      const result = await activatePackWithSeed(
        { tenantId: tenant.tenantId, packId: 'hvac', actorId: tenant.userId, lockPool: pool },
        deps,
      );
      expect(result.status).toBe('activated');
    }

    expect(await readMirror(tenant.tenantId)).toEqual(['hvac']);
  });
});
