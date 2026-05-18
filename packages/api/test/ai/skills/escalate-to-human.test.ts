import { describe, it, expect, vi } from 'vitest';
import { escalateToHuman, mapSkillReasonToBuilderReason } from '../../../src/ai/skills/escalate-to-human';
import { InMemoryOnCallRepository } from '../../../src/oncall/rotation';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import type { OnCallEntry } from '../../../src/oncall/rotation';
import type { EscalateToHumanInput } from '../../../src/ai/skills/escalate-to-human';

const TENANT_ID = 'tenant-test-001';
const SESSION_ID = 'session-abc-123';

function makeEntry(overrides: Partial<OnCallEntry> = {}): OnCallEntry {
  return {
    id: 'entry-1',
    userId: 'user-dispatcher-1',
    orderIndex: 0,
    ...overrides,
  };
}

function makeInput(overrides: Partial<EscalateToHumanInput> = {}): EscalateToHumanInput {
  return {
    tenantId: TENANT_ID,
    sessionId: SESSION_ID,
    reason: 'caller_requested',
    channel: 'inapp',
    onCallRepo: new InMemoryOnCallRepository(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Successful escalation
// ---------------------------------------------------------------------------

describe('escalateToHuman — successful escalation', () => {
  it('returns escalated: true with assignedUserId when a dispatcher is on-call', async () => {
    const entry = makeEntry({ userId: 'dispatcher-42' });
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([[TENANT_ID, [entry]]])
    );
    const result = await escalateToHuman(makeInput({ onCallRepo }));
    expect(result.escalated).toBe(true);
    expect(result.assignedUserId).toBe('dispatcher-42');
  });

  it('returns a connecting message for non-emergency escalations', async () => {
    const entry = makeEntry();
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([[TENANT_ID, [entry]]])
    );
    const result = await escalateToHuman(makeInput({ onCallRepo, reason: 'low_confidence' }));
    // P11-002 i18n catalog rephrased "connecting you" → "transferring you".
    expect(result.message).toMatch(/transferring/i);
  });

  it('emits an escalation.requested audit event when auditRepo is provided', async () => {
    const entry = makeEntry({ userId: 'disp-99' });
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([[TENANT_ID, [entry]]])
    );
    const auditRepo = new InMemoryAuditRepository();
    await escalateToHuman(makeInput({ onCallRepo, auditRepo }));

    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('escalation.requested');
    expect(events[0].tenantId).toBe(TENANT_ID);
    expect(events[0].metadata?.assignedUserId).toBe('disp-99');
    expect(events[0].metadata?.reason).toBe('caller_requested');
  });

  it('includes the reason in the audit event metadata', async () => {
    const entry = makeEntry();
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([[TENANT_ID, [entry]]])
    );
    const auditRepo = new InMemoryAuditRepository();
    await escalateToHuman(makeInput({ onCallRepo, auditRepo, reason: 'cost_cap_exceeded' }));

    const events = auditRepo.getAll();
    expect(events[0].metadata?.reason).toBe('cost_cap_exceeded');
  });

  it('does not throw when auditRepo is not provided', async () => {
    const entry = makeEntry();
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([[TENANT_ID, [entry]]])
    );
    await expect(escalateToHuman(makeInput({ onCallRepo }))).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// No dispatcher available
// ---------------------------------------------------------------------------

describe('escalateToHuman — no dispatcher on call', () => {
  it('returns escalated: false when rotation is empty', async () => {
    const onCallRepo = new InMemoryOnCallRepository();
    const result = await escalateToHuman(makeInput({ onCallRepo }));
    expect(result.escalated).toBe(false);
  });

  it('returns a follow-up message when no dispatcher is available', async () => {
    const onCallRepo = new InMemoryOnCallRepository();
    const result = await escalateToHuman(makeInput({ onCallRepo }));
    expect(result.message).toMatch(/follow up/i);
  });

  it('does not set assignedUserId when no dispatcher found', async () => {
    const onCallRepo = new InMemoryOnCallRepository();
    const result = await escalateToHuman(makeInput({ onCallRepo }));
    expect(result.assignedUserId).toBeUndefined();
  });

  it('still emits an audit event when auditRepo provided and no dispatcher found', async () => {
    const onCallRepo = new InMemoryOnCallRepository();
    const auditRepo = new InMemoryAuditRepository();
    await escalateToHuman(makeInput({ onCallRepo, auditRepo }));

    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('escalation.requested');
    expect(events[0].metadata?.outcome).toBe('no_dispatcher_available');
  });
});

// ---------------------------------------------------------------------------
// Emergency dispatch reason
// ---------------------------------------------------------------------------

describe('escalateToHuman — emergency_dispatch reason', () => {
  it('returns an urgency-indicating message for emergency_dispatch', async () => {
    const entry = makeEntry();
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([[TENANT_ID, [entry]]])
    );
    const result = await escalateToHuman(
      makeInput({ onCallRepo, reason: 'emergency_dispatch' })
    );
    expect(result.escalated).toBe(true);
    expect(result.message).toMatch(/emergency/i);
  });

  it('includes emergencyDescription in the message when provided', async () => {
    const entry = makeEntry();
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([[TENANT_ID, [entry]]])
    );
    const result = await escalateToHuman(
      makeInput({
        onCallRepo,
        reason: 'emergency_dispatch',
        emergencyDescription: 'gas leak detected',
      })
    );
    expect(result.message).toContain('gas leak detected');
  });

  it('still escalates successfully with emergency_dispatch reason', async () => {
    const entry = makeEntry({ userId: 'emergency-dispatcher' });
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([[TENANT_ID, [entry]]])
    );
    const result = await escalateToHuman(
      makeInput({ onCallRepo, reason: 'emergency_dispatch' })
    );
    expect(result.escalated).toBe(true);
    expect(result.assignedUserId).toBe('emergency-dispatcher');
  });
});

// ---------------------------------------------------------------------------
// Telephony channel (v1 in-app behavior)
// ---------------------------------------------------------------------------

describe('escalateToHuman — telephony channel (v1)', () => {
  it('behaves identically to inapp channel for a found dispatcher', async () => {
    const entry = makeEntry({ userId: 'disp-telephony' });
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([[TENANT_ID, [entry]]])
    );
    const result = await escalateToHuman(
      makeInput({ onCallRepo, channel: 'telephony' })
    );
    expect(result.escalated).toBe(true);
    expect(result.assignedUserId).toBe('disp-telephony');
  });

  it('behaves identically to inapp channel when no dispatcher found', async () => {
    const onCallRepo = new InMemoryOnCallRepository();
    const result = await escalateToHuman(
      makeInput({ onCallRepo, channel: 'telephony' })
    );
    expect(result.escalated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// escalate_with_context — summary builder wiring
// ---------------------------------------------------------------------------

describe('escalateToHuman — emits escalate_with_context', () => {
  it('returns an EscalationResult whose transfer includes a built summary', async () => {
    const onCallRepo = {
      listRotation: vi.fn(async () => [
        { id: 'rot-1', userId: 'user-disp-1', phone: '+15125550999', cursorIndex: 0 },
      ]),
    };
    const dispatcherPhoneResolver = vi.fn(async () => '+15125550999');
    const buildSummary = vi.fn(() => ({
      whisper: 'Incoming call from Sarah Chen.',
      sms: 'Test SMS body',
      panel: { header: {}, customer: {}, lastInteraction: null, intent: {}, reason: {}, transcriptSnapshot: [] },
    }));

    const result = await escalateToHuman({
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      reason: 'caller_requested',
      channel: 'telephony',
      callSid: 'CA-test',
      onCallRepo: onCallRepo as never,
      dispatcherPhoneResolver,
      buildSummary,
      shopName: "Joe's HVAC",
      callerContext: {
        caller: { name: 'Sarah Chen', phone: '+15125550142' },
        intent: { type: 'create_appointment', entities: {}, confidence: 0.4 },
        transcriptSnapshot: [],
      },
    });

    expect(result.escalated).toBe(true);
    expect(buildSummary).toHaveBeenCalledTimes(1);
    expect(result.transfer).toBeDefined();
    expect(result.transfer?.summary).toBeDefined();
    expect(result.transfer?.summary?.whisper).toContain('Sarah Chen');
  });

  it('returns summary=undefined when buildSummary throws but transfer still succeeds', async () => {
    const onCallRepo = {
      listRotation: vi.fn(async () => [
        { id: 'rot-1', userId: 'user-disp-1', phone: '+15125550999', cursorIndex: 0 },
      ]),
      getCursor: vi.fn(async () => ({ index: 0 })),
      setCursorAfter: vi.fn(async () => undefined),
    };
    const buildSummary = vi.fn(() => { throw new Error('template missing'); });

    const result = await escalateToHuman({
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      reason: 'caller_requested',
      channel: 'telephony',
      callSid: 'CA-test',
      onCallRepo: onCallRepo as never,
      dispatcherPhoneResolver: async () => '+15125550999',
      buildSummary,
      shopName: "Joe's HVAC",
      callerContext: {
        caller: { name: 'Sarah Chen', phone: '+15125550142' },
        intent: { type: 'create_appointment', entities: {}, confidence: 0.4 },
        transcriptSnapshot: [],
      },
    });

    expect(result.escalated).toBe(true);
    expect(result.transfer?.summary).toBeUndefined();
    expect(result.transfer?.escalationId).toBeUndefined();
  });

  it('omits summary when callerContext is missing even if buildSummary is provided', async () => {
    const onCallRepo = {
      listRotation: vi.fn(async () => [
        { id: 'rot-1', userId: 'user-disp-1', phone: '+15125550999', cursorIndex: 0 },
      ]),
      getCursor: vi.fn(async () => ({ index: 0 })),
      setCursorAfter: vi.fn(async () => undefined),
    };
    const buildSummary = vi.fn();
    const result = await escalateToHuman({
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      reason: 'caller_requested',
      channel: 'telephony',
      callSid: 'CA-test',
      onCallRepo: onCallRepo as never,
      dispatcherPhoneResolver: async () => '+15125550999',
      buildSummary,
    });
    expect(buildSummary).not.toHaveBeenCalled();
    expect(result.transfer?.summary).toBeUndefined();
    expect(result.transfer?.escalationId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapSkillReasonToBuilderReason — reason mapping
// ---------------------------------------------------------------------------

describe('mapSkillReasonToBuilderReason', () => {
  it('maps caller_requested → operator_request', () => {
    expect(mapSkillReasonToBuilderReason('caller_requested')).toBe('operator_request');
  });
  it('maps emergency_dispatch → emergency_dispatch', () => {
    expect(mapSkillReasonToBuilderReason('emergency_dispatch')).toBe('emergency_dispatch');
  });
  it('maps low_confidence → low_confidence_intent', () => {
    expect(mapSkillReasonToBuilderReason('low_confidence')).toBe('low_confidence_intent');
  });
  it('maps max_retries_exceeded → low_confidence_intent', () => {
    expect(mapSkillReasonToBuilderReason('max_retries_exceeded')).toBe('low_confidence_intent');
  });
  it('maps cost_cap_exceeded → low_confidence_intent', () => {
    expect(mapSkillReasonToBuilderReason('cost_cap_exceeded')).toBe('low_confidence_intent');
  });
  it('maps abuse_detected → low_confidence_intent', () => {
    expect(mapSkillReasonToBuilderReason('abuse_detected')).toBe('low_confidence_intent');
  });
  it('maps provider_failure → low_confidence_intent', () => {
    expect(mapSkillReasonToBuilderReason('provider_failure')).toBe('low_confidence_intent');
  });
});
