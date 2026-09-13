import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { InMemoryCustomerRepository, type Customer } from '../../src/customers/customer';
import { InMemorySettingsRepository, type TenantSettings } from '../../src/settings/settings';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryJobRepository, type Job } from '../../src/jobs/job';
import { createLogger } from '../../src/logging/logger';
import type { FeedbackDispatcher } from '../../src/feedback/dispatcher';
import { MessageDeliveryFeedbackDispatcher } from '../../src/feedback/dispatcher';
import {
  GatedMessageDelivery,
  SmsSuppressedError,
} from '../../src/notifications/gated-message-delivery';
import type {
  MessageDeliveryProvider,
  SmsMessage,
} from '../../src/notifications/delivery-provider';
import {
  runThankYouSmsSweep,
  type ThankYouSmsWorkerDeps,
} from '../../src/workers/thank-you-sms-worker';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

const TENANT = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

const NOW = new Date('2026-06-17T15:00:00Z');
const ONE_HOUR_AGO = new Date(NOW.getTime() - 60 * 60 * 1000);
const THREE_HOURS_AGO = new Date(NOW.getTime() - 3 * 60 * 60 * 1000);

interface FakePoolState {
  rows: Array<{ id: string; tenant_id: string }>;
}

function fakePool(state: FakePoolState): Pool {
  return {
    query: vi.fn(async (_sql: string, _params: unknown[]) => {
      return {
        rows: state.rows,
        rowCount: state.rows.length,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as unknown as QueryResult;
    }),
  } as unknown as Pool;
}

/**
 * T4-F01 claim-aware fake pool — real fakePool() above returns the same
 * eligibility rows for every query, which is too coarse to exercise
 * send_claims semantics (claim/reclaim/tombstone). This variant additionally
 * simulates the send_claims table with a real in-memory Map so the
 * claim-before-send scenarios below observe genuine claim/reclaim/duplicate
 * behavior, matching send-claim-ledger.ts's exact SQL shapes. Full proof of
 * the actual SQL against real Postgres lives in
 * test/integration/thank-you-sms-worker.test.ts (Docker-gated).
 */
interface ClaimRow {
  status: 'claimed' | 'sending' | 'sent';
  claimedAt: number;
}

function claimAwarePool(
  state: FakePoolState,
  claims: Map<string, ClaimRow> = new Map(),
): { pool: Pool; claims: Map<string, ClaimRow> } {
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('send_claims')) {
      const key = `${params[0]}::${params[1]}`;
      if (sql.trim().startsWith('INSERT')) {
        const staleMinutes = Number(params[2]);
        const existing = claims.get(key);
        if (!existing) {
          claims.set(key, { status: 'claimed', claimedAt: Date.now() });
          return { rows: [{ claim_key: params[1] }], rowCount: 1 } as unknown as QueryResult;
        }
        const staleMs = staleMinutes * 60_000;
        // Only ever reclaims 'claimed' rows — a 'sending' row (provider call
        // in flight or crashed mid-flight) is NEVER auto-reclaimed, matching
        // claimSend's real WHERE clause.
        if (existing.status === 'claimed' && Date.now() - existing.claimedAt >= staleMs) {
          existing.claimedAt = Date.now();
          return { rows: [{ claim_key: params[1] }], rowCount: 1 } as unknown as QueryResult;
        }
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      if (sql.trim().startsWith('UPDATE')) {
        const existing = claims.get(key);
        // Distinguish the sending-transition UPDATE from the completion
        // UPDATE by SQL text so the fake models the intermediate state.
        if (existing) existing.status = sql.includes("'sending'") ? 'sending' : 'sent';
        return { rows: [], rowCount: existing ? 1 : 0 } as unknown as QueryResult;
      }
      if (sql.trim().startsWith('DELETE')) {
        const existing = claims.get(key);
        if (existing?.status === 'claimed' || existing?.status === 'sending') claims.delete(key);
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }
      if (sql.trim().startsWith('SELECT')) {
        // withSendClaim reads the losing claim's status to report priorStatus.
        const existing = claims.get(key);
        return {
          rows: existing ? [{ status: existing.status }] : [],
          rowCount: existing ? 1 : 0,
        } as unknown as QueryResult;
      }
    }
    return {
      rows: state.rows,
      rowCount: state.rows.length,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as unknown as QueryResult;
  });
  return { pool: { query } as unknown as Pool, claims };
}

function makeJob(overrides: Partial<Job>): Job {
  return {
    id: overrides.id ?? 'job-1',
    tenantId: overrides.tenantId ?? TENANT,
    customerId: overrides.customerId ?? 'cust-1',
    locationId: 'loc-1',
    jobNumber: 'JOB-0001',
    summary: 'Test job',
    status: 'completed',
    priority: 'normal',
    completedAt: overrides.completedAt ?? THREE_HOURS_AGO,
    createdBy: 'system',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: overrides.id ?? 'cust-1',
    tenantId: overrides.tenantId ?? TENANT,
    firstName: 'Mary',
    lastName: 'Johnson',
    displayName: 'Mary Johnson',
    primaryPhone: '+15551234567',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'test',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('runThankYouSmsSweep', () => {
  let jobRepo: InMemoryJobRepository;
  let customerRepo: InMemoryCustomerRepository;
  let settingsRepo: InMemorySettingsRepository;
  let dncRepo: InMemoryDncRepository;
  let auditRepo: InMemoryAuditRepository;
  let dispatcher: FeedbackDispatcher;
  let send: ReturnType<typeof vi.fn<[{ to: string; body: string }], Promise<void>>>;

  beforeEach(async () => {
    jobRepo = new InMemoryJobRepository();
    customerRepo = new InMemoryCustomerRepository();
    settingsRepo = new InMemorySettingsRepository();
    dncRepo = new InMemoryDncRepository();
    auditRepo = new InMemoryAuditRepository();
    send = vi.fn(async (_input: { to: string; body: string }) => undefined as void);
    dispatcher = { send } as unknown as FeedbackDispatcher;

    await settingsRepo.create(baseSettings(TENANT, 'Acme Plumbing'));
  });

  function baseSettings(tenantId: string, businessName: string, overrides: Partial<TenantSettings> = {}): TenantSettings {
    return {
      id: `s-${tenantId}`,
      tenantId,
      businessName,
      timezone: 'America/Phoenix',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 14,
      sendThankYouSms: true,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  function deps(rows: Array<{ id: string; tenant_id: string }>, overrides: Partial<ThankYouSmsWorkerDeps> = {}): ThankYouSmsWorkerDeps {
    return {
      pool: fakePool({ rows }),
      jobRepo,
      customerRepo,
      settingsRepo,
      dncRepo,
      dispatcher,
      auditRepo,
      logger,
      now: () => NOW,
      ...overrides,
    };
  }

  it('returns zeroed result with no pool (in-memory dev posture)', async () => {
    const result = await runThankYouSmsSweep({
      pool: null,
      jobRepo,
      customerRepo,
      settingsRepo,
      dncRepo,
      dispatcher,
      auditRepo,
      logger,
      now: () => NOW,
    });
    expect(result).toEqual({ tenants: 0, candidates: 0, sent: 0, suppressed: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends one SMS for an eligible completed job, stamps the idempotency column, and emits the sent audit event', async () => {
    const job = makeJob({});
    await jobRepo.create(job);
    await customerRepo.create(makeCustomer());

    const result = await runThankYouSmsSweep(deps([{ id: job.id, tenant_id: TENANT }]));

    expect(result).toEqual({ tenants: 1, candidates: 1, sent: 1, suppressed: 0, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    // The full payload the production gate needs. This assertion used to stop
    // at { to, body } — an exact-match on the defect, which is why no unit
    // test flagged it (PR #994, Codex P1).
    expect(send).toHaveBeenCalledWith({
      to: '+15551234567',
      body: expect.stringContaining('Acme Plumbing'),
      tenantId: TENANT,
      consent: { smsConsent: true, customerId: 'cust-1' },
    });

    const stamped = await jobRepo.findById(TENANT, job.id);
    expect(stamped?.thankYouSmsSentAt).toEqual(NOW);

    const events = await auditRepo.findByEntity(TENANT, 'job', job.id);
    expect(events.some((e) => e.eventType === 'notification.thank_you_sms.sent')).toBe(true);
  });

  it('suppresses when the customer has no primary phone, sets the stamp, audits the reason', async () => {
    const job = makeJob({});
    await jobRepo.create(job);
    await customerRepo.create(makeCustomer({ primaryPhone: undefined }));

    const result = await runThankYouSmsSweep(deps([{ id: job.id, tenant_id: TENANT }]));

    expect(result.sent).toBe(0);
    expect(result.suppressed).toBe(1);
    expect(send).not.toHaveBeenCalled();

    const stamped = await jobRepo.findById(TENANT, job.id);
    // Idempotency: stamp set so the sweep stops re-evaluating this row.
    expect(stamped?.thankYouSmsSentAt).toEqual(NOW);

    const events = await auditRepo.findByEntity(TENANT, 'job', job.id);
    const suppressed = events.find((e) => e.eventType === 'notification.thank_you_sms.suppressed');
    expect(suppressed?.metadata).toMatchObject({ reason: 'no_phone' });
  });

  it('suppresses when the customer has not consented to SMS', async () => {
    const job = makeJob({});
    await jobRepo.create(job);
    await customerRepo.create(makeCustomer({ smsConsent: false }));

    const result = await runThankYouSmsSweep(deps([{ id: job.id, tenant_id: TENANT }]));

    expect(result.suppressed).toBe(1);
    expect(send).not.toHaveBeenCalled();
    const events = await auditRepo.findByEntity(TENANT, 'job', job.id);
    expect(
      events.find((e) => e.eventType === 'notification.thank_you_sms.suppressed')?.metadata,
    ).toMatchObject({ reason: 'no_sms_consent' });
  });

  it('suppresses when the customer phone is on the tenant DNC list', async () => {
    const job = makeJob({});
    await jobRepo.create(job);
    await customerRepo.create(makeCustomer());
    await dncRepo.addToDnc(TENANT, '+15551234567', 'test');

    const result = await runThankYouSmsSweep(deps([{ id: job.id, tenant_id: TENANT }]));

    expect(result.suppressed).toBe(1);
    expect(send).not.toHaveBeenCalled();
    const events = await auditRepo.findByEntity(TENANT, 'job', job.id);
    expect(
      events.find((e) => e.eventType === 'notification.thank_you_sms.suppressed')?.metadata,
    ).toMatchObject({ reason: 'on_dnc' });
  });

  it('records a transient failure when dispatcher throws and leaves the stamp null so the next sweep retries', async () => {
    const job = makeJob({});
    await jobRepo.create(job);
    await customerRepo.create(makeCustomer());
    send.mockRejectedValueOnce(new Error('Twilio 503'));

    const result = await runThankYouSmsSweep(deps([{ id: job.id, tenant_id: TENANT }]));

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    const stamped = await jobRepo.findById(TENANT, job.id);
    expect(stamped?.thankYouSmsSentAt).toBeUndefined();
    // No sent audit event on a transient failure.
    const events = await auditRepo.findByEntity(TENANT, 'job', job.id);
    expect(events.some((e) => e.eventType === 'notification.thank_you_sms.sent')).toBe(false);
  });

  it('defense-in-depth: skips a tenant whose settings flipped to send_thank_you_sms=false between the query and the per-tenant pass', async () => {
    const job = makeJob({});
    await jobRepo.create(job);
    await customerRepo.create(makeCustomer());
    // Simulate the toggle being flipped after the SELECT but before sweepTenant.
    await settingsRepo.update(TENANT, { sendThankYouSms: false });

    const result = await runThankYouSmsSweep(deps([{ id: job.id, tenant_id: TENANT }]));

    expect(result.tenants).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.suppressed).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('isolates per-tenant failures: a broken tenant does not stop a healthy one', async () => {
    const jobA = makeJob({ id: 'job-a', tenantId: TENANT });
    const jobB = makeJob({ id: 'job-b', tenantId: TENANT_B, customerId: 'cust-b' });
    await jobRepo.create(jobA);
    await jobRepo.create(jobB);
    await customerRepo.create(makeCustomer());
    await customerRepo.create(makeCustomer({ id: 'cust-b', tenantId: TENANT_B }));
    await settingsRepo.create(baseSettings(TENANT_B, 'Bob HVAC'));

    const result = await runThankYouSmsSweep(
      deps([
        { id: 'job-a', tenant_id: TENANT },
        { id: 'job-b', tenant_id: TENANT_B },
      ]),
    );

    expect(result.tenants).toBe(2);
    expect(result.candidates).toBe(2);
    expect(result.sent).toBe(2);
  });

  describe('T4-F01 — claim-before-send', () => {
    it('crash-between-claim-and-send recovery: a stale claim is reclaimed and the sweep sends', async () => {
      const job = makeJob({});
      await jobRepo.create(job);
      await customerRepo.create(makeCustomer());
      const { pool, claims } = claimAwarePool({ rows: [{ id: job.id, tenant_id: TENANT }] });
      // Pre-seed a claim >15min old — simulates a crash before/during a prior send attempt.
      claims.set(`${TENANT}::thank_you_sms:${job.id}`, {
        status: 'claimed',
        claimedAt: Date.now() - 20 * 60_000,
      });

      const result = await runThankYouSmsSweep(deps([], { pool }));

      expect(result.sent).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      const stamped = await jobRepo.findById(TENANT, job.id);
      expect(stamped?.thankYouSmsSentAt).toEqual(NOW);
    });

    it('Codex P2 (PR #705) — crash-between-send-and-mark: a "sent" claim with no thankYouSmsSentAt is RECONCILED (stamped, not resent)', async () => {
      const job = makeJob({});
      await jobRepo.create(job);
      await customerRepo.create(makeCustomer());
      const { pool, claims } = claimAwarePool({ rows: [{ id: job.id, tenant_id: TENANT }] });
      // Simulates the crash landing after the provider send succeeded but
      // before the job-row write — the claim ledger's tombstone is set, the
      // business-level completion field is not. Left null forever, the
      // eligibility query re-selects this job every tick (oldest-first, LIMIT
      // 500) and can starve newer jobs — so the sweep must reconcile the stamp.
      claims.set(`${TENANT}::thank_you_sms:${job.id}`, { status: 'sent', claimedAt: Date.now() });

      const result = await runThankYouSmsSweep(deps([], { pool }));

      // No resend (SMS already went out) but the missing stamp is reconciled so
      // the job stops being re-selected.
      expect(send).not.toHaveBeenCalled();
      expect(result.sent).toBe(1);
      const stamped = await jobRepo.findById(TENANT, job.id);
      expect(stamped?.thankYouSmsSentAt).toEqual(NOW);
    });

    it('a "claimed" (in-flight) duplicate is left for the owning attempt — not resent, not stamped by this sweep', async () => {
      const job = makeJob({});
      await jobRepo.create(job);
      await customerRepo.create(makeCustomer());
      const { pool, claims } = claimAwarePool({ rows: [{ id: job.id, tenant_id: TENANT }] });
      // A fresh in-flight claim held by a concurrent sweep (NOT sent yet).
      claims.set(`${TENANT}::thank_you_sms:${job.id}`, { status: 'claimed', claimedAt: Date.now() });

      const result = await runThankYouSmsSweep(deps([], { pool }));

      expect(send).not.toHaveBeenCalled();
      expect(result.suppressed).toBe(1);
      // The owning (in-flight) attempt will stamp it; this sweep must not.
      const stamped = await jobRepo.findById(TENANT, job.id);
      expect(stamped?.thankYouSmsSentAt).toBeUndefined();
    });

    it('concurrent sweep runs racing the same job: exactly one send', async () => {
      const job = makeJob({});
      await jobRepo.create(job);
      await customerRepo.create(makeCustomer());
      const { pool, claims } = claimAwarePool({ rows: [{ id: job.id, tenant_id: TENANT }] });

      await Promise.all([
        runThankYouSmsSweep(deps([], { pool })),
        runThankYouSmsSweep(deps([], { pool })),
      ]);

      // The invariant that matters: the provider is called exactly once (no
      // double-send). The metrics `sent` sum is not asserted — a loser that
      // observes the winner's 'sent' tombstone legitimately reconciles the
      // stamp (Codex P2) and also counts, but it never re-invokes the provider.
      expect(send).toHaveBeenCalledTimes(1);
      expect(claims.get(`${TENANT}::thank_you_sms:${job.id}`)?.status).toBe('sent');
      const stamped = await jobRepo.findById(TENANT, job.id);
      expect(stamped?.thankYouSmsSentAt).toEqual(NOW);
    });

    it('a dispatcher throw releases the claim so the very next tick can retry', async () => {
      const job = makeJob({});
      await jobRepo.create(job);
      await customerRepo.create(makeCustomer());
      const { pool, claims } = claimAwarePool({ rows: [{ id: job.id, tenant_id: TENANT }] });
      send.mockRejectedValueOnce(new Error('Twilio 503'));

      const first = await runThankYouSmsSweep(deps([], { pool }));
      expect(first.failed).toBe(1);
      expect(claims.has(`${TENANT}::thank_you_sms:${job.id}`)).toBe(false); // released, not stale-waiting

      const second = await runThankYouSmsSweep(deps([], { pool }));
      expect(second.sent).toBe(1);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * PR #994, Codex P1 — the production wiring, not a substitute for it.
   *
   * `app.ts` hands this worker a `MessageDeliveryFeedbackDispatcher` wrapping
   * the SINGLE `GatedMessageDelivery` object, and the gate tags this send
   * customer-class. Every other test in this file (and the sweep fan-out
   * integration test) injects a bare `{ send: vi.fn() }`, so none of them could
   * see that the worker was calling that chain with `{ to, body }` only: the
   * gate then failed closed with `missing_consent_context`, and because
   * `TCPA_CONSENT_ENFORCEMENT` resolves to 'block' in prod/staging when unset,
   * EVERY thank-you SMS was suppressed in production while the suite stayed
   * green.
   *
   * These two tests compose the real adapter over the real gate. The first is
   * the regression guard: revert the `tenantId`/`consent` arguments in
   * `sendOneThankYou` and it fails with `missing_consent_context`.
   */
  describe('the production dispatch chain (gated delivery, block mode)', () => {
    function gatedDispatcher(env?: NodeJS.ProcessEnv): {
      dispatcher: FeedbackDispatcher;
      sentSms: SmsMessage[];
    } {
      const sentSms: SmsMessage[] = [];
      const base: MessageDeliveryProvider = {
        sendSms: async (message) => {
          sentSms.push(message);
          return { id: 'sid-1', status: 'sent' } as never;
        },
        sendEmail: async () => ({ id: 'eid-1', status: 'sent' }) as never,
      };
      const gate = new GatedMessageDelivery({
        base,
        dnc: dncRepo,
        auditRepo,
        // The prod/staging default when TCPA_CONSENT_ENFORCEMENT is unset.
        enforcement: 'block',
        // Kill-switch seam; defaults to process.env when absent.
        ...(env ? { env } : {}),
      });
      return { dispatcher: new MessageDeliveryFeedbackDispatcher(gate), sentSms };
    }

    it('a consenting customer is actually sent to through the real gate', async () => {
      const job = makeJob({});
      await jobRepo.create(job);
      await customerRepo.create(makeCustomer());
      const { dispatcher: gated, sentSms } = gatedDispatcher();

      const result = await runThankYouSmsSweep(
        deps([{ id: job.id, tenant_id: TENANT }], { dispatcher: gated }),
      );

      expect(result.sent).toBe(1);
      expect(result.suppressed).toBe(0);
      // The gate let it through, so the bytes reached the base provider…
      expect(sentSms).toHaveLength(1);
      // …tagged customer-class, and carrying the two fields whose absence made
      // the gate fail closed.
      expect(sentSms[0]).toMatchObject({
        to: '+15551234567',
        recipientClass: 'customer',
        tenantId: TENANT,
        consent: { smsConsent: true, customerId: 'cust-1' },
      });
    });

    it('a gate suppression is terminal — stamped and audited, never retried', async () => {
      const job = makeJob({});
      await jobRepo.create(job);
      await customerRepo.create(makeCustomer());
      // The gate's own verdict, e.g. a revocation that arrived on another
      // channel and sits in the consent ledger this worker does not read. The
      // local smsConsent + DNC guards both passed to get here.
      const suppressing: FeedbackDispatcher = {
        send: async () => {
          throw new SmsSuppressedError('revoked');
        },
      };

      const result = await runThankYouSmsSweep(
        deps([{ id: job.id, tenant_id: TENANT }], { dispatcher: suppressing }),
      );

      expect(result.suppressed).toBe(1);
      // Not counted as a transient failure — that is what would re-select this
      // job on every tick forever.
      expect(result.failed).toBe(0);
      const stamped = await jobRepo.findById(TENANT, job.id);
      expect(stamped?.thankYouSmsSentAt).toEqual(NOW);
      const events = await auditRepo.findByEntity(TENANT, 'job', job.id);
      expect(
        events.some(
          (e) =>
            e.eventType === 'notification.thank_you_sms.suppressed' &&
            String((e.metadata as { reason?: string } | undefined)?.reason).startsWith(
              'consent_gate:',
            ),
        ),
      ).toBe(true);
    });

    /**
     * PR #994, Codex P1 (second) — raised against the fix for the first.
     *
     * The kill switch is thrown by the SAME `SmsSuppressedError` type, ahead of
     * the owner bypass and of any consent evaluation, off an env var read per
     * send. Catching every instance of that error as terminal meant a
     * ten-minute `TELEPHONY_ENABLED=false` incident response permanently
     * discarded every thank-you it touched.
     */
    it('the kill switch is RETRYABLE — not stamped, and sends once telephony is back', async () => {
      const job = makeJob({});
      await jobRepo.create(job);
      await customerRepo.create(makeCustomer());
      const off = gatedDispatcher({ TELEPHONY_ENABLED: 'false' });

      const during = await runThankYouSmsSweep(
        deps([{ id: job.id, tenant_id: TENANT }], { dispatcher: off.dispatcher }),
      );

      expect(off.sentSms).toHaveLength(0);
      // Transient, so it counts as a failure and NOT as a handled suppression.
      expect(during.failed).toBe(1);
      expect(during.suppressed).toBe(0);
      // The absence of this stamp is the whole finding: with it, the job is
      // never re-selected and the customer is never thanked.
      const afterOutage = await jobRepo.findById(TENANT, job.id);
      expect(afterOutage?.thankYouSmsSentAt).toBeFalsy();

      // Telephony restored — the same job is still eligible and now sends.
      const back = gatedDispatcher();
      const after = await runThankYouSmsSweep(
        deps([{ id: job.id, tenant_id: TENANT }], { dispatcher: back.dispatcher }),
      );
      expect(after.sent).toBe(1);
      expect(back.sentSms).toHaveLength(1);
    });

    it('an unexpected missing_consent_context is retryable too, not silently consumed', async () => {
      const job = makeJob({});
      await jobRepo.create(job);
      await customerRepo.create(makeCustomer());
      // Only reachable via a wiring regression now that both fields are
      // forwarded; it must surface rather than eat a customer message.
      const broken: FeedbackDispatcher = {
        send: async () => {
          throw new SmsSuppressedError('missing_consent_context');
        },
      };

      const result = await runThankYouSmsSweep(
        deps([{ id: job.id, tenant_id: TENANT }], { dispatcher: broken }),
      );

      expect(result.failed).toBe(1);
      expect(result.suppressed).toBe(0);
      const stamped = await jobRepo.findById(TENANT, job.id);
      expect(stamped?.thankYouSmsSentAt).toBeFalsy();
    });
  });
});
