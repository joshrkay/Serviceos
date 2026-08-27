/**
 * VQ-007 — TextModeDriver tests.
 *
 * Drives the `AgentDriver` interface implementation that sits in front
 * of the existing classifier → action-router → skill orchestration
 * without going through Twilio. Each test exercises one slice:
 *   - session lifecycle (start / end)
 *   - lookup intents → return spoken summary
 *   - mutation intents → proposal created (no direct DB write)
 *   - bus emissions (intent_classified + proposal_created / lookup_executed)
 *   - latency reporting
 *   - hangup cause
 *   - cross-session isolation
 *
 * The LLM is faked via a `MockLLMProvider` that returns a canned
 * classifier JSON per turn — simpler than wiring a record-mode cassette
 * for unit tests. Production CI (Phase 2 corpus) will use the cassette
 * gateway; unit tests just need a deterministic gateway shim.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { AgentEventBus } from '../../src/ai/voice-quality/event-bus';
import {
  TextModeDriver,
  VQ_OWNER_ACTOR_PREFIX,
  vqOwnerActorId,
} from '../../src/ai/voice-quality/text-mode-driver';
import { LOOKUP_UNAVAILABLE_LINE } from '../../src/ai/voice-turn/phone-lookup-surface';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryLeadRepository } from '../../src/leads/in-memory-lead';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryAgreementRepository } from '../../src/agreements/agreement';
import { InMemoryDailyDigestRepository } from '../../src/digest/digest-service';
import { InMemoryMoneyDashboardRepository } from '../../src/reports/money-dashboard';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';

import type { Customer } from '../../src/customers/customer';
import type { MockLLMProvider } from '../../src/ai/providers/mock';

function makeCustomer(tenantId: string, id: string, name: string, phone?: string): Customer {
  return {
    id,
    tenantId,
    firstName: name.split(' ')[0] ?? name,
    lastName: name.split(' ').slice(1).join(' ') || 'Doe',
    displayName: name,
    primaryPhone: phone,
    preferredChannel: 'phone',
    smsConsent: true,
    isArchived: false,
    createdBy: 'test',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

interface Harness {
  store: VoiceSessionStore;
  bus: AgentEventBus;
  driver: TextModeDriver;
  provider: MockLLMProvider;
  proposalRepo: InMemoryProposalRepository;
  customerRepo: InMemoryCustomerRepository;
  appointmentRepo: InMemoryAppointmentRepository;
  dailyDigestRepo: InMemoryDailyDigestRepository;
  moneyDashboardRepo: InMemoryMoneyDashboardRepository;
  invoiceRepo: InMemoryInvoiceRepository;
}

function buildHarness(): Harness {
  const store = new VoiceSessionStore({ startInterval: false });
  const bus = new AgentEventBus();
  const { gateway, provider } = createMockLLMGateway();

  const proposalRepo = new InMemoryProposalRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const jobRepo = new InMemoryJobRepository();
  const leadRepo = new InMemoryLeadRepository();
  const auditRepo = new InMemoryAuditRepository();
  const agreementRepo = new InMemoryAgreementRepository();
  const dailyDigestRepo = new InMemoryDailyDigestRepository();
  const moneyDashboardRepo = new InMemoryMoneyDashboardRepository();

  const driver = new TextModeDriver({
    voiceSessionStore: store,
    bus,
    gateway,
    proposalRepo,
    customerRepo,
    appointmentRepo,
    invoiceRepo,
    estimateRepo,
    jobRepo,
    leadRepo,
    auditRepo,
    // #869 — the harness is the FOURTH caller of the shared lookup dispatch;
    // this bundle is the same shape the live phone's Gather adapter takes.
    lookups: {
      answers: {
        invoiceRepo,
        estimateRepo,
        agreementRepo,
        leadRepo,
        dailyDigestRepo,
        moneyDashboardRepo,
        // Harness-owned actor → role seam (decision 3). The driver's synthetic
        // owner subject resolves to `owner`; every other subject is unknown, so
        // the shipped RBAC gate fails closed exactly as it does in production.
        resolveMemberRole: async (_tenantId: string, userId: string) =>
          userId.startsWith(VQ_OWNER_ACTOR_PREFIX) ? 'owner' : null,
      },
      shared: { jobRepo, appointmentRepo, customerRepo, proposalRepo },
    },
    systemActorId: 'system:vq-test',
  });

  return {
    store,
    bus,
    driver,
    provider,
    proposalRepo,
    customerRepo,
    appointmentRepo,
    dailyDigestRepo,
    moneyDashboardRepo,
    invoiceRepo,
  };
}

describe('VQ-007 — TextModeDriver', () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    h.bus.unsubscribeAll();
    h.store.dispose();
  });

  it('VQ-007 — startSession returns a sessionId and registers the session in the store', async () => {
    const { sessionId } = await h.driver.startSession({
      tenantId: 't-1',
      callerId: '+15555550100',
      callerIdBlocked: false,
    });
    expect(sessionId).toBeTruthy();
    const snap = h.store.snapshot(sessionId);
    expect(snap).not.toBeNull();
    expect(snap!.tenantId).toBe('t-1');
  });

  it('VQ-007 — speak() with a lookup intent returns a spoken summary as agentResponse', async () => {
    const tenantId = 't-1';
    const customer = makeCustomer(tenantId, 'cust-1', 'Jane Smith', '+15555550100');
    await h.customerRepo.create(customer);

    const { sessionId } = await h.driver.startSession({
      tenantId,
      callerId: '+15555550100',
      callerIdBlocked: false,
    });
    // Bind the session to this customer so customer-scoped lookups
    // (lookup_customer, lookup_account_summary) resolve.
    const session = h.store.get(sessionId);
    if (session) session.customerId = 'cust-1';

    h.provider.setDefaultResponse(
      JSON.stringify({ intentType: 'lookup_customer', confidence: 0.95 }),
    );

    const { agentResponse } = await h.driver.speak(
      sessionId,
      'Could you confirm my contact info on file?',
    );

    expect(typeof agentResponse).toBe('string');
    expect(agentResponse.length).toBeGreaterThan(0);
    expect(agentResponse.toLowerCase()).toContain('jane');
  });

  it('VQ-007 — speak() with a mutation intent creates a proposal (no direct DB write)', async () => {
    const tenantId = 't-1';
    const { sessionId } = await h.driver.startSession({
      tenantId,
      callerId: '+15555550101',
      callerIdBlocked: false,
    });

    h.provider.setDefaultResponse(
      JSON.stringify({
        intentType: 'create_customer',
        confidence: 0.95,
        extractedEntities: {
          displayName: 'New Caller',
          phone: '+15555550101',
        },
      }),
    );

    await h.driver.speak(sessionId, 'Please add me as a new customer, my name is New Caller.');

    // Mutation must surface as a proposal, not a direct customer row.
    const proposals = await h.proposalRepo.findByTenant(tenantId);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('create_customer');
  });

  it('VQ-007 — speak() emits intent_classified + proposal_created on the bus for a mutation', async () => {
    const tenantId = 't-2';
    const { sessionId } = await h.driver.startSession({
      tenantId,
      callerId: null,
      callerIdBlocked: true,
    });

    h.provider.setDefaultResponse(
      JSON.stringify({
        intentType: 'create_customer',
        confidence: 0.91,
        extractedEntities: { displayName: 'Anon Caller', phone: '+15555550102' },
      }),
    );

    await h.driver.speak(sessionId, 'Add a new customer named Anon Caller.');

    const intentEvents = h.bus.filterByType('intent_classified');
    const proposalEvents = h.bus.filterByType('proposal_created');
    expect(intentEvents).toHaveLength(1);
    expect(intentEvents[0].intentType).toBe('create_customer');
    expect(proposalEvents).toHaveLength(1);
    expect(proposalEvents[0].proposalId).toBeTruthy();
  });

  it('VQ-007 — speak() emits intent_classified + lookup_executed on the bus for a lookup', async () => {
    const tenantId = 't-3';
    const customer = makeCustomer(tenantId, 'cust-9', 'Alice Doe', '+15555550103');
    await h.customerRepo.create(customer);

    const { sessionId } = await h.driver.startSession({
      tenantId,
      callerId: '+15555550103',
      callerIdBlocked: false,
    });
    const session = h.store.get(sessionId);
    if (session) session.customerId = 'cust-9';

    h.provider.setDefaultResponse(
      JSON.stringify({ intentType: 'lookup_customer', confidence: 0.93 }),
    );

    await h.driver.speak(sessionId, 'What contact info do you have for me?');

    expect(h.bus.filterByType('intent_classified')).toHaveLength(1);
    const lookups = h.bus.filterByType('lookup_executed');
    expect(lookups).toHaveLength(1);
    expect(lookups[0].skillName).toBe('lookup_customer');
    expect(lookups[0].success).toBe(true);
  });

  // #869 — replaces "refuses forced owner lookup intent when extendedIntents is
  // not set". The tenant flag gates what the CLASSIFIER offers, never what the
  // dispatch answers (D-026); the shipped gate is the resolved actor + RBAC.
  it('#869 — a forced owner-extended lookup is ANSWERED for an owner actor with the tenant flag unset', async () => {
    const tenantId = 't-owner-flag-off';
    const { sessionId } = await h.driver.startSession({
      tenantId,
      callerId: '+15555550109',
      callerIdBlocked: false,
      callerIsOwner: true,
    });
    const session = h.store.get(sessionId);
    if (!session) throw new Error('missing session');
    expect(session.machine.currentContext.extendedIntents).not.toBe(true);
    const findLatest = vi.spyOn(h.dailyDigestRepo, 'findLatest');

    h.provider.setDefaultResponse(
      JSON.stringify({ intentType: 'lookup_digest', confidence: 0.95 }),
    );

    const { agentResponse } = await h.driver.speak(sessionId, 'read me my day');

    expect(agentResponse).not.toBe(LOOKUP_UNAVAILABLE_LINE);
    expect(agentResponse).not.toContain('owner-level report');
    expect(findLatest).toHaveBeenCalled();
    const digests = h.bus
      .filterByType('lookup_executed')
      .filter((e) => e.skillName === 'lookup_digest');
    expect(digests).toHaveLength(1);
    expect(digests[0].success).toBe(true);
  });

  it('#869 — a forced owner-extended lookup is REFUSED for a session with no actor', async () => {
    const { sessionId } = await h.driver.startSession({
      tenantId: 't-owner-no-actor',
      callerId: '+15555550110',
      callerIdBlocked: false,
    });
    const findLatest = vi.spyOn(h.dailyDigestRepo, 'findLatest');

    h.provider.setDefaultResponse(
      JSON.stringify({ intentType: 'lookup_digest', confidence: 0.95 }),
    );

    const { agentResponse } = await h.driver.speak(sessionId, 'read me my day');

    expect(agentResponse).toContain('owner-level report');
    expect(findLatest).not.toHaveBeenCalled();
    const digests = h.bus
      .filterByType('lookup_executed')
      .filter((e) => e.skillName === 'lookup_digest');
    expect(digests).toHaveLength(1);
    expect(digests[0].success).toBe(false);
    expect(digests[0].error).toBe('refused');
  });

  it('#869 — an owner-line session answers an owner-grade lookup from the shared dispatch', async () => {
    const tenantId = 't-owner-revenue';
    h.moneyDashboardRepo.setSummary({
      month: '2026-08',
      revenueCents: 1234500,
      grossRevenueCents: 1234500,
      refundsCents: 0,
      priorMonthRevenueCents: 0,
      revenueTrendCents: 0,
      expensesCents: 0,
      outstandingCents: 0,
      overdueCents: 0,
    });
    const query = vi.spyOn(h.moneyDashboardRepo, 'query');

    const { sessionId } = await h.driver.startSession({
      tenantId,
      callerId: '+15125550100',
      callerIdBlocked: false,
      callerIsOwner: true,
    });

    h.provider.setDefaultResponse(
      JSON.stringify({ intentType: 'lookup_revenue', confidence: 0.95 }),
    );

    const { agentResponse } = await h.driver.speak(
      sessionId,
      'How much have we brought in this month?',
    );

    // The in-memory money dashboard was actually read — the spoken line is the
    // skill's own summary, not the surface's unavailable/refusal copy.
    expect(query).toHaveBeenCalled();
    expect(agentResponse).toContain('$12345.00');
    expect(agentResponse).not.toBe(LOOKUP_UNAVAILABLE_LINE);

    const revenue = h.bus
      .filterByType('lookup_executed')
      .filter((e) => e.skillName === 'lookup_revenue');
    expect(revenue).toHaveLength(1);
    expect(revenue[0].success).toBe(true);

    // The actor is stamped ONCE, at establishment, from the owner line.
    expect(h.store.get(sessionId)?.actorUserId).toBe(vqOwnerActorId(tenantId));
  });

  it('#869 — a customer session is refused the same owner-grade lookup, with the production copy', async () => {
    const tenantId = 't-customer-revenue';
    const customer = makeCustomer(tenantId, 'cust-rev', 'Rita Ruiz', '+15555550120');
    await h.customerRepo.create(customer);
    const query = vi.spyOn(h.moneyDashboardRepo, 'query');

    const { sessionId } = await h.driver.startSession({
      tenantId,
      callerId: '+15555550120',
      callerIdBlocked: false,
    });

    h.provider.setDefaultResponse(
      JSON.stringify({ intentType: 'lookup_revenue', confidence: 0.95 }),
    );

    const { agentResponse } = await h.driver.speak(
      sessionId,
      'How much have you brought in this month?',
    );

    expect(agentResponse).toContain('owner-level report');
    // Nothing was read: the refusal is decided before any repository call.
    expect(query).not.toHaveBeenCalled();

    const revenue = h.bus
      .filterByType('lookup_executed')
      .filter((e) => e.skillName === 'lookup_revenue');
    expect(revenue).toHaveLength(1);
    expect(revenue[0].success).toBe(false);
    expect(revenue[0].error).toBe('refused');

    // A customer on the phone gets no actor — and neither does this caller.
    expect(h.store.get(sessionId)?.actorUserId).toBeUndefined();
  });

  it('#869 — a customer session still gets its OWN records answered (lookup_invoices)', async () => {
    const tenantId = 't-customer-invoices';
    const customer = makeCustomer(tenantId, 'cust-inv', 'Fiona Fields', '+15555550121');
    await h.customerRepo.create(customer);

    const { sessionId } = await h.driver.startSession({
      tenantId,
      callerId: '+15555550121',
      callerIdBlocked: false,
    });
    expect(h.store.get(sessionId)?.customerId).toBe('cust-inv');

    h.provider.setDefaultResponse(
      JSON.stringify({ intentType: 'lookup_invoices', confidence: 0.95 }),
    );

    const { agentResponse } = await h.driver.speak(sessionId, 'What do I owe?');

    expect(agentResponse).not.toBe(LOOKUP_UNAVAILABLE_LINE);
    expect(agentResponse).not.toContain('owner-level report');

    const invoices = h.bus
      .filterByType('lookup_executed')
      .filter((e) => e.skillName === 'lookup_invoices');
    expect(invoices).toHaveLength(1);
    expect(invoices[0].success).toBe(true);
  });

  it('VQ-007 — speak() returns latencyMs > 0', async () => {
    const { sessionId } = await h.driver.startSession({
      tenantId: 't-1',
      callerId: '+15555550104',
      callerIdBlocked: false,
    });
    h.provider.setDefaultResponse(
      JSON.stringify({
        intentType: 'create_customer',
        confidence: 0.9,
        extractedEntities: { displayName: 'Foo Bar', phone: '+15555550104' },
      }),
    );
    const { latencyMs } = await h.driver.speak(sessionId, 'add me as a new customer');
    expect(latencyMs).toBeGreaterThan(0);
  });

  it('VQ-007 — hangup() emits session_terminated with cause=hangup', async () => {
    const { sessionId } = await h.driver.startSession({
      tenantId: 't-1',
      callerId: '+15555550105',
      callerIdBlocked: false,
    });
    await h.driver.hangup(sessionId);

    const terminated = h.bus.filterByType('session_terminated');
    expect(terminated).toHaveLength(1);
    expect(terminated[0].cause).toBe('hangup');
  });

  it('VQ-007 — endSession() removes the session from the store', async () => {
    const { sessionId } = await h.driver.startSession({
      tenantId: 't-1',
      callerId: '+15555550106',
      callerIdBlocked: false,
    });
    expect(h.store.snapshot(sessionId)).not.toBeNull();
    await h.driver.endSession(sessionId);
    expect(h.store.snapshot(sessionId)).toBeNull();
  });

  it('WS1 — a Spanish emergency keyword speaks the localized 911 line FIRST and escalates', async () => {
    // Emergency handling short-circuits BEFORE classify (no LLM), so we wire an
    // on-call rotation so escalateToHuman can emit escalation_triggered.
    const onCallRepo = new InMemoryOnCallRepository(
      new Map([['t-emergency', [{ id: 'oncall_1', userId: 'dispatcher_1', orderIndex: 0 }]]]),
    );
    const driver = new TextModeDriver({
      voiceSessionStore: h.store,
      bus: h.bus,
      gateway: createMockLLMGateway().gateway,
      proposalRepo: h.proposalRepo,
      customerRepo: h.customerRepo,
      onCallRepo,
      systemActorId: 'system:vq-test',
    });

    const { sessionId } = await driver.startSession({
      tenantId: 't-emergency',
      callerId: '+15555551104',
      callerIdBlocked: false,
    });

    const { agentResponse } = await driver.speak(
      sessionId,
      '¡Hay una fuga de gas en mi casa, se siente el olor a gas muy fuerte!',
    );

    // Localized Spanish 911 safety line, not the English source.
    expect(agentResponse).toBe('Si alguien está en peligro inmediato, cuelgue y llame al 911.');
    expect(h.bus.filterByType('escalation_triggered').length).toBeGreaterThan(0);
    // No classifier ran — the emergency interrupt consumed the turn.
    expect(h.bus.filterByType('intent_classified')).toHaveLength(0);
  });

  it('WS1 — an owner-session emits a verify_owner_identity lookup at establishment', async () => {
    const { sessionId } = await h.driver.startSession({
      tenantId: 't-owner',
      callerId: '+15125550100',
      callerIdBlocked: false,
      callerIsOwner: true,
    });
    expect(sessionId).toBeTruthy();

    const ownerId = h.bus
      .filterByType('lookup_executed')
      .filter((e) => e.skillName === 'verify_owner_identity');
    expect(ownerId).toHaveLength(1);
    expect(ownerId[0].success).toBe(true);
  });

  it('WS1 — a non-owner session does NOT emit verify_owner_identity', async () => {
    await h.driver.startSession({
      tenantId: 't-non-owner',
      callerId: '+15125550999',
      callerIdBlocked: false,
    });
    const ownerId = h.bus
      .filterByType('lookup_executed')
      .filter((e) => e.skillName === 'verify_owner_identity');
    expect(ownerId).toHaveLength(0);
  });

  it('VQ-007 — multiple sessions on the same store do not cross-contaminate', async () => {
    const tenantA = 't-A';
    const tenantB = 't-B';

    const a = await h.driver.startSession({
      tenantId: tenantA,
      callerId: '+15555550111',
      callerIdBlocked: false,
    });
    const b = await h.driver.startSession({
      tenantId: tenantB,
      callerId: '+15555550112',
      callerIdBlocked: false,
    });
    expect(a.sessionId).not.toBe(b.sessionId);

    h.provider.setDefaultResponse(
      JSON.stringify({
        intentType: 'create_customer',
        confidence: 0.9,
        extractedEntities: { displayName: 'A Caller', phone: '+15555550111' },
      }),
    );
    await h.driver.speak(a.sessionId, 'add me');

    h.provider.setDefaultResponse(
      JSON.stringify({
        intentType: 'create_customer',
        confidence: 0.9,
        extractedEntities: { displayName: 'B Caller', phone: '+15555550112' },
      }),
    );
    await h.driver.speak(b.sessionId, 'add me too');

    const propsA = await h.proposalRepo.findByTenant(tenantA);
    const propsB = await h.proposalRepo.findByTenant(tenantB);
    expect(propsA).toHaveLength(1);
    expect(propsB).toHaveLength(1);
    expect(propsA[0].tenantId).toBe(tenantA);
    expect(propsB[0].tenantId).toBe(tenantB);
  });
});
