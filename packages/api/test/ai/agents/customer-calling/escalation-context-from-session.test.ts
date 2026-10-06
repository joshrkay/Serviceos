/**
 * #1616 — the escalation-context builder: what the dispatcher summary is
 * built from when the FSM hands a call off for an identity reason (#1587's
 * claims-existing-customer / archived-record hand-offs; identifyCaller
 * throwing). Seam: `buildCallerContextFromSession` over a session the way
 * the store creates it. Expected values are the issue's — the reason names
 * identity, and the context carries the name the caller claimed — never the
 * builder's internals.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { buildCallerContextFromSession } from '../../../../src/ai/agents/customer-calling/escalation-context-from-session';

const TENANT = 't-1616-context';

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

function sessionWithCallerTurns(lines: ReadonlyArray<string>) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const session = store.create(TENANT, 'telephony', { callSid: 'CA-1616' });
  for (const text of lines) {
    store.appendTranscript(session.id, { speaker: 'caller', text, ts: Date.now() });
  }
  return session;
}

describe('#1616 — buildCallerContextFromSession for an identity hand-off', () => {
  it("a caller with a record bound to this line (the archived case) carries no claimedName — a self-introduction is not a claim about another record", () => {
    const session = sessionWithCallerTurns(["Hi, this is Jane Smith, when's my appointment?"]);
    session.customerId = '00000000-0000-4000-8000-000000001616';

    const bundle = buildCallerContextFromSession(
      session,
      '+15555550494',
      'caller_identification_failed',
      'customer_archived',
    );

    expect(bundle.caller.claimedName).toBeUndefined();
    expect(bundle.identityCase).toBe('archived');
  });

  it('a non-identity hand-off never carries a claimedName, even after a self-introduction', () => {
    const session = sessionWithCallerTurns(['Hi, this is Jane Smith.', 'Let me talk to a person.']);

    const bundle = buildCallerContextFromSession(session, '+15555550404', 'operator_request');

    expect(bundle.caller.claimedName).toBeUndefined();
    expect(bundle.identityCase).toBeUndefined();
  });

  it("carries the name the caller gave in their last turn as caller.claimedName — a claim, never caller.name", () => {
    const session = sessionWithCallerTurns(['Hi, this is Jane Smith.']);

    const bundle = buildCallerContextFromSession(
      session,
      '+15555550404',
      'caller_identification_failed',
      'claims_existing_customer',
    );

    expect(bundle.caller.claimedName).toBe('Jane Smith');
    expect(bundle.caller.name).toBeUndefined();
    expect(bundle.identityCase).toBe('claims');
  });

  it('identifyCaller throwing is a plain unverified identity — a self-introduction is not carried as a claim', () => {
    const session = sessionWithCallerTurns(['Hi, this is Jane Smith.']);

    const bundle = buildCallerContextFromSession(
      session,
      '+15555550404',
      'caller_identification_failed',
      'identify_caller_threw',
    );

    expect(bundle.caller.claimedName).toBeUndefined();
    expect(bundle.identityCase).toBe('unverified');
  });
});
