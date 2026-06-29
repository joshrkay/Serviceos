import { describe, it, expect } from 'vitest';
import {
  InProcessVoiceEventTransport,
  createVoiceEventTransport,
  type VoiceEventEnvelope,
} from '../../../../src/ai/agents/customer-calling/voice-event-transport';

const envelope = (): VoiceEventEnvelope => ({
  replicaId: 'r',
  tenantId: 't',
  sessionId: 's',
  event: { type: 'ended', reason: 'x' },
});

describe('InProcessVoiceEventTransport', () => {
  it('publish + subscribe are no-ops and close resolves', async () => {
    const t = new InProcessVoiceEventTransport();
    expect(() => t.publish(envelope())).not.toThrow();
    expect(() => t.subscribe(() => {})).not.toThrow();
    await expect(t.close()).resolves.toBeUndefined();
  });
});

describe('createVoiceEventTransport', () => {
  it('returns a no-op InProcess transport when REDIS_URL is unset', () => {
    expect(createVoiceEventTransport(undefined)).toBeInstanceOf(InProcessVoiceEventTransport);
  });

  it('returns synchronously and is safe to use immediately when a URL is given', () => {
    // The background Redis upgrade can't connect to a bogus URL in unit tests, so
    // it stays no-op — but the returned transport must function from the first tick.
    const t = createVoiceEventTransport('redis://127.0.0.1:6391');
    expect(() => t.publish(envelope())).not.toThrow();
    expect(() => t.subscribe(() => {})).not.toThrow();
  });
});
