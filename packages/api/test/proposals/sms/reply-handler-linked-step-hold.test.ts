/**
 * B3-4 — the SMS Y's "held by a reference check" reply is not claimed by the
 * linked-step gate.
 *
 * B4's follow-up tells a held SMS Y "something on it needs fixing first"
 * (audited heldBy: 'reference_check') when approveProposal refused it with
 * `details.missingFields` while the card itself has no unfilled field. The
 * linked-step gate refuses the same way (`missingFields: ['linkedStep']`,
 * plus `details.linkedStepReason`). Today the SMS action-class guard stops
 * every card that gate can hold before it is approved, but nothing in the
 * reply branch said so: were the guard ever moved, a linked step would be
 * reported and audited as a reference-check hold. The branch now also
 * requires `linkedStepReason` to be absent.
 *
 * The linked-step error cannot reach this branch through the real approval
 * path while the guard stands, so `approveChainSet` is stubbed to throw it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValidationError } from '../../../src/shared/errors';

const approveChainSet = vi.fn();
vi.mock('../../../src/proposals/actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/proposals/actions')>();
  return { ...actual, approveChainSet: (...args: unknown[]) => approveChainSet(...args) };
});

import { handleProposalSmsReply, type ProposalSmsReplyDeps } from '../../../src/proposals/sms/reply-handler';
import {
  InMemoryProposalSmsEventRepository,
  createProposalSmsEvent,
} from '../../../src/proposals/sms/sms-event';
import { InMemoryProposalRepository, createProposal } from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import type { SettingsRepository } from '../../../src/settings/settings';

const TENANT = 't-linked-hold';
const OWNER_PHONE = '+15125550100';
const REFERENCE_CHECK_REPLY = "Can't approve yet — something on it needs fixing first. Open it in the app to fix it.";

async function harness() {
  const proposalRepo = new InMemoryProposalRepository();
  const smsEventRepo = new InMemoryProposalSmsEventRepository();
  const auditRepo = new InMemoryAuditRepository();
  const sent: string[] = [];
  const deps: ProposalSmsReplyDeps = {
    proposalRepo,
    smsEventRepo,
    auditRepo,
    settingsRepo: { findByTenant: async () => ({ ownerPhone: OWNER_PHONE }) } as unknown as SettingsRepository,
    sendSms: async (_to, body) => {
      sent.push(body);
    },
  };
  const proposal = await proposalRepo.create({
    ...createProposal({
      tenantId: TENANT,
      proposalType: 'create_appointment',
      payload: {
        jobId: '6f9619ff-8b86-d011-b42d-00c04fc964ff',
        customerName: 'Mrs Lee',
        scheduledStart: '2026-06-16T19:00:00Z',
        scheduledEnd: '2026-06-16T20:00:00Z',
      },
      summary: 'Book Mrs Lee Tuesday 2pm',
      confidenceScore: 0.97,
      createdBy: 'voice',
    }),
    status: 'ready_for_review',
  });
  await smsEventRepo.create(
    createProposalSmsEvent({
      tenantId: TENANT,
      proposalId: proposal.id,
      direction: 'outbound',
      kind: 'proposal_rendered',
      fromE164: '+15125550000',
      toE164: OWNER_PHONE,
      body: 'Book Mrs Lee. Reply Y to approve.',
    }),
  );
  const ctx = { tenantId: TENANT, fromE164: OWNER_PHONE, body: 'Y', messageSid: `SM-${Math.random()}` };
  return { deps, auditRepo, sent, ctx };
}

const blockedAudit = (auditRepo: InMemoryAuditRepository) =>
  auditRepo.getAll().find((e) => e.eventType === 'proposal.sms_approve_blocked');

describe('B3-4 — a linked-step hold is not reported as a reference-check hold', () => {
  beforeEach(() => {
    approveChainSet.mockReset();
  });

  it('a linked-step error reaching the SMS Y branch is not a reference-check hold', async () => {
    const h = await harness();
    approveChainSet.mockImplementation(async () => {
      throw new ValidationError('Cannot approve proposal: linked step 1 has not run yet', {
        missingFields: ['linkedStep'],
        parentProposalId: 'parent-1',
        linkedStepReason: 'approve_parent_first',
      });
    });

    const result = await handleProposalSmsReply(h.ctx, h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'approve_blocked' });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).not.toBe(REFERENCE_CHECK_REPLY);
    expect(blockedAudit(h.auditRepo)?.metadata).not.toHaveProperty('heldBy');
  });

  it('a reference-check hold still gets its reply', async () => {
    const h = await harness();
    approveChainSet.mockImplementation(async () => {
      throw new ValidationError('The job on this card belongs to another customer', { missingFields: ['jobId'] });
    });

    await handleProposalSmsReply(h.ctx, h.deps);

    expect(h.sent).toEqual([REFERENCE_CHECK_REPLY]);
    expect(blockedAudit(h.auditRepo)?.metadata).toMatchObject({ heldBy: 'reference_check' });
  });
});
