import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  __resetKeywordRegistryForTests,
  dispatchInboundSms,
  registerKeywordHandler,
} from '../../src/sms/inbound-dispatch';
import {
  handleProposalApprovalSms,
  InMemoryProposalSmsEventRepository,
} from '../../src/sms/proposal-approval';
import { InMemoryUserRepository } from '../../src/users/user';
import { InMemoryProposalRepository, createProposal } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { ProposalApprovalKeywordHandler } from '../../src/sms/proposal-approval/keyword-router';
import { ALL_PROPOSAL_SMS_KEYWORDS } from '@ai-service-os/shared';
import { parseInboundProposalSms } from '../../src/proposals/sms/parse-inbound';
import { renderProposalSms } from '../../src/proposals/sms/render';

describe('P2-034 — proposal SMS transport', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const ownerId = '00000000-0000-0000-0000-000000000002';
  const ownerPhone = '+15555550100';

  let userRepo: InMemoryUserRepository;
  let proposalRepo: InMemoryProposalRepository;
  let smsEventRepo: InMemoryProposalSmsEventRepository;
  let auditRepo: InMemoryAuditRepository;
  let sendSms: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    __resetKeywordRegistryForTests();
    userRepo = new InMemoryUserRepository();
    proposalRepo = new InMemoryProposalRepository();
    smsEventRepo = new InMemoryProposalSmsEventRepository();
    auditRepo = new InMemoryAuditRepository();
    sendSms = vi.fn().mockResolvedValue(undefined);

    await userRepo.create({
      id: ownerId,
      tenantId,
      email: 'owner@test.com',
      role: 'owner',
      canFieldServe: true,
      mobileNumber: ownerPhone,
    });
  });

  function deps() {
    return {
      userRepo,
      proposalRepo,
      smsEventRepo,
      auditRepo,
      sendSms,
    };
  }

  async function seedProposal(id: string) {
    const proposal = createProposal({
      tenantId,
      proposalType: 'add_note',
      summary: 'Add note for Miller job',
      payload: { note: 'test' },
      createdBy: ownerId,
      sourceTrustTier: 'operator_confirmed',
    });
    proposal.id = id;
    proposal.status = 'ready_for_review';
    await proposalRepo.create(proposal);
    await smsEventRepo.recordEvent({
      tenantId,
      proposalId: id,
      direction: 'outbound',
      messageSid: `out-${id}`,
      ownerE164: ownerPhone,
      bodyPreview: 'outbound preview',
    });
  }

  it('parseInboundProposalSms accepts APPROVE, Y, yes, ok', () => {
    expect(parseInboundProposalSms('APPROVE').action).toBe('approve');
    expect(parseInboundProposalSms('  y ').action).toBe('approve');
    expect(parseInboundProposalSms('YES').action).toBe('approve');
    expect(parseInboundProposalSms('ok').action).toBe('approve');
  });

  it('registers all proposal keywords with the dispatcher', async () => {
    const handleSpy = vi.fn().mockResolvedValue({ handled: true, handler: 'proposal-approval' });
    registerKeywordHandler({
      keywords: ALL_PROPOSAL_SMS_KEYWORDS,
      handle: handleSpy,
    });

    await dispatchInboundSms({
      tenantId,
      fromE164: ownerPhone,
      body: 'approve',
      messageSid: 'SM001',
    });
    expect(handleSpy).toHaveBeenCalled();
  });

  it('approve flow transitions proposal to approved', async () => {
    const proposalId = '00000000-0000-0000-0000-000000000010';
    await seedProposal(proposalId);

    const result = await handleProposalApprovalSms(
      {
        tenantId,
        fromE164: ownerPhone,
        body: 'APPROVE',
        messageSid: 'SM-approve-1',
      },
      deps(),
    );

    expect(result.handled).toBe(true);
    const updated = await proposalRepo.findById(tenantId, proposalId);
    expect(updated?.status).toBe('approved');
  });

  it('reject flow captures remainder as rejection reason', async () => {
    const proposalId = '00000000-0000-0000-0000-000000000011';
    await seedProposal(proposalId);

    await handleProposalApprovalSms(
      {
        tenantId,
        fromE164: ownerPhone,
        body: 'REJECT wrong customer',
        messageSid: 'SM-reject-1',
      },
      deps(),
    );

    const updated = await proposalRepo.findById(tenantId, proposalId);
    expect(updated?.status).toBe('rejected');
    expect(updated?.rejectionReason).toContain('wrong customer');
  });

  it('duplicate MessageSid is a no-op', async () => {
    const proposalId = '00000000-0000-0000-0000-000000000012';
    await seedProposal(proposalId);

    const ctx = {
      tenantId,
      fromE164: ownerPhone,
      body: 'APPROVE',
      messageSid: 'SM-dup',
    };
    const first = await handleProposalApprovalSms(ctx, deps());
    const second = await handleProposalApprovalSms(ctx, deps());
    expect(first.handled).toBe(true);
    expect(second.reason).toBe('duplicate_message_sid');
  });

  it('renderProposalSms stays under 320 chars for realistic input', () => {
    const proposal = createProposal({
      tenantId,
      proposalType: 'draft_estimate',
      status: 'ready_for_review',
      summary: 'Estimate for Jane Doe — exterior paint',
      payload: {
        totalCents: 185000,
        customerName: 'Jane Doe',
        lineItems: [{ description: 'Paint', pricingSource: 'uncatalogued', unitPriceCents: 50000 }],
      },
      createdBy: ownerId,
    });
    const { body, segmentCount } = renderProposalSms(proposal);
    expect(body.length).toBeLessThanOrEqual(320);
    expect(segmentCount).toBeLessThanOrEqual(3);
    expect(body).toContain('APPROVE');
  });

  it('KeywordHandler class routes through handleProposalApprovalSms', async () => {
    const proposalId = '00000000-0000-0000-0000-000000000013';
    await seedProposal(proposalId);
    const handler = new ProposalApprovalKeywordHandler(deps());
    const result = await handler.handle({
      tenantId,
      fromE164: ownerPhone,
      body: 'yes',
      messageSid: 'SM-yes-1',
    });
    expect(result.handled).toBe(true);
  });
});
