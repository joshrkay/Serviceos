/**
 * #1587 — two identity gates the Layer 1 corpus required, ported from the
 * simulator into the production turn engine so every phone transport that
 * dispatches `speechTurn` reaches them.
 *
 * Seam: `createVoiceTurnProcessor().speechTurn` with a session established
 * the way the Twilio adapter establishes it (FSM bootstrap + caller-ID
 * identity). Expected values are the FSM's own hand-off effects and the
 * repositories' contents — never the processor's internals.
 *
 *   1. CLAIMS-EXISTING (04-identity-edges/caller-id-mismatched-but-claims-existing):
 *      an unknown caller introduces themselves as an existing customer whose
 *      number on file is not this caller-id. The engine must not mint a new
 *      record for the number (D-033's capture write is for the caller's OWN
 *      record) and must not resolve the account from the spoken name; it
 *      hands the caller to a person.
 *   2. ARCHIVED (09-concurrency/customer-just-archived-mid-call): caller-ID
 *      resolved a customer whose record is archived. Nothing is read from or
 *      drafted on a closed account; the caller is handed to a person.
 */
import { describe, it, expect } from 'vitest';
import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn/create-voice-turn-processor';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { LLMGateway, type LLMRequest, type LLMResponse } from '../../../src/ai/gateway/gateway';
import { InMemoryCustomerRepository, type Customer } from '../../../src/customers/customer';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../src/oncall/rotation';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import { InMemoryInvoiceRepository } from '../../../src/invoices/invoice';
import { InMemoryEstimateRepository } from '../../../src/estimates/estimate';
import { InMemoryJobRepository } from '../../../src/jobs/job';
import { InMemoryLeadRepository } from '../../../src/leads/in-memory-lead';
import { FixtureEntityResolver } from '../../../src/ai/voice-quality/fixture-entity-resolver';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 't-1587-identity';
const JANE_ID = '00000000-0000-4000-8000-000000001587';

class ClassifyGateway extends LLMGateway {
  constructor(private readonly intentType: string) {
    super({ defaultProvider: 'mock' }, new Map());
  }
  override async complete(_request: LLMRequest): Promise<LLMResponse> {
    return {
      content: JSON.stringify({ intentType: this.intentType, confidence: 0.95 }),
      model: 'mock',
      provider: 'mock',
      latencyMs: 1,
      tokenUsage: { input: 10, output: 10, total: 20 },
    };
  }
}

function jane(overrides: Partial<Customer> = {}): Customer {
  const now = new Date('2026-04-01T10:00:00.000Z');
  return {
    id: JANE_ID,
    tenantId: TENANT,
    firstName: 'Jane',
    lastName: 'Smith',
    displayName: 'Jane Smith',
    primaryPhone: '+15555550494',
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: 'seed',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function makeHarness(opts: { intent: string; customers: Customer[]; callerPhone: string }) {
  const store = new VoiceSessionStore({ startInterval: false });
  const customerRepo = new InMemoryCustomerRepository();
  for (const c of opts.customers) await customerRepo.create(c);
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const jobRepo = new InMemoryJobRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const leadRepo = new InMemoryLeadRepository();
  const entityResolver = new FixtureEntityResolver(() => ({
    tenantId: TENANT,
    timezone: 'America/Los_Angeles',
    customerRepo,
    jobRepo,
    invoiceRepo,
    estimateRepo,
    appointmentRepo,
    leadRepo,
  }));
  const onCallRepo = new InMemoryOnCallRepository(
    new Map([[TENANT, [{ id: 'oncall_1', userId: 'dispatcher_1', orderIndex: 0 }]]]),
  );
  const processor = createVoiceTurnProcessor({
    store,
    gateway: new ClassifyGateway(opts.intent),
    businessName: 'Acme HVAC',
    coverageSurface: 'gather',
    systemActorId: 'system:test',
    customerRepo,
    proposalRepo,
    auditRepo,
    onCallRepo,
    appointmentRepo,
    jobRepo,
    entityResolver,
    callerPhoneResolver: (s) => s.callerPhone ?? '',
  });
  const callSid = 'CA-1587';
  const session = store.create(TENANT, 'telephony', { callSid, customerProtectionIntents: true });
  session.callerPhone = opts.callerPhone;
  const events: Array<Record<string, unknown>> = [];
  session.events.on('voice-event', (e: Record<string, unknown>) => events.push(e));
  session.machine.dispatch({ type: 'incoming_call', callSid, from: opts.callerPhone, to: '', tenantId: TENANT });
  session.machine.dispatch({ type: 'greeted_ok' });
  const turn = async (speech: string): Promise<SideEffect[]> =>
    processor.speechTurn({ session, speechResult: speech, callSid, tenantId: TENANT });
  const spoken = (fx: SideEffect[]): string =>
    fx
      .filter((f) => f.type === 'tts_play' && typeof f.payload.text === 'string')
      .map((f) => f.payload.text as string)
      .join(' ');
  return { processor, session, customerRepo, proposalRepo, events, turn, spoken };
}

describe('#1587 — an unknown caller who claims to be an existing customer', () => {
  it('is handed to a person: no record is minted for the number and the spoken name resolves nothing', async () => {
    // Jane Smith is on file at +1 555 555 0494; this call is from 0404.
    const h = await makeHarness({
      intent: 'lookup_account_summary',
      customers: [jane()],
      callerPhone: '+15555550404',
    });
    h.session.machine.dispatch({ type: 'unknown_caller' });

    const fx = await h.turn('Hi, this is Jane Smith.');

    // The FSM's identity-failure hand-off, not a customer record.
    expect(h.spoken(fx)).toContain('Let me connect you with a team member');
    expect(h.session.machine.currentState).toBe('escalating');
    expect(h.events.filter((e) => e.type === 'escalation_triggered')).toHaveLength(1);
    expect(await h.customerRepo.findByTenant(TENANT)).toHaveLength(1);
    expect(h.session.customerId).toBeUndefined();
    // Nothing of Jane's is spoken.
    expect(h.spoken(fx)).not.toContain('Jane');
  });
});

describe('#1587 — a caller-ID caller whose record is archived', () => {
  it('is handed to a person instead of being read their closed account', async () => {
    const h = await makeHarness({
      intent: 'lookup_account_summary',
      customers: [jane({ primaryPhone: '+15555550903', isArchived: true })],
      callerPhone: '+15555550903',
    });
    // As the adapter binds a caller-ID match.
    h.session.customerId = JANE_ID;
    h.session.machine.dispatch({ type: 'caller_known', customerId: JANE_ID });

    const fx = await h.turn('Hi, this is Jane Smith. Can I get a summary of my account?');

    expect(h.spoken(fx)).toContain('Let me connect you with a team member');
    expect(h.session.machine.currentState).toBe('escalating');
    expect(h.events.filter((e) => e.type === 'escalation_triggered')).toHaveLength(1);
    // No lookup ran on the archived account.
    expect(h.events.filter((e) => e.type === 'lookup_executed')).toHaveLength(0);
    expect(h.spoken(fx)).not.toMatch(/appointment|invoice|owed|balance/i);
  });
});
