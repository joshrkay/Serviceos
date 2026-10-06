import { describe, it, expect, vi } from 'vitest';
import { escalateToHuman, mapSkillReasonToBuilderReason } from '../../../src/ai/skills/escalate-to-human';
import { InMemoryOnCallRepository } from '../../../src/oncall/rotation';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { buildEscalationSummary } from '../../../src/ai/agents/customer-calling/escalation-summary-builder';
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
    // Voice-parity (Feature 7) — the transfer line speaks the spec phrasing
    // "let me get someone on the line for you" (escalate.transferring catalog key).
    expect(result.message).toMatch(/someone on the line/i);
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

describe('escalateToHuman — per-technician phone routing (U4)', () => {
  const callerContext = {
    caller: { name: 'Sarah Chen', phone: '+15125550142' },
    intent: { type: 'create_appointment', entities: {}, confidence: 0.4 },
    transcriptSnapshot: [],
  };

  it('advances the rotation past a numberless user to one who set a mobile', async () => {
    const onCallRepo = {
      listRotation: vi.fn(async () => [
        { id: 'rot-1', userId: 'u-no-phone', cursorIndex: 0 },
        { id: 'rot-2', userId: 'u-has-phone', cursorIndex: 1 },
      ]),
    };
    // per-user resolver: u-no-phone returns null (→ advance), u-has-phone resolves.
    const dispatcherPhoneResolver = vi.fn(async (_t: string, userId: string) =>
      userId === 'u-has-phone' ? '+15125550222' : null,
    );

    const result = await escalateToHuman({
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      reason: 'caller_requested',
      channel: 'telephony',
      callSid: 'CA-test',
      onCallRepo: onCallRepo as never,
      dispatcherPhoneResolver,
      callerContext,
    });

    expect(result.escalated).toBe(true);
    expect(result.transfer?.dispatcherPhone).toBe('+15125550222');
    expect(result.assignedUserId).toBe('u-has-phone');
    // the numberless user was consulted (then skipped), proving the walk advanced.
    expect(dispatcherPhoneResolver).toHaveBeenCalledWith('tenant-1', 'u-no-phone');
  });

  it('falls back to business_phone when NO on-call user has a personal mobile', async () => {
    const onCallRepo = {
      listRotation: vi.fn(async () => [
        { id: 'rot-1', userId: 'u-no-phone-1', cursorIndex: 0 },
        { id: 'rot-2', userId: 'u-no-phone-2', cursorIndex: 1 },
      ]),
    };

    const result = await escalateToHuman({
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      reason: 'caller_requested',
      channel: 'telephony',
      callSid: 'CA-test',
      onCallRepo: onCallRepo as never,
      dispatcherPhoneResolver: async () => null, // nobody set a personal mobile
      businessPhoneFallbackResolver: async () => '+15125550100',
      callerContext,
    });

    expect(result.escalated).toBe(true);
    expect(result.transfer?.dispatcherPhone).toBe('+15125550100');
    expect(result.transfer?.dispatcherUserId).toBe('business_phone');
  });

  it('gives up (no_dispatcher) when neither a personal mobile nor business_phone exists', async () => {
    const onCallRepo = {
      listRotation: vi.fn(async () => [{ id: 'rot-1', userId: 'u-no-phone', cursorIndex: 0 }]),
    };

    const result = await escalateToHuman({
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      reason: 'caller_requested',
      channel: 'telephony',
      onCallRepo: onCallRepo as never,
      dispatcherPhoneResolver: async () => null,
      businessPhoneFallbackResolver: async () => null,
    });

    expect(result.escalated).toBe(false);
    expect(result.transfer).toBeUndefined();
  });

  it('cascade guard — with NO fallback resolver wired, a numberless rotation terminates (escalated:false), preventing a business-line redial loop', async () => {
    // routes/telephony.ts deliberately omits businessPhoneFallbackResolver on
    // the /dial-result cascade so a no-answer on the shared line does NOT
    // redial it forever. Mirror that: per-user resolver returns null, no
    // fallback wired → the walk exhausts and we give up (→ voicemail), rather
    // than re-firing the business-line fallback on every cascade re-invocation.
    const onCallRepo = {
      listRotation: vi.fn(async () => [{ id: 'rot-1', userId: 'u-no-phone', cursorIndex: 0 }]),
    };

    const result = await escalateToHuman({
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      reason: 'caller_requested',
      channel: 'telephony',
      onCallRepo: onCallRepo as never,
      dispatcherPhoneResolver: async () => null,
      // businessPhoneFallbackResolver intentionally omitted (cascade behavior)
    });

    expect(result.escalated).toBe(false);
    expect(result.transfer).toBeUndefined();
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
  it('#1616 — maps identity_unverified → identity_unverified (an identity hand-off is not "low confidence")', () => {
    expect(mapSkillReasonToBuilderReason('identity_unverified')).toBe('identity_unverified');
  });
});

// ---------------------------------------------------------------------------
// #1616 — identity_unverified: what the dispatcher sees vs. what is recorded
// ---------------------------------------------------------------------------

describe('#1616 — identity_unverified names identity to the dispatcher but is recorded under its D-042 category', () => {
  it('summary panel says identity_unverified; the escalation.requested audit and escalation_triggered say max_retries_exceeded', async () => {
    const onCallRepo = {
      listRotation: vi.fn(async () => [{ id: 'rot-1', userId: 'user-disp-1', cursorIndex: 0 }]),
    };
    const auditRepo = new InMemoryAuditRepository();
    const store = new VoiceSessionStore({ startInterval: false });
    const session = store.create('tenant-1', 'telephony', { callSid: 'CA-1616' });
    const events: Array<Record<string, unknown>> = [];
    session.events.on('voice-event', (e: Record<string, unknown>) => events.push(e));

    const result = await escalateToHuman({
      tenantId: 'tenant-1',
      sessionId: session.id,
      reason: 'identity_unverified',
      channel: 'telephony',
      callSid: 'CA-1616',
      onCallRepo: onCallRepo as never,
      auditRepo,
      dispatcherPhoneResolver: async () => '+15125550999',
      session,
      buildSummary: buildEscalationSummary,
      shopName: "Joe's HVAC",
      callerContext: {
        caller: { phone: '+15555550404', claimedName: 'Jane Smith' },
        identityCase: 'claims',
        intent: { type: 'unknown', entities: {}, confidence: 1 },
        transcriptSnapshot: [],
      },
    });
    store.dispose();

    expect(result.transfer?.summary?.panel.reason.code).toBe('identity_unverified');
    // D-042 (4): the recorded category — audit metadata and the Layer 1
    // event — is what #1614 pinned; #1616 changes only what the dispatcher sees.
    expect(auditRepo.getAll().map((e) => e.metadata?.reason)).toEqual(['max_retries_exceeded']);
    expect(events.find((e) => e.type === 'escalation_triggered')?.reason).toBe('max_retries_exceeded');
  });
});

describe('#1630 — the dispatcher language is separate from the caller-facing language', () => {
  it('dispatcherLanguage=es renders the Spanish summary while the caller-facing message stays English', async () => {
    const onCallRepo = {
      listRotation: vi.fn(async () => [{ id: 'rot-1', userId: 'user-disp-1', cursorIndex: 0 }]),
    };
    const store = new VoiceSessionStore({ startInterval: false });
    const session = store.create('tenant-1', 'telephony', { callSid: 'CA-1630' });

    const result = await escalateToHuman({
      tenantId: 'tenant-1',
      sessionId: session.id,
      reason: 'identity_unverified',
      channel: 'telephony',
      callSid: 'CA-1630',
      onCallRepo: onCallRepo as never,
      auditRepo: new InMemoryAuditRepository(),
      dispatcherPhoneResolver: async () => '+15125550999',
      session,
      dispatcherLanguage: 'es',
      buildSummary: buildEscalationSummary,
      shopName: "Joe's HVAC",
      callerContext: {
        caller: { phone: '+15555550404', claimedName: 'Jane Smith' },
        identityCase: 'claims',
        intent: { type: 'unknown', entities: {}, confidence: 1 },
        transcriptSnapshot: [],
      },
    });
    store.dispose();

    expect(result.transfer?.summary?.panel.reason.humanReadable).toBe(
      'La persona que llama dice ser Jane Smith, pero el número no coincide con su registro',
    );
    expect(result.message).toMatch(/someone on the line/i);
  });
});
