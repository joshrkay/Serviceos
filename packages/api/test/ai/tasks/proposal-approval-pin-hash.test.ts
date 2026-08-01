/**
 * WS21a — money/irreversible voice approval against an ENROLLED (hashed)
 * PIN. Proves the challenge dialogue behaves identically to the legacy
 * plaintext path when the stored credential is an HMAC hash: readback →
 * strict confirm → PIN prompt → spoken-digit approve, wrong-PIN retry, and
 * the 3rd-failure session lockout. The legacy-plaintext path is still covered
 * by proposal-approval-task.test.ts (fallback), which stays green.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startVoiceApproval,
  continueVoiceApproval,
  type VoiceApprovalDeps,
} from '../../../src/ai/tasks/proposal-approval-task';
import {
  createProposal,
  InMemoryProposalRepository,
  type CreateProposalInput,
  type Proposal,
} from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import type { SettingsRepository } from '../../../src/settings/settings';
import { hashVoiceApprovalPin } from '../../../src/settings/voice-approval-pin';

const TENANT = 't-voice-hash';
const SESSION = 'sess-hash-1';
const KEY = 'unit-test-enc-key';
const ref = { tenantId: TENANT, sessionId: SESSION, ownerSession: true };

function stubHashedSettingsRepo(pin: string): SettingsRepository {
  const hash = hashVoiceApprovalPin(pin, TENANT, KEY);
  return {
    findByTenant: async () => ({
      ownerPhone: '+15125550100',
      escalationSettings: { voice_approval_pin_hash: hash },
    }),
  } as unknown as SettingsRepository;
}

function makeHashHarness(pin = '4271') {
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const sent: { to: string; body: string }[] = [];
  const deps: VoiceApprovalDeps = {
    proposalRepo,
    auditRepo,
    settingsRepo: stubHashedSettingsRepo(pin),
    smsEventRepo: { hasUnappliedEditRequest: async () => false },
    oneTapFallback: {
      sendSms: async (to, body) => {
        sent.push({ to, body });
      },
      secret: 'test-secret',
      buildApproveUrl: (token) => `https://x.test/approve?token=${token}`,
      resolveOwnerPhone: async () => '+15125550100',
      recordSmsEvent: async () => {},
    },
  };
  return { deps, proposalRepo, auditRepo, sent };
}

async function seedMoney(
  repo: InMemoryProposalRepository,
  overrides: Partial<CreateProposalInput> = {},
): Promise<Proposal> {
  const proposal = createProposal({
    tenantId: TENANT,
    proposalType: 'record_payment',
    payload: { customerName: 'Acme Corp', amountCents: 20000 },
    summary: 'Record $200 payment from Acme',
    confidenceScore: 0.9,
    createdBy: 'user-1',
    ...overrides,
  });
  await repo.create(proposal);
  await repo.updateStatus(TENANT, proposal.id, 'ready_for_review');
  return (await repo.findById(TENANT, proposal.id))!;
}

describe('WS21a — enrolled hashed PIN, money-class voice approval', () => {
  const prevKey = process.env.TENANT_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.TENANT_ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    if (prevKey === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = prevKey;
  });

  it('readback → confirm → PIN prompt → spoken digits approve', async () => {
    const h = makeHashHarness('4271');
    const proposal = await seedMoney(h.proposalRepo);

    const start = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Acme payment',
    });
    expect(start.outcome).toBe('readback');

    const confirm = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'yes, approve it',
      pending: start.pending!,
    });
    expect(confirm.outcome).toBe('challenge_prompt');
    expect(confirm.pending).toMatchObject({ stage: 'challenge' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');

    const done = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'four two seven one',
      pending: confirm.pending!,
    });
    expect(done.outcome).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('approved');
  });

  it('wrong PIN → challenge_failed, kept for retry', async () => {
    const h = makeHashHarness('4271');
    await seedMoney(h.proposalRepo, {
      proposalType: 'cancel_appointment',
      payload: { customerName: 'Mrs Lee', appointmentId: 'appt-1' },
      summary: 'Cancel Mrs Lee Tuesday 2pm',
    });
    const start = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Lee appointment',
    });
    const confirm = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'yes',
      pending: start.pending!,
    });
    expect(confirm.outcome).toBe('challenge_prompt');

    const failed = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: '9 9 9 9',
      pending: confirm.pending!,
    });
    expect(failed.outcome).toBe('challenge_failed');
    expect(failed.sessionState).toMatchObject({ challengeFailCount: 1 });
  });

  it('3rd wrong PIN in the session → lockout + one-tap SMS', async () => {
    const h = makeHashHarness('4271');
    await seedMoney(h.proposalRepo);
    const start = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Acme payment',
    });
    const confirm = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'yes',
      pending: start.pending!,
    });
    let pending = confirm.pending!;
    let sessionState = confirm.sessionState;

    // Two failures, then the third trips lockout.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await continueVoiceApproval(h.deps, {
        ...ref,
        sessionState,
        utterance: '0 0 0 0',
        pending,
      });
      sessionState = r.sessionState;
      if (attempt < 3) {
        expect(r.outcome).toBe('challenge_failed');
        pending = r.pending!;
      } else {
        expect(r.outcome).toBe('challenge_lockout');
        expect(r.sessionState).toMatchObject({ challengeLockedOut: true });
        expect(h.sent.length).toBe(1); // one-tap SMS fallback fired
      }
    }
  });

  it('missing server secret → verify fails closed even with a stored hash', async () => {
    delete process.env.TENANT_ENCRYPTION_KEY;
    delete process.env.WEBHOOK_SIGNING_SECRET;
    const h = makeHashHarness('4271');
    await seedMoney(h.proposalRepo);
    const start = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Acme payment',
    });
    const confirm = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'yes',
      pending: start.pending!,
    });
    // Enrolled (hash present) so we still prompt for the code…
    expect(confirm.outcome).toBe('challenge_prompt');
    // …but the correct PIN can't verify without the secret.
    const done = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'four two seven one',
      pending: confirm.pending!,
    });
    expect(done.outcome).toBe('challenge_failed');
    process.env.TENANT_ENCRYPTION_KEY = KEY;
  });
});
