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

  it.each(['hmm', 'uh let me think', 'what time is it tomorrow', ''])(
    'anything else ("%s") takes NO action and keeps the proposal pending',
    async (utterance) => {
      const h = makeHarness();
      const { pending, proposal } = await startAndGetPending(h);

      const result = await continueVoiceApproval(h.deps, { ...ref, utterance, pending });

      expect(result.outcome).toBe('kept_for_later');
      expect(result.pending).toBeNull();
      expect(result.speak.toLowerCase()).toContain('later');
      expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
        'ready_for_review',
      );
    },
  );

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

  it('wrong PIN → no approval, dialogue cleared', async () => {
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
    expect(failed.pending).toBeNull();
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
