/**
 * QUALITY-2026-07-12 WS2 — on-call close PREPARATION through the REAL FSM +
 * voice-turn processor over in-memory repos (supersedes the D-018 autonomous
 * close). The human-authority invariants under test:
 *
 *  - eligible close: affirmative → strict confirm → consent ask → grant → hold
 *    placed → a DRAFT owner-approval chain (draft_estimate → send_estimate →
 *    create_booking) is STAGED; NOTHING is approved or executed by the system;
 *    the owner gets ONE one-tap approval SMS; the honest CLOSE_FALLBACK_LINE is
 *    spoken (never "you're booked"). No `proposal.system_approved` audit, no
 *    backdated approvedAt.
 *  - owner one-tap approve (approveChainSet) then approves the capture-class
 *    head + booking with approvedAt ≈ now — the D-009 undo window is honored.
 *  - repeated affirmative after staging: the interim line, no re-stage.
 *  - pre-gate fail (tenant not opted in): interim line + two-member chain + ONE
 *    owner SMS; nothing approved.
 *  - consent decline: decline copy + two-member chain.
 *  - post-consent lane fail (booking lane off): hold released + honest line +
 *    two-member chain (no booking member).
 */
import { describe, it, expect, vi } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import {
  SMS_CONSENT_ASK,
  SMS_CONSENT_DECLINE_FALLBACK,
  CLOSE_FALLBACK_LINE,
} from '../../../src/ai/voice-turn/create-voice-turn-processor';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { approveChainSet } from '../../../src/proposals/actions';
import { isInUndoWindow } from '../../../src/proposals/lifecycle';
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
  const ownerSmsBodies: Array<{ to: string; body: string }> = [];

  await settingsRepo.create(settingsRow(opts.settings));
  await customerRepo.create(customerRow());
  await jobRepo.create(jobRow());

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
      platformDisabled: false,
      bookingPlatformDisabled: false,
      ownerPhoneResolver: async () => (opts.ownerSms === false ? null : OWNER_PHONE),
      sendOwnerSms: async (to, body) => {
        ownerSmsBodies.push({ to, body });
      },
      oneTapSecret: 'close-secret',
      buildApproveUrl: (token) => `https://x/approve?token=${token}`,
    },
  });

  return {
    store, proposalRepo, auditRepo, appointmentRepo, estimateRepo, jobRepo,
    consentEventRepo, customerRepo, session, processor, ownerSmsBodies,
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

describe('WS2 — on-call close staged for owner approval', () => {
  it('stages a DRAFT owner chain (incl. the held booking) — nothing is approved or executed', async () => {
    const h = await makeHarness();
    await reachClosing(h);

    // Affirmative → strict confirm passes → consent ask.
    const askFx = await turn(h, 'yes book it');
    expect(lastTts(askFx)).toBe(SMS_CONSENT_ASK);
    expect(h.session.pendingConsentCapture?.close).toBeDefined();

    // Grant → consent recorded, hold placed, owner chain STAGED (drafts only).
    const closeFx = await turn(h, 'yes that is fine');

    // Consent: ledger row + sms_consent flipped.
    expect(h.consentEventRepo.rows).toHaveLength(1);
    expect(h.consentEventRepo.rows[0]).toMatchObject({ kind: 'sms', state: 'granted', source: 'voice' });
    expect((await h.customerRepo.findById(TENANT, CUSTOMER_ID))!.smsConsent).toBe(true);

    // Chain: three members, ALL still draft/blocked — nothing approved/executed.
    const proposals = await h.proposalRepo.findByTenant(TENANT);
    const chain = proposals.filter((p) => p.chainId);
    expect(chain).toHaveLength(3);
    const byType = Object.fromEntries(chain.map((p) => [p.proposalType, p]));
    expect(byType.draft_estimate!.status).toBe('draft');
    expect(byType.send_estimate!.status).toBe('draft');
    expect(byType.create_booking!.status).toBe('draft');
    // The human-authority invariant: nothing reached approved/executed, and
    // nothing carries a (backdated or otherwise) approvedAt.
    expect(chain.every((p) => p.status === 'draft')).toBe(true);
    expect(chain.every((p) => p.approvedAt === undefined)).toBe(true);
    // draft_estimate never executed → no estimate entity was created.
    expect(byType.draft_estimate!.resultEntityId).toBeUndefined();

    // The held booking carries the concrete appointmentId (the hold was kept).
    const heldApptId = byType.create_booking!.payload.appointmentId as string;
    const appt = await h.appointmentRepo.findById(TENANT, heldApptId);
    expect(appt!.holdPendingApproval).toBe(true);

    // Owner got exactly ONE one-tap approval chain SMS (never a UNDO SMS).
    expect(h.ownerSmsBodies).toHaveLength(1);
    expect(h.ownerSmsBodies[0]!.to).toBe(OWNER_PHONE);
    expect(h.ownerSmsBodies[0]!.body).toContain('3 linked actions:');
    expect(h.ownerSmsBodies[0]!.body).toContain('https://x/approve?token=');
    expect(h.ownerSmsBodies[0]!.body.toLowerCase()).not.toContain('undo');

    // No system-approval audit event was ever emitted.
    expect(h.auditRepo.getAll().some((e) => e.eventType === 'proposal.system_approved')).toBe(false);

    // Honest copy — never claims the caller is booked.
    expect(lastTts(closeFx)).toBe(CLOSE_FALLBACK_LINE);
    expect(h.session.closeState).toBe('fallback');
  });

  it('owner one-tap approve then approves the capture-class head + booking — undo window honored, no backdating', async () => {
    const h = await makeHarness();
    await reachClosing(h);
    await turn(h, 'yes book it');
    await turn(h, 'yes that is fine');

    const chain = (await h.proposalRepo.findByTenant(TENANT)).filter((p) => p.chainId);
    const head = chain.find((p) => p.proposalType === 'draft_estimate')!;

    const before = Date.now();
    const result = await approveChainSet(
      h.proposalRepo, TENANT, head.id, 'owner-user', 'owner', h.auditRepo, 'one_tap',
    );
    const after = Date.now();

    // The capture-class head + booking are approved; the comms send follows separately.
    const approvedTypes = result.approved.map((p) => p.proposalType).sort();
    expect(approvedTypes).toEqual(['create_booking', 'draft_estimate']);
    expect(result.skipped.some((s) => s.reason === 'non_capture')).toBe(true);

    for (const p of result.approved) {
      expect(p.status).toBe('approved');
      // approvedAt is stamped at NOW (never backdated past the undo window).
      expect(p.approvedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(p.approvedAt!.getTime()).toBeLessThanOrEqual(after);
      expect(isInUndoWindow(p, Date.now())).toBe(true);
    }
  });

  it('a repeated affirmative after staging does NOT re-stage or re-text', async () => {
    const h = await makeHarness();
    await reachClosing(h);
    await turn(h, 'yes book it');
    await turn(h, 'yes that is fine');
    const again = await turn(h, 'yes book it');
    expect(lastTts(again)).toContain("I'll have the owner finalize");
    expect((await h.proposalRepo.findByTenant(TENANT)).filter((p) => p.chainId)).toHaveLength(3);
    expect(h.ownerSmsBodies).toHaveLength(1);
  });
});

describe('WS2 — fallback modes (no held booking staged)', () => {
  it('pre-gate fail (tenant not opted in): interim line + two-member chain + ONE owner SMS', async () => {
    const h = await makeHarness({ settings: { autonomousCloseEnabled: false } });
    await reachClosing(h);

    const fx = await turn(h, 'yes book it');
    expect(lastTts(fx)).toContain("I'll have the owner finalize");
    expect(h.session.pendingConsentCapture).toBeUndefined();
    expect(h.session.closeState).toBe('fallback');

    const proposals = await h.proposalRepo.findByTenant(TENANT);
    const chain = proposals.filter((p) => p.chainId);
    expect(chain).toHaveLength(2);
    const draft = chain.find((p) => p.proposalType === 'draft_estimate')!;
    const send = chain.find((p) => p.proposalType === 'send_estimate')!;
    expect(chain.find((p) => p.proposalType === 'create_booking')).toBeUndefined();
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
  });

  it('consent DECLINE in close mode: decline copy + two-member chain, no consent row', async () => {
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
        ownerPhoneResolver: async () => OWNER_PHONE,
        sendOwnerSms: async (to, body) => { h.ownerSmsBodies.push({ to, body }); },
        oneTapSecret: 'close-secret',
        buildApproveUrl: (t) => `https://x/approve?token=${t}`,
      },
    });
    const fx = await decliningProcessor.speechTurn({
      session: h.session, speechResult: 'no thanks', callSid: 'CA-close', tenantId: TENANT,
    });
    expect(lastTts(fx)).toBe(SMS_CONSENT_DECLINE_FALLBACK);
    expect(h.consentEventRepo.rows).toHaveLength(0);
    expect(h.session.closeState).toBe('fallback');
    const chain = (await h.proposalRepo.findByTenant(TENANT)).filter((p) => p.chainId);
    expect(chain).toHaveLength(2);
    expect(chain.every((p) => p.status === 'draft')).toBe(true);
  });

  it('post-consent booking-lane fail: hold released + honest line + two-member chain', async () => {
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
    // Two-member owner chain queued (no booking member), nothing approved.
    const chain = (await h.proposalRepo.findByTenant(TENANT)).filter((p) => p.chainId);
    expect(chain).toHaveLength(2);
    expect(chain.find((p) => p.proposalType === 'create_booking')).toBeUndefined();
    expect(chain.every((p) => p.status === 'draft')).toBe(true);
  });
});
