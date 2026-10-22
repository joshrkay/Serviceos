/**
 * D-019 owner close chain — the ONE chain SMS, rendered for who receives it.
 *
 * B1 follow-up: when the tenant has no owner phone the chain SMS goes to the
 * backup supervisor. A legacy technician backup gets no link (they cannot
 * approve), and the reply handler refuses their Y, N and EDIT alike — so the
 * body must not ask them for any of those replies.
 */
import { describe, it, expect, vi } from 'vitest';
import { queueCloseFallbackChain } from '../../src/proposals/autonomous-close-execution';
import { createProposal, InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { ApprovalSmsRecipient, ResolvedApprover } from '../../src/proposals/approver-identity';
import { verifyOneTapApproveToken, createInMemoryNonceStore } from '../../src/proposals/auto-approve';

const TENANT = 't-close-sms';

const BACKUP_MOBILE: ApprovalSmsRecipient = { phone: '+15125550111', via: 'backup_supervisor' };

async function stageChain(
  resolveLinkApprover: (tenantId: string, phone: string) => Promise<ResolvedApprover | null>,
  smsRecipient: ApprovalSmsRecipient = BACKUP_MOBILE,
) {
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const head = createProposal({
    tenantId: TENANT,
    proposalType: 'draft_estimate',
    payload: { customerName: 'Jane Doe', lineItems: [{ description: 'Tune-up', quantity: 1, unitPrice: 18900 }] },
    summary: 'Estimate for Jane — tune-up',
    createdBy: 'voice',
  });
  await proposalRepo.create(head);
  const sms: string[] = [];
  const sentTo: string[] = [];
  const result = await queueCloseFallbackChain(
    {
      proposalRepo,
      auditRepo,
      routing: {
        auditRepo,
        sendSms: async (to, body) => {
          sentTo.push(to);
          sms.push(body);
        },
        secret: 'close-sms-secret',
        buildApproveUrl: (token) => `https://x.test/approve?token=${token}`,
        resolveLinkApprover,
        resolveSmsRecipient: async () => smsRecipient,
      },
    },
    {
      tenantId: TENANT,
      draftEstimateProposalId: head.id,
      sessionId: 'vs-close-sms',
      evaluation: { eligible: false, reason: 'tenant_not_opted_in' },
    },
  );
  return { result, sms, sentTo, auditRepo, headId: head.id };
}

describe('queueCloseFallbackChain — the chain SMS for its recipient', () => {
  it('a dispatcher backup gets the Reply Y form and a link', async () => {
    const { result, sms } = await stageChain(async () => ({
      role: 'dispatcher',
      userId: 'clerk-disp',
      via: 'backup_supervisor',
    }));

    expect(result).toEqual({ queued: true, smsSent: true });
    expect(sms[0]).toContain('Reply Y to approve the setup steps');
    expect(sms[0]).toContain('token=');
  });

  it('a technician backup gets the for-your-info form: no Reply Y, no N, no link', async () => {
    const { result, sms } = await stageChain(async () => ({
      role: 'technician',
      userId: 'clerk-tech',
      via: 'backup_supervisor',
    }));

    expect(result).toEqual({ queued: true, smsSent: true });
    expect(sms[0]).toContain('2 linked actions:');
    expect(sms[0]).toContain('For your info — the owner needs to review this in the app.');
    expect(sms[0]).not.toMatch(/Reply Y|reply N|token=/i);
  });
});

// B3-2 — the close chain texts the phone the recipient resolver picked, then
// asks who that phone approves as. A lookup that failed there used to read
// as "cannot approve", so the OWNER was sent the for-your-info chain text
// with no link. The owner phone is the owner by definition and is not looked
// up; a backup whose lookup fails still gets no link.
describe('queueCloseFallbackChain — a link lookup that fails after the phone was picked', () => {
  const failingLookup = () =>
    vi.fn(async (_tenantId: string, _phone: string): Promise<ResolvedApprover | null> => {
      throw new Error('settings read timed out');
    });

  it('the owner phone still gets the Reply Y form and the owner link', async () => {
    const lookup = failingLookup();
    const { result, sms, sentTo, auditRepo, headId } = await stageChain(lookup, {
      phone: '+15125550100',
      via: 'owner_phone',
    });

    expect(result).toEqual({ queued: true, smsSent: true });
    expect(sentTo).toEqual(['+15125550100']);
    expect(sms[0]).toContain('2 linked actions:');
    expect(sms[0]).toContain('Reply Y to approve the setup steps');
    expect(sms[0]).not.toContain('For your info');
    const token = sms[0].match(/token=([A-Za-z0-9._-]+)/)![1];
    const verified = await verifyOneTapApproveToken({
      token,
      secret: 'close-sms-secret',
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(verified).toMatchObject({ ok: true, proposalId: headId });
    expect(verified).not.toHaveProperty('approver');
    expect(lookup).not.toHaveBeenCalled();
    const routed = auditRepo.getAll().find((e) => e.eventType === 'unsupervised_proposal_routed');
    expect(routed?.metadata).toMatchObject({ smsSent: true });
    expect(routed?.metadata).not.toHaveProperty('suppressReason');
  });

  it("the backup's mobile fails closed: the for-your-info form, no link", async () => {
    const lookup = failingLookup();
    const { result, sms, sentTo, auditRepo } = await stageChain(lookup);

    expect(result).toEqual({ queued: true, smsSent: true });
    expect(lookup).toHaveBeenCalledWith(TENANT, '+15125550111');
    expect(sentTo).toEqual(['+15125550111']);
    expect(sms[0]).toContain('For your info — the owner needs to review this in the app.');
    expect(sms[0]).not.toMatch(/Reply Y|reply N|token=/i);
    const routed = auditRepo.getAll().find((e) => e.eventType === 'unsupervised_proposal_routed');
    expect(routed?.metadata).toMatchObject({ approveLinkSuppressed: true, suppressReason: 'recipient_cannot_approve' });
  });
});
