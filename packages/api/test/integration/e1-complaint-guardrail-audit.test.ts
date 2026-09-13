/**
 * I8 (#1020, lane A) — "Safety escalation beats containment" (D-027),
 * proven against real Postgres.
 *
 * `emergency-tier.test.ts` / `emergency-tier-transitions.test.ts` /
 * `complaint-guardrail.test.ts` prove the deterministic E1 classifier and the
 * FSM's complaint global guard only as PURE functions (`classifyCallerSafety`,
 * `transition`) — no I/O, no audit event. This file proves the SAME
 * production functions feeding the SAME REAL side-effect executor
 * (`VoiceTurnProcessor.executeSideEffects`, from
 * `createVoiceTurnProcessor` — the function every live call (twilio-adapter's
 * `runEmergencyScan`) drives) against a real database:
 *
 *   1. E1 with NO rules loaded (`classifyCallerSafety(utterance, {})` — the
 *      runtime hot path, corpus rules never shipped) at the real handler:
 *      the resulting `emergency_detected` audit event is written to Postgres
 *      and reads back through `PgAuditRepository.findByEntity`.
 *   2. Complaint escalation fires from EVERY live (non-terminal,
 *      pre-escalation) FSM state, each producing its own real audit row.
 *   3. T1 — a second tenant's audit trail is untouched by the first
 *      tenant's emergency + complaint events.
 *
 * Do NOT touch the E1 script text (O-2, decisions.md) — this file only reads
 * `LIFE_SAFETY_E1_SCRIPT`/`classifyCallerSafety`, never edits it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createVoiceTurnProcessor, type VoiceTurnProcessor } from '../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryVoiceSessionRepository } from '../../src/voice/voice-session';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { classifyCallerSafety } from '../../src/ai/agents/customer-calling/emergency-tier';
import { transition } from '../../src/ai/agents/customer-calling/transitions';
import type {
  CallingAgentEvent,
  CallingAgentState,
} from '../../src/ai/agents/customer-calling/types';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

// Every FSM state, so LIVE_STATES below is exhaustive by construction: if
// CallingAgentState ever gains a member without a corresponding key here,
// this object literal fails to compile (missing property).
const ALL_STATES: Record<CallingAgentState, true> = {
  idle: true,
  greeting: true,
  identifying: true,
  ask_caller: true,
  intent_capture: true,
  entity_resolution: true,
  entity_confirm: true,
  intent_confirm: true,
  proposal_draft: true,
  closing: true,
  escalating: true,
  degraded: true,
  terminated: true,
};

// The FSM's live states — the complaint global guard (transitions.ts,
// checkGlobalGuards) only no-ops for 'escalating' and 'terminated'
// (`if (state === 'escalating' || state === 'terminated') { ... }`), so
// every other state, 'idle'/'entity_confirm'/'degraded' included, is
// legitimately live and must be exercised here.
const LIVE_STATES: CallingAgentState[] = (Object.keys(ALL_STATES) as CallingAgentState[]).filter(
  (s) => s !== 'escalating' && s !== 'terminated',
);

function neverCalledGateway(): LLMGateway {
  return {
    complete: vi.fn(async () => {
      throw new Error('I8 real-handler test never drives the LLM path — deterministic scans only');
    }) as unknown as LLMGateway['complete'],
  } as unknown as LLMGateway;
}

describe('I8 — E1 + complaint escalation write their audit event through the real handler at real Postgres', () => {
  let pool: Pool;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    auditRepo = new PgAuditRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function buildProcessor(userId: string): VoiceTurnProcessor {
    return createVoiceTurnProcessor({
      store: new VoiceSessionStore({ startInterval: false }),
      gateway: neverCalledGateway(),
      businessName: 'I8 Test Business',
      auditRepo,
      proposalRepo: new InMemoryProposalRepository(),
      voiceSessionRepo: new InMemoryVoiceSessionRepository(),
      systemActorId: userId,
    });
  }

  it('E1 with NO rules loaded: the real handler writes its audit event, read back via PgAuditRepository.findByEntity', async () => {
    const tenant = await createTestTenant(pool);
    const store = new VoiceSessionStore({ startInterval: false });
    const processor = buildProcessor(tenant.userId);
    const session = store.create(tenant.tenantId, 'telephony', { callSid: 'CA-i8-e1' });

    const utterance = 'I smell gas in the kitchen';
    // Production classifier, called exactly as the runtime hot path calls it
    // (twilio-adapter.ts runEmergencyScan): no `rules` argument, since the
    // corpus rules file is not shipped in the runtime image.
    const safety = classifyCallerSafety(utterance, {});
    expect(safety.tier).toBe('E1');
    expect(safety.source).toBe('embedded');

    const fromState: CallingAgentState = 'proposal_draft';
    const event: CallingAgentEvent = {
      type: 'emergency_detected',
      keyword: safety.keyword,
      utterance,
      // Runtime-asserted above (`expect(safety.tier).toBe('E1')`) — TS can't
      // narrow SafetyTier ('E1'|'E2'|'E3') to the event's 'E1'|'E2' from that.
      tier: safety.tier as 'E1' | 'E2',
      responseScript: safety.responseScript ?? undefined,
    };
    const result = transition(fromState, event, session.machine.currentContext);
    expect(result.nextState).toBe('terminated');
    expect(result.sideEffects.some((f) => f.type === 'revoke_pending_bookings')).toBe(true);
    expect(result.sideEffects.some((f) => f.type === 'create_proposal')).toBe(false);

    // The REAL handler — the same executeSideEffects the live call drives.
    await processor.executeSideEffects(session, result.sideEffects, tenant.tenantId);

    const rows = await auditRepo.findByEntity(tenant.tenantId, 'voice_session', session.id);
    const emergencyRows = rows.filter((r) => r.eventType.endsWith('.emergency_detected'));
    expect(emergencyRows).toHaveLength(1);
    expect(emergencyRows[0].eventType).toBe(`agent.calling.${fromState}.emergency_detected`);
    expect(emergencyRows[0].entityType).toBe('voice_session');
    expect(emergencyRows[0].entityId).toBe(session.id);
    expect(emergencyRows[0].metadata).toMatchObject({
      tenantId: tenant.tenantId,
      toState: 'terminated',
    });
  });

  it('LIVE_STATES is exhaustive: every CallingAgentState except escalating/terminated', () => {
    // 13-member CallingAgentState union minus escalating/terminated = 11.
    expect(LIVE_STATES).toHaveLength(11);
    expect(LIVE_STATES).toEqual(expect.arrayContaining(['idle', 'entity_confirm', 'degraded']));
    expect(LIVE_STATES).not.toContain('escalating');
    expect(LIVE_STATES).not.toContain('terminated');
  });

  it('complaint escalation fires the global guard from EVERY live FSM state, each with its own real audit row', async () => {
    const tenant = await createTestTenant(pool);
    const store = new VoiceSessionStore({ startInterval: false });
    const processor = buildProcessor(tenant.userId);

    for (const fromState of LIVE_STATES) {
      const session = store.create(tenant.tenantId, 'telephony', {
        callSid: `CA-i8-complaint-${fromState}`,
      });
      const event: CallingAgentEvent = {
        type: 'intent_classified',
        intentType: 'complaint',
        entities: { noteBody: `service complaint from state ${fromState}` },
        confidence: 0.9,
        aiRunId: `run-${fromState}`,
        utterance: `I am very unhappy about the last visit (${fromState})`,
      };
      const result = transition(fromState, event, session.machine.currentContext);
      expect(result.nextState).toBe('escalating');

      await processor.executeSideEffects(session, result.sideEffects, tenant.tenantId);

      const rows = await auditRepo.findByEntity(tenant.tenantId, 'voice_session', session.id);
      const complaintRows = rows.filter((r) => r.eventType.endsWith('.complaint_guardrail'));
      expect(complaintRows).toHaveLength(1);
      expect(complaintRows[0].eventType).toBe(`agent.calling.${fromState}.complaint_guardrail`);
      expect(complaintRows[0].entityId).toBe(session.id);
    }
  });

  it('T1 — a second tenant\'s audit trail is untouched by tenant A\'s emergency + complaint events', async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool);
    const store = new VoiceSessionStore({ startInterval: false });
    const processor = buildProcessor(tenantA.userId);

    const sessionB = store.create(tenantB.tenantId, 'telephony', { callSid: 'CA-i8-tenantB' });

    const sessionA1 = store.create(tenantA.tenantId, 'telephony', { callSid: 'CA-i8-tenantA-e1' });
    const e1Result = transition(
      'intent_capture',
      {
        type: 'emergency_detected',
        keyword: 'gas leak',
        utterance: 'there is a gas leak',
        tier: 'E1',
      },
      sessionA1.machine.currentContext,
    );
    await processor.executeSideEffects(sessionA1, e1Result.sideEffects, tenantA.tenantId);

    const sessionA2 = store.create(tenantA.tenantId, 'telephony', {
      callSid: 'CA-i8-tenantA-complaint',
    });
    const complaintResult = transition(
      'intent_capture',
      {
        type: 'intent_classified',
        intentType: 'complaint',
        entities: { noteBody: 'tenant A complaint' },
        confidence: 0.9,
        aiRunId: 'run-tenantA',
        utterance: 'tenant A caller complaint',
      },
      sessionA2.machine.currentContext,
    );
    await processor.executeSideEffects(sessionA2, complaintResult.sideEffects, tenantA.tenantId);

    // Tenant A really did get both audit rows.
    expect(
      (await auditRepo.findByEntity(tenantA.tenantId, 'voice_session', sessionA1.id)).some(
        (r) => r.eventType.endsWith('.emergency_detected'),
      ),
    ).toBe(true);
    expect(
      (await auditRepo.findByEntity(tenantA.tenantId, 'voice_session', sessionA2.id)).some(
        (r) => r.eventType.endsWith('.complaint_guardrail'),
      ),
    ).toBe(true);

    // Tenant B's untouched session has no audit rows at all, and tenant B's
    // recent-audit feed is empty — the two tenants' emergency/complaint
    // events never cross.
    expect(
      await auditRepo.findByEntity(tenantB.tenantId, 'voice_session', sessionB.id),
    ).toHaveLength(0);
    expect(await auditRepo.findRecentByTenant(tenantB.tenantId)).toHaveLength(0);
  });
});
