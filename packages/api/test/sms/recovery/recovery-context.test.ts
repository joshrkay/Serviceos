import { describe, it, expect } from 'vitest';
import {
  buildRecoveryContext,
  InMemoryDroppedCallRecoveryRepository,
  DroppedCallScheduler,
} from '../../../src/sms/recovery/scheduler';
import { composeStateAwareCue } from '../../../src/sms/recovery/state-aware-cue';
import {
  handleDroppedCallRecovery,
  type DroppedCallHandlerDeps,
} from '../../../src/sms/recovery/dropped-call-handler';
import { InMemoryAuditRepository } from '../../../src/audit/audit';

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

describe('RV-115 — buildRecoveryContext (per FSM state bucket)', () => {
  it('proposal_created: a queued proposal wins regardless of intent', () => {
    const ctx = buildRecoveryContext({
      state: 'terminated',
      currentIntent: 'create_appointment',
      extractedEntities: { date: 'tomorrow', ignored: 42 as unknown as string },
      proposalIds: ['p1'],
    });
    expect(ctx.bucket).toBe('proposal_created');
    expect(ctx.proposalIds).toEqual(['p1']);
    expect(ctx.intent).toBe('create_appointment');
    // Only string-valued entities survive the snapshot.
    expect(ctx.entitiesResolved).toEqual({ date: 'tomorrow' });
  });

  it('mid_intent: intent captured, nothing queued', () => {
    const ctx = buildRecoveryContext({
      state: 'terminated',
      currentIntent: 'booking',
      proposalIds: [],
    });
    expect(ctx.bucket).toBe('mid_intent');
    expect(ctx.intent).toBe('booking');
  });

  it('early: dropped before intent capture', () => {
    const ctx = buildRecoveryContext({ state: 'terminated', proposalIds: [] });
    expect(ctx.bucket).toBe('early');
    expect(ctx.intent).toBeUndefined();
  });
});

describe('RV-115 — composeStateAwareCue', () => {
  it('proposal_created → status cue', () => {
    const cue = composeStateAwareCue({
      state: 'terminated',
      bucket: 'proposal_created',
      proposalIds: ['p1'],
    });
    expect(cue).toContain('We saved your request');
  });

  it('mid_intent → curated "about your <intent>" cue (never the raw slug)', () => {
    expect(
      composeStateAwareCue({
        state: 'terminated',
        bucket: 'mid_intent',
        intent: 'booking',
        proposalIds: [],
      }),
    ).toContain('book an appointment');
    // Unknown slugs degrade to no cue — never leak the classifier label.
    expect(
      composeStateAwareCue({
        state: 'terminated',
        bucket: 'mid_intent',
        intent: 'some_weird_internal_slug',
        proposalIds: [],
      }),
    ).toBe('');
  });

  it('early / missing context → no cue', () => {
    expect(
      composeStateAwareCue({ state: 'terminated', bucket: 'early', proposalIds: [] }),
    ).toBe('');
    expect(composeStateAwareCue(null)).toBe('');
    expect(composeStateAwareCue(undefined)).toBe('');
  });
});

describe('RV-115 — scheduler persists the context onto the durable row', () => {
  it('schedule() stores context; idempotent re-schedule fills a missing one and never overwrites', async () => {
    const repo = new InMemoryDroppedCallRecoveryRepository();
    const scheduler = new DroppedCallScheduler(repo, noopLogger);
    const first = await scheduler.schedule({
      tenantId: 't1',
      voiceSessionId: 's1',
      callerE164: '+15125550111',
      outcome: 'dropped',
      channel: 'voice_inbound',
      context: {
        state: 'terminated',
        bucket: 'mid_intent',
        intent: 'booking',
        proposalIds: [],
      },
    });
    expect(first?.context?.bucket).toBe('mid_intent');

    const again = await scheduler.schedule({
      tenantId: 't1',
      voiceSessionId: 's1',
      callerE164: '+15125550111',
      outcome: 'dropped',
      channel: 'voice_inbound',
      context: { state: 'terminated', bucket: 'early', proposalIds: [] },
    });
    // Idempotent: the original context wins.
    expect(again?.id).toBe(first?.id);
    expect(repo.rows[0].context?.bucket).toBe('mid_intent');
  });

  it('detection still rejects non-recovery outcomes (no row, context or not)', async () => {
    const repo = new InMemoryDroppedCallRecoveryRepository();
    const scheduler = new DroppedCallScheduler(repo, noopLogger);
    const row = await scheduler.schedule({
      tenantId: 't1',
      voiceSessionId: 's2',
      callerE164: '+15125550111',
      outcome: 'completed',
      channel: 'voice_inbound',
      context: { state: 'closing', bucket: 'proposal_created', proposalIds: ['p'] },
    });
    expect(row).toBeNull();
    expect(repo.rows).toHaveLength(0);
  });
});

describe('RV-115 — recovery SMS handler composes the state-aware cue', () => {
  function handlerDeps(overrides: Partial<Omit<DroppedCallHandlerDeps, 'repo'>> = {}) {
    const composed: Array<{ contextCue: string }> = [];
    const deps: Omit<DroppedCallHandlerDeps, 'repo'> = {
      audit: new InMemoryAuditRepository(),
      logger: noopLogger,
      rateLimit: { check: async () => true, record: async () => undefined },
      resolvedSince: async () => null,
      compose: async ({ contextCue }) => {
        composed.push({ contextCue });
        return `Sorry we got cut off. ${contextCue}`.trim();
      },
      sendSms: async () => 'SM-1',
      ...overrides,
    };
    return { deps, composed };
  }

  it('a proposal_created context yields the status cue (no topIntentFor lookup needed)', async () => {
    const repo = new InMemoryDroppedCallRecoveryRepository();
    const row = await repo.schedule({
      tenantId: 't1',
      voiceSessionId: 's1',
      callerE164: '+15125550111',
      scheduledFor: new Date(),
      context: { state: 'terminated', bucket: 'proposal_created', proposalIds: ['p1'] },
    });
    const { deps, composed } = handlerDeps();
    const result = await handleDroppedCallRecovery(row, { repo, ...deps });
    expect(result.action).toBe('sent');
    expect(composed[0].contextCue).toContain('We saved your request');
  });

  it('a mid_intent context yields the intent cue; a context-free row falls back to topIntentFor', async () => {
    const repo = new InMemoryDroppedCallRecoveryRepository();
    const withContext = await repo.schedule({
      tenantId: 't1',
      voiceSessionId: 's2',
      callerE164: '+15125550112',
      scheduledFor: new Date(),
      context: { state: 'terminated', bucket: 'mid_intent', intent: 'plumbing', proposalIds: [] },
    });
    const { deps, composed } = handlerDeps({
      topIntentFor: async () => 'estimate',
    });
    await handleDroppedCallRecovery(withContext, { repo, ...deps });
    expect(composed[0].contextCue).toContain('plumbing issue');

    const legacy = await repo.schedule({
      tenantId: 't1',
      voiceSessionId: 's3',
      callerE164: '+15125550113',
      scheduledFor: new Date(),
    });
    await handleDroppedCallRecovery(legacy, { repo, ...deps });
    expect(composed[1].contextCue).toContain('estimate');
  });
});
