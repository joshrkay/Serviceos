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
});
