import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryProposalRepository,
  Proposal,
} from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import {
  InMemoryDeliveryProvider,
  MessageDeliveryProvider,
  SmsMessage,
} from '../../../src/notifications/delivery-provider';
import { sendProposalApprovalRequest } from '../../../src/sms/proposal-approval/compose';
import { smsApprovalCodeOf } from '../../../src/sms/proposal-approval/render';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = '33333333-3333-3333-3333-333333333333';
const OWNER_MOBILE = '+15551230002';

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p-1',
    tenantId: TENANT,
    proposalType: 'draft_invoice',
    status: 'ready_for_review',
    payload: { lineItems: [{ description: 'Water Heater', quantity: 1, unitPriceCents: 185_000 }] },
    summary: 'invoice Acme for the water heater',
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('sendProposalApprovalRequest', () => {
  let proposalRepo: InMemoryProposalRepository;
  let delivery: InMemoryDeliveryProvider;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
    delivery = new InMemoryDeliveryProvider();
    auditRepo = new InMemoryAuditRepository();
  });

  it('stamps a code on the proposal, texts the owner, and audits the send', async () => {
    const proposal = makeProposal();
    await proposalRepo.create(proposal);

    const result = await sendProposalApprovalRequest(
      { proposal, recipientE164: OWNER_MOBILE, recipientUserId: OWNER_ID },
      { proposalRepo, messageDelivery: delivery, auditRepo, generateCode: () => 'A7KQ' },
    );

    expect(result).toMatchObject({ sent: true, code: 'A7KQ' });

    // Code persisted on the proposal so an inbound reply can resolve it.
    const stored = await proposalRepo.findById(TENANT, 'p-1');
    expect(smsApprovalCodeOf(stored!)).toBe('A7KQ');
    expect((stored!.sourceContext!.smsApproval as { recipientUserId: string }).recipientUserId).toBe(
      OWNER_ID,
    );

    // Owner texted a one-tap request.
    expect(delivery.sentSms).toHaveLength(1);
    expect(delivery.sentSms[0].to).toBe(OWNER_MOBILE);
    expect(delivery.sentSms[0].body).toContain('YES A7KQ');
    expect(delivery.sentSms[0].body).toContain('$1,850.00');
    expect(delivery.sentSms[0].idempotencyKey).toBe('proposal-approval-request:p-1');

    expect(
      auditRepo.getAll().some((e) => e.eventType === 'proposal_approval.sms_requested'),
    ).toBe(true);
  });

  it('preserves existing sourceContext when stamping the code', async () => {
    const proposal = makeProposal({ sourceContext: { conversationId: 'conv-9' } });
    await proposalRepo.create(proposal);

    await sendProposalApprovalRequest(
      { proposal, recipientE164: OWNER_MOBILE, recipientUserId: OWNER_ID },
      { proposalRepo, messageDelivery: delivery, generateCode: () => 'A7KQ' },
    );

    const stored = await proposalRepo.findById(TENANT, 'p-1');
    expect(stored!.sourceContext!.conversationId).toBe('conv-9');
    expect(smsApprovalCodeOf(stored!)).toBe('A7KQ');
  });

  it('is idempotent — does not re-text a proposal that already has a code', async () => {
    const proposal = makeProposal({ sourceContext: { smsApproval: { code: 'OLD1' } } });
    await proposalRepo.create(proposal);

    const result = await sendProposalApprovalRequest(
      { proposal, recipientE164: OWNER_MOBILE, recipientUserId: OWNER_ID },
      { proposalRepo, messageDelivery: delivery, generateCode: () => 'NEW2' },
    );

    expect(result).toEqual({ sent: false, reason: 'already_sent', code: 'OLD1' });
    expect(delivery.sentSms).toHaveLength(0);
  });

  it('reports send_failed without throwing when the provider rejects', async () => {
    const proposal = makeProposal();
    await proposalRepo.create(proposal);
    const failing: MessageDeliveryProvider = {
      sendSms: async (_m: SmsMessage) => {
        throw new Error('twilio down');
      },
      sendEmail: async () => {
        throw new Error('unused');
      },
    };

    const result = await sendProposalApprovalRequest(
      { proposal, recipientE164: OWNER_MOBILE, recipientUserId: OWNER_ID },
      { proposalRepo, messageDelivery: failing, generateCode: () => 'A7KQ' },
    );

    expect(result).toMatchObject({ sent: false, reason: 'send_failed', code: 'A7KQ' });
    // Code is still stamped (so a later resend/inbound can resolve it).
    expect(smsApprovalCodeOf((await proposalRepo.findById(TENANT, 'p-1'))!)).toBe('A7KQ');
  });
});
