/**
 * The live-phone lookup path, pinned at the Gather seam (#866 / #843).
 *
 * History: PR #860 wrote this net to pin the OLD behaviour — including the
 * five intents that had no case and the ownerSession-only authorization —
 * so that fixing them "stays a deliberate act". This is that act. The phone
 * is now the third caller of the shared dispatch
 * (`workers/voice-lookup-answer.ts`), authorised by the session's ACTOR.
 *
 * Everything here is observable behaviour: what the caller hears, where the
 * FSM is left, what the session bus saw. Nothing asserts which internal
 * function ran.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { PhoneLookupDeps } from '../../src/ai/voice-turn/phone-lookup-surface';
import {
  LOOKUP_UNAVAILABLE_LINE,
} from '../../src/ai/voice-turn/phone-lookup-surface';

const tenantId = 'tenant-lk';
// `voiceLookupAnswerSchema` validates `entityRef.id` as a UUID (the phone's
// real customerId/jobId always are), so the stub ids have to be too.
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const NOT_WIRED = 'I&apos;m having trouble pulling that up right now';
const OWNER_REFUSAL = 'owner-level report';

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

type Role = 'owner' | 'dispatcher' | 'technician';

/**
 * A minimal lookups bundle. `answers`/`shared` mirror app.ts's shape; every
 * repo is a vi.fn stub the test controls. `roles` maps actorUserId → role for
 * the shared module's RBAC gate.
 */
function lookups(over: {
  // Deliberately loose: each test wires only the handful of repo METHODS the
  // skill under test actually calls, not whole repository implementations.
  answers?: Record<string, unknown>;
  shared?: Record<string, unknown>;
  roles?: Record<string, Role>;
  entityResolver?: PhoneLookupDeps['entityResolver'];
}): PhoneLookupDeps {
  return {
    answers: {
      resolveMemberRole: async (_t: string, userId: string) => over.roles?.[userId] ?? null,
      ...(over.answers ?? {}),
    } as unknown as PhoneLookupDeps['answers'],
    shared: {
      proposalRepo: { findByTenant: vi.fn(async () => []) },
      ...(over.shared ?? {}),
    } as unknown as PhoneLookupDeps['shared'],
    ...(over.entityResolver ? { entityResolver: over.entityResolver } : {}),
  };
}

function makeAdapter(opts: {
  intentType: string;
  entities?: Record<string, unknown>;
  ownerSession?: boolean;
  actorUserId?: string;
  identified?: boolean;
  lookups?: PhoneLookupDeps;
  deps?: Record<string, unknown>;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: gatewayReturning(opts.intentType, opts.entities),
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    ...(opts.lookups ? { lookups: opts.lookups } : {}),
    ...(opts.deps ?? {}),
  } as never);
  const callSid = `CA-${opts.intentType}-${opts.actorUserId ?? 'anon'}`;
  const session = store.create(tenantId, 'telephony', {
    callSid,
    ...(opts.ownerSession ? { ownerSession: true, extendedIntents: true } : {}),
  });
  if (opts.actorUserId) session.actorUserId = opts.actorUserId;
  session.machine.dispatch({
    type: 'incoming_call',
    tenantId,
    callSid,
    from: '+15125550111',
    to: '+15125550000',
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  if (opts.identified !== false) {
    session.machine.dispatch({ type: 'caller_known', customerId: CUSTOMER_ID });
    session.customerId = CUSTOMER_ID;
  }
  const events: Array<{ type?: string; success?: boolean; error?: string }> = [];
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

const lookupEvents = (h: ReturnType<typeof makeAdapter>) => h.events.filter((e) => e.type === 'lookup_executed');

describe('phone lookups — the five that were dead on the phone now answer', () => {
  it('lookup_my_day: a technician actor hears THEIR day (self-scoped through the shared dispatch)', async () => {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    const h = makeAdapter({
      intentType: 'lookup_my_day',
      actorUserId: 'clerk-tech',
      lookups: lookups({
        roles: { 'clerk-tech': 'technician' },
        shared: {
          appointmentRepo: {
            findByDateRange: vi.fn(async () => [
              { id: 'a1', tenantId, jobId: 'job-1', scheduledStart: start, scheduledEnd: new Date(start.getTime() + 3_600_000), status: 'scheduled' },
            ]),
          },
          jobRepo: {
            findByIds: vi.fn(async () => [{ id: 'job-1', tenantId, summary: 'Main drain repair', assignedTechnicianId: 'u-tech' }]),
          },
          userRepo: {
            findByTenant: vi.fn(async () => [{ id: 'u-tech', tenantId, clerkUserId: 'clerk-tech', role: 'technician' }]),
          },
        },
      }),
    });

    const xml = await ask(h, "what's my day look like");

    expect(xml).not.toContain(NOT_WIRED);
    expect(xml).toContain('Main drain repair');
    expect(h.session.machine.currentState).toBe('intent_capture');
    expect(xml).toContain('Anything else');
  });

  it('lookup_materials: any resolved actor hears the pending shopping list', async () => {
    const listPending = vi.fn(async () => [
      { id: 'm1', tenantId, description: '3/4 inch copper elbows', quantity: 6, status: 'pending', createdBy: 'u1', createdAt: new Date(), updatedAt: new Date() },
    ]);
    const h = makeAdapter({
      intentType: 'lookup_materials',
      actorUserId: 'clerk-tech',
      lookups: lookups({ roles: { 'clerk-tech': 'technician' }, answers: { materialItemRepo: { listPending } as never } }),
    });

    const xml = await ask(h, 'what materials do I need');

    expect(listPending).toHaveBeenCalled();
    expect(xml).toContain('copper elbows');
  });

  it('lookup_job_profit: an owner naming a job hears the margin', async () => {
    const findById = vi.fn(async () => ({ id: JOB_ID, tenantId, summary: 'Miller water heater', status: 'completed' }));
    const h = makeAdapter({
      intentType: 'lookup_job_profit',
      entities: { jobReference: 'the Miller job' },
      actorUserId: 'clerk-owner',
      lookups: lookups({
        roles: { 'clerk-owner': 'owner' },
        entityResolver: { resolve: vi.fn(async () => ({ kind: 'resolved', candidate: { id: JOB_ID, kind: 'job', label: 'Miller water heater', score: 0.99 } })) } as never,
        shared: { jobRepo: { findById, findByIds: vi.fn(async () => []) } },
        answers: {
          settingsRepo: { findByTenant: vi.fn(async () => ({ tenantId, laborRateCentsPerHour: 8500 })) } as never,
          invoiceRepo: { findByJob: vi.fn(async () => [{ id: 'inv-1', jobId: JOB_ID, status: 'paid', totals: { totalCents: 120000 }, amountPaidCents: 120000, amountDueCents: 0 }]) } as never,
          timeEntryRepo: { findByJob: vi.fn(async () => []) } as never,
          // getJobProfit reads job expenses through the TENANT list with a
          // jobId filter (jobs/job-profit.ts) — there is no findByJob here.
          expenseRepo: { findByTenant: vi.fn(async () => []) } as never,
        },
      }),
    });

    const xml = await ask(h, 'did I make money on the Miller job');

    expect(findById).toHaveBeenCalledWith(tenantId, JOB_ID);
    expect(xml).not.toContain(NOT_WIRED);
    expect(xml).not.toContain(OWNER_REFUSAL);
  });

  it.each(['lookup_crew_schedule', 'lookup_timesheets'])(
    '%s: a dispatcher actor is answered (reports:view) — the flag-era ownerSession gate is gone',
    async (intentType) => {
      const h = makeAdapter({
        intentType,
        actorUserId: 'clerk-dispatch',
        lookups: lookups({
          roles: { 'clerk-dispatch': 'dispatcher' },
          shared: {
            appointmentRepo: { findByDateRange: vi.fn(async () => []) },
            jobRepo: { findByIds: vi.fn(async () => []) },
            userRepo: { findByTenant: vi.fn(async () => []) },
          },
          answers: {
            // TimeEntryService.weeklyHoursByUser reads the WEEK window off
            // findByTenant — the only primitive lookup_timesheets touches.
            timeEntryRepo: { findByTenant: vi.fn(async () => []) } as never,
          },
        }),
      });

      const xml = await ask(h, 'tell me about the crew');

      expect(xml).not.toContain(NOT_WIRED);
      expect(xml).not.toContain(OWNER_REFUSAL);
      expect(h.session.machine.currentState).toBe('intent_capture');
    },
  );
});

describe('phone lookups — authorization is the actor\'s DB role, not the caller-ID boolean', () => {
  it('a technician asking for revenue hears the owner-level refusal, and no repo is read', async () => {
    const query = vi.fn();
    const h = makeAdapter({
      intentType: 'lookup_revenue',
      actorUserId: 'clerk-tech',
      lookups: lookups({ roles: { 'clerk-tech': 'technician' }, answers: { moneyDashboardRepo: { query } as never } }),
    });

    const xml = await ask(h, 'how much did we make this month');

    expect(xml).toContain(OWNER_REFUSAL);
    expect(query).not.toHaveBeenCalled();
  });

  it('an identified CUSTOMER (no actor) asking for revenue is refused — the defence-in-depth gap from #866', async () => {
    const h = makeAdapter({
      intentType: 'lookup_revenue',
      lookups: lookups({ answers: { moneyDashboardRepo: { query: vi.fn() } as never } }),
    });

    const xml = await ask(h, 'how much money did you make this month');

    expect(xml).toContain(OWNER_REFUSAL);
  });

  it('an identified customer asking for the lead pipeline is refused honestly', async () => {
    const h = makeAdapter({
      intentType: 'lookup_leads',
      lookups: lookups({ answers: { leadRepo: { findByTenant: vi.fn(async () => []) } as never } }),
    });

    const xml = await ask(h, 'what leads do you have');

    expect(xml).toContain('couldn&apos;t verify your access to the lead pipeline');
  });

  it('an owner actor on a session with the tenant flag OFF is still answered — the flag gates classification, not dispatch', async () => {
    const digestDate = new Date().toISOString().slice(0, 10);
    const findLatest = vi.fn(async () => ({
      tenantId,
      digestDate,
      payload: {},
      narrative: 'Owner digest: revenue was strong',
    }));
    const h = makeAdapter({
      intentType: 'lookup_digest',
      ownerSession: false,
      actorUserId: 'clerk-owner',
      lookups: lookups({
        roles: { 'clerk-owner': 'owner' },
        answers: {
          // lookup-digest.ts asks for TODAY first, then falls back to the
          // latest stored digest — both primitives must exist.
          dailyDigestRepo: {
            findByTenantAndDate: vi.fn(async () => null),
            findLatest,
          } as never,
        },
      }),
    });

    const xml = await ask(h, 'read me my digest');

    expect(findLatest).toHaveBeenCalled();
    expect(xml).toContain('Owner digest');
  });

  it('a customer\'s own balance / invoices / appointments keep answering exactly as before', async () => {
    const findByCustomer = vi.fn(async () => []);
    const h = makeAdapter({
      intentType: 'lookup_jobs',
      lookups: lookups({ shared: { jobRepo: { findByCustomer, findById: vi.fn(async () => null) }, appointmentRepo: { findByCustomer: vi.fn(async () => []) } } }),
    });

    const xml = await ask(h, 'what jobs do I have open');

    // lookup-jobs.ts passes its own paging options as a third argument.
    expect(findByCustomer).toHaveBeenCalledWith(tenantId, CUSTOMER_ID, expect.anything());
    expect(xml).not.toContain(NOT_WIRED);
    expect(xml).toContain('Anything else');
  });
});

describe('phone lookups — the contract that must not move', () => {
  it('an unidentified caller never reaches a lookup — identification intercepts first', async () => {
    const findByCustomer = vi.fn(async () => []);
    const h = makeAdapter({
      intentType: 'lookup_jobs',
      identified: false,
      lookups: lookups({ shared: { jobRepo: { findByCustomer } } }),
    });

    await ask(h, 'what jobs do I have');

    expect(h.session.machine.currentState).toBe('identifying');
    expect(findByCustomer).not.toHaveBeenCalled();
  });

  it('a lookup never advances the FSM', async () => {
    const h = makeAdapter({ intentType: 'lookup_invoices', lookups: lookups({}) });
    await ask(h, 'what do I owe');
    expect(h.session.machine.currentState).toBe('intent_capture');
  });

  it('every outcome is a metric — lookup_executed rides the session bus', async () => {
    const h = makeAdapter({
      intentType: 'lookup_jobs',
      lookups: lookups({ shared: { jobRepo: { findByCustomer: vi.fn(async () => []), findById: vi.fn(async () => null) } } }),
    });

    await ask(h, 'what jobs do I have open');

    expect(lookupEvents(h)).toHaveLength(1);
  });

  it('a deployment with no lookups bundle speaks the unavailable line (never a 5xx)', async () => {
    const h = makeAdapter({ intentType: 'lookup_invoices' });

    const xml = await ask(h, 'what do I owe');

    expect(xml).toContain(NOT_WIRED);
    expect(LOOKUP_UNAVAILABLE_LINE).toContain("I'm having trouble pulling that up right now");
  });
});
