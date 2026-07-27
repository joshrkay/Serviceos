import { afterEach, describe, expect, it, vi } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import { InMemoryVoiceSessionRepository } from '../../../../src/voice/voice-session';
import type { LLMGateway } from '../../../../src/ai/gateway/gateway';

// Regression: ISSUE-002 — completed in-app interactions persisted without their transcript
// Found by /qa on 2026-07-25
// Report: .gstack/qa-reports/qa-report-app-therivetapp-com-2026-07-25.md
describe('in-app transcript persistence', () => {
  const store = new VoiceSessionStore({ startInterval: false });

  afterEach(() => {
    store.dispose();
  });

  it('persists spoken turns when the session ends', async () => {
    const gateway = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({ intentType: 'unknown', confidence: 0.2 }),
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      })),
    } as unknown as LLMGateway;
    const voiceSessionRepo = new InMemoryVoiceSessionRepository();
    const adapter = new InAppVoiceAdapter({
      store,
      gateway,
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(),
      voiceSessionRepo,
    });

    const { sessionId } = await adapter.startSession('tenant-x', 'user-x');
    await adapter.handleInput(sessionId, 'show me today’s schedule');
    await adapter.endSession(sessionId);
    await Promise.resolve();
    await Promise.resolve();

    const row = await voiceSessionRepo.findById('tenant-x', sessionId);
    expect(row?.transcript).toEqual(
      expect.arrayContaining([expect.stringContaining('show me today’s schedule')]),
    );
  });
});
