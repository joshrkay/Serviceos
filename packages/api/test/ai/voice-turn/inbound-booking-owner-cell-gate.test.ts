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
import {
  VoiceSessionStore,
  type VoiceSession,
} from '../../../src/ai/agents/customer-calling/voice-session-store';
import { DefaultSlotConflictChecker } from '../../../src/ai/tasks/slot-conflict-checker';
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

/**
 * Classifier verdict (0.97, above the tenant's 0.95 lane threshold), then "yes"; repeats per booking.
 * `fallbackStage` marks every response as served by a failover stage.
 */
function bookingGateway(opts: { fallbackStage?: string } = {}): LLMGateway {
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
      ...(opts.fallbackStage ? { degraded: true, fallbackStage: opts.fallbackStage } : {}),
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

function undoChannel(opts: { canDeliver?: boolean } = {}) {
  return {
    sendSms: vi.fn(async (_to: string, _body: string) => {}),
    secret: 'test-one-tap-secret',
    buildUndoUrl: (token: string) => `https://api.example.com/undo?token=${token}`,
    canDeliver: () => opts.canDeliver ?? true,
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
  /** Use the production P0-035 checker over this call's repos instead of a stub. */
  realConflictChecker?: boolean;
  /** Adjust the identified session before the booking turns. */
  mutateSession?: (session: VoiceSession) => void;
  /** Serve the classifier from a failover stage. */
  fallbackStage?: string;
  /** The caller's customer record (display name for the owner's UNDO text). */
  customerDisplayName?: string;
}) {
  const { ownerPhone, laneUndo } = opts;
  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
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
  opts.mutateSession?.(session);
  const checker = opts.realConflictChecker
    ? new DefaultSlotConflictChecker({
        appointmentRepo,
        assignmentRepo: { findByAppointment: async () => [] } as never,
        jobRepo: {
          findById: async (_t: string, id: string) =>
            id === JOB_ID ? ({ id: JOB_ID, customerId: CUSTOMER_ID } as never) : null,
        } as never,
      })
    : opts.slotConflictChecker === undefined
      ? FREE_SLOT
      : opts.slotConflictChecker;

  const processor = createVoiceTurnProcessor({
    store,
    gateway: bookingGateway(opts.fallbackStage ? { fallbackStage: opts.fallbackStage } : {}),
    businessName: 'Rivet HVAC',
    systemActorId: 'calling-agent',
    auditRepo,
    proposalRepo,
    voiceSessionRepo: new InMemoryVoiceSessionRepository(),
    settingsRepo,
    appointmentRepo,
    entityResolver: jobResolver,
    ...(laneUndo ? { laneUndo } : {}),
    ...(checker ? { slotConflictChecker: checker as never } : {}),
    ...(opts.customerDisplayName
      ? {
          customerRepo: {
            findById: async (_t: string, id: string) =>
              id === CUSTOMER_ID ? ({ id, displayName: opts.customerDisplayName } as never) : null,
          } as never,
        }
      : {}),
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
  return { proposals, spoken, appointmentRepo, auditRepo };
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

  it('no slot-conflict check wired: the hold waits for review (conflict_check_unavailable)', async () => {
    const { proposals } = await bookOnLiveCall({
      ownerPhone: OWNER_CELL,
      laneUndo: undoChannel(),
      slotConflictChecker: null,
    });
    expect(proposals[0]!.status).toBe('draft');
    expect(autonomousLaneEvaluationFor(proposals[0]!)).toEqual({
      eligible: false,
      reason: 'conflict_check_unavailable',
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

  // Value: protects=booking the same slot twice on one call auto-approves it once and texts the owner once;
  //   fails_when=the conflict check stops seeing the call's own first hold, or the live path skips it;
  //   why_new=the first version pinned a duplicate guard the real checker made unreachable; seam=none;
  //   no_claim=technician conflicts (the live path passes no technician)
  it('booking the same slot twice on one call auto-approves it once and texts the owner once', async () => {
    const laneUndo = undoChannel();
    const { proposals } = await bookOnLiveCall({
      ownerPhone: OWNER_CELL,
      laneUndo,
      bookTwice: true,
      realConflictChecker: true,
    });
    expect(proposals).toHaveLength(2);
    expect(proposals[0]!.status).toBe('approved');
    // The second hold is refused as the customer's own busy slot: a draft
    // with no lane verdict, never a second auto-approval.
    expect(proposals[1]!.proposalType).toBe('create_appointment');
    expect(proposals[1]!.status).toBe('draft');
    expect(autonomousLaneEvaluationFor(proposals[1]!)).toBeUndefined();
    await vi.waitFor(() => expect(laneUndo.sendSms).toHaveBeenCalledTimes(1));
  });

  // Value: protects=only a caller-ID identity nobody can fake on this call takes the lane;
  //   fails_when=the live path drops the callerCreatedThisCall, rejected-identity or session-match check;
  //   why_new=only the attestation check was tested; seam=none; no_claim=how the identity check decides
  it.each([
    ['the customer was created on this call', (s: VoiceSession) => { s.callerCreatedThisCall = true; }],
    ['the identity check rejected the caller', (s: VoiceSession) => { s.callerIdentity = 'rejected'; }],
    [
      "the booking's customer is not the caller-ID match",
      (s: VoiceSession) => { s.customerId = '99999999-3333-4444-5555-666666666666'; },
    ],
  ])('%s: never books autonomously (no_verified_customer)', async (_name, mutateSession) => {
    const laneUndo = undoChannel();
    const { proposals } = await bookOnLiveCall({ ownerPhone: OWNER_CELL, laneUndo, mutateSession });
    const booking = proposals.find((p) => p.proposalType === 'create_booking')!;
    expect(booking.status).toBe('draft');
    expect(autonomousLaneEvaluationFor(booking)).toEqual({
      eligible: false,
      reason: 'no_verified_customer',
    });
    expect(laneUndo.sendSms).not.toHaveBeenCalled();
  });

  // Value: protects=the lane trusts only the primary model's confidence;
  //   fails_when=the live path accepts any confidence source but 'model' (a failover model's self-score);
  //   why_new=live tests only fed primary-model turns; seam=none; no_claim=which failover stages exist
  it('a booking classified by a failover model never auto-approves (below_threshold)', async () => {
    const laneUndo = undoChannel();
    const { proposals } = await bookOnLiveCall({
      ownerPhone: OWNER_CELL,
      laneUndo,
      fallbackStage: 'cheaper-model',
    });
    expect(proposals[0]!.status).toBe('draft');
    expect(autonomousLaneEvaluationFor(proposals[0]!)).toEqual({
      eligible: false,
      reason: 'below_threshold',
    });
    expect(laneUndo.sendSms).not.toHaveBeenCalled();
  });

  // Value: protects=a session the injection guard flagged never auto-books on its model confidence;
  //   fails_when=the live path stops passing injectionFlagged into the lane flags;
  //   why_new=red-team pass 3: the lane ignored the injection flag; seam=none; no_claim=the injection scan itself
  it('a prompt-injection-flagged session never auto-approves (session_flagged)', async () => {
    const laneUndo = undoChannel();
    const { proposals } = await bookOnLiveCall({
      ownerPhone: OWNER_CELL,
      laneUndo,
      mutateSession: (s) => {
        (s.machine.currentContext as { injectionFlagged?: boolean }).injectionFlagged = true;
      },
    });
    expect(proposals[0]!.status).toBe('draft');
    expect(autonomousLaneEvaluationFor(proposals[0]!)).toEqual({
      eligible: false,
      reason: 'session_flagged',
    });
    expect(laneUndo.sendSms).not.toHaveBeenCalled();
  });

  // Value: protects=the lane stops auto-approving while the outbound SMS kill switch silences the owner's UNDO;
  //   fails_when=the live path checks only that the channel is wired, not that it can deliver now;
  //   why_new=red-team pass 3 reproduced auto-approval with TELEPHONY_ENABLED=false; seam=none;
  //   no_claim=the kill switch's own suppression
  it('UNDO channel wired but the SMS kill switch is off: draft, undo_channel_unavailable, no SMS', async () => {
    const laneUndo = undoChannel({ canDeliver: false });
    const { proposals } = await bookOnLiveCall({ ownerPhone: OWNER_CELL, laneUndo });
    expect(proposals[0]!.status).toBe('draft');
    expect(autonomousLaneEvaluationFor(proposals[0]!)).toEqual({
      eligible: false,
      reason: 'undo_channel_unavailable',
    });
    expect(laneUndo.sendSms).not.toHaveBeenCalled();
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

  it('owner cell AND a wired UNDO channel: the booking auto-confirms, the caller hears "You\'re booked", the owner gets one UNDO text, both audited', async () => {
    const laneUndo = undoChannel();
    const { proposals, spoken, appointmentRepo, auditRepo } = await bookOnLiveCall({
      ownerPhone: OWNER_CELL,
      laneUndo,
    });

    expect(proposals).toHaveLength(1);
    const booking = proposals[0]!;
    expect(autonomousLaneEvaluationFor(booking)).toEqual({ eligible: true, threshold: 0.95 });
    expect(booking.status).toBe('approved');
    // The eligible verdict and the sent UNDO are both audited.
    await vi.waitFor(async () => {
      const events = await auditRepo.findByEntity(TENANT, 'proposal', booking.id);
      expect(events.find((e) => e.eventType === 'autonomous_booking_lane_evaluated')?.metadata).toMatchObject({
        eligible: true,
        threshold: 0.95,
      });
      expect(events.find((e) => e.eventType === 'autonomous_booking_undo_sms')?.metadata).toMatchObject({
        status: 'sent',
      });
    });
    const hold = await appointmentRepo.findById(TENANT, booking.payload.appointmentId as string);
    expect(spoken).toBe(
      spokenAutonomousBookConfirm(timeReadbackFromHold(hold!.scheduledStart.toISOString(), TZ)),
    );
    await vi.waitFor(() => expect(laneUndo.sendSms).toHaveBeenCalledTimes(1));
    expect(laneUndo.sendSms).toHaveBeenCalledWith(OWNER_CELL, expect.stringContaining('Tap to UNDO'));
  });

  // Value: protects=the owner's UNDO text names the customer on record and the booked time, never caller-spoken text;
  //   fails_when=the live path sends stored.summary ("Schedule appointment for <spoken name>") or drops the time;
  //   why_new=the first live UNDO text carried no time and a caller-influenced name; seam=none; no_claim=SMS delivery
  it('the owner UNDO text names the customer on record and the booked time', async () => {
    const laneUndo = undoChannel();
    const { proposals, appointmentRepo } = await bookOnLiveCall({
      ownerPhone: OWNER_CELL,
      laneUndo,
      customerDisplayName: 'Dana Lee',
    });
    const hold = await appointmentRepo.findById(TENANT, proposals[0]!.payload.appointmentId as string);
    const when = timeReadbackFromHold(hold!.scheduledStart.toISOString(), TZ);
    await vi.waitFor(() => expect(laneUndo.sendSms).toHaveBeenCalledTimes(1));
    const [, body] = laneUndo.sendSms.mock.calls[0]!;
    expect(body.startsWith(`Rivet booked: Dana Lee — ${when}. Tap to UNDO: `)).toBe(true);
  });

  // Value: protects=a slow or failing UNDO send never delays or breaks the caller's confirmed booking, and is audited;
  //   fails_when=the send is awaited in the turn again, or a send failure escapes the turn or leaves no audit trail;
  //   why_new=the live UNDO send was awaited inline with no failure test; seam=none; no_claim=Twilio timeouts
  it('a hung UNDO send never delays the confirmation; a failed one is audited and the booking stands', async () => {
    const hung = undoChannel();
    hung.sendSms.mockImplementation(() => new Promise<void>(() => {}));
    const result = await Promise.race([
      bookOnLiveCall({ ownerPhone: OWNER_CELL, laneUndo: hung }),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 2000)),
    ]);
    expect(result).not.toBe('timeout');

    const failing = undoChannel();
    failing.sendSms.mockRejectedValue(new Error('twilio down'));
    const { proposals, spoken, appointmentRepo, auditRepo } = await bookOnLiveCall({
      ownerPhone: OWNER_CELL,
      laneUndo: failing,
    });
    const booking = proposals[0]!;
    expect(booking.status).toBe('approved');
    const hold = await appointmentRepo.findById(TENANT, booking.payload.appointmentId as string);
    expect(spoken).toBe(
      spokenAutonomousBookConfirm(timeReadbackFromHold(hold!.scheduledStart.toISOString(), TZ)),
    );
    await vi.waitFor(async () => {
      const events = await auditRepo.findByEntity(TENANT, 'proposal', booking.id);
      expect(events.find((e) => e.eventType === 'autonomous_booking_undo_sms')?.metadata).toMatchObject({
        status: 'failed',
      });
    });
  });

  it('every live lane verdict is audited (router parity)', async () => {
    const { proposals, auditRepo } = await bookOnLiveCall({ laneUndo: undoChannel() });
    const events = await auditRepo.findByEntity(TENANT, 'proposal', proposals[0]!.id);
    expect(events.find((e) => e.eventType === 'autonomous_booking_lane_evaluated')?.metadata).toMatchObject({
      eligible: false,
      reason: 'owner_cell_missing',
    });
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
