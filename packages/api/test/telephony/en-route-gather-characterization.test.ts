/**
 * #847 — en_route ("on my way") on the live Gather path, pinned at the same
 * seam as the lookup characterization net: a real TwilioGatherAdapter +
 * VoiceSessionStore with a stub LLM gateway. Everything here is observable
 * behaviour — what the caller hears, where the FSM is left, whether the SAME
 * audited act as the app en-route button fired, what the session bus saw.
 *
 * Before the fix the intent fell through `intentToProposalType`'s default and
 * became a `voice_clarification` card — on the surface a technician in the
 * field is most likely to be holding.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { PhoneEnRouteDeps } from '../../src/ai/voice-turn/phone-en-route-surface';

const tenantId = 'tenant-enroute';
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

function makeAdapter(opts: {
  actorUserId?: string;
  enRoute?: PhoneEnRouteDeps;
  entities?: Record<string, unknown>;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: gatewayReturning('en_route', opts.entities),
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    ...(opts.enRoute ? { enRoute: opts.enRoute } : {}),
  } as never);
  const callSid = `CA-enroute-${Math.random().toString(36).slice(2, 8)}`;
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
  return { adapter, session, callSid, events };
}

const ask = (h: ReturnType<typeof makeAdapter>, speech: string) =>
  h.adapter.handleGather({
    sessionId: h.session.id,
    callSid: h.callSid,
    speechResult: speech,
    confidence: 0.95,
    tenantId,
  });

const enRouteEvents = (h: ReturnType<typeof makeAdapter>) =>
  h.events.filter((e) => e.type === 'en_route_executed');

describe('en_route on the Gather path', () => {
  it('a technician actor fires the audited act and hears the on-my-way confirmation', async () => {
    const bundle = enRouteBundle();
    const h = makeAdapter({ actorUserId: TECH_ID, enRoute: bundle });

    const twiml = await ask(h, "I'm on my way");

    expect(twiml).toContain('Sent the customer an on-my-way text');
    // Stays a conversation — next <Gather>, FSM never left intent_capture.
    expect(twiml).toContain('Anything else I can help you with?');
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
    expect(enRouteEvents(h)[0]?.outcome).toBe('sent');
  });

  it('scopes resolution to the acting technician (AC-2 — never a tenant-wide query)', async () => {
    const bundle = enRouteBundle();
    const h = makeAdapter({ actorUserId: TECH_ID, enRoute: bundle });

    await ask(h, "I'm on my way");

    expect(bundle.assignmentRepo!.findByTechnician).toHaveBeenCalledWith(tenantId, TECH_ID);
  });

  it('no resolved actor → honest identity refusal, and the act never fires', async () => {
    const bundle = enRouteBundle();
    const h = makeAdapter({ enRoute: bundle });

    const twiml = await ask(h, "I'm on my way");

    expect(twiml).toContain('match your number to a team member');
    expect(bundle.coordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
    expect(enRouteEvents(h)[0]?.outcome).toBe('refused');
  });

  it('a non-technician actor is refused (anti-spoofing — same rule as the SMS keyword leg)', async () => {
    const bundle = enRouteBundle();
    const h = makeAdapter({ actorUserId: OWNER_ID, enRoute: bundle });

    const twiml = await ask(h, "I'm on my way");

    expect(twiml).toContain('sent by the technician on the job');
    expect(bundle.coordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
    expect(enRouteEvents(h)[0]?.outcome).toBe('refused');
  });

  it('no tenant timezone → cannot-answer, never a UTC-guessed day', async () => {
    const bundle = enRouteBundle({
      settingsRepo: { findByTenant: async () => ({ tenantId, timezone: null } as never) },
    });
    const h = makeAdapter({ actorUserId: TECH_ID, enRoute: bundle });

    const twiml = await ask(h, "I'm on my way");

    expect(twiml).toContain('which of your appointments is today');
    expect(bundle.coordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
    expect(enRouteEvents(h)[0]?.outcome).toBe('unavailable');
  });

  it('bundle not wired → unavailable line, no crash, no card', async () => {
    const h = makeAdapter({ actorUserId: TECH_ID });

    const twiml = await ask(h, "I'm on my way");

    expect(twiml).toContain('on-my-way text right now');
    expect(h.session.machine.currentState).toBe('intent_capture');
    expect(enRouteEvents(h)[0]?.outcome).toBe('unavailable');
  });

  it('nothing eligible today → an explicit "nothing was sent", never silence', async () => {
    const bundle = enRouteBundle();
    bundle.assignmentRepo = { findByTechnician: vi.fn(async () => []) };
    const h = makeAdapter({ actorUserId: TECH_ID, enRoute: bundle });

    const twiml = await ask(h, "I'm on my way");

    expect(twiml).toContain('nothing was sent');
    expect(bundle.coordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
    expect(enRouteEvents(h)[0]?.outcome).toBe('no_appointment');
  });
});
