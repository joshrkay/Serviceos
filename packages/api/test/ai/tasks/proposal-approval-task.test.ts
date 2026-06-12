/**
 * RV-071 — owner voice approval task.
 *
 * The safety-critical core: readback composed from PAYLOAD fields (never
 * the utterance), explicit affirmative required on the NEXT turn before
 * approveProposal(channel:'voice') runs, money/irreversible challenge
 * (or polite refusal + real one-tap SMS), pending-edit parity, owner
 * gate, ordinal disambiguation, stale-target fail-closed.
 */
import { describe, it, expect } from 'vitest';
import {
  startVoiceApproval,
  continueVoiceApproval,
  composeReadback,
  spokenDigits,
  VOICE_APPROVAL_ACTOR_ID,
  type VoiceApprovalDeps,
  type PendingVoiceApproval,
  type VoiceApprovalSessionState,
} from '../../../src/ai/tasks/proposal-approval-task';
import {
  createProposal,
  InMemoryProposalRepository,
  type CreateProposalInput,
  type Proposal,
} from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import type { SettingsRepository } from '../../../src/settings/settings';

const TENANT = 't-voice';
const SESSION = 'sess-1';

function stubSettingsRepo(challenge?: string): SettingsRepository {
  return {
    findByTenant: async () => ({
      ownerPhone: '+15125550100',
      escalationSettings: challenge ? { voice_approval_challenge: challenge } : {},
    }),
  } as unknown as SettingsRepository;
}

interface Harness {
  deps: VoiceApprovalDeps;
  proposalRepo: InMemoryProposalRepository;
  auditRepo: InMemoryAuditRepository;
  sent: { to: string; body: string }[];
  recorded: { tenantId: string; proposalId: string; body: string }[];
}

function makeHarness(opts: {
  challenge?: string;
  hasUnappliedEdit?: boolean;
  withOneTap?: boolean;
} = {}): Harness {
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const sent: { to: string; body: string }[] = [];
  const recorded: { tenantId: string; proposalId: string; body: string }[] = [];
  const deps: VoiceApprovalDeps = {
    proposalRepo,
    auditRepo,
    settingsRepo: stubSettingsRepo(opts.challenge),
    smsEventRepo: {
      hasUnappliedEditRequest: async () => opts.hasUnappliedEdit ?? false,
    },
    ...(opts.withOneTap !== false
      ? {
          oneTapFallback: {
            sendSms: async (to, body) => {
              sent.push({ to, body });
            },
            secret: 'test-secret',
            buildApproveUrl: (token) => `https://x.test/approve?token=${token}`,
            resolveOwnerPhone: async () => '+15125550100',
            recordSmsEvent: async (args) => {
              recorded.push(args);
            },
          },
        }
      : {}),
  };
  return { deps, proposalRepo, auditRepo, sent, recorded };
}

const ref = { tenantId: TENANT, sessionId: SESSION, ownerSession: true };

async function seedPending(
  repo: InMemoryProposalRepository,
  overrides: Partial<CreateProposalInput> = {},
): Promise<Proposal> {
  const proposal = createProposal({
    tenantId: TENANT,
    proposalType: 'draft_estimate',
    payload: {
      customerName: 'Henderson Family LLC',
      lineItems: [
        { description: 'Water heater', total: 40000 },
        { description: 'Labor', total: 5000 },
      ],
      totalCents: 45000,
    },
    summary: 'Estimate for Henderson — water heater replacement',
    createdBy: 'voice',
    ...overrides,
  });
  await repo.create(proposal);
  await repo.updateStatus(TENANT, proposal.id, 'ready_for_review');
  return (await repo.findById(TENANT, proposal.id))!;
}

// ─── Readback invariant ──────────────────────────────────────────────────────

describe('RV-071 — readback is composed from the proposal payload', () => {
  it('contains the payload customer name and amount — not the utterance', async () => {
    const h = makeHarness();
    await seedPending(h.proposalRepo);

    // The owner SAID "Anderson" (a mishearing) — but resolution matched
    // Henderson via summary tokens? No: signals won't match Anderson, so
    // use the real reference here and assert payload provenance directly.
    const result = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Henderson estimate',
    });

    expect(result.outcome).toBe('readback');
    expect(result.speak).toContain('Henderson Family LLC'); // payload field, not the spoken "Henderson"
    expect(result.speak).toContain('$450.00'); // payload money, never spoken
    expect(result.speak.toLowerCase()).toContain('approve');
    expect(result.pending).toMatchObject({ action: 'approve', stage: 'confirm' });
  });

  it('composeReadback is a pure function of payload fields', () => {
    const proposal = createProposal({
      tenantId: TENANT,
      proposalType: 'draft_invoice',
      payload: { customerName: 'Acme Corp', totalCents: 123456, lineItems: [{ total: 123456 }] },
      summary: 'THIS SUMMARY MUST NOT BE SPOKEN',
      createdBy: 'voice',
    });
    const readback = composeReadback(proposal, 'approve');
    expect(readback).toContain('Acme Corp');
    expect(readback).toContain('$1,234.56');
    expect(readback).toMatch(/invoice/i);
    expect(readback).not.toContain('THIS SUMMARY MUST NOT BE SPOKEN');
  });
});

// ─── Confirm turn ────────────────────────────────────────────────────────────

describe('RV-071 — explicit affirmative required on the next turn', () => {
  async function startAndGetPending(h: Harness): Promise<{ pending: PendingVoiceApproval; proposal: Proposal }> {
    const proposal = await seedPending(h.proposalRepo);
    const start = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Henderson estimate',
    });
    expect(start.outcome).toBe('readback');
    return { pending: start.pending!, proposal };
  }

  it('"yes" approves through approveProposal with channel voice', async () => {
    const h = makeHarness();
    const { pending, proposal } = await startAndGetPending(h);

    const result = await continueVoiceApproval(h.deps, { ...ref, utterance: 'yes', pending });

    expect(result.outcome).toBe('approved');
    const stored = await h.proposalRepo.findById(TENANT, proposal.id);
    expect(stored?.status).toBe('approved');
    expect(stored?.approvedAt).toBeInstanceOf(Date);
    const approvedEvent = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'proposal.approved' && e.entityId === proposal.id);
    expect(approvedEvent).toBeDefined();
    expect(approvedEvent!.metadata).toMatchObject({ channel: 'voice' });
    expect(approvedEvent!.actorId).toBe(VOICE_APPROVAL_ACTOR_ID);
  });

  it.each(['approve', 'yes, approve it', 'go ahead'])(
    '"%s" also counts as the explicit affirmative',
    async (utterance) => {
      const h = makeHarness();
      const { pending, proposal } = await startAndGetPending(h);
      const result = await continueVoiceApproval(h.deps, { ...ref, utterance, pending });
      expect(result.outcome).toBe('approved');
      expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('approved');
    },
  );

  it.each(['hmm', 'uh let me think', 'what time is it tomorrow'])(  // non-empty non-strict
    'non-strict non-empty ("%s") → re-ask once, then kept_for_later',
    async (utterance) => {
      const h = makeHarness();
      const { pending, proposal } = await startAndGetPending(h);

      // First non-strict → re-ask
      const reask = await continueVoiceApproval(h.deps, { ...ref, utterance, pending });
      expect(reask.outcome).toBe('confirm_reask');
      expect(reask.pending).not.toBeNull();
      expect(reask.speak.toLowerCase()).toContain('just to be safe');
      expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');

      // Second non-strict → kept_for_later
      const final = await continueVoiceApproval(h.deps, { ...ref, utterance, pending: reask.pending! });
      expect(final.outcome).toBe('kept_for_later');
      expect(final.pending).toBeNull();
      expect(final.speak.toLowerCase()).toContain('later');
      expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
    },
  );

  it('empty/silence on confirm → re-ask once, then kept_for_later', async () => {
    const h = makeHarness();
    const { pending, proposal } = await startAndGetPending(h);

    const reask = await continueVoiceApproval(h.deps, { ...ref, utterance: '', pending });
    expect(reask.outcome).toBe('confirm_reask');
    expect(reask.pending).not.toBeNull();

    const final = await continueVoiceApproval(h.deps, { ...ref, utterance: '', pending: reask.pending! });
    expect(final.outcome).toBe('kept_for_later');
    expect(final.pending).toBeNull();
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });

  it('"no" declines without rejecting — the proposal stays pending', async () => {
    const h = makeHarness();
    const { pending, proposal } = await startAndGetPending(h);

    const result = await continueVoiceApproval(h.deps, { ...ref, utterance: 'no, hold off', pending });

    expect(result.outcome).toBe('kept_for_later');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });

  it('"repeat that" re-speaks the readback and stays pending', async () => {
    const h = makeHarness();
    const { pending } = await startAndGetPending(h);

    const result = await continueVoiceApproval(h.deps, { ...ref, utterance: 'say that again', pending });

    expect(result.outcome).toBe('readback');
    expect(result.speak).toContain('Henderson Family LLC');
    expect(result.pending).toMatchObject({ stage: 'confirm' });
  });

  it('a meanwhile-handled target fails closed', async () => {
    const h = makeHarness();
    const { pending, proposal } = await startAndGetPending(h);
    // Dashboard approval raced the voice confirm.
    await h.proposalRepo.updateStatus(TENANT, proposal.id, 'approved');

    const result = await continueVoiceApproval(h.deps, { ...ref, utterance: 'yes', pending });

    expect(result.outcome).toBe('not_found');
    expect(result.speak).toContain('already handled');
  });
});

// ─── Reject flow ─────────────────────────────────────────────────────────────

describe('RV-071 — reject flow', () => {
  it('readback + affirmative rejects with channel voice', async () => {
    const h = makeHarness();
    const proposal = await seedPending(h.proposalRepo);

    const start = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'reject',
      reference: 'the Henderson estimate',
    });
    expect(start.outcome).toBe('readback');
    expect(start.speak.toLowerCase()).toContain('reject');

    const result = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'yes, reject it',
      pending: start.pending!,
    });

    expect(result.outcome).toBe('rejected');
    const stored = await h.proposalRepo.findById(TENANT, proposal.id);
    expect(stored?.status).toBe('rejected');
    const rejectedEvent = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'proposal.rejected' && e.entityId === proposal.id);
    expect(rejectedEvent!.metadata).toMatchObject({ channel: 'voice' });
  });

  it('rejection does not require the money challenge', async () => {
    // record_payment is money-class but REJECTING it moves no money.
    const h = makeHarness({ challenge: undefined });
    const proposal = await seedPending(h.proposalRepo, {
      proposalType: 'record_payment',
      payload: { customerName: 'Acme Corp', amountCents: 20000 },
      summary: 'Record $200 payment from Acme',
    });

    const start = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'reject',
      reference: 'the Acme payment',
    });
    expect(start.outcome).toBe('readback');

    const result = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'yes',
      pending: start.pending!,
    });
    expect(result.outcome).toBe('rejected');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('rejected');
  });
});

// ─── Money / irreversible classes ────────────────────────────────────────────

describe('RV-071 — money/irreversible challenge', () => {
  it('challenge unset → polite refusal + REAL one-tap SMS via routeUnsupervisedProposal', async () => {
    const h = makeHarness({ challenge: undefined });
    const proposal = await seedPending(h.proposalRepo, {
      proposalType: 'record_payment',
      payload: { customerName: 'Acme Corp', amountCents: 20000 },
      summary: 'Record $200 payment from Acme',
    });

    const result = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Acme payment',
    });

    expect(result.outcome).toBe('refused_challenge_unset');
    expect(result.pending).toBeNull();
    expect(result.speak).toContain('text link');
    // The SMS actually went out, with a one-tap link, and the render was
    // recorded for the P2-034 reply transport.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe('+15125550100');
    expect(h.sent[0].body).toContain('https://x.test/approve?token=');
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].proposalId).toBe(proposal.id);
    // And the existing routing audit fired.
    const routed = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'unsupervised_proposal_routed');
    expect(routed).toBeDefined();
    // Nothing was approved.
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });

  it('challenge unset + no SMS wiring → refusal copy does not claim a text was sent', async () => {
    const h = makeHarness({ challenge: undefined, withOneTap: false });
    await seedPending(h.proposalRepo, {
      proposalType: 'record_payment',
      payload: { customerName: 'Acme Corp', amountCents: 20000 },
      summary: 'Record $200 payment from Acme',
    });

    const result = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Acme payment',
    });

    expect(result.outcome).toBe('refused_challenge_unset');
    expect(result.speak).not.toContain("I've sent you one");
    expect(h.sent).toHaveLength(0);
  });

  it('challenge set → readback, affirmative, PIN prompt, spoken digits approve', async () => {
    const h = makeHarness({ challenge: '4271' });
    const proposal = await seedPending(h.proposalRepo, {
      proposalType: 'record_payment',
      payload: { customerName: 'Acme Corp', amountCents: 20000 },
      summary: 'Record $200 payment from Acme',
    });

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
    // Not yet approved.
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');

    const done = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'four two seven one',
      pending: confirm.pending!,
    });
    expect(done.outcome).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('approved');
  });

  it('wrong PIN → challenge_failed, dialogue kept for retry (up to 3 attempts)', async () => {
    const h = makeHarness({ challenge: '4271' });
    const proposal = await seedPending(h.proposalRepo, {
      proposalType: 'cancel_appointment', // irreversible-class
      payload: { customerName: 'Mrs Lee', appointmentId: 'appt-1' },
      summary: 'Cancel Mrs Lee Tuesday 2pm',
    });

    const start = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Lee appointment',
    });
    expect(start.outcome).toBe('readback');
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
    // Dialogue kept pending for retry (not null on first failure)
    expect(failed.pending).not.toBeNull();
    expect(failed.pending).toMatchObject({ stage: 'challenge' });
    // I1 — the fail counter is SESSION-level state, not dialogue state.
    expect(failed.sessionState).toMatchObject({ challengeFailCount: 1 });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });

  it('capture-class proposals approve with NO challenge even when one is configured', async () => {
    const h = makeHarness({ challenge: '4271' });
    const proposal = await seedPending(h.proposalRepo); // draft_estimate = capture

    const start = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Henderson estimate',
    });
    const result = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'yes',
      pending: start.pending!,
    });
    expect(result.outcome).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('approved');
  });
});

// ─── Pending-edit parity ─────────────────────────────────────────────────────

describe('RV-071 — pending-edit parity (same guard as SMS/one-tap)', () => {
  it('approval is blocked while hasUnappliedEditRequest is true', async () => {
    const h = makeHarness({ hasUnappliedEdit: true });
    const proposal = await seedPending(h.proposalRepo);

    const result = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Henderson estimate',
    });

    expect(result.outcome).toBe('blocked_pending_edit');
    expect(result.pending).toBeNull();
    expect(result.speak).toContain('queue');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });

  it('rejecting stays allowed while an edit is pending (SMS parity)', async () => {
    const h = makeHarness({ hasUnappliedEdit: true });
    await seedPending(h.proposalRepo);

    const result = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'reject',
      reference: 'the Henderson estimate',
    });

    expect(result.outcome).toBe('readback');
  });
});

// ─── Owner gate ──────────────────────────────────────────────────────────────

describe('RV-071 — owner gate (defense in depth)', () => {
  it('startVoiceApproval refuses when ownerSession is false', async () => {
    const h = makeHarness();
    const proposal = await seedPending(h.proposalRepo);

    const result = await startVoiceApproval(h.deps, {
      tenantId: TENANT,
      sessionId: SESSION,
      ownerSession: false,
      action: 'approve',
      reference: 'the Henderson estimate',
    });

    expect(result.outcome).toBe('denied_not_owner');
    expect(result.pending).toBeNull();
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });

  it('continueVoiceApproval refuses when ownerSession is false', async () => {
    const h = makeHarness();
    const proposal = await seedPending(h.proposalRepo);

    const result = await continueVoiceApproval(h.deps, {
      tenantId: TENANT,
      sessionId: SESSION,
      ownerSession: false,
      utterance: 'yes',
      pending: { action: 'approve', stage: 'confirm', proposalId: proposal.id },
    });

    expect(result.outcome).toBe('denied_not_owner');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });
});

// ─── Resolution edges ────────────────────────────────────────────────────────

describe('RV-071 — resolution edges', () => {
  it('ambiguous reference → ONE clarification with an ordinal-anchored list', async () => {
    const h = makeHarness();
    const a = await seedPending(h.proposalRepo, { summary: 'Estimate for Henderson — kitchen' });
    const b = await seedPending(h.proposalRepo, { summary: 'Estimate for Henderson — bathroom' });

    const start = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Henderson estimate',
    });
    expect(start.outcome).toBe('clarification');
    expect(start.pending).toMatchObject({ stage: 'disambiguate' });
    expect(start.pending!.orderedIds).toHaveLength(2);

    // "the second one" resolves ordinally against the just-spoken list.
    const second = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'the second one',
      pending: start.pending!,
    });
    expect(second.outcome).toBe('readback');
    expect(second.proposalId).toBe(start.pending!.orderedIds![1]);
    expect([a.id, b.id]).toContain(second.proposalId);
  });

  it('a second failed clarification gives up (one-clarification rule)', async () => {
    const h = makeHarness();
    await seedPending(h.proposalRepo, { summary: 'Estimate for Henderson — kitchen' });
    await seedPending(h.proposalRepo, { summary: 'Estimate for Henderson — bathroom' });

    const start = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Henderson estimate',
    });
    const giveUp = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'um the henderson one',
      pending: start.pending!,
    });
    expect(giveUp.outcome).toBe('kept_for_later');
    expect(giveUp.pending).toBeNull();
  });

  it('a bare "approve it" with exactly one pending proposal reads it back', async () => {
    const h = makeHarness();
    await seedPending(h.proposalRepo);

    const result = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'approve it',
    });

    expect(result.outcome).toBe('readback');
    expect(result.speak).toContain('Henderson Family LLC');
  });

  it('clarification speaks the TRUE total when more than 5 are pending (M3)', async () => {
    const h = makeHarness();
    for (let i = 1; i <= 6; i++) {
      await seedPending(h.proposalRepo, { summary: `Estimate ${i} — job ${i}` });
    }

    const result = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'approve it', // no signals → list path
    });

    expect(result.outcome).toBe('clarification');
    expect(result.speak).toContain('I found 6 pending — here are the first 5:');
    expect(result.pending!.orderedIds).toHaveLength(5);
  });

  it('nothing pending → truthful line, no dialogue', async () => {
    const h = makeHarness();
    const result = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'approve it',
    });
    expect(result.outcome).toBe('nothing_pending');
    expect(result.pending).toBeNull();
  });

  it('unmatched reference → not_found, no dialogue', async () => {
    const h = makeHarness();
    await seedPending(h.proposalRepo);

    const result = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Zimmerman invoice',
    });

    expect(result.outcome).toBe('not_found');
    expect(result.pending).toBeNull();
  });
});

describe('RV-071 — spokenDigits', () => {
  it('normalizes digit words and mixed forms', () => {
    expect(spokenDigits('four two seven one')).toBe('4271');
    expect(spokenDigits('4 2 7 1')).toBe('4271');
    expect(spokenDigits('4271.')).toBe('4271');
    // Compound number words are unsupported by design — the partial
    // extraction can never equal a full PIN, so verification fails closed.
    expect(spokenDigits('forty-two')).toBe('2');
  });
});

// ─── Strict-confirm retargeting guard ────────────────────────────────────────

describe('RV-071 — strict-confirm retargeting guard', () => {
  async function startAndGetPending(h: Harness): Promise<{ pending: PendingVoiceApproval; proposal: Proposal }> {
    const proposal = await seedPending(h.proposalRepo);
    const start = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Henderson estimate',
    });
    expect(start.outcome).toBe('readback');
    return { pending: start.pending!, proposal };
  }

  it('retargeting utterance → re-ask once, then kept_for_later', async () => {
    const h = makeHarness();
    const { pending, proposal } = await startAndGetPending(h);

    // First: retargeting utterance triggers re-ask
    const reask = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'approve the acme invoice instead',
      pending,
    });
    expect(reask.outcome).toBe('confirm_reask');
    expect(reask.pending).not.toBeNull();
    expect(reask.speak.toLowerCase()).toContain('just to be safe');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');

    // Second non-strict → dialogue exits
    const final = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'yes and also send the invoice',
      pending: reask.pending!,
    });
    expect(final.outcome).toBe('kept_for_later');
    expect(final.pending).toBeNull();
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });

  it('strict affirmative after re-ask still approves', async () => {
    const h = makeHarness();
    const { pending, proposal } = await startAndGetPending(h);

    const reask = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'approve the acme invoice instead',
      pending,
    });
    expect(reask.outcome).toBe('confirm_reask');

    const approved = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'yes',
      pending: reask.pending!,
    });
    expect(approved.outcome).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('approved');
  });

  it('"no" / explicit negation still cancels immediately (no re-ask)', async () => {
    const h = makeHarness();
    const { pending, proposal } = await startAndGetPending(h);

    const result = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'no',
      pending,
    });
    expect(result.outcome).toBe('kept_for_later');
    expect(result.pending).toBeNull();
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });
});

// ─── Challenge attempt cap & session lockout ──────────────────────────────────

describe('RV-071 — challenge attempt cap (max 3) and session lockout', () => {
  function makeMoneyProposalHarness(opts: { challenge?: string; withOneTap?: boolean } = {}) {
    return makeHarness({ challenge: opts.challenge ?? '4271', withOneTap: opts.withOneTap });
  }

  async function reachChallengeStage(
    h: Harness,
    proposalType: Parameters<typeof seedPending>[1]['proposalType'] = 'record_payment',
  ) {
    const proposal = await seedPending(h.proposalRepo, {
      proposalType,
      payload: { customerName: 'Acme Corp', amountCents: 20000 },
      summary: 'Record $200 payment from Acme',
    });
    const start = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Acme payment',
    });
    expect(start.outcome).toBe('readback');
    const confirm = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'yes',
      pending: start.pending!,
    });
    expect(confirm.outcome).toBe('challenge_prompt');
    return { proposal, challengePending: confirm.pending! };
  }

  it('2 failures then correct code → approved (under the cap)', async () => {
    const h = makeMoneyProposalHarness();
    const { proposal, challengePending } = await reachChallengeStage(h);

    // Failure 1
    const fail1 = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: '0 0 0 0',
      pending: challengePending,
    });
    expect(fail1.outcome).toBe('challenge_failed');
    expect(fail1.pending).toMatchObject({ stage: 'challenge' });
    // I1 — counter lives on the SESSION state the caller must merge+thread.
    expect(fail1.sessionState).toMatchObject({ challengeFailCount: 1 });

    // Failure 2
    const fail2 = await continueVoiceApproval(h.deps, {
      ...ref,
      sessionState: fail1.sessionState,
      utterance: '1 2 3 4',
      pending: fail1.pending!,
    });
    expect(fail2.outcome).toBe('challenge_failed');
    expect(fail2.pending).toMatchObject({ stage: 'challenge' });
    expect(fail2.sessionState).toMatchObject({ challengeFailCount: 2 });

    // Correct code on 3rd attempt → approved
    const approved = await continueVoiceApproval(h.deps, {
      ...ref,
      sessionState: fail2.sessionState,
      utterance: 'four two seven one',
      pending: fail2.pending!,
    });
    expect(approved.outcome).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('approved');
  });

  it('3rd failure → challenge_lockout, SMS fallback sent, session locked', async () => {
    const h = makeMoneyProposalHarness();
    const { proposal, challengePending } = await reachChallengeStage(h);

    let pending = challengePending;
    let sessionState: VoiceApprovalSessionState | undefined;
    for (let i = 1; i <= 2; i++) {
      const r = await continueVoiceApproval(h.deps, {
        ...ref,
        sessionState,
        utterance: '0 0 0 0',
        pending,
      });
      expect(r.outcome).toBe('challenge_failed');
      pending = r.pending!;
      sessionState = { ...sessionState, ...r.sessionState };
    }

    // 3rd failure → lockout
    const lockout = await continueVoiceApproval(h.deps, {
      ...ref,
      sessionState,
      utterance: '0 0 0 0',
      pending,
    });
    expect(lockout.outcome).toBe('challenge_lockout');
    expect(lockout.pending).toBeNull();
    expect(lockout.sessionState).toMatchObject({
      challengeLockedOut: true,
      challengeFailCount: 3,
    });

    // SMS fallback was sent
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe('+15125550100');

    // Audit event for lockout (not the challenge value)
    const lockoutEvent = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'proposal.voice_challenge_lockout');
    expect(lockoutEvent).toBeDefined();
    expect(lockoutEvent!.metadata).toMatchObject({ attemptCount: 3 });
    // The attempted PIN value must NOT appear in audit metadata
    expect(JSON.stringify(lockoutEvent!.metadata)).not.toContain('0000');

    // Proposal still pending
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });

  it('subsequent money approval attempt in locked session is refused immediately', async () => {
    const h = makeMoneyProposalHarness();
    const { challengePending } = await reachChallengeStage(h);

    // Reach lockout
    let pending = challengePending;
    let sessionState: VoiceApprovalSessionState | undefined;
    for (let i = 1; i <= 2; i++) {
      const r = await continueVoiceApproval(h.deps, {
        ...ref,
        sessionState,
        utterance: '0 0 0 0',
        pending,
      });
      pending = r.pending!;
      sessionState = { ...sessionState, ...r.sessionState };
    }
    const lockout = await continueVoiceApproval(h.deps, {
      ...ref,
      sessionState,
      utterance: '0 0 0 0',
      pending,
    });
    expect(lockout.outcome).toBe('challenge_lockout');
    const lockedState: VoiceApprovalSessionState = lockout.sessionState!;

    // Try a fresh money approval in the same (now locked) session
    const proposal2 = await seedPending(h.proposalRepo, {
      proposalType: 'record_payment',
      payload: { customerName: 'Beta Corp', amountCents: 5000 },
      summary: 'Record $50 payment from Beta Corp',
    });
    const refused = await startVoiceApproval(h.deps, {
      ...ref,
      sessionState: lockedState,
      action: 'approve',
      reference: 'the Beta payment',
    });
    expect(refused.outcome).toBe('challenge_lockout');
    expect(refused.pending).toBeNull();
    expect((await h.proposalRepo.findById(TENANT, proposal2.id))?.status).toBe('ready_for_review');
  });

  it('fail counter SURVIVES dialogue cancel/restart — 3rd failure across dialogues locks (I1)', async () => {
    const h = makeMoneyProposalHarness();
    const { proposal, challengePending } = await reachChallengeStage(h);

    // Two failures in the first dialogue.
    let sessionState: VoiceApprovalSessionState | undefined;
    let pending = challengePending;
    for (const code of ['0 0 0 0', '1 1 1 1']) {
      const r = await continueVoiceApproval(h.deps, {
        ...ref,
        sessionState,
        utterance: code,
        pending,
      });
      expect(r.outcome).toBe('challenge_failed');
      pending = r.pending!;
      sessionState = { ...sessionState, ...r.sessionState };
    }

    // Explicit cancel exits the dialogue WITHOUT burning an attempt.
    const cancelled = await continueVoiceApproval(h.deps, {
      ...ref,
      sessionState,
      utterance: 'cancel that',
      pending,
    });
    expect(cancelled.outcome).toBe('kept_for_later');
    expect(cancelled.pending).toBeNull();
    expect(cancelled.sessionState).toBeUndefined();

    // Restart a brand-new dialogue against the same target.
    const restart = await startVoiceApproval(h.deps, {
      ...ref,
      sessionState,
      action: 'approve',
      reference: 'the Acme payment',
    });
    expect(restart.outcome).toBe('readback');
    const confirm = await continueVoiceApproval(h.deps, {
      ...ref,
      sessionState,
      utterance: 'yes',
      pending: restart.pending!,
    });
    expect(confirm.outcome).toBe('challenge_prompt');

    // 3rd wrong code OF THE SESSION (1st of this dialogue) → lockout.
    const lockout = await continueVoiceApproval(h.deps, {
      ...ref,
      sessionState,
      utterance: '2 2 2 2',
      pending: confirm.pending!,
    });
    expect(lockout.outcome).toBe('challenge_lockout');
    expect(lockout.sessionState).toMatchObject({
      challengeLockedOut: true,
      challengeFailCount: 3,
    });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });
});

// ─── Stage assert (challenge stage action invariant) ─────────────────────────

describe('RV-071 — stage assert: challenge stage requires action=approve', () => {
  it('impossible state (action=reject, stage=challenge) → kept_for_later + audit warn', async () => {
    const h = makeHarness({ challenge: '4271' });
    const proposal = await seedPending(h.proposalRepo, {
      proposalType: 'record_payment',
      payload: { customerName: 'Acme Corp', amountCents: 20000 },
      summary: 'Record $200 payment from Acme',
    });

    // Construct the structurally impossible state directly
    const impossiblePending: PendingVoiceApproval = {
      action: 'reject',
      stage: 'challenge',
      proposalId: proposal.id,
    };

    const result = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: '4271',
      pending: impossiblePending,
    });

    expect(result.outcome).toBe('kept_for_later');
    expect(result.pending).toBeNull();

    // Audit event for the invariant violation
    const auditEvent = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'proposal.voice_approval_stage_invariant_violated');
    expect(auditEvent).toBeDefined();
    expect(auditEvent!.metadata).toMatchObject({ stage: 'challenge', action: 'reject' });

    // Proposal must NOT be rejected (the action was blocked)
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });
});

// ─── ITEM 5 — Voice-channel hardening pins ───────────────────────────────────

describe('ITEM 5(a) — digit-bearing cancel at challenge stage counts as a failed attempt', () => {
  // "cancel 1 2 3 4" — digit-bearing utterance: the digits are treated as a
  // code attempt even though the utterance also contains a cancel word.
  // Only digit-FREE cancels ("cancel", "never mind") exit without penalty.
  it('"cancel 1 2 3 4" at challenge stage → challenge_failed (not kept_for_later)', async () => {
    const h = makeHarness({ challenge: '4271' });
    const proposal = await seedPending(h.proposalRepo, {
      proposalType: 'record_payment',
      payload: { customerName: 'Acme Corp', amountCents: 20000 },
      summary: 'Record $200 payment from Acme',
    });

    const start = await startVoiceApproval(h.deps, {
      ...ref,
      action: 'approve',
      reference: 'the Acme payment',
    });
    expect(start.outcome).toBe('readback');
    const confirm = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'yes',
      pending: start.pending!,
    });
    expect(confirm.outcome).toBe('challenge_prompt');

    // "cancel 1 2 3 4" — digit-bearing → treated as a code attempt, not a cancel
    const result = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'cancel 1 2 3 4',
      pending: confirm.pending!,
    });
    expect(result.outcome).toBe('challenge_failed');
    expect(result.sessionState).toMatchObject({ challengeFailCount: 1 });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });

  it('digit-free "cancel" at challenge stage → kept_for_later without burning an attempt', async () => {
    const h = makeHarness({ challenge: '4271' });
    await seedPending(h.proposalRepo, {
      proposalType: 'record_payment',
      payload: { customerName: 'Acme Corp', amountCents: 20000 },
      summary: 'Record $200 payment from Acme',
    });

    const start = await startVoiceApproval(h.deps, { ...ref, action: 'approve', reference: 'the Acme payment' });
    const confirm = await continueVoiceApproval(h.deps, { ...ref, utterance: 'yes', pending: start.pending! });
    expect(confirm.outcome).toBe('challenge_prompt');

    const result = await continueVoiceApproval(h.deps, {
      ...ref,
      utterance: 'cancel',
      pending: confirm.pending!,
    });
    expect(result.outcome).toBe('kept_for_later');
    // No attempt burned — sessionState should not be emitted or carry no failCount increment
    expect(result.sessionState).toBeUndefined();
  });
});

describe('ITEM 5(b) — post-lockout one-tap SMS send-once flag', () => {
  async function reachLockout(h: Harness) {
    const proposal = await seedPending(h.proposalRepo, {
      proposalType: 'record_payment',
      payload: { customerName: 'Acme Corp', amountCents: 20000 },
      summary: 'Record $200 payment from Acme',
    });
    const start = await startVoiceApproval(h.deps, { ...ref, action: 'approve', reference: 'the Acme payment' });
    const confirm = await continueVoiceApproval(h.deps, { ...ref, utterance: 'yes', pending: start.pending! });

    let pending = confirm.pending!;
    let sessionState: VoiceApprovalSessionState | undefined;
    for (let i = 0; i < 3; i++) {
      const r = await continueVoiceApproval(h.deps, { ...ref, sessionState, utterance: '0 0 0 0', pending });
      pending = r.pending!;
      sessionState = { ...sessionState, ...r.sessionState };
    }
    expect(sessionState?.challengeLockedOut).toBe(true);
    return { proposal, lockedState: sessionState! };
  }

  it('first post-lockout refusal sends the SMS and sets oneTapSmsSentAfterLockout', async () => {
    const h = makeHarness({ challenge: '4271' });
    const { lockedState } = await reachLockout(h);
    const initialSentCount = h.sent.length;

    const proposal2 = await seedPending(h.proposalRepo, {
      proposalType: 'record_payment',
      payload: { customerName: 'Beta Corp', amountCents: 5000 },
      summary: 'Record $50 payment from Beta Corp',
    });

    const refused = await startVoiceApproval(h.deps, {
      ...ref,
      sessionState: lockedState,
      action: 'approve',
      reference: 'the Beta payment',
    });
    expect(refused.outcome).toBe('challenge_lockout');
    expect(h.sent.length).toBe(initialSentCount + 1); // SMS sent on first post-lockout attempt
    expect(refused.sessionState).toMatchObject({ oneTapSmsSentAfterLockout: true });
    expect((await h.proposalRepo.findById(TENANT, proposal2.id))?.status).toBe('ready_for_review');
  });

  it('second post-lockout refusal does NOT re-send the SMS; copy says link already sent', async () => {
    const h = makeHarness({ challenge: '4271' });
    const { lockedState } = await reachLockout(h);

    await seedPending(h.proposalRepo, {
      proposalType: 'record_payment',
      payload: { customerName: 'Beta Corp', amountCents: 5000 },
      summary: 'Record $50 payment from Beta Corp',
    });

    // First refusal — sets the flag
    const first = await startVoiceApproval(h.deps, {
      ...ref,
      sessionState: lockedState,
      action: 'approve',
      reference: 'the Beta payment',
    });
    const sentAfterFirst = h.sent.length;
    const stateAfterFirst: VoiceApprovalSessionState = { ...lockedState, ...first.sessionState };

    await seedPending(h.proposalRepo, {
      proposalType: 'record_payment',
      payload: { customerName: 'Gamma Corp', amountCents: 3000 },
      summary: 'Record $30 payment from Gamma Corp',
    });

    // Second refusal — should NOT re-send
    const second = await startVoiceApproval(h.deps, {
      ...ref,
      sessionState: stateAfterFirst,
      action: 'approve',
      reference: 'the Gamma payment',
    });
    expect(second.outcome).toBe('challenge_lockout');
    expect(h.sent.length).toBe(sentAfterFirst); // no additional SMS
    expect(second.speak).toContain('already sent');
    // sessionState not emitted again (no new changes)
    expect(second.sessionState).toBeUndefined();
  });
});
