/**
 * #1204 — a classifier that crosses the per-session output-token cap between
 * turns consumes the tracker's one-shot `cost_cap_exceeded` event. The next
 * turn must still end the call, and the end must leave the same audit row the
 * event path writes. At real Postgres.
 *
 * Drives both phone transports through their production entry points on a
 * real `TwilioGatherAdapter` whose audit side effects go to
 * `PgAuditRepository`: Gather (`handleGather`) and Media Streams
 * (`processCallerUtterance`, the `speechTurn` app.ts hands the media-streams
 * adapter). Only the LLM completions are scripted: the main turns through the
 * gateway, the between-turns spend through the real `gradeVulnerability`
 * (its `recordCompletionUsage` is where the event is discarded).
 *
 * T1: tenant A's calls cross the cap; neighbour tenant B's call in the same
 * run stays under it (divergent data) and its audit trail carries no cap row.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { gradeVulnerability } from '../../src/ai/agents/customer-calling/vulnerability-grader';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

const LOW_CONFIDENCE_UNKNOWN = JSON.stringify({
  intentType: 'unknown',
  confidence: 0.1,
  reasoning: 'unclear',
  extractedEntities: {},
});
const DRAFT_ESTIMATE = JSON.stringify({
  intentType: 'draft_estimate',
  confidence: 0.95,
  reasoning: 'wants a quote',
  extractedEntities: { customerName: 'Acme' },
});

function makeGatewayScript(steps: Array<{ content: string; output: number }>): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn().mockImplementation(async () => {
      const step = steps[Math.min(i, steps.length - 1)]!;
      i += 1;
      const response: LLMResponse = {
        content: step.content,
        model: 'mock-model',
        provider: 'mock',
        tokenUsage: { input: 500, output: step.output, total: 500 + step.output },
        latencyMs: 1,
      };
      return response;
    }),
  } as unknown as LLMGateway;
}

describe('#1204 — token cap crossed between turns ends the call, audit row at real Postgres', () => {
  let pool: Pool;
  let auditRepo: PgAuditRepository;
  let tenantA: TestTenant;
  let neighbour: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    auditRepo = new PgAuditRepository(pool);
    tenantA = await createTestTenant(pool);
    neighbour = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function startCall(tenant: TestTenant, callSid: string, gateway: LLMGateway) {
    const store = new VoiceSessionStore({ startInterval: false });
    const adapter = new TwilioGatherAdapter({
      store,
      gateway,
      auditRepo,
      systemActorId: tenant.userId,
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
    });
    await adapter.handleInbound({
      callSid,
      from: '+15125550100',
      to: '+15125550999',
      tenantId: tenant.tenantId,
    });
    const session = store.findByCallSid(callSid)!;
    if (session.machine.currentState === 'ask_caller') {
      session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    }
    return { adapter, session, tenant };
  }

  type Call = Awaited<ReturnType<typeof startCall>>;

  async function runVulnerabilityGrader(call: Call, outputTokens: number) {
    await gradeVulnerability(
      { transcript: 'my mom is on oxygen', priorTurns: [], tenantId: call.tenant.tenantId },
      {
        llm: {
          complete: async () => ({
            text: '{"vulnerabilityScore":0.1,"urgencyTier":"none","signals":[]}',
            tokenUsage: { input: 200, output: outputTokens },
            model: 'mock-model',
          }),
        },
        costTracker: call.session.costTracker,
        sessionCostCapCents: call.session.costTracker.costCapCents,
        maxBudgetRatio: 0.8,
      },
    );
  }

  const gather = (call: Call, speechResult: string) =>
    call.adapter.handleGather({
      sessionId: call.session.id,
      callSid: call.session.callSid!,
      speechResult,
      confidence: 0.9,
      tenantId: call.tenant.tenantId,
    });

  const mediaStreamsTurn = (call: Call, speechResult: string) =>
    call.adapter.processCallerUtterance({
      sessionId: call.session.id,
      callSid: call.session.callSid!,
      speechResult,
      tenantId: call.tenant.tenantId,
    });

  async function capRows(call: Call) {
    const rows = await auditRepo.findByEntity(call.tenant.tenantId, 'voice_session', call.session.id);
    return rows.filter((r) => r.eventType.endsWith('.cost_cap_exceeded'));
  }

  it('Gather: the grader crosses the cap between turns; the next turn ends the call and writes one cap audit row', async () => {
    const call = await startCall(
      tenantA,
      'CA-1204-gather-a',
      makeGatewayScript([
        { content: LOW_CONFIDENCE_UNKNOWN, output: 1450 },
        { content: DRAFT_ESTIMATE, output: 1 },
      ]),
    );
    await gather(call, 'um I have a question');
    expect(call.session.costTracker.isExceeded).toBe(false);
    await runVulnerabilityGrader(call, 60);
    expect(call.session.costTracker.isExceeded).toBe(true);

    const xml = await gather(call, 'I would like a quote for a water heater');

    expect(xml).toContain('I&apos;m connecting you with a team member who can assist you further.');
    expect(call.session.machine.currentState).toBe('escalating');
    const rows = await capRows(call);
    expect(rows.map((r) => r.eventType)).toEqual(['agent.calling.intent_capture.cost_cap_exceeded']);
    expect(rows[0].tenantId).toBe(tenantA.tenantId);
    expect(rows[0].metadata).toMatchObject({ fromState: 'intent_capture', toState: 'escalating' });
  });

  it('Media Streams: the grader crosses the cap between turns; the next turn ends the call once, one cap audit row', async () => {
    const call = await startCall(
      tenantA,
      'CA-1204-ms-a',
      makeGatewayScript([
        { content: LOW_CONFIDENCE_UNKNOWN, output: 1450 },
        { content: DRAFT_ESTIMATE, output: 1 },
        { content: DRAFT_ESTIMATE, output: 1 },
      ]),
    );
    await mediaStreamsTurn(call, 'um I have a question');
    await runVulnerabilityGrader(call, 60);

    const fx = await mediaStreamsTurn(call, 'I would like a quote for a water heater');
    expect(fx.filter((f) => f.type === 'notify_oncall').map((f) => f.payload.reason)).toEqual([
      'cost_cap_exceeded',
    ]);
    expect(call.session.machine.currentState).toBe('escalating');

    // Never twice: back on a classify branch while still over the cap.
    call.session.machine.dispatch({ type: 'proposal_queued', proposalId: 'p-1' });
    await mediaStreamsTurn(call, 'and a quote for a furnace too');

    const rows = await capRows(call);
    expect(rows.map((r) => r.eventType)).toEqual(['agent.calling.intent_capture.cost_cap_exceeded']);
  });

  it('T1 — neighbour tenant B, whose grader stays under the cap, keeps talking and gets no cap audit row', async () => {
    const call = await startCall(
      neighbour,
      'CA-1204-gather-b',
      makeGatewayScript([
        { content: LOW_CONFIDENCE_UNKNOWN, output: 1450 },
        { content: DRAFT_ESTIMATE, output: 1 },
      ]),
    );
    await gather(call, 'um I have a question');
    await runVulnerabilityGrader(call, 10);
    const xml = await gather(call, 'I would like a quote for a water heater');

    expect(call.session.costTracker.isExceeded).toBe(false);
    expect(call.session.machine.currentState).toBe('intent_confirm');
    expect(xml).toContain('Just to confirm');
    expect(await capRows(call)).toEqual([]);

    // Tenant A's cap rows are not visible in tenant B's trail, and B wrote
    // no cap row anywhere.
    const neighbourAll = await auditRepo.findRecentByTenant(neighbour.tenantId, { limit: 200 });
    expect(neighbourAll.length).toBeGreaterThan(0);
    expect(neighbourAll.some((r) => r.eventType.endsWith('.cost_cap_exceeded'))).toBe(false);
    expect(neighbourAll.every((r) => r.tenantId === neighbour.tenantId)).toBe(true);
  });
});
