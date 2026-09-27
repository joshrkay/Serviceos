/**
 * #1406 D10 — "Never mind, that is all for now. Goodbye." on in-app voice
 * classified as `unknown` and, on the second miss, escalated to a human
 * ("Let me connect you with a team member"). A farewell ends the session.
 *
 * Seam: InAppVoiceAdapter (startSession / handleInput), mocked gateway.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InAppVoiceAdapter, isFarewell } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import type { LLMGateway } from '../../../../src/ai/gateway/gateway';

const UNKNOWN = JSON.stringify({ intentType: 'unknown', confidence: 0.5, extractedEntities: {} });

describe('InAppVoiceAdapter — farewell ends the session (#1406 D10)', () => {
  let store: VoiceSessionStore;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
  });
  afterEach(() => store.dispose());

  it('"Goodbye" after an unclear turn closes the session instead of escalating', async () => {
    const complete = vi.fn(async () => ({
      content: UNKNOWN,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    }));
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: { complete } as unknown as LLMGateway,
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(new Map()),
    });
    const { sessionId } = await adapter.startSession('tenant-farewell', 'user-1');
    await adapter.handleInput(sessionId, 'Hmm, can you look at the thing?');

    const turn = await adapter.handleInput(sessionId, 'Never mind, that is all for now. Goodbye.');

    expect(turn.ended).toBe(true);
    expect(turn.state).toBe('terminated');
    expect(turn.sideEffects.some((e) => e.type === 'notify_oncall')).toBe(false);
    expect(turn.ttsText).not.toMatch(/team member/i);
  });

  it('only a request-free goodbye counts as a farewell', () => {
    expect(isFarewell('Goodbye.')).toBe(true);
    expect(isFarewell("Thanks, that's all. Bye!")).toBe(true);
    expect(isFarewell('Never mind, that is all for now. Goodbye.')).toBe(true);
    expect(isFarewell('Bye, and book Garcia for Tuesday')).toBe(false);
    expect(isFarewell('Is that all the invoices for Garcia?')).toBe(false);
    expect(isFarewell('okay')).toBe(false);
  });
});
