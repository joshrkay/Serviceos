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
