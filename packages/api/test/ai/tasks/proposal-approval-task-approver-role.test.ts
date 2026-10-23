/**
 * B1 — the voice owner line approves as WHO is calling, not as 'owner'.
 *
 * The owner line is recognised by caller-ID (owner_phone, or the backup
 * supervisor's mobile). The approve, reject and edit steps then called the
 * proposal actions with 'owner' regardless, so a backup dispatcher on the line
 * could clear the owner-only settings:update gate, and their spoken price
 * edits were attributed to the owner. The telephony establishment now
 * resolves the line's approver once (`resolveApproverRole`) and carries it on
 * the session; every turn acts with it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  startVoiceApproval,
  startVoiceEdit,
  startVoiceBatchApproval,
  continueVoiceApproval,
  VOICE_APPROVAL_ACTOR_ID,
  type VoiceApprovalDeps,
  type VoiceApprovalSessionRef,
} from '../../../src/ai/tasks/proposal-approval-task';
import {
  createProposal,
  InMemoryProposalRepository,
  type CreateProposalInput,
  type Proposal,
} from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalSmsEventRepository } from '../../../src/proposals/sms/sms-event';
import type { SettingsRepository } from '../../../src/settings/settings';
import { verifyOneTapApproveToken, createInMemoryNonceStore } from '../../../src/proposals/auto-approve';

const TENANT = 't-voice-b1';
const BACKUP_SUBJECT = 'clerk-backup-voice';
const CUSTOMER = 'b3b8a9a2-7c1d-4e8f-9a1b-2c3d4e5f6a7b';
const CATALOG_ITEM = 'b3b8a9a2-7c1d-4e8f-9a1b-000000000001';

function makeHarness(delta?: Record<string, unknown>) {
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const deps: VoiceApprovalDeps = {
    proposalRepo,
    auditRepo,
    settingsRepo: {
      findByTenant: async () => ({ ownerPhone: '+15125550100', escalationSettings: {} }),
    } as unknown as SettingsRepository,
    smsEventRepo: new InMemoryProposalSmsEventRepository(),
    ...(delta ? { editInterpreter: async () => delta } : {}),
  };
  return { deps, proposalRepo, auditRepo };
}

function lineRef(approver?: VoiceApprovalSessionRef['approver']): VoiceApprovalSessionRef {
  return { tenantId: TENANT, sessionId: 'sess-b1', ownerSession: true, ...(approver ? { approver } : {}) };
}
const backupDispatcher = lineRef({ role: 'dispatcher', userId: BACKUP_SUBJECT });
const backupTechnician = lineRef({ role: 'technician', userId: BACKUP_SUBJECT });

async function seed(repo: InMemoryProposalRepository, input: Partial<CreateProposalInput> = {}): Promise<Proposal> {
  const proposal = createProposal({
    tenantId: TENANT,
    proposalType: 'draft_estimate',
    payload: {
      customerId: CUSTOMER,
      customerName: 'Henderson Family LLC',
      lineItems: [{ description: 'Labor', category: 'labor', quantity: 1, unitPrice: 11500 }],
    },
    summary: 'Estimate for Henderson — condenser',
    createdBy: 'voice',
    ...input,
  });
  await repo.create(proposal);
  await repo.updateStatus(TENANT, proposal.id, 'ready_for_review');
  return (await repo.findById(TENANT, proposal.id))!;
}

async function approveByVoice(deps: VoiceApprovalDeps, ref: VoiceApprovalSessionRef) {
  const readback = await startVoiceApproval(deps, { ...ref, action: 'approve', reference: 'approve it' });
  expect(readback.outcome).toBe('readback');
  return continueVoiceApproval(deps, { ...ref, utterance: 'yes', pending: readback.pending! });
}

describe('B1 — voice owner line: a backup dispatcher acts as the dispatcher', () => {
  it('approve stamps the dispatcher and their subject, never owner', async () => {
    const h = makeHarness();
    const proposal = await seed(h.proposalRepo);

    const result = await approveByVoice(h.deps, backupDispatcher);

    expect(result.outcome).toBe('approved');
    const approved = (await h.proposalRepo.findById(TENANT, proposal.id))!;
    expect(approved.status).toBe('approved');
    expect(approved.executedByRole).toBe('dispatcher');
    expect(approved.executedBy).toBe(BACKUP_SUBJECT);
    expect(h.auditRepo.getAll().find((e) => e.eventType === 'proposal.approved')).toMatchObject({
      actorId: BACKUP_SUBJECT,
      actorRole: 'dispatcher',
    });
  });

  it('a card that needs settings:update is refused in plain words, and stays waiting', async () => {
    const h = makeHarness();
    const proposal = await seed(h.proposalRepo, {
      proposalType: 'update_catalog_item',
      payload: { catalogItemId: CATALOG_ITEM, unitPriceCents: 9900 },
      summary: 'Raise the run capacitor to $99',
    });

    const result = await approveByVoice(h.deps, backupDispatcher);

    expect(result.outcome).toBe('approve_failed');
    expect(result.speak).toMatch(/owner/i);
    expect(result.speak).not.toMatch(/proposal|dashboard|AI\b|agent|verify/i);
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });

  it('reject and edit act as the dispatcher too', async () => {
    const h = makeHarness({ lineItems: [{ description: 'Labor', category: 'labor', quantity: 1, unitPrice: 20000 }] });
    const toEdit = await seed(h.proposalRepo);

    const edit = await startVoiceEdit(h.deps, {
      ...backupDispatcher,
      reference: 'the Henderson estimate',
      instruction: 'make the labor 200 dollars',
    });
    expect(edit.outcome).toBe('edited');
    expect(h.auditRepo.getAll().find((e) => e.eventType === 'proposal.edited')).toMatchObject({
      actorId: BACKUP_SUBJECT,
      actorRole: 'dispatcher',
    });

    const readback = await startVoiceApproval(h.deps, { ...backupDispatcher, action: 'reject', reference: 'reject it' });
    const rejected = await continueVoiceApproval(h.deps, {
      ...backupDispatcher,
      utterance: 'yes, reject it',
      pending: readback.pending!,
    });
    expect(rejected.outcome).toBe('rejected');
    expect((await h.proposalRepo.findById(TENANT, toEdit.id))?.status).toBe('rejected');
    expect(h.auditRepo.getAll().find((e) => e.eventType === 'proposal.rejected')).toMatchObject({
      actorId: BACKUP_SUBJECT,
      actorRole: 'dispatcher',
    });
  });
});

describe('B1 — voice owner line: a backup whose role cannot approve is turned away', () => {
  it('approve, batch, edit and a carried-over pending step all refuse; nothing changes', async () => {
    const h = makeHarness({ totalCents: 1 });
    const proposal = await seed(h.proposalRepo);

    const start = await startVoiceApproval(h.deps, { ...backupTechnician, action: 'approve', reference: 'approve it' });
    const batch = await startVoiceBatchApproval(h.deps, backupTechnician);
    const edit = await startVoiceEdit(h.deps, { ...backupTechnician, reference: 'it', instruction: 'make it $1' });
    const carried = await continueVoiceApproval(h.deps, {
      ...backupTechnician,
      utterance: 'yes',
      pending: { action: 'approve', stage: 'confirm', proposalId: proposal.id },
    });

    for (const result of [start, batch, edit, carried]) {
      expect(result.outcome).toBe('denied_not_owner');
      expect(result.pending).toBeNull();
    }
    const after = (await h.proposalRepo.findById(TENANT, proposal.id))!;
    expect(after.status).toBe('ready_for_review');
    expect(after.payload).toEqual(proposal.payload);
  });
});

describe('B1 — the owner line without a backup approver is unchanged', () => {
  it('an owner session with no carried approver approves as owner under the voice actor', async () => {
    const h = makeHarness();
    const proposal = await seed(h.proposalRepo);

    const result = await approveByVoice(h.deps, lineRef());

    expect(result.outcome).toBe('approved');
    const approved = (await h.proposalRepo.findById(TENANT, proposal.id))!;
    expect(approved.executedByRole).toBe('owner');
    expect(approved.executedBy).toBe(VOICE_APPROVAL_ACTOR_ID);
  });

  it('the owner_phone approver is the owner under the voice actor', async () => {
    const h = makeHarness();
    const proposal = await seed(h.proposalRepo);

    await approveByVoice(h.deps, lineRef({ role: 'owner' }));

    const approved = (await h.proposalRepo.findById(TENANT, proposal.id))!;
    expect(approved.executedByRole).toBe('owner');
    expect(approved.executedBy).toBe(VOICE_APPROVAL_ACTOR_ID);
  });
});

describe('B1 — the voice one-tap fallback link approves as its recipient', () => {
  it('a refused money approval texts the backup a link that carries their role', async () => {
    const h = makeHarness();
    const sent: { to: string; body: string }[] = [];
    h.deps.oneTapFallback = {
      sendSms: async (to, body) => {
        sent.push({ to, body });
      },
      secret: 'voice-b1-secret',
      buildApproveUrl: (token) => `https://x.test/approve?token=${token}`,
      resolveSmsRecipient: async () => ({ phone: '+15125550111', via: 'backup_supervisor' as const }),
      resolveLinkApprover: async () => ({ role: 'dispatcher', userId: BACKUP_SUBJECT, via: 'backup_supervisor' }),
    };
    await seed(h.proposalRepo, {
      proposalType: 'record_payment',
      payload: { customerName: 'Acme Corp', amountCents: 20000 },
      summary: 'Record $200 payment from Acme',
    });

    const result = await startVoiceApproval(h.deps, { ...backupDispatcher, action: 'approve', reference: 'the Acme payment' });

    expect(result.outcome).toBe('refused_challenge_unset');
    const token = sent[0].body.match(/token=([A-Za-z0-9._-]+)/)![1];
    await expect(
      verifyOneTapApproveToken({ token, secret: 'voice-b1-secret', consumeNonce: createInMemoryNonceStore() }),
    ).resolves.toMatchObject({ ok: true, confirm: true, approver: { userId: BACKUP_SUBJECT, role: 'dispatcher' } });
  });

  // B1 follow-up — the phone the fallback texts can be a backup who cannot
  // approve (demoted since the call began). No link, and no reply prompt:
  // their texted N and EDIT are refused too.
  it('a fallback texted to a backup who cannot approve is for-your-info only', async () => {
    const h = makeHarness();
    const sent: { to: string; body: string }[] = [];
    h.deps.oneTapFallback = {
      sendSms: async (to, body) => {
        sent.push({ to, body });
      },
      secret: 'voice-b1-secret',
      buildApproveUrl: (token) => `https://x.test/approve?token=${token}`,
      resolveSmsRecipient: async () => ({ phone: '+15125550111', via: 'backup_supervisor' as const }),
      resolveLinkApprover: async () => ({ role: 'technician', userId: BACKUP_SUBJECT, via: 'backup_supervisor' }),
    };
    await seed(h.proposalRepo, {
      proposalType: 'record_payment',
      payload: { customerName: 'Acme Corp', amountCents: 20000 },
      summary: 'Record $200 payment from Acme',
    });

    await startVoiceApproval(h.deps, { ...backupDispatcher, action: 'approve', reference: 'the Acme payment' });

    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('For your info — the owner needs to review this in the app.');
    expect(sent[0].body).not.toMatch(/approve in the app|reply N|EDIT|token=/);
  });
});

// B3-2 — the fallback texts the phone the recipient resolver picked, then
// asks who that phone approves as. A lookup that failed there used to read
// as "cannot approve", so the OWNER was sent the for-your-info text with no
// link. The owner phone is the owner by definition and is not looked up; a
// backup whose lookup fails still gets no link.
describe('B3-2 — the voice one-tap fallback when the link lookup fails after the phone was picked', () => {
  function failingLookupHarness(recipient: { phone: string; via: 'owner_phone' | 'backup_supervisor' }) {
    const h = makeHarness();
    const sent: { to: string; body: string }[] = [];
    const resolveLinkApprover = vi.fn(async () => {
      throw new Error('settings read timed out');
    });
    h.deps.oneTapFallback = {
      sendSms: async (to, body) => {
        sent.push({ to, body });
      },
      secret: 'voice-b3-2-secret',
      buildApproveUrl: (token) => `https://x.test/approve?token=${token}`,
      resolveSmsRecipient: async () => recipient,
      resolveLinkApprover,
    };
    return { ...h, sent, resolveLinkApprover };
  }
  const seedPayment = (repo: InMemoryProposalRepository) =>
    seed(repo, {
      proposalType: 'record_payment',
      payload: { customerName: 'Acme Corp', amountCents: 20000 },
      summary: 'Record $200 payment from Acme',
    });

  async function expectOwnerLink(sent: { to: string; body: string }[], proposalId: string) {
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('+15125550100');
    expect(sent[0].body).toContain('Tap the link to approve, reply N to reject, or EDIT to change.');
    expect(sent[0].body).not.toContain('For your info');
    const token = sent[0].body.match(/token=([A-Za-z0-9._-]+)/)![1];
    const verified = await verifyOneTapApproveToken({
      token,
      secret: 'voice-b3-2-secret',
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(verified).toMatchObject({ ok: true, proposalId, confirm: true });
    // The plain owner link: no backup identity rides on it.
    expect(verified).not.toHaveProperty('approver');
  }

  it('a refused money approval on the owner line still texts the owner the link', async () => {
    const h = failingLookupHarness({ phone: '+15125550100', via: 'owner_phone' });
    const proposal = await seedPayment(h.proposalRepo);

    const result = await startVoiceApproval(h.deps, {
      ...lineRef({ role: 'owner' }),
      action: 'approve',
      reference: 'the Acme payment',
    });

    expect(result.outcome).toBe('refused_challenge_unset');
    expect(result.speak).toBe('That one needs a tap to confirm — I’ve sent you a text link.');
    await expectOwnerLink(h.sent, proposal.id);
    expect(h.resolveLinkApprover).not.toHaveBeenCalled();
    const routed = h.auditRepo.getAll().find((e) => e.eventType === 'unsupervised_proposal_routed');
    expect(routed?.metadata).toMatchObject({ smsSent: true });
    expect(routed?.metadata).not.toHaveProperty('suppressReason');
  });

  it('the confirm-stage fallback (the PIN cleared mid-call) texts the owner the link too', async () => {
    const h = failingLookupHarness({ phone: '+15125550100', via: 'owner_phone' });
    h.deps.settingsRepo = {
      findByTenant: async () => ({
        ownerPhone: '+15125550100',
        escalationSettings: { voice_approval_challenge: '4271' },
      }),
    } as unknown as SettingsRepository;
    const proposal = await seedPayment(h.proposalRepo);
    const owner = lineRef({ role: 'owner' });

    const start = await startVoiceApproval(h.deps, { ...owner, action: 'approve', reference: 'the Acme payment' });
    expect(start.outcome).toBe('readback');
    h.deps.settingsRepo = {
      findByTenant: async () => ({ ownerPhone: '+15125550100', escalationSettings: {} }),
    } as unknown as SettingsRepository;
    const result = await continueVoiceApproval(h.deps, { ...owner, utterance: 'yes, approve it', pending: start.pending! });

    expect(result.outcome).toBe('refused_challenge_unset');
    await expectOwnerLink(h.sent, proposal.id);
    expect(h.resolveLinkApprover).not.toHaveBeenCalled();
  });

  it("the backup's mobile fails closed: the for-your-info text, no link", async () => {
    const h = failingLookupHarness({ phone: '+15125550111', via: 'backup_supervisor' });
    await seedPayment(h.proposalRepo);

    await startVoiceApproval(h.deps, { ...backupDispatcher, action: 'approve', reference: 'the Acme payment' });

    expect(h.resolveLinkApprover).toHaveBeenCalledWith(TENANT, '+15125550111');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe('+15125550111');
    expect(h.sent[0].body).toContain('For your info — the owner needs to review this in the app.');
    expect(h.sent[0].body).not.toMatch(/Tap the link|reply N|EDIT|token=/);
    const routed = h.auditRepo.getAll().find((e) => e.eventType === 'unsupervised_proposal_routed');
    expect(routed?.metadata).toMatchObject({ approveLinkSuppressed: true, suppressReason: 'recipient_cannot_approve' });
  });
});
