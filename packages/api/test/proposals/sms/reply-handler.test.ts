/**
 * P2-034 — SMS approval transport, inbound reply handler.
 *
 * Covers the story's required tests: approve variants (Y/YES/yes/OK),
 * reject with reason capture, edit session (LLM delta → re-render, and the
 * honest fallback when interpretation fails), unknown-mobile anti-spoofing,
 * tenant isolation, no-pending behavior, the already-handled re-reply, and
 * the clarify-once-then-escalate edge. Duplicate MessageSid no-op lives in
 * the webhook layer (test/webhooks/twilio-sms-dispatch.test.ts) — here we
 * prove a REPEATED approval intent (new sid) cannot double-execute.
 */
import { describe, it, expect } from 'vitest';
import {
  handleProposalSmsReply,
  handleProposalSmsFallback,
  type ProposalSmsReplyDeps,
  EDIT_SESSION_TTL_MS,
} from '../../../src/proposals/sms/reply-handler';
import {
  InMemoryProposalSmsEventRepository,
  createProposalSmsEvent,
} from '../../../src/proposals/sms/sms-event';
import {
  InMemoryProposalRepository,
  createProposal,
  type Proposal,
} from '../../../src/proposals/proposal';
import { applyChainMetadata } from '../../../src/proposals/chain';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import type { SettingsRepository } from '../../../src/settings/settings';
import type { UserRepository } from '../../../src/users/user';
import type { InboundSmsContext } from '../../../src/sms/inbound-dispatch';

const TENANT = 't-1';
const OWNER_PHONE = '+15125550100';

function stubSettingsRepo(ownerPhone: string | null = OWNER_PHONE): SettingsRepository {
  return {
    findByTenant: async () => (ownerPhone ? { ownerPhone } : { ownerPhone: null }),
  } as unknown as SettingsRepository;
}

interface Harness {
  deps: ProposalSmsReplyDeps;
  proposalRepo: InMemoryProposalRepository;
  smsEventRepo: InMemoryProposalSmsEventRepository;
  auditRepo: InMemoryAuditRepository;
  sent: { to: string; body: string }[];
}

function makeHarness(overrides: Partial<ProposalSmsReplyDeps> = {}): Harness {
  const proposalRepo = new InMemoryProposalRepository();
  const smsEventRepo = new InMemoryProposalSmsEventRepository();
  const auditRepo = new InMemoryAuditRepository();
  const sent: { to: string; body: string }[] = [];
  const deps: ProposalSmsReplyDeps = {
    proposalRepo,
    smsEventRepo,
    settingsRepo: stubSettingsRepo(),
    auditRepo,
    sendSms: async (to, body) => {
      sent.push({ to, body });
    },
    ...overrides,
  };
  return { deps, proposalRepo, smsEventRepo, auditRepo, sent };
}

async function seedPendingProposal(
  h: Harness,
  tenantId = TENANT,
  overrides: Partial<Parameters<typeof createProposal>[0]> = {},
  renderedAt?: Date,
): Promise<Proposal> {
  const base = createProposal({
    tenantId,
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
    ...overrides,
  });
  const proposal = await h.proposalRepo.create({ ...base, status: 'ready_for_review' });
  await h.smsEventRepo.create(
    createProposalSmsEvent({
      tenantId,
      proposalId: proposal.id,
      direction: 'outbound',
      kind: 'proposal_rendered',
      body: 'Book Mrs Lee Tuesday 2pm. Reply Y to approve, N to reject, EDIT to change.',
      ...(renderedAt ? { now: renderedAt } : {}),
    }),
  );
  return proposal;
}

function ctx(body: string, opts: Partial<InboundSmsContext> = {}): InboundSmsContext {
  return {
    tenantId: TENANT,
    fromE164: OWNER_PHONE,
    body,
    messageSid: `SM-${Math.random().toString(36).slice(2)}`,
    ...opts,
  };
}

describe('handleProposalSmsReply — approve', () => {
  it.each(['Y', 'YES', 'yes', 'OK', 'approve'])(
    'approves the pending proposal on %s',
    async (token) => {
      const h = makeHarness();
      const proposal = await seedPendingProposal(h);

      const result = await handleProposalSmsReply(ctx(token), h.deps);

      expect(result).toMatchObject({ handled: true, reason: 'approved' });
      const updated = await h.proposalRepo.findById(TENANT, proposal.id);
      expect(updated?.status).toBe('approved');
      expect(updated?.approvedAt).toBeInstanceOf(Date);
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].to).toBe(OWNER_PHONE);
      expect(h.sent[0].body).toContain('Approved');
      const events = h.auditRepo.getAll().map((e) => e.eventType);
      expect(events).toContain('proposal.approved');
      expect(events).toContain('proposal.sms_approved');
    },
  );

  it('records the inbound reply event with the MessageSid', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);
    const c = ctx('Y');

    await handleProposalSmsReply(c, h.deps);

    const inbound = h.smsEventRepo.events.find((e) => e.kind === 'reply_approve');
    expect(inbound).toMatchObject({
      proposalId: proposal.id,
      direction: 'inbound',
      messageSid: c.messageSid,
      body: 'Y',
    });
  });

  it('a repeated approval intent cannot double-approve (re-sent Y, new sid)', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);

    await handleProposalSmsReply(ctx('Y'), h.deps);
    const second = await handleProposalSmsReply(ctx('Y'), h.deps);

    // The approved proposal is no longer reviewable, so the second reply
    // truthfully reports it was already handled — no double transition.
    expect(second).toMatchObject({ handled: true, reason: 'already_handled' });
    const updated = await h.proposalRepo.findById(TENANT, proposal.id);
    expect(updated?.status).toBe('approved');
    expect(h.sent[1].body).toContain('already handled');
  });

  it('never falls through to an older pending proposal when the newest render was handled', async () => {
    const h = makeHarness();
    // Older proposal A is still pending; newer proposal B was rendered
    // after it and then approved from the dashboard.
    const older = await seedPendingProposal(h, TENANT, {}, new Date('2026-06-11T15:00:00Z'));
    const newer = await seedPendingProposal(h, TENANT, {}, new Date('2026-06-11T15:05:00Z'));
    await h.proposalRepo.updateStatus(TENANT, newer.id, 'approved', {
      approvedAt: new Date(),
    });

    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    // The reply binds to the newest render ONLY — it must not approve A.
    expect(result).toMatchObject({ handled: true, reason: 'already_handled' });
    expect((await h.proposalRepo.findById(TENANT, older.id))?.status).toBe(
      'ready_for_review',
    );
    expect(h.sent[0].body).toContain('already handled');
    expect(h.auditRepo.getAll().map((e) => e.eventType)).toContain(
      'proposal.sms_reply_stale_target',
    );
  });

  it('same-millisecond renders target the later-inserted proposal (seq tiebreaker)', async () => {
    const h = makeHarness();
    const sameInstant = new Date('2026-06-11T15:00:00Z');
    await seedPendingProposal(h, TENANT, {}, sameInstant);
    const newer = await seedPendingProposal(
      h,
      TENANT,
      { summary: 'Invoice Mr Chen $300' },
      sameInstant,
    );

    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'approved' });
    expect((await h.proposalRepo.findById(TENANT, newer.id))?.status).toBe('approved');
  });

  it('blocks approval when required fields are missing and says so', async () => {
    const h = makeHarness();
    // voice_clarification payloads require fields; simulate missing ones via
    // sourceContext.missingFields, the canonical missing-field carrier.
    const base = createProposal({
      tenantId: TENANT,
      proposalType: 'create_appointment',
      payload: { customerName: 'Mrs Lee' },
      summary: 'Book Mrs Lee',
      createdBy: 'voice',
      sourceContext: { missingFields: ['scheduledStart'] },
    });
    const proposal = await h.proposalRepo.create({ ...base, status: 'ready_for_review' });
    await h.smsEventRepo.create(
      createProposalSmsEvent({
        tenantId: TENANT,
        proposalId: proposal.id,
        direction: 'outbound',
        kind: 'proposal_rendered',
        body: 'x',
      }),
    );

    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'approve_blocked' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
      'ready_for_review',
    );
    expect(h.sent[0].body).toContain("Can't approve yet");
  });

  it('Y on a chain head approves capture members and reports linked-action counts', async () => {
    const h = makeHarness();
    const chainId = 'sms-chain-1';
    const head = createProposal({
      tenantId: TENANT,
      proposalType: 'create_customer',
      payload: { name: 'Jane Chain' },
      summary: 'Create Jane Chain',
      createdBy: 'voice',
    });
    applyChainMetadata(head, {
      chainId,
      chainIndex: 0,
      chainLength: 3,
      dependsOnChainIndices: [],
      chainRefs: [],
    });
    const job = createProposal({
      tenantId: TENANT,
      proposalType: 'create_job',
      payload: { customerId: 'placeholder', title: 'Install' },
      summary: 'Create install job',
      createdBy: 'voice',
    });
    applyChainMetadata(job, {
      chainId,
      chainIndex: 1,
      chainLength: 3,
      dependsOnChainIndices: [0],
      chainRefs: [{ payloadPath: 'customerId', parentChainIndex: 0, entityKind: 'customerId' }],
    });
    const sendEstimate = createProposal({
      tenantId: TENANT,
      proposalType: 'send_estimate',
      payload: { estimateId: '550e8400-e29b-41d4-a716-446655440001' },
      summary: 'Send estimate',
      createdBy: 'voice',
    });
    applyChainMetadata(sendEstimate, {
      chainId,
      chainIndex: 2,
      chainLength: 3,
      dependsOnChainIndices: [1],
      chainRefs: [{ payloadPath: 'estimateId', parentChainIndex: 1, entityKind: 'estimateId' }],
    });
    await h.proposalRepo.createMany([
      { ...head, status: 'ready_for_review' },
      { ...job, status: 'draft' },
      { ...sendEstimate, status: 'draft' },
    ]);
    await h.smsEventRepo.create(
      createProposalSmsEvent({
        tenantId: TENANT,
        proposalId: head.id,
        direction: 'outbound',
        kind: 'proposal_rendered',
        body: 'Chain summary. Reply Y to approve the setup steps; starred items follow separately.',
      }),
    );

    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'approved' });
    expect((await h.proposalRepo.findById(TENANT, head.id))?.status).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, job.id))?.status).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, sendEstimate.id))?.status).toBe('draft');
    expect(h.sent[0].body).toContain('Approved 2 linked actions');
    expect(h.sent[0].body).toContain('1 follows separately');
    expect(h.auditRepo.getAll()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'proposal.sms_approved',
          metadata: expect.objectContaining({
            skipped: [{ id: sendEstimate.id, reason: 'non_capture' }],
          }),
        }),
      ]),
    );
  });

  it('Y on a non-head chain member confirms only the single approved proposal', async () => {
    const h = makeHarness();
    const chainId = 'sms-chain-member';
    const head = createProposal({
      tenantId: TENANT,
      proposalType: 'create_customer',
      payload: { name: 'Jane Chain' },
      summary: 'Create Jane Chain',
      createdBy: 'voice',
    });
    applyChainMetadata(head, {
      chainId,
      chainIndex: 0,
      chainLength: 2,
      dependsOnChainIndices: [],
      chainRefs: [],
    });
    const job = createProposal({
      tenantId: TENANT,
      proposalType: 'create_job',
      payload: { customerId: 'placeholder', title: 'Install' },
      summary: 'Create install job',
      createdBy: 'voice',
    });
    applyChainMetadata(job, {
      chainId,
      chainIndex: 1,
      chainLength: 2,
      dependsOnChainIndices: [0],
      chainRefs: [{ payloadPath: 'customerId', parentChainIndex: 0, entityKind: 'customerId' }],
    });
    await h.proposalRepo.createMany([
      { ...head, status: 'ready_for_review' },
      { ...job, status: 'draft' },
    ]);
    await h.smsEventRepo.create(
      createProposalSmsEvent({
        tenantId: TENANT,
        proposalId: job.id,
        direction: 'outbound',
        kind: 'proposal_rendered',
        body: 'Create install job. Reply Y to approve, N to reject, EDIT to change.',
      }),
    );

    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'approved' });
    expect((await h.proposalRepo.findById(TENANT, head.id))?.status).toBe('ready_for_review');
    expect((await h.proposalRepo.findById(TENANT, job.id))?.status).toBe('approved');
    expect(h.sent[0].body).toContain('Approved — "Create install job" will run shortly.');
    expect(h.sent[0].body).not.toContain('follows separately');
  });
});

describe('handleProposalSmsReply — mutation vs notification failures', () => {
  it('a failed confirmation send after a successful approval still reports approved', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);
    h.deps.sendSms = async () => {
      throw new Error('twilio down');
    };

    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'approved' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('approved');
    expect(h.auditRepo.getAll().map((e) => e.eventType)).toContain(
      'proposal.sms_approved_notify_failed',
    );
  });

  it('a failed confirmation send after a successful rejection still reports rejected', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);
    h.deps.sendSms = async () => {
      throw new Error('twilio down');
    };

    const result = await handleProposalSmsReply(ctx('N too expensive'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'rejected' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('rejected');
    expect(h.auditRepo.getAll().map((e) => e.eventType)).toContain(
      'proposal.sms_rejected_notify_failed',
    );
  });
});

describe('handleProposalSmsReply — reject', () => {
  it('rejects with the trailing text as the reason', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);

    const result = await handleProposalSmsReply(ctx('N price is too high'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'rejected' });
    const updated = await h.proposalRepo.findById(TENANT, proposal.id);
    expect(updated?.status).toBe('rejected');
    expect(updated?.rejectionReason).toBe('price is too high');
    expect(h.sent[0].body).toContain('Rejected');
  });

  it('uses a default reason when REJECT has no trailing text', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);

    await handleProposalSmsReply(ctx('REJECT'), h.deps);

    const updated = await h.proposalRepo.findById(TENANT, proposal.id);
    expect(updated?.rejectionReason).toBe('Rejected via SMS reply');
  });
});

describe('handleProposalSmsReply — identity & isolation', () => {
  it('ignores replies from an unknown mobile (anti-spoofing)', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);

    const result = await handleProposalSmsReply(
      ctx('Y', { fromE164: '+15125559999' }),
      h.deps,
    );

    expect(result).toMatchObject({ handled: false, reason: 'unknown_mobile' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
      'ready_for_review',
    );
    expect(h.sent).toHaveLength(0);
    expect(h.auditRepo.getAll().map((e) => e.eventType)).toContain(
      'proposal.sms_reply_unverified_mobile',
    );
  });

  it('matches the owner phone across formatting differences', async () => {
    const h = makeHarness();
    await seedPendingProposal(h);

    const result = await handleProposalSmsReply(
      ctx('Y', { fromE164: '(512) 555-0100' }),
      h.deps,
    );

    expect(result).toMatchObject({ handled: true, reason: 'approved' });
  });

  it("cannot touch another tenant's proposal (isolation)", async () => {
    const h = makeHarness();
    // The pending proposal + outbound SMS live in tenant B only.
    const other = await seedPendingProposal(h, 't-2');

    // Owner of tenant A replies on tenant A's webhook URL.
    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'no_pending_proposal' });
    expect((await h.proposalRepo.findById('t-2', other.id))?.status).toBe(
      'ready_for_review',
    );
  });

  it('replies truthfully when nothing is pending', async () => {
    const h = makeHarness();

    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'no_pending_proposal' });
    expect(h.sent[0].body).toContain('Nothing is waiting');
  });
});

describe('edit session flow', () => {
  it('EDIT opens a 10-minute session and asks what to change', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);
    const now = new Date('2026-06-11T15:00:00Z');
    h.deps.now = () => now;

    const result = await handleProposalSmsReply(ctx('EDIT'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'edit_session_opened' });
    const session = await h.smsEventRepo.findOpenEditSession(TENANT, "5125550100", now);
    expect(session?.proposalId).toBe(proposal.id);
    expect(session?.expiresAt?.getTime()).toBe(now.getTime() + EDIT_SESSION_TTL_MS);
    expect(h.sent[0].body).toContain('What should I change');
  });

  it('applies an interpreted delta and re-renders for re-approval', async () => {
    const h = makeHarness({
      interpretEdit: async () => ({ customerName: 'Mr Chen' }),
    });
    const proposal = await seedPendingProposal(h);
    await handleProposalSmsReply(ctx('EDIT'), h.deps);

    const result = await handleProposalSmsFallback(
      ctx('actually it is for Mr Chen'),
      h.deps,
    );

    expect(result).toMatchObject({ handled: true, reason: 'edited' });
    const updated = await h.proposalRepo.findById(TENANT, proposal.id);
    expect(updated?.payload.customerName).toBe('Mr Chen');
    expect(updated?.status).toBe('ready_for_review'); // re-approval required
    const rerender = h.smsEventRepo.events.find((e) => e.kind === 'reapproval_rendered');
    expect(rerender?.proposalId).toBe(proposal.id);
    // The re-approval SMS itself carries the reply tokens — and echoes the
    // owner's instruction, since the stored summary may still describe the
    // pre-edit value (it is not recomputed by editProposal).
    expect(h.sent.at(-1)?.body).toContain('Reply Y to approve');
    expect(h.sent.at(-1)?.body).toContain('Updated:');
    expect(h.sent.at(-1)?.body).toContain('your change: "actually it is for Mr Chen"');
    // The next Y approves the edited proposal.
    const approval = await handleProposalSmsReply(ctx('Y'), h.deps);
    expect(approval).toMatchObject({ handled: true, reason: 'approved' });
  });

  it('falls back honestly when interpretation fails', async () => {
    const h = makeHarness({ interpretEdit: async () => null });
    const proposal = await seedPendingProposal(h);
    await handleProposalSmsReply(ctx('EDIT'), h.deps);

    const result = await handleProposalSmsFallback(ctx('mumble mumble'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'edit_recorded' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.payload.customerName).toBe(
      'Mrs Lee',
    );
    const recorded = h.smsEventRepo.events.find((e) => e.kind === 'edit_request');
    expect(recorded?.body).toBe('mumble mumble');
    expect(h.sent.at(-1)?.body).toContain('review queue');
    expect(h.auditRepo.getAll().map((e) => e.eventType)).toContain(
      'proposal.sms_edit_requested',
    );
    // "Your note is attached" must be true: the instruction is queue-visible
    // on sourceContext, the review UI's annotation carrier.
    const annotated = await h.proposalRepo.findById(TENANT, proposal.id);
    expect(annotated?.sourceContext?.pendingSmsEditRequest).toMatchObject({
      instruction: 'mumble mumble',
    });
  });

  it('Y after a failed edit capture does NOT approve the stale payload', async () => {
    const h = makeHarness({ interpretEdit: async () => null });
    const proposal = await seedPendingProposal(h);
    await handleProposalSmsReply(ctx('EDIT'), h.deps);
    await handleProposalSmsFallback(ctx('make it $200'), h.deps); // recorded for manual review

    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'approve_blocked_pending_edit' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
      'ready_for_review',
    );
    expect(h.sent.at(-1)?.body).toContain('queue');
    // Rejecting the stale version stays allowed — it is the safe direction.
    const rejection = await handleProposalSmsReply(ctx('N changed my mind'), h.deps);
    expect(rejection).toMatchObject({ handled: true, reason: 'rejected' });
  });

  // RV-004 (P2-034-parity): SMS Y-reply while a manual edit is pending —
  // explicit parity test verifying all three observable effects: no approval
  // call, blocked-reply SMS, and the sms_approve_blocked_pending_edit audit
  // event (mirrors the one_tap_blocked_pending_edit event on the one-tap route).
  it('RV-004: Y-reply while edit pending emits the audit event and blocks approveProposal', async () => {
    const h = makeHarness({ interpretEdit: async () => null });
    const proposal = await seedPendingProposal(h);
    // Seed an unapplied edit request directly (no open session needed — this
    // is the post-session state where interpretation failed or returned null).
    await h.smsEventRepo.create(
      createProposalSmsEvent({
        tenantId: TENANT,
        proposalId: proposal.id,
        direction: 'inbound',
        kind: 'edit_request',
        messageSid: 'SM-edit-seed',
        fromPhone: '5125550100',
        body: 'lower the price',
      }),
    );

    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    // 1. The result is a clean block — never an error path.
    expect(result).toMatchObject({ handled: true, reason: 'approve_blocked_pending_edit' });
    // 2. approveProposal was NOT called — status is still reviewable.
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
      'ready_for_review',
    );
    // 3. The owner receives an SMS explaining the block (not a generic error).
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe(OWNER_PHONE);
    expect(h.sent[0].body).toContain('queue');
    // 4. The audit event is emitted (parity with proposal.one_tap_blocked_pending_edit).
    const auditTypes = h.auditRepo.getAll().map((e) => e.eventType);
    expect(auditTypes).toContain('proposal.sms_approve_blocked_pending_edit');
    expect(auditTypes).not.toContain('proposal.approved');
  });

  // RV-004 regression: Y with NO pending edit still approves (existing behavior intact).
  // This test mirrors the parametric suite above but is an explicit regression guard
  // for the parity fix — a pending-edit guard must not fire when there is no
  // unapplied edit_request.
  it('RV-004 regression: Y-reply with no pending edit approves normally', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);

    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'approved' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('approved');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].body).toContain('Approved');
    const auditTypes = h.auditRepo.getAll().map((e) => e.eventType);
    expect(auditTypes).toContain('proposal.approved');
    expect(auditTypes).not.toContain('proposal.sms_approve_blocked_pending_edit');
  });

  it('a failed re-approval send keeps approval blocked (edit applied, never delivered)', async () => {
    const h = makeHarness({ interpretEdit: async () => ({ customerName: 'Mr Chen' }) });
    const proposal = await seedPendingProposal(h);
    await handleProposalSmsReply(ctx('EDIT'), h.deps);
    // The re-approval send (and only it) fails — e.g. Twilio outage.
    h.deps.sendSms = async (_to, body) => {
      if (body.includes('Updated:')) throw new Error('twilio down');
      h.sent.push({ to: _to, body });
    };

    const result = await handleProposalSmsFallback(ctx('change to Mr Chen'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'reapproval_send_failed' });
    // The edit IS applied…
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.payload.customerName).toBe(
      'Mr Chen',
    );
    // …but no unsent render was recorded, so Y stays blocked.
    expect(h.smsEventRepo.events.find((e) => e.kind === 'reapproval_rendered')).toBeUndefined();
    h.deps.sendSms = async (to, body) => {
      h.sent.push({ to, body });
    };
    const approval = await handleProposalSmsReply(ctx('Y'), h.deps);
    expect(approval).toMatchObject({ handled: true, reason: 'approve_blocked_pending_edit' });
  });

  it('a successful SMS edit re-render unblocks approval', async () => {
    const h = makeHarness({ interpretEdit: async () => ({ customerName: 'Mr Chen' }) });
    await seedPendingProposal(h);
    await handleProposalSmsReply(ctx('EDIT'), h.deps);
    await handleProposalSmsFallback(ctx('change to Mr Chen'), h.deps);

    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'approved' });
  });

  it('unblocks even when the clock ticks between edit_request and reapproval', async () => {
    // Production clocks advance between the two rows; a stale reapproval
    // timestamp would leave hasUnappliedEditRequest() true forever.
    const h = makeHarness({ interpretEdit: async () => ({ customerName: 'Mr Chen' }) });
    let tick = new Date('2026-06-11T15:00:00Z').getTime();
    h.deps.now = () => new Date((tick += 1)); // every clock read is 1ms later
    await seedPendingProposal(h);
    await handleProposalSmsReply(ctx('EDIT'), h.deps);
    await handleProposalSmsFallback(ctx('change to Mr Chen'), h.deps);

    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'approved' });
  });

  it('the session window is fixed — a message after expiry is not an edit', async () => {
    const h = makeHarness({ interpretEdit: async () => ({ customerName: 'X' }) });
    const proposal = await seedPendingProposal(h);
    const opened = new Date('2026-06-11T15:00:00Z');
    h.deps.now = () => opened;
    await handleProposalSmsReply(ctx('EDIT'), h.deps);

    // 11 minutes later the session has lapsed; free text becomes the
    // clarify flow, not an edit.
    h.deps.now = () => new Date(opened.getTime() + 11 * 60 * 1000);
    const result = await handleProposalSmsFallback(ctx('make it $200'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'clarification_sent' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.payload.customerName).toBe(
      'Mrs Lee',
    );
  });

  it('captures an instruction that starts with an edit keyword during an open session', async () => {
    // "change the price..." routes to the KEYWORD handler (first token is a
    // registered edit token); with a session open it must be treated as the
    // instruction, not re-open another session.
    const h = makeHarness({
      interpretEdit: async ({ instruction }) => {
        expect(instruction).toBe('change it to Mr Chen');
        return { customerName: 'Mr Chen' };
      },
    });
    const proposal = await seedPendingProposal(h);
    await handleProposalSmsReply(ctx('EDIT'), h.deps);

    const result = await handleProposalSmsReply(ctx('change it to Mr Chen'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'edited' });
    const updated = await h.proposalRepo.findById(TENANT, proposal.id);
    expect(updated?.payload.customerName).toBe('Mr Chen');
    // No second "What should I change?" prompt was sent.
    expect(h.sent.filter((s) => s.body.includes('What should I change'))).toHaveLength(1);
  });

  it('applies an inline "EDIT <instruction>" without a round trip', async () => {
    const h = makeHarness({
      interpretEdit: async () => ({ customerName: 'Mr Chen' }),
    });
    const proposal = await seedPendingProposal(h);

    const result = await handleProposalSmsReply(ctx('EDIT make it for Mr Chen'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'edited' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.payload.customerName).toBe(
      'Mr Chen',
    );
    expect(h.sent.some((s) => s.body.includes('What should I change'))).toBe(false);
  });

  it("the backup supervisor's Y is not captured by the owner's edit session", async () => {
    const BACKUP_PHONE = '+15125550111';
    const h = makeHarness({
      settingsRepo: {
        findByTenant: async () => ({
          ownerPhone: OWNER_PHONE,
          backupSupervisorUserId: 'u-backup',
        }),
      } as unknown as SettingsRepository,
      userRepo: {
        findById: async () => ({ id: 'u-backup', mobileNumber: BACKUP_PHONE }),
      } as unknown as UserRepository,
      interpretEdit: async () => ({ customerName: 'X' }),
    });
    const proposal = await seedPendingProposal(h);
    await handleProposalSmsReply(ctx('EDIT'), h.deps); // owner opens a session

    // The backup's Y inside the window is a decision, not edit text.
    const result = await handleProposalSmsReply(
      ctx('Y', { fromE164: BACKUP_PHONE }),
      h.deps,
    );

    expect(result).toMatchObject({ handled: true, reason: 'approved' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.payload.customerName).toBe(
      'Mrs Lee',
    );
    // The owner's session is theirs alone and remains open.
    const session = await h.smsEventRepo.findOpenEditSession(
      TENANT,
      '5125550100',
      new Date(),
    );
    expect(session).not.toBeNull();
  });

  it('an open session captures unrecognized-token instructions routed to the keyword handler', async () => {
    // "START at 9 tomorrow" reaches handleProposalSmsReply via the
    // START/YES compliance composite; the session must capture it even
    // though the parser calls it unrecognized.
    const h = makeHarness({
      interpretEdit: async ({ instruction }) => {
        expect(instruction).toBe('START at 9 tomorrow');
        return { customerName: 'Mr Chen' };
      },
    });
    const proposal = await seedPendingProposal(h);
    await handleProposalSmsReply(ctx('EDIT'), h.deps);

    const result = await handleProposalSmsReply(ctx('START at 9 tomorrow'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'edited' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.payload.customerName).toBe(
      'Mr Chen',
    );
  });

  it('a newer proposal SMS supersedes an open edit session — Y approves the new proposal', async () => {
    const h = makeHarness({ interpretEdit: async () => ({ message: 'X' }) });
    const older = await seedPendingProposal(h, TENANT, {}, new Date('2026-06-11T15:00:00Z'));
    h.deps.now = () => new Date('2026-06-11T15:01:00Z');
    await handleProposalSmsReply(ctx('EDIT'), h.deps); // session opens for `older`

    // A new proposal is rendered + texted while the session is open.
    const newer = await seedPendingProposal(h, TENANT, {}, new Date('2026-06-11T15:02:00Z'));

    h.deps.now = () => new Date('2026-06-11T15:03:00Z');
    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    // The Y belongs to the newer message — never edit text for the older one.
    expect(result).toMatchObject({ handled: true, reason: 'approved' });
    expect((await h.proposalRepo.findById(TENANT, newer.id))?.status).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, older.id))?.status).toBe(
      'ready_for_review',
    );
    expect(h.smsEventRepo.events.find((e) => e.kind === 'edit_request')).toBeUndefined();
    const session = h.smsEventRepo.events.find((e) => e.kind === 'edit_session_opened');
    expect(session?.consumedAt).toBeInstanceOf(Date);
    expect(h.auditRepo.getAll().map((e) => e.eventType)).toContain(
      'proposal.sms_edit_session_superseded',
    );
  });

  it('free text after a superseding render becomes clarification, not an edit', async () => {
    const h = makeHarness({ interpretEdit: async () => ({ message: 'X' }) });
    await seedPendingProposal(h, TENANT, {}, new Date('2026-06-11T15:00:00Z'));
    h.deps.now = () => new Date('2026-06-11T15:01:00Z');
    await handleProposalSmsReply(ctx('EDIT'), h.deps);
    const newer = await seedPendingProposal(h, TENANT, {}, new Date('2026-06-11T15:02:00Z'));

    h.deps.now = () => new Date('2026-06-11T15:03:00Z');
    const result = await handleProposalSmsFallback(ctx('huh what is this'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'clarification_sent' });
    expect(h.smsEventRepo.events.find((e) => e.kind === 'edit_request')).toBeUndefined();
    const nudge = h.smsEventRepo.events.find((e) => e.kind === 'clarification_sent');
    expect(nudge?.proposalId).toBe(newer.id);
  });

  it('an edit session consumes on first message — no spam extension', async () => {
    const h = makeHarness({ interpretEdit: async () => null });
    await seedPendingProposal(h);
    const now = new Date('2026-06-11T15:00:00Z');
    h.deps.now = () => now;
    await handleProposalSmsReply(ctx('EDIT'), h.deps);

    await handleProposalSmsFallback(ctx('first change'), h.deps);
    const session = await h.smsEventRepo.findOpenEditSession(TENANT, "5125550100", now);
    expect(session).toBeNull();
  });
});

describe('clarification flow (fallback)', () => {
  it('nudges once on unrecognized text, then escalates silently', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);

    const first = await handleProposalSmsFallback(ctx('huh?'), h.deps);
    expect(first).toMatchObject({ handled: true, reason: 'clarification_sent' });
    expect(h.sent[0].body).toContain('Reply Y to approve');

    const second = await handleProposalSmsFallback(ctx('what??'), h.deps);
    expect(second).toMatchObject({ handled: true, reason: 'clarification_escalated' });
    expect(h.sent).toHaveLength(1); // no second nudge — no reply loops
    expect(h.auditRepo.getAll().map((e) => e.eventType)).toContain(
      'proposal.sms_clarification_escalated',
    );
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
      'ready_for_review',
    );
  });

  it('a failed edit-prompt send opens no session and leaves approval unblocked', async () => {
    const h = makeHarness({ interpretEdit: async () => ({ customerName: 'X' }) });
    const proposal = await seedPendingProposal(h);
    h.deps.sendSms = async () => {
      throw new Error('twilio down');
    };

    const result = await handleProposalSmsReply(ctx('EDIT'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'edit_prompt_send_failed' });
    expect(
      h.smsEventRepo.events.find((e) => e.kind === 'edit_session_opened'),
    ).toBeUndefined();
    expect(h.smsEventRepo.events.find((e) => e.kind === 'edit_request')).toBeUndefined();

    // Delivery recovers — a plain Y still approves (nothing was blocked).
    h.deps.sendSms = async (to, body) => {
      h.sent.push({ to, body });
    };
    const approval = await handleProposalSmsReply(ctx('Y'), h.deps);
    expect(approval).toMatchObject({ handled: true, reason: 'approved' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('approved');
  });

  it('a failed nudge send does not burn the clarification limit', async () => {
    const h = makeHarness();
    await seedPendingProposal(h);
    h.deps.sendSms = async () => {
      throw new Error('twilio down');
    };

    const first = await handleProposalSmsFallback(ctx('huh?'), h.deps);
    expect(first).toMatchObject({ handled: true, reason: 'clarification_send_failed' });
    expect(h.smsEventRepo.events.find((e) => e.kind === 'clarification_sent')).toBeUndefined();

    // Delivery recovers — the next unclear reply still gets the one nudge.
    h.deps.sendSms = async (to, body) => {
      h.sent.push({ to, body });
    };
    const second = await handleProposalSmsFallback(ctx('what??'), h.deps);
    expect(second).toMatchObject({ handled: true, reason: 'clarification_sent' });
    expect(h.sent).toHaveLength(1);
  });

  it('declines silently for non-owner free text', async () => {
    const h = makeHarness();
    await seedPendingProposal(h);

    const result = await handleProposalSmsFallback(
      ctx('hello', { fromE164: '+15125559999' }),
      h.deps,
    );

    expect(result).toMatchObject({ handled: false, reason: 'not_owner' });
    expect(h.sent).toHaveLength(0);
  });

  it('declines when there is no pending proposal context', async () => {
    const h = makeHarness();

    const result = await handleProposalSmsFallback(ctx('hello'), h.deps);

    expect(result).toMatchObject({ handled: false, reason: 'no_context' });
  });
});

describe('RV-073 — SMS reply approvals/rejections tag channel sms', () => {
  it('proposal.approved audit metadata carries channel sms', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);

    await handleProposalSmsReply(ctx('Y'), h.deps);

    const approvedEvent = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'proposal.approved' && e.entityId === proposal.id);
    expect(approvedEvent).toBeDefined();
    expect(approvedEvent!.metadata).toMatchObject({ channel: 'sms' });
  });

  it('proposal.rejected audit metadata carries channel sms', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);

    await handleProposalSmsReply(ctx('N customer canceled'), h.deps);

    const rejectedEvent = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'proposal.rejected' && e.entityId === proposal.id);
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent!.metadata).toMatchObject({ channel: 'sms' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// RV-074 — low/very_low-confidence proposals over SMS.
//
// The LOW form ("Needs review in app before approval — reply N to reject")
// goes out with NO one-tap link, but it MUST anchor the reply transport
// (kind `review_required_rendered`): the N it solicits has to target THIS
// proposal, not whatever older render came before. And a Y texted anyway
// must be re-blocked by the same confidence predicate that suppressed the
// approve affordance — never approved.
// ───────────────────────────────────────────────────────────────────────────

describe('RV-074 — review_required_rendered (low-confidence) anchoring', () => {
  async function seedLowConfidenceProposal(
    h: Harness,
    renderedAt?: Date,
  ): Promise<Proposal> {
    const base = createProposal({
      tenantId: TENANT,
      proposalType: 'create_appointment',
      payload: {
        jobId: '6f9619ff-8b86-d011-b42d-00c04fc964ff',
        customerName: 'Mr Vega',
        scheduledStart: '2026-06-17T19:00:00Z',
        scheduledEnd: '2026-06-17T20:00:00Z',
        _meta: { overallConfidence: 'low' },
      },
      summary: 'Book Mr Vega Wednesday 2pm',
      confidenceScore: 0.42,
      createdBy: 'voice',
    });
    const proposal = await h.proposalRepo.create({ ...base, status: 'ready_for_review' });
    await h.smsEventRepo.create(
      createProposalSmsEvent({
        tenantId: TENANT,
        proposalId: proposal.id,
        direction: 'outbound',
        kind: 'review_required_rendered',
        body: 'Book Mr Vega Wednesday 2pm Needs review in app before approval — reply N to reject.',
        ...(renderedAt ? { now: renderedAt } : {}),
      }),
    );
    return proposal;
  }

  it('Y on a low-confidence proposal is blocked with truthful copy + audit, proposal untouched', async () => {
    const h = makeHarness();
    // An OLDER normal proposal was rendered first — the Y must not land on it.
    const older = await seedPendingProposal(h, TENANT, {}, new Date('2026-06-11T15:00:00Z'));
    const low = await seedLowConfidenceProposal(h, new Date('2026-06-11T15:05:00Z'));

    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    expect(result).toMatchObject({
      handled: true,
      reason: 'approve_blocked_low_confidence',
    });
    // Neither proposal changed state — especially not an approval.
    expect((await h.proposalRepo.findById(TENANT, low.id))?.status).toBe('ready_for_review');
    expect((await h.proposalRepo.findById(TENANT, older.id))?.status).toBe('ready_for_review');
    // Truthful reply: review happens in the app.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].body).toBe(
      'This one needs review in the app before it can be approved.',
    );
    // Audit trail names the LOW proposal.
    const blocked = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'proposal.sms_approve_blocked_low_confidence');
    expect(blocked?.entityId).toBe(low.id);
    expect(h.auditRepo.getAll().map((e) => e.eventType)).not.toContain('proposal.approved');
  });

  it('N rejects THE low proposal — not the older rendered one', async () => {
    const h = makeHarness();
    const older = await seedPendingProposal(h, TENANT, {}, new Date('2026-06-11T15:00:00Z'));
    const low = await seedLowConfidenceProposal(h, new Date('2026-06-11T15:05:00Z'));

    const result = await handleProposalSmsReply(ctx('N not real work'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'rejected' });
    expect((await h.proposalRepo.findById(TENANT, low.id))?.status).toBe('rejected');
    // The older proposal is untouched — targeting honored the LOW anchor.
    expect((await h.proposalRepo.findById(TENANT, older.id))?.status).toBe('ready_for_review');
    const rejected = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'proposal.rejected');
    expect(rejected?.entityId).toBe(low.id);
  });

  it('a review_required render supersedes an open edit session — Y targets the LOW proposal (and is blocked)', async () => {
    const h = makeHarness({ interpretEdit: async () => ({ message: 'X' }) });
    const older = await seedPendingProposal(h, TENANT, {}, new Date('2026-06-11T15:00:00Z'));
    h.deps.now = () => new Date('2026-06-11T15:01:00Z');
    await handleProposalSmsReply(ctx('EDIT'), h.deps); // session opens for `older`
    h.sent.length = 0;

    // A LOW proposal is rendered + texted while the session is open.
    const low = await seedLowConfidenceProposal(h, new Date('2026-06-11T15:02:00Z'));

    h.deps.now = () => new Date('2026-06-11T15:03:00Z');
    const result = await handleProposalSmsReply(ctx('Y'), h.deps);

    // The Y belongs to the newer (LOW) message — not edit text for the older
    // one, and never an approval of a low-confidence proposal.
    expect(result).toMatchObject({
      handled: true,
      reason: 'approve_blocked_low_confidence',
    });
    expect((await h.proposalRepo.findById(TENANT, low.id))?.status).toBe('ready_for_review');
    expect((await h.proposalRepo.findById(TENANT, older.id))?.status).toBe('ready_for_review');
    expect(h.smsEventRepo.events.find((e) => e.kind === 'edit_request')).toBeUndefined();
    const session = h.smsEventRepo.events.find((e) => e.kind === 'edit_session_opened');
    expect(session?.consumedAt).toBeInstanceOf(Date);
    const events = h.auditRepo.getAll().map((e) => e.eventType);
    expect(events).toContain('proposal.sms_edit_session_superseded');
    expect(events).toContain('proposal.sms_approve_blocked_low_confidence');
  });

  it('N after a superseding review_required render rejects the LOW proposal', async () => {
    const h = makeHarness({ interpretEdit: async () => ({ message: 'X' }) });
    const older = await seedPendingProposal(h, TENANT, {}, new Date('2026-06-11T15:00:00Z'));
    h.deps.now = () => new Date('2026-06-11T15:01:00Z');
    await handleProposalSmsReply(ctx('EDIT'), h.deps);

    const low = await seedLowConfidenceProposal(h, new Date('2026-06-11T15:02:00Z'));

    h.deps.now = () => new Date('2026-06-11T15:03:00Z');
    const result = await handleProposalSmsReply(ctx('N'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'rejected' });
    expect((await h.proposalRepo.findById(TENANT, low.id))?.status).toBe('rejected');
    expect((await h.proposalRepo.findById(TENANT, older.id))?.status).toBe('ready_for_review');
    expect(h.smsEventRepo.events.find((e) => e.kind === 'edit_request')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Track E — action-class belt-and-braces: a Y that resolves (via the anchor)
// to a money/comms/irreversible proposal must NEVER approve it, regardless
// of how the Y arrived. The RV-071 one-tap fallback renders these proposals
// with link-based instructions ("Tap the link to approve…") — no Y prompt —
// but an owner can still text Y out of habit. The class guard makes that fail
// closed: the HMAC link is the only sanctioned SMS approval path for these
// classes.
// ─────────────────────────────────────────────────────────────────────────────

describe('Track E — SMS Y blocked for non-capture action classes', () => {
  it.each([
    ['record_payment', 'money', { invoiceId: '6f9619ff-8b86-d011-b42d-00c04fc964ff', amountCents: 20000, paymentMethod: 'cash' }],
    ['send_estimate', 'comms', { estimateId: '6f9619ff-8b86-d011-b42d-00c04fc964ff' }],
    ['cancel_appointment', 'irreversible', { appointmentId: '6f9619ff-8b86-d011-b42d-00c04fc964ff' }],
  ] as const)(
    'Y on a hypothetically-anchored %s (%s) proposal is refused with truthful copy + audit',
    async (proposalType, actionClass, payload) => {
      const h = makeHarness();
      // Hypothetical: SOMETHING anchored a Y-able render on a non-capture
      // proposal (a mis-anchor or future bug — no legitimate path does).
      const proposal = await seedPendingProposal(h, TENANT, {
        proposalType,
        payload: payload as Record<string, unknown>,
        summary: `Pending ${proposalType}`,
      });

      const result = await handleProposalSmsReply(ctx('Y'), h.deps);

      expect(result).toMatchObject({
        handled: true,
        reason: 'approve_blocked_action_class',
      });
      // Not approved — the proposal is untouched.
      expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
        'ready_for_review',
      );
      expect(h.auditRepo.getAll().map((e) => e.eventType)).not.toContain('proposal.approved');
      // Truthful refusal: the app or the proposal's own approval link.
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].body).toBe(
        'This one needs the app or its own approval link — a texted Y can’t approve it.',
      );
      // Audit names the proposal and the class that fired.
      const blocked = h.auditRepo
        .getAll()
        .find((e) => e.eventType === 'proposal.sms_approve_blocked_action_class');
      expect(blocked?.entityId).toBe(proposal.id);
      expect(blocked?.metadata).toMatchObject({ proposalType, actionClass });
    },
  );

  it('N still rejects a non-capture proposal (rejection stays allowed)', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h, TENANT, {
      proposalType: 'record_payment',
      payload: { invoiceId: '6f9619ff-8b86-d011-b42d-00c04fc964ff', amountCents: 20000, paymentMethod: 'cash' },
      summary: 'Record $200 payment',
    });

    const result = await handleProposalSmsReply(ctx('N wrong amount'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'rejected' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('rejected');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Track E — chain-ref edit guard: a delta that touches a payload field still
// holding an unresolved `$ref:chain[…]` token is refused (it would overwrite
// the chain wiring). NOTE the pre-existing fail-closed behavior this guard
// sharpens: for uuid-typed contract fields (draft_estimate.customerId) the
// merged payload would already fail Zod (the token is not a uuid) into the
// generic recorded-note path — this guard adds the truthful copy and covers
// PLAIN-STRING contract fields (issue_invoice.invoiceId) where the overwrite
// would otherwise pass validation silently.
// ─────────────────────────────────────────────────────────────────────────────

describe('Track E — SMS edit refused when the delta touches an unresolved chain ref', () => {
  it('refuses with "waiting on an earlier step — approval by text is paused until then" copy, audits, and leaves the token in place', async () => {
    const h = makeHarness({
      interpretEdit: async () => ({ invoiceId: 'INV-1024' }),
    });
    const proposal = await seedPendingProposal(h, TENANT, {
      proposalType: 'issue_invoice',
      payload: {
        // Unresolved chain token in a PLAIN-STRING contract field
        // (z.string().min(1)) — without the guard, the overwrite would
        // pass Zod and silently detach the dependent from its parent.
        invoiceId: '$ref:chain[0].invoiceId',
      },
      summary: 'Issue the new invoice',
    });

    const result = await handleProposalSmsReply(
      ctx('EDIT issue invoice 1024 instead'),
      h.deps,
    );

    expect(result).toMatchObject({ handled: true, reason: 'edit_blocked_chain_ref' });
    // The chain wiring is intact.
    const stored = await h.proposalRepo.findById(TENANT, proposal.id);
    expect(stored?.payload.invoiceId).toBe('$ref:chain[0].invoiceId');
    // Clear, truthful copy — includes the "paused until then" phrasing.
    expect(h.sent.some((s) => s.body.includes('waiting on an earlier step'))).toBe(true);
    expect(h.sent.some((s) => s.body.includes('approval by text is paused until then'))).toBe(true);
    // Audited with the touched fields.
    const blocked = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'proposal.sms_edit_blocked_chain_ref');
    expect(blocked?.entityId).toBe(proposal.id);
    expect(blocked?.metadata).toMatchObject({ fields: ['invoiceId'] });
    // The recorded edit_request stays unapplied → approval remains blocked.
    expect(await h.smsEventRepo.hasUnappliedEditRequest(TENANT, proposal.id)).toBe(true);
  });

  it('a delta NOT touching the token field still applies normally (plain-string contract)', async () => {
    const h = makeHarness({
      interpretEdit: async () => ({ paymentTermDays: 30 }),
    });
    const proposal = await seedPendingProposal(h, TENANT, {
      proposalType: 'issue_invoice',
      payload: { invoiceId: '$ref:chain[0].invoiceId', paymentTermDays: 14 },
      summary: 'Issue the new invoice',
    });

    const result = await handleProposalSmsReply(ctx('EDIT make it net 30'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'edited' });
    const stored = await h.proposalRepo.findById(TENANT, proposal.id);
    expect(stored?.payload.invoiceId).toBe('$ref:chain[0].invoiceId');
    expect(stored?.payload.paymentTermDays).toBe(30);
  });

  it('pre-existing uuid fail-closed: a non-touching delta on a uuid-typed token field lands in the recorded-note path', async () => {
    // draft_estimate.customerId is z.string().uuid() — the merged payload
    // still carries the token, so editProposal's Zod validation throws and
    // the edit falls into the generic recorded-note path (documented
    // behavior the chain-ref guard does NOT change).
    const h = makeHarness({
      interpretEdit: async () => ({
        lineItems: [{ description: 'Service', quantity: 1, unitPrice: 20000 }],
      }),
    });
    const proposal = await seedPendingProposal(h, TENANT, {
      proposalType: 'draft_estimate',
      payload: {
        customerId: '$ref:chain[0].customerId',
        lineItems: [{ description: 'Service', quantity: 1, unitPrice: 30000 }],
      },
      summary: 'Estimate for the new customer',
    });

    const result = await handleProposalSmsReply(ctx('EDIT make it $200'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'edit_recorded' });
    const stored = await h.proposalRepo.findById(TENANT, proposal.id);
    // Nothing changed — token intact, line items untouched.
    expect(stored?.payload.customerId).toBe('$ref:chain[0].customerId');
    expect((stored?.payload.lineItems as Array<Record<string, unknown>>)[0].unitPrice).toBe(30000);
    expect(
      h.auditRepo.getAll().some((e) => e.eventType === 'proposal.sms_edit_failed'),
    ).toBe(true);
  });
});

describe('handleProposalSmsReply — approve_all (U5 "ALL" / "APPROVE ALL")', () => {
  async function seedReady(
    h: Harness,
    overrides: Partial<Parameters<typeof createProposal>[0]>,
    metaOverride?: Record<string, unknown>,
  ): Promise<Proposal> {
    const base = createProposal({
      tenantId: TENANT,
      proposalType: 'create_appointment',
      payload: { jobId: '6f9619ff-8b86-d011-b42d-00c04fc964ff', customerName: 'A' },
      summary: 'seed',
      confidenceScore: 0.97,
      createdBy: 'voice',
      ...overrides,
    });
    const payload = metaOverride
      ? { ...(base.payload as Record<string, unknown>), _meta: metaOverride }
      : base.payload;
    return h.proposalRepo.create({ ...base, status: 'ready_for_review', payload });
  }

  it('approves every eligible capture-class proposal; excludes money + low-confidence', async () => {
    const h = makeHarness();
    const a = await seedReady(h, { proposalType: 'create_appointment' });
    const b = await seedReady(h, { proposalType: 'create_customer', payload: { name: 'B' } });
    const money = await seedReady(h, {
      proposalType: 'issue_invoice',
      payload: { invoiceId: 'i-1', totalCents: 50_000 },
    });
    const lowConf = await seedReady(
      h,
      { proposalType: 'create_appointment' },
      { overallConfidence: 'low' },
    );

    const result = await handleProposalSmsReply(ctx('ALL'), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'approved_all' });
    expect((await h.proposalRepo.findById(TENANT, a.id))?.status).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, b.id))?.status).toBe('approved');
    // Money + low-confidence are untouched — they need in-app review.
    expect((await h.proposalRepo.findById(TENANT, money.id))?.status).toBe('ready_for_review');
    expect((await h.proposalRepo.findById(TENANT, lowConf.id))?.status).toBe('ready_for_review');
    expect(h.sent[0].body).toContain('Approved all 2');
    expect(h.auditRepo.getAll().map((e) => e.eventType)).toContain('proposal.sms_approved_all');
  });

  it('"APPROVE ALL" (and "YES ALL") also route to bulk approve', async () => {
    for (const body of ['APPROVE ALL', 'YES ALL']) {
      const h = makeHarness();
      const a = await seedReady(h, { proposalType: 'create_appointment' });
      const result = await handleProposalSmsReply(ctx(body), h.deps);
      expect(result).toMatchObject({ handled: true, reason: 'approved_all' });
      expect((await h.proposalRepo.findById(TENANT, a.id))?.status).toBe('approved');
    }
  });

  it('ignores a non-owner number (identity guard)', async () => {
    const h = makeHarness();
    await seedReady(h, { proposalType: 'create_appointment' });
    const result = await handleProposalSmsReply(
      ctx('ALL', { fromE164: '+15559990000' }),
      h.deps,
    );
    expect(result).toMatchObject({ handled: false, reason: 'unknown_mobile' });
  });

  it('is idempotent — a repeated ALL approves nothing the second time', async () => {
    const h = makeHarness();
    await seedReady(h, { proposalType: 'create_appointment' });
    await seedReady(h, { proposalType: 'create_customer', payload: { name: 'B' } });

    const first = await handleProposalSmsReply(ctx('ALL'), h.deps);
    const second = await handleProposalSmsReply(ctx('ALL'), h.deps);

    expect(first).toMatchObject({ reason: 'approved_all' });
    // Everything already approved → nothing eligible left.
    expect(second).toMatchObject({ reason: 'approve_all_none' });
  });

  it('replies helpfully when nothing is eligible', async () => {
    const h = makeHarness();
    await seedReady(h, {
      proposalType: 'issue_invoice',
      payload: { invoiceId: 'i-1', totalCents: 50_000 },
    });
    const result = await handleProposalSmsReply(ctx('ALL'), h.deps);
    expect(result).toMatchObject({ handled: true, reason: 'approve_all_none' });
    expect(h.sent[0].body).toContain('Nothing is waiting');
  });
});
