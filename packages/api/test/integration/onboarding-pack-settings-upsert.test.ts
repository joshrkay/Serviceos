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
 * recovery read fails with 25P02 and the route still 500s. (The executor path
 * is unaffected — each repo call gets its own transaction — which is why the
 * lock-scope file's winner test passes.) The repo already documents this
 * hazard on `TransactionScope.savepoint` (db/tenant-transaction.ts).
 *
 * P2 — read-then-merge-then-write is a lost update. When a third writer
 * creates the settings row with no packs (the sibling handler's
 * `upsertIdentityFields` does exactly that), two activations for DIFFERENT
 * packs can both read the same mirror and both write only their own pack, so
 * one pack silently vanishes from `_activeVerticalPacks` — the mirror read by
 * the Templates page and public intake — while both `pack_activations` rows
 * are active.
 *
 * Both tests are deterministic: the interleaving is forced through a
 * call-through hook on the settings read, never by timing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
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

  it('P1 — inside the request-scoped transaction, another writer creating tenant_settings does not poison the caller', async () => {
    const deps = buildDeps();

    // Stand up exactly what the HTTP route gives activatePackWithSeed: one
    // BEGIN'd, tenant-scoped client, published on the AsyncLocalStorage the
    // repositories read, and passed in as `lockClient`.
    const requestClient: PoolClient = await pool.connect();
    let result: Awaited<ReturnType<typeof activatePackWithSeed>> | undefined;
    let thrown: unknown;
    try {
      await requestClient.query('BEGIN');
      await applyTenantContext(requestClient, tenant.tenantId, { transactional: true });

      // The other writer commits on its OWN connection between our read and
      // our write — the same window the sibling handler's pre-lock
      // upsertIdentityFields opens.
      let interleaved = false;
      const realFindByTenant = deps.settingsRepo.findByTenant.bind(deps.settingsRepo);
      deps.settingsRepo.findByTenant = async (tenantId: string) => {
        const found = await realFindByTenant(tenantId);
        if (!interleaved) {
          interleaved = true;
          await new PgSettingsRepository(pool).upsertIdentityFields(tenantId, {
            businessName: 'Sibling Co',
            jobBufferMinutes: 30,
          });
        }
        return found;
      };

      await tenantContextStore.run(
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

      expect(interleaved).toBe(true);
      // Before the fix this is a 25P02: "current transaction is aborted,
      // commands ignored until end of transaction block" — the 23505 killed
      // the shared request transaction and the recovery read cannot run.
      expect(thrown).toBeUndefined();
      expect(result).toEqual({ status: 'activated', seedResult: expect.anything() });

      await requestClient.query('COMMIT');
    } finally {
      await requestClient.query('ROLLBACK').catch(() => undefined);
      requestClient.release();
    }

    // The request's writes are visible and merged with the sibling's.
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

  it('P2 — two activations for DIFFERENT packs both land in the mirror, even when one reads before the other writes', async () => {
    const depsA = buildDeps();
    const depsB = buildDeps();

    // The row exists with no packs — what the sibling handler's
    // upsertIdentityFields leaves behind, and the state in which both
    // activations take the read-then-write path.
    await depsA.settingsRepo.upsertIdentityFields(tenant.tenantId, {
      businessName: 'Two Packs Co',
      jobBufferMinutes: 30,
    });
    expect(await readMirror(tenant.tenantId)).toEqual([]);

    // Deterministic lost-update shape: A reads the mirror, then B's ENTIRE
    // activation runs and commits, and only then does A write. Different
    // packs mean different advisory keys, so nothing serializes them.
    let interleaved = false;
    const realFindByTenant = depsA.settingsRepo.findByTenant.bind(depsA.settingsRepo);
    depsA.settingsRepo.findByTenant = async (tenantId: string) => {
      const found = await realFindByTenant(tenantId);
      if (!interleaved) {
        interleaved = true;
        const bResult = await activatePackWithSeed(
          {
            tenantId: tenant.tenantId,
            packId: 'plumbing',
            actorId: tenant.userId,
            lockPool: pool,
          },
          depsB,
        );
        expect(bResult.status).toBe('activated');
      }
      return found;
    };

    const aResult = await activatePackWithSeed(
      { tenantId: tenant.tenantId, packId: 'hvac', actorId: tenant.userId, lockPool: pool },
      depsA,
    );

    expect(interleaved).toBe(true);
    expect(aResult.status).toBe('activated');

    // Both packs are active in the authoritative table…
    const packRows = await pool.query(
      `SELECT pack_id FROM pack_activations WHERE tenant_id = $1 AND status = 'active' ORDER BY pack_id`,
      [tenant.tenantId],
    );
    expect(packRows.rows).toEqual([{ pack_id: 'hvac' }, { pack_id: 'plumbing' }]);

    // …and the mirror the Templates page and public intake read must agree.
    // Before the fix A's stale read overwrites B's entry and this is ['hvac'].
    expect([...(await readMirror(tenant.tenantId))].sort()).toEqual(['hvac', 'plumbing']);

    // The unrelated identity field is untouched by either activation.
    const settings = await pool.query(
      `SELECT business_name FROM tenant_settings WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(settings.rows[0].business_name).toBe('Two Packs Co');
  });
});
