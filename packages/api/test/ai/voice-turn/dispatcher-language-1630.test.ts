/**
 * #1630 — the dispatcher-facing escalation copy follows the tenant's
 * `default_language`, and the ask_caller max-retries hand-off is filed under
 * the same recorded category as the in-app adapter.
 *
 * Seam: `createVoiceTurnProcessor().speechTurn` with a session established the
 * way the Twilio adapter establishes it, a scripted gateway, shipped in-memory
 * repositories and the real summary fan-out (WhisperCache + SMS stub). Expected
 * sentences are the issue's / #1616's own wording, never the processor's.
 */
import { describe, it, expect, afterEach } from 'vitest';
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
import { InMemorySettingsRepository, type TenantSettings } from '../../../src/settings/settings';
import { FixtureEntityResolver } from '../../../src/ai/voice-quality/fixture-entity-resolver';
import { WhisperCache } from '../../../src/telephony/whisper-cache';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 't-1630-language';
const JANE_ID = '00000000-0000-4000-8000-000000001616';
const JANE_PHONE = '+15555550494';
const OTHER_PHONE = '+15555550404';
const DISPATCHER_PHONE = '+15555550100';

/** The model, scripted: one classify answer for every turn. */
class ScriptedGateway extends LLMGateway {
  constructor(private readonly classifyJson: string) {
    super({ defaultProvider: 'mock' }, new Map());
  }
  override async complete(request: LLMRequest): Promise<LLMResponse> {
    const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
    const content = user.includes("Classify the caller's response as YES or NO.")
      ? JSON.stringify({ answer: 'yes', reasoning: 'scripted' })
      : this.classifyJson;
    return {
      content,
      model: 'mock',
      provider: 'mock',
      latencyMs: 1,
      tokenUsage: { input: 10, output: 10, total: 20 },
    };
  }
}

function classify(intentType: string): string {
  return JSON.stringify({ intentType, confidence: 0.95, extractedEntities: {} });
}

function jane(overrides: Partial<Customer> = {}): Customer {
  const now = new Date('2026-04-01T10:00:00.000Z');
  return {
    id: JANE_ID,
    tenantId: TENANT,
    firstName: 'Jane',
    lastName: 'Smith',
    displayName: 'Jane Smith',
    primaryPhone: JANE_PHONE,
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: 'seed',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

type StartedEvent = {
  type: 'escalation_started';
  escalationId: string;
  panel: { reason: { code: string; humanReadable: string } };
};

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

async function makeHarness(opts: {
  classifyJson: string;
  customers: Customer[];
  callerPhone: string;
  defaultLanguage?: 'en' | 'es';
  withCustomerRepo?: boolean;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const customerRepo = new InMemoryCustomerRepository();
  for (const c of opts.customers) await customerRepo.create(c);
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const jobRepo = new InMemoryJobRepository();
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    tenantId: TENANT,
    timezone: 'America/Los_Angeles',
    ...(opts.defaultLanguage ? { defaultLanguage: opts.defaultLanguage } : {}),
  } as TenantSettings);
  const gateway = new ScriptedGateway(opts.classifyJson);
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
  // The real fan-out targets: the whisper the dispatcher hears on pickup and
  // the context SMS sent before the bridge.
  const whisperCache = new WhisperCache();
  const smsBodies: string[] = [];
  const processor = createVoiceTurnProcessor({
    store,
    gateway,
    businessName: 'Acme HVAC',
    coverageSurface: 'gather',
    systemActorId: 'system:test',
    ...(opts.withCustomerRepo === false ? {} : { customerRepo }),
    proposalRepo,
    auditRepo,
    onCallRepo,
    appointmentRepo,
    jobRepo,
    settingsRepo,
    entityResolver,
    callerPhoneResolver: (s) => s.callerPhone ?? '',
    publicBaseUrl: 'https://api.example.test',
    dispatcherPhoneResolver: async () => DISPATCHER_PHONE,
    whisperCache,
    deliveryProvider: {
      sendSms: async ({ body }: { to: string; body: string }) => {
        smsBodies.push(body);
        return { ok: true };
      },
    },
  });
  const callSid = 'CA-1616';
  const session = store.create(TENANT, 'telephony', { callSid, customerProtectionIntents: true });
  session.callerPhone = opts.callerPhone;
  const events: Array<Record<string, unknown>> = [];
  session.events.on('voice-event', (e: Record<string, unknown>) => events.push(e));
  session.machine.dispatch({ type: 'incoming_call', callSid, from: opts.callerPhone, to: '', tenantId: TENANT });
  session.machine.dispatch({ type: 'greeted_ok' });
  const turn = async (speech: string): Promise<SideEffect[]> =>
    processor.speechTurn({ session, speechResult: speech, callSid, tenantId: TENANT });
  const started = (): StartedEvent | undefined =>
    events.find((e) => e.type === 'escalation_started') as StartedEvent | undefined;
  return { session, auditRepo, events, turn, whisperCache, smsBodies, started };
}

describe('#1630 (1) — dispatcher copy follows the tenant default_language', () => {
  async function claimsJane(defaultLanguage?: 'en' | 'es') {
    const h = await makeHarness({
      classifyJson: classify('lookup_account_summary'),
      customers: [jane()],
      callerPhone: OTHER_PHONE,
      ...(defaultLanguage ? { defaultLanguage } : {}),
    });
    h.session.machine.dispatch({ type: 'unknown_caller' });
    await h.turn('Hi, this is Jane Smith.');
    return h;
  }

  it('a Spanish-default tenant gets the Spanish panel, whisper and SMS', async () => {
    const h = await claimsJane('es');

    const started = h.started();
    expect(started?.panel.reason.humanReadable).toBe(
      'La persona que llama dice ser Jane Smith, pero el n\u00famero no coincide con su registro',
    );
    expect(h.whisperCache.get(started?.escalationId ?? '')?.text).toContain(
      'Reason: dice ser Jane Smith, el n\u00famero no coincide con su registro.',
    );
    expect(h.smsBodies).toHaveLength(1);
    expect(h.smsBodies[0]).toContain('Reason: dice ser Jane Smith (sin verificar).');
  });

  it('an English-default tenant is unchanged', async () => {
    const h = await claimsJane('en');

    expect(h.started()?.panel.reason.humanReadable).toBe(
      "Caller says they're Jane Smith but the number doesn't match their record",
    );
    expect(h.smsBodies[0]).toContain("Reason: says they're Jane Smith (unverified).");
  });
});

describe('#1630 (2) — ask_caller max retries is filed like the in-app adapter files it', () => {
  it('an unidentified caller handed off after the retry cap is recorded as max_retries_exceeded, not low_confidence', async () => {
    // No customer repo on the line: every ask_caller turn is a failed identification.
    const h = await makeHarness({
      classifyJson: classify('unknown'),
      customers: [],
      callerPhone: OTHER_PHONE,
      withCustomerRepo: false,
    });
    h.session.machine.dispatch({ type: 'unknown_caller' });

    await h.turn('It is John.');
    expect(h.session.machine.currentState).toBe('ask_caller');
    await h.turn('Still John.');

    expect(h.session.machine.currentState).toBe('escalating');
    expect(h.events.find((e) => e.type === 'escalation_triggered')?.reason).toBe('max_retries_exceeded');
    const audit = h.auditRepo.getAll().find((e) => e.eventType === 'escalation.requested');
    expect(audit?.metadata?.reason).toBe('max_retries_exceeded');
  });
});
