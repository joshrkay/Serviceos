/**
 * D-019 owner close chain — the ONE chain SMS, rendered for who receives it.
 *
 * B1 follow-up: when the tenant has no owner phone the chain SMS goes to the
 * backup supervisor. A legacy technician backup gets no link (they cannot
 * approve), and the reply handler refuses their Y, N and EDIT alike — so the
 * body must not ask them for any of those replies.
 */
import { describe, it, expect } from 'vitest';
import { queueCloseFallbackChain } from '../../src/proposals/autonomous-close-execution';
import { createProposal, InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { ResolvedApprover } from '../../src/proposals/approver-identity';

const TENANT = 't-close-sms';

async function stageChain(recipient: ResolvedApprover) {
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
  const result = await queueCloseFallbackChain(
    {
      proposalRepo,
      auditRepo,
      routing: {
        auditRepo,
        sendSms: async (_to, body) => {
          sms.push(body);
        },
        secret: 'close-sms-secret',
        buildApproveUrl: (token) => `https://x.test/approve?token=${token}`,
        resolveLinkApprover: async () => recipient,
        ownerPhoneResolver: async () => '+15125550111',
      },
    },
    {
      tenantId: TENANT,
      draftEstimateProposalId: head.id,
      sessionId: 'vs-close-sms',
      evaluation: { eligible: false, reason: 'tenant_not_opted_in' },
    },
  );
  return { result, sms };
}

describe('queueCloseFallbackChain — the chain SMS for its recipient', () => {
  it('a dispatcher backup gets the Reply Y form and a link', async () => {
    const { result, sms } = await stageChain({ role: 'dispatcher', userId: 'clerk-disp', via: 'backup_supervisor' });

    expect(result).toEqual({ queued: true, smsSent: true });
    expect(sms[0]).toContain('Reply Y to approve the setup steps');
    expect(sms[0]).toContain('token=');
  });

  it('a technician backup gets the for-your-info form: no Reply Y, no N, no link', async () => {
    const { result, sms } = await stageChain({ role: 'technician', userId: 'clerk-tech', via: 'backup_supervisor' });

    expect(result).toEqual({ queued: true, smsSent: true });
    expect(sms[0]).toContain('2 linked actions:');
    expect(sms[0]).toContain('For your info — the owner needs to review this in the app.');
    expect(sms[0]).not.toMatch(/Reply Y|reply N|token=/i);
  });
});
