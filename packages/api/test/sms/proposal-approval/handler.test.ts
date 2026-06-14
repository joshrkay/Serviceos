import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryUserRepository, User } from '../../../src/users/user';
import {
  InMemoryProposalRepository,
  Proposal,
  ProposalStatus,
} from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryDeliveryProvider } from '../../../src/notifications/delivery-provider';
import { InboundSmsContext } from '../../../src/sms/inbound-dispatch';
import {
  handleProposalApprovalSms,
  ProposalApprovalHandlerDeps,
} from '../../../src/sms/proposal-approval/handler';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = '33333333-3333-3333-3333-333333333333';
const OWNER_MOBILE = '+15551230002';
const TECH_ID = '22222222-2222-2222-2222-222222222222';
const TECH_MOBILE = '+15551230001';

let seq = 0;
function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  seq += 1;
  return {
    id: `p-${seq}`,
    tenantId: TENANT,
    proposalType: 'draft_invoice',
    status: 'ready_for_review' as ProposalStatus,
    payload: {
      customerId: 'c-1',
      jobId: 'j-1',
      lineItems: [{ description: 'Water Heater', quantity: 1, unitPriceCents: 185_000 }],
    },
    summary: 'invoice Acme for the water heater',
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface Harness {
  deps: ProposalApprovalHandlerDeps;
  proposalRepo: InMemoryProposalRepository;
  delivery: InMemoryDeliveryProvider;
  auditRepo: InMemoryAuditRepository;
}

async function buildHarness(): Promise<Harness> {
  const userRepo = new InMemoryUserRepository();
  const owner: Omit<User, 'createdAt' | 'updatedAt'> = {
    id: OWNER_ID,
    tenantId: TENANT,
    email: 'owner@example.com',
    role: 'owner',
    canFieldServe: true,
    mobileNumber: OWNER_MOBILE,
  };
  const tech: Omit<User, 'createdAt' | 'updatedAt'> = {
    id: TECH_ID,
    tenantId: TENANT,
    email: 'tech@example.com',
    role: 'technician',
    canFieldServe: true,
    mobileNumber: TECH_MOBILE,
  };
  await userRepo.create(owner);
  await userRepo.create(tech);

  const proposalRepo = new InMemoryProposalRepository();
  const delivery = new InMemoryDeliveryProvider();
  const auditRepo = new InMemoryAuditRepository();

  return {
    proposalRepo,
    delivery,
    auditRepo,
    deps: { userRepo, proposalRepo, messageDelivery: delivery, auditRepo },
  };
}

function ctx(body: string, from = OWNER_MOBILE, messageSid = 'SM-1'): InboundSmsContext {
  return { tenantId: TENANT, fromE164: from, body, messageSid };
}

describe('handleProposalApprovalSms', () => {
  let h: Harness;
  beforeEach(async () => {
    seq = 0;
    h = await buildHarness();
  });

  it('approves the single pending proposal on a bare APPROVE (one-tap)', async () => {
    await h.proposalRepo.create(makeProposal());

    const result = await handleProposalApprovalSms(ctx('APPROVE'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'approved' });
    const after = await h.proposalRepo.findById(TENANT, 'p-1');
    expect(after?.status).toBe('approved');
    expect(after?.approvedAt).toBeInstanceOf(Date);
    // Owner gets a confirmation text.
    expect(h.delivery.sentSms).toHaveLength(1);
    expect(h.delivery.sentSms[0].to).toBe(OWNER_MOBILE);
    expect(h.delivery.sentSms[0].body).toContain('✓ Approved');
    expect(h.auditRepo.getAll().some((e) => e.eventType === 'proposal_approval.sms_approved')).toBe(
      true,
    );
  });

  it('rejects the single pending proposal on a bare NO', async () => {
    await h.proposalRepo.create(makeProposal());

    const result = await handleProposalApprovalSms(ctx('DECLINE'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'rejected' });
    const after = await h.proposalRepo.findById(TENANT, 'p-1');
    expect(after?.status).toBe('rejected');
    expect(after?.rejectionReason).toBe('sms_rejected');
    expect(h.delivery.sentSms[0].body).toContain('✓ Declined');
  });

  it('uses the code to pick the right proposal among several', async () => {
    await h.proposalRepo.create(
      makeProposal({ id: 'p-a', sourceContext: { smsApproval: { code: 'AAAA' } } }),
    );
    await h.proposalRepo.create(
      makeProposal({ id: 'p-b', sourceContext: { smsApproval: { code: 'BBBB' } } }),
    );

    await handleProposalApprovalSms(ctx('APPROVE BBBB'), h.deps);

    expect((await h.proposalRepo.findById(TENANT, 'p-b'))?.status).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, 'p-a'))?.status).toBe('ready_for_review');
  });

  it('asks for a code when several are pending and none was given', async () => {
    await h.proposalRepo.create(makeProposal({ id: 'p-a' }));
    await h.proposalRepo.create(makeProposal({ id: 'p-b' }));

    const result = await handleProposalApprovalSms(ctx('APPROVE'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'needs_code' });
    expect(h.delivery.sentSms[0].body).toContain('2 items');
    // Nothing was approved.
    expect((await h.proposalRepo.findById(TENANT, 'p-a'))?.status).toBe('ready_for_review');
    expect((await h.proposalRepo.findById(TENANT, 'p-b'))?.status).toBe('ready_for_review');
  });

  it('replies not_found for an unknown code', async () => {
    await h.proposalRepo.create(
      makeProposal({ id: 'p-a', sourceContext: { smsApproval: { code: 'AAAA' } } }),
    );

    const result = await handleProposalApprovalSms(ctx('APPROVE ZZZZ'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'not_found' });
    expect(h.delivery.sentSms[0].body).toMatch(/already be handled/i);
    expect((await h.proposalRepo.findById(TENANT, 'p-a'))?.status).toBe('ready_for_review');
  });

  it('replies nothing_pending when the queue is empty', async () => {
    const result = await handleProposalApprovalSms(ctx('APPROVE'), h.deps);
    expect(result).toMatchObject({ handled: true, reason: 'nothing_pending' });
    expect(h.delivery.sentSms[0].body).toMatch(/caught up/i);
  });

  it('ignores unknown mobile numbers with NO reply (never text strangers)', async () => {
    await h.proposalRepo.create(makeProposal());

    const result = await handleProposalApprovalSms(ctx('APPROVE', '+15559999999'), h.deps);

    expect(result).toMatchObject({ handled: false, reason: 'unknown_mobile' });
    expect(h.delivery.sentSms).toHaveLength(0);
    expect((await h.proposalRepo.findById(TENANT, 'p-1'))?.status).toBe('ready_for_review');
    // The attempt is still audited (cleanly — no empty entityId).
    expect(
      h.auditRepo.getAll().some((e) => e.eventType === 'proposal_approval.unverified_mobile'),
    ).toBe(true);
  });

  it('ignores a technician (no proposals:approve permission) with NO reply', async () => {
    await h.proposalRepo.create(makeProposal());

    const result = await handleProposalApprovalSms(ctx('APPROVE', TECH_MOBILE), h.deps);

    expect(result).toMatchObject({ handled: false, reason: 'forbidden' });
    expect(h.delivery.sentSms).toHaveLength(0);
    expect((await h.proposalRepo.findById(TENANT, 'p-1'))?.status).toBe('ready_for_review');
  });

  it('tells the owner to open the app when the proposal has unfilled required fields', async () => {
    await h.proposalRepo.create(
      makeProposal({ sourceContext: { missingFields: ['lineItems[0].catalogItemId'] } }),
    );

    const result = await handleProposalApprovalSms(ctx('APPROVE'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'needs_details' });
    expect(h.delivery.sentSms[0].body).toMatch(/open the app/i);
    // Still pending — SMS can't fill the gaps.
    expect((await h.proposalRepo.findById(TENANT, 'p-1'))?.status).toBe('ready_for_review');
  });

  it('does not act on another tenant\'s proposals', async () => {
    // A proposal in a different tenant must be invisible to this tenant's owner.
    await h.proposalRepo.create(makeProposal({ id: 'other', tenantId: 'tenant-2' }));

    const result = await handleProposalApprovalSms(ctx('APPROVE'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'nothing_pending' });
    expect((await h.proposalRepo.findById('tenant-2', 'other'))?.status).toBe('ready_for_review');
  });
});
