/**
 * Postgres integration — the per-tenant sweep contract (D-032, T4).
 *
 * Every tenant-iterating sweep makes three promises that nothing tested:
 *
 *   1. It runs on the PRODUCTION tenant selector, not a hand-picked list.
 *      Every other sweep test stubs `listTenantIds: async () => [oneId]`,
 *      which replaces the exact thing under test. Here the sweep is handed the
 *      real `listAllTenantIds(pool)` and sees every tenant the database holds —
 *      this file's own in a single-file run, and every other integration
 *      file's tenants in a full-suite run.
 *   2. It honours EACH tenant's own configuration in a single pass. The
 *      Phoenix mis-booking (I10) was exactly this failure: both tenants'
 *      queries were fine and the configuration was assumed shared.
 *   3. One tenant's failure does not abort the rest. `daily-digest-worker.ts`
 *      even carries the comment "Failure isolation: one tenant's failure never
 *      breaks the sweep" — implemented, commented, and never proven.
 *
 * The digest sweep is the first sweep wired in because it is the marquee
 * capability (PRD §8.9 story 9.6) and its T0 grade was the sharpest finding in
 * §11.0e. To add another sweep, seed tenants with `seedDigestTenant`-style
 * divergent config and repeat the three assertions against that worker.
 *
 * Assertions are scoped to the tenants THIS file seeds. The shared container
 * carries tenants from every other integration file, so the sweep's aggregate
 * counters include strangers; only row-level checks on our own ids are sound.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { listAllTenantIds } from '../../src/tenants/list-tenant-ids';
import { runDailyDigestSweep } from '../../src/workers/daily-digest-worker';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgDailyDigestRepository } from '../../src/digest/pg-daily-digest';
import type { DigestComputeDeps } from '../../src/digest/digest-service';
import type { SettingsRepository } from '../../src/settings/settings';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

/**
 * 2026-06-11T23:05Z is simultaneously 18:05 in Chicago (CDT, UTC-5) and 16:05
 * in Phoenix (MST, UTC-7, no DST). Two tenants in different zones with
 * different digest_times are therefore BOTH due at this one instant — which is
 * the whole point: a sweep that assumed one shared timezone would serve at most
 * one of them.
 */
const DUE_NOW = new Date('2026-06-11T23:05:00.000Z');
const LOCAL_DATE = '2026-06-11';

function emptyComputeDeps(settingsRepo: SettingsRepository): DigestComputeDeps {
  const none = async () => [];
  return {
    paymentRepo: { findByTenant: none },
    jobRepo: { findByTenant: none },
    appointmentRepo: { findByDateRange: none },
    invoiceRepo: { findByTenant: none, findByJobs: none },
    estimateRepo: { findByJobs: none, findByTenant: none },
    proposalRepo: { findByStatus: none, findConfidenceMarkedForDay: none },
    customerRepo: { findById: async () => null },
    settingsRepo,
    feedbackResponseRepo: {
      countByRatingInRange: async () => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }),
    },
    correctionLessonRepo: { findAppliedForDay: none },
  } as unknown as DigestComputeDeps;
}

/** Same stubs, except every read throws for one chosen tenant. */
function computeDepsFailingFor(settingsRepo: SettingsRepository, failTenantId: string): DigestComputeDeps {
  const base = emptyComputeDeps(settingsRepo) as unknown as Record<string, Record<string, unknown>>;
  const guard = (fn: unknown) =>
    async (...args: unknown[]) => {
      if (args.some((a) => a === failTenantId)) {
        throw new Error(`synthetic failure for tenant ${failTenantId}`);
      }
      return (fn as (...a: unknown[]) => Promise<unknown>)(...args);
    };
  for (const [repoName, repo] of Object.entries(base)) {
    if (repoName === 'settingsRepo' || !repo || typeof repo !== 'object') continue;
    for (const [method, fn] of Object.entries(repo)) {
      if (typeof fn === 'function') repo[method] = guard(fn);
    }
  }
  return base as unknown as DigestComputeDeps;
}

describe('Postgres integration — per-tenant sweep fan-out (T4)', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let digestRepo: PgDailyDigestRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    digestRepo = new PgDailyDigestRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedDigestTenant(opts: {
    timezone: string;
    digestTime: string;
    enabled: boolean;
  }): Promise<string> {
    const { tenantId } = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone,
         owner_phone, digest_enabled, digest_time, digest_channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        uuidv4(),
        tenantId,
        'Fan-out Co',
        opts.timezone,
        `+1555${tenantId.replace(/-/g, '').slice(0, 7)}`,
        opts.enabled,
        opts.digestTime,
        'sms',
      ],
    );
    return tenantId;
  }


  it('runs on the REAL tenant selector and serves each tenant on its OWN timezone + digest_time', async () => {
    const chicago = await seedDigestTenant({ timezone: 'America/Chicago', digestTime: '18:00', enabled: true });
    const phoenix = await seedDigestTenant({ timezone: 'America/Phoenix', digestTime: '16:00', enabled: true });
    const disabled = await seedDigestTenant({ timezone: 'America/Chicago', digestTime: '18:00', enabled: false });

    const realIds = await listAllTenantIds(pool);
    expect(realIds).toEqual(expect.arrayContaining([chicago, phoenix, disabled]));

    await runDailyDigestSweep({
      settingsRepo,
      digestRepo,
      computeDeps: emptyComputeDeps(settingsRepo),
      // The production enumerator. Not a stub.
      listTenantIds: () => listAllTenantIds(pool),
      publicBaseUrl: 'https://app.example.com',
      logger,
      now: () => DUE_NOW,
    });

    // T3: both due tenants served in ONE pass, each on its own clock.
    expect(await digestRepo.findByTenantAndDate(chicago, LOCAL_DATE)).not.toBeNull();
    expect(await digestRepo.findByTenantAndDate(phoenix, LOCAL_DATE)).not.toBeNull();
    // …and the opted-out tenant is untouched.
    expect(await digestRepo.findByTenantAndDate(disabled, LOCAL_DATE)).toBeNull();
  });

  it('keeps going when one tenant throws — the other tenants are still served', async () => {
    const doomed = await seedDigestTenant({ timezone: 'America/Chicago', digestTime: '18:00', enabled: true });
    const survivorA = await seedDigestTenant({ timezone: 'America/Chicago', digestTime: '18:00', enabled: true });
    const survivorB = await seedDigestTenant({ timezone: 'America/Phoenix', digestTime: '16:00', enabled: true });

    const result = await runDailyDigestSweep({
      settingsRepo,
      digestRepo,
      computeDeps: computeDepsFailingFor(settingsRepo, doomed),
      listTenantIds: () => listAllTenantIds(pool),
      publicBaseUrl: 'https://app.example.com',
      logger,
      now: () => DUE_NOW,
    });

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(await digestRepo.findByTenantAndDate(doomed, LOCAL_DATE)).toBeNull();
    // The point of the test: the sweep did not abort at the first throw.
    expect(await digestRepo.findByTenantAndDate(survivorA, LOCAL_DATE)).not.toBeNull();
    expect(await digestRepo.findByTenantAndDate(survivorB, LOCAL_DATE)).not.toBeNull();
  });
});
