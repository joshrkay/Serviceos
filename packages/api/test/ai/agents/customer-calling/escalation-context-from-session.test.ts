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
  it('maps caller_identification_failed to the identity_unverified builder reason, not low_confidence_intent', () => {
    const session = sessionWithCallerTurns(['Hi, this is Jane Smith.']);

    const bundle = buildCallerContextFromSession(session, '+15555550404', 'caller_identification_failed');

    expect(bundle.builderReason).toBe('identity_unverified');
  });

  it("carries the name the caller gave in their last turn as caller.claimedName — a claim, never caller.name", () => {
    const session = sessionWithCallerTurns(['Hi, this is Jane Smith.']);

    const bundle = buildCallerContextFromSession(session, '+15555550404', 'caller_identification_failed');

    expect(bundle.caller.claimedName).toBe('Jane Smith');
    expect(bundle.caller.name).toBeUndefined();
  });
});
