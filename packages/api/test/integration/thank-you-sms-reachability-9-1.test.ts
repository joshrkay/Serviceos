/**
 * §8.9 row 9.1 — rung-5 REACHABILITY for the thank-you SMS sweep.
 *
 * The row's write + audit are already proven at real Postgres
 * (test/integration/thank-you-sms-worker.test.ts: claim-before-send,
 * NULL-stamp reconciliation, and a real two-sweep race all pass against real
 * `send_claims`). What none of those tests do is wire the dispatcher to the
 * REAL production consent gate (`GatedMessageDelivery`, enforcement:
 * 'block') the way `app.ts` actually builds `ThankYouSmsWorkerDeps.dispatcher`
 * — every existing test uses a hand-rolled capturing stub. PR #994's fix (see
 * the big comment above `withSendClaim` in thank-you-sms-worker.ts) depends
 * on this worker forwarding `tenantId` + `consent` to the gate correctly;
 * "the send survives the central consent gate in block mode" (the row's own
 * acceptance wording) has never been exercised with the real gate class.
 *
 * This file re-proves the row's three acceptance clauses with the REAL gate
 * standing in for the dispatcher, at real Postgres, with a second tenant
 * (T2) whose own send/audit trail is isolated from the first:
 *   1. exactly one send + one `notification.thank_you_sms.sent` audit row
 *      under two concurrent sweeps over the same eligible job;
 *   2. a "sent" claim with a NULL stamp is reconciled, not resent (and still
 *      produces exactly one audit row, not a duplicate);
 *   3. the send actually clears the real block-mode gate (not suppressed).
 *
 * #1184 adds the audit-claim ordering block at the bottom: the audit claim is
 * only spent once the audit row is written, so a failed write is retried by the
 * next sweep (exactly one audit row, one SMS) and a sweep with no auditRepo
 * spends nothing.
 *
 * #1184 review follow-up: a job whose SMS already went out is never
 * re-routed into a suppression branch (a STOP reply / consent revocation that
 * lands between a failed audit write and the next sweep must not stamp it
 * "suppressed"), and a stale audit claim whose row already committed is never
 * written twice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgDncRepository } from '../../src/compliance/dnc';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createLogger } from '../../src/logging/logger';
import { runThankYouSmsSweep } from '../../src/workers/thank-you-sms-worker';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { MessageDeliveryFeedbackDispatcher } from '../../src/feedback/dispatcher';
import { PgConsentEventRepository } from '../../src/compliance/consent-events';
import { normalizePhone } from '../../src/compliance/dnc';
import { buildStopKeywordHandler } from '../../src/compliance/stop-reply';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const NOW = new Date('2026-06-20T15:00:00Z');
const FOUR_HOURS_AGO = new Date(NOW.getTime() - 4 * 60 * 60 * 1000);

describe('9.1 reachability — thank-you SMS through the REAL block-mode consent gate', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let dncRepo: PgDncRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    dncRepo = new PgDncRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedTenantWithJob(): Promise<{
    tenantId: string;
    userId: string;
    customerId: string;
    jobId: string;
    phone: string;
  }> {
    const tenant = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), tenant.tenantId, 'Acme Plumbing', 'America/Phoenix'],
    );

    const customerId = uuidv4();
    const phone = `+1555${customerId.replace(/-/g, '').slice(0, 7)}`;
    await pool.query(
      `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name,
        primary_phone, preferred_channel, sms_consent, is_archived, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [customerId, tenant.tenantId, 'Mary', 'Johnson', 'Mary Johnson', phone, 'sms', true, false, tenant.userId],
    );

    const locationId = uuidv4();
    await pool.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [locationId, tenant.tenantId, customerId, '1 Main St', 'Phoenix', 'AZ', '85001', 'US'],
    );

    const jobId = uuidv4();
    const jobNumber = `JOB-${jobId.slice(0, 8)}`;
    await pool.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary,
        status, priority, created_by, completed_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'completed','normal',$7,$8, NOW(), NOW())`,
      [jobId, tenant.tenantId, customerId, locationId, jobNumber, 'Test job', tenant.userId, FOUR_HOURS_AGO],
    );

    return { tenantId: tenant.tenantId, userId: tenant.userId, customerId, jobId, phone };
  }

  function realGateDispatcher(base: InMemoryDeliveryProvider) {
    const gate = new GatedMessageDelivery({
      base,
      dnc: dncRepo,
      auditRepo,
      enforcement: 'block',
      // Pin the SMS kill switch ON — sendSms() checks this BEFORE consent
      // (gated-message-delivery.ts), and an inherited TELEPHONY_ENABLED=false
      // would short-circuit to `channel_disabled`, silently proving nothing.
      env: { ...process.env, TELEPHONY_ENABLED: 'true' },
    });
    return new MessageDeliveryFeedbackDispatcher(gate);
  }

  it('two concurrent sweeps over the same eligible job, through the real gate: exactly one send, one audit row — and a neighbour tenant sends+audits independently (T2)', async () => {
    const a = await seedTenantWithJob();
    const b = await seedTenantWithJob();

    const base = new InMemoryDeliveryProvider();
    const dispatcher = realGateDispatcher(base);

    await Promise.all([
      runThankYouSmsSweep({
        pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
        now: () => NOW,
      }),
      runThankYouSmsSweep({
        pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
        now: () => NOW,
      }),
    ]);

    // Exactly one real send per tenant, through the real gate — the gate
    // did not suppress it (the story's "survives the consent gate" clause).
    // This is the send-claim ledger's own at-most-once guarantee (T4-F01),
    // re-proven here with the REAL gate standing in for the dispatcher.
    expect(base.sentSms.filter((m) => m.to === a.phone)).toHaveLength(1);
    expect(base.sentSms.filter((m) => m.to === b.phone)).toHaveLength(1);

    // Exactly one `notification.thank_you_sms.sent` audit row per tenant's job.
    for (const t of [a, b]) {
      const events = await auditRepo.findByEntity(t.tenantId, 'job', t.jobId);
      expect(events.filter((e) => e.eventType === 'notification.thank_you_sms.sent')).toHaveLength(1);
    }

    // T2 isolation: tenant B's job audit is invisible under tenant A's id.
    const crossTenantRead = await auditRepo.findByEntity(a.tenantId, 'job', b.jobId);
    expect(crossTenantRead).toHaveLength(0);

    // The sweep's own idempotency stamp landed for both.
    const stampedA = await pool.query(`SELECT thank_you_sms_sent_at FROM jobs WHERE id = $1`, [a.jobId]);
    expect(stampedA.rows[0].thank_you_sms_sent_at).not.toBeNull();
    const stampedB = await pool.query(`SELECT thank_you_sms_sent_at FROM jobs WHERE id = $1`, [b.jobId]);
    expect(stampedB.rows[0].thank_you_sms_sent_at).not.toBeNull();
  });

  /**
   * PRODUCT GAP found by this lane, not previously ticketed (reported here
   * per §12.4d — this lane files nothing itself).
   *
   * The row's acceptance is "exactly one send AND one audit row" under two
   * concurrent sweeps. The send half holds (T4-F01's send-claim ledger is
   * solid — see the passing test above; a live `Promise.all` race against
   * this same worker never produced a second SEND in any run of this file).
   * The audit half does not, for a real and reproducible reason:
   * `sendOneThankYou`'s eligibility read (the outer sweep's SQL SELECT) and
   * its own `jobRepo.update(thankYouSmsSentAt)` stamp are NOT in the same
   * transaction — so a second, genuinely concurrent sweep tick's SELECT can
   * observe `thank_you_sms_sent_at IS NULL` a moment before the first
   * tick's stamp commits, and still reach `sendOneThankYou` for the same
   * job. When that second call's `withSendClaim` then observes the claim
   * already `'sent'` (thank-you-sms-worker.ts:325-337,
   * `claimResult.outcome === 'duplicate' && priorStatus === 'sent'`), it
   * unconditionally falls through to the SAME `jobRepo.update` +
   * `emitAudit('sent')` the winner already ran
   * (thank-you-sms-worker.ts:350-358) — with no check for whether the job
   * was already stamped. That fallthrough exists on purpose for genuine
   * crash recovery (PR #705, Codex P2: winner sent but crashed before
   * stamping) — but it fires identically here, where nothing crashed,
   * producing a SECOND `notification.thank_you_sms.sent` audit row for one
   * real send.
   *
   * A live `Promise.all` reproduction of this is timing-dependent (the
   * two-transaction gap above is usually microseconds), so this test
   * reproduces the exact interleaving DETERMINISTICALLY instead of hoping
   * to win a race: run the real sweep once (real send, real stamp, real
   * single audit row — asserted below as the honest baseline), then reset
   * ONLY `thank_you_sms_sent_at` back to NULL (standing in for a second
   * concurrent tick's SELECT having already read the row before the first
   * tick's stamp committed — the send_claims row is untouched, still
   * genuinely `'sent'` from the real send above) and run the real sweep
   * again.
   */
  it(
    'FIXED (#1140): a second concurrent sweep tick never adds a second audit row for one real send — the crash-recovery reconcile path is now idempotent on the audit trail',
    async () => {
      const seed = await seedTenantWithJob();
      const base = new InMemoryDeliveryProvider();
      const dispatcher = realGateDispatcher(base);

      await runThankYouSmsSweep({
        pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
        now: () => NOW,
      });
      // Honest baseline: the real, single sweep tick sent once and audited
      // once. (Not itself the finding — the finding is what happens next.)
      expect(base.sentSms).toHaveLength(1);
      const claimStatus = await pool.query(
        `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
        [seed.tenantId, `thank_you_sms:${seed.jobId}`],
      );
      expect(claimStatus.rows[0].status).toBe('sent');
      const baseline = await auditRepo.findByEntity(seed.tenantId, 'job', seed.jobId);
      expect(baseline.filter((e) => e.eventType === 'notification.thank_you_sms.sent')).toHaveLength(1);

      // Stand in for a second concurrent tick's SELECT racing the first
      // tick's UPDATE — the claim row (the real crash-safety ledger) is left
      // exactly as the real send above left it.
      await pool.query(`UPDATE jobs SET thank_you_sms_sent_at = NULL WHERE id = $1`, [seed.jobId]);

      await runThankYouSmsSweep({
        pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
        now: () => NOW,
      });

      // DESIRED: no resend (this holds — the claim ledger works) AND no
      // second audit row (this is the gap).
      expect(base.sentSms).toHaveLength(1);
      const after = await auditRepo.findByEntity(seed.tenantId, 'job', seed.jobId);
      expect(after.filter((e) => e.eventType === 'notification.thank_you_sms.sent')).toHaveLength(1);
    },
  );

  it('a "sent" claim with a NULL stamp is reconciled through the real gate — no resend, exactly one audit row', async () => {
    const seed = await seedTenantWithJob();
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at, sent_at)
       VALUES ($1, $2, 'sent', NOW(), NOW())`,
      [seed.tenantId, `thank_you_sms:${seed.jobId}`],
    );

    const base = new InMemoryDeliveryProvider();
    const dispatcher = realGateDispatcher(base);

    await runThankYouSmsSweep({
      pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
      now: () => NOW,
    });

    // No resend through the real gate.
    expect(base.sentSms.filter((m) => m.to === seed.phone)).toHaveLength(0);

    // The reconcile path still runs the happy-path stamp + audit exactly once
    // (thank-you-sms-worker.ts: "Falls through to the same stamp + audit the
    // happy path runs").
    const row = await pool.query(`SELECT thank_you_sms_sent_at FROM jobs WHERE id = $1`, [seed.jobId]);
    expect(row.rows[0].thank_you_sms_sent_at).toEqual(NOW);
    const events = await auditRepo.findByEntity(seed.tenantId, 'job', seed.jobId);
    expect(events.filter((e) => e.eventType === 'notification.thank_you_sms.sent')).toHaveLength(1);
  });
  /**
   * #1184 — follow-up to #1140. The audit claim (`thank_you_sms_audit:{jobId}`)
   * used to be inserted ALREADY 'sent' before `auditRepo.create` ran, as a
   * separate statement, and after the job was stamped. A failed audit write
   * (connection drop, RLS/config error) or a crash between the two statements
   * therefore left the job with one real SMS and ZERO
   * `notification.thank_you_sms.sent` rows forever: the stamp stopped the job
   * being re-selected, and the spent claim would have skipped the audit anyway.
   * And a sweep with no `auditRepo` spent the claim without writing anything.
   *
   * These tests pin the fix: the claim is 'claimed' until the audit row lands
   * (then 'sent'), a failed write releases it and leaves the job unstamped so
   * the next sweep reconciles the audit without resending, a crash-abandoned
   * claim is stale-reclaimed like `claimSend`, and no claim is taken at all
   * without an `auditRepo`.
   */
  describe('#1184 — the audit claim is spent only once the audit row is written', () => {
    const SENT = 'notification.thank_you_sms.sent';

    async function sentAuditRows(tenantId: string, jobId: string) {
      const events = await auditRepo.findByEntity(tenantId, 'job', jobId);
      return events.filter((e) => e.eventType === SENT);
    }

    async function suppressedAuditRows(tenantId: string, jobId: string) {
      const events = await auditRepo.findByEntity(tenantId, 'job', jobId);
      return events.filter((e) => e.eventType === 'notification.thank_you_sms.suppressed');
    }

    async function auditClaim(tenantId: string, jobId: string): Promise<string | null> {
      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
        [tenantId, `thank_you_sms_audit:${jobId}`],
      );
      return rows[0]?.status ?? null;
    }

    async function stampOf(jobId: string): Promise<Date | null> {
      const { rows } = await pool.query<{ thank_you_sms_sent_at: Date | null }>(
        `SELECT thank_you_sms_sent_at FROM jobs WHERE id = $1`,
        [jobId],
      );
      return rows[0].thank_you_sms_sent_at;
    }

    /**
     * The real Pg audit repository, except that its FIRST
     * `notification.thank_you_sms.sent` write for `failTenantId` throws — a
     * connection drop / RLS error standing in. Every other write (the other
     * tenant's, the retry) goes to real Postgres.
     */
    function auditRepoFailingOnceFor(failTenantId: string): { repo: PgAuditRepository; failures: () => number } {
      let failures = 0;
      const repo = Object.create(auditRepo) as PgAuditRepository;
      repo.create = async (event) => {
        if (failures === 0 && event.tenantId === failTenantId && event.eventType === SENT) {
          failures++;
          throw new Error('synthetic audit write failure (#1184)');
        }
        return auditRepo.create(event);
      };
      return { repo, failures: () => failures };
    }

    it('auditRepo.create throws once → two sweeps: exactly ONE sent audit row and exactly ONE SMS — and the neighbour tenant is untouched (T2)', async () => {
      const a = await seedTenantWithJob();
      const b = await seedTenantWithJob();
      const base = new InMemoryDeliveryProvider();
      const dispatcher = realGateDispatcher(base);
      const flaky = auditRepoFailingOnceFor(a.tenantId);

      const first = await runThankYouSmsSweep({
        pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo: flaky.repo, logger,
        now: () => NOW,
      });
      expect(flaky.failures()).toBe(1);
      expect(first.failed).toBeGreaterThanOrEqual(1);
      // The SMS went out, but with no audit row the claim is NOT spent and the
      // job is NOT stamped — so the next sweep can still record the audit.
      expect(base.sentSms.filter((m) => m.to === a.phone)).toHaveLength(1);
      expect(await sentAuditRows(a.tenantId, a.jobId)).toHaveLength(0);
      expect(await auditClaim(a.tenantId, a.jobId)).toBeNull();
      expect(await stampOf(a.jobId)).toBeNull();

      await runThankYouSmsSweep({
        pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo: flaky.repo, logger,
        now: () => NOW,
      });

      // Tenant A: one real SMS (no resend), exactly one audit row, claim spent, job stamped.
      expect(base.sentSms.filter((m) => m.to === a.phone)).toHaveLength(1);
      expect(await sentAuditRows(a.tenantId, a.jobId)).toHaveLength(1);
      expect(await auditClaim(a.tenantId, a.jobId)).toBe('sent');
      expect(await stampOf(a.jobId)).toEqual(NOW);

      // Tenant B (divergent: its audit write never failed): one SMS, one audit
      // row written by the FIRST sweep, nothing added by the second.
      expect(base.sentSms.filter((m) => m.to === b.phone)).toHaveLength(1);
      expect(await sentAuditRows(b.tenantId, b.jobId)).toHaveLength(1);
      expect(await auditClaim(b.tenantId, b.jobId)).toBe('sent');
      expect(await stampOf(b.jobId)).toEqual(NOW);
      // And neither tenant's job audit is visible under the other's id.
      expect(await auditRepo.findByEntity(a.tenantId, 'job', b.jobId)).toHaveLength(0);
      expect(await auditRepo.findByEntity(b.tenantId, 'job', a.jobId)).toHaveLength(0);
    });

    it('a sweep with NO auditRepo sends and stamps but does not spend the audit claim', async () => {
      const seed = await seedTenantWithJob();
      const base = new InMemoryDeliveryProvider();
      const dispatcher = realGateDispatcher(base);

      await runThankYouSmsSweep({
        pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, logger,
        now: () => NOW,
      });

      expect(base.sentSms.filter((m) => m.to === seed.phone)).toHaveLength(1);
      expect(await stampOf(seed.jobId)).toEqual(NOW);
      expect(await auditClaim(seed.tenantId, seed.jobId)).toBeNull();
      expect(await sentAuditRows(seed.tenantId, seed.jobId)).toHaveLength(0);
    });

    it('a crash-abandoned audit claim (still "claimed", past the stale window) is reclaimed: the audit row is written once, no resend', async () => {
      const seed = await seedTenantWithJob();
      // State a crash leaves: the SMS went out (send claim 'sent'), the audit
      // claim was taken but the process died before the row landed, and the job
      // was never stamped.
      await pool.query(
        `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at, sent_at)
         VALUES ($1, $2, 'sent', NOW(), NOW())`,
        [seed.tenantId, `thank_you_sms:${seed.jobId}`],
      );
      await pool.query(
        `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at)
         VALUES ($1, $2, 'claimed', NOW() - INTERVAL '20 minutes')`,
        [seed.tenantId, `thank_you_sms_audit:${seed.jobId}`],
      );
      const base = new InMemoryDeliveryProvider();
      const dispatcher = realGateDispatcher(base);

      await runThankYouSmsSweep({
        pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
        now: () => NOW,
      });

      expect(base.sentSms.filter((m) => m.to === seed.phone)).toHaveLength(0);
      expect(await sentAuditRows(seed.tenantId, seed.jobId)).toHaveLength(1);
      expect(await auditClaim(seed.tenantId, seed.jobId)).toBe('sent');
      expect(await stampOf(seed.jobId)).toEqual(NOW);
    });
    /**
     * Review finding on PR #1196 (MEDIUM). With the audit write retryable, "SMS
     * delivered, audit write failed, job unstamped" is a normal state. If the
     * customer opts out before the next sweep (a STOP reply to the thank-you
     * itself), the permanent-suppression checks used to run BEFORE the worker
     * learnt the SMS claim was already 'sent', so the job was stamped with a
     * `notification.thank_you_sms.suppressed` row for a message that was
     * delivered, and the `sent` row was never written.
     */
    it('an SMS already sent is reconciled, never suppressed, when the customer replies STOP between a failed audit write and the next sweep — and a neighbour already on DNC is still suppressed (T2)', async () => {
      const a = await seedTenantWithJob();
      const b = await seedTenantWithJob();
      const base = new InMemoryDeliveryProvider();
      const dispatcher = realGateDispatcher(base);
      const flaky = auditRepoFailingOnceFor(a.tenantId);
      const stop = buildStopKeywordHandler({
        dncRepo,
        consentRepo: new PgConsentEventRepository(pool),
        customerRepo,
        pool,
      });
      // Tenant B (divergent): its customer opted out BEFORE any thank-you went out.
      await stop.handle({ tenantId: b.tenantId, fromE164: b.phone, body: 'STOP', messageSid: `SM${uuidv4()}` });

      await runThankYouSmsSweep({
        pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo: flaky.repo, logger,
        now: () => NOW,
      });
      expect(flaky.failures()).toBe(1);
      expect(base.sentSms.filter((m) => m.to === a.phone)).toHaveLength(1);
      expect(await sentAuditRows(a.tenantId, a.jobId)).toHaveLength(0);
      expect(await stampOf(a.jobId)).toBeNull();

      // Tenant A's customer replies STOP to the thank-you, through the real handler.
      const handled = await stop.handle({
        tenantId: a.tenantId, fromE164: a.phone, body: 'STOP', messageSid: `SM${uuidv4()}`,
      });
      expect(handled.handled).toBe(true);
      expect(await dncRepo.isOnDnc(a.tenantId, normalizePhone(a.phone))).toBe(true);

      await runThankYouSmsSweep({
        pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo: flaky.repo, logger,
        now: () => NOW,
      });

      // Tenant A: one SMS, exactly one `sent` row, zero `suppressed` rows, stamped.
      expect(base.sentSms.filter((m) => m.to === a.phone)).toHaveLength(1);
      expect(await sentAuditRows(a.tenantId, a.jobId)).toHaveLength(1);
      expect(await suppressedAuditRows(a.tenantId, a.jobId)).toHaveLength(0);
      expect(await stampOf(a.jobId)).toEqual(NOW);

      // Tenant B: never sent, suppressed exactly once as on_dnc, stamped.
      expect(base.sentSms.filter((m) => m.to === b.phone)).toHaveLength(0);
      const bSuppressed = await suppressedAuditRows(b.tenantId, b.jobId);
      expect(bSuppressed).toHaveLength(1);
      expect((bSuppressed[0].metadata as { reason?: string }).reason).toBe('on_dnc');
      expect(await sentAuditRows(b.tenantId, b.jobId)).toHaveLength(0);
      expect(await stampOf(b.jobId)).toEqual(NOW);
    });

    it('an SMS already sent is reconciled, never suppressed, when smsConsent is revoked between a failed audit write and the next sweep', async () => {
      const seed = await seedTenantWithJob();
      const base = new InMemoryDeliveryProvider();
      const dispatcher = realGateDispatcher(base);
      const flaky = auditRepoFailingOnceFor(seed.tenantId);

      await runThankYouSmsSweep({
        pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo: flaky.repo, logger,
        now: () => NOW,
      });
      expect(flaky.failures()).toBe(1);
      expect(base.sentSms.filter((m) => m.to === seed.phone)).toHaveLength(1);
      expect(await stampOf(seed.jobId)).toBeNull();

      // The owner revokes SMS consent on the customer record (the repository write the app uses).
      const updated = await customerRepo.update(seed.tenantId, seed.customerId, { smsConsent: false });
      expect(updated?.smsConsent).toBe(false);

      await runThankYouSmsSweep({
        pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo: flaky.repo, logger,
        now: () => NOW,
      });

      expect(base.sentSms.filter((m) => m.to === seed.phone)).toHaveLength(1);
      expect(await sentAuditRows(seed.tenantId, seed.jobId)).toHaveLength(1);
      expect(await suppressedAuditRows(seed.tenantId, seed.jobId)).toHaveLength(0);
      expect(await stampOf(seed.jobId)).toEqual(NOW);
    });

    /**
     * Review finding on PR #1196 (LOW). The audit claim's completion
     * (`markSendClaimComplete`) is a separate statement after the audit row
     * commits. If it fails, the claim stays 'claimed' and a sweep past the
     * stale window used to reclaim it and write a SECOND `sent` row.
     */
    it('a stale audit claim whose audit row already committed is completed without writing a second row', async () => {
      const seed = await seedTenantWithJob();
      const base = new InMemoryDeliveryProvider();
      const dispatcher = realGateDispatcher(base);
      const auditKey = `thank_you_sms_audit:${seed.jobId}`;
      // The real pool, except the audit claim's completion UPDATE fails once
      // (a transient DB error after the audit row committed).
      let completionFailures = 0;
      const flakyPool = {
        query: (sql: string, params?: unknown[]) => {
          if (
            completionFailures === 0 &&
            /UPDATE send_claims SET status = 'sent'/.test(sql) &&
            Array.isArray(params) && params[1] === auditKey
          ) {
            completionFailures++;
            return Promise.reject(new Error('synthetic claim-completion failure (#1184 review)'));
          }
          return pool.query(sql, params as unknown[]);
        },
      } as unknown as Pool;

      await runThankYouSmsSweep({
        pool: flakyPool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
        now: () => NOW,
      });
      expect(completionFailures).toBe(1);
      expect(base.sentSms.filter((m) => m.to === seed.phone)).toHaveLength(1);
      expect(await sentAuditRows(seed.tenantId, seed.jobId)).toHaveLength(1);
      expect(await auditClaim(seed.tenantId, seed.jobId)).toBe('claimed');
      expect(await stampOf(seed.jobId)).toBeNull();

      // The stale window passes (claimSend compares against NOW(); there is no
      // clock seam, so the claim's own timestamp is aged instead).
      await pool.query(
        `UPDATE send_claims SET claimed_at = NOW() - INTERVAL '20 minutes'
          WHERE tenant_id = $1 AND claim_key = $2`,
        [seed.tenantId, auditKey],
      );

      await runThankYouSmsSweep({
        pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
        now: () => NOW,
      });

      expect(base.sentSms.filter((m) => m.to === seed.phone)).toHaveLength(1);
      expect(await sentAuditRows(seed.tenantId, seed.jobId)).toHaveLength(1);
      expect(await auditClaim(seed.tenantId, seed.jobId)).toBe('sent');
      expect(await stampOf(seed.jobId)).toEqual(NOW);
    });
  });
});
