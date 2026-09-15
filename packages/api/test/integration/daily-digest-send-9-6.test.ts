/**
 * Postgres integration — 9.6 End-of-day digest: the SEND, not just the row.
 *
 * `sweep-tenant-fanout.test.ts` already proves the digest sweep runs on the
 * PRODUCTION tenant selector (`listAllTenantIds(pool)`, not a stubbed list)
 * and serves two tenants in different timezones in one pass (T3+T4) — cited
 * here, not re-proven: `grep -nE "listTenantIds:\s*async\s*\(\)\s*=>\s*\[" ` over
 * that file matches nothing, and its two `it` blocks under "per-tenant sweep
 * fan-out (T4)" are the T3/T4 evidence for this row.
 *
 * What that file does NOT prove, because it hands the sweep
 * `emptyComputeDeps` and no delivery/dispatch wiring, is the row's own
 * acceptance criterion: "a digest sends once — not duplicated, not re-sent".
 * A digest that is only ever STORED is not a send. This file wires the real
 * compute-dependency repositories (so the payload reflects an actual
 * completed job, not an empty stub) plus a real delivery provider and
 * `PgDispatchRepository`, so "sent" means a row in `message_dispatches` at
 * real Postgres, read back by entity — the same shape as every other
 * message-sending sweep in this suite (thank-you SMS, review request).
 *
 * `digestChannel: 'none'` is a DOCUMENTED product mode (digest-service.ts /
 * daily-digest-worker.ts: "'none' — digest is stored for the web view; no
 * SMS"), not a hermetic-environment limitation — so it is asserted directly
 * as the honest, intentional outcome: a digest row with zero dispatch rows.
 *
 * The gap this file surfaced (#1113) is CLOSED here: nothing in the digest
 * send path used to call `PgAuditRepository.create` for the send itself.
 * `daily-digest-worker.ts`'s `DailyDigestWorkerDeps` had no `auditRepo`
 * field at all — the `auditRepo` inside `DigestComputeDeps` is read-only,
 * consulted by `computeDigestPayload` to compute the WS22 "N fixed"
 * reflection INSIDE the digest content, never written to record that a send
 * happened, while `thank-you-sms-worker.ts` writes
 * `notification.thank_you_sms.sent` right after its send. The worker now
 * takes its own `auditRepo` and writes
 * `notification.daily_digest.sent` / `.suppressed` / `.failed` on the
 * `daily_digest` entity — asserted below on the send, the documented
 * `channel: 'none'` suppression, and across two tenants in one sweep.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { runDailyDigestSweep } from '../../src/workers/daily-digest-worker';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgDailyDigestRepository } from '../../src/digest/pg-daily-digest';
import { PgDispatchRepository } from '../../src/notifications/dispatch-repository';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgFeedbackResponseRepository } from '../../src/feedback/pg-feedback-response';
import { PgCorrectionLessonRepository } from '../../src/learning/corrections/pg-correction-lesson';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { createLogger } from '../../src/logging/logger';
import type { DigestComputeDeps } from '../../src/digest/digest-service';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

/** Same instant as sweep-tenant-fanout.test.ts: 18:05 CDT Chicago AND 16:05
 *  MST Phoenix at once — both tenants' 'today' is 2026-06-11 in their own tz. */
const DUE_NOW = new Date('2026-06-11T23:05:00.000Z');
const LOCAL_DATE = '2026-06-11';

describe('Postgres integration — daily digest SEND (9.6)', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let digestRepo: PgDailyDigestRepository;
  let dispatchRepo: PgDispatchRepository;
  let auditRepo: PgAuditRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    digestRepo = new PgDailyDigestRepository(pool);
    dispatchRepo = new PgDispatchRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** Real repos throughout — no stubs. Empty tables simply yield empty
   *  arrays for every section the test doesn't seed. */
  function realComputeDeps(): DigestComputeDeps {
    return {
      paymentRepo: new PgPaymentRepository(pool),
      invoiceRepo: new PgInvoiceRepository(pool),
      estimateRepo: new PgEstimateRepository(pool),
      jobRepo,
      appointmentRepo: new PgAppointmentRepository(pool),
      proposalRepo: new PgProposalRepository(pool),
      customerRepo,
      settingsRepo,
      feedbackResponseRepo: new PgFeedbackResponseRepository(pool),
      correctionLessonRepo: new PgCorrectionLessonRepository(pool),
      auditRepo,
      now: () => DUE_NOW,
    };
  }

  async function seedTenant(opts: {
    timezone: string;
    digestTime: string;
    enabled: boolean;
    channel: 'sms' | 'none';
  }): Promise<string> {
    const { tenantId } = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone,
         owner_phone, digest_enabled, digest_time, digest_channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        uuidv4(),
        tenantId,
        'Digest Send Co',
        opts.timezone,
        `+1555${tenantId.replace(/-/g, '').slice(0, 7)}`,
        opts.enabled,
        opts.digestTime,
        opts.channel,
      ],
    );
    return tenantId;
  }

  /** Resolves the tenant's own owner_id (inserted by createTestTenant) so
   *  job/customer/location rows satisfy created_by FKs under this tenant. */
  async function ownerIdOf(tenantId: string): Promise<string> {
    const { rows } = await pool.query('SELECT owner_id FROM tenants WHERE id = $1', [tenantId]);
    return rows[0].owner_id as string;
  }

  async function seedCustomerAndLocation(
    tenantId: string,
    userId: string,
  ): Promise<{ customerId: string; locationId: string }> {
    const customerId = uuidv4();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Digest',
      lastName: 'Customer',
      displayName: 'Digest Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = uuidv4();
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1: '9 Digest Ave',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      addressType: 'service',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { customerId, locationId };
  }

  async function seedJobCompletedNow(
    tenantId: string,
    customerId: string,
    locationId: string,
    userId: string,
  ): Promise<void> {
    const jobId = uuidv4();
    await jobRepo.create({
      id: jobId,
      tenantId,
      customerId,
      locationId,
      jobNumber: `J-${jobId.slice(0, 8)}`,
      summary: 'Digest send fixture job',
      status: 'completed',
      priority: 'normal',
      createdBy: userId,
      createdAt: DUE_NOW,
      updatedAt: DUE_NOW,
    });
  }

  it('an enabled sms-channel tenant with real activity today gets exactly ONE digest send, read back from message_dispatches', async () => {
    const tenantId = await seedTenant({
      timezone: 'America/Chicago',
      digestTime: '18:00',
      enabled: true,
      channel: 'sms',
    });
    const ownerId = await ownerIdOf(tenantId);
    const { customerId, locationId } = await seedCustomerAndLocation(tenantId, ownerId);
    await seedJobCompletedNow(tenantId, customerId, locationId, ownerId);

    const result = await runDailyDigestSweep({
      settingsRepo,
      digestRepo,
      computeDeps: realComputeDeps(),
      listTenantIds: async () => [tenantId],
      delivery: new InMemoryDeliveryProvider(),
      dispatchRepo,
      publicBaseUrl: 'https://app.example.com',
      logger,
      now: () => DUE_NOW,
    });

    expect(result.sent).toBe(1);

    const digest = await digestRepo.findByTenantAndDate(tenantId, LOCAL_DATE);
    expect(digest).not.toBeNull();
    expect(digest!.payload.jobsCompletedCount).toBe(1);
    expect(digest!.smsDispatchId).toBeTruthy();

    // The write the row's criterion actually demands: one real dispatch row.
    const dispatches = await dispatchRepo.findByEntity(tenantId, 'daily_digest', digest!.id);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.status).toBe('sent');
    expect(dispatches[0]!.channel).toBe('sms');

    // Idempotency half of the criterion: sweeping again must not double-send.
    const secondPass = await runDailyDigestSweep({
      settingsRepo,
      digestRepo,
      computeDeps: realComputeDeps(),
      listTenantIds: async () => [tenantId],
      delivery: new InMemoryDeliveryProvider(),
      dispatchRepo,
      publicBaseUrl: 'https://app.example.com',
      logger,
      now: () => DUE_NOW,
    });
    expect(secondPass.sent).toBe(0);
    expect(secondPass.skipped).toBe(1);
    const dispatchesAfterRetry = await dispatchRepo.findByEntity(tenantId, 'daily_digest', digest!.id);
    expect(dispatchesAfterRetry).toHaveLength(1);
  });

  it("digestChannel 'none' is a documented skip — the digest stores but sends nothing", async () => {
    const tenantId = await seedTenant({
      timezone: 'America/Chicago',
      digestTime: '18:00',
      enabled: true,
      channel: 'none',
    });
    const ownerId = await ownerIdOf(tenantId);
    const { customerId, locationId } = await seedCustomerAndLocation(tenantId, ownerId);
    await seedJobCompletedNow(tenantId, customerId, locationId, ownerId);

    const result = await runDailyDigestSweep({
      settingsRepo,
      digestRepo,
      computeDeps: realComputeDeps(),
      listTenantIds: async () => [tenantId],
      delivery: new InMemoryDeliveryProvider(),
      dispatchRepo,
      publicBaseUrl: 'https://app.example.com',
      logger,
      now: () => DUE_NOW,
    });

    expect(result.generated).toBe(1);
    expect(result.sent).toBe(0);

    const digest = await digestRepo.findByTenantAndDate(tenantId, LOCAL_DATE);
    expect(digest).not.toBeNull();
    expect(digest!.smsDispatchId).toBeUndefined();
    const dispatches = await dispatchRepo.findByEntity(tenantId, 'daily_digest', digest!.id);
    expect(dispatches).toHaveLength(0);
  });

  it('a tenant with the digest disabled gets no row and no send at all', async () => {
    const tenantId = await seedTenant({
      timezone: 'America/Chicago',
      digestTime: '18:00',
      enabled: false,
      channel: 'sms',
    });
    const ownerId = await ownerIdOf(tenantId);
    const { customerId, locationId } = await seedCustomerAndLocation(tenantId, ownerId);
    await seedJobCompletedNow(tenantId, customerId, locationId, ownerId);

    const result = await runDailyDigestSweep({
      settingsRepo,
      digestRepo,
      computeDeps: realComputeDeps(),
      listTenantIds: async () => [tenantId],
      delivery: new InMemoryDeliveryProvider(),
      dispatchRepo,
      publicBaseUrl: 'https://app.example.com',
      logger,
      now: () => DUE_NOW,
    });

    expect(result.sent).toBe(0);
    expect(result.generated).toBe(0);
    expect(await digestRepo.findByTenantAndDate(tenantId, LOCAL_DATE)).toBeNull();
  });

  it('T3 — two tenants in different timezones are BOTH due at one instant and each gets its OWN send, with no cross-tenant leakage', async () => {
    const chicago = await seedTenant({
      timezone: 'America/Chicago',
      digestTime: '18:00',
      enabled: true,
      channel: 'sms',
    });
    const phoenix = await seedTenant({
      timezone: 'America/Phoenix',
      digestTime: '16:00',
      enabled: true,
      channel: 'sms',
    });

    const chicagoOwner = await ownerIdOf(chicago);
    const chicagoFixture = await seedCustomerAndLocation(chicago, chicagoOwner);
    await seedJobCompletedNow(chicago, chicagoFixture.customerId, chicagoFixture.locationId, chicagoOwner);
    // Phoenix gets TWO completed jobs today — a different number from
    // Chicago's one, so the payloads are distinguishably each tenant's own.
    const phoenixOwner = await ownerIdOf(phoenix);
    const phoenixFixtureA = await seedCustomerAndLocation(phoenix, phoenixOwner);
    await seedJobCompletedNow(phoenix, phoenixFixtureA.customerId, phoenixFixtureA.locationId, phoenixOwner);
    const phoenixFixtureB = await seedCustomerAndLocation(phoenix, phoenixOwner);
    await seedJobCompletedNow(phoenix, phoenixFixtureB.customerId, phoenixFixtureB.locationId, phoenixOwner);

    const result = await runDailyDigestSweep({
      settingsRepo,
      digestRepo,
      computeDeps: realComputeDeps(),
      listTenantIds: async () => [chicago, phoenix],
      delivery: new InMemoryDeliveryProvider(),
      dispatchRepo,
      publicBaseUrl: 'https://app.example.com',
      logger,
      now: () => DUE_NOW,
      auditRepo,
    });

    expect(result.sent).toBe(2);

    const chicagoDigest = await digestRepo.findByTenantAndDate(chicago, LOCAL_DATE);
    const phoenixDigest = await digestRepo.findByTenantAndDate(phoenix, LOCAL_DATE);
    expect(chicagoDigest).not.toBeNull();
    expect(phoenixDigest).not.toBeNull();
    // Each tenant's own number, not the other's — the fan-out test already
    // proves the storage half of this; here it's the SENT content that must
    // not cross tenants.
    expect(chicagoDigest!.payload.jobsCompletedCount).toBe(1);
    expect(phoenixDigest!.payload.jobsCompletedCount).toBe(2);

    const chicagoDispatches = await dispatchRepo.findByEntity(chicago, 'daily_digest', chicagoDigest!.id);
    const phoenixDispatches = await dispatchRepo.findByEntity(phoenix, 'daily_digest', phoenixDigest!.id);
    expect(chicagoDispatches).toHaveLength(1);
    expect(phoenixDispatches).toHaveLength(1);

    // #1113 T1 — each send is audited under its OWN tenant, carrying its own
    // tenant-local send time, and neither tenant's context reads the other's.
    const chicagoEvents = await auditRepo.findByEntity(chicago, 'daily_digest', chicagoDigest!.id);
    const phoenixEvents = await auditRepo.findByEntity(phoenix, 'daily_digest', phoenixDigest!.id);
    expect(chicagoEvents).toHaveLength(1);
    expect(phoenixEvents).toHaveLength(1);
    expect(chicagoEvents[0].eventType).toBe('notification.daily_digest.sent');
    expect(phoenixEvents[0].eventType).toBe('notification.daily_digest.sent');
    expect((chicagoEvents[0].metadata as Record<string, unknown>).tenantLocalTime).toBe('18:05');
    expect((phoenixEvents[0].metadata as Record<string, unknown>).tenantLocalTime).toBe('16:05');
    expect((chicagoEvents[0].metadata as Record<string, unknown>).dispatchId).toBe(
      chicagoDispatches[0].id,
    );
    expect(
      await auditRepo.findByEntity(phoenix, 'daily_digest', chicagoDigest!.id),
    ).toHaveLength(0);
    expect(
      await auditRepo.findByEntity(chicago, 'daily_digest', phoenixDigest!.id),
    ).toHaveLength(0);
  });

  // The real, production tenant selector (`listAllTenantIds(pool)`, not the
  // `listTenantIds: async () => [tenantId]` stub every test above uses) is
  // NOT re-proven here — it already has its own dedicated T4 entry in
  // sweep-tenant-fanout.test.ts ("runs on the REAL tenant selector and serves
  // each tenant on its OWN timezone + digest_time" / "keeps going when one
  // tenant throws"). Falsifier confirming that file is not stubbed:
  //   grep -nE "listTenantIds:\s*async\s*\(\)\s*=>\s*\[" test/integration/sweep-tenant-fanout.test.ts
  // → no match (only this file's own single/two-tenant convenience stubs
  // match that pattern, and this comment documents why that's fine: this
  // file's job is the SEND/audit gap, not the enumerator, which is proven
  // elsewhere and cited, not duplicated).

  it('#1113 — a digest send writes notification.daily_digest.sent through PgAuditRepository', async () => {
    // The precondition assertions come first on purpose (xhawk-ai review,
    // PR #1111): a send regression (sweep throws, no dispatch written,
    // digest lookup null) must fail THIS test loudly rather than be
    // mistaken for the audit assertion failing.
    const tenantId = await seedTenant({
      timezone: 'America/Chicago',
      digestTime: '18:00',
      enabled: true,
      channel: 'sms',
    });
    const ownerId = await ownerIdOf(tenantId);
    const { customerId, locationId } = await seedCustomerAndLocation(tenantId, ownerId);
    await seedJobCompletedNow(tenantId, customerId, locationId, ownerId);

    const result = await runDailyDigestSweep({
      settingsRepo,
      digestRepo,
      computeDeps: realComputeDeps(),
      listTenantIds: async () => [tenantId],
      delivery: new InMemoryDeliveryProvider(),
      dispatchRepo,
      publicBaseUrl: 'https://app.example.com',
      logger,
      now: () => DUE_NOW,
      auditRepo,
    });

    // Preconditions: the send actually happened. If any of these regress,
    // THIS assertion fails — not the audit assertion below.
    expect(result.sent).toBe(1);
    const digest = await digestRepo.findByTenantAndDate(tenantId, LOCAL_DATE);
    expect(digest).not.toBeNull();
    const dispatches = await dispatchRepo.findByEntity(tenantId, 'daily_digest', digest!.id);
    expect(dispatches).toHaveLength(1);

    // #1113 — the send is audited with the shape the ticket specifies and
    // the shape `notification.thank_you_sms.sent` already uses.
    const events = await auditRepo.findByEntity(tenantId, 'daily_digest', digest!.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId,
      eventType: 'notification.daily_digest.sent',
      entityType: 'daily_digest',
      entityId: digest!.id,
      actorRole: 'system',
    });
    expect(events[0].metadata).toMatchObject({
      channel: 'sms',
      digestDate: LOCAL_DATE,
      dispatchId: dispatches[0].id,
    });
    expect(typeof (events[0].metadata as Record<string, unknown>).tenantLocalTime).toBe('string');
  });

  it("#1113 — digestChannel 'none' is audited as a suppression, not silence", async () => {
    // Josh's open question on #1113 ("is the suppressed case audited or
    // deliberately silent?") is answered the way the sibling worker answers
    // it: `thank-you-sms-worker.ts` audits `.suppressed` with a reason, so a
    // digest that was generated and deliberately not sent leaves the same
    // kind of trace. Flip this to `toHaveLength(0)` if the decision goes the
    // other way — the emitter is one guarded call.
    const tenantId = await seedTenant({
      timezone: 'America/Chicago',
      digestTime: '18:00',
      enabled: true,
      channel: 'none',
    });
    const ownerId = await ownerIdOf(tenantId);
    const { customerId, locationId } = await seedCustomerAndLocation(tenantId, ownerId);
    await seedJobCompletedNow(tenantId, customerId, locationId, ownerId);

    const result = await runDailyDigestSweep({
      settingsRepo,
      digestRepo,
      computeDeps: realComputeDeps(),
      listTenantIds: async () => [tenantId],
      delivery: new InMemoryDeliveryProvider(),
      dispatchRepo,
      publicBaseUrl: 'https://app.example.com',
      logger,
      now: () => DUE_NOW,
      auditRepo,
    });

    expect(result.generated).toBe(1);
    expect(result.sent).toBe(0);
    const digest = await digestRepo.findByTenantAndDate(tenantId, LOCAL_DATE);
    expect(digest).not.toBeNull();
    expect(await dispatchRepo.findByEntity(tenantId, 'daily_digest', digest!.id)).toHaveLength(0);

    const events = await auditRepo.findByEntity(tenantId, 'daily_digest', digest!.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'notification.daily_digest.suppressed',
      entityType: 'daily_digest',
      entityId: digest!.id,
      actorRole: 'system',
    });
    expect(events[0].metadata).toMatchObject({
      channel: 'none',
      digestDate: LOCAL_DATE,
      reason: 'channel_none',
    });
  });

});
