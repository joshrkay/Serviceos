import { describe, it, expect } from 'vitest';
import {
  shouldImmediatelyDialOnEmergency,
  EMERGENCY_INTENTS,
} from '../../../src/ai/skills/escalate-to-human';

describe('P12-004 — shouldImmediatelyDialOnEmergency', () => {
  it('returns true for an emergency intent + unsupervised + telephony', () => {
    expect(
      shouldImmediatelyDialOnEmergency({
        intent: 'emergency_plumbing',
        supervisorPresent: false,
        channel: 'telephony',
      }),
    ).toBe(true);

    expect(
      shouldImmediatelyDialOnEmergency({
        intent: 'gas_leak',
        supervisorPresent: false,
        channel: 'telephony',
      }),
    ).toBe(true);

    expect(
      shouldImmediatelyDialOnEmergency({
        intent: 'no_heat',
        supervisorPresent: false,
        channel: 'telephony',
      }),
    ).toBe(true);
  });

  it('returns false for non-emergency intents regardless of presence/channel', () => {
    expect(
      shouldImmediatelyDialOnEmergency({
        intent: 'book_appointment',
        supervisorPresent: false,
        channel: 'telephony',
      }),
    ).toBe(false);

    expect(
      shouldImmediatelyDialOnEmergency({
        intent: 'lookup_balance',
        supervisorPresent: false,
        channel: 'telephony',
      }),
    ).toBe(false);
  });

  it('returns false when a supervisor is present (normal AI path proceeds)', () => {
    expect(
      shouldImmediatelyDialOnEmergency({
        intent: 'emergency_plumbing',
        supervisorPresent: true,
        channel: 'telephony',
      }),
    ).toBe(false);
  });

  it('returns false on in-app channel (no Twilio Dial available)', () => {
    expect(
      shouldImmediatelyDialOnEmergency({
        intent: 'emergency_plumbing',
        supervisorPresent: false,
        channel: 'inapp',
      }),
    ).toBe(false);
  });

  it('exposes the emergency intent set for callers to extend in tests', () => {
    expect(EMERGENCY_INTENTS.has('emergency_plumbing')).toBe(true);
    expect(EMERGENCY_INTENTS.has('emergency_hvac')).toBe(true);
    expect(EMERGENCY_INTENTS.has('book_appointment')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P12-004 — emergencyImmediateDial wrapper (audit + escalation path)
// ───────────────────────────────────────────────────────────────────────────

import { emergencyImmediateDial } from '../../../src/ai/skills/escalate-to-human';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import type { OnCallRepository, OnCallEntry } from '../../../src/oncall/rotation';

function stubOnCallRepo(entries: OnCallEntry[]): OnCallRepository {
  return {
    getNextOnCall: async () => entries[0] ?? null,
    listRotation: async () => entries,
  };
}

describe('P12-004 — emergencyImmediateDial', () => {
  const entry: OnCallEntry = { id: 'rot-1', userId: 'user-1', orderIndex: 0 };

  it('dials immediately for emergency + unsupervised + telephony and emits audit', async () => {
    const audit = new InMemoryAuditRepository();
    const result = await emergencyImmediateDial({
      intent: 'emergency_plumbing',
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      channel: 'telephony',
      onCallRepo: stubOnCallRepo([entry]),
      auditRepo: audit,
      presenceChecker: async () => false,
    });

    expect(result.dialed).toBe(true);
    expect(result.escalation?.escalated).toBe(true);

    const events = await audit.findByEntity('tenant-1', 'session', 'sess-1');
    const dialEvents = events.filter((e) => e.eventType === 'emergency_immediate_dial');
    expect(dialEvents).toHaveLength(1);
    expect(dialEvents[0].metadata).toMatchObject({
      intent: 'emergency_plumbing',
      channel: 'telephony',
    });
  });

  it('does not dial when a supervisor is present', async () => {
    const audit = new InMemoryAuditRepository();
    const result = await emergencyImmediateDial({
      intent: 'emergency_plumbing',
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      channel: 'telephony',
      onCallRepo: stubOnCallRepo([entry]),
      auditRepo: audit,
      presenceChecker: async () => true,
    });
    expect(result.dialed).toBe(false);
    const events = await audit.findByEntity('tenant-1', 'session', 'sess-1');
    expect(events).toHaveLength(0);
  });

  it('does not dial for a non-emergency intent and never calls the presence checker for it', async () => {
    let presenceCalls = 0;
    const result = await emergencyImmediateDial({
      intent: 'book_appointment',
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      channel: 'telephony',
      onCallRepo: stubOnCallRepo([entry]),
      presenceChecker: async () => {
        presenceCalls += 1;
        return false;
      },
    });
    expect(result.dialed).toBe(false);
    expect(presenceCalls).toBe(0);
  });

  it('does not dial on the in-app channel', async () => {
    const result = await emergencyImmediateDial({
      intent: 'gas_leak',
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      channel: 'inapp',
      onCallRepo: stubOnCallRepo([entry]),
      presenceChecker: async () => false,
    });
    expect(result.dialed).toBe(false);
  });
});
