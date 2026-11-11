/**
 * On-call booking confirmation vs SMS consent, driven through the real
 * voice-turn processor (`speechTurn`) with a scripted gateway and in-memory
 * repos.
 *
 * The autonomous-lane confirm line promises "I'll text you a confirmation",
 * but the customer-SMS gate (block mode) suppresses that text for a caller with
 * no `sms_consent`. So a caller with no consent on file is ASKED first (the
 * existing `pendingConsentCapture` + strict `confirmIntent` mechanism); the
 * promise is spoken only after a recorded yes. A caller who already consented
 * hears the unchanged line with no extra turn; everyone else hears
 * "You're booked for {time}." with no text promise.
 *
 * Value: protects=a caller is never promised a confirmation text that the SMS consent gate will suppress, and a consent-capture failure never blocks or undoes the booking;
 *   fails_when=the confirm line is spoken without a consent check, the answer is not consumed through recordSmsConsentFromVoice, an already-consented caller is asked again, or a capture error escapes the turn;
 *   why_new=the on-call SMS consent ask lived only in the quote-and-close flow, so an ordinary booking promised a text production then suppressed;
 *   seam=none;
 *   no_claim=SMS delivery and the gate itself (booking-confirmation-voice-consent-gate.test.ts), the owner UNDO text
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const recordSpy = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../../src/voice/outbound-consent', async (orig) => {
  const real = await orig<typeof import('../../../src/voice/outbound-consent')>();
  recordSpy.fn.mockImplementation(real.recordSmsConsentFromVoice);
  return {
    ...real,
    recordSmsConsentFromVoice: (...args: Parameters<typeof real.recordSmsConsentFromVoice>) =>
      recordSpy.fn(...args),
  };
});

const logSpy = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../src/logging/logger', async (orig) => {
  const real = await orig<typeof import('../../../src/logging/logger')>();
  return {
    ...real,
    createLogger: (opts: Parameters<typeof real.createLogger>[0]) => {
      const l = real.createLogger(opts);
      return {
        ...l,
        warn: (...a: unknown[]) => {
          logSpy.warn(...a);
          (l.warn as (...x: unknown[]) => void)(...a);
        },
        error: (...a: unknown[]) => {
          logSpy.error(...a);
          (l.error as (...x: unknown[]) => void)(...a);
        },
      };
    },
  };
});

import { configureSupervisorCreationHook } from '../../../src/proposals/supervisor/hook';
import { STIR_VERSTAT_FULL_ATTESTATION } from '../../../src/telephony/stir-attestation';
import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryVoiceSessionRepository } from '../../../src/voice/voice-session';
import { InMemorySettingsRepository } from '../../../src/settings/settings';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import { InMemoryCustomerRepository, type Customer } from '../../../src/customers/customer';
import { InMemoryConsentEventRepository } from '../../../src/compliance/consent-events';
import { InMemoryDncRepository, normalizePhone } from '../../../src/compliance/dnc';
import {
  spokenAutonomousBookConfirm,
  timeReadbackFromHold,
} from '../../../src/ai/voice-turn/inbound-booking-completion';
import type { EntityResolver } from '../../../src/ai/resolution/entity-resolver';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';
import type { CoverageSurface } from '../../../src/ai/voice-turn/coverage-table';

const TENANT = 'tenant-booking-sms-consent';
const TZ = 'America/Chicago';
const CALL_SID = 'CA-booking-sms-consent';
const CALLER_PHONE = '+15125550100';
const CUSTOMER_ID = '22222222-3333-4444-5555-666666666666';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_CELL = '+15125550888';

const ASK = "Okay to text your confirmation to the number you're calling from?";

/** classify (0.97) → readback "yes" → then one scripted consent answer per entry. */
function scriptedGateway(consentAnswers: string[]): LLMGateway {
  const contents = [
    JSON.stringify({
      intentType: 'create_appointment',
      confidence: 0.97,
      reasoning: 'caller wants a furnace repair visit',
      extractedEntities: {
        jobReference: 'furnace not heating',
        dateTimeDescription: 'Tuesday at 2pm',
      },
    }),
    JSON.stringify({ answer: 'yes', reasoning: 'caller confirmed the readback' }),
    ...consentAnswers,
  ];
  let i = 0;
  return {
    complete: vi.fn(async () => ({
      content: contents[Math.min(i++, contents.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

const yes = JSON.stringify({ answer: 'yes', reasoning: 'caller agreed' });
const no = JSON.stringify({ answer: 'no', reasoning: 'caller declined' });

const jobResolver: EntityResolver = {
  async resolve({ kind }) {
    if (kind === 'job') {
      return {
        kind: 'resolved',
        candidate: { id: JOB_ID, kind: 'job', label: 'Furnace not heating', score: 1 },
      };
    }
    return { kind: 'skipped' };
  },
};

function customerRow(smsConsent: boolean): Customer {
  return {
    id: CUSTOMER_ID,
    tenantId: TENANT,
    firstName: 'Dana',
    lastName: 'Lee',
    displayName: 'Dana Lee',
    primaryPhone: CALLER_PHONE,
    smsConsent,
    preferredChannel: 'sms',
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Customer;
}

async function bookOnLiveCall(opts: {
  /** The customer's stored `sms_consent`. */
  smsConsent: boolean;
  /** One scripted confirmIntent answer per consent turn. */
  consentAnswers?: string[];
  onDnc?: boolean;
  coverageSurface?: CoverageSurface;
  language?: 'en' | 'es';
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = new InMemoryProposalRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const consentEventRepo = new InMemoryConsentEventRepository();
  const dncRepo = new InMemoryDncRepository();
  if (opts.onDnc) dncRepo.add(TENANT, normalizePhone(CALLER_PHONE));
  await customerRepo.create(customerRow(opts.smsConsent));
  await settingsRepo.create({
    id: 'settings-booking-sms-consent',
    tenantId: TENANT,
    businessName: 'Rivet HVAC',
    timezone: TZ,
    autonomousBookingEnabled: true,
    autonomousBookingThreshold: 0.95,
    ownerPhone: OWNER_CELL,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Parameters<InMemorySettingsRepository['create']>[0]);

  const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
  session.machine.dispatch({
    type: 'incoming_call',
    callSid: CALL_SID,
    from: CALLER_PHONE,
    to: '+15125550999',
    tenantId: TENANT,
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: CUSTOMER_ID });
  session.customerId = CUSTOMER_ID;
  session.callerPhone = CALLER_PHONE;
  session.stirVerstat = STIR_VERSTAT_FULL_ATTESTATION;
  if (opts.language) session.language = opts.language;

  const gateway = scriptedGateway(opts.consentAnswers ?? []);
  const processor = createVoiceTurnProcessor({
    store,
    gateway,
    businessName: 'Rivet HVAC',
    systemActorId: 'calling-agent',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    voiceSessionRepo: new InMemoryVoiceSessionRepository(),
    settingsRepo,
    appointmentRepo,
    entityResolver: jobResolver,
    customerRepo,
    consentEventRepo,
    dncRepo,
    laneUndo: {
      sendSms: vi.fn(async () => {}),
      secret: 'test-one-tap-secret',
      buildUndoUrl: (token: string) => `https://api.example.com/undo?token=${token}`,
      canDeliver: () => true,
    },
    slotConflictChecker: { check: async () => ({ ok: true as const }) } as never,
    ...(opts.coverageSurface ? { coverageSurface: opts.coverageSurface } : {}),
  });

  const say = (speechResult: string): Promise<SideEffect[]> =>
    processor.speechTurn({ session, speechResult, callSid: CALL_SID, tenantId: TENANT });

  await say('My furnace stopped heating, can someone come Tuesday at 2pm?');
  const bookingFx = await say('Yes, that works');

  const proposals = await proposalRepo.findByTenant(TENANT);
  const booking = proposals.find((p) => p.proposalType === 'create_booking')!;
  const hold = await appointmentRepo.findById(TENANT, booking.payload.appointmentId as string);
  const when = timeReadbackFromHold(hold!.scheduledStart.toISOString(), TZ);

  return {
    session,
    say,
    processor,
    gateway,
    bookingFx,
    booking,
    hold,
    when,
    proposalRepo,
    appointmentRepo,
    customerRepo,
    consentEventRepo,
  };
}

const spokenOf = (fx: SideEffect[]): string | undefined =>
  [...fx].reverse().find((e) => e.type === 'tts_play')?.payload.text as string | undefined;

describe('on-call booking confirmation — SMS consent before the text promise', () => {
  beforeEach(() => {
    recordSpy.fn.mockClear();
    logSpy.warn.mockClear();
    logSpy.error.mockClear();
  });
  afterEach(() => configureSupervisorCreationHook(null));

  it('no consent + yes: asks first, then records the grant once and promises the text', async () => {
    const h = await bookOnLiveCall({ smsConsent: false, consentAnswers: [yes] });

    // The booking turn asks; it neither promises a text nor writes consent yet.
    expect(spokenOf(h.bookingFx)).toBe(ASK);
    expect(h.booking.status).toBe('approved');
    expect(h.session.pendingConsentCapture).toMatchObject({
      customerId: CUSTOMER_ID,
      phone: CALLER_PHONE,
    });
    expect(recordSpy.fn).not.toHaveBeenCalled();
    expect(h.consentEventRepo.rows).toHaveLength(0);

    const answerFx = await h.say('Yes, that is fine');

    expect(recordSpy.fn).toHaveBeenCalledTimes(1);
    expect(recordSpy.fn.mock.calls[0]![1]).toMatchObject({
      tenantId: TENANT,
      customerId: CUSTOMER_ID,
      phone: CALLER_PHONE,
      voiceSessionId: h.session.id,
    });
    expect(h.consentEventRepo.rows).toHaveLength(1);
    expect(h.consentEventRepo.rows[0]).toMatchObject({
      kind: 'sms',
      state: 'granted',
      source: 'voice',
      voiceSessionId: h.session.id,
    });
    expect((await h.customerRepo.findById(TENANT, CUSTOMER_ID))!.smsConsent).toBe(true);
    expect(spokenOf(answerFx)).toBe(spokenAutonomousBookConfirm(h.when));
    expect(h.session.pendingConsentCapture).toBeUndefined();
  });

  it.each([
    ['an explicit no', no],
    ['an unparseable answer', 'not json at all'],
  ])('no consent + %s: no consent write, booked line without a text promise', async (_label, answer) => {
    const h = await bookOnLiveCall({ smsConsent: false, consentAnswers: [answer] });
    expect(spokenOf(h.bookingFx)).toBe(ASK);

    const answerFx = await h.say('No thanks');

    expect(recordSpy.fn).not.toHaveBeenCalled();
    expect(h.consentEventRepo.rows).toHaveLength(0);
    expect((await h.customerRepo.findById(TENANT, CUSTOMER_ID))!.smsConsent).toBe(false);
    const line = spokenOf(answerFx);
    expect(line).toBe(`You're booked for ${h.when}.`);
    expect(line).not.toMatch(/text/i);
    // The booking itself is untouched by the answer.
    const proposals = await h.proposalRepo.findByTenant(TENANT);
    expect(proposals.find((p) => p.id === h.booking.id)!.status).toBe('approved');
    expect(h.session.pendingConsentCapture).toBeUndefined();
  });

  it('no consent + silence on the question: treated as no — booked line, no text promise, no write', async () => {
    const h = await bookOnLiveCall({ smsConsent: false, consentAnswers: [no] });
    expect(spokenOf(h.bookingFx)).toBe(ASK);

    const silenceFx = await h.processor.handlePendingConsentCapture(h.session, '', TENANT);

    expect(recordSpy.fn).not.toHaveBeenCalled();
    expect(spokenOf(silenceFx ?? [])).toBe(`You're booked for ${h.when}.`);
  });

  it('already consented: no question, no extra turn, the current line unchanged', async () => {
    const h = await bookOnLiveCall({ smsConsent: true });

    expect(spokenOf(h.bookingFx)).toBe(spokenAutonomousBookConfirm(h.when));
    expect(h.session.pendingConsentCapture).toBeUndefined();
    // classify + readback confirm only — no consent confirmIntent call.
    expect((h.gateway.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(recordSpy.fn).not.toHaveBeenCalled();
    expect(h.consentEventRepo.rows).toHaveLength(0);
    expect(h.booking.status).toBe('approved');
  });

  it('capture failure: the booking stands, the no-promise line is spoken, the error is logged', async () => {
    const h = await bookOnLiveCall({ smsConsent: false, consentAnswers: [yes] });
    expect(spokenOf(h.bookingFx)).toBe(ASK);
    recordSpy.fn.mockRejectedValueOnce(new Error('ledger down'));

    const answerFx = await h.say('Yes, that is fine');

    expect(recordSpy.fn).toHaveBeenCalledTimes(1);
    const line = spokenOf(answerFx);
    expect(line).toBe(`You're booked for ${h.when}.`);
    expect(line).not.toMatch(/text/i);
    // Booking, hold and proposal are exactly as they were before the answer.
    const proposals = await h.proposalRepo.findByTenant(TENANT);
    expect(proposals.find((p) => p.id === h.booking.id)!.status).toBe('approved');
    expect((await h.appointmentRepo.findById(TENANT, h.hold!.id))!.status).not.toBe('canceled');
    expect(h.consentEventRepo.rows).toHaveLength(0);
    const logged = [...logSpy.warn.mock.calls, ...logSpy.error.mock.calls].some(([message]) =>
      /recordSmsConsentFromVoice/.test(String(message)),
    );
    expect(logged).toBe(true);
  });

  it('caller on the DNC list: no question and no text promise', async () => {
    const h = await bookOnLiveCall({ smsConsent: false, onDnc: true });

    expect(spokenOf(h.bookingFx)).toBe(`You're booked for ${h.when}.`);
    expect(h.session.pendingConsentCapture).toBeUndefined();
    expect((h.gateway.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(h.booking.status).toBe('approved');
  });

  it('a transport that never consumes the consent answer (Gather) is not asked: no promise, nothing left pending', async () => {
    const h = await bookOnLiveCall({ smsConsent: false, coverageSurface: 'gather' });

    expect(spokenOf(h.bookingFx)).toBe(`You're booked for ${h.when}.`);
    expect(h.session.pendingConsentCapture).toBeUndefined();
    expect(h.booking.status).toBe('approved');
  });
});
