/**
 * LCR-02 — the ladder cap's terminal stamp lands in voice_sessions.
 *
 * The cap now ends by its cause: a silent line takes a voicemail and is
 * stamped `silence_max_retries` (the FSM never escalates — nobody is paged);
 * a low-confidence cap escalates through the FSM's system_failure, and when
 * nothing could be dialed the caller is offered a voicemail and the row is
 * stamped `low_stt_confidence_max_retries` in state `escalating`.
 *
 * Seam: the real TwilioGatherAdapter driving PgVoiceSessionRepository
 * (create at /voice, markEnded at the cap) against real Postgres — a mocked
 * repo is never the only proof the end stamp's columns are right.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgVoiceSessionRepository } from '../../src/voice/pg-voice-session';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

function gateway(): LLMGateway {
  const response: LLMResponse = {
    content: '{"intentType":"unknown","confidence":0,"reasoning":"x"}',
    model: 'mock',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

describe('Postgres integration — ladder cap terminal stamp (LCR-02)', () => {
  let pool: Pool;
  let repo: PgVoiceSessionRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgVoiceSessionRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function call(callSid: string) {
    const store = new VoiceSessionStore({ startInterval: false });
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: gateway(),
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://api.test',
      auditRepo: new InMemoryAuditRepository(),
      voiceSessionRepo: repo,
    });
    vi.spyOn(
      (adapter as unknown as { processor: { runSummary: (s: unknown) => Promise<void> } }).processor,
      'runSummary',
    ).mockResolvedValue(undefined);
    await adapter.handleInbound({ callSid, from: '+15125550100', to: '+15125550999', tenantId: tenant.tenantId });
    const session = store.findByCallSid(callSid)!;
    if (session.machine.currentState === 'ask_caller') {
      session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    }
    // The /voice row insert is fire-and-forget; wait for it to land.
    await vi.waitFor(async () => expect(await repo.findById(tenant.tenantId, session.id)).not.toBeNull());
    const turn = (speechResult: string, confidence?: number) =>
      adapter.handleGather({ sessionId: session.id, callSid, speechResult, confidence, tenantId: tenant.tenantId });
    return { session, turn };
  }

  it('a silent line at the cap is stamped silence_max_retries and never escalates', async () => {
    const { session, turn } = await call('CA-lcr02-int-silence');
    await turn('');
    expect(await turn('')).toContain('<Record');

    await vi.waitFor(async () => {
      const row = await repo.findById(tenant.tenantId, session.id);
      expect(row?.endedAt).toBeTruthy();
      expect(row?.endedReason).toBe('silence_max_retries');
    });
    const row = await repo.findById(tenant.tenantId, session.id);
    expect(row?.state).not.toBe('escalating');
    expect(row?.outcome).toBe(session.terminalOutcome);
  });

  it('a low-confidence cap with nobody to dial is stamped low_stt_confidence_max_retries in escalating', async () => {
    const { session, turn } = await call('CA-lcr02-int-lowconf');
    await turn('mumbled one', 0.3);
    expect(await turn('mumbled two', 0.2)).toContain('<Record');

    await vi.waitFor(async () => {
      const row = await repo.findById(tenant.tenantId, session.id);
      expect(row?.endedReason).toBe('low_stt_confidence_max_retries');
    });
    const row = await repo.findById(tenant.tenantId, session.id);
    expect(row?.state).toBe('escalating');
    // deriveCallOutcome: escalating on a system_failure reason is an infra failure.
    expect(row?.outcome).toBe('failed');
  });
});
