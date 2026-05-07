import { describe, it, expect, afterEach } from 'vitest';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';

describe('VoiceSessionStore', () => {
  const stores: VoiceSessionStore[] = [];

  afterEach(() => {
    while (stores.length) stores.pop()!.dispose();
  });

  function newStore(opts?: ConstructorParameters<typeof VoiceSessionStore>[0]) {
    const s = new VoiceSessionStore({ startInterval: false, ...opts });
    stores.push(s);
    return s;
  }

  it('creates and retrieves a session by id', () => {
    const store = newStore();
    const session = store.create('tenant-a', 'inapp');
    expect(session.tenantId).toBe('tenant-a');
    expect(session.channel).toBe('inapp');
    expect(store.get(session.id)?.id).toBe(session.id);
  });

  it('reaps idle sessions past TTL', () => {
    const store = newStore({ idleTtlMs: 1000 });
    const session = store.create('t', 'inapp');
    // Pretend last activity was 2s ago
    session.lastActivityAt = new Date(Date.now() - 2000);
    const reaped = store.reapIdle();
    expect(reaped).toContain(session.id);
    expect(store.peek(session.id)).toBeUndefined();
  });

  it('does not reap sessions that are still fresh', () => {
    const store = newStore({ idleTtlMs: 60_000 });
    const session = store.create('t', 'inapp');
    const reaped = store.reapIdle();
    expect(reaped).not.toContain(session.id);
    expect(store.peek(session.id)).toBeDefined();
  });

  it('isolates sessions across tenants', () => {
    const store = newStore();
    const a = store.create('tenant-a', 'inapp');
    const b = store.create('tenant-b', 'inapp');
    expect(a.tenantId).not.toBe(b.tenantId);
    expect(store.size()).toBe(2);
  });

  it('delete removes the session', () => {
    const store = newStore();
    const s = store.create('t', 'inapp');
    store.delete(s.id);
    expect(store.peek(s.id)).toBeUndefined();
  });
});
