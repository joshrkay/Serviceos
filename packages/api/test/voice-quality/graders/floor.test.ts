/**
 * VQ-020 — Floor grader tests.
 *
 * Each test exercises one of the eight hard-floor criteria (#1-#8 in
 * `rubric.v1.json`) plus the aggregator behaviour. Tests build synthetic
 * `Observation` + `VoiceQualityScript` fixtures directly so they don't
 * depend on the harness, runner, or any LLM/cassette path.
 */
import { describe, it, expect } from 'vitest';
import { gradeFloor, hangupHandled } from '../../../src/ai/voice-quality/graders/floor';
import type { Observation } from '../../../src/ai/voice-quality/observation';
import type { VoiceQualityScript } from '../../../src/ai/voice-quality/schema';
import type { VoiceSessionEvent } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type { AuditEvent } from '../../../src/audit/audit';
import type { Proposal } from '../../../src/proposals/proposal';

function makeAuditEvent(partial: Partial<AuditEvent>): AuditEvent {
  return {
    id: partial.id ?? 'audit-1',
    tenantId: partial.tenantId ?? 't-1',
    actorId: partial.actorId ?? 'voice-agent',
    actorRole: partial.actorRole ?? 'system',
    eventType: partial.eventType ?? 'proposal.created',
    entityType: partial.entityType ?? 'proposal',
    entityId: partial.entityId ?? 'p-1',
    correlationId: partial.correlationId,
    metadata: partial.metadata ?? {},
    createdAt: partial.createdAt ?? new Date(),
  };
}

function makeObservation(partial: Partial<Observation> = {}): Observation {
  return {
    callId: partial.callId ?? 'call-1',
    scriptId: partial.scriptId ?? 'script-1',
    tenantId: partial.tenantId ?? 't-1',
    events: partial.events ?? [],
    proposals: partial.proposals ?? [],
    customerCountDelta: partial.customerCountDelta ?? 0,
    appointmentCountDelta: partial.appointmentCountDelta ?? 0,
    audit: partial.audit ?? [],
    totalCostCents: partial.totalCostCents ?? 0,
    totalDurationMs: partial.totalDurationMs ?? 1000,
    perTurnLatencyMs: partial.perTurnLatencyMs ?? [],
    sessionEndedAs: partial.sessionEndedAs ?? 'completed',
    hangupOccurred: partial.hangupOccurred ?? false,
    errors: partial.errors ?? [],
  };
}

function makeScript(partial: Partial<VoiceQualityScript> = {}): VoiceQualityScript {
  return {
    id: partial.id ?? 'script-1',
    bucket: partial.bucket ?? '01-happy-lookups',
    fixtures: partial.fixtures ?? {
      tenant: {},
      customers: [],
    },
    callerId: partial.callerId ?? '+15551234567',
    callerIdBlocked: partial.callerIdBlocked ?? false,
    turns: partial.turns ?? [],
    grading: partial.grading ?? { appliesFloor: [1, 2, 3, 4, 5, 6, 7, 8], appliesDisposition: [] },
    layer2Eligible: partial.layer2Eligible ?? false,
    layer2Only: partial.layer2Only ?? false,
  };
}

function proposalCreated(proposalId: string, ts = 100): VoiceSessionEvent {
  return { type: 'proposal_created', proposalId } as VoiceSessionEvent;
}

function lookupExecuted(skillName: string, success = true, ts = 50): VoiceSessionEvent {
  return { type: 'lookup_executed', skillName, durationMs: 100, success, ts };
}

function sessionTerminated(
  cause: 'hangup' | 'cost_cap' | 'cap_exceeded' | 'completed',
  ts = 999,
): VoiceSessionEvent {
  return { type: 'session_terminated', cause, ts };
}

describe('VQ-020 — gradeFloor', () => {
  it('VQ-020 — gradeFloor passes when all 8 checks pass (synthetic clean observation)', () => {
    const obs = makeObservation({
      events: [
        lookupExecuted('lookup-customer', true, 50),
        proposalCreated('p-1', 100),
        sessionTerminated('completed', 999),
      ],
      audit: [
        makeAuditEvent({ tenantId: 't-1', eventType: 'proposal.created', entityType: 'proposal' }),
      ],
      perTurnLatencyMs: [500, 1500],
      totalCostCents: 30,
      sessionEndedAs: 'completed',
      hangupOccurred: false,
      customerCountDelta: 0,
    });
    const script = makeScript({
      fixtures: { tenant: { costCapCents: 80 }, customers: [] },
      turns: [],
    });

    const result = gradeFloor(obs, script);

    expect(result.passed).toBe(true);
    expect(result.failedCriteria).toEqual([]);
  });

  it('VQ-020 — gradeFloor fails on PII leak (agent transcript with phone before identity resolution)', () => {
    // Agent transcript provided as VoiceSessionEvent extension via metadata-bearing
    // events. Conservative impl: scan `agentResponse` field on session-level events
    // OR rely on a synthetic `pii_leak` marker. Here we drive an obs with an
    // explicit `agentResponses` event stream embedded in events.
    const events: VoiceSessionEvent[] = [
      // PII spoken before any successful identity-resolving lookup
      {
        // The grader scans events of any type for a `text` / `agentResponse` /
        // `transcript` field. Use a custom-shaped object cast to the union for
        // the test (the grader is conservative and tolerates unknown fields).
        type: 'speech_outbound',
        text: 'Your number on file is 555-123-4567',
        ts: 10,
      } as unknown as VoiceSessionEvent,
      lookupExecuted('lookup-customer', true, 100),
    ];
    const obs = makeObservation({ events, perTurnLatencyMs: [200] });
    const script = makeScript();

    const result = gradeFloor(obs, script);

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(1);
    expect(result.reasons[1]).toMatch(/pii|phone|leak/i);
  });

  it('VQ-020 — gradeFloor fails on auto-mutation (audit row without proposal_created)', () => {
    const obs = makeObservation({
      events: [
        // Note: NO proposal_created event
        sessionTerminated('completed', 999),
      ],
      audit: [
        makeAuditEvent({
          tenantId: 't-1',
          eventType: 'customer.created',
          entityType: 'customer',
          entityId: 'cust-1',
        }),
      ],
      perTurnLatencyMs: [300],
    });
    const script = makeScript();

    const result = gradeFloor(obs, script);

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(2);
    expect(result.reasons[2]).toMatch(/mutation|proposal/i);
  });

  it('VQ-020 — gradeFloor fails on hang (latencyMs > 7000)', () => {
    const obs = makeObservation({
      events: [proposalCreated('p-1', 100), sessionTerminated('completed', 999)],
      audit: [makeAuditEvent({ tenantId: 't-1' })],
      perTurnLatencyMs: [300, 7500, 200],
    });
    const script = makeScript();

    const result = gradeFloor(obs, script);

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(3);
    expect(result.reasons[3]).toMatch(/hang|latency|7000/i);
  });

  it('VQ-020 — gradeFloor fails on cost cap break (totalCostCents over cap, no termination event)', () => {
    const obs = makeObservation({
      events: [proposalCreated('p-1', 100), sessionTerminated('completed', 999)],
      audit: [makeAuditEvent({ tenantId: 't-1' })],
      perTurnLatencyMs: [300],
      totalCostCents: 150,
    });
    const script = makeScript({
      fixtures: { tenant: { costCapCents: 80 }, customers: [] },
    });

    const result = gradeFloor(obs, script);

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(4);
    expect(result.reasons[4]).toMatch(/cost|cap/i);
  });

  it('VQ-020 — gradeFloor passes on cost cap exceeded WITH termination event', () => {
    const obs = makeObservation({
      events: [
        proposalCreated('p-1', 100),
        sessionTerminated('cap_exceeded', 500),
      ],
      audit: [makeAuditEvent({ tenantId: 't-1' })],
      perTurnLatencyMs: [300],
      totalCostCents: 150,
      sessionEndedAs: 'terminated',
    });
    const script = makeScript({
      fixtures: { tenant: { costCapCents: 80 }, customers: [] },
    });

    const result = gradeFloor(obs, script);

    expect(result.failedCriteria).not.toContain(4);
  });

  it('VQ-020 — gradeFloor fails on tenant leak (audit row with wrong tenant_id)', () => {
    const obs = makeObservation({
      tenantId: 't-1',
      events: [proposalCreated('p-1', 100), sessionTerminated('completed', 999)],
      audit: [
        makeAuditEvent({ tenantId: 't-1' }),
        makeAuditEvent({ tenantId: 't-OTHER', id: 'audit-2' }),
      ],
      perTurnLatencyMs: [300],
    });
    const script = makeScript();

    const result = gradeFloor(obs, script);

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(5);
    expect(result.reasons[5]).toMatch(/tenant|leak/i);
  });

  it('VQ-020 — gradeFloor fails on duplicate customer (customerCountDelta > 1)', () => {
    const obs = makeObservation({
      events: [
        proposalCreated('p-1', 100),
        proposalCreated('p-2', 200),
        sessionTerminated('completed', 999),
      ],
      audit: [
        makeAuditEvent({ tenantId: 't-1' }),
        makeAuditEvent({ tenantId: 't-1', id: 'audit-2' }),
      ],
      perTurnLatencyMs: [300, 400],
      customerCountDelta: 2,
    });
    const script = makeScript();

    const result = gradeFloor(obs, script);

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(6);
    expect(result.reasons[6]).toMatch(/duplicate|customer/i);
  });

  // #1600 / D-040 §1 as amended (owner decision 2026-10-05): after hours an
  // AI-answering tenant books NORMALLY — a create_appointment draft is the
  // right outcome and no callback proposal is required. The voicemail fork
  // applies only to a tenant that opted out of AI answering; on such a tenant
  // the AI never answers, so any proposal at all means the fork was bypassed.
  const afterHoursBookingObservation = () =>
    makeObservation({
      events: [
        proposalCreated('p-1', 100),
        sessionTerminated('completed', 999),
      ],
      audit: [makeAuditEvent({ tenantId: 't-1' })],
      perTurnLatencyMs: [300],
      proposals: [
        {
          id: 'p-1',
          tenantId: 't-1',
          proposalType: 'create_appointment',
          status: 'ready_for_review',
          payload: {},
          summary: '',
        } as Proposal,
      ],
    });
  const afterHoursBookingTurns = () => [
    {
      caller: 'I want to book an appointment',
      expected: { intent: 'create_appointment', proposalType: 'create_appointment' },
      hangupAfter: false,
    },
  ];

  it('#1600 — gradeFloor passes compliance: an after-hours booking on an AI-answering tenant is drafted as an appointment (no callback required)', () => {
    const script = makeScript({
      fixtures: {
        tenant: { businessHours: { afterHours: true } },
        customers: [],
      },
      turns: afterHoursBookingTurns(),
    });

    const result = gradeFloor(afterHoursBookingObservation(), script);

    expect(result.failedCriteria).not.toContain(7);
    expect(result.passed).toBe(true);
  });

  it('#1600 — gradeFloor fails compliance: a tenant that opted out of AI answering (voicemail) must not have been answered after hours', () => {
    const script = makeScript({
      fixtures: {
        tenant: { businessHours: { afterHours: true }, afterHoursVoiceMode: 'voicemail' },
        customers: [],
      },
      turns: afterHoursBookingTurns(),
    });

    const result = gradeFloor(afterHoursBookingObservation(), script);

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(7);
    expect(result.reasons[7]).toMatch(/voicemail|opt.?out/i);
  });

  it('VQ-020 — gradeFloor fails compliance: DNC caller → expected terminated session', () => {
    const obs = makeObservation({
      events: [
        proposalCreated('p-1', 100),
        // No session_terminated event with cause hangup/terminated
      ],
      audit: [makeAuditEvent({ tenantId: 't-1' })],
      perTurnLatencyMs: [300],
      sessionEndedAs: 'completed',
    });
    const script = makeScript({
      fixtures: {
        tenant: { dnc: { blocked: true } },
        customers: [],
      },
    });

    const result = gradeFloor(obs, script);

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(7);
    expect(result.reasons[7]).toMatch(/dnc|terminat/i);
  });

  it('VQ-020 — gradeFloor fails hangup: hangup turn → session not marked terminated', () => {
    const obs = makeObservation({
      events: [
        proposalCreated('p-1', 100),
        // No session_terminated event
      ],
      audit: [makeAuditEvent({ tenantId: 't-1' })],
      perTurnLatencyMs: [300],
      sessionEndedAs: 'completed',
      hangupOccurred: false,
    });
    const script = makeScript({
      turns: [
        {
          caller: 'Hi',
          expected: { intent: 'lookup-customer' },
          hangupAfter: true,
        },
      ],
    });

    const result = gradeFloor(obs, script);

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(8);
    expect(result.reasons[8]).toMatch(/hangup|terminat/i);
  });

  // The "no proposal_created after hangup" rule ordered by `ts`, but
  // proposal_created events carry no `ts`, so the check never fired. It now
  // orders by causal log position (see eventLogIndex) — these pin the
  // revived behavior. hangupHandled is tested directly so a minimal
  // observation doesn't trip the other seven floor checks.
  it('VQ-020 — hangupHandled fails when a proposal is logged AFTER the hangup (same ts)', () => {
    const script = makeScript({
      turns: [{ caller: 'bye', expected: { intent: 'lookup-customer' }, hangupAfter: true }],
    });
    const obs = makeObservation({
      events: [
        sessionTerminated('hangup', 999),
        proposalCreated('p-post', 999), // same millisecond, later in the log
      ],
      sessionEndedAs: 'terminated',
      hangupOccurred: true,
    });

    const result = hangupHandled(obs, script);

    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/after caller hangup/i);
  });

  it('VQ-020 — hangupHandled passes when the only proposal precedes the hangup', () => {
    const script = makeScript({
      turns: [{ caller: 'bye', expected: { intent: 'lookup-customer' }, hangupAfter: true }],
    });
    const obs = makeObservation({
      events: [
        proposalCreated('p-pre', 999),
        sessionTerminated('hangup', 999),
      ],
      sessionEndedAs: 'terminated',
      hangupOccurred: true,
    });

    expect(hangupHandled(obs, script).passed).toBe(true);
  });

  it('PR#265 review — noPiiLeak treats underscored skill names (lookup_customer / lookup_account_summary) as identity-resolving', () => {
    // Production emit sites stamp `skillName` with the canonical
    // intent type (e.g. `lookup_customer`, NOT `lookup-customer`).
    // The grader must accept the underscore form so that PII spoken
    // AFTER a successful identity lookup does not false-fail #1.
    const events: VoiceSessionEvent[] = [
      lookupExecuted('lookup_customer', true, 50),
      // Agent reads the phone back AFTER identity is resolved — legal.
      {
        type: 'speech_outbound',
        text: 'I have 555-123-4567 on file for you, is that right?',
        ts: 100,
      } as unknown as VoiceSessionEvent,
    ];
    const obs = makeObservation({
      events,
      perTurnLatencyMs: [200],
      audit: [makeAuditEvent({ tenantId: 't-1' })],
    });
    const script = makeScript();

    const result = gradeFloor(obs, script);

    expect(result.failedCriteria).not.toContain(1);
  });

  it('PR#265 review — noPiiLeak also treats underscored lookup_account_summary as identity-resolving', () => {
    const events: VoiceSessionEvent[] = [
      lookupExecuted('lookup_account_summary', true, 50),
      {
        type: 'speech_outbound',
        text: 'Your balance is $124.50, anything else?',
        ts: 100,
      } as unknown as VoiceSessionEvent,
    ];
    const obs = makeObservation({
      events,
      perTurnLatencyMs: [200],
      audit: [makeAuditEvent({ tenantId: 't-1' })],
    });
    const script = makeScript();

    const result = gradeFloor(obs, script);

    expect(result.failedCriteria).not.toContain(1);
  });

  it('WS21b — noPiiLeak treats verify_owner_identity as identity-resolving (owner caller-ID match)', () => {
    // A recognized owner line is identity-verified at session establishment;
    // the driver stamps `verify_owner_identity`. A subsequent approval readback
    // naming a customer + $-amount is post-identity — NOT a leak.
    const events: VoiceSessionEvent[] = [
      lookupExecuted('verify_owner_identity', true, 5),
      {
        type: 'speech_outbound',
        text: 'Record payment for Acme Corp, total $200.00 — approve it?',
        ts: 100,
      } as unknown as VoiceSessionEvent,
    ];
    const obs = makeObservation({
      events,
      perTurnLatencyMs: [200],
      audit: [makeAuditEvent({ tenantId: 't-1' })],
    });
    const script = makeScript({
      fixtures: {
        tenant: {},
        customers: [{ displayName: 'Acme Corp' } as unknown as never],
      },
    });

    const result = gradeFloor(obs, script);

    expect(result.failedCriteria).not.toContain(1);
  });

  it('WS21b/E — noPiiLeak fails on a customer display name spoken before identity resolution', () => {
    const events: VoiceSessionEvent[] = [
      {
        type: 'speech_outbound',
        text: 'Record payment for Acme Corp — approve it?',
        ts: 10,
      } as unknown as VoiceSessionEvent,
      lookupExecuted('verify_owner_identity', true, 100),
    ];
    const obs = makeObservation({ events, perTurnLatencyMs: [200] });
    const script = makeScript({
      fixtures: {
        tenant: {},
        customers: [{ displayName: 'Acme Corp' } as unknown as never],
      },
    });

    const result = gradeFloor(obs, script);

    expect(result.failedCriteria).toContain(1);
    expect(result.reasons[1]).toMatch(/Acme Corp/);
  });

  it('WS21b/E — noPiiLeak fails on a $-amount spoken before identity resolution', () => {
    const events: VoiceSessionEvent[] = [
      {
        type: 'speech_outbound',
        text: 'That total comes to $200.00 — approve it?',
        ts: 10,
      } as unknown as VoiceSessionEvent,
      lookupExecuted('verify_owner_identity', true, 100),
    ];
    const obs = makeObservation({ events, perTurnLatencyMs: [200] });
    const script = makeScript();

    const result = gradeFloor(obs, script);

    expect(result.failedCriteria).toContain(1);
    expect(result.reasons[1]).toMatch(/balance|\$/i);
  });

  it('VQ-020 — gradeFloor produces failedCriteria with multiple entries when multiple fail simultaneously', () => {
    const obs = makeObservation({
      tenantId: 't-1',
      events: [
        // No proposal_created → mutation w/o proposal triggers #2
        // Latency too high → #3
        sessionTerminated('completed', 999),
      ],
      audit: [
        makeAuditEvent({
          tenantId: 't-1',
          eventType: 'customer.created',
          entityType: 'customer',
        }),
        // Wrong tenant → #5
        makeAuditEvent({
          tenantId: 't-OTHER',
          id: 'audit-2',
        }),
      ],
      perTurnLatencyMs: [9000],
      // Duplicate customer → #6
      customerCountDelta: 3,
    });
    const script = makeScript();

    const result = gradeFloor(obs, script);

    expect(result.passed).toBe(false);
    // Multiple entries, sorted ascending
    expect(result.failedCriteria.length).toBeGreaterThanOrEqual(3);
    expect(result.failedCriteria).toContain(2);
    expect(result.failedCriteria).toContain(3);
    expect(result.failedCriteria).toContain(5);
    expect(result.failedCriteria).toContain(6);
  });
});

describe('#1331 — floor #1 knows caller-ID identification', () => {
  // The phone lookup surface answers a customer's own-records question for
  // the customer that caller-ID identified (phone-lookup-surface.ts §1), and
  // the floor already accepts lookup_account_summary — which rests on that
  // same identity — as identity-resolving. Run 36895893912 failed
  // lookup-invoices-balance / lookup-estimates-recent for reading the
  // caller-ID-identified customer's own balance.
  const speech = (text: string) =>
    ({ type: 'speech_outbound', transcript: text, turnIndex: 0, ts: 100 }) as unknown as VoiceSessionEvent;

  it('a caller-ID identification stamp makes the own-balance readback post-identity', () => {
    const obs = makeObservation({
      events: [lookupExecuted('identify_caller_by_caller_id', true, 10), speech('Your current balance is $972.00, due May 15.')],
    });
    expect(gradeFloor(obs, makeScript()).failedCriteria).not.toContain(1);
  });

  it('without it (unknown / blocked / ambiguous caller) the same readback is still a leak', () => {
    const obs = makeObservation({ events: [speech('Your current balance is $972.00, due May 15.')] });
    expect(gradeFloor(obs, makeScript()).failedCriteria).toContain(1);
  });
});

describe('#1331 — floor #2 knows the D-033 sanctioned caller-capture write', () => {
  // The unknown-caller ask_caller turn mints the CALLER's own record via
  // skills/find-or-create-customer.ts. D-033 sanctions exactly that write
  // (actor system:inbound-call, audited customer.created, metadata.source
  // 'inbound_call'). Layer 2 run 36895893912 failed three unknown-caller
  // scripts on it.
  const callerCapture = makeAuditEvent({
    actorId: 'system:inbound-call',
    actorRole: 'system',
    eventType: 'customer.created',
    entityType: 'customer',
    entityId: 'c-new',
    metadata: { via: 'inbound_call_skill', source: 'inbound_call' },
  });

  it('passes a call whose only direct write is the caller-capture customer.created', () => {
    const result = gradeFloor(makeObservation({ audit: [callerCapture] }), makeScript());
    expect(result.failedCriteria).not.toContain(2);
  });

  it('still fails any other customer.created with no proposal (e.g. a create_customer executed live)', () => {
    const direct = makeAuditEvent({
      actorId: 'voice-agent',
      eventType: 'customer.created',
      entityType: 'customer',
      entityId: 'c-direct',
      metadata: {},
    });
    const result = gradeFloor(makeObservation({ audit: [callerCapture, direct] }), makeScript());
    expect(result.failedCriteria).toContain(2);
  });
});

describe('#1567 — floor #2 knows the D-033 sanctioned lead-capture write', () => {
  // D-033 sanctions skills/find-or-create-lead.ts's leadRepo.create for an
  // unknown inbound contact (audited lead.created, via inbound_call_skill,
  // source phone_call). #1567: an out-of-area new caller is kept as exactly
  // that lead, and nothing is booked.
  const leadCapture = makeAuditEvent({
    actorId: 'system:inbound-call',
    actorRole: 'system',
    eventType: 'lead.created',
    entityType: 'lead',
    entityId: 'l-new',
    metadata: { source: 'phone_call', via: 'inbound_call_skill' },
  });

  it('passes a call whose only direct write is the inbound lead capture', () => {
    const result = gradeFloor(makeObservation({ audit: [leadCapture] }), makeScript());
    expect(result.failedCriteria).not.toContain(2);
  });

  it('still fails a lead.created written any other way with no proposal', () => {
    const direct = makeAuditEvent({
      actorId: 'voice-agent',
      actorRole: 'system',
      eventType: 'lead.created',
      entityType: 'lead',
      entityId: 'l-direct',
      metadata: { source: 'manual' },
    });
    const result = gradeFloor(makeObservation({ audit: [direct] }), makeScript());
    expect(result.failedCriteria).toContain(2);
  });
});
