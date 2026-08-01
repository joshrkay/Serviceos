import { describe, it, expect, afterEach } from 'vitest';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import type {
  VoiceEventTransport,
  VoiceEventEnvelope,
} from '../../../../src/ai/agents/customer-calling/voice-event-transport';
import type { VoiceSessionEvent } from '../../../../src/ai/agents/customer-calling/voice-session-store';

/**
 * In-process fake transport: records everything published and exposes the
 * registered subscribe handler so a test can simulate a message arriving from
 * another replica.
 */
class FakeTransport implements VoiceEventTransport {
  readonly published: VoiceEventEnvelope[] = [];
  handler: ((env: VoiceEventEnvelope) => void) | null = null;
  closed = false;

  publish(env: VoiceEventEnvelope): void {
    this.published.push(env);
  }
  subscribe(handler: (env: VoiceEventEnvelope) => void): void {
    this.handler = handler;
  }
  async close(): Promise<void> {
    this.closed = true;
  }

  /** Simulate a message published by another replica. */
  deliver(env: VoiceEventEnvelope): void {
    this.handler?.(env);
  }
}

describe('VoiceSessionStore cross-instance fan-out (U3d)', () => {
  const stores: VoiceSessionStore[] = [];
  const make = (transport: FakeTransport, replicaId: string): VoiceSessionStore => {
    const store = new VoiceSessionStore({
      transport,
      replicaId,
      startInterval: false,
    });
    stores.push(store);
    return store;
  };

  afterEach(() => {
    while (stores.length) stores.pop()?.dispose();
  });

  it('mirrors a local session event to the transport with a full envelope', () => {
    const transport = new FakeTransport();
    const store = make(transport, 'replica-a');
    const session = store.create('tenant-1', 'telephony', { callSid: 'CA123' });

    const evt: VoiceSessionEvent = { type: 'ended', reason: 'hangup' };
    session.events.emit('voice-event', evt);

    expect(transport.published).toHaveLength(1);
    expect(transport.published[0]).toEqual({
      replicaId: 'replica-a',
      tenantId: 'tenant-1',
      sessionId: session.id,
      callSid: 'CA123',
      event: evt,
    });
  });

  it('mirrors events from sessions created BEFORE the store was given the transport listener', () => {
    // The store attaches the mirror to any session already present at
    // construction; create() also attaches it for later sessions. Both paths
    // share the same listener set, so a session made after construction mirrors.
    const transport = new FakeTransport();
    const store = make(transport, 'replica-a');
    const a = store.create('t', 'telephony', {});
    const b = store.create('t', 'inapp', {});

    a.events.emit('voice-event', { type: 'ended', reason: 'x' });
    b.events.emit('voice-event', { type: 'ended', reason: 'y' });

    expect(transport.published.map((e) => e.sessionId).sort()).toEqual([a.id, b.id].sort());
  });

  it('injects a REMOTE event into the global (subscribeGlobal) sink', () => {
    const transport = new FakeTransport();
    const store = make(transport, 'replica-a');

    const received: VoiceSessionEvent[] = [];
    store.subscribeGlobal((evt) => received.push(evt));

    const remote: VoiceEventEnvelope = {
      replicaId: 'replica-b',
      tenantId: 'tenant-9',
      sessionId: 'sess-remote',
      event: { type: 'escalation_triggered', reason: 'no_answer', ts: 1 },
    };
    transport.deliver(remote);

    expect(received).toEqual([remote.event]);
  });

  it('DROPS self-originated messages (no double-fire on the owning replica)', () => {
    const transport = new FakeTransport();
    const store = make(transport, 'replica-a');

    const received: VoiceSessionEvent[] = [];
    store.subscribeGlobal((evt) => received.push(evt));

    // A message tagged with our own replicaId is what we'd see echoed back from
    // Redis for an event we published locally — it must not be re-injected, or
    // the owning replica's global listeners would fire twice per event.
    transport.deliver({
      replicaId: 'replica-a',
      tenantId: 't',
      sessionId: 's',
      event: { type: 'ended', reason: 'self' },
    });

    expect(received).toHaveLength(0);
  });

  it('closes the transport on dispose', () => {
    const transport = new FakeTransport();
    const store = new VoiceSessionStore({ transport, replicaId: 'r', startInterval: false });
    store.dispose();
    expect(transport.closed).toBe(true);
  });
});
