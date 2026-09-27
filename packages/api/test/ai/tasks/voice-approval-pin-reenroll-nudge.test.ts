/**
 * #1238 item 7 — PINs enrolled before the hashing / weak-PIN rules (legacy
 * plaintext `voice_approval_challenge`, or a hashed PIN the enrollment route
 * would now refuse as too easy to guess) keep working — owners are never
 * locked out — but the owner is told ONCE, on the call where they use it, to
 * set a new PIN. Seam: the voice-approval task (start/continueVoiceApproval).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startVoiceApproval,
  continueVoiceApproval,
  type VoiceApprovalDeps,
} from '../../../src/ai/tasks/proposal-approval-task';
import { createProposal, InMemoryProposalRepository, type Proposal } from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryVoiceApprovalPinLockAlertRepository } from '../../../src/settings/voice-approval-pin-lock-alert';
import { hashVoiceApprovalPin } from '../../../src/settings/voice-approval-pin';
import type { SettingsRepository } from '../../../src/settings/settings';

const TENANT = 't-pin-reenroll';
const SECRET = 'reenroll-test-secret';
const NUDGED = 'proposal.voice_approval_pin_reenroll_nudged';

type Credential = { legacyPlaintext: string } | { hashedPin: string };

function settingsRepo(credential: Credential): SettingsRepository {
  const escalationSettings =
    'legacyPlaintext' in credential
      ? { voice_approval_challenge: credential.legacyPlaintext }
      : { voice_approval_pin_hash: hashVoiceApprovalPin(credential.hashedPin, TENANT, SECRET) };
  return {
    findByTenant: async () => ({ ownerPhone: '+15125550100', escalationSettings }),
  } as unknown as SettingsRepository;
}

function makeHarness(credential: Credential) {
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const deps = {
    proposalRepo,
    auditRepo,
    settingsRepo: settingsRepo(credential),
    smsEventRepo: { hasUnappliedEditRequest: async () => false },
    pinLockAlertRepo: new InMemoryVoiceApprovalPinLockAlertRepository(),
  } as VoiceApprovalDeps;
  return { deps, proposalRepo, auditRepo };
}

async function seedMoney(repo: InMemoryProposalRepository, customerName: string): Promise<Proposal> {
  const proposal = createProposal({
    tenantId: TENANT,
    createdBy: 'voice',
    proposalType: 'record_payment',
    payload: { customerName, amountCents: 20000 },
    summary: `Record $200 payment from ${customerName}`,
  });
  await repo.create(proposal);
  await repo.updateStatus(TENANT, proposal.id, 'ready_for_review');
  return (await repo.findById(TENANT, proposal.id))!;
}

/** readback → yes → challenge → speak `code`. */
async function approveWithCode(
  h: ReturnType<typeof makeHarness>,
  sessionId: string,
  reference: string,
  code: string,
) {
  const ref = { tenantId: TENANT, sessionId, ownerSession: true } as const;
  const start = await startVoiceApproval(h.deps, { ...ref, action: 'approve', reference });
  expect(start.outcome).toBe('readback');
  const confirm = await continueVoiceApproval(h.deps, { ...ref, utterance: 'yes', pending: start.pending! });
  expect(confirm.outcome).toBe('challenge_prompt');
  return continueVoiceApproval(h.deps, { ...ref, utterance: code, pending: confirm.pending! });
}

const NUDGE = /set a new (voice )?approval pin/i;

let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.TENANT_ENCRYPTION_KEY;
  process.env.TENANT_ENCRYPTION_KEY = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
  else process.env.TENANT_ENCRYPTION_KEY = previousSecret;
});

describe('#1238 item 7 — one-time re-enroll nudge for PINs enrolled under the old rules', () => {
  it('a legacy plaintext PIN still approves, and the owner is told once to set a new PIN — the next call is not nagged again', async () => {
    const h = makeHarness({ legacyPlaintext: '4271' });
    const acme = await seedMoney(h.proposalRepo, 'Acme Corp');
    const beta = await seedMoney(h.proposalRepo, 'Beta Corp');

    const first = await approveWithCode(h, 'call-1', 'the Acme payment', 'four two seven one');
    expect(first.outcome).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, acme.id))?.status).toBe('approved');
    expect(first.speak).toMatch(NUDGE);
    // The spoken nudge never repeats the PIN.
    expect(first.speak).not.toMatch(/4\s*2\s*7\s*1|four two seven one/i);

    const second = await approveWithCode(h, 'call-2', 'the Beta payment', '4271');
    expect(second.outcome).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, beta.id))?.status).toBe('approved');
    expect(second.speak).not.toMatch(NUDGE);

    const nudges = h.auditRepo.getAll().filter((e) => e.eventType === NUDGED);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.metadata).toMatchObject({ reason: 'legacy_plaintext' });
  });

  it('a hashed PIN the enrollment route would now refuse as too easy (1111) still approves, with the one nudge', async () => {
    const h = makeHarness({ hashedPin: '1111' });
    const acme = await seedMoney(h.proposalRepo, 'Acme Corp');

    const r = await approveWithCode(h, 'call-1', 'the Acme payment', 'one one one one');
    expect(r.outcome).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, acme.id))?.status).toBe('approved');
    expect(r.speak).toMatch(NUDGE);
    const nudges = h.auditRepo.getAll().filter((e) => e.eventType === NUDGED);
    expect(nudges.map((e) => e.metadata?.reason)).toEqual(['weak_pin']);
  });

  it('a hashed PIN that meets the current rules is never nudged', async () => {
    const h = makeHarness({ hashedPin: '4271' });
    await seedMoney(h.proposalRepo, 'Acme Corp');

    const r = await approveWithCode(h, 'call-1', 'the Acme payment', '4271');
    expect(r.outcome).toBe('approved');
    expect(r.speak).not.toMatch(NUDGE);
    expect(h.auditRepo.getAll().filter((e) => e.eventType === NUDGED)).toHaveLength(0);
  });
});
