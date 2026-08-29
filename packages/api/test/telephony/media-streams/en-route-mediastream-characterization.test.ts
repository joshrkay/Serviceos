/**
 * #847 (#860 step 2) — en_route ("on my way") on the MEDIA-STREAMS transport.
 *
 * The media-streams adapter delegates every final transcript to
 * `TwilioGatherAdapter#processCallerUtterance` (app.ts wires the adapter's
 * `speechTurn` dep to exactly that method), which runs the shared
 * `speechTurn` in create-voice-turn-processor — so THIS seam is where the
 * transport consumes classified intents, and where the en_route branch
 * lives. Driven here the same way the WS finals path drives it, with a stub
 * LLM gateway; everything asserted is observable behaviour — the side
 * effects the adapter renders as TTS, where the FSM is left, whether the
 * SAME audited act as the app en-route button fired, what the session bus
 * saw. Mirrors the Gather characterization one directory up
 * (en-route-gather-characterization.test.ts): both transports call the one
 * phone surface adapter.
 *
 * Before the fix the intent fell into the FSM funnel and ended in a
 * `voice_clarification` card — on a transport a technician in the field is
 * most likely to be using.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';
import type { PhoneEnRouteDeps } from '../../../src/ai/voice-turn/phone-en-route-surface';

const tenantId = 'tenant-enroute-ms';
const TECH_ID = 'tech-canonical-uuid';
const OWNER_ID = 'owner-canonical-uuid';
// Midday in Chicago; the appointment below is the same local service day.
const FIXED = new Date('2026-08-26T16:00:00.000Z');

function gatewayReturning(intentType: string, extractedEntities?: Record<string, unknown>): LLMGateway {
  const response: LLMResponse = {
    content: JSON.stringify({ intentType, confidence: 0.96, ...(extractedEntities ? { extractedEntities } : {}) }),
    model: 'stub',
    provider: 'stub',
    latencyMs: 1,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  } as unknown as LLMResponse;
  return { complete: vi.fn(async () => response) } as unknown as LLMGateway;
}

const APPT = {
  id: 'appt-1',
  jobId: 'job-1',
  status: 'scheduled',
  scheduledStart: new Date('2026-08-26T18:00:00.000Z'),
} as never;

function enRouteBundle(over: Partial<PhoneEnRouteDeps> = {}): PhoneEnRouteDeps & {
  coordinator: { enqueueEnRouteNotice: ReturnType<typeof vi.fn> };
  auditCreate: ReturnType<typeof vi.fn>;
} {
  const users: Record<string, { id: string; role: string; firstName: string; lastName: string; email: string }> = {
    [TECH_ID]: { id: TECH_ID, role: 'technician', firstName: 'Carlos', lastName: 'Ruiz', email: 'c@x.com' },
    [OWNER_ID]: { id: OWNER_ID, role: 'owner', firstName: 'Olive', lastName: 'Owner', email: 'o@x.com' },
  };
  const coordinator = { enqueueEnRouteNotice: vi.fn(async () => 'appt-1:en_route') };
  const auditCreate = vi.fn(async () => undefined);
  return {
    userRepo: { findById: async (_t: string, id: string) => (users[id] as never) ?? null },
    assignmentRepo: {
      findByTechnician: vi.fn(async (_t: string, techId: string) =>
        techId === TECH_ID ? [{ id: 'a1', appointmentId: 'appt-1', technicianId: TECH_ID } as never] : [],
      ),
    },
    appointmentRepo: { findById: async () => APPT },
    settingsRepo: { findByTenant: async () => ({ tenantId, timezone: 'America/Chicago' } as never) },
    enRouteCoordinator: coordinator,
    auditRepo: { create: auditCreate } as never,
    now: () => FIXED,
    coordinator,
    auditCreate,
    ...over,
  };
}

function makeHarness(opts: { actorUserId?: string; enRoute?: PhoneEnRouteDeps } = {}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = {
    create: vi.fn(async (p: Record<string, unknown>) => p),
    findByTenant: vi.fn(async () => []),
  };
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: gatewayReturning('en_route'),
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    proposalRepo,
    ...(opts.enRoute ? { enRoute: opts.enRoute } : {}),
  } as never);
  const callSid = `CA-ms-enroute-${Math.random().toString(36).slice(2, 8)}`;
  const session = store.create(tenantId, 'telephony', { callSid });
  session.machine.dispatch({
    type: 'incoming_call',
    tenantId,
    callSid,
    from: '+15125550111',
    to: '+15125550000',
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: '11111111-1111-4111-8111-111111111111' });
  session.customerId = '11111111-1111-4111-8111-111111111111';
  if (opts.actorUserId) session.actorUserId = opts.actorUserId;
  const events: Array<{ type?: string; outcome?: string }> = [];
  session.events.on('voice-event', (e: { type?: string }) => events.push(e));
  return { adapter, session, callSid, events, proposalRepo };
}

// The media-streams finals entry: app.ts wires the WS adapter's `speechTurn`
// dep to processCallerUtterance, so this call IS the transport seam.
const speak = (h: ReturnType<typeof makeHarness>, speech: string) =>
  h.adapter.processCallerUtterance({
    sessionId: h.session.id,
    callSid: h.callSid,
    speechResult: speech,
    tenantId,
  });

const ttsTexts = (fx: SideEffect[]) =>
  fx.filter((f) => f.type === 'tts_play').map((f) => (f.payload as { text: string }).text);

const enRouteEvents = (h: ReturnType<typeof makeHarness>) =>
  h.events.filter((e) => e.type === 'en_route_executed');

describe('en_route on the media-streams transport (speechTurn seam)', () => {
  it('a technician actor fires the audited act and hears the on-my-way confirmation', async () => {
    const bundle = enRouteBundle();
    const h = makeHarness({ actorUserId: TECH_ID, enRoute: bundle });

    const fx = await speak(h, "I'm on my way");

    const spoken = ttsTexts(fx);
    expect(spoken.some((t) => t.includes('Sent the customer an on-my-way text'))).toBe(true);
    // Stays a conversation — the FSM never left intent_capture.
    expect(spoken).toContain('Anything else I can help you with?');
    expect(h.session.machine.currentState).toBe('intent_capture');
    // The SAME act as the app button: coordinator enqueue + audited actor.
    expect(bundle.coordinator.enqueueEnRouteNotice).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, appointmentId: 'appt-1', technicianName: 'Carlos Ruiz' }),
    );
    expect(bundle.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'appointment.en_route_triggered',
        actorId: TECH_ID,
        actorRole: 'technician',
      }),
    );
    // Never a proposal — a direct status act, not a clarification card.
    expect(h.proposalRepo.create).not.toHaveBeenCalled();
    expect(enRouteEvents(h)[0]?.outcome).toBe('sent');
  });

  it('no resolved actor → honest identity refusal, and the act never fires', async () => {
    const bundle = enRouteBundle();
    const h = makeHarness({ enRoute: bundle });

    const fx = await speak(h, "I'm on my way");

    expect(ttsTexts(fx).some((t) => t.includes('match your number to a team member'))).toBe(true);
    expect(bundle.coordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
    expect(h.proposalRepo.create).not.toHaveBeenCalled();
    expect(enRouteEvents(h)[0]?.outcome).toBe('refused');
  });

  it('a non-technician actor is refused (anti-spoofing — same rule as the SMS keyword leg)', async () => {
    const bundle = enRouteBundle();
    const h = makeHarness({ actorUserId: OWNER_ID, enRoute: bundle });

    const fx = await speak(h, "I'm on my way");

    expect(ttsTexts(fx).some((t) => t.includes('sent by the technician on the job'))).toBe(true);
    expect(bundle.coordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
    expect(enRouteEvents(h)[0]?.outcome).toBe('refused');
  });

  it('no tenant timezone → cannot-answer, never a UTC-guessed day', async () => {
    const bundle = enRouteBundle({
      settingsRepo: { findByTenant: async () => ({ tenantId, timezone: null } as never) },
    });
    const h = makeHarness({ actorUserId: TECH_ID, enRoute: bundle });

    const fx = await speak(h, "I'm on my way");

    expect(ttsTexts(fx).some((t) => t.includes('which of your appointments is today'))).toBe(true);
    expect(bundle.coordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
    expect(enRouteEvents(h)[0]?.outcome).toBe('unavailable');
  });

  it('bundle not wired → unavailable line, no crash, no card, FSM untouched', async () => {
    const h = makeHarness({ actorUserId: TECH_ID });

    const fx = await speak(h, "I'm on my way");

    expect(ttsTexts(fx).some((t) => t.includes('on-my-way text right now'))).toBe(true);
    expect(h.session.machine.currentState).toBe('intent_capture');
    expect(h.proposalRepo.create).not.toHaveBeenCalled();
    expect(enRouteEvents(h)[0]?.outcome).toBe('unavailable');
  });

  it('nothing eligible today → an explicit "nothing was sent", never silence', async () => {
    const bundle = enRouteBundle();
    bundle.assignmentRepo = { findByTechnician: vi.fn(async () => []) };
    const h = makeHarness({ actorUserId: TECH_ID, enRoute: bundle });

    const fx = await speak(h, "I'm on my way");

    expect(ttsTexts(fx).some((t) => t.includes('nothing was sent'))).toBe(true);
    expect(bundle.coordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
    expect(enRouteEvents(h)[0]?.outcome).toBe('no_appointment');
  });
});
