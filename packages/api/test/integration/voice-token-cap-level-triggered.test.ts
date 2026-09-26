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
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgOnCallRepository } from '../../src/oncall/rotation';
import {
  pgSupervisorPresenceLoader,
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import { classifyCallerSafety } from '../../src/ai/agents/customer-calling/emergency-tier';
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

  async function startCall(
    tenant: TestTenant,
    callSid: string,
    gateway: LLMGateway,
    /** #1212 — real proposal + on-call repos for the emergency path. */
    emergencyDeps?: {
      proposalRepo: PgProposalRepository;
      onCallRepo: PgOnCallRepository;
      dispatcherPhoneResolver: () => Promise<string>;
    },
  ) {
    const store = new VoiceSessionStore({ startInterval: false });
    const adapter = new TwilioGatherAdapter({
      store,
      gateway,
      auditRepo,
      systemActorId: tenant.userId,
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      ...(emergencyDeps ?? {}),
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

  // ─── #1212: an emergency outcome wins over the cap end ──────────────────
  //
  // Each call runs in its own tenant (owner on the on-call rotation), so a
  // capped call's whole audit + proposal trail can be compared with the same
  // call made uncapped. Neighbour tenant B (no rotation, divergent config)
  // must stay untouched.
  describe('#1212 — a keyword-free emergency on the capped turn takes the emergency path', () => {
    const KEYWORD_FREE_EMERGENCY =
      'my water heater just split open and scalding water is pouring across the garage floor';
    const EMERGENCY = JSON.stringify({
      intentType: 'emergency_dispatch',
      confidence: 0.94,
      reasoning: 'active scalding-water release, needs someone now',
      extractedEntities: {},
    });
    let proposalRepo: PgProposalRepository;
    let onCallRepo: PgOnCallRepository;
    const emergencyTenants: string[] = [];

    beforeAll(() => {
      proposalRepo = new PgProposalRepository(pool);
      onCallRepo = new PgOnCallRepository(pool);
    });

    afterEach(() => {
      _resetSupervisorPresenceCache();
      setSupervisorPresenceLoader(null);
    });

    afterAll(() => {
      // For the PR row dump.
      console.log(`#1212 emergency tenants: ${emergencyTenants.join(',')} neighbour: ${neighbour.tenantId}`);
    });

    /** A fresh tenant whose owner is the only on-call rotation entry (tenant config; no product route writes it). */
    async function rotationTenant(label: string): Promise<TestTenant> {
      const tenant = await createTestTenant(pool);
      await pool.query(
        `INSERT INTO tenant_oncall_rotation (tenant_id, user_id, order_index) VALUES ($1, $2, 0)`,
        [tenant.tenantId, tenant.userId],
      );
      emergencyTenants.push(`${label}=${tenant.tenantId}`);
      return tenant;
    }

    async function emergencyCall(label: string, callSid: string) {
      const tenant = await rotationTenant(label);
      return startCall(
        tenant,
        callSid,
        makeGatewayScript([
          { content: LOW_CONFIDENCE_UNKNOWN, output: 1450 },
          { content: EMERGENCY, output: 1 },
        ]),
        { proposalRepo, onCallRepo, dispatcherPhoneResolver: async () => '+15125550111' },
      );
    }

    /** The tenant's whole trail, order-independent (rows written in one ms tie on created_at). */
    async function trail(call: Call) {
      const audits = await auditRepo.findRecentByTenant(call.tenant.tenantId, { limit: 200 });
      const proposals = await proposalRepo.findByTenant(call.tenant.tenantId);
      return {
        auditTypes: audits.map((r) => r.eventType).sort(),
        proposalTypes: proposals.map((p) => p.proposalType).sort(),
      };
    }

    it('precondition: the utterance is keyword-free', () => {
      expect(classifyCallerSafety(KEYWORD_FREE_EMERGENCY, {}).tier).toBe('E3');
    });

    it('Gather: the capped turn writes the emergency_dispatch rows an uncapped call writes, and no cost_cap row', async () => {
      const control = await emergencyCall('gather-control', 'CA-1212-gather-control');
      await gather(control, 'um I have a question');
      await gather(control, KEYWORD_FREE_EMERGENCY);

      const call = await emergencyCall('gather-capped', 'CA-1212-gather-capped');
      await gather(call, 'um I have a question');
      await runVulnerabilityGrader(call, 60);
      expect(call.session.costTracker.isExceeded).toBe(true);
      const xml = await gather(call, KEYWORD_FREE_EMERGENCY);

      expect(xml).not.toContain('I&apos;m connecting you with a team member who can assist you further.');
      expect(call.session.machine.currentContext.escalationReason).toBe('emergency_dispatch');
      const capped = await trail(call);
      expect(capped.auditTypes).toContain('agent.calling.intent_capture.emergency_dispatch');
      expect(capped.auditTypes.some((t) => t.endsWith('.cost_cap_exceeded'))).toBe(false);
      expect(capped).toEqual(await trail(control));
    });

    it('Media Streams, unsupervised tenant: the capped turn dials on-call now (emergency_immediate_dial row), as an uncapped call does', async () => {
      // Presence is stubbed here: an owner's default users.current_mode is
      // 'supervisor', and the only product write path to change it is the
      // /me/mode route.
      setSupervisorPresenceLoader(async () => false);
      const control = await emergencyCall('ms-unsupervised-control', 'CA-1212-ms-control');
      await mediaStreamsTurn(control, 'um I have a question');
      await mediaStreamsTurn(control, KEYWORD_FREE_EMERGENCY);

      const call = await emergencyCall('ms-unsupervised-capped', 'CA-1212-ms-capped');
      await mediaStreamsTurn(call, 'um I have a question');
      await runVulnerabilityGrader(call, 60);
      expect(call.session.costTracker.isExceeded).toBe(true);
      const fx = await mediaStreamsTurn(call, KEYWORD_FREE_EMERGENCY);

      expect(fx.some((f) => f.type === 'notify_oncall')).toBe(false);
      const rows = await auditRepo.findRecentByTenant(call.tenant.tenantId, { limit: 200 });
      const dial = rows.find((r) => r.eventType === 'emergency_immediate_dial');
      expect(dial?.entityId).toBe(call.session.id);
      expect(dial?.metadata).toMatchObject({ intent: 'emergency_dispatch', escalated: true });
      const capped = await trail(call);
      expect(capped.auditTypes.some((t) => t.endsWith('.cost_cap_exceeded'))).toBe(false);
      expect(capped).toEqual(await trail(control));
    });

    it('Media Streams, supervised tenant (real presence query): the capped turn takes the FSM emergency path, as an uncapped call does', async () => {
      setSupervisorPresenceLoader(pgSupervisorPresenceLoader(pool));
      const control = await emergencyCall('ms-supervised-control', 'CA-1212-ms-sup-control');
      await mediaStreamsTurn(control, 'um I have a question');
      await mediaStreamsTurn(control, KEYWORD_FREE_EMERGENCY);

      const call = await emergencyCall('ms-supervised-capped', 'CA-1212-ms-sup-capped');
      await mediaStreamsTurn(call, 'um I have a question');
      await runVulnerabilityGrader(call, 60);
      const fx = await mediaStreamsTurn(call, KEYWORD_FREE_EMERGENCY);

      expect(fx.filter((f) => f.type === 'notify_oncall').map((f) => f.payload.reason)).toEqual([
        'emergency_dispatch',
      ]);
      const capped = await trail(call);
      expect(capped.auditTypes).toContain('agent.calling.intent_capture.emergency_dispatch');
      expect(capped.auditTypes).not.toContain('emergency_immediate_dial');
      expect(capped.auditTypes.some((t) => t.endsWith('.cost_cap_exceeded'))).toBe(false);
      expect(capped).toEqual(await trail(control));
    });

    it('Media Streams, unsupervised tenant, no reachable on-call phone: the capped turn writes the failed Dial row AND the FSM emergency_dispatch transition (not stuck in intent_capture)', async () => {
      setSupervisorPresenceLoader(async () => false);
      const tenant = await rotationTenant('ms-unsupervised-nophone-capped');
      const call = await startCall(
        tenant,
        'CA-1212-ms-nophone',
        makeGatewayScript([
          { content: LOW_CONFIDENCE_UNKNOWN, output: 1450 },
          { content: EMERGENCY, output: 1 },
        ]),
        // The owner is on the rotation but has no reachable phone.
        { proposalRepo, onCallRepo, dispatcherPhoneResolver: async () => null as unknown as string },
      );
      await mediaStreamsTurn(call, 'um I have a question');
      await runVulnerabilityGrader(call, 60);
      expect(call.session.costTracker.isExceeded).toBe(true);
      await mediaStreamsTurn(call, KEYWORD_FREE_EMERGENCY);

      expect(call.session.machine.currentState).toBe('escalating');
      expect(call.session.machine.currentContext.escalationReason).toBe('emergency_dispatch');
      const rows = await auditRepo.findRecentByTenant(call.tenant.tenantId, { limit: 200 });
      expect(rows.find((r) => r.eventType === 'emergency_immediate_dial')?.metadata).toMatchObject({
        escalated: false,
        transferInitiated: false,
      });
      expect(rows.map((r) => r.eventType)).toContain('agent.calling.intent_capture.emergency_dispatch');
      expect(rows.some((r) => r.eventType.endsWith('.cost_cap_exceeded'))).toBe(false);
      // #1230 — one incident, one escalation.requested: the FSM's notify_oncall
      // reuses the immediate-dial result instead of walking the rotation again.
      expect(rows.filter((r) => r.eventType === 'escalation.requested')).toHaveLength(1);
    });

    it('T1 — neighbour tenant B (no rotation) gets none of the emergency rows and no proposals', async () => {
      const neighbourAll = await auditRepo.findRecentByTenant(neighbour.tenantId, { limit: 200 });
      expect(neighbourAll.every((r) => r.tenantId === neighbour.tenantId)).toBe(true);
      expect(
        neighbourAll.some(
          (r) =>
            r.eventType === 'emergency_immediate_dial' ||
            r.eventType.endsWith('.emergency_dispatch') ||
            r.eventType.startsWith('escalation.'),
        ),
      ).toBe(false);
      expect(await proposalRepo.findByTenant(neighbour.tenantId)).toEqual([]);
    });
  });
});
