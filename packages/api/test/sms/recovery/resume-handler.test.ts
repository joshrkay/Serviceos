import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createDroppedCallResumeHandler,
  composeBookingStatusReply,
  composeCallbackReply,
} from '../../../src/sms/recovery/resume-handler';
import { InMemoryDroppedCallRecoveryRepository } from '../../../src/sms/recovery/scheduler';
import { InMemoryCallMeBackRepository } from '../../../src/voice/call-me-back/call-me-back';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import {
  __resetKeywordRegistryForTests,
  dispatchInboundSms,
  registerKeywordHandler,
  registerRecoveryResumeHandler,
} from '../../../src/sms/inbound-dispatch';
import type { Proposal } from '../../../src/proposals/proposal';

const TENANT = 't1';
const CALLER = '+15125550111';

function ctx(body: string) {
  return { tenantId: TENANT, fromE164: CALLER, body, messageSid: 'SM-resume-1' };
}

async function seedRecovery(
  repo: InMemoryDroppedCallRecoveryRepository,
  context?: Parameters<InMemoryDroppedCallRecoveryRepository['schedule']>[0]['context'],
) {
  return repo.schedule({
    tenantId: TENANT,
    voiceSessionId: 'sess-1',
    callerE164: '(512) 555-0111', // formatting drift — matching is digit-based
    scheduledFor: new Date(),
    ...(context ? { context } : {}),
  });
}

function proposalStub(status: string): Proposal {
  const now = new Date();
  return {
    id: 'p1',
    tenantId: TENANT,
    proposalType: 'create_booking',
    status,
    payload: {},
    summary: 'booking',
    createdBy: 'agent',
    createdAt: now,
    updatedAt: now,
  } as unknown as Proposal;
}

describe('RV-116 — dropped-call resume handler', () => {
  it('no recovery thread for the phone → declines (handled false)', async () => {
    const handler = createDroppedCallResumeHandler({
      recoveryRepo: new InMemoryDroppedCallRecoveryRepository(),
      sendSms: vi.fn(),
    });
    const result = await handler.handle(ctx('hi'));
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('no_recovery_thread');
  });

  it('open booking proposal in the context → confirms by status cue', async () => {
    const repo = new InMemoryDroppedCallRecoveryRepository();
    await seedRecovery(repo, {
      state: 'terminated',
      bucket: 'proposal_created',
      proposalIds: ['p1'],
    });
    const sendSms = vi.fn(async () => ({}));
    const auditRepo = new InMemoryAuditRepository();
    const handler = createDroppedCallResumeHandler({
      recoveryRepo: repo,
      proposalRepo: { findById: vi.fn(async () => proposalStub('ready_for_review')) },
      callMeBackRepo: new InMemoryCallMeBackRepository(),
      sendSms,
      auditRepo,
      businessName: 'Acme',
    });
    const result = await handler.handle(ctx('yes please'));
    expect(result.handled).toBe(true);
    expect(sendSms).toHaveBeenCalledWith({
      to: CALLER,
      body: composeBookingStatusReply('Acme'),
      tenantId: TENANT,
    });
    expect(
      auditRepo.getAll().some(
        (e) =>
          e.eventType === 'dropped_call_recovery.resumed' &&
          (e.metadata as { outcome?: string }).outcome === 'booking_status_sent',
      ),
    ).toBe(true);
  });

  it('mid-intent context → creates a call_me_back task and acknowledges', async () => {
    const repo = new InMemoryDroppedCallRecoveryRepository();
    await seedRecovery(repo, {
      state: 'terminated',
      bucket: 'mid_intent',
      intent: 'plumbing',
      proposalIds: [],
    });
    const callMeBackRepo = new InMemoryCallMeBackRepository();
    const sendSms = vi.fn(async () => ({}));
    const handler = createDroppedCallResumeHandler({
      recoveryRepo: repo,
      callMeBackRepo,
      sendSms,
      businessName: 'Acme',
    });
    const result = await handler.handle(ctx('still need help with the leak'));
    expect(result.handled).toBe(true);
    const pending = await callMeBackRepo.listPending(TENANT);
    expect(pending).toHaveLength(1);
    expect(pending[0].reason).toBe('dropped_call_resume');
    expect(pending[0].callerPhone).toBe(CALLER);
    expect(pending[0].intentSummary).toBe('plumbing');
    expect(sendSms).toHaveBeenCalledWith({ to: CALLER, body: composeCallbackReply('Acme'), tenantId: TENANT });
  });

  it('resolved proposal (executed) falls through to the callback path', async () => {
    const repo = new InMemoryDroppedCallRecoveryRepository();
    await seedRecovery(repo, {
      state: 'terminated',
      bucket: 'proposal_created',
      proposalIds: ['p1'],
    });
    const callMeBackRepo = new InMemoryCallMeBackRepository();
    const handler = createDroppedCallResumeHandler({
      recoveryRepo: repo,
      proposalRepo: { findById: vi.fn(async () => proposalStub('executed')) },
      callMeBackRepo,
      sendSms: vi.fn(async () => ({})),
    });
    const result = await handler.handle(ctx('hello?'));
    expect(result.handled).toBe(true);
    expect(await callMeBackRepo.listPending(TENANT)).toHaveLength(1);
  });

  it('replies outside the 24h window do not resume', async () => {
    const repo = new InMemoryDroppedCallRecoveryRepository();
    const row = await seedRecovery(repo, {
      state: 'terminated',
      bucket: 'early',
      proposalIds: [],
    });
    // Age the row two days.
    repo.rows.find((r) => r.id === row.id)!.createdAt = new Date(
      Date.now() - 2 * 24 * 3600 * 1000,
    );
    const handler = createDroppedCallResumeHandler({
      recoveryRepo: repo,
      sendSms: vi.fn(),
    });
    expect((await handler.handle(ctx('hi'))).handled).toBe(false);
  });
});

describe('RV-116 — inbound dispatch integration (thread matching is LAST)', () => {
  beforeEach(() => {
    __resetKeywordRegistryForTests();
  });

  it('keyword routing wins over the resume handler', async () => {
    const resumeHandle = vi.fn(async () => ({ handled: true, handler: 'dropped-call-resume' }));
    registerRecoveryResumeHandler({ name: 'dropped-call-resume', handle: resumeHandle });
    registerKeywordHandler({
      keywords: ['stop'],
      handle: async () => ({ handled: true, handler: 'stop' }),
    });
    const result = await dispatchInboundSms(ctx('STOP'));
    expect(result.handler).toBe('stop');
    expect(resumeHandle).not.toHaveBeenCalled();
  });

  it('free text with no keyword/fallback match routes to the resume handler', async () => {
    const repo = new InMemoryDroppedCallRecoveryRepository();
    await seedRecovery(repo, {
      state: 'terminated',
      bucket: 'mid_intent',
      intent: 'booking',
      proposalIds: [],
    });
    const sendSms = vi.fn(async () => ({}));
    registerRecoveryResumeHandler(
      createDroppedCallResumeHandler({
        recoveryRepo: repo,
        callMeBackRepo: new InMemoryCallMeBackRepository(),
        sendSms,
      }),
    );
    const result = await dispatchInboundSms(ctx('about that appointment we discussed'));
    expect(result.handled).toBe(true);
    expect(result.handler).toBe('dropped-call-resume');
  });

  it('non-recovery free text still reports no_matching_handler', async () => {
    registerRecoveryResumeHandler(
      createDroppedCallResumeHandler({
        recoveryRepo: new InMemoryDroppedCallRecoveryRepository(),
        sendSms: vi.fn(),
      }),
    );
    const result = await dispatchInboundSms(ctx('random text'));
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('no_matching_handler');
  });

  it('a throwing resume handler is contained (dispatcher never throws)', async () => {
    registerRecoveryResumeHandler({
      name: 'dropped-call-resume',
      handle: async () => {
        throw new Error('boom');
      },
    });
    const result = await dispatchInboundSms(ctx('hello'));
    expect(result.handled).toBe(false);
  });
});
