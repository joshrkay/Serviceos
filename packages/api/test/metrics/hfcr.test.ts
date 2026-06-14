/**
 * HFCR computation tests.
 *
 * Pins the conservative attribution rule: a payment counts toward HFCR only
 * when its invoice's gating proposal chain was approved entirely off the web
 * (sms/voice/one_tap/auto), never 'ui'. Covers channel verdicts, chain
 * disqualification, auto-approval, refunds, period bounds, recovered-call
 * (voice) counting, and two-tenant isolation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { computeHfcrForTenant, HfcrPeriod } from '../../src/metrics/hfcr';
import { InMemoryPaymentRepository, Payment } from '../../src/invoices/payment';
import { InMemoryProposalRepository, Proposal } from '../../src/proposals/proposal';
import {
  InMemoryAuditRepository,
  createAuditEvent,
} from '../../src/audit/audit';

const TENANT = 't1';
const JUNE: HfcrPeriod = {
  from: new Date('2026-06-01T00:00:00Z'),
  to: new Date('2026-07-01T00:00:00Z'),
};

let paymentRepo: InMemoryPaymentRepository;
let proposalRepo: InMemoryProposalRepository;
let auditRepo: InMemoryAuditRepository;

beforeEach(() => {
  paymentRepo = new InMemoryPaymentRepository();
  proposalRepo = new InMemoryProposalRepository();
  auditRepo = new InMemoryAuditRepository();
});

function deps() {
  return { paymentRepo, proposalRepo, auditRepo };
}

function makePayment(over: Partial<Payment> = {}): Payment {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    invoiceId: 'inv',
    amountCents: 10000,
    method: 'credit_card',
    status: 'completed',
    receivedAt: new Date('2026-06-10T00:00:00Z'),
    processedBy: 'system:stripe_webhook',
    createdAt: new Date(),
    updatedAt: new Date(),
    refundedAmountCents: 0,
    refundedAt: null,
    lastRefundStripeId: null,
    reversedAt: null,
    reversalReason: null,
    ...over,
  };
}

function makeProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    proposalType: 'issue_invoice',
    status: 'executed',
    payload: {},
    summary: 'Issue invoice',
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

async function recordApproval(proposal: Proposal, channel?: string): Promise<void> {
  await auditRepo.create(
    createAuditEvent({
      tenantId: proposal.tenantId,
      actorId: 'u1',
      actorRole: 'owner',
      eventType: 'proposal.approved',
      entityType: 'proposal',
      entityId: proposal.id,
      metadata: {
        proposalType: proposal.proposalType,
        status: 'approved',
        ...(channel ? { channel } : {}),
      },
    }),
  );
}

/** Seed an invoice gated by a single proposal approved on `channel`, plus a payment. */
async function seedInvoice(
  invoiceId: string,
  channel: string | 'auto' | 'none',
  paymentOver: Partial<Payment> = {},
): Promise<void> {
  const proposal = makeProposal({ resultEntityId: invoiceId });
  await proposalRepo.create(proposal);
  if (channel !== 'auto' && channel !== 'none') await recordApproval(proposal, channel);
  // 'auto' → executed proposal with no approval event; 'none' handled by caller
  await paymentRepo.create(makePayment({ invoiceId, ...paymentOver }));
}

describe('computeHfcrForTenant', () => {
  it('counts a voice-approved invoice and marks it a recovered call', async () => {
    await seedInvoice('inv-voice', 'voice');
    const r = await computeHfcrForTenant(TENANT, JUNE, deps());
    expect(r.hfcrCents).toBe(10000);
    expect(r.handsFreeInvoiceCount).toBe(1);
    expect(r.recoveredCallCount).toBe(1);
  });

  it('counts sms / one_tap / auto approvals as hands-free (not recovered calls)', async () => {
    await seedInvoice('inv-sms', 'sms', { amountCents: 5000 });
    await seedInvoice('inv-onetap', 'one_tap', { amountCents: 3000 });
    await seedInvoice('inv-auto', 'auto', { amountCents: 2000 }); // executed, no approval event
    const r = await computeHfcrForTenant(TENANT, JUNE, deps());
    expect(r.hfcrCents).toBe(10000);
    expect(r.handsFreeInvoiceCount).toBe(3);
    expect(r.recoveredCallCount).toBe(0);
  });

  it('EXCLUDES an invoice approved on the web (ui)', async () => {
    await seedInvoice('inv-web', 'ui');
    const r = await computeHfcrForTenant(TENANT, JUNE, deps());
    expect(r.hfcrCents).toBe(0);
    expect(r.handsFreeInvoiceCount).toBe(0);
    expect(r.consideredPaymentCount).toBe(1);
  });

  it('EXCLUDES an approval with an unknown (unstamped) channel — conservative', async () => {
    const proposal = makeProposal({ resultEntityId: 'inv-legacy' });
    await proposalRepo.create(proposal);
    await recordApproval(proposal); // no channel stamped
    await paymentRepo.create(makePayment({ invoiceId: 'inv-legacy' }));
    const r = await computeHfcrForTenant(TENANT, JUNE, deps());
    expect(r.hfcrCents).toBe(0);
  });

  it('EXCLUDES an invoice with no gating proposal (hand-created in the app)', async () => {
    await paymentRepo.create(makePayment({ invoiceId: 'inv-orphan' }));
    const r = await computeHfcrForTenant(TENANT, JUNE, deps());
    expect(r.hfcrCents).toBe(0);
    expect(r.consideredPaymentCount).toBe(1);
  });

  it('disqualifies the whole invoice when ANY chain sibling was web-approved', async () => {
    const chainId = 'chain-1';
    // The issue proposal that produced the invoice was voice-approved...
    const issue = makeProposal({ resultEntityId: 'inv-chain', chainId });
    // ...but a sibling in the same chain was approved on the web.
    const sibling = makeProposal({ proposalType: 'create_customer', chainId });
    await proposalRepo.create(issue);
    await proposalRepo.create(sibling);
    await recordApproval(issue, 'voice');
    await recordApproval(sibling, 'ui');
    await paymentRepo.create(makePayment({ invoiceId: 'inv-chain' }));

    const r = await computeHfcrForTenant(TENANT, JUNE, deps());
    expect(r.hfcrCents).toBe(0); // a single web tap in the chain disqualifies
  });

  it('nets partial refunds out of the HFCR total', async () => {
    await seedInvoice('inv-refund', 'voice', {
      amountCents: 10000,
      refundedAmountCents: 2500,
    });
    const r = await computeHfcrForTenant(TENANT, JUNE, deps());
    expect(r.hfcrCents).toBe(7500);
  });

  it('ignores payments outside the period and reversed (failed) payments', async () => {
    await seedInvoice('inv-may', 'voice', { receivedAt: new Date('2026-05-30T00:00:00Z') });
    // A reversed payment is status 'failed' — findByTenant(status:'completed') skips it.
    await seedInvoice('inv-reversed', 'voice', {
      status: 'failed',
      reversedAt: new Date('2026-06-12T00:00:00Z'),
    });
    const r = await computeHfcrForTenant(TENANT, JUNE, deps());
    expect(r.hfcrCents).toBe(0);
    expect(r.consideredPaymentCount).toBe(0);
  });

  it('sums multiple payments on the same hands-free invoice once per invoice', async () => {
    const proposal = makeProposal({ resultEntityId: 'inv-multi' });
    await proposalRepo.create(proposal);
    await recordApproval(proposal, 'sms');
    await paymentRepo.create(makePayment({ invoiceId: 'inv-multi', amountCents: 4000 }));
    await paymentRepo.create(makePayment({ invoiceId: 'inv-multi', amountCents: 6000 }));
    const r = await computeHfcrForTenant(TENANT, JUNE, deps());
    expect(r.hfcrCents).toBe(10000);
    expect(r.handsFreeInvoiceCount).toBe(1);
  });

  it('isolates tenants — t2 payments never bleed into t1 HFCR', async () => {
    await seedInvoice('inv-t1', 'voice');
    // A t2 invoice + voice approval + payment under tenant t2.
    const t2Proposal: Proposal = makeProposal({ tenantId: 't2', resultEntityId: 'inv-t2' });
    await proposalRepo.create(t2Proposal);
    await recordApproval(t2Proposal, 'voice');
    await paymentRepo.create(makePayment({ tenantId: 't2', invoiceId: 'inv-t2', amountCents: 99999 }));

    const r = await computeHfcrForTenant(TENANT, JUNE, deps());
    expect(r.hfcrCents).toBe(10000); // only t1's invoice
    expect(r.consideredPaymentCount).toBe(1);
  });
});
