/**
 * D-015 owner-cell gate on the LIVE-CALL booking path (U3), driven through the
 * real voice-turn processor (`speechTurn`) with a scripted gateway and
 * in-memory repos. An opted-in tenant with no owner cell on file
 * (`tenant_settings.owner_phone`) must never have a caller's booking confirmed
 * autonomously: the caller hears the honest "reserved, the team will confirm"
 * line, the booking lands as a draft, and the lane stamp says why.
 *
 * Value: protects=a live-call booking auto-confirms only with an owner cell AND a wired UNDO channel, and then texts the owner a one-tap UNDO;
 *   fails_when=the live path drops the classifier confidence, the owner_phone or the UNDO wiring check, or skips the UNDO SMS;
 *   why_new=no handler-level test drove the live-call booking lane to a verdict; only the pure helper was covered;
 *   seam=none;
 *   no_claim=SMS delivery and token redemption (mocked sender; the undo route has its own tests)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { configureSupervisorCreationHook } from '../../../src/proposals/supervisor/hook';
import { STIR_VERSTAT_FULL_ATTESTATION } from '../../../src/telephony/stir-attestation';
import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { autonomousLaneEvaluationFor } from '../../../src/proposals/autonomous-lane';
import { InMemoryVoiceSessionRepository } from '../../../src/voice/voice-session';
import { InMemorySettingsRepository } from '../../../src/settings/settings';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import {
  spokenAutonomousBookConfirm,
  spokenBookingPendingOwner,
  timeReadbackFromHold,
} from '../../../src/ai/voice-turn/inbound-booking-completion';
import type { EntityResolver } from '../../../src/ai/resolution/entity-resolver';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-owner-cell-gate';
const TZ = 'America/Chicago';
const CALL_SID = 'CA-owner-cell-gate';
const CALLER_PHONE = '+15125550100';
const CUSTOMER_ID = '22222222-3333-4444-5555-666666666666';
const JOB_ID = '33333333-3333-4333-8333-333333333333';

/** Classifier verdict (0.97, above the tenant's 0.95 lane threshold), then "yes"; repeats per booking. */
function bookingGateway(): LLMGateway {
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
  ];
  let i = 0;
  return {
    complete: vi.fn(async () => ({
      content: contents[i++ % contents.length],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

/** The caller's spoken job resolves to the tenant's one open job. */
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

const OWNER_CELL = '+15125550888';

function undoChannel() {
  return {
    sendSms: vi.fn(async (_to: string, _body: string) => {}),
    secret: 'test-one-tap-secret',
    buildUndoUrl: (token: string) => `https://api.example.com/undo?token=${token}`,
  };
}

const FREE_SLOT = { check: async () => ({ ok: true as const }) };

async function bookOnLiveCall(opts: {
  ownerPhone?: string;
  laneUndo?: ReturnType<typeof undoChannel>;
  /** Defaults to A-attested; pass a verstat (or null) to override. */
  stirVerstat?: string | null;
  /** Defaults to a checker that finds the slot free; null leaves it unwired. */
  slotConflictChecker?: { check: (...args: never[]) => Promise<unknown> } | null;
  language?: 'en' | 'es';
  /** Book the same slot twice on one call. */
  bookTwice?: boolean;
}) {
  const { ownerPhone, laneUndo } = opts;
  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = new InMemoryProposalRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    id: 'settings-owner-cell-gate',
    tenantId: TENANT,
    businessName: 'Rivet HVAC',
    timezone: TZ,
    autonomousBookingEnabled: true,
    autonomousBookingThreshold: 0.95,
    ...(ownerPhone ? { ownerPhone } : {}),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Parameters<InMemorySettingsRepository['create']>[0]);

  // Identified inbound caller at intent_capture (the caller-ID match path).
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
  const verstat = opts.stirVerstat === undefined ? STIR_VERSTAT_FULL_ATTESTATION : opts.stirVerstat;
  if (verstat) session.stirVerstat = verstat;
  if (opts.language) session.language = opts.language;
  const checker = opts.slotConflictChecker === undefined ? FREE_SLOT : opts.slotConflictChecker;

  const processor = createVoiceTurnProcessor({
    store,
    gateway: bookingGateway(),
    businessName: 'Rivet HVAC',
    systemActorId: 'calling-agent',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    voiceSessionRepo: new InMemoryVoiceSessionRepository(),
    settingsRepo,
    appointmentRepo,
    entityResolver: jobResolver,
    ...(laneUndo ? { laneUndo } : {}),
    ...(checker ? { slotConflictChecker: checker as never } : {}),
  });

  let fx: SideEffect[] = [];
  for (let i = 0; i < (opts.bookTwice ? 2 : 1); i++) {
    await processor.speechTurn({
      session,
      speechResult: 'My furnace stopped heating, can someone come Tuesday at 2pm?',
      callSid: CALL_SID,
      tenantId: TENANT,
    });
    fx = await processor.speechTurn({
      session,
      speechResult: 'Yes, that works',
      callSid: CALL_SID,
      tenantId: TENANT,
    });
  }

  const proposals = await proposalRepo.findByTenant(TENANT);
  const spoken = [...fx].reverse().find((e) => e.type === 'tts_play')?.payload.text;
  return { proposals, spoken, appointmentRepo };
}

describe('live-call booking (U3) — D-015 owner-cell gate and owner UNDO', () => {
  afterEach(() => configureSupervisorCreationHook(null));

  it('caller-ID that is not A-attested never books autonomously (no_verified_customer)', async () => {
    const laneUndo = undoChannel();
    const { proposals } = await bookOnLiveCall({
      ownerPhone: OWNER_CELL,
      laneUndo,
      stirVerstat: 'TN-Validation-Passed-B',
    });
    expect(proposals[0]!.status).toBe('draft');
    expect(autonomousLaneEvaluationFor(proposals[0]!)).toEqual({
      eligible: false,
      reason: 'no_verified_customer',
    });
    expect(laneUndo.sendSms).not.toHaveBeenCalled();
  });

  it('a slot the caller is already busy in is never held: a draft for the owner, no SMS', async () => {
    const laneUndo = undoChannel();
    const { proposals } = await bookOnLiveCall({
      ownerPhone: OWNER_CELL,
      laneUndo,
      slotConflictChecker: {
        check: async () => ({ ok: false, conflict: 'customer_busy', appointmentId: 'a-busy' }),
      },
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.proposalType).toBe('create_appointment');
    expect(proposals[0]!.status).toBe('draft');
    expect(laneUndo.sendSms).not.toHaveBeenCalled();
  });

  it('no slot-conflict check wired: the hold waits for review (slot_conflict)', async () => {
    const { proposals } = await bookOnLiveCall({
      ownerPhone: OWNER_CELL,
      laneUndo: undoChannel(),
      slotConflictChecker: null,
    });
    expect(proposals[0]!.status).toBe('draft');
    expect(autonomousLaneEvaluationFor(proposals[0]!)).toEqual({
      eligible: false,
      reason: 'slot_conflict',
    });
  });

  it('a Spanish-language call never hears the English "you\'re booked" commitment (language_unsupported)', async () => {
    const { proposals } = await bookOnLiveCall({
      ownerPhone: OWNER_CELL,
      laneUndo: undoChannel(),
      language: 'es',
    });
    expect(proposals[0]!.status).toBe('draft');
    expect(autonomousLaneEvaluationFor(proposals[0]!)).toEqual({
      eligible: false,
      reason: 'language_unsupported',
    });
  });

  // Value: protects=a caller never hears "You're booked" for a booking the supervisor held for review, and the owner gets no UNDO for it;
  //   fails_when=the spoken line keys on the lane verdict alone, or the UNDO send drops the stored.status === 'approved' guard;
  //   why_new=live tests only reached approved or lane-ineligible bookings; seam=none (the production hook installer);
  //   no_claim=the supervisor's own cap counting
  it('a lane-eligible booking the supervisor holds for review: honest pending line, no UNDO text', async () => {
    configureSupervisorCreationHook({
      evaluate: () => ({ verdict: 'force_review', reasons: ['hourly auto-approvals budget exhausted'] }),
      onAutoApproved() {},
      onDecision() {},
    });
    const laneUndo = undoChannel();
    const { proposals, spoken, appointmentRepo } = await bookOnLiveCall({
      ownerPhone: OWNER_CELL,
      laneUndo,
    });
    const booking = proposals[0]!;
    expect(autonomousLaneEvaluationFor(booking)).toEqual({ eligible: true, threshold: 0.95 });
    expect(booking.status).not.toBe('approved');
    const hold = await appointmentRepo.findById(TENANT, booking.payload.appointmentId as string);
    expect(spoken).toBe(
      spokenBookingPendingOwner(timeReadbackFromHold(hold!.scheduledStart.toISOString(), TZ)),
    );
    expect(laneUndo.sendSms).not.toHaveBeenCalled();
  });

  it('booking the same slot twice on one call auto-approves it once and texts the owner once', async () => {
    const laneUndo = undoChannel();
    const { proposals } = await bookOnLiveCall({ ownerPhone: OWNER_CELL, laneUndo, bookTwice: true });
    expect(proposals).toHaveLength(2);
    expect(proposals.map((p) => p.status)).toEqual(['approved', 'draft']);
    expect(autonomousLaneEvaluationFor(proposals[1]!)).toEqual({
      eligible: false,
      reason: 'duplicate_booking',
    });
    expect(laneUndo.sendSms).toHaveBeenCalledTimes(1);
  });

  it('opted-in tenant with NO owner cell: draft booking, honest "team will confirm" line, owner_cell_missing, no SMS', async () => {
    const laneUndo = undoChannel();
    const { proposals, spoken, appointmentRepo } = await bookOnLiveCall({ laneUndo });

    expect(proposals).toHaveLength(1);
    const booking = proposals[0]!;
    expect(booking.proposalType).toBe('create_booking');
    expect(booking.status).toBe('draft');
    expect(autonomousLaneEvaluationFor(booking)).toEqual({
      eligible: false,
      reason: 'owner_cell_missing',
    });

    // The held slot is real, and the caller is told it awaits the team —
    // never "you're booked".
    const hold = await appointmentRepo.findById(TENANT, booking.payload.appointmentId as string);
    expect(hold?.holdPendingApproval).toBe(true);
    expect(spoken).toBe(
      spokenBookingPendingOwner(timeReadbackFromHold(hold!.scheduledStart.toISOString(), TZ)),
    );
    expect(laneUndo.sendSms).not.toHaveBeenCalled();
  });

  it('owner cell AND a wired UNDO channel: the booking auto-confirms, the caller hears "You\'re booked", the owner gets one UNDO text', async () => {
    const laneUndo = undoChannel();
    const { proposals, spoken, appointmentRepo } = await bookOnLiveCall({
      ownerPhone: OWNER_CELL,
      laneUndo,
    });

    expect(proposals).toHaveLength(1);
    const booking = proposals[0]!;
    expect(autonomousLaneEvaluationFor(booking)).toEqual({ eligible: true, threshold: 0.95 });
    expect(booking.status).toBe('approved');
    const hold = await appointmentRepo.findById(TENANT, booking.payload.appointmentId as string);
    expect(spoken).toBe(
      spokenAutonomousBookConfirm(timeReadbackFromHold(hold!.scheduledStart.toISOString(), TZ)),
    );
    expect(laneUndo.sendSms).toHaveBeenCalledTimes(1);
    expect(laneUndo.sendSms).toHaveBeenCalledWith(OWNER_CELL, expect.stringContaining('Tap to UNDO'));
  });

  it('owner cell but NO UNDO channel wired: draft booking, undo_channel_unavailable, honest line', async () => {
    const { proposals, spoken, appointmentRepo } = await bookOnLiveCall({ ownerPhone: OWNER_CELL });

    expect(proposals).toHaveLength(1);
    const booking = proposals[0]!;
    expect(booking.status).toBe('draft');
    expect(autonomousLaneEvaluationFor(booking)).toEqual({
      eligible: false,
      reason: 'undo_channel_unavailable',
    });
    const hold = await appointmentRepo.findById(TENANT, booking.payload.appointmentId as string);
    expect(spoken).toBe(
      spokenBookingPendingOwner(timeReadbackFromHold(hold!.scheduledStart.toISOString(), TZ)),
    );
  });
});
