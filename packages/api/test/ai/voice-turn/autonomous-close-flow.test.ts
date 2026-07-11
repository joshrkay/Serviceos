/**
 * WS18d — the sanctioned on-call close, end to end through the REAL FSM +
 * voice-turn processor + a REAL ProposalExecutor over in-memory repos.
 *
 * Paths pinned:
 *  - full close: affirmative → strict confirm → consent ask → grant → hold →
 *    lane → chain (draft_estimate → send_estimate → create_booking) executes
 *    IN ORDER on the turn; estimate row exists; the send dispatched through
 *    the (Noop) delivery provider with the resolved estimateId; the hold is
 *    confirmed; the owner got the UNDO SMS; the success copy is spoken.
 *  - pre-gate fail (tenant not opted in): owner-finalizes interim line + the
 *    fallback chain drafts + ONE renderChainSms owner SMS; nothing executes.
 *  - consent decline in close mode: decline copy + fallback chain.
 *  - post-consent lane fail (booking lane not opted in): hold released +
 *    honest fallback line.
 */
import { describe, it, expect, vi } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import {
  SMS_CONSENT_ASK,
  SMS_CONSENT_DECLINE_FALLBACK,
  CLOSE_TIMEOUT_COPY,
  CLOSE_FALLBACK_LINE,
} from '../../../src/ai/voice-turn/create-voice-turn-processor';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { ProposalExecutor } from '../../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../../src/proposals/execution/idempotency';
import { InMemoryProposalExecutionRepository } from '../../../src/proposals/proposal-execution';
import { createExecutionHandlerRegistry } from '../../../src/proposals/execution/handlers';
import { NoopEstimateDeliveryProvider } from '../../../src/proposals/execution/voice-extended-handlers';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import { InMemoryJobRepository, type Job } from '../../../src/jobs/job';
import { InMemoryCustomerRepository, type Customer } from '../../../src/customers/customer';
import { InMemoryConsentEventRepository } from '../../../src/compliance/consent-events';
import {
  InMemorySettingsRepository,
  type TenantSettings,
} from '../../../src/settings/settings';
import { InMemoryEstimateRepository } from '../../../src/estimates/estimate';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import type { CatalogItem, CatalogItemRepository } from '../../../src/catalog/catalog-item';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-close';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333';
const CALLER_PHONE = '+15125550100';
const OWNER_PHONE = '+15125550999';

function catalogItem(name: string, unitPriceCents: number): CatalogItem {
  const now = new Date().toISOString();
  return {
    id: `c-${name.toLowerCase().replace(/\s+/g, '-')}`,
    tenantId: TENANT,
    name,
    description: '',
    category: 'Parts',
    unit: 'each',
    unitPriceCents,
    productServiceType: 'product',
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function stubCatalogRepo(): CatalogItemRepository {
  return {
    listByTenant: async () => [catalogItem('Water Heater Replacement', 185000)],
  } as unknown as CatalogItemRepository;
}

/** classify(draft_estimate w/ scheduling entities) then "yes" forever. */
function closeGateway(): LLMGateway {
  const responses: LLMResponse[] = [
    {
      content: JSON.stringify({
        intentType: 'draft_estimate',
        confidence: 0.97,
        reasoning: 'quote',
        extractedEntities: {
          customerName: 'Ada',
          lineItemDescriptions: ['water heater replacement'],
          dateTimeDescription: 'tomorrow at 2pm',
        },
      }),
      model: 'm', provider: 'p', tokenUsage: { input: 1, output: 1, total: 2 }, latencyMs: 1,
    },
    {
      content: JSON.stringify({ answer: 'yes', reasoning: 'affirmative' }),
      model: 'm', provider: 'p', tokenUsage: { input: 1, output: 1, total: 2 }, latencyMs: 1,
    },
  ];
  let i = 0;
  return {
    complete: vi.fn().mockImplementation(async () => responses[Math.min(i++, responses.length - 1)]),
  } as unknown as LLMGateway;
}

function settingsRow(overrides: Partial<TenantSettings> = {}): TenantSettings {
  return {
    id: 'settings-1',
    tenantId: TENANT,
    businessName: 'Acme Plumbing',
    timezone: 'America/Chicago',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    autonomousCloseEnabled: true,
    autonomousCloseMaxCents: 500000,
    autonomousBookingEnabled: true,
    autonomousBookingThreshold: 0.95,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as TenantSettings;
}

function customerRow(): Customer {
  return {
    id: CUSTOMER_ID,
    tenantId: TENANT,
    firstName: 'Ada',
    lastName: 'Lovelace',
    displayName: 'Ada Lovelace',
    primaryPhone: CALLER_PHONE,
    smsConsent: false,
    preferredChannel: 'sms',
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Customer;
}

function jobRow(): Job {
  return {
    id: JOB_ID,
    tenantId: TENANT,
    customerId: CUSTOMER_ID,
    locationId: '44444444-4444-4444-8444-444444444444',
    jobNumber: 'J-1',
    summary: 'Water heater replacement',
    status: 'new',
    priority: 'normal',
    createdBy: 'test',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Job;
}

async function makeHarness(opts: {
  settings?: Partial<TenantSettings>;
  ownerSms?: boolean;
} = {}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const jobRepo = new InMemoryJobRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const consentEventRepo = new InMemoryConsentEventRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const estimateDelivery = new NoopEstimateDeliveryProvider();
  const executionRepo = new InMemoryProposalExecutionRepository();
  const ownerSmsBodies: Array<{ to: string; body: string }> = [];

  await settingsRepo.create(settingsRow(opts.settings));
  await customerRepo.create(customerRow());
  await jobRepo.create(jobRow());

  const handlers = createExecutionHandlerRegistry({
    proposalRepo,
    appointmentRepo,
    jobRepo,
    customerRepo,
    estimateRepo,
    settingsRepo,
    auditRepo,
    estimateDeliveryProvider: estimateDelivery,
  });
  const executor = new ProposalExecutor(
    handlers,
    proposalRepo,
    new IdempotencyGuard(executionRepo, proposalRepo),
    auditRepo,
    { executionRepo },
  );

  const gateway = closeGateway();
  const session = store.create(TENANT, 'telephony', { callSid: 'CA-close' });
  session.machine.dispatch({
    type: 'incoming_call', callSid: 'CA-close', from: CALLER_PHONE, to: '+15125550001', tenantId: TENANT,
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: CUSTOMER_ID });
  session.customerId = CUSTOMER_ID;
  session.callerPhone = CALLER_PHONE;

  const processor = createVoiceTurnProcessor({
    store,
    gateway,
    businessName: 'Acme Plumbing',
    systemActorId: 'test-actor',
    proposalRepo,
    auditRepo,
    appointmentRepo,
    jobRepo,
    customerRepo,
    consentEventRepo,
    settingsRepo,
    estimateRepo,
    catalogRepo: stubCatalogRepo(),
    autonomousClose: {
      executor,
      platformDisabled: false,
      bookingPlatformDisabled: false,
      ownerPhoneResolver: async () => (opts.ownerSms === false ? null : OWNER_PHONE),
      sendOwnerSms: async (to, body) => {
        ownerSmsBodies.push({ to, body });
      },
      oneTapSecret: 'close-secret',
      buildUndoUrl: (token) => `https://x/undo?token=${token}`,
      buildApproveUrl: (token) => `https://x/approve?token=${token}`,
    },
  });

  return {
    store, proposalRepo, auditRepo, appointmentRepo, estimateRepo, jobRepo,
    consentEventRepo, customerRepo, estimateDelivery, session, processor,
    ownerSmsBodies,
  };
}

type Harness = Awaited<ReturnType<typeof makeHarness>>;

async function turn(h: Harness, speechResult: string): Promise<SideEffect[]> {
  return h.processor.speechTurn({
    session: h.session, speechResult, callSid: 'CA-close', tenantId: TENANT,
  });
}

async function reachClosing(h: Harness): Promise<void> {
  await turn(h, 'I need a quote to replace my water heater, tomorrow at 2pm');
  expect(h.session.machine.currentState).toBe('intent_confirm');
  await turn(h, 'yes');
  expect(h.session.machine.currentState).toBe('closing');
  expect(h.session.machine.currentContext.pendingQuote).toBeDefined();
}

function lastTts(fx: SideEffect[]): string | undefined {
  return [...fx].reverse().find((e) => e.type === 'tts_play')?.payload.text as string | undefined;
}

describe('WS18d — full sanctioned close', () => {
  it('executes the chain in order on the consent-grant turn', async () => {
    const h = await makeHarness();
    await reachClosing(h);

    // Affirmative → strict confirm passes → consent ask.
    const askFx = await turn(h, 'yes book it');
    expect(lastTts(askFx)).toBe(SMS_CONSENT_ASK);
    expect(h.session.pendingConsentCapture?.close).toBeDefined();

    // Grant → consent recorded, hold placed, chain assembled + system-approved
    // + executed synchronously.
    const closeFx = await turn(h, 'yes that is fine');

    // Consent: ledger row + sms_consent flipped.
    expect(h.consentEventRepo.rows).toHaveLength(1);
    expect(h.consentEventRepo.rows[0]).toMatchObject({ kind: 'sms', state: 'granted', source: 'voice' });
    expect((await h.customerRepo.findById(TENANT, CUSTOMER_ID))!.smsConsent).toBe(true);

    // Chain: three members, all executed, in order.
    const proposals = await h.proposalRepo.findByTenant(TENANT);
    const chain = proposals.filter((p) => p.chainId);
    expect(chain).toHaveLength(3);
    const byType = Object.fromEntries(chain.map((p) => [p.proposalType, p]));
    expect(byType.draft_estimate!.status).toBe('executed');
    expect(byType.send_estimate!.status).toBe('executed');
    expect(byType.create_booking!.status).toBe('executed');

    // Estimate row exists; the send dispatched with the RESOLVED estimateId
    // (chain resolution threaded member 0's resultEntityId).
    const estimateId = byType.draft_estimate!.resultEntityId!;
    expect(await h.estimateRepo.findById(TENANT, estimateId)).not.toBeNull();
    expect(h.estimateDelivery.lastDispatch).toMatchObject({
      tenantId: TENANT,
      estimateId,
      channel: 'sms',
      recipient: CALLER_PHONE,
    });

    // Booking hold confirmed.
    const appointmentId = byType.create_booking!.payload.appointmentId as string;
    const appt = await h.appointmentRepo.findById(TENANT, appointmentId);
    expect(appt!.holdPendingApproval).toBe(false);

    // Owner UNDO SMS went out immediately, with the undo link.
    expect(h.ownerSmsBodies).toHaveLength(1);
    expect(h.ownerSmsBodies[0]!.to).toBe(OWNER_PHONE);
    expect(h.ownerSmsBodies[0]!.body).toContain('https://x/undo?token=');
    expect(h.ownerSmsBodies[0]!.body).toContain("can't be recalled");

    // Sanction audited per member; success copy spoken (never claims arrival).
    const sanctionEvents = h.auditRepo.getAll().filter((e) => e.eventType === 'proposal.system_approved');
    expect(sanctionEvents).toHaveLength(3);
    expect(sanctionEvents.every((e) => e.metadata!.sanction === 'D-018')).toBe(true);
    const spoken = lastTts(closeFx)!;
    expect(spoken).toMatch(/^You're booked for .+\. I'm sending the quote and booking link to your phone now — you'll get a text in a moment\.$/);
    expect(h.session.closeState).toBe('closed');
  });

  it('a repeated affirmative after the close does NOT re-run it', async () => {
    const h = await makeHarness();
    await reachClosing(h);
    await turn(h, 'yes book it');
    await turn(h, 'yes that is fine');
    const again = await turn(h, 'yes book it');
    expect(lastTts(again)).toContain("You're all set");
    expect((await h.proposalRepo.findByTenant(TENANT)).filter((p) => p.chainId)).toHaveLength(3);
    expect(h.ownerSmsBodies).toHaveLength(1);
  });
});

describe('WS18d — fallback modes', () => {
  it('pre-gate fail (tenant not opted in): interim line + fallback drafts + ONE owner chain SMS', async () => {
    const h = await makeHarness({ settings: { autonomousCloseEnabled: false } });
    await reachClosing(h);

    const fx = await turn(h, 'yes book it');
    expect(lastTts(fx)).toContain("I'll have the owner finalize");
    expect(h.session.pendingConsentCapture).toBeUndefined();
    expect(h.session.closeState).toBe('fallback');

    // Fallback chain: the estimate draft is now chained to a send_estimate DRAFT.
    const proposals = await h.proposalRepo.findByTenant(TENANT);
    const draft = proposals.find((p) => p.proposalType === 'draft_estimate')!;
    const send = proposals.find((p) => p.proposalType === 'send_estimate')!;
    expect(draft.chainId).toBeDefined();
    expect(send.chainId).toBe(draft.chainId);
    expect(draft.status).toBe('draft');
    expect(send.status).toBe('draft');
    // Ineligible evaluation stamped on the members.
    expect((draft.sourceContext as Record<string, unknown>).autonomousCloseEvaluation).toMatchObject({
      eligible: false,
      reason: 'tenant_not_opted_in',
    });

    // Exactly ONE owner SMS, in the chain form.
    expect(h.ownerSmsBodies).toHaveLength(1);
    expect(h.ownerSmsBodies[0]!.body).toContain('2 linked actions:');

    // Nothing executed.
    expect(h.estimateDelivery.lastDispatch).toBeNull();
  });

  it('consent DECLINE in close mode: decline copy + fallback chain, no consent row', async () => {
    const h = await makeHarness();
    await reachClosing(h);
    await turn(h, 'yes book it');
    // The harness gateway answers "yes" to everything, so the decline turn is
    // driven through a second processor over the SAME store/session whose
    // gateway answers "no" (the pending capture lives on the session).
    const noGateway = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({ answer: 'no', reasoning: 'declined' }),
        model: 'm', provider: 'p', tokenUsage: { input: 1, output: 1, total: 2 }, latencyMs: 1,
      }),
    } as unknown as import('../../../src/ai/gateway/gateway').LLMGateway;
    const decliningProcessor = createVoiceTurnProcessor({
      store: h.store,
      gateway: noGateway,
      businessName: 'Acme Plumbing',
      systemActorId: 'test-actor',
      proposalRepo: h.proposalRepo,
      auditRepo: h.auditRepo,
      appointmentRepo: h.appointmentRepo,
      customerRepo: h.customerRepo,
      consentEventRepo: h.consentEventRepo,
      autonomousClose: {
        executor: { execute: async () => { throw new Error('never'); } },
        ownerPhoneResolver: async () => OWNER_PHONE,
        sendOwnerSms: async (to, body) => { h.ownerSmsBodies.push({ to, body }); },
        oneTapSecret: 'close-secret',
        buildApproveUrl: (t) => `https://x/approve?token=${t}`,
        buildUndoUrl: (t) => `https://x/undo?token=${t}`,
      },
    });
    const fx = await decliningProcessor.speechTurn({
      session: h.session, speechResult: 'no thanks', callSid: 'CA-close', tenantId: TENANT,
    });
    expect(lastTts(fx)).toBe(SMS_CONSENT_DECLINE_FALLBACK);
    expect(h.consentEventRepo.rows).toHaveLength(0);
    expect(h.session.closeState).toBe('fallback');
    const send = (await h.proposalRepo.findByTenant(TENANT)).find((p) => p.proposalType === 'send_estimate');
    expect(send?.status).toBe('draft');
  });

  it('post-consent booking-lane fail: hold released + honest fallback line', async () => {
    const h = await makeHarness({ settings: { autonomousBookingEnabled: false } });
    await reachClosing(h);
    await turn(h, 'yes book it');
    const fx = await turn(h, 'yes that is fine');

    expect(lastTts(fx)).toBe(CLOSE_FALLBACK_LINE);
    expect(h.session.closeState).toBe('fallback');

    // The lane evaluation audit surfaced the composed D-015 failure.
    const evaluated = h.auditRepo.getAll().find(
      (e) => e.eventType === 'agent.calling.autonomous_close_evaluated',
    );
    expect(evaluated).toBeDefined();
    expect(
      (evaluated!.metadata!.evaluation as { eligible: boolean; reason?: string }),
    ).toMatchObject({ eligible: false, reason: 'booking_lane_ineligible' });
    // The fresh hold was released (no phantom 24h calendar block).
    const holds = await h.appointmentRepo.findByJob(TENANT, JOB_ID);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.status).toBe('canceled');
    // Nothing executed; fallback chain queued.
    expect(h.estimateDelivery.lastDispatch).toBeNull();
    const send = (await h.proposalRepo.findByTenant(TENANT)).find((p) => p.proposalType === 'send_estimate');
    expect(send?.status).toBe('draft');
  });

  it('timeout budget: a hung executor leaves members approved and speaks the timeout copy', async () => {
    const h = await makeHarness();
    await reachClosing(h);
    await turn(h, 'yes book it');

    // Swap in a processor (same store/session) whose executor throws — a
    // throw is treated exactly like the budget expiring: members are left
    // approved for the background sweep.
    const failingSettingsRepo = new InMemorySettingsRepository();
    await failingSettingsRepo.create(settingsRow());
    const yesGateway = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({ answer: 'yes', reasoning: 'granted' }),
        model: 'm', provider: 'p', tokenUsage: { input: 1, output: 1, total: 2 }, latencyMs: 1,
      }),
    } as unknown as LLMGateway;
    const hangingProcessor = createVoiceTurnProcessor({
      store: h.store,
      gateway: yesGateway,
      businessName: 'Acme Plumbing',
      systemActorId: 'test-actor',
      proposalRepo: h.proposalRepo,
      auditRepo: h.auditRepo,
      appointmentRepo: h.appointmentRepo,
      jobRepo: h.jobRepo,
      customerRepo: h.customerRepo,
      consentEventRepo: h.consentEventRepo,
      settingsRepo: failingSettingsRepo,
      catalogRepo: stubCatalogRepo(),
      autonomousClose: {
        executor: {
          execute: async () => {
            throw new Error('advisory lock contention');
          },
        },
        ownerPhoneResolver: async () => OWNER_PHONE,
        sendOwnerSms: async (to, body) => { h.ownerSmsBodies.push({ to, body }); },
        oneTapSecret: 'close-secret',
        buildUndoUrl: (t) => `https://x/undo?token=${t}`,
        buildApproveUrl: (t) => `https://x/approve?token=${t}`,
      },
    });
    const fx = await hangingProcessor.speechTurn({
      session: h.session, speechResult: 'yes that is fine', callSid: 'CA-close', tenantId: TENANT,
    });
    expect(lastTts(fx)).toBe(CLOSE_TIMEOUT_COPY);
    // Members stay approved for the background sweep.
    const chain = (await h.proposalRepo.findByTenant(TENANT)).filter((p) => p.chainId);
    expect(chain).toHaveLength(3);
    expect(chain.every((p) => p.status === 'approved')).toBe(true);
    // Owner UNDO SMS still sent on the timeout-partial close.
    expect(h.ownerSmsBodies.some((s) => s.body.includes('undo?token='))).toBe(true);
  });
});
