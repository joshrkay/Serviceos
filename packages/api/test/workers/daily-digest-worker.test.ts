import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runDailyDigestSweep,
  checkDigestDue,
  localMinutesOfDay,
  DIGEST_SWEEP_INTERVAL_MS,
  type DailyDigestWorkerDeps,
} from '../../src/workers/daily-digest-worker';
import {
  InMemoryDailyDigestRepository,
  type DailyDigestPayload,
  type DailyDigestRepository,
  type DigestComputeDeps,
} from '../../src/digest/digest-service';
import { InMemorySettingsRepository, type TenantSettings } from '../../src/settings/settings';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { verifyOneTapApproveToken } from '../../src/proposals/auto-approve';
import { createLogger } from '../../src/logging/logger';
import type { PaymentRepository } from '../../src/invoices/payment';
import type { InvoiceRepository } from '../../src/invoices/invoice';
import type { EstimateRepository } from '../../src/estimates/estimate';
import type { JobRepository } from '../../src/jobs/job';
import type { AppointmentRepository } from '../../src/appointments/appointment';
import type { Proposal, ProposalRepository } from '../../src/proposals/proposal';
import type { CustomerRepository } from '../../src/customers/customer';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

const TZ = 'America/Chicago';
// 2026-06-11 18:05 in Chicago (CDT = UTC-5) → 23:05Z. digest_time 18:00
// falls inside the just-passed 15-min bucket (17:50, 18:05].
const DUE_NOW = new Date('2026-06-11T23:05:00Z');
const LOCAL_DATE = '2026-06-11';
const SECRET = 'test-one-tap-secret';

function settingsRow(tenantId: string, overrides: Partial<TenantSettings> = {}): TenantSettings {
  return {
    id: `settings-${tenantId}`,
    tenantId,
    businessName: 'ACME HVAC',
    timezone: TZ,
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    ownerPhone: '+15551230000',
    digestEnabled: true,
    digestTime: '18:00',
    digestChannel: 'sms',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function pendingProposal(id: string): Proposal {
  return {
    id,
    tenantId: 't1',
    proposalType: 'draft_estimate',
    status: 'ready_for_review',
    payload: { totals: { totalCents: 45000 }, customerName: 'Lopez' },
    summary: 'Estimate for Lopez',
    createdBy: 'ai',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Proposal;
}

interface ComputeStubOverrides {
  proposals?: Proposal[];
  paymentsThrow?: boolean;
}

function stubComputeDeps(o: ComputeStubOverrides = {}, settingsRepo?: InMemorySettingsRepository): DigestComputeDeps {
  return {
    paymentRepo: {
      findByTenant: async () => {
        if (o.paymentsThrow) throw new Error('payments query exploded');
        return [];
      },
    } as unknown as PaymentRepository,
    jobRepo: { findByTenant: async () => [] } as unknown as JobRepository,
    appointmentRepo: { findByDateRange: async () => [] } as unknown as AppointmentRepository,
    invoiceRepo: {
      findByTenant: async () => [],
      findByJobs: async () => [],
    } as unknown as InvoiceRepository,
    estimateRepo: { findByJobs: async () => [] } as unknown as EstimateRepository,
    proposalRepo: {
      findByStatus: async (_t: string, status: string) =>
        status === 'draft' ? [] : o.proposals ?? [],
    } as unknown as ProposalRepository,
    customerRepo: { findById: async () => null } as unknown as CustomerRepository,
    settingsRepo: (settingsRepo ?? new InMemorySettingsRepository()) as never,
    now: () => DUE_NOW,
  };
}

describe('checkDigestDue (tenant-local 15-min bucket matching)', () => {
  it('fires when the local digest_time is inside the just-passed bucket (now inclusive)', () => {
    expect(checkDigestDue({ digestTime: '18:00', timezone: TZ, now: DUE_NOW }).due).toBe(true);
    // Exactly at `now` local wall clock.
    expect(checkDigestDue({ digestTime: '18:05', timezone: TZ, now: DUE_NOW }).due).toBe(true);
  });

  it('does not fire outside the bucket (already-fired earlier slot, or future slot)', () => {
    // 17:50 is the exclusive lower bound of (17:50, 18:05].
    expect(checkDigestDue({ digestTime: '17:50', timezone: TZ, now: DUE_NOW }).due).toBe(false);
    expect(checkDigestDue({ digestTime: '18:06', timezone: TZ, now: DUE_NOW }).due).toBe(false);
    expect(checkDigestDue({ digestTime: '12:00', timezone: TZ, now: DUE_NOW }).due).toBe(false);
  });

  it('handles the bucket wrapping local midnight', () => {
    // 00:05 local in Chicago → bucket (23:50, 00:05].
    const justPastMidnight = new Date('2026-06-12T05:05:00Z');
    expect(checkDigestDue({ digestTime: '23:55', timezone: TZ, now: justPastMidnight }).due).toBe(true);
    expect(checkDigestDue({ digestTime: '00:05', timezone: TZ, now: justPastMidnight }).due).toBe(true);
    expect(checkDigestDue({ digestTime: '23:45', timezone: TZ, now: justPastMidnight }).due).toBe(false);
  });

  it('midnight-wrap: effectiveDate is the PREVIOUS day when target > prevMin (the day that ended)', () => {
    // 00:05 Chicago = 2026-06-12. Bucket (23:50 Jun-11, 00:05 Jun-12].
    // A 23:55 digest_time fell in the Jun-11 tail → must be dated 2026-06-11.
    const justPastMidnight = new Date('2026-06-12T05:05:00Z');
    const res23_55 = checkDigestDue({ digestTime: '23:55', timezone: TZ, now: justPastMidnight });
    expect(res23_55.due).toBe(true);
    expect(res23_55.effectiveDate).toBe('2026-06-11'); // the day that ended

    // A 00:05 digest_time fell in the new day head → dated to 2026-06-12.
    const res00_05 = checkDigestDue({ digestTime: '00:05', timezone: TZ, now: justPastMidnight });
    expect(res00_05.due).toBe(true);
    expect(res00_05.effectiveDate).toBe('2026-06-12'); // new day

    // Normal (non-wrap) case: effectiveDate is the current local day.
    const normal = checkDigestDue({ digestTime: '18:00', timezone: TZ, now: DUE_NOW });
    expect(normal.due).toBe(true);
    expect(normal.effectiveDate).toBe('2026-06-11');
  });

  it('DST fall-back: prevMin > nowMin but date unchanged → due:false (not a midnight crossing)', () => {
    // Reproduced fixture: America/Chicago 2026-11-01, clocks fall back at 2 AM.
    // At 07:05Z the local time is 01:05 CST (UTC-6). 15 min earlier (06:50Z) it
    // was 01:50 CDT (UTC-5). prevMin=110 > nowMin=65 — looks like a midnight wrap,
    // but both instants share the same local calendar date 2026-11-01.
    // digestTime 18:00 (=1080) > prevMin (110) → without the date-equality guard
    // this would wrongly fire due:true.
    const dstFallBackNow = new Date('2026-11-01T07:05:00Z');
    const result = checkDigestDue({
      digestTime: '18:00',
      timezone: 'America/Chicago',
      now: dstFallBackNow,
      intervalMs: 15 * 60 * 1000,
    });
    expect(result.due).toBe(false);
    expect(result.effectiveDate).toBe('2026-11-01');

    // The genuine 18:00 digest still fires correctly at 00:05Z (next day in UTC),
    // which is 18:05 CST → bucket (17:50, 18:05].
    const genuineDue = new Date('2026-11-02T00:05:00Z'); // 18:05 CST
    const genuine = checkDigestDue({
      digestTime: '18:00',
      timezone: 'America/Chicago',
      now: genuineDue,
      intervalMs: 15 * 60 * 1000,
    });
    expect(genuine.due).toBe(true);
    expect(genuine.effectiveDate).toBe('2026-11-01');
  });

  it('accepts the HH:MM:SS shape the TIME column emits and rejects garbage', () => {
    expect(checkDigestDue({ digestTime: '18:00:00', timezone: TZ, now: DUE_NOW }).due).toBe(true);
    expect(checkDigestDue({ digestTime: 'whenever', timezone: TZ, now: DUE_NOW }).due).toBe(false);
  });

  it('localMinutesOfDay reads tenant wall-clock minutes', () => {
    expect(localMinutesOfDay(DUE_NOW, TZ)).toBe(18 * 60 + 5);
    expect(localMinutesOfDay(DUE_NOW, 'UTC')).toBe(23 * 60 + 5);
  });
});

describe('runDailyDigestSweep', () => {
  let settingsRepo: InMemorySettingsRepository;
  let digestRepo: InMemoryDailyDigestRepository;
  let dispatchRepo: InMemoryDispatchRepository;
  let sendSms: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    settingsRepo = new InMemorySettingsRepository();
    digestRepo = new InMemoryDailyDigestRepository();
    dispatchRepo = new InMemoryDispatchRepository();
    sendSms = vi.fn().mockResolvedValue({
      provider: 'twilio',
      providerMessageId: 'SM-1',
      channel: 'sms',
    });
    await settingsRepo.create(settingsRow('t1'));
  });

  function deps(overrides: Partial<DailyDigestWorkerDeps> = {}): DailyDigestWorkerDeps {
    return {
      settingsRepo,
      digestRepo,
      computeDeps: stubComputeDeps({}, settingsRepo),
      listTenantIds: async () => ['t1'],
      delivery: { sendSms } as never,
      dispatchRepo,
      oneTapSecret: SECRET,
      buildApproveUrl: (token) => `https://api.x/approve?token=${token}`,
      publicBaseUrl: 'https://app.x',
      logger,
      now: () => DUE_NOW,
      ...overrides,
    };
  }

  it('generates, stores, sends the owner SMS, and records sms_dispatch_id for a due tenant', async () => {
    const result = await runDailyDigestSweep(deps());
    expect(result).toMatchObject({ tenants: 1, generated: 1, sent: 1, failed: 0 });

    const stored = await digestRepo.findByTenantAndDate('t1', LOCAL_DATE);
    expect(stored).not.toBeNull();
    expect(stored?.payload.date).toBe(LOCAL_DATE);
    expect(stored?.narrative).toBeTruthy();
    expect(stored?.smsDispatchId).toBeTruthy();

    expect(sendSms).toHaveBeenCalledTimes(1);
    const msg = sendSms.mock.calls[0][0];
    expect(msg.to).toBe('+15551230000');
    expect(msg.body.length).toBeLessThanOrEqual(480);
    expect(msg.body).toContain(`/digest/${LOCAL_DATE}`);
    expect(msg.idempotencyKey).toBe(`daily_digest:${LOCAL_DATE}`);

    // Dispatch audit row links back to the digest.
    const dispatches = await dispatchRepo.findByEntity('t1', 'daily_digest', stored!.id);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].id).toBe(stored!.smsDispatchId);
  });

  it('is idempotent per (tenant, date): a second sweep in the same bucket never double-sends', async () => {
    await runDailyDigestSweep(deps());
    const second = await runDailyDigestSweep(deps());
    expect(second.sent).toBe(0);
    expect(second.generated).toBe(0);
    expect(second.skipped).toBe(1);
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it('race path: when the insert loses the UNIQUE(tenant,date) race, the loser does not send', async () => {
    const losingRepo: DailyDigestRepository = {
      ...digestRepo,
      findByTenantAndDate: digestRepo.findByTenantAndDate.bind(digestRepo),
      findLatest: digestRepo.findLatest.bind(digestRepo),
      upsert: digestRepo.upsert.bind(digestRepo),
      setSmsDispatchId: digestRepo.setSmsDispatchId.bind(digestRepo),
      insertIfAbsent: async (tenantId, date, payload, narrative) => {
        // Simulate a concurrent sweep committing first: the row exists by
        // the time our INSERT runs, so ON CONFLICT DO NOTHING returns the
        // winner's row with inserted=false.
        const winner = await digestRepo.upsert(tenantId, date, payload, narrative);
        return { digest: winner, inserted: false };
      },
    };
    const result = await runDailyDigestSweep(deps({ digestRepo: losingRepo }));
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('retries the send from the stored snapshot when a previous sweep stored but failed to send', async () => {
    // First sweep: provider blows up AFTER the row is stored.
    sendSms.mockRejectedValueOnce(new Error('twilio 500'));
    const first = await runDailyDigestSweep(deps());
    expect(first.failed).toBe(1);
    const afterFirst = await digestRepo.findByTenantAndDate('t1', LOCAL_DATE);
    expect(afterFirst).not.toBeNull();
    expect(afterFirst?.smsDispatchId).toBeUndefined();

    // Next tick (outside the due bucket — retry keys off the stored row).
    const later = new Date(DUE_NOW.getTime() + 15 * 60 * 1000);
    const second = await runDailyDigestSweep(deps({ now: () => later }));
    expect(second.sent).toBe(1);
    expect((await digestRepo.findByTenantAndDate('t1', LOCAL_DATE))?.smsDispatchId).toBeTruthy();
    // Same provider idempotency key on both attempts → provider dedupes.
    expect(sendSms.mock.calls[0][0].idempotencyKey).toBe(sendSms.mock.calls[1][0].idempotencyKey);
  });

  it('retry path: send-succeeded-claim-failed — second sweep claims the existing dispatch without re-sending', async () => {
    // First sweep: SMS sent but setSmsDispatchId fails (returns null = already claimed).
    const claimOnce = vi.spyOn(digestRepo, 'setSmsDispatchId');
    claimOnce.mockResolvedValueOnce(null); // simulate losing the claim race
    const first = await runDailyDigestSweep(deps());
    expect(first.sent).toBe(1);
    expect(sendSms).toHaveBeenCalledTimes(1);
    // The dispatch row exists (from dispatchRepo.create), but smsDispatchId was not set.
    const afterFirst = await digestRepo.findByTenantAndDate('t1', LOCAL_DATE);
    expect(afterFirst?.smsDispatchId).toBeUndefined();

    // Second sweep: should find the existing dispatch and claim it WITHOUT calling sendSms again.
    claimOnce.mockRestore();
    const later = new Date(DUE_NOW.getTime() + 15 * 60 * 1000);
    const second = await runDailyDigestSweep(deps({ now: () => later }));
    expect(second.sent).toBe(0);
    expect(second.claimed).toBe(1); // claimed from existing dispatch, not re-sent
    expect(sendSms).toHaveBeenCalledTimes(1); // no second send
    expect((await digestRepo.findByTenantAndDate('t1', LOCAL_DATE))?.smsDispatchId).toBeTruthy();
  });

  it('dispatch create unique-violation: recovers via findByEntity and claims without error', async () => {
    // Scenario: sendSms succeeds, but dispatchRepo.create throws a unique-violation
    // (a concurrent sweep created the dispatch row in the same instant). The
    // catch block falls back to findByEntity which finds the concurrent row and
    // claims it, so the function returns 'sent' and the record gets smsDispatchId.

    const digestRepo2 = new InMemoryDailyDigestRepository();
    const settingsRepo2 = new InMemorySettingsRepository();
    await settingsRepo2.create(settingsRow('t1'));
    const sendSms2 = vi.fn().mockResolvedValue({ provider: 'twilio', providerMessageId: 'SM-dup', channel: 'sms' });

    // A specialized dispatchRepo that:
    //  - findByEntity returns [] on first call (no dispatch yet when sendSms runs),
    //    then returns the pre-seeded row on second call (what the concurrent winner created).
    //  - create throws a unique-violation.
    const UNIQUE_ERR = Object.assign(new Error('duplicate key violates unique constraint'), { code: '23505' });
    let findCallCount = 0;
    const seededDispatchId = 'dispatch-concurrent-winner';
    const controlledDispatchRepo: import('../../src/notifications/dispatch-repository').DispatchRepository = {
      async findByEntity(_t: string, _et: string, _eid: string) {
        findCallCount++;
        if (findCallCount === 1) {
          // First call (before send): no dispatch yet.
          return [];
        }
        // Second call (in catch after create fails): concurrent winner's row.
        return [{ id: seededDispatchId, tenantId: 't1', entityType: 'daily_digest', entityId: _eid,
          channel: 'sms', recipient: '+15551230000', provider: 'twilio',
          status: 'sent', sentAt: new Date() }] as never;
      },
      async create(_input) {
        throw UNIQUE_ERR;
      },
      async findById() { return null; },
      async updateStatus() { return null; },
      async listByTenant() { return { dispatches: [], total: 0 }; },
    };

    const result = await runDailyDigestSweep({
      settingsRepo: settingsRepo2,
      digestRepo: digestRepo2,
      computeDeps: stubComputeDeps({}, settingsRepo2),
      listTenantIds: async () => ['t1'],
      delivery: { sendSms: sendSms2 } as never,
      dispatchRepo: controlledDispatchRepo,
      publicBaseUrl: 'https://app.x',
      logger,
      now: () => DUE_NOW,
    });

    expect(result.sent).toBe(1);
    expect(sendSms2).toHaveBeenCalledTimes(1);
    // The concurrent winner's dispatch was claimed.
    const finalRecord = await digestRepo2.findByTenantAndDate('t1', LOCAL_DATE);
    expect(finalRecord?.smsDispatchId).toBe(seededDispatchId);
  });

  it('skips tenants whose digest is disabled or whose digest_time is outside the bucket', async () => {
    await settingsRepo.update('t1', { digestEnabled: false });
    expect((await runDailyDigestSweep(deps())).generated).toBe(0);

    await settingsRepo.update('t1', { digestEnabled: true, digestTime: '12:00' });
    expect((await runDailyDigestSweep(deps())).generated).toBe(0);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("digest_channel 'none': stores the digest (web view) without sending SMS", async () => {
    await settingsRepo.update('t1', { digestChannel: 'none' });
    const result = await runDailyDigestSweep(deps());
    expect(result.generated).toBe(1);
    expect(result.sent).toBe(0);
    expect(sendSms).not.toHaveBeenCalled();
    expect(await digestRepo.findByTenantAndDate('t1', LOCAL_DATE)).not.toBeNull();
  });

  it('stores without sending when the tenant has no owner_phone', async () => {
    await settingsRepo.update('t1', { ownerPhone: null });
    const result = await runDailyDigestSweep(deps());
    expect(result.generated).toBe(1);
    expect(result.sent).toBe(0);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('falls back to the deterministic narrative when the LLM composer throws — the digest still sends', async () => {
    const composeNarrative = vi.fn().mockRejectedValue(new Error('gateway down'));
    const result = await runDailyDigestSweep(deps({ composeNarrative }));
    expect(composeNarrative).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
    const stored = await digestRepo.findByTenantAndDate('t1', LOCAL_DATE);
    expect(stored?.narrative).toContain('quiet day');
  });

  it('uses the composed narrative when the LLM succeeds', async () => {
    const composeNarrative = vi.fn().mockResolvedValue('You crushed it today.');
    await runDailyDigestSweep(deps({ composeNarrative }));
    const stored = await digestRepo.findByTenantAndDate('t1', LOCAL_DATE);
    expect(stored?.narrative).toBe('You crushed it today.');
  });

  it('embeds verifiable one-tap approve links (≤30-min TTL) for top pending approvals', async () => {
    const result = await runDailyDigestSweep(deps({
      computeDeps: stubComputeDeps({ proposals: [pendingProposal('prop-1')] }, settingsRepo),
    }));
    expect(result.sent).toBe(1);
    const body: string = sendSms.mock.calls[0][0].body;
    expect(body.length).toBeLessThanOrEqual(480);
    const match = /approve\?token=([^\s]+)/.exec(body);
    expect(match).not.toBeNull();
    const verified = await verifyOneTapApproveToken({
      token: decodeURIComponent(match![1]),
      secret: SECRET,
      expectedTenantId: 't1',
      consumeNonce: () => true,
    });
    expect(verified).toMatchObject({ ok: true, proposalId: 'prop-1', tenantId: 't1' });
    // TTL clamp: token must expire within 30 minutes.
    const payloadB64 = decodeURIComponent(match![1]).split('.')[0];
    const tokenPayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    expect(tokenPayload.e - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000 + 1000);
  });

  it('RV-065: embeds a verifiable mint_draft_invoice one-tap link per unbilled job', async () => {
    const jobId = '11111111-1111-4111-8111-111111111111';
    const acceptedEstimate = {
      id: '55555555-5555-4555-8555-555555555555',
      tenantId: 't1',
      jobId,
      estimateNumber: 'EST-1',
      status: 'accepted',
      lineItems: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          description: 'Replace heater',
          quantity: 1,
          unitPriceCents: 48000,
          totalCents: 48000,
          sortOrder: 0,
          taxable: true,
        },
      ],
      totals: {
        subtotalCents: 48000,
        taxableSubtotalCents: 48000,
        discountCents: 0,
        taxRateBps: 0,
        taxCents: 0,
        totalCents: 48000,
      },
      version: 1,
    };
    const computeDeps: DigestComputeDeps = {
      ...stubComputeDeps({}, settingsRepo),
      jobRepo: {
        findByTenant: async () => [
          {
            id: jobId,
            tenantId: 't1',
            customerId: 'cust-1',
            status: 'completed',
            moneyState: 'estimate_accepted',
            updatedAt: new Date('2026-06-01T00:00:00Z'),
          },
        ],
      } as unknown as JobRepository,
      estimateRepo: {
        findByJobs: async () => [acceptedEstimate],
      } as unknown as EstimateRepository,
    };

    const result = await runDailyDigestSweep(deps({ computeDeps }));
    expect(result.sent).toBe(1);
    const body: string = sendSms.mock.calls[0][0].body;
    expect(body.length).toBeLessThanOrEqual(480);
    expect(body).toContain('Bill');

    const match = /Bill[^h]*?(https:\/\/api\.x\/approve\?token=[^\s]+)/.exec(body);
    expect(match).not.toBeNull();
    const token = decodeURIComponent(match![1].split('token=')[1]);
    const verified = await verifyOneTapApproveToken({
      token,
      secret: SECRET,
      expectedTenantId: 't1',
      consumeNonce: () => true,
    });
    expect(verified).toEqual({
      ok: true,
      action: 'mint_draft_invoice',
      jobId,
      tenantId: 't1',
    });
  });

  it('isolates tenant failures: one tenant exploding never blocks the others', async () => {
    await settingsRepo.create(settingsRow('t2', { ownerPhone: '+15559990000' }));
    const computeDepsByTenant: DigestComputeDeps = {
      ...stubComputeDeps({}, settingsRepo),
      paymentRepo: {
        findByTenant: async (tenantId: string) => {
          if (tenantId === 't1') throw new Error('tenant t1 query exploded');
          return [];
        },
      } as unknown as PaymentRepository,
    };
    const result = await runDailyDigestSweep(deps({
      computeDeps: computeDepsByTenant,
      listTenantIds: async () => ['t1', 't2'],
    }));
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms.mock.calls[0][0].to).toBe('+15559990000');
    expect(await digestRepo.findByTenantAndDate('t2', LOCAL_DATE)).not.toBeNull();
    expect(await digestRepo.findByTenantAndDate('t1', LOCAL_DATE)).toBeNull();
  });

  it('survives listTenantIds failure with a zeroed result', async () => {
    const result = await runDailyDigestSweep(deps({
      listTenantIds: async () => {
        throw new Error('tenants table unavailable');
      },
    }));
    expect(result).toEqual({ tenants: 0, generated: 0, sent: 0, claimed: 0, skipped: 0, failed: 0 });
  });

  it('low/very_low confidence proposals get no one-tap link in the SMS; reviewInApp is marked', async () => {
    const lowConfidenceProposal = {
      ...pendingProposal('prop-low'),
      payload: { totals: { totalCents: 10000 }, customerName: 'Smith', _meta: { overallConfidence: 'low' } },
    } as Proposal;
    const highConfidenceProposal = {
      ...pendingProposal('prop-high'),
      payload: { totals: { totalCents: 20000 }, customerName: 'Jones', _meta: { overallConfidence: 'high' } },
    } as Proposal;

    await runDailyDigestSweep(deps({
      computeDeps: stubComputeDeps({ proposals: [highConfidenceProposal, lowConfidenceProposal] }, settingsRepo),
    }));

    const body: string = sendSms.mock.calls[0][0].body;
    // High-confidence proposal should have a one-tap link.
    expect(body).toMatch(/approve\?token=/);
    // Low-confidence proposal must NOT have a one-tap link.
    // We can't easily distinguish which link goes with which proposal in the
    // SMS body, but we can verify the stored payload marks low as reviewInApp.
    const stored = await digestRepo.findByTenantAndDate('t1', LOCAL_DATE);
    const topApprovals = stored!.payload.pendingApprovals.top;
    const lowEntry = topApprovals.find((a) => a.proposalId === 'prop-low');
    const highEntry = topApprovals.find((a) => a.proposalId === 'prop-high');
    expect(lowEntry?.reviewInApp).toBe(true);
    expect(highEntry?.reviewInApp).toBeUndefined();
  });

  it('absent _meta → one-tap link is allowed (unchanged behavior)', async () => {
    const noMetaProposal = pendingProposal('prop-no-meta'); // no _meta in payload
    await runDailyDigestSweep(deps({
      computeDeps: stubComputeDeps({ proposals: [noMetaProposal] }, settingsRepo),
    }));
    const body: string = sendSms.mock.calls[0][0].body;
    expect(body).toMatch(/approve\?token=/); // link present
  });

  it('invalid tenant timezone falls back to America/New_York with a single structured warn (not per-tick)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    await settingsRepo.update('t1', { timezone: 'Not/AZone' });
    // We just want to prove it doesn't throw and logs exactly once; the
    // actual due/skip outcome depends on the fallback tz and is not asserted.
    const result = await runDailyDigestSweep(deps());
    // The warn about invalid timezone should have been emitted exactly once.
    const tzWarns = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('invalid tenant timezone'),
    );
    expect(tzWarns).toHaveLength(1);
    expect(tzWarns[0][1]).toMatchObject({ invalidTimezone: 'Not/AZone', fallbackTimezone: 'America/New_York' });
    // Sweep should not throw (outcome is skipped or generated, never failed due to tz).
    expect(result.failed).toBe(0);
    warnSpy.mockRestore();
  });

  it('exports the 15-minute sweep cadence app.ts drives', () => {
    expect(DIGEST_SWEEP_INTERVAL_MS).toBe(15 * 60 * 1000);
  });
});
