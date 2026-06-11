import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runDailyDigestSweep,
  isDigestDue,
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
      findByStatus: async () => o.proposals ?? [],
    } as unknown as ProposalRepository,
    customerRepo: { findById: async () => null } as unknown as CustomerRepository,
    settingsRepo: (settingsRepo ?? new InMemorySettingsRepository()) as never,
    now: () => DUE_NOW,
  };
}

describe('isDigestDue (tenant-local 15-min bucket matching)', () => {
  it('fires when the local digest_time is inside the just-passed bucket (now inclusive)', () => {
    expect(isDigestDue({ digestTime: '18:00', timezone: TZ, now: DUE_NOW })).toBe(true);
    // Exactly at `now` local wall clock.
    expect(isDigestDue({ digestTime: '18:05', timezone: TZ, now: DUE_NOW })).toBe(true);
  });

  it('does not fire outside the bucket (already-fired earlier slot, or future slot)', () => {
    // 17:50 is the exclusive lower bound of (17:50, 18:05].
    expect(isDigestDue({ digestTime: '17:50', timezone: TZ, now: DUE_NOW })).toBe(false);
    expect(isDigestDue({ digestTime: '18:06', timezone: TZ, now: DUE_NOW })).toBe(false);
    expect(isDigestDue({ digestTime: '12:00', timezone: TZ, now: DUE_NOW })).toBe(false);
  });

  it('handles the bucket wrapping local midnight', () => {
    // 00:05 local in Chicago → bucket (23:50, 00:05].
    const justPastMidnight = new Date('2026-06-12T05:05:00Z');
    expect(isDigestDue({ digestTime: '23:55', timezone: TZ, now: justPastMidnight })).toBe(true);
    expect(isDigestDue({ digestTime: '00:05', timezone: TZ, now: justPastMidnight })).toBe(true);
    expect(isDigestDue({ digestTime: '23:45', timezone: TZ, now: justPastMidnight })).toBe(false);
  });

  it('accepts the HH:MM:SS shape the TIME column emits and rejects garbage', () => {
    expect(isDigestDue({ digestTime: '18:00:00', timezone: TZ, now: DUE_NOW })).toBe(true);
    expect(isDigestDue({ digestTime: 'whenever', timezone: TZ, now: DUE_NOW })).toBe(false);
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
    expect(result).toEqual({ tenants: 0, generated: 0, sent: 0, skipped: 0, failed: 0 });
  });

  it('exports the 15-minute sweep cadence app.ts drives', () => {
    expect(DIGEST_SWEEP_INTERVAL_MS).toBe(15 * 60 * 1000);
  });
});
