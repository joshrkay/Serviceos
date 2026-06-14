/**
 * Weekly HFCR owner-summary sweep tests.
 *
 * Covers: composing + sending one SMS per tenant for the completed week,
 * record-first idempotency (no double-send on re-sweep), the $0 skip
 * (no spam), the no-owner-phone skip, and two-tenant isolation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  runHfcrWeeklySendSweep,
  composeWeeklyHfcrSms,
  startOfWeekUTC,
  HfcrWeeklySendDeps,
} from '../../src/workers/hfcr-weekly-send-worker';
import { InMemoryPaymentRepository, Payment } from '../../src/invoices/payment';
import { InMemoryProposalRepository, Proposal } from '../../src/proposals/proposal';
import { InMemoryAuditRepository, createAuditEvent } from '../../src/audit/audit';
import { InMemoryHfcrWeeklySendRepository } from '../../src/metrics/hfcr-weekly-send';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const NOW = new Date('2026-06-17T12:00:00Z');
const THIS_MONDAY = startOfWeekUTC(NOW);
const PREV_MONDAY = new Date(THIS_MONDAY.getTime() - 7 * 24 * 60 * 60 * 1000);
// A timestamp inside the just-completed week [PREV_MONDAY, THIS_MONDAY).
const IN_LAST_WEEK = new Date(PREV_MONDAY.getTime() + 2 * 24 * 60 * 60 * 1000);
const WEEK_KEY = PREV_MONDAY.toISOString().slice(0, 10);

let paymentRepo: InMemoryPaymentRepository;
let proposalRepo: InMemoryProposalRepository;
let auditRepo: InMemoryAuditRepository;
let hfcrSendRepo: InMemoryHfcrWeeklySendRepository;
let sentSms: Array<{ to: string; body: string }>;

beforeEach(() => {
  paymentRepo = new InMemoryPaymentRepository();
  proposalRepo = new InMemoryProposalRepository();
  auditRepo = new InMemoryAuditRepository();
  hfcrSendRepo = new InMemoryHfcrWeeklySendRepository();
  sentSms = [];
});

function deps(over: Partial<HfcrWeeklySendDeps> = {}): HfcrWeeklySendDeps {
  return {
    paymentRepo,
    proposalRepo,
    auditRepo,
    hfcrSendRepo,
    resolveOwnerPhone: async () => '+15551230000',
    sendSms: async (args) => {
      sentSms.push(args);
    },
    listTenantIds: async () => ['t1'],
    logger,
    now: () => NOW,
    ...over,
  };
}

/** Seed a voice-approved invoice paid in the completed week for `tenantId`. */
async function seedHandsFree(tenantId: string, invoiceId: string, amountCents: number) {
  const proposal: Proposal = {
    id: uuidv4(),
    tenantId,
    proposalType: 'issue_invoice',
    status: 'executed',
    payload: {},
    summary: 'Issue invoice',
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    resultEntityId: invoiceId,
  };
  await proposalRepo.create(proposal);
  await auditRepo.create(
    createAuditEvent({
      tenantId,
      actorId: 'u1',
      actorRole: 'owner',
      eventType: 'proposal.approved',
      entityType: 'proposal',
      entityId: proposal.id,
      metadata: { channel: 'voice' },
    }),
  );
  const payment: Payment = {
    id: uuidv4(),
    tenantId,
    invoiceId,
    amountCents,
    method: 'credit_card',
    status: 'completed',
    receivedAt: IN_LAST_WEEK,
    processedBy: 'system:stripe_webhook',
    createdAt: new Date(),
    updatedAt: new Date(),
    refundedAmountCents: 0,
    refundedAt: null,
    lastRefundStripeId: null,
    reversedAt: null,
    reversalReason: null,
  };
  await paymentRepo.create(payment);
}

describe('runHfcrWeeklySendSweep', () => {
  it('texts the owner the weekly hands-free total and records the send', async () => {
    await seedHandsFree('t1', 'inv-1', 50000);
    const result = await runHfcrWeeklySendSweep(deps());

    expect(result).toEqual({ tenants: 1, sent: 1, failed: 0 });
    expect(sentSms).toHaveLength(1);
    expect(sentSms[0].to).toBe('+15551230000');
    expect(sentSms[0].body).toContain('$500.00');
    expect(sentSms[0].body).toMatch(/recovered 1 call/);

    const row = await hfcrSendRepo.findByWeek('t1', WEEK_KEY);
    expect(row).not.toBeNull();
    expect(row!.hfcrCents).toBe(50000);
  });

  it('is idempotent — a second sweep does not re-send', async () => {
    await seedHandsFree('t1', 'inv-1', 50000);
    await runHfcrWeeklySendSweep(deps());
    const second = await runHfcrWeeklySendSweep(deps());

    expect(second.sent).toBe(0);
    expect(sentSms).toHaveLength(1); // not 2
  });

  it('does not record the send when SMS delivery fails — so it retries next sweep', async () => {
    await seedHandsFree('t1', 'inv-1', 50000);
    let failSend = true;
    const flakyDeps = deps({
      sendSms: async (args) => {
        if (failSend) throw new Error('gateway timeout');
        sentSms.push(args);
      },
    });

    const first = await runHfcrWeeklySendSweep(flakyDeps);
    expect(first.sent).toBe(0);
    expect(first.failed).toBe(1);
    expect(sentSms).toHaveLength(0);
    // No ledger row written → the week is NOT silently dropped.
    expect(await hfcrSendRepo.findByWeek('t1', WEEK_KEY)).toBeNull();

    // Sender recovers on the next tick → summary delivered + recorded once.
    failSend = false;
    const second = await runHfcrWeeklySendSweep(flakyDeps);
    expect(second.sent).toBe(1);
    expect(sentSms).toHaveLength(1);
    expect(await hfcrSendRepo.findByWeek('t1', WEEK_KEY)).not.toBeNull();
  });

  it('skips a tenant with no hands-free revenue (no $0 spam, no row)', async () => {
    // A web-approved invoice → not hands-free → nothing to summarize.
    const proposal: Proposal = {
      id: uuidv4(),
      tenantId: 't1',
      proposalType: 'issue_invoice',
      status: 'executed',
      payload: {},
      summary: 's',
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
      resultEntityId: 'inv-web',
    };
    await proposalRepo.create(proposal);
    await auditRepo.create(
      createAuditEvent({
        tenantId: 't1',
        actorId: 'u1',
        actorRole: 'owner',
        eventType: 'proposal.approved',
        entityType: 'proposal',
        entityId: proposal.id,
        metadata: { channel: 'ui' },
      }),
    );
    await paymentRepo.create({
      id: uuidv4(),
      tenantId: 't1',
      invoiceId: 'inv-web',
      amountCents: 9999,
      method: 'credit_card',
      status: 'completed',
      receivedAt: IN_LAST_WEEK,
      processedBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
      refundedAmountCents: 0,
      refundedAt: null,
      lastRefundStripeId: null,
      reversedAt: null,
      reversalReason: null,
    });

    const result = await runHfcrWeeklySendSweep(deps());
    expect(result.sent).toBe(0);
    expect(sentSms).toHaveLength(0);
    expect(await hfcrSendRepo.findByWeek('t1', WEEK_KEY)).toBeNull();
  });

  it('skips a tenant with no owner phone', async () => {
    await seedHandsFree('t1', 'inv-1', 50000);
    const result = await runHfcrWeeklySendSweep(deps({ resolveOwnerPhone: async () => null }));
    expect(result.sent).toBe(0);
    expect(sentSms).toHaveLength(0);
  });

  it('isolates tenants — each owner gets only their own HFCR', async () => {
    await seedHandsFree('t1', 'inv-1', 50000);
    await seedHandsFree('t2', 'inv-2', 70000);

    await runHfcrWeeklySendSweep(
      deps({
        listTenantIds: async () => ['t1', 't2'],
        resolveOwnerPhone: async (tid) => (tid === 't1' ? '+1111' : '+2222'),
      }),
    );

    expect(sentSms).toHaveLength(2);
    const t1Sms = sentSms.find((s) => s.to === '+1111');
    const t2Sms = sentSms.find((s) => s.to === '+2222');
    expect(t1Sms!.body).toContain('$500.00');
    expect(t2Sms!.body).toContain('$700.00');
  });
});

describe('composeWeeklyHfcrSms', () => {
  it('includes the recovered-call count when > 0', () => {
    expect(composeWeeklyHfcrSms(123456, 3)).toContain('$1,234.56');
    expect(composeWeeklyHfcrSms(123456, 3)).toContain('recovered 3 calls');
  });

  it('omits the call clause when no calls were recovered', () => {
    const msg = composeWeeklyHfcrSms(50000, 0);
    expect(msg).toContain('$500.00');
    expect(msg).not.toMatch(/recovered/);
  });
});

describe('startOfWeekUTC', () => {
  it('returns the UTC Monday of the containing week', () => {
    // 2026-06-17 is a Wednesday → Monday is 2026-06-15.
    expect(startOfWeekUTC(new Date('2026-06-17T12:00:00Z')).toISOString().slice(0, 10)).toBe('2026-06-15');
    // A Monday maps to itself.
    expect(startOfWeekUTC(new Date('2026-06-15T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-06-15');
    // A Sunday maps back to the prior Monday.
    expect(startOfWeekUTC(new Date('2026-06-21T23:59:59Z')).toISOString().slice(0, 10)).toBe('2026-06-15');
  });
});
