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
import { describe, it, expect, vi } from 'vitest';
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

/** Classifier verdict (0.97, above the tenant's 0.95 lane threshold), then "yes". */
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
      content: contents[Math.min(i++, contents.length - 1)],
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

async function bookOnLiveCall(opts: {
  ownerPhone?: string;
  laneUndo?: ReturnType<typeof undoChannel>;
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
  });

  await processor.speechTurn({
    session,
    speechResult: 'My furnace stopped heating, can someone come Tuesday at 2pm?',
    callSid: CALL_SID,
    tenantId: TENANT,
  });
  const fx: SideEffect[] = await processor.speechTurn({
    session,
    speechResult: 'Yes, that works',
    callSid: CALL_SID,
    tenantId: TENANT,
  });

  const proposals = await proposalRepo.findByTenant(TENANT);
  const spoken = [...fx].reverse().find((e) => e.type === 'tts_play')?.payload.text;
  return { proposals, spoken, appointmentRepo };
}

describe('live-call booking (U3) — D-015 owner-cell gate and owner UNDO', () => {
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
