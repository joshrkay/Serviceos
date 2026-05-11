import { describe, it, expect } from 'vitest';
import { escalateToHuman } from '../../../src/ai/skills/escalate-to-human';
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
