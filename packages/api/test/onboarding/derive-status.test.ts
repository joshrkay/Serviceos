import { describe, it, expect } from 'vitest';
import {
  deriveDraftExecution,
  deriveOnboardingStatus,
  type DraftProposalMember,
  type OnboardingFacts,
} from '../../src/onboarding/derive-status';
import { UNDO_WINDOW_MS, isInUndoWindow } from '../../src/proposals/lifecycle';

/** A listed proposal row as the status read sees it; approved long ago unless stated. */
const member = (status: string, approvedAt: Date | null = new Date('2026-01-01T00:00:00Z')): DraftProposalMember => ({
  status,
  approvedAt,
});

function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    tenantExists: true,
    identity: { businessName: null, businessHours: null, jobBufferMinutes: null, hourlyRateCents: null, timezone: null },
    packActivated: false,
    twilioStatus: null,
    subscription: { stripeSubscriptionId: null, status: null },
    inboundCallCount: 0,
    testCallSkippedAt: null,
    voiceAgentLiveAt: null,
    activatedAt: null,
    aiConfigPresent: false,
    aiVerificationStatus: null,
    aiVerificationError: null,
    aiVerificationSkippedAt: null,
    ...overrides,
  };
}

/** Facts with everything up to and including billing satisfied. */
function billingDoneFacts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return facts({
    identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000, timezone: 'America/Phoenix' },
    packActivated: true,
    twilioStatus: 'full_readiness',
    subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' },
    ...overrides,
  });
}

describe('deriveOnboardingStatus', () => {
  it('fresh tenant: only signup done, identity is current', () => {
    const r = deriveOnboardingStatus(facts());
    expect(r.steps[0]).toEqual({ id: 'signup', status: 'done' });
    expect(r.steps[1]).toEqual({ id: 'identity', status: 'current' });
    expect(r.currentStep).toBe('identity');
    expect(r.isComplete).toBe(false);
  });

  it('emits accountCreatedAt only when tenantCreatedAt is set', () => {
    expect(deriveOnboardingStatus(facts()).accountCreatedAt).toBeUndefined();
    const created = new Date('2026-06-01T00:00:00.000Z');
    expect(deriveOnboardingStatus(facts({ tenantCreatedAt: created })).accountCreatedAt).toBe(
      created.toISOString(),
    );
  });

  it('identity done: pack becomes current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000, timezone: 'America/Phoenix' },
    }));
    expect(r.steps[1].status).toBe('done');
    expect(r.steps[2].status).toBe('current');
    expect(r.currentStep).toBe('pack');
  });

  it('identity partial (no hourly rate): identity stays current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: null, timezone: 'America/Phoenix' },
    }));
    expect(r.steps[1].status).toBe('current');
  });

  // A tenant with a NULL timezone cannot book: CreateAppointmentTaskHandler
  // (ai/tasks/create-appointment-task.ts) refuses to guess a zone and turns
  // every spoken booking into a voice_clarification. Reporting identity
  // "done" in that state unlocks onboarding onto a product that cannot take
  // an appointment — which is exactly what conversational onboarding used to
  // do, because its settings handler never wrote the column and this check
  // never asked for it. Null and absent are the same "never chosen"
  // (migration 263 dropped the column's NOT NULL and its Eastern DEFAULT).
  it('identity partial (no timezone): identity stays current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000, timezone: null },
    }));
    expect(r.steps[1].status).toBe('current');
    expect(r.currentStep).toBe('identity');
  });

  it('identity partial (timezone key absent entirely): identity stays current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
    }));
    expect(r.steps[1].status).toBe('current');
  });

  it('identity partial (empty-string timezone): identity stays current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000, timezone: '' },
    }));
    expect(r.steps[1].status).toBe('current');
  });

  it('pack activated: billing becomes current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000, timezone: 'America/Phoenix' },
      packActivated: true,
    }));
    expect(r.steps[2].status).toBe('done');
    expect(r.steps[3].status).toBe('current');
    expect(r.currentStep).toBe('billing');
  });

  it('billing not done: phone stays pending even while provisioning runs', () => {
    // Provisioning only starts at trial checkout now, but the derivation must
    // stay sane if a twilio status exists pre-billing: billing is the current
    // step, phone is pending.
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000, timezone: 'America/Phoenix' },
      packActivated: true,
      twilioStatus: 't0_requested',
    }));
    expect(r.steps[3].status).toBe('current');
    expect(r.steps[4].status).toBe('pending');
  });

  it('phone provisioning: phone is current (not done)', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000, timezone: 'America/Phoenix' },
      packActivated: true,
      subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' },
      twilioStatus: 'provisioning',
    }));
    expect(r.steps[4].status).toBe('current');
  });

  it('phone full_readiness: phone done, ai_check becomes current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000, timezone: 'America/Phoenix' },
      packActivated: true,
      subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' },
      twilioStatus: 'full_readiness',
    }));
    expect(r.steps[3]).toEqual({ id: 'billing', status: 'done' });
    expect(r.steps[4].status).toBe('done');
    expect(r.steps[5].status).toBe('current');
  });

  it('phone failed: phone is error with blocker', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000, timezone: 'America/Phoenix' },
      packActivated: true,
      subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' },
      twilioStatus: 'failed',
    }));
    expect(r.steps[4].status).toBe('error');
    expect(r.steps[4].blockers).toBeDefined();
  });

  it('subscription trialing: billing done, phone current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000, timezone: 'America/Phoenix' },
      packActivated: true,
      subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' },
    }));
    expect(r.steps[3]).toEqual({ id: 'billing', status: 'done' });
    expect(r.steps[4].id).toBe('phone');
    expect(r.steps[4].status).toBe('current');
    expect(r.currentStep).toBe('phone');
  });

  it('ai_check passed: test_call becomes current', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      aiConfigPresent: true,
      aiVerificationStatus: 'passed',
    }));
    expect(r.steps[5]).toEqual({ id: 'ai_check', status: 'done' });
    expect(r.steps[6].id).toBe('test_call');
    expect(r.steps[6].status).toBe('current');
    expect(r.currentStep).toBe('test_call');
  });

  it('ai_check running: current with verifying metadata', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      aiConfigPresent: true,
      aiVerificationStatus: 'running',
    }));
    expect(r.steps[5].status).toBe('current');
    expect(r.steps[5].metadata).toEqual({ verifying: true });
  });

  it('ai_check failed with config: error + ai_verification_failed blocker', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      aiConfigPresent: true,
      aiVerificationStatus: 'failed',
      aiVerificationError: 'boom',
    }));
    expect(r.steps[5].status).toBe('error');
    expect(r.steps[5].blockers).toEqual(['ai_verification_failed']);
    expect(r.steps[5].metadata).toEqual({ error: 'boom' });
  });

  it('ai_check failed without config: error + ai_config_missing blocker', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      aiConfigPresent: false,
      aiVerificationStatus: 'failed',
    }));
    expect(r.steps[5].status).toBe('error');
    expect(r.steps[5].blockers).toEqual(['ai_config_missing']);
  });

  it('ai_check skipped after failure: step skipped, setup completes', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      aiConfigPresent: true,
      aiVerificationStatus: 'failed',
      aiVerificationError: 'boom',
      aiVerificationSkippedAt: new Date('2026-09-27T00:00:00.000Z'),
      inboundCallCount: 1,
    }));
    expect(r.steps[5]).toEqual({ id: 'ai_check', status: 'skipped' });
    expect(r.isComplete).toBe(true);
    expect(r.currentStep).toBeNull();
  });

  it('ai_check passed after skip: still done (a real pass wins)', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      aiConfigPresent: true,
      aiVerificationStatus: 'passed',
      aiVerificationSkippedAt: new Date('2026-09-27T00:00:00.000Z'),
    }));
    expect(r.steps[5]).toEqual({ id: 'ai_check', status: 'done' });
  });

  it('ai_check skip without a failure on record: skipped, not current', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      aiVerificationStatus: null,
      aiVerificationSkippedAt: new Date('2026-09-27T00:00:00.000Z'),
    }));
    expect(r.steps[5]).toEqual({ id: 'ai_check', status: 'skipped' });
    expect(r.currentStep).toBe('test_call');
  });

  it('inbound call recorded but ai_check not passed: not complete', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({ inboundCallCount: 1 }));
    expect(r.isComplete).toBe(false);
    expect(r.currentStep).toBe('ai_check');
  });

  it('inbound call recorded and ai_check passed: test_call done, complete=true', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      aiConfigPresent: true,
      aiVerificationStatus: 'passed',
      inboundCallCount: 1,
    }));
    expect(r.steps[6].status).toBe('done');
    expect(r.isComplete).toBe(true);
    expect(r.currentStep).toBeNull();
  });

  it('has 7 steps in order', () => {
    const r = deriveOnboardingStatus(facts());
    expect(r.steps.map((s) => s.id)).toEqual([
      'signup', 'identity', 'pack', 'billing', 'phone', 'ai_check', 'test_call',
    ]);
  });

  it('intermediate twilio status (e.g., t0_requested): phone is current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000, timezone: 'America/Phoenix' },
      packActivated: true,
      subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' },
      twilioStatus: 't0_requested',
    }));
    expect(r.steps[4].status).toBe('current');
  });

  // #1563 — checkout sets up the subaccount + Messaging Service but buys no
  // number; the phone step must stay 'current' and tell the UI to show the
  // picker (not a "claiming…" spinner).
  it('subaccount ready, no number yet: phone stays current and asks for a pick', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000, timezone: 'America/Phoenix' },
      packActivated: true,
      subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' },
      twilioStatus: 't0_requested',
      twilioLineState: 'awaiting_pick',
    }));
    expect(r.steps[4]).toMatchObject({ id: 'phone', status: 'current', metadata: { lineState: 'awaiting_pick' } });
    expect(r.currentStep).toBe('phone');
    expect(r.isComplete).toBe(false);
  });

  it('a pick in flight: phone stays current and names the number being claimed', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000, timezone: 'America/Phoenix' },
      packActivated: true,
      subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' },
      twilioStatus: 't0_requested',
      twilioLineState: 'claiming',
      twilioPendingNumber: '+15125550123',
    }));
    expect(r.steps[4]).toMatchObject({
      status: 'current',
      metadata: { lineState: 'claiming', pendingNumber: '+15125550123' },
    });
  });

  // #1605 — the owner's test call (now let through the not_live gate) ends,
  // which both records the inbound call (test_call → done) AND auto-flips
  // voice_agent_live_at (maybeAutoGoLiveOnInboundEnd). Pin that the derived
  // status reports both facts together, not just the step.
  it('owner test call ended: test_call done AND voiceAgentLive true', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      aiConfigPresent: true,
      aiVerificationStatus: 'passed',
      inboundCallCount: 1,
      voiceAgentLiveAt: new Date('2026-10-04T12:00:00.000Z'),
    }));
    expect(r.steps[6]).toEqual({ id: 'test_call', status: 'done' });
    expect(r.voiceAgentLive).toBe(true);
    expect(r.isComplete).toBe(true);
  });

  it('test call skipped (ai_check passed): test_call=skipped, complete=true', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      subscription: { stripeSubscriptionId: 'sub_1', status: 'active' },
      aiConfigPresent: true,
      aiVerificationStatus: 'passed',
      testCallSkippedAt: new Date(),
    }));
    expect(r.steps[6].status).toBe('skipped');
    expect(r.isComplete).toBe(true);
  });
});

describe('deriveOnboardingStatus — pick-don\'t-build draft facts', () => {
  it('surfaces the draft additively and keeps exactly seven steps', () => {
    const r = deriveOnboardingStatus(facts({ draft: { status: 'draft', choicesAnswered: 3, version: 4 } }));
    expect(r.steps).toHaveLength(7);
    expect(r.draft).toEqual({ status: 'draft', choicesAnswered: 3, version: 4, execution: null });
  });
  it('omits draft when the tenant has none', () => {
    expect(deriveOnboardingStatus(facts({ draft: null }))).not.toHaveProperty('draft');
    expect(deriveOnboardingStatus(facts())).not.toHaveProperty('draft');
  });
});

describe('deriveDraftExecution', () => {
  const tracked = (statuses: string[], expected = 2) => ({ expected, members: statuses.map((st) => member(st)) });

  it.each([
    [['approved', 'approved'], 'pending'],
    [['approved', 'executing'], 'executing'],
    [['executing', 'executing'], 'executing'],
    // One half finished, the other still waiting for the worker: work is in flight.
    [['executed', 'approved'], 'executing'],
    [['executed', 'executing'], 'executing'],
    [['executed', 'executed'], 'executed'],
    // `failed` only while retry can complete the pair: every OTHER member is
    // still approved/executing/executed, so re-queueing the failed one finishes it.
    [['execution_failed', 'approved'], 'failed'],
    [['execution_failed', 'executing'], 'failed'],
    [['execution_failed', 'executed'], 'failed'],
    [['approved', 'execution_failed'], 'failed'],
    [['execution_failed', 'execution_failed'], 'failed'],
    // States the owner can land in through the inbox. Retry cannot leave them
    // (POST /draft/retry only re-queues execution_failed), so they are `stopped`,
    // never `failed`: the shell must neither wait forever nor offer a dead Retry.
    [['undone', 'approved'], 'stopped'],
    [['expired', 'executed'], 'stopped'],
    [['rejected', 'approved'], 'stopped'],
    [['draft', 'approved'], 'stopped'],
    [['ready_for_review', 'executed'], 'stopped'],
    [['undone', 'undone'], 'stopped'],
    // A failure next to a member retry cannot recover is `stopped`, NOT `failed`:
    // re-queueing only the failed half would execute it while the other stays
    // undone/rejected/expired, leaving half the approved configuration live.
    [['execution_failed', 'undone'], 'stopped'],
    [['undone', 'execution_failed'], 'stopped'],
    [['execution_failed', 'rejected'], 'stopped'],
    [['rejected', 'execution_failed'], 'stopped'],
    [['execution_failed', 'expired'], 'stopped'],
    [['expired', 'execution_failed'], 'stopped'],
    [['execution_failed', 'draft'], 'stopped'],
    [['execution_failed', 'ready_for_review'], 'stopped'],
  ])('approved draft with proposals %j is %s', (statuses, expected) => {
    expect(deriveDraftExecution('approved', tracked(statuses))).toBe(expected);
  });

  it('a listed proposal that no longer exists (fewer rows than ids) is stopped, not failed', () => {
    expect(deriveDraftExecution('approved', tracked(['executed'], 2))).toBe('stopped');
    expect(deriveDraftExecution('approved', tracked([], 2))).toBe('stopped');
    // A failure among the rows that remain does not change that: the missing
    // sibling cannot be re-queued, so retrying only the failed half would
    // execute half the configuration. Stopped wins over failed.
    expect(deriveDraftExecution('approved', tracked(['execution_failed'], 2))).toBe('stopped');
    expect(deriveDraftExecution('approved', tracked(['execution_failed', 'approved'], 3))).toBe('stopped');
    // The full set present and failed alongside a retryable sibling is still failed.
    expect(deriveDraftExecution('approved', tracked(['execution_failed', 'executed'], 2))).toBe('failed');
  });

  it('an approved draft with nothing to track is null, never a vacuous executed', () => {
    expect(deriveDraftExecution('approved', tracked([], 0))).toBeNull();
    expect(deriveDraftExecution('approved', undefined)).toBeNull();
  });

  it('a draft still being edited has no execution state', () => {
    expect(deriveDraftExecution('draft', tracked(['approved', 'approved']))).toBeNull();
    expect(deriveDraftExecution('draft', undefined)).toBeNull();
  });
});

describe('deriveOnboardingStatus — draft execution on the status', () => {
  const approved = (statuses: string[]) =>
    facts({
      draft: { status: 'approved', choicesAnswered: 7, version: 3, proposals: { expected: 2, members: statuses.map((st) => member(st)) } },
    });

  it('carries execution in draft, keeps seven steps, and does not leak the raw statuses', () => {
    const r = deriveOnboardingStatus(approved(['execution_failed', 'executed']));
    expect(r.draft).toEqual({ status: 'approved', choicesAnswered: 7, version: 3, execution: 'failed', undoable: false, recovery: 'settings' });
    expect(r.draft).not.toHaveProperty('proposals');
    expect(r.steps).toHaveLength(7);
  });

  it('does not change a single step id or status with or without the draft', () => {
    const base = deriveOnboardingStatus(facts());
    const withDraft = deriveOnboardingStatus(approved(['approved', 'approved']));
    expect(withDraft.steps).toEqual(base.steps);
    expect(withDraft.currentStep).toBe(base.currentStep);
    expect(withDraft.draft?.execution).toBe('pending');
  });
});

describe('deriveOnboardingStatus — the phone step\'s failure code (S5b-1)', () => {
  const lineFacts = { twilioPhoneNumber: '+12165550123', twilioLineState: 'failed' as const, twilioPendingNumber: '+12165550199' };
  const phone = (r: ReturnType<typeof deriveOnboardingStatus>) => r.steps.find((s) => s.id === 'phone')!;

  it.each([
    ['area_code_unavailable', ['area_code_unavailable', 'twilio_provisioning_failed']],
    ['credentials_missing', ['twilio_credentials_missing', 'twilio_provisioning_failed']],
    ['provider_error', ['twilio_provider_error', 'twilio_provisioning_failed']],
    ['unknown', ['twilio_provisioning_failed']],
  ] as const)('a failed row with %s → error, the code, and its blockers', (code, blockers) => {
    const r = deriveOnboardingStatus(billingDoneFacts({ twilioStatus: 'failed', twilioFailureCode: code, ...lineFacts }));
    expect(phone(r)).toEqual({
      id: 'phone',
      status: 'error',
      failureCode: code,
      blockers,
      metadata: { phoneNumber: '+12165550123', lineState: 'failed', pendingNumber: '+12165550199' },
    });
  });

  it('a failed row with no code in the facts reads as unknown (a failed step always carries a code)', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({ twilioStatus: 'failed' }));
    expect(phone(r)).toEqual({ id: 'phone', status: 'error', failureCode: 'unknown', blockers: ['twilio_provisioning_failed'] });
  });

  it.each([
    ['full_readiness', 'done'],
    ['t0_requested', 'current'],
  ] as const)('a row that did not fail (%s) carries no failureCode, even if a stale one is in the facts', (twilioStatus, status) => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      twilioStatus,
      twilioFailureCode: 'provider_error',
      twilioPhoneNumber: '+12165550123',
      twilioLineState: twilioStatus === 'full_readiness' ? 'active' : 'claiming',
      twilioPendingNumber: '+12165550199',
    }));
    const step = phone(r);
    expect(step.status).toBe(status);
    expect(step).not.toHaveProperty('failureCode');
    expect(step).not.toHaveProperty('blockers');
    expect(step.metadata).toEqual({
      phoneNumber: '+12165550123',
      lineState: twilioStatus === 'full_readiness' ? 'active' : 'claiming',
      pendingNumber: '+12165550199',
    });
  });

  it('no other step gains a failureCode', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({ twilioStatus: 'failed', twilioFailureCode: 'provider_error' }));
    for (const s of r.steps.filter((x) => x.id !== 'phone')) expect(s).not.toHaveProperty('failureCode');
/**
 * S4 (U9) — the two derived hints on the status draft block. Both are computed
 * on a FIXED clock (deriveOnboardingStatus's second argument), one second ahead
 * of it, so the shell is never offered an Undo or a Start over the endpoint
 * would refuse.
 */
describe('deriveOnboardingStatus — draft undoable and recovery (fixed clock)', () => {
  const T0 = new Date('2026-10-19T12:00:00.000Z');
  const at = (ms: number) => new Date(T0.getTime() + ms);
  const statusOf = (members: DraftProposalMember[], now: Date, expected = 2) =>
    deriveOnboardingStatus(
      facts({ draft: { status: 'approved', choicesAnswered: 7, version: 3, proposals: { expected, members } } }),
      now,
    ).draft!;
  /** Approved at T0 (the window opens there). */
  const fresh = (status = 'approved') => member(status, T0);

  describe('undoable', () => {
    it('is absent while the draft is still being edited, and so is recovery', () => {
      const d = deriveOnboardingStatus(facts({ draft: { status: 'draft', choicesAnswered: 3, version: 4 } }), at(0)).draft!;
      expect(d).not.toHaveProperty('undoable');
      expect(d).not.toHaveProperty('recovery');
    });

    it('is false for an approved draft with nothing listed and for a listed proposal that no longer exists', () => {
      const none = deriveOnboardingStatus(facts({ draft: { status: 'approved', choicesAnswered: 7, version: 2 } }), at(0)).draft!;
      expect(none.undoable).toBe(false);
      expect(statusOf([], at(0), 0).undoable).toBe(false);
      expect(statusOf([fresh()], at(1000), 2).undoable).toBe(false);
    });

    it('is true only while every member is approved inside its window, one second early', () => {
      expect(statusOf([fresh(), fresh()], at(0)).undoable).toBe(true);
      expect(statusOf([fresh(), fresh()], at(3900)).undoable).toBe(true);
      expect(statusOf([fresh(), fresh()], at(4000)).undoable).toBe(false);
      expect(statusOf([fresh(), fresh()], at(UNDO_WINDOW_MS)).undoable).toBe(false);
      // One member approved later (a fresh window) does not reopen the older one.
      expect(statusOf([fresh(), member('approved', at(3000))], at(4000)).undoable).toBe(false);
      // An approved row with no approval stamp is outside its window.
      expect(statusOf([fresh(), member('approved', null)], at(0)).undoable).toBe(false);
    });

    it.each(['executing', 'executed', 'execution_failed', 'undone', 'rejected', 'expired'])(
      'is false when a member is %s beside one still inside its window',
      (other) => {
        expect(statusOf([fresh(), fresh(other)], at(1000)).undoable).toBe(false);
        expect(statusOf([fresh(other), fresh()], at(1000)).undoable).toBe(false);
      },
    );
  });

  describe('recovery', () => {
    it.each<[string, number, 'reset' | 'settings', DraftProposalMember[]]>([
      // Something already ran or is running: only Settings can finish it.
      ['failed beside executing', 1000, 'settings', [fresh('execution_failed'), fresh('executing')]],
      ['failed beside executed', 1000, 'settings', [fresh('execution_failed'), fresh('executed')]],
      ['undone beside executed', 1000, 'settings', [fresh('undone'), fresh('executed')]],
      ['expired beside executing', 1000, 'settings', [fresh('expired'), fresh('executing')]],
      ['rejected beside executed, either order', 1000, 'settings', [fresh('executed'), fresh('rejected')]],
      // An approved member: reset only while its window is open, one second early.
      ['failed beside approved at 3.9 s', 3900, 'reset', [fresh('execution_failed'), fresh()]],
      ['failed beside approved at 4.0 s', 4000, 'settings', [fresh('execution_failed'), fresh()]],
      ['failed beside approved with no stamp', 0, 'settings', [fresh('execution_failed'), member('approved', null)]],
      ['undone beside approved at 3.9 s', 3900, 'reset', [fresh('undone'), fresh()]],
      ['undone beside approved at 4.0 s', 4000, 'settings', [fresh('undone'), fresh()]],
      ['rejected beside approved in its window', 1000, 'reset', [fresh('rejected'), fresh()]],
      // Nothing ran and nothing approved: reset can always clear it.
      ['failed beside undone', 9000, 'reset', [fresh('execution_failed'), fresh('undone')]],
      ['undone beside failed', 9000, 'reset', [fresh('undone'), fresh('execution_failed')]],
      ['undone beside undone', 9000, 'reset', [fresh('undone'), fresh('undone')]],
      ['failed beside failed', 9000, 'reset', [fresh('execution_failed'), fresh('execution_failed')]],
      ['failed beside a stuck draft', 9000, 'reset', [fresh('execution_failed'), fresh('draft')]],
      ['expired beside rejected', 9000, 'reset', [fresh('expired'), fresh('rejected')]],
    ])('%s, read at +%i ms, is %s', (_label, offset, expected, members) => {
      const d = statusOf(members, at(offset));
      expect(['failed', 'stopped']).toContain(d.execution);
      expect(d.recovery).toBe(expected);
    });

    it('is reset for a missing member beside one approved inside its window, settings once it closes', () => {
      expect(statusOf([fresh()], at(1000), 2)).toMatchObject({ execution: 'stopped', recovery: 'reset' });
      expect(statusOf([fresh()], at(4000), 2)).toMatchObject({ execution: 'stopped', recovery: 'settings' });
      expect(statusOf([], at(9000), 2)).toMatchObject({ execution: 'stopped', recovery: 'reset' });
    });

    it.each<[string, DraftProposalMember[]]>([
      ['pending', [fresh(), fresh()]],
      ['executing', [fresh(), fresh('executing')]],
      ['executed', [fresh('executed'), fresh('executed')]],
    ])('is absent while the set is %s', (execution, members) => {
      const d = statusOf(members, at(1000));
      expect(d.execution).toBe(execution);
      expect(d).not.toHaveProperty('recovery');
    });

    it('keeps seven steps with the same ids whatever the hints say', () => {
      const base = deriveOnboardingStatus(facts(), at(0));
      const r = deriveOnboardingStatus(
        facts({ draft: { status: 'approved', choicesAnswered: 7, version: 3, proposals: { expected: 2, members: [fresh('undone'), fresh()] } } }),
        at(1000),
      );
      expect(r.steps.map((s) => s.id)).toEqual(['signup', 'identity', 'pack', 'billing', 'phone', 'ai_check', 'test_call']);
      expect(r.steps).toEqual(base.steps);
    });
  });

  /**
   * The hints never promise more than the endpoints grant. Undo wants every
   * member approved inside its window at the instant it runs; reset wants
   * nothing executing or executed and every approved member inside its window.
   * Both predicates are written here from lifecycle's own `isInUndoWindow` at
   * the status clock with NO margin, independent of the derivation under test.
   */
  it('sweep 0..8 s in 250 ms steps: undoable implies undo is allowed, reset implies reset is allowed', () => {
    const sets: DraftProposalMember[][] = [
      [fresh(), fresh()],
      [fresh(), member('approved', at(2000))],
      [fresh('undone'), fresh()],
      [fresh('execution_failed'), member('approved', at(1500))],
      [fresh('rejected'), fresh()],
    ];
    const undoAllowed = (members: DraftProposalMember[], nowMs: number) =>
      members.length === 2 && members.every((m) => isInUndoWindow(m, nowMs));
    const resetAllowed = (members: DraftProposalMember[], nowMs: number) =>
      !members.some((m) => m.status === 'executing' || m.status === 'executed') &&
      members.filter((m) => m.status === 'approved').every((m) => isInUndoWindow(m, nowMs));

    const seen = { undoable: new Set<boolean>(), recovery: new Set<string | undefined>() };
    for (const members of sets) {
      for (let offset = 0; offset <= 8000; offset += 250) {
        const now = at(offset);
        const d = statusOf(members, now);
        seen.undoable.add(d.undoable!);
        seen.recovery.add(d.recovery);
        if (d.undoable) expect(undoAllowed(members, now.getTime()), `undo at +${offset} ms`).toBe(true);
        if (d.recovery === 'reset') expect(resetAllowed(members, now.getTime()), `reset at +${offset} ms`).toBe(true);
      }
    }
    // Not vacuous: the sweep crosses both edges of both hints.
    expect([...seen.undoable].sort()).toEqual([false, true]);
    expect(seen.recovery).toEqual(new Set([undefined, 'reset', 'settings']));
  });
});
