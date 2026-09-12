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
import { runWeeklyFeedbackSweep } from '../../src/workers/weekly-feedback-worker';
import { runHoldReaperSweep } from '../../src/workers/hold-reaper-worker';
import { runEstimateReminderSweep } from '../../src/workers/estimate-reminder-worker';
import { runEstimateExpirySweep } from '../../src/workers/estimate-expiry-worker';
import { runHfcrWeeklySendSweep } from '../../src/workers/hfcr-weekly-send-worker';
import { runGoogleReviewsSweep } from '../../src/workers/google-reviews';
import { runThankYouSmsSweep } from '../../src/workers/thank-you-sms-worker';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { PgDncRepository } from '../../src/compliance/dnc';
import { runReviewRequestSweep } from '../../src/workers/review-request-worker';
import { runDroppedCallRecoverySweep } from '../../src/workers/dropped-call-worker';
import { PgDroppedCallRecoveryRepository } from '../../src/sms/recovery/scheduler';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { WeeklyFeedbackSnapshot } from '../../src/digest/weekly-feedback';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import {
  resolveTenantOwnerEmail,
  isWeeklyFeedbackEnabledForTenant,
  resolveTenantBusinessName,
} from '../../src/digest/weekly-feedback-config';
import { PgDailyDigestRepository } from '../../src/digest/pg-daily-digest';
import type { DigestComputeDeps } from '../../src/digest/digest-service';
import type { SettingsRepository } from '../../src/settings/settings';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

/** What the thank-you sweep hands its dispatcher — the whole input, so the
 *  per-tenant scope can be asserted rather than inferred from the recipient. */
interface ThankYouDispatch {
  to: string;
  body: string;
  tenantId?: string;
  consent?: { smsConsent: boolean; customerId?: string };
}

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

/**
 * Same stubs, except every read throws for the FIRST of `ours` the sweep
 * actually reaches — not for a tenant chosen in advance.
 *
 * `listAllTenantIds` runs `SELECT id FROM tenants` with no `ORDER BY`, so the
 * enumeration order is unspecified and these tests cannot pick the doomed
 * tenant up front: if the survivors happened to be served first, a sweep that
 * aborted after the first error would already have written their rows and the
 * assertions would pass anyway. Failing whoever comes first makes "the failure
 * preceded the surviving work" true by construction rather than by luck.
 * Caught in review on this PR (Codex P2) after the same defect was fixed for
 * the cross-tenant-query sweeps with distinct `completed_at` values — which
 * fixed only half of it.
 */
function computeDepsFailingForFirstOf(
  settingsRepo: SettingsRepository,
  ours: string[],
): { deps: DigestComputeDeps; doomed: () => string | null } {
  const base = emptyComputeDeps(settingsRepo) as unknown as Record<string, Record<string, unknown>>;
  let failed: string | null = null;
  const guard = (fn: unknown) =>
    async (...args: unknown[]) => {
      const mine = args.find((a) => typeof a === 'string' && ours.includes(a)) as string | undefined;
      if (mine !== undefined && (failed === null || failed === mine)) {
        failed = mine;
        throw new Error(`synthetic failure for tenant ${mine}`);
      }
      return (fn as (...a: unknown[]) => Promise<unknown>)(...args);
    };
  for (const [repoName, repo] of Object.entries(base)) {
    if (repoName === 'settingsRepo' || !repo || typeof repo !== 'object') continue;
    for (const [method, fn] of Object.entries(repo)) {
      if (typeof fn === 'function') repo[method] = guard(fn);
    }
  }
  return { deps: base as unknown as DigestComputeDeps, doomed: () => failed };
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
    const ours = [
      await seedDigestTenant({ timezone: 'America/Chicago', digestTime: '18:00', enabled: true }),
      await seedDigestTenant({ timezone: 'America/Chicago', digestTime: '18:00', enabled: true }),
      await seedDigestTenant({ timezone: 'America/Phoenix', digestTime: '16:00', enabled: true }),
    ];
    const failing = computeDepsFailingForFirstOf(settingsRepo, ours);

    const result = await runDailyDigestSweep({
      settingsRepo,
      digestRepo,
      computeDeps: failing.deps,
      listTenantIds: () => listAllTenantIds(pool),
      publicBaseUrl: 'https://app.example.com',
      logger,
      now: () => DUE_NOW,
    });

    // Whichever of ours the sweep reached first is the one that threw, so every
    // surviving assertion below describes work done AFTER a failure.
    const doomed = failing.doomed();
    expect(doomed).not.toBeNull();
    expect(ours).toContain(doomed);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(await digestRepo.findByTenantAndDate(doomed as string, LOCAL_DATE)).toBeNull();
    for (const survivor of ours.filter((t) => t !== doomed)) {
      expect(await digestRepo.findByTenantAndDate(survivor, LOCAL_DATE)).not.toBeNull();
    }
  });
});

/**
 * A note on what these blocks do and do not claim.
 *
 * Each sweep below already has its own integration test covering its business
 * logic and its Postgres writes. These blocks prove something those tests
 * cannot: the FAN-OUT contract — that the sweep runs on the production tenant
 * enumerator, honours each tenant's own configuration in a single pass, and
 * survives one tenant throwing. Data repositories are therefore stubbed where
 * the sweep's own test already proves them; the enumerator never is, because
 * the enumerator is the thing under test.
 */

function snapshotWithWork(weekStartIso: string, weekEndIso: string): WeeklyFeedbackSnapshot {
  // isEmptyWeek() skips a tenant whose week is all zeroes ("no dead-week spam"),
  // so the snapshot has to carry at least one non-zero signal to reach a send.
  return {
    weekStartIso,
    weekEndIso,
    revenueCents: 125_00,
    priorRevenueCents: 100_00,
    jobsCompleted: 3,
    priorJobsCompleted: 2,
    jobsBooked: 4,
    estimatesSent: 2,
    estimatesSentValueCents: 400_00,
    invoicesPaidCount: 1,
    callsAnswered: 5,
    newLeads: 2,
  } as unknown as WeeklyFeedbackSnapshot;
}

describe('Postgres integration — weekly-feedback sweep fan-out (T4)', () => {
  let pool: Pool;
  let auditRepo: PgAuditRepository;
  let settingsRepo: PgSettingsRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    auditRepo = new PgAuditRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
  });

  /**
   * A tenant with its OWN stored recipient, business name and opt-out flag.
   *
   * `createTestTenant` gives every tenant the same `owner_email`
   * ('test@example.com'), so seeding distinct values is what makes the
   * per-tenant assertions below falsifiable: a resolver that ignored the
   * tenant id it was handed would serve one address to all three.
   */
  async function seedWeeklyTenant(opts: {
    label: string;
    businessName: string;
    enabled: boolean;
  }): Promise<{ tenantId: string; email: string }> {
    const { tenantId } = await createTestTenant(pool);
    const email = `${opts.label}-${tenantId.slice(0, 8)}@example.com`;
    await pool.query('UPDATE tenants SET owner_email = $2 WHERE id = $1', [tenantId, email]);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, weekly_feedback_enabled)
       VALUES ($1, $2, $3, 'America/Chicago', $4)`,
      [uuidv4(), tenantId, opts.businessName, opts.enabled],
    );
    return { tenantId, email };
  }

  /**
   * Builds a sweep run scoped to the tenants this test seeded. Tenants belonging
   * to other integration files are enumerated for real and then skipped at the
   * opt-out gate — which is exactly how a stranger tenant behaves in production.
   */
  async function runWeekly(opts: {
    /** Tenants THIS test seeded. Strangers are gated out (see below). */
    ours: string[];
    /** Throw for the FIRST of these the sweep reaches — see the digest seam. */
    failFirstOf?: string[];
  }): Promise<{
    sent: { to: string; text: string }[];
    sentTo: string[];
    failed: number;
    doomed: string | null;
  }> {
    const sent: { to: string; text: string }[] = [];
    let doomed: string | null = null;
    const result = await runWeeklyFeedbackSweep({
      auditRepo,
      listTenantIds: () => listAllTenantIds(pool),
      // The PRODUCTION resolvers, reading the rows seeded above — the same
      // three functions app.ts hands this sweep. Substituting them here (as
      // every other test of this worker does) would leave a regression that
      // stopped scoping by tenant id invisible: caught in review on this PR
      // (Codex P2).
      //
      // The `ours` guard is scoping, not substitution. The shared container
      // holds every other integration file's tenants, and weekly feedback is
      // opt-OUT, so strangers would otherwise all be served. For OUR tenants
      // — including the opted-out one — the real gate decides.
      isFeedbackEnabled: async (tenantId) =>
        opts.ours.includes(tenantId)
          ? isWeeklyFeedbackEnabledForTenant(settingsRepo, tenantId)
          : false,
      resolveOwnerEmail: (tenantId) => resolveTenantOwnerEmail(pool, tenantId),
      resolveBusinessName: (tenantId) => resolveTenantBusinessName(settingsRepo, tenantId),
      buildSnapshot: async (tenantId, weekStart, weekEnd) => {
        if (opts.failFirstOf?.includes(tenantId) && (doomed === null || doomed === tenantId)) {
          doomed = tenantId;
          throw new Error(`synthetic failure for tenant ${tenantId}`);
        }
        return snapshotWithWork(weekStart.toISOString(), weekEnd.toISOString());
      },
      sendEmail: async (args) => {
        sent.push({ to: args.to, text: args.text });
        return undefined;
      },
      logger,
    });
    return { sent, sentTo: sent.map((e) => e.to), failed: result.failed, doomed };
  }

  it('serves each enabled tenant at its OWN stored address, greeting and opt-out', async () => {
    const a = await seedWeeklyTenant({ label: 'a', businessName: 'Alpha Plumbing', enabled: true });
    const b = await seedWeeklyTenant({ label: 'b', businessName: 'Beta HVAC', enabled: true });
    const optedOut = await seedWeeklyTenant({
      label: 'c',
      businessName: 'Gamma Electric',
      enabled: false,
    });
    const ours = [a.tenantId, b.tenantId, optedOut.tenantId];

    const { sent, sentTo } = await runWeekly({ ours });

    // T3: two tenants, two different recipients, one pass — no mixing. The
    // addresses come from each tenant's own row via the production resolver.
    expect(sentTo).toContain(a.email);
    expect(sentTo).toContain(b.email);
    // The opt-out is the tenant's own stored flag, read by the production gate.
    expect(sentTo).not.toContain(optedOut.email);

    // …and the per-tenant configuration reaches the body, not just the
    // envelope: each owner is greeted with their OWN business name. This is
    // the I10 shape — both queries correct, the configuration assumed shared.
    const toA = sent.find((e) => e.to === a.email);
    const toB = sent.find((e) => e.to === b.email);
    expect(toA?.text).toContain('Alpha Plumbing');
    expect(toA?.text).not.toContain('Beta HVAC');
    expect(toB?.text).toContain('Beta HVAC');
    expect(toB?.text).not.toContain('Alpha Plumbing');
  });

  it('keeps going when one tenant throws — the other tenants are still served', async () => {
    const seeded = [
      await seedWeeklyTenant({ label: 't0', businessName: 'Zero Co', enabled: true }),
      await seedWeeklyTenant({ label: 't1', businessName: 'One Co', enabled: true }),
    ];
    const ours = seeded.map((t) => t.tenantId);
    const emailOf = new Map(seeded.map((t) => [t.tenantId, t.email]));

    const { sentTo, failed, doomed } = await runWeekly({
      ours,
      failFirstOf: ours,
    });

    // The thrower is whoever the sweep reached first, so the survivor's email
    // is provably work done after a failure rather than before one.
    expect(doomed).not.toBeNull();
    expect(ours).toContain(doomed);
    expect(failed).toBeGreaterThanOrEqual(1);
    expect(sentTo).not.toContain(emailOf.get(doomed as string));
    for (const survivor of ours.filter((t) => t !== doomed)) {
      expect(sentTo).toContain(emailOf.get(survivor));
    }
  });
});

/**
 * Every tenant-iterating sweep has a FIRST per-tenant call inside its loop.
 * Wrapping that one seam records which tenants the loop actually reached, and
 * lets exactly one of them throw — which is precisely the T4 contract: every
 * eligible tenant is processed, and one failure does not abort the rest.
 *
 * The sweeps below are driven through this seam rather than through fully
 * seeded business data on purpose. Their own integration tests already prove
 * what they *do* for a tenant; these prove *which tenants they reach*, on the
 * real enumerator, which no other test covers.
 */
function recordingSeam<T>(failFirstOf: string[] | null, result: T) {
  const visited: string[] = [];
  // The thrower is chosen by the enumerator, not by the caller: whichever of
  // `failFirstOf` the sweep reaches first. `listAllTenantIds` has no ORDER BY,
  // so picking one in advance would leave these tests unable to distinguish
  // "kept going after a failure" from "did the survivors before the failure."
  let doomed: string | null = null;
  return {
    visited,
    doomed: () => doomed,
    fn: async (tenantId: string): Promise<T> => {
      visited.push(tenantId);
      if (failFirstOf?.includes(tenantId) && (doomed === null || doomed === tenantId)) {
        doomed = tenantId;
        throw new Error(`synthetic failure for tenant ${tenantId}`);
      }
      return result;
    },
  };
}

/** Seeds three tenants and returns their ids. */
async function seedTrio(pool: Pool): Promise<[string, string, string]> {
  const a = (await createTestTenant(pool)).tenantId;
  const b = (await createTestTenant(pool)).tenantId;
  const c = (await createTestTenant(pool)).tenantId;
  return [a, b, c];
}

describe('Postgres integration — enumerator-driven sweep fan-out (T4)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  describe('hold-reaper sweep', () => {
    const run = async (failFirstOf: string[] | null) => {
      const { visited, fn, doomed } = recordingSeam(failFirstOf, []);
      const result = await runHoldReaperSweep({
        appointmentRepo: { findExpiredHolds: fn } as never,
        listTenantIds: () => listAllTenantIds(pool),
        logger,
      });
      return { visited, failed: result.failed, doomed: doomed() };
    };

    it('reaches every tenant through the real enumerator', async () => {
      const trio = await seedTrio(pool);
      const { visited } = await run(null);
      expect(visited).toEqual(expect.arrayContaining(trio));
    });

    it('keeps going when one tenant throws', async () => {
      const ours = await seedTrio(pool);
      const { visited, failed, doomed } = await run(ours);
      expect(failed).toBeGreaterThanOrEqual(1);
      // Whoever the enumerator reached first is the thrower, so every other
      // tenant in `visited` was reached AFTER a failure — which is the claim.
      expect(doomed).not.toBeNull();
      expect(ours).toContain(doomed);
      expect(visited).toEqual(expect.arrayContaining(ours));
    });
  });

  describe('estimate-reminder sweep', () => {
    const run = async (failFirstOf: string[] | null) => {
      const { visited, fn, doomed } = recordingSeam(failFirstOf, []);
      const result = await runEstimateReminderSweep({
        estimateRepo: { findByTenant: fn } as never,
        sendService: {} as never,
        pool: null,
        listTenantIds: () => listAllTenantIds(pool),
        logger,
      });
      return { visited, failed: result.failed, doomed: doomed() };
    };

    it('reaches every tenant through the real enumerator', async () => {
      const trio = await seedTrio(pool);
      const { visited } = await run(null);
      expect(visited).toEqual(expect.arrayContaining(trio));
    });

    it('keeps going when one tenant throws', async () => {
      const ours = await seedTrio(pool);
      const { visited, failed, doomed } = await run(ours);
      expect(failed).toBeGreaterThanOrEqual(1);
      // Whoever the enumerator reached first is the thrower, so every other
      // tenant in `visited` was reached AFTER a failure — which is the claim.
      expect(doomed).not.toBeNull();
      expect(ours).toContain(doomed);
      expect(visited).toEqual(expect.arrayContaining(ours));
    });
  });

  // §8.7 G1 (ticket #1012) — the estimate-expiry sweep (row 7.1/Phase 1 in
  // estimate-phases.test.ts) is not one of the sweeps this file otherwise
  // covers; its own test only ever proved a single hand-picked tenant. This
  // block mirrors 'estimate-reminder sweep' immediately above: real
  // enumerator reach + failure isolation, on the SAME `findByTenant` seam.
  describe('estimate-expiry sweep', () => {
    const run = async (failFirstOf: string[] | null) => {
      const { visited, fn, doomed } = recordingSeam(failFirstOf, []);
      const result = await runEstimateExpirySweep({
        estimateRepo: { findByTenant: fn } as never,
        listTenantIds: () => listAllTenantIds(pool),
        logger,
      });
      return { visited, failed: result.failed, doomed: doomed() };
    };

    it('reaches every tenant through the real enumerator', async () => {
      const trio = await seedTrio(pool);
      const { visited } = await run(null);
      expect(visited).toEqual(expect.arrayContaining(trio));
    });

    it('keeps going when one tenant throws', async () => {
      const ours = await seedTrio(pool);
      const { visited, failed, doomed } = await run(ours);
      expect(failed).toBeGreaterThanOrEqual(1);
      // Whoever the enumerator reached first is the thrower, so every other
      // tenant in `visited` was reached AFTER a failure — which is the claim.
      expect(doomed).not.toBeNull();
      expect(ours).toContain(doomed);
      expect(visited).toEqual(expect.arrayContaining(ours));
    });

    // §8.7 review (ticket #1012) named this gap: the two tests above stub
    // estimateRepo.findByTenant to prove ONLY that every tenant is visited —
    // "untouched" was never checked. This one runs the REAL PgEstimateRepository
    // (and real PgAuditRepository) so "untouched" means a concrete row: a
    // second tenant with an estimate that ISN'T past valid_until keeps its
    // 'sent' status and gets no estimate.expired audit row, in the SAME
    // sweep pass that expires its neighbour through the real enumerator.
    it('leaves a second tenant with nothing to expire untouched while its neighbour is expired in the same pass', async () => {
      const estimateRepo = new PgEstimateRepository(pool);
      const expiryAuditRepo = new PgAuditRepository(pool);
      const locationRepo = new PgLocationRepository(pool);
      const jobRepo = new PgJobRepository(pool);
      const customerRepo = new PgCustomerRepository(pool);

      const seedSentEstimate = async (validUntil: Date) => {
        const { tenantId, userId } = await createTestTenant(pool);
        const customerId = uuidv4();
        await customerRepo.create({
          id: customerId, tenantId, firstName: 'Fan', lastName: 'Out', displayName: 'Fan Out',
          preferredChannel: 'phone', smsConsent: false, isArchived: false,
          createdBy: userId, createdAt: new Date(), updatedAt: new Date(),
        });
        const locationId = uuidv4();
        await locationRepo.create({
          id: locationId, tenantId, customerId, street1: '1 Main St', city: 'Austin', state: 'TX',
          postalCode: '78701', country: 'USA', addressType: 'service', isPrimary: true, isArchived: false,
          createdAt: new Date(), updatedAt: new Date(),
        });
        const jobId = uuidv4();
        await jobRepo.create({
          id: jobId, tenantId, customerId, locationId, jobNumber: `J-${jobId.slice(0, 8)}`,
          summary: 'Fan-out expiry job', status: 'scheduled', priority: 'normal',
          createdBy: userId, createdAt: new Date(), updatedAt: new Date(),
        });
        const lineItems = [buildLineItem(uuidv4(), 'Labor', 1, 5000, 0, true)];
        const totals = calculateDocumentTotals(lineItems, 0, 0);
        const est = await estimateRepo.create({
          id: uuidv4(), tenantId, jobId, estimateNumber: `EST-${uuidv4().slice(0, 8)}`,
          status: 'sent', lineItems, totals, validUntil, version: 1,
          createdBy: userId, createdAt: new Date(), updatedAt: new Date(),
        });
        return { tenantId, estimateId: est.id };
      };

      // Past valid_until — this one IS a candidate and must expire.
      const expiring = await seedSentEstimate(new Date(Date.now() - 86_400_000));
      // Future valid_until — a second tenant that looks like a candidate
      // (status 'sent') but has nothing due to expire yet.
      const untouched = await seedSentEstimate(new Date(Date.now() + 86_400_000));

      const result = await runEstimateExpirySweep({
        estimateRepo,
        auditRepo: expiryAuditRepo,
        listTenantIds: () => listAllTenantIds(pool),
        logger,
      });
      expect(result.expired).toBeGreaterThanOrEqual(1);

      expect((await estimateRepo.findById(expiring.tenantId, expiring.estimateId))!.status).toBe('expired');
      const expiringEvents = await expiryAuditRepo.findByEntity(expiring.tenantId, 'estimate', expiring.estimateId);
      expect(expiringEvents.map((e) => e.eventType)).toContain('estimate.expired');

      // T1 — the second/untouched tenant's estimate keeps its status and has
      // NO estimate.expired audit row, in the same pass that expired its
      // neighbour above.
      expect((await estimateRepo.findById(untouched.tenantId, untouched.estimateId))!.status).toBe('sent');
      const untouchedEvents = await expiryAuditRepo.findByEntity(untouched.tenantId, 'estimate', untouched.estimateId);
      expect(untouchedEvents.map((e) => e.eventType)).not.toContain('estimate.expired');
    });
  });

  describe('hfcr weekly-send sweep', () => {
    const run = async (failFirstOf: string[] | null) => {
      const { visited, fn, doomed } = recordingSeam(failFirstOf, null);
      const result = await runHfcrWeeklySendSweep({
        hfcrSendRepo: { findByWeek: fn } as never,
        paymentRepo: { findByTenant: async () => [] } as never,
        proposalRepo: { findByTenant: async () => [] } as never,
        auditRepo: { findByEntity: async () => [], create: async () => undefined } as never,
        resolveOwnerPhone: async () => null,
        sendSms: async () => undefined,
        listTenantIds: () => listAllTenantIds(pool),
        logger,
      });
      return { visited, failed: result.failed, doomed: doomed() };
    };

    it('reaches every tenant through the real enumerator', async () => {
      const trio = await seedTrio(pool);
      const { visited } = await run(null);
      expect(visited).toEqual(expect.arrayContaining(trio));
    });

    it('keeps going when one tenant throws', async () => {
      const ours = await seedTrio(pool);
      const { visited, failed, doomed } = await run(ours);
      expect(failed).toBeGreaterThanOrEqual(1);
      // Whoever the enumerator reached first is the thrower, so every other
      // tenant in `visited` was reached AFTER a failure — which is the claim.
      expect(doomed).not.toBeNull();
      expect(ours).toContain(doomed);
      expect(visited).toEqual(expect.arrayContaining(ours));
    });
  });

  describe('google-reviews sweep', () => {
    const run = async (failFirstOf: string[] | null) => {
      const { visited, fn, doomed } = recordingSeam(failFirstOf, null);
      const result = await runGoogleReviewsSweep({
        pollStateRepo: { getPollState: fn } as never,
        credentialResolver: { getCredential: async () => null } as never,
        // No `proposalEmission`: this sweep is driven for tenant REACH, and
        // the worker ingests without emitting proposals when it is absent.
        reviewRepo: {} as never,
        listTenantIds: () => listAllTenantIds(pool),
        logger,
      });
      return { visited, failed: result.failed, doomed: doomed() };
    };

    it('reaches every tenant through the real enumerator', async () => {
      const trio = await seedTrio(pool);
      const { visited } = await run(null);
      expect(visited).toEqual(expect.arrayContaining(trio));
    });

    it('keeps going when one tenant throws', async () => {
      const ours = await seedTrio(pool);
      const { visited, failed, doomed } = await run(ours);
      expect(failed).toBeGreaterThanOrEqual(1);
      // Whoever the enumerator reached first is the thrower, so every other
      // tenant in `visited` was reached AFTER a failure — which is the claim.
      expect(doomed).not.toBeNull();
      expect(ours).toContain(doomed);
      expect(visited).toEqual(expect.arrayContaining(ours));
    });
  });
});

/**
 * The other sweep shape: no enumerator at all.
 *
 * thank-you-SMS and review-request do not take `listTenantIds`. They run ONE
 * cross-tenant SQL query, group the rows by tenant, and loop. They are
 * therefore multi-tenant by construction — but that construction had never been
 * exercised with more than one tenant's rows in the result set, so nothing
 * proved the grouping keeps tenants apart or that one tenant's failure spares
 * the others. T4 for this shape reads: the cross-tenant query returns rows for
 * several tenants, each is handled under its own settings, and a failure on one
 * does not abort the rest.
 */
describe('Postgres integration — cross-tenant query sweep fan-out (T4)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  // Both sweeps below select `ORDER BY j.completed_at ASC LIMIT 500`. In a
  // full-suite run the shared container holds other files' completed jobs, so
  // these fixtures are dated far in the past to sort first and stay inside the
  // limit deterministically.
  const FIXTURE_EPOCH = Date.parse('2020-01-01T00:00:00.000Z');
  // ...and each fixture gets its OWN timestamp, one second apart, so the sweep
  // processes them in the order they were seeded.
  //
  // They previously shared one instant. `ORDER BY completed_at ASC` leaves ties
  // in unspecified order, so the failure-isolation tests below — which seed the
  // doomed tenant first and assert the survivor is still processed — only
  // detected a regression when the doomed row happened to come back first. A
  // handler that swallowed the error and BROKE out of the loop would have
  // passed roughly half the time, which is not a test, it is a coin flip.
  // Caught in review on this PR (Codex P2); mutation-proof in the commit
  // message. Seeding order is now sweep order, so "doomed first" is a fact
  // rather than a hope.
  let fixtureSeq = 0;
  const nextCompletedAt = (): Date => new Date(FIXTURE_EPOCH + fixtureSeq++ * 1000);
  const seededJobIds: string[] = [];

  afterAll(async () => {
    // Stamp the fixtures so they drop out of BOTH eligibility queries. Without
    // this they stay eligible forever and would leak into the assertions of
    // thank-you-sms-worker.test.ts and review-request-sweep.test.ts.
    if (seededJobIds.length > 0) {
      await pool.query(
        `UPDATE jobs SET thank_you_sms_sent_at = NOW(), review_request_sent_at = NOW()
          WHERE id = ANY($1::uuid[])`,
        [seededJobIds],
      );
    }
    await closeSharedTestDb();
  });

  /** A tenant with settings and one long-completed job, eligible for both sweeps. */
  async function seedEligibleTenant(): Promise<{ tenantId: string; jobId: string; phone: string; customerId: string }> {
    const { tenantId, userId } = await createTestTenant(pool);
    const phone = `+1555${tenantId.replace(/-/g, '').slice(0, 7)}`;
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone)
       VALUES ($1,$2,$3,$4)`,
      [uuidv4(), tenantId, 'Fan-out Plumbing', 'America/Phoenix'],
    );
    const customerId = uuidv4();
    await pool.query(
      `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name,
         primary_phone, preferred_channel, sms_consent, is_archived, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        customerId, tenantId, 'Mary', 'Johnson', 'Mary Johnson',
        phone, 'sms', true, false, userId,
      ],
    );
    const locationId = uuidv4();
    await pool.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [locationId, tenantId, customerId, '1 Main St', 'Phoenix', 'AZ', '85001', 'US'],
    );
    const jobId = uuidv4();
    await pool.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary,
         status, priority, created_by, completed_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'completed','normal',$7,$8, NOW(), NOW())`,
      [
        jobId, tenantId, customerId, locationId,
        `J-${jobId.slice(0, 8)}`, 'Fan-out job', userId, nextCompletedAt(),
      ],
    );
    seededJobIds.push(jobId);
    return { tenantId, jobId, phone, customerId };
  }

  describe('thank-you-SMS sweep', () => {
    /**
     * REAL job/customer/DNC repositories, against the rows seeded above.
     *
     * An earlier version of this block stubbed them — and the stubs were wrong
     * in two ways (`jobRepo` had no `findById`; the DNC stub exposed
     * `isSuppressed` where the interface requires `isOnDnc`), so every job threw
     * before reaching the dispatcher. The tests still went green: the first
     * asserted only the settings visits and never used its `dispatched` array,
     * and the second read those incidental stub failures as proof of failure
     * isolation. Caught in review on this PR. The lesson is the same one §11.0e
     * is about — a fan-out test that never reaches the thing it claims to fan
     * out to is not evidence — so the repositories are now real and the
     * DISPATCHED tenants are asserted, not merely the visited ones.
     */
    const run = async (tenantsOfInterest: string[], failFor: string | null) => {
      const visited: string[] = [];
      const dispatched: ThankYouDispatch[] = [];
      const realSettings = new PgSettingsRepository(pool);
      const result = await runThankYouSmsSweep({
        pool,
        settingsRepo: {
          findByTenant: async (tenantId: string) => {
            // Record once per tenant: sendOneThankYou re-reads settings for
            // language, so this seam is hit more than once per tenant.
            if (tenantsOfInterest.includes(tenantId) && !visited.includes(tenantId)) {
              visited.push(tenantId);
            }
            if (tenantId === failFor) throw new Error(`synthetic failure for ${tenantId}`);
            const row = await realSettings.findByTenant(tenantId);
            return { ...(row ?? {}), sendThankYouSms: true } as never;
          },
        } as never,
        jobRepo: new PgJobRepository(pool),
        customerRepo: new PgCustomerRepository(pool),
        dncRepo: new PgDncRepository(pool),
        dispatcher: {
          // Capture the WHOLE input, not just the recipient. Recording `to`
          // alone would pass even if every message carried the first tenant's
          // `tenantId` — under which the production consent-ledger and DNC
          // lookups would run in the wrong scope, silently. Caught in review on
          // PR #994 (Codex P2), against the round that made the worker forward
          // these fields in the first place.
          send: async (input: ThankYouDispatch) => {
            dispatched.push(input);
          },
        } as never,
        logger,
      });
      return { visited, dispatched, failed: result.failed, tenants: result.tenants, sent: result.sent };
    };

    it('groups a multi-tenant result set and SENDS for each tenant under its own settings', async () => {
      const a = await seedEligibleTenant();
      const b = await seedEligibleTenant();

      const { visited, dispatched, tenants } = await run([a.tenantId, b.tenantId], null);

      expect(tenants).toBeGreaterThanOrEqual(2);
      expect(visited).toEqual(expect.arrayContaining([a.tenantId, b.tenantId]));
      // The assertion the earlier version was missing: each tenant's customer
      // was actually SENT to, not merely visited.
      expect(dispatched.map((d) => d.to)).toEqual(
        expect.arrayContaining([a.phone, b.phone]),
      );

      // …and each message carries ITS OWN tenant's scope. Without this, a
      // worker that forwarded one tenant's id for every send would pass every
      // assertion above: the recipient numbers would still be right, while the
      // gate's per-tenant DNC and consent-ledger lookups ran against the wrong
      // tenant. Recipient identity is not tenant identity.
      expect(dispatched.find((d) => d.to === a.phone)).toMatchObject({
        tenantId: a.tenantId,
        consent: { smsConsent: true, customerId: a.customerId },
      });
      expect(dispatched.find((d) => d.to === b.phone)).toMatchObject({
        tenantId: b.tenantId,
        consent: { smsConsent: true, customerId: b.customerId },
      });
    });

    it('keeps going when one tenant throws — the other tenant is still SENT', async () => {
      const doomed = await seedEligibleTenant();
      const survivor = await seedEligibleTenant();

      const { dispatched, failed } = await run(
        [doomed.tenantId, survivor.tenantId],
        doomed.tenantId,
      );

      expect(failed).toBeGreaterThanOrEqual(1);
      // Scoped to our own tenants: the doomed one never dispatches, the
      // survivor does. A blanket `failed >= 1` would also pass if every tenant
      // broke, which is exactly how the earlier version fooled itself.
      expect(dispatched.map((d) => d.to)).not.toContain(doomed.phone);
      expect(dispatched.map((d) => d.to)).toContain(survivor.phone);
      // The survivor's send is still correctly scoped after another tenant threw.
      expect(dispatched.find((d) => d.to === survivor.phone)).toMatchObject({
        tenantId: survivor.tenantId,
        consent: { smsConsent: true, customerId: survivor.customerId },
      });
    });
  });

  describe('review-request sweep', () => {
    const run = async (failForJobId: string | null) => {
      const enqueued: string[] = [];
      const result = await runReviewRequestSweep({
        pool,
        jobRepo: { update: async () => undefined } as never,
        queue: {
          send: async (_kind: string, payload: { jobId?: string }) => {
            const jobId = payload.jobId;
            if (jobId === failForJobId) throw new Error(`synthetic failure for job ${jobId}`);
            if (jobId) enqueued.push(jobId);
            return undefined;
          },
        } as never,
        logger,
      });
      return { enqueued, failed: result.failed };
    };

    it('enqueues across tenants from one cross-tenant query', async () => {
      const a = await seedEligibleTenant();
      const b = await seedEligibleTenant();

      const { enqueued } = await run(null);

      expect(enqueued).toEqual(expect.arrayContaining([a.jobId, b.jobId]));
    });

    it('keeps going when one row throws', async () => {
      const doomed = await seedEligibleTenant();
      const survivor = await seedEligibleTenant();

      const { enqueued, failed } = await run(doomed.jobId);

      expect(failed).toBeGreaterThanOrEqual(1);
      expect(enqueued).not.toContain(doomed.jobId);
      expect(enqueued).toContain(survivor.jobId);
    });
  });

  /**
   * C6 (#1011 PR-3) — the dropped-call recovery sweep has no fan-out entry in
   * this file. Like thank-you-SMS and review-request immediately above,
   * `dropped-call-worker.ts` takes no `listTenantIds` dependency:
   * `PgDroppedCallRecoveryRepository.findDueTenantIds` (scheduler.ts) runs ONE
   * cross-tenant `SELECT DISTINCT tenant_id` query, and the worker's send
   * batch (Phase 2) is scoped to whatever that REAL query returns — so this
   * belongs in the cross-tenant-query shape, not the enumerator-driven one.
   * T4 for this sweep: the real repository sees every tenant with a due row in
   * one pass, one tenant's synthetic send failure does not stop the rest, and
   * a tenant with nothing scheduled is left untouched in the same pass.
   */
  describe('dropped-call recovery sweep', () => {
    const DC_SCHEDULED_FOR = new Date('2020-02-02T00:00:00.000Z');
    const DC_DUE_AT = new Date(DC_SCHEDULED_FOR.getTime() + 1000);

    async function seedDueRecovery(): Promise<string> {
      const { tenantId } = await createTestTenant(pool);
      await pool.query(
        `INSERT INTO dropped_call_recoveries (tenant_id, voice_session_id, caller_e164, scheduled_for)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, uuidv4(), `+1555${tenantId.replace(/-/g, '').slice(0, 7)}`, DC_SCHEDULED_FOR],
      );
      return tenantId;
    }

    const run = async (failForTenant: string | null) => {
      const repo = new PgDroppedCallRecoveryRepository(pool);
      const auditRepo = new PgAuditRepository(pool);
      const sent: string[] = [];
      const result = await runDroppedCallRecoverySweep({
        repo,
        handlerDeps: {
          audit: auditRepo,
          logger,
          rateLimit: { check: async () => true, record: async () => undefined },
          resolvedSince: async () => null,
          compose: async () => 'We got cut off — reply to pick back up.',
          sendSms: async (input) => {
            if (input.tenantId === failForTenant) {
              throw new Error(`synthetic failure for tenant ${input.tenantId}`);
            }
            sent.push(input.tenantId);
            return `SM_${sent.length}`;
          },
        },
        logger,
        now: () => DC_DUE_AT,
      });
      return { sent, failed: result.failed };
    };

    it('reaches every tenant with a due row through the REAL cross-tenant selector', async () => {
      const trio = [await seedDueRecovery(), await seedDueRecovery(), await seedDueRecovery()];

      const { sent } = await run(null);

      expect(sent).toEqual(expect.arrayContaining(trio));
    });

    it('keeps going when one tenant throws — the other tenants are still SENT', async () => {
      const doomed = await seedDueRecovery();
      const survivorA = await seedDueRecovery();
      const survivorB = await seedDueRecovery();

      const { sent, failed } = await run(doomed);

      expect(failed).toBeGreaterThanOrEqual(1);
      expect(sent).not.toContain(doomed);
      expect(sent).toContain(survivorA);
      expect(sent).toContain(survivorB);
    });

    it('leaves a tenant with nothing scheduled untouched while its neighbour sends in the same pass', async () => {
      const withWork = await seedDueRecovery();
      const { tenantId: withoutWork } = await createTestTenant(pool);

      const { sent } = await run(null);

      expect(sent).toContain(withWork);
      expect(sent).not.toContain(withoutWork);
    });
  });
});
